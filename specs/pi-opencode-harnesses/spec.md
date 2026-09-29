# pi + OpenCode harness adapters — spec

Status: **implemented** (2026-09-29). Plan: [plan.md](plan.md).

## Goal

agentglass shows pi and OpenCode sessions like Claude/Codex/fx: list, live transcript, drill-down,
subagents (OpenCode), live + busy state, send/resume, tokens/cost in Stats, `--json`/`--watch`.
Each is one adapter behind the `HarnessAdapter` port (`src/harness/types.ts`), registered in
`HARNESSES`, with golden samples in `src/harness/harness.check.ts`.

## Targets

| | version to target | install on this box | storage |
|---|---|---|---|
| **pi** | `@earendil-works/pi-coding-agent` **0.87.1** (session format v3; read v1/v2 too) | not installed globally (only a 0.84.2 pnpm dep of maifab — leave it) → `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` | JSONL `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl` |
| **OpenCode** | **2.0.19** (`@opencode/cli`, GA since 2026-09-11, repo `anomalyco/opencode` branch `v2`) + 1.2–1.18 (`opencode-ai`) | brew `opencode` 1.17.10, no sessions yet → install `@opencode/cli` | SQLite `~/.local/share/opencode/opencode.db` (WAL), v2 tables `session_v2`/`session_message`, v1 tables `session`/`message`/`part` |

OpenCode's pre-1.2 JSON `storage/` layout is out of scope (migrated to SQLite by 1.2.0 in Feb 2026).

## Findings that shape the design

### pi (source: pi-mono 0.87.1, `packages/coding-agent`)
- Header line `{"type":"session","version":3,"id","timestamp","cwd","parentSession"?}`; then entries
  `{type,id,parentId,timestamp(ISO)}`: `message` (roles `user`, `assistant`, `toolResult`, `bashExecution`,
  `custom`, `system`), `compaction`, `branch_summary`, `model_change`, `session_info{name}`, `usage`, `label`,
  `custom`, `custom_message`, `context_edit`, `thinking_level_change`.
- Assistant: `content[]` of `text` / `thinking` / `toolCall{id,name,arguments}`, `model`, `responseModel?`,
  `stopReason` ∈ stop|length|toolUse|error|aborted|deferred, `usage{input,output,cacheRead,cacheWrite,cacheWrite1h?,cost{total}}`.
  **pi writes its own cost** → take `usage.cost.total`, don't re-price.
- Usage also on `type:"usage"`, `toolResult.usage`, `compaction.usage`, `branch_summary.usage`.
- Forks (`/fork`, `--fork`) copy entries verbatim into a new file with `header.parentSession` → skip usage of
  entries older than the header timestamp, or costs double. `parentSession` is a fork, **not** a subagent.
- No built-in subagents (the example extension runs children with `--no-session`).
- Title: latest `session_info.name`, else first user text.
- **Liveness: no lock, no registry, file not kept open** (append/close per entry). Process title `pi` / `pi-rpc`
  (argv overwritten on Linux). Only link: the process cwd == session cwd (newest session there).
- Busy: last `message` is `user`/`toolResult`, or assistant with `stopReason:"toolUse"|"deferred"`.
- CLI: resume `pi --session <path|id>`; headless `pi -p --session <path|id> -- "<msg>"`. A bare id outside the
  cwd's session dir triggers an interactive "fork into cwd?" prompt → always pass the **file path**.
- Tools: `bash{command}`, `edit{path, edits[{oldText,newText}]}` (legacy `{path,oldText,newText}`),
  `write{path,content}`, `read`, `grep`, `find`, `ls`.

### OpenCode (source: anomalyco/opencode v2.0.19 + v1.18.33)
- One SQLite DB for all sessions; v2 migrates v1 rows into `session_v2`/`session_message` in the same file but
  keeps the v1 tables, and 1.18 keeps writing v1 → **read both, dedupe by session id, v2 wins**.
- `session_v2`: id, parent_id, directory, title, time_created/updated, time_suspended (set while a turn runs),
  time_idle, cost, tokens_*, model JSON. `session_message(id, session_id, type, seq, time_*, data JSON)`, ordered by
  `seq`; types user / assistant{content[text|reasoning|tool{id,name,state}], cost, tokens, finish, time} / shell /
  compaction / idle{outcome} (turn end) / system / synthetic / …
- v1: `message.data` (role, modelID, cost, tokens, time.completed) + `part.data` (text, reasoning, tool{callID,
  tool, state{status,input,output,time}}, step-start/finish, patch, …).
- Subagents: child session has `parent_id`; spawning call = v2 tool `subagent` (`state.metadata.sessionID`),
  v1 tool `task` (`metadata.sessionId`).
- OpenCode records its own `cost` (models.dev prices) per assistant message → take it; don't also sum step-finish.
- Liveness v2: daemon `opencode serve --service`, registration `~/.local/state/opencode/service.json`
  `{url, pid, password}`; busy = `time_suspended IS NOT NULL`. v1: no registry; busy = last assistant without
  `time.completed` / tool part pending|running.
- CLI (1.x and 2.x alike): resume `opencode -s <id>`; headless `opencode run -s <id> "<msg>"`.
- Reading without linking SQLite (scriptc can't): **`sqlite3 -readonly -json` CLI** (macOS: /usr/bin; Linux: often
  missing — here linuxbrew 3.53.4). Alternatives: v2 HTTP API (daemon must run), `opencode db` (1.x only, slow).

## Design decisions (proposed)

1. **Session source port.** Today six readers go straight to the file (`sessions.ts` head/tail, `ledger.ts`,
   `ui/transcript.ts`, `features/cli.ts --watch`, `callgraph/view.ts`). Add an optional
   `source?: SessionSource` to the adapter — `stat(s)` and `lines(s, from, to)` over an adapter-defined cursor
   (bytes for files, `seq` for OpenCode) plus `tailSpan` — and route all six readers through
   `sourceOf(s)`; the default is the current file reader, so claude/codex/fx/kiro don't change.
2. **Non-file sessions.** OpenCode sessions get a stable pseudo path `<db>#<session id>` (Sess.path stays the
   map key). Adapter capabilities become optional where a DB can't provide them: `files?` (trash) and new
   `search?(q)` (full-text); `roots()` may return `[]`.
3. **Liveness by cwd.** New optional `liveCwd?: boolean`: procs links each live process of that harness to the
   newest session whose `cwd` equals the process cwd (from `Platform.procFiles`). Used by pi (and OpenCode v1).
4. **Steering gets the session.** `headless(s, msg)` / `resume(s)` take the `Sess` (pi needs `s.path`); the four
   existing adapters change mechanically.
5. **Exact cost from the log.** New record primitive `usageExact(a, d, in, out, cr, cw, usd)` books tokens and
   a harness-reported cost without re-pricing (`usd < 0` falls back to the price table).
6. **OpenCode via `sqlite3` CLI**, read-only, `-cmd ".timeout 2000"`, re-queried only when `opencode.db` or
   `opencode.db-wal` mtime/size change. No sqlite3 → OpenCode sessions don't show, with one warning toast
   and a `--help` / README note. (HTTP-API fallback: later, if needed.)
7. **OpenCode delete (`D`) is not offered** — there is no trash, only permanent `opencode session delete`.
8. **Real-life tests through cliproxyapi** (`127.0.0.1:8317`, Claude + Codex accounts): pi and OpenCode are
   pointed at it as an Anthropic-/OpenAI-compatible provider; each builds a small todo web app; agentglass is
   checked against those real sessions (list, transcript, subagent for OpenCode, live/busy, send, resume, Stats).

## Out of scope
OpenCode JSON storage (< 1.2), OpenCode HTTP-API reader, pi subagent extension sessions, Windows.

## Decisions (approved 2026-09-29)
1. OpenCode: replace brew `opencode` 1.17.10 with `@opencode/cli` 2.0.19 (npm global); still read 1.2–1.18 tables.
2. `sqlite3` CLI is a runtime requirement for OpenCode (warning when missing).
3. pi: `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` (0.87.1) under nvm Node 24.
4. Real-life tests through cliproxyapi with the user's Claude/Codex accounts (one small todo app each).
5. OpenCode `D` (trash) is not offered.
