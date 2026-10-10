// agentglass — call graph (c): a session's turns, tool calls and subagents as a DevTools-style flame chart + call tree
// SPDX-License-Identifier: Apache-2.0
import { clean, fit, fitStyled, fillTo, width, cw, cpOf, numAt, home, ESC_RE } from "../../util/text.ts";
import type { Ev, Sess } from "../../model/types.ts";
import { S, say, type TV, type Mode } from "../../state.ts";
import { remoteOnly } from "../../model/remote.ts";
import { H } from "../../hooks.ts";
import { harnessOf, sourceOf, window, parseEvents, epochOf } from "../../harness/index.ts";
import { FILE_SOURCE } from "../../harness/source.ts";
import { titleOf, subActive, current } from "../../model/sessions.ts";
import { openDetail } from "../../ui/detail.ts";
import { C, CSI, RST, fg, bg } from "../../ui/theme.ts";
import { put, box, spin } from "../../ui/screen.ts";
import { type Graph, type Agg, type Summary, type Src, type Span, type Band, K_TURN, K_AGENT, CATS, SORTS, HIDDEN_ROW, SKILL_ROW, buildGraph, aggregate, sortAggs, summary, dur, skillLanes, skillAgg, laneCap, lean } from "./model.ts";
import { type Mark, marksOf } from "../../model/marks.ts";
import { loadOf } from "../skills/marks.ts";
import { openSkillView } from "../skills/view.ts";
import { kindIds, kindSet, kindsIn, forgetKinds } from "../../model/kinds.ts";
import { famOf } from "../../model/marks.ts";
import { mask as vfMask, test as vfTest, active as vfActive, fstate, filterKey, barOpen, chipBar, setCount, emptyText as vfEmpty, forgetMasks } from "../../ui/evfilter.ts";

const VIEW = "callgraph";

const NAME = "call graph";
const EIGHT = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
const STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000];
const INK = "16;16;20"; // label text on a colored bar
const B = CSI + "1m";
const empty: Graph = { spans: [], rows: [], t0: 0, t1: 1, noTiming: false };
const G = {
  root: null as Sess | null, tvs: [] as TV[], from: [] as number[], full: null as TV | null, spawn: [] as string[], nsubs: 0, tick: 0, gen: 0, // from: each TV's first byte
  g: empty, aggs: [] as Agg[], sum: { wall: 0, active: 0, turns: 0, tools: 0, agents: 0, longest: -1 } as Summary,
  tab: 0, v0: 0, vw: 1, fitted: true, sel: -1, rtop: 0, aggKey: "",
  backMode: "list" as Mode, backTv: null as TV | null, inDetail: false,
  tsort: 0, tsel: 0, ttop: 0, topen: new Set<string>(), flat: [] as Agg[], lvl: [] as number[],
  hitY: [] as number[], hitX0: [] as number[], hitX1: [] as number[], hitI: [] as number[],
  sk: [] as Band[][], skMore: 0, skMax: -1, skMarks: [] as Mark[], skY: [] as number[], skX0: [] as number[], skX1: [] as number[], skRef: [] as string[], // skill lanes, their hit boxes
};
const SK_LANES = 3; // skill lanes at least; more while the chart leaves rows free below (laneCap)

// ── loading: the same bounded tail the transcript reads (last 6 MB), one TV per session. The graph keeps lean events
// (model.ts lean(): a 27 MB session with 175 subagents held 1.4 GB as parsed); ↵ and r read that one session in full
// from the same offsets (fullTV), so event indices match ──
function newTV(s: Sess, evs: Ev[], off: number): TV {
  return { s, evs, off, ep: epochOf(s), scroll: 0, follow: false, expand: false, lines: [], lw: 0, ln: -1, lexp: false, cur: -1, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1, from: -1, items: [], xr: [], fk: "" };
}
// s's events from cursor a to z (each line's hooks applied as parseEvents does), lean or as parsed, into out; the next
// cursor. Lean: a file in 256 KB steps (a longer line: a larger one) — what a step parses is freed before the next, so
// the events kept do not pin the pages of a whole 6 MB parse (glibc keeps them: 144 MB → 50 MB on 175 subagents)
function readEvs(s: Sess, a: number, z: number, slim: boolean, out: Ev[]): number {
  const src = sourceOf(s.h); const base = slim && src === FILE_SOURCE ? 262144 : Math.max(1, z - a);
  let at = a; let step = base;
  while (at < z) {
    const r = src.lines(s, at, Math.min(z, at + step));
    if (r.next <= at) { if (at + step >= z) break; step = step * 2; continue; } // no whole line in the step
    step = base;
    const evs: Ev[] = slim ? [] : out;
    for (const l of r.lines) parseEvents(s.h, l, evs, s);
    if (slim) for (const e of evs) out.push(lean(e, out.length ? out[out.length - 1] : null));
    at = r.next;
  }
  return at;
}
function loadTV(s: Sess, k: number): TV {
  const src = sourceOf(s.h);
  const st = src.stat(s);
  const size = st ? st.size : s.size; // else gone
  const a = src.align(s, Math.max(0, size - window(src, 6291456)));
  const evs: Ev[] = [];
  const tv = newTV(s, evs, readEvs(s, a, size, true, evs));
  while (G.from.length <= k) G.from.push(0);
  G.from[k] = a;
  return tv;
}
// the parent's tool call that spawned subagent s, if the harness records it
function spawnOf(s: Sess): string { const f = harnessOf(s.h).spawnOf; return f ? f(s) : ""; }
// fresh: read every session; else keep the sessions already read (a new subagent reads only itself)
function load(s: Sess, fresh: boolean): void {
  const old = new Map<string, number>();
  if (!fresh && G.root === s) for (let k = 0; k < G.tvs.length; k++) old.set(G.tvs[k].s.path, k);
  const tvs = G.tvs; const from = G.from;
  G.root = s; G.tvs = []; G.from = []; G.spawn = []; G.full = null;
  const all = [s]; for (const c of s.subs) all.push(c);
  for (let k = 0; k < all.length; k++) {
    const x = all[k]; const j = old.get(x.path) ?? -1;
    if (j >= 0) { G.tvs.push(tvs[j]); while (G.from.length <= k) G.from.push(0); G.from[k] = numAt(from, j, 0); }
    else G.tvs.push(loadTV(x, k));
    G.spawn.push(k ? spawnOf(x) : "");
  }
  G.nsubs = s.subs.length;
}
// ↵ and r: session k with its events as parsed (the same bytes as its lean ones); one kept at a time while the graph is open
function fullTV(k: number): TV | null {
  const t = tvAt(k); if (!t) return null;
  const f = G.full;
  if (f && f.s === t.s && f.off === t.off) return f;
  const evs: Ev[] = [];
  const tv = newTV(t.s, evs, readEvs(t.s, numAt(G.from, k, 0), t.off, false, evs));
  G.full = tv;
  return tv;
}
function spanAt(i: number): Span | null { return i >= 0 && i < G.g.spans.length ? G.g.spans[i] : null; }
// ── the event-kind filter (ui/evfilter.ts, view "callgraph"): hidden tool and subagent spans are not drawn; their time
// stays empty with a dim ┄n tick per lane, the axis and the turns stay; the tree folds them into one ┄ n hidden row ──
const HID = { key: "", hide: [] as boolean[], shown: 0, total: 0 };
// hidden(i) reads the last syncHidden(): every entry point (frame, key, the chip bar's count) syncs once, not per span
function hidden(i: number): boolean { return i >= 0 && i < HID.hide.length && HID.hide[i] === true; }
function syncHidden(): void {
  const on = vfActive(VIEW);
  const k = on ? fstate(VIEW) + "|" + String(G.gen) : ""; // gen: the spans and events changed (rebuild)
  if (k === HID.key && HID.hide.length === G.g.spans.length) return;
  HID.key = k; HID.hide = []; HID.shown = 0; HID.total = 0;
  const ms: Uint8Array[] = []; for (const t of G.tvs) ms.push(on ? vfMask(VIEW, t.s, t.evs) : new Uint8Array(0));
  for (const sp of G.g.spans) {
    let h = false;
    if (sp.kind !== K_TURN) {
      HID.total++;
      if (on) {
        const t = tvAt(sp.src); const m = sp.src >= 0 && sp.src < ms.length ? ms[sp.src] : null;
        if (sp.kind === K_AGENT) h = !(t && vfTest(VIEW, t.s, { raw: "tool", kinds: ["subagent"], tool: "", args: "", server: "", fam: "", err: -1 }));
        else h = !(m && sp.ev >= 0 && sp.ev < m.length && m[sp.ev] + 0 === 1);
      }
      if (!h) HID.shown++;
    }
    HID.hide.push(h);
  }
}
// the kinds of a span (its call's, a subagent's): solo (i) on the selection
function spanKinds(sp: Span): string[] {
  if (sp.kind === K_AGENT) return ["subagent"];
  const t = tvAt(sp.src); if (!t || sp.ev < 0 || sp.ev >= t.evs.length) return [];
  return kindSet(kindIds(t.s, t.evs)[sp.ev] + 0);
}
// the kinds of every loaded event (the chip bar), once per rebuild: kinds.ts keeps memos for a few arrays, not 176
const GK = { key: "", m: new Map<string, number>() };
function graphKinds(): Map<string, number> {
  const key = String(G.gen); if (GK.key === key) return GK.m;
  const m = new Map<string, number>();
  for (const t of G.tvs) for (const [k, n] of kindsIn(t.s, t.evs)) m.set(k, (m.get(k) ?? 0) + n);
  GK.key = key; GK.m = m;
  return m;
}
// ] [ with a filter: the next / previous shown span in time (any lane)
function nextShown(d: number): number {
  syncHidden();
  const cur = spanAt(G.sel); const t0 = cur ? cur.t0 : d > 0 ? -Infinity : Infinity;
  let best = -1; let bt = 0;
  for (let i = 0; i < G.g.spans.length; i++) {
    const sp = G.g.spans[i]; if (sp.kind === K_TURN || hidden(i) || i === G.sel) continue;
    const ok = d > 0 ? sp.t0 > t0 || (sp.t0 === t0 && i > G.sel) : sp.t0 < t0 || (sp.t0 === t0 && i < G.sel);
    if (ok && (best < 0 || (d > 0 ? sp.t0 < bt : sp.t0 > bt))) { best = i; bt = sp.t0; }
  }
  return best;
}
setCount(VIEW, (): string => { syncHidden(); return String(HID.shown) + " of " + String(HID.total) + " spans"; });
function tvAt(i: number): TV | null { return i >= 0 && i < G.tvs.length ? G.tvs[i] : null; }
function rebuild(): void {
  const old = spanAt(G.sel);
  const srcs: Src[] = [];
  for (let k = 0; k < G.tvs.length; k++) { const t = G.tvs[k]; srcs.push({ evs: t.evs, live: subActive(t.s), kind: t.s.kind, spawn: G.spawn[k] ?? "" }); }
  G.g = buildGraph(srcs, Date.now()); G.gen++; HID.key = "-";
  const r = G.root; G.skMarks = r ? marksOf(r, ["skill:load"]) : []; G.skMax = -1; layLanes();
  aggs();
  G.sum = summary(G.g);
  G.sel = -1;
  if (old) for (let i = 0; i < G.g.spans.length; i++) { const s = G.g.spans[i]; if (s.src === old.src && s.ev === old.ev && s.kind === old.kind) { G.sel = i; break; } }
  if (G.sel < 0) G.sel = G.sum.longest >= 0 ? G.sum.longest : G.g.spans.length ? 0 : -1;
  if (G.fitted) fitAll();
}
// the call tree over the shown spans; the hidden ones as one ┄ n hidden row (its time, count and families)
function aggs(): void {
  syncHidden();
  G.aggs = aggregate(G.g, vfActive(VIEW) ? HID.hide : null);
  for (const a of G.aggs) if (a.name === HIDDEN_ROW) { // named with its count and families, most first
    const fm = new Map<string, number>();
    for (let i = 0; i < G.g.spans.length; i++) if (hidden(i)) { const sp = G.g.spans[i]; const fs: string[] = []; for (const k of spanKinds(sp)) { const f = famOf(k); if (fs.indexOf(f) < 0) fs.push(f); } for (const f of fs) fm.set(f, (fm.get(f) ?? 0) + 1); }
    const ks: string[] = []; for (const k of fm.keys()) ks.push(k);
    ks.sort((x: string, y: string): number => (fm.get(y) ?? 0) - (fm.get(x) ?? 0) || (x < y ? -1 : 1));
    a.name = "┄ " + String(a.count) + " hidden" + ks.slice(0, 3).map((k: string): string => " · " + k + " " + String(fm.get(k) ?? 0)).join("");
  }
  const sa = skShown() ? skillAgg(G.skMarks, G.g.t1) : null; if (sa) G.aggs.push(sa); // in-context time per skill, after the calls
  sortAggs(G.aggs, G.tsort);
  G.aggKey = HID.key;
}
// the selected span's session, its events and the event index (related events' r); null = nothing selected
export function graphAnchor(): { s: Sess; evs: Ev[]; i: number } | null {
  const sp = spanAt(G.sel); if (!sp || sp.ev < 0) return null;
  const t = fullTV(sp.src); return t && sp.ev < t.evs.length ? { s: t.s, evs: t.evs, i: sp.ev } : null;
}
// checks: the selection, the spans, the last frame's hit boxes (span → first column) and the tree's rows
export function cgState(): { sel: number; spans: Span[]; hitI: number[]; hitX0: number[]; hitY: number[]; tree: string[] } {
  const tree: string[] = []; for (const a of G.aggs) tree.push(a.name + " " + String(a.count));
  return { sel: G.sel, spans: G.g.spans, hitI: G.hitI.slice(), hitX0: G.hitX0.slice(), hitY: G.hitY.slice(), tree };
}
export function cgSelect(i: number): void { if (spanAt(i)) { G.sel = i; G.tab = 0; reveal(); } }
// the call graph of a session (the c key; repo-view's project detail); esc returns to where it was opened
export function openGraph(s: Sess): void { open(s); }
function open(s: Sess): void {
  release();
  load(s, true);
  G.backMode = S.mode; G.backTv = S.tv; G.inDetail = false;
  G.sel = -1; G.fitted = true; G.rtop = 0; G.tsel = 0; G.ttop = 0; G.topen.clear();
  rebuild();
  S.fview = NAME; S.mode = "view";
  if (!G.g.spans.length) say("info", "no turns or tool calls in this session yet");
}
function back(): void { S.mode = G.backMode; S.tv = G.backTv; release(); }
// closing (or opening another session) lets go of everything the graph read or derived: events, spans, their memos
function release(): void {
  const f = G.full; const ts = G.tvs.slice(); if (f) ts.push(f);
  for (const t of ts) { forgetKinds(t.evs); forgetMasks(t.evs); }
  G.root = null; G.tvs = []; G.from = []; G.full = null; G.spawn = []; G.g = empty; G.aggs = []; G.flat = []; G.lvl = [];
  G.sk = []; G.skMarks = []; G.hitY = []; G.hitX0 = []; G.hitX1 = []; G.hitI = []; G.skY = []; G.skX0 = []; G.skX1 = []; G.skRef = [];
  HID.key = ""; HID.hide = []; GK.key = ""; GK.m = new Map<string, number>();
}
function live(): boolean { for (const t of G.tvs) if (subActive(t.s)) return true; return false; }
// every 2s: tail new lines (and newly spawned subagents) into the open graph
function refresh(): void {
  const r = G.root;
  if (!r || S.mode !== "view" || S.fview !== NAME) return;
  G.tick++;
  if (G.tick % 4) return;
  if (r.subs.length !== G.nsubs) { load(r, false); rebuild(); return; } // a new subagent: read only it
  for (const t of G.tvs) if (epochOf(t.s) !== t.ep) { load(r, true); rebuild(); return; } // a source switched transport: start over
  let grew = false;
  for (const t of G.tvs) {
    const src = sourceOf(t.s.h);
    const st = src.stat(t.s);
    if (!st || st.size <= t.off) continue;
    t.off = readEvs(t.s, t.off, Math.min(st.size, t.off + window(src, 16777216)), true, t.evs); grew = true;
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
  for (const x of rowOf(r)) { const i = x.ix; if (hidden(i)) continue; const dd = x.t1 < tc ? tc - x.t1 : x.t0 > tc ? x.t0 - tc : 0; if (best < 0 || dd < bd) { best = i; bd = dd; } }
  if (best >= 0) { G.sel = best; reveal(); }
}
function step(d: number): void {
  const s = spanAt(G.sel);
  if (!s) return;
  const ids = rowOf(s.row);
  let p = ids.indexOf(s) + d;
  while (p >= 0 && p < ids.length && hidden(ids[p].ix)) p += d; // hidden spans are skipped
  if (p >= 0 && p < ids.length) { G.sel = ids[p].ix; reveal(); }
}
function drill(i: number): void {
  const s = spanAt(i);
  if (!s || s.ev < 0) return;
  const tv = fullTV(s.src);
  if (!tv || s.ev >= tv.evs.length) return;
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
  const ticks: number[] = []; // hidden spans per column: a dim ┄n where they lie (the time axis stays true)
  for (const s of rowOf(r)) {
    const i = s.ix;
    const a = (s.t0 - G.v0) / dt; const z = (s.t1 - G.v0) / dt;
    if (z < 0 || a >= n) continue;
    if (hidden(i)) { const c = Math.max(0, Math.min(n - 1, Math.floor(a))); while (ticks.length <= c) ticks.push(0); ticks[c] = (ticks[c] ?? 0) + 1; continue; }
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
  for (let c = 0; c < ticks.length; c++) {
    const k = ticks[c] ?? 0; if (!k || (ch[c] !== " " && ch[c] !== "┊")) continue;
    const t = k > 1 ? "┄" + String(k) : "┄";
    for (let j = 0; j < t.length && c + j < n; j++) if (j === 0 || ch[c + j] === " " || ch[c + j] === "┊") { ch[c + j] = t.charAt(j); fs[c + j] = C.dim; bs[c + j] = C.panel; }
  }
  if (r === 0 && skShown()) for (const m of G.skMarks) { const c = Math.floor((m.t0 - G.v0) / dt); if (c >= 0 && c < n && (ch[c] === " " || ch[c] === "┊")) { ch[c] = "✧"; fs[c] = C.cyan; } } // a skill loaded here (the turn keeps its colour and its label)
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
// ── skills (skill-usage §6.2): a ✧ tick on the turns row at each load, and a lane per concurrently open skill under the
// turns with a band from load to unload; the kind filter keeps them while it shows skill:load ──
function skShown(): boolean { const r = G.root; return !!r && G.skMarks.length > 0 && (!vfActive(VIEW) || vfTest(VIEW, r, { raw: "meta", kinds: ["skill:load"], tool: "", args: "", server: "", fam: "", err: -1 })); }
// the drawn rows: graph rows (≥ 0) with the skill lanes (-1 - lane) after the turns' rows
function dispRows(): number[] {
  const o: number[] = []; let k = 0;
  for (let ri = 0; ri < G.g.rows.length; ri++) { const row = rowOf(ri); if (row.length && row[0].depth === 0) k = ri + 1; }
  for (let ri = 0; ri < G.g.rows.length; ri++) { if (ri === k && skShown()) for (let l = 0; l < G.sk.length; l++) o.push(-1 - l); o.push(ri); }
  if (k >= G.g.rows.length && skShown()) for (let l = 0; l < G.sk.length; l++) o.push(-1 - l);
  return o;
}
function drawLane(l: number, y: number, grid: string[]): void {
  const n = cols(); const dt = G.vw / n;
  const ch: string[] = []; const fs: string[] = []; const bs: string[] = [];
  for (let c = 0; c < n; c++) { ch.push(grid[c] ?? " "); fs.push(C.line); bs.push(C.panel); }
  const none: Band[] = []; const lane = l >= 0 && l < G.sk.length ? G.sk[l] ?? none : none;
  for (const b of lane) {
    const a = Math.floor((b.t0 - G.v0) / dt); const z = Math.floor((b.t1 - G.v0) / dt);
    if (z < 0 || a >= n) continue;
    for (let c = Math.max(0, a); c <= Math.min(n - 1, z); c++) { ch[c] = c === a ? "✧" : c === z && !b.open ? "┤" : "─"; fs[c] = C.cyan; }
    const t = narrow(" " + b.label); const x0 = Math.max(0, a) + 1;
    if (z - x0 >= 3) for (let j = 0; j < t.length && x0 + j < Math.min(n, z); j++) { ch[x0 + j] = t[j] ?? " "; fs[x0 + j] = C.cyan; }
    G.skY.push(y); G.skX0.push(1 + Math.max(0, a)); G.skX1.push(1 + Math.min(n - 1, Math.max(a, z))); G.skRef.push(b.ref);
  }
  if (l === G.sk.length - 1 && G.skMore > 0) { const t = " +" + String(G.skMore); for (let j = 0; j < t.length; j++) { const c = n - t.length + j; if (c >= 0) { ch[c] = t.charAt(j); fs[c] = C.dim; } } }
  put(1, y, runs(ch, fs, bs));
}
function skillAt(ref: string): void {
  const r = G.root; if (!r) return;
  for (const m of G.skMarks) if (m.ref === ref) { const x = loadOf(r, m); if (x) openSkillView(r, x); return; }
}
// the skill lanes for the chart's height: the rows the spans leave free (≥ SK_LANES), so "+n" folds only what cannot show
function layLanes(): void {
  const max = laneCap(Math.max(1, S.H - 9), G.g.rows.length, SK_LANES);
  if (max === G.skMax) return;
  const sl = skillLanes(G.skMarks, G.g.t1, max); G.sk = sl.lanes; G.skMore = sl.more; G.skMax = max;
}
function renderFlame(): void {
  const Ht = S.H; const y0 = 5; const rh = Math.max(1, Ht - 9);
  layLanes();
  G.hitY.length = 0; G.hitX0.length = 0; G.hitX1.length = 0; G.hitI.length = 0;
  G.skY.length = 0; G.skX0.length = 0; G.skX1.length = 0; G.skRef.length = 0;
  const grid = ruler(4);
  const s = spanAt(G.sel);
  const disp = dispRows(); const di = s ? disp.indexOf(s.row) : -1;
  if (di >= 0) { if (di < G.rtop) G.rtop = di; else if (di >= G.rtop + rh) G.rtop = di - rh + 1; }
  G.rtop = Math.max(0, Math.min(G.rtop, disp.length - rh));
  for (let r = 0; r < rh; r++) {
    const d = G.rtop + r < disp.length ? numAt(disp, G.rtop + r, 0) : -1000000;
    if (d >= 0) drawRow(d, y0 + r, grid);
    else if (d > -1000000) drawLane(-1 - d, y0 + r, grid);
    else put(1, y0 + r, fg(C.line) + grid.join("") + RST);
  }
  if (!G.g.spans.length) put(3, y0 + 1, fg(C.dim) + "no turns or tool calls yet" + RST);
  else if (vfActive(VIEW) && HID.shown === 0) put(3, y0 + 1, fg(C.dim) + vfEmpty(VIEW) + RST);
  infoBar(Ht - 4);
  if (barOpen(VIEW)) { const b = fitStyled(" " + chipBar(VIEW, graphKinds(), S.W - 3), S.W - 2); put(1, Ht - 3, bg(C.sel) + b + fillTo(b, S.W - 2) + RST); }
}
function flatten(list: Agg[], lvl: number): void {
  for (const a of list) {
    G.flat.push(a); G.lvl.push(lvl);
    if (a.kids.length && G.topen.has(a.name)) flatten(a.kids, lvl + 1);
  }
}
function renderTree(): void {
  const Ht = S.H; const w = S.W - 2;
  syncHidden(); if (G.aggKey !== HID.key) aggs();
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
      num(a.name.startsWith("✧") ? "–" : pct.toFixed(pct < 10 ? 1 : 0) + "%", C.sub) + num(a.err ? String(a.err) : "–", a.err ? C.red : C.dim); // skills: time in context overlaps, no share of wall
    l = fitStyled(l, w);
    put(1, 5 + r, (on ? bg(C.sel) : "") + l + (on ? bg(C.sel) : "") + fillTo(l, w) + RST);
  }
  if (!G.flat.length) put(3, 6, fg(C.dim) + "no tool calls yet" + RST);
  const hint = fg(C.sub) + " sorted by " + fg(C.accent) + B + (SORTS[G.tsort] ?? "") + RST + fg(C.dim) + " (s)  ·  ␣ expand subagent  ·  ↵ longest call in the flame chart  ·  % of wall time; errors = results that read as failures" + RST;
  put(1, Ht - 4, bg(C.sel) + fitStyled(hint, w) + bg(C.sel) + fillTo(fitStyled(hint, w), w) + RST);
  if (barOpen(VIEW)) { const b = fitStyled(" " + chipBar(VIEW, graphKinds(), w - 1), w); put(1, Ht - 3, bg(C.sel) + b + fillTo(b, w) + RST); } else put(1, Ht - 3, " ".repeat(w));
}
function render(): void {
  const r = G.root;
  if (!r) return;
  const W = S.W; const Ht = S.H;
  const lv = live() ? " · " + spin() + " live" : "";
  syncHidden();
  const fc = vfActive(VIEW) ? String(HID.shown) + " of " + String(HID.total) + " spans · " : "";
  const info = fc + "view " + dur(G.vw) + " of " + dur(Math.max(0, G.g.t1 - G.g.t0)) + " · from " + hms(G.g.t0) + (G.tvs.length > 1 ? " · ⑂ " + (G.tvs.length - 1) : "") + lv;
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
  if (a && a.name.startsWith("✧ ") && a.name !== SKILL_ROW) { // a skill: its newest load in view skill
    let ref = ""; let t = -1; for (const m of G.skMarks) if ("✧ " + m.label === a.name && m.t0 > t) { t = m.t0; ref = m.ref; }
    if (ref) skillAt(ref); return;
  }
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
  syncHidden();
  if (k === "?" || k === "r") return false; // r: related events around the selected span (features/related)
  if ((k === "]" || k === "[") && !vfActive(VIEW) && G.tab === 0) { step(k === "]" ? 1 : -1); return true; } // no filter: the span beside it on the row
  const sel = spanAt(G.sel);
  const fk = filterKey(VIEW, k, graphKinds, sel ? spanKinds(sel) : [], nextShown);
  if (fk >= -1) { syncHidden(); if (fk >= 0) { G.sel = fk; G.tab = 0; reveal(); } else if (spanAt(G.sel) && hidden(G.sel)) { const nx = nextShown(1); G.sel = nx >= 0 ? nx : nextShown(-1); } return true; }
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
  for (let j = 0; j < G.skRef.length; j++) if (numAt(G.skY, j, -1) === y && x >= numAt(G.skX0, j, 0) && x <= numAt(G.skX1, j, -1)) { skillAt(G.skRef[j] ?? ""); return true; } // a skill band: view skill
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
  ["↑  ↓", "row above / below (turn › tool › subagent › …)"], ["h l  [ ]", "previous / next span on the row ([ ] with a kind filter: the previous / next shown span)"],
  ["K  i  !  /", "event kinds: hidden spans leave their time empty with a dim ┄n tick, the tree folds them into one ┄ n hidden row"],
  ["✧", "skills: a tick on the turns row at each load; under the turns one lane per skill in context (load → unload, click: view skill); tree: ✧ skills = time in context (↵ view skill)"],
  ["↵  click again", "event detail of that call (esc comes back)"], ["s  ␣", "call tree: sort column · expand a subagent"], ["esc  q  right-click", "back"] ] });
