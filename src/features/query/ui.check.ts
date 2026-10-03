// agentglass — self-check for the filter input, keys, chips and pins in the TUI (no terminal): scriptc build src/features/query/ui.check.ts -o uc && ./uc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../../state.ts";
import { sessions, buildView } from "../../model/sessions.ts";
import { onInput } from "../../input.ts";
import { boxChips, emptyText } from "../../hooks.ts";
import { print } from "./parse.ts";
import { initPins, localFor, setLocal } from "./scope.ts";
import { complete, hiddenCount } from "./ui.ts";
import { fxBase } from "./fixture.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }
function ids(): string { const o: string[] = []; for (const s of S.view) if (s.depth === 0) o.push(s.id); return o.sort().join(","); }
function type(t: string): void { for (const ch of Array.from(t)) onInput(ch); }

fxBase(); let saved = "";
initPins({ load: () => "", save: (v: string) => { saved = v; }, remember: true }); buildView();
eq("all", ids(), "c1,k1,x1");
onInput("/"); eq("input open", S.mode + "/" + S.inputAction, "input/query");
type("harness is codex");
eq("live re-filter", ids(), "x1");
type(" and tool is");                                   // incomplete: needs a value
eq("prefix keeps last valid", ids(), "x1"); eq("inline error", S.inputErr, "tool is …: needs a value (column 27)");
onInput("enter"); eq("enter on invalid stays open", S.mode, "input");
onInput("esc"); eq("esc cancels to previous", print(localFor("Sessions")), ""); eq("all back", ids(), "c1,k1,x1"); eq("error cleared", S.inputErr, "");
onInput("/"); type("too"); eq("a key prefix is not a text search yet", ids(), "c1,k1,x1"); eq("no error for a key prefix", S.inputErr, "");
type("l is Bash"); onInput("enter");
eq("enter applies", print(localFor("Sessions")) + "|" + ids() + "|" + S.mode, "tool is Bash|c1|list");
eq("chips", plain(boxChips("sessions", 80)), "tool is Bash calls ≤ 90 d");
onInput("p");
eq("p pins all local", print(S.pins), "tool is Bash"); eq("local emptied", print(localFor("Sessions")), ""); eq("pin persisted", saved, "tool is Bash");
eq("pinned chip + hidden count", plain(boxChips("sessions", 80)), "⚲ tool is Bash · pins hide 2 calls ≤ 90 d");
eq("hidden count", String(hiddenCount("Sessions")), "2");
onInput("esc"); eq("esc keeps pins", print(S.pins), "tool is Bash");
onInput("h"); eq("h cycles local harness", print(localFor("Sessions")), "harness is claude");
onInput("h"); eq("h next", print(localFor("Sessions")), "harness is codex");
eq("empty list says why", plain(emptyText("sessions")), "no sessions match — 1 hidden by pins (P edits)");
onInput("h"); onInput("h"); onInput("h"); onInput("h"); onInput("h"); onInput("h"); eq("h wraps to all", print(localFor("Sessions")), "");
onInput("h"); onInput("l"); eq("l toggles live", print(localFor("Sessions")), "harness is claude and live is true");
onInput("l"); eq("l toggles back", print(localFor("Sessions")), "harness is claude");
// P edits the pins; empty + enter unpins
onInput("P"); eq("P opens pins", S.inputAction + "|" + S.inputText, "pins|tool is Bash");
onInput("ctrl-u"); type("tol is x"); onInput("enter"); eq("P invalid stays", S.mode + "|" + S.inputErr, "input|unknown key \"tol\" — did you mean tool?");
onInput("ctrl-u"); onInput("enter"); eq("P empty unpins", print(S.pins) + "|" + saved + "|" + S.mode, "||list");
// / prefilled with the tab's local filter; tab completion
setLocal("Sessions", []);
onInput("/"); type("stat"); onInput("tab"); eq("tab completes a key", S.inputText, "state ");
onInput("tab"); eq("tab again cycles", S.inputText, "status ");
onInput("ctrl-u"); type("status "); onInput("tab"); eq("tab completes an op", S.inputText, "status is ");
onInput("tab"); eq("tab again: next operator", S.inputText, "status is_not ");
onInput("ctrl-u"); type("status is "); onInput("tab"); eq("tab completes a value", S.inputText, "status is ok ");
onInput("esc");
eq("completion keys", complete("too", true).slice(0, 1).join(","), "tool");
eq("completion ops", complete("cost ", true).join(","), "is,is_not,>,>=,<,<=");
eq("completion enum", complete("status is ", true).join(","), "ok,error,unknown");
eq("completion is_one_of list", complete("harness is_one_of claude c", true).join(","), "codex");
eq("completion text values", complete("tool is B", true).join(","), "Bash");
// restored pins are announced
eq("start toast", initPins({ load: () => "repo is agentglass", save: (v: string) => {}, remember: true }), "pinned: repo is agentglass — P edits, P then enter on empty unpins");
buildView(); eq("restored pins filter", ids(), "c1");
eq("sessions in fixture", String(sessions.size), "4");
console.log(bad ? bad + " failed" : "filter ui: all checks passed");
if (bad) process.exit(1);
