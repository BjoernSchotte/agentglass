// agentglass — the exact fleet merge (fleet spec 13, 14): hashed Claude message ownership across hosts, shadow ledger
// entries from exact reports, re-pricing with this machine's table and re-bucketing into its time zone
// SPDX-License-Identifier: Apache-2.0
// Every occurrence of a message (local logs from the ledger's owned ids, remote sessions from their reports' own rows)
// competes for the message: the smallest order key wins, ties go to the smaller host id, then the smaller session key.
// Each host already counted a message once among its own logs, so only cross-host copies lose here. A losing remote
// occurrence is taken out of its session's shadow entry (exactly what its host booked for it); a losing local
// occurrence goes into a correction entry for its log (negative amounts: the local ledger itself stays untouched).
// Copies carry identical usage, so which occurrence wins changes attribution, never the totals.
import { type Acc, type Day, NO_SA, saOf, saW, newAcc, newDay, mkey, reprice, lastDays } from "../usage/record.ts";
import { SA_N, SA_LU, SA_LC, SA_L, SA_C, SA_T } from "../usage/skillrec.ts";
import { monthStart } from "../usage/costs.ts";
import { resolve, cost } from "../usage/pricing.ts";
import { type Bill, MODES } from "../usage/billing.ts";
import { str, obj } from "../../util/json.ts";
import { type DayRow, type HostReport, type OwnRow, type SessRow, ownSess } from "./model.ts";
import { type OwnChunk, hashCount, hashFind, fillRow, lenOf } from "./ownc.ts";

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

// the days a viewer's cost figures need (this month, the last 15 days for the projection) plus a day on each side for
// the time-zone shift: what a snapshot carries day rows for, and what a local correction covers
const DAY_MS = 86400000;
export function costDays(now: number): Set<string> {
  const o = new Set<string>(); for (const k of monthStart(now)) o.add(k); for (const k of lastDays(16)) o.add(k);
  const t = new Date(now + DAY_MS); o.add(t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"));
  const ks = [...o].sort(); const f = ks[0] ?? ""; const p = new Date(Date.parse(f + "T12:00:00") - DAY_MS);
  o.add(p.getFullYear() + "-" + String(p.getMonth() + 1).padStart(2, "0") + "-" + String(p.getDate()).padStart(2, "0"));
  return o;
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
  if (dr.sa.length) { // skill rows carry no hour: with the day's noon (skill-usage 6.15)
    const d = dayOf(a, shiftDH(dr.d, 12, shiftMin).d); const sa = saW(d);
    for (const r of dr.sa) {
      const k = (r[0] ?? "") + "\t" + (r[1] ?? "") + "\t" + (r[2] ?? ""); const x0 = sa.get(k);
      const x = x0 ? x0 : saZero(); if (!x0) sa.set(k, x);
      for (let i = 0; i < SA_N; i++) x[i] = (x[i] ?? 0) + n(r[3 + i]);
    }
  }
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
// a day a shadow lost every booking of (a copy another host or this machine owns): nothing any sum reads is left in it
// (tools and turns stay with their host's rows: no figure reads them from a shadow)
function emptyDay(d: Day): boolean { return d.inTok === 0 && d.outTok === 0 && d.cr === 0 && d.cw === 0 && Math.abs(d.cost) < 1e-9 && Math.abs(d.unk) < 1e-9 && d.uc === 0 && d.um.size === 0; }
export function prune(a: Acc): void { for (const [k, d] of [...a.days.entries()]) if (emptyDay(d)) a.days.delete(k); }

// ── skills (skill-usage 6.15): a skill's tokens are shares of its requests' tokens, booked per day, provider and model
// (Day.sa), not per message. A losing occurrence takes out of the skill rows of its (host day, provider, model) the part
// of each bucket it took out of the session's tokens there: exact when an occurrence loses a whole bucket (a copy of a
// log loses all of its messages to the other host: the usual case), in proportion when it loses part of one. Load
// counts follow the day's tokens. ──
// lost tokens per "<day>\t<provider>\t<model>": [in, cacheRead, write5m, write1h]
export function addLost(m: Map<string, number[]>, row: OwnRow): void {
  if (!row.n.length) return;
  const k = row.d + "\t" + row.prov + "\t" + row.m; let x = m.get(k); if (!x) { x = [0, 0, 0, 0]; m.set(k, x); }
  x[0] = (x[0] ?? 0) + (row.n[0] ?? 0); x[1] = (x[1] ?? 0) + (row.n[2] ?? 0); x[2] = (x[2] ?? 0) + (row.n[3] ?? 0); x[3] = (x[3] ?? 0) + (row.n[4] ?? 0);
}
// what a session's (day, provider, model) buckets held: [in, cacheRead, write5m, write1h]
function had(m: Map<string, number[]>, d: string, prov: string, model: string, t: number[]): void {
  const k = d + "\t" + prov + "\t" + model; let x = m.get(k); if (!x) { x = [0, 0, 0, 0]; m.set(k, x); }
  x[0] = (x[0] ?? 0) + (t[0] ?? 0); x[1] = (x[1] ?? 0) + (t[1] ?? 0); x[2] = (x[2] ?? 0) + (t[2] ?? 0); x[3] = (x[3] ?? 0) + (t[3] ?? 0);
}
function lostShare(lost: number[] | undefined, held: number[] | undefined, i: number): number {
  const l = lost ? lost[i] ?? 0 : 0; const h = held ? held[i] ?? 0 : 0;
  return l <= 0 ? 0 : h <= 0 ? 1 : Math.min(1, l / h);
}
// the part of one skill row (x, at its host day) that goes with the lost tokens: per bucket of load, carry and tail; load
// counts in proportion to the day's tokens (rounded: whole loads)
function lostPart(x: number[], prov: string, model: string, day: string, lost: Map<string, number[]>, held: Map<string, number[]>, dayFrac: number): number[] {
  const o: number[] = []; for (let i = 0; i < SA_N; i++) o.push(0);
  if (!prov && !model) { for (let i = SA_LU; i <= SA_LC; i++) o[i] = Math.round((x[i] ?? 0) * dayFrac); return o; }
  const k = day + "\t" + (prov.startsWith("=") ? prov.slice(1) : prov) + "\t" + model; const lo = lost.get(k); const he = held.get(k);
  for (let b = 0; b < 4; b++) { const f = lostShare(lo, he, b); for (const at of [SA_L, SA_C, SA_T]) o[at + b] = (x[at + b] ?? 0) * f; }
  return o;
}
function dayFracOf(lost: Map<string, number[]>, held: Map<string, number[]>, day: string): number {
  let l = 0; let h = 0; const p = day + "\t";
  for (const [k, v] of held) if (k.startsWith(p)) h += (v[0] ?? 0) + (v[1] ?? 0) + (v[2] ?? 0) + (v[3] ?? 0);
  for (const [k, v] of lost) if (k.startsWith(p)) l += (v[0] ?? 0) + (v[1] ?? 0) + (v[2] ?? 0) + (v[3] ?? 0);
  return l <= 0 ? 0 : h <= 0 ? 1 : Math.min(1, l / h);
}
// x − p per slot, never below 0; true = nothing left
function takeOut(x: number[], p: number[]): boolean { for (let i = 0; i < SA_N; i++) x[i] = Math.max(0, (x[i] ?? 0) - (p[i] ?? 0)); return zero(x); }
function saZero(): number[] { const o: number[] = []; for (let i = 0; i < SA_N; i++) o.push(0); return o; }
function zero(x: number[]): boolean { for (const v of x) if (Math.abs(v) > 1e-9) return false; return true; }
// a shadow's skill rows after its lost occurrences (lost, by host day): what its day rows held, then the lost parts out
export function shadowSkills(a: Acc, ds: DayRow[], lost: Map<string, number[]>, shiftMin: number): void {
  if (!lost.size) return;
  const held = new Map<string, number[]>();
  for (const dr of ds) for (const t of dr.tp) had(held, dr.d, t[1] ?? "", t[2] ?? "", [n(t[3]), n(t[5]), n(t[6]), n(t[7])]);
  for (const dr of ds) {
    if (!dr.sa.length) continue;
    const d = a.days.get(shiftDH(dr.d, 12, shiftMin).d); if (!d || saOf(d) === NO_SA) continue;
    const df = dayFracOf(lost, held, dr.d);
    for (const r of dr.sa) {
      const k = (r[0] ?? "") + "\t" + (r[1] ?? "") + "\t" + (r[2] ?? ""); const x = d.sa.get(k); if (!x) continue;
      const src: number[] = []; for (let i = 0; i < SA_N; i++) src.push(n(r[3 + i]));
      const p = lostPart(src, r[1] ?? "", r[2] ?? "", dr.d, lost, held, df);
      if (takeOut(x, p)) d.sa.delete(k);
    }
  }
}
// a local log's skill rows into its correction entry, negative: the part that goes with its lost messages
export const LOCAL_SKILLS = { acc: (path: string): Acc | null => null }; // the log's ledger entry (hosts.ts sets it)
export function correctSkills(c: Acc, local: Acc, lost: Map<string, number[]>): void {
  if (!lost.size) return;
  const held = new Map<string, number[]>();
  for (const [dk, d] of local.days) for (const [tk, r] of d.tp) { const t1 = tk.indexOf("\t"); const t2 = tk.indexOf("\t", t1 + 1); had(held, dk, tk.slice(t1 + 1, t2), tk.slice(t2 + 1), [r[0] ?? 0, r[2] ?? 0, r[3] ?? 0, r[4] ?? 0]); }
  for (const [dk, d] of local.days) {
    if (saOf(d) === NO_SA) continue;
    const df = dayFracOf(lost, held, dk);
    for (const [k, x] of d.sa) {
      const t1 = k.indexOf("\t"); const t2 = k.indexOf("\t", t1 + 1);
      const p = lostPart(x, k.slice(t1 + 1, t2), k.slice(t2 + 1), dk, lost, held, df); if (zero(p)) continue;
      const cs = saW(dayOf(c, dk));
      const y0 = cs.get(k); const y = y0 ? y0 : saZero(); if (!y0) cs.set(k, y);
      for (let i = 0; i < SA_N; i++) y[i] = (y[i] ?? 0) - (p[i] ?? 0);
    }
  }
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
// a local Claude log: its session key (ties), its owned messages (hs: hash ids, ks: order keys, in the order the ledger
// claimed them: they only grow), its billing mode, its read offset (its booked rows move only with it)
export interface LocalLog { path: string; skey: string; hs: number[]; ks: number[]; bill: string; off: number } // hs: hash ids (ownc.ts)
export interface FleetHost { name: string; hostId: string; r: HostReport; shiftMin: number }
// one entry for the sums: an Acc and how its providers bill. host = the host's name ("" = a local correction)
export interface Shadow { host: string; key: string; a: Acc; bill: string; prov: Map<string, string> }
export interface Exact { accs: Shadow[]; removed: number; corrected: number; inexact: string[] }
export function modeOfShadow(x: Shadow, p: string): Bill { const m = x.prov.get(p) ?? x.bill; const i = MODES.indexOf(m as Bill); return MODES[i >= 0 ? i : MODES.length - 1] ?? "unknown"; }
// what a merge keeps for the next one (the TUI merges again whenever a report or the local ledger moved): the hosts'
// owner index, extended by the rows a report appended (a host's own rows only grow; anything else rebuilds it), each
// local log's hashes the hosts also hold and what it wins or loses (redone as the log grows or the owners of its hashes
// change), each shadow and correction entry with exactly what it was built from (its day rows, the hashes it lost). A
// merge then costs what moved, not every message of every host again.
// The owner index is in columns by hash id (ownc.ts): ok = the owner's order key, oi = its host index (-2 = no host holds
// the hash), os = its session key (an id into sks)
interface ShadowMemo { days: DayRow[]; lost: string; sh: Shadow; n: number }
interface LocalMemo { hs: number[]; n: number; hits: number[]; lost: number[]; lostJ: string; built: string; stealH: number[]; stealW: string[]; off: number; sh: Shadow | null; nl: number; inexact: boolean; done: boolean }
export interface XCache { mode: string; sig: string; steal: Map<number, string>; ok: Float64Array; oi: Int32Array; os: Int32Array; sks: string[]; ski: Map<string, number>; om: Map<string, OwnChunk[]>; parts: Map<string, OwnChunk[]>; shadows: Map<string, ShadowMemo>; logs: Map<string, LocalMemo> }
export function newXCache(): XCache { return { mode: "", sig: "\u0000", steal: new Map<number, string>(), ok: new Float64Array(0), oi: new Int32Array(0), os: new Int32Array(0), sks: [], ski: new Map<string, number>(), om: new Map<string, OwnChunk[]>(), parts: new Map<string, OwnChunk[]>(), shadows: new Map<string, ShadowMemo>(), logs: new Map<string, LocalMemo>() }; }
// how kept merges went (checks): owner index rebuilt, or extended by appended rows
export const MSTAT = { full: 0, grown: 0 };
// a host part's chunks are the earlier ones plus new ones at the end (the same chunk objects: snap.ts applySnap concat)
function grew(prev: OwnChunk[], rows: OwnChunk[]): boolean { const n = prev.length; return rows.length >= n && (n === 0 || (rows[0] === prev[0] && rows[n - 1] === prev[n - 1])); }
// the index's columns cover every hash id there is (ids only grow; a new slot holds no owner)
function cover(c: XCache): void {
  const n = hashCount(); if (c.oi.length >= n) return;
  const cap = Math.max(1024, n * 2, c.oi.length * 2); const ok = new Float64Array(cap); const oi = new Int32Array(cap); const os = new Int32Array(cap);
  for (let i = 0; i < c.oi.length; i++) { ok[i] = c.ok[i] ?? 0; oi[i] = c.oi[i] ?? -2; os[i] = c.os[i] ?? 0; }
  for (let i = c.oi.length; i < cap; i++) oi[i] = -2;
  c.ok = ok; c.oi = oi; c.os = os;
}
function held(c: XCache, id: number): boolean { const i = Number(id); return i >= 0 && i < c.oi.length && (c.oi[i] ?? -2) !== -2; }
function skId(c: XCache, k: string): number { const v = c.ski.get(k); if (v !== undefined) return v; c.ski.set(k, c.sks.length); c.sks.push(k); return c.sks.length - 1; }
// a local log's booked rows (the msgrows sidecar); done = false: not ready yet (a sidecar being rebuilt in slices: ask
// again); ok = false: unknown (the log is reported in `inexact`)
export interface LocalRows { rows: OwnRow[]; ok: boolean; done: boolean }
// ── the merge as a job (fleet follow-ups): the TUI runs it in time slices (step), a CLI run at once (exactFleet). It
// works on the inputs it started with (reports never change in place; a newer one merges in the next job) ──
const P_INDEX = 0; const P_LOCAL = 1; const P_SHADOW = 2; const P_CORR = 3; const P_DONE = 4;
interface Append { i: number; sk: string; pk: string; rows: OwnChunk[]; from: number }
export interface MergeJob {
  c: XCache; local: LocalLog[]; localId: string; hosts: FleetHost[]; reprice: boolean; rowsOf: (path: string, until: number) => LocalRows; days: Set<string>; dsig: string;
  full: boolean; appends: Append[]; ph: number; a: number; b: number; ci: number; ri: number; // cursors of the phase
  rowsMoved: Set<string>; dirty: Set<string>; added: Set<number>; owner: Set<number>; stealMoved: Set<string>;
  loses: number[]; seenL: Set<string>; keep: Set<string>; out: Shadow[]; removed: number; corrected: number; inexact: string[];
  sb: ShadowBuild | null; cb: CorrBuild | null; // an entry half built when a slice ended
  done: number; total: number; x: Exact | null;
}
// a shadow being built (its session's chunks, the hashes it loses, where the subtraction is) and a correction (its log's
// rows, where it is): a session or log of thousands of messages spans slices
interface ShadowBuild { mk: string; ds: DayRow[]; a: Acc; ls: Set<number>; lk: string; rows: OwnChunk[]; ci: number; ri: number; lt: Map<string, number[]> } // lt: lost tokens (skills)
interface CorrBuild { rows: OwnRow[]; i: number; a: Acc; lost: Set<number>; lt: Map<string, number[]> }
// a new job: which of the hosts' rows moved since the last merge (appended rows, a reset or a gone part rebuilds the index).
// days: the days a local correction covers (costDays: what the hosts' day rows cover too; empty = every day)
export function mergeStart(local: LocalLog[], localId: string, hosts: FleetHost[], reprice: boolean, rowsOf: (path: string, until: number) => LocalRows, xc: XCache, sig: string, pv: string, days: Set<string> = new Set<string>()): MergeJob {
  const c = xc;
  const mode = (reprice ? "r" : "n") + "\t" + localId + "\t" + pv;
  if (c.mode !== mode) { c.mode = mode; c.sig = "\u0000"; c.shadows.clear(); c.logs.clear(); c.steal.clear(); } // other prices, another viewer: every entry again
  let full = c.sig !== sig;
  const appends: Append[] = [];
  if (!full) {
    const seen = new Set<string>();
    for (let i = 0; i < hosts.length && !full; i++) {
      const fh = hosts[i]; if (!fh) continue;
      for (const o of fh.r.owned) {
        const pk = String(i) + "\t" + o.key; seen.add(pk); const prev = c.parts.get(pk);
        if (prev === o.rows) continue;
        if (prev && !grew(prev, o.rows)) { full = true; break; } // a reset part
        appends.push({ i, sk: ownSess(o.key), pk, rows: o.rows, from: prev ? prev.length : 0 });
      }
    }
    if (!full) for (const pk of c.parts.keys()) if (!seen.has(pk)) { full = true; break; } // a part gone
  }
  if (full) MSTAT.full++; else if (appends.length) MSTAT.grown++;
  if (full) { c.sig = sig; c.steal.clear(); c.oi = new Int32Array(0); c.ok = new Float64Array(0); c.os = new Int32Array(0); c.sks = []; c.ski = new Map<string, number>(); c.om = new Map<string, OwnChunk[]>(); c.parts = new Map<string, OwnChunk[]>(); } // om: "<host index>\t<session key>" → its chunks
  cover(c);
  // progress: index parts (or appends), local logs, sessions, corrections (at most one per local log)
  let parts = 0; if (full) { for (const fh of hosts) parts += fh.r.owned.length; } else parts = appends.length;
  let sess = 0; for (const fh of hosts) sess += fh.r.sessions.length;
  let dsig = ""; if (days.size) { const ks = [...days].sort(); dsig = (ks[0] ?? "") + "~" + (ks[ks.length - 1] ?? "") + "#" + String(ks.length); } // a correction is redone when its days move (midnight)
  return { c, local, localId, hosts, reprice, rowsOf, days, dsig, full, appends, ph: P_INDEX, a: 0, b: 0, ci: 0, ri: 0,
    rowsMoved: new Set<string>(), dirty: new Set<string>(), added: new Set<number>(), owner: new Set<number>(), stealMoved: new Set<string>(),
    loses: [], seenL: new Set<string>(), keep: new Set<string>(), out: [], removed: 0, corrected: 0, inexact: [], sb: null, cb: null,
    done: 0, total: parts + 2 * local.length + sess, x: null };
}
// one slice of the job, until the clock passes `until` (a step always makes some progress); true = finished (j.x)
export function mergeStep(j: MergeJob, until: number): boolean {
  const c = j.c; const hosts = j.hosts; const local = j.local;
  const idOf = (i: number): string => { const x = Number(i); return x < 0 ? j.localId : (hosts[x]?.hostId ?? ""); };
  let did = false; // a step always makes some progress: the clock is asked only after the first unit of work
  const late = (): boolean => did && Date.now() >= until;
  // offer occurrence (hash id h, order key, host index i, session key id sk) for h; true = it owns h now
  const offer = (h: number, key: number, i: number, sk: number): boolean => {
    const x = Number(h);
    if (held(c, x) && !first(key, idOf(i), String(c.sks[Number(sk)] ?? ""), Number(c.ok[x] ?? 0), idOf(Number(c.oi[x] ?? -1)), String(c.sks[Number(c.os[x] ?? 0)] ?? ""))) return false;
    c.ok[x] = key; c.oi[x] = i; c.os[x] = sk; return true;
  };
  let n = 0; // rows since the clock was read last
  if (j.ph === P_INDEX && j.full) {
    for (; j.a < hosts.length; j.a++, j.b = 0) {
      const fh = hosts[j.a]; if (!fh) continue; const i = j.a;
      for (; j.b < fh.r.owned.length; j.b++, j.ci = 0, j.ri = 0) {
        const o = fh.r.owned[j.b]; if (!o) continue;
        const sk = ownSess(o.key); const skx = skId(c, sk);
        if (j.ci === 0 && j.ri === 0) { const ok = String(i) + "\t" + sk; const p = c.om.get(ok); c.om.set(ok, p ? p.concat(o.rows) : o.rows); c.parts.set(String(i) + "\t" + o.key, o.rows); }
        for (; j.ci < o.rows.length; j.ci++, j.ri = 0) {
          const ch = o.rows[j.ci]; if (!ch) continue;
          for (; j.ri < ch.n; j.ri++) {
            const h = Number(ch.h[j.ri] ?? -1); if (h >= 0) offer(h, Number(ch.k[j.ri] ?? 0), i, skx);
            did = true; if (++n >= 2048) { n = 0; if (late()) { j.ri++; return false; } }
          }
        }
        j.done++;
      }
    }
    j.ph = P_LOCAL; j.a = 0;
  } else if (j.ph === P_INDEX) {
    for (; j.a < j.appends.length; j.a++, j.ci = 0, j.ri = 0) {
      const ap = j.appends[j.a]; if (!ap) continue;
      const mk = String(ap.i) + "\t" + ap.sk; const tail = ap.rows.slice(ap.from); const skx = skId(c, ap.sk);
      if (j.ci === 0 && j.ri === 0) { c.parts.set(ap.pk, ap.rows); const p = c.om.get(mk); c.om.set(mk, p ? p.concat(tail) : tail); j.rowsMoved.add(mk); }
      for (; j.ci < tail.length; j.ci++, j.ri = 0) {
        const ch = tail[j.ci]; if (!ch) continue;
        for (; j.ri < ch.n; j.ri++) {
          const h = Number(ch.h[j.ri] ?? -1); if (h < 0) continue;
          const had = held(c, h); const pi = Number(c.oi[h] ?? -2); const ps = String(c.sks[Number(c.os[h] ?? 0)] ?? "");
          if (offer(h, Number(ch.k[j.ri] ?? 0), ap.i, skx)) { if (!had) j.added.add(h); else { j.owner.add(h); j.dirty.add(String(pi) + "\t" + ps); } }
          did = true; if (++n >= 2048) { n = 0; if (late()) { j.ri++; return false; } }
        }
      }
      j.done++;
    }
    j.ph = P_LOCAL; j.a = 0;
  }
  // the local side: only the local messages some host also holds compete (any other one is this machine's alone: nothing
  // to decide, and 200 k local ids stay out of the index). c.steal: hash id → the host occurrence a local copy beats
  // ("<host index>\t<session key>"), kept across merges: a log's part changes only when the log is redone; stealMoved: the
  // host sessions whose stolen hashes changed
  const steal = c.steal;
  const unsteal = (m: LocalMemo): void => { for (let q = 0; q < m.stealH.length; q++) { const h = Number(m.stealH[q] ?? -1); const w = m.stealW[q] ?? ""; if (steal.get(h) === w) steal.delete(h); j.stealMoved.add(w); } m.stealH = []; m.stealW = []; };
  if (j.ph === P_LOCAL) {
    for (; j.a < local.length; j.a++) {
      if (late()) return false;
      const l = local[j.a]; if (!l) continue; j.seenL.add(l.path); j.done++; did = true;
      let m = c.logs.get(l.path);
      if (m && (m.hs !== l.hs || m.n > l.hs.length)) { unsteal(m); m = undefined; } // a re-read log: a new entry
      if (!m) { m = { hs: l.hs, n: 0, hits: [], lost: [], lostJ: "", built: "", stealH: [], stealW: [], off: -1, sh: null, nl: 0, inexact: false, done: false }; c.logs.set(l.path, m); }
      let redo = j.full || !m.done || m.n !== l.hs.length;
      if (j.full) { m.n = 0; m.hits = []; m.stealH = []; m.stealW = []; }
      else if (j.added.size || j.owner.size) { // hashes new to the index it already held; held hashes with another owner now
        for (let i = 0; i < m.n; i++) if (j.added.has(Number(l.hs[i] ?? -1))) { m.hits.push(i); redo = true; }
        if (!redo && j.owner.size) for (const i0 of m.hits) if (j.owner.has(Number(l.hs[i0 + 0] ?? -1))) { redo = true; break; }
      }
      cover(c); // its hash ids are interned (a host that sends one later finds the same id): the index covers them
      for (let i = m.n; i < l.hs.length; i++) if (held(c, Number(l.hs[i] ?? -1))) m.hits.push(i);
      m.n = l.hs.length;
      if (redo) {
        unsteal(m); m.lost = [];
        for (const i0 of m.hits) {
          const i = i0 + 0; const h = Number(l.hs[i] ?? -1); if (!held(c, h)) continue;
          const hi = Number(c.oi[h] ?? -1); const hs = String(c.sks[Number(c.os[h] ?? 0)] ?? "");
          if (first(Number(l.ks[i] ?? 0), j.localId, l.skey, Number(c.ok[h] ?? 0), idOf(hi), hs)) { const w = String(hi) + "\t" + hs; m.stealH.push(h); m.stealW.push(w); steal.set(h, w); j.stealMoved.add(w); }
          else m.lost.push(h);
        }
        m.lostJ = m.lost.join(","); m.done = true;
      }
      if (m.lost.length) j.loses.push(j.a); else { m.sh = null; m.nl = 0; m.inexact = false; m.off = -1; }
    }
    for (const [k, m] of [...c.logs.entries()]) if (!j.seenL.has(k)) { unsteal(m); c.logs.delete(k); }
    j.ph = P_SHADOW; j.a = 0; j.b = 0;
  }
  if (j.ph === P_SHADOW) {
    const scratch: OwnRow = { h: "", key: 0, d: "", hr: 0, m: "", prov: "", n: [] };
    for (; j.a < hosts.length; j.a++, j.b = 0) {
      const fh = hosts[j.a]; if (!fh) continue; const i = j.a;
      for (; j.b < fh.r.sessions.length; j.b++) {
        const sr = fh.r.sessions[j.b]; if (!sr) continue;
        let bd = j.sb;
        if (!bd) {
          if (late()) return false;
          j.done++; did = true;
          const ds = sr.days; if (!ds) continue;
          const mk = String(i) + "\t" + sr.key; j.keep.add(mk);
          const hit = c.shadows.get(mk);
          if (!j.full && hit && hit.days === ds && !j.stealMoved.has(mk) && !j.rowsMoved.has(mk) && !j.dirty.has(mk)) { j.out.push(hit.sh); j.removed += hit.n; continue; } // same rows, owners, local copies
          // the hashes this session loses: another host's earlier copy, or this machine's (stolen)
          const rows = c.om.get(mk) ?? []; const lost: number[] = []; const ls = new Set<number>(); const me = skId(c, sr.key);
          for (const ch of rows) for (let r = 0; r < ch.n; r++) {
            const h = Number(ch.h[r] ?? -1); if (h < 0 || ls.has(h)) continue;
            if (!(Number(c.oi[h] ?? -2) === i && Number(c.os[h] ?? -1) === me) || (steal.size > 0 && steal.get(h) === mk)) { ls.add(h); lost.push(h); }
          }
          const lk = String(lenOf(rows)) + ":" + lost.join(",");
          if (hit && hit.days === ds && hit.lost === lk) { j.out.push(hit.sh); j.removed += hit.n; continue; }
          bd = { mk, ds, a: shadowOf(sr, fh.shiftMin), ls, lk, rows, ci: 0, ri: 0, lt: new Map<string, number[]>() }; j.sb = bd;
        }
        // its lost rows out of it, a slice at a time (a session of thousands of messages)
        let n = 0;
        for (; bd.ci < bd.rows.length; bd.ci++, bd.ri = 0) {
          const ch = bd.rows[bd.ci]; if (!ch) continue;
          for (; bd.ri < ch.n; bd.ri++) {
            if (!bd.ls.has(Number(ch.h[bd.ri] ?? -1))) continue;
            fillRow(ch, bd.ri, scratch, false); subtract(bd.a, scratch, fh.shiftMin); addLost(bd.lt, scratch); did = true;
            if (++n >= 256) { n = 0; if (late()) { bd.ri++; return false; } }
          }
        }
        j.sb = null; const a = bd.a;
        shadowSkills(a, bd.ds, bd.lt, fh.shiftMin);
        if (bd.ls.size) prune(a);
        if (j.reprice) repriceShadow(a);
        const pm = new Map<string, string>(); for (const p of sr.prov) pm.set(p[0] ?? "", p[1] ?? "");
        const sh: Shadow = { host: fh.name, key: sr.key, a, bill: a.bill, prov: pm };
        c.shadows.set(bd.mk, { days: bd.ds, lost: bd.lk, sh, n: bd.ls.size });
        j.out.push(sh); j.removed += bd.ls.size;
      }
    }
    for (const k of [...c.shadows.keys()]) if (!j.keep.has(k)) c.shadows.delete(k);
    j.ph = P_CORR; j.a = 0; j.done += local.length - j.loses.length; // the logs that lose nothing: no correction to make
  }
  if (j.ph === P_CORR) {
    for (; j.a < j.loses.length; j.a++) {
      const l = local[Number(j.loses[j.a] ?? 0)]; if (!l) continue; const m = c.logs.get(l.path); if (!m) continue;
      let cb = j.cb;
      if (!cb) {
        if (m.off === l.off && (m.sh || m.inexact) && m.lostJ + "|" + j.dsig === m.built) { j.done++; if (m.inexact) j.inexact.push(l.path); else if (m.sh) { j.out.push(m.sh); j.corrected += m.nl; } continue; } // its rows and what it loses are as before
        if (late()) return false;
        const lr = j.rowsOf(l.path, until); did = true; if (!lr.done) return false; // its sidecar is being rebuilt: the next slice goes on
        j.done++;
        m.off = l.off; m.sh = null; m.nl = 0; m.inexact = false; m.built = m.lostJ + "|" + j.dsig;
        if (!lr.ok) { m.inexact = true; j.inexact.push(l.path); continue; }
        const a0 = newAcc(); a0.ro = true;
        cb = { rows: lr.rows, i: 0, a: a0, lost: new Set<number>(), lt: new Map<string, number[]>() }; j.cb = cb;
      }
      // a message no host holds stays this machine's; a day outside the hosts' day rows keeps its local booking (no host
      // carries it there: taking it out would count the message nowhere)
      for (; cb.i < cb.rows.length; cb.i++) {
        const r = cb.rows[cb.i]; if (!r || !r.h || (j.days.size > 0 && !j.days.has(r.d))) continue;
        const h = hashFind(r.h); if (held(c, h) && !steal.has(h)) { correct(cb.a, r); addLost(cb.lt, r); cb.lost.add(h); }
        did = true; if ((cb.i & 255) === 255 && late()) { cb.i++; return false; }
      }
      j.cb = null;
      const la = LOCAL_SKILLS.acc(l.path); if (la) correctSkills(cb.a, la, cb.lt);
      m.sh = { host: "", key: l.path, a: cb.a, bill: l.bill, prov: new Map<string, string>() }; m.nl = cb.lost.size;
      j.corrected += cb.lost.size; j.out.push(m.sh);
    }
    j.ph = P_DONE;
  }
  j.x = { accs: j.out, removed: j.removed, corrected: j.corrected, inexact: j.inexact };
  return true;
}
// rowsOf: a local log's booked rows (the msgrows sidecar), asked only for logs that lose a message; null = unknown (the
// log is reported in `inexact`). xc/sig: the cache kept between merges and the hosts' identity (names, ids, time zones:
// a new sig rebuilds everything the hosts decide); pv: the price table's generation (a new one rebuilds every entry)
export function exactFleet(local: LocalLog[], localId: string, hosts: FleetHost[], reprice: boolean, rowsOf: (path: string) => OwnRow[] | null, xc: XCache | null = null, sig = "", pv = ""): Exact {
  const j = mergeStart(local, localId, hosts, reprice, (p: string, u: number): LocalRows => { const r = rowsOf(p); return { rows: r ?? [], ok: r !== null, done: true }; }, xc ?? newXCache(), sig, pv);
  while (!mergeStep(j, Infinity)) { /* runs to the end */ }
  return j.x ?? { accs: [], removed: 0, corrected: 0, inexact: [] };
}
// re-price a shadow with this machine's table (spec 14); harness-reported cost (hx) has no tp row and stays as sent
export function repriceShadow(a: Acc): void { reprice(a); }
