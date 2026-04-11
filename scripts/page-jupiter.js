/**
 * ZendIQ – page-jupiter.js
 * Jupiter (jup.ag) site adapter.
 * Registers with ns.registerSiteAdapter() to provide Jupiter-specific idle
 * Monitor content and URL-based token score head-start.
 * The full optimisation flow (approval → fetchWidgetQuote → signing) is the
 * shared default — this adapter does NOT implement onSwapDetected.
 * Must load in MAIN world BEFORE page-interceptor.js.
 */

(function () {
  'use strict';
  const ns = window.__zq;
  if (!ns?.registerSiteAdapter) return;

  const KNOWN = {
    'SOL':  'So11111111111111111111111111111111111111112',
    'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'JUP':  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'WIF':  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    'RAY':  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  };

  // ── Resolve a token symbol or raw mint to a mint address ─────────────────
  function _resolveMint(s) {
    if (!s) return null;
    if (s.length >= 32) return s;
    return KNOWN[s.toUpperCase()] ?? null;
  }

  // ── Read outputMint from URL ─────────────────────────────────────────────
  function _outputMintFromUrl() {
    try {
      const u     = new URL(window.location.href);
      const byQ   = _resolveMint(u.searchParams.get('buy') ?? u.searchParams.get('outputMint'));
      if (byQ) return byQ;
      const path  = window.location.pathname.match(/\/swap\/[A-Za-z0-9]+-([A-Za-z0-9]+)/);
      if (path) return _resolveMint(path[1]);
    } catch (_) {}
    return null;
  }

  ns.registerSiteAdapter({
    name: 'jupiter',

    matches() {
      const h = window.location.hostname;
      return h === 'jup.ag' || h.endsWith('.jup.ag');
    },

    // Jupiter uses the shared optimisation flow states — no custom busy states.
    busyStates: [],

    // ── URL parsing: pre-fetch token score for the output token ─────────────
    initPage() {
      const outM = _outputMintFromUrl();
      if (outM && ns.fetchTokenScore && outM !== ns._tokenScoreMint) {
        ns._tokenScoreMint  = outM;
        ns.tokenScoreResult = null;
        Promise.resolve().then(() => ns.fetchTokenScore(outM, null));
      }
    },

    // ── Network hook: no-op (page-network.js handles Jupiter ticks) ──────────
    onNetworkRequest(_url, _parsed) {},

    // ── Wallet hook: no-op (Jupiter tx args are handled by the shared flow) ──
    onWalletArgs(_args) {},

    // ── No onSwapDetected: falls through to shared jup.ag optimisation flow ──

    // ── Monitor tab idle content ─────────────────────────────────────────────
    renderMonitor() {
      // When a trade is in-flight the generic monitor renders it — only provide
      // idle content when there is no live data yet.
      if (ns.jupiterLiveQuote || ns.widgetCapturedTrade) return null;

      const outM     = ns.lastOutputMint ?? null;  // only show when real network activity has set this
      const ts       = (outM && ns.tokenScoreResult?.loaded && ns.tokenScoreResult?.mint === outM)
                         ? ns.tokenScoreResult : null;
      const tsColor  = ts?.level === 'CRITICAL' ? '#FF4444'
                     : ts?.level === 'HIGH'     ? '#FF6B00'
                     : ts?.level === 'MEDIUM'   ? '#FFB547' : '#14F195';

      return `
        <div style="padding:14px 16px">
          <div style="font-size:12px;color:#9B9BAD;text-align:center;padding:12px 0;line-height:1.6">
            Monitoring active.<br>
            <a href="https://jup.ag" target="_blank" rel="noopener"
               style="color:#14F195;font-weight:600;text-decoration:none">Swap on jup.ag</a>
            to see risk analysis here.
          </div>
          ${ts ? `
          <div style="display:flex;justify-content:space-between;align-items:center;
                      background:rgba(255,255,255,0.04);border-radius:8px;padding:8px 10px">
            <span style="font-size:13px;color:#C2C2D4">Token Risk</span>
            <span style="font-size:13px;font-weight:700;color:${tsColor}">${ts.level} &middot; ${ts.score}/100</span>
          </div>` : outM ? `
          <div style="font-size:12px;color:#9B9BAD;text-align:center;padding:4px 0">
            Scanning token risk&hellip;
          </div>` : ''}
        </div>`;
    },
  });
})();
