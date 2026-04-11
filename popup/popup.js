/**
 * ZendIQ popup.js — init + event wiring
 * All logic lives in the popup-*.js modules loaded before this file.
 * Load order: config → wallet → ui → swap → monitor → activity → settings → captured → this
 */

// ── Background message bridge ──────────────────────────────────────────────

// Sync footer version from manifest.json so it is never out of date
document.getElementById('footer-version').innerHTML =
  `v${chrome.runtime.getManifest().version} &middot; <span style="color:#9945FF">Open Beta</span>`;

function bgMsg(payload) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(payload, response => {
        if (chrome.runtime.lastError) {
          return reject(new Error('BG: ' + chrome.runtime.lastError.message));
        }
        if (!response?.ok) return reject(new Error(response?.error || 'BG error'));
        resolve(response.data);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ── Live sync: refresh popup UI when widget saves a setting or history updates ──
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    // Throttle: only re-apply if the popup panel is visible and already initialised
    if (document.readyState === 'complete' && typeof restoreSettings === 'function') {
      restoreSettings();
    }
  }
  if (changes.sendiq_swap_history) {
    // Re-render Activity tab if it's currently open so on-chain data appears without requiring tab switch
    if (document.getElementById('panel-activity')?.classList.contains('active') && typeof loadActivity === 'function') {
      loadActivity();
    }
  }
  if (changes.secLastResult) {
    // Wallet scan result updated (e.g. widget ran a scan) — update display only.
    // Do NOT call initSecurityBadge() here: it always calls runCheck() which saves
    // secLastResult again, firing this handler again → infinite scan/blink loop.
    if (typeof refreshSecurityDisplay === 'function') {
      refreshSecurityDisplay(changes.secLastResult.newValue);
    }
  }
  // secReviewed_<type> changed (e.g. widget reviewed toggle flipped) — refresh display
  if (Object.keys(changes).some(k => k.startsWith('secReviewed_'))) {
    if (typeof loadSecurity === 'function') loadSecurity();
  }
});

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildPickers();
  loadMonitor();
  detectWallet()
    .then(() => initSecurityBadge())
    .catch(e => console.error('[ZendIQ] detectWallet error:', e));

  // ── First-launch onboarding ─────────────────────────────────────────────
  chrome.storage.local.get(['sendiq_onboarded', 'sendiq_pending_tab'], ({ sendiq_onboarded, sendiq_pending_tab }) => {
    if (sendiq_pending_tab) {
      // Widget requested a specific tab (e.g. "Open ZendIQ popup" from Wallet tab)
      chrome.storage.local.remove('sendiq_pending_tab');
      showTab(sendiq_pending_tab);
      // Do NOT call loadSecurity() here — detectWallet().then(initSecurityBadge)
      // runs concurrently and owns the initial scan. Calling loadSecurity() before
      // walletPubkey is set causes a double-scan and the scanning/score glitch.
      return;
    }
    if (!sendiq_onboarded) {
      document.getElementById('onboarding-card').classList.add('show');
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    }
  });
  document.getElementById('ob-dismiss').addEventListener('click', () => {
    chrome.storage.local.set({ sendiq_onboarded: true });
    // Notify open jup.ag tabs so widget welcome card hides immediately
    chrome.runtime.sendMessage({ type: 'PUSH_ONBOARDED' });
    document.getElementById('onboarding-card').classList.remove('show');
    showTab('security');
    loadSecurity();
  });

  // ── Tab navigation ─────────────────────────────────────────────────────
  document.getElementById('tab-swap').addEventListener('click',     () => showTab('swap'));
  document.getElementById('tab-monitor').addEventListener('click',  () => showTab('monitor'));
  document.getElementById('tab-activity').addEventListener('click', () => showTab('activity'));
  document.getElementById('tab-settings').addEventListener('click', () => showTab('settings'));
  document.getElementById('tab-security').addEventListener('click', () => { showTab('security'); loadSecurity(); });

  // ── Swap tab ───────────────────────────────────────────────────────────
  document.getElementById('sel-in').addEventListener('click',   () => togglePicker('in'));
  document.getElementById('sel-out').addEventListener('click',  () => togglePicker('out'));
  document.getElementById('btn-flip').addEventListener('click',  flipTokens);
  document.getElementById('btn-quote').addEventListener('click', getQuote);
  document.getElementById('btn-swap').addEventListener('click',  sendSwap);
  document.getElementById('amount-in').addEventListener('input', resetQuote);

  // ── Widget toggle ───────────────────────────────────────────────────
  (async () => {
    const toggle = document.getElementById('widget-toggle');
    const tab = await findDexTab().catch(() => null);
    if (!tab?.id) return;
    toggle.disabled = false;
    // Reflect current widget expanded + visible state
    chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: () => {
        const w = document.getElementById('sr-widget');
        return !!w && w.style.display !== 'none' && w.classList.contains('expanded');
      },
    }).then(([{ result }]) => { toggle.checked = !!result; }).catch(() => {});
    toggle.addEventListener('change', () => {
      const show = toggle.checked;
      chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: (show) => {
          const w = document.getElementById('sr-widget');
          if (!w) return;
          if (show) {
            w.style.display = '';
            if (!w.classList.contains('expanded')) window.__zq?.openZendIQPanel();
          } else {
            // Collapse first so state is clean, then hide completely
            w.classList.remove('expanded');
            w.style.display = 'none';
          }
        },
        args: [show],
      }).catch(() => {});
      // Note: popup intentionally stays open so the user can see the state change
    });
  })();

  // ── U1 hint link — focus existing jup.ag tab or open a new one ─────────
  document.getElementById('hint-go-jup').addEventListener('click', () => {
    findDexTab().then(tab => {
      if (tab?.id) {
        chrome.tabs.update(tab.id, { active: true });
        chrome.windows.update(tab.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: 'https://jup.ag' });
      }
      window.close();
    }).catch(() => { chrome.tabs.create({ url: 'https://jup.ag' }); window.close(); });
  });

  // ── U1 hint link — open widget on jup.ag tab ──────────────────────────
  document.getElementById('hint-open-widget').addEventListener('click', () => {
    findDexTab().then(tab => {
      if (tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => {
            if (!window.__zq) return;
            const w = document.getElementById('sr-widget');
            if (!w || !w.classList.contains('expanded')) {
              window.__zq.openZendIQPanel();
            }
          },
        }).catch(() => {});
        chrome.tabs.update(tab.id, { active: true });
        chrome.windows.update(tab.windowId, { focused: true });
        window.close();
      } else {
        chrome.tabs.create({ url: 'https://jup.ag' });
        window.close();
      }
    }).catch(() => { chrome.tabs.create({ url: 'https://jup.ag' }); window.close(); });
  });

  // ── Settings tab ───────────────────────────────────────────────────────

  document.getElementById('auto-protect').addEventListener('change', () => {
    const apHint = document.getElementById('auto-protect-hint');
    if (apHint) apHint.style.display = document.getElementById('auto-protect').checked ? '' : 'none';
    saveSettings();
    findDexTab().then(tab => {
      if (!tab?.id) return;
      chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: v => { if (window.__zq) window.__zq.autoProtect = v; },
        args: [document.getElementById('auto-protect').checked],
      }).catch(() => {});
    }).catch(() => {});
  });

  document.getElementById('auto-accept').addEventListener('change', () => {
    const checked = document.getElementById('auto-accept').checked;
    const hint = document.getElementById('auto-accept-hint');
    if (hint) hint.style.display = checked ? '' : 'none';
    saveSettings();
    findDexTab().then(tab => {
      if (!tab?.id) return;
      chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: v => { if (window.__zq) window.__zq.autoAccept = v; },
        args: [checked],
      }).catch(() => {});
    }).catch(() => {});
  });

  document.querySelectorAll('.profile-btn').forEach(btn =>
    btn.addEventListener('click', () => setProfile(btn.dataset.profile)));

  document.querySelectorAll('#custom-thresholds .mode-btn[data-level]').forEach(btn =>
    btn.addEventListener('click', () => setMinRisk(btn.dataset.level)));

  document.getElementById('thresh-loss-usd').addEventListener('input', () => { saveSettings(); syncThresholdsToPage(); });
  document.getElementById('thresh-slippage').addEventListener('input',  () => { saveSettings(); syncThresholdsToPage(); });

  // Priority fee mode radio buttons
  document.querySelectorAll('input[name="jito-mode"]').forEach(radio =>
    radio.addEventListener('change', () => { saveSettings(); syncThresholdsToPage(); }));

  // ── Restore persisted settings ──────────────────────────────────────────
  restoreSettings();

  // ── Background health check ─────────────────────────────────────────────
  bgMsg({ type: 'PING' })
    .catch(e => console.error('[ZendIQ] Background service worker DEAD:', e.message));

  // ── Handle captured trade from widget interceptor ───────────────────────
  checkCapturedTrade();
});
