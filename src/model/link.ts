// agentglass — liveness by cwd for harnesses with no registry and no open transcript (pi, OpenCode)
// SPDX-License-Identifier: Apache-2.0
import type { Live } from "../harness/types.ts";

// start: when the process started (epoch ms, 0 = unknown: the newest session is its own, as for every harness without
// session starts). resume: what it continues ("" = a new session, "latest", a session id, or gemini's 1-based index)
export interface CwdProc { pid: number; h: string; cwd: string; start: number; resume: string }
// start: when the session began (epoch ms, 0 = unknown: always a candidate)
export interface CwdSess { path: string; id: string; h: string; cwd: string; mtime: number; pid: number; start: number }
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
// With session and process starts (Gemini, which rewrites an older session of the project when it starts):
// - a new process's own sessions are those begun since it started (1 s slack: an etime start is a lower bound in whole
//   seconds); the most recently started process picks first, so two in one project each get theirs. A session with an
//   unknown start (gemini recreated a file another one's startup deleted: no header) only when it has none of those.
//   None = no link;
// - a resume links the session it continues: an id, gemini's index (by start, sessions with messages, 1-based), or
//   "latest" (the last started of those with messages begun before it); an id not listed yet links nothing;
// - an in-TUI resume (the process records into an older session from then on; its startup one stays empty): a lone
//   process in its project takes an older session that got a message (lastMsg, epoch ms) after it started and later
//   than any of its own, unless another process held it since (held: a headless --resume run that ended)
const SLACK = 1000;
export function linkByCwd(procs: CwdProc[], sess: CwdSess[], lastMsg: (path: string) => number = (p: string): number => 0,
  held: (path: string, pid: number, since: number) => boolean = (p: string, pid: number, since: number): boolean => false): Map<string, number> {
  const out = new Map<string, number>();
  const owned = new Set<number>();
  for (const s of sess) if (s.pid > 0) owned.add(s.pid);
  const by = new Map<string, CwdSess[]>(); // "<h>\t<cwd>" → sessions, newest first
  for (const s of sess) {
    if (!s.cwd) continue;
    const k = s.h + "\t" + s.cwd;
    const l = by.get(k);
    if (l) l.push(s); else by.set(k, [s]);
  }
  for (const l of by.values()) l.sort((a, b) => b.mtime - a.mtime);
  const all = new Map<string, CwdSess[]>(); for (const [k, l] of by) all.set(k, l.slice()); // gemini's index counts taken ones too
  const n = new Map<string, number>(); for (const p of procs) if (p.cwd && !owned.has(p.pid)) { const k = p.h + "\t" + p.cwd; n.set(k, (n.get(k) ?? 0) + 1); }
  // resumes first (they name their session), then new processes, last started first; unknown starts last, lowest pid first
  const rank = (p: CwdProc): number => p.resume ? 0 : p.start > 0 ? 1 : 2;
  const ps = procs.slice().sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? b.start - a.start : a.pid - b.pid));
  for (const p of ps) {
    if (!p.cwd || owned.has(p.pid)) continue;
    const k = p.h + "\t" + p.cwd; const l = by.get(k); if (!l) continue;
    let i = -1;
    if (p.resume) i = resumed(p, l, all.get(k) ?? [], lastMsg);
    else if (p.start > 0) {
      for (let j = 0; j < l.length && i < 0; j++) if ((l[j]?.start ?? 0) >= p.start - SLACK) i = j;
      for (let j = 0; j < l.length && i < 0; j++) if ((l[j]?.start ?? 0) === 0) i = j; // start unknown: when none is surely its own
      if ((n.get(k) ?? 0) === 1) {
        let o = -1; let ot = -1; // its own session's last message: read only once an older one got a message since (a tail read)
        for (let j = 0; j < l.length; j++) {
          const s = l[j]; if (!s || s.start <= 0 || s.start >= p.start - SLACK || s.mtime < p.start) continue;
          const t = lastMsg(s.path); if (t < p.start || held(s.path, p.pid, p.start)) continue; // the startup rewrite: no message
          if (ot < 0) ot = i >= 0 ? lastMsg(l[i]?.path ?? "") : 0;
          if (t > ot) { o = j; ot = t; }
        }
        if (o >= 0) i = o;
      }
    } else i = 0;
    if (i < 0 || i >= l.length) continue; // none of its own yet
    const s = l.splice(i, 1)[0];
    if (s && s.pid === 0) out.set(s.path, p.pid);
  }
  return out;
}
// the index in l (untaken, newest first) of the session a resume continues, -1 none
function resumed(p: CwdProc, l: CwdSess[], all: CwdSess[], lastMsg: (path: string) => number): number {
  const at = (path: string): number => { for (let j = 0; j < l.length; j++) if (l[j]?.path === path) return j; return -1; };
  for (let j = 0; j < l.length; j++) if (l[j]?.id === p.resume) return j;
  // gemini's list: sessions with messages that began before the process, by start
  const before = all.filter((s: CwdSess): boolean => s.start > 0 && (p.start <= 0 || s.start < p.start) && lastMsg(s.path) > 0);
  before.sort((a, b) => a.start - b.start);
  if (p.resume === "latest") {
    if (!before.length) return l.length ? 0 : -1; // starts unknown: the newest, as before
    return at(before[before.length - 1]?.path ?? "");
  }
  const x = /^[0-9]+$/.test(p.resume) ? Number(p.resume) : 0;
  return x >= 1 && x <= before.length ? at(before[x - 1]?.path ?? "") : -1;
}
