// agentglass — cost by billing mode over all sessions (today, 7 days, month), projections and the budget watch
// SPDX-License-Identifier: Apache-2.0
import { H } from "../../hooks.ts";
import { say } from "../../state.ts";
import { section } from "../../util/config.ts";
import { OS } from "../../platform/index.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger } from "./ledger.ts";
import { L, todayKey, lastDays } from "./record.ts";
import { type Bill, MODES } from "./billing.ts";
import { modeOf } from "./bill-live.ts";
import { type ModeSum, type DayCost, type Budget, type BState, newSum, addDay, parseBudget, budgetState, stateOf, notifyOnce, projectToday, projectMonth, daysLeftInMonth, monthStart } from "./costs.ts";

export const budget: Budget = parseBudget(section("budget"));

// cached sums stay valid ≤ 5 s, and while indexing bumps the ledger version every tick they are rebuilt at most every 2 s
function fresh(ver: number, at: number): boolean { const age = Date.now() - at; return ver >= 0 && age < 5000 && (ver === L.ver || age < 2000); }
// cost/unpriced by mode over the given local days, harness "" = all (cached per ledger version, ≤ 5 s)
const sums = new Map<string, { ver: number; at: number; m: ModeSum }>();
export function sumDays(days: string[], harness: string): ModeSum {
  const key = harness + "|" + days.join(",");
  const hit = sums.get(key);
  if (hit && fresh(hit.ver, hit.at)) return hit.m;
  const m = newSum();
  for (const s of sessions.values()) {
    if (harness && s.h !== harness) continue;
    const a = ledger.get(s.path); if (!a) continue;
    for (const k of days) { const d = a.days.get(k); if (d) addDay(m, d, (p: string): Bill => modeOf(s, p)); }
  }
  sums.set(key, { ver: L.ver, at: Date.now(), m });
  return m;
}
function zeros24(): number[] { const z: number[] = []; for (let i = 0; i < 24; i++) z.push(0); return z; }
// per mode (index of MODES), one DayCost per given day; a day's hourly cost splits over modes by its providers' shares
export function dayCosts(days: string[], harness: string): DayCost[][] {
  const out: DayCost[][] = [];
  for (let i = 0; i < MODES.length; i++) { const r: DayCost[] = []; for (const k of days) r.push({ key: k, cost: 0, hc: zeros24() }); out.push(r); }
  for (const s of sessions.values()) {
    if (harness && s.h !== harness) continue;
    const a = ledger.get(s.path); if (!a) continue;
    for (let j = 0; j < days.length; j++) {
      const d = a.days.get(days[j] ?? ""); if (!d || d.cost <= 0) continue;
      for (const [p, c] of d.cp) {
        const row = out[MODES.indexOf(modeOf(s, p))]; const dc = row ? row[j] : undefined; if (!dc) continue;
        dc.cost += c; const f = c / d.cost;
        for (let h = 0; h < 24; h++) dc.hc[h] = (dc.hc[h] ?? 0) + (d.hc[h] ?? 0) * f;
      }
    }
  }
  return out;
}
export interface Proj { today: number; month: number } // -1 = not enough history
// series = the last 15 local days (oldest first, today last) + month-to-date cost; a series without any cost projects 0
function project(series: DayCost[], mtd: number, hour: number, left: number): Proj {
  if (!series.length) return { today: 0, month: mtd };
  const today = series[series.length - 1];
  const hist = series.slice(0, series.length - 1);
  let any = today.cost > 0; for (const d of hist) if (d.cost > 0) any = true;
  if (!any) return { today: 0, month: mtd };
  const pt = projectToday(hist, today, hour);
  return { today: pt, month: projectMonth(hist, mtd, pt, today.cost, left) };
}
// the given modes' rows summed into one series (one DayCost per day)
function sumRows(rows: DayCost[][], pick: (i: number) => boolean): DayCost[] {
  const out: DayCost[] = [];
  const n = rows.length ? rows[0].length : 0;
  for (let j = 0; j < n; j++) {
    const dc: DayCost = { key: rows[0][j].key, cost: 0, hc: zeros24() };
    for (let i = 0; i < rows.length; i++) {
      if (!pick(i)) continue;
      const r = rows[i]; if (j >= r.length) continue; const x = r[j];
      dc.cost += x.cost; for (let h = 0; h < 24; h++) dc.hc[h] = (dc.hc[h] ?? 0) + (x.hc[h] ?? 0);
    }
    out.push(dc);
  }
  return out;
}
export interface CostNow {
  today: ModeSum; week: ModeSum; month: ModeSum;
  projByMode: Proj[]; proj: Proj; projCounted: Proj; // per mode; of the summed series over all modes / the budget's counted modes
  budget: Budget; bs: BState;
}
const nows = new Map<string, { ver: number; at: number; c: CostNow }>();
export function costNow(harness: string): CostNow {
  const hit = nows.get(harness);
  if (hit && fresh(hit.ver, hit.at)) return hit.c;
  const now = Date.now(); const hour = new Date(now).getHours(); const left = daysLeftInMonth(now);
  const d15 = lastDays(15); const mk = monthStart(now);
  const month = sumDays(mk, harness);
  const rows = dayCosts(d15, harness);
  const projByMode: Proj[] = [];
  for (let i = 0; i < MODES.length; i++) projByMode.push(project(rows[i] ?? [], month.by[i] ?? 0, hour, left));
  const counted = (i: number): boolean => budget.counts.indexOf(MODES[i] ?? "unknown") >= 0;
  let mtdAll = 0; let mtdCounted = 0;
  for (let i = 0; i < MODES.length; i++) { mtdAll += month.by[i] ?? 0; if (counted(i)) mtdCounted += month.by[i] ?? 0; }
  // sums project the summed series: one mode with a short history does not blank the total
  const projCounted = project(sumRows(rows, counted), mtdCounted, hour, left);
  const bs = budgetState(budget, month, projByMode.map((p: Proj) => p.month));
  bs.projected = projCounted.month; bs.state = stateOf(budget, bs.used, bs.projected);
  const c: CostNow = { today: sumDays([todayKey()], harness), week: sumDays(lastDays(7), harness), month, projByMode,
    proj: project(sumRows(rows, (i: number) => true), mtdAll, hour, left), projCounted, budget, bs };
  nows.set(harness, { ver: L.ver, at: now, c });
  return c;
}
// the over-budget toast + desktop notification, at most once per calendar day
export function budgetSend(msg: string): void {
  const m = msg + " (budget $" + String(budget.usd) + "/month)";
  say("warn", m);
  if (process.env.AGENTGLASS_NOTIFY !== "0") OS.notify("agentglass", "budget", m);
}
let warned = false; let lastCheck = 0;
H.onTick.push(() => {
  if (!warned) { warned = true; if (budget.bad) say("warn", "config budget." + budget.bad.split(",").join(" / budget.") + " invalid — ignored"); }
  if (budget.usd <= 0 || Date.now() - lastCheck < 60000) return;
  lastCheck = Date.now();
  notifyOnce(costNow("").bs, todayKey(), budgetSend);
});
