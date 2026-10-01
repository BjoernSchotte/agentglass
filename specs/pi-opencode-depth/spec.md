# pi MCP + pi subagents + OpenCode HTTP reader — spec

Status: **draft** (2026-10-01). Plan: [plan.md](plan.md). Follows [pi-opencode-harnesses](../pi-opencode-harnesses/spec.md),
whose "out of scope" list this closes: OpenCode HTTP-API reader, pi subagent extension sessions. Adds pi's native MCP
(0.99.0, 2026-09-29), which did not exist then.

Research notes (source refs, JSON shapes): `research-pi-mcp.md`, `research-pi-oc.md` (session scratchpad, summarized here).

## Goal
1. **pi MCP**: every MCP tool call pi makes shows in the transcript and in Stats (per tool, grouped per server, errors,
   durations) — native MCP in pi ≥ 0.99 (direct, deferred and the default *codemode* exposure) and the
   `pi-mcp-adapter` extension used before 0.99 (and still on 0.99). Tool calls nested in codemode scripts (bash, edit,
   write) count like top-level calls (lines, files, shell programs). Old pi without MCP: unchanged.
2. **pi subagents**: sessions written by the three subagent packages are found, shown nested under their parent
   (not as top-level sessions), linked to the spawning call, and their usage counted once.
3. **OpenCode over HTTP**: when the `sqlite3` CLI is missing (or fails) but the OpenCode 2.x service daemon runs,
   OpenCode sessions come from its HTTP API instead of not showing at all.

## Facts (from research)

### pi versions
- Newest pi 0.99.2 (2026-09-30); native MCP since 0.99.0; before that 0.87.1. Session header stays
  `{"type":"session","version":3,…}` — **no pi version in the file**. Detection must be by content, never by version.

### pi native MCP (≥ 0.99)
- Tool name `mcp__<server>__<tool>` (0.99.2: `[^A-Za-z0-9_]`→`_`; 0.99.0/1 kept `-`; > 64 chars → cut + hash suffix).
  The toolResult carries the authoritative names: `details:{server, tool, fullOutputPath?}`; `isError` = MCP `isError`.
- Exposure `codemode` is the **default**: the model calls `codemode {"code":"<js>"}`; MCP (and other) calls run inside
  via `ctx.executeTool()` and get **no messages of their own**. They are on the codemode toolResult:
  - `message.nestedCalls{complete, calls[{id:"<parent>/<n>", name, arguments | argumentsBytes, status:"ok"|"error"|"unfinished", durationMs?, error?}]}`
    (generic, any tool using `ctx.executeTool`; ≤ 256 calls; `complete:false` when arguments were dropped);
  - `details.calls[{id, name, args:"<json string>", status:"running"|"ok"|"error"|"cancelled", durationMs, cost?}]` (codemode's own).
  Nested results are not recorded. Nested usage is already summed into the toolResult `usage`.
- Resource tools `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` (`details.server`), `tool_search`
  (`details.loaded[]`). `role:"system"` messages may carry `sections.mcp_servers` and `toolsAdded/toolsRemoved`.

### pi-mcp-adapter (extension, 1.0 … 4.0; replaces native MCP when installed)
- Proxy tool `mcp` `{tool, args, server?, …}`; result `details{mode:"call"|"search"|"describe"|"list"|"status"|"connect"|…, server, tool}`.
- Direct tools `<server>_<tool>` (default prefix; also `short`, `none`, `mcp` = `mcp__<server>_<tool>`) — **name alone does not
  identify MCP**; result `details{server, tool}`.
- Per-server wrapper `mcp__<server>` `{tool, args}`; result details like the proxy.
- `mcpScript {code}` → `details{mode:"script", calls[{operation, path, ok, error?, durationMs}]}`.
- Errors: `details.error ∈ {tool_error, call_failed}`; adapters < 2.11 left `isError:false`.

### pi subagents (core pi has none; three npm packages, all in-process — no own pid, normal v3 JSONL with `usage.cost`)
| package | child file | header `parentSession` | parent call → child link |
|---|---|---|---|
| `pi-subagents` (nicobailon) | `<parentBase>/<runId>/run-<i>/session.jsonl`, fork-context runs `<parentBase>/forks/<ts>_<id>.jsonl` | none / parent path (forks) | parent toolResult `details.results[].sessionFile` |
| `@tintinweb/pi-subagents` | normal session dir `--<cwd>--/<ts>_<id>.jsonl` | parent **path** | child `session_info.name` = `<type>#<8 hex>` = prefix of parent toolResult (`toolName:"Agent"`) `details.agentId` |
| `@gotgenes/pi-subagents` | `<parentBase>/tasks/<ts>_<id>.jsonl` | parent **id** | not traced (in memory only) |

`<parentBase>` = parent session file path without `.jsonl`. The bundled *example* extension runs children with
`--no-session`: no child file, child usage only in the parent toolResult `details.results[].usage`.
Today: nicobailon/gotgenes children are invisible (scan is one level deep), tintinweb children show as top-level
sessions and steal the parent's live pid (cwd link picks the newest unparented session), example-extension child cost
is not counted. `parentSession` alone cannot tell a subagent from a `/fork` (pi sets it for both).

### OpenCode HTTP API (2.x service daemon)
- Discovery: `$XDG_STATE_HOME/opencode/service.json` (default `~/.local/state/opencode/service.json`) =
  `{id, version, url, pid, password}`, written 0600 by the daemon, removed on clean shutdown. Identity:
  `GET /api/info` → `{version, pid, …}`; trust only if `pid` = the file's pid. 404 = older 2.x → incompatible.
  **Never run `opencode api`/`opencode run` to probe** — they start the daemon.
- Auth: HTTP Basic `opencode:<password>`.
- `GET /api/session?limit=1000[&cursor=…]` (newest first by `time.updated`; `next` cursor is set even on the last page:
  stop on a short page) → `{id, parentID, location.directory, title, agent, time{created,updated,archived?}, fork?, cost, tokens}`.
- `GET /api/session/active` → `{"data":{"ses_…":{"type":"running"}}}` = busy set (runs owned by the daemon).
- `GET /api/session/:id/message?order=asc&limit=200` then `?cursor=<base64url {"id":<last id>,"order":"asc","direction":"next"}>`
  → messages, same JSON as `session_message.data` plus `id`, **without `seq`**; streaming assistant rows change in place
  (no `time.completed` yet).
- Not available over HTTP: message `seq`, `time.suspended`, full-text search (`search` = title only), 1.x sessions not
  migrated, `--standalone` servers. 1.x has no discoverable server → 1.x stays SQLite-only.
- Latency: list 3 ms, active 1 ms, 200 messages 6 ms (one request ≈ one `sqlite3` spawn).

## Design decisions (proposed)

1. **Content-keyed pi tool recording, no version gate.** All new paths in `pi.ts` trigger on content (`nestedCalls`,
   `details.server`, tool names `mcp`/`mcpScript`/`mcp__…`). Old pi sessions produce byte-identical Stats.
2. **One canonical MCP name**: `mcp__<server>__<tool>` from the toolResult's `details.{server,tool}` whenever present
   (native and adapter), so `mcpServer()` and the existing per-server grouping in Stats work unchanged. Stats count a call
   at its toolCall (as today) and **re-key** it on the result: new record primitive `retool(a, p, name)` moves the one
   count (tool total, hour histogram) from the pending call's tool row to `name` in the same day. Adapter proxy calls with
   `details.mode` ≠ `call` stay under `mcp` (gateway housekeeping: search, describe, status, connect, auth).
3. **Nested calls are real calls.** For a toolResult with `nestedCalls` (else codemode `details.calls`, else adapter
   `details{mode:"script"}.calls`) each nested call is recorded through the same helper as a top-level call (tool row,
   duration from `durationMs`, error from `status`/`error`, bash commands → shell programs, edit/write → lines + files),
   dated at the parent result's timestamp. The parent `codemode`/`mcpScript` row keeps counting as its own call.
   `status:"unfinished"`/`"running"`/`"cancelled"` count as a call without duration. Nested names go through the same MCP
   canonicalization (native nested names are already `mcp__s__t`).
4. **Adapter errors**: `details.error ∈ {tool_error, call_failed}` counts as an error even with `isError:false`.
5. **Transcript**: `toolArg` learns `code` (first line, codemode/mcpScript) and `tool` (adapter proxy: `server/tool`);
   after a result with nested calls, one compact `meta` line per nested call: `↳ mcp__github__search_code ok 412ms`
   (`[error] …` with the error text). `role:"system"` with `sections.mcp_servers` → one `meta` line `MCP: a, b, c`.
6. **pi subagent discovery**: `scan` also descends into `<parentBase>/` directories (only names that have a sibling
   `<name>.jsonl`): `tasks/*.jsonl` (gotgenes), `forks/*.jsonl` and `*/run-*/session.jsonl` (nicobailon). These get
   `parent` = the parent's id from the directory layout and their id from the header line (read once, cached by path;
   `session.jsonl` carries no id in its name). `kind` = `subagent`.
7. **tintinweb children** (same dir as the parent): `meta` reads the head (headBytes) only for files whose header has
   `parentSession`; a `session_info.name` matching `/^[^#\s]+#[0-9a-f]{8}$/` marks a subagent (`kind` = the part before `#`,
   `parent` = id from the `parentSession` path). Any other `parentSession` = a fork: stays top-level (it is what the user
   continues in, and must stay linkable to the live pid).
8. **spawnOf** (call graph): nicobailon → parent toolResult whose `details.results[].sessionFile` = child path;
   tintinweb → parent `Agent` toolResult whose `details.agentId` starts with the child's 8 hex. Found by one substring
   scan of the parent file, cached. gotgenes → `""` (not recorded).
9. **No double counting**: child files are counted as their own sessions; the parent's `details.results[].usage` is booked
   **only** when the result has no `sessionFile` (the example extension, `--no-session`). Booked as usage of the parent
   session at the result's timestamp, model from `results[].model`.
10. **Steering**: unchanged — `s`/`R` on a subagent already go to its owner (`owner()` in actions.ts).
11. **OpenCode transport: SQLite first, HTTP fallback.** SQLite stays primary (seq cursor, `time_suspended`, full-text
    search, 1.x). HTTP is used when `sqlite3` is missing or its queries fail, **and** `service.json` names a live daemon
    whose `/api/info` pid matches. Neither → today's warning (now: "OpenCode needs the sqlite3 CLI or a running
    `opencode service`"). Daemon down + no sqlite3 → sessions keep their last known rows for the run (no flicker), then
    the warning.
12. **HTTP via `curl`, synchronously**, like the `sqlite3` CLI (the `SessionSource` port is synchronous; `fetch` is
    async). Credentials go through stdin (`curl -sS --fail -K -` with `user = "opencode:<pw>"`), never argv or env.
    `--max-time 3`, response cap 64 MB. No curl → HTTP unavailable.
13. **HTTP cursor = index in the ascending message list** (no `seq`). Streaming rows: the readable end is held at the
    first assistant row without `time.completed` (or running shell/compaction) while the session is in the active set —
    the same hold rule as SQLite, computed from fetched rows. Messages are fetched incrementally from the last settled
    message id (client-built cursor) and cached per session; the list is re-fetched when `time.updated` changes.
14. **Cursor epochs**: `SessionSource` gains optional `epoch?: (s) => string` ("seq" for SQLite, "idx" for HTTP). The
    ledger stores it per session and **resets** that session's account (re-reads from 0) when it changes, and transcript
    readers reset their cursor — so switching transport (sqlite3 installed later) never mixes cursor meanings or
    double-counts.
15. **HTTP-mode capabilities**: busy = active set; `search` = title match (documented limitation); subagents via
    `parentID` + parent tool `subagent` `state.metadata.sessionID` (same parser as SQLite); usage = the same `usage()` on
    the same row JSON (`seq` replaced by the index). Send/resume unchanged (CLI).

## Testing
- Unit/contract checks with fixture lines (pi native direct, codemode with nestedCalls incl. an edit, a bash and an error,
  adapter proxy with `details.error:"tool_error"` + `isError:false`, adapter direct `srv_tool`, system message with
  `mcp_servers`; three subagent layouts; example-extension result with usage and no `sessionFile`).
- Old-pi regression: the existing pi fixtures produce identical `--json` Stats before/after.
- OpenCode HTTP: a check against a fake HTTP server (a tiny scriptc/Node server is not available at runtime → the check
  stubs curl via `AGENTGLASS_CURL` pointing at a script that serves fixture JSON per URL), plus a live run against the
  real daemon on a **copy** of the DB.
- Real-life runs (pi 0.99.2 with one local stdio MCP server, pi with `@tintinweb/pi-subagents` and `pi-subagents`,
  OpenCode 2.x without sqlite3 on PATH) through cliproxyapi, like the previous plan.

## Out of scope
pi-mcp-extension / @spences10/pi-mcp / other minor MCP extensions (their tools stay plain tools), MCP server connection
state (only in `~/.pi/agent/mcp.log`), nicobailon async/background runs whose session path is not traced, OpenCode 1.x
over HTTP, OpenCode SSE live updates (polling stays), Windows.

## Open questions
1. Upgrade the local pi from 0.87.1 to 0.99.2 for the real-life tests (npm global, `--ignore-scripts`)? Default: yes.
2. MCP server for the pi test: `@modelcontextprotocol/server-everything` (stdio, no network)? Default: yes.
3. Which subagent packages to install for the live test: tintinweb + nicobailon (default), gotgenes too?
4. For the OpenCode HTTP live test, hide `sqlite3` via `AGENTGLASS_SQLITE3=/nonexistent` (default) — no uninstall.
