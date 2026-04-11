/**
 * ZendIQ popup — monitor
 * Renders the Monitor tab content (active/inactive state).
 */

const PROFILE_TRIGGER_COPY = {
  alert:    'By default it appears on <strong style="color:var(--text)">every swap</strong> — so you\'ll always see the optimised alternative before signing.',
  balanced: 'Your <strong style="color:var(--text)">Auto-Profit</strong> profile means it only steps in when the optimised route puts more money in your pocket after all fees.',
  focused:  'Your <strong style="color:var(--text)">Major Wins Only</strong> profile means it only activates when there\'s a routing gain above $10 — small improvements are skipped.',
  custom:   'It activates based on your <strong style="color:var(--text)">custom thresholds</strong> — adjust them any time in Settings.',
};

async function loadMonitor() {
  const el = document.getElementById('monitor-status');
  el.innerHTML = '<div class="monitor-idle">Checking&hellip;</div>';

  const [tab, stored] = await Promise.all([
    findDexTab(),
    new Promise(resolve => chrome.storage.local.get(['settings'], r => resolve(r.settings ?? {}))),
  ]);

  const profile     = stored.profile ?? 'alert';
  const triggerCopy = PROFILE_TRIGGER_COPY[profile] ?? PROFILE_TRIGGER_COPY.alert;

  if (tab?.id) {
    const site = _dexSiteFromTab(tab);

    // Check whether the widget is currently hidden on that tab
    let widgetHidden = false;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => { const w = document.getElementById('sr-widget'); return !!w && w.style.display === 'none'; },
      });
      widgetHidden = !!result;
    } catch {}

    const hiddenBanner = widgetHidden ? `
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;padding:9px 11px;background:rgba(255,181,71,0.08);border:1px solid rgba(255,181,71,0.28);border-radius:8px;font-size:var(--fs-base);color:#FFB547;line-height:1.55">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:2px"><path d="M12 9v4m0 4h.01" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>The ZendIQ widget is <strong style="color:#FFB547">hidden</strong> on <a href="${site.href}" target="_blank" rel="noopener" style="color:#FFB547;font-weight:700;text-decoration:underline">${site.name}</a>. Click <button id="mon-widget-enable" style="background:none;border:none;padding:0;font-size:inherit;font-family:inherit;font-weight:700;color:var(--purple);cursor:pointer;text-decoration:underline">Widget</button> above or the toggle to show it again.</span>
      </div>` : '';

    el.innerHTML = `
      ${hiddenBanner}
      <div class="monitor-active">
        <span class="mon-status-dot"></span>
        <strong style="color:var(--text)">Monitoring active</strong><br>
        <span style="font-size:var(--fs-base);line-height:1.6">
          Trade on <a href="${site.href}" target="_blank" rel="noopener" style="color:${site.color};font-weight:700;text-decoration:none">${site.name}</a> as normal.<br><br>
          ${triggerCopy}<br><br>
          <span style="color:var(--muted)">Adjust when the widget triggers in the <a id="mon-go-settings-active" style="color:var(--purple);text-decoration:none;cursor:pointer">Settings</a> tab.</span>
        </span>
      </div>`;
    const settingsLinkActive = el.querySelector('#mon-go-settings-active');
    if (settingsLinkActive) settingsLinkActive.addEventListener('click', () => showTab('settings'));

    // Clickable "Widget" text in the hidden-widget banner
    const monWidgetEnable = el.querySelector('#mon-widget-enable');
    if (monWidgetEnable) {
      monWidgetEnable.addEventListener('click', () => {
        const toggle = document.getElementById('widget-toggle');
        chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => {
            const w = document.getElementById('sr-widget');
            if (!w) return;
            w.style.display = '';
            if (!w.classList.contains('expanded')) window.__zq?.openZendIQPanel();
          },
        }).then(() => {
          if (toggle) { toggle.checked = true; }
          // Reload monitor tab to remove the banner
          loadMonitor();
        }).catch(() => {});
      });
    }
  } else {
    el.innerHTML = `
      <div class="monitor-inactive">
        <span class="mon-status-dot"></span>
        <strong style="color:var(--text)">Monitoring not active</strong>
        <ol class="monitor-steps">
          <li><div class="ms-num">1</div><span>Open <a href="https://jup.ag" target="_blank" rel="noopener" style="color:var(--purple);font-weight:700;text-decoration:none">jup.ag</a>, <a href="https://raydium.io/swap/" target="_blank" rel="noopener" style="color:var(--purple);font-weight:700;text-decoration:none">Raydium</a>, or <a href="https://pump.fun" target="_blank" rel="noopener" style="color:var(--purple);font-weight:700;text-decoration:none">pump.fun</a> in this browser</span></li>
          <li><div class="ms-num">2</div><span>Connect your Solana wallet</span></li>
          <li><div class="ms-num">3</div><span>Trade as normal — ZendIQ will appear automatically before you sign and show you if a better route is available</span></li>
        </ol>
        <div class="monitor-or">You can control when the widget activates in the <a id="mon-go-settings" style="color:var(--purple);text-decoration:none;cursor:pointer"><strong>Settings</strong></a> tab.</div>
      </div>`;
    const settingsLink = el.querySelector('#mon-go-settings');
    if (settingsLink) settingsLink.addEventListener('click', () => showTab('settings'));
    const swapLink = el.querySelector('#mon-go-swap');
    if (swapLink) swapLink.addEventListener('click', () => showTab('swap'));
  }
}

