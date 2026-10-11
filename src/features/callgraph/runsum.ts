// agentglass — the session detail's transcript figures (turns, wall and active time, repeat runs, error texts) as a
// running summary per log, read from a cursor like the index reads costs: the first ask reads the log once (serve: in
// slices), later asks read only what was appended — a live 100 MB session answers in milliseconds. The span rules are
// the call graph's own (model.ts spanFeed/spanEnd), so the figures equal summary(buildGraph(…)) and loopRuns: spans
// that can no longer change are folded into the turn count, the min/max times and a merged interval list, then dropped.
// A subagent's log contributes its agent span [first, last event] (it covers its calls) and its repeat runs.
// States are kept for the sessions asked about (gradually, no re-index) in <cache>/detail.jsonl.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ev, Sess } from "../../model/types.ts";
import { sourceOf, parseEvents, window } from "../../harness/index.ts";
import { type Span, type SpanSt, K_TURN, K_TOOL, newSpanSt, spanFeed, spanEnd, isErr, ms } from "./model.ts";
import { type TurnCursor } from "./turns.ts";
import { CACHE_DIR } from "../usage/callcache.ts";
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";

// per log: error texts by call id (the errors list shows 10, newest first), a few of any result (an error the ledger saw
// that the text heuristics miss), repeat runs; STATES_MAX logs kept: a session with hundreds of subagents fits
export const TEXT_MAX = 200; export const TEXTS_ERR = 50; export const TEXTS_ANY = 20; export const RUNS_MAX = 200; export const STATES_MAX = 3000;
export interface RunRec { tool: string; arg: string; n: number; ts: string }
export interface LogSum {
  p: string; ep: string; off: number; top: boolean; used: number;
  st: SpanSt; out: Span[]; // the spans not folded yet (top-level logs)
  turnsAt: number; t0: number; t1: number; iv: number[]; // folded: min t0 / max t1 of spans, merged tool intervals [a,z,…]
  first: number; last: number; // first and last event time (a subagent's agent span)
  rn: number; rk: string; rf: RunRec | null; runs: RunRec[]; // the current repeat run (key hash) and the finished ones (≥ 3)
  errT: Map<string, string>; anyT: Map<string, string>; // result texts by call id: errors, and the latest of any
}
export function newSum(p: string, ep: string, top: boolean): LogSum {
  return { p, ep, off: 0, top, used: Date.now(), st: newSpanSt(0, -1, 0), out: [], turnsAt: 0, t0: 0, t1: 0, iv: [], first: 0, last: 0,
    rn: 0, rk: "", rf: null, runs: [], errT: new Map<string, string>(), anyT: new Map<string, string>() };
}
// a span to fill from the cache
function blank(): Span { return { t0: 0, t1: 0, depth: 0, row: 0, kind: 2, cat: 4, name: "", arg: "", id: "", err: -1, open: false, est: false, src: 0, ev: -1, parent: -1, ix: 0 }; }

// ── intervals: a sorted merged list [a0,z0,a1,z1,…]; spans mostly come in time order, so the search starts at the end ──
export function ivAdd(iv: number[], a: number, z: number): void {
  if (z <= a) return;
  let i = iv.length - 2;
  while (i >= 0 && (iv[i] ?? 0) > a) i -= 2; // the last pair starting at or before a
  // merge with the pair at i (if it reaches a) and every later pair z covers
  let lo = i >= 0 && (iv[i + 1] ?? 0) >= a ? i : i + 2; let na = a; let nz = z;
  if (lo === i) { na = iv[i] ?? a; nz = Math.max(nz, iv[i + 1] ?? z); }
  let hi = lo;
  while (hi < iv.length && (iv[hi] ?? 0) <= nz) { nz = Math.max(nz, iv[hi + 1] ?? nz); hi += 2; }
  iv.splice(lo, hi - lo, na, nz);
}
export function ivLen(iv: number[]): number { let n = 0; for (let i = 0; i + 1 < iv.length; i += 2) n += (iv[i + 1] ?? 0) - (iv[i] ?? 0); return n; }

// ── feeding: one event ──
function hashKey(s: string): string { let h1 = 0x811c9dc5; let h2 = 0x01000193; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 + c, 2246822519) >>> 0; } return String(h1) + "." + String(h2) + "." + String(s.length); }
function closeRun(ls: LogSum): void { if (ls.rf && ls.rn >= 3) { ls.runs.push({ tool: ls.rf.tool, arg: ls.rf.arg, n: ls.rn, ts: ls.rf.ts }); if (ls.runs.length > RUNS_MAX) ls.runs.shift(); } ls.rn = 0; ls.rk = ""; ls.rf = null; }
function keep(m: Map<string, string>, k: string, v: string, max: number): void { m.delete(k); m.set(k, v); if (m.size > max) for (const x of m.keys()) { m.delete(x); break; } }
export function sumFeed(ls: LogSum, e: Ev): void {
  const t = ms(e.ts); if (t) { if (!ls.first) ls.first = t; ls.last = t; } // as buildGraph's agent span: first and last timed event
  // repeat runs (detect.ts loopRuns): identical tool calls in a row; results and thinking do not break a run
  if (e.kind !== "result" && e.kind !== "thinking") {
    if (e.kind !== "tool") closeRun(ls);
    else {
      const k = hashKey(e.text + "\u0001" + e.full);
      if (ls.rn > 0 && k !== ls.rk) closeRun(ls);
      if (ls.rn === 0) { const i = e.text.indexOf("\u0000"); ls.rf = { tool: i >= 0 ? e.text.slice(0, i) : e.text, arg: i >= 0 ? e.text.slice(i + 1) : "", n: 0, ts: e.ts }; }
      ls.rk = k; ls.rn++;
    }
  }
  if (e.kind === "result" && e.id) { const x = e.text.length > TEXT_MAX ? e.text.slice(0, TEXT_MAX) : e.text; keep(ls.anyT, e.id, x, TEXTS_ANY); if (isErr(e.text)) keep(ls.errT, e.id, x, TEXTS_ERR); }
  if (!ls.top) return; // a subagent: its agent span covers its calls
  spanFeed(ls.st, e, ls.out);
  if (ls.out.length > 64) fold(ls);
}
// fold the spans that can no longer change: closed turns, and closed calls of a closed turn; renumber the rest
function fold(ls: LogSum): void {
  const st = ls.st; const keepIx: number[] = [];
  for (let i = 0; i < ls.out.length; i++) {
    const s = ls.out[i] as Span;
    const done = s.kind === K_TURN ? i !== st.turn : !s.open && s.parent !== st.turn;
    if (!done) { keepIx.push(i); continue; }
    if (!ls.t0 || s.t0 < ls.t0) ls.t0 = s.t0; if (s.t1 > ls.t1) ls.t1 = s.t1;
    if (s.kind !== K_TURN) ivAdd(ls.iv, s.t0, s.t1);
  }
  if (keepIx.length === ls.out.length) return;
  const map = new Map<number, number>(); const out: Span[] = [];
  for (let j = 0; j < keepIx.length; j++) { const i = keepIx[j] ?? 0; const x = ls.out[i]; if (x) { map.set(i, out.length); out.push(x); } }
  for (const s of out) s.parent = s.parent >= 0 ? map.get(s.parent) ?? -3 : s.parent; // a folded turn: closed, never spread again
  st.turn = st.turn >= 0 ? map.get(st.turn) ?? -1 : -1;
  for (const [k, v] of st.pending) { const n = map.get(v); if (n === undefined) st.pending.delete(k); else st.pending.set(k, n); }
  const an: number[] = []; for (const v of st.anon) { const n = map.get(v); if (n !== undefined) an.push(n); } st.anon = an;
  ls.out = out;
}

// ── reading from the cursor ──
const STATES = new Map<string, LogSum>(); const IO = { loaded: false, dirty: false, savedAt: 0 };
export function stateOf(s: Sess, top: boolean): LogSum {
  load();
  let ls = STATES.get(s.path);
  if (!ls || ls.ep !== s.ep || ls.top !== top || s.size < ls.off) { ls = newSum(s.path, s.ep, top); STATES.set(s.path, ls); } // new, or the log restarted
  ls.used = Date.now();
  return ls;
}
export function caughtUp(ls: LogSum, s: Sess): boolean { return ls.off >= s.size; }
// read on from the cursor for about budget ms (0 = to the end); true = at the log's end
export function sumStep(ls: LogSum, s: Sess, budget: number): boolean {
  const src = sourceOf(s.h); const stt = src.stat(s); if (!stt) return true;
  const end = budget > 0 ? Date.now() + budget : 0; const evs: Ev[] = [];
  while (ls.off < stt.size) {
    const r = src.lines(s, ls.off, Math.min(stt.size, ls.off + window(src, 4194304))); // allEvents' window: a line it reads, this reads
    for (const l of r.lines) { evs.length = 0; parseEvents(s.h, l, evs, s); for (const e of evs) sumFeed(ls, e); }
    if (r.next <= ls.off) break;
    ls.off = r.next; IO.dirty = true;
    if (end && Date.now() >= end) break;
  }
  return ls.off >= stt.size;
}

// ── the figures over a session's logs: fam[0] the session (top), the rest its subagents ──
export interface SumOut { turns: number; wallMs: number; activeMs: number; runs: { r: RunRec; i: number }[]; texts: Map<string, string> }
function cloneSpan(s: Span): Span { return { t0: s.t0, t1: s.t1, depth: s.depth, row: s.row, kind: s.kind, cat: s.cat, name: s.name, arg: s.arg, id: s.id, err: s.err, open: s.open, est: s.est, src: s.src, ev: s.ev, parent: s.parent, ix: s.ix }; }
function cloneSt(st: SpanSt): SpanSt {
  const c: TurnCursor = { open: st.cur.open, n: st.cur.n, closedBy: st.cur.closedBy, prompt: st.cur.prompt, late: st.cur.late };
  const p = new Map<string, number>(); for (const [k, v] of st.pending) p.set(k, v);
  return { src: st.src, parent: st.parent, depth: st.depth, pending: p, anon: st.anon.slice(), turn: st.turn, last: st.last, cur: c, i: st.i };
}
// null: nothing timed at all (the graph lays turns out in units then), or a subagent with one timestamp (its span is
// its spawning call's): the caller reads the logs in full
export function sumOut(states: LogSum[], live: boolean[], now: number): SumOut | null {
  const iv: number[] = []; let t0 = 0; let t1 = 0; let turns = 0;
  const at = (a: number, z: number): void => { if (!t0 || a < t0) t0 = a; if (z > t1) t1 = z; };
  for (let k = 0; k < states.length; k++) {
    const ls = states[k] as LogSum; const lv = live[k] ?? false;
    if (ls.top) {
      turns += ls.st.cur.n;
      for (let i = 0; i + 1 < ls.iv.length; i += 2) ivAdd(iv, ls.iv[i] ?? 0, ls.iv[i + 1] ?? 0);
      if (ls.t0) at(ls.t0, ls.t1);
      const out: Span[] = []; for (const s of ls.out) out.push(cloneSpan(s));
      const st = cloneSt(ls.st); spanEnd(st, lv, now, out);
      for (const s of out) { at(s.t0, s.t1); if (s.kind !== K_TURN) ivAdd(iv, s.t0, s.t1); }
    } else if (ls.first) {
      const z = lv ? Math.max(ls.last, now) : ls.last;
      if (z <= ls.first) return null; // one timestamp: the graph fills its spawning call's span (hostOf) — read in full
      at(ls.first, z); ivAdd(iv, ls.first, z);
    }
  }
  if (t1 <= t0) return null;
  const runs: { r: RunRec; i: number }[] = []; const texts = new Map<string, string>();
  for (let k = 0; k < states.length; k++) {
    const ls = states[k] as LogSum;
    for (const r of ls.runs) runs.push({ r, i: k });
    if (ls.rf && ls.rn >= 3) runs.push({ r: { tool: ls.rf.tool, arg: ls.rf.arg, n: ls.rn, ts: ls.rf.ts }, i: k });
    for (const [id, t] of ls.anyT) texts.set(id, t); for (const [id, t] of ls.errT) texts.set(id, t);
  }
  return { turns, wallMs: t1 - t0, activeMs: ivLen(iv), runs, texts };
}

// ── persistence: <cache>/detail.jsonl, one state per line; the newest STATES_MAX asked-about logs ──
const FILE = join(CACHE_DIR, "detail.jsonl"); const VER = 1;
function load(): void {
  if (IO.loaded) return; IO.loaded = true;
  let text = ""; try { text = readFileSync(FILE, "utf8"); } catch (e) { return; }
  const ls = text.split("\n"); if (ls[0] !== "{\"v\":" + String(VER) + "}") return; // another format: start over
  for (let i = 1; i < ls.length; i++) { const o = parse(ls[i] ?? ""); const s = o ? fromJson(o) : null; if (s) STATES.set(s.p, s); } // a broken line: that log starts over
}
export function saveSums(force: boolean): void {
  if (!IO.dirty || (!force && Date.now() - IO.savedAt < 60000)) return;
  const all = [...STATES.values()].sort((a, b) => b.used - a.used).slice(0, STATES_MAX);
  const lines = ["{\"v\":" + String(VER) + "}"]; for (const s of all) lines.push(JSON.stringify(toJson(s)));
  try { mkdirSync(CACHE_DIR, { recursive: true }); const tmp = FILE + ".tmp" + String(process.pid); writeFileSync(tmp, lines.join("\n") + "\n"); renameSync(tmp, FILE); IO.dirty = false; IO.savedAt = Date.now(); } catch (e) { /* the next save tries again */ }
}
process.on("exit", () => { try { saveSums(true); } catch (e) { /* never block the exit */ } });
function spanJ(s: Span): number[] { return [s.t0, s.t1, s.depth, s.kind, s.open ? 1 : 0, s.parent, s.err]; }
function pairs(m: Map<string, string>): string[][] { const o: string[][] = []; for (const [k, v] of m) o.push([k, v]); return o; }
export function toJson(ls: LogSum): Obj {
  const st = ls.st; const pend: unknown[] = []; for (const [k, v] of st.pending) pend.push([k, v]);
  const ids: string[] = []; const out: number[][] = []; for (const s of ls.out) { ids.push(s.id); out.push(spanJ(s)); }
  const runs: Obj[] = []; for (const r of ls.runs) runs.push({ tool: r.tool, arg: r.arg, n: r.n, ts: r.ts });
  return { p: ls.p, ep: ls.ep, off: ls.off, top: ls.top, used: ls.used, t0: ls.t0, t1: ls.t1, iv: ls.iv, first: ls.first, last: ls.last,
    st: [st.turn, st.last, st.i, st.cur.open ? 1 : 0, st.cur.n, st.cur.prompt ? 1 : 0, st.cur.late ? 1 : 0], cb: st.cur.closedBy, pend, anon: st.anon,
    out, ids, rn: ls.rn, rk: ls.rk, rf: ls.rf ? { tool: ls.rf.tool, arg: ls.rf.arg, ts: ls.rf.ts } : null, runs, errT: pairs(ls.errT), anyT: pairs(ls.anyT) };
}
function n0(v: unknown): number { return typeof v === "number" && isFinite(v) ? v : 0; }
function nums(v: unknown): number[] { const o: number[] = []; for (const x of arr(v)) o.push(n0(x)); return o; }
export function fromJson(o: Obj): LogSum | null {
  const p = str(o["p"]); if (!p || typeof o["off"] !== "number") return null;
  const ls = newSum(p, str(o["ep"]), o["top"] === true);
  ls.off = n0(o["off"]); ls.used = n0(o["used"]); ls.t0 = n0(o["t0"]); ls.t1 = n0(o["t1"]);
  ls.iv = nums(o["iv"]); ls.first = n0(o["first"]); ls.last = n0(o["last"]);
  const a = nums(o["st"]);
  ls.st.turn = a.length > 0 ? a[0] ?? -1 : -1; ls.st.last = a[1] ?? 0; ls.st.i = a[2] ?? 0;
  ls.st.cur = { open: a[3] === 1, n: a[4] ?? 0, closedBy: str(o["cb"]), prompt: a[5] === 1, late: a[6] === 1 };
  for (const x of arr(o["pend"])) { const q = arr(x); ls.st.pending.set(str(q[0]), n0(q[1])); }
  ls.st.anon = nums(o["anon"]);
  const ids = arr(o["ids"]); const out: Span[] = []; let j = 0;
  for (const x of arr(o["out"])) { const n = nums(x); const s = blank(); s.t0 = n[0] ?? 0; s.t1 = n[1] ?? 0; s.depth = n[2] ?? 0; s.kind = n[3] ?? K_TOOL; s.open = n[4] === 1; s.parent = n.length > 5 ? n[5] ?? -1 : -1; s.err = n.length > 6 ? n[6] ?? -1 : -1; s.id = str(ids[j]); out.push(s); j++; }
  ls.out = out;
  ls.rn = n0(o["rn"]); ls.rk = str(o["rk"]);
  const rf = obj(o["rf"]); ls.rf = rf ? { tool: str(rf["tool"]), arg: str(rf["arg"]), n: 0, ts: str(rf["ts"]) } : null;
  for (const x of arr(o["runs"])) { const r = obj(x); if (r) ls.runs.push({ tool: str(r["tool"]), arg: str(r["arg"]), n: n0(r["n"]), ts: str(r["ts"]) }); }
  for (const x of arr(o["errT"])) { const q = arr(x); ls.errT.set(str(q[0]), str(q[1])); }
  for (const x of arr(o["anyT"])) { const q = arr(x); ls.anyT.set(str(q[0]), str(q[1])); }
  return ls;
}
export function resetSumsForTest(): void { STATES.clear(); IO.loaded = true; IO.dirty = false; }
