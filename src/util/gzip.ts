// agentglass — gzip in pure TS for OTLP request bodies: DEFLATE (RFC 1951) with LZ77 and fixed Huffman codes, in the
// gzip container (RFC 1952). No dynamic tables: OTLP/JSON repeats keys and ids so much that fixed codes get most of the gain.
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, unlinkSync, chmodSync } from "node:fs";
import { readBytes } from "./fs.ts";
import { numAt } from "./text.ts";

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1; CRC[n] = c >>> 0; }
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = (CRC[(c ^ b[i]) & 255] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// fixed Huffman literal/length codes (RFC 1951 3.2.6), stored bit-reversed (the bit writer is LSB-first)
function rev(v: number, n: number): number { let r = 0; for (let i = 0; i < n; i++) { r = (r << 1) | (v & 1); v = v >>> 1; } return r; }
const LCODE = new Uint32Array(288); const LBITS = new Uint8Array(288);
for (let s = 0; s < 288; s++) {
  const c = s < 144 ? [0x30 + s, 8] : s < 256 ? [0x190 + s - 144, 9] : s < 280 ? [s - 256, 7] : [0xc0 + s - 280, 8];
  LCODE[s] = rev(c[0] ?? 0, c[1] ?? 0); LBITS[s] = c[1] ?? 0;
}
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LSYM = new Uint8Array(259); // match length → code index 0..28
function fill(t: Uint8Array, base: number[], ext: number[], max: number): void {
  for (let c = 0; c < base.length; c++) { const lo = numAt(base, c, 0); const hi = Math.min(max, c === 28 && max === 258 ? 258 : lo + (1 << numAt(ext, c, 0)) - 1); let v = lo; while (v <= hi) { t[v] = c; v = v + 1; } }
}
fill(LSYM, LBASE, LEXT, 258);
const DSYM = new Uint8Array(32769); // distance → code 0..29
fill(DSYM, DBASE, DEXT, 32768);
const DREV = new Uint8Array(30); for (let c = 0; c < 30; c++) DREV[c] = rev(c, 5);

const WSIZE = 32768; const WMASK = WSIZE - 1; const HBITS = 15; const HSIZE = 1 << HBITS; const CHAIN = 32; const MAXM = 258;
export function deflateRaw(b: Uint8Array): Uint8Array {
  const n = b.length;
  const out = new Uint8Array(n + (n >>> 3) + 64); // fixed codes: at most 9 bits per byte
  let op = 0; let bb = 0; let bc = 0;
  const put = (v: number, k: number): void => { bb = (bb | (v << bc)) >>> 0; bc += k; while (bc >= 8) { out[op++] = bb & 255; bb = bb >>> 8; bc -= 8; } };
  put(1, 1); put(1, 2); // BFINAL, BTYPE 01 (fixed Huffman)
  const head = new Int32Array(HSIZE).fill(-1); const prev = new Int32Array(WSIZE);
  let i = 0;
  while (i < n) {
    let best = 0; let dist = 0;
    if (i + 2 < n) {
      const h = Math.imul((b[i] << 16) | (b[i + 1] << 8) | b[i + 2], 0x9e3779b1) >>> (32 - HBITS);
      let c = head[h]; let chain = CHAIN; const lim = Math.min(MAXM, n - i);
      while (c >= 0 && i - c <= WSIZE && chain-- > 0) {
        if (b[c + best] === b[i + best] && b[c] === b[i]) {
          let l = 0; while (l < lim && b[c + l] === b[i + l]) l++;
          if (l > best) { best = l; dist = i - c; if (l >= lim) break; }
        }
        const p = prev[c & WMASK]; if (p >= c) break; c = p;
      }
      prev[i & WMASK] = head[h]; head[h] = i;
    }
    if (best >= 3) {
      const ls = LSYM[best]; const s = 257 + ls;
      put(LCODE[s], LBITS[s]); const le = LEXT[ls] ?? 0; if (le) put(best - (LBASE[ls] ?? 0), le);
      const ds = DSYM[dist]; put(DREV[ds], 5); const de = DEXT[ds] ?? 0; if (de) put(dist - (DBASE[ds] ?? 0), de);
      for (let k = 1; k < best; k++) { // index the skipped positions too (no lazy matching)
        const j = i + k; if (j + 2 >= n) break;
        const h = Math.imul((b[j] << 16) | (b[j + 1] << 8) | b[j + 2], 0x9e3779b1) >>> (32 - HBITS);
        prev[j & WMASK] = head[h]; head[h] = j;
      }
      i += best;
    } else { put(LCODE[b[i]], LBITS[b[i]]); i++; }
  }
  put(LCODE[256], LBITS[256]); // end of block
  if (bc > 0) out[op++] = bb & 255;
  return out.slice(0, op);
}
export function gzip(b: Uint8Array): Uint8Array {
  const d = deflateRaw(b); const n = b.length; const c = crc32(b);
  const out = new Uint8Array(d.length + 18);
  out[0] = 0x1f; out[1] = 0x8b; out[2] = 8; out[9] = 255; // deflate, no name, mtime 0, os unknown
  out.set(d, 10);
  const t = 10 + d.length;
  out[t] = c & 255; out[t + 1] = (c >>> 8) & 255; out[t + 2] = (c >>> 16) & 255; out[t + 3] = (c >>> 24) & 255;
  out[t + 4] = n & 255; out[t + 5] = (n >>> 8) & 255; out[t + 6] = (n >>> 16) & 255; out[t + 7] = (n >>> 24) & 255;
  return out;
}
// bytes to a new 0600 file; false when the write failed
export function writeBin(path: string, b: Uint8Array): boolean {
  try {
    try { unlinkSync(path); } catch (e) { /* none */ }
    const fd = openSync(path, "w"); chmodSync(path, 0o600); // before any byte is written
    try { writeSync(fd, b); } finally { closeSync(fd); }
    return true;
  } catch (e) { return false; }
}
// once per run: can this runtime put compressed bytes into a file unchanged? (else the export sends plain JSON)
export function gzipProbe(dir: string): boolean {
  const parts: string[] = []; for (let i = 0; i < 64; i++) parts.push("{\"k\":\"agentglass\",\"i\":" + String(i * 37) + "}");
  const z = gzip(new TextEncoder().encode(parts.join(",")));
  const p = dir + "/gzip-probe-" + String(process.pid) + ".bin";
  if (!writeBin(p, z)) return false;
  const back = readBytes(p, 0, z.length + 16);
  try { unlinkSync(p); } catch (e) { /* gone */ }
  if (back.length !== z.length) return false;
  for (let i = 0; i < z.length; i++) if (back[i] !== z[i]) return false;
  return true;
}
