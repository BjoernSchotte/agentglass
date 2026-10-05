// agentglass — triage view: scriptc build src/features/triage/view.check.ts -o tvc && ./tvc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../../state.ts";
import { width } from "../../util/text.ts";
import { H } from "../../hooks.ts";
import { onInput } from "../../input.ts";
import { parse, print, printClause } from "../query/parse.ts";
import type { Clause } from "../query/types.ts";
import { initPins, localFor, setLocal } from "../query/scope.ts";
import { fxBase } from "../query/fixture.ts";
import { statsDrill, statsTabIndex } from "../usage/stats.ts";
import { newRun, useTriageCfg } from "./run.ts";
import { T, openTriage, viewLines, includeSel, selectRow, onInclude, multiDims } from "./view.ts";
import { score } from "./score.ts";
let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
let saved = "";
initPins({ load: () => "", save: (v: string) => { saved = v; }, remember: true });
useTriageCfg({ longCall: "30s", expensiveUsd: 5, minSupport: 1, warn: "" }); // the fixture is tiny: every value counts

// ── render and navigation ──
fxBase();
openTriage(newRun("Stats", "call", [], parse("status is error").cs, 2), () => { S.mode = "list"; });
const st = T.st;
if (!st) { bad++; console.log("FAIL no triage state"); } else {
  eq("mode", S.mode + " " + S.fview, "view triage");
  const L0 = viewLines(st, 120, 30);
  eq("lines fill the view", String(L0.length), "28");
  eq("header", (L0[0] ?? "").indexOf("triage · status is error (3) vs rest (7)") >= 0 ? "ok" : L0[0] ?? "", "ok");
  eq("column header", (L0[1] ?? "").indexOf("χ²") >= 0 && (L0[1] ?? "").indexOf("attribute") >= 0 ? "ok" : L0[1] ?? "", "ok");
  eq("small sample banner", L0.some((l) => l.indexOf("small sample: 3 rows, percentages are unreliable") >= 0) ? "ok" : "no", "ok");
  eq("a row", L0.some((l) => /harness\s+codex/.test(l)) ? "ok" : L0.join("\n"), "ok");
  onInput("b"); eq("b cycles", st.run.base, "previous");
  onInput("b"); eq("b skips group without group", st.run.base, "rest");
  onInput("u"); eq("u flips", String(st.run.under), "true");
  onInput("c"); eq("c call weights", st.run.weight, "duration");
  const Lw = viewLines(st, 120, 30); eq("weighted header", (Lw[1] ?? "").indexOf("weighted, no significance") >= 0 ? "ok" : Lw[1] ?? "", "ok");
  onInput("m"); eq("m = 30 days", String(st.run.days), "30");
  onInput("s"); eq("s opens the picker", String(st.picker), "true");
  eq("picker lists presets", viewLines(st, 120, 30).some((l) => l.indexOf("failing sessions") >= 0) ? "ok" : "no", "ok");
  onInput("1"); eq("preset 1", print(st.run.sel) + "/" + String(st.run.slow), "status is error/false");
  onInput("s"); onInput("2"); eq("preset 2 = slow", String(st.run.slow) + " " + st.run.entity, "true call");
  onInput("e"); eq("slow keeps calls", st.run.entity, "call");
  onInput("s"); onInput("4"); eq("preset 4 = sessions", st.run.entity + " | " + print(st.run.sel), "session | cost > 5");
  onInput("c"); eq("c session weights", st.run.weight, "cost");
  onInput("e"); eq("e back to calls resets the weight", st.run.entity + " " + st.run.weight, "call count");
  onInput("s"); onInput("1"); onInput("d");
  eq("narrow drops chi2", String((viewLines(st, 90, 30)[1] ?? "").indexOf("χ²")), "-1");
  eq("80 columns fit", viewLines(st, 80, 24).every((l) => width(l) <= 80) ? "ok" : "too wide", "ok");
  // banners (the multi-valued note is ~80 wide on session rows) are cut to the width like every other line
  onInput("e"); const Ls = viewLines(st, 72, 24);
  eq("errored calls on session rows say what they count", (Ls[0] ?? "").indexOf("triage · status is error (") >= 0 ? "ok" : Ls[0] ?? "", "ok");
  onInput("e");
  eq("72 columns fit (sessions)", Ls.every((l) => width(l) <= 72) ? "ok" : Ls.filter((l) => width(l) > 72).join("\n"), "ok");
  eq("80 columns fit (sessions)", Ls.every((l) => width(l) <= 80) ? "ok" : Ls.filter((l) => width(l) > 80).join("\n"), "ok");
  onInput("w"); onInput("u");
  // enter expands, enter again lists the newest calls, esc leaves them
  selectRow("tool", "Bash"); onInput("enter"); eq("expand", st.expand, "tool");
  onInput("enter"); eq("calls listed", st.calls, "tool\tBash");
  eq("calls lines", viewLines(st, 120, 30).some((l) => l.indexOf("newest calls · tool is Bash") >= 0) ? "ok" : "no", "ok");
  onInput("esc"); eq("esc closes calls", st.calls + "|" + S.mode, "|view");
  onInput("esc"); eq("esc leaves", S.mode === "view" ? "still view" : "left", "left");
}

// ── a preset narrows the origin's local filter (AND) instead of replacing it, and says so ──
fxBase(); setLocal("Stats", parse("harness is codex").cs);
openTriage(newRun("Stats", "call", [], localFor("Stats"), 2), () => { S.mode = "list"; });
const sp = T.st;
if (sp) {
  S.toast = ""; onInput("s"); onInput("1");
  eq("preset 1 narrows the Stats filter", print(sp.run.sel), "harness is codex and status is error");
  eq("narrowing toast", S.toast, "preset errored calls narrows the Stats filter: harness is codex and status is error");
  onInput("s"); onInput("4"); eq("preset 4 narrows too (the previous preset is replaced)", print(sp.run.sel), "harness is codex and cost > 5");
  onInput("s"); onInput("6"); eq("preset 6 keeps the filter as the selection", print(sp.run.sel) + " " + sp.run.base, "harness is codex previous");
  onInput("esc");
}
setLocal("Stats", []);
// a filter already in the scope (Stats drill-down: the scope is pins ∧ local) is not repeated in the selection
openTriage(newRun("Stats", "call", parse("harness is codex").cs, parse("tool is Bash").cs, 2), () => { S.mode = "list"; });
setLocal("Stats", parse("harness is codex").cs);
const sd = T.st; if (sd) { onInput("s"); onInput("1"); eq("scope clause not repeated", print(sd.run.sel), "status is error"); onInput("esc"); }
setLocal("Stats", []);
// the multi-valued note names only dimensions that have a row on screen
eq("multi note: dims with rows", multiDims("call", ["program", "file", "ext", "tool"], [{ attr: "program", value: "npm", s: score(3, 10, 1, 10) }, { attr: "tool", value: "Bash", s: score(3, 10, 1, 10) }]).join(","), "program");
eq("multi note: none", multiDims("session", ["model", "tool"], []).join(","), "");

// ── + / − into the origin, p pins, o opens, r / R guards ──
fxBase(); setLocal("Sessions", []);
openTriage(newRun("Sessions", "call", [], parse("status is error").cs, 2), () => { S.mode = "list"; S.tab = 0; });
eq("select codex", String(selectRow("harness", "codex")), "true");
eq("include toast", includeSel(false), "Sessions filter: + harness is codex");
onInput("esc"); eq("include persists in origin", print(localFor("Sessions")), "harness is codex");
eq("triage scope narrowed", T.st ? print(T.st.run.scope) : "none", "harness is codex");
// merge rule on a second include: is_not replaces is
openTriage(newRun("Sessions", "call", [], parse("status is error").cs, 2), () => {});
selectRow("harness", "codex"); includeSel(true);
eq("exclude replaces is", print(localFor("Sessions")), "harness is_not codex");
// a pinned set: + and − narrow it, in the run and in the tab (pins ∘ local), never widen it
initPins({ load: () => "harness is_one_of claude codex", save: (v: string) => { saved = v; }, remember: true }); setLocal("Sessions", []);
openTriage(newRun("Sessions", "call", S.pins.slice(), parse("status is error").cs, 2), () => {});
selectRow("harness", "codex"); includeSel(false);
eq("+ on a pinned set narrows the run", T.st ? print(T.st.run.scope) : "", "harness is codex");
eq("+ on a pinned set: the tab", print(localFor("Sessions")), "harness is codex");
setLocal("Sessions", []); openTriage(newRun("Sessions", "call", S.pins.slice(), parse("status is error").cs, 2), () => {});
selectRow("harness", "codex"); includeSel(true);
eq("− on a pinned set narrows the run", T.st ? print(T.st.run.scope) : "", "harness is claude");
// a local set: + narrows it (the row is one of its values), it does not merge into the same set
initPins({ load: () => "", save: (v: string) => { saved = v; }, remember: true }); setLocal("Sessions", parse("harness is_one_of claude codex").cs);
openTriage(newRun("Sessions", "call", [], parse("status is error").cs, 2), () => {});
selectRow("harness", "codex");
eq("+ on a local set: toast", includeSel(false), "Sessions filter: + harness is codex (narrowed: harness is codex)");
eq("+ on a local set narrows the tab", print(localFor("Sessions")), "harness is codex");
setLocal("Sessions", parse("harness is_not codex").cs);
// a non-tab origin receives the clause through onInclude; the tabs' filters stay as they are
let got = "";
onInclude("Compare", (c: Clause): string => { got = printClause(c); return "group A: + " + printClause(c); });
openTriage(newRun("Compare", "call", [], parse("status is error").cs, 2), () => {});
selectRow("harness", "codex");
eq("onInclude toast", includeSel(false), "group A: + harness is codex");
eq("onInclude clause", got + " | " + print(localFor("Sessions")), "harness is codex | harness is_not codex");
// p: pins the value
openTriage(newRun("Stats", "call", [], parse("status is error").cs, 2), () => {});
selectRow("tool", "Grep"); onInput("p");
eq("p pins", print(S.pins) + " | " + saved, "tool is Grep | tool is Grep");
eq("p narrows the run", T.st ? print(T.st.run.scope) : "", "tool is Grep");
setLocal("Stats", []);
// guards: r drops for this triage only, R for real
initPins({ load: () => "status is error", save: (v: string) => { saved = v; }, remember: true });
openTriage(newRun("Stats", "call", S.pins.slice(), parse("status is error").cs, 2), () => {});
const g0 = T.st && T.st.res === null ? viewLines(T.st, 120, 30) : [];
eq("guard text", g0.some((l) => l.indexOf("Baseline is empty: the filter `status is error` already selects only these. r removes it for this triage") >= 0) ? "ok" : g0.join("\n"), "ok");
onInput("r"); const g1 = T.st ? viewLines(T.st, 120, 30) : []; const r1 = T.st && T.st.res ? T.st.res.guard : "x";
eq("r local", print(S.pins) + " | " + r1, "status is error | ");
eq("dropped shown", (g1[0] ?? "").indexOf("dropped: status is error") >= 0 ? "ok" : g1[0] ?? "", "ok");
onInput("R"); eq("R real", print(S.pins) + " | " + saved, " | ");
// o: Sessions filtered to the selection and the value
openTriage(newRun("Stats", "call", [], parse("status is error").cs, 2), () => {});
selectRow("tool", "Bash"); onInput("o");
eq("o opens Sessions", String(S.tab) + " " + S.mode + " " + print(localFor("Sessions")), "0 list harness is_not codex and status is error and tool is Bash");

// the typed selection (s, 7): tab after a unique completion goes on, a parse error marks its column
openTriage(newRun("Stats", "call", [], parse("status is error").cs, 2), () => {});
onInput("s"); onInput("7"); eq("7 asks", S.mode + " " + S.inputAction, "input triage");
onInput("ctrl-u"); for (const ch of "harn") onInput(ch); onInput("tab"); onInput("tab"); eq("selection: tab after a unique key goes on", S.inputText, "harness is ");
onInput("ctrl-u"); for (const ch of "status is bogus") onInput(ch); eq("selection: error column", String(S.inputErrCol), "10");
onInput("esc"); onInput("esc");

// ── t: entry points ──
fxBase(); initPins({ load: () => "repo is agentglass", save: (v: string) => {}, remember: true });
setLocal("Sessions", parse("cost > 0").cs); S.tab = 0; S.mode = "list";
onInput("t");
const t1 = T.st;
eq("from Sessions", t1 ? t1.run.entity + " | " + print(t1.run.scope) + " | " + print(t1.run.sel) + " | " + String(t1.run.days) : "none", "session | repo is agentglass | cost > 0 | 7");
onInput("esc"); eq("esc back to Sessions", S.mode + String(S.tab), "list0");
setLocal("Sessions", []); onInput("t"); eq("no local → picker", String(T.st ? T.st.picker : false), "true");
eq("picker esc without a selection leaves", (onInput("esc"), S.mode + String(S.tab)), "list0");
setLocal("Sessions", parse("repo is other").cs); onInput("t");
eq("a local equality overrides the pin on its key", T.st ? print(T.st.run.scope) + " | " + print(T.st.run.sel) : "", " | repo is other");
onInput("esc");
// Stats tab and its drill-down
S.tab = statsTabIndex(); S.mode = "list"; setLocal("Stats", parse("harness is claude").cs);
onInput("t");
eq("from Stats", T.st ? T.st.run.entity + " | " + print(T.st.run.scope) + " | " + print(T.st.run.sel) : "none", "call | repo is agentglass | harness is claude");
onInput("esc");
statsDrill("Bash", [], false); onInput("t");
eq("from the drill-down", T.st ? T.st.run.entity + " | " + print(T.st.run.sel) + " | " + print(T.st.run.scope) + " | " + String(T.st.run.days) : "none", "call | tool is Bash and status is error | repo is agentglass | 1");
onInput("esc"); eq("esc keeps the drill-down", S.mode + " " + String(S.tab === statsTabIndex()), "list true");
eq("footer hint", JSON.stringify(H.footerHints.map((f) => f("list")).filter((h) => h.length && h[0][0] === "t")), "[[[\"t\",\"triage\"]]]");
console.log(bad ? bad + " failed" : "triage view: all checks passed");
if (bad) process.exit(1);
