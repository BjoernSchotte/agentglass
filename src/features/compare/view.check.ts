// agentglass — self-check for the compare view: scriptc build src/features/compare/view.check.ts -o cvc && ./cvc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../../state.ts";
import { width, fitTail } from "../../util/text.ts";
import { onInput } from "../../input.ts";
import { titleOf } from "../../model/sessions.ts";
import { initPins } from "../query/scope.ts";
import { statsTabIndex, statsDrillTool } from "../usage/stats.ts";
import { localFor } from "../query/scope.ts";
import { print } from "../query/parse.ts";
import { groupOfSession } from "./metrics.ts";
import { CV, openCompare, compareLines, tableCols } from "./view.ts";
import { M, selectSession } from "./marks.ts";
import { useTriageCfg } from "../triage/run.ts";
import { T, selectRow as selectTriageRow, includeSel } from "../triage/view.ts";
import { cmpBase, cmpCleanup, sess } from "./fixture.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function has(ls: string[], s: string): boolean { return ls.some((l) => l.indexOf(s) >= 0); }
initPins({ load: () => "", save: (v: string) => {}, remember: false });

cmpBase(); openCompare(groupOfSession(sess("a1")), groupOfSession(sess("b1")), "Sessions", "");
const st = CV.st;
if (!st) { bad++; console.log("FAIL no compare state"); } else {
  eq("mode", S.mode + " " + S.fview, "view compare");
  const L1 = compareLines(st, 120, 40);
  eq("lines fill the view", String(L1.length), "38");
  eq("header", (L1[0] ?? "").indexOf("A: " + titleOf(sess("a1")) + "  ·  B: " + titleOf(sess("b1"))) >= 0 ? "ok" : L1[0] ?? "", "ok");
  eq("subagents incl.", has(L1, "subagents incl.") ? "ok" : "no", "ok");
  eq("ratio column wide", has(L1, "×2.0") ? "ok" : "no", "ok");
  eq("tabs", has(L1, "summary") && has(L1, "timeline") ? "ok" : "no", "ok");
  eq("tabs fit at 80", has(compareLines(st, 80, 24), " time ") ? "ok" : compareLines(st, 80, 24)[1] ?? "", "ok");
  // the status flags (counting, subagents, live, side) never squeeze the tabs: every tab stays on the line at 80 columns
  st.sec = 1; const L80 = compareLines(st, 80, 24); st.sec = 0;
  eq("all tabs at 80 with flags", /\bsum\b.*\btools\b.*\bprogs\b.*\bcmds\b.*\bfiles\b.*\bmodels\b.*\btime\b/.test(L80[1] ?? "") ? "ok" : L80[1] ?? "", "ok");
  eq("share headers whole at 80", !has(L80, "share…") && has(L80, "% A") ? "ok" : L80[3] ?? "", "ok");
  eq("flags still shown", has(L80, "subagents incl.") && has(L80, "↵ side B") ? "ok" : L80.slice(0, 3).join("\n"), "ok");
  // tables at 80 columns: names get the room (share gauges go first); paths keep their file name
  eq("names ≥ 24 at 80", String(tableCols(80, false).nw >= 24 && tableCols(80, true).nw >= 20), "true");
  eq("gauges when wide", String(tableCols(160, true).bw >= 8), "true");
  eq("path keeps the file name", fitTail("/tmp/agtest-session-compare-opencode/app.js", 20), "…are-opencode/app.js");
  eq("tool calls row", L1.some((l) => /tool calls\s+5\s+10\s+\+5\s+×2\.0/.test(l)) ? "ok" : L1.join("\n"), "ok");
  eq("no ratio < 100 cols", has(compareLines(st, 99, 40), "×2.0") ? "shown" : "dropped", "dropped");
  eq("no Δ < 80 cols", has(compareLines(st, 79, 40), "+5") ? "shown" : "dropped", "dropped");
  eq("80 columns fit", compareLines(st, 80, 24).every((l) => width(l) <= 80) ? "ok" : "too wide", "ok");
  eq("72 columns fit", compareLines(st, 72, 24).every((l) => width(l) <= 72) ? "ok" : compareLines(st, 72, 24).filter((l) => width(l) > 72).join("\n"), "ok");
  onInput("S"); eq("S toggles", String(st.subs), "false");
  eq("S recounts", has(compareLines(st, 120, 40), "subagents excl.") && compareLines(st, 120, 40).some((l) => /tool calls\s+5\s+8\b/.test(l)) ? "ok" : "no", "ok");
  onInput("S");
  onInput("x"); eq("x swaps", st.A.label, titleOf(sess("b1")));
  onInput("x");
  onInput("tab"); eq("tab → tools", String(st.sec), "1");
  const Lt = compareLines(st, 120, 40);
  eq("tools rows", has(Lt, "Bash") && has(Lt, "⧉ github") ? "ok" : Lt.join("\n"), "ok");
  eq("small samples banner", has(Lt, "small samples, no significance") ? "ok" : "no", "ok");
  for (let i = 0; i < 4; i++) onInput("down");
  onInput(" "); eq("␣ opens the server", st.open.has("mcp__github") ? "open" : "closed", "open");
  eq("kids listed", has(compareLines(st, 120, 40), "get_issue") ? "ok" : "no", "ok");
  onInput("down"); onInput("left"); eq("← on a tool folds its server", (st.open.has("mcp__github") ? "open" : "closed") + " sel " + String(st.sel), "closed sel 4");
  onInput("right"); eq("→ unfolds", st.open.has("mcp__github") ? "open" : "closed", "open");
  onInput("tab"); eq("tab → programs", has(compareLines(st, 120, 40), "npm") ? "ok" : "no", "ok");
  onInput("tab"); onInput("tab"); eq("tab → files", String(st.sec), "4");
  const Lf = compareLines(st, 120, 40);
  eq("file lists", has(Lf, "only in A (1)") && has(Lf, "src/a.ts") && has(Lf, "only in B (1)") && has(Lf, "in both (1)") ? "ok" : Lf.join("\n"), "ok");
  onInput("enter"); eq("enter on a missing file", S.toast.indexOf("not found:") === 0 ? "ok" : S.toast, "ok");
  onInput("tab"); eq("tab → models", has(compareLines(st, 120, 40), "claude-opus-4-5") ? "ok" : "no", "ok");
  onInput("tab"); eq("tab → timeline", has(compareLines(st, 120, 40), "since each session's start") ? "ok" : compareLines(st, 120, 40).join("\n"), "ok");
  onInput("tab"); eq("tab wraps", String(st.sec), "0");
  onInput("2"); eq("2 opens B's transcript", S.mode + " " + (S.tv ? S.tv.s.id : ""), "transcript b1");
  onInput("esc"); eq("esc returns to compare", S.mode + " " + S.fview, "view compare");
  onInput("tab"); onInput("]"); onInput("enter");
  eq("enter on a tool → Stats drill-down of B", String(S.tab) + " " + statsDrillTool() + " | " + print(localFor("Stats")), String(statsTabIndex()) + " Bash | session is claude:b1");
  S.mode = "view"; S.fview = "compare"; st.sec = 0;
  onInput("a"); eq("a edits group A", S.mode + " " + S.inputText, "input session is claude:a1");
  S.inputText = "tol is Bash"; onInput("enter"); eq("bad expression stays open", S.mode + " " + (S.inputErr.indexOf("did you mean tool") >= 0 ? "err" : S.inputErr), "input err");
  onInput("ctrl-u"); for (const ch of "harn") onInput(ch); onInput("tab"); onInput("tab"); eq("group: tab after a unique key goes on", S.inputText, "harness is ");
  onInput("ctrl-u"); for (const ch of "status is bogus") onInput(ch); eq("group: error column", String(S.inputErrCol), "10");
  S.inputText = "model ~ sonnet"; onInput("enter"); eq("expression group", S.mode + " " + print(st.A.cs) + " " + String(st.A.single === null), "view model ~ sonnet true");
  eq("sessions row with an expression", compareLines(st, 120, 40).some((l) => /sessions\s+1\s+1/.test(l)) ? "ok" : compareLines(st, 120, 40).join("\n"), "ok");
  eq("1 on a group", (() => { onInput("1"); return S.toast; })(), "group A is not a single session");
  onInput("b"); S.inputText = "harness is pi"; onInput("enter");
  eq("empty group named", has(compareLines(st, 120, 40), "group B matched nothing: harness is pi") ? "ok" : "no", "ok");
  onInput("esc"); eq("esc back", S.mode + String(S.tab), "list0");
}
// C from the list opens the view; A = B toasts instead
cmpBase(); S.mode = "list"; S.tab = 0; M.a = ""; M.b = "";
selectSession("b1"); onInput("C"); eq("C opens the view", S.mode + " " + S.fview, "view compare");
const st2 = CV.st; eq("C picked the previous run", st2 ? st2.A.label + " | " + (st2.note.indexOf("A: previous claude session in app") === 0 ? "note" : st2.note) : "", titleOf(sess("a1")) + " | note");
onInput("esc"); M.a = sess("a1").path; M.b = sess("a1").path; onInput("C"); eq("A = B toast", S.mode + " " + S.toast, "list A and B are the same");
M.a = ""; M.b = "";
S.tab = statsTabIndex(); onInput("C");
const st3 = CV.st; eq("Stats C: periods", st3 ? print(st3.A.cs) + " | " + print(st3.B.cs) + " | " + st3.origin : "", "day is yesterday | day is today | Stats");
onInput("esc"); eq("esc to Stats", S.mode + " " + String(S.tab === statsTabIndex()), "list true");
// t: triage A vs B, + edits group A, esc returns with the view's state
useTriageCfg({ longCall: "30s", expensiveUsd: 5, minSupport: 1, warn: "" });
cmpBase(); openCompare(groupOfSession(sess("a1")), groupOfSession(sess("b1")), "Sessions", "");
const cs0 = CV.st; if (cs0) { cs0.sec = 1; compareLines(cs0, 120, 40); }
onInput("t");
const ts = T.st;
eq("t opens triage A vs B", ts ? ts.run.base + " | " + print(ts.run.sel) + " | " + print(ts.run.group) : "none", "group | session is claude:a1 | session is claude:b1");
eq("entity call within retention", ts ? ts.run.entity + " " + String(ts.run.days) : "", "call 1");
eq("origin", ts ? ts.run.origin : "", "Compare");
selectTriageRow("tool", "Bash"); const msg = includeSel(false);
eq("include toast", msg, "group A: + tool is Bash");
onInput("esc"); eq("back in compare", S.fview + " " + S.mode, "compare view");
const cs = CV.st; eq("include edited group A", cs ? print(cs.A.cs) : "", "session is claude:a1 and tool is Bash");
eq("state kept (section)", cs ? String(cs.sec) : "", "1");
eq("header shows the expression", cs ? (compareLines(cs, 120, 40)[0] ?? "").indexOf("A: session is claude:a1 and tool is Bash") >= 0 ? "ok" : compareLines(cs, 120, 40)[0] ?? "" : "", "ok");
if (cs) { onInput("S"); onInput("t"); const t2 = T.st; eq("t without subagents", t2 ? print(t2.run.sel) + " | " + print(t2.run.group) : "", "session is claude:a1 and tool is Bash and subagent is false | session is claude:b1 and subagent is false"); onInput("esc"); }
cmpCleanup();
console.log(bad ? String(bad) + " failed" : "compare view: all checks passed");
if (bad) process.exit(1);
