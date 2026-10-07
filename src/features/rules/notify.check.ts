// agentglass — self-check for the notify command: scriptc build src/features/rules/notify.check.ts -o nc && ./nc
// SPDX-License-Identifier: Apache-2.0
// The commands are tiny sh scripts: sh is the program, the alert never passes through a shell string.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { newSess } from "../../model/types.ts";
import { readText, run } from "../../util/fs.ts";
import { absent } from "../detect.ts";
import { type NotifyCfg, type Rule, loadRules, defaultNotify } from "./config.ts";
import type { Trans } from "./engine.ts";
import { CMD, IO, alertJson, argvFor, cmdSubs, cmdEnv, runCommand, onTrans, throttleKey } from "./notify.ts";
import { fileSafe, withSafety } from "./state.ts";
import { applyMeta } from "../../hooks.ts";
import "../redact.ts"; // --redact (the check env) fakes titles and projects in the session model

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-notify-check-" + String(Date.now()); mkdirSync(dir, { recursive: true });
function script(name: string, body: string): string { const p = dir + "/" + name; writeFileSync(p, "#!/bin/sh\n" + body + "\n"); chmodSync(p, 0o700); return p; }
const rs = loadRules("", false); const ap = rs.rules[1];
const s = newSess("claude", "n1", "/n/1", false); s.cwd = "/w/secret-project"; s.title = "the real title keepme-not"; applyMeta(s);
const tr = (state: string): Trans => ({ at: 1000000, path: s.path, rule: "approval", from: 0, to: 1, state, v: 42, thr: 20 });
const v = absent(); v.v = 42; v.tool = "Bash";
const cfg = (cmd: string[], on: string[]): NotifyCfg => { const c = defaultNotify(); c.command = cmd; c.on = on; return c; };
const toasts: string[] = []; IO.toast = (m: string): void => { toasts.push(m); };
IO.bell = (): void => { /* quiet */ };

// agent-wait: host-wide metrics notify once per (rule, host): three sessions in contention ring one bell
{
  let bells = 0; IO.bell = (): void => { bells++; };
  const cr = loadRules('{"rules":[{"id":"contention","enabled":true}]}', true).rules.filter((r: Rule) => r.id === "contention")[0] ?? ap;
  const cv = absent(); cv.v = 3; cv.cmd = "pnpm test ×2, tsc";
  for (const id of ["h1", "h2", "h3"]) { const x = newSess("claude", id, "/h/" + id, false); onTrans(x, cr, { at: 5000000, path: x.path, rule: "contention", from: 0, to: 1, state: "fire", v: 3, thr: 3 }, false, false, false, defaultNotify(), cv, "3 heavy commands running", 0); }
  eq("contention: one bell for three sessions", String(bells), "1");
  // a fourth session joins minutes later (past the throttle): still the same contention, no new notification
  const x4 = newSess("claude", "h4", "/h/h4", false); onTrans(x4, cr, { at: 5000000 + 600000, path: x4.path, rule: "contention", from: 0, to: 1, state: "fire", v: 4, thr: 3 }, false, false, false, defaultNotify(), cv, "4 heavy", 0);
  eq("contention: a later session joins quietly", String(bells), "1");
  for (const id of ["h1", "h2", "h3", "h4"]) onTrans(newSess("claude", id, "/h/" + id, false), cr, { at: 5000000 + 700000, path: "/h/" + id, rule: "contention", from: 1, to: 0, state: "resolve", v: 1, thr: 3 }, false, false, false, defaultNotify(), cv, "resolved", 0);
  const x5 = newSess("claude", "h5", "/h/h5", false); onTrans(x5, cr, { at: 5000000 + 800000, path: x5.path, rule: "contention", from: 0, to: 1, state: "fire", v: 3, thr: 3 }, false, false, false, defaultNotify(), cv, "again", 0);
  eq("contention: after all resolved, a new one rings", String(bells), "2");
  eq("throttle key", throttleKey(cr, newSess("claude", "h9", "/h/h9", false)) + "|" + throttleKey(ap, s), "contention\t@host|" + s.path);
  IO.bell = (): void => { /* quiet */ };
}
eq("kill default 10 s", String(CMD.killMs), "10000");
eq("argv literal", argvFor(["/tmp/x/hook", "{rule}", "$(id)", "{tool} {value}"], cmdSubs(ap, v, tr("fire"), s)).join("|"), "/tmp/x/hook|approval|$(id)|Bash 42s");
const j = alertJson(s, ap, tr("fire"), "Bash pending 42s", 1000000);
eq("alert json", j.rule + " " + j.severity + " " + j.state + " " + String(j.value) + " " + j.unit + " " + String(j.threshold) + " " + j.since, "approval degraded fire 42 duration 20 1970-01-01T00:16:40.000Z");
eq("redacted title", String(j.title.indexOf("real title") < 0), "true");
eq("redacted project", String(j.project !== "secret-project"), "true");

// the command's environment: the notifier basics + AGENTGLASS_*, never agentglass's own secrets
process.env.SECRET_TOKEN = "hunter2"; process.env.ANTHROPIC_API_KEY = "sk-check";
eq("env set for the check", String(process.env.SECRET_TOKEN), "hunter2");
const ce = cmdEnv(j);
eq("cmdEnv: no secrets", String(ce["SECRET_TOKEN"] === undefined && ce["ANTHROPIC_API_KEY"] === undefined), "true");
eq("cmdEnv: PATH kept", String(ce["PATH"] === process.env.PATH), "true");
eq("cmdEnv: rule", ce["AGENTGLASS_RULE"] ?? "", "approval");
// stdin + env
const hook = script("hook", "cat > " + dir + "/in.json; env | grep '^AGENTGLASS_' | sort > " + dir + "/env.txt; env > " + dir + "/env-all.txt");
eq("start", runCommand(cfg(["sh", hook], ["fire", "escalate"]), j, cmdSubs(ap, v, tr("fire"), s)), "");
// not configured for the state
eq("not on resolve", runCommand(cfg(["sh", hook], ["fire"]), alertJson(s, ap, tr("resolve"), "", 0), cmdSubs(ap, v, tr("resolve"), s)), "not configured for resolve");
// an acknowledged alert's escalate still runs the command; bell rules do not apply
writeFileSync(dir + "/count.txt", "");
const counter = script("count", "echo x >> " + dir + "/count.txt");
onTrans(s, ap, { at: 2000000, path: s.path, rule: "approval", from: 1, to: 2, state: "escalate", v: 130, thr: 120 }, true, false, true, cfg(["sh", counter], ["fire", "escalate"]), v, "m", 0);
onTrans(s, ap, tr("resolve"), false, false, true, cfg(["sh", counter], ["resolve"]), v, "m", 0);
onTrans(s, ap, tr("fire"), false, false, true, cfg(["sh", counter], ["resolve"]), v, "m", 0); // fire not listed
onTrans(s, ap, tr("fire"), false, true, false, cfg(["sh", counter], ["fire"]), v, "m", 0); // --watch without --notify
// ≤ 4 at once; more wait in a queue (≤ 32, oldest first) and start as slots free; past that they are dropped
CMD.killMs = 1500; CMD.graceMs = 500;
const slp = script("sleep", "trap '' TERM; while :; do sleep 0.2; done"); // ignores SIGTERM: SIGKILL ends it
const c4 = cfg(["sh", slp], ["fire"]);
for (let i = CMD.running; i < 4; i++) runCommand(c4, j, cmdSubs(ap, v, tr("fire"), s));
eq("4 running", String(CMD.running), "4");
writeFileSync(dir + "/queue.txt", "");
const qs = script("q", "echo \"$1\" >> " + dir + "/queue.txt; if [ \"$1\" = 0 ]; then env > " + dir + "/qenv.txt; fi");
let queued = "";
for (let i = 0; i < 32; i++) queued += runCommand(cfg(["sh", qs, String(i)], ["fire"]), j, cmdSubs(ap, v, tr("fire"), s));
eq("32 queued", queued + String(CMD.queue.length), "32");
eq("33rd dropped", runCommand(cfg(["sh", qs, "x"], ["fire"]), j, cmdSubs(ap, v, tr("fire"), s)), "notify queue full (32 waiting) — dropped");
onTrans(s, ap, tr("fire"), false, true, true, cfg(["sh", qs, "y"], ["fire"]), v, "m", 0);
eq("dropped from a transition: a warning", toasts.splice(0).join("|"), "rules: notify queue full (32 waiting) — dropped");
eq("still 32 queued", String(CMD.queue.length), "32");
// the desktop notification carries a guess (Gemini outside tmux: "approval?") before the title
const desks: string[] = []; IO.desk = (t: string, sub: string, body: string): void => { desks.push(body); };
const wt = rs.rules[0]; const hv = absent(); hv.v = 3; hv.hint = "approval?";
const gs = newSess("gemini", "n2", "/n/2", false); gs.title = "build the todo app"; applyMeta(gs);
const wtr = (p: string): Trans => ({ at: 3000000, path: p, rule: "waiting", from: 0, to: 1, state: "fire", v: 3, thr: 0 });
const ne = process.env.AGENTGLASS_NOTIFY ?? ""; process.env.AGENTGLASS_NOTIFY = "1";
onTrans(gs, wt, wtr(gs.path), false, false, false, defaultNotify(), hv, "turn finished · approval?", 0);
const ps = newSess("claude", "n3", "/n/3", false); ps.title = "build the todo app"; applyMeta(ps);
onTrans(ps, wt, wtr(ps.path), false, false, false, defaultNotify(), v, "turn finished", 0);
// the likely approval (Gemini outside tmux, thoughts only): marked after the rule's prefix
const ls = newSess("gemini", "n4", "/n/4", false); ls.title = "build the todo app"; applyMeta(ls);
const lv = absent(); lv.v = 21; lv.hint = "likely";
onTrans(ls, ap, { at: 3000000, path: ls.path, rule: "approval", from: 0, to: 1, state: "fire", v: 21, thr: 20 }, false, false, false, defaultNotify(), lv, "approval dialog pending 21s, cpu 0% · likely", 0);
eq("desktop: likely after the prefix", (desks[desks.length - 1] ?? "").slice(0, 19), "approval? (likely) ");
desks.pop();
process.env.AGENTGLASS_NOTIFY = ne || "0";
eq("desktop: hint first, plain without", desks.map((d: string) => d.startsWith("approval? ") ? "hint" : d.indexOf("approval") < 0 ? "plain" : d).join(","), "hint,plain");
// permission check of the rules file
const rf = dir + "/rules.json"; writeFileSync(rf, "{}"); chmodSync(rf, 0o664);
eq("664 unsafe", String(fileSafe(rf)), "false");
chmodSync(rf, 0o600);
eq("600 safe", String(fileSafe(rf)), "true");
const us = withSafety(loadRules('{"notify":{"command":["/bin/true"]}}', true), false);
eq("unsafe → command dropped with a diagnostic", String(us.notify.command.length) + " " + String(us.diags.length ? us.diags[0].msg.slice(0, 22) : ""), "0 notify.command ignored");
const t0 = Date.now();
setTimeout(() => {
  const inp = readText(dir + "/in.json", 0, 65536);
  let parsed = ""; try { const o = JSON.parse(inp) as { rule: string; state: string }; parsed = o.rule + " " + o.state; } catch (e) { parsed = "bad json: " + inp; }
  eq("stdin is the alert", parsed, "approval fire");
  const env = readText(dir + "/env.txt", 0, 65536);
  eq("env rule", String(env.indexOf("AGENTGLASS_RULE=approval") >= 0), "true");
  eq("env state", String(env.indexOf("AGENTGLASS_STATE=fire") >= 0), "true");
  eq("env value", String(env.indexOf("AGENTGLASS_VALUE=42") >= 0), "true");
  const all = readText(dir + "/env-all.txt", 0, 262144);
  eq("child env: no secrets", String(all.indexOf("hunter2") < 0 && all.indexOf("sk-check") < 0 && all.indexOf("PATH=") >= 0), "true");
  eq("stdin redacted", String(inp.indexOf("real title") < 0), "true");
  eq("count: escalate (acked) + resolve", readText(dir + "/count.txt", 0, 100), "x\nx\n");
  eq("toasts: none", toasts.join("|"), "");
}, 800);
// the sleeps are killed after killMs: all slots free again
setTimeout(() => {
  eq("killed: slots free", String(CMD.running), "0");
  const ran = readText(dir + "/queue.txt", 0, 4096).split("\n").filter((l: string) => l !== "").map((l: string) => Number(l)).sort((a: number, b: number) => a - b);
  let want = ""; for (let i = 0; i < 32; i++) want += (i ? "," : "") + String(i);
  eq("queue drained: every queued command ran once", ran.join(","), want);
  eq("queue empty", String(CMD.queue.length), "0");
  const qe = readText(dir + "/qenv.txt", 0, 262144);
  eq("queued command env: no secrets", String(qe.indexOf("hunter2") < 0 && qe.indexOf("sk-check") < 0 && qe.indexOf("PATH=") >= 0), "true");
  eq("killed in time", String(Date.now() - t0 < 4500), "true");
  run("rm", ["-rf", dir]);
  console.log(bad ? bad + " failed" : "rules notify: all checks passed");
  process.exit(bad ? 1 : 0);
}, 3500);
