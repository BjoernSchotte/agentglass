# MCP server — spec

Status: **implemented** (2026-10-08; open questions answered at the end), decisions made under the user's 2026-10-05 delegation (see "Decisions").
Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4). Builds on cli-agent-mode (contract 1),
agent-wait, filter-language, triage, session-compare, related-events, honest-costs, model-prices and fleet.

## Goal
Coding agents (Claude Code, Codex, Gemini CLI, OpenCode, pi, Kiro …) query agentglass as native MCP tools instead of
shelling out to the CLI:

- **`agentglass-mcp`**, a small stdio Model Context Protocol server, one per agent session. It answers 11 read-only
  tools: the calling session (`session current`), other sessions, errors, cost, triage, compare, related events,
  contention ("should I start my test run now?"), wait history, fleet hosts and unpriced models.
- **`agentglass mcp install`** prints (by default) or applies (`--write`, with consent) the registration for each
  installed harness. **`agentglass mcp doctor`** shows whether the server starts, which session it sees as "current",
  and how long a call takes.
- The same privacy as agent mode: the agent sees only its own project, `--redact` applies, and no transcript content
  (tool results, later prompts, assistant text) unless the user opts in.
- Idle cost near zero: the server holds no ledger. Each tool call runs one short `agentglass` CLI child.

## Why (user value)
- **Agents use tools they are given.** A shell command needs the agent to know that `agentglass` exists, its flags
  and its exit codes. Today that knowledge has to come from a `CLAUDE.md` paragraph. MCP tools come with names,
  descriptions and JSON schemas in every session, so the model finds `contention` before it starts `pnpm test`, and
  `session` when the user asks "what did this cost so far?".
- **The contention check pays off only when agents actually use it.** agent-wait measured heavy commands running ≥ 2
  at once for 12.6 h of 71 h in 30 days, with p50 1.4–2× slower when they overlapped. `agentglass wait --check` exists
  but is rarely called. An MCP tool whose description says "call before tests, builds, type checks" is.
- **Structured results, no parsing.** Hosts get `structuredContent` with an `outputSchema`, so there is no text
  scraping and no format guessing. The default fields are curated: 20 session rows are 5.1 KB instead of 324 KB
  (measured below).
- **Many agents at once.** The user runs up to 36 live agents on one host. An in-process server that loaded the
  ledger would hold ~110–140 MB per agent session, ≈ 4–5 GB in all. This design holds 0.13 MB of private memory per
  idle server (measured, see Today).

## Today (current code, measured)

### What exists
- **Agent mode** (`src/features/agentenv.ts`): `detectHost` (`:37`) turns agent mode on from env markers (`MARKERS`,
  `:17`) or `AGENTGLASS_AGENT=1`. `agentHost` (`:93`) walks the process tree when several harness markers are present
  (`:97`, nested agents). `currentFrom` (`:110`) resolves "current" from the env session id (`SESSION_VARS`, `:20`) and
  the process ancestry. `ancestry` (`:71`) walks `ppid` from the CLI's own pid (≤ 64 steps) to the first linked
  harness process. `scopeOf` (`:168`) sets the project scope from `process.cwd()`. `errLine` (`:141`) writes errors as
  one JSON line inside an agent.
- **CLI dispatch** (`src/main.ts:239`): `H.cli` handlers. Inside an agent, bare `agentglass` prints the compact help
  (`:246`). Without a TTY the TUI refuses to start (`:252`).
- **Query commands, contract 1** (`docs/cli-contract.md`): `session [<ref>]`, `sessions`, `errors`, `cost`, `wait`
  (`--now`, `--check`), `triage`, `compare`, `--json --related`, `fleet status`, `prices`. `<cmd> --help --format
  json` lists fields (`src/features/clihelp.ts`). The contract number is `CONTRACT = 1`
  (`src/features/version.ts:55`).
- **Tool shells vs MCP servers.** `toolShells` (`src/features/detect.ts:64-67`) counts only an agent's outermost
  descendant *shells* as tool commands; MCP servers are spawned directly and are skipped (`watchdog.check.ts:26-29`
  "cmds skip mcp"). `family.ts:330` never classes a process with `mcp` in its name as a check. Both rules matter here:
  `agentglass-mcp` and its children must never show up as an agent's running command, in `wait --now` or in the
  `long cmd` alarm.
- **An extra binary in the release** already exists: `agentglass-receive-tls` (`scripts/package.sh:14-17`,
  `install.sh:73-75`, `scripts/formula.sh:56-62`, `src/features/update.ts:166-180`). It is optional per target.
- **No MCP code.** cli-agent-mode listed "an MCP server mode" as out of scope.

### Measured on this host (2026-10-08, Linux 6.17, 32 cores, `main` @ 887a2a5 / 2026.10.10, release build, isolated `AGENTGLASS_*` paths, a copy of the real ledger cache, niced)

**scriptc 0.1.7 stdio** (probes under `~/.cache/agentglass-agents/spec-mcp/probe/`):

| probe | result |
|---|---|
| `process.stdin.on("data")` on a pipe, a JSON line split across two writes 300 ms apart | reassembled; `"end"` fires on EOF |
| a UTF-8 character split across two reads, decoded per chunk | **corrupted** (`��`). Byte-level framing (split on `0x0A`, decode whole lines) is correct: `aüb` |
| 5,000 requests in one burst | all framed, 16 ms |
| `writeSync(1, …)` of a 2 MB response to a reader that sleeps 1 s first | all 2,000,043 bytes, no `EAGAIN` |
| `spawn` with piped stdout/stderr, child writes 3 MB then exits 3 | `"close"` fires after all data and stderr (`"exit"` can come first: use `"close"`) |
| `ch.kill()` 100 ms after spawning `sleep 30` | exit after 100 ms (cancellation works) |
| two calls in flight; the second finishes first | both answered, out of order |
| idle probe, stdin open, 30 s | RSS 1.7 MB, **Private_Dirty 128 KB**, 1 thread, 0 CPU ticks |
| the full agentglass binary (every module imported), idle on stdin, 60 s | RSS 11.4 MB, **Private_Dirty 5.3 MB**, 0 CPU ticks |

**CLI calls a tool would make** (warm cache, wall / peak RSS of the child):

| command | wall | peak RSS |
|---|---|---|
| `--version --json` | 0.02 s | 9.7 MB |
| `sessions --since 24h --limit 10` (agent mode) | 0.66 s | 107 MB |
| `session last` | 0.65 s | 110 MB |
| `errors --since 24h --limit 5` | 0.79 s | 123 MB |
| `cost` (first / warm) | 3.22 s / 0.69–1.17 s | 142–146 MB |
| `cost --since 7d --by model` | 0.57 s | 107 MB |
| `triage --preset errors` | 0.98 s | 118 MB |
| `wait --now --json` / `wait --check` | 0.80 s / 0.48 s | 134 / 108 MB |
| `prices --unpriced` | 1.97 s | 115 MB |

Every call scans the session index (3,356 sessions) and the process table (~2,300 processes): ~0.5 s and ~108 MB
is the floor, also for `wait --now`, which reads no history.

**Output sizes** (bytes of compact JSON, the largest session on this host):

| output | bytes |
|---|---|
| `--json --limit 20`, all fields | 324,020 |
| `sessions --limit 20`, 10 curated fields | 5,138 |
| `session <id>`, all fields | 118,074 (`git` 84,584, `subagents` 29,083) |
| `session <id>`, curated (no `git`, `subagents`, `path`, `mux`) | 11,270 |
| `--json --related last --minutes 5` | 23,506 |
| `errors --since 24h --limit 20` / `wait --json` / `triage --preset errors --json` | 6,545 / 9,610 / 3,245 |
| full `--help --format json` | 36,873 |

**MCP hosts, observed with a spy server** (it logs env, the process chain and the JSON-RPC traffic; isolated
`HOME`, no model call, no user session):

| host | how run | protocol requested | client capabilities | server env | server's parent |
|---|---|---|---|---|---|
| Gemini CLI 0.63.0 | `gemini mcp list` (needs a trusted folder) | `2025-06-18` | `{}`; sends `ping` right after `initialized` | full env: `GEMINI_CLI=1` **plus the outer agent's** `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `AI_AGENT` | the `node … gemini` process; cwd = project |
| pi 0.99.2 | `pi mcp list --json` | `2025-11-25` | `{"roots":{}}` | full env: `PI_CODING_AGENT=true`, `AI_AGENT=pi`, outer `CLAUDECODE` …; no `PI_SESSION_ID` | the `pi` process; cwd = project |
| OpenCode 2.0.19 | `opencode mcp list` | — | — | — | printed nothing without a TTY and hung under a PTY (open question 3) |
| Kiro CLI 2.25.0 | `kiro-cli mcp status` | — | — | — | needs a login: not run |
| Claude Code, Codex | — | — | — | — | not run: the user's own installs; never used for tests |

So **the env is not a reliable identity**: a nested host passes on the *outer* agent's session id. The process tree
is reliable: the server's parent is the harness process. This is the same ancestry `currentFrom` already walks.

## Design

### 1. Architecture: a thin server, one CLI child per call
```
agent host (claude, codex, gemini, pi, opencode, kiro)
  └─ agentglass-mcp            stdio JSON-RPC; no ledger, no scan; ~0.13 MB private when idle
       └─ agentglass <cmd> --format json …   one per tools/call (≤ 2 at once); ends with the call
```
1. **`agentglass-mcp` is its own small binary** (`src/mcp/main.ts`), built by `build.sh` next to `agentglass` and
   shipped in the same archive (Decision 2). It imports only `src/mcp/*`, `src/util/json.ts` and
   `src/build-info.ts`, and no feature module, so module init stays at the probe's size.
2. **Every `tools/call` runs one `agentglass` child** with a fixed argv built from the validated arguments (§4). The
   output is the CLI's contract-1 JSON, shaped (§5) and returned. The CLI stays the only implementation of every
   query: there is no second code path whose numbers could drift.
3. **The child binary** is `$AGENTGLASS_MCP_BIN` when set (tests), else `agentglass` next to the server's own
   `process.execPath`. At the first call the server checks `agentglass --version --json` once: `contract >= 1`, else
   every call fails with `{"code":"contract", "hint":"agentglass update"}`. The result is cached for the server's
   life.
4. **No idle work and no idle exit.** No timer runs while no call is in flight. The server never exits on idle:
   Claude Code, Gemini and pi do not restart a stdio server that exited, so its tools would vanish until the user
   reconnects. There is nothing to free, because the server holds no data (Decision 7).

### 2. Transport and framing (stdio)
1. **Framing:** newline-delimited JSON-RPC 2.0, UTF-8. Bytes are buffered and split on `0x0A`; only whole lines are
   decoded (the probe showed that per-chunk decoding corrupts split characters). Empty lines are ignored. A line over
   **4 MiB** is dropped up to its newline and answered with `-32600` and `id: null`.
2. **Output:** only JSON-RPC messages go to stdout, one per line, through one `send()` that loops `writeSync` until
   every byte is written (EAGAIN-safe, although the probe saw none). Diagnostics go to stderr (hosts keep it in their
   MCP logs) only with `--log` or `AGENTGLASS_MCP_LOG=1`; by default the server writes nothing to stderr.
3. **Shutdown:** on stdin `end`, `SIGTERM` or `SIGINT`, the server kills the children in flight (SIGTERM, then
   SIGKILL after 1 s) and exits 0. A closed stdout (EPIPE) ends it the same way.
4. **Streamable HTTP is out of scope** (Decision 3).

### 3. Protocol
1. **Versions:** `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. `initialize` answers with the client's
   `protocolVersion` when it is in that list, else `2025-11-25` (the client then decides whether to disconnect).
2. **`initialize` result:**
   ```json
   {"protocolVersion":"…","capabilities":{"tools":{"listChanged":false}},
    "serverInfo":{"name":"agentglass","title":"agentglass","version":"2026.10.x"},
    "instructions":"…",
    "_meta":{"agentglass/contract":1}}
   ```
   `instructions` (≤ 600 characters) gives the model the basics:
   > agentglass reads the coding-agent sessions on this machine (Claude Code, Codex, Gemini CLI, pi, OpenCode, Kiro,
   > fx). `session` with no ref is the session calling these tools. You see this project only (<scope>). Call
   > `contention` before a test run, build, type check or install. Results are JSON; lists page with `cursor`.

   `<scope>` is `project` or `all projects` (§6). Under `--redact` the project name is never named.
3. **Methods:**
   - `initialize`, `ping` (also before `initialize`), `tools/list` (no pagination: 11 tools), `tools/call`.
   - Notifications: `notifications/initialized` and `notifications/cancelled` (§3.5).
   - Anything else: `-32601`. A request before `initialize` other than `ping` gets `-32600`.
4. **Version-dependent output.**
   - From `2025-06-18` on: `outputSchema` per tool and `structuredContent` per result, plus the same JSON as one text
     block (the spec's backwards-compatibility rule).
   - Before `2025-06-18`: the text block only.
   - `title` and `annotations` (`readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`) on every
     tool from `2025-03-26` on.
   - JSON-RPC batches (a line that is a JSON array) only under `2025-03-26`; otherwise `-32600`.
5. **Cancellation:** `notifications/cancelled {requestId}` kills that call's child (or drops it from the queue). No
   response is sent for it. An unknown or finished id is ignored.
6. **Progress:** when `tools/call` carries `_meta.progressToken`, the server sends
   `notifications/progress {progressToken, progress: <seconds elapsed>, message: "agentglass <cmd>"}` every 2 s while
   the child runs. There is no `total`. The heartbeat keeps hosts that reset their timeout on progress from giving up
   during a slow first call (cold cache).
7. **Errors.**
   - An unknown tool name → JSON-RPC `-32602`.
   - Invalid arguments → a tool result with `isError: true` and the message, so the model can correct itself (the
     `2025-11-25` rule).
   - A child exit 2/3/4 → a tool result with `isError: true`, carrying the child's stderr JSON line `{"error":{code,
     message,hint}}` as both text and `structuredContent`.
   - Timeout, busy or a missing binary → `isError: true` with codes `timeout`, `busy`, `no_cli`, `contract`.
8. **Not offered:** resources, prompts, sampling, elicitation, logging, completions, `listChanged` (Decision 5).

### 4. Tools
All tools are read-only. Each row: name · what it answers · input (JSON Schema properties; none is required unless
marked) · the CLI child · default fields. A `fields` input takes any field the CLI command lists (`<cmd> --help
--format json`) as an enum. `limit` and `cursor` page list tools (§5.2).

| tool | answers | input | child argv (always + `--format json`; `--fields` from `fields` or the default) | default fields |
|---|---|---|---|---|
| `session` | one session: cost, tokens, models, tools, errors, files, repeats | `ref` (default `current`; `current`, `last`, `parent`, an id, a ≥ 6-char prefix, `harness:id`), `root` bool, `fields` | `session <ref> [--root]` | `id harness title cwd live status updated costUsd costBasis tokens turns wallMs activeMs models tools errors files repeats attention stuck alerts` |
| `sessions` | sessions, newest first | `since` (`24h` default, `Nh`/`Nd`), `live` bool, `harness` enum, `filter` (filter language), `limit` 1–100 (20), `cursor`, `fields` | `sessions --since S [--live] [--harness H] [--filter=F] --limit offset+limit+1` | `id harness title project updated live status costUsd attention stuck` |
| `errors` | failed tool calls, newest first | `ref`, `since` (`24h`), `filter`, `limit` 1–100 (20), `cursor` | `errors [<ref>] --since S [--filter=F] --limit offset+limit+1` | `ts harness session tool arg durationMs` (+ `text` with `--content`) |
| `cost` | spend today / 7 d / month and budget; or rows by a key | `since` (`today`/`7d`/`30d`/`YYYY-MM-DD`), `by` enum `day model harness project session`, `filter` | `cost` / `cost --since S --by B [--filter=F]` | all (small) |
| `triage` | what is different about a selection (errors, slow, expensive …) | `preset` enum, `select`, `baseline` enum, `entity` enum, `days` 1–90, `limit` 1–50 (10) | `triage --json …` | all |
| `compare` | A vs B: two sessions, or two filter groups | `sessions` [ref, ref] **or** `a` + `b` (filter expressions); `filter`, `subagents` bool (true) | `compare <r1> <r2> --json` / `compare --a=A --b=B --json [--no-subagents]` | all, arrays capped (§5.3) |
| `related` | what happened ±N min around an event, all agents of the project, conflicts flagged | `ref` (`current`), `event` (tool call id), `at` (ISO time), `minutes` 1–60 (10), `limit` 1–200 (50), `cursor` | `--json --related <ref> [--event E] [--at T] --minutes M` | `anchor project from to more capped sessions events` |
| `contention` | should I start a heavy command now? | `kind` enum `test typecheck lint build install ci`, `family` (e.g. `pnpm test`), `max` 1–32 | `wait --check --json [--kind K \| --family F] [--max N]` | shaped: `{go, heavyRunning, max, running[≤10], load1, cpus, memAvailPct, advice}` |
| `waits` | what agents wait on: time per command family/kind/tool | `since` (`7d`), `by` enum `family kind tool`, `filter`, `limit` 1–50 (15) | `wait --json --since S --by B [--filter=F] --limit N` | `rows[key kind heavy calls totalMs share p50Ms p95Ms errors trend peak]`, `agentTime`, `period`, `guard` |
| `fleet` | the fleet's hosts: reachable, stale, last pull | — | `fleet status --json` (never `--refresh`: no SSH from a tool call) | hosts as printed; no hosts configured → `{hosts: [], configured: false}` (exit 2 `usage` mapped, not an error) |
| `prices` | models without a price (why a cost is null) | `unpriced` bool (true), `model` (exact name) | `prices --json [--unpriced]` | `models[model source price unpricedTokens estimated]` |

Details:
1. **`session` with no `ref` is the caller** ("current", §7). `ref: "last"` is the newest other session in this
   project.
2. **`contention`** turns `wait --check`'s exit code into data: `go = !check.over` (exit 3 is not an error here).
   `advice` is one sentence, e.g. `"3 heavy commands running (pnpm test ×2, tsc): wait or run a subset"` or
   `"0 heavy commands running: go"`. `running` keeps the 10 oldest heavy ones first, then others, each `{session,
   harness, family, kind, heavy, ageSec, rssMb}`. It is host-wide, as `wait --now` is in the CLI (contract 1:
   `scope.now = "host"`): machine resources are shared across projects. Family names only, never command lines.
3. **Descriptions** are ≤ 200 characters each and say when to call the tool, e.g. `contention`: "Before running
   tests, builds, type checks, lint or installs: are other agents on this machine already running heavy commands?
   Returns go=false with what is running." The whole `tools/list` result is ≤ 9 KB (≈ 2.3k tokens; a test pins it).
4. **Argument safety:** every value is checked against its schema (type, enum, range, `^[A-Za-z0-9:._-]{1,128}$` for
   refs and ids, ≤ 512 characters for filter expressions, no leading `-`). Values are passed as `--flag=value` or as
   positional refs, never through a shell. The child's argv is built only from these values.
5. **Write tools: none** (Decision 4). `prices set`, sending a prompt to another agent and acknowledging alerts stay
   CLI and TUI actions.

### 5. Shaping results
1. **Envelope.** List tools return `{rows: […], next: "<cursor>"|null, truncated: bool, scope: "project"|"all"}`.
   Object tools return the CLI object plus `scope`. `structuredContent` must be an object, so bare CLI arrays are
   always wrapped.
2. **Pagination.** `cursor` is opaque: `base64url("o:<offset>")`. The server asks the child for `offset + limit + 1`
   rows and returns rows `[offset, offset + limit)`. `next` is set when one more row existed. The CLI has no offset,
   so later pages cost a longer child run; `limit` ≤ 100 bounds it.
3. **Size cap.** The text block is at most `--max-bytes` (default **24,000**, range 4,000–200,000; ≈ 6k tokens, below
   Claude Code's 10k-token warning).
   - List tools drop rows from the end until the result fits, then set `truncated: true` and `next`.
   - Object tools trim their longest array fields (`files`, `tools`, `errors`, `repeats`, `events`, `programs`,
     `models`) from the end, and set `truncated: ["files", …]`.
   - A single row over the cap is replaced by `{id, truncated: true}`.
4. **Content stripping** (§8) runs before the size cap.
5. **Numbers and nulls** pass through unchanged: unpriced stays `null`, never `0` (honest-costs).

### 6. Scope and options
1. **Agent mode in every child:** the child env is the server's env plus `AGENTGLASS_AGENT=1` and `NO_COLOR=1`. Some
   hosts (Codex, open question 2) start MCP servers with a filtered env and no harness marker, so agent mode must not
   depend on those markers.
2. **Project scope by default**, exactly as in the CLI (cli-agent-mode 3.6). The child's `agentScope` uses its cwd,
   which is the server's cwd: Gemini and pi start servers in the project directory (observed). If the server's cwd is
   `$HOME` or `/` (a host that starts servers there), the server resolves the calling session's cwd once, at the
   first call, with `agentglass session current --all-projects --fields cwd` (`--all-projects` because the session is not
   in `$HOME`'s scope; only `cwd` is read, and it never reaches the agent). That becomes the children's cwd. If it cannot be
   resolved, project-scoped calls fail with code `no_project` and the hint "start the server in the project or
   register it with --all-projects".
3. **Server options** go in the registered command line. The user writes them, or approves them in `mcp install`,
   so the consent is explicit:

   | option | effect |
   |---|---|
   | `--all-projects` | children get `--all-projects` (config `agent.scope: "all"` has the same effect, as in the CLI) |
   | `--content` | keep the content fields (§8) |
   | `--redact` | children get `--redact`; `AGENTGLASS_REDACT=1` in the host's env also works (inherited) |
   | `--max-bytes N` | the size cap (§5.3) |
   | `--timeout S` | per-call child timeout, 5–600 s, default **50** (Codex's MCP `tool_timeout_sec` default is 60) |
   | `--log` | diagnostics to stderr |
   | `--version`, `--help` | print and exit (no server) |

   An unknown option makes the server exit 2 at start with one stderr line. The host then shows the failure and that
   line.
4. **Concurrency:** at most **2 children** in flight per server and 8 queued, FIFO; beyond that a call fails at once
   with `busy`. Each child costs ~0.5–1 s and ~110–145 MB while it runs (measured). The cap keeps one chatty agent
   from multiplying that.

### 7. Identity: "current"
1. The server does nothing itself. The child resolves `session current` as the CLI does (`currentFrom`,
   `agentenv.ts:110`). Its ancestry starts at its own pid, passes `agentglass-mcp` (no harness) and reaches the
   harness process, which the server's parent is. The same walk works for a shell command, one level deeper.
2. **The env session id is dropped** for children: the server removes `SESSION_VARS` (`CLAUDE_CODE_SESSION_ID`,
   `OPENCODE_SESSION_ID`, `CODEX_THREAD_ID`, `KIRO_SESSION_ID`, `PI_SESSION_ID`). There are two reasons:
   - A nested host passes on the outer agent's id (observed under Gemini and pi).
   - The server lives as long as the host process. After `/clear` or `/resume` the host is on another session, while
     an id captured at server start would still name the old one.

   The process link follows the live registry and open transcript, so it moves with the host.
3. **Fallback:** if the child answers `no_current_session` (exit 3) and the server's env had a session variable, the
   server retries once with the variables kept. This covers sandboxes without `ps`, where the CLI uses env ids only
   (cli-agent-mode §5).
4. Result: the `session` tool's output carries `via` (`ancestor:pid N`, `env:<VAR>`), so `doctor` and the user can
   see how the caller was found. This is an additive field in the CLI's `session` output.

### 8. Privacy
1. **Content is off by default.** Content means tool results, prompts after the first, assistant text, thinking and
   subagent task prompts. Without `--content` the server strips these paths after parsing:

   | tool | stripped |
   |---|---|
   | `errors` | `rows[].text` (not requested: `--fields` omits it) |
   | `session` | `errors[].text` |
   | `related` | `events[].text` where `kind` is `prompt` or `agent` |
   | `compare`, `triage` | none (aggregates only); a canary test proves it |

   **Kept:** titles (the first prompt, already in contract 1 and needed to tell sessions apart; faked under
   `--redact`), tool names, command lines and file paths of tool calls (`arg`, related `shell`/`read`/`write`
   events). These are activity metadata the CLI already returns in agent mode (Decision 6).
2. **Scope:** as in agent mode (§6.2). `contention` is host-wide (family names, session ids, harness, age, RSS).
3. **`--redact`** applies in every child. `instructions` never names the project under redact.
4. **Never offered:** transcripts as resources, raw files, or anything from other hosts beyond `fleet status`'s host
   list. Fleet session rows are not scoped by project, so the `fleet` tool does not return them.
5. Output goes to the agent's model provider, as CLI output in agent mode does. The README's MCP section says so.

### 9. `agentglass mcp` (in the main binary)
```
agentglass mcp install [--harness claude|codex|gemini|pi|kiro|opencode|all] [--write] [--yes]
                       [--scope user|project] [--all-projects] [--content] [--redact]
agentglass mcp doctor [--json]
agentglass mcp                  # no subcommand: what agentglass-mcp is and how to install it (exit 0)
```
1. **`install` prints by default.** For each harness found on `PATH` (or each one named in `--harness`; `all` = every
   one), it prints a heading and the exact command or snippet:

   | harness | registration printed (`<cmd>` = `agentglass-mcp` + options) | `--write` runs |
   |---|---|---|
   | Claude Code | `claude mcp add --scope user agentglass -- <cmd>` | that command |
   | Codex | `codex mcp add agentglass -- <cmd>` and the `config.toml` table `[mcp_servers.agentglass]` `command`, `args` | that command |
   | Gemini CLI | `gemini mcp add --scope user agentglass <cmd>` | that command |
   | pi | `pi mcp add agentglass -- <cmd>` | that command |
   | Kiro CLI | `kiro-cli mcp add --name agentglass --scope global --command agentglass-mcp [--args …]` | that command |
   | OpenCode | the `opencode.json` snippet `"mcp": {"agentglass": {"type": "local", "command": ["agentglass-mcp", …], "enabled": true}}` and the file path (`~/.config/opencode/opencode.json`) | nothing: print only (Decision 8) |

   `--scope project` uses each harness's project scope (`--scope project` / `--scope local`; pi `--local`; Kiro
   `workspace`). `<cmd>` is the bare `agentglass-mcp` when `command -v agentglass-mcp` resolves to the binary beside
   this `agentglass`, else its absolute path.
2. **`--write`** runs the printed harness command (argv, no shell) for each selected harness that has one.
   - It asks `y/N` per harness on a TTY.
   - Without a TTY or inside an agent it needs `--yes` and refuses with exit 2 otherwise, as `update` does
     (cli-agent-mode §1.5).
   - It reports each command's exit code, and agentglass never edits a harness config file itself.
   - If `agentglass-mcp` is missing next to the binary (a hand-copied binary), it fails with exit 1 and the hint
     `./build.sh builds both; install.sh and brew install both`.
3. **`doctor`** starts `agentglass-mcp` as its MCP host would, from this shell. It sends `initialize`, `tools/list`
   and `tools/call session {}`, then prints:
   - binary paths and versions, and the contract;
   - the negotiated protocol;
   - the tool count and the `tools/list` bytes;
   - the "current" result with `via` (inside an agent shell this is that agent's session; in a plain terminal,
     `no_current_session` is expected and said so);
   - the call's wall time;
   - the scope.

   `--json` prints the same as one object. Exit 0 when the server answered all three, 1 otherwise.
4. **Bare `agentglass mcp`** prints a short text (JSON in agent mode): what the server is, `agentglass mcp install`,
   and `agentglass mcp doctor`. If stdin is not a TTY and no agent marker is set (a host misconfigured to run
   `agentglass mcp` as the server), it writes one stderr line, "the MCP server is agentglass-mcp: run agentglass mcp
   install", and exits 2, so the host shows a clear error rather than a hang.
5. Help records (`addCmd`) for `mcp`, `mcp install` and `mcp doctor`. Not in the compact agent help: agents in shells
   should not register servers on their own. The README gets an "MCP server" section.

### 10. Contract
1. **One contract number for the CLI and MCP** (Decision 9). `docs/cli-contract.md` gets a section "MCP server
   (`agentglass-mcp`)" that lists:
   - tool names, input property names, types and enums;
   - the envelope (§5.1);
   - error codes (`timeout`, `busy`, `no_cli`, `contract`, `no_project`, plus the CLI's own);
   - `_meta["agentglass/contract"]`.

   Additive (keeps N): a new tool, input property, output field or enum value. Breaking (bumps N): a tool or input
   renamed or removed, a type or meaning changed, a default that widens what is returned (scope, content).
2. **Goldens:** `testdata/mcp/tools-2025-11-25.json` (with `outputSchema`, `title`, `annotations`) and
   `testdata/mcp/tools-2024-11-05.json` (without them) are the exact `tools/list` results. A golden changes only
   together with the contract doc, and a breaking change also bumps `CONTRACT`.
3. Every `outputSchema` property is a field the CLI command lists in `--help --format json` (or a documented shaped
   field such as `go`, `advice`, `next`). A check enforces it, so the MCP schema cannot drift from the CLI.

### 11. Packaging
- `build.sh` builds `agentglass-mcp` after `agentglass` (same flags, `AGENTGLASS_MCP_OUT` default `agentglass-mcp`
  beside `AGENTGLASS_OUT`).
- `scripts/package.sh` requires it and checks `--version` equality.
- `install.sh` and `scripts/formula.sh` install it beside `agentglass`.
- `agentglass update` replaces it together with `agentglass`: the same archive, renamed after `agentglass`. A
  missing one is reported as `partial`, as for `agentglass-receive-tls`.
- Unlike `agentglass-receive-tls` it is not optional: it uses the default backend, so it builds wherever
  `agentglass` builds (macOS x64 `--backend c` included: no `Record<string, RegExp>`, no TLS).

## Failure modes
- **Cold ledger cache:** the first child indexes all history, which takes minutes and up to ~875 MB (tui-footprint,
  cold full index).
  - The call times out at `--timeout` (50 s), and the error hint says "agentglass is indexing history for the first
    time: run `agentglass` once, then retry".
  - Progress heartbeats keep hosts that honour them waiting until then.
  - Whether a killed child keeps its partial index is open question 4.
- **Many agents call at once:** each child costs ~110–145 MB for ~0.5–1 s. Ten simultaneous `contention` calls
  peak at ~1.3 GB for a second. The per-server cap is 2. There is no machine-wide cap in v1 (Decision 10).
- **The harness process is not linked to a session yet** (no prompt sent): `session` → `no_current_session`, hint
  "session not written yet". `sessions`, `cost` and other tools work.
- **`ps`/`/proc` unavailable** (sandboxed MCP server): the env-id retry (§7.3). Otherwise `no_current_session`.
- **`agentglass` replaced while the server runs** (`update`): the next child is the new binary. The contract check is
  cached per binary path + mtime and re-runs on change.
- **Host sends garbage / huge lines / requests before `initialize`:** handled by §2.1 and §3.3; the server never
  crashes on input (fuzz check).
- **stdout closed by the host:** EPIPE → kill children, exit 0.
- **Clients that send `2024-11-05` and parse strictly:** they get no `outputSchema` or `structuredContent` (§3.4).
- **An unknown CLI field asked in `fields`:** rejected by the enum before spawning.
- **`fleet status` without hosts:** `{hosts: [], configured: false}`, not an error.

## Interactions with other specs
- **cli-agent-mode:** the server is a client of contract 1. It adds `via` to `session` output (additive). Agent mode
  is forced in children (`AGENTGLASS_AGENT=1`).
- **agent-wait:** `contention` = `wait --check`, `waits` = `wait --json`. `agentglass-mcp` and its children must stay
  out of `toolShells` and `wait --now` (regression fixture, plan T7).
- **filter-language:** `filter`, `select`, `a`/`b` are filter expressions, validated by the child (a bad one → exit 2
  → `isError` with the parser's message and hint).
- **related-events, triage, session-compare, honest-costs, model-prices, fleet:** read through their CLI JSON, no
  change.
- **tui-footprint:** no TUI change; footprint budget in Testing.
- **release-management:** a second binary in every archive and formula (§11).

## Testing
- **`src/mcp/rpc.check.ts`** (pure):
  - framing: split lines, split UTF-8, CRLF tolerated, empty lines, oversize line → `-32600` and the next line still
    parsed;
  - version negotiation for each listed version plus an unknown one;
  - `ping` before `initialize`; requests before `initialize`; notifications get no response;
  - batch only under `2025-03-26`;
  - error codes;
  - 2,000 random byte strings never throw.
- **`src/mcp/tools.check.ts`** (pure):
  - `tools/list` equals both goldens byte for byte, and its size is ≤ 9 KB;
  - each tool's argv mapping for valid input;
  - each validation failure (type, enum, range, a ref starting with `-`, a 513-char filter, an unknown field);
  - cursor round trip;
  - size cap trimming (lists, objects, a single huge row);
  - content stripping per tool, `--content` keeping it;
  - every `outputSchema` property is a CLI field (from a recorded `--help --format json`) or a documented shaped
    field.
- **`src/mcp/run.check.ts`:** with a stub child (`sh -c` scripts):
  - concurrency 2 and queue 8, then `busy`;
  - timeout kill with SIGTERM, then SIGKILL;
  - cancel while queued and while running;
  - progress every 2 s only with a token;
  - stderr JSON error parsed;
  - env: `SESSION_VARS` dropped, `AGENTGLASS_AGENT=1` set, the retry keeps them;
  - the cwd rule for `$HOME`.
- **`scripts/mcp.test.sh`** (end to end on a fixture HOME, contract-test style; uses `scripts/mcp-client.py`, a
  small JSON-RPC stdio client; skips without python3):
  1. Conformance: `initialize` (`2025-11-25` and `2024-11-05`), `notifications/initialized`, `ping`, `tools/list`
     = golden, each of the 11 tools with default input → no `isError` (`fleet` → `configured: false`), unknown tool →
     `-32602`, bad input → `isError`.
  2. Identity: a fake harness process (`scripts/fake-agent.c` linked as `claude`, holding a fixture transcript open)
     starts the client, which starts `agentglass-mcp`, while `CLAUDE_CODE_SESSION_ID` is set to a *different*
     session. `session {}` returns the fake agent's session with `via` `ancestor:pid …`.
  3. Scope: two projects; a server started in p1 sees only p1 sessions in `sessions`; `--all-projects` sees both; a
     server started in `$HOME` takes the fake agent's session cwd.
  4. Content canary: fixture tool results, a later prompt and assistant text contain `CANARY-7f3a`. No tool output
     contains it without `--content`; `errors` with `--content` does.
  5. Redact: `--redact` → titles faked, `instructions` without the project name.
  6. Cancel: `notifications/cancelled` during a call (`AGENTGLASS_MCP_BIN` = a stub that sleeps) → the stub pid is
     gone within 1.5 s, and no response for that id.
  7. Shutdown: closing stdin with a call in flight → server and child gone within 1.5 s.
  8. `wait --now` from a fake agent with a running `agentglass-mcp` child lists no `agentglass` family.
  9. `agentglass mcp install` with stub `claude`/`codex`/`gemini`/`pi`/`kiro-cli` on `PATH`:
     - default prints and runs nothing (stub logs empty);
     - `--write` without a TTY and without `--yes` → exit 2;
     - `--write --yes --harness claude` → the stub got exactly the printed argv.
  10. `agentglass mcp doctor --json` → `ok: true`, `tools: 11`.
- **Footprint** (`scripts/footprint.sh` style, manual, release build, real-history copy of the cache, niced):
  - idle server: Private_Dirty ≤ 1 MB, RSS ≤ 4 MB, 0 CPU ticks over 60 s;
  - the server's own CPU per call ≤ 5 ms;
  - warm `session {}` ≤ 1.5 s and `contention` ≤ 1 s wall on this host;
  - 36 idle servers ≤ 40 MB of private memory in all.
- **Live hosts** (manual, plan T8, isolated `HOME`, no model call):
  - `gemini mcp list` → `Connected`;
  - `pi mcp list --json` → `state: connected` with 11 tools;
  - OpenCode and Kiro when open question 3 is settled.

  Never against the user's own Claude Code or Codex.
- `scripts/contract.test.sh` gains the MCP section checks (tool names and input properties from the doc table).

## Out of scope
- Streamable HTTP / SSE transport, remote MCP, OAuth.
- Write tools (prices, prompts to other agents, alert acknowledgement, `open`).
- MCP resources (transcripts by URI), prompts, sampling, elicitation, completions.
- A machine-wide cap on concurrent children across servers.
- Keeping a warm in-process index in the server.
- Editing harness config files directly (OpenCode is print-only).
- Cursor, Windsurf, Zed and other hosts agentglass does not read sessions of (they can register the server by hand;
  "current" then has no session).

## Decisions (2026-10-08, delegated by the user on 2026-10-05)
Each: question · options · decision · why · cost if wrong.

1. **In-process query engine or one CLI child per call?**
   - Options: (a) the server loads the ledger and answers in process; (b) one `agentglass` child per call.
   - **Decision: (b).**
   - Why: a warm CLI call peaks at 107–146 MB (measured) and an in-process server would keep that resident per
     agent session, ≈ 4–5 GB for the 36 live agents seen on this host. (b) holds nothing between calls. It reuses
     contract-1 JSON byte for byte, so MCP and CLI numbers cannot differ. Latency is 0.5–1.2 s warm, which is fine
     for a tool call.
   - Cost if wrong: if agents call tools in tight loops, latency adds up. A short result cache or a shared daemon can
     be added behind the same tool contract.
2. **Server in the main binary (`agentglass mcp serve`) or a separate `agentglass-mcp`?**
   - Options: (a) the main binary; (b) a small separate binary built from `src/mcp/` only.
   - **Decision: (b).**
   - Why: measured idle Private_Dirty is 5.3 MB for the main binary (module init of every feature) against 0.13 MB
     for a minimal scriptc server. With 36 agents that is ~190 MB against ~5 MB, held all day. The user asked to keep
     memory low on this shared host. The release pipeline already ships a second binary (`agentglass-receive-tls`),
     so the packaging path exists. Unlike that one, this binary is not optional.
   - Cost if wrong: one more file in archives, formula and `update` (plan T6). If packaging proves brittle, (a) is a
     30-line entry in the main binary using the same `src/mcp/` modules.
3. **Transport: stdio only, or Streamable HTTP too?**
   - Options: stdio; HTTP on the hub's `node:http` server; both.
   - **Decision: stdio only.**
   - Why: every target host runs local servers over stdio (observed for Gemini and pi). An HTTP server cannot see
     its caller's process, so "current" and the project scope (the two things that make the tools useful and safe)
     would be gone. It would also need auth, Origin checks and session ids. The hub's receiver is a different trust
     boundary.
   - Cost if wrong: web-based clients cannot connect. Fleet and OTLP already cover remote reading; HTTP can be added
     later with an explicit host/project argument and tokens.
4. **Write tools?**
   - Options: none; `prices_set` and `send_prompt` behind `--allow-write`; all.
   - **Decision: none in v1.**
   - Why: there is no CLI for sending a prompt (it is a TUI action). An MCP tool for it would let one agent steer
     another: a prompt-injection relay across sessions. `prices set` changes every cost the user sees, and an agent
     that is over budget should not be able to reprice. Both stay one CLI command away for the user. Read-only tools
     can carry `readOnlyHint`, so hosts may skip the confirmation dialog.
   - Cost if wrong: an agent asked by the user to price a model says "run `agentglass prices set …`". Adding an
     opt-in write tool later is additive (contract keeps N).
5. **Resources, prompts, notifications?**
   - Options: transcripts as resources; prompts as slash commands; `listChanged`.
   - **Decision: none.**
   - Why: transcripts are exactly the content we keep out by default. Prompts add a surface each host shows
     differently, for little gain over good tool descriptions. The tool list is fixed per binary.
   - Cost if wrong: users want `/agentglass-cost` as a slash command. A prompt is additive.
6. **What counts as content?**
   - Options: (a) everything from transcripts; (b) bodies only (results, prompts after the first, assistant text,
     thinking, subagent task prompts); keep titles, tool names, command lines and paths.
   - **Decision: (b).**
   - Why: without titles and command lines, `sessions`, `errors` and `related` cannot answer their questions ("which
     session ran `pnpm test` at 14:02?"). The CLI already returns them in agent mode, inside the same project scope.
     `--redact` fakes titles. Tool results and conversation text are where secrets and private text actually sit.
   - Cost if wrong: a secret in a command line (`curl -H "Authorization: …"`) reaches the model provider of an agent
     in the same project. `--redact` scrubs known secret shapes; a stricter mode can drop `arg` later (additive
     option).
7. **Idle timeout?**
   - Options: exit after N idle minutes; drop caches after N minutes; none.
   - **Decision: none.**
   - Why: the server holds no cache. Measured idle cost is 0 CPU ticks and 0.13 MB private. Hosts do not restart an
     exited stdio server, so an exit would remove the tools from a long session.
   - Cost if wrong: nothing measurable. If a later version caches, it adds a TTL then.
8. **Does `mcp install` edit config files?**
   - Options: print only; edit every config; run each harness's own `mcp add`.
   - **Decision: print by default; `--write` runs the harness's own `mcp add` command after a `y/N` (or `--yes`);
     never edit a file ourselves (OpenCode stays print-only).**
   - Why: the user's harness configs (`~/.claude.json`, `config.toml`, `settings.json`, JSONC `opencode.json`) belong
     to tools that change their formats. Their own CLI writes them correctly, and printing is always safe.
   - Cost if wrong: OpenCode users paste one snippet. A harness CLI changes its `mcp add` flags: the printed command
     fails visibly, and a test with stubs pins our argv.
9. **Own contract number for MCP?**
   - Options: a separate `mcpContract`; the CLI's `contract`.
   - **Decision: one number.**
   - Why: MCP outputs are CLI outputs, so a CLI field rename breaks both anyway. One number, one doc and one check
     are easier to rely on. `_meta["agentglass/contract"]` carries it in `initialize`.
   - Cost if wrong: an MCP-only breaking change bumps the CLI's number, so scripts check once and see nothing changed
     for them. That is cheap and rare.
10. **Machine-wide limit on concurrent children?**
    - Options: per-server cap; a lock-slot directory shared by all servers; none.
    - **Decision: per-server cap 2, queue 8.**
    - Why: a slot directory adds stale-lock handling for calls that last a second. The measured worst case (10 calls
      at once ≈ 1.3 GB for ~1 s) is short-lived.
    - Cost if wrong: a burst of many agents calling at once spikes memory. A slot directory (the pattern `scripts/check.sh`
      uses for machine-wide check slots) can be added inside `run.ts` without a contract change.
11. **Tool naming?**
    - Options: `agentglass_session` …; plain `session` ….
    - **Decision: plain names.**
    - Why: hosts namespace MCP tools by server name (Claude Code `mcp__agentglass__session`, OpenCode
      `agentglass_session`), so a prefix would double it. Short names cost fewer tokens in every session.
    - Cost if wrong: a host without namespacing has a name clash with another server's `session`. Renaming is a
      breaking change (contract bump).
12. **Which session is "current" when env and process tree disagree?**
    - Options: env first (the CLI's rule); process tree first.
    - **Decision: process tree; env only as a retry.**
    - Why: measured nested hosts inherit the outer agent's `CLAUDE_CODE_SESSION_ID`, and a long-lived server's env
      goes stale after `/clear`. The process link follows the host's live registry.
    - Cost if wrong: a harness whose process is not linked but whose env id is right needs the retry (one extra
      ~0.6 s child). Measured for none so far.

## Open questions (technical verification during implementation)
1. **Claude Code:** does the registry link (`~/.claude/sessions/<pid>.json`) follow `/clear` and `/resume` within one
   process, so "current" moves? Verify with a fixture registry file rewritten mid-test. The user's Claude Code is
   never used.
2. **Codex:** which env does Codex give stdio MCP servers (its default allow-list, no `CODEX_*` markers expected),
   and what cwd? `AGENTGLASS_AGENT=1` in children makes detection independent of this. Verify the cwd from Codex's
   source (`codex-rs` MCP client) rather than a live run.
3. **OpenCode 2.0.19:** `opencode mcp list` printed nothing without a TTY and hung under a PTY. Find a non-interactive
   way (an `--print-logs` run of `opencode run` with a fake provider, or source reading) to confirm stdio server start,
   env and cwd. Until then OpenCode is "should work, unverified" in the README.
4. **Cold cache under a timeout:** does a CLI child killed during a cold index keep the cache entries it already
   wrote, so retries make progress? Measure with an empty `AGENTGLASS_CACHE_DIR` and `--timeout 5`.
5. **`structuredContent` in each host:** which hosts pass `structuredContent` rather than the text block to the
   model (it affects only token cost, not correctness). Record per host in the README table.

### Answers (implementation, 2026-10-08)
1. **Claude registry `/clear`:** yes. `scripts/mcp.test.sh` rewrites a fake agent's `~/.claude/sessions/<pid>.json` from
   session A to B between two calls of the same process: `session {}` returns A, then B.
2. **Codex** (source, `codex-rs/rmcp-client`): a stdio server gets only `HOME LOGNAME PATH SHELL USER LANG LC_ALL
   TERM TMPDIR TZ` plus the server's configured `env_vars`/`env` (`DEFAULT_ENV_VARS`, `create_env_for_mcp_server`),
   its cwd is the server config's `cwd` or else Codex's own working directory (`LocalStdioServerLauncher`,
   `runtime_context.local_process_cwd()`), in a new process group; the parent stays the codex process. No `CODEX_*`
   marker reaches the server: `AGENTGLASS_AGENT=1` in the children covers it, and the cwd is the project.
3. **OpenCode 2.0.19:** still unverified. `opencode mcp list` with isolated `XDG_*` dirs and no TTY exits 125
   without output and starts its own `opencode serve --service` daemon (killed after the probe). README: "should
   work, unverified".
4. **Cold cache under a timeout:** a child killed during a cold index keeps nothing (`cost` with an empty cache and
   `--timeout 5`: four calls, each `timeout`, the cache stays at 1 KB), so retries make no progress. `sessions` (24 h)
   answers within 5 s on a cold cache. The `timeout` hint and the README say: run `agentglass` once first.
5. **`structuredContent`:** pi 0.99.2 (code mode, the default exposure) hands the model `structuredContent` (its
   generated code read `s.structuredContent ?? s`); Gemini CLI 0.63.0 showed the model the JSON object. Both answered
   correctly in live sessions (session, errors, waits, contention; `scope: project`, contention `host`).

