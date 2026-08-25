/**
 * ZendIQ — content_bridge.js
 * Runs in ISOLATED world. Bridges MAIN world ↔ chrome.runtime (background).
 */
// Stamp the manifest version onto the DOM immediately so MAIN world page scripts
// can read it. Both worlds share the same document, making this the simplest
// cross-world data transfer at document_start — no messaging needed.
try { document.documentElement.dataset.zendiqVersion = chrome.runtime.getManifest().version; } catch (_) {}
try { document.documentElement.dataset.zendiqIcon = chrome.runtime.getURL('assets/icon-48.png'); } catch (_) {}

// ── SW keepalive: persistent port ────────────────────────────────────────────
// Chrome MV3 service workers sleep after ~30 s of inactivity. On axiom.trade
// there is no background message traffic (no Jupiter live ticks), so the SW is
// almost always cold when token scoring fires — causing 3–4 s cold-start delays
// that eat the entire timeout budget.
//
// An open chrome.runtime.connect() port counts as activity and keeps the SW
// alive for the port's entire lifetime (this tab's session). bridge.js loads at
// document_start so the SW wakes immediately when the page opens — well before
// the user can navigate to a token and trigger fetchTokenScore.
//
// A 20 s heartbeat message guards against Chrome silently dropping idle ports.
// On disconnect (extension reload / SW restart) we reconnect after 1 s.
;(function _swKeepalive() {
  let _port = null;
  function _connect() {
    try {
      _port = chrome.runtime.connect({ name: 'zq-keepalive' });
      _port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; // consume the error so Chrome doesn't log it
        _port = null;
        setTimeout(_connect, 1000);   // reconnect once SW has restarted
      });
    } catch (_) {}
  }
  _connect();
  // Heartbeat: keeps the port (and therefore the SW) alive during long idle periods.
  setInterval(() => { try { _port?.postMessage({ type: 'zq-ping' }); } catch (_) {} }, 20_000);
})();

// ── background → page ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // PUSH_SEC_RESULT: relay as plain ZENDIQ_SEC_RESULT_RESPONSE (interceptor's first
  // window listener expects no sr_bridge wrapper — same format as ZENDIQ_GET_SEC_RESULT reply)
  if (msg?.type === 'PUSH_SEC_RESULT') {
    try { window.postMessage({ type: 'ZENDIQ_SEC_RESULT_RESPONSE', result: msg.result, reviewed: !!msg.reviewed }, '*'); } catch (_) {}
    return;
  }
  // PUSH_ONBOARDED: popup dismissed welcome card — tell widget to hide its card too
  if (msg?.type === 'PUSH_ONBOARDED') {
    try { window.postMessage({ type: 'ZENDIQ_ONBOARDED_RESPONSE', value: true }, '*'); } catch (_) {}
    return;
  }
  // Background refreshed SOL price — relay to MAIN world so ns.solPriceUsd stays current
  if (msg?.type === 'PUSH_SOL_PRICE') {
    try { window.postMessage({ type: 'ZENDIQ_SOL_PRICE_UPDATE', price: msg.price }, '*'); } catch (_) {}
    return;
  }
  try {
    window.postMessage({ sr_bridge: true, msg }, '*');
  } catch (e) {
    if (!e?.message?.includes('context')) console.warn('[ZendIQ][bridge] postMessage failed', e?.message);
  }
});

// ── page → background ─────────────────────────────────────────────────────────
window.addEventListener('message', (e) => {
  if (!e.data) return;

  // RPC_CALL: routed through background to bypass jup.ag CSP (which blocks direct
  // fetch to api.mainnet-beta.solana.com from the MAIN world content script).
  // Uses a correlation _id so the async response can be matched back to the caller.
  if (e.data.sr_bridge_to_ext && e.data.msg?.type === 'FETCH_PAGE_JSON') {
    const { url, _id, headers } = e.data.msg;
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_JSON', url, headers }, (res) => {
        if (chrome.runtime.lastError) {
          if (!chrome.runtime.lastError.message?.includes('context'))
            console.warn('[ZendIQ][bridge] FETCH_PAGE_JSON bg error', chrome.runtime.lastError.message);
          return;
        }
        try { window.postMessage({ sr_bridge: true, msg: { type: 'FETCH_PAGE_JSON_RESPONSE', _id, result: res } }, '*'); } catch (_) {}
      });
    } catch (err) {
      if (!err?.message?.includes('context')) console.warn('[ZendIQ][bridge] FETCH_PAGE_JSON error', err?.message);
    }
    return;
  }

  if (e.data.sr_bridge_to_ext && e.data.msg?.type === 'FETCH_PAGE_JSON_POST') {
    const { url, body, _id } = e.data.msg;
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_JSON_POST', url, body }, (res) => {
        if (chrome.runtime.lastError) {
          if (!chrome.runtime.lastError.message?.includes('context'))
            console.warn('[ZendIQ][bridge] FETCH_PAGE_JSON_POST bg error', chrome.runtime.lastError.message);
          return;
        }
        try { window.postMessage({ sr_bridge: true, msg: { type: 'FETCH_PAGE_JSON_RESPONSE', _id, result: res } }, '*'); } catch (_) {}
      });
    } catch (err) {
      if (!err?.message?.includes('context')) console.warn('[ZendIQ][bridge] FETCH_PAGE_JSON_POST error', err?.message);
    }
    return;
  }

  if (e.data.sr_bridge_to_ext && e.data.msg?.type === 'FETCH_BYTES_POST') {
    const { url, body, _id } = e.data.msg;
    try {
      chrome.runtime.sendMessage({ type: 'FETCH_BYTES_POST', url, body }, (res) => {
        if (chrome.runtime.lastError) {
          if (!chrome.runtime.lastError.message?.includes('context'))
            console.warn('[ZendIQ][bridge] FETCH_BYTES_POST bg error', chrome.runtime.lastError.message);
          return;
        }
        try { window.postMessage({ sr_bridge: true, msg: { type: 'FETCH_BYTES_POST_RESPONSE', _id, result: res } }, '*'); } catch (_) {}
      });
    } catch (err) {
      if (!err?.message?.includes('context')) console.warn('[ZendIQ][bridge] FETCH_BYTES_POST error', err?.message);
    }
    return;
  }

  if (e.data.sr_bridge_to_ext && e.data.msg?.type === 'AXIOM_LOCK') {
    const { op, owner, _id } = e.data.msg;
    // Unlike the forwarders above this one answers on every path. The caller gates
    // a third-party mutation on the reply, so an unanswered request and a refusal
    // must not look alike: silence would only be distinguished by its timeout.
    const reply = (result) => {
      try { window.postMessage({ sr_bridge: true, msg: { type: 'AXIOM_LOCK_RESPONSE', _id, result } }, '*'); } catch (_) {}
    };
    try {
      chrome.runtime.sendMessage({ type: 'AXIOM_LOCK', op, owner }, (res) => {
        if (chrome.runtime.lastError) {
          if (!chrome.runtime.lastError.message?.includes('context'))
            console.warn('[ZendIQ][bridge] AXIOM_LOCK bg error', chrome.runtime.lastError.message);
          return reply({ ok: false, error: 'bridge' });
        }
        reply(res ?? { ok: false, error: 'empty' });
      });
    } catch (err) {
      if (!err?.message?.includes('context')) console.warn('[ZendIQ][bridge] AXIOM_LOCK error', err?.message);
      reply({ ok: false, error: 'bridge' });
    }
    return;
  }

  if (e.data.sr_bridge_to_ext && e.data.msg?.type === 'RPC_CALL') {
    const { method, params, _id } = e.data.msg;
    try {
      chrome.runtime.sendMessage({ type: 'RPC_CALL', method, params }, (res) => {
        if (chrome.runtime.lastError) {
          if (!chrome.runtime.lastError.message?.includes('context'))
            console.warn('[ZendIQ][bridge] RPC_CALL bg error', chrome.runtime.lastError.message);
          return;
        }
        try { window.postMessage({ sr_bridge: true, msg: { type: 'RPC_RESPONSE', _id, result: res } }, '*'); } catch (_) {}
      });
    } catch (err) {
      if (!err?.message?.includes('context')) console.warn('[ZendIQ][bridge] RPC_CALL error', err?.message);
    }
    return;
  }

  // RPC_BATCH: batch multiple Solana RPC methods in a single HTTP request to avoid rate-limiting
  if (e.data.sr_bridge_to_ext && e.data.msg?.type === 'RPC_BATCH') {
    const { calls, _id } = e.data.msg;
    try {
      chrome.runtime.sendMessage({ type: 'RPC_BATCH', calls }, (res) => {
        if (chrome.runtime.lastError) {
          if (!chrome.runtime.lastError.message?.includes('context'))
            console.warn('[ZendIQ][bridge] RPC_BATCH bg error', chrome.runtime.lastError.message);
          return;
        }
        try { window.postMessage({ sr_bridge: true, msg: { type: 'RPC_BATCH_RESPONSE', _id, result: res } }, '*'); } catch (_) {}
      });
    } catch (err) {
      if (!err?.message?.includes('context')) console.warn('[ZendIQ][bridge] RPC_BATCH error', err?.message);
    }
    return;
  }

  // JITO_SUBMIT: route through background so x-bundle-id response header is readable
  if (e.data.sr_bridge_to_ext && e.data.msg?.type === 'JITO_SUBMIT') {
    const { signedTxB64, _id } = e.data.msg;
    try {
      chrome.runtime.sendMessage({ type: 'JITO_SUBMIT', signedTxB64 }, (res) => {
        if (chrome.runtime.lastError) {
          if (!chrome.runtime.lastError.message?.includes('context'))
            console.warn('[ZendIQ][bridge] JITO_SUBMIT bg error', chrome.runtime.lastError.message);
          return;
        }
        try { window.postMessage({ sr_bridge: true, msg: { type: 'JITO_SUBMIT_RESPONSE', _id, result: res } }, '*'); } catch (_) {}
      });
    } catch (err) {
      if (!err?.message?.includes('context')) console.warn('[ZendIQ][bridge] JITO_SUBMIT error', err?.message);
    }
    return;
  }

  // Legacy bridge messages — only forward whitelisted types
  if (e.data.sr_bridge_to_ext) {
    const ALLOWED_FROM_PAGE = new Set(['GET_HISTORY', 'HISTORY_UPDATE', 'LOG_PRO_EVENT']);
    if (!e.data.msg || !ALLOWED_FROM_PAGE.has(e.data.msg.type)) return;
    try {
      chrome.runtime.sendMessage(e.data.msg);
    } catch (err) {
      // 'Extension context invalidated' fires when the extension is reloaded while
      // the page is still open — the content script is orphaned and chrome.runtime
      // becomes unavailable. This is expected and harmless; silently ignore it.
      if (!err?.message?.includes('context')) console.warn('[ZendIQ][bridge] sendMessage failed', err?.message);
    }
    return;
  }

  // ZendIQ: cache wallet pubkey from MAIN world so popup can read it as fallback
  // when executeScript fails (e.g. pump.fun homepage before coin loads).
  if (e.data.type === 'ZENDIQ_SAVE_WALLET_PUBKEY') {
    const pk = String(e.data.pubkey ?? '').replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (pk.length >= 32 && pk.length <= 44) chrome.storage.local.set({ sendiq_wallet_pubkey: pk });
    return;
  }

  // ZendIQ: request persisted settings from storage (called by MAIN world at startup)
  if (e.data.type === 'ZENDIQ_GET_SETTINGS') {
    chrome.storage.local.get(['settings'], ({ settings: s = {} }) => {
      window.postMessage({
        type:     'ZENDIQ_SETTINGS_RESPONSE',
        settings: {
          minRiskLevel:    s.minRiskLevel    ?? 'LOW',
          minLossUsd:      s.minLossUsd      ?? 0,
          minSlippage:     s.minSlippage     ?? 0,
          uiMode:          s.uiMode          ?? 'simple',
          autoProtect:     s.autoProtect     ?? false,
          autoAccept:      s.autoAccept      ?? false,
          jitoMode:        s.jitoMode        ?? 'auto',
          profile:         s.profile         ?? 'alert',
          pauseOnHighRisk:        s.pauseOnHighRisk !== false,  // default true
          dynamicSlippageMode: s.dynamicSlippageMode ?? 'shadow',
          axiomOptimize:   s.axiomOptimize ?? null,   // null = never answered the consent prompt
        },
      }, '*');
    });
    return;
  }

  // ZendIQ: load / set onboarded flag (shared key with popup — sendiq_onboarded)
  if (e.data.type === 'ZENDIQ_GET_ONBOARDED') {
    chrome.storage.local.get(['sendiq_onboarded'], ({ sendiq_onboarded }) => {
      try { window.postMessage({ type: 'ZENDIQ_ONBOARDED_RESPONSE', value: !!sendiq_onboarded }, '*'); } catch (_) {}
    });
    return;
  }
  if (e.data.type === 'ZENDIQ_SET_ONBOARDED') {
    chrome.storage.local.set({ sendiq_onboarded: true });
    return;
  }

  // ZendIQ: first DEX page visit — auto-expand widget once, then never again
  if (e.data.type === 'ZENDIQ_GET_FIRST_DEX_VISIT') {
    chrome.storage.local.get(['sendiq_firstDexVisitCompleted'], ({ sendiq_firstDexVisitCompleted }) => {
      try { window.postMessage({ type: 'ZENDIQ_FIRST_DEX_VISIT_RESPONSE', completed: !!sendiq_firstDexVisitCompleted }, '*'); } catch (_) {}
    });
    return;
  }
  if (e.data.type === 'ZENDIQ_SET_FIRST_DEX_VISIT') {
    chrome.storage.local.set({ sendiq_firstDexVisitCompleted: true });
    return;
  }

  // ZendIQ: seed ns.solPriceUsd from cached storage value on page load
  if (e.data.type === 'ZENDIQ_GET_SOL_PRICE') {
    chrome.storage.local.get(['sendiq_sol_price'], (r) => {
      try { window.postMessage({ type: 'ZENDIQ_SOL_PRICE_RESPONSE', price: r.sendiq_sol_price ?? null }, '*'); } catch (_) {}
    });
    return;
  }

  // ZendIQ: request background to open the extension popup (from widget)
  if (e.data.type === 'ZENDIQ_OPEN_POPUP') {
    // Record which tab the popup should open to (Wallet/Security tab)
    chrome.storage.local.set({ sendiq_pending_tab: e.data.tab || 'security' });
    try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIMISE_POPUP' }, () => {}); } catch (_) {}
    return;
  }

  // ZendIQ: persist widget scan result under the same key the popup uses
  if (e.data.type === 'ZENDIQ_SAVE_SEC_RESULT') {
    const r = e.data.result;
    if (r && typeof r === 'object') chrome.storage.local.set({ secLastResult: r });
    return;
  }

  // ZendIQ: load persisted scan result (shared with popup — same secLastResult key)
  if (e.data.type === 'ZENDIQ_GET_SEC_RESULT') {
    chrome.storage.local.get(['secLastResult'], ({ secLastResult }) => {
      if (!secLastResult) return;
      const wt = secLastResult.walletType ?? 'unknown';
      const reviewedKey = `secReviewed_${wt}`;
      chrome.storage.local.get([reviewedKey], (data) => {
        try { window.postMessage({ type: 'ZENDIQ_SEC_RESULT_RESPONSE', result: secLastResult, reviewed: !!data[reviewedKey] }, '*'); } catch (_) {}
      });
    });
    return;
  }

  // ZendIQ: read whether the user has reviewed auto-approve for a given wallet type
  if (e.data.type === 'ZENDIQ_GET_SEC_REVIEWED') {
    const wt = String(e.data.walletType ?? '').replace(/[^a-z]/g, '');
    if (!wt) return;
    chrome.storage.local.get([`secReviewed_${wt}`], (result) => {
      try { window.postMessage({ type: 'ZENDIQ_SEC_REVIEWED_RESPONSE', walletType: wt, value: !!result[`secReviewed_${wt}`] }, '*'); } catch (_) {}
    });
    return;
  }

  // ZendIQ: persist "I've reviewed auto-approve settings" toggle for a given wallet type
  if (e.data.type === 'ZENDIQ_SET_SEC_REVIEWED') {
    const wt = String(e.data.walletType ?? '').replace(/[^a-z]/g, '');
    if (!wt) return;
    chrome.storage.local.set({ [`secReviewed_${wt}`]: !!e.data.value });
    return;
  }

  // ZendIQ (OPS-181): persist the outstanding Axiom settings-restore obligation.
  // Written before the mutating POST so a crash mid-trade still leaves a record.
  // A null obligation clears it — only sent once both surfaces verify as restored.
  if (e.data.type === 'ZENDIQ_SAVE_AXIOM_OBLIGATION') {
    const tok = typeof e.data.token === 'string' && /^[A-Za-z0-9]{1,40}$/.test(e.data.token) ? e.data.token : null;
    // Every exit answers, rejections included. The caller blocks a third-party
    // mutation on this reply, and fail-closed must not also mean fail-slow — a
    // silent reject would cost it the full timeout for an answer known instantly.
    const ack = (ok, why) => {
      if (!tok) return;
      try { window.postMessage({ type: 'ZENDIQ_AXIOM_OBLIGATION_SAVED', token: tok, ok: ok, why: why ?? null }, '*'); } catch (_) {}
    };
    const raw = e.data.obligation;
    if (raw == null) { chrome.storage.local.remove('sendiq_axiom_obligation', () => ack(!chrome.runtime.lastError, 'clear')); return; }
    if (typeof raw !== 'object' || raw.v !== 1) return ack(false, 'shape');
    if (typeof raw.presetKey !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(raw.presetKey)) return ack(false, 'presetKey');
    if (!raw.fields || typeof raw.fields !== 'object') return ack(false, 'fields');
    const okVal = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
    const clean = (src) => {
      const out = {};
      if (!src || typeof src !== 'object') return out;
      for (const k of Object.keys(src)) {
        if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
        const f = src[k];
        if (!f || typeof f !== 'object' || !('from' in f) || !('to' in f)) continue;
        if (!okVal(f.from) || !okVal(f.to)) continue;
        out[k] = { from: f.from, to: f.to };
      }
      return out;
    };
    const fields = clean(raw.fields);
    const serverFields = clean(raw.serverFields);
    if (!Object.keys(fields).length && !Object.keys(serverFields).length) return ack(false, 'fields-empty');
    chrome.storage.local.set({
      sendiq_axiom_obligation: {
        v: 1,
        createdAt: Number(raw.createdAt) || Date.now(),
        host: typeof raw.host === 'string' && /^api\d*\.axiom\.trade$/.test(raw.host) ? raw.host : null,
        presetKey: raw.presetKey,
        fields,
        serverFields,
        localRestored:  !!raw.localRestored,
        serverRestored: !!raw.serverRestored,
        attempts: Math.min(Number(raw.attempts) || 0, 999),
      },
    }, () => {
      const err = chrome.runtime.lastError;
      // A discarded failure here is an untracked third-party mutation, which is
      // the defect OPS-181 exists to prevent — never swallow it silently.
      if (err) console.warn('[ZendIQ][bridge] obligation persist failed', err.message);
      ack(!err, err ? 'set' : null);
    });
    return;
  }

  // ZendIQ (OPS-181): load the outstanding obligation on page start
  if (e.data.type === 'ZENDIQ_GET_AXIOM_OBLIGATION') {
    const tok = typeof e.data.token === 'string' && /^[A-Za-z0-9]{1,40}$/.test(e.data.token) ? e.data.token : null;
    chrome.storage.local.get(['sendiq_axiom_obligation'], ({ sendiq_axiom_obligation }) => {
      // The mutate path blocks on this answer, so a storage failure has to be
      // reported rather than returned as an empty record: "cannot tell" and
      // "nothing outstanding" lead to opposite decisions about mutating.
      const err = chrome.runtime.lastError;
      if (err) console.warn('[ZendIQ][bridge] obligation read failed', err.message);
      try {
        window.postMessage({
          type: 'ZENDIQ_AXIOM_OBLIGATION_RESPONSE',
          obligation: err ? null : (sendiq_axiom_obligation ?? null),
          ok: !err,
          token: tok,
        }, '*');
      } catch (_) {}
    });
    return;
  }

  // ZendIQ: save updated settings from widget panel
  if (e.data.type === 'ZENDIQ_SAVE_SETTINGS') {
    try {
      const raw = e.data.payload ?? {};
      // Validate: only allow known keys with expected types/ranges — prevents storage poisoning
      const VALID_JITO    = new Set(['always', 'auto', 'never']);
      const VALID_PROFILE = new Set(['alert', 'balanced', 'focused', 'custom']);
      const VALID_RLEVEL  = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
      const VALID_UIMODE  = new Set(['simple', 'advanced']);
      const p = {};
      if (typeof raw.jitoMode     === 'string' && VALID_JITO.has(raw.jitoMode))       p.jitoMode     = raw.jitoMode;
      if (typeof raw.profile      === 'string' && VALID_PROFILE.has(raw.profile))     p.profile      = raw.profile;
      if (typeof raw.autoProtect     === 'boolean')                                       p.autoProtect     = raw.autoProtect;
      if (typeof raw.autoAccept      === 'boolean')                                       p.autoAccept      = raw.autoAccept;
      if (typeof raw.pauseOnHighRisk === 'boolean')                                       p.pauseOnHighRisk = raw.pauseOnHighRisk;
      if (typeof raw.uiMode       === 'string' && VALID_UIMODE.has(raw.uiMode))       p.uiMode       = raw.uiMode;
      if (typeof raw.minRiskLevel === 'string' && VALID_RLEVEL.has(raw.minRiskLevel)) p.minRiskLevel = raw.minRiskLevel;
      if (typeof raw.minLossUsd   === 'number' && isFinite(raw.minLossUsd)   && raw.minLossUsd  >= 0) p.minLossUsd   = raw.minLossUsd;
      if (typeof raw.minSlippage  === 'number' && isFinite(raw.minSlippage)  && raw.minSlippage >= 0) p.minSlippage  = raw.minSlippage;
      const VALID_DYNSLIP = new Set(['shadow', 'active', 'off']);
      if (typeof raw.dynamicSlippageMode === 'string' && VALID_DYNSLIP.has(raw.dynamicSlippageMode)) p.dynamicSlippageMode = raw.dynamicSlippageMode;
      const VALID_AXOPT = new Set(['on', 'off']);
      if (typeof raw.axiomOptimize === 'string' && VALID_AXOPT.has(raw.axiomOptimize)) p.axiomOptimize = raw.axiomOptimize;
      chrome.storage.local.get(['settings'], ({ settings: existing = {} }) => {
        chrome.storage.local.set({ settings: { ...existing, ...p } });
      });
    } catch (err) {
      console.warn('[ZendIQ][bridge] ZENDIQ_SAVE_SETTINGS failed', err?.message);
    }
    return;
  }
});

