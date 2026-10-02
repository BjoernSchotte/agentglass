// agentglass — cost by billing mode: sums, mode-aware money format, the unpriced breakdown, projection and budget (pure)
// SPDX-License-Identifier: Apache-2.0
import { type Bill, MODES, tag } from "./billing.ts";
import { type Day, dayKey } from "./record.ts";

export function kfmt(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "K";
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e8 ? 1 : 0) + "M";
  return (n / 1e9).toFixed(1) + "B";
}
export function grp(n: number): string {
  const s = String(Math.round(n)); let out = "";
  for (let i = 0; i < s.length; i++) { if (i > 0 && (s.length - i) % 3 === 0) out += ","; out += s.charAt(i); }
  return out;
}

// by[i] = cost of MODES[i]; unk/um = unpriced tokens (per model), uc = credits without a rate
export interface ModeSum { by: number[]; unk: number; um: Map<string, number>; uc: number }
export function newSum(): ModeSum { return { by: [0, 0, 0, 0, 0], unk: 0, um: new Map<string, number>(), uc: 0 }; }
// one session-day into the sum; mode resolves each provider's cost (pi/OpenCode per provider, else the session's mode)
export function addDay(m: ModeSum, d: Day, mode: (prov: string) => Bill): void {
  for (const [p, c] of d.cp) { const i = MODES.indexOf(mode(p)); if (i >= 0) m.by[i] = (m.by[i] ?? 0) + c; }
  m.unk = m.unk + d.unk; m.uc = m.uc + d.uc;
  for (const [k, n] of d.um) m.um.set(k, (m.um.get(k) ?? 0) + n);
}
export function addSum(m: ModeSum, o: ModeSum): void {
  for (let i = 0; i < MODES.length; i++) m.by[i] = (m.by[i] ?? 0) + (o.by[i] ?? 0);
  m.unk = m.unk + o.unk; m.uc = m.uc + o.uc;
  for (const [k, n] of o.um) m.um.set(k, (m.um.get(k) ?? 0) + n);
}
export function total(m: ModeSum): number { let t = 0; for (const c of m.by) t += c; return t; }
// the only mode with cost, "" when mixed or none
export function single(m: ModeSum): Bill | "" {
  let r: Bill | "" = "";
  for (let i = 0; i < MODES.length; i++) if ((m.by[i] ?? 0) > 0) { if (r) return ""; r = MODES[i] ?? "unknown"; }
  return r;
}
// only API-key spend is real money as shown; everything else is a list-price estimate (≈)
export function money(c: number, bill: Bill | ""): string { return (bill === "api" ? "$" : "≈$") + (c < 1000 ? c.toFixed(2) : grp(c)); }
export function moneyTag(c: number, bill: Bill): string { return money(c, bill) + " " + tag(bill); }
// "$3.10 spend + ≈$9.20 plan"; narrow: the total alone
export function split(m: ModeSum, narrow: boolean): string {
  const one = single(m);
  if (narrow || !one && total(m) === 0) return money(total(m), one);
  if (one) return moneyTag(total(m), one);
  const parts: string[] = [];
  for (let i = 0; i < MODES.length; i++) if ((m.by[i] ?? 0) > 0) parts.push(moneyTag(m.by[i] ?? 0, MODES[i] ?? "unknown"));
  return parts.join(" + ");
}
// "gpt-x 900K · custom 300K · +2 models · kiro 120 credits (set kiroCreditUsd)", "" when nothing is unpriced
export function unpricedLine(m: ModeSum, top: number): string {
  const ms = [...m.um.entries()].filter((e) => e[1] > 0);
  ms.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const parts: string[] = [];
  for (let i = 0; i < ms.length && i < top; i++) { const e = ms[i]; if (e) parts.push(e[0] + " " + kfmt(e[1])); }
  const rest = ms.length - Math.min(top, ms.length);
  if (rest > 0) parts.push("+" + String(rest) + (rest === 1 ? " model" : " models"));
  if (m.uc > 0) parts.push("kiro " + kfmt(m.uc) + " credits (set kiroCreditUsd)");
  return parts.join(" · ");
}

// ── projection ──
// one local day summed over sessions (for one mode or a set of modes): its cost and cost per local hour
export interface DayCost { key: string; cost: number; hc: number[] }
const MIN_DAYS = 3;
// today: spent so far + the 14-day hourly profile for the hours still ahead; the current hour adds what its profile
// has left beyond what it already spent. hist = the days before today (oldest first); -1 = not enough history
export function projectToday(hist: DayCost[], today: DayCost, hour: number): number {
  const act = hist.filter((d) => d.cost > 0);
  if (act.length < MIN_DAYS) return -1;
  const h0 = Math.max(0, Math.min(23, Math.floor(hour)));
  const prof = (h: number): number => { let t = 0; for (const d of act) t += d.hc[h] ?? 0; return t / act.length; };
  let r = today.cost;
  for (let h = h0 + 1; h < 24; h++) r += prof(h);
  return r + Math.max(0, prof(h0) - (today.hc[h0] ?? 0));
}
// month: month-to-date + today's projected remainder + days left × the mean daily cost since the first day with data in
// hist (the last complete days, oldest first; leading empty days do not dilute the mean); -1 = not enough history
export function projectMonth(hist: DayCost[], mtd: number, todayProj: number, todaySpent: number, daysLeft: number): number {
  let first = -1; let act = 0;
  for (let i = 0; i < hist.length; i++) { const d = hist[i]; if (d && d.cost > 0) { if (first < 0) first = i; act++; } }
  if (act < MIN_DAYS) return -1;
  let sum = 0; for (let i = first; i < hist.length; i++) sum += hist[i]?.cost ?? 0;
  const mean = sum / (hist.length - first);
  return mtd + (todayProj >= 0 ? Math.max(0, todayProj - todaySpent) : 0) + daysLeft * mean;
}
function noonOf(now: number): number { const t = new Date(now); return now - ((t.getHours() * 60 + t.getMinutes()) * 60 + t.getSeconds()) * 1000 - t.getMilliseconds() + 43200000; }
// days after today in this local month (noon steps: DST shifts can't skip or repeat a day)
export function daysLeftInMonth(now: number): number {
  const noon = noonOf(now); const mo = dayKey(new Date(noon)).slice(0, 7);
  let n = 0; while (n < 31 && dayKey(new Date(noon + (n + 1) * 86400000)).slice(0, 7) === mo) n++;
  return n;
}
// day keys from the 1st of this local month through today
export function monthStart(now: number): string[] {
  const noon = noonOf(now); const mo = dayKey(new Date(noon)).slice(0, 7); const out: string[] = [];
  for (let i = 0; i < 31; i++) { const k = dayKey(new Date(noon - i * 86400000)); if (k.slice(0, 7) !== mo) break; out.push(k); }
  return out.reverse();
}
