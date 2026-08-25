/**
 * ZendIQ popup - config
 * Shared constants and mutable state used across popup modules.
 */

// -- ZendIQ protocol fee (future) --------------------------------------------
const FEE_WALLET = 'BS9DnoBnndNj6QmeEbH2mxizefWYyrLond5G8bKUYxHC';

// Mutable state - written/read by the wallet and settings modules
let walletPubkey = null;
let jitoMode = 'auto';  // 'always' = always high priority | 'auto' = high when risky | 'never' = always standard
