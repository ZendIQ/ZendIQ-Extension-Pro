/**
 * ZendIQ popup — popup-security.js
 * Wallet Security Checker (W2-P0-1) — popup panel.
 *
 * Runs in the extension popup context: full chrome.runtime access,
 * no content-script restrictions.
 *
 * Public API: loadSecurity()
 */

// ── Known drain / malicious delegate contracts ──────────────────────────────
const DRAIN_CONTRACTS = new Set([
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

const UNLIMITED_THRESHOLD = 1_000_000_000_000_000; // effective unlimited

// ── Helper: background RPC (popup has direct chrome.runtime access) ─────────
function popupRpcCall(method, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'RPC_CALL', method, params }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error ?? 'RPC failed'));
    });
  });
}

// ── Wallet type detection (checks injected providers) ───────────────────────
// The popup runs in the extension page — window.solana isn't available here.
// Instead we check chrome.storage for the wallet type stashed by popup-wallet.js.
function detectWalletTypeFromStorage(cb) {
  // popup-wallet.js stores detectedWalletProvider into chrome.storage.session or
  // we fall back to inspecting the stored settings. For now we infer from the
  // wallet address source stored during detectWallet().
  chrome.storage.local.get(['settings'], ({ settings: s = {} }) => {
    cb(s.walletType ?? 'unknown');
  });
}

// ── State ────────────────────────────────────────────────────────────────────
let _secResult           = null;  // last scan result
let _secChecking         = false; // scan in progress
let _secWalletMissing    = false; // re-check attempted without jup.ag open
let _reviewedAutoApprove = false; // user confirmed they checked wallet auto-approve settings
let _lastKnownTabColor   = '';    // preserved across scans to avoid flash

// ── Tab colour badge ─────────────────────────────────────────────────────────
// Colours only the SVG icon — not the "Wallet" text label.
// Border underline only appears when the tab is .active.
// During a rescan we keep the last known colour so the icon doesn't flash amber.
function _updateSecurityTabColor() {
  const btn = document.getElementById('tab-security');
  if (!btn) return;
  let color = 'var(--orange)'; // amber default — no scan yet
  if (_secChecking) {
    // Hold the last known colour while rescanning — no amber flash
    color = _lastKnownTabColor || 'var(--orange)';
  } else if (_secResult) {
    const { score: rawScore, autoApproveDeduction = 0 } = _secResult;
    const ds = rawScore == null ? null
      : Math.max(0, rawScore - (_reviewedAutoApprove ? 0 : autoApproveDeduction));
    if      (ds == null) color = '';
    else if (ds === 100)  color = 'var(--green)';
    else if (ds >= 80)    color = 'var(--orange)';
    else if (ds >= 60)    color = '#FF6B00';
    else                  color = 'var(--danger)';
    _lastKnownTabColor = color; // save for use during next scan
  }
  // Colour the SVG icon only — leave the "Wallet" text at CSS default.
  const svg = btn.querySelector('svg');
  if (svg) svg.style.color = color;
  btn.style.color = ''; // never tint the text
  btn.style.borderBottomColor = btn.classList.contains('active') ? color : '';
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderSecurityPanel() {
  _updateSecurityTabColor();

  const panel = document.getElementById('panel-security');
  if (!panel) return;

  const esc     = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => esc(s).replace(/"/g, '&quot;');

  if (_secChecking && !_secResult) {
    panel.innerHTML = `
      <div class="section" style="text-align:center;padding:28px 16px">
        <div style="font-size:12px;color:var(--muted);animation:secPulse 1.2s ease-in-out infinite;margin-bottom:6px">Scanning on-chain approvals…</div>
        <div style="font-size:13px;color:var(--muted)">Checking SPL Token &amp; Token-2022 programs</div>
      </div>`;
    return;
  }

  if (!_secResult) {
    panel.innerHTML = `
      <div class="section">
        <div class="section-title">Wallet Security Check</div>
        ${walletPubkey ? `
        <p style="font-size:13px;color:var(--muted);line-height:1.65;margin-bottom:14px">
          ZendIQ scans your wallet for <strong style="color:var(--text)">unlimited token approvals</strong>,
          known drain contracts, and wallet-specific risks.<br><br>
          All checks are read-only queries against your <strong style="color:var(--text)">public wallet address</strong>.
          ZendIQ never has access to your <strong style="color:var(--green)">private key</strong> or seed phrase,
          and no data ever leaves your browser.
        </p>` : ''}
        ${walletPubkey ? `<button id="sec-run-btn" class="btn-q">
          🔒 Run Security Check
        </button>` : ''}
        ${!walletPubkey ? `
        <div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);font-size:13px;color:var(--muted);line-height:1.7">
          <div style="font-weight:700;color:var(--text);margin-bottom:5px">How to enable the wallet scan:</div>
          <div style="margin-bottom:4px">1. Open <a href="https://jup.ag" target="_blank" rel="noopener" style="color:var(--purple);font-weight:700;text-decoration:none">jup.ag</a>, <a href="https://raydium.io/swap/" target="_blank" rel="noopener" style="color:var(--purple);font-weight:700;text-decoration:none">Raydium</a>, or <a href="https://pump.fun" target="_blank" rel="noopener" style="color:var(--purple);font-weight:700;text-decoration:none">pump.fun</a> in this browser and connect your wallet there.</div>
          <div style="margin-bottom:4px">2. ZendIQ automatically reads your <strong style="color:var(--text)">public address</strong> from the page — no wallet is added to ZendIQ itself.</div>
          <div>3. Return here and click <strong style="color:var(--text)">Run Security Check</strong>.</div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);font-size:13px;color:var(--text)">
            <span style="color:var(--green)">✓</span> <strong>Your private key and seed phrase are never read or stored by ZendIQ.</strong>
          </div>
        </div>` : ''}
      </div>`;
    document.getElementById('sec-run-btn')?.addEventListener('click', runCheck);
    return;
  }

  const { score: rawScore, autoApproveDeduction = 0, checkedAt, unlimitedApprovals = [], badContracts = [], findings = [], totalAccounts, walletType } = _secResult;

  const displayScore = rawScore == null ? null : Math.max(0, rawScore - (_reviewedAutoApprove ? 0 : autoApproveDeduction));

  const scoreColor = displayScore == null ? 'var(--muted)'
    : displayScore === 100  ? 'var(--green)'
    : displayScore >= 80   ? 'var(--orange)'
    : displayScore >= 60   ? '#FF6B00'
    : 'var(--danger)';
  const openActions = findings.filter(f =>
    ['CRITICAL', 'HIGH', 'WARN'].includes(f.severity) &&
    !(f.reviewable && _reviewedAutoApprove)).length;
  const scoreSubline = openActions === 0 ? 'All checks passed'
    : openActions === 1 ? '1 action required' : `${openActions} actions required`;

  const _s = checkedAt ? Math.round((Date.now() - checkedAt) / 1000) : null;
  const timeAgo = _s == null ? '' : _s < 60 ? `${_s}s ago` : _s < 3600 ? `${Math.round(_s / 60)}m ago` : `${Math.round(_s / 3600)}h ago`;

  const sevColor = { CRITICAL: 'var(--danger)', HIGH: '#FF6B00', WARN: 'var(--orange)', OK: 'var(--green)' };
  const sevIcon  = { CRITICAL: '⛔', HIGH: '⚠', WARN: '⚠', OK: '✓' };

  const revokeLink = unlimitedApprovals.length > 0
    ? `<a href="https://revoke.cash" target="_blank" rel="noopener" class="sec-revoke-link">
        🔗 Review &amp; revoke at revoke.cash →
       </a>`
    : '';

  const walletTypeFmt = walletType && walletType !== 'unknown'
    ? walletType.charAt(0).toUpperCase() + walletType.slice(1)
    : 'Unknown';

  // Split findings: reviewable (auto-approve warning) rendered near top, rest below
  const reviewableFinding = findings.find(f => f.reviewable);
  const otherFindings     = findings.filter(f => !f.reviewable);

  const renderFinding = (f) => {
    const isReviewed = f.reviewable && _reviewedAutoApprove;
    const textColor  = f.reviewable
      ? (_reviewedAutoApprove ? 'var(--green)' : 'var(--orange)')
      : (sevColor[f.severity] ?? 'var(--text)');

    const reviewToggle = f.reviewable
      ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:7px;margin-top:8px;border-top:1px solid rgba(255,255,255,0.06)">
          <span style="font-size:13px;font-weight:600;color:${_reviewedAutoApprove ? 'var(--green)' : 'var(--orange)'}">I\u2019ve disabled ${walletTypeFmt}\u2019s auto-approve setting</span>
          <label class="switch" title="${_reviewedAutoApprove ? 'Click to un-mark' : 'Check this once you have disabled auto-approve and removed unrecognised connected apps — this protects your wallet from silent transaction signing'}" style="flex-shrink:0">
            <input type="checkbox" id="sec-reviewed-toggle" ${_reviewedAutoApprove ? 'checked' : ''}>
            <span class="slider slider-amber"></span>
          </label>
        </div>`
      : '';

    // When reviewed: collapse to single toggle row only
    if (isReviewed) {
      const tipAttrR = f.tooltip ? ` data-tip="${escAttr(f.tooltip)}" style="cursor:help"` : '';
      return `
    <div class="sec-finding"${tipAttrR}>
      <span class="sec-finding-icon" style="color:var(--green)">✓</span>
      <div style="flex:1">${reviewToggle}</div>
    </div>`;
    }

    // Tooltip text for this finding — shown in floating tip on hover
    const tipAttr  = f.tooltip ? ` data-tip="${escAttr(f.tooltip)}"` : '';
    const tipCursor = f.tooltip ? ' style="cursor:help"' : '';

    const stepsHtml = f.steps
      ? `<div style="margin-top:6px"><div style="font-size:12px;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px">Steps inside your wallet:</div><div style="font-size:13px;color:var(--text);line-height:1.55">${esc(f.steps)}</div></div>`
      : '';

    if (f.reviewable) {
      const bordC = f.severity === 'CRITICAL' ? 'rgba(255,68,68,0.2)' : f.severity === 'HIGH' ? 'rgba(255,107,0,0.2)' : 'rgba(255,181,71,0.2)';
      const bgC   = f.severity === 'CRITICAL' ? 'rgba(255,68,68,0.05)' : f.severity === 'HIGH' ? 'rgba(255,107,0,0.05)' : 'rgba(255,181,71,0.04)';
      return `
      <div${tipAttr}${tipCursor} style="margin-bottom:8px;padding:10px 12px;border-radius:9px;background:${bgC};border:1px solid ${bordC}">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:${f.detail || f.steps ? '4px' : '0'}">
          <span style="color:${sevColor[f.severity] ?? 'var(--muted)'}">${sevIcon[f.severity] ?? '·'}</span>
          <span style="font-size:13px;font-weight:600;color:${textColor}">${esc(f.text)}</span>
        </div>
        ${f.detail ? `<div style="font-size:13px;color:var(--muted);margin-bottom:6px">${esc(f.detail)}</div>` : ''}
        ${stepsHtml}
        ${reviewToggle}
      </div>`;
    }
    return `
    <div class="sec-finding"${tipAttr}${tipCursor}>
      <span class="sec-finding-icon" style="color:${sevColor[f.severity] ?? 'var(--muted)'}">${sevIcon[f.severity] ?? '·'}</span>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:${textColor}">${esc(f.text)}</div>
        ${f.detail ? `<div style="font-size:13px;color:var(--muted);margin-top:2px">${esc(f.detail)}</div>` : ''}
      </div>
    </div>`;
  };

  const reviewableHtml = reviewableFinding ? renderFinding(reviewableFinding) : '';
  const otherFindingsHtml = otherFindings.map(renderFinding).join('');

  panel.innerHTML = `
    ${_secWalletMissing ? `
    <div style="margin:8px 12px 0;padding:8px 12px;border-radius:7px;background:rgba(255,181,71,0.08);border:1px solid rgba(255,181,71,0.25);font-size:13px;color:var(--orange);line-height:1.6">
      ⚠ Open <a href="https://jup.ag" target="_blank" rel="noopener" style="color:var(--orange);font-weight:700;text-decoration:underline">jup.ag</a> and connect your wallet, then click Re-scan to refresh this scan.
    </div>` : ''}
    <div class="section">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
        <div>
          <div class="section-title" title="Score = 100 minus deductions: −30 per known drainer (max −60), −20 per unknown unlimited approval (max −40), −20 if wallet auto-approve settings have not been reviewed. 80–100 = Secure, 60–79 = Review, 40–59 = At Risk, 0–39 = Critical." style="cursor:help">Wallet Security Score</div>
          <div class="sec-score-hover-wrap" style="cursor:help" data-tip="Score starts at 100. Deductions: −30 per known drainer contract (max −60), −20 per unlimited approval (max −40), −20 if wallet settings not reviewed.">
            <div style="display:flex;align-items:baseline;gap:4px">
              <span style="font-size:32px;font-weight:900;color:${scoreColor};font-family:'Space Mono',monospace;line-height:1">${displayScore ?? '—'}</span>
              <span style="font-size:13px;font-weight:700;color:var(--muted)">&thinsp;/ 100</span>
            </div>
            <div style="font-size:13px;color:${openActions === 0 ? 'var(--green)' : 'var(--orange)'};font-weight:600;margin-top:2px">${scoreSubline}</div>
            ${timeAgo ? `<div style="font-size:12px;color:var(--muted);margin-top:1px">Last scanned: ${timeAgo}</div>` : ''}
          </div>
        </div>
        <button id="sec-run-btn" class="btn-q" title="Re-scan all token accounts on-chain for active unlimited approvals and known drainer contracts" style="width:auto;padding:7px 12px;margin:0;font-size:13px;flex-shrink:0" ${_secChecking ? 'disabled' : ''}>
          ${_secChecking ? 'Scanning…' : '↺ Re-scan'}
        </button>
      </div>

      ${reviewableHtml}
    </div>

    <div class="section" style="border-bottom:none">
      <div class="section-title" title="Each finding describes a specific risk detected in your wallet. Hover over individual findings for a full explanation of the risk and what you should do." style="cursor:help">Other Findings</div>
      ${otherFindingsHtml}
      ${revokeLink}
      <div style="margin-top:10px;font-size:13px;color:var(--muted);line-height:1.7;cursor:help" data-tip="ZendIQ operates entirely inside your browser. Your wallet private key and seed phrase are never read, stored, or transmitted — they are only ever held inside your wallet extension and are never exposed to ZendIQ. The security scan works by taking your public wallet address (visible to anyone on-chain) and querying the Solana RPC directly from your browser to retrieve token account delegate approvals. No data is sent to any ZendIQ server. revoke.cash is an independent third-party tool — ZendIQ has no affiliation with it and does not share any data with it.">
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px">
          <span style="color:var(--green);font-size:12px">✓</span>
          <span><strong style="color:var(--text)">ZendIQ never has access to your private key or seed phrase.</strong> Only your public address is used.</span>
        </div>
        On-chain scan only — no data leaves your browser. &nbsp;
        <a href="https://revoke.cash" target="_blank" rel="noopener" style="color:var(--purple);text-decoration:none">revoke.cash</a> is a trusted third-party tool.
      </div>
    </div>
    <div id="sec-float-tip" style="display:none;position:fixed;z-index:9999;max-width:240px;padding:9px 12px;border-radius:8px;background:#13131F;border:1px solid rgba(255,255,255,0.13);font-size:13px;color:#C8C8D8;line-height:1.65;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,0.6)"></div>`;

  document.getElementById('sec-run-btn')?.addEventListener('click', () => {
    if (!_secChecking) runCheck();
  });

  // Floating tooltip — follows mouse, appears on any [data-tip] element
  const floatTip = panel.querySelector('#sec-float-tip');
  if (floatTip) {
    panel.querySelectorAll('[data-tip]').forEach(el => {
      el.addEventListener('mouseenter', e => {
        floatTip.textContent = el.dataset.tip;
        floatTip.style.display = 'block';
      });
      el.addEventListener('mousemove', e => {
        const tipH = floatTip.offsetHeight;
        const tipW = floatTip.offsetWidth || 244;
        const x    = Math.min(e.clientX + 12, window.innerWidth - tipW - 8);
        const y    = (window.innerHeight - e.clientY) < (tipH + 24)
                     ? e.clientY - tipH - 8
                     : e.clientY + 16;
        floatTip.style.left = Math.max(4, x) + 'px';
        floatTip.style.top  = Math.max(4, y) + 'px';
      });
      el.addEventListener('mouseleave', () => { floatTip.style.display = 'none'; });
    });
  }

  document.getElementById('sec-reviewed-toggle')?.addEventListener('change', (e) => {
    const walletType = _secResult?.walletType ?? 'unknown';
    _reviewedAutoApprove = e.target.checked;
    const key = `secReviewed_${walletType}`;
    if (_reviewedAutoApprove) chrome.storage.local.set({ [key]: true });
    else chrome.storage.local.remove(key);
    renderSecurityPanel();
    // Push updated reviewed state to the widget immediately
    if (_secResult) {
      chrome.runtime.sendMessage({ type: 'PUSH_SEC_RESULT', result: _secResult, reviewed: _reviewedAutoApprove }, () => void chrome.runtime.lastError);
    }
  });
}

// ── Run scan ─────────────────────────────────────────────────────────────────
async function runCheck() {
  // Re-detect pubkey fresh each time in case the tab changed
  await detectWallet().catch(() => {});
  const pubkey = walletPubkey;
  if (!pubkey) {
    // If we already have valid results, preserve them and show a warning banner
    if (_secResult && _secResult.score != null) {
      _secWalletMissing = true;
      renderSecurityPanel();
      return;
    }
    // No prior results — show the full no-wallet state
    _secResult = {
      score: null, checkedAt: Date.now(), pubkey: null, walletType: 'unknown',
      totalAccounts: 0, unlimitedApprovals: [], badContracts: [],
      findings: [{ severity: 'WARN', text: 'No wallet detected', detail: 'Visit jup.ag and connect your wallet there — ZendIQ will detect the public address automatically.' }],
    };
    renderSecurityPanel();
    return;
  }

  _secWalletMissing = false;
  _secChecking = true;
  // Do NOT null _secResult here — keep the previous result visible while rescanning
  // so the panel shows the old score/findings instead of a blank "Scanning…" spinner.
  // renderSecurityPanel() re-renders the Re-check button as "Scanning…" via _secChecking.
  renderSecurityPanel();

  const findings      = [];
  let   unlimitedList = [];
  let   knownBadList  = [];
  let   totalAccounts = 0;

  try {
    const PROGRAMS = [
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ];
    // Fetch both token programs in parallel to halve the wall-clock time
    const results = await Promise.allSettled(
      PROGRAMS.map(programId => popupRpcCall('getTokenAccountsByOwner', [pubkey, { programId }, { encoding: 'jsonParsed' }]))
    );
    let allAccounts = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allAccounts = allAccounts.concat(r.value?.result?.value ?? []);
    }
    totalAccounts = allAccounts.length;

    for (const acct of allAccounts) {
      const info = acct?.account?.data?.parsed?.info;
      if (!info) continue;
      const { delegate, delegatedAmount, mint } = info;
      if (!delegate) continue;
      const delegatedRaw = Number(delegatedAmount?.amount ?? 0);
      if (delegatedRaw < UNLIMITED_THRESHOLD) continue;
      const entry = { delegate, mint: mint ?? 'Unknown', delegatedRaw };
      unlimitedList.push(entry);
      if (DRAIN_CONTRACTS.has(delegate)) knownBadList.push(entry);
    }

    const unknownUnlimited = unlimitedList.length - knownBadList.length;
    let rawScore = 100;
    rawScore -= Math.min(knownBadList.length  * 30, 60);
    rawScore -= Math.min(unknownUnlimited     * 20, 40);
    rawScore  = Math.max(0, rawScore);
    const score = rawScore; // kept for _secResult.score compat

    if (knownBadList.length > 0) {
      findings.push({
        severity: 'CRITICAL',
        text:     `${knownBadList.length} known drainer contract${knownBadList.length > 1 ? 's' : ''} has token approval`,
        detail:   'Revoke immediately — these contracts are confirmed wallet drainers',
        tooltip:  'CRITICAL RISK: These contract addresses are in ZendIQ\'s known-drainer database. A wallet drainer is a smart contract deliberately designed to steal funds. It already has unlimited permission to move your tokens — it can and likely will execute a full drain at any time. Go to revoke.cash NOW, connect your wallet, and revoke all approvals to these addresses. Do not make any more transactions until this is done.',
      });
    }
    if (unknownUnlimited > 0) {
      findings.push({
        severity: 'HIGH',
        text:     `${unknownUnlimited} unlimited token approval${unknownUnlimited > 1 ? 's' : ''} active`,
        detail:   "Review and revoke any you don't recognise at revoke.cash",
        tooltip:  'HIGH RISK: You have given at least one contract unlimited permission to transfer your tokens. Even if the contract is legitimate today, it retains this permission forever unless you revoke it. If the contract is later compromised, upgraded maliciously, or was always a scam, it can drain every token that has this approval — without any further action from you. Visit revoke.cash to review and revoke approvals you no longer need.',
      });
    }

    // Wallet-type guidance
    const autoApproveWarnings = {
      phantom: {
        text:    'Action required: check & disable Phantom auto-approve',
        detail:  'Disable auto-approve for all dApps — it lets sites sign transactions silently without a popup.',
        steps:   'Inside Phantom → click the ⚙️ Settings tab → Security & Privacy → Trusted Apps → review each entry and disable auto-approve.',
        tooltip: 'RISK: If Phantom auto-approve is enabled for a dApp, any malicious script or compromised site that has been granted access can silently sign transactions WITHOUT showing you a confirmation popup — resulting in a complete wallet drain. Open the Phantom browser extension, go to Settings → Security & Privacy → Trusted Apps, and remove or disable auto-approve for any entry you do not recognise.',
      },
      backpack: {
        text:    'Action required: check & disable Backpack transaction approvals',
        detail:  'Disable pre-approved dApps — they can sign transactions silently without a confirmation popup.',
        steps:   'Inside Backpack → Settings → Security → Transaction Approval → remove pre-approved dApps you no longer use.',
        tooltip: 'RISK: Backpack pre-approved dApps can sign transactions silently. A malicious or compromised site with pre-approval can drain your entire wallet without triggering a confirmation prompt. Regularly audit Settings → Security → Transaction Approval.',
      },
      solflare: {
        text:    'Action required: check & disable Solflare auto-sign sessions',
        detail:  'Disable active auto-sign sessions — they allow sites to submit transactions at any time without your confirmation.',
        steps:   'Inside Solflare → Settings → Security → Auto-sign → revoke any sessions you do not actively need.',
        tooltip: 'RISK: Solflare auto-sign sessions allow a connected site to submit signed transactions at any time while the session is active. A malicious site with an auto-sign session can drain your wallet silently. Revoke all sessions you do not actively need.',
      },
      glow: {
        text:    'Action required: check & disable Glow connected apps',
        detail:  'Disable signing rights for connected apps — they can submit transactions without a per-transaction popup.',
        steps:   'Inside Glow → Settings → Connected Apps → remove any apps with signing rights you no longer use.',
        tooltip: 'RISK: Connected apps in Glow that have signing rights can submit transactions without a per-transaction popup. If any connected app is malicious or gets compromised, it can drain your wallet. Revoke connections to apps you are not actively using.',
      },
      brave: {
        text:    'Action required: check & disable Brave Wallet dApp connections',
        detail:  'Disable authorised site connections — they can request transaction signatures at any time.',
        steps:   'Inside Brave → Crypto Wallets icon → Sites with access → revoke authorised dApps you no longer use.',
        tooltip: 'RISK: Sites with Brave Wallet access can request transaction signatures at any time. If an authorised site runs malicious code (e.g. via a supply-chain attack), it can drain your wallet. Remove access for any site you do not actively use.',
      },
      jupiter: {
        text:    'Action required: check & disable Jupiter Wallet auto-approve',
        detail:  'Disable Auto Approve and Skip Review — these bypass confirmation popups and are a drain risk if left on.',
        steps:   'Inside Jupiter Wallet → click ⋮ (top right) → Manage Settings → Preferences: ensure Auto Approve = Disabled and Skip Review = Disabled → then Security → Connected Apps → remove any sites you no longer use.',
        tooltip: 'RISK: Jupiter Wallet has two bypass settings. "Auto Approve" (Preferences) silently signs transactions without a popup. "Skip Review" skips the transaction review screen. Either can be exploited by a malicious connected site to drain your wallet. Also check Security → Connected Apps and remove any sites you do not recognise.',
      },
    };

    // Detect wallet type from injected providers via the active jup.ag tab
    let detectedType = 'unknown';
    try {
      const [tab] = await new Promise(res => chrome.tabs.query({ url: ['*://*.jup.ag/*', '*://raydium.io/*', '*://*.raydium.io/*', '*://pump.fun/*', '*://*.pump.fun/*'], active: true }, ts => res(ts ?? [])));
      if (tab) {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (connectedPubkey) => {
            const nameToType = (name = '') => {
              name = name.toLowerCase();
              if (name.includes('jupiter'))  return 'jupiter';
              if (name.includes('backpack')) return 'backpack';
              if (name.includes('solflare')) return 'solflare';
              if (name.includes('glow'))     return 'glow';
              if (name.includes('phantom'))  return 'phantom';
              if (name.includes('coin98'))   return 'coin98';
              if (name.includes('brave'))    return 'brave';
              return null;
            };
            try {
              // Collect all Wallet Standard wallets
              const found = [];
              window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
                detail: { register(w) { found.push(w); } },
              }));
              // 1st pass: find whichever wallet has the connected account
              if (connectedPubkey) {
                for (const w of found) {
                  for (const acc of (w?.accounts ?? [])) {
                    const addr = acc?.address ?? acc?.publicKey?.toString?.();
                    if (addr === connectedPubkey) return nameToType(w.name) ?? 'unknown';
                  }
                }
              }
              // 2nd pass: name-based, but skip browser-native wallets (Brave)
              // so a browser-injected wallet doesn't shadow an extension wallet
              for (const w of found) {
                const t = nameToType(w.name);
                if (t && t !== 'brave') return t;
              }
              // 3rd pass: accept Brave if still nothing found
              for (const w of found) {
                const t = nameToType(w.name);
                if (t) return t;
              }
            } catch (_) {}
            // Legacy namespace fallbacks (last resort)
            if (window.jupiterWallet || window.jupiter?.solana || window.solana?.isJupiter) return 'jupiter';
            if (window.phantom?.solana?.isPhantom)                                return 'phantom';
            if (window.backpack?.solana || window.xnft?.solana)                   return 'backpack';
            if (window.solflare?.isSolflare || window.solana?.isSolflare)         return 'solflare';
            if (window.solana?.isGlow)                                             return 'glow';
            if (window.solana?.isCoin98)                                           return 'coin98';
            if (window.solana?.isBrave || window.braveSolana)                     return 'brave';
            if (window.solana?.isPhantom)                                          return 'phantom';
            return 'unknown';
          },
          args: [pubkey],
        });
        detectedType = result?.result ?? 'unknown';
      }
    } catch (_) { /* tab not found or scripting failed — ignore */ }

    const autoWarn = autoApproveWarnings[detectedType];
    if (autoWarn) findings.push({ severity: 'WARN', ...autoWarn, reviewable: true });

    // Load whether the user already reviewed auto-approve for this wallet type
    const reviewedKey = `secReviewed_${detectedType}`;
    _reviewedAutoApprove = false;
    try {
      const stored = await new Promise(res => chrome.storage.local.get([reviewedKey], res));
      _reviewedAutoApprove = !!stored[reviewedKey];
    } catch (_) {}

    // Auto-approve deduction: −10 until user marks as reviewed
    const autoApproveDeduction = autoWarn ? 20 : 0;

    if (!findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')) {
      findings.unshift({
        severity: 'OK',
        text:     unlimitedList.length === 0
          ? `0 harmful accounts found`
          : `${unlimitedList.length} approval${unlimitedList.length > 1 ? 's' : ''} found — none match known drainers`,
        detail:   'Approval scan complete',
        tooltip:  'All SPL Token and Token-2022 program accounts were checked for active delegate approvals. None with unlimited amounts were found, which means no third-party contract currently has blanket permission to transfer your tokens. Continue practicing good hygiene: revoke approvals after every interaction and review regularly.',
      });
    }

    _secResult = { score, rawScore, autoApproveDeduction, checkedAt: Date.now(), pubkey, walletType: detectedType, totalAccounts, unlimitedApprovals: unlimitedList, badContracts: knownBadList, findings };
    // Persist so the tab badge survives popup close/reopen
    chrome.storage.local.set({ secLastResult: _secResult });
    // Notify the active jup.ag page so the widget wallet tab updates immediately
    chrome.runtime.sendMessage({ type: 'PUSH_SEC_RESULT', result: _secResult, reviewed: _reviewedAutoApprove });

  } catch (e) {
    _secResult = {
      score: null, checkedAt: Date.now(), pubkey, walletType: 'unknown',
      totalAccounts, unlimitedApprovals: [], badContracts: [],
      findings: [{ severity: 'WARN', text: 'Security check failed', detail: e.message?.slice(0, 100) ?? 'Unknown error' }],
    };
  } finally {
    _secChecking = false;
    renderSecurityPanel();
  }
}

// ── Public: update display from a new stored result without starting a scan ──
// Used by popup.js storage-change handler so a widget scan updates the popup
// without triggering the re-scan loop (initSecurityBadge always calls runCheck).
function refreshSecurityDisplay(newResult) {
  if (!newResult || typeof newResult !== 'object') return;
  if (_secChecking) return; // scan in progress — let it finish, it will re-render
  _secResult = newResult;
  const key = `secReviewed_${_secResult.walletType ?? 'unknown'}`;
  chrome.storage.local.get([key], (data) => {
    _reviewedAutoApprove = !!data[key];
    _updateSecurityTabColor();
    renderSecurityPanel();
  });
}

// ── Public: restore tab badge colour on every popup open ────────────────
// Called after detectWallet() resolves so walletPubkey is guaranteed to be set.
function initSecurityBadge() {
  chrome.storage.local.get(['secLastResult'], ({ secLastResult }) => {
    if (secLastResult) {
      _secResult = secLastResult;
      const key = `secReviewed_${_secResult.walletType ?? 'unknown'}`;
      // Inner callback: restore reviewed state, paint badge, THEN start scan.
      // This ensures _lastKnownTabColor is seeded before runCheck() blanks _secResult.
      chrome.storage.local.get([key], (data) => {
        _reviewedAutoApprove = !!data[key];
        _updateSecurityTabColor(); // seeds _lastKnownTabColor
        if (walletPubkey && !_secChecking) runCheck();
      });
    } else {
      // No stored result — start scan immediately; icon stays grey until done
      if (walletPubkey && !_secChecking) runCheck();
    }
  });
}

// ── Public: called by popup.js when the Security tab is opened ───────────────
function loadSecurity() {
  // Restore reviewed state from storage if we already have a scan result
  if (_secResult?.walletType && _secResult.walletType !== 'unknown') {
    chrome.storage.local.get([`secReviewed_${_secResult.walletType}`], (data) => {
      _reviewedAutoApprove = !!data[`secReviewed_${_secResult.walletType}`];
      renderSecurityPanel();
    });
  } else {
    renderSecurityPanel();
  }
  // Auto-run on first open if a pubkey is available
  if (!_secResult && !_secChecking && walletPubkey) {
    runCheck();
  }
}
