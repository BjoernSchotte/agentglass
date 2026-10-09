// agentglass — self-check for rule metrics: scriptc build src/features/rules/metrics.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { newSess } from "../../model/types.ts";
import { type Call, DICT, intern } from "../usage/facts.ts";
import { rowsFrom, newRows } from "../usage/rows.ts";
import { type Obs, type MVal, approvalWait, commandAge, stalledFor, spinningFor, repeatRun } from "../detect.ts";
import { type Rule, loadRules } from "./config.ts";
import { metricOf, procMetric, sessMetric, skillMetric } from "./metrics.ts";
import { render } from "./engine.ts";
import { type Acc, newAcc, bucket, tokens, turn, skillLoad, skillUnload } from "../usage/record.ts";
import { setVis } from "../skills/vis.ts";
import { type Run, LIVE } from "../wait/live.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ev(kind: string, text: string): Ev { return { kind, text, ts: "", id: "", full: "" }; }
function flat(n: number, v: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(v); return a; }
function rule(json: string): Rule { const rs = loadRules("{\"builtins\":false,\"rules\":[" + json + "]}", true); if (rs.diags.length) console.log("diag " + rs.diags[0].msg); return rs.rules[0]; }
function v(m: MVal): string { return m.v < 0 ? "absent" : String(Math.round(m.v * 1000) / 1000); }
const now = 1000000000;
const call = ev("tool", "Bash\u0000ls");
function obs(mtimeAgo: number, busy: boolean, evs: Ev[], cpu: number[]): Obs { return { now, mtime: now - mtimeAgo * 1000, busy, evs, cpu, cmds: [], subsActive: false }; }

// process metrics: values, absence, boundaries
const p20 = obs(20, true, [ev("user", "x"), call], flat(7, 0.5));
eq("approval 20s value", v(approvalWait(p20, 2, 7, 5)), "20");
eq("approval 6 samples absent", v(approvalWait(obs(30, true, [call], flat(6, 0.5)), 2, 7, 5)), "absent");
eq("approval 7 samples", v(approvalWait(obs(30, true, [call], flat(7, 0.5)), 2, 7, 5)), "30");
eq("approval idle absent", v(approvalWait(obs(30, false, [call], flat(7, 0.5)), 2, 7, 5)), "absent");
eq("approval cpu absent", v(approvalWait(obs(30, true, [call], flat(7, 3)), 2, 7, 5)), "absent");
eq("approval cpu string", approvalWait(obs(30, true, [call], flat(7, 0.5)), 2, 7, 5).cpu, "1");
const sub: Obs = { now, mtime: now - 30000, busy: true, evs: [call], cpu: flat(7, 0), cmds: [], subsActive: true };
eq("approval subagent absent", v(approvalWait(sub, 2, 7, 5)), "absent");
const fresh: Obs = { now, mtime: now - 30000, busy: true, evs: [call], cpu: flat(7, 0), cmds: [{ age: 34, name: "sleep" }], subsActive: false };
eq("approval fresh cmd absent", v(approvalWait(fresh, 2, 7, 5)), "absent");
eq("approval old cmd present", v(approvalWait({ now, mtime: now - 30000, busy: true, evs: [call], cpu: flat(7, 0), cmds: [{ age: 36, name: "sleep" }], subsActive: false }, 2, 7, 5)), "30");
const asks: Obs = { now, mtime: now - 3000, busy: false, evs: [ev("assistant", "I will")], cpu: [], cmds: [], subsActive: false, asks: true };
eq("approval title asserts level 1", String(approvalWait(asks, 2, 7, 5).lv) + " " + v(approvalWait(asks, 2, 7, 5)), "1 3");
eq("command age", v(commandAge({ now, mtime: now, busy: true, evs: [call], cpu: [], cmds: [{ age: 700, name: "sleep" }, { age: 5, name: "x" }], subsActive: false })), "700");
eq("command age cmd", commandAge({ now, mtime: now, busy: true, evs: [call], cpu: [], cmds: [{ age: 700, name: "sleep" }], subsActive: false }).cmd, "sleep");
eq("command age no pending", v(commandAge({ now, mtime: now, busy: true, evs: [call, ev("result", "ok")], cpu: [], cmds: [{ age: 700, name: "sleep" }], subsActive: false })), "absent");
eq("stalled 480", v(stalledFor(obs(480, true, [ev("assistant", "hm")], flat(7, 0.5)), 1, 7)), "480");
eq("stalled cpu string", stalledFor(obs(480, true, [ev("assistant", "hm")], flat(7, 0.5)), 1, 7).cpu, "0.5");
eq("stalled 6 samples", v(stalledFor(obs(480, true, [], flat(6, 0.5)), 1, 7)), "absent");
eq("stalled idle", v(stalledFor(obs(480, false, [], flat(7, 0.5)), 1, 7)), "absent");
{ const o = obs(720, true, [ev("assistant", "hm")], flat(7, 0.5)); o.asks = true; // Gemini in tmux, its title says "Action Required"
  eq("stalled: not while the agent's title says it waits for approval", v(stalledFor(o, 1, 7)), "absent"); }
eq("spinning 119", v(spinningFor(obs(200, false, [], flat(119, 95)), 80, 120)), "absent");
eq("spinning 120", v(spinningFor(obs(200, false, [], flat(120, 95)), 80, 120)), "200");
eq("repeat", v(repeatRun(obs(0, true, [call, call, call], []))) + " " + repeatRun(obs(0, true, [call, call], [])).tool, "3 Bash");
const wt = rule('{"id":"w","metric":"turn_done","degraded":0}');
eq("turn_done idle", v(procMetric(wt, obs(0, false, [], []), now - 5000)), "5");
eq("turn_done busy", v(procMetric(wt, obs(0, true, [], []), now - 5000)), "absent");
eq("turn_done no transition", v(procMetric(wt, obs(0, false, [], []), 0)), "absent");
// the guessed approval (Gemini outside tmux) rides on the finished turn as a hint, marked with "?"
const gObs = obs(0, false, [], []); gObs.guess = true;
eq("turn_done hint", procMetric(wt, gObs, now - 5000).hint + " " + v(procMetric(wt, gObs, now - 5000)), "approval? 5");
eq("turn_done no hint", procMetric(wt, obs(0, false, [], []), now - 5000).hint, "");
const st = rule('{"id":"s","metric":"stalled","critical":"8m"}');
const gs = obs(500, true, [ev("thinking", "plan")], flat(7, 0.2)); gs.guess = true;
eq("stalled hint", procMetric(st, gs, 0).hint + " " + v(procMetric(st, gs, 0)), "approval? 500");
eq("stalled no hint", procMetric(st, obs(500, true, [ev("thinking", "plan")], flat(7, 0.2)), 0).hint, "");
eq("params override", v(procMetric(rule('{"id":"s","metric":"stalled","critical":"1m","params":{"cpu_below":5}}'), obs(100, true, [], flat(7, 3)), 0)), "100");

// session metrics
const s = newSess("claude", "m1", "/fx/m1.jsonl", false);
s.mtime = now; s.cost = -1; s.inTok = 10; s.outTok = 5; s.cacheRTok = 100; s.cacheWTok = 1;
eq("cost unknown", v(sessMetric(rule('{"id":"c","metric":"session_cost","degraded":1}'), s)), "absent");
s.cost = 2.5;
eq("cost", v(sessMetric(rule('{"id":"c","metric":"session_cost","degraded":1}'), s)), "2.5");
eq("tokens", v(sessMetric(rule('{"id":"t","metric":"session_tokens","degraded":1}'), s)), "116");

// call metrics: 30 Bash (10 errors: every third), 5 Edit ok, 2 Bash unfinished, npm programs on the last 5 Bash
const calls: Call[] = [];
function row(t: number, tool: string, err: number, progs: string[]): Call {
  const ps: number[] = []; for (const p of progs) ps.push(intern(DICT.prog, p));
  return { t, tool: intern(DICT.tool, tool), model: -1, mq: 0, progs: ps, cmds: [], files: [], ms: err < 0 ? -1 : 100, err, out: 0, cid: "" };
}
for (let i = 0; i < 30; i++) calls.push(row(now - (40 - i) * 1000, "Bash", i % 3 === 0 ? 1 : 0, i >= 25 ? ["npm"] : ["ls"]));
for (let i = 0; i < 5; i++) calls.push(row(now - 5000 + i, "Edit", 0, []));
calls.push(row(now, "Bash", -1, [])); calls.push(row(now, "Bash", -1, []));
const rows = rowsFrom(calls);
const o0 = obs(0, true, [], []);
const m = (j: string): string => v(metricOf(rule(j), s, o0, 0, rows, new Map<string, MVal>()));
eq("rate bash", m('{"id":"r","metric":"tool_error_rate","where":"tool is Bash","degraded":"30%"}'), "0.333");
eq("rate min_calls", m('{"id":"r","metric":"tool_error_rate","where":"tool is Bash","min_calls":40,"degraded":"30%"}'), "absent");
eq("rate window 10", m('{"id":"r","metric":"tool_error_rate","where":"tool is Bash","window":10,"degraded":"30%"}'), "0.3");
// the last 10 Bash with a result are i 20..29: errors at 21, 24, 27 → 3/10; window 5 (25..29): 27 → 1/5
eq("rate window 5", m('{"id":"r","metric":"tool_error_rate","where":"tool is Bash","window":5,"degraded":"30%"}'), "0.2");
eq("calls bash (incl. unfinished)", m('{"id":"c","metric":"tool_calls","where":"tool is Bash","degraded":1}'), "32");
eq("errors all", m('{"id":"e","metric":"tool_errors","degraded":1}'), "10");
eq("calls program npm", m('{"id":"p","metric":"tool_calls","where":"program is npm","degraded":1}'), "5");
eq("rate whole session", m('{"id":"r","metric":"tool_error_rate","degraded":"30%"}'), "0.286");
// repeat_run with a where: the repeated call itself
const loopEdit = obs(0, true, [ev("tool", "Edit\u0000a.ts"), ev("tool", "Edit\u0000a.ts"), ev("tool", "Edit\u0000a.ts")], []);
const loopBash = obs(0, true, [call, call, call], []);
const rr = '{"id":"b","metric":"repeat_run","where":"tool is Bash","degraded":5}';
eq("repeat where: Edit loop", v(metricOf(rule(rr), s, loopEdit, 0, newRows(), new Map<string, MVal>())), "absent");
eq("repeat where: Bash loop", v(metricOf(rule(rr), s, loopBash, 0, newRows(), new Map<string, MVal>())), "3");
// memo: one computation per key per tick
const memo = new Map<string, MVal>();
const r1 = rule('{"id":"a","metric":"session_cost","degraded":1}'); const r2 = rule('{"id":"b","metric":"session_cost","critical":9}');
const a1 = metricOf(r1, s, o0, 0, rows, memo); s.cost = 7; const a2 = metricOf(r2, s, o0, 0, rows, memo);
eq("memo same value", v(a2), "2.5");
eq("memo one entry", String(memo.size) + " " + v(a1), "1 2.5");
// agent-wait: host-wide contention metrics from the live look (present only for a session running a heavy command)
{
  const run = (path: string, family: string, kind: string, heavy: boolean, age: number): Run => ({ path, h: "claude", family, kind, heavy, ageSec: age, rssKb: 1, pid: 1, bg: false });
  LIVE.cur = { at: now, load1: -1, cpus: 8, memAvailPct: -1, running: [run("/A", "pnpm test", "test", true, 30), run("/B", "pnpm test", "test", true, 90), run("/C", "tsc", "typecheck", true, 120), run("/D", "git status", "vcs", false, 500)] };
  const ss = ["A", "B", "C", "D", "E"].map((x: string) => newSess("claude", x, "/" + x, false));
  const o = obs(1, true, [], []);
  const rc = rule('{"id":"c","metric":"contention","degraded":3}');
  const rf = rule('{"id":"f","metric":"contention_family","degraded":2}');
  const rm = rule('{"id":"m","metric":"contention","degraded":3,"params":{"min_age":60}}');
  const val = (r: Rule, i: number): MVal => metricOf(r, ss[i] ?? ss[0], o, 0, newRows(), new Map<string, MVal>());
  eq("contention per session", [0, 1, 2, 3, 4].map((i: number) => v(val(rc, i))).join(","), "3,3,3,absent,absent");
  eq("contention_family", v(val(rf, 0)) + "," + v(val(rf, 2)), "2,1");
  eq("min_age 60", [0, 1, 2].map((i: number) => v(val(rm, i))).join(","), "absent,2,2");
  eq("{cmd}", val(rc, 0).cmd, "pnpm test ×2, tsc");
  eq("{cmd} family", val(rf, 0).cmd, "pnpm test ×2");
  LIVE.cur = { at: now - 60000, load1: -1, cpus: 8, memAvailPct: -1, running: LIVE.cur.running };
  eq("stale look: absent", v(val(rc, 0)), "absent");
}
// skill-usage 6.12: reloads while a copy is in context, carry $ per skill, the open skills' share of the context
{
  setVis([], false);
  const T = "LOREMSKILLTEXT" + "x".repeat(3586); const iso = "2026-10-01T09:00:00.000Z"; const M = "claude-sonnet-4-5";
  const mk = (compactFirst: boolean): Acc => {
    const a = newAcc(); const d = bucket(a, 0, iso);
    turn(a, 0, iso, 1); tokens(a, d, M, 0, 10, 0, 20000, 0);
    skillLoad(a, "alpha", "user", 1000, iso, T, true, "/h/.claude/skills/alpha", false);
    tokens(a, d, M, 0, 10, 20000, 1500, 0);
    if (compactFirst) skillUnload(a, 1500, "compact");
    skillLoad(a, "alpha", "model", 2000, iso, T, true, "/h/.claude/skills/alpha", false);
    skillLoad(a, "beta", "model", 2100, iso, T, true, "/h/.claude/skills/beta", false);
    tokens(a, d, M, 0, 10, 21500, 3000, 0);
    turn(a, 0, iso, 1);
    for (let i = 0; i < 3; i++) tokens(a, d, M, 0, 10, 24500, 100, 0);
    return a;
  };
  const twice = mk(false); const after = mk(true);
  const rv = (m: MVal): string => v(m) + (m.skill ? " " + m.skill : "");
  eq("skill_reloads: loaded twice while in context", rv(skillMetric("skill_reloads", [twice])), "2 alpha");
  eq("skill_reloads: the first was compacted before", rv(skillMetric("skill_reloads", [after])), "1 beta");
  eq("skill_reloads: no loads", v(skillMetric("skill_reloads", [newAcc()])), "absent");
  const cu = skillMetric("skill_carry_usd", [twice]);
  eq("skill_carry_usd: the most carried skill", cu.skill + " " + String(cu.v > 0), "alpha true");
  const sh = skillMetric("skill_context_share", [twice]); const shv = sh.v;
  eq("skill_context_share in (0, 1]", String(shv > 0 && shv <= 1) + " " + String(Math.round(shv * 1000) / 1000 === Math.round(Math.min(1, 3000 / 24600) * 1000) / 1000), "true true");
  setVis([{ match: "alpha", mode: "omit" }], false);
  eq("omit: alpha never names an alert", rv(skillMetric("skill_reloads", [twice])), "1 beta");
  setVis([{ match: "alpha", mode: "name" }], false);
  const fk = skillMetric("skill_reloads", [twice]).skill;
  eq("name rule: the fake, same length", String(fk !== "alpha" && fk.length === 5), "true");
  setVis([], false);
  // the built-in: off; enabled it fires degraded with its message
  const def = loadRules("{}", true).rules.filter((r: Rule) => r.id === "skill-reload")[0];
  eq("skill-reload built-in", def ? def.metric + " " + def.op + " " + String(def.deg) + " " + String(def.enabled) : "", "skill_reloads >= 2 false");
  const en = loadRules('{"rules":[{"id":"skill-reload","enabled":true}]}', true).rules.filter((r: Rule) => r.id === "skill-reload")[0];
  const s0 = newSess("claude", "s", "/x/s.jsonl", false); s0.cwd = "/x";
  const mv = skillMetric("skill_reloads", [twice]);
  eq("enabled: degraded message", en ? String(en.enabled) + " " + String(mv.v >= en.deg) + " " + render(en, mv, 1, s0) : "", "true true alpha loaded 2× in one context");
  // where on skill.* keys (6.12): the metric counts only the matching skills; the session's other skills do not
  const wr = (w: string): Rule => { const r0 = loadRules('{"rules":[{"id":"w","metric":"skill_carry_usd","op":">","degraded":0,"where":' + JSON.stringify(w) + '}]}', true); eq("where compiles: " + w, r0.diags.map((d) => d.msg).join("|"), ""); return r0.rules.filter((r: Rule) => r.id === "w")[0] as Rule; };
  const wb = wr("skill is beta"); const vb = skillMetric("skill_carry_usd", [twice], wb.wf ? wb.wf.skill : []);
  eq("where skill is beta: beta's carry, not alpha's", vb.skill + " " + String(vb.v >= 0 && vb.v < cu.v), "beta true");
  const wn = wr("skill is nope"); eq("where skill is nope: absent", v(skillMetric("skill_carry_usd", [twice], wn.wf ? wn.wf.skill : [])), "absent");
  const wt = wr("skill.trigger is model and skill.loads >= 2"); eq("where skill.trigger and skill.loads", skillMetric("skill_reloads", [twice], wt.wf ? wt.wf.skill : []).skill, "alpha");
  const ws = wr("skill is beta"); const sb = skillMetric("skill_context_share", [twice], ws.wf ? ws.wf.skill : []);
  eq("where on skill_context_share: beta's size only", String(Math.round(sb.v * 1e4)), String(Math.round(Math.min(1, 1000 / 24600) * 1e4)));
  eq("unknown session: absent", v(sessMetric(rule('{"id":"r","metric":"skill_reloads","degraded":2}'), s0)), "absent");
}
console.log(bad ? bad + " failed" : "rules metrics: all checks passed");
if (bad) process.exit(1);
