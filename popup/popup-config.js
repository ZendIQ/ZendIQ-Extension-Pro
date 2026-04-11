/**
 * ZendIQ popup — config
 * Shared constants, token list, and mutable state used across popup modules.
 */

const TOKENS = [
  { symbol:'SOL',  name:'Solana',    mint:'So11111111111111111111111111111111111111112',  decimals:9 },
  { symbol:'USDC', name:'USD Coin',  mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals:6 },
  { symbol:'USDT', name:'Tether',    mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals:6 },
  { symbol:'JUP',  name:'Jupiter',   mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals:6 },
  { symbol:'BONK', name:'Bonk',      mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals:5 },
  { symbol:'WIF',  name:'dogwifhat', mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals:6 },
  { symbol:'RAY',  name:'Raydium',   mint:'4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals:6 },
];

const SLIPPAGE_BPS      = 50;
const ULTRA_ORDER_URL   = 'https://lite-api.jup.ag/ultra/v1/order';
const ULTRA_EXECUTE_URL = 'https://lite-api.jup.ag/ultra/v1/execute';

// ── Priority fees (baked into the transaction at order time) ─────────────
const PRIORITY_FEE_LOW  =  50_000;  // kept for reference
const PRIORITY_FEE_HIGH = 100_000;
const JITO_TIP_HIGH     = 100_000;

// ── Dynamic fee calculator (mirrors page-config.js version) ─────────────────
function calcDynamicFees({ riskScore = 0, mevScore = 0, priceImpactPct = null, tradeUsd = null, jitoMode = 'auto', solPriceUsd = null } = {}) {
  if (jitoMode === 'never')  return { priorityFeeLamports: null, jitoTipLamports: null };
  if (jitoMode === 'always') return { priorityFeeLamports: 500_000, jitoTipLamports: 200_000 };
  const mevBoost = Math.min(Math.round((mevScore ?? 0) * 0.3), 20);
  const combined = Math.min((riskScore ?? 0) + mevBoost, 100);
  const score    = (tradeUsd != null && tradeUsd < 5) ? Math.min(combined, 35) : combined;
  let priorityFee;
  if      (score < 20) priorityFee = null;
  else if (score < 40) priorityFee = 50_000;
  else if (score < 60) priorityFee = 150_000;
  else if (score < 80) priorityFee = 300_000;
  else                 priorityFee = 500_000;
  let jitoTip = null;
  if (score >= 35 && (tradeUsd == null || tradeUsd >= 5)) {
    const impact = priceImpactPct != null ? Math.abs(parseFloat(priceImpactPct)) : null;
    if (impact != null && tradeUsd != null && solPriceUsd != null && solPriceUsd > 0) {
      const mevLamports = (tradeUsd * impact * 0.35 * 0.15 / solPriceUsd) * 1e9;
      jitoTip = Math.round(Math.min(Math.max(mevLamports, 1_000), 500_000));
    } else {
      jitoTip = score < 60 ? 20_000 : score < 80 ? 80_000 : 200_000;
    }
  }
  return { priorityFeeLamports: priorityFee, jitoTipLamports: jitoTip };
}

// ── Priority fee — controls priorityFeeLamports baked into /order at fetch time ─
// jitoMode 'always' → always HIGH, 'auto' → HIGH when risk >= threshold, 'never' → LOW
const JITO_AUTO_THRESHOLD = 40;  // MEV risk score threshold for priority fee escalation

// ── ZendIQ protocol fee (future) ────────────────────────────────────────────
const FEE_WALLET    = 'BS9DnoBnndNj6QmeEbH2mxizefWYyrLond5G8bKUYxHC';

// Mutable state — written/read by wallet, swap, and captured-trade modules
let tokenIn      = TOKENS.find(t => t.symbol === 'USDC') || TOKENS[0];
let tokenOut     = TOKENS.find(t => t.symbol === 'SOL')  || TOKENS[1];
let walletPubkey = null;
let lastOrder    = null;
let jitoMode = 'auto';  // 'always' = always high priority | 'auto' = high when risky | 'never' = always standard
