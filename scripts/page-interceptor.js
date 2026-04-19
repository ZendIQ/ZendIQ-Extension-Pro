/**
 * ZendIQ – interceptor.js  (thin orchestrator)
 * Runs in MAIN world.  All heavy logic lives in the other modules.
 * Load order: config → utils → decoders → risk → wallet → overlay → widget → trade → network → this
 */

(function () {
  'use strict';
  const ns = window.__zq;

  // ── Swap button click interceptor ────────────────────────────────────────
  // Intercepts the Swap button in capture phase BEFORE React's handler.
  // stopImmediatePropagation() (synchronous) prevents React ever seeing it.
  // After the user confirms we re-fire btn.click() bypassing our own guard.
  // ── Site adapter page init (URL mint extraction, token scoring head-start, etc.) ──
  ns.activeSiteAdapter?.()?.initPage?.();

  window.__zendiq_swap_bypass = false;
  document.addEventListener('click', async (e) => {
    if (window.__zendiq_swap_bypass) return;
    try {
      if (e.target && e.target.closest && e.target.closest('#sr-widget')) return;
    } catch (_) {}
    const btn = e.target?.closest('button, [role="button"]');
    if (!btn) return;
    if (btn.getAttribute('role') === 'tab' || btn.closest('[role="tablist"]')) return;
    const txt = btn.textContent?.trim().replace(/\s+/g, ' ');
    const _isPumpFun = window.location.hostname.includes('pump.fun');
    // Pump.fun: "Buy <TokenName>" (requires name after Buy — bare "Buy" tab is excluded)
    // or "Place Trade", only when a mint is already known from URL or API sniffing.
    const _isPumpBuy = _isPumpFun && !!ns.lastOutputMint
      && /^(buy\s+\S.*|place\s+trade)$/i.test(txt) && txt.length <= 40;
    const _btnMatch = /^(confirm\s+)?swap$/i.test(txt) || _isPumpBuy;
    if (_btnMatch) {
      e.stopImmediatePropagation();
      e.preventDefault();
      try {
        const p = window.__zendiq_last_order_params;
        const STABLES = {
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,
        };
        const inDec = p?.inputMint ? (STABLES[p.inputMint] ?? 9) : 9;
        const inAmount = p?.amount ? Number(p.amount) / Math.pow(10, inDec) : 0;
        const isStable = p?.inputMint && !!STABLES[p.inputMint];
        // Derive token price from already-available in-memory data.
        // jupiterLiveQuote.inUsdValue is set on every ~1s Jupiter tick — most accurate.
        // widgetLastPriceData.inputPriceUsd is set when ZendIQ fetches its own order.
        let tokenPriceUsd = 1;
        if (isStable) {
          tokenPriceUsd = 1;
        } else {
          const _lq = ns.jupiterLiveQuote;
          if (_lq?.inUsdValue != null && _lq?.inputMint === p?.inputMint && _lq?.inAmount != null) {
            const _lqInAmt = Number(_lq.inAmount) / Math.pow(10, inDec);
            if (_lqInAmt > 0) tokenPriceUsd = _lq.inUsdValue / _lqInAmt;
          } else {
            tokenPriceUsd = ns.widgetLastPriceData?.inputPriceUsd ?? 1;
          }
        }
        const inAmountUsd = inAmount * tokenPriceUsd;
        const slippagePct = p?.slippageBps != null ? Number(p.slippageBps) / 100 : 0.5;
        const TOKEN_SYMBOLS = {
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
          'So11111111111111111111111111111111111111112':  'SOL',
        };
        const inputSymbol = p?.inputMint ? (TOKEN_SYMBOLS[p.inputMint] ?? p.inputMint.slice(0,4)+'…') : 'tokens';
        const txInfo = {
          accountCount: 3,
          swapInfo: {
            inAmount,
            inAmountUsd,
            tokenPriceUsd,
            inputMint:       p?.inputMint  ?? null,
            outputMint:      p?.outputMint ?? null,
            inputSymbol,
            slippagePercent: slippagePct,
            source: 'jupiter',
          },
        };
        const context = await ns.fetchDevnetContext(txInfo).catch(() => ({ congestion: 'low' }));
        const risk = await ns.calculateRisk(txInfo, context);
        try {
          if (typeof ns.calculateMEVRisk === 'function') {
            const mevRisk = ns.calculateMEVRisk({
              inputMint:    p?.inputMint  ?? null,
              outputMint:   p?.outputMint ?? null,
              amountUSD:    inAmountUsd,
              routePlan:    ns.jupiterLiveQuote?.routePlan ?? null,
              slippage:     slippagePct / 100,
              poolLiquidity: null,
              routeType:    ns.mevRouteType?.(ns.jupiterLiveQuote),
            });
            if (mevRisk) {
              risk.mev = mevRisk;
              if (mevRisk.riskScore > risk.score) {
                risk.score = Math.round((risk.score + mevRisk.riskScore) / 2);
                risk.level = risk.score >= 70 ? 'CRITICAL' : risk.score >= 40 ? 'HIGH' : risk.score >= 20 ? 'MEDIUM' : 'LOW';
              }
            }
          }
        } catch (mevErr) {
          console.error('[ZendIQ] MEV calc failed (click path):', mevErr?.message);
        }
        ns.lastRiskResult = risk;
        // Token Score: ensure a fresh fetch is in-flight for the output token
        // (may already be cached / in-progress from live-tick trigger in page-network.js)
        if (p?.outputMint && ns.fetchTokenScore && p.outputMint !== ns._tokenScoreMint) {
          ns._tokenScoreMint  = p.outputMint;
          ns.tokenScoreResult = null;
          ns.fetchTokenScore(p.outputMint, null);
        }
        const overlayInfo = { method: 'Jupiter Swap', params: [], orderParams: p, risk };
        const decision = await ns.showPendingTransaction(overlayInfo);
        if (decision === 'confirm') {
          window.__zendiq_ws_confirmed = true;
          window.__zendiq_swap_bypass = true;
          // Re-query the button fresh — React may have re-rendered the DOM while the
          // ZendIQ overlay was open, making the original `btn` reference a detached node
          // whose `.click()` dispatches into the void (never reaches React's root handler).
          // Use EXACT original text match — the broad regex was matching pump.fun's app-
          // download / upsell buttons ("Buy on App", etc.) causing navigation to app.pump.fun.
          const _freshBtn = _isPumpBuy
            ? (document.body.contains(btn) ? btn
              : Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
                  const t = b.textContent?.trim().replace(/\s+/g, ' ') ?? '';
                  return t === txt;
                }) ?? btn)
            : btn;
          _freshBtn.click();
          window.__zendiq_swap_bypass = false;
        } else if (decision === 'optimise') {
          // widget handles the optimised route — do nothing
        }
        // 'cancel': do nothing
      } catch (err) {
        console.error('[ZendIQ] Swap click overlay error — failing open:', err?.message);
        window.__zendiq_swap_bypass = true;
        btn.click();
        window.__zendiq_swap_bypass = false;
      }
    }
  }, { capture: true });

  // ── Load persisted settings at startup via content_bridge ─────────────
  // MAIN world can't call chrome.storage directly — request via postMessage;
  // content_bridge.js reads storage and posts the result back.
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'ZENDIQ_SETTINGS_RESPONSE') {
      const s = e.data.settings ?? {};
      ns.threshMinRiskLevel = s.minRiskLevel ?? 'LOW';
      ns.threshMinLossUsd   = s.minLossUsd   ?? 0;
      ns.threshMinSlippage  = s.minSlippage  ?? 0;
      ns.widgetMode         = s.uiMode       ?? 'simple';
      ns.autoProtect        = s.autoProtect  ?? false;
      ns.autoAccept         = s.autoAccept   ?? false;
      ns.pauseOnHighRisk    = s.pauseOnHighRisk !== false; // default true
      ns.jitoMode           = s.jitoMode     ?? 'auto';
      ns.settingsProfile    = s.profile      ?? 'alert';
    }
    // Reviewed-state for wallet security — loaded after scan completes via bridge
    if (e.data?.type === 'ZENDIQ_SEC_REVIEWED_RESPONSE') {
      if (typeof e.data.value === 'boolean') {
        ns.walletReviewedAutoApprove = e.data.value;
        try { ns.renderWidgetPanel?.(); } catch (_) {}
      }
    }
    // Persisted scan result loaded on page start — restores widget wallet tab without re-scan
    if (e.data?.type === 'ZENDIQ_SEC_RESULT_RESPONSE') {
      if (e.data.result && !ns.walletSecurityChecking) {
        ns.walletSecurityResult     = e.data.result;
        ns.walletReviewedAutoApprove = !!e.data.reviewed;
        try { ns.renderWidgetPanel?.(); } catch (_) {}
      }
    }
    if (e.data?.type === 'ZENDIQ_ONBOARDED_RESPONSE') {
      ns.onboarded = !!e.data.value;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      // Auto-expand so the welcome card is visible immediately on first install.
      // Retry until the widget DOM exists — it may still be injecting if body
      // wasn't ready when page-widget.js first ran.
      if (!e.data.value) {
        const _tryExpand = () => {
          try {
            const _w = document.getElementById('sr-widget');
            if (_w) {
              if (!_w.classList.contains('expanded')) {
                _w.style.display = '';
                _w.classList.add('expanded');
                if (ns._fitBodyHeight) ns._fitBodyHeight(_w);
                try { ns.renderWidgetPanel?.(); } catch (_) {}
              }
            } else {
              setTimeout(_tryExpand, 100);
            }
          } catch (_) {}
        };
        _tryExpand();
      }
    }
  });
  window.postMessage({ type: 'ZENDIQ_GET_SETTINGS' }, '*');
  // Ask background for persisted swap history so the widget Activity tab is populated on page load
  window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'GET_HISTORY' } }, '*');
  // Load prior wallet security scan (shared with popup — same secLastResult key)
  window.postMessage({ type: 'ZENDIQ_GET_SEC_RESULT' }, '*');
  // Load onboarded flag so widget welcome card shows/hides correctly
  window.postMessage({ type: 'ZENDIQ_GET_ONBOARDED' }, '*');

  // ── Listen for history updates forwarded from background (bridge)
  window.addEventListener('message', (e) => {
    try {
      if (!e.data) return;
      // Bridge posts messages as { sr_bridge: true, msg }
      if (e.data.sr_bridge && e.data.msg) {
        const { type, payload } = e.data.msg;

        // Full history on page init — populate ns.recentSwaps; page-widget.js listener
        // handles the DOM update directly, so no renderWidgetPanel() here (would loop).
        if (type === 'HISTORY_RESPONSE') {
          if (!Array.isArray(payload) || !payload.length) return;
          ns.recentSwaps = payload.slice(0, ns.MAX_SWAP_HISTORY ?? 20);
          return;
        }

        // Live update — spread the full payload so widget has all fields.
        // page-widget.js bridge listener handles the DOM update directly.
        if (type === 'HISTORY_UPDATE') {
          if (!payload) return;
          try {
            ns.recentSwaps = ns.recentSwaps || [];
            const sig = payload.signature ?? null;
            const existing = sig ? ns.recentSwaps.findIndex(h => h.signature === sig) : -1;
            if (existing >= 0) {
              ns.recentSwaps[existing] = Object.assign({}, ns.recentSwaps[existing], payload);
            } else {
              ns.recentSwaps.unshift(Object.assign({}, payload));
              if (ns.recentSwaps.length > (ns.MAX_SWAP_HISTORY ?? 20)) ns.recentSwaps.pop();
            }
          } catch (err) { console.warn('[ZendIQ] failed to apply history update', err); }
        }
      }
    } catch (err) {}
  });

  // ── Kick-off wallet detection ────────────────────────────────────────────
  ns.detectAndHookWallet();
  setTimeout(() => ns.scheduleWsProbe(), 0);

  // Run a few quick scans for globally registered wallets then stop
  const _scanInterval = setInterval(() => ns.scanAndWrapGlobalWallets(), 250);
  setTimeout(() => clearInterval(_scanInterval), 5000);

  // ── Ensure widget is in the DOM ──────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ns.ensureWidgetInjected);
  } else {
    ns.ensureWidgetInjected();
  }

})();
