// agentglass — a tiny TUI to browse, watch and steer coding-agent sessions
// (Claude Code ~/.claude, Codex ~/.codex, fx ~/.fx). Built as a native binary with scriptc.
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { S, say } from "./state.ts";
import { H, tabAt, viewOf, screenOut, armed, backlog } from "./hooks.ts";
import { sessions, scan, buildView, probeLive } from "./model/sessions.ts";
import { procs, refreshProcs, refreshSlow } from "./model/procs.ts";
import { C, CSI } from "./ui/theme.ts";
import { buf, put, renderModal } from "./ui/screen.ts";
import { flush, resetFrame, partial } from "./ui/frame.ts";
import { renderHeader } from "./ui/header.ts";
import { renderFooter } from "./ui/footer.ts";
import { renderSessions } from "./ui/list.ts";
import { renderProcs } from "./ui/procs.ts";
import { renderTranscript } from "./ui/transcript.ts";
import { renderDetail } from "./ui/detail.ts";
import { renderHelp } from "./ui/help.ts";
import { tokens, keyName, onInput, onMouse } from "./input.ts";
import { enter, quit, termSize, focusOf } from "./term.ts";
import { type Job, DBG, fastDraw, newSched, levelOf, hotWhy, due, runJob, sleepFor, forceMs, debugLine, refreshMode } from "./sched.ts";
import { str } from "./util/json.ts";
import { bytes } from "./util/text.ts";
import { section } from "./util/config.ts";
import { L } from "./features/usage/record.ts";
import { indexing } from "./features/usage/ledger.ts";
import { replaying } from "./features/replay.ts";
import { agentHost, hostObj, cliError } from "./features/agentenv.ts";
import { compactHelp } from "./features/clihelp.ts";
// feature modules: import each once here for its side effects (they register on H)
import "./features/replay.ts";
import "./features/rules/cli.ts"; // before cli.ts: `rules --help` is its own
import "./features/cli.ts";
import "./features/cost-cli.ts";
import "./features/queries.ts";
import "./features/themes.ts";
import "./features/ticker.ts";
import "./features/watchdog.ts";
import "./features/usage/cache.ts";
import "./features/usage/stats.ts";
import "./features/query/ui.ts";
import "./features/callgraph/view.ts";
import "./features/triage/cli.ts";
import "./features/triage/view.ts";
import "./features/redact.ts";
import "./features/prices.ts";
import "./features/update.ts";
import "./features/otlp/export.ts";

function render(): void {
  S.dirty = false; S.animating = false; // spin() sets animating again while something on screen turns
  buf.length = 0;
  buf.push("\x1b[?2026h");
  renderHeader();
  const mode = S.mode; const pm = S.prevMode;
  const fv = mode === "view" || (pm === "view" && (mode === "help" || mode === "input" || mode === "confirm")) ? viewOf(S.fview) : null;
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
  buf.push("\x1b[?2026l");
  if (H.screenFilter.length) for (let i = 0; i < buf.length; i++) buf[i] = screenOut(buf[i] ?? "");
  flush(buf.join(""), (s: string) => { process.stdout.write(s); });
}
// the header row alone (a marquee step): a full frame costs ~3× more to build, and the marquee moves ~6 times a second
function renderTop(): void {
  buf.length = 0;
  buf.push("\x1b[?2026h");
  renderHeader();
  buf.push("\x1b[?2026l");
  if (H.screenFilter.length) for (let i = 0; i < buf.length; i++) buf[i] = screenOut(buf[i] ?? "");
  partial(buf.join(""), (s: string) => { process.stdout.write(s); });
}

// ── adaptive refresh: one self-rescheduling setTimeout loop over named jobs (src/sched.ts decides what is due) ──
const mode = refreshMode(process.env.AGENTGLASS_REFRESH ?? "", str(section("refresh")["mode"]));
const sc = newSched(mode.mode === "fixed", false, Date.now()); // SIGWINCH is not delivered by the runtime: size is polled
const act = { input: 0, focusOut: 0, grow: 0 };
let lastBuild = 0; let scanSig = ""; let watchSig = ""; let gen = 0;

function live(): boolean { return procs.length > 0; }
let why = "";
function relevel(now: number): void {
  const a = { now, input: act.input, focusOut: act.focusOut, replay: replaying(), grow: act.grow, indexing: indexing() || backlog(), live: live() };
  sc.lv = levelOf(a); sc.burst = a.indexing; if (DBG.on) why = sc.lv !== "hot" ? "" : hotWhy(a) + (a.indexing ? " " + bytes(L.total - L.done) + " left" : "");
}
function sizeJob(): void { if (termSize()) render(); } // a resize repaints at once, outside the render cap
function scanSum(): string { let n = 0; let z = 0; for (const s of sessions.values()) { n++; z += s.size; } return n + ":" + z; }
// attention/stuck of the watched (live) sessions: an alarm that changes must be drawn
function alarmSig(): string { let o = ""; for (const s of sessions.values()) if (s.pid > 0) o += s.path + (s.attention ? "!" : ".") + s.stuck + "|"; return o; }
function probe(): void { if (probeLive()) { act.grow = Date.now(); S.dirty = true; } }
function body(j: Job, now: number): () => void {
  if (j === "size") return sizeJob;
  if (j === "procs") return () => { refreshProcs(); S.dirty = true; }; // header CPU graph, Processes tab
  if (j === "scan") return () => { scan(); buildView(); const g = scanSum(); if (g !== scanSig) { scanSig = g; S.dirty = true; } };
  if (j === "slow") return () => { refreshSlow(); S.dirty = true; };
  if (j === "probe") return probe;
  if (j === "tick") return () => {
    if (S.mode === "list" && S.tab === 0) buildView();
    const v = L.ver; for (const f of H.onTick) f();
    if (L.ver !== v) S.dirty = true;
  };
  // alarm latency = the watch interval: probe first (the probe may sleep up to 1 s, the tail follows the stat), and a
  // changed alarm is drawn at once, also unfocused (rare, and the ◆ must not wait for the render cap)
  if (j === "watch") return () => { probe(); for (const f of H.onWatch) f(); const g = alarmSig(); if (g !== watchSig) { watchSig = g; render(); } };
  if (j === "fast") return () => {
    let d = false; for (const f of H.onFastTick) if (f()) d = true;
    let hd = false; for (const f of H.onHeaderTick) if (f()) hd = true;
    const w = fastDraw(d, hd, sc.unf); // armed animation draws at its own pace; unfocused: the 1/s cap
    if (w === "full") render(); else if (w === "header") renderTop(); else if (w === "dirty") S.dirty = true;
  };
  return () => { // render: build only when something changed, animates, a toast is up, or the clock texts are due
    const toast = S.toast !== "" && now - S.toastAt < S.toastMs + 500; // includes the frame that removes it
    if (!(sc.fixed || S.dirty || S.animating || toast || now - lastBuild >= forceMs(sc.lv))) return;
    lastBuild = now; S.frame++; render();
  };
}
function warnJob(m: string): void { say("err", m); S.dirty = true; }
function turn(): void {
  const now = Date.now();
  relevel(now);
  for (const j of due(sc, now, live(), armed())) runJob(sc, j, body(j, now), () => Date.now(), warnJob);
  relevel(Date.now()); // a job may have changed the level (a file grew, indexing finished)
  if (DBG.on) DBG.line = debugLine(sc, live(), armed(), why);
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
  resetFrame(); S.dirty = true;
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
  if (DBG.on) DBG.line = debugLine(sc, live(), armed(), why);
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
  if (!process.stdin.isTTY) { console.error("agentglass needs an interactive terminal"); process.exit(1); }
  enter();
  scan(); refreshProcs(); refreshSlow(); buildView();
  if (mode.err) say("warn", mode.err);
  DBG.on = process.env.AGENTGLASS_DEBUG_REFRESH === "1";
  render(); lastBuild = Date.now(); scanSig = scanSum();
  process.stdin.on("data", onData);
  process.on("SIGTERM", () => quit());
  loop();
}
main();
