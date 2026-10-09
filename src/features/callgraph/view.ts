// agentglass — call graph (c): a session's turns, tool calls and subagents as a DevTools-style flame chart + call tree
// SPDX-License-Identifier: Apache-2.0
import { clean, fit, fitStyled, fillTo, width, cw, cpOf, numAt, home, ESC_RE } from "../../util/text.ts";
import type { Ev, Sess } from "../../model/types.ts";
import { S, say, type TV, type Mode } from "../../state.ts";
import { remoteOnly } from "../../model/remote.ts";
import { H } from "../../hooks.ts";
import { harnessOf, sourceOf, window, parseEvents, epochOf } from "../../harness/index.ts";
import { titleOf, subActive, current } from "../../model/sessions.ts";
import { openDetail } from "../../ui/detail.ts";
import { C, CSI, RST, fg, bg } from "../../ui/theme.ts";
import { put, box, spin } from "../../ui/screen.ts";
import { type Graph, type Agg, type Summary, type Src, type Span, K_TURN, K_AGENT, CATS, SORTS, buildGraph, aggregate, sortAggs, summary, dur } from "./model.ts";

const NAME = "call graph";
const EIGHT = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
const STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000];
const INK = "16;16;20"; // label text on a colored bar
const B = CSI + "1m";
const empty: Graph = { spans: [], rows: [], t0: 0, t1: 1, noTiming: false };
const G = {
  root: null as Sess | null, tvs: [] as TV[], spawn: [] as string[], nsubs: 0, tick: 0,
  g: empty, aggs: [] as Agg[], sum: { wall: 0, active: 0, turns: 0, tools: 0, agents: 0, longest: -1 } as Summary,
  tab: 0, v0: 0, vw: 1, fitted: true, sel: -1, rtop: 0,
  backMode: "list" as Mode, backTv: null as TV | null, inDetail: false,
  tsort: 0, tsel: 0, ttop: 0, topen: new Set<string>(), flat: [] as Agg[], lvl: [] as number[],
  hitY: [] as number[], hitX0: [] as number[], hitX1: [] as number[], hitI: [] as number[],
};

// ── loading: the same bounded tail the transcript reads (last 6 MB), one TV per session so ↵ can drill into it ──
function loadTV(s: Sess): TV {
  const src = sourceOf(s.h);
  const st = src.stat(s);
  const size = st ? st.size : s.size; // else gone
  const r = src.lines(s, src.align(s, Math.max(0, size - window(src, 6291456))), size);
  const evs: Ev[] = [];
  for (const l of r.lines) parseEvents(s.h, l, evs, s);
  return { s, evs, off: r.next, ep: epochOf(s), scroll: 0, follow: false, expand: false, lines: [], lw: 0, ln: -1, lexp: false, cur: -1, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1, from: -1, items: [], xr: [], fk: "" };
}
// the parent's tool call that spawned subagent s, if the harness records it
function spawnOf(s: Sess): string { const f = harnessOf(s.h).spawnOf; return f ? f(s) : ""; }
function load(s: Sess): void {
  G.root = s; G.tvs = [loadTV(s)]; G.spawn = [""];
  for (const c of s.subs) { G.tvs.push(loadTV(c)); G.spawn.push(spawnOf(c)); }
  G.nsubs = s.subs.length;
}
function spanAt(i: number): Span | null { return i >= 0 && i < G.g.spans.length ? G.g.spans[i] : null; }
function tvAt(i: number): TV | null { return i >= 0 && i < G.tvs.length ? G.tvs[i] : null; }
function rebuild(): void {
  const old = spanAt(G.sel);
  const srcs: Src[] = [];
  for (let k = 0; k < G.tvs.length; k++) { const t = G.tvs[k]; srcs.push({ evs: t.evs, live: subActive(t.s), kind: t.s.kind, spawn: G.spawn[k] ?? "" }); }
  G.g = buildGraph(srcs, Date.now());
  G.aggs = aggregate(G.g); sortAggs(G.aggs, G.tsort);
  G.sum = summary(G.g);
  G.sel = -1;
  if (old) for (let i = 0; i < G.g.spans.length; i++) { const s = G.g.spans[i]; if (s.src === old.src && s.ev === old.ev && s.kind === old.kind) { G.sel = i; break; } }
  if (G.sel < 0) G.sel = G.sum.longest >= 0 ? G.sum.longest : G.g.spans.length ? 0 : -1;
  if (G.fitted) fitAll();
}
// the selected span's session, its events and the event index (related events' r); null = nothing selected
export function graphAnchor(): { s: Sess; evs: Ev[]; i: number } | null {
  const sp = spanAt(G.sel); if (!sp || sp.ev < 0) return null;
  const t = tvAt(sp.src); return t && sp.ev < t.evs.length ? { s: t.s, evs: t.evs, i: sp.ev } : null;
}
// the call graph of a session (the c key; repo-view's project detail); esc returns to where it was opened
export function openGraph(s: Sess): void { open(s); }
function open(s: Sess): void {
  load(s);
  G.backMode = S.mode; G.backTv = S.tv; G.inDetail = false;
  G.sel = -1; G.fitted = true; G.rtop = 0; G.tsel = 0; G.ttop = 0; G.topen.clear();
  rebuild();
  S.fview = NAME; S.mode = "view";
  if (!G.g.spans.length) say("info", "no turns or tool calls in this session yet");
}
function back(): void { S.mode = G.backMode; S.tv = G.backTv; G.root = null; G.tvs = []; G.g = empty; }
function live(): boolean { for (const t of G.tvs) if (subActive(t.s)) return true; return false; }
// every 2s: tail new lines (and newly spawned subagents) into the open graph
function refresh(): void {
  const r = G.root;
  if (!r || S.mode !== "view" || S.fview !== NAME) return;
  G.tick++;
  if (G.tick % 4) return;
  if (r.subs.length !== G.nsubs) { load(r); rebuild(); return; }
  for (const t of G.tvs) if (epochOf(t.s) !== t.ep) { load(r); rebuild(); return; } // a source switched transport: start over
  let grew = false;
  for (const t of G.tvs) {
    const src = sourceOf(t.s.h);
    const st = src.stat(t.s);
    if (!st || st.size <= t.off) continue;
    const rl = src.lines(t.s, t.off, Math.min(st.size, t.off + window(src, 16777216)));
    for (const l of rl.lines) parseEvents(t.s.h, l, t.evs, t.s);
    t.off = rl.next; grew = true;
  }
  if (grew || live()) rebuild();
}

// ── time window ─────────────────────────────────────────────────────────────
function cols(): number { return Math.max(10, S.W - 2); }
function clampView(): void {
  const wall = Math.max(1, G.g.t1 - G.g.t0);
  G.vw = Math.max(50, Math.min(G.vw, wall * 1.1));
  G.v0 = Math.max(G.g.t0 - G.vw * 0.5, Math.min(G.v0, G.g.t1 - G.vw * 0.5));
}
function fitAll(): void { const w = Math.max(1, G.g.t1 - G.g.t0); G.vw = w * 1.02; G.v0 = G.g.t0 - w * 0.01; G.fitted = true; }
function zoomAround(tc: number, f: number): void { const fr = (tc - G.v0) / G.vw; G.vw = G.vw * f; G.v0 = tc - fr * G.vw; G.fitted = false; clampView(); }
function selCenter(): number { const s = spanAt(G.sel); return s ? (s.t0 + s.t1) / 2 : G.v0 + G.vw / 2; }
function pan(f: number): void { G.v0 = G.v0 + G.vw * f; G.fitted = false; clampView(); }
function reveal(): void {
  const s = spanAt(G.sel);
  if (!s) return;
  if (s.t1 < G.v0 || s.t0 > G.v0 + G.vw) { G.v0 = (s.t0 + s.t1) / 2 - G.vw / 2; G.fitted = false; clampView(); }
}
function rowOf(r: number): Span[] { const none: Span[] = []; return r >= 0 && r < G.g.rows.length ? G.g.rows[r] ?? none : none; }
// ↑↓: the span in the neighbouring row closest to the selection's center
function moveRow(d: number): void {
  const s = spanAt(G.sel);
  const r = (s ? s.row : -1) + d;
  if (r < 0 || r >= G.g.rows.length) return;
  const tc = selCenter();
  let best = -1; let bd = 0;
  for (const x of rowOf(r)) { const i = x.ix; const dd = x.t1 < tc ? tc - x.t1 : x.t0 > tc ? x.t0 - tc : 0; if (best < 0 || dd < bd) { best = i; bd = dd; } }
  if (best >= 0) { G.sel = best; reveal(); }
}
function step(d: number): void {
  const s = spanAt(G.sel);
  if (!s) return;
  const ids = rowOf(s.row);
  const p = ids.indexOf(s) + d;
  if (p >= 0 && p < ids.length) { G.sel = ids[p].ix; reveal(); }
}
function drill(i: number): void {
  const s = spanAt(i);
  if (!s || s.ev < 0) return;
  const tv = tvAt(s.src);
  if (!tv) return;
  S.tv = tv; tv.cur = s.ev; tv.follow = false;
  G.inDetail = true;
  openDetail(s.ev);
}

// ── drawing ─────────────────────────────────────────────────────────────────
function catCol(c: number): string {
  return c === 0 ? C.green : c === 1 ? C.yellow : c === 2 ? C.cyan : c === 3 ? C.purple : c === 4 ? C.claude : c === 5 ? C.accent : c === 6 ? C.sub : C.line;
}
function hms(t: number): string {
  if (!t) return "--:--:--";
  const d = new Date(t);
  const p = (n: number): string => (n < 10 ? "0" : "") + n;
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function tick(t: number, step: number): string {
  if (step < 1000) return (t / 1000).toFixed(1) + "s";
  const s = Math.round(t / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60 ? String(s % 60).padStart(2, "0") : "");
  return Math.floor(s / 3600) + "h" + (s % 3600 ? String(Math.floor((s % 3600) / 60)).padStart(2, "0") : "");
}
function narrow(s: string): string[] { return Array.from(clean(s)).filter((ch) => cw(cpOf(ch)) === 1); } // one cell per char
// a subagent's task: its title, else the first prompt in its log (codex/fx children have no title)
function promptOf(t: TV): string {
  if (t.s.title) return clean(t.s.title);
  for (const e of t.evs) if (e.kind === "user") return clean(e.text);
  return clean(titleOf(t.s));
}
function label(s: Span): string { return s.kind === K_AGENT ? "⑂ " + s.name : s.kind === K_TURN ? s.name + " · " + s.arg : s.name + " " + s.arg; }
function pathOf(s: Span): string {
  const parts: string[] = [];
  let x: Span | null = s; let n = 0;
  while (x && n++ < 12) {
    if (x.kind === K_AGENT) parts.unshift("(" + x.name + ")");
    else if (x.kind === 1 && (parts[0] ?? "").startsWith("(")) parts[0] = x.name + (parts[0] ?? ""); // Agent(Explore): the call + what it spawned
    else parts.unshift(x.name);
    x = spanAt(x.parent);
  }
  return parts.join(" › ");
}
function runs(ch: string[], fs: string[], bs: string[]): string {
  let out = ""; let pf = ""; let pb = "";
  for (let c = 0; c < ch.length; c++) {
    const f = fs[c] ?? C.dim; const b = bs[c] ?? C.panel;
    if (f !== pf || b !== pb) { out += fg(f) + bg(b); pf = f; pb = b; }
    out += ch[c] ?? " ";
  }
  return out + RST;
}
function drawRow(r: number, y: number, grid: string[]): void {
  const n = cols(); const dt = G.vw / n;
  const ch: string[] = []; const fs: string[] = []; const bs: string[] = [];
  for (let c = 0; c < n; c++) { ch.push(grid[c] ?? " "); fs.push(C.line); bs.push(C.panel); }
  const set = (c: number, x: string, f: string, b: string): void => { if (c >= 0 && c < n) { ch[c] = x; fs[c] = f; bs[c] = b; } };
  for (const s of rowOf(r)) {
    const i = s.ix;
    const a = (s.t0 - G.v0) / dt; const z = (s.t1 - G.v0) / dt;
    if (z < 0 || a >= n) continue;
    const on = i === G.sel;
    const col = on ? C.text : catCol(s.cat);
    const ink = on || s.kind !== K_TURN ? INK : C.text;
    let c0 = Math.floor(a); let c1 = c0;
    if (z - a < 1) set(c0, EIGHT[Math.max(1, Math.min(8, Math.round((z - a) * 8))) - 1] ?? "▏", col, C.panel); // thinner than a cell
    else {
      const ka = Math.round((a - c0) * 8); // empty eighths at the start: drawn inverted
      let first = c0;
      if (ka >= 8) first = c0 + 1; else if (ka > 0) { set(c0, EIGHT[ka - 1] ?? "▏", C.panel, col); first = c0 + 1; }
      const cz = Math.floor(z); const kz = Math.round((z - cz) * 8);
      for (let c = Math.max(0, first); c < Math.min(cz, n); c++) set(c, " ", ink, col);
      if (kz > 0) set(cz, EIGHT[kz - 1] ?? "█", col, C.panel);
      c1 = kz > 0 ? cz : cz - 1;
      const lx = Math.max(0, first); const room = Math.min(cz, n) - lx;
      if (room >= 3) { const t = narrow(label(s)).slice(0, room - 1); for (let j = 0; j < t.length; j++) set(lx + 1 + j, t[j] ?? " ", ink, col); }
    }
    G.hitY.push(y); G.hitX0.push(1 + Math.max(0, c0)); G.hitX1.push(1 + Math.min(n - 1, Math.max(c0, c1))); G.hitI.push(i);
  }
  put(1, y, runs(ch, fs, bs));
}
function ruler(y: number): string[] {
  const n = cols(); const dt = G.vw / n;
  let st = STEPS[STEPS.length - 1] ?? 86400000;
  for (const x of STEPS) if (x / dt >= 12) { st = x; break; }
  const ch: string[] = []; const grid: string[] = [];
  for (let c = 0; c < n; c++) { ch.push("─"); grid.push(" "); }
  const rel0 = G.v0 - G.g.t0;
  for (let t = Math.ceil(rel0 / st) * st; t < rel0 + G.vw; t += st) {
    const c = Math.floor((t - rel0) / dt);
    if (c < 0 || c >= n) continue;
    ch[c] = "┬"; grid[c] = "┊";
    const l = tick(t, st);
    for (let j = 0; j < l.length && c + 1 + j < n; j++) ch[c + 1 + j] = l[j] ?? " ";
  }
  let l = "";
  for (const x of ch) l += (x === "─" ? fg(C.line) : x === "┬" ? fg(C.dim) : fg(C.sub)) + x;
  put(1, y, l + RST);
  return grid;
}
function status(s: Span): string {
  if (s.open) return fg(C.yellow) + spin() + " running" + RST;
  if (s.kind !== 1) return "";
  return s.err > 0 ? fg(C.red) + B + "✖ error" + RST : s.err === 0 ? fg(C.green) + "✔ ok" + RST : fg(C.dim) + "– no result" + RST;
}
function infoBar(y: number): void {
  const w = S.W - 2;
  const s = spanAt(G.sel);
  if (!s) { put(1, y, bg(C.sel) + " ".repeat(w) + RST); put(1, y + 1, bg(C.sel) + " ".repeat(w) + RST); return; }
  const st = status(s);
  const sw = width(st.replace(ESC_RE, ""));
  const p = fitStyled(fg(C.accent) + B + " " + clean(pathOf(s)) + RST, w - sw - 2);
  put(1, y, bg(C.sel) + p + bg(C.sel) + fillTo(p, w - sw - 1) + st + bg(C.sel) + " " + RST);
  const tv = tvAt(s.src);
  const what = s.kind === K_AGENT ? "subagent " + s.name + (tv ? " · " + promptOf(tv) : "") : s.kind === K_TURN ? "❯ " + s.arg : s.name + "(" + s.arg + ")";
  const meta = "  " + hms(s.t0) + " · " + dur(s.t1 - s.t0) + (s.est ? " ≈ no timing in log" : "") + (s.ev >= 0 ? " · ↵ details" : "");
  const mw = width(meta);
  const l2 = bg(C.sel) + fg(C.text) + " " + fit(clean(what).replace(/\s+/g, " "), Math.max(1, w - mw - 1)) + fg(C.sub) + meta + RST;
  put(1, y + 1, fitStyled(l2, w) + bg(C.sel) + fillTo(fitStyled(l2, w), w) + RST);
}
function summaryLine(y: number): void {
  const m = G.sum; const wall = Math.max(1, m.wall);
  const ls = spanAt(m.longest);
  const sep = fg(C.dim) + " · " + RST;
  const l = " " + fg(C.sub) + "wall " + RST + fg(C.text) + B + dur(m.wall) + RST + sep + fg(C.sub) + "active " + RST + fg(C.green) + dur(m.active) + " (" + Math.round((m.active / wall) * 100) + "%)" + RST + sep +
    fg(C.sub) + "idle/thinking " + RST + fg(C.yellow) + dur(Math.max(0, m.wall - m.active)) + RST + sep + fg(C.text) + m.turns + RST + fg(C.sub) + " turns " + RST + fg(C.text) + m.tools + RST + fg(C.sub) + " tools " + RST +
    fg(C.text) + m.agents + RST + fg(C.sub) + " subagents" + RST + (ls ? sep + fg(C.sub) + "longest " + RST + fg(catCol(ls.cat)) + clean(ls.kind === K_AGENT ? "⑂ " + ls.name : ls.name) + " " + dur(ls.t1 - ls.t0) + RST : "") +
    (G.g.noTiming ? sep + fg(C.yellow) + "≈ no timing in log" + RST : "");
  put(1, y, fitStyled(l, S.W - 2));
}
function tabsLine(y: number): void {
  const t = (i: number, s: string): string => (G.tab === i ? bg(C.sel) + fg(C.text) + B + CSI + "4m" : fg(C.sub)) + " " + s + " " + RST;
  let l = " " + t(0, "Flame chart") + " " + t(1, "Call tree") + fg(C.dim) + "  tab" + RST + "   ";
  for (let c = 0; c < CATS.length; c++) l += fg(catCol(c)) + "■ " + RST + fg(C.sub) + (CATS[c] ?? "") + "  " + RST;
  put(1, y, fitStyled(l, S.W - 2));
}
function renderFlame(): void {
  const Ht = S.H; const y0 = 5; const rh = Math.max(1, Ht - 9);
  G.hitY.length = 0; G.hitX0.length = 0; G.hitX1.length = 0; G.hitI.length = 0;
  const grid = ruler(4);
  const s = spanAt(G.sel);
  if (s) { if (s.row < G.rtop) G.rtop = s.row; else if (s.row >= G.rtop + rh) G.rtop = s.row - rh + 1; }
  G.rtop = Math.max(0, Math.min(G.rtop, G.g.rows.length - rh));
  for (let r = 0; r < rh; r++) {
    const ri = G.rtop + r;
    if (ri < G.g.rows.length) drawRow(ri, y0 + r, grid);
    else put(1, y0 + r, fg(C.line) + grid.join("") + RST);
  }
  if (!G.g.spans.length) put(3, y0 + 1, fg(C.dim) + "no turns or tool calls yet" + RST);
  infoBar(Ht - 4);
}
function flatten(list: Agg[], lvl: number): void {
  for (const a of list) {
    G.flat.push(a); G.lvl.push(lvl);
    if (a.kids.length && G.topen.has(a.name)) flatten(a.kids, lvl + 1);
  }
}
function renderTree(): void {
  const Ht = S.H; const w = S.W - 2;
  G.flat = []; G.lvl = [];
  flatten(G.aggs, 0);
  const cw8 = 8; const nw = Math.max(12, w - cw8 * 7 - 1);
  const wall = Math.max(1, G.sum.wall);
  const heads = ["total", "self", "count", "avg", "max", "% wall", "errors"];
  let h = fg(C.sub) + B + " " + fit(G.tsort === 6 ? "name ▾" : "name", nw - 1) + RST;
  for (let i = 0; i < heads.length; i++) {
    const on = i === G.tsort || (i === 6 && G.tsort === 5) || (i === 5 && G.tsort === 0);
    h += (on && i !== 5 ? fg(C.accent) + B : fg(C.sub)) + ((on && i !== 5 ? "▾" : "") + (heads[i] ?? "")).padStart(cw8) + RST;
  }
  put(1, 4, fitStyled(h, w));
  const rh = Math.max(1, Ht - 9);
  G.tsel = Math.max(0, Math.min(G.tsel, G.flat.length - 1));
  if (G.tsel < G.ttop) G.ttop = G.tsel; else if (G.tsel >= G.ttop + rh) G.ttop = G.tsel - rh + 1;
  for (let r = 0; r < rh; r++) {
    const i = G.ttop + r;
    if (i >= G.flat.length) { put(1, 5 + r, " ".repeat(w)); continue; }
    const a = G.flat[i]; const lv = numAt(G.lvl, i, 0);
    const on = i === G.tsel;
    const mark = a.kids.length ? (G.topen.has(a.name) ? "▾ " : "▸ ") : "  ";
    const col = a.agent ? C.claude : C.text;
    const nm = "  ".repeat(lv) + mark + a.name;
    const num = (s: string, c: string): string => fg(c) + s.padStart(cw8) + RST;
    const pct = (a.total / wall) * 100;
    let l = (on ? fg(C.accent) + "▌" : " ") + RST + fg(col) + (a.agent ? B : "") + fit(clean(nm), nw - 1) + RST +
      num(dur(a.total), C.text) + num(dur(a.self), C.sub) + num(String(a.count), C.text) + num(dur(a.total / Math.max(1, a.count)), C.sub) + num(dur(a.max), C.sub) +
      num(pct.toFixed(pct < 10 ? 1 : 0) + "%", C.sub) + num(a.err ? String(a.err) : "–", a.err ? C.red : C.dim);
    l = fitStyled(l, w);
    put(1, 5 + r, (on ? bg(C.sel) : "") + l + (on ? bg(C.sel) : "") + fillTo(l, w) + RST);
  }
  if (!G.flat.length) put(3, 6, fg(C.dim) + "no tool calls yet" + RST);
  const hint = fg(C.sub) + " sorted by " + fg(C.accent) + B + (SORTS[G.tsort] ?? "") + RST + fg(C.dim) + " (s)  ·  ␣ expand subagent  ·  ↵ longest call in the flame chart  ·  % of wall time; errors = results that read as failures" + RST;
  put(1, Ht - 4, bg(C.sel) + fitStyled(hint, w) + bg(C.sel) + fillTo(fitStyled(hint, w), w) + RST);
  put(1, Ht - 3, " ".repeat(w));
}
function render(): void {
  const r = G.root;
  if (!r) return;
  const W = S.W; const Ht = S.H;
  const lv = live() ? " · " + spin() + " live" : "";
  const info = "view " + dur(G.vw) + " of " + dur(Math.max(0, G.g.t1 - G.g.t0)) + " · from " + hms(G.g.t0) + (G.tvs.length > 1 ? " · ⑂ " + (G.tvs.length - 1) : "") + lv;
  box(0, 1, W, Ht - 2, "call graph · " + titleOf(r), home(r.cwd) + " · " + info, true);
  summaryLine(2);
  tabsLine(3);
  if (G.tab === 0) renderFlame(); else renderTree();
}

// ── registration ────────────────────────────────────────────────────────────
H.views.push({ name: NAME, render });
H.onTick.push(refresh);
function treeEnter(): void {
  const a = G.tsel >= 0 && G.tsel < G.flat.length ? G.flat[G.tsel] : null;
  if (!a || a.best < 0) return;
  G.sel = a.best; G.tab = 0;
  const s = spanAt(a.best);
  if (s && s.t1 - s.t0 > G.vw * 0.9) { G.vw = (s.t1 - s.t0) * 1.3; G.v0 = s.t0 - (s.t1 - s.t0) * 0.15; G.fitted = false; clampView(); }
  reveal();
}
H.keys.push((mode: string, k: string): boolean => {
  if (mode === "detail" && G.inDetail) { // detail opened from the graph: back lands here, not in a transcript
    if (k !== "esc" && k !== "q" && k !== "left" && k !== "backspace") return false;
    S.dv = null; S.tv = G.backTv; S.mode = "view"; G.inDetail = false;
    return true;
  }
  if (k === "c" && (mode === "transcript" || (mode === "list" && S.tab === 0))) {
    const s = mode === "transcript" ? (S.tv ? S.tv.s : null) : current();
    if (s && !remoteOnly(s, "the call graph")) open(s);
    return true;
  }
  if (mode !== "view" || S.fview !== NAME) return false;
  if (k === "?" || k === "r") return false; // r: related events around the selected span (features/related)
  if (k === "esc" || k === "q" || k === "backspace") { back(); return true; }
  if (k === "tab") { G.tab = 1 - G.tab; return true; }
  if (G.tab === 1) {
    const rh = Math.max(1, S.H - 9);
    if (k === "up" || k === "k" || k === "wheelup") G.tsel--;
    else if (k === "down" || k === "j" || k === "wheeldown") G.tsel++;
    else if (k === "pgup") G.tsel -= rh;
    else if (k === "pgdn") G.tsel += rh;
    else if (k === "g" || k === "home") G.tsel = 0;
    else if (k === "G" || k === "end") G.tsel = G.flat.length - 1;
    else if (k === "s") { G.tsort = (G.tsort + 1) % SORTS.length; sortAggs(G.aggs, G.tsort); }
    else if (k === " " || k === "right" || k === "left") {
      const a = G.tsel >= 0 && G.tsel < G.flat.length ? G.flat[G.tsel] : null;
      if (a && a.kids.length) { if (G.topen.has(a.name) && k !== "right") G.topen.delete(a.name); else if (k !== "left") G.topen.add(a.name); }
    }
    else if (k === "enter") treeEnter();
    return true;
  }
  if (k === "left") pan(-0.125);
  else if (k === "right") pan(0.125);
  else if (k === "+" || k === "=" || k === "wheelup") zoomAround(selCenter(), 1 / 1.5);
  else if (k === "-" || k === "_" || k === "wheeldown") zoomAround(selCenter(), 1.5);
  else if (k === "0") fitAll();
  else if (k === "up" || k === "k") moveRow(-1);
  else if (k === "down" || k === "j") moveRow(1);
  else if (k === "h" || k === "[") step(-1);
  else if (k === "l" || k === "]") step(1);
  else if (k === "enter") drill(G.sel);
  return true;
});
H.mouse.push((mode: string, b: number, x: number, y: number, press: boolean): boolean => {
  if (mode !== "view" || S.fview !== NAME || y === S.H - 1) return false; // footer hints stay buttons
  if (b === 64 || b === 65) {
    if (G.tab === 1) G.tsel += b === 64 ? -3 : 3;
    else zoomAround(G.v0 + ((x - 1 + 0.5) / cols()) * G.vw, b === 64 ? 1 / 1.25 : 1.25);
    return true;
  }
  if (!press || b !== 0) return false; // right-click falls through to esc = back
  if (y === 3) { G.tab = x < 16 ? 0 : x < 29 ? 1 : G.tab; return true; }
  if (G.tab === 1) {
    const i = G.ttop + (y - 5);
    if (y >= 5 && i < G.flat.length) { if (i === G.tsel) treeEnter(); else G.tsel = i; }
    return true;
  }
  for (let j = G.hitI.length - 1; j >= 0; j--) {
    if (numAt(G.hitY, j, -1) !== y || x < numAt(G.hitX0, j, 0) || x > numAt(G.hitX1, j, -1)) continue;
    const i = numAt(G.hitI, j, -1);
    if (i === G.sel) drill(i); else G.sel = i;
    return true;
  }
  return true;
});
H.footerHints.push((mode: string): string[][] => {
  if (mode === "view" && S.fview === NAME) return G.tab === 0
    ? [["tab", "call tree"], ["←→", "pan"], ["+/-", "zoom"], ["0", "fit"], ["↑↓", "depth"], ["h/l", "prev/next"], ["↵", "details"]]
    : [["tab", "flame chart"], ["s", "sort"], ["␣", "expand"], ["↵", "show in chart"]];
  return mode === "transcript" || (mode === "list" && S.tab === 0) ? [["c", "call graph"]] : [];
});
H.helpSections.push({ name: NAME, ctx: NAME, keys: [
  ["c", "call graph of the session (sessions list / transcript)"], ["tab", "flame chart ⇄ call tree"],
  ["←  →", "pan"], ["+  -  wheel", "zoom (around the selection / the mouse)"], ["0", "fit everything"],
  ["↑  ↓", "row above / below (turn › tool › subagent › …)"], ["h l  [ ]", "previous / next span on the row"],
  ["↵  click again", "event detail of that call (esc comes back)"], ["s  ␣", "call tree: sort column · expand a subagent"], ["esc  q  right-click", "back"] ] });
