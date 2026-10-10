// agentglass — self-check for room scope, share policy and the field-level projection (fleet-teams spec 6; Task 2):
//   scriptc build src/features/team/policy.check.ts -o pc && ./pc
// SPDX-License-Identifier: Apache-2.0
import { type Room, type RoomShare, scopeMatch, inScope, suggest, teamRow, levelOf, LEVEL_FIELDS } from "./policy.ts";
import { type Obj, parse } from "../../util/json.ts";
import { readText } from "../../util/fs.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

// scope patterns: * one segment, ** any number, the forges' paths case-insensitive (CI_HOSTS)
ok("* matches one segment", scopeMatch("github.com/acme/*", "github.com/acme/api"), "");
ok("* not two", !scopeMatch("github.com/acme/*", "github.com/acme/api/sub"), "");
ok("** matches one", scopeMatch("github.com/acme/**", "github.com/acme/api"), "");
ok("** matches two", scopeMatch("github.com/acme/**", "github.com/acme/api/sub"), "");
ok("* within a segment", scopeMatch("github.com/acme/infra-*", "github.com/acme/infra-net") && !scopeMatch("github.com/acme/infra-*", "github.com/acme/web"), "");
ok("other org", !scopeMatch("github.com/acme/*", "github.com/other/api"), "");
ok("other host", !scopeMatch("github.com/acme/*", "gitlab.com/acme/api"), "");
ok("exact", scopeMatch("github.com/acme/api", "github.com/acme/api") && !scopeMatch("github.com/acme/api", "github.com/acme/api2"), "");
ok("github case-insensitive", scopeMatch("github.com/ACME/*", "github.com/acme/api") && scopeMatch("GitHub.com/acme/API", "github.com/acme/api"), "");
ok("other hosts case-sensitive", !scopeMatch("git.example.com/ACME/*", "git.example.com/acme/api") && scopeMatch("git.example.com/acme/*", "git.example.com/acme/api"), "");
ok("bare * is every repo (team of one)", scopeMatch("*", "github.com/acme/api") && scopeMatch("**", "git.example.com/a/b/c"), "");
ok("** in the middle", scopeMatch("github.com/**/api", "github.com/acme/team/api") && scopeMatch("github.com/**/api", "github.com/acme/api"), "");
ok("empty pattern matches nothing", !scopeMatch("", "github.com/acme/api"), "");

const room: Room = { id: "r0000000000000001", name: "backend", scope: ["github.com/acme/*"], level: "titles", budgetUsd: 0, epoch: 1 };
const sh: RoomShare = { room: "r0000000000000001", on: true, repos: ["github.com/acme/api"], level: "numbers", since: 1000, paused: false };
ok("in scope", inScope(room, sh, "git:github.com/acme/api", 2000), "");
ok("path identity never", !inScope(room, sh, "path:/home/x", 2000), "");
ok("local file remote never", !inScope({ id: room.id, name: room.name, scope: ["**"], level: "numbers", budgetUsd: 0, epoch: 1 }, { room: sh.room, on: true, repos: ["file/home/x/r"], level: "numbers", since: 0, paused: false }, "git:file/home/x/r", 2000), "");
ok("repo not chosen", !inScope(room, sh, "git:github.com/acme/web", 2000), "");
ok("chosen but outside the room's scope", !inScope(room, { room: sh.room, on: true, repos: ["github.com/other/api"], level: "numbers", since: 0, paused: false }, "git:github.com/other/api", 2000), "");
ok("before the history start", !inScope(room, sh, "git:github.com/acme/api", 999), "");
ok("paused", !inScope(room, { room: sh.room, on: true, repos: sh.repos, level: "numbers", since: 0, paused: true }, "git:github.com/acme/api", 2000), "");
ok("off", !inScope(room, { room: sh.room, on: false, repos: sh.repos, level: "numbers", since: 0, paused: false }, "git:github.com/acme/api", 2000), "");
ok("another room's share", !inScope(room, { room: "r2", on: true, repos: sh.repos, level: "numbers", since: 0, paused: false }, "git:github.com/acme/api", 2000), "");
ok("no git: prefix", !inScope(room, sh, "github.com/acme/api", 2000), "");

ok("level: member below the room", levelOf(room, sh) === "numbers", "");
ok("level: both titles", levelOf(room, { room: sh.room, on: true, repos: [], level: "titles", since: 0, paused: false }) === "titles", "");
ok("level: room caps the member", levelOf({ id: room.id, name: "", scope: [], level: "numbers", budgetUsd: 0, epoch: 1 }, { room: sh.room, on: true, repos: [], level: "titles", since: 0, paused: false }) === "numbers", "");
const sg = suggest(room, sh, ["git:github.com/acme/api", "git:github.com/acme/web", "git:github.com/acme/web", "git:github.com/other/x", "path:/home/x/acme", "git:github.com/acme/cli"]);
ok("suggest: matching, unchosen, once, sorted", JSON.stringify(sg) === "[\"github.com/acme/cli\",\"github.com/acme/web\"]", JSON.stringify(sg));

// teamRow: a jsonSess object with every field set → the goldens, byte for byte
const TEAM = "0123456789abcdef";
function fixture(): Obj {
  return {
    id: "abc-123", harness: "claude", title: "fix login sk-ant-api03-SECRETxyz0123456789abcdefABCDEF for bob@example.com", cwd: "/home/x/acme/api", branch: "feat/login",
    remote: "git@github.com:acme/api.git", model: "claude-sonnet-4-5", path: "/home/x/.claude/projects/-home-x-acme-api/abc-123.jsonl", updated: "2026-10-01T10:00:00.000Z",
    bytes: 12345, live: true, pid: 4242, status: "busy", mux: { kind: "tmux", pane: "%3", workspace: "work-ws", tab: "api-tab", status: null }, parent: null, kind: "main",
    subagents: 2, twins: 0, activity: "Editing /home/x/acme/api/login.ts",
    tokens: { in: 100, out: 200, cacheRead: 300, cacheWrite: 400 }, costUsd: 1.25, costEstimatedUsd: 1.3, billing: { mode: "api", plan: "Max 20x", source: "config" },
    unpricedTokens: 5, unpricedCredits: 0, tools: 17, linesAdded: 40, linesRemoved: 3, attention: false, stuck: "waiting on /home/x/acme/api/.env",
    skills: [
      { name: "tdd", source: "plugin:superpowers", n: 2, loads: 1, tokens: { load: 1000, carry: 2000, tail: 300 }, costUsd: 0.01, carryUsd: 0.02, tailUsd: 0.003, size: 4096, tier: "exact", hash: "deadbeef", scope: "user", dir: "/home/x/.claude/skills/tdd" },
      { name: "(hidden)", source: "user", n: 1, loads: 1, tokens: { load: 50, carry: 0, tail: 0 }, costUsd: 0, carryUsd: 0, tailUsd: 0, size: null, tier: "≈", hash: null, scope: null, dir: null },
    ],
    repo: { key: "git:github.com/acme/api", label: "acme/api", kind: "git", worktree: "wt1", top: "/home/x/acme/api", remote: "git@github.com:acme/api.git" },
    alerts: [
      { rule: "cost-spike", severity: "warn", value: 3, unit: "usd", threshold: 2, since: "2026-10-01T09:00:00.000Z", message: "cost spike in /home/x/acme/api", labels: { repo: "acme/api" }, acked: false },
      { rule: "stuck", severity: "crit", value: 600, unit: "s", threshold: 300, since: "2026-10-01T09:30:00.000Z", message: "waiting on /home/x/acme/api/.env", labels: {}, acked: true },
    ],
    git: { commits: [{ sha: "0123abcd", branch: "feat/login", subject: "remove leaked key", at: "2026-10-01T09:59:00.000Z", how: "reflog", counted: true, status: "unknown", merge: false, add: null, del: null }],
      produced: 1, prs: [{ url: "https://github.com/acme/api/pull/7", how: "gh" }], issues: [{ url: "https://github.com/acme/api/issues/3", how: "msg" }], links: [{ url: "https://ci.example.com/x", how: "msg" }], costPerCommit: 1.25, noReflog: false },
    zzz: "an unknown new field",
  };
}
const gn = readText("src/features/team/testdata/row-numbers.golden.json", 0, 65536).trim();
const gt = readText("src/features/team/testdata/row-titles.golden.json", 0, 65536).trim();
const rn = JSON.stringify(teamRow(fixture(), "numbers", TEAM)); const rt = JSON.stringify(teamRow(fixture(), "titles", TEAM));
ok("numbers golden", gn.length > 0 && rn === gn, "\n got  " + rn + "\n want " + gn);
ok("titles golden", gt.length > 0 && rt === gt, "\n got  " + rt + "\n want " + gt);
// nothing outside the allowlist anywhere in the output, at any level
for (const lv of ["numbers", "titles"]) {
  const out = JSON.stringify(teamRow(fixture(), lv, TEAM));
  for (const w of ["/home/", "zzz", "unknown new field", "Max 20x", "git@", "pull/7", "0123abcd", "remove leaked", "Editing", "tmux", "work-ws", "api-tab", "%3", "SECRETxyz", "bob@", "deadbeef", "skills/tdd", "superpowers", "abc-123", "12345", "4242", "cost spike in", "wt1", "\"pid\"", "\"cwd\"", "\"path\"", "\"remote\"", "\"mux\"", "\"activity\""])
    ok(lv + ": no " + w, out.indexOf(w) < 0, out);
}
ok("numbers: no title, no branch", JSON.stringify(teamRow(fixture(), "numbers", TEAM)).indexOf("\"title\"") < 0 && JSON.stringify(teamRow(fixture(), "numbers", TEAM)).indexOf("feat/login") < 0, "");
ok("an unknown level is numbers", JSON.stringify(teamRow(fixture(), "everything", TEAM)) === gn, "");
// the allowlist itself: titles ⊇ numbers, never a forbidden field
{
  const n = LEVEL_FIELDS["numbers"] ?? []; const t = LEVEL_FIELDS["titles"] ?? [];
  let sup = n.length > 0; for (const f of n) if (t.indexOf(f) < 0) sup = false;
  ok("titles ⊇ numbers", sup && t.indexOf("title") >= 0 && t.indexOf("branch") >= 0 && n.indexOf("title") < 0, JSON.stringify(t));
  for (const f of ["cwd", "path", "remote", "activity", "stuck", "mux", "pid", "bytes", "parent", "twins", "attention", "zzz"]) ok("never " + f, n.indexOf(f) < 0 && t.indexOf(f) < 0, f);
}
// a shortSess row (outside the list window): only the fields it has, nothing invented
{
  const short: Obj = { id: "old-1", harness: "codex", updated: "2026-09-20T10:00:00.000Z", live: false, kind: "main", costUsd: null, billing: { mode: "sub", plan: "Pro", source: "auth" }, tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 } };
  const r = JSON.stringify(teamRow(short, "titles", TEAM));
  ok("short row", r.startsWith("{\"id\":\"") && r.indexOf("\"harness\":\"codex\",\"updated\":\"2026-09-20T10:00:00.000Z\",\"live\":false,\"kind\":\"main\",\"tokens\":{\"in\":1,\"out\":2,\"cacheRead\":3,\"cacheWrite\":4},\"costUsd\":null,\"billing\":{\"mode\":\"sub\"}}") > 0, r);
  ok("short row: no status invented", r.indexOf("status") < 0 && r.indexOf("title") < 0 && r.indexOf("Pro") < 0, r);
}
// status: the enum only
function st(o: Obj): string { const r = teamRow(o, "numbers", TEAM); return typeof r["status"] === "string" ? String(r["status"]) : "-"; }
ok("status busy", st({ id: "a", harness: "claude", live: true, status: "busy", attention: false, stuck: null }) === "busy", "");
ok("status idle (free text otherwise)", st({ id: "a", harness: "claude", live: true, status: "open via /dev/pts/3", attention: false, stuck: null }) === "idle", "");
ok("status from the row's state (pi: status open while it works)", st({ id: "a", harness: "pi", live: true, status: "open", state: "busy", attention: false, stuck: null }) === "busy", "");
ok("an unknown state falls back", st({ id: "a", harness: "pi", live: true, status: "open", state: "weird", attention: false, stuck: null }) === "idle", "");
ok("status attention", st({ id: "a", harness: "claude", live: true, status: "busy", attention: true, stuck: null }) === "attention", "");
ok("status ended", st({ id: "a", harness: "claude", live: false, status: "", attention: false, stuck: null }) === "ended", "");
// repo: only a git remote key, never a local path identity
{
  const o = fixture(); o["repo"] = { key: "path:/home/x/acme", label: "acme", kind: "path", worktree: "", top: "/home/x/acme", remote: "" };
  ok("path repo dropped", JSON.stringify(teamRow(o, "titles", TEAM)).indexOf("\"repo\"") < 0, "");
  const f = fixture(); f["repo"] = { key: "git:file/home/x/r", label: "r", kind: "git", worktree: "", top: "", remote: "" };
  ok("file remote dropped", JSON.stringify(teamRow(f, "titles", TEAM)).indexOf("\"repo\"") < 0, "");
}
// a non-number where a number belongs is dropped, not passed through (a future jsonSess change cannot smuggle text)
{
  const o = fixture(); o["tools"] = "/home/x/secret"; o["tokens"] = { in: 1, out: "/home/x", cacheRead: 3, cacheWrite: 4, extra: 9 };
  const r = JSON.stringify(teamRow(o, "numbers", TEAM));
  ok("typed fields", r.indexOf("/home/") < 0 && r.indexOf("\"tools\"") < 0 && r.indexOf("extra") < 0 && r.indexOf("\"out\":0") > 0, r);
  const g = fixture(); g["git"] = null;
  ok("git null stays null", JSON.stringify(teamRow(g, "numbers", TEAM)).indexOf("\"git\":null") > 0, "");
}
ok("parse of a golden", parse(gn) !== null, "");

if (bad > 0) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("policy: all checks passed");
