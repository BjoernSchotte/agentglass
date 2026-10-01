// agentglass — live transcript view: event rendering, incremental tail, event cursor
// SPDX-License-Identifier: Apache-2.0
import { width, clean, fit, wrap, fitStyled, fillTo, localHM, bytes, home, numAt } from "../util/text.ts";
import type { Ev, Sess } from "../model/types.ts";
import { S, say, type TV } from "../state.ts";
import { enrich } from "../hooks.ts";
import { parseEvents, sourceOf, window, epochOf } from "../harness/index.ts";
import { titleOf, parentOf, subActive, activeSubs, restat } from "../model/sessions.ts";
import { C, CSI, RST, fg, bg } from "./theme.ts";
import { put, box, spin, scrollbar } from "./screen.ts";

export function evLines(e: Ev, w: number, expand: boolean, out: string[]): void {
  const tsx = e.ts.length >= 16 ? localHM(e.ts) : "";
  if (e.kind === "user") {
    out.push("");
    const ls = wrap(e.text, w - 2);
    for (let i = 0; i < ls.length; i++) out.push((i === 0 ? fg(C.cyan) + CSI + "1m" + "❯ " : "  ") + RST + bg(C.sel) + fg(C.text) + fit(ls[i], w - 8) + RST + (i === 0 ? fg(C.dim) + " " + fit(tsx, 5) + RST : ""));
  } else if (e.kind === "assistant") {
    const ls = wrap(e.text, w - 2);
    for (let i = 0; i < ls.length; i++) out.push((i === 0 ? fg(C.text) + "⏺ " : "  ") + RST + fg(C.text) + ls[i] + RST);
  } else if (e.kind === "thinking") {
    const ls = wrap(e.text, w - 2);
    const n = expand ? ls.length : Math.min(2, ls.length);
    for (let i = 0; i < n; i++) out.push(fg(C.dim) + CSI + "3m" + (i === 0 ? "∴ " : "  ") + ls[i] + RST);
    if (n < ls.length) out.push(fg(C.dim) + "  … " + (ls.length - n) + " more lines" + RST);
  } else if (e.kind === "tool") {
    const i = e.text.indexOf("\u0000");
    const name = e.text.slice(0, i);
    const ls = wrap(e.text.slice(i + 1), w - 4 - width(name));
    const n = expand ? ls.length : Math.min(3, ls.length);
    for (let j = 0; j < n; j++) out.push((j === 0 ? fg(C.yellow) + "⚒ " + CSI + "1m" + name + RST + fg(C.sub) + "(" : " ".repeat(width(name) + 3) + fg(C.sub)) + ls[j] + (j === n - 1 ? (n < ls.length ? " …" : ")") : "") + RST);
  } else if (e.kind === "result") {
    const ls = wrap(e.text.length > 20000 ? e.text.slice(0, 20000) : e.text, w - 4);
    const n = expand ? ls.length : Math.min(3, ls.length);
    for (let j = 0; j < n; j++) out.push(fg(C.line) + (j === 0 ? "  ⎿ " : "    ") + fg(C.dim) + ls[j] + RST);
    if (n < ls.length) out.push(fg(C.dim) + "    … +" + (ls.length - n) + " lines (t to expand)" + RST);
  } else {
    out.push(fg(C.line) + "── " + fg(C.purple) + clean(e.text) + fg(C.line) + " " + "─".repeat(Math.max(0, w - width(e.text) - 5)) + RST);
  }
}
// events laid out: all, or the first t.limit (replay)
export function shown(t: TV): number { return t.limit < 0 ? t.evs.length : Math.min(t.limit, t.evs.length); }
export function renderTranscript(): void {
  const t = S.tv;
  if (!t) return;
  const s = t.s;
  enrich(s);
  // incremental read
  const src = sourceOf(s.h);
  const st = src.stat(s); if (st) restat(s, st.size, st.mtime, epochOf(s)); // else gone
  if (s.ep !== t.ep) tvStart(t); // the source switched transport: its cursor means something else now
  if (s.size > t.off) {
    const r = src.lines(s, t.off, Math.min(s.size, t.off + window(src, 16777216)));
    for (const l of r.lines) parseEvents(s.h, l, t.evs, s);
    t.off = r.next;
  }
  const W = S.W; const H = S.H;
  const iw = W - 4;
  const n = shown(t);
  if (t.lw !== iw || t.ln !== n || t.lexp !== t.expand) {
    const out: string[] = []; const le: number[] = []; const ls: number[] = [];
    for (let i = 0; i < n; i++) { ls.push(out.length); evLines(t.evs[i], iw - 1, t.expand, out); while (le.length < out.length) le.push(i); }
    t.lines = out; t.lineEv = le; t.lineStart = ls; t.lw = iw; t.ln = n; t.lexp = t.expand;
  }
  const vh = H - 4;
  const maxScroll = Math.max(0, t.lines.length - vh);
  if (t.focusTs || t.focusText) { // opened from a preview row: put the cursor on that event
    for (let i = n - 1; i >= 0; i--) {
      const e = t.evs[i];
      if (e.kind === t.focusKind && e.ts === t.focusTs && (e.text === t.focusText || (e.id !== "" && e.id === t.focusText))) { t.cur = i; t.follow = false; t.scroll = Math.max(0, numAt(t.lineStart, i, 0) - Math.floor(vh / 3)); break; }
    }
    t.focusTs = ""; t.focusText = "";
  }
  if (t.follow) { t.scroll = maxScroll; t.cur = n - 1; }
  t.scroll = Math.max(0, Math.min(t.scroll, maxScroll));
  const live = s.pid || (s.depth === 1 && subActive(s)) ? " · " + spin() + " live" : "";
  const subs = s.subs.length ? " · ⑂ " + activeSubs(s) + "/" + s.subs.length + " (n)" : "";
  const name = s.depth === 1 ? "↳ " + s.kind + (s.name ? " " + s.name : "") + ": " + titleOf(s) : titleOf(s);
  box(0, 1, W, H - 2, name, (s.depth === 1 ? "u parent · n next · " : "") + home(s.cwd) + subs + live + " · " + (t.follow ? "follow" : Math.round((t.scroll / Math.max(1, maxScroll)) * 100) + "%"), true);
  for (let r = 0; r < vh; r++) {
    const li = t.scroll + r;
    const l = li < t.lines.length ? t.lines[li] : "";
    const on = li < t.lines.length && numAt(t.lineEv, li, -1) === t.cur;
    const f = fitStyled(l, iw - 1);
    put(1, 2 + r, (on ? fg(C.accent) + "▌" + RST : " ") + f + fillTo(f, iw - 1) + "  ");
  }
  scrollbar(t.lines.length, vh, t.scroll, maxScroll);
}
export function moveCur(t: TV, d: number, vh: number): void {
  const n = shown(t);
  if (!n) return;
  t.cur = Math.max(0, Math.min(n - 1, (t.cur < 0 ? n - 1 : t.cur) + d));
  t.follow = false;
  const s0 = numAt(t.lineStart, t.cur, 0);
  const e0 = numAt(t.lineStart, t.cur + 1, t.lines.length);
  if (s0 < t.scroll) t.scroll = s0;
  else if (e0 > t.scroll + vh) t.scroll = Math.min(s0, e0 - vh);
  if (d > 0 && t.cur === n - 1) t.follow = true;
}
export function openTranscript(s: Sess): void {
  const t: TV = { s, evs: [], off: 0, ep: s.ep, scroll: 0, follow: true, expand: false, lines: [], lw: 0, ln: -1, lexp: false, cur: -1, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1 };
  tvStart(t);
  S.tv = t;
  S.mode = "transcript";
}
// (re)start reading at the last 6 MB
function tvStart(t: TV): void {
  const s = t.s; const src = sourceOf(s.h);
  const start = Math.max(0, s.size - window(src, 6291456));
  t.evs = []; t.off = start; t.ep = s.ep; t.ln = -1;
  if (start > 0) { // skip the partial first line
    t.off = src.align(s, start);
    t.evs.push({ kind: "meta", text: "showing last " + bytes((s.size - start) * src.unit) + " of " + bytes(s.size * src.unit), ts: "", id: "", full: "" });
  }
}
export function cycleSub(dir: number): void {
  const tv = S.tv;
  if (!tv) return;
  const root = tv.s.depth === 1 ? parentOf(tv.s) : tv.s;
  if (!root || !root.subs.length) { say("info", "no subagents"); return; }
  const kids = root.subs.slice().sort((a, b) => (subActive(b) ? 1 : 0) - (subActive(a) ? 1 : 0) || b.mtime - a.mtime);
  const i = kids.indexOf(tv.s);
  openTranscript(kids[(((i + dir) % kids.length) + kids.length) % kids.length]);
}
