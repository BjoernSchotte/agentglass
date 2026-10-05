// agentglass — Linux process table from /proc, read incrementally (no ps child): new, young and tracked pids every
// pass, every pid on a full pass. Pure parsers plus a reader with an injectable root (checks use fixture trees).
// SPDX-License-Identifier: Apache-2.0
import { openSync, readSync, closeSync } from "node:fs";
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
// launchers that exec into what they start (sh -c, env, npx…): only these are re-read while young; an interpreter or a
// binary keeps its command line, its children are new pids
const EXECS = ["sh", "bash", "zsh", "dash", "fish", "env", "npx", "npm", "pnpm", "yarn", "bunx", "uv", "uvx", "sudo", "nohup", "timeout", "script", "exec"];
export const PROCFS_STATS = { stat: 0, cmdline: 0, comm: 0 }; // reads, for checks
// per pid: the row handed out (kept across passes) and the last stat sample for the CPU delta
// comm = the name from the last stat; args = its command line was read (only for processes that may be agents: want)
interface Ent { row: ProcRow; start: number; startMs: number; tty: number; t: number; at: number; seen: number; comm: string; args: boolean; rssAt: number }
// wait: new pids whose name is not an agent's or an interpreter's, seen once (by their name only): read on the next pass
// if still there (most of a busy host's new processes live less than a pass: a shell command, git)
const PF = { root: "", pass: 0, bootMs: 0, ents: new Map<number, Ent>(), out: [] as ProcRow[], wait: new Map<number, number>() };
const RSS_EVERY = 4; // a tracked pid's resident size every 4th pass (~6 s): its cpu needs the stat every pass, not this
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
function readArgs(fs: ProcFs, st: Stat): string {
  PROCFS_STATS.cmdline++;
  const f = fs.root + "/" + String(st.pid) + "/cmdline";
  let raw = readBytes(f, 0, 4096); if (raw.length === 4096) raw = readBytes(f, 0, 131072);
  const a = cmdlineText(raw, st.comm);
  return own(st.state === "Z" ? a + " <defunct>" : a);
}
// a /proc entry's pid, -1 for the rest (self, sys, …); by hand: ~2,500 entries a pass, Number() is slower
function pidOf(name: string): number {
  let n = 0;
  for (let i = 0; i < name.length; i++) { const c = name.charCodeAt(i); if (c < 48 || c > 57) return -1; n = n * 10 + c - 48; }
  return name.length ? n : -1;
}
// one pass: rows of every pid under fs.root. A pid is read when it is new, tracked (a harness tree: cpu, resident size),
// young (< 10 s) while its name is a launcher's (exec chains: EXECS), or on a full pass; a reused pid shows
// in its start time. The command line is read only where want(comm) — an agent's or a launcher's name — or for a tracked
// pid or its new child, and again when the name changed (an exec); other rows have args "". cpu is the recent % from
// the tick delta since the last sample (0 on the first). The array is reused: callers read it before the next pass.
export function scanProcs(fs: ProcFs, now: number, tracked: Set<number>, full: boolean, want: (comm: string) => boolean = (c: string): boolean => true): ProcRow[] {
  if (PF.root !== fs.root) { PF.root = fs.root; PF.ents.clear(); PF.wait.clear(); }
  if (full || !PF.bootMs) PF.bootMs = bootMs(fs, now); // again on full passes: the wall clock may have been stepped
  PF.pass++; const pass = PF.pass; const out = PF.out; out.length = 0;
  for (const name of listDir(fs.root)) {
    const pid = pidOf(name); if (pid < 0) continue;
    let e = PF.ents.get(pid);
    const tr = tracked.has(pid);
    const young = e !== undefined && now - e.startMs < YOUNG_MS && EXECS.indexOf(e.comm) >= 0;
    if (!e && !full && !PF.wait.has(pid)) { // first sight: only its name; an agent or an interpreter is read at once
      const c = readComm(fs, pid);
      if (!c) continue;
      if (!want(c) || EXECS.indexOf(c) >= 0) { PF.wait.set(pid, pass); continue; }
    }
    if (!e || full || young || tr) {
      PF.wait.delete(pid);
      const st = readStat(fs, pid);
      if (!st) { if (e) PF.ents.delete(pid); continue; } // gone between the listing and the read
      if (e && e.start !== st.start) e = undefined; // pid reused
      const startMs = PF.bootMs + st.start / fs.hz * 1000;
      const args = tr || want(st.comm) || tracked.has(st.ppid);
      if (!e) {
        const row: ProcRow = { pid, ppid: st.ppid, cpu: 0, rss: args ? readRss(fs, pid, st.rssPages) : st.rssPages * fs.page, etime: own(etimeText((now - startMs) / 1000)), tty: own(ttyName(st.ttyNr)), args: args ? readArgs(fs, st) : "" };
        e = { row, start: st.start, startMs, tty: st.ttyNr, t: st.ticks, at: now, seen: pass, comm: st.comm, args, rssAt: args ? pass : -1 }; // -1: rss from stat, statm once tracked
        PF.ents.set(pid, e);
      } else {
        const r = e.row;
        r.ppid = st.ppid; r.etime = own(etimeText((now - startMs) / 1000));
        if (tr && (pass - e.rssAt >= RSS_EVERY || e.rssAt < 0)) { r.rss = readRss(fs, pid, st.rssPages); e.rssAt = pass; }
        if (st.ttyNr !== e.tty) { e.tty = st.ttyNr; r.tty = own(ttyName(st.ttyNr)); }
        const exec = st.comm !== e.comm; if (exec) e.comm = own(st.comm);
        if (args && (!e.args || exec || young || full)) { r.args = readArgs(fs, st); e.args = true; }
        else if (exec && !args) { r.args = ""; e.args = false; }
        if (now - e.at >= 500) { r.cpu = Math.max(0, (st.ticks - e.t) / fs.hz / ((now - e.at) / 1000) * 100); e.t = st.ticks; e.at = now; } // a pass right after another: a 10 ms tick over a few ms would read as 1000%+
      }
    }
    e.seen = pass;
    out.push(e.row);
  }
  for (const [pid, e] of PF.ents) if (e.seen !== pass) PF.ents.delete(pid);
  for (const [pid, p] of PF.wait) if (p !== pass) PF.wait.delete(pid); // gone before its second pass (or read now)
  return out;
}
// a pass without the /proc listing: the pids seen last time, the tracked ones read fresh (cpu, a gone one dropped);
// new pids wait for the next listing pass
export function knownProcs(fs: ProcFs, now: number, tracked: Set<number>): ProcRow[] {
  const out = PF.out; out.length = 0;
  for (const [pid, e] of PF.ents) {
    if (tracked.has(pid)) {
      const st = readStat(fs, pid);
      if (!st || st.start !== e.start) { PF.ents.delete(pid); continue; } // gone (or reused: the next listing reads it as new)
      const r = e.row; r.ppid = st.ppid;
      if (now - e.at >= 500) { r.cpu = Math.max(0, (st.ticks - e.t) / fs.hz / ((now - e.at) / 1000) * 100); e.t = st.ticks; e.at = now; }
    }
    out.push(e.row);
  }
  return out;
}
// /proc is usable: a numbered entry and a boot time (else the caller falls back to ps)
export function procfsUsable(fs: ProcFs): boolean {
  if (fs.btime <= 0 || fs.hz <= 0 || fs.page <= 0) return false;
  for (const n of listDir(fs.root)) if (pidOf(n) >= 0) return true;
  return false;
}
