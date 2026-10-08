// agentglass — self-check for `agentglass mcp install`: each harness's registration (printed text and argv), scopes and
// options, and when the bare server name is used: scriptc build src/features/mcp-cli.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
import { type Reg, HARNESS_IDS, regs, serverCmd } from "./mcp-cli.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const J = (v: unknown): string => JSON.stringify(v);
const all = (c: string): boolean => true;
const none = (c: string): boolean => false;
function one(h: string, scope: string, opts: string[]): Reg { return regs("agentglass-mcp", opts, scope, [h], all)[0] as Reg; }

ok("harness ids", J(HARNESS_IDS) === J(["claude", "codex", "gemini", "pi", "kiro", "opencode"]), J(HARNESS_IDS));
const o2 = ["--all-projects", "--content"];
ok("claude user", J(one("claude", "user", o2).argv) === J(["claude", "mcp", "add", "--scope", "user", "agentglass", "--", "agentglass-mcp", "--all-projects", "--content"]), J(one("claude", "user", o2).argv));
ok("claude project", J(one("claude", "project", []).argv) === J(["claude", "mcp", "add", "--scope", "project", "agentglass", "--", "agentglass-mcp"]), J(one("claude", "project", []).argv));
ok("claude print", one("claude", "user", o2).print === "claude mcp add --scope user agentglass -- agentglass-mcp --all-projects --content", one("claude", "user", o2).print);
ok("codex", J(one("codex", "user", o2).argv) === J(["codex", "mcp", "add", "agentglass", "--", "agentglass-mcp", "--all-projects", "--content"]), J(one("codex", "user", o2).argv));
ok("codex print: the config.toml table", one("codex", "user", o2).print.indexOf("[mcp_servers.agentglass]\n  command = \"agentglass-mcp\"\n  args = [\"--all-projects\", \"--content\"]") > 0, one("codex", "user", o2).print);
ok("gemini user", J(one("gemini", "user", []).argv) === J(["gemini", "mcp", "add", "--scope", "user", "agentglass", "agentglass-mcp"]), J(one("gemini", "user", []).argv));
ok("gemini options after --", J(one("gemini", "project", ["--redact"]).argv) === J(["gemini", "mcp", "add", "--scope", "project", "agentglass", "agentglass-mcp", "--", "--redact"]), J(one("gemini", "project", ["--redact"]).argv));
ok("pi user", J(one("pi", "user", []).argv) === J(["pi", "mcp", "add", "agentglass", "--", "agentglass-mcp"]), J(one("pi", "user", []).argv));
ok("pi project", J(one("pi", "project", ["--redact"]).argv) === J(["pi", "mcp", "add", "--local", "agentglass", "--", "agentglass-mcp", "--redact"]), J(one("pi", "project", ["--redact"]).argv));
ok("kiro global", J(one("kiro", "user", ["--redact"]).argv) === J(["kiro-cli", "mcp", "add", "--name", "agentglass", "--scope", "global", "--command", "agentglass-mcp", "--args", "--redact"]), J(one("kiro", "user", ["--redact"]).argv));
ok("kiro workspace", J(one("kiro", "project", []).argv) === J(["kiro-cli", "mcp", "add", "--name", "agentglass", "--scope", "workspace", "--command", "agentglass-mcp"]), J(one("kiro", "project", []).argv));
const oc = one("opencode", "user", o2);
ok("opencode print-only", oc.argv.length === 0 && oc.print.indexOf("\"mcp\": {\"agentglass\": {\"type\": \"local\", \"command\": [\"agentglass-mcp\", \"--all-projects\", \"--content\"], \"enabled\": true}}") >= 0 && oc.print.indexOf("~/.config/opencode/opencode.json") >= 0, oc.print);
ok("opencode project file", one("opencode", "project", []).print.indexOf("opencode.json in the project") >= 0, one("opencode", "project", []).print);
ok("quoted print", one("claude", "user", []).print === "claude mcp add --scope user agentglass -- agentglass-mcp" && regs("/opt/my dir/agentglass-mcp", [], "user", ["claude"], all)[0].print.indexOf("'/opt/my dir/agentglass-mcp'") > 0, regs("/opt/my dir/agentglass-mcp", [], "user", ["claude"], all)[0].print);
// which: the named ones; none named = every harness found on PATH
ok("found on PATH", J(regs("agentglass-mcp", [], "user", [], (c: string) => c === "pi" || c === "kiro-cli").map((r: Reg) => r.harness)) === J(["pi", "kiro"]), "");
ok("named but not found", regs("agentglass-mcp", [], "user", ["claude"], none)[0].found === false, "");
ok("all", regs("agentglass-mcp", [], "user", ["all"], none).length === 6, "");
// serverCmd: the bare name only when PATH resolves it to this agentglass's sibling
ok("bare name", serverCmd("/opt/bin/agentglass", (c: string) => "/opt/bin/agentglass-mcp") === "agentglass-mcp", "");
ok("absolute: another one on PATH", serverCmd("/opt/bin/agentglass", (c: string) => "/usr/bin/agentglass-mcp") === "/opt/bin/agentglass-mcp", "");
ok("absolute: none on PATH", serverCmd("/opt/bin/agentglass", (c: string) => "") === "/opt/bin/agentglass-mcp", "");

console.log(bad ? String(bad) + " failed" : "mcp-cli: all checks passed");
if (bad) process.exit(1);
