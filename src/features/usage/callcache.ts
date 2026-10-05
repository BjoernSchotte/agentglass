// agentglass — per-session call-row files (~/.agentglass/cache/calls/<key>.json): columnar, local dictionaries, retention
// SPDX-License-Identifier: Apache-2.0
// A calls file is valid only for the ledger offset it was written at and the path it names: anything else (a crash between
// this write and ledger.json's, a hash collision, an old format) counts as missing and that one session re-indexes.
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";
import { readText, listDir, cacheDir } from "../../util/fs.ts";
import { intSetting } from "../../util/config.ts";
import { type Acc, startOfDay, num, heavy } from "./record.ts";
import { type Call, type Dict, DICT, intern, nameOf } from "./facts.ts";

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
function refTable(a: Acc, cmds: boolean): Map<number, string> {
  const m = new Map<number, string>();
  for (const d of a.days.values()) {
    for (const k of (cmds ? heavy(d).cmds : heavy(d).files).keys()) {
      const x = k.slice(k.indexOf("\t") + 1); const h = textHash(x); const o = m.get(h);
      if (o === undefined) m.set(h, x); else if (o !== x) m.set(h, AMBIG);
    }
  }
  return m;
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
  let prev = 0;
  for (const c of a.calls) {
    t.push(c.t - prev); prev = c.t; // deltas: a few digits instead of 13
    to.push(localId(DICT.tool, tm, tn, c.tool)); mo.push(localId(DICT.model, mm, mn, c.model)); mq.push(c.mq);
    pg.push(localIds(DICT.prog, pm, pn, c.progs)); cmd.push(localIds(DICT.cmd, cm, cn, c.cmds)); fi.push(localIds(DICT.file, fm, fn, c.files));
    ms.push(c.ms); er.push(c.err); ou.push(c.out); ids.push(c.cid);
  }
  const cl: string[] = []; const fl: string[] = [];
  const cr = refsOut(cn, refTable(a, true), cl); const fr = refsOut(fn, refTable(a, false), fl);
  const cf = frontOut(cl, cr); const ff = frontOut(fl, fr);
  const cp = cidPrefix(ids); const ci: string[] = []; for (const c of ids) ci.push(c ? c.slice(cp.length) : "");
  return JSON.stringify({ v: FORMAT, path, off: a.off, tool: tn, model: mn, prog: pn, cmd: cr, cmdp: cf.pre, cmdl: cf.rest, file: fr, filep: ff.pre, filel: ff.rest, cp, t, to, mo, mq, pg, cm: cmd, fi, ms, er, ou, ci });
}

function nums(v: unknown): number[] | null { const o: number[] = []; for (const x of arr(v)) { if (typeof x !== "number") return null; o.push(num(x)); } return o; }
function strs(v: unknown): string[] | null { const o: string[] = []; for (const x of arr(v)) { if (typeof x !== "string") return null; o.push(x as string); } return o; }
// local names → global ids (re-interned into DICT)
function globalIds(d: Dict, v: unknown): number[] | null { const ns = strs(v); if (!ns) return null; const o: number[] = []; for (const n of ns) o.push(intern(d, n)); return o; }
// text references (hashes or literal indexes) → global ids; null when a hash does not resolve in this ledger state
function refIds(d: Dict, refs: unknown, pre: unknown, rest: unknown, tab: Map<number, string>): number[] | null {
  const rs = nums(refs); if (!rs) return null;
  const pl = nums(pre); if (!pl) return null;
  const rl = strs(rest); if (!rl) return null;
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
function col(v: unknown, n: number): number[] | null { const c = nums(v); if (!c || c.length !== n) return null; return c; }
function remap(m: number[], xs: number[]): number[] { const o: number[] = []; for (const x of xs) { const g = at(m, x); if (g >= 0) o.push(g); } return o; }
function lists(v: unknown, n: number): number[][] | null {
  const o: number[][] = []; const xs = arr(v); if (xs.length !== n) return null;
  for (const x of xs) { const l = nums(x); if (!l) return null; o.push(l); }
  return o;
}
// null = missing, corrupt, written for another path or another ledger offset, or referring to texts this ledger state lacks:
// the caller re-indexes the session. a = the session's ledger entry the file must be consistent with (off, day counters).
export function decodeCalls(body: string, path: string, a: Acc): Call[] | null {
  const o: Obj | null = parse(body);
  if (!o || o["v"] !== FORMAT || str(o["path"]) !== path || o["off"] !== a.off) return null;
  // one check per column: scriptc narrows a nullable only through its own test
  const tg = globalIds(DICT.tool, o["tool"]); if (!tg) return null;
  const mg = globalIds(DICT.model, o["model"]); if (!mg) return null;
  const pg = globalIds(DICT.prog, o["prog"]); if (!pg) return null;
  const cg = refIds(DICT.cmd, o["cmd"], o["cmdp"], o["cmdl"], refTable(a, true)); if (!cg) return null;
  const fg = refIds(DICT.file, o["file"], o["filep"], o["filel"], refTable(a, false)); if (!fg) return null;
  const t = nums(o["t"]); if (!t) return null;
  const n = t.length;
  const to = col(o["to"], n); if (!to) return null;
  const mo = col(o["mo"], n); if (!mo) return null;
  const mq = col(o["mq"], n); if (!mq) return null;
  const ms = col(o["ms"], n); if (!ms) return null;
  const er = col(o["er"], n); if (!er) return null;
  const ou = col(o["ou"], n); if (!ou) return null;
  const ci = strs(o["ci"]); if (!ci || ci.length !== n) return null;
  const cp = str(o["cp"]);
  const pl = lists(o["pg"], n); if (!pl) return null;
  const cl = lists(o["cm"], n); if (!cl) return null;
  const fl = lists(o["fi"], n); if (!fl) return null;
  const out: Call[] = []; let tt = 0;
  for (let i = 0; i < n; i++) {
    tt += at(t, i); const id = ci[i] ?? "";
    out.push({ t: tt, tool: at(tg, at(to, i)), model: at(mg, at(mo, i)), mq: at(mq, i), progs: remap(pg, pl[i] ?? []), cmds: remap(cg, cl[i] ?? []), files: remap(fg, fl[i] ?? []),
      ms: at(ms, i), err: at(er, i), out: at(ou, i), cid: id ? cp + id : "" });
  }
  return out;
}

// drop rows older than cutoff (rows are in call order, but a restored session may interleave: filter, not slice)
export function prune(a: Acc, cutoff: number): boolean {
  let keep = 0; for (const c of a.calls) if (c.t >= cutoff) keep++;
  if (keep === a.calls.length) return false;
  const newest = a.lastCall >= 0 && a.lastCall < a.calls.length ? a.calls[a.lastCall] : null;
  a.calls = a.calls.filter((c: Call) => c.t >= cutoff);
  a.lastCall = newest && newest.t >= cutoff ? a.calls.indexOf(newest) : -1;
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
export function loadCallsFrom(dir: string, path: string, a: Acc): Call[] | null {
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
