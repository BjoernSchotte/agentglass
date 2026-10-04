// agentglass — self-check for the git preview line and view rows: scriptc build src/features/vcs/view.check.ts -o vv && ./vv
// SPDX-License-Identifier: Apache-2.0
import { perCommit, previewLine, viewRows, merged, type Row } from "./view.ts";
import { type GitInfo, type GCommit, type GLink, newInfo, tally } from "./attrib.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function gc(sha: string, how: string, at: number): GCommit { return { sha, br: "main", subj: "s" + sha, at, how, counted: how === "observed", status: "present", merge: false, add: 1, del: 2, files: 1, call: "c", ts: "", path: "/p" }; }
function gl(url: string, n: number, how: string): GLink { return { url, n, how, call: "", ts: "", path: "/p" }; }
function info(cs: GCommit[], prs: GLink[]): GitInfo { const g = newInfo(); for (const c of cs) g.commits.push(c); for (const l of prs) g.prs.push(l); tally(g); return g; }

const g = info([gc("aaaaaaa", "observed", 1), gc("bbbbbbb", "observed", 2), gc("ccccccc", "observed", 3), gc("ddddddd", "reflog", 4), gc("eeeeeee", "shared", 5)], [gl("https://github.com/o/r/pull/142", 142, "created")]);
eq("preview line", previewLine(g, 2.52, 0, "api"), "3 commits (✓3 · ≈1 · ?1 shared not counted) · PR #142 (created) · $0.84/commit");
eq("estimate marker off API", perCommit(2.52, 0, 3, "plan"), "≈$0.84/commit");
eq("no commits, no $/commit", previewLine(info([], [gl("https://github.com/o/r/pull/9", 9, "mentioned")]), 5, 0, "api"), "PR #9 (mentioned)");
eq("only ≈", previewLine(info([gc("ddddddd", "reflog", 4)], []), 5, 0, "api"), "0 commits (✓0 · ≈1 not counted)");
eq("unpriced", perCommit(0, 1000, 2, "api"), "?/commit");
eq("zero commits", perCommit(3, 0, 0, "api"), "");
eq("nothing", previewLine(newInfo(), 1, 0, "api"), "");

// rows: ✓ before ≈ before shared; created PR before mentioned; ≈/shared dim
const g2 = info([gc("ddddddd", "reflog", 1), gc("eeeeeee", "shared", 0), gc("aaaaaaa", "observed", 9)], [gl("https://github.com/o/r/pull/1", 1, "created"), gl("https://github.com/o/r/pull/2", 2, "mentioned")]);
const rs = viewRows(g2, 0, 120);
eq("row order", rs.map((r: Row) => r.mark + (r.kind === "commit" ? r.copy.slice(0, 1) : r.copy.slice(-1)) + (r.dim ? "d" : "")).join(" "), "✓a ≈dd ?ed ⇡1 ⇡2d");
eq("not counted note", rs.length > 1 && rs[1].text.indexOf("not counted") >= 0 ? "y" : "n", "y");
eq("diff stat column", rs.length ? (rs[0].text.indexOf("+1 −2") >= 0 ? "y" : "n") : "-", "y");
// a parent with its subagent: the sub's ✓ wins over the parent's ≈ of the same sha; counts add up
const par = info([gc("aaaaaaa", "reflog", 1)], []); const sub = info([gc("aaaaaaa", "observed", 1), gc("bbbbbbb", "observed", 2)], []);
const m = merged([par, sub]);
eq("merge leaves the parent's own row alone", par.commits.length ? par.commits[0].how : "-", "reflog");
eq("merged", m.commits.map((c: GCommit) => c.sha.slice(0, 1) + c.how).join(" ") + " =" + String(m.produced), "aobserved bobserved =2");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("view ok");
