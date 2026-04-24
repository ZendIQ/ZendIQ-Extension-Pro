/**
 * ZendIQ – network.js
 * fetch + XHR interception: captures /order params, triggers overlay on
 * /execute and RPC sendTransaction, and handles the /execute block/pass-through.
 */

(function installNetworkInterception() {
  'use strict';
  const ns = window.__zq;

// ── Stable-token set (used by risk scorer) ─────────────────────────────
  const STABLES_SET  = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  ]);

  // ── Shared risk scoring ──────────────────────────────────────────────────
  // Called both on /execute intercept and on each Jupiter /order tick (live updates).
  // Returns the composed risk object and mutates ns.lastRiskResult.
  const TOKEN_DEC = {
    'So11111111111111111111111111111111111111112':  9, // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  6, // JUP
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5, // BONK
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 6, // WIF
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':  6, // RAY
  };
  // STABLES_SET already declared above (reused here for isStable check)
  const TOKEN_SYMBOLS = {
    'So11111111111111111111111111111111111111112':  'SOL',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  'JUP',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':  'RAY',
  };

  async function _rescoreFromParams(p) {
    // Token Score: proactively fetch when outputMint changes (cached — only runs once per mint per 5 min)
    const _rcMint = p?.outputMint ?? null;
    if (_rcMint && _rcMint !== ns._tokenScoreMint && ns.fetchTokenScore) {
      ns._tokenScoreMint = _rcMint;
      ns.tokenScoreResult = null; // clear stale result so widget immediately shows 'Scanning…'
      const _rcSym = TOKEN_SYMBOLS[_rcMint] ?? null;
      ns.fetchTokenScore(_rcMint, _rcSym); // async; updates ns.tokenScoreResult + re-renders on arrival
    }

    const inDec    = p?.inputMint ? (TOKEN_DEC[p.inputMint] ?? 9) : 9;
    const inAmount = p?.amount ? Number(p.amount) / Math.pow(10, inDec) : 0;
    const isStable = p?.inputMint && STABLES_SET.has(p.inputMint);
    // Derive token price from Jupiter's live quote inUsdValue — no external price API needed.
    // jupiterLiveQuote.inUsdValue is set on every ~1s Jupiter /order tick.
    // widgetLastPriceData.inputPriceUsd is set when ZendIQ fetches its own order.
    let tokenPriceUsd;
    if (isStable) {
      tokenPriceUsd = 1;
    } else {
      const lq = ns.jupiterLiveQuote;
      const lqInAmt = (lq?.inAmount != null && lq?.inputMint === p?.inputMint)
        ? Number(lq.inAmount) / Math.pow(10, inDec) : 0;
      if (lq?.inUsdValue != null && lqInAmt > 0) {
        tokenPriceUsd = lq.inUsdValue / lqInAmt;
      } else {
        const _wld = ns.widgetLastPriceData;
        tokenPriceUsd = _wld?.inputPriceUsd ?? null;
      }
    }
    const inAmountUsd = tokenPriceUsd != null ? inAmount * tokenPriceUsd : null;
    const inputSymbol   = p?.inputMint ? (TOKEN_SYMBOLS[p.inputMint] ?? p.inputMint.slice(0,4)+'…') : 'tokens';
    const slippagePct   = p?.slippageBps != null ? Number(p.slippageBps) / 100 : 0.5;
    const priceImpactPct = p?.priceImpactPct != null ? parseFloat(p.priceImpactPct) * 100 : null;

    const txInfo = {
      accountCount: 3,
      swapInfo: { inAmount, inAmountUsd, tokenPriceUsd, inputMint: p?.inputMint ?? null, outputMint: p?.outputMint ?? null, inputSymbol, slippagePercent: slippagePct, priceImpactPct, source: 'jupiter' },
    };
    const context = await ns.fetchDevnetContext(txInfo).catch(() => ({ congestion: 'low' }));
    const risk    = await ns.calculateRisk(txInfo, context);

    try {
      const mevRisk = ns.calculateMEVRisk({
        inputMint: p?.inputMint ?? null, outputMint: p?.outputMint ?? null,
        amountUSD: inAmountUsd, routePlan: ns.jupiterLiveQuote?.routePlan ?? null, slippage: slippagePct / 100, poolLiquidity: null,
        routeType: ns.mevRouteType?.(ns.jupiterLiveQuote),
      });
      if (mevRisk) {
        risk.mev = mevRisk;
        if (mevRisk.riskScore > risk.score) {
          risk.score = Math.round((risk.score + mevRisk.riskScore) / 2);
          risk.level = risk.score >= 70 ? 'CRITICAL' : risk.score >= 40 ? 'HIGH' : risk.score >= 20 ? 'MEDIUM' : 'LOW';
        }
      }
    } catch (_) {}

    // While the risk overlay is showing, never downgrade — only accept a new result
    // if its score is >= the current one. Jupiter ticks often return slippageBps:0
    // (auto-slippage) which would recalculate to near-zero risk, wiping out factors.
    if (!ns.pendingTransaction || !ns.lastRiskResult || risk.score >= ns.lastRiskResult.score) {
      ns.lastRiskResult = risk;
    }
    return risk;
  }

  // ── fetch override ──────────────────────────────────────────────────
  try {
    const origFetch = window.fetch.bind(window);
    // ── Capture an unoptimised /execute response and save to Activity ────────
    // Defined inside the try block so it closes over origFetch.
    // Called from both the __zendiq_ws_confirmed bypass path (normal jup.ag flow
    // where the wallet hook showed the overlay) and from the network-overlay path.
    async function _captureConfirmTrade(resource, init, risk) {
      // Wallet has signed — transition "signing-original" to a "sending" phase so the card
      // stays visible with an updated header while awaiting the /execute response.
      const _wasSigningOrig = ns.widgetSwapStatus === 'signing-original';
      // Save captured trade reference BEFORE nulling it in the signing-original block so
      // token symbols / amounts come from the intercepted tx context, falling back to lq.
      const _lq  = ns.jupiterLiveQuote;
      const _ct  = ns.widgetCapturedTrade;
      if (_wasSigningOrig) {
        if (ns._signingOriginalTimeout) { clearTimeout(ns._signingOriginalTimeout); ns._signingOriginalTimeout = null; }
        if (ns.widgetOriginalSigningInfo) ns.widgetOriginalSigningInfo._sending = true;
        ns.widgetCapturedTrade = null;
        ns.widgetLastOrder     = null;
        try { ns.renderWidgetPanel?.(); } catch (_) {}
      }
      const inMint  = _ct?.inputMint  ?? _lq?.inputMint  ?? null;
      const outMint = _ct?.outputMint ?? _lq?.outputMint ?? null;
      const outDec  = outMint ? (TOKEN_DEC[outMint] ?? 6) : 6;
      const inDec   = inMint  ? (TOKEN_DEC[inMint]  ?? 9) : 9;
      const inAmt   = _ct?.amountUI ?? (_lq?.inAmount  != null ? Number(_lq.inAmount)  / Math.pow(10, inDec)  : null);
      const outAmt  = _lq?.outAmount != null ? Number(_lq.outAmount) / Math.pow(10, outDec) : null;
      const resp = await origFetch(resource, init);
      resp.clone().json().then(data => {
        const sig = data?.signature ?? null;
        const entry = {
          signature:      sig,
          tokenIn:        _ct?.inputSymbol  ?? TOKEN_SYMBOLS[inMint]  ?? (inMint  ? inMint.slice(0, 6)  + '\u2026' : '?'),
          tokenOut:       _ct?.outputSymbol ?? TOKEN_SYMBOLS[outMint] ?? (outMint ? outMint.slice(0, 6) + '\u2026' : '?'),
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
          riskScore:      risk?.score  ?? null,
          riskLevel:      risk?.level  ?? null,
          riskFactors:    risk?.factors ?? [],
          mevFactors:     risk?.mev?.factors ?? [],
          mevRiskLevel:   risk?.mev?.riskLevel ?? null,
          mevRiskScore:              risk?.mev?.riskScore ?? null,
          mevEstimatedLossPercent:   risk?.mev?.estimatedLossPercentage ?? null,
          inUsdValue:     _lq?.inUsdValue  ?? null,
          outUsdValue:    _lq?.outUsdValue ?? null,
          ...(_lq?.swapType !== 'rfq' && _lq?.swapType !== 'gasless' ? { sandwichResult: null } : {}),
        };
        // Update widget: done-original on success, error on failure
        if (_wasSigningOrig) {
          if (sig && data?.status !== 'Failed' && !data?.error) {
            ns.widgetOriginalTxSig = sig;
            ns.widgetSwapStatus    = 'done-original';
          } else {
            ns.widgetSwapStatus          = 'error';
            ns.widgetSwapError           = data?.error ?? (data?.status === 'Failed' ? 'Jupiter swap failed' : 'Transaction failed');
            ns.widgetOriginalSigningInfo = null;
          }
          try { ns.renderWidgetPanel?.(); } catch (_) {}
        }
        // Only record trades that actually landed on-chain (signature present + not Failed)
        if (!sig || data?.status === 'Failed' || data?.error) return;
        try { window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: entry } }, '*'); } catch (_) {}
        // Analytics: swap proceeded via Jupiter's original route
        try { if (ns.logProEvent) {
          const _sshCon = window.location.hostname;
          ns.logProEvent('swap_proceeded', {
            site:      _sshCon.includes('raydium') ? 'raydium.io' : _sshCon.includes('pump') ? 'pump.fun' : 'jup.ag',
            trade_usd: entry.inUsdValue != null ? Math.min(Number(entry.inUsdValue), 50000) : null,
            profile:   ns.settingsProfile ?? 'unknown',
            reason:    null,
          });
        } } catch (_) {}
        // Structured trade record (routes to trades DB table)
        try { if (ns.logTrade) {
          const _sshCon2 = window.location.hostname;
          ns.logTrade({
            user_action:  'proceeded',
            dex:          _sshCon2.includes('raydium') ? 'raydium.io' : _sshCon2.includes('pump') ? 'pump.fun' : 'jup.ag',
            exec_path:    'direct',
            tx_sig:       sig,
            input_mint:   inMint ?? null,
            output_mint:  outMint ?? null,
            success:      1,
            trade_usd:    entry.inUsdValue != null ? Math.min(Number(entry.inUsdValue), 50000) : null,
            profile:      ns.settingsProfile ?? 'unknown',
            bot_risk_score:    risk?.score ?? null,
            token_risk_score:  ns.tokenScoreResult?.score ?? null,
            tx_classification: (function (lv) { return lv === 'LOW' ? 'safe' : lv === 'MEDIUM' ? 'caution' : lv ? 'danger' : null; })(risk?.level),
          });
        } } catch (_) {}
        if (sig && outMint && ns.fetchActualOut) {
          (async () => {
            try {
              const _wp = ns.resolveWalletPubkey() ?? null;
              const result = await ns.fetchActualOut(sig, outMint, _wp,
                _lq?.outAmount != null ? Number(_lq.outAmount) : null, outDec);
              if (!result) return;
              window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                signature: sig,
                actualOutAmount: String(result.actualOut),
                quoteAccuracy:   result.quoteAccuracy,
                amountOut:       String(result.actualOut),
              }}}, '*');
            } catch (_) {}
          })();
        }
        // Sandwich detection — fire-and-forget for AMM trades only
        if (sig && inMint && outMint && ns.detectSandwich
            && _lq?.swapType !== 'rfq' && _lq?.swapType !== 'gasless') {
          const _inUsd = _lq?.inUsdValue ?? null;
          (async () => {
            try {
              const result = await ns.detectSandwich(sig, inMint, outMint, {
                inputDecimals: inDec,
                amountIn: inAmt,
                amountInUsd: _inUsd,
              });
              if (!result) return;
              window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                signature: sig, sandwichResult: result,
              }}}, '*');
              if (ns.logMev) {
                const _atkH = result.attackerWallet && ns.hashAddr
                  ? await ns.hashAddr(result.attackerWallet).catch(() => null) : null;
                const _mevM = result.signals?.includes('bonding_curve_pda') ? 'bonding_curve_pda'
                            : result.signals?.some(s => String(s).includes('vault')) ? 'vault_neighbor'
                            : result.method === 'front-run' ? 'front_run_only' : 'unknown';
                ns.logMev({ tx_sig: sig, detected: !!result.detected, loss_usd: result.extractedUsd ?? null,
                  loss_bps: result.extractedUsd && _inUsd ? Math.round(result.extractedUsd / _inUsd * 10000) : null,
                  attacker_hash: _atkH, method: _mevM, prevented_count: result.detected ? 1 : 0 });
              }
            } catch (_) {}
          })();
        }
      }).catch(() => {});
      return resp;
    }
    window.fetch = async function (resource, init) {
      try {
        const url      = (typeof resource === 'string') ? resource : resource?.url;
        const body     = init?.body ?? null;
        const parsed   = body ? ns.tryParseJson(body) : null;
        const methodName = parsed?.method;

        // Sniff jup.ag's own Solana RPC endpoint — it supports CORS from this domain
        // and can be reused for our getTokenAccountsByOwner lookup.
        // Capture on the first JSON-RPC POST that isn't one of our own calls.
        if (!ns._jupRpcUrl && url && typeof url === 'string' && !window.__zendiq_own_tx
            && parsed?.jsonrpc === '2.0' && methodName
            && !url.includes('jup.ag') && !url.includes('raydium.io')) {
          ns._jupRpcUrl = url;
        }

        // ── Site adapter network hook (mint/slippage extraction, API sniff) ──
        ns.activeSiteAdapter?.()?.onNetworkRequest?.(url, parsed);

        // ── pump.fun API response tap ─────────────────────────────────────
        // Intercepts ALL pump.fun fetch calls and searches each JSON response for
        // either (a) explicit bonding_curve/bondingCurve fields or
        // (b) a base64-encoded Solana transaction containing the buy instruction.
        // Covers coins API, trade-build API, and any other pump.fun endpoint that
        // carries the bonding curve address.  Does NOT require a trailing slash in
        // the URL (previous pattern had that bug).  Non-JSON responses are silently
        // ignored by the .catch handler.
        if (url && /pump\.fun/.test(url) && !window.__zendiq_own_tx) {
          const _pumpResp = await origFetch(resource, init);
          _pumpResp.clone().json().then(j => {
            if (!j || typeof j !== 'object') return;
            // (a) Explicit bonding curve address fields
            const _bc  = j.bonding_curve ?? j.bondingCurve ?? null;
            const _abc = j.associated_bonding_curve ?? j.associatedBondingCurve ?? null;
            if (_bc && _abc && typeof _bc === 'string' && _bc.length > 30) {
              ns._pumpExtractedAccounts = { bondingCurve: _bc, assocBondingCurve: _abc };
              if (ns.pumpFunContext) { ns.pumpFunContext.bondingCurve = _bc; ns.pumpFunContext.assocBondingCurve = _abc; }
            }
            // (b) Base64 transaction bytes — parse bonding curve from raw tx
            const _txB64 = j.transaction ?? j.tx ?? j.Transaction ?? j.data?.transaction ?? null;
            if (_txB64 && typeof _txB64 === 'string' && _txB64.length > 100) {
              try {
                const _raw = atob(_txB64);
                const _bytes = new Uint8Array(_raw.length);
                for (let i = 0; i < _raw.length; i++) _bytes[i] = _raw.charCodeAt(i);
                if (_bytes.length > 100) {
                  const _ext = ns.activeSiteAdapter?.()?.parseTxAccounts?.(_bytes);
                  if (_ext?.bondingCurve) {
                    // Cache full account template so _buildPumpBuyTx can reuse pump.fun's exact layout
                    if (_ext.allKeys?.length > 8 && _ext.buyIxAcctIndices?.length > 10) {
                      ns._pumpTxTemplate = { allKeys: _ext.allKeys, buyIxAcctIndices: _ext.buyIxAcctIndices, msgHeader: _ext.msgHeader };
                    }
                    ns._pumpExtractedAccounts = _ext;
                    ns._pumpGlobalAccounts = { global: _ext.global, feeRecip: _ext.feeRecip, evtAuth: _ext.evtAuth };
                    if (ns.pumpFunContext) { ns.pumpFunContext.bondingCurve = _ext.bondingCurve; ns.pumpFunContext.assocBondingCurve = _ext.assocBondingCurve; }
                  }
                }
              } catch (_) {}
            }
          }).catch(() => {});
          return _pumpResp;
        }


        const isJupiterOrder = url && url.includes('jup.ag') && url.includes('/order')
                            && (init?.method ?? 'GET') === 'GET' && !window.__zendiq_own_tx;
        if (isJupiterOrder) {
          try {
            const _u     = new URL(url);
            const _taker = _u.searchParams.get('taker') || _u.searchParams.get('userPublicKey');
            const amt    = _u.searchParams.get('amount') || _u.searchParams.get('inAmount');
            // Always initialise the params object so the /execute handler always has something.
            // URL params may be absent on the first tick; the response body will fill them in.
            if (!window.__zendiq_last_order_params) window.__zendiq_last_order_params = {};
            const _seed = window.__zendiq_last_order_params;
            if (_u.searchParams.get('inputMint')  || _u.searchParams.get('inputToken'))  _seed.inputMint  = _u.searchParams.get('inputMint')  || _u.searchParams.get('inputToken');
            if (_u.searchParams.get('outputMint') || _u.searchParams.get('outputToken')) _seed.outputMint = _u.searchParams.get('outputMint') || _u.searchParams.get('outputToken');
            if (amt)    _seed.amount     = amt;
            if (_taker) _seed.taker      = _taker;
            if (_u.searchParams.get('slippageBps')) _seed.slippageBps = _u.searchParams.get('slippageBps');
            // Tap the response body — MUTATE existing object so the /execute handler sees updates via its p reference
            const orderResp = await origFetch(resource, init);
            const orderClone = orderResp.clone();
            // ── Handle 400 / no-route errors from Jupiter ────────────────────────
            if (!orderResp.ok) {
              orderResp.json().then(j => {
                ns.jupiterOrderError = j?.error ?? j?.message ?? 'No route found';
                ns.jupiterLiveQuote  = null;
                if (ns.pendingTransaction || ns.widgetCapturedTrade) ns.renderWidgetPanel();
              }).catch(() => {
                ns.jupiterOrderError = 'No route found';
                ns.jupiterLiveQuote  = null;
                if (ns.pendingTransaction || ns.widgetCapturedTrade) ns.renderWidgetPanel();
              });
              return orderClone;
            }
            // Clear any previous error on a successful response
            ns.jupiterOrderError = null;
            orderResp.json().then(j => {
              if (!j || typeof j !== 'object') return;
              const params = window.__zendiq_last_order_params;
              if (!params) return;
              if (j.inputMint)  params.inputMint  = j.inputMint;
              if (j.outputMint) params.outputMint = j.outputMint;
              if (j.inAmount)   params.amount     = String(j.inAmount);
              // Only update slippageBps from the response when it is non-zero.
              // Jupiter Ultra always returns slippageBps:0 for auto-slippage mode;
              // overwriting with 0 would cause the risk engine to see 0% slippage and
              // drop all slippage-related risk factors.
              if (j.slippageBps != null && Number(j.slippageBps) > 0) params.slippageBps = String(j.slippageBps);
              params.priceImpactPct = j.priceImpactPct ?? null;
              // Cache Jupiter's live ticking quote so the widget can show it immediately
              if (j.outAmount && params.inputMint) {
                ns.jupiterLiveQuote = {
                  outAmount:      j.outAmount,
                  inAmount:       j.inAmount ?? params.amount,
                  inputMint:      params.inputMint,
                  outputMint:     params.outputMint ?? params.inputMint,
                  priceImpactPct: j.priceImpactPct ?? null,
                  routePlan:      j.routePlan ?? null,
                  taker:          params.taker ?? null,
                  capturedAt:     Date.now(),
                  // USD values from Jupiter's order response — used to derive token prices
                  // without needing any external /price API call.
                  inUsdValue:     j.inUsdValue  ?? null,
                  outUsdValue:    j.outUsdValue ?? null,
                  // Route type — needed to avoid cross-type baseline comparisons (gasless
                  // vs AMM quotes are not interchangeable; comparing them causes false
                  // negative-net results that prevent ZendIQ from ever optimising).
                  swapType:       j.swapType   ?? null,
                };
                // Always rescore on every live tick so lastRiskResult (Est. Loss,
                // route complexity, etc.) stays fresh in monitor mode too.
                // Only re-render when something is actually visible.
                _rescoreFromParams(params).then(risk => {
                  const _widget = document.getElementById('sr-widget');
                  const _widgetOpen = _widget && _widget.classList.contains('expanded');
                  const _activeTab = ns.widgetActiveTab;
                  // Don't re-render Activity or Settings tabs on live ticks — nothing
                  // risk-related changes there, and the full innerHTML rebuild causes flicker.
                  const _tabNeedsUpdate = _activeTab === 'swap' || _activeTab === 'monitor' || !_activeTab;
                  // Don't re-render while a sign/send/done is in progress — live ticks
                  // would overwrite the signing/success panel with stale Monitor content.
                  const _busySign = ['signing', 'sending', 'done', 'signing-original', 'done-original'].includes(ns.widgetSwapStatus);
                  if (!_busySign && (ns.pendingTransaction || ns.widgetCapturedTrade || (_widgetOpen && _tabNeedsUpdate))) {
                    // Keep widgetCapturedTrade risk fields in sync so fee escalation and net benefit gate are accurate
                    if (ns.widgetCapturedTrade) {
                      ns.widgetCapturedTrade.riskScore               = risk.score;
                      ns.widgetCapturedTrade.mevScore                = risk.mev?.riskScore ?? ns.widgetCapturedTrade.mevScore ?? 0;
                      ns.widgetCapturedTrade.mevEstimatedLossPercent = risk.mev?.estimatedLossPercentage ?? ns.widgetCapturedTrade.mevEstimatedLossPercent ?? null;
                    }
                    ns.renderWidgetPanel();
                  }
                }).catch(() => {});
              }
            }).catch(() => {});
            return orderClone;
          } catch (_) {}
          // Fall through on error
        }

        // ── Jupiter /execute intercept ─────────────────────────────────────
        const isJupiterExecute = url && (
          url.includes('ultra-api.jup.ag/execute') ||
          url.includes('lite-api.jup.ag/ultra/v1/execute') ||
          // Catch any future jup.ag execute URL variants (gasless relay, etc.)
          (url.includes('.jup.ag') && url.includes('/execute') && !url.includes('/order'))
        );
        // Jupiter may pass a Request object as first arg (no `init`), or omit method entirely.
        // Fall back to resource?.method (Request object), then treat unknown as POST — the
        // execute endpoint is write-only; no GET ever reaches it in normal operation.
        const _execMethod = (init?.method ?? resource?.method ?? 'POST').toUpperCase();
        if (isJupiterExecute && _execMethod === 'POST' && !window.__zendiq_own_tx) {
          if (window.__zendiq_ws_confirmed) {
            // User proceeded through the ZendIQ overlay without optimising (normal jup.ag Swap flow:
            // wallet hook showed the overlay, user confirmed, wallet signed, jup.ag now calls /execute).
            // Tap the response to save an unoptimised trade card to Activity.
            window.__zendiq_ws_confirmed = false;
            const _snapRisk = ns._confirmRiskSnapshot ?? null;
            ns._confirmRiskSnapshot = null;
            return _captureConfirmTrade(resource, init, _snapRisk);
          } else if (ns.widgetSwapStatus === 'signing-original') {
            // signing-original state means the ZendIQ overlay already ran and the user already
            // confirmed — __zendiq_ws_confirmed should have been set but wasn't (race or gasless
            // relay path). Save the Activity entry without showing a second overlay.
            const _snapRisk2 = ns._confirmRiskSnapshot ?? ns.lastRiskResult ?? null;
            ns._confirmRiskSnapshot = null;
            return _captureConfirmTrade(resource, init, _snapRisk2);
          } else {
            try {
              const lq  = ns.jupiterLiveQuote;
              // Use live params; build from jupiterLiveQuote only as last resort.
              // Always write back so subsequent /order ticks keep mutating the same object.
              if (!window.__zendiq_last_order_params) {
                window.__zendiq_last_order_params = lq
                  ? { inputMint: lq.inputMint, outputMint: lq.outputMint, amount: String(lq.inAmount ?? '') }
                  : {};
              }
              const p = window.__zendiq_last_order_params;
              // Fill any missing fields from the live quote
              if (lq) {
                if (!p.inputMint  && lq.inputMint)  p.inputMint  = lq.inputMint;
                if (!p.outputMint && lq.outputMint) p.outputMint = lq.outputMint;
                if (!p.amount     && lq.inAmount)   p.amount     = String(lq.inAmount);
              }
              const risk = await _rescoreFromParams(p);
              const overlayInfo = { method: 'Jupiter Swap', params: [], orderParams: p, risk };
              const decision = await ns.showPendingTransaction(overlayInfo);
              if (decision === 'cancel') {
                return new Response(JSON.stringify({ error: 'Blocked by ZendIQ' }), {
                  status: 400, headers: { 'Content-Type': 'application/json' },
                });
              }
              if (decision === 'optimise') {
                return new Response(JSON.stringify({ error: 'Replaced by optimised route' }), {
                  status: 400, headers: { 'Content-Type': 'application/json' },
                });
              }
              // 'confirm' from the network-path overlay (fallback for non-wallet-hook flows)
              return _captureConfirmTrade(resource, init, risk);
            } catch (overlayErr) {
              console.error('[ZendIQ] /execute overlay error, falling through:', overlayErr?.message);
            }
          }
        }

        // ── RPC sendTransaction intercept ──────────────────────────────────
        const isRpc = url && (
          url.includes('api.mainnet-beta.solana.com') ||
          url.includes('.helius-rpc.com') ||
          url.includes('rpcpool')
        );

        if (isRpc && (methodName === 'sendTransaction' || methodName === 'send_raw_transaction') && !window.__zendiq_own_tx
            && !window.location.hostname.includes('pump.fun')) {
          // ── Raydium "Continue with original route" — tap RPC response for sig ──
          // Mirrors the lite version: signature lives in the sendTransaction fetch response
          // as data?.result ("{jsonrpc:…,result:'<BASE58_SIG>',id:…}").
          // __zendiq_ws_confirmed is set in page-interceptor.js BEFORE btn.click() so it’s
          // already true when this fetch fires (wallet hook short-circuits without clearing it).
          const _isRdmConfirmedFetch = (window.__zendiq_ws_confirmed || ns.widgetSwapStatus === 'signing-original')
                                    && url.includes('rpcpool') && !window.__zendiq_own_tx;
          if (_isRdmConfirmedFetch) {
            window.__zendiq_ws_confirmed = false;   // claim the flag
            const _rdmRisk   = ns._confirmRiskSnapshot ?? ns.lastRiskResult ?? null;
            ns._confirmRiskSnapshot = null;
            const _rdmLq     = ns.jupiterLiveQuote;
            const _rdmCt     = ns.widgetCapturedTrade;
            const _rdmRawOut = ns._rdmOriginalContext?.rawOut
                            ?? ns._rdmSignParams?._computeOutAmount
                            ?? (ns._rdmLastComputeOut != null ? Number(ns._rdmLastComputeOut) : null)
                            ?? ns._rdmMinAmountOut ?? null;
            const _TOKEN_DEC_R = { 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, 'So11111111111111111111111111111111111111112': 9 };
            const _TOKEN_SYM_R = { 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT', 'So11111111111111111111111111111111111111112': 'SOL' };
            const _rdmInMint  = _rdmCt?.inputMint  ?? window.__zendiq_last_order_params?.inputMint  ?? null;
            const _rdmOutMint = _rdmCt?.outputMint ?? window.__zendiq_last_order_params?.outputMint ?? null;
            const _rdmOutDec  = _rdmCt?.outputDecimals ?? (_TOKEN_DEC_R[_rdmOutMint] ?? 6);
            const _rdmInDec   = _rdmCt?.inputDecimals  ?? (_TOKEN_DEC_R[_rdmInMint]  ?? 9);
            const _rdmRawAmt  = window.__zendiq_last_order_params?.amount;
            const _rdmInAmt   = _rdmCt?.amountUI ?? (_rdmRawAmt != null ? Number(_rdmRawAmt) / Math.pow(10, _rdmInDec) : null);
            const _rdmOutAmt  = _rdmRawOut != null ? _rdmRawOut / Math.pow(10, _rdmOutDec) : null;
            const rdmResp = origFetch(resource, init);
            rdmResp.then(r => r.clone().json().then(data => {
              const sig = (typeof data?.result === 'string' && data.result.length >= 40) ? data.result : null;
              if (sig) {
                const entry = {
                  signature:      sig,
                  tokenIn:        _rdmCt?.inputSymbol  ?? _TOKEN_SYM_R[_rdmInMint]  ?? (_rdmInMint  ? _rdmInMint.slice(0, 6)  + '\u2026' : '?'),
                  tokenOut:       _rdmCt?.outputSymbol ?? _TOKEN_SYM_R[_rdmOutMint] ?? (_rdmOutMint ? _rdmOutMint.slice(0, 6) + '\u2026' : '?'),
                  amountIn:       _rdmInAmt  != null ? String(_rdmInAmt)  : null,
                  amountOut:      _rdmOutAmt != null ? String(_rdmOutAmt) : null,
                  quotedOut:      _rdmOutAmt != null ? String(_rdmOutAmt) : null,
                  optimized:      false,
                  timestamp:      Date.now(),
                  inputMint:      _rdmInMint,
                  outputMint:     _rdmOutMint,
                  outputDecimals: _rdmOutDec,
                  rawOutAmount:   _rdmRawOut != null ? String(_rdmRawOut) : null,
                  swapType:       'amm',
                  routeSource:    'raydium',
                  sandwichResult: null,  // populated via async HISTORY_UPDATE below
                  riskScore:      _rdmRisk?.score  ?? null,
                  riskLevel:      _rdmRisk?.level  ?? null,
                  riskFactors:    _rdmRisk?.factors ?? [],
                  mevFactors:     _rdmRisk?.mev?.factors ?? [],
                  mevRiskLevel:   _rdmRisk?.mev?.riskLevel ?? null,
                  mevRiskScore:   _rdmRisk?.mev?.riskScore ?? null,
                  mevEstimatedLossPercent: _rdmRisk?.mev?.estimatedLossPercentage ?? null,
                  inUsdValue:     _rdmLq?.inUsdValue  ?? null,
                  outUsdValue:    _rdmLq?.outUsdValue ?? null,
                };
                try { window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: entry } }, '*'); } catch (_) {}
                // Analytics: Raydium swap proceeded via original route
                try { if (ns.logProEvent) {
                  ns.logProEvent('swap_proceeded', {
                    site:      'raydium.io',
                    trade_usd: entry.inUsdValue != null ? Math.min(Number(entry.inUsdValue), 50000) : null,
                    profile:   ns.settingsProfile ?? 'unknown',
                    reason:    null,
                  });
                } } catch (_) {}
                // Structured trade record (routes to trades DB table)
                try { if (ns.logTrade) {
                  ns.logTrade({
                    user_action:  'proceeded',
                    dex:          'raydium.io',
                    exec_path:    'direct',
                    tx_sig:       sig,
                    input_mint:   _rdmInMint ?? null,
                    output_mint:  _rdmOutMint ?? null,
                    success:      1,
                    trade_usd:    entry.inUsdValue != null ? Math.min(Number(entry.inUsdValue), 50000) : null,
                    profile:      ns.settingsProfile ?? 'unknown',
                    bot_risk_score:    _rdmRisk?.score ?? null,
                    token_risk_score:  ns.tokenScoreResult?.score ?? null,
                    tx_classification: (function (lv) { return lv === 'LOW' ? 'safe' : lv === 'MEDIUM' ? 'caution' : lv ? 'danger' : null; })(_rdmRisk?.level),
                  });
                } } catch (_) {}
                ns.widgetOriginalTxSig = sig;
                ns.widgetLastTxSig     = sig;
                ns.widgetSwapStatus    = 'done-original';
                ns._rdmPostSwapIdle    = true;
                try { ns.renderWidgetPanel?.(); } catch (_) {}
                setTimeout(() => {
                  if (ns.widgetSwapStatus === 'done-original') {
                    ns.widgetSwapStatus = '';
                    const _bi = document.getElementById('sr-body-inner');
                    if (_bi) _bi.innerHTML = '';
                    try { ns.renderWidgetPanel?.(); } catch (_) {}
                  }
                }, 2000);
                if (ns.fetchActualOut && _rdmOutMint) {
                  (async () => {
                    try {
                      const _wp = ns.resolveWalletPubkey?.() ?? null;
                      const result = await ns.fetchActualOut(sig, _rdmOutMint, _wp, _rdmRawOut, _rdmOutDec);
                      if (!result) return;
                      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                        signature: sig, actualOutAmount: String(result.actualOut),
                        quoteAccuracy: result.quoteAccuracy, amountOut: String(result.actualOut),
                      }}}, '*');
                    } catch (_) {}
                  })();
                }
                // Sandwich detection — deduped by ns._sandwichPending so safe to call even if
                // page-raydium.js already fired it for the same signature.
                if (ns.detectSandwich && _rdmInMint && _rdmOutMint) {
                  (async () => {
                    try {
                      const result = await ns.detectSandwich(sig, _rdmInMint, _rdmOutMint, {
                        inputDecimals: _rdmInDec,
                        amountInUsd: _rdmLq?.inUsdValue ?? null,
                      });
                      if (!result) return;
                      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                        signature: sig, sandwichResult: result,
                      }}}, '*');
                      if (ns.logMev) {
                        const _iu = _rdmLq?.inUsdValue ?? null;
                        const _atkH = result.attackerWallet && ns.hashAddr
                          ? await ns.hashAddr(result.attackerWallet).catch(() => null) : null;
                        const _mevM = result.signals?.includes('bonding_curve_pda') ? 'bonding_curve_pda'
                                    : result.signals?.some(s => String(s).includes('vault')) ? 'vault_neighbor'
                                    : result.method === 'front-run' ? 'front_run_only' : 'unknown';
                        ns.logMev({ tx_sig: sig, detected: !!result.detected, loss_usd: result.extractedUsd ?? null,
                          loss_bps: result.extractedUsd && _iu ? Math.round(result.extractedUsd / _iu * 10000) : null,
                          attacker_hash: _atkH, method: _mevM, prevented_count: result.detected ? 1 : 0 });
                      }
                    } catch (_) {}
                  })();
                }
              } else {
                ns.widgetSwapStatus = '';
                ns.widgetOriginalSigningInfo = null;
                ns._rdmPostSwapIdle = true;
                try { ns.renderWidgetPanel?.(); } catch (_) {}
              }
            }).catch(() => {})).catch(() => {});
            return rdmResp;
          }

          let overlayInfo = { method: methodName || 'send', params: parsed?.params };

          try {
            const candidate = parsed?.params?.[0];
            if (typeof candidate === 'string' && window.ZendIQ?.decodeSignedTx) {
              const decoded = window.ZendIQ.decodeSignedTx(candidate);
              if (decoded && decoded.ok) {
                const best = decoded.findings.find(f => f.protocol === 'jupiter') || decoded.findings[0];
                if (best && best.decoded) {
                  const d = best.decoded;
                  const inRaw  = d.inAmount ?? d.amountIn;
                  const minRaw = d.minimumOutAmount ?? d.minimumAmountOut;
                  const mints  = new Set();
                  try {
                    const scanStr  = JSON.stringify(parsed);
                    const mintRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
                    let m;
                    while ((m = mintRegex.exec(scanStr)) !== null) {
                      if (m[0].length >= 32) mints.add(m[0]);
                    }
                  } catch (e) {}
                  overlayInfo.decoded = {
                    protocol: best.protocol,
                    inAmountRaw: inRaw,
                    minOutRaw: minRaw,
                    slippagePercent: d.slippagePercent,
                    detectedMints: Array.from(mints),
                    totalBytes: decoded.length,
                  };
                }
              }
            }
          } catch (e) {
            console.warn('[ZendIQ] Transaction decode attempt error', e?.message);
          }

          const decision = await ns.showPendingTransaction(overlayInfo);

          if (overlayInfo.decoded) {
            ns.addSwapToHistory({
              decision,
              amount:   overlayInfo.decoded.inAmountRaw ? overlayInfo.decoded.inAmountRaw / Math.pow(10, 9) : 0,
              slippage: overlayInfo.decoded.slippagePercent || 0,
              risk:     overlayInfo.risk || null,
            });

            if (overlayInfo.risk && (overlayInfo.risk.level === 'CRITICAL' || overlayInfo.risk.level === 'HIGH')) {
              const widget = document.getElementById('sr-widget');
              if (widget) {
                widget.classList.add('alert');
                const ps = widget.querySelector('#sr-pill-status');
                if (ps) { ps.textContent = 'Alert'; ps.style.color = '#FFB547'; }
              }
            }
          }

          if (decision === 'cancel') {
            return new Response(JSON.stringify({ error: 'Blocked by ZendIQ' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
        }
      } catch (e) {
        if (e?.message && !e.message.includes('Content-Security-Policy') && !e.message.includes('Failed to fetch')) {
          console.warn('[ZendIQ] fetch interception error', e);
        }
        throw e; // always rethrow so callers receive a proper rejection, not undefined
      }

      // ── Pump.fun transaction detection ──────────────────────────────────
      // Our wallet hooks (signTransaction / signAndSendTransaction) do NOT fire
      // on pump.fun — the site uses an internal wallet adapter that caches the
      // original signing methods before our hooks are installed.
      // Pump.fun submits signed txs to Jito block engines and Temporal/Nozomi
      // in parallel (8+ POSTs to */transactions). Jito JSON-RPC response format:
      // { jsonrpc: "2.0", result: "<base58_signature>" }
      // We tap the first successful response containing a signature.
      if (window.location.hostname.includes('pump.fun')
          && (ns.widgetSwapStatus === 'pump-signing' || ns.widgetSwapStatus === 'pump-sending' || ns.widgetSwapStatus === 'signing-original' || window.__zendiq_ws_confirmed)
          && typeof resource === 'string'
          && resource.includes('/transactions')) {
        const _pumpMethod = init?.method?.toUpperCase?.();
        if (_pumpMethod === 'POST') {
          // Extract signature from request body as fallback — the serialized tx's
          // first 64 bytes (after the 1-byte numSigners prefix) are the fee-payer sig.
          let _reqBodySig = null;
          try {
            const _body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            // Jito format: { jsonrpc, method: "sendTransaction", params: ["<base58_tx>"] }
            const _txB58 = _body?.params?.[0];
            if (typeof _txB58 === 'string' && _txB58.length > 100) {
              _reqBodySig = _txB58; // store full base58 tx — we'll extract sig if needed
              // ── Cache pump.fun fixed program accounts from this transaction ──────
              // Extract global state, fee recipient, and event authority addresses.
              // These are fixed per contract deployment but we capture from real txs
              // so we never rely solely on hardcoded values.
              if (!ns._pumpGlobalAccounts) {
                try {
                  const _B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
                  function _decB58(s) {
                    let n = 0n;
                    for (const c of s) { const idx = _B58A.indexOf(c); if (idx < 0) return null; n = n * 58n + BigInt(idx); }
                    const b = new Uint8Array(32);
                    for (let i = 31; i >= 0 && n > 0n; i--) { b[i] = Number(n & 0xffn); n >>= 8n; }
                    return b;
                  }
                  function _encB58(b) {
                    const d = [0]; for (let i = 0; i < b.length; i++) { let c = b[i]; for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
                    return d.reverse().map(x => _B58A[x]).join('');
                  }
                  const _txBytes = _decB58(_txB58);
                  if (_txBytes) {
                    // Parse: numSigs + sigs → header (3) → compact-u16 numAccts → account keys
                    let _off = 0;
                    const _ns2 = _txBytes[_off++] ?? 0;
                    _off += _ns2 * 64; // skip signatures
                    if (_txBytes[_off] >= 0x80) _off++; // skip v0 version byte
                    _off += 3; // skip header
                    let _na = _txBytes[_off++]; if (_na & 0x80) { _na = (_na & 0x7f) | (_txBytes[_off++] << 7); }
                    const _accts = [];
                    for (let i = 0; i < _na; i++) { _accts.push(_encB58(new Uint8Array(_txBytes.buffer, _txBytes.byteOffset + _off, 32))); _off += 32; }
                    // In a pump.fun buy tx, account order is typically:
                    // [user, global, feeRecip, mint, bondingCurve, assocBC, userATA, system, token, rent, eventAuth, program]
                    // We identify program by known address, then derive positions
                    const _PUMP_PROG = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
                    const _progIdx = _accts.indexOf(_PUMP_PROG);
                    if (_progIdx >= 0 && _accts.length >= 10) {
                      // Global = 2nd-to-last readonly unsigned acct (index progIdx-1 is event_auth, progIdx-2 is rent, etc.)
                      // More reliably: global is typically at index 1, feeRecip at 2, evtAuth at progIdx-1
                      ns._pumpGlobalAccounts = {
                        global:   _accts[1],
                        feeRecip: _accts[2],
                        evtAuth:  _accts[_progIdx - 1],
                      };
                    }
                  }
                } catch (_) {}
              }
            }
          } catch (_) {}

          const resp = await origFetch(resource, init);
          try {
            const _clone = resp.clone();
            _clone.text().then(_text => {
              // Already handled by a prior parallel request
              if (ns._pumpTxSigHandled) return;
              let sig = null;
              try {
                const data = JSON.parse(_text);
                // Jito JSON-RPC: { result: "<base58_signature>" }
                sig = data?.result ?? data?.signature ?? data?.txSignature ?? null;
                // Some endpoints return string result directly
                if (typeof sig === 'string' && sig.length >= 43 && sig.length <= 90) {
                  // valid base58 sig
                } else {
                  sig = null;
                }
              } catch (_) {
                // Response might be plain text signature
                if (typeof _text === 'string' && _text.length >= 43 && _text.length <= 90) {
                  sig = _text.trim();
                }
              }
              if (!sig) return;
              ns._pumpTxSigHandled = true; // prevent duplicate handling from parallel requests
              ns._pumpTxCooldownUntil = Date.now() + 10000; // suppress re-intercepts for 10s
              window.__zendiq_ws_confirmed = false;
              clearTimeout(ns._pumpSigningTimeout);
              const _wasOptimise = ns._pumpTxWasOptimised
                ?? (ns.widgetSwapStatus === 'pump-signing' && ns.pumpFunPatchedSlippage);
              ns._recordPumpActivity?.(sig, !!_wasOptimise);
              ns._pumpTxWasOptimised = false; // clear after use
              // Transition widget
              ns.widgetOriginalTxSig = sig;
              ns.widgetSwapStatus    = _wasOptimise ? 'pump-done' : 'done-original';
              ns.widgetActiveTab     = 'monitor';
              try { ns.renderWidgetPanel?.(); } catch (_) {}
              // Auto-dismiss after 2s
              clearTimeout(ns._pumpDoneTimer);
              ns._pumpDoneTimer = setTimeout(() => {
                if (ns.widgetSwapStatus === 'pump-done' || ns.widgetSwapStatus === 'done-original') {
                  ns.widgetSwapStatus = '';
                  ns.pumpFunContext    = null;
                  ns.pumpFunErrorMsg   = null;
                  ns._pumpTxSigHandled = false;
                  try { ns.renderWidgetPanel?.(); } catch (_) {}
                }
              }, 2000);
            }).catch(() => {});
          } catch (_) {}
          return resp;
        }
      }

      return origFetch(resource, init);
    };
  } catch (e) { console.warn('[ZendIQ] Could not override fetch', e); }

  // ── XHR override ────────────────────────────────────────────────────────
  // Skip the send override on pump.fun — all three intercept targets (Raydium compute,
  // Raydium send-tx, RPC sendTransaction) are irrelevant there. Installing it anyway
  // puts ZendIQ in every XHR call stack, making DevTools show page-network.js as the
  // initiator for pump.fun's own analytics and API calls.
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__sr_url = url;
      // ── pump.fun XHR response tap ──────────────────────────────────────
      // The send override is skipped on pump.fun to avoid DevTools attribution
      // noise, but adding a load listener HERE (in open) doesn't affect the
      // send call-site attribution.  Covers any pump.fun API call that goes
      // through XHR instead of window.fetch (e.g. /coins/{mint}, /trade/*).
      if (url && /pump\.fun/.test(url)) {
        this.addEventListener('load', function () {
          try {
            const j = ns.tryParseJson(this.responseText);
            if (!j || typeof j !== 'object') return;
            // (a) Explicit bonding curve fields
            const _bc  = j.bonding_curve ?? j.bondingCurve ?? null;
            const _abc = j.associated_bonding_curve ?? j.associatedBondingCurve ?? null;
            if (_bc && _abc && typeof _bc === 'string' && _bc.length > 30) {
              ns._pumpExtractedAccounts = { bondingCurve: _bc, assocBondingCurve: _abc };
              if (ns.pumpFunContext) { ns.pumpFunContext.bondingCurve = _bc; ns.pumpFunContext.assocBondingCurve = _abc; }
            }
            // (b) Base64 transaction bytes
            const _txB64 = j.transaction ?? j.tx ?? j.Transaction ?? null;
            if (_txB64 && typeof _txB64 === 'string' && _txB64.length > 100) {
              try {
                const _raw = atob(_txB64);
                const _bytes = new Uint8Array(_raw.length);
                for (let i = 0; i < _raw.length; i++) _bytes[i] = _raw.charCodeAt(i);
                if (_bytes.length > 100) {
                  const _ext = ns.activeSiteAdapter?.()?.parseTxAccounts?.(_bytes);
                  if (_ext?.bondingCurve) {
                    if (_ext.allKeys?.length > 8 && _ext.buyIxAcctIndices?.length > 10) {
                      ns._pumpTxTemplate = { allKeys: _ext.allKeys, buyIxAcctIndices: _ext.buyIxAcctIndices, msgHeader: _ext.msgHeader };
                    }
                    ns._pumpExtractedAccounts = _ext;
                    ns._pumpGlobalAccounts = { global: _ext.global, feeRecip: _ext.feeRecip, evtAuth: _ext.evtAuth };
                    if (ns.pumpFunContext) { ns.pumpFunContext.bondingCurve = _ext.bondingCurve; ns.pumpFunContext.assocBondingCurve = _ext.assocBondingCurve; }
                  }
                }
              } catch (_) {}
            }
          } catch (_) {}
        }, { passive: true });
      }
      return origOpen.apply(this, arguments);
    };
    if (window.location.hostname.includes('pump.fun')) {
      // open hook is enough on pump.fun; skip the send override entirely
    } else {
    XMLHttpRequest.prototype.send = function (body) {
      try {
        const url    = this.__sr_url || '';
        const parsed = ns.tryParseJson(body);
        // Tap Raydium compute/swap XHR responses to capture real outputAmount.
        // Raydium's React bundle calls /compute/swap-base-in via XHR (not fetch),
        // so the fetch override never sees it. We store the result in _rdmLastComputeOut
        // so onDecision (Proceed anyway) always has a quotedOut for Quote Accuracy.
        if (url && url.includes('raydium.io') && url.includes('/compute/')) {
          this.addEventListener('load', function () {
            try {
              const d = ns.tryParseJson(this.responseText);
              const rawOut = d?.data?.outputAmount ?? d?.data?.amountOut ?? d?.data?.outAmount
                          ?? d?.outputAmount ?? d?.amountOut ?? null;
              if (rawOut != null) ns._rdmLastComputeOut = String(rawOut);
            } catch (_) {}
          }, { passive: true });
        }
        // Let site adapters sniff any XHR request (e.g. Raydium compute API may use XHR)
        try { ns.activeSiteAdapter?.()?.onNetworkRequest?.(url, parsed); } catch (_) {}

        // ── Raydium send-tx XHR — transition widget to "sending…" state ──
        // The signed tx goes to service-v1.raydium.io/send-tx (XHR, response = {success:true}).
        // The real Solana signature comes from rpcpool.com/sendTransaction via fetch
        // (intercepted above). This handler ONLY advances the widget state; it does NOT
        // clear __zendiq_ws_confirmed (fetch handler owns that flag).
        const _isRdmSendTx = url.includes('raydium.io') && url.includes('send-tx') && !window.__zendiq_own_tx;
        if (_isRdmSendTx && (window.__zendiq_ws_confirmed || ns.widgetSwapStatus === 'signing-original')) {
          if (ns.widgetSwapStatus === 'signing-original') {
            if (ns._signingOriginalTimeout) { clearTimeout(ns._signingOriginalTimeout); ns._signingOriginalTimeout = null; }
            if (ns.widgetOriginalSigningInfo) ns.widgetOriginalSigningInfo._sending = true;
            ns.widgetCapturedTrade = null;
            ns.widgetLastOrder     = null;
            try { ns.renderWidgetPanel?.(); } catch (_) {}
          }
          return origSend.apply(this, arguments);
        }

        if (url.includes('api.mainnet-beta.solana.com') || url.includes('.helius-rpc.com') || url.includes('rpcpool.com')) {
          if (parsed?.method === 'sendTransaction' || parsed?.method === 'send_raw_transaction') {
            const xhr = this;
            ns.showPendingTransaction({ method: parsed.method, params: parsed.params }).then(decision => {
              if (decision === 'confirm') {
                origSend.call(xhr, body);
              } else {
                try { xhr.abort(); } catch (e) {}
              }
            });
            return;
          }
        }
      } catch (e) { console.warn('[ZendIQ] XHR interception error', e); }
      return origSend.apply(this, arguments);
    };
    } // end else (non-pump.fun)
  } catch (e) { console.warn('[ZendIQ] Could not override XHR', e); }
})();
