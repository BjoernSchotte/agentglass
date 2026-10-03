// agentglass — self-check for the help records: scriptc build src/features/clihelp.check.ts -o ch && ./ch
// SPDX-License-Identifier: Apache-2.0
import { REG, jsonHelp, compactHelp, cmdOf } from "./clihelp.ts";
import { usage } from "./cli.ts";
import { arr, obj } from "../util/json.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
// the text help (byte-identical to main's before the records, plus the rows added since), from its second line: the first names the build
const GOLDEN = "\nusage:\n  agentglass                                         interactive TUI\n  agentglass --theme <name>                          TUI with a color theme\n  agentglass --redact                                privacy mode for screencasts: fake titles/projects/content, scrubbed names\n                                                     (also AGENTGLASS_REDACT=1; combinable with --json / --watch)\n  agentglass --json [opts]                           print a JSON snapshot of sessions (newest first) and exit\n  agentglass --watch [opts]                          stream new events of all agents as JSONL (tail -f for every session)\n  agentglass cost [--json] [--check]                 costs today / 7 days / month by billing mode, unpriced usage, projection, budget\n                                                     (--harness h: one harness; --check: exit 3 when over budget)\n  agentglass --update-prices                         fetch the opted-in community price list now (see ~/.agentglass/config.json)\n  agentglass --help | -h                             this text\n  agentglass update [--channel stable|dev]           update to the newest release (--tag T, --dry-run, --json, --yes, --rollback, status)\n  agentglass --version [--json]                      print the version (--json: version, channel, commit, date, platform, install method)\n\noptions for --json / --watch:\n  --live                                             only sessions with a running agent process\n  --harness claude|codex|fx|pi|opencode|kiro|gemini  only this harness\n  --limit N                                          --json: at most N sessions\n  --subagents                                        --json: include subagent sessions\n  --from-start                                       --watch: replay existing logs from the beginning (combine with a filter)\n  --for <dur>                                        --watch: stop after this long (30s, 5m, 1h)\n  --until-idle                                       --watch: stop when no event arrived for 10 s (inside an agent: --for or this)\n\n--json fields: id harness title cwd branch remote model path updated bytes live pid status parent kind subagents\n  activity tokens{in,out,cacheRead,cacheWrite} costUsd billing{mode,plan,source} unpricedTokens unpricedCredits\n  tools linesAdded linesRemoved attention stuck skills[{name,source,n}]\n  (costUsd = API list price, null when only unpriced usage exists; billing.mode = api|plan|metered|gateway|unknown,\n  source = session|process|config \u2014 config = assumed from the current config files;\n  skills source = command: a slash command / $mention, model: the agent chose it)\n--watch lines: {ts,harness,session,title,project,parent,kind,tool,text}; kind = user|assistant|thinking|tool|result|meta,\n  plus live|exit when an agent process appears or disappears\n\nOpenCode sessions are read from its SQLite database with the sqlite3 CLI (AGENTGLASS_SQLITE3 = another command);\n  without it, 2.x sessions come from a running `opencode service` over HTTP with curl (AGENTGLASS_CURL); with neither\n  they are not listed (a warning says so)";
const u = usage().trimEnd();
eq("first line", String(u.startsWith("agentglass ") && u.split("\n")[0].indexOf("browse, watch and steer") > 0), "true");
const got = u.slice(u.indexOf("\n") + 1);
if (got !== GOLDEN) { const a = got.split("\n"); const b = GOLDEN.split("\n"); for (let i = 0; i < Math.max(a.length, b.length); i++) eq("help line " + String(i + 2), a[i] ?? "<none>", b[i] ?? "<none>"); }

const full = obj(JSON.parse(jsonHelp("", { on: false })));
let ncmd = 0; for (const c of REG) if (c.group === "cmd") ncmd++;
eq("json help lists every command", String(full ? arr(full["commands"]).length : -1), String(ncmd));
eq("json help formats", JSON.stringify(full ? full["formats"] : null), JSON.stringify(["json", "jsonl", "csv", "table"]));
eq("unknown command", jsonHelp("nope", {}), "");
const one = obj(JSON.parse(jsonHelp("--json", {})));
eq("one command", String(one ? arr(one["commands"]).length : -1), "1");
eq("cmdOf", String(cmdOf("--json") !== null && cmdOf("nope") === null), "true");
const ch = compactHelp({ harness: "claude", session: "abc", scope: "project" });
eq("compact parses", String(obj(JSON.parse(ch)) !== null), "true");
eq("compact has no option tables", String(ch.indexOf("\"options\"") < 0 && ch.indexOf("\"fields\"") < 0), "true");
eq("compact ≤ 1 KB (" + String(ch.length) + ")", String(ch.length <= 1024), "true");

console.log(bad ? bad + " failed" : "clihelp: all checks passed");
if (bad) process.exit(1);
