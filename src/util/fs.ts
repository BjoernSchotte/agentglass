// agentglass — file reading, directory listing and subprocess helpers
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const CLAUDE = join(HOME, ".claude");
export const CODEX = join(HOME, ".codex");
export const FX = join(HOME, ".fx");
// the cache dir (ledger, call rows, projects, price lists): AGENTGLASS_CACHE_DIR keeps test and branch builds off the
// real one; read per call, the env may change after import (checks)
export function cacheDir(): string { const e = process.env["AGENTGLASS_CACHE_DIR"]; return e !== undefined && e ? e : join(HOME, ".agentglass", "cache"); }

export function readBytes(path: string, start: number, len: number): Uint8Array {
  const b = new Uint8Array(len);
  let n = 0;
  try { const fd = openSync(path, "r"); n = readSync(fd, b, 0, len, start); closeSync(fd); } catch (e) { n = 0; }
  return b.subarray(0, n);
}
// a whole small file, telling "missing" apart from "there but unreadable" (a directory, no permission, over max bytes):
// writers that merge into a file must never take an unreadable file for an empty one
export function readWhole(path: string, max: number): { text: string; missing: boolean; err: string } {
  if (!existsSync(path)) return { text: "", missing: true, err: "" };
  try {
    const st = statSync(path);
    if (!st.isFile()) return { text: "", missing: false, err: "not a regular file" };
    const big = { text: "", missing: false, err: "larger than " + String(Math.floor(max / 1024)) + " KiB" };
    if (st.size > max) return big;
    const b = new Uint8Array(max + 1); // max + 1: a file that grew past max since the stat is refused, not cut short
    const fd = openSync(path, "r"); let n = 0;
    try { let r = 1; while (n < b.length && r > 0) { r = readSync(fd, b, n, b.length - n, n); n += r; } } finally { closeSync(fd); }
    if (n > max) return big;
    return { text: new TextDecoder("utf-8").decode(b.subarray(0, n)), missing: false, err: "" };
  } catch (e) { return { text: "", missing: false, err: e instanceof Error ? e.message : String(e) }; }
}
export function readText(path: string, start: number, len: number): string {
  const b = readBytes(path, start, len);
  return new TextDecoder("utf-8").decode(b);
}
// Complete lines in [start,end). align: skip the partial first line. Returns next unread offset.
export function readLines(path: string, start: number, end: number, align: boolean): { lines: string[]; next: number } {
  const b = readBytes(path, start, end - start);
  let a = 0;
  if (align) { while (a < b.length && b[a] !== 10) a++; a++; }
  let z = b.length - 1;
  while (z >= a && b[z] !== 10) z--;
  if (z < a) return { lines: [], next: align ? start : start };
  const text = new TextDecoder("utf-8").decode(b.subarray(a, z + 1));
  return { lines: text.split("\n"), next: start + z + 1 };
}
export function listDir(p: string): string[] { try { return readdirSync(p); } catch (e) { return []; } }
// listDir for the session scans: the last listing is reused while the directory's mtime stands and is over 2 s old (a
// change within the same coarse mtime tick must not be missed), and at least once a minute it is listed anyway
// (filesystems whose directory mtime does not move). A missing directory lists as [] and is forgotten. The array is
// shared: callers must not change it.
export const FS_CLOCK = { now: (): number => Date.now() };
export const FS_STATS = { lists: 0 }; // real listings (checks)
const DIRS = new Map<string, { mt: number; at: number; names: string[] }>();
const FRESH_MS = 2000; const RELIST_MS = 60000;
export function listDirCached(p: string): string[] {
  let mt = 0;
  try { mt = statSync(p).mtimeMs; } catch (e) { DIRS.delete(p); return []; }
  const now = FS_CLOCK.now(); const e = DIRS.get(p);
  if (e && e.mt === mt && now - mt >= FRESH_MS && now - e.at < RELIST_MS) return e.names;
  FS_STATS.lists++;
  const names = listDir(p);
  DIRS.set(p, { mt, at: now, names });
  return names;
}
export function run(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }); } catch (e) { return ""; }
}
