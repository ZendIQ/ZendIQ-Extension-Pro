/**
 * ZendIQ – overlay.js
 * Swap history, pending-transaction state, and decision resolution.
 */

(function () {
  'use strict';
  const ns = window.__zq;

  // ── Add a swap to history ────────────────────────────────────────────────
  function addSwapToHistory(swapInfo) {
    ns.recentSwaps.unshift({
      timestamp: new Date().toLocaleTimeString(),
      status:    swapInfo.decision,
      amount:    swapInfo.amount,
      slippage:  swapInfo.slippage,
      risk:      swapInfo.risk,
    });
    if (ns.recentSwaps.length > ns.MAX_SWAP_HISTORY) {
      ns.recentSwaps.pop();
    }
    try {
      // Forward to extension background so popup history is persisted and widget can sync
      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
        timestamp: Date.now(),
        optimized: false,
        amount: swapInfo.amount,
        slippage: swapInfo.slippage,
        risk: swapInfo.risk,
        decision: swapInfo.decision,
      } } }, '*');
    } catch (e) {}
  }

  // ── Threshold check helpers ──────────────────────────────────────────────
  const RISK_LEVELS = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

  async function loadThresholds() {
    // Thresholds are synced into ns on page load (via content_bridge) and whenever
    // the user changes settings in the popup. Fall back to permissive defaults so
    // all swaps show the widget until the user explicitly changes the thresholds.
    return {
      minRiskLevel: ns.threshMinRiskLevel ?? 'LOW',
      minLossUsd:   ns.threshMinLossUsd   ?? 0,
      minSlippage:  ns.threshMinSlippage  ?? 0,
    };
  }

  function passesTresholds(risk, thresholds) {
    if (!risk) return true; // no risk data — show widget
    const riskNum   = RISK_LEVELS[risk.level]              ?? 0;
    const minNum    = RISK_LEVELS[thresholds.minRiskLevel] ?? 0;
    const lossUsd   = risk.estimatedLoss;  // already in USD
    const slippage  = risk.swapSlippage ?? 0;

    if (riskNum  < minNum)                 return false;
    if (lossUsd  < thresholds.minLossUsd)  return false;
    if (slippage < thresholds.minSlippage) return false;
    return true;
  }

  // ── Show overlay and await decision ─────────────────────────────────────
  function showPendingTransaction(txInfo) {
    // If a decision is already in-flight (probe running or Review & Sign open),
    // return the same promise so the second caller (e.g. legacy wallet hook that
    // fires after the Wallet Standard hook) joins the existing flow instead of
    // starting a duplicate probe.  This fixes the ~5s double-probe delay where
    // `handleTransaction` called `showPendingTransaction` while `widgetSwapStatus`
    // was already 'ready' (not in _busyStates), causing a second full Raydium fetch.
    if (ns.pendingDecisionResolve) return ns.pendingDecisionPromise;

    ns.pendingDecisionPromise = new Promise(async (resolve) => {
      try {
      // State-based guard: suppress new intercepts while ZendIQ is actively
      // fetching, signing, or just completed a swap. This prevents Jupiter's
      // UI refresh / Swap button re-enable from triggering a second overlay
      // before the user has a chance to initiate a genuinely new trade.
      // 'signing-original' is included — the zendiqWsOverlay + handleTransaction
      // adapter-call try-catch blocks now reset widgetSwapStatus to '' on wallet
      // cancel, so users can retry cleanly without a page refresh.
      const _busyStates = ['fetching', 'signing', 'signing-original', 'sending', 'done', 'done-original',
        ...(ns._adapterBusyStates?.() ?? [])];
      if (_busyStates.includes(ns.widgetSwapStatus)) {
        // 'skip': ZendIQ is actively processing — caller should silently drop the incoming
        // tx rather than letting it through or showing a new overlay. This prevents
        // Raydium's immediate auto-retry (after the 'optimise' throw) from opening a
        // second wallet prompt on top of ZendIQ's in-flight signing.
        resolve('skip');
        ns.pendingDecisionPromise = null;
        return;
      }

      // Site adapters (e.g. pump.fun) handle their own complete swap detection flow.
      const _swapAdapter = ns.activeSiteAdapter?.();
      if (_swapAdapter?.onSwapDetected) return _swapAdapter.onSwapDetected(txInfo, resolve);

      const risk = ns.lastRiskResult;

      // Auto-optimise: when enabled, intercept every swap regardless of risk level
      // or protection profile. Keep the promise pending while fetchWidgetQuote runs;
      // it will resolve 'optimise' (savings found → ZendIQ signs) or 'confirm'
      // (no savings → Jupiter's original tx passes through untouched).
      // Auto-Profit profile ('balanced') uses the same deferred-decision path even
      // when the auto-optimise toggle is OFF — profitability is checked in
      // fetchWidgetQuote, not here. The only difference vs toggle-ON is that
      // autoAccept=false always shows Review & Sign before signing.
      const _useAutoProtectPath = ns.autoProtect || ns.settingsProfile === 'balanced';
      if (_useAutoProtectPath) {
        ns.pendingTransaction     = txInfo;
        ns.pendingDecisionResolve = resolve;
        ns.widgetCapturedTrade    = null;
        ns.widgetLastOrder        = null;
        ns.widgetSwapError        = '';
        ns._autoProtectPending    = true;
        // When autoAccept is on: run entirely in background — no spinner, no flash.
        // The widget opens only when there is a result to show:
        //   • signing (ZendIQ route, net positive)
        //   • signing-original (no net benefit / negative)
        //   • ready (Review & Sign — token risk pause, or autoAccept=OFF)
        // When autoAccept is off: show the fetching spinner immediately so the user
        // knows ZendIQ is working before the Review & Sign panel appears.
        if (!ns.autoAccept) {
          ns.widgetSwapStatus = 'fetching';
          const widget = document.getElementById('sr-widget');
          if (widget) {
            widget.style.display = '';
            if (!widget.classList.contains('expanded')) widget.classList.add('expanded');
            widget.classList.remove('compact');
            ns.widgetActiveTab = 'monitor';
            if (ns._fitBodyHeight) ns._fitBodyHeight(widget);
          }
        }
        // Fire handleOptimiseTrade after this microtask so the promise is fully set up
        Promise.resolve().then(() => ns.handleOptimiseTrade?.());
        return;
      }

      // Check user-configured thresholds before interrupting the swap
      const thresholds = await loadThresholds();
      if (!passesTresholds(risk, thresholds)) {
        resolve('confirm'); // silently allow — swap doesn't meet trigger criteria
        ns.pendingDecisionPromise = null; // clean up so future swaps don't see stale resolved promise
        return;
      }

      ns.pendingTransaction     = txInfo;
      ns.pendingDecisionResolve = resolve;

      // Clear any stale optimise-flow state from a previous interception so
      // old errors and quotes don't bleed into the new risk overlay.
      ns.widgetCapturedTrade = null;
      ns.widgetLastOrder     = null;
      // Pre-set 'fetching' so the widget opens with the minimal loading card instead
      // of flashing the full Monitor (Bot Attack Risk, Token Score, savings) before
      // the proactive probe completes and Review & Sign takes over (~1s).
      ns.widgetSwapStatus    = 'fetching';
      ns.widgetSwapError     = '';

      const widget = document.getElementById('sr-widget');
      if (widget) {
        widget.style.display = '';
        widget.classList.add('alert', 'expanded');
        widget.classList.remove('compact');
        ns.widgetActiveTab = 'monitor';
        if (ns._fitBodyHeight) ns._fitBodyHeight(widget);
        ns.renderWidgetPanel();
      }
      // Proactive background fetch: build widgetCapturedTrade and silently fetch a
      // ZendIQ quote so the savings card shows real data before the user clicks anything.
      // noAutoAccept=true — pending decision stays unresolved; user still chooses.
      Promise.resolve().then(() => ns.handleOptimiseTrade?.(true));
      } catch (err) {
        console.error('[ZendIQ] showPendingTransaction internal error, allowing swap through:', err);
        resolve('confirm');
      }
    });
    return ns.pendingDecisionPromise;
  }

  // ── Resolve a pending decision ───────────────────────────────────────────
  function handlePendingDecision(decision) {
    if (ns.pendingDecisionResolve) {
      const result = decision === 'block' ? 'cancel'
                   : decision === 'optimise' ? 'optimise'
                   : 'confirm';
      // Stash risk data before clearing — page-network.js /execute interceptor
      // reads this snapshot when __zendiq_ws_confirmed fires on the confirm path.
      if (result === 'confirm') {
        ns._confirmRiskSnapshot = ns.lastRiskResult ?? null;
      }
      // Save a snapshot so Monitor can show "signing-original" state while the
      // user's wallet prompt is open for Jupiter's unoptimised transaction.
      if (result === 'confirm') {
        const ct = ns.widgetCapturedTrade;
        const lq = ns.jupiterLiveQuote;
        if (ct || lq) {
          ns.widgetOriginalSigningInfo = {
            inputMint:      ct?.inputMint    ?? lq?.inputMint    ?? null,
            outputMint:     ct?.outputMint   ?? lq?.outputMint   ?? null,
            inputSymbol:    ct?.inputSymbol  ?? null,
            outputSymbol:   ct?.outputSymbol ?? null,
            inputDecimals:  ct?.inputDecimals  ?? null,
            outputDecimals: ct?.outputDecimals ?? null,
            inAmt:        ct?.amountUI ?? null,
            inAmountRaw:  lq?.inAmount  ?? null,  // raw units — widget computes UI amt if inAmt is null
            riskScore: ns.lastRiskResult?.score ?? ct?.riskScore ?? null,
            riskLevel: ns.lastRiskResult?.level ?? null,
          };
        } else {
          ns.widgetOriginalSigningInfo = null;
        }
      }
      // For 'optimise': set cooldown before resolving — Jupiter fires a retry of
      // signTransaction the instant it receives the rejection throw from zendiqWsOverlay,
      // before signWidgetSwap has had a chance to set window.__zendiq_own_tx.
      if (result === 'optimise') ns._signCooldownUntil = Date.now() + 6000;
      ns.pendingDecisionResolve(result);
      ns.pendingTransaction     = null;
      ns.pendingDecisionResolve = null;
      ns.pendingDecisionPromise = null;
      ns.lastRiskResult         = null;
      ns._skipConfirmPending    = false;

      const widget = document.getElementById('sr-widget');
      if (widget) {
        widget.classList.remove('alert');
        const status = widget.querySelector('#sr-pill-status');
        if (status) { status.textContent = 'Ready'; status.style.color = ''; }
        // If confirm: show signing-original immediately (before zendiqWsOverlay microtask resumes)
        // so Monitor never flashes back to idle between click and wallet opening.
        if (result === 'confirm' && ns.widgetOriginalSigningInfo) {
          ns.widgetSwapStatus = 'signing-original';
          ns.widgetActiveTab  = 'monitor';
        }
        ns.renderWidgetPanel();
      }
    }
  }

  // ── showOverlay — legacy helper, delegates to renderWidgetPanel ──────────
  function showOverlay(txInfo, context, risk) {
    ns.pendingDecisionPromise = new Promise(resolve => {
      ns.lastRiskResult     = risk;
      ns.pendingTransaction = txInfo;
      ns.pendingDecisionResolve = resolve;
      ns.widgetActiveTab = 'monitor';

      ns.widgetCapturedTrade = null;
      ns.widgetLastOrder     = null;
      ns.widgetSwapStatus    = '';
      ns.widgetSwapError     = '';

      const w = document.getElementById('sr-widget');
      if (!w) { resolve('skip'); return; }

      const levelColor = ({CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'})[risk.level] ?? '#14F195';
      const status = w.querySelector('#sr-pill-status');
      if (status) { status.textContent = risk.level + ' Risk'; status.style.color = levelColor; }
      w.style.display = '';
      w.classList.add('expanded', 'alert');
      ns.renderWidgetPanel();
    });
    return ns.pendingDecisionPromise;
  }

  // ── Export ───────────────────────────────────────────────────────────────
  Object.assign(ns, {
    addSwapToHistory,
    showPendingTransaction,
    handlePendingDecision,
    showOverlay,
  });
})();
