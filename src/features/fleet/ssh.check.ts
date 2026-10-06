// agentglass — self-check for the SSH feed: argv, quoting, ControlPath, statuses, timeouts and kills, spool reads:
// scriptc build src/features/fleet/ssh.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { detachedPid } from "../../platform/posix.ts";
import type { HostCfg, FleetCfg } from "./config.ts";
import { FORMAT, type HostReport, type FeedState, noOwned } from "./model.ts";
import { reportLines, sessRowOf } from "./report.ts";
import { q, controlPath, sshArgs, statusOf, SNIPPET, FEEDTEST, sshFeed } from "./ssh.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
ok("q", q("a'b") === "'a'\\''b'", q("a'b"));
ok("q ~/", q("~/.local/bin/agentglass") === "~/'.local/bin/agentglass'", q("~/.local/bin/agentglass"));
ok("q plain", q("--days") === "'--days'", q("--days"));
const cp = controlPath("/home/u/.agentglass/run", "ws");
ok("control path", /^\/home\/u\/\.agentglass\/run\/f-[0-9a-f]{12}$/.test(cp), cp);
ok("control path differs per target", cp !== controlPath("/home/u/.agentglass/run", "vm1"), "same");
ok("control path too long", controlPath("/" + "x".repeat(80), "ws") === "", controlPath("/" + "x".repeat(80), "ws"));
ok("control path at the limit", controlPath("/" + "x".repeat(74), "ws") !== "" && controlPath("/" + "x".repeat(75), "ws") === "", String(("/" + "x".repeat(74) + "/f-012345678901").length));
const h: HostCfg = { name: "ws", ssh: "me@ws", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "" };
const want = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "Compression=yes",
  "-o", "ControlMaster=auto", "-o", "ControlPath=/r/f-0123", "-o", "ControlPersist=600", "--", "me@ws", "'agentglass'", "'fleet'", "'pull'", "'--days'", "'7'", "'--redact'"];
ok("argv", JSON.stringify(sshArgs(h, 7, true, "/r/f-0123")) === JSON.stringify(want), JSON.stringify(sshArgs(h, 7, true, "/r/f-0123")));
const noSh = sshArgs(h, 3, false, "");
ok("argv without sharing", noSh.indexOf("ControlMaster=auto") < 0 && noSh[noSh.length - 1] === "'3'" && noSh.indexOf("me@ws") === 12 && noSh[11] === "--", JSON.stringify(noSh));
ok("status ssh", statusOf(255, "ssh: Could not resolve hostname ws: Name or service not known", h, 90).msg.indexOf("Could not resolve hostname") >= 0, "msg");
ok("status publickey", statusOf(255, "me@ws: Permission denied (publickey).", h, 90).msg.indexOf("ssh-agent") >= 0, statusOf(255, "me@ws: Permission denied (publickey).", h, 90).msg);
ok("status 127", statusOf(127, "", h, 90).msg.indexOf("set fleet.hosts[].agentglass") >= 0 && statusOf(127, "", h, 90).code === "missing", "127");
ok("status 126", statusOf(126, "agentglass fleet serve: only fleet pull and --version are allowed", h, 90).code === "refused", "126");
ok("status old", statusOf(2, "agentglass: unknown command fleet", h, 90).code === "old", "old");
ok("status old (TUI)", statusOf(1, "agentglass needs an interactive terminal", h, 90).code === "old", "old tui");
ok("status timeout", statusOf(-1, "", h, 90).msg.indexOf("timed out after 90 s") >= 0, "timeout");
ok("status other", statusOf(3, "boom", h, 90).msg === "exit 3: boom", statusOf(3, "boom", h, 90).msg);
ok("snippet", SNIPPET.indexOf("mv -f \"$d/$k.rc.tmp\" \"$d/$k.rc\"") >= 0 && SNIPPET.indexOf("${") < 0 && SNIPPET.indexOf("umask 077") === 0, SNIPPET);

// the feed with a stub spawn: argv shape, one run at a time
const dir = join(HOME, "fleet"); process.env["AGENTGLASS_FLEET_DIR"] = dir;
const bin = join(HOME, "bin"); mkdirSync(bin, { recursive: true });
function script(name: string, body: string): string { const p = join(bin, name); writeFileSync(p, "#!/bin/sh\n[ \"$1\" = -V ] && exit 0\n" + body + "\n"); chmodSync(p, 0o755); return p; }
process.env["AGENTGLASS_SSH"] = script("ssh-stub", "exit 0");
const f: FleetCfg = { hosts: [h], localName: "local", refreshS: 60, days: 7, timeoutS: 10, warns: [] };
const calls: string[][] = [];
let t = 1000000;
const stub = sshFeed(h, f, false, (): number => t, (cmd: string, args: string[]): number => { calls.push([cmd].concat(args)); return 999999; }, 256);
ok("start", stub.start(t), "false");
ok("second start while running", !stub.start(t), "true");
const c0 = calls[0] ?? [];
ok("spawn argv", c0[0] === "sh" && c0[1] === "-c" && c0[2] === SNIPPET && c0[3] === "sh" && c0[4] === dir && c0[5] === "ws" && (c0[6] ?? "").endsWith("ssh-stub") && c0[c0.length - 1] === "'7'", JSON.stringify(c0));
ok("one spawn", calls.length === 1, String(calls.length));
ok("spool dir 0700", existsSync(dir), "missing");

// real processes: a fake ssh that sleeps is killed with its group at the timeout
FEEDTEST.timeoutMs = 300;
process.env["AGENTGLASS_SSH"] = script("ssh-slow", "sleep 30");
const hs: HostCfg = { name: "slow", ssh: "slow", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "" };
const slow = sshFeed(hs, f, false, (): number => Date.now(), detachedPid, 256);
ok("slow start", slow.start(Date.now()), "false");
const pid = Number((readFileSync(join(dir, "slow.pid"), "utf8").split(" ")[0]) ?? "");
execFileSync("sleep", ["0.5"]);
const s1: FeedState = slow.poll(Date.now());
ok("timeout status", s1.code === "timeout" && !s1.busy, JSON.stringify(s1));
execFileSync("sleep", ["0.3"]);
let left = ""; try { left = execFileSync("ps", ["-o", "pid=,stat=", "-g", String(pid)], { encoding: "utf8" }).trim(); } catch (e) { left = ""; }
ok("group killed", left.split("\n").every((l: string) => l.trim() === "" || /Z/.test(l)), left); // Z: exited, reaped once the event loop runs (this check blocks it)

// a fake ssh that prints a 900-session report: read within a few polls at 256 lines each
const rep: HostReport = { hello: { format: FORMAT, version: "x", hostId: "0123456789abcdef", hostName: "ws", os: "linux", tzOffsetMin: 0, redact: false, days: 7, now: Date.now(), priceSig: "" }, sessions: [], cost: { today: {} }, allowance: null, live: null, exact: false, owned: noOwned() };
for (let i = 0; i < 900; i++) rep.sessions.push(sessRowOf({ id: "s" + String(i), harness: "claude", title: "t" + String(i) }));
writeFileSync(join(HOME, "report.jsonl"), reportLines(rep).join("\n") + "\n");
FEEDTEST.timeoutMs = 20000;
process.env["AGENTGLASS_SSH"] = script("ssh-cat", "cat " + JSON.stringify(join(HOME, "report.jsonl")));
const hc: HostCfg = { name: "cat", ssh: "cat", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "" };
const cf = sshFeed(hc, f, false, (): number => Date.now(), detachedPid, 256);
ok("cat start", cf.start(Date.now()), "false");
let got: FeedState | null = null; let polls = 0; const t0 = Date.now();
while (Date.now() - t0 < 10000) {
  const s = cf.poll(Date.now());
  if (existsSync(join(dir, "cat.rc")) || polls > 0) polls++;
  if (s.report) { got = s; break; }
  execFileSync("sleep", ["0.05"]);
}
ok("report read", got !== null && got.report !== null && got.report.sessions.length === 900 && got.code === "ok" && !got.busy, got ? JSON.stringify({ code: got.code, err: got.err, n: got.report ? got.report.sessions.length : -1 }) : "none");
ok("within 5 polls of the rc", polls > 0 && polls <= 6, String(polls));
// a cut report (exit 0, no end line) keeps the previous one
writeFileSync(join(HOME, "cut.jsonl"), reportLines(rep).slice(0, 10).join("\n") + "\n");
process.env["AGENTGLASS_SSH"] = script("ssh-cut", "cat " + JSON.stringify(join(HOME, "cut.jsonl")));
cf.start(Date.now());
let cut: FeedState | null = null; const t1 = Date.now();
while (Date.now() - t1 < 10000) { const s = cf.poll(Date.now()); if (!s.busy) { cut = s; break; } execFileSync("sleep", ["0.05"]); }
ok("cut keeps the report", cut !== null && cut.code === "cut" && cut.report !== null && cut.report.sessions.length === 900, cut ? cut.code + " " + cut.err : "none");
// a fresh feed on the same spool loads the cached report and keeps the last run's status
const again = sshFeed(hc, f, false, (): number => Date.now(), detachedPid, 256);
let ag: FeedState = again.poll(Date.now()); for (let i = 0; i < 10 && !ag.report; i++) ag = again.poll(Date.now());
ok("cached report at start", ag.report !== null && ag.report.sessions.length === 900 && ag.code === "cut", ag.code);
// exit codes from the fake ssh
process.env["AGENTGLASS_SSH"] = script("ssh-255", "echo 'ssh: connect to host gone port 22: Connection refused' >&2; exit 255");
const gone = sshFeed({ name: "gone", ssh: "gone", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "" }, f, false, (): number => Date.now(), detachedPid, 256);
gone.start(Date.now()); let gs: FeedState = gone.poll(Date.now()); const t2 = Date.now();
while (gs.busy && Date.now() - t2 < 10000) { execFileSync("sleep", ["0.05"]); gs = gone.poll(Date.now()); }
ok("exit 255", gs.code === "ssh" && gs.err.indexOf("Connection refused") >= 0 && gs.report === null, gs.code + " " + gs.err);
console.log(bad ? String(bad) + " failed" : "fleet ssh: all checks passed");
if (bad) process.exit(1);
