// agentglass — self-check for rules.json loading: scriptc build src/features/rules/config.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import { type Rule, type Diag, type RuleSet, loadRules, builtins, durSec, parseThr, jsonPos, lineCol, unitOf, METRICS } from "./config.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function rule(rs: RuleSet, id: string): Rule | null { for (const r of rs.rules) if (r.id === id) return r; return null; }
function diags(rs: RuleSet): string { return rs.diags.map((d) => String(d.line) + ":" + String(d.col) + " " + d.rule + " " + (d.err ? "E" : "W") + " " + d.msg).join(" | "); }
function first(rs: RuleSet): string { const d = rs.diags[0]; return d ? String(d.line) + ":" + String(d.col) + " " + d.rule + " " + (d.err ? "E" : "W") : "none"; }
function en(rs: RuleSet, id: string): string { const r = rule(rs, id); return r ? String(r.enabled) : "missing"; }

eq("metrics", String(METRICS.length), "16");
eq("skill units", [unitOf("skill_reloads"), unitOf("skill_carry_usd"), unitOf("skill_context_share")].join(","), "count,usd,ratio");
eq("skill_carry_usd user rule", diags(loadRules('{"rules":[{"id":"fat-skill","metric":"skill_carry_usd","op":">","degraded":0.5}]}', true)), "");
eq("skill_context_share takes a percentage", diags(loadRules('{"rules":[{"id":"share","metric":"skill_context_share","degraded":"20%"}]}', true)), "");
eq("unit", [unitOf("tool_error_rate"), unitOf("session_cost"), unitOf("stalled"), unitOf("tool_calls")].join(","), "ratio,usd,duration,count");
eq("durSec 2m", String(durSec("2m")), "120");
eq("durSec 500ms", String(durSec("500ms")), "0.5");
eq("durSec 2x", String(durSec("2x")), "-1");
eq("durSec 1h", String(durSec("1h")), "3600");
eq("thr 30%", String(parseThr("30%", "ratio")), "0.3");
eq("thr 0.3", String(parseThr(0.3, "ratio")), "0.3");
eq("thr ratio > 1", String(parseThr(2, "ratio")), "-1");
eq("thr dur on usd", String(parseThr("2m", "usd")), "-1");
eq("thr num dur", String(parseThr(20, "duration")), "20");

const none = loadRules("", false);
eq("missing: 8 built-ins", String(none.rules.length), "8");
eq("missing: no diags", String(none.diags.length), "0");
const ids = none.rules.map((r: Rule) => r.id).join(",");
eq("built-in order", ids, "waiting,approval,loop,long-cmd,stalled,spinning,contention,skill-reload");
eq("built-in reasons", none.rules.map((r: Rule) => r.reason).join(","), "waiting,approval,loop,long cmd,stalled,spinning,contention,skill reload");
eq("built-in count", String(builtins().length), "8");
// agent-wait: the contention built-in is off until enabled; contention_family and min_age validate
const ctb = builtins()[6];
eq("contention built-in", ctb ? ctb.metric + " " + ctb.op + " " + String(ctb.deg) + " " + String(ctb.forSec) + " " + String(ctb.enabled) + " " + ctb.ack + " " + String(ctb.notify) + " " + ctb.message : "", "contention >= 3 30 false none true {value} heavy commands running: {cmd}");
eq("contention enabled", en(loadRules('{"rules":[{"id":"contention","enabled":true}]}', true), "contention"), "true");
const cten = rule(loadRules('{"rules":[{"id":"contention","enabled":true}]}', true), "contention");
eq("contention enabled keeps threshold and for", cten ? String(cten.deg) + " " + String(cten.forSec) : "", "3 30");
eq("contention_family valid", diags(loadRules('{"rules":[{"id":"same","metric":"contention_family","degraded":2,"for":"30s","params":{"min_age":"1m"}}]}', true)), "");
eq("min_age -1", String(loadRules('{"rules":[{"id":"x","metric":"contention","degraded":3,"params":{"min_age":-1}}]}', true).diags.filter((d: Diag) => d.err).length), "1");

const ap = loadRules('{"rules":[{"id":"approval","critical":"2m"}]}', true);
const a = rule(ap, "approval");
eq("merge: deg kept", a ? String(a.deg) + " " + String(a.hasDeg) : "", "20 true");
eq("merge: crit added", a ? String(a.crit) + " " + String(a.hasCrit) : "", "120 true");
eq("merge: ack kept", a ? a.ack + " " + a.prefix : "", "look approval? ");
eq("merge: no diags", diags(ap), "");

const only = loadRules('{"builtins":false,"rules":[{"id":"session-cost","metric":"session_cost","degraded":5}]}', true);
eq("builtins false", only.rules.map((r: Rule) => r.id).join(","), "session-cost");
eq("user rule reason/prefix", only.rules.length ? only.rules[0].reason + "|" + only.rules[0].prefix : "", "session-cost|[session-cost] ");
eq("spinning disabled", en(loadRules('{"rules":[{"id":"spinning","enabled":false}]}', true), "spinning"), "false");

// per-rule errors: each disables only its rule, diag at line:col
const errs: string[][] = [
  ['{"rules":[{"metric":"session_cost","degraded":1}]}', "", "1:11  E"],
  ['{"rules":[{"id":"Bad_Id","metric":"session_cost","degraded":1}]}', "", "1:17 Bad_Id E"],
  ['{"rules":[{"id":"x","metric":"nope","degraded":1}]}', "x", "1:30 x E"],
  ['{"rules":[{"id":"x","degraded":1}]}', "x", "1:11 x E"],
  ['{"rules":[{"id":"x","metric":"session_cost","degraded":"2m"}]}', "x", "1:56 x E"],
  ['{"rules":[{"id":"x","metric":"session_cost"}]}', "x", "1:11 x E"],
  ['{"rules":[{"id":"x","metric":"session_cost","degraded":5,"critical":2}]}', "x", "1:69 x E"],
  ['{"rules":[{"id":"x","metric":"stalled","degraded":"1m","params":{"samples":401}}]}', "x", "1:76 x E"],
  ['{"rules":[{"id":"x","metric":"stalled","degraded":"1m","params":{"cpu_below":101}}]}', "x", "1:78 x E"],
  ['{"rules":[{"id":"x","metric":"session_cost","degraded":1,"ack":"never"}]}', "x", "1:64 x E"],
  ['{"rules":[{"id":"x","metric":"session_cost","degraded":1,"where":"tool is Bash"}]}', "x", "1:67 x E"],
  ['{"rules":[{"id":"x","metric":"tool_calls","degraded":1,"where":"day is today"}]}', "x", "1:65 x E"],
  ['{"rules":[{"id":"x","metric":"session_cost","degraded":1,"labels":{"a":"1","b":"1","c":"1","d":"1","e":"1","f":"1","g":"1","h":"1","i":"1","j":"1","k":"1","l":"1","m":"1","n":"1","o":"1","p":"1","q":"1"}}]}', "x", "1:67 x E"],
];
for (const e of errs) {
  const rs = loadRules(e[0] ?? "", true);
  eq("error " + (e[0] ?? ""), first(rs), e[2] ?? "");
  if (e[1]) eq("disabled " + (e[0] ?? ""), en(rs, e[1] ?? ""), "false");
  eq("others run " + (e[0] ?? ""), en(rs, "waiting"), "true");
}
// a broken override of a built-in keeps the built-in as it was (defaults stay active)
const bo = loadRules('{"rules":[{"id":"approval","critical":"2x"}]}', true);
const ba = rule(bo, "approval");
eq("broken override: built-in kept", ba ? String(ba.enabled) + " " + String(ba.deg) + " " + String(ba.hasCrit) : "", "true 20 false");
eq("broken override: says so", String(bo.diags.length === 1 && bo.diags[0].msg.indexOf("the built-in approval stays unchanged") >= 0), "true");
eq("broken new rule: says disabled", String(loadRules('{"rules":[{"id":"x","metric":"nope"}]}', true).diags[0].msg.endsWith("— rule disabled")), "true");
// an invalid threshold is one diagnostic, not two
eq("bad threshold: one diag", String(loadRules('{"rules":[{"id":"x","metric":"session_cost","degraded":"2m"}]}', true).diags.length), "1");
eq("no threshold at all", first(loadRules('{"rules":[{"id":"loop","critical":null}]}', true)), "1:11 loop E");
// fields the metric does not read: warnings
eq("min_calls on tool_calls", diags(loadRules('{"rules":[{"id":"x","metric":"tool_calls","degraded":1,"min_calls":5}]}', true)), "1:56 x W min_calls applies to tool_error_rate only (ignored for tool_calls)");
eq("window on session_cost", first(loadRules('{"rules":[{"id":"x","metric":"session_cost","degraded":1,"window":5}]}', true)), "1:58 x W");
eq("window on tool_error_rate", diags(loadRules('{"rules":[{"id":"x","metric":"tool_error_rate","degraded":"10%","window":5,"min_calls":3}]}', true)), "");
const dup = loadRules('{"rules":[{"id":"x","metric":"session_cost","degraded":1},{"id":"x","metric":"session_cost","degraded":2}]}', true);
eq("duplicate id", first(dup), "1:65 x E");
eq("duplicate keeps first", rule(dup, "x") ? String((rule(dup, "x") as Rule).deg) : "", "1");
// multi-line: where on line 4, the bad token inside the string
const ml = '{\n  "rules": [\n    { "id": "bash-errors", "metric": "tool_error_rate",\n      "where": "tool is Bash and stauts is error", "degraded": "30%" }\n  ]\n}';
const mr = loadRules(ml, true);
eq("where col", first(mr), "4:34 bash-errors E");
eq("where msg", mr.diags.length ? mr.diags[0].msg.slice(0, 22) : "", "where: unknown key \"st");
// escaped quote before the bad token shifts the raw column
const esc = loadRules('{"rules":[{"id":"x","metric":"tool_calls","degraded":1,"where":"title is \\"a\\" and stauts is error"}]}', true);
eq("where col with escapes", first(esc), "1:84 x E");
// call attribute with a session metric: column of the key
const ca = loadRules('{"rules":[{"id":"x","metric":"session_cost","degraded":1,"where":"harness is codex and tool is Bash"}]}', true);
eq("call attr col", first(ca), "1:88 x E");
// unknown field: warning only
const uf = loadRules('{"rules":[{"id":"x","metric":"session_cost","degraded":1,"colour":"red"}]}', true);
eq("unknown field", first(uf), "1:58 x W");
eq("unknown field: enabled", en(uf, "x"), "true");
// syntax error
const sy = loadRules('{"rules":[}', true);
eq("syntax non-empty", String(sy.syntax !== ""), "true");
eq("syntax: built-ins", String(sy.rules.length), "8");
eq("syntax pos", first(sy), "1:11  E");
eq("syntax multi-line", first(loadRules('{\n "rules": [\n  {"id": "x",}\n ]\n}', true)), "3:14  E");
// valid where compiles; call rule
const ok = loadRules('{"rules":[{"id":"bash-errors","metric":"tool_error_rate","where":"tool is Bash","min_calls":20,"degraded":"30%","window":50}]}', true);
const br = rule(ok, "bash-errors");
eq("call rule", br ? String(br.enabled) + " " + String(br.deg) + " " + String(br.minCalls) + " " + String(br.window) + " " + String(br.wf !== null) : "", "true 0.3 20 50 true");
const rp = rule(loadRules('{"rules":[{"id":"bash-repeats","metric":"repeat_run","where":"tool is Bash","degraded":5}]}', true), "bash-repeats");
eq("repeat_run event filter", rp ? String(rp.ef !== null) : "", "true");
eq("repeat_run status rejected", first(loadRules('{"rules":[{"id":"r","metric":"repeat_run","where":"status is error","degraded":5}]}', true)), "1:52 r E");
// notify
const nt = loadRules('{"notify":{"throttle":"1m","command":["/usr/bin/logger","{rule}"],"on":["fire","resolve"],"bell":false}}', true);
eq("notify", String(nt.notify.throttleSec) + " " + nt.notify.command.join(",") + " " + nt.notify.on.join(",") + " " + String(nt.notify.bell), "60 /usr/bin/logger,{rule} fire,resolve false");
eq("notify command string", first(loadRules('{"notify":{"command":"logger x"}}', true)), "1:22  E");
// for + per-harness copies
const ph = loadRules('{"rules":[{"id":"waiting","where":"harness is_not codex"},{"id":"waiting-codex","metric":"turn_done","where":"harness is codex","degraded":"5m","ack":"look","for":"10s"}]}', true);
const wc = rule(ph, "waiting-codex");
eq("copy", wc ? String(wc.deg) + " " + wc.ack + " " + String(wc.forSec) + " " + wc.message : "", "300 look 10 turn finished");
eq("copy diags", diags(ph), "");
// jsonPos with nested arrays/objects and escaped quotes
const jt = '{"a":[1,{"b":"x\\"y","c":[true,null]}],"d":"}"}';
const jp = jsonPos(jt);
eq("pos a.1.b", String(jp.get("a.1.b") ?? -1), "13");
eq("pos a.1.c.1", String(jp.get("a.1.c.1") ?? -1), "30");
eq("pos d", String(jp.get("d") ?? -1), "42");
eq("pos key d", String(jp.get("d:k") ?? -1), "38");
eq("lineCol", lineCol("ab\ncd", 4).join(":"), "2:2");
console.log(bad ? bad + " failed" : "rules config: all checks passed");
if (bad) process.exit(1);
