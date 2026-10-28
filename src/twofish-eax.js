/**
 * Cisco Packet Tracer .pkt / .pka / .pta container codec (pure JS).
 *
 * Four-stage pipeline used by Packet Tracer 6.x and later:
 *   1. position-keyed XOR + byte reversal
 *   2. Twofish-EAX (key 0x89*16, nonce 0x10*16)   [CMAC tag + CTR keystream]
 *   3. position-keyed XOR (length based)
 *   4. zlib inflate behind a 4-byte big-endian length prefix
 *
 * Twofish is implemented from the designers' definition and checked against the
 * published all-zero test vector (9F589F5CF6122C32B6BFEC2F2AE8C35A).
 */

import { inflateSync, inflateRawSync, deflateSync } from 'node:zlib'

// ------------------------------------------------------------------ Twofish --
const RHO = 0x01010101

const T_Q0 = ['817D6F320B59ECA4', 'ECB81235F4A6709D', 'BA5E6D90C8F32471', 'D7F4126E9B3085CA']
const T_Q1 = ['28BDF76E31940AC5', '1E2B4C376DA5F908', '4C75169A0ED82B3F', 'B951C3DE647F208A']

const ror4 = (x, n) => ((x >> n) | (x << (4 - n))) & 15

function makeQ (tables) {
  const [t0, t1, t2, t3] = tables.map((t) => [...t].map((c) => parseInt(c, 16)))
  const q = new Uint8Array(256)
  for (let x = 0; x < 256; x++) {
    const a0 = x >> 4
    const b0 = x & 15
    const a1 = a0 ^ b0
    const b1 = a0 ^ ror4(b0, 1) ^ ((8 * a0) & 15)
    const a2 = t0[a1]
    const b2 = t1[b1]
    const a3 = a2 ^ b2
    const b3 = a2 ^ ror4(b2, 1) ^ ((8 * a2) & 15)
    q[x] = 16 * t3[b3] + t2[a3]
  }
  return q
}

const Q0 = makeQ(T_Q0)
const Q1 = makeQ(T_Q1)

const MDS_POLY = 0x169
const RS_POLY = 0x14d

function gfMul (a, b, poly) {
  let r = 0
  while (b) {
    if (b & 1) r ^= a
    a <<= 1
    if (a & 0x100) a ^= poly
    b >>= 1
  }
  return r
}

const RS = [
  [0x01, 0xa4, 0x55, 0x87, 0x5a, 0x58, 0xdb, 0x9e],
  [0xa4, 0x56, 0x82, 0xf3, 0x1e, 0xc6, 0x68, 0xe5],
  [0x02, 0xa1, 0xfc, 0xc1, 0x47, 0xae, 0x3d, 0x19],
  [0xa4, 0x55, 0x87, 0x5a, 0x58, 0xdb, 0x9e, 0x03]
]

const MUL_5B = new Uint8Array(256)
const MUL_EF = new Uint8Array(256)
for (let i = 0; i < 256; i++) {
  MUL_5B[i] = gfMul(i, 0x5b, MDS_POLY)
  MUL_EF[i] = gfMul(i, 0xef, MDS_POLY)
}

function mdsMultiply (y0, y1, y2, y3) {
  const o0 = y0 ^ MUL_EF[y1] ^ MUL_5B[y2] ^ MUL_5B[y3]
  const o1 = MUL_5B[y0] ^ MUL_EF[y1] ^ MUL_EF[y2] ^ y3
  const o2 = MUL_EF[y0] ^ MUL_5B[y1] ^ y2 ^ MUL_EF[y3]
  const o3 = MUL_EF[y0] ^ y1 ^ MUL_EF[y2] ^ MUL_5B[y3]
  return (o0 | (o1 << 8) | (o2 << 16) | (o3 << 24)) >>> 0
}

const rol = (x, n) => {
  n %= 32
  return n === 0 ? x >>> 0 : (((x << n) | (x >>> (32 - n))) >>> 0)
}
const ror = (x, n) => rol(x, 32 - (n % 32))
const byteOf = (w, i) => (w >>> (8 * i)) & 0xff

function h (x, words) {
  const k = words.length
  const b = words.map((w) => [byteOf(w, 0), byteOf(w, 1), byteOf(w, 2), byteOf(w, 3)])
  let y0 = byteOf(x, 0)
  let y1 = byteOf(x, 1)
  let y2 = byteOf(x, 2)
  let y3 = byteOf(x, 3)

  if (k === 4) {
    y0 = Q1[y0] ^ b[3][0]; y1 = Q0[y1] ^ b[3][1]; y2 = Q0[y2] ^ b[3][2]; y3 = Q1[y3] ^ b[3][3]
  }
  if (k >= 3) {
    y0 = Q1[y0] ^ b[2][0]; y1 = Q1[y1] ^ b[2][1]; y2 = Q0[y2] ^ b[2][2]; y3 = Q0[y3] ^ b[2][3]
  }
  y0 = Q1[Q0[Q0[y0] ^ b[1][0]] ^ b[0][0]]
  y1 = Q0[Q0[Q1[y1] ^ b[1][1]] ^ b[0][1]]
  y2 = Q1[Q1[Q0[y2] ^ b[1][2]] ^ b[0][2]]
  y3 = Q0[Q1[Q1[y3] ^ b[1][3]] ^ b[0][3]]
  return mdsMultiply(y0, y1, y2, y3)
}

export class Twofish {
  constructor (key) {
    if (key.length !== 16) throw new Error('only 128-bit Twofish keys are supported')
    const m = []
    for (let i = 0; i < 4; i++) {
      m.push((key[4 * i] | (key[4 * i + 1] << 8) | (key[4 * i + 2] << 16) | (key[4 * i + 3] << 24)) >>> 0)
    }
    const even = [m[0], m[2]]
    const odd = [m[1], m[3]]

    const rsWord = (off) => {
      let out = 0
      for (let row = 0; row < 4; row++) {
        let v = 0
        for (let col = 0; col < 8; col++) v ^= gfMul(RS[row][col], key[off + col], RS_POLY)
        out |= v << (8 * row)
      }
      return out >>> 0
    }
    this.s = [rsWord(0), rsWord(8)].reverse()   // S-box words, reversed

    this.k = new Array(40)
    for (let i = 0; i < 20; i++) {
      const a = h((2 * i * RHO) >>> 0, even)
      const b = rol(h(((2 * i + 1) * RHO) >>> 0, odd), 8)
      this.k[2 * i] = (a + b) >>> 0
      this.k[2 * i + 1] = rol((a + 2 * b) >>> 0, 9)
    }
  }

  g (x) { return h(x, this.s) }

  encryptBlock (block) {
    const k = this.k
    let r = [
      ((block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24)) >>> 0) ^ k[0],
      ((block[4] | (block[5] << 8) | (block[6] << 16) | (block[7] << 24)) >>> 0) ^ k[1],
      ((block[8] | (block[9] << 8) | (block[10] << 16) | (block[11] << 24)) >>> 0) ^ k[2],
      ((block[12] | (block[13] << 8) | (block[14] << 16) | (block[15] << 24)) >>> 0) ^ k[3]
    ]
    for (let rnd = 0; rnd < 16; rnd++) {
      const t0 = this.g(r[0])
      const t1 = this.g(rol(r[1], 8))
      const f0 = (t0 + t1 + k[8 + 2 * rnd]) >>> 0
      const f1 = (t0 + 2 * t1 + k[9 + 2 * rnd]) >>> 0
      const n2 = ror((r[2] ^ f0) >>> 0, 1)
      const n3 = (rol(r[3], 1) ^ f1) >>> 0
      r = [n2, n3, r[0], r[1]]
    }
    const out = [(r[2] ^ k[4]) >>> 0, (r[3] ^ k[5]) >>> 0, (r[0] ^ k[6]) >>> 0, (r[1] ^ k[7]) >>> 0]
    const buf = Buffer.alloc(16)
    for (let i = 0; i < 4; i++) buf.writeUInt32LE(out[i], 4 * i)
    return buf
  }
}

// ---------------------------------------------------------------------- EAX --
const BS = 16
const M128 = (1n << 128n) - 1n

const xorBuf = (a, b) => {
  const out = Buffer.alloc(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ (b[i] ?? 0)
  return out
}

function gfDouble (b) {
  const carry = b[0] & 0x80
  const out = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) {
    const next = i + 1 < 16 ? b[i + 1] : 0
    out[i] = ((b[i] << 1) & 0xff) | (next >> 7)
  }
  if (carry) out[15] ^= 0x87
  return out
}

function omac (cipher, t, msg) {
  const L = cipher.encryptBlock(Buffer.alloc(16))
  const k1 = gfDouble(L)
  const k2 = gfDouble(k1)

  const tagBlock = Buffer.alloc(16)
  tagBlock.writeUInt32BE(t, 12)

  let data = Buffer.concat([tagBlock, msg])
  let last
  let body
  if (data.length % BS === 0) {
    last = xorBuf(data.subarray(data.length - BS), k1)
    body = data.subarray(0, data.length - BS)
  } else {
    const pad = Buffer.alloc(BS - (data.length % BS))
    pad[0] = 0x80
    data = Buffer.concat([data, pad])
    last = xorBuf(data.subarray(data.length - BS), k2)
    body = data.subarray(0, data.length - BS)
  }

  let state = Buffer.alloc(16)
  for (let i = 0; i < body.length; i += BS) {
    state = cipher.encryptBlock(xorBuf(state, body.subarray(i, i + BS)))
  }
  return cipher.encryptBlock(xorBuf(state, last))
}

function ctr (cipher, nonceBlock, data) {
  const out = Buffer.alloc(data.length)
  const base = BigInt('0x' + nonceBlock.toString('hex'))
  for (let off = 0, blk = 0; off < data.length; off += BS, blk++) {
    const counter = (base + BigInt(blk)) & M128
    const cb = Buffer.from(counter.toString(16).padStart(32, '0'), 'hex')
    const ks = cipher.encryptBlock(cb)
    const n = Math.min(BS, data.length - off)
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i]
  }
  return out
}

function eaxDecrypt (cipher, nonce, ctWithTag) {
  if (ctWithTag.length < BS) throw new Error('payload too short for an EAX tag')
  const tag = ctWithTag.subarray(ctWithTag.length - BS)
  const ct = ctWithTag.subarray(0, ctWithTag.length - BS)
  const n = omac(cipher, 0, nonce)
  const hh = omac(cipher, 1, Buffer.alloc(0))
  const c = omac(cipher, 2, ct)
  const expected = xorBuf(xorBuf(n, hh), c)
  if (!expected.equals(tag)) {
    throw new Error('EAX authentication tag mismatch (corrupt file or wrong key)')
  }
  return ctr(cipher, n, ct)
}

// ----------------------------------------------------------------- pipeline --
export const PKA_KEY = Buffer.alloc(16, 0x89)
export const PKA_NONCE = Buffer.alloc(16, 0x10)

export function decryptPkt (data) {
  const n = data.length
  if (!n) throw new Error('empty file')

  const stage1 = Buffer.alloc(n)
  for (let i = 0; i < n; i++) stage1[i] = (data[n + ~i] ^ ((n - i * n) & 0xff)) & 0xff

  const cipher = new Twofish(PKA_KEY)
  const stage2 = eaxDecrypt(cipher, PKA_NONCE, stage1)

  const m = stage2.length
  const stage3 = Buffer.alloc(m)
  for (let i = 0; i < m; i++) stage3[i] = stage2[i] ^ ((m - i) & 0xff)

  if (stage3.length < 4) throw new Error('decrypted payload too small')
  const declaredSize = stage3.readUInt32BE(0)
  const payload = stage3.subarray(4)
  let plain
  try {
    plain = inflateSync(payload)
  } catch (e) {
    try {
      plain = inflateRawSync(payload)
    } catch {
      throw new Error(`zlib decompression failed: ${e.message}`)
    }
  }
  // Packet Tracer only reads `declaredSize` bytes of the payload, so a prefix
  // that disagrees with the real byte length silently truncates the document
  // (typically the last device's trailing elements). inflateSync() ignores the
  // prefix, so without this flag the corruption is invisible from the read side.
  const sizeMismatch = declaredSize !== plain.length
  return { xml: plain, declaredSize, sizeMismatch }
}

export function encryptPkt (xml) {
  // The 4-byte prefix is a BYTE count of the UTF-8 payload. For a JS string
  // `.length` is the UTF-16 code-unit count instead, so any non-ASCII character
  // (Chinese canvas notes, accented device names, ...) makes the prefix short
  // and Packet Tracer silently truncates the tail of the document when it loads
  // the file. Normalise to a Buffer so both call styles are safe.
  const payload = Buffer.isBuffer(xml) ? xml : Buffer.from(String(xml), 'utf8')
  const lenPrefix = Buffer.alloc(4)
  lenPrefix.writeUInt32BE(payload.length, 0)
  const stage3 = Buffer.concat([lenPrefix, deflateSync(payload)])
  const m = stage3.length
  const stage2 = Buffer.alloc(m)
  for (let i = 0; i < m; i++) stage2[i] = stage3[i] ^ ((m - i) & 0xff)

  const cipher = new Twofish(PKA_KEY)
  const n = omac(cipher, 0, PKA_NONCE)
  const hh = omac(cipher, 1, Buffer.alloc(0))
  const ct = ctr(cipher, n, stage2)
  const c = omac(cipher, 2, ct)
  const stage1 = Buffer.concat([ct, xorBuf(xorBuf(n, hh), c)])

  const out = Buffer.alloc(stage1.length)
  for (let i = 0; i < stage1.length; i++) {
    out[stage1.length + ~i] = stage1[i] ^ ((stage1.length - i * stage1.length) & 0xff)
  }
  return out
}
