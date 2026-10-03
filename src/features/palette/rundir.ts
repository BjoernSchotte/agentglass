// agentglass — single instance, security primitives: the owner-only run directory (~/.agentglass/run, 0700) and the
// server lock (tui.lock, O_EXCL, holding the pid). Foreign or tampered entries are never followed, chmodded or unlinked.
// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import { openSync, closeSync, writeSync, readSync, fstatSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { HOME } from "../../util/fs.ts";

export interface FInfo { uid: number; mode: number; kind: string }
export type InfoFn = (path: string) => FInfo | null; // lstat semantics (OS.fileInfo; checks pass stubs)
// AGENTGLASS_RUN_DIR: another run directory (test runs must not touch the real one)
export const RUN_DIR = process.env.AGENTGLASS_RUN_DIR || join(HOME, ".agentglass", "run");
export function myUid(): number { return userInfo().uid; }
function octal(m: number): string { return "0" + String((m >> 6) & 7) + String((m >> 3) & 7) + String(m & 7); }
// "" = a real directory, ours, no group/other bits; else why not. create: an absent dir is made 0700 (umask 077 around it)
export function secureDir(dir: string, uid: number, info: InfoFn, create: boolean): string {
  let i = info(dir);
  if (!i && create) {
    const old = process.umask(0o077);
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { /* raced or no parent: re-checked below */ } finally { process.umask(old); }
    i = info(dir);
  }
  if (!i) return dir + " is missing";
  if (i.kind === "link") return dir + " is a symlink";
  if (i.kind !== "dir") return dir + " is not a directory";
  if (i.uid !== uid) return dir + " is owned by uid " + String(i.uid);
  if ((i.mode & 0o077) !== 0) return dir + " has mode " + octal(i.mode) + ", which allows group/other access";
  return "";
}
// a regular file of ours, read without following a symlink and without blocking on a FIFO; null = refused/missing
export function readOwn(path: string, uid: number, info: InfoFn, max: number): Uint8Array | null {
  const i = info(path);
  if (!i || i.kind !== "file" || i.uid !== uid) return null;
  let fd = -1;
  try {
    fd = openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null; // swapped between the check and the open
    const b = new Uint8Array(max); const n = readSync(fd, b, 0, max, 0);
    return b.subarray(0, n);
  } catch (e) { return null; } finally { if (fd >= 0) closeSync(fd); }
}
// a new file of ours with mode 0600: O_EXCL + O_NOFOLLOW, never over anything that exists (a symlink included)
export function createOwn(path: string, data: string): boolean {
  let fd = -1;
  try {
    fd = openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    writeSync(fd, data); return true;
  } catch (e) { return false; } finally { if (fd >= 0) closeSync(fd); }
}
function lockPid(dir: string, uid: number, info: InfoFn): number {
  const b = readOwn(join(dir, "tui.lock"), uid, info, 64);
  if (!b) return -1;
  const t = new TextDecoder().decode(b).trim();
  return /^\d{1,10}$/.test(t) ? Number(t) : 0; // garbage in our own lock = stale
}
// 1 = we hold the lock now, 0 = a live agentglass holds it, -1 = the lock is not a regular file of ours (disable)
// A stale lock (dead pid, or a pid reused by another program) is broken only under tui.lock.break (O_EXCL): two TUIs
// that judged the same stale lock at once could otherwise both unlink it and both serve (seen on CI). A break file
// left by a crash is removed after BREAK_STALE.
const BREAK_STALE = 10000;
function oldBreak(bk: string, now: number): boolean { try { const st = fs.lstatSync(bk); return st.isFile() && !st.isSymbolicLink() && now - st.mtimeMs > BREAK_STALE; } catch (e) { return false; } }
export function takeLock(dir: string, pid: number, uid: number, info: InfoFn, alive: (pid: number) => boolean, isOurs: (pid: number) => boolean): number {
  const p = join(dir, "tui.lock"); const bk = join(dir, "tui.lock.break");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createOwn(p, String(pid) + "\n")) return 1;
    const i = info(p);
    if (!i) continue; // released between the two calls
    if (i.kind !== "file" || i.uid !== uid) return -1;
    const h = lockPid(dir, uid, info);
    if (h < 0) return -1;
    if (h > 0 && h !== pid && alive(h) && isOurs(h)) return 0;
    if (h === pid) return 1;
    if (!createOwn(bk, String(pid) + "\n")) { // another TUI is breaking it: it serves (or a crashed breaker's file ages out)
      if (oldBreak(bk, Date.now())) { try { unlinkSync(bk); } catch (e) { /* gone */ } continue; }
      return 0;
    }
    try { if (lockPid(dir, uid, info) === h) unlinkSync(p); } catch (e) { /* someone else cleaned it */ } finally { try { unlinkSync(bk); } catch (e) { /* gone */ } }
  }
  return 0;
}
export function releaseLock(dir: string, pid: number): void {
  const p = join(dir, "tui.lock");
  if (lockPid(dir, myUid(), (x: string): FInfo | null => infoNative(x)) === pid) { try { unlinkSync(p); } catch (e) { /* gone */ } }
}
// on quit: a fast native check instead of spawning stat (lstat: a symlink is never "ours")
function infoNative(p: string): FInfo | null {
  try { const st = fs.lstatSync(p); return { uid: myUid(), mode: 0o600, kind: st.isSymbolicLink() ? "link" : st.isFile() ? "file" : st.isDirectory() ? "dir" : "other" }; } catch (e) { return null; }
}
// the lock still names this pid (two TUIs that judged the same stale lock at once: the one whose lock was replaced
// learns it here and stops serving)
export function holdsLock(dir: string, pid: number, uid: number, info: InfoFn): boolean { return lockPid(dir, uid, info) === pid; }
// the live server's pid, 0 = none
export function lockHolder(dir: string, uid: number, info: InfoFn, alive: (pid: number) => boolean, isOurs: (pid: number) => boolean): number {
  const h = lockPid(dir, uid, info);
  return h > 0 && alive(h) && isOurs(h) ? h : 0;
}
