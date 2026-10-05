// agentglass — self-check for process → harness detection: scriptc build src/model/procs.check.ts -o prc && ./prc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync } from "node:fs";
import { harnessOfArgs, linkOne, wakeScan } from "./procs.ts";
import type { Proc } from "./types.ts";
import { WAKE_H, WAKE_DIRS, listDirCached, FS_STATS, FS_CLOCK } from "../util/fs.ts";
import { projectDirOf } from "../harness/claude.ts";
import { CLAUDE, CODEX } from "../util/fs.ts";
import { newSess, type Sess } from "./types.ts";
import { H } from "../hooks.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const cases: string[][] = [
  ["node /u/.nvm/versions/node/v24/bin/gemini -p hi", "gemini"], // launcher
  ["node --max-old-space-size=8192 /u/lib/node_modules/@google/gemini-cli/bundle/gemini.js -p hi", "gemini"], // relaunched child
  ["node --no-warnings=DEP0040 --max-old-space-size=8192 /x/bundle/gemini.js", "gemini"],
  ["/usr/local/bin/gemini", "gemini"], // SEA binary
  ["node /x/pi.js", "pi"],
  ["node /x/dist/cli.js", ""],
  ["node --inspect", ""], // only flags: nothing to name
  ["node -r ./hook.js /u/bin/gemini -p hi", "gemini"], // a flag with a separate value is no script
  ["node --require /x/pi.js --import /y/loader.mjs /u/bin/gemini", "gemini"],
  ["node --inspect-port 9229 /x/pi.js", "pi"],
  ["node -e 1", ""], // inline code: no script
  ["/usr/bin/aider --model x", "aider"],
  ["claude --resume abc", "claude"],
];
for (const c of cases) { const got = harnessOfArgs(c[0]); ok(c[0], got === c[1], JSON.stringify(got) + " ≠ " + c[1]); }
// linking a session to its process: H.meta (redact fakes the name) runs only when the linked name changed or s.name was
// rewritten since; the real name never stays in s.name
let metas = 0;
H.meta.push((s: Sess): void => { metas++; if (s.name && !s.name.startsWith("F-")) s.name = "F-" + s.name; });
const ls = newSess("codex", "l1", "/l/1", false);
ok("first link runs meta", linkOne(ls, 42, "busy", "real") && ls.name === "F-real" && ls.pid === 42, ls.name);
const m0 = metas;
ok("same link under H.meta (--redact): meta again, fake kept", linkOne(ls, 42, "idle", "real") && ls.name === "F-real" && ls.status === "idle" && metas === m0 + 1, ls.name);
ok("other name: meta again", linkOne(ls, 42, "idle", "other") && ls.name === "F-other", ls.name);
ls.name = "nick"; // a re-parse set it (codex nickname): the link wins again, as before
ok("name rewritten elsewhere: relinked", linkOne(ls, 42, "idle", "other") && ls.name === "F-other", ls.name);
ok("unlinked: name cleared", linkOne(ls, 0, "", "") && ls.name === "" && ls.pid === 0, ls.name);
H.meta.pop(); // without --redact: a link that did not change is skipped
const ns = newSess("codex", "l2", "/l/2", false);
ok("no meta: first link", linkOne(ns, 7, "busy", "x") && ns.name === "x", ns.name);
ok("no meta: same link skipped", !linkOne(ns, 7, "idle", "x") && ns.status === "idle", ns.status);
// a new agent with no session yet wakes the scan of quiet dirs: Claude its project dir (named from the cwd), any other
// harness all of its dirs; a linked agent wakes nothing
function pr(pid: number, h: string, cwd: string, sess: string): Proc { return { pid, ppid: 1, cpu: 0, rss: 0, etime: "", tty: "", args: h, h, cwd, tcpu: 0, trss: 0, kids: 0, sess }; }
ok("claude project dir from a cwd", projectDirOf("/home/u/.herdr/work_trees/x-1") === CLAUDE + "/projects/-home-u--herdr-work-trees-x-1", projectDirOf("/home/u/.herdr/work_trees/x-1"));
WAKE_H.clear();
wakeScan([pr(10, "claude", "/home/u/proj", ""), pr(11, "codex", "/home/u/p2", ""), pr(12, "gemini", "/w", "/s/linked.json"), pr(13, "pi", "", ""), pr(14, "opencode", "/o", ""), pr(15, "kiro", "/k", ""), pr(16, "fx", "/f", "")], 5000);
ok("claude: its project dir", WAKE_DIRS.has(CLAUDE + "/projects/-home-u-proj") && !WAKE_H.has("claude"), [...WAKE_DIRS].join(","));
let codexDir = false; for (const d of WAKE_DIRS) if (d.startsWith(CODEX + "/sessions/")) codexDir = true;
ok("codex: today's rollout dir", codexDir && !WAKE_H.has("codex"), [...WAKE_DIRS].join(","));
ok("pi, opencode, kiro, fx: their harness", WAKE_H.get("pi") === 5000 && WAKE_H.get("opencode") === 5000 && WAKE_H.get("kiro") === 5000 && WAKE_H.get("fx") === 5000, [...WAKE_H.keys()].join(","));
ok("a linked agent wakes nothing", !WAKE_H.has("gemini"), "");
// a quiet dir is looked at again while woken (harness or dir), and not after the minute
const qd = "/tmp/agentglass-wake-check-" + String(process.pid); mkdirSync(qd, { recursive: true });
let fnow = Date.now() + 3600000 * 3; FS_CLOCK.now = (): number => fnow;
listDirCached(qd, 0, "codex"); fnow += 1000; WAKE_H.set("codex", fnow - 70000); let st0 = FS_STATS.stats; listDirCached(qd, 0, "codex");
ok("quiet, not woken: no stat", FS_STATS.stats === st0, "");
WAKE_H.set("codex", fnow); st0 = FS_STATS.stats; listDirCached(qd, 0, "codex");
ok("woken harness: stat", FS_STATS.stats === st0 + 1, "");
WAKE_H.clear(); WAKE_DIRS.add(qd); st0 = FS_STATS.stats; listDirCached(qd, 0, "claude");
ok("woken dir: stat", FS_STATS.stats === st0 + 1, "");
WAKE_DIRS.clear(); rmSync(qd, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "procs: all checks passed (" + String(cases.length + 14) + " cases)"); process.exit(bad ? 1 : 0);
