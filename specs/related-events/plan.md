# Related Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One key (`r`) from any event in detail, transcript or call graph opens a full-screen timeline of everything that happened within ±N minutes in the same project, across all sessions and harnesses, with same-file conflicts, cross-worktree overlaps and workspace clobbers flagged; `agentglass --json --related` prints the same data.

**Architecture:** A generic time seek (`seekTime`) on the `SessionSource` port reads only the window of each candidate session. A pure model (`src/features/related/model.ts`) turns parsed events into `RelEv` rows, folds results into calls, normalizes files to `FileRef {top, rel}` and marks conflicts. A builder (`build.ts`) picks candidate sessions from repo-view's project identity and `Day.act` intervals, then reads them incrementally across ticks under a byte and time budget. A full-screen view (`view.ts`) renders it; `src/features/cli.ts` exposes the CLI form. Nothing new is persisted.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — binding; this plan argues from it, including "Decisions (review 2026-10-02)".

**Phase:** 7. Starts when phases 1–6 are merged; it needs repo-view (`Ident`, `identOfCwd`, `realCwd`, `Day.act`), git-linkage (`Acc.vcs` commits, `readReflog`), repo-view's `Ident.gitdir`, rules-config (`LOG` alert ring) and filter-language (`parse`, `compile`, `sessMatches`, the `Compiled.event` predicates). Within phase 7 it is independent; recommended merge order to keep rebases small: cli-agent-mode → related-events → command-palette → adaptive-refresh (all three touch `src/features/cli.ts`; command-palette adds the start-cursor transcript open that this view's `enter` then uses).

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields, not foreign interfaces); call optional function members via a local; out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log` (the bisect uses integer halving, no logarithms).
- Read-only: never write into agent data dirs; no network; nothing new on disk (no cache file, no ledger change → **no `cache.ts` `VERSION` bump**). The view is rebuilt on demand.
- Identity and files use the **real** cwd (`realCwd(s)` from repo-view) — under `--redact` `s.cwd` is fake. Everything shown goes through `parseEvents()` (redaction hook), `titleOf()`, `display()` and the screen filter.
- Read budget per build: ≤ 16 MB (`16777216` bytes, counted as cursor span × `src.unit`); ≤ 50 ms of work per tick; the UI never blocks.
- Keys live in mode-scoped handlers: `r` in `detail`, `transcript` and the `callgraph` view; the view's own keys only while `S.mode === "view" && S.fview === "related"`. No existing binding changes.
- Config keys `related.minutes` and `related.conflictMinutes`: integers 1–240, default 10; invalid → 10 with one startup toast each.
- Style: match the surrounding code — dense one-line helpers, short `//` why-comments, no new dependencies.
- Old behavior is a contract: `./agentglass --json --subagents --limit 400` identical before/after except volatile fields (`updated bytes activity live pid status attention stuck`).
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-related-events`, branch `feat/related-events`, PR to `main`, rebase-merge after green CI.

## Review Focus

1. **Seek misses events** — out-of-order tails (Claude compaction replays, Gemini re-appends) and lines without `ts` must not make the bisect skip the window start; the one-window margin must catch them, and reads stay ≤ 15 on 50 MB. Task 1 `source.check.ts` (synthetic 50 MB log + record stub).
2. **Duplicates** — a replayed or re-appended event appears once (`(id, kind)`, else `(ts, text)`); a result never becomes its own row. Task 2 `model.check.ts`.
3. **Parent/subagent exemption** — exempt outside the subagent's active interval, `‼` with `parent wrote while its subagent ran` inside it (paired spawn result and the no-result fallback), siblings never exempt. Task 3 `model.check.ts`.
4. **Same physical file vs. overlap** — `(top, rel)` equal → conflict; same `rel`, different `top` → overlap; paths outside the repo keep their absolute path with `top = ""`. Task 2 + Task 3 checks with two worktrees.
5. **Budget and incrementality** — a build over 40 candidates never reads more than 16 MB and never spends more than 50 ms per tick; partial results render with `loading k/n sessions`. Task 4 `build.check.ts` (read counter + fake clock).

---

### Task 0: Worktree, prerequisites, open question, fixtures

**Files:** none committed except `src/features/related/fixtures.ts` if real shapes are needed (hand-written lines in real shapes; no copies of real sessions).

- [ ] **Step 1: Worktree** `git worktree add -b feat/related-events ../agentglass-related-events main && cd ../agentglass-related-events && ./build.sh && sh scripts/check.sh` → Expected: build OK, all checks `ok`.
- [ ] **Step 2: Prerequisite names** (exact names from the producer plans):
  - `grep -rn "export function identOfCwd\|export interface Ident\|export function realCwd" src` → Expected: `identOfCwd(cwd: string): Ident | null` (repo-view, `src/model/project.ts`), `Ident` with `key`, `label`, `kind`, `top`, `common`, `worktree`, `gitdir` (the per-worktree git dir), `remote`, `via`, `gone`, `unread` (all repo-view), `realCwd(s: Sess): string` in `src/features/redact.ts`.
  - `grep -n "act" src/features/usage/record.ts src/features/usage/cache.ts` → Expected: `Day.act: number[]` (flat merged local-minute intervals).
  - `grep -rn "vcs\b\|VRef\|export function.*[Rr]eflog" src/features` → Expected: `Acc.vcs: VRef[]` with `k:"commit"`, and `readReflog(gitdir)` (`src/features/vcs/reflog.ts`) returning `RefEv {at, old, new, op, branch, subj}`.
  - `grep -rn "export const LOG\|interface Trans" src/features/rules` → Expected: `LOG: Trans[]`, the in-memory ring of 500 `{at, path, rule, from, to, state, v, thr}` (rules-config §4).
  - `grep -rn "export function parse\b\|export function compile\|export function sessMatches\|event:" src/features/query` → Expected: `parse(src): Parsed`, `compile(cs, ctx): { f: Compiled | null; err: QErr | null }`, `sessMatches(f, s)`, and `Compiled.event: ((s, kind, tool, args) => boolean)[]` — the predicates `--watch` evaluates per event (call clauses `tool server program command file ext` on `tool` events).
  - If any of these is missing on `main`, stop: the prerequisite plan is not merged.
- [ ] **Step 3: Open question 1 — approval records per harness** (read-only probes on the user's real data; record each result in the ledger):
  - Codex: `rg -o -m5 '"type":"[a-z_]*approval[a-z_]*"|"decision":"[a-z_]+"' ~/.codex/sessions | sort | uniq -c | head`
  - OpenCode: `sqlite3 -readonly ~/.local/share/opencode/opencode.db "select substr(data,1,300) from part where data like '%permission%' or data like '%rejected%' limit 5"`
  - Gemini: `rg -o -m5 '"status":"(cancelled|error)"[^}]{0,200}' ~/.gemini/tmp/*/chats/*.jsonl | head`
  - Kiro: `rg -o -m5 -i '.{0,80}(denied|rejected|approval).{0,80}' ~/.kiro/sessions/cli | head`
  - fx: `rg -o -m5 -i '.{0,80}(denied|rejected|approval).{0,80}' ~/.fx | head`
  - Expected evidence per harness: the exact line shape of a user denial, or "none found". For each harness with a shape, Task 2 adds a hand-written line in that shape to `model.check.ts` and maps it to an `alert` row `denied <tool>`. **Fallback (spec 4):** a harness without a recorded decision gets no `denied` rows; the alert log still covers agentglass's own `approval?` detection; README states the limit per harness.
- [ ] **Step 4: Real-shape fixture lines** for Task 7: one Claude `Edit` call + result, one Codex `apply_patch` call (`*** Update File:`), one pi `edit` call, each editing `src/a.ts`, plus one Claude `Bash` `git stash` call. Hand-write them in the shapes `src/harness/harness.check.ts` SAMPLES already use (no copies of real sessions).
- [ ] **Step 5: Commit** only if a fixture module was added: `test(related): real-shape fixture lines for related events`.

---

### Task 1: `seekTime` — bisect a session source by time

**Files:** Modify `src/harness/source.ts`; Test `src/harness/source.check.ts` (extend).

**Interfaces — Consumes:** `SessionSource` (`src/harness/types.ts:15-21`), `window(src, bytes)` (`src/harness/index.ts:37`).

**Interfaces — Produces:**
- `export interface Seek { at: number; reads: number; found: boolean }` — `at` = aligned cursor to start reading from (one window before the first chunk whose first timestamp ≥ `t0`), `reads` = `src.lines` calls made, `found = false` when no timestamp was found anywhere (caller then reads the tail ≤ 6 MB and filters).
- `export function seekTime(s: Sess, src: SessionSource, size: number, t0: number, win: number, tsOf: (line: string) => number): Seek` — `win` = `window(src, 65536)`; `tsOf` returns epoch ms of the first event with a timestamp in that raw line, `0` if none (callers pass a parser bound to the harness; the source stays harness-agnostic).

Algorithm (spec 3): `lo = 0, hi = size`; while `hi - lo > win`: `mid = src.align(s, lo + Math.floor((hi - lo) / 2))`; if `mid >= hi` break; read `src.lines(s, mid, Math.min(size, mid + win))`, take the first line with `tsOf > 0`; if none, extend by one more window (at most 4 windows); still none → `hi = mid` (go left: re-reading is safe, skipping is not); else `ts >= t0 ? hi = mid : lo = mid`. Result `at = src.align(s, Math.max(0, lo - win))`.

- [ ] **Step 1: Failing check** in `source.check.ts`:
  - write `/tmp/agentglass-seek-check/big.jsonl`: 50 MB of lines `{"ts":"<iso>","n":<i>}` one second apart starting `2026-01-01T00:00:00Z`, every 7th line without `ts`, and the last 2 MB holding 300 lines whose `ts` is 10 min *earlier* than their neighbours (out-of-order tail);
  - `tsOf = (l) => { const m = /"ts":"([^"]+)"/.exec(l); return m ? Date.parse(m[1] ?? "") : 0; }`;
  - `seekTime` for `t0` at 40 % of the file → `found === true`, `reads <= 15`, and reading forward from `at` reaches the first line with `ts >= t0` (scan to verify; no line with `ts >= t0` exists before `at` except inside the margin);
  - `t0` inside the out-of-order tail: the out-of-order lines whose ts ≥ `t0` lie at or after `at`;
  - a file of only `{"x":1}` lines → `found === false`;
  - record-source stub: `SessionSource` with `unit: 1`, cursor = record index over an in-memory array of 100,000 records, `align` identity → same assertions, `reads <= 20`.
  Run: `scriptc build src/harness/source.check.ts -o /tmp/sc && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/sc` → Expected: FAIL (`seekTime` undefined).
- [ ] **Step 2: Implement** `seekTime` in `source.ts` as above (integer halving only).
- [ ] **Step 3: Run** the check → Expected: PASS; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `feat(harness): seekTime — bisect a session source by timestamp`.

---

### Task 2: Related event model — kinds, folding, files, dedup

**Files:** Create `src/features/related/model.ts`, `src/features/related/model.check.ts`; Modify `src/ui/detail.ts` (export `filesOf`, `:228`).

**Interfaces — Consumes:** `Ev` (`src/model/types.ts:4`), `catOf`, `CATS`, `toolName`, `toolArg`, `isErr`, `ms` (`src/features/callgraph/model.ts:6-34`), `patchFiles` (`src/features/usage/calls.ts:146`), `filesOf(texts, cwd)` (detail.ts, now exported).

**Interfaces — Produces:**
- `export interface FileRef { top: string; rel: string }`
- `export interface RelEv { t: number; ts: string; sess: string; h: string; kind: string; cat: number; tool: string; text: string; files: FileRef[]; add: number; del: number; err: boolean; self: boolean; mark: string; withS: string[]; dt: number; race: boolean; evKind: string; evId: string; evText: string }` — `sess` = session path (`""` for `commit (no session)`); `kind` ∈ `prompt write shell read agent web mcp alert commit`; `mark` ∈ `"" anchor conflict overlap clobber`; `withS` = other session paths of a flag, `dt` = ms to the nearest of them; `evKind/evId/evText` locate the source event for `enter`.
- `export function fileRef(abs: string, top: string): FileRef` — inside `top` → `{top, rel}` (no leading `/`); else `{top: "", rel: abs}`.
- `export function toRel(evs: Ev[], sess: string, h: string, cwd: string, top: string, self: boolean, t0: number, t1: number, seen: Set<string>, out: RelEv[]): void` — per spec 4: `user` → `prompt`; `tool` → kind by `catOf` (edit → `write`, shell → `shell`, read, agent, web, mcp; `other` → `read`); its paired `result` (same `id`, later index) sets `err = isErr(result.text)`, and a Claude denial (`/^The user doesn't want to proceed/`) or a Task 0 shape adds a separate `alert` row `denied <tool>` at the result's time; results never become rows; `files` = `filesOf([text, full], cwd)` ∪ `patchFiles(full)` → `fileRef`; `add/del` from `patchFiles` sums; events outside `[t0, t1]` dropped; dedup key `sess + "\u0001" + (id ? id + "\u0001" + kind : ts + "\u0001" + text)` in `seen`.
- `export const KIND_SETS: string[][]` = `[["prompt","write","shell","agent","alert","commit"], ["prompt","write","shell","read","agent","web","mcp","alert","commit"], ["write"]]` (`k` cycles).

- [ ] **Step 1: Failing check** `model.check.ts`:
  - Claude `Edit` tool event with `full` `{"file_path":"/w/main/src/a.ts",…}` + result → one `write` row, `files[0] = {top:"/w/main", rel:"src/a.ts"}`, `err false`;
  - Codex `apply_patch` with `*** Update File: src/a.ts` + 2 `+` and 1 `-` lines, cwd `/w/wt2`, top `/w/wt2` → `files[0].rel === "src/a.ts"`, `add 2`, `del 1`;
  - `Bash` `npm test` + result `Exit code 1` → `shell` row `err true`; a `Read` → `read`; a `Task` → `agent`; `/etc/hosts` edit → `{top:"", rel:"/etc/hosts"}`;
  - Claude result `The user doesn't want to proceed with this tool use.` → `write` row plus `alert` row `denied Edit`; each Task 0 harness shape → its `denied` row;
  - the same events passed twice (compaction replay) → rows once; an event without id repeated with the same `(ts, text)` → once; an event at `t1 + 1` → dropped;
  Run: `scriptc build src/features/related/model.check.ts -o /tmp/rm && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/rm` → Expected: FAIL (module missing).
- [ ] **Step 2: Implement** `model.ts` and export `filesOf` from `detail.ts` (signature unchanged).
- [ ] **Step 3: Run** → Expected: PASS; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `feat(related): event model — kinds, folded results, file refs, dedup`.

---

### Task 3: Conflicts, overlaps, clobbers + config

**Files:** Modify `src/features/related/model.ts`; Test `src/features/related/model.check.ts`.

**Interfaces — Produces:**
- `export interface Spawn { parent: string; child: string; t0: number; t1: number }` — the subagent's active interval: spawning call start → its paired result; without a result, the child's first → last event (spec 5).
- `export function clobberCmd(cmd: string): boolean` — `git stash` (not `stash list|show`), `git checkout -- .`, `git checkout .`, `git restore .`, `git reset --hard`, `git clean -f…`, `git switch <x>` (not `-c`/`-C`), `git checkout <x>` where `<x>` is one non-flag argument without `/` or `.` (branch-like); everything else false.
- `export function markConflicts(rows: RelEv[], cMs: number, spawns: Spawn[]): number` — sets `mark/withS/dt/race` per spec 5 on the whole loaded range and returns the flagged count; `conflict` = same `(top, rel)`, different sessions, `|Δt| ≤ cMs`, not (parent, own child) unless the parent write lies inside that child's `Spawn` interval (`race = true`); `overlap` = same `rel`, different non-empty `top`, `|Δt| ≤ cMs`; `clobber` = `shell` row with `clobberCmd(text)` and another session's `write` in the same `top` within `cMs` before it. A conflict wins over an overlap on the same row.
- `export function relCfg(sec: Obj): { minutes: number; conflictMinutes: number; warn: string }` — integers 1–240 else 10; `warn` names each invalid key (`""` if none).

- [ ] **Step 1: Failing checks** (append to `model.check.ts`):
  - A writes `/w/main/src/a.ts` at 0, B at +70 s, C = 10 min → both rows `conflict`, B `withS = [A]`, `dt = 70000`;
  - same at exactly `+600000` → flagged; at `+600001` → not (C boundary);
  - same `rel` in `/w/main` and `/w/wt2` → `overlap` on both, not `conflict`;
  - parent P writes at +5 min, its child K writes the same file at +6 min, K's spawn interval [+1, +4] min → not flagged; interval [+4, +7] min → both `conflict`, P `race = true`; spawn without paired result → interval from K's first to last row (same two cases); siblings K1/K2 of P writing the same file → flagged;
  - `git stash` by A at +2 min after B wrote in the same top at +1 min → A row `clobber`, `withS = [B]`; `git stash list` → nothing; `clobberCmd` table: each listed form true, `git checkout src/a.ts` false, `git switch -c x` false, `git checkout main` true;
  - `relCfg({minutes: 5, conflictMinutes: 0})` → `{5, 10, warn mentions conflictMinutes}`; `relCfg({minutes: "x"})` → 10 + warn; `relCfg({minutes: 241})` → 10; `relCfg({})` → `{10, 10, ""}`.
  Run as in Task 2 → Expected: FAIL.
- [ ] **Step 2: Implement** (index rows by `top + "\u0000" + rel` and by `rel`; sort each bucket by `t`; compare neighbours inside `cMs` — no O(n²) over all rows).
- [ ] **Step 3: Run** → Expected: PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(related): conflict, overlap and clobber detection; related.* config`.

---

### Task 4: Candidates and the incremental builder

**Files:** Create `src/features/related/build.ts`, `src/features/related/build.check.ts`.

**Interfaces — Consumes:** `seekTime` (Task 1), `toRel`, `markConflicts`, `relCfg`, `Spawn` (Tasks 2–3), `sessions`, `loadHead` (`src/model/sessions.ts`), `ledger` (`src/features/usage/ledger.ts:13`), `sourceOf`, `window`, `parseEvents` (`src/harness/index.ts`), `identOfCwd`/`realCwd`/`Day.act` (repo-view), `Acc.vcs` + `readReflog(gitdir)` (git-linkage), rules-config `LOG`, `harnessOf(h).spawnOf` (via a local).

**Interfaces — Produces:**
- `export interface Build { anchor: RelEv; key: string; label: string; scope: string; t0: number; t1: number; cands: string[]; more: number; next: number; rows: RelEv[]; flagged: number; bytes: number; cur: Map<string, number>; end: Map<string, number>; seen: Set<string>; live: boolean; tsMissing: boolean }` — `scope` `"project"` or `"cwd"` (Ident kind `none`); `next` = index of the next candidate to read; `cur/end` = per-session cursor and stop cursor.
- `export function anchorTime(evs: Ev[], i: number): number` — own `ts`, else nearest earlier, else next later; `0` = none (spec 1).
- `export function candidates(anchor: Sess, t0: number, t1: number, cap: number): { paths: string[]; more: number; scope: string }` — same `identOfCwd(realCwd(s)).key` (or same real cwd for kind `none` / `null`); indexed sessions: active minutes of `Day.act` intersecting the window (window day keys → intervals); unindexed or pending: `mtime ≥ t0` and the first timestamp of the head ≤ `t1`; subagents are their own candidates; ranked by active minutes, top `cap` (40) kept, `more` = the rest; anchor always first.
- `export function startBuild(anchor: Sess, evs: Ev[], i: number, minutes: number, conflictMinutes: number): Build | null` — `null` when `anchorTime` is 0 (caller toasts "this event has no time").
- `export function stepBuild(b: Build, budgetMs: number, now: () => number): boolean` — reads 64 KB windows from `b.cands[b.next…]` (seek on first touch; reuse `S.tv.evs` when the open transcript is the anchor's and its first event `ts ≤ t0` or it was read from 0); stops a session at the first event with `ts > t1`; adds alert rows from `LOG` (`state` `fire`/`escalate`, `at ∈ [t0, t1]`, `path` ∈ candidates; approval waits, waiting, stuck) and commit rows (`VRef k:"commit"` with `t` in window, plus `readReflog(Ident.gitdir)` entries of every worktree of the project (distinct `gitdir` over all sessions with that `key`) in the window whose sha no session observed → `kind:"commit"`, `sess:""`, text `commit (no session) <sha7> <subj>`); collects `Spawn`s (subagent's parent + `spawnOf` call id → that call's start/result times); after each session: sort rows by `t`, `markConflicts`; returns `true` while candidates remain and `bytes < 16777216`; never runs longer than `budgetMs` (checks `now()` between windows).
- `export function repoll(b: Build): void` — live: when `t1 > Date.now()` and a candidate session is live, append from `b.cur` (no seek) and re-mark.

- [ ] **Step 1: Failing check** `build.check.ts` (sessions inserted into `sessions` with temp files; ledger Accs with `Day.act` set by hand; `LOG` and `Acc.vcs` filled through their public APIs):
  - anchor with `ts = ""` at index 3, index 2 has a ts → `anchorTime` = index 2's; all empty → 0 and `startBuild` null;
  - 45 sessions of the project active in the window, 3 of another project, 1 inactive → `cands.length === 40`, `more === 5`, other project absent, anchor first;
  - kind `none` anchor → only same-cwd sessions, `scope === "cwd"`;
  - an unindexed session (no Acc) with mtime in the window and head ts before `t1` → candidate;
  - budget: 40 sessions of 2 MB each fully inside the window → after stepping to completion `bytes <= 16777216`, `true` returned while work remains; a fake clock advancing 20 ms per window → each `stepBuild(b, 50, clock)` call reads ≤ 3 windows;
  - a `LOG` `fire` entry for a candidate in the window → `alert` row; for a non-candidate → none;
  - a `VRef` commit in the window → `commit` row of that session; a reflog commit (fixture `logs/HEAD` in a temp gitdir) not observed → `commit (no session)` row with `sess === ""`; an observed sha → only the session's row;
  - live repoll: append 2 lines to a candidate file, `repoll` → 2 more rows, no duplicates.
  Run: `scriptc build src/features/related/build.check.ts -o /tmp/rb && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/rb` → Expected: FAIL.
- [ ] **Step 2: Implement** `build.ts`.
- [ ] **Step 3: Run** → Expected: PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(related): candidate sessions and an incremental, budgeted builder`.

---

### Task 5: The `related` view, keys and entry points

**Files:** Create `src/features/related/view.ts`; Modify `src/main.ts` (import `./features/related/view.ts` after `./features/callgraph/view.ts`), `src/features/callgraph/view.ts` (export `graphAnchor()`; let `r` fall through in its view key handler, `:344-357`), `src/ui/help.ts` only through `H.helpSections` (no edit of `HELP`); Test `src/features/related/view.check.ts`.

**Interfaces — Consumes:** `Build`, `startBuild`, `stepBuild`, `repoll`, `KIND_SETS` (Tasks 2–4), `openTranscript` (`src/ui/transcript.ts:100`), `TV.focusKind/focusTs/focusText` (`src/state.ts:10`), `H.views/keys/mouse/onTick/footerHints/helpSections` (`src/hooks.ts`), `section("related")` (`src/util/config.ts`), filter-language parser + the `--watch` event matcher (names from Task 0 Step 2).

**Interfaces — Produces:**
- callgraph: `export function graphAnchor(): { s: Sess; evs: Ev[]; i: number } | null` — the selected span's session (`G.tvs[span.src].s`), its events and `span.ev`; `null` when nothing is selected or `ev < 0`.
- `export function openRelated(s: Sess, evs: Ev[], i: number): void` — saves `back = {mode: S.mode, tv: S.tv, dv: S.dv, fview: S.fview}`, starts the build (toast and stay when `null`), sets `S.fview = "related"`, `S.mode = "view"`.
- View state `R = { b, sel, top, minutes, cycle: number[], fileOnly, own, kset, q, pred, back, inTranscript }`.

Behavior (spec 6):
- Entry: `r` in `detail` (anchor `S.dv.idx` of `S.tv.evs`), `transcript` (`tv.cur`, else last event), `view`/`callgraph` (`graphAnchor()`).
- Render: header ` related · <label> · ±Nm around HH:MM:SS · n sessions · m events · ‼ k` (+ `· loading i/n sessions` while building, `+K more sessions not shown`, `(same cwd: no project)` for scope `cwd`); rows per the spec mock: marker (`▶ ‼ ≈`), offset `±mm:ss`, local clock, harness glyph + `fit(titleOf(s), 16)`, worktree tag when it differs from the anchor's, kind glyph + tool, text, status (`✗`, `+a −d`, note `also edited by <glyph> <title> 1m10s earlier`, `parent wrote while its subagent ran`); anchor-session rows in normal colour, others tinted with `harnessOf(h).color()`.
- Keys in the view: `↑↓ j k`, `g G`, `pgup pgdn`; `enter` → `openTranscript(s)` + focus (`focusKind = evKind`, `focusTs = ts`, `focusText = evId || evText`), sets `R.inTranscript`; in `transcript` mode with `R.inTranscript`, `esc q left` return to the view (handled before the built-in transcript esc); a row whose event lies before the loaded transcript window toasts `event is older than the loaded transcript (last 6 MB)` (command-palette later replaces this with a start-cursor open); `+`/`-` step through `[2,5,10,30,60]` ∪ configured value (rebuild); `f` files ∩ anchor files; `o` own session rows on/off; `k` cycles `KIND_SETS`; `n`/`N` next/previous flagged row; `/` opens `ask("filter related", …)` → `compile(parse(text).cs, "watch")` (error → `S.inputErr`, last valid filter kept); call clauses run the `f.event` predicates on tool rows (`(s, "tool", name, args)`), session clauses `sessMatches(f, s)` on the row's session, non-tool rows pass call clauses only when no call clause is given; a parse error toasts its message; `esc q backspace` → restore `back`.
- Tick: `H.onTick` → `stepBuild(R.b, 50, Date.now)` while it returns true; every 4th tick `repoll` when live (2 s).

- [ ] **Step 1: Failing check** `view.check.ts` (drives `onInput` with key names; sessions from temp files as in Task 4):
  - from transcript with `tv.cur` on an Edit → `r` → `S.mode === "view"`, `S.fview === "related"`; `esc` → back in transcript, same `tv`, same `cur`;
  - from detail → `r` → view; `esc` → detail with the same `dv.idx`;
  - from the call graph with a selected tool span → `r` → view anchored on that event; `esc` → `S.fview === "callgraph"`;
  - anchor without any time → toast `this event has no time`, mode unchanged;
  - `+` from 10 → 30 (rebuild, `t1 - t0 === 60 min`); `-` twice → 5; configured 7 → cycle contains 7;
  - `k` cycles 3 sets; `o` hides anchor-session rows; `f` keeps only rows sharing a `FileRef` with the anchor;
  - `n` moves to the next `‼`/`≈` row, `N` back; `/` `tool is Bash` → only Bash rows (+ non-tool rows hidden since a call clause is given); `/` `harness is codex` → only codex sessions' rows;
  - `enter` on another session's row → transcript of that session, `focusTs` set; `esc` → back in the related view.
  Run: `scriptc build src/features/related/view.check.ts -o /tmp/rv && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/rv` → Expected: FAIL.
- [ ] **Step 2: Implement** `view.ts`, the callgraph export + `r` fall-through, the `main.ts` import, a help section (`ctx: "related"`) and footer hints (`r related` in transcript/detail; the view's own hints).
- [ ] **Step 3: Run** → Expected: PASS; `sh scripts/check.sh` → all `ok`; `./build.sh` OK.
- [ ] **Step 4: Commit** `feat(related): related-events view on r from detail, transcript and call graph`.

---

### Task 6: `agentglass --json --related`

**Files:** Modify `src/features/cli.ts` (option parsing, usage text, handler); Create `src/features/related/cli.ts` (JSON assembly, imported by `cli.ts`); Test `src/features/related/cli.check.ts`.

**Interfaces — Produces:**
- `export interface RelJson { anchor: { session: string; harness: string; t: string; kind: string; text: string }; project: { key: string; label: string }; from: string; to: string; sessions: { id: string; harness: string; title: string; worktree: string }[]; events: { t: string; session: string; harness: string; title: string; kind: string; tool: string; text: string; files: string[]; err: boolean; self: boolean; conflict: { kind: string; with: string[] } | null }[] }` (spec 7; `files` = `rel` only; `with` = session ids).
- `export function relatedJson(prefix: string, eventId: string, at: string, minutes: number): { code: number; json: string; err: string }` — `code` 0 ok, 2 ambiguous/bad option (candidates in `err` as `harness:id title` lines), 3 unknown prefix or event not found; anchor = the event with that id, else the first event at/after `--at`, else the session's last event; runs `stepBuild` to completion (no tick budget in CLI; the 16 MB cap stays).

- [ ] **Step 1: Failing check** `cli.check.ts`: fixture sessions (two projects) → `relatedJson("<6-char prefix>", "<call id>", "", 10)` → `code 0`, JSON parses, `events` sorted by `t`, the conflict row has `conflict.kind === "conflict"` and `with` = the other session's id; ambiguous prefix (two ids sharing it) → `code 2`, `err` has two lines; unknown → `code 3`; `--at` before the session's first event → anchor = first event; under the check's `AGENTGLASS_REDACT=1`, titles and cwd-derived labels are the fakes (`AGENTGLASS_REDACT_KEEP=keepme` kept), never the real title.
  Run → Expected: FAIL.
- [ ] **Step 2: Implement**; `cli.ts`: `--related <prefix>` with `--event`, `--at`, `--minutes` (1–240, else exit 2 via `fail`), only together with `--json`; usage rows added under "options for --json". If cli-agent-mode is merged, register a help record for `--related` and route errors through its JSON error writer in agent mode.
- [ ] **Step 3: Run** → Expected: PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(related): --json --related prints the related timeline`.

---

### Task 7: Fixture project end to end

**Files:** Create `scripts/related.test.sh`.

- [ ] **Step 1: Failing test** `scripts/related.test.sh`: temp `HOME`; `git init` a repo `$t/w/main` with one commit and `git worktree add $t/w/wt2`; write all timestamps on 2026-09-30 UTC: a Claude session (cwd `$t/w/main`, `Edit src/a.ts` at 14:02:31 and 14:06:43, a `git commit` banner at 14:10:13), a Codex rollout (cwd `$t/w/wt2`, `apply_patch` `src/a.ts` at 14:06:03 + `npm test` failing), a pi session (cwd `$t/w/main`, `edit src/a.ts` at 14:07:53) using the Task 0 shapes; build agentglass once (`AGENTGLASS_OUT=$t/ag sh build.sh`); run `HOME=$t $t/ag --json --related <claude id prefix> --at 2026-09-30T14:06:43Z`. Expected: events interleaved by time from 3 harnesses; the pi row `conflict` with the Claude session (same `top`), the Codex row `overlap` (other worktree); the commit row present; `$t/ag --json --related zzzzzz` exits 3.
  Run: `sh scripts/related.test.sh` → Expected: FAIL before Task 6 is wired / PASS after.
- [ ] **Step 2: Fix** whatever the end-to-end run exposes (root cause, in the owning module, with a check added there).
- [ ] **Step 3: Run** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `test(related): three harnesses in two worktrees, end to end`.

---

### Task 8: Real-life verification, docs, final review

**Files:** Modify `README.md` (keys table: `r`; a "Related events" section incl. config keys, conflict kinds, the shell-write limit and the per-harness approval findings from Task 0), `CHANGELOG.md` (unreleased entry).

- [ ] **Step 1: Real sessions (read-only).** `./build.sh`; in the TUI open a recent transcript in a repo where several agents ran (the user's `~/code/agentglass` sessions qualify); press `r` on an Edit → rows from other sessions/harnesses appear, `loading` progresses, `+`/`-` rebuild, `enter`/`esc` round-trip works, the call graph `r` works. Run `./agentglass --json --related <id prefix> --minutes 30 | head -c 2000` and compare with the view. Run once with `--redact`: no real titles/paths in view or JSON. Measure: `/usr/bin/time -v ./agentglass --json --related <prefix> --minutes 60` → max RSS and wall time recorded in the PR description.
- [ ] **Step 2: Docs** README + CHANGELOG + help section text.
- [ ] **Step 3:** `sh scripts/check.sh` → all `ok`; `./agentglass --json --subagents --limit 400` identical to `main` except volatile fields.
- [ ] **Step 4: Commit** `docs: related events`.
- [ ] **Step 5: Final whole-branch review** (most capable model) against spec + Review Focus, one fix pass, PR to `main`, CI green, rebase-merge, remove worktree and branch.
