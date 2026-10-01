// agentglass — self-check for the pi adapter (MCP, nested calls, subagents): scriptc build src/harness/pi.check.ts -o pc && ./pc
// SPDX-License-Identifier: Apache-2.0
import { type Acc, type Day, newAcc } from "../features/usage/record.ts";
import { pi } from "./pi.ts";
import { type Ev, type Sess, newSess } from "../model/types.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { linkByCwd } from "../model/link.ts";
import { parse as parseJson } from "../util/json.ts";

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

// ── transcript (spec decision 5) ──
function evs(ls: string[]): string {
  const out: Ev[] = [];
  for (const l of ls) { const o = parseJson(l); if (o) pi.parse(o, out, null); }
  return out.map((e) => e.kind + ":" + e.text.split("\u0000").join(" ")).join("\n");
}
const cmEv = evs([call("cm", "codemode", CODE), result("cm", "codemode", ",\"details\":{\"calls\":[]},\"isError\":false,\"nestedCalls\":{\"calls\":" + NESTED + ",\"complete\":false}")]);
ok("codemode transcript", cmEv === "tool:codemode const e = await tools.mcp__everything__echo({message:'hi'});\nresult:x\n" +
  "meta:↳ mcp__everything__echo ok 412ms\nmeta:↳ bash ok 7ms\nmeta:↳ write ok 1ms\nmeta:↳ mcp__everything__add [error] bad 1ms\nmeta:↳ edit unfinished", cmEv);
ok("adapter proxy target", evs([call("c1", "mcp", "{\"tool\":\"echo\",\"server\":\"everything\",\"args\":{\"message\":\"a\"}}")]) === "tool:mcp everything/echo", evs([call("c1", "mcp", "{\"tool\":\"echo\",\"server\":\"everything\"}")]));
ok("adapter proxy target without server", evs([call("c1", "mcp", "{\"tool\":\"echo\"}")]) === "tool:mcp echo", "");
ok("code: first non-empty line", evs([call("c1", "codemode", "{\"code\":\"\\n  \\nreturn 1;\\nx\"}")]) === "tool:codemode return 1;", evs([call("c1", "codemode", "{\"code\":\"\\n  \\nreturn 1;\\nx\"}")]));
const SYS = "{\"type\":\"message\",\"timestamp\":\"" + T1 + "\",\"message\":{\"role\":\"system\",\"content\":\"\",\"sections\":{\"preamble\":\"p\",\"mcp_servers\":\"<mcp_servers>\\nMCP servers whose tools are not declared to you.\\n- mcp__everything (codemode)\\n- mcp__github (direct)\\n</mcp_servers>\"}}}";
ok("system mcp_servers", evs([SYS]) === "meta:MCP: everything, github", evs([SYS]));
ok("system without mcp_servers", evs(["{\"type\":\"message\",\"timestamp\":\"" + T1 + "\",\"message\":{\"role\":\"system\",\"content\":\"\",\"sections\":{\"preamble\":\"p\"}}}"]) === "", "");

// ── subagent discovery (spec decisions 6, 7) ──
const root = "/tmp/agentglass-pi-check"; rmSync(root, { recursive: true, force: true });
const cwdDir = root + "/--w--"; const PB = cwdDir + "/2026-10-01T10-00-00-000Z_P";
for (const d of [PB + "/tasks", PB + "/r1/run-0", PB + "/forks", cwdDir + "/subagent-artifacts"]) mkdirSync(d, { recursive: true });
function hdr(id: string, ps: string): string { return "{\"type\":\"session\",\"version\":3,\"id\":\"" + id + "\",\"timestamp\":\"" + T1 + "\",\"cwd\":\"/w\"" + (ps ? ",\"parentSession\":\"" + ps + "\"" : "") + "}\n"; }
function info(name: string): string { return "{\"type\":\"session_info\",\"id\":\"i1\",\"timestamp\":\"" + T1 + "\",\"name\":\"" + name + "\"}\n"; }
writeFileSync(PB + ".jsonl", hdr("P", ""));
writeFileSync(PB + "/tasks/2026-10-01T10-00-01-000Z_T.jsonl", hdr("T", "P"));
writeFileSync(PB + "/r1/run-0/session.jsonl", hdr("X", "") + info("subagent-delegate-r1-1"));
writeFileSync(PB + "/forks/2026-10-01T10-00-02-000Z_F.jsonl", hdr("F", PB + ".jsonl"));
writeFileSync(cwdDir + "/2026-10-01T10-00-03-000Z_C.jsonl", hdr("C", PB + ".jsonl") + "{\"type\":\"model_change\",\"id\":\"m\",\"timestamp\":\"" + T1 + "\",\"modelId\":\"m\"}\n" + info("Explore#1b2c3d4e"));
writeFileSync(cwdDir + "/2026-10-01T10-00-04-000Z_K.jsonl", hdr("K", PB + ".jsonl") + info("my fork"));
writeFileSync(cwdDir + "/subagent-artifacts/r1_delegate_0_transcript.jsonl", "{}\n");
process.env["PI_CODING_AGENT_SESSION_DIR"] = root;
const found = new Map<string, Sess>();
const scanM = pi.scan;
scanM((path: string, id: string, parent: string, archived: boolean) => {
  const s = newSess("pi", id, path, archived); s.parent = parent;
  const mf = pi.meta; if (mf) mf(s);
  found.set(id, s);
});
function pk(id: string): string { const s = found.get(id); return s ? s.parent + "/" + s.kind : "missing"; }
ok("six sessions", found.size === 6, [...found.keys()].sort().join(","));
ok("parent top-level", pk("P") === "/", pk("P"));
ok("gotgenes task child", pk("T") === "P/subagent", pk("T"));
ok("nicobailon run child: id from header", pk("X") === "P/subagent", pk("X"));
ok("nicobailon fork-context child", pk("F") === "P/subagent", pk("F"));
ok("tintinweb child from session_info name", pk("C") === "P/Explore", pk("C"));
ok("a /fork stays top-level", pk("K") === "/", pk("K"));
// liveness: one pi process in the cwd, the tintinweb child newest → never linked to it (procs.ts offers only unparented sessions)
const live: { path: string; h: string; cwd: string; mtime: number; pid: number }[] = [];
let mt = 0;
for (const id of ["P", "K", "C"]) { const s = found.get(id); mt++; if (s && !s.parent) live.push({ path: s.path, h: "pi", cwd: s.cwd, mtime: id === "C" ? 99 : mt, pid: 0 }); }
const lk = linkByCwd([{ pid: 42, h: "pi", cwd: "/w" }], live);
const kp = found.get("K");
ok("pid goes to the newest unparented session", !!kp && lk.get(kp.path) === 42 && lk.size === 1, String(lk.size));

// ── spawnOf (spec decision 8) ──
const xs = found.get("X"); const cs = found.get("C"); const ts = found.get("T");
writeFileSync(PB + ".jsonl", hdr("P", "") +
  result("call_9", "subagent", ",\"details\":{\"mode\":\"single\",\"results\":[{\"index\":0,\"sessionFile\":\"" + PB + "/r1/run-0/session.jsonl\",\"usage\":{\"input\":1,\"cost\":0.5}}]},\"isError\":false") + "\n" +
  result("call_7", "Agent", ",\"details\":{\"displayName\":\"Explore\",\"agentId\":\"1b2c3d4e-4211-41e\",\"status\":\"completed\"},\"isError\":false") + "\n");
const spawn = pi.spawnOf; const sp = (s: Sess | undefined): string => spawn && s ? spawn(s) : "-";
ok("pi-subagents child → its subagent call", sp(xs) === "call_9", sp(xs));
ok("tintinweb child → its Agent call", sp(cs) === "call_7", sp(cs));
ok("gotgenes child: not traced", sp(ts) === "", sp(ts));
// ── subagent usage booked once (spec decision 9) ──
const ex = feed([result("call_1", "subagent", ",\"details\":{\"mode\":\"single\",\"results\":[{\"agent\":\"a\",\"usage\":{\"input\":10,\"output\":5,\"cost\":0.01},\"model\":\"m\"}]},\"isError\":false")]);
ok("--no-session child usage booked on the parent", Math.abs(ex.cost - 0.01) < 1e-9 && ex.inTok === 10 && ex.outTok === 5, String(ex.cost));
const ex2 = feed([result("call_1", "subagent", ",\"details\":{\"results\":[{\"sessionFile\":\"/x/s.jsonl\",\"usage\":{\"input\":10,\"output\":5,\"cost\":0.01},\"model\":\"m\"}]},\"isError\":false")]);
ok("child with its own file: not booked twice", ex2.cost === 0 && ex2.inTok === 0, String(ex2.cost));

console.log(bad ? bad + " failed" : "pi: all checks passed");
if (bad) process.exit(1);
