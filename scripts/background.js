/**
 * ZendIQ – background.js v0.2.1
 * Service worker handles ALL external fetches.
 * Popup cannot fetch cross-origin in MV3 — everything routes through here.
 */

// Allowed origins for FETCH_JSON to prevent SSRF
const FETCH_JSON_ALLOWED = [
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
  'https://pumpportal.fun',
];

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

  // ── Push onboarded flag to jup.ag tabs (popup dismissed → widget hides card) ─
  if (msg.type === 'PUSH_ONBOARDED') {
    chrome.tabs.query({ url: '*://*.jup.ag/*' }, (tabs) => {
      if (tabs?.length) {
        tabs.forEach(t => chrome.tabs.sendMessage(
          t.id,
          { type: 'PUSH_ONBOARDED' },
          () => void chrome.runtime.lastError
        ));
      }
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
    fetch(msg.url, fetchOpts)
      .then(async r => {
        if (!r.ok) {
          const status = r.status;
          if (status !== 400 && status !== 404 && status !== 429 && status !== 502 && status !== 503 && status !== 530) console.error('[SR bg] FETCH_JSON error: HTTP', status, msg.url);
          sendResponse({ ok: false, error: 'HTTP ' + status, status });
          return;
        }
        const data = await r.json();
        sendResponse({ ok: true, data });
      })
      .catch(err => {
        console.error('[SR bg] FETCH_JSON fetch error:', err.message);
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
          // 429/503 = rate-limit/overload (expected)
          const _isSilent = status === 429 || status === 503;
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
      .catch(() => sendResponse({ ok: false, error: 'All RPC endpoints failed' }));
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
            const _dexUrls = ['*://*.jup.ag/*', '*://*.raydium.io/*', '*://raydium.io/*', '*://*.pump.fun/*', '*://pump.fun/*'];
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

