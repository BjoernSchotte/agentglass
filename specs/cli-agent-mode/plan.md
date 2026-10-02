# CLI Agent Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a coding agent runs `agentglass`, it never opens the TUI and never prompts: bare `agentglass` prints a compact JSON help, output defaults to compact JSON, errors are one JSON line on stderr, and four query commands (`session`, `sessions`, `errors`, `cost`) answer the questions agents ask, scoped to the current project by default. `--format json|jsonl|csv|table` and `--fields` work for everyone.

**Architecture:** `src/features/agentenv.ts` detects agent mode once from flags and environment markers, and resolves the "current" session lazily through the process ancestry. Help becomes typed records (`src/features/clihelp.ts`) that render both the text help and the JSON help. Every command builds plain row objects and hands them to one formatter (`src/features/format.ts`). The query commands live in `src/features/queries.ts` and read the ledger, filter-language's shared aggregation and per-call rows, repo-view's project identity and honest-costs' billing labels.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh` (PTY via `script -qc`).

**Spec:** [spec.md](spec.md) — binding; this plan argues from it, including "Decisions (review 2026-10-02)".

**Phase:** 7. Starts when phases 1–6 are merged; it uses honest-costs (`billing`, unpriced tokens, per-model day buckets `Day.mt`/`Day.um`/`modelUses()`), filter-language (`aggregate()`, per-call rows, `--filter`) and repo-view (`identOfCwd`). No other phase-7 plan is required; recommended merge order inside phase 7: cli-agent-mode → related-events → command-palette → adaptive-refresh, because command-palette's `open` registers a help record here, uses `agentHost()` and the `--format table` OSC 8 column, and shares the session-ref resolver (`src/model/sessref.ts`) this plan creates.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields); call optional function members via a local (`process.getuid`, adapter hooks); out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log` (p50 via sorted index, no logarithms).
- Outside agent mode nothing changes except that `--format`, `--fields` and the query commands exist: `--help` text, `--json` (still JSON, pretty on a TTY), `--watch` and the TUI behave as on `main`. `./agentglass --json --subagents --limit 400` identical before/after except volatile fields (`updated bytes activity live pid status attention stuck`).
- Agent mode: never start the TUI, never read stdin, no ANSI colours, no OSC sequences, compact JSON; errors only as `{"error":{"code","message","hint"?}}` on stderr with stdout empty. Exit codes: 0 ok (empty result ok), 1 runtime, 2 usage, 3 not found, 4 ambiguous.
- Privacy: agent-mode queries see only the current project unless widened (`--all-projects`, config `agent.scope: "all"`); `--project-only` narrows a configured `all`. `--redact` applies unchanged; error `text` ≤ 200 chars and through `scrubText` when redaction is on. No credentials in output, argv of children or logs. No network.
- Ledger cache: no change and no `VERSION` bump. Per-model tokens and cost come from honest-costs' day buckets (`Day.mt`, `Day.um`, `modelUses()`, phase 1; spec Decision 3).
- Style: match the surrounding code — dense one-line helpers, short `//` why-comments, no new dependencies.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-cli-agent-mode`, branch `feat/cli-agent-mode`, PR to `main`, rebase-merge after green CI.

## Review Focus

1. **The TUI starts inside an agent's PTY** — with any env marker, bare `agentglass` must exit 0 within 2 s with the compact help (valid JSON, ≤ 1 KB), and `update --tag <older>` must exit 2 without reading stdin. Task 3 checks + Task 10 `scripts/agent-mode.test.sh` under `script -qc`.
2. **Wrong "current" session** — nested agents (nearest ancestor wins, `via` names both), an env id that is not found (falls back to ancestry with a warning), a subagent shell (`--root` goes up), a missing `ps` (env ids only). Task 2 `agentenv.check.ts`.
3. **Scope leak** — agent mode must never print sessions of another project unless widened; `scope` in the envelope and help states the effective scope. Task 5 `sessref.check.ts` + Task 8 `queries.check.ts`.
4. **CSV/table correctness** — quoting, embedded newlines and quotes, the formula guard (`= + - @`), flattening (`tokens_in`), `null` → empty, CJK/emoji widths and `…` cuts, `--fields` order and unknown-field exit 2. Task 4 `format.check.ts` golden tests.
5. **`cost` totals** — `cost --by model` totals equal the Stats totals for the same days; unpriced tokens never show as `$0`. Task 9 `queries.check.ts`.

---

### Task 0: Worktree, prerequisites, open questions

**Files:** none committed.

- [ ] **Step 1: Worktree** `git worktree add -b feat/cli-agent-mode ../agentglass-cli-agent-mode main && cd ../agentglass-cli-agent-mode && ./build.sh && sh scripts/check.sh` → Expected: build OK, all `ok`. Save goldens from this build: `./agentglass --help > /tmp/agm-help-main.txt; ./agentglass --json --subagents --limit 400 > /tmp/agm-json-main.json`.
- [ ] **Step 2: Prerequisite names** (stop if missing — the prerequisite plan is not merged):
  - `grep -n "export function costNow" src/features/usage/summary.ts; ls src/features/cost-cli.ts` → honest-costs' `agentglass cost` (Task 9 extends it).
  - `grep -rn "export function aggregate\|export function totals\|export function parse\b\|export function compile\|export function eachCall" src/features/query` → filter-language's `parse(src): Parsed`, `compile(cs, ctx): { f, err }`, `aggregate(f, entity, days, dims, weight)`, `totals(f, days)`, `eachCall(f, days, fn)` over the per-call rows (`filter.callDays`).
  - `grep -rn "export function identOfCwd\|export function realCwd" src` → repo-view identity (`identOfCwd(cwd): Ident | null`).
  - `grep -rn "billing\|unpriced" src/features/usage/billing.ts src/features/cli.ts` → honest-costs' per-session `billing: {mode, plan, source}` and `unpricedTokens`.
- [ ] **Step 3: Per-model tokens.** `grep -n "mt:\|um:\|export function modelUses\|export interface ModelUse" src/features/usage/record.ts` → Expected: honest-costs' `Day.mt: Map<string, number[]>` (model → `[in, out, cacheRead, cacheWrite, costUsd]`), `Day.um` (unpriced tokens per model) and `modelUses(a: Acc, days: string[] | null): ModelUse[]` with `ModelUse { model, inTok, outTok, cr, cw, cost, unk }`. Missing → stop (honest-costs not merged).
- [ ] **Step 4: Open question 1 — Codex session id.** `mkdir -p /tmp/agtest-agent && cd /tmp/agtest-agent && codex exec --skip-git-repo-check 'Run exactly this shell command and print its output verbatim: env | grep -E "^(CODEX|AI_AGENT|AGENT)"'`; then `f=$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1); head -c 4000 "$f" | grep -o '"id":"[^"]*"' | head -1`. Expected evidence: the printed `CODEX_THREAD_ID` equals the rollout's `session_meta` id. Repeat once with unified exec enabled if the installed version has a flag for it (`codex --help | grep -i unified`). **Fallback:** variable absent → keep it as a marker only if any `CODEX_*` marker is set and resolve the session by ancestry; value ≠ rollout id → do not use it as a session id (marker only). Update the spec's table row in the PR description, not the spec.
- [ ] **Step 5: Open question 2 — Kiro.** `kiro-cli chat --help | head -40` to find the non-interactive/trust flags, then run one prompt in `/tmp/agtest-agent` asking it to run `env | grep -iE "kiro|ai_agent|agent"` and print the output. Expected evidence: whether `KIRO_SESSION_ID` (or any marker) is present and whether it equals the session id in `~/.kiro/sessions/cli/`. **Fallback:** no marker → remove `KIRO_SESSION_ID` from the marker list (Task 2) and rely on ancestry (`kiro-cli` is in its adapter's `procs`).
- [ ] **Step 6: Claude Code live row** (re-confirm): from this agent's shell `env | grep -E "^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ID|AI_AGENT)="` → Expected: all four present; `CLAUDE_CODE_SESSION_ID` equals a `~/.claude/projects/*/<id>.jsonl` file name.
- [ ] **Step 7:** Not installed harnesses (`command -v codex kiro-cli gemini pi opencode`) → note them; their rows stay as specified and the Task 11 live check skips them.

---

### Task 1: Help as typed records (no behavior change)

**Files:** Create `src/features/clihelp.ts`, `src/features/clihelp.check.ts`; Modify `src/features/cli.ts` (`CMDS`/`OPTS`/`usage()` at `:15-54` become records + `textHelp()`).

**Interfaces — Produces:**
- `export interface OptRec { flag: string; arg: string; summary: string; def: string; values: string[] }`
- `export interface CmdRec { cmd: string; usage: string; summary: string; options: OptRec[]; fields: string[]; group: string }` — `group` `"cmd"` (usage table) or `"opt"` (the `--json`/`--watch` option table) so the text layout stays identical.
- `export const REG: CmdRec[]`; `export function addCmd(c: CmdRec): void` (other features — `export`, `open` — register theirs).
- `export function textHelp(head: string, tail: string): string` — renders the two aligned tables exactly as `usage()` does today (`"  " + padEnd(col)`; `col` = longest first column + 2 over both tables).
- `export function jsonHelp(cmd: string, agent: Obj): string` — `{name, version, agentMode, commands:[{cmd, usage, summary, options:[{flag, arg, summary, default, values}], fields}], formats, exitCodes, examples}`; `cmd` non-empty → only that command (unknown → `""`).
- `export function compactHelp(agent: Obj): string` — `{name, version, agentMode:{harness, session, scope}, commands:[{cmd, summary}], examples:[3], more:"agentglass --help"}`, compact, target ≤ 1024 bytes.
- `export const EXAMPLES: string[]` — five short queries (`agentglass session current --fields costUsd,tools,errors`, `agentglass errors --since 24h --limit 5`, `agentglass session last`, `agentglass cost --since today --by model`, `agentglass sessions --since 24h --format table`); compact help takes the first three.

- [ ] **Step 1: Failing check** `clihelp.check.ts`: `textHelp(...)` with the records ported from `cli.ts` equals the golden text (embed the expected string, copied from `/tmp/agm-help-main.txt` with the version line replaced by the same `BUILD` expression); `jsonHelp("", {})` parses and lists every `REG` command; `jsonHelp("nope", {})` → `""`; `compactHelp({})` parses, has no `options` key anywhere, length ≤ 1024. Run: `scriptc build src/features/clihelp.check.ts -o /tmp/ch && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/ch` → Expected: FAIL (module missing).
- [ ] **Step 2: Implement**; `cli.ts` `usage()` becomes `textHelp(head, tail)` with the same head/tail paragraphs.
- [ ] **Step 3: Run** check → PASS; `./build.sh && ./agentglass --help | diff - /tmp/agm-help-main.txt` → Expected: no diff; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `refactor(cli): help as typed records, text help rendered from them`.

---

### Task 2: Agent detection (`agentenv.ts`)

**Files:** Create `src/features/agentenv.ts`, `src/features/agentenv.check.ts`.

**Interfaces — Consumes:** `allProcs`, `refreshProcs`, `procSess` (`src/model/procs.ts:41-50, 153`), `Proc` (`src/model/types.ts:14`), `sessions` (`src/model/sessions.ts:9`).

**Interfaces — Produces:**
- `export interface AgentHost { on: boolean; harness: string; session: string; via: string }` — `via`: `"flag"`, `"env:<NAME>"`, `"ancestor:pid N"`, `"env:<NAME>+ancestor:pid N"`, or `""`.
- `export const MARKERS: string[]` = `["CLAUDECODE","AI_AGENT","CODEX_SANDBOX","CODEX_SANDBOX_NETWORK_DISABLED","CODEX_CI","CODEX_THREAD_ID","GEMINI_CLI","PI_CODING_AGENT","OPENCODE","OPENCODE_SESSION_ID","KIRO_SESSION_ID"]` (Task 0 Steps 4–5 may drop entries; record the ruling).
- `export const SESSION_VARS: string[]` = `["CLAUDE_CODE_SESSION_ID","OPENCODE_SESSION_ID","CODEX_THREAD_ID","KIRO_SESSION_ID"]` (same rule).
- `export function detectHost(env: Record<string, string>, args: string[]): AgentHost` — pure; precedence spec 1.1–1.2: `--no-agent`/`AGENTGLASS_AGENT=0` → off; `--agent`/`AGENTGLASS_AGENT=1` → on (`via "flag"`); else first marker present → on, harness from the marker (`CLAUDECODE` → claude, `CODEX_*` → codex, `GEMINI_CLI` → gemini, `PI_CODING_AGENT` → pi, `OPENCODE*` → opencode, `KIRO_SESSION_ID` → kiro, `AI_AGENT` prefix `claude-code` → claude, `pi` → pi, `opencode` → opencode, else `""`); `AGENT` alone never; `session` = first `SESSION_VARS` value present.
- `export function ancestry(pid: number, procs: Map<number, Proc>, sessOf: (p: Proc) => string): { harness: string; session: string; pid: number; steps: number }` — walks `ppid` ≤ 64 steps; first `p.h !== ""` gives harness, first `sessOf(p) !== ""` gives session; cycles stop the walk.
- `export function agentHost(): AgentHost` — `detectHost(process.env, process.argv.slice(2))`, cached.
- `export interface Current { s: Sess | null; via: string; code: string; hint: string }` and `export function currentSession(root: boolean): Current` — env session id looked up across all harnesses by exact id; not found → warning `session id from <VAR> not found, using the process tree` and ancestry; ancestry needs `refreshProcs()` + `scan()` + linking; `ps` unavailable (`OS.listProcs()` returns `[]`) → env only + warning; nearest ancestor beats an env marker of a different harness (`via` names both); `root` → walk `parent` up to the top-level session; failures → `code "no_current_session"`, hints `pass a session id or use 'last'` / `session not written yet` (process found, no session).

- [ ] **Step 1: Failing check** `agentenv.check.ts`:
  - table over env fixtures: `{CLAUDECODE:"1", CLAUDE_CODE_SESSION_ID:"abc"}` → `{on, "claude", "abc", "env:CLAUDECODE"}`; `{AI_AGENT:"claude-code_2.1_agent"}` → claude; `{AI_AGENT:"pi"}` → pi; `{AI_AGENT:"cursor"}` → on, harness `""`; `{CODEX_CI:"1", CODEX_THREAD_ID:"t1"}` → codex, `t1`; `{GEMINI_CLI:"1"}` → gemini, session `""`; `{PI_CODING_AGENT:"true"}` → pi; `{OPENCODE:"1", OPENCODE_SESSION_ID:"ses_x"}` → opencode; `{AGENT:"1"}` → off; `{}` → off; `{CLAUDECODE:"1"}` + args `--no-agent` → off; `{AGENTGLASS_AGENT:"0", CLAUDECODE:"1"}` → off; `{}` + `--agent` → on `via "flag"`; `{AGENTGLASS_AGENT:"1"}` → on;
  - ancestry on a synthetic `Map<number, Proc>`: shell 300 → claude 200 (session S1) → zsh 100 → found `{claude, S1, 200}`; nested: shell 400 → codex 350 (S2) → bash 320 → claude 200 (S1) → nearest = codex/S2; wrapper `node` with `h:"claude"` above the real binary → harness from the nearest; a ppid cycle → stops, no hang; 70-deep chain → stops at 64 steps;
  - `currentSession` with a stubbed procs list (`[]`) and `CLAUDE_CODE_SESSION_ID` of a session inserted into `sessions` → that session; unknown id + empty procs → `code "no_current_session"`.
  Run: `scriptc build src/features/agentenv.check.ts -o /tmp/ae && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/ae` → Expected: FAIL.
- [ ] **Step 2: Implement** (`process.env` copied into a `Record<string, string>` dropping `undefined`).
- [ ] **Step 3: Run** → PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(cli): detect agent hosts from flags, environment and process ancestry`.

---

### Task 3: Agent-mode gate — no TUI, no prompts, JSON errors, bounded `--watch`

**Files:** Modify `src/main.ts` (`:57-58`), `src/features/update.ts` (`:120`), `src/features/cli.ts` (`fail()` `:69`, `--watch` options `:71-82`, `watch()` `:133-186`, help records), `src/features/agentenv.ts` (`cliError`, `interactive`); Test `src/features/agentenv.check.ts`, `src/features/update.check.ts`, `src/features/cli.check.ts` (create).

**Interfaces — Produces:**
- `export function interactive(): boolean` — `process.stdin.isTTY && !agentHost().on`.
- `export function cliError(code: string, msg: string, hint: string, exit: number): never` — agent mode: one line `{"error":{"code","message"[, "hint"]}}` to stderr via `writeSync(2, …)`; otherwise `agentglass: <msg>` (+ `\n  hint: <hint>` when given); then `process.exit(exit)`. `fail(msg)` in cli.ts calls `cliError("usage", msg, "", 2)`.
- `export function parseDur(s: string): number` — `^\d+(ms|s|m|h)$` → ms, else `-1`.
- main.ts: after every `H.cli` declined: `if (agentHost().on) { writeSync(1, compactHelp(hostObj()) + "\n"); process.exit(0); }` before the TTY check (so `--theme x` inside an agent also prints the compact help — the TUI it would start is bare `agentglass`).
- `--watch` gains `--for <dur>` (exit 0 after it) and `--until-idle` (exit 0 when no event for 10 s); in agent mode one of them is required, else `cliError("usage", "--watch needs --for <dur> or --until-idle inside an agent", "e.g. --watch --for 30s", 2)`; `--format` with `--watch` → usage error (always JSONL).
- `--help` in agent mode (or with `--format json`) prints `jsonHelp`; `<cmd> --help` prints only that command.

- [ ] **Step 1: Failing checks**: `parseDur("30s") === 30000`, `parseDur("2m") === 120000`, `parseDur("x") === -1`; `update.check.ts`: with `AGENTGLASS_AGENT=1` forced through `detectHost` cache reset hook, `interactive() === false`; `cli.check.ts`: `cliError` output shape captured by running a tiny child (`execFileSync` of the check binary itself with `--child-error` and env `AGENTGLASS_AGENT=1`) → stderr exactly one JSON line, stdout empty, exit 2.
- [ ] **Step 2: Run** → Expected: FAIL.
- [ ] **Step 3: Implement**; `update.ts:120` `process.stdin.isTTY` → `interactive()`; ensure no ANSI escape is written in agent mode (CLI writes go through `out()`, which never styles; assert `screenOut` adds none).
- [ ] **Step 4: Run** checks → PASS; `./build.sh`; `CLAUDECODE=1 ./agentglass </dev/null; echo $?` → compact JSON + `0`; `CLAUDECODE=1 ./agentglass --watch; echo $?` → JSON error on stderr + `2`; `./agentglass --help | diff - /tmp/agm-help-main.txt` → only the new `--for/--until-idle` rows; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `feat(cli): agent mode never starts the TUI or prompts; JSON errors; bounded --watch`.

---

### Task 4: `--format json|jsonl|csv|table` and `--fields`

**Files:** Create `src/features/format.ts`, `src/features/format.check.ts`; Modify `src/features/cli.ts` (`snapshot()` `:95-114` builds rows then formats; options).

**Interfaces — Consumes:** `width()`, `cw()`, `fit()` (`src/util/text.ts:11-30`).

**Interfaces — Produces:**
- `export function flatten(o: Obj): Obj` — nested objects joined with `_` (`tokens.in` → `tokens_in`), arrays → `;`-joined scalars (objects inside arrays → compact JSON), `null` stays `null`.
- `export function pickCols(rows: Obj[], fields: string[], defaults: string[]): { cols: string[]; bad: string[]; valid: string[] }` — `fields` empty → `defaults` (empty defaults → union of keys in first-seen order).
- `export function csvCell(v: unknown): string` — `null`/`undefined` → empty; formula guard: text starting `= + - @` gets a leading `'` (numbers are not guarded); quote when it contains `,` `"` `\n` `\r`; `"` doubled.
- `export function render(rows: Obj[], cols: string[], fmt: string, single: boolean, pretty: boolean, tty: boolean, cols0: number): string` — `json` (array, or one object when `single`; `pretty` → 2-space indent), `jsonl` (one compact object per line), `csv` (header + `\n` lines, no CR), `table` (header + rows; visible-width padding; numbers right-aligned; the widest text column cut with `…` to fit `cols0`, default 120 from `$COLUMNS`; `single` → key/value list; colours only when `tty`).
- `export function defaultFormat(agent: boolean, stdoutTty: boolean, legacyJson: boolean): string` — `legacyJson` (`--json`) → `json`; agent → `json`; TTY → `table`; else `json`.
- `--format` with an unknown value → usage error listing `json, jsonl, csv, table`; `--fields` unknown → usage error listing the valid names.

- [ ] **Step 1: Failing golden checks** `format.check.ts` over the same 3 rows (`{id:"a", title:"Fix, \"quotes\"\nnext", tokens:{in:1,out:2}, cost:null, tags:["x","y"], formula:"=1+2", neg:-3, cjk:"日本語テキスト", emoji:"🚀 go"}`): exact expected strings for json, jsonl, csv (`tokens_in`, `tags` `x;y`, `'=1+2`, `-3` unguarded, empty for `null`, quoted title with doubled quotes and the newline inside quotes) and table at `cols0 = 40` (CJK/emoji widths counted 2, `…` cut, `neg` right-aligned); `pickCols` with `["cost","id"]` → that order; `["nope"]` → `bad = ["nope"]`; `defaultFormat` table of the four cases.
  Run: `scriptc build src/features/format.check.ts -o /tmp/fm && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/fm` → Expected: FAIL.
- [ ] **Step 2: Implement**; `snapshot()` builds the same `JSess` objects, then `render(rows, cols, fmt, false, pretty, …)`; `--json` without `--format` keeps today's output byte for byte (pretty on a TTY outside agent mode, compact otherwise and always in agent mode).
- [ ] **Step 3: Run** → PASS; with `vf='import json,sys; d=json.load(sys.stdin); [[r.pop(k, None) for k in ("updated","bytes","activity","live","pid","status","attention","stuck")] for r in d]; print(json.dumps(d, sort_keys=True))'`: `./build.sh && ./agentglass --json --subagents --limit 400 | python3 -c "$vf" > /tmp/agm-new.json && python3 -c "$vf" < /tmp/agm-json-main.json | diff - /tmp/agm-new.json` → Expected: no diff; `./agentglass --json --format csv --fields id,harness,costUsd --limit 3` → header + 3 rows; suite `ok`.
- [ ] **Step 4: Commit** `feat(cli): --format json|jsonl|csv|table and --fields for every list`.

---

### Task 5: Session references and agent-mode scope

**Files:** Create `src/model/sessref.ts`, `src/model/sessref.check.ts`; Modify `src/features/agentenv.ts` (scope).

**Interfaces — Consumes:** `sessions`, `parentOf` (`src/model/sessions.ts`), `isHarness`, `harnessIds` (`src/harness/index.ts`), `identOfCwd`, `realCwd` (repo-view), `currentSession` (Task 2), `section("agent")` (`src/util/config.ts`).

**Interfaces — Produces:**
- `export interface Found { s: Sess | null; code: number; cands: Sess[] }` — `code` 0 found, 3 not found, 4 ambiguous.
- `export function findSession(ref: string): Found` — `<harness>:<id>` (harness validated), exact id across harnesses (subagents included), else a unique prefix of ≥ 6 chars (< 6 → `code 2` usage via the caller); ambiguous → `cands` sorted newest first. **Shared with command-palette's `ref.ts`.**
- `export function resolveRef(ref: string, root: boolean): Found` — `current` (default in agent mode) → `currentSession(root)`; `last` → newest top-level session whose real cwd is the current directory (`realpath`) or in the same project, excluding current; `parent` → current's root; anything else → `findSession`.
- `export interface Scope { name: string; key: string; cwd: string; warn: string }` and `export function agentScope(args: string[]): Scope` — outside agent mode `name "all"`; inside: config `agent.scope` (`project` default | `all`; anything else → `project` + `warn`), `--all-projects` → `all`, `--project-only` → `project`; `key = identOfCwd(realpath(cwd))?.key ?? "path:" + realpath(cwd)` (via a local, no optional chaining if scriptc rejects it).
- `export function inScope(s: Sess, sc: Scope): boolean` — `all` → true; else the same key rule applied to `realCwd(s)` equals `sc.key`.

- [ ] **Step 1: Failing check** `sessref.check.ts` (sessions inserted into `sessions`, cwd dirs created under `/tmp/agentglass-sessref/{p1,p2}` each with a `.git` dir): exact id; `claude:<id>`; `bogus:<id>` → 3; 6-char unique prefix; prefix shared by two → 4 with 2 `cands`; `last` from cwd `p1` with two sessions there → the newer non-current; `parent` of a subagent current → root; scope: agent on + no config → `project`, a `p2` session not `inScope`; `--all-projects` → in scope; config `{"agent":{"scope":"all"}}` + `--project-only` → `project`; config `"scope":"everyone"` → `project` + `warn` non-empty.
  Run → Expected: FAIL.
- [ ] **Step 2: Implement**.
- [ ] **Step 3: Run** → PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(cli): session references (current, last, parent, id, prefix) and agent-mode project scope`.

---

### Task 6: Per-model rows from honest-costs' buckets

**Files:** Modify `src/features/queries.ts` (create it here if Task 7 has not), Test `src/features/queries.check.ts`. No ledger or cache change (honest-costs owns `Day.mt`/`Day.um`).

**Interfaces — Consumes:** `modelUses(a, days)`, `ModelUse` (honest-costs, `src/features/usage/record.ts`), `ledger`/`accOf` (`src/features/usage/ledger.ts`).

**Interfaces — Produces:** `export function modelRows(ss: Sess[], days: string[] | null): Obj[]` — `modelUses` summed per model over the sessions → `{model, in, out, cacheRead, cacheWrite, costUsd, unpricedTokens}` sorted by `costUsd` desc then tokens; `costUsd: null` when `cost === 0 && unk > 0` (never `0` for unpriced usage). Task 7 (`models`) and Task 9 (`cost --by model`) both call it.

- [ ] **Step 1: Failing check** in `queries.check.ts`: two fixture sessions, `tokens(a, d, "m1", 10, 5, 2, 1, 0)` twice in one and once in the other, plus an unpriced `"gpt-x"` → `modelRows` row `m1` = in 30 / out 15 / cacheRead 6 / cacheWrite 3 and the summed cost; `gpt-x` → `costUsd: null`, `unpricedTokens > 0`; `days` restricts to those day keys.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; suite `ok`.
- [ ] **Step 5: Commit** `feat(cli): per-model rows from the ledger's per-model day buckets`.

---

### Task 7: `agentglass session [<ref>]`

**Files:** Create `src/features/queries.ts`, `src/features/queries.check.ts`; Modify `src/main.ts` (import `./features/queries.ts` with the other features), `src/features/clihelp.ts` (record).

**Interfaces — Consumes:** `resolveRef`, `inScope`, `agentScope` (Task 5), `render`/`pickCols` (Task 4), `cliError` (Task 3), `complete` (`src/hooks.ts:37`), `loadHead`/`loadTail`/`titleOf`/`activity` (`src/model/sessions.ts`), `sourceOf`/`parseEvents`/`window` (`src/harness/index.ts`), `buildGraph`/`summary` (`src/features/callgraph/model.ts:108, 200`), `ledger` + `Day.tt`/`files` (`src/features/usage/*`), `modelRows` (Task 6), `loopRun` logic (`src/features/watchdog.ts:21`), honest-costs `billing`.

**Interfaces — Produces:**
- `export function sessionObj(s: Sess): Obj` — the `--json` session fields (`cli.ts:58-62` shape, via a shared `jsonSess(s)` extracted from `snapshot()`), plus `turns`, `wallMs`, `activeMs` (`summary(buildGraph(...))` over the session and its subagents read whole in `window(src, 4194304)` chunks), `models: [{model, in, out, cacheRead, cacheWrite, costUsd}]` (`modelRows([s, …subagents], null)`; `costUsd: null` when the model's cost is unknown), `tools: [{name, calls, errors, p50Ms, maxMs}]` top 15 by calls (p50 from the `TS.hist` buckets), `errors: [{ts, tool, arg, text}]` last 10 (result text by call id from the events read above, first 200 chars, `scrubText` under redaction), `files: [{path, add, del}]` top 15, `repeats: [{tool, arg, n, ts}]` (runs ≥ 3), `subagents: [{id, kind, costUsd, tools}]`, `costBasis` (honest-costs `billing`).
- `export function loopRuns(evs: Ev[], min: number): { tool: string; arg: string; n: number; ts: string }[]` in `watchdog.ts` — every run of identical calls (same key as `loopRun`) of length ≥ `min`; `loopRun` unchanged.
- CLI: `session [<ref>] [--root] [--format F] [--fields …] [--all-projects|--project-only]`; out-of-scope target → `cliError("out_of_scope", …, "use --all-projects", 3)`; default format per `defaultFormat`; table form = key/value list.

- [ ] **Step 1: Failing check** `queries.check.ts` on fixture files (Claude session with 2 turns, a failing Bash call with result `Exit code 1\nnpm ERR! missing script`, the same `Bash ls` 4× in a row, an Edit with a patch, one subagent): `sessionObj` → `turns 2`, `errors[0].text` starts with `Exit code 1`, `repeats[0].n === 4`, `files[0].path` set, `subagents.length === 1`, `models[0].model` = the fixture model; `loopRuns` of `[a,a,a,b,b,c,c,c,c]` with min 3 → two runs (3, 4).
  Run: `scriptc build src/features/queries.check.ts -o /tmp/q && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/q` → Expected: FAIL.
- [ ] **Step 2: Implement**. **Step 3: Run** → PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(cli): agentglass session <ref> — cost, tools, errors, files, repeats of one session`.

---

### Task 8: `sessions` and `errors`

**Files:** Modify `src/features/queries.ts`, `src/features/clihelp.ts`; Test `src/features/queries.check.ts`.

**Interfaces — Produces:**
- `export function parseSince(s: string, now: number): number` — `today`, `<n>h`, `<n>d`, `YYYY-MM-DD` (local midnight) → epoch ms; invalid → `-1` (usage error).
- `sessions [--since 24h] [--cwd <dir>] [--limit N] [--live] [--subagents] [--harness H] [--filter EXPR]` — rows = `jsonSess` objects; `--cwd .` → `realpath`; scope applied; table defaults `updated harness title project costUsd tools status`.
- `export function errorRows(ref: string, sinceMs: number, limit: number, sc: Scope): { rows: Obj[]; source: string }` — `{ts, harness, session, tool, arg, text, durationMs}` newest first; source `"calls"` (filter-language per-call rows via `eachCall`, `err === 1`, within `filter.callDays`) when present, else `"recent"` (`TS.errs`, last 10 per tool per day); `text` read by call id: per session, scan source windows with an `indexOf(id)` prefilter, `parseEvents` only on hit lines, stop at the hit; ≤ 64 MB scanned per command, beyond → `text: null`; with `<ref>` only that session and its subagents.
- `errors`/`cost` JSON envelope `{"rows":[…],"source":"…","scope":"…"}`; csv/table/jsonl print rows only.

- [ ] **Step 1: Failing checks**: `parseSince` table; `errorRows` over two fixture sessions in two projects with agent scope `project` → only the cwd project's errors, newest first, `text` filled, `source` as expected; `limit 1` → 1 row; a session outside `--since` → excluded.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; suite `ok`.
- [ ] **Step 5: Commit** `feat(cli): sessions and errors queries`.

---

### Task 9: `cost` — extend honest-costs' command

**Files:** Modify `src/features/cost-cli.ts` (honest-costs' `agentglass cost` handler: new options, row mode, `--format`), `src/features/queries.ts`, `src/features/clihelp.ts` (replace the existing `cost` record, do not add a second); Test `src/features/queries.check.ts`, extend `scripts/cost.test.sh` (honest-costs).

**Interfaces — Consumes:** honest-costs' `agentglass cost` handler and `costNow(h)` (`src/features/usage/summary.ts`; summary form and `--check`); filter-language `aggregate(f, "session", days, [dim], "cost")` for `day|harness|project|session`; `modelRows` (Task 6, honest-costs' `Day.mt`/`Day.um`) for `model`; `lastDays`/`dayKey` (`src/features/usage/record.ts:23-31`).

**Interfaces — Produces:** `export function costRows(sinceKey: string, by: string, sc: Scope): Obj[]` — rows `{key, in, out, cacheRead, cacheWrite, costUsd, unpricedTokens, sessions}` + a final `{key:"total", …}`; `costUsd: null` for a row whose tokens are all unpriced (never `0`); `by` ∉ `day model harness project session` → usage error.
- Option handling in the one `cost` handler (spec 3.4, Decision 4): no `--by` and no `--since` → honest-costs' summary (`costNow(h)`) as today; `json` (agent mode, `--json`, `--format json`) prints its JSON object unchanged, `table` its text table, `csv`/`jsonl` → `cliError("usage", "csv/jsonl need --by", …, 2)`. `--by` or `--since` (alone → `--by day`; `--since` default `today`) → `costRows` with the `{rows, source, scope}` envelope for `json`, bare rows otherwise. `--harness h` narrows both forms; `--check` in both forms exits 3 when `costNow(h).budget.state === "over"` after printing.

- [ ] **Step 1: Failing checks**: `cost` with no `--by`/`--since` in agent mode → the honest-costs JSON keys `today`, `month`, `budget` (byte-equal to `cost --json` outside agent mode); `cost --format csv` without `--by` → exit 2; `cost --check --by day` with an over budget → rows printed, exit 3; fixture ledger with two days, two models (one unpriced), two harnesses: `costRows(…, "model")` total `costUsd` and tokens equal the total of filter-language's `aggregate(<empty filter>, "session", days, ["harness"], "cost")` for the same days (the shared evaluator the Stats tab reads since filter-language); unpriced model row `costUsd === null`, `unpricedTokens > 0`; `by "day"` has one row per day; scope `project` drops the other project's sessions.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; suite `ok`.
- [ ] **Step 5: Commit** `feat(cli): agentglass cost by day, model, harness, project or session`.

---

### Task 10: End to end under a PTY and on a fixture HOME

**Files:** Create `scripts/agent-mode.test.sh`.

- [ ] **Step 1: Test script** (build once: `AGENTGLASS_OUT=$t/ag sh build.sh`; temp `HOME=$t/h` with one Claude session in `$t/h/w/p1` (2 turns, a failing Bash), one Codex rollout in `p1`, one Gemini session in `$t/h/w/p2`):
  - `script -qc "env CLAUDECODE=1 HOME=$t/h timeout 2 $t/ag" /dev/null | tr -d '\r'` → exit 0, output parses as JSON (`node -e` or `python3 -c json.load`), ≤ 1024 bytes, contains no `"options"`;
  - `CLAUDECODE=1 HOME=$t/h $t/ag update --tag v2000.1.1 </dev/null` → exit 2 within 2 s (no network: `AGENTGLASS_DOWNLOAD_BASE=file://$t/none`), stderr one JSON line;
  - `cd $t/h/w/p1 && CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=<claude id> HOME=$t/h $t/ag session current --fields id,costUsd,errors` → that session, compact JSON;
  - same with `last` → the Codex session; `session <6-char shared prefix>` → exit 4; `session zzzzzz` → exit 3;
  - `errors` from `p1` → only `p1` rows, `scope "project"`; with `--all-projects` → also `p2`;
  - `cost --by model --format csv` → header + rows + total; `sessions --format table` outside agent mode on a non-TTY → JSON (default), with `--format table` → aligned text.
  Run: `sh scripts/agent-mode.test.sh` → Expected: PASS (fix failures at the root, with a check in the owning module).
- [ ] **Step 2:** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 3: Commit** `test(cli): agent mode under a PTY and query commands on a fixture home`.

---

### Task 11: Live check per harness, docs, final review

**Files:** Modify `README.md` (agent mode section, `--format`/`--fields`, query commands, exit codes, `agent.scope`, the `CLAUDE.md`/`AGENTS.md` paragraph: "Run `agentglass session current` to see this session's cost and failed tool calls."), `CHANGELOG.md`.

- [ ] **Step 1: Live checks (read-only for agentglass; the agents write their own sessions in `/tmp/agtest-agent`).** For each installed harness (Task 0 Step 7), ask it to run `agentglass session current --fields id,harness,costUsd` and `agentglass` (bare). Expected: its own session id and harness; bare prints the compact help; nothing hangs. Record the variables actually present per harness in the PR description (this settles the Codex and Kiro rows).
- [ ] **Step 2: Real data**: `./agentglass cost --since 7d --by harness --format table` totals match the Stats tab (7 days); `./agentglass errors --since 24h --all-projects --limit 5 --format jsonl` sane; `--redact` run shows fakes only.
- [ ] **Step 3: Docs**; `./agentglass --help` shows the new commands; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `docs: agent mode, --format and query commands`.
- [ ] **Step 5: Final whole-branch review** (most capable model) against spec + Review Focus, one fix pass, PR to `main`, CI green, rebase-merge, remove worktree + branch, `rm -rf /tmp/agtest-agent`.
