// agentglass — `agentglass --watch --otlp <url>`: closed turns stream to the backend while agents work (spec 5.2)
// SPDX-License-Identifier: Apache-2.0
// The transcripts are the spool: the queue is bounded, a dropped or unsent turn is not marked, so the next `export`
// sends it from the transcripts. No second copy on disk.
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { approvalOf } from "../watchdog.ts";
import { type SessB, newSessB, advance, syncSubs, openCall } from "./build.ts";
import { type XTurn, type XSpan, attrD, attrB } from "./types.ts";

export const QUIET_LIVE = 120000; // a turn without a close marker counts as finished after 2 quiet minutes
const FLUSH_MS = 5000; const FLUSH_SPANS = 512; const MAX_SPANS = 10000; const BACKOFF_MAX = 300000;
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
}
export function newLive(since: number): Live {
  return { b: new Map<string, SessB>(), q: [], qSpans: 0, lastFlush: 0, dropped: false, fails: 0, retryAt: 0, appr: new Map<string, string>(), apprAt: new Map<string, number>(), late: new Map<string, number[]>(), since, content: false, subagents: true, ticks: 0, running: new Set<string>(),
    want: (s: Sess) => !!s, skip: (t: XTurn) => !t, approval: approvalOf, warn: (m: string) => { process.stderr.write("agentglass: " + m + "\n"); }, sent: 0, lastOk: 0, halt: "" };
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
function approvals(L: Live, s: Sess, b: SessB, now: number): void {
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
  if (a && was === undefined) { const c = openCall(b); L.appr.set(s.path, c ? c.spanId : ""); L.apprAt.set(s.path, now); return; }
  if (a || was === undefined) return;
  const since = L.apprAt.get(s.path) ?? now;
  L.appr.delete(s.path); L.apprAt.delete(s.path);
  if (!was) { L.late.set(s.path, [since, now]); return; }
  if (op) for (const sp of op.spans) if (sp.spanId === was) attach(sp, now);
}
// one poll: read every selected session, queue what closed, flush every 5 s or at 512 queued spans
// The first poll also reads every session that may hold a running turn (a live process, or written within the quiet
// time): its open turn is exported when it closes, even though it started before --since. Any other session untouched
// since --since is not read at all until it changes; its turns had all closed before the start.
export function liveTick(L: Live, now: number, send: (turns: XTurn[]) => boolean): void {
  const first = L.ticks === 0; L.ticks++;
  for (const s of sessions.values()) {
    if (s.parent && s.depth > 0) continue;
    let b = L.b.get(s.path);
    if (!b) {
      const maybeRunning = first && (s.pid > 0 || now - s.mtime < QUIET_LIVE);
      if ((s.mtime < L.since && !maybeRunning) || !L.want(s)) continue;
      b = newSessB(s, L.subagents ? s.subs : []); L.b.set(s.path, b);
    } else if (L.subagents) syncSubs(b, s.subs);
    approvals(L, s, b, now);
    for (const t of advance(b, { now, quietMs: QUIET_LIVE, content: L.content, subagents: L.subagents })) {
      const k = t.path + "\u0000" + t.key; const was = L.running.delete(k);
      if ((t.t0 < L.since && !was) || L.skip(t)) continue;
      enqueue(L, t);
    }
    const op = b.open; if (first && op) L.running.add(op.path + "\u0000" + op.key);
  }
  if (L.qSpans >= FLUSH_SPANS || now - L.lastFlush >= FLUSH_MS) flush(L, now, send);
}
// SIGINT/SIGTERM: one last flush within the budget
export function liveStop(L: Live, send: (turns: XTurn[]) => boolean, budgetMs: number): void {
  if (!L.q.length || budgetMs <= 0) return;
  L.retryAt = 0; flush(L, Date.now(), send);
}
