/**
 * ZendIQ – page-pump.js
 * pump.fun site adapter.
 * Registers with ns.registerSiteAdapter() so all pump.fun-specific logic is
 * isolated from the generic orchestrators (approval, wallet, widget, network).
 * Must load in MAIN world BEFORE page-interceptor.js.
 */

(function () {
  'use strict';
  const ns = window.__zq;
  if (!ns?.registerSiteAdapter) return;
  if (!window.location.hostname.includes('pump.fun')) return;

  // ── Parse raw tx args → maxSolCost in SOL (float) ─────────────────────────
  // Reads bytes 16-23 of the pump.fun buy instruction (maxSolCost u64 LE, lamports).
  // Returns the value in SOL, or null if parsing fails.
  function _maxSolCostFromTx(args) {
    if (!args) return null;
    try {
      let VTx = null;
      for (const k of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
        if (window[k]?.VersionedTransaction) { VTx = window[k].VersionedTransaction; break; }
      }
      if (!VTx) return null;
      const PUMP_PROGRAMS = new Set([
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymgQ8h',
        'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW',
      ]);
      let vtx = null;
      if (Array.isArray(args[0]) && args[0][0]?.transaction instanceof Uint8Array) {
        vtx = VTx.deserialize(args[0][0].transaction);
      } else if (args[0]?.message) {
        vtx = args[0];
      }
      if (!vtx) return null;
      const msg  = vtx.message;
      const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
      const pIdx = keys.findIndex(k => PUMP_PROGRAMS.has(typeof k === 'string' ? k : k.toBase58?.() ?? String(k)));
      if (pIdx < 0) return null;
      const ixs  = msg.compiledInstructions ?? msg.instructions ?? [];
      const pIx  = ixs.find(ix => ix.programIdIndex === pIdx);
      if (!pIx) return null;
      const data = pIx.data instanceof Uint8Array ? pIx.data
        : typeof pIx.data === 'string' ? Uint8Array.from(atob(pIx.data), c => c.charCodeAt(0))
        : null;
      if (!data || data.length < 24) return null;
      let lamports = 0n;
      for (let i = 0; i < 8; i++) lamports |= BigInt(data[16 + i]) << BigInt(i * 8);
      return Number(lamports) / 1e9; // SOL
    } catch (_) { return null; }
  }

  // ── Tx modifier: patches maxSolCost (bytes 16-23, u64 LE) to 0.5% slippage ──
  function _modifyPumpFunTx(args, currentSlipPct) {
    if (!args || !currentSlipPct || currentSlipPct <= 0.5) return null;
    const PUMP_PROGRAMS = new Set([
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymgQ8h', // bonding curve
      'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW', // advanced
    ]);
    try {
      let VTx = null;
      for (const k of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
        if (window[k]?.VersionedTransaction) { VTx = window[k].VersionedTransaction; break; }
      }
      if (!VTx) {
        for (const v of Object.values(window)) {
          if (v && typeof v === 'object' && typeof v.VersionedTransaction?.deserialize === 'function') {
            VTx = v.VersionedTransaction; break;
          }
        }
      }
      if (!VTx) return null;

      function _rdU64(buf, off) {
        let v = 0n;
        for (let i = 0; i < 8; i++) v |= BigInt(buf[off + i]) << BigInt(i * 8);
        return Number(v);
      }
      function _wrU64(buf, off, val) {
        let n = BigInt(Math.ceil(val));
        for (let i = 0; i < 8; i++) { buf[off + i] = Number(n & 0xffn); n >>= 8n; }
      }
      function _patch(vtx) {
        const msg  = vtx.message;
        const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
        const pIdx = keys.findIndex(k => PUMP_PROGRAMS.has(typeof k === 'string' ? k : k.toBase58?.() ?? String(k)));
        if (pIdx < 0) return false;
        const ixs  = msg.compiledInstructions ?? msg.instructions ?? [];
        const pIx  = ixs.find(ix => ix.programIdIndex === pIdx);
        if (!pIx) return false;
        const data = pIx.data instanceof Uint8Array ? pIx.data
          : typeof pIx.data === 'string' ? Uint8Array.from(atob(pIx.data), c => c.charCodeAt(0))
          : null;
        if (!data || data.length < 24) return false;
        const currentMax = _rdU64(data, 16);
        if (currentMax <= 0) return false;
        const baseCost = currentMax / (1 + currentSlipPct / 100);
        _wrU64(data, 16, baseCost * 1.005); // target 0.5%
        return true;
      }

      // Wallet Standard: args = [[{account, transaction: Uint8Array, ...}], ...]
      if (Array.isArray(args[0]) && args[0][0]?.transaction instanceof Uint8Array) {
        const input = args[0][0];
        const vtx   = VTx.deserialize(input.transaction);
        if (!_patch(vtx)) return null;
        return [[{ ...input, transaction: vtx.serialize() }, ...args[0].slice(1)], ...args.slice(1)];
      }
      // Legacy VersionedTransaction: args = [vtx, opts?]
      if (args[0]?.message) {
        if (!_patch(args[0])) return null;
        return args; // modified in-place
      }
      return null;
    } catch (_) { return null; }
  }

  // ── Colour/label helpers (duplicated from widget IIFE for adapter use before helpers expose) ──
  const _clr = lv => ({ CRITICAL: '#FF4D4D', HIGH: '#FFB547', MEDIUM: '#9945FF', LOW: '#14F195' })[lv] ?? '#9B9BAD';
  const _rl  = lv => ({ CRITICAL: '⛔ Critical risk', HIGH: '⚠ High risk', MEDIUM: '⚠ Moderate risk', LOW: '✓ Low risk' })[lv] ?? lv;

  ns.registerSiteAdapter({
    name: 'pump',
    matches:    () => window.location.hostname.includes('pump.fun'),
    busyStates: ['pump-slippage-review', 'pump-signing'],

    // ── Page init: extract mint from URL for early token scoring ─────────
    initPage() {
      const m = window.location.pathname.match(/\/coin\/([1-9A-HJ-NP-Za-km-z]{32,50})/);
      if (m) {
        ns.lastOutputMint = m[1];
        if (ns.fetchTokenScore && m[1] !== ns._tokenScoreMint) {
          ns._tokenScoreMint  = m[1];
          ns.tokenScoreResult = null;
          Promise.resolve().then(() => ns.fetchTokenScore(m[1], null));
        }
      }
    },

    // ── Network hook: extract mint + intended SOL amount from pump.fun API calls ────
    onNetworkRequest(url, parsed) {
      if (!url || !/pump\.fun/.test(url) || !/\/(trade|buy|swap)/.test(url)) return;
      try {
        const segs = new URL(url, location.origin).pathname.split('/')
          .filter(s => s.length >= 32 && s.length <= 50 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s));
        if (segs[0] && segs[0] !== ns.lastOutputMint) {
          ns.lastOutputMint = segs[0];
          if (ns.fetchTokenScore && segs[0] !== ns._tokenScoreMint) {
            ns._tokenScoreMint  = segs[0];
            ns.tokenScoreResult = null;
            ns.fetchTokenScore(segs[0], null);
          }
        }
        // Capture the user's intended SOL amount from the API request body.
        // pump.fun sends { amount: X, denominatedInSol: true, slippage: Y } where
        // Y is often the bonding curve progress (0-1 fraction), NOT the user's slippage
        // tolerance — so we extract amount only and derive slippage from tx bytes later.
        if (parsed?.amount != null && (parsed?.denominatedInSol === true || parsed?.denominatedInSol === 'true')) {
          const a = Number(parsed.amount);
          if (isFinite(a) && a > 0 && a < 1000) ns.pumpFunNetAmount = a;
        }
      } catch (_) {}
    },

    // ── Wallet hook: capture raw args before approval prompt ─────────────
    onWalletArgs(args) {
      ns.pumpFunRawArgs = args;

      // Update slippage from tx bytes now that the real tx has been built.
      // This is the authoritative source — overrides anything from DOM/localStorage.
      if (ns.pumpFunContext) {
        const maxSol = _maxSolCostFromTx(args);
        const solAmt = ns.pumpFunContext.solAmount;
        if (maxSol > 0 && solAmt > 0) {
          const derived = (maxSol / solAmt - 1) * 100;
          if (derived >= 0.1 && derived <= 100) {
            ns.pumpFunContext.slippagePct = derived;
          }
        }
      }

      // If user already clicked "Sign at 0.5%", modify the tx in-place now.
      // The wallet hook has the real args — mutate them before origFn() is called.
      if (ns.pumpFunWantOptimise && ns.pumpFunContext) {
        ns.pumpFunWantOptimise = false;
        const slip = ns.pumpFunContext.slippagePct ?? 10;
        const mArgs = _modifyPumpFunTx(args, slip);
        if (mArgs) {
          // In-place mutation: wallet hook holds same array reference
          if (Array.isArray(args[0]) && args[0][0]?.transaction instanceof Uint8Array) {
            args[0][0] = { ...args[0][0], transaction: mArgs[0][0].transaction };
          }
          // Legacy path: _modifyPumpFunTx already mutates args[0].message in-place
          ns.pumpFunModifiedArgs = mArgs; // backup for onDecision path if needed
        }
      }
    },

    // ── Swap detection: build context, open widget, gate on slippage ─────
    async onSwapDetected(txInfo, resolve) {
      // ── Amount: prefer API body (most accurate) → DOM → zero ──────────
      // ns.pumpFunNetAmount is set by onNetworkRequest when pump.fun's trade
      // API call includes { amount: X, denominatedInSol: true }.
      const netAmt = ns.pumpFunNetAmount ?? 0;
      ns.pumpFunNetAmount  = null; // consume
      ns.pumpFunWantOptimise = false; // reset on each new swap intercept

      // DOM fallback: look for visible inputs with a small positive SOL value.
      // Filter out hidden/tiny elements (e.g. preset-button state inputs) to
      // avoid picking up 0.05, 0.1 etc. that are baked into preset buttons.
      let domAmt = 0;
      if (!netAmt) {
        for (const el of document.querySelectorAll('input')) {
          if (el.disabled || el.readOnly || el.type === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 30 || r.height < 12) continue; // skip invisible/tiny
          const v = parseFloat(el.value);
          if (!isFinite(v) || v < 0.0001 || v > 1000) continue;
          domAmt = v;
          break;
        }
      }

      const solAmtRaw = netAmt || domAmt; // user's intended spend (before slippage)

      // ── Slippage: derive from tx bytes whenever possible ───────────────
      // maxSolCost (bytes 16-23 of buy instruction, lamports) = baseCost × (1 + slip/100).
      // Dividing by the user's intended spend gives the exact slippage the wallet was
      // built with — far more reliable than scraping DOM buttons or intercepting API
      // params (pump.fun passes bondingCurveProgress as "slippage" in some calls).
      const maxSolCostFromTx = _maxSolCostFromTx(ns.pumpFunRawArgs ?? []);
      let slip;
      if (maxSolCostFromTx > 0 && solAmtRaw > 0) {
        const derived = (maxSolCostFromTx / solAmtRaw - 1) * 100;
        if (derived >= 0.1 && derived <= 100) {
          slip = derived;
        }
      }

      // DOM fallback: scan visible % buttons/inputs near the trade form.
      // Cap at 50 to exclude bonding curve progress text (often 20–99%).
      if (slip == null) {
        slip = (() => {
          try {
            const cands = Array.from(document.querySelectorAll('button, input'))
              .map(el => { const m = el.tagName === 'INPUT' ? String(el.value).match(/^(\d+(?:\.\d+)?)$/) : el.textContent?.trim().match(/^(\d+(?:\.\d+)?)\s*%$/); return m ? { el, val: parseFloat(m[1]) } : null; })
              .filter(x => x && x.val >= 0.1 && x.val <= 50);
            const act = cands.find(c =>
              /active|select|current|on/i.test(c.el.className) ||
              c.el.getAttribute('aria-pressed') === 'true' ||
              c.el.getAttribute('data-state') === 'on'
            );
            return act?.val ?? null;
          } catch (_) { return null; }
        })();
      }

      // Fallback: read slippage from pump.fun's localStorage settings.
      // pump.fun persists user-set slippage under various keys.
      if (slip == null) {
        slip = (() => {
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key) continue;
              const kl = key.toLowerCase();
              if (!kl.includes('slip')) continue;
              const raw = parseFloat(localStorage.getItem(key));
              if (!isFinite(raw) || raw <= 0) continue;
              // Fraction (e.g. 0.01 = 1%) or percentage (e.g. 1 = 1%)
              const pct = raw < 1 ? raw * 100 : raw;
              if (pct >= 0.1 && pct <= 100) return pct;
            }
          } catch (_) {}
          return null;
        })();
      }

      if (slip == null) slip = 10; // last-resort default — will be corrected by onWalletArgs
      const solAmt = solAmtRaw || (maxSolCostFromTx > 0 ? maxSolCostFromTx / (1 + slip / 100) : 0);

      // Re-run risk with actual SOL amount + real slippage for accurate scores
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      let pfRisk = ns.lastRiskResult;
      if (solAmt > 0) {
        try {
          const sp   = ns.widgetLastPriceData?.solPriceUsd ?? 80;
          const pfTx = { swapInfo: {
            inAmount: solAmt, inAmountUsd: solAmt * sp, tokenPriceUsd: sp,
            inputMint: SOL_MINT, outputMint: ns.lastOutputMint ?? null,
            inputSymbol: 'SOL', slippagePercent: slip,
          }};
          const ctx = await ns.fetchDevnetContext(pfTx).catch(() => ({ congestion: 'low' }));
          pfRisk = await ns.calculateRisk(pfTx, ctx);
          if (typeof ns.calculateMEVRisk === 'function') {
            const mev = ns.calculateMEVRisk({
              inputMint: SOL_MINT, outputMint: ns.lastOutputMint ?? null,
              amountUSD: solAmt * sp, routePlan: null,
              slippage: slip / 100, poolLiquidity: null,
            });
            if (mev) {
              pfRisk.mev = mev;
              if (mev.riskScore > pfRisk.score) {
                pfRisk.score = Math.round((pfRisk.score + mev.riskScore) / 2);
                pfRisk.level = pfRisk.score >= 70 ? 'CRITICAL' : pfRisk.score >= 40 ? 'HIGH' : pfRisk.score >= 20 ? 'MEDIUM' : 'LOW';
              }
            }
          }
          ns.lastRiskResult = pfRisk;
        } catch (_) { pfRisk = ns.lastRiskResult; }
      }

      ns.pumpFunContext = {
        outputMint:  ns.lastOutputMint ?? null,
        solAmount:   solAmt,
        slippagePct: slip,
        risk:        pfRisk ?? null,
        tokenScore:  ns.tokenScoreResult ?? null,
      };
      ns.jupiterLiveQuote    = null;
      ns.widgetCapturedTrade = null;
      ns.widgetLastOrder     = null;
      ns.widgetActiveTab     = 'monitor';
      const w = document.getElementById('sr-widget');
      if (w) {
        w.style.display = '';
        if (!w.classList.contains('expanded')) w.classList.add('expanded');
        w.classList.remove('compact', 'alert');
        ns._fitBodyHeight?.(w);
      }

      if (slip > 0.5) {
        // Slippage can be optimised — show Review & Sign and keep promise open
        ns.widgetSwapStatus       = 'pump-slippage-review';
        ns.pendingDecisionResolve = resolve;
        ns.renderWidgetPanel?.();
        return;
      }
      // Already near-optimal (≤ 0.5%) — pass through immediately
      ns.widgetSwapStatus = '';
      ns.renderWidgetPanel?.();
      resolve('confirm');
      ns.pendingDecisionPromise = null;
    },

    // ── Wallet Standard path: handle 'pump-optimise' decision ─────────────
    // origFn spreads args. Returns the tx result or undefined (fall through).
    async onDecision(decision, origFn, args) {
      if (decision !== 'pump-optimise') return undefined;
      const _ma = ns.pumpFunModifiedArgs; ns.pumpFunModifiedArgs = null;
      if (_ma) {
        window.__zendiq_own_tx = true;
        try {
          const r = await origFn(..._ma);
          window.__zendiq_own_tx = false;
          ns.widgetSwapStatus = 'pump-done';
          try { ns.renderWidgetPanel?.(); } catch (_) {}
          return r;
        } catch (e) {
          window.__zendiq_own_tx = false;
          ns.widgetSwapStatus = '';
          try { ns.renderWidgetPanel?.(); } catch (_) {}
          throw e;
        }
      }
      return undefined; // modification unavailable — caller falls through to original tx
    },

    // ── Legacy (handleTransaction) path: args are [transaction, options] ──
    async onDecisionLegacy(decision, originalMethod, transaction, options) {
      if (decision !== 'pump-optimise') return undefined;
      const _ma = ns.pumpFunModifiedArgs; ns.pumpFunModifiedArgs = null;
      if (_ma) {
        window.__zendiq_own_tx = true;
        try {
          const r = await originalMethod(_ma[0], _ma[1] ?? options);
          window.__zendiq_own_tx = false;
          ns.widgetSwapStatus = 'pump-done';
          try { ns.renderWidgetPanel?.(); } catch (_) {}
          return r;
        } catch (e) {
          window.__zendiq_own_tx = false;
          ns.widgetSwapStatus = '';
          try { ns.renderWidgetPanel?.(); } catch (_) {}
          throw e;
        }
      }
      return undefined;
    },

    // ── Widget: passive Monitor content ─────────────────────────────────
    renderMonitor() {
      if (!ns.pumpFunContext?.outputMint) return null;

      const pfc  = ns.pumpFunContext;
      const slip = pfc.slippagePct ?? 1;
      const solP = ns.widgetLastPriceData?.solPriceUsd ?? 80;
      const ts   = (ns.tokenScoreResult?.mint === pfc.outputMint && ns.tokenScoreResult?.loaded)
        ? ns.tokenScoreResult : pfc.tokenScore;
      const risk = ns.lastRiskResult ?? pfc.risk;
      const isAdv = ns.widgetMode !== 'simple';

      // Trigger async token score fetch if not yet loaded
      if (!ts?.loaded && ns._tokenScoreMint !== pfc.outputMint && ns.fetchTokenScore) {
        ns._tokenScoreMint = pfc.outputMint;
        ns.fetchTokenScore(pfc.outputMint);
      }

      // Use ns card helpers if already exposed (post first-render); fall back to inline
      const _buildTs = ns._buildTokenRiskCard;
      const _buildEr = ns._buildExecutionRiskCard;

      const slipLv    = slip > 3 ? 'CRITICAL' : slip > 1 ? 'HIGH' : slip > 0.5 ? 'MEDIUM' : 'LOW';
      const slipC     = _clr(slipLv);
      const fmt       = v => v < 0.0001 ? v.toFixed(6) : v < 0.01 ? v.toFixed(4) : v.toFixed(3);
      const fmtU      = v => v < 0.001 ? `~$${v.toFixed(4)}` : v < 0.01 ? `~$${v.toFixed(3)}` : `~$${v.toFixed(2)}`;
      const botWin    = pfc.solAmount > 0 ? pfc.solAmount * (slip / 100) : null;
      const botWinU   = botWin != null ? botWin * solP : null;
      const savSol    = (botWin != null && slip > 0.5) ? (botWin - pfc.solAmount * 0.005) : null;
      const savUsd    = savSol != null ? savSol * solP : null;
      const mevR      = risk?.mev ?? null;
      const slipBadge = isAdv ? `${slip.toFixed(1)}% \u00b7 ${slipLv}` : _rl(slipLv);

      const slipCard = `<div style="background:${slipC}11;border:1px solid ${slipC}44;border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help"
        title="Slippage is the max price deviation you accept. On pump.fun\u2019s bonding curve, bots can sandwich your buy up to your full slippage tolerance.&#10;0\u20130.5%: LOW | 0.5\u20131%: MEDIUM | 1\u20133%: HIGH | &gt;3%: CRITICAL">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px${isAdv ? ';margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06)' : ''}">
          <span style="color:${slipC};font-weight:600">Slippage Risk</span>
          <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${slipC}">${slipBadge}</span>
        </div>
        ${isAdv ? `
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="color:#9B9BAD;cursor:help" title="The maximum bots can front-run from this trade at your current slippage tolerance.">Bot attack window</span>
          <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${slipLv !== 'LOW' ? slipC : '#14F195'}">${botWin != null ? `${fmt(botWin)} SOL${botWinU != null ? ` (${fmtU(botWinU)})` : ''}` : '\u2014'}</span>
        </div>
        ${savSol != null && savSol > 0.000001 ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="color:#9B9BAD;cursor:help" title="Reducing to 0.5% cuts the bot window to the minimum viable level.">Save with 0.5% slippage</span>
          <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#14F195">~${fmt(savSol)} SOL${savUsd != null ? ` (${fmtU(savUsd)})` : ''}</span>
        </div>` : ''}
        ${mevR ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="color:#9B9BAD">Bot risk score</span>
          <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${_clr(mevR.riskLevel)}">${isAdv ? `${mevR.riskLevel} \u00b7 ${mevR.riskScore}/100` : _rl(mevR.riskLevel)}</span>
        </div>` : ''}
        <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#C2C2D4;line-height:1.5">
          ${slip > 0.5 ? '\u2699 Lower slippage in pump.fun settings before buying to reduce bot exposure' : '\u2713 Slippage near-optimal \u2014 bot attack window is minimal'}
        </div>` : ''}
      </div>`;

      const tsHtml = _buildTs ? _buildTs(ts, !isAdv) : `<div style="background:#FFB54711;border:1px solid #FFB54744;border-radius:10px;padding:10px 12px;margin-bottom:10px"><span style="font-size:13px;color:#FFB547;font-weight:600">Token Risk Score</span><span style="float:right;font-size:12px;font-family:'Space Mono',monospace;color:#FFB547">${ts?.loaded ? `${ts.level} \u00b7 ${ts.score}/100` : 'Scanning\u2026'}</span></div>`;
      const erHtml = _buildEr ? _buildEr(risk, !isAdv) : '';
      const amtRow = pfc.solAmount > 0
        ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="color:#9B9BAD">Buying with</span>
            <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#E8E8F0">${pfc.solAmount.toFixed(4)} SOL</span>
          </div>` : '';

      return `<div id="sr-monitor-scroll" style="flex:1;min-height:0;overflow-y:auto;padding:14px 16px 12px;">
        <div style="margin-bottom:10px;padding:7px 10px;background:rgba(153,69,255,0.06);border:1px solid rgba(153,69,255,0.15);border-radius:8px">
          <div style="font-size:12px;color:#9945FF;font-weight:600">pump.fun bonding curve</div>
          <div style="font-size:12px;color:#9B9BAD;margin-top:2px">ZendIQ routing not available \u2014 lower slippage in pump.fun settings to cut bot exposure.</div>
        </div>
        ${amtRow}${slipCard}${tsHtml}${erHtml}
      </div>`;
    },

    // ── Widget: flow content dispatcher ──────────────────────────────────
    renderFlow() {
      if (ns.widgetSwapStatus === 'pump-slippage-review' && ns.pumpFunContext) return this._renderReview();
      if (ns.widgetSwapStatus === 'pump-signing')  return this._renderSigning();
      if (ns.widgetSwapStatus === 'pump-done')     return this._renderDone();
      return null;
    },

    _renderReview() {
      // Card helpers are exposed on ns after the first renderWidgetPanel call.
      // When this is called they are always available (renderWidgetPanel runs first).
      const _buildOrder  = ns._buildOrderCard        ?? ((r) => '');
      const _buildTs     = ns._buildTokenRiskCard     ?? (() => '');
      const _buildEr     = ns._buildExecutionRiskCard ?? (() => '');
      const _buildCosts  = ns._buildSavingsCostsCard  ?? (() => '');
      const _buildShell  = ns._buildReviewShell       ?? ((c, n, p, s) => c);
      const clr          = ns._rClr ?? _clr;

      const pfc    = ns.pumpFunContext;
      const slip   = pfc.slippagePct ?? 1;
      const solP   = ns.widgetLastPriceData?.solPriceUsd ?? 80;
      const pfRisk = ns.lastRiskResult ?? pfc.risk;
      const pfTs   = (ns.tokenScoreResult?.mint === pfc.outputMint && ns.tokenScoreResult?.loaded)
        ? ns.tokenScoreResult : pfc.tokenScore;
      const isSimp = ns.widgetMode === 'simple';

      const slipLv  = slip > 3 ? 'CRITICAL' : slip > 1 ? 'HIGH' : slip > 0.5 ? 'MEDIUM' : 'LOW';
      const slipC   = clr(slipLv);
      const fmt     = v => v < 0.0001 ? v.toFixed(6) : v < 0.01 ? v.toFixed(4) : v.toFixed(3);
      const fmtU    = v => v < 0.001 ? `~$${v.toFixed(4)}` : v < 0.01 ? `~$${v.toFixed(3)}` : `~$${v.toFixed(2)}`;
      const origExp = pfc.solAmount > 0 ? pfc.solAmount * slip / 100 : null;
      const optExp  = pfc.solAmount > 0 ? pfc.solAmount * 0.005 : null;
      const savSol  = (origExp != null && optExp != null) ? Math.max(0, origExp - optExp) : null;
      const savUsd  = savSol != null ? savSol * solP : null;
      const mevR    = pfRisk?.mev ?? null;

      const orderRows = [
        ...(pfc.solAmount > 0 ? [{ label: 'Spending', value: `${pfc.solAmount.toFixed(4)} SOL`, tooltip: 'The amount of SOL you are spending on this bonding curve buy.' }] : []),
        { label: 'Your slippage',      value: `${slip.toFixed(1)}%`, valueColor: slipC,   tooltip: 'The slippage tolerance set in pump.fun. Bots can profitably sandwich your buy up to this amount.' },
        { label: 'ZendIQ optimised to', value: '0.5%',                valueColor: '#14F195', tooltip: 'ZendIQ patches maxSolCost in your transaction bytes to enforce 0.5% tolerance \u2014 no new transaction is created.' },
        { label: 'Route',              value: 'pump.fun bonding curve', valueColor: '#C2C2D4', tooltip: 'ZendIQ modifies only the maxSolCost field inside the transaction. Buy amount is unchanged.' },
      ];

      // Slippage Risk card — custom (pump-specific sub-rows)
      const slipBadge2 = isSimp ? _rl(slipLv) : `${slipLv} \u00b7 ${slip.toFixed(1)}% slippage`;
      const slipRowsAdv = isSimp ? '' : [
        { label: 'Bot attack window', value: origExp != null ? `~${fmt(origExp)} SOL${savUsd != null ? ` (${fmtU(origExp * solP)})` : ''}` : '\u2014', color: origExp != null && origExp > 0.001 ? slipC : '#14F195', tip: `Maximum SOL bots could extract at your ${slip.toFixed(1)}% tolerance.` },
        { label: 'At 0.5% (ZendIQ)',  value: optExp  != null ? `~${fmt(optExp)} SOL` : '\u2014', color: '#14F195', tip: 'With 0.5% slippage the bot window shrinks to this.' },
        ...(mevR ? [{ label: 'Bot risk score', value: `${mevR.riskLevel} \u00b7 ${mevR.riskScore}/100`, color: clr(mevR.riskLevel), tip: '' }] : []),
      ].map(r =>
        `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px${r.tip ? ';cursor:help' : ''}" ${r.tip ? `title="${r.tip}"` : ''}>` +
        `<span style="color:#9B9BAD">${r.label}</span>` +
        `<span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${r.color}">${r.value}</span></div>`
      ).join('');
      const slipCard = `<div style="background:${slipC}11;border:1px solid ${slipC}44;border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help"
        title="Slippage tolerance = the max value bots can extract via sandwich attack on your buy.&#10;&#10;0\u20130.5%: LOW | 0.5\u20131%: MEDIUM | 1\u20133%: HIGH | &gt;3%: CRITICAL">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px${slipRowsAdv ? ';margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06)' : ''}">
          <span style="color:${slipC};font-weight:600">Slippage Risk</span>
          <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${slipC}">${slipBadge2}</span>
        </div>${slipRowsAdv}
      </div>`;

      const costsRows = [
        { label: 'Bot protection savings', value: savSol != null && savSol > 0.000001 ? `~${fmt(savSol)} SOL (${fmtU(savUsd)})` : '\u2014', valueColor: savSol != null && savSol > 0.000001 ? '#14F195' : '#9B9BAD', tooltip: `Maximum SOL bots can no longer extract once slippage is reduced from ${slip.toFixed(1)}% to 0.5%.` },
        { label: 'ZendIQ Fee', value: 'FREE \u00b7 Beta', valueColor: '#14F195', tooltip: 'ZendIQ charges no fee for slippage optimisation. No new transaction \u2014 just a byte patch.' },
      ];

      return _buildShell(
        _buildOrder(orderRows) + _buildTs(pfTs, isSimp) + slipCard + _buildEr(pfRisk, isSimp) + _buildCosts(costsRows, 1),
        'ZendIQ patches <code style="color:#9945FF;font-size:9px">maxSolCost</code> only. Buy amount stays the same. If the price moves &gt;0.5% before your tx lands it reverts safely \u2014 retry immediately.',
        { id: 'sr-btn-pump-optimise', label: '\u2736 Sign at 0.5% slippage' },
        [
          { id: 'sr-btn-pump-proceed', label: `\u21a9 Proceed at ${slip.toFixed(1)}% (original)`, tooltip: `Proceed with your original ${slip.toFixed(1)}% slippage \u2014 ZendIQ will not modify the transaction` },
          { id: 'sr-btn-pump-cancel',  label: '\u2715 Cancel', tooltip: 'Cancel this swap entirely. Nothing will be sent to your wallet \u2014 click Buy again to retry.' },
        ]
      );
    },

    _renderSigning() {
      const pfc = ns.pumpFunContext ?? {};
      return `<div style="padding:14px 16px;text-align:center">
        <div style="font-size:12px;font-weight:700;color:#FFB547;margin-bottom:8px">\u23f3 Approve in wallet\u2026</div>
        <div style="font-size:13px;color:#C2C2D4;margin-bottom:4px">Optimised slippage: <span style="color:#14F195;font-weight:700">0.5%</span></div>
        ${(pfc.solAmount ?? 0) > 0 ? `<div style="font-size:12px;color:#9B9BAD;margin-bottom:8px">Spending: ${Number(pfc.solAmount).toFixed(4)} SOL</div>` : ''}
        <div style="font-size:12px;color:#14F195">ZendIQ reduced your sandwich exposure</div>
      </div>`;
    },

    _renderDone() {
      return `<div style="padding:14px 16px;text-align:center">
        <div style="font-size:13px;font-weight:700;color:#14F195;margin-bottom:4px">Swap Sent \u2713</div>
        <div style="font-size:12px;color:#C2C2D4;margin-bottom:14px">Signed at 0.5% slippage \u2014 bot window minimised</div>
        <button id="sr-btn-widget-new" style="width:100%;padding:10px;border:1px solid rgba(20,241,149,0.3);border-radius:8px;background:rgba(20,241,149,0.08);color:#14F195;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">+ New Swap</button>
      </div>`;
    },

    // ── Widget: button click handler ─────────────────────────────────────
    onButtonClick(id) {
      if (id === 'sr-btn-pump-cancel') {
        ns.widgetSwapStatus = '';
        ns.pumpFunContext   = null;
        ns.pumpFunRawArgs   = null;
        const w = document.getElementById('sr-widget');
        if (w) { w.classList.remove('expanded', 'alert'); w.style.display = 'none'; }
        if (ns.pendingDecisionResolve) {
          const res = ns.pendingDecisionResolve;
          ns.pendingDecisionResolve = null;
          ns.pendingDecisionPromise = null;
          res('cancel');
        }
        return true;
      }
      if (id === 'sr-btn-pump-optimise') {
        // The tx has not been built yet at click time — pump.fun builds it after
        // we re-fire the button. Set a flag so onWalletArgs modifies it in-place
        // when the real tx arrives, then resolve 'confirm' so the interceptor
        // re-fires the buy button.
        ns.pumpFunWantOptimise = true;
        ns.widgetSwapStatus    = 'pump-signing';
        ns.renderWidgetPanel?.();
        if (ns.pendingDecisionResolve) {
          const res = ns.pendingDecisionResolve;
          ns.pendingDecisionResolve = null;
          ns.pendingDecisionPromise = null;
          res('confirm'); // interceptor re-fires btn → pump builds tx → onWalletArgs patches it
        }
        return true;
      }
      if (id === 'sr-btn-pump-proceed') {
        ns.widgetSwapStatus = '';
        if (ns.pendingDecisionResolve) {
          const res = ns.pendingDecisionResolve;
          ns.pendingDecisionResolve = null;
          ns.pendingDecisionPromise = null;
          res('confirm');
        }
        ns.renderWidgetPanel?.();
        return true;
      }
      return false;
    },

    // ── Widget: post-render hook (auto-dismiss pump-done after 3s) ────────
    onAfterRender() {
      if (ns.widgetSwapStatus === 'pump-done') {
        setTimeout(() => {
          if (ns.widgetSwapStatus === 'pump-done') {
            ns.widgetSwapStatus = '';
            ns.pumpFunContext    = null;
            ns.renderWidgetPanel?.();
          }
        }, 3000);
      }
    },
  });

  // Also expose the tx modifier directly on ns for any legacy callers
  ns._modifyPumpFunTx = _modifyPumpFunTx;
})();
