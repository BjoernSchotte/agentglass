// agentglass — self-check for the herdr CLI parsing and decision rules (shapes of herdr 0.9.1, fake values): sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import { parseAgents, parseLabels, parseProcInfo, parseError, parseVersion, versionAtLeast, sessRef, choosePid, pollDue, fresh, placeLabel, sendOutcome, envHerdr, parseWorkspaces, workspaceFor, rowState, tabLabel, parseCreated, workspaceByPanes } from "./herdr-parse.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const AL = '{"id":"cli:agent:list","result":{"agents":[' +
  '{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"S1"},"agent_status":"blocked","cwd":"/w","focused":false,"pane_id":"w7:p1A","tab_id":"w7:t6","terminal_id":"term_a","workspace_id":"w7"},' +
  '{"agent":"pi","agent_session":{"agent":"pi","kind":"path","source":"herdr:pi","value":"/h/.pi/s.jsonl"},"agent_status":"idle","pane_id":"w2:p1","tab_id":"w2:t1","terminal_id":"term_b","workspace_id":"w2"},' +
  '{"agent":"amp","agent_status":"working","pane_id":"w2:p2","tab_id":"w2:t1","terminal_id":"term_c","workspace_id":"w2"},' +
  '{"agent":"claude","agent_status":"idle","tab_id":"w2:t1","workspace_id":"w2"}],"type":"agent_list"}}';
const l = parseAgents(AL);
ok("ok + 3 entries (no pane id skipped)", l.ok && l.agents.length === 3, String(l.agents.length));
ok("fields", l.agents[0]?.pane === "w7:p1A" && l.agents[0]?.term === "term_a" && l.agents[0]?.status === "blocked" && l.agents[0]?.sVal === "S1", JSON.stringify(l.agents[0] ?? null));
ok("garbage → not ok", !parseAgents("<html>").ok && !parseAgents('{"result":{}}').ok, "");
ok("labels", parseLabels('{"result":{"workspaces":[{"workspace_id":"w7","label":"webapp"}],"type":"workspace_list"}}', "workspaces", "workspace_id").get("w7") === "webapp", "");
ok("proc info", parseProcInfo('{"result":{"process_info":{"foreground_processes":[{"pid":11,"name":"claude"},{"pid":12,"name":"npm"}],"pane_id":"w7:p1A","shell_pid":9}}}').join(",") === "11,12", "");
ok("error", parseError('{"error":{"code":"agent_blocked","message":"agent w1:p1 is blocked"},"id":"cli:agent:prompt"}').code === "agent_blocked", "");
ok("error none", parseError("").code === "", "");
ok("version", parseVersion("status: running\nversion: 0.9.1\nendpoint_compatible: yes\n") === "0.9.1", "");
ok("version cmp", versionAtLeast("0.8.2", "0.8.2") && versionAtLeast("0.10.0", "0.8.2") && !versionAtLeast("0.8.1", "0.8.2") && !versionAtLeast("", "0.8.2"), "");
ok("ref id", sessRef("claude", "id", "S1").key === "claude:S1", "");
ok("ref path", sessRef("pi", "path", "/h/.pi/s.jsonl").path === "/h/.pi/s.jsonl", "");
ok("ref unknown label", sessRef("amp", "id", "X").key === "" && sessRef("claude", "id", "").key === "", "");
const roots = new Map<number, string>([[11, "claude"], [13, "codex"]]);
const hr = (pid: number): string => roots.get(pid) ?? "";
ok("pid by label", choosePid([12, 13, 11], hr, "claude") === 11, "");
ok("pid any harness", choosePid([12, 13], hr, "claude") === 13, "");
ok("pid none", choosePid([12], hr, "claude") === 0, "");
ok("due: log moving", !pollDue(2900, true, false, false, 99999), "");
ok("due: quiet busy", pollDue(3000, true, false, false, 1500), "");
ok("due: once per look", !pollDue(3000, true, false, false, 1000), "");
ok("due: idle, not hidden", !pollDue(9000, false, false, false, 99999), "");
ok("due: idle, hidden (gemini)", pollDue(9000, false, true, false, 1500), "");
ok("due: backoff after 60 s", !pollDue(60000, true, false, false, 3000) && pollDue(60000, true, false, false, 6000), "");
ok("due: blocked re-read", pollDue(100, false, false, true, 0), "");
ok("due: blocked for long: every 6 s", !pollDue(600000, false, false, true, 1500) && pollDue(600000, false, false, true, 6000), "");
ok("fresh", fresh(2000, 1999) && fresh(2000, 2000) && !fresh(1999, 2000) && !fresh(0, 0), "");
ok("place", placeLabel("webapp", "2", "w7:p1A", false) === "webapp › 2 · w7:p1A", placeLabel("webapp", "2", "w7:p1A", false));
ok("place redact", placeLabel("webapp", "2", "w7:p1A", true) === "w7:p1A", "");
ok("place no labels", placeLabel("", "", "w7:p1A", false) === "w7:p1A", "");
ok("send ok", sendOutcome(0, "", "webapp › 2").kind === "ok", "");
ok("send blocked", sendOutcome(1, '{"error":{"code":"agent_blocked","message":"m"}}', "x").text.indexOf("dialog") >= 0, "");
ok("send other", sendOutcome(3, "", "x").text === "send failed (exit 3)", sendOutcome(3, "", "x").text);
const env = new TextEncoder().encode("PATH=/bin\u0000ANTHROPIC_API_KEY=SECRET\u0000HERDR_PANE_ID=w7:p1A\u0000HERDR_SOCKET_PATH=/h/.config/herdr/herdr.sock\u0000");
const e = envHerdr(env);
ok("env two values", e.pane === "w7:p1A" && e.sock === "/h/.config/herdr/herdr.sock", JSON.stringify(e));
ok("env nothing else", JSON.stringify(e).indexOf("SECRET") < 0, "");
const WS = parseWorkspaces('{"result":{"type":"workspace_list","workspaces":[{"workspace_id":"w1","label":"api","worktree":{"checkout_path":"/r/api","repo_root":"/r/api"}},{"workspace_id":"w2","label":"feat-x","worktree":{"checkout_path":"/h/.herdr/worktrees/api/feat-x","repo_root":"/r/api"}},{"workspace_id":"w3","label":"~"}]}}');
ok("workspaces", WS.length === 3 && WS[1]?.checkout === "/h/.herdr/worktrees/api/feat-x" && WS[2]?.checkout === "", JSON.stringify(WS));
ok("ws: longest checkout", workspaceFor("/h/.herdr/worktrees/api/feat-x/src", "/r/api", WS) === 1, "");
ok("ws: segment aware", workspaceFor("/r/api-old", "", WS) === -1, "");
ok("ws: repo root fallback", workspaceFor("/elsewhere", "/r/api", WS) === 0, "");
ok("row: working fresh", rowState("working", 10000, 9000, 20000) === "working", "");
ok("row: stale vs log", rowState("working", 9000, 9500, 20000) === "", "");
ok("row: too old", rowState("done", 1000, 0, 40000) === "", "");
ok("row: idle no change", rowState("idle", 10000, 0, 20000) === "", "");
ok("tab label", tabLabel("fix the flaky login test in CI please", "abcdef0123", false).length <= 24 && tabLabel("x", "abcdef0123", true) === "abcdef01", "");
ok("workspace ids", parseAgents(AL).agents[0]?.ws === "w7" && parseAgents(AL).agents[0]?.tab === "w7:t6", "");
ok("created: tab", parseCreated('{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"w1:p2","tab_id":"w1:t2","terminal_id":"t"},"tab":{"label":"t2","tab_id":"w1:t2","workspace_id":"w1"},"type":"tab_created"}}').pane === "w1:p2", "");
ok("created: workspace", parseCreated('{"result":{"root_pane":{"pane_id":"w3:p1","tab_id":"w3:t1"},"tab":{"tab_id":"w3:t1"},"workspace":{"workspace_id":"w3","label":"x"},"type":"workspace_created"}}').ws === "w3", "");
ok("created: garbage", parseCreated("{}").pane === "", "");
ok("send not_ready", sendOutcome(1, '{"error":{"code":"agent_not_ready","message":"m"}}', "x").kind === "warn", "");
ok("send gone", sendOutcome(1, '{"error":{"code":"agent_not_found","message":"m"}}', "x").text === "the herdr pane is gone", "");
ok("send server down", sendOutcome(1, '{"error":{"code":"server_not_running","message":"m"}}', "x").kind === "err", "");
ok("send other code", sendOutcome(1, '{"error":{"code":"weird","message":"' + "y".repeat(200) + '"}}', "x").text.length <= 107, String(sendOutcome(1, '{"error":{"code":"weird","message":"' + "y".repeat(200) + '"}}', "x").text.length));
ok("send text", sendOutcome(0, "", "webapp › 2").text === "sent to herdr webapp › 2", sendOutcome(0, "", "webapp › 2").text);
ok("version none", parseVersion("status: running\n") === "" && versionAtLeast("1.0", "0.8.2") && !versionAtLeast("0.8", "0.8.2"), "");
ok("row: blocked", rowState("blocked", 10000, 0, 20000) === "blocked", "");
ok("tab label cut", tabLabel("ÄÖÜ".repeat(20), "abc", false).length === 24 && tabLabel("", "abcdef0123", false) === "abcdef01", "");
ok("env empty", envHerdr(new Uint8Array(0)).sock === "", "");
ok("agent cwd", parseAgents('{"result":{"agents":[{"agent":"claude","cwd":"/w/x","pane_id":"w1:p1","terminal_id":"t"}]}}').agents[0]?.cwd === "/w/x", "");
ok("ws by panes", workspaceByPanes("/w/x/src", [["/w", "w1"], ["/w/x", "w2"], ["/w/xy", "w3"]]) === "w2" && workspaceByPanes("/w/xy2", [["/w/xy", "w3"]]) === "" && workspaceByPanes("/a", [["/", "w9"]]) === "", "");
console.log(bad ? bad + " failed" : "herdr-parse: all checks passed");
if (bad) process.exit(1);
