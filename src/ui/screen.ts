// agentglass — frame buffer and drawing primitives: boxes, badges, graphs, modals
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { C, CSI, RST, fg, bg, heat } from "./theme.ts";
import { width, clean, fit } from "../util/text.ts";

export const buf: string[] = [];
export function put(x: number, y: number, s: string): void { if (y >= 0 && y < S.H) buf.push(CSI + (y + 1) + ";" + (x + 1) + "H" + s); }
export function box(x: number, y: number, w: number, h: number, title: string, info: string, focus: boolean): void {
  const bc = fg(focus ? C.accent : C.line);
  let t = title ? " " + clean(title) + " " : "";
  if (width(t) > w - 4) t = fit(t, w - 4);
  let i = info ? " " + clean(info) + " " : "";
  const room = w - 4 - width(t);
  if (width(i) > room) i = room > 2 ? "…" + Array.from(i).slice(-(room - 1)).join("") : "";
  const mid = Math.max(0, w - 3 - width(t) - width(i));
  put(x, y, bc + "╭─" + (focus ? CSI + "1m" + fg(C.text) : fg(C.sub)) + t + RST + bc + "─".repeat(mid) + fg(C.dim) + i + bc + "╮" + RST);
  for (let r = 1; r < h - 1; r++) { put(x, y + r, bc + "│" + RST); put(x + w - 1, y + r, bc + "│" + RST); }
  put(x, y + h - 1, bc + "╰" + "─".repeat(Math.max(0, w - 2)) + "╯" + RST);
}
// harness "logos": Claude's terracotta spark vs. Codex's terminal prompt — distinct in shape, color and name
export const BADGE_W = 10;
export function badge(h: string): string {
  if (h === "claude") return fg(C.claude) + CSI + "1m" + "✻" + RST + fg(C.claude) + " Claude  " + RST;
  if (h === "codex") return bg("236;236;240") + fg("16;16;20") + CSI + "1m" + ">_" + RST + fg(C.text) + " Codex  " + RST;
  if (h === "fx") return fg(C.text) + CSI + "1m" + "▲" + RST + fg(C.fx) + CSI + "1m" + " 𝒇x" + RST + fg(C.fx) + "      " + RST;
  return fg(C.purple) + CSI + "1m" + "◆" + RST + fg(C.purple) + " " + fit(h, BADGE_W - 2) + RST;
}
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spin(): string { return SPIN[S.frame % SPIN.length]; }
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
