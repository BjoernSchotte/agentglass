// agentglass — self-check for fleet watch (spec 16): the remote lines, the viewer's tail, restarts, rotation, staleness,
// the desktop notification of critical transitions. scriptc build src/features/fleet/watch.check.ts -o wc && ./wc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, appendFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { parse, obj, str } from "../../util/json.ts";
import { type Sess, newSess } from "../../model/types.ts";
import type { SState } from "../../model/state.ts";
import type { HostCfg } from "./config.ts";
import type { LiveRow } from "./model.ts";
import { type WState, newWState, watchLines, alertLine, betterState, BEAT_MS, REPEAT_MS } from "./watch.ts";
import { type WatchEv, watchFeed, feedWatch, watchArgs, WATCH_MAX, WATCH_SNIPPET } from "./watchfeed.ts";
import { type RemoteHost, overlay, liveFresh, LIVE_FRESH_MS, newRemote } from "./hosts.ts";
import { alertOut, turnDue } from "./tui.ts";
import { spoolPath } from "./store.ts";
import { idleFeed } from "./ssh.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = join(HOME, "fleet"); process.env["AGENTGLASS_FLEET_DIR"] = dir; mkdirSync(dir, { recursive: true, mode: 0o700 });
function st(live: boolean, busy: boolean): SState { return { live, busy, attention: false, approval: false, stuck: "" }; }
function kinds(ls: string[]): string { const o: string[] = []; for (const l of ls) { const x = parse(l); if (x) o.push(Object.keys(x)[0] ?? ""); } return o.join(","); }

// twins (one session under two project dirs, one of them live): one state per key, the live one, so the stream does not
// flap between them every second
ok("of two states of a session the live one", betterState(st(true, false), st(false, false)) && !betterState(st(false, false), st(true, false)) && betterState(st(true, true), st(true, false)), "");
// ── the remote side: pure lines over stub states and a fake clock ──
const w: WState = newWState(); let t = 1000000;
let ls = watchLines(w, [{ key: "claude:a", st: st(true, true) }, { key: "claude:b", st: st(true, false) }], t);
ok("start: one live line per live session, a beat", kinds(ls) === "live,live,beat", kinds(ls));
t += 1000; ls = watchLines(w, [{ key: "claude:a", st: st(true, true) }, { key: "claude:b", st: st(true, false) }], t);
ok("nothing changed: nothing", ls.length === 0, kinds(ls));
t += 1000; ls = watchLines(w, [{ key: "claude:a", st: st(true, false) }, { key: "claude:b", st: st(true, false) }], t);
ok("busy → idle: a turn line and one live line", kinds(ls) === "turn,live" && ls[0]?.indexOf("claude:a") !== undefined && (ls[0] ?? "").indexOf("claude:a") > 0, ls.join(" "));
t += BEAT_MS; ls = watchLines(w, [{ key: "claude:a", st: st(true, false) }, { key: "claude:b", st: st(true, false) }], t);
ok("30 s: a beat", kinds(ls) === "beat", kinds(ls));
t += REPEAT_MS; ls = watchLines(w, [{ key: "claude:a", st: st(true, false) }, { key: "claude:b", st: st(true, false) }], t);
ok("300 s: every live state again", kinds(ls) === "live,live,beat", kinds(ls));
t += 1000; ls = watchLines(w, [{ key: "claude:a", st: st(true, false) }], t);
ok("a session gone: sent once as not live", kinds(ls) === "live" && (ls[0] ?? "").indexOf("\"live\":false") > 0, ls.join(" "));
const al = alertLine("claude:a", { rule: "stuck", severity: "critical", state: "fire", value: 3, threshold: 2, labels: [["team", "x"]], message: "stuck for 3 min" }, t);
const ao = obj((parse(al) ?? {})["alert"]);
ok("alert line", !!ao && str(ao["rule"]) === "stuck" && str(ao["severity"]) === "critical" && str(ao["key"]) === "claude:a", al);
ok("no content in a state line", ls.join("").indexOf("text") < 0 && ls.join("").indexOf("prompt") < 0, ls.join(""));

// ── the viewer: tail a stream file fed by the test (a stub spawn that does nothing) ──
const h: HostCfg = { name: "ws", ssh: "me@ws", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "", snapshot: true, watch: true };
const wa = watchArgs(h, true, "");
ok("watch argv", JSON.stringify(wa.slice(wa.indexOf("--") + 1)) === JSON.stringify(["me@ws", "'agentglass'", "'fleet'", "'watch'", "'--redact'"]), JSON.stringify(wa));
const bin = join(HOME, "bin"); mkdirSync(bin, { recursive: true }); const fake = join(bin, "ssh"); writeFileSync(fake, "#!/bin/sh\nexit 0\n"); chmodSync(fake, 0o755); process.env["AGENTGLASS_SSH"] = fake;
let spawned = 0; let pid = 0;
const wf = watchFeed(h, "ws", false, "", (cmd: string, args: string[]): number => { spawned++; pid = Number(execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim()); return pid; });
let now = Date.now();
ok("start", wf.start(now) && spawned === 1 && wf.running(), String(spawned));
const file = spoolPath("ws", "watch.jsonl");
appendFileSync(file, '{"hello":{"format":"agentglass-fleet/v1"}}\n{"live":{"key":"claude:a","at":1,"live":true,"busy":true,"attention":true,"approval":false,"stuck":""}}\n{"beat":1}\n');
let ev: WatchEv = wf.poll(now);
ok("poll: the rows", ev.rows.length === 1 && (ev.rows[0]?.key ?? "") === "claude:a" && (ev.rows[0]?.attention ?? false) && wf.beatAt() === now, JSON.stringify(ev.rows));
ev = wf.poll(now); ok("poll again: nothing new", ev.rows.length === 0, String(ev.rows.length));
appendFileSync(file, '{"alert":{"key":"claude:a","rule":"stuck","severity":"critical","state":"fire","message":"m","at":5}}\n{"turn":{"key":"claude:a","done":true,"at":6}}\n{"live":{"key":"claude:a","at":7,"live":tr'); // a partial last line
ev = wf.poll(now);
ok("alert and turn; the partial line waits", ev.alerts.length === 1 && ev.turns.length === 1 && ev.rows.length === 0, JSON.stringify(ev));
appendFileSync(file, 'ue,"busy":false,"attention":false,"approval":false,"stuck":""}}\n');
ev = wf.poll(now); ok("the line completed", ev.rows.length === 1 && !(ev.rows[0]?.busy ?? true), JSON.stringify(ev.rows));
// 300 lines: at most 256 per poll
let many = ""; for (let i = 0; i < 300; i++) many += '{"live":{"key":"claude:k' + String(i) + '","live":true}}\n'; appendFileSync(file, many);
const p1 = wf.poll(now).rows.length; const p2 = wf.poll(now).rows.length;
ok("≤ 256 lines per poll, the rest next", p1 === 256 && p2 === 44, String(p1) + "+" + String(p2));
// the stream ends: restart after a backoff
try { process.kill(pid, "SIGKILL"); } catch (e) { /* gone */ }
execFileSync("sleep", ["0.2"]); try { execFileSync("sh", ["-c", "wait"]); } catch (e) { /* none */ }
now = Date.now(); wf.poll(now);
ok("ended → not running", !wf.running(), "running");
ok("restart waits for the backoff", !wf.start(now), "started at once");
ok("restart after it", wf.start(now + 5001) && spawned === 2, String(spawned));
// 16 MB → killed, the next start truncates
writeFileSync(file, "x".repeat(WATCH_MAX + 10) + "\n");
wf.poll(Date.now());
ok("over 16 MB: stopped for a rotation", !wf.running(), "running");
ok("rotation: a fresh file on start", wf.start(Date.now()) && existsSync(file) && execFileSync("wc", ["-c", file], { encoding: "utf8" }).trim().startsWith("0"), "not truncated");
wf.stop();
ok("stop kills our pid", !wf.running(), "running");
try { process.kill(pid, "SIGKILL"); } catch (e) { /* gone */ }

// ── the real snippet: the stream ends when its viewer goes, however it went ──
const viewer = Number(execFileSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
const slowSsh = join(bin, "ssh-slow"); writeFileSync(slowSsh, "#!/bin/sh\necho '{\"beat\":1}'\nexec sleep 60\n"); chmodSync(slowSsh, 0o755);
const sp = Number(execFileSync("sh", ["-c", "sh -c \"$1\" sh \"$2\" ws2 \"$3\" \"$4\" >/dev/null 2>&1 & echo $!", "x", WATCH_SNIPPET, dir, String(viewer), slowSsh], { encoding: "utf8" }).trim());
execFileSync("sleep", ["0.5"]);
const kid = (): string => { try { return execFileSync("pgrep", ["-P", String(sp)], { encoding: "utf8" }).trim(); } catch (e) { return ""; } };
ok("stream running while its viewer is", kid() !== "", "no child");
try { process.kill(viewer, "SIGKILL"); } catch (e) { /* gone */ }
let gone = false; for (let i = 0; i < 70 && !gone; i++) { execFileSync("sleep", ["0.1"]); let alive = true; try { process.kill(sp, 0); } catch (e) { alive = false; } gone = !alive || kid() === ""; }
ok("the viewer gone: the stream ends within ~5 s", gone, kid());
try { process.kill(sp, "SIGKILL"); } catch (e) { /* gone */ }

// ── the host's rows: the stream's states while it beats, the report's after 90 s without a beat ──
const s = newSess("claude", "a", "@ws/claude:a", false); s.host = "ws"; s.rlive = false;
const rh: RemoteHost = newRemote(h, idleFeed("ssh")); rh.rows = [s];
const n0 = Date.now(); rh.beatAt = n0;
rh.live.set("claude:a", { key: "claude:a", at: n0, live: true, busy: true, attention: true, approval: false, stuck: "", alerts: [] });
ok("overlay: live and attention from the stream", overlay(rh, n0) && s.rlive && s.attention && liveFresh(rh, n0), String(s.rlive));
ok("90 s without a beat: not live", overlay(rh, n0 + LIVE_FRESH_MS + 1) && !s.rlive && !s.attention && !liveFresh(rh, n0 + LIVE_FRESH_MS + 1), String(s.rlive));
// ── critical → desktop once; a repeat does not; degraded only toasts ──
const seen = new Set<string>();
const a1 = { key: "claude:a", rule: "stuck", severity: "critical", state: "fire", message: "m", at: 5 };
ok("critical fire → notify", alertOut("ws", "t", a1, seen).notify, "");
ok("the same transition again → no second notify", !alertOut("ws", "t", a1, seen).notify, "");
ok("degraded → toast only", !alertOut("ws", "t", { key: "claude:a", rule: "x", severity: "degraded", state: "fire", message: "m", at: 6 }, seen).notify, "");
ok("resolve → toast only", !alertOut("ws", "t", { key: "claude:a", rule: "stuck", severity: "critical", state: "resolve", message: "m", at: 7 }, seen).notify, "");
// ── a turn end: the next snapshot within 5 s, at most one per 10 s ──
ok("turn: due in 5 s", turnDue(n0 + 60000, n0, 0) === n0 + 5000, String(turnDue(n0 + 60000, n0, 0) - n0));
ok("turn: 10 s after the last", turnDue(n0 + 60000, n0, n0 + 2000) === n0 + 12000, String(turnDue(n0 + 60000, n0, n0 + 2000) - n0));
ok("turn: never later than already due", turnDue(n0 + 1000, n0, 0) === n0 + 1000, "");
ok("feedWatch ignores garbage", !feedWatch({ rows: [], alerts: [], turns: [] }, "not json", 0), "");

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("fleet watch: all checks passed");
