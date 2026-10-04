// agentglass — CLI help as typed records: the text help and the JSON help (full and compact) render from the same rows
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../util/json.ts";
import { BUILD } from "../build-info.ts";
import { FORMATS } from "./format.ts";

// def = default ("" none), values = the allowed values ([] = free)
export interface OptRec { flag: string; arg: string; summary: string; def: string; values: string[] }
// group "cmd" = a row of the usage table, "opt" = a row of the "options for --json / --watch" table (cmd = the flag);
// a "\n" in summary continues on the next row under the description column
export interface CmdRec { cmd: string; usage: string; summary: string; options: OptRec[]; fields: string[]; group: string }

export const REG: CmdRec[] = [];
// a record with the same cmd and group replaces the older one (a feature refines a built-in row); else it goes before the
// record named before ("" or unknown = at the end)
export function addCmd(c: CmdRec, before = ""): void {
  for (let i = 0; i < REG.length; i++) if (REG[i].cmd === c.cmd && REG[i].group === c.group) { REG[i] = c; return; }
  for (let i = 0; i < REG.length; i++) if (before && REG[i].cmd === before && REG[i].group === c.group) { REG.splice(i, 0, c); return; }
  REG.push(c);
}
export function cmdOf(cmd: string): CmdRec | null { for (const c of REG) if (c.group === "cmd" && c.cmd === cmd) return c; return null; }
export function opt(flag: string, arg: string, summary: string, def: string, values: string[]): OptRec { return { flag, arg, summary, def, values }; }

// the one exit-code table of every command (text help, JSON help exitCodes, README "Exit codes"); EXIT_EXTRA = the
// command-specific meanings on top of it
export const EXIT_CODES: Obj = { "0": "ok (an empty result is ok)", "1": "runtime failure", "2": "usage error", "3": "not found", "4": "ambiguous reference" };
const EXIT_EXTRA = "cost --check 3 = over budget; rules check 1 = warnings, 2 = errors; export 1 = some requests failed";
export const EXAMPLES: string[] = [
  "agentglass session current --fields costUsd,tools,errors",
  "agentglass errors --since 24h --limit 5",
  "agentglass session last",
  "agentglass cost --since today --by model",
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
// one command's text help (agentglass <cmd> --help outside agent mode)
export function cmdText(c: CmdRec): string {
  const os: string[][] = c.options.map((o: OptRec) => [o.flag + (o.arg ? " " + o.arg : ""), o.summary + (o.def ? " (default " + o.def + ")" : "")]);
  let col = 0; for (const r of os) col = Math.max(col, (r[0] ?? "").length + 2);
  return "usage: " + c.usage + "\n\n  " + c.summary.split("\n").join("\n  ") + (os.length ? "\n\noptions:\n" + table(os, col) : "") +
    (c.fields.length ? "\n\nfields: " + c.fields.join(" ") : "");
}

function optJson(o: OptRec): Obj { return { flag: o.flag, arg: o.arg, summary: o.summary, default: o.def, values: o.values }; }
function cmdJson(c: CmdRec): Obj { return { cmd: c.cmd, usage: c.usage, summary: c.summary.split("\n").join(" "), options: c.options.map(optJson), fields: c.fields }; }
// full machine help; cmd non-empty = only that command ("" when it is unknown)
export function jsonHelp(cmd: string, agent: Obj): string {
  const cs: Obj[] = [];
  for (const c of REG) if (c.group === "cmd" && (!cmd || c.cmd === cmd)) cs.push(cmdJson(c));
  if (cmd && !cs.length) return "";
  const ex: string[] = [];
  for (const e of EXAMPLES) if (!cmd || e.startsWith("agentglass " + cmd + " ")) ex.push(e);
  return JSON.stringify({ name: "agentglass", version: BUILD.version, agentMode: agent, commands: cs, formats: FORMATS, exitCodes: EXIT_CODES, examples: ex });
}
// TUI-only and maintenance commands: --help lists them
const NOT_COMPACT = ["", "--theme", "--redact", "--help", "--update-prices", "update", "rules check", "rules defaults"];
// the summary's first clause (before a parenthesis or semicolon), at most 70 characters
function brief(s: string): string { const t = (s.split("\n")[0] ?? "").split(" (")[0].split(";")[0].trim(); return t.length > 70 ? t.slice(0, 69) + "…" : t; }
// bare agentglass inside an agent: what exists and three examples, no option tables (target ≤ 1 KB: it costs the agent tokens)
export function compactHelp(agent: Obj): string {
  const cs: Obj[] = [];
  for (const sub of [true, false]) // subcommands (the queries) first, then the flag commands
    for (const c of REG) if (c.group === "cmd" && NOT_COMPACT.indexOf(c.cmd) < 0 && c.cmd.startsWith("-") !== sub) cs.push({ cmd: c.cmd, summary: brief(c.summary) });
  return JSON.stringify({ name: "agentglass", version: BUILD.version, agentMode: agent, commands: cs, examples: EXAMPLES.slice(0, 3), more: "agentglass --help" });
}
