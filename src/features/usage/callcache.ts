// agentglass — per-session call-row files (~/.agentglass/cache/calls/<key>.json): columnar, local dictionaries, retention
// SPDX-License-Identifier: Apache-2.0
// A calls file is valid only for the ledger offset it was written at and the path it names: anything else (a crash between
// this write and ledger.json's, a hash collision, an old format) counts as missing and that one session re-indexes.
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";
import { HOME, readText, listDir } from "../../util/fs.ts";
import { intSetting } from "../../util/config.ts";
import { type Acc, startOfDay, num } from "./record.ts";
import { type Call, type Dict, DICT, intern, nameOf } from "./facts.ts";

// AGENTGLASS_CACHE_DIR: a separate ledger cache (test builds of other branches must not rewrite the real one)
export const CACHE_DIR = process.env.AGENTGLASS_CACHE_DIR || join(HOME, ".agentglass", "cache");
export const CALLS_DIR = join(CACHE_DIR, "calls");
const FORMAT = 1;

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
export function encodeCalls(path: string, a: Acc): string {
  const tn: string[] = []; const mn: string[] = []; const pn: string[] = []; const cn: string[] = []; const fn: string[] = [];
  const tm = new Map<number, number>(); const mm = new Map<number, number>(); const pm = new Map<number, number>(); const cm = new Map<number, number>(); const fm = new Map<number, number>();
  const t: number[] = []; const to: number[] = []; const mo: number[] = []; const mq: number[] = []; const pg: number[][] = []; const cmd: number[][] = []; const fi: number[][] = [];
  const ms: number[] = []; const er: number[] = []; const ou: number[] = []; const ci: string[] = [];
  for (const c of a.calls) {
    t.push(c.t); to.push(localId(DICT.tool, tm, tn, c.tool)); mo.push(localId(DICT.model, mm, mn, c.model)); mq.push(c.mq);
    pg.push(localIds(DICT.prog, pm, pn, c.progs)); cmd.push(localIds(DICT.cmd, cm, cn, c.cmds)); fi.push(localIds(DICT.file, fm, fn, c.files));
    ms.push(c.ms); er.push(c.err); ou.push(c.out); ci.push(c.cid);
  }
  return JSON.stringify({ v: FORMAT, path, off: a.off, tool: tn, model: mn, prog: pn, cmd: cn, file: fn, t, to, mo, mq, pg, cm: cmd, fi, ms, er, ou, ci });
}

function nums(v: unknown): number[] | null { const o: number[] = []; for (const x of arr(v)) { if (typeof x !== "number") return null; o.push(num(x)); } return o; }
function strs(v: unknown): string[] | null { const o: string[] = []; for (const x of arr(v)) { if (typeof x !== "string") return null; o.push(x as string); } return o; }
// local names → global ids (re-interned into DICT)
function globalIds(d: Dict, v: unknown): number[] | null { const ns = strs(v); if (!ns) return null; const o: number[] = []; for (const n of ns) o.push(intern(d, n)); return o; }
// + 0: scriptc cannot index with a bare element read that came out of this same function (SC1090)
function at(m: number[], i: number): number { if (i < 0 || i >= m.length) return -1; return m[i] + 0; }
function col(v: unknown, n: number): number[] | null { const c = nums(v); if (!c || c.length !== n) return null; return c; }
function remap(m: number[], xs: number[]): number[] { const o: number[] = []; for (const x of xs) { const g = at(m, x); if (g >= 0) o.push(g); } return o; }
function lists(v: unknown, n: number): number[][] | null {
  const o: number[][] = []; const xs = arr(v); if (xs.length !== n) return null;
  for (const x of xs) { const l = nums(x); if (!l) return null; o.push(l); }
  return o;
}
// null = missing, corrupt, written for another path or another ledger offset: the caller re-indexes the session
export function decodeCalls(body: string, path: string, off: number): Call[] | null {
  const o: Obj | null = parse(body);
  if (!o || o["v"] !== FORMAT || str(o["path"]) !== path || o["off"] !== off) return null;
  // one check per column: scriptc narrows a nullable only through its own test
  const tg = globalIds(DICT.tool, o["tool"]); if (!tg) return null;
  const mg = globalIds(DICT.model, o["model"]); if (!mg) return null;
  const pg = globalIds(DICT.prog, o["prog"]); if (!pg) return null;
  const cg = globalIds(DICT.cmd, o["cmd"]); if (!cg) return null;
  const fg = globalIds(DICT.file, o["file"]); if (!fg) return null;
  const t = nums(o["t"]); if (!t) return null;
  const n = t.length;
  const to = col(o["to"], n); if (!to) return null;
  const mo = col(o["mo"], n); if (!mo) return null;
  const mq = col(o["mq"], n); if (!mq) return null;
  const ms = col(o["ms"], n); if (!ms) return null;
  const er = col(o["er"], n); if (!er) return null;
  const ou = col(o["ou"], n); if (!ou) return null;
  const ci = strs(o["ci"]); if (!ci || ci.length !== n) return null;
  const pl = lists(o["pg"], n); if (!pl) return null;
  const cl = lists(o["cm"], n); if (!cl) return null;
  const fl = lists(o["fi"], n); if (!fl) return null;
  const out: Call[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ t: at(t, i), tool: at(tg, at(to, i)), model: at(mg, at(mo, i)), mq: at(mq, i), progs: remap(pg, pl[i] ?? []), cmds: remap(cg, cl[i] ?? []), files: remap(fg, fl[i] ?? []),
      ms: at(ms, i), err: at(er, i), out: at(ou, i), cid: ci[i] ?? "" });
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
export function loadCallsFrom(dir: string, path: string, off: number): Call[] | null {
  const f = fileOf(dir, path);
  let size = 0; try { size = statSync(f).size; } catch (e) { return null; }
  return decodeCalls(readText(f, 0, size).trim(), path, off);
}
// remove calls files of sessions that no longer exist (and leftovers of an interrupted write)
export function sweepCalls(dir: string, live: Set<string>): void {
  for (const n of listDir(dir)) {
    if (n.endsWith(".json") && live.has(n.slice(0, -5))) continue;
    try { unlinkSync(join(dir, n)); } catch (e) { /* gone already */ }
  }
}
