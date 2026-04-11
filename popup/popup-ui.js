/**
 * ZendIQ popup — ui
 * Tab switching, token pickers, swap form helpers.
 */

// ── Tabs ───────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.getElementById('tab-'   + name).classList.add('active');
  if (name === 'monitor')  loadMonitor();
  if (name === 'activity') loadActivity();
  if (name === 'swap')     detectWallet();
  // Recalculate security tab badge — border only shows when tab is active
  _updateSecurityTabColor?.();
}

// ── Token pickers ──────────────────────────────────────────────────────────
function buildPickers() {
  ['in', 'out'].forEach(side => {
    const el = document.getElementById('picker-' + side);
    el.innerHTML = TOKENS.map(t =>
      `<div class="pick-item" data-side="${side}" data-sym="${t.symbol}">` +
      `<div><div>${t.symbol}</div><div class="pi-sub">${t.name}</div></div>` +
      `</div>`
    ).join('');
    el.querySelectorAll('.pick-item').forEach(item =>
      item.addEventListener('click', () => selectToken(item.dataset.side, item.dataset.sym))
    );
  });
}

function togglePicker(side) {
  const el    = document.getElementById('picker-' + side);
  const other = document.getElementById('picker-' + (side === 'in' ? 'out' : 'in'));
  other.classList.remove('open');
  el.classList.toggle('open');
}

function selectToken(side, symbol) {
  const tok = TOKENS.find(t => t.symbol === symbol);
  if (!tok) return;
  if (side === 'in'  && tok.symbol === tokenOut.symbol) tokenOut = tokenIn;
  if (side === 'out' && tok.symbol === tokenIn.symbol)  tokenIn  = tokenOut;
  if (side === 'in')  tokenIn  = tok;
  if (side === 'out') tokenOut = tok;
  updateTokenUI();
  document.getElementById('picker-' + side).classList.remove('open');
  resetQuote();
}

function updateTokenUI() {
  document.getElementById('ticker-in').textContent  = tokenIn.symbol;
  document.getElementById('ticker-out').textContent = tokenOut.symbol;
}

function flipTokens() {
  [tokenIn, tokenOut] = [tokenOut, tokenIn];
  const outVal = parseFloat(document.getElementById('amount-out').value);
  if (outVal > 0) document.getElementById('amount-in').value = outVal;
  updateTokenUI();
  resetQuote();
}

// Close open pickers on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.tok-wrap'))
    document.querySelectorAll('.tok-picker').forEach(p => p.classList.remove('open'));
});

// ── Status / quote helpers ─────────────────────────────────────────────────
function setStatus(msg, type) {
  const el = document.getElementById('sw-status');
  el.textContent = msg;
  el.className   = 'sw-status' + (type ? ' ' + type : '');
}

function resetQuote() {
  lastOrder = null;
  document.getElementById('quote-box').classList.remove('show');
  document.getElementById('btn-swap').classList.remove('show');
  document.getElementById('amount-out').value = '';
  setStatus('', '');
  // Clear savings callout
  const savingsBox = document.getElementById('savings-box');
  if (savingsBox) savingsBox.classList.remove('show');
  const qImpactCost = document.getElementById('q-impact-cost');
  if (qImpactCost) { qImpactCost.textContent = '—'; qImpactCost.className = 'sav-val r'; }
  const qEstSavings = document.getElementById('q-est-savings');
  if (qEstSavings) { qEstSavings.textContent = '—'; qEstSavings.className = 'sav-val g'; }
  const qMevShield  = document.getElementById('q-mev-shield');
  if (qMevShield)  { qMevShield.textContent  = '—'; qMevShield.className  = 'sav-val'; }
}
