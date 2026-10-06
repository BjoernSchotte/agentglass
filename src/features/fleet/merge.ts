// agentglass — the exact fleet merge (fleet spec 13, 14): hashed Claude message ownership across hosts, shadow ledger
// entries from exact reports, re-pricing with this machine's table and re-bucketing into its time zone
// SPDX-License-Identifier: Apache-2.0
// Every occurrence of a message (local logs from the ledger's owned ids, remote sessions from their reports' own rows)
// competes for the message: the smallest order key wins, ties go to the smaller host id, then the smaller session key.
// Each host already counted a message once among its own logs, so only cross-host copies lose here. A losing remote
// occurrence is taken out of its session's shadow entry (exactly what its host booked for it); a losing local
// occurrence goes into a correction entry for its log (negative amounts: the local ledger itself stays untouched).
// Copies carry identical usage, so which occurrence wins changes attribution, never the totals.
import { type Acc, type Day, newAcc, newDay, mkey, reprice } from "../usage/record.ts";
import { resolve, cost } from "../usage/pricing.ts";
import { type Bill, MODES } from "../usage/billing.ts";
import { str, obj } from "../../util/json.ts";
import { type DayRow, type HostReport, type OwnRow, type SessRow, ownSess } from "./model.ts";

export interface Occ { host: string; hostId: string; key: string; row: OwnRow }
// a before b in the ownership order (spec 13.2)
function first(k1: number, id1: string, s1: string, k2: number, id2: string, s2: string): boolean {
  if (k1 !== k2) return k1 < k2;
  if (id1 !== id2) return id1 < id2;
  return s1 < s2;
}
// per hashed id, the occurrence that owns it
export function ownerIndex(occs: Occ[]): Map<string, Occ> {
  const m = new Map<string, Occ>();
  for (const o of occs) { const b = m.get(o.row.h); if (!b || first(o.row.key, o.hostId, o.key, b.row.key, b.hostId, b.key)) m.set(o.row.h, o); }
  return m;
}

// ── time zones (spec 14): (day, hour) on the host → on this machine, shifted by whole hours ──
function hoursOf(shiftMin: number): number { return Math.round(shiftMin / 60); } // a half-hour zone rounds (documented)
const SHIFT = new Map<string, string>(); // "<day>|<hour>|<shiftH>" → "<day>|<hour>"
export function shiftDH(day: string, hour: number, shiftMin: number): { d: string; h: number } {
  const sh = hoursOf(shiftMin); if (!sh) return { d: day, h: hour };
  const k = day + "|" + String(hour) + "|" + String(sh); const hit = SHIFT.get(k);
  if (hit !== undefined) { const i = hit.indexOf("|"); return { d: hit.slice(0, i), h: Number(hit.slice(i + 1)) }; }
  const t = Date.parse(day + "T00:00:00.000Z"); if (!(t > 0)) return { d: day, h: hour };
  const x = new Date(t + (hour + sh) * 3600000);
  const d = x.toISOString().slice(0, 10); const h = x.getUTCHours();
  if (SHIFT.size > 50000) SHIFT.clear();
  SHIFT.set(k, d + "|" + String(h));
  return { d, h };
}

// ── shadow entries (spec 13.4): an Acc per exact remote session, built from its day rows, never in the ledger ──
function dayOf(a: Acc, k: string): Day { let d = a.days.get(k); if (!d) { d = newDay(); a.days.set(k, d); } return d; }
function n(s: string | undefined): number { const v = Number(s ?? ""); return isFinite(v) ? v : 0; }
function addCostTo(a: Acc, d: Day, h: number, prov: string, model: string, usd: number): void {
  a.cost = a.cost + usd; d.cost = d.cost + usd;
  d.cp.set(prov, (d.cp.get(prov) ?? 0) + usd);
  if (h >= 0 && h < 24) d.hc[h] = (d.hc[h] ?? 0) + usd;
  if (model) { const k = mkey(model); let r = d.mt.get(k); if (!r) { r = [0, 0, 0, 0, 0]; d.mt.set(k, r); } r[4] = (r[4] ?? 0) + usd; }
}
function addUnk(a: Acc, d: Day, model: string, tok: number): void {
  a.unk = a.unk + tok; d.unk = d.unk + tok;
  const k = mkey(model); const v = (d.um.get(k) ?? 0) + tok;
  if (Math.abs(v) > 1e-9) d.um.set(k, v); else d.um.delete(k);
}
function addTok(a: Acc, d: Day, model: string, t: number[]): void {
  const i = t[0] ?? 0; const o = t[1] ?? 0; const c = t[2] ?? 0; const w = (t[3] ?? 0) + (t[4] ?? 0);
  a.inTok = a.inTok + i; a.outTok = a.outTok + o; a.cr = a.cr + c; a.cw = a.cw + w;
  d.inTok = d.inTok + i; d.outTok = d.outTok + o; d.cr = d.cr + c; d.cw = d.cw + w;
  const k = mkey(model); let r = d.mt.get(k); if (!r) { r = [0, 0, 0, 0, 0]; d.mt.set(k, r); }
  r[0] = (r[0] ?? 0) + i; r[1] = (r[1] ?? 0) + o; r[2] = (r[2] ?? 0) + c; r[3] = (r[3] ?? 0) + w;
}
export function shadowOf(r: SessRow, shiftMin: number): Acc {
  const a = newAcc(); a.ro = true;
  const b = obj(r.s["billing"]) ?? {}; a.bill = str(b["mode"]); a.plan = str(b["plan"]); a.billSrc = "session";
  for (const dr of r.days ?? []) addDayRow(a, dr, shiftMin);
  return a;
}
function addDayRow(a: Acc, dr: DayRow, shiftMin: number): void {
  for (const t of dr.tp) {
    const x = shiftDH(dr.d, n(t[0]), shiftMin); const prov = t[1] ?? ""; const model = t[2] ?? "";
    const d = dayOf(a, x.d); const tk = String(x.h) + "\t" + prov + "\t" + model;
    const tok = [n(t[3]), n(t[4]), n(t[5]), n(t[6]), n(t[7])]; const usd = n(t[8]);
    const r0 = d.tp.get(tk); const row = r0 ? r0 : [0, 0, 0, 0, 0, usd < 0 ? -1 : 0]; if (!r0) d.tp.set(tk, row);
    for (let i = 0; i < 5; i++) row[i] = (row[i] ?? 0) + (tok[i] ?? 0);
    addTok(a, d, model, tok);
    if (usd >= 0 && (row[5] ?? 0) >= 0) { row[5] = (row[5] ?? 0) + usd; addCostTo(a, d, x.h, prov, model, usd); }
    else addUnk(a, d, model, (tok[0] ?? 0) + (tok[1] ?? 0) + (tok[2] ?? 0) + (tok[3] ?? 0) + (tok[4] ?? 0));
  }
  for (const h of dr.hx) { const x = shiftDH(dr.d, n(h[0]), shiftMin); addCostTo(a, dayOf(a, x.d), x.h, h[1] ?? "", "", n(h[2])); }
  // the day-level parts carry no hour: they move with the day's noon
  if (!dr.um.length && !dr.unk && !dr.uc && !dr.tools && !dr.turns) return;
  const d = dayOf(a, shiftDH(dr.d, 12, shiftMin).d);
  for (const u of dr.um) addUnk(a, d, u[0] ?? "", n(u[1]));
  if (dr.unk > 0 && !dr.um.length) { a.unk = a.unk + dr.unk; d.unk = d.unk + dr.unk; }
  a.uc = a.uc + dr.uc; d.uc = d.uc + dr.uc; a.tools = a.tools + dr.tools; d.tools = d.tools + dr.tools; d.turns = d.turns + dr.turns;
}
// one message's booking out of an entry (sign -1: a losing remote occurrence from its shadow) or a negative into a
// correction entry (local); never below 0 for a shadow (a row its day rows do not hold: a window edge)
export function subtract(a: Acc, row: OwnRow, shiftMin: number): void {
  if (!row.n.length) return;
  const x = shiftDH(row.d, row.hr, shiftMin); const d = a.days.get(x.d); if (!d) return;
  const tk = String(x.h) + "\t" + row.prov + "\t" + row.m; const tp = d.tp.get(tk); if (!tp) return;
  const tok: number[] = []; for (let i = 0; i < 5; i++) { const v = Math.min(row.n[i] ?? 0, tp[i] ?? 0); tok.push(v); tp[i] = (tp[i] ?? 0) - v; }
  const neg: number[] = []; for (const v of tok) neg.push(-v);
  addTok(a, d, row.m, neg);
  if ((tp[5] ?? 0) >= 0) {
    const usd = Math.min(row.n[5] ?? 0, tp[5] ?? 0); if (usd > 0) { tp[5] = (tp[5] ?? 0) - usd; addCostTo(a, d, x.h, row.prov, row.m, -usd); }
  } else addUnk(a, d, row.m, -((tok[0] ?? 0) + (tok[1] ?? 0) + (tok[2] ?? 0) + (tok[3] ?? 0) + (tok[4] ?? 0)));
}
// a local losing occurrence: its booking as a negative amount, priced with the current table (the local ledger is)
function correct(a: Acc, row: OwnRow): void {
  if (!row.n.length) return;
  const d = dayOf(a, row.d); const tok: number[] = []; for (let i = 0; i < 5; i++) tok.push(-(row.n[i] ?? 0));
  addTok(a, d, row.m, tok);
  const r = resolve(row.m, row.prov);
  if (r) {
    const usd = cost(r.p, row.n[0] ?? 0, row.n[1] ?? 0, row.n[2] ?? 0, row.n[3] ?? 0, row.n[4] ?? 0);
    const tk = String(row.hr) + "\t" + row.prov + "\t" + row.m; const t0 = d.tp.get(tk); const tp = t0 ? t0 : [0, 0, 0, 0, 0, 0]; if (!t0) d.tp.set(tk, tp);
    for (let i = 0; i < 5; i++) tp[i] = (tp[i] ?? 0) + (tok[i] ?? 0);
    tp[5] = (tp[5] ?? 0) - usd;
    addCostTo(a, d, row.hr, row.prov, row.m, -usd);
  } else addUnk(a, d, row.m, -((row.n[0] ?? 0) + (row.n[1] ?? 0) + (row.n[2] ?? 0) + (row.n[3] ?? 0) + (row.n[4] ?? 0)));
}

// ── the merge ──
// a local Claude log: its session key (ties), its ownership rows (hash + key, every owned message), its billing mode
export interface LocalLog { path: string; skey: string; keys: OwnRow[]; bill: string }
export interface FleetHost { name: string; hostId: string; r: HostReport; shiftMin: number }
// one entry for the sums: an Acc and how its providers bill. host = the host's name ("" = a local correction)
export interface Shadow { host: string; key: string; a: Acc; bill: string; prov: Map<string, string> }
export interface Exact { accs: Shadow[]; removed: number; corrected: number; inexact: string[] }
export function modeOfShadow(x: Shadow, p: string): Bill { const m = x.prov.get(p) ?? x.bill; const i = MODES.indexOf(m as Bill); return MODES[i >= 0 ? i : MODES.length - 1] ?? "unknown"; }
// rowsOf: a local log's booked rows (the msgrows sidecar), asked only for logs that lose a message; null = unknown (the
// log is reported in `inexact`)
export function exactFleet(local: LocalLog[], localId: string, hosts: FleetHost[], reprice: boolean, rowsOf: (path: string) => OwnRow[] | null): Exact {
  // the owner per hash, without materializing occurrences: [key, host index (-1 local), session key]
  const bk = new Map<string, number>(); const bi = new Map<string, number>(); const bs = new Map<string, string>();
  const idOf = (i: number): string => i < 0 ? localId : (hosts[i]?.hostId ?? "");
  const offer = (h: string, key: number, i: number, sk: string): void => {
    const k0 = bk.get(h);
    if (k0 === undefined || first(key, idOf(i), sk, k0, idOf(bi.get(h) ?? -1), bs.get(h) ?? "")) { bk.set(h, key); bi.set(h, i); bs.set(h, sk); }
  };
  for (const l of local) for (const r of l.keys) offer(r.h, r.key, -1, l.skey);
  for (let i = 0; i < hosts.length; i++) { const fh = hosts[i]; if (!fh) continue; for (const o of fh.r.owned) { const sk = ownSess(o.key); for (const r of o.rows) offer(r.h, r.key, i, sk); } }
  const wins = (h: string, i: number, sk: string): boolean => bi.get(h) === i && bs.get(h) === sk;
  const out: Shadow[] = []; let removed = 0; let corrected = 0; const inexact: string[] = [];
  for (let i = 0; i < hosts.length; i++) {
    const fh = hosts[i]; if (!fh) continue;
    const om = new Map<string, OwnRow[]>(); for (const o of fh.r.owned) { const sk = ownSess(o.key); const p = om.get(sk); om.set(sk, p ? p.concat(o.rows) : o.rows); }
    for (const sr of fh.r.sessions) {
      if (!sr.days) continue;
      const a = shadowOf(sr, fh.shiftMin);
      const lost = new Set<string>();
      for (const r of om.get(sr.key) ?? []) if (!wins(r.h, i, sr.key)) { subtract(a, r, fh.shiftMin); lost.add(r.h); }
      removed += lost.size;
      if (reprice) repriceShadow(a);
      const pm = new Map<string, string>(); for (const p of sr.prov) pm.set(p[0] ?? "", p[1] ?? "");
      out.push({ host: fh.name, key: sr.key, a, bill: a.bill, prov: pm });
    }
  }
  for (const l of local) {
    let loses = false; for (const r of l.keys) if (!wins(r.h, -1, l.skey)) { loses = true; break; }
    if (!loses) continue;
    const rows = rowsOf(l.path); if (!rows) { inexact.push(l.path); continue; }
    const a = newAcc(); a.ro = true; const lost = new Set<string>();
    for (const r of rows) if (r.h && !wins(r.h, -1, l.skey)) { correct(a, r); lost.add(r.h); }
    corrected += lost.size;
    out.push({ host: "", key: l.path, a, bill: l.bill, prov: new Map<string, string>() });
  }
  return { accs: out, removed, corrected, inexact };
}
// re-price a shadow with this machine's table (spec 14); harness-reported cost (hx) has no tp row and stays as sent
export function repriceShadow(a: Acc): void { reprice(a); }
