// agentglass — self-check for the watchdog heuristics: scriptc build src/features/watchdog.check.ts -o wdc && AGENTGLASS_NOTIFY=0 ./wdc
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Proc } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { type Obs, etimeSec, loopRun, pendingTool, toolCmds, approvalNote, stuckOf, alarmOf } from "./watchdog.ts";

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
S.tv = { s: fs, evs: [], off: 0, ep: "", scroll: 0, follow: true, expand: false, lines: [], lw: 0, ln: 0, lexp: false, cur: 0, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1 };
tick(); eq("transcript open clears", String(fs.attention), "false");
S.tv = null;
// a whole turn between two looks (a short answer, or an approval prompt the agent logs as a finished reply): never seen
// busy, but a new prompt in the log and idle now = the turn finished
fs.evs = [ev("meta", "turn started"), ev("assistant", "done"), ev("meta", "turn complete"), ev("user", "next"), ev("meta", "turn started"), ev("assistant", "ok"), ev("meta", "turn complete")];
tick(); eq("turn between two looks raises", String(fs.attention), "true");
S.tv = { s: fs, evs: [], off: 0, ep: "", scroll: 0, follow: true, expand: false, lines: [], lw: 0, ln: 0, lexp: false, cur: 0, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1 };
tick(); S.tv = null;
tick(); eq("same prompt again: no new alarm", String(fs.attention), "false");
fs.evs = [ev("assistant", "ok"), ev("meta", "turn complete")]; // the prompt scrolled out of the tail window
tick(); eq("prompt out of the window: no alarm", String(fs.attention), "false");
fs.evs = [ev("user", "go"), ev("meta", "turn started"), call, call, call];
tick(); eq("loop flagged", fs.stuck, "loop");
console.log(bad ? bad + " failed" : "watchdog: all checks passed");
if (bad) process.exit(1);
