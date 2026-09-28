// agentglass — harness processes (ps/lsof/tmux) and their link to sessions
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { str, parse, base } from "../util/json.ts";
import { CLAUDE, KIRO, readText, listDir, run } from "../util/fs.ts";
import type { Proc, Sess } from "./types.ts";
import { sessions } from "./sessions.ts";
import { S } from "../state.ts";
import { applyMeta } from "../hooks.ts";

const HARN = ["claude", "codex", "fx", "kiro-cli", "q", "gemini", "opencode", "aider", "cursor-agent", "amp", "qwen", "crush", "goose", "copilot"];
export let procs: Proc[] = [];
export const allProcs = new Map<number, Proc>();
export const hist = new Map<number, number[]>();
export const cpuHist: number[] = [];
const tmuxByTty = new Map<string, string>();
const cwdByPid = new Map<number, string>();
const codexPidByPath = new Map<string, number>();
const claudeLive = new Map<string, { pid: number; status: string; name: string }>();
const kiroLive = new Map<string, number>(); // kiro session uuid → live pid (from <uuid>.lock, pid verified running)

function harnessOf(args: string): string {
  const t = args.split(" ");
  let b = base(t[0]);
  if ((b === "node" || b === "bun" || b === "deno") && t.length > 1) b = base(t[1]).replace(/\.(m?js|ts)$/, "");
  // kiro-cli spawns child processes named kiro-cli-chat and a bundled `bun .../kiro-cli/.../tui.js`;
  // fold the whole tree onto kiro-cli so process linking and rootOf() see one harness
  if (b === "kiro-cli-chat" || (b === "tui" && args.indexOf("/kiro-cli/") >= 0)) b = "kiro-cli";
  return HARN.indexOf(b) >= 0 ? b : "";
}
export function refreshProcs(): void {
  allProcs.clear();
  const kids = new Map<number, number[]>();
  for (const l of run("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,etime=,tty=,args="]).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const p: Proc = { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rss: Number(m[4]) * 1024, etime: m[5], tty: m[6], args: m[7], h: "", cwd: "", tcpu: 0, trss: 0, kids: 0, sess: "" };
    p.h = harnessOf(p.args);
    allProcs.set(p.pid, p);
    const k = kids.get(p.ppid);
    if (k) k.push(p.pid); else kids.set(p.ppid, [p.pid]);
  }
  const out: Proc[] = [];
  let total = 0;
  for (const p of allProcs.values()) {
    if (!p.h) continue;
    const parent = allProcs.get(p.ppid);
    if (parent && parent.h) continue; // wrapper→binary: count as child of the outer one
    const stack = [p.pid];
    while (stack.length) {
      const q = allProcs.get(stack.pop() as number);
      if (!q) continue;
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
  cpuHist.push(total); if (cpuHist.length > 240) cpuHist.shift();
  out.sort((a, b) => b.tcpu - a.tcpu || a.pid - b.pid);
  const sp = procAt(S.psel); const selPid = sp ? sp.pid : 0;
  procs = out;
  for (let i = 0; i < procs.length; i++) if (procs[i].pid === selPid) S.psel = i; // selection follows the pid, not the row
  // claude live registry
  claudeLive.clear();
  const sd = join(CLAUDE, "sessions");
  for (const f of listDir(sd)) {
    if (!f.endsWith(".json")) continue;
    const o = parse(readText(join(sd, f), 0, 8192).trim());
    if (!o) continue;
    const pid = typeof o["pid"] === "number" ? (o["pid"] as number) : 0;
    if (pid && allProcs.has(pid)) claudeLive.set(str(o["sessionId"]), { pid, status: str(o["status"]), name: str(o["name"]) });
  }
  // kiro live registry: <uuid>.lock holds the owning pid. kiro-cli does not keep the transcript
  // open (unlike codex/fx), so lsof never links it — but a lock whose pid is still running is live.
  // Stale locks persist after death, so the pid must be verified against the live process table.
  kiroLive.clear();
  const kd = join(KIRO, "sessions", "cli");
  for (const f of listDir(kd)) {
    if (!f.endsWith(".lock")) continue;
    const o = parse(readText(join(kd, f), 0, 4096).trim());
    if (!o) continue;
    const pid = typeof o["pid"] === "number" ? (o["pid"] as number) : 0;
    if (pid && allProcs.has(pid)) kiroLive.set(f.slice(0, -5), pid); // strip ".lock" → uuid
  }
  linkSessions();
}
export function refreshSlow(): void {
  // cwd + open rollout files of harness procs (lsof), tmux panes
  cwdByPid.clear(); codexPidByPath.clear();
  const pids = procs.map((p) => String(p.pid));
  if (pids.length) {
    let pid = 0; let fd = "";
    for (const l of run("lsof", ["-a", "-p", pids.join(","), "-Fpfn"]).split("\n")) {
      if (l.startsWith("p")) pid = Number(l.slice(1));
      else if (l.startsWith("f")) fd = l.slice(1);
      else if (l.startsWith("n")) {
        const n = l.slice(1);
        if (fd === "cwd") cwdByPid.set(pid, n);
        else if (n.endsWith(".jsonl") && (n.indexOf("/rollout-") >= 0 || n.indexOf("/.fx/sessions/") >= 0 || n.indexOf("/.kiro/sessions/cli/") >= 0)) codexPidByPath.set(n, pid);
      }
    }
  }
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
    if (s.h === "claude") { const l = claudeLive.get(s.id); if (l) { s.pid = l.pid; s.status = l.status; s.name = l.name; } }
    else if (s.h === "kiro") { const pid = kiroLive.get(s.id); if (pid && allProcs.has(pid)) { const r = rootOf(pid); s.pid = r ? r.pid : pid; s.status = "open"; } }
    else { const pid = codexPidByPath.get(s.path); if (pid && allProcs.has(pid)) { const r = rootOf(pid); s.pid = r ? r.pid : pid; s.status = "open"; } }
    applyMeta(s);
  }
  for (const p of procs) p.sess = "";
  for (const s of sessions.values()) if (s.pid) { const r = rootOf(s.pid); if (r) r.sess = s.path; }
}
export function tmuxTarget(pid: number): string {
  const p = allProcs.get(pid);
  if (!p || p.tty === "??") return "";
  return tmuxByTty.get("/dev/" + p.tty) ?? "";
}
// bounds-checked (see sessAt)
export function procAt(i: number): Proc | null { return i >= 0 && i < procs.length ? procs[i] : null; }
export function procSess(p: Proc): Sess | null { return p.sess ? sessions.get(p.sess) ?? null : null; }
