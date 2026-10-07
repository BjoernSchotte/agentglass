// agentglass — agent-wait period report: wall time per command family, per tool and per kind, the agent-time split, trend
// SPDX-License-Identifier: Apache-2.0
// One pass over the call rows of a window and the window of equal length before it (spec agent-wait §2), resumable a
// session at a time (the TUI steps it in ≤ 20 ms slices; the CLI runs it to the end). Families come from the rows' command
// ids at read time (family.ts memo); nothing here is cached or written.
import type { Sess } from "../../model/types.ts";
import { sessions, parentOf } from "../../model/sessions.ts";
import { ledger } from "../usage/ledger.ts";
import { spanMin } from "../usage/record.ts";
import { DICT, nameOf, localOf } from "../usage/facts.ts";
import type { Rows } from "../usage/rows.ts";
import { HB, hb } from "../usage/calls.ts";
import { type Compiled, sessMatches, callsIn, callCutoff } from "../query/eval.ts";
import { rowFam, famName, famKind, famHeavy, famGeneric, toolFamily, toolKind, waitCfg } from "./family.ts";
import type { CallSpan } from "./overlap.ts";

export interface SlowCall { path: string; t: number; ms: number }
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
  ss: Sess[]; i: number; fams: Map<number, Acc>; tools: Map<string, Acc>; split: Split; spans: CallSpan[]; roots: Set<string>; done: boolean;
}
export const STEPS = { n: 0 }; // stepWait calls (the tab's hidden-work check)

function zeros(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0); return a; }
function newRow(key: string, id: number, generic: boolean, kind: string, heavy: boolean, isTool: boolean): WRow {
  return { key, id, generic, kind, heavy, isTool, n: 0, timed: 0, ms: 0, max: 0, hist: zeros(HB), err: 0, agents: 0, prevN: 0, prevMs: 0, slow: [] };
}
// local day keys of [since, until)
export function dayKeysOf(since: number, until: number): string[] {
  const o: string[] = [];
  for (let t = since; t < until; t += 6 * 3600000) { const k = localOf(t).day; if (o.indexOf(k) < 0) o.push(k); }
  const last = localOf(until - 1).day; if (until > since && o.indexOf(last) < 0) o.push(last);
  return o;
}
export function newWaitRun(f: Compiled, since: number, until: number): WaitRun {
  const prevSince = since - (until - since);
  const cur = new Set<string>(dayKeysOf(since, until)); const both = new Set<string>(dayKeysOf(prevSince, until));
  const ss: Sess[] = []; for (const s of sessions.values()) if (!s.host) ss.push(s);
  return { f, since, until, prevSince, cur, both, cut: callCutoff(), minMs: waitCfg().minSec * 1000, ss, i: 0, fams: new Map<number, Acc>(), tools: new Map<string, Acc>(),
    split: { activeMs: 0, toolMs: 0, userMs: 0, pollMs: 0, modelMs: 0 }, spans: [], roots: new Set<string>(), done: false };
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
function session(r: WaitRun, s: Sess, idx: number): void {
  if (!sessMatches(r.f, s)) return;
  const root = rootOf(s); const tv: number[] = []; const uv: number[] = []; const pv: number[] = []; let rows = 0;
  callsIn(r.f, s, r.both, r.cut, (rw: Rows, i: number): void => {
    const t = rw.t[i] + 0; const cur = t >= r.since && t < r.until;
    if (!cur && !(t >= r.prevSince && t < r.since)) return;
    const ms = rw.ms[i] + 0; const fid = rowFam(rw, i);
    let a: Acc | undefined; let kind = "";
    if (fid >= 0) { a = r.fams.get(fid); kind = famKind(fid); if (!a) { a = { w: newRow(famName(fid), fid, famGeneric(fid), kind, famHeavy(fid), false), agents: new Set<string>() }; r.fams.set(fid, a); } }
    else {
      const name = nameOf(DICT.tool, rw.tool[i] + 0); const key = toolFamily(name); kind = toolKind(name);
      a = r.tools.get(key); if (!a) { a = { w: newRow(key, -1, false, kind, false, true), agents: new Set<string>() }; r.tools.set(key, a); }
    }
    const w = a.w;
    if (!cur) { w.prevN++; if (ms >= 0) w.prevMs += ms; return; }
    rows++; w.n++; a.agents.add(root);
    if (rw.err[i] === 1) w.err++;
    if (ms < 0) return;
    w.timed++; w.ms += ms; if (ms > w.max) w.max = ms;
    const b = hb(ms); w.hist[b] = (w.hist[b] ?? 0) + 1;
    slowIn(w, { path: s.path, t, ms });
    if (ms > 0) {
      tv.push(t); tv.push(t + ms);
      if (kind === "user" && fid < 0) { uv.push(t); uv.push(t + ms); }
      if (kind === "wait" || kind === "ci") { pv.push(t); pv.push(t + ms); }
    }
    if (fid >= 0 && famHeavy(fid) && ms >= r.minMs && ms > 0) r.spans.push({ t0: t, t1: t + ms, group: fid, agent: idx });
  });
  if (r.f.needsCalls && rows === 0) return; // a call filter: only sessions with a matching call in the window
  if (rows > 0) r.roots.add(root);
  let act = 0; const a = ledger.get(s.path);
  if (a) for (const [dk, d] of a.days) if (r.cur.has(dk)) act += spanMin(d.act) * 60000;
  const tool = unionLen(tv);
  const sp = r.split;
  sp.activeMs = sp.activeMs + act; sp.toolMs = sp.toolMs + tool; sp.userMs = sp.userMs + unionLen(uv); sp.pollMs = sp.pollMs + unionLen(pv);
  sp.modelMs = sp.modelMs + Math.max(0, act - tool);
}
// one session at a time until budgetMs passed (0: exactly one); true when finished
export function stepWait(r: WaitRun, budgetMs: number): boolean {
  STEPS.n++;
  const until = Date.now() + budgetMs;
  while (!r.done) {
    if (r.i >= r.ss.length) { r.done = true; break; }
    const s = r.ss[r.i]; const idx = r.i; r.i++;
    if (s) session(r, s, idx);
    if (Date.now() >= until) break;
  }
  return r.done;
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
