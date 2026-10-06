// agentglass — the tmux adapter: panes by tty (list-panes), titles once per look, send-keys, switch-client
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { run } from "../util/fs.ts";
import { say } from "../state.ts";
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";

const byTty = new Map<string, string>(); // pane tty → "session:window.pane"
const ttyOf = new Map<number, string>(); // agent pid → its tty device (the last refresh's processes)
const noPane = new Set<string>(); // ttys of agents outside tmux: not asked again till the 30 s
const T = { at: 0, look: -1, titles: new Map<string, string>() };
function readPanes(now: number, ps: MuxProc[]): void {
  T.at = now; byTty.clear(); noPane.clear();
  for (const l of run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"]).split("\n")) {
    const i = l.indexOf(" ");
    if (i > 0) byTty.set(l.slice(0, i), l.slice(i + 1));
  }
  for (const p of ps) if (p.tty && !byTty.has(p.tty)) noPane.add(p.tty);
}
function sig(): string { let o = ""; for (const [k, v] of byTty) o += k + " " + v + "\n"; return o; }
function pane(id: string, tty: string): MuxPane { return { kind: "tmux", id, term: tty, server: "", ws: "", wsId: "", tab: "", status: "", at: 0 }; }
// checks: forget the map
export function tmuxReset(): void { byTty.clear(); ttyOf.clear(); noPane.clear(); T.at = 0; T.look = -1; T.titles.clear(); }
export function sendTmux(t: string, msg: string): void {
  try {
    execFileSync("tmux", ["send-keys", "-t", t, "-l", "--", msg], { stdio: "ignore" });
    // delayed Enter: TUIs like Codex treat an Enter inside a fast key burst as a pasted newline
    setTimeout(() => { run("tmux", ["send-keys", "-t", t, "Enter"]); say("ok", "sent to tmux " + t); }, 400);
  } catch (e) { say("err", "tmux send failed"); }
}
export const tmux: Mux = {
  id: "tmux", label: "tmux",
  present: (now: number): boolean => true, // tmux absent: list-panes returns "" (no pane claimed)
  // panes listed when an agent sits on a tty no pane is known for (a new pane), else every 30 s (a moved one)
  refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => {
    ttyOf.clear(); for (const p of ps) if (p.tty) ttyOf.set(p.pid, p.tty);
    let due = force || now - T.at >= 30000;
    if (!due) for (const p of ps) if (p.tty && !byTty.has(p.tty) && !noPane.has(p.tty)) { due = true; break; }
    if (!due) return false;
    const was = sig(); readPanes(now, ps);
    return sig() !== was;
  },
  paneOf: (pid: number): MuxPane | null => { const t = ttyOf.get(pid) ?? ""; const id = t ? byTty.get(t) ?? "" : ""; return id ? pane(id, t) : null; },
  paneOfSession: (key: string, path: string): MuxPane | null => null,
  links: (): MuxLink[] => [],
  // pane titles by tty, one list-panes per look (an agent's title can change within a second)
  title: (p: MuxPane, look: number): string => {
    if (T.look !== look) {
      T.look = look; T.titles.clear();
      for (const l of run("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_title}"]).split("\n")) { const i = l.indexOf("\t"); if (i > 0) T.titles.set(l.slice(0, i), l.slice(i + 1)); }
    }
    return T.titles.get(p.term) ?? "";
  },
  status: (p: MuxPane, due: boolean, look: number, now: number): string => "",
  send: (p: MuxPane, msg: string): void => { sendTmux(p.id, msg); },
  focus: (p: MuxPane): void => {
    if (process.env.TMUX) { run("tmux", ["switch-client", "-t", p.id]); say("ok", "switched to " + p.id); }
    else say("warn", "not inside tmux — attach with: tmux a -t " + p.id);
  },
  start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => false,
};
