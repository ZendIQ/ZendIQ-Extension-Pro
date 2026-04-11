/**
 * ZendIQ – config.js
 * Bootstraps the shared namespace `window.__zq` with all config constants
 * and mutable state fields used across modules. Loaded first.
 * Runs in MAIN world (same JS context as the DEX page).
 */

(function () {
  // Guard: only one copy of ZendIQ should run per page context.
  if (window.__safeRouteLoaded) return;
  window.__safeRouteLoaded = true;

  const NETWORK    = 'mainnet-beta';  // switch to 'devnet' for testing
  const RPC_URL    = NETWORK === 'devnet'
    ? 'https://api.devnet.solana.com'
    : 'https://api.mainnet-beta.solana.com';

  const HELIUS_KEY = '';  // optional: set your Helius API key here for a faster RPC
  const HELIUS_RPC = HELIUS_KEY
    ? `https://${NETWORK}.helius-rpc.com/?api-key=${HELIUS_KEY}`
    : RPC_URL;

  window.__zq = {
    // ── Config ────────────────────────────────────────────────────────────
    NETWORK,
    RPC_URL,
    HELIUS_KEY,
    HELIUS_RPC,
    FEE_WALLET:   'BS9DnoBnndNj6QmeEbH2mxizefWYyrLond5G8bKUYxHC',

    // ── Priority fees (baked into the order transaction at fetch time) ──────
    // Actual fees computed by calcDynamicFees()
    PRIORITY_FEE_LOW:   50_000,
    PRIORITY_FEE_HIGH: 100_000,
    JITO_TIP_HIGH:     100_000,
    JITO_AUTO_THRESHOLD: 40,

    // ── Mutable shared state ────────────────────────────────────────────
    walletHooked: false,
    _wsWallet:    null,   // Wallet Standard wallet object
    _wsAccount:   null,   // Wallet Standard account for active pubkey

    // Priority fee mode — synced from popup settings
    jitoMode:          'auto',  // 'always' = high priority | 'auto' = high when risky | 'never' = standard

    // Overlay state
    lastRiskResult: null,
    pendingTransaction: null,
    pendingDecisionResolve: null,
    pendingDecisionPromise: null,
    _autoProtectPending:    false,  // true while autoProtect is holding the intercept promise open

    // History
    recentSwaps: [],
    MAX_SWAP_HISTORY: 5,

    // Widget state
    widgetActiveTab: 'monitor',
    widgetMode:  'simple',   // 'simple' | 'advanced'
    autoProtect: false,      // auto-optimise HIGH/CRIT without prompting
    autoAccept:  false,      // skip quote confirmation — go straight to wallet sign
    pauseOnHighRisk: true,   // pause auto-accept when output token scores HIGH or CRITICAL risk
    settingsProfile: 'alert', // 'alert' | 'balanced' | 'focused' | 'custom'
    widgetCapturedTrade: null,
    widgetLastOrder: null,
    widgetSwapStatus: '',   // '' | 'fetching' | 'ready' | 'signing' | 'signing-original' | 'sending' | 'done' | 'done-original' | 'error'
    widgetSwapError: '',
    widgetOriginalSigningInfo: null, // snapshot saved before unoptimised tx hits wallet
    widgetOriginalTxSig: null,       // signature from Jupiter's /execute response
    _signingOriginalTimeout: null,   // safety auto-dismiss handle for signing-original state
    widgetLastQuoteFetchedAt: null,  // timestamp of last successful quote fetch
    jupiterLiveQuote: null,          // latest quote sniffed from Jupiter's own UI ticks
    _quoteRefreshTimer: null,        // setInterval handle for auto-refresh
    _quickProbeTimer: null,          // one-shot 3s re-fetch when baseline typeMatch fails

    // Trigger thresholds — synced from popup settings, persisted in chrome.storage
    // undefined = not yet loaded from storage (approval.js will read storage on first use)
    threshMinRiskLevel: undefined,
    threshMinLossUsd:   undefined,
    threshMinSlippage:  undefined,

    // Token Score — output token on-chain + RugCheck analysis
    tokenScoreResult:  null,  // latest TokenScoreResult ({score, level, factors, loaded, mint})
    tokenScoreCache:   new Map(),  // Map<mint, {result, fetchedAt}> for 5-minute TTL caching
    _tokenScoreMint:   null,  // mint currently being / last scored (dedup guard)

    // Onboarding — false until user dismisses welcome card (shared with popup via sendiq_onboarded)
    onboarded: null,  // null = not yet loaded from storage; false = not seen; true = seen

    // pump.fun passive monitor context — set when user clicks Buy on pump.fun bonding curve
    // (no Jupiter routing available; widget shows slippage risk + token risk + execution risk)
    pumpFunContext: null,  // { outputMint, solAmount, slippagePct, risk, tokenScore } | null
    pumpFunNetAmount: null, // transient: intended SOL amount from pump.fun API request body (replaces pumpFunSlippage)
    pumpFunWantOptimise: false, // flag: user clicked Sign at 0.5% — onWalletArgs should patch tx in-place
    pumpFunRawArgs: null,       // raw wallet hook args captured before pump.fun slippage review
    pumpFunModifiedArgs: null,  // wallet hook args with maxSolCost patched to 0.5% slippage

    // ── Site adapter registry ────────────────────────────────────────────
    _siteAdapters: [],  // populated by page-pump.js, page-raydium.js, etc.

    // Extension version — read from DOM attribute stamped by bridge.js (ISOLATED world)
    // before any MAIN world scripts run, so it's always available here.
    version: document.documentElement.dataset.zendiqVersion || '',
  };

// ── Dynamic fee calculator ──────────────────────────────────────────────
  // Returns { priorityFeeLamports: number|null, jitoTipLamports: number|null }
  // null means omit the param entirely — let Jupiter auto-manage (recommended for low-risk)
  window.__zq.calcDynamicFees = function ({ riskScore = 0, mevScore = 0, priceImpactPct = null, tradeUsd = null, jitoMode = 'auto', solPriceUsd = null } = {}) {
    if (jitoMode === 'never')  return { priorityFeeLamports: null, jitoTipLamports: null };
    if (jitoMode === 'always') return { priorityFeeLamports: 500_000, jitoTipLamports: 200_000 };

    // SOL price fallback for fee scaling calculations when live price is unavailable
    const sol = solPriceUsd != null && solPriceUsd > 0 ? solPriceUsd : 80;

    // Combined score: base risk + MEV boost (capped +30 pts).
    // Multiplier 0.5 so MEDIUM MEV (score 25) contributes +13 pts.
    const mevBoost = Math.min(Math.round((mevScore ?? 0) * 0.5), 30);
    const combined = Math.min((riskScore ?? 0) + mevBoost, 100);
    // Small trades (<$5): cap score — never worth paying high fees for tiny amounts
    const score    = (tradeUsd != null && tradeUsd < 5) ? Math.min(combined, 35) : combined;

    // Priority fee: risk-score tier sets the ceiling; trade size scales it down
    // so the fee never exceeds 0.5% of the trade value (min 10k lamports if fee applies).
    // This ensures priority fees stay profitable on small trades without a re-fetch.
    let priorityFee;
    if (score < 25) {
      priorityFee = null;   // let Jupiter auto-manage
    } else {
      const tiered = score < 40 ? 50_000 : score < 60 ? 150_000 : score < 80 ? 300_000 : 500_000;
      if (tradeUsd != null) {
        const maxByTrade = Math.round(tradeUsd * 0.005 / sol * 1e9);  // 0.5% of trade in lamports
        priorityFee = Math.max(10_000, Math.min(tiered, maxByTrade));
      } else {
        priorityFee = tiered;
      }
    }

    // Jito tip: two independent triggers —
    //   (a) combined score >= 35 (high composite risk), OR
    //   (b) mevScore >= 25 (MEDIUM+ bot risk) — Jito is MEV-specific protection
    //       and should fire whenever bots are a real concern regardless of overall score.
    // Both require trade >= $5 to be worth the cost.
    const jitoWorthy = (score >= 35 || (mevScore ?? 0) >= 25) && (tradeUsd == null || tradeUsd >= 5);
    let jitoTip = null;
    if (jitoWorthy) {
      // priceImpactPct is a raw decimal fraction from Jupiter (e.g. 0.001 = 0.1%)
      const impact = priceImpactPct != null ? Math.abs(parseFloat(priceImpactPct)) : null;
      if (impact != null && tradeUsd != null) {
        // Target: cover 15% of estimated MEV exposure; uses live solPrice or $80 fallback
        const mevLamports = (tradeUsd * impact * 0.35 * 0.15 / sol) * 1e9;
        jitoTip = Math.round(Math.min(Math.max(mevLamports, 1_000), 500_000));
      } else if (tradeUsd != null) {
        // No price impact yet: conservative 0.08% of trade value — scales with swap size
        const mevLamports = (tradeUsd * 0.0008 / sol) * 1e9;
        jitoTip = Math.round(Math.min(Math.max(mevLamports, 1_000), 200_000));
      } else {
        // No trade size at all: static fallback tiers
        jitoTip = score < 60 ? 20_000 : score < 80 ? 80_000 : 200_000;
      }
    }

    return { priorityFeeLamports: priorityFee, jitoTipLamports: jitoTip };
  };

  // ── Site adapter registry helpers ────────────────────────────────────────
  window.__zq.registerSiteAdapter = function (adapter) {
    window.__zq._siteAdapters.push(adapter);
  };
  window.__zq.activeSiteAdapter = function () {
    return window.__zq._siteAdapters.find(a => a.matches?.()) ?? null;
  };
  window.__zq._adapterBusyStates = function () {
    return window.__zq._siteAdapters.flatMap(a => a.busyStates ?? []);
  };

  console.log(`[ZendIQ] Interceptor loaded on ${NETWORK}`);
  try { localStorage.setItem('sr_network', NETWORK); } catch (_) {}
})();
