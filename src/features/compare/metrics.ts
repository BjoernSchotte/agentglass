// agentglass — session compare: two groups (filter expressions) inside one scope, their totals and the summary rows (spec §1, §3, §8)
// SPDX-License-Identifier: Apache-2.0
// A group is scope ∧ its clauses (∧ subagent is false when subagents are off), counted by filter-language's totals() —
// buckets for session/day clauses (all history), call rows for call clauses. The count is resumable (CmpJob): the view
// steps it between frames, the CLI and checks run it to the end.
import type { Sess } from "../../model/types.ts";
import { sessions, titleOf } from "../../model/sessions.ts";
import { ledger } from "../usage/ledger.ts";
import { L, dayKey, type ModelUse, modelUses, unionMin } from "../usage/record.ts";
import type { Rows } from "../usage/rows.ts";
import { DICT, nameOf } from "../usage/facts.ts";
import { fmtMs, pct } from "../usage/calls.ts";
import { kfmt, grp, type ModeSum, newSum, addDay, total, single, money, split } from "../usage/costs.ts";
import type { Bill } from "../usage/billing.ts";
import { modeOf } from "../usage/bill-live.ts";
import type { Clause, QErr } from "../query/types.ts";
import { parse, print } from "../query/parse.ts";
import { type Compiled, compile, livePid, sessMatches, callsIn, callCutoff } from "../query/eval.ts";
import { type Totals, type TotJob, totalsJob, totalsStep, emptyTotals } from "../query/agg.ts";
import { sessionOf, resolveSession } from "./key.ts";

export interface Group { label: string; cs: Clause[]; single: Sess | null /* the session when the group is one session */ }
export interface Side {
  n: number /* top-level sessions */; t: Totals; m: ModeSum /* cost per billing mode, unpriced */; bill: Bill | "" /* single(m), "" mixed/none */;
  turns: number /* Σ Day.turns of top-level sessions */; wall: number /* ms, -1 n/a */; active: number /* ms: per day the union of the counted sessions' active minutes */; live: boolean; indexing: number /* 0..1, 1 = done */;
  err: string /* the group's expression does not compile */; prio: string /* a session of the group still being read, "" none */; f: Compiled | null; mu: ModelUse[] /* per model over the side's session-days */;
  calls: Map<string, number> /* call rows per model (within retention) */; limited: boolean /* session-days older than the call rows */;
}
export interface Metric { key: string; label: string; a: string; b: string; d: string /* Δ text, "" none */; r: string /* "×2.4", "" none */; tone: number /* +1 worse (red), -1 better (green), 0 neutral */ }
export interface Cmp { key: string; A: Group; B: Group; subs: boolean; a: Side; b: Side; rows: Metric[]; same: boolean /* A and B canonical-equal */; emptyA: boolean; emptyB: boolean }

// ── groups ──
export function groupOfSession(s: Sess): Group { return { label: titleOf(s), cs: [{ key: "session", op: "is", vals: [s.h + ":" + s.id], neg: false, pinned: false }], single: s }; }
// a typed expression → a group (session values resolved to "<harness>:<id>"); one `session is x` clause is a single session
export function groupOfExpr(src: string): { g: Group | null; err: QErr | null } {
  const p = parse(src); if (p.err) return { g: null, err: p.err };
  if (!p.cs.length) return { g: null, err: { msg: "type an expression, e.g. model ~ opus or session is claude:abc123", col: 0 } };
  const r = compile(p.cs, "list"); if (r.err) return { g: null, err: r.err };
  const cs: Clause[] = [];
  for (const c of p.cs) {
    if (c.key !== "session") { cs.push(c); continue; }
    const vs: string[] = []; for (const v of c.vals) vs.push(resolveSession(v).v);
    cs.push({ key: c.key, op: c.op, vals: vs, neg: c.neg, pinned: false });
  }
  const one = cs.length === 1 && cs[0].key === "session" && cs[0].op === "is" && cs[0].vals.length === 1 ? sessionOf(cs[0].vals[0] ?? "") : null;
  return { g: one ? groupOfSession(one) : { label: print(cs), cs, single: null }, err: null };
}
export const NOSUB: Clause = { key: "subagent", op: "is", vals: ["false"], neg: false, pinned: false };
// scope ∧ group (∧ subagent is false): a plain AND — addAll would merge `harness is a` with `harness is b` into one_of
export function groupClauses(g: Group, scope: Clause[], subs: boolean): Clause[] { return scope.concat(g.cs, subs ? [] : [NOSUB]); }

// ── the resumable count ──
export interface CmpJob {
  key: string; A: Group; B: Group; subs: boolean; days: string[] | null; ver: number;
  fa: Compiled | null; fb: Compiled | null; ea: string; eb: string; ja: TotJob | null; jb: TotJob | null;
  ph: number /* 0 A totals, 1 B totals, 2 call rows per model, 3 done */; work: Sess[]; side: number[]; wi: number;
  ca: Map<string, number>; cb: Map<string, number>; res: Cmp | null;
}
export function cmpKey(A: Group, B: Group, scope: Clause[], subs: boolean, days: string[] | null): string {
  return JSON.stringify([print(A.cs), print(B.cs), subs, print(scope), days ? days.join(",") : "*", dayKey(new Date())]);
}
function compiled(cs: Clause[]): { f: Compiled | null; err: string } { const r = compile(cs, "list"); return { f: r.f, err: r.err ? r.err.msg : "" }; }
export function cmpJob(A: Group, B: Group, scope: Clause[], subs: boolean, days: string[] | null): CmpJob {
  const a = compiled(groupClauses(A, scope, subs)); const b = compiled(groupClauses(B, scope, subs));
  return { key: cmpKey(A, B, scope, subs, days), A, B, subs, days, ver: L.ver, fa: a.f, fb: b.f, ea: a.err, eb: b.err,
    ja: a.f ? totalsJob(a.f, days) : null, jb: b.f ? totalsJob(b.f, days) : null, ph: 0, work: [], side: [], wi: 0,
    ca: new Map<string, number>(), cb: new Map<string, number>(), res: null };
}
// work until the clock reaches `until` (Infinity = to the end); true when j.res is set
export function cmpStep(j: CmpJob, until: number): boolean {
  while (!j.res) {
    if (j.ph === 0) { const t = j.ja; if (t && !totalsStep(t, until)) return false; j.ph = 1; }
    else if (j.ph === 1) { const t = j.jb; if (t && !totalsStep(t, until)) return false; j.ph = 2; plan(j); }
    else if (j.ph === 2) {
      while (j.wi < j.work.length) {
        const s = j.work[j.wi]; const sd = j.side[j.wi] ?? 0; j.wi++;
        modelCalls(sd === 0 ? j.fa : j.fb, sd === 0 ? j.ja : j.jb, s, sd === 0 ? j.ca : j.cb);
        if (until !== Infinity && Date.now() >= until) return false;
      }
      j.ph = 3;
    } else { j.res = finish(j); if (cache.size > 16) cache.clear(); cache.set(j.key, { ver: j.ver, at: Date.now(), cmp: j.res }); }
  }
  return true;
}
// 0…1 while counting
export function cmpProgress(j: CmpJob): number {
  if (j.res) return 1;
  const part = (t: TotJob | null): number => !t || t.done ? 1 : t.ss.length ? t.i / t.ss.length : 1;
  if (j.ph === 0) return part(j.ja) * 0.45;
  if (j.ph === 1) return 0.45 + part(j.jb) * 0.45;
  return 0.9 + (j.work.length ? (j.wi / j.work.length) * 0.1 : 0.1);
}
function plan(j: CmpJob): void {
  const add = (t: TotJob | null, sd: number): void => { if (!t) return; for (const p of t.t.paths) { const s = sessions.get(p); if (s) { j.work.push(s); j.side.push(sd); } } };
  add(j.ja, 0); add(j.jb, 1);
}
// one session's call rows on its counted days, per model (the models section's calls column)
function modelCalls(f: Compiled | null, t: TotJob | null, s: Sess, into: Map<string, number>): void {
  if (!f || !t) return;
  const dks = t.t.pdays.get(s.path); if (!dks) return;
  callsIn(f, s, new Set<string>(dks), callCutoff(), (r: Rows, i: number) => { const m = r.model[i] >= 0 ? nameOf(DICT.model, r.model[i] + 0) : "unknown"; into.set(m, (into.get(m) ?? 0) + 1); });
}

const cache = new Map<string, { ver: number; at: number; cmp: Cmp }>();
// the cached comparison when it is current (or, while the ledger indexes, younger than 2 s); null = count it
export function cmpCached(key: string): Cmp | null {
  const h = cache.get(key); if (!h) return null;
  return h.ver === L.ver || (L.done < L.total && Date.now() - h.at < 2000) ? h.cmp : null;
}
export function compareGroups(A: Group, B: Group, scope: Clause[], subs: boolean, days: string[] | null): Cmp {
  const k = cmpKey(A, B, scope, subs, days); const h = cache.get(k);
  if (h && h.ver === L.ver) return h.cmp;
  const j = cmpJob(A, B, scope, subs, days); cmpStep(j, Infinity);
  return j.res ?? finish(j);
}

// ── sides ──
function mergeUse(by: Map<string, ModelUse>, u: ModelUse): void {
  const x = by.get(u.model);
  if (!x) { by.set(u.model, { model: u.model, inTok: u.inTok, outTok: u.outTok, cr: u.cr, cw: u.cw, cost: u.cost, unk: u.unk }); return; }
  x.inTok += u.inTok; x.outTok += u.outTok; x.cr += u.cr; x.cw += u.cw; x.cost += u.cost; x.unk += u.unk;
}
function sideOf(g: Group, f: Compiled | null, err: string, tj: TotJob | null, calls: Map<string, number>): Side {
  const t = tj ? tj.t : emptyTotals();
  const m = newSum(); let turns = 0; let live = false; let limited = false;
  const cutDay: string = dayKey(new Date(callCutoff() + 43200000));
  const by = new Map<string, ModelUse>(); const acts = new Map<string, number[][]>(); // day → the counted sessions' Day.act
  for (const p of t.pdays.keys()) {
    const dks: string[] = t.pdays.get(p) ?? []; const s = sessions.get(p); const a = ledger.get(p); if (!s || !a) continue;
    if (livePid(s) > 0) live = true;
    for (const dk of dks) {
      const d = a.days.get(dk); if (!d) continue;
      addDay(m, d, (prov: string): Bill => modeOf(s, prov));
      if (!s.parent) turns += d.turns; // a subagent's opening prompt comes from its parent agent, not a person
      if (String(dk) < cutDay) limited = true;
      if (d.act.length) { const l = acts.get(dk); if (l) l.push(d.act); else acts.set(dk, [d.act]); }
    }
    for (const u of modelUses(a, dks)) mergeUse(by, u);
  }
  // indexing: the bytes read of every session the group's session clauses admit (a session not read yet has no days to match);
  // with day clauses only sessions written since the group's first day can hold one of its days
  let tot = 0; let done = 0; let prio = "";
  const dk0: string = f && f.dayKeys ? f.dayKeys[0] ?? "~" : "";
  if (f) for (const s of sessions.values()) {
    if (!sessMatches(f, s) || (dk0 && String(dayKey(new Date(s.mtime))) < dk0)) continue;
    const a = ledger.get(s.path); const off = a ? Math.min(a.off, s.size) : 0;
    tot += s.size; done += a && a.stall === s.size ? s.size : off;
    if (!prio && off < s.size && !(a && a.stall === s.size)) prio = s.path;
  }
  let act = 0; for (const ls of acts.values()) act += unionMin(ls); // a subagent working inside its parent's minutes adds nothing
  const mu = [...by.values()].sort((x: ModelUse, y: ModelUse) => y.cost - x.cost || (y.inTok + y.outTok) - (x.inTok + x.outTok) || (x.model < y.model ? -1 : x.model > y.model ? 1 : 0));
  const wall = g.single && t.first > 0 && t.last >= t.first ? Math.round(t.last - t.first) : -1;
  // whole clock minutes count: 8m52s of work can touch 10 of them — a single session's active time never exceeds its wall
  return { n: t.sessions, t, m, bill: single(m), turns, wall, active: wall >= 0 ? Math.min(act * 60000, wall) : act * 60000, live, indexing: tot > 0 ? done / tot : 1, err, prio, f, mu, calls, limited };
}
function finish(j: CmpJob): Cmp {
  const a = sideOf(j.A, j.fa, j.ea, j.ja, j.ca); const b = sideOf(j.B, j.fb, j.eb, j.jb, j.cb);
  const p = a.prio || b.prio; if (p) { L.prio = p; L.prioAt = Date.now(); } // the ledger's next tick reads A's sessions first, then B's (as the preview does)
  const same = !!j.fa && !!j.fb && j.fa.key === j.fb.key;
  return { key: j.key, A: j.A, B: j.B, subs: j.subs, a, b, rows: metricRows(j.A, j.B, a, b), same, emptyA: a.err !== "" || a.t.paths.size === 0, emptyB: b.err !== "" || b.t.paths.size === 0 };
}

// ── the summary rows (spec §3) ──
const MINUS = "−";
// "0" also when the difference rounds away in the unit ($0.004 → "0", not "−$0.00")
// an estimate keeps its ≈ in front: "≈+$0.07"
function signed(d: number, f: (n: number) => string): string {
  const t = f(Math.abs(d)); if (d === 0 || t === f(0)) return "0";
  const sg = d > 0 ? "+" : MINUS; return t.startsWith("≈") ? "≈" + sg + t.slice(1) : sg + t;
}
function ratio(a: number, b: number): string { if (!(a > 0 && b >= 0)) return ""; const r = b / a; return "×" + (r < 0.1 ? r.toFixed(2) : r < 100 ? r.toFixed(1) : r < 1000 ? String(Math.round(r)) : kfmt(r)); }
function pctTxt(x: number): string { return (x * 100).toFixed(1) + "%"; }
// a numeric row; a or b < 0 = unknown: "n/a", no Δ, no ratio. worse: a higher B is worse (cost, errors, durations)
function num(key: string, label: string, a: number, b: number, f: (n: number) => string, worse: boolean, withRatio: boolean): Metric {
  const k = a >= 0 && b >= 0; const d = b - a;
  return { key, label, a: a >= 0 ? f(a) : "n/a", b: b >= 0 ? f(b) : "n/a", d: k ? signed(d, f) : "", r: k && withRatio ? ratio(a, b) : "", tone: k && worse ? (d > 0 ? 1 : d < 0 ? -1 : 0) : 0 };
}
function share(key: string, label: string, a: number, b: number, worse: boolean): Metric {
  const k = a >= 0 && b >= 0; const d = b - a;
  const pp = k ? (d > 0 ? "+" : d < 0 ? MINUS : "") + (Math.abs(d) * 100).toFixed(1) + " pp" : "";
  return { key, label, a: a >= 0 ? pctTxt(a) : "n/a", b: b >= 0 ? pctTxt(b) : "n/a", d: pp, r: "", tone: k && worse ? (d > 0 ? 1 : d < 0 ? -1 : 0) : 0 };
}
function text(key: string, label: string, a: string, b: string): Metric { return { key, label, a, b, d: "", r: "", tone: 0 }; }
function unpriced(s: Side): boolean { return s.m.unk > 0 || s.m.uc > 0; }
// the cost cell: one mode "$3.10 spend", mixed "$3.10 spend + ≈$9.20 plan" (narrow: the total), " +?" for unpriced parts
export function costCell(s: Side, narrow: boolean): string {
  if (s.err) return "n/a";
  const tot = total(s.m);
  if (tot === 0 && unpriced(s)) return "cost ?";
  return split(s.m, narrow) + (unpriced(s) ? " +?" : "");
}
function tokAll(t: Totals): number { return t.inTok + t.outTok + t.cr + t.cw; }
function hitOf(t: Totals): number { const den = t.inTok + t.cr + t.cw; return den > 0 ? t.cr / den : -1; }
function q(t: Totals, x: number): number { return t.dn > 0 ? pct(t.hist, x, t.max) : -1; }
function modelsOf(s: Side): string {
  const set = new Set<string>();
  for (const u of s.mu) if (u.inTok + u.outTok + u.cr + u.cw > 0 && u.model !== "unknown") set.add(u.model);
  for (const m of s.t.models) if (m !== "unknown") set.add(m);
  const o = [...set].sort(); return o.length ? o.join(", ") : "n/a";
}
function subsCell(s: Side): string {
  const t = s.t; if (t.subs === 0) return "0";
  return grp(t.subs) + " · " + (t.subsCost === 0 && t.subsUnk > 0 ? "cost ?" : money(t.subsCost, s.bill || "unknown"));
}
export function metricRows(A: Group, B: Group, a: Side, b: Side): Metric[] {
  const ta = a.t; const tb = b.t; const o: Metric[] = [];
  const two = !!A.single && !!B.single;
  if (!two) o.push(num("sessions", "sessions", a.n, b.n, grp, false, true));
  // cost: no Δ when either side has unpriced usage (the difference would be a guess)
  const ca = total(a.m); const cb = total(b.m); const known = !unpriced(a) && !unpriced(b) && !a.err && !b.err;
  const bill: Bill | "" = a.bill === b.bill ? a.bill : "";
  const mf = (n: number): string => money(n, bill);
  o.push({ key: "cost", label: "cost", a: costCell(a, false), b: costCell(b, false), d: known ? signed(cb - ca, mf) : "", r: known ? ratio(ca, cb) : "", tone: known ? (cb > ca ? 1 : cb < ca ? -1 : 0) : 0 });
  // wall: first event → last activity (a session resumed days later spans the gap); active: the minutes with activity
  if (A.single || B.single) o.push(num("wall", "wall time", a.wall, b.wall, fmtMs, false, true));
  o.push(num("active", "active time", a.err ? -1 : a.active, b.err ? -1 : b.active, fmtMs, false, true));
  o.push(num("turns", "turns", a.turns, b.turns, grp, false, true));
  o.push(num("in", "tokens in", ta.inTok, tb.inTok, kfmt, false, true));
  o.push(num("out", "tokens out", ta.outTok, tb.outTok, kfmt, false, true));
  o.push(num("cache_read", "cache read", ta.cr, tb.cr, kfmt, false, true));
  o.push(num("cache_write", "cache write", ta.cw, tb.cw, kfmt, false, true));
  o.push(share("cache_hit", "cache hit", hitOf(ta), hitOf(tb), false));
  const perTurn = (s: Side, v: number): number => s.turns > 0 ? v / s.turns : -1;
  // each side's own cost per turn when that side is fully priced; num() drops Δ and ratio when the other is not
  o.push(num("cost_turn", "cost / turn", !unpriced(a) && !a.err ? perTurn(a, ca) : -1, !unpriced(b) && !b.err ? perTurn(b, cb) : -1, mf, true, true));
  o.push(num("tok_turn", "tokens / turn", perTurn(a, tokAll(ta)), perTurn(b, tokAll(tb)), kfmt, false, true));
  o.push(num("tools", "tool calls", ta.tools, tb.tools, grp, false, true));
  o.push(num("calls_turn", "calls / turn", perTurn(a, ta.tools), perTurn(b, tb.tools), (n: number): string => n.toFixed(1), false, true));
  o.push(num("errors", "errors", ta.errors, tb.errors, grp, true, true));
  o.push(share("error_rate", "error rate", ta.tools > 0 ? ta.errors / ta.tools : -1, tb.tools > 0 ? tb.errors / tb.tools : -1, true));
  o.push(text("timed", "timed calls", grp(ta.dn) + "/" + grp(ta.tools), grp(tb.dn) + "/" + grp(tb.tools)));
  o.push(num("p50", "p50 call", q(ta, 0.5), q(tb, 0.5), fmtMs, true, true));
  o.push(num("p95", "p95 call", q(ta, 0.95), q(tb, 0.95), fmtMs, true, true));
  o.push(num("max", "max call", ta.dn > 0 ? ta.max : -1, tb.dn > 0 ? tb.max : -1, fmtMs, true, true));
  o.push(text("lines", "lines + / " + MINUS, "+" + grp(ta.add) + " " + MINUS + grp(ta.del), "+" + grp(tb.add) + " " + MINUS + grp(tb.del)));
  o.push(num("files", "files touched", ta.files.size, tb.files.size, grp, false, true));
  o.push(text("models", "models", modelsOf(a), modelsOf(b)));
  const sm = num("subagents", "subagents", ta.subs, tb.subs, grp, false, false);
  o.push({ key: sm.key, label: sm.label, a: subsCell(a), b: subsCell(b), d: sm.d, r: "", tone: 0 });
  if (a.err || b.err) for (const m of o) { if (a.err) m.a = "n/a"; if (b.err) m.b = "n/a"; m.d = ""; m.r = ""; m.tone = 0; }
  return o;
}
