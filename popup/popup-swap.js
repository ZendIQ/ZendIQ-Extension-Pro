/**
 * ZendIQ popup — swap
 * Quote fetching (Ultra /order) and transaction signing + execution (Ultra /execute).
 */

// ── Local risk estimate (popup-side, no interceptor available here) ────────
function scoreRisk(quote, amountIn, tok) {
  let score = 0;
  const pi = parseFloat(quote.priceImpactPct ?? 0);
  const mc = ['BONK','WIF','SAMO','MYRO','POPCAT'].includes(tok?.symbol);
  if (pi >= 2)  score += 35; else if (pi >= 0.5) score += 15;
  if (mc)       score += 25;
  if (amountIn >= 10) score += 10;
  score = Math.min(100, Math.max(0, score));
  const level = score >= 70 ? 'CRITICAL' : score >= 40 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW';
  return { score, level };
}

// ── Fetch a Jupiter Ultra /order inside the page context ────────────────────
async function _fetchUltraOrder(tab, url) {
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (u) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(1500 * attempt);
        try {
          const res = await fetch(u);
          if (res.status === 429 || res.status === 503) {
            if (attempt < 2) continue; // retry
            return { error: 'Jupiter API is busy — try again in a moment' };
          }
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { error: 'HTTP ' + res.status + (text ? ': ' + text.slice(0, 100) : '') };
          }
          const data = await res.json();
          if (data.error) return { error: String(data.error) };
          return { ok: true, data };
        } catch (e) { return { error: e.message }; }
      }
      return { error: 'Jupiter API is busy — try again in a moment' };
    },
    args: [url],
  });
  const r = result?.[0]?.result;
  if (!r?.ok) throw new Error(r?.error || 'Order fetch failed');
  return r.data;
}

// ── Get Quote via Ultra /order ─────────────────────────────────────────────
async function getQuote() {
  resetQuote();
  const amountIn = parseFloat(document.getElementById('amount-in').value);
  if (!amountIn || amountIn <= 0)         { setStatus('Enter an amount', 'err'); return; }
  if (tokenIn.symbol === tokenOut.symbol) { setStatus('Select different tokens', 'err'); return; }

  const btn = document.getElementById('btn-quote');
  btn.disabled = true;
  setStatus('Getting order…', 'load');

  try {
    const tab = await findDexTab();
    if (!tab?.id) throw new Error('No jup.ag or raydium tab found — open one first');

    // Resolve wallet pubkey in page context (needed for taker param)
    const pkRes = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        try {
          const getPubkey = (w) => {
            const pk = w?.publicKey;
            if (!pk) return null;
            const s = typeof pk === 'string' ? pk : (pk?.toBase58?.() ?? pk?.toString?.());
            return (s && s.length >= 32) ? s : null;
          };
          const legacy = [
            window.phantom?.solana, window.solflare,
            window.backpack?.solana, window.jupiterWallet, window.jupiter?.solana,
            window.solana,
          ].filter(Boolean);
          for (const w of legacy) {
            const s = getPubkey(w);
            if (s) return { pubkey: s };
          }
          for (const w of legacy) {
            if (typeof w.connect === 'function' && !w.isBraveWallet) {
              try { await w.connect({ onlyIfTrusted: true }); const s = getPubkey(w); if (s) return { pubkey: s }; } catch (_) {}
            }
          }
          const stdWallets = [];
          window.addEventListener('wallet-standard:register-wallet', (e) => {
            if (typeof e?.detail?.register === 'function') e.detail.register({ register(w) { stdWallets.push(w); } });
          });
          try {
            window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
              detail: { register(w) { stdWallets.push(w); } },
            }));
          } catch (_) {}
          for (const w of stdWallets) {
            for (const acc of (w?.accounts ?? [])) {
              const addr = acc?.address ?? acc?.publicKey?.toString?.();
              if (addr && addr.length >= 32) return { pubkey: String(addr) };
            }
          }
          return { error: 'not_connected' };
        } catch (e) { return { error: e.message }; }
      },
    });

    const pk = pkRes?.[0]?.result;
    if (!pk?.pubkey) throw new Error(
      pk?.error === 'not_connected' ? 'Connect your wallet on jup.ag first' : 'Could not read wallet pubkey'
    );
    walletPubkey = pk.pubkey;

    const lamports = Math.round(amountIn * Math.pow(10, tokenIn.decimals));
    const baseUrl  = ULTRA_ORDER_URL +
      `?inputMint=${tokenIn.mint}&outputMint=${tokenOut.mint}` +
      `&amount=${lamports}&slippageBps=${SLIPPAGE_BPS}&taker=${walletPubkey}`;

    // Phase 1 — fetch with no manual priority fee, let Jupiter auto-manage to get real price impact
    let order = await _fetchUltraOrder(tab, baseUrl);
    if (!order.transaction) throw new Error('No transaction in order response');
    if (!order.requestId)   throw new Error('No requestId in order response');

    // Score using real price impact from phase-1 response
    const riskPre     = scoreRisk(order, amountIn, tokenOut);
    const STABLES_PU  = new Set(['USDC','USDT']);
    const tradeUsd    = STABLES_PU.has(tokenIn.symbol) ? amountIn : null;
    const { priorityFeeLamports, jitoTipLamports } = calcDynamicFees({
      riskScore:      riskPre.score,
      priceImpactPct: parseFloat(order.priceImpactPct ?? 0),  // raw fraction from Jupiter
      tradeUsd,
      jitoMode,
    });
    let priorityFee = priorityFeeLamports ?? 0;
    let useJitoTip  = !!jitoTipLamports;

    // Phase 2 — re-fetch with dynamic fees only if non-trivial
    if (priorityFee > 0 || useJitoTip) {
      const lvl = riskPre.level;
      setStatus(`${lvl === 'CRITICAL' ? 'Critical' : lvl === 'HIGH' ? 'High' : 'Medium'} risk — optimising priority fee${useJitoTip ? ' + Jito tip' : ''}…`, 'load');
      const feeUrl = baseUrl +
        (priorityFee  ? `&priorityFeeLamports=${priorityFee}` : '') +
        (useJitoTip   ? `&jitoTipLamports=${jitoTipLamports}` : '');
      order = await _fetchUltraOrder(tab, feeUrl);
      if (!order.transaction) throw new Error('No transaction in re-fetched order response');
      if (!order.requestId)   throw new Error('No requestId in re-fetched order response');
    }

    lastOrder = order;

    // Render quote info
    const outAmt  = parseInt(order.outAmount) / Math.pow(10, tokenOut.decimals);
    const pi      = parseFloat(order.priceImpactPct ?? 0);
    const minOut  = parseInt(order.otherAmountThreshold ?? order.outAmount) / Math.pow(10, tokenOut.decimals);
    const route   = order.routePlan?.map(r => r.swapInfo?.label).filter(Boolean).join(' → ') || 'Jupiter Ultra';
    const risk    = scoreRisk(order, amountIn, tokenOut);
    const cols    = { CRITICAL:'#FF4D4D', HIGH:'#FFB547', MEDIUM:'#9945FF', LOW:'#14F195' };
    const col     = cols[risk.level];

    document.getElementById('amount-out').value          = outAmt.toFixed(tokenOut.decimals <= 6 ? 4 : 6);
    document.getElementById('q-rate').textContent        = `1 ${tokenIn.symbol} = ${(outAmt/amountIn).toFixed(4)} ${tokenOut.symbol}`;
    document.getElementById('q-impact').textContent      = pi.toFixed(3) + '%';
    document.getElementById('q-impact').className        = 'q-val ' + (pi >= 2 ? 'r' : pi >= 0.5 ? 'o' : 'g');
    document.getElementById('q-min').textContent         = minOut.toFixed(4) + ' ' + tokenOut.symbol;
    document.getElementById('q-route').textContent       = route;
    const _riskTip = `ZendIQ Risk Score: ${risk.score}/100\nLevel: ${risk.level}  (LOW: 0\u201324 | MEDIUM: 25\u201349 | HIGH: 50\u201374 | CRITICAL: 75+)` +
      ((risk.factors ?? []).length ? '\n\nTop factors:\n' + (risk.factors ?? []).slice(0, 3).map(f => `\u2022 ${f.name} [${f.severity}]`).join('\n') : '');
    document.getElementById('q-risk').innerHTML          =
      `<span class="risk-pill" style="background:${col}18;border:1px solid ${col}44;color:${col};cursor:help" title="${_riskTip.replace(/"/g, '&quot;').replace(/\n/g, '&#10;')}">` +
      `<span class="risk-dot" style="background:${col}"></span>${risk.level} · ${risk.score}/100</span>`;
    const qPri     = document.getElementById('q-priority');
    const qJitoTip = document.getElementById('q-jito-tip');
    const qJitoRow = document.getElementById('q-jito-row');
    if (qPri) {
      if (useJitoTip) {
        qPri.textContent = `${(PRIORITY_FEE_HIGH / 1e9).toFixed(5)} SOL`;
        qPri.className   = 'q-val o';
        if (qJitoRow)  qJitoRow.style.display  = '';
        if (qJitoTip) {
          qJitoTip.textContent = `${(JITO_TIP_HIGH / 1e9).toFixed(5)} SOL`;
          qJitoTip.className   = 'q-val o';
        }
      } else {
        qPri.textContent = `${(PRIORITY_FEE_LOW / 1e9).toFixed(5)} SOL`;
        qPri.className   = 'q-val g';
        if (qJitoRow) qJitoRow.style.display = 'none';
      }
    }

    document.getElementById('quote-box').classList.add('show');
    document.getElementById('btn-swap').classList.add('show');
    setStatus('Order ready — transaction pre-built for your wallet', '');

    // ── Savings callout ──────────────────────────────────────────────────────
    // Impact cost: exact tokens lost to market price impact (from Jupiter's own data).
    const impactCostTokens = outAmt * (pi / 100);
    // Estimated savings vs. a naive single-pool swap: Jupiter Ultra multi-hop
    // routing typically recovers ~35% of price impact vs. an unoptimised single route.
    // Labelled "(est.)" to be transparent this is an approximation.
    const estSavingsTokens = impactCostTokens * 0.35;

    const qImpactCost = document.getElementById('q-impact-cost');
    const qEstSavings = document.getElementById('q-est-savings');
    const qMevShield  = document.getElementById('q-mev-shield');
    const savingsBox  = document.getElementById('savings-box');

    if (qImpactCost) {
      if (impactCostTokens > 0.00001) {
        qImpactCost.className   = pi >= 2 ? 'sav-val r' : pi >= 0.5 ? 'sav-val o' : 'sav-val m';
        qImpactCost.textContent = `-${impactCostTokens.toFixed(4)} ${tokenOut.symbol} (${pi.toFixed(2)}%)`;
      } else {
        qImpactCost.className   = 'sav-val g';
        qImpactCost.textContent = `< 0.00001 ${tokenOut.symbol} (\u2248 none)`;
      }
    }

    if (qEstSavings) {
      if (estSavingsTokens > 0.000001) {
        qEstSavings.className   = 'sav-val g';
        qEstSavings.textContent = `+${estSavingsTokens.toFixed(4)} ${tokenOut.symbol} (est.)`;
      } else {
        qEstSavings.className   = 'sav-val m';
        qEstSavings.textContent = 'negligible';
      }
    }

    if (qMevShield) {
      if (useJitoTip) {
        qMevShield.className = 'sav-val g';
        qMevShield.innerHTML = `Active <span class="sav-badge mev-on">&#9673; Jito tip</span>`;
      } else {
        qMevShield.className = 'sav-val m';
        qMevShield.innerHTML = `Standard <span class="sav-badge mev-off">low risk</span>`;
      }
    }

    if (savingsBox) savingsBox.classList.add('show');

    // Annotate lastOrder with metadata so handleSwapSuccess can persist it
    lastOrder._fees             = { priorityFeeLamports: priorityFee, jitoTipLamports: jitoTipLamports ?? 0 };
    lastOrder._riskScore        = risk.score;
    lastOrder._riskLevel        = risk.level;
    lastOrder._riskFactors      = risk.factors ?? [];
    lastOrder._mevFactors       = risk.mev?.factors ?? [];
    lastOrder._mevRiskLevel     = risk.mev?.riskLevel ?? null;
    lastOrder._mevRiskScore     = risk.mev?.score ?? null;
    lastOrder._priceImpactPct   = pi;
    lastOrder._estSavingsTokens = estSavingsTokens;
    lastOrder._outputDecimals   = tokenOut.decimals;

    // Derive USD prices from the order response — no external price API needed.
    // Jupiter's /order always includes inUsdValue / outUsdValue on successful quotes.
    try {
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const inAmt  = amountIn; // already human-readable
      const outAmt = parseInt(order.outAmount) / Math.pow(10, tokenOut.decimals);
      const iprice = (order.inUsdValue  != null && inAmt  > 0) ? order.inUsdValue  / inAmt  : null;
      const oprice = (order.outUsdValue != null && outAmt > 0) ? order.outUsdValue / outAmt : null;
      const sprice = tokenIn.mint  === SOL_MINT ? iprice
                   : tokenOut.mint === SOL_MINT ? oprice
                   : null;
      lastOrder._priceData = {
        inputPriceUsd:  iprice,
        outputPriceUsd: oprice,
        solPriceUsd:    sprice,
        amountInUsd:    order.inUsdValue ?? null,
      };
    } catch (_) { lastOrder._priceData = {}; }

  } catch (e) {
    setStatus('Error: ' + (e.message || 'unknown'), 'err');
    console.error('[ZendIQ] getQuote error:', e);
  } finally {
    document.getElementById('btn-quote').disabled = false;
  }
}

// ── // ── Sign & Execute via Ultra /execute ──────────────────────────────────────
async function sendSwap() {
  if (!lastOrder) { setStatus('Get an order first', 'err'); return; }

  const btn = document.getElementById('btn-swap');
  btn.disabled = true;

  try {
    const tab = await findDexTab();
    if (!tab?.id) throw new Error('No jup.ag tab found');

    const txBase64  = lastOrder.transaction;
    const requestId = lastOrder.requestId;

    setStatus('Approve in your wallet…', 'load');

    // ── Sign the swap transaction in page context ────────────────────────
    const signResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (b64) => {
        try {
          window.__zendiq_own_tx = true;
          const swapBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

          const toB64 = (tx) => {
            const raw = tx?.serialize ? tx.serialize() : (tx instanceof Uint8Array ? tx : null);
            if (!raw) return null;
            let bin = ''; for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
            return btoa(bin);
          };

          // Find VersionedTransaction on jup.ag's bundled web3.js
          let VersionedTransaction = null;
          for (const key of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
            if (window[key]?.VersionedTransaction) { VersionedTransaction = window[key].VersionedTransaction; break; }
          }
          if (!VersionedTransaction) {
            for (const key of Object.keys(window)) {
              try {
                const obj = window[key];
                if (obj && typeof obj === 'object' && typeof obj.VersionedTransaction?.deserialize === 'function') {
                  VersionedTransaction = obj.VersionedTransaction; break;
                }
              } catch (_) {}
            }
          }

          // Path A: Wallet Standard
          const ns = window.__zq ?? {};
          const stdWallets = ns._wsWallet ? [ns._wsWallet] : [];
          try {
            window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',
              { detail: { register(w) { if (!stdWallets.includes(w)) stdWallets.push(w); } } }));
          } catch (_) {}

          for (const w of stdWallets) {
            const feat = w?.features?.['solana:signTransaction'];
            // Use || so an empty array [] also triggers the fallback (Phantom sometimes returns [])
            const accs = (w?.accounts?.length ? w.accounts : null) || (ns._wsAccount ? [ns._wsAccount] : []);
            if (!feat?.signTransaction || !accs.length) continue;
            try {
              const [res] = await feat.signTransaction({ account: accs[0], transaction: swapBytes, chain: 'solana:mainnet' });
              const signed = res?.signedTransaction;
              if (signed) return { signedTransaction: toB64(new Uint8Array(signed)) };
            } catch (e) {
              if (/reject|cancel|denied|abort/i.test(e?.message ?? '')) return { error: 'cancelled' };
            }
            const sendFeat = w?.features?.['solana:signAndSendTransaction'];
            if (sendFeat?.signAndSendTransaction) {
              const accs2 = (w?.accounts?.length ? w.accounts : null) || (ns._wsAccount ? [ns._wsAccount] : []);
              if (!accs2.length) continue;
              try {
                const [out] = await sendFeat.signAndSendTransaction({ account: accs2[0], transaction: swapBytes, chain: 'solana:mainnet' });
                const sig = out?.signature;
                if (sig) return { skippedExecute: true, signature: typeof sig === 'string' ? sig : btoa(String.fromCharCode(...new Uint8Array(sig))) };
              } catch (e) {
                if (/reject|cancel|denied|abort/i.test(e?.message ?? '')) return { error: 'cancelled' };
              }
            }
          }

          // Path B: legacy wallet
          // VersionedTransaction.deserialize is preferred; fall back to raw Uint8Array
          // (Phantom's legacy adapter accepts raw bytes in modern versions)
          const wallet = window.phantom?.solana || window.solflare || window.backpack?.solana
            || window.jupiterWallet || window.jupiter?.solana || window.okxwallet?.solana || window.solana;
          if (wallet) {
            const txToSign = VersionedTransaction ? VersionedTransaction.deserialize(swapBytes) : swapBytes;
            try {
              if (wallet.signTransaction) {
                const signed = await wallet.signTransaction(txToSign);
                const b64 = toB64(signed);
                if (b64) return { signedTransaction: b64 };
              }
              if (wallet.signAndSendTransaction) {
                const r = await wallet.signAndSendTransaction(txToSign, { isVersioned: true });
                const sig = r?.signature ?? (typeof r === 'string' ? r : null);
                if (sig) return { skippedExecute: true, signature: sig };
              }
            } catch (e) {
              if (/reject|cancel|denied|abort/i.test(e?.message ?? '')) return { error: 'cancelled' };
              // If raw-bytes failed and we haven't tried deserialized form yet, retry with it
              if (!VersionedTransaction) throw e;
            }
          }

          return { error: 'No wallet could sign the transaction. Make sure your wallet is connected.' };
        } catch (e) {
          return { error: e?.message ?? String(e) };
        } finally {
          window.__zendiq_own_tx = false;
        }
      },
      args: [txBase64],
    });

    const signData = signResult?.[0]?.result;
    if (!signData)                       throw new Error('No response from page');
    if (signData.error === 'cancelled')  {
      setStatus('Rejected in wallet', 'err');
      setTimeout(() => {
        const _s = document.getElementById('sw-status');
        if (_s && _s.textContent === 'Rejected in wallet') setStatus('', '');
      }, 2000);
      return;
    }
    if (signData.error)                  throw new Error(signData.error);

    if (signData.skippedExecute) {
      handleSwapSuccess(signData.signature);
      return;
    }

    setStatus('Sending to Jupiter…', 'load');

    const executeResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (signedTransaction, reqId, executeUrl) => {
        try {
          window.__zendiq_own_tx = true;
          const res = await fetch(executeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signedTransaction, requestId: reqId }),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { error: 'HTTP ' + res.status + (text ? ': ' + text.slice(0, 100) : '') };
          }
          return { ok: true, data: await res.json() };
        } catch (e) { return { error: e.message }; }
        finally { window.__zendiq_own_tx = false; }
      },
      args: [signData.signedTransaction, requestId, ULTRA_EXECUTE_URL],
    });

    const execData = executeResult?.[0]?.result;
    if (!execData?.ok) throw new Error(execData?.error || 'Execute failed');

    const execResponse = execData.data;
    if (execResponse.status === 'Success') {
      handleSwapSuccess(execResponse.signature);
    } else if (execResponse.status === 'Failed') {
      const detail = [execResponse.error, execResponse.code].filter(Boolean).join(' / ');
      throw new Error('Swap failed on-chain: ' + (detail || 'unknown error'));
    } else {
      handleSwapSuccess(execResponse.signature ?? 'pending');
    }

  } catch (e) {
    setStatus(e.message || 'Swap failed', 'err');
    console.error('[ZendIQ] sendSwap error:', e);
  } finally {
    document.getElementById('btn-swap').disabled = false;
  }
}
function handleSwapSuccess(signature) {
  setStatus('Swap Successful', 'ok');

  // ── Success panel ────────────────────────────────────────────────────────
  (function _showSuccessPanel() {
    const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const panel   = document.getElementById('panel-swap');
    const sp      = panel?.querySelector('.sp');
    const hint    = panel?.querySelector('.how-hint');
    if (!panel) return;
    if (sp)   sp.style.display   = 'none';
    if (hint) hint.style.display = 'none';
    const existing = panel.querySelector('#zq-swap-success');
    if (existing) existing.remove();
    const amtIn  = _esc(document.getElementById('amount-in')?.value ?? '');
    const amtOut = _esc(document.getElementById('amount-out')?.value ?? '');
    const symIn  = _esc(tokenIn?.symbol  ?? '');
    const symOut = _esc(tokenOut?.symbol ?? '');
    const shortFull = signature ? (signature.slice(0,8) + '\u2026' + signature.slice(-4)) : null;
    const solscanUrl = signature ? ('https://solscan.io/tx/' + _esc(signature)) : null;
    const el = document.createElement('div');
    el.id = 'zq-swap-success';
    el.style.cssText = 'padding:24px 16px;text-align:center';
    el.innerHTML = `
      <div style="font-size:15px;font-weight:700;color:#14F195;margin-bottom:6px">Swap Successful</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">${amtIn} ${symIn} \u2192 ${amtOut} ${symOut}</div>
      ${solscanUrl ? `<a href="${solscanUrl}" target="_blank" rel="noopener" style="display:inline-block;margin-bottom:18px;font-size:var(--fs-base);color:#9945FF;text-decoration:none;font-family:monospace" title="View on Solscan">${shortFull} \u2197</a>` : '<div style="margin-bottom:18px"></div>'}
      <button id="zq-btn-new-swap" style="width:100%;padding:11px;border:1px solid rgba(20,241,149,0.3);border-radius:8px;background:rgba(20,241,149,0.08);color:#14F195;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">+ New Swap</button>`;
    panel.appendChild(el);
    const _dismissSuccess = () => {
      if (panel.contains(el)) {
        el.remove();
        if (sp)   sp.style.display   = '';
        if (hint) hint.style.display = '';
        resetQuote();
      }
    };
    const _autoCloseTimer = setTimeout(_dismissSuccess, 2000);
    document.getElementById('zq-btn-new-swap').addEventListener('click', () => {
      clearTimeout(_autoCloseTimer);
      _dismissSuccess();
    });
  })();
  // ── end success panel ────────────────────────────────────────────────────
  const entry = {
    signature,
    tokenIn:   tokenIn.symbol,
    tokenOut:  tokenOut.symbol,
    amountIn:  document.getElementById('amount-in').value,
    amountOut: document.getElementById('amount-out').value,
    quotedOut: document.getElementById('amount-out').value,
    optimized: !!(lastOrder && lastOrder.routePlan),
    timestamp: Date.now(),
    solscanUrl: signature ? ('https://solscan.io/tx/' + signature) : null,
    outputMint:  tokenOut?.mint ?? null,
    // Fee / risk / savings metadata
    priorityFeeLamports:  lastOrder?._fees?.priorityFeeLamports  ?? PRIORITY_FEE_LOW,
    jitoTipLamports:      lastOrder?._fees?.jitoTipLamports       ?? 0,
    riskScore:            lastOrder?._riskScore        ?? null,
    riskLevel:            lastOrder?._riskLevel        ?? null,
    riskFactors:          lastOrder?._riskFactors      ?? [],
    mevFactors:           lastOrder?._mevFactors       ?? [],
    mevRiskLevel:         lastOrder?._mevRiskLevel     ?? null,
    mevRiskScore:         lastOrder?._mevRiskScore     ?? null,
    priceImpactPct:       lastOrder?._priceImpactPct   ?? null,
    estSavingsTokens:     lastOrder?._estSavingsTokens ?? null,
    rawOutAmount:         lastOrder?.outAmount          ?? null,
    outputDecimals:       lastOrder?._outputDecimals    ?? tokenOut?.decimals ?? 6,
    // USD price data for savings breakdown tooltip
    ...(lastOrder?._priceData ?? {}),
  };

  // Persist last swap and append to history
  chrome.storage.local.set({ sendiq_last_swap: entry });
  chrome.storage.local.get(['sendiq_swap_history'], ({ sendiq_swap_history: hist = [] }) => {
    try {
      hist = Array.isArray(hist) ? hist : [];
      hist.unshift(entry);
      if (hist.length > 200) hist = hist.slice(0, 200);
      chrome.storage.local.set({ sendiq_swap_history: hist });
    } catch (e) { console.warn('[ZendIQ] save history failed', e); }
  });

  // Notify page (via background bridge) so widget can update in real-time
  try { chrome.runtime.sendMessage({ type: 'HISTORY_UPDATE', payload: entry }); } catch (_) {}

  // Async: fetch actual on-chain output from Solana RPC and enrich the history entry
  const _enrichSig     = signature;
  const _enrichMint    = tokenOut?.mint ?? null;
  const _enrichWallet  = walletPubkey ?? null;
  const _enrichRawOut  = lastOrder?.outAmount != null ? Number(lastOrder.outAmount) : null;
  const _enrichDec     = lastOrder?._outputDecimals ?? tokenOut?.decimals ?? 6;
  (async () => {
    if (!_enrichSig || !_enrichMint || !_enrichWallet) return;
    // Async helper: send RPC call via background service worker
    const _rpcCall = (method, params) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'RPC_CALL', method, params }, res => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (res?.ok) resolve(res.data);
        else reject(new Error(res?.error ?? 'RPC failed'));
      });
    });
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const isSOL = _enrichMint === SOL_MINT;
    let actualOut = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 0 ? 3000 : 2000));
      try {
        const res = await _rpcCall('getTransaction', [
          _enrichSig,
          { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
        ]);
        const tx = res?.result;
        if (!tx?.meta) continue;
        const meta = tx.meta;
        if (isSOL) {
          const msg  = tx.transaction?.message ?? {};
          const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
          const idx  = keys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === _enrichWallet);
          if (idx >= 0) {
            const received = (meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0) + (meta.fee ?? 0);
            if (received > 0) actualOut = received / 1e9;
          }
        } else {
          const post = meta.postTokenBalances ?? [];
          const pre  = meta.preTokenBalances  ?? [];
          const postEntry = post.find(e => e.mint === _enrichMint && e.owner === _enrichWallet);
          const preEntry  = pre.find(e  => e.mint === _enrichMint && e.owner === _enrichWallet);
          if (postEntry) {
            const diff = (postEntry.uiTokenAmount?.uiAmount ?? 0) - (preEntry?.uiTokenAmount?.uiAmount ?? 0);
            if (diff > 0) actualOut = diff;
          }
        }
        break; // tx found — exit loop regardless
      } catch (_) { /* retry */ }
    }
    if (actualOut == null) return;
    const quoteAccuracy = (_enrichRawOut > 0 && _enrichDec != null)
      ? Math.min(100, (actualOut / (_enrichRawOut / Math.pow(10, _enrichDec))) * 100)
      : null;
    const extra = { actualOutAmount: String(actualOut), amountOut: String(actualOut), quoteAccuracy };
    // Update stored history entry and re-broadcast so widget refreshes
    chrome.storage.local.get(['sendiq_swap_history'], ({ sendiq_swap_history: hist = [] }) => {
      try {
        hist = Array.isArray(hist) ? hist : [];
        const idx = hist.findIndex(h => h.signature === _enrichSig);
        if (idx >= 0) hist[idx] = Object.assign({}, hist[idx], extra);
        else hist.unshift(Object.assign({}, entry, extra));
        if (hist.length > 200) hist = hist.slice(0, 200);
        chrome.storage.local.set({ sendiq_swap_history: hist });
        try { chrome.runtime.sendMessage({ type: 'HISTORY_UPDATE', payload: Object.assign({ signature: _enrichSig }, extra) }); } catch (_) {}
      } catch (e) { console.warn('[ZendIQ] enrich history failed', e); }
    });
  })();
  lastOrder = null;
  document.getElementById('btn-swap').classList.remove('show');
}
