// agentglass — CLI help as typed records: the text help and the JSON help (full and compact) render from the same rows
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../util/json.ts";
import { BUILD } from "../build-info.ts";
import { FORMATS } from "./format.ts";
import { agentHost, hostObj } from "./agentenv.ts";

// def = default ("" none), values = the allowed values ([] = free)
export interface OptRec { flag: string; arg: string; summary: string; def: string; values: string[] }
// group "cmd" = a row of the usage table, "opt" = a row of the "options for --json / --watch" table (cmd = the flag);
// a "\n" in summary continues on the next row under the description column
export interface CmdRec { cmd: string; usage: string; summary: string; options: OptRec[]; fields: string[]; group: string }

export const REG: CmdRec[] = [];
// options a command module declares for a record registered elsewhere (cli.ts's usage rows), whichever comes first
const OPTS = new Map<string, OptRec[]>();
// a record with the same cmd and group replaces the older one (a feature refines a built-in row); else it goes before the
// record named before ("" or unknown = at the end)
export function addCmd(c: CmdRec, before = ""): void {
  const os = c.group === "cmd" && !c.options.length ? OPTS.get(c.cmd) : undefined; if (os) c.options = os;
  for (let i = 0; i < REG.length; i++) if (REG[i].cmd === c.cmd && REG[i].group === c.group) { REG[i] = c; return; }
  for (let i = 0; i < REG.length; i++) if (before && REG[i].cmd === before && REG[i].group === c.group) { REG.splice(i, 0, c); return; }
  REG.push(c);
}
// a command's options, declared where it parses them: the JSON help lists them, its text help prints optTable(os)
export function setOptions(cmd: string, os: OptRec[]): OptRec[] {
  OPTS.set(cmd, os);
  for (const c of REG) if (c.group === "cmd" && c.cmd === cmd) c.options = os;
  return os;
}
export function cmdOf(cmd: string): CmdRec | null { for (const c of REG) if (c.group === "cmd" && c.cmd === cmd) return c; return null; }
export function opt(flag: string, arg: string, summary: string, def: string, values: string[]): OptRec { return { flag, arg, summary, def, values }; }

// the one exit-code table of every command (text help, JSON help exitCodes, README "Exit codes"); EXIT_EXTRA = the
// command-specific meanings on top of it
export const EXIT_CODES: Obj = { "0": "ok (an empty result is ok)", "1": "runtime failure", "2": "usage error", "3": "not found", "4": "ambiguous reference" };
const EXIT_EXTRA = "cost --check 3 = over budget; rules check 1 = warnings, 2 = errors; export 1 = some requests failed, 3 = another export to the endpoint runs;\n  fleet --strict 5 = a host failed or is stale; fleet serve 126 = refused; wait --check 3 = heavy commands at the limit;\n  receive 3 = another receive serves its directory";
export const EXAMPLES: string[] = [
  "agentglass session current --fields costUsd,tools,errors",
  "agentglass errors --since 24h --limit 5",
  "agentglass session last",
  "agentglass cost --since today --by model",
  "agentglass prices --unpriced",
  "agentglass prices set gpt-6.1-sol --in 1.25 --out 10",
  "agentglass sessions --since 24h --format table",
];

function rows(g: string): string[][] {
  const out: string[][] = [];
  for (const c of REG) {
    if (c.group !== g) continue;
    const ls = c.summary.split("\n");
    for (let i = 0; i < ls.length; i++) out.push([i === 0 ? c.usage : "", ls[i] ?? ""]);
  }
  return out;
}
function table(rs: string[][], col: number): string { return rs.map((r: string[]) => "  " + (r[0] ?? "").padEnd(col) + (r[1] ?? "")).join("\n"); }
// one description column for both tables, past the longest first column
export function textHelp(head: string, tail: string): string {
  const cr = rows("cmd"); const or = rows("opt");
  let col = 0; for (const r of cr.concat(or)) col = Math.max(col, (r[0] ?? "").length + 2);
  const ex = Object.keys(EXIT_CODES).map((k: string) => k + " " + String(EXIT_CODES[k])).join(" · ");
  return head + "\n\nusage:\n" + table(cr, col) + "\n\noptions for --json / --watch:\n" + table(or, col) +
    "\n\nexit codes: " + ex + "\n  (command-specific: " + EXIT_EXTRA + ")\n\n" + tail;
}
// options as text rows: "--flag arg  summary (default …)"; a "\n" in summary continues under the description column
export function optTable(os: OptRec[]): string {
  const rs: string[][] = [];
  for (const o of os) {
    const ls = (o.summary + (o.def ? " (default " + o.def + ")" : "")).split("\n");
    for (let i = 0; i < ls.length; i++) rs.push([i === 0 ? o.flag + (o.arg ? " " + o.arg : "") : "", ls[i] ?? ""]);
  }
  let col = 0; for (const r of rs) col = Math.max(col, (r[0] ?? "").length + 2);
  return table(rs, col);
}
// one command's text help (agentglass <cmd> --help outside agent mode)
export function cmdText(c: CmdRec): string {
  return "usage: " + c.usage + "\n\n  " + c.summary.split("\n").join("\n  ") + (c.options.length ? "\n\noptions:\n" + optTable(c.options) : "") +
    (c.fields.length ? "\n\nfields: " + c.fields.join(" ") : "");
}

function optJson(o: OptRec): Obj { return { flag: o.flag, arg: o.arg, summary: o.summary.split("\n").join(" "), default: o.def, values: o.values }; }
function cmdJson(c: CmdRec): Obj { return { cmd: c.cmd, usage: c.usage, summary: c.summary.split("\n").join(" "), options: c.options.map(optJson), fields: c.fields }; }
// full machine help; cmd non-empty = only that command, or its subcommands (rules → rules check, rules defaults); "" when
// it is unknown
export function jsonHelp(cmd: string, agent: Obj): string {
  const cs: Obj[] = [];
  for (const c of REG) if (c.group === "cmd" && (!cmd || c.cmd === cmd || c.cmd.startsWith(cmd + " "))) cs.push(cmdJson(c));
  if (cmd && !cs.length) return "";
  const ex: string[] = [];
  for (const e of EXAMPLES) if (!cmd || e.startsWith("agentglass " + cmd + " ")) ex.push(e);
  return JSON.stringify({ name: "agentglass", version: BUILD.version, agentMode: agent, commands: cs, formats: FORMATS, exitCodes: EXIT_CODES, examples: ex });
}
// <cmd> --help: the JSON help inside an agent or with --format json (as cli.ts's help), else the command's text
export function helpOf(cmd: string, args: string[], text: string): string {
  const fi = args.indexOf("--format");
  return agentHost().on || (fi >= 0 && args[fi + 1] === "json") ? jsonHelp(cmd, hostObj(true)) : text;
}
export function wantsHelp(args: string[]): boolean { return args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0; }
// TUI-only, maintenance and version commands: --help lists them
const NOT_COMPACT = ["", "--theme", "--redact", "--help", "--version", "--update-prices", "update", "open" /* a TUI: no use inside an agent */, "rules check", "rules defaults", "prices set", "prices alias", "prices unset",
  "--no-fleet", "fleet cost", "fleet status", "fleet pull", "fleet snapshot", "fleet watch", "fleet drop", "fleet serve", "fleet authorize",
  "receive", "receive token", "receive status", "receive service"]; // fleet: one entry, fleet --help lists the rest; receive: a hub command, not an agent tool
// the summary's first clause (before a parenthesis or semicolon), at most 36 characters, cut after a whole word
function brief(s: string): string {
  const t = (s.split("\n")[0] ?? "").split(" (")[0].split(";")[0].trim(); if (t.length <= 36) return t;
  const cut = t.slice(0, 36); const sp = cut.lastIndexOf(" ");
  return (sp > 16 ? cut.slice(0, sp) : cut.slice(0, 35)).replace(/[,:/ ]+$/, "") + "…";
}
// bare agentglass inside an agent: what exists and three examples, no option tables (target ≤ 1 KB: it costs the agent
// tokens; the version is left to --version)
export function compactHelp(agent: Obj): string {
  const cs: Obj[] = [];
  for (const sub of [true, false]) // subcommands (the queries) first, then the flag commands
    for (const c of REG) if (c.group === "cmd" && NOT_COMPACT.indexOf(c.cmd) < 0 && c.cmd.startsWith("-") !== sub) cs.push({ cmd: c.cmd, summary: brief(c.summary) });
  return JSON.stringify({ name: "agentglass", agentMode: agent, commands: cs, examples: EXAMPLES.slice(0, 3), more: "agentglass --help" });
}
