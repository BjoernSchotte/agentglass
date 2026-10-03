// agentglass — triage view: full-screen ranking of over-/under-represented values, include/exclude/pin, guards (spec §5)
// SPDX-License-Identifier: Apache-2.0
// Opened with t from Sessions, Stats and the Stats drill-down (or by session-compare). A key changes the run at once; the
// recount (≈1 s for 30 days of call rows) runs in slices between frames: the old table stays, the header shows progress,
// keys stay live and a newer key replaces the count in flight.
import type { Sess } from "../../model/types.ts";
import { S, say } from "../../state.ts";
import { H, tabAt } from "../../hooks.ts";
import { clean, fit, fitStyled, fillTo, width, vwidth } from "../../util/text.ts";
import { titleOf } from "../../model/sessions.ts";
import { ask } from "../../actions.ts";
import { C, CSI, RST, fg, bg } from "../../ui/theme.ts";
import { put, spin } from "../../ui/screen.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { harnessOf } from "../../harness/index.ts";
import type { Call } from "../usage/facts.ts";
import { localOf } from "../usage/facts.ts";
import { fmtMs } from "../usage/calls.ts";
import { grp } from "../usage/costs.ts";
import { L } from "../usage/record.ts";
import { statsDrillTool, statsPeriod } from "../usage/stats.ts";
import type { Clause } from "../query/types.ts";
import { parse, print, printClause, sameClause } from "../query/parse.ts";
import { compile, eachCall } from "../query/eval.ts";
import { addClause, addAll, effective, localFor, setLocal, setPins } from "../query/scope.ts";
import { complete } from "../query/ui.ts";
import { type TRow, rank, fmtLift, fmtPct, chiStr } from "./score.ts";
import { type Run, type Result, type TJob, PRESETS, presetOf, newRun, triageJob, triageStep, triageProgress, triageCfg, periodOf, periodLabel, guardText, shown, slowKeep, without } from "./run.ts";

export const TV_NAME = "triage";
export interface TState { run: Run; res: Result | null; sel: number; top: number; expand: string; picker: boolean; calls: string /* attr\tvalue whose newest calls are listed, "" none */; csel: number; back: () => void }
export const T: { st: TState | null } = { st: null };

// ── state beside TState: the listed rows, the newest-calls list, recount bookkeeping ──
interface CR { s: Sess; c: Call }
const V = { rows: [] as TRow[], rowsOf: "", calls: [] as CR[], stale: true, job: null as TJob | null, at: 0, ver: -1, want: "", inTx: false, rowY0: 0, rowN: 0 };
// ms of counting: a little in the frame after a key (small counts then finish without a spinner), then slices on a timer of
// their own with the event loop free in between (the refresh jobs' 5% budget would stretch a 1 s count to 20 s)
const SLICE_FRAME = 15; const SLICE = 40; const GAP = 10;
const incOrigin: string[] = []; const incFn: ((c: Clause) => string)[] = []; // scriptc: no function values in a Map
// a non-tab origin (session-compare's "Compare") receives the +/- clauses; fn returns the toast
export function onInclude(origin: string, fn: (c: Clause) => string): void {
  const i = incOrigin.indexOf(origin);
  if (i >= 0) incFn[i] = fn; else { incOrigin.push(origin); incFn.push(fn); }
}

function rowKey(r: TRow): string { return r.attr + "\t" + r.value; }
function rowAt(i: number): TRow | null { return i >= 0 && i < V.rows.length ? V.rows[i] : null; }
function crAt(i: number): CR | null { return i >= 0 && i < V.calls.length ? V.calls[i] : null; }
// a selection to rank: nothing to count while the picker waits for the first choice
function idle(st: TState): boolean { return st.picker && !st.run.sel.length && !st.run.slow && st.run.preset === 0; }
// the run changed: keep the cursor's (attr, value) and recount on the next tick
function changed(st: TState): void { const r = rowAt(st.sel); if (r) V.want = rowKey(r); V.stale = true; st.calls = ""; S.dirty = true; }
// recount (when stale, or the ledger moved: every 2 s while indexing, every 10 s otherwise) for up to `ms` (Infinity = to
// the end), then re-rank; until a count finishes, st.res stays the previous result
function ensure(st: TState, ms: number): void {
  if (idle(st)) { st.res = null; V.rows = []; V.rowsOf = ""; V.job = null; V.stale = false; return; }
  const moved = L.ver !== V.ver && Date.now() - V.at >= (L.done < L.total ? 2000 : 10000);
  if (V.stale || (!V.job && (moved || !st.res))) { V.job = triageJob(st.run); V.stale = false; V.at = Date.now(); V.ver = L.ver; }
  const j = V.job;
  if (j && triageStep(j, ms === Infinity ? Infinity : Date.now() + ms)) { st.res = j.res; V.job = null; V.rowsOf = ""; }
  const res = st.res; if (!res) return;
  const k = res.key + "|" + String(V.at) + "|" + String(st.run.under) + "|" + st.expand;
  if (k === V.rowsOf) return;
  V.rowsOf = k;
  V.rows = res.guard ? [] : rank(res.rows, st.run.under, 3, triageCfg().minSupport, st.expand);
  if (V.want) { for (let i = 0; i < V.rows.length; i++) if (rowKey(V.rows[i]) === V.want) st.sel = i; V.want = ""; }
  st.sel = Math.max(0, Math.min(st.sel, V.rows.length - 1));
}

export function openTriage(r: Run, back: () => void): void {
  T.st = { run: r, res: null, sel: 0, top: 0, expand: "", picker: false, calls: "", csel: 0, back };
  V.stale = true; V.job = null; V.rows = []; V.rowsOf = ""; V.calls = []; V.want = ""; V.inTx = false;
  S.fview = TV_NAME; S.mode = "view"; S.dirty = true;
}
function leave(st: TState): void { st.calls = ""; st.picker = false; V.job = null; V.stale = true; const b = st.back; b(); }
function counting(): boolean { return !!V.job || V.stale; }

// ── text helpers ──
function expr(cs: Clause[]): string { const o: string[] = []; for (const c of cs) { const vs: string[] = []; for (const v of c.vals) vs.push(shown(c.key, v)); o.push(printClause({ key: c.key, op: c.op, vals: vs, neg: c.neg, pinned: c.pinned })); } return o.join(" and "); }
function rp(s: string, w: number): string { const n = width(s); return n >= w ? fit(s, w) : " ".repeat(w - n) + s; }
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
function bar(frac: number, w: number, col: string): string {
  const e = Math.round(Math.max(0, Math.min(1, frac)) * w * 8); const full = Math.floor(e / 8);
  const s = "█".repeat(full) + (full < w ? EIGHTHS[e % 8] ?? "" : "");
  return fg(col) + s + RST + " ".repeat(Math.max(0, w - width(s)));
}
function line(s: string, W: number): string { const f = fitStyled(s, W); return f + fillTo(f, W); }
function plainOf(s: string): string { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); }
const MULTI_CALL = ["program", "ext", "file"]; const MULTI_SESS = ["tool", "program", "ext", "model"];
function entWord(r: Run): string { return r.entity === "call" ? "calls" : "sessions"; }

// ── layout: H − 2 lines (rows 1 … H−2 of the screen), styled ──
function header(st: TState, W: number): string {
  const r = st.run; const res = st.res;
  const k = (key: string, v: string): string => fg(C.accent) + key + RST + fg(C.sub) + " " + v + RST;
  const right = k("b", r.base) + fg(C.dim) + " · " + RST + k("e", entWord(r)) + fg(C.dim) + " · " + RST + k("c", r.weight);
  const sel = res ? res.selLabel : "choose a selection"; const base = res ? res.baseLabel : "";
  let left = fg(C.accent) + CSI + "1m" + "triage" + RST + fg(C.dim) + " · " + RST + fg(C.text) + (res && res.selLabel === print(r.sel) ? expr(r.sel) : sel) + RST;
  if (res) left += fg(C.sub) + " (" + grp(res.selN) + ")" + RST + fg(C.dim) + " vs " + RST + fg(C.text) + (r.base === "group" ? expr(r.group) : base) + RST + fg(C.sub) + " (" + grp(res.baseN) + ")" + RST;
  left += fg(C.dim) + " · " + RST + fg(C.sub) + periodLabel(r.days) + RST;
  const sc = without(r.scope, r.dropped);
  if (sc.length) left += fg(C.dim) + " · scope: " + RST + fg(C.sub) + expr(sc) + RST;
  if (r.dropped.length) left += fg(C.dim) + " · dropped: " + CSI + "9m" + expr(r.dropped) + RST;
  let rt = right;
  if (counting() && !idle(st)) {
    // progress in a fixed place: no banner line comes and goes, the rows do not move
    const j = V.job; const p = fg(C.accent) + spin() + RST + fg(C.sub) + " counting " + String(Math.floor((j ? triageProgress(j) : 0) * 100)).padStart(3) + "%" + RST;
    rt = W - 2 - vwidth(p + " · " + right) - 2 >= 30 ? p + fg(C.dim) + " · " + RST + right : p;
  }
  const rw = vwidth(rt); const room = W - 2 - rw - 2;
  if (room < 30 && rt === right) return " " + line(left, W - 2) + " ";
  const l = fitStyled(left, Math.max(0, room));
  return " " + l + fillTo(l, Math.max(0, room)) + "  " + rt + " ";
}
interface Cols { aw: number; vw: number; bw: number; chi: boolean; baseBar: boolean }
function cols(W: number, weighted: boolean): Cols {
  const chi = W >= 100; const baseBar = W >= 80; const aw = 10;
  const vw = Math.max(10, Math.min(30, Math.floor(W * 0.2)));
  const fixed = 1 + aw + 2 + vw + 2 + 7 + 2 + 7 + 2 + 7 + (chi ? (weighted ? 27 : 9) : 0) + 1;
  const bars = W - fixed; const bw = Math.max(3, Math.min(24, baseBar ? Math.floor((bars - 2) / 2) : bars - 1));
  return { aw, vw, bw, chi, baseBar };
}
function colHeader(st: TState, c: Cols, W: number): string {
  const weighted = st.run.weight !== "count";
  const l = " " + fit("attribute", c.aw) + "  " + fit("value", c.vw) + "  " + fit("selection", c.bw + 8) + "  " + fit("baseline", (c.baseBar ? c.bw + 1 : 0) + 7) + "  " + rp("lift", 7) +
    (c.chi ? "  " + (weighted ? "weighted, no significance" : rp("χ²", 7)) : "");
  return fg(C.dim) + line(l, W) + RST;
}
function rowLine(st: TState, r: TRow, c: Cols, mx: number, first: boolean, on: boolean, W: number): string {
  const s = r.s; const b = on ? bg(C.sel) : "";
  const pct = (p: number): string => rp(fmtPct(p), 6);
  const chi = !c.chi ? "" : s.chi2 < 0 ? "" : "  " + (s.sig ? fg(C.accent) + "●" + RST + b : " ") + fg(s.sig ? C.text : C.sub) + rp(chiStr(s.chi2), 6) + RST + b;
  const liftCol = s.lift < 0 || s.lift >= 1 ? C.text : C.sub;
  const l = b + " " + fg(first ? C.sub : C.dim) + fit(first ? r.attr : "", c.aw) + RST + b + "  " + fg(C.text) + (on ? CSI + "1m" : "") + fit(shown(r.attr, r.value), c.vw) + RST + b + "  " +
    bar(mx > 0 ? s.pS / mx : 0, c.bw, C.accent) + b + " " + fg(C.text) + pct(s.pS) + RST + b + "  " +
    (c.baseBar ? bar(mx > 0 ? s.pB / mx : 0, c.bw, C.dim) + b + " " : "") + fg(C.sub) + pct(s.pB) + RST + b + "  " + fg(liftCol) + rp(fmtLift(s), 7) + RST + b + chi;
  return line(l, W) + RST;
}
function pickerLines(st: TState, W: number): string[] {
  const o: string[] = [" " + fg(C.text) + CSI + "1m" + "what should triage look at?" + RST, ""];
  for (const p of PRESETS) {
    const what = p.n === 7 ? "type an expression (tab completes)" : p.slow ? "duration ≥ the p90 of the same tool" : p.n === 6 ? "scope this period vs the previous one" : print(p.sel());
    o.push(line("   " + fg(C.accent) + CSI + "1m" + String(p.n) + RST + "  " + fg(C.text) + fit(p.name, 22) + RST + fg(C.sub) + fit(what, 44) + RST + fg(C.dim) + (p.n === 6 ? "previous period" : "vs the rest") + " · " + p.entity + RST, W));
  }
  o.push(""); o.push(" " + fg(C.dim) + "1–7 choose · esc " + (idle(st) ? "back" : "keep the current selection") + RST);
  return o;
}
function callLines(st: TState, W: number, n: number): string[] {
  const i = st.calls.indexOf("\t"); const attr = st.calls.slice(0, i); const v = st.calls.slice(i + 1);
  const o: string[] = [fg(C.dim) + line(" newest calls · " + attr + " is " + shown(attr, v) + " · ↵ opens the transcript at the call · esc back", W) + RST];
  if (!V.calls.length) { o.push(" " + fg(C.sub) + "no matching calls in the period" + RST); return o; }
  const wk = st.run.days > 1;
  for (let k = 0; k < V.calls.length && o.length < n; k++) {
    const x = V.calls[k]; const on = k === st.csel; const b = on ? bg(C.sel) : "";
    const l = localOf(x.c.t); const d = new Date(x.c.t);
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    const ad = harnessOf(x.s.h);
    const st1 = x.c.err === 1 ? fg(C.red) + "✗" : x.c.err === 0 ? fg(C.green) + "✓" : fg(C.dim) + "?";
    o.push(line(b + " " + fg(C.sub) + (wk ? l.day.slice(5) + " " : "") + hm + RST + b + "  " + fg(C.text) + rp(x.c.ms >= 0 ? fmtMs(x.c.ms) : "—", 7) + RST + b + "  " + st1 + RST + b + "  " +
      fg(ad.color()) + ad.mark + RST + b + " " + fg(C.text) + clean(titleOf(x.s)) + RST, W) + RST);
  }
  return o;
}
function banners(st: TState, res: Result): string[] {
  const o: string[] = []; const r = st.run;
  if (res.partial) o.push(fg(C.yellow) + spin() + " partial: still indexing · refreshes every 2 s" + RST);
  if (res.small && !res.guard) o.push(fg(C.yellow) + "small sample: " + grp(Math.min(res.selN, res.baseN)) + " rows, percentages are unreliable" + RST);
  if (r.weight === "cost" && res.unpriced > 0) o.push(fg(C.sub) + "+" + grp(res.unpriced) + " unpriced (cost 0)" + RST);
  const multi: string[] = []; for (const d of res.dimsUsed) if ((r.entity === "call" ? MULTI_CALL : MULTI_SESS).indexOf(d) >= 0) multi.push(d);
  if (multi.length && !res.guard) o.push(fg(C.dim) + multi.join(", ") + ": shares of " + entWord(r) + " with ≥ 1 value, they may sum over 100%" + RST);
  return o;
}
function build(st: TState, W: number, Ht: number, sync: boolean): string[] {
  if (sync) ensure(st, Infinity);
  const n = Math.max(1, Ht - 2); const out: string[] = [header(st, W)];
  const c = cols(W, st.run.weight !== "count");
  const res = st.res;
  if (st.picker || idle(st)) {
    for (const l of pickerLines(st, W)) out.push(l);
  } else if (!res) {
    // the first count of this triage: nothing to show yet but what is being counted
    out.push(colHeader(st, c, W)); out.push("");
    out.push(" " + fg(C.accent) + spin() + RST + fg(C.sub) + " counting " + entWord(st.run) + " · " + periodLabel(st.run.days) + " — keys work meanwhile" + RST);
  } else if (st.calls) {
    for (const l of callLines(st, W, n - 1)) out.push(l);
  } else {
    out.push(colHeader(st, c, W));
    const ban = banners(st, res);
    if (res.guard) {
      out.push(""); out.push(" " + fg(C.yellow) + guardText(st.run, res, false) + RST);
    } else if (!V.rows.length) {
      out.push(""); out.push(" " + fg(C.sub) + "no value reaches the minimum support (" + String(triageCfg().minSupport) + " " + entWord(st.run) + ", 1% of the selection)" + (st.run.days < 30 ? " — w / m widen the period" : "") + RST);
    } else {
      const room = Math.max(1, n - out.length - ban.length);
      if (st.sel < st.top) st.top = st.sel; else if (st.sel >= st.top + room) st.top = st.sel - room + 1;
      st.top = Math.max(0, Math.min(st.top, Math.max(0, V.rows.length - room)));
      let mx = 0; for (const r of V.rows) mx = Math.max(mx, r.s.pS, r.s.pB);
      V.rowY0 = out.length; V.rowN = Math.min(room, V.rows.length - st.top);
      for (let i = st.top; i < V.rows.length && i < st.top + room; i++) {
        const r = V.rows[i]; const prev = rowAt(i - 1);
        out.push(rowLine(st, r, c, mx, i === st.top || !prev || prev.attr !== r.attr, i === st.sel, W));
      }
    }
    while (out.length < n - ban.length) out.push("");
    for (const b of ban) out.push(" " + b);
  }
  while (out.length < n) out.push("");
  return out.slice(0, n);
}
// plain (ANSI-stripped) lines of the view at W × H, for checks (counts synchronously)
export function viewLines(st: TState, W: number, Ht: number): string[] { const o: string[] = []; for (const l of build(st, W, Ht, true)) o.push(plainOf(l)); return o; }
function render(): void {
  const st = T.st; if (!st) return;
  ensure(st, SLICE_FRAME);
  if (counting()) pump();
  const ls = build(st, S.W, S.H, false);
  for (let i = 0; i < ls.length; i++) put(0, 1 + i, ls[i] ?? "");
}

// ── actions ──
// the clause for the selected row; "" note when the value has no filter equivalent
function clauseOf(st: TState, r: TRow, neg: boolean): Clause | null {
  if (st.run.entity === "session" && (r.attr === "hour" || r.attr === "weekday")) return null; // the session's start: no filter key says that
  return { key: r.attr, op: neg ? "is_not" : "is", vals: [r.value], neg: false, pinned: false };
}
function isTab(o: string): boolean { return o === "Sessions" || o === "Stats"; }
// + / − on the selected row: into the origin tab's local filter (it stays there after triage), the run narrows; the toast
export function includeSel(neg: boolean): string {
  const st = T.st; if (!st) return "";
  ensure(st, 0); // the rows on screen: a count in flight does not block the key
  const r = rowAt(st.sel); if (!r) return "";
  const c = clauseOf(st, r, neg);
  if (!c) { const m = "the session start " + r.attr + " has no filter key — o lists these sessions"; say("warn", m); return m; }
  let msg = "";
  const ii = incOrigin.indexOf(st.run.origin);
  if (ii >= 0) { const fn = incFn[ii]; msg = fn(c); }
  else if (isTab(st.run.origin)) { const a = addClause(localFor(st.run.origin), c); setLocal(st.run.origin, a.cs); msg = st.run.origin + " filter: + " + printClause(c) + (a.note ? " (" + a.note + ")" : ""); }
  else msg = "+ " + printClause(c);
  st.run.scope = addClause(st.run.scope, c).cs; changed(st); V.want = rowKey(r);
  say("info", msg);
  return msg;
}
function pinSel(st: TState): void {
  const r = rowAt(st.sel); if (!r) return;
  const c = clauseOf(st, r, false); if (!c) { say("warn", "the session start " + r.attr + " has no filter key"); return; }
  const e = setPins(print(addClause(S.pins, c).cs)); if (e) { say("err", e.msg); return; }
  st.run.scope = addClause(st.run.scope, c).cs; changed(st); V.want = rowKey(r);
  say("info", "pinned: " + printClause(c) + " — P edits pins");
}
// o: the Sessions list filtered to scope ∧ selection ∧ value (pins apply there anyway)
function openSel(st: TState): void {
  const r = rowAt(st.sel); if (!r) return;
  const add: Clause[] = [];
  for (const c of without(st.run.scope, st.run.dropped)) { let pin = false; for (const p of S.pins) if (sameClause(p, c)) pin = true; if (!pin) add.push(c); }
  for (const c of st.run.sel) add.push(c);
  const c = clauseOf(st, r, false); if (c) add.push(c);
  const loc = addAll(localFor("Sessions"), add).cs;
  setLocal("Sessions", loc); S.tab = 0; S.mode = "list"; S.sel = 0;
  const why = st.run.slow ? "slow is not a filter — showing " + (c ? printClause(c) : "the scope") + ": " : !c ? "the session start " + r.attr + " has no filter key: " : "";
  say("info", why + "Sessions filter: " + expr(loc));
}
// enter on an expanded value: its newest 10 calls in the selection
function loadCalls(st: TState, r: TRow): void {
  const cs = without(st.run.scope, st.run.dropped).concat(st.run.sel, [{ key: r.attr, op: "is", vals: [r.value], neg: false, pinned: false }]);
  const f = compile(cs, "stats").f; const keep = st.run.slow ? slowKeep(st.run) : null;
  const all: CR[] = [];
  if (f) eachCall(f, periodOf(st.run.days, false), (s: Sess, c: Call) => { if (keep) { const k = keep; if (!k(s, c)) return; } all.push({ s, c }); });
  all.sort((a: CR, b: CR) => b.c.t - a.c.t);
  V.calls = all.slice(0, 10); st.calls = rowKey(r); st.csel = 0;
}
function openCall(st: TState): void {
  const x = crAt(st.csel); if (!x) return;
  openTranscript(x.s);
  const t = S.tv; if (t && x.c.cid) { t.focusKind = "tool"; t.focusTs = ""; t.focusText = x.c.cid; }
  V.inTx = true;
}
function choosePreset(st: TState, n: number): void {
  const p = presetOf(n); if (!p) return;
  if (n === 7) { ask("triage selection", "triage", print(st.run.sel)); return; }
  const r = st.run;
  r.preset = n; r.sel = p.sel(); r.slow = p.slow; r.base = p.base;
  if (n <= 5) r.entity = p.entity;
  if (p.slow) r.entity = "call";
  fixWeight(r); st.picker = false; st.expand = ""; changed(st);
}
function fixWeight(r: Run): void {
  if (r.entity === "call" && (r.weight === "cost" || r.weight === "tokens")) r.weight = "count";
  if (r.entity === "session" && r.weight === "duration") r.weight = "count";
}
function move(st: TState, d: number): void { st.sel = Math.max(0, Math.min(V.rows.length - 1, st.sel + d)); }
function guardKeys(st: TState, k: string): void {
  const res = st.res;
  if (k === "r") {
    if (!res || res.guard !== "empty-baseline" || !res.offending.length) { say("info", "r drops the clauses behind an empty baseline — there is none"); return; }
    st.run.dropped = st.run.dropped.concat(res.offending); changed(st);
    say("info", "dropped " + expr(res.offending) + " for this triage — R removes it for real");
    return;
  }
  const off = res && res.guard === "empty-baseline" && res.offending.length ? res.offending : st.run.dropped;
  if (!off.length) { say("info", "R removes the clauses behind an empty baseline — there are none"); return; }
  const o = st.run.origin;
  if (isTab(o)) setLocal(o, without(localFor(o), off));
  const e = setPins(print(without(S.pins, off))); if (e) { say("err", e.msg); return; }
  st.run.scope = without(st.run.scope, off); st.run.dropped = without(st.run.dropped, off); changed(st);
  say("info", "removed " + expr(off) + " from " + (isTab(o) ? o + "/" : "") + "pins");
}
function keyView(st: TState, k: string): boolean {
  if (st.picker) {
    if (k.length === 1 && k >= "1" && k <= "7") { choosePreset(st, Number(k)); return true; }
    if (k === "esc" || k === "q" || k === "bs") { if (idle(st)) leave(st); else st.picker = false; return true; }
    return k !== "?";
  }
  if (st.calls) {
    if (k === "up" || k === "k" || k === "wheelup") st.csel = Math.max(0, st.csel - 1);
    else if (k === "down" || k === "j" || k === "wheeldown") st.csel = Math.min(Math.max(0, V.calls.length - 1), st.csel + 1);
    else if (k === "enter" || k === "right") openCall(st);
    else if (k === "esc" || k === "q" || k === "bs" || k === "left") st.calls = "";
    else return k !== "?";
    return true;
  }
  const r = st.run;
  if (k === "esc" || k === "q" || k === "bs") { leave(st); return true; }
  if (k === "up" || k === "k" || k === "wheelup") move(st, -1);
  else if (k === "down" || k === "j" || k === "wheeldown") move(st, 1);
  else if (k === "pgup") move(st, -10);
  else if (k === "pgdn") move(st, 10);
  else if (k === "home" || k === "g") move(st, -V.rows.length);
  else if (k === "end" || k === "G") move(st, V.rows.length);
  else if (k === "enter" || k === "right") {
    const row = rowAt(st.sel); if (!row) return true;
    if (st.expand !== row.attr) { st.expand = row.attr; V.want = rowKey(row); V.rowsOf = ""; }
    else if (r.entity === "call") loadCalls(st, row);
    else say("info", "o lists these sessions");
  }
  else if (k === "left") { if (st.expand) { const row = rowAt(st.sel); if (row) V.want = rowKey(row); st.expand = ""; V.rowsOf = ""; } }
  else if (k === "+" || k === "=") includeSel(false);
  else if (k === "-" || k === "_") includeSel(true);
  else if (k === "p") pinSel(st);
  else if (k === "o") openSel(st);
  else if (k === "b") {
    if (r.slow) { say("info", "slow calls compare against the rest only"); return true; }
    r.base = r.base === "rest" ? "previous" : r.base === "previous" && r.group.length ? "group" : "rest"; changed(st);
  }
  else if (k === "e") {
    if (r.slow) { say("info", "slow calls are per call — s picks a session selection"); return true; }
    r.entity = r.entity === "call" ? "session" : "call"; fixWeight(r); st.expand = ""; changed(st);
  }
  else if (k === "c") {
    r.weight = r.entity === "call" ? (r.weight === "count" ? "duration" : "count") : r.weight === "count" ? "cost" : r.weight === "cost" ? "tokens" : "count"; changed(st);
  }
  else if (k === "u") { r.under = !r.under; st.sel = 0; st.top = 0; V.rowsOf = ""; }
  else if (k === "s") st.picker = true;
  else if (k === "d" || k === "w" || k === "m") { r.days = k === "d" ? 1 : k === "w" ? 7 : 30; changed(st); }
  else if (k === "r" || k === "R") guardKeys(st, k);
  else return k !== "?";
  return true;
}
// test helper: put the cursor on (attr, value) if it is listed; true when found
export function selectRow(attr: string, value: string): boolean {
  const st = T.st; if (!st) return false;
  ensure(st, Infinity);
  for (let i = 0; i < V.rows.length; i++) if (V.rows[i].attr === attr && V.rows[i].value === value) { st.sel = i; return true; }
  return false;
}

// ── t: Sessions (entity session), Stats (entity call), the Stats drill-down (that tool's errors) ──
function statsTab(): boolean { const t = tabAt(S.tab - 2); return !!t && t.name === "Stats"; }
function pinsScope(local: Clause[]): Clause[] { const e = effective(S.pins, local); return without(S.pins, e.struck); }
function openFrom(): void {
  const tab = S.tab;
  const back = (): void => { S.mode = "list"; S.tab = tab; };
  if (tab === 0) {
    const loc = localFor("Sessions");
    openTriage(newRun("Sessions", "session", pinsScope(loc), loc.slice(), 7), back);
  } else {
    const loc = localFor("Stats"); const tool = statsDrillTool(); const days = statsPeriod().length;
    if (tool) {
      const sv = tool.startsWith("mcp__") && tool.indexOf("__", 5) < 0;
      const sel: Clause[] = [{ key: sv ? "server" : "tool", op: "is", vals: [sv ? tool.slice(5) : tool], neg: false, pinned: false }, { key: "status", op: "is", vals: ["error"], neg: false, pinned: false }];
      openTriage(newRun("Stats", "call", effective(S.pins, loc).cs, sel, days), back);
    } else openTriage(newRun("Stats", "call", pinsScope(loc), loc.slice(), days), back);
  }
  const st = T.st;
  if (st && !st.run.sel.length) st.picker = true;
}

// ── registration ──
H.views.push({ name: TV_NAME, render });
H.keys.push((mode: string, k: string): boolean => {
  if (mode === "transcript" && V.inTx && (k === "esc" || k === "q" || k === "left")) { S.tv = null; S.mode = "view"; S.fview = TV_NAME; V.inTx = false; return true; }
  if (mode === "list" && k === "t" && (S.tab === 0 || statsTab())) { openFrom(); return true; }
  const st = T.st;
  if (mode !== "view" || S.fview !== TV_NAME || !st) return false;
  return keyView(st, k);
});
H.mouse.push((mode: string, b: number, x: number, y: number, press: boolean): boolean => {
  const st = T.st;
  if (mode !== "view" || S.fview !== TV_NAME || !st || y === S.H - 1) return false;
  if (b === 64 || b === 65) { keyView(st, b === 64 ? "wheelup" : "wheeldown"); return true; }
  if (!press || b !== 0 || st.picker || st.calls) return b === 0 && press;
  const i = st.top + (y - 1 - V.rowY0);
  if (y - 1 >= V.rowY0 && i < st.top + V.rowN) { if (i === st.sel) keyView(st, "enter"); else st.sel = i; }
  return true;
});
// a count in flight: SLICE ms of work, GAP ms for keys and frames, until done; it pauses outside the view (transcript, tabs)
let pumping = false;
function pump(): void { if (pumping) return; pumping = true; setTimeout(slice, GAP); }
function slice(): void {
  pumping = false;
  const st = T.st;
  if (!st || S.fview !== TV_NAME || (S.mode !== "view" && S.mode !== "help") || !counting()) return;
  try { ensure(st, SLICE); } catch (e) { V.job = null; V.stale = false; say("err", "triage count failed: " + String(e)); }
  S.dirty = true;
  if (counting()) pump();
}
// the typed selection (preset 7): live validation, tab completion
let cycBase = ""; let cycCands: string[] = []; let cycI = 0; let cycLast = "";
function exprErr(t: string): string { if (!t.trim()) return "type a selection, e.g. tool is Bash and status is error"; const p = parse(t); if (p.err) return p.err.msg; const c = compile(p.cs, "stats"); return c.err ? c.err.msg : ""; }
H.input.push((action: string, ev: string, text: string): boolean => {
  if (action !== "triage") return false;
  const st = T.st; if (!st) return false;
  if (ev === "change") { S.inputErr = text.trim() ? exprErr(text) : ""; if (text !== cycLast) cycCands = []; return false; }
  if (ev === "tab") {
    if (cycCands.length && text === cycLast) cycI = (cycI + 1) % cycCands.length;
    else { const cs = complete(text, true); if (!cs.length) return false; const m = /\S*$/.exec(text); const cur = m ? m[0] : ""; cycBase = text.slice(0, text.length - cur.length); cycCands = cs; cycI = 0; }
    const next = cycBase + (cycCands[cycI] ?? "") + " "; S.inputText = next; cycLast = next; S.inputErr = exprErr(next);
    return false;
  }
  if (ev === "esc") { S.inputErr = ""; return false; }
  if (ev !== "enter") return false;
  const e = exprErr(text); if (e) { S.inputErr = e; return true; }
  const r = st.run; r.sel = parse(text).cs; r.preset = 7; r.slow = false; if (r.base === "group" && !r.group.length) r.base = "rest";
  st.picker = false; st.expand = ""; changed(st);
  return false;
});
H.footerHints.push((mode: string): string[][] => {
  if (mode === "list" && (S.tab === 0 || statsTab())) return [["t", "triage"]];
  const st = T.st;
  if (mode !== "view" || S.fview !== TV_NAME || !st) return [];
  if (st.picker) return [["1-7", "selection"]];
  if (st.calls) return [["↑↓", "call"], ["↵", "transcript"]];
  const res = st.res;
  if (res && res.guard === "empty-baseline") return [["r", "drop here"], ["R", "remove for real"], ["b", "baseline"], ["s", "selection"]];
  return [["↑↓", "value"], ["↵", "expand"], ["+", "include"], ["-", "exclude"], ["p", "pin"], ["o", "open"], ["b", "baseline"], ["e", "entity"], ["c", "weight"], ["u", "under"], ["s", "selection"], ["d/w/m", "period"]];
});
H.helpSections.push({ name: "triage", ctx: TV_NAME, keys: [
  ["t", "triage: Sessions (sessions), Stats (calls), Stats drill-down (that tool's errors)"],
  ["", "ranks values over-represented in the selection vs the baseline; ● = χ² ≥ 6.63 (p < 0.01)"],
  ["↑↓ jk", "select a value"], ["↵  →", "all values of the attribute · again: its newest calls (↵ opens the transcript)"], ["←", "fold the attribute"],
  ["+  -", "include / exclude the value in the origin tab's filter (stays after esc)"], ["p", "pin the value (all tabs)"],
  ["o", "Sessions list filtered to the selection and the value"],
  ["b", "baseline: rest → previous period (→ group from compare)"], ["e", "entity: calls ⇄ sessions"],
  ["c", "weight: count / duration (calls) · count / cost / tokens (sessions)"], ["u", "over- ⇄ under-represented"],
  ["s  1–7", "selection: errored, slow, long calls · expensive, failing sessions · period vs last · custom"],
  ["d  w  m", "period: today, 7 days, 30 days"], ["r  R", "empty baseline: drop its clauses here / from the tab and pins"], ["esc", "back"],
  ["", "config triage.longCall (30s), triage.expensiveUsd (5), triage.minSupport (3)"]] });
