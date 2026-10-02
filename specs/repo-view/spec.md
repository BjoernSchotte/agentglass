# Repos view (project identity) — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 5 (depends on filter-language).

## Goal
A **Repos** tab that groups all sessions of all harnesses by *project*, not by directory. Per project, for a chosen
period: sessions, live sessions, cost, active time, tool error rate, most-changed files, harness mix and branches. You
drill from a project to its sessions, and from a session to its transcript or call tree.

Project identity is computed once per working directory and cached. Linked worktrees and separate clones of the same
remote are one project. Directories that are not git repos are grouped by path. The identity is shared: filter-language
(`repo` attribute), git-linkage and related-events all use it.

## Why (user value)
- "What did project X cost this week, and which agent did the work?" Today you can answer this only one session at a
  time. The Stats tab groups by harness and tool, never by project.
- Worktree-heavy workflows (one worktree per agent) split one project into many cwds. Grouping by cwd basename shows
  `agentglass`, `agentglass-specs`, `agentglass-gemini` as three projects. They are one project.
- Error rate and most-changed files per project show where agents struggle, for example "Bash fails 30% in this repo".

## Today (current code, with path:line refs)
- A session knows its `cwd` and, for Claude and Codex, its `branch` (`src/model/types.ts:4-5`). Where the cwd comes from:
  - at discovery (`meta`): fx `session.json` (`src/harness/fx.ts:61`), pi header line (`src/harness/pi.ts:70-72`),
    Kiro sidecar (`src/harness/kiro.ts:22-25`), Gemini `.project_root` (`src/harness/gemini.ts:201`), OpenCode rows
    (`src/harness/opencode.ts:210`);
  - only after a log head read (`loadHead`, `src/model/sessions.ts:36`): Claude (`src/harness/claude.ts:46`) and Codex
    (`src/harness/codex.ts:55`). The session list loads at most 40 heads per frame (`src/ui/list.ts:53`).
- No code knows about git repos. No git CLI is called anywhere. The only process helper is `run()` (sync, 4 s
  timeout, `src/util/fs.ts:35-37`).
- Per-session, per-local-day usage lives in the ledger: `Day` = tools per name (`tt`, with `err`), shell programs,
  commands, **changed files** (`files`, key `"<tool>\t<path>"`, edits, +/− lines), hourly call counts, tokens, cost,
  unpriced tokens (`src/features/usage/record.ts:10`). The ledger is persisted with a format version
  (`src/features/usage/cache.ts:15`); a version bump re-indexes all logs.
- `Day.files` is a bounded top-k: over 600 entries it keeps the 300 most used (`src/features/usage/calls.ts:41-51`).
- The Stats tab aggregates ledger days by harness (`agg()`, `src/features/usage/stats.ts:49-77`). It counts top-level
  sessions only (`:73`) and switches between today and 7 days (`:79-80`). Its drill-down jumps into a transcript at
  an event (`jump()`, `:359-365`).
- No "active time" exists in the ledger. The call tree computes active time per session as the union of span
  intervals (`src/features/callgraph/model.ts:211-217`), but only for the session it is showing.
- Under `--redact`, `s.cwd` is replaced by a fake path in an `H.meta` hook. The real path is kept privately in
  `Rec.real` (`src/features/redact.ts:226, 251`).
- filter-language (phase 2) defines the `repo` attribute through `projectOf(cwd)`: the nearest `.git` walking up,
  where a worktree resolves to its main repo, else `basename(cwd)`. It invites repo-view to refine the identity
  behind that function. It also adds per-call ledger rows (`Acc.calls`) and bumps the ledger `VERSION`.
- parsing-fixes (phase 1) adds `scrubRemote(raw) → Remote {url, host, path, owner, name} | null`
  (`src/util/giturl.ts`) and a scrubbed `Sess.remote` for Codex (from `session_meta.git.repository_url`).
- Tabs are registered through `H.tabs` (`src/hooks.ts:8, 26, 39`). The global `tab` key and the number keys switch tabs
  before the tab sees the key (`src/input.ts:134-140`).

## Design

### 1. Project identity (`src/model/project.ts`, pure apart from fs reads)
Input: the **real** cwd of a session. Under `--redact`, redact.ts exports `realCwd(s)`, which returns `Rec.real`;
otherwise it returns `s.cwd`. Output: `Ident { key, label, kind, top, common, worktree, remote }`.

Resolution uses the filesystem only. The default path spawns no git process:
1. `cwd` is empty → `kind:"none"`, key `none`, label `(no project)`.
2. Walk up from `cwd`, at most 40 levels, and stat `<d>/.git` at each level:
   - a directory → `gitdir = <d>/.git`, `top = <d>`;
   - a file → read `gitdir: <p>` (≤ 1 KB; `<p>` is relative to `<d>`) → `gitdir`, `top = <d>`;
   - nothing found up to `/` → non-git (step 6).
3. `common` = `<gitdir>/commondir` resolved against `gitdir` if that file exists (linked worktree), else `gitdir`.
   Submodules (`gitdir` under `<super>/.git/modules/<name>`, no `commondir`) are their own repo, which is correct.
4. Remote: parse `<common>/config` (≤ 256 KB) with a minimal INI reader: `[remote "<name>"]` sections, key `url`.
   Pick `origin`; else `upstream`; else the first remote in file order (a single remote is the first). Mark the
   choice so the UI can show "(remote: upstream)".
5. Normalize the remote URL. `scrubRemote()` (decision 3) already parses the forms and drops userinfo, query,
   fragment and `.git`, so normalization works on its `host` and `path`:
   - `scheme://[user[:pw]@]host[:port]/path`, `ssh://git@host:22/path` and scp form `git@host:path` all become
     `host/path`;
   - lowercase the host, drop a default port (22, 443, 80) and keep any other port as `host:port`, strip a trailing
     `/` and `.git`, collapse `//`;
   - comparison key `git:<host>/<path>`; the path is lowercased **only** for the known case-insensitive hosts
     `github.com`, `gitlab.com`, `bitbucket.org` (exact host match after lowercasing, no subdomains); every other
     host — self-hosted GitLab, Gitea, plain ssh servers — keeps the path's case. The label keeps the original case;
   - local paths as remotes (`/srv/git/x.git`, `file://…`) → `git:file/<realpath>`;
   - a URL with no recognizable host (for example an `insteadOf` alias like `gh:owner/repo`, or the file has `[include]` /
     `[includeIf]`) → **one** fallback `git -C <top> remote get-url <name>` through `run()`. Its result is cached
     like everything else. This is the only git spawn, and it runs at most once per (common dir, config mtime).
   - no remote at all → key `gitdir:<realpath(common)>`. Worktrees of one local repo still merge; clones without a
     remote do not.
6. Non-git → key `path:<realpath(cwd)>`, label `~/…` (shortened). A cwd that no longer exists keeps its cached
   identity (decision 2). If it was never resolved, the key is `path:<cwd>` and the label gets a `(gone)` suffix.
7. `worktree` = `basename(top)` when `top` is not the main worktree (main = `dirname(common)` when `common` ends in
   `/.git`), else `""`.

Labels: a remote gives `owner/repo` (the last two path segments). If two different keys would show the same label
(`github.com/a/x` and `gitlab.com/a/x`), both get the host prefix. A local-only repo gives `basename(main top)`.

A subdirectory cwd belongs to its repo. The session row shows the repo-relative directory as `repo:sub/dir` when it
is not the top.

### 2. Cost and caching
- In memory: `Map<cwd, Ident>`. The disk cache is `~/.agentglass/cache/projects.json`:
  `{v:1, cwds:{<cwd>:{key,label,kind,top,common,worktree,remote,cfgMtime,checked}}, sess:{<session path>:<cwd>}}`,
  written atomically like the ledger (`cache.ts:83-96`), every 30 s when dirty and on quit.
- `sess` keeps the cwd of each session. After a restart, Claude and Codex sessions get their project without
  re-reading log heads. Entries for sessions that no longer exist are dropped on save.
- Revalidation: when an entry was checked more than 10 min ago and the cwd still exists, stat `<common>/config`. If
  its mtime changed, parse it again. A cwd that no longer exists is never re-resolved.
- Budget per tick: resolve new cwds for at most 20 ms or 25 cwds, whichever comes first. A resolve is about 2–15
  `stat`s plus two small reads. There are normally a few dozen to a few hundred distinct cwds, so a cold start takes
  a handful of ticks. Sessions that still lack a cwd (Claude or Codex head not read yet) get head loads in the
  Repos tab, at most 40 per frame like `list.ts:53`. The tab shows `resolving N sessions…` until this is done.
- `realpathSync` resolves symlinks, so `~/code/x` and `/mnt/data/code/x` merge. **Uncertain:** scriptc 0.1.7 support
  for `realpathSync`. Fallback: `readlink` per path segment, or no symlink resolution (a documented limitation).

### 3. Credential scrub
Every remote URL, from `<common>/config`, the `git remote get-url` fallback or `Sess.remote`, goes through
parsing-fixes' `scrubRemote()` before anything else uses it. If it returns `null` (the URL still looks like a
credential), the identity falls back to `gitdir:` (step 5) and the label to the repo's basename. `projects.json`
stores only `Remote.url`. If a session's cwd no longer exists but Codex recorded `Sess.remote`, that remote gives the
key.

### 4. Active time (ledger addition)
- `Day` gains `act: number[]`: flat, sorted, merged minute-of-day intervals `[s0,e0,s1,e1,…]` (local minutes, `e`
  exclusive), persisted as key `k`.
- Recording: `bucket()` (`record.ts:41`) knows each line's timestamp. It extends the session's open interval when the
  new minute is no more than the idle gap after the interval's end, and starts a new interval otherwise. The gap is
  config `repo.idleGapMin` (`~/.agentglass/config.json`, integer minutes 1–60, default 5; invalid → 5 with one
  startup toast). Intervals are built at index time, so a changed gap applies to newly indexed lines only; the help
  text says so (a full re-index happens with the next `VERSION` bump).
  `done()` (`calls.ts:54`) also covers `[call t, call t + ms]`, so a 20-minute test run counts as active even if no
  line was written during it.
- At most 200 intervals per day. When over, merge the pair with the smallest gap. Intervals are split at midnight,
  and each part goes into its own day's bucket.
- Repo active time = **union** of the intervals of all its sessions (sort and merge). Two agents working in parallel
  for an hour count as one hour, not two. The repo detail also shows "agent-hours" (the sum).
- This differs from the call tree's "active" (span union, `callgraph/model.ts:211`) on purpose: the ledger does not
  keep spans. The help text says so.
- Ledger format `VERSION` bumps once to the next free number at implementation time (`cache.ts:15`). This means one full re-index. git-linkage
  shares the same bump, so ship both phase-5 specs in one release.

### 5. Aggregation (`src/features/repos/agg.ts`)
For a period (a list of day keys, like `stats.ts:80`) and an optional filter (decision 8):
- `RepoAgg { key, label, kind, worktrees:Set, sessions, live, last, cost, unk, inTok, outTok, tools, err,
  act:number[], agentMin, files:Map<relpath, Cnt & {by:Set<harness>}>, tools:Map<name, Cnt>,
  byHarness:Map<h, {sess, cost, unk}>, branches:Map<branch, {sess, cost}> }`.
- Walk sessions and their ledger days, as `agg()` does. Each session's project comes from its own cwd. A subagent
  without a cwd uses its parent's. A subagent's cost goes to the project of its own cwd: Claude worktree-isolated
  subagents can work in another worktree. `sessions` counts top-level sessions only, as `stats.ts:73` does.
- Files: an absolute path under the session's `top` becomes repo-relative. A relative path is joined to the session
  cwd first. Because the path is relative to *each worktree's own* `top`, `src/a.ts` edited in two worktrees merges
  into one row. Paths outside the repo go into one "outside the repo" group, shown last. `Day.files` is top-k pruned
  per day (`calls.ts:41`), so file counts are approximate for very busy days. The help text notes this.
- Error rate = Σ`err` / Σ`n` over every tool. The value is shown only when n ≥ 10; below that it shows `·`.
- Cached per (period, filter, ledger version `L.ver`, identity-map version) for 5 s, like `agg()` (`stats.ts:51`).

### 6. UI: Repos tab (`src/features/repos/tab.ts`, registered after Stats)
List (one row per project, sorted by cost by default):
```
 repo                 sess live   cost   active  err%  harness mix   files  last
 bjoern/agentglass      41   2  $38.20   9h12m   4.1%  ██████▅▂ ✳◎π    214  2m
 acme/shop-api           6   0   $4.80   1h05m  12.0%  ████████ ◎       31  3d
 ~/tmp/scratch           3   0   $0.40     12m     ·   ████     ✳        2  5d
```
- The harness mix is an 8-cell bar in harness colors, proportional to cost (to sessions when cost is unknown),
  followed by the harness marks (`stats.ts:258`). Cost uses `money()` and keeps the `?` marker for unpriced tokens
  (`stats.ts:30, 84`).
- A worktree count shows as a dim `⑂3` after the label when there is more than one.
- Keys: `↑↓ jk`, `g/G`, `pgup/pgdn`; `d` today, `w` 7 days, `m` 30 days, `a` all time; `s` cycles the sort (cost,
  active, sessions, err%, last); `/` filter (decision 8); `enter` or click opens the project detail.

Project detail (in the same tab; `esc`/`backspace` goes back):
- Header: label, scrubbed remote, kind, worktrees (name and top), period totals (cost, tokens, active time and
  agent-hours, tools, err%).
- Box **sessions** (left, focused by default): every top-level session of the project in the period, newest first:
  harness badge, title, worktree/subdir, branch, cost, active time, err%. `enter` opens the transcript (as
  `stats.ts:359`). `c` opens the call tree: callgraph exports its `open(s)`, which the `c` handler uses today
  (`callgraph/view.ts:350-353`). `esc` from either comes back here.
- Box **files**: top 20 repo-relative paths: edits, `+add −del`, which harnesses edited them. `enter` on a file
  narrows the sessions box to the sessions that edited it (from their `Day.files`) and shows a chip `file:<path>`.
  `esc` clears the chip.
- Box **tools**: the top 8 tools by errors, with err% and the shell programs that fail most (from `Day.prog`).
- Box **branches** (if any session has a branch): branch, sessions, cost. git-linkage adds commits and $/commit.
- `←/→` moves focus between boxes (`tab` is taken by the global tab switch, `input.ts:135`).
- From the Sessions tab, `@` opens the Repos tab with the selected session's project detail.

### 7. CLI
- `--json` session objects gain `repo: {key, label, kind, worktree, top, remote}`. `remote` is scrubbed. `top` is
  the real path. Under `--redact` both are faked through `display()`.
- `agentglass --json --repos [--days N] [--filter '…']` prints one object per project: the `RepoAgg` fields (files:
  top 50; intervals reduced to `activeMin`, `agentMin`). `--days` defaults to 7, and `0` means all history.
  filter-language's `day` clauses narrow the period further.

### 8. Filters (filter-language)
- This spec replaces the implementation behind filter-language's `projectOf(cwd)`. The attribute keeps its key, and
  clauses that already match keep matching wherever label = basename. This spec supplies the value of the `repo`
  attribute: `repo is acme/shop-api` matches the label, and
  `repo ~ shop` matches a substring of the label or the key. New attributes: `worktree`, `project.kind`
  (`git|gitdir|path|none`).
- In the Repos tab, the active and pinned filters apply to the **sessions** before grouping. `harness is codex`
  therefore shows each project's Codex share only.

### 9. Failure modes
- `.git` unreadable (permissions) → path identity with a dim `?`. A `.git` file pointing to a missing gitdir (the
  main repo was deleted) → cached identity if there is one, else path identity.
- `config` larger than 256 KB or unparsable → no remote → `gitdir:` key.
- Slow network filesystems: the per-tick time budget caps the stall. The identity of a slow cwd resolves over
  several ticks.
- Two clones of different forks (`me/x`, `upstream/x`) are different projects (different `origin`). This is
  documented, not merged.

### 10. Privacy
Everything is local. No network: the fallback `git remote get-url` reads config only. Remotes are scrubbed
(decision 3). Under `--redact`, labels, remotes and paths go through `display()` kinds `repo`/`cwd`/`file`, which
redact.ts fakes consistently with its fake project names (`redact.ts:106, 358`).

## Interactions with other specs
- **filter-language**: provides the grammar, pinning, `--filter` and `projectOf()`. This spec defines the `repo`, `worktree` and
  `project.kind` values.
- **parsing-fixes**: `scrubRemote()` and `Sess.remote` (decision 3).
- **git-linkage**: uses `Ident.top`/`common` for `git log`, and adds commits and $/commit to the branches box and a
  `commits` column.
- **related-events**: uses `Ident.key` to pick sessions of the same project, and `top` to tell "same file" from "same
  path in another worktree".
- **triage / session-compare**: `repo` becomes a triage dimension with real identity instead of cwd basenames.
- **otlp-export**: may export `Ident.label` and the scrubbed remote as repository attributes.

## Testing
- `src/model/project.check.ts` with temp directories: plain repo; subdirectory cwd; linked worktree (`.git` file +
  `commondir`); submodule; two clones with https / ssh / scp remotes of the same repo → same key; `.git` suffix,
  trailing slash, default and custom port; userinfo token scrubbed; no remote → `gitdir:`; worktrees of a remote-less
  repo merge; multiple remotes without `origin` (`upstream` wins, else first in file order); `GitHub.com/Me/X` and
  `github.com/me/x` → same key, `git.example.com/Me/X` and `…/me/x` → different keys; non-git dir; deleted cwd keeps its cached identity; alias remote
  calls the fallback (stub `run`) exactly once; label collision gets the host prefix.
- A normalization table test (input URL → key, label).
- `record.check.ts`: active intervals: gap ≤ 5 min joins, > 5 min splits, `repo.idleGapMin` = 15 changes both,
  invalid value → 5, tool duration fills, midnight split, the 200-interval cap, persistence round trip.
- `repos/agg.check.ts`: synthetic ledgers: subagent attribution, top-level session count, union vs agent-minutes,
  repo-relative file merge across worktrees, outside-repo group, err% hidden under 10 calls, filter applied before
  grouping.
- Manual: a real worktree setup (main repo + 3 worktrees + one subagent worktree) → one row with `⑂4`.

## Out of scope
- Team or user analytics, and any per-person breakdown.
- Remote APIs (GitHub, GitLab) to resolve forks or canonical names.
- Merging forks or renamed remotes into one project.
- A Sankey or other chart beyond the mix bar.

## Decisions (review 2026-10-02)
1. Remote choice? `origin`, then `upstream`, then the first in file order (1.4).
2. Lowercased path keys? Only for the known hosts github.com, gitlab.com, bitbucket.org (1.5).
3. Idle gap configurable? Yes, `repo.idleGapMin`, default 5 (4).

## Open questions (to verify during implementation)
1. scriptc `realpathSync` support (decision 2).
