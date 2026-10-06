// agentglass — filter language: aggregation over day buckets or call rows, shared by Stats, triage, compare, repo-view (spec §5)
// SPDX-License-Identifier: Apache-2.0
// Two paths: session/day-only filters read the Day buckets (all history, fast); a call clause, or a call-level dimension the
// buckets cannot answer (model × status, …), reads the call rows (within retention). Callers do not choose.
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, callsOf } from "../usage/ledger.ts";
import { type Day, L, heavy } from "../usage/record.ts";
import { type Dict, DICT, nameOf, extOf, localOf } from "../usage/facts.ts";
import { type Rows, rowIds, KIND_PROG, KIND_CMD, KIND_FILE } from "../usage/rows.ts";
import { type Cnt, type TS, HB, EDGE, newCnt, hb, pct, mcpServer } from "../usage/calls.ts";
import { type Compiled, sessMatches, dayMatches, callsIn, weekdayOf, livePid } from "./eval.ts";
import { callCutoff } from "../usage/callcache.ts";
import { repoShown } from "./project.ts";
import { titleOf, working } from "../../model/sessions.ts";

export type Weight = "count" | "cost" | "tokens" | "duration";
export interface Bin { n: number; w: number; err: number; hist: number[] /* HB buckets, durations of timed rows (call entity) */; max: number }
export interface Dist { dim: string; total: number; wTotal: number; vals: Map<string, Bin>; path: "rows" | "buckets"; unpriced: number /* sessions with unknown cost, weight 0 */ }
// buckets count program/command/file per occurrence, not per call, and know no per-call model/status/duration: rows only
export const ROW_DIMS: string[] = ["model", "status", "duration", "out", "program", "command", "file", "ext"];
export interface ToolT { n: number; err: number; dn: number; ms: number; max: number; hist: number[]; out: number }
export interface Totals {
  sessions: number; subs: number; subsCost: number; subsUnk: number;   // top-level sessions with activity; subagent sessions, their cost and unpriced tokens
  cost: number; unk: number; inTok: number; outTok: number; cr: number; cw: number;
  tools: number; errors: number; add: number; del: number;
  dn: number; ms: number; max: number; hist: number[];                  // merged durations of all tools
  perTool: Map<string, ToolT>; prog: Map<string, Cnt>; cmds: Map<string, Cnt>; files: Map<string, Cnt>; // prog/cmds keyed "<tool>\t<x>", files by path
  models: Set<string>; paths: Set<string> /* matching session paths */; pdays: Map<string, string[]> /* path → the day keys it contributed */; first: number; last: number /* min Acc.t0, max last activity */;
  callScoped: boolean;   // f had call clauses: cost/tokens are "in session-days with matching calls", tools/errors/durations from matching rows only
  path: "rows" | "buckets";
}

function zeros(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0); return a; }
function newBin(): Bin { return { n: 0, w: 0, err: 0, hist: zeros(HB), max: 0 }; }
function newToolT(): ToolT { return { n: 0, err: 0, dn: 0, ms: 0, max: 0, hist: zeros(HB), out: 0 }; }
export function tsOf(t: ToolT, q: number): number { return t.dn > 0 ? pct(t.hist, q, t.max) : -1; }
const WD = ["su", "mo", "tu", "we", "th", "fr", "sa"];

// ── dimension values in display case ──
function durLabel(ms: number): string { if (ms < 0) return "unknown"; const b = hb(ms); return b === 0 ? "<10ms" : "≥" + fmtEdge(EDGE[b - 1] ?? 0); }
function fmtEdge(ms: number): string { return ms < 1000 ? String(ms) + "ms" : ms < 60000 ? String(ms / 1000) + "s" : String(ms / 60000) + "m"; }
function outLabel(n: number, known: boolean): string { if (!known) return "unknown"; let e = 1024; if (n < e) return "<1KB"; while (n >= e * 16 && e < 1073741824) e *= 16; return "≥" + (e >= 1048576 ? String(e / 1048576) + "MB" : String(e / 1024) + "KB"); }
function stateOf(s: Sess): string { if (s.stuck) return "stuck"; if (s.attention) return "attention"; const p = livePid(s); return p && working(s) ? "busy" : p ? "idle" : "ended"; }
function sessModels(s: Sess): string[] {
  const o: string[] = []; if (s.model) o.push(s.model);
  const seen = new Set<number>(); const r = callsOf(s);
  for (let i = 0; i < r.n; i++) { const x = r.model[i] + 0; if (x >= 0 && !seen.has(x)) { seen.add(x); const m = nameOf(DICT.model, x); if (o.indexOf(m) < 0) o.push(m); } }
  return o.length ? o : ["unknown"];
}
function startOf(s: Sess): { hour: string; wd: string } { const a = ledger.get(s.path); const t0 = a ? a.t0 : 0; if (t0 <= 0) return { hour: "unknown", wd: "unknown" }; const l = localOf(t0); return { hour: String(l.hour), wd: WD[l.wd] ?? "" }; }
// dimensions other features add (mux: workspace)
export interface DimFn { dim: string; f: (s: Sess) => string[] }
export const DIMS: DimFn[] = [];
// a session attribute as dimension values
export function sessDim(dim: string, s: Sess): string[] {
  switch (dim) {
    case "harness": return [s.h];
    case "repo": case "project": return [repoShown(s)]; // the identity is real (realCwd): faked under --redact
    case "cwd": return [s.cwd];
    case "branch": return [s.branch];
    case "model": return sessModels(s);
    case "title": return [titleOf(s)];
    case "id": return [s.id];
    case "agent": return [s.kind];
    case "subagent": return [s.parent ? "true" : "false"];
    case "live": return [livePid(s) > 0 ? "true" : "false"];
    case "archived": return [s.archived ? "true" : "false"];
    case "state": return [stateOf(s)];
    case "hour": return [startOf(s).hour];
    case "weekday": return [startOf(s).wd];
  }
  for (const d of DIMS) if (d.dim === dim) { const f = d.f; return f(s); }
  return [];
}
function uniq(xs: string[]): string[] { const o: string[] = []; for (const x of xs) if (o.indexOf(x) < 0) o.push(x); return o; }
function dictNames(d: { ids: Map<string, number>; names: string[] }, xs: number[]): string[] { const o: string[] = []; for (const x of xs) o.push(nameOf(d, x)); return o; }
// the dimensions callDim answers per row; any other falls back to the session's value
const CALL_LEVEL = ["tool", "server", "program", "command", "file", "ext", "status", "duration", "out", "model", "hour", "day", "weekday"];
// a call attribute as dimension values (multi-valued attributes: each distinct value)
export function callDim(dim: string, s: Sess, r: Rows, i: number): string[] {
  switch (dim) {
    case "tool": return [nameOf(DICT.tool, r.tool[i])];
    case "server": return [mcpServer(nameOf(DICT.tool, r.tool[i]))];
    case "program": return uniq(dictNames(DICT.prog, rowIds(r, i, KIND_PROG)));
    case "command": return uniq(dictNames(DICT.cmd, rowIds(r, i, KIND_CMD)));
    case "file": return uniq(dictNames(DICT.file, rowIds(r, i, KIND_FILE)));
    case "ext": { const o: string[] = []; for (const f of rowIds(r, i, KIND_FILE)) { const e = extOf(nameOf(DICT.file, f)); if (o.indexOf(e) < 0) o.push(e); } return o; }
    case "status": return [r.err[i] === 1 ? "error" : r.err[i] === 0 ? "ok" : "unknown"];
    case "duration": return [durLabel(r.ms[i])];
    case "out": return [outLabel(r.out[i], r.err[i] >= 0)];
    case "model": return [r.model[i] >= 0 ? nameOf(DICT.model, r.model[i]) : "unknown"];
    case "hour": return [String(localOf(r.t[i]).hour)];
    case "day": return [localOf(r.t[i]).day];
    case "weekday": return [WD[localOf(r.t[i]).wd] ?? ""];
  }
  return sessDim(dim, s);
}

function bin(d: Dist, k: string): Bin { let b = d.vals.get(k); if (!b) { b = newBin(); d.vals.set(k, b); } return b; }
function addHist(to: number[], from: number[]): void { for (let i = 0; i < HB; i++) to[i] = (to[i] ?? 0) + (from[i] ?? 0); }
function newDists(dims: string[], path: "rows" | "buckets"): Dist[] { const o: Dist[] = []; for (const d of dims) o.push({ dim: d, total: 0, wTotal: 0, vals: new Map<string, Bin>(), path, unpriced: 0 }); return o; }
function dayTok(d: Day): number { return d.inTok + d.outTok + d.cr + d.cw; }
function unpricedDay(d: Day): boolean { return d.cost === 0 && d.unk > 0; }

// ── cache per (filter, entity, days, dims, weight, ledger version) ──
const cache = new Map<string, Dist[]>(); const tcache = new Map<string, Totals>(); let cacheVer = -1;
export function aggKey(f: Compiled, entity: string, days: string[], dims: string[], weight: string): string { return f.key + "|" + entity + "|" + days.join(",") + "|" + dims.join(",") + "|" + weight + "|" + String(L.ver); }
function fresh(): void { if (cacheVer !== L.ver) { cache.clear(); tcache.clear(); cacheVer = L.ver; } if (cache.size > 64) cache.clear(); if (tcache.size > 64) tcache.clear(); }

export function aggregate(f: Compiled, entity: "session" | "call", days: string[], dims: string[], weight: Weight): Dist[] {
  const j = aggJob(f, entity, days, dims, weight, null); aggStep(j, Infinity); return j.out;
}
// rows path with an extra row test no filter can express (triage `slow`); not cached (keep is a closure)
export function aggregateWhere(f: Compiled, days: string[], dims: string[], weight: Weight, keep: (s: Sess, r: Rows, i: number) => boolean): Dist[] {
  const j = aggJob(f, "call", days, dims, weight, keep); aggStep(j, Infinity); return j.out;
}

// ── resumable aggregation: one session per step, so a long count (30 days of call rows) runs in slices between frames ──
export interface AggJob {
  k: string /* cache key, "" = not cached */; f: Compiled; entity: "session" | "call"; days: string[]; dset: Set<string>; dims: string[]; weight: Weight;
  keep: ((s: Sess, r: Rows, i: number) => boolean) | null; rows: boolean; cut: number; sl: boolean[] /* dims answered per session */; ss: Sess[]; i: number; out: Dist[]; done: boolean;
}
export function aggJob(f: Compiled, entity: "session" | "call", days: string[], dims: string[], weight: Weight, keep: ((s: Sess, r: Rows, i: number) => boolean) | null): AggJob {
  fresh();
  const k = keep ? "" : aggKey(f, entity, days, dims, weight); const hit = k ? cache.get(k) : undefined;
  let rows = f.needsCalls || keep !== null; if (entity === "call") for (const d of dims) if (ROW_DIMS.indexOf(d) >= 0) rows = true;
  const sl: boolean[] = []; for (const d of dims) sl.push(CALL_LEVEL.indexOf(d) < 0);
  const ss: Sess[] = []; if (!hit) for (const s of sessions.values()) ss.push(s);
  return { k, f, entity, days, dset: new Set<string>(days), dims, weight, keep, rows, cut: callCutoff(), sl, ss, i: 0, out: hit ?? newDists(dims, rows ? "rows" : "buckets"), done: !!hit };
}
// sessions until the clock reaches `until` (Infinity = to the end); true when done (j.out is then complete and cached)
export function aggStep(j: AggJob, until: number): boolean {
  while (!j.done) {
    if (j.i >= j.ss.length) { j.done = true; if (j.k) { fresh(); cache.set(j.k, j.out); } break; }
    const s = j.ss[j.i]; j.i++;
    if (j.rows) { if (j.entity === "call") rowsCall(j, s); else rowsSess(j, s); }
    else if (j.entity === "call") bucketCall(j, s); else bucketSess(j, s);
    if (until !== Infinity && Date.now() >= until) break;
  }
  return j.done;
}

function bucketCall(j: AggJob, s: Sess): void {
  if (!sessMatches(j.f, s)) return;
  const a = ledger.get(s.path); if (!a) return;
  for (const dk of j.days) {
    const d = a.days.get(dk); if (!d || !dayMatches(j.f, s, dk, d)) continue;
    for (const [name, st] of heavy(d).tt) for (const ds of j.out) addTS(ds, s, dk, name, st, j.weight);
  }
}
// session entity: once per session with ≥ 1 selected day passing the filter
function bucketSess(j: AggJob, s: Sess): void {
  if (!sessMatches(j.f, s)) return;
  const a = ledger.get(s.path); if (!a) return;
  const weight = j.weight;
  let any = false; let err = 0; let w = 0; let unp = false; const tools: string[] = []; const progs: string[] = []; const exts: string[] = []; const dks: string[] = [];
  for (const dk of j.days) {
    const d = a.days.get(dk); if (!d || !dayMatches(j.f, s, dk, d)) continue;
    any = true; dks.push(dk);
    for (const [name, st] of heavy(d).tt) { err += st.err; if (tools.indexOf(name) < 0) tools.push(name); if (weight === "duration") w += st.ms; }
    for (const pk of heavy(d).prog.keys()) { const p = pk.slice(pk.indexOf("\t") + 1); if (progs.indexOf(p) < 0) progs.push(p); }
    for (const fk of heavy(d).files.keys()) { const e = extOf(fk.slice(fk.indexOf("\t") + 1)); if (exts.indexOf(e) < 0) exts.push(e); }
    if (weight === "cost") { if (unpricedDay(d)) unp = true; w += d.cost; } else if (weight === "tokens") w += dayTok(d);
  }
  if (!any) return;
  if (weight === "count") w = 1;
  for (const ds of j.out) {
    const vs = ds.dim === "tool" ? tools : ds.dim === "program" ? progs : ds.dim === "ext" ? exts : ds.dim === "day" ? dks : sessDim(ds.dim, s);
    ds.total++; ds.wTotal += w; if (unp) ds.unpriced++;
    for (const v of vs) { const b = bin(ds, v); b.n++; b.w += w; b.err += err; }
  }
}
// one tool's day counter into a call-entity distribution
function addTS(ds: Dist, s: Sess, dk: string, name: string, st: TS, weight: Weight): void {
  const w = weight === "count" ? st.n : weight === "duration" ? st.ms : 0;
  ds.total += st.n; ds.wTotal += w;
  if (ds.dim === "hour") { for (let h = 0; h < 24; h++) { const n = st.h[h] ?? 0; if (n > 0) { const b = bin(ds, String(h)); b.n += n; if (weight === "count") b.w += n; } } return; }
  const vs = ds.dim === "tool" ? [name] : ds.dim === "server" ? [mcpServer(name)] : ds.dim === "day" ? [dk] : ds.dim === "weekday" ? [WD[weekdayOf(dk)] ?? ""] : sessDim(ds.dim, s);
  for (const v of vs) { const b = bin(ds, v); b.n += st.n; b.w += w; b.err += st.err; addHist(b.hist, st.hist); if (st.max > b.max) b.max = st.max; }
}

function rowsCall(j: AggJob, s: Sess): void {
  const out = j.out; const weight = j.weight; const kp = j.keep;
  // session attributes are the same for every row of the session: its rows add up in one bin, which joins each session
  // dimension's value bin once at the end
  const acc = newBin(); let any = false;
  callsIn(j.f, s, j.dset, j.cut, (r: Rows, ri: number) => {
    if (kp) { const k = kp; if (!k(s, r, ri)) return; }
    any = true;
    const w = weight === "count" ? 1 : weight === "duration" ? Math.max(0, r.ms[ri]) : 0;
    const hi = r.ms[ri] >= 0 ? hb(r.ms[ri]) : -1;
    addRow(acc, w, r, ri, hi);
    for (let i = 0; i < out.length; i++) {
      const ds = out[i]; const dim = ds.dim;
      ds.total++; ds.wTotal += w;
      if (j.sl[i]) continue;
      // the multi-valued call dims straight from the row's ids
      if (dim === "program" || dim === "file" || dim === "command") {
        const ids: number[] = rowIds(r, ri, dim === "program" ? KIND_PROG : dim === "file" ? KIND_FILE : KIND_CMD); const d: Dict = dim === "program" ? DICT.prog : dim === "file" ? DICT.file : DICT.cmd;
        let x = 0; for (const id of ids) { if (ids.indexOf(id) === x) addRow(bin(ds, nameOf(d, id)), w, r, ri, hi); x++; }
      } else if (dim === "ext") {
        const fs = rowIds(r, ri, KIND_FILE);
        if (fs.length) { const es: string[] = []; for (const f of fs) { const e = extId(f); if (es.indexOf(e) < 0) { es.push(e); addRow(bin(ds, e), w, r, ri, hi); } } }
      } else for (const v of callDim(dim, s, r, ri)) addRow(bin(ds, v), w, r, ri, hi);
    }
  });
  if (!any) return;
  for (let i = 0; i < out.length; i++) {
    if (!j.sl[i]) continue;
    const ds = out[i];
    for (const v of sessDim(ds.dim, s)) { const b = bin(ds, v); b.n += acc.n; b.w += acc.w; b.err += acc.err; addHist(b.hist, acc.hist); if (acc.max > b.max) b.max = acc.max; }
  }
}
function addRow(b: Bin, w: number, r: Rows, i: number, hi: number): void { b.n++; b.w += w; if (r.err[i] === 1) b.err++; if (hi >= 0) { b.hist[hi] = (b.hist[hi] ?? 0) + 1; if (r.ms[i] > b.max) b.max = r.ms[i] + 0; } }
// extension per file id (file ids are ledger-wide and never reused)
const extMemo = new Map<number, string>();
function extId(id: number): string { const e = extMemo.get(id); if (e !== undefined) return e; const x = extOf(nameOf(DICT.file, id)); extMemo.set(id, x); return x; }
// session entity: a session counts once if any of its rows match; call dims are the union over those rows
function rowsSess(j: AggJob, s: Sess): void {
  const dims = j.dims; const kp = j.keep;
  let n = 0; let err = 0; let dur = 0; const dks: string[] = []; const vals: string[][] = []; for (let i = 0; i < dims.length; i++) vals.push([]);
  callsIn(j.f, s, j.dset, j.cut, (r: Rows, ri: number) => {
    if (kp) { const k = kp; if (!k(s, r, ri)) return; }
    n++;
    if (r.err[ri] === 1) err++;
    if (r.ms[ri] > 0) dur += r.ms[ri];
    const dk = localOf(r.t[ri]).day; if (dks.indexOf(dk) < 0) dks.push(dk);
    for (let i = 0; i < dims.length; i++) {
      const dim = dims[i] ?? ""; if (dim === "hour" || dim === "weekday") continue;
      const into = vals[i] ?? []; for (const v of callDim(dim, s, r, ri)) if (into.indexOf(v) < 0) into.push(v);
    }
  });
  if (!n) return;
  const a = ledger.get(s.path); const weight = j.weight;
  let w = 1; let unp = false;
  if (weight === "cost" || weight === "tokens") { w = 0; if (a) for (const dk of dks) { const d = a.days.get(dk); if (!d) continue; if (weight === "cost") { w += d.cost; if (unpricedDay(d)) unp = true; } else w += dayTok(d); } }
  else if (weight === "duration") w = dur;
  for (let i = 0; i < j.out.length; i++) {
    const ds = j.out[i]; const dim = dims[i] ?? "";
    const vs = dim === "hour" || dim === "weekday" ? sessDim(dim, s) : (vals[i] ?? []);
    ds.total++; ds.wTotal += w; if (unp) ds.unpriced++;
    for (const v of vs) { const b = bin(ds, v); b.n++; b.w += w; b.err += err; }
  }
}

// "rest" baselines: a − b per value (never below 0; values reaching 0 are dropped)
export function minus(a: Dist[], b: Dist[]): Dist[] {
  const out: Dist[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = i < b.length ? b[i] : null;
    const d: Dist = { dim: x.dim, total: Math.max(0, x.total - (y ? y.total : 0)), wTotal: Math.max(0, x.wTotal - (y ? y.wTotal : 0)), vals: new Map<string, Bin>(), path: x.path, unpriced: Math.max(0, x.unpriced - (y ? y.unpriced : 0)) };
    for (const [k, v] of x.vals) {
      const o = y ? y.vals.get(k) : undefined;
      const n = v.n - (o ? o.n : 0); if (n <= 0) continue;
      const h: number[] = []; for (let j = 0; j < HB; j++) h.push(Math.max(0, (v.hist[j] ?? 0) - (o ? o.hist[j] ?? 0 : 0)));
      d.vals.set(k, { n, w: Math.max(0, v.w - (o ? o.w : 0)), err: Math.max(0, v.err - (o ? o.err : 0)), hist: h, max: v.max });
    }
    out.push(d);
  }
  return out;
}

// ── totals ──
// nothing counted (a group whose expression does not compile)
export function emptyTotals(): Totals { return newTotals("buckets", false); }
function newTotals(path: "rows" | "buckets", scoped: boolean): Totals {
  return { sessions: 0, subs: 0, subsCost: 0, subsUnk: 0, cost: 0, unk: 0, inTok: 0, outTok: 0, cr: 0, cw: 0, tools: 0, errors: 0, add: 0, del: 0, dn: 0, ms: 0, max: 0, hist: zeros(HB),
    perTool: new Map<string, ToolT>(), prog: new Map<string, Cnt>(), cmds: new Map<string, Cnt>(), files: new Map<string, Cnt>(), models: new Set<string>(), paths: new Set<string>(), pdays: new Map<string, string[]>(), first: 0, last: 0, callScoped: scoped, path };
}
function addCnt(m: Map<string, Cnt>, k: string, c: Cnt): void { let x = m.get(k); if (!x) { x = newCnt(); m.set(k, x); } x.n = x.n + c.n; x.err = x.err + c.err; x.add = x.add + c.add; x.del = x.del + c.del; }
function bump(m: Map<string, Cnt>, k: string, err: boolean): void { let x = m.get(k); if (!x) { x = newCnt(); m.set(k, x); } x.n = x.n + 1; if (err) x.err = x.err + 1; }
function toolT(t: Totals, name: string): ToolT { let x = t.perTool.get(name); if (!x) { x = newToolT(); t.perTool.set(name, x); } return x; }
// a day's money, tokens and lines; models from its per-model buckets unless rows name them
function dayMoney(t: Totals, s: Sess, dk: string, d: Day, models: boolean): void {
  t.cost += d.cost; t.unk += d.unk; t.inTok += d.inTok; t.outTok += d.outTok; t.cr += d.cr; t.cw += d.cw; t.add += d.add; t.del += d.del;
  if (s.parent) { t.subsCost += d.cost; t.subsUnk += d.unk; }
  if (models) for (const m of d.mt.keys()) t.models.add(m);
  const pd = t.pdays.get(s.path); if (pd) pd.push(dk); else t.pdays.set(s.path, [dk]);
}
function sessSeen(t: Totals, s: Sess): void {
  if (t.paths.has(s.path)) return;
  t.paths.add(s.path);
  if (s.parent) t.subs++; else t.sessions++;
  const a = ledger.get(s.path); const t0 = a ? a.t0 : 0;
  if (t0 > 0 && (t.first === 0 || t0 < t.first)) t.first = t0;
  const last = Math.max(s.last, s.mtime); if (last > t.last) t.last = last;
}
function allDays(): string[] { const set = new Set<string>(); for (const a of ledger.values()) for (const k of a.days.keys()) set.add(k); return [...set].sort(); }
// days null = all history
export function totals(f: Compiled, days: string[] | null): Totals { const j = totalsJob(f, days); totalsStep(j, Infinity); return j.t; }
// resumable like aggJob: one session per step (compare counts two groups between frames)
export interface TotJob { k: string; f: Compiled; dset: Set<string>; days: string[]; cut: number; ss: Sess[]; i: number; t: Totals; seen: Set<string>; done: boolean }
export function totalsJob(f: Compiled, days: string[] | null): TotJob {
  fresh();
  const ds = days ?? allDays();
  const k = aggKey(f, "totals", ds, [], ""); const hit = tcache.get(k);
  const ss: Sess[] = []; if (!hit) for (const s of sessions.values()) ss.push(s);
  return { k, f, dset: new Set<string>(ds), days: ds, cut: callCutoff(), ss, i: 0, t: hit ?? newTotals(f.needsCalls ? "rows" : "buckets", f.needsCalls), seen: new Set<string>(), done: !!hit };
}
// sessions until the clock reaches `until` (Infinity = to the end); true when done (j.t is then complete and cached)
export function totalsStep(j: TotJob, until: number): boolean {
  while (!j.done) {
    if (j.i >= j.ss.length) { j.done = true; fresh(); tcache.set(j.k, j.t); break; }
    const s = j.ss[j.i]; j.i++;
    if (j.f.needsCalls) rowTotals(j, s); else bucketTotals(j, s);
    if (until !== Infinity && Date.now() >= until) break;
  }
  return j.done;
}
function bucketTotals(j: TotJob, s: Sess): void {
  const f = j.f; const t = j.t;
  if (!sessMatches(f, s)) return;
  const a = ledger.get(s.path); if (!a) return;
  for (const dk of j.days) {
    const d = a.days.get(dk); if (!d || !dayMatches(f, s, dk, d)) continue;
    sessSeen(t, s); dayMoney(t, s, dk, d, true); t.tools += d.tools;
    for (const [name, st] of heavy(d).tt) {
      const x = toolT(t, name);
      x.n += st.n; x.err += st.err; x.dn += st.dn; x.ms += st.ms; x.out += st.out; if (st.max > x.max) x.max = st.max; addHist(x.hist, st.hist);
      t.errors += st.err; t.dn += st.dn; t.ms += st.ms; if (st.max > t.max) t.max = st.max; addHist(t.hist, st.hist);
    }
    for (const [pk, c] of heavy(d).prog) addCnt(t.prog, pk, c);
    for (const [ck, c] of heavy(d).cmds) addCnt(t.cmds, ck, c);
    for (const [fk, c] of heavy(d).files) addCnt(t.files, fk.slice(fk.indexOf("\t") + 1), c);
  }
}
// "<path>\t<day>" in j.seen: days with ≥ 1 matching row add their cost/tokens/lines once
function rowTotals(j: TotJob, s: Sess): void {
  const t = j.t; const a = ledger.get(s.path);
  callsIn(j.f, s, j.dset, j.cut, (r: Rows, ri: number) => {
    sessSeen(t, s);
    const dk = localOf(r.t[ri]).day; const sk = s.path + "\t" + dk;
    if (!j.seen.has(sk)) { j.seen.add(sk); const d = a ? a.days.get(dk) : undefined; if (d) dayMoney(t, s, dk, d, false); }
    t.models.add(r.model[ri] >= 0 ? nameOf(DICT.model, r.model[ri]) : "unknown");
    const name = nameOf(DICT.tool, r.tool[ri]); const x = toolT(t, name); const err = r.err[ri] === 1;
    t.tools++; x.n++; if (err) { t.errors++; x.err++; }
    if (r.ms[ri] >= 0) { const b = hb(r.ms[ri]); x.dn++; x.ms += r.ms[ri]; if (r.ms[ri] > x.max) x.max = r.ms[ri]; x.hist[b] = (x.hist[b] ?? 0) + 1; t.dn++; t.ms += r.ms[ri]; if (r.ms[ri] > t.max) t.max = r.ms[ri]; t.hist[b] = (t.hist[b] ?? 0) + 1; }
    if (r.err[ri] >= 0) x.out += r.out[ri];
    for (const p of uniq(dictNames(DICT.prog, rowIds(r, ri, KIND_PROG)))) bump(t.prog, name + "\t" + p, err);
    for (const cm of uniq(dictNames(DICT.cmd, rowIds(r, ri, KIND_CMD)))) bump(t.cmds, name + "\t" + cm, err);
    for (const fp of uniq(dictNames(DICT.file, rowIds(r, ri, KIND_FILE)))) bump(t.files, fp, false);
  });
}
