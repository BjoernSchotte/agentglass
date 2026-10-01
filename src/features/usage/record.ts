// agentglass — usage port: the ledger's per-session/per-day records and the primitives harness adapters record usage with
// SPDX-License-Identifier: Apache-2.0
// An adapter's usage(a, line) turns one transcript line into calls of bucket → tool/pend/lines/file/tokens;
// its result lines close a pending call with done() from calls.ts. Everything else (budgets, caching, stats) is the ledger's.
import { price, cost } from "./pricing.ts";
import { type TS, type Cnt, type Pend, newTS, cnt, norm, program, argSummary, patchFiles } from "./calls.ts";

// one local day of one session; unk = tokens (or fx turns) whose price is unknown
// tt = per tool; prog/cmds/files are keyed "<tool>\t<program | command line | path>"
export interface Day { tools: number; tt: Map<string, TS>; prog: Map<string, Cnt>; cmds: Map<string, Cnt>; files: Map<string, Cnt>; hours: number[]; inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number; add: number; del: number }
export interface Acc {
  off: number; skip: boolean; stall: number; // next unread byte; inside a >1 MB line; size at which only a partial line was left
  ids: Set<string>; days: Map<string, Day>; model: string;
  pend: Map<string, Pend>; // calls waiting for their result, by call id (not persisted: a restart loses their duration)
  ep: string; // the source's cursor epoch off counts in (SessionSource.epoch)
  x: number[]; xM: number; // the harness adapter's own running state (codex: cumulative token counters; fx: usage snapshot + its mtime)
  inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number; tools: number; add: number; del: number;
}
export const L = { ver: 0, done: 0, total: 0, prio: "", prioAt: 0, rlPct: -1, rlWin: 0, rlReset: 0, rlAt: 0 }; // rl* = latest Codex primary rate limit

export function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
function two(n: number): string { return (n < 10 ? "0" : "") + n; }
export function dayKey(d: Date): string { return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()); }
export function todayKey(): string { return dayKey(new Date()); }
// local midnight today (ms); scriptc has no new Date(y, m, d)
export function startOfDay(): number { const t = new Date(); return t.getTime() - ((t.getHours() * 60 + t.getMinutes()) * 60 + t.getSeconds()) * 1000 - t.getMilliseconds(); }
// last n local days, oldest first (anchored at noon so DST shifts can't skip a day)
export function lastDays(n: number): string[] {
  const noon = startOfDay() + 43200000; const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(noon - i * 86400000)));
  return out;
}
export function nlines(s: string): number { if (!s) return 0; const n = s.split("\n").length; return s.endsWith("\n") ? n - 1 : n; }

export function newAcc(): Acc {
  return { off: 0, skip: false, stall: -1, ids: new Set<string>(), days: new Map<string, Day>(), model: "", pend: new Map<string, Pend>(), ep: "", x: [], xM: 0,
    inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, tools: 0, add: 0, del: 0 };
}
// timestamp → day bucket + local hour; the conversion is cached per UTC hour prefix (lines arrive in order)
let tsKey = ""; let tsDay = ""; let tsHour = 0;
export function bucket(a: Acc, ms: number, iso: string): Day {
  if (iso) {
    const k = iso.slice(0, 13);
    if (k !== tsKey) { const d = new Date(iso); tsKey = k; tsDay = dayKey(d); tsHour = d.getHours(); }
  } else { const d = new Date(ms > 0 ? ms : Date.now()); tsKey = ""; tsDay = dayKey(d); tsHour = d.getHours(); }
  let d = a.days.get(tsDay);
  if (!d) { d = { tools: 0, tt: new Map<string, TS>(), prog: new Map<string, Cnt>(), cmds: new Map<string, Cnt>(), files: new Map<string, Cnt>(), hours: [], inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, add: 0, del: 0 }; for (let i = 0; i < 24; i++) d.hours.push(0); a.days.set(tsDay, d); }
  return d;
}
export function tool(a: Acc, d: Day, name: string): TS {
  a.tools++; d.tools++;
  let st = d.tt.get(name);
  if (!st) { st = newTS(); d.tt.set(name, st); }
  st.n = st.n + 1;
  st.h[tsHour] = (st.h[tsHour] ?? 0) + 1;
  d.hours[tsHour] = (d.hours[tsHour] ?? 0) + 1;
  return st;
}
// remember a call until its result shows up; shell commands are counted now, their errors on the result
export function pend(a: Acc, d: Day, st: TS, name: string, id: string, t: number, ts: string, arg: string, cmds: string[]): void {
  const sh: Cnt[] = [];
  for (const c of cmds) { const n = norm(c); if (n) { sh.push(cnt(d.prog, name + "\t" + program(n))); sh.push(cnt(d.cmds, name + "\t" + n)); } }
  if (!id) return;
  if (a.pend.size > 2000) a.pend.clear(); // results that never came (skipped >1 MB lines, crashes): don't leak
  a.pend.set(id, { t: t > 0 ? t : 0, ts, arg: argSummary(arg), st, sh });
}
// the result names the real tool (pi MCP behind a proxy): move the call's one count to that row of the same day
export function retool(a: Acc, p: Pend, name: string): void {
  const d = bucket(a, p.t, p.ts);
  let key = ""; let found = false;
  for (const [k, v] of d.tt) if (v === p.st) { key = k; found = true; break; }
  if (!found || key === name) return;
  const h = tsHour; const o = p.st;
  o.n = o.n - 1; o.h[h] = Math.max(0, (o.h[h] ?? 0) - 1);
  if (o.n <= 0) d.tt.delete(key);
  let st = d.tt.get(name);
  if (!st) { st = newTS(); d.tt.set(name, st); }
  st.n = st.n + 1; st.h[h] = (st.h[h] ?? 0) + 1;
  p.st = st;
}
export function file(d: Day, name: string, path: string, add: number, del: number): void {
  if (!path) return;
  const c = cnt(d.files, name + "\t" + path);
  c.add = c.add + add; c.del = c.del + del;
}
export function isoMs(iso: string): number {
  if (!iso) return 0;
  const d = new Date(iso); const t = d.getTime();
  return t > 0 ? t : 0;
}
export function lines(a: Acc, d: Day, nAdd: number, nDel: number): void {
  a.add = a.add + nAdd;
  a.del = a.del + nDel;
  d.add = d.add + nAdd;
  d.del = d.del + nDel;
}
function count(a: Acc, d: Day, nIn: number, nOut: number, nCr: number, w5: number, w1: number): void {
  // ponytail: spelled out — scriptc rejects some `obj.field += n` pairs on one line (SC1043)
  a.inTok = a.inTok + nIn; a.outTok = a.outTok + nOut; a.cr = a.cr + nCr; a.cw = a.cw + w5 + w1;
  d.inTok = d.inTok + nIn; d.outTok = d.outTok + nOut; d.cr = d.cr + nCr; d.cw = d.cw + w5 + w1;
}
// the harness reports its own cost (OpenCode, pi): booked as is; usd <= 0 = unknown (0 for models it has no price for) → priced like tokens()
export function usageExact(a: Acc, d: Day, model: string, nIn: number, nOut: number, nCr: number, w5: number, w1: number, usd: number): void {
  if (usd <= 0) { tokens(a, d, model, nIn, nOut, nCr, w5, w1); return; }
  count(a, d, nIn, nOut, nCr, w5, w1);
  a.cost += usd; d.cost += usd;
}
export function tokens(a: Acc, d: Day, model: string, nIn: number, nOut: number, nCr: number, w5: number, w1: number): void {
  count(a, d, nIn, nOut, nCr, w5, w1);
  const p = price(model);
  if (p) { const c = cost(p, nIn, nOut, nCr, w5, w1); a.cost += c; d.cost += c; }
  else { const t = nIn + nOut + nCr + w5 + w1; a.unk += t; d.unk += t; }
}

// every file an apply_patch-style patch touches: lines and per-file counts
export function patchLines(a: Acc, d: Day, name: string, patch: string): void {
  for (const f of patchFiles(patch)) { lines(a, d, f.add, f.del); file(d, name, f.p, f.add, f.del); }
}
