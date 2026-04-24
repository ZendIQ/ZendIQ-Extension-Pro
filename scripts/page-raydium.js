/**
 * ZendIQ – page-raydium.js
 * Raydium site adapter.
 * Registers with ns.registerSiteAdapter() so raydium.io swaps are intercepted and
 * compared against Jupiter Ultra routes. No onSwapDetected — falls through to the
 * shared jup.ag optimisation flow (page-approval.js → handleOptimiseTrade).
 * Must load in MAIN world BEFORE page-interceptor.js.
 */

(function () {
  'use strict';
  const ns = window.__zq;
  if (!ns?.registerSiteAdapter) return;

  // ── Deserialise first arg to VersionedTransaction ────────────────────────
  function _toVTx(arg) {
    let VTx = null;
    for (const k of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
      if (window[k]?.VersionedTransaction) { VTx = window[k].VersionedTransaction; break; }
    }
    if (!VTx) {
      for (const v of Object.values(window)) {
        if (v && typeof v === 'object' &&
            typeof v.VersionedTransaction?.deserialize === 'function') {
          VTx = v.VersionedTransaction; break;
        }
      }
    }
    if (!VTx) return null;
    try {
      if (arg && typeof arg === 'object' && arg.message) return arg; // already a VTx-like
      // Wallet Standard single input: { account, transaction: Uint8Array, chain }
      if (arg?.transaction instanceof Uint8Array) return VTx.deserialize(arg.transaction);
      // Wallet Standard array input: [{ account, transaction: Uint8Array }, ...]
      if (Array.isArray(arg) && arg[0]?.transaction instanceof Uint8Array) return VTx.deserialize(arg[0].transaction);
      // Wallet Standard array of byte arrays: [[{account, transaction: Uint8Array}], ...]
      if (Array.isArray(arg) && Array.isArray(arg[0]) && arg[0][0]?.transaction instanceof Uint8Array) return VTx.deserialize(arg[0][0].transaction);
      const buf = arg instanceof Uint8Array ? arg
        : (Array.isArray(arg) ? new Uint8Array(arg)
        : (arg?.data ? new Uint8Array(arg.data) : null));
      return buf ? VTx.deserialize(buf) : null;
    } catch (_) { return null; }
  }

  // ── Adapter ──────────────────────────────────────────────────────────────
  ns.registerSiteAdapter({
    name: 'raydium',

    matches() {
      return window.location.hostname.includes('raydium.io');
    },

    // Raydium uses Jupiter-style flow states — no custom busy states needed.
    busyStates: [],

    // ── URL parsing: read inputMint/outputMint from search params ───────────
    initPage() {
      const _readUrlParams = () => {
        try {
          const p    = new URLSearchParams(window.location.search);
          const inM  = p.get('inputMint');
          const outM = p.get('outputMint');
          if (inM && inM.length >= 32) {
            window.__zendiq_last_order_params = window.__zendiq_last_order_params ?? {};
            window.__zendiq_last_order_params.inputMint = inM;
          }
          if (outM && outM.length >= 32) {
            window.__zendiq_last_order_params = window.__zendiq_last_order_params ?? {};
            const _prev = window.__zendiq_last_order_params.outputMint;
            window.__zendiq_last_order_params.outputMint = outM;
            // Trigger token score re-fetch when output mint changes
            if (ns.fetchTokenScore && outM !== ns._tokenScoreMint) {
              ns._tokenScoreMint  = outM;
              ns.tokenScoreResult = null;
              Promise.resolve().then(() => ns.fetchTokenScore(outM, null));
            }
            // If the output mint changed mid-session, clear stale trade context
            if (_prev && _prev !== outM) {
              ns.widgetCapturedTrade  = null;
              ns.widgetLastOrder      = null;
              ns._rdmSwapAttempted    = false; // reset so Token Risk hides until next Swap click
            }
          }
        } catch (_) {}
      };
      _readUrlParams();
      // SPA listener: Raydium updates the URL without a page reload when the user
      // switches tokens. Re-read mints on every history navigation and on a 250ms
      // poll to catch hash/query mutations that don't fire popstate.
      let _lastHref = window.location.href;
      try {
        window.addEventListener('popstate', _readUrlParams);
      } catch (_) {}
      setInterval(() => {
        const _cur = window.location.href;
        if (_cur !== _lastHref) { _lastHref = _cur; _readUrlParams(); }
      }, 250);
    },

    // ── Network hook: parse Raydium compute URL for early mint + amount extraction ─
    // Raydium's UI calls /compute/swap-base-in?inputMint=...&outputMint=...&amount=...
    // before touching the wallet. Tapping this gives us reliable params even when the
    // tx decoder fails (CLMM/CPMM pools that don't match AMM discriminators).
    onNetworkRequest(url, _parsed) {
      if (!url || !url.includes('raydium.io') || !url.includes('/compute/')) return;
      // New swap being set up — restore the Raydium-specific idle monitor content
      ns._rdmPostSwapIdle = false;
      try {
        const u    = new URL(url);
        const inM  = u.searchParams.get('inputMint');
        const outM = u.searchParams.get('outputMint');
        const amt  = u.searchParams.get('amount');
        const slip = u.searchParams.get('slippageBps');
        if (!inM && !outM && !amt) return;
        window.__zendiq_last_order_params = window.__zendiq_last_order_params ?? {};
        if (inM  && inM.length  >= 32) window.__zendiq_last_order_params.inputMint  = inM;
        if (outM && outM.length >= 32) window.__zendiq_last_order_params.outputMint = outM;
        if (amt)                       window.__zendiq_last_order_params.amount       = amt;
        if (slip)                      window.__zendiq_last_order_params.slippageBps  = slip;
        // Trigger proactive token score when the output mint changes
        if (outM && outM.length >= 32 && outM !== ns._tokenScoreMint && ns.fetchTokenScore) {
          ns._tokenScoreMint  = outM;
          ns.tokenScoreResult = null;
          Promise.resolve().then(() => ns.fetchTokenScore(outM, null));
        }
      } catch (_) {}
    },

    // ── Wallet hook: extract swap amounts from the serialised tx ────────────
    onWalletArgs(args) {
      try {
        ns._rdmSwapAttempted = true; // user clicked Swap — enable Token Risk display
        const vtx = _toVTx(args?.[0]);
        if (!vtx) return;
        const txInfo = ns.extractTxInfo?.(vtx);

        // If the decoder identifies this as a Raydium swap, extract amounts.
        if (txInfo?.swapInfo?.source === 'raydium') {
          const { inAmount, minimumAmountOut } = txInfo.swapInfo;
          // Prefer the value already set by onNetworkRequest (from the compute URL) since it
          // arrives before the wallet fires and is always accurate.
          if (inAmount != null) {
            window.__zendiq_last_order_params = window.__zendiq_last_order_params ?? {};
            if (!window.__zendiq_last_order_params.amount) {
              window.__zendiq_last_order_params.amount = String(inAmount);
            }
          }
          // Store minimumAmountOut for emergency fallback — page-trade.js will override
          // widgetBaselineRawOut with the real compute outAmount once the quote arrives.
          ns._rdmMinAmountOut = minimumAmountOut ?? null;
        }
        // If the decoder couldn't identify the instruction (unknown pool), the amount may
        // already be in __zendiq_last_order_params from onNetworkRequest — that's fine.
        // Ensure inputMint/outputMint are populated from URL params in either case.
        const _p = window.__zendiq_last_order_params;
        if (_p && (!_p.inputMint || !_p.outputMint)) {
          // initPage() handles this; nothing extra to do here
        }
      } catch (_) {}
    },

    // ── No onSwapDetected: falls through to shared jup.ag approval flow ─────
    // ── onDecision: handle 'confirm' (Proceed anyway) on raydium.io ─────────────
    // Jupiter flow handles 'optimise'; only 'confirm' (Proceed anyway) needs special
    // treatment here — we must sign the original Raydium tx, then save the trade to
    // Activity via HISTORY_UPDATE (there is no /execute endpoint for Raydium txs).
    async onDecision(decision, origFn, args) {
      if (decision !== 'confirm') return undefined; // let caller handle optimise/cancel
      try {
        const _ct  = ns.widgetCapturedTrade;
        const _inMint  = _ct?.inputMint  ?? window.__zendiq_last_order_params?.inputMint  ?? null;
        const _outMint = _ct?.outputMint ?? window.__zendiq_last_order_params?.outputMint ?? null;
        const _outDec  = _ct?.outputDecimals ?? 6;
        const _inDec   = _ct?.inputDecimals  ?? 9;
        const _risk    = ns.lastRiskResult ?? null;
        // Sign and broadcast the original Raydium tx
        const res = await origFn(...args);
        // Extract signature — Wallet Standard signTransaction returns [{ signedTransaction: Uint8Array }]
        // but Raydium may pass a nested format [[{...}]] so unwrap up to 2 levels.
        let _sig = null;
        try {
          // Unwrap up to 2 levels of array nesting
          let _r = res;
          if (Array.isArray(_r) && Array.isArray(_r[0])) _r = _r[0]; // [[{...}]] → [{...}]
          const _item = Array.isArray(_r) ? _r[0] : _r;
          // 1. signedTransaction bytes (signTransaction result) → extract fee-payer sig from bytes[1..65]
          let _txBytes = _item?.signedTransaction ?? _item?.transaction ?? null;
          if (!_txBytes && _item instanceof Uint8Array) _txBytes = _item;
          if (!_txBytes && ArrayBuffer.isView(_item)) _txBytes = new Uint8Array(_item.buffer, _item.byteOffset, _item.byteLength);
          if (_txBytes && !(_txBytes instanceof Uint8Array)) {
            if (ArrayBuffer.isView(_txBytes)) _txBytes = new Uint8Array(_txBytes.buffer, _txBytes.byteOffset, _txBytes.byteLength);
            else if (typeof _txBytes === 'object') { const _len = _txBytes.length ?? Object.keys(_txBytes).length; const _a = new Uint8Array(_len); for (let _i = 0; _i < _len; _i++) _a[_i] = _txBytes[_i] ?? _txBytes[String(_i)] ?? 0; _txBytes = _a; }
          }
          if (_txBytes instanceof Uint8Array && _txBytes.length > 65 && _txBytes[0] >= 1 && _txBytes[0] <= 8) {
            _sig = ns.b58Encode(_txBytes.slice(1, 65));
          }
          // 2. signAndSendTransaction fallback: .signature field
          if (!_sig) {
            const _raw = _item?.signature ?? null;
            if      (typeof _raw === 'string')    _sig = _raw;
            else if (_raw instanceof Uint8Array)  _sig = ns.b58Encode(_raw);
            else if (_raw && typeof _raw === 'object') {
              const _bytes = new Uint8Array(Object.keys(_raw).length);
              for (const k of Object.keys(_raw)) _bytes[+k] = _raw[k];
              _sig = ns.b58Encode(_bytes);
            }
          }
        } catch (_) {}
        // Record to Activity
        if (_sig) {
          const _inAmt  = _ct?.amountUI ?? null;
          // Prefer the Raydium compute API output (stored by fetchWidgetQuote as _computeOutAmount)
          // over the tx minimum-amount-out (slippage floor). _rdmSignParams is only set when Raydium
          // wins the comparison; when Jupiter wins, fall back to _rdmLastComputeOut (always stored
          // after any successful compute fetch) then to _rdmMinAmountOut (slippage floor from tx bytes).
          const _rdmRawOut = ns._rdmSignParams?._computeOutAmount
            ?? (ns._rdmLastComputeOut != null ? Number(ns._rdmLastComputeOut) : null)
            ?? (ns._rdmMinAmountOut  != null ? Number(ns._rdmMinAmountOut)  : null);
          const _outAmt = _rdmRawOut != null ? _rdmRawOut / Math.pow(10, _outDec) : null;
          const entry = {
            signature:    _sig,
            tokenIn:      _ct?.inputSymbol  ?? '?',
            tokenOut:     _ct?.outputSymbol ?? '?',
            amountIn:     _inAmt  != null ? String(_inAmt)  : null,
            amountOut:    _outAmt != null ? String(_outAmt) : null,
            quotedOut:    _outAmt != null ? String(_outAmt) : null,
            optimized:    false,
            timestamp:    Date.now(),
            inputMint:    _inMint,
            outputMint:   _outMint,
            outputDecimals: _outDec,
            rawOutAmount: _rdmRawOut != null ? String(Math.round(_rdmRawOut)) : null,
            swapType:     'amm',
            riskScore:    _risk?.score  ?? null,
            riskLevel:    _risk?.level  ?? null,
            riskFactors:  _risk?.factors      ?? [],
            mevFactors:   _risk?.mev?.factors ?? [],
            mevRiskLevel: _risk?.mev?.riskLevel ?? null,
            mevRiskScore: _risk?.mev?.riskScore ?? null,
            mevEstimatedLossPercent: _risk?.mev?.estimatedLossPercentage ?? null,
            sandwichResult: null,  // populated via async HISTORY_UPDATE below
          };
          try {
            window.postMessage({ sr_bridge_to_ext: true,
              msg: { type: 'HISTORY_UPDATE', payload: entry } }, '*');
          } catch (_) {}
          // Transition widget to done-original success state — mirrors Jupiter /execute flow.
          // Must happen before clearing widgetCapturedTrade so the card can read pair info.
          ns.widgetOriginalTxSig      = _sig;
          ns.widgetOriginalSigningInfo = {
            inputSymbol:   _ct?.inputSymbol  ?? '?',
            outputSymbol:  _ct?.outputSymbol ?? '?',
            inputMint:     _inMint,
            outputMint:    _outMint,
            inputDecimals: _inDec,
            outputDecimals: _outDec,
            inAmt:         _ct?.amountUI ?? null,
          };
          ns.widgetSwapStatus   = 'done-original';
          ns.widgetLastTxSig    = _sig;
          // Raydium uses send-tx (not /execute), so page-network.js never clears this flag.
          // Must clear here so the next Raydium swap is intercepted normally.
          window.__zendiq_ws_confirmed = false;
          if (ns._quoteRefreshTimer) { clearInterval(ns._quoteRefreshTimer); ns._quoteRefreshTimer = null; }
          ns.widgetCapturedTrade = null;
          ns.widgetLastOrder     = null;
          ns.pendingDecisionResolve = null;
          ns.pendingDecisionPromise = null;
          ns.renderWidgetPanel?.();
          // Auto-dismiss after 2s back to idle monitor
          setTimeout(() => {
            if (ns.widgetSwapStatus === 'done-original') {
              ns.widgetSwapStatus = '';
              const _bi = document.getElementById('sr-body-inner');
              if (_bi) _bi.innerHTML = '';
              ns.renderWidgetPanel?.();
            }
          }, 2000);
          // Switch to post-swap idle so renderMonitor() returns null and the
          // generic "Monitoring active" content shows instead of the pre-trade blurb.
          ns._rdmPostSwapIdle = true;
          // Poll for on-chain confirmation and actual out amount
          if (ns.fetchActualOut && _outMint) {
            const _wp = ns.resolveWalletPubkey?.() ?? null;
            Promise.resolve().then(async () => {
              try {
                const result = await ns.fetchActualOut(_sig, _outMint, _wp,
                  _rdmRawOut, _outDec);
                if (!result) return;
                window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                  signature:       _sig,
                  actualOutAmount: String(result.actualOut),
                  quoteAccuracy:   result.quoteAccuracy,
                  amountOut:       String(result.actualOut),
                }}}, '*');
              } catch (_) {}
            });
          }
          // Sandwich detection — fire-and-forget for Raydium AMM trades
          if (ns.detectSandwich && _inMint && _outMint) {
            const _inUsd = _ct?.inUsdValue ?? null;
            const _inDec2 = _inDec;
            (async () => {
              try {
                const result = await ns.detectSandwich(_sig, _inMint, _outMint, {
                  inputDecimals: _inDec2,
                  amountIn: _ct?.amountUI ?? null,
                  amountInUsd: _inUsd,
                });
                if (!result) return;
                window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                  signature: _sig, sandwichResult: result,
                }}}, '*');
                if (ns.logMev) {
                  const _atkH = result.attackerWallet && ns.hashAddr
                    ? await ns.hashAddr(result.attackerWallet).catch(() => null) : null;
                  const _mevM = result.signals?.includes('bonding_curve_pda') ? 'bonding_curve_pda'
                              : result.signals?.some(s => String(s).includes('vault')) ? 'vault_neighbor'
                              : result.method === 'front-run' ? 'front_run_only' : 'unknown';
                  ns.logMev({ tx_sig: _sig, detected: !!result.detected, loss_usd: result.extractedUsd ?? null,
                    loss_bps: result.extractedUsd && _inUsd ? Math.round(result.extractedUsd / _inUsd * 10000) : null,
                    attacker_hash: _atkH, method: _mevM, prevented_count: result.detected ? 1 : 0 });
                }
              } catch (_) {}
            })();
          }
        }
        return res;
      } catch (e) {
        const m = e?.message ?? '';
        if (/reject|cancel|denied|abort/i.test(m)) throw e;
        console.error('[ZendIQ] Raydium onDecision confirm error:', m);
        throw e;
      }
    },
    // ── Monitor tab idle content when on raydium.io ──────────────────────────
    renderMonitor() {
      const score = ns.tokenScoreResult;
      const risk  = ns.lastRiskResult;


      // After a completed swap, show generic "Monitoring active" idle content
      // (same as Jupiter) until the user begins a new swap (/compute clears this flag).
      if (ns._rdmPostSwapIdle) return null;

      // Idle state: waiting for a swap attempt
      const outM = window.__zendiq_last_order_params?.outputMint ?? ns.lastOutputMint ?? null;
      const tsLoaded = score?.loaded && score?.mint === outM;
      const tsLv     = tsLoaded ? score.level : null;
      const tsColor  = tsLv === 'CRITICAL' ? '#FF4444' : tsLv === 'HIGH' ? '#FF6B00' : tsLv === 'MEDIUM' ? '#FFB547' : '#14F195';

      return `
        <div style="padding:14px 16px">
          <div style="font-size:13px;color:#C2C2D4;text-align:center;padding:12px 0;line-height:1.6">
            ${ns.walletHooked
              ? `Monitoring active.<br>Start a swap on <a href="https://raydium.io/swap/" target="_blank" rel="noopener" style="color:#9945FF;text-decoration:none">Raydium</a> to see ZendIQ\u2019s route check and risk analysis.`
              : `Connect your wallet on <a href="https://raydium.io/swap/" target="_blank" rel="noopener" style="color:#9945FF;text-decoration:none">Raydium</a> to get started.<br>Once connected, ZendIQ will check every swap for a better route and flag any risks \u2014 before you sign.`
            }
          </div>
          ${ns._rdmSwapAttempted ? (tsLoaded ? `
          <div style="display:flex;justify-content:space-between;align-items:center;
                      background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px">
            <span style="font-size:13px;color:#C2C2D4">Token Risk</span>
            <span style="font-size:13px;font-weight:700;color:${tsColor}">${tsLv} &middot; ${score.score}/100</span>
          </div>` : outM ? `
          <div style="font-size:12px;color:#9B9BAD;text-align:center;padding:4px 0">
            Scanning token risk&hellip;
          </div>` : '') : ''}
          ${ns._rdmSwapAttempted && risk ? `
          <div style="display:flex;justify-content:space-between;align-items:center;
                      background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px;margin-top:6px">
            <span style="font-size:13px;color:#C2C2D4">Bot Risk</span>
            <span style="font-size:13px;font-weight:700;color:${risk.mev?.riskLevel === 'HIGH' || risk.mev?.riskLevel === 'CRITICAL' ? '#FF6B00' : '#14F195'}">
              ${risk.mev?.riskLevel ?? 'LOW'}
            </span>
          </div>` : ''}
        </div>`;
    },
  });
})();
