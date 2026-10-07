// agentglass — self-check for OTLP/JSON encoding and attributes: scriptc build src/features/otlp/encode.check.ts -o ec && ./ec
// The suite runs it with AGENTGLASS_REDACT=1 (privacy cases); the plain cases build a config that ignores redaction where noted.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { type Obj, obj, str, arr, parse as parseJson } from "../../util/json.ts";
import { HOME } from "../../util/fs.ts";
import { newSess } from "../../model/types.ts";
import { applyMeta } from "../../hooks.ts";
import "../redact.ts";
import { REDACT } from "../redact-on.ts";
import { type XTurn, type XSpan, newSpan } from "./types.ts";
import { cfgFrom } from "./config.ts";
import { encodeRequest, nanos, vcsOf } from "./encode.ts";
import { HOSTID } from "../../util/hostid.ts";
import { scrubText } from "../redact.ts";

// a fixed host id for every resource (otlp-complete 3.1)
mkdirSync(HOME + "/.agentglass", { recursive: true }); writeFileSync(HOME + "/.agentglass/hid", "00112233445566ff\n"); HOSTID.idFile = HOME + "/.agentglass/hid";
let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const T0 = 1767225600123;
function turn(h: string, key: string): XTurn {
  const t: XTurn = { h, rootId: "s1", path: "/p", key, index: 1, traceId: "0123456789abcdef0123456789abcdef", t0: T0, t1: T0 + 5000, closed: true, closedBy: "next", compacted: false, ver: "2.1.90", cwd: "/w/app", branch: "main", remote: "", spans: [], fx: [], fxOn: false, title: "", repoKey: "" };
  const r = newSpan("invoke_agent", "invoke_agent Claude Code", "aaaaaaaaaaaaaaaa", "", T0, "s1"); r.t1 = T0 + 5000; r.model = "claude-sonnet-4-5"; r.models = ["claude-opus-4-5", "claude-sonnet-4-5"]; r.input = "fix the build"; r.output = "done";
  const c = newSpan("chat", "chat claude-sonnet-4-5", "bbbbbbbbbbbbbbbb", r.spanId, T0 + 10, "s1"); c.t1 = T0 + 900; c.model = "claude-sonnet-4-5"; c.provider = "anthropic"; c.respId = "msg_a";
  c.nIn = 10; c.nOut = 5; c.cr = 100; c.cw = 5; c.rs = 0; c.cost = 0.01; c.hasUsage = true; c.bill = "plan"; c.costSrc = "built-in"; c.output = "x".repeat(40);
  const u = newSpan("chat", "chat mystery", "cccccccccccccccc", r.spanId, T0 + 1000, "s1"); u.t1 = T0 + 1100; u.model = "mystery"; u.nIn = 3; u.unk = 3; u.hasUsage = true; u.bill = "unknown";
  const x = newSpan("execute_tool", "execute_tool mcp__ctx__search", "dddddddddddddddd", r.spanId, T0 + 950, "s1"); x.t1 = T0 + 990; x.tool = "mcp__ctx__search"; x.mcp = "ctx"; x.callId = "toolu_1"; x.args = "{\"query\":\"q\"}"; x.result = "hit";
  const b = newSpan("execute_tool", "execute_tool Bash git", "eeeeeeeeeeeeeeee", r.spanId, T0 + 1200, "s1"); b.t1 = T0 + 1300; b.tool = "Bash"; b.prog = "git"; b.exit = 1; b.err = "tool_error"; b.errMsg = "fatal";
  t.spans = [r, c, u, x, b];
  return t;
}
function req(turns: XTurn[], raw: unknown): Obj { return parseJson(encodeRequest(turns, cfgFrom(raw))) ?? {}; }
function spans(o: Obj): Obj[] { const out: Obj[] = []; for (const rs of arr(o["resourceSpans"])) for (const ss of arr((obj(rs) ?? {})["scopeSpans"])) for (const s of arr((obj(ss) ?? {})["spans"])) { const so = obj(s); if (so) out.push(so); } return out; }
function attrs(s: Obj): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of arr(s["attributes"])) { const ao = obj(a); if (!ao) continue; const v = obj(ao["value"]) ?? {}; const k = Object.keys(v)[0] ?? ""; m.set(str(ao["key"]), k + ":" + JSON.stringify(v[k])); }
  return m;
}
const keys = (s: Obj): string => [...attrs(s).keys()].join(",");

eq("nanos", nanos(1767225600123), "1767225600123000000");
eq("nanos floor", nanos(1767225600123.7), "1767225600123000000");
const o = req([turn("claude", "k#0")], {});
const sp = spans(o);
eq("span count", String(sp.length), "5");
const root = sp[0] ?? {}; const chat = sp[1] ?? {}; const unp = sp[2] ?? {}; const mcp = sp[3] ?? {}; const bash = sp[4] ?? {};
eq("times are decimal strings", JSON.stringify(root["startTimeUnixNano"]) + " " + JSON.stringify(chat["endTimeUnixNano"]), "\"1767225600123000000\" \"1767225601023000000\"");
eq("kinds", String(root["kind"]) + String(chat["kind"]) + String(mcp["kind"]), "131");
eq("root has no parent", String(root["parentSpanId"] === undefined) + " " + str(chat["parentSpanId"]), "true aaaaaaaaaaaaaaaa");
const ra = attrs(root);
eq("root: no usage", String([...ra.keys()].some((k: string) => k.startsWith("gen_ai.usage.") || k === "agentglass.usage.cost" || k === "agentglass.billing.mode")), "false");
eq("root facts", [ra.get("gen_ai.operation.name"), ra.get("gen_ai.request.model"), ra.get("agentglass.models"), ra.get("session.id"), ra.get("agentglass.turn.index"), ra.get("gen_ai.agent.name")].join(" "),
  "stringValue:\"invoke_agent\" stringValue:\"claude-sonnet-4-5\" arrayValue:{\"values\":[{\"stringValue\":\"claude-opus-4-5\"},{\"stringValue\":\"claude-sonnet-4-5\"}]} stringValue:\"s1\" intValue:\"1\" stringValue:\"Claude Code\"");
const ca = attrs(chat);
eq("chat usage inclusive", [ca.get("gen_ai.usage.input_tokens"), ca.get("gen_ai.usage.output_tokens"), ca.get("gen_ai.usage.cache_read.input_tokens"), ca.get("gen_ai.usage.cache_write.input_tokens"), ca.get("agentglass.usage.cost"), ca.get("agentglass.billing.mode"), ca.get("gen_ai.response.id"), String(ca.has("gen_ai.usage.reasoning.output_tokens"))].join(" "),
  "intValue:\"115\" intValue:\"5\" intValue:\"100\" intValue:\"5\" doubleValue:0.01 stringValue:\"plan\" stringValue:\"msg_a\" false");
eq("provider semantics", attrs(spans(req([turn("claude", "k#0")], { inputTokens: "provider" }))[1] ?? {}).get("gen_ai.usage.input_tokens") ?? "", "intValue:\"10\"");
{ // one provider rule across the trace: gen_ai.provider.name from the model; the record's own provider id kept apart
  const t = turn("pi", "k#0"); t.spans[1].provider = "openai"; t.spans[1].provId = "cliproxyapi"; t.spans[1].model = "gpt-5.2"; t.spans[0].model = "gpt-5.2";
  const ps = spans(req([t], {})); const r0 = attrs(ps[0] ?? {}); const c1 = attrs(ps[1] ?? {}); const b4 = attrs(ps[4] ?? {});
  eq("provider: same name on root, chat and tool spans; logged id on the chat span", [r0.get("gen_ai.provider.name"), c1.get("gen_ai.provider.name"), b4.get("gen_ai.provider.name"), c1.get("agentglass.provider.id"), String(r0.has("agentglass.provider.id"))].join(" "),
    "stringValue:\"openai\" stringValue:\"openai\" stringValue:\"openai\" stringValue:\"cliproxyapi\" false");
  // a model with no known vendor: the logged provider names it on every span of the trace, not only on chat
  const u = turn("pi", "k#0"); u.spans[1].provider = "ollama"; u.spans[1].provId = "ollama"; u.spans[1].model = "qwen3-coder:30b"; u.spans[0].model = "qwen3-coder:30b";
  const us = spans(req([u], {}));
  eq("provider: an unknown vendor's logged provider on root and tool spans too", [attrs(us[0] ?? {}).get("gen_ai.provider.name"), attrs(us[1] ?? {}).get("gen_ai.provider.name"), attrs(us[4] ?? {}).get("gen_ai.provider.name")].join(" "),
    "stringValue:\"ollama\" stringValue:\"ollama\" stringValue:\"ollama\"");
  const f = turn("fx", "k#0"); f.spans[1].total = true;
  eq("fx: the delta marker", attrs(spans(req([f], {}))[1] ?? {}).get("agentglass.usage.session_delta") ?? "", "boolValue:true");
}
const ua = attrs(unp);
eq("unpriced: no cost, billing mode kept", String(ua.has("agentglass.usage.cost")) + " " + (ua.get("agentglass.billing.mode") ?? ""), "false stringValue:\"unknown\"");
eq("unpriced: cost source", ua.get("agentglass.usage.cost.source") ?? "", "stringValue:\"unpriced\"");
eq("priced: built-in source, not estimated", (ca.get("agentglass.usage.cost.source") ?? "") + " " + (ca.get("agentglass.usage.cost.estimated") ?? ""), "stringValue:\"built-in\" boolValue:false");
{ const t = turn("codex", "k#0"); t.spans[1].costSrc = "alias"; t.spans[1].costEst = true; const al = attrs(spans(req([t], {}))[1] ?? {});
  eq("alias-priced: source and estimate", (al.get("agentglass.usage.cost.source") ?? "") + " " + (al.get("agentglass.usage.cost.estimated") ?? ""), "stringValue:\"alias\" boolValue:true"); }
eq("billing mode only on chat", String(attrs(mcp).has("agentglass.billing.mode") || attrs(bash).has("agentglass.billing.mode")), "false");
const ma = attrs(mcp);
eq("mcp tool", [ma.get("gen_ai.tool.name"), ma.get("gen_ai.tool.type"), ma.get("mcp.method.name"), ma.get("agentglass.mcp.server.name"), ma.get("gen_ai.tool.call.id")].join(" "),
  "stringValue:\"search\" stringValue:\"extension\" stringValue:\"tools/call\" stringValue:\"ctx\" stringValue:\"toolu_1\"");
const ba = attrs(bash);
eq("shell tool", [ba.get("process.executable.name"), ba.get("process.exit.code"), ba.get("error.type"), ba.get("gen_ai.tool.type")].join(" "), "stringValue:\"git\" intValue:\"1\" stringValue:\"tool_error\" stringValue:\"function\"");
eq("error status without content: no message", JSON.stringify(bash["status"]), "{\"code\":2}");
// content off: no messages, arguments or results anywhere
const js0 = encodeRequest([turn("claude", "k#0")], cfgFrom({}));
eq("content off", String(["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "fatal"].some((k: string) => js0.indexOf(k) >= 0)), "false");
// content on: semconv message shape, truncated to contentMax
const oc = req([turn("claude", "k#0")], { content: true, contentMax: 256 });
const rc = attrs(spans(oc)[0] ?? {});
eq("input messages", rc.get("gen_ai.input.messages") ?? "", "stringValue:" + JSON.stringify(JSON.stringify([{ role: "user", parts: [{ type: "text", content: "fix the build" }] }])));
const big = turn("claude", "k#0"); big.spans[1].output = "y".repeat(1000);
const cc = attrs(spans(req([big], { content: true, contentMax: 256 }))[1] ?? {});
eq("truncated to contentMax", String((cc.get("gen_ai.output.messages") ?? "").length < 400), "true");
eq("status message with content", JSON.stringify(spans(oc)[4]?.["status"]), "{\"code\":2,\"message\":\"fatal\"}");
eq("tool content", (attrs(spans(oc)[3] ?? {}).get("gen_ai.tool.call.arguments") ?? "") + " " + (attrs(spans(oc)[3] ?? {}).get("gen_ai.tool.call.result") ?? ""), "stringValue:\"{\\\"query\\\":\\\"q\\\"}\" stringValue:\"hit\"");
// attribute tables: extra on every span, drop and rename last (span and resource)
const ox = req([turn("claude", "k#0")], { attributes: { extra: { "deployment.environment.name": "laptop" }, rename: { "agentglass.usage.cost": "my.cost" }, drop: ["process.working_directory", "os.type"] } });
const xs = spans(ox);
eq("extra everywhere", String(xs.every((s: Obj) => attrs(s).has("deployment.environment.name"))), "true");
eq("drop", String(xs.some((s: Obj) => attrs(s).has("process.working_directory"))) + " " + String(JSON.stringify(ox).indexOf("os.type") >= 0), "false false");
eq("rename", String(attrs(xs[1] ?? {}).has("my.cost")) + " " + String(attrs(xs[1] ?? {}).has("agentglass.usage.cost")), "true false");
// resource and scope; two harnesses → two ResourceSpans
const two = req([turn("claude", "a#0"), turn("codex", "b#0")], {});
const rss = arr(two["resourceSpans"]);
eq("two resources", String(rss.length), "2");
const res0 = attrs(obj((obj(rss[0]) ?? {})["resource"]) ?? {});
eq("resource", [res0.get("service.name"), res0.get("service.version"), res0.get("agentglass.source"), res0.get("agentglass.usage.input_tokens.semantics"), String(res0.has("host.name")), String(res0.has("os.type"))].join(" "),
  "stringValue:\"claude-code\" stringValue:\"2.1.90\" stringValue:\"transcript\" stringValue:\"inclusive\" false true");
const sc = obj((obj(arr((obj(rss[0]) ?? {})["scopeSpans"])[0]) ?? {})["scope"]) ?? {};
eq("scope", str(sc["name"]) + " " + String(str(sc["version"]).length > 0), "agentglass true");
// vcs from the repo's own config, credentials scrubbed; nothing under --redact
const dir = "/tmp/agentglass-otlp-enc-" + String(process.pid); mkdirSync(dir + "/.git", { recursive: true });
writeFileSync(dir + "/.git/config", "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://user:ghp_x@github.com/o/r.git\n");
const v = vcsOf(dir, "main", "");
eq("vcs", v.map((a) => a.k + "=" + a.s).join(" "), REDACT ? "" : "vcs.repository.url.full=https://github.com/o/r vcs.repository.name=r vcs.owner.name=o vcs.provider.name=github vcs.ref.head.name=main vcs.ref.head.type=branch");
// the remote repo-view picks for the project (here the only one, not named origin)
writeFileSync(dir + "/.git/config", "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@gitlab.com:grp/proj.git\n");
const v2 = vcsOf(dir + "/", "dev", "");
eq("vcs: non-origin remote", v2.map((a) => a.k + "=" + a.s).join(" "), REDACT ? "" : "vcs.repository.url.full=ssh://gitlab.com/grp/proj vcs.repository.name=proj vcs.owner.name=grp vcs.provider.name=gitlab vcs.ref.head.name=dev vcs.ref.head.type=branch");
rmSync(dir, { recursive: true, force: true });
// privacy (suite runs with AGENTGLASS_REDACT=1): a learned name never leaves, no vcs.* keys
if (REDACT) {
  const s = newSess("claude", "p1", "/x.jsonl", false); s.cwd = HOME + "/zzsecretprojzz"; applyMeta(s);
  const t = turn("claude", "k#0"); t.spans[0].input = "please fix zzsecretprojzz now"; t.spans[3].result = "found in zzsecretprojzz/a.ts";
  const js = encodeRequest([t], cfgFrom({ content: true }));
  eq("redact: learned name scrubbed", String(js.indexOf("zzsecretprojzz") >= 0), "false");
  eq("redact: no vcs", String(js.indexOf("\"vcs.") >= 0), "false");
}
// ── otlp-complete 3: host.id, titles, request id, repo key, 1-hour cache writes, meta call details ──
{
  const resOf = (o: Obj, k: string): string => { const out: string[] = []; for (const r of arr(o["resourceSpans"])) out.push(attrs(obj((obj(r) ?? {})["resource"]) ?? {}).get(k) ?? "-"); return out.join(" "); };
  eq("host.id on every resource", resOf(req([turn("claude", "a#0"), turn("codex", "b#0")], {}), "host.id"), "stringValue:\"00112233445566ff\" stringValue:\"00112233445566ff\"");
  eq("host.id droppable", resOf(req([turn("claude", "a#0")], { attributes: { drop: ["host.id"] } }), "host.id"), "-");
  eq("agentglass.redact only under --redact", resOf(req([turn("claude", "a#0")], {}), "agentglass.redact"), REDACT ? "boolValue:true" : "-");
  const tt = turn("claude", "k#0"); tt.title = "fix login bug"; tt.repoKey = "git:github.com/acme/app";
  tt.spans[1].reqId = "req_011"; tt.spans[1].cw1 = 3;
  tt.spans[4].cmd = "git push origin main"; // the Bash span
  const rd = newSpan("execute_tool", "execute_tool Read", "ffffffffffffffff", tt.spans[0].spanId, T0 + 1400, "s1"); rd.t1 = T0 + 1450; rd.tool = "Read"; rd.target = "/w/app/src/a.ts";
  const gr = newSpan("execute_tool", "execute_tool Grep", "1111111111111111", tt.spans[0].spanId, T0 + 1500, "s1"); gr.t1 = T0 + 1550; gr.tool = "Grep"; gr.target = "/elsewhere/b.ts";
  const mx = newSpan("execute_tool", "execute_tool mcp__x__y", "2222222222222222", tt.spans[0].spanId, T0 + 1600, "s1"); mx.t1 = T0 + 1650; mx.tool = "mcp__x__y"; mx.mcp = "x"; mx.cmd = "should not go"; mx.target = "/w/app/nope";
  tt.spans.push(rd); tt.spans.push(gr); tt.spans.push(mx);
  const d0 = spans(req([tt], {}));
  const root0 = attrs(d0[0] ?? {});
  eq("no title by default", String(root0.has("agentglass.session.title")), REDACT ? "true" : "false");
  const d1 = spans(req([tt], { titles: true }));
  eq("title with otlp.titles", attrs(d1[0] ?? {}).get("agentglass.session.title") ?? "-", "stringValue:" + JSON.stringify(scrubText("fix login bug")));
  eq("title only on the root", String(d1.slice(1).some((x: Obj) => attrs(x).has("agentglass.session.title"))), "false");
  const long = turn("claude", "k#0"); long.title = "t".repeat(400);
  eq("title cut to 256", String((attrs(spans(req([long], { titles: true }))[0] ?? {}).get("agentglass.session.title") ?? "").length), String(256 + "stringValue:\"\"".length));
  const hashed = "stringValue:\"" + "x" + "\"";
  const rk = d0.map((x: Obj) => attrs(x).get("agentglass.repo.key") ?? "-");
  eq("repo key on every span", String(rk.every((v: string) => v === rk[0] && v !== "-")), "true");
  eq("repo key value", REDACT ? String(/^stringValue:"[0-9a-f]{16}"$/.test(rk[0] ?? "")) : rk[0] ?? "", REDACT ? "true" : "stringValue:\"git:github.com/acme/app\"");
  eq("repo key absent without identity", String(spans(req([turn("claude", "k#0")], {})).some((x: Obj) => attrs(x).has("agentglass.repo.key"))), "false");
  eq("repo key right after the vcs attributes", String(keys(d0[0] ?? {}).indexOf("process.working_directory,agentglass.repo.key") >= 0 || keys(d0[0] ?? {}).indexOf("vcs.ref.head.type,agentglass.repo.key") >= 0), "true");
  const ch1 = attrs(d0[1] ?? {});
  eq("request id on the chat span", ch1.get("agentglass.request.id") ?? "-", "stringValue:\"req_011\"");
  eq("1-hour cache writes", ch1.get("agentglass.usage.cache_write_1h.input_tokens") ?? "-", "intValue:\"3\"");
  eq("no 1-hour attribute at 0", String(attrs(spans(req([turn("claude", "k#0")], {}))[1] ?? {}).has("agentglass.usage.cache_write_1h.input_tokens")), "false");
  eq("detail none: no command or target", String(d0.some((x: Obj) => attrs(x).has("agentglass.tool.command") || attrs(x).has("agentglass.tool.target"))), "false");
  const dm = spans(req([tt], { detail: "meta" }));
  eq("meta: shell command", attrs(dm[4] ?? {}).get("agentglass.tool.command") ?? "-", "stringValue:" + JSON.stringify(scrubText("git push origin main")));
  eq("meta: target relative to the cwd", attrs(dm[5] ?? {}).get("agentglass.tool.target") ?? "-", "stringValue:" + JSON.stringify(scrubText("src/a.ts")));
  eq("meta: target outside the cwd as is", attrs(dm[6] ?? {}).get("agentglass.tool.target") ?? "-", "stringValue:" + JSON.stringify(scrubText("/elsewhere/b.ts")));
  eq("meta: nothing on other tools", String(attrs(dm[7] ?? {}).has("agentglass.tool.command") || attrs(dm[7] ?? {}).has("agentglass.tool.target")), "false");
  eq("meta: no target on shell, no command on files", String(attrs(dm[4] ?? {}).has("agentglass.tool.target") || attrs(dm[5] ?? {}).has("agentglass.tool.command")), "false");
  eq("content implies meta", attrs(spans(req([tt], { content: true }))[4] ?? {}).get("agentglass.tool.command") ?? "-", "stringValue:" + JSON.stringify(scrubText("git push origin main")));
  if (hashed === "") bad++;
}

// agent-wait: shell tool spans carry the command family and kind; a generic family (interpreter + script) only with meta
{
  const t = turn("claude", "w#0");
  const ok = newSpan("execute_tool", "execute_tool Bash pnpm", "1111111111111111", t.spans[0]?.spanId ?? "", T0 + 1400, "s1"); ok.t1 = T0 + 1500; ok.tool = "Bash"; ok.prog = "pnpm"; ok.fam = "pnpm test"; ok.fkind = "test";
  const gen = newSpan("execute_tool", "execute_tool Bash node", "2222222222222222", t.spans[0]?.spanId ?? "", T0 + 1600, "s1"); gen.t1 = T0 + 1700; gen.tool = "Bash"; gen.prog = "node"; gen.fam = "node gen.js"; gen.fkind = "other"; gen.fgen = true;
  t.spans = [t.spans[0] ?? ok, ok, gen];
  const w0 = spans(req([t], {})); const wm = spans(req([t], { detail: "meta" }));
  const fk = (o: Obj): string => (attrs(o).get("agentglass.tool.family") ?? "-") + " " + (attrs(o).get("agentglass.tool.kind") ?? "-");
  eq("family + kind", fk(w0[1] ?? {}), "stringValue:\"pnpm test\" stringValue:\"test\"");
  eq("generic family: program only", fk(w0[2] ?? {}), "stringValue:\"node\" stringValue:\"other\"");
  eq("generic family with meta", fk(wm[2] ?? {}), "stringValue:\"node gen.js\" stringValue:\"other\"");
  eq("no family on the root", fk(w0[0] ?? {}), "- -");
}
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp encode: all checks passed");
