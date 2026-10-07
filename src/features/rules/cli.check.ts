// agentglass — self-check for `rules check|defaults` and the --watch engine step: scriptc build src/features/rules/cli.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../../model/types.ts";
import { newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { loadRules } from "./config.ts";
import { checkText, defaultsText, thrText } from "./cli.ts";
import { type Obs, watchStep } from "../watchdog.ts";
import { firing } from "./engine.ts";
import { H } from "../../hooks.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ev(kind: string, text: string): Ev { return { kind, text, ts: "", id: "", full: "" }; }

const e = checkText('{"rules":[\n {"id":"x","metric":"nope","degraded":1},\n {"id":"y","metric":"session_cost","degraded":1,"colour":1}\n]}', true, true);
eq("error + warning: exit 2", String(e.code), "2");
eq("error line", e.lines.filter((l: string) => l.startsWith("rules.json:")).join(" | "), "rules.json:2:21: x: unknown metric \"nope\"; one of turn_done, approval_wait, repeat_run, command_age, stalled, spinning, session_cost, session_tokens, tool_calls, tool_errors, tool_error_rate, contention, contention_family — rule disabled | rules.json:3:49: y: warning: unknown field \"colour\" (ignored)");
eq("json diags", e.json.diagnostics.map((d) => d.severity).join(","), "error,warning");
eq("warnings only: exit 1", String(checkText('{"rules":[{"id":"y","metric":"session_cost","degraded":1,"colour":1}]}', true, true).code), "1");
eq("clean: exit 0", String(checkText('{"rules":[{"id":"approval","critical":"2m"}]}', true, true).code), "0");
eq("missing: exit 0", String(checkText("", false, false).code), "0");
eq("syntax: exit 2", String(checkText('{"rules":[}', true, true).code), "2");
// a file-level problem has no rule part: file:line:col: message (never "-:")
eq("syntax line", checkText('{"rules":[{"id":"x",}]}', true, true).lines.filter((l: string) => l.startsWith("rules.json:")).join(" | "), "rules.json:1:21: syntax error: expected a quoted key — using built-in rules");
eq("file-level line", checkText('{"rules":5}', true, true).lines.filter((l: string) => l.startsWith("rules.json:")).join(" | "), "rules.json:1:10: rules must be an array");
const unread = checkText("", true, true, "permission denied");
eq("unreadable: exit 2", String(unread.code), "2");
eq("unreadable: line", unread.lines.filter((l: string) => l.startsWith("rules.json:")).join(" | "), "rules.json:1:1: cannot read the file (permission denied) — using built-in rules");
eq("unsafe command: exit 2", String(checkText('{"notify":{"command":["/bin/true"]}}', true, false).code), "2");
const ap = checkText('{"rules":[{"id":"approval","critical":"2m"}]}', true, true).lines.filter((l: string) => l.indexOf("approval_wait") >= 0)[0] ?? "";
eq("effective rule line", ap.replace(/\s+/g, " ").trim(), "approval approval_wait > 20s/2m");
eq("thrText", [thrText("duration", 600), thrText("duration", 20), thrText("duration", 3600), thrText("ratio", 0.3), thrText("usd", 5)].join(","), "10m,20s,1h,30%,5");
// defaults round-trip to the same built-ins, zero diagnostics
const d = loadRules(defaultsText(false), true);
eq("defaults: no diags", d.diags.map((x) => x.msg).join("|"), "");
const b = loadRules("", false);
const sig = (rs: typeof b): string => rs.rules.map((r) => [r.id, r.metric, r.op, String(r.deg), String(r.crit), String(r.hasDeg), String(r.hasCrit), r.ack, String(r.notify), r.message, r.reason, r.prefix].join(":")).join("\n");
eq("defaults round-trip", sig(d), sig(b));
const x = loadRules(defaultsText(true), true);
eq("examples: no diags", x.diags.map((y) => y.msg).join("|"), "");
eq("examples: disabled", x.rules.filter((r) => !r.enabled).length + " of " + String(x.rules.length), "7 of 13");

// --watch: a synthetic stalled session gives one critical fire on the first step
const s = newSess("claude", "st1", "/fx/st1.jsonl", false);
s.pid = 4242; s.mtime = Date.now() - 540000; s.evs = [ev("user", "go"), ev("assistant", "thinking about it")];
sessions.set(s.path, s);
const cpu: number[] = []; for (let i = 0; i < 10; i++) cpu.push(0.2);
const o: Obs = { now: Date.now(), mtime: s.mtime, busy: true, evs: s.evs, cpu, cmds: [], subsActive: false, asks: false };
const ts = watchStep(s, o, b, Date.now());
eq("watch: stalled fires", ts.map((t) => t.rule + ":" + t.state + ":" + String(t.to)).join(","), "stalled:fire:2");
eq("watch: alert text", firing(b, s).map((a) => a.severity + " " + a.message.slice(0, 15)).join(","), "critical no log activity");
eq("watch: second step quiet", String(watchStep(s, o, b, Date.now()).length), "0");
// --watch / TUI: Gemini outside tmux (no title to read) holds a finished turn's alert until the quiet window is decided —
// quiet at once, or 2 more looks (≈ 3 s at the 1.5 s cadence) — so the bell, notification, command and --watch line
// carry the "approval?" guess; other harnesses fire on the first idle look
const gs = newSess("gemini", "gm1", "/fx/gm1.json", false); gs.pid = 4343; sessions.set(gs.path, gs);
const gobs = (busy: boolean, may: boolean, guess: boolean): Obs => ({ now: Date.now(), mtime: Date.now(), busy, evs: [ev("user", "go"), ev("assistant", "I will create index.html")], cpu: [5, 5], cmds: [], subsActive: false, asks: false, mayGuess: may, guess });
const tsOf = (t: ReturnType<typeof watchStep>): string => t.filter((x) => x.rule === "waiting").map((x) => x.state).join(",");
const msgOf = (): string => firing(b, gs).filter((a) => a.rule === "waiting").map((a) => a.message).join(",");
let gt = Date.now();
const step = (so: Sess, o2: Obs): ReturnType<typeof watchStep> => { gt = gt + 1500; return watchStep(so, o2, b, gt); };
watchStep(gs, gobs(true, true, false), b, gt);
eq("gemini: turn end, not quiet yet: held", tsOf(step(gs, gobs(false, true, false))), "");
eq("gemini: quiet on the next look: fires with the hint", tsOf(step(gs, gobs(false, true, true))), "fire");
eq("gemini: fired message", msgOf(), "turn finished · approval?");
step(gs, gobs(true, true, false));
eq("gemini: never quiet: held 1", tsOf(step(gs, gobs(false, true, false))), "");
eq("gemini: never quiet: held 2", tsOf(step(gs, gobs(false, true, false))), "");
eq("gemini: never quiet: fires after 2 more looks", tsOf(step(gs, gobs(false, true, false))), "fire");
eq("gemini: plain message", msgOf(), "turn finished");
step(gs, gobs(true, true, false));
eq("gemini: quiet at once: fires at once", tsOf(step(gs, gobs(false, true, true))), "fire");
const cs = newSess("claude", "cl1", "/fx/cl1.jsonl", false); cs.pid = 4444; sessions.set(cs.path, cs);
watchStep(cs, gobs(true, false, false), b, gt);
eq("claude: fires on the first idle look", watchStep(cs, gobs(false, false, false), b, gt + 1500).filter((x) => x.rule === "waiting").map((x) => x.state).join(","), "fire");
// Gemini outside tmux, thoughts only (no text, no call): log-silent > 20 s with the tree quiet raises the approval rule
// (◆, bell/notify/--watch like the exact title) marked likely; < 20 s nothing; Gemini writes again → it resolves
const ls = newSess("gemini", "gm2", "/fx/gm2.json", false); ls.pid = 4545; sessions.set(ls.path, ls);
const quiet: number[] = []; for (let i = 0; i < 10; i++) quiet.push(0.3);
const tob = (t: number, silent: number, may: boolean, last: Ev): Obs => ({ now: t, mtime: t - silent * 1000, busy: last.kind !== "assistant", evs: [ev("user", "go"), last], cpu: quiet, cmds: [], subsActive: false, asks: false, mayGuess: may, guess: may });
const apOf = (t: ReturnType<typeof watchStep>): string => t.filter((x) => x.rule === "approval").map((x) => x.state).join(",");
let lt = Date.now();
const think = ev("thinking", "I will run ls");
eq("likely: 10 s quiet: nothing yet", apOf(watchStep(ls, tob(lt, 10, true, think), b, lt)), "");
lt += 1500; eq("likely: 19 s: nothing yet", apOf(watchStep(ls, tob(lt, 19, true, think), b, lt)), "");
lt += 1500; eq("likely: 21 s: fires", apOf(watchStep(ls, tob(lt, 21, true, think), b, lt)), "fire");
eq("likely: message", firing(b, ls).filter((a) => a.rule === "approval").map((a) => a.severity + " " + a.message).join(","), "degraded approval dialog pending 21s, cpu 0% · likely");
const pv = (): string => { const o2: string[] = []; for (const f of H.previewSections) for (const l of f(ls, 100)) o2.push(l.replace(/\x1b\[[0-9;]*m/g, "")); return o2.join("|"); };
eq("likely: preview line", pv(), "◆ approval? (likely) · approval dialog pending 21s, cpu 0%");
eq("likely: ◆ not ⚠", firing(b, ls).filter((a) => a.level === 2).length + "", "0");
lt += 1500; eq("likely: Gemini writes (text): resolves", apOf(watchStep(ls, tob(lt, 0, true, ev("assistant", "done")), b, lt)), "resolve");
lt += 1500; watchStep(ls, tob(lt, 0, true, think), b, lt);
lt += 1500; eq("likely: fires again", apOf(watchStep(ls, tob(lt, 22, true, think), b, lt)), "fire");
lt += 1500; eq("likely: Gemini writes another thought: resolves", apOf(watchStep(ls, tob(lt, 0, true, ev("thinking", "still")), b, lt)), "resolve");
// the same with a bare reply (no thoughts at all): the prompt stays the newest event
const bs = newSess("gemini", "gm5", "/fx/gm5.json", false); bs.pid = 4848; sessions.set(bs.path, bs);
const bob = (t: number, silent: number, bare: boolean): Obs => ({ now: t, mtime: t - silent * 1000, busy: true, evs: [ev("user", "go")], cpu: quiet, cmds: [], subsActive: false, asks: false, mayGuess: true, bare });
lt += 1500; eq("bare: 15 s: nothing", apOf(watchStep(bs, bob(lt, 15, true), b, lt)), "");
lt += 1500; eq("bare: 21 s: fires", apOf(watchStep(bs, bob(lt, 21, true), b, lt)), "fire");
lt += 1500; eq("bare: its calls arrive: resolves", apOf(watchStep(bs, { now: lt, mtime: lt, busy: true, evs: [ev("user", "go"), ev("tool", "write_file\u0000a"), ev("result", "ok")], cpu: quiet, cmds: [], subsActive: false, asks: false, mayGuess: true, bare: false }, b, lt)), "resolve");
const ts2 = newSess("gemini", "gm3", "/fx/gm3.json", false); ts2.pid = 4646; sessions.set(ts2.path, ts2);
lt += 1500; eq("likely: in tmux (title read): never", apOf(watchStep(ts2, tob(lt, 60, false, think), b, lt)), "");
// the threshold is the approval rule's: degraded "30s" waits 30 s
const b30 = loadRules('{"rules":[{"id":"approval","degraded":"30s"}]}', true);
const ls30 = newSess("gemini", "gm4", "/fx/gm4.json", false); ls30.pid = 4747; sessions.set(ls30.path, ls30);
lt += 1500; eq("likely: degraded 30s: 25 s nothing", apOf(watchStep(ls30, tob(lt, 25, true, think), b30, lt)), "");
lt += 1500; eq("likely: degraded 30s: 31 s fires", apOf(watchStep(ls30, tob(lt, 31, true, think), b30, lt)), "fire");
console.log(bad ? bad + " failed" : "rules cli: all checks passed");
if (bad) process.exit(1);
