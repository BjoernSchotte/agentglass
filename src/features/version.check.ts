// agentglass — self-check for version parsing/ordering: sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import { parseVersion, compareVersions, parseDevTag, versionOfTag, installMethod, versionInfo, CONTRACT } from "./version.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function cmp(a: string, b: string): number { const x = parseVersion(a); const y = parseVersion(b); return x && y ? compareVersions(x, y) : 99; }
ok("stable parses", parseVersion("2026.9.1") !== null, "");
ok("zero-padded month rejected", parseVersion("2026.09.1") === null, "");
ok("N=0 rejected", parseVersion("2026.9.0") === null, "");
ok("month rollover", cmp("2026.10.1", "2026.9.12") > 0, String(cmp("2026.10.1", "2026.9.12")));
ok("counter", cmp("2026.9.2", "2026.9.10") < 0, String(cmp("2026.9.2", "2026.9.10")));
ok("dev after its base", cmp("2026.9.1-dev.20260930.4+a1b2c3d4", "2026.9.1") > 0, "");
ok("dev before next stable", cmp("2026.9.1-dev.20260930.4+a1b2c3d4", "2026.9.2") < 0, "");
ok("dev by date then run", cmp("2026.9.1-dev.20260930.4+a1b2c3d4", "2026.9.1-dev.20261001.1+b1b2c3d4") < 0 && cmp("2026.9.1-dev.20261001.2+aaaaaaaa", "2026.9.1-dev.20261001.1+bbbbbbbb") > 0, "");
ok("dev before any stable", cmp("0.0.0-dev.20260930.1+a1b2c3d4", "2026.9.1") < 0, "");
ok("local parses", parseVersion("2026.9.1-local+a1b2c3d4-dirty") !== null && parseVersion("0.0.0-local+a1b2c3d4") !== null, "");
ok("garbage rejected", parseVersion("latest") === null && parseVersion("v2026.9.1") === null && parseVersion("2026.9.1-1") === null, "");
const d = parseDevTag("dev-20260930.12.2-a1b2c3d4");
ok("dev tag", !!d && d.date === 20260930 && d.run === 12 && d.attempt === 2 && d.sha === "a1b2c3d4", JSON.stringify(d));
ok("bad dev tag", parseDevTag("dev-2026093.1.1-a1b2c3d4") === null && parseDevTag("dev-20260930.1.1-XYZ") === null, "");
ok("versionOfTag", versionOfTag("v2026.9.1") === "2026.9.1" && versionOfTag("dev-20260930.1.1-a1b2c3d4") === "" && versionOfTag("v2026.09.1") === "", "");
ok("brew", installMethod("/opt/homebrew/Cellar/agentglass/2026.9.1/bin/agentglass", "stable", "") === "homebrew", "");
ok("linuxbrew", installMethod("/home/linuxbrew/.linuxbrew/Cellar/agentglass-dev/x/bin/agentglass", "dev", "") === "homebrew", "");
ok("script", installMethod("/home/u/.local/bin/agentglass", "stable", "{\"method\":\"script\",\"path\":\"/home/u/.local/bin/agentglass\"}") === "script", "");
ok("script marker for another path", installMethod("/usr/local/bin/agentglass", "stable", "{\"method\":\"script\",\"path\":\"/home/u/.local/bin/agentglass\"}") === "unknown", "");
ok("source", installMethod("/home/u/code/agentglass/agentglass", "local", "") === "source", "");
// the CLI contract number (docs/cli-contract.md): an integer, in --version --json
ok("contract", CONTRACT === 1 && versionInfo()["contract"] === 1, String(versionInfo()["contract"]));
console.log(bad ? bad + " failed" : "version: all checks passed");
process.exit(bad ? 1 : 0);
