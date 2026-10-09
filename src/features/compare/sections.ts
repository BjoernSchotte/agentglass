// agentglass — session compare: detail sections — tools, programs, commands, files, models, timeline (spec §4)
// SPDX-License-Identifier: Apache-2.0
// Pure over a finished Cmp (its Totals, per-model buckets and per-model call counts), except the timeline, which reads the
// two single sessions' call rows. Every sorted table: |Δ share| desc, then nA + nB desc, then label asc.
import { sessions } from "../../model/sessions.ts";
import { home } from "../../util/text.ts";
import { ledger, copyKey } from "../usage/ledger.ts";
import { type Cnt, HB, pct, mcpServer } from "../usage/calls.ts";
import type { Rows } from "../usage/rows.ts";
import { dayKey, heavy } from "../usage/record.ts";
import type { ToolT } from "../query/agg.ts";
import { EMPTY, callsIn, callCutoff } from "../query/eval.ts";
import { projectRoot } from "../query/project.ts";
import { real } from "../../model/project.ts";
import { realCwd } from "../../hooks.ts";
import { score } from "../triage/score.ts";
import type { Cmp, Side } from "./metrics.ts";
import { skillTable } from "../skills/model.ts";
import { skillVis, HIDDEN } from "../skills/vis.ts";

const EPS = 1e-9;
function tie(da: number, db: number, na: number, nb: number, la: string, lb: string): number {
  if (Math.abs(da - db) > EPS) return db - da;
  if (na !== nb) return nb - na;
  return la < lb ? -1 : la > lb ? 1 : 0;
}

// ── tools ──
export interface ToolRow { key: string; label: string; server: boolean; kid: boolean; nA: number; nB: number; shA: number; shB: number; dpp: number; errA: number; errB: number; p50A: number; p50B: number; p95A: number; p95B: number; chi2: number /* -1 none */; sig: boolean }
interface Acc2 { n: number; err: number; dn: number; max: number; hist: number[] }
function acc0(): Acc2 { const h: number[] = []; for (let i = 0; i < HB; i++) h.push(0); return { n: 0, err: 0, dn: 0, max: 0, hist: h }; }
function addT(x: Acc2, t: ToolT): void { x.n += t.n; x.err += t.err; x.dn += t.dn; if (t.max > x.max) x.max = t.max; for (let i = 0; i < HB; i++) x.hist[i] = (x.hist[i] ?? 0) + (t.hist[i] ?? 0); }
function q(x: Acc2, p: number): number { return x.dn > 0 ? pct(x.hist, p, x.max) : -1; }
function at(m: Map<string, Acc2>, k: string): Acc2 { let x = m.get(k); if (!x) { x = acc0(); m.set(k, x); } return x; }
// selection = B, baseline = A: a significant row says "B uses this tool at another rate than A"
function toolRow(key: string, label: string, server: boolean, kid: boolean, a: Acc2, b: Acc2, NA: number, NB: number, sigOn: boolean): ToolRow {
  const shA = NA > 0 ? a.n / NA : 0; const shB = NB > 0 ? b.n / NB : 0;
  const sc = sigOn ? score(b.n, NB, a.n, NA) : null;
  return { key, label, server, kid, nA: a.n, nB: b.n, shA, shB, dpp: (shB - shA) * 100, errA: a.err, errB: b.err, p50A: q(a, 0.5), p50B: q(b, 0.5), p95A: q(a, 0.95), p95B: q(b, 0.95), chi2: sc ? sc.chi2 : -1, sig: sc ? sc.sig : false };
}
function byShare(x: ToolRow, y: ToolRow): number { return tie(Math.abs(x.dpp), Math.abs(y.dpp), x.nA + x.nB, y.nA + y.nB, x.label, y.label); }
export const SIG_MIN = 50; // calls per group before χ² marks anything
export function toolRows(c: Cmp, open: Set<string>): { rows: ToolRow[]; significance: boolean } {
  const ta = c.a.t; const tb = c.b.t; const NA = ta.tools; const NB = tb.tools; const sigOn = NA >= SIG_MIN && NB >= SIG_MIN;
  // MCP tools fold into their server row ("mcp__<server>"), as the Stats tab's top tools do
  const pa = new Map<string, Acc2>(); const pb = new Map<string, Acc2>(); const ka = new Map<string, Acc2>(); const kb = new Map<string, Acc2>();
  const parents: string[] = []; const kids = new Map<string, string[]>();
  const put = (name: string, t: ToolT, mp: Map<string, Acc2>, mk: Map<string, Acc2>): void => {
    const sv = mcpServer(name); const pk = sv ? "mcp__" + sv : name;
    if (parents.indexOf(pk) < 0) parents.push(pk);
    addT(at(mp, pk), t);
    if (sv) { const ks = kids.get(pk) ?? []; if (ks.indexOf(name) < 0) ks.push(name); kids.set(pk, ks); addT(at(mk, name), t); }
  };
  for (const [n, t] of ta.perTool) put(n, t, pa, ka);
  for (const [n, t] of tb.perTool) put(n, t, pb, kb);
  const top: ToolRow[] = [];
  for (const pk of parents) { const sv = kids.has(pk); top.push(toolRow(pk, sv ? pk.slice(5) : pk, sv, false, pa.get(pk) ?? acc0(), pb.get(pk) ?? acc0(), NA, NB, sigOn)); }
  top.sort(byShare);
  const rows: ToolRow[] = [];
  for (const r of top) {
    rows.push(r);
    if (!r.server || !open.has(r.key)) continue;
    const ks: ToolRow[] = [];
    for (const n of kids.get(r.key) ?? []) ks.push(toolRow(n, n.slice(r.key.length + 2), false, true, ka.get(n) ?? acc0(), kb.get(n) ?? acc0(), NA, NB, sigOn));
    ks.sort(byShare); for (const k of ks) rows.push(k);
  }
  return { rows, significance: sigOn };
}

// ── programs / commands (shell tools only; keys "<tool>\t<x>" merged by x) ──
export interface CntRow { key: string; nA: number; nB: number; shA: number; shB: number; dpp: number; errA: number; errB: number; chi2: number; sig: boolean }
function merged(m: Map<string, Cnt>): Map<string, Cnt> {
  const o = new Map<string, Cnt>();
  for (const [k, c] of m) { const x = k.slice(k.indexOf("\t") + 1); const y = o.get(x); if (y) { y.n += c.n; y.err += c.err; } else o.set(x, { n: c.n, err: c.err, add: 0, del: 0 }); }
  return o;
}
function sumN(m: Map<string, Cnt>): number { let n = 0; for (const c of m.values()) n += c.n; return n; }
export function cntRows(c: Cmp, which: "prog" | "cmds"): CntRow[] {
  const ma = merged(which === "prog" ? c.a.t.prog : c.a.t.cmds); const mb = merged(which === "prog" ? c.b.t.prog : c.b.t.cmds);
  const NA = sumN(ma); const NB = sumN(mb); const sigOn = NA >= SIG_MIN && NB >= SIG_MIN;
  const keys: string[] = []; for (const k of ma.keys()) keys.push(k); for (const k of mb.keys()) if (!ma.has(k)) keys.push(k);
  const o: CntRow[] = [];
  for (const k of keys) {
    const a = ma.get(k); const b = mb.get(k); const nA = a ? a.n : 0; const nB = b ? b.n : 0;
    const shA = NA > 0 ? nA / NA : 0; const shB = NB > 0 ? nB / NB : 0; const sc = sigOn ? score(nB, NB, nA, NA) : null;
    o.push({ key: k, nA, nB, shA, shB, dpp: (shB - shA) * 100, errA: a ? a.err : 0, errB: b ? b.err : 0, chi2: sc ? sc.chi2 : -1, sig: sc ? sc.sig : false });
  }
  o.sort((x: CntRow, y: CntRow) => tie(Math.abs(x.dpp), Math.abs(y.dpp), x.nA + x.nB, y.nA + y.nB, x.key, y.key));
  return o;
}

// ── files ──
export interface FileRow { path: string; shown: string; abs: string; editsA: number; editsB: number; addA: number; delA: number; addB: number; delB: number }
// the one repo root every counted session of both sides shares ("" = several, or none); from the real cwds (--redact
// fakes s.cwd for display; the file paths are real and faked at output)
function sharedRoot(c: Cmp): string {
  let root = ""; let first = true;
  for (const t of [c.a.t, c.b.t]) for (const p of t.paths) {
    const s = sessions.get(p); const r = s ? projectRoot(realCwd(s)) : "";
    if (!r) return "";
    if (first) { root = r; first = false; } else if (r !== root) return "";
  }
  return root;
}
// the root as the sessions' cwds spell it: projectRoot() resolves symlinks (macOS /tmp → /private/tmp), the recorded
// file paths keep the cwd's form. "<cwd>" whose real path is "<root>/<rel>" spells the root as cwd minus "/<rel>".
function rootForms(c: Cmp, root: string): string[] {
  const o: string[] = [];
  for (const t of [c.a.t, c.b.t]) for (const p of t.paths) {
    const s = sessions.get(p); const c0 = s ? realCwd(s) : ""; if (!c0) continue;
    const cwd = c0.replace(/\/+$/, ""); const rc = real(cwd);
    if (rc !== root && !rc.startsWith(root + "/")) continue;
    const rel = rc.slice(root.length); if (!cwd.endsWith(rel)) continue;
    const f = cwd.slice(0, cwd.length - rel.length); if (f && f !== root && o.indexOf(f) < 0) o.push(f);
  }
  return o;
}
export function fileLists(c: Cmp): { onlyA: FileRow[]; onlyB: FileRow[]; both: FileRow[]; root: string } {
  const root = sharedRoot(c); const fa = c.a.t.files; const fb = c.b.t.files;
  const forms = root ? rootForms(c, root).concat([root]) : [];
  const shown = (p: string): string => { for (const r of forms) if (p.startsWith(r + "/")) return p.slice(r.length + 1); return home(p); };
  const row = (p: string): FileRow => { const a = fa.get(p); const b = fb.get(p); return { path: p, shown: shown(p), abs: p, editsA: a ? a.n : 0, editsB: b ? b.n : 0, addA: a ? a.add : 0, delA: a ? a.del : 0, addB: b ? b.add : 0, delB: b ? b.del : 0 }; };
  const onlyA: FileRow[] = []; const onlyB: FileRow[] = []; const both: FileRow[] = [];
  for (const p of fa.keys()) (fb.has(p) ? both : onlyA).push(row(p));
  for (const p of fb.keys()) if (!fa.has(p)) onlyB.push(row(p));
  const ord = (x: FileRow, y: FileRow): number => (y.editsA + y.editsB) - (x.editsA + x.editsB) || (x.shown < y.shown ? -1 : x.shown > y.shown ? 1 : 0);
  onlyA.sort(ord); onlyB.sort(ord); both.sort(ord);
  return { onlyA, onlyB, both, root: forms[0] ?? "" };
}

// ── models: tokens and cost from the per-model day buckets, calls from the rows ──
export interface ModelRow { model: string; callsA: number; callsB: number; tokA: number; tokB: number; costA: number; costB: number; unkA: boolean; unkB: boolean }
export function modelRows(c: Cmp): { rows: ModelRow[]; limited: boolean } {
  const by = new Map<string, ModelRow>();
  const row = (m: string): ModelRow => { let r = by.get(m); if (!r) { r = { model: m, callsA: 0, callsB: 0, tokA: 0, tokB: 0, costA: 0, costB: 0, unkA: false, unkB: false }; by.set(m, r); } return r; };
  const fill = (s: Side, isA: boolean): void => {
    for (const u of s.mu) {
      const tok = u.inTok + u.outTok; if (tok + u.cr + u.cw === 0 && u.unk === 0) continue;
      const r = row(u.model);
      if (isA) { r.tokA += tok; r.costA += u.cost; if (u.unk > 0) r.unkA = true; } else { r.tokB += tok; r.costB += u.cost; if (u.unk > 0) r.unkB = true; }
    }
    for (const [m, n] of s.calls) { const r = row(m); if (isA) r.callsA += n; else r.callsB += n; }
  };
  fill(c.a, true); fill(c.b, false);
  const rows = [...by.values()].filter((r: ModelRow) => r.model !== "unknown" || r.callsA + r.callsB + r.tokA + r.tokB > 0);
  rows.sort((x: ModelRow, y: ModelRow) => (y.costA + y.costB) - (x.costA + x.costB) || (x.model < y.model ? -1 : x.model > y.model ? 1 : 0));
  return { rows, limited: c.a.limited || c.b.limited };
}

// ── skills (skill-usage §6.10): per skill its loads, $ and $ per session that loaded it, on each side's counted
// session-days (Day.sa); omitted skills fold into one "(hidden)" row; ● = the share of sessions loading it differs ──
export interface SkillCmpRow { name: string; loadsA: number; loadsB: number; usdA: number; usdB: number; sessA: number; sessB: number; unkA: boolean; unkB: boolean; chi2: number; sig: boolean }
interface SkSide { loads: number; usd: number; unk: boolean; sess: Set<string> }
export const SIG_SESS = 20; // sessions per group before χ² marks a skill row
function skSide(sd: Side): Map<string, SkSide> {
  const m = new Map<string, SkSide>(); const t = sd.t;
  for (const p of t.paths) {
    const a = ledger.get(p); const ds = t.pdays.get(p); if (!a || !ds || !a.sk.length) continue;
    const s = sessions.get(p); const sid = s ? copyKey(s) : p;
    for (const r of skillTable([a], [sid], ds, "cost")) {
      const v = skillVis(r.name); const k = v.mode === "omit" ? HIDDEN : v.shown;
      let x = m.get(k); if (!x) { x = { loads: 0, usd: 0, unk: false, sess: new Set<string>() }; m.set(k, x); }
      x.loads += r.loadsUser + r.loadsModel + r.loadsCompact; x.usd += r.usd; if (r.unpriced || r.tier === "?") x.unk = true; x.sess.add(sid);
    }
  }
  return m;
}
export function skillCmpRows(c: Cmp): { rows: SkillCmpRow[]; significance: boolean } {
  const ma = skSide(c.a); const mb = skSide(c.b);
  const NA = c.a.t.skeys.size; const NB = c.b.t.skeys.size; const sigOn = NA >= SIG_SESS && NB >= SIG_SESS;
  const keys: string[] = []; for (const k of ma.keys()) keys.push(k); for (const k of mb.keys()) if (!ma.has(k)) keys.push(k);
  const rows: SkillCmpRow[] = [];
  for (const k of keys) {
    const a = ma.get(k); const b = mb.get(k); const sA = a ? a.sess.size : 0; const sB = b ? b.sess.size : 0;
    const sc = sigOn && k !== HIDDEN ? score(sB, NB, sA, NA) : null;
    rows.push({ name: k, loadsA: a ? a.loads : 0, loadsB: b ? b.loads : 0, usdA: a ? a.usd : 0, usdB: b ? b.usd : 0, sessA: sA, sessB: sB, unkA: a ? a.unk : false, unkB: b ? b.unk : false, chi2: sc ? sc.chi2 : -1, sig: sc ? sc.sig : false });
  }
  // by $ on both sides, the hidden row last
  rows.sort((x: SkillCmpRow, y: SkillCmpRow) => (x.name === HIDDEN ? 1 : 0) - (y.name === HIDDEN ? 1 : 0) || (y.usdA + y.usdB) - (x.usdA + x.usdB) || (y.loadsA + y.loadsB) - (x.loadsA + x.loadsB) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return { rows, significance: sigOn };
}

// ── timeline: calls per 5-minute slot since each single session's start (hourly from the buckets past call retention) ──
const SLOT = 300000; const HOUR = 3600000; const MAX_SLOTS = 2016; // a week of 5-minute slots
function setOf(xs: string[]): Set<string> { const o = new Set<string>(); for (const x of xs) o.add(x); return o; }
function bump(out: number[], i: number, n: number): void { if (i < 0 || i >= MAX_SLOTS) return; while (out.length <= i) out.push(0); out[i] = (out[i] ?? 0) + n; }
// the side's call rows (subagents per the toggle) on its counted days, by 5-minute slot since t0
function rowsOf(sd: Side, t0: number, out: number[]): void {
  const t = sd.t; const f = sd.f ?? EMPTY; const cut = callCutoff();
  for (const p of t.paths) {
    const x = sessions.get(p); const ds = t.pdays.get(p); if (!x || !ds) continue;
    callsIn(f, x, setOf(ds), cut, (r: Rows, i: number) => bump(out, Math.floor((r.t[i] - t0) / SLOT), 1));
  }
}
// local midnight of the day holding t (scriptc has no new Date(y, m, d))
function midnight(t: number): number { const d = new Date(t); return t - ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 - d.getMilliseconds(); }
// local midnight of day key dk, stepping whole days from t0's day (noon-anchored: DST cannot skip a day)
function dayStart(dk: string, t0: number): number {
  const noon = midnight(t0) + 43200000;
  for (let i = 0; i < 400; i++) { const n = noon + i * 86400000; if (dayKey(new Date(n)) === dk) return midnight(n); }
  return -1;
}
// past call retention: the hourly counts (TS.h) of the counted day buckets, by hour since t0's hour
function hoursOf(sd: Side, t0: number, out: number[]): void {
  const t = sd.t; const h0 = t0 - (t0 - midnight(t0)) % HOUR;
  for (const p of t.paths) {
    const a = ledger.get(p); const ds = t.pdays.get(p); if (!a || !ds) continue;
    for (const dk of ds) {
      const d = a.days.get(dk); const base = dayStart(dk, t0); if (!d || base < 0) continue;
      for (const st of heavy(d).tt.values()) for (let h = 0; h < 24; h++) { const n = st.h[h] ?? 0; if (n) bump(out, Math.floor((base + h * HOUR - h0) / HOUR), n); }
    }
  }
}
export function timeline(c: Cmp): { a: number[]; b: number[]; slot: number } | null {
  const sa = c.A.single; const sb = c.B.single; if (!sa || !sb) return null;
  const aa = ledger.get(sa.path); const ab = ledger.get(sb.path);
  const t0a = aa ? aa.t0 : 0; const t0b = ab ? ab.t0 : 0; if (t0a <= 0 || t0b <= 0) return null;
  const a: number[] = []; const b: number[] = []; const cut = callCutoff();
  if (t0a >= cut && t0b >= cut) { rowsOf(c.a, t0a, a); rowsOf(c.b, t0b, b); return { a, b, slot: SLOT }; }
  hoursOf(c.a, t0a, a); hoursOf(c.b, t0b, b);
  return { a, b, slot: HOUR };
}
