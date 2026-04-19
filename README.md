# ZendIQ Pro

> **Solana swap optimiser with MEV protection.** Intercepts swaps on Jupiter, Raydium, and Pump.fun, scores risk in real time, and rebuilds your route through Jupiter Ultra to get you more tokens — before you sign.
>
> 🌐 [zendiq.ai](https://zendiq.ai)

> **Status:** Live in development — Chrome Web Store release pending Pro beta (June 2026). **ZendIQ Lite** (the free edition) is already live on the Chrome Web Store: [Install ZendIQ Lite →](https://chromewebstore.google.com/detail/piacdmhfdpnddopdojdfkjbbbcpgpblf)

---

## What it does

ZendIQ Pro runs alongside your favourite Solana DEX and springs into action the moment you click **Swap**. An in-page widget and popup give you:

- A **real-time risk score** for the token you are buying (0–100, 16 on-chain signals)
- A **Bot Attack Risk** rating — detects MEV exposure on the public mempool
- An **optimised route** via Jupiter's Ultra API with dynamic priority fees and optional Jito tips — fetched, compared, and ready to sign in ~1 second
- A **savings preview** before you sign showing estimated routing gain and fee breakdown
- **Auto-Profit mode** — ZendIQ signs automatically when the net gain is positive; passes Jupiter's route through when it is not

It works on **Jupiter** (`jup.ag`), **Raydium** (`raydium.io`), and **Pump.fun** (`pump.fun`) without requiring any account, email, or backend service.

---

## Built with

| Integration | Role |
|-------------|------|
| **Jupiter Ultra API** | Optimised swap order routing, transaction building, and execution |
| **Jito** | MEV protection via priority tips routed through Jupiter's execution engine; atomic bundle submission on pump.fun |
| **Solana RPC** (`mainnet-beta`, `publicnode`) | On-chain data: mint/freeze authority, holder distribution, wallet accounts |
| **Helius RPC** *(optional)* | Faster RPC for deployer history and bundle detection scans |
| **RugCheck** | Token risk flags, LP lock status, rug-pull detection |
| **DexScreener** | Token age, liquidity depth, 24 h price change, market cap |
| **GeckoTerminal** | Price history (3M / 6M), volume trend |

---

## Features

### In-page widget

A movable panel injected directly into the DEX page (4 tabs):

| Tab | What it shows |
|-----|---------------|
| **Monitor** | Live risk score, token risk score, bot-attack risk, estimated savings |
| **Review & Sign** | Rate, selling/buying amounts, price impact, route, risk cards, savings & costs breakdown, action buttons |
| **Activity** | Swap history with pair, gain/loss, exchange type, quote accuracy |
| **Wallet Security** | On-chain approval audit, Security Score, drainer detection, per-wallet guidance |
| **Settings** | Protection profile, Auto-optimise, Auto-accept, Priority fee / Jito mode, thresholds |

### Protection profiles

| Profile | Behaviour |
|---------|-----------|
| **Auto-Profit** *(recommended)* | ZendIQ signs when net positive; passes through when not — no user action needed |
| **Always Ask Me** | Every swap opens the Review & Sign panel — choose each time |
| **Major Wins Only** | Only intercepts trades with HIGH token risk or significant estimated losses |
| **Custom** | Set your own risk level, loss amount, and slippage thresholds |

### Token Risk Score

Runs 16 on-chain and market signals in parallel for every output token you select:

| Signal | Source |
|--------|--------|
| Mint authority (can devs print unlimited tokens?) | Solana RPC |
| Freeze authority (can devs lock your tokens?) | Solana RPC |
| Top holder concentration (whale / insider supply) | Solana RPC |
| RugCheck risk flags (copycat, low liquidity, known rug, etc.) | RugCheck API |
| Speculative / memecoin market risk | Token metadata |
| LP lock status | RugCheck API |
| 3-month price change | GeckoTerminal |
| Long-term price change (up to ~6 months) | GeckoTerminal |
| Volume trend / activity collapse — 7-day vs 30–90-day baseline | GeckoTerminal |
| Token age | DexScreener |
| 24 h price change | DexScreener |
| Liquidity depth | DexScreener |
| Market cap | DexScreener |
| Serial deployer — how many tokens the creator wallet launched (last 30 days) | Solana RPC |
| Deployer rug rate — what % of the deployer's previous tokens collapsed to near-zero | Solana RPC |
| Bundle launch detection — Jito bundle manipulation at token creation | Solana RPC |

Results are cached per token for 5 minutes and shown instantly for stablecoins / SOL.

### Bot Attack Risk

Analyses the pending swap for mempool-facing exposure using route structure, liquidity sources, trade size, and price impact. RFQ and gasless fills (direct market-maker routes with no mempool exposure) are flagged as N/A with no false positives.

### Wallet Security tab

Scans your connected wallet for:
- SPL Token and Token-2022 accounts with **unlimited delegations** (most common drainer vector)
- Matches against a list of known drainer contract addresses
- **Security Score** (0–100) with per-finding breakdown and a direct link to [revoke.cash](https://revoke.cash)
- Wallet-specific step-by-step guidance for disabling auto-approve in Phantom, Backpack, Solflare, Glow, Brave Wallet, and Jupiter Wallet

No transaction is signed. The scan is read-only.

### Priority fees & Jito tips

ZendIQ calculates dynamic fees based on risk score and trade size:

| Setting | Behaviour |
|---------|-----------|
| **Auto** | Fees scale with risk and trade size; no fee on LOW-risk trades beneath the threshold |
| **Always on** | Priority fee + Jito tip sent on every swap |
| **Never** | No fees added — standard network priority |

Fees flow through Jupiter's execution engine. ZendIQ never handles or custodies lamports.

---

## Risk levels

| Score | Level | What it means |
|-------|-------|---------------|
| 0–24 | 🟢 LOW | On-chain hygiene looks clean |
| 25–49 | 🟡 MEDIUM | Some risk signals present |
| 50–69 | 🟠 HIGH | Significant red flags — review carefully |
| 70–100 | 🔴 CRITICAL | Multiple severe warning signs |

---

## Install

### Manual / Developer install

1. Clone or download this repository
2. Open `chrome://extensions` (or `brave://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `zendiq-pro/` folder

> **Supported browsers:** Chrome 112+ and Brave. Manifest V3.  
> **Supported wallets:** Phantom, Backpack, Solflare, Glow, Brave Wallet, Jupiter Wallet, and any Wallet Standard-compliant wallet.

---

## Privacy & data collection

ZendIQ Pro does **not** phone home. All swap data, history, risk scores, and wallet security results are stored exclusively in `chrome.storage.local` on your own machine.

The extension contacts the following third-party APIs **from your browser** solely to calculate risk scores:

| API | Purpose |
|-----|---------|
| `api.rugcheck.xyz` | RugCheck risk flags for the output token |
| `api.dexscreener.com` | Token age, liquidity, 24 h price change |
| `api.geckoterminal.com` | Price history and volume trend |
| Solana RPC (`mainnet-beta.solana.com`, `solana.publicnode.com`) | Mint/freeze authority, holder data, wallet accounts |
| `lite-api.jup.ag` | Optimised swap order fetch and transaction execution |

### What is NEVER sent to ZendIQ servers

| Data | Where it stays |
|------|----------------|
| Wallet public key or address | `chrome.storage.local` only |
| Private keys or seed phrases | Never accessed — not technically possible from a content script |
| Transaction signatures | `chrome.storage.local` only |
| Full swap history | `chrome.storage.local` only |
| Wallet security scan results | `chrome.storage.local` only |
| Risk factor details | Computed and displayed locally |
| API responses from RugCheck, DexScreener, GeckoTerminal | Used locally for scoring; never forwarded |

ZendIQ currently operates no analytics backend for the Pro edition.

---

## Permissions

| Permission | Reason |
|------------|--------|
| `storage` | Save swap history, security scan results, and settings locally |
| `activeTab` | Detect the currently open DEX tab |
| `scripting` | Inject the risk overlay and wallet hook into DEX pages |
| `tabs` | Query open tabs to find the active DEX |
| `*://jup.ag/*`, `*://raydium.io/*`, `*://pump.fun/*` | Intercept swap events on supported DEXes |
| `https://lite-api.jup.ag/*` | Fetch optimised order and execute via Jupiter Ultra |
| `https://api.rugcheck.xyz/*` | Token risk flags |
| `https://api.dexscreener.com/*` | Token metadata and market data |
| `https://api.geckoterminal.com/*` | Price history and volume trend |
| `https://api.mainnet-beta.solana.com/*`, `https://solana.publicnode.com/*` | Solana RPC |

No payment APIs, social networks, or ad networks are contacted.

---

<details>
<summary><strong>Project structure</strong></summary>

```
zendiq-pro/
├── manifest.json                  Extension config (MV3)
├── assets/                        Extension icons (16 / 48 / 128 px)
├── popup/                         Extension popup (runs in extension context)
│   ├── popup.html                 UI — 5 tabs: Swap, Monitor, Activity, Wallet, Settings
│   ├── popup.js                   DOMContentLoaded wiring
│   ├── popup-config.js            Shared constants and mutable state
│   ├── popup-ui.js                Tab switching, token pickers, status helpers
│   ├── popup-wallet.js            Wallet detection and pubkey injection
│   ├── popup-swap.js              Quote fetch and sign flow (popup context)
│   ├── popup-monitor.js           Monitor tab renderer
│   ├── popup-activity.js          Activity tab — swap history
│   ├── popup-settings.js          Settings: profiles, toggles, thresholds
│   ├── popup-security.js          Wallet Security tab
│   └── popup-captured.js          Captured-trade banner helper
└── scripts/                       Content scripts and service worker
    ├── background.js              Service worker — external fetches, storage bridge
    ├── bridge.js                  Isolated-world relay: page ↔ background
    ├── page-config.js             window.__zq namespace, constants, shared state
    ├── page-utils.js              Encoding helpers, RPC call wrapper
    ├── page-decoders.js           Binary parser, Jupiter / Raydium instruction decoders
    ├── page-risk.js               Risk scoring engine (swap + MEV)
    ├── page-token-score.js        Token risk score — 16 signals, 5-min cache
    ├── page-wallet.js             Wallet detection and sign hook (MAIN world)
    ├── page-approval.js           Intercept gatekeeper — pending-decision promise
    ├── page-widget.js             In-page widget render (4 tabs + header)
    ├── page-trade.js              Quote fetch, savings gate, auto-accept, sign flow
    ├── page-network.js            Fetch + XHR override — live quote cache
    ├── page-jupiter.js            Jupiter-specific site adapter
    ├── page-raydium.js            Raydium-specific site adapter
    ├── page-pump.js               Pump.fun site adapter
    ├── page-security.js           Wallet account scanner (MAIN world)
    ├── page-badge.js              Extension icon badge helper
    ├── page-interceptor.js        Orchestrator — wires all modules on page load
    └── page-trade-store.js        Shared token list, CapturedTrade schema
```

</details>

---

## Disclaimer

ZendIQ Pro is provided for informational and convenience purposes only. It is not financial advice. Savings estimates compare ZendIQ's optimised route against Jupiter's concurrent live quote at the moment you click **Sign & Send** — the original route is never executed, so the comparison is an estimate. Zero risk cannot be guaranteed after optimisation. No profit is guaranteed.

The Lite edition has been reviewed and published on the Chrome Web Store. **ZendIQ never accesses private keys or seed phrases** — signing happens entirely inside your wallet; ZendIQ only requests the signed transaction bytes.

Use at your own risk.
