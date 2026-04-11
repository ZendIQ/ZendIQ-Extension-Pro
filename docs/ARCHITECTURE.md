# ZendIQ — Architecture

## Constraints

- No npm / no bundler: raw MV3 extension, vanilla JS only.
- Fetches that call Jupiter Ultra run in the page MAIN world via `chrome.scripting.executeScript` (service worker fetches may be blocked by Brave Shields).
- Wallet signing and `window.solana` access must run in the page MAIN world.

## Site Adapter Pattern (v0.8+)

All exchange-specific logic is isolated into **site adapter** modules. Each adapter registers itself
on `window.__zq` via `registerSiteAdapter()` and the five core orchestrator files delegate to
`activeSiteAdapter()` rather than containing inline `if (_isPumpFun)` branches.

### Adapter Interface

```js
{
  name:           string,              // display label
  matches():      boolean,             // true when current URL is this site
  busyStates:     string[],            // prevents re-intercept during active flow
  initPage():     void,                // called once on page load
  onNetworkRequest(url, parsed): void, // called per XHR/fetch intercept
  onWalletArgs(args): void,            // called before wallet hook fires
  onSwapDetected(txInfo, resolve): Promise<void>,  // OPTIONAL — pump.fun only
  onDecision(decision, origFn, args): Promise<any>,
  onDecisionLegacy(decision, origMethod, tx, opts): Promise<any>,
  renderMonitor(): string|null,        // idle Monitor HTML (null = use generic)
  renderFlow():   string|null,         // active flow panel HTML
  onButtonClick(id): boolean,          // return true if button was handled
  onAfterRender(): void,               // post-render DOM wiring
}
```

### Registry (`window.__zq`)

| Method | Description |
|--------|-------------|
| `registerSiteAdapter(a)` | Registers adapter; last matching adapter wins |
| `activeSiteAdapter()` | Returns matching adapter for current URL or `null` |
| `_adapterBusyStates()` | Returns `busyStates[]` of active adapter |

### Registered Adapters

| File | Site | Key behaviour |
|------|------|---------------|
| `page-jupiter.js` | jup.ag | Token score head-start from URL params; idle Monitor card |
| `page-pump.js` | pump.fun | Full flow: buy-click intercept, tx modification (0.5% slippage), Review & Sign panel, Cancel |
| `page-raydium.js` | raydium.io | URL param parsing; falls through to shared Jupiter optimisation flow |

### Script Load Order (manifest.json — MAIN world)

```
page-config.js       ← namespace + registry init
page-decoders.js     ← tx parsing (used by adapters)
page-risk.js         ← risk scoring
page-token-score.js  ← token risk scoring
page-network.js      ← network intercept (delegates onNetworkRequest)
page-jupiter.js      ← registers Jupiter adapter
page-pump.js         ← registers pump.fun adapter
page-raydium.js      ← registers Raydium adapter
page-interceptor.js  ← calls initPage(); wires wallet hooks
page-wallet.js       ← wallet hooking
page-approval.js     ← intercept gatekeeper
page-widget.js       ← widget renderer
```

---

## System Overview

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Browser (Brave / Chrome)                                       â”‚
â”‚                                                                 â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”‚
â”‚  â”‚  jup.ag tab                                              â”‚  â”‚
â”‚  â”‚                                                          â”‚  â”‚
â”‚  â”‚  MAIN world                                              â”‚  â”‚
â”‚  â”‚    page-interceptor.js                                        â”‚  â”‚
â”‚  â”‚      â€¢ hooks window.solana.signAndSendTransaction        â”‚  â”‚
â”‚  â”‚      â€¢ hooks window.fetch (watches RPC calls)            â”‚  â”‚
â”‚  â”‚      â€¢ shows overlay widget on every detected swap       â”‚  â”‚
â”‚  â”‚      â€¢ "Optimise Trade" â†’ saves CapturedTrade to storage â”‚  â”‚
â”‚  â”‚                                                          â”‚  â”‚
â”‚  â”‚  ISOLATED world                                          â”‚  â”‚
â”‚  â”‚    bridge.js                                     â”‚  â”‚
â”‚  â”‚      â€¢ forwards OPTIROUTE_SAVE_CAPTURED_TRADE messages   â”‚  â”‚
â”‚  â”‚      â€¢ bridges page â†” background                         â”‚  â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â”‚
â”‚                                                                 â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   â”‚
â”‚  â”‚  Extension Popup  â”‚    â”‚  Background (Service Worker)    â”‚   â”‚
  â”‚  popup.html       â”‚    â”‚  background.js                  â”‚   â”‚
  â”‚                  â”‚    â”‚                                  â”‚   â”‚
  â”‚  9 popup scripts: â”‚    â”‚  â€¢ PING handler                 â”‚   â”‚
  â”‚  popup-config     â”‚    â”‚  â€¢ OPEN_OPTIMISE_POPUP handler  â”‚   â”‚
  â”‚  popup-wallet     â”‚    â”‚  â€¢ Storage helpers              â”‚   â”‚
  â”‚  popup-ui         â”‚    â”‚                                 â”‚   â”‚
  â”‚  popup-swap       â”‚    â”‚                                 â”‚   â”‚
  â”‚  popup-monitor    â”‚    â”‚                                 â”‚   â”‚
  â”‚  popup-activity   â”‚    â”‚                                 â”‚   â”‚
  â”‚  popup-settings   â”‚    â”‚                                 â”‚   â”‚
  â”‚  popup-captured   â”‚    â”‚                                 â”‚   â”‚
  â”‚  popup (init)     â”‚    â”‚                                 â”‚   â”‚
  â”‚                  â”‚    â”‚                                 â”‚   â”‚
  â”‚  4 tabs:          â”‚    â”‚                                 â”‚   â”‚
  â”‚    Swap           â”‚    â”‚                                 â”‚   â”‚
  â”‚    Monitor        â”‚    â”‚                                 â”‚   â”‚
  â”‚    Activity       â”‚    â”‚                                 â”‚   â”‚
  â”‚    Settings       â”‚    â”‚                                 â”‚   â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜   â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

## Data Flow: Passive Monitoring

```
1. User visits jup.ag
2. page-interceptor.js loads in MAIN world
3. Hooks window.solana.signAndSendTransaction
4. User initiates swap on jup.ag
5. Jupiter calls wallet.signAndSendTransaction(tx)
6. page-interceptor.js catches it BEFORE it reaches wallet
7. extractTxInfo(tx) â†’ reads amounts, accounts, instruction data
8. calculateRisk(txInfo, context) â†’ score 0-100, level LOW/MEDIUM/HIGH/CRITICAL
9. showPendingTransaction() â†’ renders overlay widget
10. User sees: risk score, amount, slippage, route
11. User clicks: Block / Allow / Optimise Trade
```

## Data Flow: Optimise Trade

```
1. User clicks "Optimise Trade" in overlay
2. page-interceptor.js:
   - extractMintsFromContext() â†’ reads inputMint/outputMint from URL
   - buildCapturedTrade() â†’ creates CapturedTrade object
   - window.postMessage(OPTIROUTE_SAVE_CAPTURED_TRADE, captured)
3. bridge.js receives message:
   - chrome.storage.local.set({ sendiq_captured_trade: captured })
   - chrome.runtime.sendMessage(OPEN_OPTIMISE_POPUP)
4. background.js receives OPEN_OPTIMISE_POPUP:
   - chrome.action.openPopup()
5. popup.js opens, checkCapturedTrade() runs:
   - reads sendiq_captured_trade from storage
   - pre-fills tokenIn, tokenOut, amountUI
   - shows context banner (original trade + risk level)
   - auto-calls getQuote()
6. getQuote() via Ultra API:
   - reads walletPubkey from page (needed for taker param)
   - GET lite-api.jup.ag/ultra/v1/order?inputMint=...&taker=PUBKEY
   - response: { transaction, requestId, outAmount, routePlan, ... }
   - stores full order as lastOrder
   - displays quote details in UI
7. User clicks "Optimise & Sign":
   - injects signing script into jup.ag tab
   - deserializes VersionedTransaction from base64
   - wallet.signTransaction(tx) â†’ wallet popup appears
   - user approves â†’ signed base64 returned
   - POST lite-api.jup.ag/ultra/v1/execute { signedTransaction, requestId }
   - Jupiter broadcasts, handles landing
   - success â†’ stores to sendiq_last_swap, shows signature
```

## CapturedTrade Schema

```typescript
interface CapturedTrade {
  inputMint:    string;      // e.g. So111...112
  outputMint:   string;      // e.g. EPjFW...t1v
  inputSymbol:  string;      // e.g. "SOL"
  outputSymbol: string;      // e.g. "USDC"
  inputDecimals: number;     // e.g. 9
  amountRaw:    number;      // lamports / base units
  amountUI:     number;      // human readable e.g. 0.1
  originalSlippageBps: number;
  riskScore:    number;      // 0-100
  riskLevel:    'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskFactors:  string[];    // e.g. ["High price impact", "Memecoin target"]
  source:       'jupiter' | 'raydium' | 'unknown';
  capturedAt:   number;      // timestamp ms
  pageUrl:      string;
  status:       'pending' | 'optimised' | 'signed' | 'expired';
}
```

## Chrome Extension Worlds

| Script | World | Chrome API access | window.solana access |
|--------|-------|-------------------|---------------------|
| page-interceptor.js | MAIN | âŒ | âœ… |
| bridge.js | ISOLATED | âœ… chrome.runtime, storage | âŒ |
| background.js | Service Worker | âœ… full | âŒ |
| popup-*.js / popup.js | Extension page | âœ… full | âŒ direct |
| Injected scripts | MAIN (injected) | âŒ | âœ… |

This is why all wallet signing and fetch calls are injected into the page via `chrome.scripting.executeScript` â€” that's the only way to reach `window.solana` from non-MAIN contexts.

## Jupiter Ultra API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `lite-api.jup.ag/ultra/v1/order` | GET | Quote + unsigned transaction |
| `lite-api.jup.ag/ultra/v1/execute` | POST | Broadcast signed transaction |

**Why Ultra over Metis Swap API:**
- Single call for quote + tx (Metis needs `/quote` then `/swap`)
- Jupiter handles broadcasting â€” no `sendRawTransaction` needed
- Built-in retry, priority fees, slippage protection
- `taker` param means tx is pre-built for the specific wallet

**Priority fee / Jito tip:** Ultra supports optional params such as `priorityFeeLamports` and `jitoTipLamports` on `/order` to influence compute-unit pricing and validator tip routing. ZendIQ exposes these via `jitoMode` and runtime settings.

**Note:** `quote-api.jup.ag/v6` was fully deprecated May 2025. Do not use.
