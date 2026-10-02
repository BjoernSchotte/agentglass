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
import { type ModeSum, type DayCost, type Budget, type BState, newSum, addDay, parseBudget, budgetState, notifyOnce, projectToday, projectMonth, daysLeftInMonth, monthStart } from "./costs.ts";

export const budget: Budget = parseBudget(section("budget"));

// cost/unpriced by mode over the given local days, harness "" = all (cached per ledger version, ≤ 5 s)
const sums = new Map<string, { ver: number; at: number; m: ModeSum }>();
export function sumDays(days: string[], harness: string): ModeSum {
  const key = harness + "|" + days.join(",");
  const hit = sums.get(key);
  if (hit && hit.ver === L.ver && Date.now() - hit.at < 5000) return hit.m;
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
// Σ of per-mode projections over the picked modes; -1 as soon as one of them is unknown
function sumProj(ps: Proj[], pick: (i: number) => boolean): Proj {
  let t = 0; let m = 0;
  for (let i = 0; i < ps.length; i++) {
    if (!pick(i)) continue; const p = ps[i];
    t = t < 0 || p.today < 0 ? -1 : t + p.today; m = m < 0 || p.month < 0 ? -1 : m + p.month;
  }
  return { today: t, month: m };
}
export interface CostNow {
  today: ModeSum; week: ModeSum; month: ModeSum;
  projByMode: Proj[]; proj: Proj; projCounted: Proj; // per mode; summed over all modes / over the budget's counted modes
  budget: Budget; bs: BState;
}
const nows = new Map<string, { ver: number; at: number; c: CostNow }>();
export function costNow(harness: string): CostNow {
  const hit = nows.get(harness);
  if (hit && hit.ver === L.ver && Date.now() - hit.at < 5000) return hit.c;
  const now = Date.now(); const hour = new Date(now).getHours(); const left = daysLeftInMonth(now);
  const d15 = lastDays(15); const mk = monthStart(now);
  const month = sumDays(mk, harness);
  const rows = dayCosts(d15, harness);
  const projByMode: Proj[] = [];
  for (let i = 0; i < MODES.length; i++) projByMode.push(project(rows[i] ?? [], month.by[i] ?? 0, hour, left));
  const counted = (i: number): boolean => budget.counts.indexOf(MODES[i] ?? "unknown") >= 0;
  const c: CostNow = { today: sumDays([todayKey()], harness), week: sumDays(lastDays(7), harness), month, projByMode,
    proj: sumProj(projByMode, (i: number) => true), projCounted: sumProj(projByMode, counted), budget,
    bs: budgetState(budget, month, projByMode.map((p: Proj) => p.month)) };
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
