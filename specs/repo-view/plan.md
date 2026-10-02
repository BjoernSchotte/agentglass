# Repos View (Project Identity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Repos tab that groups all sessions of all harnesses by project (worktrees and clones of one remote merge), with per-project cost, active time, error rate, changed files, harness mix and branches. The same project identity backs filter-language's `repo` attribute, `--json` and `--json --repos`.

**Architecture:** `src/model/project.ts` resolves a cwd to an `Ident` from the filesystem only: `.git` walk, `commondir`, minimal INI read of `config`, remote normalization on top of parsing-fixes' `scrubRemote()`. A per-cwd cache with a per-tick budget and `~/.agentglass/cache/projects.json` keeps it cheap. The ledger's `Day` gains `act` (merged minute intervals) for active time. `src/features/repos/` holds the session→identity glue, the aggregation (`RepoAgg`) over ledger days and filter-language's compiled filters, the tab, and the CLI output.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps; `node:fs`; `run()` from `src/util/fs.ts` for the single `git remote get-url` fallback. Checks are standalone scriptc programs (`*.check.ts`).

**Spec:** [spec.md](spec.md) — read it first, including "Decisions (review 2026-10-02)"; this plan argues from it.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields, not foreign interfaces); call optional function members via a local; out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log`.
- Resolution spawns no git process except the one `git -C <top> remote get-url <name>` fallback (spec 1.5), at most once per (common dir, config mtime). No network.
- Never write into agent data dirs or into any repository (`.git` is read only). Read limits: `.git` file ≤ 1 KB, `config` ≤ 256 KB, walk ≤ 40 levels.
- Every remote URL goes through `scrubRemote()` before any other use; `projects.json` stores only `Remote.url`. Credentials never in argv, env of children, logs or `--json`.
- Normalization: default ports 22/443/80 dropped; the path is lowercased only for the exact hosts `github.com`, `gitlab.com`, `bitbucket.org`; remote choice `origin` → `upstream` → first in file order (spec decisions 1, 2).
- `repo.idleGapMin`: integer 1–60, default 5; invalid → 5 with one startup toast (spec decision 3).
- Per-tick resolve budget: 20 ms or 25 cwds, whichever comes first. Revalidation after 10 min. Disk cache saved every 30 s when dirty and on quit, atomically.
- `src/features/usage/cache.ts` `VERSION` bumps **once** in Task 5, to the next free number at implementation time (5 on `main` today; filter-language and parsing-fixes bump it before this branch). git-linkage shares this bump only if no build (stable or dev channel) carrying it was published in between (git-linkage Task 0 decides).
- Keys: the Repos tab's keys live in the tab (`Tab.key`, `src/hooks.ts:8`): `↑↓ jk g G pgup pgdn d w m a s / enter esc backspace ← →`, plus `c` in the detail. Digits, `tab`, `q`, `?` stay global (`src/input.ts:134-137`). `@` is new in the Sessions list (free today).
- Under `--redact`, labels, remotes and paths go through `display()` kinds `repo`/`cwd`/`file`.
- Style: dense one-line helpers, short `//` comments saying why, no new dependencies. The model layer (`src/model/`) never imports from `src/features/`.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-repo-view`, branch `feat/repo-view`, PR to `main`, rebase-merge after green CI. **Phase 5.** Starts when parsing-fixes (phase 1: `scrubRemote`, `Sess.remote`) and filter-language (phase 2: attribute registry, `projectOf()`, `aggregate()`, per-call rows, pins) are merged. git-linkage (phase 5) builds on this branch and starts after it is merged.

## Review Focus

1. **One project under two keys**: an `https://` clone and a `git@…:` clone of one GitHub repo, a `.git`/no-`.git` suffix, `GitHub.com/Me/X` vs `github.com/me/x` — all one key; a self-hosted host keeps case. Task 1 normalization table.
2. **Parallel agents double-counting active time**: two sessions active 10:00–11:00 in one project → active 1h, agent-hours 2h; a session crossing midnight splits into both days. Task 5 (`unionMin`) and Task 6 (agg check).
3. **A worktree whose main repo was deleted** (`.git` file → missing gitdir) or a deleted cwd: no crash, no re-resolve loop, the cached identity wins, else `path:` with `(gone)`. Task 2 + Task 3 checks.
4. **Credential-looking remote** (`https://x-access-token:ghs_…@github.com/o/r`, a token in the query or fragment): the credential is never in `projects.json`, labels or `--json`; a remote `scrubRemote` drops falls back to `gitdir:`. Path segments are kept (parsing-fixes' rule). Task 2 check reads `projects.json` back and greps for the token.
5. **Cold start with hundreds of cwds on a slow FS**: one tick never resolves more than 25 cwds or runs past 20 ms; the tab shows `resolving N sessions…` and converges. Task 3 check with 100 temp cwds and a stubbed clock.

---

### Task 0: Worktree, build, open question, upstream names

**Files:** none committed except a `Ruling:` note in the PR description draft (`/tmp/agentglass-repo-view-rulings.md`, not in the repo).

- [ ] **Step 1: Worktree** `git worktree add -b feat/repo-view ../agentglass-repo-view main && cd ../agentglass-repo-view && ./build.sh && sh scripts/check.sh` → binary built, all checks `ok`.
- [ ] **Step 2: Open question 1 — scriptc `realpathSync`** (spec 2). It is already used on `main` (`src/platform/linux.ts:27`, `src/features/version.ts:44`). Probe the semantics this spec needs:
  ```sh
  mkdir -p /tmp/agrv/real/x && ln -sfn /tmp/agrv/real /tmp/agrv/link
  cat > /tmp/agrv/rp.ts <<'EOF'
  import { realpathSync } from "node:fs";
  for (const p of ["/tmp/agrv/link/x", "/tmp/agrv/real/x", "/tmp/agrv/missing"]) { try { console.log(p + " -> " + realpathSync(p)); } catch (e) { console.log(p + " -> THROW"); } }
  EOF
  scriptc build /tmp/agrv/rp.ts -o /tmp/agrv/rp && /tmp/agrv/rp
  ```
  Expected: `/tmp/agrv/link/x -> /tmp/agrv/real/x`, `/tmp/agrv/real/x -> /tmp/agrv/real/x`, `/tmp/agrv/missing -> THROW`. Fallback if it does not resolve the symlink: no symlink resolution (spec 2: documented limitation; README line in Task 10), `real(p)` returns `p` normalized (no `//`, no trailing `/`).
- [ ] **Step 3: Upstream names.** On `main`, confirm the exported names this plan consumes (filter-language plan Tasks 3–8 "Produces", parsing-fixes Task 1/8; a missing name means that branch is not merged: stop):
  - parsing-fixes: `grep -n "export function scrubRemote\|export interface Remote" src/util/giturl.ts`; `grep -n "remote" src/model/types.ts` (`Sess.remote: string`, scrubbed URL or `""`).
  - filter-language: `grep -rn "export function \(projectOf\|projectRoot\|parse\|compile\|sessMatches\|dayMatches\|aggregate\|register\|extend\|tabFilter\|chips\|openFilterInput\)\b\|export interface \(Compiled\|Attr\|Clause\|Call\)\b" src/features/query src/features/usage`; `grep -n "export function intSetting\|export function intOf" src/util/config.ts`. Used below exactly as: `projectOf(cwd)` (`src/features/query/project.ts`), `register(a: Attr)` (attrs.ts), `extend(key, x: Ext)`, `parse(src): Parsed` (`.cs`, `.err`), `compile(cs, "stats"): { f: Compiled | null; err: QErr | null }`, `sessMatches(f, s)`, `dayMatches(f, s, dk, d)` (eval.ts), `tabFilter("Repos", "stats"): Compiled`, `chips("Repos", "stats", w)`, `openFilterInput("Repos")` (ui.ts), `intSetting(sec, key, lo, hi, def)` / `intOf(v, lo, hi, def)` (`src/util/config.ts`; one startup toast on an invalid value).
  - Expected evidence: each name found with file:line.
- [ ] **Step 4: Current `VERSION`**: `grep -n "VERSION =" src/features/usage/codec.ts src/features/usage/cache.ts` → note N; Task 5 sets N+1.
- [ ] **Step 5: Real layouts (read-only)** for the Task 10 run: `git -C ~/code/agentglass worktree list`; `cat ~/code/agentglass/.git/config | grep -A2 '^\[remote'` (do not paste URLs anywhere); `ls ~/.claude/projects | wc -l`. Checks use hand-written temp repos (Task 2), never copies of these.

---

### Task 1: Remote parsing and normalization (pure)

**Files:** Create `src/model/project.ts` (pure part), `src/model/project.check.ts`.

**Interfaces:**
- Consumes: `scrubRemote(raw: string): Remote | null`, `Remote { url, host, path, owner, name }` (parsing-fixes, `src/util/giturl.ts`).
- Produces:
  - `export interface RemoteEntry { name: string; url: string }`
  - `export function iniRemotes(text: string): RemoteEntry[]` — `[remote "<name>"]` sections, key `url` (first `url` per section), file order; ignores comments (`#`, `;`), trims, handles `url = "quoted"`.
  - `export function hasInclude(text: string): boolean` — true when a `[include]` or `[includeIf …]` section exists.
  - `export function pickRemote(rs: RemoteEntry[]): RemoteEntry | null` — `origin`, else `upstream`, else `rs[0]`.
  - `export interface Norm { key: string; label: string; host: string; url: string }` (`url` = scrubbed)
  - `export function normRemote(raw: string): Norm | null` — `null` when `scrubRemote` returns `null` **or** the URL has no recognizable host (alias such as `gh:owner/repo`); see rules below.
  - `export const CI_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"]`

Rules for `normRemote` (spec 1.5): `r = scrubRemote(raw)`; `null` → `null`. Local (`r.host === ""`, `file://…` or absolute path) → key `git:file/<real(path)>` (`real` from Task 2 is not available yet: here use the path as given; Task 2 wires `real`), label `basename(path)` without `.git`. Otherwise host lowercased; port: from `r.host` `h:p` keep `:p` unless `p` is 22, 443 or 80; path: collapse `//`, strip leading/trailing `/`, strip `.git`; key path lowercased only when `CI_HOSTS.indexOf(host) >= 0`; `key = "git:" + host + "/" + path`; `label = owner/name` (last two path segments, original case; one segment → that segment). A host must contain a `.` or be `localhost` or carry a port, else → `null` (alias).

- [ ] **Step 1: Failing check** `src/model/project.check.ts` (helpers `eq(what, got, want)` like `watchdog.check.ts`). Normalization table, input → `key | label` (or `null`):
  - `https://github.com/Me/X.git` → `git:github.com/me/x | Me/X`
  - `git@github.com:me/x` → `git:github.com/me/x | me/x`
  - `ssh://git@github.com:22/me/x/` → `git:github.com/me/x | me/x`
  - `https://GitHub.com:443/Me/X` → `git:github.com/me/x | Me/X`
  - `https://git.example.com/Me/X` → `git:git.example.com/Me/X | Me/X`; `https://git.example.com/me/x` → `git:git.example.com/me/x` (different key)
  - `ssh://git@git.example.com:2222/team/app.git` → `git:git.example.com:2222/team/app | team/app`
  - `https://gitlab.com/Group/Sub/Proj` → `git:gitlab.com/group/sub/proj | Sub/Proj`
  - `https://x-access-token:ghs_abc@github.com/o/r` → `git:github.com/o/r` (scrubbed)
  - `https://github.com/o/ghp_0123456789abcdef0123456789abcdef01` → `null`
  - `/srv/git/x.git` and `file:///srv/git/x.git` → same `git:file/…` key, label `x`
  - `gh:owner/repo` → `null`
  - `https://github.com//me//x.git/` → `git:github.com/me/x`
  - INI: `[remote "upstream"]\n\turl = https://a/u\n[remote "origin"]\n\turl = https://a/o` → `pickRemote` = origin; without origin → upstream; `[remote "b"]`,`[remote "c"]` → `b`; no remotes → `null`; `# url = x` ignored; `[includeIf "gitdir:~/w/"]` → `hasInclude` true.
- [ ] **Step 2: Run** `scriptc build src/model/project.check.ts -o /tmp/pc && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/pc` → Expected: build fails (`normRemote` not exported).
- [ ] **Step 3: Implement** the five functions in `src/model/project.ts` (header comment: identity rules, spec 1).
- [ ] **Step 4: Run** the check → Expected: last line `project ok` and exit 0; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `git add src/model/project.ts src/model/project.check.ts && git commit -m "feat(repos): remote URL normalization for project identity"` (+ Co-Authored-By line).

---

### Task 2: Identity resolution from the filesystem

**Files:** Modify `src/model/project.ts`; Test `src/model/project.check.ts`.

**Interfaces:**
- Consumes: Task 1 functions; `run(cmd, args)` (`src/util/fs.ts:35-37`) as the default git runner.
- Produces:
  - `export interface Ident { key: string; label: string; kind: string /* "git" | "gitdir" | "path" | "none" */; top: string; common: string; gitdir: string /* per-worktree git dir: <top>/.git or the .git file's target; "" non-git (git-linkage reflog, related-events) */; worktree: string; remote: string /* scrubbed url or "" */; via: string /* chosen remote name, "" */; gone: boolean; unread: boolean /* .git unreadable → dim "?" */ }`
  - `export type GitRun = (cmd: string, args: string[]) => string`
  - `export function real(p: string): string` — `realpathSync`, on throw the normalized input (Task 0 fallback decides).
  - `export function resolveCwd(cwd: string, git: GitRun): Ident`
  - `export function subOf(id: Ident, cwd: string): string` — repo-relative dir of `cwd` under `id.top` (`""` at the top or for non-git).
  - `export function cfgMtime(common: string): number` — mtime of `<common>/config`, `0` if absent.

Algorithm = spec 1 steps 1–7, exactly: empty → `{kind:"none", key:"none", label:"(no project)"}`; walk ≤ 40 levels stat'ing `<d>/.git` (dir → `gitdir = <d>/.git`; file → `gitdir: <p>` ≤ 1 KB, relative to `<d>`; stored as `Ident.gitdir`, realpath'd); `common` from `<gitdir>/commondir` (resolved against gitdir) else gitdir; remotes from `<common>/config` (≤ 256 KB, larger → no remote); `normRemote(pickRemote(...).url)`; if that is `null` because of an alias or `hasInclude(text)` → **one** `git("git", ["-C", top, "remote", "get-url", name])`, trimmed, through `normRemote` again; still `null` → `gitdir:` identity. No remote → `key "gitdir:" + real(common)`, `kind "gitdir"`, label `basename(main top)`; non-git → `key "path:" + real(cwd)`, `kind "path"`, label `~/…` (shortened with `home()` from `src/util/text.ts`); cwd does not exist → `key "path:" + cwd`, `gone: true`, label + ` (gone)`; `.git` exists but is unreadable (stat ok, read fails) → path identity with `unread: true`; `.git` file pointing to a missing gitdir → path identity (the cache in Task 3 prefers an older cached identity). `worktree = basename(top)` when `top !== dirname(common)` or `common` does not end in `/.git`, else `""`. Remote-based local paths (`git:file/…`) use `real()`.

- [ ] **Step 1: Failing checks** (temp dirs under `/tmp/agpc-<pid>/`, created with `mkdirSync`/`writeFileSync`, removed at the end; git runner stub counts calls):
  - plain repo `r1/.git/config` with origin `git@github.com:me/x.git` → kind `git`, key `git:github.com/me/x`, label `me/x`, `top` = r1, `worktree` `""`;
  - cwd `r1/src/a` → same key; `subOf` = `src/a`;
  - linked worktree `w1/.git` file `gitdir: ../r1/.git/worktrees/w1`, `r1/.git/worktrees/w1/commondir` = `../..` → same key as r1, `worktree` = `w1`, `common` = r1/.git, `gitdir` = r1/.git/worktrees/w1 (r1 itself: `gitdir` = r1/.git);
  - submodule `r1/mod/.git` file → `../.git/modules/mod`, with its own config remote `https://github.com/me/mod` → key `git:github.com/me/mod`;
  - clone `r2` with `https://github.com/me/x` → same key as r1;
  - no remote: `r3` + worktree `w3` → both `gitdir:<real r3/.git>`, kind `gitdir`, label `r3`; separate clone `r4` without remote → different key;
  - `upstream` + `fork` remotes → `via` = `upstream`; `b`,`c` → `b`;
  - token URL `https://x-access-token:ghs_SECRET@github.com/o/r` → key `git:github.com/o/r`, `remote` contains no `ghs_SECRET`;
  - token-shaped path segment (`https://github.com/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8`) → kept: key `git:github.com/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8` (parsing-fixes' scrub never drops path segments as tokens);
  - alias `gh:me/x` → stub called exactly once with `["-C", top, "remote", "get-url", "origin"]`, stub returns `https://github.com/me/x` → key `git:github.com/me/x`; config with `[include]` → stub called once;
  - non-git dir → kind `path`; missing dir → `gone` true, label ends ` (gone)`;
  - `.git` file pointing to a deleted gitdir → kind `path`;
  - symlinked cwd (`/tmp/agpc/link` → r1) → same key as r1 (skipped with a printed note when Task 0 took the fallback).
- [ ] **Step 2: Run** the check → Expected: FAIL (`resolveCwd` undefined).
- [ ] **Step 3: Implement** `real`, `resolveCwd`, `subOf`, `cfgMtime` (fs reads via `readText` from `src/util/fs.ts`; `statSync`/`existsSync` from `node:fs`).
- [ ] **Step 4: Run** the check → PASS; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `feat(repos): resolve a cwd to its project from .git, commondir and config`.

---

### Task 3: Identity cache, budget, `projects.json`, label collisions

**Files:** Modify `src/model/project.ts`; Test `src/model/project.check.ts`.

**Interfaces:**
- Consumes: `resolveCwd`, `cfgMtime`, `Ident` (Task 2).
- Produces:
  - `export const P = { ver: 0, todo: 0 }` — `ver` increments whenever an identity is added or changes (the aggregation cache key); `todo` = cwds still queued.
  - `export function identOfCwd(cwd: string): Ident | null` — cached identity, else queues the cwd and returns `null`.
  - `export function resolveTick(maxMs: number, maxN: number, now: () => number, git: GitRun): number` — resolves queued cwds and revalidates entries checked > 10 min ago (stat `<common>/config`; mtime changed → re-resolve; cwd gone → never re-resolved, keeps its identity); returns the number resolved.
  - `export function labelOf(id: Ident): string` — the label, host-prefixed when another known key has the same label (`github.com/a/x` vs `gitlab.com/a/x` → `github.com/a/x`, `gitlab.com/a/x`).
  - `export function rememberSess(path: string, cwd: string): void` and `export function cwdOfSess(path: string): string` — the `sess` map (spec 2).
  - `export function loadProjects(file: string): void`, `export function saveProjects(file: string, live: Set<string>): boolean` — format `{v:1, cwds:{<cwd>:{key,label,kind,top,common,gitdir,worktree,remote,via,gone,unread,cfgMtime,checked}}, sess:{<path>:<cwd>}}`; `live` = existing session paths (others dropped); atomic tmp + rename like `src/features/usage/cache.ts:82-95`; returns false on write failure (read-only home: keep going in memory). Saves only when dirty.
  - `export const PROJECTS_FILE = join(HOME, ".agentglass", "cache", "projects.json")`

A re-resolve that now yields kind `path` from a `.git` file with a missing gitdir keeps the cached git identity (spec 9).

- [ ] **Step 1: Failing checks**:
  - 100 temp cwds queued; `resolveTick(20, 25, clock, stub)` with a clock that advances 1 ms per call → returns ≤ 25 and stops when the stubbed clock passes 20 ms; repeated ticks converge to `P.todo === 0`;
  - `identOfCwd` on an unknown cwd → `null`, then after one tick → identity, `P.ver` incremented once;
  - revalidation: change `config` origin + bump its mtime, `checked` set 11 min back → next tick re-resolves to the new key; deleted cwd with `checked` old → identity unchanged, no stat of its config (stub `existsSync` counter not needed: assert identity equal);
  - `.git` file whose gitdir was deleted after the first resolve → cached `git:` key kept;
  - `saveProjects` → `loadProjects` round trip into a fresh cache (export a `resetProjects()` for the check) gives identical idents and `sess` entries; a session path not in `live` is dropped; the file text contains no `ghs_` (token test from Task 2);
  - label collision: idents for `github.com/a/x` and `gitlab.com/a/x` → `labelOf` gives the host-prefixed labels; a lone `a/y` stays `a/y`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(repos): cached, budgeted project identity with projects.json`.

---

### Task 4: Session identity, `repo` attributes, redaction, `--json repo`

**Files:** Create `src/features/repos/ident.ts`; Modify `src/features/redact.ts` (export `realCwd`, display kind `repo`), `src/features/query/project.ts` (filter-language's `projectOf()`), `src/features/query/attrs.ts` (register `worktree`, `project.kind`), `src/features/cli.ts` (`JSess.repo`), `src/main.ts` (import `./features/repos/ident.ts` before `./features/usage/stats.ts`); Test `src/features/repos/ident.check.ts`.

**Interfaces:**
- Consumes: `identOfCwd`, `resolveTick`, `labelOf`, `rememberSess`, `cwdOfSess`, `loadProjects`, `saveProjects`, `PROJECTS_FILE`, `subOf`, `normRemote` (Tasks 1–3); filter-language `register(a: Attr)`, `extend(key, x: Ext)`, `Attr`, `Val`; parsing-fixes `Sess.remote`.
- Produces:
  - `src/features/redact.ts`: `export function realCwd(s: Sess): string` — `recs.get(s.path)?.real || s.cwd` (written with a local, no optional chaining on the Map result); display kind `repo`: `owner/name` → `fakeProject(owner)/fakeProject(name)`, `host/owner/name` keeps the host; kind `remote`: replaces `owner/name` in the URL the same way.
  - `src/features/repos/ident.ts`:
    - `export function identOf(s: Sess): Ident | null` — cwd = `realCwd(s)`; empty → for a subagent its parent's cwd (`parentOf(s)`), else `cwdOfSess(s.path)`; records `rememberSess(s.path, cwd)`; when the identity is `gone` and `s.remote` is set, returns a copy keyed by `normRemote(s.remote)` (kind `git`).
    - `export function repoLabel(s: Sess): string` — `labelOf(identOf(s))` or `""` while unresolved.
    - `H.onTick`: `resolveTick(20, 25, Date.now, run)`; every 30 s `saveProjects(PROJECTS_FILE, live paths)`; `H.onQuit`: save. `loadProjects(PROJECTS_FILE)` at import.
  - `projectOf(cwd)` body → `const id = identOfCwd(cwd); return id ? labelOf(id) : base(cwd)` (keeps the old basename until resolved, so existing clauses keep matching). The `repo` attribute's session value via `extend("repo", { sess: (s) => …, resolve: null })`: `Val.ss = [repoLabel(s) || base(s.cwd), Ident.key]` (lowercased). The registry has no per-op values; a string clause matches when any value matches, so `repo is me/x` hits the label and `repo ~ shop` the label or the key (spec 8). `repo is git:github.com/me/x` also matches (the key), which is harmless.
  - New attributes (`register` for the metadata + `extend` for the session value): `worktree` (session, text, `Ident.worktree`), `project.kind` (session, enum `git|gitdir|path|none`).
  - `cli.ts` `JSess.repo: { key: string; label: string; kind: string; worktree: string; top: string; remote: string } | null` — `top` real path, `remote` scrubbed; both through `display("cwd" | "remote", …)`; `label` through `display("repo", …)`; `snapshot()` resolves synchronously for each listed session (`resolveTick(1e9, 1e9, Date.now, run)` once after `discover()`).

- [ ] **Step 1: Failing checks** (`ident.check.ts`, temp repos as in Task 2): a Claude-like `Sess` with `cwd` in a worktree → `identOf` same key as the main repo after one tick; a subagent with `cwd ""` → its parent's identity; a session whose cwd was deleted and `remote = "https://github.com/me/x"` → key `git:github.com/me/x`; with `REDACT` on (checks run with `AGENTGLASS_REDACT=1`): `display("repo", "me/x", null)` ≠ `me/x`, has the same `/` shape, and is stable across two calls; `realCwd` after `applyMeta(s)` returns the real temp path while `s.cwd` is fake; filter `repo is me/x` and `worktree is w1` and `project.kind is gitdir` select the expected sessions through `sessMatches(compile(parse(…).cs, "stats").f ?? EMPTY, s)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; `./build.sh && ./agentglass --json --limit 5 | head -c 2000` → each object has `repo` with a real key.
- [ ] **Step 5: Commit** `feat(repos): session project identity behind the repo filter key and --json`.

---

### Task 5: Active time in the ledger (`Day.act`)

**Files:** Modify `src/features/repos/ident.ts` (one line at import: `ACT.gap = intSetting("repo", "idleGapMin", 1, 60, 5)`), `src/features/usage/record.ts` (`Day.act`, `Acc.al`, `ACT`, `actMark`, `actSpan`, `addSpan`, `unionMin`, `spanMin`, `flushSpans`, `bucket()` calls `actMark`), `src/features/usage/calls.ts` (`SPANS`, `done()` pushes), `src/features/usage/ledger.ts` (`step()` calls `flushSpans(a)` after each `ad.usage(a, l)`, both branches at `:32` and `:49`), `src/features/usage/codec.ts` (honest-costs moved `dayOut/In`, `accOut/In` and `VERSION` there from `cache.ts`; persist `ak` per day (`k` is parsing-fixes' `skills`), `al` per Acc; `VERSION` N → N+1 with comment `N+1: Day.act active intervals (repo-view)`); Test `src/features/usage/record.check.ts`.

**Interfaces:**
- Produces (record.ts):
  - `Day.act: number[]` — flat sorted merged `[s0,e0,s1,e1,…]` local minutes of day, `e` exclusive, ≤ 200 intervals.
  - `Acc.al: number` — epoch ms of the latest activity seen (persisted as `al`).
  - `export const ACT = { gap: 5 }` — idle gap in minutes (set from config in `ident.ts`, this task).
  - `export function addSpan(act: number[], s: number, e: number): void` — insert + merge overlapping/adjacent; over 200 intervals merge the pair with the smallest gap.
  - `export function actMark(a: Acc, d: Day, ms: number): void` — called by `bucket()` when `ms > 0` or `iso` is set (never for the `Date.now()` fallback). `m` = local minute of day of `ms` (cache the conversion per `iso.slice(0,16)` like `tsKey`); if `0 ≤ ms − a.al ≤ ACT.gap·60000`: same day → `addSpan(d.act, minute(a.al), m + 1)`; previous day → `addSpan(prev.act, minute(a.al), 1440)` and `addSpan(d.act, 0, m + 1)` (`prev = a.days.get(dayKey(new Date(a.al)))`, skipped when absent); else `addSpan(d.act, m, m + 1)`. `a.al = max(a.al, ms)`.
  - `export function actSpan(a: Acc, t0: number, t1: number): void` — covers `[t0, t1]` minute-wise, split at local midnights, each part into its own day's bucket (creating it through `bucket(a, t, "")`).
  - `export function flushSpans(a: Acc): void` — applies and clears `SPANS` (pairs `t0, t1`).
  - `export function spanMin(act: number[]): number` and `export function unionMin(lists: number[][]): number` — total minutes of one list; of the union of several (sort + merge).
- Produces (calls.ts): `export const SPANS: number[] = []`; `done()` pushes `p.t, p.t + ms` when `p.t > 0 && ms > 0 && ms < 86400000`.

- [ ] **Step 1: Failing checks** in `record.check.ts` (ISO timestamps built from a local `Date` so the check is TZ-independent):
  - lines at 10:00, 10:03, 10:08 (gap 5) → one interval `[600, 609)`; 10:00 then 10:06 → two intervals;
  - `ACT.gap = 15` → 10:00, 10:14 one interval; restore 5;
  - `tool()` + `pend()` at 11:00 and `done(p, 20·60000, …)` + `flushSpans(a)` → `[660, 681)` covered without lines in between;
  - 23:58 then 00:02 next day → day 1 ends with `[1438, 1440)`, day 2 starts `[0, 3)`; a span 23:50–00:10 → both days;
  - 205 separated one-minute marks → 200 intervals, total minutes ≥ 205 (merging only grows coverage);
  - `bucket(a, 0, "")` (no timestamp) adds nothing to `act`;
  - `unionMin([[600,660],[630,690]]) === 90`, sum of `spanMin` = 120;
  - persistence: `accOut`/`accIn` are module-private — round-trip through exported `saveTo(file)`/`loadFrom(file)` in cache.ts if they exist; else add `export function accJson(a: Acc): Obj` / `export function accParse(o: Obj): Acc` wrappers (one line each) and assert `act` and `al` survive.
  - config: `intSetting("repo","idleGapMin",1,60,5)` on `{"repo":{"idleGapMin":0}}` → 5 and one toast; on `15` → 15 (the pure `intOf(v, 1, 60, 5)` for the values; `intSetting` for the toast).
- [ ] **Step 2: Run** `scriptc build src/features/usage/record.check.ts -o /tmp/rc && /tmp/rc` → FAIL.
- [ ] **Step 3: Implement**; bump `VERSION`.
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; the existing harness checks (`harness.check.ts`, `gemini.check.ts`, `pi.check.ts`, `kiro.check.ts`, `opencode.check.ts`) unchanged and green.
- [ ] **Step 5: Commit** `feat(usage): active-time intervals per session-day (repo.idleGapMin)`.

---

### Task 6: Repo aggregation (`RepoAgg`)

**Files:** Create `src/features/repos/agg.ts`, `src/features/repos/agg.check.ts`; (`dayMatches`/`sessMatches` come from filter-language `eval.ts`.)

**Interfaces:**
- Consumes: `identOf`, `labelOf` (Task 4/3), `P.ver` (Task 3), `Day.act`, `unionMin`, `spanMin` (Task 5), `ledger` (`src/features/usage/ledger.ts:13`), `L.ver`, `sessions`, filter-language `Compiled`, `sessMatches`, `dayMatches`, `aggregate()` (cross-check only); honest-costs `ModeSum`, `newSum`, `addDay` (`costs.ts`), `modeOf` (`bill-live.ts`).
- Produces:
  ```ts
  export interface FileAgg { n: number; add: number; del: number; by: Set<string> }
  export interface HarnessAgg { sess: number; cost: number; unk: number }
  export interface BranchAgg { sess: number; cost: number; unk: number }
  export interface RepoAgg {
    key: string; label: string; kind: string; worktrees: Map<string, string> /* name → top */; sessions: number; live: number; last: number;
    cost: number; unk: number; modes: ModeSum /* honest-costs: cost per billing mode */; inTok: number; outTok: number; calls: number; err: number; activeMin: number; agentMin: number;
    files: Map<string, FileAgg>; outside: FileAgg; tools: Map<string, Cnt> /* name → n, err */; progErr: Map<string, Cnt>;
    byHarness: Map<string, HarnessAgg>; branches: Map<string, BranchAgg>; paths: string[] /* top-level session paths, newest first */;
  }
  export function repoAgg(days: string[], f: Compiled | null): RepoAgg[]   // cached 5 s per (days, canonical filter, L.ver, P.ver)
  export function relFile(top: string, cwd: string, p: string): string    // "" = outside the repo
  export function errPct(err: number, n: number): number                  // -1 when n < 10 (shown as "·")
  export function allDays(): string[]                                     // every day key in the ledger, sorted
  ```
  Rules (spec 5): every session (top-level and subagent) that passes `sessMatches(f, s)` contributes the days that pass `dayMatches` to the project of **its own** identity (`identOf(s)`; a subagent without cwd uses its parent's); `sessions` counts top-level sessions with ≥ 1 matching day (`!s.parent`, like `stats.ts:71`); `live` counts top-level with `s.pid`; cost/unk/tokens/calls/err from `Day` (`modes` via honest-costs `addDay(r.modes, d, (p) => modeOf(s, p))`) (`calls` = Σ `TS.n`, `err` = Σ `TS.err` over `d.tt`); `activeMin` = Σ over day keys of `unionMin(all sessions' d.act of that day)`; `agentMin` = Σ `spanMin`; files: `Day.files` keys `"<tool>\t<path>"` → `relFile(id.top, cwd, path)`; worktrees keyed by `Ident.worktree || "(main)"`; branches by `s.branch` (skip `""`); `progErr` = `Day.prog` entries with `err > 0`.
  Note: the spec's `RepoAgg` lists `tools` twice (a number and a map); here the count is `calls` and the map is `tools`.

- [ ] **Step 1: Failing checks** (`agg.check.ts`; synthetic `Sess` objects in `sessions` and `Acc`s in `ledger`, identities seeded by resolving temp repos as in Task 2): main repo + worktree `w1` sessions → one `RepoAgg` with `worktrees.size === 2`; a subagent (no cwd) with cost 1.0 under a parent with cost 2.0 → project cost 3.0, `sessions === 1`; a subagent with its own cwd in another repo → its cost goes there; two sessions with `act [600,660]` and `[630,690]` the same day → `activeMin 90`, `agentMin 120`; `src/a.ts` edited absolutely in main and in `w1` → one `files` row `src/a.ts` with `by` = both harnesses; `/etc/hosts` → `outside.n === 1`; 9 calls with 3 errors → `errPct === -1`, 10 calls → 30; filter `harness is codex` → only Codex sessions counted; cost per repo equals `aggregate(f, "session", days, ["repo"], "cost")` values for the same filter (one equality per repo); cache: a second call with unchanged `L.ver`/`P.ver` returns the same array object.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(repos): per-project aggregation over ledger days`.

---

### Task 7: Repos tab — project list

**Files:** Create `src/features/repos/tab.ts`, `src/features/repos/tab.check.ts`; Modify `src/main.ts` (import `./features/repos/tab.ts` right after `./features/usage/stats.ts`, so the tab sits after Stats), `src/ui/help.ts` only if tabs are listed there.

**Interfaces:**
- Consumes: `repoAgg`, `errPct`, `allDays` (Task 6), honest-costs `split(m, narrow)`/`money(c, bill)` (`costs.ts`), `grp()`/`kfmt()` (`stats.ts:19-29`), `fmtMs`-style duration → write `hm(min: number): string` (`9h12m`, `12m`), `harnessOf(h).color()/.mark`, `box`/`put` (`src/ui/screen.ts`), `lastDays`, `todayKey` (`record.ts`), filter-language `openFilterInput("Repos")`, `chips("Repos", "stats", w)`, effective filter `tabFilter("Repos", "stats"): Compiled`, `P.todo` (Task 3).
- Produces:
  - `export function mixBar(by: Map<string, HarnessAgg>, cells: number): string[]` — harness id per cell, proportional to cost (sessions when every cost is 0 and unk > 0), largest remainder; ≥ 1 cell for any harness with a share > 0 when `by.size ≤ cells`.
  - `export function sortRepos(rows: RepoAgg[], by: string): RepoAgg[]` — `by` ∈ `cost|active|sessions|err|last`, descending, ties by label.
  - `export function hm(min: number): string`
  - `const RV = { period: "w" /* d|w|m|a */, sort: "cost", sel: 0, top: 0, detail: "" /* project key, "" = list */ }` and `const tab: Tab = { name: "Repos", render, key, mouse }` pushed to `H.tabs`.
  - Row layout per spec 6: `repo sess live cost active err% harness-mix files last`; `⑂N` dim after the label when `worktrees.size > 1`; cost cell `split(r.modes, true)`, `+?` appended when `unk > 0`, `cost ?` when `cost === 0 && unk > 0` (honest-costs' tight-width form); `·` for `errPct < 0`; `last` via `ago()`. Header subtitle: period name + `chips("Repos", "stats", w)`. While `P.todo > 0` or sessions without `headDone` exist: `resolving N sessions…` in the box title, and `loadHead` for ≤ 40 such sessions per frame (as `src/ui/list.ts:53`).
  - Keys (list): `up/k`, `down/j`, `g`, `G`, `pgup`, `pgdn`; `d`/`w`/`m`/`a` period (`[todayKey()]`, `lastDays(7)`, `lastDays(30)`, `allDays()`); `s` cycles sort; `/` → `openFilterInput("Repos")`; `enter` → `RV.detail = row.key`. Mouse: click selects, double click/second click opens.

- [ ] **Step 1: Failing checks** (`tab.check.ts`, pure helpers only): `mixBar` with costs `{claude:3, codex:1}` over 8 cells → 6×claude, 2×codex; all-unpriced `{pi: sess 2, kiro: sess 2}` → 4/4; a harness with 1% share over 8 cells → ≥ 1 cell; `sortRepos` by each key; `hm(552) === "9h12m"`, `hm(12) === "12m"`, `hm(0) === "0m"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (render reads `repoAgg(period, tabFilter("Repos", "stats"))`).
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; `./build.sh && ./agentglass` → `4` opens Repos, rows render, `d/w/m/a`, `s`, `/harness is codex` work; quit.
- [ ] **Step 5: Commit** `feat(repos): Repos tab with per-project cost, active time, errors and harness mix`.

---

### Task 8: Project detail, drill-down, `@` from Sessions

**Files:** Modify `src/features/repos/tab.ts`, `src/features/callgraph/view.ts` (export `open` as `openGraph`, keep the `c` handler at `:350-353` calling it), `src/features/usage/stats.ts` only if `jump()` (`:359-365`) is reused (export it as `jumpTo(path: string, id: string, ts: string)`); Test `src/features/repos/tab.check.ts`.

**Interfaces:**
- Consumes: Task 6/7 names; `openTranscript` (`src/ui/transcript.ts:100`); `openGraph(s: Sess)`; `identOf`, `subOf`.
- Produces:
  - `export function detailSessions(r: RepoAgg, file: string): string[]` — session paths of the project, newest first; with `file !== ""` only those whose matching `Day.files` contain that repo-relative path.
  - `export function topFiles(r: RepoAgg, n: number): [string, FileAgg][]` (by edits; `outside` last).
  - `export function topErrTools(r: RepoAgg, n: number): [string, Cnt][]` (by `err`, then `n`).
  - Detail state `RV.focus: 0|1|2|3` (sessions, files, tools, branches), `RV.file` (chip), per-box selection.
  - Header: label, scrubbed remote (`display("remote", …)`) + `(remote: upstream)` when `via !== "origin"`, kind, worktrees (name and top via `display("cwd", …)`), period totals (cost, tokens, active `hm(activeMin)` and agent-hours `hm(agentMin)`, calls, err%).
  - Boxes: **sessions** (harness badge, title, `worktree` or `repo:sub/dir` via `subOf`, branch, cost, active (`spanMin` Σ), err%); **files** (top 20: edits, `+add −del`, harness marks); **tools** (top 8 by errors, err%, worst programs from `progErr`); **branches** (if any: branch, sessions, cost).
  - Keys (detail): `←/→` focus; `↑↓ jk` selection in the focused box; sessions box `enter` → `openTranscript(s)`, `c` → `openGraph(s)` (esc from either returns to the tab: both restore `S.mode` and the tab index stays); files box `enter` → `RV.file = path` (chip `file:<path>`), `esc` clears the chip first, then `esc`/`backspace` leaves the detail.
  - Sessions tab: `H.keys` handler for `@` in mode `list`, `S.tab === 0`: `S.tab = 2 + H.tabs.indexOf(tab)`, `RV.detail = identOf(current()).key` (toast `project not resolved yet` when `null`). Help section `repos` lists the tab keys and `@`.

- [ ] **Step 1: Failing checks**: `detailSessions` with a file chip returns only sessions with that file in their `Day.files` (rel path match across worktrees); `topFiles` puts `outside` last; `topErrTools` ordering; `@` handler with a resolved current session sets `S.tab` to the Repos index and `RV.detail` to its key (drive through `H.keys` with a fake `S.view`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; manual: Sessions → `@` → detail → `enter` transcript → `esc` back in detail; `c` call graph → `esc` back.
- [ ] **Step 5: Commit** `feat(repos): project detail with sessions, files, tools and branches; @ from Sessions`.

---

### Task 9: CLI `--json --repos`

**Files:** Create `src/features/repos/cli.ts`; Modify `src/features/cli.ts` (`OPTS`: `--repos`, `--days N`; `--json fields` help line adds `repo{key,label,kind,worktree,top,remote}`; dispatch `--repos` inside the `--json` branch); Test `src/features/repos/cli.check.ts` (pure JSON shaping) and a manual run.

**Interfaces:**
- Consumes: `repoAgg`, `allDays`, `lastDays`, filter-language `Opts.filter: Compiled` (filter-language Task 10 compiles `--filter` for `--json`; reused as is), `sessMatches`, `dayMatches`, `display()`.
- Produces:
  - `export interface JRepo { key: string; label: string; kind: string; worktrees: { name: string; top: string }[]; sessions: number; live: number; last: string; costUsd: number | null; unpricedTokens: number; tokens: { in: number; out: number }; calls: number; errors: number; errorRate: number | null; activeMin: number; agentMin: number; files: { path: string; edits: number; add: number; del: number; harnesses: string[] }[]; outsideFiles: number; byHarness: { harness: string; sessions: number; costUsd: number | null }[]; branches: { branch: string; sessions: number; costUsd: number | null }[] }`
  - `export function repoJson(r: RepoAgg): JRepo` — files top 50; `costUsd` null when `cost === 0 && unk > 0`; `errorRate` null under 10 calls; labels/paths through `display()`.
  - `export function reposCli(days: number, f: Compiled | null): void` — `days` default 7, `0` = `allDays()`; `day` clauses of the filter narrow further (via `dayMatches`); before aggregating: `discover()`, `complete(s)` for sessions passing the session clauses, `resolveTick(1e9, 1e9, Date.now, run)`; prints a JSON array, `process.exit(0)`. Invalid `--days` → `fail("--days needs a number ≥ 0")` (exit 2).

- [ ] **Step 1: Failing check**: `repoJson` on a synthetic `RepoAgg` with 60 files → 50 in output; unpriced → `costUsd: null`; 9 calls → `errorRate: null`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; `./agentglass --json --repos --days 7 | head -c 1500` → array of projects; `--days 0` → more or equal projects; `--filter 'harness is codex' --repos` → only Codex shares; `--redact` → labels faked, no real path in output (`grep -c "$HOME"` → 0).
- [ ] **Step 5: Commit** `feat(repos): agentglass --json --repos`.

---

### Task 10: Real-life verification, docs, final review

**Files:** Modify `README.md` (Repos tab, keys, `@`, `--repos`, `--days`, `repo.idleGapMin`, worktree/clone merging, forks are separate projects, active time is a union and differs from the call tree's span-based "active", changed gap applies to newly indexed lines only, file counts approximate on very busy days, symlink limitation if Task 0 fell back), `src/features/cli.ts` help text (done in Task 9), help popup section (Task 8).

- [ ] **Step 1: Real data (read-only)** with a fresh build: `./agentglass` → Repos tab: `~/code/agentglass` and its worktrees (`agentglass-plans`, any `agentglass-*`) are **one** row with `⑂N` = worktree count; Claude worktree-isolated subagent sessions land in that row; a non-git dir shows `~/…`; cost of the period equals the Stats tab total for the same period (± subagent attribution note); `resolving N sessions…` disappears within a few seconds on a cold start (`rm ~/.agentglass/cache/projects.json` first — it is a cache, not user data).
- [ ] **Step 2: Measure** cold-start resolve time (`time ./agentglass --json --repos --days 0 > /dev/null`) and `projects.json` size; note both in the PR description.
- [ ] **Step 3: Privacy check**: `grep -E "ghp_|ghs_|glpat-|x-access-token|@" ~/.agentglass/cache/projects.json` → no credential hits (an `@` only inside a scrubbed-out form must not appear at all).
- [ ] **Step 4: Docs** as listed. `sh scripts/check.sh` → all `ok`; `./build.sh` → ok.
- [ ] **Step 5: Commit** `docs: Repos tab and project identity in the README`.
- [ ] **Step 6: Final whole-branch review** (most capable model) against spec + this plan's Review Focus; one fix pass; PR to `main` (body ends with the Claude Code attribution line); CI green; rebase-merge; remove worktree and branch.
