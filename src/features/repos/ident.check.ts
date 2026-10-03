// agentglass — self-check for session project identity, repo filter values and redaction: scriptc build src/features/repos/ident.check.ts -o ic && AGENTGLASS_REDACT=1 ./ic
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { applyMeta, display } from "../../hooks.ts";
import { P, real, resolveTick, setGit, rememberSess } from "../../model/project.ts";
import { parse } from "../query/parse.ts";
import { EMPTY, compile, sessMatches } from "../query/eval.ts";
import { projectOf, projectRoot } from "../query/project.ts";
import { realCwd } from "../redact.ts";
import { REDACT } from "../redact-on.ts";
import { identOf, repoLabel } from "./ident.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function stub(cmd: string, args: string[]): string { return cmd + args.join(" ") === "" ? "x" : ""; }
function now(): number { return Date.now(); }
setGit(stub);
P.sync = false; // the TUI path: queue, then a tick

const T = real("/tmp") + "/agic-" + String(process.pid);
rmSync(T, { recursive: true, force: true });
function mk(rel: string, body: string): void { const p = T + "/" + rel; mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, body); }
const cfg = (url: string): string => '[remote "origin"]\n\turl = ' + url + "\n";
mk("r1/.git/config", cfg("git@github.com:me/x.git")); mk("r1/.git/HEAD", "x");
mk("w1/.git", "gitdir: ../r1/.git/worktrees/w1"); mk("r1/.git/worktrees/w1/commondir", "../.."); mk("r1/.git/worktrees/w1/HEAD", "x");
mk("r3/.git/config", "[core]\n"); mkdirSync(T + "/plain", { recursive: true }); mkdirSync(T + "/w1/src", { recursive: true });

function sess(h: string, id: string, cwd: string, parent: string): Sess {
  const s = newSess(h, id, "/fx/" + h + "/" + id + ".jsonl", false);
  s.cwd = cwd; s.parent = parent; s.headDone = true; sessions.set(s.path, s); return s;
}
const main = sess("claude", "m1", T + "/r1", "");
const wt = sess("claude", "w1", T + "/w1/src", "");
const sub = sess("claude", "sub1", "", "w1");
const gone = sess("codex", "g1", T + "/deleted", ""); gone.remote = "https://github.com/me/x";
const loc = sess("codex", "l1", T + "/r3", "");
const pl = sess("pi", "p1", T + "/plain", "");
const unread = newSess("claude", "u1", "/fx/claude/u1.jsonl", false); sessions.set(unread.path, unread); // head not read: cwd unknown

eq("unresolved → null", identOf(wt) === null ? "null" : "x", "null");
eq("projectOf basename until resolved", projectOf(T + "/w1/src"), "src");
for (const s of sessions.values()) identOf(s);
resolveTick(1e9, 1e9, now, stub);
const im = identOf(main); const iw = identOf(wt);
eq("worktree session = main key", iw ? iw.key : "", "git:github.com/me/x"); eq("main key", im ? im.key : "", "git:github.com/me/x");
eq("worktree name", iw ? iw.worktree : "", "w1");
const is = identOf(sub); eq("subagent → parent identity", is ? is.key + " " + is.worktree : "", "git:github.com/me/x w1");
const ig = identOf(gone); eq("gone cwd + remote", ig ? ig.key + " " + ig.kind : "", "git:github.com/me/x git");
eq("head unread → null", identOf(unread) === null ? "null" : "x", "null");
unread.headDone = true; const iu = identOf(unread); eq("no cwd after head → none", iu ? iu.kind : "", "none");
// a subagent reads its own head before taking its parent's project (a worktree-isolated one works elsewhere)
const subU = newSess("claude", "sub2", "/fx/claude/sub2.jsonl", false); subU.parent = "w1"; sessions.set(subU.path, subU);
eq("subagent head unread → null (not the parent's)", identOf(subU) === null ? "null" : "x", "null");
subU.headDone = true; const isu = identOf(subU); eq("subagent head read, no cwd → parent", isu ? isu.worktree : "", "w1");
const orphanP = newSess("claude", "op", "/fx/claude/op.jsonl", false); sessions.set(orphanP.path, orphanP);
const subP = sess("claude", "sub3", "", "op");
eq("parent head unread → null", identOf(subP) === null ? "null" : "x", "null");
// huge first lines: no cwd in the head, the tail is still unread → unresolved, not "(no project)"
const big = sess("claude", "big", "", ""); big.size = 5000000;
eq("cwd only in the unread tail → null", identOf(big) === null ? "null" : "x", "null");
big.tailSize = big.size; const ib = identOf(big); eq("tail read, still no cwd → none", ib ? ib.kind : "", "none");
// after a restart the remembered cwd (projects.json) wins over the parent's
const subR = sess("claude", "sub4", "", "m1"); rememberSess(subR.path, T + "/w1");
identOf(subR); resolveTick(1e9, 1e9, now, stub); const isr = identOf(subR); eq("remembered cwd beats the parent", isr ? isr.worktree : "", "w1");
for (const x of [subU, orphanP, subP, big, subR]) sessions.delete(x.path);
eq("repoLabel", repoLabel(wt), "me/x");
eq("projectOf after resolve", projectOf(T + "/w1/src"), "me/x");
eq("projectRoot worktree → main", projectRoot(T + "/w1/src"), T + "/r1");
eq("projectRoot non-git", projectRoot(T + "/plain"), "");

// filters
function M(src: string): string {
  const p = parse(src); if (p.err) return "ERR " + p.err.msg;
  const r = compile(p.cs, "stats"); if (!r.f) return "ERR " + (r.err ? r.err.msg : "");
  const f = r.f ?? EMPTY; const out: string[] = [];
  for (const s of sessions.values()) if (sessMatches(f, s)) out.push(s.id);
  return out.sort().join(",");
}
eq("repo is label", M("repo is me/x"), "g1,m1,sub1,w1");
eq("repo ~ key", M("repo ~ github.com/me"), "g1,m1,sub1,w1");
eq("repo basename for non-git", M("repo is plain"), "p1");
eq("worktree is", M("worktree is w1"), "sub1,w1");
eq("project.kind gitdir", M("project.kind is gitdir"), "l1");
eq("project.kind path", M("project.kind is path"), "p1");

// redaction (checks run with AGENTGLASS_REDACT=1)
eq("redact on", REDACT ? "y" : "n", "y");
const f1 = display("repo", "me/project-x", null); const f2 = display("repo", "me/project-x", null);
eq("repo faked", f1 !== "me/project-x" ? "y" : f1, "y"); eq("repo shape", String(f1.split("/").length), "2"); eq("repo stable", f2, f1);
const fh = display("repo", "github.com/acmecorp/secretproj", null);
eq("host kept", fh.startsWith("github.com/") && fh.indexOf("secretproj") < 0 ? "y" : fh, "y");
eq("no project kept", display("repo", "(no project)", null), "(no project)");
const fr = display("remote", "https://github.com/acmecorp/secretproj", null);
eq("remote faked", fr.startsWith("https://github.com/") && fr.indexOf("secretproj") < 0 && fr.indexOf("acmecorp") < 0 ? "y" : fr, "y");
const rs = sess("claude", "rd1", T + "/w1", "");
applyMeta(rs);
eq("realCwd keeps the real path", realCwd(rs), T + "/w1"); eq("s.cwd faked", rs.cwd !== T + "/w1" ? "y" : "n", "y");
identOf(rs); resolveTick(1e9, 1e9, now, stub); const ir = identOf(rs); eq("identity from the real cwd", ir ? ir.key : "", "git:github.com/me/x");

rmSync(T, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "repo ident ok");
if (bad) process.exit(1);
