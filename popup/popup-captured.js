/**
 * ZendIQ popup — captured trade
 * Reads a trade captured by the in-page interceptor, pre-fills the swap form,
 * shows a context banner, and auto-triggers a quote.
 */

function checkCapturedTrade() {
  chrome.storage.local.get(['sendiq_captured_trade'], ({ sendiq_captured_trade: ct }) => {
    if (!ct) return;

    // Expire after 5 minutes
    if (Date.now() - (ct.capturedAt ?? 0) > 5 * 60 * 1000) {
      chrome.storage.local.remove('sendiq_captured_trade');
      return;
    }

    const inTok  = TOKENS.find(t => t.mint === ct.inputMint);
    const outTok = TOKENS.find(t => t.mint === ct.outputMint);
    if (inTok)  { tokenIn  = inTok;  updateTokenUI(); }
    else        { console.warn('[ZendIQ] Input mint not in TOKENS:', ct.inputMint); }
    if (outTok) { tokenOut = outTok; updateTokenUI(); }
    else        { console.warn('[ZendIQ] Output mint not in TOKENS:', ct.outputMint); }

    if (ct.amountUI) {
      document.getElementById('amount-in').value = ct.amountUI.toFixed(ct.inputDecimals <= 6 ? 4 : 6);
    }

    showTab('swap');
    showCapturedBanner(ct);
    getQuote();

    chrome.storage.local.remove('sendiq_captured_trade');
  });
}

function showCapturedBanner(ct) {
  document.getElementById('captured-banner')?.remove();

  const riskColors = { CRITICAL:'#FF4D4D', HIGH:'#FFB547', MEDIUM:'#9945FF', LOW:'#14F195', UNKNOWN:'var(--muted)' };
  const col    = riskColors[ct.riskLevel] ?? 'var(--muted)';
  const amtStr = ct.amountUI != null ? ct.amountUI.toFixed(4) + ' ' + escapeHtml(ct.inputSymbol) : '';

  const banner = document.createElement('div');
  banner.id = 'captured-banner';
  banner.style.cssText = `
    margin: 10px 16px 0;
    padding: 8px 10px;
    background: linear-gradient(135deg, rgba(153,69,255,0.08), rgba(20,241,149,0.05));
    border: 1px solid rgba(153,69,255,0.25);
    border-radius: 8px;
    font-size: 11px;
  `;
  banner.innerHTML = `
    <div style="color:#9945FF;font-weight:700;font-size:var(--fs-base);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">
      ✦ Optimising detected trade
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span style="color:#E8E8F0">${escapeHtml(ct.inputSymbol)} → ${escapeHtml(ct.outputSymbol)}${amtStr ? ' · ' + amtStr : ''}</span>
      <span style="background:${col}18;border:1px solid ${col}44;color:${col};padding:1px 6px;border-radius:10px;font-size:var(--fs-xs);font-weight:700">
        ${escapeHtml(ct.riskLevel)}
      </span>
    </div>
    ${ct.riskFactors?.length ? `<div style="color:var(--muted);margin-top:3px;font-size:var(--fs-base)">${ct.riskFactors.slice(0,2).map(f => escapeHtml(f?.name ?? f)).join(' · ')}</div>` : ''}
  `;

  const tabs = document.querySelector('.tabs');
  if (tabs) tabs.parentNode.insertBefore(banner, tabs);
}
