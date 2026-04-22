/**
 * ZendIQ – page-pump.js
 * pump.fun site adapter.
 * Registers with ns.registerSiteAdapter() so all pump.fun-specific logic is
 * isolated from the generic orchestrators (approval, wallet, widget, network).
 * Must load in MAIN world BEFORE page-interceptor.js.
 */

(function () {
  'use strict';
  const ns = window.__zq;
  if (!ns?.registerSiteAdapter) return;
  if (!window.location.hostname.includes('pump.fun')) return;

  // ── pump.fun program constants ────────────────────────────────────────────
  const _PUMP_PROG         = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const _PUMP_PROG_WRAPPER  = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe'; // outer wrapper — must be called, CPIs into 6EF8

  // ── Jito tip accounts (official set — one is randomly selected each bundle) ─
  const _JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  ];
  const _PUMP_TIP_FLOOR       = 50_000;   // 0.00005 SOL — minimum tip for any bundle attempt
  const _PUMP_TIP_CAP         = 5_000_000; // 0.005 SOL  — maximum tip
  const _PUMP_BUNDLE_MIN_SOL  = 0.005;     // skip bundle below this — sandwich exposure < floor
  // Tip = 80% of expected sandwich exposure (0.5% slippage × trade), clamped to [floor, cap].
  // This guarantees the user always nets a benefit: saves 100% of sandwich loss, pays 80% as tip.

  // ── Parse pump.fun buy tx raw bytes → bonding curve + global accounts ───────
  // Accepts any serialized Solana tx (legacy or v0) and extracts the account
  // addresses embedded in the pump buy instruction.  Returns null on failure.
  function _parsePumpAccountsFromBytes(txBytes) {
    if (!txBytes || !ns.b58Decode || !ns.b58Encode) return null;
    try {
      // compact-u16 decoder: 1 byte if value < 128, else 2 bytes (little-endian)
      const _cu = (buf, p) => {
        let v = buf[p++];
        if (v & 0x80) v = (v & 0x7F) | (buf[p++] << 7);
        return [v, p];
      };

      let _p = 0;
      // Read signature block (compact-u16 count + 64 bytes each)
      let [_nSigs, _p0] = _cu(txBytes, _p);
      _p = _p0 + _nSigs * 64;
      // Skip v0 versioned message prefix byte (0x80) if present — it appears AFTER the signatures,
      // not at byte 0. Legacy txs have no version byte here.
      if (txBytes[_p] & 0x80) _p++;

      // Read message header (3 bytes: numSigners, numReadonlySigned, numReadonlyUnsigned)
      const _numSigners          = txBytes[_p];
      const _numReadonlySigned   = txBytes[_p + 1];
      const _numReadonlyUnsigned = txBytes[_p + 2];
      _p += 3;

      // Read static account keys (v0 txs may have additional accounts from LUTs)
      let [_nAccts, _p1] = _cu(txBytes, _p);
      _p = _p1;
      const _pkeys = [];
      for (let i = 0; i < _nAccts; i++) {
        _pkeys.push(txBytes.slice(_p, _p + 32));
        _p += 32;
      }
      // Skip recent blockhash
      _p += 32;

      // Find the pump program index in the static account list
      // Recognise both old (6EF8, BSfD) and new wrapper (FAdo9NCw) pump programs
      const _PP1 = ns.b58Decode('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
      const _PP2 = ns.b58Decode('BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW');
      const _PP3 = ns.b58Decode('FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe');
      const _eq  = (a, b) => a && b && a.length === b.length && a.every((x, j) => x === b[j]);
      const _ppIdx = _pkeys.findIndex(k => _eq(k, _PP1) || _eq(k, _PP2) || _eq(k, _PP3));
      if (_ppIdx < 0) return null;

      // Iterate instructions looking for a pump buy discriminator
      // Old 6EF8:    0x66 0x06 0x3d ...  (sha256("global:buy")[:8] for 6EF8 IDL)
      // New wrapper: 0x66 0x32 0x3d ...  (FAdo9NCw IDL)
      let [_nIxs, _p2] = _cu(txBytes, _p);
      _p = _p2;
      let _ia = null;
      for (let i = 0; i < _nIxs && !_ia; i++) {
        const _prog = txBytes[_p++]; // program index is u8 (NOT compact-u16)
        let [_na, _p3] = _cu(txBytes, _p); _p = _p3;
        const _accts = Array.from(txBytes.slice(_p, _p + _na)); _p += _na;
        let [_dl, _p4] = _cu(txBytes, _p); _p = _p4;
        const _d = txBytes.slice(_p, _p + _dl); _p += _dl;
        // Match both old and new buy discriminators
        if (_prog === _ppIdx && _d[0] === 0x66 && _d[2] === 0x3d &&
            (_d[1] === 0x06 || _d[1] === 0x32)) _ia = _accts;
      }
      if (!_ia || _ia.length < 11) return null;

      const _keysB58 = _pkeys.map(k => ns.b58Encode(k));
      return {
        global:            _keysB58[_ia[0]],
        feeRecip:          _keysB58[_ia[1]],
        bondingCurve:      _keysB58[_ia[3]],
        assocBondingCurve: _keysB58[_ia[4]],
        evtAuth:           _keysB58[_ia[10]],
        allKeys:          _keysB58,
        buyIxAcctIndices: Array.from(_ia),
        msgHeader:        { numSigners: _numSigners, numReadonlySigned: _numReadonlySigned, numReadonlyUnsigned: _numReadonlyUnsigned },
      };
    } catch (_) { return null; }
  }

  // ── Extract recent blockhash bytes from a v0 or legacy transaction ────────
  function _extractBlockhashFromTx(txBytes) {
    let p = 0;
    let nSig = txBytes[p++]; if (nSig & 0x80) nSig = (nSig & 0x7f) | (txBytes[p++] << 7);
    p += nSig * 64;
    if (txBytes[p] & 0x80) p++; // skip v0 version byte if present
    p += 3;                      // skip message header (3 bytes)
    let nAccts = txBytes[p++]; if (nAccts & 0x80) nAccts = (nAccts & 0x7f) | (txBytes[p++] << 7);
    p += nAccts * 32;
    return txBytes.slice(p, p + 32); // blockhash is next 32 bytes
  }

  // ── Inject a Jito tip instruction directly into a pump buy tx ───────────
  // Parses the v0/legacy message, inserts the tip account into the static key
  // list (writable unsigned slot), adjusts ALL existing instruction indices,
  // and appends a SystemProgram.Transfer instruction.  Returns new unsigned tx
  // bytes, or null on failure.  This eliminates the 2-tx bundle approach —
  // the tip lives inside the buy tx, so Jito sees a single atomic tx bundle.
  function _injectJitoTip(txBytes, tipLamports) {
    const tipAcctB58 = _JITO_TIP_ACCOUNTS[Math.floor(Math.random() * _JITO_TIP_ACCOUNTS.length)];
    const tipKey = ns.b58Decode(tipAcctB58);
    const sysKey = new Uint8Array(32); // SystemProgram — all zeros
    try {
      // compact-u16 decode / encode
      const _cu = (buf, p) => {
        let v = buf[p++];
        if (v & 0x80) v = (v & 0x7f) | (buf[p++] << 7);
        return [v, p];
      };
      const _encCU = (v) => v < 0x80 ? [v] : [0x80 | (v & 0x7f), v >> 7];

      // ── Parse envelope ────────────────────────────────────────────────
      let p = 0;
      let [nSigs, pSigs] = _cu(txBytes, p);
      p = pSigs + nSigs * 64; // past signature slot(s)

      // ── Parse message ─────────────────────────────────────────────────
      const isV0 = (txBytes[p] & 0x80) !== 0;
      if (isV0) p++;

      const numReqSig     = txBytes[p];
      const numROSigned   = txBytes[p + 1];
      const numROUnsigned = txBytes[p + 2];
      p += 3;

      let [nAccts, pKeys] = _cu(txBytes, p);
      p = pKeys;
      const keysStart = p;

      // Find SystemProgram index in static key list
      let sysIdx = -1;
      for (let i = 0; i < nAccts; i++) {
        let match = true;
        for (let j = 0; j < 32; j++) {
          if (txBytes[keysStart + i * 32 + j] !== sysKey[j]) { match = false; break; }
        }
        if (match) { sysIdx = i; break; }
      }
      if (sysIdx < 0) { console.warn('[ZendIQ PUMP] tip inject: SystemProgram not in static keys'); return null; }

      p = keysStart + nAccts * 32; // past all keys
      const blockhash = txBytes.slice(p, p + 32);
      p += 32;

      // ── Parse instructions ────────────────────────────────────────────
      let [nIxs, pIxStart] = _cu(txBytes, p);
      p = pIxStart;

      // Insertion point: right before the readonly-unsigned zone so the tip
      // account is writable + unsigned.  Existing readonly keys shift +1 in
      // index; header counts stay the same → layout preserved.
      const insertIdx = nAccts - numROUnsigned;

      const rawIxs = [];
      for (let i = 0; i < nIxs; i++) {
        const progByte = txBytes[p++]; // u8
        let [nIxAccts, pA] = _cu(txBytes, p); p = pA;
        const ixAccts = Array.from(txBytes.slice(p, p + nIxAccts)); p += nIxAccts;
        let [dataLen, pD] = _cu(txBytes, p); p = pD;
        const ixData = txBytes.slice(p, p + dataLen); p += dataLen;
        rawIxs.push({ progByte, nIxAccts, ixAccts, dataLen, ixData });
      }

      // Everything remaining is the ATL section (v0 only)
      const atlRaw = isV0 ? txBytes.slice(p) : new Uint8Array(0);

      // ── Shift helper: every index >= insertIdx shifts by +1 ───────────
      const shift = (idx) => idx >= insertIdx ? idx + 1 : idx;
      const newSysIdx = shift(sysIdx);
      const tipIdx    = insertIdx; // the new tip account lives here

      // ── Build new message ─────────────────────────────────────────────
      const out = [];
      if (isV0) out.push(0x80);
      out.push(numReqSig, numROSigned, numROUnsigned);
      out.push(..._encCU(nAccts + 1));

      // Static keys: [0..insertIdx-1] + tipKey + [insertIdx..nAccts-1]
      for (let i = 0; i < insertIdx * 32; i++) out.push(txBytes[keysStart + i]);
      for (let i = 0; i < 32; i++) out.push(tipKey[i]);
      for (let i = insertIdx * 32; i < nAccts * 32; i++) out.push(txBytes[keysStart + i]);

      // Blockhash (unchanged)
      for (let i = 0; i < 32; i++) out.push(blockhash[i]);

      // Instructions: nIxs + 1 (existing + tip transfer)
      out.push(..._encCU(nIxs + 1));
      for (const ix of rawIxs) {
        out.push(shift(ix.progByte)); // shifted program index
        out.push(..._encCU(ix.nIxAccts));
        for (const a of ix.ixAccts) out.push(shift(a)); // shifted account indices
        out.push(..._encCU(ix.dataLen));
        for (let i = 0; i < ix.ixData.length; i++) out.push(ix.ixData[i]);
      }

      // Tip instruction: SystemProgram.Transfer(user → tipAccount, tipLamports)
      const _encU64 = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
      const tipTransferData = new Uint8Array([2, 0, 0, 0, ..._encU64(tipLamports)]);
      out.push(newSysIdx);      // program = SystemProgram
      out.push(..._encCU(2));    // 2 accounts
      out.push(0);               // source = user (fee payer, always index 0)
      out.push(tipIdx);          // destination = tip account
      out.push(..._encCU(12));   // data length = 12
      for (let i = 0; i < tipTransferData.length; i++) out.push(tipTransferData[i]);

      // ATL section (v0 only) — copied as-is; ATL indices are internal, unaffected by static key shift
      for (let i = 0; i < atlRaw.length; i++) out.push(atlRaw[i]);

      // ── Rebuild tx envelope ───────────────────────────────────────────
      const newMsg = new Uint8Array(out);
      const sigCountBytes = _encCU(nSigs);
      const result = new Uint8Array(sigCountBytes.length + nSigs * 64 + newMsg.length);
      let wp = 0;
      for (const b of sigCountBytes) result[wp++] = b;
      // Copy existing signature slot(s) — all zeros for unsigned tx
      result.set(txBytes.slice(pSigs, pSigs + nSigs * 64), wp);
      wp += nSigs * 64;
      result.set(newMsg, wp);

      return result;
    } catch (e) {
      console.warn('[ZendIQ PUMP] tip injection failed:', e.message);
      return null;
    }
  }

  // ── Build a v0 Jito tip transfer tx (unsigned, zero-padded sig slot) ──────
  // Constructs a SOL transfer from user → one of the Jito tip accounts.
  // Uses the same blockhash as the main pump.fun tx so both land in the same block.
  function _buildJitoTipTx(userB58, blockhashBytes, tipLamports, useV0) {
    const tipAcct = _JITO_TIP_ACCOUNTS[Math.floor(Math.random() * _JITO_TIP_ACCOUNTS.length)];
    const user    = ns.b58Decode(userB58); // 32 bytes
    const tip     = ns.b58Decode(tipAcct); // 32 bytes
    const sys     = new Uint8Array(32);    // SystemProgram — all zeros
    // SystemProgram.transfer instruction data: discriminator (u32 LE = 2) + lamports (u64 LE)
    // Use BigInt path to avoid any 32-bit overflow edge cases.
    const _encU64 = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
    const ixData  = new Uint8Array([2, 0, 0, 0, ..._encU64(tipLamports)]);
    // Jito bundles require all txs to use the same version.
    // When the buy tx is v0, the tip must also be v0 — otherwise bundle is Invalid.
    const msg = useV0
      ? [
          0x80,                    // v0 version byte
          1, 0, 1,                 // header: 1 req-sig, 0 readonly-signed, 1 readonly-unsigned
          3,                       // 3 static account keys (compact-u16)
          ...user, ...tip, ...sys, // [feePayer=user, tipAcct, SystemProgram]
          ...blockhashBytes,       // shared recent blockhash (32 bytes)
          1,                       // 1 instruction (compact-u16)
          2,                       // program index = 2 (SystemProgram)
          2, 0, 1,                 // compact-u16(2) accounts + indices [0=user, 1=tip]
          12, ...ixData,           // compact-u16(12) data length + transfer data
          0,                       // 0 address table lookups (compact-u16)
        ]
      : [
          1, 0, 1,                 // header: 1 req-sig, 0 readonly-signed, 1 readonly-unsigned
          3,                       // 3 static account keys (compact-u16)
          ...user, ...tip, ...sys, // [feePayer=user, tipAcct, SystemProgram]
          ...blockhashBytes,       // shared recent blockhash (32 bytes)
          1,                       // 1 instruction (compact-u16)
          2,                       // program index = 2 (SystemProgram)
          2, 0, 1,                 // compact-u16(2) accounts + indices [0=user, 1=tip]
          12, ...ixData,           // compact-u16(12) data length + transfer data
        ];
    // Envelope: [compact-u16 numSigs=1][64 zero-byte sig placeholder][message]
    const tx = new Uint8Array(1 + 64 + msg.length);
    tx[0] = 1;
    tx.set(msg, 65);
    return tx;
  }

  // ── Sign a bundle of txs in one wallet prompt (variadic WS signTransaction) 
  // Returns an array of signed Uint8Arrays matching the input order.
  async function _wsSignBundle(txBytesArray) {
    const wsFeat = ns._wsWallet?.features?.['solana:signTransaction'];
    if (!wsFeat?.signTransaction) throw new Error('No WS signTransaction available');
    const account = ns._wsAccount;
    if (!account) throw new Error('No WS account');
    window.__zendiq_own_tx = true;
    try {
      const inputs = txBytesArray.map(b => ({ account, transaction: b, chain: 'solana:mainnet' }));
      // Wallet Standard signTransaction is a REST-parameter function: ...inputs
      // Correct call is spread: signTransaction(...inputs) so each tx is a separate arg.
      // Passing an array as a single arg wraps it: [[tx1,tx2]] → wallet gets undefined account.
      const results = await wsFeat.signTransaction(...inputs);
      const items   = Array.isArray(results) ? results : [results];
      return inputs.map((_, i) => {
        const r = items[i];
        return r?.signedTransaction ?? r?.transaction ?? null;
      });
    } finally {
      window.__zendiq_own_tx = false;
    }
  }

  async function _wsSignTx(txBytes) {
    const wsFeat = ns._wsWallet?.features?.['solana:signTransaction'];
    if (!wsFeat?.signTransaction) throw new Error('No WS signTransaction available');
    const account = ns._wsAccount;
    if (!account) throw new Error('No WS account');
    window.__zendiq_own_tx = true;
    try {
      const res = await wsFeat.signTransaction({ account, transaction: txBytes, chain: 'solana:mainnet' });
      const item = Array.isArray(res) ? res[0] : res;
      const signed = item?.signedTransaction ?? item?.transaction ?? null;
      return signed;
    } finally {
      window.__zendiq_own_tx = false;
    }
  }

  // ── Submit a single tx to Jito block engine as a protected bundle ────────
  // Uses sendTransaction?bundleOnly=true — Jito wraps the tx as a single-tx bundle
  // internally, providing full atomic bundle protection (sandwich-proof).
  // This is the Jito-recommended approach for single protected transactions.
  // Returns { bundleId, sig, endpoint } on success, { bundleId: null } on failure.
  async function _submitToJito(signedTxBytesArray) {
    const _toB64 = (bytes) => {
      let s = '';
      for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(s);
    };
    // Use the first (and only) tx in the array — single-tx bundle
    const txBytes = signedTxBytesArray[0];
    const b64Tx   = _toB64(txBytes);
    const sigSlot = txBytes.slice(1, 65);

    const _JITO_ENDPOINTS = [
      'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
      'https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
      'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
      'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
      'https://london.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
      'https://dublin.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
      'https://slc.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
      'https://singapore.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
      'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
    ];

    // Race all endpoints in parallel — first accepted wins.
    const _body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64Tx, { encoding: 'base64' }] });
    const _tryEndpoint = async (url) => {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: _body,
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json();
      const bundleId = r.headers.get('x-bundle-id') ?? null;
      if (data?.result) return { bundleId, sig: data.result, endpoint: url.replace('/api/v1/transactions?bundleOnly=true', '') };
      throw new Error(JSON.stringify(data?.error ?? 'no result'));
    };

    try {
      return await Promise.any(_JITO_ENDPOINTS.map(_tryEndpoint));
    } catch (_) {
      return { bundleId: null, endpoint: null, sig: null };
    }
  }

  // ── Poll Jito bundle landing status ────────────────────────────────────────
  // Polls getInflightBundleStatuses (fast, updated every block) then falls back to
  // getBundleStatuses (chain history lookup). Same two-step logic as page-trade.js.
  // Returns { ok: true } on landed, { ok: false, err } on failed, null on timeout.
  async function _awaitJitoBundleConfirmation(bundleId, jitoBase, maxWaitMs = 20000) {
    const _inflightUrl = jitoBase + '/api/v1/getInflightBundleStatuses';
    const _statusUrl   = jitoBase + '/api/v1/getBundleStatuses';
    const _post = async (url, body) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
      return r.json();
    };
    const start = Date.now();
    let _sawInvalid = false;
    // Step 1: poll inflight statuses (updated every slot ~400ms)
    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const d  = await _post(_inflightUrl, { jsonrpc: '2.0', id: 1, method: 'getInflightBundleStatuses', params: [[bundleId]] });
        const sv = d?.result?.value?.[0];
        if (!sv) continue; // not yet in tracker
        if (sv.status === 'Landed') return { ok: true };
        if (sv.status === 'Failed') return { ok: false, err: 'Jito bundle failed on-chain' };
        if (sv.status === 'Invalid') { _sawInvalid = true; break; } // left inflight tracker — check chain history below
      } catch (_) {}
    }
    // Step 2: getBundleStatuses — authoritative chain history check
    try {
      const d  = await _post(_statusUrl, { jsonrpc: '2.0', id: 1, method: 'getBundleStatuses', params: [[bundleId]] });
      const sv = d?.result?.value?.[0];
      if (sv?.confirmation_status) return { ok: true };
    } catch (_) {}
    // Distinguish: timed out without ever seeing Invalid (unknown — may have landed)
    // vs definitively saw Invalid + not on chain (bundle was dropped, tx never broadcast).
    return _sawInvalid ? { ok: false, err: 'bundle_invalid' } : null;
  }

  // ── Poll for on-chain confirmation (success or failure) ──────────────────
  // Returns { ok: true } on success, { ok: false, err } on failure, null on timeout.
  async function _awaitConfirmation(sig, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const res = await ns.rpcCall('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
        const status = res?.result?.value?.[0];
        if (!status) continue;
        if (status.err) return { ok: false, err: status.err };
        const cs = status.confirmationStatus;
        if (cs === 'confirmed' || cs === 'finalized') return { ok: true };
      } catch (_) {}
    }
    return null; // timeout — unknown outcome
  }

  // â”€â”€ Fetch pre-built tx from pumpportal.fun (0.5% slippage) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns raw Uint8Array tx bytes or throws.
  async function _fetchPumpportalTx(mint, solAmount, user, slippage = 0.5) {
    // Single-object body — pumpportal returns raw binary tx bytes (not JSON, not base58).
    // b58Decode is designed for 32-byte keys; using it on a full tx truncates to 32 bytes.
    const reqBody = JSON.stringify({
      publicKey:        user,
      action:           'buy',
      mint,
      amount:           solAmount,
      denominatedInSol: 'true',
      slippage:         slippage,  // percentage — caller-supplied; default 0.5%, up to 1.0% with Jito bundle
      priorityFee:      0.0001,   // SOL — added as compute budget priority fee in the tx
      pool:             'auto',    // 'auto' covers bonding curve + pump-amm + Raydium; 'pump' only targets bonding curve and 400s on migrated tokens
    });
    const res = await new Promise((resolveP) => {
      const _id = Math.random().toString(36).slice(2);
      const _h = (ev) => {
        if (!ev.data?.sr_bridge || ev.data.msg?.type !== 'FETCH_BYTES_POST_RESPONSE' || ev.data.msg._id !== _id) return;
        window.removeEventListener('message', _h);
        resolveP(ev.data.msg.result);
      };
      window.addEventListener('message', _h);
      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'FETCH_BYTES_POST', url: 'https://pumpportal.fun/api/trade-local', body: reqBody, _id } }, '*');
      setTimeout(() => { window.removeEventListener('message', _h); resolveP({ ok: false, error: 'timeout' }); }, 15000);
    });
    if (!res?.ok) throw new Error('pumpportal.fun: ' + (res?.error ?? 'request failed'));
    // Single-object endpoint returns raw binary transaction bytes — decode directly
    return Uint8Array.from(atob(res.data), c => c.charCodeAt(0));
  }

  // â”€â”€ Patch the recent blockhash in a raw legacy tx â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Locates the blockhash field by parsing the compact-u16 header, then
  // overwrites the 32 bytes with a fresh one from RPC.
  async function _patchFreshBlockhash(txBytes) {
    let p = 0;
    let nSigs = txBytes[p++];
    if (nSigs & 0x80) nSigs = (nSigs & 0x7f) | (txBytes[p++] << 7);
    p += nSigs * 64;
    if (txBytes[p] & 0x80) p++; // skip v0 version byte if present
    p += 3; // message header
    let nAccts = txBytes[p++];
    if (nAccts & 0x80) nAccts = (nAccts & 0x7f) | (txBytes[p++] << 7);
    p += nAccts * 32;
    const bhOffset = p; // blockhash starts here
    const bhRes = await ns.rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = bhRes?.result?.value?.blockhash;
    if (!blockhash) throw new Error('Could not fetch recent blockhash');
    const copy = new Uint8Array(txBytes);
    const bhBytes = ns.b58Decode(blockhash);
    for (let i = 0; i < 32; i++) copy[bhOffset + i] = bhBytes[i];
    return copy;
  }

  // ── Inject jitodontfront account into a pump.fun tx (legacy or v0) ──────────
  // Appends the DontFront pubkey as the last static read-only unsigned account.
  // No instruction references it — Jito's block engine scans the account table
  // directly to recognise the sandwich-protection signal.
  // Works for both legacy and v0 messages; fail-open on any parse error.
  function _injectDontFrontPump(txBytes) {
    const DF_B58 = 'jitodontfront111111111111111111111111111111';
    if (!ns.b58Decode) return txBytes;
    try {
      const dfBytes = ns.b58Decode(DF_B58);
      if (!dfBytes || dfBytes.length !== 32) return txBytes;

      const _cu    = (buf, p) => { let v = buf[p++]; if (v & 0x80) v = (v & 0x7F) | (buf[p++] << 7); return [v, p]; };
      const _encCU = (n) => n < 128 ? [n] : [0x80 | (n & 0x7F), n >> 7];

      // Parse envelope
      let p = 0;
      const [, p1] = _cu(txBytes, p);
      const nSigs  = txBytes[0] & 0x7F; // safe: compact-u16, always < 128 for normal txs
      const sigEnd = p1 + nSigs * 64;

      // Locate message header
      const msgStart = sigEnd;
      const isV0     = (txBytes[msgStart] & 0x80) !== 0;
      const hdrStart = isV0 ? msgStart + 1 : msgStart;

      // Header: [numReqSig, numROSigned, numROUnsigned]
      const numROUnsigned = txBytes[hdrStart + 2];

      // Static account keys start after the 3-byte header + compact-u16 nAccts
      let [nAccts, keysStart] = _cu(txBytes, hdrStart + 3);

      // Already injected?
      for (let i = 0; i < nAccts; i++) {
        const off = keysStart + i * 32;
        if (dfBytes.every((b, j) => b === txBytes[off + j])) return txBytes;
      }

      // Append DontFront as last static key (last readonly-unsigned position).
      // numROUnsigned++, nAccts++ — no instruction index shifts needed because
      // no instruction ever references this account.
      const keysEnd   = keysStart + nAccts * 32;
      const newNAccts = _encCU(nAccts + 1);

      const out = [];
      // Sig count + sigs (everything before the message)
      for (let i = 0; i < msgStart; i++) out.push(txBytes[i]);
      if (isV0) out.push(0x80);                                        // version byte
      out.push(txBytes[hdrStart], txBytes[hdrStart + 1], numROUnsigned + 1); // header
      out.push(...newNAccts);                                          // new nAccts
      for (let i = keysStart; i < keysEnd; i++) out.push(txBytes[i]); // existing keys
      for (let i = 0; i < 32; i++) out.push(dfBytes[i]);              // DontFront key
      for (let i = keysEnd; i < txBytes.length; i++) out.push(txBytes[i]); // rest unchanged

      return new Uint8Array(out);
    } catch (e) {
      console.warn('[ZendIQ PUMP] DontFront injection failed:', e.message);
      return txBytes; // fail-open — swap proceeds without DontFront
    }
  }

  // â”€â”€ Full sign + submit orchestrator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Called when user clicks "Sign at X% slippage". Fetches a pre-built tx from
  // pumpportal.fun (optimised slippage: 0.5% default, up to 1.0% when user set ≥1%,
  // plus priority fee), injects a Jito tip, signs, and submits as a single-tx Jito bundle.
  async function _signAndSubmitPumpTx() {
    const pfc = ns.pumpFunContext;
    if (!pfc) return;
    const mint      = pfc.outputMint;
    const solAmount = pfc.solAmount;
    if (!mint || !solAmount) return;
    const user = ns.resolveWalletPubkey?.();
    if (!user) return;
    // Optimised slippage: clamp user's tolerance to [0.5%, 1.0%].
    // Jito bundle + DontFront protect against bots so 1% fills more often without extra risk.
    const _ziqSlip = pfc.ziqSlip ?? Math.min(1.0, Math.max(0.5, pfc.slippagePct ?? 1.0));

    ns.widgetSwapStatus = 'pump-signing';
    try { ns.renderWidgetPanel?.(); } catch (_) {}

    try {
      // 1. Fetch pre-built tx from pumpportal.fun (optimised ZendIQ slippage baked in by API)
      //    Use prefetched tx if available and fresh (fetched during panel review time);
      //    otherwise fetch now. Prefetch TTL is 45s — well inside pumpportal's 60s window.
      let rawTxBytes;
      const _prefetch = ns._pumpPrefetchedTx;
      ns._pumpPrefetchedTx = null; // consume regardless of whether we use it
      const _prefetchAge = _prefetch ? (Date.now() - _prefetch.fetchedAt) : Infinity;
      if (_prefetch?.bytes && _prefetchAge < 45_000) {
        rawTxBytes = _prefetch.bytes;
      } else {
        rawTxBytes = await _fetchPumpportalTx(mint, solAmount, user, _ziqSlip);
      }

      // 2. Extract expected token output from pumpportal's tx for Activity recording
      const _ixData = _readPumpBuyIxData([rawTxBytes]);
      const expectedTokensRaw = _ixData?.tokenAmountRaw ?? 0;
      if (ns.pumpFunContext) ns.pumpFunContext.expectedTokenOutRaw = expectedTokensRaw;

      // 3. Calculate Jito tip — must not exceed the sandwich exposure (ZendIQ slippage tolerance).
      //    tip = 80% of exposure → user keeps 20% as net savings from protection.
      //    Below _PUMP_BUNDLE_MIN_SOL the exposure is smaller than any competitive tip — skip bundle.
      const _sandwichExposureLam = Math.round(solAmount * 1e9 * _ziqSlip / 100);
      if (solAmount < _PUMP_BUNDLE_MIN_SOL) {
        // Trade too small to bundle profitably — submit direct via RPC.
        // Show explanation card while wallet prompt is open.
        const _expLamDirect = Math.round(solAmount * 1e9 * _ziqSlip / 100);
        ns._pumpDirectExpLam = _expLamDirect; // used by _renderDirectSigning
        ns.widgetSwapStatus = 'pump-direct-signing';
        try { ns.renderWidgetPanel?.(); } catch (_) {}
        ns._pumpTxWasOptimised = false;
        ns._pumpTxSigHandled   = true;
        window.__zendiq_ws_confirmed = false;
        const signedDirectBytes = await _wsSignTx(rawTxBytes);
        if (!signedDirectBytes) throw new Error('Wallet returned no signed bytes');
        const sigDirect = ns.b58Encode?.(signedDirectBytes.slice(1, 65)) ?? null;
        const _toB64d = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(s); };
        await ns.rpcCall('sendRawTransaction', [_toB64d(signedDirectBytes), { encoding: 'base64', skipPreflight: false }]);
        ns.widgetSwapStatus = 'pump-sending';
        try { ns.renderWidgetPanel?.(); } catch (_) {}
        const confirmedDirect = sigDirect ? await _awaitConfirmation(sigDirect) : null;
        if (!confirmedDirect || confirmedDirect.ok) {
          ns.widgetSwapStatus = 'pump-done';
          ns.widgetOriginalTxSig = sigDirect ?? null;
          ns._pumpTxCooldownUntil = Date.now() + 10000;
          clearTimeout(ns._pumpSigningTimeout);
          try { ns.renderWidgetPanel?.(); } catch (_) {}
          if (sigDirect) _recordPumpActivity(sigDirect, false);
        } else {
          const _e = typeof confirmedDirect.err === 'string' ? confirmedDirect.err : Object.keys(confirmedDirect.err ?? {})[0] ?? 'on-chain error';
          throw new Error('Swap failed: ' + _e);
        }
        return;
      }
      const _tipLamports = Math.min(_PUMP_TIP_CAP, Math.max(_PUMP_TIP_FLOOR, Math.round(_sandwichExposureLam * 0.8)));
      const _ixDiag = _readPumpBuyIxData([rawTxBytes]);
      const freshTxBytes = await _patchFreshBlockhash(rawTxBytes);

      // 4. Inject Jito tip instruction directly into the buy tx.
      //    This eliminates the 2-tx bundle that was failing with Invalid status —
      //    Jito's sequential simulation rejected the separate tip tx because the buy tx
      //    depleted the user's SOL balance first.  With the tip inside the buy tx,
      //    the tip is paid atomically from the same balance before the buy executes.
      const injectedTxBytes = _injectJitoTip(freshTxBytes, _tipLamports);
      if (!injectedTxBytes) throw new Error('Failed to inject Jito tip — cannot submit bundle');

      // 4b. Inject DontFront account -- signals Jito block engine this tx is
      // sandwich-protected. Appended as last static read-only unsigned account;
      // no instruction references it so no index shifts are needed.
      const _withDontFront = _injectDontFrontPump(injectedTxBytes);

      // 5. Sign single tx with wallet (one prompt)
      const signedBytes = await _wsSignTx(_withDontFront);
      if (!signedBytes) throw new Error('Wallet returned no signed bytes');
      const _sigFilled = signedBytes.slice(1, 65).some(b => b !== 0);

      // 6. Extract signature
      const sig = ns.b58Encode?.(signedBytes.slice(1, 65)) ?? null;

      // 7. Simulate before submitting — catches stale state early
      const _toB64 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(s); };
      try {
        const _simRes = await ns.rpcCall('simulateTransaction', [_toB64(signedBytes), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }]);
        const _simVal = _simRes?.result?.value;
        if (_simVal?.err) {
          console.warn('[ZendIQ PUMP] tx simulation FAILED:', JSON.stringify(_simVal.err), '| logs:', (_simVal.logs ?? []).slice(-5).join(' | '));
        } else {
        }
      } catch (_simE) {
        console.warn('[ZendIQ PUMP DBG] simulation RPC error (non-fatal):', _simE.message);
      }

      // 8. Submit via Jito sendTransaction?bundleOnly=true — full sandwich protection
      ns._pumpTxWasOptimised  = true;
      ns._pumpTxSigHandled    = true;
      window.__zendiq_ws_confirmed = false;
      const _jitoResult = await _submitToJito([signedBytes]);

      // 9. Show "sending" state while awaiting on-chain confirmation
      ns.widgetSwapStatus = 'pump-sending';
      try { ns.renderWidgetPanel?.(); } catch (_) {}

      // 10. Poll for on-chain result
      // sendTransaction?bundleOnly=true returns a tx signature directly.
      // x-bundle-id header may not be accessible due to CORS — use bundle ID if available,
      // otherwise poll the tx signature via standard RPC.
      let confirmed;
      if (_jitoResult?.bundleId) {
        const _jitoBase = _jitoResult.endpoint;
        confirmed = await _awaitJitoBundleConfirmation(_jitoResult.bundleId, _jitoBase);
        if (confirmed?.err === 'bundle_invalid') {
          // Bundle entered auction but was not selected — poll sig as it may still land
          confirmed = sig ? await _awaitConfirmation(sig, 15000) : null;
          if (!confirmed) confirmed = { ok: false, err: 'bundle not filled \u2014 click Buy to retry.' };
        } else if (confirmed === null && sig) {
          confirmed = await _awaitConfirmation(sig, 15000);
        }
      } else if (_jitoResult?.sig || sig) {
        // No bundle ID from header (CORS) — poll the tx signature directly
        const _pollSig = sig ?? _jitoResult.sig;
        confirmed = await _awaitConfirmation(_pollSig, 25000);
        if (!confirmed) confirmed = { ok: false, err: 'bundle not confirmed \u2014 click Buy to retry.' };
      } else {
        // All Jito endpoints failed — bundle was never submitted.
        confirmed = { ok: false, err: 'all Jito endpoints unavailable \u2014 click Buy to retry.' };
      }

      if (confirmed === null) {
        // Timeout â€” treat optimistically as done
        ns.widgetSwapStatus    = 'pump-done';
        ns.widgetOriginalTxSig  = sig ?? null;
        ns._pumpTxCooldownUntil = Date.now() + 10000;
        clearTimeout(ns._pumpSigningTimeout);
        try { ns.renderWidgetPanel?.(); } catch (_) {}
        if (sig) _recordPumpActivity(sig, true, false, _tipLamports);
      } else if (confirmed.ok) {
        ns.widgetSwapStatus    = 'pump-done';
        ns.widgetOriginalTxSig  = sig ?? null;
        ns._pumpTxCooldownUntil = Date.now() + 10000;
        clearTimeout(ns._pumpSigningTimeout);
        try { ns.renderWidgetPanel?.(); } catch (_) {}
        if (sig) _recordPumpActivity(sig, true, false, _tipLamports);
      } else {
        ns._pumpTxWasOptimised = false;
        const _errMsg = typeof confirmed.err === 'string'
          ? confirmed.err
          : Object.keys(confirmed.err ?? {})[0] ?? 'on-chain error';
        ns.pumpFunErrorMsg  = `\u2715 Transaction failed (${_errMsg}) \u2014 click Buy to retry`;
        ns.widgetSwapStatus = 'pump-error';
        try { ns.renderWidgetPanel?.(); } catch (_) {}
        if (sig) _recordPumpActivity(sig, false, true /* failed */);
        clearTimeout(ns._pumpErrorTimer);
        ns._pumpErrorTimer = setTimeout(() => {
          if (ns.widgetSwapStatus === 'pump-error') {
            ns.widgetSwapStatus = '';
            ns.pumpFunContext    = null;
            ns.pumpFunErrorMsg   = null;
            try { document.getElementById('sr-widget')?.classList.remove('expanded', 'alert'); } catch (_) {}
            try { ns.renderWidgetPanel?.(); } catch (_) {}
          }
        }, 5000);
      }
    } catch (e) {
      window.__zendiq_own_tx = false;
      ns._pumpTxWasOptimised = false;
      const _isCancel = /reject|cancel|declin|denied|refus/i.test(e.message ?? '');
      ns.pumpFunErrorMsg = _isCancel
        ? '\u2715 Wallet rejected \u2014 click Buy to retry'
        : `\u2715 ${e.message ?? 'Order failed'} \u2014 click Buy to retry`;
      ns.widgetSwapStatus = 'pump-error';
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      clearTimeout(ns._pumpErrorTimer);
      ns._pumpErrorTimer = setTimeout(() => {
        if (ns.widgetSwapStatus === 'pump-error') {
          ns.widgetSwapStatus = '';
          ns.pumpFunContext    = null;
          ns.pumpFunErrorMsg   = null;
          try { document.getElementById('sr-widget')?.classList.remove('expanded', 'alert'); } catch (_) {}
          try { ns.renderWidgetPanel?.(); } catch (_) {}
        }
      }, 3000);
    }
  }
  // Expose so page-interceptor can call from the 'optimise' decision branch
  ns._signAndSubmitPumpTx = _signAndSubmitPumpTx;

  // ── Extract tx signature from wallet response ─────────────────────────
  // signAndSendTransaction response has .signature; signTransaction returns signed bytes.
  function _extractSigFromResult(r) {
    try {
      const item = Array.isArray(r) ? r[0] : r;
      if (item?.signature) {
        const raw = item.signature;
        if (typeof raw === 'string') return raw;
        if (raw instanceof Uint8Array) return ns.b58Encode?.(raw) ?? null;
      }
      let txBytes = item?.signedTransaction ?? item?.transaction ?? null;
      if (!txBytes && item instanceof Uint8Array) txBytes = item;
      if (txBytes instanceof Uint8Array && txBytes.length >= 65) {
        return ns.b58Encode?.(txBytes.slice(1, 65)) ?? null;
      }
    } catch (_) {}
    return null;
  }

  // ── Save a pump.fun trade to Activity and fire sandwich detection ──────
  // failed=true: tx landed on-chain but was rejected by the program (for transparency).
  function _recordPumpActivity(sig, optimized, failed = false, tipLamports = 0) {
    try {
      const pfc     = ns.pumpFunContext;
      const outMint = pfc?.outputMint ?? ns.lastOutputMint ?? null;
      const inMint  = 'So11111111111111111111111111111111111111112';
      const risk    = pfc?.risk ?? ns.lastRiskResult ?? null;
      const solP    = ns.widgetLastPriceData?.solPriceUsd ?? 80;
      const solAmt  = pfc?.solAmount ?? null;
      const _inUsd  = solAmt != null ? solAmt * solP : null;
      // Expected token output from the tx instruction (bytes 8-15 of pump buy ix).
      // Fallback chain: context (set by onSwapDetected) → ns cache (set by onWalletArgs
      // before context exists) → live read from raw args.
      const _quotedRawOut = pfc?.expectedTokenOutRaw
        ?? ns._pumpFunCachedExpectedOut
        ?? _expectedTokenOutFromTx(ns.pumpFunRawArgs)
        ?? null;
      ns._pumpFunCachedExpectedOut = null; // consume
      const _outDec = 6; // pump.fun tokens are always 6 decimals

      // ── Compute slippage-protection savings for Activity Actual Gain ──────────
      // For ZendIQ-optimized pump trades the "gain" is: the SOL bots could have
      // extracted at the user's original slippage (vs. ZendIQ's enforced 0.5%)
      // minus the Jito bundle tip paid for atomic protection.
      // Formula mirrors the Est. Net Benefit shown on the Review & Sign panel.
      const _origSlip   = pfc?.slippagePct ?? 1;
      const _botWindow  = solAmt != null ? solAmt * _origSlip / 100 : null;        // max extractable at orig slippage
      // Jito bundle + DontFront atomically prevents ALL sandwich extraction within the bot window.
      // Value = full window when using Jito; slippage-reduction delta only on direct (no bundle) path.
      const _savSol     = optimized && tipLamports > 0 && _botWindow != null
        ? _botWindow  // Jito bundle: entire bot window is protected
        : (_botWindow != null ? Math.max(0, _botWindow - (solAmt ?? 0) * (pfc?.ziqSlip ?? 0.5) / 100) : null);
      const _snapSavUsd = optimized && _savSol != null ? _savSol * solP : null;
      const _tipUsdSnap = optimized && tipLamports > 0 ? (tipLamports / 1e9) * solP : 0;
      const _snapNetUsd = _snapSavUsd != null ? _snapSavUsd - _tipUsdSnap : null;

      const entry = {
        signature:   sig,
        tokenIn:     'SOL',
        tokenOut:    ns.tokenScoreResult?.symbol ?? pfc?.tokenSymbol ?? '?',
        amountIn:    solAmt != null ? String(solAmt) : null,
        amountOut:   null, // filled by fetchActualOut after on-chain confirmation
        quotedOut:   _quotedRawOut != null ? String(_quotedRawOut / Math.pow(10, _outDec)) : null,
        optimized,
        failed: failed || false, // true when tx landed but was rejected on-chain
        timestamp:   Date.now(),
        inputMint:   inMint,
        outputMint:  outMint,
        outputDecimals: _outDec,
        swapType:    'bonding_curve',
        routeSource: 'pump.fun',
        jitoBundle:          optimized && tipLamports > 0,
        jitoTipLamports:     optimized && tipLamports > 0 ? tipLamports : null,
        jitoTipUsd:          optimized && tipLamports > 0 ? (tipLamports / 1e9) * solP : null,
        priorityFeeLamports: null, // pumpportal.fun bakes priority fee internally — not separately charged
        priorityFeeUsd:      null,
        riskScore:   risk?.score  ?? null,
        riskLevel:   risk?.level  ?? null,
        riskFactors: risk?.factors      ?? [],
        mevFactors:  risk?.mev?.factors ?? [],
        mevRiskLevel: risk?.mev?.riskLevel ?? null,
        mevRiskScore: risk?.mev?.riskScore ?? null,
        mevEstimatedLossPercent: risk?.mev?.estimatedLossPercentage ?? null,
        inUsdValue:  _inUsd,
        outUsdValue: null, // filled by fetchActualOut
        sandwichResult: null, // placeholder — updated async by sandwich detection below
        // Slippage-protection savings snapshot (mirrors Est. Net Benefit on Review & Sign panel):
        // bot extraction window at original vs 0.5% slippage, minus Jito tip cost.
        snapSavingsUsd: _snapSavUsd,
        snapNetUsd:     _snapNetUsd,
      };
      window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: entry } }, '*');
      // On-chain output amount + quote accuracy enrichment.
      if (outMint && ns.fetchActualOut) {
        // Cache symbol now — dismiss timer clears tokenScoreResult/pumpFunContext at 2s
        const _cachedSym = ns.tokenScoreResult?.symbol ?? pfc?.tokenSymbol ?? null;
        (async () => {
          try {
            const result = await ns.fetchActualOut(sig, outMint, null, _quotedRawOut, _outDec);
            if (!result) return;
            const update = { signature: sig, actualOutAmount: result.actualOut };
            if (result.actualOut != null) update.amountOut = String(result.actualOut);
            if (result.quoteAccuracy != null) update.quoteAccuracy = result.quoteAccuracy;
            // Resolve token symbol: closure cache → tokenScoreCache (survives dismiss) → fresh fetch
            let _sym = _cachedSym
              ?? ns.tokenScoreCache?.get(outMint)?.result?.symbol
              ?? null;
            if (!_sym && ns.fetchTokenScore) {
              try { const ts = await ns.fetchTokenScore(outMint); _sym = ts?.symbol ?? null; } catch (_) {}
            }
            if (_sym) update.tokenOut = _sym;
            // Derive outUsdValue from actualOut if token price is known
            if (result.actualOut != null && _inUsd != null && solAmt > 0) {
              update.outUsdValue = _inUsd; // approximately equal for a swap
            }
            window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: update } }, '*');
          } catch (_) {}
        })();
      }
    } catch (_) {}
    // Sandwich detection — async, fire-and-forget
    // Delay 6s so the tx is confirmed on-chain before getTransaction is called;
    // detectSandwich has no built-in polling (unlike fetchActualOut).
    // Retry once at 12s if the first attempt fails with 'unavailable'.
    try {
      const pfc    = ns.pumpFunContext;
      const outMint = pfc?.outputMint ?? ns.lastOutputMint ?? null;
      if (outMint && ns.detectSandwich) {
        const inMint = 'So11111111111111111111111111111111111111112';
        const solP   = ns.widgetLastPriceData?.solPriceUsd ?? 80;
        const solAmt = pfc?.solAmount ?? null;
        const _sandwichOpts = {
          inputDecimals: 9,
          amountIn:    solAmt,
          amountInUsd: solAmt != null ? solAmt * solP : null,
        };
        setTimeout(async () => {
          try {
            let result = await ns.detectSandwich(sig, inMint, outMint, _sandwichOpts);
            // Retry once if tx wasn't confirmed yet
            if (result?.error === 'unavailable') {
              await new Promise(r => setTimeout(r, 6000));
              result = await ns.detectSandwich(sig, inMint, outMint, _sandwichOpts);
            }
            // Always update history — send error result too so widget shows
            // "unknown" instead of eternal "pending…"
            if (!result) return;
            window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: {
              signature: sig, sandwichResult: result,
            }}}, '*');
          } catch (_) {}
        }, 6000);
      }
    } catch (_) {}
  }

  // ── Detect buy vs sell from instruction discriminator ────────────────────
  // pump.fun uses Anchor discriminators (sha256("global:method")[0..8]):
  //   buy:  0x66 0x06 0x3d ...
  //   sell: 0x33 0xe6 0x85 ...
  // Returns 'buy', 'sell', or null (unknown / not a pump.fun tx).
  function _getPumpTxSide(args) {
    if (!args) return null;
    try {
      let VTx = null;
      for (const k of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
        if (window[k]?.VersionedTransaction) { VTx = window[k].VersionedTransaction; break; }
      }
      if (!VTx) return null;
      const PUMP_PROGRAMS = new Set([
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW',
      ]);
      let vtx = null;
      if (Array.isArray(args[0]) && args[0][0]?.transaction instanceof Uint8Array) {
        vtx = VTx.deserialize(args[0][0].transaction);
      } else if (args[0]?.transaction instanceof Uint8Array) {
        vtx = VTx.deserialize(args[0].transaction);
      } else if (args[0]?.message) {
        vtx = args[0];
      }
      if (!vtx) return null;
      const msg  = vtx.message;
      const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
      const pIdx = keys.findIndex(k => PUMP_PROGRAMS.has(typeof k === 'string' ? k : k.toBase58?.() ?? String(k)));
      if (pIdx < 0) return null;
      const ixs  = msg.compiledInstructions ?? msg.instructions ?? [];
      const pIx  = ixs.find(ix => ix.programIdIndex === pIdx);
      if (!pIx) return null;
      const data = pIx.data instanceof Uint8Array ? pIx.data
        : typeof pIx.data === 'string' ? Uint8Array.from(atob(pIx.data), c => c.charCodeAt(0))
        : null;
      if (!data || data.length < 3) return null;
      if (data[0] === 0x66 && data[1] === 0x06 && data[2] === 0x3d) return 'buy';
      if (data[0] === 0x33 && data[1] === 0xe6 && data[2] === 0x85) return 'sell';
      return null;
    } catch (_) { return null; }
  }

  // ── Parse raw tx args → maxSolCost in SOL (float) ─────────────────────────
  // Reads bytes 16-23 of the pump.fun buy instruction (maxSolCost u64 LE, lamports).
  // Returns the value in SOL, or null if parsing fails.
  // Extract raw tx bytes from any pump.fun wallet-hook args format.
  function _getPumpTxRawBytes(args) {
    if (!args) return null;
    // Helper: prepend a fake 1-sig header so _readPumpBuyIxData can parse a raw message.
    // message.serialize() returns raw message bytes with no signature prefix.
    const _msgToTx = (msgBytes) => {
      const h = new Uint8Array(1 + 64); h[0] = 1; // numSigs=1, 64 zero bytes
      const out = new Uint8Array(h.length + msgBytes.length);
      out.set(h); out.set(msgBytes, h.length);
      return out;
    };
    try {
      if (Array.isArray(args[0]) && args[0][0]?.transaction instanceof Uint8Array) return args[0][0].transaction;
      if (args[0]?.transaction instanceof Uint8Array) return args[0].transaction;
      if (args[0] instanceof Uint8Array) return args[0];
      // WS format: { account: WalletAccount, transaction: VersionedTransaction }
      // pump.fun passes the VTx object under args[0].transaction.
      // NOTE: VersionedTransaction.serialize() THROWS if tx has no signatures yet
      // (pump.fun's tx is unsigned at this point). Use message.serialize() as primary.
      const _vtx = args[0]?.transaction;
      if (_vtx) {
        if (typeof _vtx.serialize === 'function') {
          try { return _vtx.serialize(); } catch (_) {}
        }
        // Primary fallback: message.serialize() works without signatures.
        if (_vtx.message && typeof _vtx.message.serialize === 'function') {
          try { return _msgToTx(_vtx.message.serialize()); } catch (_) {}
        }
        // Last resort: pass options to serialize (web3.js v1 legacy Transaction path).
        if (typeof _vtx.serialize === 'function') {
          try { return _vtx.serialize({ requireAllSignatures: false, verifySignatures: false }); } catch (_) {}
        }
      }
      // Raw VersionedTransaction or legacy Transaction at args[0]
      if (args[0]?.message && typeof args[0].serialize === 'function') {
        try { return args[0].serialize(); } catch (_) {}
        try { return args[0].serialize({ requireAllSignatures: false, verifySignatures: false }); } catch (_) {}
      }
      if (args[0]?.message && typeof args[0].message?.serialize === 'function') {
        try { return _msgToTx(args[0].message.serialize()); } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  // Raw scan for the pump buy discriminator (0x66 0x32 0x3d 0x12 0x01 0xda 0xeb 0xea).
  // Returns { maxSolCostSol, slippageBps, tokenAmountRaw } or null.
  // Works without any web3.js window global — pure byte scan.
  function _readPumpBuyIxData(args) {
    const buf = _getPumpTxRawBytes(args);
    if (!buf || buf.length < 50) return null;
    try {
      const numSigs = buf[0] ?? 0;
      const scanStart = 1 + (numSigs & 0x7f) * 64; // skip over signatures
      for (let i = scanStart; i + 25 < buf.length; i++) {
        // pump buy discriminator: 0x66 {0x06|0x32} 0x3d 0x12 ...
        // 0x06 = old 6EF8 program, 0x32 = new FAdo9NCw wrapper
        if (buf[i] !== 0x66 || (buf[i+1] !== 0x32 && buf[i+1] !== 0x06) || buf[i+2] !== 0x3d || buf[i+3] !== 0x12) continue;
        let tokenAmt = 0n, maxLam = 0n;
        for (let j = 0; j < 8; j++) tokenAmt |= BigInt(buf[i+8+j]) << BigInt(j*8);
        for (let j = 0; j < 8; j++) maxLam   |= BigInt(buf[i+16+j]) << BigInt(j*8);
        const slippageBps = buf[i+24] | (buf[i+25] << 8);
        if (maxLam < 100_000n || maxLam > 1_000_000_000_000n) continue; // sanity: 0.0001–1000 SOL
        return {
          maxSolCostSol:  Number(maxLam) / 1e9,
          slippageBps,
          tokenAmountRaw: Number(tokenAmt),
        };
      }
    } catch (_) {}
    return null;
  }

  function _maxSolCostFromTx(args) {
    return _readPumpBuyIxData(args)?.maxSolCostSol ?? null;
  }

  // Reads bytes 8-15 of the pump.fun buy instruction (expected token output, raw u64 LE).
  // Returns the raw integer amount (before decimal conversion), or null.
  function _expectedTokenOutFromTx(args) {
    return _readPumpBuyIxData(args)?.tokenAmountRaw ?? null;
  }
  // ── Tx modifier: patches maxSolCost (bytes 16-23, u64 LE) to 0.5% slippage ──
  //
  // Two-path strategy:
  //   (A) web3.js path  — uses VTx.deserialize for structured access.
  //                       Works wherever VersionedTransaction is a window global.
  //   (B) raw-scan path — scans the serialised Uint8Array for the pump buy
  //                       discriminator bytes and patches in-place. This is the
  //                       primary path on pump.fun because its webpack bundle
  //                       never exposes VersionedTransaction as a window global.
  function _modifyPumpFunTx(args, currentSlipPct) {
    if (!args || !currentSlipPct || currentSlipPct <= 0.5) return null;

    // ── shared helpers ────────────────────────────────────────────────────
    function _rdU64(buf, off) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v |= BigInt(buf[off + i]) << BigInt(i * 8);
      return Number(v);
    }
    function _wrU64(buf, off, val) {
      let n = BigInt(Math.ceil(val));
      for (let i = 0; i < 8; i++) { buf[off + i] = Number(n & 0xffn); n >>= 8n; }
    }

    // ── (B) raw-scan fallback ─────────────────────────────────────────────
    // Solana pump.fun buy instruction prefix — Anchor discriminator sha256("global:buy")[0..3].
    // We use 3 bytes + a sanity check on maxSolCost to avoid false-positive matches in
    // account keys or the blockhash. The tx bytes are mutated IN-PLACE (copy of Uint8Array).
    function _patchRaw(buf) {
      // Skip signature section: first byte is compact-u16 numSigs (typically 0x01),
      // followed by numSigs × 64 bytes. Start scanning after that to avoid accidentally
      // matching the all-zeros fee-payer signature slot on unsigned transactions.
      const numSigs = buf[0] ?? 0;
      const scanStart = 1 + numSigs * 64;
      for (let i = scanStart; i + 23 < buf.length; i++) {
        if (buf[i] !== 0x66 || buf[i + 1] !== 0x32 || buf[i + 2] !== 0x3d) continue;
        // Validate: maxSolCost must be a positive lamport amount (> 100k, < 1000 SOL in lamports)
        const maxLam = _rdU64(buf, i + 16);
        if (maxLam < 100_000 || maxLam > 1_000_000_000_000) continue;
        const baseLam = maxLam / (1 + currentSlipPct / 100);
        _wrU64(buf, i + 16, baseLam * 1.005); // 0.5% slippage
        return true;
      }
      return false;
    }

    // ── (A) web3.js structured patch ─────────────────────────────────────
    const PUMP_PROGRAMS = new Set([
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // bonding curve
      'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW', // advanced
    ]);
    function _patchVtx(vtx) {
      const msg  = vtx.message;
      const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
      const pIdx = keys.findIndex(k => PUMP_PROGRAMS.has(typeof k === 'string' ? k : k.toBase58?.() ?? String(k)));
      if (pIdx < 0) return false;
      const ixs  = msg.compiledInstructions ?? msg.instructions ?? [];
      const pIx  = ixs.find(ix => ix.programIdIndex === pIdx);
      if (!pIx) return false;
      const data = pIx.data instanceof Uint8Array ? pIx.data
        : typeof pIx.data === 'string' ? Uint8Array.from(atob(pIx.data), c => c.charCodeAt(0))
        : null;
      if (!data || data.length < 24) return false;
      const currentMax = _rdU64(data, 16);
      if (currentMax <= 0) return false;
      const baseCost = currentMax / (1 + currentSlipPct / 100);
      _wrU64(data, 16, baseCost * 1.005); // target 0.5%
      return true;
    }

    // ── Helper: patch a raw Uint8Array — tries web3.js first, raw scan second ──
    function _patchBytes(srcBytes) {
      let VTx = null;
      for (const k of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
        if (window[k]?.VersionedTransaction) { VTx = window[k].VersionedTransaction; break; }
      }
      if (!VTx) {
        for (const v of Object.values(window)) {
          if (v && typeof v === 'object' && typeof v.VersionedTransaction?.deserialize === 'function') {
            VTx = v.VersionedTransaction; break;
          }
        }
      }
      // (A) web3 path
      if (VTx) {
        try {
          const vtx = VTx.deserialize(srcBytes);
          if (_patchVtx(vtx)) return vtx.serialize();
          return null;
        } catch (_) {}
      }
      // (B) raw scan path — copy bytes so we don't corrupt the original on failure
      const patched = new Uint8Array(srcBytes);
      return _patchRaw(patched) ? patched : null;
    }

    try {
      // Wallet Standard batch: args = [[{account, transaction: Uint8Array, ...}], ...]
      if (Array.isArray(args[0]) && args[0][0]?.transaction instanceof Uint8Array) {
        const input    = args[0][0];
        const patched  = _patchBytes(input.transaction);
        if (!patched) return null;
        return [[{ ...input, transaction: patched }, ...args[0].slice(1)], ...args.slice(1)];
      }
      // Wallet Standard single: args = [{account, transaction: Uint8Array, ...}, ...]
      if (args[0]?.transaction instanceof Uint8Array) {
        const input   = args[0];
        const patched = _patchBytes(input.transaction);
        if (!patched) return null;
        return [{ ...input, transaction: patched }, ...args.slice(1)];
      }
      // Legacy VersionedTransaction: args = [vtx, opts?]
      if (args[0]?.message) {
        // VTx is already deserialized — use the structured path directly
        let VTx = null;
        for (const k of ['solanaWeb3', '__solana_web3__', 'SolanaWeb3']) {
          if (window[k]?.VersionedTransaction) { VTx = window[k].VersionedTransaction; break; }
        }
        if (!VTx) {
          for (const v of Object.values(window)) {
            if (v?.VersionedTransaction?.deserialize) { VTx = v.VersionedTransaction; break; }
          }
        }
        if (!VTx || !_patchVtx(args[0])) return null;
        return args; // modified in-place
      }
      return null;
    } catch (_) { return null; }
  }

  // ── Colour/label helpers (duplicated from widget IIFE for adapter use before helpers expose) ──
  const _clr = lv => ({ CRITICAL: '#FF4D4D', HIGH: '#FFB547', MEDIUM: '#9945FF', LOW: '#14F195' })[lv] ?? '#9B9BAD';
  const _rl  = lv => ({ CRITICAL: '⛔ Critical risk', HIGH: '⚠ High risk', MEDIUM: '⚠ Moderate risk', LOW: '✓ Low risk' })[lv] ?? lv;

  ns.registerSiteAdapter({
    name: 'pump',
    matches:    () => window.location.hostname.includes('pump.fun'),
    busyStates: ['pump-slippage-review', 'pump-signing', 'pump-direct-signing', 'pump-sending', 'pump-done', 'pump-error'],

    // ── Expose raw-bytes parser for page-network.js trade-API tap ─────────
    parseTxAccounts: _parsePumpAccountsFromBytes,

    // ── Page init: extract mint from URL for early token scoring ─────────
    initPage() {
      const m = window.location.pathname.match(/\/coin\/([1-9A-HJ-NP-Za-km-z]{32,50})/);
      if (m) {
        // Only track the mint — don't fetch the score eagerly here.
        // Visiting a coin page should not trigger the risk card in the Monitor tab.
        // The score is fetched by renderMonitor() when the widget is actually open
        // (i.e. the user initiates a swap).
        ns.lastOutputMint = m[1];
        if (m[1] !== ns._tokenScoreMint) {
          ns._tokenScoreMint  = m[1];
          ns.tokenScoreResult = null;
        }
      }
      // Listen for input events on the pump.fun buy amount field.
      // Fired when the user types or clicks a preset — captures the exact value
      // BEFORE the Buy button is clicked, avoiding the DOM scan race at swap time.
      document.addEventListener('input', (ev) => {
        const el = ev.target;
        if (!el || el.tagName !== 'INPUT') return;
        if (el.disabled || el.readOnly || el.type === 'hidden') return;
        const v = parseFloat(el.value);
        if (!isFinite(v) || v <= 0 || v > 500) return;
        // Accept only values that look like SOL amounts (not token quantities).
        // Pump.fun token amounts are usually large integers; SOL buys are typically < 10.
        // The preset buttons also fire input events — that is exactly what we want.
        if (v < 0.0001) return;
        ns.pumpFunLastInputAmt = v;
      }, true /* capture — fires before React's own handlers */);
    },

    // ── Network hook: extract mint + intended SOL amount from pump.fun API calls ────
    onNetworkRequest(url, parsed) {
      if (!url || !/pump\.fun/.test(url) || !/\/(trade|buy|swap)/.test(url)) return;
      try {
        const segs = new URL(url, location.origin).pathname.split('/')
          .filter(s => s.length >= 32 && s.length <= 50 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s));
        if (segs[0] && segs[0] !== ns.lastOutputMint) {
          ns.lastOutputMint = segs[0];
          // Track the mint but don't eagerly score — same policy as initPage().
          if (segs[0] !== ns._tokenScoreMint) {
            ns._tokenScoreMint  = segs[0];
            ns.tokenScoreResult = null;
          }
        }
        // Capture the user's intended SOL amount from the API request body.
        // pump.fun sends { amount: X, denominatedInSol: true, slippage: Y } where
        // Y is often the bonding curve progress (0-1 fraction), NOT the user's slippage
        // tolerance — so we extract amount only and derive slippage from tx bytes later.
        if (parsed?.amount != null && (parsed?.denominatedInSol === true || parsed?.denominatedInSol === 'true')) {
          const a = Number(parsed.amount);
          if (isFinite(a) && a > 0 && a < 1000) ns.pumpFunNetAmount = a;
        }
      } catch (_) {}
    },

    // ── Wallet hook: capture raw args before approval prompt ─────────────
    onWalletArgs(args) {
      // Guard: when ZendIQ is in 'pump-signing' state it's calling _wsSignTx with its
      // OWN tx bytes, which triggers this hook again via zendiqWsOverlay's re-entry
      // path. Do NOT reset the template or overwrite pumpFunRawArgs in that case —
      // both contain pump.fun's original tx data from the first real interception.
      if (ns.widgetSwapStatus === 'pump-signing') return;
      // Clear any stale template from a previous swap BEFORE extracting the new one.
      // This must happen here (not in onSwapDetected) because onSwapDetected fires
      // AFTER onWalletArgs — clearing there destroys the freshly-stored template.
      ns._pumpTxTemplate = null;
      ns.pumpFunRawArgs = args;

      // Cache expected token output immediately — pumpFunContext may not exist yet
      // (onWalletArgs runs before onSwapDetected creates the context).
      const _rawOut = _expectedTokenOutFromTx(args);
      if (_rawOut != null && _rawOut > 0) ns._pumpFunCachedExpectedOut = _rawOut;

      // Update slippage from tx bytes now that the real tx has been built.
      // This is the authoritative source — overrides anything from DOM/localStorage.
      if (ns.pumpFunContext) {
        const maxSol = _maxSolCostFromTx(args);
        const solAmt = ns.pumpFunContext.solAmount;
        if (maxSol > 0 && solAmt > 0) {
          const derived = (maxSol / solAmt - 1) * 100;
          if (derived >= 0.1 && derived <= 100) {
            ns.pumpFunContext.slippagePct = derived;
          }
        }
        if (_rawOut != null && _rawOut > 0) ns.pumpFunContext.expectedTokenOutRaw = _rawOut;
      }

      // Extract bonding curve + global accounts directly from the original pump.fun tx.
      // pump.fun buy ix IDL account order: global(0), feeRecip(1), mint(2),
      //   bondingCurve(3), assocBondingCurve(4), assocUser(5), user(6), ...
      //   eventAuthority(10)
      try {
        const _toStr = k => typeof k === 'string' ? k : k.toBase58?.() ?? null;
        const _PUMP_PROG_SET = new Set([
          '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW',
        ]);
        let _extracted = null;

        // Path A: message-object — args[0] is a VersionedTransaction object with
        // .accountKeys as live web3.js PublicKey instances (.toBase58() works).
        // instruction.data may be Uint8Array (compiledInstructions) or base58 string
        // (legacy Message.instructions) — use b58Decode for strings, NOT atob.
        if (!_extracted && args[0]?.message) {
          const _msg  = args[0].message;
          const _keys = _msg.staticAccountKeys ?? _msg.accountKeys ?? [];
          const _pIdx = _keys.findIndex(k => _PUMP_PROG_SET.has(_toStr(k)));
          if (_pIdx >= 0) {
            const _ixs = _msg.compiledInstructions ?? _msg.instructions ?? [];
            const _pIx = _ixs.find(ix => ix.programIdIndex === _pIdx);
            let _d = null;
            if (_pIx?.data instanceof Uint8Array) _d = _pIx.data;
            else if (typeof _pIx?.data === 'string') {
              // Legacy Message encodes instruction data as base58, NOT base64.
              try { _d = ns.b58Decode(_pIx.data); } catch (_) {}
            }
            if (_d && _d[0] === 0x66 && (_d[1] === 0x32 || _d[1] === 0x06) && _d[2] === 0x3d) {
              const _ia    = _pIx.accountKeyIndexes ?? _pIx.accounts ?? [];
              const _iaArr = _ia instanceof Uint8Array ? Array.from(_ia) : Array.from(_ia);
              if (_iaArr.length >= 11) {
                const _keysB58 = Array.from(_keys, k => _toStr(k));
                const _msgHdr  = _msg.header ?? {};
                _extracted = {
                  global:            _keysB58[_iaArr[0]],
                  feeRecip:          _keysB58[_iaArr[1]],
                  bondingCurve:      _keysB58[_iaArr[3]],
                  assocBondingCurve: _keysB58[_iaArr[4]],
                  evtAuth:           _keysB58[_iaArr[10]],
                  allKeys:           _keysB58,
                  buyIxAcctIndices:  _iaArr,
                  msgHeader: {
                    numSigners:          _msgHdr.numRequiredSignatures       ?? 1,
                    numReadonlySigned:   _msgHdr.numReadonlySignedAccounts   ?? 0,
                    numReadonlyUnsigned: _msgHdr.numReadonlyUnsignedAccounts ?? 7,
                  },
                };
              }
            }
          }
        }

        // Path B: raw bytes parser — covers WS {transaction:Uint8Array}, direct
        // Uint8Array, VersionedTransaction.serialize(), legacy Transaction.serialize(),
        // and Message.serialize() (message-only bytes with fake sig header prepended).
        if (!_extracted) {
          let _txBytes = null;
          const _a0 = args[0];
          if (_a0 instanceof Uint8Array) _txBytes = _a0;
          else if (_a0?.transaction instanceof Uint8Array) _txBytes = _a0.transaction;
          else if (Array.isArray(_a0) && _a0[0]?.transaction instanceof Uint8Array) _txBytes = _a0[0].transaction;
          if (!_txBytes && typeof _a0?.serialize === 'function') {
            try { _txBytes = _a0.serialize(); } catch (_) {}
            if (!_txBytes) try { _txBytes = _a0.serialize({ requireAllSignatures: false, verifySignatures: false }); } catch (_) {}
          }
          if (!_txBytes && typeof _a0?.message?.serialize === 'function') {
            try {
              const _mb = _a0.message.serialize();
              const _fh = new Uint8Array(1 + 64); _fh[0] = 1;
              _txBytes = new Uint8Array(_fh.length + _mb.length);
              _txBytes.set(_fh, 0); _txBytes.set(_mb, _fh.length);
            } catch (_) {}
          }
          if (_txBytes && _txBytes.length > 100 && ns.b58Decode && ns.b58Encode) {
            _extracted = _parsePumpAccountsFromBytes(_txBytes);
          }
        }

        if (_extracted?.bondingCurve && _extracted?.assocBondingCurve) {
          ns._pumpGlobalAccounts    = { global: _extracted.global, feeRecip: _extracted.feeRecip, evtAuth: _extracted.evtAuth };
          ns._pumpExtractedAccounts = _extracted;
          if (_extracted.allKeys?.length > 8 && _extracted.buyIxAcctIndices?.length > 10) {
            ns._pumpTxTemplate = { allKeys: _extracted.allKeys, buyIxAcctIndices: _extracted.buyIxAcctIndices, msgHeader: _extracted.msgHeader };
          }
          if (ns.pumpFunContext) {
            ns.pumpFunContext.bondingCurve      = _extracted.bondingCurve;
            ns.pumpFunContext.assocBondingCurve = _extracted.assocBondingCurve;
          }
        } else {
        }
      } catch (e) { }

      // If user already clicked "Sign at 0.5%", modify the tx in-place now.
      // The wallet hook has the real args — mutate them before origFn() is called.
      if (ns.pumpFunWantOptimise && ns.pumpFunContext) {
        ns.pumpFunWantOptimise = false;
        const slip = ns.pumpFunContext.slippagePct ?? 10;
        const mArgs = _modifyPumpFunTx(args, slip);
        if (mArgs) {
          // In-place mutation: wallet hook holds same array reference
          if (Array.isArray(args[0]) && args[0][0]?.transaction instanceof Uint8Array) {
            args[0][0] = { ...args[0][0], transaction: mArgs[0][0].transaction };
          } else if (args[0]?.transaction instanceof Uint8Array && mArgs[0]?.transaction instanceof Uint8Array) {
            args[0] = { ...args[0], transaction: mArgs[0].transaction };
          }
          // Legacy path: _modifyPumpFunTx already mutates args[0].message in-place
          ns.pumpFunModifiedArgs = mArgs; // backup for onDecision path if needed
          ns._pumpTxWasOptimised = true;  // survives to network interceptor
        }
      }
    },

    // ── Swap detection: build context, open widget, gate on slippage ─────
    async onSwapDetected(txInfo, resolve) {
      // ── Cooldown: suppress re-intercepts for 10s after a completed pump tx ──
      // pump.fun fires a second wallet hook call after confirming a trade (possibly
      // a UI retry or post-confirm action). Without this guard, the stale call
      // re-triggers pump-slippage-review after the done-original dismiss.
      if (Date.now() < (ns._pumpTxCooldownUntil ?? 0)) {
        ns.pendingDecisionResolve = null;
        ns.pendingDecisionPromise = null;
        resolve('confirm');
        return;
      }

      // ── Buy/sell detection: bail immediately for sells ─────────────────
      // Slippage optimisation patches maxSolCost (bytes 16-23), which only exists
      // on buy instructions. For sells those bytes are minSolOutput — a completely
      // different field. Sells pass straight through without showing the widget.
      const _txSide = _getPumpTxSide(ns.pumpFunRawArgs ?? []);
      if (_txSide === 'sell') {
        ns.pumpFunNetAmount  = null;
        ns.pumpFunWantOptimise = false;
        resolve('confirm');
        ns.pendingDecisionPromise = null;
        return;
      }

      // ── Amount: prefer API body (most accurate) → cached input → tx bytes ──────────
      // ns.pumpFunNetAmount is set by onNetworkRequest when pump.fun's trade
      // API call includes { amount: X, denominatedInSol: true }.
      // ns.pumpFunLastInputAmt is set by the input listener in initPage() on every
      // keystroke / preset click — the most reliable DOM source.
      const netAmt = ns.pumpFunNetAmount ?? 0;
      ns.pumpFunNetAmount    = null;   // consume
      ns.pumpFunWantOptimise = false;  // reset on each new swap intercept
      // pumpFunLastInputAmt is kept sticky (not nulled) so repeated Buy clicks
      // on the same token reuse the same value until the user changes the input.
      const _cachedInput = ns.pumpFunLastInputAmt ?? 0;

      const solAmtRaw = netAmt || _cachedInput; // user's intended spend (before slippage)

      // ── Slippage + SOL amount: read directly from tx bytes (most authoritative) ──
      // _readPumpBuyIxData does a raw discriminator scan — works on pump.fun where
      // VersionedTransaction is not a window global.  Returns maxSolCost (SOL),
      // slippageBps, and tokenAmountRaw without needing web3.js.
      const _ixData = _readPumpBuyIxData(ns.pumpFunRawArgs ?? []);
      const maxSolCostFromTx = _ixData?.maxSolCostSol ?? null;
      let slip;
      // Primary: slippageBps directly from tx data — exact, no DOM needed
      if (_ixData?.slippageBps != null && _ixData.slippageBps >= 5 && _ixData.slippageBps <= 10000) {
        slip = _ixData.slippageBps / 100;
      }

      if (slip == null && maxSolCostFromTx > 0 && solAmtRaw > 0) {
        const derived = (maxSolCostFromTx / solAmtRaw - 1) * 100;
        if (derived >= 0.1 && derived <= 100) {
          slip = derived;
        }
      }

      // DOM fallback: scan visible % buttons/inputs near the trade form.
      // Cap at 50 to exclude bonding curve progress text (often 20–99%).
      if (slip == null) {
        slip = (() => {
          try {
            const cands = Array.from(document.querySelectorAll('button, input'))
              .map(el => { const m = el.tagName === 'INPUT' ? String(el.value).match(/^(\d+(?:\.\d+)?)$/) : el.textContent?.trim().match(/^(\d+(?:\.\d+)?)\s*%$/); return m ? { el, val: parseFloat(m[1]) } : null; })
              .filter(x => x && x.val >= 0.1 && x.val <= 50);
            const act = cands.find(c =>
              /active|select|current|on/i.test(c.el.className) ||
              c.el.getAttribute('aria-pressed') === 'true' ||
              c.el.getAttribute('data-state') === 'on'
            );
            return act?.val ?? null;
          } catch (_) { return null; }
        })();
      }

      // Fallback: read slippage from pump.fun's localStorage settings.
      // pump.fun persists user-set slippage under various keys.
      if (slip == null) {
        slip = (() => {
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key) continue;
              const kl = key.toLowerCase();
              if (!kl.includes('slip')) continue;
              const raw = parseFloat(localStorage.getItem(key));
              if (!isFinite(raw) || raw <= 0) continue;
              // Fraction (e.g. 0.01 = 1%) or percentage (e.g. 1 = 1%)
              const pct = raw < 1 ? raw * 100 : raw;
              if (pct >= 0.1 && pct <= 100) return pct;
            }
          } catch (_) {}
          return null;
        })();
      }

      if (slip == null) slip = 10; // last-resort default — will be corrected by onWalletArgs
      // Derive SOL amount: prefer API/DOM → tx bytes (most reliable) → maxSolCost back-calculation
      const solAmtFromTx = (_ixData?.maxSolCostSol != null && _ixData.slippageBps != null)
        ? _ixData.maxSolCostSol / (1 + _ixData.slippageBps / 10000)
        : null;
      // Priority: tx bytes (most authoritative) > API body > cached input
      const solAmt = solAmtFromTx || solAmtRaw || (maxSolCostFromTx != null ? maxSolCostFromTx / (1 + slip / 100) : 0);

      // Guard: no input detected at all — show an error rather than buying for 0 SOL
      if (!solAmt) {
        ns.pumpFunErrorMsg  = '\u2715 Could not detect buy amount \u2014 type the amount and click Buy again';
        ns.widgetSwapStatus = 'pump-error';
        const w = document.getElementById('sr-widget');
        if (w) { w.style.display = ''; if (!w.classList.contains('expanded')) w.classList.add('expanded'); }
        ns.renderWidgetPanel?.();
        setTimeout(() => { if (ns.widgetSwapStatus === 'pump-error') { ns.pumpFunErrorMsg = null; ns.widgetSwapStatus = ''; ns.renderWidgetPanel?.(); } }, 6000);
        resolve('confirm');
        ns.pendingDecisionPromise = null;
        return;
      }

      // Re-run risk with actual SOL amount + real slippage for accurate scores
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      let pfRisk = ns.lastRiskResult;
      if (solAmt > 0) {
        try {
          const sp   = ns.widgetLastPriceData?.solPriceUsd ?? 80;
          const pfTx = { swapInfo: {
            inAmount: solAmt, inAmountUsd: solAmt * sp, tokenPriceUsd: sp,
            inputMint: SOL_MINT, outputMint: ns.lastOutputMint ?? null,
            inputSymbol: 'SOL', slippagePercent: slip,
          }};
          const ctx = await ns.fetchDevnetContext(pfTx).catch(() => ({ congestion: 'low' }));
          pfRisk = await ns.calculateRisk(pfTx, ctx);
          if (typeof ns.calculateMEVRisk === 'function') {
            const mev = ns.calculateMEVRisk({
              inputMint: SOL_MINT, outputMint: ns.lastOutputMint ?? null,
              amountUSD: solAmt * sp, routePlan: null,
              slippage: slip / 100, poolLiquidity: null,
              routeType: 'bonding_curve',
            });
            if (mev) {
              pfRisk.mev = mev;
              if (mev.riskScore > pfRisk.score) {
                pfRisk.score = Math.round((pfRisk.score + mev.riskScore) / 2);
                pfRisk.level = pfRisk.score >= 70 ? 'CRITICAL' : pfRisk.score >= 40 ? 'HIGH' : pfRisk.score >= 20 ? 'MEDIUM' : 'LOW';
              }
            }
          }
          ns.lastRiskResult = pfRisk;
        } catch (_) { pfRisk = ns.lastRiskResult; }
      }

      ns.pumpFunContext = {
        outputMint:  ns.lastOutputMint ?? null,
        tokenSymbol: ns.tokenScoreResult?.symbol ?? null,
        solAmount:   solAmt,
        slippagePct: slip,
        ziqSlip:     Math.min(1.0, Math.max(0.5, slip)),
        risk:        pfRisk ?? null,
        tokenScore:  ns.tokenScoreResult ?? null,
      };
      ns.jupiterLiveQuote    = null;
      ns.widgetCapturedTrade = null;
      ns.widgetLastOrder     = null;
      ns.widgetActiveTab     = 'monitor';
      const w = document.getElementById('sr-widget');
      if (w) {
        w.style.display = '';
        if (!w.classList.contains('expanded')) w.classList.add('expanded');
        w.classList.remove('compact', 'alert');
        ns._fitBodyHeight?.(w);
      }

      if (slip > 0.5) {
        // Slippage can be optimised — show Review & Sign and keep promise open.
        // Prefetch the pumpportal tx in the background while the user reviews the panel,
        // so the wallet popup opens instantly when they click Sign (no 200-500ms fetch wait).
        ns.widgetSwapStatus       = 'pump-slippage-review';
        ns.pendingDecisionResolve = resolve;
        ns._pumpPrefetchedTx      = null;
        const _prefetchUser = ns.resolveWalletPubkey?.();
        if (_prefetchUser) {
          _fetchPumpportalTx(ns.pumpFunContext.outputMint, ns.pumpFunContext.solAmount, _prefetchUser, ns.pumpFunContext.ziqSlip)
            .then(bytes => { ns._pumpPrefetchedTx = { bytes, fetchedAt: Date.now() }; })
            .catch(() => {}); // silent — _signAndSubmitPumpTx will re-fetch on failure
        }
        ns.renderWidgetPanel?.();
        return;
      }
      // Already near-optimal (≤ 0.5%) — pass through immediately
      ns.widgetSwapStatus = '';
      ns.renderWidgetPanel?.();
      resolve('confirm');
      ns.pendingDecisionPromise = null;
    },

    // ── Wallet Standard path: handle 'pump-optimise' and 'confirm' decisions ──
    // Returns the tx result or undefined (fall through to caller's original path).
    // Must handle 'confirm' here — if we return undefined for 'confirm', zendiqWsOverlay
    // sets widgetSwapStatus='signing-original' which only clears on Jupiter /execute,
    // which pump.fun never calls, leaving the widget permanently stuck.
    async onDecision(decision, origFn, args) {
      if (decision === 'confirm') {
        // Reachable from two paths:
        //   (a) "Sign at 0.5%" — user optimised; tx is patched, pump-done on success.
        //   (b) "Proceed anyway" / "Continue with Jupiter" — user declined ZendIQ's route;
        //       tx is unmodified, done-original on success (amber "Via Jupiter" card).
        //
        // Two patching cases on path (a):
        //   (a) onWalletArgs ran first (zendiqWsOverlay path) — it cleared pumpFunWantOptimise
        //       and set pumpFunModifiedArgs; args are already patched in-place.
        //   (b) onWalletArgs hasn't run yet — pumpFunWantOptimise is still true; we patch here.
        let callArgs = args;
        let _patchApplied = ns.pumpFunModifiedArgs !== null; // set by onWalletArgs case (a)
        if (ns.pumpFunWantOptimise) {
          // Case (b): onWalletArgs hasn't patched yet — do it now.
          ns.pumpFunWantOptimise = false;
          const slip = ns.pumpFunContext?.slippagePct ?? 10;
          const mArgs = _modifyPumpFunTx(args, slip);
          if (mArgs) { callArgs = mArgs; _patchApplied = true; }
        }
        ns.pumpFunModifiedArgs = null; // clear backup flag for next swap
        ns.pumpFunPatchedSlippage = _patchApplied; // stored for _renderDone() message
        window.__zendiq_own_tx = true;
        try {
          const r = await origFn(...callArgs);
          window.__zendiq_own_tx = false;
          window.__zendiq_ws_confirmed = false;
          const _sig = _extractSigFromResult(r);
          if (!_patchApplied) {
            // "Proceed anyway" path — signing-original was already set by handlePendingDecision;
            // transition to done-original (amber "Via Jupiter's route" card) not pump-done.
            if (_sig) _recordPumpActivity(_sig, false);
            ns.widgetOriginalTxSig = _sig ?? null;
            ns._pumpTxSigHandled   = true;
            ns._pumpTxWasOptimised = false;
            ns._pumpTxCooldownUntil = Date.now() + 10000;
            ns.widgetSwapStatus = 'done-original';
            ns.widgetActiveTab  = 'monitor';
            if (ns._signingOriginalTimeout) { clearTimeout(ns._signingOriginalTimeout); ns._signingOriginalTimeout = null; }
            try { ns.renderWidgetPanel?.(); } catch (_) {}
            // Async sanity check — slippage rejection on bonding curve will show as on-chain error
            if (_sig) (async () => {
              try {
                await new Promise(resW => setTimeout(resW, 4000));
                const txRes = await ns.rpcCall('getTransaction', [
                  _sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
                ]);
                if (txRes?.result?.meta?.err) {
                  window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE',
                    payload: { signature: _sig, txFailed: true, optimized: false },
                  }}, '*');
                }
              } catch (_) {}
            })();
            return r;
          }
          // "Sign at 0.5%" path — show green pump-done success card.
          ns.widgetSwapStatus = 'pump-done';
          try { ns.renderWidgetPanel?.(); } catch (_) {}
          if (_sig) _recordPumpActivity(_sig, _patchApplied);
          ns._pumpTxSigHandled   = true;        // prevent network interceptor from overwriting
          ns._pumpTxWasOptimised = _patchApplied; // backup for network interceptor if it still fires
          // Async on-chain sanity check: pump.fun broadcasts after we return signed bytes.
          // Poll once at ~4s (after pump-done auto-dismiss at 2s) to detect on-chain failure
          // and update the Activity entry accordingly.
          if (_sig) (async () => {
            try {
              await new Promise(resW => setTimeout(resW, 4000));
              const txRes = await ns.rpcCall('getTransaction', [
                _sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
              ]);
              if (txRes?.result?.meta?.err) {
                // Update Activity entry to mark failure
                window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE',
                  payload: { signature: _sig, txFailed: true, optimized: _patchApplied },
                }}, '*');
              }
            } catch (_) {}
          })();
          return r;
        } catch (e) {
          window.__zendiq_own_tx = false;
          window.__zendiq_ws_confirmed = false;
          if (!ns.pumpFunPatchedSlippage) {
            // "Proceed anyway" wallet rejection — clear signing-original state cleanly
            ns.widgetSwapStatus = '';
            ns.widgetOriginalSigningInfo = null;
            try { ns.renderWidgetPanel?.(); } catch (_) {}
            throw e;
          }
          // Show a brief error card so the user knows to retry, rather than silent idle.
          // Wallet rejection messages vary by wallet; "reject/cancel/declined" covers most.
          const _isCancel = /reject|cancel|declin|denied|refus/i.test(e.message ?? '');
          ns.pumpFunErrorMsg = _isCancel
            ? '\u2715 Wallet rejected \u2014 click Buy to retry'
            : '\u2715 Order failed \u2014 click Buy to retry';
          ns.widgetSwapStatus = 'pump-error';
          try { ns.renderWidgetPanel?.(); } catch (_) {}
          clearTimeout(ns._pumpErrorTimer);
          ns._pumpErrorTimer = setTimeout(() => {
            if (ns.widgetSwapStatus === 'pump-error') {
              ns.widgetSwapStatus = '';
              ns.pumpFunContext   = null;
              ns.pumpFunErrorMsg  = null;
              const w = document.getElementById('sr-widget');
              if (w) { w.classList.remove('expanded', 'alert'); }
              try { ns.renderWidgetPanel?.(); } catch (_) {}
            }
          }, 3000);
          throw e;
        }
      }
      return undefined;
    },

    // ── Legacy window.solana path: wraps onDecision with the right arg shape ──
    // handleTransaction passes (decision, origFn, transaction, options) individually;
    // onDecision expects (decision, origFn, args) where args is the spread array.
    onDecisionLegacy(decision, origFn, transaction, options) {
      return this.onDecision(decision, (...a) => origFn(a[0] ?? transaction, a[1] ?? options), [transaction, options]);
    },

    renderMonitor() {
      if (!ns.pumpFunContext?.outputMint) return null;

      const pfc  = ns.pumpFunContext;
      const slip = pfc.slippagePct ?? 1;
      const _ziqSl = pfc.ziqSlip ?? Math.min(1.0, Math.max(0.5, slip));
      const solP = ns.widgetLastPriceData?.solPriceUsd ?? 80;
      const ts   = (ns.tokenScoreResult?.mint === pfc.outputMint && ns.tokenScoreResult?.loaded)
        ? ns.tokenScoreResult : pfc.tokenScore;
      const risk = ns.lastRiskResult ?? pfc.risk;
      const isAdv = ns.widgetMode !== 'simple';

      // Trigger async token score fetch if not yet loaded
      if (!ts?.loaded && ns._tokenScoreMint !== pfc.outputMint && ns.fetchTokenScore) {
        ns._tokenScoreMint = pfc.outputMint;
        ns.fetchTokenScore(pfc.outputMint);
      }

      // Use ns card helpers if already exposed (post first-render); fall back to inline
      const _buildTs = ns._buildTokenRiskCard;
      const _buildEr = ns._buildExecutionRiskCard;

      const slipLv    = slip > 3 ? 'CRITICAL' : slip > 1 ? 'HIGH' : slip > 0.5 ? 'MEDIUM' : 'LOW';
      const slipC     = _clr(slipLv);
      const fmt       = v => v < 0.0001 ? v.toFixed(6) : v < 0.01 ? v.toFixed(4) : v.toFixed(3);
      const fmtU      = v => v < 0.001 ? `~$${v.toFixed(4)}` : v < 0.01 ? `~$${v.toFixed(3)}` : `~$${v.toFixed(2)}`;
      const botWin    = pfc.solAmount > 0 ? pfc.solAmount * (slip / 100) : null;
      const botWinU   = botWin != null ? botWin * solP : null;
      // Jito bundle: protect the full bot window; direct path: show slippage-reduction delta only.
      const _monDirect = pfc.solAmount < _PUMP_BUNDLE_MIN_SOL;
      const savSol    = botWin != null
        ? (_monDirect ? Math.max(0, botWin - pfc.solAmount * _ziqSl / 100) : botWin)
        : null;
      const savUsd    = savSol != null ? savSol * solP : null;
      const mevR      = risk?.mev ?? null;
      const slipBadge = isAdv ? `${slip.toFixed(1)}% \u00b7 ${slipLv}` : _rl(slipLv);

      const slipCard = `<div style="background:${slipC}11;border:1px solid ${slipC}44;border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help"
        title="Slippage is the max price deviation you accept. On pump.fun\u2019s bonding curve, bots can sandwich your buy up to your full slippage tolerance.&#10;0\u20130.5%: LOW | 0.5\u20131%: MEDIUM | 1\u20133%: HIGH | &gt;3%: CRITICAL">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px${isAdv ? ';margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06)' : ''}">
          <span style="color:${slipC};font-weight:600">Slippage Risk</span>
          <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${slipC}">${slipBadge}</span>
        </div>
        ${isAdv ? `
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="color:#9B9BAD;cursor:help" title="The maximum bots can front-run from this trade at your current slippage tolerance.">Bot attack window</span>
          <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${slipLv !== 'LOW' ? slipC : '#14F195'}">${botWin != null ? `${fmt(botWin)} SOL${botWinU != null ? ` (${fmtU(botWinU)})` : ''}` : '\u2014'}</span>
        </div>
        ${savSol != null && savSol > 0.000001 ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="color:#9B9BAD;cursor:help" title="Reducing to 0.5% cuts the bot window to the minimum viable level.">Save with 0.5% slippage</span>
          <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#14F195">~${fmt(savSol)} SOL${savUsd != null ? ` (${fmtU(savUsd)})` : ''}</span>
        </div>` : ''}
        ${mevR ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="color:#9B9BAD">Bot risk score</span>
          <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${_clr(mevR.riskLevel)}">${isAdv ? `${mevR.riskLevel} \u00b7 ${mevR.riskScore}/100` : _rl(mevR.riskLevel)}</span>
        </div>` : ''}
        <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#C2C2D4;line-height:1.5">
          ${slip > 0.5 ? '\u2699 Lower slippage in pump.fun settings before buying to reduce bot exposure' : '\u2713 Slippage near-optimal \u2014 bot attack window is minimal'}
        </div>` : ''}
      </div>`;

      const tsHtml = _buildTs ? _buildTs(ts, !isAdv) : `<div style="background:#FFB54711;border:1px solid #FFB54744;border-radius:10px;padding:10px 12px;margin-bottom:10px"><span style="font-size:13px;color:#FFB547;font-weight:600">Token Risk Score</span><span style="float:right;font-size:12px;font-family:'Space Mono',monospace;color:#FFB547">${ts?.loaded ? `${ts.level} \u00b7 ${ts.score}/100` : 'Scanning\u2026'}</span></div>`;
      const erHtml = _buildEr ? _buildEr(risk, !isAdv) : '';
      const amtRow = pfc.solAmount > 0
        ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="color:#9B9BAD">Buying with</span>
            <span style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:#E8E8F0">${pfc.solAmount.toFixed(4)} SOL</span>
          </div>` : '';

      return `<div id="sr-monitor-scroll" style="flex:1;min-height:0;overflow-y:auto;padding:14px 16px 12px;">
        <div style="margin-bottom:10px;padding:7px 10px;background:rgba(153,69,255,0.06);border:1px solid rgba(153,69,255,0.15);border-radius:8px">
          <div style="font-size:12px;color:#9945FF;font-weight:600">pump.fun bonding curve</div>
          <div style="font-size:12px;color:#9B9BAD;margin-top:2px">ZendIQ routing not available \u2014 lower slippage in pump.fun settings to cut bot exposure.</div>
        </div>
        ${amtRow}${slipCard}${tsHtml}${erHtml}
      </div>`;
    },

    // ── Widget: flow content dispatcher ──────────────────────────────────
    renderFlow() {
      if (ns.widgetSwapStatus === 'pump-slippage-review' && ns.pumpFunContext) return this._renderReview();
      if (ns.widgetSwapStatus === 'pump-signing')         return this._renderSigning();
      if (ns.widgetSwapStatus === 'pump-direct-signing')  return this._renderDirectSigning();
      if (ns.widgetSwapStatus === 'pump-sending')         return this._renderSending();
      if (ns.widgetSwapStatus === 'pump-done')            return this._renderDone();
      if (ns.widgetSwapStatus === 'pump-error')           return this._renderError();
      return null;
    },

    _renderReview() {
      // Card helpers are exposed on ns after the first renderWidgetPanel call.
      // When this is called they are always available (renderWidgetPanel runs first).
      const _buildOrder  = ns._buildOrderCard        ?? ((r) => '');
      const _buildTs     = ns._buildTokenRiskCard     ?? (() => '');
      const _buildCosts  = ns._buildSavingsCostsCard  ?? (() => '');
      const _buildShell  = ns._buildReviewShell       ?? ((c, n, p, s) => c);
      const _sc          = ns._rClr                   ?? _clr;
      const _rl          = ns._riskLabel              ?? (l => l);

      const pfc    = ns.pumpFunContext;
      const slip   = pfc.slippagePct ?? 1;
      const _ziqSl = pfc.ziqSlip ?? Math.min(1.0, Math.max(0.5, slip));
      const solP   = ns.widgetLastPriceData?.solPriceUsd ?? 80;
      const pfRisk = ns.lastRiskResult ?? pfc.risk;
      const mevR   = pfRisk?.mev ?? null;
      const pfTs   = (ns.tokenScoreResult?.mint === pfc.outputMint && ns.tokenScoreResult?.loaded)
        ? ns.tokenScoreResult : pfc.tokenScore;
      const isSimp = ns.widgetMode === 'simple';

      const fmt  = v => v < 0.0001 ? v.toFixed(6) : v < 0.01 ? v.toFixed(4) : v.toFixed(3);
      const fmtU = v => v < 0.001 ? `~$${v.toFixed(4)}` : v < 0.01 ? `~$${v.toFixed(3)}` : `~$${v.toFixed(2)}`;
      const slipLv  = slip > 3 ? 'CRITICAL' : slip > 1 ? 'HIGH' : slip > 0.5 ? 'MEDIUM' : 'LOW';
      const origExp = pfc.solAmount > 0 ? pfc.solAmount * slip / 100 : null;
      const _isDirectPath = pfc.solAmount < _PUMP_BUNDLE_MIN_SOL;
      // Jito bundle protects the entire bot window; direct path only saves the slippage-reduction delta.
      const savSol  = origExp != null
        ? (_isDirectPath ? Math.max(0, origExp - pfc.solAmount * _ziqSl / 100) : origExp)
        : null;
      const savUsd  = savSol != null ? savSol * solP : null;

      const _expLam  = Math.round(pfc.solAmount * 1e9 * _ziqSl / 100);
      const _expSol  = (_expLam / 1e9).toFixed(5);
      const _minTipSol = (_PUMP_TIP_FLOOR / 1e9).toFixed(5);
      const _tipLam  = _isDirectPath ? 0 : Math.min(_PUMP_TIP_CAP, Math.max(_PUMP_TIP_FLOOR, Math.round(_expLam * 0.8)));
      const _tipSol  = (_tipLam / 1e9).toFixed(5);
      const _tipUsd  = _tipLam / 1e9 * solP;

      // ── Order card ──
      const orderRows = [
        ...(pfc.solAmount > 0 ? [{ label: 'Spending', value: `${pfc.solAmount.toFixed(4)} SOL`, tooltip: 'The amount of SOL you are spending on this bonding curve buy.' }] : []),
        { label: 'Your slippage',       value: `${slip.toFixed(1)}%`,       valueColor: _sc(slipLv),   tooltip: 'The slippage tolerance set in pump.fun. Bots can profitably sandwich your buy up to this amount.' },
        { label: 'ZendIQ optimised to', value: `${_ziqSl.toFixed(1)}%`,      valueColor: '#14F195',     tooltip: `ZendIQ patches maxSolCost to enforce ${_ziqSl.toFixed(1)}% tolerance \u2014 no new transaction is created.` },
        { label: 'Route',               value: 'pump.fun bonding curve',      valueColor: '#9945FF',     tooltip: 'ZendIQ modifies only the maxSolCost field. Buy amount is unchanged.' },
      ];

      // ── Overall Risk card (mirrors Jupiter's Review & Sign composite card) ──
      const _execSc  = pfRisk?.score ?? 0;
      const _execLvl = pfRisk?.level ?? 'LOW';
      const _botSc   = mevR?.riskScore ?? 0;
      const _botLvl  = mevR?.riskLevel ?? 'LOW';
      const _tsL2    = pfTs?.loaded && pfTs?.mint === pfc.outputMint;
      const _tkSc    = _tsL2 ? (pfTs.score ?? 0) : 0;
      const _tkLvl   = _tsL2 ? (pfTs.level ?? 'LOW') : null;
      const _comp    = Math.round(_execSc * 0.40 + _botSc * 0.35 + _tkSc * 0.25);
      const _compLvl = _comp >= 75 ? 'CRITICAL' : _comp >= 50 ? 'HIGH' : _comp >= 25 ? 'MEDIUM' : 'LOW';
      const _cc      = _sc(_compLvl);
      const _cBadge  = isSimp ? _rl(_compLvl) : `${_compLvl} \u00b7 ${_comp}/100`;
      const _cSubRows = !isSimp ? `<div style="margin-top:8px;border-top:1px solid ${_cc}22;padding-top:7px">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">
            <span style="color:#C8C8D8;font-size:12px">Execution</span>
            <span style="color:${_sc(_execLvl)};font-size:12px;font-weight:700;font-family:'Space Mono',monospace">${_execLvl} \u00b7 ${_execSc}/100</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">
            <span style="color:#C8C8D8;font-size:12px">Bot Attack</span>
            <span style="color:${_sc(_botLvl)};font-size:12px;font-weight:700;font-family:'Space Mono',monospace">${_botLvl} \u00b7 ${_botSc}/100</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">
            <span style="color:#C8C8D8;font-size:12px">Token Risk</span>
            <span style="color:${_tsL2 ? _sc(_tkLvl) : '#C2C2D4'};font-size:12px;font-weight:700;font-family:'Space Mono',monospace">${_tsL2 ? `${_tkLvl} \u00b7 ${_tkSc}/100` : 'scanning\u2026'}</span>
          </div>
        </div>` : '';
      const _overallCard = `<div title="Overall Risk Score \u2014 weighted composite of all three risk dimensions.&#10;Formula: Execution \u00d7 40% + Bot Attack \u00d7 35% + Token Risk \u00d7 25%&#10;&#10;Execution: ${_execSc}/100 \u00b7 Bot Attack: ${_botSc}/100 \u00b7 Token Risk: ${_tsL2 ? _tkSc + '/100' : 'pending\u2026'}" style="background:${_cc}11;border:1px solid ${_cc}44;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:help">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
          <span style="color:${_cc};font-weight:600">Overall Risk</span>
          <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${_cc}">${_cBadge}</span>
        </div>${_cSubRows}
      </div>`;

      // ── Bot Attack Risk card (mirrors Jupiter's Review & Sign) ──
      let _botCard = '';
      if (mevR) {
        const _mc     = _sc(mevR.riskLevel);
        const _mBadge = isSimp ? _rl(mevR.riskLevel) : `${mevR.riskLevel} \u00b7 ${mevR.estimatedLossPercentage?.toFixed(2) ?? '0'}% est. loss`;
        const _eln    = pfRisk?.estimatedLossNative ?? null;
        let _estLossHtml = '';
        if (!isSimp) {
          if (_eln == null || _eln < 0.000001) {
            _estLossHtml = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px"><span style="color:#C2C2D4">Est. Loss</span><span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:#14F195">${_eln == null ? '\u2014' : 'none'}</span></div>`;
          } else {
            const _elFmt = _eln < 0.0001 ? _eln.toFixed(6) : _eln < 0.01 ? _eln.toFixed(4) : _eln.toFixed(2);
            const _elPct = (mevR.estimatedLossPercentage ?? 0).toFixed(2);
            const _elCol = parseFloat(_elPct) >= 1 ? '#FF4D4D' : '#FFB547';
            _estLossHtml = `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px"><span style="color:#C2C2D4">Est. Loss</span><span style="font-weight:700;font-family:'Space Mono',monospace;font-size:12px;color:${_elCol}">${_elFmt} SOL (${_elPct}%)</span></div>`;
          }
        }
        let _botFactorRows = '';
        if (!isSimp && mevR.factors?.length) {
          _botFactorRows = mevR.factors.map(f => {
            const fc = f.score >= 30 ? '#FF4D4D' : f.score >= 15 ? '#FFB547' : f.score >= 5 ? '#9945FF' : '#14F195';
            return `<div style="display:flex;justify-content:space-between;padding:3px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ${fc};border-radius:0 5px 5px 0;margin-bottom:3px"><span style="font-size:12px;color:#C0C0D8">${f.name}</span><span style="font-size:11px;font-weight:700;color:${fc};font-family:'Space Mono',monospace">${f.score}</span></div>`;
          }).join('');
        }
        const _hasBotDetail = !isSimp && (_estLossHtml || _botFactorRows);
        _botCard = `<div title="Bot Attack Risk \u2014 pump.fun buys are in the public mempool and can be sandwiched. Higher slippage = larger bot window.&#10;Score 0\u201390: LOW &lt;25 | MEDIUM 25\u201349 | HIGH 50\u201374 | CRITICAL 75+" style="background:${_mc}11;border:1px solid ${_mc}44;border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px${_hasBotDetail ? ';margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06)' : ''}">
            <span style="color:${_mc};font-weight:600">Bot Attack Risk</span>
            <span style="font-weight:700;font-size:12px;font-family:'Space Mono',monospace;color:${_mc}">${_mBadge}</span>
          </div>${_estLossHtml}${_botFactorRows}
        </div>`;
      }

      // ── Savings & Costs card ──
      const costsRows = _isDirectPath
        ? [
            { label: 'Bot protection', value: 'Active \u00b7 0.5% enforced',        valueColor: '#14F195', tooltip: 'ZendIQ patches maxSolCost so your buy cannot be sandwiched beyond 0.5% slippage.' },
            { label: 'Jito bundle',    value: 'Skipped \u00b7 trade too small',      valueColor: '#6B6B8A', tooltip: `Max sandwich exposure (${_expSol} SOL) is smaller than the minimum Jito tip (${_minTipSol} SOL). Sending direct is more profitable.` },
            { label: 'ZendIQ Fee',     value: 'FREE \u00b7 Beta',                    valueColor: '#14F195', tooltip: 'ZendIQ charges no fee during open beta.' },
          ]
        : [
            { label: 'Bot protection savings', value: savSol != null && savSol > 0.000001 ? `~${fmt(savSol)} SOL (${fmtU(savUsd)})` : '\u2014', valueColor: savSol != null && savSol > 0.000001 ? '#14F195' : '#9B9BAD', tooltip: `Maximum SOL bots can no longer extract once slippage is reduced from ${slip.toFixed(1)}% to 0.5%.` },
            { label: 'Jito bundle tip',        value: `~${_tipSol} SOL (${fmtU(_tipUsd)})`, valueColor: '#9945FF', tooltip: 'Tip paid to Jito validators for atomic bundle inclusion. Always less than the sandwich exposure it protects.' },
            { label: 'ZendIQ Fee',             value: 'FREE \u00b7 Beta',                    valueColor: '#14F195', tooltip: 'ZendIQ charges no fee during open beta.' },
            { label: 'Est. Net Benefit',        value: savSol != null && (savSol - _tipLam / 1e9) > 0.000001 ? `~${fmt(Math.max(0, savSol - _tipLam / 1e9))} SOL` : '\u2248 none', valueColor: savSol != null && (savSol - _tipLam / 1e9) > 0.000001 ? '#14F195' : '#C2C2D4', tooltip: 'SOL saved from sandwich protection minus the Jito bundle tip.' },
          ];

      // ── Info banner (direct path — replaces Jupiter negative-net banner placement) ──
      const _infoBanner = _isDirectPath
        ? `<div style="background:rgba(20,241,149,0.07);border:1px solid rgba(20,241,149,0.25);border-radius:8px;padding:10px 12px;margin-bottom:8px" title="Max sandwich exposure on this trade is ${_expSol} SOL.\nMin Jito tip floor is ${_minTipSol} SOL.\nThe tip would exceed the potential loss \u2014 sending direct keeps this trade profitable.">
          <div style="font-size:13px;font-weight:700;color:#14F195;margin-bottom:3px">\u2713 Bundle skipped \u2014 savings without the fee</div>
          <div style="font-size:12px;color:#9B9BAD;line-height:1.5">Max exposure: <span style="color:#E8E8F0">${_expSol} SOL</span> &middot; Jito tip floor: <span style="color:#E8E8F0">${_minTipSol} SOL</span> \u2014 sending direct is more profitable.</div>
        </div>`
        : '';

      const _note = _isDirectPath
        ? `ZendIQ enforces ${_ziqSl.toFixed(1)}% slippage and sends direct. No Jito tip \u2014 the trade is profitable without it.`
        : `ZendIQ patches <code style="color:#9945FF;font-size:9px">maxSolCost</code> only. Buy amount unchanged. If the price moves &gt;${_ziqSl.toFixed(1)}% the tx reverts safely \u2014 retry immediately.`;

      const _primaryBtn = { id: 'sr-btn-pump-optimise',
        label: _isDirectPath ? '\u2713 Continue with original order' : `\u2736 Sign at ${_ziqSl.toFixed(1)}% + Jito bundle` };
      const _secondaryBtns = [
        { id: 'sr-btn-pump-proceed', label: `\u21a9 Proceed at ${slip.toFixed(1)}% (original)`, tooltip: `Proceed with your original ${slip.toFixed(1)}% slippage \u2014 ZendIQ will not modify the transaction` },
        { id: 'sr-btn-pump-cancel',  label: '\u2715 Cancel', tooltip: 'Cancel this swap entirely. Nothing will be sent to your wallet \u2014 click Buy again to retry.' },
      ];

      const _cards = _buildOrder(orderRows) + _overallCard + _buildTs(pfTs, isSimp) + _botCard
        + _buildCosts(costsRows, _isDirectPath ? null : 3) + _infoBanner;

      return _buildShell(_cards, _note, _primaryBtn, _secondaryBtns);
    },

    _renderSending() {
      return `<div style="padding:14px 16px;text-align:center">
        <div style="font-size:12px;font-weight:600;color:#9945FF;margin-bottom:8px">\u23f3 Sending transaction\u2026</div>
        <div style="font-size:13px;color:#C2C2D4">Broadcasting transaction\u2026</div>
      </div>`;
    },

    _renderDirectSigning() {
      const pfc    = ns.pumpFunContext ?? {};
      const _ziqSl = pfc.ziqSlip ?? 0.5;
      const _sym   = pfc.tokenSymbol ?? ns.tokenScoreCache?.get(pfc.outputMint)?.result?.symbol ?? '?';
      const _sOut  = (pfc.expectedTokenOutRaw ?? 0) > 0 ? (pfc.expectedTokenOutRaw / 1e6).toFixed(4) : null;
      const _sol   = pfc.solAmount ?? 0;
      const _expLam = ns._pumpDirectExpLam ?? Math.round(_sol * 1e9 * _ziqSl / 100);
      const _expSol = (_expLam / 1e9).toFixed(5);
      const _minTipSol = (_PUMP_TIP_FLOOR / 1e9).toFixed(5);
      return `<div style="padding:14px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:12px;font-weight:700;color:#FFB547">&#9200; Approve in wallet…</span>
          <span style="font-size:12px;color:#14F195;font-weight:600">&#10003; Direct send</span>
        </div>
        <div style="background:rgba(20,241,149,0.04);border:1px solid rgba(20,241,149,0.14);border-radius:8px;padding:9px 11px;margin-bottom:8px">
          ${_sol > 0 ? `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:13px;color:#C2C2D4">Spending</span><span style="font-size:13px;color:#E8E8F0;font-weight:600">${_sol.toFixed(4)} SOL</span></div>` : ''}
          ${_sOut ? `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:13px;color:#C2C2D4">Buying (est.)</span><span style="font-size:13px;color:#14F195;font-weight:700">${_sOut} ${_sym}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;margin-bottom:5px">
            <span style="font-size:13px;color:#C2C2D4">Slippage</span>
            <span style="font-size:12px;color:#14F195;font-weight:700">${_ziqSl.toFixed(1)}% (ZendIQ)</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:13px;color:#C2C2D4">Route</span>
            <span style="font-size:12px;color:#9945FF;font-weight:600">pump.fun bonding curve</span>
          </div>
        </div>
        <div style="background:rgba(20,241,149,0.06);border:1px solid rgba(20,241,149,0.2);border-radius:8px;padding:8px 11px;margin-bottom:6px" title="Sandwich exposure on this trade (${_expSol} SOL) is smaller than the minimum competitive Jito bundle tip (${_minTipSol} SOL). Skipping the bundle keeps your fees lower than the protection would save.">
          <div style="font-size:12px;font-weight:700;color:#14F195;margin-bottom:4px">&#10003; Bundle skipped — no fee wasted</div>
          <div style="font-size:12px;color:#9B9BAD;line-height:1.4">Max sandwich exposure on this trade is <span style="color:#E8E8F0">${_expSol} SOL</span> — smaller than the minimum Jito tip (<span style="color:#E8E8F0">${_minTipSol} SOL</span>). Sending direct keeps you profitable.</div>
        </div>
        <div style="font-size:12px;color:#C2C2D4;text-align:center">Check your wallet — tap Approve to confirm</div>
      </div>`;
    },

    _renderSigning() {
      const pfc    = ns.pumpFunContext ?? {};
      const _ziqSl = pfc.ziqSlip ?? 0.5;
      const _sym   = pfc.tokenSymbol ?? ns.tokenScoreCache?.get(pfc.outputMint)?.result?.symbol ?? '?';
      const _sOut  = (pfc.expectedTokenOutRaw ?? 0) > 0
        ? (pfc.expectedTokenOutRaw / 1e6).toFixed(4) : null;
      return `<div style="padding:14px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-size:12px;font-weight:700;color:#FFB547">&#9200; Approve in wallet\u2026</span>
          <span style="font-size:12px;color:#14F195;font-weight:600">&#10022; ZendIQ optimized</span>
        </div>
        <div style="background:rgba(20,241,149,0.04);border:1px solid rgba(20,241,149,0.14);border-radius:8px;padding:9px 11px;margin-bottom:8px">
          ${(pfc.solAmount ?? 0) > 0 ? `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:13px;color:#C2C2D4">Spending</span><span style="font-size:13px;color:#E8E8F0;font-weight:600">${Number(pfc.solAmount).toFixed(4)} SOL</span></div>` : ''}
          ${_sOut ? `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:13px;color:#C2C2D4">Buying (est.)</span><span style="font-size:13px;color:#14F195;font-weight:700">${_sOut} ${_sym}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;margin-bottom:5px">
            <span style="font-size:13px;color:#C2C2D4">Slippage</span>
            <span style="font-size:12px;color:#14F195;font-weight:700">${_ziqSl.toFixed(1)}% (ZendIQ)</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:13px;color:#C2C2D4">Route</span>
            <span style="font-size:12px;color:#9945FF;font-weight:600">pump.fun bonding curve</span>
          </div>
        </div>
        <div style="font-size:13px;color:#C2C2D4;text-align:center">Check your wallet \u2014 tap Approve to confirm</div>
      </div>`;
    },

    _renderDone() {
      // Auto-dismiss after 2s — mirrors done/skipped states in the main widget flow.
      clearTimeout(ns._pumpDoneTimer);
      ns._pumpDoneTimer = setTimeout(() => {
        if (ns.widgetSwapStatus === 'pump-done') {
          ns.widgetSwapStatus = '';
          ns.pumpFunContext   = null;
          const w = document.getElementById('sr-widget');
          if (w) { w.classList.remove('expanded', 'alert'); }
          try { ns.renderWidgetPanel?.(); } catch (_) {}
        }
      }, 2000);
      const pfc  = ns.pumpFunContext ?? {};
      const sig  = ns.widgetOriginalTxSig;
      const _sym = pfc.tokenSymbol ?? ns.tokenScoreCache?.get(pfc.outputMint)?.result?.symbol ?? '?';
      const _sOut = (pfc.expectedTokenOutRaw ?? 0) > 0
        ? (pfc.expectedTokenOutRaw / 1e6).toFixed(4) : null;
      const _shortSig = sig ? (sig.slice(0, 8) + '\u2026' + sig.slice(-4)) : null;
      const _solUrl   = sig ? ('https://solscan.io/tx/' + sig) : null;
      const _isPatched = ns.pumpFunPatchedSlippage !== false;
      const _amtRow = (_sOut && (pfc.solAmount ?? 0) > 0)
        ? `<div style="font-size:13px;color:#C2C2D4;margin:4px 0 0">${Number(pfc.solAmount).toFixed(4)} SOL \u2192 ${_sOut} ${_sym}</div>`
        : '';
      const _subtitle = _isPatched
        ? `<div style="font-size:12px;color:#C2C2D4;margin-bottom:2px">Slippage optimized to ${(pfc.ziqSlip ?? 0.5).toFixed(1)}%</div>`
        : `<div style="font-size:12px;color:#FFB547;margin-bottom:2px">Original slippage \u2014 not modified</div>`;
      const _sigLink = _solUrl
        ? `<a href="${_solUrl}" target="_blank" rel="noopener" style="display:block;margin:8px 0 14px;font-size:12px;color:#9945FF;text-decoration:none;font-family:monospace" title="View on Solscan">${_shortSig} \u2197</a>`
        : '<div style="margin-bottom:14px"></div>';
      return `<div style="padding:14px 16px;text-align:center">
        <div style="font-size:13px;font-weight:700;color:#14F195;margin-bottom:2px">Swap Successful</div>
        ${_subtitle}
        ${_amtRow}
        ${_sigLink}
        <button id="sr-btn-widget-new" style="width:100%;padding:10px;border:1px solid rgba(20,241,149,0.3);border-radius:8px;background:rgba(20,241,149,0.08);color:#14F195;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">+ New Swap</button>
      </div>`;
    },

    _renderError() {
      // Auto-dismiss after 3s — same pattern as pump-done.
      clearTimeout(ns._pumpErrorTimer);
      ns._pumpErrorTimer = setTimeout(() => {
        if (ns.widgetSwapStatus === 'pump-error') {
          ns.widgetSwapStatus = '';
          ns.pumpFunContext   = null;
          ns.pumpFunErrorMsg  = null;
          const w = document.getElementById('sr-widget');
          if (w) { w.classList.remove('expanded', 'alert'); }
          try { ns.renderWidgetPanel?.(); } catch (_) {}
        }
      }, 3000);
      const msg = ns.pumpFunErrorMsg ?? '\u2715 Order failed \u2014 click Buy to retry';
      return `<div style="padding:14px 16px;">
        <div style="background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.25);border-radius:8px;padding:10px;margin-bottom:10px;">
          <div style="font-size:13px;font-weight:700;color:#FF4D4D;margin-bottom:4px">Error</div>
          <div style="font-size:13px;color:#E8E8F0">${msg}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button id="sr-btn-pump-retry" style="flex:1;padding:10px;border:1px solid rgba(153,69,255,0.3);border-radius:8px;background:rgba(153,69,255,0.08);color:#9945FF;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">\u21ba Retry</button>
          <button id="sr-btn-pump-cancel" style="flex:1;padding:10px;background:none;border:1px solid rgba(255,77,77,0.2);color:#FF4D4D;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">\u2715 Cancel</button>
        </div>
      </div>`;
    },

    // ── Widget: button click handler ─────────────────────────────────────
    onButtonClick(id) {
      if (id === 'sr-btn-pump-retry') {
        // Re-show the slippage review panel if context is still available, else dismiss.
        clearTimeout(ns._pumpErrorTimer);
        ns.pumpFunErrorMsg = null;
        if (ns.pumpFunContext) {
          ns.widgetSwapStatus = 'pump-slippage-review';
          ns.renderWidgetPanel?.();
        } else {
          ns.widgetSwapStatus = '';
          const w = document.getElementById('sr-widget');
          if (w) { w.classList.remove('expanded', 'alert'); }
          ns.renderWidgetPanel?.();
        }
        return true;
      }
      if (id === 'sr-btn-pump-cancel') {
        clearTimeout(ns._pumpSigningTimeout);
        ns.widgetSwapStatus = '';
        ns.pumpFunContext   = null;
        ns.pumpFunRawArgs   = null;
        const w = document.getElementById('sr-widget');
        if (w) { w.classList.remove('expanded', 'alert'); w.style.display = 'none'; }
        if (ns.pendingDecisionResolve) {
          const res = ns.pendingDecisionResolve;
          ns.pendingDecisionResolve = null;
          ns.pendingDecisionPromise = null;
          res('cancel');
        }
        return true;
      }
      if (id === 'sr-btn-pump-optimise') {
        // Both direct and bundle paths: resolve 'optimise' so page-interceptor does nothing,
        // then _signAndSubmitPumpTx handles signing internally (direct path = pumpportal.fun
        // tx at 0.5% via RPC; bundle path = Jito bundle). This was the working pre-refactor path.
        ns.pumpFunWantOptimise = false;
        ns._pumpTxSigHandled   = false;
        if (ns.pendingDecisionResolve) {
          const res = ns.pendingDecisionResolve;
          ns.pendingDecisionResolve = null;
          ns.pendingDecisionPromise = null;
          res('optimise'); // interceptor does nothing — _signAndSubmitPumpTx handles signing
        }
        _signAndSubmitPumpTx(); // async — transitions to pump-done / pump-error internally
        return true;
      }
      if (id === 'sr-btn-pump-proceed') {
        ns._pumpTxSigHandled = false;
        // Populate widgetOriginalSigningInfo so signing-original and done-original
        // cards show correct pump.fun data instead of Jupiter defaults.
        const _pfc = ns.pumpFunContext;
        ns.widgetOriginalSigningInfo = {
          inputMint:     'So11111111111111111111111111111111111111112',
          outputMint:    _pfc?.outputMint ?? ns.lastOutputMint ?? null,
          inputSymbol:   'SOL',
          outputSymbol:  ns.tokenScoreResult?.symbol ?? _pfc?.tokenSymbol
                           ?? ns.tokenScoreCache?.get(_pfc?.outputMint ?? ns.lastOutputMint)?.result?.symbol ?? '?',
          inputDecimals:  9,
          outputDecimals: 6,
          inAmt:         _pfc?.solAmount ?? null,
          inAmountRaw:   null,
          riskScore:     _pfc?.risk?.score ?? ns.lastRiskResult?.score ?? null,
          riskLevel:     _pfc?.risk?.level ?? ns.lastRiskResult?.level ?? null,
        };
        ns.widgetSwapStatus = 'signing-original';
        ns.widgetActiveTab  = 'monitor';
        const _wp = document.getElementById('sr-widget');
        if (_wp) { _wp.style.display = ''; if (!_wp.classList.contains('expanded')) _wp.classList.add('expanded'); }
        ns.renderWidgetPanel?.();
        // Set confirmed flag so zendiqWsOverlay routes to the pump.fun proceed path
        // (signing-original → done-original + Activity recording) when pump.fun fires
        // the wallet call. Without this the signing-original passthrough guard short-circuits.
        window.__zendiq_ws_confirmed = true;
        if (ns.pendingDecisionResolve) {
          const res = ns.pendingDecisionResolve;
          ns.pendingDecisionResolve = null;
          ns.pendingDecisionPromise = null;
          res('confirm');
        }
        // Safety timeout — same as optimise path above.
        clearTimeout(ns._pumpSigningTimeout);
        ns._pumpSigningTimeout = setTimeout(() => {
          if (ns.widgetSwapStatus === 'signing-original') {
            ns.widgetSwapStatus = '';
            ns.pumpFunContext    = null;
            ns._pumpTxSigHandled = false;
            window.__zendiq_ws_confirmed = false;
            try { ns.renderWidgetPanel?.(); } catch (_) {}
          }
        }, 20000);
        return true;
      }
      if (id === 'sr-btn-widget-new') {
        // "+ New Swap" / "Dismiss" — cancel any auto-dismiss timers and reset immediately.
        clearTimeout(ns._pumpDoneTimer);
        clearTimeout(ns._pumpErrorTimer);
        clearTimeout(ns._pumpSigningTimeout);
        ns.widgetSwapStatus = '';
        ns.pumpFunContext    = null;
        ns.pumpFunErrorMsg   = null;
        const w = document.getElementById('sr-widget');
        if (w) { w.classList.remove('expanded', 'alert'); }
        ns.renderWidgetPanel?.();
        return true;
      }
      return false;
    },
  });

  // Also expose the tx modifier directly on ns for any legacy callers
  ns._modifyPumpFunTx = _modifyPumpFunTx;
  // Exposed so the wallet hook can record Activity for the "Proceed anyway" path
  // (which bypasses onDecision and hits __zendiq_ws_confirmed directly).
  ns._recordPumpActivity = _recordPumpActivity;
})();
