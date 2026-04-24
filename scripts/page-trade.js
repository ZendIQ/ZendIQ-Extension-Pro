/**
 * ZendIQ ? trade.js
 * Trade capture, quote fetching, signing, and the handleOptimiseTrade flow.
 */

(function () {
  'use strict';
  const ns = window.__zq;

  // -- extractMintsFromContext ----------------------------------------------
  function extractMintsFromContext(txInfo) {
    try {
      const u = new URL(window.location.href);
      const sell = u.searchParams.get('sell') ?? u.searchParams.get('inputMint');
      const buy  = u.searchParams.get('buy')  ?? u.searchParams.get('outputMint');
      if (sell && buy && sell.length >= 32 && buy.length >= 32) {
        return { inputMint: sell, outputMint: buy };
      }
    } catch(e) {}

    const KNOWN = {
      'SOL':  'So11111111111111111111111111111111111111112',
      'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      'JUP':  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      'WIF':  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
      'RAY':  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    };
    try {
      const pathMatch = window.location.pathname.match(/\/swap\/([A-Za-z0-9]+)-([A-Za-z0-9]+)/);
      if (pathMatch) {
        const inMint  = KNOWN[pathMatch[1].toUpperCase()] ?? (pathMatch[1].length >= 32 ? pathMatch[1] : null);
        const outMint = KNOWN[pathMatch[2].toUpperCase()] ?? (pathMatch[2].length >= 32 ? pathMatch[2] : null);
        if (inMint && outMint) return { inputMint: inMint, outputMint: outMint };
      }
    } catch(e) {}

    return { inputMint: null, outputMint: null };
  }

  // -- buildCapturedTrade ---------------------------------------------------
  function buildCapturedTrade(txInfo, risk, mints) {
    const DECIMALS = {
      'So11111111111111111111111111111111111111112': 9,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,
      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 6,
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 5,
      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 6,
      '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 6,
    };
    const SYMBOLS = {
      'So11111111111111111111111111111111111111112': 'SOL',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
      '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
    };

    const rawFromOrderParams = window.__zendiq_last_order_params?.amount ?? null;
    const rawFromDecode = txInfo?.swapInfo?.inAmount ?? txInfo?.decoded?.inAmountRaw ?? null;
    const amtRawStr = rawFromOrderParams ?? (rawFromDecode != null ? String(rawFromDecode) : null);
    const amtRaw    = amtRawStr != null ? Number(amtRawStr) : null;
    const slipPct   = txInfo?.swapInfo?.slippagePercent ?? txInfo?.decoded?.slippagePercent ?? null;

    const inMint  = mints?.inputMint  ?? window.__zendiq_last_order_params?.inputMint  ?? 'So11111111111111111111111111111111111111112';
    const outMint = mints?.outputMint ?? window.__zendiq_last_order_params?.outputMint ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const inDec   = DECIMALS[inMint]  ?? 9;
    const outDec  = DECIMALS[outMint] ?? 6;

    return {
      inputMint:          inMint,
      outputMint:         outMint,
      inputSymbol:        SYMBOLS[inMint]  ?? inMint.slice(0, 4)  + '?',
      outputSymbol:       SYMBOLS[outMint] ?? outMint.slice(0, 4) + '?',
      inputDecimals:      inDec,
      outputDecimals:     outDec,
      amountRaw:          amtRaw,
      amountRawStr:       amtRawStr,
      amountUI:           amtRaw != null ? amtRaw / Math.pow(10, inDec) : null,
      originalSlippageBps: slipPct ? Math.round(slipPct * 100) : 50,
      riskScore:          risk?.score         ?? 0,
      mevScore:           risk?.mev?.riskScore ?? 0,
      riskLevel:          risk?.level          ?? 'UNKNOWN',
      riskFactors:        risk?.factors ?? [],
      mevFactors:         risk?.mev?.factors ?? [],
      mevRiskLevel:       risk?.mev?.riskLevel ?? null,
      mevRiskScore:       risk?.mev?.riskScore ?? null,
      source:             txInfo?.swapInfo?.source ?? ns.activeSiteAdapter?.()?.name ?? 'unknown',
      capturedAt:         Date.now(),
      pageUrl:            window.location.href,
      status:             'pending',
    };
  }

  // -- _setSigningOriginalFromTrade -----------------------------------------
  // Sets widgetSwapStatus to 'signing-original' using whatever trade data is
  // currently available. Called on the negative-net confirm path so the Monitor
  // shows the amber "Jupiter's original swap" card instead of the 'skipped' flash.
  function _setSigningOriginalFromTrade(nsRef, opts) {
    const ct = nsRef.widgetCapturedTrade;
    const lq = nsRef.jupiterLiveQuote;
    if ((ct || lq) && !nsRef.widgetOriginalSigningInfo) {
      nsRef.widgetOriginalSigningInfo = {
        inputMint:      ct?.inputMint    ?? lq?.inputMint    ?? null,
        outputMint:     ct?.outputMint   ?? lq?.outputMint   ?? null,
        inputSymbol:    ct?.inputSymbol  ?? null,
        outputSymbol:   ct?.outputSymbol ?? null,
        inputDecimals:  ct?.inputDecimals  ?? null,
        outputDecimals: ct?.outputDecimals ?? null,
        inAmt:       ct?.amountUI ?? null,
        inAmountRaw: lq?.inAmount ?? null,
        riskScore: nsRef.lastRiskResult?.score ?? ct?.riskScore ?? null,
        riskLevel: nsRef.lastRiskResult?.level ?? null,
        reason:    opts?.reason ?? null,
      };
    }
    nsRef.widgetSwapStatus = 'signing-original';
    nsRef.widgetActiveTab  = 'monitor';
    const widget = document.getElementById('sr-widget');
    if (widget) {
      widget.style.display = '';
      if (!widget.classList.contains('expanded')) widget.classList.add('expanded');
    }
  }

  // -- Raydium Trade API helpers --------------------------------------------
  // Fetch a competitive quote from Raydium's on-chain AMM pools via the Trade API.
  // Returns the raw Raydium compute response data object, or null on any failure.
  // Routes through background bridge via pageJsonFetch to avoid jup.ag's CSP which
  // blocks direct fetch() from MAIN world scripts to third-party origins.
  async function fetchRaydiumQuote(inputMint, outputMint, amountStr, slippageBps) {
    try {
      const url = 'https://transaction-v1.raydium.io/compute/swap-base-in' +
        '?inputMint='  + inputMint +
        '&outputMint=' + outputMint +
        '&amount='     + amountStr +
        '&slippageBps='+ (slippageBps ?? 50) +
        '&txVersion=V0';
      // pageJsonFetch routes through bridge → background service worker (no CSP restrictions).
      // Has a 10s internal timeout; Raydium compute is typically < 1s.
      const res = await ns.pageJsonFetch(url);
      // Return the FULL response ? /transaction/swap-base-in needs it as `swapResponse`.
      // outputAmount lives at res.data.outputAmount; callers extract it from .data.
      if (!res?.success || !res.data?.outputAmount) {
        return null;
      }
      return res;
    } catch (e) {
      return null;
    }
  }

  // Shared address cache used by both _deriveATA and _fetchTokenAccount.
  // Keyed by "wallet:mint"; set to the real on-chain address once known.
  const _ataCache = {};

  // _fetchTokenAccount ? primary lookup via direct fetch() from MAIN world.
  // page-trade.js runs in jup.ag's MAIN world so CORS is unrestricted.
  // Tries jup.ag's own snifffed RPC first (it's whitelisted for this origin), then
  // a list of fallbacks. Falls back to _deriveATA only if all fail.
  // Always call with onChainOnly=false (default) — Raydium requires the output account
  // address even when the account doesn't exist yet, so it can include ATA creation in the TX.
  const _ataCacheOnChain = {}; // tracks which cached addresses are confirmed on-chain
  async function _fetchTokenAccount(walletPubkey, mint, onChainOnly = false) {
    const _key = walletPubkey + ':' + mint;
    if (_ataCache[_key] && (!onChainOnly || _ataCacheOnChain[_key])) return _ataCache[_key];
    // Strategy: derive ATA deterministically, then verify with getAccountInfo.
    // getTokenAccountsByOwner is disabled on most free public RPC nodes.
    // getAccountInfo is a simple single-key lookup — universally supported and goes through
    // the background service worker so CORS restrictions on the page origin don't apply.
    const _SPL     = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const _T22     = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const _ATAPROG = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

    // Find page's embedded web3.js PublicKey. On jup.ag it's a named global; on raydium.io
    // it's bundled privately and may not be accessible as a window property.
    let _PK = null;
    for (const k of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
      if (typeof window[k]?.PublicKey?.findProgramAddressSync === 'function') { _PK = window[k].PublicKey; break; }
    }
    if (!_PK) {
      for (const k of Object.keys(window)) {
        try { const o = window[k]; if (o?.PublicKey?.findProgramAddressSync) { _PK = o.PublicKey; break; } } catch(_){}
      }
    }

    // Build candidate addresses to check.
    // When web3.js is available: try both SPL and Token-2022 ATAs (handles both token programs).
    // When web3.js is not available (e.g. raydium.io): fall back to _deriveATA which has a
    // pure-JS WebCrypto derivation path — SPL only, but covers all common tokens including BONK.
    const _candidates = [];
    if (_PK) {
      for (const _tokenProg of [_SPL, _T22]) {
        try {
          const [_ata] = _PK.findProgramAddressSync(
            [new _PK(walletPubkey).toBuffer(), new _PK(_tokenProg).toBuffer(), new _PK(mint).toBuffer()],
            new _PK(_ATAPROG)
          );
          _candidates.push({ addr: _ata.toBase58(), label: _tokenProg === _T22 ? '(T22)' : '(SPL)' });
        } catch(_) {}
      }
    } else {
      // No web3.js available — derive SPL ATA via pure-JS fallback
      const _splAta = await _deriveATA(walletPubkey, mint).catch(() => null);
      if (_splAta) _candidates.push({ addr: _splAta, label: '(SPL-js)' });
    }

    // Verify each candidate on-chain via getAccountInfo (background worker — no CORS issues)
    for (const { addr: _candidate, label: _label } of _candidates) {
      try {
        const _info = await ns.rpcCall('getAccountInfo', [_candidate, { encoding: 'jsonParsed' }]);
        if (_info?.result?.value?.data?.parsed?.info?.mint === mint) {
          _ataCache[_key] = _candidate; _ataCacheOnChain[_key] = true;
          return _candidate;
        }
      } catch (_) {}
    }

    // On-chain verification failed for all candidates.
    // onChainOnly=true: caller explicitly asked for verification — skip Raydium cleanly.
    if (onChainOnly) return null;
    // Unverified fallback — used for output accounts where Raydium creates the ATA itself.
    const ata = await _deriveATA(walletPubkey, mint);
    if (ata) _ataCache[_key] = ata;
    return ata;
  }
  // _deriveATA ? fallback-only canonical ATA derivation.
  // Path 1: tries jup.ag's bundled web3.js PublicKey.findProgramAddressSync (no network, fast).
  // Path 2: pure-JS fallback using Web Crypto SHA-256 + BigInt ed25519 off-curve check.
  async function _deriveATA(walletPubkey, mint) {
    const _key = walletPubkey + ':' + mint;
    if (_ataCache[_key] !== undefined) return _ataCache[_key];
    try {
      // -- Path 1: web3.js PublicKey scan ------------------------------------
      let PK = null;
      for (const k of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
        if (typeof window[k]?.PublicKey?.findProgramAddressSync === 'function') { PK = window[k].PublicKey; break; }
      }
      if (!PK) {
        for (const k of Object.keys(window)) {
          try {
            const o = window[k];
            if (o && typeof o === 'object' && typeof o.PublicKey?.findProgramAddressSync === 'function') { PK = o.PublicKey; break; }
          } catch (_) {}
        }
      }
      if (PK) {
        const TOKEN_PROG = new PK('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        const ATA_PROG   = new PK('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const [ata] = PK.findProgramAddressSync(
          [new PK(walletPubkey).toBuffer(), TOKEN_PROG.toBuffer(), new PK(mint).toBuffer()],
          ATA_PROG
        );
        const addr = ata.toBase58();
        _ataCache[_key] = addr;
        return addr;
      }

      // -- Path 2: pure-JS ATA derivation via Web Crypto SHA-256 -------------
      // ATA = findProgramAddress([wallet, TOKEN_PROGRAM, mint], ATA_PROGRAM)
      // Solana PDA: SHA256(seeds... || [nonce] || program_id || "ProgramDerivedAddress")
      //   starting from nonce=255, pick first hash that is NOT a valid ed25519 point.
      const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      function _b58Dec(s) {
        let n = 0n;
        for (const c of s) { const i = _B58.indexOf(c); if (i < 0) throw new Error('bad b58'); n = n * 58n + BigInt(i); }
        const b = new Uint8Array(32);
        for (let i = 31; i >= 0; i--) { b[i] = Number(n & 255n); n >>= 8n; }
        return b;
      }
      // Ed25519 off-curve check: -x^2 + y^2 = 1 + d*x^2*y^2 (p = 2^255 - 19)
      // Legendre(u/v) = pow(u*v, (p-1)/2)  [since Legendre(1/b) = Legendre(b) for ?1 values]
      // Returns true when the 32-byte hash IS a valid compressed ed25519 point (on-curve).
      const _edP = (1n << 255n) - 19n;
      const _edD = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
      const _mp  = n => ((n % _edP) + _edP) % _edP;
      const _pow = (b, e) => { let r = 1n; b = _mp(b); while (e > 0n) { if (e & 1n) r = r * b % _edP; e >>= 1n; b = b * b % _edP; } return r; };
      function _isOnCurve(bytes) {
        let y = 0n;
        for (let i = 0; i < 32; i++) y |= BigInt(bytes[i]) << BigInt(8 * i);
        y &= (1n << 255n) - 1n;
        if (y >= _edP) return false;
        const y2  = y * y % _edP;
        const u   = _mp(y2 - 1n);                      // numerator of x^2
        const v   = _mp(1n + _edD * y2 % _edP);        // denominator of x^2
        const leg = _pow(u * v % _edP, (_edP - 1n) / 2n);
        return leg === 1n || leg === 0n;                // 1/0 = on curve; p-1 = off curve
      }
      const walletB  = _b58Dec(walletPubkey);
      const mintB    = _b58Dec(mint);
      const tokProgB = _b58Dec('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const ataProgB = _b58Dec('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      const pdaTag   = new TextEncoder().encode('ProgramDerivedAddress'); // 21 bytes
      for (let nonce = 255; nonce >= 0; nonce--) {
        const buf = new Uint8Array(32 + 32 + 32 + 1 + 32 + pdaTag.length); // 150 bytes
        let off = 0;
        for (const part of [walletB, tokProgB, mintB, Uint8Array.of(nonce), ataProgB, pdaTag]) {
          buf.set(part, off); off += part.length;
        }
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
        if (!_isOnCurve(hash)) {
          const addr = ns.b58Encode(hash);
          _ataCache[_key] = addr;
          return addr;
        }
      }
      _ataCache[_key] = null;
      return null;
    } catch (e) {
      return null; // don't cache errors ? allow retry
    }
  }

  // Request a serialised VersionedTransaction from Raydium for the given route data.
  // Returns an array of base64 tx strings (1 or 2), or null on any failure.
  // routeData     = full Raydium compute response {id, success, version, data:{inputMint,...}}
  // inputAccount  = wallet's token ATA for the input mint (null for SOL or if lookup failed).
  // outputAccount = ATA address for the output token (non-SOL); Raydium creates it if missing.
  async function fetchRaydiumTx(routeData, walletPubkey, priorityFeeLamports, inputAccount, outputAccount) {
    try {
      const SOL_MINT   = 'So11111111111111111111111111111111111111112';
      const innerData  = routeData?.data ?? {};
      const inputMint  = innerData.inputMint  ?? null;
      const outputMint = innerData.outputMint ?? null;
      const isInputSol  = inputMint  === SOL_MINT;
      const isOutputSol = outputMint === SOL_MINT;
      // Raydium expects micro-lamports per compute unit (~ 200k CU budget)
      const microLamports = priorityFeeLamports > 0
        ? String(Math.max(1, Math.round(priorityFeeLamports * 1_000_000 / 200_000)))
        : '0';
      const body = {
        computeUnitPriceMicroLamports: microLamports,
        swapResponse:  routeData,   // full {id, success, version, data} ? required by Raydium API
        txVersion:     'V0',
        wallet:        walletPubkey,
        wrapSol:       isInputSol,
        unwrapSol:     isOutputSol,
      };
      if (inputAccount)  body.inputAccount  = inputAccount;
      if (outputAccount) body.outputAccount = outputAccount;
      // pageJsonPost routes through bridge → background service worker (no CSP restrictions).
      const res = await ns.pageJsonPost(
        'https://transaction-v1.raydium.io/transaction/swap-base-in',
        body, 5000
      );
      if (!res?.success || !Array.isArray(res.data) || !res.data[0]?.transaction) {
        console.error('[ZendIQ] Raydium TX build failed:', res?.msg ?? res?.error ?? JSON.stringify(res)?.slice(0, 120));
        return null;
      }
      const _txArr = res.data.map(d => d.transaction);
      return _txArr;
    } catch (e) {
      return null;
    }
  }

  // -- handleOptimiseTrade --------------------------------------------------
  // probeOnly=true: build trade + run a silent background fetch but keep the pending
  // decision unresolved ? used for proactive pre-fetch when auto-optimise is OFF so the
  // savings card shows real data before the user clicks anything.
  async function handleOptimiseTrade(probeOnly = false) {
    try {
      const mints    = extractMintsFromContext(ns.pendingTransaction);
      const captured = buildCapturedTrade(ns.pendingTransaction, ns.lastRiskResult, mints);
      captured.walletPubkey = window.__zendiq_last_order_params?.taker ?? ns.resolveWalletPubkey();
      ns.widgetCapturedTrade = captured;
      // probeOnly: keep current quote/status visible ? user hasn't clicked yet
      if (!probeOnly) {
        ns.widgetSwapStatus = '';
        ns.widgetSwapError  = '';
        // If the proactive probe already fetched a quote, reuse it ? skip the network
        // round-trip and go straight to Review & Sign immediately. Only fall through to
        // a full fetch when the probe hasn't returned yet or was skipped entirely.
        if (ns.widgetLastOrder) {
          ns.widgetActiveTab = 'monitor';
          if (!ns._autoProtectPending) ns.handlePendingDecision('optimise');
          ns.renderWidgetPanel();
          return;
        }
        ns.widgetLastOrder = null;
      }
      ns.widgetActiveTab = 'monitor';
      // In autoProtect flow the decision is deferred to fetchWidgetQuote (savings check);
      // only resolve immediately when the user explicitly clicked Optimise.
      if (!ns._autoProtectPending && !probeOnly) {
        ns.handlePendingDecision('optimise');
      }
      // probeOnly: silent=true + noAutoAccept=true ? fetch in background, update savings
      // card, but never auto-sign (user still makes the final decision).
      fetchWidgetQuote(probeOnly, probeOnly);
    } catch (e) {
      console.error('[ZendIQ] handleOptimiseTrade error:', e);
    }
  }

  // -- fetchWidgetQuote -----------------------------------------------------
  // silent=true ? background refresh: keeps current quote visible while re-fetching,
  //               swaps in new tx silently, ignores transient errors.
  async function fetchWidgetQuote(silent = false, noAutoAccept = false) {
    if (!ns.widgetCapturedTrade) return;
    // pump.fun uses bonding-curve fills — no Jupiter order endpoint available
    if (window.location.hostname.includes('pump.fun')) return;

    if (!silent) {
      ns.widgetSwapStatus      = 'fetching';
      ns.widgetSwapError       = '';
      ns.widgetLastOrder       = null;
      ns.widgetLastTxSig       = null;
      ns.widgetLastTxPair      = null;
      ns.widgetLastTxFromSwapTab = null;
      ns._rdmLastComputeOut    = null;  // cleared each new fetch so stale Raydium baseline never bleeds
      ns._rdmSignParams        = null;  // cleared so stale _computeOutAmount from previous trade never contaminates baseline
      ns.widgetPausedForToken  = false;
      ns.renderWidgetPanel();
    }

    try {
      const walletPubkey = ns.widgetCapturedTrade.walletPubkey || ns.resolveWalletPubkey();
      if (!walletPubkey) throw new Error('Wallet not connected ? connect your wallet on jup.ag first');

      const { inputMint, outputMint, amountRaw, amountRawStr } = ns.widgetCapturedTrade;
      if (!inputMint || !outputMint) throw new Error('Token information unavailable');
      if (!amountRaw && !amountRawStr) throw new Error('Trade amount unavailable ? try swapping again');

      const amountStr  = amountRawStr ?? String(amountRaw);
      const jitoMode    = ns.jitoMode ?? 'auto';

      // Compute fees dynamically: scale with risk, MEV score, price impact, trade size.
      // widgetCapturedTrade.mevScore is snapshotted at intercept time ? may be 0 if async
      // MEV scoring hadn't completed yet. Use lastRiskResult as a live fallback so Jito is
      // correctly requested on pairs with real MEV exposure (e.g. BONK/WIF at MEDIUM+ risk).
      const effectiveMevScore = Math.max(
        ns.widgetCapturedTrade?.mevScore            ?? 0,
        ns.lastRiskResult?.mev?.riskScore           ?? 0
      );
      // Also propagate live score back into captured trade so subsequent logic uses it
      if (effectiveMevScore > (ns.widgetCapturedTrade?.mevScore ?? 0)) {
        ns.widgetCapturedTrade.mevScore = effectiveMevScore;
        ns.widgetCapturedTrade.mevEstimatedLossPercent =
          ns.lastRiskResult?.mev?.estimatedLossPercentage ?? ns.widgetCapturedTrade.mevEstimatedLossPercent;
      }
      const STABLES_FEE  = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
      const inDec0       = ns.widgetCapturedTrade.inputDecimals ?? 6;
      const tradeUsd     = STABLES_FEE.has(inputMint)
        ? Number(amountStr) / Math.pow(10, inDec0)
        : (ns.widgetLastPriceData?.amountInUsd ?? null);
      const { priorityFeeLamports, jitoTipLamports } = ns.calcDynamicFees({
        riskScore:      ns.widgetCapturedTrade?.riskScore      ?? 0,
        mevScore:       effectiveMevScore,
        priceImpactPct: ns.jupiterLiveQuote?.priceImpactPct   ?? null,
        tradeUsd,
        jitoMode,
        solPriceUsd:    ns.widgetLastPriceData?.solPriceUsd   ?? null,
      });

      // Fire Raydium compute quote in parallel with Jupiter's /order request ? no extra
      // latency since both run simultaneously.
      // Run Raydium when: (a) non-silent fetch, OR (b) first-time probe (widgetLastOrder is
      // null) ? the probe result is what ends up in Review & Sign so it must include the
      // Raydium comparison. Background 10s refresh ticks (silent=true with existing order)
      // skip Raydium to avoid unnecessary network load.
      // Run Raydium when:
      //   (a) non-silent fetch ? always compare on full fetches
      //   (b) first-time probe (no existing order yet)
      //   (c) existing order is already Raydium ? keep it fresh on 10s refresh / pre-sign re-fetch
      // Skip on swap-tab quotes and Jupiter-only background ticks.
      const _rdmShouldRun = (!ns.widgetCapturedTrade?.fromSwapTab) &&
        (!silent || !ns.widgetLastOrder || ns.widgetLastOrder?._source === 'raydium') &&
        !ns._rdmSkipOnce;   // set true after a sim failure so fallback gets Jupiter's route
      ns._rdmSkipOnce = false;  // consume the flag each fetch
      // Also fire RPC token-account lookups in parallel ? avoids the need for on-page
      const _SOL_MINT = 'So11111111111111111111111111111111111111112';
      // All three run in parallel: Raydium compute (HTTP) + ATA derivations (crypto, ~1ms each)
      const _rdmFiredAt = Date.now();
      // When SOL is the input, Raydium wraps exactly `amount` lamports. The wallet must also
      // have native SOL for fees AFTER wrapping AND must keep its account above the Solana
      // minimum rent-exempt balance (~890,880 lamports).
      //
      // Bundling path (jitoTip >= 1000): the swap tx carries NO priority fee — bundle
      // ordering is set by the tip tx amount. Reserve = tip lamports + 906_880 (rent floor).
      // Non-bundling path: reserve for worst-case CU price. Raydium routing can use up to
      // 1.4M CU (7× our 200k assumption), so actual fee can be 7× priorityFeeLamports.
      const _rdmBundling = (ns.jitoMode ?? 'auto') !== 'never';
      const _rdmFeeReserve = (inputMint === _SOL_MINT)
        ? Math.max(1_000_000, (
            _rdmBundling
              ? (jitoTipLamports ?? 0) + 906_880        // bundle: tip tx debit + rent-exempt floor
              : (priorityFeeLamports ?? 0) * 7 + 906_880 // non-bundle: CU price worst case
          ))
        : 0;
      const _rdmAmountStr = _rdmFeeReserve > 0
        ? String(Math.max(1, Number(amountStr) - _rdmFeeReserve))
        : amountStr;
      const _rdmComputePromise = _rdmShouldRun
        ? fetchRaydiumQuote(inputMint, outputMint, _rdmAmountStr, ns.widgetCapturedTrade.originalSlippageBps ?? 50)
        : Promise.resolve(null);
      // Output account: onChainOnly=false (derived ATA is fine; Raydium includes ATA-create CPI).
      // Input account: NOT pre-fetched. Raydium's TX builder derives the standard SPL ATA from
      // wallet + mint when inputAccount is omitted — avoids REQ_OWNER_ACCOUNT_ERROR from wrong ATAs.
      const _rdmOutAccP = (_rdmShouldRun && outputMint !== _SOL_MINT && walletPubkey) ? _fetchTokenAccount(walletPubkey, outputMint, false) : Promise.resolve(null);

      const url = 'https://lite-api.jup.ag/ultra/v1/order' +
        '?inputMint='  + inputMint +
        '&outputMint=' + outputMint +
        '&amount='     + amountStr +
        '&swapMode=ExactIn' +
        '&taker='      + walletPubkey +
        (priorityFeeLamports ? '&priorityFeeLamports=' + priorityFeeLamports : '') +
        (jitoTipLamports     ? '&jitoTipLamports='     + jitoTipLamports     : '');

      window.__zendiq_own_tx = true;
      let res;
      try {
        const _sleep = ms => new Promise(r => setTimeout(r, ms));
        for (let _attempt = 0; _attempt < 3; _attempt++) {
          if (_attempt > 0) await _sleep(1500 * _attempt);
          res = await fetch(url);
          if (res.status !== 429 && res.status !== 503) break;
        }
      } finally {
        window.__zendiq_own_tx = false;
      }
      if (!res.ok) {
        const errText = (res.status === 429 || res.status === 503)
          ? 'Jupiter is rate limiting ? please wait a moment and try again'
          : 'HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 100);
        throw new Error(errText);
      }
      const order_raw = await res.json();
      if (order_raw.error) throw new Error(String(order_raw.error));
      if (!order_raw.transaction) throw new Error('No transaction in order response');
      if (!order_raw.requestId)   throw new Error('No requestId in order response');
      let order = order_raw;

      // -- Raydium vs Jupiter comparison ------------------------------------
      // _rdmComputePromise was fired before Jupiter's /order so it ran in parallel.
      // Replace the order only when Raydium gives strictly more output tokens AND
      // a valid serialised transaction can be built. Falls back to Jupiter silently.
      // Raydium orders use RPC broadcast (no /execute) ? signWidgetSwap checks requestId.
      if (_rdmShouldRun) {
        try {
          // _rdmCompute is the full Raydium compute response {id, success, version, data}
          // .data has outputAmount, routePlan, etc.
          //
          // Deadline: wait up to 1500ms total from when Raydium fetch was fired.
          // AMM routes get the full window; RFQ/gasless get a shorter 1000ms cap since
          // they return quickly and Raydium's AMM compute is usually done by then too.
          // (RFQ fills can be beaten by Raydium AMM ? giving 0ms wait was wrong.)
          const _jupIsAMM      = !['rfq', 'gasless'].includes(order_raw.swapType);
          // Always give Raydium at least 600ms after Jupiter returns, even if Jupiter was slow.
          // Without this floor, a slow Jupiter response (>1500ms) would leave _rdmExtraMs=0,
          // abandoning Raydium even when it was about to respond.
          const _rdmExtraMs    = Math.max(600, (_jupIsAMM ? 2000 : 1500) - (Date.now() - _rdmFiredAt));
          const _rdmDeadline   = new Promise(r => setTimeout(r, _rdmExtraMs, null));
          const [_rdmCompute, _rdmOutAcc] = await Promise.all([
            Promise.race([_rdmComputePromise, _rdmDeadline]),
            _rdmOutAccP,
          ]);
          const _rdmData  = _rdmCompute?.data ?? null;
          const _jupOut   = Number(order_raw.outAmount ?? 0);
          const _rdmOut   = _rdmData?.outputAmount ? Number(_rdmData.outputAmount) : 0;

          // Fee-adjusted comparison: deduct EACH side's Jito tip from its own output so we
          // compare true net received amounts. Priority fees are identical on both sides
          // and cancel out. Tips are paid in SOL so we convert via outTokenPriceUsd.
          //   rdmNetOut = rdmOut - rdmTipCostTokens
          //   jupNetOut = jupOut - jupTipCostTokens
          //   winner = rdmNetOut > jupNetOut
          //         = (rdmOut - jupOut) > (rdmTipCostTokens - jupTipCostTokens)
          // Both sides pay the current calculated Jito tip — use jitoTipLamports directly.
          // Do NOT use widgetLastOrderFees.jitoTipLamports: that reflects the PREVIOUS order
          // (often 0 for RFQ fills) and would understate Raydium's bundle cost, biasing the
          // comparison in Raydium's favour.
          const _jupTip = jitoTipLamports ?? 0;
          const _rdmBundleTip = Math.max(_jupTip, 1_000);
          // Derive SOL price from the trade if possible, else fall back to the live price
          // stored by the risk module, then the consistent project-wide $80 floor.
          const _solPriceEst =
            (inputMint === _SOL_MINT && order_raw.inUsdValue && Number(amountStr) > 0)
              ? order_raw.inUsdValue / (Number(amountStr) / 1e9)
              : (outputMint === _SOL_MINT && order_raw.outUsdValue && _jupOut > 0)
                ? order_raw.outUsdValue / (_jupOut / 1e9)
                : (ns.widgetLastPriceData?.solPriceUsd ?? 80);
          // Convert lamports -> tokens for each side.
          const _outTokenPriceUsd = (order_raw.outUsdValue && _jupOut > 0) ? order_raw.outUsdValue / _jupOut : null;
          const _tipToTokens = (lamports) =>
            (_outTokenPriceUsd && _outTokenPriceUsd > 0)
              ? (lamports / 1e9) * _solPriceEst / _outTokenPriceUsd
              : 0;
          // Credit Raydium with the additional MEV protection value vs Jupiter's route.
          // Raydium Jito bundles protect ~95% of expected MEV loss.
          // Jupiter AMM + Jito protects ~70%; Jupiter AMM without Jito protects 0%.
          // Jupiter RFQ/gasless is off-chain (no mempool) — full MEV protection (1.0).
          // Net credit = delta × expected loss in output tokens.
          // Only applied when mevScore >= 25 (MEDIUM+) to avoid phantom credits on safe pairs.
          const _jupIsRFQ        = order_raw.swapType === 'rfq' || order_raw.swapType === 'gasless';
          const _mevEstLossPct   = ns.lastRiskResult?.mev?.estimatedLossPercentage ?? 0;
          const _jupMevMult      = _jupIsRFQ ? 1.0 : (_jupTip > 0 ? 0.70 : 0.0);
          const _mevCreditTokens = (effectiveMevScore >= 25 && _mevEstLossPct > 0 && _jupOut > 0)
            ? (0.95 - _jupMevMult) * (_mevEstLossPct / 100) * _jupOut
            : 0;
          const _rdmNetOut = _rdmOut - _tipToTokens(_rdmBundleTip) + _mevCreditTokens;
          const _jupNetOut = _jupOut - _tipToTokens(_jupTip);
          const _rdmOutAdj = _rdmNetOut; // alias used in the if-block below
          if (_rdmData && _rdmNetOut > _jupNetOut) {
            // Scale Jupiter's outUsdValue by the output token ratio to get a Raydium estimate
            const _rdmOutUsd = (order_raw.outUsdValue != null && _jupOut > 0)
              ? order_raw.outUsdValue * (_rdmOut / _jupOut) : null;
            // Build display order immediately from compute data ? Review & Sign renders from
            // this without waiting for the TX build (which takes another 1-3s via Raydium API).
            order = {
              transaction:          null,   // filled lazily by _rdmTxPromise below
              requestId:            null,   // Raydium: RPC sendTransaction, not Jupiter /execute
              _source:              'raydium',
              _rdmPoolType:         _rdmData.routePlan?.[0]?.poolType ?? null,
              outAmount:            String(_rdmData.outputAmount),
              otherAmountThreshold: String(_rdmData.otherAmountThreshold ?? 0),
              priceImpactPct:       _rdmData.priceImpactPct ?? null,
              routePlan:            _rdmData.routePlan ?? [],
              swapType:             'amm',
              inUsdValue:           order_raw.inUsdValue ?? null,
              outUsdValue:          _rdmOutUsd,
            };
            // Fetch input account now that we know Raydium wins — sequential lookup.
            // onChainOnly=true: never returns a _deriveATA-derived address.
            // _deriveATA uses the SPL Token program; Token-2022 ATAs have different addresses
            // and passing the wrong one causes REQ_OWNER_ACCOUNT_ERROR.
            // If the first on-chain call returns null (transient RPC issue), retry once.
            let _inAccForTx = null;
            if (inputMint !== _SOL_MINT && walletPubkey) {
              _inAccForTx = await _fetchTokenAccount(walletPubkey, inputMint, true).catch(() => null);
              if (!_inAccForTx) {
                await new Promise(r => setTimeout(r, 600));
                _inAccForTx = await _fetchTokenAccount(walletPubkey, inputMint, true).catch(() => null);
              }
            }
            // If we still can't confirm the input account on-chain, skip Raydium.
            // Passing null causes REQ_INPUT_ACCOUT_ERROR; passing a wrong derived address
            // (e.g. SPL ATA for a Token-2022 token) causes REQ_OWNER_ACCOUNT_ERROR.
            if (inputMint !== _SOL_MINT && !_inAccForTx) {
              // Revert to Jupiter order — input account could not be confirmed on-chain.
              order = order_raw;
              ns._rdmSignParams = null;
            } else {
            // Store the compute params needed to re-build a fresh TX at sign time.
            // Pool state changes every few seconds — a fresh TX build right before signing
            // ensures the otherAmountThreshold matches the current on-chain price.
            ns._rdmSignParams = {
              inputMint, outputMint, amountStr: _rdmAmountStr,
              slippageBps: ns.widgetCapturedTrade.originalSlippageBps ?? 50,
              walletPubkey, priorityFeeLamports: _rdmBundling ? 0 : (priorityFeeLamports ?? 0),
              inAcc: _inAccForTx, outAcc: _rdmOutAcc,
              // Store the compute outputAmount so fetchWidgetQuote can use it as the real
              // Raydium baseline (not the slippage floor minimumAmountOut from the tx).
              _computeOutAmount: _rdmData.outputAmount ? Number(_rdmData.outputAmount) : null,
            };
            // Also build TX eagerly in background.
            ns._rdmTxPromise = fetchRaydiumTx(
              _rdmCompute, walletPubkey, _rdmBundling ? 0 : (priorityFeeLamports ?? 0), _inAccForTx, _rdmOutAcc
            ).then(tx => {
              if (tx && ns.widgetLastOrder?._source === 'raydium') {
                ns.widgetLastOrder.transaction = tx;
              }
              return tx ?? null;
            }).catch(() => null);
            } // end else (inAccForTx found)
          }
// Always store the Raydium compute output so the baseline block below can use it
          // when Jupiter won (no _rdmSignParams set in that case). On raydium.io there is no
          // jupiterLiveQuote, so widgetBaselineRawOut would otherwise be null, leaving Est.
          // Net Benefit as '?' even though we know exactly what Raydium would have given.
          ns._rdmLastComputeOut = _rdmData?.outputAmount != null ? String(_rdmData.outputAmount) : null;
        } catch (_rdmErr) {
        }
      }

      ns.widgetLastOrder          = order;
      // Raydium bundles: swap tx has no priority fee; bundle ordering is set by tip tx only.
      // Zero priority fee in both cases so Review & Sign and Activity show correct costs.
      const _isNoFeeRoute     = order.swapType === 'rfq' || order.swapType === 'gasless';
      const _isRdmBundleOrder = order._source === 'raydium' && _rdmBundling;
      ns.widgetLastOrderFees       = {
        priorityFeeLamports: (_isNoFeeRoute || _isRdmBundleOrder) ? 0 : (priorityFeeLamports ?? 0),
        // Raydium bundles always use at least 1 000 lamports (same floor as signWidgetSwap).
        // Without this, low-risk trades (calcDynamicFees → 0 tip) show no bundle row in
        // Review & Sign even though a real bundle is submitted at sign time.
        jitoTipLamports: _isNoFeeRoute ? 0 : _isRdmBundleOrder ? Math.max(jitoTipLamports ?? 0, 1_000) : (jitoTipLamports ?? 0),
      };

      // -- Forced AMM re-fetch for MEV protection --------------------------
      // When Jupiter returns a gasless/RFQ fill but the pair has MEDIUM+ MEV risk (= 25),
      // attempt to fetch a Jito-protected AMM route for better mempool coverage.
      // Fired as a background promise ? does NOT block rendering 'ready' with the gasless
      // order. If the AMM route arrives before the user clicks Sign & Send, the panel
      // silently upgrades (same mechanism as the 10s auto-refresh). If the user signs the
      // gasless order first, the background fetch result is discarded.
      if (_isNoFeeRoute && effectiveMevScore >= 25 && jitoMode !== 'never') {
        const _solFJito    = ns.widgetLastPriceData?.solPriceUsd ?? 80;
        const _jitoForced  = tradeUsd != null
          ? Math.max(20_000, Math.min(200_000, Math.round(tradeUsd * 0.0008 / _solFJito * 1e9)))
          : 20_000;
        const _mevUrl = 'https://lite-api.jup.ag/ultra/v1/order' +
          '?inputMint='  + inputMint +
          '&outputMint=' + outputMint +
          '&amount='     + amountStr +
          '&swapMode=ExactIn' +
          '&taker='      + walletPubkey +
          '&jitoTipLamports=' + _jitoForced;
        window.__zendiq_own_tx = true;
        fetch(_mevUrl)
          .then(async r => {
            if (!r.ok) return;
            const _mevOrder = await r.json();
            // Only replace when: valid AMM route, still in 'ready', not already signing.
            if (!_mevOrder.error && _mevOrder.transaction && _mevOrder.requestId &&
                _mevOrder.swapType !== 'rfq' && _mevOrder.swapType !== 'gasless' &&
                ns.widgetSwapStatus === 'ready' && !ns._busySign) {
              ns.widgetLastOrder     = _mevOrder;
              ns.widgetLastOrderFees = { priorityFeeLamports: 0, jitoTipLamports: _jitoForced };
              // Re-derive SOL-price-dependent fee costs so the Jito tip shows correctly in UI
              const _sprice = ns.widgetLastPriceData?.solPriceUsd ?? 80;
              ns.widgetLastPriceData = {
                ...ns.widgetLastPriceData,
                jitoTipUsd: (_jitoForced / 1e9) * _sprice,
              };
              ns.renderWidgetPanel();
            }
          })
          .catch(() => {})
          .finally(() => { window.__zendiq_own_tx = false; });
      }
      // Capture Jupiter's own live quote as baseline for savings comparison.
      // Guard: only use if the live quote is for the same pair, amount, AND route type.
      // Comparing a gasless/RFQ baseline against an AMM quote (or vice versa) is
      // apples-to-oranges ? market-maker fills carry different pricing than on-chain
      // AMM routes, so the comparison always produces a misleading negative net.
      // When types mismatch, null the baseline ? _net = null ? ZendIQ signs optimistically.
      {
        const lq = ns.jupiterLiveQuote;
        const mintMatch = lq &&
          lq.inputMint  === inputMint &&
          lq.outputMint === outputMint;
        const amtMatch  = lq && lq.inAmount != null &&
          Math.abs(Number(lq.inAmount) - Number(amountStr)) < 2; // allow ?1 lamport rounding
        // Always set the baseline when mint + amount match, regardless of route type.
        // Jupiter may return AMM, RFQ, or Gasless for the same pair; ZendIQ may find a
        // different fill mechanism. The token-amount comparison is meaningful in all cases,
        // and the stale-baseline sanity guard (50% diff) already blocks phantom numbers.
        // The _routeMismatch label in Review & Sign surfaces the fill-type difference visually.
        //
        // Guard: skip during a pre-sign re-fetch (silent + status='signing').
        // The re-fetch only refreshes the tx bytes (which expire in ~30s) ? it is NOT a
        // re-evaluation of the trade. Jupiter live ticks can land during those ~300ms and
        // would advance the baseline to a new market tick, making Activity compare the signed
        // order against a post-click price rather than the decision-time price.
        const _isPreSignRefetch = silent && ns.widgetSwapStatus === 'signing';
        if (!_isPreSignRefetch) {
          // On raydium.io the live quote comes from our own Raydium compute call, not Jupiter.
          // widgetCapturedTrade.source is set by onWalletArgs; when present, use the Raydium
          // compute output already stored in _rdmSignParams as the real baseline so we compare
          // ZendIQ's Jupiter order against what Raydium would have given — not Raydium's
          // slippage floor (minimumAmountOut) which understates the actual output by ~0.5%.
          const _isRdmSite = ns.widgetCapturedTrade?.source === 'raydium';
          if (_isRdmSite && ns._rdmSignParams?._computeOutAmount) {
            // Raydium wins: ZendIQ serves the Raydium order.
            // Baseline = Jupiter's competing quote so Est. Net Benefit shows the real routing
            // gain: "Raydium gave X more tokens than Jupiter would have."
            // order_raw.outAmount is Jupiter's output; order.outAmount is Raydium's output.
            ns.widgetBaselineRawOut = order_raw.outAmount;
          } else if (_isRdmSite && ns._rdmLastComputeOut) {
            // Jupiter wins on raydium.io: ZendIQ serves Jupiter Ultra instead of Raydium.
            // Baseline = Raydium compute output (what user would have gotten without ZendIQ).
            // Savings = Jupiter Ultra outAmount − Raydium outAmount.
            // jupiterLiveQuote is null on raydium.io so the normal lq.outAmount path gives null.
            ns.widgetBaselineRawOut = ns._rdmLastComputeOut;
          } else if (_isRdmSite) {
            // On raydium.io but Raydium compute timed out — no comparison available yet.
            // Use ZendIQ's own order as neutral placeholder so the display shows
            // '≈ same as original' rather than '—'. The 3s quick re-probe below will
            // overwrite this once Raydium compute responds on the retry.
            ns.widgetBaselineRawOut = order.outAmount;
          } else {
            ns.widgetBaselineRawOut = (mintMatch && amtMatch) ? lq.outAmount : null;
          }
        }
      }

      // Derive USD prices directly from the order response ? no external price API needed.
      // Jupiter's /order always returns inUsdValue and outUsdValue on successful quotes.
      try {
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        const inDec  = ns.widgetCapturedTrade?.inputDecimals  ?? 9;
        const outDec = ns.widgetCapturedTrade?.outputDecimals ?? 6;
        const inAmt  = Number(amountStr);
        const outAmt = Number(order.outAmount ?? 0);
        // Per-token price = total USD value / human-readable amount
        const iprice = (order.inUsdValue  != null && inAmt  > 0) ? order.inUsdValue  / (inAmt  / Math.pow(10, inDec))  : null;
        const oprice = (order.outUsdValue != null && outAmt > 0) ? order.outUsdValue / (outAmt / Math.pow(10, outDec)) : null;
        // SOL price: derive from whichever side of the pair is SOL; keep previous value otherwise
        const prev   = ns.widgetLastPriceData?.solPriceUsd ?? null;
        const sprice = inputMint  === SOL_MINT ? iprice
                     : outputMint === SOL_MINT ? oprice
                     : prev;
        const pri  = ns.widgetLastOrderFees?.priorityFeeLamports ?? 0;
        const jito = ns.widgetLastOrderFees?.jitoTipLamports ?? 0;
        ns.widgetLastPriceData = {
          inputPriceUsd:  iprice,
          outputPriceUsd: oprice,
          solPriceUsd:    sprice,
          amountInUsd:    order.inUsdValue ?? null,
          priorityFeeUsd: (pri  > 0 && sprice) ? (pri  / 1e9) * sprice : null,
          jitoTipUsd:     (jito > 0 && sprice) ? (jito / 1e9) * sprice : null,
        };
      } catch (_) { ns.widgetLastPriceData = {}; }

      // -- Profitability cap: when gross routing savings are positive but less than the fees
      // we requested, re-fetch with fees scaled so net benefit >= 20% of savings.
      // Only runs on non-silent first fetch to avoid infinite loops.
      // Skipped for RFQ/gasless (fees already zeroed), jitoMode=always, or when we can't
      // compute savings (no baseline or no output price).
      // Profitability-cap re-fetch: skipped for Raydium orders — the cap always re-fetches
      // via the Jupiter URL and would override a legitimately-winning Raydium order.
      // Raydium route selection already accounts for tip costs symmetrically in the comparison.
      if (!silent && !_isNoFeeRoute && jitoMode !== 'always' && order._source !== 'raydium') {
        const _capOutDec  = ns.widgetCapturedTrade?.outputDecimals ?? 6;
        const _capBase    = ns.widgetBaselineRawOut != null ? Number(ns.widgetBaselineRawOut) : null;
        const _capRawOut  = Number(order.outAmount ?? 0);
        const _capOpr     = ns.widgetLastPriceData?.outputPriceUsd ?? null;
        const _capSolP    = ns.widgetLastPriceData?.solPriceUsd ?? null;
        const _capPriL    = ns.widgetLastOrderFees.priorityFeeLamports ?? 0;
        const _capJitoL   = ns.widgetLastOrderFees.jitoTipLamports ?? 0;
        const _capTotalL  = _capPriL + _capJitoL;
        if (_capBase != null && _capOpr != null && _capSolP != null && _capTotalL > 0) {
          const _capGross  = (_capRawOut - _capBase) / Math.pow(10, _capOutDec);
          const _capAct    = _capRawOut / Math.pow(10, _capOutDec);
          if (_capGross > 0 && Math.abs(_capGross) <= _capAct * 0.5) {
            const _capSavUsd = _capGross * _capOpr;
            const _capFeeUsd = (_capTotalL / 1e9) * _capSolP;
            if (_capSavUsd > 0 && _capFeeUsd > _capSavUsd) {
              // Scale fees down so they consume at most 80% of savings ? 20% net profit
              const _targetL  = Math.floor((_capSavUsd * 0.80 / _capSolP) * 1e9);
              const _newPriL  = _capTotalL > 0 ? Math.max(0, Math.floor(_targetL * (_capPriL  / _capTotalL))) : 0;
              const _newJitoL = Math.max(0, _targetL - _newPriL);
              try {
                const _capUrl = 'https://lite-api.jup.ag/ultra/v1/order' +
                  '?inputMint='  + inputMint +
                  '&outputMint=' + outputMint +
                  '&amount='     + amountStr +
                  '&swapMode=ExactIn' +
                  '&taker='      + walletPubkey +
                  (_newPriL  > 0 ? '&priorityFeeLamports=' + _newPriL  : '') +
                  (_newJitoL > 0 ? '&jitoTipLamports='     + _newJitoL : '');
                window.__zendiq_own_tx = true;
                const _capRes = await fetch(_capUrl).finally(() => { window.__zendiq_own_tx = false; });
                if (_capRes.ok) {
                  const _capOrder = await _capRes.json();
                  if (!_capOrder.error && _capOrder.transaction && _capOrder.requestId) {
                    order = _capOrder;
                    ns.widgetLastOrder     = _capOrder;
                    const _capIsNoFee = _capOrder.swapType === 'rfq' || _capOrder.swapType === 'gasless';
                    ns.widgetLastOrderFees = { priorityFeeLamports: _capIsNoFee ? 0 : _newPriL, jitoTipLamports: _capIsNoFee ? 0 : _newJitoL };
                    // Recompute price data with new order's USD values and scaled fees
                    try {
                      const _inDec2  = ns.widgetCapturedTrade?.inputDecimals  ?? 9;
                      const _outDec2 = ns.widgetCapturedTrade?.outputDecimals ?? 6;
                      const _inAmt2  = Number(amountStr);
                      const _outAmt2 = Number(_capOrder.outAmount ?? 0);
                      const _ip2 = (_capOrder.inUsdValue  != null && _inAmt2  > 0) ? _capOrder.inUsdValue  / (_inAmt2  / Math.pow(10, _inDec2))  : ns.widgetLastPriceData.inputPriceUsd;
                      const _op2 = (_capOrder.outUsdValue != null && _outAmt2 > 0) ? _capOrder.outUsdValue / (_outAmt2 / Math.pow(10, _outDec2)) : ns.widgetLastPriceData.outputPriceUsd;
                      const SOL_M2 = 'So11111111111111111111111111111111111111112';
                      const _sp2 = inputMint === SOL_M2 ? _ip2 : outputMint === SOL_M2 ? _op2 : _capSolP;
                      ns.widgetLastPriceData = {
                        ...ns.widgetLastPriceData,
                        inputPriceUsd:  _ip2,
                        outputPriceUsd: _op2,
                        solPriceUsd:    _sp2,
                        amountInUsd:    _capOrder.inUsdValue ?? ns.widgetLastPriceData.amountInUsd,
                        priorityFeeUsd: (_newPriL  > 0 && _sp2) ? (_newPriL  / 1e9) * _sp2 : null,
                        jitoTipUsd:     (_newJitoL > 0 && _sp2) ? (_newJitoL / 1e9) * _sp2 : null,
                      };
                    } catch (_) {}
                  }
                }
              } catch (_) { /* keep original order if re-fetch fails */ }
            }
          }
        }
      }

      ns.widgetLastQuoteFetchedAt  = Date.now();

      // When autoAccept is on and the autoProtect path is active, defer the 'ready' render.
      // The decision block below will either open the widget already at 'signing' (normal auto-sign),
      // set 'signing-original' (negative net), or set 'ready' explicitly (token risk pause).
      // This prevents the one-frame Review & Sign flash before signing begins.
      // Also defer when on raydium.io with a Raydium-source order and autoProtect is active —
      // the Raydium no-benefit gate below may release the original tx without showing Review & Sign.
      const _isRdmSiteOrderDefer = (ns.widgetCapturedTrade?.source === 'raydium') && ns._autoProtectPending;
      const _deferReady = !silent && !noAutoAccept &&
        !ns.widgetCapturedTrade?.fromSwapTab &&
        ((ns.autoAccept === true && ns._autoProtectPending === true) || _isRdmSiteOrderDefer);
      if (!_deferReady) {
        // Skip render only when this is a pre-sign silent re-fetch (B57):
        //   signWidgetSwap pre-sets 'signing' so the handlePendingDecision render shows
        //   the signing card without a Review & Sign flash, and snap values aren't reset.
        // The 'fetching' case (probeOnly path) must NOT skip — that's the initial background
        // probe for Always Ask Me, and the render here is what transitions the widget away
        // from the "Analysing swap…" spinner to show the savings card + Monitor content.
        // Note: the auto-accept deferred path (B54/B56) never reaches this branch because
        //   _deferReady=true guards it; removing 'fetching' here has no effect on that path.
        // Skip render if a silent fetch completed while the user has already progressed
        // past 'ready' — e.g. 10s timer fires, user clicks "Continue with original route"
        // mid-fetch → status becomes 'signing-original'; we must NOT overwrite that state
        // with a new Review & Sign panel. Also covers 'signing', 'sending', 'done(-original)'.
        const _BUSY_STATES = ['signing', 'signing-original', 'sending', 'done', 'done-original'];
        const _skipRender = silent && _BUSY_STATES.includes(ns.widgetSwapStatus);
        ns.widgetSwapStatus = _skipRender ? ns.widgetSwapStatus : 'ready';
        if (!_skipRender) ns.renderWidgetPanel();
      }

      // Quick re-probe: when route types mismatched (e.g. Jupiter=gasless, ZendIQ=AMM or vice
      // versa), widgetBaselineRawOut is null so Review & Sign shows '?' for Est. Net Benefit.
      // Schedule a 3s silent re-fetch to try again ? Jupiter's live tick often catches up to
      // the same route type within a couple of seconds, enabling the real comparison.
      // Also re-probe when ZendIQ's first quote was provably worse than Jupiter's baseline
      // (negative savingsUsd) ? a subsequent call may return a different, better route.
      if (!silent && !noAutoAccept) {
        if (ns._quickProbeTimer) { clearTimeout(ns._quickProbeTimer); ns._quickProbeTimer = null; }
        // Re-probe when: (a) baseline is null (route-type mismatch on jup.ag), or
        // (b) on raydium.io and Raydium compute timed out (_rdmLastComputeOut still null) —
        //     the neutral order.outAmount placeholder was used; retry to get a real comparison.
        const _needProbe = ns.widgetBaselineRawOut === null ||
          (ns.widgetCapturedTrade?.source === 'raydium' && !ns._rdmLastComputeOut);
        if (_needProbe) {
          ns._quickProbeTimer = setTimeout(() => {
            ns._quickProbeTimer = null;
            if (ns.widgetSwapStatus === 'ready') ns.fetchWidgetQuote(true);
          }, 3_000);
        }
      }

      // -- Auto-accept / autoProtect decision ------------------------------
      // Compute net benefit once ? used by auto-accept gate and autoProtect fallback.
      if (!silent && !noAutoAccept && !ns.widgetCapturedTrade?.fromSwapTab) {
        // When auto-accept is active and we have no Jupiter baseline yet, wait briefly
        // for a live tick to arrive (~1s interval). This prevents signing an
        // optimistically-null net that would have been negative if we'd had the data.
        // The wait exits early as soon as the baseline is set, or after 1.5s max.
        if (ns.autoAccept && ns._autoProtectPending && ns.widgetBaselineRawOut == null) {
          await new Promise(resolve => {
            let elapsed = 0;
            const t = setInterval(() => {
              elapsed += 100;
              if (ns.widgetBaselineRawOut != null || elapsed >= 1500 || !ns._autoProtectPending) {
                clearInterval(t);
                resolve();
              }
            }, 100);
          });
        }

        const _base   = ns.widgetBaselineRawOut != null ? Number(ns.widgetBaselineRawOut) : null;
        const _rawOut = order.outAmount != null ? Number(order.outAmount) : null;
        const _outDec = ns.widgetCapturedTrade?.outputDecimals ?? 6;
        const _pd     = ns.widgetLastPriceData ?? {};
        const SOL_M   = 'So11111111111111111111111111111111111111112';
        const _opr    = _pd.outputPriceUsd ?? (ns.widgetCapturedTrade?.outputMint === SOL_M ? _pd.solPriceUsd : null);
        // Compute fee costs in USD ? use stored USD values when available (derived from
        // SOL price ? lamports). For non-SOL pairs where solPriceUsd couldn't be derived,
        // fall back to lamport arithmetic using a conservative $80 SOL floor so fees
        // are never silently ignored in the net benefit gate.
        const _solFallback = _pd.solPriceUsd ?? 80;
        const _priUsd  = _pd.priorityFeeUsd  != null ? _pd.priorityFeeUsd
          : ((ns.widgetLastOrderFees?.priorityFeeLamports ?? 0) / 1e9) * _solFallback;
        const _jitoUsd = _pd.jitoTipUsd      != null ? _pd.jitoTipUsd
          : ((ns.widgetLastOrderFees?.jitoTipLamports     ?? 0) / 1e9) * _solFallback;
        let _net   = null;
        let _gross = null; // raw token routing diff (positive = ZendIQ gives more tokens)
        if (_base != null && _rawOut != null) {
          _gross = (_rawOut - _base) / Math.pow(10, _outDec);
          const _act   = _rawOut / Math.pow(10, _outDec);
          if (Math.abs(_gross) <= _act * 0.5) { // stale-baseline sanity guard
            _net = _opr != null
              ? _gross * _opr - _priUsd - _jitoUsd
              : _gross - _priUsd - _jitoUsd; // no output price ? token gain minus fees in USD
          }
        }

        // MEV protection value: Jito achieves ~70% reduction of expected bot-attack exposure.
        // Fees are already deducted in _net (paid once for the tx covering both benefits).
        // Only suppress MEV when ZendIQ's route yields fewer tokens (_gross < 0).
        // Do NOT suppress when routing is merely break-even (_gross = 0) and fees push
        // _net negative ? that is the normal case for liquid pairs (BONK/WIF) where ZendIQ
        // and Jupiter hit the same AMM route. Jito protection is still valuable there.
        const _mevELP  = ns.widgetCapturedTrade?.mevEstimatedLossPercent;
        const _mevAmt  = ns.widgetLastPriceData?.amountInUsd;
        const _mevUsd  = (_mevELP != null && _mevAmt != null && (ns.widgetCapturedTrade?.mevScore ?? 0) >= 25)
          ? Number(_mevAmt) * (_mevELP / 100) : null;
        // Raydium + Jito bundle bypasses the public mempool entirely ? ~95% MEV coverage.
        // Jupiter's Jito-tipped route still touches P2P nodes briefly ? ~70%.
        const _isRdmBundle = order._source === 'raydium' && (ns.widgetLastOrderFees?.jitoTipLamports ?? 0) >= 1000;
        const _mevMult = _isRdmBundle ? 0.95 : 0.70;
        const _mevProtection = (_gross != null && _gross < 0)
          ? null  // ZendIQ route is token-worse ? don't let MEV value justify signing it
          : ((_mevUsd != null && (_priUsd + _jitoUsd) > 0) ? _mevUsd * _mevMult : null);
        // Combined: routing gain/loss + MEV protection value - fees (once).
        // When no routing baseline: MEV protection - fees.
        const _combinedNet = _net != null
          ? _net + (_mevProtection ?? 0)
          : (_mevProtection != null ? _mevProtection - _priUsd - _jitoUsd : null);

        // Pause auto-accept when the output token has HIGH/CRITICAL risk score (loaded).
        // Prevents silently signing into a rug/honeypot without the user reviewing the panel.
        const _tokenLevel    = ns.tokenScoreResult?.level;
        const _pauseForToken = (ns.pauseOnHighRisk !== false) &&
          ns.tokenScoreResult?.loaded === true &&
          (_tokenLevel === 'HIGH' || _tokenLevel === 'CRITICAL');
        // Track whether we're showing Review & Sign specifically because token risk blocked auto-accept.
        // Widget uses this to show an explanatory banner so the user understands why auto-sign paused.
        ns.widgetPausedForToken = (ns.autoAccept === true && _pauseForToken === true);
        // ── Raydium site: release original tx when ZendIQ adds no net benefit ──────
        // When the user is on raydium.io, they're already using Raydium. If ZendIQ's
        // route (whether Raydium or Jupiter) produces no meaningful net gain after fees,
        // releasing the original Raydium tx is the right UX — the user gets the same
        // outcome without an extra confirmation step.
        // Only applies when:
        //   (a) we're on the raydium.io site (source === 'raydium')
        //   (b) ZendIQ picked Raydium (order._source === 'raydium') — same route as original
        //   (c) _combinedNet is known and ≤ 0 (no net benefit after fees)
        // When Jupiter wins on raydium.io (order._source !== 'raydium'), ZendIQ is offering a
        // genuinely different route → always show Review & Sign.
        const _isRdmSiteOrder = ns.widgetCapturedTrade?.source === 'raydium' && order._source === 'raydium';
        if (_isRdmSiteOrder && _combinedNet != null && _combinedNet <= 0 && ns._autoProtectPending) {
          ns._autoProtectPending = false;
          _setSigningOriginalFromTrade(ns, { reason: 'no_net_benefit' });
          if (ns.pendingDecisionResolve) {
            ns._confirmRiskSnapshot = ns.lastRiskResult ?? null;
            ns.pendingDecisionResolve('confirm');
            ns.pendingDecisionResolve = null;
            ns.pendingDecisionPromise = null;
            ns.pendingTransaction     = null;
          }
          ns.renderWidgetPanel();
          return;
        }

        if (ns.autoAccept && !_pauseForToken) {
          if (_combinedNet == null || _combinedNet > 0) {
            // Savings confirmed, or unknown (no baseline/price yet) ? sign optimistically.
            // Only skip when net is definitively negative (ZendIQ is provably worse).
            if (ns._autoProtectPending && ns.pendingDecisionResolve) {
              ns._autoProtectPending    = false;
              // Set cooldown BEFORE resolving ? Jupiter retries signTransaction the
              // instant it receives the 'optimise' throw, before signWidgetSwap starts.
              ns._signCooldownUntil = Date.now() + 6000;
              ns.pendingDecisionResolve('optimise');
              ns.pendingDecisionResolve = null;
              ns.pendingDecisionPromise = null;
              ns.pendingTransaction     = null;
            }
            // Freeze the snapshot values now ? Review & Sign never renders on this path,
            // but the 'signing' Monitor card reads them for Est. Net Benefit display.
            const _gross = (_base != null && _rawOut != null)
              ? (_rawOut - _base) / Math.pow(10, _outDec) : null;
            const _grossSanity = _gross != null && _rawOut != null
              ? Math.abs(_gross) <= (_rawOut / Math.pow(10, _outDec)) * 0.5 : false;
            const _savUsd = _grossSanity && _opr != null ? _gross * _opr : null;
            ns.widgetSnapBaselineRawOut = ns.widgetBaselineRawOut;
            ns.widgetSnapSavingsUsd     = _savUsd;
            ns.widgetSnapNetUsd         = _combinedNet ?? _net;
            // Open widget so user can see signing progress
            const widget = document.getElementById('sr-widget');
            if (widget) {
              widget.style.display = '';
              if (!widget.classList.contains('expanded')) widget.classList.add('expanded');
              widget.classList.remove('compact');
              ns.widgetActiveTab = 'monitor';
              if (ns._fitBodyHeight) ns._fitBodyHeight(widget);
            }
            signWidgetSwap();
            return;
          }
          // Net is definitively negative: ZendIQ route is worse ? release Jupiter's tx.
          // Show signing-original (not 'skipped') ? the wallet IS about to open.
          if (ns._autoProtectPending) {
            ns._autoProtectPending = false;
            _setSigningOriginalFromTrade(ns, { reason: 'no_net_benefit' });
            if (ns.pendingDecisionResolve) {
              // Snapshot risk so _captureConfirmTrade can include it in the Activity entry
              ns._confirmRiskSnapshot = ns.lastRiskResult ?? null;
              ns.pendingDecisionResolve('confirm');
              ns.pendingDecisionResolve = null;
              ns.pendingDecisionPromise = null;
              ns.pendingTransaction     = null;
            }
            ns.renderWidgetPanel();
            return;
          }
        } else if (ns._autoProtectPending) {
          // autoAccept off: gate on combined net (routing + MEV protection) before blocking Jupiter.
          // Skip ZendIQ only when combined benefit is definitively negative ? not just routing.
          // Only open Review & Sign when benefit is positive or unknown (no price data yet).
          ns._autoProtectPending = false;
          if (_combinedNet != null && _combinedNet < 0) {
            _setSigningOriginalFromTrade(ns, { reason: 'no_net_benefit' });
            if (ns.pendingDecisionResolve) {
              // Snapshot risk so _captureConfirmTrade can include it in the Activity entry
              ns._confirmRiskSnapshot = ns.lastRiskResult ?? null;
              ns.pendingDecisionResolve('confirm');
              ns.pendingDecisionResolve = null;
              ns.pendingDecisionPromise = null;
              ns.pendingTransaction     = null;
            }
            ns.renderWidgetPanel();
            return;
          }
          // Positive or unknown benefit ? show Review & Sign panel so user can review
          // before signing. The pending promise stays open; signWidgetSwap() resolves it
          // as 'optimise' (blocking Jupiter's tx) when the user clicks Sign & Send.
          const widget = document.getElementById('sr-widget');
          if (widget) {
            widget.style.display = '';
            if (!widget.classList.contains('expanded')) widget.classList.add('expanded');
            widget.classList.remove('compact');
            ns.widgetActiveTab = 'monitor';
            if (ns._fitBodyHeight) ns._fitBodyHeight(widget);
          }
          // Freeze snapshot so Review & Sign shows the correct Est. Net Benefit.
          ns.widgetSwapStatus         = 'ready';
          ns.widgetSnapBaselineRawOut = ns.widgetBaselineRawOut;
          ns.widgetSnapSavingsUsd     = null; // re-derived in renderWidgetPanel
          ns.widgetSnapNetUsd         = _combinedNet ?? _net;
          ns.renderWidgetPanel();
        }
      } else if (ns._autoProtectPending) {
        // Fallback (silent / noAutoAccept / fromSwapTab): show panel, let user decide.
        ns._autoProtectPending = false;
        ns.handlePendingDecision('optimise');
      }

    } catch (e) {
      if (ns._autoProtectPending) {
        // Quote failed ? let Jupiter's original tx through as a safe fallback.
        ns._autoProtectPending = false;
        if (ns.pendingDecisionResolve) {
          ns._confirmRiskSnapshot = ns.lastRiskResult ?? null;
          ns.pendingDecisionResolve('confirm');
          ns.pendingDecisionResolve = null;
          ns.pendingDecisionPromise = null;
          ns.pendingTransaction     = null;
        }
      }
      if (silent) {
        // Silent refresh: keep existing quote, just warn ? quote may be slightly stale
        console.warn('[ZendIQ] Background quote refresh failed (keeping current):', e.message);
        // Restore 'ready' silently so signWidgetSwap can proceed with the existing order.
        // Covers both pre-sign re-fetch contexts:
        //   'fetching' ? auto-accept path (B54/B56)
        //   'signing'  ? normal sign path (B57)
        if (ns.widgetLastOrder && (ns.widgetSwapStatus === 'fetching' || ns.widgetSwapStatus === 'signing')) {
          ns.widgetSwapStatus = 'ready';
        } else if (!ns.widgetLastOrder && ns.widgetSwapStatus === 'fetching') {
          // Probe failed with no previous quote — unblock the widget so the user can
          // still 'Proceed anyway' or dismiss. Renders the Monitor tab with any risk
          // analysis already computed. (Common on non-jup.ag sites when amount capture fails.)
          ns.widgetSwapStatus = '';
          ns.widgetSwapError  = '';
          try { ns.renderWidgetPanel?.(); } catch (_) {}
        }
        return;
      }
      // Map known Jupiter API / wallet user-conditions to friendly messages.
      const _msg = (e.message || '').toLowerCase();
      let _friendlyMsg;
      if (_msg.includes('insufficient funds') || _msg.includes('insufficient balance')) {
        _friendlyMsg = 'Not enough balance for this swap ? top up your wallet and try again';
      } else if (_msg.includes('slippage') || _msg.includes('price impact')) {
        _friendlyMsg = 'Price moved too much ? try increasing slippage tolerance';
      } else if (_msg.includes('rate limit') || _msg.includes('429')) {
        _friendlyMsg = 'Rate limited ? please wait a moment and retry';
      } else {
        console.error('[ZendIQ] fetchWidgetQuote error:', e);
        _friendlyMsg = e.message || 'Quote fetch failed';
      }
      ns.widgetSwapError  = _friendlyMsg;
      ns.widgetSwapStatus = 'error';
      ns.renderWidgetPanel();
    }
  }

  // -- signWidgetSwap -------------------------------------------------------
  async function signWidgetSwap(retryCount = 0) {
    if (!ns.widgetCapturedTrade) return;

    // Capture what the user actually saw on Review & Sign BEFORE re-fetching a fresh quote.
    // The re-fetch triggers a re-render which overwrites widgetSnap* ? we need to preserve
    // the original values so Activity shows exactly the figure the user agreed to sign.
    const _preSignSnapNet      = ns.widgetSnapNetUsd           ?? null;
    const _preSignSnapSavings  = ns.widgetSnapSavingsUsd       ?? null;
    const _preSignSnapMevProt  = ns.widgetSnapMevProtectionUsd ?? null;
    const _preSignSnapBaseline = ns.widgetSnapBaselineRawOut   ?? null;

    // -- Step 1: Advance to 'signing' BEFORE handlePendingDecision ------------------------
    // This fixes two bugs when profile is Always Ask Me (no auto-accept):
    //
    //   (a) NET FLASH: handlePendingDecision calls renderWidgetPanel(). If status is still
    //       'ready' that re-renders the Review & Sign panel, recalculating netUsd from the
    //       live Jupiter tick baseline which may have shifted negative since the user clicked.
    //       The user sees a negative-net flash AND the signing card inherits the wrong value.
    //
    //   (b) TIMER CORRUPTION: the 10s quote-refresh timer stays active while status='ready'.
    //       Setting 'signing' synchronously here causes renderWidgetPanel() inside
    //       handlePendingDecision to clear the interval (timerActive = 'signing'==='ready' = false)
    //       BEFORE any await. Without this, the timer can fire during wallet approval, updating
    //       ns.widgetLastOrder with a new order ? making quoteAccuracy compare a different
    //       outAmount than the transaction the user actually approved in their wallet.
    ns.widgetSwapStatus = 'signing';
    ns.widgetSwapError  = '';

    // Resolve Jupiter's pending signTransaction as 'optimise' (throws into Jupiter's hook).
    // handlePendingDecision sets cooldown, clears pending* state, and calls renderWidgetPanel()
    // which now renders the signing card (not Review & Sign). Safe no-op when no pending decision.
    if (ns.pendingDecisionResolve) {
      ns.handlePendingDecision('optimise');
    }

    // -- Step 2: Freeze snap values permanently ---------------------------------------------
    // Always overwrite with exactly what the user saw when they clicked Sign & Send.
    // The previous '== null' guard missed cases where a render (live tick or handlePendingDecision)
    // had already overwritten the snap with a recalculated live value.
    // null here means 'no data was available' ? correct for history and signing card display.
    ns.widgetSnapNetUsd            = _preSignSnapNet;
    ns.widgetSnapSavingsUsd        = _preSignSnapSavings;
    ns.widgetSnapMevProtectionUsd  = _preSignSnapMevProt;
    ns.widgetSnapBaselineRawOut    = _preSignSnapBaseline;

    // -- Step 3: Pre-sign refresh ------------------------------------------------------------
    // Raydium: await the background TX build started during the probe ? typically already done
    // by the time the user clicks Sign & Send (~2s to build, user reads Review & Sign for 2-5s).
    // Skip a full re-fetch; Raydium txs share Solana blockhash expiry (~60s) and the probe
    // was at most a few seconds ago. Fall back to full re-fetch only when the build failed.
    // Jupiter: re-fetch a fresh /order as before (txs expire in ~30s).
    if (ns.widgetLastOrder?._source === 'raydium') {
      // Always re-build TX fresh at sign time ? Raydium AMM pool state changes every few
      // seconds. The background TX built during the probe may have a stale otherAmountThreshold
      // that fails on-chain. A fresh compute + TX build takes ~1-2s and happens while the
      // signing card renders, before the wallet popup appears.
      const _sp = ns._rdmSignParams;
      if (_sp) {
        try {
          // Use a wide slippage tolerance for the TX-build quote.
          // otherAmountThreshold is a minimum output floor ? Raydium fills at the actual
          // market price, never at the threshold. Using 500 bps (5%) means the TX survives
          // normal pool movement during wallet popup latency (5?30 s) without causing a worse
          // fill. The display/comparison quote still uses the user's real slippage setting.
          const _txSlippage = 500;
          const _freshCompute = await fetchRaydiumQuote(_sp.inputMint, _sp.outputMint, _sp.amountStr, _txSlippage);
          if (_freshCompute?.data?.outputAmount) {
            // Output account: look up at sign time (ATA may have been created since quote).
            // Input account: onChainOnly=true to avoid stale _deriveATA cache entries.
            const _freshInAcc  = _sp.inputMint  !== 'So11111111111111111111111111111111111111112'
              ? await _fetchTokenAccount(_sp.walletPubkey, _sp.inputMint,  true).catch(() => _sp.inAcc ?? null)
              : null;
            const _freshOutAcc = _sp.outputMint !== 'So11111111111111111111111111111111111111112'
              ? await _fetchTokenAccount(_sp.walletPubkey, _sp.outputMint, false).catch(() => _sp.outAcc)
              : null;
            const _freshTx = await fetchRaydiumTx(_freshCompute, _sp.walletPubkey, _sp.priorityFeeLamports, _freshInAcc, _freshOutAcc);
            if (_freshTx && ns.widgetLastOrder?._source === 'raydium') {
              ns.widgetLastOrder.transaction = _freshTx;
              ns.widgetLastOrder.outAmount   = String(_freshCompute.data.outputAmount);
            } else {
            }
          }
        } catch (_) { /* fall through to cached tx */ }
      }
      // Await background build in case fresh re-fetch above failed
      if (ns._rdmTxPromise) { await ns._rdmTxPromise; ns._rdmTxPromise = null; }
      if (!ns.widgetLastOrder?.transaction) {
        // TX build failed — fall back to a full widget re-fetch.
        // If Raydium wins again it will start a new _rdmTxPromise; await it too.
        // If the TX build still fails, force a Jupiter-only re-fetch so we never
        // reach the signing path with an empty txList.
        await fetchWidgetQuote(true, true);
        if (ns.widgetLastOrder?._source === 'raydium' && ns._rdmTxPromise) {
          await ns._rdmTxPromise;
          ns._rdmTxPromise = null;
        }
        // B102: fetchWidgetQuote preserves 'signing' status; restore 'ready' for the
        // pre-sign re-fetch path so the guards below work as intended.
        if (ns.widgetSwapStatus === 'signing') ns.widgetSwapStatus = 'ready';
        if (ns.widgetSwapStatus !== 'ready') return;
        // Raydium TX build failed twice — skip it on next fetch and use Jupiter
        if (ns.widgetLastOrder?._source === 'raydium' && !ns.widgetLastOrder?.transaction) {
          ns._rdmSkipOnce = true;
          await fetchWidgetQuote(true, true);
          if (ns.widgetSwapStatus === 'signing') ns.widgetSwapStatus = 'ready';
          if (ns.widgetSwapStatus !== 'ready') return;
        }
      } else {
        ns.widgetSwapStatus = 'ready';
      }
    } else {
      await fetchWidgetQuote(true, true);
      // B102: fetchWidgetQuote preserves 'signing' status; restore 'ready' for the
      // pre-sign re-fetch path so the guard below works as intended.
      if (ns.widgetSwapStatus === 'signing') ns.widgetSwapStatus = 'ready';
      if (ns.widgetSwapStatus !== 'ready') return;
    }

    // -- Step 4: Re-enter 'signing' and render ----------------------------------------------
    ns.widgetSwapStatus = 'signing';
    ns.renderWidgetPanel();

    // -- Step 5: Capture signed order as local constants ------------------------------------
    // Capture outAmount AND the baseline at the same instant ? both from the fresh pre-sign
    // re-fetch (Step 3). This ensures Activity's Net Benefit compares the two numbers from
    // the same market moment, regardless of any 10s timer or live-tick updates that may have
    // advanced widgetSnapBaselineRawOut between the initial Review & Sign render and clicking.
    // transaction is now an array for Raydium (may be 2 txs: ATA-create + swap).
    const txList            = Array.isArray(ns.widgetLastOrder.transaction)
      ? ns.widgetLastOrder.transaction
      : (ns.widgetLastOrder.transaction ? [ns.widgetLastOrder.transaction] : []);
    const txBase64          = txList[0] ?? null;  // primary tx used for single-tx Jupiter path
    const requestId         = ns.widgetLastOrder.requestId;
    const _signedOutAmount  = ns.widgetLastOrder.outAmount;  // local ? for quoteAccuracy below
    const _signedBaseline   = ns.widgetBaselineRawOut ?? null; // baseline contemporaneous with signed order
    let _hadRdmSimFail = false;  // true when Raydium pre-sim failed; visible to outer catch
    window.__zendiq_own_tx = true;
    try {
      const swapBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));

      // Find VersionedTransaction from jup.ag bundled web3.js
      // Also capture _web3Pkg (the full package) so we can construct a Jito tip tx
      // using Transaction, PublicKey, and SystemProgram from the same web3.js build.
      let VersionedTransaction = null;
      let _web3Pkg = null;
      for (const key of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
        if (window[key]?.VersionedTransaction) {
          VersionedTransaction = window[key].VersionedTransaction;
          _web3Pkg = window[key];
          break;
        }
      }
      if (!VersionedTransaction) {
        for (const key of Object.keys(window)) {
          try {
            const obj = window[key];
            if (obj && typeof obj === 'object' && typeof obj.VersionedTransaction?.deserialize === 'function') {
              VersionedTransaction = obj.VersionedTransaction;
              _web3Pkg = obj;
              break;
            }
          } catch (_) {}
        }
      }

      const legacyWallet = window.phantom?.solana || window.solflare || window.backpack?.solana
                        || window.braveSolana || window.jupiterWallet || window.jupiter?.solana || window.solana;

      let signedB64      = null;
      let skippedExecute = false;

      ns.resolveWalletPubkey();

      const toB64 = (tx) => {
        const raw = tx?.serialize ? tx.serialize() : (tx instanceof Uint8Array ? tx : null);
        if (!raw) return null;
        let bin = ''; for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
        return btoa(bin);
      };

      // Path 1: Wallet Standard signTransaction ? preferred, gets signed bytes back.
      // Raydium txs are handled entirely by the multi-tx RPC block below (handles 1 or 2 txs,
      // signs each, confirms in order). Skip WS/legacy paths for Raydium to avoid
      // signAndSendTransaction bypassing the new multi-tx confirm logic.
      const _isRaydiumTx = ns.widgetLastOrder?._source === 'raydium';
      let _path1Err = null;
      if (!_isRaydiumTx && !signedB64 && ns._wsWallet) {
        const wsAccount = ns._wsAccount || ns._wsWallet.accounts?.[0] || null;
        const wsSignFeature = ns._wsWallet.features?.['solana:signTransaction'];
        if (wsSignFeature?.signTransaction && wsAccount) {
          try {
            const [res] = await wsSignFeature.signTransaction({ account: wsAccount, transaction: swapBytes, chain: 'solana:mainnet' });
            const rawSwap = res?.signedTransaction;
            if (rawSwap) {
              let bin = ''; for (let i = 0; i < rawSwap.length; i++) bin += String.fromCharCode(rawSwap[i]);
              signedB64 = btoa(bin);
            }
          } catch (wsErr) {
            const m = wsErr?.message ?? '';
            if (/reject|cancel|denied|abort/i.test(m)) throw new Error('cancelled');
            // For Raydium simulation failures: try WS signAndSendTransaction as a fallback.
            // Some wallets (Jupiter Wallet) implement this without running preflight simulation,
            // letting the tx land on-chain where it succeeds. Skip for non-Raydium failures.
            if (_isRaydiumTx) {
              const wsSnSFallback = ns._wsWallet.features?.['solana:signAndSendTransaction'];
              if (wsSnSFallback?.signAndSendTransaction && wsAccount) {
                try {
                  const _snsFbRes = await wsSnSFallback.signAndSendTransaction({ account: wsAccount, transaction: swapBytes, chain: 'solana:mainnet' });
                  skippedExecute = true;
                  if (_snsFbRes?.signature) ns.widgetLastTxSig = ns.b58Encode(_snsFbRes.signature);
                } catch (snsFallbackErr) {
                  const m2 = snsFallbackErr?.message ?? '';
                  if (/reject|cancel|denied|abort/i.test(m2)) throw new Error('cancelled');
                  _path1Err = snsFallbackErr;
                }
              } else {
                _path1Err = wsErr;
              }
            } else {
              // Non-Raydium: log and fall through to Path 2
              console.error('[ZendIQ] WS signTransaction failed, trying legacy path:', wsErr);
              _path1Err = wsErr;
            }
          }
        } else if (wsAccount && !signedB64) {
          // signTransaction feature absent ? try signAndSendTransaction (wallet handles broadcast)
          const wsSnS = ns._wsWallet.features?.['solana:signAndSendTransaction'];
          if (wsSnS?.signAndSendTransaction) {
            try {
              const _wsSnsRes = await wsSnS.signAndSendTransaction({ account: wsAccount, transaction: swapBytes, chain: 'solana:mainnet' });
              skippedExecute = true;
              if (_wsSnsRes?.signature) ns.widgetLastTxSig = ns.b58Encode(_wsSnsRes.signature);
            } catch (wsErr) {
              const m = wsErr?.message ?? '';
              if (/reject|cancel|denied|abort/i.test(m)) throw new Error('cancelled');
              console.error('[ZendIQ] WS signAndSendTransaction failed, trying legacy path:', wsErr);
              _path1Err = wsErr;
            }
          }
        }
      }

      // Path 2: legacy wallet (window.phantom.solana etc.) ? Jupiter only.
      // Raydium uses the multi-tx RPC block below instead.
      if (!_isRaydiumTx && !signedB64 && !skippedExecute && legacyWallet) {
        try {
          const txToSign = VersionedTransaction ? VersionedTransaction.deserialize(swapBytes) : swapBytes;
          if (!signedB64 && !skippedExecute && legacyWallet.signTransaction) {
            const signed = await legacyWallet.signTransaction(txToSign);
            if (signed?.serialize) signedB64 = toB64(signed);
            else if (signed instanceof Uint8Array) signedB64 = toB64(signed);
          }
          if (!signedB64 && !skippedExecute && legacyWallet?.signAndSendTransaction) {
            await legacyWallet.signAndSendTransaction(txToSign, { isVersioned: true });
            skippedExecute = true;
          }
        } catch (legErr) {
          const m = legErr?.message ?? '';
          if (/reject|cancel|denied|abort/i.test(m)) throw new Error('cancelled');
          // Both paths failed ? throw the more informative error
          throw _path1Err ?? legErr;
        }
      }

      // If both paths were skipped (no wallet found at all), apply the Path 1 error if we had one
      if (!signedB64 && !skippedExecute && _path1Err) throw _path1Err;

      if (skippedExecute) {
        const _cap = ns.widgetCapturedTrade;
        const _lo  = ns.widgetLastOrder || {};
        const _dec = _cap?.outputDecimals ?? 6;
        // ns.widgetLastTxSig may already contain a sig captured from signAndSendTransaction above.
        ns.widgetLastTxPair = {
          inSym:  _cap?.inputSymbol  ?? '?',
          outSym: _cap?.outputSymbol ?? '?',
          inAmt:  _cap?.amountUI ?? null,
          outAmt: _lo.outAmount ? (Number(_lo.outAmount) / Math.pow(10, _dec)) : null,
        };
        ns.widgetLastTxFromSwapTab = _cap?.fromSwapTab ?? false;
        ns.widgetSwapStatus    = 'done';
        // Analytics: swap completed (skippedExecute — wallet signed+sent directly)
        try { if (ns.logProEvent) {
          const _feesSkip = ns.widgetLastOrderFees ?? {};
          const _lpSkip   = ns.widgetLastPriceData ?? {};
          const _solSkip  = _lpSkip.solPriceUsd ?? 80;
          const _sshSkip  = window.location.hostname;
          ns.logProEvent('swap_optimised', {
            site:             _cap?.source === 'raydium' ? 'raydium.io' : _sshSkip.includes('pump') ? 'pump.fun' : 'jup.ag',
            net_benefit_usd:  ns.widgetSnapNetUsd ?? null,
            routing_gain_usd: ns.widgetSnapSavingsUsd ?? null,
            mev_value_usd:    ns.widgetSnapMevProtectionUsd != null ? Math.min(ns.widgetSnapMevProtectionUsd, 5000) : null,
            fees_usd:         ((_feesSkip.priorityFeeLamports ?? 0) + (_feesSkip.jitoTipLamports ?? 0)) / 1e9 * _solSkip || null,
            trade_usd:        _lpSkip.inUsdValue != null ? Math.min(Number(_lpSkip.inUsdValue), 50000) : null,
            route_type:       _lo.swapType === 'rfq' ? 'rfq' : _lo.swapType === 'gasless' ? 'gasless' : _cap?.source === 'raydium' ? 'raydium' : _lo.swapType ? 'amm' : 'unknown',
            jito_used:        (_cap?.source === 'raydium' && (_feesSkip.jitoTipLamports ?? 0) >= 1000),
            profile:          ns.settingsProfile ?? 'unknown',
            auto_sign:        !!ns.autoAccept,
          });
          // Structured trade record (routes to trades DB table)
          try { if (ns.logTrade) {
            const _rSkip  = ns.lastRiskResult;
            const _lv2s   = (lv) => lv === 'LOW' ? 'safe' : lv === 'MEDIUM' ? 'caution' : lv ? 'danger' : null;
            const _rt     = _lo.swapType === 'rfq' ? 'rfq' : _lo.swapType === 'gasless' ? 'gasless' : _cap?.source === 'raydium' ? 'raydium' : 'amm';
            ns.logTrade({
              user_action:      'optimised',
              dex:              _cap?.source === 'raydium' ? 'raydium.io' : _sshSkip.includes('pump') ? 'pump.fun' : 'jup.ag',
              exec_path:        _rt === 'amm' ? ((_feesSkip.jitoTipLamports ?? 0) >= 1000 ? 'jito' : 'direct') : _rt,
              tx_sig:           ns.widgetLastTxSig ?? null,
              input_mint:       _cap?.inputMint  ?? null,
              output_mint:      _cap?.outputMint ?? null,
              success:          1,
              trade_usd:        _lpSkip.inUsdValue != null ? Math.min(Number(_lpSkip.inUsdValue), 50000) : null,
              net_benefit_usd:  ns.widgetSnapNetUsd ?? null,
              routing_gain_usd: ns.widgetSnapSavingsUsd ?? null,
              mev_value_usd:    ns.widgetSnapMevProtectionUsd != null ? Math.min(ns.widgetSnapMevProtectionUsd, 5000) : null,
              fees_usd:         ((_feesSkip.priorityFeeLamports ?? 0) + (_feesSkip.jitoTipLamports ?? 0)) / 1e9 * _solSkip || null,
              jito_tip_lamports: _feesSkip.jitoTipLamports ?? null,
              route_chosen:     _rt,
              bot_risk_score:   _rSkip?.score  ?? null,
              token_risk_score: ns.tokenScoreResult?.score ?? null,
              tx_classification: _lv2s(_rSkip?.level),
              profile:          ns.settingsProfile ?? 'unknown',
              auto_sign:        !!ns.autoAccept,
            });
          } } catch (_) {}
        } } catch (_) {}
        ns._signCooldownUntil  = Date.now() + 4000;
        if (ns.widgetCapturedTrade?.source === 'raydium') ns._rdmPostSwapIdle = true;
        ns.widgetLastOrder     = null;
        ns.widgetCapturedTrade = null;
        ns.renderWidgetPanel();
        return;
      }

      if (!signedB64 && !skippedExecute && !_isRaydiumTx) throw new Error('Could not sign transaction ? make sure your wallet is connected and unlocked');

      ns.widgetSwapStatus = 'sending';
      ns.renderWidgetPanel();

      let data;
      if (requestId) {
        // -- Jupiter /execute path ------------------------------------------
        const execRes = await fetch('https://lite-api.jup.ag/ultra/v1/execute', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ signedTransaction: signedB64, requestId }),
        });
        if (!execRes.ok) {
          const text = await execRes.text().catch(() => '');
          throw new Error('HTTP ' + execRes.status + (text ? ': ' + text.slice(0, 100) : ''));
        }
        data = await execRes.json();
        if (data.status === 'Failed') {
          const code   = data.code;
          const errStr = String(data.error ?? '').toLowerCase();
          // -2005 = blockhash expired / requestId TTL elapsed (user took >~60s in wallet popup,
          // or Jupiter's server-side requestId timed out). Recover silently: re-fetch a fresh
          // quote so the user just has to click "Sign & Send" again — no re-entering anything.
          const isStale = code === -2005 || errStr.includes('blockhash') || errStr.includes('expired');
          // Positive on-chain program error codes (>= 100) indicate the tx landed but the
          // on-chain program rejected it — almost always because the price moved past the swap's
          // output threshold between quote and execution. Treat the same as an expired quote:
          // silently re-fetch so the user gets a fresh rate and just re-clicks Sign & Send.
          const isOnChainSlippage = typeof code === 'number' && code >= 100;
          if (isStale || isOnChainSlippage) {
            ns.widgetSwapStatus = 'fetching';
            ns.widgetSwapError  = '';
            ns.renderWidgetPanel();
            await fetchWidgetQuote(false, true);
            if (ns.widgetSwapStatus === 'ready') {
              ns.widgetSwapError  = isOnChainSlippage
                ? 'Price moved — fresh quote loaded, click Sign & Send again'
                : 'Quote expired — click Sign & Send again';
              ns.widgetSwapStatus = 'ready';
              ns.renderWidgetPanel();
            }
            return;
          }
          // Unknown on-chain failure — surface a clean, readable message (strip raw tx sig / code).
          const userMsg = data.error
            ? data.error.replace(/\([A-Za-z0-9]{40,}\)/g, '').replace(/\s{2,}/g, ' ').trim()
            : 'unknown error';
          throw new Error('Swap failed on-chain: ' + userMsg);
        }
      } else {
        // -- Raydium broadcast path ----------------------------------------
        // requestId is null for Raydium orders ? broadcast via the wallet's
        // own RPC endpoint (signAndSendTransaction lets the wallet handle
        // broadcast with its own premium node + skip-preflight logic).
        // txList may contain 2 txs when the wallet has no output ATA yet:
        //   tx[0] = create ATA, tx[1] = the actual swap.
        // Each tx is signed+broadcast in order; intermediate txs are polled
        // for confirmation before the next is signed.
        const _sleep = ms => new Promise(r => setTimeout(r, ms));
        const _rdmTxsToSign = txList.length > 0 ? txList : (txBase64 ? [txBase64] : []);
        if (!_rdmTxsToSign.length) throw new Error('No Raydium transaction to sign');

        // Extract a base58 sig from WS signAndSendTransaction responses.
        // Jupiter Wallet (and some others) return an ARRAY like [{signature:{0:14,1:137,...}}]
        // where the signature value is a JSON-serialised object with numeric keys rather than
        // a real Uint8Array. Handle all four cases: array wrapper, object-with-numeric-keys,
        // plain Uint8Array, and plain string.
        function _extractRdmSig(res) {
          const item = Array.isArray(res) ? res[0] : res;
          const raw  = item?.signature ?? item?.signedTransaction ?? null;
          if (!raw) return null;
          if (typeof raw === 'string') return raw;
          if (raw instanceof Uint8Array) return ns.b58Encode(raw);
          // JSON-serialised Uint8Array: {"0":14,"1":137,...}
          if (typeof raw === 'object') {
            const bytes = new Uint8Array(Object.keys(raw).length);
            for (const k of Object.keys(raw)) bytes[+k] = raw[k];
            return ns.b58Encode(bytes);
          }
          return null;
        }

        let rpcSig = null;
        let _jitoBundleOk = false;
        let _rdmSimFailed = false;  // set when wallet rejects due to simulation/insufficient SOL (local to loop)
        let _bundleSignedSwapBytes = null; // set when bundle path signs the swap tx ? reused by fallback to avoid a second wallet popup
        // Simulation failure patterns: covers Phantom "Transaction simulation failed",
        // "insufficient lamports", "custom program error", and generic RPC sim errors.
        const _isSimErr = e => /simulat|insufficient.{0,20}lamport|custom.{0,20}program.{0,10}error|program.{0,10}error/i.test(e?.message ?? '');

        // -- Jito Bundle path --------------------------------------------------------------
        // When jitoTipLamports >= 1000, bundle all Raydium txs together with a SOL tip tx
        // and submit atomically to the Jito Block Engine for MEV protection and validator
        // priority. The tip tx is LAST in the bundle per Jito's requirement.
        // On any error falls through transparently to the standard per-tx sign+send path.
        //
        // Raydium routes always need a Jito tip ? there is no /execute endpoint for them,
        // and without a tip the bundle is deprioritised and frequently "Invalid".
        // If calcDynamicFees returned no tip (low risk score), use 1_000 lamports as the
        // minimum so the bundle path is always taken for Raydium, regardless of risk profile.
        const _isRdmBundle = ns.widgetLastOrder?._source === 'raydium' && (ns.jitoMode ?? 'auto') !== 'never';
        const _jitoBundleTip = _isRdmBundle
          ? Math.max(ns.widgetLastOrderFees?.jitoTipLamports ?? 0, 1_000)
          : (ns.widgetLastOrderFees?.jitoTipLamports ?? 0);
        // widgetLastOrderFees.jitoTipLamports is updated ONLY on confirmed bundle success below
        // (so Activity never shows a tip cost for bundles that fell back to standard RPC).
        // Wallet pubkey: try multiple sources — ns.walletPubkey may not be set yet at this
        // point in the flow; _rdmSignParams is always populated for Raydium orders.
        const _bundleWallet = ns.walletPubkey
          || ns._rdmSignParams?.walletPubkey
          || ns._wsAccount?.address
          || legacyWallet?.publicKey?.toBase58?.()
          || null;
        if (
          _jitoBundleTip >= 1000
          && (ns.jitoMode ?? 'auto') !== 'never'
          && !_hadRdmSimFail                                // don't bundle on sim-failure recovery
          && _rdmTxsToSign.length <= 5                      // Jito max: 5 txs per bundle (tip injected, not a separate tx)
          && _bundleWallet                                  // need wallet pubkey for tip
        ) {
          try {
            // Jito tip accounts — pick one at random to reduce contention (per Jito docs).
            const _JITO_TIPS = [
              '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
              'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
              'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
              'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
              'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
              'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
              'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
              '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
            ];
            // -- Build a standalone Jito tip tx (separate from Raydium's tx) -------------
            // Raydium's txs use complex ATL structures. Injecting instructions into them
            // causes AccountLoadedTwice / InsufficientFunds / 400 errors from Jito.
            // Instead: keep Raydium's tx completely unmodified and append a plain SOL
            // transfer to a Jito tip account as a separate tx at the END of the bundle.
            // Bundle layout: [swapTx1?, swapTx, tipTx] — tip must be last per Jito spec.
            function _buildRdmTipTx(userB58, blockhashBytes, tipLamports, useV0) {
              const tipAcct = _JITO_TIPS[Math.floor(Math.random() * _JITO_TIPS.length)];
              const user    = ns.b58Decode(userB58);
              const tip     = ns.b58Decode(tipAcct);
              const sys     = new Uint8Array(32); // SystemProgram — all zeros
              const _encU64 = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
              const ixData  = new Uint8Array([2, 0, 0, 0, ..._encU64(tipLamports)]);
              // Jito requires all txs in a bundle to use the same version.
              const msg = useV0
                ? [ 0x80, 1, 0, 1, 3, ...user, ...tip, ...sys, ...blockhashBytes,
                    1, 2, 2, 0, 1, 12, ...ixData, 0 ]
                : [ 1, 0, 1, 3, ...user, ...tip, ...sys, ...blockhashBytes,
                    1, 2, 2, 0, 1, 12, ...ixData ];
              const tx = new Uint8Array(1 + 64 + msg.length);
              tx[0] = 1; // compact-u16(1) — one signature slot
              tx.set(msg, 65);
              return tx;
            }
            // Parse blockhash + version from the swap tx bytes (read-only, no modification).
            function _parseSwapMeta(txBytes) {
              let p = 0;
              const _cu = (buf, pos) => { let v = buf[pos++]; if (v & 0x80) v = (v & 0x7f) | (buf[pos++] << 7); return [v, pos]; };
              let [nSigs, pSigs] = _cu(txBytes, p); p = pSigs + nSigs * 64;
              const isV0 = (txBytes[p] & 0x80) !== 0;
              if (isV0) p++;
              p += 3; // skip header bytes
              let [nAccts, pKeys] = _cu(txBytes, p); p = pKeys + nAccts * 32;
              return { isV0, blockhash: txBytes.slice(p, p + 32) };
            }
            // Jito sandwich mitigation: inject a jitodontfront read-only account into each
            // Raydium swap tx BEFORE the user signs. The block engine rejects any bundle that
            // places another transaction before the tx containing this account, preventing
            // front-run / sandwich wrapping. Appended as the last static read-only unsigned
            // account in the V0 message. Jito's block engine scans all account keys directly —
            // no need to attach it to any instruction's accounts list (and doing so would
            // corrupt instructions like SetComputeUnitLimit that expect 0 accounts).
            // Fails open: returns original base64 unmodified on any parse error.
            function _injectDontFront(txB64) {
              try {
                const DF_B58  = 'jitodontfront111111111111111111111111111111';
                const dfBytes = ns.b58Decode(DF_B58);
                const raw     = Uint8Array.from(atob(txB64), c => c.charCodeAt(0));
                const _rcu = (buf, pos) => { let v = buf[pos++]; if (v & 0x80) v = (v & 0x7f) | (buf[pos++] << 7); return [v, pos]; };
                const _wcu = n => n < 128 ? new Uint8Array([n]) : new Uint8Array([0x80 | (n & 0x7f), n >> 7]);
                let p = 0;
                let [nSigs, p2] = _rcu(raw, p); p = p2;
                const sigSec = raw.slice(0, p + nSigs * 64);
                p += nSigs * 64;
                if ((raw[p] & 0x80) === 0) return txB64; // legacy tx — skip
                p++; // V0 prefix
                const numReqSigs  = raw[p];
                const numROSigned = raw[p + 1];
                const numROUnsig  = raw[p + 2];
                p += 3;
                let [numStatic, p3] = _rcu(raw, p); p = p3;
                const staticBytes = raw.slice(p, p + numStatic * 32);
                p += numStatic * 32;
                const blockhash = raw.slice(p, p + 32);
                p += 32;
                let [numInstrs, p4] = _rcu(raw, p); p = p4;
                const instrs = [];
                for (let i = 0; i < numInstrs; i++) {
                  const progIdx = raw[p++];
                  let [nA, p5] = _rcu(raw, p); p = p5;
                  const accts = Array.from(raw.slice(p, p + nA)); p += nA;
                  let [dLen, p6] = _rcu(raw, p); p = p6;
                  const data = raw.slice(p, p + dLen); p += dLen;
                  instrs.push({ progIdx, accts, data });
                }
                const altSec = raw.slice(p);
                // Already has dontfront? skip
                for (let i = 0; i < numStatic; i++) {
                  if (staticBytes.slice(i * 32, i * 32 + 32).every((b, j) => b === dfBytes[j])) return txB64;
                }
                // Append DontFront as the last static read-only unsigned account.
                // All ALT-indexed refs in instructions must be shifted +1 since static table grew.
                const newNumStatic = numStatic + 1;
                const newROUnsig   = numROUnsig + 1;
                const newInstrs = instrs.map(instr => ({
                  progIdx: instr.progIdx >= numStatic ? instr.progIdx + 1 : instr.progIdx,
                  accts:   instr.accts.map(idx => idx >= numStatic ? idx + 1 : idx),
                  data:    instr.data,
                }));
                const encInstrs = list => {
                  const parts = [];
                  for (const ix of list) {
                    parts.push(new Uint8Array([ix.progIdx]));
                    parts.push(_wcu(ix.accts.length));
                    parts.push(new Uint8Array(ix.accts));
                    parts.push(_wcu(ix.data.length));
                    if (ix.data.length) parts.push(new Uint8Array(ix.data));
                  }
                  return parts;
                };
                const parts = [
                  new Uint8Array([0x80]),
                  new Uint8Array([numReqSigs, numROSigned, newROUnsig]),
                  _wcu(newNumStatic), staticBytes, dfBytes,
                  blockhash,
                  _wcu(newInstrs.length), ...encInstrs(newInstrs),
                  altSec,
                ];
                const msgLen = parts.reduce((s, a) => s + a.length, 0);
                const newMsg = new Uint8Array(msgLen);
                let off = 0; for (const part of parts) { newMsg.set(part, off); off += part.length; }
                const fullTx = new Uint8Array(sigSec.length + newMsg.length);
                fullTx.set(sigSec); fullTx.set(newMsg, sigSec.length);
                let b64 = ''; for (let i = 0; i < fullTx.length; i++) b64 += String.fromCharCode(fullTx[i]);
                return btoa(b64);
              } catch (_e) {
                console.warn('[ZendIQ] DontFront injection skipped:', _e.message);
                return txB64; // fail-open — swap proceeds without DontFront
              }
            }
            const _lastRdmRaw = Uint8Array.from(atob(_rdmTxsToSign[_rdmTxsToSign.length - 1]), c => c.charCodeAt(0));
            const { isV0: _rdmIsV0, blockhash: _rdmBlockhash } = _parseSwapMeta(_lastRdmRaw);
            const _tipTxRaw = _buildRdmTipTx(_bundleWallet, _rdmBlockhash, _jitoBundleTip, _rdmIsV0);

            // Bundle = [Raydium txs with DontFront injected] + tip tx last.
            // _injectDontFront rewrites unsigned message bytes before wallet signing.
            const _dontFrontB64 = _rdmTxsToSign.map(_injectDontFront);
            const _toSignRaw = [
              ..._dontFrontB64.map(b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0))),
              _tipTxRaw,
            ];

            // -- Sign all txs — single wallet confirmation -----------------------------
            const _wsA  = ns._wsAccount || ns._wsWallet?.accounts?.[0] || null;
            const _wsSF = ns._wsWallet?.features?.['solana:signTransaction'];
            let _signedAll = [];

            if (_wsSF?.signTransaction && _wsA) {
              // Wallet Standard: solana:signTransaction IS variadic ? pass all txs in one call
              // so the wallet shows a single "Approve N transactions" popup for the whole bundle.
              const _inputs = _toSignRaw.map(tx => ({ account: _wsA, transaction: tx, chain: 'solana:mainnet' }));
              let _results;
              try {
                _results = await _wsSF.signTransaction(..._inputs);
              } catch (_e) {
                if (/reject|cancel|denied|abort/i.test(_e?.message ?? '')) throw new Error('cancelled');
                throw _e;
              }
              _signedAll = _results.map(r => r?.signedTransaction ? new Uint8Array(r.signedTransaction) : null);
              if (_signedAll.some(b => !b)) throw new Error('bundle: signTransaction returned null bytes');
              _bundleSignedSwapBytes = _signedAll[_rdmTxsToSign.length - 1] ?? null;
            } else if (legacyWallet?.signAllTransactions && VersionedTransaction) {
              // Legacy wallet fallback: needs VersionedTransaction objects ? also one popup.
              const _objs = _toSignRaw.map(b => VersionedTransaction.deserialize(b));
              const _res  = await legacyWallet.signAllTransactions(_objs);
              _signedAll  = _res.map(tx =>
                tx instanceof Uint8Array ? tx : (tx?.serialize ? new Uint8Array(tx.serialize()) : null)
              );
              if (_signedAll.some(b => !b)) throw new Error('bundle: legacy serialisation failed');
              _bundleSignedSwapBytes = _signedAll[_rdmTxsToSign.length - 1] ?? null;
            } else {
              throw new Error('bundle: no Wallet Standard signTransaction or legacy signAllTransactions available');
            }

            // -- Encode signed txs as base64 for Jito ----------------------------------
            const _bundleB64 = _signedAll.map(raw => {
              let bin = ''; for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
              return btoa(bin);
            });

            // -- Pre-submit: simulate swap TX to catch obvious failures before wasting a Jito slot ---
            // NOTE: Raydium V0 txs use ALTs; many RPC nodes return simulation errors for ALT-heavy
            // txs even when they would succeed on-chain (node hasn't loaded ALT data into cache).
            // Simulation result is therefore DIAGNOSTIC ONLY — we log it but never abort on it.
            // Real on-chain failure detection is handled by the getSignatureStatuses check below.
            try {
              const _simUrl = ns._jupRpcUrl || 'https://api.mainnet-beta.solana.com';
              const _simR = await fetch(_simUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction',
                  params: [_bundleB64[_bundleB64.length - 2], { encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: true }] })
              });
              const _simD = await _simR.json();
              const _simErr = _simD?.result?.value?.err;
              if (_simErr) {
                const _simErrStr = JSON.stringify(_simErr);
                // Deterministic failures — will ALWAYS fail on-chain regardless of skipPreflight.
                // Abort now and let Jupiter execute instead.
                //   AccountLoadedTwice   = tip injection added an account already in ATL
                //   InsufficientFunds*   = 100%-SOL swap left no lamports for the injected tip
                if (_simErrStr.includes('AccountLoadedTwice') ||
                    /insufficient.{0,30}(lamport|fund|fee|rent)/i.test(_simErrStr)) {
                  _hadRdmSimFail = true;
                  throw new Error('__rdm_sim_fallback__');
                }
                // Non-deterministic errors (ALT cache misses, custom program pre-checks)
                // may still land fine on-chain with skipPreflight. Log only.
                console.warn('[ZendIQ] Raydium bundle sim warning (may be ALT cache miss):', _simErrStr);
              }
            } catch (_simEx) {
              if (_simEx.message === '__rdm_sim_fallback__') throw _simEx;
            }
            // -- Submit to Jito -------------------------------------------------------
            // Single-tx path (most Raydium swaps): use sendTransaction?bundleOnly=true —
            // same approach as pump.fun. Returns a real sig in data.result and the bundle
            // ID in the x-bundle-id response header. No separate bundle status polling
            // needed beyond polling the sig on RPC.
            // Multi-tx path (ATA-create + swap): must use /bundles (accepts array).
            const _isSingleBundle = false; // always use /bundles — bundleOnly=true rejected Raydium ATL txs
            const _JITO_BASE_URLS = [
              'https://amsterdam.mainnet.block-engine.jito.wtf',
              'https://ny.mainnet.block-engine.jito.wtf',
              'https://frankfurt.mainnet.block-engine.jito.wtf',
              'https://tokyo.mainnet.block-engine.jito.wtf',
              'https://london.mainnet.block-engine.jito.wtf',
              'https://dublin.mainnet.block-engine.jito.wtf',
              'https://slc.mainnet.block-engine.jito.wtf',
              'https://singapore.mainnet.block-engine.jito.wtf',
              'https://mainnet.block-engine.jito.wtf',
            ];

            // Extract swap tx sig from signed bytes (bytes 1-64 after compact-u16 sig count).
            // Tip tx is last in _signedAll; swap tx is at index [_rdmTxsToSign.length - 1].
            const _swapRaw = _signedAll[_rdmTxsToSign.length - 1];
            if (_swapRaw?.length > 65) rpcSig = ns.b58Encode(_swapRaw.slice(1, 65));
            const _jitoTipSig = null; // tip is a separate tx in the bundle, no ZendIQ tracking needed

            let _bundleId = null;
            let _jitoBase = null;

            if (_isSingleBundle) {
              // ── Single-tx: sendTransaction?bundleOnly=true (pump.fun approach) ──────
              const _swapB64 = _bundleB64[0];
              const _body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
                params: [_swapB64, { encoding: 'base64' }] });
              const _tryEndpoint = async (base) => {
                const url = base + '/api/v1/transactions?bundleOnly=true';
                const r = await fetch(url, { method: 'POST',
                  headers: { 'Content-Type': 'application/json' }, body: _body,
                  signal: AbortSignal.timeout(8000) });
                const d = await r.json();
                const bid = r.headers.get('x-bundle-id') ?? null;
                if (d?.result) return { sig: d.result, bundleId: bid, base };
                throw new Error(JSON.stringify(d?.error ?? 'no result'));
              };
              let _st;
              try {
                _st = await Promise.any(_JITO_BASE_URLS.map(_tryEndpoint));
              } catch (_) {
                throw new Error('Jito: all regional endpoints unavailable (429/503/timeout)');
              }
              if (_st.sig) rpcSig = _st.sig; // authoritative sig from Jito response
              _bundleId = _st.bundleId;
              _jitoBase = _st.base;

              // Poll RPC for confirmation — same as pump.fun.
              // Sig came directly from Jito so we know it's the right one.
              let _confirmed = false;
              const _rpcUrl  = ns._jupRpcUrl || 'https://api.mainnet-beta.solana.com';
              for (let _pi = 0; _pi < 20 && !_confirmed; _pi++) {
                await new Promise(r => setTimeout(r, 1000));
                try {
                  const _r = await fetch(_rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[rpcSig]] }) });
                  const _d = await _r.json();
                  const _sv = _d?.result?.value?.[0];
                  if (_sv && !_sv.err) { _confirmed = true; _jitoBundleOk = true; break; }
                  if (_sv?.err) { _hadRdmSimFail = true; throw new Error('__rdm_sim_fallback__'); }
                  // null = not yet seen, keep polling
                } catch (_pe) { if (_pe.message === '__rdm_sim_fallback__') throw _pe; }
              }
              if (!_confirmed) throw new Error('__bundle_expired__');

            } else {
              // ── Multi-tx: /bundles (ATA-create + swap) ───────────────────────────────
              const _BUNDLE_ENDPOINTS = _JITO_BASE_URLS.map(b => b + '/api/v1/bundles');
              const _jitoPayload = { jsonrpc: '2.0', id: 1, method: 'sendBundle',
                params: [_bundleB64, { encoding: 'base64' }] };
              const _tryBundle = async (url) => {
                const d = await ns.pageJsonPost(url, _jitoPayload, 4000);
                if (d?.result) return { result: d.result, endpoint: url };
                throw new Error(JSON.stringify(d?.error ?? 'no result'));
              };
              let _jitoResult;
              try {
                _jitoResult = await Promise.any(_BUNDLE_ENDPOINTS.map(_tryBundle));
              } catch (_) {
                throw new Error('Jito: all regional endpoints unavailable (429/503/timeout)');
              }
              _bundleId = _jitoResult.result;
              _jitoBase = _jitoResult.endpoint.replace('/api/v1/bundles', '');

              if (_bundleId) {
                const _INFLIGHT_URL = _jitoBase + '/api/v1/getInflightBundleStatuses';
                const _STATUSES_URL = _jitoBase + '/api/v1/getBundleStatuses';

                // Step 1: getInflightBundleStatuses
                const _inflightBody = { jsonrpc: '2.0', id: 1, method: 'getInflightBundleStatuses', params: [[_bundleId]] };
                for (let _pi = 0; _pi < 12; _pi++) {
                  await new Promise(r => setTimeout(r, 500));
                  try {
                    const _sd = await ns.pageJsonPost(_INFLIGHT_URL, _inflightBody);
                    const _sv = _sd?.result?.value?.[0];
                    if (!_sv) continue;
                    if (_sv.status === 'Landed') { _jitoBundleOk = true; break; }
                    if (_sv.status === 'Failed') throw new Error('Jito bundle failed on-chain -- please retry');
                  } catch (_pollErr) {
                    if (_pollErr.message.startsWith('Jito bundle failed')) throw _pollErr;
                  }
                }

                // Step 2: getBundleStatuses
                if (!_jitoBundleOk) {
                  try {
                    const _gbsBody = { jsonrpc: '2.0', id: 1, method: 'getBundleStatuses', params: [[_bundleId]] };
                    const _gbsD = await ns.pageJsonPost(_STATUSES_URL, _gbsBody, 4000);
                    const _gbsV = _gbsD?.result?.value?.[0];
                    if (_gbsV?.confirmation_status) {
                      if (_gbsV.transactions?.[0]) rpcSig = _gbsV.transactions[0];
                      _jitoBundleOk = true;
                    }
                  } catch (_) {}
                }

                // Step 3: direct RPC sig check
                if (!_jitoBundleOk && rpcSig) {
                  try {
                    const _rpcUrl = ns._jupRpcUrl || 'https://api.mainnet-beta.solana.com';
                    const _r = await fetch(_rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[rpcSig]] }) });
                    const _d = await _r.json();
                    const _sigStatus = _d?.result?.value?.[0];
                    if (_sigStatus && !_sigStatus.err) {
                      _jitoBundleOk = true;
                    } else if (_sigStatus === null) {
                      const _signedSwapFb = _signedAll[_rdmTxsToSign.length - 1];
                      let _fbOk = false;
                      if (_signedSwapFb) {
                        try {
                          let _fbBin = ''; for (let _i = 0; _i < _signedSwapFb.length; _i++) _fbBin += String.fromCharCode(_signedSwapFb[_i]);
                          const _fbB64 = btoa(_fbBin);
                          const _fbRpc = ns._jupRpcUrl || 'https://api.mainnet-beta.solana.com';
                          const _fbR = await fetch(_fbRpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
                              params: [_fbB64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }) });
                          const _fbD = await _fbR.json();
                          if (_fbD?.result) {
                            rpcSig = _fbD.result;
                            for (let _ci = 0; _ci < 8; _ci++) {
                              await new Promise(r => setTimeout(r, 1500));
                              try {
                                const _cr = await fetch(_fbRpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[rpcSig]] }) });
                                const _cd = await _cr.json();
                                const _cv = _cd?.result?.value?.[0];
                                if (_cv && !_cv.err) { _fbOk = true; _jitoBundleOk = true; break; }
                                if (_cv?.err) throw new Error('__rdm_sim_fallback__');
                              } catch (_cErr) { if (_cErr.message === '__rdm_sim_fallback__') throw _cErr; }
                            }
                          }
                        } catch (_fbErr) { if (_fbErr.message === '__rdm_sim_fallback__') throw _fbErr; }
                      }
                      if (!_fbOk) throw new Error('__bundle_expired__');
                    } else if (_sigStatus && _sigStatus.err) {
                      _hadRdmSimFail = true;
                      throw new Error('__rdm_sim_fallback__');
                    }
                  } catch (_rpcErr) {
                    if (_rpcErr.message === '__bundle_expired__') throw _rpcErr;
                  }
                }
                if (!_jitoBundleOk) throw new Error('__bundle_expired__');
              }
            }

            data = { status: 'Success', signature: rpcSig, jitoTipSig: _jitoTipSig ?? null, bundleId: _bundleId ?? null };
            // Safety: if _jitoBundleTip was somehow raised above what fetchWidgetQuote stored
            // (e.g. a future code path), record the actual tip paid so Activity stays accurate.
            if (ns.widgetLastOrderFees && _jitoBundleTip > (ns.widgetLastOrderFees.jitoTipLamports ?? 0)) {
              ns.widgetLastOrderFees = { ...ns.widgetLastOrderFees, jitoTipLamports: _jitoBundleTip };
            }
          } catch (jitoErr) {
            if (/reject|cancel|denied|abort/i.test(jitoErr?.message ?? '')) throw new Error('cancelled');
            if (jitoErr?.message === '__bundle_expired__') throw jitoErr;
            if (jitoErr?.message?.startsWith('Jito bundle failed')) throw jitoErr;
            if (jitoErr?.message === '__rdm_sim_fallback__') throw jitoErr;
            // Any other unexpected Jito error — surface it to the user, no silent fallback.
            throw jitoErr;
          }
        }
      }

      ns.widgetSwapStatus    = 'done';
      // Cooldown: suppress re-intercept for 4 s so Jupiter's retry after the
      // 'optimise' throw doesn't immediately open a new panel.
      ns._signCooldownUntil = Date.now() + 4000;
      if (ns.widgetCapturedTrade?.source === 'raydium') ns._rdmPostSwapIdle = true;
      try {
        // Persist a history entry via the bridge so popup will show it
        const sig = data?.signature ?? null;
        const captured = ns.widgetCapturedTrade;
        const lastOrder = ns.widgetLastOrder || {};
        const outDec = captured?.outputDecimals ?? 6;
        const outAmt = lastOrder.outAmount ? (Number(lastOrder.outAmount) / Math.pow(10, outDec)).toFixed(6) : null;
        const inAmt  = captured?.amountUI != null ? captured.amountUI : (captured?.amountRaw ? (captured.amountRaw / Math.pow(10, captured.inputDecimals ?? 9)) : null);
        // Save summary for the success display panel
        ns.widgetLastTxSig  = sig;
        ns.widgetLastTxPair = {
          inSym:  captured?.inputSymbol  ?? '?',
          outSym: captured?.outputSymbol ?? '?',
          inAmt,
          outAmt: outAmt != null ? Number(outAmt) : null,
        };
        ns.widgetLastTxFromSwapTab = captured?.fromSwapTab ?? false;
        const entry = {
          signature: sig,
          tokenIn:   captured?.inputSymbol ?? (captured?.inputMint ?? '?'),
          tokenOut:  captured?.outputSymbol ?? (captured?.outputMint ?? '?'),
          amountIn:  inAmt != null ? String(inAmt) : null,
          amountOut: outAmt != null ? String(outAmt) : null,
          quotedOut: outAmt != null ? String(outAmt) : null,
          optimized: true,
          timestamp: Date.now(),
          solscanUrl:  sig ? ('https://solscan.io/tx/' + sig) : null,
          jitoTipSig:  data?.jitoTipSig ?? null,
          jitoBundle:  !!(data?.bundleId || data?.jitoTipSig),
          // Fee / risk / savings metadata
          priorityFeeLamports: ns.widgetLastOrderFees?.priorityFeeLamports ?? ns.PRIORITY_FEE_LOW,
          jitoTipLamports:     ns.widgetLastOrderFees?.jitoTipLamports ?? 0,
          outputMint:          captured?.outputMint ?? null,
          riskScore:           captured?.riskScore ?? null,
          riskLevel:           (() => { const s = captured?.riskScore ?? null; return s != null ? (s >= 60 ? 'CRITICAL' : s >= 40 ? 'HIGH' : s >= 20 ? 'MEDIUM' : 'LOW') : null; })(),
          riskFactors:         captured?.riskFactors ?? [],
          mevFactors:               captured?.mevFactors ?? [],
          mevRiskLevel:             captured?.mevRiskLevel ?? null,
          mevRiskScore:             captured?.mevRiskScore ?? null,
          mevEstimatedLossPercent:  captured?.mevEstimatedLossPercent ?? null,
          priceImpactPct:      lastOrder.priceImpactPct ?? null,
          swapType:            lastOrder.swapType ?? null,
          routeSource:         lastOrder._source ?? null,  // 'raydium' or null (Jupiter)
          rawOutAmount:        _signedOutAmount ?? lastOrder.outAmount ?? null,
          outputDecimals:      outDec,
          // Use the baseline frozen at Review & Sign render time ? not the live tick value
          // which may have advanced by the time the tx confirms (~1-3s later).
          // _preSignSnap* are captured at the top of signWidgetSwap before the re-fetch
          // overwrites ns.widgetSnap* ? ensures Activity shows exactly what the user saw.
          // _preSignSnapBaseline is the baseline frozen at Review & Sign render time ?
          // exactly what the user saw when they decided to sign. Use it as first priority.
          // _signedBaseline (from widgetBaselineRawOut after pre-sign re-fetch) is now
          // equivalent because the re-fetch no longer updates widgetBaselineRawOut, but
          // keeping _preSignSnapBaseline first makes the semantics explicit.
          baselineRawOut:      _preSignSnapBaseline ?? _signedBaseline ?? ns.widgetSnapBaselineRawOut ?? ns.widgetBaselineRawOut ?? null,
          // Snapshot of the exact netUsd/savingsUsd the user saw on the Review & Sign panel.
          // Activity tab will prefer these over a recalculated value (on-chain Tier 1 still overrides).
          snapNetUsd:             _preSignSnapNet     ?? ns.widgetSnapNetUsd     ?? null,
          snapSavingsUsd:         _preSignSnapSavings ?? ns.widgetSnapSavingsUsd ?? null,
          snapMevProtectionUsd:   _preSignSnapMevProt ?? ns.widgetSnapMevProtectionUsd ?? null,
          // estSavingsTokens: removed ? price-impact formula was producing phantom savings
          // that never matched Activity. Savings are either from baseline comparison or null.
          estSavingsTokens: null,
          // Sandwich detection result — null = check in progress (resolved async via HISTORY_UPDATE).
          // Field is omitted entirely for RFQ/gasless routes (no AMM pool, no sandwich possible).
          ...(lastOrder.swapType !== 'rfq' && lastOrder.swapType !== 'gasless' ? { sandwichResult: null } : {}),
          // USD price data for savings breakdown tooltip
          ...(ns.widgetLastPriceData ?? {}),
        };
        try { window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: entry } }, '*'); } catch (e) {}

        // Analytics: swap completed via ZendIQ's route
        try { if (ns.logProEvent) {
          const _feesMain = ns.widgetLastOrderFees ?? {};
          const _lpMain   = ns.widgetLastPriceData ?? {};
          const _solMain  = _lpMain.solPriceUsd ?? 80;
          const _sshMain  = window.location.hostname;
          ns.logProEvent('swap_optimised', {
            site:             entry.routeSource === 'raydium' ? 'raydium.io' : _sshMain.includes('pump') ? 'pump.fun' : 'jup.ag',
            net_benefit_usd:  entry.snapNetUsd ?? null,
            routing_gain_usd: entry.snapSavingsUsd ?? null,
            mev_value_usd:    entry.snapMevProtectionUsd != null ? Math.min(entry.snapMevProtectionUsd, 5000) : null,
            fees_usd:         ((_feesMain.priorityFeeLamports ?? 0) + (_feesMain.jitoTipLamports ?? 0)) / 1e9 * _solMain || null,
            trade_usd:        entry.inUsdValue != null ? Math.min(Number(entry.inUsdValue), 50000) : null,
            route_type:       entry.swapType === 'rfq' ? 'rfq' : entry.swapType === 'gasless' ? 'gasless' : entry.routeSource === 'raydium' ? 'raydium' : entry.swapType ? 'amm' : 'unknown',
            jito_used:        !!(entry.jitoBundle),
            profile:          ns.settingsProfile ?? 'unknown',
            auto_sign:        !!ns.autoAccept,
          });
          // Structured trade record (routes to trades DB table)
          try { if (ns.logTrade) {
            const _rMain  = ns.lastRiskResult;
            const _lv2s2  = (lv) => lv === 'LOW' ? 'safe' : lv === 'MEDIUM' ? 'caution' : lv ? 'danger' : null;
            const _rtMain = entry.swapType === 'rfq' ? 'rfq' : entry.swapType === 'gasless' ? 'gasless' : entry.routeSource === 'raydium' ? 'raydium' : 'amm';
            ns.logTrade({
              user_action:      'optimised',
              dex:              entry.routeSource === 'raydium' ? 'raydium.io' : _sshMain.includes('pump') ? 'pump.fun' : 'jup.ag',
              exec_path:        _rtMain === 'amm' ? (!!(entry.jitoBundle) ? 'jito' : 'direct') : _rtMain,
              tx_sig:           sig ?? null,
              input_mint:       entry.inputMint  ?? null,
              output_mint:      entry.outputMint ?? null,
              success:          1,
              trade_usd:        entry.inUsdValue != null ? Math.min(Number(entry.inUsdValue), 50000) : null,
              net_benefit_usd:  entry.snapNetUsd ?? null,
              routing_gain_usd: entry.snapSavingsUsd ?? null,
              mev_value_usd:    entry.snapMevProtectionUsd != null ? Math.min(entry.snapMevProtectionUsd, 5000) : null,
              fees_usd:         ((_feesMain.priorityFeeLamports ?? 0) + (_feesMain.jitoTipLamports ?? 0)) / 1e9 * _solMain || null,
              jito_tip_lamports: _feesMain.jitoTipLamports ?? null,
              route_chosen:     _rtMain,
              bot_risk_score:   _rMain?.score  ?? null,
              token_risk_score: ns.tokenScoreResult?.score ?? null,
              tx_classification: _lv2s2(_rMain?.level),
              profile:          ns.settingsProfile ?? 'unknown',
              auto_sign:        !!ns.autoAccept,
            });
          } } catch (_) {}
        } } catch (_) {}

        // Fire-and-forget: poll Solana RPC for actual on-chain output and update the entry
        if (sig && captured?.outputMint) {
          (async () => {
            try {
              const result = await ns.fetchActualOut(
                sig,
                captured.outputMint,
                walletPubkey ?? ns.resolveWalletPubkey() ?? null,
                // Use the outAmount from the exact order that was sent to the wallet.
                // _signedOutAmount is a local captured before any async ? safe from
                // timer or live-tick updates to ns.widgetLastOrder.
                _signedOutAmount != null ? Number(_signedOutAmount) : (lastOrder.outAmount != null ? Number(lastOrder.outAmount) : null),
                outDec,
              );
              if (!result) return;
              // Post a partial update ? background will merge it into the existing entry
              window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                signature: sig,
                actualOutAmount:  String(result.actualOut),
                quoteAccuracy:    result.quoteAccuracy,
                // Update displayed amountOut to actual received
                amountOut:        String(result.actualOut),
              }}}, '*');
            } catch (_) {}
          })();
        }

        // Sandwich detection — fire-and-forget, AMM trades only (RFQ/gasless have no mempool)
        if (sig && ns.detectSandwich && captured?.inputMint && captured?.outputMint
            && lastOrder.swapType !== 'rfq' && lastOrder.swapType !== 'gasless') {
          // Capture ns state synchronously before any await (ns vars get nulled after this try block)
          const _inUsdVal = ns.widgetLastPriceData?.inUsdValue ?? null;
          (async () => {
            try {
              const result = await ns.detectSandwich(sig, captured.inputMint, captured.outputMint, {
                inputDecimals: captured.inputDecimals ?? 9,
                amountIn:    inAmt,
                amountInUsd: _inUsdVal,
              });
              if (!result) return;
              window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
                signature: sig,
                sandwichResult: result,
              }}}, '*');
              if (ns.logMev) {
                const _atkH = result.attackerWallet && ns.hashAddr
                  ? await ns.hashAddr(result.attackerWallet).catch(() => null) : null;
                const _mevM = result.signals?.includes('bonding_curve_pda') ? 'bonding_curve_pda'
                            : result.signals?.some(s => String(s).includes('vault')) ? 'vault_neighbor'
                            : result.method === 'front-run' ? 'front_run_only' : 'unknown';
                ns.logMev({ tx_sig: sig, detected: !!result.detected, loss_usd: result.extractedUsd ?? null,
                  loss_bps: result.extractedUsd && _inUsdVal ? Math.round(result.extractedUsd / _inUsdVal * 10000) : null,
                  attacker_hash: _atkH, method: _mevM, prevented_count: result.detected ? 1 : 0 });
              }
            } catch (_) {}
          })();
        }
      } catch (e) { console.warn('[ZendIQ] history persist failed (widget path)', e); }
      ns.widgetLastOrder             = null;
      ns.widgetCapturedTrade         = null;
      ns.widgetSnapBaselineRawOut    = null;
      ns.widgetSnapNetUsd            = null;
      ns.widgetSnapSavingsUsd        = null;
      ns.widgetSnapMevProtectionUsd  = null;
      // Ensure Monitor tab is active so the success card is always visible,
      // even if the user had switched to Activity or Settings during the bundle poll.
      ns.widgetActiveTab = 'monitor';
      ns.renderWidgetPanel();

    } catch (e) {
      if (e.message === '__rdm_sim_fallback__') {
        // Raydium simulation failed ? fetch Jupiter's route instead and return to Review & Sign.
        try {
          ns._rdmSkipOnce     = true;   // force Jupiter on this one fetch
          ns.widgetSwapError  = 'Raydium simulation failed ? loading Jupiter\'s route?';
          ns.widgetSwapStatus = 'fetching';
          ns.renderWidgetPanel();
          await fetchWidgetQuote(false, true);
          if (ns.widgetSwapStatus === 'ready') {
            ns.widgetSwapError = 'Raydium route failed simulation \u2014 Jupiter\'s route loaded below';
            ns.renderWidgetPanel();
          }
        } catch (_fbErr) {
          ns.widgetSwapError  = 'Swap failed ? please try again';
          ns.widgetSwapStatus = 'error';
          ns.renderWidgetPanel();
        }
        return;
      }
      if (e.message === '__bundle_expired__') {
        // Jito bundle blockhash expired. signWidgetSwap Step 3 already rebuilds a fresh
        // Raydium TX + blockhash via fetchRaydiumQuote + fetchRaydiumTx, so retry directly.
        // Do NOT call fetchWidgetQuote here ? that re-runs the Raydium vs Jupiter comparison
        // and can switch to Jupiter if Raydium's API responds slower than the 1.5s deadline,
        // which is exactly the wrong behaviour for a bundle retry.
        if (retryCount < 2) {
          ns._rdmSkipOnce = false;
          signWidgetSwap(retryCount + 1);
        } else {
          ns.widgetSwapError  = 'Bundle failed after 3 attempts \u2014 please try again';
          ns.widgetSwapStatus = 'error';
          ns.renderWidgetPanel();
        }
        return;
      }
      const _cancelled = e.message === 'cancelled';
      if (!_cancelled) console.error('[ZendIQ] signWidgetSwap error:', e);
      ns.widgetSnapBaselineRawOut   = null;
      ns.widgetSnapNetUsd           = null;
      ns.widgetSnapSavingsUsd       = null;
      ns.widgetSnapMevProtectionUsd = null;
      ns.widgetSwapError  = _cancelled ? 'Transaction rejected in wallet' : (e.message || 'Swap failed');
      ns.widgetSwapStatus = 'error';
      ns.renderWidgetPanel();
    } finally {
      window.__zendiq_own_tx = false;
    }
  }

  // -- Export ---------------------------------------------------------------
  Object.assign(ns, {
    extractMintsFromContext,
    buildCapturedTrade,
    handleOptimiseTrade,
    fetchWidgetQuote,
    signWidgetSwap,
    deriveAta: _deriveATA,
  });
})();
