// agentglass — agent-wait digests: a session's call rows summed per local day and family or tool (cache/wait/<key>.json)
// SPDX-License-Identifier: Apache-2.0
// A period report sums per family; reading every calls file of the period for that was most of a first report (0.85 s for
// 7 days here). A digest holds what the report needs of a day, so a period is a fold over day sums: per family / tool the
// calls, timed calls, time, max, failures and histogram; the day's first and last call start (a day lies wholly inside or
// outside a window, else the report reads that session's rows); the unions of the day's call spans (tools, questions to
// the user, polling) and their overlap with the session's next day (the agent-time split stays exact across midnight);
// the heavy calls' spans (overlap figures); and each command of the calls file's family (rows read for a part day or a
// drill-down need no command text). Written beside the calls file when it is saved (cache.ts via callcache.ts CALLS), or
// worked out from a calls file once (report.ts, the backfill job). Valid for the calls file's offset and the family rules
// (this build's built-ins, config.json "wait"); anything else counts as missing. Never a source of truth.
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cursor, eat, skip, num as snum, str as sstr, nums as snums, strs as sstrs, numLists } from "../../util/jsonscan.ts";
import { readText, listDir } from "../../util/fs.ts";
import { rawSection } from "../../util/config.ts";
import { HB, hb } from "../usage/calls.ts";
import { type CallScan, type ScanJob, CACHE_DIR, CALLS, CALLS_DIR, pathKey, scanJob, scanStep, scanCmds } from "../usage/callcache.ts";
import type { Acc } from "../usage/record.ts";
import { DICT, nameOf, localOf } from "../usage/facts.ts";
import { tmpOf } from "../usage/cachefile.ts";
import { FAM_RULES, famIdFor, famName, famKind, famHeavy, famGeneric, toolKind, waitCfg, rowFam, cmdFam, textFam, betterFam } from "./family.ts";

const V = 2; // 2: cf last (a fold stops before it)
export const DIG = { dir: join(CACHE_DIR, "wait") };
// checks: another cache dir
export function setDigestDirForTest(dir: string): void { DIG.dir = dir; }
// the family rules a digest was worked out under
export function rulesKey(): string { return String(FAM_RULES) + "|" + JSON.stringify(rawSection("wait") ?? null); }

// one family (fid ≥ 0) or non-shell tool (fid < 0, tool) on one day; hb = its histogram's non-empty buckets as
// [bucket, count, …] (most entries fill two or three of the 16)
export interface DigEnt { fid: number; tool: string; n: number; timed: number; ms: number; max: number; err: number; hb: number[] }
// one local day: t0/t1 = first/last call start, e1 = last end of a timed call; u = merged length of the call spans
// [tools, user, polling], x = their overlap with the session's next digest day; sp = heavy calls ≥ wait.minSec as
// [start, ms, family id] triples
export interface DigDay { dk: string; t0: number; t1: number; e1: number; u: number[]; x: number[]; ents: DigEnt[]; sp: number[] }
// cf: each command of the calls file (its local order) → family id (-1 none)
export interface Digest { key: string; path: string; off: number; days: DigDay[]; cf: number[] }
// one session's rows as plain columns (from Rows or a scanned calls file): fid = the row's family (-1: a non-shell tool)
export interface DigRows { n: number; t: number[]; ms: number[]; er: number[]; fid: number[]; tool: string[] }

function zeros(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0); return a; }
// [a0, b0, a1, b1, …] → merged, sorted
function merged(iv: number[]): number[] {
  const ps: number[][] = []; for (let k = 0; k + 1 < iv.length; k += 2) ps.push([iv[k] + 0, iv[k + 1] + 0]);
  ps.sort((x: number[], y: number[]) => (x[0] ?? 0) - (y[0] ?? 0));
  const o: number[] = [];
  for (const p of ps) {
    const a = p[0] ?? 0; const b = p[1] ?? 0; const n = o.length;
    if (n && a <= (o[n - 1] ?? 0)) { if (b > (o[n - 1] ?? 0)) o[n - 1] = b; } else { o.push(a); o.push(b); }
  }
  return o;
}
function lenOf(m: number[]): number { let n = 0; for (let k = 0; k + 1 < m.length; k += 2) n += (m[k + 1] ?? 0) - (m[k] ?? 0); return n; }
// overlap length of two merged lists
function inter(a: number[], b: number[]): number {
  let i = 0; let j = 0; let n = 0;
  while (i + 1 < a.length && j + 1 < b.length) {
    const lo = Math.max(a[i] + 0, b[j] + 0); const hi = Math.min(a[i + 1] + 0, b[j + 1] + 0);
    if (hi > lo) n += hi - lo;
    if (a[i + 1] + 0 < b[j + 1] + 0) i += 2; else j += 2;
  }
  return n;
}
interface Work { day: DigDay; m: Map<string, DigEnt>; h: Map<string, number[]> /* full histograms while building */; tv: number[]; uv: number[]; pv: number[] /* spans: tools, user, polling */ }
// the digest of a session's rows (any order); minMs: wait.minSec in ms
export function buildDigest(path: string, off: number, r: DigRows, cf: number[], minMs: number): Digest {
  const by = new Map<string, Work>();
  for (let i = 0; i < r.n; i++) {
    const t = (r.t[i] ?? 0) + 0; const ms = (r.ms[i] ?? -1) + 0; const fid = (r.fid[i] ?? -1) + 0; const tool = fid >= 0 ? "" : r.tool[i] ?? "";
    const dk = localOf(t).day; let w = by.get(dk);
    if (!w) { w = { day: { dk, t0: t, t1: t, e1: t, u: [0, 0, 0], x: [0, 0, 0], ents: [], sp: [] }, m: new Map<string, DigEnt>(), h: new Map<string, number[]>(), tv: [], uv: [], pv: [] }; by.set(dk, w); }
    const d = w.day; if (t < d.t0) d.t0 = t; if (t > d.t1) d.t1 = t;
    const k = fid >= 0 ? "f" + String(fid) : "t" + tool; let e = w.m.get(k);
    if (!e) { e = { fid, tool, n: 0, timed: 0, ms: 0, max: 0, err: 0, hb: [] }; w.m.set(k, e); w.h.set(k, zeros(HB)); d.ents.push(e); }
    e.n++; if ((r.er[i] ?? -1) === 1) e.err++;
    if (ms < 0) continue;
    e.timed++; e.ms += ms; if (ms > e.max) e.max = ms;
    const hs = w.h.get(k); const b = hb(ms); if (hs) hs[b] = (hs[b] ?? 0) + 1;
    if (ms <= 0) continue;
    if (t + ms > d.e1) d.e1 = t + ms;
    const kind = fid >= 0 ? famKind(fid) : toolKind(tool);
    w.tv.push(t); w.tv.push(t + ms);
    if (kind === "user" && fid < 0) { w.uv.push(t); w.uv.push(t + ms); }
    if (kind === "wait" || kind === "ci") { w.pv.push(t); w.pv.push(t + ms); }
    if (fid >= 0 && famHeavy(fid) && ms >= minMs) { d.sp.push(t); d.sp.push(ms); d.sp.push(fid); }
  }
  const ks = [...by.keys()].sort();
  const days: DigDay[] = []; let pt: number[] = []; let pu: number[] = []; let pp: number[] = [];
  for (const k of ks) {
    const w = by.get(k); if (!w) continue;
    for (const [ek, e] of w.m) { const hs = w.h.get(ek) ?? []; for (let b = 0; b < hs.length; b++) { const c = (hs[b] ?? 0) + 0; if (c) { e.hb.push(b); e.hb.push(c); } } }
    const mt = merged(w.tv); const mu = merged(w.uv); const mp = merged(w.pv);
    w.day.u = [lenOf(mt), lenOf(mu), lenOf(mp)];
    const pd = days[days.length - 1]; if (pd) pd.x = [inter(pt, mt), inter(pu, mu), inter(pp, mp)];
    days.push(w.day); pt = mt; pu = mu; pp = mp;
  }
  return { key: rulesKey(), path, off, days, cf };
}

// ── file ──
function fileOf(path: string): string { return join(DIG.dir, pathKey(path) + ".json"); }
export function encodeDigest(g: Digest): string {
  const loc = new Map<number, number>(); const fn: string[] = []; const fk: string[] = []; const fh: number[] = []; const fg: number[] = [];
  const lf = (id: number): number => {
    if (id < 0) return -1;
    let x = loc.get(id); if (x === undefined) { x = fn.length; loc.set(id, x); fn.push(famName(id)); fk.push(famKind(id)); fh.push(famHeavy(id) ? 1 : 0); fg.push(famGeneric(id) ? 1 : 0); }
    return x;
  };
  const tl = new Map<string, number>(); const tn: string[] = [];
  const lt = (t: string): number => { let x = tl.get(t); if (x === undefined) { x = tn.length; tl.set(t, x); tn.push(t); } return x; };
  const dk: string[] = []; const dt: number[] = []; const du: number[] = []; const da: number[][] = []; const ds: number[][] = [];
  for (const d of g.days) {
    dk.push(d.dk); dt.push(d.t0); dt.push(d.t1); dt.push(d.e1);
    for (const v of d.u) du.push(v); for (const v of d.x) du.push(v);
    const a: number[] = [];
    for (const e of d.ents) {
      a.push(e.fid >= 0 ? lf(e.fid) : -1 - lt(e.tool)); a.push(e.n); a.push(e.timed); a.push(e.ms); a.push(e.max); a.push(e.err);
      a.push(e.hb.length / 2); for (const v of e.hb) a.push(v);
    }
    da.push(a);
    const s: number[] = []; for (let k = 0; k + 2 < d.sp.length; k += 3) { s.push(d.sp[k] ?? 0); s.push(d.sp[k + 1] ?? 0); s.push(lf((d.sp[k + 2] ?? -1) + 0)); }
    ds.push(s);
  }
  const cf: number[] = []; for (const id of g.cf) cf.push(lf(id));
  return JSON.stringify({ v: V, key: g.key, path: g.path, off: g.off, fn, fk, fh, fg, tn, dk, dt, du, da, ds, cf }); // cf last: a fold stops before it
}
// cf: read the command families too (rows read for a part day or a drill-down); a fold needs only the days
export function decodeDigest(body: string, cfToo: boolean): Digest | null {
  const c = cursor(body);
  let v = -1; let key = ""; let path = ""; let off = -1; let fn: string[] = []; let fk: string[] = []; let fh: number[] = []; let fg: number[] = []; let tn: string[] = [];
  let cf: number[] = []; let dk: string[] = []; let dt: number[] = []; let du: number[] = []; let da: number[][] = []; let ds: number[][] = [];
  if (!eat(c, 123)) return null;
  if (!eat(c, 125)) for (;;) {
    const k = sstr(c); if (!c.ok || !eat(c, 58)) return null;
    if (k === "cf" && !cfToo) break; // the last member (encodeDigest)
    if (k === "v") v = snum(c); else if (k === "key") key = sstr(c); else if (k === "path") path = sstr(c); else if (k === "off") off = snum(c);
    else if (k === "fn") fn = sstrs(c); else if (k === "fk") fk = sstrs(c); else if (k === "fh") fh = snums(c); else if (k === "fg") fg = snums(c); else if (k === "tn") tn = sstrs(c);
    else if (k === "cf") cf = snums(c); else if (k === "dk") dk = sstrs(c); else if (k === "dt") dt = snums(c); else if (k === "du") du = snums(c);
    else if (k === "da") da = numLists(c); else if (k === "ds") ds = numLists(c);
    else skip(c);
    if (!c.ok) return null;
    if (eat(c, 44)) continue;
    if (eat(c, 125)) break;
    return null;
  }
  const nd = dk.length;
  if (v !== V || fk.length !== fn.length || fh.length !== fn.length || fg.length !== fn.length || dt.length !== nd * 3 || du.length !== nd * 6 || da.length !== nd || ds.length !== nd) return null;
  const gid: number[] = []; for (let i = 0; i < fn.length; i++) gid.push(famIdFor(fn[i] ?? "", fk[i] ?? "other", fh[i] === 1, fg[i] === 1));
  const fam = (x: number): number => (x >= 0 && x < gid.length ? (gid[x] ?? -1) + 0 : -1);
  const days: DigDay[] = [];
  for (let i = 0; i < nd; i++) {
    const a = da[i] ?? []; const ents: DigEnt[] = []; let k = 0;
    while (k + 6 < a.length) {
      const key0 = (a[k] ?? 0) + 0; const nb = (a[k + 6] ?? 0) + 0; if (k + 7 + nb * 2 > a.length) return null;
      const hbs = a.slice(k + 7, k + 7 + nb * 2); for (let b = 0; b < hbs.length; b += 2) if ((hbs[b] ?? -1) < 0 || (hbs[b] ?? HB) >= HB) return null;
      const ti = -1 - key0;
      if (key0 < 0 && ti >= tn.length) return null;
      ents.push({ fid: key0 >= 0 ? fam(key0) : -1, tool: key0 >= 0 ? "" : tn[ti] ?? "", n: (a[k + 1] ?? 0) + 0, timed: (a[k + 2] ?? 0) + 0, ms: (a[k + 3] ?? 0) + 0, max: (a[k + 4] ?? 0) + 0, err: (a[k + 5] ?? 0) + 0, hb: hbs });
      k += 7 + nb * 2;
    }
    if (k !== a.length) return null;
    const s0 = ds[i] ?? []; const sp: number[] = [];
    for (let j = 0; j + 2 < s0.length; j += 3) { sp.push((s0[j] ?? 0) + 0); sp.push((s0[j + 1] ?? 0) + 0); sp.push(fam((s0[j + 2] ?? -1) + 0)); }
    days.push({ dk: dk[i] ?? "", t0: (dt[i * 3] ?? 0) + 0, t1: (dt[i * 3 + 1] ?? 0) + 0, e1: (dt[i * 3 + 2] ?? 0) + 0, u: du.slice(i * 6, i * 6 + 3), x: du.slice(i * 6 + 3, i * 6 + 6), ents, sp });
  }
  const cg: number[] = []; for (const x of cf) cg.push(fam(x));
  return { key, path, off, days, cf: cg };
}
export const DIG_STATS = { read: 0, written: 0, built: 0 }; // counters for checks
// the digest of path for its calls file at off, under the current rules (cfToo: decodeDigest); null = none valid
export function readDigest(path: string, off: number, cfToo: boolean): Digest | null {
  const f = fileOf(path); let size = 0;
  try { size = statSync(f).size; } catch (e) { return null; }
  DIG_STATS.read++;
  const g = decodeDigest(readText(f, 0, size), cfToo);
  return g && g.path === path && g.off === off && g.key === rulesKey() ? g : null;
}
// is there a valid digest of path at off? Its head only (v, key, path, off come first): no day is decoded
export function digestValid(path: string, off: number): boolean {
  const f = fileOf(path); let size = 0;
  try { size = statSync(f).size; } catch (e) { return false; }
  const key = rulesKey(); const c = cursor(readText(f, 0, Math.min(size, 1024 + key.length * 2)));
  let v = -1; let k0 = ""; let p0 = ""; let o0 = -1;
  if (!eat(c, 123)) return false;
  for (let i = 0; i < 4; i++) {
    const k = sstr(c); if (!c.ok || !eat(c, 58)) return false;
    if (k === "v") v = snum(c); else if (k === "key") k0 = sstr(c); else if (k === "path") p0 = sstr(c); else if (k === "off") o0 = snum(c); else return false;
    if (!c.ok || !eat(c, 44)) return false;
  }
  return v === V && k0 === key && p0 === path && o0 === off;
}
// atomic (a writer of its own: two agentglass runs may save at once); a failed write only costs the work again
export function writeDigest(g: Digest): void {
  try {
    mkdirSync(DIG.dir, { recursive: true });
    const f = fileOf(g.path); const tmp = tmpOf(f);
    const fd = openSync(tmp, "w"); writeSync(fd, encodeDigest(g)); closeSync(fd);
    renameSync(tmp, f); DIG_STATS.written++;
  } catch (e) { /* a cache */ }
}
// digests of sessions that no longer exist go (and leftovers of an interrupted write a minute old: another process may be
// writing one now); live = pathKeys
export function sweepDigests(live: Set<string>): void {
  const now = Date.now();
  for (const n of listDir(DIG.dir)) {
    if (n.endsWith(".json") && live.has(n.slice(0, -5))) continue;
    const f = join(DIG.dir, n);
    if (n.endsWith(".tmp")) { let m = now; try { m = statSync(f).mtimeMs; } catch (e) { continue; } if (now - m < 60000) continue; }
    try { unlinkSync(f); } catch (e) { /* gone already */ }
  }
  try { unlinkSync(join(CACHE_DIR, "wait-families.json")); } catch (e) { /* 2026.10.10 kept families there; digests hold them now */ }
}
// the digest of a session's rows in memory, at its calls file's offset (cmds: the file's command list); the families were
// worked out while the rows were indexed (calls.ts CMDS.booked), so this is one pass over the rows
export function digestOfRows(path: string, a: Acc, cmds: number[]): Digest {
  const rw = a.rows; const dr: DigRows = { n: rw.n, t: [], ms: [], er: [], fid: [], tool: [] };
  for (let i = 0; i < rw.n; i++) {
    const fid = rowFam(rw, i);
    dr.t.push(rw.t[i] + 0); dr.ms.push(rw.ms[i] + 0); dr.er.push(rw.err[i] + 0); dr.fid.push(fid); dr.tool.push(fid >= 0 ? "" : nameOf(DICT.tool, rw.tool[i] + 0));
  }
  const cf: number[] = []; for (const id of cmds) cf.push(cmdFam(id));
  DIG_STATS.built++;
  return buildDigest(path, a.off, dr, cf, minMs());
}
// the digest of a calls file not in memory (its command texts normalised once each), written for the next reader; sc =
// the file as read (the caller may want its rows now). null: no readable file at a's offset — or a format-2 file with a
// 200-character command, whose session must index again (callcache.ts FORMAT). As a job (digestStep in time slices: a
// big file is read member by member, its texts normalised a batch at a time) or at once (digestOfFile).
export interface DigJob { path: string; a: Acc; sj: ScanJob; fams: number[]; done: boolean; out: { g: Digest; sc: CallScan } | null }
export function digestJob(path: string, a: Acc): DigJob { return { path, a, sj: scanJob(CALLS_DIR, path, a, true), fams: [], done: false, out: null }; }
// until the clock passes until (some progress at least); true when done (j.out)
export function digestStep(j: DigJob, until: number): boolean {
  if (j.done) return true;
  if (!j.sj.done && !scanStep(j.sj, until)) return false;
  const sc = j.sj.out; if (!sc) { j.done = true; return true; }
  while (j.fams.length < sc.cmds.length) { j.fams.push(textFam(sc.cmds[j.fams.length] ?? "")); if ((j.fams.length & 63) === 0 && Date.now() >= until) return false; }
  const fams = j.fams; const dr: DigRows = { n: sc.n, t: sc.t, ms: sc.ms, er: sc.er, fid: [], tool: [] };
  for (let i = 0; i < sc.n; i++) {
    let fid = -1; for (const c of scanCmds(sc, i)) if (c >= 0 && c < fams.length) fid = betterFam(fid, (fams[c + 0] ?? -1) + 0);
    const ti = (sc.to[i] ?? -1) + 0; dr.fid.push(fid); dr.tool.push(fid >= 0 || ti < 0 ? "" : sc.tools[ti] ?? "");
  }
  const g = buildDigest(j.path, j.a.off, dr, fams, minMs()); DIG_STATS.built++; writeDigest(g);
  j.out = { g, sc }; j.done = true; return true;
}
export function digestOfFile(path: string, a: Acc): { g: Digest; sc: CallScan } | null { const j = digestJob(path, a); digestStep(j, Infinity); return j.out; }
CALLS.saved = (path: string, a: Acc, cmds: number[]): void => { writeDigest(digestOfRows(path, a, cmds)); };
CALLS.swept = sweepDigests;
// minSec in ms (the spans' threshold)
export function minMs(): number { return waitCfg().minSec * 1000; }
