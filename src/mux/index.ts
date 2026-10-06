// agentglass — the multiplexer registry and what the app calls: panes of pids and sessions, send, jump, start, links,
// per-look reads for the watchdog. Precedence: the innermost multiplexer owns an agent — tmux is asked before herdr
// (tmux inside a herdr pane holds the agent's tty; herdr inside tmux, tmux does not know the agent's tty)
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";
import { tmux } from "./tmux.ts";
import { none, NONE_PANE } from "./none.ts";
import { herdr } from "./herdr.ts";
import { placeLabel } from "./herdr-parse.ts";
import { REDACT } from "../features/redact-on.ts";
import { MUX_EVENTS } from "./events.ts";
export { NONE_PANE, MUX_EVENTS };

export const MUXES: Mux[] = [tmux, herdr];
const LAST = { ps: [] as MuxProc[], known: (key: string, path: string): number => 0, look: 0, sharedAt: -1, sharedId: 0 };
// checks: replace the adapters (MUXES keeps its identity) / forget the last processes and looks
export function setMuxes(ms: Mux[]): void { MUXES.length = 0; for (const m of ms) MUXES.push(m); }
export function muxReset(): void { LAST.ps = []; LAST.known = (key: string, path: string): number => 0; LAST.sharedAt = -1; MUX_EVENTS.jumped = false; }
export function muxOf(kind: string): Mux { for (const m of MUXES) if (m.id === kind) return m; return none; }
// the slow job (and actions, forced): every present adapter maps the agent processes; true = some map changed
export function muxRefresh(ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean {
  LAST.ps = ps; LAST.known = known;
  let ch = false; for (const m of MUXES) if (m.present(now) && m.refresh(ps, now, force, known)) ch = true;
  return ch;
}
export function paneOfPid(pid: number): MuxPane {
  if (!pid) return NONE_PANE;
  const now = Date.now();
  for (const m of MUXES) { if (!m.present(now)) continue; const p = m.paneOf(pid); if (p) return p; }
  return NONE_PANE;
}
// a live session by its pid; one without a process by its session key (a herdr pane whose agent reports it)
export function paneOfSess(s: Sess): MuxPane {
  if (s.pid) return paneOfPid(s.pid);
  const now = Date.now();
  for (const m of MUXES) { if (!m.present(now)) continue; const p = m.paneOfSession(s.h + ":" + s.id, s.path); if (p) return p; }
  return NONE_PANE;
}
// actions: the panes read now (the display's map may be up to 30 s old; a moved pane has a new address)
export function paneNow(s: Sess): MuxPane { muxRefresh(LAST.ps, Date.now(), true, LAST.known); return paneOfSess(s); }
export function paneNowPid(pid: number): MuxPane { muxRefresh(LAST.ps, Date.now(), true, LAST.known); return paneOfPid(pid); }
export function sendTo(p: MuxPane, msg: string): void { muxOf(p.kind).send(p, msg); }
export function focusOn(p: MuxPane): void { muxOf(p.kind).focus(p); }
// resume an ended session in a new pane of the first multiplexer that can (herdr, when agentglass runs inside it)
export function startIn(h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean {
  const now = Date.now();
  for (const m of MUXES) if (m.present(now) && m.start(h, id, args, cwd, top, label)) return true;
  return false;
}
export function muxLinks(): MuxLink[] { const out: MuxLink[] = []; const now = Date.now(); for (const m of MUXES) if (m.present(now)) for (const l of m.links()) out.push(l); return out; }
// the links as text: part of procs.ts's link signature (a changed link relinks)
export function muxSig(): string { let o = ""; for (const l of muxLinks()) o += String(l.pid) + " " + l.key + " " + l.path + "\n"; return o; }
// one look of the watchdog: titles and statuses read at most once per look id
export interface MuxLook { title: (p: MuxPane) => string; status: (p: MuxPane, due: boolean) => string }
function lookOf(id: number, now: number): MuxLook {
  return { title: (p: MuxPane): string => muxOf(p.kind).title(p, id), status: (p: MuxPane, due: boolean): string => muxOf(p.kind).status(p, due, id, now) };
}
export function muxLook(now: number): MuxLook { LAST.look++; return lookOf(LAST.look, now); }
// one-shot callers (H.complete, approvalOf) share a look for 1 s: a --json run over many sessions reads once
export function sharedMuxLook(now: number): MuxLook {
  if (LAST.sharedAt < 0 || now - LAST.sharedAt >= 1000) { LAST.look++; LAST.sharedId = LAST.look; LAST.sharedAt = now; }
  return lookOf(LAST.sharedId, now);
}
// a pane for people: "tmux work:1.0", "herdr webapp › 2 · w7:p1A" (labels hidden under --redact), "" for none
export function paneText(p: MuxPane): string { return p.kind === "none" ? "" : p.kind + " " + (p.kind === "herdr" ? placeLabel(p.ws, p.tab, p.id, REDACT) : p.id); }
// paneText in at most w columns: herdr's labels are cut first (with …), the pane id stays whole
export function paneTextIn(p: MuxPane, w: number): string {
  const t = paneText(p); const cs = Array.from(t); if (cs.length <= w || p.kind !== "herdr") return t;
  const tail = " · " + p.id; const room = w - Array.from("herdr " + tail).length - 1;
  if (room < 3 || t === "herdr " + p.id) return "herdr " + p.id;
  return "herdr " + Array.from(t.slice(6, t.length - tail.length)).slice(0, room).join("") + "…" + tail;
}
