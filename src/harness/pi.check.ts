// agentglass — self-check for the pi adapter (MCP, nested calls, subagents): scriptc build src/harness/pi.check.ts -o pc && ./pc
// SPDX-License-Identifier: Apache-2.0
import { type Acc, type Day, newAcc } from "../features/usage/record.ts";
import { pi } from "./pi.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

// synthetic lines in the shapes pi 0.99.2 / pi-mcp-adapter 4.0 write (real runs, 2026-10-01)
const T1 = "2026-10-01T10:00:00.000Z"; const T2 = "2026-10-01T10:00:01.000Z";
function call(id: string, name: string, args: string): string {
  return "{\"type\":\"message\",\"timestamp\":\"" + T1 + "\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"arguments\":" + args + "}],\"model\":\"m\",\"stopReason\":\"toolUse\"}}";
}
function result(id: string, name: string, extra: string): string {
  return "{\"type\":\"message\",\"timestamp\":\"" + T2 + "\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"" + id + "\",\"toolName\":\"" + name + "\",\"content\":[{\"type\":\"text\",\"text\":\"x\"}]" + extra + "}}";
}
function feed(ls: string[]): Acc { const a = newAcc(); for (const l of ls) pi.usage(a, l); return a; }
function day(a: Acc): Day | null { let d: Day | null = null; for (const v of a.days.values()) d = v; return d; }
// "name:n/err" per tool row, sorted
function rows(a: Acc): string {
  const d = day(a); if (!d) return "";
  const out: string[] = []; for (const [k, v] of d.tt) out.push(k + ":" + String(v.n) + "/" + String(v.err));
  return out.sort().join(" ");
}

// ── MCP canonical names (spec decision 2) and adapter errors (decision 4) ──
ok("native direct", rows(feed([call("c1", "mcp__everything__echo", "{\"message\":\"hi\"}"), result("c1", "mcp__everything__echo", ",\"details\":{\"server\":\"everything\",\"tool\":\"echo\"},\"isError\":false")])) === "mcp__everything__echo:1/0", "");
const prox = feed([call("c1", "mcp", "{\"tool\":\"echo\",\"server\":\"everything\",\"args\":{\"message\":\"a\"}}"), result("c1", "mcp", ",\"details\":{\"mode\":\"call\",\"server\":\"everything\",\"tool\":\"echo\",\"canonicalTool\":\"everything_echo\"},\"isError\":false")]);
ok("adapter proxy re-keyed", rows(prox) === "mcp__everything__echo:1/0", rows(prox));
ok("adapter proxy totals", prox.tools === 1, String(prox.tools));
const srch = feed([call("c1", "mcp", "{\"search\":\"sum\"}"), result("c1", "mcp", ",\"details\":{\"mode\":\"search\",\"matches\":[{\"server\":\"everything\",\"tool\":\"everything_get-sum\"}]},\"isError\":false")]);
ok("adapter search stays mcp", rows(srch) === "mcp:1/0", rows(srch));
const dir = feed([call("c1", "everything_echo", "{\"message\":\"a\"}"), result("c1", "everything_echo", ",\"details\":{\"server\":\"everything\",\"tool\":\"echo\"},\"isError\":false")]);
ok("adapter direct tool", rows(dir) === "mcp__everything__echo:1/0", rows(dir));
const wrap = feed([call("c1", "mcp__everything", "{\"tool\":\"echo\",\"args\":{}}"), result("c1", "mcp__everything", ",\"details\":{\"mode\":\"call\",\"server\":\"everything\",\"tool\":\"echo\"},\"isError\":false")]);
ok("adapter server wrapper", rows(wrap) === "mcp__everything__echo:1/0", rows(wrap));
const terr = feed([call("c1", "mcp", "{\"tool\":\"get_sum\",\"server\":\"everything\"}"), result("c1", "mcp", ",\"details\":{\"mode\":\"call\",\"error\":\"tool_error\",\"server\":\"everything\",\"tool\":\"get-sum\"},\"isError\":false")]);
ok("adapter tool_error counts with isError false", rows(terr) === "mcp__everything__get-sum:1/1", rows(terr));
const cf = feed([call("c1", "mcp", "{\"tool\":\"x\"}"), result("c1", "mcp", ",\"details\":{\"mode\":\"call\",\"error\":\"call_failed\",\"server\":\"s\",\"tool\":\"x\"},\"isError\":false")]);
ok("adapter call_failed counts", rows(cf) === "mcp__s__x:1/1", rows(cf));
const auth = feed([call("c1", "mcp", "{\"tool\":\"x\"}"), result("c1", "mcp", ",\"details\":{\"mode\":\"call\",\"error\":\"auth_required\",\"server\":\"s\",\"tool\":\"x\"},\"isError\":false")]);
ok("adapter auth_required no error", rows(auth) === "mcp__s__x:1/0", rows(auth));
const plain = feed([call("c1", "bash", "{\"command\":\"ls\"}"), result("c1", "bash", ",\"isError\":false")]);
ok("plain tool unchanged", rows(plain) === "bash:1/0", rows(plain));

// ── nested calls (spec decision 3) ──
function row(a: Acc, k: string): string { const d = day(a); const v = d ? d.tt.get(k) : undefined; return v ? [v.n, v.err, v.dn, v.ms].join(",") : "none"; }
function progs(a: Acc): string { const d = day(a); if (!d) return ""; const o: string[] = []; for (const k of d.prog.keys()) o.push(k); return o.sort().join("|"); }
function files(a: Acc): string { const d = day(a); if (!d) return ""; const o: string[] = []; for (const [k, v] of d.files) o.push(k + ":" + String(v.add) + "/" + String(v.del)); return o.sort().join("|"); }
const NESTED = "[{\"id\":\"cm/1\",\"name\":\"mcp__everything__echo\",\"status\":\"ok\",\"arguments\":{\"message\":\"hi\"},\"durationMs\":412}," +
  "{\"id\":\"cm/2\",\"name\":\"bash\",\"status\":\"ok\",\"arguments\":{\"command\":\"wc -l notes.txt\"},\"durationMs\":7}," +
  "{\"id\":\"cm/3\",\"name\":\"write\",\"status\":\"ok\",\"arguments\":{\"path\":\"notes.txt\",\"content\":\"a\\nb\\n\"},\"durationMs\":1}," +
  "{\"id\":\"cm/4\",\"name\":\"mcp__everything__add\",\"status\":\"error\",\"arguments\":{\"a\":\"x\"},\"durationMs\":1,\"error\":\"bad\"}," +
  "{\"id\":\"cm/5\",\"name\":\"edit\",\"status\":\"unfinished\",\"argumentsBytes\":9000}]";
// codemode details.calls: args is a JSON string, durations are floats
const DCALLS = "[{\"id\":\"cm/1\",\"name\":\"mcp__everything__echo\",\"args\":\"{\\\"message\\\":\\\"hi\\\"}\",\"status\":\"ok\",\"durationMs\":412.2}," +
  "{\"id\":\"cm/2\",\"name\":\"bash\",\"args\":\"{\\\"command\\\":\\\"wc -l notes.txt\\\"}\",\"status\":\"ok\",\"durationMs\":7.3}," +
  "{\"id\":\"cm/3\",\"name\":\"write\",\"args\":\"{\\\"path\\\":\\\"notes.txt\\\",\\\"content\\\":\\\"a\\\\nb\\\\n\\\"}\",\"status\":\"ok\",\"durationMs\":1.2}," +
  "{\"id\":\"cm/4\",\"name\":\"mcp__everything__add\",\"args\":\"{}\",\"status\":\"error\",\"durationMs\":0.8,\"error\":\"bad\"}," +
  "{\"id\":\"cm/5\",\"name\":\"edit\",\"args\":\"\",\"status\":\"running\"}]";
const CODE = "{\"code\":\"const e = await tools.mcp__everything__echo({message:'hi'});\\nreturn e;\"}";
function nestedCase(w: string, extra: string): void {
  const a = feed([call("cm", "codemode", CODE), result("cm", "codemode", extra)]);
  ok(w + ": rows", rows(a) === "bash:1/0 codemode:1/0 edit:1/0 mcp__everything__add:1/1 mcp__everything__echo:1/0 write:1/0", rows(a));
  ok(w + ": echo duration", row(a, "mcp__everything__echo") === "1,0,1,412", row(a, "mcp__everything__echo"));
  ok(w + ": edit without arguments, no duration", row(a, "edit") === "1,0,0,0", row(a, "edit"));
  ok(w + ": shell program", progs(a) === "bash\twc", progs(a));
  ok(w + ": written lines + file", files(a) === "write\tnotes.txt:2/0" && a.add === 2 && a.del === 0, files(a) + " " + String(a.add));
  ok(w + ": tools", a.tools === 6, String(a.tools));
  ok(w + ": nothing left pending", a.pend.size === 0, String(a.pend.size));
}
nestedCase("nestedCalls", ",\"details\":{\"calls\":[]},\"isError\":false,\"nestedCalls\":{\"calls\":" + NESTED + ",\"complete\":false}");
nestedCase("details.calls", ",\"details\":{\"calls\":" + DCALLS + "},\"isError\":false");
const scr = feed([call("ms", "mcpScript", "{\"code\":\"await mcp.call('echo')\"}"), result("ms", "mcpScript", ",\"details\":{\"mode\":\"script\",\"calls\":[{\"operation\":\"call\",\"path\":\"echo\",\"ok\":true,\"durationMs\":5},{\"operation\":\"search\",\"path\":\"echo\",\"ok\":true,\"durationMs\":1},{\"operation\":\"call\",\"path\":\"add\",\"ok\":false,\"error\":\"nope\",\"durationMs\":2}]},\"isError\":false")]);
ok("mcpScript calls", rows(scr) === "add:1/1 echo:1/0 mcpScript:1/0", rows(scr));
ok("mcpScript duration", row(scr, "echo") === "1,0,1,5", row(scr, "echo"));
// a codemode result whose call line was not seen (pending lost): nested calls still count
const lost = feed([result("cm", "codemode", ",\"details\":{\"calls\":[]},\"nestedCalls\":{\"calls\":" + NESTED + ",\"complete\":true}")]);
ok("nested without parent pending", lost.tools === 5, String(lost.tools));

console.log(bad ? bad + " failed" : "pi: all checks passed");
if (bad) process.exit(1);
