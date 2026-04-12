/**
 * ZendIQ – wallet.js
 * Wallet detection, hooking (legacy + Wallet Standard), and resolveWalletPubkey.
 */

(function () {
  'use strict';
  const ns = window.__zq;

  // ── Simple wallet detection and hooking ─────────────────────────────────
  function detectAndHookWallet(attempts) {
    if (attempts === undefined) attempts = 0;
    if (window.solana?.signAndSendTransaction) {
      if (ns.walletHooked) return;
      ns.walletHooked = true;

      const wallet = window.solana;

      const realSignAndSend = wallet.signAndSendTransaction;
      const realSignTx = wallet.signTransaction;
      const realSendTx = wallet.sendTransaction;

      try {
        Object.defineProperty(wallet, 'signAndSendTransaction', {
          get() {
            return async function (...args) {
              return ns.handleTransaction(args[0], args[1] || {}, realSignAndSend.bind(wallet), 'signAndSendTransaction');
            };
          },
          configurable: true,
        });
      } catch (e) {
        console.warn('[ZendIQ] Could not hook signAndSendTransaction:', e.message);
      }

      try {
        Object.defineProperty(wallet, 'signTransaction', {
          get() {
            return async function (...args) {
              return ns.handleTransaction(args[0], args[1] || {}, realSignTx.bind(wallet), 'signTransaction');
            };
          },
          configurable: true,
        });
      } catch (e) {
        console.warn('[ZendIQ] Could not hook signTransaction:', e.message);
      }

      try {
        wallet.sendTransaction = async function (...args) {
          return ns.handleTransaction(args[0], args[1] || {}, realSendTx.bind(wallet), 'sendTransaction');
        };
      } catch (e) {
        console.warn('[ZendIQ] Could not hook sendTransaction:', e.message);
      }

      ns.updateWidgetStatus('Active');
      return;
    }

    if (attempts > 40) {
      console.warn('[ZendIQ] Wallet not detected after 10 seconds');
      return;
    }

    setTimeout(() => detectAndHookWallet(attempts + 1), 250);
  }

  // ── Wallet Standard hook — CustomEvent constructor override ────────────
  (function patchCustomEvent() {
    const OrigCustomEvent = window.CustomEvent;
    function PatchedCustomEvent(type, opts) {
      if (type === 'wallet-standard:app-ready' && typeof opts?.detail?.register === 'function') {
        const origRegister = opts.detail.register;
        opts.detail.register = function (wallet) {
          try {
            hookWsWallet(wallet, wallet?.accounts?.[0] ?? null);
            if (!ns._wsWallet && wallet) { ns._wsWallet = wallet; ns._wsAccount = wallet?.accounts?.[0] ?? null; }
          } catch (e) {
            console.warn('[ZendIQ][WS] hookWsWallet in CustomEvent threw:', e.message);
          }
          return origRegister(wallet);
        };
      }
      return new OrigCustomEvent(type, opts);
    }
    PatchedCustomEvent.prototype = OrigCustomEvent.prototype;
    Object.setPrototypeOf(PatchedCustomEvent, OrigCustomEvent);
    window.CustomEvent = PatchedCustomEvent;
  })();

  // ── Fallback probe ───────────────────────────────────────────────────────
  function probeAndHookWsWallet() {
    try {
      const reg = window.navigator?.wallets ?? window.__wallet_standard_wallets__;
      if (reg) {
        const list = Array.isArray(reg) ? reg : (reg.get?.() ?? []);
        for (const w of list) {
          if (w?.features?.['solana:signAndSendTransaction'] || w?.features?.['solana:signTransaction']) {
            if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
            hookWsWallet(w, w.accounts?.[0] ?? null);
            return true;
          }
        }
      }
    } catch (e) { console.warn('[ZendIQ][WS] registry probe error:', e.message); }
    try {
      const found = [];
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
        detail: { register(wallet) { found.push(wallet); } },
      }));
      for (const w of found) {
        if (w?.features?.['solana:signAndSendTransaction'] || w?.features?.['solana:signTransaction']) {
          if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
          hookWsWallet(w, w.accounts?.[0] ?? null);
          return true;
        }
      }
    } catch (e) { console.warn('[ZendIQ][WS] app-ready probe error:', e.message); }
    return false;
  }

  function scheduleWsProbe(attemptsLeft) {
    if (attemptsLeft === undefined) attemptsLeft = 20;
    if (probeAndHookWsWallet()) return;
    if (attemptsLeft > 0) {
      setTimeout(() => scheduleWsProbe(attemptsLeft - 1), 500);
    } else {
      console.warn('[ZendIQ] Wallet Standard wallet not found after probing');
    }
  }

  try {
    window.addEventListener('wallet-standard:register-wallet', (e) => {
      const w = e.detail?.wallet ?? e.wallet;
      if (w?.features?.['solana:signAndSendTransaction'] || w?.features?.['solana:signTransaction']) {
        if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
        hookWsWallet(w, w.accounts?.[0] ?? null);
      }
    });
  } catch (_) {}

  // ── Global scan fallback ─────────────────────────────────────────────────
  function scanAndWrapGlobalWallets() {
    try {
      for (const key of Object.keys(window)) {
        if (!key || key.startsWith('__')) continue;
        let obj;
        try { obj = window[key]; } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;

        if ((typeof obj.signTransaction === 'function' || typeof obj.signAndSendTransaction === 'function') && !obj.__sr_wrapped) {
          try {
            obj.__sr_wrapped = true;

            const realSignAndSend = obj.signAndSendTransaction;
            const realSignTx = obj.signTransaction;
            const realSendTx = obj.sendTransaction;

            if (typeof realSignAndSend === 'function') {
              Object.defineProperty(obj, 'signAndSendTransaction', {
                get() {
                  return async function (...args) {
                    return ns.handleTransaction(args[0], args[1] || {}, realSignAndSend.bind(obj), 'signAndSendTransaction');
                  };
                },
                configurable: true,
              });
            }

            if (typeof realSignTx === 'function') {
              Object.defineProperty(obj, 'signTransaction', {
                get() {
                  return async function (...args) {
                    return ns.handleTransaction(args[0], args[1] || {}, realSignTx.bind(obj), 'signTransaction');
                  };
                },
                configurable: true,
              });
            }

            if (typeof realSendTx === 'function') {
              try {
                obj.sendTransaction = async function (...args) {
                  return ns.handleTransaction(args[0], args[1] || {}, realSendTx.bind(obj), 'sendTransaction');
                };
              } catch (e) { /* ignore */ }
            }
          } catch (e) {
            console.warn('[ZendIQ] Failed to wrap global', key, e?.message);
          }
        }
      }
    } catch (e) {
      const name = e?.name || '';
      const msg = String(e?.message || e);
      if (name === 'SecurityError' || msg.includes('Blocked a frame')) {
        // ignore cross-origin noise
      } else {
        console.error('[ZendIQ] scanAndWrapGlobalWallets error', e);
      }
    }
  }

  // ── resolveWalletPubkey ──────────────────────────────────────────────────
  function resolveWalletPubkey() {
    const candidates = [
      window.phantom?.solana, window.solflare, window.backpack?.solana,
      window.braveSolana, window.jupiterWallet, window.jupiter?.solana, window.solana,
    ];
    for (const w of candidates) {
      if (!w?.publicKey) continue;
      const pk = w.publicKey;
      const str = typeof pk === 'string' ? pk : (pk?.toBase58?.() ?? pk?.toString?.() ?? '');
      if (str.length >= 32) return str;
    }

    const tryWsWallets = (list) => {
      for (const w of list) {
        for (const acc of (w?.accounts ?? [])) {
          const addr = acc?.address ?? acc?.publicKey?.toString?.();
          if (addr && String(addr).length >= 32) {
            const isNew = !ns._wsWallet;
            ns._wsWallet  = w;
            ns._wsAccount = acc;
            if (isNew) hookWsWallet(w, acc);
            return String(addr);
          }
        }
      }
      return null;
    };
    try {
      const reg = window.navigator?.wallets ?? window.__wallet_standard_wallets__;
      if (reg) {
        const list = Array.isArray(reg) ? reg : (reg.get?.() ?? []);
        const found = tryWsWallets(list);
        if (found) return found;
      }
    } catch (_) {}
    try {
      const found = [];
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
        detail: { register(wallet) { found.push(wallet); } },
      }));
      const result = tryWsWallets(found);
      if (result) return result;
    } catch (_) {}

    return null;
  }

  // Extract the transaction signature from a signed VersionedTransaction returned by
  // wallet.signTransaction. The tx sig is the fee-payer's signature at bytes [1..65]
  // (after the single-byte numSigners prefix).
  // Used as an Activity recording safety-net: if _captureConfirmTrade loses the response
  // (e.g. resp.clone().json() fails silently), this ensures the entry is already saved.
  function _extractSigFromSignedTx(res) {
    try {
      const item = Array.isArray(res) ? res[0] : res;
      let txBytes = item?.signedTransaction ?? item?.transaction ?? null;
      // Fallback: item itself might be the serialised tx bytes
      if (!txBytes) {
        if (item instanceof Uint8Array) txBytes = item;
        else if (ArrayBuffer.isView(item)) txBytes = new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
      }
      if (!txBytes) return null;
      if (!(txBytes instanceof Uint8Array)) {
        if (ArrayBuffer.isView(txBytes)) {
          txBytes = new Uint8Array(txBytes.buffer, txBytes.byteOffset, txBytes.byteLength);
        } else if (typeof txBytes === 'object') {
          const len = txBytes.length ?? Object.keys(txBytes).length;
          const arr = new Uint8Array(len);
          for (let i = 0; i < len; i++) arr[i] = txBytes[i] ?? txBytes[String(i)] ?? 0;
          txBytes = arr;
        }
      }
      if (txBytes.length < 65) return null;
      const numSigs = txBytes[0];
      if (numSigs < 1 || numSigs > 8) return null;
      return ns.b58Encode?.(txBytes.slice(1, 65)) ?? null;
    } catch (_) {}
    return null;
  }

  // ── Helpers for the "signing-original" Monitor state ────────────────────
  // Called right before origFn on the 'confirm' path — builds widgetOriginalSigningInfo
  // from whatever data is available (may have been set by handlePendingDecision already).
  function _ensureOriginalSigningInfo(nsRef) {
    if (nsRef.widgetOriginalSigningInfo) return; // already set by handlePendingDecision
    const ct = nsRef.widgetCapturedTrade;
    const lq = nsRef.jupiterLiveQuote;
    if (!ct && !lq) return;
    nsRef.widgetOriginalSigningInfo = {
      inputMint:      ct?.inputMint    ?? lq?.inputMint    ?? null,
      outputMint:     ct?.outputMint   ?? lq?.outputMint   ?? null,
      inputSymbol:    ct?.inputSymbol  ?? null,
      outputSymbol:   ct?.outputSymbol ?? null,
      inputDecimals:  ct?.inputDecimals  ?? null,
      outputDecimals: ct?.outputDecimals ?? null,
      inAmt:       ct?.amountUI ?? null,
      inAmountRaw: lq?.inAmount ?? null,
      riskScore: ct?.riskScore ?? null,
      riskLevel: null,
    };
  }

  // Extract a base58 signature from a wallet response object (Wallet Standard / legacy).
  // Returns null if the result is a signed-tx object rather than a sent-tx response.
  function _extractSig(result) {
    try {
      const item = Array.isArray(result) ? result[0] : result;
      const raw  = item?.signature ?? null;
      if (!raw) return null;
      if (typeof raw === 'string')    return raw;
      if (raw instanceof Uint8Array)  return ns.b58Encode?.(raw) ?? null;
      if (typeof raw === 'object') {
        const bytes = new Uint8Array(Object.keys(raw).length);
        for (const k of Object.keys(raw)) bytes[+k] = raw[k];
        return ns.b58Encode?.(bytes) ?? null;
      }
    } catch (_) {}
    return null;
  }

  // Save an unoptimised trade to Activity after signAndSendTransaction completes.
  // Used when the wallet signs+sends in one step so /execute is never called.
  function _saveConfirmToHistory(sig, nsRef) {
    try {
      const _lq   = nsRef.jupiterLiveQuote;
      const _ct   = nsRef.widgetCapturedTrade;
      // Prefer the risk snapshot frozen at decision time — handlePendingDecision clears
      // lastRiskResult before the wallet hook resumes, so _confirmRiskSnapshot is the
      // reliable source.
      const _risk = nsRef._confirmRiskSnapshot ?? nsRef.lastRiskResult ?? null;
      const inMint  = _ct?.inputMint  ?? _lq?.inputMint  ?? null;
      const outMint = _ct?.outputMint ?? _lq?.outputMint ?? null;
      const outDec  = _ct?.outputDecimals ?? 6;
      const inDec   = _ct?.inputDecimals  ?? 9;
      const inAmt   = _ct?.amountUI ?? (_lq?.inAmount  != null ? Number(_lq.inAmount)  / Math.pow(10, inDec)  : null);
      const outAmt  = _lq?.outAmount != null ? Number(_lq.outAmount) / Math.pow(10, outDec) : null;
      const entry = {
        signature:      sig,
        tokenIn:        _ct?.inputSymbol  ?? '?',
        tokenOut:       _ct?.outputSymbol ?? '?',
        amountIn:       inAmt  != null ? String(inAmt)  : null,
        amountOut:      outAmt != null ? String(outAmt) : null,
        quotedOut:      outAmt != null ? String(outAmt) : null,
        optimized:      false,
        timestamp:      Date.now(),
        inputMint:      inMint,
        outputMint:     outMint,
        outputDecimals: outDec,
        rawOutAmount:   _lq?.outAmount ?? null,
        priceImpactPct: _lq?.priceImpactPct ?? null,
        swapType:       _lq?.swapType ?? null,
        riskScore:      _risk?.score  ?? null,
        riskLevel:      _risk?.level  ?? null,
        riskFactors:    _risk?.factors      ?? [],
        mevFactors:     _risk?.mev?.factors ?? [],
        mevRiskLevel:   _risk?.mev?.riskLevel ?? null,
        mevRiskScore:   _risk?.mev?.riskScore ?? null,
        mevEstimatedLossPercent: _risk?.mev?.estimatedLossPercentage ?? null,
        inUsdValue:     _lq?.inUsdValue  ?? null,
        outUsdValue:    _lq?.outUsdValue ?? null,
      };
      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: entry } }, '*');
      if (nsRef.fetchActualOut && outMint) {
        const _wp = nsRef.resolveWalletPubkey?.() ?? null;
        (async () => {
          try {
            const result = await nsRef.fetchActualOut(sig, outMint, _wp,
              _lq?.outAmount != null ? Number(_lq.outAmount) : null, outDec);
            if (!result) return;
            window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
              signature: sig, actualOutAmount: String(result.actualOut),
              quoteAccuracy: result.quoteAccuracy, amountOut: String(result.actualOut),
            }}}, '*');
          } catch (_) {}
        })();
      }
    } catch (e) { console.error('[ZendIQ] _saveConfirmToHistory:', e?.message); }
  }

  // Attempt to transition to done-original after wallet returns from signAndSendTransaction.
  // If `res` contains a signature the tx was already sent — /execute won't fire.
  // Returns true if it handled the transition so the caller can skip _clearOriginalSigningInfo.
  function _handleSignAndSendResult(res, nsRef) {
    const sig = _extractSig(res);
    if (!sig) return false;
    _saveConfirmToHistory(sig, nsRef);
    nsRef.widgetOriginalTxSig = sig;
    nsRef.widgetSwapStatus    = 'done-original';
    nsRef.widgetActiveTab     = 'monitor';
    // Cancel the 15s safety timeout — we're done cleanly
    if (nsRef._signingOriginalTimeout) { clearTimeout(nsRef._signingOriginalTimeout); nsRef._signingOriginalTimeout = null; }
    try { nsRef.renderWidgetPanel?.(); } catch (_) {}
    return true;
  }

  function _clearOriginalSigningInfo(nsRef) {
    if (nsRef._signingOriginalTimeout) {
      clearTimeout(nsRef._signingOriginalTimeout);
      nsRef._signingOriginalTimeout = null;
    }
    if (nsRef.widgetSwapStatus === 'signing-original') {
      nsRef.widgetSwapStatus         = '';
      nsRef.widgetOriginalSigningInfo = null;
      nsRef.widgetCapturedTrade       = null;
      nsRef.widgetLastOrder           = null;
      try { nsRef.renderWidgetPanel?.(); } catch (_) {}
    }
  }

  // ── zendiqWsOverlay ─────────────────────────────────────────────────────
  async function zendiqWsOverlay(callerLabel, origFn, args) {
    if (window.__zendiq_own_tx) return origFn(...args);
    // Click interceptor already handled this swap — user confirmed, pass straight through.
    // Do NOT clear the flag here; the /execute fetch intercept is the final step and reads it.
    if (window.__zendiq_ws_confirmed) return origFn(...args);
    // Post-sign cooldown: ZendIQ just threw 'optimise' — auto-retries from the DEX
    // (e.g. Raydium fires immediately after the throw) must be silently dropped, NOT
    // passed through via origFn, which would open the wallet for the original tx on top
    // of ZendIQ's in-flight signing. Return undefined so the DEX retry resolves with null.
    if (ns._signCooldownUntil && Date.now() < ns._signCooldownUntil) return;
    // If the original tx is being signed (wallet prompt is open), any concurrent sign call
    // (ATA creation, Jupiter retry, etc.) should pass straight through without analysis.
    if (ns.widgetSwapStatus === 'signing-original') return origFn(...args);
    if (ns.pendingDecisionPromise) {
      const decision = await ns.pendingDecisionPromise;
      if (decision === 'cancel') throw new Error('Transaction rejected by user via ZendIQ');
      // 'skip': ZendIQ is busy (signing/sending/done) — silently drop the retry
      if (decision === 'skip') return;
    // Throw a custom error (not code 4001 / "User rejected") so Jupiter shows an error
    // state rather than re-enabling the Swap button, which would trigger a new intercept.
    if (decision === 'optimise') throw new Error('Transaction replaced by optimised route via ZendIQ');
      if (decision === 'pump-optimise') {
        const _adptResult0 = await ns.activeSiteAdapter?.()?.onDecision?.(decision, origFn, args);
        if (_adptResult0 !== undefined) return _adptResult0;
        // modification unavailable — fall through to confirm/original path
      }
      // Site adapter confirm hook for the early-return path (pendingDecisionPromise already resolved).
      if (decision === 'confirm') {
        // Set flag BEFORE calling adapter so any concurrent sign call (e.g. on Raydium where
        // the adapter returns early before __zendiq_ws_confirmed would otherwise be set) is
        // bypassed and never triggers a second Review & Sign panel.
        window.__zendiq_ws_confirmed = true;
        try {
          const _adptEarly = await ns.activeSiteAdapter?.()?.onDecision?.('confirm', origFn, args);
          if (_adptEarly !== undefined) return _adptEarly;
        } catch (e) {
          // Early-join: the full-analysis path (handleTransaction / zendiqWsOverlay) is
          // primarily responsible for state management. Swallow adapter errors here to
          // avoid duplicate state resets; clear flag so future intercepts work.
          window.__zendiq_ws_confirmed = false;
          _clearOriginalSigningInfo(ns);
          return;
        }
      }
      // Already true for the 'confirm' path above; also set here so pump-optimise fallthrough
      // (modification unavailable) sets the flag before calling origFn.
      window.__zendiq_ws_confirmed = true;
      // Show "signing original" indicator — widgetOriginalSigningInfo was saved by handlePendingDecision;
      // fall back to building it here for the autoProtect-skipped path which resolves directly.
      _ensureOriginalSigningInfo(ns);
      ns.widgetSwapStatus = 'signing-original';
      ns.widgetActiveTab  = 'monitor';
      const _w2 = document.getElementById('sr-widget');
      if (_w2) { _w2.style.display = ''; if (!_w2.classList.contains('expanded')) _w2.classList.add('expanded'); }
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      // Clear flag if wallet rejects so the next swap attempt is re-intercepted
      try {
        const _origFnPromise2 = origFn(...args);
        // User approved wallet — immediately flip card to "⏳ Sending…"
        if (ns.widgetOriginalSigningInfo) ns.widgetOriginalSigningInfo._sending = true;
        try { ns.renderWidgetPanel?.(); } catch (_) {}
        const res = await _origFnPromise2;
        if (callerLabel === 'signAndSendTransaction') {
          // Try primary path: wallet signed+broadcast, response has .signature
          if (_handleSignAndSendResult(res, ns)) {
            window.__zendiq_ws_confirmed = false; // broadcast done — /execute won't follow
          } else {
            // Wallet returned signed bytes instead of a broadcast sig (behaves like signTransaction).
            // Keep __zendiq_ws_confirmed so /execute intercept can do the done-original transition.
            // Also save a backup Activity entry from the signed tx bytes in case /execute fails.
            try { const _txSig = _extractSigFromSignedTx(res); if (_txSig) _saveConfirmToHistory(_txSig, ns); } catch (_) {}
          }
        } else {
          // Safety net: extract sig from signed tx bytes and save to Activity immediately.
          // _captureConfirmTrade in page-network.js also records when Jupiter calls /execute;
          // background.js merges both entries by sig, so the final record is enriched.
          // This prevents a blank Activity when resp.clone().json() fails silently.
          try { const _txSig = _extractSigFromSignedTx(res); if (_txSig) _saveConfirmToHistory(_txSig, ns); } catch (_) {}
        }
        return res;
      } catch (e) {
        window.__zendiq_ws_confirmed = false;
        ns.widgetSwapStatus = '';
        _clearOriginalSigningInfo(ns);
        throw e;
      }
    }
    // Run ZendIQ risk analysis + show overlay — keep origFn OUTSIDE this try so
    // wallet rejections propagate cleanly and don't get wrapped by the catch block.
    let signDecision;
    try {
      const p   = window.__zendiq_last_order_params;
      const lq  = ns.jupiterLiveQuote;
      // Fill any missing fields from the live quote so Amount always displays correctly
      const params = p ?? {};
      if (lq) {
        if (!params.inputMint  && lq.inputMint)  params.inputMint  = lq.inputMint;
        if (!params.outputMint && lq.outputMint) params.outputMint = lq.outputMint;
        if (!params.amount     && lq.inAmount)   params.amount     = String(lq.inAmount);
        if (!params.slippageBps && lq.slippageBps) params.slippageBps = String(lq.slippageBps);
      }
      if (!window.__zendiq_last_order_params) window.__zendiq_last_order_params = params;
      const inDec = params.inputMint ? (ns._TOKEN_DEC?.[params.inputMint] ?? ({
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,
        'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  6,
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5,
        'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 6,
        '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':  6,
      })[params.inputMint] ?? 9) : 9;
      // Run adapter wallet hook first so it populates __zendiq_last_order_params
      // (inputMint, outputMint, amount) from the tx bytes before calculateRisk is
      // called. Without this, Raydium swaps were scored with inAmount=0 because
      // the amount was only set after risk scoring.
      ns.activeSiteAdapter?.()?.onWalletArgs?.(args);
      // Re-read params after adapter may have enriched them
      const updatedParams = window.__zendiq_last_order_params ?? params;
      if (updatedParams !== params) {
        if (!params.inputMint  && updatedParams.inputMint)  params.inputMint  = updatedParams.inputMint;
        if (!params.outputMint && updatedParams.outputMint) params.outputMint = updatedParams.outputMint;
        if (!params.amount     && updatedParams.amount)     params.amount     = updatedParams.amount;
      }
      const txInfo = {
        accountCount: 3,
        swapInfo: {
          inAmount:        params.amount ? Number(params.amount) / Math.pow(10, inDec) : 0,
          slippagePercent: params.slippageBps ? Number(params.slippageBps) / 100 : 0.5,
          source: ns.activeSiteAdapter?.()?.name ?? 'jupiter',
        },
      };
      const risk = await ns.calculateRisk(txInfo, { congestion: 'normal' });
      ns.lastRiskResult = risk;
      const overlayInfo = { method: 'Jupiter Swap', params: [], orderParams: params, risk };
      signDecision = await ns.showPendingTransaction(overlayInfo);
    } catch (e) {
      if (e.message?.includes('ZendIQ')) throw e;
      console.error('[ZendIQ] zendiqWsOverlay unexpected error, allowing sign call through:', e.message);
      signDecision = 'confirm'; // fail open — don't block user's swap on an internal error
    }
    if (signDecision === 'cancel') throw new Error('Transaction rejected by user via ZendIQ');
    if (signDecision === 'optimise') throw new Error('Transaction replaced by optimised route via ZendIQ');
    // 'skip': B44 busy-state guard fired — ZendIQ is actively signing, silently drop
    if (signDecision === 'skip') return;
    if (signDecision === 'pump-optimise') {
      const _adptResult = await ns.activeSiteAdapter?.()?.onDecision?.(signDecision, origFn, args);
      if (_adptResult !== undefined) return _adptResult;
      // modification unavailable — fall through to original tx path
    }
    // Site adapter confirm hook: allows adapters (e.g. raydium) to intercept the
    // Proceed-anyway path for Activity recording. Returns undefined to fall through.
    if (signDecision === 'confirm') {
      // Set flag BEFORE calling adapter (mirrors the early-join-path fix above).
      window.__zendiq_ws_confirmed = true;
      try {
        const _adptConfirm = await ns.activeSiteAdapter?.()?.onDecision?.('confirm', origFn, args);
        if (_adptConfirm !== undefined) return _adptConfirm;
      } catch (e) {
        // Adapter threw (e.g. wallet cancel/reject on Raydium) — reset state so the user
        // can click Swap again without a page reload. Previously widgetSwapStatus stayed
        // stuck at 'signing-original' indefinitely on Raydium wallet cancels.
        window.__zendiq_ws_confirmed = false;
        _clearOriginalSigningInfo(ns);
        throw e;
      }
    }
    // Already true for the 'confirm' path above; also set here so pump-optimise fallthrough
    // (modification unavailable) sets the flag before calling origFn.
    window.__zendiq_ws_confirmed = true;
    // Show "signing original" indicator in Monitor before wallet prompt opens
    _ensureOriginalSigningInfo(ns);
    ns.widgetSwapStatus = 'signing-original';
    ns.widgetActiveTab  = 'monitor';
    const _w3 = document.getElementById('sr-widget');
    if (_w3) { _w3.style.display = ''; if (!_w3.classList.contains('expanded')) _w3.classList.add('expanded'); }
    try { ns.renderWidgetPanel?.(); } catch (_) {}
    // Clear flag on wallet rejection so the next swap attempt is re-intercepted
    try {
      const _origFnPromise = origFn(...args);
      // User approved wallet — immediately flip card to "⏳ Sending…" without waiting for tx
      if (ns.widgetOriginalSigningInfo) ns.widgetOriginalSigningInfo._sending = true;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      const res = await _origFnPromise;
      if (callerLabel === 'signAndSendTransaction') {
        // Try primary: wallet signed+broadcast, response has .signature
        if (_handleSignAndSendResult(res, ns)) {
          window.__zendiq_ws_confirmed = false; // broadcast done — /execute won't follow
        } else {
          // Wallet returned signed bytes instead of broadcast sig — keep flag for /execute.
          try { const _txSig = _extractSigFromSignedTx(res); if (_txSig) _saveConfirmToHistory(_txSig, ns); } catch (_) {}
        }
      } else {
        // Safety net: extract sig from signed tx bytes and save to Activity immediately.
        try { const _txSig = _extractSigFromSignedTx(res); if (_txSig) _saveConfirmToHistory(_txSig, ns); } catch (_) {}
      }
      // signTransaction: keep signing-original status; _captureConfirmTrade handles done-original
      return res;
    } catch (e) {
      window.__zendiq_ws_confirmed = false;
      ns.widgetSwapStatus = '';
      _clearOriginalSigningInfo(ns);
      throw e;
    }
  }

  // ── hookWsWallet ─────────────────────────────────────────────────────────
  function hookWsWallet(w, _acc) {
    try {
      const feat = w?.features?.['solana:signAndSendTransaction'];
      if (feat?.signAndSendTransaction && !feat.__zendiq_hooked_sast) {
        const orig = feat.signAndSendTransaction.bind(feat);
        feat.__zendiq_hooked_sast = true;
        Object.defineProperty(feat, 'signAndSendTransaction', {
          get() { return (...args) => zendiqWsOverlay('signAndSendTransaction', orig, args); },
          configurable: true,
        });
      }
    } catch (e) {
      console.warn('[ZendIQ] Could not hook WS signAndSendTransaction:', e.message);
    }

    try {
      const feat = w?.features?.['solana:signTransaction'];
      if (feat?.signTransaction && !feat.__zendiq_hooked_st) {
        const orig = feat.signTransaction.bind(feat);
        feat.__zendiq_hooked_st = true;
        Object.defineProperty(feat, 'signTransaction', {
          get() { return (...args) => zendiqWsOverlay('signTransaction', orig, args); },
          configurable: true,
        });
      }
    } catch (e) {
      console.warn('[ZendIQ] Could not hook WS signTransaction:', e.message);
    }
  }

  // ── handleTransaction ────────────────────────────────────────────────────
  async function handleTransaction(transaction, options, originalMethod, methodName) {
    if (window.__zendiq_own_tx) {
      return originalMethod(transaction, options);
    }
    // Click interceptor already handled this swap — user confirmed, pass straight through.
    // Do NOT clear the flag here; the /execute fetch intercept is the final step and reads it.
    if (window.__zendiq_ws_confirmed) return originalMethod(transaction, options);
    // Post-sign cooldown: silently drop auto-retries (same reason as zendiqWsOverlay above).
    if (ns._signCooldownUntil && Date.now() < ns._signCooldownUntil) return;
    // If the original tx is already being signed, any concurrent/legacy sign call passes through.
    if (ns.widgetSwapStatus === 'signing-original') return originalMethod(transaction, options);
    // If the Wallet Standard hook (zendiqWsOverlay) is already running a flow for this swap,
    // join it rather than starting a parallel analysis. Mirrors the same guard in zendiqWsOverlay.
    if (ns.pendingDecisionPromise) {
      const decision = await ns.pendingDecisionPromise;
      if (decision === 'cancel')   throw new Error('Transaction cancelled by user via ZendIQ');
      if (decision === 'optimise') throw new Error('Transaction replaced by optimised route via ZendIQ');
      if (decision === 'pump-optimise') {
        const _adptResult2 = await ns.activeSiteAdapter?.()?.onDecisionLegacy?.(decision, originalMethod, transaction, options);
        if (_adptResult2 !== undefined) return _adptResult2;
        // modification unavailable — fall through to confirm/original path
      }
      // 'confirm' or pump-optimise fallback — WS path handles submission; skip duplicate.
      return;
    }

    // Run ZendIQ analysis — keep originalMethod OUTSIDE the catch so wallet
    // rejections propagate up cleanly and don't trigger a double sign prompt.
    let decision;
    try {
      const txInfo  = ns.extractTxInfo(transaction);
      const context = await ns.fetchDevnetContext(txInfo);
      const risk    = await ns.calculateRisk(txInfo, context);
      ns.lastRiskResult = risk;
      ns.activeSiteAdapter?.()?.onWalletArgs?.([transaction, options]);
      decision = await ns.showPendingTransaction(txInfo);
    } catch (err) {
      if (err.message?.includes('cancelled by user')) throw err;
      console.error(`[ZendIQ] Error in ${methodName}, falling back:`, err);
      return await originalMethod(transaction, options);
    }

    if (decision === 'cancel') {
      throw new Error('Transaction cancelled by user via ZendIQ');
    }
    if (decision === 'optimise') throw new Error('Transaction replaced by optimised route via ZendIQ');
    if (decision === 'skip') return; // ZendIQ busy — silently drop the retry
    if (decision === 'pump-optimise') {
      const _adptResult3 = await ns.activeSiteAdapter?.()?.onDecisionLegacy?.(decision, originalMethod, transaction, options);
      if (_adptResult3 !== undefined) return _adptResult3;
      // modification unavailable — fall through to original tx path
    }
    // 'confirm' or pump-optimise fallback — show signing-original state before passing tx to wallet
    _ensureOriginalSigningInfo(ns);
    ns.widgetSwapStatus = 'signing-original';
    ns.widgetActiveTab  = 'monitor';
    // Signal to the /execute fetch interceptor that the wallet hook already showed the overlay
    // and the user confirmed — it should tap the response for Activity history rather than
    // re-showing the overlay. Mirrors the same flag set in zendiqWsOverlay's confirm path.
    window.__zendiq_ws_confirmed = true;
    const _w4 = document.getElementById('sr-widget');
    if (_w4) { _w4.style.display = ''; if (!_w4.classList.contains('expanded')) _w4.classList.add('expanded'); }
    try { ns.renderWidgetPanel?.(); } catch (_) {}
    try {
      const _origFnPromise = originalMethod(transaction, options);
      // User approved wallet — immediately flip card to "⏳ Sending…" without waiting for tx
      if (ns.widgetOriginalSigningInfo) ns.widgetOriginalSigningInfo._sending = true;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      const res = await _origFnPromise;
      if (methodName === 'signAndSendTransaction') {
        // Try primary: wallet signed+broadcast, response has .signature
        if (_handleSignAndSendResult(res, ns)) {
          window.__zendiq_ws_confirmed = false; // broadcast done — /execute won't follow
        } else {
          // Wallet returned signed bytes instead of broadcast sig — keep flag for /execute.
          try { const _txSig = _extractSigFromSignedTx(res); if (_txSig) _saveConfirmToHistory(_txSig, ns); } catch (_) {}
        }
      } else {
        // Safety net: extract sig from signed tx bytes and save to Activity immediately.
        try { const _txSig = _extractSigFromSignedTx(res); if (_txSig) _saveConfirmToHistory(_txSig, ns); } catch (_) {}
      }
      // signTransaction: keep signing-original status; _captureConfirmTrade handles done-original
      return res;
    } catch (e) {
      window.__zendiq_ws_confirmed = false;
      ns.widgetSwapStatus = '';
      _clearOriginalSigningInfo(ns);
      throw e;
    }
  }
  Object.assign(ns, {
    detectAndHookWallet,
    scheduleWsProbe,
    scanAndWrapGlobalWallets,
    resolveWalletPubkey,
    zendiqWsOverlay,
    hookWsWallet,
    handleTransaction,
  });
})();
