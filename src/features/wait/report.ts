// agentglass — agent-wait period report: wall time per command family, per tool and per kind, the agent-time split, trend
// SPDX-License-Identifier: Apache-2.0
// One pass over the call rows of a window and the window of equal length before it (spec agent-wait §2), resumable a
// session at a time (the TUI steps it in ≤ 20 ms slices; the CLI runs it to the end). Families come from the rows' command
// ids at read time (family.ts memo); a calls file not in memory is scanned for the pass alone, its families kept across
// runs (famcache.ts). The tab keeps the static part's sums to start its next report from (Base).
import type { Sess } from "../../model/types.ts";
import { sessions, parentOf } from "../../model/sessions.ts";
import { ledger, unread } from "../usage/ledger.ts";
import { type Acc as LAcc, spanMin } from "../usage/record.ts";
import { type CallScan, CALLS_DIR, pathKey, scanCallsFrom } from "../usage/callcache.ts";
import { DICT, nameOf, localOf } from "../usage/facts.ts";
import { type Rows, KIND_CMD } from "../usage/rows.ts";
import { HB, hb } from "../usage/calls.ts";
import { type Compiled, sessMatches, dayMatches, callsIn, callCutoff } from "../query/eval.ts";
import { rowFam, cmdFam, famKnown, famName, famKind, famHeavy, famGeneric, toolFamily, toolKind, waitCfg, textFam, releaseTexts, betterFam } from "./family.ts";
import { famsOf, putFams, saveFams } from "./famcache.ts";
import type { CallSpan } from "./overlap.ts";

export interface SlowCall { path: string; t: number; ms: number; id: string /* the harness call id (transcript focus) */ }
// one family (shell calls), tool (other calls) or kind: n calls (timed: with a duration), ms total, err failed, agents =
// distinct top-level sessions; prev* = the previous window; slow = the 10 longest calls
export interface WRow {
  key: string; id: number /* family id (overlap group); -1 tools and kinds */; generic: boolean /* interpreter + script (family.ts) */; kind: string; heavy: boolean; isTool: boolean; n: number; timed: number; ms: number; max: number;
  hist: number[]; err: number; agents: number; prevN: number; prevMs: number; slow: SlowCall[];
}
// agent time of the window: active (Day.act), tools = union of the calls' spans, user = questions to the user, polling =
// wait/ci calls (inside tools), model = active − tools (clamped per session)
export interface Split { activeMs: number; toolMs: number; userMs: number; pollMs: number; modelMs: number }
export interface WaitReport {
  since: number; until: number; prevSince: number; days: number; complete: boolean; // complete: the previous window lies inside retention
  fams: WRow[]; kinds: WRow[]; tools: WRow[]; split: Split; spans: CallSpan[]; sessions: number; bgCalls: number; done: boolean;
}
const SLOW = 10;
interface Acc { w: WRow; agents: Set<string> }
export interface WaitRun {
  f: Compiled; since: number; until: number; prevSince: number; cur: Set<string>; both: Set<string>; cut: number; minMs: number;
  ss: Sess[]; nst: number /* ss[0, nst): the static part (calls files not read yet: Base) */; i: number; phase: number /* ss[i]: 0 to read, 1 rows read, 2 families being worked out */; cmds: number[]; ci: number;
  fams: Map<number, Acc>; tools: Map<string, Acc>; split: Split; spans: CallSpan[]; roots: Set<string>; done: boolean;
  rec: Base | null /* the static part being recorded */; prev: Prev /* its rows of the previous window (applied when it ends) */;
}
export const STEPS = { n: 0 }; // stepWait calls (the tab's hidden-work check)
// rows of the previous window, kept apart: its start moves with the clock (prevSince = since − (until − since))
interface Prev { t: number[]; ms: number[]; fam: number[]; tool: string[] }
function newPrev(): Prev { return { t: [], ms: [], fam: [], tool: [] }; }
// The static part of the last unfiltered report: the sessions whose calls files were not read yet when it started
// (finished sessions, most of history), with their sums for the window and their rows of the previous one. The tab
// recomputes every 30 s while agents work; while none of those sessions changed (same ledger entry, same offset) and
// the day, retention and period are the same, a report starts from these sums and reads only the other sessions.
interface Base {
  key: string; sess: Map<string, { a: LAcc; off: number }>; fams: Map<number, Acc>; tools: Map<string, Acc>; split: Split; spans: CallSpan[]; roots: Set<string>; prev: Prev;
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
  const r: WaitRun = { f, since, until, prevSince, cur, both, cut, minMs, ss: [], nst: 0, i: 0, phase: 0, cmds: [], ci: 0, fams: new Map<number, Acc>(), tools: new Map<string, Acc>(),
    split: { activeMs: 0, toolMs: 0, userMs: 0, pollMs: 0, modelMs: 0 }, spans: [], roots: new Set<string>(), done: false, rec: null, prev: newPrev() };
  const key = baseKey(f, since, cut, minMs); const b = BASE.m.get(key);
  if (f.key === "" && b && baseOk(b, key)) { // the static part as it was: its sums, its previous-window rows from now's start
    BASE_STATS.used++;
    r.fams = copyFams(b.fams); r.tools = copyTools(b.tools); r.split = copySplit(b.split); r.spans = b.spans.slice(); r.roots = setOf(b.roots);
    applyPrev(r, b.prev);
    for (const s of sessions.values()) if (!s.host && !b.sess.has(s.path)) r.ss.push(s);
    return r;
  }
  for (const s of sessions.values()) if (!s.host && unread.has(s.path)) r.ss.push(s);
  r.nst = r.ss.length;
  for (const s of sessions.values()) if (!s.host && !unread.has(s.path)) r.ss.push(s);
  if (f.key === "") r.rec = { key, sess: new Map<string, { a: LAcc; off: number }>(), fams: new Map<number, Acc>(), tools: new Map<string, Acc>(), split: r.split, spans: [], roots: new Set<string>(), prev: r.prev };
  return r;
}
function slowIn(w: WRow, c: SlowCall): void {
  const sl = w.slow;
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
function applyPrev(r: WaitRun, p: Prev): void {
  for (let k = 0; k < p.t.length; k++) {
    if ((p.t[k] ?? 0) < r.prevSince) continue;
    const w = accFor(r, (p.fam[k] ?? -1) + 0, p.tool[k] ?? "").w; const ms = (p.ms[k] ?? -1) + 0;
    w.prevN++; if (ms >= 0) w.prevMs += ms;
  }
}
// one session's pass: its rows of the windows, whichever reader gives them
interface Pass { s: Sess; root: string; idx: number; tv: number[]; uv: number[]; pv: number[]; rows: number }
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
// a session whose calls file can be read for this pass alone (its rows are not in memory, the filter tests no call)
function scannable(r: WaitRun, s: Sess): boolean { return unread.has(s.path) && r.f.call.length === 0 && r.f.rowx.length === 0; }
// the families of a scanned file's commands: stored (famcache.ts) while the file is the same, else from their texts
function scanned(s: Sess, a: LAcc): { sc: CallScan; fams: number[] } | null {
  const known = famsOf(s.path, a.off);
  let sc = scanCallsFrom(CALLS_DIR, s.path, a, known === null); if (!sc) return null;
  if (known && known.length === sc.ncmd) return { sc, fams: known };
  if (known) { sc = scanCallsFrom(CALLS_DIR, s.path, a, true); if (!sc) return null; } // stored for another command list
  const fams: number[] = []; for (const x of sc.cmds) fams.push(textFam(x));
  putFams(s.path, a.off, fams);
  return { sc, fams };
}
// a session's id in spans (overlap's "agents at the peak"): stable across reports, the static part's spans keep theirs
const AGENTS = new Map<string, number>();
function agentId(path: string): number { let i = AGENTS.get(path); if (i === undefined) { i = AGENTS.size; AGENTS.set(path, i); } return i; }
function session(r: WaitRun, s: Sess): void {
  if (!sessMatches(r.f, s)) return;
  const p: Pass = { s, root: rootOf(s), idx: agentId(s.path), tv: [], uv: [], pv: [], rows: 0 };
  const la = ledger.get(s.path);
  const x = la && scannable(r, s) && unreadIn(r, s) ? scanned(s, la) : null;
  if (x && la) {
    const sc = x.sc; const fams = x.fams; const fd = r.f.day.length > 0;
    for (let i = 0; i < sc.n; i++) {
      const t = (sc.t[i] ?? 0) + 0; if (t < r.cut) continue;
      if (fd) { const dk = localOf(t).day; const d = la.days.get(dk); if (!d || !dayMatches(r.f, s, dk, d)) continue; }
      let fid = -1; for (const c of sc.cm[i] ?? []) if (c >= 0 && c < fams.length) fid = betterFam(fid, (fams[c + 0] ?? -1) + 0);
      const ti = (sc.to[i] ?? -1) + 0; const id = sc.ci[i] ?? "";
      row(r, p, t, (sc.ms[i] ?? -1) + 0, (sc.er[i] ?? -1) + 0, fid, ti >= 0 ? sc.tools[ti] ?? "" : "", id ? sc.cp + id : "");
    }
  } else callsIn(r.f, s, r.both, r.cut, (rw: Rows, i: number): void => {
    const fid = rowFam(rw, i);
    row(r, p, rw.t[i] + 0, rw.ms[i] + 0, rw.err[i] + 0, fid, fid >= 0 ? "" : nameOf(DICT.tool, rw.tool[i] + 0), rw.cid[i] ?? "");
  });
  const a = ledger.get(s.path);
  if (r.rec && r.i < r.nst && a) r.rec.sess.set(s.path, { a, off: a.off });
  if (r.f.needsCalls && p.rows === 0) return; // a call filter: only sessions with a matching call in the window
  if (p.rows > 0) r.roots.add(p.root);
  let act = 0;
  if (a) for (const [dk, d] of a.days) if (r.cur.has(dk)) act += spanMin(d.act) * 60000;
  const tool = unionLen(p.tv);
  const sp = r.split;
  sp.activeMs = sp.activeMs + act; sp.toolMs = sp.toolMs + tool; sp.userMs = sp.userMs + unionLen(p.uv); sp.pollMs = sp.pollMs + unionLen(p.pv);
  sp.modelMs = sp.modelMs + Math.max(0, act - tool);
}
// a session whose call rows this run has not read yet and that has a day in the windows
function unreadIn(r: WaitRun, s: Sess): boolean {
  if (!unread.has(s.path)) return false;
  const a = ledger.get(s.path); if (!a) return false;
  for (const k of a.days.keys()) if (r.both.has(k)) return true;
  return false;
}
// the command ids of s's rows in the windows whose family is not worked out yet
function newCmds(r: WaitRun, s: Sess): number[] {
  const o: number[] = []; const seen = new Set<number>();
  callsIn(r.f, s, r.both, r.cut, (rw: Rows, i: number): void => {
    const e = i + 1 < rw.n ? rw.lo[i + 1] + 0 : rw.nl;
    for (let k = rw.lo[i] + 0; k < e; k++) { const v = rw.li[k] + 0; if (v % 4 === KIND_CMD) { const id = (v - KIND_CMD) / 4; if (!famKnown(id) && !seen.has(id)) { seen.add(id); o.push(id); } } }
  });
  return o;
}
// the static part ends: keep a copy of its sums (the next report may start there), then its previous-window rows count
function endStatic(r: WaitRun): void {
  const b = r.rec; if (!b) return;
  b.fams = copyFams(r.fams); b.tools = copyTools(r.tools); b.split = copySplit(r.split); b.spans = r.spans.slice(); b.roots = setOf(r.roots);
  const old: string[] = []; for (const k of BASE.m.keys()) if ((k.split("|")[1] ?? "") !== String(r.cut)) old.push(k); // a day ago: never valid again
  for (const k of old) BASE.m.delete(k);
  if (BASE.m.size >= 4) BASE.m.clear();
  BASE.m.set(b.key, b); r.rec = null;
  applyPrev(r, r.prev); r.prev = newPrev();
}
// one session at a time until budgetMs passed (0: exactly one); true when finished. A session whose rows are in memory
// (live, or read by another view): its new commands' families first (in slices: thousands of new commands do not blow a
// frame), then its pass. Any other: its calls file is read for the pass alone (scanned) — rows and texts are not kept.
export function stepWait(r: WaitRun, budgetMs: number): boolean {
  STEPS.n++;
  const until = Date.now() + budgetMs;
  while (!r.done) {
    if (r.i === r.nst && r.rec) endStatic(r);
    if (r.i >= r.ss.length) { finish(r); break; }
    const s = r.ss[r.i];
    if (s && r.phase === 0 && sessMatches(r.f, s) && !scannable(r, s)) { r.cmds = newCmds(r, s); r.ci = 0; r.phase = 2; }
    if (r.phase === 2) {
      while (r.ci < r.cmds.length) { cmdFam((r.cmds[r.ci] ?? -1) + 0); r.ci++; if ((r.ci & 63) === 0 && Date.now() >= until) break; }
      if (r.ci < r.cmds.length) break;
    }
    r.phase = 0; r.cmds = [];
    if (s) session(r, s);
    r.i++;
    if (Date.now() >= until) break;
  }
  return r.done;
}
function finish(r: WaitRun): void {
  r.done = true; releaseTexts();
  saveFams((): Set<string> => { const o = new Set<string>(); for (const p of sessions.keys()) o.add(pathKey(p)); return o; }); // the sessions that still exist
}
export function waitProgress(r: WaitRun): { i: number; n: number } { return { i: r.i, n: r.ss.length }; }
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
    sessions: r.roots.size, bgCalls: 0, done: r.done };
}
export function trendOf(w: WRow, complete: boolean): number | null { return complete && w.prevMs > 0 ? w.ms / w.prevMs - 1 : null; }
export function shareOf(w: WRow, s: Split): number { return s.activeMs > 0 ? w.ms / s.activeMs : 0; }
