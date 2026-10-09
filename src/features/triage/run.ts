// agentglass — triage runs: selection vs baseline groups (rest, previous period, explicit group), presets, slow, guards (spec §1–§4)
// SPDX-License-Identifier: Apache-2.0
// Both groups come from filter-language aggregate() over one dimension list; "rest" is always scope − selection via minus(),
// never a negated expression (the grammar has no OR, so ¬(a ∧ b) cannot be written).
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { say } from "../../state.ts";
import { display } from "../../hooks.ts";
import { type Obj } from "../../util/json.ts";
import { section } from "../../util/config.ts";
import { L, lastDays, startOfDay } from "../usage/record.ts";
import { callDays } from "../usage/callcache.ts";
import type { Rows } from "../usage/rows.ts";
import { DICT, nameOf } from "../usage/facts.ts";
import { pct } from "../usage/calls.ts";
import type { Clause } from "../query/types.ts";
import { parse, print, sameClause } from "../query/parse.ts";
import { attrOf } from "../query/attrs.ts";
import { type Compiled, EMPTY, compile, matchSession, numOf, callCutoff } from "../query/eval.ts";
import { type Dist, type Weight, type Bin, type AggJob, aggJob, aggStep, minus } from "../query/agg.ts";
import { type TRow, score, wscore } from "./score.ts";

export type Base = "rest" | "previous" | "group";
export type Guard = "" | "empty-baseline" | "empty-selection" | "small-sample" | "retention";
export interface Run {
  entity: "call" | "session"; scope: Clause[]; sel: Clause[]; slow: boolean; preset: number /* 1..7, 0 = from origin */;
  base: Base; group: Clause[] /* base "group" only */; days: number /* period length: 1, 7 or 30 */; weight: Weight; under: boolean;
  origin: string /* "Sessions" | "Stats" | "Compare" */; dropped: Clause[] /* removed by `r` for this triage only */;
}
export interface Result {
  key: string; selN: number; baseN: number; rows: TRow[] /* every scored (attr, value) with a > 0 in the used dims; rank() filters and orders */; guard: Guard; small: boolean;
  offending: Clause[]; partial: boolean; from: string; to: string; unpriced: number; selLabel: string; baseLabel: string; dimsUsed: string[];
}
export interface Preset { n: number; name: string; entity: "call" | "session"; sel: () => Clause[]; slow: boolean; base: Base }

// ── config: triage.longCall (duration, a number = seconds), triage.expensiveUsd (> 0), triage.minSupport (integer ≥ 1) ──
export interface TriageCfg { longCall: string; expensiveUsd: number; minSupport: number; warn: string }
export function parseTriageCfg(o: Obj): TriageCfg {
  const bad: string[] = [];
  let longCall = "30s"; const lc = o["longCall"];
  if (typeof lc === "number") { const n = lc as number; if (n > 0) longCall = String(n) + "s"; else bad.push("longCall"); }
  else if (typeof lc === "string") { const v = (lc as string).trim(); const ms = numOf("dur", v); if (ms > 0 && /[a-z]$/i.test(v)) longCall = v; else bad.push("longCall"); }
  else if (lc !== undefined) bad.push("longCall");
  let expensiveUsd = 5; const eu = o["expensiveUsd"];
  if (typeof eu === "number" && (eu as number) > 0) expensiveUsd = eu as number; else if (eu !== undefined) bad.push("expensiveUsd");
  let minSupport = 3; const ms = o["minSupport"];
  if (typeof ms === "number" && Number.isInteger(ms as number) && (ms as number) >= 1) minSupport = ms as number; else if (ms !== undefined) bad.push("minSupport");
  const ks: string[] = []; for (const b of bad) ks.push("triage." + b);
  return { longCall, expensiveUsd, minSupport, warn: ks.length ? "config " + ks.join(", ") + " invalid — using defaults" : "" };
}
let cfg: TriageCfg | null = null;
// checks: a fixed config instead of ~/.agentglass/config.json
export function useTriageCfg(c: TriageCfg): void { cfg = c; }
export function triageCfg(): TriageCfg {
  const c = cfg; if (c) return c;
  const n = parseTriageCfg(section("triage")); cfg = n;
  if (n.warn) say("warn", n.warn);
  return n;
}

function P(src: string): Clause[] { return parse(src).cs; }
function none(): Clause[] { const o: Clause[] = []; return o; }
// spec §2; the 7th selection is the typed expression
export const PRESETS: Preset[] = [
  { n: 1, name: "errored calls", entity: "call", sel: () => P("status is error"), slow: false, base: "rest" },
  { n: 2, name: "slow calls", entity: "call", sel: none, slow: true, base: "rest" },
  { n: 3, name: "long calls", entity: "call", sel: () => P("duration > " + triageCfg().longCall), slow: false, base: "rest" },
  { n: 4, name: "expensive sessions", entity: "session", sel: () => P("cost > " + String(triageCfg().expensiveUsd)), slow: false, base: "rest" },
  { n: 5, name: "failing sessions", entity: "session", sel: () => P("error_rate > 20% and tools >= 10"), slow: false, base: "rest" },
  { n: 6, name: "this period vs last", entity: "call", sel: none, slow: false, base: "previous" },
  { n: 7, name: "custom", entity: "call", sel: none, slow: false, base: "rest" },
];
export function presetOf(n: number): Preset | null { return n >= 1 && n <= PRESETS.length ? PRESETS[n - 1] : null; }

export function newRun(origin: string, entity: "call" | "session", scope: Clause[], sel: Clause[], days: number): Run {
  return { entity, scope, sel, slow: false, preset: 0, base: "rest", group: [], days, weight: "count", under: false, origin, dropped: [] };
}

const CALL_DIMS = ["tool", "server", "program", "ext", "model", "repo", "harness", "agent", "hour", "weekday", "branch", "status", "file"];
const SESS_DIMS = ["harness", "repo", "model", "agent", "branch", "tool", "program", "ext", "weekday", "hour", "state", "subagent"];
export function dimsFor(r: Run): string[] { return r.entity === "call" ? CALL_DIMS : SESS_DIMS; }
// the values an equality clause of the selection fixes, "attr\tvalue" lowercased. Against the rest or the previous period
// their rows only restate the selection (`tool is Bash` → "tool Bash 100% vs 0%", `status is error` → status 100%), so they
// are not listed; the attribute's other values stay: `program is npm` still shows which programs run beside npm.
// A group baseline (compare) is another expression: there the shares are an answer.
function fixedVals(r: Run): Set<string> {
  const o = new Set<string>(); if (r.base === "group") return o;
  for (const c of r.sel) {
    const a = attrOf(c.key);
    if (!a || c.neg || (c.op !== "is" && c.op !== "is_one_of")) continue;
    for (const v of c.vals) if (v.indexOf("*") < 0) o.add(a.key + "\t" + v.toLowerCase());
  }
  return o;
}
// local day keys oldest first: the last `days` days, or the `days` before them
export function periodOf(days: number, previous: boolean): string[] { return previous ? lastDays(days * 2).slice(0, days) : lastDays(days); }
export function periodLabel(days: number): string { return days === 1 ? "today" : String(days) + " days"; }

export function without(cs: Clause[], drop: Clause[]): Clause[] {
  const o: Clause[] = [];
  for (const c of cs) { let d = false; for (const x of drop) if (sameClause(c, x)) d = true; if (!d) o.push(c); }
  return o;
}
function concat(a: Clause[], b: Clause[]): Clause[] { return a.concat(b); }
function F(cs: Clause[]): Compiled { if (!cs.length) return EMPTY; const r = compile(cs, "stats"); return r.f ?? EMPTY; }
// f restricted to the sessions that match sel in days (session entity): the selection's sessions are then described whole
// (all their tools, programs, …), not only by the rows that made them match
function within(f: Compiled, sel: Compiled, days: string[]): Compiled {
  const sess = f.sess.concat([(s: Sess): boolean => matchSession(sel, s, days)]);
  return { key: f.key + " ∧ ⊂[" + sel.key + "@" + days.join(",") + "]", cs: f.cs, sess, day: f.day, call: f.call, event: f.event, ev: f.ev, evLift: f.evLift, content: f.content, dayKeys: f.dayKeys, rowx: f.rowx, needsCalls: f.needsCalls, dimmed: f.dimmed };
}
function groupJob(r: Run, scopeF: Compiled, cs: Clause[], days: string[], dims: string[]): AggJob {
  if (!cs.length) return aggJob(scopeF, r.entity, days, dims, r.weight, null);
  const gf = F(concat(without(r.scope, r.dropped), cs));
  return r.entity === "session" ? aggJob(within(scopeF, gf, days), "session", days, dims, r.weight, null) : aggJob(gf, "call", days, dims, r.weight, null);
}
// the counts a run needs, in order (a later one may read an earlier result: slow needs the per-tool p90 first)
interface Groups { plan: ((got: Dist[][]) => AggJob)[]; sel: (got: Dist[][]) => Dist[]; base: (got: Dist[][]) => Dist[] }
function at(got: Dist[][], i: number): Dist[] { return i < got.length ? got[i] : []; }
function groups(r: Run, dims: string[]): Groups {
  const scopeF = F(without(r.scope, r.dropped));
  const days = periodOf(r.days, false);
  if (r.base === "previous" || r.base === "group") {
    const other = r.base === "group" ? r.group : r.sel; const od = r.base === "group" ? days : periodOf(r.days, true);
    return { plan: [() => groupJob(r, scopeF, r.sel, days, dims), () => groupJob(r, scopeF, other, od, dims)], sel: (g: Dist[][]) => at(g, 0), base: (g: Dist[][]) => at(g, 1) };
  }
  if (r.slow && r.entity === "call") {
    // untimed calls (fx, kiro, unfinished) are in neither group
    return { plan: [() => p90Job(r), () => aggJob(scopeF, "call", days, dims, r.weight, (s: Sess, r: Rows, i: number) => r.ms[i] >= 0), (g: Dist[][]) => aggJob(scopeF, "call", days, dims, r.weight, slowFrom(at(g, 0)))],
      sel: (g: Dist[][]) => at(g, 2), base: (g: Dist[][]) => minus(at(g, 1), at(g, 2)) };
  }
  return { plan: [() => aggJob(scopeF, r.entity, days, dims, r.weight, null), () => groupJob(r, scopeF, r.sel, days, dims)], sel: (g: Dist[][]) => at(g, 1), base: (g: Dist[][]) => minus(at(g, 0), at(g, 1)) };
}
// the slow test: duration ≥ the p90 of the same tool over scope and period (30 s is normal for Bash and alarming for Read)
function p90Job(r: Run): AggJob { return aggJob(F(without(r.scope, r.dropped)), "call", periodOf(r.days, false), ["tool"], "count", null); }
function slowFrom(tools: Dist[]): (s: Sess, r: Rows, i: number) => boolean {
  const p90 = new Map<string, number>();
  for (const d of tools) for (const [t, b] of d.vals) if (histN(b) > 0) p90.set(t, pct(b.hist, 0.9, b.max));
  return (s: Sess, r: Rows, i: number): boolean => r.ms[i] >= 0 && r.ms[i] >= (p90.get(nameOf(DICT.tool, r.tool[i] + 0)) ?? Infinity);
}
export function slowKeep(r: Run): (s: Sess, r: Rows, i: number) => boolean { const j = p90Job(r); aggStep(j, Infinity); return slowFrom(j.out); }
function histN(b: Bin): number { let n = 0; for (const x of b.hist) n += x; return n; }

export function labelOf(r: Run): string {
  if (r.slow) return "slow calls";
  const p = presetOf(r.preset);
  if (p && p.n >= 1 && p.n <= 5 && p.entity === r.entity) return p.name; // "errored calls" on session rows: the expression says it
  if (!r.sel.length) return r.base === "previous" ? (r.entity === "call" ? "calls" : "sessions") + " · " + periodLabel(r.days) : "everything";
  return print(r.sel);
}
function baseLabelOf(r: Run): string { return r.base === "previous" ? "previous " + periodLabel(r.days) : r.base === "group" ? print(r.group) : "rest"; }
export function runKey(r: Run): string {
  return JSON.stringify([r.entity, print(without(r.scope, r.dropped)), print(r.sel), r.slow, r.preset, r.base, print(r.group), r.days, r.weight]);
}

const cache = new Map<string, { ver: number; at: number; res: Result }>();
// a count in slices: the TUI steps it between frames (keys stay live during a 30-day count), runTriage runs it to the end
export interface TJob { r: Run /* a copy: keys may change the view's run meanwhile */; key: string; ver: number; partial: boolean; g: Groups; got: Dist[][]; cur: AggJob | null; res: Result | null }
function copyRun(r: Run): Run {
  return { entity: r.entity, scope: r.scope.slice(), sel: r.sel.slice(), slow: r.slow, preset: r.preset, base: r.base, group: r.group.slice(), days: r.days, weight: r.weight, under: r.under, origin: r.origin, dropped: r.dropped.slice() };
}
// cached per (key, L.ver); while the ledger still indexes (L.ver moves constantly) recomputed at most every 2 s
export function triageJob(run: Run): TJob {
  const r = copyRun(run); const key = runKey(r); const hit = cache.get(key); const partial = L.done < L.total;
  const j: TJob = { r, key, ver: L.ver, partial, g: groups(r, dimsFor(r)), got: [], cur: null, res: null };
  if (hit && (hit.ver === L.ver || (partial && Date.now() - hit.at < 2000))) j.res = hit.res;
  return j;
}
// work until the clock reaches `until` (Infinity = to the end); true when j.res is set
export function triageStep(j: TJob, until: number): boolean {
  while (!j.res) {
    let c = j.cur;
    if (!c) { const mk = j.g.plan[j.got.length]; c = mk(j.got); j.cur = c; }
    if (!aggStep(c, until)) return false;
    j.got.push(c.out); j.cur = null;
    if (j.got.length >= j.g.plan.length) {
      const res = compute(j.r, j.key, j.partial, j.g.sel(j.got), j.g.base(j.got));
      if (cache.size > 32) cache.clear();
      cache.set(j.key, { ver: j.ver, at: Date.now(), res }); j.res = res;
    } else if (until !== Infinity && Date.now() >= until) return false;
  }
  return true;
}
// 0…1, for the progress shown while a count runs
export function triageProgress(j: TJob): number {
  if (j.res) return 1;
  const c = j.cur; const part = c && c.ss.length ? c.i / c.ss.length : 0;
  return (j.got.length + part) / Math.max(1, j.g.plan.length);
}
export function runTriage(r: Run): Result { const j = triageJob(r); triageStep(j, Infinity); return j.res ?? emptyRes(j); }
function emptyRes(j: TJob): Result { return compute(j.r, j.key, j.partial, [], []); }
function compute(r: Run, key: string, partial: boolean, gs: Dist[], gb: Dist[]): Result {
  const dims = dimsFor(r);
  const g = { sel: gs, base: gb };
  const s0 = g.sel.length ? g.sel[0] : null; const b0 = g.base.length ? g.base[0] : null;
  const A = s0 ? s0.total : 0; const B = b0 ? b0.total : 0;
  const days = periodOf(r.days, false);
  const res: Result = { key, selN: A, baseN: B, rows: [], guard: "", small: A < 20 || B < 20, offending: [], partial, from: days[0] ?? "", to: days[days.length - 1] ?? "",
    unpriced: s0 ? s0.unpriced : 0, selLabel: labelOf(r), baseLabel: baseLabelOf(r), dimsUsed: [] };
  if (B === 0 && A > 0) {
    // the scope already says what the selection says: name its clauses on the selection's keys
    const ks: string[] = []; for (const c of r.sel) ks.push(c.key);
    if (r.preset >= 1 && r.preset <= 3) ks.push("status");
    if (r.preset === 3) ks.push("duration");
    for (const c of without(r.scope, r.dropped)) if (ks.indexOf(c.key) >= 0) res.offending.push(c);
    res.guard = "empty-baseline"; return res;
  }
  if (A === 0) { res.guard = "empty-selection"; return res; }
  if (r.entity === "call" && r.base === "previous") {
    if (startOfDay() - (2 * r.days - 1) * 86400000 < callCutoff()) { res.guard = "retention"; return res; } // ±1 h around DST: the cutoff is a whole day
  }
  const weighted = r.weight !== "count"; const fx = fixedVals(r);
  for (let i = 0; i < dims.length; i++) {
    const sd = i < g.sel.length ? g.sel[i] : null; const bd = i < g.base.length ? g.base[i] : null;
    if (!sd || !bd) continue;
    const vals = new Set<string>(); for (const k of sd.vals.keys()) vals.add(k); for (const k of bd.vals.keys()) vals.add(k);
    if (vals.size <= 1) continue;
    const dim = dims[i] ?? "";
    let used = false;
    for (const [v, sb] of sd.vals) {
      if (sb.n <= 0 || (dim === "server" && v === "") || fx.has(dim + "\t" + v.toLowerCase())) continue; // server "" = not an MCP call
      used = true;
      const bb = bd.vals.get(v);
      res.rows.push({ attr: dim, value: v, s: weighted ? wscore(sb.n, sb.w, sd.wTotal, bb ? bb.n : 0, bb ? bb.w : 0, bd.wTotal) : score(sb.n, A, bb ? bb.n : 0, B) });
    }
    if (used) res.dimsUsed.push(dim);
  }
  return res;
}

// a value as shown (--redact scrubs it like the filter chips); "" agent = top-level
export function shown(attr: string, v: string): string {
  if (attr === "agent" && v === "") return "main";
  if (v === "") return "(none)";
  return attr === "program" ? display("prog", v, null) : display("filter:" + attr, v, null);
}
// the text a guard shows instead of the table (spec §4.5), with the key (TUI) or the option (CLI) that fixes it
export function guardText(r: Run, res: Result, cli: boolean): string {
  const when = r.days === 1 ? "today" : "for " + String(r.days) + " days";
  if (res.guard === "empty-baseline") {
    if (!res.offending.length) return "Baseline is empty: the scope already selects only these." + (cli ? "" : " b picks another baseline.");
    return "Baseline is empty: the filter `" + print(res.offending) + "` already selects only these. " +
      (cli ? "Drop it from --filter." : "r removes it for this triage, R removes it from " + r.origin + " and the pins.");
  }
  if (res.guard === "empty-selection") return "No " + res.selLabel + " in scope " + when + "." + (cli ? " --days widens the period." : r.days < 30 ? " w / m widen the period." : "");
  if (res.guard === "retention") return "Call details are kept for " + String(callDays()) + " days: the previous period starts before that." + (cli ? " --entity session reads all history." : " e switches to sessions.");
  return "";
}
