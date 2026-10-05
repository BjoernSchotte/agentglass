// agentglass — self-check for the row-wise frame diff: scriptc build src/ui/frame.check.ts -o fc && ./fc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { flushRows, flushPart, resetFrame } from "./frame.ts";
import { put, clearBuf, bufRows, spin } from "./screen.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function has(what: string, hay: string, needle: string, yes: boolean): void { if ((hay.indexOf(needle) >= 0) !== yes) { bad++; console.log("FAIL " + what + ": " + JSON.stringify(hay)); } }
let out = "";
const w = (s: string): void => { out += s; };
function frame(n: number, row3: string): string[] { const r: string[] = []; for (let y = 0; y < n; y++) r.push(y === 3 ? row3 : "row" + String(y)); return r; }

eq("first frame: every row", String(flushRows(frame(6, "a"), w)), "6");
has("synchronized update", out, "\x1b[?2026h", true);
out = ""; eq("row 3 changed: one row", String(flushRows(frame(6, "b"), w)), "1");
has("row 3 addressed", out, "\x1b[4;1Hb", true); has("row 2 not written", out, "row2", false);
out = ""; eq("identical: nothing", String(flushRows(frame(6, "b"), w)), "0"); eq("no output", out, "");
resetFrame(); out = ""; eq("after resetFrame (focus-in): every row", String(flushRows(frame(6, "b"), w)), "6");
out = ""; eq("another row count (resize): every row", String(flushRows(frame(7, "b"), w)), "7");
S.repaint = true; out = ""; eq("repaint (screen cleared): every row", String(flushRows(frame(7, "b"), w)), "7");
eq("repaint consumed", S.repaint ? "yes" : "no", "no");
// a partial write (the header row alone, marquee) updates what the next full frame compares against
const top: string[] = []; for (let y = 0; y < 7; y++) top.push(y === 0 ? "head2" : "");
out = ""; eq("partial: the header row", String(flushPart(top, w)), "1"); has("header written", out, "\x1b[1;1Hhead2", true);
const next = frame(7, "b"); next[0] = "head2";
out = ""; eq("full frame after it: nothing new", String(flushRows(next, w)), "0");
next[0] = "row0"; out = ""; eq("header back: that row", String(flushRows(next, w)), "1");
// a partial write before any full frame: the next full frame writes every row
resetFrame(); flushPart(top, w); out = ""; eq("partial on an unknown screen, then all rows", String(flushRows(next, w)), "7");
// rows from the put buffer: each row holds its puts in order, other rows stay empty
S.H = 5; clearBuf(); put(0, 1, "x"); put(4, 1, "y"); put(2, 3, "z"); put(0, 9, "off screen");
const rs = bufRows();
eq("rows", String(rs.length), "5"); eq("row 1", rs[1] ?? "", "\x1b[2;1Hx\x1b[2;5Hy"); eq("row 3", rs[3] ?? "", "\x1b[4;3Hz"); eq("row 0 empty", rs[0] ?? "", "");
S.animating = false; spin();
eq("spin marks animating", String(S.animating), "true");
eq("dirty defaults true", String(S.dirty), "true");

console.log(bad ? bad + " failed" : "frame: all checks passed");
if (bad) process.exit(1);
