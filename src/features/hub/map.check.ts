// agentglass — self-check for OTLP → host reports: scriptc build src/features/hub/map.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { obj, arr } from "../../util/json.ts";
import { newAgg, ingestLine, reportsOf, prune, msgHash } from "./map.ts";
import type { HostReport } from "../fleet/model.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const SAMPLE = readFileSync("testdata/hub/collector-sample.jsonl", "utf8").trim(); // the exporter's own output for the claude fixture
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const num = (v: unknown): number => typeof v === "number" ? v as number : NaN;
const js = (v: unknown): string => v === undefined ? "undefined" : JSON.stringify(v);
const kv = (k: string, v: string): string => "{\"key\":\"" + k + "\",\"value\":{\"stringValue\":" + JSON.stringify(v) + "}}";
const ki = (k: string, v: number): string => "{\"key\":\"" + k + "\",\"value\":{\"intValue\":\"" + String(v) + "\"}}";
const kb = (k: string, v: boolean): string => "{\"key\":\"" + k + "\",\"value\":{\"boolValue\":" + String(v) + "}}";
const ns = (ms: number): string => String(ms) + "000000";
function rep(m: Map<string, HostReport>, k: string): HostReport | null { return m.get(k) ?? null; }
function sess0(r: HostReport | null, k: string): unknown { if (!r || !r.sessions.length) return null; const x = r.sessions[0]; return x ? x.s[k] : null; }

// the exporter's request, read as a Collector directory (trust payload: host = host.id)
let a = newAgg();
ingestLine(a, SAMPLE, null);
const t0 = 1788256823000;
let r = rep(reportsOf(a, t0, true, 3650), "00112233445566ff");
ok("one host by host.id", r !== null && a.hosts.size === 1, String(a.hosts.size));
const s0 = r ? r.sessions[0] : null; const s = s0 ? s0.s : {};
ok("one session, harness:conversation", r?.sessions.length === 1 && s0?.key === "claude:11111111-1111-4111-8111-111111111111", String(s0?.key));
const tok = obj(s["tokens"]) ?? {};
ok("tokens exclusive of cache (inclusive semantics)", tok["in"] === 70 && tok["out"] === 71 && tok["cacheRead"] === 400 && tok["cacheWrite"] === 20, JSON.stringify(tok));
ok("cost = sum of chat spans", near(num(s["costUsd"]), 0.00122), String(s["costUsd"]));
ok("billing mode", (obj(s["billing"]) ?? {})["mode"] === "plan", JSON.stringify(s["billing"]));
ok("tools, subagents, model", s["tools"] === 4 && s["subagents"] === 1 && s["model"] === "claude-sonnet-4-5", JSON.stringify([s["tools"], s["subagents"], s["model"]]));
ok("cwd, branch, repo key", s["cwd"] === "/home/u/proj" && s["branch"] === "main" && obj(s["repo"]) !== null, JSON.stringify([s["cwd"], s["branch"], s["repo"]]));
ok("field order = the --json contract", Object.keys(s).join(",").startsWith("id,harness,title,cwd,branch,remote,model,path,updated,bytes,live,pid"), Object.keys(s).join(","));
ok("not reconstructable: null/0", s["path"] === null && s["pid"] === 0 && s["bytes"] === 0 && s["git"] === null && s["linesAdded"] === 0, JSON.stringify([s["path"], s["pid"]]));
const own = s0 && s0.own ? s0.own : [];
let hasB = false; let ob12 = false;
for (const o of own) if (o.h === msgHash("msg_b")) { hasB = true; ob12 = o.n[0] === 12 && o.n[1] === 30 && o.key === 1788256806500 * 2; }
ok("own rows: one per Claude response id", own.length === 5 && hasB, String(own.length));
ok("own row of a fallback message sums both attempts, earliest key", ob12, JSON.stringify(own));
ok("msgHash = fleet 13.1", msgHash("msg_a").length === 16 && /^[0-9a-f]+$/.test(msgHash("msg_a")), msgHash("msg_a"));
const days = s0 && s0.days ? s0.days : [];
let calls = 0; let usd = 0; let width = 0;
for (const d of days) { calls += d.calls; for (const t of d.tp) { usd += Number(t[8] ?? "0"); width = t.length; } }
ok("day rows: every chat span, table-priced rows of 9", calls === 6 && near(usd, 0.00122) && width === 9, JSON.stringify(days));
ok("exact (agentglass scope)", r !== null && r.exact && r.hello.version !== "", String(r?.exact));
// a resent batch counts once
ingestLine(a, SAMPLE, null);
r = rep(reportsOf(a, t0, true, 3650), "00112233445566ff");
const rs0 = r ? r.sessions[0] : null;
ok("resend: same totals", rs0 !== null && near(num(rs0.s["costUsd"]), 0.00122) && (rs0.own ?? []).length === 5, String(rs0?.s["costUsd"]));
ok("unchanged host: no report", reportsOf(a, t0, false, 3650).size === 0, "reported");
prune(a);
// a receive directory: the label names the host
a = newAgg(); ingestLine(a, SAMPLE, { name: "ci", hostId: "00112233445566ff" });
ok("label host", rep(reportsOf(a, t0, true, 3650), "ci")?.hello.hostId === "00112233445566ff", [...a.hosts.keys()].join(","));
// a Collector that stamps the authenticated subject: a host.id change under one subject is dropped
function res(hid: string, sub: string, extra: string): string { return "{\"resource\":{\"attributes\":[" + kv("service.name", "claude-code") + "," + kv("host.id", hid) + (sub ? "," + kv("agentglass.auth.subject", sub) : "") + extra + "]}"; }
function span(id: string, conv: string, end: number, attrs: string[]): string { return "{\"spanId\":\"" + id + "\",\"name\":\"chat\",\"endTimeUnixNano\":\"" + ns(end) + "\",\"attributes\":[" + kv("gen_ai.operation.name", "chat") + "," + kv("gen_ai.conversation.id", conv) + (attrs.length ? "," + attrs.join(",") : "") + "]}"; }
function tline(rs: string, sps: string[]): string { return "{\"resourceSpans\":[" + rs + ",\"scopeSpans\":[{\"scope\":{\"name\":\"agentglass\",\"version\":\"x\"},\"spans\":[" + sps.join(",") + "]}]}]}"; }
const cost = (v: number): string => "{\"key\":\"agentglass.usage.cost\",\"value\":{\"doubleValue\":" + String(v) + "}}";
a = newAgg();
ingestLine(a, tline(res("aaaaaaaaaaaaaaaa", "cn=lap", ""), [span("1", "c1", t0, [ki("gen_ai.usage.input_tokens", 5), cost(0.5), kv("agentglass.usage.cost.source", "built-in")])]), null);
ingestLine(a, tline(res("bbbbbbbbbbbbbbbb", "cn=lap", ""), [span("2", "c2", t0, [])]), null);
ok("subject pins its first host id", a.hosts.size === 1 && a.refused === 1, [...a.hosts.keys()].join(","));
// native Claude Code api_request records: matched by request id → dropped; unmatched → harness-priced usage
function natLine(req: string, sess: string, usdv: number): string {
  return "{\"resourceLogs\":[{\"resource\":{\"attributes\":[" + kv("service.name", "claude-code") + "," + kv("host.id", "cccccccccccccccc") + "," + kv("user.email", "me@example.com") + "]},\"scopeLogs\":[{\"scope\":{\"name\":\"com.anthropic.claude_code.events\"},\"logRecords\":[{\"timeUnixNano\":\"" + ns(t0) + "\",\"body\":{\"stringValue\":\"claude_code.api_request\"},\"attributes\":[" +
    kv("event.name", "claude_code.api_request") + "," + kv("request_id", req) + "," + kv("session.id", sess) + "," + kv("model", "claude-sonnet-4-5") + "," + ki("input_tokens", 10) + "," + ki("output_tokens", 2) + ",{\"key\":\"cost_usd\",\"value\":{\"doubleValue\":" + String(usdv) + "}}," + kv("user.email", "me@example.com") + "," + kv("user.account_uuid", "acct-1") + "]}]}]}]}";
}
a = newAgg();
ingestLine(a, natLine("req_1", "native-sess", 0.25), null); // arrives before the agentglass span
ingestLine(a, tline(res("cccccccccccccccc", "", "," + kv("user.email", "me@example.com")), [span("9", "ag-sess", t0, [kv("agentglass.request.id", "req_1"), ki("gen_ai.usage.input_tokens", 10), cost(0.25), kv("agentglass.usage.cost.source", "built-in")])]), null);
ingestLine(a, natLine("req_2", "native-only", 0.75), null);
r = rep(reportsOf(a, t0, true, 3650), "cccccccccccccccc");
const ks: string[] = []; for (const x of r ? r.sessions : []) ks.push(x.key);
ok("matched native dropped, unmatched kept", ks.sort().join(",") === "claude:ag-sess,claude:native-only", ks.join(","));
let nat: { usd: number; hx: number; tp: number } = { usd: -1, hx: -1, tp: -1 };
for (const x of r ? r.sessions : []) if (x.key === "claude:native-only") { const d0 = x.days ? x.days[0] : null; nat = { usd: num(x.s["costUsd"]), hx: d0 ? d0.hx.length : -1, tp: d0 ? d0.tp.length : -1 }; }
ok("unmatched native: harness-priced (hx)", near(nat.usd, 0.75) && nat.hx === 1 && nat.tp === 0, JSON.stringify(nat));
ok("a host with native usage is not exact", r !== null && !r.exact, String(r?.exact));
ok("no address or account id anywhere in the reports", JSON.stringify(r).indexOf("@") < 0 && JSON.stringify(r).indexOf("acct-1") < 0, "leaked");
const r2 = rep(reportsOf(a, t0, true, 3650), "cccccccccccccccc");
let again = -1; for (const x of r2 ? r2.sessions : []) if (x.key === "claude:native-only") again = num(x.s["costUsd"]);
ok("reports do not accumulate native usage", near(again, 0.75), String(again));
// the logs stream: heartbeat, session state, alerts; stale after 90 s
function lline(recs: string[]): string { return "{\"resourceLogs\":[{\"resource\":{\"attributes\":[" + kv("service.name", "claude-code") + "," + kv("host.id", "dddddddddddddddd") + "]},\"scopeLogs\":[{\"scope\":{\"name\":\"agentglass\"},\"logRecords\":[" + recs.join(",") + "]}]}]}"; }
function rec(ev: string, t: number, attrs: string[], body: string): string { return "{\"timeUnixNano\":\"" + ns(t) + "\",\"eventName\":\"" + ev + "\",\"body\":{\"stringValue\":" + JSON.stringify(body) + "},\"attributes\":[" + attrs.join(",") + "]}"; }
a = newAgg();
ingestLine(a, lline([rec("agentglass.heartbeat", t0, [], "agentglass.heartbeat"),
  rec("agentglass.session.state", t0, [kv("gen_ai.conversation.id", "s1"), kb("agentglass.session.live", true), kb("agentglass.session.busy", false), kb("agentglass.session.attention", true), kb("agentglass.session.approval", true), kv("agentglass.session.stuck", ""), kv("agentglass.session.title", "fix login")], "x"),
  rec("agentglass.alert", t0, [kv("gen_ai.conversation.id", "s1"), kv("agentglass.alert.rule", "cost.session"), kv("agentglass.alert.severity", "critical"), kv("agentglass.alert.state", "fire")], "session over $5")]), null);
r = rep(reportsOf(a, t0 + 30000, true, 3650), "dddddddddddddddd");
const lv = r && r.live ? r.live[0] : undefined;
ok("live row from session.state", lv !== undefined && lv.live && lv.attention && lv.approval && lv.key === "claude:s1", js(r ? r.live : null));
ok("alert on the live row and the session", lv !== undefined && lv.alerts.length === 1 && r !== null && arr(sess0(r, "alerts")).length === 1 && sess0(r, "title") === "fix login", js(lv ? lv.alerts : null));
r = rep(reportsOf(a, t0 + 91000, true, 3650), "dddddddddddddddd");
ok("heartbeat over 90 s old: not live", r !== null && r.live !== null && r.live[0]?.live === false && sess0(r, "live") === false, js(r ? r.live : null));
ingestLine(a, lline([rec("agentglass.alert", t0 + 5000, [kv("gen_ai.conversation.id", "s1"), kv("agentglass.alert.rule", "cost.session"), kv("agentglass.alert.state", "resolve")], "")]), null);
r = rep(reportsOf(a, t0 + 6000, true, 3650), "dddddddddddddddd");
ok("resolved alert gone", r !== null && r.live !== null && (r.live[0]?.alerts.length ?? 1) === 0, js(r ? r.live : null));
// malformed lines are ignored
a = newAgg(); ingestLine(a, "{x", null); ingestLine(a, "[]", null); ingestLine(a, "{\"resourceSpans\":[{\"resource\":3}]}", null);
ok("garbage ignored", a.hosts.size === 0, String(a.hosts.size));
if (bad) console.log(String(bad) + " failed"); else console.log("hub map: all checks passed");
if (bad) process.exit(1);
