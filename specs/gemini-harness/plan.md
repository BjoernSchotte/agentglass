# Gemini CLI Harness Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agentglass shows Gemini CLI (≥ 0.39) sessions like the other harnesses: list, live transcript, subagents, live/busy, send/resume, tokens + cost, Stats, `--json`, trash.

**Architecture:** One adapter file `src/harness/gemini.ts` behind the `HarnessAdapter` port, registered in `HARNESSES`. Its `SessionSource` turns Gemini's upsert/rewind/checkpoint JSONL into a normalized append-only stream (first-occurrence index per path), so the existing append-only readers (transcript, tail, ledger) work unchanged. Built-in Gemini prices in `pricing.ts`.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`).

**Spec:** [spec.md](spec.md) — read it first; this plan argues from it.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`; a task is done only when both pass.
- scriptc limits: no `readlinkSync`; no `n.toString(radix)`; nominal typing; optional function members via a local; out-of-range array reads trap; no crypto (no sha256 → never derive slugs or hashes, read `.project_root`).
- Byte offsets are bytes, not string lengths: the normalizer splits raw `readBytes` buffers at `\n` (10) and decodes per line; never compute offsets from JS string lengths (UTF-8).
- Style: match the surrounding adapters (pi.ts, kiro.ts): dense helpers, short why-comments, no new dependencies.
- Other harnesses unchanged: `--json --subagents --limit 400` for claude/codex/fx/pi/opencode/kiro identical before/after (volatile fields excepted).
- Never write into `~/.gemini` except the existing trash action (moves files); never touch `logs.json`.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-gemini`, branch `feat/gemini-harness`, PR to `main`, rebase-merge after green CI. Starts after the pi/OpenCode depth branch is merged (both touch `procs.ts`/`harness.check.ts`).

## Review Focus

1. **Window boundaries in the normalizer**: a reader starting mid-file (tail window) must not emit a re-appended message as new nor drop a tool call that first appears in its window. Task 2 check iterates every cut point.
2. **Token double counting** across re-appends, `$set.messages` checkpoints and rewind replays: Stats tokens = sum over unique message ids. Task 2 + Task 4 checks.
3. **A partially written last line** (Gemini appends while we read): the index must not advance past it; the next read completes it. Task 2 check with a truncated tail.
4. **Two projects with the same basename** (`app`, `app-1`) and a stale `tmp/<64 hex>` copy: each session listed once with the right cwd. Task 3 check.
5. **Unknown model / long-context price**: `gemini-3.5-flash` with no price → `unk`, not $0; a Pro message with input 250k priced at the `>200k` rate. Task 4 check.

---

### Task 0: Install Gemini CLI, real sessions, fixtures

**Files:** `specs/gemini-harness/fixtures/` (anonymized, ≤ 60 lines per file).

- [ ] **Step 1: Worktree** `git worktree add -b feat/gemini-harness ../agentglass-gemini main`; `./build.sh`.
- [ ] **Step 2: Install** (open question 2): `PATH=$HOME/.nvm/versions/node/v24.12.0/bin:$PATH npm i -g --ignore-scripts @google/gemini-cli && gemini --version`.
- [ ] **Step 3: Auth** (open question 1): cliproxyapi if it serves Gemini (`GOOGLE_GEMINI_BASE_URL`/`GEMINI_API_KEY` pointing at it), otherwise stop and ask the user.
- [ ] **Step 4: Real runs** in `/tmp/agtest-gemini`: "Build a minimal todo web app (index.html + app.js, localStorage), then run `node --check app.js`"; ask it to use the `codebase_investigator` agent once (subagent file); `/rewind` once; then `gemini --resume <id> -p "add a clear-completed button"` headless.
- [ ] **Step 5: Capture** the session JSONL, one subagent JSONL, `.project_root`, the directory listing of `~/.gemini/tmp/<slug>/`. Anonymize (`$HOME` → `/home/u`, keys/emails), trim tool output to ≤ 200 chars.
- [ ] **Step 6: Commit** `chore(specs): real Gemini CLI fixture sessions`. If real data contradicts the spec facts: ledger a `Ruling:` and follow the data.

---

### Task 1: Adapter skeleton, registration, process detection

**Files:** Create `src/harness/gemini.ts`; Modify `src/harness/index.ts` (`HARNESSES`), `src/model/procs.ts` (`OTHER` minus `gemini`; `harnessOf` skips `-` args after `node`/`bun`/`deno`), `src/ui/theme.ts` + `src/features/themes.ts` (new color `gemini` in every theme, next to `codex`); Test `src/harness/harness.check.ts`, `src/model/procs.check.ts` (create if absent: `harnessOf` cases).

**Interfaces — Produces:** `export const gemini: HarnessAdapter` with `id "gemini"`, `label "Gemini"`, `glyph "✦"`, `mark "✦"`, `color: () => C.gemini`, `bin "gemini"`, `procs ["gemini"]`, `roots`, `scan`, `meta`, `headBytes 65536`, `parse`, `busy`, `liveCwd: true`, `headless`, `resume`, `files`, `usage` (stubs filled by later tasks; `harnessOf` exported for the check if not already).

- [ ] **Step 1: Failing checks**: `harnessOf("node /u/.nvm/x/bin/gemini -p hi") === "gemini"`, `harnessOf("node --max-old-space-size=8192 /x/bundle/gemini.js") === "gemini"`, `harnessOf("node /x/pi.js")` unchanged; harness contract check iterates `HARNESSES` and finds `gemini` (headless contains id + MSG, resume contains id).
- [ ] **Step 2:** FAIL. **Step 3: Implement** (skeleton with `headless: (s, m) => ["--resume", s.id, "-p", m]`, `resume: (s) => ["--resume", s.id]`). **Step 4:** PASS + suite + other harnesses identical.
- [ ] **Step 5: Commit** `feat(gemini): register the Gemini CLI adapter and detect its processes`.

---

### Task 2: Normalizing source (first-occurrence index)

**Files:** Modify `src/harness/gemini.ts` (`source`); Create `src/harness/gemini.check.ts`.

**Interfaces — Produces:**
- `interface Ix { at: number; msg: Map<string, number>; call: Map<string, number>; tok: Map<string, number>; spawn: Map<string, string>; size: number }` — per path, `at` = bytes indexed (always a line start), maps id → first byte offset; `spawn`: agentId → tool-call id.
- `function indexTo(path: string, to: number): Ix` — reads `[ix.at, to)` with `readBytes`, splits at byte 10, parses each **complete** line, records first offsets; stops before an incomplete last line. Reset when the file shrank.
- `const source: SessionSource` — `stat` = file size/mtime; `align` = FILE_SOURCE.align; `lines(s, from, to)` = `indexTo(s.path, to)` then for each complete line in `[from, to)` (byte offset X) emit `normalize(o, X, ix)` per spec decision 2 (skip empty results); `next` = offset after the last complete line; `unit 1`.
- `function normalize(o: Obj, x: number, ix: Ix): string` — returns `""` or one JSON line: `{"id","timestamp","type",…message fields if first(msg)…, "toolCalls":[only calls whose first offset is x], "tokens": only if first(tok) is x}`; `$set.summary` → `{"$title":…}`; `$rewindTo` → `{"$meta":"rewound"}`; `$set.messages` → `{"$meta":"history compressed"}` plus unseen messages; header → passed through (`{"sessionId",…,"kind"}`).

- [ ] **Step 1: Failing checks** (fixture from Task 0, else a synthetic one with: header; user m1; gemini m2 with tokens; m2 re-appended with toolCalls c1,c2 and the same tokens; `$set.summary`; `{"$set":{"lastUpdated":…}}`; user m3; `$rewindTo:"m3"`; `$set.messages` repeating m1,m2; gemini m4 with tokens and c3; a truncated last line):
  - full read: m1, m2 (text once), c1, c2, c3 once each; tokens of m2 and m4 once; `$title` once; truncated line not emitted and `next` stops before it;
  - **every cut point**: for each line start `k`, `lines(0,k)` ∪ `lines(k,end)` emits the same ids as the full read, each once;
  - append the rest of the truncated line → next read emits it.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(gemini): normalizing source — upserts, rewinds and checkpoints become an append-only stream`.

---

### Task 3: scan, meta, parse, busy, spawnOf, files

**Files:** Modify `src/harness/gemini.ts`; Test `src/harness/gemini.check.ts`, `src/harness/harness.check.ts` (SAMPLES: normalized lines).

- `roots()`: `~/.gemini/tmp`, plus `~/.cache/.gemini/tmp` if it exists. `GEMINI_CLI_HOME`/`GEMINI_DIR` env overrides only if the source honors them (check `core/src/config/storage.ts`; else none).
- `scan`: per root, per `<slug>` dir with a readable `.project_root`; `chats/session-*.jsonl` → `add(path, headerId(path), "", false)`; `chats/<dir>/*.jsonl` → `add(path, basename, dir, false)`. `headerId`: first line ≤ 4 KB, cached by path.
- `meta`: `s.cwd` = `.project_root` (trimmed) of the slug (two/three levels up); header `kind:"subagent"` or scan parent → `s.kind = "subagent"`.
- `parse` per spec decision 3 (normalized lines; `functionResponse` result text = `response.output ?? response.error ?? JSON`; status ≠ `success` → `[<status>] ` prefix).
- `busy` per spec decision 6.
- `spawnOf(s)`: parent path = `chats/<parent>.jsonl`'s file found by the header id (cache a map sessionId → path during scan); `indexTo(parent, size).spawn.get(s.id) ?? ""`.
- `files(s)`: per spec decision 11 (existing paths only).

- [ ] **Step 1: Failing checks**: temp `HOME` with slugs `app` (`.project_root` `/w/app`), `app-1` (`/v/app`), a 64-hex dir without `.project_root`, `bin/` → sessions only from `app`/`app-1` with the right cwd; subagent under `chats/<parentId>/` → parent link, kind; `spawnOf(sub)` = the tool-call id carrying its agentId; parse SAMPLES produce user/assistant/thinking/tool/result/meta events and set title + model; `busy` cases: last `user` → true, last `result` → true, last `assistant` → false; `files` lists the session + its subagent dir, never `logs.json`.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(gemini): sessions, subagents, transcript, busy and trash`.

---

### Task 4: Usage + Gemini prices

**Files:** Modify `src/harness/gemini.ts` (`usage`), `src/features/usage/pricing.ts` (built-in Gemini entries + long-context keys); Test `src/harness/gemini.check.ts`, `src/features/usage/calls.check.ts` or a new `pricing.check.ts` for the price lookup.

- Prices: fetch `https://ai.google.dev/gemini-api/docs/pricing` at implementation time and copy the standard (paid tier, ≤ 200k / > 200k) input, output and cache-read prices per model; add entries for every listed model in the spec decision 9 list that the page prices; explicit version prefixes; long-context keys `"<model>>200k"`. Record the source URL and date in a comment next to the table.
- `usage(a, l)`: pre-filter `"tokens":{` / `"toolCalls"`; parse; `d = bucket(a, 0, timestamp)`; tokens per spec decision 8 with model key `md + (isPro(md) && input > 200000 ? ">200k" : "")`; tool calls: `tool` + `pend` + `done` immediately (duration, error, output size = result text length); lines/files per spec decision 8; shell commands into `pend`'s `cmds`.

- [ ] **Step 1: Failing checks**: message `tokens{input:1000,cached:400,output:100,thoughts:50,tool:10}` on `gemini-2.5-pro` → in 610, out 150, cr 400, cost = table price × those; input 250000 → `>200k` rate; `gemini-3.5-flash` without price → `unk` > 0 and cost 0; `run_shell_command {command:"npm test"}` status error → tool row err 1, shell program `npm`; `replace` with diffStat 3/1 → lines +3 −1 and file row; the same normalized stream read twice from different windows → identical Acc totals.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS + suite; `src/features/usage/cache.ts` `VERSION` bump with comment (Gemini prices change cached costs only for Gemini sessions, but the price fingerprint already handles user/community tables — bump only if the built-in table is part of the cache key; check `pricing.ts` fingerprint and ledger first, ledger a `Ruling:` either way).
- [ ] **Step 5: Commit** `feat(gemini): tokens, cost and tool stats; built-in Gemini prices`.

---

### Task 5: Real-life verification + docs

**Files:** Modify `README.md` (harness list, Gemini notes: 30-day retention, headless approval mode, legacy `.json` not shown), `src/ui/help.ts` if it lists harnesses.

- [ ] **Step 1:** Against the Task 0 sessions and a new live run: list + cwd, transcript (thinking, tools, results, rewind/compression markers), subagent nested + call graph link, live dot + busy while running, `s` headless send (appends to the same file), `R` resume, Stats rows (`run_shell_command`, `write_file`, `replace`, per-day tokens + cost), `--json`, trash moves the session + its subagent dir.
- [ ] **Step 2:** Docs. **Step 3:** `sh scripts/check.sh` PASS. **Step 4: Commit** `docs: Gemini CLI in the README`.
- [ ] **Step 5:** Final whole-branch review (most capable model), one fix pass, PR, CI green, rebase-merge, remove worktree + branch, clean `/tmp/agtest-gemini`.
