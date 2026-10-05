// agentglass — Linux process table from /proc, read incrementally (no ps child): new, young and tracked pids every
// pass, every pid on a full pass. Pure parsers plus a reader with an injectable root (checks use fixture trees).
// SPDX-License-Identifier: Apache-2.0
import { readBytes, readText, listDir } from "../util/fs.ts";
import { own } from "../util/own.ts";
import type { ProcRow } from "./types.ts";

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
// ps etime: [[dd-]hh:]mm:ss
function two(n: number): string { return (n < 10 ? "0" : "") + String(n); }
export function etimeText(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const d = Math.floor(t / 86400); const h = Math.floor(t / 3600) % 24;
  return (d ? String(d) + "-" : "") + (d || h ? two(h) + ":" : "") + two(Math.floor(t / 60) % 60) + ":" + two(t % 60);
}

// hz = CLK_TCK, page = page size in bytes, btime = boot time in s (/proc/stat)
export interface ProcFs { root: string; hz: number; page: number; btime: number }
export function btimeOf(root: string): number {
  const t = readText(root + "/stat", 0, 65536); const i = t.indexOf("\nbtime ");
  return i < 0 ? 0 : Number(t.slice(i + 7, t.indexOf("\n", i + 1))) || 0;
}
// a pid younger than this re-reads its cmdline every pass: exec chains (sh -c → node → agent) settle within it
export const YOUNG_MS = 10000;
export const PROCFS_STATS = { stat: 0, cmdline: 0 }; // reads, for checks
// per pid: the row handed out (kept across passes) and the last stat sample for the CPU delta
interface Ent { row: ProcRow; start: number; startMs: number; tty: number; t: number; at: number; seen: number }
const PF = { root: "", pass: 0, bootMs: 0, ents: new Map<number, Ent>() };
// boot time in ms: now − /proc/uptime as ps computes elapsed time (btime is whole seconds: etime would run up to 1 s
// ahead of ps); btime where there is no uptime file
function bootMs(fs: ProcFs, now: number): number {
  const up = Number(readText(fs.root + "/uptime", 0, 64).split(" ")[0] ?? "");
  return up > 0 ? now - up * 1000 : fs.btime * 1000;
}

function readStat(fs: ProcFs, pid: number): Stat | null {
  PROCFS_STATS.stat++;
  const s = parseStat(readText(fs.root + "/" + String(pid) + "/stat", 0, 1024));
  return s && s.pid === pid ? s : null;
}
// resident pages from statm: what ps shows (VmRSS); stat's rss field can be far off on current kernels
function readRss(fs: ProcFs, pid: number, fallback: number): number {
  const t = readText(fs.root + "/" + String(pid) + "/statm", 0, 128); const i = t.indexOf(" ");
  const n = i > 0 ? Number(t.slice(i + 1, t.indexOf(" ", i + 1))) : NaN;
  return (Number.isNaN(n) ? fallback : n) * fs.page;
}
function readArgs(fs: ProcFs, st: Stat): string {
  PROCFS_STATS.cmdline++;
  const a = cmdlineText(readBytes(fs.root + "/" + String(st.pid) + "/cmdline", 0, 131072), st.comm);
  return own(st.state === "Z" ? a + " <defunct>" : a);
}
// a /proc entry's pid, -1 for the rest (self, sys, …); by hand: ~2,500 entries a pass, Number() is slower
function pidOf(name: string): number {
  let n = 0;
  for (let i = 0; i < name.length; i++) { const c = name.charCodeAt(i); if (c < 48 || c > 57) return -1; n = n * 10 + c - 48; }
  return name.length ? n : -1;
}
// one pass: rows of every pid under fs.root. Unchanged pids (not new, young, tracked, nor a full pass) keep their row as
// it was; cpu is the recent % from the tick delta since the last sample (0 on the first one, as ps-free Linux had it)
export function scanProcs(fs: ProcFs, now: number, tracked: Set<number>, full: boolean): ProcRow[] {
  if (PF.root !== fs.root) { PF.root = fs.root; PF.ents.clear(); }
  if (full || !PF.bootMs) PF.bootMs = bootMs(fs, now); // again on full passes: the wall clock may have been stepped
  PF.pass++; const pass = PF.pass; const out: ProcRow[] = [];
  for (const name of listDir(fs.root)) {
    const pid = pidOf(name); if (pid < 0) continue;
    let e = PF.ents.get(pid);
    const young = e !== undefined && now - e.startMs < YOUNG_MS;
    if (!e || full || young || tracked.has(pid)) {
      const st = readStat(fs, pid);
      if (!st) { if (e) PF.ents.delete(pid); continue; } // gone between the listing and the read
      if (e && e.start !== st.start) e = undefined; // pid reused
      const startMs = PF.bootMs + st.start / fs.hz * 1000;
      if (!e) {
        const row: ProcRow = { pid, ppid: st.ppid, cpu: 0, rss: readRss(fs, pid, st.rssPages), etime: own(etimeText((now - startMs) / 1000)), tty: own(ttyName(st.ttyNr)), args: readArgs(fs, st) };
        e = { row, start: st.start, startMs, tty: st.ttyNr, t: st.ticks, at: now, seen: pass };
        PF.ents.set(pid, e);
      } else {
        const r = e.row;
        r.ppid = st.ppid; r.rss = readRss(fs, pid, st.rssPages); r.etime = own(etimeText((now - startMs) / 1000));
        if (st.ttyNr !== e.tty) { e.tty = st.ttyNr; r.tty = own(ttyName(st.ttyNr)); }
        if (full || young) r.args = readArgs(fs, st);
        if (now - e.at >= 500) { r.cpu = Math.max(0, (st.ticks - e.t) / fs.hz / ((now - e.at) / 1000) * 100); e.t = st.ticks; e.at = now; } // a pass right after another: a 10 ms tick over a few ms would read as 1000%+
      }
    }
    e.seen = pass;
    out.push(e.row);
  }
  for (const [pid, e] of PF.ents) if (e.seen !== pass) PF.ents.delete(pid);
  return out;
}
// /proc is usable: a numbered entry and a boot time (else the caller falls back to ps)
export function procfsUsable(fs: ProcFs): boolean {
  if (fs.btime <= 0 || fs.hz <= 0 || fs.page <= 0) return false;
  for (const n of listDir(fs.root)) if (pidOf(n) >= 0) return true;
  return false;
}
