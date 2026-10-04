// agentglass — self-check for the watchdog heuristics: scriptc build src/features/watchdog.check.ts -o wdc && AGENTGLASS_NOTIFY=0 ./wdc
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Proc, Sess } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { type Obs, etimeSec, loopRun, pendingTool, toolCmds, approvalNote, approvalWait, stuckOf, alarmOf, approvalGuess, nextAlarm } from "./watchdog.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ev(kind: string, text: string): Ev { return { kind, text, ts: "", id: "", full: "" }; }
function pr(pid: number, ppid: number, etime: string, args: string): Proc { return { pid, ppid, cpu: 0, rss: 0, etime, tty: "??", args, h: "", cwd: "", tcpu: 0, trss: 0, kids: 0, sess: "" }; }
function flat(n: number, v: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(v); return a; }

eq("etime mm:ss", String(etimeSec("01:05")), "65");
eq("etime hh:mm:ss", String(etimeSec("02:00:01")), "7201");
eq("etime dd-hh:mm:ss", String(etimeSec("1-00:00:10")), "86410");
const call = ev("tool", "Bash\u0000ls");
eq("loop 3", String(loopRun([ev("user", "x"), call, ev("result", "a"), call, ev("result", "a"), call])), "3");
eq("loop broken", String(loopRun([call, ev("tool", "Bash\u0000pwd"), call])), "1");
eq("pending", pendingTool([ev("user", "x"), call]), "Bash");
eq("not pending", pendingTool([call, ev("result", "ok")]), "");

const kids = new Map<number, Proc[]>();
kids.set(1, [pr(2, 1, "02:00:00", "/Users/x/.caveman/bin/caveman-mcp"), pr(3, 1, "12:00", "/bin/zsh -c eval 'sleep 999'")]);
kids.set(3, [pr(4, 3, "12:00", "sleep 999")]);
const cmds = toolCmds(1, kids);
eq("cmds skip mcp", String(cmds.length), "1");
eq("cmd name", cmds.length ? cmds[0].name : "", "sleep");

const now = 1000000000;
const base: Obs = { now, mtime: now - 45000, busy: true, evs: [ev("user", "x"), call], cpu: flat(10, 0.2), cmds: [], subsActive: false };
eq("approval", approvalNote(base).slice(0, 12), "Bash pending");
eq("approval: idle", approvalNote({ now, mtime: base.mtime, busy: false, evs: base.evs, cpu: base.cpu, cmds: [], subsActive: false }), "");
// the agent's terminal says so (Gemini's tmux pane title "✋ Action Required"): Gemini logs the reply text but the tool
// call only once it ran, so the log looks like a finished turn and no tool is pending; idle, busy CPU, at once
eq("approval: title, at once", approvalNote({ now, mtime: now, busy: false, evs: [ev("assistant", "I will run mkdir x")], cpu: [], cmds: [], subsActive: false, asks: true }), "approval dialog open");
eq("approval: a harness that never asks (pi)", approvalNote({ now, mtime: base.mtime, busy: true, evs: base.evs, cpu: base.cpu, cmds: [], subsActive: false, noAsk: true }), "");
eq("approval: no title", approvalNote({ now, mtime: now, busy: false, evs: [ev("assistant", "I will run mkdir x")], cpu: [], cmds: [], subsActive: false, asks: false }), "");
// which alarm a look raises: approval wins over the turn that only looks finished
eq("alarm: approval over turn finished", alarmOf(true, false, true, true), "approval?");
eq("alarm: busy → idle", alarmOf(true, false, false, false), "turn finished");
eq("alarm: turn between looks", alarmOf(false, false, true, false), "turn finished");
eq("alarm: nothing new", alarmOf(false, false, false, false), "");
eq("alarm: still busy", alarmOf(true, true, true, false), "");
eq("alarm: approval while busy-looking", alarmOf(false, true, false, true), "approval?");
eq("approval: fresh cmd runs", approvalNote({ now, mtime: base.mtime, busy: true, evs: base.evs, cpu: base.cpu, cmds: [{ age: 30, name: "sleep" }], subsActive: false }), "");
eq("approval: too soon", approvalNote({ now, mtime: now - 5000, busy: true, evs: base.evs, cpu: base.cpu, cmds: [], subsActive: false }), "");
eq("stuck: long cmd", stuckOf({ now, mtime: base.mtime, busy: true, evs: base.evs, cpu: base.cpu, cmds: cmds, subsActive: false })[0] ?? "", "long cmd");
eq("stuck: loop", stuckOf({ now, mtime: now, busy: true, evs: [call, call, call], cpu: [], cmds: [], subsActive: false })[0] ?? "", "loop");
eq("stuck: stalled", stuckOf({ now, mtime: now - 600000, busy: true, evs: [ev("assistant", "hm")], cpu: flat(10, 0.3), cmds: [], subsActive: false })[0] ?? "", "stalled");
eq("stuck: spinning", stuckOf({ now, mtime: now - 200000, busy: false, evs: [ev("assistant", "hm")], cpu: flat(120, 95), cmds: [], subsActive: false })[0] ?? "", "spinning");
eq("stuck: fine", stuckOf({ now, mtime: now - 200000, busy: false, evs: [ev("assistant", "hm")], cpu: flat(60, 0), cmds: [], subsActive: false })[0] ?? "", "");
// state machine: a fake live codex session, turn start → complete raises ◆; opening its transcript clears it
const fs = newSess("codex", "fake", "/nonexistent/fake.jsonl", false);
fs.pid = 1; fs.tailSize = 0; fs.mtime = Date.now(); fs.evs = [ev("meta", "turn started")];
sessions.set(fs.path, fs); S.mode = "transcript";
eq("watchdog on onWatch", String(H.onWatch.length), "1"); // (onTick holds the ledger the rule metrics read)
const tick = (): void => { for (const f of H.onWatch) f(); };
tick(); eq("first sight records only", String(fs.attention), "false");
fs.evs = [ev("meta", "turn started"), ev("assistant", "done"), ev("meta", "turn complete")];
tick(); eq("turn finished raises", String(fs.attention), "true");
tick(); eq("stays raised", String(fs.attention), "true");
S.tv = { s: fs, evs: [], off: 0, ep: "", scroll: 0, follow: true, expand: false, lines: [], lw: 0, ln: 0, lexp: false, cur: 0, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1, from: -1 };
tick(); eq("transcript open clears", String(fs.attention), "false");
S.tv = null;
// a whole turn between two looks (a short answer, or an approval prompt the agent logs as a finished reply): never seen
// busy, but a new prompt in the log and idle now = the turn finished
fs.evs = [ev("meta", "turn started"), ev("assistant", "done"), ev("meta", "turn complete"), ev("user", "next"), ev("meta", "turn started"), ev("assistant", "ok"), ev("meta", "turn complete")];
tick(); eq("turn between two looks raises", String(fs.attention), "true");
S.tv = { s: fs, evs: [], off: 0, ep: "", scroll: 0, follow: true, expand: false, lines: [], lw: 0, ln: 0, lexp: false, cur: 0, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1, from: -1 };
tick(); S.tv = null;
tick(); eq("same prompt again: no new alarm", String(fs.attention), "false");
fs.evs = [ev("assistant", "ok"), ev("meta", "turn complete")]; // the prompt scrolled out of the tail window
tick(); eq("prompt out of the window: no alarm", String(fs.attention), "false");
fs.evs = [ev("user", "go"), ev("meta", "turn started"), call, call, call];
tick(); eq("loop flagged", fs.stuck, "loop");
// ! cycles every unacked attention row, critical (⚠) before degraded (◆), view order within one severity; a ◆ that never
// clears (a cost rule without ack) no longer hides the ⚠ rows behind it
const sev = [0, 1, 0, 2, 1, 0, 2];
eq("! from a plain row: the first critical", String(nextAlarm(sev, 0, 0)), "3");
eq("! critical → next critical", String(nextAlarm(sev, 3, 2)), "6");
eq("! last critical → first degraded", String(nextAlarm(sev, 6, 2)), "1");
eq("! degraded → next degraded", String(nextAlarm(sev, 1, 1)), "4");
eq("! last degraded wraps to the first critical", String(nextAlarm(sev, 4, 1)), "3");
eq("! a row acked since the jump keeps its place", String(nextAlarm([0, 0, 0, 2, 1, 0, 2], 1, 1)), "4");
eq("! only one item, on it: stays", String(nextAlarm([0, 1, 0], 1, 1)), "1");
eq("! none", String(nextAlarm([0, 0, 0], 1, 0)), "-1");
eq("! empty view", String(nextAlarm([], 0, 0)), "-1");
// the ! key: from a row the cursor was moved to, the most severe first; then on along the cycle, also past a row that
// was acked by looking at it
const rows: Sess[] = []; const flagsOf = ["", "◆", "", "⚠", "◆", "", "⚠"];
for (let i = 0; i < flagsOf.length; i++) { const r = newSess("claude", "r" + String(i), "/bang/" + String(i), false); r.attention = flagsOf[i] !== ""; r.stuck = flagsOf[i] === "⚠" ? "loop" : ""; rows.push(r); }
S.view = rows; S.mode = "list"; S.tab = 0; S.sel = 1;
const bang = (): number => { for (const f of H.keys) if (f("list", "!")) break; return S.sel; };
const seen: number[] = []; for (let i = 0; i < 6; i++) seen.push(bang());
eq("! from a ◆ row the cursor sits on: ⚠ first, then cycles", seen.join(","), "3,6,1,4,3,6");
S.sel = 3; eq("! on the first ⚠ (moved there): the next one", String(bang()), "6");
bang(); rows[1].attention = false; // jumped to row 1, then looking at it acked it
eq("! after an acked row: goes on after it", String(bang()), "4");
S.view = [];
// Gemini outside tmux: no title to read; idle reply text next to a call it has not logged yet may be an approval dialog
const gq: Obs = { now, mtime: now - 4000, busy: false, evs: [ev("user", "go"), ev("assistant", "I will create index.html")], cpu: [5, 0.4, 0.3], cmds: [], subsActive: false };
eq("guess: text, quiet 3 s", String(approvalGuess(gq, true)), "true");
eq("guess: harness without that shape (claude) or a title was read", String(approvalGuess(gq, false)), "false");
eq("guess: cpu busy", String(approvalGuess({ now, mtime: gq.mtime, busy: false, evs: gq.evs, cpu: [0.3, 3], cmds: [], subsActive: false }, true)), "false");
eq("guess: too few samples", String(approvalGuess({ now, mtime: gq.mtime, busy: false, evs: gq.evs, cpu: [0.3], cmds: [], subsActive: false }, true)), "false");
eq("guess: busy after text", String(approvalGuess({ now, mtime: gq.mtime, busy: true, evs: gq.evs, cpu: gq.cpu, cmds: [], subsActive: false }, true)), "false");
eq("guess: busy, thoughts only (no text, call not logged)", String(approvalGuess({ now, mtime: gq.mtime, busy: true, evs: [ev("user", "go"), ev("thinking", "plan")], cpu: gq.cpu, cmds: [], subsActive: false }, true)), "true");
eq("guess: idle after thoughts", String(approvalGuess({ now, mtime: gq.mtime, busy: false, evs: [ev("user", "go"), ev("thinking", "plan")], cpu: gq.cpu, cmds: [], subsActive: false }, true)), "false");
eq("guess: ends with an error note", String(approvalGuess({ now, mtime: gq.mtime, busy: false, evs: [ev("assistant", "x"), ev("meta", "[error] quota")], cpu: gq.cpu, cmds: [], subsActive: false }, true)), "false");
eq("guess: the title already tells", String(approvalGuess({ now, mtime: gq.mtime, busy: false, evs: gq.evs, cpu: gq.cpu, cmds: [], subsActive: false, asks: true }, true)), "false");
// Gemini outside tmux, a reply with only thoughts (its call is logged once it ran): log-silent with the tree quiet → the
// approval rule's value, marked likely; the title (tmux) path and every other shape stay as they were
const th: Obs = { now, mtime: now - 25000, busy: true, evs: [ev("user", "go"), ev("thinking", "I will run ls")], cpu: flat(10, 0.3), cmds: [], subsActive: false, asks: false, mayGuess: true };
const aw = (o: Obs): string => { const a = approvalWait(o, 2, 7, 5); return a.v < 0 ? "absent" : String(Math.round(a.v)) + " " + a.tool + " " + a.hint + " lv" + String(a.lv); };
eq("likely: thoughts only, quiet 25 s", aw(th), "25 approval dialog likely lv0");
eq("likely: note", approvalNote(th), "approval dialog pending 25s, cpu 0% · likely");
eq("likely: 10 s silent: value below the 20 s threshold", aw({ now, mtime: now - 10000, busy: true, evs: th.evs, cpu: th.cpu, cmds: [], subsActive: false, mayGuess: true }), "10 approval dialog likely lv0");
eq("likely: in tmux (title read, not asking): nothing", aw({ now, mtime: th.mtime, busy: true, evs: th.evs, cpu: th.cpu, cmds: [], subsActive: false, asks: false, mayGuess: false }), "absent");
eq("likely: in tmux, title asks: exact", aw({ now, mtime: th.mtime, busy: true, evs: th.evs, cpu: th.cpu, cmds: [], subsActive: false, asks: true, mayGuess: false }), "25 approval dialog  lv1");
eq("likely: cpu busy", aw({ now, mtime: th.mtime, busy: true, evs: th.evs, cpu: flat(10, 5), cmds: [], subsActive: false, mayGuess: true }), "absent");
eq("likely: too few samples", aw({ now, mtime: th.mtime, busy: true, evs: th.evs, cpu: flat(3, 0.3), cmds: [], subsActive: false, mayGuess: true }), "absent");
eq("likely: a tool command runs (approved)", aw({ now, mtime: th.mtime, busy: true, evs: th.evs, cpu: th.cpu, cmds: [{ age: 10, name: "sleep" }], subsActive: false, mayGuess: true }), "absent");
eq("likely: a subagent works", aw({ now, mtime: th.mtime, busy: true, evs: th.evs, cpu: th.cpu, cmds: [], subsActive: true, mayGuess: true }), "absent");
eq("likely: reply with text (idle): the turn_done guess, not this", aw({ now, mtime: th.mtime, busy: false, evs: [ev("user", "go"), ev("assistant", "I will run ls")], cpu: th.cpu, cmds: [], subsActive: false, mayGuess: true }), "absent");
// a bare reply (no thoughts at all): the prompt (or a result) is the newest event, the log has an empty reply after it
eq("likely: bare reply after the prompt", aw({ now, mtime: th.mtime, busy: true, evs: [ev("user", "go")], cpu: th.cpu, cmds: [], subsActive: false, mayGuess: true, bare: true }), "25 approval dialog likely lv0");
eq("likely: bare reply after a result", aw({ now, mtime: th.mtime, busy: true, evs: [ev("user", "go"), ev("tool", "list_directory\u0000app"), ev("result", "a")], cpu: th.cpu, cmds: [], subsActive: false, mayGuess: true, bare: true }), "25 approval dialog likely lv0");
eq("likely: prompt only, no reply yet (a slow model): nothing", aw({ now, mtime: th.mtime, busy: true, evs: [ev("user", "go")], cpu: th.cpu, cmds: [], subsActive: false, mayGuess: true }), "absent");
eq("likely: bare reply in tmux: nothing", aw({ now, mtime: th.mtime, busy: true, evs: [ev("user", "go")], cpu: th.cpu, cmds: [], subsActive: false, mayGuess: false, bare: true }), "absent");
eq("guess: bare reply", String(approvalGuess({ now, mtime: gq.mtime, busy: true, evs: [ev("user", "go")], cpu: gq.cpu, cmds: [], subsActive: false, bare: true }, true)), "true");
eq("likely: Gemini wrote the call (it ran) since", aw({ now, mtime: now - 1000, busy: true, evs: [ev("user", "go"), ev("thinking", "x"), ev("tool", "run_shell_command\u0000ls"), ev("result", "a.txt")], cpu: th.cpu, cmds: [], subsActive: false, mayGuess: true }), "absent");
console.log(bad ? bad + " failed" : "watchdog: all checks passed");
if (bad) process.exit(1);
