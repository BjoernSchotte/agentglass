// agentglass — agent-wait live collection: shell argv parsing, heavy commands per watched session, subtree RSS, the
// open-call fallback, host load parsing
// check: ffi
// SPDX-License-Identifier: Apache-2.0
// The argv check runs a real shell in Claude Code's command format and reads it back through this OS's process table
// (Linux /proc, macOS libproc in the ffi build): CI's macOS job proves the format parses there too.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proc } from "../../model/types.ts";
import { OS } from "../../platform/index.ts";
import { fxReset, fxSession, isoAt } from "../query/fixture.ts";
import { allProcs } from "../../model/procs.ts";
import { type Run, shellCmd, collectLive, heavyNow, famCounts, parseLoad } from "./live.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function pr(pid: number, ppid: number, etime: string, rss: number, args: string): Proc { return { pid, ppid, cpu: 0, rss, etime, tty: "??", args, h: "", start: 0, cwd: "", tcpu: 0, trss: 0, kids: 0, sess: "" }; }
function q(s: string): string { return JSON.stringify(s); }

// argv → the command a shell runs: Claude's eval '…', else the text after -c (combined flags too)
eq("claude eval", shellCmd("/usr/bin/zsh -c source /h/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval 'pnpm test -- --run' \\< /dev/null && pwd -P >| /tmp/claude-1-cwd"), "pnpm test -- --run");
eq("bash -lc", shellCmd("bash -lc cargo build"), "cargo build");
eq("eval quotes", shellCmd("/bin/zsh -c eval 'echo '\\''a b'\\'' && tsc'"), "echo 'a b' && tsc");
eq("plain sh", shellCmd("/bin/sh"), "");
eq("sh -c", shellCmd("/bin/sh -c npx tsc --noEmit"), "npx tsc --noEmit");
eq("login shell", shellCmd("-zsh"), "");
eq("bash -e -c", shellCmd("bash -e -c pnpm lint"), "pnpm lint");
// Claude Code 2.1 quotes a ' inside the eval word as '"'"' (and adds < /dev/null only without an input redirect)
eq("eval '\"'\"' quotes", shellCmd("/usr/bin/zsh -c source /h/s.sh 2>/dev/null || true && eval 'grep -n '\"'\"'a b'\"'\"' x | head -3' && pwd -P >| /tmp/c-cwd"), "grep -n 'a b' x | head -3");
eq("eval word in double quotes", shellCmd("/bin/bash -c eval \"echo \\\"hi\\\" \\$HOME\" < /dev/null && pwd -P >| /tmp/c-cwd"), "echo \"hi\" $HOME");
eq("eval bare word", shellCmd("/bin/zsh -c source /h/s.sh && eval ls\\ -la && pwd -P"), "ls -la");
eq("eval with lines before it", shellCmd("/usr/bin/zsh -c source /h/s.sh 2>/dev/null || true && export A='1'\nexport B='2'\n: && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval 'pnpm test' < /dev/null && pwd -P >| /tmp/c-cwd"), "pnpm test");
// only Claude's wrapper (… && eval <word> … && pwd -P) is unwrapped: an eval inside another harness's -c text is the command's own
eq("eval in a -c text", shellCmd("bash -c make all && eval foo"), "make all && eval foo");
eq("eval word ends at an operator", shellCmd("/bin/zsh -c source /h/s.sh && eval 'pnpm test'</dev/null && pwd -P >| /tmp/c-cwd"), "pnpm test");
eq("eval word, quote never closed", shellCmd("/bin/zsh -c source /h/s.sh && eval 'pnpm test && pwd -P"), "pnpm test && pwd -P");

// a real shell in Claude Code's format, read back from the process table (the macOS CI job runs this in the ffi build)
{
  const sh = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh"; const cwdf = join(tmpdir(), "agentglass-live-check-" + String(process.pid) + "-cwd");
  const cmd = "source /nonexistent/snapshot.sh 2>/dev/null || true && eval 'sleep 3 && echo '\"'\"'it is done'\"'\"'' < /dev/null && pwd -P >| " + cwdf;
  const ch = spawn(sh, ["-c", cmd], { stdio: "ignore" }); const pid = ch.pid ?? 0;
  let args = "";
  for (let k = 0; k < 40 && !args; k++) { spawnSync("sleep", ["0.05"]); for (const r of OS.listProcs(new Set<number>([pid]), (c: string): boolean => true, true)) if (r.pid === pid) args = r.args; }
  ch.kill("SIGKILL");
  eq("real " + sh + ": argv read back (" + process.platform + ")", shellCmd(args), "sleep 3 && echo 'it is done'");
  rmSync(cwdf, { force: true });
}

// three watched agents: a Claude-shaped shell with a node child, a -c shell, and one with no tree but an open call
function bash(id: string, cmd: string, hh: number): string {
  return "{\"type\":\"assistant\",\"timestamp\":" + q(isoAt(0, hh, 0)) + ",\"message\":{\"id\":\"m" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":" + q(id) + ",\"name\":\"Bash\",\"input\":{\"command\":" + q(cmd) + "}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}";
}
fxReset();
const a = fxSession("claude", "A", "/w/a", "", "claude-sonnet-4-5", []); a.pid = 100;
const b = fxSession("claude", "B", "/w/b", "", "claude-sonnet-4-5", [bash("b1", "npx tsc", 0)]); b.pid = 300;
const c = fxSession("claude", "C", "/w/c", "", "claude-sonnet-4-5", [bash("c1", "uv run pytest -q", 0)]); c.pid = 500;
const d = fxSession("claude", "D", "/w/d", "", "claude-sonnet-4-5", []); d.pid = 700;
const kids = new Map<number, Proc[]>();
const K = 1024; // Proc.rss is bytes
kids.set(100, [pr(200, 100, "02:10", 3000 * K, "/usr/bin/zsh -c eval 'pnpm test' \\< /dev/null")]);
kids.set(200, [pr(201, 200, "02:09", 900000 * K, "node vitest")]);
kids.set(300, [pr(400, 300, "00:40", 2000 * K, "/bin/bash -c npx tsc"), pr(402, 300, "1:00:00", 50000 * K, "node /x/mcp-server.js")]);
kids.set(400, [pr(401, 400, "00:39", 600000 * K, "node tsc")]);
kids.set(700, [pr(800, 700, "00:05", 1000 * K, "/bin/zsh -c eval 'git status'"), pr(810, 700, "7-22:03:19", 1000, "sh -c playwright-mcp"), pr(820, 700, "1-00:00:00", 1000, "sh -c pnpm test")]);
const now = Date.now();
const lw = collectLive([a, b, c, d], kids, now);
const rs = lw.running.slice().sort((x: Run, y: Run) => x.pid - y.pid);
function show(r: Run): string { return r.path.slice(r.path.lastIndexOf("/") + 1) + " " + r.family + " " + r.kind + " " + String(r.heavy) + " rss" + String(r.rssKb) + " bg" + String(r.bg) + " age" + String(r.ageSec); }
eq("runs", String(rs.length), "4");
eq("fallback run", rs[0] ? show(rs[0]) : "", "C.jsonl pytest test true rss-1 bgfalse age" + String(Math.floor((now - Date.parse(isoAt(0, 0, 0))) / 1000)));
eq("claude run", rs[1] ? show(rs[1]) : "", "A.jsonl pnpm test test true rss903000 bgtrue age130");
eq("open call names the run, the tree its memory", rs[2] ? show(rs[2]) : "", "B.jsonl tsc typecheck true rss602000 bgfalse age" + String(Math.floor((now - Date.parse(isoAt(0, 0, 0))) / 1000)));
eq("light run", rs[3] ? show(rs[3]) : "", "D.jsonl git status vcs false rss1000 bgtrue age5");
eq("heavy now", String(heavyNow(lw, "", "").length), "3");
eq("heavy now family", String(heavyNow(lw, "pnpm test", "").length), "1");
eq("heavy now kind", String(heavyNow(lw, "", "typecheck").length), "1");
eq("host figures not read (nobody wants them)", String(lw.load1) + " " + String(lw.memAvailPct), "-1 -1");

// one root process shared by several sessions (a daemon): its shells cannot be told apart → open calls only
const e = fxSession("claude", "E", "/w/e", "", "claude-sonnet-4-5", [bash("e1", "pnpm lint", 0)]); e.pid = 900;
const f = fxSession("claude", "F", "/w/f", "", "claude-sonnet-4-5", []); f.pid = 900;
kids.set(900, [pr(901, 900, "00:10", 1000, "/bin/sh -c pnpm build")]);
const sh = collectLive([e, f], kids, now);
eq("shared root", sh.running.map((r: Run): string => r.family + " rss" + String(r.rssKb)).join(","), "pnpm lint rss-1");

// Gemini runs a command inside a wrapper script (its lines are steps); a stray option is no program
const gm = fxSession("gemini", "G", "/w/g", "", "gemini-2.5-flash", []); gm.pid = 1100;
const gk = new Map<number, Proc[]>();
gk.set(1100, [pr(1101, 1100, "00:20", 1000, "/bin/bash -c shopt -u promptvars nullglob extglob; _bgpids_file=/tmp/g/bgpids.tmp\n(\n  trap 'jobs -p > \"$_bgpids_file\"' EXIT\nnpm test\n)\n__code=$?\nexit $__code"), pr(1102, 1100, "00:10", 1000, "/bin/zsh -c -d -f pnpm lint")]);
eq("gemini wrapper", collectLive([gm], gk, now).running.map((r: Run): string => r.family + "/" + r.kind).join(","), "npm test/test,pnpm lint/lint");

// OpenCode runs `npm test` without a shell: npm's own `sh -c` is the shell found; the command is its ancestor below the agent
const oc = fxSession("opencode", "O", "/w/o", "", "claude-sonnet-4-5", []); oc.pid = 1200;
const ok2 = new Map<number, Proc[]>();
const npmP = pr(1201, 1200, "00:30", 50000 * K, "npm test"); const shP = pr(1202, 1201, "00:30", 2000 * K, "sh -c sleep 300 && echo ok");
ok2.set(1200, [npmP]); ok2.set(1201, [shP]); allProcs.set(1201, npmP); allProcs.set(1202, shP);
eq("command without a shell", collectLive([oc], ok2, now).running.map((r: Run): string => r.family + " rss" + String(r.rssKb)).join(","), "npm test rss52000");
allProcs.clear();
// an agent with agentglass-mcp running a CLI child (which runs a shell) and its own pnpm test: only pnpm test is listed
const mc = fxSession("claude", "M", "/w/m", "", "claude-sonnet-4-5", []); mc.pid = 1300;
const mk = new Map<number, Proc[]>();
mk.set(1300, [pr(1301, 1300, "10:00", 1000, "/opt/bin/agentglass-mcp"), pr(1310, 1300, "00:10", 1000, "/bin/zsh -c pnpm test")]);
mk.set(1301, [pr(1302, 1301, "00:01", 1000, "agentglass session current --format json")]);
mk.set(1302, [pr(1303, 1302, "00:01", 1000, "sh -c stty size < /dev/tty")]);
eq("agentglass-mcp never a run", collectLive([mc], mk, now).running.map((r: Run): string => r.family).join(","), "pnpm test");
// a third-party MCP server that runs a test for the agent: a real run (only agentglass-mcp's subtree is skipped)
const mo = new Map<number, Proc[]>(); // (a new map: toolShells memoizes per map)
mo.set(1300, [pr(1320, 1300, "10:00", 1000, "node /x/mcp-server.js")]);
mo.set(1320, [pr(1321, 1320, "00:10", 1000, "/bin/sh -c pnpm test")]);
eq("other mcp server's run listed", collectLive([mc], mo, now).running.map((r: Run): string => r.family).join(","), "pnpm test");

// counts: by count, then name; ≤ 60 characters
function run(fam: string): Run { return { path: "/p", h: "claude", family: fam, kind: "test", heavy: true, ageSec: 1, rssKb: 1, pid: 1, bg: false }; }
eq("famCounts", famCounts([run("tsc"), run("pnpm test"), run("pnpm test")]), "pnpm test ×2, tsc");
eq("famCounts tie", famCounts([run("b"), run("a")]), "a, b");
const long = famCounts([run("a".repeat(30)), run("b".repeat(30)), run("c".repeat(30))]);
eq("famCounts cut", String(long.length <= 60) + " " + String(long.endsWith("…")), "true true");
// /proc/loadavg + /proc/meminfo
const pl = parseLoad("5.04 5.92 4.64 2/10996 1", "MemTotal:       128137748 kB\nMemFree:  1 kB\nMemAvailable:   49274876 kB\n");
eq("parseLoad", String(pl.load1) + " " + String(pl.memAvailPct), "5.04 38");
const bad2 = parseLoad("", "");
eq("parseLoad empty", String(bad2.load1) + " " + String(bad2.memAvailPct), "-1 -1");

console.log(bad ? bad + " failed" : "live: all checks passed");
if (bad) process.exit(1);
