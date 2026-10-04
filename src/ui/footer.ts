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
    const room = W - width(S.inputLabel) - 4;
    const txt = clean(S.inputText) + "▏";
    const err = S.inputErr ? "  " + clean(S.inputErr) : "";
    const tw = Math.min(width(txt), Math.max(10, room - width(err))); // the error stays visible next to the text
    const shown = width(txt) > tw ? "…" + Array.from(txt).slice(-(tw - 1)).join("") : txt;
    put(0, y, bg(C.sel) + fg(C.accent) + CSI + "1m" + " " + S.inputLabel + " ❯ " + RST + bg(C.sel) + fg(C.text) + shown + fg(C.red) + fit(err, Math.max(0, room - width(shown))) + RST);
    renderToast(); // e.g. a link that waits for this prompt
    return;
  }
  footX0.length = 0; footX1.length = 0; footKey.length = 0;
  // feature hints right after "? keys": they are the mode-specific ones (e.g. replay) and are dropped last
  const ks: string[] = []; const ws: string[] = [];
  const k = (key: string, what: string): void => { ks.push(key); ws.push(what); };
  k("?", "keys"); if (mode === "list" || mode === "transcript" || mode === "detail" || mode === "view") k("^K", "palette"); // everywhere Ctrl+K works
  for (const f of H.footerHints) for (const kd of f(mode)) k(kd[0] ?? "", kd[1] ?? "");
  if (mode === "detail") { k("↑↓/jk", "scroll"); k("[/]", "prev/next event"); k("1-9", "open file"); k("tab", "select file"); k("o", "pager"); k("e", "edit"); k("z", "fold all"); k("w", "wrap"); k("v", "all in pager"); k("y", "copy"); k("esc", "back"); }
  else if (mode === "view") k("esc", "back");
  else if (mode === "palette") { k("↵", "run"); k("→", "session actions"); k("tab", "scope"); k("esc", "close"); }
  else if (mode === "transcript") { k("↑↓/jk", "event"); k("↵", "details"); k("g/G", "top/end"); k("f", "follow"); k("t", "expand tools"); k("n/N", "subagents"); k("u", "parent"); k("s", "send"); k("R", "resume"); k("esc", "back"); }
  else if (S.tab === 0) { k("↵", "open"); k("␣", "subagents"); k("/", "filter"); k("p", "pin"); k("P", "pins"); k("F", "full-text"); k("h", "harness"); k("l", "live"); k("s", "send"); k("R", "resume"); k("x", "kill"); k("D", "trash"); }
  else if (S.tab === 1) { k("↵", "session"); k("s", "send"); k("x", "SIGTERM"); k("X", "SIGKILL"); k("a", "attach tmux"); k("P", "pins"); k("q", "quit"); }
  else k("q", "quit");
  const ft = fitHints(ks, ws, W - 1); const gap = ft.gap;
  let hints = ""; let fx = 0;
  for (let i = 0; i < ks.length; i++) {
    if (i >= ft.n && !(ft.tail && i === ks.length - 1)) continue;
    const key = ks[i]; const what = ws[i];
    if (ft.cut && ft.tail && i === ks.length - 1) { hints += fg(C.dim) + "…" + RST + " ".repeat(gap); fx += 1 + gap; }
    const w = width(key) + 1 + width(what);
    // clickable: the hint's key, when it maps to one keystroke
    const k0 = key.split("/")[0];
    const act = key === "^K" ? "ctrl-k" : key === "↵" ? "enter" : key === "␣" ? " " : key === "esc" ? "esc" : key === "tab" ? "tab" : width(k0) === 1 && k0.length === 1 ? k0 : "";
    if (act) { footX0.push(fx); footX1.push(fx + w); footKey.push(act); }
    fx += w + gap;
    hints += fg(C.accent) + CSI + "1m" + key + RST + fg(C.sub) + " " + what + " ".repeat(gap) + RST;
  }
  if (ft.cut && !ft.tail) hints += fg(C.dim) + "…" + RST;
  put(0, y, fitStyled(hints, W - 1) + CSI + "K");
  if (DBG.on && DBG.line) { const d = " " + fit(DBG.line, Math.min(width(DBG.line), W - 2)) + " "; put(W - width(d), y, bg(C.panel) + fg(C.dim) + d + RST); } // over the hints' tail
  renderToast();
}
// the hints that fit the room (keys ks, labels ws): all with two-space gaps, else one-space gaps and hints dropped from
// the end ("? keys" stays first, a closing esc/q stays last; "…" marks the cut: ? lists every key of the view).
// Shown: the first n hints, then the last one when tail
export function hintsWidth(ks: string[], ws: string[], n: number, tail: boolean, gap: number, cut: boolean): number {
  let w = 0; let m = 0;
  for (let i = 0; i < ks.length; i++) if (i < n || (tail && i === ks.length - 1)) { w += width(ks[i]) + 1 + width(ws[i]); m++; }
  return w + gap * Math.max(0, m - 1) + (cut ? 1 + (m ? gap : 0) : 0);
}
export function fitHints(ks: string[], ws: string[], room: number): { n: number; gap: number; cut: boolean; tail: boolean } {
  const all = ks.length;
  if (hintsWidth(ks, ws, all, false, 2, false) <= room) return { n: all, gap: 2, cut: false, tail: false };
  if (hintsWidth(ks, ws, all, false, 1, false) <= room) return { n: all, gap: 1, cut: false, tail: false };
  const last = all - 1; const keep = all > 1 && (ks[last] === "esc" || ks[last] === "q");
  let n = keep ? last : all;
  while (n > 1 && hintsWidth(ks, ws, n, keep, 1, true) > room) n--;
  return { n, gap: 1, cut: true, tail: keep };
}
// a toast's text in lines of ≤ w columns, broken at blanks (a longer word is split), at most max lines, the last cut with …
export function toastLines(t: string, w: number, max: number): string[] {
  const out: string[] = []; let cur = "";
  for (const wd of t.split(" ")) {
    if (!wd) continue;
    let x = wd;
    while (width(x) > w) { if (cur) { out.push(cur); cur = ""; } const cs: string[] = []; for (const ch of x) cs.push(ch); let n = 0; let i = 0; while (i < cs.length && n + width(cs[i]) <= w) { n += width(cs[i]); i++; } out.push(cs.slice(0, i).join("")); x = cs.slice(i).join(""); }
    if (!x) continue;
    if (cur && width(cur) + 1 + width(x) > w) { out.push(cur); cur = x; } else cur = cur ? cur + " " + x : x;
  }
  if (cur) out.push(cur);
  if (out.length <= max) return out;
  const last = out.slice(max - 1).join(" ");
  return out.slice(0, max - 1).concat([fit(last, w).replace(/\s+$/, "")]);
}
function renderToast(): void {
  const W = S.W; const Ht = S.H;
  if (S.toast && Date.now() - S.toastAt < S.toastMs) {
    const tk = S.toastKind;
    const icon = tk === "ok" ? "✔" : tk === "err" ? "✖" : tk === "warn" ? "⚠" : "ℹ";
    const col = tk === "ok" ? C.green : tk === "err" ? C.red : tk === "warn" ? C.yellow : C.cyan;
    // wraps instead of cutting (up to 3 lines): the box grows upwards, its bottom stays above the footer
    const ls = toastLines(clean(S.toast), Math.max(8, W - 10), 3);
    let tw = 0; for (const l of ls) tw = Math.max(tw, width(l));
    const w = Math.min(W - 4, tw + 6);
    const x = W - w - 1; const top = Ht - 3 - ls.length;
    put(x, top, fg(col) + "╭" + "─".repeat(w - 2) + "╮" + RST);
    for (let i = 0; i < ls.length; i++) put(x, top + 1 + i, fg(col) + "│" + RST + bg(C.panel) + fg(col) + CSI + "1m" + fit((i === 0 ? " " + icon + " " : "   ") + ls[i] + " ", w - 2) + RST + fg(col) + "│" + RST);
    put(x, Ht - 2, fg(col) + "╰" + "─".repeat(w - 2) + "╯" + RST);
  }
}
