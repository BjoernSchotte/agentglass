# Gemini CLI harness adapter — spec

Status: **draft** (2026-10-01). Plan: [plan.md](plan.md). Research notes (source refs, JSON shapes):
`research-gemini.md` (session scratchpad, summarized here). Source read: `google-gemini/gemini-cli` main
(`0.64.0-nightly.20260929`). Gemini CLI is not installed yet; every shape below is from source until Task 0 captures
real files.

## Goal
agentglass shows Gemini CLI sessions with the same depth as the other harnesses: list, live transcript, drill-down,
subagents, live/busy, send/resume, tokens + cost, Stats, `--json`/`--watch`, trash.

## Facts

### Storage (≥ v0.39, 2026-04-23)
```
~/.gemini/tmp/<slug>/.project_root                 absolute cwd (one line)
~/.gemini/tmp/<slug>/chats/session-<YYYY-MM-DDTHH-MM>[-<n>]-<id8>.jsonl     main sessions
~/.gemini/tmp/<slug>/chats/<parentSessionId>/<agentId>.jsonl              subagents (kind "subagent")
~/.gemini/tmp/<slug>/tool-outputs/session-<id>/, <slug>/<id>/, logs/session-<id>.jsonl   per-session artifacts
```
- `<slug>` = lowercased cwd basename + `-N` on collision (≥ v0.29) — not reversible: **cwd comes from `.project_root`**.
  Pre-0.29 `tmp/<sha256>` dirs are copied, not moved → stale duplicates: **dirs without `.project_root` are skipped**
  (also `tmp/bin`). `SANDBOX=sandbox-exec` uses `~/.cache/.gemini/tmp` (second root).
- Gemini deletes sessions after 30 days by default (`general.sessionRetention`).
- Legacy whole-file `.json` sessions (≤ v0.38) are out of scope (all older than the retention window).

### Record stream (one JSON per line, appended with open/close per write — the file is never held open)
1. Header (first line): `{"sessionId":"<uuid>","projectHash":"<sha256>","startTime":"…","lastUpdated":"…","kind":"main"|"subagent"}`.
   The filename carries only `id.slice(0,8)`: **the full id comes from the header**.
2. Message `{id, timestamp, type:"user"|"gemini"|"info"|"error"|"warning", content, …}`:
   - `user`: `content` = string | Part | Part[] (`{text}`, `{inlineData}`, `{functionResponse}` …). A user message holding
     only `functionResponse` parts is a synthetic tool-result echo (skip; results come from `toolCalls[].result`).
   - `gemini`: `content` = response text; `model`; `thoughts[{subject, description, timestamp}]`;
     `tokens{input, output, cached, thoughts, tool, total}`; `toolCalls[{id, name, args, result[functionResponse], status,
     timestamp (completion), agentId?, displayName, description, resultDisplay(string | {fileDiff, filePath, diffStat{model_added_lines, model_removed_lines}})}]`.
3. Patch `{"$set":{…}}`: `summary` (title), `lastUpdated` (after every message), `directories`, `memoryScratchpad`;
   `{"$set":{"messages":[…]}}` = full checkpoint after compression/masking (reader rebuilds from it).
4. Rewind `{"$rewindTo":"<messageId>"}`: that message and everything after it are dropped (`/rewind`).
- **Upserts**: a changed message is re-appended in full with the same `id` (tokens arriving late, completed tool calls
  merged into the last gemini message). Tool calls are only written **on completion**. The same tokens repeat on every
  re-append, checkpoint and rewind replay.

### Usage
- `input` includes `cached`; `thoughts` are billed as output; `tool` is input-side. No cost anywhere in the files;
  background helper calls (router, summaries, compression) are not in the transcript (slight undercount).
- `pricing.ts` has no Gemini prices; the opt-in community lists (LiteLLM `gemini` provider, models.dev) do.
- Pro models charge ~2× input / 1.5× output for prompts > 200k tokens.

### CLI
- `gemini --resume <full uuid> -p "<msg>"` (headless, same file appended), `gemini --resume <uuid>` (interactive);
  lookup is per project → **cwd must be the session's project root** (agentglass already spawns in `s.cwd`).
- Headless denies any tool that would ask for approval unless `--approval-mode auto_edit|yolo`.
- Subagent sessions cannot be resumed.
- Processes: `node …/gemini(.js)` parent + a relaunched child `node --max-old-space-size=… …/gemini.js` (env
  `GEMINI_CLI_NO_RELAUNCH=true`); SEA binary `gemini`. No pid registry, no lock.

## Design decisions (proposed)

1. **Adapter `src/harness/gemini.ts`**, id `gemini`, label `Gemini`, glyph `✦`, own theme color `C.gemini` (Gemini blue, set in every theme like `C.codex`), `bin: "gemini"`,
   `procs: ["gemini"]`; `"gemini"` leaves `OTHER` in `src/model/procs.ts`; `harnessOf` there skips leading `-`/`--flag`
   args after `node` so the relaunched child is recognized too (it then groups under the parent as today).
2. **Normalizing source** (the hard part). The transcript, tail loader and ledger read Gemini sessions through a
   `SessionSource` (cursor = bytes, `unit` 1, so file windows stay as they are) whose `lines(s, from, to)` returns a
   **normalized, append-only** stream: a per-path index (built incrementally from byte 0, extended to `to`) records for
   every message id, tool-call id and token-carrying version the **byte offset of its first occurrence**. A line at
   offset X is emitted as:
   - message fields only if X is the first offset of that message id (text, thoughts, model);
   - each tool call only if X is the first offset of that tool-call id (it arrives with a re-append);
   - `tokens` only if X is the first offset where that message id carried tokens;
   - `$set.summary` → `{"$title":…}`; `$rewindTo` → `{"$meta":"rewound"}`; `$set.messages` → messages from the array
     whose ids were never seen (normally none) + `{"$meta":"history compressed"}`; `lastUpdated`-only patches dropped.
   Lines that end up empty are dropped. Because emission depends only on first offsets, any window `[from, to)` yields
   each id once, readers never see a duplicate, and the ledger books tokens and calls exactly once. Rewound/compressed
   history stays visible in the transcript with a marker (as it happened), Stats keep what was billed.
3. **parse** (on normalized lines): user text (noise filter: `/`, `?`, `<session_context>`, `<hook_context>` prefixes) →
   `user`; thoughts → `thinking` (`subject: description`); gemini text → `assistant`; each tool call → `tool`
   (`name` + `toolArg`) and `result` (`[error] `/`[cancelled] ` prefix for status ≠ success; text = functionResponse
   `output`/`error` or `resultDisplay` string); `info`/`error`/`warning` → `meta`; `$title` → `s.title`; `$meta` → `meta`;
   `model` → `s.model`.
4. **scan**: roots `~/.gemini/tmp` (+ `~/.cache/.gemini/tmp` if present). For each `<slug>` with `.project_root`:
   `chats/session-*.jsonl` → id from the header (≤ 4 KB, read once, cached by path); `chats/<uuid>/*.jsonl` → subagent,
   id = basename, parent = dir name. `meta` sets `s.cwd` from `.project_root` and `s.kind` (`subagent` → agent name if
   the header names one, else `subagent`).
5. **spawnOf**: the index records `toolCalls[].agentId → toolCall.id` while indexing the parent; a subagent's spawn =
   lookup of its id in the parent's index (built on demand, cached).
6. **busy** (from tail events): last event `user` or `tool` without its `result` → busy; last `result` → busy (the model
   answers next); `assistant`/`meta` → idle. Ambiguity (text + a still-running tool call that is not written yet) is
   accepted: shows idle until the call completes.
7. **Liveness**: `liveCwd: true` (process cwd = project root). Subagents have `s.parent` → never linked.
8. **Usage**: per normalized gemini line with tokens: `in = input − cached + tool`, `out = output + thoughts`,
   `cacheRead = cached`, `cacheWrite = 0`, priced via the table (`usageExact` with `usd = -1`). Tool calls: `tool` + `pend`
   + `done` on the same line (they are written complete): duration = `toolCalls[].timestamp − message.timestamp`
   (≥ 0 else unknown), error = status ≠ success. Lines/files: `replace` (`file_path`, `old_string`/`new_string`),
   `write_file` (`file_path`, `content`), preferring `resultDisplay.diffStat.model_added_lines/model_removed_lines` when
   present; shell: `run_shell_command` (`command`). Subagent files are counted as their own sessions (the parent's
   `invoke_agent` carries no tokens → no double count).
9. **Prices**: built-in entries for `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3-pro`,
   `gemini-3.1-pro`, `gemini-3-flash` with values **verified against ai.google.dev/pricing at implementation time**
   (each version prefix listed explicitly, longest prefix wins, so `gemini-3` never prices `gemini-3.5-…`). Long-context
   tier: a message with `tokens.input > 200000` on a Pro model is priced under `<model>>200k` entries. Models without
   a price → `unk` (or the opt-in community list / `prices.json`).
10. **Steering**: `headless: ["--resume", s.id, "-p", msg]`, `resume: ["--resume", s.id]`; no approval flag by default
    (like Claude/Codex: tools needing approval are denied in headless runs); users who want more set
    `AGENTGLASS_GEMINI="gemini --approval-mode auto_edit"`. Live sessions go through tmux as for every harness.
11. **files** (trash): the session file, `chats/<id>/` (its subagents), `tool-outputs/session-<id>/`, `<slug>/<id>/`,
    `logs/session-<id>.jsonl` — what gemini's own delete removes; never `logs.json` (shared by all sessions).
12. **Real-life test** through cliproxyapi (if it serves the Gemini protocol) or with the user's Google login — open
    question 1.

## Testing
- Normalizer check (the core): a fixture with a message re-appended with tool calls, late tokens, a `$set.summary`,
  a `$rewindTo` and a `$set.messages` checkpoint → for every window split (all `from` cut points) the union of emitted
  ids equals the set of ids, each exactly once; tokens booked once (Stats tokens = sum over unique ids).
- Contract check (`harness.check.ts` SAMPLES) for parse, headless/resume args, scan/meta on a temp `~/.gemini`.
- Usage check: fixture tokens → in/out/cache split, price lookup incl. `>200k`, tool rows, lines from diffStat.
- procs: `node --max-old-space-size=8192 /x/gemini.js` and `node /x/bin/gemini` both resolve to `gemini`.
- Real-life: install gemini (npm `@google/gemini-cli`), small todo-app run with one subagent, resume + headless send,
  then agentglass list/transcript/Stats/live/busy against it.

## Out of scope
Legacy `.json` sessions, pre-0.29 hash dirs, container sandboxes (sessions inside the container), remote (A2A) agents,
`/chat save` checkpoint tags, Windows.

## Open questions
1. Auth for the live test: cliproxyapi (if it proxies Gemini) or your Google login (`gemini` OAuth, free tier)? Or a
   Gemini API key? Default: try cliproxyapi, else ask.
2. Install `@google/gemini-cli` globally under nvm Node 24 (`npm i -g --ignore-scripts`)? Default: yes.
3. Glyph/color: `✦` in Gemini blue OK?
