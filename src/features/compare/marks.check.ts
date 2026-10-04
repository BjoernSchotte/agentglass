// agentglass — self-check for compare marks and the C pair: scriptc build src/features/compare/marks.check.ts -o mk && ./mk
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H } from "../../hooks.ts";
import { titleOf } from "../../model/sessions.ts";
import { lastDays } from "../usage/record.ts";
import { print } from "../query/parse.ts";
import { fxSession, isoAt } from "../query/fixture.ts";
import { M, toggleMark, prevSession, pickPair, pickPairText, periodPair, selectSession } from "./marks.ts";
import { TMP, cmpBase, cmpCleanup, sess, prompt, call } from "./fixture.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function idOf(s: Sess | null): string { return s ? s.id : "none"; }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); }
const U = "{\"input_tokens\":10,\"output_tokens\":5}";

cmpBase();
const a0 = fxSession("claude", "a0", TMP + "/app", "", "claude-sonnet-4-5", [prompt(isoAt(0, 7, 0), "first try")].concat(call(isoAt(0, 7, 1), "m0", "claude-sonnet-4-5", U, "Bash", "a0c1", "{\"command\":\"ls\"}", 100, false)));
a0.mtime = Date.parse(isoAt(0, 7, 2)); a0.last = a0.mtime;
const c9 = fxSession("codex", "c9", TMP + "/app", "", "gpt-5", [
  "{\"timestamp\":" + JSON.stringify(isoAt(0, 10, 0)) + ",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}}"]);
c9.mtime = Date.parse(isoAt(0, 10, 1)); c9.last = c9.mtime;
// another claude session that started before b1 but in another repo: skipped by the previous pick
const z = fxSession("claude", "z9", "/elsewhere/other", "", "claude-sonnet-4-5", [prompt(isoAt(0, 10, 30), "unrelated")]);
z.mtime = Date.parse(isoAt(0, 10, 31)); z.last = z.mtime;

eq("previous pick", idOf(prevSession(sess("b1"))), "a1");      // a1 started 09:00 < b1 11:00; c9 is codex; z9 another repo; b1s a subagent
eq("previous of a1", idOf(prevSession(sess("a1"))), "a0");
eq("previous of the first", idOf(prevSession(sess("a0"))), "none");
eq("subagent never picked", idOf(prevSession(sess("b1"))) === "b1s" ? "picked" : "ok", "ok");
selectSession("b1"); const p = pickPair();
eq("no marks → previous", typeof p === "string" ? p : p.A.label + " vs " + p.B.label, titleOf(sess("a1")) + " vs " + titleOf(sess("b1")));
eq("note names the pick", typeof p === "string" ? "" : p.note.indexOf("A: previous claude session in app · " + titleOf(sess("a1")) + " · today 09:00") === 0 ? "ok" : p.note, "ok");
eq("mark A", toggleMark(sess("a0")), "A: " + titleOf(sess("a0")));
eq("mark B", toggleMark(sess("b1")), "B: " + titleOf(sess("b1")));
selectSession("c9"); const p2 = pickPair();
eq("two marks", typeof p2 === "string" ? p2 : p2.A.label + " vs " + p2.B.label + " | " + p2.note, titleOf(sess("a0")) + " vs " + titleOf(sess("b1")) + " | ");
eq("third replaces B", toggleMark(sess("c9")), "B: " + titleOf(sess("c9")));
eq("prefix", plain(H.rowPrefix.map((f) => f(sess("a0"))).join("")), "A ");
eq("prefix B", plain(H.rowPrefix.map((f) => f(sess("c9"))).join("")), "B ");
eq("no prefix", plain(H.rowPrefix.map((f) => f(sess("a1"))).join("")), "");
eq("unmark", toggleMark(sess("c9")), "unmarked");
selectSession("b1"); const p3 = pickPair();
eq("one mark → mark vs selected", typeof p3 === "string" ? p3 : p3.A.label + " vs " + p3.B.label, titleOf(sess("a0")) + " vs " + titleOf(sess("b1")));
selectSession("a0"); eq("A = B", pickPairText(), "mark a second session with m");
M.a = sess("a0").path; M.b = sess("a0").path; eq("A = B guard", pickPairText(), "A and B are the same");
selectSession("a0"); M.a = ""; M.b = ""; eq("none earlier", pickPairText(), "no earlier claude session in app — mark two with m");
M.a = "/gone/path.jsonl"; selectSession("b1"); eq("a gone mark drops", pickPairText() + " " + M.a, "view ");
const pp = periodPair(lastDays(7)); eq("period pair", print(pp.A.cs) + " | " + print(pp.B.cs), "day >= -13d and day < -6d | day >= -6d");
const pd = periodPair(lastDays(1)); eq("period pair today", print(pd.A.cs) + " | " + print(pd.B.cs) + " | " + pd.note, "day is yesterday | day is today | yesterday vs today");
eq("m key", (() => { S.mode = "list"; S.tab = 0; selectSession("a1"); for (const f of H.keys) if (f("list", "m")) break; return M.a === sess("a1").path ? "marked" : "no"; })(), "marked");
cmpCleanup();
console.log(bad ? String(bad) + " failed" : "compare marks: all checks passed");
if (bad) process.exit(1);
