// agentglass — self-check for the hub's ingest scrub: scriptc build src/features/hub/scrub.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { scrubRequest, scrubNeeded } from "./scrub.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const kv = (k: string, v: string): string => "{\"key\":" + JSON.stringify(k) + ",\"value\":{\"stringValue\":" + JSON.stringify(v) + "}}";
const req = "{\"resourceSpans\":[{\"resource\":{\"attributes\":[" + kv("service.name", "claude-code") + "," + kv("user.email", "me@example.com") + "," + kv("host.id", "0011223344556677") + "]},\"scopeSpans\":[{\"scope\":{\"name\":\"agentglass\"},\"spans\":[" +
  "{\"traceId\":\"a\",\"spanId\":\"b\",\"name\":\"chat\",\"attributes\":[" + kv("gen_ai.input.messages", "[{\"role\":\"user\",\"parts\":[{\"content\":\"secret source\"}]}]") + "," + kv("agentglass.session.title", "mail me@example.com about it") + "," +
  "{\"key\":\"nested\",\"value\":{\"kvlistValue\":{\"values\":[" + kv("user.email", "x@example.org") + "," + kv("ok", "1") + "]}}}" + "]}," +
  "{\"traceId\":\"a\",\"spanId\":\"c\",\"name\":\"execute_tool Bash\",\"attributes\":[" + kv("gen_ai.tool.call.result", "rm -rf output") + "," + kv("agentglass.tool.command", "curl -H 'x-api-key: AbCdEfGhIjKlMnOpQrStUvWx0123' u") + "," + kv("process.working_directory", "/home/u/p") + "]," +
  "\"events\":[{\"timeUnixNano\":\"1\",\"name\":\"exception\",\"attributes\":[" + kv("exception.message", "failed for a@b.example") + "]}],\"status\":{\"code\":2,\"message\":\"stack with code\"}}]}]}]}";
const r = scrubRequest(req, false, []);
ok("parsed", r.err === "", r.err);
ok("user.email gone", r.json.indexOf("user.email") < 0, r.json);
ok("content gone", r.json.indexOf("gen_ai.input.messages") < 0 && r.json.indexOf("secret source") < 0 && r.json.indexOf("gen_ai.tool.call.result") < 0 && r.json.indexOf("rm -rf output") < 0, r.json);
ok("status message gone, code kept", r.json.indexOf("stack with code") < 0 && r.json.indexOf("\"code\":2") >= 0, r.json);
ok("no address anywhere", r.json.indexOf("@example") < 0 && r.json.indexOf("@b.example") < 0, r.json);
ok("title kept, scrubbed", r.json.indexOf("agentglass.session.title") >= 0 && r.json.indexOf("mail xx@xxxxxxx.xxx about it") >= 0, r.json);
ok("token masked in the command", r.json.indexOf("AbCdEfGhIjKlMnOpQrStUvWx0123") < 0 && r.json.indexOf("agentglass.tool.command") >= 0, r.json);
ok("other attributes kept", r.json.indexOf("process.working_directory") >= 0 && r.json.indexOf("\"ok\"") >= 0 && r.json.indexOf("host.id") >= 0, r.json);
ok("dropped count: email ×2, input, result, status", r.dropped === 5, String(r.dropped));
const k = scrubRequest(req, true, ["process.working_directory"]);
ok("keepContent keeps content", k.json.indexOf("secret source") >= 0 && k.json.indexOf("rm -rf output") >= 0 && k.json.indexOf("stack with code") >= 0, k.json);
ok("keepContent still drops user.email", k.json.indexOf("user.email") < 0 && k.dropped === 2, String(k.dropped));
ok("drop list", k.json.indexOf("process.working_directory") < 0, k.json);
const lg = "{\"resourceLogs\":[{\"resource\":{\"attributes\":[]},\"scopeLogs\":[{\"logRecords\":[{\"body\":{\"stringValue\":\"user me@example.com logged in\"},\"attributes\":[" + kv("user.email", "me@example.com") + "," + kv("event.name", "claude_code.api_request") + "]}]}]}]}";
const l = scrubRequest(lg, false, []);
ok("log body scrubbed, email attribute gone", l.json.indexOf("@example") < 0 && l.json.indexOf("logged in") >= 0 && l.json.indexOf("claude_code.api_request") >= 0 && l.dropped === 1, l.json);
ok("not JSON", scrubRequest("{x", false, []).err !== "" && scrubRequest("[1]", false, []).err !== "", "accepted");
// the fast path: only requests that name no scrubbed key skip the rebuild; an escape that could spell one never does
const cfg = { keepContent: false, drop: ["process.working_directory"] };
ok("needed: email, content, status message, free text, drop list", scrubNeeded(req, cfg) && scrubNeeded("{\"key\":\"process.working_directory\"}", cfg) && scrubNeeded("{\"status\":{\"code\":2,\"message\":\"x\"}}", cfg), "not needed");
ok("needed: spaced and nested keys", scrubNeeded("{\"key\" :  \"user.email\"}", cfg) && scrubNeeded("{\"attributes\":[{\"key\":\"a\"},{\"key\":\n\"gen_ai.tool.call.result\"}]}", cfg), "missed");
ok("needed: a backslash in a key", scrubNeeded("{\"key\":\"user\\/email\"}", cfg), "missed");
ok("not needed: a plain span", !scrubNeeded("{\"resourceSpans\":[{\"resource\":{\"attributes\":[" + kv("host.id", "0011223344556677") + "]}}]}", cfg), "needed");
ok("an escaped key is scrubbed", scrubNeeded("{\"key\":\"user\\u002eemail\"}", cfg) && scrubRequest("{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"user\\u002eemail\",\"value\":{\"stringValue\":\"me@example.com\"}}]}}]}", false, []).json.indexOf("example") < 0, "bypassed");
if (bad) console.log(String(bad) + " failed"); else console.log("hub scrub: all checks passed");
if (bad) process.exit(1);
