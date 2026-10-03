// agentglass — self-check for rules hot reload and bell/desktop throttling: scriptc build src/features/rules/reload.check.ts -o rl && ./rl
// SPDX-License-Identifier: Apache-2.0
import { newSess } from "../../model/types.ts";
import { HIST } from "../../model/procs.ts";
import { S } from "../../state.ts";
import { type MVal, absent } from "../detect.ts";
import { R, reload, fileMtime } from "./state.ts";
import { writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { type Trans, stepSession, stateOf, LOG } from "./engine.ts";
import { IO, onTrans } from "./notify.ts";
import { loadRules } from "./config.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const F = { text: "", mtime: -1 };
const rl = (now: number): boolean => reload(now, (p: string) => F.text, (p: string) => F.mtime, (p: string) => true);
function ids(): string { return R.set.rules.filter((r) => r.enabled).map((r) => r.id).join(","); }
// a chmod alone (the fix the unsafe-command warning asks for) counts as a change: the permission check runs again
const cf = "/tmp/agentglass-reload-check-" + String(Date.now()) + ".json"; writeFileSync(cf, "{}"); chmodSync(cf, 0o664);
const m0 = fileMtime(cf);
const until = Date.now() + 30; while (Date.now() < until) { /* let the clock tick */ }
chmodSync(cf, 0o600);
eq("chmod changes the stamp", String(fileMtime(cf) !== m0), "true");
unlinkSync(cf);
let t = 1000000;
eq("missing → built-ins", String(rl(t)) + " " + ids(), "false waiting,approval,loop,long-cmd,stalled,spinning");
F.text = '{"rules":[{"id":"cost","metric":"session_cost","degraded":1}]}'; F.mtime = 5;
eq("within 2 s: not checked", String(rl(t + 1000)), "false");
eq("valid → replaced", String(rl(t + 2500)) + " " + ids(), "true waiting,approval,loop,long-cmd,stalled,spinning,cost");
// a firing rule, then a broken edit: kept, one warning per mtime
const v = absent(); v.v = 5; v.at = t; const vals = new Map<string, MVal>(); vals.set("cost", v);
stepSession(R.set, "/r/1", vals, t);
const cs = stateOf("/r/1", "cost"); eq("cost fires", cs ? String(cs.level) : "none", "1");
S.toast = "";
F.text = '{"rules":[{"id":"cost","metric":"session_cost","degraded":1}'; F.mtime = 6;
eq("broken → kept", String(rl(t + 5000)) + " " + ids(), "false waiting,approval,loop,long-cmd,stalled,spinning,cost");
eq("one warning", S.toast.indexOf("keeping the previous rules") >= 0 ? "warned" : S.toast, "warned");
S.toast = "";
eq("same mtime: no second warning", String(rl(t + 7500)) + " [" + S.toast + "]", "false []");
// removed id: state gone silently (no transition reaches the outputs)
const n0 = LOG.length;
F.text = '{"rules":[]}'; F.mtime = 7;
rl(t + 10000);
eq("removed id: state gone", String(stateOf("/r/1", "cost") === null), "true");
eq("removed id: no transition", String(LOG.length - n0), "0");
// CPU history cap follows samples
F.text = '{"rules":[{"id":"spin-long","metric":"spinning","critical":"9m","params":{"samples":400}}]}'; F.mtime = 8;
rl(t + 12500); eq("cap 400", String(HIST.cap), "400");
F.text = '{"rules":[{"id":"spin-long","metric":"spinning","critical":"9m","params":{"samples":400},"enabled":false}]}'; F.mtime = 9;
rl(t + 15000); eq("cap back to 120", String(HIST.cap), "120");
F.mtime = -1; rl(t + 17500); eq("deleted → built-ins", ids(), "waiting,approval,loop,long-cmd,stalled,spinning");
// one error: the toast names it (file:line:col, rule, what is wrong); several: the count
S.toast = ""; F.text = '{"rules":[{"id":"approval","critical":"2x"}]}'; F.mtime = 10; rl(t + 20000);
eq("one error toast", S.toast.startsWith("rules.json:1:39: approval: threshold \"2x\" is invalid") ? "named" : S.toast, "named");
S.toast = ""; F.text = '{"rules":[{"id":"approval","critical":"2x"},{"id":"x","metric":"nope"}]}'; F.mtime = 11; rl(t + 22500);
eq("two errors toast", S.toast.startsWith("rules.json: 2 errors") ? "counted" : S.toast, "counted");
F.mtime = -1; rl(t + 25000);

// bell/desktop throttle (30 s per session, shared), ack, AGENTGLASS_NOTIFY=0 (the check env)
let bells = 0; let desks = 0;
IO.bell = (): void => { bells++; };
IO.desk = (a: string, b: string, c: string): void => { desks++; };
const rs = loadRules("", false); const w = rs.rules[0];
const s = newSess("claude", "n1", "/n/1", false); s.cwd = "/w/app";
const tr = (at: number, state: string): Trans => ({ at, path: s.path, rule: "waiting", from: 0, to: 1, state, v: 0, thr: 0 });
onTrans(s, w, tr(t, "fire"), false, false, true, rs.notify, absent(), "turn finished", t);
onTrans(s, w, tr(t + 10000, "fire"), false, false, true, rs.notify, absent(), "turn finished", t);
eq("10 s apart: one bell", String(bells), "1");
onTrans(s, w, tr(t + 31000, "fire"), false, false, true, rs.notify, absent(), "turn finished", t);
eq("31 s apart: two bells", String(bells), "2");
onTrans(s, w, tr(t + 70000, "fire"), true, false, true, rs.notify, absent(), "turn finished", t);
eq("acked: none", String(bells), "2");
onTrans(s, w, tr(t + 140000, "resolve"), false, false, true, rs.notify, absent(), "turn finished", t);
eq("resolve: no bell", String(bells), "2");
onTrans(s, w, tr(t + 210000, "fire"), false, true, true, rs.notify, absent(), "turn finished", t);
eq("--watch: no bell", String(bells), "2");
eq("AGENTGLASS_NOTIFY=0: no desktop", String(desks), "0");
onTrans(s, rs.rules[2], { at: t + 300000, path: s.path, rule: "loop", from: 0, to: 2, state: "fire", v: 3, thr: 3 }, false, false, true, rs.notify, absent(), "x", t);
eq("notify false: no bell", String(bells), "2");
console.log(bad ? bad + " failed" : "rules reload: all checks passed");
if (bad) process.exit(1);
