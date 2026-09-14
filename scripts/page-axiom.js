/**
 * ZendIQ – page-axiom.js
 * Axiom.trade verification adapter — post-settlement signal capture and token risk scoring.
 *
 * Registers a fetch + XHR observer at document_start (MAIN world) to read
 * Axiom's three post-settlement telemetry signals:
 *   • log-tx-v3                      — trade outcome, fees, MEV mode
 *   • meme-open-single-position-v2   — buy: wallet pubkey + token address
 *   • handle-position-close-v2       — sell: wallet pubkey + token address
 *
 * Caches ns.axiomSessionPubkey (wallet pubkey from position signals).
 * Triggers ns.fetchTokenScore on buy, deduped by ns._tokenScoreMint.
 *
 * Loaded independently of page-network.js (which must NOT run on axiom.trade —
 * page-network.js overrides sendTransaction and would wrongly trigger the
 * swap-intercept flow on Axiom's Helius submissions). This file installs a
 * minimal observer scoped to Axiom's telemetry endpoints only.
 *
 * Load order: page-config.js → page-utils.js → page-token-score.js → page-axiom.js.
 */

(function () {
  'use strict';

  // ── Only run on the main trading UI ─────────────────────────────────────
  // Use exact match so docs.axiom.trade / api3.axiom.trade etc. don't get
  // the fetch/XHR override installed (avoids spurious extension warnings).
  const _HOST = window.location.hostname;
  if (_HOST !== 'axiom.trade' && _HOST !== 'www.axiom.trade') return;

  const ns = window.__zq;

  // ── Local intercept state (IIFE scope) ───────────────────────────────────
  let _axiomBypassNext   = false;  // set true before re-click to bypass our own capture
  let _approvedAddr      = null;   // /meme/ address the held click belongs to; the page can move under it
  let _axiomBuyAmountSol = null;   // last SOL amount the user entered in the amount field

  // ── Live SOL price (OPS-244) ─────────────────────────────────────────────
  // ns.solPriceUsd is fed by the background alarm (Binance SOLUSDT, every 5 min)
  // and seeded from storage on load. Null until it lands — callers emit no USD
  // figure rather than one derived from a constant.
  function _solUsd() {
    const p = ns?.solPriceUsd;
    return (typeof p === 'number' && p > 0 && p < 100000) ? p : null;
  }
  // page-interceptor.js carries this wiring on the other DEXes but is not loaded here.
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'ZENDIQ_SOL_PRICE_RESPONSE' || e.data.type === 'ZENDIQ_SOL_PRICE_UPDATE') {
      if (typeof e.data.price === 'number' && e.data.price > 0) ns.solPriceUsd = e.data.price;
    }
  });
  try { window.postMessage({ type: 'ZENDIQ_GET_SOL_PRICE' }, '*'); } catch (_) {}
  // bridge.js and this file both run at document_start, so the first ask can beat
  // the listener that answers it.
  setTimeout(function () {
    if (_solUsd() == null) { try { window.postMessage({ type: 'ZENDIQ_GET_SOL_PRICE' }, '*'); } catch (_) {} }
  }, 1500);

  // ── Chain detection (OPS-243) ────────────────────────────────────────────
  // Axiom added a chain selector on 25 Aug 2026. Everything this file reads or
  // writes is Solana-specific — the preset store, the RPC we enrich from, the
  // address shapes we parse — so anything not positively identified as Solana is
  // treated as out of scope rather than assumed to be Solana.
  const _CHAIN_SOL     = 'solana';
  const _CHAIN_OTHER   = 'other';
  const _CHAIN_UNKNOWN = 'unknown';

  const _B58_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  // A Solana signature is 64 base58-encoded bytes. An EVM tx hash is 0x + 64 hex,
  // which cannot match: base58 excludes '0'.
  const _SOL_SIG_RE  = /^[1-9A-HJ-NP-Za-km-z]{80,96}$/;
  // Matched against the whole path rather than a known segment: the BNB and Base
  // token routes are not documented, and an address is self-identifying anyway.
  const _EVM_IN_PATH = /\/(0x[0-9a-fA-F]{40})(?:[/?#]|$)/;
  const _B58_IN_PATH = /\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/;

  // Verified 13 Sep 2026 against the live settings blob (314 keys): no field names
  // the active chain, and Discover carries ?chains=sol,bnb,base — a filter, not a
  // selection. Axiom also fetches get-settings for every enabled chain at once, so
  // the ?evmChain= parameter is a race between concurrent requests rather than a
  // current-chain signal. Chain is a property of the token, read from its address.
  //
  // Matched against the whole pathname rather than a known segment: the BNB and
  // Base token routes are undocumented, and an address is self-identifying.
  function _chainFromUrl() {
    const p = window.location.pathname;
    if (_EVM_IN_PATH.test(p)) return _CHAIN_OTHER;
    if (_B58_IN_PATH.test(p)) return _CHAIN_SOL;
    return null;
  }

  // Singular ?chain=sol, distinct from Discover's ?chains=sol,bnb,base filter list.
  // Ranked below the path address, which names the token actually being traded.
  function _chainFromQuery() {
    try {
      const v = new URLSearchParams(window.location.search).get('chain');
      if (!v) return null;
      return /^sol/i.test(v.trim()) ? _CHAIN_SOL : _CHAIN_OTHER;
    } catch (_) { return null; }
  }

  let _chainLogged = null;

  // OPS-250 proposed that a router transition briefly reports `unknown` on a token page.
  // Every observed `unknown` was the multi-chain Discover feed, correctly identified, so
  // the hold that used to sit here never once fired and was removed.
  function _chain() {
    const c = _chainFromUrl() ?? _chainFromQuery() ?? _CHAIN_UNKNOWN;
    if (ns) ns.axiomChain = c;
    if (c !== _chainLogged) {
      _chainLogged = c;
      console.log('[ZQ:AXIOM] chain=' + c + (c === _CHAIN_SOL ? '' : ' \u2014 observe only: no intercept, no settings write, no Solana RPC'
        + ' \u2014 url=' + window.location.pathname + window.location.search));
    }
    return c;
  }

  // Unknown counts as not-Solana everywhere a decision is made. Only positive
  // identification unlocks the intercept and the settings mutation.
  function _isSolana() { return _chain() === _CHAIN_SOL; }

  // The pill is all a collapsed widget says. "Active" on a chain we never check
  // is a coverage claim, and the explanatory card only appears once expanded.
  // Off a token page nothing is intercepted either, so the same applies there.
  // Token pages are identified by the address in the path, not by a route prefix:
  // the BNB and Base routes are undocumented and do not all live under /meme/.
  // ?chain= is the last resort — it is absent on Discover, so it cannot be mistaken
  // for one, and its plural ?chains= sibling is a filter list we deliberately ignore.
  function _pillActiveLabel() {
    const p = window.location.pathname;
    if (_EVM_IN_PATH.test(p)) return 'Solana only';
    if (_B58_IN_PATH.test(p)) return _chain() === _CHAIN_SOL ? 'Active' : 'Solana only';
    if (_chainFromQuery() === _CHAIN_OTHER) return 'Solana only';
    return 'Not checking';
  }

  // Quick-buy buttons read "Buy <amount> <ticker>" from the Quick Buy setting;
  // the token page's own button reads "Buy <symbol>". Matched on the whole shape
  // so a numeric symbol like "Buy 777" is not mistaken for an amount. Used only
  // where picking the wrong button fires an unapproved trade; the intercept stays
  // loose, because failing to match there means no check ran.
  function _isTokenBuyText(txt) {
    return txt.startsWith('buy ') && !/^buy\s+[\d.]+\s+\w+$/.test(txt);
  }

  // Bare "Sell" is the Buy/Sell tab, not a trade. Both "Sell <symbol> <amount>" and
  // the "Sell Init." quick exit are real sells and both read the sell preset.
  function _isTokenSellText(txt) {
    return txt.startsWith('sell ');
  }

  // ── Analytics session state ──────────────────────────────────────────────
  // Axiom never loads page-wallet.js, so the session lifecycle that file owns on
  // the other DEXes has to be driven from here instead.
  const _AX_SITE       = 'axiom.trade';
  const _axSessionAt   = Date.now();
  let   _axTradeCount  = 0;
  let   _axEngaged     = false;   // one widget_engaged per intercept, not per code path
  const _axLvl2Class   = function (lv) { return lv === 'LOW' ? 'safe' : lv === 'MEDIUM' ? 'caution' : lv ? 'danger' : null; };
  function _axEngage() {
    if (_axEngaged) return;
    _axEngaged = true;
    try { ns?.logFunnel?.('widget_engaged', { dex: _AX_SITE }); } catch (_) {}
  }

  // ── Axiom-only widget mode ───────────────────────────────────────────────
  // Flag pages throughout page-widget.js to hide routing UX and show risk-only
  // content. Also exposes resolveWalletPubkey so the widget can display the address.
  if (ns) {
    ns.axiomVerifyOnly = true;
    if (!ns.resolveWalletPubkey) {
      ns.resolveWalletPubkey = () => ns.axiomSessionPubkey ?? null;
    }
    // Called by page-widget.js Proceed button — re-clicks the trade button with
    // our capture listener bypassed so React's handlers fire normally.
    ns.axiomProceedTrade = function () {
      const _approvedBtn = ns.axiomPendingBtnRef;
      const _side    = ns.axiomPendingSide === 'sell' ? 'sell' : 'buy';
      const _matches = _side === 'sell' ? _isTokenSellText : _isTokenBuyText;
      ns.axiomConfirmPending = false;
      ns.axiomPendingBtnRef  = null;
      _axEngage();
      // Immediately re-render Monitor so confirm panel disappears before the
      // trade fires — prevents the panel staying up through settlement.
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      // Prefer the button the user actually approved. The scan is a fallback for
      // a React re-render and is document-order, so it could otherwise fire a
      // different token's quick-buy than the one that was scored. Only scan while
      // the page still shows the token that was approved. Compared as the raw route
      // address, since /meme/ carries a pool address for some tokens and a mint for others.
      const _sameToken = _isSolana() && _approvedAddr != null && _readMintFromUrl() === _approvedAddr;
      const btn = (_approvedBtn?.isConnected ? _approvedBtn : null)
        ?? (_sameToken
          ? Array.from(document.querySelectorAll('button')).find(function (b) {
              return _matches((b.textContent ?? '').trim().toLowerCase());
            })
          : null);
      if (!btn) {
        console.warn('[ZQ:AXIOM] approved ' + _side + ' did not fire \u2014 button no longer on the page');
        return;
      }
      // Fire the full pointer → mouse → click chain so Axiom's handler fires
      // regardless of whether they use onPointerDown, onMouseDown, or onClick.
      // _axiomBypassNext lets all three events pass through our capture listeners.
      _axiomBypassNext = true;
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, isPrimary: true }));
      btn.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true, composed: true, isPrimary: true }));
      btn.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true, composed: true }));
      btn.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true, composed: true }));
      btn.click();
    };
  }

  // ── Signal URL fragments ─────────────────────────────────────────────────
  // Three post-settlement telemetry endpoints Axiom fires after every trade.
  // See docs/axiom-integration-scoping.md §2.3 for field documentation.
  const _SIG_LOG_TX    = 'log-tx-v3';
  const _SIG_OPEN_POS  = 'meme-open-single-position-v2';
  const _SIG_CLOSE_POS = 'handle-position-close-v2';

  function _isAxiomSignal(url) {
    if (typeof url !== 'string') return false;
    return url.includes('axiom.trade') && (
      url.includes(_SIG_LOG_TX) ||
      url.includes(_SIG_OPEN_POS) ||
      url.includes(_SIG_CLOSE_POS)
    );
  }

  // ── Safe JSON parse (no page-utils.js dependency in step 1) ─────────────
  function _tryJson(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  // ── Field extractors ─────────────────────────────────────────────────────

  // log-tx-v3: full trade outcome — signature, preset (fees, MEV mode), provider.
  // Primary post-trade anchor for sandwich detection and Activity recording.
  function _extractLogTx(raw) {
    const b = _tryJson(raw);
    if (!b) return null;
    const log = Array.isArray(b.logs) ? b.logs[0] : null;
    if (!log) return null;
    const p = log.preset ?? {};
    return {
      type:           'log-tx-v3',
      signature:      log.signature              ?? null,
      success:        log.success                ?? null,
      timeTakenMs:    log.timeTakenMs            ?? null,
      provider:       log.provider               ?? null,
      region:         log.region                 ?? null,
      slippage:       p.slippage                 ?? null,
      priorityFeeSol: p.priorityFeeSol           ?? null,
      bribeFeeSol:    p.bribeFeeSol              ?? null,
      mevProtection:  p.mevProtection            ?? null,
      enhancedMev:    p.enhancedMevProtection    ?? null,
    };
  }

  // meme-open-single-position-v2: new buy position.
  // walletAddress is the session wallet pubkey — cache on first signal received.
  // handle-position-close-v2: sell / position close.
  function _extractPosition(raw, type) {
    const b = _tryJson(raw);
    if (!b) return null;
    return {
      type,
      walletAddress: Array.isArray(b.walletAddresses) ? (b.walletAddresses[0] ?? null) : null,
      tokenAddress:  b.tokenAddress ?? null,
      subOrgId:      b.subOrgId     ?? null,
    };
  }

  // ── Pubkey + position state helpers ─────────────────────────────────────

  // Regex for Solana pubkeys: 32–44 base58 chars (no 0, O, I, l).
  const _PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // Centralised pubkey setter — update-if-changed, logs every transition.
  // Replaces the old first-write-wins guard so multi-wallet switches are tracked.
  function _setPubkey(pubkey, source) {
    if (!pubkey || !ns) return;
    if (pubkey === ns.axiomSessionPubkey) return;
    if (ns.axiomSessionPubkey) {
      console.log('[ZQ:AXIOM] wallet switch (' + source + '):', ns.axiomSessionPubkey.slice(0, 8) + '…', '→', pubkey.slice(0, 8) + '…');
    }
    ns.axiomSessionPubkey = pubkey;    // Update the pill status — same 'Active' label as Jupiter once wallet is known.
    try { ns.setWalletForSession?.(pubkey, 'axiom'); } catch (_) {}
    try { ns.updateWidgetStatus?.(_pillActiveLabel()); } catch (_) {}  }

  // Recursively find a Solana pubkey in a parsed JSON object.
  // Only follows object keys that semantically relate to a wallet to reduce
  // false positives (token addresses share the same base58 shape).
  const _WALLET_KEY_RE = /wallet|pubkey|address|account|public|owner/i;
  function _deepFindPubkey(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth ?? 0) > 4) return null;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && _WALLET_KEY_RE.test(k) && _PUBKEY_RE.test(v.trim())) return v.trim();
      if (v && typeof v === 'object') {
        const found = _deepFindPubkey(v, (depth ?? 0) + 1);
        if (found) return found;
      }
    }
    return null;
  }

  // Typed read of Axiom's own wallet list, which lives in the localStorage 'settings'
  // object (H.12: that object is Axiom's source of truth). Read by field name rather than
  // via _deepFindPubkey — the same blob holds token mints, which share the base58 shape and
  // would resolve as a wallet. 'settings' is also not matched by _STORE_KEY_RE below.
  function _readFromAxiomSettings() {
    try {
      const raw = localStorage.getItem('settings');
      if (!raw) return null;
      const list = JSON.parse(raw)?.solWalletsAndGroups;
      if (!Array.isArray(list)) return null;
      // Entries are wallets or groups, so filter on type rather than taking [0]. A multi-wallet
      // account resolves to its first wallet-typed entry until a trade signal names the actual one.
      for (const entry of list) {
        if (entry?.type !== 'wallet') continue;
        const addr = typeof entry.address === 'string' ? entry.address.trim() : '';
        if (_PUBKEY_RE.test(addr)) return addr;
      }
    } catch (_) {}
    return null;
  }

  // Scan localStorage + sessionStorage for a wallet pubkey.
  // Key-name filter narrows search; otherwise token addresses (same shape) yield false positives.
  const _STORE_KEY_RE = /wallet|pubkey|address|account|solana|profile|user/i;
  function _readFromStorage() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key || !_STORE_KEY_RE.test(key)) continue;
          const raw = store.getItem(key);
          if (!raw) continue;
          if (_PUBKEY_RE.test(raw.trim())) return raw.trim();
          try { const f = _deepFindPubkey(JSON.parse(raw), 0); if (f) return f; } catch (_) {}
        }
      } catch (_) {}
    }
    return null;
  }

  // Scan DOM attributes and text nodes for a wallet pubkey.
  // Not called at document_start (DOM empty then) — deferred to DOMContentLoaded.
  // Last resort: _readFromAxiomSettings supersedes this wherever Axiom has written its
  // wallet list. No stable pubkey-bearing DOM attribute exists (confirmed 22 Aug 2026).
  const _DOM_ATTRS = ['data-pubkey', 'data-wallet', 'data-address', 'data-wallet-address'];

  // Accepts only a unanimous answer. Holder, top-trader and tracker tables sit inside
  // these same zones, so first-match-wins could return a stranger's wallet — and since
  // Axiom's X-identity release an opted-in wallet renders a display name in place of its
  // address, which can remove the real owner's address while leaving everyone else's.
  function _ambiguous(n, where) {
    console.warn('[ZQ:AXIOM] ' + n + ' candidate pubkeys in ' + where + ' — no session wallet read from DOM');
    return null;
  }
  function _readFromDom() {
    const found = new Set();
    for (const attr of _DOM_ATTRS) {
      for (const el of document.querySelectorAll('[' + attr + ']')) {
        const v = el.getAttribute(attr)?.trim();
        if (v && _PUBKEY_RE.test(v)) found.add(v);
      }
    }
    if (found.size === 1) return [...found][0];
    if (found.size > 1) return _ambiguous(found.size, 'wallet attributes');

    const zones = document.querySelectorAll(
      'header, nav, [class*="wallet"], [class*="profile"], [class*="account"], [class*="user"]'
    );
    for (const zone of zones) {
      for (const el of zone.querySelectorAll('*')) {
        const text = (el.firstChild?.nodeType === 3 ? el.firstChild.textContent : '').trim();
        if (_PUBKEY_RE.test(text)) found.add(text);
      }
    }
    if (found.size === 1) return [...found][0];
    if (found.size > 1) return _ambiguous(found.size, 'page text');
    return null;
  }

  // MutationObserver fallback — watches for pubkey-shaped text after React hydration.
  // Self-cancels after 60 s or when axiomSessionPubkey is already populated.
  let _domObserver = null;
  function _startObserver() {
    if (_domObserver) return;
    const deadline = Date.now() + 60_000;
    _domObserver = new MutationObserver(function () {
      if (ns?.axiomSessionPubkey || Date.now() > deadline) {
        _domObserver.disconnect(); _domObserver = null; return;
      }
      // Re-checked here because Axiom writes 'settings' after auth resolves, which can land
      // later than document_start — the early read misses it on a fresh login.
      const found = _readFromAxiomSettings() ?? _readFromDom();
      if (found) { _setPubkey(found, 'dom-observer'); _domObserver.disconnect(); _domObserver = null; }
    });
    _domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── Dispatch captured signal ─────────────────────────────────────────────

  function _dispatchSignal(url, bodyStr) {
    let ev = null;
    if (url.includes(_SIG_LOG_TX))         ev = _extractLogTx(bodyStr);
    else if (url.includes(_SIG_OPEN_POS))  ev = _extractPosition(bodyStr, 'meme-open-single-position-v2');
    else if (url.includes(_SIG_CLOSE_POS)) ev = _extractPosition(bodyStr, 'handle-position-close-v2');
    if (!ev) return;

    // Step 3b: update session wallet pubkey (update-if-changed, logs wallet switches).
    if (ev.walletAddress) _setPubkey(ev.walletAddress, 'signal');

    // Step 3c: per-wallet open-position map — enables token resolution on close signals.
    if (ev.type === 'meme-open-single-position-v2' && ev.walletAddress && ev.tokenAddress && ns) {
      ns.axiomLastOpIsClose = false;
      ns.axiomPositions.set(ev.walletAddress, { wallet: ev.walletAddress, token: ev.tokenAddress, openedAt: Date.now() });
    } else if (ev.type === 'handle-position-close-v2' && ev.walletAddress && ns) {
      ns.axiomLastOpIsClose = true;  // suppress the log-tx-v3 that follows (sell trade)
      const open = ns.axiomPositions.get(ev.walletAddress);
      if (open) {
        // Prefer map-resolved token; close signal body may omit tokenAddress.
        if (!ev.tokenAddress) ev = Object.assign({}, ev, { tokenAddress: open.token });
        ns.axiomPositions.delete(open.wallet);
        console.log('[ZQ:AXIOM] position close resolved: wallet=' + open.wallet.slice(0, 8) + '… token=' + open.token.slice(0, 8) + '…');
      } else if (!ev.tokenAddress) {
        console.log('[ZQ:AXIOM] position close: no open position in map (opened before ZendIQ loaded) wallet=' + ev.walletAddress.slice(0, 8) + '…');
      }
    }

    // Step 4: trigger token risk scoring on buy; deduped by ns._tokenScoreMint.
    // Base58 only: an EVM token address has no Solana scorer, and assigning it would
    // clobber the mint the Activity writer below reads.
    if (ev.type === 'meme-open-single-position-v2' && ev.tokenAddress && ns?.fetchTokenScore
        && _B58_ADDR_RE.test(ev.tokenAddress)) {
      if (ev.tokenAddress !== ns._tokenScoreMint) {
        ns._tokenScoreMint  = ev.tokenAddress;
        ns.tokenScoreResult = null;
        ns.axiomRiskAcknowledged = false; // new token — reset acknowledgement
        ns.fetchTokenScore(ev.tokenAddress, null);
      }
    }

    // Step 6: Activity recording from log-tx-v3.
    // Fires post-settlement. Token context comes from ns._tokenScoreMint (set by URL
    // navigation before the user buys). Risk score from ns.tokenScoreResult (pre-fetched
    // the moment the user navigates to the token page).
    if (ev.type === 'log-tx-v3' && ev.signature && ns) {
      // Chain evidence from the payload itself — stronger than the URL here. _tokenScoreMint
      // is deliberately never cleared, so an unguarded BNB trade would be filed as
      // "SOL → <last Solana token viewed>" with that token's risk score attached.
      if (!_SOL_SIG_RE.test(ev.signature)) {
        console.log('[ZQ:AXIOM] non-Solana trade — not recorded: ' + String(ev.signature).slice(0, 12) + '\u2026');
        ns.axiomLastOpIsClose = false;
        return;
      }
      // log-tx-v3 fires for both buys and sells; a preceding handle-position-close-v2
      // marks a sell. Only a hint — the signal can be missed, and the on-chain
      // enrichment below overrides it either way.
      const _sellHint = ns.axiomLastOpIsClose === true;
      ns.axiomLastOpIsClose = false;
      // Cache slippage (decimal) and MEV mode for use in pre-trade risk computations.
      if (ev.slippage != null) ns.axiomLastSlippage = ev.slippage / 100;
      if (ev.mevProtection != null) ns.axiomLastMevMode = ev.mevProtection;
      // Was this the trade we just optimized? Capture before restore clears the flag.
      const _wasOptimized = ns.axiomOptimizing === true;
      const _optDetail    = _wasOptimized ? (ns.axiomLastOptimization ?? null) : null;
      const _token = ns._tokenScoreMint || null;
      const _risk  = (ns.tokenScoreResult?.loaded) ? ns.tokenScoreResult : null;
      const _SOL   = 'So11111111111111111111111111111111111111112';
      const _entry = {
        source:      'axiom',
        chain:       _chain(),
        optimized:   _wasOptimized,
        signature:   ev.signature,
        success:     ev.success,
        timestamp:   Date.now(),
        walletPubkey: ns.axiomSessionPubkey ?? null,
        // One side is always SOL on Axiom; the sell hint decides which.
        side:        _sellHint ? 'sell' : 'buy',
        tokenOut:    _sellHint ? 'SOL' : (_risk?.symbol ?? null),
        outputMint:  _sellHint ? _SOL : _token,
        tokenIn:     _sellHint ? (_risk?.symbol ?? null) : 'SOL',
        inputMint:   _sellHint ? _token : _SOL,
        // Pre-trade SOL amount read from the buy box — meaningless on a sell.
        amountIn:    _sellHint ? null : (_axiomBuyAmountSol ?? null),
        amountOut:   null,   // filled async below via getTransaction
        // Token risk describes the meme token. On a sell it is not what was received.
        riskScore:   _sellHint ? null : (_risk?.score   ?? null),
        riskLevel:   _sellHint ? null : (_risk?.level   ?? null),
        riskFactors: _sellHint ? null : (_risk?.factors ?? null),
        // Exchange hint.
        routeSource: 'axiom',
        // Axiom preset breakdown extracted from the log-tx-v3 body.
        axiomPreset: {
          priorityFeeSol:        ev.priorityFeeSol        ?? null,
          bribeFeeSol:           ev.bribeFeeSol           ?? null,
          mevProtection:         ev.mevProtection         ?? null,
          enhancedMevProtection: ev.enhancedMev           ?? null,
          provider:              ev.provider              ?? null,
          region:                ev.region                ?? null,
          slippage:              ev.slippage              ?? null,
          timeTakenMs:           ev.timeTakenMs           ?? null,
        },
        sandwichResult: null,   // filled async below
        // ZendIQ optimization breakdown (present only when this buy was optimized).
        axiomOptimization: _optDetail,
      };
      try {
        window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: _entry } }, '*');
      } catch (_) {}

      // Analytics: structured trade record, plus the legacy swap_* event the
      // /stats/pro swap_funnel still reads. Both, so the Axiom cohort appears in
      // the same two places every other DEX does.
      _axTradeCount++;
      const _axSlipBps = ev.slippage != null ? Math.min(10000, Math.round(ev.slippage * 100)) : null;
      // Fee fields are named …Sol but are native-denominated, so off Solana they are
      // not SOL and must not be priced as if they were.
      const _axIsSol   = _isSolana();
      const _axSolUsd  = _axIsSol ? _solUsd() : null;
      const _axUsd     = (_axiomBuyAmountSol != null && _axSolUsd != null) ? _axiomBuyAmountSol * _axSolUsd : null;
      const _axFeesSol = (ev.priorityFeeSol ?? 0) + (ev.bribeFeeSol ?? 0);
      try { ns.logTrade?.({
        user_action:       _wasOptimized ? 'optimised' : 'proceeded',
        dex:               _AX_SITE,
        exec_path:         (ev.enhancedMev || ev.mevProtection) ? 'axiom_mev' : 'axiom_direct',
        tx_sig:            ev.signature,
        input_mint:        _axIsSol ? _SOL : null,
        output_mint:       _token,
        success:           ev.success == null ? null : (ev.success ? 1 : 0),
        trade_usd:         _axUsd != null ? Math.min(_axUsd, 500000) : null,
        trade_sol:         _axIsSol ? (_axiomBuyAmountSol ?? null) : null,
        quoted_slippage:   ev.slippage ?? null,
        fees_usd:          (_axFeesSol > 0 && _axSolUsd != null) ? Math.min(_axFeesSol * _axSolUsd, 5000) : null,
        slot_latency_ms:   ev.timeTakenMs != null ? Math.min(300000, Math.round(ev.timeTakenMs)) : null,
        bot_risk_score:    ns.axiomMevRisk?.riskScore ?? null,
        token_risk_score:  _risk?.score ?? null,
        tx_classification: _axLvl2Class(_risk?.level),
        auto_sign:         false,
        // Unvalidated extras land in trades.data_json — Axiom's sender attribution.
        provider:          ev.provider ?? null,
        region:            ev.region   ?? null,
        // Sent separately because fees_usd sums them: H.4's floor-vs-scaling question
        // can only be answered by comparing bribe_fee_sol against trade_sol.
        priority_fee_sol:  ev.priorityFeeSol ?? null,
        bribe_fee_sol:     ev.bribeFeeSol    ?? null,
      }); } catch (_) {}
      try { ns.logProEvent?.(_wasOptimized ? 'swap_optimised' : 'swap_proceeded', {
        site:         _AX_SITE,
        token_level:  _risk?.level ?? null,
        mev_level:    ns.axiomMevRisk?.riskLevel ?? null,
        trade_usd:    _axUsd != null ? Math.min(_axUsd, 50000) : null,
        trade_sol:    _axiomBuyAmountSol ?? null,
        input_mint:   _SOL,
        output_mint:  _token,
        amount_in:    _axiomBuyAmountSol ?? null,
        slippage_bps: _axSlipBps,
      }); } catch (_) {}

      // Restore the user's original preset now that the optimized trade has settled.
      if (_wasOptimized) { _restoreSettings('settled'); }

      // Sandwich detection — assumed buy direction (SOL→token) which is the common case.
      // For sells the direction is reversed; detection may miss but never false-positives.
      if (ns.detectSandwich && _token && _isSolana()) {
        ns.detectSandwich(ev.signature, _SOL, _token).then(function (sw) {
          if (!sw) return;
          try {
            window.postMessage({
              sr_bridge_to_ext: true,
              msg: { type: 'HISTORY_UPDATE', payload: { signature: ev.signature, sandwichResult: sw } },
            }, '*');
          } catch (_) {}
        }).catch(function () {});
      }

      // Async: fetch actual SOL spent + tokens received from the confirmed transaction.
      // Posts a second HISTORY_UPDATE to enrich the Activity card once on-chain data arrives.
      // Solana-only: off-chain this is 8 retries against a signature that cannot resolve.
      if (ns.rpcCall && _isSolana()) {
        const _sig = ev.signature;
        const _wp  = ns.axiomSessionPubkey;
        (async function () {
          for (let attempt = 0; attempt < 8; attempt++) {
            await new Promise(function (r) { setTimeout(r, attempt === 0 ? 4000 : 3000); });
            try {
              const tx = await ns.rpcCall('getTransaction', [
                _sig,
                { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: ns.MAX_TX_VERSION },
              ]);
              if (!tx?.meta) continue;
              const meta = tx.meta;
              if (meta.err != null) return; // failed tx — amountIn/Out irrelevant
              const msg  = tx.transaction?.message ?? {};
              const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
              const _rwp = _wp ?? (keys.length > 0
                ? (typeof keys[0] === 'string' ? keys[0] : (keys[0]?.pubkey ?? null)) : null);

              // Direction is decided here, from the wallet's own balance deltas.
              // The close signal that set _sellHint can be missed, and a missed sell
              // was filed as a buy carrying the buy box's stale SOL amount.
              const post = meta.postTokenBalances ?? [];
              const pre  = meta.preTokenBalances  ?? [];
              const _uiAmt = function (e) {
                if (!e) return 0;
                return e.uiTokenAmount?.uiAmount
                  ?? (parseFloat(e.uiTokenAmount?.amount ?? '0') / Math.pow(10, e.uiTokenAmount?.decimals ?? 0));
              };

              // Owner-matched throughout. An unowned match on the traded mint is the
              // pool's account, and on a sell the pool gains exactly what the user
              // sold — which is how the sold amount was being shown as received.
              let tokenDelta = null;
              if (_token) {
                const pe = post.find(function (e) { return e.mint === _token && e.owner === _rwp; });
                const pr = pre.find(function  (e) { return e.mint === _token && e.owner === _rwp; });
                if (pe || pr) tokenDelta = _uiAmt(pe) - _uiAmt(pr);
              }
              if (tokenDelta == null) {
                // Largest absolute move among this wallet's own token accounts.
                let best = 0;
                for (const pe of post) {
                  if (pe.owner !== _rwp) continue;
                  const pr = pre.find(function (e) { return e.mint === pe.mint && e.accountIndex === pe.accountIndex; });
                  const d  = _uiAmt(pe) - _uiAmt(pr);
                  if (Math.abs(d) > Math.abs(best)) best = d;
                }
                if (best !== 0) tokenDelta = best;
              }

              // Signed, with the network fee added back so it reflects the swap alone.
              let solDelta = null;
              if (_rwp) {
                const idx = keys.findIndex(function (k) {
                  return (typeof k === 'string' ? k : k?.pubkey) === _rwp;
                });
                if (idx >= 0) {
                  solDelta = ((meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0) + (meta.fee ?? 0)) / 1e9;
                }
              }

              const _sell = (tokenDelta != null)
                ? tokenDelta < 0
                : (solDelta != null ? solDelta > 0 : _sellHint);

              const _payload = { signature: _sig, side: _sell ? 'sell' : 'buy' };
              if (_sell) {
                _payload.tokenIn    = _risk?.symbol ?? null;
                _payload.inputMint  = _token;
                _payload.tokenOut   = 'SOL';
                _payload.outputMint = _SOL;
                if (tokenDelta != null) _payload.amountIn  = Math.abs(tokenDelta);
                if (solDelta   != null) _payload.amountOut = Math.abs(solDelta);
                // Cleared, not left stale: the meme token's risk does not describe SOL.
                _payload.riskScore = null; _payload.riskLevel = null; _payload.riskFactors = null;
              } else {
                if (solDelta   != null && solDelta   < 0) _payload.amountIn  = Math.abs(solDelta);
                if (tokenDelta != null && tokenDelta > 0) _payload.amountOut = tokenDelta;
              }
              try {
                window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: _payload } }, '*');
              } catch (_) {}
              return;
            } catch (_) { /* retry */ }
          }
        })();
      }
      // Refresh Monitor tab so it shows idle state (not the confirm panel) after
      // settlement. axiomConfirmPending is already false (cleared by axiomProceedTrade).
      try { ns.renderWidgetPanel?.(); } catch (_) {}
    }

    console.log('[ZQ:AXIOM]', ev.type);
  }

  // ── Pre-trade risk computation ───────────────────────────────────────────
  // Reads Axiom's slippage setting from localStorage (user preference persisted
  // by Axiom's React app). Falls back to last known value from log-tx-v3 signals,
  // then to the observed default of 20% (confirmed across multiple live trades).
  const _SLIP_KEY_RE = /slippage|slip|setting/i;
  function _readAxiomSlippage(side) {
    // The active preset is authoritative and side-specific; the scan below cannot
    // reach into solPresets and so cannot tell a 40% sell from a 20% buy.
    try {
      const s = _readSettings();
      const p = _preset(s, s?.currentSolPresetKey, side);
      const n = parseFloat(p?.slippage);
      if (!isNaN(n) && n > 0 && n <= 100) return n > 1 ? n / 100 : n;
    } catch (_) {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !_SLIP_KEY_RE.test(k)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const n = parseFloat(raw);
        if (!isNaN(n) && n > 0 && n <= 100) return n > 1 ? n / 100 : n; // "20" or "0.20"
        try {
          const obj = JSON.parse(raw);
          const slip = obj?.slippage ?? obj?.defaultSlippage ?? null;
          if (slip != null) { const s = parseFloat(slip); if (!isNaN(s) && s > 0) return s > 1 ? s / 100 : s; }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  // ── Preset optimization (snapshot → safe write → restore) ────────────────
  // Axiom signs server-side (Turnkey) so ZendIQ cannot rebuild the tx. The only
  // lever is to temporarily tighten the active preset on the trade's own side
  // (lower slippage,
  // force MEV Secure) before the trade, then restore the original afterwards so
  // the change is completely seamless. Endpoint + recipe verified live:
  //   POST {apiHost}/update-settings  body {settings:<full object>}  → requires an
  //     actual diff + bumped lastUpdatedAt; cookie auth (credentials:include).
  //   GET  {apiHost}/get-settings     → the same object UNWRAPPED; cookie auth.
  // The wrap asymmetry is the API's, not ours: read unwrapped, write wrapped.
  //
  // The host is sharded (api10, api3, …) and both endpoints share it, so a
  // hardcoded shard would break the read and the write together and silently.
  // Learn it from live traffic. The unnumbered alias is the fallback and also
  // serves both endpoints — /get-settings verified 200 on it, 22 Aug 2026.
  let _apiHost = null;
  let _healingOnLoad = false;  // a Buy clicked during this is skipped, not failed
  function _noteApiHost(url) {
    try {
      const h = new URL(url, location.href).hostname;
      if (/^api\d*\.axiom\.trade$/.test(h)) { _apiHost = h; if (ns) ns.axiomApiHost = h; }
    } catch (_) {}
  }
  function _apiBase()          { return 'https://' + (_apiHost ?? ns?.axiomApiHost ?? 'api.axiom.trade'); }
  function _updateSettingsUrl() { return _apiBase() + '/update-settings'; }
  function _getSettingsUrl()    { return _apiBase() + '/get-settings'; }

  function _readSettings() {
    try {
      const raw = localStorage.getItem('settings');
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (_) { return null; }
  }

  // A cleared site and an unparseable mirror both make _readSettings return null,
  // but they mean opposite things: nothing local holds our value vs. we cannot tell.
  function _localState() {
    try {
      const raw = localStorage.getItem('settings');
      if (raw == null || raw === '') return 'absent';
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? 'ok' : 'unreadable';
    } catch (_) { return 'unreadable'; }
  }

  function _mevModeLabel(buy) {
    if (!buy) return 'Off';
    if (buy.enhancedMevProtection) return 'Secure';
    if (buy.mevProtection) return 'Reduced';
    return 'Off';
  }

  // Worst (highest) of a set of risk levels.
  function _worstLevel(/* ...levels */) {
    const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    let worst = 'LOW';
    for (let i = 0; i < arguments.length; i++) {
      const lvl = arguments[i];
      if (lvl && (order[lvl] ?? 0) > (order[worst] ?? 0)) worst = lvl;
    }
    return worst;
  }

  // Compute the proposed safe changes for the active preset on the given side.
  // Returns null when settings are unreadable or there is nothing worth changing.
  function _computeOptimization(side) {
    if (!ns?.axiomOptimizeEnabled) return null;
    if (!_isSolana()) return null;
    const settings = _readSettings();
    if (!settings) return null;
    const _side = side === 'sell' ? 'sell' : 'buy';
    const key = settings.currentSolPresetKey;
    const preset = _preset(settings, key, _side);
    if (!preset) return null;

    const slipFrom = parseFloat(preset.slippage);
    if (isNaN(slipFrom) || slipFrom <= 0) return null;

    // Target slippage from the worst of bot-attack and token risk.
    const botLvl = ns.axiomMevRisk?.riskLevel ?? null;
    const tkLvl  = (ns.tokenScoreResult?.loaded) ? (ns.tokenScoreResult.level ?? null) : null;
    const worst  = _worstLevel(botLvl, tkLvl);
    const slipTarget = worst === 'CRITICAL' ? 10 : worst === 'HIGH' ? 15 : 20;
    const slipTo = Math.min(slipFrom, slipTarget); // only ever lower

    const mevFrom = _mevModeLabel(preset);

    const changes = [];
    if (slipTo < slipFrom) changes.push({ label: 'Slippage', from: slipFrom + '%', to: slipTo + '%' });
    if (mevFrom !== 'Secure') changes.push({ label: 'MEV protection', from: mevFrom, to: 'Secure' });
    if (!changes.length) return null; // already safe — nothing to optimize

    // Honest, conservative savings estimate (potential exposure removed).
    // A sell's size is a token quantity, not SOL, so there is no sound USD figure —
    // null omits the row rather than sizing the exit off a stale buy amount.
    // No live SOL price means the same: omit, rather than quote a constant.
    let estSavingsUsd = null;
    const _optSolUsd = _solUsd();
    if (_side === 'buy' && _optSolUsd != null) {
      const buyAmt = _readBuyAmountFromButton() ?? _axiomBuyAmountSol ?? 0;
      const usd = buyAmt * _optSolUsd;
      const slipSav = usd > 0 ? usd * ((slipFrom - slipTo) / 100) * 0.15 : 0; // 0.15 fill-rate, matches jup.ag math
      const mevSav  = (mevFrom !== 'Secure' && ns.axiomMevRisk?.estimatedLossUSD > 0)
        ? ns.axiomMevRisk.estimatedLossUSD * 0.95
        : 0;
      estSavingsUsd = slipSav + mevSav;
    }

    return { settings, key, side: _side, preset, slipFrom, slipTo, mevFrom, mevTo: 'Secure', changes, estSavingsUsd };
  }

  // POST a settings object to Axiom. Returns true on HTTP 2xx.
  // Callers must build the body from a fresh read of the server copy — never from
  // a snapshot and never from the local mirror, which can hold different values.
  let _serverCache = null; // last object seen from get-settings, for the unload path
  async function _postSettings(s) {
    try {
      const res = await window.fetch(_updateSettingsUrl(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ settings: s }),
      });
      if (res.ok) _serverCache = s;
      return res.ok;
    } catch (_) { return false; }
  }

  // ── OPS-181: restore obligation ──────────────────────────────────────────
  // Axiom's settings live on three independent surfaces — the server copy, the
  // localStorage mirror, and in-memory React state (H.11). A mutation we fail to
  // undo is a third-party account left changed without the user's knowledge, so
  // the obligation to restore is recorded before the mutation and cleared only by
  // observation. `update-settings` cannot confirm state (H.10); `get-settings` can.

  function _preset(settings, key, side) {
    return settings?.solPresets?.[key]?.[side === 'sell' ? 'sell' : 'buy'] ?? null;
  }
  // Obligations written before sells were covered carry no side; all were buys.
  function _obPreset(settings, ob) { return _preset(settings, ob.presetKey, ob.side ?? 'buy'); }

  // A permanently-failing obligation would otherwise retry on every load forever,
  // each retry a POST to a third party from the user's authenticated session.
  const _RESTORE_ATTEMPT_CEILING = 5;

  // How long we keep restoring silently. Past this we ask instead of writing.
  // Our targets are 10/15/20 — exactly the round numbers a human types — so a
  // preset reading `to` is weak evidence we were the one who wrote it. If the user
  // set 20 themselves and we "restore" 30, we have raised their slippage and left
  // them less safe than we found them: the worst direction for this product to be
  // wrong in. Asking costs one prompt, so the window is short rather than generous.
  // Once ob.serverStamp is verified (see below) this bound relaxes — an untouched
  // stamp proves authorship better than any amount of elapsed time.
  const _OBLIGATION_EXPIRY_MS = 48 * 60 * 60 * 1000;

  function _isExpired(ob) {
    return (Date.now() - (Number(ob.createdAt) || 0)) > _OBLIGATION_EXPIRY_MS
        || (ob.attempts ?? 0) >= _RESTORE_ATTEMPT_CEILING;
  }

  // ── OPS-181: settings lock ───────────────────────────────────────────────
  // Required for the restore as well as the mutation. Both are read-modify-write
  // over the same two surfaces, and a restore racing another tab's mutation can
  // put back a value that tab has already moved on from.
  // Heartbeat rather than a plain flag: a tab that crashes cannot release, so the
  // lock has to age out on its own or the account wedges until storage is cleared.
  // The staleness window is the cost of that — a tab throttled by the browser for
  // longer than this loses the lock while still believing it holds it, which is
  // why 'refresh' reports the loss instead of silently re-taking it.
  const _LOCK_BEAT_MS = 5000;   // must stay well under the worker's 15s staleness
  const _lockOwner = 'lk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let _lockBeat = null;
  let _lockHeld = false;

  function _lockRpc(op, timeoutMs) {
    return new Promise(function (resolve) {
      const id = 'lk' + Math.random().toString(36).slice(2, 10);
      let settled = false;
      const finish = function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(v);
      };
      const onMsg = function (ev) {
        if (ev.source !== window || ev.origin !== window.location.origin) return;
        const m = ev.data?.sr_bridge ? ev.data.msg : null;
        if (m?.type !== 'AXIOM_LOCK_RESPONSE' || m._id !== id) return;
        finish(m.result ?? { ok: false });
      };
      window.addEventListener('message', onMsg);
      // No answer means no lock. Treating a timeout as success would mutate
      // exactly when we have least evidence we are the only writer.
      const timer = setTimeout(function () { finish({ ok: false, error: 'timeout' }); }, timeoutMs ?? 2000);
      try { window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'AXIOM_LOCK', op: op, owner: _lockOwner, _id: id } }, '*'); }
      catch (_) { finish({ ok: false, error: 'post' }); }
    });
  }

  function _stopLockBeat() {
    if (_lockBeat) { clearInterval(_lockBeat); _lockBeat = null; }
  }

  async function _acquireLock() {
    const r = await _lockRpc('acquire');
    _lockHeld = !!r?.ok;
    if (!_lockHeld) return false;
    if (!_lockBeat) {
      _lockBeat = setInterval(function () {
        _lockRpc('refresh').then(function (rr) {
          if (rr?.ok) return;
          _lockHeld = false;
          _stopLockBeat();
          console.warn('[ZQ:AXIOM] settings lock lost — another tab took over');
        });
      }, _LOCK_BEAT_MS);
    }
    return true;
  }

  function _releaseLock() {
    _stopLockBeat();
    if (!_lockHeld) return Promise.resolve();
    _lockHeld = false;
    return _lockRpc('release');
  }

  // Only the fields we actually changed, each with the value to put back.
  function _diffFields(before, after) {
    const fields = {};
    for (const k of Object.keys(after)) {
      if (String(before[k]) !== String(after[k])) fields[k] = { from: before[k], to: after[k] };
    }
    return fields;
  }

  // What a live preset says about our obligation:
  //   'from'  — already restored, nothing owed
  //   'to'    — our mutation is still in place
  //   'other' — the user has since set something else; their intent supersedes ours
  function _verdict(buy, fields) {
    if (!buy) return null;
    let allFrom = true, allTo = true;
    for (const k of Object.keys(fields)) {
      if (String(buy[k]) !== String(fields[k].from)) allFrom = false;
      if (String(buy[k]) !== String(fields[k].to))   allTo   = false;
    }
    return allFrom ? 'from' : allTo ? 'to' : 'other';
  }

  function _persistObligation(ob) {
    if (ns) ns.axiomObligation = ob;
    try { window.postMessage({ type: 'ZENDIQ_SAVE_AXIOM_OBLIGATION', obligation: ob }, '*'); } catch (_) {}
  }

  // Same write, but resolves only once the bridge confirms storage accepted it.
  // The MAIN-world hop is a task-queue message racing a network round trip, so
  // fire-and-forget is a hope, not a sequence. Resolves false on reject, storage
  // failure, or no answer — never assume a record we have not been told exists.
  function _persistObligationAcked(ob, timeoutMs) {
    if (ns) ns.axiomObligation = ob;
    return new Promise(function (resolve) {
      const token = 'ob' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let settled = false;
      const finish = function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(v);
      };
      const onMsg = function (e) {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type !== 'ZENDIQ_AXIOM_OBLIGATION_SAVED' || e.data.token !== token) return;
        if (!e.data.ok) console.warn('[ZQ:AXIOM] obligation persist rejected (' + e.data.why + ')');
        finish(!!e.data.ok);
      };
      window.addEventListener('message', onMsg);
      const timer = setTimeout(function () { finish(false); }, timeoutMs ?? 2000);
      try { window.postMessage({ type: 'ZENDIQ_SAVE_AXIOM_OBLIGATION', obligation: ob, token: token }, '*'); }
      catch (_) { finish(false); }
    });
  }

  // The obligation as storage holds it, not as this tab remembers it. ns.axiomObligation
  // is filled at page load, so a tab opened before another tab mutated has no record of
  // that mutation and would read its result as the user's own setting.
  // `ok:false` means we could not tell, which is not the same as nothing outstanding.
  function _fetchObligation(timeoutMs) {
    return new Promise(function (resolve) {
      const token = 'og' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let settled = false;
      const finish = function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(v);
      };
      const onMsg = function (e) {
        if (e.origin !== window.location.origin) return;
        if (e.data?.type !== 'ZENDIQ_AXIOM_OBLIGATION_RESPONSE' || e.data.token !== token) return;
        const ob = e.data.obligation;
        finish({ ok: e.data.ok !== false, obligation: (ob && ob.v === 1 && ob.fields) ? ob : null });
      };
      window.addEventListener('message', onMsg);
      const timer = setTimeout(function () { finish({ ok: false, obligation: null }); }, timeoutMs ?? 2000);
      try { window.postMessage({ type: 'ZENDIQ_GET_AXIOM_OBLIGATION', token: token }, '*'); }
      catch (_) { finish({ ok: false, obligation: null }); }
    });
  }

  async function _fetchServerSettings() {
    try {
      const res = await window.fetch(_getSettingsUrl(), { credentials: 'include' });
      if (!res.ok) return null;
      const j = await res.json();
      const s = j?.settings ?? j; // GET is unwrapped today; tolerate either
      if (!s || typeof s !== 'object') return null;
      _serverCache = s;
      return s;
    } catch (_) { return null; }
  }

  // Read-modify-write on the local mirror, touching only the named fields.
  // `dir` is 'to' or 'from'. The read happens here, at write time, so anything
  // Axiom's own UI changed meanwhile survives — a whole-snapshot write would not.
  function _writeLocalFields(presetKey, fields, dir, side) {
    try {
      const keys = Object.keys(fields);
      if (!keys.length) return true;
      const s = _readSettings();
      const p = _preset(s, presetKey, side);
      if (!p) return false;
      for (const k of keys) p[k] = fields[k][dir];
      localStorage.setItem('settings', JSON.stringify(s));
      return true;
    } catch (_) { return false; }
  }

  // → true when nothing is owed on the local mirror any more.
  // Three branches on what the preset actually reads, per surface: 'to' is ours to
  // undo, 'from' is already done, anything else is the user's own later choice —
  // and writing over that would be the very thing this whole mechanism exists to
  // prevent, so uncertainty abandons rather than writes.
  function _settleLocal(ob, serverSettled, readOnly) {
    try {
      const state = _localState();
      // Site data cleared: no mirror holds our value, and Axiom re-seeds it from the
      // server — so this is only settled once the server is clean too.
      if (state === 'absent')     { ob.localOutcome = 'absent';     return !!serverSettled; }
      if (state === 'unreadable') { ob.localOutcome = 'unreadable'; return false; }

      const v = _verdict(_obPreset(_readSettings(), ob), ob.fields);
      if (v == null)     { ob.localOutcome = 'preset-absent'; return !!serverSettled; }
      if (v === 'from')  { ob.localOutcome = 'restored';   return true; }
      if (v === 'other') { ob.localOutcome = 'superseded'; return true; }
      // Expired: the read still happens, only the write stops. 'from' and 'other'
      // above settle for free; this is the one branch that needs the user.
      if (readOnly)      { ob.localOutcome = 'needs-decision'; return false; }

      if (!_writeLocalFields(ob.presetKey, ob.fields, 'from', ob.side)) { ob.localOutcome = 'write-failed'; return false; }
      const after = _verdict(_obPreset(_readSettings(), ob), ob.fields);
      ob.localOutcome = after === 'from' ? 'restored' : 'write-unconfirmed';
      return after === 'from';
    } catch (_) { ob.localOutcome = 'unreadable'; return false; }
  }

  // → true when nothing is owed on the server copy any more.
  // Checked independently of the local outcome: either surface can be clean while
  // the other is still stale, so there are two completion states, not one pass.
  async function _settleServer(ob, readOnly) {
    const f = ob.serverFields ?? ob.fields; // the server's own before-values, not the mirror's
    const server = await _fetchServerSettings();
    if (!server) { ob.serverOutcome = 'unreachable'; return false; }
    const v = _verdict(_obPreset(server, ob), f);
    // A response we cannot find the preset in is not proof the preset is clean —
    // it is a response we do not understand. Stays owed and surfaces to the user.
    if (v == null)     { ob.serverOutcome = 'preset-absent'; return false; }
    if (v === 'from')  { ob.serverOutcome = 'restored';   return true; }
    if (v === 'other') { ob.serverOutcome = 'superseded'; return true; }
    if (readOnly)      { ob.serverOutcome = 'needs-decision'; return false; }

    const p = _obPreset(server, ob);
    for (const k of Object.keys(f)) p[k] = f[k].from;
    server.lastUpdatedAt = Date.now(); // force a real diff so the write is accepted
    const ok = await _postSettings(server);
    const after = await _fetchServerSettings();
    const done = _verdict(_obPreset(after, ob), f) === 'from';
    if (ok && !done) console.warn('[ZQ:AXIOM] restore POST accepted but server still reads the mutated preset');
    ob.serverOutcome = done ? 'restored' : (after ? 'write-unconfirmed' : 'unreachable');
    return done;
  }

  // Restore the user's original preset. Safe to call repeatedly, and called from
  // four places now — trade settlement, page load, a refusal in another tab, and
  // the user's own Restore button — so it takes the obligation as an argument
  // rather than assuming it created it. `force` is the user answering the prompt.
  async function _restoreSettings(reason, obIn, opts) {
    const ob = obIn ?? ns?.axiomObligation;
    if (ns) {
      ns.axiomOptimizing = false;
      if (ns._axiomRestoreTimer) { clearTimeout(ns._axiomRestoreTimer); ns._axiomRestoreTimer = null; }
    }
    if (!ob) return;
    if (ns) ns.axiomObligation = ob;

    // Expired or out of attempts: keep reading, stop writing. The read is what
    // clears the common cases for free — only a surface still holding our value
    // reaches the user, and only then because we cannot prove it is ours.
    const readOnly = !opts?.force && _isExpired(ob);

    // The restore reads both surfaces and writes them back, so it needs the lock
    // for the same reason the mutation does.
    if (!(await _acquireLock())) {
      // Another tab is mid-cycle. Not our failure, so it must not spend an attempt:
      // the ceiling exists to bound real failures, not contention.
      console.log('[ZQ:AXIOM] restore deferred (' + reason + ') — settings lock held elsewhere');
      return;
    }

    // Server first. Axiom may rewrite the local mirror from server state on a path
    // we have not characterised, which would silently undo a local-only restore.
    if (!ob.serverRestored) ob.serverRestored = await _settleServer(ob, readOnly);
    if (!ob.localRestored)  ob.localRestored  = _settleLocal(ob, ob.serverRestored, readOnly);
    if (!readOnly) ob.attempts++;
    ob.needsDecision = ob.localOutcome === 'needs-decision' || ob.serverOutcome === 'needs-decision';

    const done = ob.localRestored && ob.serverRestored;
    _persistObligation(done ? null : ob);
    // Held while anything is still owed: that also blocks a fresh mutation from
    // capturing our unrestored value as its original. Released once we have stopped
    // acting, so a tab waiting on the user does not block every other tab's restore.
    if (done || readOnly) _releaseLock();
    console.log('[ZQ:AXIOM] restore (' + reason + ') local=' + ob.localRestored + '/' + (ob.localOutcome ?? '-') +
                ' server=' + ob.serverRestored + '/' + (ob.serverOutcome ?? '-') + (readOnly ? ' [read-only]' : ''));
  }

  // Optimize & Buy: patch safe values → re-fire Buy → schedule restore.
  // Exposed as ns.axiomOptimizeTrade for the widget button. No auto-sign — the
  // user still approves the buy through Axiom's own flow.
  // Returns false when the optimization was abandoned and nothing was changed.
  async function _applyOptimizationAndBuy() {
    // Second gate. _computeOptimization already checks the flag, but this is the only
    // function that writes to the user's settings — it must not depend on a caller.
    if (!ns?.axiomOptimizeEnabled) { ns?.axiomProceedTrade?.(); return; }
    // Consent is Solana-scoped: it describes a mutation of solPresets, which is the
    // only preset store this file knows how to read or put back. Off Solana there is
    // also no held click to release, so proceeding is only right if we did intercept.
    if (!_isSolana()) {
      console.log('[ZQ:AXIOM] optimization refused \u2014 chain=' + (ns?.axiomChain ?? _CHAIN_UNKNOWN));
      if (ns) ns.axiomOptimizeAbandoned = { at: Date.now(), why: 'chain-not-supported' };
      // We only intercept on Solana, so a pending confirm here means the page moved
      // under the panel. Re-firing would hunt for a trade button on whatever is on
      // screen now — a different token's. Drop the approval rather than guess.
      if (ns?.axiomConfirmPending) {
        ns.axiomConfirmPending = false;
        ns.axiomPendingBtnRef  = null;
        try { ns.renderWidgetPanel?.(); } catch (_) {}
      }
      return false;
    }
    const opt = _computeOptimization(ns?.axiomPendingSide);
    if (!opt || !ns) { ns?.axiomProceedTrade?.(); return; }

    // The user asked to optimize. Re-firing their unprotected preset for them substitutes a
    // different trade for the one they chose, so the fallback is theirs to confirm. Only a
    // held click can be held — with nothing pending there is no decision to put to them.
    const _holdForUser = function () {
      if (ns.axiomConfirmPending) { try { ns.renderWidgetPanel?.(); } catch (_) {} return false; }
      ns.axiomProceedTrade?.();
      return false;
    };

    const _abandon = function (why) {
      console.warn('[ZQ:AXIOM] optimization abandoned (' + why + ') — Axiom settings untouched');
      ns.axiomObligation = null;
      ns.axiomLastOptimization = null;
      ns.axiomOptimizeAbandoned = { at: Date.now(), why: why };
      _releaseLock();
      return _holdForUser();
    };

    // A second mutation while one is still owed would overwrite the only record of
    // the true original with the value we ourselves wrote. Deliberately not routed
    // through _abandon, which clears the obligation — here it must survive.
    const _skipForOutstanding = function (owed) {
      const why = owed.ok ? 'restore-outstanding' : 'obligation-unreadable';
      console.warn('[ZQ:AXIOM] optimization skipped (' + why + ') — an earlier change may be unrestored');
      ns.axiomLastOptimization = null;
      ns.axiomOptimizeAbandoned = { at: Date.now(), why: why };
      if (owed.obligation) {
        ns.axiomObligation = owed.obligation;  // another tab's record; we hold the lock, so we heal it
        _restoreSettings('pre-trade');
      } else {
        _releaseLock();
      }
      return _holdForUser();
    };

    ns.axiomOptimizeAbandoned = null;
    _axEngage();
    ns.axiomLastOptimization = {
      slipFrom: opt.slipFrom, slipTo: opt.slipTo,
      mevFrom: opt.mevFrom, mevTo: opt.mevTo,
      estSavingsUsd: opt.estSavingsUsd, changes: opt.changes,
    };

    // The three fields this optimization touches, and nothing else.
    const intended = {
      slippage: String(opt.slipTo),
      enhancedMevProtection: true,   // Secure
      mevProtection: false,          // Secure is the enhanced flag only
    };

    // The before-values read and the mutation write have to be one critical
    // section. A second tab reading between them takes our mutation for its own
    // original, and its undo then re-applies ours.
    if (!(await _acquireLock())) return _abandon(_healingOnLoad ? 'startup' : 'locked');

    // Inside the lock, and from storage rather than memory: holding the lock only
    // proves no one is mid-cycle now, not that the last cycle finished. A tab that
    // was throttled past the staleness window leaves its obligation behind.
    const owed = await _fetchObligation();
    if (!owed.ok || owed.obligation) return _skipForOutstanding(owed);

    // Each surface is diffed against its own fresh read. The mirror and the server
    // can legitimately hold different values, so a single shared before-value would
    // put the wrong one back on one of them.
    const localBuy  = _preset(_readSettings(), opt.key, opt.side);
    const server    = await _fetchServerSettings();
    const serverBuy = _preset(server, opt.key, opt.side);
    if (!localBuy || !serverBuy) return _abandon('settings-unreadable');

    // A field with no readable before-value cannot be put back faithfully, and
    // the bridge would drop it from the record — leaving a half-undoable change.
    for (const k of Object.keys(intended)) {
      if (!(k in localBuy) || !(k in serverBuy)) return _abandon('unknown-field');
    }

    const fields       = _diffFields(localBuy,  intended);
    const serverFields = _diffFields(serverBuy, intended);
    // Already at the safe values: nothing to undo, so nothing to hold the lock for.
    if (!Object.keys(fields).length && !Object.keys(serverFields).length) { _releaseLock(); ns.axiomProceedTrade?.(); return; }

    // Write-ahead: the obligation is recorded before the mutation, so a crash
    // between the two leaves a record to heal from rather than a silent change.
    const ob = {
      v: 1,
      createdAt: Date.now(),
      host: _apiHost,
      presetKey: opt.key,
      side: opt.side,
      fields,
      serverFields,
      localRestored: false,
      serverRestored: false,
      attempts: 0,
    };

    // Abandon rather than mutate: without a confirmed undo record, an optimized
    // trade is a third-party setting we might never be able to put back.
    if (!(await _persistObligationAcked(ob))) return _abandon('no-undo-record');

    ns.axiomOptimizing = true;
    for (const k of Object.keys(serverFields)) serverBuy[k] = serverFields[k].to;
    server.lastUpdatedAt = Date.now();
    const ok = await _postSettings(server);
    if (!ok) {
      // Write failed — but "failed" here cannot be trusted (H.10), so read the
      // server rather than assuming nothing landed. Only an observed 'from'
      // clears the obligation; an unreadable server leaves it outstanding.
      ns.axiomOptimizing = false;
      ns.axiomLastOptimization = null;
      const v = _verdict(_preset(await _fetchServerSettings(), opt.key, opt.side), serverFields);
      if (v === 'from') { _persistObligation(null); _releaseLock(); }
      else              await _restoreSettings('write-failed');
      ns.axiomOptimizeAbandoned = { at: Date.now(), why: 'settings-write-failed' };
      return _holdForUser();
    }

    if (!_writeLocalFields(opt.key, fields, 'to', opt.side)) {
      // The mirror is what Axiom actually reads (H.11), so a server-only write
      // protects nothing. Put the server back rather than claim a protected trade.
      ns.axiomLastOptimization = null;
      ns.axiomOptimizeAbandoned = { at: Date.now(), why: 'mirror-unwritable' };
      await _restoreSettings('mirror-write-failed');
      return _holdForUser();
    }

    // Settings are safe on both surfaces. Fire the original Buy click.
    ns.axiomProceedTrade?.();

    // Read back the server's own timestamp for this write, after the buy so the
    // trade is not made to wait on it. Not yet used to decide anything: the field
    // moved once in probe testing for reasons we could not attribute, and it is
    // unverified whether it moves when another device writes. Once that is
    // confirmed, `readOnly` in _restoreSettings becomes `stamp changed since ours`
    // and the 48h bound relaxes — a condition swap, not a data-model change.
    _fetchServerSettings().then(function (s) {
      if (!s || ns.axiomObligation !== ob) return;
      ob.serverStamp = s.lastUpdatedAt ?? null;
      _persistObligation(ob);
    });

    // Fallback restore if the settlement signal is missed (e.g. failed/cancelled).
    ns._axiomRestoreTimer = setTimeout(function () { _restoreSettings('timeout'); }, 45000);
  }

  // Best-effort restore if the user closes the tab mid-trade — sendBeacon carries
  // same-site cookies so the write still authenticates without awaiting a promise.
  // Opportunistic only: it never clears the obligation, because it cannot observe
  // the outcome. The next load confirms by reading.
  // The lock is deliberately not released here. Releasing would let another tab
  // start a fresh mutation while this beacon is still in flight, and read the
  // value the beacon is about to undo as its own original. It ages out instead.
  window.addEventListener('beforeunload', function () {
    const ob = ns?.axiomObligation;
    if (!ob || (ob.localRestored && ob.serverRestored)) return;
    if ((ob.attempts ?? 0) >= _RESTORE_ATTEMPT_CEILING) return;
    try {
      _writeLocalFields(ob.presetKey, ob.fields, 'from', ob.side);
      // No GET is possible at unload, so patch the last object the server itself
      // gave us. Falling back to the mirror here would post its values to the
      // server and overwrite anything that only ever existed there.
      const f = ob.serverFields ?? ob.fields;
      const s = _serverCache;
      const p = _obPreset(s, ob);
      if (!p || _verdict(p, f) !== 'to') return;
      for (const k of Object.keys(f)) p[k] = f[k].from;
      s.lastUpdatedAt = Date.now();
      const blob = new Blob([JSON.stringify({ settings: s })], { type: 'application/json' });
      navigator.sendBeacon(_updateSettingsUrl(), blob);
    } catch (_) {}
  });

  // Separate listener from the restore beacon above: that one returns early on
  // several conditions and must not gate the session record.
  window.addEventListener('beforeunload', function () {
    if (!ns?._sessionLogged) return;
    try {
      ns.logSession?.('end', {
        type:         'end',
        wallet:       'axiom',
        dex:          _AX_SITE,
        duration_s:   Math.min(86400, Math.round((Date.now() - _axSessionAt) / 1000)),
        trades_count: _axTradeCount,
      });
    } catch (_) {}
  });

  if (ns) ns.axiomOptimizeTrade = _applyOptimizationAndBuy;

  // The card may have been on screen for days, so both actions re-read: the record
  // from storage in case another tab settled it, and the surfaces inside the restore.
  if (ns) ns.axiomRestoreNow = async function () {
    const owed = await _fetchObligation();
    if (!owed.ok) return false;
    if (!owed.obligation) { ns.axiomObligation = null; return true; }
    await _restoreSettings('user', owed.obligation, { force: true });
    return !ns.axiomObligation;
  };
  if (ns) ns.axiomKeepCurrent = function () { _persistObligation(null); _releaseLock(); };

  // ── Consent gate (OPS-185) ───────────────────────────────────────────────
  // page-interceptor.js is not loaded on axiom.trade, so the settings handshake
  // that file owns elsewhere has to be driven from here.
  let _consentShownLogged = false;

  function _saveAxiomConsent(choice) {
    try {
      window.postMessage({ type: 'ZENDIQ_SAVE_SETTINGS', payload: { axiomOptimize: choice } }, '*');
    } catch (_) {}
  }

  if (ns) ns.axiomSetConsent = function (choice) {
    if (choice !== 'on' && choice !== 'off') return;
    ns.axiomOptimizeConsent = choice;
    ns.axiomOptimizeEnabled = choice === 'on';
    _saveAxiomConsent(choice);
    try {
      ns.logFunnel?.(choice === 'on' ? 'axiom_consent_enabled' : 'axiom_consent_kept_off', { dex: _AX_SITE });
    } catch (_) {}
    try { ns.renderWidgetPanel?.(); } catch (_) {}
  };

  // Called by the panel the first time the unanswered prompt is actually rendered,
  // so `shown` counts impressions rather than page loads.
  if (ns) ns.axiomConsentShown = function () {
    if (_consentShownLogged) return;
    _consentShownLogged = true;
    try { ns.logFunnel?.('axiom_consent_shown', { dex: _AX_SITE }); } catch (_) {}
  };

  window.addEventListener('message', function (e) {
    if (e.source !== window || e.origin !== window.location.origin) return;
    if (e.data?.type !== 'ZENDIQ_SETTINGS_RESPONSE') return;
    const s = e.data.settings ?? {};
    if (!ns) return;
    ns.axiomOptimizeConsent = s.axiomOptimize ?? null;
    ns.axiomOptimizeEnabled = s.axiomOptimize === 'on';
    // page-interceptor.js owns this sync on every other DEX; axiom.trade doesn't load it.
    // The route-optimisation fields are unused here but must still be held, because the
    // widget Settings tab writes the whole blob back.
    ns.threshMinRiskLevel  = s.minRiskLevel ?? 'LOW';
    ns.threshMinLossUsd    = s.minLossUsd   ?? 0;
    ns.threshMinSlippage   = s.minSlippage  ?? 0;
    ns.widgetMode          = s.uiMode       ?? 'simple';
    ns.autoProtect         = s.autoProtect  ?? false;
    ns.autoAccept          = s.autoAccept   ?? false;
    ns.pauseOnHighRisk     = s.pauseOnHighRisk !== false;
    ns.dynamicSlippageMode = s.dynamicSlippageMode ?? 'shadow';
    ns.jitoMode            = s.jitoMode     ?? 'auto';
    ns.settingsProfile     = s.profile      ?? 'alert';
    ns.settingsLoaded      = true;
    // Unanswered: put the prompt in front of the user rather than waiting for a Buy click.
    // Not on a chain we have already ruled out — the prompt describes a Solana-only
    // action, so asking there would be asking for consent to something that cannot run.
    if (ns.axiomOptimizeConsent === null && _chain() !== _CHAIN_OTHER) {
      const _w = document.getElementById('sr-widget');
      if (_w) { _w.style.display = ''; _w.classList.add('expanded'); ns.widgetActiveTab = 'monitor'; }
      else ns.ensureWidgetInjected?.();
    }
    try { ns.renderWidgetPanel?.(); } catch (_) {}
  });

  (function _requestSettings() {
    const send = () => { try { window.postMessage({ type: 'ZENDIQ_GET_SETTINGS' }, '*'); } catch (_) {} };
    send();
    // bridge.js and this file both run at document_start; a single post can lose the race.
    setTimeout(send, 400);
    setTimeout(function () { if (!ns?.settingsLoaded) send(); }, 1500);
  })();


  // Compute Execution Risk and Bot Attack Risk for the current axiom token.
  // Called after fetchTokenScore completes and whenever slippage/mint changes.
  // Results stored on ns so renderMonitor can read them synchronously.
  const _SOL_MINT = 'So11111111111111111111111111111111111111112';
  // amountUSD is optional — pass the real USD value when the user has entered an amount.
  // Omit (or pass null/undefined) for the proactive scan before any amount is set.
  // mint may be null: the slippage and congestion checks describe the user's buy
  // settings, not the token, so they still hold when the token cannot be identified.
  async function _computeAxiomRisk(mint, amountUSD) {
    if (!ns) return;

    // Slippage: localStorage → last log-tx-v3 signal → observed default (20%).
    const _slipDecimal = _readAxiomSlippage(ns?.axiomPendingSide) ?? ns.axiomLastSlippage ?? 0.20;

    // ── Bot Attack Risk via calculateMEVRisk ─────────────────────────────
    // Axiom is primarily used for memecoin buys: single-hop AMM, high slippage,
    // thin liquidity — all factors that make sandwich attacks profitable.
    // Use routeType 'bonding_curve' for pump.fun mints (end in 'pump'),
    // else 'unknown' (Raydium AMM post-graduation).
    // Skipped without a mint: the memecoin-pair test would fall through to the
    // safer branch and report a low score it has no basis for.
    if (mint && ns.calculateMEVRisk) {
      ns.axiomMevRisk = ns.calculateMEVRisk({
        inputMint:  _SOL_MINT,
        outputMint: mint,
        amountUSD:  (amountUSD ?? null), // null = unknown (skips size floor cap); real value re-scores
        routePlan:  null,                // single hop
        slippage:   _slipDecimal,
        routeType:  mint.endsWith('pump') ? 'bonding_curve' : 'unknown',
      });
    }

    // ── Execution Risk via calculateRisk ────────────────────────────────
    if (ns.calculateRisk && ns.fetchDevnetContext) {
      const txInfo = {
        accountCount: 6,  // typical for a meme buy
        swapInfo: {
          slippagePercent: _slipDecimal * 100, // calculateRisk expects percentage
          inAmount:        null,
          inAmountUsd:     null,
          outputMint:      mint,
          source:          'axiom',
        },
      };
      try {
        const ctx = await ns.fetchDevnetContext(txInfo);
        ns.axiomRiskResult = await ns.calculateRisk(txInfo, ctx);
      } catch (_) {}
    }

    // Re-render widget with fresh risk data.
    try { ns.renderWidgetPanel?.(); } catch (_) {}
  }

  // ── Step 3a: early session wallet pubkey read ────────────────────────────
  // Storage is available immediately at document_start; DOM is not.
  // Falls back through: axiom settings → generic storage scan → DOM scan → MutationObserver.
  // Signal-path (_dispatchSignal) wins over all of these — it names the wallet that actually traded.
  (function _earlyPubkeyRead() {
    const fromSettings = _readFromAxiomSettings();
    if (fromSettings) { _setPubkey(fromSettings, 'axiom-settings'); return; }
    const fromStorage = _readFromStorage();
    if (fromStorage) { _setPubkey(fromStorage, 'storage'); return; }
    function _domRead() {
      if (ns?.axiomSessionPubkey) return;
      const fromDom = _readFromDom();
      if (fromDom) _setPubkey(fromDom, 'dom');
      else         _startObserver();
    }
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', _domRead, { once: true });
    } else {
      _domRead();
    }
  })();

  // ── OPS-181: load-time healing ───────────────────────────────────────────
  // An obligation is healed by whichever tab finds it, not by the one that created
  // it — the creating tab may have been closed or killed mid-trade.
  (function _healOnLoad() {
    // The API host is sharded and learned from live traffic. The unnumbered alias
    // answers /get-settings, but the restore also has to POST, and that is not
    // verified on the alias — so give Axiom's own first call a chance to name the
    // shard rather than spending an attempt on a guess.
    function _awaitApiHost(maxMs) {
      return new Promise(function (resolve) {
        if (_apiHost) return resolve();
        const t0 = Date.now();
        const iv = setInterval(function () {
          if (_apiHost || Date.now() - t0 >= maxMs) { clearInterval(iv); resolve(); }
        }, 250);
      });
    }

    (async function () {
      let owed = await _fetchObligation();
      // The bridge may not be listening yet this early; one retry distinguishes
      // "not ready" from "nothing owed", which otherwise look the same.
      if (!owed.ok) {
        await new Promise(function (r) { setTimeout(r, 1500); });
        owed = await _fetchObligation();
      }
      if (!owed.ok || !owed.obligation) return;
      if (ns) ns.axiomObligation = owed.obligation;
      _healingOnLoad = true;
      try {
        await _awaitApiHost(8000);
        await _restoreSettings('load', owed.obligation);
      } finally { _healingOnLoad = false; }
    })();
  })();

  // ── fetch observer ──────────────────────────────────────────────────────────────────
  // Installed at document_start before Axiom's JS bundles load.
  const _origFetch = window.fetch;
  window.fetch = async function (resource, init) {
    try {
      const url = typeof resource === 'string' ? resource : (resource?.url ?? '');
      _noteApiHost(url);
      if (_isAxiomSignal(url)) {
        const body = init?.body ?? null;
        if (typeof body === 'string' && body) _dispatchSignal(url, body);
      }
    } catch (_) {}
    return _origFetch(resource, init);
  };

  // ── XHR observer ─────────────────────────────────────────────────────────────────
  // Axiom's telemetry signals are most likely fetch, but this observer covers XHR too.
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (_method, url) {
    this.__zq_ax_url = typeof url === 'string' ? url : '';
    try { _noteApiHost(this.__zq_ax_url); } catch (_) {}
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__zq_ax_url ?? '';
      if (_isAxiomSignal(url) && typeof body === 'string' && body) {
        _dispatchSignal(url, body);
      }
    } catch (_) {}
    return _origSend.apply(this, arguments);
  };

  // ── SPA URL listener (step 5) ────────────────────────────────────────────
  // Axiom is a React SPA. Token navigation uses history.pushState, which does
  // NOT fire popstate — the setInterval poll is the primary detection path.
  // popstate covers browser back/forward navigation.
  //
  // URL pattern: axiom.trade/meme/{addr}, where addr is the pool address for some
  // tokens and the mint for others — the two are indistinguishable by shape.
  const _MINT_PATH_RE = /\/meme\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/;
  // Matched against pathname alone, same input as _chainFromUrl. That keeps the two
  // in step: an address here always implies chain=solana, never a silent unknown.
  function _readMintFromUrl() {
    const m = _MINT_PATH_RE.exec(window.location.pathname);
    return m ? m[1] : null;
  }

  // An approval belongs to the token that was on screen when it was given, so the
  // route moving is the approval expiring.
  function _dropApproval(why) {
    _approvedAddr = null;
    if (!ns?.axiomConfirmPending) return;
    ns.axiomConfirmPending = false;
    ns.axiomPendingBtnRef  = null;
    ns.axiomOptimizeAbandoned = { at: Date.now(), why: why };
    try { ns.renderWidgetPanel?.(); } catch (_) {}
  }

  // Axiom's /meme/ route carries the pool address for some tokens and the mint for
  // others. A new token returns no DexScreener pair simply because it is not indexed
  // yet, so "no pair" cannot be read as "this is the mint" — the account type has to
  // be confirmed on-chain. Unresolved stays null and blocks scoring: a partial
  // verdict computed against a pool address reads to the user as an all-clear.
  const _mintCache = new Map();

  // An indexer can name the wrong side of a pair, a quote asset, or a stale token.
  // Confirming the account is an SPL mint is what separates a resolved token from
  // a plausible-looking string that would be scored with full confidence.
  const _TOKEN_PROGRAMS = new Set([
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',   // SPL Token
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',   // Token-2022
  ]);
  async function _isMintAccount(addr) {
    try {
      const info = await ns.rpcCall('getAccountInfo', [addr, { encoding: 'jsonParsed' }]);
      const val  = info?.value;
      return val?.data?.parsed?.type === 'mint' && _TOKEN_PROGRAMS.has(val?.owner);
    } catch (_) { return false; }
  }

  async function _dexScreenerBase(addr) {
    if (!ns?.pageJsonFetch) return null;
    const d    = await ns.pageJsonFetch('https://api.dexscreener.com/latest/dex/pairs/solana/' + addr);
    const pair = Array.isArray(d?.pairs) ? d.pairs[0] : (d?.pair ?? null);
    return pair?.baseToken?.address ?? null;
  }

  // GeckoTerminal indexes a new pool sooner than DexScreener, which is the case that
  // actually fails here — a token listed nowhere at all is the rarer miss.
  async function _geckoBase(addr) {
    if (!ns?.pageJsonFetch) return null;
    const g = await ns.pageJsonFetch(
      'https://api.geckoterminal.com/api/v2/networks/solana/pools/' + addr,
      { Accept: 'application/json;version=20230302' });
    const id = g?.data?.relationships?.base_token?.data?.id ?? '';
    return String(id).replace(/^solana_/, '') || null;
  }

  async function _resolveMint(addr) {
    if (!addr) return null;
    if (_mintCache.has(addr)) return _mintCache.get(addr);

    let mint = (await _isMintAccount(addr)) ? addr : null;

    // Pool address — ask the indexers which token it trades, then verify the answer.
    // Tried in order so the second call only fires when the first yields nothing usable.
    if (!mint) {
      const _sources = [['dexscreener', _dexScreenerBase], ['geckoterminal', _geckoBase]];
      for (let i = 0; i < _sources.length && !mint; i++) {
        const _name = _sources[i][0];
        let c = null, err = null;
        try { c = await _sources[i][1](addr); } catch (e) { err = e; }
        // Which step failed is the whole diagnosis: an indexer that returned nothing
        // and a mint that would not verify need opposite fixes.
        if (err)            { console.log('[ZQ:AXIOM] ' + _name + ' errored: ' + (err?.message ?? err)); continue; }
        if (!c)             { console.log('[ZQ:AXIOM] ' + _name + ' returned no base token'); continue; }
        if (!_B58_ADDR_RE.test(c) || c === _SOL_MINT) {
          console.log('[ZQ:AXIOM] ' + _name + ' returned unusable base token: ' + c);
          continue;
        }
        if (await _isMintAccount(c)) mint = c;
        else console.log('[ZQ:AXIOM] ' + _name + ' base ' + c.slice(0, 8) + '\u2026 did not verify as a mint');
      }
    }

    if (!mint) {
      // Not cached — a later visit may resolve once the token is indexed.
      // Logged, not warned: this is an expected state for a new token and the widget
      // reports it. console.warn would file it in the browser's extension error list.
      console.log('[ZQ:AXIOM] could not identify token for ' + addr.slice(0, 8) + '\u2026 \u2014 not scoring');
      return null;
    }
    _mintCache.set(addr, mint);
    if (mint !== addr) console.log('[ZQ:AXIOM] pool ' + addr.slice(0, 8) + '\u2026 \u2192 mint ' + mint.slice(0, 8) + '\u2026');
    return mint;
  }

  // A collapsed pill on a list page reads as coverage those Buy buttons do not have.
  // Once per page load, and never again once the user has said they know.
  let _listGapShown = false;
  function _maybeShowListGap(settled) {
    if (!ns || _listGapShown || ns.axiomListGapAck) return;
    if (_readMintFromUrl()) return;
    if (_chain() === _CHAIN_OTHER) return;
    // Axiom's router passes through address-less URLs mid-navigation, which would
    // otherwise pop the list notice open on a token page.
    if (!settled) { setTimeout(function () { _maybeShowListGap(true); }, 700); return; }
    if (!document.getElementById('sr-widget')) { setTimeout(function () { _maybeShowListGap(true); }, 300); return; }
    _listGapShown = true;
    try { ns.openZendIQPanel?.(); } catch (_) {}
  }

  let _currentAxiomMint = null;

  // A collapsed pill reading "Active" is a coverage claim. When a check cannot run,
  // say so on the pill and open the panel — silence here reads as a pass.
  function _flagNotCovered(flag) {
    if (!ns) return;
    ns[flag] = true;
    try { ns.updateWidgetStatus?.('Not covered'); } catch (_) {}
    try { (ns.openZendIQPanel ?? ns.renderWidgetPanel)?.(); } catch (_) {}
  }

  function _onMintChange(routeAddr) {
    if (routeAddr === _currentAxiomMint) return;
    _currentAxiomMint  = routeAddr;
    _axiomBuyAmountSol = null;  // reset amount on token navigation
    if (!ns) return;
    // Reset any pending intercept state from the previous token.
    ns.axiomConfirmPending = false;
    ns.axiomPendingBtnRef  = null;
    ns.axiomMintUnresolved = false;
    ns.axiomScoreFailed    = false;
    // Both describe the token being left. Recompute is not guaranteed — the MEV
    // block is skipped when the mint cannot be resolved — so a stale verdict would
    // otherwise be shown, logged and optimised against under the new token's name.
    ns.axiomMevRisk    = null;
    ns.axiomRiskResult = null;
    if (!routeAddr) {
      // Left the token page for a list. ns._tokenScoreMint is deliberately left
      // set: the trade logger reads it to attribute a buy that is still settling.
      try { ns.updateWidgetStatus?.(_pillActiveLabel()); } catch (_) {}
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      _maybeShowListGap();
      return;
    }
    // Clear stale score so the widget shows "Scanning…" while the mint resolves.
    ns._tokenScoreMint  = null;
    ns.tokenScoreResult = null;
    try { ns.renderWidgetPanel?.(); } catch (_) {}

    _resolveMint(routeAddr).then(function (mint) {
      if (_currentAxiomMint !== routeAddr) return;  // navigated away mid-resolve
      if (!mint) {
        _flagNotCovered('axiomMintUnresolved');
        _computeAxiomRisk(null).catch(function () {});
        return;
      }
      ns._tokenScoreMint = mint;
      try { ns.updateWidgetStatus?.(_pillActiveLabel()); } catch (_) {}
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      // Pre-fetch before the user buys — score is ready by the time the trade fires.
      if (ns.fetchTokenScore) {
        ns.fetchTokenScore(mint, null).then(function (r) {
          if (_currentAxiomMint !== routeAddr) return;
          if (!r || !r.loaded) { _flagNotCovered('axiomScoreFailed'); return; }
          // Compute execution + MEV risk now that the token score is available.
          _computeAxiomRisk(mint).catch(function () {});
          // Open the widget proactively on HIGH/CRITICAL so user sees the warning
          // before they click Buy — and on a partial scan, which the collapsed pill
          // cannot distinguish from a clean one.
          if ((r.level === 'HIGH' || r.level === 'CRITICAL' || r.unknown === true) && ns.openZendIQPanel) {
            ns.openZendIQPanel();
          } else if (ns.renderWidgetPanel) {
            // Refresh pill badge colour and Monitor content for lower-risk tokens.
            ns.renderWidgetPanel();
          }
        }).catch(function () {
          if (_currentAxiomMint !== routeAddr) return;
          _flagNotCovered('axiomScoreFailed');
        });
      }
      // Also run a lightweight MEV risk estimate immediately (slippage known, token known).
      // Gives the widget something to show before token score finishes loading.
      _computeAxiomRisk(mint).catch(function () {});
    }).catch(function (e) {
      // Without this the panel never renders and nothing says why: a rejection here
      // skips the flag, the score fetch and the render in one silent step.
      if (_currentAxiomMint !== routeAddr) return;
      console.warn('[ZQ:AXIOM] mint resolution threw for ' + String(routeAddr).slice(0, 8) + '\u2026', e);
      _flagNotCovered('axiomMintUnresolved');
      _computeAxiomRisk(null).catch(function () {});
    });
  }

  // Reads initial mint on load, then polls every 250 ms for SPA navigation.
  (function _startSpaListener() {
    // Inject the widget DOM as soon as the page body is available.
    // page-interceptor.js is not loaded on axiom.trade, so we bootstrap the widget here.
    (function _initWidget() {
      function _go() {
        try { if (ns?.ensureWidgetInjected) ns.ensureWidgetInjected(); } catch (_) {}
        // page-wallet.js is not in the Axiom manifest — walletHooked is never set,
        // so the pill stays 'Connecting...' forever. Set 'Active' immediately since
        // we are monitoring regardless; _setPubkey upgrades nothing (already Active).
        try { ns?.updateWidgetStatus?.(_pillActiveLabel()); } catch (_) {}
      }
      if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', _go, { once: true });
      } else {
        _go();
      }
    })();

    _onMintChange(_readMintFromUrl());
    _maybeShowListGap();
    // Chain is tracked separately from the mint: a Solana list page and a BNB token
    // page both read as "no mint", so _onMintChange would short-circuit and the widget
    // would keep showing the previous chain's verdict.
    let _lastChain = _chain();
    function _syncChain() {
      const c = _chain();
      if (c === _lastChain) return;
      _lastChain = c;
      try { ns.renderWidgetPanel?.(); } catch (_) {}
    }
    // The pill states coverage, which tracks the route, not the chain or the mint.
    // Two addressless routes (Discover, a BNB token page) share a mint of null and
    // a Solana token page shares a chain with Solana Discover, so neither
    // _onMintChange nor _syncChain fires on those transitions.
    function _syncPill() {
      try { ns.updateWidgetStatus?.(_pillActiveLabel()); } catch (_) {}
    }
    let _lastHref = window.location.href;
    function _onRouteChange() {
      if (_approvedAddr != null && _readMintFromUrl() !== _approvedAddr) _dropApproval('navigated-away');
      _syncChain();
      _syncPill();
      _onMintChange(_readMintFromUrl());
    }
    setInterval(function () {
      if (window.location.href !== _lastHref) {
        _lastHref = window.location.href;
        _onRouteChange();
      }
    }, 250);
    window.addEventListener('popstate', _onRouteChange);

    // Buy button intercept and amount watcher use event delegation — no DOM ready needed.
    _interceptBuyButton();
    _watchAmountInput();
  })();

  // ── Buy button intercept ─────────────────────────────────────────────────
  // Two-layer capture intercept: pointerdown + click.
  // pointerdown fires before mousedown/click and before any React handler.
  // Calling preventDefault() on pointerdown causes Chrome to suppress the
  // subsequent mousedown and click from the physical press, so Axiom's handler
  // never fires regardless of which DOM event they listen to.
  // btn.click() (programmatic — used by axiomProceedTrade) does NOT fire
  // pointerdown, so the proceed path is unaffected.
  function _interceptBuyButton() {
    // → { btn, side } or null. Deliberately loose on buys: a missed match there
    // means the trade runs unchecked.
    function _tradeBtn(e) {
      const path = e.composedPath ? e.composedPath() : [];
      const btn  = path.find(function (el) { return el && el.tagName === 'BUTTON'; })
                ?? e.target?.closest?.('button');
      if (!btn) return null;
      const txt = (btn.textContent ?? '').trim().toLowerCase();
      if (txt.startsWith('buy ')) return { btn: btn, side: 'buy' };
      if (_isTokenSellText(txt))  return { btn: btn, side: 'sell' };
      return null;
    }

    // Discover/Pulse quick-buy buttons also read "Buy <amount>", and off a token
    // page _tokenScoreMint still holds the last token viewed — intercepting there
    // would show one token's verdict over another token's buy.
    function _onScoredTokenPage() {
      const addr = _readMintFromUrl();
      return !!addr && !ns?.axiomMintUnresolved && !!ns?._tokenScoreMint;
    }

    function _showPanel(btn, side) {
      const _side = side === 'sell' ? 'sell' : 'buy';
      if (ns) {
        ns.axiomConfirmPending = true;
        ns.axiomPendingBtnRef  = btn;
        ns.axiomPendingSide    = _side;
        _approvedAddr          = _readMintFromUrl();
        ns.axiomRiskAcknowledged = false; // new intercept — reset acknowledgement
        ns.axiomOptimizeAbandoned = null; // last trade's notice no longer applies
        _axEngaged = false;
        // _axiomBuyAmountSol is read off the buy button, so it describes no sell.
        const _amtSol = _side === 'sell' ? null : (_axiomBuyAmountSol ?? null);
        const _spI = _solUsd();
        const _iUsd = (_amtSol != null && _spI != null) ? _amtSol * _spI : null;
        try { ns.logProEvent?.('swap_intercepted', {
          site:         _AX_SITE,
          side:         _side,
          token_level:  ns.tokenScoreResult?.level ?? null,
          mev_level:    ns.axiomMevRisk?.riskLevel ?? null,
          trade_usd:    _iUsd != null ? Math.min(_iUsd, 50000) : null,
          trade_sol:    _amtSol,
          output_mint:  ns._tokenScoreMint ?? null,
          amount_in:    _amtSol,
        }); } catch (_) {}
        try { ns.logFunnel?.('widget_shown', { dex: _AX_SITE }); } catch (_) {}
      }
      const _w = document.getElementById('sr-widget');
      if (_w) {
        _w.style.display = '';
        _w.classList.add('expanded');
        if (ns) ns.widgetActiveTab = 'monitor';
      } else if (ns?.ensureWidgetInjected) {
        ns.ensureWidgetInjected();
        if (ns) ns.widgetActiveTab = 'monitor';
      }
      try { ns?.renderWidgetPanel?.(); } catch (_) {}
    }

    // Auto-accept: optimize and buy without waiting for a click. Fails closed —
    // an unscored token keeps the panel, because pauseOnHighRisk cannot be
    // evaluated against a verdict that has not arrived yet.
    function _shouldAutoAccept() {
      if (!ns?.autoAccept) return false;
      if (!_isSolana()) return false;
      if (!ns.axiomOptimizeEnabled || ns.axiomOptimizeConsent !== 'on') return false;
      if (ns.axiomObligation) return false;      // a restore is still owed
      // pauseOnHighRisk is a reason not to buy. On an exit the same verdict argues
      // for leaving sooner, so gating the sell behind a panel inverts its intent.
      if (ns.axiomPendingSide === 'sell') return true;
      if (ns.pauseOnHighRisk === false) return true;
      const r = ns.tokenScoreResult;
      if (!r?.loaded) return false;
      if (r.unknown === true) return false;   // too little read to call it anything
      return r.level !== 'HIGH' && r.level !== 'CRITICAL';
    }

    function _showPanelOrAutoAccept(btn, side) {
      _showPanel(btn, side);
      if (!_shouldAutoAccept()) return;
      if (ns) ns.axiomAutoAccepting = true;
      try { ns?.renderWidgetPanel?.(); } catch (_) {}
      Promise.resolve()
        .then(function () { return _applyOptimizationAndBuy(); })
        .catch(function (e) {
          console.warn('[ZQ:AXIOM] auto-accept failed, falling back to the panel', e);
        })
        .then(function () {
          if (ns) ns.axiomAutoAccepting = false;
          try { ns?.renderWidgetPanel?.(); } catch (_) {}
        });
    }

    // Layer 1: pointerdown — earliest possible intercept point.
    // preventDefault() here suppresses the browser-generated mousedown + click
    // that would follow a physical press, blocking Axiom regardless of which
    // event their React component listens to (onClick, onMouseDown, onPointerDown).
    document.addEventListener('pointerdown', function (e) {
      if (_axiomBypassNext) return; // proceed-path: flag cleared by click handler; all events pass through
      if (!_isSolana()) return;     // never block a buy we cannot assess
      if (!_onScoredTokenPage()) return;
      const hit = _tradeBtn(e);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      _showPanelOrAutoAccept(hit.btn, hit.side);
    }, true);

    // Layer 2: click — handles keyboard Enter / programmatic clicks that skip
    // the pointer event chain, and serves as the bypass path for axiomProceedTrade.
    document.addEventListener('click', function (e) {
      if (_axiomBypassNext) { _axiomBypassNext = false; return; }
      if (!_isSolana()) return;     // never block a buy we cannot assess
      if (!_onScoredTokenPage()) return;
      const hit = _tradeBtn(e);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // avoid double-showing, and never re-enter an auto-accept already in flight
      if (!ns?.axiomConfirmPending && !ns?.axiomAutoAccepting) _showPanelOrAutoAccept(hit.btn, hit.side);
    }, true);
  }

  // ── Amount input watcher ─────────────────────────────────────────────────
  // Re-scores bot attack risk whenever the user changes the SOL amount.
  // Listens for native 'input' events (covers typed values) and watches the
  // buy button text for preset-button clicks via MutationObserver, since preset
  // buttons update React state without a native input event on the amount field.

  // True when a visible input holds this value. Used only to corroborate an
  // otherwise-ambiguous bare integer read off the buy button.
  function _amountInputHas(v) {
    const inputs = document.querySelectorAll('input');
    for (let i = 0; i < inputs.length; i++) {
      const r = inputs[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && parseFloat(inputs[i].value) === v) return true;
    }
    return false;
  }

  // Extracts the SOL amount from one Buy button's text. Authoritative over the
  // amount field, which the generic 'input' listener confuses with slippage.
  function _amountFromButtonText(txt) {
    if (!/^\s*buy\s/i.test(txt)) return null;
    let m = /[\u8CB7]\s*([0-9]+(?:\.[0-9]+)?)/.exec(txt)         // Buy SYM 買X.XX
         ?? /buy\s+\S+\s+([0-9]+(?:\.[0-9]+)?)/i.exec(txt);      // Buy SYM X.XX
    let ambiguous = false;
    if (!m) {
      // Live layout renders 買 as an icon, so it never reaches textContent and the
      // amount abuts the symbol: "Buy catalyst0.001". A bare trailing integer is
      // then indistinguishable from a symbol ending in a digit ("Buy CAT3").
      m = /([0-9]+(?:\.[0-9]+)?)\s*$/.exec(txt);
      ambiguous = !!m && !m[1].includes('.');
    }
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (isNaN(v) || v <= 0 || v >= 100000) return null;
    return (ambiguous && !_amountInputHas(v)) ? null : v;
  }

  function _readBuyAmountFromButton() {
    const btns = document.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      const v = _amountFromButtonText(btns[i].textContent ?? '');
      if (v != null) return v;
    }
    return null;
  }

  function _watchAmountInput() {
    let _debounce = null;
    function _rescore(solAmt) {
      // Skip while the confirm panel is open — DOM changes from widget rendering
      // would otherwise re-trigger _computeAxiomRisk unnecessarily.
      if (ns?.axiomConfirmPending) return;
      // Prefer the Buy button amount — the generic 'input' listener also fires
      // for the slippage field, so never trust the raw input value alone.
      const amt = _readBuyAmountFromButton() ?? solAmt;
      _axiomBuyAmountSol = amt;
      const mint = ns?._tokenScoreMint;
      if (!mint) return;
      // null trade size is supported downstream — it skips the size floor rather than faking one.
      const _spW = _solUsd();
      const usd  = _spW != null ? amt * _spW : null;
      _computeAxiomRisk(mint, usd).catch(function () {});
    }
    // Typed input events.
    document.addEventListener('input', function (e) {
      const el = e.target;
      if (!el || el.tagName !== 'INPUT') return;
      const v = parseFloat(el.value);
      if (!isNaN(v) && v > 0 && v < 100000) {
        clearTimeout(_debounce);
        _debounce = setTimeout(function () { _rescore(v); }, 300);
      }
    }, { capture: true, passive: true });
    // Preset buttons update the buy-button text — watch for that change.
    function _startBtnObserver() {
      const obs = new MutationObserver(function () {
        const v = _readBuyAmountFromButton();
        if (v == null) return;
        clearTimeout(_debounce);
        _debounce = setTimeout(function () { _rescore(v); }, 200);
      });
      obs.observe(document.body, { subtree: true, characterData: true, childList: true });
    }
    if (document.body) { _startBtnObserver(); }
    else { window.addEventListener('DOMContentLoaded', _startBtnObserver, { once: true }); }
  }

  // ── Site adapter registration ────────────────────────────────────────────
  // Registered so page-interceptor.js (if ever loaded here) finds the adapter
  // via ns.activeSiteAdapter(). Substantive logic lives in _dispatchSignal above.
  if (!ns?.registerSiteAdapter) return;

  ns.registerSiteAdapter({
    name:       'axiom',
    matches()   { return _HOST === 'axiom.trade' || _HOST === 'www.axiom.trade'; },
    busyStates: [],

    initPage() {
      // Steps 3a–5 are triggered directly from the IIFE above
      // (page-interceptor.js is not loaded on axiom.trade, so initPage is never called).
    },

    onNetworkRequest(_url, _parsed) {
      // No-op — page-network.js is not loaded on axiom.trade.
      // All signal reading is handled by the fetch/XHR observer above.
    },

    onWalletArgs(_args) {
      // No-op — Turnkey signs server-side; wallet adapter never fires for trades
    },

    // Called by page-widget.js renderWidgetPanel() when Monitor tab is active
    // and no pending swap is being processed. Returns HTML string.
    // Mirrors the Review & Sign card stack: Overall Risk → Token Risk Score →
    // Bot Attack Risk → Execution Risk → impact warning → close button.
    renderMonitor() {
      const tokenScore = ns.tokenScoreResult;
      const _token     = ns._tokenScoreMint;
      const hasScore   = tokenScore?.loaded && tokenScore.mint === _token;
      const mevRisk    = ns.axiomMevRisk;
      const execRisk   = ns.axiomRiskResult;
      const _isSimple  = ns.widgetMode === 'simple';
      const _esc       = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const _sym       = hasScore
        ? _esc(tokenScore.symbol || (_token ? _token.slice(0,8) + '\u2026' : '?'))
        : (_token ? _token.slice(0,8) + '\u2026' : '?');

      // Both of the early returns below own the whole tab, so the abandon banner at
      // the foot of this function cannot reach the two states you land in by moving.
      const _dropWhy = ns.axiomOptimizeAbandoned?.why;
      const _dropHtml = (_dropWhy === 'navigated-away' || _dropWhy === 'chain-not-supported')
          ? `<div style="color:#FFB547;font-size:12px;line-height:1.6;margin-top:9px;padding-top:9px;border-top:1px solid rgba(255,181,71,0.25)">
              The trade you were approving was dropped when the page moved — <b style="color:#E8E8F0">nothing was sent</b>.
              Go back to that token and click Buy again if you still want it.
            </div>`
        : '';

      // ── Not a Solana pair (OPS-243) ─────────────────────────────────────
      // An idle Monitor panel reads as an all-clear. Say the check did not run.
      if (_chain() === _CHAIN_OTHER) {
        return `<div style="padding:14px 16px;">
          <div style="background:rgba(255,181,71,0.07);border:1px solid rgba(255,181,71,0.35);border-radius:10px;padding:12px 13px">
            <div style="color:#FFB547;font-size:13px;font-weight:700;margin-bottom:7px">ZendIQ does not cover this chain</div>
            <div style="color:#C2C2D4;font-size:12px;line-height:1.6;margin-bottom:7px">
              This pair is not on Solana. ZendIQ&rsquo;s risk scoring, bot-attack detection and trade-setting
              optimisation are Solana-only, so <b style="color:#E8E8F0">no check runs here</b> — nothing is
              scored, nothing is intercepted, and no Axiom setting is changed.
            </div>
            <div style="color:#C2C2D4;font-size:12px;line-height:1.6">
              Your trade goes through Axiom exactly as it would without ZendIQ. Switch to a Solana pair to get
              ZendIQ&rsquo;s checks back.
            </div>
            ${_dropHtml}
          </div>
        </div>`;
      }

      // ── Consent gate (OPS-185) — shown until the user answers ────────────
      // Neither button is styled as the default: the choice is not pre-made.
      const _consentHtml = (ns.settingsLoaded && ns.axiomOptimizeConsent == null) ? (function () {
        try { ns.axiomConsentShown?.(); } catch (_) {}
        return '<div style="background:rgba(153,69,255,0.07);border:1px solid rgba(153,69,255,0.35);border-radius:10px;padding:12px 13px;margin-bottom:12px">'
          + '<div style="color:#E8E8F0;font-size:13px;font-weight:700;margin-bottom:7px">Optimize your Axiom trades</div>'
          + '<div style="color:#C2C2D4;font-size:12px;line-height:1.6;margin-bottom:7px">'
          +   'When enabled, ZendIQ scores each trade before it executes. If your Axiom preset is looser than '
          +   'the measured risk warrants, it <b style="color:#E8E8F0">offers</b> a tighter trade slippage and a '
          +   'stronger MEV protection mode, sized to that specific trade \u2014 then puts your original settings '
          +   'back when the trade settles. You approve each trade.'
          + '</div>'
          + '<div style="color:#C2C2D4;font-size:12px;line-height:1.6;margin-bottom:7px">'
          +   'ZendIQ never touches your funds or keys. If a setting cannot be put back, ZendIQ tells you '
          +   'and lets you restore it yourself.'
          + '</div>'
          + '<div style="color:#C2C2D4;font-size:12px;line-height:1.6;margin-bottom:10px">'
          +   'Leave this off and ZendIQ only observes and reports \u2014 risk scores and sandwich detection, '
          +   'with no changes to your Axiom settings.'
          + '</div>'
          + '<div style="display:flex;gap:7px">'
          +   '<button id="sr-ax-consent-on" style="flex:1;padding:9px;border:1px solid rgba(255,255,255,0.18);border-radius:7px;background:rgba(255,255,255,0.04);color:#E8E8F0;font-size:12px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">Enable</button>'
          +   '<button id="sr-ax-consent-off" style="flex:1;padding:9px;border:1px solid rgba(255,255,255,0.18);border-radius:7px;background:rgba(255,255,255,0.04);color:#E8E8F0;font-size:12px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">Keep off</button>'
          + '</div>'
          + '<div style="color:#6B6B8A;font-size:10.5px;line-height:1.5;margin-top:8px">Changeable any time in Settings.</div>'
          + '</div>';
      })() : '';

      // ── Off a token page — state the coverage gap, don't imply protection ──
      // Keyed on the URL, not _tokenScoreMint: that is left pointing at the last
      // token viewed, so trusting it would show a stale verdict next to a list of
      // other tokens' Buy buttons. List quick-buys read "Buy <amount>" and do match
      // the intercept's selector — they are uncovered because _onScoredTokenPage
      // refuses to intercept off a token page, not because they cannot match.
      if (!_readMintFromUrl()) {
        return `<div style="padding:14px 16px;">
          ${_consentHtml}
          <div style="background:rgba(255,181,71,0.07);border:1px solid rgba(255,181,71,0.35);border-radius:10px;padding:12px 13px">
            <div style="color:#FFB547;font-size:13px;font-weight:700;margin-bottom:7px">Buys on this page are not checked</div>
            <div style="color:#C2C2D4;font-size:12px;line-height:1.6;margin-bottom:7px">
              ZendIQ scores a token and steps in front of your buy only once you open that token&rsquo;s own page.
              A <b style="color:#E8E8F0">Buy</b> clicked straight from a list &mdash; Discover, Pulse or Trackers &mdash;
              executes immediately, with no risk check and no chance to review.
            </div>
            <div style="color:#C2C2D4;font-size:12px;line-height:1.6">
              Open the token first if you want it scored before you commit.
            </div>
            ${_dropHtml}
          </div>
          <button id="sr-ax-listgap-ok" style="width:100%;margin-top:10px;padding:10px;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(255,255,255,0.04);color:#C2C2D4;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">\u2713 Got it \u2014 close</button>
        </div>`;
      }

      // Token identity or its score is missing. The buy-setting checks below do not
      // depend on either, so they still run — a 20% slippage preset is worth flagging
      // whether or not we know what is being bought.
      const _tokenUnchecked = !!(ns.axiomMintUnresolved || ns.axiomScoreFailed);
      const _uncheckedCard = _tokenUnchecked
        ? '<div style="background:rgba(255,181,71,0.07);border:1px solid rgba(255,181,71,0.35);border-radius:10px;padding:11px 13px;margin-bottom:10px">'
          + '<div style="color:#FFB547;font-size:13px;font-weight:700;margin-bottom:6px">Token risk could not be checked</div>'
          + (_isSimple ? '' :
              '<div style="color:#C2C2D4;font-size:12px;line-height:1.6;margin-bottom:6px">'
              + (ns.axiomMintUnresolved
                  ? 'ZendIQ could not work out which token this page refers to \u2014 very new tokens are often not listed anywhere yet. '
                  : 'The token risk check did not complete. ')
              + 'No mint authority, holder, liquidity or token age check has run.'
              + '</div>')
          + '<div style="color:#C2C2D4;font-size:12px;line-height:1.6">'
          +   '<b style="color:#E8E8F0">Treat this buy as unprotected on token risk.</b> '
          +   (_isSimple
                ? 'Your trade settings are still checked below.'
                : 'Your trade settings are still checked below. Reload to retry, or check the token yourself before trading.')
          + '</div></div>'
        : '';

      if (!_token && !_tokenUnchecked) {
        return `<div style="padding:14px 16px;">
          ${_consentHtml}
          <div style="font-size:13px;color:#C2C2D4;text-align:center;padding:12px 0;line-height:1.6">
            Reading token&hellip;
          </div>
        </div>`;
      }
      const _clr = { CRITICAL:'#FF4D4D', HIGH:'#FFB547', MEDIUM:'#9945FF', LOW:'#14F195' };
      const _c   = lvl => _clr[lvl] ?? '#C2C2D4';
      const _rl  = ns._riskLabel ?? (lvl => lvl);

      // ── Overall Risk — weighted composite (same formula as jup.ag) ─────────
      const _tkSc   = hasScore  ? (tokenScore.score        ?? 0) : 0;
      const _tkLvl  = hasScore  ? (tokenScore.level        ?? 'LOW') : null;
      const _botSc  = mevRisk   ? (mevRisk.riskScore       ?? 0) : 0;
      const _botLvl = mevRisk   ? (mevRisk.riskLevel       ?? 'LOW') : null;
      const _exSc   = execRisk  ? (execRisk.score          ?? 0) : 0;
      const _exLvl  = execRisk  ? (execRisk.level          ?? 'LOW') : null;
      const _BANDS   = { CRITICAL: 70, HIGH: 40, MEDIUM: 20 };
      const _cmp     = ns._compositeRisk
        ? ns._compositeRisk([
            { score: _exSc,  level: _exLvl,  weight: 0.40, loaded: !!execRisk },
            { score: _botSc, level: _botLvl, weight: 0.35, loaded: !!mevRisk },
            { score: _tkSc,  level: _tkLvl,  weight: 0.25, loaded: !!hasScore },
          ], _BANDS)
        : (() => {
            const s = Math.round(_exSc * 0.40 + _botSc * 0.35 + _tkSc * 0.25);
            return { score: s, level: s >= 70 ? 'CRITICAL' : s >= 40 ? 'HIGH' : s >= 20 ? 'MEDIUM' : 'LOW', floored: false };
          })();
      const _comp    = _cmp.score;
      const _compLvl = _cmp.level;
      const _cc      = _c(_compLvl);
      const _hasAnyRisk = mevRisk || execRisk || hasScore;
      // An unloaded dimension contributes 0 to the weighted sum, so a partial score
      // is not comparable to a full one. Name the basis rather than let the badge imply three.
      const _dims    = [
        { key: 'Execution',  loaded: !!execRisk, level: _exLvl  },
        { key: 'Bot Attack', loaded: !!mevRisk,  level: _botLvl },
        { key: 'Token Risk', loaded: !!hasScore, level: _tkLvl  },
      ];
      const _onNames = _dims.filter(d => d.loaded).map(d => d.key);
      const _offName = _dims.filter(d => !d.loaded).map(d => d.key);
      // What the weights alone would give, so the printed basis reconciles with the badge.
      const _rawW    = Math.round(_exSc * 0.40 + _botSc * 0.35 + _tkSc * 0.25);
      const _driver  = _dims.find(d => d.loaded && d.level === _compLvl)?.key;
      const _compBadge = _hasAnyRisk
        ? (_isSimple ? _rl(_compLvl) : (_compLvl + ' \u00b7 ' + _comp + '/100'))
        : '<span style="font-size:12px;color:#FFB547">scanning\u2026</span>';
      const _basisHtml = !_hasAnyRisk ? '' : (_offName.length
        ? '<div style="color:#FFB547;font-size:11px;line-height:1.5;margin-top:4px">Scored on '
          + _onNames.join(' + ') + ' only \u2014 ' + _offName.join(' and ')
          + (_offName.length > 1 ? ' are' : ' is') + ' not included</div>'
        : _cmp.floored
          ? '<div style="color:#8A8AA3;font-size:11px;line-height:1.5;margin-top:4px">'
            + (_isSimple
                ? 'Set by the worst risk: ' + (_driver ?? 'one dimension') + '.'
                : 'Raised to ' + _compLvl + ' by ' + (_driver ?? 'the worst dimension')
                  + ' \u2014 the weights alone give ' + _rawW + '.')
            + '</div>'
          : _isSimple ? ''
            : '<div style="color:#8A8AA3;font-size:11px;line-height:1.5;margin-top:4px">Execution 40% \u00b7 Bot Attack 35% \u00b7 Token Risk 25%</div>');
      const _compTip = 'Overall Risk Score \u2014 '
        + (_offName.length
            ? 'only ' + _onNames.length + ' of 3 dimensions could be scored.'
            : 'weighted composite of all three risk dimensions.')
        + '&#10;Formula: Execution \u00d7 40% + Bot Attack \u00d7 35% + Token Risk \u00d7 25%'
        + (_offName.length
            ? '&#10;&#10;A dimension that did not run counts as 0, so the weighted figure on its own would understate the risk. The level here is set by the worst dimension that did run.'
            : '')
        + '&#10;&#10;Execution: ' + (execRisk ? _exSc + '/100' : 'not checked')
        + ' \u00b7 Bot Attack: ' + (mevRisk ? _botSc + '/100' : 'not checked')
        + ' \u00b7 Token Risk: ' + (hasScore ? _tkSc + '/100' : 'not checked')
        + (_cmp.floored
            ? '&#10;&#10;Raised to ' + _compLvl + ': one dimension is ' + _compLvl
              + ' on its own. The worst risk sets the headline \u2014 averaging would hide it.'
            : '');
      const _sc = lvl => _c(lvl ?? 'LOW');
      // A check that failed is not still running — "scanning…" would promise a verdict.
      const _waiting = un => '<span style="font-size:12px;color:#FFB547">' + (un ? 'not checked' : 'scanning\u2026') + '</span>';
      const _subRows = _isSimple ? '' : (
        '<div style="margin-top:8px;border-top:1px solid ' + _cc + '22;padding-top:7px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">'
        +   '<span style="color:#C8C8D8;font-size:12px">Execution</span>'
        +   (_exLvl
              ? '<span style="color:' + _sc(_exLvl) + ';font-size:12px;font-weight:700;font-family:Space Mono,monospace">' + _exLvl + ' \u00b7 ' + _exSc + '/100</span>'
              : _waiting(false))
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">'
        +   '<span style="color:#C8C8D8;font-size:12px">Bot Attack</span>'
        +   (_botLvl
              ? '<span style="color:' + _sc(_botLvl) + ';font-size:12px;font-weight:700;font-family:Space Mono,monospace">' + _botLvl + ' \u00b7 ' + _botSc + '/100</span>'
              : _waiting(!!ns.axiomMintUnresolved))
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">'
        +   '<span style="color:#C8C8D8;font-size:12px">Token Risk</span>'
        +   (hasScore
              ? '<span style="color:' + _sc(_tkLvl) + ';font-size:12px;font-weight:700;font-family:Space Mono,monospace">' + _tkLvl + ' \u00b7 ' + _tkSc + '/100</span>'
              : _waiting(_tokenUnchecked))
        + '</div>'
        + '</div>'
      );
      const _overallCard =
        '<div title="' + _compTip + '" style="background:' + _cc + '11;border:1px solid ' + _cc + '44;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:help">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">'
        +   '<span style="color:' + _cc + ';font-weight:600">Overall Risk</span>'
        +   '<span style="font-weight:700;font-size:12px;font-family:Space Mono,monospace;color:' + _cc + '">' + _compBadge + '</span>'
        + '</div>'
        + _basisHtml
        + _subRows
        + '</div>';

      // ── Token Risk Score — shared builder from page-widget.js ─────────────
      const _tokenRiskCard = _tokenUnchecked
        ? _uncheckedCard
        : (ns._buildTokenRiskCard
            ? ns._buildTokenRiskCard(hasScore ? tokenScore : null, _isSimple)
            : '<div style="text-align:center;padding:12px 0;color:#C2C2D4;font-size:12px">Scanning token risk\u2026</div>');

      // ── Bot Attack Risk — real score from calculateMEVRisk ───────────────
      // Axiom is ranked among the most sandwiched DEX UIs (sandwiched.me).
      // mevProtection=false (the observed default) means raw RPC broadcast — fully exposed.
      let _botCard = '';
      if (!mevRisk) {
        // Green on a check that never ran reads as a pass, so the unresolved case
        // takes the same amber treatment as the token card.
        _botCard = ns.axiomMintUnresolved
          ? '<div style="background:rgba(255,181,71,0.07);border:1px solid rgba(255,181,71,0.35);border-radius:10px;padding:11px 13px;margin-bottom:10px">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:6px">'
            +   '<span style="color:#FFB547;font-weight:700">Bot attack risk could not be checked</span>'
            + '</div>'
            + (_isSimple ? '' :
                '<div style="color:#C2C2D4;font-size:12px;line-height:1.6;margin-bottom:6px">'
                + 'Sandwich scoring needs the token\u2019s pair type and liquidity depth, and neither can be read '
                + 'without identifying the token first. No route, trade-size or pair check has run.'
                + '</div>')
            + '<div style="color:#C2C2D4;font-size:12px;line-height:1.6">'
            +   '<b style="color:#E8E8F0">Assume this trade is exposed.</b> '
            +   'Axiom broadcasts direct to RPC with no Jito, and your slippage setting is checked below.'
            + '</div></div>'
          : '<div style="background:linear-gradient(135deg,rgba(20,241,149,0.05),rgba(153,69,255,0.05));border:1px solid rgba(20,241,149,0.18);border-radius:10px;padding:10px 12px;margin-bottom:10px">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">'
            + '<span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>'
            + _waiting(false)
            + '</div></div>';
      } else {
        const _mc   = _c(mevRisk.riskLevel);
        const _mbg  = 'background:' + _mc + '11;border:1px solid ' + _mc + '44';
        const _badge = _isSimple ? _rl(mevRisk.riskLevel) : (mevRisk.riskLevel + ' \u00b7 ' + (mevRisk.estimatedLossPercentage?.toFixed(2) ?? '0') + '% est. loss');
        const _mevTip = 'Bot Attack Risk \u2014 Axiom.trade is one of the most sandwiched platforms (sandwiched.me).'
          + '&#10;Raw RPC broadcast (mevProtection: off) = fully exposed to sandwich attacks.'
          + '&#10;Score 0\u2013100: LOW <20 | MEDIUM 20\u201339 | HIGH 40\u201369 | CRITICAL 70+';

        // MEV factor rows — Advanced mode
        let _mevRows = '';
        if (!_isSimple) {
          const _mf = mevRisk.factors ?? [];
          if (_mf.length) {
            // The trade-size floor overrides the rows above — show what it capped rather than a bare 0.
            const _cap = _mf.find(function (f) { return f.capped; });
            _mevRows = '<div style="margin-top:8px">' + _mf.map(function (f) {
              if (f.capped) {
                return '<div title="' + _esc(f.impact ?? '') + '" style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(20,241,149,0.08);border-left:2px solid #14F195;border-radius:0 5px 5px 0;margin-bottom:3px;cursor:help">'
                  + '<span style="font-size:12px;color:#14F195">' + _esc(f.factor) + '</span>'
                  + '<span style="font-size:9px;font-weight:700;color:#14F195;font-family:Space Mono,monospace;flex-shrink:0;margin-left:6px">' + f.capped.from + ' \u2192 ' + f.capped.to + '</span>'
                  + '</div>';
              }
              const fc = ns.mevFactorColor(f.score);
              // Superseded rows keep full label contrast — the strikethrough and grey
              // border carry the meaning, so dimming the text only costs legibility.
              const _bd = _cap ? 'rgba(255,255,255,0.14)' : fc;
              const _sc = _cap ? '#8A8AA3;text-decoration:line-through' : fc;
              return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ' + _bd + ';border-radius:0 5px 5px 0;margin-bottom:3px">'
                + '<span style="font-size:12px;color:#C0C0D8">' + _esc(f.factor) + '</span>'
                + '<span style="font-size:9px;font-weight:700;color:' + _sc + ';font-family:Space Mono,monospace;flex-shrink:0;margin-left:6px">' + f.score + '</span>'
                + '</div>';
            }).join('')
            + (_cap ? '<div style="font-size:11px;color:#8A8AA3;padding:3px 8px 0">Signals above superseded \u2014 final bot risk ' + _cap.capped.to + '/100</div>' : '')
            + '</div>';
          }
        }

        // Est. exposure row
        const _expUsd = mevRisk.estimatedLossUSD > 0.0001
          ? '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">'
            + '<span style="color:#C2C2D4;cursor:help" title="Estimated dollar value bots could extract from this swap. Based on trade size and slippage tolerance. Actual trade amount not yet known.">Est. Exposure</span>'
            + '<span style="font-weight:700;font-family:Space Mono,monospace;font-size:12px;color:#FFB547">~$' + mevRisk.estimatedLossUSD.toFixed(4) + '</span>'
            + '</div>'
          : '';

        if (_isSimple) {
          _botCard = '<div title="' + _mevTip + '" style="' + _mbg + ';border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">'
            + '<span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>'
            + '<span style="font-weight:700;font-size:12px;font-family:Space Mono,monospace;color:' + _mc + '">' + _badge + '</span>'
            + '</div></div>';
        } else {
          _botCard = '<div title="' + _mevTip + '" style="' + _mbg + ';border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06)">'
            + '<span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>'
            + '<span style="font-weight:700;font-size:12px;font-family:Space Mono,monospace;color:' + _mc + '">' + _badge + '</span>'
            + '</div>'
            + _mevRows
            + _expUsd
            + '</div>';
        }
      }

      // ── Execution Risk — shared builder; execRisk from calculateRisk ─────
      const _execCard = ns._buildExecutionRiskCard
        ? (ns._buildExecutionRiskCard(execRisk ?? null, _isSimple) || '<div style="background:rgba(255,181,71,0.06);border:1px solid rgba(255,181,71,0.2);border-radius:10px;padding:10px 12px;margin-bottom:10px"><div style="color:#FFB547;font-size:12px">Execution Risk — scanning\u2026</div></div>')
        : '';

      // ── Trade fees — what the active preset will pay, shown before the trade ─
      // Axiom's bribe is a flat SOL amount, so on a small trade it can exceed the
      // trade itself. Shown rather than changed: the bribe buys block inclusion,
      // and lowering it trades money for the risk of a trade that never lands.
      const _feeCard = (function () {
        // solPresets is Solana-denominated, so labelling it SOL is only correct here.
        if (!_isSolana()) return '';
        const _fs = _readSettings();
        if (!_fs) return '';
        const _fSide = ns.axiomPendingSide === 'sell' ? 'sell' : 'buy';
        const _fp = _preset(_fs, _fs.currentSolPresetKey, _fSide);
        if (!_fp) return '';
        // With autoFee on, Axiom sizes the fee itself and the preset numbers are not what gets paid.
        if (_fp.autoFee) return '';

        const _prio  = parseFloat(_fp.priorityFeeSol);
        const _bribe = parseFloat(_fp.bribeFeeSol);
        const _hasP  = !isNaN(_prio)  && _prio  > 0;
        const _hasB  = !isNaN(_bribe) && _bribe > 0;
        if (!_hasP && !_hasB) return '';
        const _tot = (_hasP ? _prio : 0) + (_hasB ? _bribe : 0);

        // Only a buy's SOL leg is known up front; a sell's proceeds are not, so the
        // ratio is omitted there rather than invented from an unrelated buy amount.
        const _legSol = _fSide === 'buy' ? (_readBuyAmountFromButton() ?? _axiomBuyAmountSol) : null;
        const _pct    = _legSol > 0 ? (_tot / _legSol * 100) : null;
        const _fc = _pct == null ? '#C2C2D4'
          : _pct >= 50 ? '#FF4444'
          : _pct >= 20 ? '#FF6B00'
          : _pct >= 10 ? '#FFB547'
          : '#14F195';

        const _sol = function (n) {
          return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + ' SOL';
        };
        const _badge = _pct != null
          ? _pct.toFixed(_pct < 10 ? 1 : 0) + '% of trade'
          : _sol(_tot);
        const _feeTip = 'Fees configured in your active ' + _fSide + ' preset (' + _esc(String(_fs.currentSolPresetKey ?? '')) + ').'
          + '&#10;The bribe is a flat SOL amount and does not scale with trade size.'
          + '&#10;Axiom has been observed settling slightly above these figures.'
          + '&#10;ZendIQ shows these fees but never changes them \u2014 the bribe buys block inclusion.';

        const _row = function (label, val, colour) {
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px">'
            + '<span style="color:#C2C2D4">' + label + '</span>'
            + '<span style="font-family:Space Mono,monospace;font-weight:700;color:' + (colour ?? '#E8E8F0') + '">' + _esc(val) + '</span>'
            + '</div>';
        };

        // A flat fee is only worth calling out when it is large next to the trade.
        const _warn = (_pct != null && _pct >= 20)
          ? '<div style="font-size:11px;color:' + _fc + ';line-height:1.5;margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,0.08)">'
            + 'This is a flat fee, so it costs the same on any trade size. Lower the bribe in your Axiom '
            + _fSide + ' preset to keep it proportionate.</div>'
          : (_fSide === 'sell'
            ? '<div style="font-size:11px;color:#6B6B8A;line-height:1.5;margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,0.08)">'
              + 'Sell proceeds are not known until the trade settles \u2014 ZendIQ shows what this cost as a share of '
              + 'your proceeds in Activity afterwards.</div>'
            : '');

        const _detail = _isSimple ? '' :
            (_hasP ? _row('Priority fee', _sol(_prio)) : '')
          + (_hasB ? _row('Bribe', _sol(_bribe)) : '')
          + ((_hasP && _hasB)
              ? '<div style="border-top:1px solid rgba(255,255,255,0.08);margin-top:4px;padding-top:4px">'
                + _row('Total', _sol(_tot), _fc) + '</div>'
              : '');

        return '<div title="' + _feeTip + '" style="background:' + _fc + '0E;border:1px solid ' + _fc + '3A;border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px' + (_detail ? ';margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06)' : '') + '">'
          +   '<span style="color:' + _fc + ';font-weight:600">' + (_fSide === 'sell' ? 'Sell' : 'Buy') + ' Fees</span>'
          +   '<span style="font-weight:700;font-size:12px;font-family:Space Mono,monospace;color:' + _fc + '">' + _esc(_badge) + '</span>'
          + '</div>'
          + _detail
          + _warn
          + '</div>';
      })();

      // ── Optimization abandoned — settings untouched, trade still held ─────
      // Deliberately has no dismiss timer and survives re-render: the user asked
      // for protection and did not get it, so the fallback is theirs to choose
      // rather than ours to assume.
      const _abWhy = {
        'navigated-away':       'You moved to another page, so the approval for the previous token was dropped.',
        'chain-not-supported':  'The page moved to a chain ZendIQ does not cover, so the approval was dropped.',
        'no-undo-record':       'ZendIQ could not save the record it needs to undo the change.',
        'settings-unreadable':  'ZendIQ could not read your Axiom settings safely.',
        'settings-write-failed':'Axiom rejected the settings change.',
        'mirror-unwritable':    'The change could not be applied to this browser, so it was undone.',
        'unknown-field':        'A setting ZendIQ needed to change was not in the expected format.',
        // Amber, not the grey line below: a failure to verify is not a choice not to act.
        'obligation-unreadable':'ZendIQ could not confirm an earlier change had already been undone.',
      };
      // Chose not to act, rather than tried and failed. Kept out of the amber card
      // on purpose: putting "we did nothing" beside "your account may still be
      // changed" teaches the user to dismiss the one that matters.
      const _skipWhy = {
        'startup':              'ZendIQ was still starting up. Try again in a moment.',
        'locked':               'Another Axiom tab was mid-change.',
        'restore-outstanding':  'ZendIQ was finishing an earlier restore first.',
      };
      const _abReason = ns.axiomOptimizeAbandoned?.why ?? null;
      const _abandonHtml = (_abReason && !_skipWhy[_abReason])
        ? '<div style="background:rgba(255,181,71,0.10);border:1px solid rgba(255,181,71,0.45);border-radius:8px;padding:9px 12px;margin-bottom:10px">'
          + '<div style="color:#FFB547;font-size:13px;font-weight:700;margin-bottom:3px">\u26a0 Could not optimize this trade</div>'
          + '<div style="color:#C2C2D4;font-size:12px;line-height:1.5">'
          +   _esc(_abWhy[_abReason] ?? 'ZendIQ could not apply the safer preset.')
          +   ' Your Axiom settings were left exactly as they were, and nothing has been sent yet.</div>'
          + '</div>'
        : '';
      const _skipHtml = (_abReason && _skipWhy[_abReason])
        ? '<div style="color:#6B6B8A;font-size:11.5px;line-height:1.5;margin-bottom:10px;padding:0 2px">'
          + 'Not optimized \u2014 ' + _esc(_skipWhy[_abReason]) + ' Nothing has been sent yet.</div>'
        : '';

      // ── Outstanding restore — split by surface ───────────────────────────
      // "This browser" and "your Axiom account" are different problems with
      // different remedies, and only one of them follows the user to another device.
      const _ob = ns.axiomObligation;
      const _obHtml = (_ob && !(_ob.localRestored && _ob.serverRestored)) ? (function () {
        const _f = _ob.fields?.slippage ?? _ob.serverFields?.slippage ?? null;
        const _mine  = _f ? _f.to   : null;   // the value ZendIQ set
        const _yours = _f ? _f.from : null;   // the value the user had
        const _localOwed  = !_ob.localRestored;
        const _serverOwed = !_ob.serverRestored;
        const _ask = !!_ob.needsDecision;
        const _col = _ask ? '#FF6B6B' : '#FFB547';
        const _where = _localOwed && _serverOwed ? 'this browser and your Axiom account'
                     : _serverOwed ? 'your Axiom account'
                     : 'this browser';
        const _body = _ask
          ? (_f
              ? 'ZendIQ changed your ' + (_ob.side === 'sell' ? 'sell' : 'buy') + ' slippage to ' + _esc(String(_mine)) + '% for a trade and has not been able to '
                + 'confirm it was put back on ' + _where + '. It has been long enough that this may now be your own setting, '
                + 'so ZendIQ will not change it without you.'
              : 'ZendIQ has not been able to confirm a settings change was put back on ' + _where + '. '
                + 'It has been long enough that ZendIQ will not change anything without you.')
          : 'ZendIQ is still restoring your original trade settings on ' + _where + '. '
            + (_serverOwed ? 'Your Axiom account is reachable from any device, so this follows you. ' : '')
            + 'It will retry automatically.';
        const _actions = _ask && _f
          ? '<div style="display:flex;gap:7px;margin-top:9px">'
            + '<button id="sr-ax-restore" style="flex:1;padding:9px;border:none;border-radius:7px;background:linear-gradient(135deg,#14F195,#0cc97a);color:#061a10;font-size:12px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">Restore ' + _esc(String(_yours)) + '%</button>'
            + '<button id="sr-ax-keep" style="flex:1;padding:9px;border:1px solid rgba(255,255,255,0.14);border-radius:7px;background:none;color:#C2C2D4;font-size:12px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif">Keep ' + _esc(String(_mine)) + '%</button>'
            + '</div>'
          : '<button id="sr-ax-reload" style="width:100%;padding:9px;margin-top:9px;border:1px solid rgba(255,255,255,0.14);border-radius:7px;background:none;color:#C2C2D4;font-size:12px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif">Reload and retry now</button>';
        return '<div style="background:' + _col + '14;border:1px solid ' + _col + '66;border-radius:8px;padding:10px 12px;margin-bottom:10px">'
          + '<div style="color:' + _col + ';font-size:13px;font-weight:700;margin-bottom:4px">\u26a0 '
          + (_ask ? 'Your Axiom settings need a decision' : 'Restoring your Axiom settings') + '</div>'
          + '<div style="color:#C2C2D4;font-size:12px;line-height:1.55">' + _body + '</div>'
          + _actions
          + '</div>';
      })() : '';

      // ── Impact warning for HIGH / CRITICAL combined risk ─────────────────
      const _warnLvl = _hasAnyRisk && (_comp >= 40 || _botSc >= 40)
        ? (_comp >= 70 || _botSc >= 70 ? 'CRITICAL' : 'HIGH')
        : null;
      const _impactHtml = (_warnLvl && !ns.axiomRiskAcknowledged)
        ? '<div style="background:' + _c(_warnLvl) + '11;border:1px solid ' + _c(_warnLvl) + '33;border-radius:8px;padding:9px 12px;margin-bottom:10px">'
          + '<div style="color:' + _c(_warnLvl) + ';font-size:13px;font-weight:700;margin-bottom:3px">\u26a0 '
          + (_warnLvl === 'CRITICAL' ? 'Critical' : 'High') + ' sandwich risk on '
          + (ns.axiomMintUnresolved ? 'these trade settings' : 'this token') + '</div>'
          + '<div style="color:#C2C2D4;font-size:12px;line-height:1.5">Axiom broadcasts direct to RPC (no Jito by default). ZendIQ will show this panel before each trade \u2014 use Cancel if concerned.</div>'
          + '</div>'
        : '';

      // ── Footer: Proceed/Cancel (intercept) or Got-it (browse) ─────────────
      const _isSellSide = ns.axiomPendingSide === 'sell';
      const _slipPct   = ((_readAxiomSlippage(ns.axiomPendingSide) ?? ns.axiomLastSlippage ?? 0.20) * 100).toFixed(1);
      // The amount reader parses the Buy button, so it describes no sell.
      const _buyAmt    = _isSellSide ? null : (_readBuyAmountFromButton() ?? _axiomBuyAmountSol);
      const _amtLabel  = _buyAmt
        ? 'Trading <b>' + _buyAmt + ' SOL</b> at <b>' + _slipPct + '% slippage</b>'
        : 'Slippage tolerance: <b>' + _slipPct + '%</b>';

      // Optimization breakdown — only while a buy is intercepted and there is
      // something worth changing (lower slippage and/or MEV Secure).
      const _opt = ns.axiomConfirmPending ? _computeOptimization(ns.axiomPendingSide) : null;
      const _optCard = _opt ? (function () {
        const _rows = _opt.changes.map(function (c) {
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px">'
            + '<span style="color:#C2C2D4">' + _esc(c.label) + '</span>'
            + '<span style="font-family:Space Mono,monospace;font-weight:700">'
            +   '<span style="color:#FF6B6B">' + _esc(c.from) + '</span>'
            +   '<span style="color:#6B6B8A"> \u2192 </span>'
            +   '<span style="color:#14F195">' + _esc(c.to) + '</span>'
            + '</span></div>';
        }).join('');
        const _sav = _opt.estSavingsUsd > 0.0001
          ? '~$' + _opt.estSavingsUsd.toFixed(_opt.estSavingsUsd < 1 ? 4 : 2)
          : 'Lower exposure';
        return '<div style="background:linear-gradient(135deg,rgba(20,241,149,0.08),rgba(20,241,149,0.03));border:1px solid rgba(20,241,149,0.35);border-radius:10px;padding:11px 13px;margin-bottom:10px">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;padding-bottom:7px;border-bottom:1px solid rgba(20,241,149,0.18)">'
          +   '<span style="color:#14F195;font-weight:700;font-size:13px">\ud83d\udee1 ZendIQ Optimization</span>'
          +   '<span title="Estimated exposure removed by tighter slippage + MEV Secure. Not a guaranteed gain." style="color:#14F195;font-weight:700;font-size:12px;font-family:Space Mono,monospace;cursor:help">' + _sav + '</span>'
          + '</div>'
          + _rows
          + '<div style="font-size:10.5px;color:#6B8B7A;line-height:1.5;margin-top:7px">Applied to your active ' + (_opt.side === 'sell' ? 'sell' : 'buy') + ' preset for this trade only, then restored automatically.</div>'
          + '</div>';
      })() : '';

      // Pinned with the buttons below: what the trade changes has to be on screen
      // next to the button that agrees to it, not somewhere up the card stack.
      const _footerInfo = (ns.axiomAutoAccepting || ns.axiomConfirmPending)
        ? '<div style="font-size:12px;color:#C2C2D4;margin-bottom:8px;text-align:center">' + _amtLabel + '</div>' + _optCard
        : '';
      const _footerBtns = ns.axiomAutoAccepting
        ? '<div style="width:100%;padding:11px;border:1px solid rgba(20,241,149,0.35);border-radius:8px;background:rgba(20,241,149,0.06);color:#14F195;font-size:13px;font-weight:700;text-align:center;font-family:\'DM Sans\',sans-serif">\u23f3 Optimizing your ' + (_isSellSide ? 'sell' : 'buy') + '\u2026</div>'
        : ns.axiomConfirmPending
        ? (_opt
              ? '<button id="sr-ax-optimize" style="width:100%;padding:11px;border:none;border-radius:8px;background:linear-gradient(135deg,#14F195,#0cc97a);color:#061a10;font-size:13px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif;margin-bottom:7px">Optimize &amp; ' + (_isSellSide ? 'Sell' : 'Buy') + '</button>'
                + '<button id="sr-ax-proceed" style="width:100%;padding:9px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:none;color:#C2C2D4;font-size:12px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif;margin-bottom:7px">Proceed without optimizing</button>'
              : '<button id="sr-ax-proceed" style="width:100%;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#14F195,#0cc97a);color:#061a10;font-size:13px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif;margin-bottom:7px">\u2713 Proceed with trade</button>')
          + '<button id="sr-ax-cancel" style="width:100%;padding:10px;border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:none;color:#C2C2D4;font-size:12px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif">\u2715 Cancel trade</button>'
        : ns.axiomRiskAcknowledged
          ? ''
          : '<button id="sr-ax-close" style="width:100%;padding:10px;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(255,255,255,0.04);color:#C2C2D4;font-size:13px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif;transition:background 0.15s">\u2713 Got it \u2014 close</button>';
      const _disclaimer = ns.axiomAutoAccepting
        ? '<div style="font-size:11px;color:#4A4A6A;line-height:1.55;margin:0 0 10px;padding:0 2px">Auto-accept is on — ZendIQ is applying the optimization and placing your ' + (_isSellSide ? 'sell' : 'buy') + '. Turn it off in Settings to review each trade.</div>'
        : ns.axiomConfirmPending
        ? (_opt
            ? '<div style="font-size:11px;color:#4A4A6A;line-height:1.55;margin:0 0 10px;padding:0 2px">ZendIQ tightens your preset for this trade only and restores your original settings the moment it settles.</div>'
            : '<div style="font-size:11px;color:#4A4A6A;line-height:1.55;margin:0 0 10px;padding:0 2px">Your preset is already safe. ZendIQ cannot re-route Axiom trades \u2014 cancel and lower slippage manually to reduce risk further.</div>')
        : ns.axiomRiskAcknowledged
          ? ''
          : ns.axiomMintUnresolved
            ? '<div style="font-size:11px;color:#FFB547;line-height:1.55;margin:0 0 12px;padding:0 2px">ZendIQ cannot identify this token, so it will not step in front of your trade \u2014 clicking Buy or Sell goes straight to Axiom, unchecked.</div>'
            : _tokenUnchecked
              ? '<div style="font-size:11px;color:#FFB547;line-height:1.55;margin:0 0 12px;padding:0 2px">ZendIQ intercepts each trade, but the token risk check did not run on this one.</div>'
              : '<div style="font-size:11px;color:#4A4A6A;line-height:1.55;margin:0 0 12px;padding:0 2px">ZendIQ intercepts each trade to show this risk check.</div>';

      return '<div style="padding:14px 16px 0">'
        + (_token ? '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.7px;color:#6B6B8A;margin-bottom:10px">TOKEN RISK \u00b7 ' + _sym + '</div>' : '')
        + _consentHtml
        + _obHtml
        + _abandonHtml
        + _skipHtml
        + _overallCard
        + _tokenRiskCard
        + _botCard
        + _execCard
        + _feeCard
        + _impactHtml
        + (_footerBtns
            ? '<div style="position:sticky;bottom:0;z-index:10;margin:0 -16px;padding:9px 16px 12px;background:#12121E;border-top:1px solid rgba(255,255,255,0.06)">' + _footerInfo + _disclaimer + _footerBtns + '</div>'
            : _footerInfo + _disclaimer + '<div style="height:14px"></div>')
        + '</div>';
    },
  });

})();
