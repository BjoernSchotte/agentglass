// agentglass — self-check for the frame diff: scriptc build src/ui/frame.check.ts -o fc && ./fc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { flush, resetFrame } from "./frame.ts";
import { spin } from "./screen.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
let n = 0; let out = "";
const w = (s: string): void => { n++; out = s; };

eq("first frame written", String(flush("A", w)) + " " + String(n), "true 1");
eq("same frame skipped", String(flush("A", w)) + " " + String(n), "false 1");
eq("changed frame written", String(flush("B", w)) + " " + String(n) + " " + out, "true 2 B");
S.repaint = true; // the screen was cleared (resize): an identical frame must still be written
eq("repaint writes identical", String(flush("B", w)) + " " + String(n) + " " + String(S.repaint), "true 3 false");
eq("after repaint skipped again", String(flush("B", w)), "false");
resetFrame();
eq("reset writes", String(flush("B", w)) + " " + String(n), "true 4");
S.animating = false; spin();
eq("spin marks animating", String(S.animating), "true");
eq("dirty defaults true", String(S.dirty), "true");

console.log(bad ? bad + " failed" : "frame: all checks passed");
if (bad) process.exit(1);
