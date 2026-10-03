// agentglass — self-check for focus reporting tokens: scriptc build src/term.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import { tokens } from "./input.ts";
import { focusOf } from "./term.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }

const ts = tokens("a\x1b[I\x1b[<0;3;4M\x1b[Ob");
eq("tokens", JSON.stringify(ts), JSON.stringify(["a", "\x1b[I", "\x1b[<0;3;4M", "\x1b[O", "b"]));
eq("focus kinds", ts.map((t: string) => focusOf(t)).join(","), ",in,,out,");
eq("SS3 arrow is not focus", focusOf("\x1bOA"), "");
eq("plain I/O keys are not focus", focusOf("I") + focusOf("O"), "");

console.log(bad ? bad + " failed" : "term: all checks passed");
if (bad) process.exit(1);
