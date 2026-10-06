// agentglass — `agentglass cost`: today / 7 days / month by billing mode, unpriced usage, projection and the budget
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, complete, screenOut } from "../hooks.ts";
import { S, say } from "../state.ts";
import { sessions, loadHead } from "../model/sessions.ts";
import { harnessIds, isHarness } from "../harness/index.ts";
import type { Obj } from "../util/json.ts";
import { home } from "../util/text.ts";
import { CONFIG_FILE } from "../util/config.ts";
import { discover } from "./cli.ts";
import { agentHost, agentScope, hostObj, cliError } from "./agentenv.ts";
import { jsonHelp, addCmd, opt } from "./clihelp.ts";
import { type Fmt, fmtArgs } from "./format.ts";
import { BY, COST_FIELDS, MODEL_FIELDS, WS_FIELDS, costRows, qopts, qfilter, printEnvelope } from "./queries.ts";
import { startOfDay, dayKey, todayKey } from "./usage/record.ts";
import { MODES } from "./usage/billing.ts";
import { type ModeSum, money, kfmt, grp, unpricedLine, monthStart } from "./usage/costs.ts";
import { type CostNow, costNow, budget } from "./usage/summary.ts";

const HELP = `usage: agentglass cost [--json] [--harness h] [--check]
       agentglass cost [--since today|<n>d|YYYY-MM-DD] [--by day|model|harness|project|session|workspace] [--format F] [--fields a,b]

  costs today, over the last 7 days and this month, by billing mode:
    spend = API key (real spend)   plan = subscription (list-price equivalent)
    cloud = Bedrock/Vertex/Foundry/Azure   gateway = proxy/gateway   unknown = not detectable
  plus unpriced usage (tokens of models without a price, Kiro credits without kiroCreditUsd; agentglass prices sets them),
  estimatedUsd = the share priced through a prices.json alias (≈, also on an API key),
  the projected month (needs 3+ days of history) and the budget from ~/.agentglass/config.json:
    { "budget": { "monthlyUsd": 200, "counts": ["api", "metered", "gateway"], "warnAt": 0.8 } }

  --json        machine-readable output
  --harness h   only this harness (${harnessIds().join(", ")})
  --check       exit 3 when the month is over budget (for prompts and cron)

  with --by, --since or --filter (without --by: by day; --since defaults to today): one row per key
    {key, in, out, cacheRead, cacheWrite, costUsd, unpricedTokens, sessions} plus a total row
    (--by model adds priceSource = user|alias|gateway|community|built-in|harness|unpriced and estimated = alias-priced)
    (--by workspace: key = the herdr workspace label — its id under --redact — or (none); adds workspaceId, null for
    (none); a live session counts for its pane's workspace, an ended one for the workspace whose worktree holds its dir)
    (costUsd is null, never 0, for a row whose tokens are all unpriced; csv/jsonl/table print bare rows,
    json the {rows, source, scope} envelope); inside an agent only the current project (--all-projects: every one)
  --format json|jsonl|csv|table   (default: json in an agent or with --json, else table on a terminal)
  --fields a,b,c                  only these columns
  --filter '<expr>'               only matching sessions, days and calls (the filter language; repeatable)`;
const WORDS = ["spend", "plan", "cloud", "gateway", "unknown"];

let rc = 0; // the exit code a failed write (closed reader, full disk) still reports: --check's 3 survives `| head`
function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(rc); } }
function fail(msg: string): never { cliError("usage", msg, "", 2); }

function byMode(m: ModeSum): Obj { const o: Obj = {}; for (let i = 0; i < MODES.length; i++) o[MODES[i] ?? ""] = round(m.by[i] ?? 0); return o; }
function unpriced(m: ModeSum): Obj { const bm: Obj = {}; for (const [k, n] of m.um) bm[k] = n; return { tokens: m.unk, byModel: bm, credits: m.uc }; }
function round(c: number): number { return Math.round(c * 1e6) / 1e6; }
// the `cost --json` object (fleet pull prints exactly this)
export function json(c: CostNow): Obj {
  const pb: Obj = {}; for (let i = 0; i < MODES.length; i++) { const p = c.projByMode[i]; pb[MODES[i] ?? ""] = p && p.month >= 0 ? round(p.month) : null; }
  const b = c.budget;
  return {
    today: { byMode: byMode(c.today), estimatedUsd: round(c.today.est), unpriced: unpriced(c.today) },
    week: { byMode: byMode(c.week), estimatedUsd: round(c.week.est), unpriced: unpriced(c.week) },
    month: { byMode: byMode(c.month), estimatedUsd: round(c.month.est), unpriced: unpriced(c.month), projected: c.proj.month >= 0 ? { byMode: pb, total: round(c.proj.month) } : null },
    budget: b.usd > 0 ? { monthlyUsd: b.usd, counts: b.counts, used: round(c.bs.used), projected: c.bs.projected >= 0 ? round(c.bs.projected) : null, state: c.bs.state, approx: c.bs.approx } : null,
  };
}
interface Row { name: string; m: ModeSum }
function pad(s: string, w: number): string { return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function text(c: CostNow): void {
  const rows: Row[] = [{ name: "today", m: c.today }, { name: "7 days", m: c.week }, { name: "month to date", m: c.month }];
  const cols: number[] = [];
  for (let i = 0; i < MODES.length; i++) if (rows.some((r: Row) => (r.m.by[i] ?? 0) > 0) || ((c.projByMode[i]?.month ?? 0) > 0)) cols.push(i);
  if (!cols.length) cols.push(0);
  const W = 12; const L = 16;
  let hd = "".padEnd(L); for (let k = 0; k < cols.length; k++) hd += pad(WORDS[cols[k] ?? 0] ?? "", W); hd += pad("unpriced", W);
  out(hd);
  for (const r of rows) {
    let l = r.name.padEnd(L);
    for (let k = 0; k < cols.length; k++) { const i = cols[k] ?? 0; l += pad(money(r.m.by[i] ?? 0, MODES[i] ?? "unknown", (r.m.estBy[i] ?? 0) > 1e-9), W); }
    l += pad(r.m.unk > 0 ? kfmt(r.m.unk) + " tok" : "—", W);
    out(l);
  }
  let pl = "projected month".padEnd(L);
  for (let k = 0; k < cols.length; k++) { const i = cols[k] ?? 0; const p = c.projByMode[i]; pl += pad(p && p.month >= 0 ? money(p.month, MODES[i] ?? "unknown", (c.month.estBy[i] ?? 0) > 1e-9) : "—", W); }
  out(pl + (c.proj.month < 0 ? "   (needs 3+ days of history)" : "   (total " + money(c.proj.month, cols.length === 1 && cols[0] === 0 ? "api" : "", c.month.est > 1e-9) + ")"));
  out("");
  const uw = unpricedLine(c.week, 5); const um = unpricedLine(c.month, 5);
  out("unpriced (month): " + (um || "none"));
  if (uw && uw !== um) out("unpriced (7 days): " + uw);
  const b = c.budget;
  if (b.usd <= 0) { out("budget: none — set budget.monthlyUsd in " + home(CONFIG_FILE)); return; }
  const ap = c.bs.approx ? "≈" : "";
  out("budget: $" + grp(b.usd) + "/month (counts " + b.counts.join(", ") + "): " + c.bs.state + " · used " + ap + "$" + c.bs.used.toFixed(2) +
    (c.bs.projected >= 0 ? " · projected " + ap + "$" + c.bs.projected.toFixed(2) : "") + " · " + String(Math.round((c.bs.used / b.usd) * 100)) + "% used");
}

// every session that can hold a day of this month or of the 14-day projection window, indexed to its end
export function summary(harness: string): CostNow {
  const from = Math.min(startOfDay() - (monthStart(Date.now()).length - 1) * 86400000, startOfDay() - 15 * 86400000) - 3600000;
  for (const s of sessions.values()) if (s.mtime >= from && (!harness || s.h === harness)) { loadHead(s); complete(s); }
  return costNow(harness);
}
// without --by/--since: the summary (json or its text table); with them: rows per day/model/harness/project/session
function cost(args: string[]): void {
  if (args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) { out(agentHost().on || fmtArgs(args).fmt === "json" ? jsonHelp("cost", hostObj(true)) : HELP); process.exit(0); }
  const o = qopts("cost", args, ["--json", "--check", "--harness", "--since", "--by", "--filter", "--pinned"], false);
  const rowsForm = o.by !== "" || o.since !== "" || o.filters.length > 0 || o.pinned;
  if (o.by && BY.indexOf(o.by) < 0) fail("--by must be one of " + BY.join(", "));
  if (!rowsForm && (o.f.fmt === "csv" || o.f.fmt === "jsonl" || o.f.fields.length)) cliError("usage", (o.f.fields.length ? "--fields" : o.f.fmt) + " needs rows: add --by " + BY.join("|"), "e.g. agentglass cost --by model --format " + (o.f.fmt || "csv"), 2);
  S.cli = true;
  if (budget.bad) say("warn", "config budget." + budget.bad.split(",").join(" / budget.") + " invalid — ignored");
  const sc = agentScope(args);
  discover();
  if (!rowsForm) {
    const c = summary(o.harness);
    rc = o.check && c.bs.state === "over" ? 3 : 0;
    // json inside an agent, with --json / --format json; the text table otherwise (also in pipes, as before)
    if (o.json || o.f.fmt === "json" || (!o.f.fmt && agentHost().on)) out(process.stdout.isTTY && !agentHost().on ? JSON.stringify(json(c), null, 2) : JSON.stringify(json(c)));
    else text(c);
    process.exit(rc);
  }
  const since = o.since ? dayKey(new Date(o.sinceMs)) : todayKey();
  const by = o.by || "day";
  const rows = costRows(since, by, sc, qfilter(o));
  const f: Fmt = { fmt: o.f.fmt || (o.json ? "json" : ""), fields: o.f.fields };
  const code = o.check && summary(o.harness).bs.state === "over" ? 3 : 0; // before printing: a failed write keeps it
  const cols = by === "model" ? MODEL_FIELDS : by === "workspace" ? WS_FIELDS : COST_FIELDS;
  printEnvelope(rows, "ledger", sc, f, cols, cols, code);
  process.exit(code);
}

addCmd({ cmd: "cost", usage: "agentglass cost [--json] [--check]", summary: "costs today / 7 days / month by billing mode, unpriced usage, projection, budget\n(--harness h: one harness; --check: exit 3 when over budget; --since/--by: rows per day|model|harness|project|session|workspace)",
  options: [opt("--json", "", "the summary as JSON", "", []), opt("--harness", harnessIds().join("|"), "only this harness", "", harnessIds()), opt("--check", "", "exit 3 when the month is over budget (after printing)", "", []),
    opt("--since", "today|<n>d|YYYY-MM-DD", "rows from that day on (alone: --by day)", "today", []), opt("--by", BY.join("|"), "one row per key (alone: --since today)", "day", BY),
    opt("--filter", "'<expr>'", "rows of the matching sessions, days and calls only (repeatable)", "", []), opt("--pinned", "", "also apply the filter pinned in the TUI", "", []),
    opt("--format", "json|jsonl|csv|table", "output format (csv/jsonl need rows)", "json in an agent or with --json, else table on a terminal", ["json", "jsonl", "csv", "table"]), opt("--fields", "a,b,c", "only these columns of the rows", "", []),
    opt("--all-projects", "", "inside an agent: rows of every project (default: the current one)", "", []), opt("--project-only", "", "inside an agent: only the current project, over a configured agent.scope all", "", [])],
  fields: COST_FIELDS.concat(["workspaceId"]), group: "cmd" });
H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: `cost --json` is this command's flag
  if (args[0] !== "cost") return false;
  cost(args);
  return true;
});
