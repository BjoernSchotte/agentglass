// agentglass — JSON-lines framing over a byte stream: split on 0x0A and decode whole lines only (a UTF-8 character split
// across reads stays intact); lines over MAX_LINE are dropped and reported. Shared by agentglass-mcp and serve --stdio.
// SPDX-License-Identifier: Apache-2.0
// Imports nothing: agentglass-mcp's idle memory is its module init.

export const MAX_LINE = 4 * 1024 * 1024;
// parts: the pending line's chunks (no newline in them); plen their bytes; skipping: an oversize line is being dropped
export interface Framer { parts: Uint8Array[]; plen: number; skipping: boolean }
export function newFramer(): Framer { return { parts: [], plen: 0, skipping: false }; }
export interface Frame { line: string; oversize: boolean } // oversize: a dropped line (→ -32600, id null)
function joined(f: Framer, tail: Uint8Array): Uint8Array {
  if (!f.parts.length) return tail;
  const b = new Uint8Array(f.plen + tail.length); let at = 0;
  for (let i = 0; i < f.parts.length; i++) { const p = f.parts[i] as Uint8Array; b.set(p, at); at += p.length; }
  b.set(tail, at);
  return b;
}
// one complete line (without its "\n"): CRLF tolerated, blank lines skipped, over MAX_LINE dropped
function emit(out: Frame[], b: Uint8Array): void {
  let n = b.length; if (n > 0 && b[n - 1] === 13) n--;
  if (n > MAX_LINE) { out.push({ line: "", oversize: true }); return; }
  let blank = true; for (let i = 0; i < n && blank; i++) { const c = b[i] ?? 0; if (c !== 32 && c !== 9 && c !== 13) blank = false; }
  if (!blank) out.push({ line: new TextDecoder("utf-8").decode(b.subarray(0, n)), oversize: false });
}
export function push(f: Framer, d: Uint8Array): Frame[] {
  const out: Frame[] = [];
  let from = 0;
  while (from < d.length) {
    let nl = from; while (nl < d.length && d[nl] !== 10) nl++;
    if (nl === d.length) nl = -1;
    if (nl < 0) { // no line end in this chunk: keep it (+1: room for a final "\r"), or start/keep dropping it
      const rest = d.subarray(from);
      if (!f.skipping && f.plen + rest.length > MAX_LINE + 1) { f.skipping = true; f.parts = []; f.plen = 0; }
      if (!f.skipping) { f.parts.push(rest.slice()); f.plen += rest.length; } // slice: the caller may reuse its buffer
      break;
    }
    if (f.skipping) out.push({ line: "", oversize: true });
    else emit(out, joined(f, d.subarray(from, nl)));
    f.parts = []; f.plen = 0; f.skipping = false; from = nl + 1;
  }
  return out;
}
