// agentglass — building blocks shared by the POSIX adapters: ps, lsof, detached helper processes
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { run } from "../util/fs.ts";
import type { ProcRow } from "./types.ts";

export function psProcs(): ProcRow[] {
  const out: ProcRow[] = [];
  for (const l of run("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,etime=,tty=,args="]).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rss: Number(m[4]) * 1024, etime: m[5], tty: m[6], args: m[7] });
  }
  return out;
}
export function lsofFiles(pids: number[], want: (path: string) => boolean): { cwd: Map<number, string>; open: Map<string, number> } {
  const cwd = new Map<number, string>(); const open = new Map<string, number>();
  if (!pids.length) return { cwd, open };
  let pid = 0; let fd = "";
  for (const l of run("lsof", ["-a", "-p", pids.join(","), "-Fpfn"]).split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("f")) fd = l.slice(1);
    else if (l.startsWith("n")) {
      const n = l.slice(1);
      if (fd === "cwd") cwd.set(pid, n);
      else if (want(n)) open.set(n, pid);
    }
  }
  return { cwd, open };
}
// "??" (macOS) / "?" (Linux): no controlling terminal
export function devOf(tty: string): string { return tty && tty !== "??" && tty !== "?" ? "/dev/" + tty : ""; }
export function detached(cmd: string, args: string[]): void {
  try { const ch = spawn(cmd, args, { stdio: "ignore", detached: true }); ch.on("error", (e: Error) => { /* not installed */ }); ch.unref(); } catch (e) { /* best effort */ }
}
// a name for path inside dir that is not taken yet: "x.jsonl", "x 2.jsonl", "x 3.jsonl", …
export function freeName(dir: string, path: string): string {
  const b = basename(path);
  if (!existsSync(join(dir, b))) return b;
  const dot = b.lastIndexOf(".");
  const stem = dot > 0 ? b.slice(0, dot) : b; const ext = dot > 0 ? b.slice(dot) : "";
  for (let n = 2; ; n++) { const c = stem + " " + n + ext; if (!existsSync(join(dir, c))) return c; }
}
export function moveInto(dir: string, path: string): string { const n = freeName(dir, path); renameSync(path, join(dir, n)); return n; }
