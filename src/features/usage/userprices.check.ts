// agentglass — self-check for the prices.json writer and price-line parsing: scriptc build src/features/usage/userprices.check.ts -o up && ./up
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync, readFileSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parsePriceLine, checkPrice, entryOf, storedKey, setUserEntry, userEntry, type PriceIn } from "./userprices.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function canon(path: string): string { return JSON.stringify(JSON.parse(readFileSync(path, "utf8"))); }

const d = "/tmp/agentglass-up-" + process.pid;
rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
// a missing file (and its missing directory) is created
const f1 = join(d, "sub", "prices.json");
setUserEntry(f1, "gpt-x", { input: 1, output: 2 });
ok("missing file written", canon(f1) === "{\"gpt-x\":{\"input\":1,\"output\":2}}", readFileSync(f1, "utf8"));
ok("pretty + newline", readFileSync(f1, "utf8").endsWith("}\n") && readFileSync(f1, "utf8").indexOf("\n  \"gpt-x\"") >= 0, readFileSync(f1, "utf8"));
const e1 = userEntry(f1, "GPT-X"); ok("userEntry reads back (normalised)", !!e1 && e1["output"] === 2, e1 ? JSON.stringify(e1) : "null");
// a blank file is {}
const f2 = join(d, "blank.json"); writeFileSync(f2, "  \n");
setUserEntry(f2, "a", { alias: "gpt-x" });
ok("blank file → {}", canon(f2) === "{\"a\":{\"alias\":\"gpt-x\"}}", readFileSync(f2, "utf8"));
// other keys survive; null removes
const f3 = join(d, "keep.json"); writeFileSync(f3, "{\"kiroCreditUsd\": 0.04, \"a\": {\"input\": 3, \"output\": 4}}");
setUserEntry(f3, "b", { input: 1, output: 1 });
ok("other keys kept", canon(f3) === "{\"kiroCreditUsd\":0.04,\"a\":{\"input\":3,\"output\":4},\"b\":{\"input\":1,\"output\":1}}", readFileSync(f3, "utf8"));
setUserEntry(f3, "a", null);
ok("null removes", canon(f3) === "{\"kiroCreditUsd\":0.04,\"b\":{\"input\":1,\"output\":1}}", readFileSync(f3, "utf8"));
ok("absent entry → null", userEntry(f3, "a") === null, "found");
// invalid JSON: throws, bytes unchanged
const f4 = join(d, "broken.json"); const broken = "{\"a\": {\"input\": 1,, }"; writeFileSync(f4, broken);
let threw = ""; try { setUserEntry(f4, "b", { input: 1, output: 1 }); } catch (e) { threw = String(e); }
ok("invalid JSON throws", threw.indexOf("not valid JSON") >= 0, threw);
ok("invalid JSON left as is", readFileSync(f4, "utf8") === broken, readFileSync(f4, "utf8"));
const f5 = join(d, "array.json"); writeFileSync(f5, "[1]");
let threw2 = ""; try { setUserEntry(f5, "b", { input: 1, output: 1 }); } catch (e) { threw2 = String(e); }
ok("non-object throws", threw2 !== "" && readFileSync(f5, "utf8") === "[1]", threw2);
// a symlink stays a link, its target holds the change
writeFileSync(join(d, "target.json"), "{\"z\": {\"input\": 1, \"output\": 1}}"); execFileSync("ln", ["-s", join(d, "target.json"), join(d, "link.json")]);
setUserEntry(join(d, "link.json"), "y", { alias: "z" });
ok("symlink stays a link", lstatSync(join(d, "link.json")).isSymbolicLink(), "replaced by a file");
ok("symlink target updated", canon(join(d, "target.json")) === "{\"z\":{\"input\":1,\"output\":1},\"y\":{\"alias\":\"z\"}}", readFileSync(join(d, "target.json"), "utf8"));
// stored keys
ok("storedKey", storedKey("openai/GPT-6.1-sol-20260101") === "gpt-6.1-sol", storedKey("openai/GPT-6.1-sol-20260101"));
setUserEntry(f3, "OpenAI/GPT-6.1-Sol", { input: 5, output: 6 });
ok("entry stored under the normalised key", canon(f3).indexOf("\"gpt-6.1-sol\":{\"input\":5") >= 0, readFileSync(f3, "utf8"));
rmSync(d, { recursive: true, force: true });

// parsePriceLine / checkPrice / entryOf
function pl(t: string): string { const r = parsePriceLine(t); return r.p ? r.p.i + "," + r.p.o + "," + r.p.cr + "," + r.p.cw + "," + r.p.cw1 : "ERR " + r.err; }
ok("two values", pl("1.25 10") === "1.25,10,-1,-1,-1", pl("1.25 10"));
ok("$ and /", pl("$1.25 / $10") === "1.25,10,-1,-1,-1", pl("$1.25 / $10"));
ok("commas, five values", pl("1,2,0.1,1.25,2") === "1,2,0.1,1.25,2", pl("1,2,0.1,1.25,2"));
ok("0 0 valid", pl("0 0") === "0,0,-1,-1,-1", pl("0 0"));
ok("one value", pl("1") === "ERR in and out are needed", pl("1"));
ok("empty", pl("  ") === "ERR in and out are needed", pl("  "));
ok("not a number", pl("abc 1") === "ERR \"abc\" is not a number", pl("abc 1"));
ok("too many", pl("1 2 3 4 5 6") === "ERR too many values (max 5)", pl("1 2 3 4 5 6"));
const neg: PriceIn = { i: -2, o: 1, cr: -1, cw: -1, cw1: -1 };
ok("negative", pl("-2 1") === "ERR prices must be ≥ 0" || checkPrice(neg) === "prices must be ≥ 0", pl("-2 1"));
ok("too big", pl("10001 1") === "ERR price over $10000/Mtok", pl("10001 1"));
ok("checkPrice ok", checkPrice({ i: 1, o: 2, cr: -1, cw: -1, cw1: -1 }) === "", "err");
ok("entryOf minimal", JSON.stringify(entryOf({ i: 1.25, o: 10, cr: -1, cw: -1, cw1: -1 })) === "{\"input\":1.25,\"output\":10}", JSON.stringify(entryOf({ i: 1.25, o: 10, cr: -1, cw: -1, cw1: -1 })));
ok("entryOf full", JSON.stringify(entryOf({ i: 1, o: 2, cr: 0.1, cw: 1.25, cw1: 2 })) === "{\"input\":1,\"output\":2,\"cacheRead\":0.1,\"cacheWrite\":1.25,\"cacheWrite1h\":2}", "x");

console.log(bad ? bad + " failed" : "userprices: all checks passed");
if (bad) process.exit(1);
