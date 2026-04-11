/**
 * ZendIQ — trade-store.js
 *
 * Shared schema and helpers for the CapturedTrade object.
 * This file is loaded as a separate script in the extension.
 * Interceptor reads it via window.ZendIQ namespace.
 * Popup reads directly via import or inline.
 *
 * CapturedTrade flows:
 *   interceptor.js → chrome.storage.local → popup.js
 *   interceptor.js → content_bridge.js   → background.js → popup focus
 */

const STORAGE_KEY_CAPTURED = 'sendiq_captured_trade';
const STORAGE_KEY_LAST_SWAP = 'sendiq_last_swap';
const STORAGE_KEY_SETTINGS  = 'sendiq_settings';

// Known token list (mint → metadata)
// Interceptor uses this to resolve symbols from mint addresses
const KNOWN_TOKENS = {
  'So11111111111111111111111111111111111111112':  { symbol: 'SOL',  name: 'Solana',    decimals: 9,  icon: '◎'  },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', name: 'USD Coin',  decimals: 6,  icon: '💵' },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', name: 'Tether',    decimals: 6,  icon: '💲' },
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  { symbol: 'JUP',  name: 'Jupiter',   decimals: 6,  icon: '🪐' },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK', name: 'Bonk',      decimals: 5,  icon: '🐶' },
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': { symbol: 'WIF',  name: 'dogwifhat', decimals: 6,  icon: '🎩' },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY',  name: 'Raydium',   decimals: 6,  icon: '⚡' },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':  { symbol: 'mSOL', name: 'Marinade',  decimals: 9,  icon: '🌊' },
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': { symbol: 'jitoSOL', name: 'JitoSOL', decimals: 9, icon: '🔥' },
};

// Reverse lookup: symbol → mint
const SYMBOL_TO_MINT = Object.fromEntries(
  Object.entries(KNOWN_TOKENS).map(([mint, t]) => [t.symbol, mint])
);

/**
 * Resolve mint address from either a mint string or a ticker symbol
 */
function resolveMint(mintOrSymbol) {
  if (!mintOrSymbol) return null;
  // Already a full mint address
  if (mintOrSymbol.length >= 32) return mintOrSymbol;
  // Ticker lookup
  return SYMBOL_TO_MINT[mintOrSymbol.toUpperCase()] ?? null;
}

/**
 * Get token metadata from mint address
 */
function getTokenMeta(mint) {
  return KNOWN_TOKENS[mint] ?? { symbol: mint.slice(0,4)+'…', name: 'Unknown', decimals: 6, icon: '?' };
}

/**
 * Parse mint addresses from jup.ag URL
 * Handles:
 *   /swap/SOL-USDC
 *   /swap?sell=So111...&buy=EPjF...
 *   /swap?inputMint=...&outputMint=...
 */
function parseMintsFromUrl(url) {
  try {
    const u = new URL(url);

    // Query param style: ?sell=...&buy=...
    const sell = u.searchParams.get('sell') ?? u.searchParams.get('inputMint');
    const buy  = u.searchParams.get('buy')  ?? u.searchParams.get('outputMint');
    if (sell && buy) {
      return {
        inputMint:  resolveMint(sell),
        outputMint: resolveMint(buy),
      };
    }

    // Path style: /swap/SOL-USDC
    const pathMatch = u.pathname.match(/\/swap\/([^-/]+)-([^/?]+)/);
    if (pathMatch) {
      return {
        inputMint:  resolveMint(pathMatch[1]),
        outputMint: resolveMint(pathMatch[2]),
      };
    }
  } catch (e) {
    // ignore
  }
  return { inputMint: null, outputMint: null };
}

/**
 * Build a CapturedTrade object from interceptor data
 */
function buildCapturedTrade({ inputMint, outputMint, amountRaw, slippageBps, riskScore, riskLevel, riskFactors, source, pageUrl }) {
  const inMeta  = getTokenMeta(inputMint  ?? 'So11111111111111111111111111111111111111112');
  const outMeta = getTokenMeta(outputMint ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const amountUI = amountRaw != null ? amountRaw / Math.pow(10, inMeta.decimals) : null;

  return {
    inputMint:    inputMint,
    outputMint:   outputMint,
    inputSymbol:  inMeta.symbol,
    outputSymbol: outMeta.symbol,
    inputIcon:    inMeta.icon,
    outputIcon:   outMeta.icon,
    inputDecimals: inMeta.decimals,
    amountRaw:    amountRaw,
    amountUI:     amountUI,
    originalSlippageBps: slippageBps ?? 50,
    riskScore:    riskScore ?? 0,
    riskLevel:    riskLevel ?? 'UNKNOWN',
    riskFactors:  riskFactors ?? [],
    source:       source ?? 'unknown',
    capturedAt:   Date.now(),
    pageUrl:      pageUrl ?? '',
    status:       'pending',
  };
}

/**
 * Check if a captured trade is still fresh (within 5 minutes)
 */
function isTradeFresh(capturedTrade) {
  if (!capturedTrade?.capturedAt) return false;
  return (Date.now() - capturedTrade.capturedAt) < 5 * 60 * 1000;
}

// Export as window namespace for interceptor (MAIN world, no modules)
if (typeof window !== 'undefined') {
  window.ZendIQ = window.ZendIQ ?? {};
  Object.assign(window.ZendIQ, {
    KNOWN_TOKENS,
    SYMBOL_TO_MINT,
    STORAGE_KEY_CAPTURED,
    STORAGE_KEY_LAST_SWAP,
    STORAGE_KEY_SETTINGS,
    resolveMint,
    getTokenMeta,
    parseMintsFromUrl,
    buildCapturedTrade,
    isTradeFresh,
  });
}

// Also export for popup (module context)
if (typeof module !== 'undefined') {
  module.exports = {
    KNOWN_TOKENS, SYMBOL_TO_MINT,
    STORAGE_KEY_CAPTURED, STORAGE_KEY_LAST_SWAP, STORAGE_KEY_SETTINGS,
    resolveMint, getTokenMeta, parseMintsFromUrl, buildCapturedTrade, isTradeFresh,
  };
}
