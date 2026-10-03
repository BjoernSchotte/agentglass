// agentglass — self-check for project identity (remote normalization, resolution, cache): scriptc build src/model/project.check.ts -o pc && ./pc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { run } from "../util/fs.ts";
import { home } from "../util/text.ts";
import { readFileSync } from "node:fs";
import { iniRemotes, hasInclude, pickRemote, normRemote, type Ident, resolveCwd, subOf, real, cfgMtime,
  P, identOfCwd, resolveTick, labelOf, rememberSess, cwdOfSess, loadProjects, saveProjects, resetProjects } from "./project.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function N(raw: string): string { const n = normRemote(raw); return n ? n.key + " | " + n.label : "null"; }

// ── normalization table (spec 1.5) ──
eq("https .git", N("https://github.com/Me/X.git"), "git:github.com/me/x | Me/X");
eq("scp", N("git@github.com:me/x"), "git:github.com/me/x | me/x");
eq("ssh default port, trailing /", N("ssh://git@github.com:22/me/x/"), "git:github.com/me/x | me/x");
eq("host case + 443", N("https://GitHub.com:443/Me/X"), "git:github.com/me/x | Me/X");
eq("self-hosted keeps case", N("https://git.example.com/Me/X"), "git:git.example.com/Me/X | Me/X");
eq("self-hosted lower", N("https://git.example.com/me/x"), "git:git.example.com/me/x | me/x");
eq("custom port kept", N("ssh://git@git.example.com:2222/team/app.git"), "git:git.example.com:2222/team/app | team/app");
eq("gitlab subgroups", N("https://gitlab.com/Group/Sub/Proj"), "git:gitlab.com/group/sub/proj | Sub/Proj");
eq("userinfo token scrubbed", N("https://x-access-token:ghs_abc@github.com/o/r"), "git:github.com/o/r | o/r");
const tok = normRemote("https://x-access-token:ghs_abc@github.com/o/r");
eq("scrubbed url", tok ? tok.url : "", "https://github.com/o/r");
eq("http default port", N("http://git.example.com:80/a/b"), "git:git.example.com/a/b | a/b");
eq("alias → null", N("gh:owner/repo"), "null");
eq("collapse //", N("https://github.com//me//x.git/"), "git:github.com/me/x | me/x");
eq("one segment", N("https://git.example.com/solo"), "git:git.example.com/solo | solo");
eq("localhost ok", N("ssh://git@localhost/a/b"), "git:localhost/a/b | a/b");
eq("garbage", N("not a url"), "null");
eq("empty", N(""), "null");
const l1 = normRemote("/srv/git/x.git"); const l2 = normRemote("file:///srv/git/x.git");
eq("local path label", l1 ? l1.label : "", "x");
eq("local path key", l1 ? l1.key : "", "git:file/srv/git/x");
eq("file:// = path", l2 ? l2.key : "", l1 ? l1.key : "?");

// ── INI ──
const up = iniRemotes('[remote "upstream"]\n\turl = https://a/u\n[remote "origin"]\n\turl = https://a/o\n');
eq("ini count", String(up.length), "2");
const p1 = pickRemote(up); eq("origin wins", p1 ? p1.name + " " + p1.url : "", "origin https://a/o");
const p2 = pickRemote(iniRemotes('[remote "fork"]\nurl=https://a/f\n[remote "upstream"]\n url = https://a/u')); eq("upstream next", p2 ? p2.name : "", "upstream");
const p3 = pickRemote(iniRemotes('[remote "b"]\n url = https://a/b\n[remote "c"]\n url = https://a/c')); eq("first in file order", p3 ? p3.name : "", "b");
eq("no remotes", pickRemote(iniRemotes("[core]\n\tbare = false\n")) === null ? "null" : "x", "null");
eq("comment ignored", String(iniRemotes('[remote "o"]\n# url = x\n; url = y\n\turl = "https://q/r" ; trailing\n').map((r) => r.url).join(",")), "https://q/r");
eq("first url per section", iniRemotes('[remote "o"]\n url = https://a/1\n url = https://a/2').map((r) => r.url).join(","), "https://a/1");
eq("section name case-insensitive", iniRemotes('[Remote "origin"]\n URL = https://a/1').map((r) => r.name + " " + r.url).join(","), "origin https://a/1");
eq("url outside remote", String(iniRemotes('[branch "main"]\n url = https://x/y').length), "0");
eq("includeIf", hasInclude('[core]\n[includeIf "gitdir:~/w/"]\n\tpath = x') ? "y" : "n", "y");
eq("include", hasInclude("[include]\n\tpath = x") ? "y" : "n", "y");
eq("no include", hasInclude('[remote "o"]\n url = include') ? "y" : "n", "n");

// ── resolution from the filesystem (temp repos) ──
const T = real("/tmp") + "/agpc-" + String(process.pid);
rmSync(T, { recursive: true, force: true });
function mk(rel: string, body: string): void { const p = T + "/" + rel; mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, body); }
function dir(rel: string): void { mkdirSync(T + "/" + rel, { recursive: true }); }
const calls: string[] = [];
let reply = "";
function stub(cmd: string, args: string[]): string { calls.push(cmd + " " + args.join(" ")); return reply; }
function R(rel: string): Ident { return resolveCwd(rel.startsWith("/") ? rel : T + "/" + rel, stub); }
function ID(id: Ident): string { return id.kind + " " + id.key + " | " + id.label; }
const cfg = (name: string, url: string): string => '[core]\n\tbare = false\n[remote "' + name + '"]\n\turl = ' + url + "\n\tfetch = +refs/heads/*:refs/remotes/" + name + "/*\n";

mk("r1/.git/config", cfg("origin", "git@github.com:me/x.git")); mk("r1/.git/HEAD", "ref: refs/heads/main\n"); dir("r1/src/a");
const r1 = R("r1");
eq("plain repo", ID(r1), "git git:github.com/me/x | me/x");
eq("plain top", r1.top, T + "/r1"); eq("plain worktree", r1.worktree, ""); eq("plain gitdir", r1.gitdir, T + "/r1/.git"); eq("plain via", r1.via, "origin");
eq("plain remote scrubbed", r1.remote, "ssh://github.com/me/x");
const r1s = R("r1/src/a"); eq("subdir key", r1s.key, r1.key); eq("subOf", subOf(r1s, T + "/r1/src/a"), "src/a"); eq("subOf top", subOf(r1, T + "/r1"), "");
eq("cfgMtime", cfgMtime(r1.common) > 0 ? "y" : "n", "y"); eq("cfgMtime missing", String(cfgMtime(T + "/nope")), "0");
// linked worktree
mk("w1/.git", "gitdir: ../r1/.git/worktrees/w1\n"); mk("r1/.git/worktrees/w1/commondir", "../..\n"); mk("r1/.git/worktrees/w1/HEAD", "ref: refs/heads/w1\n");
const w1 = R("w1");
eq("worktree key", w1.key, r1.key); eq("worktree name", w1.worktree, "w1"); eq("worktree common", w1.common, T + "/r1/.git"); eq("worktree gitdir", w1.gitdir, T + "/r1/.git/worktrees/w1"); eq("worktree top", w1.top, T + "/w1");
// submodule: its own repo
mk("r1/mod/.git", "gitdir: ../.git/modules/mod"); mk("r1/.git/modules/mod/config", cfg("origin", "https://github.com/me/mod")); mk("r1/.git/modules/mod/HEAD", "x");
const sm = R("r1/mod"); eq("submodule", sm.key, "git:github.com/me/mod"); eq("submodule worktree", sm.worktree, "");
// clone over https
mk("r2/.git/config", cfg("origin", "https://github.com/me/x")); eq("clone same key", R("r2").key, r1.key);
// no remote: worktrees merge, clones do not
mk("r3/.git/config", "[core]\n"); mk("w3/.git", "gitdir: " + T + "/r3/.git/worktrees/w3"); mk("r3/.git/worktrees/w3/commondir", "../..");
const r3 = R("r3"); const w3 = R("w3");
eq("gitdir kind", ID(r3), "gitdir gitdir:" + T + "/r3/.git | r3"); eq("gitdir worktree merge", w3.key, r3.key); eq("gitdir worktree label", w3.label, "r3");
mk("r4/.git/config", "[core]\n"); eq("gitdir clone differs", R("r4").key === r3.key ? "same" : "diff", "diff");
// remote choice
mk("r5/.git/config", cfg("fork", "https://github.com/me/f") + cfg("upstream", "https://github.com/up/x")); const r5 = R("r5"); eq("upstream wins", r5.via + " " + r5.key, "upstream git:github.com/up/x");
mk("r6/.git/config", cfg("b", "https://github.com/me/b") + cfg("c", "https://github.com/me/c")); eq("first remote", R("r6").via, "b");
// credentials
mk("r7/.git/config", cfg("origin", "https://x-access-token:ghs_SECRET@github.com/o/r")); const r7 = R("r7");
eq("token key", r7.key, "git:github.com/o/r"); eq("token not in remote", r7.remote.indexOf("ghs_SECRET") >= 0 ? "leak" : "ok", "ok");
mk("r8/.git/config", cfg("origin", "https://github.com/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8")); eq("token-shaped path kept", R("r8").key, "git:github.com/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8");
// alias → one git call
eq("no git call so far", String(calls.length), "0");
mk("r9/.git/config", cfg("origin", "gh:me/x")); reply = "https://github.com/me/x\n";
const r9 = R("r9"); eq("alias key", r9.key, "git:github.com/me/x"); eq("alias one call", calls.join(";"), "git -C " + T + "/r9 remote get-url origin");
R("r9"); eq("alias call cached per (common, mtime)", String(calls.length), "1");
mk("r10/.git/config", "[include]\n\tpath = ../other\n"); reply = "git@github.com:me/inc.git";
eq("include → git", R("r10").key, "git:github.com/me/inc"); eq("include one call", String(calls.length), "2");
mk("r11/.git/config", cfg("origin", "gh:nope")); reply = "";
const r11 = R("r11"); eq("alias unresolved → gitdir", r11.kind, "gitdir"); eq("alias unresolved label", r11.label, "r11");
// non-git, gone, broken worktree
dir("plain/sub"); const pl = R("plain/sub"); eq("non-git", pl.kind + " " + pl.key, "path path:" + T + "/plain/sub");
const gone = R("missing/dir"); eq("gone", gone.gone ? "gone" : "here", "gone"); eq("gone label", gone.label.endsWith(" (gone)") ? "y" : gone.label, "y"); eq("gone key", gone.key, "path:" + T + "/missing/dir");
const gw = R("r1/.claude/worktrees/agent-1"); eq("gone cwd inside a repo → its project", gw.key + " " + gw.worktree + (gw.gone ? " gone" : ""), r1.key + " agent-1 gone");
mk("bw/.git", "gitdir: " + T + "/deleted/.git/worktrees/bw"); eq("broken worktree → path", R("bw").kind, "path");
eq("empty cwd", ID(resolveCwd("", stub)), "none none | (no project)");
// unreadable .git file
mk("ur/.git", "gitdir: x"); chmodSync(T + "/ur/.git", 0o000);
const ur = R("ur"); const root = ur.unread === false && ur.kind === "git"; eq("unreadable .git", root ? "root?" : ur.kind + " " + (ur.unread ? "unread" : ""), "path unread");
chmodSync(T + "/ur/.git", 0o644);
mk("pw/.git", "gitdir: " + T + "/r1/.git/worktrees/gone-meta\n"); const pw = R("pw"); eq("pruned worktree metadata → its repo", pw.key + " " + pw.worktree, r1.key + " pw");
mkdirSync(T + "/eg/.git", { recursive: true }); const eg = R("eg"); eq("empty .git dir is a repo", eg.kind + (eg.unread ? " unread" : ""), "gitdir");
mkdirSync(T + "/ud/.git", { recursive: true }); chmodSync(T + "/ud/.git", 0o000);
const ud = R("ud"); eq("unlistable .git dir", ud.kind + (ud.unread ? " unread" : ""), "path unread"); chmodSync(T + "/ud/.git", 0o755);
// symlinked cwd
run("ln", ["-s", T + "/r1", T + "/link"]); eq("symlink same key", R("link/src").key, r1.key); eq("symlink top real", R("link").top, T + "/r1");

// ── cache, budget, revalidation, projects.json, labels ──
resetProjects();
for (let i = 0; i < 100; i++) dir("many/c" + String(i));
for (let i = 0; i < 100; i++) identOfCwd(T + "/many/c" + String(i));
eq("queued", String(P.todo), "100");
let tk = 0; const clock = (): number => tk++;
const n1 = resolveTick(20, 25, clock, stub); eq("budget ≤ 25", n1 <= 25 ? "ok" : String(n1), "ok");
tk = 0; let fast = 0; const slowClock = (): number => { fast += 7; return fast; };
const n2 = resolveTick(20, 25, slowClock, stub); eq("budget stops at 20 ms", n2 <= 3 ? "ok" : String(n2), "ok");
for (let i = 0; i < 20 && P.todo > 0; i++) { tk = 0; resolveTick(20, 25, clock, stub); }
eq("converges", String(P.todo), "0");
resetProjects();
eq("unknown → null", identOfCwd(T + "/r1") === null ? "null" : "x", "null");
const v0 = P.ver; resolveTick(1e9, 1e9, nowF, stub);
const c1 = identOfCwd(T + "/r1"); eq("after tick", c1 ? c1.key : "", "git:github.com/me/x"); eq("ver +1", String(P.ver - v0), "1");
eq("empty cwd never queued", identOfCwd("") ? "none" : "null", "none");
// revalidation: origin changed + mtime bumped, checked > 10 min ago
mk("r1/.git/config", cfg("origin", "https://github.com/me/renamed")); run("touch", ["-d", "+5 seconds", T + "/r1/.git/config"]);
resolveTick(1e9, 1e9, nowF, stub); const c2 = identOfCwd(T + "/r1"); eq("not revalidated before 10 min", c2 ? c2.key : "", "git:github.com/me/x");
const later = (): number => Date.now() + 11 * 60000;
function nowF(): number { return Date.now(); }
resolveTick(1e9, 1e9, later, stub); const c3 = identOfCwd(T + "/r1"); eq("revalidated", c3 ? c3.key : "", "git:github.com/me/renamed");
// a cwd that disappears keeps its identity
dir("tmpc"); mk("tmpc/.git/config", cfg("origin", "https://github.com/me/tmp")); identOfCwd(T + "/tmpc"); resolveTick(1e9, 1e9, nowF, stub);
rmSync(T + "/tmpc", { recursive: true, force: true });
resolveTick(1e9, 1e9, (): number => Date.now() + 22 * 60000, stub); const tc = identOfCwd(T + "/tmpc"); eq("deleted cwd keeps identity", tc ? tc.key + (tc.gone ? " gone" : "") : "", "git:github.com/me/tmp");
// a worktree whose main repo was deleted keeps the cached git identity
mk("main9/.git/config", cfg("origin", "https://github.com/me/nine")); mk("wt9/.git", "gitdir: " + T + "/main9/.git/worktrees/wt9"); mk("main9/.git/worktrees/wt9/commondir", "../..");
identOfCwd(T + "/wt9"); resolveTick(1e9, 1e9, nowF, stub);
rmSync(T + "/main9", { recursive: true, force: true });
resolveTick(1e9, 1e9, (): number => Date.now() + 33 * 60000, stub); const w9 = identOfCwd(T + "/wt9"); eq("broken worktree keeps git key", w9 ? w9.key : "", "git:github.com/me/nine");
// a never-resolved vanished cwd: cached like any other (no re-resolve per start); resolved again once it exists
identOfCwd(T + "/back"); resolveTick(1e9, 1e9, nowF, stub); const bk = identOfCwd(T + "/back"); eq("gone path", bk ? bk.label : "", home(T + "/back") + " (gone)");
// projects.json round trip
identOfCwd(T + "/r7"); identOfCwd(T + "/w1"); resolveTick(1e9, 1e9, nowF, stub);
rememberSess("/logs/a.jsonl", T + "/w1"); rememberSess("/logs/dead.jsonl", T + "/r7");
const PF = T + "/cache/projects.json";
eq("save", saveProjects(PF, new Set<string>(["/logs/a.jsonl"])) ? "y" : "n", "y");
const text = readFileSync(PF, "utf8");
eq("no token on disk", text.indexOf("ghs_") >= 0 ? "leak" : "ok", "ok");
eq("not dirty: no second write", saveProjects(PF, new Set<string>(["/logs/a.jsonl"])) ? "y" : "n", "y");
const before = JSON.stringify([identOfCwd(T + "/w1"), identOfCwd(T + "/r7"), identOfCwd(T + "/wt9")]);
resetProjects(); eq("reset", identOfCwd(T + "/w1") === null ? "null" : "x", "null");
resetProjects(); loadProjects(PF);
eq("round trip idents", JSON.stringify([identOfCwd(T + "/w1"), identOfCwd(T + "/r7"), identOfCwd(T + "/wt9")]), before);
const bk2 = identOfCwd(T + "/back"); eq("gone path kept in projects.json", bk2 ? bk2.key + (bk2.gone ? " gone" : "") : "null", "path:" + T + "/back gone");
mk("back/.git/config", cfg("origin", "https://github.com/me/back"));
resolveTick(1e9, 1e9, (): number => Date.now() + 44 * 60000, stub); const bk3 = identOfCwd(T + "/back"); eq("reappeared cwd re-resolved", bk3 ? bk3.key + (bk3.gone ? " gone" : "") : "", "git:github.com/me/back");
eq("sess kept", cwdOfSess("/logs/a.jsonl"), T + "/w1"); eq("sess dropped", cwdOfSess("/logs/dead.jsonl"), "");
rememberSess("/logs/b.jsonl", T + "/w1"); eq("read-only target", saveProjects("/proc/nope/projects.json", new Set<string>()) ? "y" : "n", "n");
// label collisions get the host prefix
resetProjects();
mk("ga/.git/config", cfg("origin", "https://github.com/a/x")); mk("gl/.git/config", cfg("origin", "https://gitlab.com/a/x")); mk("gy/.git/config", cfg("origin", "https://github.com/a/y"));
for (const d of ["ga", "gl", "gy"]) identOfCwd(T + "/" + d);
resolveTick(1e9, 1e9, nowF, stub);
const ga = identOfCwd(T + "/ga"); const gl = identOfCwd(T + "/gl"); const gy = identOfCwd(T + "/gy");
eq("collision github", ga ? labelOf(ga) : "", "github.com/a/x"); eq("collision gitlab", gl ? labelOf(gl) : "", "gitlab.com/a/x"); eq("lone label", gy ? labelOf(gy) : "", "a/y");
rmSync(T, { recursive: true, force: true });

console.log(bad ? bad + " failed" : "project ok");
if (bad) process.exit(1);
