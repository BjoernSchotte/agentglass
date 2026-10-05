// agentglass — self-check for the rule engine: scriptc build src/features/rules/engine.check.ts -o ec && ./ec
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { newSess } from "../../model/types.ts";
import { type Obs, type MVal, type Cmd, absent, approvalNote, stuckOf } from "../detect.ts";
import { type RuleSet, loadRules, unitOf } from "./config.ts";
import { metricOf } from "./metrics.ts";
import { newRows } from "../usage/rows.ts";
import { type Trans, LOG, stepSession, flags, ackLook, unwatch, retain, stateOf, snapLevel, firing, watching } from "./engine.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ev(kind: string, text: string): Ev { return { kind, text, ts: "", id: "", full: "" }; }
function flat(n: number, v: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(v); return a; }
function states(ts: Trans[]): string { return ts.map((t: Trans) => t.rule + ":" + t.state).join(","); }
const BI = loadRules("", false);
const sess = newSess("claude", "e1", "/fx/e1.jsonl", false);
// values of every enabled rule for an observation (scope: all in scope)
function vals(rs: RuleSet, o: Obs, turnAt: number): Map<string, MVal> {
  const m = new Map<string, MVal>(); const memo = new Map<string, MVal>();
  for (const r of rs.rules) if (r.enabled) m.set(r.id, metricOf(r, sess, o, turnAt, newRows(), memo));
  return m;
}

// ── equivalence: old helpers vs built-in rules on the same observations ──
const now = 1000000000;
const call = ev("tool", "Bash\u0000ls");
const cmd700: Cmd[] = [{ age: 700, name: "sleep" }];
function O(ago: number, busy: boolean, evs: Ev[], cpu: number[], cmds: Cmd[], subs: boolean, asks: boolean): Obs { return { now, mtime: now - ago * 1000, busy, evs, cpu, cmds, subsActive: subs, asks }; }
const fx: Obs[] = [
  O(20, true, [ev("user", "x"), call], flat(10, 0.2), [], false, false), // pending exactly 20 s
  O(21, true, [ev("user", "x"), call], flat(10, 0.2), [], false, false),
  O(45, true, [call], flat(6, 0.2), [], false, false), // 6 samples
  O(45, true, [call], flat(7, 0.2), [], false, false), // 7 samples
  O(45, true, [call], flat(7, 0.2), [], true, false), // subagent active
  O(45, true, [call], flat(7, 0.2), [{ age: 30, name: "sleep" }], false, false), // fresh command
  O(45, true, [call], flat(7, 3), [], false, false), // cpu busy
  O(45, false, [call], flat(7, 0.2), [], false, false), // idle
  O(3, false, [ev("assistant", "I will")], [], [], false, true), // Gemini approval title
  O(480, true, [ev("assistant", "hm")], flat(10, 0.3), [], false, false), // silent exactly 480 s
  O(481, true, [ev("assistant", "hm")], flat(10, 0.3), [], false, false),
  O(600, true, [ev("assistant", "hm")], flat(10, 0.3), [{ age: 5, name: "x" }], false, false), // a command runs: not stalled
  O(0, true, [call, call], [], [], false, false), // loop 2
  O(0, true, [call, call, call], [], [], false, false), // loop 3
  O(45, true, [call, call, call], flat(10, 0.2), cmd700, false, false), // loop + long cmd
  O(45, true, [ev("user", "x"), call], flat(10, 0.2), cmd700, false, false), // long cmd (and approval absent: cmd old enough? no, 700 > 45+5)
  O(45, true, [ev("user", "x"), call], flat(10, 0.2), [{ age: 600, name: "sleep" }], false, false), // long cmd exactly 600
  O(45, true, [call, ev("result", "ok")], flat(10, 0.2), cmd700, false, false), // no call pending
  O(200, false, [ev("assistant", "hm")], flat(119, 95), [], false, false), // spinning 119 samples
  O(200, false, [ev("assistant", "hm")], flat(120, 95), [], false, false), // spinning 120
  O(180, false, [ev("assistant", "hm")], flat(120, 95), [], false, false), // silent exactly 180
  O(200, false, [ev("assistant", "hm")], flat(60, 0), [], false, false), // fine
  O(600, true, [ev("assistant", "hm")], flat(120, 95), [], false, false), // spinning, not stalled (cpu)
];
for (let i = 0; i < fx.length; i++) {
  const o = fx[i]; const p = "/eq/" + String(i);
  stepSession(BI, p, vals(BI, o, 0), now);
  const f = flags(BI, p);
  eq("equiv stuck #" + String(i), f[1] ?? "", stuckOf(o)[0] ?? "");
  const st = stateOf(p, "approval");
  eq("equiv approval #" + String(i), String(st !== null && st.level === 1), String(approvalNote(o) !== ""));
  eq("equiv attention #" + String(i), f[0] ?? "", approvalNote(o) !== "" ? "1" : "");
}
eq("fixtures ≥ 20", String(fx.length >= 20), "true");
eq("loop + long cmd (+ approval): every firing alert in the preview", firing(BI, newSess("claude", "x", "/eq/14", false)).map((a) => a.rule + ":" + a.severity).join(","), "approval:degraded,loop:critical,long-cmd:critical");

// ── waiting: first sight, fire once, resolve on busy, ack, re-fire ──
const W = "/w/1";
function idle(t: number): Obs { return { now: t, mtime: t, busy: false, evs: [], cpu: [], cmds: [], subsActive: false }; }
function busy(t: number): Obs { return { now: t, mtime: t, busy: true, evs: [], cpu: [], cmds: [], subsActive: false }; }
eq("first sight: nothing", states(stepSession(BI, W, vals(BI, idle(now), 0), now)), "");
eq("turn finished fires", states(stepSession(BI, W, vals(BI, idle(now), now), now)), "waiting:fire");
eq("still idle: no transition", states(stepSession(BI, W, vals(BI, idle(now + 1500), now), now + 1500)), "");
eq("attention", flags(BI, W)[0] ?? "", "1");
ackLook(BI, W);
eq("ack hides", flags(BI, W)[0] ?? "", "");
stepSession(BI, W, vals(BI, idle(now + 3000), now), now + 3000);
eq("stays acked while firing", flags(BI, W)[0] ?? "", "");
eq("a new turn re-fires", states(stepSession(BI, W, vals(BI, idle(now + 4500), now + 4000), now + 4500)), "waiting:resolve,waiting:fire");
eq("re-fire shows", flags(BI, W)[0] ?? "", "1");
eq("busy resolves", states(stepSession(BI, W, vals(BI, busy(now + 5000), 0), now + 5000)), "waiting:resolve");
// a guessed approval (Gemini outside tmux) is no new alert: the same firing turn says "turn finished · approval?"
const G = "/w/guess"; const gi = idle(now); gi.guess = true;
stepSession(BI, G, vals(BI, idle(now), now), now);
eq("guess: no new transition", states(stepSession(BI, G, vals(BI, gi, now), now + 1500)), "");
eq("guess: message", firing(BI, newSess("gemini", "g", G, false)).map((a) => a.message).join(","), "turn finished · approval?");
stepSession(BI, G, vals(BI, idle(now + 3000), now), now + 3000);
eq("guess gone: plain again", firing(BI, newSess("gemini", "g", G, false)).map((a) => a.message).join(","), "turn finished");
eq("idle again fires", states(stepSession(BI, W, vals(BI, idle(now + 6000), now + 6000), now + 6000)), "waiting:fire");

// ── waiting degraded 5m: rings at the threshold, not at the transition ──
const W5 = loadRules('{"rules":[{"id":"waiting","degraded":"5m"}]}', true);
const t0 = now + 100000;
eq("5m: transition, no fire", states(stepSession(W5, "/w/5", vals(W5, { now: t0, mtime: t0, busy: false, evs: [], cpu: [], cmds: [], subsActive: false }, t0), t0)), "");
eq("5m: 299 s, no fire", states(stepSession(W5, "/w/5", vals(W5, { now: t0 + 299000, mtime: t0, busy: false, evs: [], cpu: [], cmds: [], subsActive: false }, t0), t0 + 299000)), "");
eq("5m: 300 s fires", states(stepSession(W5, "/w/5", vals(W5, { now: t0 + 300000, mtime: t0, busy: false, evs: [], cpu: [], cmds: [], subsActive: false }, t0), t0 + 300000)), "waiting:fire");
eq("5m: once", states(stepSession(W5, "/w/5", vals(W5, { now: t0 + 301500, mtime: t0, busy: false, evs: [], cpu: [], cmds: [], subsActive: false }, t0), t0 + 301500)), "");

// ── for: an absent tick resets the pending timer ──
const FR = loadRules('{"builtins":false,"rules":[{"id":"cost","metric":"session_cost","degraded":5,"for":"30s"}]}', true);
function cost(c: number): Map<string, MVal> { const m = new Map<string, MVal>(); const v = absent(); if (c >= 0) { v.v = c; v.at = now; } m.set("cost", v); return m; }
const F = "/f/1"; let tr = "";
for (let t = 0; t <= 20; t += 2) tr += states(stepSession(FR, F, cost(6), now + t * 1000));
tr += states(stepSession(FR, F, cost(-1), now + 22000));
for (let t = 24; t <= 44; t += 2) tr += states(stepSession(FR, F, cost(6), now + t * 1000));
eq("for: interrupted → no fire", tr, "");
eq("for: 30 s after the restart fires", states(stepSession(FR, F, cost(6), now + 54000)), "cost:fire");

// ── escalate / deescalate / resolve ──
const ES = loadRules('{"builtins":false,"rules":[{"id":"cost","metric":"session_cost","degraded":5,"critical":20}]}', true);
let seq = "";
for (const c of [6, 21, 10, 0]) seq += states(stepSession(ES, "/e/1", cost(c), now)) + ";";
eq("escalation sequence", seq, "cost:fire;cost:escalate;cost:deescalate;cost:resolve;");
stepSession(ES, "/e/4", cost(6), now);
eq("resolve carries the last value", stepSession(ES, "/e/4", cost(-1), now).map((t: Trans) => t.state + " " + String(t.v)).join(","), "resolve 6");
stepSession(ES, "/e/2", cost(21), now);
eq("critical → stuck reason = id", flags(ES, "/e/2")[1] ?? "", "cost");

// ack: look holds until the alert resolves (spec §3, §5): an escalation stays hidden; the next firing shows again
const AK = loadRules('{"builtins":false,"rules":[{"id":"cost","metric":"session_cost","degraded":5,"critical":20,"ack":"look"}]}', true);
stepSession(AK, "/ak/1", cost(6), now); ackLook(AK, "/ak/1");
eq("acked escalate", states(stepSession(AK, "/ak/1", cost(21), now)), "cost:escalate");
eq("escalate keeps the ack", String(stateOf("/ak/1", "cost")?.acked) + " " + flags(AK, "/ak/1").join("|"), "true |");
stepSession(AK, "/ak/1", cost(0), now);
stepSession(AK, "/ak/1", cost(21), now);
eq("next firing shows", flags(AK, "/ak/1").join("|"), "|cost");

// ── per-harness copies: never both for one session ──
const PH = loadRules('{"rules":[{"id":"waiting","where":"harness is_not codex"},{"id":"waiting-codex","metric":"turn_done","where":"harness is codex","degraded":"5m","ack":"look"}]}', true);
eq("copies load clean", String(PH.diags.length), "0");
function scoped(rs: RuleSet, h: string): string {
  const s = newSess(h, "p", "/p/" + h, false); const m = new Map<string, MVal>(); const memo = new Map<string, MVal>();
  for (const r of rs.rules) { const f = r.wf; if (!r.enabled || (f && !f.sess.every((p) => p(s)))) continue; m.set(r.id, metricOf(r, s, { now, mtime: now, busy: false, evs: [], cpu: [], cmds: [], subsActive: false }, now - 400000, newRows(), memo)); }
  return states(stepSession(rs, s.path, m, now));
}
eq("codex: only the copy", scoped(PH, "codex"), "waiting-codex:fire");
eq("claude: only the built-in", scoped(PH, "claude"), "waiting:fire");

// ── unwatch / retain: silent ──
const n0 = LOG.length;
unwatch("/e/2");
eq("unwatch drops state", String(watching("/e/2")), "false");
eq("unwatch: no transitions", String(LOG.length), String(n0));
stepSession(ES, "/e/3", cost(21), now);
retain(new Set<string>(["other"]));
eq("retain drops removed ids", String(stateOf("/e/3", "cost") === null), "true");
for (let i = 0; i < 600; i++) stepSession(ES, "/log/x", cost(i % 2 === 0 ? 6 : 0), now + i);
eq("log keeps 500", String(LOG.length), "500");

// ── one-shot snapLevel ──
const SA = loadRules('{"rules":[{"id":"approval","for":"10s"}]}', true).rules[1];
const sv = (v: number, at: number): MVal => { const m = absent(); m.v = v; m.at = at; return m; };
eq("snap approval 25 s", String(snapLevel(SA, "duration", sv(25, 0), now)), "0");
eq("snap approval 31 s", String(snapLevel(SA, "duration", sv(31, 0), now)), "1");
const SC = loadRules('{"builtins":false,"rules":[{"id":"c","metric":"session_cost","degraded":5,"for":"1m"}]}', true).rules[0];
eq("snap cost 30 s", String(snapLevel(SC, unitOf("session_cost"), sv(6, now - 30000), now)), "0");
eq("snap cost 90 s", String(snapLevel(SC, unitOf("session_cost"), sv(6, now - 90000), now)), "1");
const S0 = loadRules('{"builtins":false,"rules":[{"id":"c","metric":"session_cost","degraded":5}]}', true).rules[0];
eq("snap for 0", String(snapLevel(S0, "usd", sv(6, now), now)), "1");
console.log(bad ? bad + " failed" : "rules engine: all checks passed");
if (bad) process.exit(1);
