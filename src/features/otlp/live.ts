// agentglass — `agentglass --watch --otlp <url>`: closed turns stream to the backend while agents work (spec 5.2)
// SPDX-License-Identifier: Apache-2.0
// The transcripts are the spool: the queue is bounded, a dropped or unsent turn is not marked, so the next `export`
// sends it from the transcripts. No second copy on disk.
import type { Sess } from "../../model/types.ts";
import { sessions, loadTail } from "../../model/sessions.ts";
import { approvalOf } from "../watchdog.ts";
import { type SState, sessState, sameState } from "../../model/state.ts";
import { type SessB, newSessB, advance, syncSubs, openCall, busyOf, repoKeyOf } from "./build.ts";
import { type XTurn, type XSpan, attrD, attrB } from "./types.ts";
import { type OtlpCfg, cfgFrom } from "./config.ts";
import { type XLog, type AlertT, heartbeat, stateLog, turnOpenLog, alertLog, HEARTBEAT_S } from "./logs.ts";

export const QUIET_LIVE = 120000; // a turn without a close marker counts as finished after 2 quiet minutes
const OUT_RECHECK = 2000; // a session judged out: how often its tail is read again to see whether it came in
const FLUSH_MS = 5000; const FLUSH_SPANS = 512; const MAX_SPANS = 10000; const BACKOFF_MAX = 300000;
const MAX_LOGS = 2000; const STATE_REPEAT = 300000; // logs stream (otlp-complete 2.6, 2.3)
export interface PendAlert { s: Sess; a: AlertT }
export interface Live {
  b: Map<string, SessB>; q: XTurn[]; qSpans: number; lastFlush: number; dropped: boolean; fails: number; retryAt: number;
  appr: Map<string, string>; // session path → the open call's span id waiting for approval
  apprAt: Map<string, number>; // … and when it was first seen waiting
  late: Map<string, number[]>; // a cleared wait whose call is not logged yet: [seen, cleared]
  since: number; content: boolean; subagents: boolean;
  ticks: number; running: Set<string>; // turns open at the first poll (path + key): exported when they close, whatever --since says
  want: (s: Sess) => boolean; // selection (harness, session clauses)
  skip: (t: XTurn) => boolean; // already marked for this endpoint, or left to the harness's own export
  approval: (s: Sess) => string; // the watchdog's estimate (a stub in checks)
  warn: (msg: string) => void;
  sent: number; lastOk: number;
  halt: string; // a TLS failure stopped sending for the run (the message); turns stay queued, unmarked
  // ── the logs stream (otlp-complete 2): best effort, own bounded queue, never marked ──
  logs: boolean; cfg: OtlpCfg; // on (a logs endpoint, not --no-logs, not answered 404/405); titles/attribute tables for the records
  lq: XLog[]; lqDropped: boolean; lastLogFlush: number; logFails: number; logRetryAt: number; resendState: boolean;
  lastBeat: number; st: Map<string, SState>; stAt: Map<string, number>; // last state per session path and when it was sent
  opened: Set<string>; // open turns announced (path + key); a closed turn leaves it
  away: Set<string>; // open turns (path + key) seen while their session was outside --filter: never sent
  track: (s: Sess) => boolean; // not wanted now but may be later (--filter judged it out, not merely unknown): followed
  outAt: Map<string, number>; // sessions judged out before they had a builder: the last such poll (their turns from before are never sent)
  pend: PendAlert[]; // rules transitions from the --watch loop (Sink.alert), queued on the next tick
  sendLogs: (logs: XLog[]) => boolean; // false = failed (backoff); it may switch L.logs off (404/405) or set L.halt
  busyRule: (b: SessB) => boolean; // the builder's busy rule (a stub in checks)
}
export function newLive(since: number): Live {
  return { b: new Map<string, SessB>(), q: [], qSpans: 0, lastFlush: 0, dropped: false, fails: 0, retryAt: 0, appr: new Map<string, string>(), apprAt: new Map<string, number>(), late: new Map<string, number[]>(), since, content: false, subagents: true, ticks: 0, running: new Set<string>(),
    want: (s: Sess) => !!s, skip: (t: XTurn) => !t, approval: approvalOf, warn: (m: string) => { process.stderr.write("agentglass: " + m + "\n"); }, sent: 0, lastOk: 0, halt: "",
    logs: false, cfg: cfgFrom({}), lq: [], lqDropped: false, lastLogFlush: 0, logFails: 0, logRetryAt: 0, resendState: false, lastBeat: 0, st: new Map<string, SState>(), stAt: new Map<string, number>(),
    opened: new Set<string>(), away: new Set<string>(), track: (s: Sess) => !s, outAt: new Map<string, number>(), pend: [], sendLogs: (ls: XLog[]) => ls.length >= 0, busyRule: busyOf };
}
// over MAX_SPANS: the oldest whole turns go (unmarked, so a later export resends them)
export function enqueue(L: Live, t: XTurn): void {
  if (L.halt) return; // nothing goes out this run: the turn stays unmarked for the next export
  L.q.push(t); L.qSpans += t.spans.length;
  while (L.qSpans > MAX_SPANS && L.q.length > 1) {
    const d = L.q.shift(); if (!d) break;
    L.qSpans -= d.spans.length;
    if (!L.dropped) { L.dropped = true; L.warn("otlp: the export queue is full (backend unreachable?) — dropping the oldest turns; `agentglass export` sends them later from the transcripts"); }
  }
}
function flush(L: Live, now: number, send: (turns: XTurn[]) => boolean): void {
  if (!L.q.length || now < L.retryAt || L.halt) return;
  L.lastFlush = now;
  L.q = L.q.filter((t: XTurn) => !L.skip(t)); // a retry after a partial failure: what got through is marked now
  if (!L.q.length) { L.qSpans = 0; return; }
  const turns = L.q.slice(0);
  if (send(turns)) {
    L.q = L.q.slice(turns.length); L.qSpans = 0; for (const t of L.q) L.qSpans += t.spans.length;
    let n = 0; for (const t of turns) n += t.spans.length;
    L.sent += n; L.lastOk = now; L.fails = 0; L.retryAt = 0;
  } else { L.fails++; L.retryAt = now + Math.min(BACKOFF_MAX, FLUSH_MS * Math.pow(2, Math.min(10, L.fails - 1))); }
}
// approval waits: the watchdog's note appears → remember the open call; it clears → the call's span gets the estimate.
// Gemini writes a call only once it ran: then the wait is kept until a call covering it shows up (2 min at most).
function attach(sp: XSpan, now: number): void {
  sp.attrs.push(attrD("agentglass.tool.approval_wait", Math.max(0, now - sp.t0) / 1000));
  sp.events.push({ name: "agentglass.approval_wait", t: now, attrs: [attrB("agentglass.estimated", true)] });
}
function approvals(L: Live, s: Sess, b: SessB, now: number): string {
  const op = b.open;
  const late = L.late.get(s.path);
  if (late && op) {
    let hit: XSpan | null = null;
    for (const sp of op.spans) if (sp.op === "execute_tool" && sp.agent === "" && sp.t0 <= late[0] + 1000 && sp.t1 >= late[1] - 5000) hit = sp;
    if (hit) { attach(hit, late[1]); L.late.delete(s.path); }
    else if (now - late[1] > 120000) L.late.delete(s.path);
  }
  const a = s.pid > 0 && op ? L.approval(s) : "";
  const was = L.appr.get(s.path);
  if (a && was === undefined) { const c = openCall(b); L.appr.set(s.path, c ? c.spanId : ""); L.apprAt.set(s.path, now); return a; }
  if (a || was === undefined) return a;
  const since = L.apprAt.get(s.path) ?? now;
  L.appr.delete(s.path); L.apprAt.delete(s.path);
  if (!was) { L.late.set(s.path, [since, now]); return a; }
  if (op) for (const sp of op.spans) if (sp.spanId === was) attach(sp, now);
  return a;
}
// ── the logs stream ──
// over MAX_LOGS: the oldest records go (one warning); state is re-sent once sending works again
export function enqueueLog(L: Live, l: XLog): void {
  if (!L.logs || L.halt) return;
  L.lq.push(l);
  if (L.lq.length > MAX_LOGS) {
    L.lq = L.lq.slice(L.lq.length - MAX_LOGS);
    if (!L.lqDropped) { L.lqDropped = true; L.warn("otlp: the logs queue is full (backend unreachable?) — dropping the oldest records; session state is re-sent once it is reachable"); }
  }
}
// one top-level session after its poll: state on change / every 300 s while live / after a recovery, its open turn once
function logSession(L: Live, s: Sess, b: SessB, appr: string, now: number): void {
  const st = sessState(s, (x: Sess): string => x ? appr : "", (x: Sess): boolean => !!x && L.busyRule(b));
  const prev = L.st.get(s.path); const at = L.stAt.get(s.path) ?? 0;
  const due = prev ? !sameState(prev, st) || (st.live && (now - at >= STATE_REPEAT || L.resendState)) : st.live;
  L.st.set(s.path, st);
  if (due) { enqueueLog(L, stateLog(s, st, now, b.open, L.cfg, b.ver, repoKeyOf(s))); L.stAt.set(s.path, now); }
  const op = b.open; if (!op) return;
  const k = op.path + "\u0000" + op.key;
  if (!L.opened.has(k)) { L.opened.add(k); enqueueLog(L, turnOpenLog(op, now)); }
}
function logTick(L: Live, now: number): void {
  for (const p of L.pend) {
    if (!L.want(p.s)) continue; // judged when it is sent: the session may have left the filter since the rule fired
    const b = L.b.get(p.s.path);
    enqueueLog(L, alertLog(p.s, p.a, now, b ? b.open : null, L.cfg, b ? b.ver : ""));
  }
  L.pend = [];
  if (now - L.lastBeat >= HEARTBEAT_S * 1000) {
    L.lastBeat = now; let live = 0; let busy = 0; let att = 0;
    for (const st of L.st.values()) if (st.live) { live++; if (st.busy) busy++; if (st.attention) att++; }
    enqueueLog(L, heartbeat(now, live, busy, att));
  }
}
// on the spans' cadence (every 5 s or at 512 records), one request; failures back off like the span queue
export function flushLogs(L: Live, now: number): void {
  if (L.halt) { L.lq = []; return; } // a TLS failure stopped the run: nothing more goes out
  if (!L.logs || !L.lq.length || now < L.logRetryAt) return;
  if (L.lq.length < FLUSH_SPANS && now - L.lastLogFlush < FLUSH_MS) return;
  L.lastLogFlush = now;
  const batch = L.lq.slice(0);
  if (L.sendLogs(batch)) {
    L.lq = L.lq.slice(batch.length);
    if (L.logFails > 0) { L.resendState = true; L.lqDropped = false; } // a receiver catches up on the next poll
    L.logFails = 0; L.logRetryAt = 0;
  } else if (!L.logs || L.halt) L.lq = []; // switched off (404/405) or a TLS failure: nothing more goes out
  else { L.logFails++; L.logRetryAt = now + Math.min(BACKOFF_MAX, FLUSH_MS * Math.pow(2, Math.min(10, L.logFails - 1))); }
}
// one poll: read every selected session, queue what closed, flush every 5 s or at 512 queued spans
// The first poll also reads every session that may hold a running turn (a live process, or written within the quiet
// time): its open turn is exported when it closes, even though it started before --since. Any other session untouched
// since --since is not read at all until it changes; its turns had all closed before the start.
export function liveTick(L: Live, now: number, send: (turns: XTurn[]) => boolean): void {
  const first = L.ticks === 0; L.ticks++;
  const resend = L.resendState;
  for (const s of sessions.values()) {
    if (s.parent && s.depth > 0) continue;
    let b = L.b.get(s.path);
    if (!b) { // with the logs stream a session whose agent starts later is read too: its state is "now"
      const maybeRunning = (first && (s.pid > 0 || now - s.mtime < QUIET_LIVE)) || (L.logs && s.pid > 0);
      if (s.mtime < L.since && !maybeRunning) continue;
      if (!L.want(s)) {
        // judged out (not merely unknown yet): its log's newest cwd is followed through the tail (every 2 s; a builder
        // would read its whole history) — the agent may move in; what it did until then is never sent
        if (!L.track(s)) continue;
        const oa = L.outAt.get(s.path); if (oa !== undefined && now - oa < OUT_RECHECK) continue;
        loadTail(s);
        if (!L.want(s)) { L.outAt.set(s.path, now); continue; }
      }
      b = newSessB(s, L.subagents ? s.subs : []); L.b.set(s.path, b);
    } else if (L.subagents) syncSubs(b, s.subs);
    const outAt = L.outAt.get(s.path) ?? -1; L.outAt.delete(s.path); // it just came in: turns begun by its last poll outside stay out
    const appr = approvals(L, s, b, now);
    const ts = advance(b, { now, quietMs: QUIET_LIVE, content: L.content, subagents: L.subagents });
    // the filter is judged again on what this read brought (an agent's log follows it to another cwd): nothing of a
    // session outside it goes out — no turn that was open at any poll it spent outside, and no state; it is still read,
    // so it picks up from here if it comes back
    const ok = L.want(s);
    for (const t of ts) {
      const k = t.path + "\u0000" + t.key; const was = L.running.delete(k); L.opened.delete(k); const away = L.away.delete(k);
      if (!ok || away || t.t0 <= outAt || (t.t0 < L.since && !was) || L.skip(t)) continue;
      enqueue(L, t);
    }
    const op = b.open; if (first && op) L.running.add(op.path + "\u0000" + op.key);
    if (op && op.t0 <= outAt) L.away.add(op.path + "\u0000" + op.key);
    if (!ok) { if (op) L.away.add(op.path + "\u0000" + op.key); L.st.delete(s.path); L.stAt.delete(s.path); continue; } // the heartbeat counts the sessions inside only
    if (L.logs) logSession(L, s, b, appr, now);
  }
  if (resend) L.resendState = false;
  if (L.logs) logTick(L, now);
  if (L.qSpans >= FLUSH_SPANS || now - L.lastFlush >= FLUSH_MS) flush(L, now, send);
  flushLogs(L, now);
}
// SIGINT/SIGTERM: one last flush of spans and logs within the budget
export function liveStop(L: Live, send: (turns: XTurn[]) => boolean, budgetMs: number): void {
  if (budgetMs <= 0) return;
  const t0 = Date.now();
  if (L.q.length) { L.retryAt = 0; flush(L, t0, send); }
  if (L.lq.length && Date.now() - t0 < budgetMs) { L.logRetryAt = 0; L.lastLogFlush = 0; flushLogs(L, Date.now()); }
}
