// agentglass — side effects: send prompts, resume, kill, trash, full-text search, external pager/editor
// SPDX-License-Identifier: Apache-2.0
import { existsSync, renameSync, openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { join } from "node:path";
import { base } from "./util/json.ts";
import { HOME, CLAUDE, CODEX, FX, run } from "./util/fs.ts";
import { home } from "./util/text.ts";
import type { Sess } from "./model/types.ts";
import { S, say } from "./state.ts";
import { sessions, scan, buildView, parentOf, current } from "./model/sessions.ts";
import { refreshProcs, rootOf, tmuxTarget, procAt, procSess } from "./model/procs.ts";
import { cmdOf, headlessArgs, resumeArgs } from "./harness/index.ts";
import { enter, leave } from "./term.ts";

export function ask(label: string, action: string, init: string): void { S.prevMode = S.mode === "input" ? S.prevMode : S.mode; S.mode = "input"; S.inputLabel = label; S.inputAction = action; S.inputText = init; }
export function confirm(text: string, action: string): void { S.prevMode = S.mode; S.mode = "confirm"; S.confirmText = text; S.confirmAction = action; }
export function target(): Sess | null {
  if (S.mode === "transcript" || S.prevMode === "transcript") return S.tv ? S.tv.s : null;
  if (S.tab === 1) { const p = procAt(S.psel); return p ? procSess(p) : null; }
  return current();
}
export function targetPid(): number {
  if (S.tab === 1 && S.prevMode !== "transcript" && S.mode !== "transcript") { const p = procAt(S.psel); return p ? p.pid : 0; }
  const s = target(); if (!s || !s.pid) return 0;
  const r = rootOf(s.pid); return r ? r.pid : s.pid;
}
export function openExternal(cmd: string, path: string): void {
  if (!existsSync(path)) { say("warn", "not found: " + home(path)); return; }
  const c = cmd.split(" ").filter((x) => x.length > 0);
  leave();
  try { execFileSync(c[0], c.slice(1).concat([path]), { stdio: "inherit" }); } catch (err) { /* viewer exit code */ }
  enter();
}
function pagerCmd(): string { const p = process.env.PAGER; return p !== undefined && p.trim() ? p : "less -R"; }
function editorCmd(): string { const v = process.env.VISUAL; const e = process.env.EDITOR; return v !== undefined && v.trim() ? v : e !== undefined && e.trim() ? e : "vi"; }
export function openFileN(n: number, edit: boolean): void {
  const dv = S.dv;
  if (!dv || n < 0 || n >= dv.files.length) return;
  dv.fsel = n;
  openExternal(edit ? editorCmd() : pagerCmd(), dv.files[n]);
}
export function pageDetail(): void {
  const dv = S.dv;
  if (!dv) return;
  const dir = join(HOME, ".agentglass", "tmp");
  try { mkdirSync(dir, { recursive: true }); } catch (err) { /* exists */ }
  const f = join(dir, "detail.txt");
  try { const fd = openSync(f, "w"); writeSync(fd, dv.plain + "\n"); closeSync(fd); } catch (err) { say("err", "cannot write " + home(f)); return; }
  openExternal(pagerCmd(), f);
}
export function sendTmux(t: string, msg: string): void {
  try {
    execFileSync("tmux", ["send-keys", "-t", t, "-l", "--", msg], { stdio: "ignore" });
    // delayed Enter: TUIs like Codex treat an Enter inside a fast key burst as a pasted newline
    setTimeout(() => { run("tmux", ["send-keys", "-t", t, "Enter"]); say("ok", "sent to tmux " + t); }, 400);
  } catch (e) { say("err", "tmux send failed"); }
}
// subagent transcripts are not resumable sessions: prompts and resumes go to the owning session
export function owner(s: Sess): Sess | null {
  if (!s.parent) return s;
  const p = parentOf(s);
  if (!p) say("warn", "subagent without its parent session — nothing to resume");
  return p;
}
export function sendPrompt(sub: Sess, msg: string): void {
  const s = owner(sub);
  if (!s) return;
  if (s.pid) {
    const t = tmuxTarget(s.pid);
    if (!t) { say("warn", "session is live outside tmux — cannot inject input safely"); return; }
    sendTmux(t, msg);
    return;
  }
  const c = cmdOf(s.h);
  const args = c.slice(1).concat(headlessArgs(s.h, s.id, msg));
  const logDir = join(HOME, ".agentglass", "logs");
  try { mkdirSync(logDir, { recursive: true }); } catch (e) { /* exists */ }
  const log = join(logDir, s.id + ".log");
  try {
    const fd = openSync(log, "a");
    writeSync(fd, "\n=== " + new Date().toISOString() + " " + c[0] + " " + args.join(" ") + "\n");
    const ch = spawn(c[0], args, { stdio: ["ignore", fd, fd], detached: true, cwd: s.cwd && existsSync(s.cwd) ? s.cwd : HOME });
    closeSync(fd);
    ch.on("error", (e: Error) => say("err", c[0] + ": " + e.message));
    ch.on("exit", (code: number | null) => say(code === 0 ? "ok" : "err", c[0] + " finished (" + String(code) + ") · log " + home(log)));
    ch.unref();
    say("ok", "headless " + c[0] + " resumed · log " + home(log));
  } catch (e) { say("err", "spawn failed: " + String(e)); }
}
export function resume(sub: Sess): void {
  const s = owner(sub);
  if (!s) return;
  if (s.pid) {
    const t = tmuxTarget(s.pid);
    if (t && process.env.TMUX) { run("tmux", ["switch-client", "-t", t]); say("ok", "switched to " + t); }
    else say("warn", "already running (pid " + s.pid + ")" + (t ? " in tmux " + t : ""));
    return;
  }
  const c = cmdOf(s.h);
  const args = c.slice(1).concat(resumeArgs(s.h, s.id));
  leave();
  try { execFileSync(c[0], args, { stdio: "inherit", cwd: s.cwd && existsSync(s.cwd) ? s.cwd : HOME }); } catch (e) { /* non-zero exit */ }
  enter();
  refreshProcs(); scan(); buildView();
}
export function killPid(pid: number, sig: string): void {
  if (!pid) { say("warn", "no process linked"); return; }
  try { process.kill(pid, sig); say("ok", sig + " → " + pid); } catch (e) { say("err", "kill failed: " + String(e)); }
  refreshProcs();
}
export function trash(s: Sess): void {
  const t = join(HOME, ".Trash");
  try {
    if (s.h === "fx") {
      const d = s.path.slice(0, -"/events.jsonl".length);
      renameSync(d, join(t, "fx-session-" + base(d)));
    } else renameSync(s.path, join(t, base(s.path)));
    const dir = s.path.slice(0, -6);
    if (s.h === "claude" && existsSync(dir)) renameSync(dir, join(t, base(dir)));
    if (s.h === "claude" && existsSync(dir + ".meta.json")) renameSync(dir + ".meta.json", join(t, base(dir) + ".meta.json"));
    sessions.delete(s.path);
    if (S.tv && S.tv.s === s) { S.tv = null; S.mode = "list"; }
    say("ok", "moved to ~/.Trash");
  } catch (e) { say("err", "trash failed: " + String(e)); }
  buildView();
}
export function fullText(q: string): void {
  S.fullq = q;
  if (!q) { S.useFull = false; buildView(); return; }
  const dirs = [join(CLAUDE, "projects"), join(CODEX, "sessions"), join(CODEX, "archived_sessions"), join(FX, "sessions")].filter((d) => existsSync(d));
  const r = spawnSync("rg", ["-l", "-i", "-F", "--glob", "*.jsonl", "--", q].concat(dirs), { encoding: "utf8", timeout: 30000 });
  let out = r.stdout;
  if (r.error) out = run("grep", ["-rilF", "--include=*.jsonl", "--", q].concat(dirs));
  S.fulltext = new Set<string>(out.split("\n").filter((l) => l.length > 0)); S.useFull = true;
  S.sel = 0; buildView();
  say("info", S.fulltext.size + " sessions contain “" + q + "”");
}
