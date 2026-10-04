// agentglass — named actions for the palette: every key binding of the ? help as an action that does what the key does
// SPDX-License-Identifier: Apache-2.0
import { S, type Mode } from "../../state.ts";
import { H, type Ctx, type Action, tabAt } from "../../hooks.ts";
import { current } from "../../model/sessions.ts";
import { onInput } from "../../input.ts";

// the origin snapshot (taken when the palette opens)
export function ctxNow(): Ctx {
  const tv = S.tv; const dv = S.dv;
  const sess = S.mode === "transcript" || S.mode === "detail" ? (tv ? tv.s : null) : S.tab === 0 ? current() : null;
  return { mode: S.mode, prevMode: S.prevMode, tab: S.tab, fview: S.fview, sel: S.sel, psel: S.psel, sess, ev: S.mode === "detail" && dv ? dv.idx : tv ? tv.cur : -1 };
}
function modeOf(m: string): Mode {
  return m === "transcript" ? "transcript" : m === "detail" ? "detail" : m === "view" ? "view" : m === "input" ? "input" : m === "confirm" ? "confirm" : m === "help" ? "help" : "list";
}
// back to the origin: mode, tab, selection (S.tv / S.dv were never touched)
export function restore(c: Ctx): void { S.mode = modeOf(c.mode); S.prevMode = modeOf(c.prevMode); S.tab = c.tab; S.fview = c.fview; S.sel = c.sel; S.psel = c.psel; }
// the key's own handler in the origin context: features get palette entries without exporting internals
export function replayKey(k: string): (c: Ctx) => void { return (c: Ctx): void => { restore(c); onInput(k); }; }

// contexts
export function inSessions(c: Ctx): boolean { return c.mode === "list" && c.tab === 0; }
export function inProcs(c: Ctx): boolean { return c.mode === "list" && c.tab === 1; }
export function inTranscript(c: Ctx): boolean { return c.mode === "transcript"; }
export function inDetail(c: Ctx): boolean { return c.mode === "detail"; }
export function inList(c: Ctx): boolean { return c.mode === "list"; }
export function tabNamed(c: Ctx, name: string): boolean { const t = tabAt(c.tab - 2); return c.mode === "list" && t !== null && t.name === name; }
function any(c: Ctx): boolean { return c.mode === "list" || c.mode === "transcript" || c.mode === "detail" || c.mode === "view"; }

// a key-backed action: keys = the display hint (the ? help's first key), press = the key name onInput gets
export function keyAction(id: string, group: string, title: string, keys: string, press: string, when: (c: Ctx) => boolean): Action {
  return { id, title, group, keys, when, run: replayKey(press) };
}
export function addActions(as: Action[]): void { for (const a of as) H.actions.push(a); }
const sessOrStats = (c: Ctx): boolean => inSessions(c) || tabNamed(c, "Stats");
addActions([
  keyAction("help.show", "Global", "Keyboard shortcuts (help)", "?", "?", any),
  keyAction("tab.next", "Global", "Next tab", "Tab", "tab", inList),
  { id: "app.quit", title: "Quit agentglass", group: "Global", keys: "q", when: inList, run: replayKey("q") },
  keyAction("session.open", "Session", "Open live transcript", "↵", "enter", inSessions),
  keyAction("session.fold", "Session", "Fold / unfold subagents", "space", " ", inSessions),
  keyAction("filter.edit", "Filter", "Filter…", "/", "/", sessOrStats),
  keyAction("filter.fulltext", "Filter", "Full-text search (ripgrep)…", "F", "F", inSessions),
  keyAction("filter.pin", "Filter", "Pin the filter (every tab, remembered)", "p", "p", sessOrStats),
  keyAction("pins.edit", "Filter", "Edit pins…", "P", "P", (c: Ctx): boolean => inSessions(c) || inProcs(c) || tabNamed(c, "Stats")),
  keyAction("triage.open", "Filter", "Triage: what is different about the filtered sessions", "t", "t", sessOrStats),
  keyAction("compare.mark", "Session", "Mark A / B for compare (again: unmark)", "m", "m", inSessions),
  keyAction("compare.open", "Session", "Compare A vs B (marks, previous run of the repo; Stats: previous period)", "C", "C", sessOrStats),
  keyAction("filter.harness", "Filter", "Cycle harness filter", "h", "h", inSessions),
  keyAction("filter.live", "Filter", "Live sessions only", "l", "l", inSessions),
  keyAction("filter.clear", "Filter", "Clear the filter (pins stay)", "esc", "esc", inSessions),
  keyAction("session.send", "Session", "Send prompt…", "s", "s", inSessions),
  keyAction("session.resume", "Session", "Resume interactively", "R", "R", inSessions),
  keyAction("session.kill", "Session", "SIGTERM the session's agent…", "x", "x", inSessions),
  keyAction("session.trash", "Session", "Move session to the trash…", "D", "D", inSessions),
  keyAction("session.copyId", "Session", "Copy session id", "y", "y", inSessions),
  keyAction("session.attention", "Session", "Next session needing attention", "!", "!", inSessions),
  keyAction("callgraph.open", "Session", "Call graph", "c", "c", (c: Ctx): boolean => inSessions(c) || inTranscript(c)),
  keyAction("proc.open", "Process", "Open linked session", "↵", "enter", inProcs),
  keyAction("proc.send", "Process", "Send prompt to the agent's tmux pane…", "s", "s", inProcs),
  keyAction("proc.attach", "Process", "Switch tmux client to the pane", "a", "a", inProcs),
  keyAction("proc.term", "Process", "SIGTERM the process…", "x", "x", inProcs),
  keyAction("proc.kill", "Process", "SIGKILL the process…", "X", "X", inProcs),
  keyAction("transcript.detail", "Transcript", "Event details", "↵", "enter", inTranscript),
  keyAction("transcript.follow", "Transcript", "Bottom + live follow", "G", "G", inTranscript),
  keyAction("transcript.expand", "Transcript", "Expand / collapse tool output", "t", "t", inTranscript),
  keyAction("transcript.nextSub", "Transcript", "Next subagent", "n", "n", inTranscript),
  keyAction("transcript.prevSub", "Transcript", "Previous subagent", "N", "N", inTranscript),
  keyAction("transcript.parent", "Transcript", "Up to parent session", "u", "u", inTranscript),
  keyAction("transcript.send", "Transcript", "Send prompt…", "s", "s", inTranscript),
  keyAction("transcript.resume", "Transcript", "Resume interactively", "R", "R", inTranscript),
  keyAction("transcript.replay", "Transcript", "Replay as a time-lapse", "P", "P", inTranscript),
  keyAction("transcript.back", "Transcript", "Back to the list", "esc", "esc", inTranscript),
  keyAction("detail.prev", "Detail", "Previous event", "[", "[", inDetail),
  keyAction("detail.next", "Detail", "Next event", "]", "]", inDetail),
  keyAction("detail.file1", "Detail", "Open the first referenced file in $PAGER", "1-9", "1", inDetail),
  keyAction("detail.selFile", "Detail", "Select the next file", "tab", "tab", inDetail),
  keyAction("detail.pager", "Detail", "Open the selected file in $PAGER", "o", "o", inDetail),
  keyAction("detail.editor", "Detail", "Open the selected file in $EDITOR", "e", "e", inDetail),
  keyAction("detail.fold", "Detail", "Expand / collapse long blocks", "z", "z", inDetail),
  keyAction("detail.wrap", "Detail", "Wrap / cut long code lines", "w", "w", inDetail),
  keyAction("detail.pagerAll", "Detail", "Whole detail in $PAGER", "v", "v", inDetail),
  keyAction("detail.copy", "Detail", "Copy detail to clipboard", "y", "y", inDetail),
  keyAction("detail.back", "Detail", "Back to the transcript", "esc", "esc", inDetail),
  keyAction("theme.cycle", "Theme", "Cycle color theme", "T", "T", (c: Ctx): boolean => c.mode === "list" || inTranscript(c) || inDetail(c)),
  keyAction("stats.today", "Stats", "Stats: today", "d", "d", (c: Ctx): boolean => tabNamed(c, "Stats")),
  keyAction("stats.week", "Stats", "Stats: last 7 days", "w", "w", (c: Ctx): boolean => tabNamed(c, "Stats")),
  keyAction("stats.budget", "Stats", "Stats: budget state", "B", "B", (c: Ctx): boolean => tabNamed(c, "Stats")),
]);
