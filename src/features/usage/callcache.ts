// agentglass — per-session call-row files (~/.agentglass/cache/calls/<key>.json): columnar, local dictionaries, retention
// SPDX-License-Identifier: Apache-2.0
// A calls file is valid only for the ledger offset it was written at and the path it names: anything else (a crash between
// this write and ledger.jsonl's, a hash collision, an old format) counts as missing and that one session re-indexes.
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cursor, eat, skip, numLists, num as snum, str as sstr, nums as snums, strs as sstrs } from "../../util/jsonscan.ts";
import { readText, listDir, cacheDir } from "../../util/fs.ts";
import { intSetting } from "../../util/config.ts";
import { type Acc, startOfDay, num, peekHeavy } from "./record.ts";
import { type Dict, DICT, intern, nameOf } from "./facts.ts";
import { type Rows, sized, compact, rowIds, KIND_PROG, KIND_CMD, KIND_FILE } from "./rows.ts";

// AGENTGLASS_CACHE_DIR: a separate ledger cache (test builds of other branches must not rewrite the real one)
export const CACHE_DIR = cacheDir();
export const CALLS_DIR = join(CACHE_DIR, "calls");
const FORMAT = 2; // 2: command/file texts as references into the ledger day counters (else front-coded), delta call times, call id prefix

// two 32-bit FNV-1a hashes with different offset bases, 16 hex chars (scriptc has no node:crypto, no toString(16))
function fnv(s: string, h0: number): number { let h = h0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const HEX = "0123456789abcdef";
function hex8(n: number): string { let o = ""; for (let i = 28; i >= 0; i -= 4) o += HEX.charAt((n >>> i) & 15); return o; }
export function pathKey(p: string): string { return hex8(fnv(p, 2166136261)) + hex8(fnv(p, 3735928559)); }

// retention in local days (today counts as one); config filter.callDays
let daysOverride = 0;
export function callDays(): number { return daysOverride > 0 ? daysOverride : intSetting("filter", "callDays", 1, 0, 90); }
export function setCallDaysForTest(n: number): void { daysOverride = n; }
// start of the oldest local day still holding rows
export function callCutoff(): number { return startOfDay() - (callDays() - 1) * 86400000; }

// global dictionary id → local index into the file's own name list
function localId(d: Dict, m: Map<number, number>, names: string[], i: number): number {
  if (i < 0) return -1;
  const hit = m.get(i); if (hit !== undefined) return hit;
  names.push(nameOf(d, i)); m.set(i, names.length - 1); return names.length - 1;
}
function localIds(d: Dict, m: Map<number, number>, names: string[], xs: number[]): number[] { const o: number[] = []; for (const x of xs) o.push(localId(d, m, names, x)); return o; }

// Command lines and file paths are the bulk of a calls file, and the ledger already keeps each of them as a day-counter key
// ("<tool>\t<text>", Day.cmds / Day.files) of the same session at the same off. A file stores a 32-bit hash of the text
// instead; decoding resolves it against those keys. A text the keys lack, or whose hash is shared by another text of the
// session, is stored literally (ref = -1 - index into the literal list). An unresolvable hash makes the file invalid.
const AMBIG = "\u0000"; // two texts of one session share the hash
function textHash(s: string): number { return fnv(s, 2166136261); }
// both tables in one pass over the days; a day not decoded yet is decoded for this and dropped again (peekHeavy): reading
// a session's rows must not pin every day's heavy maps
interface Refs { cmds: Map<number, string>; files: Map<number, string> }
function refInto(m: Map<number, string>, k: string): void {
  const x = k.slice(k.indexOf("\t") + 1); const h = textHash(x); const o = m.get(h);
  if (o === undefined) m.set(h, x); else if (o !== x) m.set(h, AMBIG);
}
function refTables(a: Acc): Refs {
  const r: Refs = { cmds: new Map<number, string>(), files: new Map<number, string>() };
  for (const d of a.days.values()) { const h = peekHeavy(d); for (const k of h.cmds.keys()) refInto(r.cmds, k); for (const k of h.files.keys()) refInto(r.files, k); }
  return r;
}
function refsOut(names: string[], tab: Map<number, string>, lits: string[]): number[] {
  const o: number[] = [];
  for (const n of names) { const h = textHash(n); if (tab.get(h) === n) o.push(h); else { lits.push(n); o.push(-lits.length); } }
  return o;
}
// literals sorted and front-coded (length of the prefix shared with the previous one + the rest): commands of one session
// share long prefixes ("cd /repo && npm run …"); refs are renumbered to the sorted order
interface Front { pre: number[]; rest: string[] }
function frontOut(lits: string[], refs: number[]): Front {
  const ix: number[] = []; for (let i = 0; i < lits.length; i++) ix.push(i);
  ix.sort((x: number, y: number) => { const a = lits[x] ?? ""; const b = lits[y] ?? ""; return a < b ? -1 : a > b ? 1 : 0; });
  const pos: number[] = []; for (let i = 0; i < ix.length; i++) pos.push(0);
  const pre: number[] = []; const rest: string[] = []; let prev = "";
  for (let k = 0; k < ix.length; k++) {
    const i = ix[k] ?? 0; const x = lits[i] ?? ""; pos[i] = k;
    let n = 0; const m = Math.min(prev.length, x.length); while (n < m && prev.charCodeAt(n) === x.charCodeAt(n)) n++;
    pre.push(n); rest.push(x.slice(n)); prev = x;
  }
  for (let j = 0; j < refs.length; j++) { const r = refs[j] ?? 0; if (r < 0) refs[j] = -1 - (pos[-r - 1] ?? 0); }
  return { pre, rest };
}
function frontIn(pre: number[], rest: string[]): string[] | null {
  if (pre.length !== rest.length) return null;
  const o: string[] = []; let prev = "";
  for (let i = 0; i < pre.length; i++) { const n = pre[i] ?? 0; if (n > prev.length) return null; prev = prev.slice(0, n) + (rest[i] ?? ""); o.push(prev); }
  return o;
}
// the longest prefix all non-empty call ids share, one char short of the shortest (a suffix is never "": "" = no id)
function cidPrefix(ids: string[]): string {
  let p = ""; let first = true;
  for (const c of ids) {
    if (!c) continue;
    if (first) { p = c.slice(0, c.length - 1); first = false; continue; }
    let i = 0; const n = Math.min(p.length, c.length - 1);
    while (i < n && p.charCodeAt(i) === c.charCodeAt(i)) i++;
    p = p.slice(0, i);
  }
  return p;
}
export function encodeCalls(path: string, a: Acc): string {
  const tn: string[] = []; const mn: string[] = []; const pn: string[] = []; const cn: string[] = []; const fn: string[] = [];
  const tm = new Map<number, number>(); const mm = new Map<number, number>(); const pm = new Map<number, number>(); const cm = new Map<number, number>(); const fm = new Map<number, number>();
  const t: number[] = []; const to: number[] = []; const mo: number[] = []; const mq: number[] = []; const pg: number[][] = []; const cmd: number[][] = []; const fi: number[][] = [];
  const ms: number[] = []; const er: number[] = []; const ou: number[] = []; const ids: string[] = [];
  let prev = 0; const r = a.rows;
  for (let i = 0; i < r.n; i++) {
    const ti = r.t[i] + 0; t.push(ti - prev); prev = ti; // deltas: a few digits instead of 13
    to.push(localId(DICT.tool, tm, tn, r.tool[i] + 0)); mo.push(localId(DICT.model, mm, mn, r.model[i] + 0)); mq.push(r.mq[i] + 0);
    pg.push(localIds(DICT.prog, pm, pn, rowIds(r, i, KIND_PROG))); cmd.push(localIds(DICT.cmd, cm, cn, rowIds(r, i, KIND_CMD))); fi.push(localIds(DICT.file, fm, fn, rowIds(r, i, KIND_FILE)));
    ms.push(r.ms[i] + 0); er.push(r.err[i] + 0); ou.push(r.out[i] + 0); ids.push(r.cid[i] ?? "");
  }
  const cl: string[] = []; const fl: string[] = [];
  const rt = refTables(a); const cr = refsOut(cn, rt.cmds, cl); const fr = refsOut(fn, rt.files, fl);
  const cf = frontOut(cl, cr); const ff = frontOut(fl, fr);
  const cp = cidPrefix(ids); const ci: string[] = []; for (const c of ids) ci.push(c ? c.slice(cp.length) : "");
  return JSON.stringify({ v: FORMAT, path, off: a.off, tool: tn, model: mn, prog: pn, cmd: cr, cmdp: cf.pre, cmdl: cf.rest, file: fr, filep: ff.pre, filel: ff.rest, cp, t, to, mo, mq, pg, cm: cmd, fi, ms, er, ou, ci });
}

// local names → global ids (re-interned into DICT)
function globalIds(d: Dict, ns: string[]): number[] { const o: number[] = []; for (const n of ns) o.push(intern(d, n)); return o; }
// text references (hashes or literal indexes) → global ids; null when a hash does not resolve in this ledger state
function refIds(d: Dict, rs: number[], pl: number[], rl: string[], tab: Map<number, string>): number[] | null {
  const ls = frontIn(pl, rl); if (!ls) return null;
  const o: number[] = [];
  for (const r of rs) {
    let x = "";
    if (r < 0) { const i = -r - 1; if (i >= ls.length) return null; x = ls[i] ?? ""; }
    else { const hit = tab.get(r); if (hit === undefined || hit === AMBIG) return null; x = hit; }
    o.push(intern(d, x));
  }
  return o;
}
// + 0: scriptc cannot index with a bare element read that came out of this same function (SC1090)
function at(m: number[], i: number): number { if (i < 0 || i >= m.length) return -1; return m[i] + 0; }
const LITE_SKIP = new Set<string>(["model", "prog", "file", "filep", "filel", "mo", "mq", "ou", "pg", "fi"]);
// a calls file's members, read with the pull reader (util/jsonscan.ts: no JSON tree); a missing column reads as empty
interface CF {
  v: number; path: string; off: number; cp: string; tool: string[]; model: string[]; prog: string[]; cmdl: string[]; filel: string[]; ci: string[];
  cmd: number[]; cmdp: number[]; file: number[]; filep: number[]; t: number[]; to: number[]; mo: number[]; mq: number[]; ms: number[]; er: number[]; ou: number[];
  pg: number[][]; cm: number[][]; fi: number[][];
}
// lite (scanCalls): only what the wait report reads (times, tools, durations, results, call ids, command refs; the command
// texts only when texts); the other members are skipped unparsed
function readCF(body: string, lite: boolean, texts: boolean): CF | null {
  const f: CF = { v: -1, path: "", off: -1, cp: "", tool: [], model: [], prog: [], cmdl: [], filel: [], ci: [], cmd: [], cmdp: [], file: [], filep: [], t: [], to: [], mo: [], mq: [], ms: [], er: [], ou: [], pg: [], cm: [], fi: [] };
  const c = cursor(body);
  if (!eat(c, 123)) return null;
  if (eat(c, 125)) return f;
  for (;;) {
    const k = sstr(c); if (!c.ok || !eat(c, 58)) return null;
    if (lite && (LITE_SKIP.has(k) || (!texts && (k === "cmdp" || k === "cmdl")))) skip(c);
    else if (k === "v") f.v = snum(c); else if (k === "off") f.off = snum(c); else if (k === "path") f.path = sstr(c); else if (k === "cp") f.cp = sstr(c);
    else if (k === "tool") f.tool = sstrs(c); else if (k === "model") f.model = sstrs(c); else if (k === "prog") f.prog = sstrs(c);
    else if (k === "cmdl") f.cmdl = sstrs(c); else if (k === "filel") f.filel = sstrs(c); else if (k === "ci") f.ci = sstrs(c);
    else if (k === "cmd") f.cmd = snums(c); else if (k === "cmdp") f.cmdp = snums(c); else if (k === "file") f.file = snums(c); else if (k === "filep") f.filep = snums(c);
    else if (k === "t") f.t = snums(c); else if (k === "to") f.to = snums(c); else if (k === "mo") f.mo = snums(c); else if (k === "mq") f.mq = snums(c);
    else if (k === "ms") f.ms = snums(c); else if (k === "er") f.er = snums(c); else if (k === "ou") f.ou = snums(c);
    else if (k === "pg") f.pg = numLists(c); else if (k === "cm") f.cm = numLists(c); else if (k === "fi") f.fi = numLists(c);
    else skip(c);
    if (!c.ok) return null;
    if (eat(c, 44)) continue;
    if (eat(c, 125)) return f;
    return null;
  }
}
// null = missing, corrupt, written for another path or another ledger offset, or referring to texts this ledger state lacks:
// the caller re-indexes the session. a = the session's ledger entry the file must be consistent with (off, day counters).
export function decodeCalls(body: string, path: string, a: Acc): Rows | null {
  const o = readCF(body, false, false);
  if (!o || o.v !== FORMAT || o.path !== path || o.off !== a.off) return null;
  const tg = globalIds(DICT.tool, o.tool); const mg = globalIds(DICT.model, o.model); const pg = globalIds(DICT.prog, o.prog);
  const rt = refTables(a);
  const cg = refIds(DICT.cmd, o.cmd, o.cmdp, o.cmdl, rt.cmds); if (!cg) return null;
  const fg = refIds(DICT.file, o.file, o.filep, o.filel, rt.files); if (!fg) return null;
  const t = o.t; const n = t.length;
  const to = o.to; const mo = o.mo; const mq = o.mq; const ms = o.ms; const er = o.er; const ou = o.ou; const ci = o.ci; const cp = o.cp;
  const pl = o.pg; const cl = o.cm; const fl = o.fi;
  for (const col of [to, mo, mq, ms, er, ou]) if (col.length !== n) return null;
  if (ci.length !== n || pl.length !== n || cl.length !== n || fl.length !== n) return null;
  // straight into the columns: no per-row object
  let nl = 0; for (let i = 0; i < n; i++) nl += (pl[i] ?? []).length + (cl[i] ?? []).length + (fl[i] ?? []).length;
  const out = sized(n, nl); let tt = 0; let k = 0;
  const ids = (g: number[], xs: number[], kind: number): void => { for (const x of xs) { const v = at(g, x); if (v >= 0) { out.li[k] = v * 4 + kind; k++; } } };
  for (let i = 0; i < n; i++) {
    tt += at(t, i); const id = ci[i] ?? "";
    out.t[i] = tt; out.tool[i] = at(tg, at(to, i)); out.model[i] = at(mg, at(mo, i)); out.mq[i] = at(mq, i);
    out.ms[i] = at(ms, i); out.err[i] = at(er, i); out.out[i] = at(ou, i); out.cid.push(id ? cp + id : ""); out.lo[i] = k;
    ids(pg, pl[i] ?? [], KIND_PROG); ids(cg, cl[i] ?? [], KIND_CMD); ids(fg, fl[i] ?? [], KIND_FILE);
  }
  out.n = n; out.nl = k;
  return out;
}

// A calls file read for one pass, nothing kept (agent-wait: a period's report reads thousands of files once): rows as plain
// columns with local ids (cm: indexes into the file's command list, ncmd long; an index out of range names nothing, as in
// decodeCalls), no interning into DICT and no Rows; cmds = the command texts, only when asked (resolving references
// decodes the session's day counters), else empty. Valid exactly when decodeCalls is (null: read it through callsOf).
export interface CallScan { n: number; t: number[]; to: number[]; tools: string[]; ms: number[]; er: number[]; cp: string; ci: string[]; cm: number[][]; ncmd: number; cmds: string[] }
export function scanCalls(body: string, path: string, a: Acc, texts: boolean): CallScan | null {
  const o = readCF(body, true, texts);
  if (!o || o.v !== FORMAT || o.path !== path || o.off !== a.off) return null;
  const n = o.t.length;
  for (const col of [o.to, o.ms, o.er]) if (col.length !== n) return null;
  if (o.ci.length !== n || o.cm.length !== n) return null;
  let cmds: string[] = [];
  if (texts) {
    const ls = frontIn(o.cmdp, o.cmdl); if (!ls) return null;
    const tab = cmdRefs(a);
    for (const r of o.cmd) {
      if (r < 0) { const i = -r - 1; if (i >= ls.length) return null; cmds.push(ls[i] ?? ""); continue; }
      const hit = tab.get(r); if (hit === undefined || hit === AMBIG) return null; cmds.push(hit);
    }
  }
  const t: number[] = []; let tt = 0; for (let i = 0; i < n; i++) { tt += at(o.t, i); t.push(tt); }
  return { n, t, to: o.to, tools: o.tool, ms: o.ms, er: o.er, cp: o.cp, ci: o.ci, cm: o.cm, ncmd: o.cmd.length, cmds };
}
// refTables' command half (a day not decoded yet is decoded for this and dropped again)
function cmdRefs(a: Acc): Map<number, string> {
  const m = new Map<number, string>();
  for (const d of a.days.values()) for (const k of peekHeavy(d).cmds.keys()) refInto(m, k);
  return m;
}
export function scanCallsFrom(dir: string, path: string, a: Acc, texts: boolean): CallScan | null {
  const f = fileOf(dir, path);
  let size = 0; try { size = statSync(f).size; } catch (e) { return null; }
  return scanCalls(readText(f, 0, size).trim(), path, a, texts);
}

// drop rows older than cutoff (rows are in call order, but a restored session may interleave: filter, not slice); the
// newest row and the pending calls' rows follow their rows' new places (-1 = dropped)
export function prune(a: Acc, cutoff: number): boolean {
  const r = a.rows;
  let keep = 0; for (let i = 0; i < r.n; i++) if (r.t[i] >= cutoff) keep++;
  if (keep === r.n) return false;
  const nw = a.lastCall >= 0 && a.lastCall < r.n ? a.lastCall : -1;
  const map = compact(r, (i: number): boolean => r.t[i] >= cutoff);
  const to = (i: number): number => (i >= 0 && i < map.length ? map[i] + 0 : -1);
  a.lastCall = to(nw);
  for (const p of a.pend.values()) if (p.rows === r) p.ri = to(p.ri);
  return true;
}

function fileOf(dir: string, path: string): string { return join(dir, pathKey(path) + ".json"); }
// atomic: a crash mid-write never leaves a torn file (and a torn one would fail its checks anyway)
export function saveCallsTo(dir: string, path: string, a: Acc): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const f = fileOf(dir, path); const tmp = f + ".tmp";
    const fd = openSync(tmp, "w"); writeSync(fd, encodeCalls(path, a)); closeSync(fd);
    renameSync(tmp, f);
    return true;
  } catch (e) { return false; }
}
export function loadCallsFrom(dir: string, path: string, a: Acc): Rows | null {
  const f = fileOf(dir, path);
  let size = 0; try { size = statSync(f).size; } catch (e) { return null; }
  return decodeCalls(readText(f, 0, size).trim(), path, a);
}
// remove calls files of sessions that no longer exist (and leftovers of an interrupted write)
export function sweepCalls(dir: string, live: Set<string>): void {
  for (const n of listDir(dir)) {
    if (n.endsWith(".json") && live.has(n.slice(0, -5))) continue;
    try { unlinkSync(join(dir, n)); } catch (e) { /* gone already */ }
  }
}
