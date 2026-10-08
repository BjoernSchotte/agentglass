// agentglass — self-check for agent detection: scriptc build src/features/agentenv.check.ts -o ae && ./ae
// SPDX-License-Identifier: Apache-2.0
import type { Proc, Sess } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { SESSION_VARS as MCP_VARS } from "../mcp/run.ts";
import { sessions } from "../model/sessions.ts";
import { type AgentHost, SESSION_VARS, detectHost, ancestry, currentFrom, parseDur, setHost, interactive, markerHarnesses, innerHost } from "./agentenv.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function hs(h: AgentHost): string { return [String(h.on), h.harness, h.session, h.via].join("|"); }
function host(env: Record<string, string>, args: string[]): string { return hs(detectHost(env, args)); }

// ── env markers and overrides ──
eq("claude", host({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" }, []), "true|claude|abc|env:CLAUDECODE");
eq("AI_AGENT claude", host({ AI_AGENT: "claude-code_2.1_agent" }, []), "true|claude||env:AI_AGENT");
eq("AI_AGENT pi", host({ AI_AGENT: "pi" }, []), "true|pi||env:AI_AGENT");
eq("AI_AGENT opencode", host({ AI_AGENT: "opencode" }, []), "true|opencode||env:AI_AGENT");
eq("AI_AGENT other", host({ AI_AGENT: "cursor" }, []), "true|||env:AI_AGENT");
eq("codex", host({ CODEX_CI: "1", CODEX_THREAD_ID: "t1" }, []), "true|codex|t1|env:CODEX_CI");
eq("codex sandbox", host({ CODEX_SANDBOX: "seatbelt" }, []), "true|codex||env:CODEX_SANDBOX");
eq("gemini", host({ GEMINI_CLI: "1" }, []), "true|gemini||env:GEMINI_CLI");
eq("pi", host({ PI_CODING_AGENT: "true" }, []), "true|pi||env:PI_CODING_AGENT");
eq("pi session id", host({ PI_CODING_AGENT: "true", AI_AGENT: "pi", PI_SESSION_ID: "01a1" }, []), "true|pi|01a1|env:PI_CODING_AGENT");
// nested: the harness's own id beats an inherited one of another harness
eq("own session var first", host({ CLAUDE_CODE_SESSION_ID: "c1", CODEX_CI: "1", CODEX_THREAD_ID: "t1" }, []), "true|codex|t1|env:CODEX_CI");
eq("opencode", host({ OPENCODE: "1", OPENCODE_SESSION_ID: "ses_x" }, []), "true|opencode|ses_x|env:OPENCODE");
eq("kiro", host({ KIRO_SESSION_ID: "k1" }, []), "true|kiro|k1|env:KIRO_SESSION_ID");
eq("AGENT alone", host({ AGENT: "1" }, []), "false|||");
eq("nothing", host({}, []), "false|||");
eq("empty marker", host({ CLAUDECODE: "" }, []), "false|||");
// nested agents (pi started from a Claude Code shell): several harnesses' markers; the process tree names the inner one
const nest = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "c1", AI_AGENT: "claude-code_2_agent", GEMINI_CLI: "1", OPENCODE: "1", OPENCODE_SESSION_ID: "ses_o", PI_SESSION_ID: "p1" };
eq("marker harnesses", markerHarnesses(nest).join(","), "claude,gemini,opencode");
eq("marker harnesses: one", markerHarnesses({ CLAUDECODE: "1", AI_AGENT: "claude-code_x" }).join(","), "claude");
const outer = detectHost(nest, []);
eq("inner opencode", hs(innerHost(outer, nest, "opencode", 42)), "true|opencode|ses_o|env:CLAUDECODE+ancestor:pid 42");
eq("inner gemini (no id var)", hs(innerHost(outer, nest, "gemini", 7)), "true|gemini||env:CLAUDECODE+ancestor:pid 7");
eq("inner = outer", hs(innerHost(outer, nest, "claude", 9)), hs(outer));
eq("no harness ancestor", hs(innerHost(outer, nest, "", 0)), hs(outer));
eq("--no-agent", host({ CLAUDECODE: "1" }, ["--no-agent"]), "false|||");
eq("AGENTGLASS_AGENT=0", host({ AGENTGLASS_AGENT: "0", CLAUDECODE: "1" }, []), "false|||");
eq("--agent", host({}, ["--agent"]), "true|||flag");
eq("AGENTGLASS_AGENT=1", host({ AGENTGLASS_AGENT: "1" }, []), "true|||flag");
eq("--agent keeps env harness", host({ CLAUDECODE: "1" }, ["--agent"]), "true|claude||flag");
eq("--no-agent beats --agent", host({}, ["--agent", "--no-agent"]), "false|||");
// a harness-specific marker beats the inherited generic AI_AGENT (codex run from Claude Code inherits AI_AGENT=claude-code…)
eq("specific beats AI_AGENT", host({ AI_AGENT: "claude-code_2_agent", CODEX_CI: "1" }, []), "true|codex||env:CODEX_CI");

// ── ancestry over a synthetic process table ──
function pr(pid: number, ppid: number, h: string, sess: string): Proc { return { pid, ppid, cpu: 0, rss: 0, etime: "", tty: "", args: "", h, start: 0, cwd: "", tcpu: 0, trss: 0, kids: 0, sess }; }
function table(ps: Proc[]): Map<number, Proc> { const m = new Map<number, Proc>(); for (const p of ps) m.set(p.pid, p); return m; }
const sessOf = (p: Proc): string => p.sess;
function anc(pid: number, ps: Proc[]): string { const a = ancestry(pid, table(ps), sessOf); return [a.harness, a.session, String(a.pid)].join("|"); }
eq("one agent", anc(300, [pr(300, 250, "", ""), pr(250, 200, "", ""), pr(200, 100, "claude", "S1"), pr(100, 1, "", "")]), "claude|S1|200");
eq("nested: nearest wins", anc(400, [pr(400, 350, "", ""), pr(350, 320, "codex", "S2"), pr(320, 200, "", ""), pr(200, 1, "claude", "S1")]), "codex|S2|350");
eq("wrapper above the binary", anc(500, [pr(500, 450, "", ""), pr(450, 440, "claude", ""), pr(440, 1, "claude", "S3")]), "claude|S3|440");
eq("agent without a session: no outer session", anc(400, [pr(400, 350, "", ""), pr(350, 320, "gemini", ""), pr(320, 200, "", ""), pr(200, 1, "claude", "S1")]), "gemini||350");
eq("cycle stops", anc(10, [pr(10, 11, "", ""), pr(11, 10, "", "")]), "||0");
const deep: Proc[] = []; for (let i = 1; i <= 70; i++) deep.push(pr(1000 + i, 1000 + i + 1, "", "")); deep.push(pr(1071, 1, "claude", "S9"));
const da = ancestry(1001, table(deep), sessOf);
eq("70 deep stops at 64", String(da.steps) + "|" + da.harness, "64|");
eq("no ps", anc(10, []), "||0");

// ── current session ──
const dir = "/tmp/agentglass-agentenv-" + String(process.pid);
function put(h: string, id: string, parent: string): Sess { const s = newSess(h, id, dir + "/" + id + ".jsonl", false); s.parent = parent; s.mtime = 1; sessions.set(s.path, s); return s; }
const root = put("claude", "root-1", ""); const sub = put("claude", "agent-a1", "root-1");
function cur(h: AgentHost, ps: Proc[], pid: number, up: boolean): string { const c = currentFrom(h, "CLAUDE_CODE_SESSION_ID", table(ps), pid, up); return (c.s ? c.s.id : "-") + "|" + c.via + "|" + c.code + "|" + c.hint; }
const envH: AgentHost = { on: true, harness: "claude", session: "root-1", via: "env:CLAUDECODE" };
eq("env id, no ps", cur(envH, [], 1, false), "root-1|env:CLAUDE_CODE_SESSION_ID||");
eq("env id of a subagent", cur({ on: true, harness: "claude", session: "agent-a1", via: "" }, [], 1, false), "agent-a1|env:CLAUDE_CODE_SESSION_ID||");
eq("--root goes up", cur({ on: true, harness: "claude", session: "agent-a1", via: "" }, [], 1, true), "root-1|env:CLAUDE_CODE_SESSION_ID||");
eq("unknown env id, no ps", cur({ on: true, harness: "claude", session: "nope", via: "" }, [], 1, false), "-||no_current_session|pass a session id or use 'last'");
const cx = put("codex", "cx-1", "");
eq("unknown env id → ancestry", cur({ on: true, harness: "claude", session: "nope", via: "" }, [pr(7, 6, "", ""), pr(6, 1, "codex", cx.path)], 7, false), "cx-1|ancestor:pid 6||");
eq("nested: ancestor beats env of another harness", cur(envH, [pr(7, 6, "", ""), pr(6, 5, "codex", cx.path), pr(5, 1, "claude", root.path)], 7, false), "cx-1|env:CLAUDE_CODE_SESSION_ID+ancestor:pid 6||");
eq("same harness: env id stays", cur(envH, [pr(7, 5, "", ""), pr(5, 1, "claude", root.path)], 7, false), "root-1|env:CLAUDE_CODE_SESSION_ID||");
eq("process found, no session", cur({ on: true, harness: "", session: "", via: "" }, [pr(7, 6, "", ""), pr(6, 1, "gemini", "")], 7, false), "-|ancestor:pid 6|no_current_session|session not written yet (or not linked to this gemini process: pass its id)");
eq("nothing at all", cur({ on: true, harness: "", session: "", via: "" }, [pr(7, 1, "", "")], 7, false), "-||no_current_session|pass a session id or use 'last'");

// ── durations, interactive ──
eq("30s", String(parseDur("30s")), "30000");
eq("2m", String(parseDur("2m")), "120000");
eq("1h", String(parseDur("1h")), "3600000");
eq("500ms", String(parseDur("500ms")), "500");
eq("bad", String(parseDur("x")), "-1");
eq("no unit", String(parseDur("30")), "-1");
setHost({ on: true, harness: "", session: "", via: "flag" });
eq("agent: never interactive", String(interactive()), "false");
// agentglass-mcp drops these from its children's env: its copy (src/mcp/run.ts, no feature imports) must stay equal
eq("session vars", JSON.stringify(SESSION_VARS), JSON.stringify(["CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID", "CODEX_THREAD_ID", "KIRO_SESSION_ID", "PI_SESSION_ID"]));
eq("session vars: the MCP copy", JSON.stringify(MCP_VARS), JSON.stringify(SESSION_VARS));

console.log(bad ? bad + " failed" : "agentenv: all checks passed");
if (bad) process.exit(1);
