/**
 * ZendIQ popup — wallet
 * Background bridge, DEX tab lookup, and wallet detection.
 */

// ── Background message bridge ──────────────────────────────────────────────
function bgMsg(payload) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(payload, response => {
        if (chrome.runtime.lastError) {
          return reject(new Error('BG: ' + chrome.runtime.lastError.message));
        }
        if (!response?.ok) return reject(new Error(response?.error || 'BG error'));
        resolve(response.data);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ── Find a jup.ag / raydium / pump.fun tab ───────────────────────────────
async function findDexTab() {
  const byUrl = await new Promise(resolve => {
    chrome.tabs.query(
      { url: ['*://jup.ag/*', '*://*.jup.ag/*', '*://raydium.io/*', '*://*.raydium.io/*', '*://pump.fun/*'] },
      tabs => resolve(tabs ?? [])
    );
  });
  if (byUrl.length) return byUrl[0];

  const allTabs = await new Promise(resolve => {
    chrome.tabs.query({}, tabs => resolve(tabs ?? []));
  });
  for (const tab of allTabs) {
    const url = tab.url ?? '';
    if (url.includes('jup.ag') || url.includes('raydium.io') || url.includes('pump.fun')) return tab;
  }
  return null;
}

// ── Determine which DEX a tab belongs to ──────────────────────────────────
function _dexSiteFromTab(tab) {
  const url = tab?.url ?? '';
  if (url.includes('raydium.io')) return { name: 'Raydium', host: 'raydium.io', href: 'https://raydium.io/swap/', color: 'var(--purple)' };
  if (url.includes('pump.fun'))   return { name: 'pump.fun', host: 'pump.fun', href: 'https://pump.fun', color: 'var(--purple)' };
  return { name: 'jup.ag', host: 'jup.ag', href: 'https://jup.ag', color: 'var(--purple)' };
}

// ── Helper injected into page to extract the connected wallet pubkey ───────
async function _injectGetPubkey(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      try {
        const getPubkey = (w) => {
          const pk = w?.publicKey;
          if (!pk) return null;
          const s = typeof pk === 'string' ? pk : (pk?.toBase58?.() ?? pk?.toString?.());
          return (s && s.length >= 32) ? s : null;
        };

        const legacy = [
          window.phantom?.solana, window.solflare,
          window.backpack?.solana, window.jupiterWallet, window.jupiter?.solana,
          window.okxwallet?.solana, window.solana,
        ].filter(Boolean);

        for (const w of legacy) {
          const s = getPubkey(w);
          if (s) return { state: 'connected', pubkey: s };
        }

        for (const w of legacy) {
          if (typeof w.connect === 'function' && !w.isBraveWallet) {
            try {
              await w.connect({ onlyIfTrusted: true });
              const s = getPubkey(w);
              if (s) return { state: 'connected', pubkey: s };
            } catch (_) {}
          }
        }

        const standardWallets = await new Promise(resolve => {
          const found = [];
          const handler = (e) => {
            if (typeof e?.detail?.register === 'function') {
              e.detail.register({ register(wallet) { found.push(wallet); } });
            }
          };
          window.addEventListener('wallet-standard:register-wallet', handler);
          try {
            window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
              detail: { register(wallet) { found.push(wallet); } },
            }));
          } catch (_) {}
          window.removeEventListener('wallet-standard:register-wallet', handler);
          resolve(found);
        });

        for (const w of standardWallets) {
          for (const acc of (w?.accounts ?? [])) {
            const addr = acc?.address ?? acc?.publicKey?.toString?.();
            if (addr && addr.length >= 32) return { state: 'connected', pubkey: String(addr), viaStandard: true };
          }
        }
        if (standardWallets.length) return { state: 'disconnected' };
        return { state: legacy.length ? 'disconnected' : 'none' };
      } catch (e) {
        return { state: 'error', msg: e.message };
      }
    },
  });
  return results?.[0]?.result ?? { state: 'none' };
}

// ── Wallet detection (updates header bar UI) ───────────────────────────────
async function detectWallet() {
  const dot    = document.getElementById('wallet-dot');
  const status = document.getElementById('wallet-status');
  const addr   = document.getElementById('wallet-addr');
  dot.classList.remove('on');
  addr.textContent = '';

  const tab = await findDexTab();
  if (!tab?.id) { status.textContent = 'Open jup.ag first'; return; }

  status.textContent = 'Checking…';
  let _injectResult = null;
  try {
    _injectResult = await _injectGetPubkey(tab.id);
  } catch (e) {
    // executeScript fails if host_permissions not yet granted for this origin,
    // or if the tab was open before the extension was installed. Fall back to
    // the pubkey cached in storage by the MAIN world page script.
    try {
      const { sendiq_wallet_pubkey: _pk } = await chrome.storage.local.get(['sendiq_wallet_pubkey']);
      if (_pk) _injectResult = { state: 'connected', pubkey: _pk };
    } catch (_) {}
    if (!_injectResult) {
      status.textContent = 'Could not read wallet';
      console.error('[ZendIQ] detectWallet:', e);
      return;
    }
  }
  try {
    const r = _injectResult;
    if (r.state === 'connected' && r.pubkey) {
      walletPubkey = r.pubkey;
      dot.classList.add('on');
      status.textContent = 'Wallet connected';
      const trunc = r.pubkey.slice(0,4) + '…' + r.pubkey.slice(-4);
      addr.innerHTML = `<span id="wallet-addr-trunc">${trunc}</span>` +
        `<button id="wallet-copy" class="copy-btn" title="Copy address">` +
        `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="3" y="3" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/>` +
        `<rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/>` +
        `</svg></button><span id="wallet-copy-feedback" class="copy-feedback">Copied</span>`;
      document.getElementById('wallet-copy').onclick = () => {
        try {
          navigator.clipboard.writeText(r.pubkey);
          const fb = document.getElementById('wallet-copy-feedback');
          if (fb) { fb.style.display = 'inline'; setTimeout(() => { fb.style.display = 'none'; }, 1400); }
        } catch (_) {}
      };
    } else if (r.state === 'disconnected') {
      status.textContent = 'Wallet found — not connected';
    } else {
      status.textContent = 'No wallet on this page';
    }
  } catch (e) {
    status.textContent = 'Could not read wallet';
    console.error('[ZendIQ] detectWallet:', e);
  }
}
