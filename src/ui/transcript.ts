// agentglass — live transcript view: event rendering, incremental tail, event cursor
// SPDX-License-Identifier: Apache-2.0
import { width, clean, fit, wrap, fitStyled, fillTo, localHM, bytes, home, numAt } from "../util/text.ts";
import type { Ev, Sess } from "../model/types.ts";
import { S, say, type TV } from "../state.ts";
import { remoteOnly } from "../model/remote.ts";
import { H, enrich } from "../hooks.ts";
import { parseEvents, sourceOf, window, epochOf } from "../harness/index.ts";
import { titleOf, parentOf, subActive, activeSubs, restat } from "../model/sessions.ts";
import { C, CSI, RST, fg, bg } from "./theme.ts";
import { put, box, spin, scrollbar } from "./screen.ts";
import { link, hyperOn, sessUrl } from "../util/hyper.ts";
import { type Mark, marksOf, markKind } from "../model/marks.ts";
import { kindsIn, kindIds, kindVer, markAt } from "../model/kinds.ts";
import { setCount, mask as vfMask, fstate, active as vfActive, runs as vfRuns, gapText, matchCount, emptyText as vfEmpty, barOpen, chipBar } from "./evfilter.ts";

const VIEW = "transcript";
setCount(VIEW, (): string => { const t = S.tv; if (!t) return ""; const c = matchCount(VIEW, t.s, t.evs); return String(c.shown) + " of " + String(c.total); });

export function evLines(e: Ev, w: number, expand: boolean, out: string[]): void {
  const tsx = e.ts.length >= 16 ? localHM(e.ts) : "";
  if (e.kind === "user") {
    out.push("");
    const ls = wrap(e.text, w - 8, true); // every line as wide as the first, which leaves room for the time
    for (let i = 0; i < ls.length; i++) out.push((i === 0 ? fg(C.cyan) + CSI + "1m" + "❯ " : "  ") + RST + bg(C.sel) + fg(C.text) + fit(ls[i], w - 8) + RST + (i === 0 ? fg(C.dim) + " " + fit(tsx, 5) + RST : ""));
  } else if (e.kind === "assistant") {
    const ls = wrap(e.text, w - 2, true);
    for (let i = 0; i < ls.length; i++) out.push((i === 0 ? fg(C.text) + "⏺ " : "  ") + RST + fg(C.text) + ls[i] + RST);
  } else if (e.kind === "thinking") {
    const ls = wrap(e.text, w - 2, true);
    const n = expand ? ls.length : Math.min(2, ls.length);
    for (let i = 0; i < n; i++) out.push(fg(C.dim) + CSI + "3m" + (i === 0 ? "∴ " : "  ") + ls[i] + RST);
    if (n < ls.length) out.push(fg(C.dim) + "  … " + (ls.length - n) + " more lines" + RST);
  } else if (e.kind === "tool") {
    const i = e.text.indexOf("\u0000");
    const name = e.text.slice(0, i);
    const ls = wrap(e.text.slice(i + 1), w - 5 - width(name)); // "⚒ name(" + the line + ")" or " …"
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
// marks (skill loads, debug episodes …) on the transcript's own events: per event index the marks that land there (the
// call they anchor on, else the first event at or after their time; evs.length = after the last), rebuilt when the
// marks or the events changed; ver counts rebuilds (the layout keys on it)
const MK = { evs: null as Ev[] | null, n: -1, marks: null as Mark[] | null, at: new Map<number, Mark[]>(), ver: 0 };
function marksAt(t: TV): Map<number, Mark[]> {
  const ms = marksOf(t.s, null);
  if (MK.evs === t.evs && MK.n === t.evs.length && MK.marks === ms) return MK.at;
  const at = new Map<number, Mark[]>();
  for (const m of ms) { const j = markAt(t.s, t.evs, m); if (j < 0) continue; const l = at.get(j); if (l) l.push(m); else at.set(j, [m]); }
  MK.evs = t.evs; MK.n = t.evs.length; MK.marks = ms; MK.at = at; MK.ver++;
  return at;
}
// points of one kind and sub at one event become one line naming each label (×n): a compaction that ends four loads reads
// "✧ alpha, beta ×2, delta out (compacted)"
function merged(ms: Mark[]): Mark[] {
  if (ms.length < 2) return ms;
  const o: Mark[] = []; const n: number[] = [];
  for (const m of ms) {
    let k = -1; if (m.t1 === m.t0) for (let j = 0; j < o.length; j++) { const x = o[j]; if (x && x.t1 === x.t0 && x.kind === m.kind && x.sub === m.sub) { k = j; break; } }
    if (k < 0) { o.push({ kind: m.kind, t0: m.t0, t1: m.t1, seq: m.seq, turn: m.turn, ev: m.ev, anchor: m.anchor, label: m.label, sub: m.sub, tok: m.tok, usd: m.usd, est: m.est, ref: m.ref }); n.push(1); continue; }
    const x = o[k]; if (!x) continue;
    const parts = x.label.split(", "); let hit = -1; for (let j = 0; j < parts.length; j++) if ((parts[j] ?? "").replace(/ ×\d+$/, "") === m.label) hit = j;
    if (hit < 0) parts.push(m.label); else { const p = parts[hit] ?? ""; const c = /×(\d+)$/.exec(p); parts[hit] = m.label + " ×" + String(c ? Number(c[1] ?? "1") + 1 : 2); }
    x.label = parts.join(", "); n[k] = (n[k] ?? 1) + 1;
  }
  return o;
}
// a mark's line: a feature's own (H.markLines), else the family's glyph, the label and its kind
export function markLine(s: Sess, m: Mark, w: number): string {
  for (const f of H.markLines) { const l = f(s, m, w); if (l) return l; }
  const k = markKind(m.kind.split(":")[0] ?? ""); const col = k ? k.color() : C.purple;
  return fitStyled(fg(col) + (k ? k.glyph : "◆") + " " + clean(m.label) + RST + fg(C.dim) + " · " + m.kind + (m.sub ? " · " + m.sub : "") + RST, w);
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
  layout(t, iw, n);
  const bar = barOpen(VIEW);
  const vh = H - 4 - (bar ? 1 : 0); // the chip bar takes the last row
  const maxScroll = Math.max(0, t.lines.length - vh);
  if (t.focusTs || t.focusText) { // opened from a preview row: put the cursor on that event
    for (let i = n - 1; i >= 0; i--) {
      const e = t.evs[i];
      if (e.kind === t.focusKind && (e.ts === t.focusTs || (t.focusTs === "" && e.id !== "")) && (e.text === t.focusText || (e.id !== "" && e.id === t.focusText))) {
        if (expandAt(t, i)) layout(t, iw, n); // the event the link or row named is shown, whatever the filter hides
        t.cur = i; t.follow = false; t.scroll = Math.max(0, numAt(t.lineStart, i, 0) - Math.floor(vh / 3)); break;
      }
    }
    t.focusTs = ""; t.focusText = "";
  }
  if (t.follow) { t.scroll = maxScroll; t.cur = t.items.length ? numAt(t.items, t.items.length - 1, n - 1) : n - 1; }
  else if (t.items.length && t.cur >= 0) t.cur = stopOf(t, t.cur); // a hidden event's stop is its gap line
  t.scroll = Math.max(0, Math.min(t.scroll, maxScroll));
  const live = s.pid || (s.depth === 1 && subActive(s)) ? " · " + spin() + " live" : "";
  const subs = s.subs.length ? " · ⑂ " + activeSubs(s) + "/" + s.subs.length + " (n)" : "";
  const name = s.depth === 1 ? "↳ " + s.kind + (s.name ? " " + s.name : "") + ": " + titleOf(s) : titleOf(s);
  const mc = vfActive(VIEW) ? matchCount(VIEW, s, t.evs) : null;
  const partial = t.evs.length > 0 && t.evs[0].kind === "meta" && t.evs[0].text.startsWith("showing "); // the tail (or a link's window) of a longer log
  const cnt = mc ? String(mc.shown) + " of " + (partial ? "≥" : "") + String(Math.max(0, mc.total - (partial ? 1 : 0))) + " events" : "";
  const info = (cnt ? cnt + " · " : "") +
    (s.depth === 1 ? "u parent · n next · " : "") + home(s.cwd) + subs + live + " · " + (t.follow ? "follow" : Math.round((t.scroll / Math.max(1, maxScroll)) * 100) + "%");
  // a long title leaves the header no room: with a filter on, the match count keeps its place (the title is cut first)
  const room = W - 4 - width(cnt) - 4;
  const title = cnt && width(name) + 2 > room ? fit(name, Math.max(8, room - 2)) : name;
  // OSC 8 terminals: the short id links to the session (Y copies the event's link); styled info is cut by box()
  box(0, 1, W, H - 2, title, hyperOn() ? clean(info) + " · " + fg(C.dim) + link(sessUrl(s.h, s.id), s.id.slice(0, 8)) + RST : info, true);
  const empty = mc !== null && mc.shown === 0 && !t.xr.length ? fg(C.dim) + vfEmpty(VIEW) + RST : "";
  for (let r = 0; r < vh; r++) {
    const li = t.scroll + r - (empty ? 1 : 0);
    const l = r === 0 && empty ? empty : li >= 0 && li < t.lines.length ? t.lines[li] : "";
    const on = li >= 0 && li < t.lines.length && numAt(t.lineEv, li, -1) === t.cur && !(r === 0 && empty);
    const f = fitStyled(l, iw - 1);
    put(1, 2 + r, (on ? fg(C.accent) + "▌" + RST : " ") + f + fillTo(f, iw - 1) + "  ");
  }
  if (bar) { const b = fitStyled(chipBar(VIEW, kindsIn(s, t.evs), iw - 1), iw - 1); put(1, 2 + vh, " " + bg(C.sel) + b + fillTo(b, iw - 1) + RST + "  "); }
  scrollbar(t.lines.length, vh, t.scroll, maxScroll);
}
// the lines of the first n events at width iw: every event, or (a kind filter on) the shown ones and one dim gap line per
// run of hidden events (cursor stops: t.items); laid out again when the width, count, expansion or filter changed
export function layout(t: TV, iw: number, n: number): void {
  const act = vfActive(VIEW);
  const st = act ? fstate(VIEW) : "";
  if ((t.fk.split("\u0001")[0] ?? "") !== st) t.xr = []; // another filter: the runs ↵ opened close again
  const mk = marksAt(t);
  const fk = (act ? st + "\u0001" + String(kindIds(t.s, t.evs).length) + ":" + String(kindVer(t.evs)) + "\u0001" + t.xr.join(",") : "") + "\u0001m" + String(MK.ver);
  if (t.lw === iw && t.ln === n && t.lexp === t.expand && t.fk === fk) return;
  const out: string[] = []; const le: number[] = []; const ls: number[] = []; const it: number[] = [];
  const m = act ? vfMask(VIEW, t.s, t.evs) : null;
  for (let i = 0; i < n;) {
    if (!m || m[i] + 0 === 1 || inX(t, i)) {
      ls.push(out.length); it.push(i);
      const xs = merged(mk.get(i) ?? []);
      if (xs.length && t.evs[i].kind === "user") out.push(""); // a prompt's blank line goes above its marks
      for (const x of xs) out.push(markLine(t.s, x, iw - 1)); // the marks that land here, before the event
      const at = out.length; evLines(t.evs[i], iw - 1, t.expand, out);
      if (xs.length && t.evs[i].kind === "user" && out[at] === "") out.splice(at, 1);
      while (le.length < out.length) le.push(i); i++; continue;
    }
    let j = i; while (j < n && m[j] + 0 === 0 && !inX(t, j)) j++;
    const g = vfRuns(VIEW, t.s, t.evs, i, j)[0];
    const gl = out.length; out.push(fg(C.dim) + "  " + (g ? gapText(g, iw - 4) : "┄ " + String(j - i) + " hidden ┄") + RST); le.push(i); it.push(i);
    for (let k = i; k < j; k++) ls.push(gl);
    i = j;
  }
  if (n > 0 && n === t.evs.length && (!m || m[n - 1] + 0 === 1)) for (const x of merged(mk.get(n) ?? [])) { out.push(markLine(t.s, x, iw - 1)); le.push(n - 1); } // later than every event: at the end
  t.lines = out; t.lineEv = le; t.lineStart = ls; t.items = it; t.lw = iw; t.ln = n; t.lexp = t.expand; t.fk = fk;
}
function inX(t: TV, i: number): boolean { for (let k = 0; k + 1 < t.xr.length; k += 2) if (i >= numAt(t.xr, k, 0) && i < numAt(t.xr, k + 1, 0)) return true; return false; }
// ↵ on a gap line (the cursor on a hidden event): that run shows until the filter changes; false = the event is shown
export function expandAt(t: TV, i: number): boolean {
  if (!vfActive(VIEW) || i < 0 || i >= t.evs.length || inX(t, i)) return false;
  const m = vfMask(VIEW, t.s, t.evs); if (m[i] + 0 === 1) return false;
  let a = i; while (a > 0 && m[a - 1] + 0 === 0 && !inX(t, a - 1)) a--;
  let b = i; while (b < t.evs.length && m[b] + 0 === 0 && !inX(t, b)) b++;
  t.xr.push(a); t.xr.push(b); t.lw = -1;
  return true;
}
// the cursor d stops on (a stop: a shown event or a gap line; t.items, every event without a filter)
export function moveCur(t: TV, d: number, vh: number): void {
  const n = shown(t);
  if (!n) return;
  const it = t.items.length ? t.items : null;
  if (!it) t.cur = Math.max(0, Math.min(n - 1, (t.cur < 0 ? n - 1 : t.cur) + d));
  else {
    let p = it.length - 1; // the stop holding the cursor: the last at or before it
    if (t.cur >= 0) { let lo = 0; let hi = it.length - 1; p = 0; while (lo <= hi) { const mid = (lo + hi) >> 1; if (numAt(it, mid, 0) <= t.cur) { p = mid; lo = mid + 1; } else hi = mid - 1; } }
    p = Math.max(0, Math.min(it.length - 1, p + (t.cur < 0 ? 0 : d)));
    t.cur = numAt(it, p, 0);
  }
  t.follow = false;
  scrollTo(t, vh);
  if (d > 0 && (it ? t.cur === numAt(it, it.length - 1, 0) : t.cur === n - 1)) t.follow = true;
}
// the stop holding event i: the last stop at or before it
export function stopOf(t: TV, i: number): number {
  let lo = 0; let hi = t.items.length - 1; let p = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (numAt(t.items, mid, 0) <= i) { p = mid; lo = mid + 1; } else hi = mid - 1; }
  return numAt(t.items, p, i);
}
// scroll so the cursor's lines are in sight
export function scrollTo(t: TV, vh: number): void {
  const s0 = numAt(t.lineStart, t.cur, 0);
  let e0 = t.lines.length; for (let i = t.cur + 1; i < t.lineStart.length; i++) { const v = numAt(t.lineStart, i, 0); if (v > s0) { e0 = v; break; } }
  if (s0 < t.scroll) t.scroll = s0;
  else if (e0 > t.scroll + vh) t.scroll = Math.min(s0, e0 - vh);
}
export function openTranscript(s: Sess): void { if (remoteOnly(s, "the transcript")) return; openTranscriptAt(s, -1); }
// cursor ≥ 0 (a link to an event older than the tail): read from just before it, then skip to the tail; G/follow still
// go to the live end
export function openTranscriptAt(s: Sess, cursor: number): TV {
  const t: TV = { s, evs: [], off: 0, ep: s.ep, scroll: 0, follow: true, expand: false, lines: [], lw: 0, ln: -1, lexp: false, cur: -1, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1, from: cursor, items: [], xr: [], fk: "" };
  tvStart(t);
  S.tv = t;
  S.mode = "transcript";
  return t;
}
function meta(text: string): Ev { return { kind: "meta", text, ts: "", id: "", full: "" }; }
// (re)start reading: at the last 6 MB, or (t.from) a 6 MB window from 64 KB before the link's event, then the tail
function tvStart(t: TV): void {
  const s = t.s; const src = sourceOf(s.h);
  const start = Math.max(0, s.size - window(src, 6291456));
  t.evs = []; t.off = start; t.ep = s.ep; t.ln = -1;
  if (t.from > 0 && t.from < start) {
    const a = src.align(s, Math.max(0, t.from - window(src, 65536)));
    const r = src.lines(s, a, Math.min(s.size, a + window(src, 6291456)));
    const evs: Ev[] = [];
    for (const l of r.lines) parseEvents(s.h, l, evs, s);
    let first = ""; for (const e of evs) if (e.ts) { first = e.ts; break; }
    t.evs.push(meta("showing from " + (first ? localHM(first) + " " + first.slice(0, 10) : bytes(a * src.unit)) + " (opened by link)"));
    for (const e of evs) t.evs.push(e);
    const tail = src.align(s, start);
    if (tail > r.next) t.evs.push(meta("… " + bytes((tail - r.next) * src.unit) + " not shown …"));
    t.off = Math.max(tail, r.next);
    return;
  }
  if (start > 0) { // skip the partial first line
    t.off = src.align(s, start);
    t.evs.push(meta("showing last " + bytes((s.size - start) * src.unit) + " of " + bytes(s.size * src.unit)));
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
