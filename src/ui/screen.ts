// agentglass — frame buffer and drawing primitives: boxes, badges, graphs, modals
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { C, CSI, RST, fg, bg, heat } from "./theme.ts";
import { width, vwidth, clean, fit, fitStyled, escAt, cw } from "../util/text.ts";
import { harnessOf, isHarness } from "../harness/index.ts";

export const buf: string[] = [];
export const bufRow: number[] = []; export const bufCol: number[] = []; // each buf entry's screen cell (frame.ts writes changed rows only)
export function put(x: number, y: number, s: string): void { if (y >= 0 && y < S.H) { buf.push(CSI + (y + 1) + ";" + (x + 1) + "H" + s); bufRow.push(y); bufCol.push(x); } }
export function clearBuf(): void { buf.length = 0; bufRow.length = 0; bufCol.length = 0; }
// the frame as one string per screen row (each row's puts in order)
export function bufRows(): string[] {
  const rows: string[] = []; for (let y = 0; y < S.H; y++) rows.push("");
  for (let i = 0; i < buf.length; i++) { const y = (bufRow[i] ?? -1) + 0; if (y >= 0 && y < rows.length) rows[y] += buf[i] ?? ""; }
  return rows;
}
export function box(x: number, y: number, w: number, h: number, title: string, info: string, focus: boolean): void {
  const bc = fg(focus ? C.accent : C.line);
  let t = title ? " " + clean(title) + " " : "";
  if (width(t) > w - 4) t = fit(t, w - 4);
  const styled = info.indexOf("\x1b") >= 0; // filter chips: already styled and sized by their maker
  let i = info ? " " + (styled ? info : clean(info)) + " " : "";
  const room = w - 4 - width(t);
  if (styled) { if (vwidth(i) > room) i = room > 2 ? fitStyled(i, room) : ""; }
  else if (width(i) > room) { // the trailing " · "-parts (key hints) go first, then the head is cut
    const ps = clean(info).split(" · "); while (ps.length > 1 && width(ps.join(" · ")) + 2 > room) ps.pop();
    i = " " + ps.join(" · ") + " ";
    if (width(i) > room) i = room >= 8 ? "…" + Array.from(i).slice(-(room - 1)).join("") : ""; // "…lls" says nothing
  }
  const mid = Math.max(0, w - 3 - width(t) - (styled ? vwidth(i) : width(i)));
  put(x, y, bc + "╭─" + (focus ? CSI + "1m" + fg(C.text) : fg(C.sub)) + t + RST + bc + "─".repeat(mid) + fg(C.dim) + i + bc + "╮" + RST);
  for (let r = 1; r < h - 1; r++) { put(x, y + r, bc + "│" + RST); put(x + w - 1, y + r, bc + "│" + RST); }
  put(x, y + h - 1, bc + "╰" + "─".repeat(Math.max(0, w - 2)) + "╯" + RST);
}
// harness "logos", BADGE_W cells: an adapter's own badge, else its glyph + label in its color; other agents (process view) get ◆ + name
export const BADGE_W = 10;
export function badge(h: string): string {
  if (!isHarness(h)) return fg(C.purple) + CSI + "1m" + "◆" + RST + fg(C.purple) + " " + fit(h, BADGE_W - 2) + RST;
  const ad = harnessOf(h);
  const own = ad.badge; if (own) return own();
  const g = fit(ad.glyph, 2).trimEnd();
  return fg(ad.color()) + CSI + "1m" + g + RST + fg(ad.color()) + fit(" " + ad.label, BADGE_W - width(g)) + RST;
}
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// a spinner is drawn as this one-cell mark; the frame writer puts the current glyph there (frame.ts), so a step of the
// spinners rewrites only their cells and a frame's text does not change with the phase (main.ts compares it)
export const SPIN_MARK = "\uE000";
export function spin(): string { S.animating = true; return SPIN_MARK; } // animating: the render job keeps the spinners turning
export function spinGlyph(): string { return SPIN[S.frame % SPIN.length]; }
// the screen cells of the frame's visible spinners (a later write on the same row may cover one: a modal, an overlay)
// with the style in effect there; drawn by frame.ts
export interface SpinCell { y: number; x: number; style: string }
function spanOf(t: string, from: number): number { let w = 0; let i = from; while (i < t.length) { const e = escAt(t, i); if (e) { i += e; continue; } const c = t.codePointAt(i) ?? 0; w += cw(c); i += c > 0xffff ? 2 : 1; } return w; }
export function spinCells(): SpinCell[] {
  const out: SpinCell[] = [];
  for (let k = 0; k < buf.length; k++) {
    const t = buf[k] ?? ""; if (t.indexOf(SPIN_MARK) < 0) continue;
    const y = (bufRow[k] ?? 0) + 0; let x = (bufCol[k] ?? 0) + 0;
    let i = t.indexOf("H") + 1; let style = "";
    while (i < t.length) {
      const e = escAt(t, i);
      if (e) { const q = t.slice(i, i + e); if (q.endsWith("m")) style = q === RST || q === CSI + "m" ? "" : style + q; i += e; continue; }
      const c = t.codePointAt(i) ?? 0;
      if (t.charAt(i) === SPIN_MARK) {
        let hid = false;
        for (let j = k + 1; j < buf.length && !hid; j++) {
          if ((bufRow[j] ?? -1) + 0 !== y) continue;
          const u = buf[j] ?? ""; const x0 = (bufCol[j] ?? 0) + 0;
          if (u.indexOf(CSI + "2K") >= 0 || (x >= x0 && x < x0 + spanOf(u, u.indexOf("H") + 1))) hid = true;
        }
        if (!hid) out.push({ y, x, style });
      }
      x += cw(c); i += c > 0xffff ? 2 : 1;
    }
  }
  return out;
}
// braille area graph (btop style): values 0..max, each cell holds 2 samples × 4 levels
export function braille(vals: number[], w: number, h: number, max: number): string[] {
  const rows: string[] = [];
  const need = w * 2;
  const v = vals.slice(-need);
  while (v.length < need) v.unshift(0);
  const levels = h * 4;
  const lv = v.map((x) => (x <= 0 ? 0 : Math.max(1, Math.round((Math.min(x, max) / max) * levels))));
  const L = [0x40, 0x04, 0x02, 0x01]; const R = [0x80, 0x20, 0x10, 0x08]; // bottom→top dots
  for (let r = 0; r < h; r++) {
    const floor = (h - 1 - r) * 4;
    let line = "";
    for (let c = 0; c < w; c++) {
      let bits = 0;
      const a = lv[c * 2] - floor; const b = lv[c * 2 + 1] - floor;
      for (let k = 0; k < 4; k++) { if (a > k) bits |= L[k]; if (b > k) bits |= R[k]; }
      line += String.fromCharCode(0x2800 + bits);
    }
    rows.push(line);
  }
  return rows;
}
export function gauge(frac: number, w: number): string {
  let s = "";
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * w);
  for (let i = 0; i < w; i++) s += i < filled ? fg(heat(i / Math.max(1, w - 1))) + "■" : fg(C.line) + "■";
  return s + RST;
}
export function renderModal(title: string, body: string[], col: string): void {
  const w = Math.min(S.W - 4, Math.max(40, Math.max(...body.map((b) => width(b) + 4))));
  const h = body.length + 2;
  const x = Math.floor((S.W - w) / 2); const y = Math.floor((S.H - h) / 2);
  const bc = fg(col);
  put(x, y, bc + "╭─ " + CSI + "1m" + title + " " + RST + bc + "─".repeat(Math.max(0, w - width(title) - 5)) + "╮" + RST);
  for (let i = 0; i < body.length; i++) put(x, y + 1 + i, bc + "│" + RST + bg(C.panel) + fg(C.text) + " " + fit(body[i], w - 3) + RST + bc + "│" + RST);
  put(x, y + h - 1, bc + "╰" + "─".repeat(w - 2) + "╯" + RST);
}
// transcript/detail scrollbar in the right border
export function scrollbar(total: number, vh: number, scroll: number, maxScroll: number): void {
  if (total <= vh) return;
  const th = Math.max(1, Math.floor((vh * vh) / total));
  const ty = Math.floor((scroll / Math.max(1, maxScroll)) * (vh - th));
  for (let r = 0; r < vh; r++) put(S.W - 1, 2 + r, fg(r >= ty && r < ty + th ? C.accent : C.line) + (r >= ty && r < ty + th ? "┃" : "│") + RST);
}
