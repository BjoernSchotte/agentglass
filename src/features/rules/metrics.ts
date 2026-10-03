// agentglass — rule metric catalog (rules-config spec §2): process metrics from the watchdog's observation, session
// metrics from the ledger totals, call metrics from filter-language's per-call rows
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import type { Call } from "../usage/facts.ts";
import { callMatches } from "../query/eval.ts";
import { type Obs, type MVal, absent, approvalWait, commandAge, stalledFor, spinningFor, repeatRun, toolName } from "../detect.ts";
import { type Rule, paramDefault } from "./config.ts";

function prm(r: Rule, k: string): number { const v = r.params.get(k); return v !== undefined ? v : paramDefault(r.metric, k); }
function val(v: number, at: number): MVal { const m = absent(); m.v = v; m.at = at; return m; }

// turnAt: when this run saw the session's last turn finish (0 = none, or busy since)
export function procMetric(r: Rule, o: Obs, turnAt: number): MVal {
  switch (r.metric) {
    case "turn_done": return turnAt > 0 && !o.busy ? val(Math.max(0, (o.now - turnAt) / 1000), turnAt) : absent();
    case "approval_wait": return approvalWait(o, prm(r, "cpu_below"), prm(r, "samples"), prm(r, "grace"));
    case "repeat_run": return repeatRun(o);
    case "command_age": return commandAge(o);
    case "stalled": return stalledFor(o, prm(r, "cpu_below"), prm(r, "samples"));
    case "spinning": return spinningFor(o, prm(r, "cpu_above"), prm(r, "samples"));
  }
  return absent();
}
export function sessMetric(r: Rule, s: Sess): MVal {
  if (r.metric === "session_cost") return s.cost < 0 ? absent() : val(s.cost, s.mtime);
  if (r.metric === "session_tokens") return val(s.inTok + s.outTok + s.cacheRTok + s.cacheWTok, s.mtime);
  return absent();
}
// rows matching the rule's call clauses (all rows without a where); window N = the last N matching rows with a result
export function callMetric(r: Rule, s: Sess, rows: Call[]): MVal {
  const f = r.wf;
  let n = 0; let done = 0; let errs = 0; let at = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const c = rows[i];
    if (f && !callMatches(f, s, c)) continue;
    if (r.window > 0) { if (c.err < 0) continue; if (done >= r.window) break; }
    n++; if (c.err >= 0) done++; if (c.err === 1) errs++;
    if (c.t > at) at = c.t;
  }
  if (r.metric === "tool_calls") return val(n, at || s.mtime);
  if (r.metric === "tool_errors") return val(errs, at || s.mtime);
  if (r.metric === "tool_error_rate") return done < Math.max(1, r.minCalls) ? absent() : val(errs / done, at);
  return absent();
}
// repeat_run with call clauses: the repeated call itself (name + arguments) must match them — exact, never behind the ledger
export function repeatWhere(r: Rule, s: Sess, o: Obs, base: MVal): MVal {
  const f = r.ef;
  if (!f || base.v < 0 || !f.event.length) return base;
  for (let i = o.evs.length - 1; i >= 0; i--) {
    const e = o.evs[i]; if (e.kind !== "tool") continue;
    const t = toolName(e); const k = e.text.indexOf("\u0000"); const args = k >= 0 ? e.text.slice(k + 1) : "";
    for (const p of f.event) if (!p(s, "tool", t, args)) return absent();
    return base;
  }
  return absent();
}
// memo key: one computation per (session, metric, params, window, min_calls, where) per tick
function memoKey(r: Rule): string {
  let p = ""; for (const [k, v] of r.params) p += k + "=" + String(v) + ";";
  return r.metric + "|" + p + "|" + String(r.window) + "|" + String(r.minCalls) + "|" + r.where;
}
export function metricOf(r: Rule, s: Sess, o: Obs, turnAt: number, rows: Call[], memo: Map<string, MVal>): MVal {
  const k = memoKey(r);
  const hit = memo.get(k); if (hit) return hit;
  let v = absent();
  if (r.metric === "session_cost" || r.metric === "session_tokens") v = sessMetric(r, s);
  else if (r.metric === "tool_calls" || r.metric === "tool_errors" || r.metric === "tool_error_rate") v = callMetric(r, s, rows);
  else { v = procMetric(r, o, turnAt); if (r.metric === "repeat_run") v = repeatWhere(r, s, o, v); }
  memo.set(k, v);
  return v;
}
