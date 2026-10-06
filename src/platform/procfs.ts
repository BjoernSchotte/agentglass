// agentglass — Linux process table from /proc, read incrementally (no ps child) by procscan.ts: new, young and tracked
// pids every pass, every pid on a full pass. Pure parsers plus a source with an injectable root (checks use fixture trees).
// SPDX-License-Identifier: Apache-2.0
import { openSync, readSync, closeSync } from "node:fs";
import { readBytes, readText, listDir } from "../util/fs.ts";
import { own } from "../util/own.ts";
import type { ProcRow } from "./types.ts";
import { type PStat, type ProcSource, scanSource, knownSource, etimeText } from "./procscan.ts";

export { etimeText };

export interface Stat { pid: number; comm: string; state: string; ppid: number; ttyNr: number; ticks: number; start: number; rssPages: number }
// /proc/<pid>/stat: "pid (comm) state ppid …"; comm may hold spaces and parens, so it ends at the LAST ")"
export function parseStat(line: string): Stat | null {
  const a = line.indexOf("("); const z = line.lastIndexOf(")");
  if (a < 0 || z < a) return null;
  const f = line.slice(z + 2).split(" "); // f[0] = field 3 (state)
  if (f.length < 22) return null;
  const pid = Number(line.slice(0, a).trim());
  const ticks = Number(f[11]) + Number(f[12]); // fields 14 utime + 15 stime
  const n = [pid, Number(f[1]), Number(f[4]), ticks, Number(f[19]), Number(f[21])];
  for (let i = 0; i < n.length; i++) if (Number.isNaN(n[i] + 0)) return null;
  return { pid, comm: line.slice(a + 1, z), state: f[0] ?? "", ppid: Number(f[1]), ttyNr: Number(f[4]), ticks, start: Number(f[19]), rssPages: Number(f[21]) };
}
// tty_nr → the name ps prints: pts/N (Unix98 majors 136–143), ttyN / ttySN (major 4), else "?"
export function ttyName(nr: number): string {
  const major = (nr >> 8) & 0xfff; const minor = (nr & 0xff) | ((nr >> 12) & 0xfff00);
  if (major >= 136 && major <= 143) return "pts/" + String(minor + (major - 136) * 256);
  if (major === 4) return minor < 64 ? "tty" + String(minor) : "ttyS" + String(minor - 64);
  return "?";
}
// cmdline (NUL-separated argv) as ps args shows it: trailing NULs cut, NULs and control characters (newlines in
// `sh -c` scripts) as spaces; empty (kernel thread, zombie) → [comm]
export function cmdlineText(raw: Uint8Array, comm: string): string {
  let z = raw.length; while (z > 0 && raw[z - 1] === 0) z--;
  if (!z) return "[" + comm + "]";
  const b = raw.slice(0, z);
  for (let i = 0; i < b.length; i++) if (b[i] < 32 || b[i] === 127) b[i] = 32;
  return new TextDecoder("utf-8").decode(b);
}
// hz = CLK_TCK, page = page size in bytes, btime = boot time in s (/proc/stat)
export interface ProcFs { root: string; hz: number; page: number; btime: number }
export function btimeOf(root: string): number {
  const t = readText(root + "/stat", 0, 65536); const i = t.indexOf("\nbtime ");
  return i < 0 ? 0 : Number(t.slice(i + 7, t.indexOf("\n", i + 1))) || 0;
}
export const PROCFS_STATS = { stat: 0, cmdline: 0, comm: 0 }; // reads, for checks
// boot time in ms: now − /proc/uptime as ps computes elapsed time (btime is whole seconds: etime would run up to 1 s
// ahead of ps); btime where there is no uptime file
function bootMs(fs: ProcFs, now: number): number {
  const up = Number(readText(fs.root + "/uptime", 0, 64).split(" ")[0] ?? "");
  return up > 0 ? now - up * 1000 : fs.btime * 1000;
}

// one buffer for every stat read (hundreds a pass)
const SB = new Uint8Array(1024);
// a process's name from /proc/<pid>/comm: the cheapest read there is ("" = gone)
function readComm(fs: ProcFs, pid: number): string {
  PROCFS_STATS.comm++;
  let n = 0;
  try { const fd = openSync(fs.root + "/" + String(pid) + "/comm", "r"); try { n = readSync(fd, SB, 0, 64, 0); } finally { closeSync(fd); } } catch (e) { return ""; }
  while (n > 0 && (SB[n - 1] === 10 || SB[n - 1] === 0)) n--;
  return new TextDecoder("utf-8").decode(SB.subarray(0, n));
}
function readStat(fs: ProcFs, pid: number): Stat | null {
  PROCFS_STATS.stat++;
  let n = 0;
  try { const fd = openSync(fs.root + "/" + String(pid) + "/stat", "r"); try { n = readSync(fd, SB, 0, SB.length, 0); } finally { closeSync(fd); } } catch (e) { return null; }
  const s = parseStat(new TextDecoder("utf-8").decode(SB.subarray(0, n)));
  return s && s.pid === pid ? s : null;
}
// resident pages from statm: what ps shows (VmRSS); stat's rss field can be far off on current kernels
function readRss(fs: ProcFs, pid: number, fallback: number): number {
  const t = readText(fs.root + "/" + String(pid) + "/statm", 0, 128); const i = t.indexOf(" ");
  const n = i > 0 ? Number(t.slice(i + 1, t.indexOf(" ", i + 1))) : NaN;
  return (Number.isNaN(n) ? fallback : n) * fs.page;
}
// 4 KB first (nearly every command line fits; a 128 KB buffer per young pid and pass was garbage the size of megabytes)
function readArgs(fs: ProcFs, pid: number, comm: string, zombie: boolean): string {
  PROCFS_STATS.cmdline++;
  const f = fs.root + "/" + String(pid) + "/cmdline";
  let raw = readBytes(f, 0, 4096); if (raw.length === 4096) raw = readBytes(f, 0, 131072);
  const a = cmdlineText(raw, comm);
  return own(zombie ? a + " <defunct>" : a);
}
// a /proc entry's pid, -1 for the rest (self, sys, …); by hand: ~2,500 entries a pass, Number() is slower
function pidOf(name: string): number {
  let n = 0;
  for (let i = 0; i < name.length; i++) { const c = name.charCodeAt(i); if (c < 48 || c > 57) return -1; n = n * 10 + c - 48; }
  return name.length ? n : -1;
}
// /proc as a process source (procscan.ts): cpu time and start from clock ticks, the tty from tty_nr, rss from stat's
// pages (cheap) or statm (precise: what ps shows); one per ProcFs object, its state kept per root
const SRC = { fs: null as ProcFs | null, src: null as ProcSource | null };
export function procfsSource(fs: ProcFs): ProcSource {
  const hit = SRC.src; if (SRC.fs === fs && hit) return hit;
  const src: ProcSource = {
    id: "procfs:" + fs.root,
    pids: (): number[] => { const o: number[] = []; for (const n of listDir(fs.root)) { const p = pidOf(n); if (p >= 0) o.push(p); } return o; },
    comm: (pid: number): string => readComm(fs, pid),
    stat: (pid: number): PStat | null => {
      const s = readStat(fs, pid); if (!s) return null;
      return { pid, comm: s.comm, zombie: s.state === "Z", ppid: s.ppid, tty: ttyName(s.ttyNr), cpuMs: s.ticks * 1000 / fs.hz, startMs: s.start / fs.hz * 1000, rss: s.rssPages * fs.page };
    },
    rss: (pid: number, st: PStat): number => readRss(fs, pid, st.rss / fs.page),
    args: (pid: number, st: PStat): string => readArgs(fs, pid, st.comm, st.zombie),
    bootMs: (now: number): number => bootMs(fs, now),
  };
  SRC.fs = fs; SRC.src = src;
  return src;
}
// one pass over /proc (procscan.ts scanSource); the array is reused: callers read it before the next pass
export function scanProcs(fs: ProcFs, now: number, tracked: Set<number>, full: boolean, want: (comm: string) => boolean = (c: string): boolean => true): ProcRow[] {
  return scanSource(procfsSource(fs), now, tracked, full, want);
}
// a pass without the /proc listing (procscan.ts knownSource)
export function knownProcs(fs: ProcFs, now: number, tracked: Set<number>): ProcRow[] { return knownSource(procfsSource(fs), now, tracked); }
// /proc is usable: a numbered entry and a boot time (else the caller falls back to ps)
export function procfsUsable(fs: ProcFs): boolean {
  if (fs.btime <= 0 || fs.hz <= 0 || fs.page <= 0) return false;
  for (const n of listDir(fs.root)) if (pidOf(n) >= 0) return true;
  return false;
}
