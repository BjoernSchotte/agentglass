// agentglass — self-check for the per-project aggregation: scriptc build src/features/repos/agg.check.ts -o ag && ./ag
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { P, real, resolveTick, setGit } from "../../model/project.ts";
import { ledger } from "../usage/ledger.ts";
import { type Day, L, newAcc, newDay, todayKey, lastDays } from "../usage/record.ts";
import { newTS, newCnt } from "../usage/calls.ts";
import { parse } from "../query/parse.ts";
import { EMPTY, compile } from "../query/eval.ts";
import { aggregate } from "../query/agg.ts";
import { identOf } from "../query/project.ts";
import { type RepoAgg, repoAgg, relFile, errPct, allDays } from "./agg.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function stub(cmd: string, args: string[]): string { return cmd === "x" ? args.join("") : ""; }
function now(): number { return Date.now(); }
setGit(stub); P.sync = false;

const T = real("/tmp") + "/agag-" + String(process.pid);
rmSync(T, { recursive: true, force: true });
function mk(rel: string, body: string): void { const p = T + "/" + rel; mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, body); }
mk("r1/.git/config", '[remote "origin"]\n\turl = https://github.com/me/x\n'); mk("w1/.git", "gitdir: ../r1/.git/worktrees/w1"); mk("r1/.git/worktrees/w1/commondir", "../..");
mk("o1/.git/config", '[remote "origin"]\n\turl = https://github.com/me/other\n'); mkdirSync(T + "/w1/src", { recursive: true });

const TODAY = todayKey();
interface DaySpec { cost: number; unk: number; calls: number; err: number; act: number[]; files: string[] }
function D(cost: number, calls: number, err: number, act: number[], files: string[]): DaySpec { return { cost, unk: 0, calls, err, act, files }; }
function sess(h: string, id: string, cwd: string, parent: string, branch: string, day: DaySpec): Sess {
  const s = newSess(h, id, "/fx/" + h + "/" + id + ".jsonl", false);
  s.cwd = cwd; s.parent = parent; s.branch = branch; s.headDone = true; s.mtime = Date.now(); sessions.set(s.path, s);
  const a = newAcc(); const d: Day = newDay();
  d.cost = day.cost; d.unk = day.unk; d.act = day.act;
  const st = newTS(); st.n = day.calls; st.err = day.err; d.tt.set("Bash", st);
  for (const f of day.files) { const c = newCnt(); c.n = 1; c.add = 2; c.del = 1; d.files.set("Edit\t" + f, c); }
  a.days.set(TODAY, d); ledger.set(s.path, a);
  return s;
}
sess("claude", "m1", T + "/r1", "", "main", D(2, 6, 1, [600, 660], [T + "/r1/src/a.ts", "/etc/hosts"]));
sess("claude", "sub1", "", "m1", "", D(1, 0, 0, [], []));
sess("codex", "w1", T + "/w1/src", "", "feat/x", D(4, 3, 2, [630, 690], ["../src/a.ts"]));
sess("claude", "sub2", T + "/o1", "m1", "", D(8, 1, 0, [], []));
for (const s of sessions.values()) identOf(s);
resolveTick(1e9, 1e9, now, stub);
L.ver++;

function byKey(rows: RepoAgg[], k: string): RepoAgg | null { for (const r of rows) if (r.key === k) return r; return null; }
const rows = repoAgg([TODAY], null);
const x = byKey(rows, "git:github.com/me/x"); const o = byKey(rows, "git:github.com/me/other");
eq("two projects", String(rows.length), "2");
eq("worktrees merged", x ? [...x.worktrees.keys()].sort().join(",") : "", "r1,w1");
eq("subagent without cwd → parent's project", x ? String(x.cost) : "", "7");
eq("top-level sessions only", x ? String(x.sessions) : "", "2");
eq("subagent with own cwd → its project", o ? String(o.cost) + " " + String(o.sessions) : "", "8 0");
eq("activeMin union", x ? String(x.activeMin) : "", "90"); eq("agentMin sum", x ? String(x.agentMin) : "", "120");
const fa = x ? x.files.get("src/a.ts") : undefined;
eq("file merged across worktrees", fa ? String(fa.n) + " " + [...fa.by].sort().join(",") : "", "2 claude,codex");
eq("outside the repo", x ? String(x.outside.n) : "", "1");
eq("calls/err", x ? String(x.calls) + "/" + String(x.err) : "", "9/3");
eq("errPct under 10", String(errPct(3, 9)), "-1"); eq("errPct 10", String(errPct(3, 10)), "30");
eq("byHarness", x ? [...x.byHarness.keys()].sort().join(",") : "", "claude,codex");
eq("branches", x ? [...x.branches.keys()].sort().join(",") : "", "feat/x,main");
eq("paths newest first", x ? String(x.paths.length) : "", "2");
// filter before grouping
const fc = compile(parse("harness is codex").cs, "stats").f ?? EMPTY;
const rc = repoAgg([TODAY], fc); const xc = byKey(rc, "git:github.com/me/x");
eq("filter: codex share only", xc ? String(xc.cost) + " " + String(xc.sessions) : "", "4 1"); eq("filter: other project gone", String(rc.length), "1");
// cross-check with aggregate()
const dist = aggregate(EMPTY, "session", [TODAY], ["repo"], "cost");
const ds = dist[0]; const bx = ds ? ds.vals.get("me/x") : undefined; const bo = ds ? ds.vals.get("me/other") : undefined;
eq("aggregate parity me/x", bx ? String(bx.w) : "", x ? String(x.cost) : "?"); eq("aggregate parity me/other", bo ? String(bo.w) : "", o ? String(o.cost) : "?");
// cache: unchanged versions → the same array
eq("cached", repoAgg([TODAY], null) === rows ? "same" : "new", "same");
L.ver++; eq("ledger change → recomputed", repoAgg([TODAY], null) === rows ? "same" : "new", "new");
// helpers
eq("relFile abs", relFile("/r", "/r/src", "/r/src/a.ts"), "src/a.ts"); eq("relFile rel", relFile("/r", "/r/src", "b/c.ts"), "src/b/c.ts");
eq("relFile outside", relFile("/r", "/r", "/etc/x"), ""); eq("relFile prefix trap", relFile("/r", "/r", "/rx/a"), ""); eq("relFile ..", relFile("/r", "/r/src", "../x.ts"), "x.ts");
eq("allDays", allDays().join(","), TODAY);
eq("lastDays has today", lastDays(7).indexOf(TODAY) >= 0 ? "y" : "n", "y");

rmSync(T, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "repo agg ok");
if (bad) process.exit(1);
