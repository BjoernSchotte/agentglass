// agentglass — all mutable UI state in one object, so every module (and feature modules) sees the same values
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "./model/types.ts";
import type { Clause } from "./features/query/types.ts";
import { screenOut } from "./hooks.ts";

export type Mode = "list" | "transcript" | "detail" | "input" | "confirm" | "help" | "view"; // view = a full-screen feature view (S.fview names it)
export interface TV {
  s: Sess; evs: Ev[]; off: number; ep: string; scroll: number; follow: boolean; expand: boolean; lines: string[]; lw: number; ln: number; lexp: boolean;
  cur: number; lineEv: number[]; lineStart: number[]; // event cursor + rendered-line ↔ event maps
  focusKind: string; focusTs: string; focusText: string; // jump target when opened from the preview; focusText may instead be the event's id
  limit: number; // -1 = all events; else only evs[0..limit) are laid out (replay)
}
// detail layer: one event (tool call + its result) fully expanded
export interface DV { idx: number; lines: string[]; plain: string; files: string[]; fileRow: number[]; foldRow: number[]; foldId: number[]; fsel: number; scroll: number; title: string; lw: number }
export interface HelpSec { name: string; ctx: string; keys: string[][] }

interface State {
  W: number; H: number; frame: number;
  dirty: boolean; animating: boolean; repaint: boolean; // something visible changed / spin() drew last frame / screen cleared: write even if identical
  tab: number; // 0 sessions, 1 processes, 2+ H.tabs
  mode: Mode; prevMode: Mode; fview: string;
  sel: number; top: number; psel: number; ptop: number;
  pins: Clause[]; local: Map<string, Clause[]>; // filter scopes: pinned (every tab, remembered) and per tab ("Sessions", "Stats", …)
  view: Sess[];
  toast: string; toastKind: string; toastAt: number; toastMs: number; // toastMs: how long the current toast shows
  inputLabel: string; inputText: string; inputAction: string; inputErr: string; // inputErr: shown in red after the input text
  confirmText: string; confirmAction: string;
  listY: number; listH: number; listX: number; listW: number;
  tv: TV | null; dv: DV | null;
  wrapCode: boolean; // detail: wrap wide code/diff/output lines, or cut them at the edge (w)
  foldOpen: number[]; foldAll: boolean; // detail: blocks the user unfolded / z = everything open
  helpScroll: number;
  prevSess: Sess | null; prevY0: number; prevX0: number; prevX1: number; // preview panel, for mouse hits
  lastClickY: number; lastClickAt: number;
  cli: boolean; // --json / --watch: no screen, say() warnings go to stderr
}
export const S: State = {
  W: 80, H: 24, frame: 0,
  dirty: true, animating: false, repaint: false,
  tab: 0, mode: "list", prevMode: "list", fview: "",
  sel: 0, top: 0, psel: 0, ptop: 0,
  pins: [], local: new Map<string, Clause[]>(),
  view: [],
  toast: "", toastKind: "info", toastAt: 0, toastMs: 5000,
  inputLabel: "", inputText: "", inputAction: "", inputErr: "",
  confirmText: "", confirmAction: "",
  listY: 0, listH: 0, listX: 0, listW: 0,
  tv: null, dv: null,
  wrapCode: true,
  foldOpen: [], foldAll: false,
  helpScroll: 0,
  prevSess: null, prevY0: 0, prevX0: 0, prevX1: 0,
  lastClickY: -1, lastClickAt: 0,
  cli: false,
};

export function say(kind: string, msg: string): void {
  S.toast = msg; S.toastKind = kind; S.toastAt = Date.now(); S.toastMs = 5000;
  if (S.cli && (kind === "warn" || kind === "err")) process.stderr.write("agentglass: " + screenOut(msg) + "\n");
}
