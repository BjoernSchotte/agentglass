// agentglass — random bytes from /dev/urandom (tokens, generation ids: never Math.random), hex, base64url and a
// constant-time string compare
// SPDX-License-Identifier: Apache-2.0
import { openSync, readSync, closeSync } from "node:fs";

export const RAND = { dev: "/dev/urandom" }; // checks point it at a short file to see the refusal
// n bytes; throws when the device cannot be read in full (callers refuse to create a token then)
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n); let got = 0;
  const fd = openSync(RAND.dev, "r");
  try { while (got < n) { const r = readSync(fd, b, got, n - got, null); if (r <= 0) break; got += r; } } finally { closeSync(fd); }
  if (got < n) throw new Error("short read from " + RAND.dev + " (" + String(got) + " of " + String(n) + " bytes)");
  return b;
}
const HEX = "0123456789abcdef";
export function hex(b: Uint8Array): string { let s = ""; for (let i = 0; i < b.length; i++) { const v = b[i] ?? 0; s += HEX[v >>> 4] + HEX[v & 15]; } return s; }
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// RFC 4648 §5 without padding (32 bytes → 43 characters)
export function b64url(b: Uint8Array): string {
  let s = ""; let i = 0;
  for (; i + 2 < b.length; i += 3) { const v = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0); s += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63] + B64[v & 63]; }
  const r = b.length - i;
  if (r === 1) { const v = (b[i] ?? 0) << 16; s += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63]; }
  else if (r === 2) { const v = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8); s += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63]; }
  return s;
}
// hex → bytes; null for an odd length or a non-hex character
export function unhex(s: string): Uint8Array | null {
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(s)) return null;
  const b = new Uint8Array(s.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return b;
}
// base64url without padding → bytes; null for a character outside the alphabet or a length no encoding produces
export function unb64url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const b = new Uint8Array(Math.floor(s.length * 3 / 4)); let acc = 0; let bits = 0; let k = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s.charAt(i)); if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff; bits += 6;
    if (bits >= 8) { bits -= 8; b[k] = (acc >>> bits) & 255; k++; }
  }
  return b;
}
// equal strings in time that depends only on the length (token hashes: always 64 hex characters)
export function ctEq(a: string, b: string): boolean {
  let d = a.length ^ b.length; const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  return d === 0;
}
