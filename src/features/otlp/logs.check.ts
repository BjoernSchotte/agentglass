// agentglass — self-check for the OTLP logs stream encoding: scriptc build src/features/otlp/logs.check.ts -o lgc && ./lgc
// The suite runs it with AGENTGLASS_REDACT=1; expectations branch on REDACT (run it once without as well).
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import { type Obj, obj, str, arr, parse as parseJson } from "../../util/json.ts";
import { HOME } from "../../util/fs.ts";
import { newSess } from "../../model/types.ts";
import { applyMeta } from "../../hooks.ts";
import { titleOf } from "../../model/sessions.ts";
import { BUILD } from "../../build-info.ts";
import "../redact.ts";
import { REDACT } from "../redact-on.ts";
import { HOSTID } from "../../util/hostid.ts";
import { type XTurn, newSpan } from "./types.ts";
import { cfgFrom } from "./config.ts";
import { heartbeat, stateLog, turnOpenLog, alertLog, encodeLogs, sevText } from "./logs.ts";

mkdirSync(HOME + "/.agentglass", { recursive: true }); writeFileSync(HOME + "/.agentglass/hid", "00112233445566ff\n"); HOSTID.idFile = HOME + "/.agentglass/hid";
let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ":\n  got  " + got + "\n  want " + want); } }
const NOW = 1790000000000;
const C = cfgFrom({});
function recs(js: string): Obj[] { const out: Obj[] = []; const o = parseJson(js) ?? {}; for (const r of arr(o["resourceLogs"])) for (const sl of arr((obj(r) ?? {})["scopeLogs"])) for (const l of arr((obj(sl) ?? {})["logRecords"])) { const lo = obj(l); if (lo) out.push(lo); } return out; }
function attrs(s: Obj): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of arr(s["attributes"])) { const ao = obj(a); if (!ao) continue; const v = obj(ao["value"]) ?? {}; const k = Object.keys(v)[0] ?? ""; m.set(str(ao["key"]), k + ":" + JSON.stringify(v[k])); }
  return m;
}
const os = process.platform === "darwin" ? "darwin" : "linux";
const kv = (k: string, v: string): string => "{\"key\":\"" + k + "\",\"value\":" + v + "}";

// heartbeat: the whole request, golden
eq("heartbeat golden", encodeLogs([heartbeat(NOW, 2, 1, 0)], C),
  "{\"resourceLogs\":[{\"resource\":{\"attributes\":[" + kv("service.name", "{\"stringValue\":\"agentglass\"}") + "," + kv("service.version", "{\"stringValue\":" + JSON.stringify(BUILD.version) + "}") + "," +
  kv("os.type", "{\"stringValue\":\"" + os + "\"}") + "," + kv("host.id", "{\"stringValue\":\"00112233445566ff\"}") + (REDACT ? "," + kv("agentglass.redact", "{\"boolValue\":true}") : "") + "]}," +
  "\"scopeLogs\":[{\"scope\":{\"name\":\"agentglass\",\"version\":" + JSON.stringify(BUILD.version) + "},\"logRecords\":[{\"timeUnixNano\":\"1790000000000000000\",\"observedTimeUnixNano\":\"1790000000000000000\"," +
  "\"severityNumber\":9,\"severityText\":\"INFO\",\"eventName\":\"agentglass.heartbeat\",\"body\":{\"stringValue\":\"agentglass.heartbeat\"},\"attributes\":[" +
  kv("event.name", "{\"stringValue\":\"agentglass.heartbeat\"}") + "," + kv("agentglass.heartbeat.interval", "{\"intValue\":\"30\"}") + "," + kv("agentglass.sessions.live", "{\"intValue\":\"2\"}") + "," +
  kv("agentglass.sessions.busy", "{\"intValue\":\"1\"}") + "," + kv("agentglass.sessions.attention", "{\"intValue\":\"0\"}") + "]}]}]}]}");
eq("severity texts", [sevText(9), sevText(13), sevText(17)].join(" "), "INFO WARN ERROR");

// a session and its open turn
const s = newSess("claude", "s1", "/x/s1.jsonl", false); s.cwd = "/w/app"; s.title = "fix login bug zzsecretzz"; s.pid = 7; applyMeta(s);
const t: XTurn = { h: "claude", rootId: "s1", path: "/x/s1.jsonl", key: "k#0", index: 3, traceId: "0123456789abcdef0123456789abcdef", t0: NOW - 5000, t1: NOW, closed: false, closedBy: "", compacted: false, ver: "2.1.90", cwd: "/w/app", branch: "", remote: "", spans: [], fx: [], fxOn: false, title: "", repoKey: "" };
t.spans.push(newSpan("invoke_agent", "invoke_agent Claude Code", "aaaaaaaaaaaaaaaa", "", NOW - 5000, "s1"));
const ch = newSpan("chat", "chat claude-sonnet-4-5", "bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa", NOW - 4000, "s1"); ch.model = "claude-sonnet-4-5"; t.spans.push(ch);

const st0 = { live: true, busy: true, attention: false, approval: false, stuck: "" };
const sr = recs(encodeLogs([stateLog(s, st0, NOW, t, C, "2.1.90", "git:github.com/acme/app")], C))[0] ?? {};
const sa = attrs(sr);
eq("state: name in field and attribute", str(sr["eventName"]) + " " + (sa.get("event.name") ?? ""), "agentglass.session.state stringValue:\"agentglass.session.state\"");
eq("state: flags", ["live", "busy", "attention", "approval", "stuck"].map((k: string) => sa.get("agentglass.session." + k) ?? "-").join(" "), "boolValue:true boolValue:true boolValue:false boolValue:false stringValue:\"\"");
eq("state: INFO while fine", String(sr["severityNumber"]), "9");
eq("state: the open turn's ids", str(sr["traceId"]) + " " + str(sr["spanId"]), "0123456789abcdef0123456789abcdef aaaaaaaaaaaaaaaa");
eq("state: session attributes", [sa.get("gen_ai.conversation.id"), sa.get("gen_ai.agent.name"), String(sa.has("process.working_directory"))].join(" "), "stringValue:\"s1\" stringValue:\"Claude Code\" true");
eq("state: repo key", REDACT ? String(/^stringValue:"[0-9a-f]{16}"$/.test(sa.get("agentglass.repo.key") ?? "")) : sa.get("agentglass.repo.key") ?? "", REDACT ? "true" : "stringValue:\"git:github.com/acme/app\"");
eq("state: title only with otlp.titles (or the fake under --redact)", String(sa.has("agentglass.session.title")), REDACT ? "true" : "false");
const sat = attrs(recs(encodeLogs([stateLog(s, st0, NOW, t, cfgFrom({ titles: true }), "2.1.90", "")], C))[0] ?? {});
eq("state: title with otlp.titles", String(sat.has("agentglass.session.title")), "true");
eq("state: the real title never under --redact", String(encodeLogs([stateLog(s, st0, NOW, t, cfgFrom({ titles: true }), "2.1.90", "")], C).indexOf("zzsecretzz") >= 0), REDACT ? "false" : "true");
for (const k of ["attention", "approval", "stuck"]) {
  const st = { live: true, busy: false, attention: k === "attention", approval: k === "approval", stuck: k === "stuck" ? "loop" : "" };
  eq("state: WARN with " + k, String((recs(encodeLogs([stateLog(s, st, NOW, null, C, "", "")], C))[0] ?? {})["severityNumber"]), "13");
}
eq("state: no ids without an open turn", String((recs(encodeLogs([stateLog(s, st0, NOW, null, C, "", "")], C))[0] ?? {})["traceId"] === undefined), "true");

// turn.open: the turn's ids, its start time, its model
const tr = recs(encodeLogs([turnOpenLog(t, NOW)], C))[0] ?? {};
const ta = attrs(tr);
eq("turn.open: ids", str(tr["traceId"]) + " " + str(tr["spanId"]), t.traceId + " " + t.spans[0].spanId);
eq("turn.open: time = turn start, observed = now", str(tr["timeUnixNano"]) + " " + str(tr["observedTimeUnixNano"]), "1789999995000000000 1790000000000000000");
eq("turn.open: attributes", [ta.get("gen_ai.conversation.id"), ta.get("agentglass.turn.index"), ta.get("gen_ai.request.model")].join(" "), "stringValue:\"s1\" intValue:\"3\" stringValue:\"claude-sonnet-4-5\"");

// alerts: severity by level, body rule, labels
const al = { rule: "loop", severity: "critical", state: "fire", value: 12, threshold: 8, labels: [["team", "core"]], message: titleOf(s) + " is looping" }; // render() quotes the title the screen shows
const ar = recs(encodeLogs([alertLog(s, al, NOW, t, C, "2.1.90")], C))[0] ?? {};
const aa = attrs(ar);
eq("alert: critical = ERROR", String(ar["severityNumber"]) + " " + str(ar["severityText"]), "17 ERROR");
eq("alert: attributes", [aa.get("agentglass.alert.rule"), aa.get("agentglass.alert.severity"), aa.get("agentglass.alert.state"), aa.get("agentglass.alert.value"), aa.get("agentglass.alert.threshold"), aa.get("agentglass.alert.label.team")].join(" "),
  "stringValue:\"loop\" stringValue:\"critical\" stringValue:\"fire\" doubleValue:12 doubleValue:8 stringValue:\"core\"");
eq("alert: body = rule id without titles", str((obj(ar["body"]) ?? {})["stringValue"]), REDACT ? str((obj(ar["body"]) ?? {})["stringValue"]) : "loop");
const am = recs(encodeLogs([alertLog(s, al, NOW, t, cfgFrom({ titles: true }), "2.1.90")], C))[0] ?? {};
eq("alert: body = message with titles", String(str((obj(am["body"]) ?? {})["stringValue"]).indexOf("looping") >= 0), "true");
eq("alert: the message's real title never under --redact", String(JSON.stringify(am).indexOf("zzsecretzz") >= 0), REDACT ? "false" : "true");
eq("alert: degraded = WARN, resolve = INFO", String((recs(encodeLogs([alertLog(s, { rule: "r", severity: "degraded", state: "fire", value: 1, threshold: 1, labels: [], message: "" }, NOW, null, C, "")], C))[0] ?? {})["severityNumber"]) + " " +
  String((recs(encodeLogs([alertLog(s, { rule: "r", severity: "critical", state: "resolve", value: 1, threshold: 1, labels: [], message: "" }, NOW, null, C, "")], C))[0] ?? {})["severityNumber"]), "13 9");

// grouping: heartbeat (agentglass) and claude records → two ResourceLogs; attribute tables apply
const two = parseJson(encodeLogs([heartbeat(NOW, 0, 0, 0), turnOpenLog(t, NOW), stateLog(s, st0, NOW, t, C, "2.1.90", "")], cfgFrom({ attributes: { drop: ["host.id", "agentglass.turn.index"], extra: { "deployment.environment.name": "laptop" } } }))) ?? {};
eq("two resources", String(arr(two["resourceLogs"]).length), "2");
eq("drop applies to resources and records", String(JSON.stringify(two).indexOf("host.id") >= 0 || JSON.stringify(two).indexOf("agentglass.turn.index") >= 0), "false");
eq("extra on every record", String(recs(JSON.stringify(two)).every((r: Obj) => attrs(r).has("deployment.environment.name"))), "true");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp logs: all checks passed");
