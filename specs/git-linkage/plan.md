# Git Linkage (Commits, PRs, Issues per Session) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session shows the commits it produced (✓ counted), commits seen nearby (≈ / `? shared`, listed, never counted), the PRs/MRs, issues and commit links it created or mentioned, and $/commit — per session, per branch and per project — from transcripts, `.git` files and a few budgeted local `git` calls.

**Architecture:** The ledger pass gets a scraper (`src/features/usage/vcs.ts`) that runs before `usage()` on every line and stores `VRef`s in `Acc.vcs` (commit banners, forge URLs, git-command spans). `src/features/vcs/` reads each worktree's `logs/HEAD` reflog without spawning, attributes reflog commits to sessions through repo-view's identity (`Ident.gitdir`, provided by repo-view) and activity windows, and enriches shas with one lazy `git log --no-walk` per session view. Output: preview section, a full-screen `git` view (`V`), Repos detail additions, `--json` `git`, `--json --git`, `--json --repos` fields.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps; `node:fs`; `run()` (`src/util/fs.ts:35-37`, sync, 4 s timeout) for the few git spawns. Checks are standalone scriptc programs (`*.check.ts`).

**Spec:** [spec.md](spec.md) — read it first, including "Decisions (review 2026-10-02)"; this plan argues from it. Section references below ("spec 4") are section numbers of that spec.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields); call optional function members via a local; out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log`.
- Local only: transcript bytes, `.git` files, the local `git` binary. Never `fetch`, `ls-remote`, `push`, or any forge API. Never write into `.git` or agent data dirs.
- Git spawns: reflog reading spawns nothing. Allowed spawns: `git -C <top> log --no-walk=unsorted --ignore-missing …` (enrichment, ≤ 100 shas, one per session view, only for the git view or `--json --git`), the no-reflog window `git log` (one per session, cached), `git -C <top> config user.email` (one per repo, cached). At most one git spawn per 500 ms tick in the TUI.
- Every scraped URL goes through `scrubRemote()`; only `Remote.url` is kept; `null` drops the URL. Committer names and emails from the reflog are parsed but never stored, shown or exported (the window fallback's `--author` value stays in memory only, never in `vcs.json`).
- ≈ and `? shared` commits are listed but never counted in commits produced, $/commit or per-branch totals (spec decisions 1, 2, 4).
- `git.tailPadMin`: integer 0–120, default 10; invalid → 10 with one startup toast (spec decision 3).
- Caps: ≤ 200 `VRef` per session (drop the oldest `mentioned` first); reflog read ≤ 8 MB (tail, line-aligned); subjects ≤ 80 chars; `arg` stays ≤ 120 chars.
- Ledger `VERSION` (`src/features/usage/cache.ts:15` on `main` today): the next free number at implementation time; when this branch ships in the same release as repo-view, it shares repo-view's one bump (Task 0 Step 4). Exactly one decision, one number.
- Keys: `V` opens the git view in the Sessions list (`S.tab === 0`) and in the transcript (both free today; transcript uses lowercase `v`). Inside the view: `↑↓ jk g G`, `enter`, `y`, `esc`.
- Under `--redact`: subjects and URLs go through `display()` kind `vcs` (subjects from the title pool, `owner/repo` → fake project name, numbers and shas kept).
- Style: dense one-line helpers, short `//` comments saying why, no new dependencies.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-git-linkage`, branch `feat/git-linkage`, PR to `main`, rebase-merge after green CI. **Phase 5.** Starts when parsing-fixes (`scrubRemote`), filter-language (per-call rows touch `Pend`/`done()`), and **repo-view** (`Ident` incl. `gitdir`, `identOf()`, `Day.act`, `Acc.al`, `RepoAgg`, Repos detail boxes, ledger bump) are merged — the spec uses repo-view's identity and windows, so this branch cannot start in parallel with it.

## Review Focus

1. **Two agents in one worktree** (or an agent plus the person committing by hand): a reflog commit covered by both windows is `? shared` on both and counted in neither; a commit observed by A never shows as ≈ or shared on B. Task 4 check.
2. **`git commit --quiet` / `--allow-empty`** (no banner, no `N files changed`): matched to the session's `gcall` span → ✓; the same reflog line outside every span → ≈, not counted. Task 2 (span recorded) + Task 4 (attribution) checks.
3. **Banner text that is not a commit** — `cat` of a log file, `git log`/`git show` output, a test fixture echoing `[main abc1234] x`: never accepted. Task 1 + Task 2 checks.
4. **Amend chains and rebases**: `commit` → `commit (amend)` → `commit (amend)` counts once; a squashed-away ✓ sha is `missing`, still counted, flagged; a banner sha from `git -C ../other commit` that is in neither this gitdir's reflog nor its object DB is `elsewhere`, not counted. Task 3 + Task 5 checks.
5. **Credential-bearing URLs in tool output** (`https://x-access-token:ghs_…@github.com/o/r/pull/3`, `?token=` query): stored scrubbed or dropped, never in `ledger.json`, `vcs.json` or `--json`. Task 1 check + Task 7 grep.

---

### Task 0: Worktree, probes, open question, version decision

**Files:** none committed; rulings in `/tmp/agentglass-git-linkage-rulings.md`, copied into the PR description.

- [ ] **Step 1: Worktree** `git worktree add -b feat/git-linkage ../agentglass-git-linkage main && cd ../agentglass-git-linkage && ./build.sh && sh scripts/check.sh` → all `ok`. Confirm repo-view is merged: `grep -n "export interface Ident" src/model/project.ts && grep -n "gitdir" src/model/project.ts && grep -n "act:" src/features/usage/record.ts` → all found (`Ident.gitdir` is repo-view's).
- [ ] **Step 2: Open question 1 — Kiro and fx result-line shapes** (spec 2, uncertain). Code evidence on `main`: Kiro results carry `data.content[].data.toolUseId` (`src/harness/kiro.ts:113-120`), fx results carry `event.tool_result.call_id` (`src/harness/fx.ts:76-80`) — so the pending-call lookup by id works for both. Confirm on real data (read-only): `grep -l '"ToolResults"' ~/.kiro/sessions/cli/*.jsonl | head -3` then `grep -o '"toolUseId":"[^"]*"' <file> | head -3` → ids present; `ls ~/.fx/sessions 2>/dev/null | head` (no fx sessions on this machine on 2026-10-02 → use hand-written lines in the shape `fx.ts:69-85` parses). Look for a real banner in Kiro output: `grep -l 'files\? changed' ~/.kiro/sessions/cli/*.jsonl | head -3`. Fallback the spec names if a harness carries no id: same-line command only, else no banners for that harness (document in README).
- [ ] **Step 3: Real git output shapes** in a scratch repo (`/tmp/agglp`, `git init -b main`, identity via `-c user.email=a@b -c user.name=n`): capture stdout of `git commit -m one`, `git commit --allow-empty -m e`, `git commit --quiet -m q`, `git merge --no-ff -m mrg f`, `git cherry-pick <sha>`, `git revert --no-edit <sha>`, `git commit --amend -m a2`, `git rebase main`, `git reset --hard HEAD~1`, and `.git/logs/HEAD`. Evidence gathered on 2026-10-02 with git 2.51: commit prints `[main 0ec883d] one` + ` 1 file changed, …`; `--allow-empty` prints `[main e43b754] e` + ` Date: …` (no "changed"); `git merge` prints **no** `[branch sha]` banner (`Merge made by the 'ort' strategy.`); reflog messages include `commit (initial):`, `commit:`, `checkout: moving from main to f`, `merge f: Merge made by the 'ort' strategy.`, and `commit (cherry-pick):` (now in the spec's list, Decision 7). Rulings: (a) any reflog message `commit (<word>):` is op `commit` except `(amend)` → `amend`, `(merge)` → `merge` and `(cherry-pick)` → `cherry-pick` (spec 1, Decision 7); (b) merges are ✓ only through a `gcall` span; (c) the prefilter also accepts `"] "` + `" Date: "` so empty-commit banners after a known git command are not lost. Turn the captured lines into hand-written strings inside the checks (no real repo data committed).
- [ ] **Step 4: Ledger version decision** (next free number at implementation time; no reserved number). `grep -n "const VERSION" src/features/usage/cache.ts` → N (repo-view's number). `git tag --contains $(git log -1 --format=%H -S"const VERSION = N" -- src/features/usage/cache.ts)` and the dev channel's latest published build (`scripts/dev-pinned.sh` / release notes): if no stable or dev build carrying N exists, Task 2 keeps N and appends `+ Acc.vcs, Acc.af (git-linkage)` to its comment; else Task 2 bumps to N+1. Write the ruling.
- [ ] **Step 5: `git log` flags**: `git -C /tmp/agglp log --no-walk=unsorted --ignore-missing --format=%H%x1f%P%x1f%ct%x1f%s%x1e --shortstat <sha> deadbeef` → one record for `<sha>`, nothing for `deadbeef`, exit 0. Fallback if `--ignore-missing` errors on an old git: pass shas one by one in the same spawn budget (≤ 1 per tick).

---

### Task 1: Pure scraping helpers (prefilter, banners, forge URLs, command classes)

**Files:** Create `src/features/usage/vcs.ts` (pure part), `src/features/usage/vcs.check.ts`.

**Interfaces:**
- Consumes: `scrubRemote(raw: string): Remote | null` (parsing-fixes, `src/util/giturl.ts`).
- Produces:
  - `export function prefilter(l: string): boolean` — `indexOf` only: `" changed, "`, `" changed\\n"`, `" changed\n"`, `"] "` together with `" Date: "`, `"/pull"`, `"merge_requests/"`, `"/issues/"`, `"/commit/"`, `"/commits/"`, `"pull-requests/"`, `"/pulls/"`.
  - `export function unesc(s: string): string` — `\/` → `/`, `\n` → newline, `\"` → `"`, `\\` → `\`.
  - `export interface Banner { br: string; sha: string; subj: string }`
  - `export function banners(text: string): Banner[]` — per line, `^\[(detached HEAD|[^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$`; `subj` ≤ 80 chars; `br` `""` for detached.
  - `export interface FUrl { k: string /* pr | issue | commit */; url: string /* canonical, scrubbed */; n: number /* PR/issue number, 0 for commits */; sha: string }`
  - `export function forgeUrls(text: string): FUrl[]` — spec 2 table: `…/pull/<n>` (not `/pull/new/…`), `…/pulls/<n>`, `…/-/merge_requests/<n>` (nested groups), `…/pull-requests/<n>`; `…/issues/<n>`, `…/-/issues/<n>`; `…/commit/<sha>`, `…/-/commit/<sha>`, `…/commits/<sha>`. Host case-insensitive; trailing `)`, `]`, `>`, `.`, `,` stripped; suffixes (`/files`, `/diffs`, `#…`, `?…`) dropped; canonical = `https://<host>/<path>/<kind segment>/<n|sha>` with the forge's own kind segment kept; through `scrubRemote`; `null` → dropped.
  - `export function isBannerCmd(cmd: string): boolean` — contains `git` and one of `commit`, `merge`, `cherry-pick`, `revert`.
  - `export function isGitCall(cmd: string): boolean` — contains `git` and one of `commit`, `merge`, `cherry-pick`, `revert`, `am`, `rebase` (word-bounded: `\bam\b`).
  - `export function createdBy(cmd: string, tool: string): boolean` — `gh pr create`, `glab mr create`, `hub pull-request`, `tea pr create`, `tea prs create`, `gh issue create`, `glab issue create`, or tool name matching `/create_(pull_request|merge_request|issue)/`.

- [ ] **Step 1: Failing check** `vcs.check.ts`: `prefilter` false for 10 ordinary Claude/Codex lines (assistant text, `ls` result, a `Read` result), true for a banner result line and a PR URL line; `banners("[main 0ec883d] one\n 1 file changed")` → `{br:"main", sha:"0ec883d", subj:"one"}`; `[main (root-commit) abc1234] x`, `[detached HEAD abc1234] y` (br `""`); `x [main abc1234] y` (not at line start) → none; `forgeUrls` on `https://github.com/o/r/pull/12/files).` → pr 12 `https://github.com/o/r/pull/12`; `https://github.com/o/r/pull/new/feat` → none; `https://gitlab.com/g/sub/p/-/merge_requests/7#note` → pr 7 path `g/sub/p`; `https://bitbucket.org/o/r/pull-requests/3` → pr 3; `https://gitea.example.com/o/r/pulls/9` → pr 9; `/issues/5`, `/-/issues/5`; `/commit/<40 hex>`, `/commits/<sha>`; `https://x-access-token:ghs_SECRET@github.com/o/r/pull/3` → url without `ghs_SECRET`; a token-shaped path → dropped; `unesc("https:\\/\\/github.com\\/o\\/r\\/pull\\/1")` → plain URL; `isBannerCmd("cat log.txt")` false, `isBannerCmd("git log")` false, `isBannerCmd("git commit -m x")` true; `isGitCall("git commit --quiet -m q")` true, `isGitCall("git amend-notes")` false; `createdBy("gh pr create --fill", "Bash")` true, `createdBy("", "mcp__github__create_pull_request")` true, `createdBy("gh pr view 3", "Bash")` false.
- [ ] **Step 2: Run** `scriptc build src/features/usage/vcs.check.ts -o /tmp/vc && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/vc` → FAIL (exports missing).
- [ ] **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(vcs): commit banner, forge URL and git command matchers`.

---

### Task 2: Scraping in the ledger pass (`Acc.vcs`, `Pend.name`, gcall spans, persistence)

**Files:** Modify `src/features/usage/vcs.ts` (`scrape`, `settle`, `addRef`), `src/features/usage/calls.ts` (`Pend.name`), `src/features/usage/record.ts` (`pend()` stores `name`; `Acc.vcs`, `Acc.af`; `actMark` sets `af`), `src/features/usage/ledger.ts` (`step()` both branches: `const g = scrape(a, l); ad.usage(a, l); if (g) settle(a, g);`), `src/features/usage/cache.ts` (persist `v`, `af`; `VERSION` per Task 0 Step 4); Test `src/features/usage/vcs.check.ts`, `src/harness/harness.check.ts` (one `git commit` sample per harness).

**Interfaces:**
- Consumes: Task 1 helpers; `Acc.al` (repo-view: epoch ms of the latest activity); `pend()`/`done()`.
- Produces:
  - `Pend.name: string` (in memory, not persisted).
  - `export interface VRef { k: string /* commit | pr | issue | gcall */; v: string /* sha, canonical URL, or "<t0>-<t1>" for gcall */; t: number /* epoch ms */; how: string /* observed | created | mentioned */; br: string; subj: string; call: string; ts: string }`
  - `Acc.vcs: VRef[]`; `Acc.af: number` (epoch ms of the first activity, min over `actMark` calls; persisted `af`).
  - `export interface Gc { ref: VRef; t0: number }` (a gcall waiting for its end time)
  - `export function scrape(a: Acc, l: string): Gc | null` — `prefilter` first (return `null` on miss unless the line can close a pending git call: also run when any pending call has a `name` and `isGitCall(arg)` — check `a.pend` size first; the set is small). Producing command: a pending call whose id occurs in `l` (iterate `a.pend`, `l.indexOf(id) >= 0`) → `arg`, `name`, `call` = id, `t`, `ts`; else a `"command"` or `"cmd"` string field in the same line (regex over `unesc(l)`, first 4 KB); else unknown. Banners: only when the command is known and `isBannerCmd(cmd)` → `commit` refs `how:"observed"`, `t` = pend `t`. URLs: `how` = `createdBy(cmd, name) ? "created" : "mentioned"`. `isGitCall(cmd)` → returns `{ ref: {k:"gcall", v:"", t: p.t, …}, t0: p.t }`.
  - `export function settle(a: Acc, g: Gc): void` — `t1 = max(g.t0, a.al)`; `g.ref.v = String(g.t0) + "-" + String(t1)`; `addRef(a, g.ref)`.
  - `export function addRef(a: Acc, r: VRef): void` — dedup by `(k, v)` (gcall refs never dedup), first sighting wins, `created` upgrades `mentioned`; at 200 drop the oldest `mentioned`, else the oldest ref.
  - Persistence: `accOut` key `v` = array of `[k, v, t, how, br, subj, call, ts]`; `af` number.

- [ ] **Step 1: Failing checks** (vcs.check.ts with an `Acc` from `newAcc()`; harness lines hand-written in the real shapes of each adapter):
  - Claude: `tool_use` Bash `git commit -m one` (id `toolu_1`) then the `tool_result` line containing `[main 0ec883d] one\\n 1 file changed` → one `commit` ref `0ec883d`, `how observed`, `call toolu_1`, plus one `gcall` with `v` `"<t0>-<t1>"`, `t1 ≥ t0`;
  - the same result text after a `cat out.txt` call → no commit ref; after `git log` → none;
  - OpenCode-style record with `"command":"git commit -m x"` and the banner in the same line → accepted;
  - Kiro: AssistantMessage with toolUse `execute_bash` `git commit -m k` (`toolUseId` `t1`), ToolResults with `toolUseId` `t1` and the banner → accepted; fx: `tool_call` `call_id` `c1` + `tool_result` `call_id` `c1` → accepted;
  - `git commit --quiet -m q` (no output) → only a `gcall` ref;
  - `gh pr create` result with `https://github.com/o/r/pull/12` → `pr` `created`; the same URL later in a `gh pr view` result → still one ref, `created`; a `mentioned` URL first then `created` → upgraded;
  - 210 distinct mentioned URLs + 1 created → 200 refs, the created one kept;
  - escaped `https:\/\/github.com\/o\/r\/issues\/5` in raw JSON → `issue` 5;
  - persistence round trip (`accIn(JSON.parse(JSON.stringify(accOut(a, 64))))`, honest-costs' exported codec in `src/features/usage/codec.ts`) keeps `vcs` and `af`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; set `VERSION` per Task 0. **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; existing harness checks unchanged.
- [ ] **Step 5: Commit** `feat(vcs): scrape commit banners, forge links and git calls into the ledger`.

---

### Task 3: Reflog reader

**Files:** Create `src/features/vcs/reflog.ts`, `src/features/vcs/reflog.check.ts`. No change to `src/model/project.ts`: `Ident.gitdir` is repo-view's.

**Interfaces:**
- Consumes: `Ident` (incl. `gitdir: string`, the per-worktree git dir), `resolveCwd` (repo-view).
- Produces:
  - `export interface RefEv { at: number /* epoch ms */; old: string; sha: string /* the spec's "new"; renamed: `new` is a keyword */; op: string /* commit | amend | merge | cherry-pick | revert | checkout | rebase | reset | other */; branch: string; subj: string; amended: boolean }`
  - `export function parseReflog(text: string, head: string): RefEv[]` — line `<old> <new> <name> <<email>> <epoch> <tz>\t<msg>`; op from msg: `commit:` / `commit (initial):` / `commit (<other>):` → `commit` (Task 0 ruling a), `commit (amend):` → `amend`, `commit (merge):` / `merge ` → `merge`, `commit (cherry-pick):` / `cherry-pick:` → `cherry-pick`, `revert:` → `revert`, `checkout:` → `checkout`, `rebase` prefix → `rebase`, `reset:` → `reset`, `pull` and the rest → `other`; `subj` = text after the first `: ` ≤ 80 chars; name and email are skipped by the parser (never copied into `RefEv`). `branch`: `head` (from `<gitdir>/HEAD` `ref: refs/heads/<b>`) **before** replay is unknown for early lines, so replay backwards: the last checkout `moving from A to B` sets B after it and A before it; lines before the first checkout get that checkout's `A`, or `head` when there is no checkout. `amend`: the event's `old` sha's commit event gets `amended: true`.
  - `export function readReflog(gitdir: string): RefEv[]` — `<gitdir>/logs/HEAD`, whole file ≤ 8 MB, else the last 8 MB starting after the first `\n`; cached per gitdir by `(size, mtime)`; missing file → `[]`.
  - `export function headBranch(gitdir: string): string`
  - `export function isNew(e: RefEv): boolean` — op ∈ commit, amend, merge, cherry-pick, revert.

- [ ] **Step 1: Failing checks**: fixture text with the Task 0 lines (`commit (initial)`, `commit`, `checkout: moving from main to f`, `commit` on f, `checkout: moving from f to main`, `merge f: …`, `commit (cherry-pick): e`, `commit (amend): a2`, `rebase (finish): returning to refs/heads/main`, `reset: moving to HEAD~1`) → ops, branches (`main`, `main`, -, `f`, -, `main`, `main`, `main`), the amended commit flagged, `isNew` for the five new-work ops only; no field contains the email `a@b`; tail: a 9 MB synthetic file (written in the check's temp dir) → first returned event starts at a line boundary and the last event is the file's last line; cache: second `readReflog` with unchanged size/mtime returns the same array object. Uses `Ident.gitdir` as repo-view resolves it (main repo `<r1>/.git`, worktree `w1` `<r1>/.git/worktrees/w1`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(vcs): reflog reader with branch replay`.

---

### Task 4: Attribution (observed, reflog ≈, shared, window `git log` fallback)

**Files:** Create `src/features/vcs/attrib.ts` (reads `git.tailPadMin` at import: `GIT.pad = intSetting("git", "tailPadMin", 0, 120, 10)`; `intSetting(sec, key, lo, hi, def)` is filter-language's config int helper in `src/util/config.ts`, also used by repo-view for `repo.idleGapMin`), `src/features/vcs/attrib.check.ts`.

**Interfaces:**
- Consumes: `VRef` (Task 2), `RefEv`, `readReflog`, `isNew` (Task 3), `identOf(s)`, `GitRun = (cmd: string, args: string[]) => string` (repo-view, `src/model/project.ts`), `Acc.af`, `Acc.al`, `ledger`, `L.ver`, `run()`.
- Produces:
  - `export const GIT = { pad: 10 }` (minutes)
  - `export interface SessIn { path: string; gitdir: string; key: string /* project */; top: string; branch: string; t0: number; t1: number; live: boolean; refs: VRef[] }`
  - `export interface GCommit { sha: string; br: string; subj: string; at: number; how: string /* observed | reflog | shared */; counted: boolean; status: string /* present | missing | amended | elsewhere | unknown */; add: number; del: number; call: string; ts: string }`
  - `export interface GLink { url: string; n: number; how: string /* created | mentioned */; call: string; ts: string }`
  - `export interface GitInfo { commits: GCommit[]; prs: GLink[]; issues: GLink[]; links: GLink[]; produced: number; noReflog: boolean; byBranch: Map<string, number> /* counted commits per branch */ }`
  - `export function windowOf(af: number, al: number, live: boolean, padMin: number, now: number): number[]` — `[af − 120000, (live ? now : al) + padMin·60000]`; `[]` when `af === 0`.
  - `export function attribute(ss: SessIn[], logs: Map<string, RefEv[]>): Map<string, GitInfo>` — pure. Per spec 4: observed = banner shas (prefix-matched to reflog shas of the same gitdir when present) plus reflog new-work events inside one of the session's gcall spans `[t0, t1 + 5000]`; the observed set is global over all sessions; remaining reflog new-work events of a gitdir inside a session window → covered by exactly one session → `reflog` on it; by ≥ 2 → `shared` on each; ≈/shared `counted: false`. Amend: an observed commit whose sha was later amended (`amended: true`) and whose amend result is also observed counts once (`status: "amended"` on the old row, `counted: false`). A banner sha absent from the gitdir's reflog keeps `status: "unknown"` and is counted (Task 5 may turn it into `elsewhere`). `produced` = counted commits; `byBranch` from `br` (banner) or reflog branch.
  - `export function sessIn(s: Sess): SessIn | null` — glue: `identOf(s)` with `gitdir !== ""`, `accOf`-free read of `ledger.get(s.path)`.
  - `export function windowLog(top: string, branch: string, t0: number, t1: number, git: GitRun): RefEv[]` — no-reflog fallback (spec 3): `rev` = `refs/heads/<branch>` when `<common>/refs/heads/<branch>` exists or `packed-refs` lists it, else `--branches`; author from `userEmail(top, git)` (cached per top, in memory only; empty → no `--author`); `git -C <top> log <rev> --since=@<t0s> --until=@<t1s> [--author=<email>] --format=%H%x1f%ct%x1f%s%x1e`; parsed into `RefEv` with op `commit`; cached per (session path, t0, t1).
  - `export function gitInfo(s: Sess): GitInfo | null` — cached per (`L.ver`, reflog size/mtime of its gitdir); groups all sessions sharing the gitdir; when `readReflog` is `[]` uses `windowLog` (budgeted by Task 5's spawn gate) and attributes those commits only when the session is the only one of its project with a window covering the commit time; `noReflog: true` → UI says "no reflog — matched by time".

- [ ] **Step 1: Failing checks** (`attrib.check.ts`, pure `attribute` over hand-built `SessIn`s and `RefEv`s; times in ms):
  - A and B share gitdir X, windows overlap; reflog commit at a time inside both → `shared` on both, `counted false`, `produced` 0 on both;
  - A in X, B in worktree Y, reflog commits per gitdir → separate, no cross-listing;
  - A has banner `abc1234`, the reflog has `abc1234ffff…` in X inside B's window too → ✓ on A, absent on B;
  - A's gcall span `[1000, 2000]`, reflog commit at 6500 ms (> t1 + 5 s) → ≈; at 6000 → ✓;
  - reflog commit outside every window → on no session;
  - `windowOf(af, al, false, 0, now)` vs `30` → a commit 20 min after `al` is in the window only with pad 30;
  - amend chain commit→amend→amend all observed → `produced` 1;
  - `byBranch` with commits on `main` and `f` → 1/1;
  - `windowLog` with a stub `git` returning two records → two `RefEv`; stub called with `--since=@<s>` seconds and `--author=a@b` after `userEmail` stub returns `a@b`; a second call with the same args → stub not called again;
  - `git.tailPadMin` validator: `-1` → 10 + one toast, `30` → 30.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(vcs): attribute reflog commits to sessions — observed, ≈ and shared`.

---

### Task 5: Enrichment via `git log --no-walk` (lazy, budgeted, cached)

**Files:** Create `src/features/vcs/enrich.ts`, `src/features/vcs/enrich.check.ts`.

**Interfaces:**
- Consumes: `GitInfo`, `GCommit` (Task 4), `run()`, `HOME`.
- Produces:
  - `export interface Stat { sha: string /* full */; merge: boolean; at: number; subj: string; add: number; del: number; files: number }`
  - `export function parseShow(out: string): Stat[]` — records split at `\x1e`, fields at `\x1f` (`%H`, `%P`, `%ct`, `%s`), followed by the optional `--shortstat` line (` N files changed, A insertions(+), D deletions(-)`, each part optional).
  - `export function applyStats(g: GitInfo, st: Stat[], inReflog: Set<string>): void` — prefix match short → full sha; not returned → `missing` when the sha is in this gitdir's reflog, else `elsewhere` (`counted: false`, spec 9); returned → `present` (merge flag kept; `amended` rows unchanged).
  - `export const VCS_FILE = join(HOME, ".agentglass", "cache", "vcs.json")`
  - `export function enrich(s: Sess, g: GitInfo, top: string, live: boolean, git: GitRun): boolean` — one spawn `git -C <top> log --no-walk=unsorted --ignore-missing --format=%H%x1f%P%x1f%ct%x1f%s%x1e --shortstat <sha…>` (≤ 100 shas, observed first); gate: at most one spawn per 500 ms tick (module-level `lastSpawn`), live sessions at most every 60 s while visible; result cached by (session path + sha list): closed sessions (no pid and window ended > 10 min ago) persisted in `VCS_FILE` (atomic, saved on quit and every 30 s when dirty), live ones in memory; `run()` → `""` → `G.unavailable = true` ("git unavailable"), commits keep short shas, no stats.

- [ ] **Step 1: Failing checks**: `parseShow` on a two-record sample (one merge with 2 parents, one with ` 3 files changed, 10 insertions(+), 2 deletions(-)`, one with only insertions) → fields; `applyStats` with one sha missing from output and present in the reflog → `missing`, counted stays true; missing and not in the reflog → `elsewhere`, counted false; stub `git` that returns `""` → unavailable flag, no throw; gate: two `enrich` calls within 500 ms → stub called once; cache: a closed session's second `enrich` reads `VCS_FILE` (temp path via an exported `setVcsFile(p)` for the check) without spawning.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(vcs): lazy git log enrichment with diff stats and missing/elsewhere status`.

---

### Task 6: Preview section, git view (`V`), redaction kind `vcs`

**Files:** Create `src/features/vcs/view.ts`; Modify `src/main.ts` (import `./features/vcs/view.ts` after `./features/repos/tab.ts`), `src/features/redact.ts` (`display` kind `vcs`), `src/features/usage/stats.ts` (export `jump()` as `jumpTo(path: string, id: string, ts: string)` if repo-view did not already); Test `src/features/vcs/view.check.ts`, `src/features/redact.check.ts`.

**Interfaces:**
- Consumes: `gitInfo`, `enrich` (Tasks 4–5), `money()`, `copyText(text, what)` (`src/actions.ts:29`), `openTranscript` (`src/ui/transcript.ts:100`), `jumpTo`, `H.previewSections`, `H.views`, `H.keys`, `display()`.
- Produces:
  - `export function perCommit(cost: number, unk: number, produced: number): string` — `""` when `produced === 0`; `?` when `cost === 0 && unk > 0`; else `money(cost / produced, 0) + "/commit"`.
  - `export function previewLine(g: GitInfo, cost: number, unk: number): string` — `git      3 commits (✓3 · ≈1 · ?1 shared not counted) · PR #142 (created) · $0.84/commit` (parts omitted when zero; the first created PR, else the first mentioned).
  - `export function viewRows(g: GitInfo): Row[]` with `interface Row { kind: string /* commit | pr | issue | link */; text: string; dim: boolean; call: string; ts: string; copy: string }` — commits (✓ / ≈ / `? shared`, short sha, time, branch, `+a −d`, subject, status; ≈ and shared dim with `not counted`), then PRs/MRs, issues, other links (`created` first).
  - View `git` registered in `H.views`; `V` in Sessions list (`S.tab === 0`) and transcript opens it for the selected row's own session (a subagent row shows the subagent's refs; a parent row shows its own refs plus its subagents' commits, as parent totals include sub-agent commits, spec 9); `enter` on a row with `call` → `jumpTo(path, call, ts)`; `y` → `copyText(row.copy, "sha" | "url")`; `esc` → previous mode. Opening the view triggers `enrich` (the only TUI path that spawns).
  - Redact `vcs`: subject → `pick(TITLES, subject)`; URL → `owner/repo` replaced with `fakeProject(owner)/fakeProject(repo)`, numbers and shas kept.
  - Help section `git` with `V`, `enter`, `y`, the ≈/shared "not counted" note.

- [ ] **Step 1: Failing checks**: `previewLine` for ✓3 ≈1 shared1 + created PR 142 + cost 2.52 → exact text above; zero commits → no `$/commit`; unpriced → `?`; `viewRows` ordering (✓ before ≈, created PR before mentioned) and dim flags; redact: `display("vcs", "https://github.com/me/x/pull/7", null)` keeps `/pull/7`, not `me/x`; a subject is replaced and stable.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; manual: a session with commits → preview line; `V` → view; `enter` lands on the tool call in the transcript; `esc` back.
- [ ] **Step 5: Commit** `feat(vcs): git preview line and session git view`.

---

### Task 7: Repos integration and CLI (`--json` `git`, `--git`, `--repos` fields)

**Files:** Modify `src/features/repos/agg.ts` (`RepoAgg.commits`, `RepoAgg.spendNoCommit`, `BranchAgg.commits`, `RepoAgg.prs`), `src/features/repos/tab.ts` (`commits` column; branches box `commits`, `$/commit`, created PR links), `src/features/repos/cli.ts` (`JRepo.commits`, `costPerCommit`, `spendWithoutCommits`), `src/features/cli.ts` (`JSess.git`, `--git` option, help lines); Test `src/features/repos/agg.check.ts`, `src/features/vcs/view.check.ts`.

**Interfaces:**
- Consumes: `gitInfo`, `enrich`, `GitInfo`, `perCommit` (Tasks 4–6); repo-view `RepoAgg`, `BranchAgg`, `repoJson`.
- Produces:
  - `RepoAgg.commits: number` (Σ `produced` of its top-level sessions, sub-agent commits included through their own sessions), `RepoAgg.spendNoCommit: number` (Σ cost of sessions with `produced === 0` in the period), `RepoAgg.prs: string[]` (created PR URLs), `BranchAgg.commits: number`; a session with commits on two branches splits its cost over `byBranch` by commit count.
  - `JSess.git: { commits: { sha: string; branch: string; subject: string; at: string; how: string; counted: boolean; status: string; add: number | null; del: number | null }[]; prs: { url: string; number: number; how: string }[]; issues: { url: string; number: number; how: string }[]; links: { url: string; how: string }[]; costPerCommit: number | null; noReflog: boolean } | null` (null for non-git sessions). Without `--git`: `status` `"unknown"` (except `amended`), `add`/`del` null; with `--git`: `enrich` per listed session synchronously (gate off in CLI).
  - `JRepo.commits: number`, `JRepo.costPerCommit: number | null`, `JRepo.spendWithoutCommits: number`.

- [ ] **Step 1: Failing checks**: agg with two sessions (one with 2 commits on `main`, cost 4; one without commits, cost 1) → `commits 2`, `spendNoCommit 1`, branch `main` commits 2 and `$/commit` 2.00; a session with 1 commit on `main` and 1 on `f`, cost 2 → each branch cost 1; JSON shaping: no `--git` → `add: null`; a non-git session → `git: null`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; `./agentglass --json --limit 20 | grep -c '"git"'` → 20; `./agentglass --json --git --limit 5` spawns ≤ 5 git processes (`strace -f -e execve -o /tmp/st ./agentglass …; grep -c '"git"' /tmp/st` or `ps` count) ; `./agentglass --json --repos --days 7` has `commits`; privacy: `grep -E "ghs_|ghp_|glpat-|x-access-token" ~/.agentglass/cache/ledger.json ~/.agentglass/cache/vcs.json` → no output.
- [ ] **Step 5: Commit** `feat(vcs): commits and $/commit in the Repos tab and --json`.

---

### Task 8: Real-life verification, docs, final review

**Files:** Modify `README.md` (git linkage: sources, ✓/≈/shared and what counts, `V`, `--git`, `git.tailPadMin`, "no reflog — matched by time", local only, quiet commits via git-call spans, merges counted only when the session ran the merge, Kiro/fx notes from Task 0), help text (Task 6/7).

- [ ] **Step 1: Real data (read-only)**: on this repository's own history (sessions that committed in `~/code/agentglass` and its worktrees): pick three sessions known to have committed (`git -C ~/code/agentglass log --since=7.days --format='%h %ci %s' | head`), open each in the TUI → ✓ commits match the shas in `git log` for that worktree; a session in `agentglass-plans` does not list commits made in `agentglass`; the Repos `agentglass` row's `commits` equals the sum over its sessions; `V` → `enter` lands on the `git commit` call; a session with a PR URL shows it `created` when it ran `gh pr create`.
- [ ] **Step 2: Measure** the re-index time after the `VERSION` change and the `ledger.json` size delta (note both in the PR).
- [ ] **Step 3: Docs.** `sh scripts/check.sh` → all `ok`; `./build.sh` → ok.
- [ ] **Step 4: Commit** `docs: git linkage in the README`.
- [ ] **Step 5: Final whole-branch review** (most capable model) against spec + Review Focus; one fix pass; PR to `main` (body ends with the Claude Code attribution line); CI green; rebase-merge; remove worktree and branch; `rm -rf /tmp/agglp`.
