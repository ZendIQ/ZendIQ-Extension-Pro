/**
 * ZendIQ – page-badge.js
 * Injects a "ZendIQ" pill badge above Jupiter's Swap button and a subtle
 * purple glow on the button itself to signal that ZendIQ is monitoring.
 *
 * Runs in MAIN world. No network calls.
 * Load order: after page-interceptor.js (last file in the MAIN world list).
 *
 * React resilience: `data-zq="1"` is re-applied via MutationObserver whenever
 * React re-renders the button's parent. The badge itself lives in document.body
 * outside React's tree and is positioned via getBoundingClientRect().
 */

(function () {
  'use strict';

  const ns = window.__zq;
  if (!ns) return;

  // ── Defer all DOM work until document.head + document.body exist ──────────
  function _init() {
    if (!document.head || !document.body) {
      return setTimeout(_init, 50);
    }
    _mount();
  }

  function _mount() {

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.id = 'zendiq-badge-style';
  style.textContent = `
    #zendiq-swap-badge {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(18,18,30,0.92);
      border: 1px solid rgba(20,241,149,0.25);
      border-radius: 30px;
      padding: 5px 12px 5px 7px;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 0 1px rgba(20,241,149,0.08);
      font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
      white-space: nowrap;
      opacity: 0;
      transform: translateX(-50%);
      transition: opacity 0.25s;
    }
    #zendiq-swap-badge.zq-visible {
      opacity: 1;
    }
    #zendiq-swap-badge .zq-name {
      font-size: 12px;
      font-weight: 700;
      color: #E8E8F0;
      letter-spacing: 0.1px;
    }
    #zendiq-swap-badge .zq-status {
      font-size: 11px;
      font-weight: 600;
      color: #14F195;
    }
    [data-zq="1"] {
      box-shadow: 0 0 0 2px rgba(20,241,149,0.35),
                  0 0 14px rgba(20,241,149,0.12) !important;
      transition: box-shadow 0.3s !important;
    }
  `;
  document.head.appendChild(style);

  // ── Badge element ─────────────────────────────────────────────────────────
  const badge = document.createElement('div');
  badge.id = 'zendiq-swap-badge';
  badge.innerHTML =
    '<svg viewBox="0 0 128 128" style="width:18px;height:18px;flex-shrink:0">' +
      '<defs>' +
        '<linearGradient id="zb_ring" x1="20%" y1="0%" x2="80%" y2="100%">' +
          '<stop offset="0%" stop-color="#00e5ff"/>' +
          '<stop offset="35%" stop-color="#5566ff"/>' +
          '<stop offset="65%" stop-color="#9922ff"/>' +
          '<stop offset="100%" stop-color="#cc44ff"/>' +
        '</linearGradient>' +
        '<linearGradient id="zb_iq" x1="0%" y1="0%" x2="40%" y2="100%">' +
          '<stop offset="0%" stop-color="#aa44ff"/>' +
          '<stop offset="100%" stop-color="#cc22ff"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="M 64 15 C 91 14, 113 35, 113 63 C 113 90, 93 112, 65 113 C 37 114, 15 93, 15 65 C 15 39, 33 18, 57 15"' +
      '      fill="none" stroke="url(#zb_ring)" stroke-width="9" stroke-linecap="round"/>' +
      '<text x="65" y="70" font-family="\'Arial Black\', Arial, sans-serif" font-weight="900" font-size="56"' +
      '      fill="url(#zb_iq)" text-anchor="middle" dominant-baseline="middle" letter-spacing="-2">IQ</text>' +
    '</svg>' +
    '<span class="zq-name">ZendIQ</span>' +
    '<span class="zq-status">Active</span>';
  document.body.appendChild(badge);

  // ── Button detection ───────────────────────────────────────────────────────
  // Uses the same text matcher as page-interceptor.js to stay in sync.
  function _findSwapButton() {
    const candidates = document.querySelectorAll('button, [role="button"]');
    for (const btn of candidates) {
      if (btn.closest('#sr-widget')) continue;          // skip ZendIQ widget
      if (btn.getAttribute('role') === 'tab') continue; // skip tab buttons
      const txt = btn.textContent?.trim().replace(/\s+/g, ' ');
      if (/^(confirm\s+)?swap$/i.test(txt)) return btn;
    }
    return null;
  }

  // ── React glow attribute ──────────────────────────────────────────────────
  // Applying `data-zq="1"` is safe: React ignores unknown data attributes on
  // DOM elements it doesn't know about. However, if it replaces the entire
  // button node (full re-render from parent), the attribute is lost — hence
  // the MutationObserver below.

  function _applyGlow(btn) {
    if (btn && btn.getAttribute('data-zq') !== '1') {
      btn.setAttribute('data-zq', '1');
    }
  }

  function _removeGlow(btn) {
    try { btn?.removeAttribute('data-zq'); } catch (_) {}
  }

  // ── MutationObserver — re-apply glow after React re-renders ──────────────
  let _currentBtn  = null;
  let _observer    = null;

  function _watchParent(btn) {
    if (_observer) { _observer.disconnect(); _observer = null; }
    const parent = btn?.parentNode;
    if (!parent) return;
    _observer = new MutationObserver(() => {
      // Re-find button in case React replaced the DOM node
      const fresh = _findSwapButton();
      if (fresh) {
        _currentBtn = fresh;
        _applyGlow(fresh);
      }
    });
    _observer.observe(parent, { childList: true, subtree: true });
  }

  // ── Badge visibility control (called externally if monitoring is toggled) ─
  let _badgeHidden = false;

  ns.updateSwapBadge = function (active) {
    _badgeHidden = !active;
    if (_badgeHidden) {
      badge.classList.remove('zq-visible');
      _removeGlow(_currentBtn);
    }
  };

  // ── Position loop (~4 fps) ────────────────────────────────────────────────
  function _tick() {
    try {
      const btn = _findSwapButton();

      // Button changed (new render or pair swap) — re-wire
      if (btn !== _currentBtn) {
        _removeGlow(_currentBtn);
        _currentBtn = btn;
        _watchParent(btn);
      }

      if (!btn || _badgeHidden) {
        badge.classList.remove('zq-visible');
        return;
      }

      _applyGlow(btn);

      const r = btn.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) {
        badge.classList.remove('zq-visible');
        return;
      }

      // Centre the badge above the button — clear by badge height + 8px gap
      const badgeH = badge.offsetHeight || 30;
      badge.style.left = (r.left + r.width / 2) + 'px';
      badge.style.top  = (r.top - badgeH - 8) + 'px';
      badge.classList.add('zq-visible');
    } catch (_) {}
  }

  // Start ticker
  setInterval(_tick, 250);

  // First tick once DOM is ready
  setTimeout(_tick, 400);

  } // end _mount()

  // Kick off — defer if document isn't ready yet
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
