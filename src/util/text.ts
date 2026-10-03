// agentglass — display width, truncation, wrapping and human-readable formatting
// SPDX-License-Identifier: Apache-2.0
import { HOME } from "./fs.ts";
import { RST } from "../ui/theme.ts";

export function cpOf(ch: string): number {
  const a = ch.charCodeAt(0);
  if (a >= 0xd800 && a <= 0xdbff && ch.length > 1) return (a - 0xd800) * 0x400 + (ch.charCodeAt(1) - 0xdc00) + 0x10000;
  return a;
}
export function cw(c: number): number {
  if (c < 32 || (c >= 0x7f && c < 0xa0) || (c >= 0x300 && c < 0x370) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)) return 2;
  return 1;
}
export function width(s: string): number { let w = 0; for (const ch of s) w += cw(cpOf(ch)); return w; }
export function clean(s: string): string { return s.replace(/\t/g, "  ").replace(/[\u0000-\u001f\u007f]/g, " "); }
// truncate to w columns (with …) and pad with spaces to exactly w
export function fit(s: string, w: number): string {
  if (w <= 0) return "";
  let out = ""; let n = 0;
  const full = width(s) <= w;
  for (const ch of s) {
    const c = cw(cpOf(ch));
    if (!full && n + c > w - 1) { out += "…"; n += 1; break; }
    out += ch; n += c;
  }
  return n < w ? out + " ".repeat(w - n) : out;
}
export function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    const l = clean(raw).replace(/\s+$/, ""); // trailing padding would wrap into blank rows
    if (l.length === 0) { out.push(""); continue; }
    let cur = ""; let n = 0;
    for (const ch of l) {
      const c = cw(cpOf(ch));
      if (n + c > w) { out.push(cur); cur = ""; n = 0; }
      cur += ch; n += c;
    }
    out.push(cur);
  }
  return out;
}
// escape sequences that take no columns: CSI, and OSC 8 hyperlinks (terminated by ST or BEL); ESC_HEAD for scanners
export const ESC_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const ESC_HEAD = /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/;
const LINK_END = "\x1b]8;;\x1b\\";
// truncate a styled line to w visible columns (keeps escapes); a cut inside a hyperlink closes it, so it cannot spill
export function fitStyled(s: string, w: number): string {
  let out = ""; let n = 0; let i = 0; let inLink = false;
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {
      const m = ESC_HEAD.exec(s.slice(i, i + 2100)); // a link's url is ≤ 2 KB
      if (m) { const e = m[0]; if (e.startsWith("\x1b]8;")) inLink = !/^\x1b\]8;[^;\x07\x1b]*;(?:\x07|\x1b\\)$/.test(e); out += e; i += e.length; continue; }
    }
    const a = s.charCodeAt(i);
    const ch = a >= 0xd800 && a <= 0xdbff ? s.slice(i, i + 2) : s.slice(i, i + 1);
    const c = cw(cpOf(ch));
    if (n + c > w) break;
    out += ch; n += c; i += ch.length;
  }
  return out + (inLink ? LINK_END : "") + RST;
}
// the visible width of a styled string (escape sequences take no columns)
export function vwidth(styled: string): number { return width(styled.replace(ESC_RE, "")); }
// pad a styled line (already ≤ w visible) to width w using its visible width
export function fillTo(styled: string, w: number): string {
  const n = vwidth(styled);
  return n < w ? " ".repeat(w - n) : "";
}
export function firstLine(s: string, n: number): string {
  const t = s.trim(); const i = t.indexOf("\n");
  const f = i >= 0 ? t.slice(0, i) : t;
  return f.length > n ? f.slice(0, n) + "…" : f;
}
export function localHM(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours(); const m = d.getMinutes();
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}
export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
export function bytes(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1048576) return (n / 1024).toFixed(0) + "K";
  if (n < 1073741824) return (n / 1048576).toFixed(n < 104857600 ? 1 : 0) + "M";
  return (n / 1073741824).toFixed(1) + "G";
}
export function home(p: string): string { return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p; }
// ponytail: slice+for-of read — in scriptc a number read via a[i] (or a[i] ?? d) cannot index another array afterwards
export function numAt(a: number[], i: number, d: number): number {
  let v = d;
  if (i >= 0 && i < a.length) for (const x of a.slice(i, i + 1)) v = x;
  return v;
}
