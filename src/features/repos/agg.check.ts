// agentglass — self-check for the per-project aggregation: scriptc build src/features/repos/agg.check.ts -o ag && ./ag
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { P, real, resolveTick, setGit } from "../../model/project.ts";
import { ledger } from "../usage/ledger.ts";
import { type Acc, type Day, L, newAcc, newDay, todayKey, lastDays, bucket, tool, pend, flushSpans, startOfDay, dayKey, heavy } from "../usage/record.ts";
import { MQ_MSG } from "../usage/facts.ts";
import { newTS, newCnt, done } from "../usage/calls.ts";
import { parse } from "../query/parse.ts";
import { EMPTY, compile } from "../query/eval.ts";
import { aggregate } from "../query/agg.ts";
import { identOf } from "../query/project.ts";
import { type RepoAgg, type BranchAgg, repoAgg, relFile, errPct, allDays, periodCommits, bookBranches, ownPr } from "./agg.ts";
import { type GitInfo, newInfo, tally } from "../vcs/attrib.ts";

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
  const st = newTS(); st.n = day.calls; st.err = day.err; heavy(d).tt.set("Bash", st);
  for (const f of day.files) { const c = newCnt(); c.n = 1; c.add = 2; c.del = 1; heavy(d).files.set("Edit\t" + f, c); }
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
// active time end to end (hand-computed): lines through bucket(), a tool run, midnight, two parallel sessions
// A: a line every 4 min 10:00–11:00 → [600,661) = 61 · B: every 3 min 10:30–11:30 → [630,691) = 61, then 12:00 + a
// 20-min Bash → [720,741) = 21 · D: 23:58 yesterday → 00:02 today → today [0,3) = 3, yesterday [1438,1440) = 2
// today: union [0,3) ∪ [600,691) ∪ [720,741) = 3 + 91 + 21 = 115; sum 61 + 82 + 3 = 146; with yesterday +2 / +2
mk("r5/.git/config", '[remote "origin"]\n\turl = https://github.com/me/five\n');
const SOD = startOfDay();
const at = (dayOff: number, hh: number, mm: number): number => SOD + dayOff * 86400000 + (hh * 60 + mm) * 60000;
const YDAY = dayKey(new Date(at(-1, 12, 0)));
function live(id: string, times: number[]): Acc {
  const s = newSess("claude", id, "/fx/claude/" + id + ".jsonl", false); s.cwd = T + "/r5"; s.headDone = true; s.mtime = Date.now(); sessions.set(s.path, s);
  const a = newAcc(); for (let i = 0; i < times.length; i++) bucket(a, 0, new Date(times[i] ?? 0).toISOString()); ledger.set(s.path, a); return a;
}
const ta: number[] = []; for (let m = 0; m <= 60; m += 4) ta.push(at(0, 10, m)); live("ea", ta);
const tb: number[] = []; for (let m = 30; m <= 90; m += 3) tb.push(at(0, 10, m)); const ab = live("eb", tb);
const db = bucket(ab, 0, new Date(at(0, 12, 0)).toISOString()); const stb = tool(ab, db, "Bash", "m", MQ_MSG);
pend(ab, db, stb, "Bash", "t1", at(0, 12, 0), new Date(at(0, 12, 0)).toISOString(), "{}", []);
const pb = ab.pend.get("t1"); if (pb) done(pb, 20 * 60000, false, 0, "t1", []); flushSpans(ab);
live("ed", [at(-1, 23, 58), at(0, 0, 2)]);
for (const s of sessions.values()) identOf(s);
resolveTick(1e9, 1e9, now, stub); L.ver++;
const e1 = byKey(repoAgg([TODAY], null), "git:github.com/me/five");
eq("e2e active today (union)", e1 ? String(e1.activeMin) : "", "115"); eq("e2e agent-minutes today (sum)", e1 ? String(e1.agentMin) : "", "146");
const e2 = byKey(repoAgg([YDAY, TODAY], null), "git:github.com/me/five");
eq("e2e two days", e2 ? String(e2.activeMin) + " " + String(e2.agentMin) : "", "117 148");
// helpers
eq("relFile abs", relFile("/r", "/r/src", "/r/src/a.ts"), "src/a.ts"); eq("relFile rel", relFile("/r", "/r/src", "b/c.ts"), "src/b/c.ts");
eq("relFile outside", relFile("/r", "/r", "/etc/x"), ""); eq("relFile prefix trap", relFile("/r", "/r", "/rx/a"), ""); eq("relFile ..", relFile("/r", "/r/src", "../x.ts"), "x.ts");
eq("allDays", allDays().join(","), [YDAY, TODAY].join(","));
eq("lastDays has today", lastDays(7).indexOf(TODAY) >= 0 ? "y" : "n", "y");

// git linkage: ✓ commits per project, spend without commits, branches split by commit count
mk("r6/.git/config", '[remote "origin"]\n\turl = https://github.com/me/six\n'); mk("r6/.git/HEAD", "ref: refs/heads/main\n");
const nowMs = at(0, 10, 0);
function gsess(id: string, cost: number, shas: string[], brs: string[]): void {
  const s = newSess("claude", id, "/fx/claude/" + id + ".jsonl", false); s.cwd = T + "/r6"; s.headDone = true; s.mtime = Date.now(); s.branch = "main"; sessions.set(s.path, s);
  const a = newAcc(); const d = bucket(a, 0, new Date(nowMs).toISOString()); d.cost = cost; a.cost = cost;
  for (let i = 0; i < shas.length; i++) a.vcs.push({ k: "commit", v: shas[i] ?? "", t: nowMs, how: "observed", br: brs[i] ?? "", subj: "x", call: "c", ts: "" });
  if (id === "g1") a.vcs.push({ k: "pr", v: "https://github.com/me/six/pull/4", t: nowMs, how: "created", br: "", subj: "", call: "c", ts: "" });
  if (id === "g1") a.vcs.push({ k: "pr", v: "https://github.com/me/tap/pull/9", t: nowMs, how: "created", br: "", subj: "", call: "c", ts: "" }); // another repo's PR
  ledger.set(s.path, a);
}
gsess("g1", 4, ["aaaaaaa", "bbbbbbb"], ["main", "main"]); gsess("g2", 1, [], []);
for (const s of sessions.values()) identOf(s);
resolveTick(1e9, 1e9, now, stub); L.ver++;
const g6 = byKey(repoAgg([TODAY], null), "git:github.com/me/six");
eq("repo commits", g6 ? String(g6.commits) : "-", "2"); eq("spend without commits", g6 ? String(g6.spendNoCommit) : "-", "1");
const bm = g6 ? g6.branches.get("main") : undefined;
eq("branch main commits + $/commit", bm ? String(bm.commits) + " " + (bm.cost / bm.commits).toFixed(2) + " sess " + String(bm.sess) : "-", "2 2.50 sess 2");
eq("created PRs of the project's own remote", g6 ? g6.prs.join(",") : "-", "https://github.com/me/six/pull/4");
eq("ownPr ssh remote", String(ownPr("https://github.com/Me/Six/pull/1", "ssh://github.com/me/six")) + String(ownPr("https://github.com/me/sixx/pull/1", "ssh://github.com/me/six")) + String(ownPr("https://x.io/a/b/pull/1", "")), "truefalsetrue");
// one session, one commit on main and one on f, cost 2: one each
const gi: GitInfo = newInfo();
gi.commits.push({ sha: "a", br: "main", subj: "", at: nowMs, how: "observed", counted: true, status: "unknown", merge: false, add: -1, del: -1, files: -1, call: "", ts: "", path: "" });
gi.commits.push({ sha: "b", br: "f", subj: "", at: nowMs, how: "observed", counted: true, status: "unknown", merge: false, add: -1, del: -1, files: -1, call: "", ts: "", path: "" });
gi.commits.push({ sha: "c", br: "f", subj: "", at: nowMs, how: "reflog", counted: false, status: "present", merge: false, add: -1, del: -1, files: -1, call: "", ts: "", path: "" });
gi.commits.push({ sha: "d", br: "main", subj: "", at: at(-1, 10, 0), how: "observed", counted: true, status: "unknown", merge: false, add: -1, del: -1, files: -1, call: "", ts: "", path: "" });
tally(gi);
const pc = periodCommits(gi, new Set<string>([TODAY]));
eq("period commits: ✓ only, today only", String(pc.n), "2");
const bm2 = new Map<string, BranchAgg>(); bookBranches(bm2, pc, "main", true, 2, 0);
const bf = bm2.get("f"); const bmn = bm2.get("main");
eq("split by commit count", (bmn ? String(bmn.cost) + "/" + String(bmn.commits) : "-") + " " + (bf ? String(bf.cost) + "/" + String(bf.commits) : "-"), "1/1 1/1");

rmSync(T, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "repo agg ok");
if (bad) process.exit(1);
