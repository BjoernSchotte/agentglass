# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coding agents query agentglass as native MCP tools. A small stdio server, `agentglass-mcp`, offers 11 read-only tools (`session`, `sessions`, `errors`, `cost`, `triage`, `compare`, `related`, `contention`, `waits`, `fleet`, `prices`). Each call runs one `agentglass` CLI child in agent mode. The server keeps the project scope, `--redact` and content stripping, and costs ~0.13 MB private memory when idle. `agentglass mcp install` prints or (with consent) applies the registration per harness, and `agentglass mcp doctor` checks it end to end.

**Architecture:**
- `src/mcp/rpc.ts`: pure framing and JSON-RPC: byte-level line framing, version negotiation, dispatch of `initialize`, `ping` and `tools/list`, batch only under `2025-03-26`.
- `src/mcp/tools.ts`: tool definitions, input validation, the argv mapping and default fields.
- `src/mcp/shape.ts`: envelope, pagination, content stripping and the size cap.
- `src/mcp/run.ts`: the child runner: spawn, env, cwd, concurrency 2 plus a queue of 8, timeout, cancel, progress.
- `src/mcp/main.ts`: wires these to stdin and stdout and is built as a second binary.
- `src/features/mcp-cli.ts`: `agentglass mcp install|doctor` in the main binary.
- No feature module is imported by `src/mcp/*`.
- No cached data changes (no `VERSION` bump).

**Tech Stack:** TypeScript → native binaries via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests are `scripts/*.test.sh`, and the test MCP client is `scripts/mcp-client.py` (python3, stdlib only).

**Spec:** [spec.md](spec.md). Read it first, including "Today (measured)", "Decisions" and "Open questions"; this plan argues from it.

**Round:** Round 2 (after 2026.10.4). Needs cli-agent-mode, agent-wait, filter-language, triage, session-compare, related-events, model-prices and fleet Part A (all merged). Touches release packaging (release-management's scripts).

## Global Constraints

- **Build and tests.** Build with `./build.sh` and run the tests with `sh scripts/check.sh`. A task is done only when both pass.
- **Single check.** Builds and caches go under your own dir, never `/tmp`: `C=$HOME/.cache/agentglass-agents/impl-mcp; mkdir -p $C/home; scriptc build --optimization dev --strip <f> -o $C/x && HOME=$C/home AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme $C/x`. The suite runs checks with `AGENTGLASS_REDACT=1`, so run once without it locally too.
- **Live runs of agentglass** use only the full isolation set, written out literally (zsh does not split `$VAR`): `AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp AGENTGLASS_FLEET_DIR=$S/fleet AGENTGLASS_HUB_DIR=$S/hub`, with `S=$HOME/.cache/agentglass-agents/impl-mcp/s; mkdir -p $S/run && chmod 700 $S/run`.
  - The server forces `AGENTGLASS_AGENT=1` in its children. For live runs, start the server itself with the set above; the children inherit every other variable.
  - Run `ls -la ~/.agentglass` before and after each live run: nothing may change.
- **Never use the user's Claude Code or Codex.** No `claude …` or `codex …` command runs in any task. Tests that need them use stubs on `PATH`. Live host checks (T8) use Gemini CLI and pi with an isolated `HOME` and no model call.
- **scriptc 0.1.7 limits:**
  - nominal typing (pass fields, not foreign interfaces);
  - no `Record<string, RegExp>` (C backend: `agentglass-mcp` must also build with `SCRIPTC_FLAGS="--backend c"`);
  - out-of-range array reads trap (bounds-check);
  - no zero-parameter arrow for an optional interface member (SC2003);
  - SC1090 array-index quirks (`+ 0` on typed-array reads used as indexes, no `.map` callbacks on index types, no `.replace` with a function);
  - a missing key of a `Record<string, string>` traps: read through `Record<string, string | undefined>` as `agentenv.ts:34-35` does.
- **Probe-proven I/O rules** (spec, Today):
  - split stdin on byte `0x0A` and decode whole lines only;
  - write stdout with a `writeSync` loop until every byte is out;
  - collect child output until `"close"`, not `"exit"`;
  - cancel with `ch.kill()` and then `ch.kill("SIGKILL")` after 1 s.
- **`src/mcp/*` imports** only `node:*`, `src/util/json.ts` and `src/build-info.ts`, never a feature, model or UI module. T5 checks this with a grep test. The idle budget depends on it.
- **Footprint budgets** (T8 measures):
  - idle server: Private_Dirty ≤ 1 MB, RSS ≤ 4 MB, 0 CPU ticks / 60 s;
  - no timer while no call is in flight;
  - the server's own CPU per call ≤ 5 ms.
- **Output discipline:** stdout carries JSON-RPC only. stderr is silent unless `--log` or `AGENTGLASS_MCP_LOG=1`; the one exception is the start-up usage error.
- **Process hygiene:** kill only pids and tmux sessions you started. One build at a time; `nice` heavy measurements.
- **CLI UX baseline:** errors go through `cliError` with a hint; text help at 80 columns; JSON help records for every new command; `--json` field order fixed.
- **Commits:** conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branches:**
  - The integration branch is `feat/mcp-server` from `origin/main`, in `../agentglass-mcp-server`.
  - Parallel tasks run in worktrees `../agentglass-mcp-server-t<N>` on `feat/mcp-server-t<N>`, branched from `feat/mcp-server` at the wave start.
  - Each task merges back in task-number order (rebase, then fast-forward).
  - One PR `feat/mcp-server` → `main`, rebase-merged after green CI.

## Waves (parallel vs sequential)

| Wave | Tasks | Run | Needs |
|---|---|---|---|
| 0 | T0 worktree, baselines, CLI field record | alone | — |
| 1 | T1 JSON-RPC core · T2 tools, shaping, goldens · T3 child runner · T4 CLI `via` + process-tree regression | **parallel** | T0 (T2 reads T0's `testdata/mcp/cli-fields.json`) |
| 2 | T5 `agentglass-mcp` entry, build, test client, end-to-end test | alone | T1–T4 |
| 3 | T6 `agentglass mcp install / doctor` · T7 packaging (archive, install.sh, formula, update) | **parallel** | T5 |
| 4 | T8 contract doc + contract test, footprint, live hosts, open questions, docs, final review | alone | T1–T7 |

Files per wave are disjoint:
- Wave 1: T1 `src/mcp/rpc*`; T2 `src/mcp/tools*`, `src/mcp/shape*`, `testdata/mcp/tools-*`; T3 `src/mcp/run*`; T4 `src/features/queries.ts`, `src/features/agentenv.ts`, `src/features/watchdog.check.ts`, `src/features/wait/live.check.ts`.
- Wave 3: T6 `src/features/mcp-cli.ts`, `src/main.ts` (one import line), `README.md`; T7 `scripts/package.sh`, `install.sh`, `scripts/formula.sh`, `src/features/update.ts`, `.github/workflows/*`, their tests.

## Review Focus

1. **Identity is the process tree.**
   - With a wrong `CLAUDE_CODE_SESSION_ID` in the env, `session {}` must still return the fake agent's session (T5 test 2).
   - The env retry runs only after `no_current_session` (T3 check).
2. **Nothing leaks.**
   - The content canary `CANARY-7f3a` never appears in any tool output without `--content` (T5 test 4).
   - The project scope holds (T5 test 3).
   - `instructions` never names the project under `--redact`.
   - `fleet` returns no session rows.
3. **Argument injection.**
   - No input value reaches argv except through the validated mapping. Refs match `^[A-Za-z0-9:._-]{1,128}$` and never start with `-`; filters are passed as `--filter=<expr>`.
   - The T2 check covers `--all-projects` given as a ref, as a filter, and inside `fields`.
4. **Protocol correctness.**
   - Version negotiation; no response to notifications; no response for a cancelled request.
   - `isError` for input errors versus `-32602` for an unknown tool.
   - `outputSchema` and `structuredContent` only from `2025-06-18` on.
   - The goldens pin `tools/list` byte for byte.
5. **The server never dies on input:** random bytes, 4 MiB+ lines, half lines at EOF, requests before `initialize` (T1 fuzz; T5 tests 6 and 7).
6. **No foreign config writes.** `mcp install` without `--write` runs nothing (stub logs empty). `--write` runs exactly the printed argv, and nothing edits harness files (T6).
7. **Idle cost.** `src/mcp/*` imports nothing heavy (grep test). No `setTimeout` or `setInterval` is armed while idle (T3 check counts armed timers). T8 measures.

---

### Task 0: Worktree, baselines, CLI field record

**Files:** Create `testdata/mcp/cli-fields.json` (committed: the field list per CLI command, the source of truth for T2's `fields` enums and the schema-drift check).

- [ ] **Step 1: Worktree and build.**
  ```sh
  git worktree add -b feat/mcp-server ../agentglass-mcp-server origin/main && cd ../agentglass-mcp-server
  AGENTGLASS_OUT=$HOME/.cache/agentglass-agents/impl-mcp/main-bin ./build.sh && sh scripts/check.sh
  ```
  Expected: the build succeeds and every check prints `ok`.
- [ ] **Step 2: Record the CLI field lists.**
  ```sh
  C=$HOME/.cache/agentglass-agents/impl-mcp; S=$C/s; mkdir -p $S/run && chmod 700 $S/run
  env AGENTGLASS_AGENT=1 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp AGENTGLASS_FLEET_DIR=$S/fleet AGENTGLASS_HUB_DIR=$S/hub $C/main-bin --help --format json \
   | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({c['cmd']:c['fields'] for c in d['commands'] if c['cmd'] in ('session','sessions','errors','cost','wait','--json','fleet') }, indent=1, sort_keys=True))" > testdata/mcp/cli-fields.json
  ```
  Expected:
  - `session` has 42 fields (spec, Today) and `errors` has `ts harness session tool arg text durationMs`;
  - `testdata/mcp/cli-fields.json` holds 7 keys.
  - T4 adds `via` to `session` and re-records this file in its last step.
- [ ] **Step 3: Baseline latency and size** for T8's comparison. Run the spec's "CLI calls" table commands once each with `/usr/bin/time -f "%e s %M KB"`, using the isolation set and `AGENTGLASS_AGENT=1`. Paste the table into the PR description as `Baseline:` lines. No commit.
- [ ] **Step 4: Commit** `test(mcp): record CLI field lists for the MCP schemas`.

---

### Task 1: JSON-RPC core (`src/mcp/rpc.ts`) — wave 1, parallel with T2, T3, T4

**Files:** Create `src/mcp/rpc.ts`, `src/mcp/rpc.check.ts`.

**Interfaces — Produces:**
```ts
import type { Obj } from "../util/json.ts";
export const VERSIONS: string[];                 // ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
export const MAX_LINE: number;                   // 4 * 1024 * 1024
export function negotiate(requested: string): string;            // requested if in VERSIONS, else VERSIONS[0]
export function structured(version: string): boolean;            // version >= "2025-06-18" (string compare on ISO dates)
export function annotated(version: string): boolean;             // version >= "2025-03-26"
export interface Framer { pend: Uint8Array; skipping: boolean }
export function newFramer(): Framer;
export interface Frame { line: string; oversize: boolean }       // oversize: a dropped line (→ -32600, id null)
export function push(f: Framer, d: Uint8Array): Frame[];         // whole lines only; trailing "\r" removed; empty lines skipped
export interface Msg { kind: string /* "request" | "notification" | "response" | "invalid" */; id: string /* the id as JSON text; "" = none */; method: string; params: Obj; why: string }
export function parse(line: string, version: string): Msg[];     // a JSON array → its items only when version === "2025-03-26"; else one "invalid"
export function ok(id: string, result: Obj): string;             // one JSON-RPC line (no "\n")
export function fail(id: string, code: number, message: string): string;   // id "" → null
export function note(method: string, params: Obj): string;
export interface Conn { version: string; init: boolean; client: string; redact: boolean; scopeName: string; contract: number }
export function newConn(): Conn;
// sync methods; tools/call and notifications/cancelled return {handled:false} for main.ts
export interface Reply { handled: boolean; lines: string[] }
export function answer(c: Conn, m: Msg, toolsList: (version: string) => Obj, instructions: (c: Conn) => string, serverVersion: string): Reply;
```

- [ ] **Step 1: Write the failing check** `src/mcp/rpc.check.ts`, which calls each function. It uses the `ok(name, cond, detail)` / count / `"rpc: all checks passed"` pattern of `src/features/fleet/serve.check.ts`. Cases:
  1. **Framing.** `push` of `{"a":1}\n{"b"` and then `:2}\n` gives 2 lines. Bytes `61 C3` then `BC 62 0A` give `aüb`. `\r\n` endings are stripped. `\n\n` is skipped. A 4 MiB + 1 line → one `oversize` frame; the line after it still parses. Data without a final newline stays pending.
  2. **Negotiate.** Each of the 4 versions maps to itself; `"2023-01-01"` and `""` map to `2025-11-25`. `structured("2025-06-18")` is true and `structured("2025-03-26")` false; `annotated("2024-11-05")` is false.
  3. **Parse.** A request, a notification (no `id`), a response (no `method`), invalid JSON → `invalid` with `why` "parse error", a non-object, and `"jsonrpc":"1.0"` → `invalid`. An array under `2025-06-18` → one invalid; under `2025-03-26` → 2 msgs. An id that is a string, a number or null round-trips as JSON text.
  4. **`answer`.**
     - `ping` before `initialize` → `{"jsonrpc":"2.0","id":1,"result":{}}`. `tools/list` before `initialize` → `-32600`.
     - `initialize` with `protocolVersion` `2025-06-18` → the result has that version, `capabilities.tools.listChanged` false, `serverInfo.name` `agentglass`, `_meta["agentglass/contract"]` 1, and `instructions` ≤ 600 characters.
     - `notifications/initialized` → handled with no lines. An unknown method → `-32601`. An unknown notification → no lines.
     - `tools/call` and `notifications/cancelled` → `handled:false`.
  5. **Fuzz.** 2,000 random byte arrays (a seeded LCG, lengths 0–300, including `0x0A`) go through `push` and then `parse` and `answer` without throwing.

  Run: `C=$HOME/.cache/agentglass-agents/impl-mcp; scriptc build --optimization dev --strip src/mcp/rpc.check.ts -o $C/rpc && $C/rpc`. Expected: the build fails (module missing).
- [ ] **Step 2: Implement** `src/mcp/rpc.ts`:
  - `push` concatenates into `pend` and scans for `10`.
  - While `skipping`, it drops bytes up to the next `10` and then emits one `oversize` frame.
  - It decodes with `new TextDecoder("utf-8").decode(sub)`.
  - Error codes: parse error `-32700` (`id` null), invalid request `-32600`, unknown method `-32601`.
- [ ] **Step 3: Run** the check command from Step 1. Expected: `rpc: all checks passed`. Also run with `SCRIPTC_FLAGS` replaced by `scriptc build --backend c --strip src/mcp/rpc.check.ts -o $C/rpc-c && $C/rpc-c`; expected the same line.
- [ ] **Step 4: Commit** `feat(mcp): JSON-RPC framing and protocol core`.

---

### Task 2: Tools, validation, shaping, goldens (`src/mcp/tools.ts`, `src/mcp/shape.ts`) — wave 1, parallel with T1, T3, T4

**Files:** Create `src/mcp/tools.ts`, `src/mcp/shape.ts`, `src/mcp/tools.check.ts`, `testdata/mcp/tools-2025-11-25.json`, `testdata/mcp/tools-2024-11-05.json`. Read `testdata/mcp/cli-fields.json` (T0). The field enums are generated into `tools.ts` by hand from it; the check compares them.

**Interfaces — Produces:**
```ts
// tools.ts
export interface Opts { allProjects: boolean; content: boolean; redact: boolean; maxBytes: number; timeoutMs: number; log: boolean }
export function defaultOpts(): Opts;                          // false, false, false, 24000, 50000, false
export function parseOpts(argv: string[]): { o: Opts; err: string; version: boolean; help: boolean };
export interface ToolDef { name: string; title: string; description: string; input: Obj; output: Obj }
export const TOOLS: ToolDef[];                                 // the 11 tools of spec §4, in this order:
// session sessions errors cost triage compare related contention waits fleet prices
export function toolsList(version: string): Obj;               // {tools:[…]}; title/annotations if annotated(), outputSchema if structured()
export interface Call { argv: string[]; tool: string; offset: number; limit: number; err: string; heartbeat: string /* "agentglass <cmd>" */ }
export function plan(name: string, args: Obj, o: Opts): Call; // err != "" → isError text; name unknown → err "unknown tool" (main.ts maps to -32602)
export function encodeCursor(offset: number): string;          // base64url of "o:<offset>"
export function decodeCursor(c: string): number;               // -1 when malformed
// shape.ts
export interface Shaped { obj: Obj; text: string; isError: boolean }
export function shapeOk(c: Call, stdout: string, scope: string, o: Opts): Shaped;     // parse, envelope, strip, paginate, cap
export function shapeExit(c: Call, code: number, stdout: string, stderr: string, scope: string, o: Opts): Shaped; // exit≠0: contention exit 3 = data, fleet "usage"+"no hosts" = configured:false, else the stderr {"error"} as isError
export function errorShaped(code: string, message: string, hint: string): Shaped;     // timeout busy no_cli contract no_project
export function stripContent(tool: string, v: Obj): Obj;       // spec §8.1 table
export function capList(rows: Obj[], extra: Obj, maxBytes: number): { rows: Obj[]; truncated: boolean };
export function capObject(v: Obj, maxBytes: number): Obj;      // trims files tools errors repeats events programs models from the end; sets truncated: [names]
```
The argv mapping is exactly the "child argv" column of spec §4. `--format json` is always added where the command takes `--format`; `--json` is used for `triage`, `compare`, `wait`, `fleet status` and `prices`. `o.allProjects` → `--all-projects` for every command that lists it, and `o.redact` → `--redact`. Default `--fields`: spec §4 "default fields"; `errors` adds `text` only with `o.content`.

- [ ] **Step 1: Write the failing check** `src/mcp/tools.check.ts`:
  1. **Goldens.** `JSON.stringify(toolsList("2025-11-25"))` equals `testdata/mcp/tools-2025-11-25.json` with its trailing newline trimmed, and the same for `2024-11-05`. The latter has no `outputSchema`, `title` or `annotations` key anywhere. The `2025-11-25` result is ≤ 9,216 bytes. Every description is ≤ 200 characters.
     - To create the goldens the first time, run the check with `MCP_GOLDEN_WRITE=1`. It writes both files and fails with "goldens written: review them". Commit them only after reading them.
  2. **Mapping**, one case per tool. For example:
     - `plan("sessions", {since:"7d", live:true, limit:5, cursor: encodeCursor(10)}, d)` → argv `["sessions","--since","7d","--live","--limit","16","--format","json","--fields","id,harness,title,project,updated,live,status,costUsd,attention,stuck"]`, offset 10, limit 5.
     - `plan("session", {}, d)` → `["session","current","--format","json","--fields",…]`.
     - `plan("compare", {sessions:["last","current"]}, d)` → `["compare","last","current","--json"]`; `{a:"model ~ opus", b:"model ~ sonnet"}` → `["compare","--a=model ~ opus","--b=model ~ sonnet","--json"]`.
     - `plan("contention", {kind:"test"}, d)` → `["wait","--check","--json","--kind","test"]`.
     - `plan("fleet", {}, d)` → `["fleet","status","--json"]`, never `--refresh`.
     - With `allProjects`, each command that takes `--all-projects` gets it (session, sessions, errors, cost, triage, related, waits).
  3. **Validation** gives a non-empty `err` and an empty argv for:
     - `ref:"--all-projects"`, `ref:"a b"`, `ref` of 129 characters;
     - `filter` of 513 characters, `filter:"--x"`;
     - `limit:0`, `limit:101`, `limit:"5"`;
     - `harness:"cursor"`, `fields:["nope"]`, `fields:["--all-projects"]`;
     - `compare` with both `sessions` and `a`, or `a` without `b`;
     - `minutes:61`, `cursor:"zz"`, an unknown property `{x:1}`.
  4. **Cursor.** `decodeCursor(encodeCursor(40)) === 40`; `decodeCursor("o:1") === -1` (not base64url of the prefix form).
  5. **Shaping.**
     - `shapeOk` for `sessions` with 21 rows of stdout, offset 0, limit 20 → 20 rows and `next` = `encodeCursor(20)`.
     - `contention`: exit 3 with `check.over:true` → `go:false`, not `isError`. `advice` starts with `"3 heavy commands running"`.
     - `fleet`: exit 2 with `{"error":{"code":"usage","message":"no hosts configured"}}` → `{hosts:[],configured:false}`.
     - `session`: exit 3 `no_current_session` → `isError` with the code and hint.
  6. **Content.**
     - `stripContent("session", {errors:[{tool:"Bash",text:"CANARY"}]})` has no `text`.
     - `related` drops `text` for kinds `prompt` and `agent` and keeps it for `shell`.
     - With `content:true`, `shapeOk` keeps them.
  7. **Cap.**
     - 200 rows of 300 bytes with `maxBytes` 24,000 → `JSON.stringify` of the envelope ≤ 24,000 and `truncated:true`.
     - An object with `files` of 500 entries → it fits and `truncated` includes `"files"`.
     - A single 30 KB row → `{id, truncated:true}`.
  8. **Schema drift.** Every `outputSchema` property name of `session`, `sessions` and `errors` rows is in `cli-fields.json` for that command, or in `["scope","next","truncated","rows","via"]`. Every `fields` enum equals the recorded list.

  Run: `scriptc build --optimization dev --strip src/mcp/tools.check.ts -o $C/tools && (cd "$(git rev-parse --show-toplevel)" && $C/tools)`. Expected: the build fails.
- [ ] **Step 2: Implement** `tools.ts` and `shape.ts`:
  - Schemas are built as `Obj` literals with `additionalProperties: false`.
  - `advice` text: `"<n> heavy command(s) running (<family ×k, …>): wait or run a subset"` when `!go`, else `"<n> heavy command(s) running: go"`.
  - The `instructions` text and the descriptions follow spec §3.2 and §4.3.
- [ ] **Step 3: Write the goldens** with `MCP_GOLDEN_WRITE=1 $C/tools`. Read both files and check the descriptions say when to call each tool. Then run `$C/tools`. Expected: `tools: all checks passed`. Also build with `--backend c`; expected the same.
- [ ] **Step 4: Commit** `feat(mcp): tool definitions, validation, result shaping and golden schemas`.

---

### Task 3: Child runner (`src/mcp/run.ts`) — wave 1, parallel with T1, T2, T4

**Files:** Create `src/mcp/run.ts`, `src/mcp/run.check.ts`.

**Interfaces — Produces:**
```ts
export const SESSION_VARS: string[];   // copy of agentenv.ts SESSION_VARS (no import: src/mcp stays light); T4's check asserts equality
export interface Job { id: string; argv: string[]; keepSession: boolean; timeoutMs: number; progress: string /* progressToken as JSON text, "" none */; label: string }
export interface Done { code: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; ms: number }
export interface RunCfg { bin: string; cwd: string; env: Record<string, string>; max: number; queueMax: number; beatMs: number }
export interface Runner { cfg: RunCfg; running: number; queued: number; timers: number }
export function newRunner(cfg: RunCfg): Runner;
export function submit(r: Runner, j: Job, onProgress: (token: string, sec: number, label: string) => void, done: (d: Done) => void): boolean; // false = busy (queue full)
export function cancel(r: Runner, id: string): boolean;    // queued → dropped (done never called); running → SIGTERM, SIGKILL after 1 s, done never called
export function killAll(r: Runner): void;                  // shutdown: every child SIGTERM, then SIGKILL after 1 s
export function childEnv(env: Record<string, string>, keepSession: boolean): Record<string, string>; // + AGENTGLASS_AGENT=1, NO_COLOR=1; minus SESSION_VARS unless keepSession
export function cliBin(execPath: string, env: Record<string, string>): string;  // AGENTGLASS_MCP_BIN, else dirname(execPath)/agentglass
export function childCwd(cwd: string, home: string): string; // "" when cwd is home or "/" (main.ts then resolves the session cwd once)
```
`Runner.timers` counts armed timers (timeouts, beats, kill escalations), so the check can assert 0 when idle.

- [ ] **Step 1: Write the failing check** `src/mcp/run.check.ts`. It uses `bin = "/bin/sh"` and argv `["-c", "<script>"]`, so stub children come from the jobs themselves. Cases are driven by `setTimeout` chains and a final summary:
  1. `echo '{"a":1}'` → `code 0`, stdout `{"a":1}\n`.
  2. `echo '{"error":{"code":"x"}}' >&2; exit 3` → code 3, stderr has it.
  3. **Concurrency.** Submit 11 `sleep 0.3` jobs with `max 2`, `queueMax 8`: 10 are accepted and the 11th `submit` returns false. The peak of `running` is 2.
  4. **Timeout.** `trap '' TERM; sleep 5` with `timeoutMs 200` → `timedOut` true, done within 1.4 s (SIGKILL after 1 s).
  5. **Cancel.**
     - A running `sleep 5` → its pid is gone within 1.2 s (`kill -0` from `process.kill(pid, 0)` throws) and `done` is not called.
     - A queued job → dropped, never spawned.
  6. **Progress.** `sleep 2.3` with token `"7"` and `beatMs 1000` → 2 beats with sec 1 and 2. With token `""` → 0 beats.
  7. **Env.** `childEnv({CLAUDE_CODE_SESSION_ID:"x", PATH:"/bin"}, false)` has no `CLAUDE_CODE_SESSION_ID`, `AGENTGLASS_AGENT` = `"1"` and `NO_COLOR` = `"1"`; with `keepSession` true it keeps the id.
  8. **Paths.** `childCwd("/home/u","/home/u") === ""`, `childCwd("/","/home/u") === ""`, `childCwd("/w/p","/home/u") === "/w/p"`. `cliBin("/opt/x/agentglass-mcp", {})` is `"/opt/x/agentglass"`; with `AGENTGLASS_MCP_BIN` set, it is that value.
  9. **Idle.** After everything has finished, `r.timers === 0` and `r.running === 0`.

  Run: `scriptc build --optimization dev --strip src/mcp/run.check.ts -o $C/run && $C/run`. Expected: the build fails.
- [ ] **Step 2: Implement** `run.ts`:
  - `spawn(cfg.bin, argv, { stdio: ["ignore","pipe","pipe"], env, cwd })`, accumulating `Uint8Array` chunks and decoding on `"close"`.
  - Every timer is registered in `r.timers` and cleared on finish.
  - The queue is FIFO. Under `max` it starts at once; otherwise it starts on the next `"close"`.
- [ ] **Step 3: Run** the check. Expected: `run: all checks passed` in ≤ 10 s. Also build with `--backend c`.
- [ ] **Step 4: Commit** `feat(mcp): child runner with queue, timeout, cancel and progress`.

---

### Task 4: CLI `via` in `session`, the process-tree regression — wave 1, parallel with T1, T2, T3

**Files:** Modify `src/features/queries.ts` (`session()` at `:390-396`, `SESSION_FIELDS` at `:389`), `src/features/agentenv.ts` (export the `via` of the resolution, unchanged precedence). Modify `src/features/watchdog.check.ts` (it holds the `toolShells` cases, e.g. "cmds skip mcp" at `:26-29`), `src/features/agentenv.check.ts` and `src/features/wait/live.check.ts`. Re-record `testdata/mcp/cli-fields.json`.

**Interfaces — Produces:** the `session` output gains `via: string`: `"env:<VAR>"`, `"ancestor:pid N"`, `"env:<VAR>+ancestor:pid N"` for `current`/`parent`, and `"ref"` for every other ref. It comes last in `SESSION_FIELDS`. This is an additive contract-1 field.

- [ ] **Step 1: Failing checks.**
  - In `watchdog.check.ts` (next to "cmds skip mcp"), build a tree:
    - harness `claude` (pid 100) → `agentglass-mcp` (pid 200, args `/opt/bin/agentglass-mcp`) → `agentglass session current --format json` (pid 300);
    - plus a shell `/bin/zsh -c pnpm test` (pid 400) under 100.
  - Assert `toolShells(100, kids)` is exactly `[400]`.
  - In `wait/live.check.ts`, add the same tree and assert that `collectLive` lists no run whose family starts with `agentglass`.
  - In `src/features/agentenv.check.ts`, assert `SESSION_VARS` equals `["CLAUDE_CODE_SESSION_ID","OPENCODE_SESSION_ID","CODEX_THREAD_ID","KIRO_SESSION_ID","PI_SESSION_ID"]`. T3 copies the list; this pins both.
  - In `scripts/agent-mode.test.sh`, `session current --fields via` with `CLAUDE_CODE_SESSION_ID` set → `{"via":"env:CLAUDE_CODE_SESSION_ID"}`, and `session <id> --fields via` → `{"via":"ref"}`.

  Run: `scriptc build --optimization dev --strip src/features/watchdog.check.ts -o $C/wd && $C/wd; sh scripts/agent-mode.test.sh`. Expected: `via` cases fail. The `toolShells` and `collectLive` cases are expected to **pass** already (spec, Today: MCP servers are spawned directly); they are regression pins.
- [ ] **Step 2: Implement.** `resolveOrFail` returns `{s, via}`, and `sessionObj` callers in `session()` set `o["via"]`.
- [ ] **Step 3: Re-record** `testdata/mcp/cli-fields.json` with T0 Step 2's command against a fresh build. Expected diff: `session` gains `"via"` only.
- [ ] **Step 4: Run** `./build.sh && sh scripts/check.sh`. Expected: all `ok`; `contract.test.sh` passes (additive field).
- [ ] **Step 5: Commit** `feat(cli): session reports how the session was resolved (via)`.

---

### Task 5: `agentglass-mcp` entry, build, test client, end-to-end test — wave 2, alone

**Files:**
- Create `src/mcp/main.ts`, `scripts/mcp-client.py`, `scripts/mcp.test.sh`, `scripts/mcp-imports.test.sh`.
- Modify `build.sh` (second target), `.gitignore` (`agentglass-mcp`).

**Interfaces — Consumes:** T1–T4 exactly as declared. **Produces:**
- **The binary:** `agentglass-mcp [--all-projects] [--content] [--redact] [--max-bytes N] [--timeout S] [--log] [--version] [--help]`.
  - `--version` prints `BUILD.version` (the same string as `agentglass --version`).
  - A bad option exits 2 with `agentglass-mcp: <msg> (agentglass-mcp --help)` on stderr.
- **The test client** `scripts/mcp-client.py`, stdlib only:
  ```
  mcp-client.py [--cwd D] [--version V] [--timeout S] -- <server argv…>   < script.jsonl
  ```
  The script holds one JSON-RPC message per line, plus directives `{"sleep": ms}`, `{"close": true}` (close stdin), `{"expect_none": id, "ms": 1500}`. The client prints every server line as it arrives, prefixed with ms since start (`<ms>\t<json>`). It exits 0 when the server exits or after `--timeout`, then 1.

- [ ] **Step 1: The import guard** `scripts/mcp-imports.test.sh`: `grep -hE '^import' src/mcp/*.ts | grep -vE 'from "node:|from "\./|util/json\.ts|build-info\.ts'` must print nothing. Expected now: it passes (T1–T3 comply).
- [ ] **Step 2: Write the failing end-to-end test** `scripts/mcp.test.sh`, in the style of `scripts/contract.test.sh`, with the header line `# check: builds 1` (shard weight for `scripts/check-plan.mjs`):
  - a private source copy, `build.sh` into `$t`;
  - a fixture HOME with Claude sessions in p1 and p2;
  - `env -i HOME=$h PATH=$PATH AGENTGLASS_CACHE_DIR=$t/cache AGENTGLASS_CONFIG=$t/config.json AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_HERDR=off …`;
  - skip with a message without python3 or cc.

  Cases (spec Testing 1–8):
  1. **Conformance** under both `2025-11-25` and `2024-11-05`.
     - `tools/list` equals the golden.
     - Each tool with `{}` (compare with `{"sessions":["last","last"]}`) → `isError` false; `fleet` → `configured:false`.
     - `{"name":"nope"}` → `-32602`; `sessions` with `{"limit":0}` → `isError` true.
     - Under `2024-11-05`, no `structuredContent` appears.
  2. **Identity.**
     - `cc -O2 -o $t/bin/fake-agent scripts/fake-agent.c && ln -s fake-agent $t/bin/claude`.
     - The fake `claude` holds p1's session transcript open (`--open`) and runs `mcp-client.py` as its child script, with `CLAUDE_CODE_SESSION_ID` set to the **p2** session.
     - `session {}` → the p1 session, and `via` starts with `ancestor:pid`.
  3. **Scope.**
     - A server with cwd p1 → `sessions {"since":"30d"}` rows only from p1, and `scope` `"project"`.
     - With `--all-projects` → rows from both, and `scope` `"all"`.
     - A server with cwd `$h` under the fake agent → p1 rows (cwd from the session).
  4. **Canary.** The fixture has `CANARY-7f3a` in a tool result, in a second user prompt and in assistant text. Grepping all outputs of case 1 finds no `CANARY-7f3a`. `errors` with `--content` finds it.
  5. **Redact.** With `--redact`, the `initialize` `instructions` lack `p1` and the `sessions` titles differ from the fixture titles.
  6. **Cancel.**
     - `AGENTGLASS_MCP_BIN=$t/slow.sh` (prints its pid to `$t/slow.pid`, then `sleep 30`).
     - Send `tools/call` id 5, `{"sleep":300}`, `notifications/cancelled {"requestId":5}`, `{"expect_none":5,"ms":1500}`.
     - The slow pid is gone (`kill -0` fails).
  7. **Shutdown.** The same slow stub, then `{"close":true}` → the server exits within 1.5 s and the stub pid is gone.
  8. **wait.** The fake agent from case 2, with the server's child running (`slow.sh`), plus `agentglass wait --now --json` (isolation set) → no `running[].family` starting with `agentglass` or `slow`.

  Run: `sh scripts/mcp.test.sh`. Expected: it fails at the build (no `src/mcp/main.ts`).
- [ ] **Step 3: Implement `src/mcp/main.ts`:**
  - `parseOpts`. Then the framer on `process.stdin` `"data"`, with `"end"` → `killAll` and exit 0. `SIGTERM`/`SIGINT` do the same.
  - `answer()` handles the sync methods.
  - **`tools/call`:**
    - `plan()`; an unknown tool → `-32602`; a non-empty `err` → `isError`.
    - Then, once per server and cached by `cliBin` path + mtime, `agentglass --version --json` → contract ≥ 1, else `contract`. A missing binary → `no_cli`.
    - When `childCwd` is `""` and the tool is project-scoped without `--all-projects`, resolve `session current --all-projects --fields cwd` once (the session lies outside `$HOME`'s scope; only `cwd` is read and never returned). Failure → `no_project`.
    - `submit` with the `progressToken` from `params._meta.progressToken`. On `done`: `shapeExit`/`shapeOk`.
    - On `no_current_session` with a session var in the env, resubmit once with `keepSession: true`.
    - Respond with `{content:[{type:"text",text}], structuredContent?: obj, isError?: true}`.
  - **`notifications/cancelled`** → `cancel`.
  - **Output** goes through one `send(line)` that loops `writeSync(1, …)` over the encoded bytes. EPIPE → `killAll`, exit 0.
- [ ] **Step 4: `build.sh`.** After the main build, add `scriptc build ${SCRIPTC_FLAGS:-} "${AGENTGLASS_SRC:-src}/mcp/main.ts" -o "${AGENTGLASS_MCP_OUT:-$(dirname "${AGENTGLASS_OUT:-agentglass}")/agentglass-mcp}"`. No `--ffi`: `src/mcp` reads no processes.
- [ ] **Step 5: Run** `./build.sh && ./agentglass-mcp --version && sh scripts/mcp.test.sh && sh scripts/mcp-imports.test.sh`. Expected:
  - the version equals `./agentglass --version`;
  - `mcp: all tests passed`;
  - the import guard prints nothing.
- [ ] **Step 6: Run** `sh scripts/check.sh`. Expected: all `ok`.
- [ ] **Step 7: Commit** `feat(mcp): agentglass-mcp stdio server`.

---

### Task 6: `agentglass mcp install | doctor` — wave 3, parallel with T7

**Files:** Create `src/features/mcp-cli.ts`, `src/features/mcp-cli.check.ts`, `scripts/mcp-install.test.sh`. Modify `src/main.ts` (one import line after `./features/fleet/cli.ts`) and `README.md` (new "MCP server" section after the agent-mode section).

**Interfaces — Produces:**
```ts
export interface Reg { harness: string; found: boolean; print: string; argv: string[] /* [] = print-only */ }
export function regs(bin: string, opts: string[], scope: string, which: string[], onPath: (cmd: string) => boolean): Reg[]; // pure; spec §9.1 table
export function serverCmd(execPath: string, which: (c: string) => string): string; // "agentglass-mcp" if PATH resolves to the sibling, else absolute
```
CLI per spec §9: `mcp` (bare), `mcp install`, `mcp doctor`, with help records via `addCmd`. Not in `compactHelp` (`clihelp.check.ts` asserts that the compact help stays ≤ 1.5 KB and has no `mcp`).

- [ ] **Step 1: Failing pure check** `mcp-cli.check.ts`:
  - `regs` for each harness gives the exact `print` text and `argv` of the spec §9.1 table, for `--scope user` and `project`, and with options `["--all-projects","--content"]`. Expected claude argv: `["claude","mcp","add","--scope","user","agentglass","--","agentglass-mcp","--all-projects","--content"]`.
  - OpenCode `argv` is `[]`.
  - `serverCmd` returns the bare name only when `which("agentglass-mcp")` equals the sibling path.
- [ ] **Step 2: Failing shell test** `scripts/mcp-install.test.sh`:
  - Stub `claude`, `codex`, `gemini`, `pi`, `kiro-cli` and `opencode` scripts in `$t/stubs` append `"$0 $*"` to `$t/calls.log`. `PATH=$t/stubs:$PATH`.
  - `agentglass mcp install` → exit 0, prints 6 headings, and `calls.log` stays empty.
  - `--write` with stdin from `/dev/null` and no `--yes` → exit 2, a hint naming `--yes`, and `calls.log` empty.
  - `--write --yes --harness claude` → `calls.log` has exactly `claude mcp add --scope user agentglass -- agentglass-mcp` (stub path prefix stripped).
  - `--harness opencode --write --yes` → exit 0, prints the snippet and "print-only", and `calls.log` empty.
  - With `CLAUDECODE=1` (agent mode), `install` prints JSON `{"harnesses":[…]}`.
  - Bare `agentglass mcp < /dev/null` with `AGENTGLASS_AGENT=0` → exit 2 and the stderr line `the MCP server is agentglass-mcp: run agentglass mcp install`.
  - `agentglass mcp doctor --json` → `ok:true`, `tools:11`, a `protocol` field, and `current.code` `no_current_session` (no agent around).
- [ ] **Step 3: Implement.**
  - `--write` on a TTY asks `y/N` per harness through the existing `interactive()` (`agentenv.ts:104`).
  - `doctor` spawns `agentglass-mcp`, speaks JSON-RPC itself (the same framing as T1, imported from `src/mcp/rpc.ts`), sends `session {}`, and times it.
- [ ] **Step 4: README.** Add an "MCP server" section:
  - what it is;
  - `agentglass mcp install`;
  - the tool table (name + one line);
  - privacy (project scope, content off, `--redact`, output goes to the model provider);
  - the hosts table (verified: Gemini CLI, pi; expected: Claude Code, Codex, Kiro; unverified: OpenCode, per open question 3);
  - `doctor`.
  - Keep it at 80 columns.
- [ ] **Step 5: Run** `./build.sh && sh scripts/mcp-install.test.sh && sh scripts/check.sh`. Expected: all `ok`.
- [ ] **Step 6: Commit** `feat(mcp): agentglass mcp install and doctor`.

---

### Task 7: Packaging: archive, install.sh, formula, update — wave 3, parallel with T6

**Files:** Modify `scripts/package.sh:14-17`, `install.sh:70-76`, `scripts/formula.sh` (install block `:56-62`), `src/features/update.ts:156` and `:166-180`, `.github/workflows/build-artifacts.yml`, and the tests that cover them (`scripts/install.test.sh`, `scripts/formula.test.sh`, `scripts/update.test.sh`, `scripts/verify-release-assets.test.sh`).

- [ ] **Step 1: Failing tests.**
  - `package.sh`: `agentglass-mcp` is missing → exit 1 `"package.sh: agentglass-mcp missing"`. A version mismatch → exit 1. The archive lists `agentglass agentglass-mcp [agentglass-receive-tls]`.
  - `install.test.sh`: after install, `$prefix/agentglass-mcp --version` equals the version.
  - `formula.test.sh`: the rendered formula has `bin.install "agentglass-mcp"` (unconditional) and a test line `assert_match version.to_s, shell_output("#{bin}/agentglass-mcp --version")`.
  - `update.test.sh`: a fake release archive with both binaries → both replaced; one without `agentglass-mcp` → `partial` line `"this release has no agentglass-mcp: the old one is kept"`, and the old file is still there.
- [ ] **Step 2: Implement.**
  - Mirror `updateTls` as `updateSibling(name, required)`, a shared helper for both siblings.
  - `agentglass-mcp` is required in `package.sh` and optional (kept) in `update` for older archives.
  - `build-artifacts.yml` uploads it in the archive. `build.sh` already builds it (T5), for the C backend too.
- [ ] **Step 3: Run** `sh scripts/install.test.sh && sh scripts/formula.test.sh && sh scripts/update.test.sh && sh scripts/verify-release-assets.test.sh && sh scripts/check.sh`. Expected: all `ok`.
- [ ] **Step 4: Commit** `build(release): ship agentglass-mcp in every archive, formula and update`.

---

### Task 8: Contract, footprint, live hosts, open questions, final review — wave 4, alone

**Files:** Modify `docs/cli-contract.md` (new section "MCP server (`agentglass-mcp`)"), `scripts/contract.test.sh`, `CHANGELOG.md` ("Added" + "Contract: additive"), `README.md` (host table results), `specs/mcp-server/spec.md` (answer open questions). Create `scripts/mcp-footprint.sh` (manual) and `scripts/mcp-live.sh` (manual).

- [ ] **Step 1: Contract doc.**
  - Add the tool table: names, input properties with types, enums and defaults, the envelope, error codes and `_meta["agentglass/contract"]`.
  - Add `session.via` to the `session` field list.
  - Extend `contract.test.sh` with a python block. It starts `agentglass-mcp` on its fixture HOME, runs `tools/list`, and asserts every tool and input property in the doc's MCP table exists with the documented type. Expected: `contract: ok`.
- [ ] **Step 2: Footprint** `scripts/mcp-footprint.sh <bin-dir> <n>`. It starts n servers, each under `mcp-client.py` with a script that initializes, lists the tools, sleeps 60 s and closes. It samples `/proc/<pid>/smaps_rollup` (`Private_Dirty`, `Rss`) and `/proc/<pid>/stat` utime+stime at 5 s and 60 s.
  - Run `nice sh scripts/mcp-footprint.sh $C/rel 1` and then `… 36` on a release build, with the isolation set and a copy of a real ledger cache in `$S/cache`.
  - Expected: per server Private_Dirty ≤ 1 MB, RSS ≤ 4 MB, Δ CPU ticks 0; 36 servers ≤ 40 MB Private_Dirty summed.
  - Then time 10 warm `session {}` and `contention {}` calls through one server: p95 ≤ 1.5 s and ≤ 1 s. The server's own utime+stime delta per call is ≤ 5 ms (on Linux the CPU of waited children is counted separately as cutime).
  - Paste the table into the PR.
- [ ] **Step 3: Live hosts** `scripts/mcp-live.sh`, manual and not in `check.sh`, with an isolated `HOME=$C/live/home` and no model call:
  - **Gemini.** `$HOME/.gemini/settings.json` = `{"mcpServers":{"agentglass":{"command":"<abs agentglass-mcp>"}}}` and `trustedFolders.json` trusting `$C/live/proj`. `(cd $C/live/proj && HOME=$C/live/home gemini mcp list)`. Expected: `✓ agentglass: … (stdio) - Connected`.
  - **pi.** `$HOME/.pi/agent/mcp.json` with the same entry. `HOME=$C/live/home PI_CODING_AGENT_DIR=$C/live/home/.pi/agent pi mcp list --json`. Expected: `"state": "connected"` and 11 tools.
  - **OpenCode** (open question 3): try `opencode mcp list --print-logs --log-level debug` with an isolated `XDG_*`. Record the result; no hang longer than 60 s (`timeout 60`).
  - Never `claude` or `codex`.
- [ ] **Step 4: Open questions.** Answer each in spec.md:
  1. **Claude registry `/clear`:** a fixture registry rewritten mid-test in `mcp.test.sh` case 2 (session A → B for the same pid) → `session {}` returns B.
  2. **Codex MCP env and cwd:** `npx opensrc https://github.com/openai/codex` in `~`, then `grep -rn "DEFAULT_ENV_VARS\|fn create_env_for_mcp_server" -A20 ~/opensrc/*codex*/codex-rs | head -60` and the stdio spawn's `current_dir`. Record the result in the README host table.
  3. **OpenCode:** Step 3.
  4. **Cold cache under timeout:** an empty `AGENTGLASS_CACHE_DIR`, `agentglass-mcp --timeout 5`, two `sessions {}` calls. Record whether the second gets further (the cache dir size grows). If not, add to the README: "first call after install: run `agentglass` once".
  5. **`structuredContent`:** from Step 3's hosts, record which content a host shows (pi `--json` lists tools only; mark as unverified otherwise).
- [ ] **Step 5: Final review.**
  - Run `./build.sh && sh scripts/check.sh` and `SCRIPTC_FLAGS="--backend c" AGENTGLASS_OUT=$C/cbin/agentglass ./build.sh` (both binaries build with the C backend).
  - Request a code review (superpowers:requesting-code-review) with the Review Focus list.
  - Fix the findings, update `CHANGELOG.md`, and commit `docs(mcp): contract section, host table, measurements`.

---

## Self-review (plan vs spec)

- Spec §1 architecture → T3, T5; §2 transport → T1, T5; §3 protocol → T1, T5; §4 tools → T2; §5 shaping → T2; §6 scope/options → T2, T3, T5; §7 identity → T3, T4, T5; §8 privacy → T2, T5; §9 `agentglass mcp` → T6; §10 contract → T2, T8; §11 packaging → T5 (build), T7.
- Each Testing bullet in the spec maps to a check or test step above. The footprint and live-host steps are manual (T8), as `scripts/footprint.sh` is today.
- Open questions 1–5 → T8 Step 4.
