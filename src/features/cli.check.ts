// agentglass — self-check for CLI errors inside an agent (runs itself as the child): scriptc build src/features/cli.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { cliError } from "./agentenv.ts";

const mode = process.argv[2] ?? "";
if (mode === "--child-error") cliError("usage", "bad \"thing\"", "try --x", 2);
if (mode === "--child-nohint") cliError("not_found", "no such session", "", 3);

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-cli-check-" + String(process.pid);
function child(arg: string, agent: string): string[] {
  const sh = "mkdir -p " + dir + "; AGENTGLASS_AGENT=" + agent + " '" + process.execPath + "' " + arg + " >" + dir + "/o 2>" + dir + "/e; echo $?";
  const code = execFileSync("sh", ["-c", sh], { encoding: "utf8" }).trim();
  return [code, readFileSync(dir + "/o", "utf8"), readFileSync(dir + "/e", "utf8")];
}
const a = child("--child-error", "1");
eq("agent: exit", a[0] ?? "", "2");
eq("agent: stdout empty", a[1] ?? "", "");
eq("agent: one JSON line", a[2] ?? "", "{\"error\":{\"code\":\"usage\",\"message\":\"bad \\\"thing\\\"\",\"hint\":\"try --x\"}}\n");
const n = child("--child-nohint", "1");
eq("agent: no hint key", n[2] ?? "", "{\"error\":{\"code\":\"not_found\",\"message\":\"no such session\"}}\n");
eq("agent: exit 3", n[0] ?? "", "3");
const h = child("--child-error", "0");
eq("human: plain text", h[2] ?? "", "agentglass: bad \"thing\"\n  hint: try --x\n");
rmSync(dir, { recursive: true, force: true });

console.log(bad ? bad + " failed" : "cli: all checks passed");
if (bad) process.exit(1);
