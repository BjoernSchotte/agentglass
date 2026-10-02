# Related events (cross-agent timeline around an event) — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 7 (depends on repo-view: project
identity; uses git-linkage and rules-config when present).

## Goal
From any event (tool call, result, prompt), one key opens a **related timeline**: everything that happened within ±N
minutes in the **same project**, across all sessions and all harnesses, interleaved by time. It includes:
- other agents' edits, especially to the same files;
- shell commands;
- prompts;
- approval waits and other alerts;
- commits.

When two agents write the same file close together, the rows are highlighted as a **conflict**.

## Why (user value)
- "Why did my test suddenly fail?" Often another agent edited the file a minute earlier. One agent's transcript
  cannot show that. Only a tool that reads every harness's logs locally can.
- Parallel agents (several worktrees, or several sessions in one checkout) step on each other: same file, `git
  stash`, `git checkout .`. Seeing it around the failing event saves a debugging round.
- It is cheap to answer, because everything is on disk and already parsed by agentglass.

## Today (current code, with path:line refs)
- Event drill-down is the detail layer: `S.dv` for one event of the open transcript `S.tv` (`src/state.ts:7-14`,
  `src/ui/detail.ts:242-302`). Keys are in `src/input.ts:108-130`; `r` is unused there. The transcript keeps a
  cursor event (`tv.cur`, `src/state.ts:9`; keys `src/input.ts:86-105`).
- Events: `Ev {kind, text, ts, id, full}` (`src/model/types.ts:3`). Tool calls are `kind:"tool"`, with
  `text = name + "\u0000" + arg`. `id` pairs a call with its result. `ts` is ISO and can be empty for some lines.
- Files of an event: `filesOf()` reads `file_path`/`path`/`notebook_path` fields and `*** Update File:` patch headers
  (`src/ui/detail.ts:228-240`; not exported). Patch per-file counts: `patchFiles()` (`src/features/usage/calls.ts:146`).
  Tool category (shell/edit/read/web/agent/mcp): `catOf()` (`src/features/callgraph/model.ts:6, 20`).
- Reading another session: `SessionSource.lines(s, from, to)` + `align()` over a byte cursor (files) or a record
  cursor (OpenCode) (`src/harness/types.ts:15-21`, `src/harness/source.ts`). Events come from `parseEvents()`, which
  also runs `H.events` hooks such as redaction (`src/hooks.ts:30`). The open transcript reads only the last 6 MB
  (`src/ui/transcript.ts:106-112`). Nothing seeks by time.
- Jumping into a transcript at a given event: `openTranscript()` plus `focusKind`/`focusTs`/`focusText`
  (`src/ui/transcript.ts:100`, `src/features/usage/stats.ts:359-365`).
- Per-session activity by day is in the ledger. repo-view adds `Day.act` minute intervals and the project identity
  `Ident` per cwd; this spec reads its `key`, `top`, `gitdir` and `worktree` fields.
- Full-screen feature views: `H.views` + `S.mode = "view"` (`src/hooks.ts:10, 28, 40`). The call graph is one example; it
  handles `esc` back to where it came from (`src/features/callgraph/view.ts:344-357`).

## Design

### 1. Entry points and keys
- `r` in **detail** (anchor = the shown event), in the **transcript** (anchor = the cursor event `tv.cur`, else the
  last event), and in the **call graph** (anchor = the selected span's event). `esc`/`q`/`backspace` returns to the
  mode it came from.
- The anchor time is the event's `ts`. If that is empty, use the nearest earlier event's `ts`, then the next one's.
  With no timestamp at all: toast "this event has no time", and the view does not open.

### 2. Scope
- **Project**: the anchor session's `Ident.key` (repo-view): every session of the same project, whatever harness,
  worktree or clone. For `kind:"none"` (no cwd), fall back to sessions with the same cwd, and say so in the header.
- **Window**: `[t − N, t + N]`. N defaults to 10 min, configurable (`config.json` `{"related":{"minutes":10}}`,
  integer 1–240; invalid → 10 with one toast). It cycles with `+`/`-` through 2, 5, 10, 30, 60 (the configured value
  is added to the cycle when it is not one of them).
- **Candidate sessions**: same project, whose activity intersects the window. Check it in memory: ledger day keys of
  the window, then `Day.act` intervals. Sessions not indexed yet: `mtime ≥ t − N` and a head timestamp ≤ `t + N`.
  Subagents are their own sessions.
- Cap: the 40 candidates with the most active minutes in the window. The header says `+K more sessions not shown`.

### 3. Reading by time (`seekTime` in `src/harness/source.ts`, generic over `SessionSource`)
- Bisect the cursor range `[0, size)`:
  1. take the midpoint and `align()` it;
  2. read one window (64 KB, or `window(src, 65536)` records);
  3. parse lines until one gives an event with a `ts`;
  4. go left if that `ts` ≥ the window start, else right.
- Stop at 64 KB granularity. Step back one extra window as margin, then read forward with `parseEvents` until an
  event's `ts` > the window end.
- About log2(size / 64 KB) small reads: ~10 for a 64 MB log.
- Logs are not strictly time-ordered: Gemini re-appends upserted messages and checkpoints, and Claude writes
  compaction replays. So events are deduplicated per session by `(id, kind)`, or by `(ts, text)` when there is no
  id, and any event outside the window is dropped. A session whose bisect cannot find any timestamp is read from its
  tail (≤ 6 MB, like the transcript) and filtered.
- The anchor session is read the same way. If the open transcript already holds the window, its `evs` are reused.
- Budget: ≤ 16 MB read per build. Building runs incrementally across ticks (≤ 50 ms per tick), shows
  `loading 3/12 sessions`, and renders what it has so far.

### 4. Related event model (`src/features/related/model.ts`, pure)
`RelEv { t, sess, h, kind, cat, tool, text, files: FileRef[], err, self, mark }`
- `kind`:
  - `prompt` — user events;
  - `write` — tool category `edit`;
  - `shell` — category `shell`;
  - `read`;
  - `agent` — a spawned subagent;
  - `web` / `mcp`;
  - `alert` — from the rules-config alert log: approval waits, waiting, stuck; this agentglass run only;
  - `commit` — from git-linkage: banners in any candidate session, plus reflog commits of the project's worktrees in
    the window that no session observed, shown as `commit (no session)`. These are usually the person's own commits.
- `err`: the paired result failed (`isErr`, `src/features/callgraph/model.ts`). The result folds into its call's
  row; a result is never its own row.
- `files`: `filesOf()` (exported from detail.ts) plus `patchFiles()`, each normalized to
  `FileRef {top, rel}` with the event session's `Ident.top`. Paths outside the repo keep their absolute path, with
  `top = ""`.
- **Approvals.** Harness-recorded approval decisions vary. Claude writes a denial as an error result ("The user
  doesn't want to proceed…"); it becomes `alert` text `denied`. Codex and the others: **uncertain**, and Task 0
  checks the real logs. The alert log always covers agentglass's own `approval?` detection.
- Default kind set: `prompt`, `write`, `shell`, `agent`, `alert`, `commit`. `k` cycles: default → + `read`/`web`/`mcp`
  (all) → writes only.

### 5. Conflicts
For each file `(top, rel)`, take the `write` events in the whole loaded range, by session:
- **conflict** (red `‼`): writes to the **same physical file** (same `top` and `rel`) by two different sessions
  within `C` minutes of each other (default 10, configurable `related.conflictMinutes`, integer 1–240; invalid → 10).
  A parent session and its own subagent are exempt (delegation, not a race) — **unless** the parent's write falls
  inside the subagent's active interval: then both edit at the same time, a true race, flagged `‼` with the note
  `parent wrote while its subagent ran`. The active interval is the spawning call's start → its result (`id` pair);
  without a paired result, the subagent session's first → last event. Sibling subagents are never exempt.
- **overlap** (yellow `≈`): the same `rel` in **different** worktrees or clones of the project, within `C`. There is
  no clash on disk, but it is a likely merge conflict.
- **clobber** (red `‼`): a `shell` event in one session runs a workspace-wide git command that can discard others'
  work:
  - `git stash` (without `list`/`show`);
  - `git checkout -- .` or `git checkout .`;
  - `git restore .`, `git reset --hard`, `git clean -f…`;
  - `git switch`/`git checkout <branch>` with uncommitted writes by another session.

  It counts when another session has `write` events in the same `top` within `C` before it.
- Every flagged row says with whom: `also edited by ✳ fix-auth 1m10s earlier`. The header counts conflicts. `n`/`N`
  jump between flagged rows.
- Writes made through shell commands (`sed -i`, redirects, formatters) are not detected as writes. This is a
  documented limit.

### 6. UI (full-screen view `related`)
```
 related · bjoern/agentglass · ±10m around 14:06:43 · 5 sessions · 63 events · ‼ 2
   -04:12 14:02:31 ✳ fix-auth-flow   ✎ Edit   src/auth/login.ts                 +12 −3
   -00:40 14:06:03 ◎ add-tests  wt2  $ Bash   npm test -- login                 ✗
 ▶  00:00 14:06:43 ✳ fix-auth-flow   ✎ Edit   src/auth/login.ts                 +4 −1
 ‼ +01:10 14:07:53 π refactor-api    ✎ write  src/auth/login.ts                 also edited by ✳ fix-auth-flow 1m10s earlier
   +02:05 14:08:48 ✳ fix-auth-flow   ◆ alert  approval? Bash pending 25s
   +03:30 14:10:13 ✳ fix-auth-flow   ● commit 3f2a91c fix login redirect
```
- Columns:
  - marker (`▶` anchor, `‼`, `≈`);
  - offset from the anchor and the local clock;
  - harness glyph + session title (≤ 16 cells);
  - the worktree tag when it differs from the anchor's;
  - kind glyph + tool;
  - text (file, command, prompt line);
  - status (`✗`, `+a −d`, conflict note).
- The anchor session's rows are in normal colour, other sessions' rows are tinted in their harness colour, and
  self rows can be hidden with `o`.
- Keys:
  - `↑↓ jk`, `g/G`, `pgup/pgdn`;
  - `enter` opens that session's transcript focused on the event (`focusKind`/`focusTs`/`focusText` as
    `stats.ts:359-365`); from there, `esc` returns to the related view;
  - `+`/`-` window; `f` only events whose files intersect the anchor's files; `o` own session on/off; `k` kind set;
  - `n`/`N` next/previous flagged row; `/` filter (filter-language expression: call attributes `tool`, `server`,
    `program`, `command`, `file`, `ext` match tool rows, session attributes such as `harness` or `title` match a
    row's session; non-tool rows pass call clauses only when no call clause is given); `esc` back.
- Live: when the window reaches into the future and a candidate session is live, re-poll every 2 s, appending from
  each session's last cursor.

### 7. CLI
`agentglass --json --related <session-id-prefix> [--event <event id> | --at <iso>] [--minutes N]` prints:
`{anchor:{session, harness, t, kind, text}, project:{key, label}, from, to, sessions:[…], events:[{t, session, harness, title, kind, tool, text, files:[rel], err, self, conflict:{kind:"conflict"|"overlap"|"clobber", with:[session]}|null}]}`.
An ambiguous or unknown prefix exits 2 with the candidates.

### 8. Privacy
Everything is local. Events go through `parseEvents()`, so `--redact` rewrites content through the existing
`H.events` hook. Titles, paths and project labels go through `display()`. Nothing new is persisted: the view is
rebuilt on demand.

## Interactions with other specs
- **repo-view**: `Ident` (`key`, `top`, `gitdir`, `worktree`), `identOfCwd`, `realCwd`, `Day.act` for picking candidates.
- **git-linkage**: commit events (banner and reflog), including commits by the person.
- **rules-config**: the alert log ring (approval waits, waiting, stuck) as `alert` rows. A future rule metric
  `file_conflicts` could reuse section 5 to alarm live. Not part of this spec.
- **filter-language**: `/` filter over event attributes.
- **command-palette**: may offer "related events" for the selected event, and a deep link
  `agentglass open <session>#<event>` can land on the anchor, then `r`.

## Testing
- `seekTime` over a synthetic 50 MB JSONL (monotonic, a tail out of order, lines without `ts`, a record source
  stub): finds the window with ≤ 15 reads; the margin catches out-of-order lines; dedup by id.
- `related/model.check.ts`:
  - kinds and folding of results into their calls;
  - `FileRef` normalization across two worktrees;
  - conflict vs overlap vs clobber; the parent/subagent exemption outside the subagent's active interval, and the
    race flag for a parent write inside it (with and without a paired spawn result); siblings flagged;
  - the C-minute boundary; `related.minutes`/`related.conflictMinutes` from config, invalid values → 10;
  - `commit (no session)` from a reflog fixture.
- Fixture project: three harness transcripts (Claude, Codex, pi) in two worktrees of one remote, editing
  `src/a.ts`. The view lists them interleaved, with the right markers.
- CLI JSON shape, and the exit code for an ambiguous prefix.

## Out of scope
- Detecting writes made through shell commands, or watching the filesystem (inotify/FSEvents).
- Live conflict alarms in the session list (a later rules-config metric).
- Events from outside agent transcripts (editor saves, CI).
- Cross-project correlation.

## Decisions (review 2026-10-02)
1. Parent/subagent exemption? Exempt unless the parent writes during the subagent's active interval; that true race
   is flagged (5).
2. N and C? Both 10 min, both configurable (`related.minutes`, `related.conflictMinutes`) (2, 5).
3. Project identity fields? Exactly repo-view's `Ident` names: `key`, `top`, `gitdir` (provided by repo-view), `worktree`;
   section references instead of decision numbers where sections are meant (Today, Interactions).

## Open questions (to verify during implementation)
1. Codex, OpenCode, Gemini, Kiro and fx approval records in the logs (section 4, uncertain).
