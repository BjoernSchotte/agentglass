# OTLP export (OpenTelemetry GenAI traces) — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 3 (depends on parsing-fixes: turn
boundaries and remote scrub; filter-language: export selection).

## Goal
`agentglass export --otlp <url>` sends coding-agent sessions to any OTLP/HTTP backend (Jaeger, Grafana Tempo, SigNoz,
Honeycomb, the .NET Aspire dashboard, an OpenTelemetry Collector) as OpenTelemetry GenAI traces. History and
backfill work for every harness agentglass reads, and no hooks are needed. A later `agentglass --watch --otlp <url>`
streams turns as they complete. Re-running an export does not create duplicates. Content stays local unless the user
opts in.

## Why (user value)
- Users can look at agent work next to their other traces, keep it longer than the harness keeps transcripts (Gemini
  deletes them after 30 days), and use the backend's own querying and dashboards.
- agentglass already holds the full call tree, durations, errors, tokens and cost for seven harnesses, including
  history. A hook-based exporter only sees sessions that ran while it was installed, and it loses spans when the network
  is down. agentglass can export the past and resume after a failure.
- One standard shape (GenAI semantic conventions) instead of one format per harness: Claude Code and Codex each emit
  their own non-semconv OTel names, and the other harnesses emit nothing.

## Today (current code, with path:line refs)
- **Turns and spans exist, but only in the UI.** `sessionSpans` (`src/features/callgraph/model.ts:51-98`) segments
  events into turn, tool and subagent spans. A turn opens on a top-level `user` event (`:60-64`) or on Codex's
  `turn started` marker (`:65-69`). It closes on `turn complete` (`:70-75`), on the next turn, or at the end.
  `hostOf` (`:100-107`) hangs a subagent under its spawning call (`HarnessAdapter.spawnOf`, `src/harness/types.ts:54`).
  The tool error flag is a text heuristic (`isErr`, `:32-36`). Fx and Kiro carry no per-call timing, so their spans
  are laid out evenly and marked `est` (`spread`, `:41-49`; `buildGraph`, `:130-135`). The view loads only the last
  6 MB of each transcript (`src/features/callgraph/view.ts:30-38`).
- **Usage is per day, not per turn.** Adapters book every line into an `Acc` (`src/features/usage/record.ts:11-18`)
  through `tokens()`/`usageExact()` (`:103-113`). The ledger reads files in chunks (`src/features/usage/ledger.ts:27-56`).
  Inside agentglass, `in` always **excludes** cache reads and writes:
  - Claude passes Anthropic's figures, which are exclusive (`src/harness/claude.ts:108`).
  - Codex subtracts the cached part (`src/harness/codex.ts:133-142`).
  - Gemini books `input − cached + tool` and folds thoughts into `out` (`src/harness/gemini.ts:306`).
  - pi and OpenCode book the harness's own split and cost (`src/harness/pi.ts:152`, `src/harness/opencode.ts:333`).
    OpenCode folds reasoning into `out`.
  - Kiro has per-turn totals in a sidecar (`src/harness/kiro.ts:154-180`).
  - fx has only session running totals (`src/harness/fx.ts:96-116`).
- **Per-call truth lives in `done()`** (`src/features/usage/calls.ts:54`): duration, the error flag from the transcript
  (`is_error`, status, exit codes) and the call id. It feeds day aggregates and keeps no record per call. `mcpServer()`
  (`calls.ts:161`) splits `mcp__<server>__<tool>`. Codex already namespaces MCP calls this way (`codex.ts:109`), and pi
  renames them on the result (`retool`, `record.ts:68-80`).
- **CLI:** `H.cli` handlers run before the TUI (`src/main.ts:57`). `cli.ts` handles `--json` and `--watch`
  (`src/features/cli.ts:188-194`). `--watch` polls every 500 ms with a byte cursor per path (`cli.ts:133-186`).
  `update` registers with `unshift` so the generic `--json` handler cannot take its arguments (`src/features/update.ts:145`).
- **HTTP:** `getJson` (`src/util/http.ts:21-29`) is a synchronous Basic-auth GET through curl. Its URL and credentials
  go to curl on stdin with `-K -`, never in argv. It uses `--noproxy *`, a 3 s timeout, and `--fail`, which hides the
  status code. There is no POST, no header support and no status code.
- **Hashing:** agentglass has no SHA-256 in-process. `OS.sha256File` shells out to `sha256sum`/`shasum` for whole
  files (`src/platform/linux.ts:73`, `src/platform/darwin.ts:21`). Bit operations work in scriptc: the price cache
  uses FNV-1a with `Math.imul` and `>>>` (`src/features/usage/pricing.ts:36`).
- **Privacy:** `--redact` / `AGENTGLASS_REDACT` (`src/features/redact.ts:15-16`) fakes titles and cwd through `H.meta`
  and replaces event content through `H.events` (`:392-406`). `scrubText` (`:186`) masks emails, tokens and learned
  names.
- **Approval waits:** `approvalNote` (`src/features/watchdog.ts:73-83`) guesses them live: a call open for more than
  20 s while the process tree is quiet. No transcript records them.
- **Config:** `~/.agentglass/config.json` is read once at start (`src/util/config.ts:10-13`).

## Design

### 1. Trace shape
1. **One trace per turn.** The root span is `chat {gen_ai.request.model}` (kind `INTERNAL`). It runs from the turn's
   first event to its last event (or to `turn complete`).
   - All turns of a session share `gen_ai.conversation.id` = the root session id. agentglass does not create a session
     root span; a session is the set of its turns.
   - Children: `execute_tool {gen_ai.tool.name}` (kind `INTERNAL`) for each tool call.
   - A subagent becomes `invoke_agent {agent type}` (kind `INTERNAL`). Its parent is the spawning tool span (the
     `Agent`/`Task`/`spawn` call). The subagent's own tool calls are children of its `invoke_agent` span. A subagent's
     prompt does not open a turn (same rule as `model.ts:77-81`).
   - Spawn host resolution reuses `hostOf`. If no spawning call is found, the `invoke_agent` span hangs under the chat
     span.
   - Codex can reuse a subagent across turns. Its whole session hangs under the first spawning call; later reuses
     appear only as their own `execute_tool` spans (known limitation, open question 3).
2. **Semconv fit.** The semconv inference span stands for one model call. Here one `chat` span aggregates every model
   call of a turn: its usage attributes are the turn's sums. Transcripts do not record per-request boundaries for every
   harness, so this is the honest grain. The deviation is documented in the README.
3. **Shell refinement.** A shell tool call (`catOf` = shell, `model.ts:25`) is named
   `execute_tool {tool} {process.executable.name}`, for example `execute_tool Bash git`. The program comes from
   `program(norm(cmd))` (`calls.ts:81-83`). This follows the semconv command-execution refinement.
4. **Approval wait is never a child span.** A child `execute_tool` span would be counted as a tool. See 3.5.

### 2. Turn segmentation (shared with the call graph)
1. Extract the turn rules from `sessionSpans` into `src/features/callgraph/turns.ts`:
   `TurnCursor.feed(e: Ev): "open" | "close" | "none"`. It is a pure state machine. `sessionSpans` and the exporter
   both use it, so the call graph and the export always agree. The parsing-fixes spec changes what counts as a human
   prompt (task notifications, noise), and both consumers inherit that change automatically.
2. Rules per harness, as the adapters emit events today:

| Harness | Turn opens | Turn closes | Timing |
|---|---|---|---|
| claude | human `user` event (not `isMeta`, not a `tool_result` relay, not noise; slash command with args) | next opener / end | per line `timestamp` |
| codex | meta `turn started` (`codex.ts:60`); a following `user` fills the prompt | `turn complete` / `turn aborted` (`:61-62`) | per line |
| gemini | `user` event (functionResponse-only echoes are skipped by the adapter) | next opener / end | per message |
| pi | `user` event | next opener / end | per message |
| opencode | `user` event | meta `turn complete`/`turn aborted` from `idle` (`opencode.ts:308`) or next opener | per part |
| kiro | `user` (Prompt) | next opener / end | none in lines: turn end from sidecar `user_turn_metadatas[i].end_timestamp`, start = previous end; children `est` |
| fx | `user` | `turn complete · Ns` (`fx.ts:50`; start = end − N) | one timestamp per turn: children `est` |

3. **Completeness.** A turn is exported only when it is closed, and only once (3.4). A turn counts as closed when one
   of these holds:
   - a later turn opened;
   - a close marker was logged;
   - the session is not busy (`busy()`), none of its subagents is active (`subActive`), and the file has been quiet
     for 2 minutes (`--watch`) or 10 minutes (one-shot export).

   A session whose process is gone closes its last turn at once. A turn without a close marker whose process died gets
   status `ERROR` with `error.type = "interrupted"`.

### 3. Data model and attributes
1. **Exporter pass** (`src/features/otlp/build.ts`). For each selected session, its subagents are read **whole**
   through `sourceOf(h).lines` in 1 MB windows (not the 6 MB tail). Each record goes through two steps:
   - `parseEvents`, which feeds the `TurnCursor` and the span builder;
   - the adapter's `usage(a, line)` on one fresh `Acc` per session.

   After each line, the change in `a.inTok/outTok/cr/cw/cost/unk` and in the new `a.rs` (decision 3.2) is added to the
   current turn. The turn's model is the last model that booked tokens in it; the other models seen are kept for
   `gen_ai.response.model` (open question 4).
   - Kiro: the per-turn sidecar totals map by turn index.
   - fx: no per-turn usage. Turns carry no `gen_ai.usage.*`. The session total goes on the session's last exported
     turn as `agentglass.usage.session_total = true`, together with the totals.
2. **Small additions to the usage port:**
   - `Acc.rs`, the reasoning tokens (a subset of `out`), set by a new `reasoning(a, d, n)` helper. Called by Gemini
     (`thoughts`), OpenCode (`reasoning`) and Codex (`reasoning_output_tokens`, when present).
   - A call tap in `calls.ts`, `let tap: ((id, ms, err, codes) => void) | null`, invoked by `done()`. With it, the
     exporter takes each span's duration and error from the adapter's exact data and falls back to the `isErr`
     heuristic only when there is no tap record. Pi's `retool` reports the real MCP name through the same tap.
3. **Attributes.** Only OTel semantic-convention names (GenAI registry and the general registries). The few facts with
   no semconv home use the producer's own `agentglass.*` namespace (3.4). All conventions are *Development* stability;
   the exporter pins the semconv-genai revision it was written against in its file header.

| Span | Attribute | Value |
|---|---|---|
| all | `gen_ai.conversation.id` | root session id (subagent spans too) |
| all | `gen_ai.agent.name` | harness product name (`Claude Code`, `Codex`, `Gemini CLI`, `pi`, `OpenCode`, `Kiro`, `fx`); on `invoke_agent` and its tools: the subagent type (`s.kind`) |
| all | `gen_ai.provider.name` | from the record's provider id when the harness logs one (OpenCode/pi), else from the model prefix: `claude-`→`anthropic`, `gpt-`/`o<digit>`/`codex-`→`openai`, `gemini-`→`gcp.gemini`, `grok-`→`x_ai`, `deepseek-`→`deepseek`, `mistral-`/`codestral-`/`devstral-`→`mistral_ai`, `kimi-`→`moonshot_ai`; omitted if unknown |
| all | `process.working_directory` | session cwd (real, or faked under `--redact`) |
| all | `vcs.repository.url.full`, `vcs.repository.name`, `vcs.owner.name`, `vcs.provider.name`, `vcs.ref.head.name`, `vcs.ref.head.type` | from repo-view's project identity (no git process) and `s.branch`; the URL goes through the parsing-fixes `scrubRemote` and is dropped if the scrub drops it; all `vcs.*` omitted under `--redact` |
| chat, invoke_agent | `gen_ai.operation.name` | `chat` / `invoke_agent` |
| chat, invoke_agent | `gen_ai.request.model` | raw model id as logged |
| chat, invoke_agent | `gen_ai.usage.input_tokens` | see 3.6 |
| chat, invoke_agent | `gen_ai.usage.output_tokens` | `out` (reasoning included) |
| chat, invoke_agent | `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens` | `cr`, `cw` (omitted when 0 and the harness never reports them: Kiro) |
| chat, invoke_agent | `gen_ai.usage.reasoning.output_tokens` | `rs`, only when > 0 |
| chat | `gen_ai.conversation.compacted` | `true` only if a compaction/summary marker fell inside the turn |
| chat | `gen_ai.skill.name` | slash-command skill of the turn's prompt (parsing-fixes L6), when known |
| execute_tool | `gen_ai.operation.name` | `execute_tool` |
| execute_tool | `gen_ai.tool.name` | MCP: the tool part of `mcp__<server>__<tool>`; else the raw name |
| execute_tool | `gen_ai.tool.call.id` | call id when logged |
| execute_tool | `gen_ai.tool.type` | `function` (MCP: `extension`) |
| execute_tool | `mcp.method.name` | `tools/call` for MCP calls (one span per call, not a second MCP span) |
| execute_tool | `process.executable.name`, `process.exit.code` | shell calls: program; exit code when the adapter reports it (`codes` from the tap) |
| execute_tool | `gen_ai.skill.name` | `Skill` tool calls (model-chosen skills) |
| execute_tool, chat | `error.type` + status `ERROR` | `tool_error`, `rejected` (user denied), `cancelled`, `timeout`, `interrupted`; status description only with `--content` |
| chat, tool | `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | only with `--content` (3.7) |

4. **`agentglass.*` attributes** (no semconv equivalent; each can be renamed or dropped, 4.4):
   - `agentglass.session.id`: the subagent's own session id, on `invoke_agent`.
   - `agentglass.turn.index`: 1-based turn index on `chat`.
   - `agentglass.usage.cost`: USD list-equivalent or real spend.
   - `agentglass.usage.cost_basis`: the billing-mode label from honest-costs. Omitted when the cost is unknown
     (`unk > 0` and cost 0). It is never sent as 0.
   - `agentglass.mcp.server.name`: semconv has none. `server.address` is a network address, not a server's
     configured name.
   - `agentglass.timing.estimated = true` on spans whose position was spread (`est`).
   - `agentglass.tool.approval_wait`: seconds, double (3.5).
5. **Approval wait.** It is known only in live mode. When the watchdog raises `approval?` for a session (`watchdog.ts:149-152`),
   the exporter remembers the open call. When the note clears, it records an estimated wait (from the call start to
   the clear time) as `agentglass.tool.approval_wait` on that call's span, plus a span event `agentglass.approval_wait`
   with attribute `agentglass.estimated = true`. One-shot exports of history carry no approval data: the transcripts
   do not record it. A denial ("The user doesn't want to proceed", `isErr`) is `error.type = rejected` in both modes.
6. **Input-token semantics (explicit per provider).** The semconv says `gen_ai.usage.input_tokens` SHOULD include
   cached tokens, and that `cache_read`/`cache_write` are subsets of it. Providers report it differently:

| Provider / harness record | Raw `input` in the record | agentglass `in` (internal) | Exported `input_tokens` (default `inclusive`) |
|---|---|---|---|
| Anthropic (claude, pi, opencode on Anthropic) | excludes cache read and write | = raw | `in + cr + cw` |
| OpenAI (codex) | includes cached | raw − cached − cache write | `in + cr + cw` (= raw) |
| Gemini (gemini) | includes cached; `tool` tokens separate | raw − cached + tool | `in + cr` |
| OpenCode / pi on other providers | the harness's split (cache separate) | = raw | `in + cr + cw` |
| Kiro | `input_token_count`, no cache split | = raw | `in` |
| fx | snapshot `input_tokens`, cache separate (**unverified**) | = raw | `in + cr + cw` |

   - Config `otlp.inputTokens: "inclusive" | "provider"`. Default `inclusive`, the semconv rule for every provider.
   - `provider` emits what the provider's API reports: exclusive for `anthropic`, inclusive for every other provider.
     It is meant for backends that compute cost per provider from raw API semantics.
   - The resource attribute `agentglass.usage.input_tokens.semantics` (`inclusive`/`provider`) states the choice in
     every request.
7. **Content (default off).**
   - Off: no prompts, completions, tool arguments, tool results, titles or status descriptions.
   - Always sent: tool names, program names, MCP server names, model, counts, durations, cwd and VCS fields (each can
     be dropped, 4.4).
   - `--content` (or `otlp.content: true`) adds `gen_ai.input.messages` (the turn's prompt), `gen_ai.output.messages`
     (the final assistant text), `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Messages use the semconv
     JSON shape `[{"role":…,"parts":[{"type":"text","content":…}]}]`. Each value is truncated to `otlp.contentMax`
     (default 16 KB).
   - Under `--redact`, the export reads the same fake or scrubbed events and identity the screen shows (the
     `H.events`/`H.meta` hooks run inside `parseEvents`). Every string attribute passes `scrubText`, and `vcs.*` is
     dropped. `AGENTGLASS_REDACT_KEEP` keeps working.
8. **Resource** (one `ResourceSpans` per harness and harness version in a request):
   - `service.name`: `claude-code`, `codex`, `gemini-cli`, `pi`, `opencode`, `kiro-cli`, `fx`.
   - `service.version`: Claude lines carry `version`, Codex `session_meta` carries `cli_version`; omitted when unknown.
   - `os.type`.
   - `host.name`: only with `otlp.hostName: true`.
   - `agentglass.usage.input_tokens.semantics`.
   - Scope: name `agentglass`, version `BUILD.version`.

   No `user.*` attributes are sent. A user who wants them adds them as extra attributes (4.4).

### 4. Deterministic ids, idempotence and state
1. **Ids.** `H(x)` = SHA-256 of the UTF-8 string `"agentglass/otlp/v1|" + x`, written as hex.
   - Root key `R = h + "|" + rootSessionId`.
   - Turn key `T` = the turn's first event `ts` exactly as logged, plus `#k`, where k is the ordinal among turns that
     share that timestamp. Without a timestamp (Kiro), `T = "i" + turnIndex`. Timestamps survive Gemini rewinds and
     loading windows; indexes do not.
   - `traceId = H("s|" + R)[0:16] + H("t|" + R + "|" + T)[0:16]`. The first 8 bytes identify the session, so
     `agentglass open <trace-id>` (command-palette spec) can find the session by hashing only session ids.
   - `chat` span id: `H("c|" + R + "|" + T)[0:16]`.
   - Tool span id: `H("x|" + R + "|" + callerSessionId + "|" + callId)[0:16]`. A call without an id uses
     `"anon:" + T + ":" + ordinal`.
   - `invoke_agent` span id: `H("a|" + R + "|" + subSessionId)[0:16]`.
   - An all-zero id (invalid in OTLP) sets its last byte to 1.
   - The `v1` prefix is part of the contract. Changing the scheme needs a new prefix and a changelog entry.
2. **SHA-256 in pure TS** (`src/util/sha256.ts`, about 80 lines, FIPS 180-4 on a `number[]` of 32-bit words using
   `>>>`, `|`, `^`, `&`, additions wrapped with `>>> 0`). The input is UTF-8 encoded with `TextEncoder`.
   - Tested against the NIST vectors ("", "abc", the 448-bit message, one million "a"s) and against `OS.sha256File`
     on random files.
   - Measured cost target: < 20 µs per short id in the native build.
   - filter-language's `sha1(path)` cache names may reuse this module (`sha256(path)[:16]`) instead of adding a
     second hash.
3. **Export state (resumable cursor).** The file is `~/.agentglass/otlp/state-<H(endpoint)[0:16]>.json`, mode 0600,
   written atomically (tmp + rename):

   ```json
   {"v":1,"endpoint":"https://otel.example/v1/traces","sessions":{"<path>":{"h":"claude","id":"…","ep":"","turns":{"<T>":1}}}}
   ```

   - A turn is marked only after a 2xx response, or a partial success that does not reject its spans.
   - A later run skips marked turns, so re-runs send nothing twice. Deterministic ids also make a deliberate resend
     (`--resend`) land on the same trace and span ids. Whether the backend merges or duplicates them is the backend's
     business; the README lists which backends dedupe (open question 2).
   - A changed cursor epoch (`epochOf`) or a truncated file keeps the marks. The ids do not depend on offsets.
   - The endpoint key ignores the query string and userinfo.
4. **Lock.** `state-….lock` is created with `O_EXCL` and holds the pid. A live pid makes a second exporter to the same
   endpoint exit with code 3 ("another export to … is running, pid N"). A stale lock is taken over.

### 5. CLI
1. **`agentglass export --otlp <url> [opts]`**, registered with `H.cli.unshift` like `update`:
   - `--since <30m|24h|7d|YYYY-MM-DD|all>`: default `7d`; turns whose start falls inside. `--until` works the same way.
   - `--harness <id>`, `--session <id>` (repeatable), `--filter '<expr>'` (filter-language session clauses select
     sessions; call/day clauses are rejected with a message), `--subagents` (default on: subagents travel with their
     root session; `--no-subagents` drops them).
   - `--content`, `--resend`, `--dry-run` (print the OTLP/JSON requests to stdout, one per line, no network, no state
     change), `--batch <n>` (spans per request, default 512, max request body 4 MB).
   - Output: a summary on stderr: `exported 1234 spans in 87 turns from 12 sessions (3 requests)`. With `--json`, the
     summary is a JSON object on stdout.
   - Exit codes: 0 = all sent; 1 = some batches failed (state keeps the rest); 2 = usage error; 3 = locked.
   - The URL: if its path is empty or `/`, `/v1/traces` is appended (as for `OTEL_EXPORTER_OTLP_ENDPOINT`); otherwise
     it is used as is (as for `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`).
   - When `--otlp` is absent, the endpoint comes from config `otlp.endpoint`, then
     `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT`. With none of these the command exits 2.
     There is no implicit default endpoint.
2. **`agentglass --watch --otlp <url>`**: the `--watch` poll loop (`cli.ts:158-185`) gains an exporter sink.
   - Each session keeps a builder state: cursor, `TurnCursor`, `Acc` and the open turn.
   - Closed turns go to an in-memory queue. The queue is flushed every 5 s or at 512 spans.
   - On start it catches up on closed but unmarked turns since `--since`. The default is the start of the watch, so
     history is never sent implicitly.
   - JSONL event lines are printed only with `--jsonl`; a status line goes to stderr every 60 s.
   - SIGINT/SIGTERM flush the queue once (5 s budget), then exit.
3. `--help` gains both commands. The README gets a "Send to an OTLP backend" section with a Jaeger and an
   OpenTelemetry Collector example.

### 6. Transport
1. **`postJson`.** `src/util/http.ts` gains
   `postJson(url, headers: [string, string][], body: string, timeoutS): { status: number; body: string; err: string }`.
   - The curl config goes on stdin (`-K -`) and holds `url`, `header = "K: V"` lines, `request = "POST"`, `--data-binary`
     taken from a body file, and `write-out = "%{http_code}"`.
   - The body file is `~/.agentglass/tmp/otlp-<pid>-<n>.json`, mode 0600, deleted in `finally`. Stdin is taken by the
     config, and secrets never go into that file.
   - `-q` comes first, as in `getJson`. There is no `--fail`, so the status code is readable. The response body goes to
     stdout, capped at 64 KB.
   - Proxies are honored, because remote endpoints often need one. Loopback skips them (`noproxy` for `localhost`,
     `127.0.0.1`, `::1`).
   - `getJson` stays as it is.
2. **Retries.**
   - Retried: connection errors (curl exit 6, 7, 28, 35, 52, 56), 429, 502, 503, 504.
   - Backoff: 1 s, 2 s, 4 s (one-shot export, 3 attempts); up to 5 min (live mode, without limit while the queue fits).
   - `Retry-After` is honored, capped at 60 s.
   - Other 4xx responses fail the batch without retry. A 200 with `partialSuccess.rejectedSpans > 0` is reported as a
     warning, and the turns are marked (resending would be rejected again).
3. **Live queue limit.** The queue holds at most 10,000 spans. On overflow it drops the oldest *whole turns* and warns
   once. Dropped turns are not marked, so the next `export` resends them from the transcripts. This is the
   resumable-cursor design: the transcripts are the spool, so there is no second copy on disk. Limitation: a
   transcript deleted (trash, Gemini retention) before a successful send is lost.
4. **OTLP/JSON encoding** (the protobuf JSON mapping):
   - `traceId`/`spanId` are lowercase hex.
   - `kind: 1` (INTERNAL).
   - `startTimeUnixNano`/`endTimeUnixNano` are **decimal strings built as `String(ms) + "000000"`**. Epoch nanoseconds
     exceed 2^53, so a JS number would lose precision.
   - `intValue` is a string. Doubles are numbers.
   - Status `code: 2` (ERROR), plus `message` only with `--content`.
   - Each request is one `ExportTraceServiceRequest` with `Content-Type: application/json`. No gzip in v1 (open
     question 5).

### 7. Configuration (`~/.agentglass/config.json`, section `otlp`)
```json
{"otlp": {
  "endpoint": "https://otel.example.com",
  "headers": {"Authorization": "Bearer ${env:OTEL_TOKEN}", "X-Scope-OrgID": "me"},
  "headersFile": "~/.agentglass/otlp-headers",
  "content": false, "contentMax": 16384, "inputTokens": "inclusive", "hostName": false,
  "attributes": {"extra": {"deployment.environment.name": "laptop"}, "rename": {"agentglass.usage.cost": "my.cost"}, "drop": ["process.working_directory"]},
  "batch": 512, "timeoutSeconds": 10, "insecure": false
}}
```
1. **Header values.** `${env:NAME}` is expanded at send time. `headersFile` holds `Key: Value` lines; it is read only
   if it is owned by the user and not readable by group or others, and it is refused otherwise with a message.
   `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (`k=v,k=v`, URL-decoded) apply when the config
   has no headers.
2. **No header flag.** There is no CLI flag that takes a header value, so tokens never reach argv or shell history.
3. **Plain HTTP.** Headers are sent over `http://` to a non-loopback host only with `"insecure": true`. Otherwise the
   run exits 2 and names the host.
4. **Attribute tables.** `extra` attributes are added to every span. `rename` and `drop` apply last, to span and
   resource attributes alike. With these, a backend that expects other names can be served without agentglass naming
   any vendor.
5. **Errors.** A malformed `otlp` section gives one warning and falls back to defaults. A wrong type for a single key is
   ignored.

### 8. Failure modes
- No curl: exit 2 with "export needs curl (AGENTGLASS_CURL)".
- An unreadable or locked source (sqlite busy) skips that session with a warning; the rest is exported.
- A > 1 MB line is skipped like in the ledger. Its call loses its result and becomes an open span ended at the turn
  end with `error.type = "unknown"`.
- Clock skew between harness timestamps is not corrected. A child that starts before its parent extends the parent to
  cover it, so backends do not show orphans.
- An empty selection prints "nothing to export" and exits 0.

## Interactions with other specs
- **parsing-fixes:** turn boundaries (task notifications, `<`-prefixed prompts), slash-command skills, and
  `scrubRemote` for `vcs.repository.url.full`.
- **filter-language:** `--filter` session clauses select sessions for export and for live export.
- **repo-view:** project identity provides `vcs.*` without spawning git. `realCwd(s)` is not used: under `--redact`
  the export sends the fake cwd.
- **honest-costs:** the `agentglass.usage.cost_basis` label. Unpriced turns carry no cost attribute.
- **command-palette:** `agentglass open <trace-id|span-id>` resolves the deterministic ids of 4.1, and the
  `agentglass://` link form can be built from `gen_ai.conversation.id` and `gen_ai.tool.call.id`.
- **rules-config:** the approval-wait estimate comes from the watchdog. If rules-config changes its thresholds, the
  export follows.
- **cli-agent-mode:** `export --json` follows `--format`. Agent mode never starts a live export implicitly.

## Testing
- **Golden spans** (`src/features/otlp/otlp.check.ts`): fixed fixture sessions → `--dry-run` JSON compared
  byte-for-byte with `testdata/otlp/golden-<harness>.json`. Fixtures:
  - Claude with a subagent and an MCP call;
  - Codex with `turn aborted` and cumulative tokens;
  - Gemini with a rewind;
  - OpenCode SQLite rows;
  - Kiro sidecar turns;
  - fx `turn complete · Ns`.

  Timestamps are fixed, ids deterministic, and the output stable across runs.
- **Ids:** the same session exported twice gives identical ids. Appending a turn leaves earlier ids unchanged. A
  Gemini rewind that removes turn 3 leaves turns 1–2 and the replacement turn with distinct, stable ids. No id is
  all zeros.
- **SHA-256:** NIST vectors, plus a 1,000-file comparison with `sha256sum`.
- **Token semantics:** a table test per harness and mode (`inclusive`, `provider`) on fixture lines. The fixture
  totals equal the Stats totals for the same files.
- **Transport:** a local mock OTLP server (scriptc `node:http`, or `nc` in the check harness) checks:
  - headers arrive and argv holds no token (`/proc/<curl pid>/cmdline` captured during the request);
  - a 503, then 200 retry;
  - a 400 fails without retry;
  - partial success;
  - `Retry-After`;
  - an interrupted live run resumes without duplicates (state file);
  - the lock refuses a second exporter.
- **Privacy:** `--redact --content` output contains no learned names (scrub dictionary fixture), and without
  `--content` no `gen_ai.*.messages` or `tool.call.*` keys appear.
- **Real backends** (manual, before release): Jaeger all-in-one and an OpenTelemetry Collector with the debug
  exporter. Check the trace tree, the error status, and that a re-run adds no spans.

## Out of scope
- gRPC, protobuf encoding, OTLP metrics and logs. Backends derive token and duration metrics from spans.
- A local OTLP receiver.
- Per-request `chat` spans inside a turn (open question 1).
- `user.*` identity and team attributes.
- Windows.
- Exporting raw transcripts or files.

## Open questions
1. **Turn root.** Should a turn root be `invoke_agent {harness}` with one child `chat` span per API request (closer to
   semconv) once per-request records are available for every harness? Claude, Codex, Gemini and OpenCode log
   per-request usage; Kiro and fx do not. v1 keeps `chat` per turn as specified.
2. **Re-export.** Which backends dedupe re-sent spans with the same ids (Tempo, Jaeger with Badger/ES, SigNoz,
   Honeycomb)? This needs a test matrix before the README claims anything. Until then `--resend` is documented as
   "may duplicate".
3. **Reused Codex subagents.** Should a Codex subagent reused across turns get one `invoke_agent` span per hosting
   turn, splitting its events by the host turn's time window?
4. **Turns with several models.** `gen_ai.request.model` takes the last model. Should the turn instead be split into
   one `chat` span per model?
5. **gzip.** `curl --data-binary` cannot compress the body. Is compressing in TS (deflate in pure TS) worth it for
   large backfills?
6. **Claude approval status.** Does Claude's `~/.claude/sessions/<pid>.json` `status` take a value for "waiting for
   permission"? If it does, live approval waits become exact instead of estimated. Not verified.
7. **fx and Kiro token semantics.** Are fx's `input_tokens` exclusive of cache? Kiro has no cache split at all. Both
   need a real capture.
