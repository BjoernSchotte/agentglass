// agentglass — self-check for the Sessions preview's activity-line cache: scriptc build src/ui/list.check.ts -o lc && ./lc
// SPDX-License-Identifier: Apache-2.0
import { C } from "./theme.ts";
import { actLines } from "./list.ts";
import { newSess } from "../model/types.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

const s = newSess("claude", "a", "/tmp/a.jsonl", false);
s.evs = [{ kind: "tool", text: "Bash ls " + "x".repeat(90), ts: "2026-10-05T10:00:00Z", id: "t1", full: "" }];
const a = actLines(s, 60).join("\n");
ok("same inputs reuse the lines", actLines(s, 60).join("\n") === a, "changed");
// a theme may change any one color the lines use: the tool line's name is yellow
const y = C.yellow; C.yellow = "1;2;3";
const b = actLines(s, 60).join("\n");
ok("a changed yellow restyles the lines", b !== a && b.indexOf("1;2;3") >= 0, b);
C.yellow = y;
const p = C.purple; C.purple = "4;5;6"; actLines(s, 60); C.purple = p;
console.log(bad ? "list: " + bad + " failed" : "list: ok");
if (bad) process.exit(1);
