/**
 * ZendIQ – utils.js
 * Pure utility helpers: JSON parsing, base64/binary conversions,
 * base-58 encoding, fee-payer extraction, and the generic RPC helper.
 */

(function () {
  const ns = window.__zq;

  function tryParseJson(data) {
    try { return JSON.parse(data); } catch { return null; }
  }

  function base64ToUint8Array(b64) {
    try {
      const bin = atob(b64);
      const len = bin.length;
      const arr = new Uint8Array(len);
      for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    } catch (e) { return null; }
  }

  function b58Encode(bytes) {
    const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const digits = [0];
    for (let i = 0; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    for (let i = 0; bytes[i] === 0; i++) digits.push(0);
    return digits.reverse().map(d => ALPHA[d]).join('');
  }

  /**
   * Extract the fee payer (account index 0) directly from a serialised
   * Solana transaction's raw bytes and return it as a base58 string.
   */
  function extractFeePayerFromTx(b64) {
    try {
      const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      let off = 0;
      if ((raw[0] & 0x80) !== 0) off = 1;  // versioned tx: skip version byte
      const numSigs = raw[off];             // compact-u16; simplified (< 128 sigs)
      off += 1 + numSigs * 64;              // skip all signatures
      off += 3;                             // skip 3-byte message header
      off += 1;                             // skip compact-u16 account count
      if (off + 32 > raw.length) return null;
      return b58Encode(raw.slice(off, off + 32));
    } catch (_) { return null; }
  }

  // Route arbitrary JSON GET requests through bridge → background service worker.
  // Used for third-party APIs (RugCheck etc.) that jup.ag's CSP would block from MAIN world.
  function pageJsonFetch(url, headers) {
    return new Promise((resolve, reject) => {
      const _id = Math.random().toString(36).slice(2);
      const _timeout = setTimeout(() => {
        window.removeEventListener('message', _handler);
        reject(new Error('FETCH_PAGE_JSON timeout'));
      }, 10000);
      function _handler(ev) {
        if (!ev.data?.sr_bridge || ev.data.msg?.type !== 'FETCH_PAGE_JSON_RESPONSE' || ev.data.msg?._id !== _id) return;
        clearTimeout(_timeout);
        window.removeEventListener('message', _handler);
        const res = ev.data.msg.result;
        if (res?.ok) resolve(res.data);
        else reject(new Error(res?.error ?? 'Fetch failed'));
      }
      window.addEventListener('message', _handler);
      try {
        window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'FETCH_PAGE_JSON', url, headers: headers || null, _id } }, '*');
      } catch (e) {
        clearTimeout(_timeout);
        window.removeEventListener('message', _handler);
        reject(e);
      }
    });
  }

  // Route arbitrary JSON POST requests through bridge → background service worker.
  // Used for Raydium /transaction/swap-base-in and similar POST-only APIs.
  function pageJsonPost(url, bodyObj, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const _id = Math.random().toString(36).slice(2);
      const _timeout = setTimeout(() => {
        window.removeEventListener('message', _handler);
        reject(new Error('FETCH_PAGE_JSON_POST timeout'));
      }, timeoutMs);
      function _handler(ev) {
        if (!ev.data?.sr_bridge || ev.data.msg?.type !== 'FETCH_PAGE_JSON_RESPONSE' || ev.data.msg?._id !== _id) return;
        clearTimeout(_timeout);
        window.removeEventListener('message', _handler);
        const res = ev.data.msg.result;
        if (res?.ok) resolve(res.data);
        else reject(new Error(res?.error ?? 'POST fetch failed'));
      }
      window.addEventListener('message', _handler);
      try {
        window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'FETCH_PAGE_JSON_POST', url, body: bodyObj, _id } }, '*');
      } catch (e) {
        clearTimeout(_timeout);
        window.removeEventListener('message', _handler);
        reject(e);
      }
    });
  }

  // Route RPC calls through bridge → background service worker.
  // Direct fetch() from the MAIN world is blocked by jup.ag's Content-Security-Policy,
  // but the background service worker has no such restriction.
  function rpcCall(method, params = []) {
    return new Promise((resolve, reject) => {
      const _id = Math.random().toString(36).slice(2);
      const _timeout = setTimeout(() => {
        window.removeEventListener('message', _handler);
        reject(new Error('RPC timeout'));
      }, 12000);
      function _handler(ev) {
        if (!ev.data?.sr_bridge || ev.data.msg?.type !== 'RPC_RESPONSE' || ev.data.msg?._id !== _id) return;
        clearTimeout(_timeout);
        window.removeEventListener('message', _handler);
        const res = ev.data.msg.result;
        if (res?.ok) resolve(res.data);
        else reject(new Error(res?.error ?? 'RPC failed'));
      }
      window.addEventListener('message', _handler);
      try {
        window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'RPC_CALL', method, params, _id } }, '*');
      } catch (e) {
        clearTimeout(_timeout);
        window.removeEventListener('message', _handler);
        reject(e);
      }
    });
  }

  /**
   * After a swap lands on-chain, fetch the actual received token amount from
   * the Solana transaction record and compute real quote accuracy.
   *
   * Polls `getTransaction` up to 5 times (3 s first pause, then 2 s each).
   * Returns { actualOut: <number>, quoteAccuracy: <0-100> } or null on failure.
   *
   * @param {string} signature      - Transaction signature (base58)
   * @param {string} outputMint     - Mint address of the received token
   * @param {string} walletPubkey   - Wallet that received the tokens
   * @param {number} quotedRawOut   - Raw (integer) quoted output amount (for accuracy calc)
   * @param {number} outputDecimals - Decimal places of the output token
   */
  async function fetchActualOut(signature, outputMint, walletPubkey, quotedRawOut, outputDecimals) {
    if (!signature || !outputMint) return null;
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const isSOL = outputMint === SOL_MINT;

    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 0 ? 5000 : 3000));
      try {
        const res = await ns.rpcCall('getTransaction', [
          signature,
          { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
        ]);
        const tx = res?.result;
        if (!tx?.meta) continue; // not confirmed yet — retry

        const meta = tx.meta;
        const msg  = tx.transaction?.message ?? {};
        const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];

        // If walletPubkey wasn't available at call time (e.g. Wallet Standard not yet hooked
        // on raydium.io), derive it from the fee payer — account index 0 is always the signer.
        const _wp = walletPubkey
          ?? (keys.length > 0 ? (typeof keys[0] === 'string' ? keys[0] : (keys[0]?.pubkey ?? null)) : null);
        if (!_wp) return null;

        let actualOut = null;
        if (isSOL) {
          // Find wallet's index in the account-key list
          const idx = keys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === _wp);
          if (idx >= 0) {
            // Add fee back: wallet paid fee from its balance, but we want received SOL, not net change
            const receivedLamports = (meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0) + (meta.fee ?? 0);
            if (receivedLamports > 0) actualOut = receivedLamports / 1e9;
          }
        } else {
          // SPL token — match by mint + owner in token balance snapshots
          const post = meta.postTokenBalances ?? [];
          const pre  = meta.preTokenBalances  ?? [];
          const postEntry = post.find(e => e.mint === outputMint && e.owner === _wp);
          const preEntry  = pre.find(e  => e.mint === outputMint && e.owner === _wp);
          if (postEntry) {
            const diff = (postEntry.uiTokenAmount?.uiAmount ?? 0) - (preEntry?.uiTokenAmount?.uiAmount ?? 0);
            if (diff > 0) actualOut = diff;
          }
        }

        if (actualOut == null) return null; // tx confirmed but couldn't parse — no retry

        // Quote accuracy: actual received vs ZendIQ's quoted amount
        let quoteAccuracy = null;
        if (quotedRawOut != null && quotedRawOut > 0 && outputDecimals != null) {
          const quotedOut = Number(quotedRawOut) / Math.pow(10, outputDecimals);
          if (quotedOut > 0) quoteAccuracy = Math.min(100, (actualOut / quotedOut) * 100);
        }

        return { actualOut, quoteAccuracy };
      } catch (_) { /* retry */ }
    }
    return null;
  }

  // ── Export ───────────────────────────────────────────────────────────────
  Object.assign(ns, {
    pageJsonFetch,
    pageJsonPost,
    tryParseJson,
    base64ToUint8Array,
    b58Encode,
    extractFeePayerFromTx,
    rpcCall,
    fetchActualOut,
  });
})();
