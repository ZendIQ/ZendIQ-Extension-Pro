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
    walletHooked:     false,
    _hookedSolanaObj: null,  // which window.solana object was last hooked — allows re-hook on wallet switch
    _sessionLogged:  false,  // true after first session:start — prevents repeat firing
    _wsWallet:       null,   // Wallet Standard wallet object (active/most-recently-used)
    _wsAccount:      null,   // Wallet Standard account for active pubkey

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

    // Sandwich detection — post-trade block scan (page-sandwich.js initialises these to Map/Set)
    sandwichCache:    null,  // Map<txSig, result> — results cached indefinitely per session
    _sandwichPending: null,  // Set<txSig>  — dedup guard for concurrent calls

    // Onboarding — false until user dismisses welcome card (shared with popup via sendiq_onboarded)
    onboarded: null,  // null = not yet loaded from storage; false = not seen; true = seen

    // Live SOL price — seeded from chrome.storage on page load, updated every 5 min via background alarm
    // Used as fallback when widgetLastPriceData.solPriceUsd is unavailable (pump.fun, Raydium, first boot)
    solPriceUsd: null,

    // Dynamic slippage (bundle-only) — tightens slippage on Raydium+Jito bundle trades to collapse sandwich economics.
    // 'shadow' = compute + log only, never override (default, safe to ship — measures revert rate before enabling).
    // 'active' = compute + apply tightened slippage to bundle tx minimumAmountOut.
    // 'off'    = feature entirely disabled.
    dynamicSlippageMode: 'shadow',
    _dynSlipData:     null,   // {tightenedBps, originalBps, marginBps, tokenClass, priceImpactBps} | null
    _dynSlipOverride: false,  // true when user clicks "Use original X% instead" on the current trade

    // Until this is true the fields above hold defaults, not the user's choices —
    // writing the settings blob before it flips would overwrite them.
    settingsLoaded: false,

    // pump.fun passive monitor context — set when user clicks Buy on pump.fun bonding curve
    // (no Jupiter routing available; widget shows slippage risk + token risk + execution risk)
    pumpFunContext: null,  // { outputMint, solAmount, slippagePct, risk, tokenScore } | null
    pumpFunNetAmount: null, // transient: intended SOL amount from pump.fun API request body (replaces pumpFunSlippage)
    pumpFunWantOptimise: false, // flag: user clicked Sign at 0.5% — onWalletArgs should patch tx in-place
    pumpFunRawArgs: null,       // raw wallet hook args captured before pump.fun slippage review
    pumpFunModifiedArgs: null,  // wallet hook args with maxSolCost patched to 0.5% slippage
    pumpFunErrorMsg: null,       // short error message shown in pump-error widget state
    pumpFunPatchedSlippage: null, // true = maxSolCost was successfully patched to 0.5%; false = patch failed (original slippage used)
    _pumpTxSigHandled: false,     // de-dupe flag: first successful Jito/Temporal response wins
    _pumpCancelObserver: null,     // MutationObserver watching for wallet cancel signals on pump.fun
    _pumpTxCooldownUntil: 0,      // timestamp: suppress re-intercepts for 10s after successful pump tx
    _pumpPrefetchedTx: null,      // { bytes: Uint8Array, fetchedAt: number } — prefetched during panel review
    _pumpBcData: null,            // cached bonding curve data from frontend-api.pump.fun (proactively fetched)
    _pumpDerivedGlobals: null,    // cached on-chain-derived { global, feeRecip, evtAuth } for current _PUMP_PROG
    _pumpTxTemplate: null,        // cached full tx account template from network tap (allKeys + buyIxAcctIndices + msgHeader)

    // ── Axiom.trade adapter state ────────────────────────────────────────
    axiomSessionPubkey: null,     // active session wallet pubkey; updated on every wallet switch
    axiomPositions:     new Map(), // Map<walletAddress, {wallet, token, openedAt}> — open positions
    axiomVerifyOnly:    false,     // true on axiom.trade — suppresses routing UX, shows risk-only widget
    axiomLastSlippage:  null,      // last known user slippage as decimal (e.g. 0.20 = 20%) from log-tx-v3
    axiomLastMevMode:   null,      // last known mevProtection boolean from log-tx-v3
    axiomMevRisk:       null,      // calculateMEVRisk result for current token
    axiomRiskResult:    null,      // calculateRisk result for current token (execution risk)
    axiomConfirmPending: false,    // true while buy-button intercept awaits user decision
    axiomPendingBtnRef:  null,     // DOM reference to the intercepted Buy button
    axiomRiskAcknowledged: false,  // true after user clicks "Got it"; cleared on token change or new buy
    // ── Axiom preset-optimization (snapshot + restore) ───────────────────
    // Off until the user opts in. `axiomOptimizeConsent` is null until answered —
    // absence of a choice is not a choice, so it must be distinguishable from 'off'.
    axiomOptimizeEnabled: false,   // master flag for the Optimize & Buy flow
    axiomOptimizeConsent: null,    // null = unanswered | 'on' | 'off'
    axiomObligation:    null,      // OPS-181 restore obligation — see page-axiom.js _applyOptimizationAndBuy
    axiomApiHost:       null,      // Axiom's settings API host, learned from live traffic (sharded: api10, api3, …)
    axiomOptimizing:    false,     // true between applying safe settings and restoring the original
    axiomOptimizeAbandoned: null,  // { at, why } when an optimize was skipped and settings left untouched
    axiomLastOptimization: null,   // { slipFrom, slipTo, mevFrom, mevTo, estSavingsUsd, changes[] } — last applied breakdown
    _axiomRestoreTimer: null,      // fallback setTimeout id that restores settings if no settlement signal arrives

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
    const sol = solPriceUsd != null && solPriceUsd > 0 ? solPriceUsd
              : (window.__zq.solPriceUsd != null && window.__zq.solPriceUsd > 0 ? window.__zq.solPriceUsd : 150);

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

  // ── Dynamic slippage calculator (bundle-only) ────────────────────────────
  // Computes a tighter slippage value for Raydium+Jito bundle transactions.
  // Sandwich economics collapse when minimumAmountOut is set just above the expected
  // price impact — attackers can't extract meaningful value without triggering a revert.
  //
  // target_slippage = expected_price_impact + safety_margin_by_token_class
  //
  // Returns { tightenedBps, originalBps, marginBps, tokenClass, priceImpactBps }
  // or null when tightening is not applicable (no impact data, or already tight enough).
  window.__zq.calcDynSlippage = function ({ priceImpactPct, originalSlippageBps, tokenScore } = {}) {
    if (priceImpactPct == null) return null; // can't tighten without impact data

    // Convert Jupiter's raw fraction (e.g. 0.007 = 0.7%) → basis points
    const pi     = Math.abs(parseFloat(priceImpactPct) || 0);
    const piBps  = Math.ceil(pi * 100 * 100);  // fraction → % → bps

    // Token class from existing tokenScoreResult signals — no new classifier needed.
    // Stable mints get tight margin; CRITICAL-risk tokens get wider headroom for
    // legitimate volatility; everything else scales linearly between them.
    const STABLE_MINTS = new Set([
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ]);
    let tokenClass = 'established'; // default (LOW risk, non-stable)
    const lvl = tokenScore?.level ?? null;
    if (lvl === 'CRITICAL') {
      tokenClass = 'fresh_launch';  // high legitimate volatility — widest headroom
    } else if (lvl === 'HIGH') {
      tokenClass = 'memecoin';
    } else if (lvl === 'MEDIUM') {
      tokenClass = 'low_cap';
    } else if (lvl === 'LOW' && STABLE_MINTS.has(tokenScore?.mint)) {
      tokenClass = 'stable';
    }

    // CRITICAL (fresh_launch): skip entirely in v1 — these tokens have too much legitimate
    // price volatility for a fixed margin to be safe. Shadow data will calibrate a future margin.
    if (tokenClass === 'fresh_launch') return null;

    // Safety margin: headroom for legitimate price drift between quote and execution.
    // v0 calibration — tune from shadow-mode telemetry before enabling 'active' mode.
    const MARGIN_BPS = { stable: 30, established: 75, low_cap: 150, memecoin: 175, fresh_launch: 250 };
    const marginBps  = MARGIN_BPS[tokenClass] ?? 75;

    const tightenedBps = piBps + marginBps;

    // Guard: only tighten if it would make a real difference vs the user's setting,
    // and only when the computed value is at least 10 bps (never near-zero slippage).
    if (tightenedBps >= (originalSlippageBps ?? 50) || tightenedBps < 10) return null;

    return { tightenedBps, originalBps: originalSlippageBps ?? 50, marginBps, tokenClass, priceImpactBps: piBps };
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
