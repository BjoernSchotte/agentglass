// agentglass — self-check for `rules check|defaults` and the --watch engine step: scriptc build src/features/rules/cli.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { loadRules } from "./config.ts";
import { checkText, defaultsText, thrText } from "./cli.ts";
import { type Obs, watchStep } from "../watchdog.ts";
import { firing } from "./engine.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ev(kind: string, text: string): Ev { return { kind, text, ts: "", id: "", full: "" }; }

const e = checkText('{"rules":[\n {"id":"x","metric":"nope","degraded":1},\n {"id":"y","metric":"session_cost","degraded":1,"colour":1}\n]}', true, true);
eq("error + warning: exit 2", String(e.code), "2");
eq("error line", e.lines.filter((l: string) => l.startsWith("rules.json:")).join(" | "), "rules.json:2:21: x: unknown metric \"nope\"; one of turn_done, approval_wait, repeat_run, command_age, stalled, spinning, session_cost, session_tokens, tool_calls, tool_errors, tool_error_rate — rule disabled | rules.json:3:49: y: warning: unknown field \"colour\" (ignored)");
eq("json diags", e.json.diagnostics.map((d) => d.severity).join(","), "error,warning");
eq("warnings only: exit 1", String(checkText('{"rules":[{"id":"y","metric":"session_cost","degraded":1,"colour":1}]}', true, true).code), "1");
eq("clean: exit 0", String(checkText('{"rules":[{"id":"approval","critical":"2m"}]}', true, true).code), "0");
eq("missing: exit 0", String(checkText("", false, false).code), "0");
eq("syntax: exit 2", String(checkText('{"rules":[}', true, true).code), "2");
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
eq("examples: disabled", x.rules.filter((r) => !r.enabled).length + " of " + String(x.rules.length), "5 of 11");

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
console.log(bad ? bad + " failed" : "rules cli: all checks passed");
if (bad) process.exit(1);
