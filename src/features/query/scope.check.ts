// agentglass — self-check for filter scopes, pins and merge rules: scriptc build src/features/query/scope.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../../state.ts";
import type { Clause } from "./types.ts";
import { parse, print } from "./parse.ts";
import { type PinStore, addClause, includeClause, addAll, effective, initPins, setPins, pinAll, setLocal, localFor, hiddenByPins, onScopeChange } from "./scope.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function P(s: string): Clause[] { return parse(s).cs; }
function one(s: string): Clause { const cs = P(s); return cs[0]; }
const T = (cs: Clause[]): string => print(cs);

// same-key merge (spec §6.2)
let r = addClause(P("tool is Bash"), one("tool is Edit")); eq("is+is", T(r.cs), "tool is_one_of Bash Edit"); eq("is+is toast", r.note, "merged: tool is_one_of Bash Edit");
r = addClause(P("tool is_one_of Bash Edit"), one("tool is Read")); eq("is+one_of", T(r.cs), "tool is_one_of Bash Edit Read");
r = addClause(P("tool is_one_of Bash Edit"), one("tool is_one_of Edit Grep")); eq("one_of+one_of union", T(r.cs), "tool is_one_of Bash Edit Grep");
r = addClause(P("tool is_not Bash"), one("tool is_not Edit")); eq("not+not", T(r.cs), "tool is_not_one_of Bash Edit"); eq("not+not toast", r.note, "merged: tool is_not_one_of Bash Edit");
r = addClause(P("tool is Bash"), one("tool is_not Bash")); eq("is vs is_not same value", T(r.cs), "tool is_not Bash"); eq("replace toast", r.note, "replaced: tool is_not Bash");
r = addClause(P("tool is_not Bash"), one("tool is Bash")); eq("is_not vs is same value", T(r.cs), "tool is Bash");
r = addClause(P("harness is_one_of pi opencode gemini"), one("harness is_not gemini")); eq("one_of minus is_not narrows", T(r.cs), "harness is_one_of pi opencode"); eq("narrow toast", r.note, "narrowed: harness is_one_of pi opencode");
r = addClause(P("harness is_one_of pi gemini"), one("harness is_not_one_of gemini pi")); eq("one_of minus all of it: newer replaces", T(r.cs), "harness is_not_one_of gemini pi");
r = addClause(P("harness is_one_of pi gemini"), one("harness is_not Gemini")); eq("narrow ignores case", T(r.cs), "harness is pi");
r = includeClause(P("harness is_one_of pi opencode gemini"), one("harness is Gemini")); eq("include narrows a set", T(r.cs), "harness is gemini"); eq("include toast", r.note, "narrowed: harness is gemini");
r = includeClause(P("harness is_one_of pi opencode"), one("harness is codex")); eq("include outside the set: merge rules", T(r.cs), "harness is_one_of pi opencode codex");
r = includeClause(P("harness is_not pi"), one("harness is_not opencode")); eq("include exclude: merge rules", T(r.cs), "harness is_not_one_of pi opencode");
r = addClause(P("tool is Bash"), one("tool is_not Edit")); eq("is vs is_not other value: AND", T(r.cs), "tool is Bash and tool is_not Edit");
r = addClause(P("cost > 2"), one("cost > 5")); eq("same direction", T(r.cs), "cost > 5"); eq("same dir toast", r.note, "replaced: cost > 5");
r = addClause(P("cost > 2"), one("cost >= 1")); eq("same direction >=", T(r.cs), "cost >= 1");
r = addClause(P("cost > 2"), one("cost < 10")); eq("opposite directions AND", T(r.cs), "cost > 2 and cost < 10"); eq("no toast", r.note, "");
r = addClause(P("model ~ opus"), one("model ~ 4")); eq("~ AND", T(r.cs), "model ~ opus and model ~ 4");
r = addClause(P("tool is Bash"), one("tool is Bash")); eq("duplicate", T(r.cs), "tool is Bash"); eq("duplicate no toast", r.note, "");
r = addClause(P("live is true"), one("live is false")); eq("bool replaces", T(r.cs), "live is false");
r = addClause(P("harness is pi"), one("harness is codex")); eq("enum union", T(r.cs), "harness is_one_of pi codex");
r = addClause(P("foo"), one("bar")); eq("text terms AND", T(r.cs), "text ~ foo and text ~ bar");
const aa = addAll(P("tool is Bash and cost > 2"), P("tool is Edit and cost > 3")); eq("addAll", T(aa.cs), "tool is_one_of Bash Edit and cost > 3"); eq("addAll notes", aa.notes.join(" | "), "merged: tool is_one_of Bash Edit | replaced: cost > 3");
// pins ∘ local (§6.3)
const e = effective(P("harness is pi and repo is agentglass"), P("harness is codex and cost > 2"));
eq("local eq overrides pinned eq", T(e.cs), "repo is agentglass and harness is codex and cost > 2"); eq("struck", T(e.struck), "harness is pi");
const e2 = effective(P("cost > 2"), P("cost < 10")); eq("ranges AND across scopes", T(e2.cs), "cost > 2 and cost < 10");
const e3 = effective(P("model ~ opus"), P("model ~ 4")); eq("~ AND across scopes", T(e3.cs) + "/" + String(e3.struck.length), "model ~ opus and model ~ 4/0");
// persistence
let saved = "repo is agentglass and harness is pi"; let calls = 0;
onScopeChange(() => { calls++; });
const st: PinStore = { load: () => saved, save: (v: string) => { saved = v; }, remember: true };
eq("restored pins announced", initPins(st), "pinned: repo is agentglass · harness is pi — P edits, P then enter on empty unpins");
eq("restored", T(S.pins), "repo is agentglass and harness is pi");
eq("restored are pinned", String(S.pins.every((c: Clause) => c.pinned)), "true");
eq("listeners told", String(calls > 0), "true");
setPins(""); eq("unpin persists", saved, "");
eq("setPins error", setPins("tol is x") ? "err" : "ok", "err");
// p: all local clauses into the pins, local emptied
setLocal("Sessions", P("tool is Bash and cost > 2"));
eq("pinAll toast", pinAll("Sessions"), "pinned: tool is Bash · cost > 2 — P edits pins");
eq("pinAll pins", T(S.pins), "tool is Bash and cost > 2"); eq("pinAll local empty", T(localFor("Sessions")), ""); eq("pinAll persisted", saved, "tool is Bash and cost > 2");
setLocal("Sessions", P("tool is Edit")); eq("pinAll merges", pinAll("Sessions"), "pinned: tool is_one_of Bash Edit · cost > 2 (merged: tool is_one_of Bash Edit) — P edits pins");
eq("pinAll empty", pinAll("Sessions"), "nothing to pin — / adds a filter, p pins it");
// hidden count: sessions the pins alone exclude
eq("hiddenByPins", String(hiddenByPins("Sessions", (cs: Clause[]) => 10 - cs.length * 3)), "6");
const st2: PinStore = { load: () => "repo is x", save: (v: string) => { saved = "SHOULD NOT"; }, remember: false };
eq("remember false ignores saved", initPins(st2), ""); eq("remember false no pins", T(S.pins), "");
setPins("tool is Bash"); eq("remember false never saves", saved === "SHOULD NOT" ? "saved" : "ok", "ok");
eq("no pins hide nothing", String(initPins(st2) === "" && hiddenByPins("Sessions", (cs: Clause[]) => 5) === 0), "true");
const st3: PinStore = { load: () => "tol is x", save: (v: string) => {}, remember: true };
eq("unparsable dropped", initPins(st3), "saved pinned filter dropped: unknown key \"tol\" — did you mean tool?"); eq("unparsable: no pins", T(S.pins), "");
console.log(bad ? bad + " failed" : "filter scopes: all checks passed");
if (bad) process.exit(1);
