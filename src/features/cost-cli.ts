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
import { cliError } from "./agentenv.ts";
import { startOfDay } from "./usage/record.ts";
import { MODES } from "./usage/billing.ts";
import { type ModeSum, money, kfmt, grp, unpricedLine, monthStart } from "./usage/costs.ts";
import { type CostNow, costNow, budget } from "./usage/summary.ts";

const HELP = `usage: agentglass cost [--json] [--harness h] [--check]

  costs today, over the last 7 days and this month, by billing mode:
    spend = API key (real spend)   plan = subscription (list-price equivalent)
    cloud = Bedrock/Vertex/Foundry/Azure   gateway = proxy/gateway   unknown = not detectable
  plus unpriced usage (tokens of models without a price, Kiro credits without kiroCreditUsd),
  the projected month (needs 3+ days of history) and the budget from ~/.agentglass/config.json:
    { "budget": { "monthlyUsd": 200, "counts": ["api", "metered", "gateway"], "warnAt": 0.8 } }

  --json        machine-readable output
  --harness h   only this harness (${harnessIds().join(", ")})
  --check       exit 3 when the month is over budget (for prompts and cron)`;
const WORDS = ["spend", "plan", "cloud", "gateway", "unknown"];

function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
function fail(msg: string): never { cliError("usage", msg, "", 2); }

function byMode(m: ModeSum): Obj { const o: Obj = {}; for (let i = 0; i < MODES.length; i++) o[MODES[i] ?? ""] = round(m.by[i] ?? 0); return o; }
function unpriced(m: ModeSum): Obj { const bm: Obj = {}; for (const [k, n] of m.um) bm[k] = n; return { tokens: m.unk, byModel: bm, credits: m.uc }; }
function round(c: number): number { return Math.round(c * 1e6) / 1e6; }
function json(c: CostNow): Obj {
  const pb: Obj = {}; for (let i = 0; i < MODES.length; i++) { const p = c.projByMode[i]; pb[MODES[i] ?? ""] = p && p.month >= 0 ? round(p.month) : null; }
  const b = c.budget;
  return {
    today: { byMode: byMode(c.today), unpriced: unpriced(c.today) },
    week: { byMode: byMode(c.week), unpriced: unpriced(c.week) },
    month: { byMode: byMode(c.month), unpriced: unpriced(c.month), projected: c.proj.month >= 0 ? { byMode: pb, total: round(c.proj.month) } : null },
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
    for (let k = 0; k < cols.length; k++) { const i = cols[k] ?? 0; l += pad(money(r.m.by[i] ?? 0, MODES[i] ?? "unknown"), W); }
    l += pad(r.m.unk > 0 ? kfmt(r.m.unk) + " tok" : "—", W);
    out(l);
  }
  let pl = "projected month".padEnd(L);
  for (let k = 0; k < cols.length; k++) { const i = cols[k] ?? 0; const p = c.projByMode[i]; pl += pad(p && p.month >= 0 ? money(p.month, MODES[i] ?? "unknown") : "—", W); }
  out(pl + (c.proj.month < 0 ? "   (needs 3+ days of history)" : "   (total " + money(c.proj.month, cols.length === 1 && cols[0] === 0 ? "api" : "") + ")"));
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

function cost(args: string[]): void {
  let asJson = false; let check = false; let harness = "";
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") asJson = true;
    else if (a === "--check") check = true;
    else if (a === "--harness") { harness = args[i + 1] ?? ""; i++; if (!isHarness(harness)) fail("--harness must be one of " + harnessIds().join(", ")); }
    else if (a === "--help" || a === "-h") { out(HELP); process.exit(0); }
    else fail("unknown option " + a + " (see agentglass cost --help)");
  }
  S.cli = true;
  if (budget.bad) say("warn", "config budget." + budget.bad.split(",").join(" / budget.") + " invalid — ignored");
  discover();
  // every session that can hold a day of this month or of the 14-day projection window, indexed to its end
  const from = Math.min(startOfDay() - (monthStart(Date.now()).length - 1) * 86400000, startOfDay() - 15 * 86400000) - 3600000;
  for (const s of sessions.values()) if (s.mtime >= from && (!harness || s.h === harness)) { loadHead(s); complete(s); }
  const c = costNow(harness);
  if (asJson) out(process.stdout.isTTY ? JSON.stringify(json(c), null, 2) : JSON.stringify(json(c)));
  else text(c);
  process.exit(check && c.bs.state === "over" ? 3 : 0);
}

H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: `cost --json` is this command's flag
  if (args[0] !== "cost") return false;
  cost(args);
  return true;
});
