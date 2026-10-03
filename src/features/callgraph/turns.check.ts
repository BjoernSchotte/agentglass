// agentglass — self-check for turn segmentation: scriptc build src/features/callgraph/turns.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { type TurnCursor, newCursor, feed, closeQuiet, abortedBy } from "./turns.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ev(kind: string, text: string): Ev { return { kind, text, ts: "", id: "", full: "" }; }
function run(c: TurnCursor, evs: Ev[], top: boolean): string { const o: string[] = []; for (const e of evs) o.push(feed(c, e, top)); return o.join(" "); }

// codex: explicit start marker, the prompt follows and fills it; complete and aborted close
let c = newCursor();
eq("codex", run(c, [ev("meta", "turn started"), ev("user", "hi"), ev("tool", "shell\u0000ls"), ev("result", "a"), ev("meta", "turn complete"), ev("meta", "turn started"), ev("meta", "turn aborted")], true), "open none none none close open close");
eq("codex closedBy", c.closedBy + " n" + c.n + " open " + c.open, "aborted n2 open false");
eq("abortedBy", String(abortedBy(ev("meta", "turn aborted"))) + String(abortedBy(ev("meta", "turn complete"))), "truefalse");
// claude / gemini / pi: a prompt opens, the next prompt closes the previous turn
c = newCursor();
eq("claude", run(c, [ev("user", "a"), ev("tool", "Bash\u0000ls"), ev("result", "x"), ev("user", "b")], true), "open none none open");
eq("claude closedBy", c.closedBy + " n" + c.n, "next n2");
// fx: the complete marker carries the duration
c = newCursor();
eq("fx", run(c, [ev("user", "go"), ev("tool", "shell\u0000ls"), ev("result", "ok"), ev("meta", "turn complete · 40.0s")], true), "open none none close");
eq("fx closedBy", c.closedBy, "marker");
// opencode: idle markers "turn complete (failed)" close too
c = newCursor();
eq("opencode", run(c, [ev("user", "go"), ev("assistant", "x"), ev("meta", "turn complete (failed)"), ev("user", "again")], true), "open none close open");
// subagent prompts never open a turn
c = newCursor();
eq("subagent", run(c, [ev("user", "explore"), ev("tool", "Grep\u0000x")], false), "none none");
// events before any prompt (the prompt is outside the read window, or was never logged) open a turn of their own
c = newCursor();
eq("no prompt", run(c, [ev("assistant", "mid-turn"), ev("tool", "Read\u0000/x"), ev("user", "next")], true), "open none open");
eq("no prompt n", String(c.n), "2");
// meta noise outside a turn opens nothing
c = newCursor();
eq("meta outside", run(c, [ev("meta", "context compacted"), ev("meta", "turn complete")], true), "none none");
// continuation: a turn closed by quiet time, then a late result opens a new turn (never reopens the old one)
c = newCursor();
eq("continuation pre", run(c, [ev("user", "a"), ev("tool", "Bash\u0000sleep")], true), "open none");
closeQuiet(c);
eq("quiet", c.closedBy + " " + String(c.open), "quiet false");
eq("continuation", run(c, [ev("result", "late")], true), "open");
eq("continuation n/late", String(c.n) + " " + String(c.late), "2 true");
eq("prompt after continuation", run(c, [ev("user", "b")], true) + " " + String(c.late) + " " + c.closedBy, "open false next");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("turns: all checks passed");
