// agentglass — self-check for compare's detail sections: scriptc build src/features/compare/sections.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { fxSession } from "../query/fixture.ts";
import { type Group, groupOfSession, groupOfExpr, compareGroups } from "./metrics.ts";
import { toolRows, cntRows, fileLists, modelRows, timeline } from "./sections.ts";
import { TMP, cmpBase, cmpCleanup, sess, editLine } from "./fixture.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }

cmpBase();
const A = groupOfSession(sess("a1"));
function G(src: string): Group { const r = groupOfExpr(src); return r.g ?? A; }
const c = compareGroups(A, groupOfSession(sess("b1")), [], true, null);
const tr = toolRows(c, new Set<string>());
eq("tool order by |Δshare|", tr.rows.map((r) => r.label).join(","), "Bash,Read,Edit,Grep,github");
eq("no significance under 50", String(tr.significance), "false");
eq("no χ² under 50", tr.rows.map((r) => String(r.chi2)).join(","), "-1,-1,-1,-1,-1");
eq("mcp grouped", tr.rows.filter((r) => r.server).map((r) => r.key + "=" + String(r.nA) + "/" + String(r.nB)).join(","), "mcp__github=1/2");
eq("shares and Δpp", tr.rows.slice(0, 1).map((r) => r.shA.toFixed(2) + " " + r.shB.toFixed(2) + " " + r.dpp.toFixed(1) + " err " + String(r.errA) + "/" + String(r.errB)).join(""), "0.40 0.10 -30.0 err 1/0");
eq("p95 per tool", tr.rows.slice(0, 1).map((r) => String(r.p95A) + "/" + String(r.p95B)).join(""), "3536/1000");
const op = toolRows(c, new Set<string>(["mcp__github"]));
eq("mcp expanded", op.rows.filter((r) => r.kid).map((r) => r.label).join(","), "get_issue,list_prs");
eq("kids right after their server", op.rows.map((r) => r.label).join(","), "Bash,Read,Edit,Grep,github,get_issue,list_prs");
const fl = fileLists(c);
eq("files root", fl.root === TMP + "/app" ? "root" : fl.root, "root");
eq("only A", fl.onlyA.map((f) => f.shown).join(","), "src/a.ts");
eq("only B", fl.onlyB.map((f) => f.shown).join(","), "src/b.ts");
eq("both", fl.both.map((f) => f.shown + " " + String(f.addA) + "/" + String(f.delA) + " " + String(f.addB) + "/" + String(f.delB)).join(","), "src/shared.ts 1/0 2/2");
eq("abs path for enter", fl.onlyA.map((f) => f.abs).join(","), TMP + "/app/src/a.ts");
const cross = compareGroups(A, G("harness is fx"), [], true, null); // f1 lives in TMP/app too → same root
eq("files root (same repo, other harness)", fileLists(cross).root === TMP + "/app" ? "root" : "none", "root");
fxSession("claude", "z1", "/elsewhere/proj", "", "claude-sonnet-4-5", editLine("/elsewhere/proj/x.ts"));
const other = compareGroups(A, groupOfSession(sess("z1")), [], true, null);
eq("files root (different repos) → ~ paths", fileLists(other).root, "");
eq("~ paths keep absolute paths outside home", fileLists(other).onlyB.map((f) => f.shown).join(","), "/elsewhere/proj/x.ts");
const pr = cntRows(c, "prog"); eq("programs", pr.map((r) => r.key + "=" + String(r.nA) + "/" + String(r.nB) + " err " + String(r.errA) + "/" + String(r.errB)).join(","), "npm=2/1 err 1/0");
const cm = cntRows(c, "cmds"); eq("commands", cm.map((r) => r.key + "=" + String(r.nA) + "/" + String(r.nB)).join(","), "npm test=2/1");
const tl = timeline(c); eq("timeline slots", tl ? tl.a.slice(0, 5).join(",") + " | " + tl.b.slice(0, 1).join(",") + " | " + String(tl.slot) : "null", "1,1,1,1,1 | 1 | 300000");
eq("timeline length", tl ? String(tl.a.length) + "/" + String(tl.b.length) : "", "5/10");
eq("no timeline for groups", timeline(compareGroups(A, G("harness is fx"), [], true, null)) === null ? "null" : "shown", "null");
const md = modelRows(c); eq("models calls", md.rows.map((m) => m.model + " " + String(m.callsA) + "/" + String(m.callsB)).join(","), "claude-opus-4-5 0/8,claude-sonnet-4-5 5/2");
eq("models tokens from buckets", md.rows.map((m) => m.model + " " + String(m.tokA) + "/" + String(m.tokB)).join(","), "claude-opus-4-5 0/7200,claude-sonnet-4-5 2400/850");
eq("models not limited (all today)", String(md.limited), "false");
const mx = modelRows(compareGroups(A, groupOfSession(sess("b1")), [], false, null));
eq("models without subagents", mx.rows.map((m) => m.model + " " + String(m.callsA) + "/" + String(m.callsB)).join(","), "claude-opus-4-5 0/8,claude-sonnet-4-5 5/0");
const mf = modelRows(cross); eq("rows without a model: unknown", mf.rows.filter((m) => m.model === "unknown").map((m) => String(m.callsB) + " calls, " + String(m.tokB) + " tokens").join(""), "1 calls, 0 tokens");
// a cwd through a symlink (macOS: /tmp → /private/tmp): the repo root resolves, the recorded paths keep the link's form;
// both sides in one repo still show repo-relative paths, and the header names the root as the paths spell it
cmpBase(); execFileSync("ln", ["-s", TMP + "/app", TMP + "/link"]); // scriptc has no symlinkSync
const l1 = fxSession("claude", "l1", TMP + "/link", "", "claude-sonnet-4-5", editLine(TMP + "/link/src/c.ts"));
const l2 = fxSession("claude", "l2", TMP + "/link", "", "claude-sonnet-4-5", editLine(TMP + "/link/src/d.ts"));
const fll = fileLists(compareGroups(groupOfSession(l1), groupOfSession(l2), [], true, null));
eq("symlinked cwd: relative paths", fll.onlyA.map((f) => f.shown).join(",") + " " + fll.onlyB.map((f) => f.shown).join(","), "src/c.ts src/d.ts");
eq("symlinked cwd: root as recorded", fll.root, TMP + "/link");
const flm = fileLists(compareGroups(A, groupOfSession(l2), [], true, null)); // one side via the link, one direct
eq("link and direct: one repo", flm.onlyB.map((f) => f.shown).join(",") + " | " + flm.onlyA.map((f) => f.shown).join(","), "src/d.ts | src/a.ts,src/shared.ts");
cmpCleanup();
console.log(bad ? String(bad) + " failed" : "compare sections: all checks passed");
if (bad) process.exit(1);
