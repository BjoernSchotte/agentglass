// agentglass — `agentglass triage`: what is different about a selection vs a baseline, as a text table or --json (spec §6)
// SPDX-License-Identifier: Apache-2.0
// Guards are answers (exit 0); a bad expression or option exits 2. Pins are not applied: scripts stay reproducible.
import { writeSync } from "node:fs";
import { H, complete, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import { sessions, loadHead } from "../../model/sessions.ts";
import type { Obj } from "../../util/json.ts";
import { width } from "../../util/text.ts";
import { C, RST, fg } from "../../ui/theme.ts";
import { gauge } from "../../ui/screen.ts";
import { discover } from "../cli.ts";
import { startOfDay } from "../usage/record.ts";
import { rowsOf } from "../usage/ledger.ts";
import type { Clause } from "../query/types.ts";
import { parse, print, quoteVal } from "../query/parse.ts";
import { projectClause } from "../query/project.ts";
import { agentHost, agentScope, cliError } from "../agentenv.ts";
import { addAll } from "../query/scope.ts";
import { sessMatches } from "../query/eval.ts";
import { cliFilter } from "../query/cli.ts";
import type { Weight } from "../query/agg.ts";
import { type TRow, rank, fmtLift, fmtPct, chiStr } from "./score.ts";
import { type Run, type Result, type Base, PRESETS, newRun, runTriage, triageCfg, periodLabel, guardText, shown } from "./run.ts";

const NAMES = ["errors", "slow", "long", "expensive", "failing", "period"]; // --preset words, PRESETS 1..6
const HELP = `usage: agentglass triage [--select '<expr>' | --preset ${NAMES.join("|")}] [--filter '<scope>']…
                         [--baseline rest|previous] [--entity call|session] [--days N]
                         [--weight count|cost|tokens|duration] [--limit N] [--json]

  ranks the attribute values over-represented in a selection compared with a baseline:
  "program npm — 34% of errored calls vs 6% of the rest". ● marks χ² ≥ 6.63 (p < 0.01, Yates).

  --select '<expr>'   the selection, in the filter grammar (e.g. 'tool is Bash and status is error')
  --preset p          errors: status is error · slow: duration ≥ the tool's p90 · long: duration > triage.longCall
                      expensive: cost > triage.expensiveUsd (sessions) · failing: error_rate > 20% and tools >= 10
                      period: this period vs the previous one (default without --select)
  --filter '<scope>'  the scope both groups come from (repeatable; pins are not applied)
  --baseline b        rest = scope minus the selection (default) · previous = the selection in the period before
  --entity e          call (rows = tool calls, kept triage.callDays) or session (default: from the preset, else call)
  --days N            period length in days (default 7)
  --weight w          count (default) · cost, tokens (sessions) · duration (calls); weighted runs have no χ²
  --limit N           at most N rows (default 20)
  --json              {entity, period, selection, baseline, rows[], guard}; guard null | empty-baseline |
                      empty-selection | small-sample | retention
  inside a coding agent: --json is the default and the scope is the current repo (--all-projects: every one)

  config (~/.agentglass/config.json): { "triage": { "longCall": "30s", "expensiveUsd": 5, "minSupport": 3 } }`;

function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
function fail(msg: string): never { cliError("usage", screenOut("triage: " + msg), "", 2); } // a JSON line inside an agent
function intArg(v: string, name: string): number { const n = Number(v); if (!/^\d+$/.test(v) || n < 1) fail(name + " must be an integer ≥ 1, got \"" + v + "\""); return n; }
function oneOf(v: string, name: string, ok: string[]): string { if (ok.indexOf(v) < 0) fail(name + " must be one of " + ok.join(", ") + (v ? ", got \"" + v + "\"" : "")); return v; }

export interface CliOpts { run: Run; limit: number; json: boolean }
// argv after "triage" → the run (exits 2 on a bad option or expression)
export function parseArgs(args: string[]): CliOpts {
  let select = ""; let hasSelect = false; let preset = ""; const filters: string[] = []; let baseline = ""; let entity = ""; let days = 7; let weight = ""; let limit = 20; let json = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? ""; const v = args[i + 1] ?? "";
    const val = (): string => { if (i + 1 >= args.length) fail(a + " needs a value (see agentglass triage --help)"); i++; return v; };
    if (a === "--json") json = true;
    else if (a === "--select") { select = val(); hasSelect = true; }
    else if (a === "--preset") preset = oneOf(val(), "--preset", NAMES);
    else if (a === "--filter") filters.push(val());
    else if (a === "--baseline") baseline = oneOf(val(), "--baseline", ["rest", "previous"]);
    else if (a === "--entity") entity = oneOf(val(), "--entity", ["call", "session"]);
    else if (a === "--days") days = intArg(val(), "--days");
    else if (a === "--weight") weight = oneOf(val(), "--weight", ["count", "cost", "tokens", "duration"]);
    else if (a === "--limit") limit = intArg(val(), "--limit");
    else if (a === "--help" || a === "-h") { out(HELP); process.exit(0); }
    else if (a === "--all-projects" || a === "--project-only") continue; // the agent-mode scope (agentScope reads them)
    else fail("unknown option " + a + " (see agentglass triage --help)");
  }
  if (hasSelect && preset) fail("--select and --preset are exclusive: pick one");
  // expressions: the filter-language error format (message + caret), exit 2
  cliFilter(filters, "", false, false, false);
  if (hasSelect) cliFilter([select], "", false, false, false);
  let scope: Clause[] = []; for (const f of filters) scope = addAll(scope, parse(f).cs).cs;
  const pn = hasSelect ? 7 : NAMES.indexOf(preset || "period") + 1;
  const p = PRESETS[pn - 1];
  const ent = entity === "call" || entity === "session" ? entity : hasSelect ? "call" : p.entity;
  if (p.slow && ent === "session") fail("--preset slow needs --entity call (slow is per call)");
  const r = newRun("cli", ent, scope, hasSelect ? parse(select).cs : p.sel(), days);
  r.preset = pn; r.slow = p.slow;
  const base: Base = baseline === "rest" || baseline === "previous" ? baseline : p.base;
  if (p.slow && base !== "rest") fail("--preset slow compares against the rest only");
  r.base = base;
  const w = weight || "count";
  if ((w === "cost" || w === "tokens") && ent !== "session") fail("--weight " + w + " needs --entity session (cost and tokens are per session)");
  if (w === "duration" && ent !== "call") fail("--weight duration needs --entity call");
  r.weight = w as Weight;
  return { run: r, limit, json };
}

export function guardOut(res: Result): string | null { return res.guard ? res.guard : res.small ? "small-sample" : null; }
function round(x: number, d: number): number { const m = d === 1 ? 10 : d === 3 ? 1000 : 1e6; return Math.round(x * m) / m; }
export function toJson(r: Run, res: Result, rows: TRow[]): Obj {
  const rs: Obj[] = [];
  for (const t of rows) rs.push({
    attr: t.attr, value: shown(t.attr, t.value), sel: { n: t.s.a, share: round(t.s.pS, 6) }, base: { n: t.s.b, share: round(t.s.pB, 6) },
    diff: round(t.s.diff, 6), lift: t.s.lift < 0 ? null : round(t.s.lift, 3), chi2: t.s.chi2 < 0 ? null : round(t.s.chi2, 1), significant: t.s.sig,
  });
  return {
    entity: r.entity, period: { from: res.from, to: res.to },
    selection: { expr: r.slow ? "slow" : print(r.sel), n: res.selN }, baseline: { mode: r.base, expr: r.base === "group" ? print(r.group) : "", n: res.baseN },
    rows: rs, guard: guardOut(res),
  };
}
function rpad(s: string, w: number): string { const n = width(s); return n >= w ? s : " ".repeat(w - n) + s; }
function lpad(s: string, w: number): string { const n = width(s); return n >= w ? s : s + " ".repeat(w - n); }
function text(r: Run, res: Result, rows: TRow[], tty: boolean): void {
  const dim = (s: string): string => tty ? fg(C.dim) + s + RST : s;
  out("triage · " + res.selLabel + " (" + String(res.selN) + ") vs " + res.baseLabel + " (" + String(res.baseN) + ") · " + periodLabel(r.days) + (r.scope.length ? " · scope: " + print(r.scope) : "") + (r.weight !== "count" ? " · weight " + r.weight : ""));
  if (res.guard) { out(guardText(r, res, true)); return; }
  if (res.small) out(dim("small sample: " + String(Math.min(res.selN, res.baseN)) + " rows, percentages are unreliable"));
  if (res.unpriced > 0 && r.weight === "cost") out(dim("+" + String(res.unpriced) + " unpriced (counted with cost 0)"));
  if (!rows.length) { out("no value reaches the minimum support (" + String(triageCfg().minSupport) + " rows, 1% of the selection)"); return; }
  let aw = 9; let vw = 5; for (const t of rows) { aw = Math.max(aw, width(t.attr)); vw = Math.min(40, Math.max(vw, width(shown(t.attr, t.value)))); }
  const bw = tty ? 12 : 0;
  const weighted = r.weight !== "count";
  out(lpad("attribute", aw) + "  " + lpad("value", vw) + "  " + rpad("selection", bw + (bw ? 1 : 0) + 7) + "  " + rpad("baseline", bw + (bw ? 1 : 0) + 7) + "  " + rpad("lift", 6) + "  " + (weighted ? "weighted, no significance" : rpad("χ²", 7)));
  let mx = 0; for (const t of rows) mx = Math.max(mx, t.s.pS, t.s.pB);
  for (const t of rows) {
    let v = shown(t.attr, t.value); if (width(v) > vw) v = v.slice(0, vw - 1) + "…";
    const bar = (p: number, acc: boolean): string => bw ? (acc ? gauge(mx > 0 ? p / mx : 0, bw) : fg(C.dim) + gauge(mx > 0 ? p / mx : 0, bw) + RST) + " " : "";
    const x = t.s.chi2 < 0 ? "" : (t.s.sig ? "●" : " ") + rpad(chiStr(t.s.chi2), 6);
    out(lpad(t.attr, aw) + "  " + lpad(v, vw) + "  " + bar(t.s.pS, true) + rpad(fmtPct(t.s.pS), 7) + "  " + bar(t.s.pB, false) + rpad(fmtPct(t.s.pB), 7) + "  " + rpad(fmtLift(t.s), 6) + "  " + rpad(x, 7));
  }
}

function triage(args: string[]): void {
  S.cli = true;
  const o = parseArgs(args); const r = o.run;
  // inside an agent: JSON, and only the current project unless widened (the output goes to the agent's model provider)
  if (agentHost().on) {
    o.json = true;
    const sc = agentScope(args);
    if (sc.name === "project") r.scope = addAll(r.scope, parse(projectClause(sc.cwd)).cs).cs; // exact identity, not a same-named repo
  }
  triageCfg();
  discover();
  // every session that can hold a row of either period, indexed to its end (cheap clauses of the scope pick them first)
  const cf = cliFilter(r.scope.length ? [print(r.scope)] : [], "", false, false, false);
  const span = r.base === "previous" ? r.days * 2 : r.days;
  const from = startOfDay() - (span - 1) * 86400000 - 3600000;
  for (const s of sessions.values()) {
    if (s.mtime < from) continue;
    if (cf.needsHead && !s.headDone) loadHead(s);
    if (!sessMatches(cf.cheap, s)) continue;
    loadHead(s); rowsOf(s); complete(s);
  }
  const res = runTriage(r);
  const rows = res.guard ? [] : rank(res.rows, false, 3, triageCfg().minSupport, "").slice(0, o.limit);
  if (o.json) out(process.stdout.isTTY ? JSON.stringify(toJson(r, res, rows), null, 2) : JSON.stringify(toJson(r, res, rows)));
  else text(r, res, rows, !!process.stdout.isTTY);
  for (const f of H.onQuit) f(); // every session of the period was indexed: keep that work for the next run
  process.exit(0);
}

H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: `triage --json` is this command's flag
  if (args[0] !== "triage") return false;
  triage(args);
  return true;
});
