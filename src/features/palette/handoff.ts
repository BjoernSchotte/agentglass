// agentglass — single instance, the transport-free core: one request "open <ref>\n" (≤ 1024 bytes, UTF-8, no control
// characters), re-parsed with the strict grammar here, never trusted from the client; ≤ 10 applied links a minute
// SPDX-License-Identifier: Apache-2.0
import { parseRef } from "./ref.ts";

export const MAX_REQ = 1024;
// a strict UTF-8 check (overlongs, surrogates and truncated sequences refused)
function utf8(b: Uint8Array): boolean {
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    const n = c < 0x80 ? 0 : c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    if (n < 0 || i + n >= b.length + (n ? 0 : 1)) return false;
    for (let k = 1; k <= n; k++) if ((b[i + k] & 0xc0) !== 0x80) return false;
    if (n === 2 && ((c === 0xe0 && b[i + 1] < 0xa0) || (c === 0xed && b[i + 1] >= 0xa0))) return false;
    if (n === 3 && ((c === 0xf0 && b[i + 1] < 0x90) || (c === 0xf4 && b[i + 1] >= 0x90))) return false;
    i += n + 1;
  }
  return true;
}
export function parseRequest(b: Uint8Array): { ref: string; err: string } {
  const no = { ref: "", err: "bad-request" };
  if (b.length < 2 || b.length > MAX_REQ || b[b.length - 1] !== 10) return no;
  for (let i = 0; i < b.length - 1; i++) if (b[i] < 0x20 || b[i] === 0x7f) return no; // the final \n is the only control byte
  if (!utf8(b)) return no;
  const t = new TextDecoder("utf-8").decode(b.subarray(0, b.length - 1));
  if (!t.startsWith("open ")) return no;
  const ref = t.slice(5);
  return parseRef(ref).ok ? { ref, err: "" } : no;
}
// applied links in the last minute
export interface Rate { at: number[] }
export function allow(r: Rate, now: number): boolean {
  r.at = r.at.filter((t: number) => now - t < 60000);
  if (r.at.length >= 10) return false;
  r.at.push(now); return true;
}
