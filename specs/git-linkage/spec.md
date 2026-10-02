# Git linkage (commits, PRs, issues per session) — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 5 (depends on parsing-fixes: `scrubRemote`;
uses repo-view's project identity).

## Goal
For every session, show which commits it produced, which PRs/MRs and issues it created or referenced, and what that
cost: **commits produced**, **$ per commit**, and $ per branch, per session and per project. Only local data is used:
transcripts, the repository's own files, and at most a few `git` invocations. There are no forge APIs and no network.

## Why (user value)
- "What did I get for $12?" A commit count, a PR link and the diff size answer it. Cost per commit shows which
  agent/model/workflow pays off, and which sessions spend money and produce nothing.
- PR and issue links that agents print scroll away in the transcript. Collected per session, they become one keypress.
- Commits made by an agent and the session that made them are linked both ways: from a commit to the exact tool
  call, and from a session to its commits.

## Today (current code, with path:line refs)
- No git awareness: `s.branch` is the only VCS field. It is set only for Claude (`gitBranch`,
  `src/harness/claude.ts:46`) and Codex (`git.branch`, `src/harness/codex.ts:55`). Nothing reads `.git`, and no code
  spawns `git`.
- The usage ledger reads every transcript line once, incrementally, and persists the state
  (`src/features/usage/ledger.ts:27-55`, `cache.ts:15`). Each raw line goes to the adapter's `usage(a, line)`
  (`ledger.ts:33, 49`). The file source reads lines in order; the record source (OpenCode rows) reads whole records
  (`ledger.ts:29-35`).
- Calls waiting for their result sit in `Acc.pend` by call id. Each holds the command summary `arg` (≤ 120 chars,
  `calls.ts:12, 166`; set in `record.ts:60-66`). The result line closes the call through `done()` (`calls.ts:54`).
  `Pend` does not keep the tool name.
- The transcript can jump to a call by id (`focusText`, used by Stats `jump()`, `src/features/usage/stats.ts:359-365`).
- Process helper: `run(cmd, args)`, sync, 4 s timeout, stderr ignored (`src/util/fs.ts:35-37`).
- Redaction rewrites display text through `H.display` kinds (`src/hooks.ts:31`, `src/features/redact.ts:358`).
- repo-view (phase 5) adds `Ident {key, top, common, worktree, …}` per cwd. This spec adds `gitdir` (the per-worktree
  git dir) to it.

## Design

### 1. Sources, in order of trust
1. **Commit banners in tool output** (`observed`, ✓): `git commit`, `git merge`, `git cherry-pick` and `git revert`
   print `[<branch> <sha>] <subject>`, also `[<branch> (root-commit) <sha>]` and `[detached HEAD <sha>]`.
2. **The worktree's HEAD reflog** (`reflog`, ≈): `<gitdir>/logs/HEAD` is a plain file with one line per HEAD move:
   `<old> <new> <name> <<email>> <epoch> <tz>\t<message>`. Read it directly; no spawn. Lines whose message starts with
   `commit:`, `commit (initial):`, `commit (amend):`, `commit (merge):`, `merge `, `cherry-pick:` or `revert:` are new
   commits *made in this worktree*, with exact times. `checkout: moving from A to B` lines track the branch at each
   point. This gives, without `git log`, the commits made in the session's worktree while the session was active.
3. **PR/MR, issue and commit URLs in tool output** (`created` or `mentioned`), scraped (decision 3).
4. **`git log` for enrichment only** (decision 5): diff size and whether a sha still exists. Never used to decide
   attribution.

A plain "`git log` in the session's time window" is not the primary source. It cannot tell which worktree or clone
made a commit, and a rebase rewrites committer dates. The reflog can tell both.

### 2. Scraping in the ledger pass (`src/features/usage/vcs.ts`)
- `step()` calls `scrape(a, line)` before `ad.usage(a, line)` for both source kinds (`ledger.ts:33, 49`). It runs
  before `usage()` closes the call, so the result's call is still in `a.pend`.
- Cheap prefilter (`indexOf`, no regex unless one hits): `" changed, "` or `" changed\n"` (commit banners are always
  followed by the `N files changed` summary), `"/pull"`, `"merge_requests/"`, `"/issues/"`, `"/commit/"`,
  `"/commits/"`, `"pull-requests/"`. Most lines fail every check.
- Before matching, a hit region is JSON-unescaped (`\/` → `/`, `\n` → newline, `\"` → `"`).
- **Which command produced this output.** First look for a pending call whose id occurs in the line (`a.pend` is
  small). That gives its `arg` and, once `Pend` keeps it, its tool `name`. If none matches, look for a `"command"` or
  `"cmd"` field in the same line: OpenCode and Gemini put call and result in one record. If neither is found, the
  command is unknown.
- Banner rules:
  - Accept a banner only when the command is known and contains `git` plus one of `commit`, `merge`, `cherry-pick`,
    `revert`. This keeps `cat`, `git log` or `git show` output from counting.
  - The regex is anchored to a line start: `^\[(detached HEAD|[^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$`.
  - Store the sha as printed (short). Decision 5 expands it.
- URL rules (case-insensitive host, trailing punctuation and `)`/`]`/`>`/`.`/`,` stripped):

  | kind | patterns → canonical |
  |---|---|
  | pr | `https://<h>/<o>/<r>/pull/<n>` (not `/pull/new/…`), `…/pulls/<n>` (Gitea/Forgejo), `…/-/merge_requests/<n>` (GitLab, nested groups), `…/pull-requests/<n>` (Bitbucket) → `https://<h>/<path>/pull/<n>`-style canonical per forge, suffixes like `/files`, `/diffs`, `#…`, `?…` dropped |
  | issue | `…/issues/<n>`, `…/-/issues/<n>` |
  | commit | `…/commit/<sha>`, `…/-/commit/<sha>`, `…/commits/<sha>` (Bitbucket) |

  Every URL goes through parsing-fixes' `scrubRemote()`, and only its `url` is kept. On `null` the URL is dropped.
- **created vs mentioned**: a URL counts as `created` when the producing command matches `gh pr create`,
  `glab mr create`, `hub pull-request`, `tea pr(s) create`, `gh issue create`, `glab issue create`, or when the tool
  name matches `/create_(pull_request|merge_request|issue)/` (MCP forge servers). Anything else is `mentioned`. The
  `git push` hint `…/pull/new/<branch>` is not a PR.
- **Git command spans**: when the producing command is known and contains `git` plus `commit`, `merge`,
  `cherry-pick`, `revert`, `am` or `rebase`, the call is also recorded as `k:"gcall"` with its start and result
  times (`v` = `"<t0>-<t1>"`), banner or not. Decision 4 uses these to recognise the session's own quiet commits.
- **Record**: `Acc.vcs: VRef[]`, with `VRef { k:"commit"|"pr"|"issue"|"gcall", v, t, how:"observed"|"created"|"mentioned",
  br, subj, call, ts }`. `v` is the sha or the canonical URL; `subj` is ≤ 80 chars; `call`/`ts` locate the event.
  Refs are deduplicated by `(k, v)`: the first sighting wins, and `created` upgrades `mentioned`. At most 200 per
  session; when full, drop the oldest `mentioned` first.
- `Pend` gains `name` (in memory, not persisted).
- Persisted in the ledger as `v` (an array of tuples). Ledger `VERSION` bump: share the single phase-5 bump with
  repo-view (6 → 7), so there is one re-index.
- **Uncertain**: Kiro and fx result lines and whether they carry the call id. If not, their banners are found only
  through the same-line command, or not at all. Task 0 of the plan checks real files.

### 3. Reflog reader (`src/features/vcs/reflog.ts`, pure parse plus fs reads)
- Input: `Ident.gitdir` of the session's cwd (repo-view). Read `<gitdir>/logs/HEAD`: the whole file if ≤ 8 MB, else
  the last 8 MB, aligned to a line. Cache the parsed result per gitdir, keyed by (size, mtime).
- Output: `RefEv { at, old, new, op:"commit"|"amend"|"merge"|"cherry-pick"|"revert"|"checkout"|"rebase"|"reset"|"other", branch, subj }`.
  `branch` comes from replaying `checkout: moving from A to B`. Before the first checkout, the branch is the current
  `HEAD` symbolic ref (`<gitdir>/HEAD`, `ref: refs/heads/<b>`).
- `amend` replaces `old` → `new`: the old sha is marked `amended` and the commit counts once.
- `rebase (finish)`, `pull` and `reset` are not new work. They only change which shas still exist, which decision 5
  reports.
- No reflog (deleted, `core.logAllRefUpdates=false`, expired after `gc.reflogExpire`, default 90 days): use the
  **window `git log` fallback**. One spawn per session, cached like decision 5:
  `git -C <top> log <rev> --since=@<t0> --until=@<t1> --author=<email> --format=…`.
  - `<rev>` = `refs/heads/<s.branch>` if the session has a branch and it exists, else `--branches`.
  - `<email>` = `git -C <top> config user.email`: one spawn per repo, cached. If it is unset, there is no author
    filter.
  - Commits found this way are ≈. They are attributed only when the session is the only one of its *project* active
    at the commit time; the worktree is unknown here. The UI says "no reflog — matched by time".

### 4. Attribution
For each session with a git identity:
- **window** = `[first activity − 2 min, last activity + tail pad]`. The tail pad is config `git.tailPadMin`
  (`~/.agentglass/config.json`, integer minutes 0–120, default 10; invalid → 10 with one startup toast); it covers
  agents that commit after a long final test run. Activity comes from repo-view's `Day.act` intervals; a live
  session's window ends now.
- **observed** commits (✓, counted): the banner shas of this session, plus reflog commits in the same gitdir whose
  time falls inside one of this session's `gcall` spans (`[t0, t1 + 5 s]`) — a `git commit --quiet` the agent ran.
- **reflog** commits (≈): entries in the window, in the **same worktree** (same `gitdir`), not observed by any
  session. A commit the person makes in that worktree while an agent runs looks exactly like this, so ≈ commits are
  **listed but not counted**: they never enter commits produced, $/commit or per-branch totals. The help text says so.
- **shared**: a ≈ entry whose window is covered by more than one session sharing the gitdir (two agents, or two
  sessions and the person) is shown on each as `? shared` and is likewise not counted in any per-session total.
- A commit observed by session A in worktree X never appears as ≈ or `? shared` for session B.

### 5. Enrichment via `git` (lazy, budgeted)
- One spawn per session view, only when the git panel (decision 6) or `--json --git` needs it:
  `git -C <top> log --no-walk=unsorted --ignore-missing --format=%H%x1f%P%x1f%ct%x1f%s%x1e --shortstat <sha…>`
  (≤ 100 shas) → full sha, merge flag, `+add −del`, files changed. A sha that is not returned gets status
  `missing` (rewritten, squashed, or only in another clone).
- Cache: closed sessions (no pid, window ended > 10 min ago) are cached forever in `~/.agentglass/cache/vcs.json`,
  keyed by session path + sha list. Live sessions are refreshed at most every 60 s while visible.
- At most one git spawn per 500 ms tick. When git is missing or times out (`run()` → `""`), the panel shows "git
  unavailable" and the commits keep their short shas without stats.

### 6. Metrics and UI
- **Commits produced** = ✓ only (amended-away commits count once). ≈ and `? shared` commits are listed with their
  own counts but never added. Merge commits are listed but not counted unless the session created the merge (✓).
- **$/commit (session)** = session cost / commits produced. Shown only when ≥ 1 commit. Unpriced cost gives `?`.
- **Branch**: the commits' branch (banner or reflog). A session with commits on two branches splits its cost by
  commit count. $/branch = Σ attributed cost / Σ commits.
- **Project** (repo-view): `commits` column, plus "spend without commits" = Σ cost of the project's sessions that
  produced none in the period.
- Preview section (`H.previewSections`): `git      3 commits (✓3 · ≈1 · ?1 shared not counted) · PR #142 (created) · $0.84/commit`.
- Session git view (full-screen `H.views` entry `git`), opened with `V` in the Sessions tab and in the transcript:
  - commits: `✓` / `≈` / `? shared`, short sha, time, branch, `+a −d`, subject, status; ≈ and shared rows dim with
    "not counted";
  - PRs/MRs, issues, other commit links: `created` first, then `mentioned`;
  - `enter` on an entry with a `call` opens the transcript focused on that tool call (as `stats.ts:359-365`); `y`
    copies the sha or URL; `esc` goes back.
- Repos detail: the branches box gains `commits`, `$/commit`, and created PR links.

### 7. CLI
- `--json` adds `git: {commits:[{sha, branch, subject, at, how:"observed"|"reflog"|"shared", counted, status:"present"|"missing"|"amended"|"unknown", add, del}],
  prs:[{url, number, how}], issues:[{url, number, how}], links:[…], costPerCommit}`. Refs and reflog are always
  included because they need no spawn. `status`, `add` and `del` are filled only with `--git`, which allows the
  spawns of decision 5.
- `agentglass --json --repos` (repo-view) gains `commits`, `costPerCommit`, `spendWithoutCommits`.

### 8. Privacy
- Local only: transcript bytes, `.git` files, the local `git` binary. Never `fetch`, `ls-remote` or any forge API.
- URLs are scrubbed (decision 2). Committer names and emails from the reflog are parsed but never stored, shown or
  exported.
- Commit subjects and URLs are user content. Under `--redact` they go through `display()` kind `vcs`. Redact fakes
  subjects from its title pool and replaces `owner/repo` in URLs with the fake project name, keeping numbers and shas.
- `vcs.json` and the ledger hold subjects; they are as private as the transcripts they come from.

### 9. Edge cases
- `git commit --quiet` prints no banner → matched to the session's `gcall` span → ✓. Without a matching span
  (e.g. a git alias the command check does not recognise) → ≈, listed, not counted.
- Commits by sub-agents: their own session gets the banner. Parent totals include sub-agent commits, as cost does.
- Rebased or squashed later: ✓ commits get `missing`. They still count as produced (the work happened), flagged.
- Commits in a different repo than the session's cwd (`git -C ../other commit`): the banner is recorded. If its sha
  is not in the session's repo (decision 5), it is listed as `elsewhere` and not counted for this project.
- Non-git sessions: no git section.

## Interactions with other specs
- **parsing-fixes**: `scrubRemote()` (`src/util/giturl.ts`).
- **repo-view**: `Ident` (adds `gitdir`), `Day.act` windows, the shared ledger version bump, the project and branch
  boxes.
- **related-events**: banner and reflog commits are events on the related timeline.
- **otlp-export**: can stamp the session's branch and HEAD sha, and the scraped PR, issue and commit URLs, on tool
  spans as VCS attributes.
- **triage**: "sessions without commits" becomes a selectable set.

## Testing
- `vcs.check.ts`: the prefilter rejects ordinary lines. A banner after a known `git commit` call is accepted; the
  same text from `cat`/`git log` is rejected. Root-commit and detached forms. Same-line command (OpenCode-style).
  `pull/new` is ignored. GitLab nested groups. Bitbucket and Gitea forms. Scrub of `https://x-access-token:…@`.
  `created` vs `mentioned` by command and by MCP tool name. Dedup and upgrade. The 200-ref cap. Escaped `\/` in raw
  JSON.
- `reflog.check.ts`: fixture `logs/HEAD` with commits, amend, checkout branch tracking, rebase, the 8 MB tail
  alignment.
- Attribution: two sessions in one worktree (`? shared`, not counted in either), two worktrees (separate), observed
  beats reflog; a quiet commit inside a `gcall` span → ✓; a reflog commit outside any span → ≈, not counted;
  `git.tailPadMin` 0 and 30 change which reflog commits fall in the window.
- Enrichment: stub `run()` output with a missing sha; git absent.
- A fixture transcript per harness with one `git commit` call (real captures where they exist; Kiro and fx after
  Task 0).

## Out of scope
- Forge APIs: PR state, reviews, merge time, cycle time and review depth.
- Pushed/unpushed detection, which would need remote refs or the network.
- Attributing commits made outside any session's worktree.
- A `--watch` event for new commits (could follow later as `kind:"commit"`).

## Decisions (review 2026-10-02)
1. `shared` commits? Listed as `? shared`, not counted in per-session totals (4).
2. Commits the person makes while an agent runs? Listed ≈, counted only if observed — so ≈ is never counted, and
   observed includes the session's own quiet commits matched to its git calls (4, 6).
3. Tail pad? 10 min, configurable (`git.tailPadMin`) (4).
4. Quiet agent commits seen only in the reflog? Counted as observed when they fall inside the session's own `git commit/merge/…` call; other reflog-only commits listed ≈, not counted.

## Open questions (to verify during implementation)
1. Kiro and fx result-line shapes (decision 2, uncertain).
