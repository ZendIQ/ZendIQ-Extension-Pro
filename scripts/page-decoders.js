/**
 * ZendIQ – decoders.js
 * Binary instruction parsers for Jupiter and Raydium swap transactions.
 * Also exports extractTxInfo for high-level transaction summarisation.
 */

(function () {
  const ns = window.__zq;

  // ════════════════════════════════════════════════════════════════════════════
  // ─── INSTRUCTION DECODERS ──────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Binary parsing utilities for decoding instruction data
   */
  const BinaryParser = {
    readU64LE: (buffer, offset = 0) => {
      if (offset + 8 > buffer.length) return null;
      let value = 0n;
      for (let i = 0; i < 8; i++) {
        value |= BigInt(buffer[offset + i]) << BigInt(i * 8);
      }
      return Number(value);
    },

    readU32LE: (buffer, offset = 0) => {
      if (offset + 4 > buffer.length) return null;
      return (buffer[offset] |
              (buffer[offset + 1] << 8) |
              (buffer[offset + 2] << 16) |
              (buffer[offset + 3] << 24)) >>> 0;
    },

    readU16LE: (buffer, offset = 0) => {
      if (offset + 2 > buffer.length) return null;
      return (buffer[offset] | (buffer[offset + 1] << 8)) & 0xFFFF;
    },

    readU8: (buffer, offset = 0) => {
      return buffer[offset] ?? null;
    },

    readHexString: (buffer, offset = 0, length = 32) => {
      if (offset + length > buffer.length) return '';
      return Array.from(buffer.slice(offset, offset + length))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    },

    toBuffer: (data) => {
      if (data instanceof Uint8Array) return data;
      if (typeof data === 'string') return Buffer.from(data, 'base64');
      if (Buffer.isBuffer(data)) return data;
      return null;
    },
  };

  /**
   * Jupiter swap instruction decoder
   */
  const JupiterDecoder = {
    DISCRIMINATORS: {
      'swap': [0xea, 0xf6, 0x3e, 0x78],
      'swapWithoutFees': [0x23, 0x22, 0x5e, 0x1b],
    },

    decode: (data) => {
      const buf = BinaryParser.toBuffer(data);
      if (!buf || buf.length < 16) return null;

      try {
        const inAmount = BinaryParser.readU64LE(buf, 8);
        const minimumOutAmount = BinaryParser.readU64LE(buf, 16);

        const slippage = minimumOutAmount && inAmount
          ? ((1 - (minimumOutAmount / inAmount)) * 100).toFixed(2)
          : null;

        return {
          type: 'swap',
          inAmount,
          minimumOutAmount,
          slippagePercent: slippage ? parseFloat(slippage) : null,
          dataLength: buf.length,
          rawHex: BinaryParser.readHexString(buf, 0, Math.min(32, buf.length)),
        };
      } catch (e) {
        console.warn('[ZendIQ] Jupiter decode error:', e.message);
        return null;
      }
    },
  };

  /**
   * Raydium AMM v4 swap instruction decoder.
   * Program: 675kPX9MHTjS2zt1qLCVCuYkBRun8dcuhNhdJ3ypD6M
   * Layout (after 8-byte discriminator): amountIn u64 LE @ 8, minimumAmountOut u64 LE @ 16
   */
  const RaydiumDecoder = {
    decode: (data) => {
      const buf = BinaryParser.toBuffer(data);
      if (!buf || buf.length < 24) return null;
      try {
        const amountIn        = BinaryParser.readU64LE(buf, 8);
        const minimumAmountOut = BinaryParser.readU64LE(buf, 16);
        const slippage = minimumAmountOut && amountIn
          ? ((1 - (minimumAmountOut / amountIn)) * 100).toFixed(2)
          : null;
        return {
          type:             'swap',
          amountIn,
          minimumAmountOut,
          slippagePercent:  slippage ? parseFloat(slippage) : null,
          dataLength:       buf.length,
          rawHex:           BinaryParser.readHexString(buf, 0, Math.min(32, buf.length)),
        };
      } catch (e) {
        console.warn('[ZendIQ] Raydium AMM decode error:', e.message);
        return null;
      }
    },
  };

  /**
   * Raydium CLMM (Concentrated Liquidity) decoder.
   * Program: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
   * Layout (Anchor, 8-byte discriminator): amount u64 LE @ 8, otherAmountThreshold u64 LE @ 16
   * Same byte positions as AMM v4 — program ID is the selector, not the discriminator.
   */
  const RaydiumClmmDecoder = {
    decode: (data) => {
      const buf = BinaryParser.toBuffer(data);
      if (!buf || buf.length < 24) return null;
      try {
        const amountIn        = BinaryParser.readU64LE(buf, 8);
        const minimumAmountOut = BinaryParser.readU64LE(buf, 16);
        if (!amountIn) return null; // reject clearly invalid instructions
        const slippage = minimumAmountOut && amountIn
          ? ((1 - (minimumAmountOut / amountIn)) * 100).toFixed(2)
          : null;
        return {
          type:             'swap',
          amountIn,
          minimumAmountOut,
          slippagePercent:  slippage ? parseFloat(slippage) : null,
          dataLength:       buf.length,
          rawHex:           BinaryParser.readHexString(buf, 0, Math.min(32, buf.length)),
        };
      } catch (e) {
        console.warn('[ZendIQ] Raydium CLMM decode error:', e.message);
        return null;
      }
    },
  };

  /**
   * Raydium CPMM (Constant Product) decoder.
   * Program: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdBkLmRFa1p9A
   * Layout (Anchor, 8-byte discriminator): amountIn u64 LE @ 8, minimumAmountOut u64 LE @ 16
   */
  const RaydiumCpmmDecoder = {
    decode: (data) => {
      const buf = BinaryParser.toBuffer(data);
      if (!buf || buf.length < 24) return null;
      try {
        const amountIn        = BinaryParser.readU64LE(buf, 8);
        const minimumAmountOut = BinaryParser.readU64LE(buf, 16);
        if (!amountIn) return null;
        const slippage = minimumAmountOut && amountIn
          ? ((1 - (minimumAmountOut / amountIn)) * 100).toFixed(2)
          : null;
        return {
          type:             'swap',
          amountIn,
          minimumAmountOut,
          slippagePercent:  slippage ? parseFloat(slippage) : null,
          dataLength:       buf.length,
          rawHex:           BinaryParser.readHexString(buf, 0, Math.min(32, buf.length)),
        };
      } catch (e) {
        console.warn('[ZendIQ] Raydium CPMM decode error:', e.message);
        return null;
      }
    },
  };

  // ── Parse swap instruction data (Jupiter / Raydium AMM v4 / CLMM / CPMM) ──
  function parseSwapInstruction(tx, msg, accounts, instructions) {
    const JUPITER_PID    = 'JUP4Fb2cqiRUcaTHdrPC8h2gNsGA2HTL5yxY2wUWvJC';
    // New JUP aggregator used since late 2024
    const JUPITER6_PID   = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const RAYDIUM_PID    = '675kPX9MHTjS2zt1qLCVCuYkBRun8dcuhNhdJ3ypD6M'; // AMM v4
    const RAYDIUM_CLMM   = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
    const RAYDIUM_CPMM   = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdBkLmRFa1p9A';

    try {
      for (const instr of instructions) {
        const programId   = accounts[instr.programIdIndex]?.toString() ?? '';
        const isJupiter   = programId === JUPITER_PID || programId === JUPITER6_PID;
        const isRdmAmm    = programId === RAYDIUM_PID;
        const isRdmClmm   = programId === RAYDIUM_CLMM;
        const isRdmCpmm   = programId === RAYDIUM_CPMM;
        const isRaydium   = isRdmAmm || isRdmClmm || isRdmCpmm;

        if (!isJupiter && !isRaydium) continue;

        const data = instr.data;
        if (!data || data.length < 8) continue;

        let decoded = null;
        let source  = null;

        if (isJupiter) {
          decoded = JupiterDecoder.decode(data);
          source  = 'jupiter';
        } else if (isRdmClmm) {
          decoded = RaydiumClmmDecoder.decode(data);
          source  = 'raydium';
        } else if (isRdmCpmm) {
          decoded = RaydiumCpmmDecoder.decode(data);
          source  = 'raydium';
        } else if (isRdmAmm) {
          decoded = RaydiumDecoder.decode(data);
          source  = 'raydium';
        }

        if (decoded) {
          return {
            source,
            programId,
            decoded,
            accountsUsed:     instr.accounts?.length ?? 0,
            slippagePercent:  decoded.slippagePercent,
            inAmount:         decoded.inAmount ?? decoded.amountIn,
            minimumOutAmount: decoded.minimumAmountOut,
            timestamp:        Date.now(),
          };
        }
      }
      return null;
    } catch (e) {
      console.warn('[ZendIQ] Failed to parse swap instruction:', e);
      return null;
    }
  }

  // ── Extract transaction info (read-only, no keys) ─────────────────────────
  function extractTxInfo(tx) {
    try {
      const msg          = tx.message ?? tx.compileMessage?.();
      const accounts     = msg?.accountKeys ?? msg?.staticAccountKeys ?? [];
      const instructions = msg?.instructions ?? [];
      const swapInfo     = parseSwapInstruction(tx, msg, accounts, instructions);

      return {
        accountCount: accounts.length,
        programIds:   accounts.map(k => k.toString()),
        instructions: instructions.length,
        swapInfo,
        timestamp:    Date.now(),
        raw:          tx,
      };
    } catch {
      return { timestamp: Date.now(), raw: tx };
    }
  }

  // ── Is this transaction a swap? (OPS-421) ─────────────────────────────────
  // The intercept used to treat every sign request as a trade, so Raydium's Reclaim Rent
  // (token-account closes) opened Review Optimisation with the previous page's pair. The
  // decision is now read from the transaction's own instructions. Raw bytes only: raydium.io
  // bundles web3.js privately, so a deserialiser on window cannot be relied on.
  //
  // Program IDs verified 2026-10-13 as executable on chain and against Raydium's program list
  // (docs.raydium.io/reference/program-addresses). Raydium's programs also add/remove liquidity,
  // open positions and create launches, so only their swap instructions count: AMM v4 by its
  // 1-byte tag (raydium-amm instruction.rs), the Anchor programs by discriminator (raydium-idl).
  const _SWAP_PROGRAMS = new Map([
    ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', { tags: [9, 11, 16, 17] }],             // Raydium AMM v4: SwapBaseIn/Out (+V2)
    ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', { disc: ['8fbe5adac41e33de', '37d96256a34ab4ad'] }], // CPMM swap_base_input/output
    ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', { disc: ['f8c69e91e17587c8', '2b04ed0b1ac91e62', '457d73daf5baf2c4'] }], // CLMM swap, swap_v2, swap_router_base_in
    ['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', { disc: ['faea0d7bd59c13ec', '18d3742869039938', '9527de9bd37c981a', '5fc8472208090ba6'] }], // LaunchLab buy/sell exact in/out
    ['routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS', { any: true }],   // Raydium AMM routing (multi-hop swaps)
    ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', { any: true }],   // Jupiter v6 aggregator (Ultra "metis")
    ['61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH', { any: true }],  // Jupiter order engine (Ultra "jupiterz" RFQ)
    ['DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH', { any: true }],  // DFlow aggregator (an Ultra router)
    // OKX DEX router (an Ultra router): web3.okx.com/onchainos/dev-docs/trade/dex-smart-contract,
    // and the top-level program of live router=okx Ultra fills (OPS-336).
    ['proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u', { any: true }],
    ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', { any: true }],   // pump.fun bonding curve
    ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { any: true }],   // PumpSwap AMM
  ]);

  const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function _b58DecodeAny(str) {
    let n = 0n;
    for (const c of str) {
      const i = _B58.indexOf(c);
      if (i < 0) return null;
      n = n * 58n + BigInt(i);
    }
    const bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
    for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.unshift(0);
    return new Uint8Array(bytes);
  }

  function _compactU16(b, o) {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const x = b[o + i];
      if (x === undefined) throw new Error('truncated');
      v |= (x & 0x7f) << (7 * i);
      if (!(x & 0x80)) return [v, o + i + 1];
    }
    throw new Error('bad compact-u16');
  }

  // Top-level instructions of a serialised transaction (legacy or v0). Program IDs are always
  // static keys, so address lookup tables never need resolving here.
  function _rawInstructions(bytes) {
    let n, o;
    [n, o] = _compactU16(bytes, 0);
    o += 64 * n;
    if (bytes[o] & 0x80) o += 1;          // versioned message prefix
    o += 3;                               // message header
    [n, o] = _compactU16(bytes, o);
    const keys = [];
    for (let i = 0; i < n; i++, o += 32) keys.push(bytes.subarray(o, o + 32));
    o += 32;                              // recent blockhash
    if (o > bytes.length) throw new Error('truncated');
    [n, o] = _compactU16(bytes, o);
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = bytes[o++];
      let len;
      [len, o] = _compactU16(bytes, o); o += len;
      [len, o] = _compactU16(bytes, o);
      const data = bytes.subarray(o, o + len); o += len;
      if (p === undefined || p >= keys.length || o > bytes.length) throw new Error('truncated');
      out.push({ program: ns.b58Encode(keys[p]), data });
    }
    return out;
  }

  // Every serialised transaction in a wallet / RPC argument: Uint8Array, base64 / base58
  // string (per the RPC `encoding`), Wallet Standard inputs (single or array), or a web3.js
  // transaction object. Null when an item cannot be turned into bytes.
  function _txBytesList(input, encoding) {
    if (input == null) return null;
    if (Array.isArray(input)) {
      const all = [];
      for (const x of input) { const l = _txBytesList(x, encoding); if (!l) return null; all.push(...l); }
      return all.length ? all : null;
    }
    if (input instanceof Uint8Array) return [input];
    if (ArrayBuffer.isView(input)) return [new Uint8Array(input.buffer, input.byteOffset, input.byteLength)];
    if (typeof input === 'string') {
      if (encoding === 'base64') {
        try { return [Uint8Array.from(atob(input), c => c.charCodeAt(0))]; } catch (_) { return null; }
      }
      const b = _b58DecodeAny(input);
      return b ? [b] : null;
    }
    if (typeof input === 'object') {
      if (input.transaction != null) return _txBytesList(input.transaction, encoding);
      if (typeof input.serialize === 'function') {
        try {
          const s = input.serialize({ requireAllSignatures: false, verifySignatures: false });
          return _txBytesList(s, encoding);
        } catch (_) { return null; }
      }
    }
    return null;
  }

  const _hex8 = (d) => Array.from(d.subarray(0, 8), x => x.toString(16).padStart(2, '0')).join('');

  // 'swap' when any top-level instruction is a recognised swap, 'non-swap' when none is,
  // 'unknown' when the transaction could not be read. Callers intercept only on 'swap'.
  function classifyTxForIntercept(input, encoding) {
    const list = _txBytesList(input, encoding);
    if (!list) return { kind: 'unknown', programs: [] };
    const programs = new Set();
    try {
      for (const bytes of list) {
        for (const ix of _rawInstructions(bytes)) {
          programs.add(ix.program);
          const rule = _SWAP_PROGRAMS.get(ix.program);
          if (!rule) continue;
          if (rule.any
              || (rule.tags && ix.data.length && rule.tags.includes(ix.data[0]))
              || (rule.disc && ix.data.length >= 8 && rule.disc.includes(_hex8(ix.data)))) {
            return { kind: 'swap', programs: [...programs] };
          }
        }
      }
    } catch (_) {
      return { kind: 'unknown', programs: [...programs] };
    }
    return { kind: 'non-swap', programs: [...programs] };
  }

  // ── Export ───────────────────────────────────────────────────────────────
  Object.assign(ns, {
    BinaryParser,
    JupiterDecoder,
    RaydiumDecoder,
    parseSwapInstruction,
    extractTxInfo,
    classifyTxForIntercept,
  });
})();
