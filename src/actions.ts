// agentglass — side effects: send prompts, resume, kill, trash, full-text search, external pager/editor
// SPDX-License-Identifier: Apache-2.0
import { existsSync, openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { HOME } from "./util/fs.ts";
import { OS } from "./platform/index.ts";
import { home } from "./util/text.ts";
import type { Sess } from "./model/types.ts";
import { S, say } from "./state.ts";
import { sessions, SG, scan, buildView, parentOf, current, titleOf } from "./model/sessions.ts";
import { refreshProcs, rootOf, procAt, procSess, sharedDaemon } from "./model/procs.ts";
import { paneNow, sendTo, focusOn, startIn } from "./mux/index.ts";
import { tabLabel } from "./mux/herdr-parse.ts";
import { identOf } from "./features/query/project.ts";
import { REDACT } from "./features/redact-on.ts";
import { harnessOf, cmdOf } from "./harness/index.ts";
import { enter, leave } from "./term.ts";
import { realCwd } from "./hooks.ts";

// the session's real dir (--redact fakes s.cwd: the agent would start in a dir that does not exist, or in $HOME)
function cwdOf(s: Sess): string { const c = realCwd(s); return c && existsSync(c) ? c : HOME; }

export function ask(label: string, action: string, init: string): void { S.prevMode = S.mode === "input" ? S.prevMode : S.mode; S.mode = "input"; S.inputLabel = label; S.inputAction = action; S.inputText = init; S.inputErrCol = -1; }
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
// clipboard: the OS's native tools, then tmux → outer terminal, then OSC 52 straight to the terminal (ssh, headless)
export function copyText(text: string, what: string): void {
  const tools = OS.clipboardCmds();
  if (process.env.TMUX) tools.push(["tmux", "load-buffer", "-w", "-"]); // -w: also sets the outer terminal's clipboard
  for (const t of tools) {
    try { execFileSync(t[0], t.slice(1), { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 3000 }); say("ok", "copied " + what); return; } catch (e) { /* next */ }
  }
  const b = new TextEncoder().encode(text);
  if (b.length > 100000) { say("err", "no clipboard tool (wl-copy, xclip, xsel) and too big for OSC 52"); return; }
  let bin = "";
  for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode(...b.subarray(i, i + 8192));
  process.stdout.write("\x1b]52;c;" + btoa(bin) + "\x07");
  say("ok", "copied " + what + " via terminal (OSC 52)");
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
// a file in $PAGER (edit: $EDITOR); "not found" toast when it is gone
export function openPath(path: string, edit: boolean): void { openExternal(edit ? editorCmd() : pagerCmd(), path); }
export function openFileN(n: number, edit: boolean): void {
  const dv = S.dv;
  if (!dv || n < 0 || n >= dv.files.length) return;
  dv.fsel = n;
  openPath(dv.files[n], edit);
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
  if (s.pid) { sendTo(paneNow(s), msg); return; } // its tmux or herdr pane; the none adapter explains why not
  const hl = harnessOf(s.h).headless;
  if (!hl) { say("warn", harnessOf(s.h).label + " has no headless mode — run it in tmux to send prompts"); return; }
  const c = cmdOf(s.h);
  const args = c.slice(1).concat(hl(s, msg));
  const logDir = join(HOME, ".agentglass", "logs");
  try { mkdirSync(logDir, { recursive: true }); } catch (e) { /* exists */ }
  const log = join(logDir, s.id + ".log");
  try {
    const fd = openSync(log, "a");
    writeSync(fd, "\n=== " + new Date().toISOString() + " " + c[0] + " " + args.join(" ") + "\n");
    const ch = spawn(c[0], args, { stdio: ["ignore", fd, fd], detached: true, cwd: cwdOf(s) });
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
  if (s.pid) { const p = paneNow(s); if (p.kind === "none") say("warn", "already running (pid " + s.pid + ")"); else focusOn(p); return; }
  const rs = harnessOf(s.h).resume;
  if (!rs) { say("warn", harnessOf(s.h).label + " can't resume a session by id"); return; }
  // inside herdr: a new tab in the workspace owning the session's directory (the agent must not live in our pane)
  const id = identOf(s);
  if (startIn(s.h, s.id, rs(s), cwdOf(s), id ? id.top : "", tabLabel(titleOf(s), s.id, REDACT))) return;
  const c = cmdOf(s.h);
  ACT_IO.inTerminal(c[0], c.slice(1).concat(rs(s)), cwdOf(s));
}
// the in-terminal resume: leave the TUI, run the agent here, come back when it exits (a seam for checks)
export const ACT_IO = {
  inTerminal: (cmd: string, args: string[], cwd: string): void => {
    leave();
    try { execFileSync(cmd, args, { stdio: "inherit", cwd }); } catch (e) { /* non-zero exit */ }
    enter();
    refreshProcs(); scan(); buildView();
  },
};
export function killPid(pid: number, sig: string): void {
  if (!pid) { say("warn", "no process linked"); return; }
  const w = sharedDaemon(pid); if (w) { say("warn", w); return; }
  try { process.kill(pid, sig); say("ok", sig + " → " + pid); } catch (e) { say("err", "kill failed: " + String(e)); }
  refreshProcs();
}
export function trash(s: Sess): void {
  const fl = harnessOf(s.h).files;
  if (!fl) { say("warn", harnessOf(s.h).label + " sessions can't be moved to the trash"); return; }
  try {
    for (const f of fl(s)) if (existsSync(f)) OS.trash(f);
    sessions.delete(s.path); SG.gen++;
    if (S.tv && S.tv.s === s) { S.tv = null; S.mode = "list"; }
    say("ok", "moved to " + OS.trashName);
  } catch (e) { say("err", "trash failed: " + String(e)); }
  buildView();
}
