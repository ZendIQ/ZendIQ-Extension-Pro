/**
 * ZendIQ Pro — page-analytics.js
 * MAIN world module. Provides ns.logProEvent(type, data) for backward-compat
 * usage and new category-specific helpers that route to structured DB tables.
 *
 * Privacy: no PII. Wallet addresses hashed (SHA-256, first 12 hex chars).
 * All events routed via bridge.js → background.js → shared backend.
 * background.js injects install_id into every outbound payload.
 */
(function () {
  'use strict';

  const ns = window.__zq;
  if (!ns) return;

  const _pyVer  = document.documentElement.dataset.zendiqVersion ?? '';
  // An unrecognised host must fall through to 'unknown', never to jup.ag: the old
  // default silently folded every new surface into the jup.ag baseline, and a
  // mislabelled event returns 200, so nothing downstream ever flags it.
  const _daHost = window.location.hostname;
  const _daSite = _daHost.includes('raydium') ? 'raydium.io'
                : _daHost.includes('pump')    ? 'pump.fun'
                : _daHost.includes('axiom')   ? 'axiom.trade'
                : _daHost.includes('jup.ag')  ? 'jup.ag'
                : 'unknown';

  // ── Internal send helper ──────────────────────────────────────────────────
  // category = null  → legacy events table (backward compat for existing callsites)
  // category = value → structured tables (installs/heartbeats/sessions/trades/mev/errors/funnel)
  function _send(category, type, data) {
    try {
      window.postMessage({
        sr_bridge_to_ext: true,
        msg: {
          type:      'LOG_PRO_EVENT',
          category:  category ?? undefined,
          eventType: type,
          data:      data ?? {},
          v:         _pyVer,
        },
      }, '*');
    } catch (_) {}
  }

  // ── Backward-compat public API ────────────────────────────────────────────
  function logProEvent(type, data) { _send(null, type, data); }
  ns.logProEvent = logProEvent;

  // ── Category-specific helpers ─────────────────────────────────────────────
  ns.logTrade   = (data)        => _send('trade',   data.user_action ?? 'trade', data);
  ns.logSession = (type, data)  => _send('session', type, data);
  ns.logFunnel  = (event, data) => _send('funnel',  event, { event, ...(data ?? {}) });
  ns.logMev      = (data)        => _send('mev',      'mev_detection', data);
  ns.logError    = (cat, data)   => _send('error',    cat, data);
  // Dynamic slippage telemetry — fires per trade when dynamicSlippageMode !== 'off'.
  // Fields: user_slip_bps, tightened_bps, token_class, price_impact_bps,
  //         shadow_mode, override_applied, active, outcome ('landed'|'reverted'|'overridden'), ts, trade_size_usd?
  ns.logDynSlip  = (data)        => _send('slippage', 'dyn_slip', data);

  // ── Wallet hash helper ────────────────────────────────────────────────────
  // SHA-256 of an address, first 12 hex chars (48 bits).
  //
  // This is a DEDUP TOKEN, NOT ANONYMISATION. The hash is unsalted and the input space
  // (Solana addresses) is public and fully enumerable, so anyone holding a candidate list
  // can hash it and match the prefix. Treat the output as pseudonymous at best, and as
  // equivalent to the address itself whenever the plausible candidate set is small —
  // which is exactly the case for known MEV bots.
  //
  // Consequence: safe for server-side dedup and distinct counts; NEVER safe to publish
  // on a public endpoint or to attribute behaviour to a specific actor. See OPS-178 and
  // the guard comment in backend/src/api/routes.js (/stats/pro, mev_summary).
  async function _hashAddr(addr) {
    if (!addr || typeof addr !== 'string') return null;
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(addr));
      return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
    } catch { return null; }
  }

  // Called from page-wallet.js after a wallet successfully hooks.
  // Caches wallet hash on ns so trade events can reference it.
  // Guard: only fires session:start once per page load — resolveWalletPubkey() is called
  // on every Jupiter tick (~1/s) and can trigger hookWsWallet via patchCustomEvent fallback,
  // which would flood the backend with session:start events.
  ns.setWalletForSession = async function (walletAddr, walletName) {
    if (ns._sessionLogged) return;
    ns._sessionLogged = true;
    ns.walletHash    = await _hashAddr(walletAddr);
    ns.walletAdapter = walletName;
    try {
      ns.logSession('start', {
        type:        'start',
        wallet:      walletName ?? 'unknown',
        wallet_hash: ns.walletHash ?? null,
        dex:         _daSite,
      });
    } catch (_) {}
  };

  // Expose hash helper so page-wallet.js can hash attacker addresses for logMev
  ns.hashAddr = _hashAddr;

  // ── daily_active ping ─────────────────────────────────────────────────────
  // Fires once per page load; background.js deduplicates per calendar day.
  // Sends category:'heartbeat' so the new heartbeats table is populated.
  _send('heartbeat', 'daily_active', { day: new Date().toISOString().slice(0, 10), site: _daSite });
})();
