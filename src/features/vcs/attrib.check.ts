// agentglass — self-check for git-linkage attribution: scriptc build src/features/vcs/attrib.check.ts -o ac && ./ac
// SPDX-License-Identifier: Apache-2.0
import { type SessIn, type GitInfo, type GCommit, attribute, attributeWith, windowOf, windowLog, userEmail, parseLog } from "./attrib.ts";
import type { RefEv } from "./reflog.ts";
import type { VRef } from "../usage/vcs.ts";
import { intOf } from "../../util/config.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function sha(c: string): string { return c.repeat(40).slice(0, 40); }
function ev(c: string, at: number, op: string, br: string): RefEv { return { at, old: "", sha: sha(c), op, branch: br, subj: "s" + c, amended: false }; }
function vr(k: string, v: string, t: number): VRef { return { k, v, t, how: "observed", br: "main", subj: "b", call: "c1", ts: "" }; }
function si(path: string, gitdir: string, t0: number, t1: number, refs: VRef[]): SessIn { return { path, gitdir, common: gitdir, key: "git:h/o/r", top: "/r", branch: "main", t0, t1, live: false, sub: false, refs }; }
function show(m: Map<string, GitInfo>, p: string): string {
  const g = m.get(p); if (!g) return "-";
  const o: string[] = []; for (const c of g.commits) o.push(c.sha.slice(0, 1) + ":" + c.how + (c.counted ? "+" : "") + (c.status === "amended" ? "(am)" : ""));
  return o.join(" ") + " =" + String(g.produced);
}
function logs(gd: string, evs: RefEv[]): Map<string, RefEv[]> { const m = new Map<string, RefEv[]>(); m.set(gd, evs); return m; }

// two sessions in one worktree, overlapping windows: a reflog commit inside both is shared on both, counted in neither
let m = attribute([si("A", "X", 0, 10000, []), si("B", "X", 5000, 20000, [])], logs("X", [ev("a", 7000, "commit", "main")]));
eq("shared on A", show(m, "A"), "a:shared =0"); eq("shared on B", show(m, "B"), "a:shared =0");
// two worktrees: each gitdir's commits stay with its own sessions
const two = new Map<string, RefEv[]>(); two.set("X", [ev("a", 7000, "commit", "main")]); two.set("Y", [ev("b", 7000, "commit", "f")]);
m = attribute([si("A", "X", 0, 10000, []), si("B", "Y", 0, 10000, [])], two);
eq("worktree X", show(m, "A"), "a:reflog =0"); eq("worktree Y", show(m, "B"), "b:reflog =0");
// a banner wins: ✓ on A, absent on B although B's window covers it
m = attribute([si("A", "X", 0, 10000, [vr("commit", "aaaaaaa", 7000)]), si("B", "X", 0, 20000, [])], logs("X", [ev("a", 7000, "commit", "main")]));
eq("banner observed on A", show(m, "A"), "a:observed+ =1"); eq("not on B", show(m, "B"), " =0");
// a quiet commit inside A's git call span [1000, 2000] + 5 s is ✓; just after it it is ≈
m = attribute([si("A", "X", 0, 100000, [vr("gcall", "1000-2000", 1000)])], logs("X", [ev("a", 7000, "commit", "main"), ev("b", 7001, "commit", "main")]));
eq("span edge", show(m, "A"), "a:observed+ b:reflog =1");
// reflog times are truncated to seconds: a commit at 31.9 s inside a call started at 31.5 s is logged at 31 s
m = attribute([si("A", "X", 0, 100000, [vr("gcall", "31500-32000", 31500)])], logs("X", [ev("a", 31000, "commit", "main"), ev("b", 30499, "commit", "main")]));
eq("reflog seconds", show(m, "A"), "b:reflog a:observed+ =1");
// outside every window: nobody gets it
m = attribute([si("A", "X", 0, 10000, [])], logs("X", [ev("a", 50000, "commit", "main")]));
eq("outside every window", show(m, "A"), " =0");
// tail pad: 20 min after the last activity is in the window only with pad 30
const af = 1000000; const al = 2000000; const t = al + 20 * 60000;
const w0 = windowOf(af, al, false, 0, 0); const w30 = windowOf(af, al, false, 30, 0);
eq("window head", String(w0[0] ?? 0), String(af - 120000));
m = attribute([si("A", "X", w0[0] ?? 0, w0[1] ?? 0, [])], logs("X", [ev("a", t, "commit", "main")])); eq("pad 0", show(m, "A"), " =0");
m = attribute([si("A", "X", w30[0] ?? 0, w30[1] ?? 0, [])], logs("X", [ev("a", t, "commit", "main")])); eq("pad 30", show(m, "A"), "a:reflog =0");
eq("no activity, no window", String(windowOf(0, 0, false, 10, 0).length), "0");
eq("live window ends now", String(windowOf(1000, 2000, true, 0, 9000)[1] ?? 0), "9000");
// amend chain commit → amend → amend, all observed: counted once
const c1 = ev("a", 1000, "commit", "main"); const c2 = ev("b", 2000, "amend", "main"); const c3 = ev("c", 3000, "amend", "main");
c2.old = c1.sha; c3.old = c2.sha; c1.amended = true; c2.amended = true;
m = attribute([si("A", "X", 0, 10000, [vr("commit", "aaaaaaa", 1000), vr("commit", "bbbbbbb", 2000), vr("commit", "ccccccc", 3000)])], logs("X", [c1, c2, c3]));
eq("amend chain", show(m, "A"), "a:observed(am) b:observed(am) c:observed+ =1");
// a banner sha absent from the reflog: unknown, counted (enrichment may turn it into elsewhere)
m = attribute([si("A", "X", 0, 10000, [vr("commit", "ddddddd", 1000)])], logs("X", []));
const g0 = m.get("A"); const r0: GCommit | null = g0 && g0.commits.length ? g0.commits[0] : null;
eq("absent banner", r0 ? r0.status + (r0.counted ? "+" : "") : "-", "unknown+");
// a banner sha in no reflog although the reflog reaches back before it: still unknown and counted (a removed worktree took
// its reflog along; seen on real data) — only enrichment's object-DB check can say elsewhere
m = attribute([si("A", "X", 0, 10000, [vr("commit", "fffffff", 5000)])], logs("X", [ev("a", 1000, "commit", "main")]));
const ge = m.get("A"); let re0: GCommit | null = null; if (ge) for (const c of ge.commits) if (c.sha === "fffffff") re0 = c;
eq("absent banner, reflog reaching back", re0 ? re0.status + (re0.counted ? "+" : "") : "-", "unknown+");
// …but on a branch the repo has never had, after the reflog's start: made in another repo (a test script's temp repo:
// `sh probe.sh` printing "[g 9318fc4] fc") — elsewhere, never counted; a detached banner or an older one stays unknown+
{ const brs = (common: string, br: string): boolean => common === "X" && (br === "main" || br === "feat");
  const vb = (v: string, t: number, br: string): VRef => { const r = vr("commit", v, t); r.br = br; return r; };
  const st = (mm: Map<string, GitInfo>, v: string): string => { const gg = mm.get("A"); if (gg) for (const c of gg.commits) if (c.sha === v) return c.status + (c.counted ? "+" : ""); return "-"; };
  m = attributeWith([si("A", "X", 0, 10000, [vb("ggggggg", 5000, "g"), vb("eeeeeee", 5000, "feat"), vb("ccccccc", 5000, ""), vb("bbbbbbb", 500, "g")])], logs("X", [ev("a", 1000, "commit", "main")]), new Map<string, string[]>(), brs);
  eq("foreign branch banner", st(m, "ggggggg"), "elsewhere"); eq("known branch banner", st(m, "eeeeeee"), "unknown+");
  eq("detached banner", st(m, "ccccccc"), "unknown+"); eq("banner older than the reflog", st(m, "bbbbbbb"), "unknown+");
  const gx = m.get("A"); eq("foreign banner not produced", gx ? String(gx.produced) : "-", "3"); }
// a banner made in another worktree of the same repo (cd ../wt && git commit): found in that worktree's reflog —
// observed and counted there, never ≈ for a session working in that worktree
{ const lg = logs("X", [ev("a", 1000, "commit", "main")]); lg.set("W", [ev("w", 5000, "commit", "feat")]);
  const pe = new Map<string, string[]>(); pe.set("C", ["X", "W"]);
  const a0 = si("A", "X", 0, 10000, [vr("commit", "wwwwwww", 5000)]); a0.common = "C"; const b0 = si("B", "W", 0, 10000, []); b0.common = "C";
  m = attributeWith([a0, b0], lg, pe);
  const gw = m.get("A"); let rw: GCommit | null = null; if (gw) for (const c of gw.commits) if (c.sha.startsWith("w")) rw = c;
  eq("peer worktree banner", rw ? rw.how + ":" + rw.status + (rw.counted ? "+" : "") + ":" + rw.br : "-", "observed:present+:main");
  eq("peer worktree: not ≈ for its own sessions", show(m, "B"), " =0"); }
// byBranch: one counted commit on main, one on f
m = attribute([si("A", "X", 0, 10000, [vr("gcall", "1-9000", 1)])], logs("X", [ev("a", 1000, "commit", "main"), ev("b", 2000, "commit", "f")]));
const gb = m.get("A");
eq("byBranch", gb ? String(gb.byBranch.get("main") ?? 0) + "/" + String(gb.byBranch.get("f") ?? 0) : "-", "1/1");
// two sessions' git calls hold the same quiet commit: shared, not counted
m = attribute([si("A", "X", 0, 10000, [vr("gcall", "1000-2000", 1000)]), si("B", "X", 0, 10000, [vr("gcall", "1500-2500", 1500)])], logs("X", [ev("a", 1800, "commit", "main")]));
eq("both spans", show(m, "A") + " | " + show(m, "B"), "a:shared =0 | a:shared =0");
// a subagent's window does not make a parent's ≈ shared
const sub = si("S", "X", 0, 10000, []); sub.sub = true;
m = attribute([si("A", "X", 0, 10000, []), sub], logs("X", [ev("a", 5000, "commit", "main")]));
eq("subagent window ignored", show(m, "A") + " | " + show(m, "S"), "a:reflog =0 |  =0");
// merges count only through the session's own git call
m = attribute([si("A", "X", 0, 20000, [vr("gcall", "4000-4500", 4000)])], logs("X", [ev("m", 4200, "merge", "main"), ev("n", 12000, "merge", "main")]));
eq("merges", show(m, "A"), "m:observed+ n:reflog =1");
// no reflog: noReflog flag
m = attribute([si("A", "Q", 0, 10000, [])], new Map<string, RefEv[]>());
const gq = m.get("A"); eq("no reflog flag", gq && gq.noReflog ? "y" : "n", "y");

// ── window git log fallback ──
const calls: string[] = [];
const stub = (cmd: string, args: string[]): string => {
  calls.push(args.join(" "));
  if (args.indexOf("config") >= 0) return "a@b\n";
  return sha("1") + "\x1f1700000100\x1fsecond\x1e\n" + sha("2") + "\x1f1700000000\x1ffirst\x1e\n";
};
const wl = windowLog("/s.jsonl", "/r", "/r/.git", "", 1700000000000, 1700000200500, stub);
eq("window log records (oldest first)", wl.map((e: RefEv) => e.subj + "@" + String(e.at)).join(","), "first@1700000000000,second@1700000100000");
eq("window log args", calls.length > 1 ? calls[1] ?? "" : "", "-C /r log --branches --since=@1700000000 --until=@1700000201 --author=a@b --format=%H%x1f%ct%x1f%s%x1e");
windowLog("/s.jsonl", "/r", "/r/.git", "", 1700000000000, 1700000200500, stub);
eq("window log cached", String(calls.length), "2");
eq("email cached per repo", userEmail("/r", stub) + String(calls.length), "a@b2");
eq("parseLog skips garbage", String(parseLog("junk\x1e" + sha("3") + "\x1f1\x1fx\x1e").length), "1");
// git.tailPadMin validation (intSetting's rule; it adds the one startup toast)
eq("tailPadMin -1", String(intOf(-1, 0, 120, 10)), "10"); eq("tailPadMin 30", String(intOf(30, 0, 120, 10)), "30"); eq("tailPadMin 121", String(intOf(121, 0, 120, 10)), "10");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("attrib ok");
