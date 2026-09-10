/**
 * ZendIQ — jito.js
 * Shared Jito Block Engine utilities: tip injection, single-tx bundle submission,
 * and on-chain confirmation polling.
 *
 * Used by page-trade.js (Raydium swaps). Not used by page-pump.js which has its
 * own self-contained Jito logic.
 */
(function () {
  'use strict';
  const ns = window.__zq;
  if (!ns) return;

  // Official Jito tip accounts — pick one at random per bundle to reduce contention.
  const _JITO_TIPS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  ];

  // Regional Jito block-engine endpoints.
  // Do NOT include the bare mainnet LB (mainnet.block-engine.jito.wtf) — it
  // round-robins per-request so status polling would hit a different backend.
  const _JITO_ENDPOINTS = [
    'https://amsterdam.mainnet.block-engine.jito.wtf',
    'https://ny.mainnet.block-engine.jito.wtf',
    'https://frankfurt.mainnet.block-engine.jito.wtf',
    'https://tokyo.mainnet.block-engine.jito.wtf',
    'https://london.mainnet.block-engine.jito.wtf',
    'https://dublin.mainnet.block-engine.jito.wtf',
    'https://slc.mainnet.block-engine.jito.wtf',
    'https://singapore.mainnet.block-engine.jito.wtf',
  ];

  // ATL resolution cache — lookup tables are immutable, safe to cache for the session.
  const _atlCache = new Map();

  // Fetch + cache the flat address list for one ATL account.
  // On-chain AddressLookupTable data: 56-byte header, then concatenated 32-byte pubkeys.
  async function _resolveAtl(atlAddr32) {
    const atlB58 = ns.b58Encode(atlAddr32);
    if (_atlCache.has(atlB58)) return _atlCache.get(atlB58);
    try {
      const info = await ns.rpcCall('getAccountInfo', [atlB58, { encoding: 'base64' }]);
      const raw  = info?.result?.value?.data?.[0];
      if (!raw) return null;
      const data  = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
      const addrs = data.slice(56); // 32 bytes × n pubkeys after 56-byte header
      _atlCache.set(atlB58, addrs);
      return addrs;
    } catch (_) { return null; }
  }

  // ── injectJitoTip ──────────────────────────────────────────────────────────
  // Injects a Jito tip (SystemProgram.Transfer) instruction into an UNSIGNED
  // Solana transaction (V0 or legacy).
  //
  // Constraint: Solana program IDs in instructions MUST be static account
  // indices — they cannot come from ATL-resolved accounts. SystemProgram must
  // therefore be in the static list.
  //
  // AccountLoadedTwice fix: Raydium pool ATLs often include SystemProgram as a
  // passively-loaded readonly account. Inserting it into static keys as well
  // triggers AccountLoadedTwice. Solution: remove it from the ATL slot list
  // before inserting it as a static key. No Raydium instruction actually
  // references SystemProgram via the ATL (it can't — program IDs must be
  // static), so removal is safe. All affected instruction account indices
  // are remapped to account for the ATL shrink + static key insert.
  //
  // Returns new unsigned tx bytes on success, null on error.
  // Minimum tip enforced at 1,000 lamports (Jito hard minimum).
  async function injectJitoTip(txBytes, tipLamports) {
    tipLamports = Math.max(1000, tipLamports | 0);
    const tipAcctB58 = _JITO_TIPS[Math.floor(Math.random() * _JITO_TIPS.length)];
    const tipKey = ns.b58Decode(tipAcctB58);
    const sysKey = new Uint8Array(32); // SystemProgram — all zeros
    try {
      const _cu     = (buf, p) => { let v = buf[p++]; if (v & 0x80) v = (v & 0x7f) | (buf[p++] << 7); return [v, p]; };
      const _encCU  = (v) => v < 0x80 ? [v] : [0x80 | (v & 0x7f), v >> 7];
      const _encU64 = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };

      let p = 0;
      let [nSigs, pSigs] = _cu(txBytes, p);
      p = pSigs + nSigs * 64;

      const isV0          = (txBytes[p] & 0x80) !== 0;
      if (isV0) p++;
      const numReqSig     = txBytes[p];
      const numROSigned   = txBytes[p + 1];
      const numROUnsigned = txBytes[p + 2];
      p += 3;

      let [nAccts, pKeys] = _cu(txBytes, p);
      p = pKeys;
      const keysStart = p;

      // Search static keys for SystemProgram.
      let sysIdx = -1;
      for (let i = 0; i < nAccts; i++) {
        if (txBytes.slice(keysStart + i * 32, keysStart + i * 32 + 32).every((b, j) => b === sysKey[j])) {
          sysIdx = i; break;
        }
      }

      p = keysStart + nAccts * 32;
      const blockhash = txBytes.slice(p, p + 32);
      p += 32;

      let [nIxs, pIxStart] = _cu(txBytes, p);
      p = pIxStart;

      // tipKey inserted immediately before readonly-unsigned zone → writable-unsigned.
      const insertIdx = nAccts - numROUnsigned;

      const rawIxs = [];
      for (let i = 0; i < nIxs; i++) {
        const progByte = txBytes[p++];
        let [nIA, pA] = _cu(txBytes, p); p = pA;
        const ixAccts = Array.from(txBytes.slice(p, p + nIA)); p += nIA;
        let [dLen, pD] = _cu(txBytes, p); p = pD;
        const ixData  = txBytes.slice(p, p + dLen); p += dLen;
        rawIxs.push({ progByte, nIA, ixAccts, dLen, ixData });
      }

      const atlRaw = isV0 ? txBytes.slice(p) : new Uint8Array(0);

      // If SystemProgram absent from static keys, scan ATLs to find it.
      // We need to know its ATL position so we can:
      //   (a) remove it from the ATL slot list (to prevent AccountLoadedTwice), and
      //   (b) remap any instruction indices that pointed past the removed slot.
      // sysAtlInfo.flatIdx = 0-based position in the combined ATL-resolved account list.
      let sysAtlInfo = null; // { ai, slotList:'wr'|'ro', slotPos, flatIdx }
      if (isV0 && sysIdx < 0 && atlRaw.length > 0) {
        let ap = 0;
        let [nAtls, apN] = _cu(atlRaw, ap); ap = apN;
        let resolvedCount = 0;
        for (let ai = 0; ai < nAtls && !sysAtlInfo; ai++) {
          const atlAddr = atlRaw.slice(ap, ap + 32); ap += 32;
          let [nWr, apW] = _cu(atlRaw, ap); ap = apW;
          const wrSlots = Array.from(atlRaw.slice(ap, ap + nWr)); ap += nWr;
          let [nRo, apR] = _cu(atlRaw, ap); ap = apR;
          const roSlots = Array.from(atlRaw.slice(ap, ap + nRo)); ap += nRo;
          const addrs = await _resolveAtl(atlAddr);
          if (addrs) {
            for (let k = 0; k < wrSlots.length && !sysAtlInfo; k++) {
              const off = wrSlots[k] * 32;
              if (off + 32 <= addrs.length && addrs.slice(off, off + 32).every(b => b === 0))
                sysAtlInfo = { ai, slotList: 'wr', slotPos: k, flatIdx: resolvedCount + k };
            }
            for (let k = 0; k < roSlots.length && !sysAtlInfo; k++) {
              const off = roSlots[k] * 32;
              if (off + 32 <= addrs.length && addrs.slice(off, off + 32).every(b => b === 0))
                sysAtlInfo = { ai, slotList: 'ro', slotPos: k, flatIdx: resolvedCount + wrSlots.length + k };
            }
          }
          resolvedCount += wrSlots.length + roSlots.length;
        }
      }

      // sysKey always inserted as static key when absent from static keys
      // (even when sysAtlInfo is set — we remove it from ATL to avoid AccountLoadedTwice,
      //  then add it as static so it's valid as a program ID).
      const needSysKey = sysIdx < 0;
      const nInserted  = needSysKey ? 2 : 1; // tipKey [+ sysKey]

      // Account index remapping.
      // Original account zones:
      //   [0, insertIdx)            static before insertion → unchanged
      //   [insertIdx, nAccts)       static from insertion point → +nInserted
      //   [nAccts, nAccts+total)    ATL-resolved:
      //     pos < sysAtlInfo.flatIdx  → +nInserted      (pure static shift)
      //     pos = sysAtlInfo.flatIdx  → insertIdx+1     (remapped to new sysKey static)
      //     pos > sysAtlInfo.flatIdx  → +nInserted−1    (+2 static, −1 ATL removal = net +1)
      const remap = (idx) => {
        if (idx < insertIdx) return idx;
        if (idx < nAccts)   return idx + nInserted;
        if (!sysAtlInfo)    return idx + nInserted;
        const atlPos = idx - nAccts;
        if (atlPos === sysAtlInfo.flatIdx) return insertIdx + 1; // → new sysKey static
        if (atlPos > sysAtlInfo.flatIdx)  return idx + nInserted - 1; // net +1
        return idx + nInserted; // before removed slot
      };

      // Program index for the tip instruction (must be a static index).
      const tipProgramIdx = sysIdx >= 0 ? remap(sysIdx) : (insertIdx + 1);
      const tipAccountIdx = insertIdx; // newly inserted tipKey

      // Rebuild ATL section, removing the SystemProgram slot from its ATL.
      const newAtlBytes = [];
      if (isV0) {
        let ap = 0;
        let [nAtls, apN] = _cu(atlRaw, ap); ap = apN;
        newAtlBytes.push(..._encCU(nAtls));
        for (let ai = 0; ai < nAtls; ai++) {
          for (let i = 0; i < 32; i++) newAtlBytes.push(atlRaw[ap + i]);
          ap += 32;
          let [nWr, apW] = _cu(atlRaw, ap); ap = apW;
          const wrSlots = Array.from(atlRaw.slice(ap, ap + nWr)); ap += nWr;
          let [nRo, apR] = _cu(atlRaw, ap); ap = apR;
          const roSlots = Array.from(atlRaw.slice(ap, ap + nRo)); ap += nRo;
          let finalWr = wrSlots, finalRo = roSlots;
          if (sysAtlInfo && ai === sysAtlInfo.ai) {
            if (sysAtlInfo.slotList === 'wr') finalWr = wrSlots.filter((_, k) => k !== sysAtlInfo.slotPos);
            else                              finalRo = roSlots.filter((_, k) => k !== sysAtlInfo.slotPos);
          }
          newAtlBytes.push(..._encCU(finalWr.length));
          for (const s of finalWr) newAtlBytes.push(s);
          newAtlBytes.push(..._encCU(finalRo.length));
          for (const s of finalRo) newAtlBytes.push(s);
        }
      }

      const out = [];
      if (isV0) out.push(0x80);
      out.push(numReqSig, numROSigned, needSysKey ? numROUnsigned + 1 : numROUnsigned);
      out.push(..._encCU(nAccts + nInserted));

      // Static keys: [0..insertIdx) + tipKey [+ sysKey] + [insertIdx..nAccts)
      for (let i = 0; i < insertIdx * 32; i++) out.push(txBytes[keysStart + i]);
      for (let i = 0; i < 32; i++) out.push(tipKey[i]);
      if (needSysKey) { for (let i = 0; i < 32; i++) out.push(sysKey[i]); }
      for (let i = insertIdx * 32; i < nAccts * 32; i++) out.push(txBytes[keysStart + i]);

      // Blockhash (unchanged)
      for (let i = 0; i < 32; i++) out.push(blockhash[i]);

      // Instructions: existing (with remapped indices) + tip transfer at end
      out.push(..._encCU(nIxs + 1));
      for (const ix of rawIxs) {
        out.push(remap(ix.progByte));
        out.push(..._encCU(ix.nIA));
        for (const a of ix.ixAccts) out.push(remap(a));
        out.push(..._encCU(ix.dLen));
        for (let i = 0; i < ix.ixData.length; i++) out.push(ix.ixData[i]);
      }

      // Tip instruction: SystemProgram.Transfer(fee-payer[0] → tipKey, lamports)
      const tipData = new Uint8Array([2, 0, 0, 0, ..._encU64(tipLamports)]);
      out.push(tipProgramIdx);  // program = SystemProgram (static index)
      out.push(..._encCU(2));   // 2 accounts
      out.push(0);              // source = fee-payer (always index 0)
      out.push(tipAccountIdx);  // destination = tipKey
      out.push(..._encCU(12));  // data length = 12
      for (let i = 0; i < tipData.length; i++) out.push(tipData[i]);

      // ATL section (rebuilt — identical to original when sysAtlInfo is null)
      for (const b of newAtlBytes) out.push(b);

      const newMsg        = new Uint8Array(out);
      const sigCountBytes = _encCU(nSigs);
      const result        = new Uint8Array(sigCountBytes.length + nSigs * 64 + newMsg.length);
      let wp = 0;
      for (const b of sigCountBytes) result[wp++] = b;
      result.set(txBytes.slice(pSigs, pSigs + nSigs * 64), wp);
      wp += nSigs * 64;
      result.set(newMsg, wp);
      return result;
    } catch (e) {
      console.warn('[ZendIQ Jito] injectJitoTip failed:', e.message);
      return null;
    }
  }

  // ── submitJitoBundleOnly ──────────────────────────────────────────────────
  // Submit a single signed transaction as a Jito-protected bundle via
  // sendTransaction?bundleOnly=true. Routes through the background service worker
  // so the x-bundle-id response header is readable (CORS blocks it from page context).
  // Returns { sig, bundleId, endpoint } on success. Throws if all endpoints reject.
  async function submitJitoBundleOnly(signedTxB64) {
    return new Promise((resolve, reject) => {
      const _id      = Math.random().toString(36).slice(2);
      const _timeout = setTimeout(() => {
        window.removeEventListener('message', _handler);
        reject(new Error('Jito: all regional endpoints unavailable (429/503/timeout)'));
      }, 15000);
      const _handler = (e) => {
        if (!e.data?.sr_bridge || e.data.msg?.type !== 'JITO_SUBMIT_RESPONSE' || e.data.msg._id !== _id) return;
        clearTimeout(_timeout);
        window.removeEventListener('message', _handler);
        const r = e.data.msg.result;
        if (r?.ok && r?.sig) {
          resolve({ sig: r.sig, bundleId: r.bundleId ?? null, endpoint: r.endpoint });
        } else {
          reject(new Error(r?.error || 'Jito submit failed'));
        }
      };
      window.addEventListener('message', _handler);
      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'JITO_SUBMIT', signedTxB64, _id } }, '*');
    });
  }

  // ── awaitJitoSigConfirmation ──────────────────────────────────────────────
  // Poll getSignatureStatuses until the transaction is confirmed on-chain,
  // fails on-chain, or the timeout elapses.
  // Returns { ok: true, slot } on confirmed success.
  // Throws on on-chain failure (tx included but errored).
  // Returns null on timeout (blockhash window elapsed; bundle likely expired).
  // That window is 150 slots, so it shrinks as slot time does: ~60s at 400ms,
  // ~45s at the current 300ms, ~30s at the 200ms target (SIMD-0525).
  async function awaitJitoSigConfirmation(sig, rpcUrl, maxWaitMs) {
    const url   = rpcUrl || ns._jupRpcUrl || 'https://api.mainnet-beta.solana.com';
    const limit = maxWaitMs ?? 30000;
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < limit) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
      attempt++;
      try {
        const r  = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[sig]] }),
          signal: AbortSignal.timeout(4000),
        });
        const d  = await r.json();
        const sv = d?.result?.value?.[0];
        if (sv?.err)       throw new Error('Jito tx failed on-chain: ' + JSON.stringify(sv.err));
        if (sv && !sv.err) return { ok: true, slot: sv.slot };
      } catch (e) {
        if (e.message.startsWith('Jito tx failed')) throw e;
        console.warn(`[ZendIQ Jito] poll ${attempt} error:`, e.message);
      }
    }
    return null; // timeout
  }

  Object.assign(ns, { injectJitoTip, submitJitoBundleOnly, awaitJitoSigConfirmation });
})();
