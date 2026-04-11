/**
 * ZendIQ popup — activity
 * Renders the Activity tab: swap history + last intercepted trade analysis.
 */

// Shared HTML-escape helper (also used by popup-captured.js which loads after this file)
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const _SERVICE_FEE_PCT = 0.0005; // 0.05% of transaction value

// EU-style number format: dots=thousands, comma=decimal  e.g. "2.135,345970"
function _euFmt(n, decimals) {
  if (!isFinite(n)) return '—';
  const abs = Math.abs(n);
  const d = decimals != null ? decimals : (abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.001 ? 6 : 8);
  const [ip, dp] = abs.toFixed(d).split('.');
  const intFmt = ip.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '-' : '') + (dp ? intFmt + ',' + dp : intFmt);
}

// ─── Savings display ─────────────────────────────────────────────────────────
// Prefers Net Benefit in USD (savings − all ZendIQ costs) when price data is
// available. Falls back to gross token routing gain otherwise.
function calcSavingsDisplay(h) {
  // _calcBreakdown is defined below but hoisted as a function declaration.
  const bd = _calcBreakdown(h);
  if (bd.netUsd != null) {
    const net    = bd.netUsd;
    const absStr = Math.abs(net) < 0.01 ? Math.abs(net).toFixed(4) : Math.abs(net).toFixed(3);
    // confirmed: quoteAccuracy ≥99% → ZendIQ delivered as promised → drop '(est.)' and '~ '
    const confirmed = h.quoteAccuracy != null && Number(h.quoteAccuracy) >= 99;
    const label  = net >= 0
      ? (confirmed ? 'Actual Gain' : 'Actual Gain (est.)')
      : (confirmed ? 'vs. original' : 'vs. original (est.)');
    const prefix = confirmed ? '' : '~ ';
    if (net >= 0) {
      return { label, text: `${prefix}+$${absStr}`, color: 'var(--green)', onChain: bd.onChain };
    } else {
      return { label, text: `${prefix}\u2212$${absStr}`, color: '#FFB547', onChain: bd.onChain, negative: true };
    }
  }

  // Fallback: gross token routing gain (no fee data yet)
  const tokenOut = h.tokenOut || '';
  const outDec   = h.outputDecimals != null ? Number(h.outputDecimals) : 6;

  if (h.baselineRawOut != null && h.rawOutAmount != null) {
    const zdq  = Number(h.rawOutAmount);
    const base = Number(h.baselineRawOut);
    if (isFinite(zdq) && isFinite(base) && base > 0) {
      const gross = (zdq - base) / Math.pow(10, outDec);
      if (Math.abs(gross) >= 1e-7) {
        const sign = gross >= 0 ? '+ ' : '- ';
        return { label: 'Net Benefit', text: `${sign}${_euFmt(Math.abs(gross))} ${tokenOut}`, color: gross >= 0 ? 'var(--green)' : '#FF4D4D' };
      }
    }
  }
  if (h.estSavingsTokens != null && Number(h.estSavingsTokens) > 1e-7) {
    return { label: 'Actual Gain (est.)', text: `~ +${_euFmt(Number(h.estSavingsTokens))} ${tokenOut} (est.)`, color: 'var(--green)' };
  }
  if (h.priceImpactPct != null && h.rawOutAmount != null) {
    const est = (Number(h.rawOutAmount) / Math.pow(10, outDec)) * Math.abs(parseFloat(h.priceImpactPct)) * 0.35;
    if (est >= 1e-7) {
      return { label: 'Actual Gain (est.)', text: `~ +${_euFmt(est)} ${tokenOut} (est.)`, color: 'var(--green)' };
    }
  }
  return { label: 'Net Benefit', text: '—', color: 'var(--muted)' };
}

// ─── Helpers / per-entry rendering ───────────────────────────────────────────
// ─── Savings breakdown (USD) for hover tooltip ───────────────────────────────
function _calcBreakdown(h) {
  const fmt   = v => (v == null || !isFinite(v)) ? '—' : '$' + (Math.abs(v) < 0.01 ? Math.abs(v).toFixed(4) : Math.abs(v).toFixed(3));
  const sol   = h.solPriceUsd    != null ? Number(h.solPriceUsd)    : null;
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const outputIsSol = h.outputMint === SOL_MINT || h.tokenOut === 'SOL' || h.tokenOut === 'WSOL';
  const opr   = h.outputPriceUsd != null ? Number(h.outputPriceUsd)
    : (outputIsSol && sol != null ? sol : null);
  const outDec = Number(h.outputDecimals ?? 6);

  const serviceFeeUsd  = 0; // Not yet extracted — free during beta
  // Prefer pre-computed values (stored at swap time when SOL price was fresh)
  const _solForFees    = sol ?? 80; // conservative SOL price floor for non-SOL pairs
  const priorityFeeUsd = h.priorityFeeUsd != null ? Number(h.priorityFeeUsd)
    : (h.priorityFeeLamports ? (h.priorityFeeLamports / 1e9) * _solForFees : null);
  const jitoTipUsd     = h.jitoTipUsd != null ? Number(h.jitoTipUsd)
    : (h.jitoTipLamports ? (h.jitoTipLamports / 1e9) * _solForFees : null);
  const totalCostUsd   = (serviceFeeUsd ?? 0) + (priorityFeeUsd ?? 0) + (jitoTipUsd ?? 0);
  // Use MEV algorithm's own estimatedLossPercentage — consistent with Review & Sign.
  // Fall back to tiered lookup from riskScore if the field wasn't stored in older history entries.
  // Suppress for LOW risk (mevRiskScore < 25) — noise below that threshold.
  const _mevRiskScore  = h.mevRiskScore ?? 0;
  const _mevEstLossPct = h.mevEstimatedLossPercent != null
    ? h.mevEstimatedLossPercent / 100
    : (_mevRiskScore >= 75 ? 0.012 : _mevRiskScore >= 50 ? 0.006 : _mevRiskScore >= 25 ? 0.003 : 0);
  const mevUsd         = (_mevEstLossPct > 0 && h.amountInUsd != null && _mevRiskScore >= 25)
    ? Number(h.amountInUsd) * _mevEstLossPct : null;

  let savingsUsd = null;
  const onChain = false; // On-chain data is used for Quote Accuracy only — see note.
  // Tier 1 removed: comparing actualOutAmount (on-chain) vs baselineRawOut (pre-execution Jupiter
  // snapshot) introduced noise from Jupiter price movement in the ~1–30s execution window.
  // 100%-accurate RFQ/gasless fills showed as negative Net Benefit because Jupiter's price
  // improved slightly between review and execution. Quote Accuracy validates delivery fidelity.

  // Tier 2.5 (primary): snapshot frozen at Review & Sign → exact figure the user agreed to.
  if (h.snapSavingsUsd != null) {
    savingsUsd = Number(h.snapSavingsUsd);
  }

  // Tier 2: ZendIQ pre-execution quote vs Jupiter pre-execution quote
  if (savingsUsd == null && h.baselineRawOut != null && h.rawOutAmount != null && opr != null) {
    const zdq = Number(h.rawOutAmount);
    const base = Number(h.baselineRawOut);
    if (isFinite(zdq) && isFinite(base) && base > 0 && zdq > 0) {
      const gross = (zdq - base) / Math.pow(10, outDec);
      const actualOut = zdq / Math.pow(10, outDec);
      if (Math.abs(gross) <= actualOut * 0.5)
        savingsUsd = gross * opr;
    }
  }

  if (savingsUsd == null && h.estSavingsTokens != null && opr != null)
    savingsUsd = Number(h.estSavingsTokens) * opr;

  // MEV fallback net: used when no routing baseline exists (typeMatch guard or different route type)
  // but Jito was paid for MEV protection. Mirrors the same formula used in Review & Sign.
  const _fees = (serviceFeeUsd ?? 0) + (priorityFeeUsd ?? 0) + (jitoTipUsd ?? 0);
  const mevNetUsd = (savingsUsd == null && mevUsd != null && totalCostUsd > 0)
    ? mevUsd - totalCostUsd : null;

  // Prefer the snapshotted netUsd (exact fee math from Review & Sign).
  const netUsd = h.snapNetUsd != null
    ? Number(h.snapNetUsd)
    : savingsUsd != null
      ? savingsUsd - _fees
      : mevNetUsd;  // MEV-only estimate when no routing baseline available

  const rlColors = { CRITICAL: '#FF4D4D', HIGH: '#FFB547', MEDIUM: '#9945FF', LOW: '#14F195' };
  return { fmt, serviceFeeUsd, priorityFeeUsd, jitoTipUsd, totalCostUsd, mevUsd, mevNetUsd, savingsUsd, netUsd, onChain, rlc: rlColors[h.riskLevel] ?? 'var(--muted)' };
}

function _buildTooltipHtml(h) {
  const { fmt, serviceFeeUsd, priorityFeeUsd, jitoTipUsd, totalCostUsd, mevUsd, savingsUsd, netUsd, onChain, rlc } = _calcBreakdown(h);
  const hasAnyUsd = priorityFeeUsd != null || mevUsd != null;
  const divider = `<div style="border-top:1px solid rgba(153,69,255,0.2);margin:8px 0"></div>`;
  const row = (lbl, val, col) =>
    `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:3px"><span style="color:var(--muted)">${lbl}</span><span style="color:${col ?? '#E8E8F0'};font-weight:600">${val}</span></div>`;
  const sub = (lbl, val, col) =>
    `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:var(--muted)">${lbl}</span><span style="color:${col ?? '#B0B0C0'}">${val}</span></div>`;

  // ── Section 1: Trade Summary ─────────────────────────────────────────────
  let html = `<div style="font-size:var(--fs-base);font-weight:700;color:#E8E8F0;margin-bottom:8px;border-bottom:1px solid rgba(153,69,255,0.25);padding-bottom:6px">Trade Breakdown</div>`;
  html += row(
    `<span title="The token you received back into your wallet after the swap completed." style="cursor:help">Received</span>`,
    escapeHtml(_fmtAmt(h.amountOut, h.tokenOut || '?')),
    '#14F195'
  );
  html += row(
    `<span title="The token you sold — sent to the DEX to execute this swap." style="cursor:help">Paid (sold)</span>`,
    escapeHtml(_fmtAmt(h.amountIn, h.tokenIn || '?')),
    '#E8E8F0'
  );
  html += row(
    `<span title="How this swap was routed. Aggregator = scans many DEX pools for the best combined price; RFQ = direct quote from professional market makers (tighter spreads, faster settlement); Gasless = swap fee sponsored by the DEX protocol." style="cursor:help">Via</span>`,
    escapeHtml(_exchangeLabel(h))
  );
  html += row(
    `<span title="When this transaction was broadcast to the Solana network." style="cursor:help">When</span>`,
    _fmtAgo(h.timestamp)
  );
  if (h.routePlan && Array.isArray(h.routePlan) && h.routePlan.length) {
    const routeStr = h.routePlan.map(s => escapeHtml(s.label ?? s.swapInfo?.label ?? s.amm ?? '?')).join(' → ');
    html += row(`<span title="The specific DEX pools and protocols chained together to achieve your final rate." style="cursor:help">Route</span>`, routeStr);
  }
  const _acc = _quoteAccuracy(h);
  if (_acc) {
    const _isUnopt = !h.optimized;
    const _accLbl = _isUnopt
      ? (_acc.onChain ? _exchangeLabel(h) + ' Quote Accuracy \u2713' : _exchangeLabel(h) + ' Quote Accuracy')
      : (_acc.onChain ? 'ZendIQ Quote Accuracy \u2713' : 'ZendIQ Quote Accuracy');
    const accTip = _isUnopt
      ? (_acc.onChain
          ? 'Actual on-chain fill accuracy \u2014 actual tokens received vs. the quoted amount, verified from the confirmed Solana transaction.'
          : 'Estimated from pre-execution price impact. Updates automatically a few seconds after confirmation.')
      : (_acc.onChain
          ? 'Actual on-chain fill accuracy \u2014 actual tokens received vs. ZendIQ\'s quoted amount, verified from the confirmed Solana transaction.'
          : 'Estimated from pre-execution price impact. Actual on-chain result may differ slightly. Updates automatically a few seconds after confirmation.');
    html += row(
      `<span title="${accTip}" style="cursor:help">${_accLbl}</span>`,
      `<span style="color:${_acc.color};font-weight:600">${_acc.text}</span>`
    );
  }

  // ── Section 2: Performance Analysis ─────────────────────────────────────
  html += divider;
  html += `<div style="font-size:var(--fs-base);font-weight:700;color:#E8E8F0;margin-bottom:8px">Performance Analysis</div>`;

  // Risk score — always shown
  html += row(
    `<span title="ZendIQ's composite Bot Attack Risk score for this swap. Factors include trade size, token volatility, pool liquidity, and token metadata. Score 0–100: LOW &lt;25 | MEDIUM 25–49 | HIGH 50–74 | CRITICAL 75+." style="cursor:help">Risk Score</span>`,
    h.riskScore != null ? `${escapeHtml(h.riskScore)}/100 ${escapeHtml(h.riskLevel ?? '')}` : '—',
    h.riskScore != null ? rlc : 'var(--muted)'
  );

  // Est. Bot Attack Exposure — always shown
  html += row(
    `<span title="Estimated dollar value bots could extract from this swap via front-running or sandwich attacks (MEV = Maximal Extractable Value). ZendIQ's Jito tip routes your transaction to validators who block these attacks." style="cursor:help">Est. Bot Attack Exposure</span>`,
    mevUsd != null ? fmt(mevUsd) : '—',
    mevUsd != null ? (mevUsd > 0.0001 ? '#FFB547' : '#14F195') : 'var(--muted)'
  );

  // Advanced mode: Risk Factors + Bot Attack Risk — always shown in advanced
  const isAdv = !document.body.classList.contains('mode-simple');
  if (isAdv) {
    const sfc = {CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'};
    const mfc = {CRITICAL:'#FF4D4D',HIGH:'#FFB547',MEDIUM:'#9945FF',LOW:'#14F195'};
    // ── Section: Risk Factors (calculateRisk factors) ──
    html += `<div style="margin:8px 0 4px;font-size:var(--fs-xs);font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;cursor:help" title="Risk signals assessed by ZendIQ for this swap: price impact, slippage, trade size, and network conditions.">Risk Factors</div>`;
    if (h.riskFactors?.length) {
      html += h.riskFactors.map(f => {
        const fc = sfc[f.severity] ?? 'var(--muted)';
        return `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:var(--muted)">${escapeHtml(f.name ?? f)}</span><span style="color:${fc};font-weight:600">${escapeHtml(f.severity ?? '')}</span></div>`;
      }).join('');
    } else {
      html += `<div style="padding-left:10px;color:var(--muted);font-size:var(--fs-base)">No risk factors recorded</div>`;
    }
    // ── Section: Bot Attack Risk (MEV factors) ────────
    html += `<div style="margin:8px 0 4px;font-size:var(--fs-xs);font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;cursor:help" title="Individual bot-attack signals detected for this swap. Each factor contributes to the overall Bot Attack Risk score.">Bot Attack Risk</div>`;
    if (h.mevFactors?.length) {
      html += h.mevFactors.map(f => {
        const fc = mfc[f.score >= 20 ? 'CRITICAL' : f.score >= 10 ? 'HIGH' : f.score >= 5 ? 'MEDIUM' : 'LOW'] ?? 'var(--muted)';
        return `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px;padding-left:10px"><span style="color:var(--muted)">${escapeHtml(f.factor)}</span><span style="color:${fc};font-weight:600">${escapeHtml(f.score)}</span></div>`;
      }).join('');
    } else {
      html += `<div style="padding-left:10px;color:var(--muted);font-size:var(--fs-base)">No bot risk detected</div>`;
    }
  }

  // Savings & Costs — always shown
  const _mevMult = (h.routeSource === 'raydium' && h.jitoBundle) ? 0.95 : 0.70;
  // Prefer the frozen snap value (set at Review & Sign time when jitoUsd was non-zero).
  // Falls back to re-computing from stored risk data when the snap value was added later.
  const _mevProtection = h.snapMevProtectionUsd != null && h.snapMevProtectionUsd >= 0.0001
    ? h.snapMevProtectionUsd
    : (mevUsd != null && (jitoTipUsd ?? 0) > 0 && mevUsd * _mevMult >= 0.0001) ? mevUsd * _mevMult : null;
  html += `<div style="margin:8px 0 4px;color:var(--muted);font-size:var(--fs-base);font-weight:700;text-transform:uppercase;letter-spacing:0.4px;cursor:help" title="Routing improvement achieved by ZendIQ\u2019s route vs Jupiter\u2019s concurrent quote, plus statistical MEV protection value, minus all associated costs.">Savings &amp; Costs</div>`;
  if (savingsUsd != null) { const _absS = Math.abs(savingsUsd), _tiny = _absS < 0.0001; html += sub(`<span title="Extra USD value ZendIQ\u2019s route obtained vs Jupiter\u2019s concurrent live quote at sign time (gross, before costs)." style="cursor:help">Est. Routing improvement</span>`, _tiny ? '\u2248\u00a0none' : (savingsUsd >= 0 ? '+' : '\u2212') + fmt(_absS), _tiny ? 'var(--muted)' : (savingsUsd >= 0 ? '#14F195' : '#FF4D4D')); }
  if (_mevProtection != null) html += sub(`<span title="Statistical MEV protection value: estimated bot-attack exposure \xd7 ${Math.round(_mevMult * 100)}% coverage rate from Jito routing. Covers most sandwich attacks before they execute." style="cursor:help">Bot protection (\xd7${Math.round(_mevMult * 100)}%)</span>`, '+' + fmt(_mevProtection), '#9945FF');
  if (savingsUsd != null || _mevProtection != null) html += `<div style="border-top:1px solid rgba(255,255,255,0.06);margin:4px 0 4px 10px"></div>`;
  html += sub('ZendIQ Fee (0.05%)', '<span style="color:#14F195;font-weight:600">FREE · Beta</span>');
  html += sub(
    `<span title="Compute unit price paid to Solana validators to prioritise your transaction. Baked into the transaction at quote time." style="cursor:help">${h.routeSource === 'raydium' ? 'Priority Fee (via Raydium)' : 'Priority Fee (via Jupiter)'}</span>`,
    priorityFeeUsd != null ? fmt(priorityFeeUsd) : '—',
    priorityFeeUsd != null && priorityFeeUsd > 0 ? '#FFB547' : undefined
  );
  html += sub(
    `<span title="Tip routed via Jupiter to Jito validators who block sandwich attacks. This is NOT a Jito bundle — Jupiter prevents third-party bundling via a reserved account in every Ultra transaction." style="cursor:help">Jito Tip (via Jupiter)</span>`,
    h.jitoTipLamports > 0 ? fmt(jitoTipUsd) : 'none',
    h.jitoTipLamports > 0 ? '#9945FF' : undefined
  );
  if (totalCostUsd > 0)
    html += `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.06)"><span style="color:var(--muted);padding-left:10px">Total</span><span style="color:#FFB547;font-weight:700">${fmt(totalCostUsd)}</span></div>`;

  // Net Benefit — always shown; fall back to token display when USD prices unavailable
  let netColor, netStr;
  if (netUsd != null) {
    netColor = netUsd >= 0 ? '#14F195' : '#FFB547';
    netStr   = (netUsd >= 0 ? '~ +' : '~ −') + fmt(Math.abs(netUsd));
  } else {
    const sv = calcSavingsDisplay(h);
    netColor = sv.text !== '—' ? sv.color : 'var(--muted)';
    netStr   = sv.text !== '—' ? sv.text : '—';
  }
  const confirmed = h.quoteAccuracy != null && Number(h.quoteAccuracy) >= 99;
  const netBenLabel = confirmed
    ? (netUsd != null ? (netUsd >= 0 ? 'Actual Gain' : 'vs. original') : 'Actual Gain')
    : (netUsd != null ? (netUsd >= 0 ? 'Actual Gain (est.)' : 'vs. original (est.)') : 'Actual Gain (est.)');
  const netBenTip = confirmed
    ? (netUsd != null
        ? (netUsd >= 0
            ? 'ZendIQ executed accurately (\u226599% quote accuracy). Routing improvement vs the original route\u2019s concurrent quote + statistical MEV protection value, minus all costs. Frozen at Sign &amp; Send.'
            : 'ZendIQ executed accurately, though this route was slightly worse than the original route\u2019s concurrent quote at sign time. Routing comparison frozen at sign time.')
        : 'ZendIQ executed accurately (\u226599% quote accuracy). Routing improvement vs the original route\u2019s concurrent quote + statistical MEV protection value, minus all costs. Frozen at Sign &amp; Send.')
    : (netUsd != null
        ? (netUsd >= 0
            ? 'Your estimated gain from ZendIQ: routing improvement vs the original route\u2019s concurrent quote + statistical MEV protection value, minus all costs. Frozen at Sign &amp; Send.'
            : 'ZendIQ returned fewer tokens than the original route\u2019s concurrent quote for this trade (est.). You proceeded with ZendIQ \u2014 the display shows the estimated loss vs. the original route.')
        : 'Your actual estimated gain from using ZendIQ instead of the original route, after all costs. Frozen at the moment you clicked Sign &amp; Send.');
  html += `<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(153,69,255,0.2);display:flex;justify-content:space-between;gap:12px"><span style="color:var(--muted);cursor:help" title="${netBenTip}">${netBenLabel}${confirmed ? ' <span style=\'font-size:var(--fs-xs);color:#14F195\'>\u2713 delivered</span>' : ''}</span><span style="color:${netColor};font-weight:700">${netStr}</span></div>`;
  return html;
}

// ─── Floating tooltip mechanics ─────────────────────────────────────────────
const _tipMap = {};
function _ensureTip() {
  let t = document.getElementById('zq-hover-tip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'zq-hover-tip';
    t.style.cssText = 'position:fixed;z-index:99999;background:#12121E;border:1px solid rgba(153,69,255,0.4);border-radius:10px;padding:12px 14px;font-size:var(--fs-base);line-height:1.6;color:#E8E8F0;box-shadow:0 8px 24px rgba(0,0,0,0.7);pointer-events:auto;display:none;overflow-y:auto;';
    t.addEventListener('mouseleave', _hideZQTip);
    document.body.appendChild(t);
  }
  return t;
}
function _showZQTip(card) {
  const h = _tipMap[card.id]; if (!h) return;
  const tip = _ensureTip();
  tip.innerHTML = _buildTooltipHtml(h);
  tip.style.display = 'block';

  const pad  = 8;
  const gap  = 6;
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;
  const maxH = Math.floor(vh * 0.75);

  tip.style.left      = pad + 'px';
  tip.style.right     = pad + 'px';
  tip.style.width     = '';
  tip.style.maxHeight = maxH + 'px';
  tip.style.bottom    = '';

  // Measure natural height after setting width
  const th = tip.offsetHeight;
  const rect = card.getBoundingClientRect();
  const spaceBelow = vh - rect.bottom - gap - pad;
  const spaceAbove = rect.top - gap - pad;

  if (spaceBelow >= Math.min(th, maxH)) {
    // Fits below
    tip.style.top = (rect.bottom + gap) + 'px';
  } else if (spaceAbove >= Math.min(th, maxH)) {
    // Fits above
    tip.style.top = Math.max(pad, rect.top - gap - Math.min(th, maxH)) + 'px';
  } else {
    // Neither — anchor to bottom of viewport
    tip.style.top    = '';
    tip.style.bottom = pad + 'px';
  }
}
function _hideZQTip() { const t = document.getElementById('zq-hover-tip'); if (t) t.style.display = 'none'; }
function _wireTooltips(container) {
  container.querySelectorAll('[id^="zq-card-"]').forEach(card => {
    card.addEventListener('mouseenter', () => _showZQTip(card));
    card.addEventListener('mouseleave', (e) => {
      // Don't hide if mouse moved into the tooltip itself
      const tip = document.getElementById('zq-hover-tip');
      if (tip && tip.contains(e.relatedTarget)) return;
      _hideZQTip();
    });
  });
}
// ─── Helpers / per-entry rendering ─────────────────────────────────────────
function _fmtAgo(ts) {
  const s = Math.round((Date.now() - (ts || 0)) / 1000);
  return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago';
}

// EU-style amount formatter: dots=thousands, comma=decimal  e.g. "44.649,664 WIF"
function _fmtAmt(val, sym) {
  const safeSym = escapeHtml(sym || '');
  if (val == null || val === '' || val === '—') return '— ' + safeSym;
  const n = parseFloat(val);
  if (!isFinite(n)) return escapeHtml(String(val)) + ' ' + safeSym;
  const abs  = Math.abs(n);
  const prec = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.001 ? 6 : 8;
  const [intPart, decPart] = n.toFixed(prec).split('.');
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (decPart ? intFmt + ',' + decPart : intFmt) + ' ' + safeSym;
}
// Human-readable exchange label from swapType / routeSource field.
function _exchangeLabel(h) {
  if (h.routeSource === 'raydium') return h.jitoBundle ? 'Raydium · AMM + Jito' : 'Raydium · AMM';
  switch ((h.swapType || '').toLowerCase()) {
    case 'rfq':       return 'Jupiter RFQ';
    case 'gasless':   return 'Jupiter (Gasless)';
    case 'aggregator':
    default:          return h.optimized ? 'ZendIQ · AMM' : 'Jupiter';
  }
}
// Quote accuracy: how close to the ZendIQ-quoted rate the execution landed.
// For optimized trades: only returns the confirmed on-chain value (null = pending).
// For unoptimized trades: falls back to priceImpactPct estimate.
function _quoteAccuracy(h) {
  // Prefer actual on-chain accuracy (populated ~3–10s after swap confirms)
  if (h.quoteAccuracy != null && isFinite(parseFloat(h.quoteAccuracy))) {
    const acc = Math.max(0, Math.min(100, parseFloat(h.quoteAccuracy)));
    const col = acc >= 99 ? '#14F195' : acc >= 97 ? '#FFB547' : '#FF4D4D';
    return { text: acc.toFixed(2) + '%', color: col, onChain: true };
  }
  // Optimized trades show 'pending…' via the caller — no internal fallback estimate.
  if (h.optimized) return null;
  // Unoptimized trades: estimate from Jupiter's price impact (pre-execution)
  if (h.priceImpactPct != null) {
    const impact = Math.abs(parseFloat(h.priceImpactPct));
    if (isFinite(impact)) {
      const acc = Math.max(0, 100 - impact * 100);
      const col = acc >= 99 ? '#14F195' : acc >= 97 ? '#FFB547' : '#FF4D4D';
      return { text: acc.toFixed(2) + '%', color: col, onChain: false };
    }
  }
  if (h.rawOutAmount != null && h.baselineRawOut != null) {
    const ratio = (Number(h.rawOutAmount) / Number(h.baselineRawOut)) * 100;
    if (isFinite(ratio) && ratio > 0) {
      const capped = Math.min(ratio, 100);
      const col = capped >= 99 ? '#14F195' : capped >= 97 ? '#FFB547' : '#FF4D4D';
      return { text: capped.toFixed(2) + '%', color: col, onChain: false };
    }
  }
  return null;
}

function _renderHistoryEntry(h, idx) {
  if (!h || typeof h !== 'object') return '';
  const id = 'zq-card-' + idx;
  _tipMap[id] = h;
  const ago      = _fmtAgo(h.timestamp);
  const inVal    = _fmtAmt(h.amountIn,  h.tokenIn  || '?');
  const outVal   = _fmtAmt(h.amountOut, h.tokenOut || '?');
  const solscanLink = h.signature
    ? `<a href="https://solscan.io/tx/${escapeHtml(h.signature)}" target="_blank" style="color:var(--green);text-decoration:none">${h.jitoTipSig ? 'Swap ↗' : 'View on Solscan'}</a>`
      + (h.jitoTipSig ? ` <a href="https://solscan.io/tx/${escapeHtml(h.jitoTipSig)}" target="_blank" style="color:var(--muted);text-decoration:none;font-size:var(--fs-base)">Jito tip ↗</a>` : '')
    : '';

  // ── Unoptimized trade card (user chose "Proceed anyway") ──────────────────
  if (!h.optimized) {
    // On-chain vs Quote row
    let execRow = '';
    if (h.actualOutAmount != null && h.quotedOut != null) {
      const actual = parseFloat(h.actualOutAmount);
      const quoted = parseFloat(h.quotedOut);
      if (isFinite(actual) && isFinite(quoted) && quoted > 0) {
        const diff = actual - quoted;
        const sign = diff >= 0 ? '+ ' : '- ';
        const col  = diff >= 0 ? 'var(--green)' : '#FFB547';
        execRow = `<div class="analysis-row"><span class="lbl" style="white-space:nowrap;cursor:help" title="Actual tokens received on-chain vs the quoted amount at swap time.">On-chain vs Quote ✓</span><span class="val" style="white-space:nowrap;flex-shrink:0;color:${col};font-weight:700">${sign}${_fmtAmt(Math.abs(diff), h.tokenOut || '')}</span></div>`;
      }
    } else if (h.quotedOut != null) {
      execRow = `<div class="analysis-row"><span class="lbl" title="Waiting for on-chain confirmation to compare against the quoted amount." style="cursor:help">On-chain vs Quote</span><span class="val" style="color:var(--muted)">pending…</span></div>`;
    }
    const accU = _quoteAccuracy(h);
    const accRowU = accU
      ? `<div class="analysis-row"><span class="lbl" title="${accU.onChain
          ? 'Actual on-chain fill accuracy \u2014 actual tokens received vs. the quoted amount, verified from the confirmed Solana transaction.'
          : 'Estimated from pre-execution price impact. Updates automatically a few seconds after confirmation.'
        }" style="cursor:help">${accU.onChain ? _exchangeLabel(h) + ' Quote Accuracy \u2713' : _exchangeLabel(h) + ' Quote Accuracy'}</span><span class="val" style="color:${accU.color};font-weight:700">${accU.text}</span></div>`
      : '';
    return `<div class="analysis-card" id="${id}" style="margin-bottom:8px;padding:8px;cursor:default;background:rgba(255,181,71,0.04);border-color:rgba(255,181,71,0.2)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
        <span style="font-size:var(--fs-base);font-weight:700;color:#FFB547">⚠ Not optimized</span>
        <span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace">+ ${outVal}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:var(--fs-base);color:var(--muted)">${escapeHtml(_exchangeLabel(h))}</span>
        <span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace">- ${inVal}</span>
      </div>
      ${execRow}
      ${accRowU}
      <div class="analysis-row" style="display:flex;justify-content:space-between;align-items:center">
        ${solscanLink ? `<div>${solscanLink}</div>` : '<div></div>'}
        <div style="color:var(--muted);font-size:12px">${ago}</div>
      </div>
    </div>`;
  }

  let sv = null;
  let savingsRow = '';
  if (h.optimized) {
    sv = calcSavingsDisplay(h);
    const _savTip = sv.negative
      ? 'ZendIQ\'s route returned slightly less than the original route\u2019s concurrent quote on this trade. You chose to proceed with ZendIQ\'s route anyway.'
      : sv.text === '\u2014' || sv.text === '—'
        ? 'No baseline available \u2014 the original route\u2019s quote wasn\u2019t captured for this trade, so no comparison can be shown.'
        : 'Estimated dollar value gained vs. the original route\u2019s concurrent quote for the same pair and amount, net of all fees.';
    savingsRow = `<div class="analysis-row"><span class="lbl" style="cursor:help" title="${_savTip}">${sv.label}</span><span class="val" style="color:${sv.color}">${sv.text}</span></div>`;
  }

  const acc = _quoteAccuracy(h);
  // Always show the accuracy row for optimized trades: pending until on-chain data arrives,
  // then upgrade to the confirmed value. Do NOT render an internal fallback estimate.
  const accuracyRow = acc
    ? `<div class="analysis-row"><span class="lbl" title="${acc.onChain
        ? 'Actual on-chain fill accuracy \u2014 actual tokens received vs. ZendIQ\'s quoted amount, verified from the confirmed Solana transaction.'
        : 'Estimated from pre-execution price impact. Actual on-chain result may differ slightly. Updates automatically a few seconds after confirmation.'
      }" style="cursor:help">${acc.onChain ? 'ZendIQ Quote Accuracy \u2713' : 'ZendIQ Quote Accuracy'}</span><span class="val" style="color:${acc.color};font-weight:700">${acc.text}</span></div>`
    : `<div class="analysis-row"><span class="lbl" title="Waiting for on-chain confirmation to compare against ZendIQ's quoted amount. Updates automatically a few seconds after the swap confirms." style="cursor:help">ZendIQ Quote Accuracy</span><span class="val" style="color:var(--muted)">pending…</span></div>`;

  const _badgeText = sv?.negative ? escapeHtml(sv.label) : 'ZendIQ Optimized';
  return `<div class="analysis-card" id="${id}" style="margin-bottom:8px;padding:8px;cursor:default">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
      <span style="font-size:var(--fs-base);font-weight:700;color:#E8E8F0">Swapped <span style="font-size:var(--fs-xs);font-weight:700;background:linear-gradient(135deg,rgba(153,69,255,0.15),rgba(20,241,149,0.06));border:1px solid rgba(153,69,255,0.3);color:#9945FF;border-radius:10px;padding:1px 6px;vertical-align:middle">${_badgeText}</span></span>
      <span style="font-size:12px;font-weight:700;color:#14F195;font-family:'Space Mono',monospace">+ ${outVal}</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:var(--fs-base);color:var(--muted)">${escapeHtml(_exchangeLabel(h))}</span>
      <span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace">- ${inVal}</span>
    </div>
    ${savingsRow}
    ${accuracyRow}
    <div class="analysis-row" style="display:flex;justify-content:space-between;align-items:center">
      ${solscanLink ? `<div>${solscanLink}</div>` : '<div/>'}
      <div style="color:var(--muted);font-size:12px">${ago}</div>
    </div>
  </div>`;
}

function loadActivity() {
  chrome.storage.local.get(['lastAnalysis', 'sendiq_last_swap', 'sendiq_swap_history'], ({ lastAnalysis, sendiq_last_swap: lastSwap, sendiq_swap_history: history = [] }) => {
    const el = document.getElementById('analysis-content');
    const lc = { CRITICAL: '#FF4D4D', HIGH: '#FFB547', MEDIUM: '#9945FF', LOW: '#14F195' };
    let html = '';
    let hasCards = false;

    if (Array.isArray(history) && history.length) {
      html += '<div style="max-height:260px;overflow:auto;padding-right:6px;">';
      history.forEach((h, i) => { try { html += _renderHistoryEntry(h, i); } catch (_) {} });
      html += '</div>';
      hasCards = true;
    } else if (lastSwap) {
      html += _renderHistoryEntry(lastSwap, 0);
      hasCards = true;
    }

    // Last intercept analysis (from risk overlay)
    if (lastAnalysis) {
      const ago = _fmtAgo(lastAnalysis.savedAt);
      html += `<div class="analysis-card">
        <div style="font-size:var(--fs-base);color:var(--muted);font-weight:700;margin-bottom:6px;text-transform:uppercase">Last Intercept</div>
        <div class="analysis-row"><span class="lbl">Risk</span><span class="val" style="color:${lc[lastAnalysis.level] ?? 'inherit'}">${escapeHtml(lastAnalysis.level)}</span></div>
        <div class="analysis-row"><span class="lbl">Est. loss</span><span class="val danger">${lastAnalysis.estimatedLoss?.toFixed(4) ?? '—'} SOL</span></div>
        <div class="analysis-row"><span class="lbl">Net savings</span><span class="val green">+${lastAnalysis.netSavings?.toFixed(4) ?? '—'} SOL</span></div>
        <div class="analysis-row"><span class="lbl">When</span><span class="val" style="color:var(--muted)">${ago}</span></div>
      </div>`;
    }

    el.innerHTML = html || '<div class="analysis-empty">No activity yet.<br>Use the Swap tab or visit jup.ag.</div>';
    if (hasCards) _wireTooltips(el);
  });
}
