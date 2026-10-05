// agentglass — liveness by cwd for harnesses with no registry and no open transcript (pi, OpenCode)
// SPDX-License-Identifier: Apache-2.0
import type { Live } from "../harness/types.ts";

// after: only sessions that started at or after this time (epoch ms) can be the process's own; 0 = any (unknown start,
// a resume). Gemini rewrites an older session of the project when it starts, which makes that one the newest by mtime.
export interface CwdProc { pid: number; h: string; cwd: string; after: number }
// a shared daemon's pid (a harness's registry, HarnessAdapter.daemon): SIGTERM would stop every session it runs, so x/X
// refuse it with this warning; "" = pid is not in that registry
export function daemonWarn(pid: number, label: string, stop: string, live: Live[]): string {
  if (!live.some((l: Live) => l.pid === pid)) return "";
  let n = 0; for (const l of live) if (l.pid === pid && l.id !== "") n++;
  return label + " daemon — runs " + String(n) + " session" + (n === 1 ? "" : "s") + "; stop it with `" + stop + "`";
}
// session path → pid. A process gets the newest session of its harness+cwd that has no process yet;
// a process that already owns a session (s.pid) is not a candidate — one process, one live session.
// A session already live through another link (OpenCode: the daemon runs it, the TUI/`run` client sits in its cwd)
// still counts as the newest in its cwd: the process is taken to be its client and links nothing.
// start: when the session began (epoch ms, 0 = unknown: always a candidate)
export function linkByCwd(procs: CwdProc[], sess: { path: string; h: string; cwd: string; mtime: number; pid: number; start: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const owned = new Set<number>();
  for (const s of sess) if (s.pid > 0) owned.add(s.pid);
  const by = new Map<string, { path: string; mtime: number; pid: number; start: number }[]>(); // "<h>\t<cwd>" → sessions, newest first
  for (const s of sess) {
    if (!s.cwd) continue;
    const k = s.h + "\t" + s.cwd;
    const l = by.get(k);
    const e = { path: s.path, mtime: s.mtime, pid: s.pid, start: s.start };
    if (l) l.push(e); else by.set(k, [e]);
  }
  for (const l of by.values()) l.sort((a, b) => b.mtime - a.mtime);
  const ps = procs.slice().sort((a, b) => a.pid - b.pid);
  for (const p of ps) {
    if (!p.cwd || owned.has(p.pid)) continue;
    const l = by.get(p.h + "\t" + p.cwd); if (!l) continue;
    let i = 0; if (p.after > 0) while (i < l.length && (l[i]?.start ?? 0) > 0 && (l[i]?.start ?? 0) < p.after) i++;
    if (i >= l.length) continue; // none of its own yet
    const s = l.splice(i, 1)[0];
    if (s && s.pid === 0) out.set(s.path, p.pid);
  }
  return out;
}
