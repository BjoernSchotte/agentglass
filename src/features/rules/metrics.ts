// agentglass — rule metric catalog (rules-config spec §2): process metrics from the watchdog's observation, session
// metrics from the ledger totals, call metrics from filter-language's per-call rows
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import type { Rows } from "../usage/rows.ts";
import { type SkQ, callMatches, skillRowsFrom, skillOk } from "../query/eval.ts";
import { type Obs, type MVal, absent, approvalWait, commandAge, stalledFor, spinningFor, repeatRun, toolName } from "../detect.ts";
import { type Rule, HOST_METRICS, SKILL_METRICS, paramDefault } from "./config.ts";
import { type Acc, type SkLoad, skOf } from "../usage/record.ts";
import { accsOf } from "../usage/ledger.ts";
import { skillLoads } from "../skills/model.ts";
import { skillVis } from "../skills/vis.ts";
import { LISTING } from "../usage/skillrec.ts";
import { type Run, type LiveWait, liveNow, famCounts } from "../wait/live.ts";

function prm(r: Rule, k: string): number { const v = r.params.get(k); return v !== undefined ? v : paramDefault(r.metric, k); }
function val(v: number, at: number): MVal { const m = absent(); m.v = v; m.at = at; return m; }

// turnAt: when this run saw the session's last turn finish (0 = none, or busy since)
export function procMetric(r: Rule, o: Obs, turnAt: number): MVal {
  switch (r.metric) {
    case "turn_done": {
      if (turnAt <= 0 || o.busy) return absent();
      const m = val(Math.max(0, (o.now - turnAt) / 1000), turnAt); if (o.guess) m.hint = "approval?";
      return m;
    }
    case "approval_wait": return approvalWait(o, prm(r, "cpu_below"), prm(r, "samples"), prm(r, "grace"));
    case "repeat_run": return repeatRun(o);
    case "command_age": return commandAge(o);
    case "stalled": { const m = stalledFor(o, prm(r, "cpu_below"), prm(r, "samples")); if (o.guess && m.v >= 0) m.hint = "approval?"; return m; }
    case "spinning": return spinningFor(o, prm(r, "cpu_above"), prm(r, "samples"));
  }
  return absent();
}
export function sessMetric(r: Rule, s: Sess): MVal {
  if (r.metric === "session_cost") return s.cost < 0 ? absent() : val(s.cost, s.mtime);
  if (r.metric === "session_tokens") return val(s.inTok + s.outTok + s.cacheRTok + s.cacheWTok, s.mtime);
  if (SKILL_METRICS.indexOf(r.metric) >= 0) return skillMetric(r.metric, accsOf(s), r.wf ? r.wf.skill : []);
  return absent();
}
// skill-usage 6.12 over a session's logs (as[0] its own, then its copies): skill_reloads = most copies of one skill in one
// context at once (a load while earlier loads of it are still in), skill_carry_usd = the largest carry $ of one skill,
// skill_context_share = the open loads' sizes / the newest request's context (as[0]). Skills hidden with omit never name
// an alert ({skill} is the shown name: a fake under --redact or a name rule); the listing is no skill here. ps: the
// where's skill.* clauses (6.11/6.12): only the skills they match count ({"metric":"skill_carry_usd","where":"skill is x"}
// is x's carry, not the largest of a session that loaded x); none = every skill
export function skillMetric(metric: string, as: Acc[], ps: ((q: SkQ) => boolean)[] = []): MVal {
  const ok = new Set<string>(); const scoped = ps.length > 0; // scriptc: no Set | null
  if (scoped) for (const q of skillRowsFrom(skillLoads(as, as.map((a: Acc) => "")))) if (skillOk(ps, q)) ok.add(q.name);
  const counts = (n: string): boolean => !scoped || ok.has(n);
  if (metric === "skill_context_share") {
    const a = as[0]; if (!a || a.lastCtx <= 0) return absent();
    let sz = 0; let at = 0; let top = ""; let tv = -1; // scoped: the matching skills' share (no listing)
    for (const l of skOf(a)) { if (l.end !== 0 || l.pend || l.S <= 0 || (scoped && (l.name === LISTING || !counts(l.name)))) continue; sz += l.S; if (l.t > at) at = l.t; if (l.name !== LISTING && l.S > tv && skillVis(l.name).mode !== "omit") { tv = l.S; top = skillVis(l.name).shown; } }
    if (sz <= 0) return absent();
    const m = val(Math.min(1, sz / a.lastCtx), at); m.skill = top; return m;
  }
  let best = -1; let name = ""; let at = 0;
  if (metric === "skill_reloads") {
    for (const a of as) for (let i = 0; i < skOf(a).length; i++) {
      const l = a.sk[i] as SkLoad; if (l.name === LISTING || l.n > 1 || skillVis(l.name).mode === "omit" || !counts(l.name)) continue;
      let n = 1; for (let j = 0; j < i; j++) { const x = a.sk[j] as SkLoad; if (x.name === l.name && x.n === 1 && x.t <= l.t && (x.end === 0 || x.end > l.t)) n++; }
      if (n > best || (n === best && l.t > at)) { best = n; name = l.name; at = l.t; }
    }
  } else {
    const per = new Map<string, number>(); const last = new Map<string, number>();
    for (const r of skillLoads(as, as.map((a: Acc) => ""))) { if (r.name === LISTING) continue; per.set(r.name, (per.get(r.name) ?? 0) + r.carryUsd); if (r.t > (last.get(r.name) ?? 0)) last.set(r.name, r.t); }
    for (const [k, v] of per) { if (skillVis(k).mode === "omit" || !counts(k)) continue; if (v > best) { best = v; name = k; at = last.get(k) ?? 0; } }
  }
  if (best < 0) return absent();
  const m = val(best, at); m.skill = skillVis(name).shown; return m;
}
// rows matching the rule's call clauses (all rows without a where); window N = the last N matching rows with a result
export function callMetric(r: Rule, s: Sess, rows: Rows): MVal {
  const f = r.wf;
  let n = 0; let done = 0; let errs = 0; let at = 0;
  for (let i = rows.n - 1; i >= 0; i--) {
    if (f && !callMatches(f, s, rows, i)) continue;
    const e = rows.err[i] + 0; const t = rows.t[i] + 0;
    if (r.window > 0) { if (e < 0) continue; if (done >= r.window) break; }
    n++; if (e >= 0) done++; if (e === 1) errs++;
    if (t > at) at = t;
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
// agent-wait: heavy commands running on this host (≥ min_age s); present only for a session that runs one itself;
// contention_family counts those of its oldest heavy command's family
export function hostMetric(r: Rule, s: Sess, lw: LiveWait): MVal {
  const minAge = prm(r, "min_age"); const all: Run[] = []; let mine: Run | null = null;
  for (const x of lw.running) {
    if (!x.heavy || x.ageSec < minAge) continue;
    all.push(x); if (x.path === s.path && (!mine || x.ageSec > mine.ageSec)) mine = x;
  }
  if (!mine) return absent();
  const fam = mine.family; const n: Run[] = r.metric === "contention_family" ? all.filter((x: Run) => x.family === fam) : all;
  const m = val(n.length, lw.at - mine.ageSec * 1000); m.cmd = famCounts(n);
  return m;
}
// memo key: one computation per (session, metric, params, window, min_calls, where) per tick
function memoKey(r: Rule): string {
  let p = ""; for (const [k, v] of r.params) p += k + "=" + String(v) + ";";
  return r.metric + "|" + p + "|" + String(r.window) + "|" + String(r.minCalls) + "|" + r.where;
}
export function metricOf(r: Rule, s: Sess, o: Obs, turnAt: number, rows: Rows, memo: Map<string, MVal>): MVal {
  const k = memoKey(r);
  const hit = memo.get(k); if (hit) return hit;
  let v = absent();
  if (r.metric === "session_cost" || r.metric === "session_tokens" || SKILL_METRICS.indexOf(r.metric) >= 0) v = sessMetric(r, s);
  else if (r.metric === "tool_calls" || r.metric === "tool_errors" || r.metric === "tool_error_rate") v = callMetric(r, s, rows);
  else if (HOST_METRICS.indexOf(r.metric) >= 0) v = hostMetric(r, s, liveNow(o.now));
  else { v = procMetric(r, o, turnAt); if (r.metric === "repeat_run") v = repeatWhere(r, s, o, v); }
  memo.set(k, v);
  return v;
}
