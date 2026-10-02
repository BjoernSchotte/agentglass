// agentglass — cost by billing mode: sums, mode-aware money format, the unpriced breakdown, projection and budget (pure)
// SPDX-License-Identifier: Apache-2.0
import { type Bill, MODES, tag } from "./billing.ts";
import { type Day } from "./record.ts";

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
