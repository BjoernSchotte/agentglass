// agentglass — cost by billing mode over all sessions (today, 7 days, month), projections and the budget watch
// SPDX-License-Identifier: Apache-2.0
import { H } from "../../hooks.ts";
import { say } from "../../state.ts";
import { section } from "../../util/config.ts";
import { OS } from "../../platform/index.ts";
import { sessions, SG } from "../../model/sessions.ts";
import { ledger, LGEN } from "./ledger.ts";
import { type Acc, L, todayKey, lastDays } from "./record.ts";
import { PGEN } from "./pricing.ts";
import { type PRow, type SessAcc, priceRows } from "./pricerows.ts";
import { type Bill, MODES } from "./billing.ts";
import { modeOf } from "./bill-live.ts";
import { type ModeSum, type DayCost, type Budget, type BState, newSum, addDay, addSum, parseBudget, budgetState, stateOf, notifyOnce, projectToday, projectMonth, daysLeftInMonth, monthStart } from "./costs.ts";

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
// ── the TUI's all-harness sums, kept per local day (header widget, Stats) ──
// One aggregate per day of the window (this month + the last 15 days): its mode sums and per-mode hourly costs over every
// session. A refresh re-sums only the days a changed session has in the window (usually today), found by one cheap pass
// (entry object, offset, sidecar stamp, billing label, pid); a new day, a re-pricing, a changed session set, and every 60 s
// (the billing evidence behind modeOf is re-checked at that pace) re-sum them all.
// One-shot CLI runs (cost) and other harness filters keep the full sums: same values, summed day by day here (floating
// point association may differ in the last digit, never in a shown cent: summary-inc.check.ts).
interface DayAgg { m: ModeSum; dc: DayCost[] /* per mode */ }
interface SessSig { a: Acc | null; off: number; xm: number; mode: string; days: string[] /* its window days, as summed */ }
const INC = { on: false, key: "", at: 0, days: new Map<string, DayAgg>(), sig: new Map<string, SessSig>(), resums: 0 };
H.start.push(() => { INC.on = true; }); // the TUI; a one-shot run sums once anyway
function dayAggOf(k: string): DayAgg {
  const m = newSum(); const dc: DayCost[] = []; for (let i = 0; i < MODES.length; i++) dc.push({ key: k, cost: 0, hc: zeros24() });
  for (const s of sessions.values()) {
    const a = ledger.get(s.path); if (!a) continue;
    const d = a.days.get(k); if (!d) continue;
    addDay(m, d, (p: string): Bill => modeOf(s, p));
    if (d.cost <= 0) continue;
    for (const [p, c] of d.cp) {
      const x = dc[MODES.indexOf(modeOf(s, p))]; if (!x) continue;
      x.cost += c; const f = c / d.cost;
      for (let h = 0; h < 24; h++) x.hc[h] = (x.hc[h] ?? 0) + (d.hc[h] ?? 0) * f;
    }
  }
  INC.resums++;
  return { m, dc };
}
function windowDays(a: Acc, win: Set<string>): string[] { const o: string[] = []; for (const k of a.days.keys()) if (win.has(k)) o.push(k); return o; }
// brings INC.days up to date for the window
function incSync(win: string[], now: number): void {
  const ws = new Set<string>(win);
  const key = win.join(",") + "|" + String(LGEN.reapply) + "|" + String(PGEN.n) + "|" + String(SG.gen) + "|" + String(sessions.size);
  const all = key !== INC.key || now - INC.at >= 60000 || now < INC.at; INC.key = key; if (all) INC.at = now;
  const touched = new Set<string>();
  const seen = INC.sig;
  for (const s of sessions.values()) {
    const a = ledger.get(s.path) ?? null; const g = seen.get(s.path);
    const mode = s.bill + "|" + String(s.pid); // the label bill-live derives from the evidence modeOf reads
    if (g && g.a === a && (!a || (g.off === a.off && g.xm === a.xM)) && g.mode === mode) continue;
    const days = a ? windowDays(a, ws) : [];
    if (g) for (const k of g.days) touched.add(k); // what it added before (an entry restarted or moved)
    for (const k of days) touched.add(k);
    seen.set(s.path, { a, off: a ? a.off : 0, xm: a ? a.xM : 0, mode, days });
  }
  if (all) { INC.days.clear(); for (const k of win) INC.days.set(k, dayAggOf(k)); if (seen.size > sessions.size) for (const p of [...seen.keys()]) if (!sessions.has(p)) seen.delete(p); return; }
  for (const k of touched) if (ws.has(k)) INC.days.set(k, dayAggOf(k));
}
function incSum(keys: string[]): ModeSum { const m = newSum(); for (const k of keys) { const d = INC.days.get(k); if (d) addSum(m, d.m); } return m; }
function incRows(keys: string[]): DayCost[][] {
  const out: DayCost[][] = [];
  for (let i = 0; i < MODES.length; i++) { const r: DayCost[] = []; for (const k of keys) { const d = INC.days.get(k); const x = d ? d.dc[i] : undefined; r.push(x ? { key: k, cost: x.cost, hc: x.hc.slice() } : { key: k, cost: 0, hc: zeros24() }); } out.push(r); }
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
export const SUMMARY_TEST = { inc: (on: boolean): void => { INC.on = on; nows.clear(); sums.clear(); }, fresh: (): void => { nows.clear(); sums.clear(); }, resums: (): number => INC.resums };
export function costNow(harness: string): CostNow {
  const hit = nows.get(harness);
  if (hit && fresh(hit.ver, hit.at)) return hit.c;
  const now = Date.now(); const hour = new Date(now).getHours(); const left = daysLeftInMonth(now);
  const d15 = lastDays(15); const mk = monthStart(now); const inc = INC.on && harness === "";
  if (inc) { const win = mk.slice(); for (const k of d15) if (win.indexOf(k) < 0) win.push(k); incSync(win, now); }
  const month = inc ? incSum(mk) : sumDays(mk, harness);
  const rows = inc ? incRows(d15) : dayCosts(d15, harness);
  const projByMode: Proj[] = [];
  for (let i = 0; i < MODES.length; i++) projByMode.push(project(rows[i] ?? [], month.by[i] ?? 0, hour, left));
  const counted = (i: number): boolean => budget.counts.indexOf(MODES[i] ?? "unknown") >= 0;
  let mtdAll = 0; let mtdCounted = 0;
  for (let i = 0; i < MODES.length; i++) { mtdAll += month.by[i] ?? 0; if (counted(i)) mtdCounted += month.by[i] ?? 0; }
  // sums project the summed series: one mode with a short history does not blank the total
  const projCounted = project(sumRows(rows, counted), mtdCounted, hour, left);
  const bs = budgetState(budget, month, projByMode.map((p: Proj) => p.month));
  bs.projected = projCounted.month; bs.state = stateOf(budget, bs.used, bs.projected);
  const c: CostNow = { today: inc ? incSum([todayKey()]) : sumDays([todayKey()], harness), week: inc ? incSum(lastDays(7)) : sumDays(lastDays(7), harness), month, projByMode,
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

// the price rows of the given days over every session (Stats subtitle counts, the price panel), harness "" = all;
// cached per ledger version and price table (≤ 5 s like the sums)
const prs = new Map<string, { ver: number; at: number; pg: number; rows: PRow[] }>();
export function pricedRows(days: string[], harness: string): PRow[] {
  const key = harness + "|" + days.join(",");
  const hit = prs.get(key);
  if (hit && hit.pg === PGEN.n && fresh(hit.ver, hit.at)) return hit.rows;
  const list: SessAcc[] = [];
  for (const s of sessions.values()) { if (harness && s.h !== harness) continue; const a = ledger.get(s.path); if (a) list.push({ a, h: s.h }); }
  const rows = priceRows(list, days);
  prs.set(key, { ver: L.ver, at: Date.now(), pg: PGEN.n, rows });
  return rows;
}
// models with usage in the period per non-default source: "2 user · 1 alias · 1 gw" ("" = none)
export function sourceCounts(days: string[]): string {
  let u = 0; let al = 0; let g = 0;
  for (const r of pricedRows(days, "")) { if (r.src === "user") u++; else if (r.src === "alias") al++; else if (r.src === "gateway") g++; }
  const ps: string[] = [];
  if (u) ps.push(String(u) + " user"); if (al) ps.push(String(al) + " alias"); if (g) ps.push(String(g) + " gw");
  return ps.join(" · ");
}
