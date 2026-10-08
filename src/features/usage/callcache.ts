// agentglass — per-session call-row files (~/.agentglass/cache/calls/<key>.json): columnar, local dictionaries, retention
// SPDX-License-Identifier: Apache-2.0
// A calls file is valid only for the ledger offset it was written at and the path it names: anything else (a crash between
// this write and ledger.jsonl's, a hash collision, an old format) counts as missing and that one session re-indexes.
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Cur, cursor, eat, skip, numLists, num as snum, str as sstr, nums as snums, strs as sstrs } from "../../util/jsonscan.ts";
import { readText, listDir, cacheDir } from "../../util/fs.ts";
import { intSetting } from "../../util/config.ts";
import { type Acc, startOfDay, num, peekHeavy } from "./record.ts";
import { CMDS } from "./calls.ts";
import { type Dict, DICT, intern, nameOf } from "./facts.ts";
import { type Rows, sized, compact, rowIds, KIND_PROG, KIND_CMD, KIND_FILE, KIND_HINT } from "./rows.ts";

// AGENTGLASS_CACHE_DIR: a separate ledger cache (test builds of other branches must not rewrite the real one)
export const CACHE_DIR = cacheDir();
export const CALLS_DIR = join(CACHE_DIR, "calls");
const FORMAT = 3; // 3: family hints of cut command lines (hm); 2: command/file texts as references into the ledger day counters (else front-coded), delta call times, call id prefix
// A format-2 file reads on (it has no hints) unless a command text in it is 200 characters long and the cut may have
// changed its family (calls.ts CMDS.mayHide): its hint is not in the file, so that session indexes again (once). The
// same for a Codex session that used exec / exec_command: a build before format 3 ended a yielded run at its yield
// (harness/codex.ts), in its rows and in the ledger's day sums alike.
const CUT = 200;
const YIELDING = ["exec", "exec_command"];

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
// row i's commands (global ids) and the hint after each (-1 none), in order
function cmdHints(r: Rows, i: number, cs: number[], hs: number[]): void {
  const e = i + 1 < r.n ? r.lo[i + 1] + 0 : r.nl;
  for (let k = r.lo[i] + 0; k < e; k++) {
    const v = r.li[k] + 0; if (v % 4 !== KIND_CMD) continue;
    const h = k + 1 < e ? r.li[k + 1] + 0 : -1;
    cs.push((v - KIND_CMD) / 4); hs.push(h >= 0 && h % 4 === KIND_HINT ? (h - KIND_HINT) / 4 : -1);
  }
}
// a calls file's text and its command list (global ids, in the file's local order: the wait digest names each one's family)
export interface Encoded { body: string; cmds: number[] }
export function encodeCalls(path: string, a: Acc): string { return encodeCallsX(path, a).body; }
export function encodeCallsX(path: string, a: Acc): Encoded {
  const tn: string[] = []; const mn: string[] = []; const pn: string[] = []; const cn: string[] = []; const fn: string[] = [];
  const tm = new Map<number, number>(); const mm = new Map<number, number>(); const pm = new Map<number, number>(); const cm = new Map<number, number>(); const fm = new Map<number, number>();
  const t: number[] = []; const to: number[] = []; const mo: number[] = []; const mq: number[] = []; const pg: number[][] = []; const cmd: number[][] = []; const hm: number[][] = []; const fi: number[][] = [];
  const cg: number[] = []; // the local command list's global ids
  let hints = false;
  const ms: number[] = []; const er: number[] = []; const ou: number[] = []; const ids: string[] = [];
  let prev = 0; const r = a.rows;
  for (let i = 0; i < r.n; i++) {
    const ti = r.t[i] + 0; t.push(ti - prev); prev = ti; // deltas: a few digits instead of 13
    to.push(localId(DICT.tool, tm, tn, r.tool[i] + 0)); mo.push(localId(DICT.model, mm, mn, r.model[i] + 0)); mq.push(r.mq[i] + 0);
    pg.push(localIds(DICT.prog, pm, pn, rowIds(r, i, KIND_PROG)));
    const cs: number[] = []; const hs: number[] = []; cmdHints(r, i, cs, hs);
    const lc: number[] = []; for (const c of cs) { const n0 = cn.length; lc.push(localId(DICT.cmd, cm, cn, c)); if (cn.length > n0) cg.push(c); }
    let lh: number[] = []; for (const h of hs) { if (h < 0) { lh.push(-1); continue; } hints = true; const n0 = cn.length; lh.push(localId(DICT.cmd, cm, cn, h)); if (cn.length > n0) cg.push(h); }
    if (lh.every((x: number): boolean => x < 0)) lh = []; // no hint in the row: nothing to align
    cmd.push(lc); hm.push(lh);
    fi.push(localIds(DICT.file, fm, fn, rowIds(r, i, KIND_FILE)));
    ms.push(r.ms[i] + 0); er.push(r.err[i] + 0); ou.push(r.out[i] + 0); ids.push(r.cid[i] ?? "");
  }
  const cl: string[] = []; const fl: string[] = [];
  const rt = refTables(a); const cr = refsOut(cn, rt.cmds, cl); const fr = refsOut(fn, rt.files, fl);
  const cf = frontOut(cl, cr); const ff = frontOut(fl, fr);
  const cp = cidPrefix(ids); const ci: string[] = []; for (const c of ids) ci.push(c ? c.slice(cp.length) : "");
  const o: Record<string, unknown> = { v: FORMAT, path, off: a.off, tool: tn, model: mn, prog: pn, cmd: cr, cmdp: cf.pre, cmdl: cf.rest, file: fr, filep: ff.pre, filel: ff.rest, cp, t, to, mo, mq, pg, cm: cmd, fi, ms, er, ou, ci };
  if (hints) o["hm"] = hm; // per row: the local hint of each command (-1 none), [] = none in the row
  return { body: JSON.stringify(o), cmds: cg };
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
  pg: number[][]; cm: number[][]; hm: number[][]; fi: number[][];
}
// lite (scanCalls): only what the wait report reads (times, tools, durations, results, call ids, command refs; the command
// texts only when texts); the other members are skipped unparsed. Member by member (cfStep): a big file read in the
// background spans time slices.
interface CFRead { c: Cur; f: CF; lite: boolean; texts: boolean; st: number /* 0 members to read, 1 done, -1 not a calls file */ }
function cfStart(body: string, lite: boolean, texts: boolean): CFRead {
  const f: CF = { v: -1, path: "", off: -1, cp: "", tool: [], model: [], prog: [], cmdl: [], filel: [], ci: [], cmd: [], cmdp: [], file: [], filep: [], t: [], to: [], mo: [], mq: [], ms: [], er: [], ou: [], pg: [], cm: [], hm: [], fi: [] };
  const c = cursor(body); const r: CFRead = { c, f, lite, texts, st: 0 };
  if (!eat(c, 123)) r.st = -1; else if (eat(c, 125)) r.st = 1;
  return r;
}
// members until the clock passes until (one at least)
function cfStep(r: CFRead, until: number): void {
  const c = r.c; const f = r.f; const lite = r.lite; const texts = r.texts;
  while (r.st === 0) {
    const k = sstr(c); if (!c.ok || !eat(c, 58)) { r.st = -1; return; }
    if (lite && (LITE_SKIP.has(k) || (!texts && (k === "cmdp" || k === "cmdl")))) skip(c);
    else if (k === "v") f.v = snum(c); else if (k === "off") f.off = snum(c); else if (k === "path") f.path = sstr(c); else if (k === "cp") f.cp = sstr(c);
    else if (k === "tool") f.tool = sstrs(c); else if (k === "model") f.model = sstrs(c); else if (k === "prog") f.prog = sstrs(c);
    else if (k === "cmdl") f.cmdl = sstrs(c); else if (k === "filel") f.filel = sstrs(c); else if (k === "ci") f.ci = sstrs(c);
    else if (k === "cmd") f.cmd = snums(c); else if (k === "cmdp") f.cmdp = snums(c); else if (k === "file") f.file = snums(c); else if (k === "filep") f.filep = snums(c);
    else if (k === "t") f.t = snums(c); else if (k === "to") f.to = snums(c); else if (k === "mo") f.mo = snums(c); else if (k === "mq") f.mq = snums(c);
    else if (k === "ms") f.ms = snums(c); else if (k === "er") f.er = snums(c); else if (k === "ou") f.ou = snums(c);
    else if (k === "pg") f.pg = numLists(c); else if (k === "cm") f.cm = numLists(c); else if (k === "hm") f.hm = numLists(c); else if (k === "fi") f.fi = numLists(c);
    else skip(c);
    if (!c.ok) { r.st = -1; return; }
    if (eat(c, 44)) { if (Date.now() >= until) return; continue; }
    r.st = eat(c, 125) ? 1 : -1;
  }
}
function readCF(body: string, lite: boolean, texts: boolean): CF | null { const r = cfStart(body, lite, texts); cfStep(r, Infinity); return r.st === 1 ? r.f : null; }
// null = missing, corrupt, written for another path or another ledger offset, or referring to texts this ledger state lacks:
// the caller re-indexes the session. a = the session's ledger entry the file must be consistent with (off, day counters).
// a file of a format this build reads, for this path at this offset, with its hints aligned to its commands
function fits(o: CF, path: string, a: Acc): boolean {
  if ((o.v !== FORMAT && o.v !== 2) || o.path !== path || o.off !== a.off) return false;
  if (o.v === 2) for (const t of o.tool) if (YIELDING.indexOf(t) >= 0) return false;
  if (o.hm.length === 0) return true;
  if (o.hm.length !== o.cm.length) return false;
  for (let i = 0; i < o.hm.length; i++) { const h = o.hm[i] ?? []; if (h.length && h.length !== (o.cm[i] ?? []).length) return false; }
  return true;
}
// a format-2 file with a text that may have been cut (see FORMAT)
function cutIn(v: number, texts: string[]): boolean { if (v !== 2) return false; for (const x of texts) if (x.length >= CUT && CMDS.mayHide(x)) return true; return false; }
export function decodeCalls(body: string, path: string, a: Acc): Rows | null {
  const o = readCF(body, false, false);
  if (!o || !fits(o, path, a)) return null;
  const tg = globalIds(DICT.tool, o.tool); const mg = globalIds(DICT.model, o.model); const pg = globalIds(DICT.prog, o.prog);
  const rt = refTables(a);
  const cg = refIds(DICT.cmd, o.cmd, o.cmdp, o.cmdl, rt.cmds); if (!cg) return null;
  if (o.v === 2) { const ts: string[] = []; for (const id of cg) ts.push(String(nameOf(DICT.cmd, id))); if (cutIn(o.v, ts)) return null; }
  const fg = refIds(DICT.file, o.file, o.filep, o.filel, rt.files); if (!fg) return null;
  const t = o.t; const n = t.length;
  const to = o.to; const mo = o.mo; const mq = o.mq; const ms = o.ms; const er = o.er; const ou = o.ou; const ci = o.ci; const cp = o.cp;
  const pl = o.pg; const cl = o.cm; const hl = o.hm; const fl = o.fi;
  for (const col of [to, mo, mq, ms, er, ou]) if (col.length !== n) return null;
  if (ci.length !== n || pl.length !== n || cl.length !== n || fl.length !== n) return null;
  // straight into the columns: no per-row object
  let nl = 0; for (let i = 0; i < n; i++) nl += (pl[i] ?? []).length + (cl[i] ?? []).length + (hl[i] ?? []).length + (fl[i] ?? []).length;
  const out = sized(n, nl); let tt = 0; let k = 0;
  const ids = (g: number[], xs: number[], kind: number): void => { for (const x of xs) { const v = at(g, x); if (v >= 0) { out.li[k] = v * 4 + kind; k++; } } };
  for (let i = 0; i < n; i++) {
    tt += at(t, i); const id = ci[i] ?? "";
    out.t[i] = tt; out.tool[i] = at(tg, at(to, i)); out.model[i] = at(mg, at(mo, i)); out.mq[i] = at(mq, i);
    out.ms[i] = at(ms, i); out.err[i] = at(er, i); out.out[i] = at(ou, i); out.cid.push(id ? cp + id : ""); out.lo[i] = k;
    ids(pg, pl[i] ?? [], KIND_PROG);
    const cs = cl[i] ?? []; const hs = hl[i] ?? [];
    for (let j = 0; j < cs.length; j++) { // each command, then its hint
      const v = at(cg, (cs[j] ?? -1) + 0); if (v < 0) continue;
      out.li[k] = v * 4 + KIND_CMD; k++;
      const h = hs.length ? at(cg, (hs[j] ?? -1) + 0) : -1; if (h >= 0) { out.li[k] = h * 4 + KIND_HINT; k++; }
    }
    ids(fg, fl[i] ?? [], KIND_FILE);
  }
  out.n = n; out.nl = k;
  return out;
}

// A calls file read for one pass, nothing kept (agent-wait: a period's report reads thousands of files once): rows as plain
// columns with local ids (cm: indexes into the file's command list, ncmd long; an index out of range names nothing, as in
// decodeCalls; hm: each command's hint, [] = none in the row), no interning into DICT and no Rows; cmds = the command
// texts, only when asked (resolving references decodes the session's day counters), else empty. Valid exactly when
// decodeCalls is (null: read it through callsOf), except that without texts a format-2 file is not checked for cut lines.
export interface CallScan { n: number; t: number[]; to: number[]; tools: string[]; ms: number[]; er: number[]; cp: string; ci: string[]; cm: number[][]; hm: number[][]; ncmd: number; cmds: string[] }
export function scanCalls(body: string, path: string, a: Acc, texts: boolean): CallScan | null { const j = scanOf(body, path, a, texts); scanStep(j, Infinity); return j.out; }
// the same as a job: scanStep until it is done (j.out: the scan, null = not valid)
export interface ScanJob { path: string; a: Acc; rd: CFRead; done: boolean; out: CallScan | null }
function scanOf(body: string, path: string, a: Acc, texts: boolean): ScanJob { return { path, a, rd: cfStart(body, true, texts), done: false, out: null }; }
export function scanJob(dir: string, path: string, a: Acc, texts: boolean): ScanJob {
  const f = fileOf(dir, path); let size = 0; try { size = statSync(f).size; } catch (e) { const j = scanOf("", path, a, texts); j.done = true; return j; }
  return scanOf(readText(f, 0, size).trim(), path, a, texts);
}
// members until the clock passes until; the texts are resolved in the step after the last member (one day decode each)
export function scanStep(j: ScanJob, until: number): boolean {
  if (j.done) return true;
  const rd = j.rd;
  if (rd.st === 0) { cfStep(rd, until); if (rd.st === 0) return false; }
  j.done = true; j.out = rd.st === 1 ? scanned(rd.f, j.path, j.a, rd.texts) : null;
  return true;
}
function scanned(o: CF, path: string, a: Acc, texts: boolean): CallScan | null {
  if (!fits(o, path, a)) return null;
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
    if (cutIn(o.v, cmds)) return null;
  }
  const t: number[] = []; let tt = 0; for (let i = 0; i < n; i++) { tt += at(o.t, i); t.push(tt); }
  return { n, t, to: o.to, tools: o.tool, ms: o.ms, er: o.er, cp: o.cp, ci: o.ci, cm: o.cm, hm: o.hm.length ? o.hm : [], ncmd: o.cmd.length, cmds };
}
// the local command indexes a scanned row's family comes from: each command, or its hint when it has one
export function scanCmds(sc: CallScan, i: number): number[] {
  const cs: number[] = sc.cm[i] ?? []; const hs: number[] = sc.hm.length ? sc.hm[i] ?? [] : [];
  if (!hs.length) return cs;
  const o: number[] = []; for (let j = 0; j < cs.length; j++) { const h = (hs[j] ?? -1) + 0; o.push(h >= 0 ? h : (cs[j] ?? -1) + 0); }
  return o;
}
// refTables' command half (a day not decoded yet is decoded for this and dropped again)
function cmdRefs(a: Acc): Map<number, string> {
  const m = new Map<number, string>();
  for (const d of a.days.values()) for (const k of peekHeavy(d).cmds.keys()) refInto(m, k);
  return m;
}
export function scanCallsFrom(dir: string, path: string, a: Acc, texts: boolean): CallScan | null { const j = scanJob(dir, path, a, texts); scanStep(j, Infinity); return j.out; }

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
export function saveCallsTo(dir: string, path: string, a: Acc): boolean { return saveCallsX(dir, path, a) !== null; }
// the same; the file's command list (global ids, its local order) or null when it was not written
export function saveCallsX(dir: string, path: string, a: Acc): number[] | null {
  try {
    mkdirSync(dir, { recursive: true });
    const f = fileOf(dir, path); const tmp = f + ".tmp"; const e = encodeCallsX(path, a);
    const fd = openSync(tmp, "w"); writeSync(fd, e.body); closeSync(fd);
    renameSync(tmp, f);
    return e.cmds;
  } catch (e) { return null; }
}
// what others keep beside the calls files (wait/digest.ts: a session's day sums): saved = a calls file was written (its
// session's entry, the file's command list), swept = the sessions that still exist (pathKeys) after a save
export const CALLS = { saved: (path: string, a: Acc, cmds: number[]): void => {}, swept: (live: Set<string>): void => {} };
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
