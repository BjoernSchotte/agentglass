// agentglass — harness processes (via the platform adapter, tmux) and their link to sessions
// SPDX-License-Identifier: Apache-2.0
import { base } from "../util/json.ts";
import { run } from "../util/fs.ts";
import { OS } from "../platform/index.ts";
import { HARNESSES, harnessOfProc } from "../harness/index.ts";
import type { Live } from "../harness/types.ts";
import type { Proc, Sess } from "./types.ts";
import { sessions } from "./sessions.ts";
import { S } from "../state.ts";
import { linkByCwd, daemonWarn, type CwdProc } from "./link.ts";
import { applyMeta } from "../hooks.ts";

// agents without an adapter yet: shown in the process view under their own name
const OTHER = ["gemini", "aider", "cursor-agent", "amp", "qwen", "crush", "goose", "copilot"];
export let procs: Proc[] = [];
export const allProcs = new Map<number, Proc>();
export const hist = new Map<number, number[]>();
export const cpuHist: number[] = [];
const tmuxByTty = new Map<string, string>();
const cwdByPid = new Map<number, string>();
const filePid = new Map<string, number>(); // open transcript → pid (HarnessAdapter.liveFile)
const registry = new Map<string, Live>(); // "<harness>:<session id>" → entry (HarnessAdapter.liveRegistry)
const daemonLive = new Map<string, Live[]>(); // harness id → its registry, for harnesses whose registry is a shared daemon

function harnessOf(args: string): string {
  const t = args.split(" ");
  let b = base(t[0]);
  if ((b === "node" || b === "bun" || b === "deno") && t.length > 1) b = base(t[1]).replace(/\.(m?js|ts)$/, "");
  return harnessOfProc(b) || (OTHER.indexOf(b) >= 0 ? b : "");
}
export function refreshProcs(): void {
  allProcs.clear();
  const kids = new Map<number, number[]>();
  for (const r of OS.listProcs()) {
    const p: Proc = { pid: r.pid, ppid: r.ppid, cpu: r.cpu, rss: r.rss, etime: r.etime, tty: r.tty, args: r.args, h: "", cwd: "", tcpu: 0, trss: 0, kids: 0, sess: "" };
    p.h = harnessOf(p.args);
    allProcs.set(p.pid, p);
    const k = kids.get(p.ppid);
    if (k) k.push(p.pid); else kids.set(p.ppid, [p.pid]);
  }
  const out: Proc[] = [];
  let total = 0;
  const now = Date.now();
  for (const p of allProcs.values()) {
    if (!p.h) continue;
    const parent = allProcs.get(p.ppid);
    if (parent && parent.h) continue; // wrapper→binary: count as child of the outer one
    const stack = [p.pid];
    while (stack.length) {
      const q = allProcs.get(stack.pop() as number);
      if (!q) continue;
      q.cpu = OS.cpuOf(q.pid, q.cpu, now);
      p.tcpu += q.cpu; p.trss += q.rss; if (q !== p) p.kids++;
      for (const c of kids.get(q.pid) ?? []) stack.push(c);
    }
    const hh = hist.get(p.pid) ?? [];
    hh.push(p.tcpu); if (hh.length > 120) hh.shift();
    hist.set(p.pid, hh);
    p.cwd = cwdByPid.get(p.pid) ?? "";
    total += p.tcpu;
    out.push(p);
  }
  for (const k of [...hist.keys()]) if (!allProcs.has(k)) hist.delete(k);
  OS.prune((pid: number) => allProcs.has(pid));
  cpuHist.push(total); if (cpuHist.length > 240) cpuHist.shift();
  out.sort((a, b) => b.tcpu - a.tcpu || a.pid - b.pid);
  const sp = procAt(S.psel); const selPid = sp ? sp.pid : 0;
  procs = out;
  for (let i = 0; i < procs.length; i++) if (procs[i].pid === selPid) S.psel = i; // selection follows the pid, not the row
  registry.clear(); daemonLive.clear();
  const alive = (pid: number): boolean => allProcs.has(pid);
  const hOf = (pid: number): string => { const p = allProcs.get(pid); return p ? p.h : ""; };
  for (const ad of HARNESSES) {
    const f = ad.liveRegistry; if (!f) continue;
    const ls = f(alive, hOf);
    for (const l of ls) registry.set(ad.id + ":" + l.id, l);
    if (ad.daemon) daemonLive.set(ad.id, ls);
  }
  linkSessions();
}
export function refreshSlow(): void {
  // cwd + open rollout files of every harness proc — nested ones too (codex app-server under its daemon holds the rollouts), tmux panes
  const hp: number[] = [];
  for (const p of allProcs.values()) if (p.h) hp.push(p.pid);
  const f = OS.procFiles(hp, (n: string) => { for (const ad of HARNESSES) { const lf = ad.liveFile; if (lf && lf(n)) return true; } return false; });
  cwdByPid.clear(); filePid.clear();
  for (const [k, v] of f.cwd) cwdByPid.set(k, v);
  for (const [k, v] of f.open) filePid.set(k, v);
  tmuxByTty.clear();
  for (const l of run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"]).split("\n")) {
    const i = l.indexOf(" ");
    if (i > 0) tmuxByTty.set(l.slice(0, i), l.slice(i + 1));
  }
  for (const p of procs) p.cwd = cwdByPid.get(p.pid) ?? "";
  linkSessions();
}
export function rootOf(pid: number): Proc | null {
  let q = allProcs.get(pid);
  while (q) { const par = allProcs.get(q.ppid); if (!par || !par.h) break; q = par; }
  return q ?? null;
}
function linkSessions(): void {
  for (const s of sessions.values()) {
    s.pid = 0; s.status = ""; s.name = "";
    const l = registry.get(s.h + ":" + s.id);
    if (l) { s.pid = l.pid; s.status = l.status; s.name = l.name; }
    else { const pid = filePid.get(s.path); if (pid && allProcs.has(pid)) { const r = rootOf(pid); s.pid = r ? r.pid : pid; s.status = "open"; } }
    applyMeta(s);
  }
  // harnesses with neither registry nor open transcript: process cwd ↔ newest session in that cwd
  // (registry pids are daemons, not TUIs; subagents never own a TUI)
  const regPids = new Set<number>();
  for (const l of registry.values()) regPids.add(l.pid);
  for (const ad of HARNESSES) {
    if (!ad.liveCwd) continue;
    const cp: CwdProc[] = [];
    for (const p of procs) if (p.h === ad.id && p.cwd && !regPids.has(p.pid)) cp.push({ pid: p.pid, h: p.h, cwd: p.cwd });
    const ss: { path: string; h: string; cwd: string; mtime: number; pid: number }[] = [];
    for (const s of sessions.values()) if (s.h === ad.id && !s.parent) ss.push({ path: s.path, h: s.h, cwd: s.cwd, mtime: s.mtime, pid: s.pid });
    for (const [path, pid] of linkByCwd(cp, ss)) {
      const s = sessions.get(path);
      if (s) { const r = rootOf(pid); s.pid = r ? r.pid : pid; s.status = "open"; }
    }
  }
  for (const p of procs) p.sess = "";
  for (const s of sessions.values()) if (s.pid) { const r = rootOf(s.pid); if (r) r.sess = s.path; }
}
// pid is a harness's shared daemon: the warning to show instead of signalling it ("" = fine to signal)
export function sharedDaemon(pid: number): string {
  for (const ad of HARNESSES) {
    const d = ad.daemon; const ls = daemonLive.get(ad.id);
    if (d && ls) { const w = daemonWarn(pid, ad.label, d, ls); if (w) return w; }
  }
  return "";
}
export function tmuxTarget(pid: number): string {
  const p = allProcs.get(pid);
  const dev = p ? OS.ttyDevice(p.tty) : "";
  return dev ? tmuxByTty.get(dev) ?? "" : "";
}
// bounds-checked (see sessAt)
export function procAt(i: number): Proc | null { return i >= 0 && i < procs.length ? procs[i] : null; }
export function procSess(p: Proc): Sess | null { return p.sess ? sessions.get(p.sess) ?? null : null; }
