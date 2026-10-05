// agentglass — a tiny TUI to browse, watch and steer coding-agent sessions
// (Claude Code ~/.claude, Codex ~/.codex, fx ~/.fx). Built as a native binary with scriptc.
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { S, say } from "./state.ts";
import { H, tabAt, viewOf, screenOut, armed, backlog } from "./hooks.ts";
import { sessions, scan, buildView, probeLive, sessAt, current } from "./model/sessions.ts";
import { procs, refreshProcs, refreshSlow } from "./model/procs.ts";
import { C, CSI } from "./ui/theme.ts";
import { buf, put, renderModal, clearBuf, bufRows, spinCells, spinGlyph } from "./ui/screen.ts";
import { flushRows, flushPart, flushSpin, resetFrame } from "./ui/frame.ts";
import { renderHeader, renderHeaderStep, statsKey } from "./ui/header.ts";
import { renderFooter } from "./ui/footer.ts";
import { renderSessions, listSig } from "./ui/list.ts";
import { renderProcs } from "./ui/procs.ts";
import { renderTranscript } from "./ui/transcript.ts";
import { renderDetail } from "./ui/detail.ts";
import { renderHelp } from "./ui/help.ts";
import { tokens, keyName, onInput, onMouse } from "./input.ts";
import { enter, quit, termSize, focusOf } from "./term.ts";
import { type Job, DBG, fastDraw, newSched, levelOf, hotWhy, due, runJob, sleepFor, forceMs, debugLine, refreshMode } from "./sched.ts";
import { str } from "./util/json.ts";
import { bytes } from "./util/text.ts";
import { section, configProblem } from "./util/config.ts";
import { L } from "./features/usage/record.ts";
import { indexing } from "./features/usage/ledger.ts";
import { replaying } from "./features/replay.ts";
import { agentHost, hostObj, cliError } from "./features/agentenv.ts";
import { compactHelp } from "./features/clihelp.ts";
import { debugExtras } from "./util/selfmem.ts";
import { WAKE_ALL } from "./util/fs.ts";
import { gitGen, gitTouches } from "./features/vcs/attrib.ts";
// feature modules: import each once here for its side effects (they register on H)
import "./features/replay.ts";
import "./features/rules/cli.ts"; // before cli.ts: `rules --help` is its own
import "./features/cli.ts";
import "./features/cost-cli.ts";
import "./features/prices-cli.ts";
import "./features/queries.ts";
import "./features/themes.ts";
import "./features/ticker.ts";
import "./features/watchdog.ts";
import "./features/usage/cache.ts";
import "./features/repos/ident.ts";
import "./features/usage/stats.ts";
import "./features/repos/tab.ts";
import "./features/compare/key.ts"; // before query/ui.ts: completion and the parser see the session key
import "./features/vcs/view.ts";
import "./features/query/ui.ts";
import "./features/callgraph/view.ts";
import "./features/related/view.ts"; // after the call graph: its view lets r fall through to here
import "./features/palette/actions.ts";
import "./features/palette/view.ts";
import "./features/palette/links.ts";
import "./features/palette/open.ts";
import "./features/palette/serve.ts";
import "./features/triage/cli.ts";
import "./features/triage/view.ts";
import "./features/compare/cli.ts";
import "./features/compare/marks.ts";
import "./features/compare/view.ts";
import "./features/redact.ts";
import "./features/prices.ts";
import "./features/update.ts";
import "./features/otlp/export.ts";

function render(): void {
  S.dirty = false; S.animating = false; headDirty = false; // spin() sets animating again while something on screen turns
  clearBuf();
  renderHeader();
  const mode = S.mode; const pm = S.prevMode;
  const fv = mode === "view" || (pm === "view" && (mode === "help" || mode === "input" || mode === "confirm" || mode === "palette")) ? viewOf(S.fview) : null;
  if (fv) { S.listH = 0; for (let y = 1; y < S.H - 1; y++) put(0, y, CSI + "2K"); fv.render(); }
  else if (mode === "detail" || (mode !== "list" && S.dv && pm === "detail")) { renderTranscript(); renderDetail(); }
  else if (mode === "transcript" || (mode !== "list" && S.tv && pm === "transcript")) renderTranscript();
  else if (S.tab === 0) renderSessions();
  else if (S.tab === 1) renderProcs();
  else { // feature tab: blank body, no built-in list mouse area
    S.listH = 0;
    for (let y = 1; y < S.H - 1; y++) put(0, y, CSI + "2K");
    const t = tabAt(S.tab - 2); if (t) t.render();
  }
  renderFooter();
  if (mode === "confirm") renderModal("confirm", [S.confirmText, "", "y  yes      n / esc  cancel"], C.yellow);
  if (mode === "help") renderHelp();
  for (const f of H.overlays) f();
  if (H.screenFilter.length) for (let i = 0; i < buf.length; i++) buf[i] = screenOut(buf[i] ?? "");
  flushRows(bufRows(), (s: string) => { process.stdout.write(s); }, spinCells(), spinGlyph()); // only the rows that changed
}
// the header row alone (a marquee step): a full frame costs ~3× more to build, and the marquee moves ~6 times a second
// step: a marquee step (only the flexible widget moved: the last header's layout is reused)
function renderTop(step: boolean): void {
  clearBuf();
  if (!step || !renderHeaderStep()) renderHeader();
  if (H.screenFilter.length) for (let i = 0; i < buf.length; i++) buf[i] = screenOut(buf[i] ?? "");
  flushPart(bufRows(), (s: string) => { process.stdout.write(s); });
}
// what the Sessions list shows (header stats and widgets, the rows, the preview: ui/list.ts listSig, the git line's
// attribution) without drawing it. Ledger ticks, process scans, live probes and the watchdog mark the list dirty only
// when it moved; the render job's clock frame is built only when it moved too (or every 5 s). Other tabs and views draw
// on every change as before.
function listShown(): boolean { return S.tab === 0 && S.mode === "list"; }
function headSig(): string { const o: string[] = [statsKey(), String(S.tab)]; for (const f of H.headerWidgets) o.push(f(S.W)); return o.join("\n"); }
function bodySig(): string { return String(gitGen()) + "/" + String(gitTouches()) + "\n" + listSig(!sc.unf); }
// once per turn at most (several jobs ask in one turn): true = the body moved (a frame); a moved header alone marks only
// that row (the cpu graph and the stats move every process scan). head = also look at the header: only the process
// scan and a ledger tick that booked something move it (an alarm count is drawn by the watch job's alarm frame)
const VIS = { head: "", body: "", turn: -1, hturn: -1, moved: false, unf: true };
let turnNo = 0; let wakeSeen = 0; let procsPass = 0; let headDirty = false;
function shownMoved(head: boolean): boolean {
  if (sc.unf && VIS.unf) return false; // unfocused: the jobs do not look; the render job does at its beat
  if (head && VIS.hturn !== turnNo) { VIS.hturn = turnNo; const h = headSig(); if (h !== VIS.head) { VIS.head = h; headDirty = true; } }
  if (VIS.turn === turnNo) return VIS.moved;
  VIS.turn = turnNo; const b = bodySig(); VIS.moved = b !== VIS.body; VIS.body = b;
  if (VIS.moved) headDirty = false; // the frame draws the header too
  return VIS.moved;
}
const SAFETY_MS = 5000; // a full Sessions frame at least this often, whatever the signature says

// ── adaptive refresh: one self-rescheduling setTimeout loop over named jobs (src/sched.ts decides what is due) ──
const mode = refreshMode(process.env.AGENTGLASS_REFRESH ?? "", str(section("refresh")["mode"]));
const sc = newSched(mode.mode === "fixed", false, Date.now()); // SIGWINCH is not delivered by the runtime: size is polled
const act = { input: 0, focusOut: 0, grow: 0 };
let lastBuild = 0; let scanSig = ""; let watchSig = ""; let gen = 0;

function live(): boolean { return procs.length > 0; }
let why = "";
function relevel(now: number): void {
  sc.fastMs = replaying() ? 50 : 150; // a replay steps at 50 ms; the marquee moves every 150 ms (ticker.ts)
  const a = { now, input: act.input, focusOut: act.focusOut, replay: replaying(), grow: act.grow, indexing: indexing() || backlog(), live: live() };
  sc.lv = levelOf(a); sc.burst = a.indexing; if (DBG.on) why = sc.lv !== "hot" ? "" : hotWhy(a) + (a.indexing ? " " + bytes(L.total - L.done) + " left" : "");
}
function sizeJob(): void { if (termSize()) render(); } // a resize repaints at once, outside the render cap
function scanSum(): string { let n = 0; let z = 0; for (const s of sessions.values()) { n++; z += s.size; } return n + ":" + z; }
// attention/stuck of the watched (live) sessions: an alarm that changes must be drawn
function alarmSig(): string { let o = ""; for (const s of sessions.values()) if (s.pid > 0) o += s.path + (s.attention ? "!" : ".") + s.stuck + "|"; return o; }
function probe(): void { if (probeLive()) { act.grow = Date.now(); if (!listShown() || shownMoved(false)) S.dirty = true; } }
function body(j: Job, now: number): () => void {
  if (j === "size") return sizeJob;
  if (j === "procs") return () => { procsPass++; refreshProcs(!sc.unf || procsPass % 2 === 0); /* unfocused: new pids looked for every other pass (3 s), the agents' cpu every pass (alarm samples) */ if (WAKE_ALL.at !== wakeSeen) { wakeSeen = WAKE_ALL.at; const x = sc.js.get("scan"); if (x) x.last = 0; } /* a new agent: scan at once (its log may be there already) */ if (!listShown() || shownMoved(true)) S.dirty = true; }; // header CPU graph, Processes tab, the preview's process line
  if (j === "scan") return () => { scan(); buildView(); const g = scanSum(); if (g !== scanSig) { scanSig = g; S.dirty = true; } };
  if (j === "slow") return () => { refreshSlow(); S.dirty = true; };
  if (j === "probe") return probe;
  if (j === "tick") return () => {
    if (S.mode === "list" && S.tab === 0) buildView();
    const v = L.ver; for (const f of H.onTick) f();
    if (L.ver !== v && (!listShown() || shownMoved(true))) S.dirty = true;
  };
  // alarm latency = the watch interval: probe first (the probe may sleep up to 1 s, the tail follows the stat), and a
  // changed alarm is drawn at once, also unfocused (rare, and the ◆ must not wait for the render cap)
  if (j === "watch") return () => { probe(); for (const f of H.onWatch) f(); const g = alarmSig(); if (g !== watchSig) { watchSig = g; render(); } else if (listShown() && shownMoved(false)) S.dirty = true; }; // the watchdog read tails: busy/idle glyphs
  if (j === "fast") return () => {
    let d = false; for (const f of H.onFastTick) if (f()) d = true;
    let hd = false; for (const f of H.onHeaderTick) if (f()) hd = true;
    const w = fastDraw(d, hd, sc.unf); // armed animation draws at its own pace; unfocused: the 1/s cap
    if (w === "full") render(); else if (w === "header") renderTop(true); else if (w === "dirty") S.dirty = true;
  };
  return () => { // render: build only when something changed, a toast is up, or the clock texts are due; else turn the spinners
    const toast = S.toast !== "" && now - S.toastAt < S.toastMs + 500; // includes the frame that removes it
    // unfocused (a tmux pane beside the focused one may still show it): a frame at the render job's 5 s beat when what
    // the list shows moved (looked at here only, not by every job), no spinner or header steps; focus-in draws at once
    if (sc.unf) { VIS.unf = false; const mv = listShown() && shownMoved(false); VIS.unf = true; if (S.dirty || toast || mv) { lastBuild = now; S.frame++; render(); } return; }
    const list = listShown();
    const clock = now - lastBuild >= forceMs(sc.lv) && (!list || now - lastBuild >= SAFETY_MS || shownMoved(false));
    if (sc.fixed || S.dirty || toast || clock || (S.animating && !list)) { lastBuild = now; S.frame++; render(); return; }
    if (headDirty) { headDirty = false; renderTop(false); } // the header row only
    if (S.animating) { S.frame++; flushSpin(spinGlyph(), (o: string) => { process.stdout.write(o); }); } // the spinner cells only
  };
}
function warnJob(m: string): void { say("err", m); S.dirty = true; }
function turn(): void {
  const now = Date.now(); turnNo++;
  relevel(now);
  for (const j of due(sc, now, live(), armed())) runJob(sc, j, body(j, now), () => Date.now(), warnJob);
  relevel(Date.now()); // a job may have changed the level (a file grew, indexing finished)
  if (DBG.on) DBG.line = debugLine(sc, live(), armed(), why, debugExtras());
}
// gen: a newer schedule (input woke the loop early) makes the older pending timer a no-op, so one chain runs
function schedule(ms: number): void { const g = ++gen; setTimeout(() => { if (g === gen) loop(); }, ms); }
function loop(): void {
  try { turn(); } catch (e) { /* the chain must survive whatever a turn throws */ }
  schedule(sleepFor(sc, Date.now(), live(), armed()));
}

function onFocus(f: string): void {
  const now = Date.now();
  if (f === "out") { act.focusOut = now; sc.unf = true; return; }
  act.focusOut = 0; act.input = now; sc.unf = false; // the user looks again: hot, full repaint (the terminal may have dropped frames)
  resetFrame(); S.dirty = true; VIS.body = ""; VIS.head = "";
  for (const j of ["size", "procs", "scan", "probe", "tick"]) { const x = sc.js.get(j); if (x) x.last = 0; } // a fresh look at once, not what the unfocused cadence left
}
function onData(d: Uint8Array): void {
  let user = false;
  for (const t of tokens(new TextDecoder("utf-8").decode(d))) {
    const f = focusOf(t);
    if (f) onFocus(f);
    else { user = true; if (t.startsWith("\x1b[<")) onMouse(t); else onInput(keyName(t)); }
  }
  const now = Date.now();
  if (user) {
    act.input = now; sc.unf = false; // a key or click means the user looks, even if the terminal's focus-in got lost
    const x = sc.js.get("size"); // a resize usually comes with input: check it, at most every 250 ms
    if (!x || now - x.last >= 250) runJob(sc, "size", termSize, () => Date.now(), warnJob);
  }
  const was = sc.lv; relevel(now);
  if (DBG.on) DBG.line = debugLine(sc, live(), armed(), why, debugExtras());
  render(); // typing latency is never capped
  if (sc.lv !== was) schedule(16); // the loop may sleep at a slower level: overdue jobs run on the next turn, not up to 1 s later
}

H.helpSections.push({ name: "refresh", ctx: "", keys: [
  ["mode", "adaptive: fast if busy, slow if idle, 1 fps hidden"], ["config.json", '"refresh": {"mode": "fixed"}: fixed 500 ms tick'],
  ["REFRESH=", "AGENTGLASS_REFRESH=adaptive|fixed (wins)"], ["DEBUG=1", "AGENTGLASS_DEBUG_REFRESH=1: level, costs in footer"],
  ["tmux", "set -g focus-events on: lets it see it is hidden"] ] });

function main(): void {
  // flags of every command (read from process.argv where they act): handlers never see them, so they find their command at
  // args[0] (agentglass --no-agent cost) and no command rejects them as unknown (triage --redact)
  const GLOBAL = ["--agent", "--no-agent", "--redact"];
  const args = process.argv.slice(2).filter((a: string) => GLOBAL.indexOf(a) < 0);
  agentHost(); // decided before any handler can warn (warnings are JSON lines inside an agent)
  for (const f of H.cli) if (f(args)) return;
  // inside a coding agent the TUI would hang its tool call (PTY shells pass the TTY check): what exists, as compact JSON
  if (agentHost().on) {
    const c = args[0] ?? ""; // no handler took it: a word here is a typo, not a request for the TUI
    if (c && !c.startsWith("-")) cliError("usage", "unknown command " + c, "agentglass --help lists the commands", 2);
    writeSync(1, compactHelp(hostObj(false)) + "\n"); process.exit(0);
  }
  tui();
}
let started = false;
function tui(): void {
  if (started) return; started = true;
  if (!process.stdin.isTTY) { console.error("agentglass needs an interactive terminal"); process.exit(1); }
  enter();
  scan(); refreshProcs(); refreshSlow(); buildView();
  for (const f of H.start) f();
  if (mode.err) say("warn", mode.err);
  const cp = configProblem(); if (cp) say("warn", cp);
  DBG.on = process.env.AGENTGLASS_DEBUG_REFRESH === "1";
  render(); lastBuild = Date.now(); scanSig = scanSum();
  process.stdin.on("data", onData);
  process.on("SIGTERM", () => quit());
  process.on("SIGINT", () => quit()); // raw mode: only a kill sends it; quit() releases the single-instance lock (no SIGHUP in scriptc 0.1.7: a stale lock is taken over)
  loop();
}
H.tui.push(tui);
H.redraw.push(() => { if (started) render(); });
main();
