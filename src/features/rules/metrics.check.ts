// agentglass — self-check for rule metrics: scriptc build src/features/rules/metrics.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { newSess } from "../../model/types.ts";
import { type Call, DICT, intern } from "../usage/facts.ts";
import { type Obs, type MVal, approvalWait, commandAge, stalledFor, spinningFor, repeatRun } from "../detect.ts";
import { type Rule, loadRules } from "./config.ts";
import { metricOf, procMetric, sessMetric } from "./metrics.ts";

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
eq("spinning 119", v(spinningFor(obs(200, false, [], flat(119, 95)), 80, 120)), "absent");
eq("spinning 120", v(spinningFor(obs(200, false, [], flat(120, 95)), 80, 120)), "200");
eq("repeat", v(repeatRun(obs(0, true, [call, call, call], []))) + " " + repeatRun(obs(0, true, [call, call], [])).tool, "3 Bash");
const wt = rule('{"id":"w","metric":"turn_done","degraded":0}');
eq("turn_done idle", v(procMetric(wt, obs(0, false, [], []), now - 5000)), "5");
eq("turn_done busy", v(procMetric(wt, obs(0, true, [], []), now - 5000)), "absent");
eq("turn_done no transition", v(procMetric(wt, obs(0, false, [], []), 0)), "absent");
eq("params override", v(procMetric(rule('{"id":"s","metric":"stalled","critical":"1m","params":{"cpu_below":5}}'), obs(100, true, [], flat(7, 3)), 0)), "100");

// session metrics
const s = newSess("claude", "m1", "/fx/m1.jsonl", false);
s.mtime = now; s.cost = -1; s.inTok = 10; s.outTok = 5; s.cacheRTok = 100; s.cacheWTok = 1;
eq("cost unknown", v(sessMetric(rule('{"id":"c","metric":"session_cost","degraded":1}'), s)), "absent");
s.cost = 2.5;
eq("cost", v(sessMetric(rule('{"id":"c","metric":"session_cost","degraded":1}'), s)), "2.5");
eq("tokens", v(sessMetric(rule('{"id":"t","metric":"session_tokens","degraded":1}'), s)), "116");

// call metrics: 30 Bash (10 errors: every third), 5 Edit ok, 2 Bash unfinished, npm programs on the last 5 Bash
const rows: Call[] = [];
function row(t: number, tool: string, err: number, progs: string[]): Call {
  const ps: number[] = []; for (const p of progs) ps.push(intern(DICT.prog, p));
  return { t, tool: intern(DICT.tool, tool), model: -1, mq: 0, progs: ps, cmds: [], files: [], ms: err < 0 ? -1 : 100, err, out: 0, cid: "" };
}
for (let i = 0; i < 30; i++) rows.push(row(now - (40 - i) * 1000, "Bash", i % 3 === 0 ? 1 : 0, i >= 25 ? ["npm"] : ["ls"]));
for (let i = 0; i < 5; i++) rows.push(row(now - 5000 + i, "Edit", 0, []));
rows.push(row(now, "Bash", -1, [])); rows.push(row(now, "Bash", -1, []));
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
eq("repeat where: Edit loop", v(metricOf(rule(rr), s, loopEdit, 0, [], new Map<string, MVal>())), "absent");
eq("repeat where: Bash loop", v(metricOf(rule(rr), s, loopBash, 0, [], new Map<string, MVal>())), "3");
// memo: one computation per key per tick
const memo = new Map<string, MVal>();
const r1 = rule('{"id":"a","metric":"session_cost","degraded":1}'); const r2 = rule('{"id":"b","metric":"session_cost","critical":9}');
const a1 = metricOf(r1, s, o0, 0, rows, memo); s.cost = 7; const a2 = metricOf(r2, s, o0, 0, rows, memo);
eq("memo same value", v(a2), "2.5");
eq("memo one entry", String(memo.size) + " " + v(a1), "1 2.5");
console.log(bad ? bad + " failed" : "rules metrics: all checks passed");
if (bad) process.exit(1);
