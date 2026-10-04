// agentglass — where a session's records come from: files by default (byte cursor), adapters may bring their own (OpenCode: SQLite rows by seq)
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { readBytes, readLines } from "../util/fs.ts";
import type { Sess } from "../model/types.ts";
import type { SessionSource } from "./types.ts";

export const FILE_SOURCE: SessionSource = {
  stat: (s: Sess) => { try { const st = statSync(s.path); return { size: st.size, mtime: st.mtimeMs }; } catch (e) { return null; } },
  align: (s: Sess, at: number) => {
    if (at <= 0) return 0;
    let pos = at - 1; // the byte before `at`: a newline means `at` already starts a line
    for (;;) {
      const b = readBytes(s.path, pos, 65536);
      if (!b.length) break;
      let i = 0; while (i < b.length && b[i] !== 10) i++;
      if (i < b.length) return pos + i + 1;
      pos += b.length;
    }
    try { return Math.max(at, statSync(s.path).size); } catch (e) { return at; } // no record starts before EOF
  },
  lines: (s: Sess, from: number, to: number) => {
    const r = readLines(s.path, from, to, false);
    if (r.lines.length && r.lines[r.lines.length - 1] === "") r.lines.pop(); // the split leaves "" after the final newline
    return r;
  },
  unit: 1,
};

// ── seek by time: bisect the cursor range for the first window holding timestamps ≥ t0 ──
// at = aligned cursor to read forward from (one window of margin before the probe that crossed t0: logs are not strictly
// time-ordered); reads = lines() calls; found = some timestamp was seen (else the caller reads the tail and filters).
// A probe without any timestamp goes left: re-reading is safe, skipping is not.
export interface Seek { at: number; reads: number; found: boolean }
export function seekTime(s: Sess, src: SessionSource, size: number, t0: number, win: number, tsOf: (line: string) => number): Seek {
  let lo = 0; let hi = size; let reads = 0; let found = false;
  const probe = (from: number): number => { // first timestamp in up to 4 windows from `from`, 0 none
    let p = from;
    for (let k = 0; k < 4 && p < size; k++) {
      const r = src.lines(s, p, Math.min(size, p + win)); reads++;
      for (const l of r.lines) { const t = tsOf(l); if (t > 0) return t; }
      if (r.next <= p) break; // one record longer than a window: give up on this probe
      p = r.next;
    }
    return 0;
  };
  while (hi - lo > win) {
    const mid = src.align(s, lo + Math.floor((hi - lo) / 2));
    if (mid >= hi) break;
    const t = probe(mid);
    if (t > 0) found = true;
    if (t === 0 || t >= t0) hi = mid; else lo = mid;
  }
  if (!found && probe(0) > 0) found = true; // every probe missed (or none ran): timestamps may still sit at the start
  return { at: src.align(s, Math.max(0, lo - win)), reads, found };
}
