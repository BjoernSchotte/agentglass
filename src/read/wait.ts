// agentglass — the wait read model (local-web-api §2): `agentglass wait --json` — wall time per command family / kind /
// tool, its share of agent time, heavy commands at once, now — as wait.get serves it. The report runs in slices
// (stepWait) in serve's queue; lazy (serve): a log the background index is far behind on is not read here (pending).
// SPDX-License-Identifier: Apache-2.0
import { complete } from "../hooks.ts";
import { sessions, loadHead } from "../model/sessions.ts";
import type { Obj } from "../util/json.ts";
import { filterOf } from "../features/query/cli.ts";
import { sessMatches } from "../features/query/eval.ts";
import { parseSince } from "../features/queries.ts";
import { type WaitRun, newWaitRun, stepWait, waitResult } from "../features/wait/report.ts";
import { waitJson, liveLook, overlapFor } from "../features/wait/cli.ts";
import { LAZY, farBehind, indexed } from "./row.ts";
import { type Err } from "./sessions.ts";

export const WAIT_BYS = ["family", "kind", "tool"];
export interface WaitQ { since: string; by: string; filter: string; limit: number }
// a report under way: run it with step(ms) until true, then out()
export interface WaitR { run: WaitRun | null; err: Err | null; pending: number; q: WaitQ }
function bad(q: WaitQ, code: string, msg: string, hint: string): WaitR { return { run: null, err: { code, msg, hint }, pending: 0, q }; }
export function waitStart(q: WaitQ, now: number): WaitR {
  if (WAIT_BYS.indexOf(q.by) < 0) return bad(q, "bad_param", "by: " + WAIT_BYS.join("|"), "");
  if (!(q.limit >= 1 && q.limit <= 1000)) return bad(q, "bad_param", "limit must be 1–1000", "");
  const since = parseSince(q.since, now); if (since < 0) return bad(q, "bad_param", "since: today, <n>h, <n>d or YYYY-MM-DD", "");
  const fr = filterOf(q.filter ? [q.filter] : [], "", false, false, false); const cf = fr.cf;
  if (!cf) { const e = fr.err; const col = e ? e.col : 0; return bad(q, "bad_filter", "filter: " + (e ? e.msg : "invalid filter") + " at column " + String(col + 1), fr.src ? fr.src + "\n" + " ".repeat(Math.max(0, col)) + "^" : ""); }
  // every session that can hold a row of either window, indexed to its end (as wait.ts indexFor), but not one the index
  // is far behind on in serve: its booked rows count, the answer says how many such logs there are
  const until = now + 1; const from = since - (until - since) - 3600000; let pending = 0;
  for (const s of sessions.values()) {
    if (s.host || s.mtime < from) continue;
    if (cf.needsHead && !s.headDone) loadHead(s);
    if (!sessMatches(cf.cheap, s)) continue;
    if (LAZY.on && farBehind(s)) { pending++; continue; }
    if (LAZY.on && indexed(s)) continue; // serve: the background index keeps it booked to its end already
    loadHead(s); complete(s);
  }
  return { run: newWaitRun(cf.f, since, until), err: null, pending, q };
}
export function waitStep(w: WaitR, ms: number): boolean { const r = w.run; return !r || stepWait(r, ms); }
// the `wait --json` object (scope: no agent project over the protocol) plus pending
export function waitOut(w: WaitR): Obj {
  const r = w.run; if (!r) return {};
  const rep = waitResult(r);
  const o = waitJson(rep, overlapFor(rep, w.q.by), liveLook(), { filter: w.q.filter || null, project: null, now: "host" }, w.q.by, w.q.limit);
  o["pending"] = w.pending;
  return o;
}
