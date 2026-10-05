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
// every BMP code point class and astral ones, as JSON.stringify writes them, read like JSON.parse reads them
let all = ""; for (let cp = 0; cp < 0x3000; cp += 7) if (cp < 0xd800 || cp > 0xdfff) all += String.fromCharCode(cp);
all += "\u{1F600}\u{10FFFF}\u{1D11E}\u00e9e\u0301";
const ac = cursor(JSON.stringify(all)); const ag = str(ac); const ap = JSON.parse(JSON.stringify(all)) as string;
eq("code point sweep = JSON.parse", String(ac.ok) + " " + String(ag === ap) + " " + String(ag.length), "true true " + String(ap.length));
// hand-escaped forms JSON.stringify never writes
const hx = '"\\u0041\\u00E9\\uD83D\\uDE00\\t\\/"'; const hc = cursor(hx);
eq("upper-case hex escapes = JSON.parse", str(hc), JSON.parse(hx) as string);
// a huge string (a long command line kept in a calls file), plain and with escapes every few bytes
const huge = "a".repeat(8 * 1048576); const hc2 = cursor(JSON.stringify(huge)); eq("8 MB plain string", String(str(hc2).length) + String(hc2.ok), String(huge.length) + "true");
let esc = ""; for (let i = 0; i < 200000; i++) esc += "ab\"c\\d\n"; const ec = cursor(JSON.stringify(esc));
eq("escaped 1.6 MB string", String(str(ec) === esc) + String(ec.ok), "truetrue");
// unknown members nested deep are skipped; a corrupt file nested very deep is rejected, not a crash
let deep = ""; for (let i = 0; i < 20; i++) deep += '{"a":['; deep += "1"; for (let i = 0; i < 20; i++) deep += "]}";
const dc = cursor('{"x":' + deep + ',"z":5}'); eat(dc, 123); str(dc); eat(dc, 58); skip(dc); eat(dc, 44); str(dc); eat(dc, 58);
eq("deep member skipped", String(num(dc)) + String(dc.ok), "5true");
const bomb = cursor("[".repeat(1000000)); skip(bomb); eq("1M open brackets: rejected", String(bomb.ok), "false");
console.log(bad ? bad + " failed" : "jsonscan: all checks passed");
if (bad) process.exit(1);
