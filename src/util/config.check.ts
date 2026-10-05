// agentglass — self-check for the config file parse/merge: scriptc build src/util/config.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { parseConfig, mergeConfig, writeConfigAt } from "./config.ts";
import { readWhole } from "./fs.ts";

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

// readWhole: missing is fine, a file it cannot read (or a directory) is an error, never "" mistaken for a missing file
const d = join(tmpdir(), "ag-config-check-" + String(process.pid)); mkdirSync(d, { recursive: true });
const miss = readWhole(join(d, "none.json"), 1024);
ok("read missing", miss.missing && miss.err === "" && miss.text === "", miss.err);
writeFileSync(join(d, "a.json"), "{\"x\": 1}");
const rd = readWhole(join(d, "a.json"), 1024);
ok("read file", !rd.missing && rd.err === "" && rd.text === "{\"x\": 1}", rd.err);
const big = readWhole(join(d, "a.json"), 4);
ok("read too large", big.err.indexOf("larger than") >= 0, big.err);
mkdirSync(join(d, "dir.json"), { recursive: true });
const dir = readWhole(join(d, "dir.json"), 1024);
ok("read a directory", !dir.missing && dir.err.length > 0, dir.err);
if (userInfo().uid !== 0) { // root reads anything
  writeFileSync(join(d, "locked.json"), "{}"); chmodSync(join(d, "locked.json"), 0o000);
  const lk = readWhole(join(d, "locked.json"), 1024);
  ok("read unreadable", !lk.missing && lk.err.length > 0, lk.err);
  let threw = ""; try { writeConfigAt(join(d, "locked.json"), "filter", "pinned", "x"); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  ok("write refuses an unreadable file", threw.indexOf("cannot read") >= 0, threw || "wrote");
  chmodSync(join(d, "locked.json"), 0o600);
  ok("unreadable file left as it is", readFileSync(join(d, "locked.json"), "utf8") === "{}", readFileSync(join(d, "locked.json"), "utf8"));
}
// writeConfigAt: a broken file is refused and left byte for byte; a symlink (dotfile managers) is written through, the link stays
writeFileSync(join(d, "broken.json"), "{\"budget\": 1,}");
let bt = ""; try { writeConfigAt(join(d, "broken.json"), "filter", "pinned", "x"); } catch (e) { bt = e instanceof Error ? e.message : String(e); }
ok("write refuses broken JSON", bt.indexOf("not valid JSON") >= 0 && readFileSync(join(d, "broken.json"), "utf8") === "{\"budget\": 1,}", bt || "wrote");
writeFileSync(join(d, "target.json"), "{\"budget\": {\"monthlyUsd\": 5}}"); execFileSync("ln", ["-s", join(d, "target.json"), join(d, "link.json")]); // scriptc has no symlinkSync
writeConfigAt(join(d, "link.json"), "filter", "pinned", "tool is Bash");
ok("symlink stays a link", lstatSync(join(d, "link.json")).isSymbolicLink(), "replaced by a file");
ok("symlink target updated", JSON.stringify(JSON.parse(readFileSync(join(d, "target.json"), "utf8"))) === "{\"budget\":{\"monthlyUsd\":5},\"filter\":{\"pinned\":\"tool is Bash\"}}", readFileSync(join(d, "target.json"), "utf8"));
writeConfigAt(join(d, "new", "config.json"), "update", "channel", "dev");
ok("write creates the file", JSON.stringify(JSON.parse(readFileSync(join(d, "new", "config.json"), "utf8"))) === "{\"update\":{\"channel\":\"dev\"}}", "missing");
rmSync(d, { recursive: true, force: true });

if (bad) { console.log(String(bad) + " config check(s) failed"); process.exit(1); }
console.log("config: all checks passed");
