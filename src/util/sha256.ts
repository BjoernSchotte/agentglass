// agentglass — SHA-256 (FIPS 180-4) in pure TS: deterministic OTLP ids without a subprocess per hash
// SPDX-License-Identifier: Apache-2.0
// 32-bit words in plain numbers: every sum wrapped with >>> 0. K and H0 are literal tables — static scriptc builds
// have no Math.sqrt / Math.cbrt to derive them. Rotations are written out inline and the schedule is a reused Uint32Array:
// a helper call per rotation cost half the time (native build, < 20 µs per short id is the target).
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const HEX = "0123456789abcdef";
const BYTE: string[] = []; for (let i = 0; i < 256; i++) BYTE.push(HEX[i >>> 4] + HEX[i & 15]);
const w = new Uint32Array(64); // message schedule, reused
const KK = new Uint32Array(64); for (let i = 0; i < 64; i++) KK[i] = K[i];

export function sha256Bytes(b: Uint8Array): number[] {
  const n = b.length; const blocks = Math.floor((n + 9 + 63) / 64);
  const m = new Uint8Array(blocks * 64);
  m.set(b, 0); m[n] = 0x80;
  const bits = n * 8; const hi = Math.floor(bits / 4294967296); const lo = bits >>> 0; // ≥ 2^32 bits only above 512 MB
  const e = blocks * 64;
  m[e - 8] = (hi >>> 24) & 255; m[e - 7] = (hi >>> 16) & 255; m[e - 6] = (hi >>> 8) & 255; m[e - 5] = hi & 255;
  m[e - 4] = (lo >>> 24) & 255; m[e - 3] = (lo >>> 16) & 255; m[e - 2] = (lo >>> 8) & 255; m[e - 1] = lo & 255;
  const h = H0.slice(0);
  for (let off = 0; off < e; off += 64) {
    for (let i = 0; i < 16; i++) { const j = off + i * 4; w[i] = ((m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3]) >>> 0; }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]; const c = w[i - 2];
      const s0 = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) >>> 0; const s1 = (((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0]; let bb = h[1]; let c = h[2]; let d = h[3]; let ee = h[4]; let f = h[5]; let g = h[6]; let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (((ee >>> 6) | (ee << 26)) ^ ((ee >>> 11) | (ee << 21)) ^ ((ee >>> 25) | (ee << 7))) >>> 0;
      const ch = ((ee & f) ^ (~ee & g)) >>> 0;
      const t1 = (hh + S1 + ch + KK[i] + w[i]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const mj = ((a & bb) ^ (a & c) ^ (bb & c)) >>> 0;
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = ee; ee = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + bb) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + ee) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h;
}
// 8 words → 64 lowercase hex chars (no toString(16) in scriptc)
export function hexOf(words: number[]): string {
  let s = "";
  for (const x of words) { s += BYTE[(x >>> 24) & 255]; s += BYTE[(x >>> 16) & 255]; s += BYTE[(x >>> 8) & 255]; s += BYTE[x & 255]; }
  return s;
}
export function sha256Hex(s: string): string { return hexOf(sha256Bytes(new TextEncoder().encode(s))); }
