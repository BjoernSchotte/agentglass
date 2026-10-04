// agentglass — self-check for the config file parse/merge: scriptc build src/util/config.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { parseConfig, mergeConfig } from "./config.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

ok("missing file", parseConfig("").root === null && parseConfig("").bad === "", parseConfig("").bad);
ok("blank file", parseConfig(" \n").bad === "", parseConfig(" \n").bad);
const good = parseConfig("{\"budget\": {\"monthlyUsd\": 5}}");
ok("valid", good.bad === "" && good.root !== null && JSON.stringify(good.root) === "{\"budget\":{\"monthlyUsd\":5}}", good.bad);
const comma = parseConfig("{\"budget\": {\"monthlyUsd\": 5},}");
ok("trailing comma is bad", comma.root === null && comma.bad.length > 0, comma.bad);
const arr = parseConfig("[1]");
ok("an array is bad", arr.root === null && arr.bad === "not a JSON object", arr.bad);

// merge: keeps other sections and keys; refuses to replace a file it cannot read
const m = mergeConfig("{\"budget\": {\"monthlyUsd\": 5}, \"filter\": {\"x\": 1}}", "filter", "pinned", "tool is Bash");
ok("merge keeps", m !== null && JSON.stringify(JSON.parse(m ?? "")) === "{\"budget\":{\"monthlyUsd\":5},\"filter\":{\"x\":1,\"pinned\":\"tool is Bash\"}}", m ?? "null");
const fresh = mergeConfig("", "update", "channel", "dev");
ok("merge into nothing", fresh !== null && JSON.stringify(JSON.parse(fresh ?? "")) === "{\"update\":{\"channel\":\"dev\"}}", fresh ?? "null");
ok("merge refuses broken JSON", mergeConfig("{\"budget\": 1,}", "filter", "pinned", "x") === null, "replaced");
ok("merge refuses a non-object", mergeConfig("[]", "filter", "pinned", "x") === null, "replaced");
const sec = mergeConfig("{\"filter\": 3}", "filter", "pinned", "x");
ok("a non-object section is replaced", sec !== null && JSON.stringify(JSON.parse(sec ?? "")) === "{\"filter\":{\"pinned\":\"x\"}}", sec ?? "null");

if (bad) { console.log(String(bad) + " config check(s) failed"); process.exit(1); }
console.log("config: all checks passed");
