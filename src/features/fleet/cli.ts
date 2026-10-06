// agentglass — `agentglass fleet …`: every host's sessions and cost in one list, the hosts' status, and the remote side
// (fleet pull, fleet serve, fleet authorize)
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, screenOut } from "../../hooks.ts";
import { cliError } from "../agentenv.ts";
import { type CmdRec, addCmd, opt, cmdOf, cmdText, helpOf, wantsHelp } from "../clihelp.ts";
import { pullCli } from "./pull.ts";
import { serveCli, authorizeCli } from "./serve.ts";

function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
const SUBS = ["pull", "serve", "authorize"];
function rec(c: string, usage: string, summary: string, options: CmdRec["options"]): CmdRec { return { cmd: c, usage, summary, options, fields: [], group: "cmd" }; }
addCmd(rec("fleet pull", "agentglass fleet pull [--days N] [--redact]", "this host's report for a fleet viewer (JSON lines: hello, cost, allowance, sessions, end);\nwhat the viewer runs over ssh",
  [opt("--days", "N", "sessions updated within N days (1–90), plus every live one", "7", []), opt("--redact", "", "fake titles, projects and paths at the source", "", [])]));
addCmd(rec("fleet serve", "agentglass fleet serve [--redact]", "the forced command of a viewer's key on a host (authorized_keys command=): runs only\nfleet pull and --version from SSH_ORIGINAL_COMMAND; exit 126 refused, 2 outside ssh",
  [opt("--redact", "", "answer every request redacted, whatever the viewer asks", "", [])]));
addCmd(rec("fleet authorize", "agentglass fleet authorize <key.pub> [--from <cidr>] [--redact]", "print the authorized_keys line that limits the viewer's key to fleet serve\n(restrict,command=…); run it on the host, append the line yourself",
  [opt("--from", "<cidr>", "only from these addresses (from=…), e.g. 100.64.0.0/10", "", []), opt("--redact", "", "the host answers redacted (fleet serve --redact)", "", [])]));
H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: `fleet --json` is this command's flag
  if (args[0] !== "fleet") return false;
  const sub = args[1] ?? "";
  const name = SUBS.indexOf(sub) >= 0 ? "fleet " + sub : "fleet";
  if (wantsHelp(args)) { const r = cmdOf(name); if (!r) cliError("usage", "unknown command " + name, "agentglass --help lists the commands", 2); out(helpOf(name, args, cmdText(r))); process.exit(0); }
  if (sub === "pull") { pullCli(args); return true; }
  if (sub === "serve") { serveCli(args); return true; }
  if (sub === "authorize") { authorizeCli(args); return true; }
  cliError("usage", "unknown fleet command " + sub, "agentglass fleet --help", 2);
});
