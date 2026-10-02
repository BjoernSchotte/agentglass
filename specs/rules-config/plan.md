# Configurable Watchdog Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The watchdog's fixed detectors become declarative rules in `~/.agentglass/rules.json` (metric, filter-language `where`, degraded/critical thresholds, `for`, labels, enable switch). The built-ins reproduce today's behaviour exactly; users tune, disable or add rules (cost, error rate, repeats, wait times). Rules drive badges, header counts, preview, `!`, bell, desktop notification, `--json` `alerts`, `--watch` `alert` lines and an optional notify command.

**Architecture:** `src/features/rules/` holds four parts: `config.ts` (load, validate with line:col, merge built-ins, hot reload), `metrics.ts` (the metric catalog; process metrics are today's watchdog helpers refactored to return numbers, call metrics read filter-language's per-call rows), `engine.ts` (per-(session, rule) state machine with `for`, transitions, ack, alert log), `notify.ts` (bell/desktop throttle and the argv-only notify command). `src/features/watchdog.ts` keeps observation and the TUI hooks but reads engine state. `src/features/rules/cli.ts` adds `rules check|defaults` and the `--json`/`--watch` outputs.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps; `node:fs`, `node:child_process` (`spawn`, as `src/actions.ts:99`). Checks are standalone scriptc programs (`*.check.ts`).

**Spec:** [spec.md](spec.md) — read it first, including "Decisions (review 2026-10-02)"; this plan argues from it. "spec N" below = section N of that spec.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields); call optional function members via a local; out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log`.
- **Exact equivalence**: with no `rules.json`, badges (◆/⚠), `s.attention`, `s.stuck` values (`loop`, `long cmd`, `stalled`, `spinning`), header counts, `!` order, bell, desktop text (`approval? <title>` / `<title>`, subtitle `<harness> · <cwd basename>`), the 30 s throttle, ack-on-look (selected > 1 s or transcript open) and `--json` `attention`/`stuck` are identical to `main`. `src/features/watchdog.check.ts` stays green unchanged.
- File: `~/.agentglass/rules.json`, JSON only (no YAML). Missing → built-ins silently. Syntax error → built-ins + one warning `rules.json: <error> — using built-in rules`. Per-rule errors disable only that rule. Hot reload: mtime stat every 2 s.
- Rule `id` `[a-z0-9-]{1,40}`; `labels` ≤ 16; `samples` ≤ 400; process CPU history cap = `max(120, largest samples of any enabled rule)`.
- Notify command: argv array, never a shell; alert JSON on stdin; env `AGENTGLASS_RULE`, `AGENTGLASS_SEVERITY`, `AGENTGLASS_STATE`, `AGENTGLASS_SESSION`, `AGENTGLASS_HARNESS`, `AGENTGLASS_VALUE`; killed after 10 s; ≤ 4 at once (extra dropped with a warning toast); runs on every transition listed in `notify.on` (default `fire`, `escalate`) **regardless of acknowledgement** (spec decision 3); honoured only when `rules.json` is owned by the user and not group/world-writable.
- `AGENTGLASS_NOTIFY=0` still disables desktop notifications. In `--watch`, bell and desktop are off; the command runs only with `--notify`; `ack: look` does nothing there.
- `turn_done` with a threshold > 0 rings at the threshold (`fire`), not at the busy → idle transition (spec decision 1). Per-harness tuning only through `where` copies (spec decision 2).
- All alert text fields go through `screenOut()`/`display()`: `--redact` fakes titles and projects in every output, including the command's stdin and env.
- No ledger change → no `VERSION` bump. No network.
- Keys: none new (the `!` jump, the ◆/⚠ badges and the help popup stay where they are).
- Style: dense one-line helpers, short `//` comments saying why, no new dependencies.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-rules-config`, branch `feat/rules-config`, PR to `main`, rebase-merge after green CI. **Phase 6.** Starts when filter-language (phase 2: grammar, attribute entities, `Acc.calls`, parse errors with columns) and the phase-5 specs (repo-view: `repo` attribute value) are merged. This branch calls the engine from the existing watchdog tick (`H.onTick`). adaptive-refresh (phase 7) adds `H.onWatch`; whichever of the two merges second moves the engine call into `H.onWatch` (if adaptive-refresh merged first, this branch registers the engine there directly).

## Review Focus

1. **The built-in rule set drifting from today's detectors** on edge timings (pending exactly 20 s, silent exactly 480 s, 6 vs 7 CPU samples, a loop and a long command at once). Task 4 equivalence table runs old helpers and the engine over the same `Obs` fixtures, including each boundary.
2. **An alert that rings every tick or never clears** after a hot reload that renames or removes a rule, or a session that stops being live mid-firing. Task 4 (unwatch resolves silently) + Task 5 (reload keeps state by id, resolves removed ids without bell).
3. **A `for` duration interrupted by one tick where the value is absent** (log line arrives, CPU sample missing): the pending timer resets, it does not fire early. Task 4 check.
4. **A notify command that hangs, floods or leaks**: a `sleep 60` command is killed at 10 s; a fifth concurrent run is dropped with one toast; the command never runs from a group-writable `rules.json`; no shell interpretation of `$(…)` in arguments. Task 6 checks.
5. **A broken `rules.json` edit while the TUI runs** (syntax error mid-save): the old rule set stays, one warning, no badge flicker. Task 5 check.

---

### Task 0: Worktree, probes, open question, upstream names

**Files:** none committed; rulings in `/tmp/agentglass-rules-rulings.md`, copied into the PR description.

- [ ] **Step 1: Worktree** `git worktree add -b feat/rules-config ../agentglass-rules-config main && cd ../agentglass-rules-config && ./build.sh && sh scripts/check.sh` → all `ok`.
- [ ] **Step 2: Open question 1 — does scriptc's `JSON.parse` error text carry a position** (spec 7)?
  ```sh
  mkdir -p /tmp/agrc && cat > /tmp/agrc/jp.ts <<'EOF'
  for (const t of ['{"a":}', '{"a":1,\n "b":[1,2,}', '{"a":1']) { try { JSON.parse(t); console.log("parsed"); } catch (e) { console.log(String(e)); } }
  EOF
  scriptc build /tmp/agrc/jp.ts -o /tmp/agrc/jp && /tmp/agrc/jp
  ```
  Expected evidence: the three error strings. If none carries a usable position (`position N` / `line L column C`), the position scanner of Task 1 is required for syntax errors too (it already is for per-rule diagnostics); write the ruling either way. Task 1 never parses positions out of the error text.
- [ ] **Step 3: spawn with stdin and kill** (notify command, spec 5):
  ```sh
  cat > /tmp/agrc/sp.ts <<'EOF'
  import { spawn } from "node:child_process";
  const ch = spawn("sh", ["-c", "cat > /tmp/agrc/in.txt; sleep 30"], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH ?? "", AGENTGLASS_RULE: "r" } });
  const w = ch.stdin; if (w) { w.write("{\"x\":1}\n"); w.end(); }
  const k = setTimeout(() => { ch.kill(); }, 1000);
  ch.on("exit", (c: number | null) => { clearTimeout(k); console.log("exit " + String(c)); });
  EOF
  scriptc build /tmp/agrc/sp.ts -o /tmp/agrc/sp && /tmp/agrc/sp && cat /tmp/agrc/in.txt
  ```
  Expected: `exit null` (killed) after ~1 s and `{"x":1}` in `in.txt`. Fallback if `stdio: "pipe"` or `ch.stdin` is unsupported: write the alert JSON to a `0600` temp file under `~/.agentglass/run/` and pass its fd as stdin (`stdio: [fd, "ignore", "ignore"]`, the pattern `src/actions.ts:96-99` already uses), unlinked on exit. Fallback if `kill()` is unsupported: `process.kill(ch.pid)`.
- [ ] **Step 4: file owner/mode** (permission check, spec 5): a scriptc probe printing `statSync(f).uid`, `statSync(f).mode & 0o777` and `process.getuid()` for a `chmod 664` file. Expected: real numbers. Fallback: `run("stat", ["-c", "%u %a", f])` on Linux / `["-f", "%u %Lp", f]` on macOS through `OS` (add `OS.ownerMode(path): number[]` to `src/platform/{linux,darwin}.ts`).
- [ ] **Step 5: Upstream names** on `main` (filter-language plan, Tasks 1 and 4–5 "Produces"; a missing name means it is not merged: stop): `grep -n "export function \(parse\|compile\|sessMatches\|callMatches\|attrOf\)\b\|export interface \(Parsed\|QErr\|Clause\|Compiled\|Call\)\b" src/features/query/*.ts src/features/usage/facts.ts` and `grep -n "calls: Call\[\]" src/features/usage/record.ts`. Used below exactly as: `parse(src: string): Parsed` (`cs: Clause[]`, `err: QErr | null` with `msg`, `col`), `compile(cs: Clause[], ctx: Ctx): { f: Compiled | null; err: QErr | null }` with ctx `"list"`, `sessMatches(f: Compiled, s: Sess): boolean`, `callMatches(f: Compiled, s: Sess, c: Call): boolean`, `attrOf(keyOrAlias: string): Attr | null` (entity in `Attr.ent`), `Call { t, tool, err, … }`, `Acc.calls: Call[]`. `grep -n "onWatch" src/hooks.ts` → expected absent (adaptive-refresh not merged; see Global Constraints).
- [ ] **Step 6: Baseline capture** for the equivalence contract: `./agentglass --json --live > /tmp/agrc/before.json` while one agent runs (fields `attention`, `stuck`), kept for Task 8.

---

### Task 1: `rules.json` parsing, units, positions, validation, built-in merge

**Files:** Create `src/features/rules/config.ts`, `src/features/rules/config.check.ts`.

**Interfaces:**
- Consumes: filter-language `parse` (`Parsed`, `QErr`), `compile(cs, "list")`, `attrOf`, `Compiled`, `Clause`.
- Produces:
  ```ts
  export interface Diag { line: number; col: number; rule: string; msg: string; err: boolean /* false = warning */ }
  export interface Rule {
    id: string; metric: string; where: string; wf: Compiled | null; op: string /* > >= < <= */;
    deg: number; crit: number; hasDeg: boolean; hasCrit: boolean; forSec: number; minCalls: number; window: number;
    params: Map<string, number>; ack: string /* look | none */; notify: boolean; message: string;
    labels: Map<string, string>; enabled: boolean; builtin: boolean; reason: string /* s.stuck value */; prefix: string /* notification body prefix */;
  }
  export interface NotifyCfg { bell: boolean; desktop: boolean; throttleSec: number; command: string[]; on: string[] }
  export interface RuleSet { rules: Rule[]; notify: NotifyCfg; diags: Diag[]; syntax: string /* "" or the JSON error */ }
  export const METRICS: string[]                       // the 11 catalog names of spec 2
  export function unitOf(metric: string): string       // duration | count | usd | ratio
  export function parseThr(v: unknown, unit: string): number   // -1 = invalid for this unit
  export function durSec(s: string): number            // "500ms" | "20s" | "2m" | "1h" → seconds, -1 invalid
  export function jsonPos(text: string): Map<string, number>   // JSON path ("rules.2.where") → byte offset of its value
  export function lineCol(text: string, off: number): number[] // [line, col], 1-based
  export function builtins(): Rule[]
  export function loadRules(text: string, exists: boolean): RuleSet
  export function rulesFile(): string                  // ~/.agentglass/rules.json
  ```
  Rules (spec 1, 3, 7): thresholds: numbers as is for `usd`/`count`; `"30%"` or `0.3` for `ratio`; duration strings for `duration` (a bare number = seconds); a duration on `usd` → error `threshold "2m" is a duration; session_cost needs a number in USD`. Built-ins exactly (spec 3 table): `waiting` (`turn_done`, `>=`, deg 0, ack look, notify, message `turn finished`, prefix `""`), `approval` (`approval_wait`, `>`, deg 20, ack look, notify, message `{tool} pending {value}, cpu {cpu}%`, prefix `approval? `), `loop` (`repeat_run`, `>=`, crit 3, no notify, reason `loop`), `long-cmd` (`command_age`, `>`, crit 600, reason `long cmd`, message `{cmd} running {value}`), `stalled` (`stalled`, `>`, crit 480, reason `stalled`), `spinning` (`spinning`, `>`, crit 180, reason `spinning`); user rules get `reason = id`, `prefix = "[" + id + "] "`. Merge: `builtins:false` drops all; a user rule with a built-in id merges field by field (present fields win). Errors (rule disabled, `err: true`): missing/invalid `id`, duplicate `id`, unknown `metric`, `where` parse error (filter-language's message, column offset into the JSON string value + 1 for the quote), a call attribute in `where` with a session metric, a day attribute anywhere, unit mismatch, neither `degraded` nor `critical`, degraded/critical out of order for `op` (`>`: deg < crit), `params` out of range (`samples` 1–400, `cpu_*` 0–100, `grace` ≥ 0), `labels` > 16, `ack` not `look|none`. Unknown fields → warning only. `notify.command` must be an array of strings.
  The built-in messages use `{cpu}` and `{cmd}` (spec 1, decision 4); the template engine accepts `{value} {threshold} {severity} {rule} {tool} {title} {project} {harness} {cpu} {cmd}` (the last two empty for metrics that do not provide them).

- [ ] **Step 1: Failing checks** (`config.check.ts`): missing file → 6 built-ins, no diags; `{"rules":[{"id":"approval","critical":"2m"}]}` → approval keeps deg 20, gains crit 120, still `ack look`; `builtins:false` + one user rule → 1 rule; `{"id":"spinning","enabled":false}` → disabled; each error case above → the rule disabled and a diag with exact `line:col` (multi-line fixture: `where` on line 4 col 37 points at the bad token inside the string); unknown field → warning, rule enabled; syntax error text `{"rules":[}` → `syntax` non-empty, built-ins only; `durSec("2m") === 120`, `durSec("500ms") === 0.5`, `durSec("2x") === -1`; `parseThr("30%", "ratio") === 0.3`; `parseThr("2m", "usd") === -1`; `jsonPos` on nested arrays/objects with escaped quotes in strings gives correct offsets.
- [ ] **Step 2: Run** `scriptc build src/features/rules/config.check.ts -o /tmp/rc && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/rc` → FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(rules): rules.json loader with line:col diagnostics and built-in merge`.

---

### Task 2: Numeric process metrics (watchdog helpers refactored)

**Files:** Modify `src/features/watchdog.ts:73-101` (`approvalNote`, `stuckOf` become wrappers); Create `src/features/rules/metrics.ts` (process part), `src/features/rules/metrics.check.ts`.

**Interfaces:**
- Consumes: `Obs`, `Cmd`, `loopRun`, `pendingTool`, `avgTail`, `toolName` (`src/features/watchdog.ts:21-71`, exports unchanged).
- Produces (in `watchdog.ts`, next to the old helpers, so `watchdog.check.ts` keeps importing from there):
  - `export interface MVal { v: number /* -1 = absent */; tool: string; cmd: string; cpu: string /* formatted as today */; at: number /* recorded time of the newest record behind v (call row t, else s.last); one-shot `for` */ }`
  - `export function approvalWait(o: Obs, cpuBelow: number, samples: number, graceSec: number): MVal` — absent when not busy, no open call, `o.cpu.length < samples`, `subsActive`, `avgTail(o.cpu, samples) >= cpuBelow`, or a command with `age < pend + graceSec`; `v` = seconds the call is open; `cpu` = `toFixed(0)`.
  - `export function commandAge(o: Obs): MVal` — absent when no call pending or no command; `v` = age of the oldest command, `cmd` = its name.
  - `export function stalledFor(o: Obs, cpuBelow: number, samples: number): MVal` — absent when not busy, fewer samples, avg ≥ `cpuBelow`, or a command runs; `v` = log-silent seconds; `cpu` = `toFixed(1)`.
  - `export function spinningFor(o: Obs, cpuAbove: number, samples: number): MVal` — absent when fewer samples or min over the last `samples` ≤ `cpuAbove`; `v` = log-silent seconds; `cpu` = min `toFixed(0)`.
  - `export function repeatRun(o: Obs): MVal` — `v` = `loopRun(o.evs)` (0 → absent), `tool` = last tool name.
  - `approvalNote(o)` = `approvalWait(o, 2, 7, 5)` with `v > 20` → today's string, else `""`; `stuckOf(o)` = first of loop (`repeatRun ≥ 3`), long cmd (`commandAge > 600`), stalled (`stalledFor > 480`), spinning (`spinningFor > 180`) → today's `[reason, detail]` strings.
  - `metrics.ts`: `export function procMetric(r: Rule, o: Obs, turnAt: number): MVal` — dispatches `turn_done` (`v = (o.now − turnAt)/1000` when `turnAt > 0 && !o.busy`, else absent), `approval_wait`, `repeat_run`, `command_age`, `stalled`, `spinning` with `r.params` defaults from spec 2 (`cpu_below` 2/1, `samples` 7/7/120, `grace` 5, `cpu_above` 80).

- [ ] **Step 1: Failing checks** (`metrics.check.ts`, `Obs` fixtures built like `watchdog.check.ts`): each metric's value and each absent condition; boundaries: pending 20 s → `approvalWait.v === 20` (built-in `>` 20 does not hold), 21 s holds; 6 samples → absent, 7 present; silent 480 s → `stalledFor.v === 480` (not > 480); 119 samples → spinning absent; `cpu` strings `"1"` / `"0.5"` formats.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; rewrite `approvalNote`/`stuckOf` as wrappers. **Step 4: Run** → PASS, and `scriptc build src/features/watchdog.check.ts -o /tmp/wd && AGENTGLASS_NOTIFY=0 /tmp/wd` unchanged PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `refactor(watchdog): detectors as numeric metrics; old helpers wrap them`.

---

### Task 3: Session and call metrics

**Files:** Modify `src/features/rules/metrics.ts`; Test `src/features/rules/metrics.check.ts`.

**Interfaces:**
- Consumes: `Rule` (Task 1), `MVal` (Task 2), filter-language `callMatches(f, s, c)`, `Call`, `Acc.calls`, `ledger` (`src/features/usage/ledger.ts:13`), `Sess` cost/token fields.
- Produces:
  - `export function sessMetric(r: Rule, s: Sess): MVal` — `session_cost` (`s.cost`, absent when `< 0`), `session_tokens` (`inTok + outTok + cacheRTok + cacheWTok`).
  - `export function callMetric(r: Rule, s: Sess, rows: Call[]): MVal` — rows matching `r.wf` call clauses (all rows when `wf` is null or has no call clauses); `window > 0` → the last `window` matching rows with `err ≥ 0`; `tool_calls` = count, `tool_errors` = Σ `err === 1`, `tool_error_rate` = errors / calls with a result, absent when that count < `min_calls`.
  - `export function repeatWhere(r: Rule, s: Sess, rows: Call[], base: MVal): MVal` — `repeat_run` with call clauses: absent when the newest row whose tool name equals `base.tool` does not match `r.wf` (or no such row yet: the ledger is behind; absent this tick).
  - `export function metricOf(r: Rule, s: Sess, o: Obs, turnAt: number): MVal` — dispatch (process / session / call); computed at most once per (session, metric, params) per tick through a per-tick memo keyed `metric + JSON(params) + window + min_calls + where`.

- [ ] **Step 1: Failing checks**: a synthetic `Acc.calls` with 30 Bash calls (10 errors) and 5 Edit calls: `tool_error_rate` `where tool is Bash` → 0.333…; `min_calls: 40` → absent; `window: 10` over rows where the last 10 Bash have 6 errors → 0.6; untimed/unfinished rows (`err −1`) excluded from rate and window; `where program is npm` selects by the row's programs; `session_cost` with `s.cost −1` → absent; `repeat_run where tool is Bash` with the last loop on `Edit` → absent, on `Bash` → count; the memo returns the same value object twice in one tick.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(rules): session and per-call metrics over the ledger's call rows`.

---

### Task 4: Engine (levels, `for`, transitions, ack, alert log) + equivalence table

**Files:** Create `src/features/rules/engine.ts`, `src/features/rules/engine.check.ts`.

**Interfaces:**
- Consumes: `Rule`, `RuleSet` (Task 1); `MVal` (Task 2); `metricOf` (Task 3); filter-language `sessMatches(f: Compiled, s: Sess): boolean` (rule scope: session clauses of `where`); old `approvalNote`, `stuckOf` (for the equivalence table only). `stepSession` receives the session's scope result via the `vals` map: a rule out of scope has no entry and is treated as absent.
- Produces:
  ```ts
  export interface AState { level: number; since: number[] /* [pending since for level 1, for level 2], 0 = not pending */; firedAt: number; acked: boolean; v: MVal }
  export interface Trans { at: number; path: string; rule: string; from: number; to: number; state: string /* fire | escalate | deescalate | resolve */; v: number; thr: number }
  export function holds(op: string, v: number, thr: number): boolean
  export function evalRule(r: Rule, st: AState, v: MVal, now: number): Trans | null   // pure step of one (session, rule)
  export function stepSession(rs: RuleSet, path: string, vals: Map<string, MVal>, now: number): Trans[]
  export function unwatch(path: string): void            // drops states silently (no transitions)
  export function ackLook(rs: RuleSet, path: string): void   // acked = true for firing rules with ack "look"
  export function flags(rs: RuleSet, path: string): string[] // [attention "1"|"" , stuck reason | ""]
  export function firing(rs: RuleSet, path: string): Alert[] // for preview / --json
  export interface Alert { rule: string; severity: string; value: number; unit: string; threshold: number; since: number; message: string; labels: Map<string, string>; acked: boolean }
  export const LOG: Trans[]                              // ring of 500
  export function retain(ids: Set<string>): void         // hot reload: drop states of removed ids silently
  export function snapLevel(r: Rule, unit: string, v: MVal, now: number): number // one-shot (--json): highest level whose threshold holds and has held ≥ forSec by recorded time — duration unit: v − thr seconds; else now − v.at; no state, no Trans
  ```
  Semantics (spec 4): absent value → target level 0 and both `since` reset; target = the highest level whose threshold holds **and** has held `≥ forSec` (`since[k]` set on the first tick it holds); `fire` 0→n (acked = false), `escalate` 1→2, `deescalate` 2→1, `resolve` n→0 (acked = false). `flags`: attention = any unacked rule at level 1 (degraded); stuck = `reason` of the first rule in rule order at level 2 (critical, unacked). A session with stuck set is not counted under ◆ in the header (unchanged rule, `watchdog.ts:186`). Message rendering substitutes the placeholders (durations as `ago()`-style text, as `dur()` in `watchdog.ts:72`).

- [ ] **Step 1: Failing checks** (`engine.check.ts`):
  - **Equivalence table**: ≥ 20 `Obs` fixtures (from `watchdog.check.ts` plus the Task 2 boundaries: pending 20/21 s, 6/7 samples, silent 480/481 s, loop 2/3, loop + long cmd, spinning 119/120 samples, approval with a subagent active, approval with a fresh command) → for each, old `stuckOf(o)[0]` equals `flags(...)[1]` after one `stepSession` with the built-ins and `metricOf` values; old `approvalNote(o) !== ""` equals the approval rule at level 1.
  - `waiting`: first sight (turnAt 0) → nothing; a busy→idle transition → `fire` once; busy again → `resolve`; `ackLook` → attention false, stays acked while firing, re-fire after resolve shows again.
  - `{"id":"waiting","degraded":"5m"}`: transition at t → no `fire` until t+300 s, then exactly one `fire` (the ring moment).
  - `for: "30s"` on a cost rule: holds 20 s, absent one tick, holds 20 s → no fire; holds 30 s → fire.
  - escalate/deescalate/resolve sequence with deg 5 / crit 20 and values 6, 21, 10, 0.
  - `waiting` restricted `where harness is_not codex` + `waiting-codex` copy `where harness is codex`: for a Codex session only the copy evaluates, for Claude only the built-in (scope check in `stepSession` via `sessMatches`).
  - `unwatch` → no transitions emitted, states gone; `retain` after removing a rule id → its state gone silently.
  - `LOG` keeps the newest 500.
  - `snapLevel`: `approval_wait` deg 20 s with `for: "10s"`, v 25 s → 0, v 31 s → 1; `session_cost` deg 5 `for: "1m"`, v 6 with `at = now − 30 s` → 0, `at = now − 90 s` → 1; `forSec 0` → plain threshold.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(rules): rule engine with for, severities, ack and transitions`.

---

### Task 5: Watchdog drives the engine (TUI), bell/desktop, reload, CPU history cap

**Files:** Modify `src/features/watchdog.ts` (tick `:131-157` computes `turnAt` per session and calls the engine; `raise`/`clear` replaced by engine outputs; badges `:173`, preview `:174-183`, header `:184-188`, `!` `:190-199`, help `:200-203` read engine flags; `H.complete` `:160-169` one-shot evaluation), `src/model/procs.ts:67` (`if (hh.length > HIST.cap)`, `export const HIST = { cap: 120 }`); Create `src/features/rules/notify.ts` (bell/desktop part), `src/features/rules/state.ts` (current `RuleSet`, load at import, reload every 2 s, startup toast); Test `src/features/rules/engine.check.ts`, `src/features/watchdog.check.ts` (unchanged), `src/features/rules/reload.check.ts`.

**Interfaces:**
- Consumes: Tasks 1–4; `OS.notify`, `titleOf`, `base`, `say`, `S.tv`, `current()`.
- Produces:
  - `state.ts`: `export const R = { set: RuleSet, mtime: number, checkedAt: number }`; `export function reload(now: number, text: (p: string) => string, mtimeOf: (p: string) => number): boolean` — every 2 s: unchanged mtime → no-op; new text with a syntax error → keep `R.set`, warn once per mtime `rules.json: <error> — keeping the previous rules`; otherwise replace, `retain(new ids)`, set `HIST.cap = max(120, max samples)`; at startup (first load) with per-rule errors → one toast `rules.json: N rules disabled — agentglass rules check`.
  - `notify.ts`: `export function onTrans(s: Sess, r: Rule, t: Trans, acked: boolean, inWatch: boolean): void` — bell (`\x07`) and desktop (`OS.notify("agentglass", s.h + " · " + (base(s.cwd) || "?"), r.prefix + titleOf(s).slice(0, 120))`) on `fire`/`escalate` when `r.notify`, not acked, not `inWatch`, `R.set.notify.bell/desktop`, and the per-session throttle (`throttleSec`, default 30, shared by bell and desktop); `AGENTGLASS_NOTIFY=0` skips desktop. Command dispatch is Task 6 (`runCommand` is called here with a no-op until then).
  - Watchdog tick: per watched session: `loadTail`, `observe`, `turnAt` update (`prevBusy && !o.busy` → `now`; `o.busy` → 0; first sight records `prevBusy` only), values via `metricOf` for every enabled rule in scope, `stepSession`, `onTrans` for each transition, then `s.attention`/`s.stuck` from `flags`; the look check (`:155`) calls `ackLook`. Unwatched sessions → `unwatch(path)` and flags cleared (as `:138`).
  - Preview: one line per firing alert — degraded built-ins keep today's wording (`◆ approval? · <msg>`, `◆ waiting for you · turn finished <ago> ago`), user rules `◆ <id> · <msg>`; critical `⚠ <reason> · <msg>`; labels appended dim as `k=v`.
  - `H.complete` (CLI `--json`): one-shot evaluation of every enabled rule in scope on the current state (spec 3, decision 5): level via `snapLevel` (`for` from recorded timestamps); `turn_done` with threshold 0 absent (needs a transition), with threshold > 0 `turnAt = s.last` when not busy; no `onTrans` (no bell, desktop or command), no ack. Sets `attention`/`stuck` and stores the snapshot alerts for Task 7. Equivalence holds: the built-ins have `forSec 0` and `waiting` stays absent.
  - Help popup section `rules`: the active rule ids with their levels, and the 5 newest `LOG` entries (the section's `keys` array is rebuilt on reload and on each transition).

- [ ] **Step 1: Failing checks**: `reload.check.ts` with injected `text`/`mtimeOf`: valid → replaced; broken → old set kept, one warning, a second tick with the same mtime → no second warning; removed id → its firing state resolved without a `Trans` reaching `onTrans`; `samples: 400` rule → `HIST.cap === 400`, disabling it → back to 120. Notify throttle: two `fire`s 10 s apart on one session → one bell (count writes through an injected writer), 31 s apart → two; acked → none; `AGENTGLASS_NOTIFY=0` (the check env) → no `OS.notify` call (stub via an injected notifier).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `watchdog.check.ts` unchanged PASS; `sh scripts/check.sh` all `ok`; manual: run an agent, let a turn finish → ◆ + bell; select it > 1 s → cleared; `rules.json` `{"rules":[{"id":"waiting","degraded":"1m"}]}` saved while running → next finished turn rings after 1 min.
- [ ] **Step 5: Commit** `feat(rules): the watchdog runs on the rule engine; rules.json hot reload`.

---

### Task 6: Notify command

**Files:** Modify `src/features/rules/notify.ts` (`runCommand`), `src/platform/{linux,darwin}.ts` only if Task 0 Step 4 took the fallback (`OS.ownerMode`); Test `src/features/rules/notify.check.ts`.

**Interfaces:**
- Consumes: `NotifyCfg`, `Rule`, `Trans`, `Alert` (Tasks 1, 4); `alertJson` (Task 7 shape, defined here and reused there); `spawn`; `display()`/`screenOut()`.
- Produces:
  - `export interface JAlert { rule: string; severity: string; state: string; value: number; unit: string; threshold: number; since: string; session: string; harness: string; title: string; project: string; message: string; labels: { [k: string]: string } }` (spec 6: durations in seconds, ratios 0–1, cost USD; text fields through `display()`/`screenOut()`).
  - `export function alertJson(s: Sess, r: Rule, t: Trans, a: Alert): JAlert`
  - `export function argvFor(cmd: string[], j: JAlert): string[]` — placeholder substitution per argument (`{value} {threshold} {severity} {rule} {tool} {title} {project} {harness} {cpu} {cmd}`); no shell, no word splitting.
  - `export function fileSafe(path: string): boolean` — owned by `process.getuid()` and `(mode & 0o022) === 0`.
  - `export function runCommand(cfg: NotifyCfg, j: JAlert, safe: boolean): string` — `""` on start, else the reason (`not allowed: rules.json is group/world-writable`, `4 notify commands running — dropped`). Runs only for `t.state ∈ cfg.on`; ignores acknowledgement (spec decision 3); `spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "ignore"], env: {...process.env, AGENTGLASS_RULE…AGENTGLASS_VALUE} })`, stdin = `JSON.stringify(j) + "\n"`, kill after 10 s; ≤ 4 running (counter decremented on `exit`/`error`); each transition runs at most once (called once per `Trans`).
  - A validation diag `notify.command ignored: rules.json must not be group- or world-writable` when `!safe` (shown by `rules check` and the startup toast count).

- [ ] **Step 1: Failing checks** (`notify.check.ts`, commands are tiny `sh` scripts in a temp dir — `sh` is the *program*, the alert never passes through a shell string): `argvFor(["/tmp/x/hook", "{rule}", "$(id)"], j)` → `["/tmp/x/hook", "approval", "$(id)"]` (literal); a hook writing stdin and env to files → stdin parses as `JAlert`, env has `AGENTGLASS_RULE`/`_STATE`; a `sleep 60` hook → exited within 11 s (check waits with a 12 s timer); five concurrent `sleep 2` hooks → fifth returns the drop reason; `notify.on: ["resolve"]` → no run on `fire`, one on `resolve`; an acked alert's `escalate` → the command runs; `chmod 664` rules file → `fileSafe` false and `runCommand(..., false)` returns the not-allowed reason; with `AGENTGLASS_REDACT=1` (check env) the stdin `title` is not the real title.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(rules): notify command — argv only, JSON on stdin, bounded and killed after 10 s`.

---

### Task 7: CLI — `rules check|defaults`, `--json` alerts, `--watch` alert lines

**Files:** Create `src/features/rules/cli.ts`; Modify `src/features/cli.ts` (`JSess.alerts`; `watch()` `:133-186` runs the engine each poll after process refresh; `--no-alerts`, `--notify` options; help text lines; `WAlert` line type), `src/main.ts` (import `./features/rules/cli.ts` before `./features/cli.ts` so `rules …` is handled first); Test `src/features/rules/cli.check.ts`, `scripts/rules.test.sh`.

**Interfaces:**
- Consumes: `loadRules`, `builtins`, `rulesFile`, `Diag` (Task 1); engine + metrics (Tasks 2–4); `alertJson`, `runCommand` (Task 6); ledger `complete(s)` (`src/features/usage/ledger.ts:92-97`).
- Produces:
  - `agentglass rules check [--json]`: prints the effective rules (built-ins merged, one line each: `id metric op degraded/critical for where`), then each diag as `rules.json:<line>:<col>: <rule id>: <message>`; `--json` → `{rules:[…], diagnostics:[{line,col,rule,message,severity}]}`; exit 0 clean, 1 warnings only, 2 errors (syntax error = 2).
  - `agentglass rules defaults [--examples]`: prints the built-ins as a ready-to-edit `rules.json` (`{"version":1,"builtins":true,"rules":[…]}` with every built-in spelled out); `--examples` adds the spec 8 table as rules with `"enabled": false`.
  - `--json`: `JSess.alerts: JAlert[]` — `firing()` from the one-shot evaluation (Task 5); `attention`/`stuck` unchanged.
  - `--watch`: `export interface WAlert { ts: string; harness: string; session: string; title: string; project: string; parent: string | null; kind: string /* "alert" */; tool: null; text: string; alert: { rule: string; severity: string; state: string; value: number; threshold: number; labels: { [k: string]: string } } }`; every poll: for live top-level sessions passing `wanted(s, o)`: `loadTail`, `observe`, `metricOf`, `stepSession`; each transition → one `WAlert` line through `out()` (so `--redact` applies); session/call metrics refresh their ledger data with `complete(s)` at most every 10 s per session; `--no-alerts` → no engine; `--notify` → `runCommand` per transition; bell/desktop never.

- [ ] **Step 1: Failing checks**: `cli.check.ts` — `checkText(text)` (the pure core of `rules check`) on a file with one error and one warning → exact lines and exit code 2; warnings only → 1; clean → 0; `defaults` output → parses with `loadRules` back to the same 6 built-ins with zero diags. `scripts/rules.test.sh` (built binary, `HOME` set to a temp dir): `agentglass rules check` with no file → exit 0; with `{"rules":[{"id":"x","metric":"nope"}]}` → stdout contains `rules.json:1:` and exit 2; `agentglass rules defaults > $HOME/.agentglass/rules.json && agentglass rules check` → exit 0.
- [ ] **Step 2: Run** `sh scripts/rules.test.sh` and the check → FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh` all `ok`; `--watch` emits an alert line for a synthetic stalled session: the check builds a `Sess` with `pid` set, fake `hist` (≥ 7 samples at 0.2 %), `mtime` 9 min ago, busy evs, no commands, runs the watch engine step once → one `WAlert` with `rule stalled`, `severity critical`, `state fire`; with `--no-alerts` logic → none.
- [ ] **Step 5: Commit** `feat(rules): rules check/defaults, --json alerts and --watch alert lines`.

---

### Task 8: Real-life verification, docs, final review

**Files:** Modify `README.md` (rules: file location, fields table, metric catalog, built-ins and their exact defaults, examples table, `rules check`/`defaults`, `--watch` alert lines, `--no-alerts`, `--notify`, notify command contract and its permission check, `for`, severities ◆/⚠, ack on look, hot reload), `src/features/cli.ts` help (Task 7).

- [ ] **Step 1: Equivalence on real sessions (read-only)**: without `rules.json`, run one real agent through a finished turn, an approval prompt (Claude with a permission-gated tool) and a long command (`sleep 700` in a test dir) → ◆ + bell on the turn, ◆ `approval?` after 20 s, ⚠ `long cmd` after 10 min, header counts and `!` as on `main`; `./agentglass --json --live` fields `attention`/`stuck` match `/tmp/agrc/before.json` semantics for the same states.
- [ ] **Step 2: User rules**: `{"rules":[{"id":"session-cost","metric":"session_cost","degraded":0.01,"message":"cost {value}"},{"id":"bash-errors","metric":"tool_error_rate","where":"tool is Bash","min_calls":5,"degraded":"10%"}]}` → ◆ on a session over 1 cent; `agentglass --watch | grep '"kind":"alert"'` shows its `fire` line; a notify command (`["/usr/bin/logger","-t","agentglass","{rule} {severity}"]`) logs once per transition (`journalctl -t agentglass -n 5`); `chmod g+w ~/.agentglass/rules.json` → command ignored and `rules check` reports it; restore `chmod 600`; delete the test `rules.json` afterwards.
- [ ] **Step 3: Docs.** `sh scripts/check.sh` → all `ok`; `./build.sh` → ok.
- [ ] **Step 4: Commit** `docs: configurable watchdog rules in the README`.
- [ ] **Step 5: Final whole-branch review** (most capable model) against spec + Review Focus; one fix pass; PR to `main` (body ends with the Claude Code attribution line); CI green; rebase-merge; remove worktree and branch; `rm -rf /tmp/agrc`.
