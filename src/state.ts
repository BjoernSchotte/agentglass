// agentglass — all mutable UI state in one object, so every module (and feature modules) sees the same values
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "./model/types.ts";

export type Mode = "list" | "transcript" | "detail" | "input" | "confirm" | "help" | "view"; // view = a full-screen feature view (S.fview names it)
export interface TV {
  s: Sess; evs: Ev[]; off: number; scroll: number; follow: boolean; expand: boolean; lines: string[]; lw: number; ln: number; lexp: boolean;
  cur: number; lineEv: number[]; lineStart: number[]; // event cursor + rendered-line ↔ event maps
  focusKind: string; focusTs: string; focusText: string; // jump target when opened from the preview; focusText may instead be the event's id
  limit: number; // -1 = all events; else only evs[0..limit) are laid out (replay)
}
// detail layer: one event (tool call + its result) fully expanded
export interface DV { idx: number; lines: string[]; plain: string; files: string[]; fileRow: number[]; foldRow: number[]; foldId: number[]; fsel: number; scroll: number; title: string; lw: number }
export interface HelpSec { name: string; ctx: string; keys: string[][] }

interface State {
  W: number; H: number; frame: number;
  tab: number; // 0 sessions, 1 processes, 2+ H.tabs
  mode: Mode; prevMode: Mode; fview: string;
  sel: number; top: number; psel: number; ptop: number;
  filter: string; hfilter: string; liveOnly: boolean; // hfilter: "", "claude", "codex", "fx", "kiro"
  fulltext: Set<string>; useFull: boolean; fullq: string;
  view: Sess[];
  toast: string; toastKind: string; toastAt: number;
  inputLabel: string; inputText: string; inputAction: string;
  confirmText: string; confirmAction: string;
  listY: number; listH: number; listX: number; listW: number;
  tv: TV | null; dv: DV | null;
  wrapCode: boolean; // detail: wrap wide code/diff/output lines, or cut them at the edge (w)
  foldOpen: number[]; foldAll: boolean; // detail: blocks the user unfolded / z = everything open
  helpScroll: number;
  prevSess: Sess | null; prevY0: number; prevX0: number; prevX1: number; // preview panel, for mouse hits
  lastClickY: number; lastClickAt: number;
}
export const S: State = {
  W: 80, H: 24, frame: 0,
  tab: 0, mode: "list", prevMode: "list", fview: "",
  sel: 0, top: 0, psel: 0, ptop: 0,
  filter: "", hfilter: "", liveOnly: false,
  fulltext: new Set<string>(), useFull: false, fullq: "",
  view: [],
  toast: "", toastKind: "info", toastAt: 0,
  inputLabel: "", inputText: "", inputAction: "",
  confirmText: "", confirmAction: "",
  listY: 0, listH: 0, listX: 0, listW: 0,
  tv: null, dv: null,
  wrapCode: true,
  foldOpen: [], foldAll: false,
  helpScroll: 0,
  prevSess: null, prevY0: 0, prevX0: 0, prevX1: 0,
  lastClickY: -1, lastClickAt: 0,
};

export function say(kind: string, msg: string): void { S.toast = msg; S.toastKind = kind; S.toastAt = Date.now(); }
