// agentglass — macOS adapter: processes, cwd and open files from libproc (libproc.ts: no ps or lsof child), read
// incrementally by procscan.ts as on Linux; ps and lsof where the build has no libproc binding or AGENTGLASS_PROCS=ps
// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { HOME, run } from "../util/fs.ts";
import { own } from "../util/own.ts";
import type { Platform, ProcRow } from "./types.ts";
import { type PStat, type ProcSource, scanSource, knownSource } from "./procscan.ts";
import { nativeProcs, lpPids, lpStat, lpArgs, lpCwd, lpFiles } from "./libproc.ts";
import { psProcs, lsofFiles, devOf, detached, moveInto, ownerModeOf, fileInfoOf } from "./posix.ts";

// libproc as a process source: identity, cpu time and rss in one read (startMs is epoch ms already); arguments another
// user's process or a zombie refuses read "(comm)", as BSD ps prints them
const LIBPROC: ProcSource = {
  id: "libproc",
  pids: (): number[] => lpPids(),
  comm: (pid: number): string => { const s = lpStat(pid); return s ? s.comm : ""; },
  stat: (pid: number): PStat | null => {
    const s = lpStat(pid);
    return s ? { pid, comm: s.comm, zombie: s.zombie, ppid: s.ppid, tty: s.tty, cpuMs: s.cpuMs, startMs: s.startMs, rss: s.rss } : null;
  },
  rss: (pid: number, st: PStat): number => st.rss,
  args: (pid: number, st: PStat): string => own(st.zombie ? "(" + st.comm + ")" : lpArgs(pid, st.comm)),
  bootMs: (now: number): number => 0,
};
export function libprocSource(): ProcSource { return LIBPROC; }
// only new, young and tracked pids are read on most passes; a full pass every 30 s catches execs and reparenting
const FULL_MS = 30000;
const LP = { lastFull: 0 };
function listProcs(tracked: Set<number>, wantArgs: (comm: string) => boolean, discover: boolean): ProcRow[] {
  if (!nativeProcs()) return psProcs(); // ps lists every process with its decaying %cpu
  const now = Date.now(); const full = discover && now - LP.lastFull >= FULL_MS;
  if (full) LP.lastFull = now;
  return discover ? scanSource(LIBPROC, now, tracked, full, wantArgs) : knownSource(LIBPROC, now, tracked);
}
function realpath(p: string): string { try { return realpathSync(p); } catch (e) { return p; } }
// the kernel's vnode paths, real paths as lsof printed them (/private/var/…)
function procFiles(pids: number[], fdPids: Set<number>, want: (path: string) => boolean): { cwd: Map<number, string>; open: Map<string, number> } {
  if (!nativeProcs()) return lsofFiles(pids, want);
  const cwd = new Map<number, string>(); const open = new Map<string, number>();
  for (const pid of pids) {
    const c = lpCwd(pid); if (c) cwd.set(pid, realpath(c));
    if (!fdPids.has(pid)) continue;
    for (const f of lpFiles(pid)) { const n = realpath(f); if (want(n)) open.set(n, pid); }
  }
  return { cwd, open };
}

function esc(t: string): string { return t.replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }

export const darwin: Platform = {
  name: "darwin",
  listProcs,
  cpuOf: (pid: number, reported: number, now: number) => reported, // the scanner's delta, or ps's own recent %cpu
  prune: (alive: (pid: number) => boolean) => { /* the scanner drops gone pids itself */ },
  procFiles,
  ttyDevice: devOf,
  clipboardCmds: () => [["pbcopy"]],
  notify: (title: string, subtitle: string, msg: string) =>
    detached("osascript", ["-e", "display notification \"" + esc(msg) + "\" with title \"" + esc(title) + "\" subtitle \"" + esc(subtitle) + "\""]),
  fullName: () => run("id", ["-F"]).trim(),
  sha256File: (path: string) => (run("shasum", ["-a", "256", path]).split(" ")[0] ?? "").trim(),
  trash: (path: string) => { moveInto(join(HOME, ".Trash"), path); },
  trashName: "~/.Trash",
  fileInfo: (path: string) => fileInfoOf(run("stat", ["-f", "%u %Lp %HT", "--", path])),
  procOwner: (pid: number) => {
    if (nativeProcs()) { const s = lpStat(pid); return s ? s.uid : -1; }
    const t = run("ps", ["-o", "uid=", "-p", String(pid)]).trim(); return /^\d+$/.test(t) ? Number(t) : -1;
  },
  ownerMode: (path: string) => ownerModeOf(run("stat", ["-L", "-f", "%u %Lp", path])),
  envOf: (pid: number) => new Uint8Array(0), // ps -E truncates and SIP hides it: config files only
};
