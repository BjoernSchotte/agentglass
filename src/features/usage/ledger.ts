// agentglass — usage ledger: incremental, budgeted per-session/per-day token, cost, tool and line counts from the raw logs
// SPDX-License-Identifier: Apache-2.0
// What a line means is the harness adapter's business (HarnessAdapter.usage, recording via ./record.ts);
// this module decides which bytes get read when, within a time slice per tick.
import { readBytes } from "../../util/fs.ts";
import type { Sess } from "../../model/types.ts";
import { H } from "../../hooks.ts";
import { TERM } from "../../term.ts";
import { sessions, SG } from "../../model/sessions.ts";
import { harnessOf, sourceOf, window } from "../../harness/index.ts";
import { FILE_SOURCE } from "../../harness/source.ts";
import { type Acc, L, newAcc, startOfDay, flushSpans, packHeavy } from "./record.ts";
import { type Rows, newRows } from "./rows.ts";
import { scrape } from "./vcs.ts";
import { OWN, reconcile, release } from "./owners.ts";
import { DEBUG_PARTS } from "../../util/selfmem.ts";

export const ledger = new Map<string, Acc>();

const CHUNK = 1048576;
// indexing pace (tui-footprint Decision 1): a 50 ms slice per tick, and the tick runs every 250 ms while indexing
// (sched.ts burst): ≤ 20 % of one core, no byte cap. tickMs documents sched.ts's cadence, it does not set it. fullMs:
// how often tick() looks at every session (in between: the hot ones, see tick)
export const PACE = { sliceMs: 50, tickMs: 250, fullMs: 5000 };
const LIVE_MB = 1048576; // a live session this far behind is indexing (a first read, a resume), below it is ingest

// call rows the cache has but this run has not read (cache.ts): a session's calls file is read only when something asks
// for its rows (callsOf) or right before the session grows, so its rows stay whole when it is saved; false = none or stale,
// the session is indexed from the start
export const unread = new Set<string>();
export const LAZY = { rows: (path: string, a: Acc): boolean => false };
// a reader of call rows (errors, triage: only the sessions of their window): this session's rows, now
export function rowsOf(s: Sess): void {
  const a = ledger.get(s.path); if (!a || !unread.has(s.path)) return;
  unread.delete(s.path); if (!LAZY.rows(s.path, a)) ledger.delete(s.path); // stale: accOf starts it over
}
// one-shot runs index a session whose rows turned out stale right away (the answer must be whole); the TUI leaves that to
// its ticks (term.ts TERM.tui) rather than block a frame on reading a whole log
function blocking(): boolean { return !TERM.tui; }
// the one way to read a session's call rows (filters, rules, triage, compare, Stats): reads its calls file first if this
// run has not; no rows when it has none (yet). Callers must not keep the Rows or an index past their pass (prune compacts).
const NONE = newRows();
export function callsOf(s: Sess): Rows {
  if (unread.has(s.path)) { rowsOf(s); if (!ledger.has(s.path) && blocking()) complete(s); }
  const a = ledger.get(s.path); return a ? a.rows : NONE;
}
export function accOf(s: Sess): Acc {
  let a = ledger.get(s.path);
  if (a && unread.has(s.path) && a.off < s.size) { unread.delete(s.path); if (!LAZY.rows(s.path, a)) a = undefined; }
  if (!a || s.size < a.off || a.ep !== s.ep) { // new, truncated/rewritten or other cursor epoch
    const old = a; unread.delete(s.path); a = newAcc(); a.ep = s.ep; ledger.set(s.path, a);
    if (old && (old.mv || old.mo.size)) release(s.path, old);
  }
  a.sub = s.parent !== ""; // known before the first line is booked: scan/meta set it when the session is first seen
  a.p = s.path;
  return a;
}
// logs that must be read again from the start: another log owns some of their messages now (owners.ts)
const redo = new Set<string>();
function restart(path: string): void {
  const o = ledger.get(path); if (!o) return;
  if (redo.has(path) && o.off === 0) return; // restarted already and not read since (a takeover of many messages at once)
  const a = newAcc(); a.ep = o.ep; a.hd = o.hd; a.tl = o.tl; a.sub = o.sub; a.p = path; // the head/tail memos stay valid
  unread.delete(path); ledger.set(path, a); redo.add(path); L.idx++;
}
OWN.accs = (): Map<string, Acc> => ledger;
OWN.alive = (path: string): boolean => sessions.has(path);
OWN.sub = (path: string): boolean => { const s = sessions.get(path); return !!s && s.parent !== ""; };
OWN.restart = restart;
export function pending(s: Sess, a: Acc): boolean { return a.off < s.size && a.stall !== s.size; }
// side files with running totals (fx usage-v2.json, …): cheap stat per session, re-read on change
function sidecar(s: Sess, a: Acc): void { const f = harnessOf(s.h).usageSidecar; if (f) f(s, a); }

// one chunk (≤ CHUNK bytes) of new log lines; returns bytes consumed (0 = nothing to do right now)
function step(s: Sess, a: Acc): number {
  const src = sourceOf(s.h);
  if (src !== FILE_SOURCE) { // record-cursor source (database rows): whole records, no byte skipping
    const r = src.lines(s, a.off, Math.min(s.size, a.off + window(src, CHUNK)));
    const ad = harnessOf(s.h);
    for (const l of r.lines) { ad.usage(a, l); scrape(a, l); }
    flushSpans(a); // the last result of the chunk: no later line of this session books its span
    const used = r.next - a.off; a.off = r.next;
    if (used <= 0) a.stall = s.size;
    return used * src.unit;
  }
  const len = Math.min(CHUNK, s.size - a.off);
  if (len <= 0) return 0;
  const b = readBytes(s.path, a.off, len);
  if (!b.length) { a.stall = s.size; return 0; }
  let z = b.length - 1;
  while (z >= 0 && b[z] !== 10) z--;
  if (z < 0) {
    if (a.off + b.length < s.size) { a.skip = true; a.off += b.length; return b.length; } // a >1 MB line (images, huge outputs): skip it
    a.stall = s.size; return 0; // partial last line, the agent is still writing it
  }
  const ls = new TextDecoder("utf-8").decode(b.subarray(0, z + 1)).split("\n");
  const ad = harnessOf(s.h);
  for (let i = a.skip ? 1 : 0; i < ls.length; i++) {
    const l = ls[i] ?? "";
    ad.usage(a, l); scrape(a, l); // after usage(): the calls this line closed name the command behind its output
  }
  flushSpans(a);
  a.skip = false;
  a.off += z + 1;
  return z + 1;
}
export function applyAcc(s: Sess, a: Acc): void { // the ledger's totals onto the session (fixtures use the real code)
  s.inTok = a.inTok; s.outTok = a.outTok; s.cacheRTok = a.cr; s.cacheWTok = a.cw;
  s.unkTok = a.unk; s.unkCr = a.uc;
  s.cost = (a.unk > 0 || a.uc > 0) && a.cost === 0 ? -1 : a.cost;
  s.tools = a.tools; s.linesAdd = a.add; s.linesDel = a.del;
}
function rank(s: Sess, sod: number): number {
  if (s.path === L.prio && Date.now() - L.prioAt < 3000) return 0;
  if (s.pid) return 1;
  return s.mtime >= sod ? 2 : 3;
}
// the session set changed since the last reconcile(): a log that skipped copies of a removed owner re-reads
let known = -1;
function settle(): void { const g = SG.gen * 1048576 + sessions.size; if (g !== known) { known = g; reconcile(); } }
// Per-tick work is proportional to change: a full pass over every session runs every 5 s (and when the session set
// changed); the ticks between visit only the hot sessions of the last full pass (pid-linked or pending) and the one the
// user looks at. A visit is a lookup and a few compares; accOf, the sidecar and applyAcc run only where something moved.
// Tk: what was last applied (same entry object at the same offset and the same Sess = skip; a restart or rewrite is a new
// Acc, a session seen again a new Sess, new sidecar totals move a.xM), the last sidecar stat (every 5 s unless pid-linked
// or a new entry), and the session's last share of L.done / L.total / indexing() (running sums, adjusted by deltas).
interface Tk { a: Acc | null; off: number; s: Sess | null; side: number; c: number; z: number; h: boolean }
const TK = new Map<string, Tk>();
let fullAt = 0; let fullSig = -1; let hot: Sess[] = [];
const RUN = { done: 0, total: 0, hist: 0 };
export const TICK_STATS = { applied: 0, sidecars: 0, visits: 0, full: 0 }; // counters for the checks
// re-apply every session on the next full pass (something changed totals in place, e.g. a re-pricing)
export const LGEN = { reapply: 0 }; // bumped by reapplyAll: totals derived from every session's numbers re-sum (summary.ts)
export function reapplyAll(): void { for (const k of TK.values()) k.a = null; fullAt = 0; LGEN.reapply++; }
function tkOf(s: Sess): Tk { let k = TK.get(s.path); if (!k) { k = { a: null, off: -1, s: null, side: 0, c: 0, z: 0, h: false }; TK.set(s.path, k); } return k; }
function apply(s: Sess, a: Acc, k: Tk): void { applyAcc(s, a); k.a = a; k.off = a.off; k.s = s; TICK_STATS.applied++; }
function contrib(s: Sess, a: Acc): number { return Math.min(a.off, s.size) + (a.stall === s.size && a.off < s.size ? s.size - a.off : 0); }
// history: bytes pending in a session without a live agent, or a live one far behind (not the appends of a live agent)
function hist(s: Sess, a: Acc): boolean { return pending(s, a) && (s.pid <= 0 || s.size - a.off > LIVE_MB); }
// the session's share of the running sums, now
function account(s: Sess, a: Acc, k: Tk): void {
  const c = contrib(s, a); const h = hist(s, a);
  RUN.done += c - k.c; RUN.total += s.size - k.z; RUN.hist += (h ? 1 : 0) - (k.h ? 1 : 0);
  k.c = c; k.z = s.size; k.h = h;
}
// one session: its entry, sidecar, totals; pending ones join the queue. Returns the entry.
function visit(s: Sess, t0: number, q: Sess[]): Acc {
  TICK_STATS.visits++;
  let a = ledger.get(s.path);
  if (!a || s.size < a.off || a.ep !== s.ep || a.p !== s.path || a.sub !== (s.parent !== "") || (a.off < s.size && unread.has(s.path))) a = accOf(s);
  const k = tkOf(s);
  if (s.pid > 0 || a !== k.a || t0 - k.side >= 5000) {
    k.side = t0; TICK_STATS.sidecars++;
    const xm = a.xM; sidecar(s, a); if (a.xM !== xm) k.a = null; // new running totals: apply them
  }
  if (pending(s, a)) q.push(s);
  if (a !== k.a || a.off !== k.off || s !== k.s) apply(s, a, k);
  account(s, a, k);
  return a;
}
// bytes/s booked while indexing history (the gauge's ETA) and the ingest of live appends (debug footer, Decision 2):
// sums over spans of ≥ 1 s, folded into EWMAs
const RATE = { at: 0, bytes: 0, bps: 0, since: 0 };
export const INGEST = { ms: 0, bytes: 0, at: 0, accMs: 0, accBytes: 0 };
function fold(now: number): void {
  if (!RATE.at) RATE.at = now;
  const dt = now - RATE.at;
  if (dt >= 1000) {
    if (RATE.bytes > 0) { const r = RATE.bytes * 1000 / dt; RATE.bps = RATE.bps > 0 ? RATE.bps * 0.7 + r * 0.3 : r; if (!RATE.since) RATE.since = now; }
    RATE.at = now; RATE.bytes = 0;
  }
  if (!INGEST.at) INGEST.at = now;
  const di = now - INGEST.at;
  if (di >= 1000) {
    const ms = INGEST.accMs * 1000 / di; const b = INGEST.accBytes * 1000 / di;
    INGEST.ms = INGEST.ms * 0.7 + ms * 0.3; INGEST.bytes = INGEST.bytes * 0.7 + b * 0.3;
    INGEST.at = now; INGEST.accMs = 0; INGEST.accBytes = 0;
  }
}
function tick(): void {
  const t0 = Date.now();
  settle(); redo.clear(); // restarted logs are pending: this and the next ticks read them in rank order
  const sod = startOfDay();
  const q: Sess[] = [];
  const sig = SG.gen * 1048576 + sessions.size;
  if (t0 - fullAt >= PACE.fullMs || t0 < fullAt || sig !== fullSig) {
    fullAt = t0; fullSig = sig; TICK_STATS.full++;
    RUN.done = 0; RUN.total = 0; RUN.hist = 0; const h: Sess[] = [];
    for (const s of sessions.values()) {
      const k = tkOf(s); k.c = 0; k.z = 0; k.h = false; // counted afresh
      const n = q.length; visit(s, t0, q);
      if (s.pid > 0 || q.length > n) h.push(s);
    }
    hot = h;
    if (TK.size > sessions.size + 64) for (const p of [...TK.keys()]) if (!sessions.has(p)) TK.delete(p);
  } else {
    for (const s of hot) visit(s, t0, q);
    const p = L.prio ? sessions.get(L.prio) : undefined; // the session the user looks at, hot or not
    if (p && Date.now() - L.prioAt < 3000 && hot.indexOf(p) < 0) { visit(p, t0, q); hot.push(p); }
  }
  q.sort((x, y) => rank(x, sod) - rank(y, sod) || y.mtime - x.mtime);
  let booked = 0;
  for (const s of q) {
    if (Date.now() - t0 >= PACE.sliceMs) break;
    const a = accOf(s); const live = !hist(s, a);
    const ts = Date.now(); let n = 0;
    while (Date.now() - t0 < PACE.sliceMs && ledger.get(s.path) === a) { const k = step(s, a); if (!k) break; n += k; }
    const b = ledger.get(s.path) ?? a; const k = tkOf(s);
    apply(s, b, k); account(s, b, k);
    booked += n;
    if (live) { INGEST.accMs += Date.now() - ts; INGEST.accBytes += n; } else RATE.bytes += n;
  }
  if (booked > 0) { L.ver++; L.idx++; }
  // a log took messages from others: they restarted at offset 0 and are pending now
  for (const p of redo) { const s = sessions.get(p); if (s) { const n = q.length; visit(s, t0, q); if (q.length > n && hot.indexOf(s) < 0) hot.push(s); } }
  L.done = RUN.done; L.total = RUN.total;
  fold(Date.now());
}
// history is being indexed (a first index, a resume far behind, a log of a finished agent that grew): the refresh level
// stays hot so the gauge advances, and the cache saves every 30 s. A live agent's appends are ingest, not indexing.
export function indexing(): boolean { return RUN.hist > 0; }
export interface IndexState { done: number; total: number; left: number; bps: number; since: number }
// done/total over every log; bps: EWMA of history bytes per second, 0 = unknown; since: first sample (ms, 0 = none)
export function indexState(): IndexState { return { done: L.done, total: L.total, left: Math.max(0, L.total - L.done), bps: RATE.bps, since: RATE.since }; }
DEBUG_PARTS.push(() => "ingest " + String(Math.round(INGEST.ms)) + "ms/s · " + String(Math.round(INGEST.bytes / 1024)) + "KB/s");
// blocking: everything up to the end of the file (CLI exports)
export function complete(s: Sess): void {
  settle();
  // the logs that may own messages this one carries are read too, and theirs (adapter carriers): a one-shot command that
  // reads only some sessions books every message where a full index does, whatever it read before
  const g = SG.gen * 1048576 + sessions.size;
  const seen = new Set<string>([s.path]); const q: Sess[] = [s];
  for (let i = 0; i < q.length; i++) {
    const x = q[i] ?? s; finish(x); drain();
    const f = harnessOf(x.h).carriers; const a = ledger.get(x.path); if (!f || !a) continue;
    for (const p of f(x, a, sessions, g)) { const r = sessions.get(p); if (r && !seen.has(p)) { seen.add(p); q.push(r); } }
  }
  // a one-shot run is done with these logs: their day detail maps go back to text (a cold full index holds every day of
  // every log at once otherwise); a later reader decodes a day again on use
  if (blocking()) for (const p of readNow) { const a = ledger.get(p); if (a) for (const d of a.days.values()) packHeavy(d); }
  readNow.length = 0;
}
const readNow: string[] = []; // logs finish() read bytes of during this complete()
// a log another one took messages from was read before: read it again now, so every completed number is settled
function drain(): void {
  for (let guard = 0; redo.size && guard < 10000; guard++) {
    const p = [...redo][0] ?? ""; redo.delete(p);
    const r = sessions.get(p); if (r) finish(r);
  }
}
function finish(s: Sess): void {
  const a = accOf(s);
  sidecar(s, a); // first: some adapters date log lines from it (kiro turn times)
  let n = 0; for (let k = step(s, a); k > 0 && ledger.get(s.path) === a; k = step(s, a)) n += k;
  if (n > 0) { readNow.push(s.path); L.idx++; } // not L.ver: per-session caches (git attribution) would be rebuilt for every completed session
  applyAcc(s, ledger.get(s.path) ?? a); // restarted meanwhile: redo reads it again
}

H.onTick.push(tick);

H.enrich.push((s: Sess) => { L.prio = s.path; L.prioAt = Date.now(); }); // O(1): the next tick indexes this one first
H.complete.push(complete);
