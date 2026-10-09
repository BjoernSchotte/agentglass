// agentglass — skills read model: a session's load timeline and per-skill tables over the ledger's Acc.sk and Day.sa, priced
// at read time through the resolver (a price change re-prices skills like everything else). Every skill surface reads
// these; none re-derives (skill-usage spec §6.0). Names here are real: surfaces show them through vis.ts (visRows/visLoads)
// SPDX-License-Identifier: Apache-2.0
import { type Acc, type SkLoad, dayKey } from "../usage/record.ts";
import { resolve, cost } from "../usage/pricing.ts";
import { SA_LU, SA_LM, SA_LC, SA_L, SA_C, SA_T, SA_HU, SA_HL, SA_HT, HP, LISTING } from "../usage/skillrec.ts";
import { skillVis, HIDDEN } from "./vis.ts";

// one load: tokens per kind summed over buckets; usd = load + carry; unpriced = some of its tokens have no price;
// i = its index in the session's Acc.sk (the "sk<i>" of a skill reference); n > 1 = a summary of folded older loads
export interface LoadRow {
  sess: string; i: number; name: string; trig: string; t: number; turn: number; te: number; end: number; why: string; rel: boolean; stub: boolean;
  bytes: number; size: number; tier: string; hash: string; scope: string; dir: string; requests: number; n: number;
  load: number; carry: number; tail: number; usd: number; carryUsd: number; tailUsd: number; unpriced: boolean;
  off: number; len: number; rec: string; model: string;
}
// one skill over a period: loads by trigger, sessions, tokens and $, size p50 of its loads, hashes (versions), tier;
// ctx = the cached + input tokens of the sessions it was loaded in (share = (load + carry) / ctx)
export interface SkillRow {
  name: string; loadsUser: number; loadsModel: number; loadsCompact: number; sessions: number; sizeP50: number;
  load: number; carry: number; tail: number; usd: number; carryUsd: number; tailUsd: number; perSess: number; share: number; ctx: number;
  tier: string; hashes: string[]; scope: string; unpriced: boolean;
}
// the stable JSON field list of a SkillRow (CLI --json, MCP): additive only
export const SKILL_FIELDS = ["name", "loadsUser", "loadsModel", "loadsCompact", "sessions", "sizeP50", "load", "carry", "tail", "usd", "carryUsd", "tailUsd", "perSess", "share", "tier", "hashes", "scope", "unpriced"];
export const LOAD_FIELDS = ["sess", "i", "name", "trig", "t", "turn", "te", "end", "why", "rel", "stub", "bytes", "size", "tier", "hash", "scope", "dir", "requests", "n", "load", "carry", "tail", "usd", "carryUsd", "tailUsd", "unpriced", "model"];

// $ of [in, cacheRead, write5m, write1h] tokens under the current price table; -1 = no price (tokens present)
export function bucketUsd(model: string, prov: string, b: number[]): number {
  const n = (b[0] ?? 0) + (b[1] ?? 0) + (b[2] ?? 0) + (b[3] ?? 0); if (n <= 0) return 0;
  const r = resolve(model, prov); if (!r) return -1;
  return cost(r.p, b[0] ?? 0, 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0);
}
function sum4(x: number[]): number { return (x[0] ?? 0) + (x[1] ?? 0) + (x[2] ?? 0) + (x[3] ?? 0); }
function sub4(x: number[], y: number[]): number[] { const o: number[] = []; for (let i = 0; i < 4; i++) o.push(Math.max(0, (x[i] ?? 0) - (y[i] ?? 0))); return o; }
function slice4(r: number[], at: number): number[] { return [r[at] ?? 0, r[at + 1] ?? 0, r[at + 2] ?? 0, r[at + 3] ?? 0]; }
export function tierOf(l: SkLoad): string { return l.S < 0 ? "?" : l.est ? "≈" : "exact"; }

// a session's timeline (load order per log; subagents' logs with their own ids); harness-priced loads take their
// reported $ (load part hl, carry the rest), table-priced tokens are priced now; tokens of both kinds in one load (a
// model without a reported cost in between) price the rest as carry
export function skillLoads(as: Acc[], ids: string[]): LoadRow[] {
  const out: LoadRow[] = [];
  for (let k = 0; k < as.length; k++) {
    const a = as[k] as Acc; const sid = ids[k] ?? "";
    for (let i = 0; i < a.sk.length; i++) {
      const l = a.sk[i] as SkLoad;
      let unpriced = false;
      const pr = (b: number[]): number => { const u = bucketUsd(l.mdl, l.prov, b); if (u < 0) { unpriced = true; return 0; } return u; };
      let lu = 0; let cu = 0; let tu = 0;
      if (l.hu > 0) {
        const rest = pr(sub4([(l.lt[0] ?? 0) + (l.ct[0] ?? 0), (l.lt[1] ?? 0) + (l.ct[1] ?? 0), (l.lt[2] ?? 0) + (l.ct[2] ?? 0), (l.lt[3] ?? 0) + (l.ct[3] ?? 0)], l.hb));
        lu = l.hl; cu = l.hu - l.hl + rest; tu = l.ht;
      } else { lu = pr(l.lt); cu = pr(l.ct); tu = pr(l.tt); }
      out.push({ sess: sid, i, name: l.name, trig: l.trig, t: l.t, turn: l.tu, te: l.te, end: l.end, why: l.why, rel: l.rel, stub: l.stub,
        bytes: l.bytes, size: l.S, tier: tierOf(l), hash: l.hash, scope: l.scope, dir: l.dir, requests: l.nq, n: l.n,
        load: sum4(l.lt), carry: sum4(l.ct), tail: sum4(l.tt), usd: lu + cu, carryUsd: cu, tailUsd: tu, unpriced, off: l.off, len: l.len, rec: l.rec, model: l.mdl });
    }
  }
  return out;
}
// a load of unknown size gets the median size of the same text's (hash) or else the same name's known loads, tier ≈
export function sizeFill(rows: LoadRow[]): void {
  for (const r of rows) {
    if (r.size >= 0) continue;
    const same: number[] = []; const named: number[] = [];
    for (const x of rows) { if (x.size < 0) continue; if (r.hash && x.hash === r.hash) same.push(x.size); if (x.name === r.name) named.push(x.size); }
    const v = same.length ? same : named; if (!v.length) continue;
    r.size = p50(v); r.tier = "≈";
  }
}
export function p50(v: number[]): number { if (!v.length) return 0; const s = v.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)] ?? 0; }

function newRow(name: string): SkillRow {
  return { name, loadsUser: 0, loadsModel: 0, loadsCompact: 0, sessions: 0, sizeP50: 0, load: 0, carry: 0, tail: 0, usd: 0, carryUsd: 0, tailUsd: 0, perSess: 0, share: 0, ctx: 0, tier: "exact", hashes: [], scope: "", unpriced: false };
}
// per skill over the given local days (null = all) from Day.sa (period-exact: tokens on the day of each request); sizes,
// hashes, tier and scope from the loads made on those days. ids[i] = the session of as[i] (copies and subagents share
// their session's id: a session counts once). by: cost | loads | tail | size | share | persess
interface Agg { row: SkillRow; sess: string[]; sizes: number[]; tiers: string[] }
export function skillTable(as: Acc[], ids: string[], days: string[] | null, by: string): SkillRow[] {
  const m = new Map<string, Agg>(); const pair = new Set<string>(); // "<name>\t<session>" seen
  const sessCtx = new Map<string, number>();
  const aggOf = (n: string): Agg => { let g = m.get(n); if (!g) { g = { row: newRow(n), sess: [], sizes: [], tiers: [] }; m.set(n, g); } return g; };
  for (let k = 0; k < as.length; k++) {
    const a = as[k] as Acc; const sid = ids[k] ?? "";
    let ctx = 0; let any = false;
    for (const [dk, d] of a.days) {
      if (days && days.indexOf(dk) < 0) continue;
      ctx += d.inTok + d.cr + d.cw;
      for (const [key, x] of d.sa) {
        const t1 = key.indexOf("\t"); const t2 = key.indexOf("\t", t1 + 1);
        const name = key.slice(0, t1); const prov = key.slice(t1 + 1, t2); const model = key.slice(t2 + 1);
        const g = aggOf(name); const r = g.row; any = true;
        const pk = name + "\t" + sid; if (!pair.has(pk)) { pair.add(pk); g.sess.push(sid); }
        r.loadsUser += x[SA_LU] ?? 0; r.loadsModel += x[SA_LM] ?? 0; r.loadsCompact += x[SA_LC] ?? 0;
        const L = slice4(x, SA_L); const C = slice4(x, SA_C); const T = slice4(x, SA_T);
        r.load += sum4(L); r.carry += sum4(C); r.tail += sum4(T);
        if (prov.startsWith(HP)) { const hu = x[SA_HU] ?? 0; const hl = x[SA_HL] ?? 0; r.usd += hu; r.carryUsd += hu - hl; r.tailUsd += x[SA_HT] ?? 0; continue; }
        let un = false;
        const pp = (b: number[]): number => { const u = bucketUsd(model, prov, b); if (u < 0) { un = true; return 0; } return u; };
        const lu = pp(L); const cu = pp(C); r.usd += lu + cu; r.carryUsd += cu; r.tailUsd += pp(T);
        if (un) r.unpriced = true;
      }
    }
    if (any) sessCtx.set(sid, (sessCtx.get(sid) ?? 0) + ctx);
    for (const l of a.sk) {
      if (days && (l.t <= 0 || days.indexOf(dayKey(new Date(l.t))) < 0)) continue;
      const g = aggOf(l.name); const r = g.row;
      if (l.S >= 0) g.sizes.push(l.S);
      const tr = tierOf(l); if (g.tiers.indexOf(tr) < 0) g.tiers.push(tr);
      if (l.hash && r.hashes.indexOf(l.hash) < 0) r.hashes.push(l.hash);
      if (!r.scope || r.scope === "?") r.scope = l.scope;
    }
  }
  const out: SkillRow[] = [];
  for (const g of m.values()) {
    const r = g.row; r.sessions = g.sess.length;
    if (r.sessions === 0 && r.loadsUser + r.loadsModel + r.loadsCompact === 0) continue;
    for (const s of g.sess) r.ctx += sessCtx.get(s) ?? 0;
    r.share = r.ctx > 0 ? (r.load + r.carry) / r.ctx : 0;
    r.perSess = r.sessions > 0 ? r.usd / r.sessions : 0;
    r.sizeP50 = p50(g.sizes);
    r.tier = g.tiers.length === 0 ? "exact" : g.tiers.length === 1 ? (g.tiers[0] ?? "exact") : "≈"; // mixed (a ? among sized loads): ≈
    if (!r.scope) r.scope = "?";
    out.push(r);
  }
  return sortRows(out, by);
}
export function sortRows(rows: SkillRow[], by: string): SkillRow[] {
  const key = (r: SkillRow): number => by === "loads" ? r.loadsUser + r.loadsModel + r.loadsCompact : by === "tail" ? r.tailUsd : by === "size" ? r.sizeP50 : by === "share" ? r.share : by === "persess" ? r.perSess : r.usd;
  return rows.sort((x, y) => key(y) - key(x) || y.load + y.carry - (x.load + x.carry) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

// what a surface may show: names through skillVis (name mode → the fake), omitted skills folded into one "(hidden)" row
// whose tokens and $ keep the totals true (spec Decision 24); hidden = how many skills it holds
export function visRows(rows: SkillRow[]): { rows: SkillRow[]; hidden: number } {
  const out: SkillRow[] = []; let h: SkillRow | null = null; let n = 0;
  for (const r of rows) {
    const v = skillVis(r.name);
    if (v.mode !== "omit") { if (v.shown !== r.name) { r.name = v.shown; r.hashes = r.hashes.slice(); } out.push(r); continue; }
    n++;
    if (!h) { h = newRow(HIDDEN); h.tier = r.tier; h.scope = "?"; }
    h.loadsUser += r.loadsUser; h.loadsModel += r.loadsModel; h.loadsCompact += r.loadsCompact; h.sessions += r.sessions;
    h.load += r.load; h.carry += r.carry; h.tail += r.tail; h.usd += r.usd; h.carryUsd += r.carryUsd; h.tailUsd += r.tailUsd; h.ctx += r.ctx;
    h.unpriced = h.unpriced || r.unpriced; if (r.tier !== h.tier) h.tier = "≈";
  }
  if (h) { h.perSess = h.sessions > 0 ? h.usd / h.sessions : 0; h.share = h.ctx > 0 ? (h.load + h.carry) / h.ctx : 0; out.push(h); }
  return { rows: out, hidden: n };
}
// a timeline for a surface: omitted skills leave the list (their tokens stay in the session's totals), names through skillVis
export function visLoads(rows: LoadRow[]): LoadRow[] {
  const out: LoadRow[] = [];
  for (const r of rows) { const v = skillVis(r.name); if (v.mode === "omit") continue; r.name = v.shown; out.push(r); }
  return out;
}
export function isListing(name: string): boolean { return name === LISTING; }

// spec §3.8 over what the ledger keeps: per load no negative slot, tail ≤ load + carry, one state; per session the skills'
// tokens ≤ its context tokens and their harness $ ≤ its cost; per day Σ Day.sa tokens ≤ the day's context tokens. [] = ok
export function skillCheck(as: Acc[], ids: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < as.length; k++) {
    const a = as[k] as Acc; const sid = ids[k] ?? String(k);
    let tok = 0; let hu = 0;
    for (let i = 0; i < a.sk.length; i++) {
      const l = a.sk[i] as SkLoad; const v = skillVis(l.name); const at = sid + "#sk" + String(i) + " (" + (v.mode === "omit" ? HIDDEN : v.shown) + ")";
      let neg = l.short < 0 || l.nq < 0 || l.hu < 0;
      for (let j = 0; j < 4; j++) { const lt = l.lt[j] ?? 0; const ct = l.ct[j] ?? 0; const tt = l.tt[j] ?? 0; if (lt < 0 || ct < 0 || tt < 0 || tt > lt + ct) neg = true; }
      if (neg) out.push(at + ": negative or inconsistent token slots");
      if ((l.end === 0) !== (l.why === "")) out.push(at + ": state (end " + String(l.end) + ", why \"" + l.why + "\")");
      tok += sum4(l.lt) + sum4(l.ct); hu += l.hu;
    }
    const ctx = a.inTok + a.cr + a.cw;
    if (tok > ctx + 0.5) out.push(sid + ": skills hold " + String(tok) + " tokens, the session's context " + String(ctx));
    if (hu > a.cost + 1e-9) out.push(sid + ": skills' reported $ " + String(hu) + " > the session's " + String(a.cost));
    for (const [dk, d] of a.days) {
      let dt = 0; for (const x of d.sa.values()) dt += sum4(slice4(x, SA_L)) + sum4(slice4(x, SA_C));
      if (dt > d.inTok + d.cr + d.cw + 0.5) out.push(sid + " " + dk + ": skills hold " + String(dt) + " tokens, the day's context " + String(d.inTok + d.cr + d.cw));
    }
  }
  return out;
}
