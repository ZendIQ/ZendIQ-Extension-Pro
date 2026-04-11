/**
 * ZendIQ – page-security.js
 * Wallet Security Checker (W2-P0-1)
 *
 * On-chain token approval scan, known-drain-contract detection, wallet-type
 * identification, and wallet-specific security guidance.
 *
 * Runs in MAIN world. Exports:
 *   ns.runWalletSecurityCheck(pubkey?) — async
 *   ns.detectWalletType()              — sync
 *   ns.walletSecurityResult            — state object (see schema below)
 *   ns.walletSecurityChecking          — bool
 *
 * Result schema:
 *   { score, checkedAt, pubkey, walletType, totalAccounts,
 *     unlimitedApprovals: [{ delegate, mint, delegatedRaw }],
 *     badContracts:       [{ delegate, mint, delegatedRaw }],
 *     findings:           [{ severity, text, detail }],
 *     error? }
 *
 * Finding severities: 'CRITICAL' | 'HIGH' | 'WARN' | 'OK'
 */

(function () {
  'use strict';
  const ns = window.__zq;

  // ── Known drain / malicious delegate contracts ───────────────────────────
  // Community-sourced; expand from Solana security community lists.
  // These are contract addresses that have been identified as drainers in
  // on-chain security incident reports (2023–2025).
  const KNOWN_DRAIN_CONTRACTS = new Set([
    '3CCLniuEGnMBWbE3FQiRQEhDGSRUnfFBWX9eV8GiJgJ2',
    'BVVdBbGmtMqDhFNpRKCBMCDmqD6a8NNvjFE6czHGJT5E',
    'GcF8pREjdFbXr4h4sMXNNNyicP2A9QN6LWsPpKMVADep',
    '9DtmUXVZhEFPGq6CQRS4RBfMkNDqVwVumtBXo3HLPF7w',
    'FGbGTPJLsLEBJW4JnK8gNqUQRiDkdQAaTfqG6G5PkR7o',
    '5sJqX3GhmdmfJC4uqoT3ZGagKByVSYo9CqTvWuLK8aCj',
    '8W8XSFxXc4RAUXCq8AyjC2k7YZ7Q6zY3GAnG2RqAqbdB',
    'AXEfAFqk4uqzC6Gy6SzZCfEJz8RKf8HnHqE8uoXYPyNZ',
    'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsRUe9efou',
    '4xQwteRzMPKJM1FS1H4fxVcLaGJy8W8PvbVTEm3XXTXB',
    '6Y5ynC3v6F8i5PHN8SfJg9JbNrjxqBmKfQdqZ7dBDVy4',
  ]);

  // Raw delegatedAmount at or above this threshold is treated as "unlimited".
  // (u64 max = 18_446_744_073_709_551_615; any amount >= 1e15 is effectively
  // a blanket approval far beyond any real token balance.)
  const UNLIMITED_THRESHOLD = 1_000_000_000_000_000;

  // ── detectWalletType ──────────────────────────────────────────────────────
  function detectWalletType() {
    try {
      if (window.phantom?.solana?.isPhantom || window.solana?.isPhantom)   return 'phantom';
      if (window.backpack?.solana || window.xnft?.solana)                  return 'backpack';
      if (window.solflare?.isSolflare || window.solana?.isSolflare)        return 'solflare';
      if (window.solana?.isGlow)                                            return 'glow';
      if (window.solana?.isBrave || window.braveSolana)                    return 'brave';
      if (window.solana?.isCoin98)                                          return 'coin98';
      if (window.solana?.isMathWallet)                                      return 'mathwallet';
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
        checkedAt: null, pubkey: null, unlimitedApprovals: [], badContracts: [], walletType: detectWalletType(),
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
    let   knownBadList  = [];
    let   totalAccounts = 0;

    try {
      // ── 1. Fetch all token accounts for both SPL Token programs ──────────
      const PROGRAMS = [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token (classic)
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
      ];
      let allAccounts = [];
      for (const programId of PROGRAMS) {
        try {
          const resp  = await ns.rpcCall('getTokenAccountsByOwner', [
            _pubkey,
            { programId },
            { encoding: 'jsonParsed' },
          ]);
          const value = resp?.result?.value ?? [];
          allAccounts = allAccounts.concat(value);
        } catch (_) { /* one program failing is OK — continue with results so far */ }
      }
      totalAccounts = allAccounts.length;

      // ── 2. Scan for unlimited / suspicious token approvals ───────────────
      for (const acct of allAccounts) {
        const info = acct?.account?.data?.parsed?.info;
        if (!info) continue;
        const { delegate, delegatedAmount, mint } = info;
        if (!delegate) continue; // no approval set — skip
        const delegatedRaw = Number(delegatedAmount?.amount ?? 0);
        if (delegatedRaw < UNLIMITED_THRESHOLD) continue; // limited approval — skip
        const entry = { delegate, mint: mint ?? 'Unknown', delegatedRaw };
        unlimitedList.push(entry);
        if (KNOWN_DRAIN_CONTRACTS.has(delegate)) {
          knownBadList.push(entry);
        }
      }

      // ── 3. Score deductions ──────────────────────────────────────────────
      // −30 per known bad contract (hard floor: −60)
      // −20 per unlimited approval not on the known-bad list (hard floor: −40)
      // Floor at 0 regardless.
      const unknownUnlimited = unlimitedList.length - knownBadList.length;
      score -= Math.min(knownBadList.length  * 30, 60);
      score -= Math.min(unknownUnlimited     * 20, 40);
      score  = Math.max(0, score);

      // ── 4. Build findings ────────────────────────────────────────────────
      if (knownBadList.length > 0) {
        findings.push({
          severity: 'CRITICAL',
          text:     `${knownBadList.length} known drainer contract${knownBadList.length > 1 ? 's' : ''} has token approval`,
          detail:   'Revoke immediately — these contracts are confirmed wallet drainers',
        });
      }
      if (unknownUnlimited > 0) {
        findings.push({
          severity: 'HIGH',
          text:     `${unknownUnlimited} unlimited token approval${unknownUnlimited > 1 ? 's' : ''} active`,
          detail:   'Review and revoke any you don\'t recognise at revoke.cash',
        });
      }

      // ── 5. Wallet-specific auto-approve guidance ─────────────────────────
      const walletType = detectWalletType();
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

      // OK finding — only show when nothing critical/high is present
      if (!findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')) {
        findings.unshift({
          severity: 'OK',
          text:     unlimitedList.length === 0
            ? `${totalAccounts} accounts scanned — 0 harmful accounts found`
            : `${unlimitedList.length} approval${unlimitedList.length > 1 ? 's' : ''} found — none match known drainers`,
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
        badContracts:       knownBadList,
        findings,
      };

    } catch (e) {
      ns.walletSecurityResult = {
        score:              null,
        checkedAt:          Date.now(),
        pubkey:             _pubkey,
        walletType:         detectWalletType(),
        totalAccounts,
        unlimitedApprovals: [],
        badContracts:       [],
        findings:           [{ severity: 'WARN', text: 'Security check failed', detail: e.message?.slice(0, 100) ?? 'Unknown error' }],
        error:              e.message,
      };
    } finally {
      ns.walletSecurityChecking = false;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      // Persist scan result to the shared secLastResult key so popup and widget stay in sync
      const _r = ns.walletSecurityResult;
      if (_r) window.postMessage({ type: 'ZENDIQ_SAVE_SEC_RESULT', result: _r }, '*');
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
