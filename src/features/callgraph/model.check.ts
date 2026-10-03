// agentglass — self-check for the call-graph model: scriptc build src/features/callgraph/model.check.ts -o cgc && ./cgc
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { type Src, buildGraph, aggregate, summary, catOf, isErr, dur } from "./model.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const T = 1790000000000;
function at(s: number): string { return new Date(T + s * 1000).toISOString(); }
function ev(kind: string, text: string, s: number, id: string): Ev { return { kind, text, ts: s < 0 ? "" : at(s), id, full: "" }; }
function src(evs: Ev[], kind: string, spawn: string): Src { return { evs, live: false, kind, spawn }; }

// claude-ish: two parallel tools, one spawning a subagent (matched by toolUseId), one error
const root = [
  ev("user", "do it", 0, ""), ev("tool", "Bash\u0000ls", 1, "a"), ev("tool", "Agent\u0000explore", 1, "b"),
  ev("result", "ok", 3, "a"), ev("result", "done", 20, "b"), ev("tool", "Read\u0000/x", 21, "c"), ev("result", "<tool_use_error>nope", 22, "c"),
  ev("assistant", "fin", 25, ""),
];
const sub = [ev("user", "explore", 2, ""), ev("tool", "Grep\u0000foo", 4, "g"), ev("result", "hit", 10, "g"), ev("assistant", "found", 18, "")];
const g = buildGraph([src(root, "", ""), src(sub, "Explore", "b")], T + 99000);
const sp = g.spans;
eq("span count", String(sp.length), "6"); // turn, Bash, Agent, Read, Explore, Grep
eq("turn", sp[0].name + " " + dur(sp[0].t1 - sp[0].t0), "turn 1 25s");
eq("bash", String((sp[1].t1 - sp[1].t0) / 1000) + " d" + sp[1].depth, "2 d1");
eq("parallel lanes", String(sp[1].row !== sp[2].row), "true");
eq("error", String(sp[3].err), "1");
eq("agent host", sp[4].name + " p" + sp[4].parent + " d" + sp[4].depth, "Explore p2 d2");
eq("sub tool", sp[5].name + " p" + sp[5].parent + " d" + sp[5].depth + " " + (sp[5].t1 - sp[5].t0) / 1000, "Grep p4 d3 6");
const sm = summary(g);
eq("summary", dur(sm.wall) + " " + dur(sm.active) + " " + sm.turns + "/" + sm.tools + "/" + sm.agents + " " + sp[sm.longest].name, "25s 20s 1/4/1 Agent");
const ag = aggregate(g);
eq("agg roots", ag.map((a) => a.name + ":" + a.count).join(","), "Bash:1,Agent:1,Read:1,⑂ Explore:1");
const ex = ag[3];
eq("agg kids", ex.kids.map((a) => a.name + ":" + a.total / 1000).join(","), "Grep:6");
eq("agent self", String(ag[1].self / 1000), "3"); // Agent 1→20 minus Explore 2→18
// fx-ish: whole turn under one timestamp, duration only in the complete meta → tools spread, est
const fx = [ev("user", "go", 50, ""), ev("tool", "shell\u0000ls", 50, "x"), ev("result", "ok", 50, "x"), ev("tool", "shell\u0000pwd", 50, "y"), ev("result", "[failed] no", 50, "y"), ev("meta", "turn complete · 40.0s", 50, "")];
const f = buildGraph([src(fx, "", "")], T);
eq("fx turn", dur(f.spans[0].t1 - f.spans[0].t0), "40s");
eq("fx spread", String(f.spans[1].est) + " " + String(f.spans[2].t0 > f.spans[1].t0) + " " + f.spans[2].err, "true true 1");
// codex-ish: turn started → noise prompt skipped → tools; the next turn's prompt attaches to its start marker
const cx = [ev("meta", "turn started", 0, ""), ev("tool", "exec\u0000ls", 1, "e"), ev("result", '{"output":"x","metadata":{"exit_code":1}}', 2, "e"), ev("meta", "turn complete", 3, ""),
  ev("meta", "turn started", 10, ""), ev("user", "next", 10, ""), ev("tool", "exec\u0000pwd", 11, "f"), ev("result", "ok", 12, "f"), ev("meta", "turn complete", 13, "")];
const c = buildGraph([src(cx, "", "")], T);
eq("codex turns", c.spans.filter((s) => s.kind === 0).map((s) => s.name + ":" + s.arg + ":" + dur(s.t1 - s.t0)).join(","), "turn 1::3.0s,turn 2:next:3.0s");
eq("codex err", String(c.spans[1].err), "1");
// nothing timed at all
const nt = buildGraph([src([ev("user", "a", -1, ""), ev("tool", "x\u0000", -1, ""), ev("result", "r", -1, "")], "", "")], T);
eq("no timing", String(nt.noTiming) + " " + String(nt.t1 > nt.t0), "true true");
eq("cats", [catOf("Bash"), catOf("exec_command"), catOf("Edit"), catOf("apply_patch"), catOf("Grep"), catOf("WebSearch"), catOf("Task"), catOf("mcp__x__y"), catOf("TodoWrite")].join(""), "001123456");
// task notifications (⟲) and peer messages (⇄) are markers: no new turn, the agent's reaction stays in the open one
const nf = [ev("user", "do it", 0, ""), ev("tool", "Bash\u0000a", 1, "a"), ev("result", "ok", 2, "a"), ev("meta", "⟲ completed · x", 3, "b"), ev("tool", "Bash\u0000c", 4, "c"), ev("result", "ok", 5, "c"),
  ev("meta", "⇄ peer · hi", 6, ""), ev("tool", "Bash\u0000d", 7, "d"), ev("result", "ok", 8, "d"), ev("user", "next", 9, "")];
const ng = buildGraph([src(nf, "", "")], T);
eq("markers open no turn", String(summary(ng).turns), "2");
eq("markers: tools stay in turn 1", ng.spans.filter((s) => s.kind === 1).map((s) => s.arg + ":" + s.parent).join(","), "a:0,c:0,d:0");
eq("isErr", [isErr("Exit code: 2\nboom"), isErr("Exit code 127\nx"), isErr("Exit code: 0"), isErr('{"output":"x","metadata":{"exit_code":1}}'), isErr("fine")].join(","), "true,true,false,true,false");
console.log(bad ? bad + " FAILED" : "ok");
process.exit(bad ? 1 : 0);
