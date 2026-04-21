/**
 * ZendIQ – widget.js
 * DOM widget: injectStatusIndicator, renderWidgetPanel, openZendIQPanel,
 * updateWidgetStatus, ensureWidgetInjected, savePillState.
 */

(function () {
  'use strict';
  const ns = window.__zq;

  // HTML-escape helper for safe innerHTML rendering of storage-derived values
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Update status text safely ────────────────────────────────────────────
  function updateWidgetStatus(newStatus) {
    const status = document.getElementById('sr-pill-status');
    if (status) {
      status.textContent = newStatus;
    } else {
      setTimeout(() => updateWidgetStatus(newStatus), 500);
    }
  }

  // ── Ensure widget is injected when DOM is ready ──────────────────────────
  function ensureWidgetInjected() {
    if (document.getElementById('sr-widget')) {
      if (ns.walletHooked) updateWidgetStatus('Active');
      return;
    }
    if (!document.body) {
      setTimeout(ensureWidgetInjected, 100);
      return;
    }
    injectStatusIndicator();
    if (ns.walletHooked) updateWidgetStatus('Active');
  }

  // ── Settings helpers ─────────────────────────────────────────────────────
  // balanced = LOW/0/0 so every swap is intercepted; the 'only when profitable' promise
  // is upheld by the net-benefit gate inside fetchWidgetQuote, not the threshold check.
  const WIDGET_PROFILES = {
    alert:    { minRiskLevel: 'LOW', minLossUsd: 0, minSlippage: 0 },
    balanced: { minRiskLevel: 'LOW', minLossUsd: 0, minSlippage: 0 },
    focused:  { minRiskLevel: 'HIGH', minLossUsd: 10, minSlippage: 2 },
  };

  function _saveWidgetSettings() {
    try {
      window.postMessage({
        type: 'ZENDIQ_SAVE_SETTINGS',
        payload: {
          uiMode:           ns.widgetMode          ?? 'simple',
          autoProtect:      ns.autoProtect         ?? false,
          autoAccept:       ns.autoAccept          ?? false,
          pauseOnHighRisk:  ns.pauseOnHighRisk      ?? true,
          jitoMode:     ns.jitoMode            ?? 'auto',
          profile:      ns.settingsProfile     ?? 'alert',
          minRiskLevel: ns.threshMinRiskLevel  ?? 'LOW',
          minLossUsd:   ns.threshMinLossUsd    ?? 0,
          minSlippage:  ns.threshMinSlippage   ?? 0,
        },
      }, '*');
    } catch (_) {}
  }

  function _applyWidgetProfile(name) {
    ns.settingsProfile = name;
    if (name !== 'custom' && WIDGET_PROFILES[name]) {
      const p = WIDGET_PROFILES[name];
      ns.threshMinRiskLevel = p.minRiskLevel;
      ns.threshMinLossUsd   = p.minLossUsd;
      ns.threshMinSlippage  = p.minSlippage;
    }
    _saveWidgetSettings();
    renderWidgetPanel();
  }

  function _wireSettingsPanel(bodyInner) {
    // Auto-protect toggle
    const apCheck = bodyInner.querySelector('#sr-set-autoprotect');
    if (apCheck) apCheck.onchange = () => { ns.autoProtect = apCheck.checked; _saveWidgetSettings(); renderWidgetPanel(); };

    // Auto-accept toggle
    const aaCheck = bodyInner.querySelector('#sr-set-autoaccept');
    const aaHint  = bodyInner.querySelector('#sr-set-autoaccept-hint');
    if (aaCheck) aaCheck.onchange = () => {
      ns.autoAccept = aaCheck.checked;
      _saveWidgetSettings();
      renderWidgetPanel();
    };

    // Pause on high token risk toggle
    const phrCheck = bodyInner.querySelector('#sr-set-pausehighrisk');
    if (phrCheck) phrCheck.onchange = () => {
      ns.pauseOnHighRisk = phrCheck.checked;
      _saveWidgetSettings();
      renderWidgetPanel();
    };

    // Profile buttons
    ['alert', 'balanced', 'focused', 'custom'].forEach(p => {
      const btn = bodyInner.querySelector(`#sr-set-profile-${p}`);
      if (btn) btn.onclick = () => _applyWidgetProfile(p);
    });

    // Custom threshold — risk level buttons
    ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].forEach(lvl => {
      const btn = bodyInner.querySelector(`#sr-set-lvl-${lvl}`);
      if (btn) btn.onclick = () => {
        ns.threshMinRiskLevel = lvl;
        ns.settingsProfile    = 'custom';
        _saveWidgetSettings();
        renderWidgetPanel();
      };
    });

    // Custom threshold numeric inputs
    const lossInput = bodyInner.querySelector('#sr-set-loss');
    const slipInput = bodyInner.querySelector('#sr-set-slip');
    if (lossInput) lossInput.oninput = () => {
      ns.threshMinLossUsd  = parseFloat(lossInput.value) || 0;
      ns.settingsProfile   = 'custom';
      _saveWidgetSettings();
    };
    if (slipInput) slipInput.oninput = () => {
      ns.threshMinSlippage = parseFloat(slipInput.value) || 0;
      ns.settingsProfile   = 'custom';
      _saveWidgetSettings();
    };

    // Jito mode radios
    bodyInner.querySelectorAll('input[name="sr-jito"]').forEach(radio => {
      radio.onchange = () => {
        if (radio.checked) {
          ns.jitoMode = radio.value;
          _saveWidgetSettings();
          renderWidgetPanel();
        }
      };
    });

  }

  // ── renderWidgetPanel ────────────────────────────────────────────────────
  function renderWidgetPanel() {
    // ── Hide any lingering Activity tooltip before rebuilding DOM ─────────
    try { const _t = document.getElementById('sr-zq-tip'); if (_t) _t.style.display = 'none'; } catch(e){}
    // ── Shared token metadata (all 7 supported tokens + SOL) ─────────────
    const MINT_DEC = {
      'So11111111111111111111111111111111111111112':  9,  // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  6, // JUP
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5, // BONK
      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 6, // WIF
      '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':  6, // RAY
    };
    const MINT_SYM = {
      'So11111111111111111111111111111111111111112':  'SOL',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  'JUP',
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
      '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':  'RAY',
    };
    // Simple-mode plain-English risk label — available across all panels (Monitor, Review & Sign).
    const _riskLabel = l => ({'LOW':'✓ Low risk','MEDIUM':'⚠ Moderate risk','HIGH':'⚠ High risk','CRITICAL':'⛔ Critical risk'}[l] ?? l ?? '—');

    // ── Shared Review & Sign panel builders ──────────────────────────────────
    // These helpers produce the standard card HTML used by every DEX integration
    // (pump.fun today; add new sites by calling these with different opts).
    // All helpers return an HTML string and are pure (no side effects).

    // Risk-level → brand colour
    const _rClr = lv => ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[lv] ?? '#C2C2D4';

    // Generic factor-row list (shared by Token Risk, Execution Risk, Bot Risk)
    // Within-tier danger priority — lower number = more dangerous = shown first.
    const _factorPriority = name => {
      const n = (name ?? '').toLowerCase();
      // CRITICAL tier
      if (n.startsWith('bot factory'))             return 10;
      if (n.startsWith('bot-created'))             return 10;
      if (n.includes('prev tokens went to zero'))  return 15;
      if (n.startsWith('bundled launch'))          return 20;
      if (n.startsWith('unlimited supply'))        return 25;
      if (n.startsWith('whale risk'))              return 30;
      if (n.startsWith('active pump'))             return 35;
      if (n.startsWith('volume collapsed'))        return 40;
      // HIGH tier
      if (n.startsWith('possible bundle'))         return 10;
      if (n.startsWith('freeze authority active')) return 15;
      if (n.startsWith('large holder'))            return 20;
      if (n.startsWith('insider supply'))          return 25;
      if (n.startsWith('serial launcher'))         return 30;
      if (n.startsWith('new token: <'))            return 38;
      if (n.startsWith('new token:'))              return 42;
      if (n.startsWith('pump in progress'))        return 50;
      if (n.startsWith('low liquidity'))           return 55;
      if (n.startsWith('micro-cap'))               return 60;
      if (n.startsWith('volume dying'))            return 65;
      // MEDIUM tier
      if (n.startsWith('flagged risk'))            return 10;
      if (n.startsWith('copycat'))                 return 15;
      if (n.startsWith('lp fully unlocked'))       return 20;
      if (n.startsWith('lp mostly unlocked'))      return 22;
      if (n.startsWith('concentrated'))            return 25;
      if (n.includes('lp providers'))              return 30;
      if (n.startsWith('recent token'))            return 35;
      if (n.startsWith('rising fast'))             return 40;
      if (n.startsWith('repeat creator'))          return 45;
      if (n.startsWith('small-cap'))               return 50;
      if (n.startsWith('volume fading'))           return 55;
      return 99;
    };
    const SEV_ORDER_TOK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

    const _factorRows = (factors, showSimple) => {
      if (showSimple || !factors?.length) return '';
      const sorted = factors.slice().sort((a, b) => {
        const sd = (SEV_ORDER_TOK[a.severity] ?? 9) - (SEV_ORDER_TOK[b.severity] ?? 9);
        return sd !== 0 ? sd : _factorPriority(a.name) - _factorPriority(b.name);
      });
      return '<div style="margin-top:6px">' + sorted.map(f => {
        const fc  = _rClr(f.severity);
        const tip = (f.detail ?? '').replace(/"/g, '&quot;');
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ${fc};border-radius:0 5px 5px 0;margin-bottom:3px;cursor:help" title="${tip}">` +
          `<span style="font-size:12px;color:#C0C0D8">${f.name}</span>` +
          `<span style="font-size:9px;font-weight:700;color:${fc};font-family:Space Mono,monospace">${f.severity}</span></div>`;
      }).join('') + '</div>';
    };

    // ── Card: Order / Trade Summary ──────────────────────────────────────────
    // rows: [{ label, value, valueColor?, tooltip? }, ...]
    // section: optional section title override (default "ZendIQ Optimisation")
    const _buildOrderCard = (rows, section) => {
      const title = section ?? 'ZendIQ Optimisation';
      const rowsHtml = rows.map(r =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0${r.tooltip ? ';cursor:help' : ''}" ${r.tooltip ? `title="${r.tooltip.replace(/"/g, '&quot;')}"` : ''}>` +
          `<span style="font-size:13px;color:#C2C2D4">${r.label}</span>` +
          `<span style="font-size:13px;font-weight:600;${r.valueColor ? `color:${r.valueColor};` : 'color:#E8E8F0;'}font-family:'Space Mono',monospace">${r.value}</span>` +
        `</div>`
      ).join('');
      return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.6px;color:#C2C2D4;font-weight:700;margin-bottom:8px">${title}</div>
        ${rowsHtml}
      </div>`;
    };

    // ── Card: Token Risk Score ────────────────────────────────────────────────
    // tokenScore: ns.tokenScoreResult or pfc.tokenScore (may be null / not yet loaded)
    const _buildTokenRiskCard = (tokenScore, isSimple) => {
      const loaded  = tokenScore?.loaded;
      const tsc     = loaded ? _rClr(tokenScore.level) : '#FFB547';
      const badge   = loaded
        ? (isSimple ? _riskLabel(tokenScore.level) : `${tokenScore.level} \u00b7 ${tokenScore.score}/100`)
        : 'Scanning\u2026';
      const rows    = loaded ? _factorRows(tokenScore.factors, isSimple) : (isSimple ? '' : '<div style="margin-top:6px;font-size:12px;color:#C2C2D4;font-style:italic">Scanning token\u2026</div>');
      const divider = loaded && rows ? ';margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06)' : '';
      return `<div style="background:${tsc}11;border:1px solid ${tsc}44;border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help"
        title="Token Risk Score \u2014 on-chain + RugCheck.xyz analysis of the token you are buying.&#10;Score 0\u2013100: LOW &lt;25 | MEDIUM 25\u201349 | HIGH 50\u201374 | CRITICAL 75+">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px${divider}">
          <span style="color:${tsc};font-weight:600">Token Risk Score</span>
          <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${tsc}">${badge}</span>
        </div>${rows}
      </div>`;
    };

    // ── Card: Execution Risk ──────────────────────────────────────────────────
    // risk: ns.lastRiskResult (may be null)
    const _buildExecutionRiskCard = (risk, isSimple) => {
      if (!risk) return '';
      const rc      = _rClr(risk.level);
      const badge   = isSimple ? _riskLabel(risk.level) : `${risk.level} \u00b7 ${risk.score}/100`;
      const rows    = _factorRows(risk.factors, isSimple);
      const divider = rows ? ';margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06)' : '';
      return `<div style="background:${rc}11;border:1px solid ${rc}44;border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help"
        title="Execution Risk \u2014 network congestion, trade size and token characteristics.&#10;Score 0\u2013100: LOW &lt;25 | MEDIUM 25\u201349 | HIGH 50\u201374 | CRITICAL 75+">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px${divider}">
          <span style="color:${rc};font-weight:600">Execution Risk</span>
          <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${rc}">${badge}</span>
        </div>${rows}
      </div>`;
    };

    // ── Card: Savings & Costs ─────────────────────────────────────────────────
    // rows: [{ label, value, valueColor?, tooltip? }, ...]   (same shape as _buildOrderCard)
    // divider: optional index before which to insert a <hr> divider (0-based within rows)
    const _buildSavingsCostsCard = (rows, dividerAfterIdx) => {
      const rowsHtml = rows.map((r, i) => {
        const sep = (dividerAfterIdx != null && i === dividerAfterIdx)
          ? '<div style="border-top:1px solid rgba(255,255,255,0.06);margin:6px 0"></div>' : '';
        return sep + `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0${r.tooltip ? ';cursor:help' : ''}" ${r.tooltip ? `title="${r.tooltip.replace(/"/g, '&quot;')}"` : ''}>` +
          `<span style="font-size:13px;color:#C2C2D4">${r.label}</span>` +
          `<span style="font-size:13px;font-weight:700;font-family:'Space Mono',monospace;color:${r.valueColor ?? '#E8E8F0'}">${r.value}</span>` +
        `</div>`;
      }).join('');
      return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.6px;color:#C2C2D4;font-weight:700;margin-bottom:8px">Savings &amp; Costs</div>
        ${rowsHtml}
      </div>`;
    };

    // ── Shell: scrollable body + sticky footer ────────────────────────────────
    // cardsHtml : HTML string for the scrollable card stack
    // note      : small grey disclaimer line below the cards (optional)
    // primaryBtn: { id, label, style? }
    // secondaryBtns: [{ id, label, tooltip? }, ...]  (rendered grey, stacked)
    const _buildReviewShell = (cardsHtml, note, primaryBtn, secondaryBtns) => {
      const noteHtml = note ? `<div style="font-size:12px;color:#4A4A6A;line-height:1.5;padding:0 2px 10px">${note}</div>` : '';
      const secBtns  = (secondaryBtns ?? []).map(b =>
        `<button id="${b.id}" data-adapter-btn style="width:100%;padding:10px;background:none;border:1px solid rgba(255,255,255,0.12);color:#C2C2D4;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;margin-top:7px" ${b.tooltip ? `title="${b.tooltip.replace(/"/g, '&quot;')}"` : ''}>${b.label}</button>`
      ).join('');
      const primStyle = primaryBtn.style ?? 'border:none;background:linear-gradient(135deg,#14F195,#0cc97a);color:#061a10;box-shadow:0 3px 12px rgba(20,241,149,0.3)';
      return `
        <div id="sr-ready-scroll" style="flex:1;min-height:0;overflow-y:auto;padding:14px 16px 4px">
          ${cardsHtml}${noteHtml}
        </div>
        <div id="sr-ready-footer" style="flex-shrink:0;padding:8px 16px 12px;border-top:1px solid rgba(255,255,255,0.06);background:#12121E">
          <button id="${primaryBtn.id}" data-adapter-btn style="width:100%;padding:11px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;${primStyle}">${primaryBtn.label}</button>
          ${secBtns}
        </div>`;
    };
    // ── End shared Review & Sign builders ────────────────────────────────────
    // Expose card builders to site adapters (pump, raydium, etc.)
    Object.assign(ns, { _rClr, _riskLabel, _factorRows, _buildOrderCard, _buildTokenRiskCard, _buildExecutionRiskCard, _buildSavingsCostsCard, _buildReviewShell });

    const widget = document.getElementById('sr-widget');
    if (!widget) return;
    const bodyInner = widget.querySelector('#sr-body-inner');
    if (!bodyInner) return;

    // ── Auto-refresh timer management ────────────────────────────────────
    // Keep quote fresh while user is reading it; stop when signing or swapped
    const timerActive = ns.widgetSwapStatus === 'ready';
    if (timerActive && !ns._quoteRefreshTimer) {
      ns._quoteRefreshTimer = setInterval(() => {
        if (ns.widgetSwapStatus === 'ready') {
          ns.fetchWidgetQuote(true);
        } else {
          clearInterval(ns._quoteRefreshTimer);
          ns._quoteRefreshTimer = null;
        }
      }, 10_000);
    } else if (!timerActive && ns._quoteRefreshTimer) {
      clearInterval(ns._quoteRefreshTimer);
      ns._quoteRefreshTimer = null;
    }

    // Wallet info
    let walletAddr = '';
    let walletConnected = false;
    let fullWalletPubkey = '';
    try {
      const pk = ns.resolveWalletPubkey();
      if (pk) {
        fullWalletPubkey = pk;
        walletAddr = pk.slice(0, 4) + '…' + pk.slice(-4);
        walletConnected = true;
      } else {
        const w = window.phantom?.solana || window.solflare || window.backpack?.solana || window.solana;
        if (w?.publicKey) {
          const raw = typeof w.publicKey === 'string' ? w.publicKey : (w.publicKey?.toBase58?.() ?? w.publicKey?.toString?.() ?? '');
          if (raw && raw.length >= 32) {
            fullWalletPubkey = raw;
            walletAddr = raw.slice(0, 4) + '…' + raw.slice(-4);
            walletConnected = w.isConnected !== false;
          }
        }
      }
    } catch(_) {}

    // Wallet tab shield colour — mirrors popup _updateSecurityTabColor() logic.
    // Colours only the SVG; text stays at the active/inactive default.
    // Held constant during a re-scan (walletSecurityChecking) to avoid flash.
    const _wsResult = ns.walletSecurityResult;
    const _wsChecking = ns.walletSecurityChecking;
    const _shieldColor = (() => {
      if (_wsChecking && ns._lastWalletShieldColor) return ns._lastWalletShieldColor; // no flash
      if (!_wsResult) return ns._lastWalletShieldColor || '#FFB547'; // amber until first scan
      const raw = _wsResult.score ?? null;
      const ad  = _wsResult.autoApproveDeduction ?? 0;
      const ds  = raw == null ? null : Math.max(0, raw - ((ns.walletReviewedAutoApprove ?? false) ? 0 : ad));
      const c = ds == null ? null : ds === 100 ? '#14F195' : ds >= 80 ? '#FFB547' : ds >= 60 ? '#FF6B00' : '#FF4444';
      if (c) ns._lastWalletShieldColor = c;
      return c;
    })();

    // Wallet security panel HTML — rendered from ns.walletSecurityResult / ns.walletSecurityChecking
    const walletSecHtml = (() => {
      const _esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const _wp  = fullWalletPubkey || '';   // use the already-resolved pubkey (same source as wallet bar)
      if (ns.walletSecurityChecking) {
        return `<div style="text-align:center;padding:28px 16px">
          <div style="font-size:12px;color:#C2C2D4;margin-bottom:6px">Scanning on-chain approvals&hellip;</div>
          <div style="font-size:12px;color:#C2C2D4">Checking SPL Token &amp; Token-2022 programs</div>
        </div>`;
      }
      if (!ns.walletSecurityResult) {
        // If the extension popup has never been opened (onboarded flag explicitly false),
        // instruct the user to open the ZendIQ popup — we rely on popup
        // initialization to restore persisted scan state and settings.
        // null = not yet loaded from storage → fall through to pubkey-based checks.
        if (ns.onboarded === false) {
          return `
            <div style="font-size:13px;font-weight:700;color:#E8E8F0;margin-bottom:8px">Wallet Security Check</div>
            <div style="margin-top:4px;padding:12px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);font-size:12px;color:#C0C0D8;line-height:1.6">
              <div style="font-weight:700;color:#E8E8F0;margin-bottom:6px">Open the ZendIQ popup to enable the wallet scan</div>
              <div style="margin-bottom:6px">1. Click the ZendIQ extension icon in your browser toolbar to open the popup.</div>
              <div style="margin-bottom:6px">2. In the popup, connect your wallet to <a href="https://jup.ag" target="_blank" rel="noopener" style="color:#9945FF;font-weight:700;text-decoration:none">jup.ag</a> in this tab.</div>
              <div style="margin-bottom:6px">3. Return to this tab — the widget will automatically restore the scan result.</div>
              <div style="margin-top:10px"><button id="sr-open-popup" style="width:100%;padding:10px;border:1px solid rgba(153,69,255,0.3);border-radius:8px;background:linear-gradient(135deg,#9945FF,#6B2BFF);color:#fff;font-size:13px;font-weight:700;cursor:pointer">Open ZendIQ popup</button></div>
              <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04);font-size:13px;color:#C2C2D4">ZendIQ never reads or stores your private key or seed phrase — only your public address is used.</div>
            </div>`;
        }
        // Otherwise fall back to the in-page guidance (no pubkey present yet)
        if (!_wp) return `
          <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.8px;color:#C2C2D4;margin-bottom:10px">Wallet Security Check</div>
          <div style="margin-top:4px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);font-size:12px;color:#C2C2D4;line-height:1.7">
            <div style="font-weight:700;color:#E8E8F0;margin-bottom:5px">How to enable the wallet scan:</div>
            <div style="margin-bottom:4px">1. Open <a href="https://jup.ag" target="_blank" rel="noopener" style="color:#9945FF;font-weight:700;text-decoration:none">jup.ag</a> in this tab and connect your wallet to Jupiter there.</div>
            <div style="margin-bottom:4px">2. ZendIQ automatically reads your <strong style="color:#E8E8F0">public address</strong> from the page &mdash; no wallet is added to ZendIQ itself.</div>
            <div>3. Return here and click <strong style="color:#E8E8F0">Run Security Check</strong>.</div>
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#E8E8F0">
              <span style="color:#14F195">&#x2713;</span> <strong>Your private key and seed phrase are never read or stored by ZendIQ.</strong>
            </div>
          </div>`;
        return `
          <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.8px;color:#C2C2D4;margin-bottom:10px">Wallet Security Check</div>
          <p style="font-size:13px;color:#C2C2D4;line-height:1.65;margin-bottom:14px">ZendIQ scans your wallet for <strong style="color:#E8E8F0">unlimited token approvals</strong>, known drain contracts, and wallet-specific risks.<br><br>All checks are read-only queries against your <strong style="color:#E8E8F0">public wallet address</strong>. ZendIQ never has access to your <strong style="color:#14F195">private key</strong> or seed phrase, and no data ever leaves your browser.</p>
          <button id="sr-sec-run" style="width:100%;padding:10px;border:1px solid rgba(153,69,255,0.3);border-radius:8px;background:rgba(153,69,255,0.1);color:#9945FF;font-size:12px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;margin-bottom:8px">&#x1F512; Run Security Check</button>`;
      }
      const _r   = ns.walletSecurityResult;
      const _rev = ns.walletReviewedAutoApprove ?? false;
      const _ad  = _r.autoApproveDeduction ?? 0;
      const _sc  = _r.score ?? null;
      const _dsc = _sc == null ? null : Math.max(0, _sc - (_rev ? 0 : _ad));
      const _scColor = _dsc == null ? '#C2C2D4' : _dsc === 100 ? '#14F195' : _dsc >= 80 ? '#FFB547' : _dsc >= 60 ? '#FF6B00' : '#FF4444';
      const _scLabel = _dsc == null ? 'Unknown' : _dsc === 100 ? 'Secure' : _dsc >= 80 ? 'Review' : _dsc >= 60 ? 'At Risk' : 'Critical';
      const _age = _r.checkedAt ? Math.round((Date.now()-_r.checkedAt)/1000) : null;
      const _ageStr = _age == null ? '' : _age < 60 ? `${_age}s ago` : _age < 3600 ? `${Math.round(_age/60)}m ago` : `${Math.round(_age/3600)}h ago`;
      const _svc = { CRITICAL:'#FF4444', HIGH:'#FF6B00', WARN:'#FFB547', OK:'#14F195' };
      const _svi = { CRITICAL:'&#x26D4;', HIGH:'&#x26A0;', WARN:'&#x26A0;', OK:'&#x2713;' };
      // Split findings: reviewable (auto-approve warning) rendered near top; others below
      const _reviewableFinding = (_r.findings??[]).find(f => f.reviewable);
      const _otherFindings     = (_r.findings??[]).filter(f => !f.reviewable);
      const _renderFinding = (f) => {
        const _isRev = f.reviewable && _rev;
        if (_isRev) return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:7px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);margin-bottom:6px">
          <span style="color:#14F195;font-size:12px">&#x2713;</span>
          <span style="font-size:12px;font-weight:600;color:#14F195;flex:1">Wallet settings reviewed &amp; secured</span>
          <label style="position:relative;display:inline-block;width:36px;height:20px;cursor:pointer;flex-shrink:0">
            <input type="checkbox" id="sr-sec-reviewed-toggle" checked style="position:absolute;opacity:0;width:0;height:0">
            <span style="position:absolute;inset:0;border-radius:10px;background:rgba(20,241,149,0.15);border:1px solid #14F195;transition:all 0.2s"></span>
            <span style="position:absolute;top:2px;left:18px;width:14px;height:14px;border-radius:50%;background:#14F195;transition:left 0.2s,background 0.2s"></span>
          </label>
        </div>`;
        const _stepsHtml = f.steps
          ? `<div style="margin-top:6px;padding:7px 10px;border-radius:6px;background:rgba(153,69,255,0.07);border:1px solid rgba(153,69,255,0.18)">
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.7px;color:#9945FF;font-weight:700;margin-bottom:4px">Steps inside your wallet</div>
              <div style="font-size:12px;color:#E8E8F0;line-height:1.55">${_esc(f.steps)}</div>
            </div>` : '';
        const _toggleHtml = f.reviewable
          ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding:6px 10px;border-radius:7px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06)">
              <span style="font-size:12px;font-weight:600;color:#FFB547">I've disabled unsafe wallet settings</span>
              <label style="position:relative;display:inline-block;width:36px;height:20px;cursor:pointer;flex-shrink:0">
                <input type="checkbox" id="sr-sec-reviewed-toggle" style="position:absolute;opacity:0;width:0;height:0">
                <span style="position:absolute;inset:0;border-radius:10px;background:rgba(26,26,46,1);border:1px solid rgba(255,181,71,0.4);transition:all 0.2s"></span>
                <span style="position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#FFB547;transition:left 0.2s,background 0.2s"></span>
              </label>
            </div>` : '';
        return `<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
          <span style="color:${_svc[f.severity]??'#C2C2D4'};font-size:12px;flex-shrink:0;line-height:1.6">${_svi[f.severity]??'&bull;'}</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;color:${_svc[f.severity]??'#E8E8F0'}">${_esc(f.text)}</div>
            ${f.detail?`<div style="font-size:12px;color:#C2C2D4;margin-top:2px">${_esc(f.detail)}</div>`:''}
            ${_stepsHtml}${_toggleHtml}
          </div>
        </div>`;
      };
      const _reviewableHtml = _reviewableFinding ? _renderFinding(_reviewableFinding) : '';
      const _otherHtml      = _otherFindings.map(_renderFinding).join('');
      const _revokeHtml = (_r.unlimitedApprovals?.length > 0)
        ? `<a href="https://revoke.cash" target="_blank" rel="noopener" style="display:block;margin-top:8px;font-size:13px;font-weight:700;color:#9945FF;text-decoration:none">&#x1F517; Review &amp; revoke at revoke.cash &rarr;</a>` : '';
      return `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
          <div title="Score starts at 100. Deductions: −30 per known drainer contract (max −60), −20 per unlimited approval (max −40), −20 if wallet settings not reviewed." style="cursor:help">
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.8px;color:#C2C2D4;margin-bottom:4px">Wallet Security Score</div>
            <div style="display:flex;align-items:baseline;gap:5px"><span style="font-size:32px;font-weight:900;color:${_scColor};font-family:'Space Mono',monospace;line-height:1">${_dsc??'&mdash;'}</span><span style="font-size:13px;font-weight:700;color:${_scColor}">${_scLabel}</span></div>
          </div>
          <button id="sr-sec-recheck" style="padding:7px 12px;border:1px solid rgba(153,69,255,0.25);border-radius:7px;background:transparent;color:#9945FF;font-size:12px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;flex-shrink:0;margin-top:2px">&circlearrowleft; Re-check</button>
        </div>
        ${_reviewableHtml}
        ${_otherFindings.length > 0 ? `<div style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#C2C2D4;font-weight:700;margin:8px 0 4px">Other Findings</div>` : ''}
        ${_otherHtml}${_revokeHtml}
        <div style="margin-top:10px;font-size:12px;color:#C2C2D4;line-height:1.65">
          <div style="display:flex;align-items:flex-start;gap:5px;margin-bottom:3px"><span style="color:#14F195">&#x2713;</span><span><strong style="color:#E8E8F0">ZendIQ never has access to your private key or seed phrase.</strong> Only your public address is used.</span></div>
          <div>On-chain scan only &mdash; no data leaves your browser. <a href="https://revoke.cash" target="_blank" rel="noopener" style="color:#9945FF;text-decoration:none">revoke.cash</a> is a trusted third-party tool.</div>
        </div>`;
    })();

    // Recent swaps HTML container (will be populated from persistent history when available)
    const swapsHtml = `
      <div id="sr-widget-activity-list">
        ${ns.recentSwaps.length > 0
          ? ns.recentSwaps.map((h, i) => {
              if (!h || typeof h !== 'object') return '';
              const agoSecs = Math.round((Date.now() - (h.timestamp||0)) / 1000);
              const ago = agoSecs < 60 ? agoSecs+'s ago' : agoSecs < 3600 ? Math.round(agoSecs/60)+'m ago' : Math.round(agoSecs/3600)+'h ago';
              const solscanLink = h.signature
                ? `<a href="https://solscan.io/tx/${escapeHtml(h.signature)}" target="_blank" style="color:#14F195;text-decoration:none">${h.jitoTipSig ? 'Swap \u2197' : 'View on Solscan'}</a>`
                  + (h.jitoTipSig ? `\u00a0<a href="https://solscan.io/tx/${escapeHtml(h.jitoTipSig)}" target="_blank" style="color:#C2C2D4;text-decoration:none;font-size:12px">Jito tip \u2197</a>` : '')
                : '';
              // Format amounts EU-style
              const _fmtW = (val, sym) => { if (val == null || val === '') return '— ' + (sym||''); const n = parseFloat(val); if (!isFinite(n)) return String(val)+' '+(sym||''); const abs=Math.abs(n); const prec=abs>=1000?2:abs>=1?4:abs>=0.001?6:8; const [ip,dp]=n.toFixed(prec).split('.'); return ip.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(dp?','+dp:'')+' '+(sym||''); };
              const inVal  = _fmtW(h.amountIn,  h.tokenIn  || '?');
              const outVal = _fmtW(h.amountOut, h.tokenOut || '?');
              // Exchange label from swapType / routeSource
              const exchLbl = h.routeSource === 'pump.fun' ? ((h.jitoBundle || h.jitoTipLamports > 0) ? 'pump.fun + Jito Bundle' : 'pump.fun') : h.routeSource === 'raydium' ? ((h.jitoBundle || h.jitoTipLamports > 0) ? 'Raydium · AMM + Jito Bundle' : 'Raydium · AMM') : h.swapType === 'rfq' ? 'RFQ · Jupiter' : h.swapType === 'gasless' ? 'Gasless · Jupiter' : 'Jupiter · AMM';
              // Savings row
              let savRow = '';
              if (h.optimized) {
                const outDec = Number(h.outputDecimals ?? 6);
                // Tier 1 removed: comparing actualOut (on-chain) vs baselineRawOut (pre-execution
                // Jupiter snapshot) was noisy — Jupiter's price movement in the ~1-30s execution
                // window caused negative Net Benefit even when ZendIQ's route was genuinely better
                // at sign time. Quote Accuracy (row below) validates delivery fidelity instead.

                // Tier 2.5: snapshot frozen at Review & Sign → exact value the user consented to
                if (!savRow && h.snapNetUsd != null) {
                  const net = Number(h.snapNetUsd);
                  const confirmed = h.quoteAccuracy != null && Number(h.quoteAccuracy) >= 99;
                  const absStr = '$' + (Math.abs(net) < 0.01 ? Math.abs(net).toFixed(4) : Math.abs(net).toFixed(3));
                  const sign = net >= 0 ? '+' : '-';
                  const lbl = net >= 0
                    ? (confirmed ? 'Actual Gain' : 'Actual Gain (est.)')
                    : (confirmed ? 'vs. original' : 'vs. original (est.)');
                  const tip = net >= 0
                    ? (confirmed ? 'ZendIQ executed accurately \u2014 routing gain vs the original route\u2019s concurrent quote at sign time.' : 'Estimated gain vs the original route\u2019s concurrent quote at the moment you signed.')
                    : (confirmed ? 'ZendIQ executed accurately, though slightly worse than the original route\u2019s concurrent quote at sign time.' : 'ZendIQ\u2019s route returned slightly fewer tokens than the original route\u2019s concurrent quote. You proceeded anyway.');
                  const col = net >= 0 ? '#14F195' : '#FFB547';
                  const prefix = confirmed ? '' : '~ ';
                  savRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="${tip}">${lbl}</span><span style="color:${col};font-weight:700">${prefix}${sign}${absStr}</span></div>`;
                }
                // Tier 2: ZendIQ quote vs Jupiter quote (fallback for older entries without snapNetUsd)
                if (!savRow && h.baselineRawOut != null && h.rawOutAmount != null) {
                  const gdiff = (Number(h.rawOutAmount) - Number(h.baselineRawOut)) / Math.pow(10, outDec);
                  const act   = Number(h.rawOutAmount) / Math.pow(10, outDec);
                  if (Math.abs(gdiff) >= 1e-7 && Math.abs(gdiff) <= act * 0.5) {
                    const sign = gdiff >= 0 ? '~ + ' : '~ - ';
                    const _savLbl = gdiff >= 0 ? 'Actual Gain (est.)' : 'vs. original (est.)';
                    const _savTip = gdiff >= 0
                      ? 'Estimated tokens gained vs. the original route\u2019s concurrent quote for the same pair and amount.'
                      : 'ZendIQ\u2019s route returned slightly fewer tokens than the original route\u2019s concurrent quote. You proceeded anyway.';
                    savRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="${_savTip}">${_savLbl}</span><span style="color:${gdiff>=0?'#14F195':'#FFB547'};font-weight:700">${sign}${_fmtW(Math.abs(gdiff), h.tokenOut||'')}</span></div>`;
                  }
                }
              }
              // Quote accuracy
              // Optimized trades: only show confirmed on-chain value (h.quoteAccuracy, set ~3-10s
              // after confirmation). Show 'pending…' until it arrives — same behaviour as the
              // unoptimized card's On-chain vs Quote row. Do NOT fall back to priceImpactPct or
              // rawOutAmount/baseline ratio, which produce a fake ~100% immediately.
              // Unoptimized trades retain the priceImpactPct fallback (they go through a separate
              // rendering branch below and this accRow variable is overridden there anyway).
              let accRow = '';
              {
                let _qAcc = null, _qOnChain = false;
                if (h.quoteAccuracy != null && isFinite(parseFloat(h.quoteAccuracy))) {
                  _qAcc = Math.max(0, Math.min(100, parseFloat(h.quoteAccuracy))); _qOnChain = true;
                } else if (!h.optimized && h.priceImpactPct != null) {
                  const _qi = Math.abs(parseFloat(h.priceImpactPct));
                  if (isFinite(_qi)) _qAcc = Math.max(0, 100 - _qi * 100);
                }
                if (_qAcc != null) {
                  const col = _qAcc>=99?'#14F195':_qAcc>=97?'#FFB547':'#FF4D4D';
                  const lbl = _qOnChain ? 'ZendIQ Quote Accuracy ✓' : 'ZendIQ Quote Accuracy';
                  const tip = _qOnChain ? 'Actual on-chain fill accuracy — actual tokens received vs. ZendIQ\'s quoted amount, verified from the confirmed Solana transaction.' : 'Estimated from pre-execution price impact. Updates automatically a few seconds after confirmation.';
                  accRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="${tip}">${lbl}</span><span style="color:${col};font-weight:700">${_qAcc.toFixed(2)}%</span></div>`;
                } else if (h.optimized) {
                  // Show pending row — on-chain result expected within ~3-10s of confirmation
                  accRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="Waiting for on-chain confirmation to compare against ZendIQ's quoted amount. Updates automatically a few seconds after the swap confirms.">ZendIQ Quote Accuracy</span><span style="color:#C2C2D4">pending…</span></div>`;
                } else if (!h.optimized && (h.quotedOut != null || h.rawOutAmount != null)) {
                  // Unoptimized (Proceed anyway): show pending until on-chain confirms
                  accRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="Waiting for on-chain confirmation to compare against the DEX's quoted amount. Updates automatically a few seconds after the swap confirms.">ZendIQ Quote Accuracy</span><span style="color:#C2C2D4">pending…</span></div>`;
                } else if (!h.optimized && h.actualOutAmount != null) {
                  // No quoted amount available (e.g. old pump.fun entries) — show confirmed result
                  accRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="On-chain result confirmed. No pre-execution quote was available for comparison.">On-chain Confirmed</span><span style="color:#14F195;font-weight:700">\u2713</span></div>`;
                }
              }
              // Sandwich detection row — only shown when sandwichResult field has been set.
              // null = check in progress (arrives via HISTORY_UPDATE ~5–15s after confirm).
              // Omitted entirely for RFQ/gasless (no AMM mempool exposure).
              const _isRFQType = h.swapType === 'rfq' || h.swapType === 'gasless';
              let sandwichRow = '';
              if ('sandwichResult' in h && !_isRFQType) {
                const _sr = h.sandwichResult;
                if (_sr === null) {
                  sandwichRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="Scanning surrounding block transactions for sandwich attacks. Updates automatically.">Sandwich check</span><span style="color:#C2C2D4">pending…</span></div>`;
                } else if (_sr?.error) {
                  sandwichRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="Block data was unavailable \u2014 sandwich check could not complete.">Sandwich check</span><span style="color:#9B9BAD">unknown</span></div>`;
                } else if (_sr?.detected) {
                  const _hasLoss = _sr.extractedUsd != null && _sr.extractedUsd > 0.001;
                  const _extHtml = _hasLoss
                    ? `<span style="color:#FFB547;font-weight:700">\u26a0 ~$${_sr.extractedUsd.toFixed(2)} extracted</span>`
                    : `<span style="font-weight:700"><span style="color:#FFB547">\u26a0 detected</span><span style="color:#14F195"> \u00b7 $0 lost</span></span>`;
                  const _attackTip = _sr.attackerWallet
                    ? `Detected buy-before / sell-after pattern from wallet ${escapeHtml(_sr.attackerWallet)}. Estimated extraction: ${_hasLoss ? '~$' + _sr.extractedUsd.toFixed(2) : '$0 \u2014 your slippage protection absorbed the attack.'}`
                    : `Detected buy-before / sell-after pattern (multi-wallet bot). Signals: ${(_sr.signals ?? []).filter(s => s !== 'token_flow').map(s => ({'jito_bundle':'Jito bundle correlation','known_program':'known bot program'}[s] ?? s)).join(', ')}. Estimated extraction: ${_hasLoss ? '~$' + _sr.extractedUsd.toFixed(2) : '$0 \u2014 your slippage protection absorbed the attack.'}.`;
                  sandwichRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="${escapeHtml(_attackTip)}">Sandwich check</span>${_extHtml}</div>`;
                } else if (_sr && !_sr.detected) {
                  const _scanTip = _sr.scanned > 0
                    ? `Scanned ${_sr.scanned} transaction${_sr.scanned !== 1 ? 's' : ''} in the same block for buy-before / sell-after patterns. No attack detected.`
                    : 'No sandwich activity detected.';
                  // quoteAccuracy is always null on pump.fun (no pre-execution quote);
                  // use actualOutAmount as on-chain arrival indicator instead.
                  if (h.quoteAccuracy == null && h.actualOutAmount == null) {
                    sandwichRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="Waiting for on-chain confirmation before finalising sandwich check.">Sandwich check</span><span style="color:#9B9BAD">pending\u2026</span></div>`;
                  } else {
                    sandwichRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="${escapeHtml(_scanTip)}">Sandwich check</span><span style="color:#14F195;font-weight:700">Not sandwiched \u2705</span></div>`;
                  }
                }
              }
              // ── Failed trade card (tx sent but rejected on-chain) ──────────
              if (h.failed) {
                return `
                  <div id="sr-wc-${i}" style="background:rgba(255,77,77,0.04);border:1px solid rgba(255,77,77,0.25);border-radius:8px;padding:10px;margin-bottom:6px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                      <span style="font-size:13px;font-weight:700;color:#FF4D4D">\u2715 Failed on-chain</span>
                      <span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace">- ${inVal}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                      <span style="font-size:13px;color:#C2C2D4">${exchLbl}</span>
                      <span style="font-size:13px;color:#9B9BAD">No tokens received</span>
                    </div>
                    ${sandwichRow}
                    <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#9B9BAD">
                      <div style="color:#14F195;">${solscanLink}</div>
                      <div style="color:#9B9BAD;font-size:12px">${ago}</div>
                    </div>
                  </div>`;
              }
              // ── Unoptimized trade card ───────────────────────────────────
              if (!h.optimized) {
                // On-chain vs Quote row: actualOutAmount (confirmed) vs quotedOut (Jupiter's quote)
                let _execRow = '';
                if (h.actualOutAmount != null && h.quotedOut != null) {
                  const actual = parseFloat(h.actualOutAmount);
                  const quoted = parseFloat(h.quotedOut);
                  if (isFinite(actual) && isFinite(quoted) && quoted > 0) {
                    const diff = actual - quoted;
                    const sign = diff >= 0 ? '+ ' : '- ';
                    const col  = diff >= 0 ? '#14F195' : '#FFB547';
                    const sym  = h.tokenOut || '';
                    _execRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;white-space:nowrap;cursor:help" title="Actual tokens received on-chain vs the DEX's quoted amount at the time of the swap.">On-chain vs Quote ✓</span><span style="color:${col};font-weight:700;white-space:nowrap;flex-shrink:0">${sign}${_fmtW(Math.abs(diff), sym)}</span></div>`;
                  }
                } else if (h.quotedOut != null) {
                  _execRow = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#C2C2D4;cursor:help" title="Waiting for on-chain confirmation to compare against the quoted amount.">On-chain vs Quote</span><span style="color:#C2C2D4">pending…</span></div>`;
                }
                // Jupiter Quote Accuracy — override the label set above (ZendIQ never quoted this trade)
                const _jupAccRow = accRow
                  .replace('ZendIQ Quote Accuracy \u2713', exchLbl + ' Quote Accuracy \u2713')
                  .replace('ZendIQ Quote Accuracy', exchLbl + ' Quote Accuracy')
                  .replace('vs. ZendIQ\u2019s quoted amount', 'vs. the ' + exchLbl + ' quoted amount');
                return `
                  <div id="sr-wc-${i}" style="background:rgba(255,181,71,0.04);border:1px solid rgba(255,181,71,0.2);border-radius:8px;padding:10px;margin-bottom:6px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                      <span style="font-size:13px;font-weight:700;color:#FFB547">⚠ Not optimized</span>
                      <span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace">+ ${outVal}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                      <span style="font-size:13px;color:#C2C2D4">${exchLbl}</span>
                      <span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace">- ${inVal}</span>
                    </div>
                    ${_execRow}
                    ${_jupAccRow}
                    ${sandwichRow}
                    <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#9B9BAD">
                      <div style="color:#14F195;">${solscanLink}</div>
                      <div style="color:#9B9BAD;font-size:12px">${ago}</div>
                    </div>
                  </div>`;
              }
              return `
                <div id="sr-wc-${i}" style="background:#1A1A2E;border:1px solid rgba(153,69,255,0.06);border-radius:8px;padding:10px;margin-bottom:6px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <span style="font-size:13px;font-weight:700;color:#E8E8F0">Swapped <span style="font-size:9px;font-weight:700;background:linear-gradient(135deg,rgba(153,69,255,0.15),rgba(20,241,149,0.06));border:1px solid rgba(153,69,255,0.3);color:#9945FF;border-radius:10px;padding:1px 6px;vertical-align:middle">ZendIQ Optimized</span></span>
                    <span style="font-size:12px;font-weight:700;color:#14F195;font-family:'Space Mono',monospace">+ ${outVal}</span>
                  </div>
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <span style="font-size:13px;color:#C2C2D4">${exchLbl}</span>
                    <span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace">- ${inVal}</span>
                  </div>
                  ${savRow}
                  ${accRow}
                  ${sandwichRow}
                  <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#9B9BAD">
                    <div style="color:#14F195;">${solscanLink}</div>
                    <div style="color:#9B9BAD;font-size:12px">${ago}</div>
                  </div>
                </div>`;
            }).join('')
          : `<div style="font-size:12px;color:#C2C2D4;text-align:center;padding:8px 0;line-height:1.6">No activity yet.<br>Complete a swap to start monitoring.</div>`}
      </div>`;

    // Monitor content
    let riskBadgeHtml = '';
    let monitorContent = '';
    if (ns.pendingTransaction) {
      const tx = ns.pendingTransaction;
      // Always read the freshest order params — /order ticks mutate this object in-place,
      // so it reflects the latest slippage, priceImpactPct and mint info from Jupiter.
      const liveParams = window.__zendiq_last_order_params ?? tx.orderData ?? tx.orderParams ?? {};
      const risk = ns.lastRiskResult;
      // When ZendIQ's proposed route is RFQ/gasless, MEV risk is eliminated — the intercept-time
      // lastRiskResult score (which included MEV) is no longer accurate for the badge.
      // Fall back to token risk score (still valid regardless of route type), or flag RFQ-safe.
      const _orderIsRFQ   = ns.widgetLastOrder?.swapType === 'rfq' || ns.widgetLastOrder?.swapType === 'gasless';
      const _tokenScore   = ns.tokenScoreResult;
      // Composite badge: Execution ×40 + Bot Attack ×35 + Token Risk ×25
      // For RFQ/gasless routes bot score = 0 (no public mempool exposure)
      const _tsMintB      = ns.widgetCapturedTrade?.outputMint ?? ns.jupiterLiveQuote?.outputMint ?? null;
      const _tsLoadedB    = _tokenScore?.mint === _tsMintB && _tokenScore?.loaded;
      const _execScB      = risk?.score ?? 0;
      const _botScB       = _orderIsRFQ ? 0 : (risk?.mev?.riskScore ?? 0);
      const _tkScB        = _tsLoadedB ? (_tokenScore.score ?? 0) : 0;
      const _compScB      = risk ? Math.round(_execScB * 0.40 + _botScB * 0.35 + _tkScB * 0.25) : null;
      const _compLvlB     = _compScB != null
        ? (_compScB >= 75 ? 'CRITICAL' : _compScB >= 50 ? 'HIGH' : _compScB >= 25 ? 'MEDIUM' : 'LOW')
        : null;
      const _badgeLevel   = _compLvlB;
      const _badgeLabel   = _badgeLevel ? `${_badgeLevel} Risk` : null;
      const levelColor    = _badgeLevel ? ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'}[_badgeLevel] ?? '#14F195') : '#FFB547';
      // Separate MEV colour for the Bot Attack Risk card (not composite-based)
      const _mevLevelColor = risk?.mev?.riskLevel ? ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'}[risk.mev.riskLevel] ?? '#C2C2D4') : levelColor;
      const _riskTooltip = risk
        ? `Overall Risk: ${_compScB ?? risk.score}/100 \u00b7 ${_badgeLevel ?? risk.level}&#10;Execution: ${risk.score}/100 \u00b7 Bot Attack: ${_botScB}/100 \u00b7 Token Risk: ${_tsLoadedB ? _tkScB + '/100' : 'pending'}&#10;Formula: Execution \u00d7 40% + Bot Attack \u00d7 35% + Token Risk \u00d7 25%` +
          (_orderIsRFQ ? `&#10;&#10;ZendIQ&#39;s route is RFQ \u2014 no mempool exposure. Bot Attack = 0 in composite.${_tokenScore ? `&#10;Token risk included: ${_tokenScore.level} (${_tokenScore.score}/100)` : ''}` : '') +
          ((risk.factors ?? []).length ? `&#10;&#10;Top execution factors:&#10;` + (risk.factors ?? []).slice(0, 3).map(f => `\u2022 ${f.name} [${f.severity}]`).join('&#10;') : '')
        : '';
      // estimatedLossNative is null when no token price available — don't fall back to USD
      const _estLossNative = risk ? (risk.estimatedLossNative ?? null) : null;
      const _skipLossSuffix = (!_orderIsRFQ) && risk && _estLossNative != null && _estLossNative > 0 ? (() => {
        const sym = risk.inputSymbol ?? 'SOL';
        const n = _estLossNative;
        const fmtN = n < 0.0001 ? n.toFixed(6) : n < 0.01 ? n.toFixed(4) : n.toFixed(2);
        const pct = (risk.swapAmountUsd ?? risk.swapAmount ?? 0) > 0
          ? ((risk.estimatedLoss / (risk.swapAmountUsd ?? risk.swapAmount)) * 100).toFixed(2)
          : '0.00';
        return `&#10;&#10;\u26a0 You may lose ${fmtN} ${sym} (${pct}%) to bot attacks by skipping ZendIQ optimisation.`;
      })() : '';
      const _skipTooltip = `Skip ZendIQ&#39;s analysis and continue with your original jup.ag swap. Your wallet prompt will appear as normal \u2014 ZendIQ will not optimise this trade.${_skipLossSuffix}`;
      riskBadgeHtml = _badgeLabel ? `<div style="display:inline-flex;align-items:center;gap:7px;border:1px solid ${levelColor}44;background:${levelColor}11;border-radius:20px;padding:3px 10px 3px 7px;cursor:help" title="${_riskTooltip}">
        <div style="width:6px;height:6px;border-radius:50%;background:${levelColor};box-shadow:0 0 6px ${levelColor};animation:srBlink 1.2s ease-in-out infinite"></div>
        <span style="font-size:13px;font-weight:700;color:${levelColor};letter-spacing:0.5px;text-transform:uppercase">${_badgeLabel}</span>
      </div>` : '';
      monitorContent = `
        <div id="sr-monitor-scroll" style="flex:1;min-height:0;overflow-y:auto;padding:14px 16px 8px;">
          <div title="Bot Attack Risk — automated bots can front-run or sandwich your swap to steal value the moment it hits the mempool. Higher score = greater exposure.&#10;&#10;Score 0–100: LOW &lt;25 | MEDIUM 25–49 | HIGH 50–74 | CRITICAL 75+" style="background:linear-gradient(135deg,rgba(20,241,149,0.05),rgba(153,69,255,0.05));border:1px solid rgba(20,241,149,0.18);border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06);">
              <span style="color:#9945FF;font-weight:600;cursor:help" title="Bot Attack Risk — automated bots can front-run or sandwich your swap to steal value the moment it hits the mempool. Higher score = greater exposure.&#10;Industry term: MEV (Maximal Extractable Value)&#10;Score 0–100: LOW &lt;25 | MEDIUM 25–49 | HIGH 50–74 | CRITICAL 75+">Bot Attack Risk</span>
              <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${_mevLevelColor};cursor:help" title="${_riskTooltip}">${risk?.mev ? (ns.widgetMode === 'simple' ? _riskLabel(risk.mev.riskLevel) : `${risk.mev.riskLevel} · ${risk.mev.riskScore}/100`) : '—'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;">
              <span style="color:#C2C2D4">Est. Loss</span>
              ${risk ? (() => {
                const n = risk.estimatedLossNative; // null when token price unavailable
                if (n == null || n < 0.000001) {
                  return `<span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:#14F195">${n == null ? '—' : 'none'}</span>`;
                }
                const sym = risk.inputSymbol ?? 'SOL';
                const fmtN = n < 0.0001 ? n.toFixed(6) : n < 0.01 ? n.toFixed(4) : n.toFixed(2);
                const pct = (risk.swapAmountUsd ?? risk.swapAmount ?? 0) > 0 ? ((risk.estimatedLoss / (risk.swapAmountUsd ?? risk.swapAmount)) * 100).toFixed(2) : '0.00';
                const lossCol = parseFloat(pct) >= 1 ? '#FF4D4D' : '#FFB547';
                return `<span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:${lossCol}">${fmtN} ${sym} (${pct}%)</span>`;
              })() : `<span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:#C2C2D4">—</span>`}
            </div>
            ${(() => {
              const lq = ns.jupiterLiveQuote;
              // Show no-route error inline when Jupiter can't find a swap path
              if (ns.jupiterOrderError) {
                return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
                  <span style="color:#FF4D4D;font-size:12px;font-weight:600">⚠ No route: ${ns.jupiterOrderError}</span>
                </div>`;
              }
              if (!lq?.outAmount || !lq?.inAmount) return '';
              const p = lq?.inputMint ? lq : liveParams;  // prefer live quote for mint resolution
              const inDec  = p.inputMint  ? (MINT_DEC[p.inputMint]  ?? 9) : 9;
              const outDec = p.outputMint ? (MINT_DEC[p.outputMint] ?? 9) : 9;
              const inSym  = MINT_SYM[p.inputMint]  ?? '?';
              const outSym = MINT_SYM[p.outputMint] ?? '?';
              const inAmt  = Number(lq.inAmount)  / Math.pow(10, inDec);
              const outAmt = Number(lq.outAmount) / Math.pow(10, outDec);
              const rate   = inAmt > 0 ? outAmt / inAmt : null;
              if (!rate) return '';
              const rateStr = rate < 1 ? rate.toFixed(6) : rate < 100 ? rate.toFixed(4) : rate.toFixed(2);
              const stale = (Date.now() - lq.capturedAt) > 4000;
              return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
                <span style="display:flex;align-items:center;gap:4px;color:#C2C2D4">
                  <span style="width:5px;height:5px;border-radius:50%;background:${stale?'#C2C2D4':'#14F195'};display:inline-block;${stale?'':'animation:srBlink 1.2s ease-in-out infinite'}"></span>
                  Rate
                </span>
                <span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:#E8E8F0">1 ${inSym} = ${rateStr} ${outSym}</span>
              </div>`;
            })()}
          </div>

          ${(() => {
            // ── Token Risk Score card — output token on-chain + RugCheck analysis ─
            const tsMint = ns.widgetCapturedTrade?.outputMint ?? ns.jupiterLiveQuote?.outputMint ?? null;
            const tsSym  = ns.widgetCapturedTrade?.outputSymbol ?? null;
            if (!tsMint) return '';
            const ts = ns.tokenScoreResult;
            // Kick off a fresh fetch when the mint changes or result is absent
            if ((!ts || ts.mint !== tsMint) && ns._tokenScoreMint !== tsMint && ns.fetchTokenScore) {
              ns._tokenScoreMint = tsMint;
              ns.fetchTokenScore(tsMint, tsSym);
            }
            const tsLoaded = ts && ts.mint === tsMint && ts.loaded;
            const tsc      = tsLoaded
              ? ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'}[ts.level] ?? '#C2C2D4')
              : '#FFB547';
            const tsBadge  = tsLoaded ? (ns.widgetMode === 'simple' ? _riskLabel(ts.level) : `${ts.level} \u00b7 ${ts.score}/100`) : 'Scanning\u2026';
            const _tsTipFactors = tsLoaded && ts.factors?.length
              ? 'Factors:\u000a' + ts.factors.map(f =>
                  `\u2022 ${f.name} [${f.severity}]${f.detail ? ' \u2014 ' + f.detail.slice(0, 55) : ''}`
                ).join('\u000a')
              : 'Scanning for rug risk, mint authority, supply concentration and RugCheck.xyz flags\u2026';
            const tsTip = `Token Risk Score \u2014 on-chain + RugCheck.xyz analysis of the token you are buying.&#10;Score 0\u2013100: LOW <25 | MEDIUM 25\u201349 | HIGH 50\u201374 | CRITICAL 75+ (higher = more risk)&#10;&#10;${_tsTipFactors}`;
            // Card border/background reflect the score level — same visual language as Bot Attack Risk
            const _tsBg     = tsLoaded ? `background:${tsc}11;border:1px solid ${tsc}44` : 'background:rgba(255,181,71,0.05);border:1px solid rgba(255,181,71,0.25)';
            const _tsLblCol = tsLoaded ? tsc : '#FFB547';
            // Factor rows rendered directly inside the card — advanced mode only.
            // In simple mode the full factor list is still accessible via the hover tooltip.
            const _tsFactorRows = (() => {
              if (ns.widgetMode === 'simple') return '';
              if (!tsLoaded || !ts.factors?.length) {
                return '<div style="margin-top:6px;font-size:12px;color:#C2C2D4;font-style:italic;padding:2px 0">Scanning token\u2026</div>';
              }
              return '<div style="margin-top:8px">' + ts.factors.map(f => {
                const fc = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[f.severity] ?? '#C2C2D4';
                const tip = f.detail ? f.detail.replace(/"/g, '&quot;') : '';
                return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ' + fc + ';border-radius:0 5px 5px 0;margin-bottom:3px;cursor:help" title="' + tip + '">' +
                    '<span style="font-size:12px;color:#C0C0D8">' + f.name + '</span>' +
                    '<span style="font-size:9px;font-weight:700;color:' + fc + ';font-family:Space Mono,monospace;flex-shrink:0;margin-left:6px">' + f.severity + '</span>' +
                  '</div>';
              }).join('') + '</div>';
            })();
            return `<div title="${tsTip}" style="${_tsBg};border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
                <span style="color:${_tsLblCol};font-weight:600;cursor:help" title="ZendIQ checks the token you are receiving: mint authority (can devs print unlimited tokens?), freeze authority (can devs block your tokens?), top holder concentration, and RugCheck.xyz flags.">Token Risk Score</span>
                <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${tsc}">${tsBadge}</span>
              </div>
              ${_tsFactorRows}
            </div>`;
          })()}

          ${(() => {
            if (!risk) return '';
            const _erc   = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[risk.level] ?? '#C2C2D4';
            const _erbg  = `background:${_erc}11;border:1px solid ${_erc}44`;
            const _erBadge = ns.widgetMode === 'simple' ? _riskLabel(risk.level) : `${risk.level} \u00b7 ${risk.score}/100`;
            const _erTip = `Execution Risk \u2014 how risky this specific swap is to execute.&#10;Covers: slippage tolerance, price impact, route complexity, network congestion, and trade size.&#10;Score 0\u2013100: LOW <25 | MEDIUM 25\u201349 | HIGH 50\u201374 | CRITICAL 75+`;
            let _erRows = '';
            if (ns.widgetMode !== 'simple') {
              const _ef = risk.factors ?? [];
              if (!_ef.length) {
                _erRows = '<div style="margin-top:6px;font-size:12px;color:#C2C2D4;font-style:italic;padding:2px 0">Analysing\u2026</div>';
              } else {
                _erRows = '<div style="margin-top:8px">' + _ef.map(f => {
                  const fc = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[f.severity] ?? '#C2C2D4';
                  return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ' + fc + ';border-radius:0 5px 5px 0;margin-bottom:3px">' +
                    '<span style="font-size:12px;color:#C0C0D8">' + f.name + '</span>' +
                    '<span style="font-size:9px;font-weight:700;color:' + fc + ';font-family:Space Mono,monospace;flex-shrink:0;margin-left:6px">' + f.severity + '</span>' +
                  '</div>';
                }).join('') + '</div>';
              }
            }
            return `<div title="${_erTip}" style="${_erbg};border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
                <span style="color:${_erc};font-weight:600">Execution Risk</span>
                <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${_erc}">${_erBadge}</span>
              </div>
              ${_erRows}
            </div>`;
          })()}

          ${(() => {
            // ── Estimated savings preview (shown before user clicks Optimise) ─────
            // If Jupiter has no route, show that clearly instead of zeroed-out numbers
            if (ns.jupiterOrderError) {
              return `<div style="margin-bottom:10px;padding:12px 14px;background:rgba(255,77,77,0.06);border:1px solid rgba(255,77,77,0.2);border-radius:9px;text-align:center;">
                <div style="font-size:13px;font-weight:600;color:#FF4D4D;margin-bottom:4px">⚠ No swap route available</div>
                <div style="font-size:12px;color:#C2C2D4">${ns.jupiterOrderError}</div>
              </div>`;
            }
            const lq  = ns.jupiterLiveQuote;
            const tx  = ns.pendingTransaction;
            const p   = window.__zendiq_last_order_params ?? tx?.orderData ?? tx?.orderParams ?? {};
            const outDec = p.outputMint ? (MINT_DEC[p.outputMint] ?? 9) : 9;
            const outSym = MINT_SYM[p.outputMint] ?? '';
            const hasLq  = lq?.outAmount && lq?.inAmount && (Date.now() - lq.capturedAt) < 15_000;
            const pi     = hasLq ? parseFloat(lq.priceImpactPct ?? 0) * 100 : 0; // convert fraction → %
            const outAmt = hasLq ? (Number(lq.outAmount) / Math.pow(10, outDec)) : 0;
            // Impact cost and routing savings in output tokens (from Jupiter price impact)
            const impactCostTokens = outAmt * (pi / 100);
            const estSavingsTokens = impactCostTokens * 0.35;
            const impactColor = pi >= 2 ? '#FF4D4D' : pi >= 0.5 ? '#FFB547' : '#14F195';
            // USD value: prefer risk.swapAmountUsd (computed by page-risk).
            // Fall back to lq.inUsdValue from the Jupiter live tick — available immediately
            // on first render before the async _rescoreFromParams has completed.
            // This prevents "none on this trade" flashing while risk is still computing.
            const STABLES_USD = {'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':true,'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':true};
            const tradeUsd = risk?.swapAmountUsd
              ?? (hasLq && lq.inUsdValue  != null && Number(lq.inUsdValue)  > 0 ? Number(lq.inUsdValue)  : null)
              ?? (hasLq && lq.outUsdValue != null && Number(lq.outUsdValue) > 0 ? Number(lq.outUsdValue) : null)
              ?? (hasLq && STABLES_USD[p.inputMint] ? Number(lq.inAmount) / 1e6 : null);
            // Prefer actual ZendIQ-quote vs Jupiter-baseline comparison (available when autoProtect
            // has already fetched, or after user clicked Review Optimisation).
            // Fallback to the price-impact formula estimate when quote hasn't been fetched yet.
            let routingSavingsUsd = null;
            let _realGross = null; // set when we have a real quote comparison (can be negative)
            {
              const _zdqOrder = ns.widgetLastOrder;
              const _pd   = ns.widgetLastPriceData ?? {};
              const _sol  = _pd.solPriceUsd != null ? Number(_pd.solPriceUsd) : null;
              const _SOL  = 'So11111111111111111111111111111111111111112';
              const _outIsSol = p.outputMint === _SOL;
              const _inAmt = hasLq ? Number(lq.inAmount) : 0;
              // Same opr fallback chain as the Review & Sign panel
              const _opr = _pd.outputPriceUsd != null ? Number(_pd.outputPriceUsd)
                : (_outIsSol && _sol ? _sol
                : (_pd.inputPriceUsd != null && _inAmt > 0 && outAmt > 0 ? _pd.inputPriceUsd * _inAmt / outAmt : null));
              if (_zdqOrder?.outAmount != null && ns.widgetBaselineRawOut != null && _opr != null) {
                const _zdq  = Number(_zdqOrder.outAmount);
                const _base = Number(ns.widgetBaselineRawOut);
                if (isFinite(_zdq) && isFinite(_base) && _base > 0 && _zdq > 0) {
                  const _gross = (_zdq - _base) / Math.pow(10, outDec);
                  // stale-baseline sanity guard: diff must be < 50% of actual
                  if (Math.abs(_gross) <= (_zdq / Math.pow(10, outDec)) * 0.5) {
                    _realGross = _gross;
                    routingSavingsUsd = _gross * _opr;
                  }
                }
              }
              if (routingSavingsUsd == null) {
                routingSavingsUsd = tradeUsd != null ? tradeUsd * (pi / 100) * 0.35 : null;
              }
            }
            // MEV shield — active when calcDynamicFees would add a Jito tip
            const rScore = risk?.score ?? 0;
            // Consistent SOL price: live price → risk.solPrice → $80 floor
            const _solPreview = ns.widgetLastPriceData?.solPriceUsd ?? risk?.solPrice ?? 80;
            const { jitoTipLamports: _previewJito, priorityFeeLamports: _previewPri } = ns.calcDynamicFees({
              riskScore: rScore,
              mevScore:  risk?.mev?.riskScore ?? 0,
              priceImpactPct: p?.priceImpactPct ?? null,
              tradeUsd,
              jitoMode:     ns.jitoMode ?? 'auto',
              solPriceUsd:  _solPreview,
            });
            const mevActive = !!_previewJito;
            // Total cost preview — deduct BOTH priority fee and Jito tip (same as Review & Sign panel)
            const mevScore = risk?.mev?.riskScore ?? 0;
            const jitoTipUsdPreview     = _previewJito > 0 ? (_previewJito / 1e9) * _solPreview : 0;
            const priorityFeeUsdPreview  = _previewPri   > 0 ? (_previewPri   / 1e9) * _solPreview : 0;
            const totalFeePreviewUsd     = jitoTipUsdPreview + priorityFeeUsdPreview;
            let mevProtectionUsd = null;
            // Only show MEV protection value at MEDIUM+ risk (score >= 20).
            // Use the same estimatedLossPercentage lookup table as calculateMEVRisk
            // (score 20–39 → 0.3%, 40–59 → 0.6%, etc.) so the number is consistent with
            // the Bot Attack Risk row. The old linear formula (mevScore/100 × 0.04) gave
            // 0.96% at score 24 vs the correct 0.3% — a 3× inflation.
            const mevLossPct = risk?.mev?.estimatedLossPercentage != null
              ? risk.mev.estimatedLossPercentage / 100   // e.g. 0.003 at score 24
              : (mevScore >= 20 ? 0.003 : 0);            // fallback when mev not yet computed
            if (mevActive && tradeUsd != null && mevScore >= 20) {
              const mevExpectedLoss = tradeUsd * mevLossPct;  // e.g. $21.48 × 0.003 = $0.064
              const mevProtected    = mevExpectedLoss * 0.70;  // Jito achieves ~70% reduction
              mevProtectionUsd = Math.max(0, mevProtected);
            }
            // hasRealQuote: true once ZendIQ has fetched its own order.
            // Don't require widgetBaselineRawOut — if baseline is null the Review & Sign panel
            // also falls back to the price-impact formula, keeping both panels consistent.
            const hasRealQuote = ns.widgetLastOrder?.outAmount != null;
            // RFQ/gasless routes are direct fills — no Jito tip is added and no MEV applies
            const _quoteIsRFQ = ns.widgetLastOrder?.swapType === 'rfq' || ns.widgetLastOrder?.swapType === 'gasless';
            // State flags for savings card rendering
            // _fetchPending: swap intercepted but ZendIQ hasn't fetched its order yet
            const _fetchPending = !hasRealQuote && ns.widgetCapturedTrade != null;
            // _routeWorse: real quote comparison shows ZendIQ yields fewer tokens than the baseline fill
            const _routeWorse   = hasRealQuote && _realGross != null && _realGross < 0;
            const _baselineRouteLabel = lq?.swapType === 'rfq' ? 'RFQ fill' : lq?.swapType === 'gasless' ? 'Gasless fill' : 'Jupiter';
            // Post-fetch only: routing net benefit (no pre-quote MEV estimate added to headline)
            const _rSav    = hasRealQuote ? (routingSavingsUsd ?? 0) : 0;
            const _netSav  = _rSav - totalFeePreviewUsd;
            const savingsUsd = (hasRealQuote && _netSav > 0.00005) ? _netSav : null;

            const fmtTok = (n, sym) => {
              const f = n < 0.000001 ? n.toExponential(2) : n.toFixed(4);
              return f + (sym ? ' ' + sym : '');
            };

            // ── Early-return: fetch still in progress ──────────────────────────
            if (_fetchPending) {
              const _fetchCard = `
              <div style="margin-bottom:10px;padding:12px 14px;background:rgba(153,69,255,0.05);border:1px solid rgba(153,69,255,0.18);border-radius:9px;text-align:center;">
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.7px;color:#C2C2D4;margin-bottom:7px">ZendIQ Analysis</div>
                <div style="font-size:13px;font-weight:600;color:#9945FF;line-height:1.3">⏳ Checking routes…</div>
                <div style="font-size:12px;color:#C2C2D4;margin-top:5px">Comparing ZendIQ routing vs current route</div>
              </div>`;
              return ns.widgetMode !== 'simple'
                ? _fetchCard + `<div style="margin-top:10px;display:flex;flex-direction:column;gap:5px;text-align:left;font-size:13px;padding:0 2px"></div>`
                : _fetchCard;
            }

            // ── Early-return: ZendIQ's route is token-worse ────────────────────
            if (_routeWorse) {
              return `
              <div style="margin-bottom:10px;padding:12px 14px;background:rgba(255,181,71,0.05);border:1px solid rgba(255,181,71,0.25);border-radius:9px;text-align:center;">
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.7px;color:#C2C2D4;margin-bottom:7px">ZendIQ Analysis</div>
                <div style="font-size:13px;font-weight:600;color:#FFB547;line-height:1.3">${_baselineRouteLabel} is better here</div>
                <div style="font-size:12px;color:#C2C2D4;margin-top:5px">ZendIQ will proceed with the original route — you receive more tokens</div>
              </div>`;
            }

            // ── "None" fallback message (post-quote, no savings) ───────────────
            const _noneHtml = `<div style="font-family:'Space Mono',monospace;font-size:13px;font-weight:600;color:#C2C2D4;line-height:1">≈ none on this trade</div>`;

            if (ns.widgetMode !== 'simple') {
              // ── Advanced: big USD savings number + breakdown ───────────────────
              const hasSavingsUsd = savingsUsd != null && savingsUsd > 0.0001;
              const hasSavingsTok = estSavingsTokens > 0.000001;
              const bigNumber = hasSavingsUsd
                ? `<div style="font-family:'Space Mono',monospace;font-size:26px;font-weight:700;color:#14F195;letter-spacing:-0.5px;line-height:1">$${savingsUsd < 0.01 ? savingsUsd.toFixed(4) : savingsUsd.toFixed(2)}</div>`
                : hasSavingsTok
                  ? `<div style="font-family:'Space Mono',monospace;font-size:20px;font-weight:700;color:#14F195;line-height:1">+${fmtTok(estSavingsTokens, outSym || '?')}</div>`
                  : _noneHtml;
              return `
              <div style="margin-bottom:10px;padding:12px 14px;background:rgba(20,241,149,0.05);border:1px solid rgba(20,241,149,0.18);border-radius:9px;text-align:center;">
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.7px;color:#C2C2D4;margin-bottom:7px">Est. savings with ZendIQ</div>
                ${bigNumber}
                <div style="font-size:12px;color:#C2C2D4;margin-top:5px">${'via ZendIQ routing (est.)' + (_quoteIsRFQ ? ' · <span style=\'color:#14F195\'>RFQ direct fill</span>' : (mevActive ? ' · <span style=\'color:#9945FF\'>Jito active</span>' : ''))}</div>
                <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px;text-align:left;font-size:13px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#C2C2D4">Routing impact</span>
                    <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${pi >= 0.5 ? impactColor : '#C2C2D4'}">
                      ${impactCostTokens > 0.000001 ? '−' + fmtTok(impactCostTokens, outSym || '?') + ' (' + pi.toFixed(2) + '%)' : (hasLq ? '≈ none' : '—')}
                    </span>
                  </div>
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#C2C2D4">Routing savings</span>
                    <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#14F195">
                      ${estSavingsTokens > 0.000001 ? '+' + fmtTok(estSavingsTokens, outSym || '?') + ' (est.)' : (hasLq ? '≈ none' : '—')}
                    </span>
                  </div>
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#C2C2D4" title="Jito tip reduces MEV front-running exposure by ~70%. Statistical expected value — will vary per trade.">Bot protection</span>
                    <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${_quoteIsRFQ ? '#C2C2D4' : (mevActive ? '#9945FF' : '#C2C2D4')}">
                      ${_quoteIsRFQ
                        ? `N/A <span style="font-size:9px;opacity:0.7">RFQ direct fill</span>`
                        : (mevActive ? `Active <span style="font-size:9px;opacity:0.7">Jito</span>` : `Priority fee only`)
                      }
                    </span>
                  </div>
                </div>
              </div>`;
            } else {
              // ── Simple: one big USD (or token) savings number ──────────────────
              const hasSavingsUsd = savingsUsd != null && savingsUsd > 0.0001;
              const hasSavingsTok = estSavingsTokens > 0.000001;
              const bigNumber = hasSavingsUsd
                ? `<div style="font-family:'Space Mono',monospace;font-size:26px;font-weight:700;color:#14F195;letter-spacing:-0.5px;line-height:1">$${savingsUsd < 0.01 ? savingsUsd.toFixed(4) : savingsUsd.toFixed(2)}</div>`
                : hasSavingsTok
                  ? `<div style="font-family:'Space Mono',monospace;font-size:20px;font-weight:700;color:#14F195;line-height:1">+${fmtTok(estSavingsTokens, outSym || '?')}</div>`
                  : _noneHtml;
              return `
              <div style="margin-bottom:10px;padding:12px 14px;background:rgba(20,241,149,0.05);border:1px solid rgba(20,241,149,0.18);border-radius:9px;text-align:center;">
                <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.7px;color:#C2C2D4;margin-bottom:7px">Est. savings with ZendIQ</div>
                ${bigNumber}
                <div style="font-size:12px;color:#C2C2D4;margin-top:5px">${'via ZendIQ routing (est.)' + (_quoteIsRFQ ? ' · <span style=\'color:#14F195\'>RFQ direct fill</span>' : (mevActive ? ' · <span style=\'color:#9945FF\'>Jito active</span>' : ''))}</div>
              </div>`;
            }
          })()}

        </div>
        <div style="flex-shrink:0;padding:8px 16px 14px;background:#12121E;border-top:1px solid rgba(153,69,255,0.12);">
          <div style="margin-bottom:8px">
            <button id="sr-btn-optimise" title="ZendIQ re-routes your swap through optimal liquidity paths to reduce bot attack exposure and get you a better rate. You'll still approve in your wallet — nothing executes without your signature." style="width:100%;padding:11px;border:none;border-radius:8px;background:linear-gradient(135deg,#14F195,#0cc97a);color:#061a10;font-size:13px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;box-shadow:0 3px 12px rgba(20,241,149,0.3)">✦ Review Optimisation</button>
          </div>
          <div style="display:flex;gap:8px">
            <button id="sr-btn-skip" title="${_skipTooltip}" style="flex:1;padding:10px;border:1px solid rgba(153,69,255,0.2);border-radius:8px;background:rgba(255,255,255,0.04);color:#C2C2D4;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">Proceed anyway</button>
            <button id="sr-btn-cancel" title="Cancel this swap entirely. Nothing will be sent to your wallet. You can adjust the trade on jup.ag and try again." style="flex:1;padding:10px;background:none;border:1px solid rgba(255,77,77,0.2);color:#FF4D4D;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">✕ Cancel</button>
          </div>
          <div style="text-align:center;font-size:9px;color:#4A4A6A;margin-top:8px;line-height:1.4">Not financial advice &middot; use at own risk &middot; profit is NOT guaranteed</div>
        </div>`;
    } else {
      // ── Site adapter monitor (jup.ag, pump.fun, Raydium, etc.) or generic fallback ──
      const _adapterMon = ns.activeSiteAdapter?.()?.renderMonitor?.();
      if (_adapterMon != null) {
        monitorContent = _adapterMon;
      } else {
        const _tsIdle = ns.tokenScoreResult?.loaded && ns.tokenScoreResult?.mint === ns.lastOutputMint
          ? ns.tokenScoreResult : null;
        // Only show token-scan text on Jupiter where live ticks set lastOutputMint
        // during active trading. On pump.fun/raydium the adapter's own renderMonitor
        // handles the active-swap state; the generic fallback here is idle-only.
        const _hasAdapterMon = !!ns.activeSiteAdapter?.()?.renderMonitor;
        const _outM   = _hasAdapterMon ? null : ns.lastOutputMint;
        const _tsIdleHtml = _tsIdle && !_hasAdapterMon
          ? _buildTokenRiskCard(_tsIdle, ns.widgetMode === 'simple')
          : (_outM ? `<div style="font-size:12px;color:#9B9BAD;text-align:center;padding:4px 0">Scanning token risk&hellip;</div>` : '');
        const _isPump = window.location.hostname.includes('pump.fun');
        const _isRdm  = window.location.hostname.includes('raydium');
        const _idleHint = _isPump ? 'Start a swap on pump.fun to see risk analysis here.'
          : _isRdm ? 'Swap on <a href="https://raydium.io" style="color:#9945FF;text-decoration:none">raydium.io</a> to see risk analysis here.'
          : 'Swap on <a href="https://jup.ag" style="color:#9945FF;text-decoration:none">jup.ag</a> to see risk analysis here.';
        monitorContent = `
          <div style="padding:14px 16px;">
            <div style="font-size:12px;color:#C2C2D4;text-align:center;padding:12px 0;line-height:1.6">
              Monitoring active.<br>${_idleHint}
            </div>
            ${_tsIdleHtml}
          </div>`;
      }
    }

    // Widget flow content (optimise flow inside Monitor or Swap tab)
    // NOTE: done/error are checked FIRST, outside the capturedTrade guard,
    // because widgetCapturedTrade is cleared before renderWidgetPanel() is called.
    let widgetFlowContent = '';
    if (ns.widgetSwapStatus === 'done') {
      const _sig  = ns.widgetLastTxSig;
      const _pair = ns.widgetLastTxPair || {};
      const _shortSig = _sig ? (_sig.slice(0, 8) + '\u2026' + _sig.slice(-4)) : null;
      const _solUrl   = _sig ? ('https://solscan.io/tx/' + _sig) : null;
      const _amtRow   = (_pair.inSym && _pair.outSym)
        ? `<div style="font-size:13px;color:#C2C2D4;margin:4px 0 0">${_pair.inAmt != null ? Number(_pair.inAmt).toFixed(4) : '?'} ${_pair.inSym} \u2192 ${_pair.outAmt != null ? Number(_pair.outAmt).toFixed(4) : '?'} ${_pair.outSym}</div>`
        : '';
      const _sigLink  = _solUrl
        ? `<a href="${_solUrl}" target="_blank" rel="noopener" style="display:block;margin:8px 0 14px;font-size:12px;color:#9945FF;text-decoration:none;font-family:monospace" title="View on Solscan">${_shortSig} \u2197</a>`
        : '<div style="margin-bottom:14px"></div>';
      widgetFlowContent = `
          <div style="padding:14px 16px;text-align:center">
            <div style="font-size:13px;font-weight:700;color:#14F195;margin-bottom:2px">Swap Successful</div>
            ${_amtRow}
            ${_sigLink}
            <button id="sr-btn-widget-new" style="width:100%;padding:10px;border:1px solid rgba(20,241,149,0.3);border-radius:8px;background:rgba(20,241,149,0.08);color:#14F195;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">+ New Swap</button>
          </div>`;
    } else if (ns.widgetSwapStatus === 'done-original') {
      // Jupiter's original swap confirmed on-chain — mirror the ZendIQ 'done' card
      const _sigO  = ns.widgetOriginalTxSig;
      const _oiD   = ns.widgetOriginalSigningInfo ?? {};
      const _dInSym  = _oiD.inputSymbol  ?? MINT_SYM[_oiD.inputMint]  ?? '?';
      const _dOutSym = _oiD.outputSymbol !== '?'
        ? _oiD.outputSymbol
        : (ns.tokenScoreCache?.get(_oiD.outputMint)?.result?.symbol ?? MINT_SYM[_oiD.outputMint] ?? '?');
      const _dInDec  = _oiD.inputDecimals  ?? (_oiD.inputMint  ? (MINT_DEC[_oiD.inputMint]  ?? 9) : 9);
      const _dOutDec = _oiD.outputDecimals ?? (_oiD.outputMint ? (MINT_DEC[_oiD.outputMint] ?? 9) : 9);
      const _dInAmt  = _oiD.inAmt ?? (_oiD.inAmountRaw != null ? Number(_oiD.inAmountRaw) / Math.pow(10, _dInDec) : null);
      const _dlqSame = ns.jupiterLiveQuote && ns.jupiterLiveQuote.outputMint === _oiD.outputMint;
      const _dOutAmt = (_dlqSame && ns.jupiterLiveQuote.outAmount != null)
        ? Number(ns.jupiterLiveQuote.outAmount) / Math.pow(10, _dOutDec) : null;
      const _dShortSig = _sigO ? (_sigO.slice(0, 8) + '\u2026' + _sigO.slice(-4)) : null;
      const _dSolUrl   = _sigO ? ('https://solscan.io/tx/' + escapeHtml(_sigO)) : null;
      const _dAdapterName = ns.activeSiteAdapter?.()?.name;
      const _dRouteLabel = _dAdapterName === 'raydium' ? "Via Raydium\u2019s route"
        : _dAdapterName === 'pump' ? "Via pump.fun\u2019s route"
        : "Via Jupiter\u2019s route";
      const _dAmtRow   = (_dInSym && _dOutSym && _dInAmt != null)
        ? `<div style="font-size:13px;color:#C2C2D4;margin:4px 0 0">${Number(_dInAmt).toFixed(4)} ${_dInSym} \u2192 ${_dOutAmt != null ? Number(_dOutAmt).toFixed(4) : '?'} ${_dOutSym}</div>`
        : '';
      const _dSigLink  = _dSolUrl
        ? `<a href="${_dSolUrl}" target="_blank" rel="noopener" style="display:block;margin:8px 0 14px;font-size:12px;color:#9945FF;text-decoration:none;font-family:monospace" title="View on Solscan">${_dShortSig} \u2197</a>`
        : '<div style="margin-bottom:14px"></div>';
      widgetFlowContent = `
          <div style="padding:14px 16px;text-align:center">
            <div style="font-size:13px;font-weight:700;color:#14F195;margin-bottom:2px">Swap Successful</div>
            <div style="font-size:12px;color:#FFB547;margin-bottom:2px">${_dRouteLabel}</div>
            ${_dAmtRow}
            ${_dSigLink}
            <button id="sr-btn-widget-new" style="width:100%;padding:10px;border:1px solid rgba(20,241,149,0.3);border-radius:8px;background:rgba(20,241,149,0.08);color:#14F195;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">+ New Swap</button>
          </div>`;
    } else if (ns.widgetSwapStatus === 'error') {
      widgetFlowContent = `
          <div style="padding:14px 16px;">
            <div style="background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.25);border-radius:8px;padding:10px;margin-bottom:10px;">
              <div style="font-size:13px;font-weight:700;color:#FF4D4D;margin-bottom:4px">Error</div>
              <div style="font-size:13px;color:#E8E8F0">${ns.widgetSwapError}</div>
            </div>
            <div style="display:flex;gap:8px">
              <button id="sr-btn-widget-retry" style="flex:1;padding:10px;border:1px solid rgba(153,69,255,0.3);border-radius:8px;background:rgba(153,69,255,0.08);color:#9945FF;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">\u21ba Retry</button>
              <button id="sr-btn-widget-error-cancel" style="flex:1;padding:10px;background:none;border:1px solid rgba(255,77,77,0.2);color:#FF4D4D;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">\u2715 Cancel</button>
            </div>
          </div>`;
    } else if (ns.widgetSwapStatus === 'signing-original') {
      // User confirmed an unoptimised Jupiter swap — show what they are about to sign.
      // Safety timeout: auto-clear after 15s in case the wallet or /execute path
      // doesn't fire the normal clear (e.g. signAndSendTransaction with slow landing).
      if (!ns._signingOriginalTimeout) {
        ns._signingOriginalTimeout = setTimeout(() => {
          ns._signingOriginalTimeout = null;
          if (ns.widgetSwapStatus === 'signing-original') {
            ns.widgetSwapStatus = '';
            ns.widgetOriginalSigningInfo = null;
            ns.widgetCapturedTrade = null;
            ns.widgetLastOrder = null;
            try { ns.renderWidgetPanel?.(); } catch (_) {}
          }
        }, 15000);
      }
      const _oi   = ns.widgetOriginalSigningInfo ?? {};
      const _olq  = ns.jupiterLiveQuote;
      const _oInSym  = _oi.inputSymbol  ?? MINT_SYM[_oi.inputMint]  ?? '?';
      const _oOutSym = _oi.outputSymbol !== '?'
        ? _oi.outputSymbol
        : (ns.tokenScoreCache?.get(_oi.outputMint)?.result?.symbol ?? MINT_SYM[_oi.outputMint] ?? '?');
      const _oInDec  = _oi.inputDecimals  ?? (_oi.inputMint  ? (MINT_DEC[_oi.inputMint]  ?? 9) : 9);
      const _oOutDec = _oi.outputDecimals ?? (_oi.outputMint ? (MINT_DEC[_oi.outputMint] ?? 9) : 9);
      const _oInAmt  = _oi.inAmt ?? (_oi.inAmountRaw != null ? Number(_oi.inAmountRaw) / Math.pow(10, _oInDec) : null);
      const _olqSame = _olq && _olq.outputMint === _oi.outputMint;
      const _oOutAmt = (_olqSame && _olq.outAmount != null)
        ? Number(_olq.outAmount) / Math.pow(10, _oOutDec) : null;
      const _oRScore = _oi.riskScore;
      const _oRLevel = _oi.riskLevel
        ?? (_oRScore != null ? (_oRScore >= 70 ? 'CRITICAL' : _oRScore >= 40 ? 'HIGH' : _oRScore >= 20 ? 'MEDIUM' : 'LOW') : null);
      const _oRlc    = { CRITICAL: '#FF4D4D', HIGH: '#FFB547', MEDIUM: '#9945FF', LOW: '#14F195' }[_oRLevel] ?? '#C2C2D4';
      const _fmt4o   = v => v != null ? Number(v).toFixed(4) : '?';
      const _oAdapterN = ns.activeSiteAdapter?.()?.name;
      const _oSrcName = _oAdapterN === 'raydium' ? "Raydium\u2019s" : _oAdapterN === 'pump' ? "pump.fun\u2019s" : "Jupiter\u2019s";
      widgetFlowContent = `
          <div style="padding:14px 16px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-size:12px;font-weight:700;color:#FFB547">${_oi._sending ? '\u23f3 Sending\u2026' : '\u23f0 Approve in wallet\u2026'}</span>
              <span style="font-size:12px;color:#FFB547;font-weight:600">&#9888; Not optimized</span>
            </div>
            <div style="background:rgba(255,181,71,0.04);border:1px solid rgba(255,181,71,0.18);border-radius:8px;padding:9px 11px;margin-bottom:8px">
              <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.6px;color:#FFB547;font-weight:700;margin-bottom:7px">${_oSrcName} original swap \u2014 no ZendIQ routing</div>
              ${_oInAmt != null ? `<div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:13px;color:#C2C2D4">Selling</span>
                <span style="font-size:13px;color:#E8E8F0;font-weight:600">${_fmt4o(_oInAmt)} ${_oInSym}</span>
              </div>` : `<div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:13px;color:#C2C2D4">Pair</span>
                <span style="font-size:13px;color:#E8E8F0;font-weight:600">${_oInSym} \u2192 ${_oOutSym}</span>
              </div>`}
              ${_oOutAmt != null ? `<div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:13px;color:#C2C2D4">Buying (est.)</span>
                <span style="font-size:13px;color:#E8E8F0;font-weight:600">${_fmt4o(_oOutAmt)} ${_oOutSym}</span>
              </div>` : _oInAmt != null ? `<div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:13px;color:#C2C2D4">Receiving</span>
                <span style="font-size:13px;color:#C2C2D4">${_oOutSym} \u2014 updated in Activity</span>
              </div>` : ''}
              ${_oRScore != null ? `<div style="display:flex;justify-content:space-between;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
                <span style="font-size:13px;color:#C2C2D4">Risk Score</span>
                <span style="font-size:13px;font-weight:700;color:${_oRlc}">${_oRScore}/100 ${_oRLevel ?? ''}</span>
              </div>` : ''}
            </div>
            <div style="font-size:13px;color:#C2C2D4;text-align:center">${_oi._sending ? 'Broadcasting to Solana\u2026' : (_oi.reason === 'no_net_benefit' ? `ZendIQ found no net benefit \u2014 ${_oSrcName} route is as good or better` : `Check your wallet \u2014 this is ${_oSrcName} original route`)}</div>
          </div>`;
    } else if (ns._adapterBusyStates?.().includes(ns.widgetSwapStatus)) {
      // ── Site adapter flow states (pump-slippage-review, pump-signing, pump-done, etc.) ──
      widgetFlowContent = ns.activeSiteAdapter?.()?.renderFlow?.() ?? '';
    } else if (ns.widgetSwapStatus === 'fetching' && !ns.widgetCapturedTrade && ns.pendingTransaction) {
      // Auto-Profit early-fetch phase: widgetCapturedTrade not yet built by fetchWidgetQuote.
      // Show a minimal loading card so the full Monitor (Bot Attack Risk, Token Score, savings)
      // never flashes before the real Review & Sign panel appears.
      const _lq = ns.jupiterLiveQuote;
      const _pt = ns.pendingTransaction;
      const _lqParams = window.__zendiq_last_order_params ?? _pt?.orderData ?? _pt?.orderParams ?? {};
      const _inSym  = MINT_SYM[_lqParams.inputMint]  ?? MINT_SYM[_lq?.inputMint]  ?? '?';
      const _outSym = MINT_SYM[_lqParams.outputMint] ?? MINT_SYM[_lq?.outputMint] ?? '?';
      widgetFlowContent = `
        <div style="padding:24px 16px;text-align:center">
          <div style="font-size:12px;font-weight:600;color:#9945FF;margin-bottom:8px">⏳ Analysing swap…</div>
          <div style="font-size:13px;color:#C2C2D4">${_inSym} → ${_outSym}</div>
          <div style="font-size:12px;color:#4A4A6A;margin-top:4px">Checking routes &amp; bot risk</div>
          <button id="sr-btn-widget-fetch-cancel" style="margin-top:14px;padding:8px 20px;background:none;border:1px solid rgba(255,77,77,0.25);color:#FF4D4D;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">✕ Cancel</button>
        </div>`;
    } else if (ns.widgetCapturedTrade) {
      const ct = ns.widgetCapturedTrade;
      if (ns.widgetSwapStatus === 'fetching') {
        // Show Jupiter's live-cached quote during fetch so the panel isn't blank
        const lq = ns.jupiterLiveQuote;
        const samePair = lq && lq.inputMint === ct.inputMint && lq.outputMint === ct.outputMint;
        const lqPreview = samePair && (Date.now() - lq.capturedAt) < 10_000
          ? `<div style="font-size:12px;color:#C2C2D4;margin-top:6px">Jup latest: ${(parseInt(lq.outAmount) / Math.pow(10, ct.outputDecimals ?? MINT_DEC[ct.outputMint] ?? 9)).toFixed(4)} ${ct.outputSymbol} · ${((lq.priceImpactPct ?? 0) * 100).toFixed(3)}% impact</div>`
          : '';
        widgetFlowContent = `
          <div style="padding:14px 16px;text-align:center">
            <div style="font-size:12px;font-weight:600;color:#9945FF;margin-bottom:8px">⏳ Checking protection options…</div>
            <div style="font-size:13px;color:#C2C2D4">${ct.inputSymbol} → ${ct.outputSymbol}</div>
            <div style="font-size:12px;color:#C2C2D4;margin-top:4px">${ct.amountUI != null ? ct.amountUI.toFixed(4) : '?'} ${ct.inputSymbol}</div>
            ${lqPreview}
            <button id="sr-btn-widget-fetch-cancel" style="margin-top:12px;padding:8px 20px;background:none;border:1px solid rgba(255,77,77,0.25);color:#FF4D4D;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">✕ Cancel</button>
          </div>`;
      } else if (ns.widgetSwapStatus === 'skipped') {
        widgetFlowContent = `
          <div style="padding:14px 16px;text-align:center">
            <div style="font-size:12px;font-weight:600;color:#C2C2D4;margin-bottom:8px">✓ No better rate found</div>
            <div style="font-size:13px;color:#C2C2D4">Using Jupiter’s quote — no action needed</div>
          </div>`;
      } else if (ns.widgetSwapStatus === 'signing') {
        // Show compact trade summary so user can verify what they're approving.
        // widgetLastOrder and widgetCapturedTrade are both still set at this point.
        const _sOrder = ns.widgetLastOrder;
        const _sDec   = ct.outputDecimals ?? MINT_DEC[ct.outputMint] ?? 9;
        const _sIDec  = ct.inputDecimals  ?? MINT_DEC[ct.inputMint]  ?? 9;
        const _sIn    = ct.amountUI ?? ((ct.amountRaw ?? 0) / Math.pow(10, _sIDec));
        const _sOut   = _sOrder?.outAmount != null ? parseInt(_sOrder.outAmount) / Math.pow(10, _sDec) : null;
        const _fmt4s  = v => v != null ? Number(v).toFixed(4) : '?';
        const _sNet   = ns.widgetSnapNetUsd;
        const _sSav   = ns.widgetSnapSavingsUsd;
        const _sNetColor = _sNet == null ? '#C2C2D4' : _sNet >= 0 ? '#14F195' : '#FFB547';
        const _sNetStr = _sNet != null
          ? (_sNet >= 0 ? '~ +' : '~ \u2212') + '$' + Math.abs(_sNet).toFixed(3)
          : _sSav != null
            ? (_sSav >= 0 ? '~ +' : '~ \u2212') + '$' + Math.abs(_sSav).toFixed(3)
            : '\u2014';
        const _sRoute = _sOrder ? (
          _sOrder._source === 'raydium' ? `Raydium \u00b7 ${_sOrder._rdmPoolType === 'CLMM' ? 'CLMM' : 'AMM'}${(ns.widgetLastOrderFees?.jitoTipLamports ?? 0) >= 1000 ? ' + Jito Bundle' : ''}`
          : _sOrder.swapType === 'rfq'     ? 'Direct Fill \u00b7 RFQ'
          : _sOrder.swapType === 'gasless' ? 'Gasless \u00b7 Market Maker'
          : ((_sOrder.routePlan?.map(r => r.swapInfo?.label).filter(Boolean).join(' \u2192 ')) || 'Jupiter Ultra')
        ) : null;
        widgetFlowContent = `
          <div style="padding:14px 16px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span style="font-size:12px;font-weight:700;color:#FFB547">&#9203; Approve in wallet\u2026</span>
              <span style="font-size:12px;color:#14F195;font-weight:600">&#10022; ZendIQ optimized</span>
            </div>
            <div style="background:rgba(20,241,149,0.04);border:1px solid rgba(20,241,149,0.14);border-radius:8px;padding:9px 11px;margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;margin-bottom:5px">
                <span style="font-size:13px;color:#C2C2D4">Selling</span>
                <span style="font-size:13px;color:#E8E8F0;font-weight:600">${_fmt4s(_sIn)} ${ct.inputSymbol}</span>
              </div>
              <div style="display:flex;justify-content:space-between;margin-bottom:5px">
                <span style="font-size:13px;color:#C2C2D4">Buying</span>
                <span style="font-size:13px;color:#14F195;font-weight:700">${_sOut != null ? _fmt4s(_sOut) : '...'} ${ct.outputSymbol}</span>
              </div>
              ${_sRoute ? `<div style="display:flex;justify-content:space-between;margin-bottom:5px">
                <span style="font-size:13px;color:#C2C2D4">Route</span>
                <span style="font-size:12px;color:#9945FF;font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:140px;white-space:nowrap">${_sRoute}</span>
              </div>` : ''}
              <div style="display:flex;justify-content:space-between;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
                <span style="font-size:13px;color:#C2C2D4">Est. Net Benefit</span>
                <span style="font-size:13px;font-weight:700;color:${_sNetColor}">${_sNetStr}</span>
              </div>
            </div>
            <div style="font-size:13px;color:#C2C2D4;text-align:center">Check your wallet \u2014 tap Approve to confirm</div>
            ${_sOrder?._source === 'raydium' ? `<div style="font-size:12px;color:#C2C2D4;text-align:center;margin-top:5px">Raydium may show a simulation warning \u2014 this is expected, click Confirm to proceed</div>` : ''}
          </div>`;
      } else if (ns.widgetSwapStatus === 'sending') {
        widgetFlowContent = `
          <div style="padding:14px 16px;text-align:center">
            <div style="font-size:12px;font-weight:600;color:#9945FF;margin-bottom:8px">⏳ Sending transaction…</div>
            <div style="font-size:13px;color:#C2C2D4">Broadcasting transaction…</div>
          </div>`;
      } else if (ns.widgetSwapStatus === 'ready' && ns.widgetLastOrder) {
        const order = ns.widgetLastOrder;
        const outDecimals = ct.outputDecimals ?? MINT_DEC[ct.outputMint] ?? 9;
        const outAmt = parseInt(order.outAmount) / Math.pow(10, outDecimals);
        const inAmt  = ct.amountUI != null ? ct.amountUI : ((ct.amountRaw ?? 0) / Math.pow(10, ct.inputDecimals ?? MINT_DEC[ct.inputMint] ?? 9));
        const rate   = inAmt > 0 ? outAmt / inAmt : null;
        const pi     = parseFloat(order.priceImpactPct ?? 0) * 100; // convert fraction → %
        // RFQ = direct P2P market-maker fill; Gasless = Jupiter-sponsored fee
        const _isRFQ  = order.swapType === 'rfq' || order.swapType === 'gasless';
        const _isRdmBundle = order._source === 'raydium' && (ns.widgetLastOrderFees?.jitoTipLamports ?? 0) >= 1000;
        const _rdmPool  = order._rdmPoolType === 'CLMM' ? 'CLMM' : 'AMM';
        const route   = _isRdmBundle                ? `Raydium · ${_rdmPool} + Jito Bundle`
          : order._source === 'raydium'             ? `Raydium · ${_rdmPool}`
          : order.swapType === 'rfq'                ? 'Direct Fill · RFQ'
          : order.swapType === 'gasless'            ? 'Gasless · Market Maker'
          : (order.routePlan?.map(r => r.swapInfo?.label).filter(Boolean).join(' → ') || 'Jupiter Ultra');
        const piColor = pi >= 2 ? '#FF4D4D' : pi >= 0.5 ? '#FFB547' : '#14F195';

        // ── Shared helpers (same visual language as tooltip) ─────────────
        // _qFmt: never shows '$0.0000' for a positive value — uses '< $0.0001' floor
        const _qFmt = v => {
          if (v == null || !isFinite(v)) return '—';
          const a = Math.abs(v);
          if (a > 0 && a < 0.00005) return '< $0.0001';
          return '$' + (a < 0.01 ? a.toFixed(4) : a.toFixed(3));
        };
        const _qRow = (l, v, c) => `<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:4px"><span style="color:#C2C2D4;font-size:13px">${l}</span><span style="color:${c ?? '#E8E8F0'};font-weight:600;font-size:13px">${v}</span></div>`;
        const _qSub = (l, v, c) => `<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:3px;padding-left:10px"><span style="color:#C2C2D4;font-size:12px">${l}</span><span style="color:${c ?? '#B0B0C0'};font-size:12px;font-weight:600">${v}</span></div>`;
        const _qSec = (lbl) => `<div style="margin:8px 0 4px;color:#C2C2D4;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">${lbl}</div>`;

        // ── Risk & MEV ────────────────────────────────────────────────────
        const rScore = ct.riskScore ?? null;
        const rLevel = rScore != null ? (rScore >= 70 ? 'CRITICAL' : rScore >= 40 ? 'HIGH' : rScore >= 20 ? 'MEDIUM' : 'LOW') : null;
        const rlc    = { CRITICAL: '#FF4D4D', HIGH: '#FFB547', MEDIUM: '#9945FF', LOW: '#14F195' }[rLevel] ?? '#C2C2D4';
        // RFQ/gasless routes bypass the public mempool — MEV risk doesn't apply
        const mevRisk = _isRFQ ? null : (ns.lastRiskResult?.mev);
        const pd     = ns.widgetLastPriceData ?? {};
        const SOL_M  = 'So11111111111111111111111111111111111111112';
        const sol    = pd.solPriceUsd != null ? Number(pd.solPriceUsd) : null;
        const outIsSol = ct.outputMint === SOL_M || ct.outputSymbol === 'SOL' || ct.outputSymbol === 'WSOL';
        const opr    = pd.outputPriceUsd != null ? Number(pd.outputPriceUsd)
          : (outIsSol && sol ? sol
          : (pd.inputPriceUsd != null && inAmt > 0 && outAmt > 0 ? pd.inputPriceUsd * inAmt / outAmt : null));
        // Use the MEV risk algorithm's own estimatedLossPercentage — consistent with the
        // "Bot Attack Risk · X% est. loss" row above it. Only show for MEDIUM+ (LOW is noise).
        // Compute the trade USD value for MEV exposure. Prefer `pd.amountInUsd` if provided
        // but fall back to sensible estimates so MEV protection is not silently lost.
        const _tradeUsdFallback = (pd.amountInUsd != null)
          ? Number(pd.amountInUsd)
          : (pd.inputPriceUsd != null && inAmt != null ? Number(pd.inputPriceUsd) * inAmt
            : (opr != null && outAmt != null ? opr * outAmt : null));

        const mevUsd = (mevRisk && mevRisk.riskLevel !== 'LOW' && mevRisk.estimatedLossPercentage != null && _tradeUsdFallback != null)
          ? Number(_tradeUsdFallback) * (mevRisk.estimatedLossPercentage / 100)
          : null;

        // ── Fees ──────────────────────────────────────────────────────────
        const fees   = ns.widgetLastOrderFees ?? {};
        const priL   = fees.priorityFeeLamports ?? 0;
        const jitoL  = fees.jitoTipLamports ?? 0;
        const SFP    = 0.0005;
        const svcUsd = 0; // Not yet extracted — free during beta
        // Use a $80 SOL floor when sol price is unavailable (non-SOL pairs) so fee
        // values are never silently null — same fallback as page-trade.js netBenefit gate.
        const _solForFees = sol ?? 80;
        const priUsd  = pd.priorityFeeUsd  != null ? Number(pd.priorityFeeUsd)  : (priL  > 0 ? (priL  / 1e9) * _solForFees : null);
        const jitoUsd = pd.jitoTipUsd      != null ? Number(pd.jitoTipUsd)      : (jitoL > 0 ? (jitoL / 1e9) * _solForFees : null);
        const totalCostUsd = (svcUsd ?? 0) + (priUsd ?? 0) + (jitoUsd ?? 0);
        const tierLabel = priL === 0 ? 'Auto' : priL <= 50_000 ? 'Standard' : priL <= 150_000 ? 'Medium' : priL <= 300_000 ? 'High' : 'Max';
        const pfColor   = priL === 0 ? '#14F195' : priL <= 50_000 ? '#14F195' : priL <= 150_000 ? '#9945FF' : '#FFB547';

        // Route type cross-comparison context — when ZendIQ's fill mechanism differs
        // from what Jupiter's live UI shows, surface both so user isn't confused
        const _lqSwapType = ns.jupiterLiveQuote?.swapType ?? null;
        const _lqIsRFQ    = _lqSwapType === 'rfq' || _lqSwapType === 'gasless';
        const _routeMismatch = _lqSwapType && (_isRFQ !== _lqIsRFQ); // one is AMM, other is RFQ
        const _jupLabel = _lqSwapType === 'rfq' ? 'RFQ' : _lqSwapType === 'gasless' ? 'Gasless' :
          (ns.jupiterLiveQuote?.routePlan?.map(r => r.swapInfo?.label).filter(Boolean).slice(0,2).join('→') || 'AMM');
        const routeLabel = route + (_routeMismatch ? ` <span style="opacity:0.55;font-size:9px">(Jup: ${_jupLabel})</span>` : '');

        // ── Savings & Net Benefit ─────────────────────────────────────────
        // Only compute savings when we have Jupiter's own live-tick baseline for the same
        // pair and amount.  We do NOT fall back to a price-impact formula — that produces
        // misleading "phantom" numbers that don't match Activity and create false confidence.
        let savingsUsd = null;
        if (ns.widgetBaselineRawOut != null && order.outAmount != null && opr != null) {
          const _zdq  = Number(order.outAmount);
          const _base = Number(ns.widgetBaselineRawOut);
          if (isFinite(_zdq) && isFinite(_base) && _base > 0 && _zdq > 0) {
            const _g   = (_zdq - _base) / Math.pow(10, outDecimals);
            const _act = _zdq / Math.pow(10, outDecimals);
            // Suppress if diff > 50% of actual output — stale or mismatched baseline
            if (Math.abs(_g) <= _act * 0.5) savingsUsd = _g * opr;
          }
        }
        const _routingNet = savingsUsd != null ? savingsUsd - (svcUsd ?? 0) - (priUsd ?? 0) - (jitoUsd ?? 0) : null;
        // MEV protection value: Jito achieves ~70% reduction of expected bot-attack exposure.
        // Suppress when savingsUsd < 0 (ZendIQ yields fewer tokens than Jupiter) — MEV
        // protection does not justify a route that is already token-worse (B41/B58 parity with
        // page-trade.js autoAccept gate). Without this guard the 10s auto-refresh timer can
        // update the baseline mid-review, making savingsUsd negative while MEV keeps netUsd
        // positive → green button even though ZendIQ's route is provably worse on token amounts.
        // Raydium + Jito bundle bypasses public mempool entirely → ~95% MEV coverage.
        // Jupiter Jito-tipped routes still have brief P2P exposure → ~70%.
        const _mevMultWidget = (order._source === 'raydium' && jitoL >= 1000) ? 0.95 : 0.70;
        const mevProtectionUsd = (mevUsd != null && totalCostUsd > 0 && !(savingsUsd != null && savingsUsd < 0)) ? mevUsd * _mevMultWidget : null;
        // Combined net: routing gain/loss + MEV protection value − fees (deducted once in _routingNet).
        // When no routing baseline exists, fall back to MEV-only: protection value − fees.
        const netUsd = _routingNet != null
          ? _routingNet + (mevProtectionUsd ?? 0)
          : (mevProtectionUsd != null ? mevProtectionUsd - (svcUsd ?? 0) - (priUsd ?? 0) - (jitoUsd ?? 0) : null);
        // mevNetUsd: kept for display logic — only set on the MEV-only fallback path
        const mevNetUsd = _routingNet == null && netUsd != null ? netUsd : null;
        const _effectiveNet = netUsd;
        const hasUsd = priUsd != null;
        // Any negative net means ZendIQ's route costs the user money vs Jupiter.
        // Threshold is -0.00005 (not exactly 0) to absorb floating-point noise on
        // break-even trades — avoids amber button on a true $0.0000 net.
        const netNeg = _effectiveNet != null && _effectiveNet < -0.00005;
        const _netNegMevOnly = _routingNet == null && mevNetUsd != null && mevNetUsd < -0.00005;

        // ── Freeze snapshot for history entry ─────────────────────────────
        // Captured at the moment Review & Sign renders — stops Jupiter live ticks
        // from overwriting widgetBaselineRawOut before the tx confirms and the
        // history entry is written. Activity will prefer these snapshot values.
        ns.widgetSnapBaselineRawOut    = ns.widgetBaselineRawOut;
        ns.widgetSnapSavingsUsd         = savingsUsd;
        ns.widgetSnapMevProtectionUsd   = mevProtectionUsd ?? null; // stored so Activity tooltip can show bot-protection row even when jitoTipUsd=0 in history
        ns.widgetSnapNetUsd             = netUsd ?? null; // combined routing + MEV protection net

        // Token-based routing gain fallback when USD prices unavailable
        const tokenGain = (() => {
          if (ns.widgetBaselineRawOut != null && order.outAmount != null) {
            const _zdq  = Number(order.outAmount);
            const _base = Number(ns.widgetBaselineRawOut);
            if (isFinite(_zdq) && isFinite(_base) && _base > 0 && _zdq > 0) {
              const g    = (_zdq - _base) / Math.pow(10, outDecimals);
              const act  = _zdq / Math.pow(10, outDecimals);
              // Suppress stale/mismatched baseline comparisons (> 50% diff = impossible)
              if (Math.abs(g) <= act * 0.5) {
                // Return 0 for exact/sub-epsilon match so the display can show
                // '≈ same as original' rather than '—' when no USD price is available.
                return Math.abs(g) < 1e-7 ? 0 : g;
              }
            }
          }
          return null;
        })();

        const netColor = netUsd == null
          ? (tokenGain != null ? (tokenGain >= 0 ? '#14F195' : '#FFB547') : '#C2C2D4')
          : (netUsd >= 0 ? '#14F195' : '#FFB547'); // amber for negative estimates (not a realized loss)
        // When no routing baseline exists but Jito is active, show mev_exposure − fees_paid
        // instead of '—'. Answers: "are we net positive after paying for protection?"
        const _jitoActive = jitoL > 0;
        // When netUsd rounds to $0.0000 but there IS a positive token gain, show tokens instead
        // so the user knows ZendIQ found a marginally better fill.
        // When both are essentially zero (both routes at parity), show '≈ same as Jupiter'.
        const _netIsDisplayZero = netUsd != null && netUsd >= 0 && netUsd < 0.00005;
        // _sameRoute: baseline exists, comparison yielded ~0 difference (same route or parity fill)
        const _sameRoute = tokenGain != null && tokenGain === 0;
        const netStr   = netUsd != null && !_netIsDisplayZero
          ? (netUsd >= 0 ? '~ +' : '~ −') + _qFmt(Math.abs(netUsd))
          : _netIsDisplayZero && tokenGain != null && tokenGain > 0
            ? `~ +${tokenGain.toFixed(4)} ${ct.outputSymbol}`
            : (_netIsDisplayZero || _sameRoute)
              ? '≈ same as original'
              : tokenGain != null
                ? `${tokenGain >= 0 ? '~ +' : '~ −'}${Math.abs(tokenGain).toFixed(4)} ${ct.outputSymbol}`
                : mevNetUsd != null
                  ? (mevNetUsd >= 0 ? '~ +' : '~ −') + _qFmt(Math.abs(mevNetUsd)) + ' (MEV est.)'
                  : (_jitoActive ? '— (Jito protected)' : '—');
        const netStrColor = (netUsd != null && !_netIsDisplayZero) ? netColor
          : (_netIsDisplayZero || _sameRoute) ? '#C2C2D4'
          : tokenGain != null ? netColor
          : mevNetUsd != null ? (mevNetUsd >= 0 ? '#14F195' : '#FFB547')
          : (_jitoActive ? '#9945FF' : '#C2C2D4');
        const _netTooltip = (_netIsDisplayZero || _sameRoute)
          ? 'Both ZendIQ and the original route found virtually identical output amounts. ZendIQ still uses the optimal available fill mechanism.'
          : _routeMismatch
            ? `ZendIQ found a ${_isRFQ ? 'direct RFQ fill' : 'multi-market AMM route'} while the original route used ${_jupLabel}. Both are valid fills; ZendIQ picks whichever gives you more tokens.`
            : 'Estimated dollar gain vs. the original route, after all ZendIQ fees are deducted.';

        // Cost total — USD when available, SOL lamport sum otherwise
        const costTotalStr = hasUsd && totalCostUsd > 0
          ? _qFmt(totalCostUsd)
          : (priL + jitoL) > 0 ? `+${((priL + jitoL) / 1e9).toFixed(5)} SOL` : null;

        // Savings breakdown variables (merged into Savings & Costs section)
        const _fmtTok = (n, sym) => (n < 0.000001 ? n.toExponential(2) : n < 0.0001 ? n.toFixed(6) : n < 0.01 ? n.toFixed(4) : n.toFixed(2)) + (sym ? ' ' + sym : '');
        const _impactCostTokens = pi > 0 ? outAmt * (pi / 100) : 0;
        const _impactColor = pi >= 2 ? '#FF4D4D' : pi >= 0.5 ? '#FFB547' : '#14F195';
        const _estSavTok = tokenGain != null && tokenGain > 0 ? tokenGain : (_impactCostTokens > 0.000001 ? _impactCostTokens * 0.35 : 0);
        const _hasSavingsTok = _estSavTok > 0.000001;
        const _jitoOn = jitoL > 0;

        // Prebuild Savings & Costs inner HTML to avoid complex inline template expressions
        let _savingsHtml = '';
        if (ns.widgetMode === 'simple') {
          const parts = [];
          parts.push('Routing impact: ' + (_impactCostTokens > 0.000001 ? ('−' + _fmtTok(_impactCostTokens, ct.outputSymbol) + ' (' + pi.toFixed(2) + '%)') : '≈ none'));
          parts.push('Routing savings: ' + (_hasSavingsTok ? ('+' + _fmtTok(_estSavTok, ct.outputSymbol)) : '≈ none'));
          parts.push('Bot protection: ' + (_isRFQ ? 'N/A · RFQ direct fill' : (_jitoOn ? 'Active · Jito' : 'Priority fee only')));
          parts.push('ZendIQ Fee: FREE · Beta');
          parts.push('Priority Fee: ' + (priUsd != null ? _qFmt(priUsd) : (priL > 0 ? `+${(priL/1e9).toFixed(5)} SOL` : 'Auto')));
          if (jitoL > 0) parts.push('Jito Tip: ' + (jitoUsd != null ? _qFmt(jitoUsd) : `+${(jitoL/1e9).toFixed(5)} SOL`));
          parts.push('Est. Net Benefit: ' + (netStr));
          const tip = parts.join('\n').replace(/"/g,'&quot;');
          _savingsHtml = `<div title="${tip}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 6px">` +
            `<span style="color:#C2C2D4;font-size:13px;font-weight:600">Est. Net Benefit</span>` +
            `<span style="color:${netStrColor};font-size:13px;font-weight:700">${netStr}</span>` +
          `</div>`;
        } else {
          let _parts = '';
          _parts += _qSub('<span title="Routing impact: how much of your output tokens the price impact eats. ZendIQ minimises this through multi-DEX routing." style="cursor:help">Routing impact</span>',
            _impactCostTokens > 0.000001 ? '−' + _fmtTok(_impactCostTokens, ct.outputSymbol) + ' (' + pi.toFixed(2) + '%)' : '≈ none',
            _impactCostTokens > 0.000001 ? _impactColor : '#C2C2D4');
          _parts += _qSub('<span title="Estimated extra tokens you receive vs a direct single-pool swap — from ZendIQ routing across multiple liquidity sources." style="cursor:help">Routing savings</span>',
            _hasSavingsTok ? '+' + _fmtTok(_estSavTok, ct.outputSymbol) + (tokenGain != null && tokenGain > 0 ? '' : ' (est.)') : '≈ none',
            _hasSavingsTok ? '#14F195' : '#C2C2D4');
          _parts += _qSub('<span title="Jito tip reduces MEV front-running exposure by ~70%. Statistical expected value — will vary per trade." style="cursor:help">Bot protection</span>',
            _isRFQ ? 'N/A · RFQ direct fill' : (_jitoOn ? 'Active · Jito' : 'Priority fee only'),
            _isRFQ ? '#C2C2D4' : (_jitoOn ? '#9945FF' : '#C2C2D4'));
          _parts += '<div style="border-top:1px solid rgba(255,255,255,0.06);margin:6px 0"></div>';
          _parts += _qSub('<span title="ZendIQ charges a 0.05% service fee on the output amount. This fee is waived entirely during the Beta period — completely free." style="cursor:help">ZendIQ Fee (0.05%)</span>', '<span style="color:#14F195;font-weight:600">FREE · Beta</span>');
          _parts += _qSub(`<span title="Solana compute unit tip paid to validators for faster transaction processing. Auto = dynamically adjusted based on network congestion. Standard → Medium → High → Max tiers increase speed and cost. Baked into the transaction at quote time." style="cursor:help">Priority Fee (via ${order._source === 'raydium' ? 'Raydium' : 'Jupiter'})</span> <span style="opacity:0.6;font-size:9px">${tierLabel}</span>`,
            priUsd != null ? _qFmt(priUsd) : (priL > 0 ? `+${(priL/1e9).toFixed(5)} SOL` : 'Auto'),
            pfColor);
          if (jitoL > 0) _parts += _qSub('<span title="An optional Jito tip to incentivise fast landing. Routed through Jupiter\'s execution engine — NOT a Jito bundle; an embedded account blocks third-party bundling." style="cursor:help">Jito Tip (via Jupiter)</span>', jitoUsd != null ? _qFmt(jitoUsd) : `+${(jitoL/1e9).toFixed(5)} SOL`, '#9945FF');
          _parts += `<div style="display:flex;justify-content:space-between;gap:10px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(153,69,255,0.18)">` +
                `<span style="color:#C2C2D4;font-size:13px;font-weight:600;cursor:help" title="${_netTooltip}">Est. Net Benefit</span>` +
                `<span style="color:${netStrColor};font-size:13px;font-weight:700">${netStr}</span>` +
              `</div>`;
          _savingsHtml = _parts;
        }

        widgetFlowContent = `
          <div id="sr-ready-scroll" style="padding:12px 14px 4px;">
            ${ns.widgetPausedForToken ? (() => {
              const _ts  = ns.tokenScoreResult;
              const _lvl = _ts?.level ?? 'HIGH';
              const _clr = _lvl === 'CRITICAL' ? '#FF4D4D' : '#FFB547';
              const _bg  = _lvl === 'CRITICAL' ? 'rgba(255,77,77,0.08)' : 'rgba(255,181,71,0.08)';
              const _bdr = _lvl === 'CRITICAL' ? 'rgba(255,77,77,0.4)'  : 'rgba(255,181,71,0.4)';
              const _sym = ct.outputSymbol || 'this token';
              return `<div style="background:${_bg};border:1px solid ${_bdr};border-radius:8px;padding:10px 12px;margin-bottom:10px">
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="${_clr}" stroke-width="2" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <span style="color:${_clr};font-size:13px;font-weight:700">Auto-sign paused &mdash; ${_lvl} token risk</span>
                  <span style="margin-left:auto;font-size:12px;font-weight:700;color:${_clr};font-family:'Space Mono',monospace">${_ts?.score ?? '?'}/100</span>
                </div>
                <div style="font-size:12px;color:#C2C2D4;line-height:1.55">ZendIQ detected a <strong style="color:${_clr}">${_lvl}</strong> risk score for <strong style="color:#E8E8F0">${_sym}</strong>. Auto-sign was paused so you can review before committing. Check the Token Risk Score row below for details.</div>
              </div>`;
            })() : ''}
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.8px;color:#C2C2D4;margin-bottom:8px">ZendIQ Quote</div>

            <!-- Quote card -->
            <div style="background:linear-gradient(135deg,rgba(20,241,149,0.04),rgba(153,69,255,0.04));border:1px solid rgba(20,241,149,0.15);border-radius:10px;padding:10px 12px;margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px;padding-bottom:7px;border-bottom:1px solid rgba(255,255,255,0.06)">
                <span style="color:#C2C2D4;font-size:13px;cursor:help" title="Best exchange rate found by ZendIQ across all available liquidity sources.">Rate</span>
                <span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:#E8E8F0">${rate !== null ? `1 ${ct.inputSymbol} = ${rate.toFixed(rate < 1 ? 6 : rate < 100 ? 4 : 2)} ${ct.outputSymbol}` : '—'}</span>
              </div>
              ${_qRow('<span title="The exact amount of token being sent from your wallet for this swap." style="cursor:help">Selling</span>', `${inAmt.toFixed(4)} ${ct.inputSymbol}`)}
              ${_qRow('<span title="The amount you will receive after the swap completes. Actual received may vary slightly depending on final on-chain slippage." style="cursor:help">Buying</span>',  `${outAmt.toFixed(4)} ${ct.outputSymbol}`, '#14F195')}
              ${ns.widgetMode === 'simple' ? '' : _qRow('<span title="How much this trade shifts the pool price. Below 0.1% is ideal. Above 1% means you are moving the market — consider splitting into smaller swaps." style="cursor:help">Price Impact</span>', `${pi.toFixed(3)}%`, piColor)}
              <div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:0">
                <span style="color:#C2C2D4;font-size:13px;cursor:help" title="${_isRFQ ? 'RFQ (Request For Quote) — a professional market maker fills your swap directly at a fixed price. No AMM pool involved, no sandwich attack risk.' + (_routeMismatch ? ' Original route used ' + _jupLabel + ' — ZendIQ found a better-priced direct fill instead.' : '') : order._source === 'raydium' ? 'Raydium AMM route — on-chain swap through Raydium concentrated liquidity pools. Found by comparing Raydium and Jupiter in parallel; Raydium offered more output tokens for this trade.' : 'The DEX routing path for your swap. Jupiter Ultra aggregator searches dozens of liquidity pools simultaneously for the optimal execution path.'}">Route</span>
                <span style="font-weight:600;font-size:12px;color:#9945FF;overflow:hidden;text-overflow:ellipsis;max-width:160px;white-space:nowrap">${routeLabel}</span>
              </div>
            </div>

            <!-- Overall Risk Score — composite of Execution + Bot Attack + Token Risk -->
            ${(() => {
              const _execSc  = ns.lastRiskResult?.score ?? rScore ?? 0;
              const _execLvl = ns.lastRiskResult?.level ?? rLevel ?? 'LOW';
              const _botSc   = mevRisk?.riskScore ?? 0;
              const _botLvl  = mevRisk?.riskLevel ?? 'LOW';
              const _tsR2    = ns.tokenScoreResult;
              const _tsL2    = _tsR2?.mint === (ct.outputMint ?? null) && _tsR2?.loaded;
              const _tkSc    = _tsL2 ? (_tsR2.score ?? 0) : 0;
              const _tkLvl   = _tsL2 ? (_tsR2.level ?? 'LOW') : null;
              const _comp    = Math.round(_execSc * 0.40 + _botSc * 0.35 + _tkSc * 0.25);
              const _compLvl = _comp >= 75 ? 'CRITICAL' : _comp >= 50 ? 'HIGH' : _comp >= 25 ? 'MEDIUM' : 'LOW';
              const _cc      = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[_compLvl] ?? '#C2C2D4';
              const _bg      = `background:${_cc}11;border:1px solid ${_cc}44`;
              const _badge   = ns.widgetMode === 'simple' ? _riskLabel(_compLvl) : `${_compLvl} \u00b7 ${_comp}/100`;
              const _tip     = `Overall Risk Score \u2014 weighted composite of all three risk dimensions.&#10;Formula: Execution \u00d7 40% + Bot Attack \u00d7 35% + Token Risk \u00d7 25%&#10;&#10;Execution: ${_execSc}/100 \u00b7 Bot Attack: ${_botSc}/100 \u00b7 Token Risk: ${_tsL2 ? _tkSc + '/100' : 'pending\u2026'}`;
              const _sc      = s => ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[s] ?? '#C2C2D4';
              const _subRows = ns.widgetMode !== 'simple' ? `<div style="margin-top:8px;border-top:1px solid ${_cc}22;padding-top:7px">
                  <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">
                    <span style="color:#C8C8D8;font-size:12px">Execution</span>
                    <span style="color:${_sc(_execLvl)};font-size:12px;font-weight:700;font-family:'Space Mono',monospace">${_execLvl} \u00b7 ${_execSc}/100</span>
                  </div>
                  <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">
                    <span style="color:#C8C8D8;font-size:12px">Bot Attack</span>
                    <span style="color:${_sc(_botLvl)};font-size:12px;font-weight:700;font-family:'Space Mono',monospace">${_botLvl} \u00b7 ${_botSc}/100</span>
                  </div>
                  <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">
                    <span style="color:#C8C8D8;font-size:12px">Token Risk</span>
                    <span style="color:${_tsL2 ? _sc(_tkLvl) : '#C2C2D4'};font-size:12px;font-weight:700;font-family:'Space Mono',monospace">${_tsL2 ? `${_tkLvl} \u00b7 ${_tkSc}/100` : 'scanning\u2026'}</span>
                  </div>
                </div>` : '';
              return `<div title="${_tip}" style="${_bg};border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:help">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
                  <span style="color:${_cc};font-weight:600">Overall Risk</span>
                  <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${_cc}">${_badge}</span>
                </div>
                ${_subRows}
              </div>`;
            })()}

            <!-- Token Risk Score — standalone gradient card (above Bot Attack Risk) -->
            ${(() => {
              const _ts     = ns.tokenScoreResult;
              const _tsMint = ct.outputMint ?? null;
              if (!_tsMint) return '';
              // Trigger async score fetch if result is absent or stale
              if ((!_ts || _ts.mint !== _tsMint) && ns._tokenScoreMint !== _tsMint && ns.fetchTokenScore) {
                ns._tokenScoreMint = _tsMint;
                ns.fetchTokenScore(_tsMint, ct.outputSymbol);
              }
              const tsLoaded = _ts && _ts.mint === _tsMint && _ts.loaded;
              const tsc      = tsLoaded ? (({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[_ts.level] ?? '#C2C2D4') : '#FFB547';
              const _tsBg    = tsLoaded ? `background:${tsc}11;border:1px solid ${tsc}44` : 'background:rgba(255,181,71,0.05);border:1px solid rgba(255,181,71,0.25)';
              const tsBadge  = tsLoaded ? (ns.widgetMode === 'simple' ? _riskLabel(_ts.level) : `${_ts.level} \u00b7 ${_ts.score}/100`) : 'Scanning\u2026';
              const _tsTipFactors = tsLoaded && _ts.factors?.length
                ? 'Factors:\u000a' + _ts.factors.map(f => `\u2022 ${f.name} [${f.severity}]${f.detail ? ' \u2014 ' + f.detail.slice(0,55) : ''}`).join('\u000a')
                : 'Scanning for rug risk, mint authority, supply concentration and RugCheck.xyz flags\u2026';
              const tsTip = `Token Risk Score \u2014 on-chain + RugCheck.xyz analysis of the token you are buying.&#10;Score 0\u2013100: LOW <25 | MEDIUM 25\u201349 | HIGH 50\u201374 | CRITICAL 75+ (higher = more risk)&#10;&#10;${_tsTipFactors}`;

              // Factor rows — Advanced mode only
              let _tsFactorRows = '';
              if (ns.widgetMode !== 'simple') {
                if (!tsLoaded || !_ts.factors?.length) {
                  _tsFactorRows = '<div style="margin-top:6px;font-size:12px;color:#C2C2D4;font-style:italic;padding:2px 0">Scanning token\u2026</div>';
                } else {
                  _tsFactorRows = '<div style="margin-top:8px">' + _ts.factors.map(f => {
                    const fc = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[f.severity] ?? '#C2C2D4';
                    const tip = f.detail ? f.detail.replace(/"/g, '&quot;') : '';
                    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ' + fc + ';border-radius:0 5px 5px 0;margin-bottom:3px;cursor:help" title="' + tip + '">' +
                      '<span style="font-size:12px;color:#C0C0D8">' + f.name + '</span>' +
                      '<span style="font-size:9px;font-weight:700;color:' + fc + ';font-family:Space Mono,monospace;flex-shrink:0;margin-left:6px">' + f.severity + '</span>' +
                    '</div>';
                  }).join('') + '</div>';
                }
              }

              return `<div title="${tsTip}" style="${_tsBg};border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
                  <span style="color:${tsc};font-weight:600;cursor:help" title="ZendIQ checks the token you are receiving: mint authority (can devs print unlimited tokens?), freeze authority (can devs block your tokens?), top holder concentration, and RugCheck.xyz flags.">Token Risk Score</span>
                  <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${tsc}">${tsBadge}</span>
                </div>
                ${_tsFactorRows}
              </div>`;
            })()}

            <!-- Bot Attack Risk — standalone gradient card (below Token Risk Score) -->
            ${(() => {
              const _botSuppressForJupGasless = savingsUsd != null && savingsUsd < 0 && _lqIsRFQ;
              const _cardBg   = 'linear-gradient(135deg,rgba(20,241,149,0.05),rgba(153,69,255,0.05))';
              const _cardBdr  = 'rgba(20,241,149,0.18)';
              const _mevTip   = 'Bot Attack Risk — automated bots can front-run or sandwich your swap to steal value the moment it hits the mempool. Higher score = greater exposure.\u000aIndustry term: MEV (Maximal Extractable Value)\u000aScore 0–100: LOW <25 | MEDIUM 25–49 | HIGH 50–74 | CRITICAL 75+';

              if (_isRFQ || _botSuppressForJupGasless) {
                const _tip   = _botSuppressForJupGasless
                  ? 'The original route\'s fill is gasless/RFQ — a direct market-maker route with no public mempool. Bot attacks (MEV) only apply to AMM routes. Since the original fill is better here, using it means zero bot risk.'
                  : 'RFQ (Request For Quote) routes go directly to a market maker. There is no public mempool exposure — sandwiching and front-running are not possible.';
                const _label = _botSuppressForJupGasless ? 'N/A · original direct fill' : 'N/A · RFQ direct fill';
                return `<div title="${_tip}" style="background:${_cardBg};border:1px solid ${_cardBdr};border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
                  <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">
                    <span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>
                    <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:#14F195">${_label}</span>
                  </div>
                </div>`;
              }
              if (!mevRisk) return '';

              const _mc   = {CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'}[mevRisk.riskLevel] ?? '#C2C2D4';
              const _mbg  = `background:${_mc}11;border:1px solid ${_mc}44`;
              const _badge = ns.widgetMode === 'simple'
                ? _riskLabel(mevRisk.riskLevel)
                : `${mevRisk.riskLevel} · ${mevRisk.estimatedLossPercentage?.toFixed(2) ?? '0'}% est. loss`;

              // Est. Loss row (full-width, matches Monitor card)
              const _eln   = ns.lastRiskResult?.estimatedLossNative ?? null;
              const _elSym = ns.lastRiskResult?.inputSymbol ?? ct.inputSymbol ?? 'SOL';
              let _estLossHtml = '';
              if (_eln == null || _eln < 0.000001) {
                _estLossHtml = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;">
                  <span style="color:#C2C2D4">Est. Loss</span>
                  <span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:#14F195">${_eln == null ? '—' : 'none'}</span>
                </div>`;
              } else {
                const _elFmt = _eln < 0.0001 ? _eln.toFixed(6) : _eln < 0.01 ? _eln.toFixed(4) : _eln.toFixed(2);
                const _swapUsd = ns.lastRiskResult?.swapAmountUsd ?? ns.lastRiskResult?.swapAmount ?? 0;
                const _elPct  = _swapUsd > 0 ? ((ns.lastRiskResult.estimatedLoss / _swapUsd) * 100).toFixed(2) : '0.00';
                const _elCol  = parseFloat(_elPct) >= 1 ? '#FF4D4D' : '#FFB547';
                _estLossHtml = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;">
                  <span style="color:#C2C2D4">Est. Loss</span>
                  <span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:${_elCol}">${_elFmt} ${_elSym} (${_elPct}%)</span>
                </div>`;
              }

              // MEV factor rows — Advanced mode only
              let _mevFactorRows = '';
              if (ns.widgetMode !== 'simple') {
                const _mf = mevRisk.factors ?? [];
                if (!_mf.length) {
                  _mevFactorRows = '<div style="font-size:12px;color:#C2C2D4;padding:2px 8px;margin-bottom:4px">No bot risk detected</div>';
                } else {
                  _mevFactorRows = '<div style="margin-top:8px">' + _mf.map(f => {
                    const fc = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[
                      f.score >= 20 ? 'CRITICAL' : f.score >= 10 ? 'HIGH' : f.score >= 5 ? 'MEDIUM' : 'LOW'
                    ] ?? '#C2C2D4';
                    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ' + fc + ';border-radius:0 5px 5px 0;margin-bottom:3px">' +
                      '<span style="font-size:12px;color:#C0C0D8">' + f.factor + '</span>' +
                      '<span style="font-size:9px;font-weight:700;color:' + fc + ';font-family:Space Mono,monospace;flex-shrink:0;margin-left:6px">' + f.score + '</span>' +
                    '</div>';
                  }).join('') + '</div>';
                }
              }

              // Est. Bot Attack Exposure USD row (only MEDIUM+)
              const _expHtml = (mevUsd != null) ? `
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
                  <span style="color:#C2C2D4;cursor:help" title="Estimated dollar value that bots could extract from this swap via front-running or sandwich attacks. ZendIQ Jito tip helps block this.">Est. Exposure</span>
                  <span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:#FFB547">${_qFmt(mevUsd)}</span>
                </div>` : '';

              // For simple mode show only the badge and provide a hover tooltip with details
              if (ns.widgetMode === 'simple') {
                const mf = mevRisk.factors ?? [];
                const mfTip = mf.length ? 'MEV factors:\n' + mf.slice(0,4).map(f => `• ${f.factor} (${f.score})`).join('\n') : 'No bot risk detected';
                const estLoss = ns.lastRiskResult?.estimatedLossNative; const estSym = ns.lastRiskResult?.inputSymbol ?? ct.inputSymbol ?? 'SOL';
                const lossTip = estLoss != null ? `Estimated loss: ${estLoss} ${estSym}` : 'Estimated loss: —';
                const tip = (_mevTip + '\n\n' + lossTip + '\n\n' + mfTip).replace(/"/g,'&quot;');
                return `<div title="${tip}" style="${_mbg};border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
                  <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">
                    <span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>
                    <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${_mc}">${_badge}</span>
                  </div>
                </div>`;
              }
              return `<div title="${_mevTip}" style="${_mbg};border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06)">
                  <span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>
                  <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${_mc}">${_badge}</span>
                </div>
                ${_estLossHtml}
                ${_mevFactorRows}
                ${_expHtml}
              </div>`;
            })()}

            <!-- Execution Risk card — slippage, price impact, network congestion, route complexity -->
            ${(() => {
              const _er = ns.lastRiskResult;
              if (!_er) return '';
              const _erc   = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[_er.level] ?? '#C2C2D4';
              const _erbg  = `background:${_erc}11;border:1px solid ${_erc}44`;
              const _erBadge = ns.widgetMode === 'simple' ? _riskLabel(_er.level) : `${_er.level} \u00b7 ${_er.score}/100`;
              const _erTip = `Execution Risk \u2014 how risky this specific swap is to execute.&#10;Covers: slippage tolerance, price impact, route complexity, network congestion, and trade size.&#10;Score 0\u2013100: LOW <25 | MEDIUM 25\u201349 | HIGH 50\u201374 | CRITICAL 75+`;
              let _erRows = '';
              if (ns.widgetMode !== 'simple') {
                const _ef = _er.factors ?? [];
                if (!_ef.length) {
                  _erRows = '<div style="margin-top:6px;font-size:12px;color:#C2C2D4;font-style:italic;padding:2px 0">Analysing\u2026</div>';
                } else {
                  _erRows = '<div style="margin-top:8px">' + _ef.map(f => {
                    const fc = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[f.severity] ?? '#C2C2D4';
                    const tip = f.detail ? f.detail.replace(/"/g, '&quot;') : '';
                    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ' + fc + ';border-radius:0 5px 5px 0;margin-bottom:3px;cursor:help" title="' + tip + '">' +
                      '<span style="font-size:12px;color:#C0C0D8">' + f.name + '</span>' +
                      '<span style="font-size:9px;font-weight:700;color:' + fc + ';font-family:Space Mono,monospace;flex-shrink:0;margin-left:6px">' + f.severity + '</span>' +
                    '</div>';
                  }).join('') + '</div>';
                }
              }
              return `<div title="${_erTip}" style="${_erbg};border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
                  <span style="color:${_erc};font-weight:600">Execution Risk</span>
                  <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${_erc}">${_erBadge}</span>
                </div>
                ${_erRows}
              </div>`;
            })()}
          </div>
          <div id="sr-ready-footer" style="position:sticky;bottom:0;z-index:10;padding:6px 14px 10px;background:#12121E;border-top:1px solid rgba(255,255,255,0.05)">
            <!-- Savings & Costs (merged) -->
            <div style="border:1px solid rgba(153,69,255,0.12);border-radius:8px;padding:8px 10px;margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 6px">
                <span style="color:#C2C2D4;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;cursor:help" title="Estimated routing savings from ZendIQ's optimised route, plus a full breakdown of all associated costs.">Savings &amp; Costs</span>
                ${costTotalStr ? `<span style="color:#E8E8F0;font-size:12px;font-weight:700">${costTotalStr}</span>` : ''}
              </div>
              ${_savingsHtml}
            </div>

            ${netNeg ? `
            <div style="background:rgba(255,181,71,0.08);border:1px solid rgba(255,181,71,0.35);border-radius:8px;padding:9px 12px;margin-bottom:8px;text-align:center">
              <div style="color:#FFB547;font-size:13px;font-weight:700;margin-bottom:3px">⚠ ${_netNegMevOnly ? 'Jito tip exceeds estimated MEV exposure on this trade' : (savingsUsd != null && savingsUsd < 0 && _lqIsRFQ) ? 'Original fill is better — and has no MEV exposure' : savingsUsd != null && savingsUsd < 0 ? 'ZendIQ\'s route outputs fewer tokens on this trade' : 'Fees exceed the routing benefit on this trade'}</div>
              <div style="color:#C2C2D4;font-size:13px">${_isRFQ ? 'The original market-maker quote was slightly better at the time it was captured.<br>Cancel and use the original route for a better outcome.' : _netNegMevOnly ? 'The Jito tip costs more than the estimated MEV exposure.<br>Consider cancelling — the original route may be cheaper.' : (savingsUsd != null && savingsUsd < 0 && _lqIsRFQ) ? 'The original route uses a direct market-maker fill (no mempool, no bot risk).<br>Cancel and use the original route — you get more tokens <em>and</em> zero MEV exposure.' : savingsUsd != null && savingsUsd < 0 ? 'The original routing found a better fill for this pair.<br>Cancel and use the original route.' : 'Signing will cost more than ZendIQ saves.<br>Cancel and use the original route for a better outcome.'}</div>
            </div>` : ''}
            ${ns.widgetSwapError ? `
            <div style="background:rgba(255,181,71,0.08);border:1px solid rgba(255,181,71,0.35);border-radius:8px;padding:8px 12px;margin-bottom:8px;text-align:center">
              <div style="color:#FFB547;font-size:13px;font-weight:600">⏱ ${escapeHtml(ns.widgetSwapError)}</div>
            </div>` : ''}
            <button id="sr-btn-widget-sign" style="width:100%;padding:11px;border:none;border-radius:8px;background:${netNeg ? 'linear-gradient(135deg,#FFB547,#d4922a)' : 'linear-gradient(135deg,#14F195,#0cc97a)'};color:${netNeg ? '#1a0f00' : '#061a10'};font-size:13px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;box-shadow:${netNeg ? '0 3px 12px rgba(255,181,71,0.3)' : '0 3px 12px rgba(20,241,149,0.3)'}">${netNeg ? '⚠ Sign anyway' : '✦ Sign &amp; Send'}</button>
            ${netNeg ? `<button id="sr-btn-widget-use-jupiter" style="width:100%;padding:11px;margin-top:6px;border:none;border-radius:8px;background:linear-gradient(135deg,#14F195,#0cc97a);color:#061a10;font-size:13px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;box-shadow:0 3px 12px rgba(20,241,149,0.3)">✓ Continue with ${_lqIsRFQ ? 'RFQ fill' : _lqSwapType === 'gasless' ? 'Gasless fill' : 'original route'}</button>` : ''}
            ${!netNeg && !ns._autoProtectPending && ns.pendingDecisionResolve ? `<button id="sr-btn-widget-use-jupiter" style="width:100%;padding:10px;margin-top:6px;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(255,255,255,0.04);color:#C2C2D4;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif" title="Skip ZendIQ's optimised route and proceed with the original swap instead.">↩ Use original route</button>` : ''}
            <button id="sr-btn-widget-cancel" style="width:100%;padding:8px;margin-top:6px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;background:transparent;color:#C2C2D4;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">✕ Cancel — click Swap to retry</button>
            <div style="text-align:center;font-size:9px;color:#4A4A6A;margin-top:8px;line-height:1.4">Not financial advice &middot; use at own risk &middot; profit is NOT guaranteed</div>
            <div style="text-align:center;font-size:12px;color:#4A4A6A;margin-top:4px">${(() => {
              const ms = ns.widgetLastQuoteFetchedAt ? Date.now() - ns.widgetLastQuoteFetchedAt : null;
              const ago = ms !== null ? (ms < 5000 ? 'just now' : Math.round(ms / 1000) + 's ago') : '';
              return ago ? `auto-refresh every 10s · updated ${ago}` : 'auto-refreshing every 10s';
            })()}</div>
          </div>`;
      } else {
        widgetFlowContent = `
          <div style="padding:14px 16px;">
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.8px;color:#C2C2D4;margin-bottom:8px">Review Optimisation</div>
            <div style="background:rgba(153,69,255,0.06);border:1px solid rgba(153,69,255,0.2);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:13px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="color:#C2C2D4">Pair</span>
                <span style="font-weight:600;color:#E8E8F0">${ct.inputSymbol} → ${ct.outputSymbol}</span>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:#C2C2D4">Amount</span>
                <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:600">${ct.amountUI != null ? ct.amountUI.toFixed(4) : '?'} ${ct.inputSymbol}</span>
              </div>
            </div>
            <button id="sr-btn-widget-quote" style="width:100%;padding:11px;border:1px solid rgba(153,69,255,0.3);border-radius:8px;background:rgba(153,69,255,0.1);color:#9945FF;font-size:13px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif">✦ Review Optimisation</button>
          </div>`;
      }
    }

    let swapTabContent = '';

    if (widgetFlowContent) {
      // For done/error: capturedTrade is cleared, use saved fromSwapTab flag instead
      const _isFromSwap = ns.widgetCapturedTrade?.fromSwapTab || ns.widgetLastTxFromSwapTab;
      if (_isFromSwap) {
        swapTabContent = widgetFlowContent;
      } else {
        monitorContent = widgetFlowContent;   // REPLACE idle monitor text, don't append
      }
    }

    // Pre-compute swap tab reactive values
    const _swapHasQuote = ns.widgetCapturedTrade?.fromSwapTab && ns.widgetLastOrder;
    const _srAmtOut = _swapHasQuote
      ? (parseInt(ns.widgetLastOrder.outAmount) / Math.pow(10, ns.widgetCapturedTrade.outputDecimals ?? 9)).toFixed(4)
      : '';
    const _swapHasActivity = (ns.widgetCapturedTrade?.fromSwapTab || ns.widgetLastTxFromSwapTab) &&
      ['fetching','ready','signing','signing-original','sending','done','done-original','error'].includes(ns.widgetSwapStatus);

    // ── First-launch welcome card — shown until user dismisses (synced with popup)
    // Note: dismissing in the widget does NOT count as the popup having been
    // opened. We track a transient `_widgetDismissed` flag so we can hide the
    // welcome card locally while still prompting the user to open the popup
    // when needed (the popup bootstraps shared state used for the wallet scan).
    if (ns.onboarded === false && !ns._widgetDismissed) {
      bodyInner.innerHTML = `
        <div style="padding:18px 16px 14px;font-family:'DM Sans',sans-serif">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#9945FF" stroke-width="2"><path d="M12 3L4 7v5c0 4.4 3.4 8.5 8 9.5 4.6-1 8-5.1 8-9.5V7l-8-4z" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span style="font-size:15px;font-weight:700;color:#E8E8F0">Welcome to ZendIQ</span>
          </div>
          <p style="font-size:13px;color:#C2C2D4;line-height:1.55;margin-bottom:12px"><strong style="color:#E8E8F0">Swap on jup.ag as you normally would.</strong> When you click Swap, ZendIQ quietly intercepts the transaction, checks for a better route and bot risks, then shows you the result — before you sign anything. You stay in control the whole time.</p>
          <ol style="margin:0 0 12px;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">
            <li style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#C2C2D4">
              <span style="flex-shrink:0;width:18px;height:18px;border-radius:50%;background:rgba(153,69,255,0.15);border:1px solid rgba(153,69,255,0.35);color:#9945FF;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center">1</span>
              <span>Open <strong style="color:#E8E8F0">jup.ag</strong>, connect your wallet, and set up a swap</span>
            </li>
            <li style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#C2C2D4">
              <span style="flex-shrink:0;width:18px;height:18px;border-radius:50%;background:rgba(153,69,255,0.15);border:1px solid rgba(153,69,255,0.35);color:#9945FF;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center">2</span>
              <span>Click Swap — ZendIQ intercepts and runs a risk + savings check</span>
            </li>
            <li style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#C2C2D4">
              <span style="flex-shrink:0;width:18px;height:18px;border-radius:50%;background:rgba(153,69,255,0.15);border:1px solid rgba(153,69,255,0.35);color:#9945FF;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center">3</span>
              <span>Approve ZendIQ's optimised route, or proceed with the original swap</span>
            </li>
          </ol>
          <p style="font-size:12px;color:#C2C2D4;text-align:center;margin-bottom:14px;line-height:1.55">
            <strong style="color:#E8E8F0">ZendIQ never has access to your private keys or seed phrase.</strong><br>
            We only read your public address — you sign using your wallet every time.
          </p>
          <button id="sr-ob-dismiss" style="width:100%;padding:11px;border:none;border-radius:8px;background:linear-gradient(135deg,#14F195,#0cc97a);color:#061a10;font-size:13px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;box-shadow:0 3px 12px rgba(20,241,149,0.3)">&#10003; Got it &mdash; show my security score</button>
        </div>`;
      const _obBtn = bodyInner.querySelector('#sr-ob-dismiss');
      if (_obBtn) _obBtn.onclick = () => {
        // Hide the welcome card locally but do NOT mark the extension as
        // globally onboarded — only the popup should broadcast that state.
        ns._widgetDismissed = true;
        // Persist the shared key so other surfaces know onboarding happened,
        // but don't assume the popup was opened in this tab.
        window.postMessage({ type: 'ZENDIQ_SET_ONBOARDED' }, '*');
        ns.widgetActiveTab = 'wallet';
        renderWidgetPanel();
        // Do NOT auto-run the security scan here; wait for the popup-originated
        // broadcast or an explicit user action to run the scan.
      };
      return;
    }

    // Full panel HTML
    // Save scroll position of the monitor panel so live ticks don't reset the view
    const _monScrollTop = bodyInner.querySelector('#sr-monitor-scroll')?.scrollTop ?? 0;
    bodyInner.innerHTML = `
      <style>
        @keyframes srBlink{0%,100%{opacity:1}50%{opacity:0.25}}
        #sr-wallet-addr button { background:none;border:none;color:#C2C2D4;cursor:pointer;font-size:13px;padding:2px 4px; }
        #sr-wallet-addr button:hover { color:#14F195; }
        #sr-wallet-addr button svg { width:14px;height:14px;display:block; }
        #sr-panel-swap .sr-tok-wrap, #sr-panel-swap input { min-width:0; }
        #sr-panel-swap input { max-width:220px; }
        #sr-panel-swap .sr-tok-wrap > div { max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        #sr-panel-swap #sr-picker-in, #sr-panel-swap #sr-picker-out { width:180px; }
        #sr-panel-swap .sr-pick-item { display:flex; align-items:center; gap:8px; padding:6px; border-radius:6px; }
      </style>

      <div style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(20,241,149,0.04);border-bottom:1px solid rgba(20,241,149,0.08);font-size:12px;color:#C2C2D4;">
        ${walletConnected ? `
          <svg width="12" height="12" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M20 6L9 17l-5-5" stroke="#14F195" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          <span style="color:#14F195;font-weight:600">Wallet connected</span>
        ` : `
          <div style="width:6px;height:6px;border-radius:50%;background:#C2C2D4"></div>
          <span>Wallet not detected</span>
        `}
        ${walletAddr ? `<span id="sr-wallet-addr" style="font-family:'Space Mono',monospace;font-size:9px;margin-left:auto;display:inline-flex;align-items:center;gap:8px">${walletAddr}<button id="sr-copy-wallet" title="Copy address"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/></svg></button><span id="sr-copy-feedback" style="display:none;color:#14F195;font-size:13px">Copied</span></span>` : ''}
      </div>

      <div style="display:flex;border-bottom:1px solid rgba(153,69,255,0.2);background:rgba(0,0,0,0.15);">
        <button id="sr-tab-swap"     style="flex:1;padding:9px 4px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${ns.widgetActiveTab==='swap'?'#14F195':'transparent'};color:${ns.widgetActiveTab==='swap'?'#14F195':'#C2C2D4'};cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle;margin-right:6px;fill:none;stroke:currentColor;stroke-width:1.6"><path d="M7 16V8m0 0l3 3M7 8l-3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 8v8m0 0l3-3m-3 3l-3-3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Swap
        </button>
        <button id="sr-tab-monitor"  style="flex:1;padding:9px 4px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${ns.widgetActiveTab==='monitor'?'#14F195':'transparent'};color:${ns.widgetActiveTab==='monitor'?'#14F195':'#C2C2D4'};cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle;margin-right:6px;fill:none;stroke:currentColor;stroke-width:1.6"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Monitor
        </button>
        <button id="sr-tab-activity" style="flex:1;padding:9px 4px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${ns.widgetActiveTab==='activity'?'#14F195':'transparent'};color:${ns.widgetActiveTab==='activity'?'#14F195':'#C2C2D4'};cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle;margin-right:6px;fill:none;stroke:currentColor;stroke-width:1.6"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Activity
        </button>
        <button id="sr-tab-wallet" style="flex:1;padding:9px 4px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${ns.widgetActiveTab==='wallet' ? (_shieldColor||'#14F195') : 'transparent'};color:${ns.widgetActiveTab==='wallet' ? (_shieldColor||'#14F195') : '#C2C2D4'};cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle;margin-right:4px;fill:none;stroke:currentColor;stroke-width:1.6;color:${_shieldColor || (ns.widgetActiveTab==='wallet' ? '#14F195' : '#C2C2D4')};transition:color 0.3s"><path d="M12 3L4 7v5c0 4.4 3.4 8.5 8 9.5 4.6-1 8-5.1 8-9.5V7l-8-4z" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Wallet
        </button>
        <button id="sr-tab-settings" style="flex:1;padding:9px 4px;font-size:13px;font-weight:600;background:none;border:none;border-bottom:2px solid ${ns.widgetActiveTab==='settings'?'#14F195':'transparent'};color:${ns.widgetActiveTab==='settings'?'#14F195':'#C2C2D4'};cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.15s;display:inline-flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle;margin-right:6px;fill:none;stroke:currentColor;stroke-width:1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Settings
        </button>
      </div>

      <div id="sr-panel-swap" style="display:${ns.widgetActiveTab==='swap'?'block':'none'}">
        <div style="display:flex;align-items:flex-start;gap:8px;margin:10px 12px 0;padding:9px 11px;background:rgba(153,69,255,0.07);border:1px solid rgba(153,69,255,0.18);border-radius:8px;font-size:12px;color:#C2C2D4;line-height:1.55;">
          <svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink:0;margin-top:2px;fill:none;stroke:#9945FF;stroke-width:2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>ZendIQ monitors all your jup.ag swaps automatically. Use this form to build a fully optimised order from scratch.</span>
        </div>
        <div style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.03)">
          <div style="margin-bottom:8px">
            <div style="font-size:13px;color:#C2C2D4;margin-bottom:6px">You're Selling</div>
            <div style="display:flex;align-items:center;gap:8px;background:#1A1A2E;border:1px solid rgba(153,69,255,0.12);border-radius:10px;padding:8px;margin-bottom:6px">
              <input id="sr-amount-in" type="number" min="0" step="0.0001" placeholder="0.1" style="flex:1;background:transparent;border:none;color:#E8E8F0;font-family:'Space Mono',monospace;font-size:16px;font-weight:700;outline:none" />
              <div class="sr-tok-wrap" style="position:relative">
                <div id="sr-sel-in" style="display:flex;align-items:center;gap:6px;background:rgba(153,69,255,0.12);border:1px solid rgba(153,69,255,0.25);border-radius:20px;padding:6px 8px;cursor:pointer;white-space:nowrap;user-select:none">
                  <span id="sr-ticker-in" style="font-size:12px;font-weight:700">SOL</span>
                  <span style="color:#C2C2D4;font-size:12px;margin-left:6px">▾</span>
                </div>
                <div id="sr-picker-in" style="display:none;position:absolute;top:calc(100% + 6px);right:0;background:#12121E;border:1px solid rgba(153,69,255,0.12);border-radius:8px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,0.6);z-index:200;width:160px"></div>
              </div>
            </div>

            <div style="display:flex;justify-content:center;margin:6px 0">
              <button id="sr-btn-flip" title="Flip tokens" style="background:#1A1A2E;border:1px solid rgba(153,69,255,0.12);color:#9945FF;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer">⇅</button>
            </div>

            <div style="font-size:13px;color:#C2C2D4;margin-bottom:6px">You're Buying</div>
            <div style="display:flex;align-items:center;gap:8px;background:#1A1A2E;border:1px solid rgba(153,69,255,0.12);border-radius:10px;padding:8px">
              <input id="sr-amount-out" type="text" readonly placeholder="—" value="${_srAmtOut}" style="flex:1;background:transparent;border:none;color:${_srAmtOut ? '#E8E8F0' : '#C2C2D4'};font-family:'Space Mono',monospace;font-size:14px;outline:none" />
              <div class="sr-tok-wrap" style="position:relative">
                <div id="sr-sel-out" style="display:flex;align-items:center;gap:6px;background:rgba(153,69,255,0.12);border:1px solid rgba(153,69,255,0.25);border-radius:20px;padding:6px 8px;cursor:pointer;white-space:nowrap;user-select:none">
                  <span id="sr-ticker-out" style="font-size:12px;font-weight:700">USDC</span>
                  <span style="color:#C2C2D4;font-size:12px;margin-left:6px">▾</span>
                </div>
                <div id="sr-picker-out" style="display:none;position:absolute;top:calc(100% + 6px);right:0;background:#12121E;border:1px solid rgba(153,69,255,0.12);border-radius:8px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,0.6);z-index:200;width:160px"></div>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;${_swapHasActivity ? 'margin-bottom:0' : ''}">
            <button id="sr-btn-send-quote" style="flex:1;padding:10px;border:1px solid rgba(153,69,255,0.2);border-radius:8px;background:rgba(153,69,255,0.06);color:#9945FF;font-size:12px;font-weight:700;cursor:pointer">${_swapHasQuote ? '↺ Refresh Quote' : 'Get Quote'}</button>
            <div id="sr-send-status" style="font-size:12px;color:#C2C2D4;align-self:center;${_swapHasActivity ? 'display:none' : ''}">&nbsp;</div>
          </div>
        </div>
        ${swapTabContent}
      </div>

      <div id="sr-panel-monitor" style="display:${ns.widgetActiveTab==='monitor'?'block':'none'}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px 6px;border-bottom:1px solid rgba(255,255,255,0.03)">
          <div style="min-width:0;flex:1">${riskBadgeHtml}</div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0">
            <label title="Simple View: shows risk level and estimated loss in $ and %&#10;Advanced View: shows MEV breakdown, individual risk contributors, price impact and full trade details." style="position:relative;display:inline-block;width:34px;height:18px;cursor:pointer;flex-shrink:0">
              <input id="sr-mon-mode-toggle" type="checkbox" ${ns.widgetMode==='advanced'?'checked':''} style="opacity:0;width:0;height:0;position:absolute">
              <span style="position:absolute;inset:0;border-radius:18px;background:${ns.widgetMode==='advanced'?'#9945FF':'rgba(255,255,255,0.1)'};transition:background 0.2s"></span>
              <span style="position:absolute;top:2px;left:${ns.widgetMode==='advanced'?'16px':'2px'};width:14px;height:14px;border-radius:50%;background:#fff;transition:left 0.2s"></span>
            </label>
            <span style="font-size:12px;color:#C2C2D4;letter-spacing:0.3px">Advanced View</span>
          </div>
        </div>
        ${monitorContent}
      </div>

      <div id="sr-panel-activity" style="display:${ns.widgetActiveTab==='activity'?'block':'none'}">
        <div style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.05)">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.8px;color:#C2C2D4;margin-bottom:8px">Activity</div>
          ${swapsHtml}
        </div>
      </div>

      <div id="sr-panel-wallet" style="display:${ns.widgetActiveTab==='wallet'?'block':'none'}">
        <div style="padding:12px 16px">
          ${walletSecHtml}
        </div>
      </div>

      <div id="sr-panel-settings" style="display:${ns.widgetActiveTab==='settings'?'block':'none'}">
        <div style="padding:12px 16px">

          <!-- Auto-optimise -->
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);margin-bottom:0">
            <div title="Only triggers when estimated savings are above 0. ZendIQ intercepts every swap and fetches an optimised quote — regardless of risk level or protection profile." style="cursor:default">
              <div style="display:flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:#E8E8F0">
                Auto-optimise when profitable
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="#C2C2D4" stroke-width="1.5" style="flex-shrink:0"><circle cx="8" cy="8" r="7"/><path d="M8 7v4m0-5.5v.5" stroke-linecap="round"/></svg>
              </div>
              <div id="sr-set-autoprotect-hint" style="display:${ns.autoProtect?'':'none'};font-size:12px;color:#C2C2D4;margin-top:2px;line-height:1.4">Only triggers when estimated savings are above 0. Overrides protection profile — intercepts every swap.</div>
            </div>
            <label style="position:relative;display:inline-block;width:36px;height:20px;cursor:pointer;flex-shrink:0;margin-left:10px">
              <input id="sr-set-autoprotect" type="checkbox" ${ns.autoProtect?'checked':''} style="opacity:0;width:0;height:0;position:absolute">
              <span style="position:absolute;inset:0;border-radius:20px;background:${ns.autoProtect?'rgba(20,241,149,0.15)':'#1A1A2E'};border:1px solid ${ns.autoProtect?'#14F195':'rgba(255,255,255,0.1)'};transition:background 0.2s,border-color 0.2s"></span>
              <span style="position:absolute;top:2px;left:${ns.autoProtect?'18px':'2px'};width:14px;height:14px;border-radius:50%;background:${ns.autoProtect?'#14F195':'#C2C2D4'};transition:left 0.2s,background 0.2s"></span>
            </label>
          </div>

          <!-- Auto-accept -->
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);margin-bottom:10px">
            <div style="cursor:default">
              <div style="display:flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:#E8E8F0" title="Only triggers when estimated savings are above 0. ZendIQ goes straight to the wallet sign request — no extra confirmation step. You still approve and sign in your wallet.">
                Auto-accept new quote
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="#C2C2D4" stroke-width="1.5" style="flex-shrink:0"><circle cx="8" cy="8" r="7"/><path d="M8 7v4m0-5.5v.5" stroke-linecap="round"/></svg>
              </div>
              <div id="sr-set-autoaccept-hint" style="display:${ns.autoAccept?'':'none'};font-size:12px;color:#C2C2D4;margin-top:2px;line-height:1.4">Only triggers when estimated savings are above 0. ZendIQ goes straight to wallet sign — you still approve in your wallet.</div>
            </div>
            <label style="position:relative;display:inline-block;width:36px;height:20px;cursor:pointer;flex-shrink:0;margin-left:10px">
              <input id="sr-set-autoaccept" type="checkbox" ${ns.autoAccept?'checked':''} style="opacity:0;width:0;height:0;position:absolute">
              <span style="position:absolute;inset:0;border-radius:20px;background:${ns.autoAccept?'rgba(20,241,149,0.15)':'#1A1A2E'};border:1px solid ${ns.autoAccept?'#14F195':'rgba(255,255,255,0.1)'};transition:background 0.2s,border-color 0.2s"></span>
              <span style="position:absolute;top:2px;left:${ns.autoAccept?'18px':'2px'};width:14px;height:14px;border-radius:50%;background:${ns.autoAccept?'#14F195':'#C2C2D4'};transition:left 0.2s,background 0.2s"></span>
            </label>
          </div>

          <!-- Pause on high token risk -->
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);margin-bottom:10px">
            <div title="Even with auto-accept on, ZendIQ will pause and show you the Review &amp; Sign panel when the output token scores HIGH or CRITICAL risk — preventing silent auto-sign into rugs or honeypots." style="cursor:default">
              <div style="display:flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:#E8E8F0">
                Pause on high token risk
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="#C2C2D4" stroke-width="1.5" style="flex-shrink:0"><circle cx="8" cy="8" r="7"/><path d="M8 7v4m0-5.5v.5" stroke-linecap="round"/></svg>
              </div>
              <div style="font-size:12px;color:#C2C2D4;margin-top:2px;line-height:1.4">Stops auto-accept when output token risk is HIGH or CRITICAL.</div>
            </div>
            <label style="position:relative;display:inline-block;width:36px;height:20px;cursor:pointer;flex-shrink:0;margin-left:10px">
              <input id="sr-set-pausehighrisk" type="checkbox" ${(ns.pauseOnHighRisk !== false)?'checked':''} style="opacity:0;width:0;height:0;position:absolute">
              <span style="position:absolute;inset:0;border-radius:20px;background:${(ns.pauseOnHighRisk !== false)?'rgba(20,241,149,0.15)':'#1A1A2E'};border:1px solid ${(ns.pauseOnHighRisk !== false)?'#14F195':'rgba(255,255,255,0.1)'};transition:background 0.2s,border-color 0.2s"></span>
              <span style="position:absolute;top:2px;left:${(ns.pauseOnHighRisk !== false)?'18px':'2px'};width:14px;height:14px;border-radius:50%;background:${(ns.pauseOnHighRisk !== false)?'#14F195':'#C2C2D4'};transition:left 0.2s,background 0.2s"></span>
            </label>
          </div>

          <!-- Protection Profile -->
          <div style="margin-bottom:14px">
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.8px;color:#C2C2D4;margin-bottom:6px">Protection profile</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
              ${[
                { id:'balanced', name:'Auto-Profit',     badge:'Recommended', badgeColor:'#14F195', desc1:'Only when I make money',      desc2:'Net profit after all fees',  tip:'ZendIQ only steps in when the optimised route puts more in your pocket after all fees (priority fee + Jito tip included). Recommended for most users.' },
                { id:'alert',    name:'Always Ask Me',   badge:'New User',     badgeColor:'#9945FF', desc1:'Show every trade opportunity', desc2:"I'll decide each time",       tip:'Perfect for new users learning how ZendIQ works. Every time you click Swap, ZendIQ intercepts the transaction before it reaches your wallet \u2014 it analyses the route for bot-attack risk and routing efficiency, then opens a panel showing the optimised option alongside the original. You see exactly what you\u2019d gain, what the risks are, and what it costs before you decide. Once you\u2019re comfortable, switch to Auto-Profit to let ZendIQ act automatically.' },
                { id:'focused',  name:'Major Wins Only', desc1:'Only profits >$10',            desc2:'Skip small gains',            tip:'Only activates on HIGH-risk trades with an estimated bot-attack exposure above $10. Low-risk and small trades are passed through silently — ideal for users who only want ZendIQ on large or high-stakes swaps.' },
                { id:'custom',   name:'Custom Settings', desc1:'Advanced configuration',       desc2:'Configure \u2192',            tip:'Set your own minimum risk level, estimated loss and slippage thresholds. Full control over when ZendIQ intervenes.' },
              ].map(p => {
                const active = (ns.settingsProfile ?? 'alert') === p.id;
                const radioStyle = active
                  ? `width:13px;height:13px;border-radius:50%;flex-shrink:0;border:3px solid #1A1A2E;background:#9945FF;box-shadow:0 0 0 2px #9945FF;display:inline-block;margin-right:6px;vertical-align:middle`
                  : `width:13px;height:13px;border-radius:50%;flex-shrink:0;border:2px solid #C2C2D4;background:transparent;display:inline-block;margin-right:6px;vertical-align:middle`;
                const d2Color = p.id==='custom' ? 'rgba(153,69,255,0.7)' : '#C2C2D4';
                return `<button id="sr-set-profile-${p.id}" title="${p.tip}" style="padding:7px 8px;border-radius:6px;font-size:13px;cursor:pointer;text-align:left;border:1px solid ${active?'rgba(153,69,255,0.5)':'rgba(153,69,255,0.15)'};background:${active?'rgba(153,69,255,0.15)':'rgba(255,255,255,0.02)'}">
                  <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:3px"><span style="${radioStyle}"></span><span style="font-size:13px;font-weight:700;color:${active?'#9945FF':'#E8E8F0'}">${p.name}</span>${p.badge ? `<span style="font-size:7px;font-weight:700;padding:1px 4px;border-radius:3px;background:rgba(${p.badgeColor==='#14F195'?'20,241,149':'153,69,255'},0.15);color:${p.badgeColor};letter-spacing:0.3px;white-space:nowrap">${p.badge}</span>` : ''}</div>
                  <div style="font-size:9px;color:#C2C2D4;line-height:1.4;padding-left:19px">${p.desc1}</div>
                  <div style="font-size:9px;color:${d2Color};line-height:1.4;padding-left:19px">${p.desc2}</div>
                </button>`;
              }).join('')}
            </div>
          </div>

          <!-- Custom Thresholds (shown only when Custom profile is active) -->
          <div id="sr-set-custom" style="display:${(ns.settingsProfile??'alert')==='custom'?'block':'none'};margin-bottom:14px;padding:10px;background:rgba(153,69,255,0.05);border:1px solid rgba(153,69,255,0.12);border-radius:8px">
            <div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <span style="font-size:12px;font-weight:500;color:#E8E8F0">Min risk level</span>
                <div style="display:flex;gap:2px">
                  ${[['LOW','LOW'],['MEDIUM','MED'],['HIGH','HIGH'],['CRITICAL','CRIT']].map(([lvl, lbl]) => {
                    const active = (ns.threshMinRiskLevel ?? 'LOW') === lvl;
                    return `<button id="sr-set-lvl-${lvl}" style="padding:4px 6px;border-radius:4px;font-size:9px;font-weight:700;cursor:pointer;border:1px solid ${active?'rgba(153,69,255,0.5)':'rgba(153,69,255,0.15)'};background:${active?'rgba(153,69,255,0.2)':'rgba(255,255,255,0.02)'};color:${active?'#9945FF':'#C2C2D4'}">${lbl}</button>`;
                  }).join('')}
                </div>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <label for="sr-set-loss" style="font-size:12px;font-weight:500;color:#E8E8F0">Min loss</label>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="sr-set-loss" type="number" min="0" step="1" value="${ns.threshMinLossUsd??0}" style="width:56px;padding:4px 6px;border-radius:5px;background:#1A1A2E;border:1px solid rgba(153,69,255,0.2);color:#E8E8F0;font-size:12px;text-align:right;outline:none;font-family:'DM Sans',sans-serif" />
                <span style="font-size:12px;color:#C2C2D4">$</span>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <label for="sr-set-slip" style="font-size:12px;font-weight:500;color:#E8E8F0">Min slippage</label>
              <div style="display:flex;align-items:center;gap:4px">
                <input id="sr-set-slip" type="number" min="0" step="0.1" value="${ns.threshMinSlippage??0}" style="width:56px;padding:4px 6px;border-radius:5px;background:#1A1A2E;border:1px solid rgba(153,69,255,0.2);color:#E8E8F0;font-size:12px;text-align:right;outline:none;font-family:'DM Sans',sans-serif" />
                <span style="font-size:12px;color:#C2C2D4">%</span>
              </div>
            </div>
          </div>

          <!-- Priority Fee / Jito Mode -->
          <div style="margin-bottom:14px">
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.8px;color:#C2C2D4;margin-bottom:6px">Priority Fee &amp; Jito Tip</div>
            ${(function() {
              const modes = [
                { value: 'always', label: 'Always High', desc: 'High priority fee + Jito tip on every trade' },
                { value: 'auto',   label: 'Auto',        desc: 'Scales priority fee \u0026 Jito tip with risk score, MEV exposure \u0026 trade size (recommended)' },
                { value: 'never',  label: 'Standard',    desc: 'Jupiter default priority \u00b7 no Jito tip' },
              ];
              return modes.map(m => {
                const active = (ns.jitoMode ?? 'auto') === m.value;
                return `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;margin-bottom:4px;border-radius:6px;cursor:pointer;border:1px solid ${active?'rgba(153,69,255,0.5)':'rgba(153,69,255,0.15)'};background:${active?'rgba(153,69,255,0.08)':'rgba(255,255,255,0.02)'}">
                  <input type="radio" name="sr-jito" value="${m.value}" ${active?'checked':''} style="accent-color:#9945FF;cursor:pointer;flex-shrink:0;width:13px;height:13px;margin:0">
                  <div>
                    <div style="font-size:13px;font-weight:700;color:${active?'#E8E8F0':'#C2C2D4'}">${m.label}</div>
                    <div style="font-size:9px;color:#C2C2D4">${m.desc}</div>
                  </div>
                </label>`;
              }).join('');
            })()}
          </div>

          <!-- Status row -->
          <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04)">
            <span style="font-size:13px;color:#C2C2D4">Network</span>
            <span style="font-size:12px;font-family:'Space Mono',monospace;color:#14F195">MAINNET</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
            <span style="font-size:13px;color:#C2C2D4">Monitoring</span>
            <span style="font-size:12px;color:#14F195;font-weight:600">● Active</span>
          </div>

          <!-- Disclaimer -->
          <div style="margin-top:14px;padding:9px 11px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:8px;">
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#C2C2D4;margin-bottom:5px">Disclaimer</div>
            <p style="font-size:12px;color:#C2C2D4;line-height:1.55;margin:0 0 5px">ZendIQ provides swap routing analysis and optimisation. <span style="color:#C2C2D4;font-weight:600">Not financial advice.</span> Use at your own risk. Our goal is to be as transparent as possible and to minimise risk — but <span style="color:#C2C2D4;font-weight:600">zero risk cannot be guaranteed</span> after optimisation.</p>
            <p style="font-size:12px;color:#C2C2D4;line-height:1.55;margin:0 0 5px">Estimated savings compare ZendIQ's quoted output against the original route's concurrent quote for the same pair and amount. Risk scores and estimated loss figures are derived from real on-chain data. <span style="color:#C2C2D4;font-weight:600">Actual Gain (est.) is an estimate</span> — the original route was never executed if you chose to optimise, so the true counterfactual cannot be known.</p>
            <p style="font-size:12px;color:#C2C2D4;line-height:1.55;margin:0 0 8px">ZendIQ Quote Accuracy (shown in Activity) compares ZendIQ's quoted rate at the moment you accepted against the actual on-chain result after execution. <span style="color:#C2C2D4;font-weight:700">Full transparency.</span></p>
            <div style="padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;font-weight:600;color:#C2C2D4;text-align:center;letter-spacing:0.2px">Profit is NOT guaranteed.</div>
          </div>

        </div>
      </div>

    `;

        // (removed local debug overlay to avoid ReferenceError on undefined locals)

    // Restore monitor panel scroll position so live data ticks don't jump the view back to top
    const _mse = bodyInner.querySelector('#sr-monitor-scroll');
    if (_mse) _mse.scrollTop = _monScrollTop;

    // Helper: when the user navigates away from Monitor while a pending decision exists,
    // remove only the 'alert' class so the widget stops blocking page interaction —
    // but keep 'expanded' (that's the normal open state) and leave pendingDecisionPromise
    // alive so they can return to Monitor and still act on it.
    function collapseAlertIfPending() {
      if (ns.pendingDecisionResolve) {
        const w = document.getElementById('sr-widget');
        if (w) w.classList.remove('alert');
      }
    }

    // Tab switching
    bodyInner.querySelector('#sr-tab-swap').onclick     = () => { collapseAlertIfPending(); ns.widgetActiveTab = 'swap';     renderWidgetPanel(); };
    bodyInner.querySelector('#sr-tab-monitor').onclick  = () => {
      ns.widgetActiveTab = 'monitor';
      // Re-apply alert class if a pending decision is still waiting
      if (ns.pendingDecisionResolve) {
        const w = document.getElementById('sr-widget');
        if (w) w.classList.add('alert');
      }
      renderWidgetPanel();
    };
    const actBtn = bodyInner.querySelector('#sr-tab-activity');
    if (actBtn) actBtn.onclick = () => {
      collapseAlertIfPending();
      ns.widgetActiveTab = 'activity';
      renderWidgetPanel();
      // Request history from background via the bridge so we get the same data the popup shows
      try {
        window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'GET_HISTORY' } }, '*');
      } catch (e) { }
    };
    const walletTabBtn = bodyInner.querySelector('#sr-tab-wallet');
    if (walletTabBtn) walletTabBtn.onclick = () => {
      collapseAlertIfPending();
      ns.widgetActiveTab = 'wallet';
      renderWidgetPanel();
      // Ask background for any persisted scan result first (bridge will post response)
      try { window.postMessage({ type: 'ZENDIQ_GET_SEC_RESULT' }, '*'); } catch (_) {}
      // Give bridge a short moment to reply and populate `ns.walletSecurityResult`.
      // If no persisted result arrives, run an on-page scan when a wallet is connected.
      setTimeout(() => {
        try {
          if (!ns.walletSecurityResult && !ns.walletSecurityChecking) {
            const _pk = ns.resolveWalletPubkey?.();
            if (_pk) ns.runWalletSecurityCheck?.(_pk);
          } else {
            // If a persisted result was loaded, re-render the panel to show it.
            renderWidgetPanel();
          }
        } catch (_) {}
      }, 120);
    };
    bodyInner.querySelector('#sr-tab-settings').onclick = () => { collapseAlertIfPending(); ns.widgetActiveTab = 'settings'; renderWidgetPanel(); };

    // Wallet security check buttons + reviewed toggle
    if (ns.widgetActiveTab === 'wallet') {
      const _secRun     = bodyInner.querySelector('#sr-sec-run');
      const _secRecheck = bodyInner.querySelector('#sr-sec-recheck');
      const _openPopupBtn = bodyInner.querySelector('#sr-open-popup');
      if (_secRun)     _secRun.onclick     = () => ns.runWalletSecurityCheck?.();
      if (_secRecheck) _secRecheck.onclick = () => ns.runWalletSecurityCheck?.();
      if (_openPopupBtn) _openPopupBtn.onclick = () => {
        try { window.postMessage({ type: 'ZENDIQ_OPEN_POPUP' }, '*'); } catch (_) {}
        // Ask bridge to re-send persisted scan result after a short delay
        setTimeout(() => { try { window.postMessage({ type: 'ZENDIQ_GET_SEC_RESULT' }, '*'); } catch (_) {} }, 500);
      };
      const _secRevToggle = bodyInner.querySelector('#sr-sec-reviewed-toggle');
      if (_secRevToggle) _secRevToggle.onchange = () => {
        ns.walletReviewedAutoApprove = _secRevToggle.checked;
        const wt = ns.walletSecurityResult?.walletType ?? 'unknown';
        window.postMessage({ type: 'ZENDIQ_SET_SEC_REVIEWED', walletType: wt, value: ns.walletReviewedAutoApprove }, '*');
        renderWidgetPanel();
      };
    }

    // Monitor tab Simple/Advanced mode toggle (checkbox)
    const monModeToggle = bodyInner.querySelector('#sr-mon-mode-toggle');
    if (monModeToggle) monModeToggle.onchange = () => { ns.widgetMode = monModeToggle.checked ? 'advanced' : 'simple'; _saveWidgetSettings(); renderWidgetPanel(); };

    // Wire settings panel controls when the settings tab is visible
    if (ns.widgetActiveTab === 'settings') {
      _wireSettingsPanel(bodyInner);
    }

    // (GET_HISTORY is sent on page init and on Activity tab onclick — no auto-send here)

    // Listen for bridge messages from the background/content script and render history
    try {
      if (!ns._widgetBridgeListenerRegistered) {
        ns._widgetBridgeListenerRegistered = true;
        window.addEventListener('message', (ev) => {
          try {
            if (!ev.data || !ev.data.sr_bridge || !ev.data.msg) return;
            const m = ev.data.msg;
            if (m.type !== 'HISTORY_RESPONSE' && m.type !== 'HISTORY_UPDATE') return;
            // Update ns.recentSwaps then let renderWidgetPanel() handle all card rendering.
            if (m.type === 'HISTORY_RESPONSE' && Array.isArray(m.payload)) {
              ns.recentSwaps = m.payload.slice(0, ns.MAX_SWAP_HISTORY ?? 20);
              // Retry fetchActualOut for optimized entries that still show 'pending…'
              // (e.g. the tab was on a different site when the swap confirmed and the
              // background broadcast never reached it — fixed going forward, but existing
              // entries need a one-time retry when they load into the widget).
              if (ns.fetchActualOut) {
                ns._fetchActualOutPending = ns._fetchActualOutPending || new Set();
                ns.recentSwaps.forEach(p => {
                  if (p.signature && p.outputMint && p.quoteAccuracy == null
                      && (p.optimized || p.quotedOut != null || p.rawOutAmount != null)
                      && !ns._fetchActualOutPending.has(p.signature)) {
                    ns._fetchActualOutPending.add(p.signature);
                    (async () => {
                      try {
                        const _wp    = ns.resolveWalletPubkey?.() ?? null;
                        const rawOut = p.rawOutAmount != null ? Number(p.rawOutAmount) : (p.quotedOut != null ? Number(p.quotedOut) : null);
                        const outDec = p.outputDecimals ?? null;
                        const result = await ns.fetchActualOut(p.signature, p.outputMint, _wp, rawOut, outDec);
                        if (!result) return;
                        window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                          signature:       p.signature,
                          actualOutAmount: String(result.actualOut),
                          quoteAccuracy:   result.quoteAccuracy,
                          amountOut:       String(result.actualOut),
                        }}}, '*');
                      } catch (_) {} finally {
                        ns._fetchActualOutPending.delete(p.signature);
                      }
                    })();
                  }
                });
              }
              // Retroactively run sandwich detection for old entries that pre-date this
              // feature (they have no sandwichResult key at all). Same pattern as the
              // fetchActualOut retry above — fires once per signature, persists via
              // HISTORY_UPDATE so the result survives future page loads.
              // NOTE: do NOT manually manage ns._sandwichPending here — detectSandwich
              // handles its own dedup internally via that same Set.
              if (ns.detectSandwich) {
                ns.recentSwaps.forEach(p => {
                  if (!p.signature || !p.inputMint || !p.outputMint) return;
                  if ('sandwichResult' in p && p.sandwichResult !== null && !p.sandwichResult?.error) return; // already has a real result
                  if (p.swapType === 'rfq' || p.swapType === 'gasless') return; // no mempool
                  (async () => {
                    try {
                      const result = await ns.detectSandwich(
                        p.signature, p.inputMint, p.outputMint,
                        { inUsdValue: p.inUsdValue ?? null }
                      );
                      if (!result) return;
                      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                        signature:      p.signature,
                        sandwichResult: result,
                      }}}, '*');
                    } catch (_) {}
                  })();
                });
              }
            }
            // If a single-history update arrives for an optimized entry that has no
            // on-chain quoteAccuracy yet, fetch it from the RPC here (page context
            // has access to ns.fetchActualOut) and re-broadcast a partial update so
            // the background/other tabs can merge it into persisted history.
            if (m.type === 'HISTORY_UPDATE' && m.payload
                && (m.payload.optimized || m.payload.quotedOut != null || m.payload.rawOutAmount != null)) {
              try {
                const p = m.payload;
                if (p.signature && p.outputMint && (p.quoteAccuracy == null) && ns.fetchActualOut) {
                  (async () => {
                    try {
                      const _wp = ns.resolveWalletPubkey?.() ?? null;
                      const rawOut = p.rawOutAmount != null ? Number(p.rawOutAmount) : (p.quotedOut != null ? Number(p.quotedOut) : null);
                      const outDec = p.outputDecimals ?? null;
                      const result = await ns.fetchActualOut(p.signature, p.outputMint, _wp, rawOut, outDec);
                      if (!result) return;
                      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                        signature: p.signature,
                        actualOutAmount: String(result.actualOut),
                        quoteAccuracy:     result.quoteAccuracy,
                        amountOut:         String(result.actualOut),
                      }}}, '*');
                    } catch (_) {}
                  })();
                }
              } catch (_) {}
            }
            // Merge incoming payload into ns.recentSwaps so renderWidgetPanel() sees fresh data
            // without requiring a full GET_HISTORY round-trip.
            if (m.type === 'HISTORY_UPDATE' && m.payload?.signature) {
              const _sig = m.payload.signature;
              const _idx = ns.recentSwaps.findIndex(s => s.signature === _sig);
              if (_idx >= 0) {
                ns.recentSwaps[_idx] = Object.assign({}, ns.recentSwaps[_idx], m.payload);
              } else {
                ns.recentSwaps.unshift(m.payload);
                if (ns.recentSwaps.length > (ns.MAX_SWAP_HISTORY ?? 20))
                  ns.recentSwaps = ns.recentSwaps.slice(0, ns.MAX_SWAP_HISTORY ?? 20);
              }
            }
            // Trigger re-render only when Activity tab is visible.
            if (ns.widgetActiveTab === 'activity') { renderWidgetPanel(); return; }
            return; // not on activity tab — state kept in sync, no visual update needed
            // ── Legacy direct-DOM renderer (unreachable — kept for reference) ─────────
            const hist = m.payload || [];
            const container = document.querySelector('#sr-widget-activity-list');
            if (!container) return;
            if (!Array.isArray(hist) || hist.length === 0) {
              container.innerHTML = `<div style="font-size:12px;color:#C2C2D4;text-align:center;padding:8px 0;line-height:1.6">No activity yet.<br>Swap on <a href="https://jup.ag" target="_blank" rel="noopener" style="color:#9945FF;font-weight:700;text-decoration:none">jup.ag</a> to start monitoring.</div>`;
              return;
            }
            // ── Tooltip builder ──────────────────────────────────────────
            function _zqBuildTipHtml(h) {
              const fmt = v => (v == null || !isFinite(v)) ? '—' : '$' + (Math.abs(v) < 0.01 ? Math.abs(v).toFixed(4) : Math.abs(v).toFixed(3));
              const fmtA = (val, sym) => { if (val == null) return '— '+(sym||''); const n=parseFloat(val); if (!isFinite(n)) return String(val)+' '+(sym||''); const abs=Math.abs(n); const p=abs>=1000?2:abs>=1?4:abs>=0.001?6:8; const [ip,dp]=n.toFixed(p).split('.'); return ip.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(dp?','+dp:'')+' '+(sym||''); };
              const fmtAgo = ts => { const s=Math.round((Date.now()-(ts||0))/1000); return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'; };
              const exchLbl = h.routeSource === 'pump.fun' ? ((h.jitoBundle || h.jitoTipLamports > 0) ? 'pump.fun + Jito Bundle' : 'pump.fun') : h.routeSource === 'raydium' ? ((h.jitoBundle || h.jitoTipLamports > 0) ? 'Raydium · AMM + Jito Bundle' : 'Raydium · AMM') : h.swapType==='rfq'?'RFQ · Jupiter':h.swapType==='gasless'?'Gasless · Jupiter':'Jupiter · AMM';
              const sol = h.solPriceUsd != null ? Number(h.solPriceUsd) : null;
              const SOL_MINT = 'So11111111111111111111111111111111111111112';
              const outputIsSol = h.outputMint === SOL_MINT || h.tokenOut === 'SOL' || h.tokenOut === 'WSOL';
              const opr = h.outputPriceUsd != null ? Number(h.outputPriceUsd) : (outputIsSol && sol != null ? sol : null);
              const outDec = Number(h.outputDecimals ?? 6);
              const priFee  = h.priorityFeeUsd != null ? Number(h.priorityFeeUsd) : (h.priorityFeeLamports && sol ? (h.priorityFeeLamports / 1e9) * sol : null);
              const jitoFee = h.jitoTipUsd != null ? Number(h.jitoTipUsd) : (h.jitoTipLamports && sol ? (h.jitoTipLamports / 1e9) * sol : null);
              const totalCost = (priFee ?? 0) + (jitoFee ?? 0);
              const mevUsd = h.amountInUsd != null && h.priceImpactPct != null ? Number(h.amountInUsd) * Math.abs(parseFloat(h.priceImpactPct)) : null;
              // Tier 1: actual on-chain vs Jupiter baseline (most honest metric)
              let savingsUsd = null;
              const onChainSav = false; // Tier 1 removed — see popup-activity.js _calcBreakdown note
              // Tier 2: ZendIQ quote vs Jupiter quote (pre-execution)
              if (h.baselineRawOut != null && h.rawOutAmount != null && opr != null) {
                const _zdq = Number(h.rawOutAmount), _base = Number(h.baselineRawOut);
                if (isFinite(_zdq) && isFinite(_base) && _base > 0 && _zdq > 0) {
                  const _g = (_zdq - _base) / Math.pow(10, outDec);
                  if (Math.abs(_g) <= (_zdq / Math.pow(10, outDec)) * 0.5) savingsUsd = _g * opr;
                }
              } else if (h.estSavingsTokens != null && opr != null)
                savingsUsd = Number(h.estSavingsTokens) * opr;
              // Tier 2.5: Snapshot from Review & Sign render (frozen baseline + fees).
              if (savingsUsd == null && h.snapSavingsUsd != null)
                savingsUsd = Number(h.snapSavingsUsd);
              // Use stored snapshot netUsd (exact figure the user saw).
              const netUsd = h.snapNetUsd != null
                ? Number(h.snapNetUsd)
                : (savingsUsd != null ? savingsUsd - (priFee ?? 0) - (jitoFee ?? 0) : null);
              const rlc = {CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'}[h.riskLevel] ?? '#C2C2D4';
              const row = (l,v,c) => `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:3px"><span style="color:#C2C2D4">${l}</span><span style="color:${c??'#E8E8F0'};font-weight:600;overflow-wrap:break-word;min-width:0;text-align:right">${v}</span></div>`;
              const sub = (l,v,c) => `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:#C2C2D4">${l}</span><span style="color:${c??'#B0B0C0'}">${v}</span></div>`;
              const divider = `<div style="border-top:1px solid rgba(153,69,255,0.2);margin:8px 0"></div>`;
              const hasAnyUsd = priFee != null || mevUsd != null;

              // ── Section 1: Trade Summary ───────────────────────────────
              let t = `<div style="font-size:13px;font-weight:700;color:#E8E8F0;margin-bottom:8px;border-bottom:1px solid rgba(153,69,255,0.25);padding-bottom:6px">Trade Breakdown</div>`;
              t += row(`<span title="The token you received back into your wallet after the swap completed." style="cursor:help">Received</span>`, escapeHtml(fmtA(h.amountOut, h.tokenOut||'?')), '#14F195');
              t += row(`<span title="The token you sold — sent to the DEX to execute this swap." style="cursor:help">Paid (sold)</span>`, escapeHtml(fmtA(h.amountIn, h.tokenIn||'?')), '#E8E8F0');
              t += row(`<span title="How your swap was routed. Aggregator = scans many DEX pools for the best combined price; RFQ = direct quote from professional market makers (tighter spreads, faster settlement); Gasless = DEX-sponsored network fee." style="cursor:help">Via</span>`, escapeHtml(exchLbl));
              t += row(`<span title="When this transaction was broadcast to the Solana network." style="cursor:help">When</span>`, fmtAgo(h.timestamp));
              if (h.routePlan && Array.isArray(h.routePlan) && h.routePlan.length) {
                const routeStr = h.routePlan.map(s => escapeHtml(s.label ?? s.swapInfo?.label ?? s.amm ?? '?')).join(' → ');
                t += row(`<span title="The specific DEX pools and protocols chained together to achieve your final rate." style="cursor:help">Route</span>`, routeStr);
              }
              if (h.priceImpactPct != null || h.quoteAccuracy != null) {
                let accVal, accOnChain = false;
                if (h.quoteAccuracy != null && isFinite(parseFloat(h.quoteAccuracy))) {
                  accVal = Math.max(0, Math.min(100, parseFloat(h.quoteAccuracy)));
                  accOnChain = true;
                } else if (h.priceImpactPct != null) {
                  const impact = Math.abs(parseFloat(h.priceImpactPct));
                  if (isFinite(impact)) accVal = Math.max(0, 100 - impact * 100);
                }
                if (accVal != null) {
                  const col = accVal >= 99 ? '#14F195' : accVal >= 97 ? '#FFB547' : '#FF4D4D';
                  const qual = accVal >= 99 ? 'Excellent \u2014 trade executed at quoted rate.' : accVal >= 97 ? 'Good \u2014 minor slippage.' : 'Notable slippage \u2014 market moved between quote and execution.';
                  const accTip = accOnChain
                    ? 'Actual on-chain fill accuracy \u2014 actual tokens received vs. ZendIQ\'s quoted amount, verified from the confirmed Solana transaction.'
                    : 'Estimated from pre-execution price impact. Updates to confirmed on-chain accuracy a few seconds after the swap confirms.';
                  t += row(
                    `<span title="${accTip}" style="cursor:help">${accOnChain ? 'ZendIQ Quote Accuracy \u2713' : 'ZendIQ Quote Accuracy'}</span>`,
                    `<span title="${qual}" style="cursor:help;color:${col};font-weight:600">${accVal.toFixed(2)}%</span>`
                  );
                }
              }

              // ── Section 2: Performance Analysis ───────────────────────
              t += divider;
              t += `<div style="font-size:13px;font-weight:700;color:#E8E8F0;margin-bottom:8px">Performance Analysis</div>`;

              // Risk Score — always shown
              t += row(
                `<span title="ZendIQ's composite Bot Attack Risk score for this swap. Factors include trade size, token volatility, pool liquidity, and token metadata. Score 0–100: LOW &lt;25 | MEDIUM 25–49 | HIGH 50–74 | CRITICAL 75+." style="cursor:help">Risk Score</span>`,
                h.riskScore != null ? `${escapeHtml(h.riskScore)}/100 ${escapeHtml(h.riskLevel??'')}` : '—',
                h.riskScore != null ? rlc : '#C2C2D4'
              );

              // Est. Bot Attack Exposure — always shown
              t += row(
                `<span title="Estimated dollar value bots could extract from this swap via front-running or sandwich attacks (MEV = Maximal Extractable Value). ZendIQ's Jito tip routes your transaction to validators who block these attacks." style="cursor:help">Est. Bot Attack Exposure</span>`,
                mevUsd != null ? fmt(mevUsd) : '—',
                mevUsd != null ? (mevUsd > 0.0001 ? '#FFB547' : '#14F195') : '#C2C2D4'
              );

              // Sandwich detection result — shown for all AMM trades (not RFQ/gasless)
              if ('sandwichResult' in h && h.swapType !== 'rfq' && h.swapType !== 'gasless') {
                const _sr2 = h.sandwichResult;
                if (_sr2 === null) {
                  t += row(`<span title="Scanning surrounding block transactions for sandwich attacks." style="cursor:help">Sandwich check</span>`, 'pending\u2026', '#C2C2D4');
                } else if (_sr2?.error) {
                  t += row(`<span title="Block data unavailable \u2014 sandwich check could not complete." style="cursor:help">Sandwich check</span>`, 'unknown', '#9B9BAD');
                } else if (_sr2?.detected) {
                  const _tip2 = _sr2.attackerWallet
                    ? `Detected buy-before / sell-after pattern from wallet ${escapeHtml(_sr2.attackerWallet)}. Estimated extraction: ${_sr2.extractedUsd != null && _sr2.extractedUsd > 0.001 ? '~$' + _sr2.extractedUsd.toFixed(2) : '$0 \u2014 your slippage protection absorbed the attack.'}`
                    : `Detected buy-before / sell-after pattern (multi-wallet bot). Signals: ${(_sr2.signals ?? []).filter(s => s !== 'token_flow').map(s => ({'jito_bundle':'Jito bundle correlation','known_program':'known bot program'}[s] ?? s)).join(', ')}. Estimated extraction: ${_sr2.extractedUsd != null && _sr2.extractedUsd > 0.001 ? '~$' + _sr2.extractedUsd.toFixed(2) : '$0 \u2014 your slippage protection absorbed the attack.'}`;
                  const _hasLoss2 = _sr2.extractedUsd != null && _sr2.extractedUsd > 0.001;
                  const _extV = _hasLoss2
                    ? `<span style="color:#FFB547">\u2248\u00a0$${_sr2.extractedUsd.toFixed(2)} extracted</span>`
                    : `<span style="color:#FFB547">\u26a0 detected</span><span style="color:#14F195"> \u00b7 $0 lost</span>`;
                  t += row(`<span title="${_tip2}" style="cursor:help">\u26a0 Sandwiched</span>`, _extV);
                } else if (_sr2 && !_sr2.detected) {
                  const _scan2 = _sr2.scanned > 0 ? `Scanned ${_sr2.scanned} transaction${_sr2.scanned !== 1 ? 's' : ''} in the same block for buy-before / sell-after patterns. No attack detected.` : 'No sandwich activity detected.';
                  t += row(`<span title="${escapeHtml(_scan2)}" style="cursor:help">Sandwich check</span>`, 'Not sandwiched \u2705', '#14F195');
                }
              }

              // Risk Factors + Bot Attack Risk — always shown in advanced mode
              if (ns.widgetMode !== 'simple') {
                const sfc = {CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'};
                const mfc = {CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'};
                // ── Section: Risk Factors (calculateRisk factors) ─────────────
                t += `<div style="margin:8px 0 4px;font-size:9px;font-weight:700;color:#C2C2D4;text-transform:uppercase;letter-spacing:0.4px;cursor:help" title="Risk signals assessed by ZendIQ for this swap: price impact, slippage, trade size, and network conditions.">Risk Factors</div>`;
                if (h.riskFactors?.length) {
                  t += h.riskFactors.map(f => {
                    const fc = sfc[f.severity] ?? '#C2C2D4';
                    return `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:#C2C2D4">${escapeHtml(f.name ?? f)}</span><span style="color:${fc};font-weight:600">${escapeHtml(f.severity ?? '')}</span></div>`;
                  }).join('');
                } else {
                  t += `<div style="padding-left:10px;color:#C2C2D4;font-size:12px">No risk factors recorded</div>`;
                }
                // ── Section: Bot Attack Risk (MEV factors) ────────────────────
                t += `<div style="margin:8px 0 4px;font-size:9px;font-weight:700;color:#C2C2D4;text-transform:uppercase;letter-spacing:0.4px;cursor:help" title="Individual bot-attack signals detected for this swap. Each factor contributes to the overall Bot Attack Risk score.">Bot Attack Risk</div>`;
                if (h.mevFactors?.length) {
                  t += h.mevFactors.map(f => {
                    const fc = mfc[f.score >= 20 ? 'CRITICAL' : f.score >= 10 ? 'HIGH' : f.score >= 5 ? 'MEDIUM' : 'LOW'] ?? '#C2C2D4';
                    return `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:#C2C2D4">${escapeHtml(f.factor)}</span><span style="color:${fc};font-weight:600">${escapeHtml(f.score)}</span></div>`;
                  }).join('');
                } else {
                  t += `<div style="padding-left:10px;color:#C2C2D4;font-size:12px">No bot risk detected</div>`;
                }
              }

              // ZendIQ Costs — always shown
              const _isRFQFill3 = h.swapType === 'rfq' || h.swapType === 'gasless';
              const _mevMult3 = ((h.routeSource === 'raydium' || h.routeSource === 'pump.fun') && h.jitoBundle) ? 0.95 : _isRFQFill3 ? 1.0 : 0.70;
              const _mevProt3 = h.snapMevProtectionUsd != null && h.snapMevProtectionUsd >= 0.0001
                ? h.snapMevProtectionUsd
                : (mevUsd != null && (_isRFQFill3 || (jitoFee ?? 0) > 0) && mevUsd * _mevMult3 >= 0.0001) ? mevUsd * _mevMult3 : null;
              const _mevLabel3 = _isRFQFill3
                ? `<span title="RFQ direct fill bypasses the public mempool entirely \u2014 zero sandwich/front-run exposure. ZendIQ routed you to a market maker instead of an AMM pool, eliminating bot attack risk completely (100% coverage vs ~70% with Jito)." style="cursor:help">Bot protection (RFQ \u00b7 100%)</span>`
                : `<span title="Statistical MEV protection value: estimated bot-attack exposure \xd7 ${Math.round(_mevMult3 * 100)}% coverage rate from Jito routing." style="cursor:help">Bot protection (\xd7${Math.round(_mevMult3 * 100)}%)</span>`;
              t += `<div style="margin:8px 0 4px;color:#C2C2D4;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;cursor:help" title="Routing improvement achieved by ZendIQ\u2019s route vs Jupiter\u2019s concurrent quote, plus statistical MEV protection value, minus all associated costs.">Savings &amp; Costs</div>`;
              if (savingsUsd != null) { const _absS3 = Math.abs(savingsUsd), _tiny3 = _absS3 < 0.0001; t += sub(`<span title="Extra USD value ZendIQ\u2019s route obtained vs Jupiter\u2019s concurrent live quote at sign time (gross, before costs)." style="cursor:help">Est. Routing improvement</span>`, _tiny3 ? '\u2248\u00a0none' : (savingsUsd >= 0 ? '+' : '\u2212') + fmt(_absS3), _tiny3 ? '#C2C2D4' : (savingsUsd >= 0 ? '#14F195' : '#FF4D4D')); }
              if (_mevProt3 != null) t += sub(_mevLabel3, '+' + fmt(_mevProt3), '#9945FF');
              if (savingsUsd != null || _mevProt3 != null) t += `<div style="border-top:1px solid rgba(255,255,255,0.06);margin:4px 0 4px 10px"></div>`;
              t += sub('ZendIQ Fee (0.05%)', '<span style="color:#14F195;font-weight:600">FREE · Beta</span>');
              t += sub(`<span title="${h.routeSource === 'pump.fun' ? 'Priority fee baked into pumpportal.fun\'s transaction — not separately charged by ZendIQ.' : 'Compute unit price paid to Solana validators to prioritise your transaction. Baked into the transaction at quote time.'}" style="cursor:help">${h.routeSource === 'raydium' ? 'Priority Fee (via Raydium)' : h.routeSource === 'pump.fun' ? 'Priority fee (pumpportal.fun)' : 'Priority Fee (via Jupiter)'}</span>`, h.routeSource === 'pump.fun' && priFee == null ? 'included' : (priFee != null ? fmt(priFee) : '—'), h.routeSource === 'pump.fun' && priFee == null ? '#9B9BAD' : (priFee != null && priFee > 0 ? '#FFB547' : undefined));
              t += sub((h.jitoBundle || h.routeSource === 'raydium' || h.routeSource === 'pump.fun') ? `<span title="Tip paid directly to Jito validators as part of an atomic bundle. ZendIQ submits your transaction + this tip together — validators are incentivised to include both atomically, blocking sandwich attacks before they execute." style="cursor:help">Jito Bundle Tip</span>` : `<span title="Tip routed via Jupiter to Jito validators who block sandwich attacks. This is NOT a Jito bundle — Jupiter prevents third-party bundling via a reserved account in every Ultra transaction." style="cursor:help">Jito Tip (via Jupiter)</span>`, h.jitoTipLamports > 0 ? fmt(jitoFee) : 'none', h.jitoTipLamports > 0 ? '#9945FF' : undefined);
              if (totalCost > 0) t += `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06)"><span style="color:#C2C2D4;padding-left:10px">Total</span><span style="color:#FFB547;font-weight:700">${fmt(totalCost)}</span></div>`;

              // Net Benefit — always shown; fall back to token display when USD prices unavailable
              let nc, ns2;
              const _netIsNeg = netUsd != null && netUsd < 0;
              const _confirmed = h.quoteAccuracy != null && Number(h.quoteAccuracy) >= 99;
              const _netBenLabel = _confirmed
                ? (_netIsNeg ? 'vs. original' : 'Actual Gain')
                : (_netIsNeg ? 'vs. original (est.)' : 'Actual Gain (est.)');
              const _netBenTip   = _netIsNeg
                ? 'ZendIQ&#39;s route returned slightly less than the original route&#39;s concurrent quote on this trade. You chose to proceed with ZendIQ&#39;s route anyway.'
                : (_confirmed
                  ? 'ZendIQ executed accurately (\u226599% quote accuracy). Routing gain vs the original route\u2019s concurrent quote at sign time, frozen when you clicked Sign &amp; Send.'
                  : 'Your actual estimated gain from using ZendIQ instead of the original route, after all costs. Frozen at the moment you clicked Sign &amp; Send.');
              if (netUsd != null) {
                nc  = netUsd >= 0 ? '#14F195' : '#FFB547';
                ns2 = (_confirmed ? '' : '~ ') + (netUsd >= 0 ? '+' : '−') + fmt(Math.abs(netUsd));
              } else if (h.baselineRawOut != null && h.rawOutAmount != null) {
                const _zdq  = Number(h.rawOutAmount);
                const _base = Number(h.baselineRawOut);
                if (isFinite(_zdq) && isFinite(_base) && _base > 0 && _zdq > 0) {
                  const gross = (_zdq - _base) / Math.pow(10, outDec);
                  const act   = _zdq / Math.pow(10, outDec);
                  if (Math.abs(gross) >= 1e-7 && Math.abs(gross) <= act * 0.5) {
                    const _OSYM = { 'So11111111111111111111111111111111111111112':'SOL','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT','JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':'JUP','DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263':'BONK','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm':'WIF','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':'RAY' };
                    const outSym = (h.outputMint && _OSYM[h.outputMint]) || (h.tokenOut || '');
                    nc  = gross >= 0 ? '#14F195' : '#FF4D4D';
                    ns2 = (gross >= 0 ? '+ ' : '- ') + fmtA(Math.abs(gross), outSym);
                  }
                }
              }
              if (!ns2) { nc = '#C2C2D4'; ns2 = '—'; }
              t += `<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(153,69,255,0.2);display:flex;justify-content:space-between;gap:12px"><span style="color:#C2C2D4;cursor:help" title="${_netBenTip}">${_netBenLabel}${_confirmed ? ' <span style=\'font-size:9px;color:#14F195\'>\u2713 delivered</span>' : ''}</span><span style="color:${nc};font-weight:700">${ns2}</span></div>`;
              return t;
            }

            // Format a stored decimal-string amount for display.
            // Uses dot as thousands separator, comma as decimal (1.000.000,42).
            const fmtHistAmt = raw => {
              const n = parseFloat(raw);
              if (!isFinite(n) || raw == null) return '—';
              if (n === 0) return '0';
              const abs = Math.abs(n);
              // Choose decimal precision based on magnitude
              let decimals;
              if (abs >= 1000)      decimals = 2;
              else if (abs >= 1)    decimals = 4;
              else if (abs >= 0.01) decimals = 4;
              else                  decimals = 6;
              // Build string with correct precision then strip trailing zeros after decimal
              let [intPart, decPart] = abs.toFixed(decimals).split('.');
              decPart = decPart ? decPart.replace(/0+$/, '') : '';
              // Add dot thousands separators to integer part
              intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
              return decPart ? intPart + ',' + decPart : intPart;
            };

            let html = '<div style="max-height:310px;overflow-y:auto;overflow-x:hidden;padding-right:2px;scrollbar-width:thin;scrollbar-color:rgba(153,69,255,0.3) transparent;">';
            hist.slice(0, 5).forEach((h, i) => {
              const secs = Math.round((Date.now() - (h.timestamp||0)) / 1000);
              const ago  = secs < 60 ? secs+'s ago' : secs < 3600 ? Math.round(secs/60)+'m ago' : Math.round(secs/3600)+'h ago';

              // ── Savings row ───────────────────────────────────────────
              let savingsHtml = '';
              if (h.optimized) {
                const tokenOut = h.tokenOut ? escapeHtml(h.tokenOut) : '';
                const outDec   = h.outputDecimals != null ? Number(h.outputDecimals) : 6;
                let savLabel = 'Actual Gain (est.)', savText = '—', savColor = '#C2C2D4';
                const sol = h.solPriceUsd != null ? Number(h.solPriceUsd) : null;
                const SOL_M = 'So11111111111111111111111111111111111111112';
                const outIsSol = h.outputMint === SOL_M || h.tokenOut === 'SOL';
                const opr = h.outputPriceUsd != null ? Number(h.outputPriceUsd)
                  : (outIsSol && sol ? sol
                  : (h.inputPriceUsd != null && Number(h.amountIn) > 0 && Number(h.amountOut) > 0
                      ? h.inputPriceUsd * Number(h.amountIn) / Number(h.amountOut) : null));
                const priUsd = h.priorityFeeUsd != null ? Number(h.priorityFeeUsd)
                  : (h.priorityFeeLamports && sol ? (h.priorityFeeLamports / 1e9) * sol : null);
                const jitoUsd = h.jitoTipUsd != null ? Number(h.jitoTipUsd)
                  : (h.jitoTipLamports && sol ? (h.jitoTipLamports / 1e9) * sol : null);
                let savUsd = null;
                if (h.baselineRawOut != null && h.rawOutAmount != null && opr != null) {
                  const _zs = Number(h.rawOutAmount), _bs = Number(h.baselineRawOut);
                  if (isFinite(_zs) && isFinite(_bs) && _bs > 0 && _zs > 0) {
                    const _gs = (_zs - _bs) / Math.pow(10, outDec);
                    if (Math.abs(_gs) <= (_zs / Math.pow(10, outDec)) * 0.5) savUsd = _gs * opr;
                  }
                }
                // Tier 1 removed — see popup-activity.js _calcBreakdown note
                // Tier 2.5: snapshot from Review & Sign render
                if (savUsd == null && h.snapSavingsUsd != null) savUsd = Number(h.snapSavingsUsd);
                // Use stored snapshot netUsd (exact figure user saw).
                const netUsd = h.snapNetUsd != null
                  ? Number(h.snapNetUsd)
                  : (savUsd != null ? savUsd - (priUsd ?? 0) - (jitoUsd ?? 0) : null);
                const _confirmedCard = h.quoteAccuracy != null && Number(h.quoteAccuracy) >= 99;
                if (netUsd != null) {
                  const absStr = Math.abs(netUsd) < 0.01 ? Math.abs(netUsd).toFixed(4) : Math.abs(netUsd).toFixed(3);
                  if (netUsd >= 0) {
                    savLabel = _confirmedCard ? 'Actual Gain' : 'Actual Gain (est.)';
                    const pfx = _confirmedCard ? '' : '~ ';
                    savText = `${pfx}+$${absStr}`; savColor = '#14F195';
                  } else {
                    savLabel = _confirmedCard ? 'vs. original' : 'vs. original (est.)';
                    const pfx = _confirmedCard ? '' : '~ ';
                    savText = `${pfx}\u2212$${absStr}`; savColor = '#FFB547';
                  }
                } else if (h.baselineRawOut != null && h.rawOutAmount != null) {
                  const _zdq  = Number(h.rawOutAmount);
                  const _base = Number(h.baselineRawOut);
                  if (isFinite(_zdq) && isFinite(_base) && _base > 0 && _zdq > 0) {
                    const gross = (_zdq - _base) / Math.pow(10, outDec);
                    const act   = _zdq / Math.pow(10, outDec);
                    // Suppress stale/mismatched baseline comparisons
                    if (Math.abs(gross) >= 1e-7 && Math.abs(gross) <= act * 0.5) {
                      savLabel = gross >= 0 ? 'Net Benefit' : 'vs. original';
                      // Derive output token symbol from outputMint for reliable labelling
                      const _OSYM = { 'So11111111111111111111111111111111111111112':'SOL', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':'JUP', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263':'BONK', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm':'WIF', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':'RAY' };
                      const outSym = (h.outputMint && _OSYM[h.outputMint]) || tokenOut;
                      savText = `${gross>=0?'+ ':'- '}${fmtHistAmt(Math.abs(gross))} ${outSym}`;
                      savColor = gross >= 0 ? '#14F195' : '#FF4D4D';
                    }
                  }
                }
                const _savTipW = savText === '\u2014'
                  ? 'No baseline available \u2014 Jupiter\u2019s live quote wasn\u2019t captured for this trade.'
                  : (savLabel.startsWith('vs. Jupiter')
                    ? 'ZendIQ\u2019s route returned slightly less than Jupiter\u2019s concurrent live quote on this trade. You proceeded anyway.'
                    : 'Estimated dollar value gained vs. Jupiter\u2019s concurrent live quote, net of all fees.');
                savingsHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span style="font-size:13px;color:#C2C2D4;cursor:help" title="${_savTipW}">${savLabel}</span><span style="font-size:13px;font-weight:700;color:${savColor}">${savText}</span></div>`;
              }

              // ── Quote accuracy row ────────────────────────────────────
              let accHtml = '';
              {
                let _qAcc = null, _qOnChain = false;
                if (h.quoteAccuracy != null && isFinite(parseFloat(h.quoteAccuracy))) {
                  _qAcc = Math.max(0, Math.min(100, parseFloat(h.quoteAccuracy))); _qOnChain = true;
                } else if (h.priceImpactPct != null) {
                  const _qi = Math.abs(parseFloat(h.priceImpactPct));
                  if (isFinite(_qi)) _qAcc = Math.max(0, 100 - _qi * 100);
                }
                if (_qAcc != null) {
                  const _qCol = _qAcc>=99?'#14F195':_qAcc>=97?'#FFB547':'#FF4D4D';
                  const _qLbl = _qOnChain ? 'ZendIQ Quote Accuracy ✓' : 'ZendIQ Quote Accuracy';
                  const _qTip = _qOnChain ? 'Actual on-chain fill accuracy \u2014 actual tokens received vs. ZendIQ\u2019s quoted amount, verified from the confirmed Solana transaction.' : 'Estimated from pre-execution price impact. Updates automatically a few seconds after confirmation.';
                  accHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span style="font-size:13px;color:#C2C2D4;cursor:help" title="${_qTip}">${_qLbl}</span><span style="color:${_qCol};font-weight:700;font-size:13px">${_qAcc.toFixed(2)}%</span></div>`;
                }
              }

              const exchLbl = h.routeSource === 'pump.fun' ? (h.jitoBundle ? 'pump.fun + Jito Bundle' : 'pump.fun') : h.routeSource === 'raydium' ? (h.jitoBundle ? 'Raydium \u00b7 AMM + Jito' : 'Raydium \u00b7 AMM') : h.swapType === 'rfq' ? 'RFQ \u00b7 Jupiter' : h.swapType === 'gasless' ? 'Gasless \u00b7 Jupiter' : 'Jupiter \u00b7 AMM';
              const inFmt  = fmtHistAmt(h.amountIn)  + '\u00a0' + escapeHtml(h.tokenIn  || '?');
              const outFmt = fmtHistAmt(h.amountOut) + '\u00a0' + escapeHtml(h.tokenOut || '?');

              const _badgeLabel = (savLabel && savLabel.toLowerCase().startsWith('vs. original')) ? escapeHtml(savLabel) : 'ZendIQ Optimized';
              const _badgeColor = (savLabel && savLabel.toLowerCase().startsWith('vs. original')) ? '#FFB547' : '#9945FF';
              const _badgeBg = _badgeColor === '#FFB547' ? 'rgba(255,181,71,0.06)' : 'rgba(153,69,255,0.15)';
              html += `<div id="sr-wc-${i}" style="background:#12121E;border:1px solid rgba(153,69,255,0.06);border-radius:8px;padding:10px;margin-bottom:8px;font-size:12px;cursor:default">`;
              html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-size:13px;font-weight:700;color:#E8E8F0">Swapped <span style="font-size:9px;font-weight:700;background:${_badgeBg};border:1px solid rgba(153,69,255,0.3);color:${_badgeColor};border-radius:10px;padding:1px 6px;vertical-align:middle">${_badgeLabel}</span></span><span style="font-size:12px;font-weight:700;color:#14F195;font-family:'Space Mono',monospace">+ ${outFmt}</span></div>`;
              html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:13px;color:#C2C2D4">${exchLbl}</span><span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace">- ${inFmt}</span></div>`;
              html += savingsHtml;
              html += accHtml;
              html += `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#9B9BAD">`;
              html += h.signature
                ? `<div style="color:#14F195"><a href="https://solscan.io/tx/${escapeHtml(h.signature)}" target="_blank" style="color:inherit;text-decoration:none">${h.jitoTipSig ? 'Swap \u2197' : 'View on Solscan'}</a>`
                  + (h.jitoTipSig ? `\u00a0<a href="https://solscan.io/tx/${escapeHtml(h.jitoTipSig)}" target="_blank" style="color:#C2C2D4;text-decoration:none;font-size:12px">Jito tip \u2197</a>` : '')
                  + `</div>`
                : '<div/>';
              html += `<div style="color:#9B9BAD;font-size:12px">${ago}</div></div></div>`;
            });
            html += '</div>';
            if (hist.length > 5)
              html += `<div style="text-align:center;font-size:12px;color:#C2C2D4;padding:6px 0 2px">+${hist.length - 5} more · open popup for full history</div>`;
            container.innerHTML = html;

            // ── Wire hover tooltips ───────────────────────────────────────
            const _zqTipEl = (() => {
              let t = document.getElementById('sr-zq-tip');
              if (!t) {
                t = document.createElement('div');
                t.id = 'sr-zq-tip';
                t.style.cssText = 'position:fixed;z-index:2147483647;background:#12121E;border:1px solid rgba(153,69,255,0.4);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.6;color:#E8E8F0;min-width:220px;max-width:256px;box-shadow:0 8px 24px rgba(0,0,0,0.6);pointer-events:none;display:none;';
                document.body.appendChild(t);
              }
              return t;
            })();
            hist.forEach((h, i) => {
              const card = container.querySelector('#sr-wc-' + i);
              if (!card) return;
              card.addEventListener('mouseenter', () => {
                _zqTipEl.innerHTML = _zqBuildTipHtml(h);
                _zqTipEl.style.maxHeight = '';
                _zqTipEl.style.overflowY = '';
                _zqTipEl.style.display = 'block';
                const rect = card.getBoundingClientRect();
                const vw = window.innerWidth, vh = window.innerHeight;
                const tw = _zqTipEl.offsetWidth, th = _zqTipEl.offsetHeight;
                const pad = 6, gap = 6;
                // Prefer below; only go above if more room there
                const spaceBelow = vh - rect.bottom - pad - gap;
                const spaceAbove = rect.top - pad - gap;
                let top;
                if (spaceBelow >= spaceAbove) {
                  const maxH = Math.max(60, spaceBelow);
                  if (th > maxH) { _zqTipEl.style.maxHeight = maxH + 'px'; _zqTipEl.style.overflowY = 'auto'; }
                  top = rect.bottom + gap;
                } else {
                  const maxH = Math.max(60, spaceAbove);
                  if (th > maxH) { _zqTipEl.style.maxHeight = maxH + 'px'; _zqTipEl.style.overflowY = 'auto'; }
                  top = Math.max(pad, rect.top - gap - Math.min(th, maxH));
                }
                let left = Math.min(rect.left, vw - pad - tw);
                left = Math.max(pad, left);
                _zqTipEl.style.top = top + 'px'; _zqTipEl.style.left = left + 'px';
              });
              card.addEventListener('mouseleave', () => { _zqTipEl.style.display = 'none'; });
            });
          } catch (e) { }
        });
      }
    } catch (e) {}

    // ── Activity card tooltip hover wiring ───────────────────────────────────
    if (ns.widgetActiveTab === 'activity' && ns.recentSwaps.length > 0) {
      try {
        const _tipEl = document.getElementById('sr-zq-tip') || (() => {
          const _t = document.createElement('div');
          _t.id = 'sr-zq-tip';
          _t.style.cssText = 'position:fixed;z-index:2147483647;background:#12121E;border:1px solid rgba(153,69,255,0.4);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.6;color:#E8E8F0;min-width:220px;max-width:256px;box-shadow:0 8px 24px rgba(0,0,0,0.6);pointer-events:none;display:none;';
          document.body.appendChild(_t); return _t;
        })();
        function _zqBuildTipHtml(h) {
          const fmt = v => (v == null || !isFinite(v)) ? '—' : '$' + (Math.abs(v) < 0.01 ? Math.abs(v).toFixed(4) : Math.abs(v).toFixed(3));
          const fmtA = (val, sym) => { if (val == null) return '— '+(sym||''); const n=parseFloat(val); if (!isFinite(n)) return String(val)+' '+(sym||''); const abs=Math.abs(n); const p=abs>=1000?2:abs>=1?4:abs>=0.001?6:8; const [ip,dp]=n.toFixed(p).split('.'); return ip.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(dp?','+dp:'')+' '+(sym||''); };
          const fmtAgo = ts => { const s=Math.round((Date.now()-(ts||0))/1000); return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'; };
          const exchLbl = h.routeSource === 'pump.fun' ? ((h.jitoBundle || h.jitoTipLamports > 0) ? 'pump.fun + Jito Bundle' : 'pump.fun') : h.routeSource === 'raydium' ? ((h.jitoBundle || h.jitoTipLamports > 0) ? 'Raydium · AMM + Jito Bundle' : 'Raydium · AMM') : h.swapType==='rfq'?'RFQ · Jupiter':h.swapType==='gasless'?'Gasless · Jupiter':'Jupiter · AMM';
          const sol = h.solPriceUsd != null ? Number(h.solPriceUsd) : null;
          const SOL_MINT = 'So11111111111111111111111111111111111111112';
          const outputIsSol = h.outputMint === SOL_MINT || h.tokenOut === 'SOL' || h.tokenOut === 'WSOL';
          const opr = h.outputPriceUsd != null ? Number(h.outputPriceUsd) : (outputIsSol && sol != null ? sol : null);
          const outDec = Number(h.outputDecimals ?? 6);
          const priFee  = h.priorityFeeUsd != null ? Number(h.priorityFeeUsd) : (h.priorityFeeLamports && sol ? (h.priorityFeeLamports / 1e9) * sol : null);
          const jitoFee = h.jitoTipUsd != null ? Number(h.jitoTipUsd) : (h.jitoTipLamports && sol ? (h.jitoTipLamports / 1e9) * sol : null);
          const totalCost = (priFee ?? 0) + (jitoFee ?? 0);
          const _mevRScore = h.mevRiskScore ?? 0;
          const _mevELP = h.mevEstimatedLossPercent != null ? h.mevEstimatedLossPercent / 100 : (_mevRScore >= 75 ? 0.012 : _mevRScore >= 50 ? 0.006 : _mevRScore >= 25 ? 0.003 : 0);
          const mevUsd = (_mevELP > 0 && h.amountInUsd != null && _mevRScore >= 25) ? Number(h.amountInUsd) * _mevELP : null;
          let savingsUsd = null;
          const onChainSav = false; // Tier 1 removed — see popup-activity.js _calcBreakdown note
          if (h.baselineRawOut != null && h.rawOutAmount != null && opr != null) {
            const _zdq = Number(h.rawOutAmount), _base = Number(h.baselineRawOut);
            if (isFinite(_zdq) && isFinite(_base) && _base > 0 && _zdq > 0) {
              const _g = (_zdq - _base) / Math.pow(10, outDec);
              if (Math.abs(_g) <= (_zdq / Math.pow(10, outDec)) * 0.5) savingsUsd = _g * opr;
            }
          } else if (h.estSavingsTokens != null && opr != null) savingsUsd = Number(h.estSavingsTokens) * opr;
          if (savingsUsd == null && h.snapSavingsUsd != null) savingsUsd = Number(h.snapSavingsUsd);
          const netUsd = h.snapNetUsd != null
            ? Number(h.snapNetUsd)
            : (savingsUsd != null ? savingsUsd - (priFee ?? 0) - (jitoFee ?? 0) : null);
          const rlc = {CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'}[h.riskLevel] ?? '#C2C2D4';
          const row = (l,v,c) => `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:3px"><span style="color:#C2C2D4">${l}</span><span style="color:${c??'#E8E8F0'};font-weight:600;overflow-wrap:break-word;min-width:0;text-align:right">${v}</span></div>`;
          const sub = (l,v,c) => `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:#C2C2D4">${l}</span><span style="color:${c??'#B0B0C0'}">${v}</span></div>`;
          const divider = `<div style="border-top:1px solid rgba(153,69,255,0.2);margin:8px 0"></div>`;
          let t = `<div style="font-size:13px;font-weight:700;color:#E8E8F0;margin-bottom:8px;border-bottom:1px solid rgba(153,69,255,0.25);padding-bottom:6px">Trade Breakdown</div>`;
          t += row(`<span title="The token you received back into your wallet after the swap completed." style="cursor:help">Received</span>`, escapeHtml(fmtA(h.amountOut, h.tokenOut||'?')), '#14F195');
          t += row(`<span title="The token you sold — sent to the DEX to execute this swap." style="cursor:help">Paid (sold)</span>`, escapeHtml(fmtA(h.amountIn, h.tokenIn||'?')), '#E8E8F0');
          t += row(`<span title="How Jupiter routed your swap." style="cursor:help">Via</span>`, escapeHtml(exchLbl));
          t += row(`<span title="When this transaction was broadcast to the Solana network." style="cursor:help">When</span>`, fmtAgo(h.timestamp));
          if (h.routePlan && Array.isArray(h.routePlan) && h.routePlan.length) {
            const routeStr = h.routePlan.map(s => escapeHtml(s.label ?? s.swapInfo?.label ?? s.amm ?? '?')).join(' → ');
            t += row(`<span title="The specific DEX pools and protocols Jupiter chained together." style="cursor:help">Route</span>`, routeStr);
          }
          if (h.priceImpactPct != null || h.quoteAccuracy != null) {
            let accVal, accOnChain = false;
            if (h.quoteAccuracy != null && isFinite(parseFloat(h.quoteAccuracy))) { accVal = Math.max(0, Math.min(100, parseFloat(h.quoteAccuracy))); accOnChain = true; }
            else if (h.priceImpactPct != null) { const imp = Math.abs(parseFloat(h.priceImpactPct)); if (isFinite(imp)) accVal = Math.max(0, 100 - imp * 100); }
            if (accVal != null) {
              const col = accVal>=99?'#14F195':accVal>=97?'#FFB547':'#FF4D4D';
              const qual = accVal>=99?'Excellent — quoted rate.':accVal>=97?'Good — minor slippage.':'Notable slippage.';
              const lbl = h.optimized ? (accOnChain ? 'ZendIQ Quote Accuracy \u2713' : 'ZendIQ Quote Accuracy') : (accOnChain ? 'Jupiter Quote Accuracy \u2713' : 'Jupiter Quote Accuracy');
              const tip = accOnChain ? 'Actual on-chain fill accuracy vs. quoted amount, verified from the confirmed Solana transaction.' : 'Estimated from price impact. Updates a few seconds after confirmation.';
              t += row(`<span title="${tip}" style="cursor:help">${lbl}</span>`, `<span title="${qual}" style="cursor:help;color:${col};font-weight:600">${accVal.toFixed(2)}%</span>`);
            }
          }
          t += divider;
          t += `<div style="font-size:13px;font-weight:700;color:#E8E8F0;margin-bottom:8px">Performance Analysis</div>`;
          t += row(`<span title="ZendIQ's composite risk score (0–100)." style="cursor:help">Risk Score</span>`, h.riskScore != null ? `${escapeHtml(String(h.riskScore))}/100 ${escapeHtml(h.riskLevel??'')}` : '—', h.riskScore != null ? rlc : '#C2C2D4');
          t += row(`<span title="Estimated dollar value extractable by bots." style="cursor:help">Est. Bot Attack Exposure</span>`, mevUsd != null ? fmt(mevUsd) : '—', mevUsd != null ? (mevUsd > 0.0001 ? '#FFB547' : '#14F195') : '#C2C2D4');
          if ('sandwichResult' in h && h.swapType !== 'rfq' && h.swapType !== 'gasless') {
            const _sr2 = h.sandwichResult;
            if (_sr2 === null) {
              t += row(`<span title="Scanning surrounding block transactions for sandwich attacks." style="cursor:help">Sandwich check</span>`, 'pending\u2026', '#C2C2D4');
            } else if (_sr2?.error) {
              t += row(`<span title="Block data unavailable \u2014 sandwich check could not complete." style="cursor:help">Sandwich check</span>`, 'unknown', '#9B9BAD');
            } else if (_sr2?.detected) {
              const _tip2 = _sr2.attackerWallet
                ? `Detected buy-before / sell-after pattern from wallet ${escapeHtml(_sr2.attackerWallet)}. Estimated extraction: ${_sr2.extractedUsd != null && _sr2.extractedUsd > 0.001 ? '~$' + _sr2.extractedUsd.toFixed(2) : '$0 \u2014 your slippage protection absorbed the attack.'}`
                : `Detected buy-before / sell-after pattern (multi-wallet bot). Signals: ${(_sr2.signals ?? []).filter(s => s !== 'token_flow').map(s => ({'jito_bundle':'Jito bundle correlation','known_program':'known bot program'}[s] ?? s)).join(', ')}. Estimated extraction: ${_sr2.extractedUsd != null && _sr2.extractedUsd > 0.001 ? '~$' + _sr2.extractedUsd.toFixed(2) : '$0 \u2014 your slippage protection absorbed the attack.'}`;
              const _hasLoss2 = _sr2.extractedUsd != null && _sr2.extractedUsd > 0.001;
              const _extV = _hasLoss2
                ? `<span style="color:#FFB547">\u2248\u00a0$${_sr2.extractedUsd.toFixed(2)} extracted</span>`
                : `<span style="color:#FFB547">\u26a0 detected</span><span style="color:#14F195"> \u00b7 $0 lost</span>`;
              t += row(`<span title="${_tip2}" style="cursor:help">\u26a0 Sandwiched</span>`, _extV);
            } else if (_sr2 && !_sr2.detected) {
              const _scan2 = _sr2.scanned > 0 ? `Scanned ${_sr2.scanned} transaction${_sr2.scanned !== 1 ? 's' : ''} in the same block for buy-before / sell-after patterns. No attack detected.` : 'No sandwich activity detected.';
              t += row(`<span title="${escapeHtml(_scan2)}" style="cursor:help">Sandwich check</span>`, 'Not sandwiched \u2705', '#14F195');
            }
          }
          if (ns.widgetMode !== 'simple') {
            const sfc = {CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'};
            t += `<div style="margin:8px 0 4px;font-size:9px;font-weight:700;color:#C2C2D4;text-transform:uppercase;letter-spacing:0.4px">Risk Factors</div>`;
            if (h.riskFactors?.length) t += h.riskFactors.map(f => `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:#C2C2D4">${escapeHtml(f.name??f)}</span><span style="color:${sfc[f.severity]??'#C2C2D4'};font-weight:600">${escapeHtml(f.severity??'')}</span></div>`).join('');
            else t += `<div style="padding-left:10px;color:#C2C2D4;font-size:12px">No risk factors recorded</div>`;
            t += `<div style="margin:8px 0 4px;font-size:9px;font-weight:700;color:#C2C2D4;text-transform:uppercase;letter-spacing:0.4px">Bot Attack Risk</div>`;
            if (h.mevFactors?.length) t += h.mevFactors.map(f => { const fc = sfc[f.score>=20?'CRITICAL':f.score>=10?'HIGH':f.score>=5?'MEDIUM':'LOW']??'#C2C2D4'; return `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:#C2C2D4">${escapeHtml(f.factor)}</span><span style="color:${fc};font-weight:600">${escapeHtml(String(f.score))}</span></div>`; }).join('');
            else t += `<div style="padding-left:10px;color:#C2C2D4;font-size:12px">No bot risk detected</div>`;
          }
          if (h.optimized) {
            // ── Savings & Costs (only for optimized trades — ZendIQ built this tx) ──
            const _mevMult2 = ((h.routeSource === 'raydium' || h.routeSource === 'pump.fun') && h.jitoBundle) ? 0.95 : 0.70;
            const _mevProt2 = h.snapMevProtectionUsd != null && h.snapMevProtectionUsd >= 0.0001
              ? h.snapMevProtectionUsd
              : (mevUsd != null && (jitoFee ?? 0) > 0 && mevUsd * _mevMult2 >= 0.0001) ? mevUsd * _mevMult2 : null;
            t += `<div style="margin:8px 0 4px;color:#C2C2D4;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;cursor:help" title="Routing improvement achieved by ZendIQ\u2019s route vs Jupiter\u2019s concurrent quote, plus statistical MEV protection value, minus all associated costs.">Savings &amp; Costs</div>`;
            if (savingsUsd != null) { const _absS2 = Math.abs(savingsUsd), _tiny2 = _absS2 < 0.0001; t += sub(`<span title="Extra USD value ZendIQ\u2019s route obtained vs Jupiter\u2019s concurrent live quote at sign time (gross, before costs)." style="cursor:help">Est. Routing improvement</span>`, _tiny2 ? '\u2248\u00a0none' : (savingsUsd >= 0 ? '+' : '\u2212') + fmt(_absS2), _tiny2 ? '#C2C2D4' : (savingsUsd >= 0 ? '#14F195' : '#FF4D4D')); }
            if (_mevProt2 != null) t += sub(`<span title="Statistical MEV protection value: estimated bot-attack exposure \xd7 ${Math.round(_mevMult2 * 100)}% coverage rate from Jito routing. Covers most sandwich attacks before they execute." style="cursor:help">Bot protection (\xd7${Math.round(_mevMult2 * 100)}%)</span>`, '+' + fmt(_mevProt2), '#9945FF');
            if (savingsUsd != null || _mevProt2 != null) t += `<div style="border-top:1px solid rgba(255,255,255,0.06);margin:4px 0 4px 10px"></div>`;
            t += sub('ZendIQ Fee (0.05%)', '<span style="color:#14F195;font-weight:600">FREE · Beta</span>');
            t += sub(`<span title="${h.routeSource === 'pump.fun' ? 'Priority fee baked into pumpportal.fun\'s transaction — not separately charged by ZendIQ.' : 'Priority fee baked into the transaction at quote time.'}" style="cursor:help">${h.routeSource === 'raydium' ? 'Priority Fee (via Raydium)' : h.routeSource === 'pump.fun' ? 'Priority fee (pumpportal.fun)' : 'Priority Fee (via Jupiter)'}</span>`, h.routeSource === 'pump.fun' && priFee == null ? 'included' : (priFee != null ? fmt(priFee) : '—'), h.routeSource === 'pump.fun' && priFee == null ? '#9B9BAD' : (priFee != null && priFee > 0 ? '#FFB547' : undefined));
            t += sub((h.jitoBundle || h.routeSource === 'raydium' || h.routeSource === 'pump.fun') ? `<span title="Tip paid directly to Jito validators as part of an atomic bundle. ZendIQ submits your transaction + this tip together — validators are incentivised to include both atomically, blocking sandwich attacks before they execute." style="cursor:help">Jito Bundle Tip</span>` : `<span title="Jito tip routed via Jupiter to validators who block sandwich attacks." style="cursor:help">Jito Tip (via Jupiter)</span>`, h.jitoTipLamports > 0 ? fmt(jitoFee) : 'none', h.jitoTipLamports > 0 ? '#9945FF' : undefined);
            if (totalCost > 0) t += `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06)"><span style="color:#C2C2D4;padding-left:10px">Total</span><span style="color:#FFB547;font-weight:700">${fmt(totalCost)}</span></div>`;
            // ── Net Benefit / Actual Gain footer ──
            const _confirmed2 = h.quoteAccuracy != null && Number(h.quoteAccuracy) >= 99;
            const _netBenLabel = _confirmed2
              ? (netUsd != null && netUsd < 0 ? 'vs. original' : 'Actual Gain')
              : (netUsd != null && netUsd < 0 ? 'vs. original (est.)' : 'Actual Gain (est.)');
            const _netBenTip = _confirmed2
              ? 'ZendIQ executed accurately (\u226599% quote accuracy). Routing improvement vs the original route\u2019s concurrent quote + statistical MEV protection value, minus all costs. Frozen at Sign &amp; Send.'
              : 'Frozen at Sign &amp; Send \u2014 routing improvement vs the original route\u2019s concurrent quote + statistical MEV protection value, minus all costs.';
            let nc, nv;
            if (netUsd != null) { nc = netUsd>=0?'#14F195':'#FFB547'; nv = (_confirmed2?'':'~ ')+(netUsd>=0?'+':'\u2212')+fmt(Math.abs(netUsd)); }
            else if (h.baselineRawOut != null && h.rawOutAmount != null) {
              const _zdq=Number(h.rawOutAmount),_base=Number(h.baselineRawOut);
              if (isFinite(_zdq)&&isFinite(_base)&&_base>0&&_zdq>0) {
                const g=(_zdq-_base)/Math.pow(10,outDec),act=_zdq/Math.pow(10,outDec);
                if (Math.abs(g)>=1e-7&&Math.abs(g)<=act*0.5) {
                  const _OSYM={'So11111111111111111111111111111111111111112':'SOL','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT','JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':'JUP','DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263':'BONK','EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm':'WIF','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':'RAY'};
                  const os=(h.outputMint&&_OSYM[h.outputMint])||h.tokenOut||''; nc=g>=0?'#14F195':'#FF4D4D'; nv=(g>=0?'+ ':'- ')+fmtA(Math.abs(g),os);
                }
              }
            }
            if (!nv) { nc='#C2C2D4'; nv='—'; }
            t += `<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(153,69,255,0.2);display:flex;justify-content:space-between;gap:12px"><span style="color:#C2C2D4;cursor:help" title="${_netBenTip}">${_netBenLabel}${_confirmed2?' <span style=\'font-size:9px;color:#14F195\'>\u2713 delivered</span>':''}</span><span style="color:${nc};font-weight:700">${nv}</span></div>`;
          } else {
            // ── Unoptimized footer: On-chain vs Quote (no ZendIQ costs, no net benefit) ──
            t += divider;
            t += `<div style="font-size:12px;font-weight:700;color:#FFB547;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Not Optimized by ZendIQ</div>`;
            t += row(`<span title="You chose to proceed without ZendIQ optimisation. The original transaction was submitted as-is — ZendIQ added no fees, no priority fee, and no Jito tip." style="cursor:help">Action taken</span>`, 'Proceeded without optimisation', '#C2C2D4');
            if (h.actualOutAmount != null && h.quotedOut != null) {
              const actual = parseFloat(h.actualOutAmount), quoted = parseFloat(h.quotedOut);
              if (isFinite(actual) && isFinite(quoted) && quoted > 0) {
                const diff = actual - quoted;
                const col = diff >= 0 ? '#14F195' : '#FFB547';
                t += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(153,69,255,0.2);display:flex;justify-content:space-between;gap:12px"><span style="color:#C2C2D4;white-space:nowrap;cursor:help" title="Actual tokens received on-chain vs the quoted amount at swap time. Negative = normal slippage on the original route.">On-chain vs Quote ✓</span><span style="color:${col};font-weight:700;white-space:nowrap;flex-shrink:0">${diff>=0?'+ ':'- '}${escapeHtml(fmtA(Math.abs(diff),h.tokenOut||''))}</span></div>`;
              }
            } else {
              t += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(153,69,255,0.2);display:flex;justify-content:space-between;gap:12px"><span style="color:#C2C2D4;cursor:help" title="Waiting for on-chain confirmation to compare against the quoted amount.">On-chain vs Quote</span><span style="color:#C2C2D4">${h.quotedOut != null ? 'pending\u2026' : '\u2014'}</span></div>`;
            }
            // Quote Accuracy row
            const _xLbl2 = h.routeSource === 'pump.fun' ? (h.jitoBundle ? 'pump.fun + Jito' : 'pump.fun') : h.routeSource === 'raydium' ? (h.jitoBundle ? 'Raydium + Jito' : 'Raydium') : (h.swapType === 'rfq' ? 'RFQ' : h.swapType === 'gasless' ? 'Gasless' : 'DEX');
            if (h.quoteAccuracy != null && isFinite(parseFloat(h.quoteAccuracy))) {
              const _acc3 = Math.max(0, Math.min(100, parseFloat(h.quoteAccuracy)));
              const _col3 = _acc3>=99?'#14F195':_acc3>=97?'#FFB547':'#FF4D4D';
              t += row(`<span title="Actual on-chain fill accuracy \u2014 actual tokens received vs. the ${_xLbl2}-quoted amount, verified from the confirmed Solana transaction." style="cursor:help">${_xLbl2} Quote Accuracy \u2713</span>`, _acc3.toFixed(2)+'%', _col3);
            } else if (h.quotedOut != null || h.rawOutAmount != null) {
              t += row(`<span title="Waiting for on-chain confirmation to compare against the ${_xLbl2}-quoted amount. Updates automatically a few seconds after the swap confirms." style="cursor:help">${_xLbl2} Quote Accuracy</span>`, 'pending\u2026', '#C2C2D4');
            }
            // Solscan link
            if (h.signature) {
              t += `<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06)"><a href="https://solscan.io/tx/${escapeHtml(h.signature)}" target="_blank" rel="noopener" style="color:#14F195;font-size:12px;text-decoration:none">View on Solscan \u2197</a></div>`;
            }
          }
          return t;
        }
        ns.recentSwaps.slice(0, 5).forEach((h, i) => {
          const card = bodyInner.querySelector('#sr-wc-' + i);
          if (!card) return;
          card.addEventListener('mouseenter', () => {
            _tipEl.innerHTML = _zqBuildTipHtml(h);
            _tipEl.style.maxHeight = ''; _tipEl.style.overflowY = ''; _tipEl.style.display = 'block';
            const rect = card.getBoundingClientRect();
            const vw = window.innerWidth, vh = window.innerHeight;
            const tw = _tipEl.offsetWidth, th = _tipEl.offsetHeight;
            const pad = 6, gap = 6;
            const spaceBelow = vh - rect.bottom - pad - gap;
            const spaceAbove = rect.top - pad - gap;
            let top;
            if (spaceBelow >= spaceAbove) {
              const maxH = Math.max(60, spaceBelow);
              if (th > maxH) { _tipEl.style.maxHeight = maxH + 'px'; _tipEl.style.overflowY = 'auto'; }
              top = rect.bottom + gap;
            } else {
              const maxH = Math.max(60, spaceAbove);
              if (th > maxH) { _tipEl.style.maxHeight = maxH + 'px'; _tipEl.style.overflowY = 'auto'; }
              top = Math.max(pad, rect.top - gap - Math.min(th, maxH));
            }
            let left = Math.min(rect.left, vw - pad - tw);
            left = Math.max(pad, left);
            _tipEl.style.top = top + 'px'; _tipEl.style.left = left + 'px';
          });
          card.addEventListener('mouseleave', () => { _tipEl.style.display = 'none'; });
        });
      } catch (e) {}
    }

    // Overlay action buttons
    if (ns.pendingTransaction) {
      const o  = bodyInner.querySelector('#sr-btn-optimise');
      const s  = bodyInner.querySelector('#sr-btn-skip');
      const c  = bodyInner.querySelector('#sr-btn-cancel');
      const i  = bodyInner.querySelector('#sr-btn-inspect');
      const sm = bodyInner.querySelector('#sr-btn-skip-monitor');
      if (o)  o.onclick  = () => ns.handleOptimiseTrade();
      if (s) {
        // Two-click confirm ONLY fires when ZendIQ has fetched a real order that
        // demonstrably beats Jupiter's baseline. Pre-quote state = single-click.
        // The warning cites the routing gain being left on the table — not the
        // statistical MEV loss, which is already visible in the Bot Attack Risk card.
        const _zdqOut  = ns.widgetLastOrder?.outAmount != null ? Number(ns.widgetLastOrder.outAmount) : null;
        const _baseOut = ns.widgetBaselineRawOut != null ? Number(ns.widgetBaselineRawOut) : null;
        const _hasConfirmedSavings = _zdqOut != null && _baseOut != null && _zdqOut > _baseOut;
        if (_hasConfirmedSavings) {
          // Compute the gain in output-token units for the warning label
          const _outDec = ns.widgetCapturedTrade?.outputDecimals ?? ns.widgetLastPriceData?.outputDecimals ?? 6;
          const _outSym = ns.widgetCapturedTrade?.outputSymbol ?? ns.widgetLastPriceData?.outputSymbol ?? '';
          const _gainRaw = _zdqOut - _baseOut;
          const _gainHuman = _gainRaw / Math.pow(10, _outDec);
          const _gainFmt = _gainHuman < 0.000001 ? _gainHuman.toExponential(2)
            : _gainHuman < 0.0001 ? _gainHuman.toFixed(6)
            : _gainHuman < 0.01   ? _gainHuman.toFixed(4)
            : _gainHuman.toFixed(2);
          const _warnText = `\u26a0 Skip +${_gainFmt}${_outSym ? ' ' + _outSym : ''} gain? \u2014 confirm?`;
          // Restore confirm-pending state if it survived a re-render
          if (ns._skipConfirmPending) {
            s.textContent = _warnText;
            s.style.color = '#FFB547'; s.style.borderColor = 'rgba(255,181,71,0.4)'; s.style.background = 'rgba(255,181,71,0.08)';
            s.title = 'Click again to confirm you want to skip ZendIQ\'s better rate and use the original transaction.';
          }
          s.onclick = () => {
            if (!ns._skipConfirmPending) {
              ns._skipConfirmPending = true;
              s.textContent = _warnText;
              s.style.color = '#FFB547'; s.style.borderColor = 'rgba(255,181,71,0.4)'; s.style.background = 'rgba(255,181,71,0.08)';
              s.title = 'Click again to confirm you want to skip ZendIQ\'s better rate and use the original transaction.';
            } else {
              ns._skipConfirmPending = false;
              ns.handlePendingDecision('allow');
            }
          };
        } else {
          // Pre-quote or no savings found — single-click, no warning
          ns._skipConfirmPending = false;
          s.onclick = () => ns.handlePendingDecision('allow');
        }
      }
      if (c)  c.onclick  = () => ns.handlePendingDecision('block');
      if (i)  i.onclick  = () => { ns.widgetActiveTab = 'swap'; renderWidgetPanel(); };
      if (sm) sm.onclick = () => ns.handlePendingDecision('allow');
    }

    // Widget swap flow buttons
    const qBtn    = bodyInner.querySelector('#sr-btn-widget-quote');
    const signBtn = bodyInner.querySelector('#sr-btn-widget-sign');
    const retryBtn = bodyInner.querySelector('#sr-btn-widget-retry');
    const newBtn  = bodyInner.querySelector('#sr-btn-widget-new');
    const fetchCancelBtn = bodyInner.querySelector('#sr-btn-widget-fetch-cancel');
    if (qBtn)     qBtn.onclick     = () => ns.fetchWidgetQuote();
    if (signBtn)  signBtn.onclick  = () => ns.signWidgetSwap();
    const useJupiterBtn = bodyInner.querySelector('#sr-btn-widget-use-jupiter');
    if (useJupiterBtn) useJupiterBtn.onclick = () => {
      // User chose Jupiter's route over ZendIQ's — resolve pending decision as 'confirm'
      // so Jupiter's original wallet call proceeds unobstructed.
      // handlePendingDecision transitions state to 'signing-original' and calls
      // renderWidgetPanel itself — do NOT clear widgetCapturedTrade or widgetSwapStatus
      // here, that would corrupt the signing-original display and break the next fetch.
      if (ns.pendingDecisionResolve) {
        ns.handlePendingDecision('confirm');
      }
    };
    const cancelBtn = bodyInner.querySelector('#sr-btn-widget-cancel');
    if (cancelBtn) cancelBtn.onclick = () => {
      // If autoProtect was holding Jupiter's tx pending (autoAccept=OFF) the promise is
      // still unresolved when Review & Sign shows. Resolve as 'block'/'cancel' so the
      // wallet hook gets a clean rejection — otherwise it hangs until the next page reload.
      // For the popup Swap tab (no pending decision) this is a safe no-op.
      if (ns.pendingDecisionResolve) {
        ns.handlePendingDecision('block'); // throws 'rejected by user' into Jupiter's hook
      }
      ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
      ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
      ns.widgetLastTxSig = null; ns.widgetLastTxPair = null; ns.widgetLastTxFromSwapTab = null;
      renderWidgetPanel();
    };
    if (retryBtn) retryBtn.onclick = () => ns.fetchWidgetQuote();


    // ── Site adapter button delegation ──────────────────────────────────────────
    const _adptInst = ns.activeSiteAdapter?.();
    if (_adptInst?.onButtonClick) {
      bodyInner.querySelectorAll('[data-adapter-btn]').forEach(el => {
        el.onclick = () => _adptInst.onButtonClick(el.id);
      });
    }
    ns.activeSiteAdapter?.()?.onAfterRender?.();


    if (newBtn)   newBtn.onclick   = () => {
      ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
      ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
      ns.widgetLastTxSig = null; ns.widgetLastTxPair = null; ns.widgetLastTxFromSwapTab = null;
      ns.widgetOriginalSigningInfo = null; ns.widgetOriginalTxSig = null;
      renderWidgetPanel();
    };
    // Auto-dismiss success panel after 2s — clear state but keep widget open
    if (ns.widgetSwapStatus === 'done') {
      setTimeout(() => {
        if (ns.widgetSwapStatus === 'done') {
          ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
          ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
          ns.widgetLastTxSig = null; ns.widgetLastTxPair = null; ns.widgetLastTxFromSwapTab = null;
          // Show generic idle content until next swap begins (clears when /compute fires)
          ns._rdmPostSwapIdle = true;
          renderWidgetPanel();
        }
      }, 2000);
    }
    // Auto-dismiss Jupiter/pump success panel after 2s — collapse widget
    if (ns.widgetSwapStatus === 'done-original') {
      setTimeout(() => {
        if (ns.widgetSwapStatus === 'done-original') {
          ns.widgetOriginalSigningInfo = null; ns.widgetOriginalTxSig = null;
          ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
          ns.pumpFunContext = null; ns.pumpFunErrorMsg = null; ns._pumpTxSigHandled = false;
          ns.lastOutputMint = null; ns.tokenScoreResult = null; ns._tokenScoreMint = null;
          ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
          const _w = document.getElementById('sr-widget');
          if (_w) { _w.classList.remove('expanded', 'alert'); const _bi = _w.querySelector('#sr-body-inner'); if (_bi) _bi.innerHTML = ''; }
          renderWidgetPanel();
        }
      }, 2000);
    }
    // Auto-dismiss skipped state after 2s — collapse widget back to compact pill
    if (ns.widgetSwapStatus === 'skipped') {
      setTimeout(() => {
        if (ns.widgetSwapStatus === 'skipped') {
          ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
          ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
          const _w = document.getElementById('sr-widget');
          if (_w) {
            _w.classList.remove('expanded', 'alert');
            const _bi = _w.querySelector('#sr-body-inner');
            if (_bi) _bi.innerHTML = '';
            savePillState(_w);
          }
          renderWidgetPanel();
        }
      }, 2000);
    }
    if (fetchCancelBtn) fetchCancelBtn.onclick = () => {
      // Release autoProtect pending promise so Jupiter's tx can proceed
      if (ns._autoProtectPending && ns.pendingDecisionResolve) {
        ns._autoProtectPending = false;
        ns.pendingDecisionResolve('confirm');
        ns.pendingDecisionResolve = null;
        ns.pendingDecisionPromise = null;
        ns.pendingTransaction     = null;
      }
      ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
      ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
      renderWidgetPanel();
    };
    const errorCancelBtn = bodyInner.querySelector('#sr-btn-widget-error-cancel');
    if (errorCancelBtn) errorCancelBtn.onclick = () => {
      ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
      ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
      renderWidgetPanel();
    };
    // Auto-dismiss wallet rejection errors after 2s — collapse widget back to compact pill
    if (ns.widgetSwapStatus === 'error' && ns.widgetSwapError === 'Transaction rejected in wallet') {
      setTimeout(() => {
        if (ns.widgetSwapStatus === 'error' && ns.widgetSwapError === 'Transaction rejected in wallet') {
          ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
          ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
          const _w = document.getElementById('sr-widget');
          if (_w) {
            _w.classList.remove('expanded', 'alert');
            const _bi = _w.querySelector('#sr-body-inner');
            if (_bi) _bi.innerHTML = '';
            savePillState(_w);
          }
          renderWidgetPanel();
        }
      }, 2000);
    }

    // Copy wallet address
    const srCopyBtn = bodyInner.querySelector('#sr-copy-wallet');
    if (srCopyBtn) {
      srCopyBtn.onclick = () => {
        try {
          if (fullWalletPubkey) navigator.clipboard.writeText(fullWalletPubkey);
          const fb = bodyInner.querySelector('#sr-copy-feedback');
          if (fb) { fb.style.display = 'inline'; setTimeout(() => { fb.style.display = 'none'; }, 1400); }
        } catch (e) {}
      };
    }

    // Swap tab token pickers
    const TOKENS = [
      { symbol:'SOL',  name:'Solana',    icon:'◎',  mint:'So11111111111111111111111111111111111111112',  decimals:9 },
      { symbol:'USDC', name:'USD Coin',  icon:'💵', mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals:6 },
      { symbol:'USDT', name:'Tether',    icon:'💲', mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals:6 },
      { symbol:'JUP',  name:'Jupiter',   icon:'🪐', mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals:6 },
      { symbol:'BONK', name:'Bonk',      icon:'🐶', mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals:5 },
      { symbol:'WIF',  name:'dogwifhat', icon:'🎩', mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals:6 },
      { symbol:'RAY',  name:'Raydium',   icon:'⚡', mint:'4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  decimals:6 },
    ];

    let tokenIn  = TOKENS.find(t => t.symbol === 'USDC') || TOKENS[1];
    let tokenOut = TOKENS.find(t => t.symbol === 'SOL')  || TOKENS[0];

    const selIn    = bodyInner.querySelector('#sr-sel-in');
    const selOut   = bodyInner.querySelector('#sr-sel-out');
    const pickerIn = bodyInner.querySelector('#sr-picker-in');
    const pickerOut = bodyInner.querySelector('#sr-picker-out');
    const amtInEl  = bodyInner.querySelector('#sr-amount-in');
    const amtOutEl = bodyInner.querySelector('#sr-amount-out');

    if (amtInEl) {
      amtInEl.value = '0.1';
      amtInEl.addEventListener('input', () => {
        ns.widgetLastOrder = null; ns.widgetSwapStatus = '';
        const st = bodyInner.querySelector('#sr-send-status'); if (st) st.textContent = '\u00A0';
      });
    }

    function updateTokenUI() {
      const tk = bodyInner.querySelector('#sr-ticker-in');
      const ot = bodyInner.querySelector('#sr-ticker-out');
      if (tk) tk.textContent = tokenIn.symbol;
      if (ot) ot.textContent = tokenOut.symbol;
    }

    function buildPickers() {
      if (pickerIn)  pickerIn.innerHTML  = TOKENS.map(t => `<div class="sr-pick-item" data-side="in"  data-sym="${t.symbol}" style="padding:6px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px"><div><div style="font-weight:700">${t.symbol}</div><div style="font-size:13px;color:#C2C2D4">${t.name}</div></div></div>`).join('');
      if (pickerOut) pickerOut.innerHTML = TOKENS.map(t => `<div class="sr-pick-item" data-side="out" data-sym="${t.symbol}" style="padding:6px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px"><div><div style="font-weight:700">${t.symbol}</div><div style="font-size:13px;color:#C2C2D4">${t.name}</div></div></div>`).join('');
      Array.from(bodyInner.querySelectorAll('.sr-pick-item')).forEach(item => {
        item.addEventListener('click', () => {
          const side = item.dataset.side;
          const tok  = TOKENS.find(t => t.symbol === item.dataset.sym);
          if (!tok) return;
          if (side === 'in') tokenIn = tok; else tokenOut = tok;
          updateTokenUI();
          if (pickerIn)  pickerIn.style.display  = 'none';
          if (pickerOut) pickerOut.style.display = 'none';
        });
      });
    }

    if (selIn)  selIn.onclick  = (e) => { if (pickerIn)  pickerIn.style.display  = pickerIn.style.display  === 'block' ? 'none' : 'block'; e.stopPropagation(); };
    if (selOut) selOut.onclick = (e) => { if (pickerOut) pickerOut.style.display = pickerOut.style.display === 'block' ? 'none' : 'block'; e.stopPropagation(); };
    document.addEventListener('click', () => { if (pickerIn) pickerIn.style.display = 'none'; if (pickerOut) pickerOut.style.display = 'none'; });

    updateTokenUI();
    buildPickers();

    const flipBtn = bodyInner.querySelector('#sr-btn-flip');
    if (flipBtn) flipBtn.onclick = () => { [tokenIn, tokenOut] = [tokenOut, tokenIn]; updateTokenUI(); };

    const sendBtn2 = bodyInner.querySelector('#sr-btn-send-quote');
    if (sendBtn2) {
      sendBtn2.onclick = async () => {
        try {
          const amount = parseFloat(amtInEl?.value || '0');
          if (!amount || amount <= 0) {
            const st = bodyInner.querySelector('#sr-send-status'); if (st) st.textContent = 'Enter an amount'; return;
          }
          const amountRaw = Math.round(amount * Math.pow(10, tokenIn.decimals));
          ns.widgetCapturedTrade = {
            inputMint:      tokenIn.mint,
            outputMint:     tokenOut.mint,
            inputDecimals:  tokenIn.decimals,
            outputDecimals: tokenOut.decimals,
            inputSymbol:    tokenIn.symbol,
            outputSymbol:   tokenOut.symbol,
            amountRaw:      amountRaw,
            amountRawStr:   String(amountRaw),
            walletPubkey:   ns.resolveWalletPubkey(),
            fromSwapTab:    true,
          };
          ns.widgetLastOrder = null; ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
          renderWidgetPanel();
          await ns.fetchWidgetQuote();
        } catch (e) {
          const st = bodyInner.querySelector('#sr-send-status'); if (st) st.textContent = 'Quote failed';
        }
      };
    }
  }

  // ── openZendIQPanel ──────────────────────────────────────────────────────
  function openZendIQPanel() {
    const widget = document.getElementById('sr-widget');
    if (!widget) return;
    widget.style.display = ''; // un-hide if user previously closed with X
    widget.classList.toggle('expanded');
    if (widget.classList.contains('expanded')) {
      if (ns.pendingTransaction) ns.widgetActiveTab = 'monitor';
      ns._fitBodyHeight(widget);
      renderWidgetPanel();
    }
  }

  // ── _fitBodyHeight — update --sr-body-mh CSS var based on widget position ──
  function _fitBodyHeight(widget) {
    if (!widget) return;
    const rect  = widget.getBoundingClientRect();
    const pill  = widget.querySelector('#sr-pill');
    const pillH = pill ? pill.offsetHeight : 44;
    const available = Math.max(180, window.innerHeight - rect.top - pillH - 16);
    widget.style.setProperty('--sr-body-mh', available + 'px');
  }

  // ── injectStatusIndicator ────────────────────────────────────────────────
  function injectStatusIndicator() {
    if (document.getElementById('sr-widget')) return;

    const style = document.createElement('style');
    style.textContent = `
      #sr-widget {
        position: fixed !important;
        top: 16px; right: 16px;
        z-index: 2147483647;
        width: 310px !important;
        min-width: 310px !important;
        max-width: 310px !important;
        box-sizing: border-box !important;
        font-family: 'DM Sans', -apple-system, sans-serif;
        animation: srWidgetIn 0.4s cubic-bezier(0.34,1.56,0.64,1) 0.8s both;
        transition: width 0.35s cubic-bezier(0.4,0,0.2,1),
                    min-width 0.35s cubic-bezier(0.4,0,0.2,1),
                    max-width 0.35s cubic-bezier(0.4,0,0.2,1);
        user-select: none;
      }
      #sr-widget *, #sr-widget *::before, #sr-widget *::after { box-sizing: border-box !important; }
      #sr-widget.expanded { width: 400px !important; min-width: 400px !important; max-width: 400px !important; }

      @keyframes srWidgetIn {
        from { opacity:0; transform: translateX(14px) scale(0.92); }
        to   { opacity:1; transform: translateX(0)    scale(1);    }
      }

      #sr-pill {
        display: flex; align-items: center; gap: 6px;
        background: rgba(18,18,30,0.92);
        border: 1px solid rgba(20,241,149,0.25);
        border-radius: 30px;
        padding: 7px 12px 7px 8px;
        backdrop-filter: blur(12px);
        box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 0 1px rgba(20,241,149,0.08);
        cursor: grab; user-select: none;
        transition: border-radius 0.3s, border-color 0.3s, background 0.3s, padding 0.3s;
        white-space: nowrap; overflow: hidden;
      }
      #sr-pill:active { cursor: grabbing; }
      #sr-widget.expanded #sr-pill {
        border-radius: 16px 16px 0 0;
        border-bottom-color: rgba(153,69,255,0.15);
        background: linear-gradient(135deg, rgba(153,69,255,0.14), rgba(20,241,149,0.07));
        cursor: grab;
      }
      #sr-pill-shield { width:20px; height:20px; flex-shrink:0; }

      #sr-pill-dot {
        width:6px; height:6px; border-radius:50%;
        background:#14F195; box-shadow:0 0 6px #14F195;
        animation:srDotPulse 2.4s ease-in-out infinite; flex-shrink:0;
        transition: background 0.3s, box-shadow 0.3s;
      }
      #sr-widget.alert #sr-pill-dot { background:#9945FF; box-shadow:0 0 8px #9945FF; }
      @keyframes srDotPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

      #sr-pill-label {
        font-size:14px; font-weight:600; color:#E8E8F0; flex:1; min-width:0;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        transition: opacity 0.2s, flex 0.3s, margin 0.3s;
      }
      #sr-pill-label span { color:#14F195; transition:color 0.2s; }
      #sr-widget.alert #sr-pill-label span { color:#FFB547; }
      #sr-pill-collapse {
        flex-shrink:0; background:none; border:none;
        color:#C2C2D4; font-size:13px; cursor:pointer; padding:0 0 0 2px;
        line-height:1; transition:color 0.15s;
      }
      #sr-pill-collapse:hover { color:#E8E8F0; }
      #sr-pill-collapse { display:none; }

      #sr-pill-toggle {
        flex-shrink:0; display:flex; align-items:center; justify-content:center;
        width:22px; height:22px; border-radius:50%;
        background:rgba(153,69,255,0.12); border:1px solid rgba(153,69,255,0.25);
        cursor:pointer; padding:0;
        transition: background 0.15s, border-color 0.15s;
      }
      #sr-pill-toggle:hover { background:rgba(153,69,255,0.22); border-color:rgba(153,69,255,0.5); }
      #sr-widget.expanded #sr-pill-toggle { background:rgba(100,100,120,0.12); border-color:rgba(255,255,255,0.1); }
      #sr-widget.expanded #sr-pill-toggle:hover { background:rgba(100,100,120,0.22); border-color:rgba(255,255,255,0.2); }
      #sr-pill-chevron {
        width:12px; height:12px;
        color:#9945FF;
        transition: transform 0.25s cubic-bezier(0.4,0,0.2,1), color 0.15s;
        pointer-events:none;
        display:block;
      }
      #sr-widget.expanded #sr-pill-chevron { transform: rotate(180deg); color:#C2C2D4; }

      #sr-pill-close {
        margin-left:auto; flex-shrink:0;
        background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);
        color:#C2C2D4; width:22px; height:22px; border-radius:50%;
        font-size:13px; cursor:pointer;
        display:flex; align-items:center; justify-content:center; line-height:1;
        transition:color 0.15s;
      }
      #sr-pill-close:hover { color:#E8E8F0; }

      #sr-body {
        max-height:0; overflow:hidden;
        transition: max-height 0.45s cubic-bezier(0.4,0,0.2,1), border-color 0.3s;
        background:#12121E;
        border:1px solid transparent; border-top:none;
        border-radius:0 0 16px 16px;
      }
      #sr-widget.expanded #sr-body {
        max-height: var(--sr-body-mh, calc(100vh - 80px));
        overflow: hidden;
        display: flex; flex-direction: column;
        border-color: rgba(153,69,255,0.25);
        box-shadow:0 12px 40px rgba(0,0,0,0.5);
      }
      #sr-body-inner { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; padding:0; }
      #sr-footer { flex-shrink:0; display:none; padding:6px 14px; border-top:1px solid rgba(255,255,255,0.06); background:#12121E; display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#6B6B8A; font-family:'DM Sans',sans-serif; border-radius:0 0 16px 16px; }
      #sr-widget.expanded #sr-footer { display:flex; }

      @keyframes srBlink { 0%,100%{opacity:1} 50%{opacity:0.25} }

      #sr-widget input[type=number] { -moz-appearance:textfield; }
      #sr-widget input[type=number]::-webkit-inner-spin-button,
      #sr-widget input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
    `;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.id = 'sr-widget';
    el.innerHTML = `
      <div id="sr-pill">
        <svg id="sr-pill-shield" viewBox="0 0 128 128" style="width:26px;height:26px;flex-shrink:0">
          <defs>
            <linearGradient id="zr_ring" x1="20%" y1="0%" x2="80%" y2="100%">
              <stop offset="0%" stop-color="#00e5ff"/>
              <stop offset="35%" stop-color="#5566ff"/>
              <stop offset="65%" stop-color="#9922ff"/>
              <stop offset="100%" stop-color="#cc44ff"/>
            </linearGradient>
            <linearGradient id="zr_iq" x1="0%" y1="0%" x2="40%" y2="100%">
              <stop offset="0%" stop-color="#aa44ff"/>
              <stop offset="100%" stop-color="#cc22ff"/>
            </linearGradient>
          </defs>
          <path d="M 64 15 C 91 14, 113 35, 113 63 C 113 90, 93 112, 65 113 C 37 114, 15 93, 15 65 C 15 39, 33 18, 57 15" fill="none" stroke="url(#zr_ring)" stroke-width="9" stroke-linecap="round"/>
          <text x="65" y="70" font-family="'Arial Black', Arial, sans-serif" font-weight="900" font-size="56" fill="url(#zr_iq)" text-anchor="middle" dominant-baseline="middle" letter-spacing="-2">IQ</text>
        </svg>
        <div id="sr-pill-dot"></div>
        <div id="sr-pill-label">ZendIQ <span id="sr-pill-status">Connecting...</span></div>
        <button id="sr-pill-toggle" title="Expand / Collapse ZendIQ">
          <svg id="sr-pill-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l4 4 4-4"/></svg>
        </button>
        <button id="sr-pill-close" title="Close widget">×</button>
      </div>
      <div id="sr-body"><div id="sr-body-inner"></div><div id="sr-footer"><span>v${ns.version} &middot; <span style="color:#9945FF;font-weight:600">Open Beta</span></span><span>Not financial advice &middot; use at own risk</span></div></div>`;

    document.body.appendChild(el);

    // Compensate for host-page CSS that shrinks our fixed widget (zoom, scale, etc.)
    // Measure actual rendered size vs declared CSS and counter-scale if needed.
    try {
      const _rect = el.getBoundingClientRect();
      const _expected = 310;
      if (_rect.width > 0 && Math.abs(_rect.width - _expected) > 5) {
        const _factor = _expected / _rect.width;
        el.style.zoom = String(_factor);
      }
    } catch (_) {}

    const pill = el.querySelector('#sr-pill');

    const openPanel = () => {
      openZendIQPanel();
      savePillState(el);
    };

    // Dedicated toggle button — primary expand/collapse target
    el.querySelector('#sr-pill-toggle').addEventListener('click', (e) => {
      if (_dragMoved) return;
      openPanel();
      e.stopPropagation();
    });

    // Clicking the logo or label also toggles (convenience)
    el.querySelector('#sr-pill-shield').addEventListener('click', (e) => {
      if (_dragMoved) return;
      openPanel();
      e.stopPropagation();
    });

    el.querySelector('#sr-pill-label').addEventListener('click', (e) => {
      if (_dragMoved) return;
      openPanel();
      e.stopPropagation();
    });

    el.querySelector('#sr-pill-close').onclick = (e) => {
      // Release any pending autoProtect intercept so Jupiter's tx can go through
      if (ns._autoProtectPending && ns.pendingDecisionResolve) {
        ns._autoProtectPending = false;
        ns.pendingDecisionResolve('confirm');
        ns.pendingDecisionResolve = null;
        ns.pendingDecisionPromise = null;
        ns.pendingTransaction     = null;
      }
      ns.widgetCapturedTrade = null; ns.widgetLastOrder = null;
      ns.widgetSwapStatus = ''; ns.widgetSwapError = '';
      el.classList.remove('expanded', 'alert');
      el.querySelector('#sr-body-inner').innerHTML = '';
      el.style.display = 'none';
      savePillState(el);
      e.stopPropagation();
    };

    // Recompute body height on window resize
    window.addEventListener('resize', () => {
      const w = document.getElementById('sr-widget');
      if (w?.classList.contains('expanded')) ns._fitBodyHeight(w);
    }, { passive: true });

    // Drag to reposition
    let dragging = false, startX, startY, startLeft, startTop, _dragMoved = false;

    pill.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging    = true;
      _dragMoved  = false;
      const rect  = el.getBoundingClientRect();
      el.style.right = 'auto';
      el.style.left  = rect.left + 'px';
      el.style.top   = rect.top  + 'px';
      startX    = e.clientX;
      startY    = e.clientY;
      startLeft = rect.left;
      startTop  = rect.top;
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Mark as a real drag once the pointer moves more than 6px
      if (!_dragMoved && Math.sqrt(dx * dx + dy * dy) > 6) _dragMoved = true;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  startLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop  + dy));
      el.style.left = newLeft + 'px';
      el.style.top  = newTop  + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      const widget = document.getElementById('sr-widget');
      if (widget?.classList.contains('expanded')) ns._fitBodyHeight(widget);
      savePillState(el);
      // Reset _dragMoved after a short delay so the click event that fires
      // immediately after mouseup can still read the flag before it clears.
      setTimeout(() => { _dragMoved = false; }, 50);
    });

    // Restore saved position, or auto-place + expand on first open
    const _savedState = (() => { try { return JSON.parse(localStorage.getItem('sr_pill_state') ?? 'null'); } catch { return null; } })();
    if (_savedState?.left != null) {
      // Returning user — restore last position
      el.style.right = 'auto';
      el.style.left  = _savedState.left + 'px';
      el.style.top   = _savedState.top  + 'px';
      if (el.classList.contains('expanded')) ns._fitBodyHeight(el);
    } else {
      // First open — wait for entrance animation then auto-expand and position
      // Position to the left of jup.ag's swap card, then auto-expand
      setTimeout(() => {
        const WIDGET_W = 320;
        const GAP      = 16;
        const TOP      = 72;

        // Find the swap card using concrete jup.ag landmarks:
        // The form container is the closest common ancestor of the token inputs.
        // We walk up from a button or input with known text rather than using
        // brittle class selectors that change between deploys.
        let cardLeft = null;
        try {
          // Strategy 1: find the "Enter an amount" / "Review order" button — it's
          // always inside the swap card and has no equivalent elsewhere on the page.
          const btns = Array.from(document.querySelectorAll('button'));
          const swapBtn = btns.find(b =>
            /enter.an.amount|review.order|connect.wallet|swap/i.test(b.textContent?.trim())
            && b.offsetParent !== null
          );
          if (swapBtn) {
            // Walk up to find the card container (first ancestor wider than 300px)
            let node = swapBtn.parentElement;
            while (node && node !== document.body) {
              const r = node.getBoundingClientRect();
              if (r.width > 300 && r.width < 800) { cardLeft = r.left; break; }
              node = node.parentElement;
            }
          }
          // Strategy 2: look for the swap sell/buy input fields
          if (cardLeft == null) {
            const input = document.querySelector('input[inputmode="decimal"], input[type="number"]');
            if (input) {
              let node = input.parentElement;
              while (node && node !== document.body) {
                const r = node.getBoundingClientRect();
                if (r.width > 300 && r.width < 800) { cardLeft = r.left; break; }
                node = node.parentElement;
              }
            }
          }
        } catch {}

        let leftPos;
        if (cardLeft != null && cardLeft > WIDGET_W + GAP * 2) {
          // Enough room to the left of the card
          leftPos = Math.round(cardLeft - WIDGET_W - GAP);
        } else if (cardLeft != null) {
          // Not enough room left — place to the right of the card
          leftPos = Math.round(cardLeft + (cardLeft > window.innerWidth / 2 ? -WIDGET_W - GAP : WIDGET_W + GAP + 430));
          leftPos = Math.min(leftPos, window.innerWidth - WIDGET_W - GAP);
        } else {
          // Fallback: top-right, standard widget position
          leftPos = window.innerWidth - WIDGET_W - GAP;
        }
        leftPos = Math.max(GAP, leftPos);

        el.style.right = 'auto';
        el.style.left  = leftPos + 'px';
        el.style.top   = TOP + 'px';

        // Use add (not toggle) so we never accidentally collapse an already-open risk overlay
        if (!el.classList.contains('expanded')) {
          el.classList.add('expanded');
          if (ns._fitBodyHeight) ns._fitBodyHeight(el);
          renderWidgetPanel();
        }
        savePillState(el);
      }, 1400);
    }
  }

  // ── savePillState ────────────────────────────────────────────────────────
  function savePillState(el) {
    try {
      const rect = el.getBoundingClientRect();
      localStorage.setItem('sr_pill_state', JSON.stringify({
        left: Math.round(rect.left),
        top:  Math.round(rect.top),
      }));
    } catch {}
  }

  // ── Export ───────────────────────────────────────────────────────────────
  Object.assign(ns, {
    updateWidgetStatus,
    ensureWidgetInjected,
    renderWidgetPanel,
    openZendIQPanel,
    injectStatusIndicator,
    savePillState,
    _fitBodyHeight,
  });
})();
