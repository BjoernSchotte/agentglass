// agentglass — self-check for styled-text widths: scriptc build src/util/text.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import { width, vwidth, fillTo, fitStyled } from "./text.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const st = "\x1b[38;2;1;2;3m\x1b[1m5h 15%\x1b[0m \x1b[2m7d 71%\x1b[0m";
ok("escapes take no columns", vwidth(st) === 13, String(vwidth(st)));
ok("width() counts escape bodies (why vwidth exists)", width(st) > vwidth(st), String(width(st)));
ok("wide glyphs", vwidth("\x1b[1m≈$1 ✦ 日本\x1b[0m") === 10, String(vwidth("\x1b[1m≈$1 ✦ 日本\x1b[0m")));
ok("fillTo pads to the visible width", fillTo(st, 20).length === 7, String(fillTo(st, 20).length));
ok("fitStyled keeps escapes, cuts visible", vwidth(fitStyled(st, 4)) === 4, String(vwidth(fitStyled(st, 4))));
console.log(bad ? bad + " failed" : "text: all checks passed");
if (bad) process.exit(1);
