// agentglass — footer: clickable key hints, the input prompt line, toasts
// SPDX-License-Identifier: Apache-2.0
import { width, clean, fit, fitStyled } from "../util/text.ts";
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { C, CSI, RST, fg, bg } from "./theme.ts";
import { put } from "./screen.ts";
import { DBG } from "../sched.ts";
import { sessAt } from "../model/sessions.ts";

// mouse hit map for the hints, rebuilt every frame
export const footX0: number[] = []; export const footX1: number[] = []; export const footKey: string[] = [];

export function renderFooter(): void {
  const W = S.W; const Ht = S.H;
  const y = Ht - 1;
  const mode = S.mode;
  if (mode === "input") {
    const txt = clean(S.inputText) + "▏";
    const err = S.inputErr ? "  " + clean(S.inputErr) : "";
    // a long label (price lines name the model and the fields) is cut before the text and its error are: ≥ 40 cells for them
    const lab = fit(S.inputLabel, Math.max(8, Math.min(width(S.inputLabel), W - 4 - Math.min(40, width(txt) + width(err) + 12))));
    const room = W - width(lab) - 4;
    const tw = Math.min(width(txt), Math.max(10, room - width(err))); // the error stays visible next to the text
    const cps = Array.from(txt); const scrolled = width(txt) > tw; const cut = scrolled ? Math.max(0, cps.length - (tw - 1)) : 0; // code points scrolled away
    const shown = scrolled ? "…" + cps.slice(cut).join("") : txt;
    // the error's column: a UTF-16 offset into the raw text → code points of the cleaned one, then past the "…"
    const ec = S.inputErr && S.inputErrCol >= 0 ? Array.from(clean(S.inputText.slice(0, S.inputErrCol))).length - cut : -1;
    put(0, y, bg(C.sel) + fg(C.accent) + CSI + "1m" + " " + lab + " ❯ " + RST + bg(C.sel) + fg(C.text) + marked(shown, ec < 0 ? -1 : ec + (scrolled ? 1 : 0)) + fg(C.red) + fit(err, Math.max(0, room - width(shown))) + RST);
    renderToast(); // e.g. a link that waits for this prompt
    return;
  }
  footX0.length = 0; footX1.length = 0; footKey.length = 0;
  // hints in display order, each with a tier (0 never dropped … 3 dropped first, see tierOf); when the row is too
  // narrow the lowest tier goes first, the last of a tier before the earlier ones, and the shown ones keep this order
  const ks: string[] = []; const ws: string[] = []; const ps: number[] = [];
  const k = (key: string, what: string, tier = -1): void => { ks.push(key); ws.push(what); ps.push(tier >= 0 ? tier : tierOf(key)); };
  k("?", "keys"); if (mode === "list" || mode === "transcript" || mode === "detail" || mode === "view") k("^K", "palette"); // everywhere Ctrl+K works
  // the view's own keys; a closing esc / q is held back to stay last
  let tk = ""; let tw = "";
  if (mode === "detail") { k("↑↓/jk", "scroll"); k("[/]", "prev/next event"); k("1-9", "open file"); k("tab", "select file"); k("o", "pager"); k("e", "edit"); k("z", "fold all"); k("w", "wrap"); k("v", "all in pager"); k("y", "copy"); tk = "esc"; tw = "back"; }
  else if (mode === "view") { tk = "esc"; tw = "back"; }
  else if (mode === "palette") { k("↵", "run"); k("→", "session actions"); k("tab", "scope"); tk = "esc"; tw = "close"; }
  else if (mode === "transcript") { k("↑↓/jk", "event"); k("↵", "details"); k("g/G", "top/end"); k("f", "follow"); k("t", "expand tools"); k("n/N", "subagents"); k("u", "parent"); k("s", "send"); k("R", "resume"); tk = "esc"; tw = "back"; }
  else if (S.tab === 0) { const cs = sessAt(S.sel); k("↵", cs && cs.host ? "remote" : "open"); /* a remote row (fleet): Enter says how to open it there */ k("/", "filter"); k("␣", "subagents"); k("p", "pin"); k("P", "pins"); k("F", "full-text"); k("h", "harness"); k("l", "live"); k("s", "send"); k("R", "resume"); k("x", "kill", 3); k("D", "trash", 3); }
  else if (S.tab === 1) { k("↵", "session"); k("s", "send"); k("x", "SIGTERM"); k("X", "SIGKILL", 3); k("a", "attach tmux"); k("P", "pins"); tk = "q"; tw = "quit"; }
  else { tk = "q"; tw = "quit"; }
  // feature hints ([key, label, tier?]) after the built-in ones (in a full-screen view they are all of its keys); a
  // feature's esc renames the closing one (e.g. "back to related")
  for (const f of H.footerHints) for (const kd of f(mode)) {
    const key = kd[0] ?? ""; const t = Number(kd[2] ?? "-1");
    if (key === "esc" && tk === "esc") { tw = kd[1] ?? ""; continue; }
    k(key, kd[1] ?? "", t >= 0 && t <= 3 ? t : -1);
  }
  if (tk) k(tk, tw, 0);
  const ft = fitHints(ks, ws, ps, W - 1); const gap = ft.gap; const last = ks.length - 1;
  const tail = ft.cut && tk !== "" && ft.show[last] === true;
  let hints = ""; let fx = 0;
  for (let i = 0; i < ks.length; i++) {
    if (!ft.show[i]) continue;
    const key = ks[i]; const what = ws[i];
    if (tail && i === last) { hints += fg(C.dim) + "…" + RST + " ".repeat(gap); fx += 1 + gap; }
    const w = width(key) + 1 + width(what);
    // clickable: the hint's key, when it maps to one keystroke
    const k0 = key === "/" ? key : key.split("/")[0]; // "/ filter" is a key itself, "n/N" two of them
    const act = key === "^K" ? "ctrl-k" : key === "↵" ? "enter" : key === "␣" ? " " : key === "esc" ? "esc" : key === "tab" ? "tab" : width(k0) === 1 && k0.length === 1 ? k0 : "";
    if (act) { footX0.push(fx); footX1.push(fx + w); footKey.push(act); }
    fx += w + gap;
    hints += fg(C.accent) + CSI + "1m" + key + RST + fg(C.sub) + " " + what + " ".repeat(gap) + RST;
  }
  if (ft.cut && !tail) hints += fg(C.dim) + "…" + RST;
  put(0, y, fitStyled(hints, W - 1) + CSI + "K");
  if (DBG.on && DBG.line) { const d = " " + fit(DBG.line, Math.min(width(DBG.line), W - 2)) + " "; put(W - width(d), y, bg(C.panel) + fg(C.dim) + d + RST); } // over the hints' tail
  renderToast();
}
// the input text with the character at an error's column (the CLI's caret) in red reverse; -1 or past the end = as is
export function marked(t: string, col: number): string {
  const cs = Array.from(t); if (col < 0 || col >= cs.length) return t;
  return cs.slice(0, col).join("") + fg(C.red) + CSI + "7m" + (cs[col] ?? "") + CSI + "27m" + fg(C.text) + cs.slice(col + 1).join("");
}
// a hint's tier when its provider names none: 0 "? keys" (never dropped), 1 the essentials (↵ open, / filter, esc / q),
// 3 the arrow keys everyone tries anyway, 2 the rest
export function tierOf(key: string): number {
  if (key === "?") return 0;
  if (key === "↵" || key === "/" || key === "esc" || key === "q") return 1;
  return key.startsWith("↑↓") || key.startsWith("←→") ? 3 : 2;
}
// the width of the shown hints (show[i]) with these gaps, plus "…" and a gap when cut
export function hintsWidth(ks: string[], ws: string[], show: boolean[], gap: number, cut: boolean): number {
  let w = 0; let m = 0;
  for (let i = 0; i < ks.length; i++) if (show[i]) { w += width(ks[i]) + 1 + width(ws[i]); m++; }
  return w + gap * Math.max(0, m - 1) + (cut ? 1 + (m ? gap : 0) : 0);
}
// the hints that fit the room (keys ks, labels ws, tiers ps): all with two-space gaps, else all with one-space gaps,
// else by tier (tier 0 always, then 1, 2, 3; within a tier the earlier first) as long as they fit, "…" marking the
// cut (? lists every key of the view). The shown ones keep their display order
export function fitHints(ks: string[], ws: string[], ps: number[], room: number): { show: boolean[]; gap: number; cut: boolean } {
  const all: boolean[] = []; for (let i = 0; i < ks.length; i++) all.push(true);
  if (hintsWidth(ks, ws, all, 2, false) <= room) return { show: all, gap: 2, cut: false };
  if (hintsWidth(ks, ws, all, 1, false) <= room) return { show: all, gap: 1, cut: false };
  const show: boolean[] = []; for (let i = 0; i < ks.length; i++) show.push(ps[i] === 0);
  let full = false;
  for (let t = 1; t <= 3 && !full; t++) for (let i = 0; i < ks.length && !full; i++) {
    if (ps[i] !== t) continue;
    show[i] = true;
    if (hintsWidth(ks, ws, show, 1, true) > room) { show[i] = false; full = true; }
  }
  return { show, gap: 1, cut: true };
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
