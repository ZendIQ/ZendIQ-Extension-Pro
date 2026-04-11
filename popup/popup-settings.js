/**
 * ZendIQ popup — settings
 * Protection profiles, threshold inputs, UI mode toggle, persistence.
 */

const PROFILES = {
  // alert: intercept every swap — user reviews and decides each time
  alert:    { minRiskLevel: 'LOW',  minLossUsd: 0, minSlippage: 0 },
  // balanced: intercept every swap — ZendIQ only presents the review panel when
  // net benefit (routing gain − fees) is positive; profitability gate in fetchWidgetQuote
  balanced: { minRiskLevel: 'LOW',  minLossUsd: 0, minSlippage: 0 },
  // focused: only intercept high-stakes trades (HIGH risk + estimated bot loss ≥ $10)
  focused:  { minRiskLevel: 'HIGH', minLossUsd: 10, minSlippage: 2 },
};

function _getThreshValues() {
  return {
    minRiskLevel: document.querySelector('#custom-thresholds .mode-btn[data-level].active')?.dataset.level ?? 'LOW',
    minLossUsd:   parseFloat(document.getElementById('thresh-loss-usd')?.value) || 0,
    minSlippage:  parseFloat(document.getElementById('thresh-slippage')?.value)  || 0,
  };
}

function _applyThreshInputs(minRiskLevel, minLossUsd, minSlippage) {
  document.querySelectorAll('#custom-thresholds .mode-btn[data-level]').forEach(b =>
    b.classList.toggle('active', b.dataset.level === minRiskLevel));
  document.getElementById('thresh-loss-usd').value = minLossUsd;
  document.getElementById('thresh-slippage').value  = minSlippage;
}

function saveSettings() {
  const profile = document.querySelector('.profile-btn.active')?.dataset.profile ?? 'alert';
  const { minRiskLevel, minLossUsd, minSlippage } = _getThreshValues();
  const jm  = document.querySelector('input[name="jito-mode"]:checked')?.value ?? 'auto';
  jitoMode = jm;
  chrome.storage.local.set({ settings: {
    uiMode:      document.getElementById('mode-adv')?.classList.contains('active') ? 'advanced' : 'simple',
    autoProtect: document.getElementById('auto-protect')?.checked ?? false,
    autoAccept:  document.getElementById('auto-accept')?.checked  ?? false,
    pauseOnHighRisk: document.getElementById('pause-on-high-risk')?.checked ?? true,
    jitoMode:    jm,
    profile, minRiskLevel, minLossUsd, minSlippage,
  }});
}

function syncThresholdsToPage() { syncSettingsToPage(); }

function syncSettingsToPage() {
  const { minRiskLevel, minLossUsd, minSlippage } = _getThreshValues();
  const jm      = document.querySelector('input[name="jito-mode"]:checked')?.value ?? jitoMode;
  const profile = document.querySelector('.profile-btn.active')?.dataset.profile ?? 'alert';
  const aprot   = document.getElementById('auto-protect')?.checked  ?? false;
  const aaccept = document.getElementById('auto-accept')?.checked   ?? false;
  const pauseHR = document.getElementById('pause-on-high-risk')?.checked ?? true;
  const uiMode  = document.getElementById('mode-adv')?.classList.contains('active') ? 'advanced' : 'simple';
  findDexTab().then(tab => {
    if (!tab?.id) return;
    chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: (r, l, s, jito, prof, ap, aa, ui, phr) => {
        if (!window.__zq) return;
        window.__zq.threshMinRiskLevel = r;
        window.__zq.threshMinLossUsd   = l;
        window.__zq.threshMinSlippage  = s;
        window.__zq.jitoMode           = jito;
        window.__zq.settingsProfile    = prof;
        window.__zq.autoProtect        = ap;
        window.__zq.autoAccept         = aa;
        window.__zq.widgetMode         = ui;
        window.__zq.pauseOnHighRisk    = phr;
        window.__zq.renderWidgetPanel?.();
      },
      args: [minRiskLevel, minLossUsd, minSlippage, jm, profile, aprot, aaccept, uiMode, pauseHR],
    }).catch(() => {});
  }).catch(() => {});
}

function setProfile(name) {
  document.querySelectorAll('.profile-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.profile === name));
  const isCustom = name === 'custom';
  document.getElementById('custom-thresholds').style.display = isCustom ? 'block' : 'none';
  if (!isCustom && PROFILES[name]) {
    const p = PROFILES[name];
    _applyThreshInputs(p.minRiskLevel, p.minLossUsd, p.minSlippage);
  }
  saveSettings();
  syncThresholdsToPage();
}

function setMinRisk(level) {
  document.querySelectorAll('#custom-thresholds .mode-btn[data-level]').forEach(b =>
    b.classList.toggle('active', b.dataset.level === level));
  saveSettings();
  syncThresholdsToPage();
}

async function setMode(mode) {
  document.getElementById('mode-simple')?.classList.toggle('active', mode === 'simple');
  document.getElementById('mode-adv')?.classList.toggle('active',    mode === 'advanced');
  document.body.classList.toggle('mode-simple',   mode === 'simple');
  document.body.classList.toggle('mode-advanced', mode === 'advanced');
  const hintSimple = document.getElementById('mode-hint-simple');
  const hintAdv    = document.getElementById('mode-hint-adv');
  if (hintSimple) hintSimple.style.display = mode === 'simple'   ? '' : 'none';
  if (hintAdv)    hintAdv.style.display    = mode === 'advanced' ? '' : 'none';
  saveSettings();
  const tab = await findDexTab();
  if (!tab?.id) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: 'MAIN',
    func: m => {
      if (window.__zq) {
        window.__zq.widgetMode = m;
        window.__zq.renderWidgetPanel?.();
      }
    },
    args: [mode],
  }).catch(() => {});
}

function restoreSettings() {
  chrome.storage.local.get(['settings'], ({ settings: s = {} }) => {
    setMode(s.uiMode === 'advanced' ? 'advanced' : 'simple');
    if (s.autoProtect) {
      document.getElementById('auto-protect').checked = true;
      const apHint = document.getElementById('auto-protect-hint');
      if (apHint) apHint.style.display = '';
    }
    if (s.autoAccept)  {
      const el = document.getElementById('auto-accept');
      if (el) {
        el.checked = true;
        const hint = document.getElementById('auto-accept-hint');
        if (hint) hint.style.display = '';
      }
    }
    const pauseHR = document.getElementById('pause-on-high-risk');
    if (pauseHR) pauseHR.checked = s.pauseOnHighRisk !== false; // default true
    const profile = s.profile ?? 'alert';
    if (profile === 'custom') {
      setProfile('custom');
      _applyThreshInputs(s.minRiskLevel ?? 'LOW', s.minLossUsd ?? 0, s.minSlippage ?? 0);
    } else {
      setProfile(profile);
    }
    // Restore priority fee mode
    const savedJito = s.jitoMode ?? 'auto';
    jitoMode = savedJito;
    const radio = document.getElementById('jito-' + savedJito);
    if (radio) radio.checked = true;
    syncThresholdsToPage();
  });
}
