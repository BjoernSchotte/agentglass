# CLI agent mode — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 7 (extends honest-costs' `agentglass cost`
and reads its per-model day buckets; the `cost` query uses filter-language's shared aggregation when present).

## Goal
When a coding agent runs `agentglass` (from its shell tool), agentglass behaves like a well-mannered CLI for machines:
- it never opens the TUI and never prompts;
- it prints JSON by default;
- `--help` is structured;
- it can answer the questions an agent actually asks: "what did my current session cost, what failed, what happened
  in the last session in this directory?".

A `--format json|jsonl|csv|table` option works for everyone, agent or human.

## Why (user value)
- Today an agent that runs `agentglass` gets one of two results. With a pipe it gets "needs an interactive terminal"
  and exit 1 (`src/main.ts:58`). Under a harness that runs commands in a PTY (Gemini CLI falls back to node-pty, Codex
  unified exec), stdin is a TTY, so the full-screen TUI starts and **hangs the agent's tool call** until it times out.
- Agents can check their own work: "my last test-fix loop cost $3, 14 Bash calls failed with exit 1, the same command
  was retried 6 times". The user can also ask the agent "what did yesterday's session in this repo do?" without
  switching windows.
- CSV and table output make `agentglass` usable in shell scripts and spreadsheets without `jq`.

## Today (current code, with path:line refs)
- **CLI entry:** `H.cli` handlers run first (`src/main.ts:57`). Without one, a non-TTY stdin exits 1 (`main.ts:58`);
  a TTY stdin starts the TUI (`main.ts:59-61`). Nothing checks the environment for an agent.
- **`--json`** prints the session list. On a TTY it is pretty-printed, otherwise compact (`src/features/cli.ts:112`).
  The fields are fixed (`cli.ts:58-62`). The options are `--live`, `--harness`, `--limit`, `--subagents`,
  `--from-start` (`cli.ts:71-82`). Bad options exit 2 through `fail()` (`cli.ts:69`). Output goes through `out()`,
  which writes synchronously and exits quietly on EPIPE (`cli.ts:66-68`). There is no CSV, no table and no field
  selection.
- **`--help`** is a hand-aligned text table (`cli.ts:15-54`) and has no machine form.
- **Prompts:** `update` asks before a downgrade only when `process.stdin.isTTY` (`src/features/update.ts:119-121`).
  In a PTY-backed agent shell that check passes, and the update blocks waiting for an answer that never comes.
- **Warnings** reach stderr in CLI mode only through `say()` when `S.cli` is set (`src/state.ts:57-60`).
- **Per-call errors:** `TS.errs` keeps the last 10 failed calls per tool per day as `Rec {t, ms, id, ts, arg}`
  (`src/features/usage/calls.ts:6-8, 17, 54-60`). The result text is not stored; it can be read back by call id from
  the transcript.
- **Process tree:** `refreshProcs` lists every process with `ppid` and harness (`src/model/procs.ts:41-50`).
  `procSess(p)` links a process to its session (`procs.ts:153`).
- **Stats aggregation** (`agg`, `src/features/usage/stats.ts:49`) is private to the Stats tab. filter-language §5
  moves it into a shared evaluator.

### Agent environment variables (verified where possible)

| Harness | Variable(s) set for the agent's shell commands | Session id for "current" | Evidence |
|---|---|---|---|
| Claude Code | `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, `AI_AGENT=claude-code_<ver>_agent` | `CLAUDE_CODE_SESSION_ID` (= transcript file name) | observed in a live Claude Code 2.1.285 shell (2026-10-02) |
| Codex | `CODEX_SANDBOX=seatbelt` (macOS sandbox only), `CODEX_SANDBOX_NETWORK_DISABLED=1` (sandbox without network), `CODEX_CI=1` (unified exec only) | `CODEX_THREAD_ID` (**uncertain**: the string exists in the 0.160.0 binary next to `unified_exec`, not seen in source; assumed to equal the rollout's session id) | `codex-rs/core/src/spawn.rs:18-23,60`, `seatbelt.rs:33`, `unified_exec/process_manager.rs:50-61` (clone of 2026-01-24); binary strings of 0.160.0 |
| Gemini CLI | `GEMINI_CLI=1` | none (`GEMINI_SESSION_ID` is only given to hooks) | `packages/core/src/services/shellExecutionService.ts:59-64,584`; `hooks/hookRunner.ts:350-353` |
| pi | `PI_CODING_AGENT=true`, `AI_AGENT=pi` (set on its own process, inherited) | none | `packages/coding-agent/src/cli/setup.ts:6-7`, `rpc-entry.ts:7-8` |
| OpenCode | `OPENCODE=1`, `AGENT=1`, `AI_AGENT=opencode` (if unset) | `OPENCODE_SESSION_ID` | `packages/core/src/tool/plugin/shell.ts:210-213`; 1.x: `OPENCODE=1` at `packages/opencode/src/index.ts:76` |
| Kiro CLI | **uncertain**: `KIRO_SESSION_ID` appears in the `kiro-cli-chat` binary; whether shell commands get it is unknown | maybe `KIRO_SESSION_ID` | binary strings only; closed source |
| fx | unknown | none | no source available |

`AI_AGENT` is a cross-tool convention (Claude Code, pi and OpenCode set it). Its presence alone is enough to enable
agent mode.

## Design

### 1. Detection (`src/features/agentenv.ts`)
```ts
export interface AgentHost { on: boolean; harness: string; session: string; via: string } // via: "env:CLAUDECODE" | "ancestor:pid 1234" | "flag" | ""
export function agentHost(): AgentHost; // computed once, cached
```
1. **Explicit override wins.** `--agent` or `AGENTGLASS_AGENT=1` turns agent mode on. `--no-agent` or
   `AGENTGLASS_AGENT=0` turns it off. A human can use `--no-agent` to get the TUI from inside an agent's terminal
   (for example tmux run from Claude Code).
2. **Environment markers.** Any of these turns agent mode on: `CLAUDECODE`, `AI_AGENT`, `CODEX_SANDBOX`,
   `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_CI`, `CODEX_THREAD_ID`, `GEMINI_CLI`, `PI_CODING_AGENT`, `OPENCODE`,
   `OPENCODE_SESSION_ID`, `KIRO_SESSION_ID`.
   - The harness comes from the first marker in that order. For `AI_AGENT`, the prefix decides: `claude-code` →
     claude, `pi` → pi, `opencode` → opencode, anything else → `""`.
   - A plain `AGENT=1` is not used on its own; the name is too generic.
3. **Process ancestry.** It is the fallback for the harness and the source of the session id when no session variable
   exists. It runs only for commands that need "current".
   - Walk the `ppid` chain from `process.pid` through `allProcs` (one `refreshProcs()`), at most 64 steps.
   - The first ancestor with `p.h !== ""` gives the harness. The first ancestor with `procSess(p)` gives the session.
     This works for every harness agentglass links today, including Gemini, pi, Kiro and fx (registry, open file or
     `liveCwd`).
   - When the env marker and the ancestor disagree (nested agents), the **nearest ancestor** wins and `via` names both.
4. **Session id from the environment.** `CLAUDE_CODE_SESSION_ID`, `OPENCODE_SESSION_ID`, `CODEX_THREAD_ID` and
   `KIRO_SESSION_ID` are looked up in `sessions` by id (exact match, any harness). An id that is not found falls back
   to ancestry with a warning. Subagent shells report the subagent's own session if the harness sets one; `session
   current --root` goes up to the root session.
5. **Effects of agent mode:**
   - The TUI never starts. Bare `agentglass` prints the **compact help** (4.5) and exits 0. Any command that would
     start the TUI (`--theme`, `open`) prints its JSON equivalent instead.
   - The default `--format` is `json`, compact (no pretty-printing, even on a PTY).
   - `NO_COLOR` is implied. No OSC escape sequences are printed (hyperlinks, OSC 52 clipboard).
   - Nothing reads stdin for confirmation. `update` without `--yes` refuses a downgrade with exit 2 and the hint "use
     --yes". The TTY check in `update.ts:120` becomes `interactive()` = `stdin.isTTY && !agentHost().on`.
   - `--watch` needs `--for <dur>` (for example `--for 30s`) or `--until-idle` (exit when no event arrived for 10 s).
     Without either it exits 2 with a hint, because an endless stream ties up the agent's tool call.
   - Errors go to stderr as one JSON line `{"error":{"code":"…","message":"…"}}`; stdout stays empty. Outside agent
     mode they stay plain `agentglass: …`.
6. **Outside agent mode** nothing changes, except that `--format` and the query commands become available.

### 2. `--format json|jsonl|csv|table` and `--fields`
1. **Applies to:** `--json` (a list of session rows), `sessions`, `session`, `errors`, `cost`. `--json` stays and
   means `--format json`. `--watch` is always JSONL; `--format` is rejected there.
2. **Defaults:** agent mode → `json`; stdout is a TTY → `table`; otherwise `json`. The default for bare `--json` stays
   JSON so existing scripts keep working.
3. **Formats:**
   - `json`: one array, or one object for single-object commands (`session`). Pretty on a TTY outside agent mode.
   - `jsonl`: one object per line, for long lists.
   - `csv`: RFC 4180 with a header row and CRLF-free `\n` lines. Nested objects are flattened with `_`
     (`tokens.in` → `tokens_in`), arrays are joined with `;`, and `null` is an empty field.
     Cells that start with `=`, `+`, `-` or `@` get a leading `'`, so spreadsheets do not run them as formulas.
   - `table`: aligned columns with visible-width padding (`width()`, `src/util/text.ts:17`). Long text is cut with `…`
     to fit `$COLUMNS` (default 120). Numbers are right-aligned. No colors when not on a TTY.
4. **`--fields a,b,c`** selects and orders top-level fields (flattened names work: `tokens_in`). An unknown field exits
   2 and lists the valid ones. The `table` defaults per command are listed in 3.
5. **Implementation.** One formatter module (`src/features/format.ts`) takes `rows: Obj[]` and `cols: string[]`. All
   commands build plain objects first and format last, so every format shows the same data.

### 3. Query commands
All commands take `--harness`, `--format` and `--fields`, plus `--filter '<expr>'` once filter-language exists. The
scope default is decision 3.6.

1. **`agentglass session [<ref>]`**, where `<ref>` is one of:
   - `current` (the default in agent mode);
   - `last`: the newest top-level session whose cwd is the current directory or inside the same project, excluding
     current;
   - `parent`: the current session's root;
   - an id or a unique id prefix of at least 6 characters (exit 4 if ambiguous, listing the candidates);
   - `<harness>:<id>`.

   Output (one object):
   - the `--json` session fields (`cli.ts:58-62`);
   - `turns`, `wallMs` and `activeMs` (callgraph `summary`, `model.ts:200-218`);
   - `models: [{model, in, out, cacheRead, cacheWrite, costUsd}]`, from honest-costs' per-model day buckets
     (`Day.mt`, `Day.um`);
   - `tools: [{name, calls, errors, p50Ms, maxMs}]`, top 15 by calls;
   - `errors: [{ts, tool, arg, text}]`, the last 10. `text` is the first 200 characters of the result, found by call id
     through `sourceOf(h).lines`;
   - `files: [{path, add, del}]`, top 15;
   - `repeats`: identical tool calls repeated ≥ 3 times in a row (the watchdog's `loopRun`, `watchdog.ts:21`);
   - `subagents: [{id, kind, costUsd, tools}]`;
   - `costBasis`: the honest-costs label, when present.

   `complete(s)` runs only for this session and its subagents, so the command stays fast on large histories.
   Table default: a key/value list.
2. **`agentglass sessions [--since 24h] [--cwd <dir>] [--limit N] [--live] [--subagents]`** is the `--json` list with
   time and cwd selection. `--cwd .` is resolved with `realpath`. Table default:
   `updated harness title project costUsd tools status`.
3. **`agentglass errors [<ref>] [--since 24h] [--limit 20]`** lists failed tool calls, newest first:
   `{ts, harness, session, tool, arg, text, durationMs}`.
   - With `<ref>`, only that session (and its subagents). Without it, the scope of 3.6.
   - The source is `TS.errs` (last 10 per tool per day), or filter-language's per-call rows once they exist (complete
     history). The command states which one it used in a `source` field of the JSON envelope.
4. **`agentglass cost`** exists already (honest-costs, phase 1: `agentglass cost [--json] [--harness h] [--check]`
   — today / 7 days / month to date per billing mode, unpriced usage, projection, budget; `--check` exits 3 when the
   budget is over). This spec **extends** that command; it does not define a second one. Added options:
   `[--since today|7d|30d|YYYY-MM-DD] [--by day|model|harness|project|session] [--format F] [--fields …]`, plus the
   agent-mode defaults (compact JSON, scope 3.6). `--harness` and `--check` keep working in both forms below.
   - **Without `--by` and `--since`:** the honest-costs output, unchanged in content: JSON
     `{today:{byMode,unpriced}, month:{byMode,unpriced,projected}, budget}` (the default in agent mode and with
     `--json`/`--format json`), or its text table (`--format table`, the default on a TTY outside agent mode).
     `csv`/`jsonl` need rows → usage error naming `--by`.
   - **With `--by` (or `--since`; `--since` alone implies `--by day`):** rows of
     `{key, in, out, cacheRead, cacheWrite, costUsd, unpricedTokens, sessions}` plus a total row, in the envelope of 5
     for `json`, bare rows for `csv`/`jsonl`/`table`. `--since` defaults to `today`. It uses the shared aggregation
     from filter-language (§5), with the Stats day buckets as the fallback. `--by model` reads honest-costs'
     per-model day buckets (`Day.mt` tokens and cost, `Day.um` unpriced tokens); this spec adds no ledger data and no
     cache version bump.
   - `--check` in either form: exit 3 when the honest-costs budget state is `over` (output printed first).
   - Unpriced tokens are never shown as $0 (honest-costs).
5. **Envelope.** In `json` format, list commands print the bare array, the same as `--json` today. `errors` and
   `cost` print `{"rows":[…],"source":"…","scope":"…"}` so an agent can see what it is looking at. CSV, table and
   JSONL print only the rows.
6. **Privacy scope.** Agent-mode output enters the agent's context and goes to its model provider. By default,
   **agent-mode queries only see sessions of the current project**: the cwd's project identity from repo-view, or the
   exact cwd before repo-view exists. Two ways widen it: `--all-projects` per command, or the config default
   `~/.agentglass/config.json` `{"agent": {"scope": "all"}}` (values `project` (default) | `all`; anything else →
   `project` with a stderr warning). `--project-only` overrides a configured `all` for one command. The JSON envelope's
   `scope` field and the help's `agentMode.scope` state the effective scope. Outside agent mode the default scope is
   everything, as today.
   - `--redact` applies unchanged: fake titles, cwd and content.
   - Error `text` is cut to 200 characters and passes `scrubText` when redaction is on.
7. **Exit codes** (all commands): 0 ok (an empty result is ok), 1 runtime failure, 2 usage error, 3 not found (no
   current session, unknown id), 4 ambiguous reference.

### 4. Structured help
1. The option tables in `cli.ts:15-33` become typed records:
   `{cmd, usage, summary, options: [{flag, arg, summary, default, values}], fields?: string[]}`. The query commands,
   `export` (otlp-export) and `open` (command-palette) register theirs the same way. The text help is rendered from
   these records, so the two forms cannot drift.
2. `agentglass --help --format json` (the default in agent mode) prints
   `{name, version, agentMode: {on, harness, session, via, scope}, commands: […], formats: […], exitCodes: {…}, examples: […]}`.
   `agentglass <cmd> --help` prints only that command.
3. `examples` holds the five queries an agent most likely needs, for example
   `agentglass session current --fields costUsd,tools,errors`. Keep them short: they cost the agent tokens.
4. The README gets a paragraph for `CLAUDE.md`/`AGENTS.md`: "Run `agentglass session current` to see this session's
   cost and failed tool calls."
5. **Compact help** (bare `agentglass` in agent mode): one compact JSON object, target ≤ 1.5 KB (1 KB until the
   agent-wait review: the list lost commands as it grew), rendered from the same records — `{name, version, agentMode: {harness, session, scope}, commands: [{cmd, summary}], examples: [3
   most useful], more: "agentglass --help"}`. No option tables, no field lists; `--help` gives the full form (4.2).

### 5. Failure modes
- No current session (the shell is not under an agent, or the link failed): exit 3 with
  `{"error":{"code":"no_current_session","message":"…","hint":"pass a session id or use 'last'"}}`.
- The current session file does not exist yet (Gemini writes on the first message, Claude on the first prompt):
  ancestry finds the process but not the session, and the result is the same exit 3 with hint "session not written
  yet".
- `ps` is unavailable (sandboxed shells, for example the Codex seatbelt): ancestry is skipped and only the env ids are
  used, with a warning.
- Large histories: `sessions`/`errors`/`cost` without filters read only the ledger's cached state. The persistent
  ledger cache is in `src/features/usage/cache.ts`. A cold cache costs one full read once, the same as `--json` today.

## Interactions with other specs
- **filter-language:** `--filter`, the per-call rows for full `errors` history, and the shared aggregation for `cost`.
- **repo-view:** project identity for `last` and for the agent-mode scope.
- **honest-costs:** `costBasis`, unpriced tokens, never $0, and the per-model day buckets (`Day.mt`, `Day.um`,
  `modelUses()`) behind `models` and `cost --by model`.
- **otlp-export:** `export --json` follows `--format`. Agent mode never starts `--watch --otlp` implicitly.
- **command-palette:** `agentglass open <ref>` in agent mode prints the resolved target as JSON (the same `<ref>`
  grammar as `session`).

## Testing
- **Detection table test:** for each env fixture (one per row above, combinations, overrides), check
  `agentHost().on/harness/session/via`. Ancestry runs on a synthetic `allProcs` map: nested agents, a wrapper binary,
  a missing `ps`.
- **No TUI in an agent:** run the binary under `script -qc` (PTY) with `CLAUDECODE=1`. Bare `agentglass` must exit 0
  within 2 s and print the compact help (valid JSON, ≤ 1.5 KB, no option tables).
- **Scope:** agent mode defaults to the current project; `--all-projects` and `agent.scope: "all"` widen it;
  `--project-only` narrows a configured `all`; an invalid `agent.scope` warns and uses `project`. `agentglass update --tag <older>` must exit 2 without reading stdin.
- **Format golden tests:** the same rows in json, jsonl, csv (quoting, formula guard, flattening) and table (CJK and
  emoji widths, cutting). `--fields` order and unknown-field errors.
- **Queries on fixture homes** (a temp `HOME` with Claude, Codex and Gemini sessions):
  - `session current` with `CLAUDE_CODE_SESSION_ID`;
  - `last` in a cwd with two sessions;
  - prefix ambiguity → exit 4;
  - `errors` reads result text by call id;
  - `cost --by model` totals equal the Stats totals for the same days.
- **Live check** (manual, once per harness that is installed): run `agentglass session current` from inside Claude
  Code, Codex, Gemini CLI, pi, OpenCode and Kiro. Record the variables actually present and update the table above.
  This is how the Codex `CODEX_THREAD_ID` and Kiro rows get settled.

## Out of scope
- YAML output.
- An MCP server mode for agentglass.
- Writing back to sessions (send and resume stay TUI actions).
- Detecting Cursor and other harnesses agentglass does not read.
- Localized output.

## Decisions (review 2026-10-02)
1. Bare `agentglass` inside an agent? Prints the compact help (1.5, 4.5).
2. Agent-mode scope? Current project by default; widened by `--all-projects` or config `agent.scope: "all"` (3.6).
3. Per-model tokens and cost? Owned by honest-costs (phase 1: `Day.mt` next to `Day.um`); `session` `models` and
   `cost --by model` read them. No ledger change and no cache version bump in this spec (3.1, 3.4).
4. `agentglass cost` already exists (honest-costs)? Extended, not redefined: `--since`/`--by`/`--format`/`--fields`
   and the agent-mode JSON default are added; `--harness`, `--check` and the honest-costs JSON fields stay. Without
   `--by`/`--since` the honest-costs summary is printed; with them, rows (3.4).

## Open questions (to verify during implementation)
1. **Codex session id.** Is `CODEX_THREAD_ID` exported to every shell command (not only unified exec), and does it
   equal the rollout's session id? To be confirmed with one `codex exec 'env'` run.
2. **Kiro.** Does Kiro CLI set `KIRO_SESSION_ID`, or any marker at all, for shell tool commands?
