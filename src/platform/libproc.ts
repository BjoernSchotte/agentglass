// agentglass — macOS process reads through src/platform/darwin/libproc.c (scriptc --ffi darwin/ffi.json; build.sh adds
// it on macOS): the pid list, identity, cpu, rss, arguments, cwd and open files with no ps or lsof child. A build
// without the manifest has no binding: the first call throws, nativeProcs() answers false and the adapter uses ps.
// SPDX-License-Identifier: Apache-2.0

// each returns the bytes written into buf, 0 = gone, -1 = unreadable, -n = buf too small (n needed); agPids the count
declare function agPids(buf: Uint8Array): number;
declare function agStat(pid: number, buf: Uint8Array): number;
declare function agArgs(pid: number, buf: Uint8Array): number;
declare function agCwd(pid: number, buf: Uint8Array): number;
declare function agFiles(pid: number, buf: Uint8Array): number;

// startMs epoch ms; cpuMs user + system time, -1 = refused (another user's process); rss bytes; tty "??" = none
export interface AgStat { ppid: number; uid: number; zombie: boolean; startMs: number; cpuMs: number; rss: number; tty: string; comm: string }
const INT = /^-?\d+$/;
// "ppid uid zombie(0|1) startMs cpuMs rss tty\tcomm" (ag_stat); comm may hold spaces; null when malformed
export function parseAgStat(text: string): AgStat | null {
  const t = text.indexOf("\t"); if (t < 0) return null;
  const f = text.slice(0, t).split(" ");
  if (f.length !== 7) return null;
  for (let i = 0; i < 6; i++) if (!INT.test(f[i] ?? "")) return null;
  const z = f[2] ?? "";
  if (z !== "0" && z !== "1") return null;
  return { ppid: Number(f[0]), uid: Number(f[1]), zombie: z === "1", startMs: Number(f[3]), cpuMs: Number(f[4]), rss: Number(f[5]), tty: f[6] ?? "??", comm: text.slice(t + 1) };
}
// NUL-separated paths in b[0, n) → strings, empty parts dropped
export function nulSplit(b: Uint8Array, n: number): string[] {
  const out: string[] = []; let s = 0;
  const z = Math.min(n, b.length);
  for (let i = 0; i <= z; i++) if (i === z || b[i] === 0) { if (i > s) out.push(new TextDecoder("utf-8").decode(b.subarray(s, i))); s = i + 1; }
  return out;
}

export const LP_STATS = { pids: 0, stat: 0, args: 0 }; // calls, for checks
const ARGS_MAX = 262144; // a longer argument list is cut there: classification needs its first words
// one buffer for stat, args and cwd (a line, a command line, a path); the pid list and open files have their own
let B = new Uint8Array(65536); let PB = new Uint8Array(16384); let FB = new Uint8Array(65536);
function text(b: Uint8Array, n: number): string { return new TextDecoder("utf-8").decode(b.subarray(0, n)); }

function pidsOf(): number[] {
  LP_STATS.pids++;
  let c = agPids(PB);
  while (c >= 0 && c * 4 >= PB.length && PB.length < 4194304) { PB = new Uint8Array(PB.length * 2); c = agPids(PB); } // may be cut: grow
  const out: number[] = [];
  for (let i = 0; i < c; i++) { const o = i * 4; const p = PB[o] | (PB[o + 1] << 8) | (PB[o + 2] << 16) | (PB[o + 3] << 24); if (p > 0) out.push(p); }
  return out;
}
// decided once per process: macOS, not forced to ps (AGENTGLASS_PROCS=ps), and the binding works (a build without
// --ffi throws ReferenceError here)
const NP = { v: -1 };
export function nativeProcs(): boolean {
  if (NP.v < 0) {
    NP.v = 0;
    if (process.platform === "darwin" && process.env.AGENTGLASS_PROCS !== "ps") { try { NP.v = pidsOf().length > 0 ? 1 : 0; } catch (e) { NP.v = 0; } }
  }
  return NP.v > 0;
}
// every pid now ([] without the binding)
export function lpPids(): number[] { return nativeProcs() ? pidsOf() : []; }
// null = gone or unreadable
export function lpStat(pid: number): AgStat | null {
  if (!nativeProcs()) return null;
  LP_STATS.stat++;
  const n = agStat(pid, B);
  return n > 0 ? parseAgStat(text(B, n)) : null;
}
// the command line as ps args shows it; "(comm)" when it cannot be read (another user's process, a zombie), as BSD ps
export function lpArgs(pid: number, comm: string): string {
  if (!nativeProcs()) return "(" + comm + ")";
  LP_STATS.args++;
  let n = agArgs(pid, B);
  if (n < -1 && B.length < ARGS_MAX) { B = new Uint8Array(Math.min(-n, ARGS_MAX)); n = agArgs(pid, B); }
  if (n < -1) n = B.length; // still longer: cut
  return n > 0 ? text(B, n) : "(" + comm + ")";
}
// the current directory as the kernel names it ("" when unknown)
export function lpCwd(pid: number): string {
  if (!nativeProcs()) return "";
  const n = agCwd(pid, B);
  return n > 0 ? text(B, n) : "";
}
// the paths of its open files
export function lpFiles(pid: number): string[] {
  if (!nativeProcs()) return [];
  let n = agFiles(pid, FB);
  if (n < -1) { FB = new Uint8Array(-n + 4096); n = agFiles(pid, FB); } // more opened meanwhile: what fits
  return n > 0 ? nulSplit(FB, n) : n < -1 ? nulSplit(FB, FB.length) : [];
}
