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
// a local Claude log: its session key (ties), its owned messages (hs: hashes, ks: order keys, in the order the ledger
// claimed them: they only grow), its billing mode, its read offset (its booked rows move only with it)
export interface LocalLog { path: string; skey: string; hs: string[]; ks: number[]; bill: string; off: number }
export interface FleetHost { name: string; hostId: string; r: HostReport; shiftMin: number }
// one entry for the sums: an Acc and how its providers bill. host = the host's name ("" = a local correction)
export interface Shadow { host: string; key: string; a: Acc; bill: string; prov: Map<string, string> }
export interface Exact { accs: Shadow[]; removed: number; corrected: number; inexact: string[] }
export function modeOfShadow(x: Shadow, p: string): Bill { const m = x.prov.get(p) ?? x.bill; const i = MODES.indexOf(m as Bill); return MODES[i >= 0 ? i : MODES.length - 1] ?? "unknown"; }
// what a merge keeps for the next one (the TUI merges again whenever a report or the local ledger moved): the hosts'
// owner index, extended by the rows a report appended (a host's own rows only grow; anything else rebuilds it), each
// local log's hashes the hosts also hold and what it wins or loses (redone as the log grows or the owners of its hashes
// change), each shadow and correction entry with exactly what it was built from (its day rows, the hashes it lost). A
// merge then costs what moved, not every message of every host again
interface ShadowMemo { days: DayRow[]; lost: string; sh: Shadow; n: number }
interface LocalMemo { hs: string[]; n: number; hits: number[]; lost: string[]; lostJ: string; built: string; steal: string[]; off: number; sh: Shadow | null; nl: number; inexact: boolean; done: boolean }
export interface XCache { mode: string; sig: string; steal: Map<string, string>; bk: Map<string, number>; bi: Map<string, number>; bs: Map<string, string>; om: Map<string, OwnRow[]>; parts: Map<string, OwnRow[]>; shadows: Map<string, ShadowMemo>; logs: Map<string, LocalMemo> }
export function newXCache(): XCache { return { mode: "", sig: "\u0000", steal: new Map<string, string>(), bk: new Map<string, number>(), bi: new Map<string, number>(), bs: new Map<string, string>(), om: new Map<string, OwnRow[]>(), parts: new Map<string, OwnRow[]>(), shadows: new Map<string, ShadowMemo>(), logs: new Map<string, LocalMemo>() }; }
// how kept merges went (checks): owner index rebuilt, or extended by appended rows
export const MSTAT = { full: 0, grown: 0 };
// a host part's rows are the earlier ones plus new ones at the end (the same row objects: snap.ts applySnap concat)
function grew(prev: OwnRow[], rows: OwnRow[]): boolean { const n = prev.length; return rows.length >= n && (n === 0 || (rows[0] === prev[0] && rows[n - 1] === prev[n - 1])); }
// rowsOf: a local log's booked rows (the msgrows sidecar), asked only for logs that lose a message; null = unknown (the
// log is reported in `inexact`). xc/sig: the cache kept between merges and the hosts' identity (names, ids, time zones:
// a new sig rebuilds everything the hosts decide); pv: the price table's generation (a new one rebuilds every entry)
export function exactFleet(local: LocalLog[], localId: string, hosts: FleetHost[], reprice: boolean, rowsOf: (path: string) => OwnRow[] | null, xc: XCache | null = null, sig = "", pv = ""): Exact {
  const c = xc ?? newXCache();
  const idOf = (i: number): string => i < 0 ? localId : (hosts[i]?.hostId ?? "");
  const mode = (reprice ? "r" : "n") + "\t" + localId + "\t" + pv;
  if (c.mode !== mode) { c.mode = mode; c.sig = "\u0000"; c.shadows.clear(); c.logs.clear(); c.steal.clear(); } // other prices, another viewer: every entry again
  const offer = (h: string, key: number, i: number, sk: string): boolean => {
    const k0 = c.bk.get(h);
    if (k0 !== undefined && !first(key, idOf(i), sk, k0, idOf(c.bi.get(h) ?? -1), c.bs.get(h) ?? "")) return false;
    c.bk.set(h, key); c.bi.set(h, i); c.bs.set(h, sk); return true;
  };
  // what moved in the hosts' rows since the last merge: appended rows (offered), the sessions they belong to, the
  // sessions that lost a hash's ownership to them, the hashes new to the index or with another owner now
  let full = c.sig !== sig;
  const appends: { i: number; sk: string; pk: string; rows: OwnRow[]; from: number }[] = [];
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
  const rowsMoved = new Set<string>(); const dirty = new Set<string>(); const added = new Set<string>(); const owner = new Set<string>();
  if (full) {
    c.sig = sig; c.steal.clear(); c.bk = new Map<string, number>(); c.bi = new Map<string, number>(); c.bs = new Map<string, string>(); c.om = new Map<string, OwnRow[]>(); c.parts = new Map<string, OwnRow[]>(); // om: "<host index>\t<session key>" → its rows
    for (let i = 0; i < hosts.length; i++) {
      const fh = hosts[i]; if (!fh) continue;
      for (const o of fh.r.owned) {
        const sk = ownSess(o.key); const ok = String(i) + "\t" + sk; const p = c.om.get(ok); c.om.set(ok, p ? p.concat(o.rows) : o.rows); c.parts.set(String(i) + "\t" + o.key, o.rows);
        for (const r of o.rows) offer(r.h, r.key, i, sk);
      }
    }
  } else for (const a of appends) {
    const mk = String(a.i) + "\t" + a.sk; const tail = a.rows.slice(a.from);
    c.parts.set(a.pk, a.rows); const p = c.om.get(mk); c.om.set(mk, p ? p.concat(tail) : tail); rowsMoved.add(mk);
    for (const r of tail) {
      const had = c.bk.has(r.h); const pi = c.bi.get(r.h) ?? -1; const ps = c.bs.get(r.h) ?? "";
      if (!offer(r.h, r.key, a.i, a.sk)) continue;
      if (!had) added.add(r.h); else { owner.add(r.h); dirty.add(String(pi) + "\t" + ps); }
    }
  }
  // the local side: only the local messages some host also holds compete (any other one is this machine's alone: nothing
  // to decide, and 200 k local ids stay out of the maps). c.steal: hash → the host occurrence a local copy beats ("<host
  // index>\t<session key>"), kept across merges: a log's part changes only when the log is redone; stealMoved: the
  // host sessions whose stolen hashes changed
  const steal = c.steal; const stealMoved = new Set<string>();
  const unsteal = (m: LocalMemo): void => { for (let q = 0; q + 1 < m.steal.length; q += 2) { const h = m.steal[q] ?? ""; const w = m.steal[q + 1] ?? ""; if (steal.get(h) === w) steal.delete(h); stealMoved.add(w); } m.steal = []; };
  const loses: number[] = []; // local logs with a message a host owns
  const seenL = new Set<string>();
  for (let j = 0; j < local.length; j++) {
    const l = local[j]; if (!l) continue; seenL.add(l.path);
    let m = c.logs.get(l.path);
    if (m && (m.hs !== l.hs || m.n > l.hs.length)) { unsteal(m); m = undefined; } // a re-read log: a new entry
    if (!m) { m = { hs: l.hs, n: 0, hits: [], lost: [], lostJ: "", built: "", steal: [], off: -1, sh: null, nl: 0, inexact: false, done: false }; c.logs.set(l.path, m); }
    let redo = full || !m.done || m.n !== l.hs.length;
    if (full) { m.n = 0; m.hits = []; m.steal = []; }
    else if (added.size || owner.size) { // hashes new to the index it already held; held hashes with another owner now
      for (let i = 0; i < m.n; i++) if (added.has(l.hs[i] ?? "")) { m.hits.push(i); redo = true; }
      if (!redo && owner.size) for (const i0 of m.hits) if (owner.has(l.hs[i0 + 0] ?? "")) { redo = true; break; }
    }
    for (let i = m.n; i < l.hs.length; i++) if (c.bk.has(l.hs[i] ?? "")) m.hits.push(i);
    m.n = l.hs.length;
    if (redo) {
      unsteal(m); m.lost = [];
      for (const i0 of m.hits) {
        const i = i0 + 0; const h = l.hs[i] ?? ""; const hi = c.bi.get(h) ?? -1; const hs = c.bs.get(h) ?? "";
        if (first(l.ks[i] ?? 0, localId, l.skey, c.bk.get(h) ?? 0, idOf(hi), hs)) { const w = String(hi) + "\t" + hs; m.steal.push(h); m.steal.push(w); steal.set(h, w); stealMoved.add(w); }
        else m.lost.push(h);
      }
      m.lostJ = m.lost.join(","); m.done = true;
    }
    if (m.lost.length) loses.push(j); else { m.sh = null; m.nl = 0; m.inexact = false; m.off = -1; }
  }
  for (const [k, m] of [...c.logs.entries()]) if (!seenL.has(k)) { unsteal(m); c.logs.delete(k); }
  const out: Shadow[] = []; let removed = 0; let corrected = 0; const inexact: string[] = [];
  const keep = new Set<string>();
  for (let i = 0; i < hosts.length; i++) {
    const fh = hosts[i]; if (!fh) continue;
    for (const sr of fh.r.sessions) {
      const ds = sr.days; if (!ds) continue;
      const mk = String(i) + "\t" + sr.key; keep.add(mk);
      const hit = c.shadows.get(mk);
      if (!full && hit && hit.days === ds && !stealMoved.has(mk) && !rowsMoved.has(mk) && !dirty.has(mk)) { out.push(hit.sh); removed += hit.n; continue; } // same rows, owners, local copies
      // the hashes this session loses: another host's earlier copy, or this machine's (stolen)
      const rows = c.om.get(mk) ?? []; const lost: string[] = []; const ls = new Set<string>();
      for (const r of rows) if (!ls.has(r.h) && (!(c.bi.get(r.h) === i && c.bs.get(r.h) === sr.key) || (steal.size > 0 && steal.get(r.h) === mk))) { ls.add(r.h); lost.push(r.h); }
      const lk = String(rows.length) + ":" + lost.join(",");
      if (hit && hit.days === ds && hit.lost === lk) { out.push(hit.sh); removed += hit.n; continue; }
      const a = shadowOf(sr, fh.shiftMin);
      for (const r of rows) if (ls.has(r.h)) subtract(a, r, fh.shiftMin);
      if (reprice) repriceShadow(a);
      const pm = new Map<string, string>(); for (const p of sr.prov) pm.set(p[0] ?? "", p[1] ?? "");
      const sh: Shadow = { host: fh.name, key: sr.key, a, bill: a.bill, prov: pm };
      c.shadows.set(mk, { days: ds, lost: lk, sh, n: ls.size });
      out.push(sh); removed += ls.size;
    }
  }
  for (const k of [...c.shadows.keys()]) if (!keep.has(k)) c.shadows.delete(k);
  for (const j0 of loses) {
    const l = local[j0 + 0]; if (!l) continue; const m = c.logs.get(l.path); if (!m) continue;
    if (m.off === l.off && (m.sh || m.inexact) && m.lostJ === m.built) { if (m.inexact) inexact.push(l.path); else if (m.sh) { out.push(m.sh); corrected += m.nl; } continue; } // its rows and what it loses are as before
    m.off = l.off; m.sh = null; m.nl = 0; m.inexact = false; m.built = m.lostJ;
    const rows = rowsOf(l.path); if (!rows) { m.inexact = true; inexact.push(l.path); continue; }
    const a = newAcc(); a.ro = true; const lost = new Set<string>();
    for (const r of rows) if (r.h && c.bk.has(r.h) && !steal.has(r.h)) { correct(a, r); lost.add(r.h); } // a message no host holds stays this machine's
    m.sh = { host: "", key: l.path, a, bill: l.bill, prov: new Map<string, string>() }; m.nl = lost.size;
    corrected += lost.size; out.push(m.sh);
  }
  return { accs: out, removed, corrected, inexact };
}
// re-price a shadow with this machine's table (spec 14); harness-reported cost (hx) has no tp row and stays as sent
export function repriceShadow(a: Acc): void { reprice(a); }
