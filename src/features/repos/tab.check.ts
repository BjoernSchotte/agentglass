// agentglass — self-check for the Repos tab helpers and the @ jump: scriptc build src/features/repos/tab.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H } from "../../hooks.ts";
import { sessions, buildView } from "../../model/sessions.ts";
import { P, real, resolveTick, setGit } from "../../model/project.ts";
import { ledger } from "../usage/ledger.ts";
import { type Day, L, newAcc, newDay, todayKey } from "../usage/record.ts";
import { newTS, newCnt } from "../usage/calls.ts";
import { identOf } from "../query/project.ts";
import { type RepoAgg, type HarnessAgg, repoAgg } from "./agg.ts";
import { hm, mixBar, sortRepos, detailSessions, topFiles, topErrTools, reposState } from "./tab.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function HA(cost: number, sess: number): HarnessAgg { return { sess, cost, unk: 0 }; }
function cells(xs: string[]): string { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].map((e: [string, number]) => e[0] + ":" + String(e[1])).join(","); }

// mix bar
const m1 = new Map<string, HarnessAgg>(); m1.set("claude", HA(3, 1)); m1.set("codex", HA(1, 1));
eq("mix by cost", cells(mixBar(m1, 8)), "claude:6,codex:2");
const m2 = new Map<string, HarnessAgg>(); m2.set("pi", HA(0, 2)); m2.set("kiro", HA(0, 2));
eq("mix by sessions when unpriced", String(mixBar(m2, 8).length) + " " + cells(mixBar(m2, 8)).split(",").sort().join(","), "8 kiro:4,pi:4");
const m3 = new Map<string, HarnessAgg>(); m3.set("claude", HA(99, 1)); m3.set("gemini", HA(1, 1));
eq("1% share gets a cell", cells(mixBar(m3, 8)), "claude:7,gemini:1");
eq("empty", String(mixBar(new Map<string, HarnessAgg>(), 8).length), "0");
// hm
eq("hm 552", hm(552), "9h12m"); eq("hm 65", hm(65), "1h05m"); eq("hm 12", hm(12), "12m"); eq("hm 0", hm(0), "0m");

// a small project setup for sort/detail/@
setGit((c: string, a: string[]): string => c + a.join("") === "" ? "x" : ""); P.sync = false;
const T = real("/tmp") + "/agtc-" + String(process.pid);
rmSync(T, { recursive: true, force: true });
function mk(rel: string, body: string): void { const p = T + "/" + rel; mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, body); }
mk("r1/.git/config", '[remote "origin"]\n\turl = https://github.com/me/x\n'); mk("w1/.git", "gitdir: ../r1/.git/worktrees/w1"); mk("r1/.git/worktrees/w1/commondir", "../..");
mk("r2/.git/config", '[remote "origin"]\n\turl = https://github.com/me/b\n');
const TODAY = todayKey();
function sess(h: string, id: string, cwd: string, cost: number, calls: number, err: number, files: string[], act: number[], mtime: number): Sess {
  const s = newSess(h, id, "/fx/" + h + "/" + id + ".jsonl", false);
  s.cwd = cwd; s.headDone = true; s.mtime = mtime; s.last = mtime; sessions.set(s.path, s);
  const a = newAcc(); const d: Day = newDay(); d.cost = cost; d.act = act;
  const st = newTS(); st.n = calls; st.err = err; d.tt.set(h === "codex" ? "exec" : "Bash", st);
  for (const f of files) { const c = newCnt(); c.n = 2; d.files.set("Edit\t" + f, c); }
  a.days.set(TODAY, d); ledger.set(s.path, a); return s;
}
const now = Date.now();
const a1 = sess("claude", "a1", T + "/r1", 5, 20, 2, [T + "/r1/src/a.ts", T + "/r1/README.md", "/etc/hosts"], [600, 700], now - 3000);
const a2 = sess("codex", "a2", T + "/w1", 1, 10, 5, [T + "/w1/src/a.ts"], [650, 660], now - 1000);
const b1 = sess("pi", "b1", T + "/r2", 2, 5, 0, [], [100, 400], now - 2000);
for (const s of sessions.values()) identOf(s);
resolveTick(1e9, 1e9, (): number => Date.now(), (c: string, a: string[]): string => c + a.join("") === "" ? "x" : "");
L.ver++; buildView();
const rows = repoAgg([TODAY], null);
const lab = (rs: RepoAgg[]): string => rs.map((r: RepoAgg) => r.label).join(",");
eq("sort cost", lab(sortRepos(rows, "cost")), "me/x,me/b"); eq("sort active", lab(sortRepos(rows, "active")), "me/b,me/x");
eq("sort sessions", lab(sortRepos(rows, "sessions")), "me/x,me/b"); eq("sort err (me/b under 10 calls → ·, last)", lab(sortRepos(rows, "err")), "me/x,me/b");
eq("sort last", lab(sortRepos(rows, "last")), "me/x,me/b");
let rx: RepoAgg | null = null; for (const r of rows) if (r.label === "me/x") rx = r;
if (rx) {
  eq("detail sessions newest first", detailSessions(rx, "").map((p: string) => p.slice(p.lastIndexOf("/") + 1)).join(","), "a2.jsonl,a1.jsonl");
  eq("file chip across worktrees", detailSessions(rx, "src/a.ts").length === 2 ? "2" : "x", "2");
  eq("file chip narrows", detailSessions(rx, "README.md").map((p: string) => p.slice(p.lastIndexOf("/") + 1)).join(","), "a1.jsonl");
  const tf = topFiles(rx, 20); eq("top files: outside last", tf.map((e) => e[0] || "(outside)").join(","), "src/a.ts,README.md,(outside)");
  eq("top err tools", topErrTools(rx, 8).map((e) => e[0] + ":" + String(e[1].err)).join(","), "exec:5,Bash:2");
} else eq("me/x row", "missing", "present");
// @ from the Sessions list
S.mode = "list"; S.tab = 0; S.view = [a2, a1, b1]; S.sel = 1;
let handled = false; for (const f of H.keys) if (f("list", "@")) { handled = true; break; }
const st = reposState();
eq("@ handled", handled ? "y" : "n", "y"); eq("@ tab", String(S.tab), String(2 + H.tabs.findIndex((t) => t.name === "Repos")));
eq("@ detail", st.detail, "git:github.com/me/x");

rmSync(T, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "repos tab ok");
if (bad) process.exit(1);
