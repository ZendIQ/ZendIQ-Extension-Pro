/**
 * ZendIQ popup - config
 * Shared constants and mutable state used across popup modules.
 */

// -- ZendIQ protocol fee (future) --------------------------------------------
const FEE_WALLET = 'BS9DnoBnndNj6QmeEbH2mxizefWYyrLond5G8bKUYxHC';

// Axiom ships only in builds whose manifest injects into axiom.trade (unpacked dev builds).
// The store build strips it at package time (scripts/build-pro-store.js), so the popup asks
// the manifest instead of assuming a tab on axiom.trade has ZendIQ running in it.
const AXIOM_ENABLED = (chrome.runtime.getManifest().content_scripts ?? [])
  .some(cs => (cs.matches ?? []).some(m => m.includes('axiom.trade')));

// Mutable state - written/read by the wallet and settings modules
let walletPubkey = null;
let jitoMode = 'auto';  // 'always' = always high priority | 'auto' = high when risky | 'never' = always standard
