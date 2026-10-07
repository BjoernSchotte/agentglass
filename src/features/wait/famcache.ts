// agentglass — agent-wait: the families of a calls file's commands, kept across runs (cache/wait-families.json)
// SPDX-License-Identifier: Apache-2.0
// A calls file's command list is fixed for the ledger offset it was written at (callcache.ts), so its families — one id
// per command, in the file's order — stay right while the file does (same session, same off) and the family rules do
// (this build, config.json "wait"). The report reads such a file without its command texts: no day counters decoded,
// nothing normalised. A file that changed is worked out again on its next read. Nothing here is a source of truth: a
// missing, unreadable or foreign file only costs that work once.
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cursor, eat, skip, num as snum, str as sstr, nums as snums, strs as sstrs, numLists } from "../../util/jsonscan.ts";
import { readText } from "../../util/fs.ts";
import { rawSection } from "../../util/config.ts";
import { BUILD } from "../../build-info.ts";
import { CACHE_DIR, pathKey } from "../usage/callcache.ts";
import { tmpOf } from "../usage/cachefile.ts";
import { famIdFor, famName, famKind, famHeavy, famGeneric } from "./family.ts";

const V = 1;
// per session (pathKey): the calls file's off and the family id of each of its commands (-1: none)
interface Ent { off: number; f: number[] }
const FC = { dir: CACHE_DIR, loaded: false, key: "", m: new Map<string, Ent>(), dirty: false };
export function famCacheFile(): string { return join(FC.dir, "wait-families.json"); }
// checks: another cache dir, nothing loaded
export function setFamCacheDirForTest(dir: string): void { FC.dir = dir; FC.loaded = false; FC.m = new Map<string, Ent>(); FC.dirty = false; }
// the rules the stored families were worked out under: a new build (built-in rules) or another "wait" config drops them
function rulesKey(): string { return BUILD.version + "|" + BUILD.date + "|" + JSON.stringify(rawSection("wait") ?? null); }

function load(): void {
  FC.loaded = true; FC.key = rulesKey(); FC.m = new Map<string, Ent>(); FC.dirty = false;
  const f = famCacheFile(); let size = 0;
  try { size = statSync(f).size; } catch (e) { return; }
  const c = cursor(readText(f, 0, size));
  let v = -1; let key = ""; let fn: string[] = []; let fk: string[] = []; let fh: number[] = []; let fg: number[] = []; let sp: string[] = []; let so: number[] = []; let sf: number[][] = [];
  if (!eat(c, 123)) return;
  if (!eat(c, 125)) for (;;) {
    const k = sstr(c); if (!c.ok || !eat(c, 58)) return;
    if (k === "v") v = snum(c); else if (k === "key") key = sstr(c);
    else if (k === "fn") fn = sstrs(c); else if (k === "fk") fk = sstrs(c); else if (k === "fh") fh = snums(c); else if (k === "fg") fg = snums(c);
    else if (k === "sp") sp = sstrs(c); else if (k === "so") so = snums(c); else if (k === "sf") sf = numLists(c);
    else skip(c);
    if (!c.ok) return;
    if (eat(c, 44)) continue;
    if (eat(c, 125)) break;
    return;
  }
  if (v !== V || key !== FC.key || fk.length !== fn.length || fh.length !== fn.length || fg.length !== fn.length || so.length !== sp.length || sf.length !== sp.length) return;
  const ids: number[] = []; for (let i = 0; i < fn.length; i++) ids.push(famIdFor(fn[i] ?? "", fk[i] ?? "other", fh[i] === 1, fg[i] === 1));
  for (let i = 0; i < sp.length; i++) {
    const f0 = sf[i] ?? []; const f1: number[] = [];
    for (const x of f0) f1.push(x >= 0 && x < ids.length ? (ids[x + 0] ?? -1) + 0 : -1);
    FC.m.set(sp[i] ?? "", { off: (so[i] ?? -1) + 0, f: f1 });
  }
}
function ready(): void { if (!FC.loaded || FC.key !== rulesKey()) load(); }
// the stored families of path's calls file at off (one per command of the file, in its order), or null
export function famsOf(path: string, off: number): number[] | null {
  ready();
  const e = FC.m.get(pathKey(path)); return e && e.off === off ? e.f : null;
}
export function putFams(path: string, off: number, f: number[]): void { ready(); FC.m.set(pathKey(path), { off, f }); FC.dirty = true; }
// written when something new was stored; only the sessions live() names (their pathKeys). Atomic, as calls files.
export function saveFams(live: () => Set<string>): void {
  if (!FC.loaded || !FC.dirty) return;
  FC.dirty = false; const keep = live();
  const local = new Map<number, number>(); const fn: string[] = []; const fk: string[] = []; const fh: number[] = []; const fg: number[] = [];
  const sp: string[] = []; const so: number[] = []; const sf: number[][] = [];
  for (const [k, e] of FC.m) {
    if (!keep.has(k)) continue;
    const o: number[] = [];
    for (const id of e.f) {
      if (id < 0) { o.push(-1); continue; }
      let x = local.get(id);
      if (x === undefined) { x = fn.length; local.set(id, x); fn.push(famName(id)); fk.push(famKind(id)); fh.push(famHeavy(id) ? 1 : 0); fg.push(famGeneric(id) ? 1 : 0); }
      o.push(x);
    }
    sp.push(k); so.push(e.off); sf.push(o);
  }
  try {
    mkdirSync(FC.dir, { recursive: true });
    const f = famCacheFile(); const tmp = tmpOf(f); // a writer of its own (two agentglass runs may save at once)
    const fd = openSync(tmp, "w"); writeSync(fd, JSON.stringify({ v: V, key: FC.key, fn, fk, fh, fg, sp, so, sf })); closeSync(fd);
    renameSync(tmp, f);
  } catch (e) { /* a cache: the next run works them out again */ }
}
