// Self-contained BC7 (DXGI BC7_UNORM / BC7_UNORM_SRGB) block decoder — pure JS, no deps.
// Build-time only (companion to lib-dds.mjs's decodeBC1). Decodes all 8 BC7 modes.
//
// Each block is 128 bits, 16 bytes, blocks in row-major order over ceil(w/4) x ceil(h/4).
// Bits are read LSB-first starting at byte 0 (the mode is the count of low zero bits before
// the first set bit). Per-mode field order is: mode bits, [rotation], [index-selection],
// partition, all R endpoints, all G, all B, [all A], then P-bits, color indices, alpha indices.
//
// References for the fixed tables / layouts: the BC7 spec (D3D11 "BC7 Format Mode Reference")
// and the Khronos/DirectXTex BC7 decode tables, reproduced here exactly.

// ── Fixed tables ─────────────────────────────────────────────────────────────

// Interpolation weights (numerator over 64). Interp: ((64-w)*e0 + w*e1 + 32) >> 6.
const aWeight2 = [0, 21, 43, 64]
const aWeight3 = [0, 9, 18, 27, 37, 46, 55, 64]
const aWeight4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]

// 2-subset partition table: 64 entries, each 16 subset-ids (0/1) for the 16 pixels.
const PARTITIONS_2 = [
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1],
  [0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1],
  [0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1],
  [0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1],
  [0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0],
  [0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
  [0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
  [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0],
  [0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0],
  [0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
  [0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0],
  [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1],
  [0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0],
  [0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0],
  [0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1],
  [0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1],
  [0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0],
  [0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0],
  [0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1],
  [0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1],
  [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0],
  [0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0],
  [0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1],
  [0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1],
  [0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0],
  [0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0],
  [0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1],
  [0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1],
  [0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
  [0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1],
  [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
  [0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
  [0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0],
  [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1],
]

// 3-subset partition table: 64 entries, each 16 subset-ids (0/1/2).
const PARTITIONS_3 = [
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 1, 2, 2, 2, 2],
  [0, 0, 0, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1],
  [0, 0, 0, 0, 2, 0, 0, 1, 2, 2, 1, 1, 2, 2, 1, 1],
  [0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2],
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 2, 2],
  [0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2],
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2],
  [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2],
  [0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2],
  [0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2],
  [0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2],
  [0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2, 1, 2, 2, 2],
  [0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 2, 2, 2, 0],
  [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2],
  [0, 1, 1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0],
  [0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2],
  [0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1],
  [0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2, 0, 2, 2, 2],
  [0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 1],
  [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2],
  [0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 1, 0, 2, 2, 1, 0],
  [0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0],
  [0, 0, 1, 2, 0, 0, 1, 2, 1, 1, 2, 2, 2, 2, 2, 2],
  [0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1, 0, 1, 1, 0],
  [0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1],
  [0, 0, 2, 2, 1, 1, 0, 2, 1, 1, 0, 2, 0, 0, 2, 2],
  [0, 1, 1, 0, 0, 1, 1, 0, 2, 0, 0, 2, 2, 2, 2, 2],
  [0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1],
  [0, 0, 0, 0, 2, 0, 0, 0, 2, 2, 1, 1, 2, 2, 2, 1],
  [0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 2, 2, 2],
  [0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 1, 1],
  [0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 2, 2, 0, 2, 2, 2],
  [0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0],
  [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0],
  [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0],
  [0, 1, 2, 0, 2, 0, 1, 2, 1, 2, 0, 1, 0, 1, 2, 0],
  [0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1],
  [0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1],
  [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2],
  [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1],
  [0, 0, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 1, 1, 2, 2],
  [0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 1, 1],
  [0, 2, 2, 0, 1, 2, 2, 1, 0, 2, 2, 0, 1, 2, 2, 1],
  [0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 0, 1],
  [0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
  [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2],
  [0, 2, 2, 2, 0, 1, 1, 1, 0, 2, 2, 2, 0, 1, 1, 1],
  [0, 0, 0, 2, 1, 1, 1, 2, 0, 0, 0, 2, 1, 1, 1, 2],
  [0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2],
  [0, 2, 2, 2, 0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2],
  [0, 0, 0, 2, 1, 1, 1, 2, 1, 1, 1, 2, 0, 0, 0, 2],
  [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2],
  [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2],
  [0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 2, 2, 2],
  [0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2],
  [0, 0, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2],
  [0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1],
  [0, 2, 2, 2, 1, 2, 2, 2, 0, 2, 2, 2, 1, 2, 2, 2],
  [0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  [0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 0, 1, 2, 2, 2, 0],
]

// Fixed anchor indices. Subset 0's anchor is always pixel 0.
// 2-subset: anchor for subset 1, indexed by partition.
const ANCHOR_2_1 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2, 15,
  15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
]
// 3-subset: anchor for subset 1 and subset 2, each indexed by partition.
const ANCHOR_3_1 = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15, 8, 15, 3, 5,
  6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
]
const ANCHOR_3_2 = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8, 15,
  3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
]

// ── Bit reader (LSB-first over the 16-byte block) ────────────────────────────
class BitReader {
  constructor(buf, offset) {
    this.buf = buf
    this.base = offset
    this.pos = 0
  }
  // Read n bits (n <= 32) LSB-first; bit i of the result is bit (pos+i) of the block.
  read(n) {
    let v = 0
    for (let i = 0; i < n; i++) {
      const bit = this.pos + i
      const byteBit = (this.buf[this.base + (bit >> 3)] >> (bit & 7)) & 1
      v |= byteBit << i
    }
    this.pos += n
    return v >>> 0
  }
}

// Expand a `bits`-bit unorm value to 8 bits: left-shift then OR the high bits down.
function expand(v, bits) {
  if (bits >= 8) return v & 0xff
  return ((v << (8 - bits)) | (v >>> (2 * bits - 8))) & 0xff
}

// Interpolate one component between e0 and e1 with weight w (0..64).
function interp(e0, e1, w) {
  return ((64 - w) * e0 + w * e1 + 32) >> 6
}

// Per-mode descriptors. cb/ab = color/alpha endpoint precision (before P-bit).
// pbits: 0=none, 'shared'=one P-bit per subset (mode 1), 'unique'=one P-bit per endpoint.
const MODES = [
  { subsets: 3, partBits: 4, cb: 4, ab: 0, ib: 3, ib2: 0, pbits: 'unique', rotBits: 0, idxBits: 0 }, // 0
  { subsets: 2, partBits: 6, cb: 6, ab: 0, ib: 3, ib2: 0, pbits: 'shared', rotBits: 0, idxBits: 0 }, // 1
  { subsets: 3, partBits: 6, cb: 5, ab: 0, ib: 2, ib2: 0, pbits: 0, rotBits: 0, idxBits: 0 }, // 2
  { subsets: 2, partBits: 6, cb: 7, ab: 0, ib: 2, ib2: 0, pbits: 'unique', rotBits: 0, idxBits: 0 }, // 3
  { subsets: 1, partBits: 0, cb: 5, ab: 6, ib: 2, ib2: 3, pbits: 0, rotBits: 2, idxBits: 1 }, // 4
  { subsets: 1, partBits: 0, cb: 7, ab: 8, ib: 2, ib2: 2, pbits: 0, rotBits: 2, idxBits: 0 }, // 5
  { subsets: 1, partBits: 0, cb: 7, ab: 7, ib: 4, ib2: 0, pbits: 'unique', rotBits: 0, idxBits: 0 }, // 6
  { subsets: 2, partBits: 6, cb: 5, ab: 5, ib: 2, ib2: 0, pbits: 'unique', rotBits: 0, idxBits: 0 }, // 7
]

function weightTable(bits) {
  return bits === 2 ? aWeight2 : bits === 3 ? aWeight3 : aWeight4
}

// Decode one 16-byte BC7 block into out[] at the given pixel positions.
// `write(localIdx, r, g, b, a)` stores the pixel.
function decodeBlock(buf, blockOff, write) {
  const br = new BitReader(buf, blockOff)

  // Mode = number of leading zero bits before first set bit (max 8).
  let mode = 0
  while (mode < 8 && br.read(1) === 0) mode++
  if (mode === 8) {
    // reserved / illegal mode: emit transparent black
    for (let i = 0; i < 16; i++) write(i, 0, 0, 0, 0)
    return
  }
  const M = MODES[mode]

  // Optional rotation + index-selection (modes 4/5 rot; mode 4 idx-select).
  let rotation = 0,
    idxSel = 0
  if (M.rotBits) rotation = br.read(M.rotBits)
  if (M.idxBits) idxSel = br.read(M.idxBits)

  // Partition.
  const partition = M.partBits ? br.read(M.partBits) : 0
  const numSubsets = M.subsets

  // Endpoints: read all R for every endpoint, then all G, all B, then all A.
  const numEndpoints = numSubsets * 2
  const hasAlpha = M.ab > 0
  const ep = [] // ep[e] = [r,g,b,a] raw component values (P-bit not yet appended)
  for (let e = 0; e < numEndpoints; e++) ep.push([0, 0, 0, 0])
  for (let e = 0; e < numEndpoints; e++) ep[e][0] = br.read(M.cb)
  for (let e = 0; e < numEndpoints; e++) ep[e][1] = br.read(M.cb)
  for (let e = 0; e < numEndpoints; e++) ep[e][2] = br.read(M.cb)
  if (hasAlpha) for (let e = 0; e < numEndpoints; e++) ep[e][3] = br.read(M.ab)

  // P-bits.
  const pbit = new Array(numEndpoints).fill(0)
  if (M.pbits === 'unique') {
    for (let e = 0; e < numEndpoints; e++) pbit[e] = br.read(1)
  } else if (M.pbits === 'shared') {
    for (let s = 0; s < numSubsets; s++) {
      const b = br.read(1)
      pbit[s * 2] = b
      pbit[s * 2 + 1] = b
    }
  }

  // Expand endpoints to 8-bit RGBA, appending the P-bit as the LSB before expansion.
  const cb = M.cb + (M.pbits ? 1 : 0)
  const ab = hasAlpha ? M.ab + (M.pbits ? 1 : 0) : 0
  const col = [] // col[e] = [r,g,b,a] expanded 0..255
  for (let e = 0; e < numEndpoints; e++) {
    const r = ep[e][0],
      g = ep[e][1],
      b = ep[e][2],
      a = ep[e][3]
    let R, G, B, A
    if (M.pbits) {
      R = expand((r << 1) | pbit[e], cb)
      G = expand((g << 1) | pbit[e], cb)
      B = expand((b << 1) | pbit[e], cb)
    } else {
      R = expand(r, cb)
      G = expand(g, cb)
      B = expand(b, cb)
    }
    if (hasAlpha) {
      A = M.pbits ? expand((a << 1) | pbit[e], ab) : expand(a, ab)
    } else {
      A = 255
    }
    col.push([R, G, B, A])
  }

  // Index bit-widths. ib = primary (color) indices; ib2 = secondary (alpha) indices.
  const ib = M.ib
  const ib2 = M.ib2
  const partTable = numSubsets === 3 ? PARTITIONS_3[partition] : numSubsets === 2 ? PARTITIONS_2[partition] : null

  // Anchor index per subset (the pixel within the block that stores one fewer bit).
  const anchors = [0]
  if (numSubsets === 2) anchors[1] = ANCHOR_2_1[partition]
  else if (numSubsets === 3) {
    anchors[1] = ANCHOR_3_1[partition]
    anchors[2] = ANCHOR_3_2[partition]
  }

  const subsetOf = (px) => (partTable ? partTable[px] : 0)
  const isAnchor = (px) => {
    for (let s = 0; s < numSubsets; s++) if (anchors[s] === px) return true
    return false
  }

  // Read primary index for each pixel (anchors store ib-1 bits, MSB implicit 0).
  const idx1 = new Array(16)
  for (let px = 0; px < 16; px++) {
    const bits = isAnchor(px) ? ib - 1 : ib
    idx1[px] = br.read(bits)
  }
  // Read secondary (alpha) indices if present.
  let idx2 = null
  if (ib2) {
    idx2 = new Array(16)
    for (let px = 0; px < 16; px++) {
      // For modes 4/5 (single subset) only pixel 0 is the anchor.
      const bits = px === 0 ? ib2 - 1 : ib2
      idx2[px] = br.read(bits)
    }
  }

  const w1 = weightTable(ib)
  const w2 = ib2 ? weightTable(ib2) : null

  for (let px = 0; px < 16; px++) {
    const s = subsetOf(px)
    const e0 = col[s * 2],
      e1 = col[s * 2 + 1]

    let r, g, b, a
    if (ib2) {
      // Two index sets: color uses idx1, alpha uses idx2 — unless index-selection
      // (mode 4) swaps which set drives color vs alpha.
      let colorIdx, alphaIdx, colorW, alphaW
      if (idxSel) {
        colorIdx = idx2[px]
        colorW = w2
        alphaIdx = idx1[px]
        alphaW = w1
      } else {
        colorIdx = idx1[px]
        colorW = w1
        alphaIdx = idx2[px]
        alphaW = w2
      }
      const cw = colorW[colorIdx]
      const aw = alphaW[alphaIdx]
      r = interp(e0[0], e1[0], cw)
      g = interp(e0[1], e1[1], cw)
      b = interp(e0[2], e1[2], cw)
      a = interp(e0[3], e1[3], aw)
    } else {
      const cw = w1[idx1[px]]
      r = interp(e0[0], e1[0], cw)
      g = interp(e0[1], e1[1], cw)
      b = interp(e0[2], e1[2], cw)
      a = hasAlpha ? interp(e0[3], e1[3], cw) : 255
    }

    // Rotation (modes 4/5): swap the named channel with alpha after interpolation.
    if (rotation === 1) {
      const t = r
      r = a
      a = t
    } else if (rotation === 2) {
      const t = g
      g = a
      a = t
    } else if (rotation === 3) {
      const t = b
      b = a
      a = t
    }

    write(px, r, g, b, a)
  }
}

/** Decode a BC7 (BC7_UNORM / _SRGB) block-compressed surface into a flat RGBA8 buffer. */
export function decodeBC7(buf, offset, width, height) {
  const out = Buffer.alloc(width * height * 4)
  const bw = (width + 3) >> 2
  const bh = (height + 3) >> 2
  let p = offset
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      decodeBlock(buf, p, (i, r, g, b, a) => {
        const px = bx * 4 + (i & 3)
        const py = by * 4 + (i >> 2)
        if (px >= width || py >= height) return
        const o = (py * width + px) * 4
        out[o] = r
        out[o + 1] = g
        out[o + 2] = b
        out[o + 3] = a
      })
      p += 16
    }
  }
  return out
}

// ── Self-test ────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('bc7.mjs')) {
  let failures = 0
  const ok = (cond, msg) => {
    if (!cond) {
      failures++
      console.error('FAIL:', msg)
    } else console.log('ok  :', msg)
  }

  // Helper: build a 16-byte block by writing fields LSB-first, mirroring the reader.
  class BitWriter {
    constructor() {
      this.bytes = new Uint8Array(16)
      this.pos = 0
    }
    write(v, n) {
      for (let i = 0; i < n; i++) {
        const bit = this.pos + i
        if ((v >> i) & 1) this.bytes[bit >> 3] |= 1 << (bit & 7)
      }
      this.pos += n
    }
    buffer() {
      return Buffer.from(this.bytes)
    }
  }

  // jscpd:ignore-start — per-mode known-answer self-tests: each BC7 mode's synthetic block writer
  // + assertions repeat the same skeleton BY NATURE (the spec's per-mode field order is what's
  // under test); collapsing them into one parametrised loop would hide which mode/layout a
  // failure points at.
  // ── Mode 6 known-answer: solid color from two equal endpoints. ──
  // Mode 6 layout: mode(7 bits = 0000001? — 6 zeros then a 1), R0..A1 (7 each),
  // P0,P1, then sixteen 4-bit indices (pixel 0 anchor = 3 bits).
  {
    const bw7 = new BitWriter()
    bw7.write(0b1000000, 7) // mode 6: six 0 bits then a 1 (LSB-first => value 64)
    // endpoints: pick raw 7-bit = 0x40 (64) for all channels, P-bit 1.
    // expanded 8-bit value: ((64<<1)|1)=129 -> 8-bit expand of an 8-bit value = 129.
    const v = 64
    for (let e = 0; e < 2; e++) bw7.write(v, 7) // R0,R1
    for (let e = 0; e < 2; e++) bw7.write(v, 7) // G0,G1
    for (let e = 0; e < 2; e++) bw7.write(v, 7) // B0,B1
    for (let e = 0; e < 2; e++) bw7.write(v, 7) // A0,A1
    bw7.write(1, 1)
    bw7.write(1, 1) // P0=1, P1=1 -> both endpoints identical
    // indices: pixel 0 = 3 bits, rest 4 bits. value 0 everywhere => uses e0 (== e1).
    bw7.write(0, 3)
    for (let i = 1; i < 16; i++) bw7.write(0, 4)
    const rgba = decodeBC7(bw7.buffer(), 0, 4, 4)
    const exp = 129 // ((64<<1)|1)=129, 8-bit expand returns 129
    let solid = true
    for (let i = 0; i < 16; i++) {
      if (rgba[i * 4] !== exp || rgba[i * 4 + 1] !== exp || rgba[i * 4 + 2] !== exp || rgba[i * 4 + 3] !== exp)
        solid = false
    }
    ok(solid, `mode6 solid block decodes all 16 px to (${exp},${exp},${exp},${exp})`)
    ok(rgba.length === 64, 'mode6 output length is 4*4*4=64')
  }

  // ── Mode 6 two-color gradient: endpoint interpolation sanity. ──
  {
    const bw7 = new BitWriter()
    bw7.write(0b1000000, 7)
    // e0 raw 0 (P0=0) -> 0; e1 raw 127 (P1=1) -> ((127<<1)|1)=255.
    bw7.write(0, 7)
    bw7.write(127, 7) // R0,R1
    bw7.write(0, 7)
    bw7.write(127, 7) // G0,G1
    bw7.write(0, 7)
    bw7.write(127, 7) // B0,B1
    bw7.write(127, 7)
    bw7.write(0, 7) // A0=255 (with P0?) — see below
    bw7.write(0, 1)
    bw7.write(1, 1) // P0=0, P1=1
    // With P0=0: e0 = expand((0<<1)|0)=0 for RGB, A0 = expand((127<<1)|0)=254.
    // With P1=1: e1 = expand((127<<1)|1)=255 for RGB, A1 = expand((0<<1)|1)=1.
    // index 0 -> e0, index 15 -> e1 (4-bit indices).
    bw7.write(0, 3) // px0 anchor -> index 0 -> e0
    for (let i = 1; i < 15; i++) bw7.write(0, 4)
    bw7.write(15, 4) // px15 -> index 15 -> e1
    const rgba = decodeBC7(bw7.buffer(), 0, 4, 4)
    // px0 (e0): RGB=0, A=254
    ok(
      rgba[0] === 0 && rgba[1] === 0 && rgba[2] === 0 && rgba[3] === 254,
      `mode6 px0 == e0 (0,0,0,254) got (${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3]})`,
    )
    // px15 (e1): RGB=255, A=1
    const o = 15 * 4
    ok(
      rgba[o] === 255 && rgba[o + 1] === 255 && rgba[o + 2] === 255 && rgba[o + 3] === 1,
      `mode6 px15 == e1 (255,255,255,1) got (${rgba[o]},${rgba[o + 1]},${rgba[o + 2]},${rgba[o + 3]})`,
    )
  }

  // ── Mode 5 known-answer: rotation=0, distinct color & alpha endpoints. ──
  // Mode 5 layout: mode(6 bits: 00000 then 1 => value 32), rotation(2), then
  // R0,R1,G0,G1,B0,B1 (7 each), A0,A1 (8 each), color indices (2-bit, px0=1 bit),
  // alpha indices (2-bit, px0=1 bit). No P-bits.
  {
    const bw7 = new BitWriter()
    bw7.write(0b100000, 6) // mode 5
    bw7.write(0, 2) // rotation = 0
    // color endpoints raw 7-bit: e0=0 -> expand(0,7)=0 ; e1=127 -> expand(127,7)=255
    bw7.write(0, 7)
    bw7.write(127, 7) // R0,R1
    bw7.write(0, 7)
    bw7.write(127, 7) // G0,G1
    bw7.write(0, 7)
    bw7.write(127, 7) // B0,B1
    // alpha endpoints 8-bit: A0=10, A1=200
    bw7.write(10, 8)
    bw7.write(200, 8)
    // color indices: px0 anchor = 1 bit; choose all 0 -> color e0 (0,0,0).
    bw7.write(0, 1)
    for (let i = 1; i < 16; i++) bw7.write(0, 2)
    // alpha indices: px0 anchor = 1 bit; choose all 0 -> alpha A0 = 10.
    bw7.write(0, 1)
    for (let i = 1; i < 16; i++) bw7.write(0, 2)
    const rgba = decodeBC7(bw7.buffer(), 0, 4, 4)
    let allBlack10 = true
    for (let i = 0; i < 16; i++) {
      if (rgba[i * 4] !== 0 || rgba[i * 4 + 1] !== 0 || rgba[i * 4 + 2] !== 0 || rgba[i * 4 + 3] !== 10)
        allBlack10 = false
    }
    ok(allBlack10, 'mode5 idx0 => color e0 (0,0,0) alpha A0 (10) for all px')
  }

  // ── Mode 5 with index 3 on both: should hit color e1 (255) and alpha A1. ──
  {
    const bw7 = new BitWriter()
    bw7.write(0b100000, 6)
    bw7.write(0, 2)
    bw7.write(0, 7)
    bw7.write(127, 7)
    bw7.write(0, 7)
    bw7.write(127, 7)
    bw7.write(0, 7)
    bw7.write(127, 7)
    bw7.write(0, 8)
    bw7.write(255, 8) // A0=0, A1=255
    bw7.write(1, 1) // px0 color anchor (1 bit) -> max for anchor is value 1; interp weight aWeight2[1]=21
    for (let i = 1; i < 16; i++) bw7.write(3, 2) // color idx 3 -> e1 (255)
    bw7.write(1, 1) // px0 alpha anchor (1 bit)
    for (let i = 1; i < 16; i++) bw7.write(3, 2) // alpha idx 3 -> A1 (255)
    const rgba = decodeBC7(bw7.buffer(), 0, 4, 4)
    // px15 color idx 3 -> 255, alpha idx 3 -> 255
    const o = 15 * 4
    ok(
      rgba[o] === 255 && rgba[o + 1] === 255 && rgba[o + 2] === 255 && rgba[o + 3] === 255,
      `mode5 px15 idx3 => (255,255,255,255) got (${rgba[o]},${rgba[o + 1]},${rgba[o + 2]},${rgba[o + 3]})`,
    )
  }

  // ── Modes 0-3: assert alpha is always 255 (no alpha channel). ──
  // Build a minimal valid block for each and confirm A=255 everywhere.
  const buildNoAlphaSolid = (mode) => {
    const M = MODES[mode]
    const bw7 = new BitWriter()
    bw7.write(1 << mode, mode + 1) // mode bits LSB-first
    if (M.partBits) bw7.write(0, M.partBits) // partition 0
    const ne = M.subsets * 2
    for (let e = 0; e < ne; e++) bw7.write(0, M.cb) // R
    for (let e = 0; e < ne; e++) bw7.write(0, M.cb) // G
    for (let e = 0; e < ne; e++) bw7.write(0, M.cb) // B
    if (M.pbits === 'unique') for (let e = 0; e < ne; e++) bw7.write(0, 1)
    else if (M.pbits === 'shared') for (let s = 0; s < M.subsets; s++) bw7.write(0, 1)
    // indices: write 0 for all, respecting anchors. We must know anchors for partition 0.
    const anchors = [0]
    if (M.subsets === 2) anchors[1] = ANCHOR_2_1[0]
    else if (M.subsets === 3) {
      anchors[1] = ANCHOR_3_1[0]
      anchors[2] = ANCHOR_3_2[0]
    }
    for (let px = 0; px < 16; px++) {
      const isA = anchors.includes(px)
      bw7.write(0, isA ? M.ib - 1 : M.ib)
    }
    return bw7.buffer()
  }
  for (let mode = 0; mode <= 3; mode++) {
    const rgba = decodeBC7(buildNoAlphaSolid(mode), 0, 4, 4)
    let allOpaque = true
    for (let i = 0; i < 16; i++) if (rgba[i * 4 + 3] !== 255) allOpaque = false
    ok(allOpaque, `mode${mode}: alpha == 255 for all 16 px (no alpha channel)`)
    ok(rgba.length === 64, `mode${mode}: output length 64`)
  }

  // ── Solid-color across all modes: equal endpoints => exact color all 16 px. ──
  // Use a non-trivial color where cb fully represents it. For each mode pick a raw
  // value whose 8-bit expansion equals a known target, and set both endpoints equal.
  const buildSolid = (mode, rawRGB) => {
    const M = MODES[mode]
    const bw7 = new BitWriter()
    bw7.write(1 << mode, mode + 1)
    if (M.rotBits) bw7.write(0, M.rotBits)
    if (M.idxBits) bw7.write(0, M.idxBits)
    if (M.partBits) bw7.write(0, M.partBits)
    const ne = M.subsets * 2
    for (let k = 0; k < 3; k++) for (let e = 0; e < ne; e++) bw7.write(rawRGB[k], M.cb)
    if (M.ab) for (let e = 0; e < ne; e++) bw7.write((1 << M.ab) - 1, M.ab) // alpha max
    if (M.pbits === 'unique')
      for (let e = 0; e < ne; e++) bw7.write(1, 1) // P=1 for both
    else if (M.pbits === 'shared') for (let s = 0; s < M.subsets; s++) bw7.write(1, 1)
    const anchors = [0]
    if (M.subsets === 2) anchors[1] = ANCHOR_2_1[0]
    else if (M.subsets === 3) {
      anchors[1] = ANCHOR_3_1[0]
      anchors[2] = ANCHOR_3_2[0]
    }
    for (let px = 0; px < 16; px++) {
      const isA = anchors.includes(px)
      bw7.write(0, isA ? M.ib - 1 : M.ib)
    }
    if (M.ib2) for (let px = 0; px < 16; px++) bw7.write(0, px === 0 ? M.ib2 - 1 : M.ib2)
    return bw7.buffer()
  }
  for (let mode = 0; mode <= 7; mode++) {
    const M = MODES[mode]
    // raw value that with appended P=1 (if any) expands to a single byte: just use 0,
    // which always expands to 0 (P=1 makes RGB nonzero — handle per pbits).
    const raw = [0, 0, 0]
    const rgba = decodeBC7(buildSolid(mode, raw), 0, 4, 4)
    const r0 = rgba[0],
      g0 = rgba[1],
      b0 = rgba[2],
      a0 = rgba[3]
    let solid = true
    for (let i = 0; i < 16; i++) {
      if (rgba[i * 4] !== r0 || rgba[i * 4 + 1] !== g0 || rgba[i * 4 + 2] !== b0 || rgba[i * 4 + 3] !== a0)
        solid = false
    }
    ok(solid, `mode${mode}: equal-endpoint block is solid (${r0},${g0},${b0},${a0}) across all 16 px`)
  }

  // ── Larger surface: dimensions not a multiple of 4 are clipped correctly. ──
  {
    const blocks = 2 // 8x8 px region but request 5x6 -> ceil = 2x2 blocks
    const buf = Buffer.alloc(blocks * blocks * 16)
    // fill with mode-6 solid-white blocks
    for (let b = 0; b < blocks * blocks; b++) {
      const bwk = new BitWriter()
      bwk.write(0b1000000, 7)
      for (let e = 0; e < 2; e++) bwk.write(127, 7)
      for (let e = 0; e < 2; e++) bwk.write(127, 7)
      for (let e = 0; e < 2; e++) bwk.write(127, 7)
      for (let e = 0; e < 2; e++) bwk.write(127, 7)
      bwk.write(1, 1)
      bwk.write(1, 1)
      bwk.write(0, 3)
      for (let i = 1; i < 16; i++) bwk.write(0, 4)
      bwk.buffer().copy(buf, b * 16)
    }
    const rgba = decodeBC7(buf, 0, 5, 6)
    ok(rgba.length === 5 * 6 * 4, 'non-multiple-of-4 surface: length == 5*6*4')
    let allWhite = true
    for (let i = 0; i < 5 * 6; i++) if (rgba[i * 4] !== 255 || rgba[i * 4 + 3] !== 255) allWhite = false
    ok(allWhite, 'non-multiple-of-4 surface: all visible px are white opaque')
  }

  // jscpd:ignore-end

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
