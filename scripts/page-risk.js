/**
 * ZendIQ – risk.js
 * Token metadata lookup, network context fetching, and the risk scoring engine.
 */

(function () {
  const ns = window.__zq;

  // ── Lookup token metadata (memecoin detection) ──────────────────────────────
  async function getTokenMetadata(mint) {
    try {
      const supply          = await ns.rpcCall('getTokenSupply', [mint]);
      const largestAccounts = await ns.rpcCall('getTokenLargestAccounts', [mint]);

      if (!supply?.result) return null;

      const totalSupply     = parseInt(supply.result.value.amount);
      const holders         = largestAccounts?.result?.value?.length ?? 0;
      const topHolderShare  = largestAccounts?.result?.value?.[0]?.uiAmount ?? 0;
      const supplyDecimals  = supply.result.value.decimals;

      const isMemecoin = (holders < 100 && topHolderShare > 0.3) || (holders < 50);

      return { mint, totalSupply, holders, topHolderShare, decimals: supplyDecimals, isMemecoin };
    } catch (e) {
      console.warn('[ZendIQ] Token metadata lookup failed:', e);
      return null;
    }
  }

  // ── Fetch live network context ─────────────────────────────────────────────
  // NOTE: We intentionally do not make outbound RPC calls here.
  // jup.ag enforces a strict connect-src CSP that blocks requests to helius-rpc.com
  // and api.mainnet-beta.solana.com — any fetch attempt causes a visible CSP error.
  // The congestion field only adds +20 to the risk score in the 'high' case,
  // so defaulting to 'normal' is a safe trade-off. If live congestion data is
  // needed in future it should route through the background service worker.
  async function fetchDevnetContext(_txInfo) {
    return { network: ns.NETWORK, congestion: 'normal', slot: 0, avgTps: 0 };
  }

  // ── Risk calculator ────────────────────────────────────────────────────────
  // Mints used for pair-type and memecoin detection (shared with calculateMEVRisk)
  const STABLE_MINTS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  ]);
  const MEMECOIN_MINTS = new Set([
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  ]);

  async function calculateRisk(txInfo, context) {
    let score = 0;
    const factors = [];

    // Congestion — always shown
    if (context.congestion === 'high') {
      score += 20;
      factors.push({ name: 'High network congestion', severity: 'MEDIUM', lossContrib: 0.003 });
    } else {
      factors.push({ name: 'Network congestion: normal', severity: 'LOW', lossContrib: 0 });
    }

    // Account count — only shown when complex
    if ((txInfo.accountCount ?? 0) > 10) {
      score += 15;
      factors.push({ name: 'Complex transaction', severity: 'MEDIUM', lossContrib: 0.002 });
    }

    const swapInfo = txInfo.swapInfo;
    let realSlippage = null;
    let realAmount   = null;

    if (swapInfo?.slippagePercent !== null && swapInfo?.slippagePercent !== undefined) {
      realSlippage = swapInfo.slippagePercent;
    }
    if (swapInfo?.inAmount !== null && swapInfo?.inAmount !== undefined) {
      realAmount = swapInfo.inAmount;  // already in human-readable units (divided at capture time)
    }

    const swapSlippage   = realSlippage ?? 0;    // fallback: 0 (auto-slippage) — hits 'Slippage: none / auto' branch
    const swapAmount     = realAmount   ?? 10;   // fallback: 10 SOL
    // Use USD-normalised amount for loss contributions so estimatedLoss is always in USD
    // null when price fetch failed — avoids treating non-SOL tokens as $140 SOL
    const swapAmountUsd  = swapInfo?.inAmountUsd ?? null;
    // Memecoin detection: only flag when the output mint is a known memecoin token.
    // A missing/undecodeable swapInfo is NOT evidence of a memecoin — it just means
    // ZendIQ couldn't parse the tx format. That earns a small MEDIUM flag, not CRITICAL.
    const outputMint     = swapInfo?.outputMint ?? null;
    const likelyMemecoin = outputMint ? MEMECOIN_MINTS.has(outputMint) : false;
    const unknownTxFormat = !swapInfo;

    // Slippage — always shown
    // lossContrib uses 15% of the tolerance as a realistic expected fill cost.
    // Using the full tolerance as loss overstates Est. Loss — Jupiter rarely fills
    // at the worst-case boundary. Score bands still reflect exposure correctly.
    const SLIPPAGE_FILL_RATE = 0.15;
    if (swapSlippage >= 5) {
      score += 40;
      factors.push({ name: `High slippage (${swapSlippage.toFixed(2)}%)`, severity: 'CRITICAL', lossContrib: (swapAmountUsd ?? 0) * (swapSlippage / 100) * SLIPPAGE_FILL_RATE });
    } else if (swapSlippage >= 3) {
      score += 25;
      factors.push({ name: `Elevated slippage (${swapSlippage.toFixed(2)}%)`, severity: 'HIGH', lossContrib: (swapAmountUsd ?? 0) * (swapSlippage / 100) * SLIPPAGE_FILL_RATE });
    } else if (swapSlippage > 0) {
      score += 5;
      factors.push({ name: `Normal slippage (${swapSlippage.toFixed(2)}%)`, severity: 'LOW', lossContrib: (swapAmountUsd ?? 0) * (swapSlippage / 100) * SLIPPAGE_FILL_RATE });
    } else {
      factors.push({ name: 'Slippage: none / auto', severity: 'LOW', lossContrib: 0 });
    }

    // Price impact — always shown when Jupiter provides the value
    const priceImpact = swapInfo?.priceImpactPct;
    if (priceImpact != null && !isNaN(priceImpact)) {
      if (priceImpact >= 5) {
        score += 35;
        factors.push({ name: `High price impact (${priceImpact.toFixed(2)}%)`, severity: 'CRITICAL', lossContrib: (swapAmountUsd ?? 0) * (priceImpact / 100) });
      } else if (priceImpact >= 1) {
        score += 15;
        factors.push({ name: `Elevated price impact (${priceImpact.toFixed(2)}%)`, severity: 'HIGH', lossContrib: (swapAmountUsd ?? 0) * (priceImpact / 100) });
      } else if (priceImpact >= 0.1) {
        score += 5;
        factors.push({ name: `Price impact (${priceImpact.toFixed(2)}%)`, severity: 'MEDIUM', lossContrib: (swapAmountUsd ?? 0) * (priceImpact / 100) });
      } else {
        factors.push({ name: `Price impact (${priceImpact.toFixed(2)}%)`, severity: 'LOW', lossContrib: 0 });
      }
    }

    if (likelyMemecoin) {
      score += 30;
      factors.push({ name: 'Memecoin target (high volatility)', severity: 'HIGH', lossContrib: (swapAmountUsd ?? 0) * 0.015 });
    } else if (unknownTxFormat) {
      score += 5;
      factors.push({ name: 'Unrecognized transaction format', severity: 'LOW', lossContrib: 0 });
    }

    // Trade size — always shown
    if (swapAmountUsd != null && swapAmountUsd >= 1000) {
      score += 10;
      factors.push({ name: `Large trade size ($${swapAmountUsd.toFixed(0)})`, severity: 'MEDIUM', lossContrib: swapAmountUsd * 0.0005 });
    } else if (swapAmountUsd != null && swapAmountUsd >= 500) {
      score += 5;
      factors.push({ name: `Medium trade size ($${swapAmountUsd.toFixed(0)})`, severity: 'LOW', lossContrib: swapAmountUsd * 0.0002 });
    } else if (swapAmountUsd != null) {
      factors.push({ name: `Small trade size ($${swapAmountUsd.toFixed(0)})`, severity: 'LOW', lossContrib: 0 });
    }

    if (swapInfo?.source === 'raydium') {
      score += 5;
      factors.push({ name: 'Raydium routing (less protection than Jupiter)', severity: 'LOW', lossContrib: (swapAmountUsd ?? 0) * 0.001 });
    }

    const estimatedLoss  = factors.reduce((s, f) => s + (f.lossContrib ?? 0), 0);

    // Derive SOL price from already-available data: widgetLastPriceData (set when ZendIQ
    // fetches its own order) or jupiterLiveQuote (set on every ~1s Jupiter tick).
    // No external price API call needed — /price/v2 is no longer available.
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const _lq  = ns.jupiterLiveQuote;
    const _wpd = ns.widgetLastPriceData;
    // Derive from live quote when SOL is the input token
    let _derivedSolPrice = null;
    if (_lq?.inUsdValue != null && _lq?.inputMint === SOL_MINT && _lq?.inAmount != null) {
      const _solAmt = Number(_lq.inAmount) / 1e9;
      if (_solAmt > 0) _derivedSolPrice = _lq.inUsdValue / _solAmt;
    } else if (_lq?.outUsdValue != null && _lq?.outputMint === SOL_MINT && _lq?.outAmount != null) {
      const _solAmt = Number(_lq.outAmount) / 1e9;
      if (_solAmt > 0) _derivedSolPrice = _lq.outUsdValue / _solAmt;
    }
    const finalScore     = Math.max(0, Math.min(100, score));

    // estimatedLossNative: convert USD loss to input-token units when price is known.
    // Return null when no price is available — showing USD as a token amount is misleading.
    const _tokenPrice = swapInfo?.tokenPriceUsd ?? 0;
    const estimatedLossNative = _tokenPrice > 0 ? estimatedLoss / _tokenPrice : null;

    return {
      score:         finalScore,
      level:         finalScore >= 70 ? 'CRITICAL' : finalScore >= 40 ? 'HIGH' : finalScore >= 20 ? 'MEDIUM' : 'LOW',
      factors,
      estimatedLoss,          // in USD
      estimatedLossNative,    // in input-token units, or null when price unavailable
      inputSymbol:   swapInfo?.inputSymbol ?? null,
      swapAmount,
      swapAmountUsd,
      solPrice:      (_wpd?.solPriceUsd ?? _derivedSolPrice ?? null),
      swapSlippage,
      swapSource:    swapInfo?.source ?? 'unknown',
      hasRealData:   realSlippage !== null || realAmount !== null,
    };
  }

  // ── MEV Risk Calculator ───────────────────────────────────────────────────
  function isStableToStable(a, b) { return STABLE_MINTS.has(a) && STABLE_MINTS.has(b); }
  function isMemecoinPair(a, b)    { return MEMECOIN_MINTS.has(a) || MEMECOIN_MINTS.has(b); }

  function getMevRiskLevel(score) {
    if (score >= 70) return 'CRITICAL';
    if (score >= 40) return 'HIGH';
    if (score >= 20) return 'MEDIUM';
    return 'LOW';
  }

  // ── Route-type resolver ───────────────────────────────────────────────────
  // mevRouteTypeFromLabel: pure string mapper — same rules as the Monitor tab route label.
  function mevRouteTypeFromLabel(str) {
    if (!str) return 'unknown';
    const s = str.toLowerCase();
    if (/rfq|direct fill/.test(s))  return 'rfq';
    if (/clmm|dlmm/.test(s))        return 'clmm';
    if (/cpmm|amm|v4/.test(s))      return 'cpmm';
    if (/pump|bonding/.test(s))      return 'bonding_curve';
    return 'unknown';
  }

  // mevRouteType: derives routeType from live context.
  // Priority: Raydium-native order → RFQ/gasless swapType → routePlan labels.
  function mevRouteType(liveQuote) {
    // Raydium-native route: pool type is stored on the ZendIQ order, not the Jupiter tick
    const order = ns.widgetLastOrder;
    if (order?._source === 'raydium') {
      return mevRouteTypeFromLabel('Raydium ' + (order._rdmPoolType ?? 'AMM'));
    }
    if (!liveQuote) return 'unknown';
    const st = liveQuote.swapType;
    if (st === 'rfq' || st === 'gasless') return 'rfq';
    // Build a label string from routePlan — mirrors the Monitor tab `route` variable
    const combined = (liveQuote.routePlan ?? [])
      .map(r => r?.swapInfo?.label ?? '').join(' ');
    return mevRouteTypeFromLabel(combined);
  }

  function calculateMEVRisk(trade) {
    const {
      inputMint     = null,
      outputMint    = null,
      amountUSD     = 0,
      routePlan     = null,    // Jupiter Ultra array: [{ swapInfo, percent }, ...]
      slippage      = 0,       // decimal, e.g. 0.015 = 1.5%
      poolLiquidity = null,    // optional USD liquidity
      routeType     = 'unknown', // 'rfq' | 'clmm' | 'cpmm' | 'bonding_curve' | 'unknown'
    } = trade ?? {};

    // ── RFQ / direct fill — sandwich is impossible ────────────────────────────
    if (routeType === 'rfq') {
      return {
        riskScore: 0,
        riskLevel: 'None',
        estimatedLossUSD: 0,
        estimatedLossPercentage: 0,
        factors: [{ factor: 'Direct fill (RFQ)', impact: 'Market maker fill — no pool to sandwich', score: 0 }],
        confidence: 'high',
      };
    }

    const factors = [];
    let score = 0;

    // ── 1. Route complexity (30% weight) ─────────────────────────────────────
    // Jupiter Ultra uses routePlan[] (not marketInfos[]). Each element is one hop.
    const hops = Array.isArray(routePlan) ? routePlan.length : 1;
    const clmmNote = routeType === 'clmm' ? ' (concentrated liquidity — harder to sandwich)' : '';
    let routeScore, routeImpact;
    if (hops >= 3) { routeScore = 30; routeImpact = `High – 3+ hop route${clmmNote}`; }
    else if (hops === 2) { routeScore = 15; routeImpact = `Medium – 2 hop route${clmmNote}`; }
    else                  { routeScore = 5;  routeImpact = `Low – single hop${clmmNote}`; }
    score += routeScore;
    factors.push({ factor: 'Route complexity', impact: routeImpact, score: routeScore });

    // ── 2. Trade size vs pool liquidity (25% weight) ──────────────────────────
    let liqScore, liqImpact;
    if (poolLiquidity == null || poolLiquidity <= 0) {
      // Memecoins almost always have low liquidity — use a higher unknown floor
      if (isMemecoinPair(inputMint, outputMint)) {
        liqScore = 15; liqImpact = 'Unknown liquidity — likely low (memecoin)';
      } else {
        liqScore = 2; liqImpact = 'Unknown liquidity (assumed minimal)';
      }
    } else {
      const pct = (amountUSD / poolLiquidity) * 100;
      if (pct > 10)      { liqScore = 25; liqImpact = `>${pct.toFixed(1)}% of pool (very high impact)`; }
      else if (pct > 5)  { liqScore = 20; liqImpact = `${pct.toFixed(1)}% of pool (high impact)`; }
      else if (pct >= 1) { liqScore = 10; liqImpact = `${pct.toFixed(1)}% of pool (moderate impact)`; }
      else                { liqScore = 2;  liqImpact = `${pct.toFixed(2)}% of pool (minimal impact)`; }
    }
    score += liqScore;
    factors.push({ factor: 'Trade size vs liquidity', impact: liqImpact, score: liqScore });

    // ── 3. Absolute trade size (20% weight) ──────────────────────────────────
    let sizeScore, sizeImpact;
    if (amountUSD > 100_000)     { sizeScore = 20; sizeImpact = `$${amountUSD.toLocaleString()} (whale)`; }
    else if (amountUSD >= 10_000) { sizeScore = 15; sizeImpact = `$${amountUSD.toLocaleString()} (large)`; }
    else if (amountUSD >= 1_000)  { sizeScore = 8;  sizeImpact = `$${amountUSD.toLocaleString()} (medium)`; }
    else                          { sizeScore = 2;  sizeImpact = `$${amountUSD.toLocaleString()} (small)`; }
    score += sizeScore;
    factors.push({ factor: 'Absolute trade size', impact: sizeImpact, score: sizeScore });

    // ── 4. Slippage tolerance (15% weight) ────────────────────────────────────
    const slipPct = slippage * 100;  // convert decimal to %
    let slipScore, slipImpact;
    if (slipPct > 3)      { slipScore = 15; slipImpact = `${slipPct.toFixed(2)}% (wide — MEV target)`; }
    else if (slipPct >= 1) { slipScore = 10; slipImpact = `${slipPct.toFixed(2)}% (elevated)`; }
    else if (slipPct >= 0.5){ slipScore = 5; slipImpact = `${slipPct.toFixed(2)}% (normal)`; }
    else                    { slipScore = 2; slipImpact = `${slipPct.toFixed(2)}% (tight)`; }
    score += slipScore;
    factors.push({ factor: 'Slippage tolerance', impact: slipImpact, score: slipScore });

    // ── 5. Token pair type (10% weight) ──────────────────────────────────────
    let pairScore, pairImpact;
    if (isStableToStable(inputMint, outputMint)) {
      pairScore = 1; pairImpact = 'Stable↔Stable (minimal MEV)';
    } else if (isMemecoinPair(inputMint, outputMint)) {
      pairScore = 10; pairImpact = 'Memecoin involved (high volatility)';
    } else {
      pairScore = 3; pairImpact = 'Standard pair';
    }
    score += pairScore;
    factors.push({ factor: 'Token pair type', impact: pairImpact, score: pairScore });

    // ── Route-type multiplier ─────────────────────────────────────────────────
    // Applied to raw score before cap. 'unknown' = 1.0 (backward-compatible).
    const ROUTE_MULTIPLIER = { clmm: 0.5, cpmm: 1.0, bonding_curve: 1.3, unknown: 1.0 };
    const routeMult = ROUTE_MULTIPLIER[routeType] ?? 1.0;
    score = Math.round(score * routeMult);

    // ── Minimum trade size floor ──────────────────────────────────────────────
    // Sandwich bots require a minimum profit threshold; small trades are rarely targeted.
    let sizeCap = null;
    if      (amountUSD < 10) sizeCap = 5;
    else if (amountUSD < 50) sizeCap = 15;
    if (sizeCap !== null && score > sizeCap) {
      score = sizeCap;
      factors.push({ factor: 'Trade size floor', impact: 'Trade too small for profitable sandwich attack', score: 0 });
    }

    // ── Final score + estimated loss ──────────────────────────────────────────
    const riskScore = Math.min(100, score);
    const riskLevel = getMevRiskLevel(riskScore);

    let lossPct;
    if      (riskScore >= 80) lossPct = 0.020;
    else if (riskScore >= 60) lossPct = 0.008;
    else if (riskScore >= 40) lossPct = 0.003;
    else if (riskScore >= 20) lossPct = 0.0005;
    else                      lossPct = 0.0001;

    const estimatedLossUSD        = amountUSD * lossPct;
    const estimatedLossPercentage = lossPct * 100;
    const confidence              = poolLiquidity != null ? 'high' : 'medium';

    return { riskScore, riskLevel, estimatedLossUSD, estimatedLossPercentage, factors, confidence };
  }

  // ── Export ───────────────────────────────────────────────────────────────
  Object.assign(ns, {
    getTokenMetadata,
    fetchDevnetContext,
    calculateRisk,
    calculateMEVRisk,
    mevRouteType,
    mevRouteTypeFromLabel,
  });
})();
