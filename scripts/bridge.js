/**
 * ZendIQ — content_bridge.js
 * Runs in ISOLATED world. Bridges MAIN world ↔ chrome.runtime (background).
 */
// Stamp the manifest version onto the DOM immediately so MAIN world page scripts
// can read it. Both worlds share the same document, making this the simplest
// cross-world data transfer at document_start — no messaging needed.
try { document.documentElement.dataset.zendiqVersion = chrome.runtime.getManifest().version; } catch (_) {}
try { document.documentElement.dataset.zendiqIcon = chrome.runtime.getURL('assets/icon-48.png'); } catch (_) {}

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
          pauseOnHighRisk: s.pauseOnHighRisk !== false,  // default true
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
      chrome.storage.local.get(['settings'], ({ settings: existing = {} }) => {
        chrome.storage.local.set({ settings: { ...existing, ...p } });
      });
    } catch (err) {
      console.warn('[ZendIQ][bridge] ZENDIQ_SAVE_SETTINGS failed', err?.message);
    }
    return;
  }

  // ZendIQ: save captured trade + open popup
  if (e.data.type === 'OPTIROUTE_SAVE_CAPTURED_TRADE') {
    try {
      const p = e.data.payload;
      // Validate required fields before storage to prevent crafted payloads
      // from auto-filling the swap form with arbitrary mints/amounts.
      if (!p || typeof p !== 'object' ||
          typeof p.inputMint  !== 'string' ||
          typeof p.outputMint !== 'string' ||
          typeof p.amountUI   !== 'number' ||
          !['CRITICAL','HIGH','MEDIUM','LOW','UNKNOWN'].includes(p.riskLevel)) {
        console.warn('[ZendIQ][bridge] OPTIROUTE_SAVE_CAPTURED_TRADE: invalid payload, dropping');
        return;
      }
      chrome.storage.local.set({
        sendiq_captured_trade: p,
      });

      // Tell background to focus/open the popup
      chrome.runtime.sendMessage({
        type:    'OPEN_OPTIMISE_POPUP',
        payload: p,
      });
    } catch (err) {
      console.warn('[ZendIQ][bridge] Captured trade save failed:', err?.message);
    }
    return;
  }
});

