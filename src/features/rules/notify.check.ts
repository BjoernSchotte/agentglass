// agentglass — self-check for the notify command: scriptc build src/features/rules/notify.check.ts -o nc && ./nc
// SPDX-License-Identifier: Apache-2.0
// The commands are tiny sh scripts: sh is the program, the alert never passes through a shell string.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { newSess } from "../../model/types.ts";
import { readText, run } from "../../util/fs.ts";
import { absent } from "../detect.ts";
import { type NotifyCfg, loadRules, defaultNotify } from "./config.ts";
import type { Trans } from "./engine.ts";
import { CMD, IO, alertJson, argvFor, cmdSubs, runCommand, onTrans } from "./notify.ts";
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

eq("kill default 10 s", String(CMD.killMs), "10000");
eq("argv literal", argvFor(["/tmp/x/hook", "{rule}", "$(id)", "{tool} {value}"], cmdSubs(ap, v, tr("fire"), s)).join("|"), "/tmp/x/hook|approval|$(id)|Bash 42s");
const j = alertJson(s, ap, tr("fire"), "Bash pending 42s", 1000000);
eq("alert json", j.rule + " " + j.severity + " " + j.state + " " + String(j.value) + " " + j.unit + " " + String(j.threshold) + " " + j.since, "approval degraded fire 42 duration 20 1970-01-01T00:16:40.000Z");
eq("redacted title", String(j.title.indexOf("real title") < 0), "true");
eq("redacted project", String(j.project !== "secret-project"), "true");

// stdin + env
const hook = script("hook", "cat > " + dir + "/in.json; env | grep '^AGENTGLASS_' | sort > " + dir + "/env.txt");
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
// ≤ 4 at once: the fifth is dropped
CMD.killMs = 1500;
const slp = script("sleep", "sleep 60");
const c4 = cfg(["sh", slp], ["fire"]);
const started = CMD.running;
let drop = "";
for (let i = started; i < 5; i++) drop = runCommand(c4, j, cmdSubs(ap, v, tr("fire"), s));
eq("fifth dropped", drop, "4 notify commands running — dropped");
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
  eq("stdin redacted", String(inp.indexOf("real title") < 0), "true");
  eq("count: escalate (acked) + resolve", readText(dir + "/count.txt", 0, 100), "x\nx\n");
  eq("toasts: none", toasts.join("|"), "");
}, 800);
// the sleeps are killed after killMs: all slots free again
setTimeout(() => {
  eq("killed: slots free", String(CMD.running), "0");
  eq("killed in time", String(Date.now() - t0 < 4000), "true");
  run("rm", ["-rf", dir]);
  console.log(bad ? bad + " failed" : "rules notify: all checks passed");
  if (bad) process.exit(1);
}, 2500);
