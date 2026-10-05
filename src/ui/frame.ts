// agentglass — frame diff: a built frame is written row by row, only the rows that differ from the last frame written
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { CSI } from "./theme.ts";

// the rows on screen as last written; whole = the next frame is written in full (start, resetFrame, a partial write
// of unknown rows)
const F = { last: [] as string[], whole: true };
function sync(o: string): string { return "\x1b[?2026h" + o + "\x1b[?2026l"; } // one synchronized update: no tearing
// rows = one string per screen row (its puts in order, each with its own cursor address). Writes the rows that changed
// (all after resetFrame, S.repaint — screen cleared, e.g. resize — or another row count); returns how many
export function flushRows(rows: string[], out: (s: string) => void): number {
  const all = F.whole || S.repaint || rows.length !== F.last.length;
  let o = ""; let n = 0;
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y] ?? "";
    if (all || r !== (F.last[y] ?? "")) { o += CSI + String(y + 1) + ";1H" + r; n++; }
  }
  if (n) out(sync(o));
  F.last = rows.slice(); F.whole = false; S.repaint = false;
  return n;
}
// a write of some rows only (the header row on a marquee step): rows holds "" for the rows it leaves alone
export function flushPart(rows: string[], out: (s: string) => void): number {
  if (F.whole || rows.length !== F.last.length) { F.whole = true; let o = ""; for (const r of rows) o += r; if (o) out(sync(o)); return o ? 1 : 0; } // unknown screen: the next full frame writes all
  let o = ""; let n = 0;
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y] ?? "";
    if (r && r !== F.last[y]) { o += CSI + String(y + 1) + ";1H" + r; F.last[y] = r; n++; }
  }
  if (n) out(sync(o));
  return n;
}
// forget the last frame (focus-in: the terminal may have dropped what it showed)
export function resetFrame(): void { F.whole = true; }
