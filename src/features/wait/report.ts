// agentglass — agent-wait period report: wall time per command family, per tool and per kind, the agent-time split, trend
// SPDX-License-Identifier: Apache-2.0
// One pass over the sessions of a window and the window of equal length before it (spec agent-wait §2), resumable a
// session at a time (the TUI steps it in ≤ 20 ms slices; the CLI runs it to the end). A session with a digest for its
// calls file (digest.ts: day sums per family and tool) is a fold over its days; a day only partly inside a window, or a
// session without a digest, is read row by row: from memory (rowFam, families worked out at read time and memoised) or
// from its calls file for this pass alone, whose digest is then worked out and kept ("computing"). The tab keeps the
// static part's sums to start its next report from (Base). The slowest calls of a row come from the rows read plus, on
// demand, the digest days that can hold one (drill).
import type { Sess } from "../../model/types.ts";
import { sessions, parentOf } from "../../model/sessions.ts";
import { ledger, unread, callsOf } from "../usage/ledger.ts";
import { type Acc as LAcc, spanMin } from "../usage/record.ts";
import { type CallScan, CALLS_DIR, scanCallsFrom, scanCmds } from "../usage/callcache.ts";
import { DICT, nameOf, localOf } from "../usage/facts.ts";
import { type Rows, KIND_CMD, KIND_HINT } from "../usage/rows.ts";
import { HB, hb } from "../usage/calls.ts";
import { type Compiled, sessMatches, dayMatches, callsIn, callCutoff } from "../query/eval.ts";
import { rowFam, cmdFam, famKnown, famName, famKind, famHeavy, famGeneric, toolFamily, toolKind, waitCfg, releaseTexts, betterFam } from "./family.ts";
import { type Digest, type DigDay, type DigJob, readDigest, digestJob, digestStep } from "./digest.ts";
import type { CallSpan } from "./overlap.ts";

export interface SlowCall { path: string; t: number; ms: number; id: string /* the harness call id (transcript focus) */ }
// one family (shell calls), tool (other calls) or kind: n calls (timed: with a duration), ms total, err failed, agents =
// distinct top-level sessions; prev* = the previous window; slow = the 10 longest calls of the rows read (drill adds the
// digest days')
export interface WRow {
  key: string; id: number /* family id (overlap group); -1 tools and kinds */; generic: boolean /* interpreter + script (family.ts) */; kind: string; heavy: boolean; isTool: boolean; n: number; timed: number; ms: number; max: number;
  hist: number[]; err: number; agents: number; prevN: number; prevMs: number; slow: SlowCall[];
}
// agent time of the window: active (Day.act), tools = union of the calls' spans, user = questions to the user, polling =
// wait/ci calls (inside tools), model = active − tools (clamped per session)
export interface Split { activeMs: number; toolMs: number; userMs: number; pollMs: number; modelMs: number }
// a digest day that may hold one of a row's slowest calls: its session, its calls' range and its longest one
export interface Cand { path: string; t0: number; t1: number; max: number }
export interface WaitReport {
  since: number; until: number; prevSince: number; days: number; complete: boolean; // complete: the previous window lies inside retention
  fams: WRow[]; kinds: WRow[]; tools: WRow[]; split: Split; spans: CallSpan[]; sessions: number; bgCalls: number; done: boolean;
  f: Compiled; cut: number; cands: Map<string, Cand[]> /* by row key (candKey) */;
}
const SLOW = 10;
interface Acc { w: WRow; agents: Set<string> }
// a digest day of the static part that is (or may become, as the clock moves the previous window's start) the previous
// window's: applied when the static part ends and again by each report started from it (applyDays)
interface PDay { path: string; d: DigDay }
export interface WaitRun {
  f: Compiled; since: number; until: number; prevSince: number; pmin: number /* the previous window's earliest start while a Base lives */; cur: Set<string>; both: Set<string>; cut: number; minMs: number;
  ss: Sess[]; nst: number /* ss[0, nst): the static part (calls files not read yet: Base) */; i: number; phase: number /* ss[i]: 0 to read, 2 families being worked out, 3 its digest */; cmds: number[]; ci: number;
  dg: Digest | null; sc: CallScan | null /* ss[i]'s digest, and its calls file when it was read for the digest */; job: DigJob | null /* ss[i]'s digest being worked out */; built: number /* digests worked out */;
  ps: PDay[]; pi: number /* part days of the previous window: read row by row after the sessions */;
  fams: Map<number, Acc>; tools: Map<string, Acc>; split: Split; spans: CallSpan[]; roots: Set<string>; cands: Map<string, Cand[]>; done: boolean;
  rec: Base | null /* the static part being recorded */; prev: Prev /* its rows of the previous window (applied when it ends) */; pd: PDay[] /* its digest days for that window */;
}
export const STEPS = { n: 0 }; // stepWait calls (the tab's hidden-work check)
export const FOLD_STATS = { folded: 0, rows: 0 }; // sessions summed from digests / read row by row (checks)
// rows of the previous window, kept apart: its start moves with the clock (prevSince = since − (until − since))
interface Prev { t: number[]; ms: number[]; fam: number[]; tool: string[] }
function newPrev(): Prev { return { t: [], ms: [], fam: [], tool: [] }; }
// The static part of the last unfiltered report: the sessions whose calls files were not read yet when it started
// (finished sessions, most of history), with their sums for the window and their rows and days of the previous one. The
// tab recomputes every 30 s while agents work; while none of those sessions changed (same ledger entry, same offset) and
// the day, retention and period are the same, a report starts from these sums and reads only the other sessions.
interface Base {
  key: string; sess: Map<string, { a: LAcc; off: number }>; fams: Map<number, Acc>; tools: Map<string, Acc>; split: Split; spans: CallSpan[]; roots: Set<string>; cands: Map<string, Cand[]>; prev: Prev; pd: PDay[];
}
const BASE = { m: new Map<string, Base>() }; // by key: one per period (d w m a) at most, so switching back is cheap too
export const BASE_STATS = { used: 0 }; // reports that started from the static part (checks)
export function dropWaitBase(): void { BASE.m = new Map<string, Base>(); }

function zeros(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0); return a; }
function newRow(key: string, id: number, generic: boolean, kind: string, heavy: boolean, isTool: boolean): WRow {
  return { key, id, generic, kind, heavy, isTool, n: 0, timed: 0, ms: 0, max: 0, hist: zeros(HB), err: 0, agents: 0, prevN: 0, prevMs: 0, slow: [] };
}
function copyAcc(a: Acc): Acc {
  const w = a.w; const o = newRow(w.key, w.id, w.generic, w.kind, w.heavy, w.isTool);
  o.n = w.n; o.timed = w.timed; o.ms = w.ms; o.max = w.max; o.hist = w.hist.slice(); o.err = w.err; o.prevN = w.prevN; o.prevMs = w.prevMs; o.slow = w.slow.slice();
  return { w: o, agents: setOf(a.agents) };
}
function setOf(x: Set<string>): Set<string> { const o = new Set<string>(); for (const v of x) o.add(v); return o; }
function copyFams(m: Map<number, Acc>): Map<number, Acc> { const o = new Map<number, Acc>(); for (const [k, a] of m) o.set(k, copyAcc(a)); return o; }
function copyTools(m: Map<string, Acc>): Map<string, Acc> { const o = new Map<string, Acc>(); for (const [k, a] of m) o.set(k, copyAcc(a)); return o; }
function copyCands(m: Map<string, Cand[]>): Map<string, Cand[]> { const o = new Map<string, Cand[]>(); for (const [k, v] of m) o.set(k, v.slice()); return o; }
function copySplit(s: Split): Split { return { activeMs: s.activeMs, toolMs: s.toolMs, userMs: s.userMs, pollMs: s.pollMs, modelMs: s.modelMs }; }
// local day keys of [since, until)
export function dayKeysOf(since: number, until: number): string[] {
  const o: string[] = [];
  for (let t = since; t < until; t += 6 * 3600000) { const k = localOf(t).day; if (o.indexOf(k) < 0) o.push(k); }
  const last = localOf(until - 1).day; if (until > since && o.indexOf(last) < 0) o.push(last);
  return o;
}
function baseKey(f: Compiled, since: number, cut: number, minMs: number): string { return String(since) + "|" + String(cut) + "|" + String(minMs) + "|" + f.key; }
function baseOk(b: Base, key: string): boolean {
  if (b.key !== key) return false;
  for (const [p, e] of b.sess) { const a = ledger.get(p); if (a !== e.a || a.off !== e.off || !sessions.has(p)) return false; }
  return true;
}
export function newWaitRun(f: Compiled, since: number, until: number): WaitRun {
  const prevSince = since - (until - since);
  const cur = new Set<string>(dayKeysOf(since, until)); const both = new Set<string>(dayKeysOf(prevSince, until));
  const cut = callCutoff(); const minMs = waitCfg().minSec * 1000;
  const r: WaitRun = { f, since, until, prevSince, pmin: prevSince - 25 * 3600000, cur, both, cut, minMs, ss: [], nst: 0, i: 0, phase: 0, cmds: [], ci: 0, dg: null, sc: null, job: null, built: 0, ps: [], pi: 0,
    fams: new Map<number, Acc>(), tools: new Map<string, Acc>(), split: { activeMs: 0, toolMs: 0, userMs: 0, pollMs: 0, modelMs: 0 }, spans: [], roots: new Set<string>(), cands: new Map<string, Cand[]>(),
    done: false, rec: null, prev: newPrev(), pd: [] };
  const key = baseKey(f, since, cut, minMs); const b = BASE.m.get(key);
  if (f.key === "" && b && baseOk(b, key)) { // the static part as it was: its sums, its previous-window rows and days from now's start
    BASE_STATS.used++;
    r.fams = copyFams(b.fams); r.tools = copyTools(b.tools); r.split = copySplit(b.split); r.spans = b.spans.slice(); r.roots = setOf(b.roots); r.cands = copyCands(b.cands);
    applyPrev(r, b.prev); applyDays(r, b.pd);
    for (const s of sessions.values()) if (!s.host && !b.sess.has(s.path)) r.ss.push(s);
    return r;
  }
  for (const s of sessions.values()) if (!s.host && unread.has(s.path)) r.ss.push(s);
  r.nst = r.ss.length;
  for (const s of sessions.values()) if (!s.host && !unread.has(s.path)) r.ss.push(s);
  if (f.key === "") r.rec = { key, sess: new Map<string, { a: LAcc; off: number }>(), fams: new Map<number, Acc>(), tools: new Map<string, Acc>(), split: r.split, spans: [], roots: new Set<string>(), cands: new Map<string, Cand[]>(), prev: r.prev, pd: r.pd };
  return r;
}
function slowIn(w: WRow, c: SlowCall): void { slowAdd(w.slow, c); }
function slowAdd(sl: SlowCall[], c: SlowCall): void {
  if (sl.length >= SLOW && c.ms <= (sl[sl.length - 1]?.ms ?? 0)) return;
  sl.push(c); sl.sort((a: SlowCall, b: SlowCall) => b.ms - a.ms || a.t - b.t || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sl.length > SLOW) sl.pop();
}
// merged length of [a0, b0, a1, b1, …] (sorted in place only when out of order)
function unionLen(iv: number[]): number {
  let sorted = true; for (let k = 2; k + 1 < iv.length; k += 2) if ((iv[k] ?? 0) < (iv[k - 2] ?? 0)) { sorted = false; break; }
  if (!sorted) {
    const ps: number[][] = []; for (let k = 0; k + 1 < iv.length; k += 2) ps.push([iv[k] ?? 0, iv[k + 1] ?? 0]);
    ps.sort((x: number[], y: number[]) => (x[0] ?? 0) - (y[0] ?? 0));
    iv.length = 0; for (const p of ps) { iv.push(p[0] ?? 0); iv.push(p[1] ?? 0); }
  }
  let n = 0; let cs = -1; let ce = -1;
  for (let k = 0; k + 1 < iv.length; k += 2) { const a = iv[k] ?? 0; const b = iv[k + 1] ?? 0; if (a > ce) { if (ce > cs) n += ce - cs; cs = a; ce = b; } else if (b > ce) ce = b; }
  if (ce > cs) n += ce - cs;
  return n;
}
function rootOf(s: Sess): string { if (!s.parent) return s.path; const p = parentOf(s); return p ? p.path : s.path; }
function accFor(r: WaitRun, fid: number, tool: string): Acc {
  if (fid >= 0) {
    let a = r.fams.get(fid);
    if (!a) { a = { w: newRow(famName(fid), fid, famGeneric(fid), famKind(fid), famHeavy(fid), false), agents: new Set<string>() }; r.fams.set(fid, a); }
    return a;
  }
  const key = toolFamily(tool); let a = r.tools.get(key);
  if (!a) { a = { w: newRow(key, -1, false, toolKind(tool), false, true), agents: new Set<string>() }; r.tools.set(key, a); }
  return a;
}
// a drill-down key: a family's id or a tool family's name
export function candKey(w: WRow): string { return w.isTool ? "t" + w.key : "f" + String(w.id); }
function candIn(r: WaitRun, k: string, c: Cand): void { // the SLOW longest days per key (a call beyond them cannot be in the top SLOW)
  let l = r.cands.get(k); if (!l) { l = []; r.cands.set(k, l); }
  if (l.length >= SLOW && c.max <= (l[l.length - 1]?.max ?? 0)) return;
  l.push(c); l.sort((x: Cand, y: Cand) => y.max - x.max); if (l.length > SLOW) l.pop();
}
function applyPrev(r: WaitRun, p: Prev): void {
  for (let k = 0; k < p.t.length; k++) {
    if ((p.t[k] ?? 0) < r.prevSince) continue;
    const w = accFor(r, (p.fam[k] ?? -1) + 0, p.tool[k] ?? "").w; const ms = (p.ms[k] ?? -1) + 0;
    w.prevN++; if (ms >= 0) w.prevMs += ms;
  }
}
// digest days before the window: whole in the previous window → their sums; partly → their rows are read (r.ps)
function applyDays(r: WaitRun, ds: PDay[]): void {
  const plo = Math.max(r.prevSince, r.cut);
  for (const x of ds) {
    const d = x.d;
    if (d.t1 < plo || d.t0 >= r.since) continue;
    if (d.t0 < plo) { r.ps.push(x); continue; }
    for (const e of d.ents) { const w = accFor(r, e.fid, e.tool).w; w.prevN += e.n; w.prevMs += e.ms; }
  }
}
// one session's pass: its rows of the windows, whichever reader gives them
interface Pass { s: Sess; root: string; idx: number; tv: number[]; uv: number[]; pv: number[]; rows: number; tool: number; user: number; poll: number }
function row(r: WaitRun, p: Pass, t: number, ms: number, err: number, fid: number, tool: string, cid: string): void {
  const cur = t >= r.since && t < r.until;
  if (!cur && !(t >= r.prevSince && t < r.since)) return;
  if (!cur && r.rec && r.i < r.nst) { const v = r.prev; v.t.push(t); v.ms.push(ms); v.fam.push(fid); v.tool.push(fid >= 0 ? "" : tool); return; } // the static part: applied when it ends
  const a = accFor(r, fid, tool); const w = a.w;
  if (!cur) { w.prevN++; if (ms >= 0) w.prevMs += ms; return; }
  const kind = w.kind;
  p.rows++; w.n++; a.agents.add(p.root);
  if (err === 1) w.err++;
  if (ms < 0) return;
  w.timed++; w.ms += ms; if (ms > w.max) w.max = ms;
  const b = hb(ms); w.hist[b] = (w.hist[b] ?? 0) + 1;
  slowIn(w, { path: p.s.path, t, ms, id: cid });
  if (ms > 0) {
    p.tv.push(t); p.tv.push(t + ms);
    if (kind === "user" && fid < 0) { p.uv.push(t); p.uv.push(t + ms); }
    if (kind === "wait" || kind === "ci") { p.pv.push(t); p.pv.push(t + ms); }
  }
  if (fid >= 0 && famHeavy(fid) && ms >= r.minMs && ms > 0) r.spans.push({ t0: t, t1: t + ms, group: fid, agent: p.idx });
}
// the filter tests no call: a session can be summed from its digest (day clauses work per day)
function foldable(r: WaitRun): boolean { return r.f.call.length === 0 && r.f.rowx.length === 0; }
// A session's digest days into the report. False: a day lies only partly inside a window (a window boundary inside its
// calls), or the day sums cannot give the tool union exactly (spans reaching past the next kept day) — nothing was added,
// the caller reads the rows. The static part keeps its days before the window for the previous one (r.pd: its start
// moves); any other session sums them now.
function fold(r: WaitRun, p: Pass, s: Sess, la: LAcc, g: Digest, stat: boolean): boolean {
  const lo = Math.max(r.since, r.cut); const plo = Math.max(r.prevSince, r.cut); const fd = r.f.day.length > 0;
  const ds = g.days; const cur: number[] = []; const pre: number[] = [];
  for (let k = 0; k < ds.length; k++) {
    const d = ds[k]; if (!d) continue;
    if (fd) { const ld = la.days.get(d.dk); if (!ld || !dayMatches(r.f, s, d.dk, ld)) continue; }
    if (d.t0 >= r.until || d.t1 < r.cut) continue; // outside every window
    if (d.t0 >= lo) { if (d.t1 >= r.until) return false; cur.push(k); continue; }
    if (d.t1 >= r.since) return false; // the window's start (or the retention cut) inside the day
    if (stat) { if (d.t1 >= Math.max(r.pmin, r.cut)) pre.push(k); continue; }
    if (d.t1 < plo) continue;
    if (d.t0 < plo) return false;
    pre.push(k);
  }
  // the union over kept days: Σ day unions − Σ overlaps of neighbouring days, exact while no day's spans reach a kept
  // day beyond its neighbour
  for (let j = 0; j < cur.length; j++) {
    const k = (cur[j] ?? 0) + 0; const d = ds[k]; if (!d) continue;
    const n1 = cur[j + 1]; const n2 = cur[j + 2];
    if (n1 !== undefined && n1 !== k + 1 && d.e1 > (ds[n1 + 0]?.t0 ?? 0)) return false;
    if (n2 !== undefined && d.e1 > (ds[n2 + 0]?.t0 ?? 0)) return false;
  }
  for (let j = 0; j < cur.length; j++) {
    const k = (cur[j] ?? 0) + 0; const d = ds[k]; if (!d) continue;
    const adj = cur[j + 1] === k + 1;
    p.tool += (d.u[0] ?? 0) - (adj ? d.x[0] ?? 0 : 0); p.user += (d.u[1] ?? 0) - (adj ? d.x[1] ?? 0 : 0); p.poll += (d.u[2] ?? 0) - (adj ? d.x[2] ?? 0 : 0);
    for (const e of d.ents) {
      const a = accFor(r, e.fid, e.tool); const w = a.w;
      p.rows += e.n; w.n += e.n; w.err += e.err; w.timed += e.timed; w.ms += e.ms; if (e.max > w.max) w.max = e.max;
      const hs = e.hb; for (let q = 0; q + 1 < hs.length; q += 2) { const b = hs[q] + 0; w.hist[b] = (w.hist[b] ?? 0) + hs[q + 1]; }
      if (e.n > 0) a.agents.add(p.root);
      if (e.timed > 0) candIn(r, candKey(w), { path: s.path, t0: d.t0, t1: d.t1, max: e.max });
    }
    for (let q = 0; q + 2 < d.sp.length; q += 3) { const t = (d.sp[q] ?? 0) + 0; const ms = (d.sp[q + 1] ?? 0) + 0; const fid = (d.sp[q + 2] ?? -1) + 0; if (fid >= 0 && ms >= r.minMs) r.spans.push({ t0: t, t1: t + ms, group: fid, agent: p.idx }); }
  }
  for (const k of pre) { const d = ds[k + 0]; if (!d) continue; if (stat) { r.pd.push({ path: s.path, d }); continue; } for (const e of d.ents) { const w = accFor(r, e.fid, e.tool).w; w.prevN += e.n; w.prevMs += e.ms; } }
  FOLD_STATS.folded++;
  return true;
}
// the rows of s one by one (t, ms, err, family, tool, call id) from its calls file (a digest names the families) or from
// memory; t ≥ cut, days passing the filter's day clauses
function eachRow(f: Compiled, cut: number, both: Set<string>, s: Sess, la: LAcc, g: Digest | null, sc0: CallScan | null, fn: (t: number, ms: number, err: number, fid: number, tool: string, cid: string) => void): void {
  const sc = sc0 ?? (g && unread.has(s.path) ? scanCallsFrom(CALLS_DIR, s.path, la, false) : null);
  if (sc && g && sc.ncmd === g.cf.length) {
    const fd = f.day.length > 0; const cf = g.cf;
    for (let i = 0; i < sc.n; i++) {
      const t = (sc.t[i] ?? 0) + 0; if (t < cut) continue;
      if (fd) { const dk = localOf(t).day; const d = la.days.get(dk); if (!d || !dayMatches(f, s, dk, d)) continue; }
      let fid = -1; for (const c of scanCmds(sc, i)) if (c >= 0 && c < cf.length) fid = betterFam(fid, (cf[c + 0] ?? -1) + 0);
      const ti = (sc.to[i] ?? -1) + 0; const id = sc.ci[i] ?? "";
      fn(t, (sc.ms[i] ?? -1) + 0, (sc.er[i] ?? -1) + 0, fid, ti >= 0 ? sc.tools[ti] ?? "" : "", id ? sc.cp + id : "");
    }
    return;
  }
  callsIn(f, s, both, cut, (rw: Rows, i: number): void => {
    const fid = rowFam(rw, i);
    fn(rw.t[i] + 0, rw.ms[i] + 0, rw.err[i] + 0, fid, fid >= 0 ? "" : nameOf(DICT.tool, rw.tool[i] + 0), rw.cid[i] ?? "");
  });
}
// a session's id in spans (overlap's "agents at the peak"): stable across reports, the static part's spans keep theirs
const AGENTS = new Map<string, number>();
function agentId(path: string): number { let i = AGENTS.get(path); if (i === undefined) { i = AGENTS.size; AGENTS.set(path, i); } return i; }
function session(r: WaitRun, s: Sess): void {
  if (!sessMatches(r.f, s)) return;
  const p: Pass = { s, root: rootOf(s), idx: agentId(s.path), tv: [], uv: [], pv: [], rows: 0, tool: 0, user: 0, poll: 0 };
  const la = ledger.get(s.path); const g = r.dg; const stat = !!r.rec && r.i < r.nst;
  const folded = !!la && !!g && fold(r, p, s, la, g, stat);
  if (!folded) {
    FOLD_STATS.rows++;
    const gc = g && !r.sc && unread.has(s.path) && la ? readDigest(s.path, la.off, true) ?? g : g; // its command families, for the calls file's rows
    if (la && (g || inWindows(r, la))) eachRow(r.f, r.cut, r.both, s, la, gc, r.sc, (t: number, ms: number, err: number, fid: number, tool: string, cid: string): void => row(r, p, t, ms, err, fid, tool, cid));
    p.tool = unionLen(p.tv); p.user = unionLen(p.uv); p.poll = unionLen(p.pv);
  }
  const a = ledger.get(s.path);
  if (stat && a) r.rec?.sess.set(s.path, { a, off: a.off });
  if (r.f.needsCalls && p.rows === 0) return; // a call filter: only sessions with a matching call in the window
  if (p.rows > 0) r.roots.add(p.root);
  let act = 0;
  if (a) for (const [dk, d] of a.days) if (r.cur.has(dk)) act += spanMin(d.act) * 60000;
  const sp = r.split;
  sp.activeMs = sp.activeMs + act; sp.toolMs = sp.toolMs + p.tool; sp.userMs = sp.userMs + p.user; sp.pollMs = sp.pollMs + p.poll;
  sp.modelMs = sp.modelMs + Math.max(0, act - p.tool);
}
// the session has a day in the windows (else nothing of it is read)
function inWindows(r: WaitRun, a: LAcc): boolean { for (const k of a.days.keys()) if (r.both.has(k)) return true; return false; }
// the command ids of s's rows in the windows whose family is not worked out yet
function newCmds(r: WaitRun, s: Sess): number[] {
  const o: number[] = []; const seen = new Set<number>();
  callsIn(r.f, s, r.both, r.cut, (rw: Rows, i: number): void => {
    const e = i + 1 < rw.n ? rw.lo[i + 1] + 0 : rw.nl;
    for (let k = rw.lo[i] + 0; k < e; k++) { const v = rw.li[k] + 0; const kd = v % 4; if (kd === KIND_CMD || kd === KIND_HINT) { const id = (v - kd) / 4; if (!famKnown(id) && !seen.has(id)) { seen.add(id); o.push(id); } } }
  });
  return o;
}
// the static part ends: keep a copy of its sums (the next report may start there), then its previous-window rows and days count
function endStatic(r: WaitRun): void {
  const b = r.rec; if (!b) return;
  b.fams = copyFams(r.fams); b.tools = copyTools(r.tools); b.split = copySplit(r.split); b.spans = r.spans.slice(); b.roots = setOf(r.roots); b.cands = copyCands(r.cands);
  const old: string[] = []; for (const k of BASE.m.keys()) if ((k.split("|")[1] ?? "") !== String(r.cut)) old.push(k); // a day ago: never valid again
  for (const k of old) BASE.m.delete(k);
  if (BASE.m.size >= 4) BASE.m.clear();
  BASE.m.set(b.key, b); r.rec = null;
  applyPrev(r, r.prev); r.prev = newPrev(); applyDays(r, r.pd); r.pd = [];
}
// a digest day partly in the previous window: its rows from that window's start on
function partDay(r: WaitRun, x: PDay): void {
  const s = sessions.get(x.path); const la = ledger.get(x.path); if (!s || !la) return;
  const g = readDigest(x.path, la.off, true); const plo = Math.max(r.prevSince, r.cut); const d = x.d;
  eachRow(r.f, r.cut, r.both, s, la, g, null, (t: number, ms: number, err: number, fid: number, tool: string, cid: string): void => {
    if (t < plo || t < d.t0 || t > d.t1 || t >= r.since) return;
    const w = accFor(r, fid, tool).w; w.prevN++; if (ms >= 0) w.prevMs += ms;
  });
}
// one session at a time until budgetMs passed (0: exactly one); true when finished. A session with a digest: its days. A
// session whose rows are in memory (live, or read by another view): its new commands' families first (in slices: thousands
// of new commands do not blow a frame), then its pass. Any other: its calls file is read for the pass alone and its digest
// kept — rows and texts are not.
export function stepWait(r: WaitRun, budgetMs: number): boolean {
  STEPS.n++;
  const until = Date.now() + budgetMs;
  while (!r.done) {
    if (r.i === r.nst && r.rec) endStatic(r);
    if (r.i >= r.ss.length) {
      if (r.pi < r.ps.length) { const x = r.ps[r.pi]; r.pi++; if (x) partDay(r, x); if (Date.now() >= until) break; continue; }
      finish(r); break;
    }
    const s = r.ss[r.i];
    if (s && r.phase === 0) {
      r.dg = null; r.sc = null;
      const la = sessMatches(r.f, s) ? ledger.get(s.path) : undefined;
      if (la && inWindows(r, la)) {
        if (foldable(r)) {
          r.dg = readDigest(s.path, la.off, false);
          if (!r.dg && unread.has(s.path)) { r.job = digestJob(s.path, la); r.phase = 3; } // none yet: worked out from its calls file (digest.ts)
        }
        if (r.phase === 0 && !r.dg && !unread.has(s.path)) { r.cmds = newCmds(r, s); r.ci = 0; r.phase = 2; }
      }
    }
    if (r.phase === 3) {
      const j = r.job; if (j && !digestStep(j, until)) break;
      const x = j ? j.out : null; r.job = null; if (x) { r.dg = x.g; r.sc = x.sc; r.built++; }
    }
    if (r.phase === 2) {
      while (r.ci < r.cmds.length) { cmdFam((r.cmds[r.ci] ?? -1) + 0); r.ci++; if ((r.ci & 63) === 0 && Date.now() >= until) break; }
      if (r.ci < r.cmds.length) break;
    }
    r.phase = 0; r.cmds = [];
    if (s) session(r, s);
    r.dg = null; r.sc = null;
    r.i++;
    if (Date.now() >= until) break;
  }
  return r.done;
}
function finish(r: WaitRun): void { r.done = true; releaseTexts(); }
// sessions done of all, and digests worked out so far (the tab's "computing")
export function waitProgress(r: WaitRun): { i: number; n: number; built: number } { return { i: r.i, n: r.ss.length, built: r.built }; }
function order(a: WRow, b: WRow): number { return b.ms - a.ms || b.n - a.n || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); }
function done(acc: Acc): WRow { acc.w.agents = acc.agents.size; return acc.w; }
// rows of the window (families and tools with ≥ 1 call in it), sorted by total time; kinds = both, summed by kind
export function waitResult(r: WaitRun): WaitReport {
  const fams: WRow[] = []; const tools: WRow[] = [];
  const kinds = new Map<string, Acc>(); const hk = waitCfg().heavyKinds;
  const addKind = (acc: Acc): void => {
    const w = acc.w; let k = kinds.get(w.kind);
    if (!k) { k = { w: newRow(w.kind, -1, false, w.kind, hk.indexOf(w.kind) >= 0, false), agents: new Set<string>() }; kinds.set(w.kind, k); }
    const x = k.w; x.n += w.n; x.timed += w.timed; x.ms += w.ms; x.err += w.err; x.prevN += w.prevN; x.prevMs += w.prevMs; if (w.max > x.max) x.max = w.max;
    for (let b = 0; b < HB; b++) x.hist[b] = (x.hist[b] ?? 0) + (w.hist[b] ?? 0);
    for (const c of w.slow) slowIn(x, c);
    for (const p of acc.agents) k.agents.add(p);
  };
  for (const a of r.fams.values()) { if (a.w.n > 0) { addKind(a); fams.push(done(a)); } }
  for (const a of r.tools.values()) { if (a.w.n > 0) { addKind(a); tools.push(done(a)); } }
  const ks: WRow[] = []; for (const a of kinds.values()) ks.push(done(a));
  fams.sort(order); tools.sort(order); ks.sort(order);
  return { since: r.since, until: r.until, prevSince: r.prevSince, days: r.cur.size, complete: r.prevSince >= r.cut, fams, kinds: ks, tools, split: r.split, spans: r.spans,
    sessions: r.roots.size, bgCalls: 0, done: r.done, f: r.f, cut: r.cut, cands: r.cands };
}
export function trendOf(w: WRow, complete: boolean): number | null { return complete && w.prevMs > 0 ? w.ms / w.prevMs - 1 : null; }
export function shareOf(w: WRow, s: Split): number { return s.activeMs > 0 ? w.ms / s.activeMs : 0; }

// ── drill-down: a row's slowest calls ──
// the rows read gave theirs (WRow.slow); a digest day gives its longest call's length only, so the days that can hold one
// of the SLOW longest are read, longest first, until no day left can beat the list. members: the rows whose calls are
// the row's (itself; for a kind, its families and tools)
export interface Drill { rep: WaitReport; keys: Set<string>; out: SlowCall[]; cs: Cand[]; i: number; both: Set<string> }
export function newDrill(rep: WaitReport, w: WRow, members: WRow[]): Drill {
  const keys = new Set<string>(); const cs: Cand[] = []; const seen = new Map<string, Cand>(); // a day once, at its longest member's max
  for (const m of members) {
    const k = candKey(m); if (keys.has(k)) continue; keys.add(k);
    for (const c of rep.cands.get(k) ?? []) { const dk = c.path + "\t" + String(c.t0); const o = seen.get(dk); if (!o) { const x: Cand = { path: c.path, t0: c.t0, t1: c.t1, max: c.max }; seen.set(dk, x); cs.push(x); } else if (c.max > o.max) o.max = c.max; }
  }
  cs.sort((a: Cand, b: Cand) => b.max - a.max || a.t0 - b.t0);
  return { rep, keys, out: w.slow.slice(), cs, i: 0, both: new Set<string>(dayKeysOf(rep.since, rep.until)) };
}
// a day at a time until budgetMs passed; true when the list is final
export function stepDrill(d: Drill, budgetMs: number): boolean {
  const until = Date.now() + budgetMs; const rep = d.rep;
  while (d.i < d.cs.length) {
    const c = d.cs[d.i]; d.i++; if (!c) continue;
    if (d.out.length >= SLOW && c.max <= (d.out[SLOW - 1]?.ms ?? 0)) { d.i = d.cs.length; break; }
    const s = sessions.get(c.path); const la = ledger.get(c.path);
    if (s && la) eachRow(rep.f, rep.cut, d.both, s, la, readDigest(c.path, la.off, true), null, (t: number, ms: number, err: number, fid: number, tool: string, cid: string): void => {
      if (t < c.t0 || t > c.t1 || t < rep.since || t >= rep.until || ms < 0) return;
      if (!d.keys.has(fid >= 0 ? "f" + String(fid) : "t" + toolFamily(tool))) return;
      slowAdd(d.out, { path: c.path, t, ms, id: cid });
    });
    if (Date.now() >= until) break;
  }
  return d.i >= d.cs.length;
}
