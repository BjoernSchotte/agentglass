// agentglass — self-check for the JSON pull reader: scriptc build src/util/jsonscan.check.ts -o js && ./js
// SPDX-License-Identifier: Apache-2.0
import { cursor, eat, skip, num, str, nums, strs, numLists } from "./jsonscan.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
// strings round-trip exactly as JSON.parse reads them
const texts = ["plain", "", "quote \" back \\ slash /", "nl\nt\tr\rb\bf\f", "ümlaut ✓ 日本", "emoji 😀 pair", "ctl \u0001\u001f", "a\\nb"];
for (const t of texts) { const c = cursor(JSON.stringify(t)); const got = str(c); eq("string " + JSON.stringify(t), (c.ok ? "ok " : "bad ") + got, "ok " + t); }
const ue = cursor('"\\u00fc\\u2713\\ud83d\\ude00\\u0041"'); eq("\\u escapes + surrogate pair", str(ue), "ü✓😀A");
const sl = cursor('"\\/x"'); eq("escaped slash", str(sl), "/x");
eq("lone surrogate → U+FFFD", str(cursor('"\\ud800x"')), "�x");
for (const b of ['"open', '"bad \\q"', '"\\u12g4"', "x"]) { const c = cursor(b); str(c); eq("bad string " + b, String(c.ok), "false"); }
// numbers and arrays
const n = cursor(" [1, -2.5, 3e2 ,0] "); eq("nums", nums(n).join(",") + (n.ok ? "" : " bad"), "1,-2.5,300,0");
const e = cursor("[]"); eq("empty", String(nums(e).length) + String(e.ok), "0true");
const ll = cursor("[[1,2],[],[3]]"); eq("lists", JSON.stringify(numLists(ll)), "[[1,2],[],[3]]");
const ss = cursor('["a","b\\"c"]'); eq("strs", strs(ss).join("|"), 'a|b"c');
for (const b of ["[1,]", "[1 2]", '[1,"x"]', "[", "[-]"]) { const c = cursor(b); nums(c); eq("bad nums " + b, String(c.ok), "false"); }
eq("num", String(num(cursor("42"))), "42");
// skip any value, then go on
const o = cursor('{"x":{"a":[1,{"b":null}],"c":"}"},"y":true,"z":7}');
eat(o, 123); str(o); eat(o, 58); skip(o); eat(o, 44); str(o); eat(o, 58); skip(o); eat(o, 44); eq("after skips", str(o), "z"); eat(o, 58);
eq("skip then value", String(num(o)) + String(o.ok) + String(eat(o, 125)), "7truetrue");
console.log(bad ? bad + " failed" : "jsonscan: all checks passed");
if (bad) process.exit(1);
