/**
 * ZendIQ – page-sandwich.js
 * Post-trade sandwich detection. After a swap confirms, scans the surrounding
 * transactions in the same block for the buy-before / sell-after attacker pattern.
 *
 * Exposes:  ns.detectSandwich(sig, inputMint, outputMint, opts?)
 * State:    ns.sandwichCache   (Map<sig, result>)
 *           ns._sandwichPending (Set<sig>)
 *
 * Runs in MAIN world. All RPC calls route through ns.rpcCall → background bridge
 * so they are never blocked by Brave Shields or jup.ag's CSP.
 */

(function () {
  'use strict';
  const ns = window.__zq;
  if (!ns) return;

  // Initialise state containers declared (as null) in page-config.js
  ns.sandwichCache    = new Map();
  ns._sandwichPending = new Set();

  // How many transactions to inspect on each side of the user's tx index.
  const WINDOW_SIZE   = 3;
  // Abort the whole check if it takes longer than this.
  const TIMEOUT_MS    = 15000;

  // Known Jito tip accounts — sandwich bots tip one of these to guarantee bundle ordering.
  const JITO_TIP_ACCOUNTS = new Set([
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4bPuSFBYcbiSMRNxRHFafST',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUC5Dga3spHMc5ighxFExbqGXmWB9aXCBpos',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  ]);

  // Known sandwich bot program IDs.
  const KNOWN_BOT_PROGRAMS = new Set([
    'vpeNALD58ByDMBiMqJcUBxfj4P1K7FniYV2cHT2YBwp',  // DeezNode / Vpe — ~50% of Solana sandwiches
    'B91piBSfCBRs5rUxCMRdJEGv7tNEnFxweWcdQJHJoFpi',  // B91 bot
  ]);

  // ── helpers ──────────────────────────────────────────────────────────────

  // Native SOL mint address — balance lives in meta.preBalances/postBalances, not token balances.
  const SOL_MINT = 'So11111111111111111111111111111111111111112';

  // Returns the raw-integer delta (post − pre) for a given wallet+mint pair.
  // Sums ALL matching entries for that owner+mint (a wallet can have multiple
  // token accounts for the same mint — only taking the first one would miss the
  // real balance change if the bot uses a non-default ATA).
  function _ownerDelta(preBals, postBals, walletPubkey, mint) {
    const _sum = (arr) => (arr ?? [])
      .filter(b => b.owner === walletPubkey && b.mint === mint)
      .reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);
    return _sum(postBals) - _sum(preBals);
  }

  // Returns the native SOL lamport delta for a wallet in a tx.
  // Uses meta.preBalances/postBalances indexed by accountKeys position.
  function _nativeDelta(txData, walletPubkey) {
    const keys = (txData?.transaction?.message?.accountKeys ?? [])
      .map(k => (typeof k === 'string' ? k : k?.pubkey));
    const idx = keys.indexOf(walletPubkey);
    if (idx < 0) return 0;
    const pre  = txData?.meta?.preBalances?.[idx]  ?? 0;
    const post = txData?.meta?.postBalances?.[idx] ?? 0;
    return post - pre;
  }

  // Extracts the fee-payer pubkey from a jsonParsed getTransaction result.
  // accountKeys[0] is always fee payer for both legacy and versioned txs.
  function _feePayer(txData) {
    const keys = txData?.transaction?.message?.accountKeys;
    if (!Array.isArray(keys) || !keys.length) return null;
    const first = keys[0];
    return typeof first === 'string' ? first : (first?.pubkey ?? null);
  }

  // Wraps an async function with a hard timeout.
  function _withTimeout(ms, fn) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
  }

  // Returns the Jito tip account pubkey that this tx tips, or null.
  // Scans all parsed transfer instructions (top-level + inner).
  function _checkJitoTip(txData) {
    const _scanInstrs = (instrs) => {
      for (const ix of (instrs ?? [])) {
        const dest = ix?.parsed?.info?.destination;
        if (dest && JITO_TIP_ACCOUNTS.has(dest)) return dest;
      }
      return null;
    };
    const topLevel = txData?.transaction?.message?.instructions ?? [];
    const inner    = (txData?.meta?.innerInstructions ?? []).flatMap(ii => ii.instructions ?? []);
    return _scanInstrs(topLevel) ?? _scanInstrs(inner);
  }

  // Returns true if the tx interacts with a known sandwich bot program.
  function _checkBotProgram(txData) {
    const topLevel = (txData?.transaction?.message?.instructions ?? []).map(ix => ix.programId);
    const inner    = (txData?.meta?.innerInstructions ?? []).flatMap(ii => (ii.instructions ?? []).map(ix => ix.programId));
    return [...topLevel, ...inner].some(pid => pid && KNOWN_BOT_PROGRAMS.has(pid));
  }

  // ── main export ──────────────────────────────────────────────────────────

  /**
   * detectSandwich(sig, inputMint, outputMint, opts?)
   *
   * Returns a result object (see below) or null if the check was skipped / deduped.
   *
   * Result shapes:
   *   { detected: false }
   *   { detected: true, attackerWallet, frontRunSig, backRunSig,
   *     extractedNative, extractedUI, extractedUsd (null if no price) }
   *   { error: 'timeout' | 'unavailable' }
   *
   * opts: { inputDecimals?, amountIn?, amountInUsd? }
   *   amountIn    – UI-unit input amount (e.g. "5.0" USDC)
   *   amountInUsd – USD value of that input (used for extraction USD estimate)
   */
  async function detectSandwich(sig, inputMint, outputMint, opts = {}) {
    if (!sig || !inputMint || !outputMint) return null;

    // Guard against containers not yet initialized (e.g. called before IIFE settled)
    if (!(ns.sandwichCache instanceof Map))    ns.sandwichCache    = new Map();
    if (!(ns._sandwichPending instanceof Set)) ns._sandwichPending = new Set();

    // Dedup — don't run two concurrent checks for the same tx
    if (ns._sandwichPending.has(sig)) return null;
    // Only serve cache hits for real results — error entries are not cached so retries work.
    const _cached = ns.sandwichCache.get(sig);
    if (_cached && !_cached.error) return _cached;

    ns._sandwichPending.add(sig);

    try {
      const result = await _withTimeout(TIMEOUT_MS, async () => {

        // ── Step 1: resolve slot from the user's tx ───────────────────────
        const txRes = await ns.rpcCall('getTransaction', [
          sig,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
        ]);
        if (!txRes?.result) return { error: 'unavailable' };
        const slot = txRes.result.slot;

        // ── Step 2: find adjacent signatures in the same block ───────────────
        // getBlock is blocked on public free-tier RPCs.
        // Strategy: identify the DEX pool vault accounts from the user's tx
        // meta (token accounts owned by someone other than the fee payer —
        // those are the liquidity pool vaults).  Every swap on the same pool
        // touches the same vaults, including attacker sandwich txs.
        // getSignaturesForAddress on a busy vault with limit:20 filtered to
        // the same slot reliably surfaces same-block neighbours.
        const userTx   = txRes.result;
        const feePayer = _feePayer(userTx);
        if (!feePayer) return { error: 'unavailable' };

        const _staticKeys = (userTx.transaction?.message?.accountKeys ?? [])
          .map(k => (typeof k === 'string' ? k : k?.pubkey))
          .filter(Boolean);
        // For V0 transactions (Raydium CLMM/CPMM) pool vault accounts are ALT-loaded.
        // preTokenBalances[].accountIndex uses the FULL ordered list:
        //   [static keys] + [ALT writable] + [ALT readonly]
        // Without appending these, vault indices beyond staticKeys.length return undefined,
        // leaving _poolVaults empty and causing 'unavailable' for every CLMM sandwich check.
        const _altWritable = userTx.meta?.loadedAddresses?.writable ?? [];
        const _altReadonly = userTx.meta?.loadedAddresses?.readonly ?? [];
        const _accountKeys = [..._staticKeys, ..._altWritable, ..._altReadonly];

        // Pool vault accounts: appear in preTokenBalances with an owner that
        // is NOT the user's fee payer (i.e. owned by the DEX program).
        const _poolVaultIdxs = (userTx.meta?.preTokenBalances ?? [])
          .filter(b => b.owner && b.owner !== feePayer)
          .map(b => b.accountIndex)
          .filter(i => i < _accountKeys.length);
        const _poolVaults = [...new Set(_poolVaultIdxs.map(i => _accountKeys[i]))].slice(0, 2);

        // Pump.fun bonding curve override — every buy/sell on a pump.fun token touches
        // the same Bonding Curve account (accounts[3] of the instruction), which is a
        // more reliable lookup key than the vault accounts used for Raydium/Jupiter.
        // PumpSwap (pAMMBay6...) uses the same accounts[] layout — handle both.
        const PUMP_PROGRAMS = new Set([
          '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun bonding curve
          'pAMMBay6oceH4gMLqCv6JEBYFrwJYRn6JhQVacyKbNe',  // PumpSwap (same layout; no test data yet)
        ]);
        const _pumpIx = (userTx.transaction?.message?.instructions ?? []).find(
          ix => PUMP_PROGRAMS.has(ix.programId)
        );
        if (_pumpIx && Array.isArray(_pumpIx.accounts) && _pumpIx.accounts.length > 3) {
          const _bondingCurve = _pumpIx.accounts[3];
          if (_bondingCurve) {
            // Replace vault list with the single bonding curve address.
            _poolVaults.length = 0;
            _poolVaults.push(_bondingCurve);
          }
        }

        if (_poolVaults.length === 0) return { error: 'unavailable' };

        // Query both pool vaults (if available) and merge — the back-run tx may
        // only touch the second vault (e.g. SOL side of the pool), so querying only
        // vault[0] would miss it entirely.
        const _vaultQueries = _poolVaults.flatMap(_va => [
          ns.rpcCall('getSignaturesForAddress', [_va, { before: sig, limit: 20, commitment: 'confirmed' }]),
          ns.rpcCall('getSignaturesForAddress', [_va, { until: sig,  limit: 20, commitment: 'confirmed' }]),
        ]);
        const _settled = await Promise.allSettled(_vaultQueries);
        const _vaultResults = _settled.map(s => s.status === 'fulfilled' ? s.value : null);

        // Keep only sigs that landed in the same slot as the user's tx.
        const _inSlot = (res) =>
          (res?.result ?? [])
            .filter(item => item.slot === slot && item.signature !== sig)
            .map(item => item.signature);

        // Even-indexed results are "before" queries; odd-indexed are "until" queries.
        const beforeSigs = _vaultResults.filter((_, i) => i % 2 === 0).flatMap(_inSlot);
        const afterSigs  = _vaultResults.filter((_, i) => i % 2 === 1).flatMap(_inSlot);

        // Build deduplicated candidate list with direction offsets.
        const seenCandidates = new Set();
        const candidateJobs  = [];
        for (const s of beforeSigs) {
          if (!seenCandidates.has(s)) { seenCandidates.add(s); candidateJobs.push({ cSig: s, offset: -1 }); }
        }
        for (const s of afterSigs) {
          if (!seenCandidates.has(s)) { seenCandidates.add(s); candidateJobs.push({ cSig: s, offset: 1 }); }
        }

        // Fetch all candidates in parallel — failures are tolerated individually
        const settled = await Promise.allSettled(
          candidateJobs.map(async ({ cSig, offset }) => {
            const r = await ns.rpcCall('getTransaction', [
              cSig,
              { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
            ]);
            return { cSig, offset, data: r?.result ?? null };
          })
        );

        // ── Step 4: classify each candidate as front-run or back-run ─────
        const fronts = []; // bought outputMint BEFORE user's tx
        const backs  = []; // sold  outputMint AFTER  user's tx

        for (const s of settled) {
          if (s.status !== 'fulfilled') continue;
          const { cSig, offset, data } = s.value;
          if (!data?.meta) continue;

          const fp   = _feePayer(data);
          if (!fp) continue;

          const pre  = data.meta.preTokenBalances  ?? [];
          const post = data.meta.postTokenBalances ?? [];

          // For native SOL pairs, deltas must come from lamport arrays, not token balances.
          const outDelta = outputMint === SOL_MINT ? _nativeDelta(data, fp) : _ownerDelta(pre, post, fp, outputMint);
          const inDelta  = inputMint  === SOL_MINT ? _nativeDelta(data, fp) : _ownerDelta(pre, post, fp, inputMint);

          // Front-run: bought outputMint before the user's tx.
          // Back-run:  sold outputMint after the user's tx.
          if (offset < 0 && outDelta > 0) {
            fronts.push({
              cSig, offset, feePayer: fp,
              outDelta,
              inSpent: Math.abs(Math.min(inDelta, 0)),
              txData: data,
            });
          } else if (offset > 0 && outDelta < 0) {
            // After user — sold outputMint (back-run)
            backs.push({
              cSig, offset, feePayer: fp,
              outSold:    Math.abs(outDelta),
              inReceived: Math.max(inDelta, 0),
              txData: data,
            });
          }
        }

        // ── Step 5: match front + back by the SAME fee-payer wallet ──────
        for (const front of fronts) {
          const back = backs.find(b => b.feePayer === front.feePayer);
          if (!back) continue;

          // Extraction = what the attacker net received in inputMint units
          // back.inReceived - front.inSpent  (positive = profit extracted from user's fill)
          const extractedNative = Math.max(0, back.inReceived - front.inSpent);
          const inputDec = opts.inputDecimals != null ? Number(opts.inputDecimals) : 6;
          const extractedUI = extractedNative / Math.pow(10, inputDec);

          // Convert to USD when caller provides input-token price data
          let extractedUsd = null;
          const _amtIn  = opts.amountIn  != null ? Number(opts.amountIn)  : null;
          const _usdIn  = opts.amountInUsd != null ? Number(opts.amountInUsd) : null;
          if (_amtIn > 0 && _usdIn != null) {
            const pricePerUIUnit = _usdIn / _amtIn;
            extractedUsd = extractedUI * pricePerUIUnit;
          }

          const res = {
            detected: true,
            confidence: 'confirmed',
            signals: ['same_wallet', 'token_flow'],
            attackerWallet: front.feePayer,
            frontRunSig:    front.cSig,
            backRunSig:     back.cSig,
            extractedNative,
            extractedUI,
            extractedUsd,
            inputMint,
            outputMint,
            scanned: candidateJobs.length,
            slot,
          };
          ns.sandwichCache.set(sig, res);
          return res;
        }

        // ── Step 5b: cross-wallet matching ─────────────────────────────────────
        // No same-wallet pair found. Check for token_flow pattern + at least
        // one strong corroborating signal (Jito bundle or known bot program).
        if (fronts.length > 0 && backs.length > 0) {
          const bestFront = fronts.reduce((a, b) => b.outDelta > a.outDelta ? b : a);
          const bestBack  = backs.reduce((a, b)  => b.outSold  > a.outSold  ? b : a);

          const signals5b = ['token_flow'];

          // Jito bundle correlation: both legs tip the same Jito tip account.
          const frontTip = _checkJitoTip(bestFront.txData);
          const backTip  = _checkJitoTip(bestBack.txData);
          if (frontTip && backTip && frontTip === backTip) signals5b.push('jito_bundle');

          // Known bot program: either leg uses a known sandwich program.
          if (_checkBotProgram(bestFront.txData) || _checkBotProgram(bestBack.txData)) {
            signals5b.push('known_program');
          }

          // Require at least one strong signal beyond token_flow alone.
          const hasStrong = signals5b.includes('jito_bundle') || signals5b.includes('known_program');
          if (hasStrong) {
            const extractedNative5b = Math.max(0, bestBack.inReceived - bestFront.inSpent);
            const inputDec5b = opts.inputDecimals != null ? Number(opts.inputDecimals) : 6;
            const extractedUI5b    = extractedNative5b / Math.pow(10, inputDec5b);
            let extractedUsd5b = null;
            const _amtIn5b = opts.amountIn    != null ? Number(opts.amountIn)    : null;
            const _usdIn5b = opts.amountInUsd != null ? Number(opts.amountInUsd) : null;
            if (_amtIn5b > 0 && _usdIn5b != null) extractedUsd5b = extractedUI5b * (_usdIn5b / _amtIn5b);

            const res5b = {
              detected: true,
              confidence: 'probable',
              signals: signals5b,
              attackerWallet: null,
              frontRunSig:    bestFront.cSig,
              backRunSig:     bestBack.cSig,
              extractedNative: extractedNative5b,
              extractedUI:     extractedUI5b,
              extractedUsd:    extractedUsd5b,
              inputMint,
              outputMint,
              scanned: candidateJobs.length,
              slot,
            };
            ns.sandwichCache.set(sig, res5b);
            return res5b;
          }
        }

        // ── Step 5c: front-run only detection ──────────────────────────────
        // The back-run sell is unreachable via RPC in Jito bundles due to cursor-
        // pagination ordering — `getSignaturesForAddress` cannot consistently place
        // the back-run in afterSigs.  Similarly, the front-run itself may land in
        // afterSigs (offset:1) rather than beforeSigs when the bundle reorders txs
        // within the same slot, causing it to be skipped by the offset<0 guard above.
        //
        // A sandwich bot MUST front-run the victim (buy the same token in the same
        // slot) — detecting the front-run alone is sufficient and is how most
        // production sandwich detectors work.  Scan ALL settled candidates (both
        // offsets) for non-victim wallets that gained the outputMint token.
        const _frontRunBuyers = [];
        for (const s of settled) {
          if (s.status !== 'fulfilled') continue;
          const { cSig: _cSig, data: _data } = s.value;
          if (!_data?.meta) continue;
          const _fp = _feePayer(_data);
          if (!_fp || _fp === feePayer) continue; // skip victim
          const _pre  = _data.meta.preTokenBalances  ?? [];
          const _post = _data.meta.postTokenBalances ?? [];
          const _tokenDelta = outputMint === SOL_MINT
            ? _nativeDelta(_data, _fp)
            : _ownerDelta(_pre, _post, _fp, outputMint);
          if (_tokenDelta <= 0) continue; // did not gain outputMint — not a buy
          // SOL spent (lamports → SOL); negative lamport delta = spent SOL buying tokens.
          const _solLamDelta = _nativeDelta(_data, _fp);
          const _solSpent    = _solLamDelta < 0 ? Math.abs(_solLamDelta) / 1e9 : null;
          _frontRunBuyers.push({ cSig: _cSig, feePayer: _fp, tokenDelta: _tokenDelta, solSpent: _solSpent, txData: _data });
        }

        if (_frontRunBuyers.length > 0) {
          // Pick the wallet that bought the most tokens (largest front-run).
          const _best = _frontRunBuyers.reduce((a, b) => b.tokenDelta > a.tokenDelta ? b : a);
          const _sig5c = ['token_flow'];
          if (_checkJitoTip(_best.txData))  _sig5c.push('jito_bundle');
          if (_checkBotProgram(_best.txData)) _sig5c.push('known_program');
          if (_frontRunBuyers.length > 1)     _sig5c.push('multi_front_runner');
          // Confidence: possible with token_flow alone; probable with at least one
          // corroborating signal (Jito, known program, or multiple buyers in same slot).
          const _conf5c = _sig5c.length > 1 ? 'probable' : 'possible';
          // Rough extraction estimate: the bot's SOL spend as a fraction of the
          // victim's input represents the price impact they extracted from the user.
          // We can't compute exact profit without the back-run.
          let _extUsd5c = null;
          const _amtIn5c = opts.amountIn    != null ? Number(opts.amountIn)    : null;
          const _usdIn5c = opts.amountInUsd != null ? Number(opts.amountInUsd) : null;
          if (_best.solSpent != null && _amtIn5c > 0 && _usdIn5c != null) {
            // Extraction ≈ victim's input USD × (bot_sol / victim_sol) × typical margin 10%
            _extUsd5c = _usdIn5c * (_best.solSpent / _amtIn5c) * 0.10;
          }
          const res5c = {
            detected: true,
            method:   'front-run',
            confidence: _conf5c,
            signals:   _sig5c,
            attackerWallet: _best.feePayer,
            frontRunSig:    _best.cSig,
            backRunSig:     null,
            frontRunner: {
              wallet:     _best.feePayer,
              signature:  _best.cSig,
              tokenDelta: _best.tokenDelta,
              solSpent:   _best.solSpent,
            },
            extractedNative: null,
            extractedUI:     null,
            extractedUsd:    _extUsd5c,
            inputMint,
            outputMint,
            scanned: candidateJobs.length,
            slot,
          };
          ns.sandwichCache.set(sig, res5c);
          return res5c;
        }

        // No matching pair or front-runner found — clean
        const cleanRes = { detected: false, scanned: candidateJobs.length, slot };
        ns.sandwichCache.set(sig, cleanRes);
        return cleanRes;
      });

      // Only cache successful results — errors (timeout / unavailable) are not cached
      // so that a later retry (after the block becomes available on the RPC) can succeed.
      if (result && !result.error) ns.sandwichCache.set(sig, result);
      return result;

    } catch (e) {
      // Don't cache errors — allow retry on next Activity tab open.
      return { error: e.message === 'timeout' ? 'timeout' : 'unavailable' };
    } finally {
      ns._sandwichPending.delete(sig);
    }
  }

  ns.detectSandwich = detectSandwich;
})();
