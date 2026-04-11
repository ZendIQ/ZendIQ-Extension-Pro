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

  // ── Export ───────────────────────────────────────────────────────────────
  Object.assign(ns, {
    BinaryParser,
    JupiterDecoder,
    RaydiumDecoder,
    parseSwapInstruction,
    extractTxInfo,
  });
})();
