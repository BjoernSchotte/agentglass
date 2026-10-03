// agentglass — `agentglass rules check|defaults`: validate rules.json with line:col diagnostics, print the built-ins
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import { type Rule, type RuleSet, loadRules, builtins, unitOf, thrText } from "./config.ts";
export { thrText };
import { RULES_FILE } from "./file.ts";
import { fileText, fileMtime, fileSafe, withSafety } from "./state.ts";

function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
function thrJson(unit: string, v: number): string | number { return unit === "duration" || unit === "ratio" ? thrText(unit, v) : v; }
interface JRule { id: string; metric: string; op: string; degraded: number | null; critical: number | null; for: number; where: string; enabled: boolean; builtin: boolean; ack: string; notify: boolean; message: string; labels: { [k: string]: string } }
interface JDiag { line: number; col: number; rule: string; message: string; severity: string }
interface JCheck { file: string; exists: boolean; rules: JRule[]; diagnostics: JDiag[] }
export interface Checked { lines: string[]; code: number; json: JCheck }
function labelsOf(r: Rule): { [k: string]: string } { const o: { [k: string]: string } = {}; for (const [k, v] of r.labels) o[k] = v; return o; }
// the pure core of `rules check`: effective rules (built-ins merged) and diagnostics; code 0 clean, 1 warnings, 2 errors
export function checkText(text: string, exists: boolean, safe: boolean): Checked {
  const rs: RuleSet = withSafety(loadRules(text, exists), safe);
  const lines: string[] = []; const jr: JRule[] = []; const jd: JDiag[] = [];
  let w = 4; for (const r of rs.rules) w = Math.max(w, r.id.length);
  let mw = 6; for (const r of rs.rules) mw = Math.max(mw, r.metric.length);
  lines.push((exists ? RULES_FILE : RULES_FILE + " (missing: built-in rules)") + (rs.syntax ? " — syntax error, built-in rules in force" : ""));
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
    lines.push("rules.json:" + String(d.line) + ":" + String(d.col) + ": " + (d.rule || "-") + ": " + (d.err ? "" : "warning: ") + d.msg);
    jd.push({ line: d.line, col: d.col, rule: d.rule, message: d.msg, severity: d.err ? "error" : "warning" });
  }
  if (rs.notify.command.length) lines.push("notify command: " + JSON.stringify(rs.notify.command) + " on " + rs.notify.on.join(", "));
  return { lines, code: errs ? 2 : warns ? 1 : 0, json: { file: RULES_FILE, exists, rules: jr, diagnostics: jd } };
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
];
export function defaultsText(examples: boolean): string {
  const rows: string[] = []; for (const r of builtins()) rows.push(ruleJson(r));
  if (examples) { const rs = loadRules("{\"builtins\":false,\"rules\":[" + EXAMPLES.join(",") + "]}", true); for (const r of rs.rules) rows.push(ruleJson(r)); }
  return "{\n  \"version\": 1,\n  \"builtins\": true,\n  \"notify\": { \"bell\": true, \"desktop\": true, \"throttle\": \"30s\", \"command\": null, \"on\": [\"fire\", \"escalate\"] },\n  \"rules\": [\n" + rows.join(",\n") + "\n  ]\n}";
}

const HELP = `usage: agentglass rules check [--json]     validate ${"~"}/.agentglass/rules.json; print the effective rules and every problem as
                                           rules.json:<line>:<col>: <rule>: <message> (exit 0 clean, 1 warnings, 2 errors)
       agentglass rules defaults [--examples]  print the built-in rules as a ready-to-edit rules.json
                                           (--examples: plus disabled example rules: cost, error rate, repeats, per harness)
the file: {"builtins": true, "notify": {...}, "rules": [{"id", "metric", "where", "op", "degraded", "critical", "for", ...}]}
a rule with a built-in id (waiting approval loop long-cmd stalled spinning) changes only the fields it names
metrics: turn_done approval_wait repeat_run command_age stalled spinning session_cost session_tokens tool_calls tool_errors tool_error_rate
AGENTGLASS_RULES=<path> reads another file`;

H.cli.push((args: string[]): boolean => {
  if (args[0] !== "rules") return false;
  S.cli = true;
  const sub = args[1] ?? "";
  if (sub === "check") {
    const exists = fileMtime(RULES_FILE) >= 0;
    const c = checkText(exists ? fileText(RULES_FILE) : "", exists, exists && fileSafe(RULES_FILE));
    if (args.indexOf("--json") >= 0) out(process.stdout.isTTY ? JSON.stringify(c.json, null, 2) : JSON.stringify(c.json));
    else for (const l of c.lines) out(l);
    process.exit(c.code);
  }
  if (sub === "defaults") { out(defaultsText(args.indexOf("--examples") >= 0)); process.exit(0); }
  if (sub === "--help" || sub === "-h" || sub === "help") { out(HELP); process.exit(0); }
  process.stderr.write("agentglass rules: " + (sub ? "unknown command \"" + sub + "\"" : "which one? check or defaults") + "\n" + HELP + "\n");
  process.exit(2);
});
