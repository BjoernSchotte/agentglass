// agentglass — session compare view: A vs B side by side — summary, tools, programs, commands, files, models, timeline (spec §2.4, §4, §5)
// SPDX-License-Identifier: Apache-2.0
// The count runs in slices between frames (two groups of 90 days of call rows take a while): the previous numbers stay
// on screen, the header shows progress, keys stay live and a newer key replaces the count in flight.
import { existsSync } from "node:fs";
import { S, say } from "../../state.ts";
import { H, display } from "../../hooks.ts";
import { clean, fit, fitTail, fitStyled, fillTo, width, vwidth, home } from "../../util/text.ts";
import { ask, openPath } from "../../actions.ts";
import { C, CSI, RST, fg, bg } from "../../ui/theme.ts";
import { put, gauge, spin } from "../../ui/screen.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { titleOf } from "../../model/sessions.ts";
import { L, todayKey, dayKey, startOfDay } from "../usage/record.ts";
import { ledger } from "../usage/ledger.ts";
import { fmtMs, mcpServer } from "../usage/calls.ts";
import { grp, kfmt, money } from "../usage/costs.ts";
import type { Bill } from "../usage/billing.ts";
import { statsDrill, statsTabIndex } from "../usage/stats.ts";
import { callDays } from "../usage/callcache.ts";
import { HIDDEN } from "../skills/vis.ts";
import type { Clause } from "../query/types.ts";
import { print, printClause } from "../query/parse.ts";
import { callCutoff } from "../query/eval.ts";
import { includeClause, effective, localFor, shownClause } from "../query/scope.ts";
import { cycleNext, exprErr, newCyc } from "../query/ui.ts";
import { shown, newRun } from "../triage/run.ts";
import { openTriage, onInclude } from "../triage/view.ts";
import { type Group, type Cmp, type CmpJob, type Metric, NOSUB, groupOfExpr, groupClauses, cmpJob, cmpStep, cmpProgress, cmpCached, cmpKey, costCell } from "./metrics.ts";
import { type ToolRow, type CntRow, type FileRow, type ModelRow, type SkillCmpRow, SIG_SESS, toolRows, cntRows, fileLists, modelRows, skillCmpRows, timeline } from "./sections.ts";

export const CV_NAME = "compare";
export interface CState {
  A: Group; B: Group; subs: boolean; sec: number /* 0 summary, 1 tools, 2 programs, 3 commands, 4 files, 5 models, 6 skills, 7 timeline */; sel: number; top: number;
  side: number /* 0 = A ([), 1 = B (]) */; open: Set<string>; note: string; origin: string /* "Sessions" | "Stats" */; scope: Clause[]; cmp: Cmp | null;
}
export const CV: { st: CState | null } = { st: null };
const SECS = ["summary", "tools", "programs", "commands", "files", "models", "skills", "timeline"];
const SECS_N = ["sum", "tools", "progs", "cmds", "files", "models", "skills", "time"]; // below 110 columns
function secName(i: number, W: number): string { return (W >= 110 ? SECS[i] : SECS_N[i]) ?? ""; }

// ── state beside CState: the count in flight and the rows of the shown section ──
interface Item { kind: string /* metric | tool | cnt | file | head | model | spark */; i: number; key: string }
const V = { job: null as CmpJob | null, stale: true, at: 0, dur: 0 /* ms the last count took */, ver: -1, inTx: false, items: [] as Item[], tools: [] as ToolRow[], cnts: [] as CntRow[], files: [] as FileRow[], models: [] as ModelRow[], skills: [] as SkillCmpRow[], rowY0: 0, rowN: 0, sig: false, root: "", limited: false };
const SLICE_FRAME = 15; const SLICE = 40; const GAP = 10;
const TL = 7; // the timeline section (two single sessions only)
function hasTimeline(st: CState): boolean { return !!st.A.single && !!st.B.single; }
function key(st: CState): string { return cmpKey(st.A, st.B, st.scope, st.subs, null); }
function changed(st: CState): void { V.stale = true; V.job = null; S.dirty = true; if (st.sec === TL && !hasTimeline(st)) st.sec = 0; }
// recount when the groups changed or the ledger moved (every 2 s while live or indexing, every 10 s otherwise, and never
// sooner than 3× the last count took: big call-row groups do not count back to back); until a count finishes the previous
// comparison stays on screen
function ensure(st: CState, ms: number): void {
  const k = key(st); const c = st.cmp;
  const busy = L.done < L.total || (!!c && (c.a.live || c.b.live));
  const moved = L.ver !== V.ver && Date.now() - V.at >= Math.max(busy ? 2000 : 10000, 3 * V.dur);
  if (V.stale || (!V.job && (!c || c.key !== k || moved))) {
    const hit = V.stale ? cmpCached(k) : null;
    V.stale = false; V.at = Date.now(); V.ver = L.ver;
    if (hit) { st.cmp = hit; V.job = null; } else V.job = cmpJob(st.A, st.B, st.scope, st.subs, null);
  }
  const j = V.job;
  if (j && cmpStep(j, ms === Infinity ? Infinity : Date.now() + ms)) { st.cmp = j.res; V.job = null; V.dur = Date.now() - V.at; }
}
function counting(): boolean { return !!V.job || V.stale; }

export function openCompare(A: Group, B: Group, origin: string, note: string): void {
  const scope = origin === "Stats" ? effective(S.pins, localFor("Stats")).cs : S.pins.slice(); // the groups are explicit: pins only, Stats also its filter
  CV.st = { A, B, subs: true, sec: 0, sel: 0, top: 0, side: 1, open: new Set<string>(), note, origin, scope, cmp: null };
  V.stale = true; V.job = null; V.inTx = false;
  S.fview = CV_NAME; S.mode = "view"; S.dirty = true;
}
function leave(st: CState): void { V.job = null; V.stale = true; S.mode = "list"; S.tab = st.origin === "Stats" ? statsTabIndex() : 0; }

// ── text helpers ──
function rp(s: string, w: number): string { const n = width(s); return n >= w ? fit(s, w) : " ".repeat(w - n) + s; }
function line(s: string, W: number): string { const f = fitStyled(s, W); return f + fillTo(f, W); }
function plainOf(s: string): string { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); }
function exprText(cs: Clause[]): string { const o: string[] = []; for (const c of cs) { const vs: string[] = []; for (const v of c.vals) vs.push(shown(c.key, v)); o.push(printClause({ key: c.key, op: c.op, vals: vs, neg: c.neg, pinned: false })); } return o.join(" and "); }
function labelOf(g: Group): string { const s = g.single; return s ? clean(titleOf(s)) : exprText(g.cs); } // a live title (heads load lazily)
const MINUS = "−";
function pp(d: number): string { return (d > 0.05 ? "+" : d < -0.05 ? MINUS : "") + Math.abs(d).toFixed(1); }
function errPct(n: number, e: number): string { return n > 0 ? ((e / n) * 100).toFixed(0) + "%" : "–"; }
function dur(ms: number): string { return ms < 0 ? "–" : fmtMs(ms); }

// ── layout: H − 2 lines (screen rows 1 … H−2), styled ──
function header(st: CState, W: number): string {
  // each label gets half the room it needs at most: a long first prompt never pushes B off the line
  const room = Math.max(10, W - 2 - 9 - 5 - 6); const la = labelOf(st.A); const lb = labelOf(st.B);
  const wa = width(la) + width(lb) <= room ? width(la) : Math.max(Math.floor(room / 2), room - width(lb));
  const left = fg(C.accent) + CSI + "1m" + "compare" + RST + "  " + fg(C.accent) + "A: " + RST + fg(C.text) + fit(la, Math.min(width(la), wa)) + RST + fg(C.dim) + "  ·  " + RST + fg(C.accent) + "B: " + RST + fg(C.text) + lb + RST;
  return " " + line(left, W - 2) + " ";
}
function tabsLine(st: CState, W: number): string {
  let l = "";
  for (let i = 0; i < SECS.length; i++) {
    if (i === TL && !hasTimeline(st)) continue;
    l += (i === st.sec ? bg(C.accent) + fg("20;20;24") + CSI + "1m" : fg(C.sub)) + " " + secName(i, W) + " " + RST + " ";
  }
  return " " + line(l, W - 2) + " ";
}
// the line under the tabs: the pick's note and the scope on the left, the status flags on the right (they never squeeze the tabs)
function noteLine(st: CState, W: number): string {
  const c = st.cmp; const fl: string[] = [];
  if (counting()) { const j = V.job; fl.push(fg(C.accent) + spin() + RST + fg(C.sub) + " counting " + String(Math.floor((j ? cmpProgress(j) : 0) * 100)).padStart(3) + "%" + RST); }
  fl.push(fg(C.sub) + "subagents " + (st.subs ? "incl." : "excl.") + RST);
  if (c && (c.a.live || c.b.live)) fl.push(fg(C.green) + "● live" + RST);
  const ix = c ? Math.min(c.a.indexing, c.b.indexing) : 1;
  if (ix < 0.999) fl.push(fg(C.yellow) + "indexing " + String(Math.floor(ix * 100)) + "%" + RST);
  if (st.sec === 1 || st.sec === 4) fl.push(fg(C.dim) + "↵ side " + RST + fg(C.accent) + (st.side === 0 ? "A" : "B") + RST);
  const right = fitStyled(fl.join(fg(C.dim) + " · " + RST), W - 2);
  const parts: string[] = [];
  if (st.note) parts.push(st.note);
  const pins = st.scope; if (pins.length) parts.push("scope: " + exprText(pins));
  const room = W - 2 - vwidth(right) - 2;
  const left = room >= 8 ? fg(C.dim) + fit(parts.join("  ·  "), room) + RST : "";
  const l = left + (left ? "  " : "") + right;
  return " " + l + fillTo(l, W - 2) + " ";
}
// summary columns: label | A | B | Δ | B/A (B/A below 100 columns and Δ below 80 dropped)
interface SCols { lw: number; vw: number; dw: number; rw: number }
function scols(W: number): SCols {
  const rw = W >= 100 ? 8 : 0; const dw = W >= 80 ? 14 : 0; const lw = 16;
  const vw = Math.max(8, Math.min(34, Math.floor((W - 3 - lw - dw - rw) / 2)));
  return { lw, vw, dw, rw };
}
function metricLine(st: CState, m: Metric, c: SCols, on: boolean, W: number): string {
  const b = on ? bg(C.sel) : ""; const cm = st.cmp;
  let va = m.a; let vb = m.b;
  if (m.key === "cost" && cm && (width(va) > c.vw - 1 || width(vb) > c.vw - 1)) { va = costCell(cm.a, true); vb = costCell(cm.b, true); }
  const dc = m.tone > 0 ? C.red : m.tone < 0 ? C.green : C.sub;
  const l = b + " " + fg(C.sub) + fit(m.label, c.lw) + RST + b + fg(C.text) + rp(va, c.vw) + RST + b + " " + fg(C.text) + rp(vb, c.vw) + RST + b +
    (c.dw ? " " + fg(dc) + rp(m.d, c.dw - 1) + RST + b : "") + (c.rw ? " " + fg(C.dim) + rp(m.r, c.rw - 1) + RST + b : "");
  return line(l, W) + RST;
}
function summaryHead(c: SCols, W: number): string { return fg(C.dim) + line(" " + fit("", c.lw) + rp("A", c.vw) + " " + rp("B", c.vw) + (c.dw ? " " + rp("Δ  B − A", c.dw - 1) : "") + (c.rw ? " " + rp("B/A", c.rw - 1) : ""), W) + RST; }
// tools / programs / commands: name | calls A | calls B | share A | share B | Δpp | err A | err B | (p95 A | p95 B) | ●
interface TCols { nw: number; bw: number; err: boolean; p95: boolean }
// names (commands, MCP tools) get 24 columns before the share gauges get any; the gauges take what is left, ≤ 16 each
export function tableCols(W: number, p95: boolean): TCols {
  const err = W >= 80; const p = p95 && W >= 110;
  const fixed = 1 + 7 + 1 + 7 + 2 + 6 + 2 + 6 + 1 + 7 + (err ? 12 : 0) + (p ? 16 : 0) + 2;
  const free = W - fixed; const g = Math.min(16, Math.floor((free - 24) / 2) - 1);
  const bw = g >= 4 ? g : 0;
  const nw = Math.max(10, Math.min(40, free - (bw ? 2 * (bw + 1) : 0)));
  return { nw, bw, err, p95: p };
}
// b: the row's background, set again after the gauge's reset
function shareCell(sh: number, bw: number, b: string): string { return (bw >= 3 ? gauge(sh, bw) + b + " " : "") + fg(C.text) + rp((sh * 100).toFixed(1) + "%", 6) + RST; }
function tableHead(c: TCols, name: string, W: number): string {
  return fg(C.dim) + line(" " + fit(name, c.nw) + rp("A", 7) + " " + rp("B", 7) + "  " + (c.bw >= 3 ? fit("share A", c.bw + 7) : rp("% A", 6)) + "  " + (c.bw >= 3 ? fit("share B", c.bw + 7) : rp("% B", 6)) + " " + rp("Δpp", 7) +
    (c.err ? rp("err A", 6) + rp("err B", 6) : "") + (c.p95 ? rp("p95 A", 8) + rp("p95 B", 8) : "") + "  ", W) + RST;
}
function toolLine(st: CState, r: ToolRow, c: TCols, on: boolean, W: number): string {
  const b = on ? bg(C.sel) : "";
  const name = r.kid ? "   " + shown("tool", r.label) : r.server ? (st.open.has(r.key) ? "▾ ⧉ " : "▸ ⧉ ") + r.label : shown("tool", r.label);
  const dc = r.sig ? C.accent : C.sub;
  const l = b + " " + fg(r.kid ? C.sub : C.text) + (on ? CSI + "1m" : "") + fit(name, c.nw) + RST + b + fg(C.text) + rp(grp(r.nA), 7) + " " + rp(grp(r.nB), 7) + RST + b + "  " + shareCell(r.shA, c.bw, b) + b + "  " + shareCell(r.shB, c.bw, b) + b + " " + fg(dc) + rp(pp(r.dpp), 7) + RST + b +
    (c.err ? fg(C.sub) + rp(errPct(r.nA, r.errA), 6) + rp(errPct(r.nB, r.errB), 6) + RST + b : "") + (c.p95 ? fg(C.sub) + rp(dur(r.p95A), 8) + rp(dur(r.p95B), 8) + RST + b : "") + " " + (r.sig ? fg(C.accent) + "●" + RST + b : " ");
  return line(l, W) + RST;
}
function cntLine(r: CntRow, c: TCols, kind: string, on: boolean, W: number): string {
  const b = on ? bg(C.sel) : "";
  const l = b + " " + fg(C.text) + (on ? CSI + "1m" : "") + fit(display(kind, r.key, null), c.nw) + RST + b + fg(C.text) + rp(grp(r.nA), 7) + " " + rp(grp(r.nB), 7) + RST + b + "  " + shareCell(r.shA, c.bw, b) + b + "  " + shareCell(r.shB, c.bw, b) + b + " " + fg(r.sig ? C.accent : C.sub) + rp(pp(r.dpp), 7) + RST + b +
    (c.err ? fg(C.sub) + rp(errPct(r.nA, r.errA), 6) + rp(errPct(r.nB, r.errB), 6) + RST + b : "") + " " + (r.sig ? fg(C.accent) + "●" + RST + b : " ");
  return line(l, W) + RST;
}
function lines2(add: number, del: number): string { return add + del === 0 ? fg(C.dim) + "–" + RST : fg(C.green) + "+" + grp(add) + RST + " " + fg(C.red) + MINUS + grp(del) + RST; }
function fileLine(r: FileRow, W: number, on: boolean): string {
  const b = on ? bg(C.sel) : ""; const pw = Math.max(10, W - 2 - 34);
  const ed = (n: number): string => n > 0 ? grp(n) + "×" : "";
  const cellA = r.editsA > 0 ? fg(C.sub) + rp(ed(r.editsA), 5) + RST + b + " " + lines2(r.addA, r.delA) : fg(C.dim) + rp("–", 5) + RST;
  const cellB = r.editsB > 0 ? fg(C.sub) + rp(ed(r.editsB), 5) + RST + b + " " + lines2(r.addB, r.delB) : fg(C.dim) + rp("–", 5) + RST;
  const ca = fitStyled(cellA, 16); const cb = fitStyled(cellB, 16);
  const l = b + "   " + fg(C.text) + (on ? CSI + "1m" : "") + fitTail(display("file", r.shown, null), pw - 2) + RST + b + " " + ca + fillTo(ca, 16) + b + " " + cb + fillTo(cb, 16);
  return line(l, W) + RST;
}
// billA / billB: the side's one billing mode (API spend prints "$", estimates "≈$"), as on the summary's cost row
function modelLine(r: ModelRow, W: number, on: boolean, limited: boolean, billA: Bill | "", billB: Bill | ""): string {
  const b = on ? bg(C.sel) : ""; const nw = Math.max(12, Math.min(30, W - 2 - 60));
  const cost = (c: number, unk: boolean, bill: Bill | ""): string => unk ? (c > 0 ? money(c, bill) + " +?" : "cost ?") : c > 0 ? money(c, bill) : "–";
  const l = b + " " + fg(C.text) + (on ? CSI + "1m" : "") + fit(r.model, nw) + RST + b + fg(limited ? C.sub : C.text) + rp(grp(r.callsA), 8) + rp(grp(r.callsB), 8) + RST + b + fg(C.text) + rp(r.tokA ? kfmt(r.tokA) : "–", 10) + rp(r.tokB ? kfmt(r.tokB) : "–", 10) + RST + b +
    fg(C.yellow) + rp(cost(r.costA, r.unkA, billA), 12) + rp(cost(r.costB, r.unkB, billB), 12) + RST + b;
  return line(l, W) + RST;
}
// skills: loads, $ and $ per session that loaded it on each side (skill-usage §6.10); narrow drops $/sess first
function skillCols(W: number): { nw: number; per: boolean } { const per = W - 2 - 64 >= 12; return { nw: Math.max(12, Math.min(30, W - 2 - (per ? 64 : 42))), per }; }
function skillHead(W: number): string { const c = skillCols(W); return fg(C.dim) + line(" " + fit("skill", c.nw) + rp("loads A", 8) + rp("loads B", 8) + rp("$ A", 12) + rp("$ B", 12) + (c.per ? rp("$/sess A", 11) + rp("$/sess B", 11) : "") + "  ", W) + RST; }
function skillLine(r: SkillCmpRow, W: number, on: boolean, billA: Bill | "", billB: Bill | ""): string {
  const b = on ? bg(C.sel) : ""; const c = skillCols(W);
  const usd = (v: number, unk: boolean, bill: Bill | ""): string => unk ? (v > 0 ? money(v, bill) + " +?" : "$ ?") : v > 0 ? money(v, bill) : "–";
  const per = (v: number, n: number, bill: Bill | ""): string => n > 0 && v > 0 ? money(v / n, bill) : "–";
  const l = b + " " + fg(r.name === HIDDEN ? C.dim : C.cyan) + (on ? CSI + "1m" : "") + fit(r.name, c.nw) + RST + b + fg(C.text) + rp(r.loadsA ? grp(r.loadsA) : "–", 8) + rp(r.loadsB ? grp(r.loadsB) : "–", 8) + RST + b +
    fg(C.yellow) + rp(usd(r.usdA, r.unkA, billA), 12) + rp(usd(r.usdB, r.unkB, billB), 12) + RST + b + (c.per ? fg(C.sub) + rp(per(r.usdA, r.sessA, billA), 11) + rp(per(r.usdB, r.sessB, billB), 11) + RST + b : "") + " " + (r.sig ? fg(C.accent) + "●" + RST + b : " ");
  return line(l, W) + RST;
}
const BLK = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
// slots merged per column (per slots each)
function merge(vals: number[], n: number, per: number): number[] { const o: number[] = []; for (let i = 0; i < n; i += per) { let v = 0; for (let k = i; k < i + per && k < vals.length; k++) v += vals[k] ?? 0; o.push(v); } return o; }
function spark(cols: number[], mx: number): string {
  let s = "";
  for (const v of cols) s += v <= 0 ? fg(C.line) + "·" : fg(C.accent) + (BLK[Math.max(1, Math.round((v / Math.max(1, mx)) * 8))] ?? "█");
  return s + RST;
}

// the selectable rows of the shown section (head rows are skipped by the cursor)
function itemsOf(st: CState, c: Cmp): Item[] {
  const o: Item[] = [];
  if (st.sec === 0) { for (let i = 0; i < c.rows.length; i++) o.push({ kind: "metric", i, key: c.rows[i].key }); return o; }
  if (st.sec === 1) { const t = toolRows(c, st.open); V.tools = t.rows; V.sig = t.significance; for (let i = 0; i < t.rows.length; i++) o.push({ kind: "tool", i, key: t.rows[i].key }); return o; }
  if (st.sec === 2 || st.sec === 3) { V.cnts = cntRows(c, st.sec === 2 ? "prog" : "cmds"); V.sig = false; for (const r of V.cnts) if (r.chi2 >= 0) V.sig = true; for (let i = 0; i < V.cnts.length; i++) o.push({ kind: "cnt", i, key: V.cnts[i].key }); return o; }
  if (st.sec === 4) {
    const fl = fileLists(c); V.root = fl.root; V.files = [];
    const add = (title: string, rs: FileRow[]): void => { o.push({ kind: "head", i: -1, key: title + " (" + String(rs.length) + ")" }); for (const r of rs) { V.files.push(r); o.push({ kind: "file", i: V.files.length - 1, key: r.abs }); } };
    add("only in A", fl.onlyA); add("only in B", fl.onlyB); add("in both", fl.both);
    return o;
  }
  if (st.sec === 5) { const m = modelRows(c); V.models = m.rows; V.limited = m.limited; for (let i = 0; i < m.rows.length; i++) o.push({ kind: "model", i, key: m.rows[i].model }); return o; }
  if (st.sec === 6) { const k = skillCmpRows(c); V.skills = k.rows; V.sig = k.significance; for (let i = 0; i < k.rows.length; i++) o.push({ kind: "skill", i, key: k.rows[i].name }); return o; }
  return o;
}
function pickable(it: Item): boolean { return it.kind !== "head"; }
function itemLine(st: CState, it: Item, on: boolean, W: number): string {
  const c = st.cmp;
  if (it.kind === "metric" && c) return metricLine(st, c.rows[it.i], scols(W), on, W);
  if (it.kind === "tool") return toolLine(st, V.tools[it.i], tableCols(W, true), on, W);
  if (it.kind === "cnt") return cntLine(V.cnts[it.i], tableCols(W, false), st.sec === 2 ? "prog" : "cmd", on, W);
  if (it.kind === "file") return fileLine(V.files[it.i], W, on);
  if (it.kind === "model" && c) return modelLine(V.models[it.i], W, on, V.limited, c.a.bill, c.b.bill);
  if (it.kind === "skill" && c) return skillLine(V.skills[it.i], W, on, c.a.bill, c.b.bill);
  if (it.kind === "head") return " " + fg(C.accent) + CSI + "1m" + line(it.key, W - 2) + RST + " ";
  return "";
}
function emptyText(c: Cmp): string {
  const one = (g: string, err: string, ix: number, cs: Clause[]): string => err ? "group " + g + ": " + err + " — " + g.toLowerCase() + " edits it"
    : ix < 0.999 ? "group " + g + " is still being read (" + String(Math.floor(ix * 100)) + "%) — the numbers fill in" : "group " + g + " matched nothing: " + exprText(cs) + " — " + g.toLowerCase() + " edits it";
  const o: string[] = []; if (c.emptyA) o.push(one("A", c.a.err, c.a.indexing, c.A.cs)); if (c.emptyB) o.push(one("B", c.b.err, c.b.indexing, c.B.cs));
  return o.join("  ·  ");
}
function build(st: CState, W: number, Ht: number, sync: boolean): string[] {
  if (sync) ensure(st, Infinity);
  const n = Math.max(1, Ht - 2); const out: string[] = [header(st, W), tabsLine(st, W), noteLine(st, W)];
  const c = st.cmp;
  if (!c) {
    out.push(""); out.push(" " + fg(C.accent) + spin() + RST + fg(C.sub) + " counting both groups — keys work meanwhile" + RST);
    while (out.length < n) out.push("");
    return out.slice(0, n);
  }
  const ban: string[] = [];
  if (c.emptyA || c.emptyB) ban.push(fg(C.yellow) + emptyText(c) + RST);
  V.items = itemsOf(st, c);
  if (st.sec === 0) out.push(summaryHead(scols(W), W));
  else if (st.sec === 1) { out.push(tableHead(tableCols(W, true), "tool", W)); if (!V.sig) ban.push(fg(C.dim) + "small samples, no significance (χ² needs ≥ 50 calls per group)" + RST); else ban.push(fg(C.dim) + "● share differs between A and B (χ² ≥ 6.63, p < 0.01) · ␣ folds MCP servers · ↵ Stats drill-down for side A ([) or B (])" + RST); }
  else if (st.sec === 2 || st.sec === 3) { out.push(tableHead(tableCols(W, false), st.sec === 2 ? "program" : "command", W)); if (!V.sig && V.cnts.length) ban.push(fg(C.dim) + "small samples, no significance" + RST); }
  else if (st.sec === 4) { const pw = Math.max(10, W - 2 - 34); out.push(fg(C.dim) + line("   " + fit(V.root ? "path (in " + home(display("cwd", V.root, null)) + ")" : "path", pw - 2) + " " + fit("A edits  ±", 16) + " " + fit("B edits  ±", 16), W) + RST); }
  else if (st.sec === 5) { const nw = Math.max(12, Math.min(30, W - 2 - 60)); out.push(fg(C.dim) + line(" " + fit("model", nw) + rp("calls A", 8) + rp("calls B", 8) + rp("tokens A", 10) + rp("tokens B", 10) + rp("cost A", 12) + rp("cost B", 12), W) + RST); if (V.limited) ban.push(fg(C.dim) + "calls: call rows are kept " + String(callDays()) + " days, older calls are not counted — tokens and cost cover all history" + RST); }
  else if (st.sec === 6) { out.push(skillHead(W)); if (V.items.length) ban.push(fg(C.dim) + (V.sig ? "● the share of sessions loading it differs (χ² ≥ 6.63, p < 0.01) · " : "small samples, no significance (χ² needs ≥ " + String(SIG_SESS) + " sessions per group) · ") + "$/sess = per session that loaded it" + RST); }
  if (st.sec === TL) {
    const tl = timeline(c);
    if (!tl) out.push(" " + fg(C.sub) + "no timeline: a session has no start time" + RST);
    else {
      const len = Math.max(tl.a.length, tl.b.length);
      const w = W - 8; let per = 1; for (const p of [1, 2, 3, 6, 12, 24, 48, 96, 192, 384, 768]) { per = p; if (Math.ceil(len / p) <= w) break; } // whole 5/10/15/30/60 min … per column
      out.push(fg(C.dim) + line(" calls per " + (tl.slot === 300000 ? String(5 * per) + " min" : String(per) + " h") + " since each session's start" + (tl.slot !== 300000 ? " (hourly: older than the call rows)" : ""), W) + RST);
      const ma = merge(tl.a, len, per); const mb = merge(tl.b, len, per); let mx = 1; for (const v of ma) mx = Math.max(mx, v); for (const v of mb) mx = Math.max(mx, v);
      out.push(line(" " + fg(C.accent) + "A " + RST + spark(ma, mx), W));
      out.push(line(" " + fg(C.accent) + "B " + RST + spark(mb, mx), W));
      out.push(fg(C.dim) + line(" A " + fmtMs(tl.a.length * tl.slot) + " · B " + fmtMs(tl.b.length * tl.slot) + " of activity", W) + RST);
    }
  } else if (!V.items.length) {
    out.push(""); out.push(" " + fg(C.sub) + (st.sec === 4 ? "no files changed on either side" : st.sec === 6 ? "no skills loaded on either side" : st.sec === 0 ? "" : "nothing on either side") + RST);
  } else {
    const room = Math.max(1, n - out.length - ban.length);
    st.sel = Math.max(0, Math.min(st.sel, V.items.length - 1));
    if (!pickable(V.items[st.sel])) st.sel = nextPick(st.sel, 1);
    if (st.sel < st.top) st.top = st.sel; else if (st.sel >= st.top + room) st.top = st.sel - room + 1;
    if (st.sel === firstPick()) st.top = 0; // a head row above the first pickable row stays visible
    st.top = Math.max(0, Math.min(st.top, Math.max(0, V.items.length - room)));
    V.rowY0 = out.length; V.rowN = Math.min(room, V.items.length - st.top);
    for (let i = st.top; i < V.items.length && i < st.top + room; i++) out.push(itemLine(st, V.items[i], i === st.sel, W));
  }
  while (out.length < n - ban.length) out.push("");
  for (const b of ban) out.push(line(" " + b, W) + RST);
  while (out.length < n) out.push("");
  return out.slice(0, n);
}
function firstPick(): number { for (let i = 0; i < V.items.length; i++) if (pickable(V.items[i])) return i; return 0; }
function nextPick(i: number, d: number): number {
  for (let k = i; k >= 0 && k < V.items.length; k += d) if (pickable(V.items[k])) return k;
  for (let k = i; k >= 0 && k < V.items.length; k -= d) if (pickable(V.items[k])) return k;
  return 0;
}
// plain (ANSI-stripped) lines of the view at W × H, for checks (counts synchronously)
export function compareLines(st: CState, W: number, Ht: number): string[] { const o: string[] = []; for (const l of build(st, W, Ht, true)) o.push(plainOf(l)); return o; }
function render(): void {
  const st = CV.st; if (!st) return;
  ensure(st, SLICE_FRAME);
  if (counting()) pump();
  const ls = build(st, S.W, S.H, false);
  for (let i = 0; i < ls.length; i++) put(0, 1 + i, ls[i] ?? "");
}

// ── actions ──
function itemAt(i: number): Item | null { return i >= 0 && i < V.items.length ? V.items[i] : null; }
function move(st: CState, d: number): void {
  if (!V.items.length) return;
  const to = Math.max(0, Math.min(V.items.length - 1, st.sel + d));
  st.sel = nextPick(to, d >= 0 ? 1 : -1);
}
function group(st: CState, side: number): Group { return side === 0 ? st.A : st.B; }
function sideName(side: number): string { return side === 0 ? "A" : "B"; }
// the Stats drill-down of a tool, scoped to one group (the group's clauses become the Stats filter; pins apply there anyway)
function drill(st: CState, tool: string): void {
  const g = group(st, st.side); const c = st.cmp;
  const loc: Clause[] = []; for (const x of groupClauses(g, st.scope, st.subs)) { let pin = false; for (const p of S.pins) if (printClause(p) === printClause(x)) pin = true; if (!pin) loc.push(x); }
  const sd = c ? (st.side === 0 ? c.a : c.b) : null; let wk = false;
  const today = todayKey(); if (sd) for (const ds of sd.t.pdays.values()) for (const d of ds) if (d !== today) wk = true;
  statsDrill(tool, loc, wk);
  say("info", "Stats drill-down · " + sideName(st.side) + ": " + exprText(loc) + (wk ? " · last 7 days" : " · today"));
}
function enter(st: CState): void {
  const it = itemAt(st.sel); if (!it) return;
  if (it.kind === "tool") { drill(st, V.tools[it.i].key); return; } // a server row: the server's drill-down
  if (it.kind === "file") { const r = V.files[it.i]; if (!existsSync(r.abs)) { say("warn", "not found: " + display("file", home(r.abs), null)); return; } openPath(r.abs, false); return; }
  if (it.kind === "metric") { say("info", "tab: tools, programs, commands, files, models" + (hasTimeline(st) ? ", timeline" : "")); return; }
}
function openSide(st: CState, side: number): void {
  const g = group(st, side); const s = g.single;
  if (!s) { say("info", "group " + sideName(side) + " is not a single session"); return; }
  openTranscript(s); V.inTx = true;
}
function swap(st: CState): void { const a = st.A; st.A = st.B; st.B = a; st.side = 1 - st.side; st.note = st.note ? "swapped · " + st.note.replace(/^swapped · /, "") : ""; changed(st); }
// t: triage with A as the selection and B as an explicit group baseline, in the compare scope; entity call when every
// counted session's calls are within retention, else session; the period reaches back to the oldest counted day
function triageAB(st: CState): void {
  const c = st.cmp;
  if (!c) { say("info", "still counting — t works once both groups are counted"); return; }
  if (c.emptyA || c.emptyB) { say("warn", emptyText(c)); return; }
  const cut = callCutoff(); let calls = true; let oldest = todayKey();
  for (const t of [c.a.t, c.b.t]) for (const p of t.paths) {
    const a = ledger.get(p); if (!a || a.t0 < cut) calls = false;
    const ds: string[] = t.pdays.get(p) ?? []; for (const d of ds) if (String(d) < oldest) oldest = String(d);
  }
  let days = 1; const noon = startOfDay() + 43200000;
  while (days < 3650 && String(dayKey(new Date(noon - days * 86400000))) >= oldest) days++;
  const extra: Clause[] = st.subs ? [] : [NOSUB];
  const r = newRun("Compare", calls ? "call" : "session", st.scope.slice(), st.A.cs.concat(extra), days);
  r.base = "group"; r.group = st.B.cs.concat(extra);
  V.job = null;
  openTriage(r, () => { S.fview = CV_NAME; S.mode = "view"; S.dirty = true; });
}
// triage's + / − edit group A (the compare view is a non-tab origin)
onInclude("Compare", (cl: Clause): string => {
  const st = CV.st; if (!st) return "";
  const cs = includeClause(st.A.cs, cl).cs; st.A = { label: print(cs), cs, single: null }; st.note = ""; changed(st);
  return "group A: + " + shownClause(cl);
});
function cycle(st: CState, d: number): void {
  const n = hasTimeline(st) ? SECS.length : SECS.length - 1;
  st.sec = (st.sec + d + n) % n; st.sel = 0; st.top = 0; S.dirty = true;
}
// an MCP server row (or one of its tools): want 1 open, 0 close (the cursor goes to the server), -1 flip
function fold(st: CState, want: number): void {
  const it = itemAt(st.sel); if (!it || it.kind !== "tool") return;
  const r = V.tools[it.i]; if (!r.server && !r.kid) return;
  const pk = r.kid ? "mcp__" + mcpServer(r.key) : r.key;
  const open = want === 1 || (want === -1 && !st.open.has(pk));
  if (open) { st.open.add(pk); return; }
  st.open.delete(pk);
  if (r.kid) for (let i = 0; i < V.tools.length; i++) if (V.tools[i].key === pk) st.sel = i;
}
function keyView(st: CState, k: string): boolean {
  const c = st.cmp; if (c) V.items = itemsOf(st, c); // the rows the key acts on: the shown section's, even before the next frame
  if (k === "esc" || k === "q" || k === "bs") { leave(st); return true; }
  if (k === "up" || k === "k" || k === "wheelup") move(st, -1);
  else if (k === "down" || k === "j" || k === "wheeldown") move(st, 1);
  else if (k === "pgup") move(st, -10);
  else if (k === "pgdn") move(st, 10);
  else if (k === "home" || k === "g") { st.sel = firstPick(); st.top = 0; }
  else if (k === "end" || k === "G") move(st, V.items.length);
  else if (k === "tab") cycle(st, 1);
  else if (k === "\x1b[Z") cycle(st, -1);
  else if (k === " " || k === "right" || k === "left") fold(st, k === " " ? -1 : k === "right" ? 1 : 0);
  else if (k === "enter") enter(st);
  else if (k === "[") { st.side = 0; say("info", "side A: ↵ drills into group A"); }
  else if (k === "]") { st.side = 1; say("info", "side B: ↵ drills into group B"); }
  else if (k === "o") openSide(st, st.side);
  else if (k === "1") openSide(st, 0);
  else if (k === "2") openSide(st, 1);
  else if (k === "a") { S.inputErr = ""; cyc.cands = []; ask("group A", "cmp-a", print(st.A.cs)); }
  else if (k === "b") { S.inputErr = ""; cyc.cands = []; ask("group B", "cmp-b", print(st.B.cs)); }
  else if (k === "x") swap(st);
  else if (k === "t") triageAB(st);
  else if (k === "S") { st.subs = !st.subs; changed(st); say("info", st.subs ? "subagents included" : "subagents excluded"); }
  else return k !== "?";
  return true;
}

// ── registration ──
H.views.push({ name: CV_NAME, render });
H.keys.push((mode: string, k: string): boolean => {
  if (mode === "transcript" && V.inTx && (k === "esc" || k === "q" || k === "left")) { S.tv = null; S.mode = "view"; S.fview = CV_NAME; V.inTx = false; return true; }
  const st = CV.st;
  if (mode !== "view" || S.fview !== CV_NAME || !st) return false;
  return keyView(st, k);
});
H.mouse.push((mode: string, b: number, x: number, y: number, press: boolean): boolean => {
  const st = CV.st;
  if (mode !== "view" || S.fview !== CV_NAME || !st || y === S.H - 1) return false;
  if (b === 64 || b === 65) { keyView(st, b === 64 ? "wheelup" : "wheeldown"); return true; }
  if (!press || b !== 0) return b === 0 && press;
  if (y === 2) { // the section tabs
    let cx = 1; for (let i = 0; i < SECS.length; i++) { if (i === TL && !hasTimeline(st)) continue; const w = width(secName(i, S.W)) + 2; if (x >= cx && x < cx + w) { st.sec = i; st.sel = 0; st.top = 0; } cx += w + 1; }
    return true;
  }
  const i = st.top + (y - 1 - V.rowY0);
  if (y - 1 >= V.rowY0 && i < st.top + V.rowN) { const it = itemAt(i); if (it && pickable(it)) { if (i === st.sel) enter(st); else st.sel = i; } }
  return true;
});
let pumping = false;
function pump(): void { if (pumping) return; pumping = true; setTimeout(slice, GAP); }
function slice(): void {
  pumping = false;
  const st = CV.st;
  if (!st || S.fview !== CV_NAME || (S.mode !== "view" && S.mode !== "help" && S.mode !== "input") || !counting()) return;
  try { ensure(st, SLICE); } catch (e) { V.job = null; V.stale = false; say("err", "compare count failed: " + String(e)); }
  S.dirty = true;
  if (counting()) pump();
}
// a / b: a group's expression, live validation and tab completion; an error keeps the input open
const cyc = newCyc();
function groupErr(t: string): string { return exprErr(t, "list", "type an expression, e.g. model ~ opus or session is claude:abc123"); }
H.input.push((action: string, ev: string, text: string): boolean => {
  if (action !== "cmp-a" && action !== "cmp-b") return false;
  const st = CV.st; if (!st) return false;
  if (ev === "change") { S.inputErr = text.trim() ? groupErr(text) : ""; if (!text.trim()) S.inputErrCol = -1; if (text !== cyc.last) cyc.cands = []; return false; }
  if (ev === "tab") { const next = cycleNext(cyc, text); if (next) { S.inputText = next; S.inputErr = groupErr(next); } return false; }
  if (ev === "esc") { S.inputErr = ""; return false; }
  if (ev !== "enter") return false;
  const r = groupOfExpr(text); const g = r.g;
  if (!g) { S.inputErr = groupErr(text) || (r.err ? r.err.msg : "invalid expression"); return true; } // groupErr: the column too
  if (action === "cmp-a") st.A = g; else st.B = g;
  st.note = ""; changed(st);
  return false;
});
H.footerHints.push((mode: string): string[][] => {
  const st = CV.st;
  if (mode !== "view" || S.fview !== CV_NAME || !st) return [];
  const o: string[][] = [["tab", "section"], ["↑↓", "row"]];
  if (st.sec === 1) { o.push(["↵", "drill-down"]); o.push(["␣", "fold"]); o.push(["[/]", "side"]); }
  if (st.sec === 4) o.push(["↵", "open file"]);
  o.push(["a/b", "edit group"]); o.push(["x", "swap"]); o.push(["S", "subagents"]); o.push(["t", "triage"]);
  if (st.A.single || st.B.single) o.push(["1/2", "transcript"]);
  return o;
});
H.helpSections.push({ name: "compare", ctx: CV_NAME, keys: [
  ["m  C", "Sessions: mark A / B · compare (marks, mark vs selected, or the previous run of the repo)"], ["C", "Stats: this period vs the previous one"],
  ["tab  ⇧tab", "section: summary, tools, programs, commands, files, models, skills, timeline (two sessions)"], ["↑↓ jk", "select a row"],
  ["↵", "tools: Stats drill-down (tool or MCP server) for the side · files: open in $PAGER"], ["[  ]", "side for ↵ and o: A / B"], ["␣  → ←", "fold / unfold an MCP server"],
  ["o  1  2", "transcript of the side's / A's / B's session (single sessions)"], ["a  b", "edit group A / B (filter grammar, tab completes)"],
  ["x", "swap A and B"], ["S", "subagents in / out of both groups"], ["t", "triage: what is different about A vs B"], ["esc", "back"],
  ["", "Δ = B − A; red: more cost, errors or duration · B/A from 100 columns, Δ from 80"]] });
