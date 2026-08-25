/**
 * ZendIQ popup — ui
 * Tab switching.
 */

// ── Tabs ───────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.getElementById('tab-'   + name).classList.add('active');
  if (name === 'monitor')  loadMonitor();
  if (name === 'activity') loadActivity();
  // Recalculate security tab badge — border only shows when tab is active
  _updateSecurityTabColor?.();
}
