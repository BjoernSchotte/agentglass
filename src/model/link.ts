// agentglass — liveness by cwd for harnesses with no registry and no open transcript (pi, OpenCode)
// SPDX-License-Identifier: Apache-2.0
export interface CwdProc { pid: number; h: string; cwd: string }
// session path → pid. A process gets the newest session of its harness+cwd that has no process yet;
// a process that already owns a session (s.pid) is not a candidate — one process, one live session.
export function linkByCwd(procs: CwdProc[], sess: { path: string; h: string; cwd: string; mtime: number; pid: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const owned = new Set<number>();
  for (const s of sess) if (s.pid > 0) owned.add(s.pid);
  const by = new Map<string, { path: string; mtime: number }[]>(); // "<h>\t<cwd>" → free sessions
  for (const s of sess) {
    if (s.pid !== 0 || !s.cwd) continue;
    const k = s.h + "\t" + s.cwd;
    const l = by.get(k);
    if (l) l.push({ path: s.path, mtime: s.mtime }); else by.set(k, [{ path: s.path, mtime: s.mtime }]);
  }
  for (const l of by.values()) l.sort((a, b) => b.mtime - a.mtime);
  const ps = procs.slice().sort((a, b) => a.pid - b.pid);
  for (const p of ps) {
    if (!p.cwd || owned.has(p.pid)) continue;
    const l = by.get(p.h + "\t" + p.cwd);
    if (!l || l.length === 0) continue;
    const s = l.shift();
    if (s) out.set(s.path, p.pid);
  }
  return out;
}
