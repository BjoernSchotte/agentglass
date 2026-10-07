// agentglass — `agentglass rules check|defaults`: validate rules.json with line:col diagnostics, print the built-ins
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import { type Rule, type RuleSet, loadRules, builtins, unitOf, thrText } from "./config.ts";
export { thrText };
import { RULES_FILE } from "./file.ts";
import { type OptRec, opt, optTable, setOptions, helpOf, wantsHelp } from "../clihelp.ts";
import { fileSafe, withSafety } from "./state.ts";
import { readWhole } from "../../util/fs.ts";

// a usage error: inside an agent one JSON line (S.cliJson, set by agentenv before any handler runs), else plain text
function usage(msg: string): never {
  process.stderr.write(S.cliJson ? JSON.stringify({ error: { code: "usage", message: msg, hint: "agentglass rules --help" } }) + "\n" : "agentglass " + msg + "\n" + RULES_HELP + "\n");
  process.exit(2);
}
let rc = 0; // the exit code a failed write (closed reader, full disk) still reports: never 0 over errors
function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(rc); } }
function thrJson(unit: string, v: number): string | number { return unit === "duration" || unit === "ratio" ? thrText(unit, v) : v; }
interface JRule { id: string; metric: string; op: string; degraded: number | null; critical: number | null; for: number; where: string; enabled: boolean; builtin: boolean; ack: string; notify: boolean; message: string; labels: { [k: string]: string } }
interface JDiag { line: number; col: number; rule: string; message: string; severity: string }
interface JCheck { file: string; exists: boolean; rules: JRule[]; diagnostics: JDiag[] }
export interface Checked { lines: string[]; code: number; json: JCheck }
function labelsOf(r: Rule): { [k: string]: string } { const o: { [k: string]: string } = {}; for (const [k, v] of r.labels) o[k] = v; return o; }
// the pure core of `rules check`: effective rules (built-ins merged) and diagnostics; code 0 clean, 1 warnings, 2 errors
// readErr: the file is there but cannot be read (a directory, no permission, too large) — an error, never "empty file"
export function checkText(text: string, exists: boolean, safe: boolean, readErr = ""): Checked {
  const rs: RuleSet = readErr ? unreadable(readErr) : withSafety(loadRules(text, exists), safe);
  const lines: string[] = []; const jr: JRule[] = []; const jd: JDiag[] = [];
  let w = 4; for (const r of rs.rules) w = Math.max(w, r.id.length);
  let mw = 6; for (const r of rs.rules) mw = Math.max(mw, r.metric.length);
  lines.push((exists ? RULES_FILE : RULES_FILE + " (missing: built-in rules)") + (readErr ? " — unreadable, built-in rules in force" : rs.syntax ? " — syntax error, built-in rules in force" : ""));
  for (const r of rs.rules) {
    const u = unitOf(r.metric);
    const lv = (r.hasDeg ? thrText(u, r.deg) : "-") + "/" + (r.hasCrit ? thrText(u, r.crit) : "-");
    const row = "  " + r.id.padEnd(w) + "  " + r.metric.padEnd(mw) + "  " + r.op.padEnd(2) + " " + lv.padEnd(11) + (r.forSec > 0 ? " for " + thrText("duration", r.forSec) : "") +
      (r.where ? "  where " + r.where : "") + (r.enabled ? "" : "  (disabled)");
    lines.push(row.trimEnd());
    jr.push({ id: r.id, metric: r.metric, op: r.op, degraded: r.hasDeg ? r.deg : null, critical: r.hasCrit ? r.crit : null, for: r.forSec, where: r.where, enabled: r.enabled, builtin: r.builtin, ack: r.ack, notify: r.notify, message: r.message, labels: labelsOf(r) });
  }
  let errs = 0; let warns = 0;
  for (const d of rs.diags) {
    if (d.err) errs++; else warns++;
    lines.push("rules.json:" + String(d.line) + ":" + String(d.col) + ": " + (d.rule ? d.rule + ": " : "") + (d.err ? "" : "warning: ") + d.msg);
    jd.push({ line: d.line, col: d.col, rule: d.rule, message: d.msg, severity: d.err ? "error" : "warning" });
  }
  if (rs.notify.command.length) lines.push("notify command: " + JSON.stringify(rs.notify.command) + " on " + rs.notify.on.join(", "));
  return { lines, code: errs ? 2 : warns ? 1 : 0, json: { file: RULES_FILE, exists, rules: jr, diagnostics: jd } };
}

function unreadable(err: string): RuleSet {
  const rs = loadRules("", false); rs.syntax = "cannot read the file (" + err + ")";
  rs.diags.push({ line: 1, col: 1, rule: "", msg: rs.syntax + " — using built-in rules", err: true }); return rs;
}

// ── defaults ──
function ruleJson(r: Rule): string {
  const u = unitOf(r.metric); const o: string[] = [];
  const q = (v: string): string => JSON.stringify(v);
  const t = (v: number): string => { const x = thrJson(u, v); return typeof x === "string" ? q(x) : String(x); };
  o.push("\"id\": " + q(r.id)); o.push("\"metric\": " + q(r.metric)); o.push("\"op\": " + q(r.op));
  if (r.hasDeg) o.push("\"degraded\": " + t(r.deg));
  if (r.hasCrit) o.push("\"critical\": " + t(r.crit));
  if (r.where) o.push("\"where\": " + q(r.where));
  if (r.forSec > 0) { const x = thrJson("duration", r.forSec); o.push("\"for\": " + (typeof x === "string" ? q(x) : String(x))); }
  if (r.window > 0) o.push("\"window\": " + String(r.window));
  if (r.minCalls !== 1) o.push("\"min_calls\": " + String(r.minCalls));
  o.push("\"ack\": " + q(r.ack)); o.push("\"notify\": " + String(r.notify)); o.push("\"message\": " + q(r.message));
  if (!r.enabled) o.push("\"enabled\": false");
  return "    { " + o.join(", ") + " }";
}
// spec §8 examples with new ids (overrides of a built-in id are shown in the README: a disabled copy would disable it)
const EXAMPLES = [
  '{"id":"session-cost","metric":"session_cost","degraded":5,"critical":20,"message":"cost {value}","enabled":false}',
  '{"id":"bash-errors","metric":"tool_error_rate","where":"tool is Bash","min_calls":20,"degraded":"30%","enabled":false}',
  '{"id":"bash-errors-recent","metric":"tool_error_rate","where":"tool is Bash","min_calls":20,"window":50,"degraded":"30%","enabled":false}',
  '{"id":"bash-repeats","metric":"repeat_run","where":"tool is Bash","degraded":5,"enabled":false}',
  '{"id":"waiting-codex","metric":"turn_done","where":"harness is codex","degraded":"5m","ack":"look","enabled":false}',
  '{"id":"same-heavy-command","metric":"contention_family","degraded":2,"for":"30s","enabled":false}',
];
export function defaultsText(examples: boolean): string {
  const rows: string[] = []; for (const r of builtins()) rows.push(ruleJson(r));
  if (examples) { const rs = loadRules("{\"builtins\":false,\"rules\":[" + EXAMPLES.join(",") + "]}", true); for (const r of rs.rules) rows.push(ruleJson(r)); }
  return "{\n  \"version\": 1,\n  \"builtins\": true,\n  \"notify\": { \"bell\": true, \"desktop\": true, \"throttle\": \"30s\", \"command\": null, \"on\": [\"fire\", \"escalate\"] },\n  \"rules\": [\n" + rows.join(",\n") + "\n  ]\n}";
}

const CHECK_OPTS: OptRec[] = setOptions("rules check", [opt("--json", "", "check: {file, exists, rules[], diagnostics[{line,col,rule,message,severity}]}", "", [])]);
const DEFAULTS_OPTS: OptRec[] = setOptions("rules defaults", [opt("--examples", "", "defaults: plus disabled example rules (cost, error rate, repeats, per harness, same heavy command)", "", [])]);
export const RULES_HELP = `usage: agentglass rules check [--json]
       agentglass rules defaults [--examples]

  check     validate ${"~"}/.agentglass/rules.json; print the effective rules and every problem as
            rules.json:<line>:<col>: [<rule>:] <message> (exit 0 clean, 1 warnings, 2 errors)
  defaults  print the built-in rules as a ready-to-edit rules.json

` + optTable(CHECK_OPTS.concat(DEFAULTS_OPTS)) + `

the file: {"builtins": true, "notify": {...}, "rules": [{"id", "metric", "where", "op", "degraded", "critical", "for", ...}]}
a rule with a built-in id (waiting approval loop long-cmd stalled spinning) changes only the fields it names
metrics: turn_done approval_wait repeat_run command_age stalled spinning session_cost session_tokens tool_calls tool_errors tool_error_rate
AGENTGLASS_RULES=<path> reads another file`;

H.cli.push((args: string[]): boolean => {
  if (args[0] !== "rules") return false;
  S.cli = true;
  const sub = args[1] ?? "";
  if (wantsHelp(args) || sub === "help") { out(helpOf(sub === "check" || sub === "defaults" ? "rules " + sub : "rules", args, RULES_HELP)); process.exit(0); }
  const own = sub === "check" ? "--json" : "--examples"; // each subcommand's one option; the agent-mode scope flags pass
  const bad = args.slice(2).filter((a: string) => [own, "--all-projects", "--project-only"].indexOf(a) < 0);
  if ((sub === "check" || sub === "defaults") && bad.length) usage("rules " + sub + ": unknown option " + (bad[0] ?? ""));
  if (sub === "check") {
    const f = readWhole(RULES_FILE, 1048576);
    const c = checkText(f.text, !f.missing, !f.missing && fileSafe(RULES_FILE), f.err);
    rc = c.code;
    const agent = S.cliJson; // inside an agent: compact JSON by default
    if (agent || args.indexOf("--json") >= 0) out(process.stdout.isTTY && !agent ? JSON.stringify(c.json, null, 2) : JSON.stringify(c.json));
    else for (const l of c.lines) out(l);
    process.exit(c.code);
  }
  if (sub === "defaults") { out(defaultsText(args.indexOf("--examples") >= 0)); process.exit(0); }
  usage("rules: " + (sub ? "unknown command \"" + sub + "\"" : "which one? check or defaults"));
});
