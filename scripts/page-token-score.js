/**
 * ZendIQ – page-token-score.js
 * Token Score: comprehensive on-chain + RugCheck risk analysis for the output token.
 *
 * Signals checked (16 active):
 *  1.  Mint authority (can devs print unlimited tokens?)
 *  2.  Freeze authority (can devs lock your tokens?)
 *  3.  Top holder concentration (whale / insider supply lock-up)
 *  4.  RugCheck.xyz risk report (copycat, low liquidity, known rug, etc.)
 *  5.  Speculative / memecoin market risk
 *  6.  LP lock status
 *  7.  3-month price change (GeckoTerminal)
 *  8.  Long-term price change (GeckoTerminal, up to ~6M)
 *  9.  Volume trend / activity collapse (GeckoTerminal)
 * 10.  Token age (DexScreener pairCreatedAt)
 * 11.  24h price change
 * 12.  Liquidity depth (DexScreener)
 * 13.  Market cap (DexScreener)
 * 14.  Serial deployer — how many tokens the creator wallet launched in last 30d
 *      +8 MEDIUM ≥3 · +20 HIGH ≥10 · +30 CRITICAL ≥25 · +35 CRITICAL ≥50 (bot factory)
 * 15.  Deployer rug rate — what % of deployer's previous tokens collapsed to near-zero
 *      +8 MEDIUM ≥40% · +15 HIGH ≥60% · +20 CRITICAL ≥80%
 * 16.  Bundle launch detection — Jito bundle manipulation at token creation
 *      +40 CRITICAL ≥5 txs in creation slot · +20 HIGH 3-4 · 0 LOW 1-2
 *      Uses standard getSignaturesForAddress RPC — no Helius key required
 *
 * Results are cached per mint (5-minute TTL). Well-known stablecoins return LOW instantly.
 * Two-phase fetch: 12-signal partial result published immediately (~1s); deployer signals
 * (14 & 15) arrive ~5–10s later via a second renderWidgetPanel() call.
 *
 * Runs in MAIN world. API calls route through background via pageJsonFetch / rpcCall.
 */

(function () {
  'use strict';
  const ns = window.__zq;

  // ── Regulated stablecoins — always return LOW with explanation ───────────────────
  // These tokens have active mint + freeze authorities by design (institutional compliance).
  // GeckoTerminal price data for stablecoins reflects the paired token’s price, not their own.
  // Running rug-pull heuristics on Circle/Tether-issued tokens produces meaningless noise.
  const STABLECOIN_MINTS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC  (Circle)
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT  (Tether)
    'EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o', // DAI   (MakerDAO bridged)
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E', // BTC   (Wormhole)
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH   (Wormhole)
    'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM',  // USDCet (Portal USDC)
  ]);

  // ── Blue-chip Solana DeFi protocol tokens — skip rug heuristics ──────────────
  // These are audited, established protocol tokens with real utility and transparent teams.
  // LP-unlock signals, 3-month price declines, and RugCheck warnings produce noise for them.
  const KNOWN_BLUECHIP_MINTS = new Map([
    ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'RAY'],    // Raydium
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  'JUP'],    // Jupiter
    ['So11111111111111111111111111111111111111112',    'SOL'],    // Wrapped SOL
    ['orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1HMxT65J', 'ORCA'],   // Orca
    ['mSoLzYCxHdYgdic8VteMv6jt3y1TnSCW2CgxdoQmxup', 'mSOL'],   // Marinade staked SOL
    ['7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', 'stSOL'],  // Lido staked SOL
    ['HZ1JovNiVvGrqs182GCycjVJtzbZjJQX5B5KUGcFSup',  'MNGO'],   // Mango Markets
    ['SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKgThh', 'SRM'],    // Serum (legacy)
    ['3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', 'WBTC'],   // Wrapped BTC (Wormhole)
  ]);

  // ── Known speculative memecoins — get a base market-risk factor ─────────────
  // On-chain hygiene (burned auth, decent distribution) doesn't mean safe to hold.
  // These tokens have no fundamental value and are purely sentiment/speculation driven.
  const KNOWN_MEMECOINS = new Set([
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF  (dogwifhat)
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump', // Fartcoin
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // POPCAT
    'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',  // MEW
    'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',  // BOME
    'nQMSJCFepwLdRnGbQCuoTZvu3MiQR3OwLMpFBKqupQz',  // MYRO
    '8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGqgooGPo', // GECKO
    'GiG7Hr61RVm4CSUxJmgiCoySFQtdiwxtqf64MsRppump', // PNUT
    '5z3EqYQo9HiCEs3R84RCDMu2n7anpDMxRhdK31CR8zjt', // PEPE (SOL)
  ]);

  // Name/symbol keywords — catch memecoins not in the hardcoded list above.
  // Checked against RugCheck tokenMeta name + symbol (lowercased).
  const MEMECOIN_KW = [
    'doge','shib','inu','pepe','frog','wif','bonk','cat','dog','moon',
    'elon','musk','chad','based','degen','floki','baby','meme','pump',
    'ape','wojak','cope','shill','wen','gm','ngmi','jeet','rekt',
    '420','69','wagmi','fart','poop','honk','nyan','smol','goat',
  ];

  // ── Cache: Map<mintAddress, { result, fetchedAt }> ───────────────────────────
  // Also keep a last-known result (no TTL) as a fallback when re-fetch fails.
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Ensure maps exist on the shared namespace
  ns.tokenScoreCache = ns.tokenScoreCache ?? new Map();
  ns.tokenScoreLast  = ns.tokenScoreLast  ?? new Map(); // persistent fallback

  function _getCached(mint) {
    const entry = ns.tokenScoreCache.get(mint);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) { ns.tokenScoreCache.delete(mint); return null; }
    return entry.result;
  }

  function _getLastKnown(mint) {
    return ns.tokenScoreLast.get(mint) ?? null;
  }

  function _setCached(mint, result) {
    ns.tokenScoreCache.set(mint, { result, fetchedAt: Date.now() });
    // Also record as last-known immediate fallback (no TTL)
    ns.tokenScoreLast.set(mint, result);
  }

  // ── Deployer analysis helpers ─────────────────────────────────────────────────
  // SPL token program IDs — used to identify InitializeMint instructions.
  const _SPL_TOKEN    = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss624VQ5SDWKn';
  const _SPL_TOKEN_22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

  // Returns the real deployer wallet — fee-payer of the mint's oldest transaction.
  // Works even after mint authority is burned. Falls back to mint authority on error.
  async function _getRealDeployer(mint) {
    if (!mint) return null;
    try {
      let before = undefined;
      let oldest = null;
      // Walk signature history back to the beginning (max 3 pages × 1000 = 3000 sigs)
      for (let page = 0; page < 3; page++) {
        const params = [mint, { limit: 1000, ...(before ? { before } : {}) }];
        const resp = await ns.rpcCall('getSignaturesForAddress', params);
        const sigs = resp?.result ?? [];
        if (!sigs.length) break;
        oldest = sigs[sigs.length - 1].signature;
        if (sigs.length < 1000) break;
        before = oldest;
      }
      if (!oldest) {
        // Fallback: mint authority as deployer proxy (null if burned)
        const resp = await ns.rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
        return resp?.result?.value?.data?.parsed?.info?.mintAuthority ?? null;
      }
      // Fee-payer of the oldest tx (accountKeys[0]) = real deployer
      const txResp = await ns.rpcCall('getTransaction', [
        oldest,
        { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ]);
      const keys = txResp?.result?.transaction?.message?.staticAccountKeys
                ?? txResp?.result?.transaction?.message?.accountKeys ?? [];
      return (typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey) ?? null;
    } catch (_) { return null; }
  }

  // Returns { tokenCount, mints[] } — distinct mints the deployer initialised in last windowDays.
  // Uses jsonParsed encoding to detect initializeMint instructions directly.
  async function _getDeployerTokenData(deployerAddress, windowDays = 30) {
    if (!deployerAddress) return { tokenCount: 0, mints: [] };
    try {
      const cutoff  = Math.floor((Date.now() - windowDays * 24 * 3600 * 1000) / 1000);
      const resp    = await ns.rpcCall('getSignaturesForAddress', [deployerAddress, { limit: 200 }]);
      const recent  = (resp?.result ?? []).filter(s => (s.blockTime ?? 0) >= cutoff);
      if (!recent.length) return { tokenCount: 0, mints: [] };

      const toCheck = recent.slice(0, 50);
      const txResps = await Promise.all(
        toCheck.map(s => ns.rpcCall('getTransaction', [
          s.signature,
          { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
        ]).catch(() => null))
      );

      const mints = [];
      const seen  = new Set();
      function _scanIxs(instructions) {
        for (const ix of (instructions ?? [])) {
          const pid = ix.programId ?? '';
          if (pid !== _SPL_TOKEN && pid !== _SPL_TOKEN_22) continue;
          const t = ix.parsed?.type ?? '';
          if (t === 'initializeMint' || t === 'initializeMint2') {
            const m = ix.parsed?.info?.mint;
            if (m && !seen.has(m)) { seen.add(m); mints.push(m); }
          }
        }
      }
      for (const r of txResps) {
        if (!r?.result) continue;
        _scanIxs(r.result.transaction?.message?.instructions);
        for (const inner of (r.result.meta?.innerInstructions ?? [])) _scanIxs(inner.instructions);
      }
      return { tokenCount: mints.length, mints };
    } catch (_) { return { tokenCount: 0, mints: [] }; }
  }

  // Batch DexScreener call for deployer's previous tokens — checks how many have
  // collapsed to near-zero liquidity (<$200), indicating a serial rug pattern.
  async function _fetchDeployerRugRate(mints) {
    if (!mints?.length) return null;
    const sample = mints.slice(0, 10); // cap to stay within rate limits
    try {
      const data = await ns.pageJsonFetch(`https://api.dexscreener.com/latest/dex/tokens/${sample.join(',')}`);
      const liquidByMint = new Map();
      for (const p of (data?.pairs ?? [])) {
        if (p.chainId !== 'solana') continue;
        const addr = p.baseToken?.address;
        if (!addr) continue;
        const liq = p.liquidity?.usd ?? 0;
        if (!liquidByMint.has(addr) || liq > liquidByMint.get(addr)) liquidByMint.set(addr, liq);
      }
      let ruggedCount = 0;
      for (const m of sample) {
        const maxLiq = liquidByMint.get(m) ?? null;
        if (maxLiq === null || maxLiq < 200) ruggedCount++;
      }
      return { checked: sample.length, ruggedCount };
    } catch (_) { return null; }
  }

  // ── Bundle Launch Detection (signal #16) ─────────────────────────────────────
  // Detects Jito bundle manipulation at token creation — the primary pump.fun rug pattern.
  //
  // Jito bundles execute atomically within the same slot, so multiple distinct wallets
  // buying in the token's creation slot is a strong signal of coordinated supply acquisition
  // designed to enable a coordinated dump on retail buyers.
  //
  // Uses standard getSignaturesForAddress RPC (newest-first, paginates backward up to
  // 2 pages / 2 000 sigs). When < 2 000 sigs total we have the full history; creation
  // slot (min slot) transaction count acts as a reliable bundle proxy.
  // Returns inconclusive for tokens with > 2 000 transactions (established tokens where
  // bundle detection is moot anyway).
  async function _fetchBundleLaunch(mint) {
    try {
      let allSigs = [];
      let cursor;
      for (let page = 0; page < 2; page++) {
        const params = [mint, cursor ? { limit: 1000, before: cursor } : { limit: 1000 }];
        const resp  = await ns.rpcCall('getSignaturesForAddress', params);
        const batch = resp?.result ?? [];
        if (!batch.length) break;
        allSigs = allSigs.concat(batch);
        if (batch.length < 1000) break; // reached the beginning of history
        cursor = batch[batch.length - 1].signature;
      }

      if (!allSigs.length) return null;

      // If still full after 2 pages the token has > 2 000 txs — creation slot unknown
      if (allSigs.length >= 2000) {
        return { bundleLevel: 'unknown', creationSlotTxCount: null, inconclusive: true };
      }

      const valid = allSigs.filter(s => s.slot && !s.err);
      if (!valid.length) return null;

      // Creation slot = minimum slot number across the complete history
      let creationSlot = valid[0].slot;
      for (const s of valid) if (s.slot < creationSlot) creationSlot = s.slot;

      const txCount = valid.filter(s => s.slot === creationSlot).length;
      return {
        bundleLevel: txCount >= 5 ? 'high' : txCount >= 3 ? 'medium' : 'low',
        creationSlotTxCount: txCount,
        inconclusive: false,
      };
    } catch (_) { return null; }
  }

  // ── On-chain: mint account info (mintAuthority, freezeAuthority) ────────────
  async function _fetchMintInfo(mint) {
    try {
      const resp = await ns.rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
      const info = resp?.result?.value?.data?.parsed?.info;
      if (!info) return null;
      return {
        mintAuthority:   info.mintAuthority   ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        supply:          info.supply          ?? null,
        decimals:        info.decimals        ?? 9,
      };
    } catch (_) { return null; }
  }

  // ── On-chain: top holder distribution ────────────────────────────────────────
  async function _fetchHolderData(mint) {
    try {
      const [largestResp, supplyResp] = await Promise.all([
        ns.rpcCall('getTokenLargestAccounts', [mint]).catch(() => null),
        ns.rpcCall('getTokenSupply',          [mint]).catch(() => null),
      ]);
      const holders      = largestResp?.result?.value ?? [];
      const totalSupply  = parseFloat(supplyResp?.result?.value?.uiAmount ?? 0);
      if (!totalSupply || !holders.length) return null;

      const holderPcts = holders.map(h => ({
        address: h.address,
        pct:     totalSupply > 0 ? (parseFloat(h.uiAmount ?? 0) / totalSupply) * 100 : 0,
      }));
      const top1Pct = holderPcts[0]?.pct ?? 0;
      const top5Pct = holderPcts.slice(0, 5).reduce((s, h) => s + h.pct, 0);

      return { holderPcts, top1Pct, top5Pct, totalHolders: holders.length };
    } catch (_) { return null; }
  }
  // ── DexScreener: price action, liquidity, market cap, token age ────────────
  async function _fetchDexScreener(mint) {
    try {
      const url  = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
      const data = await ns.pageJsonFetch(url);
      if (!data?.pairs?.length) return null;
      // Pick the Solana pair with the highest liquidity
      const solPairs = data.pairs.filter(p => p.chainId === 'solana');
      if (!solPairs.length) return null;
      solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const p = solPairs[0];
      return {
        symbol:          p.baseToken?.symbol ?? null,
        name:            p.baseToken?.name   ?? null,
        priceChange24h:  p.priceChange?.h24  ?? null,  // % — negative = drop
        volume24h:       p.volume?.h24       ?? null,  // USD
        liquidityUsd:    p.liquidity?.usd    ?? null,  // USD
        marketCap:       p.marketCap         ?? p.fdv ?? null, // USD
        pairCreatedAt:   p.pairCreatedAt     ?? null,  // Unix ms
        dexId:           p.dexId             ?? null,
        pairUrl:         p.url               ?? null,
      };
    } catch (_) { return null; }
  }
  // ── GeckoTerminal: daily OHLCV for 3-month + 6-month price change ──────────
  // Uses GeckoTerminal's free DEX API (no API key required).
  // The per-token OHLCV endpoint requires a paid key. Free path is two-step:
  //   Step 1: GET /networks/solana/tokens/{mint}/pools?limit=1  → top pool address
  //   Step 2: GET /networks/solana/pools/{pool}/ohlcv/day?limit=181 → daily candles
  // Valid timeframes on free tier: day | hour | minute | second ("week" is NOT valid).
  // Free tier max: 181 daily candles (~6 months). Candles are newest-first.
  // Each candle: [timestamp_secs, open, high, low, close, volume]
  async function _fetchGeckoTerminal(mint) {
    try {
      // GeckoTerminal free tier requires this Accept header — without it returns HTTP 400.
      const _gtHeaders = { Accept: 'application/json;version=20230302' };

      // Step 1: resolve the top liquidity pool for this token
      const poolsUrl  = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?limit=1`;
      const poolsData = await ns.pageJsonFetch(poolsUrl, _gtHeaders);
      const poolAddress = poolsData?.data?.[0]?.attributes?.address;
      if (!poolAddress) return null;

      // Step 2: fetch daily OHLCV — free tier returns up to 181 candles (~6 months)
      const ohlcvUrl  = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/day?limit=181&currency=usd`;
      const ohlcvData = await ns.pageJsonFetch(ohlcvUrl, _gtHeaders);
      const ohlcv = ohlcvData?.data?.attributes?.ohlcv_list;
      if (!Array.isArray(ohlcv) || ohlcv.length < 2) return null;

      const latestClose = parseFloat(ohlcv[0]?.[4]);
      if (!latestClose || !isFinite(latestClose)) return null;

      const daysOfData = ohlcv.length;

      // 3-month: only meaningful when we have >= 90 daily candles.
      // For newer tokens index 90 would point to recent data — not a real 3M comparison.
      let change3m = null;
      if (daysOfData >= 90) {
        const close3m = parseFloat(ohlcv[90]?.[4]);
        if (close3m && isFinite(close3m)) change3m = ((latestClose - close3m) / close3m) * 100;
      }

      // Longest window available: oldest candle in the set (up to ~181 days = ~6 months).
      // Only report when we have at least 30 days so it isn't just noise.
      let changeLong = null;
      if (daysOfData >= 30) {
        const closeLong = parseFloat(ohlcv[daysOfData - 1]?.[4]);
        if (closeLong && isFinite(closeLong)) changeLong = ((latestClose - closeLong) / closeLong) * 100;
      }

      // Volume trend: compare last 7-day avg to the 30–90 day window before that.
      // Requires >= 37 candles and a meaningful baseline (> $1k/day avg) to avoid
      // false positives on tiny tokens with near-zero volume throughout.
      let volTrend = null;
      if (daysOfData >= 37) {
        const _avg = (slice) => slice.reduce((s, c) => s + (parseFloat(c[5]) || 0), 0) / slice.length;
        const recent7  = _avg(ohlcv.slice(0, 7));
        const baseline = _avg(ohlcv.slice(7, Math.min(daysOfData, 97))); // up to 90 days of baseline
        if (baseline > 1000 && isFinite(recent7) && isFinite(baseline)) {
          volTrend = { ratio: recent7 / baseline, recentAvg: recent7, baselineAvg: baseline };
        }
      }

      // Return using change1y key so existing scoring logic works unchanged;
      // weeksOfData mapped from daysOfData for threshold guards in _computeScore.
      return { change3m, change1y: changeLong, daysOfData, weeksOfData: Math.floor(daysOfData / 7), latestClose, volTrend };
    } catch (_) { return null; }
  }

  // ── RugCheck API: comprehensive risk report ───────────────────────────────────
  async function _fetchRugCheck(mint) {
    try {
      const url  = `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`;
      const data = await ns.pageJsonFetch(url);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (_) { return null; }
  }

  // ── Score calculator ─────────────────────────────────────────────────────────
  // RugCheck risk item names that are extremely common on legitimate tokens and add no
  // meaningful signal — filtered out entirely to avoid tooltip noise.
  const RUGCHECK_NOISE = [
    'mutable metadata',   // almost every token has this — not a rug signal
    'metadata updatable', // same concept, alternate phrasing
    'metadata',           // catch-all for pure metadata mutability warnings
  ];

  function _computeScore(mintInfo, holderData, rugCheck, dexData, geckoData, mint, deployerData, rugRateData, bundleLaunchData) {
    let score   = 0;
    const factors = [];

    // ── 1. Mint authority ──────────────────────────────────────────────────────
    // Resolution order:
    //   a) RugCheck token object present → use its mintAuthority (absent key = null = burned)
    //   b) on-chain mintInfo fetched     → use its mintAuthority
    //   c) both fetches failed           → genuinely unknown
    //
    // Critically: a missing key in RugCheck's token object is NOT the same as "unknown" —
    // RugCheck omits the field when authority is revoked, so we treat it as null.
    let mintAuth;
    if (rugCheck?.token !== undefined && rugCheck.token !== null) {
      // RugCheck responded — absent key means revoked (null)
      mintAuth = rugCheck.token.mintAuthority ?? null;
    } else if (mintInfo !== null) {
      mintAuth = mintInfo.mintAuthority ?? null;
    } else {
      mintAuth = undefined; // both fetches failed
    }

    if (mintAuth === undefined) {
      // Neither source returned data — mildly concerning but not actionable
      score += 5;
      factors.push({ name: 'Mint authority: data unavailable', severity: 'LOW', detail: 'On-chain lookup failed — could not confirm whether new tokens can be minted. Check manually.' });
    } else if (mintAuth === null || mintAuth === '') {
      factors.push({ name: 'Supply fixed (mint burned)', severity: 'LOW', detail: 'Mint authority revoked — devs cannot print more tokens' });
    } else {
      score += 35;
      factors.push({ name: 'Unlimited supply risk', severity: 'CRITICAL', detail: 'Mint authority is active — devs can create unlimited tokens at any time' });
    }

    // ── 2. Freeze authority ────────────────────────────────────────────────────
    let freezeAuth;
    if (rugCheck?.token !== undefined && rugCheck.token !== null) {
      freezeAuth = rugCheck.token.freezeAuthority ?? null;
    } else if (mintInfo !== null) {
      freezeAuth = mintInfo.freezeAuthority ?? null;
    } else {
      freezeAuth = undefined;
    }

    if (freezeAuth === undefined) {
      factors.push({ name: 'Freeze authority: data unavailable', severity: 'LOW', detail: 'On-chain lookup failed — could not confirm freeze authority status. Check manually.' });
    } else if (freezeAuth === null || freezeAuth === '') {
      factors.push({ name: 'No freeze authority', severity: 'LOW', detail: 'Freeze authority revoked — your tokens cannot be frozen by the contract' });
    } else {
      score += 20;
      factors.push({ name: 'Freeze authority active', severity: 'HIGH', detail: 'Developer can freeze token transfers in your wallet at any time' });
    }

    // ── 3. Top holder concentration ────────────────────────────────────────────
    // Prefer RugCheck's topHolders (they filter out exchange wallets); fallback to on-chain
    let top1Pct  = null;
    let top5Pct  = null;
    if (rugCheck?.topHolders?.length) {
      const th = rugCheck.topHolders;
      top1Pct = parseFloat(th[0]?.pct ?? th[0]?.amount ?? 0);
      top5Pct = th.slice(0, 5).reduce((s, h) => s + parseFloat(h.pct ?? h.amount ?? 0), 0);
    } else if (holderData) {
      top1Pct = holderData.top1Pct;
      top5Pct = holderData.top5Pct;
    }

    if (top1Pct != null && isFinite(top1Pct)) {
      if (top1Pct > 50) {
        score += 30;
        factors.push({ name: `Whale risk: ${top1Pct.toFixed(1)}% in one wallet`, severity: 'CRITICAL', detail: 'A single wallet controls the majority of supply — a dump would decimate price' });
      } else if (top1Pct > 30) {
        score += 20;
        factors.push({ name: `Large holder: ${top1Pct.toFixed(1)}% in one wallet`, severity: 'HIGH', detail: 'Single wallet holds a large portion of supply — high dump risk' });
      } else if (top1Pct > 15) {
        score += 10;
        factors.push({ name: `Concentrated: ${top1Pct.toFixed(1)}% top holder`, severity: 'MEDIUM', detail: 'Notable concentration in a single wallet' });
      } else {
        factors.push({ name: `Top holder: ${top1Pct.toFixed(1)}%`, severity: 'LOW', detail: 'Supply appears reasonably distributed' });
      }
    }

    if (top5Pct != null && isFinite(top5Pct) && top5Pct > 0) {
      if (top5Pct > 70) {
        score += 15;
        factors.push({ name: `Insider supply: top 5 hold ${top5Pct.toFixed(1)}%`, severity: 'HIGH', detail: 'Supply heavily concentrated among 5 wallets — coordinated selling is possible' });
      } else if (top5Pct > 50) {
        score += 5;
        factors.push({ name: `Top 5 hold ${top5Pct.toFixed(1)}% of supply`, severity: 'MEDIUM', detail: 'Above-average supply concentration in top wallets' });
      } else {
        factors.push({ name: `Top 5 hold ${top5Pct.toFixed(1)}% of supply`, severity: 'LOW', detail: 'Supply distribution looks reasonable' });
      }
    }

    // ── 4. RugCheck risk items ────────────────────────────────────────────────
    if (rugCheck?.rugged === true) {
      score = 100;
      factors.unshift({ name: 'PREVIOUSLY RUGGED', severity: 'CRITICAL', detail: 'RugCheck has flagged this token as a confirmed rug pull' });
    }
    if (Array.isArray(rugCheck?.risks)) {
      for (const r of rugCheck.risks) {
        const lvl      = r.level ?? '';
        const rName    = r.name ?? '';
        const rNameLow = rName.toLowerCase();
        // Skip common low-signal items present on almost every legitimate token.
        // Mutable metadata is normal — not a rug signal on its own.
        if (RUGCHECK_NOISE.some(n => rNameLow.includes(n))) continue;
        // 'danger' items add HIGH signal; 'warn' adds MEDIUM noise
        if (lvl === 'danger') {
          score += 15;
          factors.push({ name: rName || 'Flagged risk', severity: 'HIGH', detail: r.description ?? '' });
        } else if (lvl === 'warn') {
          score += 5;
          factors.push({ name: rName || 'Warning', severity: 'MEDIUM', detail: r.description ?? '' });
        }
        // 'info' items are just informational — no score impact
      }
    }

    // ── 5. Speculative / memecoin market risk ─────────────────────────────────
    // Good on-chain hygiene (burned auth, decent distribution) does NOT mean the
    // token is safe to hold — memecoins can still collapse from sentiment alone.
    {
      const _isPumpFunSite = window.location.hostname?.includes('pump.fun');
      const tName = (rugCheck?.tokenMeta?.name   ?? '').toLowerCase();
      const tSym  = (rugCheck?.tokenMeta?.symbol ?? '').toLowerCase();
      const isMeme = KNOWN_MEMECOINS.has(mint) ||
        MEMECOIN_KW.some(k => tName.includes(k) || tSym.includes(k));
      if (_isPumpFunSite) {
        // Every token on pump.fun is a speculative meme launch — site context
        // is a stronger signal than keyword detection.
        score += 35;
        factors.push({
          name: 'Pump.fun launch \u2014 extreme speculative risk',
          severity: 'CRITICAL',
          detail: 'All tokens traded on pump.fun are speculative meme launches with no fundamental value floor. High probability of total loss.',
        });
      } else if (isMeme) {
        score += 25;
        factors.push({
          name: 'Speculative asset',
          severity: 'HIGH',
          detail: 'Memecoin \u2014 value is driven purely by sentiment with no fundamental floor. Expect high volatility and potential for total loss.',
        });
      }
    }

    // ── 6. Liquidity pool lock status ──────────────────────────────────────
    // Unlocked LP means devs or early investors can pull liquidity at any time.
    if (Array.isArray(rugCheck?.markets) && rugCheck.markets.length) {
      const avgLpLockedPct = rugCheck.markets.reduce((s, m) => s + (m.lp?.lpLockedPct ?? 0), 0) / rugCheck.markets.length;
      if (avgLpLockedPct < 5) {
        score += 10;
        factors.push({
          name: 'LP fully unlocked',
          severity: 'MEDIUM',
          detail: 'Liquidity pool is unlocked — liquidity can be withdrawn at any time, crashing the price.',
        });
      } else if (avgLpLockedPct < 30) {
        score += 5;
        factors.push({
          name: `LP mostly unlocked (${avgLpLockedPct.toFixed(0)}% locked)`,
          severity: 'MEDIUM',
          detail: 'Most LP tokens are unlocked — partial liquidity withdrawal risk.',
        });
      } else {
        factors.push({
          name: `LP locked (${avgLpLockedPct.toFixed(0)}%)`,
          severity: 'LOW',
          detail: 'Majority of liquidity is locked — reduced exit-rug risk.',
        });
      }
    }

    // ── 7. 3-month price change ────────────────────────────────────────────────
    // Source: GeckoTerminal daily OHLCV, candle ~90 days back vs latest close.
    // Thresholds: -15% MEDIUM (+8) | -35% HIGH (+15) | -60% CRITICAL (+22)
    // Weighted higher than 24h — a 3-month decline is a structural signal, not volatility.
    // Only penalised for drops — positive or flat is neutral (not a risk signal).
    if (geckoData?.change3m != null && geckoData.weeksOfData >= 13) {
      const chg = geckoData.change3m;
      if (chg <= -60) {
        score += 22;
        factors.push({ name: `3M price: −${Math.abs(chg).toFixed(0)}%`, severity: 'CRITICAL', detail: `Token has lost ${Math.abs(chg).toFixed(1)}% of its value over the last 3 months. Severe sustained structural decline.` });
      } else if (chg <= -35) {
        score += 15;
        factors.push({ name: `3M price: −${Math.abs(chg).toFixed(0)}%`, severity: 'HIGH', detail: `Down ${Math.abs(chg).toFixed(1)}% over 3 months. Significant sustained selling pressure.` });
      } else if (chg <= -15) {
        score += 8;
        factors.push({ name: `3M price: −${Math.abs(chg).toFixed(0)}%`, severity: 'MEDIUM', detail: `Down ${Math.abs(chg).toFixed(1)}% over 3 months. Notable downward trend.` });
      } else {
        const sign = chg >= 0 ? '+' : '';
        factors.push({ name: `3M price: ${sign}${chg.toFixed(0)}%`, severity: 'LOW', detail: `Price change of ${sign}${chg.toFixed(1)}% over the last 3 months. No significant sustained decline.` });
      }
    } else if (geckoData != null) {
      // Token is less than 3 months old — already penalised under token age; no double-penalty.
      const _d = geckoData.daysOfData ?? 0;
      const _dLabel = _d < 14 ? `${_d}d` : `${Math.floor(_d / 7)}w`;
      factors.push({ name: `3M history: only ${_dLabel} data`, severity: 'LOW', detail: `Only ${_dLabel} of price history available — 3-month comparison is not yet possible. Token age penalty already applied.` });
    }

    // ── 8. Long-term price change (up to 6 months on free tier) ──────────────
    // Source: GeckoTerminal daily OHLCV, oldest available candle vs latest close.
    // Free API max: ~181 daily candles (~6 months). Label reflects actual data span.
    // Thresholds: -20% MEDIUM (+8) | -45% HIGH (+15) | -70% CRITICAL (+22)
    // This is the heaviest price-action signal — a 6-month decline is structural, not noise.
    if (geckoData?.change1y != null && geckoData.weeksOfData >= 25) {
      const chg   = geckoData.change1y;
      const months = Math.round((geckoData.daysOfData ?? (geckoData.weeksOfData * 7)) / 30);
      const label = months >= 11 ? '1Y' : `${months}M`;
      if (chg <= -70) {
        score += 22;
        factors.push({ name: `${label} price: −${Math.abs(chg).toFixed(0)}%`, severity: 'CRITICAL', detail: `Token has lost ${Math.abs(chg).toFixed(1)}% over ${label}. Near-total collapse — structural long-term decline.` });
      } else if (chg <= -45) {
        score += 15;
        factors.push({ name: `${label} price: −${Math.abs(chg).toFixed(0)}%`, severity: 'HIGH', detail: `Down ${Math.abs(chg).toFixed(1)}% over ${label}. Severe long-term decline.` });
      } else if (chg <= -20) {
        score += 8;
        factors.push({ name: `${label} price: −${Math.abs(chg).toFixed(0)}%`, severity: 'MEDIUM', detail: `Down ${Math.abs(chg).toFixed(1)}% over ${label}. Significant long-term depreciation.` });
      } else {
        const sign = chg >= 0 ? '+' : '';
        factors.push({ name: `${label} price: ${sign}${chg.toFixed(0)}%`, severity: 'LOW', detail: `Price change of ${sign}${chg.toFixed(1)}% over ${label}. No severe long-term decline detected.` });
      }
    } else if (geckoData != null) {
      const _d2 = geckoData.daysOfData ?? 0;
      const _d2Label = _d2 < 14 ? `${_d2}d` : `${Math.floor(_d2 / 7)}w`;
      factors.push({ name: `Long-term: only ${_d2Label} data`, severity: 'LOW', detail: `Only ${_d2Label} of price history — long-term comparison is not yet possible.` });
    }

    // ── 9. Volume trend (activity decline) ────────────────────────────────────
    // Source: GeckoTerminal daily OHLCV volume column (index 5 of each candle).
    // Compares last 7-day avg to the preceding 30–90 day window.
    // Detects "dying" tokens where sentiment and trading activity have collapsed
    // even when the spot price hasn't fully reflected the abandonment yet.
    if (geckoData?.volTrend != null) {
      const { ratio, recentAvg, baselineAvg } = geckoData.volTrend;
      const dropPct = Math.round((1 - ratio) * 100);
      const _fmtV = (v) => v >= 1_000_000 ? `$${(v/1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v/1000).toFixed(0)}k` : `$${v.toFixed(0)}`;
      if (ratio < 0.05) {
        score += 22;
        factors.push({ name: `Volume collapsed: −${dropPct}%`, severity: 'CRITICAL', detail: `Recent 7d avg ${_fmtV(recentAvg)}/day vs ${_fmtV(baselineAvg)}/day historically. Trading activity has essentially stopped — strong dying-coin signal.` });
      } else if (ratio < 0.15) {
        score += 15;
        factors.push({ name: `Volume dying: −${dropPct}%`, severity: 'HIGH', detail: `Recent 7d avg ${_fmtV(recentAvg)}/day vs ${_fmtV(baselineAvg)}/day historically. Sharp decline in trading activity.` });
      } else if (ratio < 0.35) {
        score += 8;
        factors.push({ name: `Volume fading: −${dropPct}%`, severity: 'MEDIUM', detail: `Recent 7d avg ${_fmtV(recentAvg)}/day vs ${_fmtV(baselineAvg)}/day. Declining interest from traders.` });
      } else {
        factors.push({ name: `Volume: active`, severity: 'LOW', detail: `Recent 7d avg ${_fmtV(recentAvg)}/day. No significant decline in trading activity detected.` });
      }
    }

    // ── 10. Token age ──────────────────────────────────────────────────────────
    // Source: DexScreener pairCreatedAt (when the first trading pair was created).
    // Suppressed on pump.fun — every token there is <24h old by design;
    // the site-context CRITICAL factor (§5) already captures that risk fully.
    const _isPumpFunSite = window.location.hostname?.includes('pump.fun');
    if (dexData?.pairCreatedAt && !_isPumpFunSite) {
      const ageMs   = Date.now() - dexData.pairCreatedAt;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 1) {
        score += 25;
        factors.push({ name: 'New token: <24h old', severity: 'HIGH', detail: `Trading pair created ${(ageMs/3600000).toFixed(1)}h ago. Rug pulls most commonly occur within the first 24 hours of a token launch.` });
      } else if (ageDays < 7) {
        score += 15;
        factors.push({ name: `New token: ${ageDays.toFixed(0)}d old`, severity: 'HIGH', detail: `Trading pair is ${ageDays.toFixed(0)} days old. Tokens under 7 days old carry elevated rug risk.` });
      } else if (ageDays < 30) {
        score += 5;
        factors.push({ name: `Recent token: ${ageDays.toFixed(0)}d old`, severity: 'MEDIUM', detail: `Trading pair is ${ageDays.toFixed(0)} days old. Under 30 days — some early-exit risk remains.` });
      } else {
        factors.push({ name: `Token age: ${Math.floor(ageDays)}d`, severity: 'LOW', detail: `Trading pair has existed for ${Math.floor(ageDays)} days. Established enough that a sudden rug is less likely.` });
      }
    }

    // ── 10. 24h price change ──────────────────────────────────────────────────
    // On pump.fun a large GAIN means the pump phase is active and a dump is
    // likely imminent — the inverse of the normal exit-rug signal.
    if (dexData?.priceChange24h != null) {
      const chg = parseFloat(dexData.priceChange24h);
      if (isFinite(chg)) {
        if (_isPumpFunSite && chg >= 200) {
          score += 12;
          factors.push({ name: `Active pump: +${chg.toFixed(0)}% in 24h`, severity: 'CRITICAL', detail: `+${chg.toFixed(1)}% since launch \u2014 token is in the pump phase. Dump typically follows immediately after this level of gain.` });
        } else if (_isPumpFunSite && chg >= 80) {
          score += 8;
          factors.push({ name: `Pump in progress: +${chg.toFixed(0)}% in 24h`, severity: 'HIGH', detail: `+${chg.toFixed(1)}% since launch \u2014 significant pump detected. High probability of sharp reversal.` });
        } else if (_isPumpFunSite && chg >= 30) {
          score += 4;
          factors.push({ name: `Rising fast: +${chg.toFixed(0)}% in 24h`, severity: 'MEDIUM', detail: `+${chg.toFixed(1)}% since launch \u2014 elevated momentum. Watch for a sudden reversal.` });
        } else if (chg <= -50) {
          score += 12;
          factors.push({ name: `Price \u2212${Math.abs(chg).toFixed(0)}% in 24h`, severity: 'CRITICAL', detail: `Token has lost ${Math.abs(chg).toFixed(1)}% of its value in the last 24 hours. This level of drop often indicates a rug pull or coordinated exit.` });
        } else if (chg <= -30) {
          score += 8;
          factors.push({ name: `Price \u2212${Math.abs(chg).toFixed(0)}% in 24h`, severity: 'HIGH', detail: `Significant 24h drawdown of ${Math.abs(chg).toFixed(1)}%.` });
        } else if (chg <= -15) {
          score += 4;
          factors.push({ name: `Price \u2212${Math.abs(chg).toFixed(0)}% in 24h`, severity: 'MEDIUM', detail: `Notable 24h price decline of ${Math.abs(chg).toFixed(1)}%.` });
        } else {
          const sign = chg >= 0 ? '+' : '';
          factors.push({ name: `24h price: ${sign}${chg.toFixed(1)}%`, severity: 'LOW', detail: _isPumpFunSite ? `Modest movement since launch \u2014 not yet in active pump territory.` : `No significant downward movement detected.` });
        }
      }
    }

    // ── 11. Liquidity depth ────────────────────────────────────────────────────
    // Source: DexScreener liquidity.usd (USD value in the trading pool).
    // Formula: thin liquidity means a single sell can crash the price, and it
    // is trivially easy for the deployer to drain a small pool.
    if (dexData?.liquidityUsd != null) {
      const liq = dexData.liquidityUsd;
      if (liq < 5_000) {
        score += 25;
        factors.push({ name: `Liquidity: $${liq < 1000 ? liq.toFixed(0) : (liq/1000).toFixed(1)+'k'}`, severity: 'CRITICAL', detail: `Only $${liq.toFixed(0)} in the liquidity pool. At this depth any normal swap will cause extreme slippage, and the deployer can drain it immediately.` });
      } else if (liq < 25_000) {
        score += 15;
        factors.push({ name: `Low liquidity: $${(liq/1000).toFixed(1)}k`, severity: 'HIGH', detail: `$${(liq/1000).toFixed(1)}k in the trading pool. Low liquidity means high slippage and easy price manipulation.` });
      } else if (liq < 100_000) {
        score += 8;
        factors.push({ name: `Liquidity: $${(liq/1000).toFixed(0)}k`, severity: 'MEDIUM', detail: `$${(liq/1000).toFixed(0)}k liquidity. Moderate depth — large trades may still move the price significantly.` });
      } else {
        const fmt = liq >= 1_000_000 ? `$${(liq/1_000_000).toFixed(1)}M` : `$${(liq/1000).toFixed(0)}k`;
        factors.push({ name: `Liquidity: ${fmt}`, severity: 'LOW', detail: `${fmt} in the trading pool. Sufficient liquidity for normal trading.` });
      }
    }

    // ── 12. Market cap ────────────────────────────────────────────────────────
    // Source: DexScreener marketCap (circulating) or fdv (fully diluted).
    // Formula: very low market cap tokens are trivially cheap to manipulate —
    // a $10k buy can move the price 10% on a $100k mcap token.
    if (dexData?.marketCap != null) {
      const mc = dexData.marketCap;
      if (mc < 50_000) {
        score += 15;
        factors.push({ name: `Micro-cap: $${(mc/1000).toFixed(0)}k`, severity: 'HIGH', detail: `Market cap of $${(mc/1000).toFixed(0)}k. At this size a single trader can move the price dramatically. Extremely easy to pump-and-dump.` });
      } else if (mc < 500_000) {
        score += 8;
        factors.push({ name: `Small-cap: $${(mc/1000).toFixed(0)}k`, severity: 'MEDIUM', detail: `Market cap of $${(mc/1000).toFixed(0)}k. Relatively small — susceptible to coordinated price movements.` });
      } else if (mc < 10_000_000) {
        score += 3;
        factors.push({ name: `Market cap: $${(mc/1_000_000).toFixed(1)}M`, severity: 'LOW', detail: `Market cap of $${(mc/1_000_000).toFixed(1)}M. Mid-range — moderate manipulation resistance.` });
      } else {
        const fmt = mc >= 1_000_000_000 ? `$${(mc/1_000_000_000).toFixed(1)}B` : `$${(mc/1_000_000).toFixed(0)}M`;
        factors.push({ name: `Market cap: ${fmt}`, severity: 'LOW', detail: `Market cap of ${fmt}. Large enough that price manipulation by a single actor is significantly harder.` });
      }
    }

    // ── 13. Serial deployer ───────────────────────────────────────────────────
    // deployerData: { address: string, tokenCount: number } | null
    // Tiers calibrated against real pump.fun bot behaviour:
    //   ≥50 = scripted factory (token every ~14h)
    //   ≥25 = near-automated (physically implausible manually)
    //   ≥10 = systematic serial launcher
    //    ≥3 = repeat experimenter / early-stage bad actor
    if (deployerData?.address) {
      const tc = deployerData.tokenCount ?? 0;
      if (tc >= 50) {
        score += 35;
        factors.push({ name: `Bot factory — ${tc} deploys in 30d`, severity: 'CRITICAL', detail: `Creator wallet launched ${tc} tokens in 30 days (~1 every 14h). Scripted bot factory — near-certain rug.` });
      } else if (tc >= 25) {
        score += 30;
        factors.push({ name: `Bot-created token — ${tc} deploys in 30d`, severity: 'CRITICAL', detail: `Creator wallet launched ${tc} tokens in 30 days — physically implausible without automation. Automated rug pipeline.` });
      } else if (tc >= 10) {
        score += 20;
        factors.push({ name: `Serial launcher — ${tc} tokens in 30d`, severity: 'HIGH', detail: `Creator wallet has launched ${tc} tokens in 30 days. Systematic serial launches are a strong rug-pull indicator.` });
      } else if (tc >= 3) {
        score += 8;
        factors.push({ name: `Repeat creator — ${tc} tokens in 30d`, severity: 'MEDIUM', detail: `Creator has launched ${tc} tokens in the last 30 days. May be an experimenter or early-stage bad actor.` });
      } else {
        factors.push({
          name: tc === 0 ? 'Creator: first token ever' : `Creator: ${tc} token${tc === 1 ? '' : 's'} in 30d`,
          severity: 'LOW',
          detail: tc === 0
            ? 'No previous tokens found for this deployer wallet. Could be a brand-new creator.'
            : `Creator has launched ${tc} token${tc === 1 ? '' : 's'} in the last 30 days — no serial-launch pattern detected.`,
        });
      }
    }

    // ── 14. Deployer rug rate ─────────────────────────────────────────────────
    // rugRateData: { checked: number, ruggedCount: number } | null
    // Only scored when we've sampled at least 3 of the deployer's previous tokens.
    if (rugRateData?.checked >= 3) {
      const { checked, ruggedCount } = rugRateData;
      const rugPct = Math.round((ruggedCount / checked) * 100);
      if (rugPct >= 80) {
        score += 20;
        factors.push({ name: `${ruggedCount}/${checked} prev tokens went to zero`, severity: 'CRITICAL', detail: `${rugPct}% of this creator's sampled previous tokens collapsed to near-zero liquidity. Consistent rug-pull pattern confirmed.` });
      } else if (rugPct >= 60) {
        score += 15;
        factors.push({ name: `${ruggedCount}/${checked} prev tokens went to zero`, severity: 'HIGH', detail: `${rugPct}% of sampled previous tokens from this creator have near-zero liquidity. Strong rug-pull pattern.` });
      } else if (rugPct >= 40) {
        score += 8;
        factors.push({ name: `${ruggedCount}/${checked} prev tokens: most failed`, severity: 'MEDIUM', detail: `${rugPct}% of sampled previous tokens from this creator have low or no liquidity.` });
      } else {
        factors.push({ name: `${ruggedCount}/${checked} prev tokens: some losses`, severity: 'LOW', detail: `${rugPct}% of sampled previous tokens have low liquidity — within normal range for speculative launches.` });
      }
    }

    // ── 16. Bundle launch detection ────────────────────────────────────────────
    // Checks whether multiple wallets bought in the token's creation slot —
    // the on-chain fingerprint of a Jito bundle coordinated supply grab.
    // +40 CRITICAL (≥5 wallets/txs) | +20 HIGH (3–4) | LOW (1–2) | skip (null/error)
    if (bundleLaunchData != null && !bundleLaunchData.inconclusive) {
      const { bundleLevel, creationSlotTxCount } = bundleLaunchData;
      const count = creationSlotTxCount ?? 0;
      if (bundleLevel === 'high') {
        score += 40;
        factors.push({
          name: `Bundled launch: ${count} ${unit} on creation block`,
          severity: 'CRITICAL',
          detail: `${count} ${unit === 'wallets' ? 'wallets' : 'transactions'} executed in the token\'s creation block \u2014 consistent with Jito bundle manipulation. Insiders pre-load supply across multiple wallets for a coordinated dump on retail buyers.`,
        });
      } else if (bundleLevel === 'medium') {
        score += 20;
        factors.push({
          name: `Possible bundle: ${count} ${unit} in creation slot`,
          severity: 'HIGH',
          detail: `${count} ${unit === 'wallets' ? 'wallets' : 'transactions'} in the creation block. Consistent with a small Jito bundle \u2014 check top holder concentration for confirmation.`,
        });
      } else {
        // bundleLevel === 'low': 1\u20132 txs/wallets \u2014 normal launch pattern
        factors.push({
          name: `Normal launch: ${count || 1} ${unit} in creation block`,
          severity: 'LOW',
          detail: `Only ${count || 1} transaction${count === 1 ? '' : 's'} in the creation block. No bundle pattern detected.`,
        });
      }
    } else if (bundleLaunchData?.inconclusive) {
      factors.push({
        name: 'Bundle check: inconclusive',
        severity: 'LOW',
        detail: 'Token has a high transaction count \u2014 creation block analysis is unavailable. Check top holder concentration for insider supply signals.',
      });
    }
    // bundleLaunchData === null → fetch failed silently; no factor added to avoid noise

    // ── Fallback: no data at all ──────────────────────────────────────────────
    if (!mintInfo && !holderData && !rugCheck && !dexData && !geckoData) {
      score += 15;
      factors.push({ name: 'Token data unavailable', severity: 'MEDIUM', detail: 'Could not fetch on-chain, RugCheck, or DexScreener data — proceed with caution' });
    }

    const finalScore = Math.max(0, Math.min(100, score));
    const level      = finalScore >= 75 ? 'CRITICAL'
      : finalScore >= 50 ? 'HIGH'
      : finalScore >= 25 ? 'MEDIUM'
      : 'LOW';

    const dataSource = [rugCheck && 'rugcheck', (mintInfo || holderData) && 'onchain', dexData && 'dex', geckoData && 'gecko']
      .filter(Boolean).join('+') || 'unknown';
    const symbol = rugCheck?.tokenMeta?.symbol ?? dexData?.symbol ?? null;

    return {
      mint, symbol, score: finalScore, level, factors, loaded: true, error: null, dataSource,
      deployer: deployerData?.address ?? null, deployerTokenCount: deployerData?.tokenCount ?? null,
    };
  }

  // ── Public: fetchTokenScore(mint, symbol?) ───────────────────────────────────
  async function fetchTokenScore(mint, symbol) {
    if (!mint || typeof mint !== 'string') {
      return { mint, score: 0, level: 'LOW', factors: [], loaded: false, error: 'No mint address', dataSource: 'unknown' };
    }

    // Regulated stablecoins — mint/freeze authorities are institutional compliance features,
    // not rug risks. GeckoTerminal price data reflects the paired asset, not the stablecoin.
    if (STABLECOIN_MINTS.has(mint)) {
      const sym = symbol ?? mint.slice(0, 4) + '…';
      const result = {
        mint, score: 0, level: 'LOW',
        factors: [{ name: `Regulated stablecoin (${sym})`, severity: 'LOW', detail: 'Issued by a regulated institution (e.g. Circle/Tether). Mint and freeze authorities are compliance features, not rug risks. Price data in pools reflects the paired asset.' }],
        loaded: true, error: null, dataSource: 'safe',
      };
      _setCached(mint, result);
      ns.tokenScoreResult = result;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      return result;
    }
    // Blue-chip DeFi protocol tokens — audited deployments with real utility.
    // Rug heuristics (LP lock, 3M price, RugCheck noise) produce false MEDIUM signals.
    if (KNOWN_BLUECHIP_MINTS.has(mint)) {
      const sym = KNOWN_BLUECHIP_MINTS.get(mint);
      const result = {
        mint, score: 0, level: 'LOW',
        factors: [{ name: `Established protocol token (${sym})`, severity: 'LOW', detail: 'Audited Solana DeFi protocol token with transparent team and real on-chain utility. Rug-pull heuristics are not applicable.' }],
        loaded: true, error: null, dataSource: 'safe',
      };
      _setCached(mint, result);
      ns.tokenScoreResult = result;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      return result;
    }
    // Cache hit — show cached immediately and re-render.
    const cached = _getCached(mint);
    if (cached) {
      ns.tokenScoreResult = cached;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      return cached;
    }

    // Mark in-progress so widget shows "Scanning…". If we have a last-known
    // result for this mint, show that as a fallback while the fresh fetch runs.
    const lastKnown = _getLastKnown(mint);
    if (lastKnown) {
      ns.tokenScoreResult = Object.assign({}, lastKnown, { loaded: false });
      try { ns.renderWidgetPanel?.(); } catch (_) {}
    } else {
      ns.tokenScoreResult = { mint, score: 0, level: 'LOW', factors: [], loaded: false, error: null, dataSource: 'unknown' };
      try { ns.renderWidgetPanel?.(); } catch (_) {}
    }

    try {
      // Parallel fetch — on-chain + RugCheck + DexScreener + GeckoTerminal + bundle detection
      const [mintInfo, holderData, rugCheck, dexData, geckoData, bundleLaunchData] = await Promise.all([
        _fetchMintInfo(mint).catch(() => null),
        _fetchHolderData(mint).catch(() => null),
        _fetchRugCheck(mint).catch(() => null),
        _fetchDexScreener(mint).catch(() => null),
        _fetchGeckoTerminal(mint).catch(() => null),
        _fetchBundleLaunch(mint).catch(() => null),
      ]);

      // Phase 1: publish 12-signal partial result immediately so the widget shows real
      // risk factors within ~1s while the slower deployer RPC lookup runs in background.
      const _partial = _computeScore(mintInfo, holderData, rugCheck, dexData, geckoData, mint, null, null, bundleLaunchData);
      _partial.factors.push({ name: 'Creator history — scanning on-chain…', severity: 'LOW', detail: 'Checking how many tokens this wallet has deployed and how many went to zero.' });
      _partial._deployerPending = true;
      // Guard: only update UI if this mint is still relevant.
      // Checks Jupiter trade context, Jupiter live quote, and pump.fun context.
      const _currentMint = () =>
        ns.widgetCapturedTrade?.outputMint ??
        ns.jupiterLiveQuote?.outputMint ??
        ns.pumpFunContext?.outputMint ??
        ns._tokenScoreMint ??
        null;
      if (_currentMint() === mint) {
        ns.tokenScoreResult = _partial;
        try { ns.renderWidgetPanel?.(); } catch (_) {}
      }

      // Phase 2: deployer lookup — best-effort; does not block the Phase 1 result.
      let deployerData = null;
      let rugRateData  = null;
      try {
        const address = await _getRealDeployer(mint);
        if (address) {
          const td     = await _getDeployerTokenData(address, 30);
          deployerData = { address, tokenCount: td.tokenCount };
          if (td.mints.length >= 3) rugRateData = await _fetchDeployerRugRate(td.mints);
        }
      } catch (_) { /* deployer lookup is best-effort */ }

      const result = _computeScore(mintInfo, holderData, rugCheck, dexData, geckoData, mint, deployerData, rugRateData, bundleLaunchData);
      _setCached(mint, result);

      // Re-check mint relevance — user may have switched tokens during the 5–10s deployer lookup
      if (_currentMint() === mint) {
        ns.tokenScoreResult = result;
        try { ns.renderWidgetPanel?.(); } catch (_) {}
      }
      return result;
    } catch (err) {
      // On any unexpected error, fall back to the last-known result for this mint
      // so the UI doesn't remain stuck on "Scanning…". If no fallback exists,
      // return an error-shaped result.
      const fallback = _getLastKnown(mint);
      if (fallback) {
        try { ns.tokenScoreResult = fallback; ns.renderWidgetPanel?.(); } catch (_) {}
        return fallback;
      }
      const errResult = {
        mint, score: 0, level: 'LOW', factors: [{ name: 'Scan failed', severity: 'LOW', detail: err?.message ?? 'Unknown error' }],
        loaded: false, error: err?.message ?? 'Scan failed', dataSource: 'unknown',
      };
      try { ns.tokenScoreResult = errResult; ns.renderWidgetPanel?.(); } catch (_) {}
      return errResult;
    }
  }

  // ── Export ───────────────────────────────────────────────────────────────────
  Object.assign(ns, { fetchTokenScore });
})();
