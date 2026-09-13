/**
 * ZendIQ – page-security.js
 * Wallet Security Checker (W2-P0-1)
 *
 * On-chain token approval scan, known-drain-contract detection, wallet-type
 * identification, and wallet-specific security guidance.
 *
 * Runs in MAIN world. Exports:
 *   ns.runWalletSecurityCheck(pubkey?) — async
 *   ns.detectWalletType(pubkey?)       — sync
 *   ns.walletSecurityResult            — state object (see schema below)
 *   ns.walletSecurityChecking          — bool
 *
 * Result schema:
 *   { score, checkedAt, pubkey, walletType, totalAccounts,
 *     unlimitedApprovals: [{ delegate, mint, delegatedRaw }],
 *     findings:           [{ severity, text, detail }],
 *     error? }
 *
 * Finding severities: 'CRITICAL' | 'HIGH' | 'WARN' | 'OK'
 */

(function () {
  'use strict';
  const ns = window.__zq;

  // Raw delegatedAmount at or above this threshold is treated as "unlimited".
  // (u64 max = 18_446_744_073_709_551_615; any amount >= 1e15 is effectively
  // a blanket approval far beyond any real token balance.)
  const UNLIMITED_THRESHOLD = 1_000_000_000_000_000;

  // ── detectWalletType ──────────────────────────────────────────────────────
  const _nameToType = (name) => {
    const n = (name ?? '').toLowerCase();
    if (n.includes('jupiter'))  return 'jupiter';
    if (n.includes('backpack')) return 'backpack';
    if (n.includes('solflare')) return 'solflare';
    if (n.includes('glow'))     return 'glow';
    if (n.includes('phantom'))  return 'phantom';
    if (n.includes('coin98'))   return 'coin98';
    if (n.includes('brave'))    return 'brave';
    return null;
  };

  // Which wallet holds the key being scanned — not merely which extensions are installed.
  // An injected global only proves the extension exists, so matching on one hands a Jupiter
  // user Phantom's instructions whenever both are installed.
  function detectWalletType(pubkey) {
    try {
      const pk    = pubkey ?? ns.walletPubkey ?? null;
      const found = [];
      const _add  = (w) => { if (w?.name && !found.includes(w)) found.push(w); };

      try {
        window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
          detail: { register(w) { _add(w); } },
        }));
      } catch (_) {}
      try {
        const reg  = window.navigator?.wallets ?? window.__wallet_standard_wallets__;
        const list = reg ? (typeof reg.get === 'function' ? reg.get() : (Array.isArray(reg) ? reg : [])) : [];
        for (const w of list) _add(w);
      } catch (_) {}
      _add(ns._wsWallet);

      if (pk) {
        for (const w of found) {
          for (const acc of (w.accounts ?? [])) {
            const addr = acc?.address ?? acc?.publicKey?.toString?.();
            if (addr === pk) return _nameToType(w.name) ?? 'unknown';
          }
        }
      }

      const hooked = _nameToType(ns._wsWallet?.name);
      if (hooked) return hooked;

      // Name-based, holding back browser-native wallets so they can't shadow an extension.
      for (const w of found) { const t = _nameToType(w.name); if (t && t !== 'brave') return t; }
      for (const w of found) { const t = _nameToType(w.name); if (t) return t; }

      if (window.jupiterWallet || window.jupiter?.solana || window.solana?.isJupiter) return 'jupiter';
      if (window.backpack?.solana || window.xnft?.solana)                  return 'backpack';
      if (window.solflare?.isSolflare || window.solana?.isSolflare)        return 'solflare';
      if (window.solana?.isGlow)                                            return 'glow';
      if (window.solana?.isCoin98)                                          return 'coin98';
      if (window.solana?.isMathWallet)                                      return 'mathwallet';
      if (window.solana?.isBrave || window.braveSolana)                    return 'brave';
      if (window.phantom?.solana?.isPhantom || window.solana?.isPhantom)   return 'phantom';
      return 'unknown';
    } catch (_) { return 'unknown'; }
  }

  // ── runWalletSecurityCheck ────────────────────────────────────────────────
  async function runWalletSecurityCheck(pubkey) {
    const _pubkey = pubkey ?? ns.resolveWalletPubkey?.();
    if (!_pubkey) {
      ns.walletSecurityResult = {
        score: null, error: 'Wallet not connected',
        findings: [{ severity: 'WARN', text: 'Connect your wallet to run a security check', detail: '' }],
        checkedAt: null, pubkey: null, unlimitedApprovals: [], walletType: detectWalletType(),
      };
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      return;
    }

    if (ns.walletSecurityChecking) return;
    ns.walletSecurityChecking = true;
    ns.walletSecurityResult   = null; // clear so panel shows spinner
    try { ns.renderWidgetPanel?.(); } catch (_) {}

    const findings      = [];
    let   score         = 100;
    let   unlimitedList = [];
    let   totalAccounts = 0;

    try {
      // ── 1. Fetch all token accounts for both SPL Token programs ──────────
      const PROGRAMS = [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token (classic)
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
      ];
      let allAccounts = [];
      let programsOk  = 0;
      for (const programId of PROGRAMS) {
        try {
          const resp  = await ns.rpcCall('getTokenAccountsByOwner', [
            _pubkey,
            { programId },
            { encoding: 'jsonParsed' },
          ]);
          const value = resp?.result?.value;
          if (!Array.isArray(value)) throw new Error('malformed RPC response');
          allAccounts = allAccounts.concat(value);
          programsOk++;
        } catch (_) { /* tallied below — a partial scan must not report as a complete one */ }
      }
      // Nothing was actually read, so there is no basis for a verdict. Scoring 100 here
      // would read as "no approvals found" when it really means "not checked".
      // The caller appends the "approvals were not checked" caveat, so it is not repeated here.
      if (programsOk === 0) throw new Error('Could not reach Solana RPC');
      const partialScan = programsOk < PROGRAMS.length;
      totalAccounts = allAccounts.length;

      // ── 2. Scan for unlimited / suspicious token approvals ───────────────
      for (const acct of allAccounts) {
        const info = acct?.account?.data?.parsed?.info;
        if (!info) continue;
        const { delegate, delegatedAmount, mint } = info;
        if (!delegate) continue; // no approval set — skip
        const delegatedRaw = Number(delegatedAmount?.amount ?? 0);
        const entry = { delegate, mint: mint ?? 'Unknown', delegatedRaw };
        if (delegatedRaw >= UNLIMITED_THRESHOLD) unlimitedList.push(entry);
      }

      // ── 3. Score deductions ──────────────────────────────────────────────
      // −20 per unlimited approval (hard floor: −40). Floor at 0 regardless.
      score -= Math.min(unlimitedList.length * 20, 40);
      score  = Math.max(0, score);

      // ── 4. Build findings ────────────────────────────────────────────────
      if (unlimitedList.length > 0) {
        findings.push({
          severity: 'HIGH',
          text:     `${unlimitedList.length} unlimited token approval${unlimitedList.length > 1 ? 's' : ''} active`,
          detail:   'Review and revoke any you don\'t recognise at revoke.cash',
        });
      }

      // ── 5. Wallet-specific auto-approve guidance ─────────────────────────
      const walletType = detectWalletType(_pubkey);
      const autoApproveWarnings = {
        phantom:  {
          text:    'Action required: check & disable Phantom auto-approve',
          detail:  'Disable auto-approve for all dApps — it lets sites sign transactions silently without a popup.',
          steps:   'Inside Phantom → click the ⚙ Settings tab → Security & Privacy → Trusted Apps → review each entry and disable auto-approve.',
          tooltip: 'RISK: If Phantom auto-approve is enabled for a dApp, any malicious script on that site can silently sign transactions without showing you a confirmation popup — resulting in a complete wallet drain.',
          reviewable: true,
        },
        backpack: {
          text:    'Action required: check & disable Backpack transaction approvals',
          detail:  'Disable pre-approved dApps — they can sign transactions silently without a confirmation popup.',
          steps:   'Inside Backpack → Settings → Security → Transaction Approval → remove pre-approved dApps you no longer use.',
          tooltip: 'RISK: Backpack pre-approved dApps can sign transactions silently. A malicious or compromised site with pre-approval can drain your entire wallet without triggering a confirmation prompt.',
          reviewable: true,
        },
        solflare: {
          text:    'Action required: check & disable Solflare auto-sign sessions',
          detail:  'Disable active auto-sign sessions — they allow sites to submit transactions at any time without your confirmation.',
          steps:   'Inside Solflare → Settings → Security → Auto-sign → revoke any sessions you do not actively need.',
          tooltip: 'RISK: Solflare auto-sign sessions allow a connected site to submit signed transactions at any time while the session is active. A malicious site with an auto-sign session can drain your wallet silently.',
          reviewable: true,
        },
        glow: {
          text:    'Action required: check & disable Glow connected apps',
          detail:  'Disable signing rights for connected apps — they can submit transactions without a per-transaction popup.',
          steps:   'Inside Glow → Settings → Connected Apps → remove any apps with signing rights you no longer use.',
          tooltip: 'RISK: Connected apps in Glow that have signing rights can submit transactions without a per-transaction popup. If any connected app is malicious or gets compromised, it can drain your wallet.',
          reviewable: true,
        },
        brave: {
          text:    'Action required: check & disable Brave Wallet dApp connections',
          detail:  'Disable authorised site connections — they can request transaction signatures at any time.',
          steps:   'Inside Brave → Crypto Wallets icon → Sites with access → revoke authorised dApps you no longer use.',
          tooltip: 'RISK: Sites with Brave Wallet access can request transaction signatures at any time. If an authorised site runs malicious code it can drain your wallet.',
          reviewable: true,
        },
        jupiter: {
          text:    'Action required: check & disable Jupiter Wallet auto-approve',
          detail:  'Disable Auto Approve and Skip Review — these bypass confirmation popups and are a drain risk if left on.',
          steps:   'Inside Jupiter Wallet → click \u22ee (top right) → Manage Settings → Preferences: ensure Auto Approve = Disabled and Skip Review = Disabled → then Security → Connected Apps → remove any sites you no longer use.',
          tooltip: 'RISK: Jupiter Wallet has two bypass settings. "Auto Approve" silently signs transactions without a popup. "Skip Review" skips the transaction review screen. Either can be exploited by a malicious connected site to drain your wallet.',
          reviewable: true,
        },
      };
      const autoWarn = autoApproveWarnings[walletType];
      let autoApproveDeduction = 0;
      if (autoWarn) {
        findings.push({ severity: 'WARN', ...autoWarn });
        autoApproveDeduction = 20;
      }

      // A partial scan can still prove a problem, but it can never prove the absence of one.
      if (partialScan) {
        findings.unshift({
          severity: 'WARN',
          text:     'Approval scan incomplete',
          detail:   'One token program could not be reached — re-scan to finish checking.',
        });
      } else if (!findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')) {
        findings.unshift({
          severity: 'OK',
          text:     unlimitedList.length === 0
            ? `${totalAccounts} accounts scanned — no unlimited approvals found`
            : `${unlimitedList.length} approval${unlimitedList.length > 1 ? 's' : ''} found`,
          detail:   'Approval scan complete',
        });
      }

      ns.walletSecurityResult = {
        score,
        autoApproveDeduction,
        checkedAt:          Date.now(),
        pubkey:             _pubkey,
        walletType,
        totalAccounts,
        unlimitedApprovals: unlimitedList,
        findings,
      };

    } catch (e) {
      ns.walletSecurityResult = {
        score:              null,
        checkedAt:          Date.now(),
        pubkey:             _pubkey,
        walletType:         detectWalletType(_pubkey),
        totalAccounts,
        unlimitedApprovals: [],
        findings:           [{ severity: 'WARN', text: 'Security check could not run', detail: (e.message?.slice(0, 120) ?? 'Unknown error') + ' — your approvals were not checked, so this is not an all-clear.' }],
        error:              e.message,
      };
    } finally {
      ns.walletSecurityChecking = false;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      // Persist scan result to the shared secLastResult key so popup and widget stay in sync
      const _r = ns.walletSecurityResult;
      if (_r) window.postMessage({ type: 'ZENDIQ_SAVE_SEC_RESULT', result: _r }, '*');
      // Analytics: wallet security scan completed
      try { if (_r && ns.logProEvent) {
        const _sc = _r.score;
        const _st = _sc != null ? (_sc >= 100 ? 100 : _sc >= 80 ? 80 : _sc >= 60 ? 60 : 0) : null;
        ns.logProEvent('wallet_security_scanned', {
          wallet_type:     _r.walletType ?? 'unknown',
          score_tier:      _st,
          unlimited_count: (_r.unlimitedApprovals?.length ?? 0),
        });
      } } catch (_) {}
      // Load the reviewed-state for this wallet type from chrome.storage via bridge
      const _wt = _r?.walletType;
      if (_wt && _wt !== 'unknown') window.postMessage({ type: 'ZENDIQ_GET_SEC_REVIEWED', walletType: _wt }, '*');
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────
  ns.runWalletSecurityCheck = runWalletSecurityCheck;
  ns.detectWalletType       = detectWalletType;
  if (ns.walletSecurityResult        === undefined) ns.walletSecurityResult        = null;
  if (ns.walletSecurityChecking      === undefined) ns.walletSecurityChecking      = false;
  if (ns.walletReviewedAutoApprove   === undefined) ns.walletReviewedAutoApprove   = false;

})();
