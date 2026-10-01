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

console.log(bad ? bad + " failed" : "pi: all checks passed");
if (bad) process.exit(1);
