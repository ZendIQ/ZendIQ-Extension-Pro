/**
 * ZendIQ – background.js v0.2.1
 * Service worker handles ALL external fetches.
 * Popup cannot fetch cross-origin in MV3 — everything routes through here.
 */

// Analytics backend — Pro extension telemetry (anonymous aggregate events only)
const PRO_BACKEND_URL = 'https://zendiq-backend.onrender.com';

// ── Anonymous install identifier ────────────────────────────────────────────
// UUID generated once per browser profile; injected into every analytics POST.
const _PRO_IID_KEY  = 'sendiq_pro_install_id';
let   _cachedProIid = null;
async function _getProInstallId() {
  if (_cachedProIid) return _cachedProIid;
  return new Promise(resolve => {
    chrome.storage.local.get([_PRO_IID_KEY], r => {
      if (r[_PRO_IID_KEY]) { _cachedProIid = r[_PRO_IID_KEY]; return resolve(r[_PRO_IID_KEY]); }
      const id = crypto.randomUUID();
      chrome.storage.local.set({ [_PRO_IID_KEY]: id }, () => { _cachedProIid = id; resolve(id); });
    });
  });
}

// ── Telemetry send reliability ───────────────────────────────────────
// OPS-169. fetch() only rejects on network failure, so an HTTP 403/400 resolves
// normally — the previous `.catch(() => {})` discarded every server-side rejection
// without either end noticing. That is how a structured-ingest path can return zero
// rows for months while looking healthy.
//
// Two surfaces, deliberately:
//   1. a local ring buffer, for live debugging in the service-worker console;
//   2. `prior_failures` attached to the next SUCCESSFUL send, so the server learns
//      about an outage on recovery even if nobody ever opens that console.
// (1) alone would recreate the original defect one level up: an unread failure log
// is as silent as a swallowed 4xx.
const _PRO_FAIL_KEY = 'sendiq_pro_telemetry_failures';
const _PRO_FAIL_MAX = 20;

function _recordProSendFailure(status, type, detail) {
  try {
    chrome.storage.local.get([_PRO_FAIL_KEY], (r) => {
      const arr = Array.isArray(r?.[_PRO_FAIL_KEY]) ? r[_PRO_FAIL_KEY] : [];
      arr.push({ t: Date.now(), status, type, detail: String(detail ?? '').slice(0, 200) });
      chrome.storage.local.set({ [_PRO_FAIL_KEY]: arr.slice(-_PRO_FAIL_MAX) });
    });
  } catch (_) {}
}

// Summarise buffered failures so they can ride along on the next request.
function _peekProFailures() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([_PRO_FAIL_KEY], (r) => {
        const arr = Array.isArray(r?.[_PRO_FAIL_KEY]) ? r[_PRO_FAIL_KEY] : [];
        if (!arr.length) return resolve(null);
        resolve({
          reported: arr.length,
          summary: {
            count:       arr.length,
            oldest_ts:   arr[0].t,
            last_status: arr[arr.length - 1].status,
          },
        });
      });
    } catch (_) { resolve(null); }
  });
}

// Drop only the entries we actually reported — failures logged while the reporting
// request was in flight must survive.
function _clearReportedProFailures(n) {
  try {
    chrome.storage.local.get([_PRO_FAIL_KEY], (r) => {
      const arr = Array.isArray(r?.[_PRO_FAIL_KEY]) ? r[_PRO_FAIL_KEY] : [];
      chrome.storage.local.set({ [_PRO_FAIL_KEY]: arr.slice(n) });
    });
  } catch (_) {}
}

// Single exit point for every analytics POST. Never throws; always resolves.
async function _postProEvent(payload) {
  const pending = await _peekProFailures();
  try {
    const r = await fetch(PRO_BACKEND_URL + '/api/events', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(pending ? { ...payload, prior_failures: pending.summary } : payload),
    });
    if (r.ok) {
      if (pending) _clearReportedProFailures(pending.reported);
      return;
    }
    let detail = '';
    try { detail = (await r.text()).slice(0, 200); } catch (_) {}
    console.warn('[ZendIQ] telemetry rejected', r.status, payload?.type, detail);
    _recordProSendFailure(r.status, payload?.type, detail);
  } catch (err) {
    const m = err?.message ?? String(err);
    console.warn('[ZendIQ] telemetry send failed', payload?.type, m);
    _recordProSendFailure(0, payload?.type, m);
  }
}

// Allowed origins for FETCH_JSON to prevent SSRF
const FETCH_JSON_ALLOWED = [
  PRO_BACKEND_URL,   // https://zendiq-backend.onrender.com (shared)
  'https://api.jup.ag',
  'https://lite-api.jup.ag',
  'https://ultra-api.jup.ag',
  'https://api.mainnet-beta.solana.com',
  'https://solana.publicnode.com',
  'https://api.rugcheck.xyz',
  'https://api.dexscreener.com',
  'https://api.geckoterminal.com',
  'https://transaction-v1.raydium.io',
  'https://api-v3.raydium.io',
  'https://frontend-api.pump.fun',
  'https://frontend-api-v2.pump.fun',
  'https://frontend-api-v3.pump.fun',
  'https://mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
  'https://london.mainnet.block-engine.jito.wtf',
  'https://dublin.mainnet.block-engine.jito.wtf',
  'https://slc.mainnet.block-engine.jito.wtf',
  'https://singapore.mainnet.block-engine.jito.wtf',
  'https://bundles.jito.wtf',
  'https://pumpportal.fun',
  'https://api.binance.com',
];

// ── SOL price — fetched on SW startup and refreshed every 5 min ─────────────
// Background SW can fetch cross-origin freely (no CORS restrictions apply here).
async function _fetchAndCacheSolPrice() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    if (!r.ok) return;
    const d = await r.json();
    const price = parseFloat(d.price);
    if (!price || price <= 0 || price > 100_000) return;
    chrome.storage.local.set({ sendiq_sol_price: price });
    // Broadcast to all open DEX tabs so page scripts update ns.solPriceUsd immediately
    const _DEX_URLS = [
      '*://*.jup.ag/*', '*://*.raydium.io/*', '*://raydium.io/*',
      '*://pump.fun/*', '*://*.pump.fun/*',
    ];
    _DEX_URLS.forEach(pattern => {
      chrome.tabs.query({ url: pattern }, (tabs) => {
        if (tabs?.length) tabs.forEach(t =>
          chrome.tabs.sendMessage(t.id, { type: 'PUSH_SOL_PRICE', price }, () => void chrome.runtime.lastError)
        );
      });
    });
  } catch (_) {}
}

// Fetch immediately on every SW startup (covers install, update, and SW wakeup cycles)
_fetchAndCacheSolPrice();
// Alarm persists across SW hibernation — wakes the SW and re-fetches every 5 min
chrome.alarms.create('zq-sol-price',   { periodInMinutes: 5    });
// Keepalive: Chrome MV3 service workers sleep after ~30s of inactivity.
// axiom.trade has low message traffic so the SW goes cold between token navigations,
// causing all token-score fetches to time out waiting for the SW to wake up.
// A 0.4-min (24s) alarm is the minimum Chrome allows and keeps latency under ~1s.
chrome.alarms.create('zq-sw-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'zq-sol-price') _fetchAndCacheSolPrice();
  // zq-sw-keepalive: secondary keepalive via alarms (belt-and-suspenders)
});

// ── Persistent port keepalive ─────────────────────────────────────────────────
// Content scripts open a 'zq-keepalive' port at document_start (bridge.js).
// Accepting it here prevents Chrome from killing the SW while any DEX tab is open.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'zq-keepalive') return;
  // No-op handler — just accepting the port is enough to extend SW lifetime.
  // The port's heartbeat messages ('zq-ping') are intentionally ignored.
  port.onDisconnect.addListener(() => void chrome.runtime.lastError);
});

// ── Extension lifecycle events ───────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  const ua      = navigator.userAgent;
  const locale  = navigator.language ?? '';
  const country = locale.includes('-') ? locale.split('-').pop() : locale.toUpperCase();
  const os      = ua.includes('Windows') ? 'windows' : ua.includes('Mac OS X') ? 'mac' : ua.includes('Linux') ? 'linux' : 'other';
  const browser = ua.includes('Brave') ? 'brave' : 'chrome';
  _getProInstallId().then(install_id => _postProEvent({
    type:       'extension_installed',
    category:   'install',
    source:     'pro',
    install_id,
    data: {
      reason:       details.reason,
      prev_version: details.previousVersion ?? null,
      browser, os, locale: locale.slice(0, 10),
      country: (typeof country === 'string' && country.length === 2) ? country : null,
    },
    v: chrome.runtime.getManifest().version,
  }));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Ping ──────────────────────────────────────────────────────────────────
  if (msg.type === 'PING') {
    sendResponse({ ok: true, data: 'pong' });
    return true;
  }

  // ── ZendIQ: open popup after trade captured ────────────────────────────
  if (msg.type === 'OPEN_OPTIMISE_POPUP') {
    // Trade already saved to storage by content_bridge
    // Just open the popup — it will read from storage on load
    try {
      chrome.action.openPopup();
    } catch (e) {
      // openPopup() only works if extension has focus — fail silently
      // User will see the captured trade next time they open the popup
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── Push onboarded flag to all DEX tabs (popup dismissed → widget hides card) ─
  if (msg.type === 'PUSH_ONBOARDED') {
    const DEX_URLS = [
      '*://*.jup.ag/*',
      '*://*.raydium.io/*',
      '*://raydium.io/*',
      '*://pump.fun/*',
      '*://*.pump.fun/*',
    ];
    DEX_URLS.forEach(pattern => {
      chrome.tabs.query({ url: pattern }, (tabs) => {
        if (tabs?.length) {
          tabs.forEach(t => chrome.tabs.sendMessage(
            t.id,
            { type: 'PUSH_ONBOARDED' },
            () => void chrome.runtime.lastError
          ));
        }
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  // ── Push security scan result to all DEX tabs (popup scan → widget update) ─
  if (msg.type === 'PUSH_SEC_RESULT') {
    const r = msg.result;
    if (r && typeof r === 'object') {
      const DEX_URLS = [
        '*://*.jup.ag/*',
        '*://*.raydium.io/*',
        '*://raydium.io/*',
        '*://pump.fun/*',
        '*://*.pump.fun/*',
      ];
      DEX_URLS.forEach(pattern => {
        chrome.tabs.query({ url: pattern }, (tabs) => {
          if (tabs?.length) {
            tabs.forEach(t => chrome.tabs.sendMessage(
              t.id,
              { type: 'PUSH_SEC_RESULT', result: r, reviewed: !!msg.reviewed },
              () => void chrome.runtime.lastError
            ));
          }
        });
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── Generic JSON GET ──────────────────────────────────────────────────────
  if (msg.type === 'FETCH_JSON') {
    let parsedUrl;
    try { parsedUrl = new URL(msg.url); } catch { sendResponse({ ok: false, error: 'Invalid URL' }); return true; }
    const allowed = FETCH_JSON_ALLOWED.some(o => parsedUrl.origin === o);
    if (!allowed) { sendResponse({ ok: false, error: 'URL not in allowlist' }); return true; }
    const fetchOpts = msg.headers ? { headers: msg.headers } : {};
    // 9 s hard cap — prevents a slow/unresponsive external API from leaving the
    // background handler pending (which would cause the caller's timeout to fire
    // and leave the chrome.runtime channel open until the SW eventually dies).
    fetch(msg.url, { ...fetchOpts, signal: AbortSignal.timeout(9000) })
      .then(async r => {
        if (!r.ok) {
          const status = r.status;
          if (status !== 400 && status !== 404 && status !== 429 && status !== 502 && status !== 503 && status !== 530) console.error('[SR bg] FETCH_JSON error: HTTP', status, msg.url);
          sendResponse({ ok: false, error: 'HTTP ' + status, status });
          return;
        }
        // r.json() throws SyntaxError when the body is empty or truncated (HTTP 200
        // with no body). Handle it inline so it doesn't reach the outer .catch().
        let data;
        try { data = await r.json(); } catch (_) { sendResponse({ ok: false, error: 'empty response' }); return; }
        sendResponse({ ok: true, data });
      })
      .catch(err => {
        // Only genuine network errors (timeout, DNS, connection reset) land here.
        if (!err?.message?.includes('context')) console.error('[SR bg] FETCH_JSON fetch error:', err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async response
  }

  // ── Generic JSON POST ─────────────────────────────────────────────────────
  if (msg.type === 'FETCH_JSON_POST') {
    let parsedUrl;
    try { parsedUrl = new URL(msg.url); } catch { sendResponse({ ok: false, error: 'Invalid URL' }); return true; }
    const allowedPost = FETCH_JSON_ALLOWED.some(o => parsedUrl.origin === o);
    if (!allowedPost) { sendResponse({ ok: false, error: 'URL not in allowlist' }); return true; }
    fetch(msg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body ?? {}),
    })
      .then(async r => {
        if (!r.ok) {
          const status = r.status;
          // 429/503 = rate-limit/overload (expected); 400 from Jito = bundle rejected (expected)
          const _isSilent = status === 429 || status === 503 || (status === 400 && msg.url.includes('jito.wtf'));
          if (!_isSilent) console.error('[SR bg] FETCH_JSON_POST error: HTTP', status, msg.url);
          sendResponse({ ok: false, error: 'HTTP ' + status, status });
          return;
        }
        const data = await r.json();
        sendResponse({ ok: true, data });
      })
      .catch(err => {
        console.error('[SR bg] FETCH_JSON_POST fetch error:', err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async response
  }

  // ── RPC call ──────────────────────────────────────────────────────────────
  if (msg.type === 'FETCH_BYTES_POST') {
    // Fetch a URL and return the response body as base64 (for binary responses like pump.fun tx).
    const allowed = FETCH_JSON_ALLOWED.some(o => { try { return new URL(msg.url).origin === o; } catch(_) { return false; } });
    if (!allowed) { sendResponse({ ok: false, error: 'URL not in allowlist: ' + msg.url }); return true; }
    fetch(msg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...( msg.headers ?? {}) },
      body: msg.body,
    })
      .then(async r => {
        if (!r.ok) { sendResponse({ ok: false, error: 'HTTP ' + r.status }); return; }
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // Convert to base64 for postMessage transport
        let b64 = '';
        for (let i = 0; i < bytes.length; i += 8192)
          b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
        sendResponse({ ok: true, data: btoa(b64) });
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'RPC_CALL') {
    // Race all endpoints with a 10 s timeout each; first success wins.
    // Sequential fallback only runs when all parallel attempts fail.
    const _rpcEndpoints = [
      'https://solana.publicnode.com',
      'https://rpc.ankr.com/solana',
      'https://solana.drpc.org',
      'https://api.mainnet-beta.solana.com',
    ];
    const _body = JSON.stringify({ jsonrpc:'2.0', id:1, method: msg.method, params: msg.params ?? [] });
    const _fetchOne = (url) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 12_000); // 12 s per endpoint
      return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: _body, signal: ac.signal })
        .then(r => { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => { if (data?.error) throw new Error(data.error.message ?? 'RPC error'); clearTimeout(timer); return data; })
        .catch(e => { clearTimeout(timer); throw e; });
    };
    // Try all endpoints in parallel; settle for first success.
    Promise.any(_rpcEndpoints.map(_fetchOne))
      .then(data => sendResponse({ ok: true, data }))
      .catch((agg) => {
        // Surface the actual per-endpoint errors so callers can diagnose
        // sendTransaction rejections (e.g. "Transaction simulation failed: …").
        const errs = (agg?.errors || []).map(e => e?.message || String(e));
        const detail = errs.length ? errs.join(' | ') : (agg?.message || 'unknown');
        sendResponse({ ok: false, error: 'All RPC endpoints failed: ' + detail });
      });
    return true;
  }

  if (msg.type === 'RPC_BATCH') {
    // Send multiple Solana JSON-RPC methods in a single HTTP batch request.
    // Reduces publicnode load from N simultaneous calls to 1, preventing 429s
    // when getAccountInfo + getTokenLargestAccounts + getTokenSupply fire together.
    const _batchEndpoints = [
      'https://solana.publicnode.com',
      'https://api.mainnet-beta.solana.com',
    ];
    const _batchBody = JSON.stringify(
      msg.calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params ?? [] }))
    );
    const _tryBatch = async (url) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: _batchBody,
        signal: AbortSignal.timeout(12_000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const arr = await r.json();
      if (!Array.isArray(arr)) throw new Error('non-array batch response');
      return arr;
    };
    (async () => {
      for (const url of _batchEndpoints) {
        try {
          const arr = await _tryBatch(url);
          // Map batch response array back to call-index order
          const indexed = {};
          arr.forEach(item => { indexed[item.id] = item; });
          sendResponse({ ok: true, results: msg.calls.map((_, i) => indexed[i] ?? null) });
          return;
        } catch (_) {}
      }
      sendResponse({ ok: false, error: 'All batch RPC endpoints failed' });
    })();
    return true;
  }

  // ── Jito bundleOnly submit — returns x-bundle-id header (not CORS-exposed from page) ──
  if (msg.type === 'JITO_SUBMIT') {
    const JITO_EPS = [
      'https://amsterdam.mainnet.block-engine.jito.wtf',
      'https://frankfurt.mainnet.block-engine.jito.wtf',
      'https://london.mainnet.block-engine.jito.wtf',
      'https://dublin.mainnet.block-engine.jito.wtf',
      'https://ny.mainnet.block-engine.jito.wtf',
      'https://slc.mainnet.block-engine.jito.wtf',
      'https://singapore.mainnet.block-engine.jito.wtf',
      'https://tokyo.mainnet.block-engine.jito.wtf',
    ];
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'sendTransaction',
      params: [msg.signedTxB64, { encoding: 'base64' }],
    });
    const tryOne = async (base) => {
      const r = await fetch(base + '/api/v1/transactions?bundleOnly=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(8000),
      });
      const d = await r.json();
      const bundleId = r.headers.get('x-bundle-id') ?? null;
      if (d?.result) return { sig: d.result, bundleId, endpoint: base };
      throw new Error(JSON.stringify(d?.error ?? 'no result'));
    };
    Promise.any(JITO_EPS.map(tryOne))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── Storage helpers ───────────────────────────────────────────────────────
  if (msg.type === 'SAVE_ANALYSIS') {
    chrome.storage.local.set({ lastAnalysis: { ...msg.data, savedAt: Date.now() } });
    sendResponse({ ok: true });
    return true;
  }

  // ── Provide persisted history to page widget on request ───────────────────
  if (msg.type === 'GET_HISTORY') {
    chrome.storage.local.get(['sendiq_swap_history'], ({ sendiq_swap_history: hist = [] }) => {
      try {
        // Respond directly to the tab that requested history (works for all supported DEX sites)
        const _send = (id, m) => chrome.tabs.sendMessage(id, m, () => { void chrome.runtime.lastError; });
        const payload = Array.isArray(hist) ? hist : [];
        if (sender.tab?.id) {
          _send(sender.tab.id, { type: 'HISTORY_RESPONSE', payload });
        }
      } catch (e) { console.warn('[SR bg] GET_HISTORY forward failed', e); }
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Anonymous telemetry — fire-and-forget POST to Pro analytics backend ──────────
  if (msg.type === 'LOG_PRO_EVENT') {
    const eventType = String(msg.eventType ?? '').slice(0, 40);
    const data      = (msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data)) ? msg.data : {};
    const v         = typeof msg.v === 'string' ? msg.v : '';
    const category  = typeof msg.category === 'string' ? msg.category : null;
    const _doPost   = (install_id) => _postProEvent({
      type: eventType, source: 'pro', install_id, data, v,
      ...(category ? { category } : {}),
    });
    // daily_active: deduplicate — only post once per calendar day
    if (eventType === 'daily_active') {
      const today = (data.day ?? new Date().toISOString().slice(0, 10));
      chrome.storage.local.get(['sendiq_pro_last_active_day'], (result) => {
        if (result.sendiq_pro_last_active_day !== today) {
          chrome.storage.local.set({ sendiq_pro_last_active_day: today }, () => {
            _getProInstallId().then(_doPost);
          });
        }
      });
    } else {
      _getProInstallId().then(_doPost);
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── History update from popup — forward to content scripts so widget can update ─
  if (msg.type === 'HISTORY_UPDATE') {
    try {
      // Persist into chrome.storage.local history — merge if same signature already exists
      chrome.storage.local.get(['sendiq_swap_history'], ({ sendiq_swap_history: hist = [] }) => {
        try {
          hist = Array.isArray(hist) ? hist : [];
          const sig = msg.payload?.signature;
          const existingIdx = sig ? hist.findIndex(h => h.signature === sig) : -1;
          if (existingIdx >= 0) {
            // Merge enrichment update (e.g. quoteAccuracy) into existing entry
            hist[existingIdx] = Object.assign({}, hist[existingIdx], msg.payload);
          } else {
            hist.unshift(msg.payload);
            if (hist.length > 200) hist = hist.slice(0, 200);
          }
          chrome.storage.local.set({ sendiq_swap_history: hist }, () => {
            // After persisting, forward update to all supported DEX tabs so their widget can refresh
            const _send2 = (id, m) => chrome.tabs.sendMessage(id, m, () => { void chrome.runtime.lastError; });
            const _dexUrls = ['*://*.jup.ag/*', '*://*.raydium.io/*', '*://raydium.io/*', '*://*.pump.fun/*', '*://pump.fun/*', '*://*.axiom.trade/*', '*://axiom.trade/*'];
            _dexUrls.forEach(pattern => {
              chrome.tabs.query({ url: pattern }, (tabs) => {
                if (tabs && tabs.length) tabs.forEach(t => _send2(t.id, msg));
              });
            });
          });
        } catch (e) { console.warn('[SR bg] HISTORY persist failed', e); }
      });
    } catch (e) {}
    sendResponse({ ok: true });
    return true;
  }
});

