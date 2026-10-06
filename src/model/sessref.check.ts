// agentglass — self-check for session references and the agent-mode scope: scriptc build src/model/sessref.check.ts -o sr && ./sr
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import type { Sess } from "./types.ts";
import { newSess } from "./types.ts";
import { sessions } from "./sessions.ts";
import { findSession, resolveRef, lastSession } from "./sessref.ts";
import { setHost, scopeOf, inScope, projectKey } from "../features/agentenv.ts";
import { OWN } from "../features/usage/owners.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-sessref-" + String(process.pid);
rmSync(dir, { recursive: true, force: true });
for (const p of ["p1/.git", "p1/sub", "p2/.git", "loose"]) mkdirSync(dir + "/" + p, { recursive: true });
const R = realpathSync(dir); // keys name real paths (macOS: /tmp is /private/tmp)
function put(h: string, id: string, cwd: string, mtime: number, parent: string): Sess {
  const s = newSess(h, id, dir + "/" + h + "-" + id + ".jsonl", false); s.cwd = cwd; s.mtime = mtime; s.parent = parent; sessions.set(s.path, s); return s;
}
const a = put("claude", "aaaaaa-1111", dir + "/p1", 100, "");
const b = put("codex", "aaaaaa-2222", dir + "/p1/sub", 300, "");
const c = put("claude", "cccccc-3333", dir + "/p2", 500, "");
const sub = put("claude", "agent-x1", dir + "/p1", 400, "aaaaaa-1111");
put("gemini", "zz-old", dir + "/p1", 50, "");
function f(ref: string): string { const r = findSession(ref, (x: Sess): boolean => true); return String(r.code) + "|" + (r.s ? r.s.id : "-") + "|" + r.cands.map((x: Sess) => x.id).join(","); }

eq("exact id", f("cccccc-3333"), "0|cccccc-3333|");
eq("exact subagent id", f("agent-x1"), "0|agent-x1|");
eq("harness:id", f("codex:aaaaaa-2222"), "0|aaaaaa-2222|");
eq("harness:id wrong harness", f("claude:aaaaaa-2222"), "3|-|");
eq("bogus harness", f("bogus:aaaaaa-2222"), "3|-|");
eq("unique 6-char prefix", f("cccccc"), "0|cccccc-3333|");
eq("shared prefix: ambiguous, newest first", f("aaaaaa"), "4|-|aaaaaa-2222,aaaaaa-1111");
eq("too short", f("ccc"), "2|-|");
eq("unknown", f("zzzzzz"), "3|-|");
// scoped: out-of-scope matches never decide and are never named
function fs(ref: string): string { const r = findSession(ref, (x: Sess): boolean => x.cwd.startsWith(dir + "/p1")); return String(r.code) + "|" + r.err + "|" + (r.s ? r.s.id : "-") + "|" + r.cands.map((x: Sess) => x.id).join(","); }
eq("scoped: other project's id", fs("cccccc-3333"), "3|out_of_scope|-|");
eq("scoped: other project's prefix", fs("cccccc"), "3|out_of_scope|-|");
eq("scoped: in-scope id", fs("aaaaaa-1111"), "0||aaaaaa-1111|");
put("claude", "aaaaaa-9999", dir + "/p2", 900, "");
eq("scoped: a shared prefix resolves to the in-scope pair only", fs("aaaaaa"), "4|ambiguous|-|aaaaaa-2222,aaaaaa-1111");
eq("scoped: prefix unique in scope", fs("aaaaaa-1"), "0||aaaaaa-1111|");

// twins: one Claude session under two project dirs (a project moved or copied with its ~/.claude dir) is ONE session — a
// full id, <harness>:<id> or a prefix of it picks the owning copy (the one at home, owners.ts OWN.home; then the newest),
// never "ambiguous"; only different sessions are, and every candidate's <harness>:<id> then resolves
{
  const tw = (proj: string, mtime: number): Sess => { const x = newSess("claude", "b39ecea3-0000-4000-8000-000000000001", dir + "/" + proj + "/b39ecea3-0000-4000-8000-000000000001.jsonl", false); x.cwd = dir + "/p1"; x.mtime = mtime; sessions.set(x.path, x); return x; };
  const home = tw("-w-p1", 100); const away = tw("-w-p1-copy", 200); // the copy is newer: home still owns
  const was = OWN.home; OWN.home = (p: string): boolean => p === home.path;
  const fp = (ref: string): string => { const r = findSession(ref, (x: Sess): boolean => true); return String(r.code) + "|" + (r.s ? r.s.path.slice(dir.length) : "-") + "|" + r.hint; };
  eq("twins: full id → the home copy", fp("b39ecea3-0000-4000-8000-000000000001"), "0|/-w-p1/b39ecea3-0000-4000-8000-000000000001.jsonl|");
  eq("twins: harness:id → the home copy", fp("claude:b39ecea3-0000-4000-8000-000000000001"), "0|/-w-p1/b39ecea3-0000-4000-8000-000000000001.jsonl|");
  eq("twins: a prefix → the home copy", fp("b39ecea3"), "0|/-w-p1/b39ecea3-0000-4000-8000-000000000001.jsonl|");
  OWN.home = (p: string): boolean => true; // both at home (no cwd known): the newest
  eq("twins, no home decides: the newest", fp("b39ecea3"), "0|/-w-p1-copy/b39ecea3-0000-4000-8000-000000000001.jsonl|");
  OWN.home = was;
  // a different session under the same prefix: ambiguous, one candidate per session, and the hint names ids that work
  const other = put("claude", "b39ecea3-ffff-4000-8000-000000000002", dir + "/p2", 300, "");
  const r = findSession("b39ecea3", (x: Sess): boolean => true);
  eq("different sessions: ambiguous, one candidate each", String(r.code) + "|" + r.cands.map((x: Sess) => x.id).join(","), "4|b39ecea3-ffff-4000-8000-000000000002,b39ecea3-0000-4000-8000-000000000001");
  eq("hint names the full refs", r.hint, "use one of: claude:b39ecea3-ffff-4000-8000-000000000002, claude:b39ecea3-0000-4000-8000-000000000001");
  for (const c2 of r.cands) eq("candidate resolves: " + c2.id, String(findSession(c2.h + ":" + c2.id, (x: Sess): boolean => true).code), "0");
  for (const x of [home, away, other]) sessions.delete(x.path);
}

// last: newest top-level session of the cwd's project (sub dirs count), not the current one
eq("last from p1", (lastSession(dir + "/p1", null) ?? c).id, "aaaaaa-2222");
eq("last excludes current", (lastSession(dir + "/p1", b) ?? c).id, "aaaaaa-1111");
eq("last of a dir without sessions", String(lastSession(dir + "/loose", null) === null), "true");
// current / parent via the env session id (no process list here)
setHost({ on: true, harness: "claude", session: "agent-x1", via: "env:CLAUDECODE" });
eq("current", (resolveRef("current", false, (x: Sess): boolean => true).s ?? c).id, "agent-x1");
eq("current --root", (resolveRef("current", true, (x: Sess): boolean => true).s ?? c).id, "aaaaaa-1111");
eq("parent", (resolveRef("parent", false, (x: Sess): boolean => true).s ?? c).id, "aaaaaa-1111");
setHost({ on: true, harness: "claude", session: "", via: "env:CLAUDECODE" });
const nc = resolveRef("current", false, (x: Sess): boolean => true);
eq("no current", String(nc.code) + "|" + nc.err, "3|no_current_session");

// scope
eq("project key: git root", projectKey(dir + "/p1/sub"), "git:" + R + "/p1");
mkdirSync(dir + "/wt", { recursive: true }); writeFileSync(dir + "/wt/.git", "gitdir: " + dir + "/p1/.git/worktrees/wt\n");
eq("project key: a worktree is its main repo", projectKey(dir + "/wt"), "git:" + R + "/p1");
eq("project key: plain dir", projectKey(dir + "/loose"), "path:" + R + "/loose");
const sc = scopeOf(true, [], "", dir + "/p1");
eq("agent default: project", sc.name + "|" + sc.key, "project|git:" + R + "/p1");
eq("same project in scope", String(inScope(b, sc)), "true");
eq("other project out of scope", String(inScope(c, sc)), "false");
eq("unknown cwd out of scope", String(inScope(put("pi", "nocwd", "", 1, ""), sc)), "false");
eq("--all-projects", String(inScope(c, scopeOf(true, ["--all-projects"], "", dir + "/p1"))), "true");
eq("config all", scopeOf(true, [], "all", dir + "/p1").name, "all");
eq("config all + --project-only", scopeOf(true, ["--project-only"], "all", dir + "/p1").name, "project");
const ev = scopeOf(true, [], "everyone", dir + "/p1");
eq("invalid config → project + warning", ev.name + "|" + String(ev.warn !== ""), "project|true");
eq("outside agent mode: all", scopeOf(false, [], "", dir + "/p1").name, "all");
eq("sub session in scope", String(inScope(sub, sc)), "true");

rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "sessref: all checks passed");
if (bad) process.exit(1);
