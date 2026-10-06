// agentglass — self-check for the herdr adapter against a fake herdr (testdata/herdr/fake-herdr.sh): detection, pane map,
// process-info cap, moves, skips, statuses per look, send, focus, resume in a new tab — never a real herdr: sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, unlinkSync } from "node:fs";
import type { MuxProc } from "./types.ts";
import { herdr, herdrReset, herdrWorkspaces } from "./herdr.ts";
import { MUX_EVENTS } from "./events.ts";
import { S } from "../state.ts";
import { join } from "node:path";
import { HOME, listDir } from "../util/fs.ts";
import { RUN_DIR } from "../features/palette/rundir.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-herdr-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
const fake = dir + "/herdr"; writeFileSync(fake, readFileSync("testdata/herdr/fake-herdr.sh", "utf8")); chmodSync(fake, 0o755);
const sock = dir + "/herdr.sock"; writeFileSync(sock, "");
process.env["AGENTGLASS_HERDR"] = fake; process.env["AGENTGLASS_HERDR_SOCKET"] = sock;
delete process.env["HERDR_ENV"]; delete process.env["HERDR_SOCKET_PATH"];
const w = (n: string, t: string): void => { writeFileSync(dir + "/" + n, t); };
const calls = (): string[] => existsSync(dir + "/calls.log") ? readFileSync(dir + "/calls.log", "utf8").split("\n").filter((l: string) => l.length > 0) : [];
const count = (pat: string): number => calls().filter((l: string) => l.indexOf(pat) >= 0).length;
function agent(pane: string, term: string, ws: string, tab: string, label: string, status: string, kind: string, val: string): string {
  return '{"agent":"' + label + '",' + (val ? '"agent_session":{"agent":"' + label + '","kind":"' + kind + '","source":"herdr:' + label + '","value":"' + val + '"},' : "") +
    '"agent_status":"' + status + '","pane_id":"' + pane + '","tab_id":"' + tab + '","terminal_id":"' + term + '","workspace_id":"' + ws + '"}';
}
const list = (as: string[]): string => '{"id":"cli:agent:list","result":{"agents":[' + as.join(",") + '],"type":"agent_list"}}';
const A1 = agent("w7:p1A", "term_a", "w7", "w7:t6", "claude", "blocked", "id", "S1");
const A2 = agent("w2:p1", "term_b", "w2", "w2:t1", "pi", "idle", "path", "/h/.pi/s.jsonl");
const A3 = agent("w2:p2", "term_c", "w2", "w2:t1", "amp", "working", "", "");
w("agent-list.json", list([A1, A2, A3]));
w("workspace-list.json", '{"result":{"type":"workspace_list","workspaces":[{"workspace_id":"w7","label":"webapp"},{"workspace_id":"w2","label":"scratch","worktree":{"checkout_path":"/h/.herdr/worktrees/api/feat-x","repo_root":"/r/api"}}]}}');
w("tab-list.json", '{"result":{"type":"tab_list","tabs":[{"tab_id":"w7:t6","label":"6"},{"tab_id":"w2:t1","label":"1"}]}}');
w("process-info-w2:p1.json", '{"result":{"process_info":{"foreground_processes":[{"pid":31,"name":"node"}],"pane_id":"w2:p1"}}}');
w("process-info-w2:p2.json", '{"result":{"process_info":{"foreground_processes":[],"pane_id":"w2:p2"}}}');
w("status.txt", "status: running\nversion: 0.9.1\n");
const known = (key: string, path: string): number => key === "claude:S1" ? 21 : 0;
const ps: MuxProc[] = [{ pid: 21, h: "claude", tty: "", root: 21 }, { pid: 31, h: "pi", tty: "", root: 31 }];
let now = 1000000;

// detection: off spawns nothing
process.env["AGENTGLASS_HERDR"] = "off"; herdrReset();
ok("off: absent", !herdr.present(now), "");
ok("off: no call", calls().length === 0, String(calls().length));
process.env["AGENTGLASS_HERDR"] = fake; herdrReset();
ok("present", herdr.present(now), "");

// the map: a known pid needs no process-info; pi by process-info; amp unresolved
herdr.refresh(ps, now, false, known);
ok("known pid: no process-info", count("process-info --pane w7:p1A") === 0, calls().join(" / "));
ok("pi: one process-info", count("process-info --pane w2:p1") === 1 && count("process-info --pane w2:p2") === 1, calls().join(" / "));
const p21 = herdr.paneOf(21);
ok("paneOf known", p21 !== null && p21.id === "w7:p1A" && p21.ws === "webapp" && p21.tab === "6" && p21.wsId === "w7" && p21.status === "blocked", JSON.stringify(p21));
const p31 = herdr.paneOf(31); ok("paneOf by process-info", p31 !== null && p31.id === "w2:p1", JSON.stringify(p31));
const bs = herdr.paneOfSession("claude:S1", ""); ok("paneOfSession", bs !== null && bs.id === "w7:p1A", "");
const ls = herdr.links();
ok("links", ls.length === 2 && ls.some((l) => l.pid === 21 && l.key === "claude:S1") && ls.some((l) => l.pid === 31 && l.path === "/h/.pi/s.jsonl"), JSON.stringify(ls));
ok("workspaces", herdrWorkspaces().length === 2 && herdrWorkspaces()[1]?.checkout === "/h/.herdr/worktrees/api/feat-x", "");

// cadence: nothing new for 10 s → no call; 30 s → one agent list; a new pid → at once; forced → at once
let n0 = calls().length;
herdr.refresh(ps, now + 10000, false, known); ok("10 s: no call", calls().length === n0, calls().slice(n0).join(" / "));
herdr.refresh(ps, now + 30000, false, known); ok("30 s: one agent list", count("agent list") === 2, String(count("agent list")));
now += 30000;
n0 = count("agent list");
herdr.refresh(ps, now + 1000, true, known); ok("forced: at once", count("agent list") === n0 + 1, "");
now += 1000;

// cap: 12 unresolved panes → 8 process-info calls, the rest next pass; forced → all
const many: string[] = []; for (let i = 0; i < 12; i++) many.push(agent("w9:p" + String(i), "term_m" + String(i), "w9", "w9:t1", "amp", "idle", "", ""));
w("agent-list.json", list([A1].concat(many)));
let pi0 = count("process-info");
herdr.refresh(ps, now + 31000, false, known); now += 31000;
ok("cap 8 per pass", count("process-info") - pi0 === 8, String(count("process-info") - pi0));
pi0 = count("process-info");
herdr.refresh(ps, now + 1000, false, known); now += 1000; // dirty: the rest
ok("the rest next pass", count("process-info") - pi0 >= 4, String(count("process-info") - pi0));
pi0 = count("process-info");
herdr.refresh(ps, now + 1000, true, known); now += 1000;
ok("forced: all unresolved", count("process-info") - pi0 === 12, String(count("process-info") - pi0));

// a moved pane keeps its pid by terminal id, no process-info for it
w("agent-list.json", list([agent("w8:p3", "term_a", "w8", "w8:t1", "claude", "idle", "id", "S1"), A2]));
pi0 = count("process-info");
herdr.refresh(ps, now + 1000, true, known); now += 1000;
const mv = herdr.paneOf(21);
ok("moved pane: new id", mv !== null && mv.id === "w8:p3", JSON.stringify(mv));
ok("moved: no process-info for it", count("process-info --pane w8:p3") === 0, "");

// statuses: due twice in one look → one read; not due → none
n0 = count("agent list");
if (mv) { herdr.status(mv, true, 1, now); herdr.status(mv, true, 1, now); }
ok("one read per look", count("agent list") === n0 + 1, String(count("agent list") - n0));
if (mv) herdr.status(mv, false, 2, now);
ok("not due: no read", count("agent list") === n0 + 1, "");

// send: too old, ok, blocked, one at a time; focus
w("status.txt", "status: running\nversion: 0.8.1\n");
if (mv) herdr.send(mv, "hello");
ok("too old: warn", S.toastKind === "warn" && S.toast.indexOf("too old") >= 0, S.toast);
ok("too old: nothing sent", count("agent prompt") === 0, "");
// the version cannot be read (a server going down): the reason, nothing sent — not "too old"
w("fail-status", '{"error":{"code":"server_not_running","message":"no server"}}\n'); herdrReset(); herdr.refresh(ps, now, true, known);
const mv2 = herdr.paneOf(21); if (mv2) herdr.send(mv2, "hello");
ok("version unreadable: server down", S.toastKind === "err" && S.toast === "herdr server not running", S.toast);
ok("version unreadable: nothing sent", count("agent prompt") === 0, "");
unlinkSync(dir + "/fail-status");
herdrReset(); herdr.refresh(ps, now, true, known);
w("status.txt", "status: running\nversion: 0.9.1\n");
const pp = herdr.paneOf(21);
const steps: (() => void)[] = [];
steps.push(() => {
  if (pp) { herdr.send(pp, "hello $HOME"); herdr.send(pp, "again"); }
  ok("second send while one runs", S.toast === "still sending…", S.toast);
});
steps.push(() => {
  const pr = existsSync(dir + "/prompts.log") ? readFileSync(dir + "/prompts.log", "utf8") : "";
  ok("sent", pr === "hello $HOME\n" && S.toastKind === "ok" && S.toast === "sent to herdr w8:p3", pr + " / " + S.toast); // --redact (check.sh): pane id only
  ok("send argv", count("agent prompt w8:p3 hello $HOME") === 1, calls().join(" / "));
  // herdr's stderr goes to a private dir in the run dir (AGENTGLASS_RUN_DIR isolates test runs), read and removed on exit
  ok("send: stderr file in the run dir, removed", existsSync(join(RUN_DIR, "herdr")) && listDir(join(RUN_DIR, "herdr")).length === 0 && !existsSync(join(HOME, ".agentglass", "tmp")), listDir(join(RUN_DIR, "herdr")).join(","));
  w("fail-prompt", '{"error":{"code":"agent_blocked","message":"agent w8:p3 is blocked"},"id":"cli:agent:prompt"}\n');
  if (pp) herdr.send(pp, "refused");
});
steps.push(() => {
  ok("blocked: warn dialog", S.toastKind === "warn" && S.toast.indexOf("dialog") >= 0, S.toast);
  unlinkSync(dir + "/fail-prompt");
  if (pp) herdr.focus(pp);
  ok("focus argv", count("agent focus w8:p3") === 1, "");
  ok("focus toast", S.toast === "focused in herdr: w8:p3" && MUX_EVENTS.jumped, S.toast);
  // resume in a new tab of the workspace whose worktree holds the directory
  MUX_EVENTS.jumped = false;
  ok("start outside herdr: not here", !herdr.start("claude", "S9abcdef12", ["--resume", "S9"], "/h/.herdr/worktrees/api/feat-x", "/r/api", "fix login") && count("tab create") === 0, "");
  process.env["HERDR_ENV"] = "1"; process.env["HERDR_SOCKET_PATH"] = sock; herdrReset();
  w("tab-create.json", '{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"w2:p9","tab_id":"w2:t4","terminal_id":"term_n","workspace_id":"w2"},"tab":{"label":"fix login","tab_id":"w2:t4","workspace_id":"w2"},"type":"tab_created"}}');
  ok("start: fx cannot", !herdr.start("fx", "S9", [], "/x", "", "t"), "");
  ok("start: gemini cannot (herdr does not detect it: the start would time out)", !herdr.start("gemini", "S9", [], "/x", "", "t"), "");
  ok("start: started", herdr.start("claude", "S9abcdef12", ["--resume", "S9"], "/h/.herdr/worktrees/api/feat-x/src", "/r/api", "fix login"), "");
  ok("start: tab in the worktree's workspace", count("tab create --workspace w2 --cwd /h/.herdr/worktrees/api/feat-x/src --label fix login --no-focus") === 1, calls().join(" / "));
});
steps.push(() => {
  ok("start: agent start argv", count("agent start claude-S9abcdef --kind claude --pane w2:p9 -- --resume S9") === 1, calls().join(" / "));
  ok("start: focused", count("agent focus w2:p9") === 1 && MUX_EVENTS.jumped, "");
  w("fail-agent-start", '{"error":{"code":"agent_start_timeout","message":"agent did not become ready"}}\n');
  herdr.start("claude", "S9abcdef12", ["--resume", "S9"], "/elsewhere", "/r/api", "x");
});
steps.push(() => {
  ok("start failed: tab closed", count("tab close w2:t4") === 1, calls().join(" / "));
  // checks run under --redact: herdr's message (it may name paths) gives way to its code
  ok("start failed: error toast", S.toastKind === "err" && S.toast === "herdr: agent_start_timeout", S.toast);
  // no workspace for the directory, no repo match → a new workspace
  unlinkSync(dir + "/fail-agent-start");
  w("workspace-create.json", '{"result":{"root_pane":{"pane_id":"w5:p1","tab_id":"w5:t1"},"tab":{"tab_id":"w5:t1"},"workspace":{"workspace_id":"w5","label":"other"},"type":"workspace_created"}}');
  herdr.start("codex", "C1", ["resume", "C1"], "/other/proj", "/other/proj", "t");
  // (labelled like its tab under --redact: the repo's name is user text)
  ok("start: new workspace", count("workspace create --cwd /other/proj --label t --no-focus") === 1 && count("tab create --workspace w5") === 0, calls().join(" / "));
});
steps.push(() => {
  ok("start: in the new workspace's pane", count("agent start codex-C1 --kind codex --pane w5:p1 -- resume C1") === 1, "");
  // a server that is down is skipped for 60 s
  delete process.env["HERDR_ENV"]; delete process.env["HERDR_SOCKET_PATH"]; herdrReset();
  w("fail-agent-list", '{"error":{"code":"server_not_running","message":"no server"}}\n');
  ok("down: refresh false", !herdr.refresh(ps, now, true, known), "");
  const n1 = count("agent list");
  herdr.refresh(ps, now + 30000, false, known);
  ok("down: skipped 60 s", count("agent list") === n1, "");
  ok("only the pinned server", calls().every((l: string) => l.startsWith(sock + "|")), calls().filter((l: string) => !l.startsWith(sock + "|")).join(" / "));
  rmSync(dir, { recursive: true, force: true });
  console.log(bad ? bad + " failed" : "herdr: all checks passed");
  process.exit(bad ? 1 : 0);
});
let si = 0;
function next(): void { const f = steps[si++]; if (f) { f(); setTimeout(next, 900); } }
next();
