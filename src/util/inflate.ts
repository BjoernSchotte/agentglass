// agentglass — gzip reader with a hard output cap (RFC 1951/1952): the receive server's gzip-bomb guard. The runtime's
// zlib.gunzipSync has no maxOutputLength in scriptc and would allocate whatever a lying ISIZE trailer hides (8 MB of
// deflate expands to ~8 GB), so request bodies are inflated here and the first byte past the cap ends the decode.
// Table-driven Huffman decode (one lookup per symbol); CRC-32 and ISIZE verified; concatenated members read in turn.
// SPDX-License-Identifier: Apache-2.0
import { crc32 } from "./gzip.ts";

interface Inf { b: Uint8Array; p: number; bit: number; cnt: number; out: Uint8Array; n: number; max: number; err: string }
interface Huff { t: Int32Array; bits: number } // t[reversed code padded to bits] = symbol << 4 | length (0 = no code)
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fail(s: Inf, m: string): void { if (!s.err) s.err = m; s.p = s.b.length; s.cnt = 0; }
// n bits (≤ 16), LSB first; past the end → fail
function take(s: Inf, n: number): number {
  while (s.cnt < n) {
    if (s.p >= s.b.length) { fail(s, "truncated deflate stream"); return 0; }
    s.bit |= (s.b[s.p] ?? 0) << s.cnt; s.p += 1; s.cnt += 8;
  }
  const v = s.bit & ((1 << n) - 1);
  s.bit = s.bit >>> n; s.cnt = s.cnt - n; // (not -=: scriptc 0.1.7 mis-types it after >>>)
  return v;
}
// canonical Huffman table from code lengths; null = over-subscribed or (unless allowed) incomplete
function huff(len: number[], from: number, n: number, allowIncomplete: boolean): Huff | null {
  const count: number[] = []; for (let i = 0; i <= 15; i++) count.push(0);
  let maxL = 0;
  for (let i = 0; i < n; i++) { const l = len[from + i] ?? 0; count[l] = (count[l] ?? 0) + 1; if (l > maxL) maxL = l; }
  count[0] = 0;
  let left = 1;
  for (let l = 1; l <= 15; l++) { left = left * 2 - (count[l] ?? 0); if (left < 0) return null; }
  if (left > 0 && !allowIncomplete && maxL > 1) return null;
  const next: number[] = [0, 0]; for (let l = 1; l < 15; l++) next.push(((next[l] ?? 0) + (count[l] ?? 0)) * 2);
  const bitsN = Math.max(1, maxL); const size = 1 << bitsN;
  const t = new Int32Array(size);
  for (let i = 0; i < n; i++) {
    const l = len[from + i] ?? 0; if (!l) continue;
    const c = next[l] ?? 0; next[l] = c + 1;
    let r = 0; for (let k = 0; k < l; k++) if (c & (1 << k)) r |= 1 << (l - 1 - k); // bit-reversed: the stream sends codes MSB first into an LSB-first reader
    for (let j = r; j < size; j += 1 << l) t[j] = i * 16 + l;
  }
  return { t, bits: bitsN };
}
function sym(s: Inf, h: Huff): number {
  while (s.cnt < h.bits && s.p < s.b.length) { s.bit |= (s.b[s.p] ?? 0) << s.cnt; s.p += 1; s.cnt += 8; }
  const e = h.t[s.bit & ((1 << h.bits) - 1)] ?? 0; const l = e & 15;
  if (!l) { fail(s, "invalid Huffman code"); return -1; }
  if (l > s.cnt) { fail(s, "truncated deflate stream"); return -1; }
  s.bit = s.bit >>> l; s.cnt -= l;
  return e >> 4;
}
function room(s: Inf, k: number): boolean {
  if (s.n + k > s.max) { fail(s, "decompressed size over " + String(s.max) + " bytes"); return false; }
  if (s.n + k > s.out.length) {
    let c = s.out.length * 2; while (c < s.n + k) c *= 2; if (c > s.max) c = s.max;
    const o = new Uint8Array(c); o.set(s.out.subarray(0, s.n)); s.out = o;
  }
  return true;
}
let FIXED_L: Huff | null = null; let FIXED_D: Huff | null = null;
function fixed(): void {
  if (FIXED_L) return;
  const l: number[] = []; for (let i = 0; i < 288; i++) l.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
  FIXED_L = huff(l, 0, 288, false);
  const d: number[] = []; for (let i = 0; i < 30; i++) d.push(5);
  FIXED_D = huff(d, 0, 30, true);
}
// a bigger output buffer for n + k bytes (doubling, never past max); null = over max
function grow(o: Uint8Array, n: number, k: number, max: number): Uint8Array | null {
  if (n + k > max) return null;
  let c = o.length * 2; while (c < n + k) c *= 2; if (c > max) c = max;
  const g = new Uint8Array(c); g.set(o.subarray(0, n)); return g;
}
const LB = new Int32Array(29); const LE = new Int32Array(29); const DB = new Int32Array(30); const DE = new Int32Array(30);
for (let i = 0; i < 29; i++) { LB[i] = LBASE[i] ?? 0; LE[i] = LEXT[i] ?? 0; }
for (let i = 0; i < 30; i++) { DB[i] = DBASE[i] ?? 0; DE[i] = DEXT[i] ?? 0; }
// the hot loop: the bit buffer, positions and output in locals (written back on exit), one table lookup per symbol
function codes(s: Inf, lh: Huff, dh: Huff): void {
  const b = s.b; const bl = b.length; const lt = lh.t; const lmask = (1 << lh.bits) - 1; const dt = dh.t; const dmask = (1 << dh.bits) - 1;
  let bit = s.bit; let cnt = s.cnt; let p = s.p; let n = s.n; let o = s.out; const max = s.max;
  let err = "";
  for (;;) {
    while (cnt < 15 && p < bl) { bit = bit | ((b[p] ?? 0) << cnt); p = p + 1; cnt = cnt + 8; }
    let e = lt[bit & lmask] ?? 0; let l = e & 15;
    if (!l) { err = "invalid Huffman code"; break; }
    if (l > cnt) { err = "truncated deflate stream"; break; }
    bit = bit >>> l; cnt = cnt - l;
    const c = e >> 4;
    if (c < 256) {
      if (n >= o.length) { const g = grow(o, n, 1, max); if (!g) { err = "decompressed size over " + String(max) + " bytes"; break; } o = g; }
      o[n] = c; n = n + 1; continue;
    }
    if (c === 256) break;
    const li = c - 257; if (li >= 29) { err = "bad length code"; break; }
    let len = LB[li] ?? 0; const le = LE[li] ?? 0;
    if (le) {
      while (cnt < le && p < bl) { bit = bit | ((b[p] ?? 0) << cnt); p = p + 1; cnt = cnt + 8; }
      if (cnt < le) { err = "truncated deflate stream"; break; }
      len = len + (bit & ((1 << le) - 1)); bit = bit >>> le; cnt = cnt - le;
    }
    while (cnt < 15 && p < bl) { bit = bit | ((b[p] ?? 0) << cnt); p = p + 1; cnt = cnt + 8; }
    e = dt[bit & dmask] ?? 0; l = e & 15;
    if (!l) { err = "invalid Huffman code"; break; }
    if (l > cnt) { err = "truncated deflate stream"; break; }
    bit = bit >>> l; cnt = cnt - l;
    const di = e >> 4; if (di >= 30) { err = "bad distance code"; break; }
    let dist = DB[di] ?? 0; const de = DE[di] ?? 0;
    if (de) {
      while (cnt < de && p < bl) { bit = bit | ((b[p] ?? 0) << cnt); p = p + 1; cnt = cnt + 8; }
      if (cnt < de) { err = "truncated deflate stream"; break; }
      dist = dist + (bit & ((1 << de) - 1)); bit = bit >>> de; cnt = cnt - de;
    }
    if (dist > n) { err = "distance before the start"; break; }
    if (n + len > o.length) { const g = grow(o, n, len, max); if (!g) { err = "decompressed size over " + String(max) + " bytes"; break; } o = g; }
    const from = n - dist;
    if (dist >= len && len > 16) o.set(o.subarray(from, from + len), n);
    else for (let k = 0; k < len; k++) o[n + k] = o[from + k] ?? 0; // overlapping: byte by byte repeats the run
    n = n + len;
  }
  s.bit = bit; s.cnt = cnt; s.p = p; s.n = n; s.out = o;
  if (err) fail(s, err);
}
function dynamic(s: Inf): void {
  const nl = take(s, 5) + 257; const nd = take(s, 5) + 1; const nc = take(s, 4) + 4;
  if (s.err) return;
  if (nl > 286 || nd > 30) { fail(s, "bad code counts"); return; }
  const cl: number[] = []; for (let i = 0; i < 19; i++) cl.push(0);
  for (let i = 0; i < nc; i++) cl[ORDER[i] ?? 0] = take(s, 3);
  const ch = huff(cl, 0, 19, false); if (!ch) { fail(s, "bad code-length code"); return; }
  const len: number[] = [];
  while (len.length < nl + nd && !s.err) {
    const c = sym(s, ch); if (c < 0) return;
    if (c < 16) { len.push(c); continue; }
    let rep = 0; let v = 0;
    if (c === 16) { if (!len.length) { fail(s, "repeat with no previous length"); return; } v = len[len.length - 1] ?? 0; rep = 3 + take(s, 2); }
    else if (c === 17) rep = 3 + take(s, 3);
    else rep = 11 + take(s, 7);
    if (len.length + rep > nl + nd) { fail(s, "too many code lengths"); return; }
    for (let k = 0; k < rep; k++) len.push(v);
  }
  if (s.err) return;
  if (!(len[256] ?? 0)) { fail(s, "no end-of-block code"); return; }
  const lh = huff(len, 0, nl, false); const dh = huff(len, nl, nd, true);
  if (!lh || !dh) { fail(s, "bad Huffman lengths"); return; }
  codes(s, lh, dh);
}
// one raw deflate stream from s.p; s.p ends on the byte after it
function inflate(s: Inf): void {
  let last = 0;
  while (!last && !s.err) {
    last = take(s, 1); const type = take(s, 2);
    if (s.err) return;
    if (type === 0) {
      s.p -= s.cnt >>> 3; s.bit = 0; s.cnt = 0; // to the byte boundary: whole bytes read ahead go back, the partial one is padding
      if (s.b.length - s.p < 4) { fail(s, "truncated stored block"); return; }
      const n = (s.b[s.p] ?? 0) | ((s.b[s.p + 1] ?? 0) << 8); const nn = (s.b[s.p + 2] ?? 0) | ((s.b[s.p + 3] ?? 0) << 8);
      s.p += 4;
      if ((n ^ 0xffff) !== nn) { fail(s, "stored block length check"); return; }
      if (s.b.length - s.p < n) { fail(s, "truncated stored block"); return; }
      if (!room(s, n)) return;
      s.out.set(s.b.subarray(s.p, s.p + n), s.n); s.n += n; s.p += n;
    } else if (type === 1) { fixed(); if (FIXED_L && FIXED_D) codes(s, FIXED_L, FIXED_D); }
    else if (type === 2) dynamic(s);
    else { fail(s, "bad block type"); return; }
  }
  s.p -= s.cnt >>> 3; s.bit = 0; s.cnt = 0; // the trailer starts on the next byte: whole bytes read ahead go back
}
// the gzip trailer's ISIZE (uncompressed size mod 2^32) of the last member; -1 when too short
export function gzipIsize(b: Uint8Array): number {
  if (b.length < 18) return -1;
  const e = b.length; return (b[e - 4] ?? 0) + (b[e - 3] ?? 0) * 256 + (b[e - 2] ?? 0) * 65536 + (b[e - 1] ?? 0) * 16777216;
}
// a whole gzip body (one or more members) → its bytes, or err; never more than max bytes are produced
export function gunzipCapped(b: Uint8Array, max: number): { out: Uint8Array; err: string } {
  const s: Inf = { b, p: 0, bit: 0, cnt: 0, out: new Uint8Array(Math.min(Math.max(1024, b.length * 4), max)), n: 0, max, err: "" };
  let members = 0;
  while (s.p < b.length && !s.err) {
    if (b.length - s.p < 18) { fail(s, members ? "trailing bytes after the gzip member" : "too short for gzip"); break; }
    if (b[s.p] !== 0x1f || b[s.p + 1] !== 0x8b || b[s.p + 2] !== 8) { fail(s, "not gzip"); break; }
    const flg = b[s.p + 3] ?? 0; s.p += 10;
    if (flg & 0xe0) { fail(s, "reserved gzip flags"); break; }
    if (flg & 4) { if (b.length - s.p < 2) { fail(s, "truncated gzip header"); break; } const xl = (b[s.p] ?? 0) | ((b[s.p + 1] ?? 0) << 8); s.p += 2 + xl; }
    if (flg & 8) { while (s.p < b.length && b[s.p] !== 0) s.p++; s.p++; }
    if (flg & 16) { while (s.p < b.length && b[s.p] !== 0) s.p++; s.p++; }
    if (flg & 2) s.p += 2;
    if (s.p >= b.length) { fail(s, "truncated gzip header"); break; }
    const start = s.n;
    inflate(s);
    if (s.err) break;
    if (b.length - s.p < 8) { fail(s, "truncated gzip trailer"); break; }
    const crc = ((b[s.p] ?? 0) + (b[s.p + 1] ?? 0) * 256 + (b[s.p + 2] ?? 0) * 65536 + (b[s.p + 3] ?? 0) * 16777216);
    const isz = ((b[s.p + 4] ?? 0) + (b[s.p + 5] ?? 0) * 256 + (b[s.p + 6] ?? 0) * 65536 + (b[s.p + 7] ?? 0) * 16777216);
    s.p += 8;
    if ((crc32(s.out.subarray(start, s.n)) >>> 0) !== crc) { fail(s, "gzip CRC mismatch"); break; }
    if (((s.n - start) % 4294967296) !== isz) { fail(s, "gzip size mismatch"); break; }
    members++;
  }
  if (s.err) return { out: new Uint8Array(0), err: s.err };
  return { out: s.out.subarray(0, s.n), err: "" };
}
