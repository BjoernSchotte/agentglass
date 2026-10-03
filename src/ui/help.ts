// agentglass — the ? keyboard-shortcut popup
// SPDX-License-Identifier: Apache-2.0
import { width, fit, fillTo } from "../util/text.ts";
import { S, type HelpSec } from "../state.ts";
import { H } from "../hooks.ts";
import { C, CSI, RST, fg, bg } from "./theme.ts";
import { put } from "./screen.ts";
import { harnessIds } from "../harness/index.ts";

const HELP: HelpSec[] = [
  { name: "global", ctx: "", keys: [
    ["?", "show / hide this help"], ["Tab  1  2", "switch Sessions / Processes"], ["q  ctrl-c", "quit"] ] },
  { name: "sessions", ctx: "sessions", keys: [
    ["↑↓  j k", "move"], ["PgUp PgDn", "page"], ["g G  Home End", "first / last"],
    ["↵  →", "open live transcript"], ["space", "fold / unfold subagents"],
    ["/", "filter: repo is x · tool is Bash · cost > 2 · words (see filter)"], ["F", "full-text search (content ~ …, ripgrep)"],
    ["p  P", "pin the filter (every tab, remembered) · edit pins"], ["t", "triage: what is different about the filtered sessions"],
    ["h", "harness: all → " + harnessIds().join(" → ")], ["l", "live sessions only"], ["esc", "clear the filter (pins stay)"],
    ["s", "send prompt (tmux if live, else headless)"], ["R", "resume interactively"],
    ["x", "SIGTERM the session's agent"], ["D", "move session to the trash"], ["y", "copy session id"] ] },
  { name: "processes", ctx: "processes", keys: [
    ["↑↓  j k", "move"], ["g G  Home End", "first / last"], ["↵  →", "open linked session"],
    ["s", "send prompt to the agent's tmux pane"], ["a", "switch tmux client to the pane"],
    ["x", "SIGTERM (asks first)"], ["X", "SIGKILL (asks first)"], ["P", "edit pins (harness, repo, cwd, live apply here)"] ] },
  { name: "transcript", ctx: "transcript", keys: [
    ["↑↓  j k", "previous / next event (cursor ▌)"], ["↵  →  click", "drill into event: full call, result, diff, files"],
    ["wheel", "scroll lines"], ["PgUp PgDn  b ␣", "scroll a page"], ["g  Home", "top"],
    ["G  End  f", "bottom + live follow"], ["t", "expand / collapse tool output"],
    ["n  N", "next / previous subagent"], ["u", "up to parent session"],
    ["s", "send prompt"], ["R", "resume interactively"], ["esc  q  ←", "back to list"] ] },
  { name: "event details", ctx: "detail", keys: [
    ["↑↓  j k  wheel", "scroll"], ["[  ]  p n", "previous / next event"], ["1-9  click file", "open referenced file in $PAGER"],
    ["tab  o  e", "select file · open in pager · open in $EDITOR"], ["z  click ▸", "expand / collapse long blocks (>10 lines)"], ["w", "wrap / cut long code lines"], ["v", "whole detail in $PAGER"], ["y", "copy detail to clipboard"],
    ["esc  q  ←  right-click", "back to transcript"] ] },
  { name: "prompt & dialogs", ctx: "", keys: [
    ["↵", "submit"], ["esc", "cancel"], ["tab", "complete (filter and pins)"], ["ctrl-u  ctrl-w", "clear line / delete word"], ["y  n", "confirm / cancel dialog"] ] },
  { name: "mouse", ctx: "", keys: [
    ["wheel", "scroll list / transcript / details"], ["click", "select row · click again (or double-click) to open"],
    ["click preview row", "jump to that event / subagent"], ["click footer hint", "press that key"], ["right-click", "back"], ["click tab", "switch view"] ] },
];
// a feature tab can name itself as ctx to get its section highlighted
function helpContext(): string {
  const pm = S.prevMode;
  if (pm === "view") return S.fview;
  if (pm === "detail") return "detail";
  if (pm === "transcript") return "transcript";
  if (S.tab === 0) return "sessions";
  if (S.tab === 1) return "processes";
  const t = S.tab - 2;
  return t >= 0 && t < H.tabs.length ? H.tabs[t].name : "";
}
function helpLines(sec: HelpSec, w: number, ctx: string): string[] {
  const on = sec.ctx !== "" && sec.ctx === ctx;
  const out: string[] = [];
  out.push((on ? fg(C.accent) + CSI + "1m" + "▍" : fg(C.sub) + CSI + "1m" + " ") + fit(sec.name.toUpperCase() + (on ? "  · current view" : ""), w - 1) + RST);
  const kw = Math.min(18, Math.floor(w * 0.4));
  for (const kd of sec.keys) {
    out.push("  " + bg(C.sel) + fg(on ? C.accent : C.text) + CSI + "1m" + " " + fit(kd[0], kw - 2) + " " + RST + " " + fg(C.sub) + fit(kd[1], w - kw - 3) + RST);
  }
  out.push("");
  return out;
}
export function renderHelp(): void {
  const W = S.W; const Ht = S.H;
  const w = Math.min(W - 4, 120);
  const two = w >= 96;
  const cw1 = two ? Math.floor((w - 5) / 2) : w - 4;
  const ctx = helpContext();
  const blocks = HELP.concat(H.helpSections).map((sec) => helpLines(sec, cw1, ctx));
  let total = 0; for (const b of blocks) total += b.length;
  const left: string[] = []; const right: string[] = [];
  for (const b of blocks) { const tgt = two && left.length >= total / 2 ? right : left; for (const l of b) tgt.push(l); }
  const rows = Math.max(left.length, right.length);
  const h = Math.min(rows + 4, Ht - 3); // leave the footer row free for the drop shadow
  const view2 = h - 4;
  S.helpScroll = Math.max(0, Math.min(S.helpScroll, rows - view2));
  const hs = S.helpScroll;
  const x0 = Math.floor((W - w) / 2); const y0 = Math.max(1, Math.floor((Ht - h) / 2));
  const bc = fg(C.accent);
  const title = " ⌨ keyboard shortcuts ";
  put(x0, y0, bc + "╭─" + CSI + "1m" + fg(C.text) + title + RST + bc + "─".repeat(Math.max(0, w - 3 - width(title))) + "╮" + RST);
  put(x0, y0 + 1, bc + "│" + RST + bg(C.panel) + " ".repeat(w - 2) + RST + bc + "│" + RST);
  for (let r = 0; r < view2; r++) {
    const l = left[hs + r] ?? ""; const rr = right[hs + r] ?? "";
    const body = " " + l + fillTo(l, cw1) + (two ? " " + fg(C.line) + "│" + RST + bg(C.panel) + " " + rr + fillTo(rr, cw1) : "");
    put(x0, y0 + 2 + r, bc + "│" + RST + bg(C.panel) + body + RST + bg(C.panel) + fillTo(body, w - 2) + RST + bc + "│" + RST);
  }
  const more = rows > view2 ? "  j/k scroll " + (hs + 1) + "–" + Math.min(rows, hs + view2) + "/" + rows : "";
  const foot = " esc  ?  q  close" + more + " ";
  put(x0, y0 + h - 2, bc + "│" + RST + bg(C.panel) + fg(C.dim) + fit(foot, w - 2) + RST + bc + "│" + RST);
  put(x0, y0 + h - 1, bc + "╰" + "─".repeat(w - 2) + "╯" + RST);
  // drop shadow
  const sh = bg(C.shadow) + " " + RST;
  for (let r = 1; r < h; r++) put(x0 + w, y0 + r, sh);
  put(x0 + 1, y0 + h, bg(C.shadow) + " ".repeat(w) + RST);
}
