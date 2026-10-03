// agentglass — footer: clickable key hints, the input prompt line, toasts
// SPDX-License-Identifier: Apache-2.0
import { width, clean, fit, fitStyled } from "../util/text.ts";
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { C, CSI, RST, fg, bg } from "./theme.ts";
import { put } from "./screen.ts";
import { DBG } from "../sched.ts";

// mouse hit map for the hints, rebuilt every frame
export const footX0: number[] = []; export const footX1: number[] = []; export const footKey: string[] = [];

export function renderFooter(): void {
  const W = S.W; const Ht = S.H;
  const y = Ht - 1;
  const mode = S.mode;
  if (mode === "input") {
    put(0, y, bg(C.sel) + fg(C.accent) + CSI + "1m" + " " + S.inputLabel + " ❯ " + RST + bg(C.sel) + fg(C.text) + fit(clean(S.inputText) + "▏", W - S.inputLabel.length - 4) + RST);
    return;
  }
  footX0.length = 0; footX1.length = 0; footKey.length = 0;
  let fx = 0;
  const k = (key: string, what: string): string => {
    const w = width(key) + 1 + width(what);
    // clickable: the hint's key, when it maps to one keystroke
    const act = key === "↵" ? "enter" : key === "␣" ? " " : key === "esc" ? "esc" : key === "tab" ? "tab" : width(key.split("/")[0]) === 1 && key.split("/")[0].length === 1 ? key.split("/")[0] : "";
    if (act) { footX0.push(fx); footX1.push(fx + w); footKey.push(act); }
    fx += w + 2;
    return fg(C.accent) + CSI + "1m" + key + RST + fg(C.sub) + " " + what + "  " + RST;
  };
  // feature hints right after "? keys": they are the mode-specific ones (e.g. replay) and must survive truncation
  let hints = k("?", "keys");
  for (const f of H.footerHints) for (const kd of f(mode)) hints += k(kd[0] ?? "", kd[1] ?? "");
  if (mode === "detail") hints += k("↑↓/jk", "scroll") + k("[/]", "prev/next event") + k("1-9", "open file") + k("tab", "select file") + k("o", "pager") + k("e", "edit") + k("z", "fold all") + k("w", "wrap") + k("v", "all in pager") + k("y", "copy") + k("esc", "back");
  else if (mode === "view") hints += k("esc", "back");
  else if (mode === "transcript") hints += k("↑↓/jk", "event") + k("↵", "details") + k("g/G", "top/end") + k("f", "follow") + k("t", "expand tools") + k("n/N", "subagents") + k("u", "parent") + k("s", "send") + k("R", "resume") + k("esc", "back");
  else if (S.tab === 0) hints += k("↵", "open") + k("␣", "subagents") + k("/", "filter") + k("F", "full-text") + k("h", "harness") + k("l", "live") + k("s", "send") + k("R", "resume") + k("x", "kill") + k("D", "trash");
  else if (S.tab === 1) hints += k("↵", "session") + k("s", "send") + k("x", "SIGTERM") + k("X", "SIGKILL") + k("a", "attach tmux") + k("q", "quit");
  else hints += k("q", "quit");
  put(0, y, fitStyled(hints, W - 1) + CSI + "K");
  if (DBG.on && DBG.line) { const d = " " + fit(DBG.line, Math.min(width(DBG.line), W - 2)) + " "; put(W - width(d), y, bg(C.panel) + fg(C.dim) + d + RST); } // over the hints' tail
  if (S.toast && Date.now() - S.toastAt < S.toastMs) {
    const tk = S.toastKind;
    const icon = tk === "ok" ? "✔" : tk === "err" ? "✖" : tk === "warn" ? "⚠" : "ℹ";
    const col = tk === "ok" ? C.green : tk === "err" ? C.red : tk === "warn" ? C.yellow : C.cyan;
    const msg = " " + icon + " " + clean(S.toast) + " ";
    const w = Math.min(W - 4, width(msg) + 2);
    const x = W - w - 1;
    put(x, Ht - 4, fg(col) + "╭" + "─".repeat(w - 2) + "╮" + RST);
    put(x, Ht - 3, fg(col) + "│" + RST + bg(C.panel) + fg(col) + CSI + "1m" + fit(msg, w - 2) + RST + fg(col) + "│" + RST);
    put(x, Ht - 2, fg(col) + "╰" + "─".repeat(w - 2) + "╯" + RST);
  }
}
