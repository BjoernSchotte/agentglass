// agentglass — frame diff: a built frame is written row by row, only the rows that differ from the last frame written;
// spinners (screen.ts SPIN_MARK) are written as their own cells, so turning them rewrites only those cells
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { CSI, RST } from "./theme.ts";
import { type SpinCell, SPIN_MARK } from "./screen.ts";

// the rows on screen as last written (with the spinner mark, not a glyph); whole = the next frame is written in full
// (start, resetFrame, a partial write of unknown rows); cells/glyph = the spinners on screen and the glyph they show
const F = { last: [] as string[], whole: true, cells: [] as SpinCell[], glyph: "" };
function sync(o: string): string { return "\x1b[?2026h" + o + "\x1b[?2026l"; } // one synchronized update: no tearing
function shown(r: string, glyph: string): string { return r.indexOf(SPIN_MARK) < 0 ? r : r.split(SPIN_MARK).join(glyph); }
function cellsOut(cells: SpinCell[], glyph: string, skip: boolean[]): string {
  let o = ""; for (const c of cells) if (!(skip[c.y] ?? false)) o += CSI + String(c.y + 1) + ";" + String(c.x + 1) + "H" + RST + c.style + glyph + RST;
  return o;
}
// rows = one string per screen row (its puts in order, each with its own cursor address). Writes the rows that changed
// (all after resetFrame, S.repaint — screen cleared, e.g. resize — or another row count), then the spinner cells of the
// other rows when the glyph moved; returns how many rows
export function flushRows(rows: string[], out: (s: string) => void, cells: SpinCell[] = [], glyph: string = ""): number {
  const all = F.whole || S.repaint || rows.length !== F.last.length;
  let o = ""; let n = 0; const wrote: boolean[] = [];
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y] ?? "";
    const w = all || r !== (F.last[y] ?? "");
    wrote.push(w);
    if (w) { o += CSI + String(y + 1) + ";1H" + shown(r, glyph); n++; }
  }
  if (glyph !== F.glyph) o += cellsOut(cells, glyph, wrote);
  if (o) out(sync(o));
  F.last = rows.slice(); F.whole = false; S.repaint = false; F.cells = cells; F.glyph = glyph;
  return n;
}
// a step of the spinners on the last frame: their cells with the new glyph (nothing when the screen is unknown)
export function flushSpin(glyph: string, out: (s: string) => void): number {
  if (F.whole || !F.cells.length || glyph === F.glyph) return 0;
  out(sync(cellsOut(F.cells, glyph, []))); F.glyph = glyph;
  return F.cells.length;
}
// a write of some rows only (the header row on a marquee step): rows holds "" for the rows it leaves alone
export function flushPart(rows: string[], out: (s: string) => void): number {
  if (F.whole || rows.length !== F.last.length) { F.whole = true; let o = ""; for (const r of rows) o += shown(r, F.glyph); if (o) out(sync(o)); return o ? 1 : 0; } // unknown screen: the next full frame writes all
  let o = ""; let n = 0;
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y] ?? "";
    if (r && r !== F.last[y]) { o += CSI + String(y + 1) + ";1H" + shown(r, F.glyph); F.last[y] = r; n++; }
  }
  if (n) out(sync(o));
  return n;
}
// forget the last frame (focus-in: the terminal may have dropped what it showed)
export function resetFrame(): void { F.whole = true; }
