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

        // ── /order intercept — capture URL params then enrich from response body ──
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

        if (isRpc && (methodName === 'sendTransaction' || methodName === 'send_raw_transaction') && !window.__zendiq_own_tx) {
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
        if (e?.message && !e.message.includes('Content-Security-Policy')) {
          console.warn('[ZendIQ] fetch interception error', e);
        }
      }
      return origFetch(resource, init);
    };
  } catch (e) { console.warn('[ZendIQ] Could not override fetch', e); }

  // ── XHR override ────────────────────────────────────────────────────────
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__sr_url = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        const url    = this.__sr_url || '';
        const parsed = ns.tryParseJson(body);
        // Let site adapters sniff any XHR request (e.g. Raydium compute API may use XHR)
        try { ns.activeSiteAdapter?.()?.onNetworkRequest?.(url, parsed); } catch (_) {}
        if (url.includes('api.mainnet-beta.solana.com') || url.includes('.helius-rpc.com')) {
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
  } catch (e) { console.warn('[ZendIQ] Could not override XHR', e); }
})();
