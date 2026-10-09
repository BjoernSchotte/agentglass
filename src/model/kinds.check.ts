// agentglass — self-check for the event kinds and the event.kind filter keys: scriptc build src/model/kinds.check.ts -o kd && ./kd
// (GOLDEN_WRITE=1 rewrites kinds.golden: review the diff)
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { type Ev, type Sess, newSess } from "./types.ts";
import { type Mark, registerMarks } from "./marks.ts";
import { kindIds, kindSet, kindsOf, kindsIn, kindMatch, evKinds, famsIn, kindsOfFam, specific, validKind, toolKinds, T_EDIT, LEGACY_EVENT } from "./kinds.ts";
import { parseEvents } from "../harness/index.ts";
import { parse } from "../features/query/parse.ts";
import { type EvX, compile, evxOf, EMPTY, matchSession } from "../features/query/eval.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ok(w: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + w); } }

const T = Date.parse("2026-10-01T09:00:00Z");
function iso(s: number): string { return new Date(T + s * 1000).toISOString(); }
// ── Claude: real line shapes (values invented) ──
function cu(s: number, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(s), message: { role: "user", content: text } }); }
function ca(s: number, blocks: string): string { return "{\"type\":\"assistant\",\"timestamp\":\"" + iso(s) + "\",\"message\":{\"id\":\"m" + String(s) + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[" + blocks + "]}}"; }
function tu(id: string, name: string, input: string): string { return "{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}"; }
function tr(s: number, id: string, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }); }
const claude = [
  cu(0, "add a login form"),
  ca(1, "{\"type\":\"thinking\",\"thinking\":\"plan it\"},{\"type\":\"text\",\"text\":\"On it.\"}"),
  ca(2, tu("t1", "Bash", "{\"command\":\"npm test\"}")), tr(3, "t1", "Exit code 1\nFAIL login.test.ts"),
  ca(4, tu("t2", "Bash", "{\"command\":\"git status\"}")), tr(5, "t2", "clean"),
  ca(6, tu("t3", "Edit", "{\"file_path\":\"/w/a.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}")), tr(7, "t3", "ok"),
  ca(8, tu("t4", "Read", "{\"file_path\":\"/w/a.ts\"}")), tr(9, "t4", "x"),
  ca(10, tu("t5", "Grep", "{\"pattern\":\"login\"}")), tr(11, "t5", "a.ts"),
  ca(12, tu("t6", "WebFetch", "{\"url\":\"https://example.com\"}")), tr(13, "t6", "page"),
  ca(14, tu("t7", "mcp__github__get_issue", "{\"number\":1}")), tr(15, "t7", "issue"),
  ca(16, tu("t8", "Task", "{\"description\":\"explore\",\"prompt\":\"look\"}")), tr(17, "t8", "done"),
  ca(18, tu("t9", "Skill", "{\"skill\":\"brainstorming\"}")), tr(19, "t9", "loaded"),
  ca(20, tu("t10", "AskUserQuestion", "{\"questions\":[]}")), tr(21, "t10", "yes"),
  ca(22, "{\"type\":\"text\",\"text\":\"Done.\"}"),
];
// ── Codex ──
function cx(s: number, payload: string): string { return "{\"timestamp\":\"" + iso(s) + "\",\"type\":\"response_item\",\"payload\":" + payload + "}"; }
const codex = [
  cx(30, "{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"fix the build\"}]}"),
  cx(31, "{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":" + JSON.stringify("{\"command\":[\"bash\",\"-lc\",\"cargo build\"]}") + ",\"call_id\":\"c1\"}"),
  cx(32, "{\"type\":\"function_call_output\",\"call_id\":\"c1\",\"output\":\"ok\"}"),
  cx(33, "{\"type\":\"custom_tool_call\",\"name\":\"apply_patch\",\"input\":\"*** Begin Patch\",\"call_id\":\"c2\"}"),
  cx(34, "{\"type\":\"custom_tool_call_output\",\"call_id\":\"c2\",\"output\":\"done\"}"),
  "{\"timestamp\":\"" + iso(35) + "\",\"type\":\"compacted\",\"payload\":{\"message\":\"\"}}",
  cx(36, "{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Built.\"}]}"),
];
// ── pi ──
function pc(id: string, name: string, args: string): string { return "{\"type\":\"message\",\"timestamp\":\"" + iso(40) + "\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"arguments\":" + args + "}],\"model\":\"m\",\"stopReason\":\"toolUse\"}}"; }
function pr(id: string, name: string, text: string, err: boolean): string { return "{\"type\":\"message\",\"timestamp\":\"" + iso(41) + "\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"" + id + "\",\"toolName\":\"" + name + "\",\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(text) + "}]" + (err ? ",\"isError\":true" : "") + "}}"; }
const pi = [pc("p1", "bash", "{\"command\":\"pnpm install\"}"), pr("p1", "bash", "added 3", false), pc("p2", "edit", "{\"path\":\"a.ts\"}"), pr("p2", "edit", "ok", false),
  pc("p3", "write", "{\"path\":\"b.ts\"}"), pr("p3", "write", "ok", false), pc("p4", "read", "{\"path\":\"b.ts\"}"), pr("p4", "read", "x", false)];
// Gemini and OpenCode: their adapters' tool names as events (their line shapes are covered by gemini/opencode checks)
function ev(kind: string, text: string, s: number, id: string): Ev { return { kind, text, ts: iso(s), id, full: "" }; }
const gem: Ev[] = [ev("tool", "write_file\u0000a.ts", 50, "g1"), ev("result", "ok", 50, "g1"), ev("tool", "replace\u0000a.ts", 51, "g2"), ev("result", "ok", 51, "g2"),
  ev("tool", "read_file\u0000a.ts", 52, "g3"), ev("result", "x", 52, "g3"), ev("tool", "run_shell_command\u0000npx tsc --noEmit", 53, "g4"), ev("result", "Exit code: 2", 53, "g4"),
  ev("tool", "google_web_search\u0000q", 54, "g5"), ev("result", "r", 54, "g5"), ev("tool", "activate_skill\u0000x", 55, "g6"), ev("result", "ok", 55, "g6"), ev("tool", "list_directory\u0000src", 56, "g7")];
const oc: Ev[] = [ev("tool", "edit\u0000a.ts", 60, "o1"), ev("tool", "write\u0000b.ts", 61, "o2"), ev("tool", "bash\u0000vitest run", 62, "o3"), ev("result", "1 failed\n[error] tests failed", 62, "o3"),
  ev("tool", "skill\u0000x", 63, "o4"), ev("meta", "skill: x", 63, ""), ev("meta", "context compacted", 64, ""), ev("meta", "⇄ lead · check this", 65, ""), ev("tool", "patch\u0000c.ts", 66, "o5")];

function sessOf(h: string, lines: string[], extra: Ev[]): Sess {
  const s = newSess(h, h + "-k1", "/k/" + h + ".jsonl", false); s.size = 1000;
  for (const l of lines) parseEvents(h, l, s.evs, s);
  for (const e of extra) s.evs.push(e);
  return s;
}
const all: Sess[] = [sessOf("claude", claude, []), sessOf("codex", codex, []), sessOf("pi", pi, []), sessOf("gemini", [], gem), sessOf("opencode", [], oc)];

// a registered skill family: its load mark anchors on the Skill call of the claude session (and a time-anchored one)
const sk = all[0];
registerMarks({ kind: "skill", glyph: "✧", color: () => "", gen: (x: Sess) => 0,
  of: (x: Sess): Mark[] => x !== sk ? [] : [{ kind: "skill:load", t0: T + 18000, t1: -1, seq: 0, turn: 1, ev: -1, anchor: "call=t9", label: "brainstorming", sub: "model", tok: 0, usd: 0, est: false, ref: "sk0" },
    { kind: "skill:unload", t0: T + 21000, t1: T + 21000, seq: 1, turn: 1, ev: -1, anchor: "", label: "brainstorming", sub: "compact", tok: 0, usd: 0, est: false, ref: "sk0u" }] });

// the golden: one line per event — harness, index, raw kind, tool, kinds
const out: string[] = [];
for (const s of all) {
  const ids = kindIds(s, s.evs);
  for (let i = 0; i < s.evs.length; i++) {
    const e = s.evs[i]; const t = e.kind === "tool" ? e.text.slice(0, Math.max(0, e.text.indexOf("\u0000"))) : "";
    out.push(s.h + "\t" + String(i) + "\t" + e.kind + "\t" + t + "\t" + kindSet(ids[i] + 0).join(","));
  }
}
const GP = (process.env.AGENTGLASS_SRC || "src") + "/model/kinds.golden";
if (process.env.GOLDEN_WRITE === "1") { writeFileSync(GP, out.join("\n") + "\n"); console.log("kinds.golden written: review it"); process.exit(1); }
const want = readFileSync(GP, "utf8").split("\n").filter((l: string) => l.length > 0);
for (let i = 0; i < Math.max(want.length, out.length); i++) eq("golden line " + String(i + 1), out[i] ?? "(none)", want[i] ?? "(none)");

// every taxonomy kind the spec lists shows up in the fixtures
const seen = new Set<string>(); for (const s of all) for (const k of kindsOf(s).keys()) seen.add(k);
for (const k of ["prompt", "prompt:agent", "reply", "reply:thinking", "shell:test", "shell:vcs", "shell:build", "shell:install", "shell:typecheck", "edit", "read", "read:search", "web", "mcp:github", "subagent", "skill:load", "skill:unload", "meta:compact", "approval", "error"])
  ok("taxonomy has " + k, seen.has(k));

// Gemini logs MCP tools as mcp_<server>_<tool>
eq("gemini mcp", toolKinds("mcp_agentglass_sessions", "").join(","), "mcp:agentglass");
// each adapter's file-writing tools are edits (T_EDIT): claude, codex, gemini, pi, OpenCode
for (const n of ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "write_file", "replace", "edit", "write", "patch"]) eq("edit tool " + n, toolKinds(n, "").join(","), "edit");
ok("T_EDIT lower case", T_EDIT.every((n: string) => n === n.toLowerCase()));

// counts, families, specific kinds, matching
const cm = kindsOf(all[0]);
eq("claude shell count", String(cm.get("shell") ?? 0), "4");
eq("claude error count", String(cm.get("error") ?? 0), "2");
eq("claude families", famsIn(cm).join(","), "prompt,reply,shell,edit,read,web,mcp,subagent,skill,error,approval");
eq("shell kinds", kindsOfFam(cm, "shell").join(","), "shell:test,shell:vcs");
eq("specific", specific(["error", "shell:test"]), "shell:test");
ok("family match", kindMatch(["shell:test", "error"], "shell"));
ok("no prefix match", !kindMatch(["mcp:github"], "mcp:git"));
ok("exact match", kindMatch(["mcp:github"], "mcp:github"));
ok("valid kinds", validKind("shell:test") && validKind("mcp:my-server.v2") && validKind("debug:probe") && validKind("user") && !validKind("shel") && !validKind("shell:"));
eq("evKinds on s.evs", kindSet(evKinds(all[0], 0)).join(","), "prompt");
eq("legacy map", String(LEGACY_EVENT.get("user") ?? []), "prompt");

// incremental: the array grows, only the new events are classified; a late failing result tags its call
const g: Sess = newSess("claude", "grow", "/k/grow.jsonl", false); g.size = 10;
parseEvents("claude", ca(1, tu("x1", "Bash", "{\"command\":\"npm test\"}")), g.evs, g);
eq("call alone", kindSet(kindIds(g, g.evs)[0] + 0).join(","), "shell:test");
parseEvents("claude", tr(2, "x1", "Exit code 1"), g.evs, g);
const gi = kindIds(g, g.evs);
eq("call after its failing result", kindSet(gi[0] + 0).join(","), "error,shell:test");
eq("the result", kindSet(gi[1] + 0).join(","), "error,shell:test");
eq("kindsIn on another array", String(kindsIn(g, g.evs).get("error") ?? 0), "2");

// ── filter keys over kinds ──
function x(s: Sess, i: number): EvX {
  const e = s.evs[i]; let call: Ev | null = null;
  if (e.kind === "result") for (let j = i - 1; j >= 0; j--) if (s.evs[j].kind === "tool" && s.evs[j].id === e.id) { call = s.evs[j]; break; }
  return evxOf(e, call, kindSet(kindIds(s, s.evs)[i] + 0));
}
function hits(expr: string, s: Sess): string {
  const p = parse(expr); if (p.err) return "parse: " + p.err.msg;
  const r = compile(p.cs, "events"); if (r.err || !r.f) return "err: " + (r.err ? r.err.msg : "");
  const f = r.f ?? EMPTY; const o: string[] = [];
  for (let i = 0; i < s.evs.length; i++) { let k = true; for (const q of f.ev) if (!q(s, x(s, i))) { k = false; break; } if (k) o.push(String(i)); }
  return o.join(",");
}
const c0 = all[0];
eq("event.kind is skill", hits("event.kind is skill", c0), "19,20,22");
eq("event.kind is_one_of mcp, error", hits("event.kind is_one_of mcp, error", c0), "3,4,15,16");
eq("mcp.server is github", hits("mcp.server is github", c0), "15,16");
eq("shell.family ~ test", hits("shell.family ~ test", c0), "3,4");
eq("event.kind is shell and shell.family ~ git", hits("event.kind is shell and shell.family ~ git", c0), "5,6");
eq("not reply:thinking", hits("not event.kind is reply:thinking", c0).split(",").length === c0.evs.length - 1 ? "ok" : hits("not event.kind is reply:thinking", c0), "ok");
eq("legacy event is user", hits("event is user", c0), "0");
eq("legacy event is tool", hits("event is tool", c0), "3,5,7,9,11,13,15,17,19,21");
eq("legacy event is assistant (no thinking)", hits("event is assistant", c0), "2,23");
eq("event.kind is reply (family)", hits("event.kind is reply", c0), "1,2,23");
eq("legacy event is meta (raw)", hits("event is meta", all[4]), "5,6,7");
eq("event.kind is meta (family)", hits("event.kind is meta", all[4]), "6");
eq("event.kind is prompt (family)", hits("event.kind is prompt", all[4]), "7");
eq("status is error per event", hits("status is error", c0), "3,4");
eq("unknown kind", hits("event.kind is shel", c0).startsWith("parse:") || hits("event.kind is shel", c0).startsWith("err:") ? "rejected" : "accepted", "rejected");
// contexts: Stats refuses event clauses with a hint; the old --watch predicates still see raw kinds
const st = compile(parse("event.kind is skill").cs, "stats"); ok("stats refuses event.kind", st.f === null && st.err !== null && st.err.msg.indexOf("event view") >= 0);
const w = compile(parse("event is user").cs, "watch").f ?? EMPTY; let wu = true; for (const p of w.event) if (!p(c0, "user", "", "")) wu = false;
ok("watch legacy pred", wu && w.event.length === 1);
const wt = compile(parse("event.kind is shell:test").cs, "watch").f ?? EMPTY; let wb = true; for (const p of wt.event) if (!p(c0, "tool", "Bash", "npm test")) wb = false;
ok("watch shim sees kinds of (tool, args)", wb);

// the session list lifts event clauses: only the session with a skill mark has a skill event
const lf = compile(parse("event.kind is skill").cs, "list").f ?? EMPTY;
eq("list lifts event.kind is skill", all.map((x: Sess) => matchSession(lf, x, null) ? x.h : "").filter((h: string) => h !== "").join(","), "claude");

// a failure the harness flags without saying so in the output text is an error too (the call rows count it as one)
function sessOfLines(h: string, lines: string[]): Sess {
  const s = newSess(h, h + "-err", "/k/" + h + "-err.jsonl", false); s.size = 100;
  for (const l of lines) parseEvents(h, l, s.evs, s);
  return s;
}
function errsOf(h: string, lines: string[]): string {
  const s = sessOfLines(h, lines); const ids = kindIds(s, s.evs); let o = "";
  for (let i = 0; i < s.evs.length; i++) o += kindSet(ids[i] + 0).indexOf("error") >= 0 ? "E" : "-";
  return o;
}
const isErrTr = (s: number, id: string, text: string): string => JSON.stringify({ type: "user", timestamp: iso(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] } });
eq("claude is_error without a marker", errsOf("claude", [ca(1, tu("e1", "Bash", "{\"command\":\"npm test\"}")), isErrTr(2, "e1", "Command timed out after 2m 0s")]), "EE");
eq("claude is_error on an mcp call", errsOf("claude", [ca(1, tu("e2", "mcp__github__get_issue", "{}")), isErrTr(2, "e2", "MCP error -32603: not found")]), "EE");
const ce = sessOfLines("claude", [ca(1, tu("e3", "Bash", "{\"command\":\"ls\"}")), isErrTr(2, "e3", "Exit code 2\nls: x: No such file")]);
eq("claude text marker kept as is", ce.evs.length > 1 ? ce.evs[1].text.slice(0, 11) : "", "Exit code 2");
const cxe = [cx(1, "{\"type\":\"function_call\",\"name\":\"exec\",\"arguments\":\"{}\",\"call_id\":\"x1\"}"), cx(2, "{\"type\":\"function_call_output\",\"call_id\":\"x1\",\"output\":\"Script failed: ReferenceError: y is not defined\"}"),
  cx(3, "{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{}\",\"call_id\":\"x2\"}"), cx(4, "{\"type\":\"function_call_output\",\"call_id\":\"x2\",\"output\":" + JSON.stringify("{\"output\":\"denied\",\"status\":\"rejected\"}") + "}"),
  cx(5, "{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{}\",\"call_id\":\"x3\"}"), cx(6, "{\"type\":\"function_call_output\",\"call_id\":\"x3\",\"output\":\"fine\"}")];
eq("codex script failure and rejection", errsOf("codex", cxe), "EEEE--");
const pde = "{\"type\":\"message\",\"timestamp\":\"" + iso(41) + "\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"q1\",\"toolName\":\"mcp\",\"content\":[{\"type\":\"text\",\"text\":\"boom\"}],\"details\":{\"error\":\"tool_error\"}}}";
eq("pi details.error without isError", errsOf("pi", [pc("q1", "mcp", "{\"tool\":\"x\"}"), pde]), "EE");
// Gemini names MCP tools mcp_<server>_<tool> (a server with "_" is ambiguous there); its displayName "<tool> (<server> MCP
// Server)" is not: the adapter names the call mcp__<server>__<tool> like every other harness
const gml = "{\"id\":\"m9\",\"timestamp\":\"" + iso(70) + "\",\"type\":\"gemini\",\"content\":\"\",\"model\":\"gemini-2.5-pro\",\"toolCalls\":[{\"id\":\"mcp_ag_glass_sessions__call_1\",\"name\":\"mcp_ag_glass_sessions\",\"args\":{\"limit\":5},\"result\":[],\"status\":\"success\",\"timestamp\":\"" + iso(71) + "\",\"displayName\":\"sessions (ag_glass MCP Server)\"}]}";
const gsv = sessOfLines("gemini", [gml]);
eq("gemini mcp tool name", gsv.evs.length ? gsv.evs[0].text.split("\u0000")[0] ?? "" : "", "mcp__ag_glass__sessions");
eq("gemini mcp server with an underscore", gsv.evs.length ? kindSet(kindIds(gsv, gsv.evs)[0] + 0).join(",") : "", "mcp:ag_glass");

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("event kinds: ok");
