# Agent wait — spec

Status: draft (2026-10-07), decisions made under the user's 2026-10-05 delegation (see "Decisions").

## Goal
Answer two questions for one machine and across a fleet, from data agentglass already records:

1. **What do my agents wait on?** Total wall time per normalised command family (`pnpm test`, `tsc`, `cargo build`,
   `pytest`, `gh run watch` …) and per non-shell tool, across all agents and sessions of a period: share of agent time,
   count, p50/p95, failure rate, trend against the previous period; and the split of agent time into tools, the user
   (questions the agent asked) and the model.
2. **Do they block each other?** Heavy commands (tests, type checks, lint, builds, installs) running at the same time
   across agents: live ("3 heavy commands running: `pnpm test` ×2, `tsc`", with RSS and host load), history (peak
   concurrency, hours at ≥ 2 / ≥ 3, overlap timeline, duration when overlapped vs alone), an opt-in contention alert
   through the rules engine, and a CLI check an agent can run before it starts a test run.

Surfaces: a **Wait** tab (key `5`), `agentglass wait` (text, `--json`, agent mode, `--now`, `--check`), filter
attributes `family` / `kind`, rule metrics `contention` / `contention_family`, OTLP span attributes, a `wait` line in
`fleet pull`.

## Why (user value)
A team running 10+ agents in parallel: "if you're running lots of agents, look at what they're waiting on. For us it
was mostly lint, type checks and CI setup." Several agents started heavy checks at once, slowed each other down and
ran the machine out of memory. agentglass records every tool call with its command, duration and exit status, but no
view sums that wall time by *what* ran, and nothing shows that five agents are running the test suite right now.
Measured on this machine (below): shell commands are 88 % of tool wall time; heavy command kinds ran with ≥ 2 at once
for 12.6 h of 71 h in 30 days, and the same check took 1.4–2× as long (p50) when it overlapped another heavy command.
Knowing this lets the user serialise heavy checks (a lock, a CI-only suite, fewer parallel agents), and lets agents
check before they start one.

## Today (current code, measured)

### Data agentglass already has
- **Call rows** (filter-language, columnar since tui-footprint): `src/features/usage/rows.ts:12-16` — per call: start
  `t` (epoch ms), `tool`, `model`, `ms` (duration, -1 untimed), `err` (-1 no result, 0 ok, 1 failed), `out`, and ids
  of its programs, command lines and files (`KIND_PROG/CMD/FILE`, `rows.ts:9`). Booked in `pend()`
  (`src/features/usage/record.ts:219-229`): each shell command is stored as `norm(cmd)` = control characters → spaces,
  whitespace collapsed, **cut at 200 characters** (`src/features/usage/calls.ts:97`); `program()` (`calls.ts:99-117`)
  is its coarse family (first real program, wrappers `sudo env timeout nice …` and `cd/export` steps skipped).
  Duration and status are written in place by `done()` (`calls.ts:63-91`), exit codes per command for Codex.
- Read lazily through one accessor `callsOf(s)` (`src/features/usage/ledger.ts:52-55`); `eachCall`/`callsIn`
  (`src/features/query/eval.ts:390-405`) step a session at a time and skip sessions without a day bucket in the
  window; the TUI defers unread sessions (`src/features/query/ui.ts:97-99` `rowsLater`/`rowsDeferred`).
  Retention `filter.callDays`, default 90 (`src/features/usage/callcache.ts:27`).
- **Duration histograms**: `EDGE` (15 edges, 16 buckets, `calls.ts:21`), `pct()` (`calls.ts:29-35`) — the ≈ quantile
  Stats already shows; mergeable by adding buckets.
- **Active time** per session-day: `Day.act` (`record.ts:19-23`), merged minute intervals, idle gap
  `repo.idleGapMin` = 5 (`record.ts:128`); finished calls' spans count as active (`calls.ts:76`); `spanMin`,
  `unionMin` (`record.ts:189-202`).
- **Live processes**: harness trees with per-process `cpu`, `rss`, `args` (`src/model/types.ts:20-23`,
  `src/model/procs.ts:66-118`, Linux `/proc` incremental since tui-footprint, macOS libproc). The watchdog's alarm
  tick (`src/features/watchdog.ts:106-131`, `H.onWatch`, 1.5 s while agents are live) builds `Obs.cmds` per watched
  session = the outermost shells under the agent (`toolCmds`, `src/features/detect.ts:65-76`) with age and a 30-char
  name (`cmdName`, `detect.ts:77-86`). Claude Code's shells carry the command as `eval '<cmd>'` in their argv
  (checked on this host), others as `-c <cmd>`.
- **Approval**: only live — `approvalWait` (`detect.ts:98-111`) and the built-in `approval` rule
  (`src/features/rules/config.ts:168`). Nothing records approval time historically: a call's `ms` (tool_use →
  tool_result) **includes** the time its permission dialog was open.
- **Rules engine** (rules-config): metrics catalog `config.ts:21-23`, built-ins `config.ts:165-174`, per (session,
  rule) state `src/features/rules/engine.ts:54`, notification throttle per session path
  (`src/features/rules/notify.ts:23,90-92`). Every metric is per session; none spans sessions.
- **Filter attributes** for calls: `tool server program command file ext status duration out hour`
  (`src/features/query/attrs.ts:92-101`); no family, no kind.
- **OTLP**: `execute_tool` spans carry `process.executable.name` = `program()` (`src/features/otlp/encode.ts:120`) and,
  with `--detail meta`, the normalised command (`encode.ts:125`).
- **Fleet**: `fleet pull` sends hello, `cost`, `allowance`, sessions (`src/features/fleet/pull.ts:33-45`);
  `HostReport` (`src/features/fleet/model.ts`) has no call data — remote rows have no calls here
  (`query/eval.ts:376`, `if (s.host) return false`).
- **TUI**: tabs Sessions, Processes, Stats (`src/features/usage/stats.ts:705`), Repos
  (`src/features/repos/tab.ts:411`); keys `1`–`9` and Tab switch (`src/input.ts:141-143`). Stats already binds
  `d w ↑↓ ␣ ↵ t B $ C`; it shows top tools and, for one tool, its programs/commands and slowest calls — no family sums,
  no concurrency.

### Measured on this machine (read-only, 2026-10-07)
Script [`measure.py`](measure.py) over the raw transcripts of the last 30 days (Claude Code +
Codex; tool_use → tool_result pairs, the same pairing the adapters do), no agentglass cache involved:

- **Volume**: 224,624 finished calls in 2,721 agent logs; 189,515 shell calls (Claude `Bash` 160,812, Codex `exec`
  28,703). The existing calls cache here holds 162,871 rows in 1,856 files, 18 MB on disk (2026-08-08 → 10-06);
  tui-footprint measured 295k rows earlier. In memory a row costs ~70 B (`rows.ts:6`): 30 days ≈ 16 MB, 7 days ≈ 4 MB.
- **Agent time**: 1,223 agent-hours active (call-span union, 5-min gaps — an approximation of `Day.act`); tool spans
  (union per agent) 577 h = **47 %**; questions to the user (`AskUserQuestion`) 42 h = 3.5 %; the rest (≈ 49 %) is the
  model and the harness between calls.
- **Tools by wall time**: `Bash` 486 h (82 % of tool time), `AskUserQuestion` 42 h (p50 100 s), Codex `exec` 38 h,
  `Agent` 7 h, `SendMessage` 4.5 h, `TaskOutput` 3.3 h (p50 600 s: blocking on a background task); `Read` 0.5 h.
- **Command kinds** (share of shell wall time, prototype normaliser): test 10.8 %, wait loops (`sleep`, `until …`)
  5.3 %, lint 3.5 %, CI (`gh run watch`, `gh pr checks`) 3.1 %, build 2.6 %, type check 1.9 %, install 0.7 %;
  72 % other (`python3` scripts 11.8 %, `cat`, `grep`, `sed`, `git`, `ssh`). 22,101 distinct families from the
  fallback rule; **116 families cover 80 %** of shell time — normalisation and kinds matter more than the top-10.
- **Top families**: `python3` 61 h, `pytest` 12.5 h, `vitest` 11.3 h, `./build.sh` 9.9 h, `biome` 9.9 h, `pnpm test`
  9.0 h, `pnpm typecheck` 8.0 h, `gh pr checks` 6.6 h, `playwright` 5.7 h, `gh run watch` 4.9 h (p50 255 s).
  Normaliser defects found and fixed in the prototype: heredoc bodies and loop bodies (`break`, `failed` as
  "programs"), `rtk proxy`, `uv run --frozen`, `flock <lockfile>` (one repo serialises heavy runs through
  a `flock` on a heavy-run lock file: 332 calls, 8 h — users already work around contention by hand).
- **Contention** (heavy kinds test/typecheck/lint/build, calls ≥ 10 s, 5,402 calls, 71 h): ≥ 2 at once 12.6 h,
  ≥ 3 at once 3.2 h, peak 7. Any shell call ≥ 30 s: ≥ 3 at once 43 h, peak 16. Same family: `./build.sh` peak 4,
  p50 58 s alone → 98 s overlapped, p95 408 s → 1,224 s; `pnpm test` peak 4, p50 104 → 155 s.
- **Slowdown** (p50 overlapped with any other heavy call ÷ p50 alone, families with ≥ 10 calls each side):
  `pnpm test` 1.98, `sh check.sh` 1.87, `biome` 1.65, `pnpm typecheck` 1.62, `pnpm lint` 1.51, `build.sh` 1.44,
  `playwright` 1.26, `vitest` 1.16, `tsc` 1.06, `scriptc build` 0.94; `pytest`/`ruff` 4.2 (one repo dominates).
  Overlap correlates with busy periods and big repos — the figure is a correlation and is labelled so.
- **Background runs**: 2,643 Claude `Bash` calls with `run_in_background` in 30 days; their call ends at launch, so
  history undercounts them; the process scan sees them while they run.
- Host now: 32 cores, load 5.0, 128 GB, 49 GB available (`/proc/loadavg`, `/proc/meminfo`).

## Design

### 1. Command families (`src/features/wait/family.ts`, pure)
`familyOf(cmd: string): Fam` with `Fam { name: string; kind: string; heavy: boolean; generic: boolean }`, applied to
the stored `norm(cmd)` text (≤ 200 chars, one line).

1. **Segments**: split on `&&`, `||`, `;`, `|` outside quotes. `norm()` has already joined lines, so a heredoc body
   sits inside the line: `<<WORD` (quoted or not) and everything after it up to a later ` WORD` token (or the end) is
   dropped first.
2. **Words of a segment**: leading `VAR=value` assignments dropped; wrappers dropped with their options and numeric
   arguments: `sudo env timeout nice ionice nohup time command exec caffeinate stdbuf rtk` (+ `rtk proxy`),
   `flock <file>` (+ `-w N`), `xargs` (+ options). Program = basename of the next word, quotes stripped.
3. **Trivial programs** never name a family: `cd pushd popd export source . set unset ulimit true false echo printf
   test [ mkdir local read trap break continue` and the shell keywords `for while until if then else elif do done fi
   case esac`. A loop's family is its first non-trivial body command (`until gh run view … ; do sleep 20; done` →
   `gh run`).
4. **Filters** (`cat grep rg sed head tail awk jq wc sort uniq tee less cut tr column`) name a family only when no
   later segment of the line has a non-filter program (`cat log | python3 -` → `python3`; `grep -rn x src` → `grep`).
5. **Family name** of the chosen segment (`p` = program, `a` = its non-option arguments):
   - package managers `npm pnpm yarn bun`: `run <script>` / `run-script <script>` → `p run <script>`; `test`,`t` →
     `p test`; `exec|dlx|x <tool>` → the tool's family; `i|ci|add|install` → `p install`; otherwise `p <a0>`
     (`pnpm typecheck`, `pnpm lint` — pnpm's implicit `run`);
   - runners `npx pnpx bunx uvx`, `uv run [opts]`, `python -m <mod>`, `poetry run`, `pipenv run` → the family of
     what they run (`npx tsc` → `tsc`, `python3 -m pytest` → `pytest`, `uv run --frozen pytest` → `pytest`);
   - CLIs with subcommands keep one (`cargo go make just git docker kubectl mvn gradle dotnet terraform composer
     mix flutter deno scriptc tmux herdr agentglass`), `gh` keeps two (`gh run watch`, `gh pr checks`), `go tool X`
     keeps `tool X`;
   - interpreters `node tsx ts-node deno python python3 ruby perl php sh bash zsh` with a script → `<p> <script
     basename>` (`sh check.sh`, `node build.js`), marked `generic`; with `-c`/`-e`/`-` or nothing → `<p>`;
   - a path program → its basename (`./build.sh` → `build.sh`);
   - anything else → the program.
   Names are cut to 40 characters. A line with only trivial segments → `sh`.
6. **Kinds** (first match on the family name, word-anchored): `test` (`test`, `tests`, `vitest`, `jest`, `mocha`,
   `pytest`, `playwright`, `cypress`, `rspec`, `check.sh`, `e2e`, `test:*`, `cargo test`, `go test`, `mix test`),
   `typecheck` (`tsc`, `typecheck`, `type-check`, `check-types`, `mypy`, `pyright`, `vue-tsc`, `svelte-check`,
   `cargo check`), `lint` (`lint`, `eslint`, `biome`, `ruff`, `clippy`, `prettier`, `shellcheck`, `golangci-lint`,
   `stylelint`, `fmt`, `format`), `build` (`build`, `compile`, `make`, `scriptc`, `webpack`, `vite build`, `esbuild`,
   `rollup`, `next build`, `tsup`, `cargo build`, `go build`, `docker build`), `install` (`install`, `pip`,
   `uv sync`, `go mod`, `bundle install`), `ci` (`gh run *`, `gh pr checks`, `gh workflow *`, `act`), `wait`
   (`sleep`, `wait`, loops whose body is `sleep`), `vcs` (`git *`), `net` (`ssh`, `scp`, `rsync`, `curl`, `wget`),
   else `other`. **Heavy** = kind in `wait.heavyKinds`, default `test typecheck lint build install`.
7. **User rules** — `~/.agentglass/config.json`, section `wait`, read once at startup like every config section
   (`src/util/config.ts:24-37`); invalid entries are ignored with one startup toast (TUI) or stderr line (CLI) naming
   the entry:
   ```json
   { "wait": {
       "families": [
         { "match": "make *", "family": "make $1", "kind": "build" },
         { "match": "./scripts/ci.sh ...", "family": "ci.sh", "kind": "test", "heavy": true },
         { "match": "pnpm run storybook:*", "kind": "test" } ],
       "heavyKinds": ["test", "typecheck", "lint", "build", "install"],
       "minSec": 10 } }
   ```
   `match` is a word pattern against the segment's words after step 2: `*` matches one word (captured as `$1…$9`),
   a trailing `...` matches the rest, `*` inside a word is a glob (`storybook:*`). Rules run in order before the
   built-ins, on each segment (step 3–4 still decide which segment); the first hit wins; omitted `family` = the
   built-in family name, omitted `kind` = the built-in kind, `heavy` overrides the kind's default. No regular
   expressions (scriptc 0.1.7: no `Record<string, RegExp>` in the C backend; patterns are also easier to get right).
8. **Several commands in one call** (Codex `exec` scripts with several `exec_command`s): the call's family is the one
   of its commands with the highest kind priority (heavy kinds first, in `heavyKinds` order, then `ci wait vcs net
   other`), ties → the first; the call's duration counts once.
9. **Non-shell tools** get a kind by name: `user` (`AskUserQuestion`, `request_user_input*`, `ask_user`), `wait`
   (`TaskOutput`, `BashOutput`, `Monitor`, Codex `wait`, `write_stdin` polls), `agent` (`Agent`, `Task`,
   `SendMessage`, `spawn_agent`), `web` (`WebFetch`, `WebSearch`, `web_*`), `mcp` (`mcp__*`), `file` (`Read`, `Edit`,
   `Write`, `Grep`, `Glob`, `NotebookEdit`, `apply_patch`), else `other`. Their family is the tool name (MCP: `mcp
   <server>`).
10. **Memo**: family names are interned in a dictionary of their own (`FAMS`, `src/features/wait/family.ts`; the
    persisted dictionaries in `src/features/usage/facts.ts:14` stay as they are); a `Float64Array` indexed by the
    command dictionary id (`DICT.cmd`) holds family id + 1 (0 = not computed), grown on demand. Each distinct command
    text is normalised once per run; the config does not change while agentglass runs.
11. **`--redact`**: a `generic` family (interpreter + script name) shows as its program only; user-rule family names
    are user-chosen and shown as they are.

### 2. Period report (`src/features/wait/report.ts`)
`waitReport(f: Compiled, since: number, until: number, cut: number): WaitReport`, resumable (`step(budgetMs)` a
session at a time, as `callsIn`), one pass over the call rows of the window plus the previous window of equal length.

- Per family and per non-shell tool: `n`, `timed` (rows with `ms ≥ 0`), `ms` (sum), `max`, `hist[16]` (`hb()`),
  `err` (rows with `err = 1`), `agents` (distinct top-level sessions), `prevMs`, `prevN`; per kind the same sums.
- **Shares**: `share = ms / activeMs`, `activeMs` = Σ over matching sessions of `spanMin(Day.act)` × 60,000 for the
  days in the window (the agent time the Repos tab calls `agentMin`, `src/features/repos/agg.ts:164`). Parallel calls inside one agent each count, so
  shares can add up to more than the tools' union below; the table header says "share of agent time".
- **Agent-time split** (per session, from its rows in the window, then summed): `toolMs` = union of `[t, t+ms]` of
  its calls (rows are in call order; one linear merge); `userMs` = union of its `user`-kind calls; `modelMs` =
  `activeMs − toolMs` clamped at 0 ("model and harness"). Approval dialogs are inside `toolMs` (no record separates
  them); the view says so. `waitMs` (kind `wait` + `ci`) is shown inside tools as "polling".
- **Trend** = `ms / prevMs − 1` when `prevMs > 0` and the previous window lies inside retention, else `null`.
- **Quantiles**: `pct(hist, .5/.95, max)` (same ≈ as Stats); the CLI prints them with `≈` only where Stats does.
- Calls without a duration (`ms < 0`: no result yet, a restart lost the pending call) count in `n`, not in `ms` or
  quantiles. Calls over 24 h are already dropped by `done()`.

### 3. Overlap (`src/features/wait/overlap.ts`, pure)
Input: per call `t0`, `t1`, group id, agent id (session path id), only heavy calls with `ms ≥ wait.minSec` (10 s);
output per group and for the group "all heavy":

- `peak` (max concurrent calls) and `peakAt`; `atLeast[k]` = ms with ≥ k concurrent calls, k = 2…8 (8 = "8+");
- per call `over` = another call of the same group (any agent, the same agent's parallel call included) covers
  ≥ 50 % of its duration; `overAny` = the same against all heavy calls;
- `slowdown` = p50 of `over` calls ÷ p50 of the others, shown only when both sides have ≥ 10 calls, else `null`
  (and the same for `overAny`);
- `timeline`: concurrency max per bucket (1 h for ≤ 7 days, 6 h for ≤ 30, 1 day beyond), for the sparkline.

Sweep line over sorted endpoints (`O(n log n)`; ends before starts at equal times); coverage per call from a second
sweep that keeps the open calls of each group (bounded by the peak). Concurrency counts calls, not agents (two
parallel `tsc` of one agent contend too); `agents` at the peak is reported beside it.

### 4. Live (`src/features/wait/live.ts`)
Collected on the watchdog's alarm tick (`H.onWatch`, `watchdog.ts:106`), from data the tick already has:

- For each watched session, each outermost shell of `toolCmds` (`detect.ts:65`, extended to return the shell's pid):
  the command from its full `args` — `eval '<cmd>'` (Claude Code), else the text after ` -c ` — `norm()`ed and
  passed through `familyOf` (memo keyed by the args string, ≤ 512 entries, cleared when full). `rssKb` = RSS of the
  shell's subtree (the children map the tick built), `ageSec` from the shell's start, `bg` = the session has no open
  call with a shell command (a background run).
- Sessions with no visible process tree (a shared daemon such as OpenCode 2.x, `ps` fallback without a tree): their
  open calls (`Acc.pend`) with a shell command and age < 24 h, without RSS.
- Host: Linux `/proc/loadavg` (1-minute) and `/proc/meminfo` `MemAvailable`/`MemTotal`, read once per tick only while
  the Wait tab, `--watch` or a `contention` rule needs them; macOS `os.loadavg()` and no memory figure (Task 0 probe).
  CPU count from `os.cpus().length` once.
- Result `LiveWait { at, load1, cpus, memAvailPct, running: Run[] }`, `Run { path, h, family, kind, heavy, ageSec,
  rssKb, pid, bg }`. Cost: O(live shells) per tick — no history, no file reads.

### 5. Contention alert (rules-config)
- Two metrics (unit `count`), evaluated per watched session from `LiveWait`:
  - `contention` = the number of heavy commands running on this host, present only for a session that runs one
    itself (else absent: the rule cannot fire on it);
  - `contention_family` = the number running of the same family as this session's oldest heavy command.
  Params: `min_age` (seconds a command must run before it counts, default 0). `where` scopes the sessions as for
  every rule. `{cmd}` in a message = "pnpm test ×2, tsc" (families with counts, longest first, ≤ 60 chars).
- Built-in `contention`: `metric contention, op >=, degraded 3, for 30s, ack none, notify true, message
  "{value} heavy commands running: {cmd}"`, **`enabled: false`** — opt in with
  `{ "rules": [{ "id": "contention", "enabled": true }] }`; `agentglass rules defaults --examples` prints it and a
  `contention_family` example (`degraded 2`, `for 30s`).
- Every session running a heavy command while the rule holds gets the alert (the rows show which agents); the bell,
  desktop notification and command are throttled per **(rule, host)** for host-wide metrics instead of per session
  (`notify.ts:90`), so three agents give one notification. The alert flows into the alert log, `--watch` JSONL, the
  OTLP logs stream and related-events unchanged.

### 6. TUI: the Wait tab (`src/features/wait/tab.ts`)
A tab after Repos (key `5`, header name "Wait"). Layout at 80 columns (wider: the family column grows):

```
 Wait · 7 days vs previous · 412 agent-h · tools 47% (polling 6%) · you 4% · model 49%
 now  3 heavy: pnpm test ×2 2m10s 1.9G · tsc 40s 0.6G       load 5.0/32 · mem 38% free
 family              kind    share  total     n    p50    p95  err  trend  peak
▸pnpm test           test     4.1%  17.0h   340  1m08s  4m41s  1%  +12%    4
 tsc                 typec    1.9%   8.0h   990    18s  1m26s  1%   -3%    3
 …
 ── pnpm test · ≥2 at once 1.3h · overlapped p50 2m35s vs 1m44s alone (×1.5, correlation)
 ▁▁▃▅█▃▁▁▂▅▇▃▁  peak 4 at Mon 09:36 · 23 sessions · ↵ sessions  t triage
```
- Header line: period, agent hours, the split (§2). "now" line from `LiveWait`; hidden when no agent is live;
  heavy commands in red when the `contention` rule's threshold (enabled or not, default 3) is reached.
- Table: families by total (default), selection with `↑↓ jk`, `v` switches families ↔ kinds ↔ tools, `s` cycles
  the sort (total, count, p95, err, trend, peak), `d w m a` period (today, 7 days, 30 days, all within retention,
  as the Repos tab). The local filter `/` and pins apply (they select sessions and calls: `repo is x`,
  `harness is codex`).
- Bottom: the selected row's overlap figures (§3) and timeline sparkline; `↵` lists the family's slowest and newest
  calls (↵ there opens the session at that call, as Stats' drill does), `esc` back; `t` runs triage with selection
  `family is "<f>"` (Decision 12); `f` pins `family is "<f>"` as the Sessions filter and switches to Sessions.
- Work: the report is computed when the tab opens, when the period or filter changes, and — while the tab is visible
  — when the ledger moved and ≥ 30 s passed; resumable in ≤ 20 ms slices per tick with a progress line ("reading
  calls 412/1,856 sessions"). Hidden tab: no work. The "now" line reads the last tick's `LiveWait`.
- Help `?` section "wait", footer hints, palette actions (`wait.open`, `wait.period.*`, `wait.view`).

### 7. CLI: `agentglass wait`
```
agentglass wait [--since today|<n>d|YYYY-MM-DD] [--by family|kind|tool] [--filter '<expr>']… [--limit N]
                [--json | --format table|json|csv] [--fields a,b] [--now] [--check [--family f | --kind k] [--max N]]
```
- Default: the last 7 days vs the 7 before, by family, top 20, the agent-time split, contention per heavy family,
  and the "now" block. Text output fits 80 columns.
- `--json`: `{period{since,until,days}, previous{since,until}|null, scope{filter,project}, retention{days,complete},
  agentTime{activeMs,toolMs,userMs,modelMs,pollingMs}, rows[{key, kind, heavy, calls, timedCalls, totalMs, share,
  p50Ms, p95Ms, maxMs, errors, errorRate, prevTotalMs, trend, agents, peak, peakAt, atLeast2Ms, atLeast3Ms,
  slowdown{aloneP50Ms, overlapP50Ms, ratio, alone, overlapped}|null, hist[16]}], heavy{peak, peakAt, atLeastMs[7],
  slowdown}, now{at, host, load1, cpus, memAvailPct, running[{session, harness, family, kind, heavy, ageSec, rssMb,
  bg}], heavyRunning}, guard}` (`guard`: `null | "empty" | "retention"`). The fields join `docs/cli-contract.md`
  (contract stays 1: an added command).
- `--now`: only `now` (no call rows read: instant).
- `--check`: exit 3 when the heavy commands running now (or those of `--family` / `--kind`) are ≥ `--max` (default:
  the `contention` rule's degraded threshold, 3), else 0; prints the `now` object in agent mode, one line otherwise.
  For agents: `agentglass wait --check --kind test || echo "3+ heavy runs on this machine — wait or run a subset"`.
- **Agent mode** (cli-agent-mode): JSON by default; history scoped to the current project (`--all-projects` widens it),
  `now`/`--check` always host-wide — machine resources are shared across projects.
- Exit 2 for usage errors (unknown `--by`, bad `--since`, `--max` < 1), as every command.

### 8. Filter attributes
Call attributes `family` (text, `is`/`~`/`is_one_of`) and `kind` (enum: the kinds of §1.6 and §1.9) in
`src/features/query/attrs.ts`, evaluated through the memo of §1.10. They work everywhere call clauses do: Stats
(`kind is test` drills into test runs), `--json --filter`, triage (`--select 'kind is lint'`), rules `where`.

### 9. Fleet
- `fleet pull --wait` adds one line `{"wait": <the wait --json object for --days, without the agent scoping>}` after
  `allowance`; `fleet serve` allows the flag (`fleet/serve.ts` allowlist). The viewer asks for it only while its Wait
  tab is open or `agentglass wait --fleet` runs (a pull without it costs nothing extra on the host).
- `HostReport.wait: Obj | null`. The viewer merges host reports exactly where the data allows: counts, sums, errors,
  `hist` (bucket-wise: quantiles of the merged histogram), `prevTotalMs`; peaks, overlap and `now` stay **per host**
  (different machines do not contend). The Wait tab gains a host column when fleet hosts are configured and `h`
  toggles "all hosts merged" ↔ "per host"; `agentglass wait --fleet` prints the merged table plus one `now` line per
  host with its report age.
- OTLP-hub hosts: no call rows reach the viewer as rows; their Wait figures are `n/a` (Out of scope).

### 10. OTLP
`execute_tool` spans of shell calls gain `agentglass.tool.family` and `agentglass.tool.kind` (next to
`process.executable.name`); a `generic` family is sent only with `--detail meta`, otherwise its program. Backends can
then sum wait time by family without parsing commands. Contention alerts already reach the logs stream (§5).

### Failure modes
- **Background runs** (`run_in_background`, possibly Codex yielded sessions) end their call at launch: history
  undercounts them (2,643 such calls in 30 days here). The call rows carry no background marker, so the view states
  "background runs are not timed"; live they are counted (`bg`).
- **Truncated commands**: the 200-char cut can hide the heavy part of a long chain (`cd x && export … && pnpm test`
  past 200 chars → `cd`-only → `sh`). Measured share of shell rows whose stored text is exactly 200 chars: Task 0
  records it; family `sh` rows are listed so the user sees the size of the gap.
- **Approval time** inside tool time (history): labelled; live approval waits show in the "now" line via the
  existing approval alert.
- **Retention**: a period beyond `filter.callDays` shows `guard: retention` and the covered part only.
- **Clock skew across hosts**: overlap is never computed across hosts.
- **macOS `ps` fallback** (`AGENTGLASS_PROCS=ps`): no subtree RSS for short-lived shells; RSS shows `—`.
- A user rule that matches everything (`"match": "..."`) — allowed; `agentglass wait --by family` shows the result,
  and `agentglass rules check`-style validation (`wait.families` problems as toasts and in `agentglass wait --json`
  `warnings[]`).

### Privacy
Everything stays local. Family names derive from commands already stored in the ledger; `--redact` hides script
names (§1.11). `fleet pull --wait` and OTLP send families and kinds, never command lines (except OTLP `--detail meta`,
as today). The live command text is read from `/proc/<pid>/cmdline` of the user's own agent shells (already read by
the process scan) and reduced to a family; it is not stored.

## Interactions with other specs
- **filter-language**: new call attributes `family`, `kind` (§8); the report uses `eachCall`/`callsIn` and the
  `Compiled` filter. No change to cached data: **no `VERSION` bump**, no calls-file `FORMAT` change.
- **tui-footprint**: lazy rows only for the window, resumable slices, no work on hidden tabs; the live part is
  O(live shells) on the existing tick. Budgets in Testing.
- **rules-config**: two metrics, one disabled built-in, the per-host notification throttle (§5).
- **adaptive-refresh**: live collection rides `H.onWatch`; nothing runs when no agent is live.
- **cli-agent-mode**: agent JSON default, project scope for history, host scope for `now` (Decision 8); fields in
  `docs/cli-contract.md`.
- **triage**: `t` in the Wait tab = triage with `family is <f>` vs the rest of the scope.
- **fleet**: `fleet pull --wait`, `HostReport.wait`, per-host live (§9); Part B snapshots may carry the same line
  later (Out of scope).
- **otlp-export / otlp-complete**: two span attributes; alerts through the logs stream.
- **command-palette**: actions for the tab.
- **related-events**: contention alerts appear in the alert log it reads; nothing else.
- **mux-herdr**: none (live data comes from the process tree, not the multiplexer).

## Testing
- `family.check.ts`: a golden table `src/features/wait/families.golden` (≥ 200 lines `command<TAB>family<TAB>kind`,
  hand-written from the shapes measured here: wrappers, `rtk`, `flock`, heredocs, loops, pipes with filters, package
  managers, runners, interpreters, 200-char cuts, quotes, Codex multi-command); every line must match exactly; user
  rules (`$1` captures, `...`, globs, order, invalid entries → one diagnostic each).
- `report.check.ts`: fixture rows → per-family sums; invariants: Σ family `ms` = Σ timed shell rows' `ms`, Σ `n` =
  shell rows, kinds sum to the same; agent split `tool + model = active` per session; trend `null` across retention;
  resumable stepping (1 row per step) gives the identical report as one pass.
- `overlap.check.ts`: seeded random call sets (n = 1…400) against an O(n²) brute force for `peak`, `atLeast[k]`,
  `over`, `overAny`; equal endpoints; zero-length calls; one agent's parallel calls.
- `live.check.ts`: `eval '…'` and `-c` argv parsing (Claude, Codex, zsh/bash, quoting), subtree RSS, `bg` marking,
  the pend fallback.
- Rules: `contention`/`contention_family` values from a fake `LiveWait`; built-in off by default; enabling via
  rules.json; one notification for three sessions (throttle per host).
- `scripts/wait.test.sh` (fake HOME, like `cost.test.sh`): text and `--json` output, `--now`, `--check` exit 0/3,
  agent-mode scoping, exit 2 cases, `--help --format json` fields; `scripts/contract.test.sh` gains the fields.
- Fleet: `fleet pull --wait` line round-trips; merging two hosts' `hist` equals the histogram of the union.
- Golden (exactness): `scripts/golden-usage.sh` unchanged (no cached-data change) — must report 0 differences between
  main and the branch. A real-history cross-check: `agentglass wait --json --since 30d --by kind` vs
  `measure.py` on the same machine and window — totals per kind within 2 % (the two parsers pair calls identically;
  differences are rows past retention or truncated commands, listed by Task 11).
- Footprint (tui-footprint tooling, `scripts/footprint.sh`): Wait tab hidden → CPU and RSS within noise of main;
  tab visible, 7 days: first report ≤ 300 ms CPU in slices ≤ 20 ms, RSS + ≤ 15 MB; 90 days: ≤ 2 s CPU, RSS + ≤ 40 MB;
  live part ≤ 0.3 ms per tick with 36 fake agents (`scripts/fixture-agents.sh`).
- Manual: the tab at 80, 120, 200 columns; `NO_COLOR`; light theme.

## Out of scope
- Scheduling or queueing commands (a lock, `agentglass run --queue`): agentglass observes; `--check` gives agents
  the signal, and the docs show the `flock` recipe teams already use.
- Recording host load and RSS history (a sampling file): only live (Decision 10).
- Separating approval time from tool time in history (needs hooks or harness support).
- Fleet hosts fed only through the OTLP hub; Part B snapshot/watch feeds carrying `wait` (a later task once Part B
  ships; the object is the same).
- Per-repo family columns in the Repos tab.

## Decisions (2026-10-07, delegated by the user on 2026-10-05)
Each: question · options · decision · why · cost if wrong.

1. **Where in the TUI?** · (a) a section in Stats, (b) its own tab, (c) a popup from Stats. · **(b) a "Wait" tab,
   key 5.** · The view needs a header split, a live line, a 10-column table and a timeline — Stats at 80 columns
   already holds tools, details and two drill boxes and binds 12 keys; a tab gets its own keys (`d w m a s v`, as
   Repos) and costs nothing while hidden. · If wrong: one more tab in the header (it already degrades to numbers);
   moving the table into Stats later reuses `report.ts` unchanged.
2. **CLI name** · `wait`, `waits`, `contention`, `load`, a `stats --by family` flag. · **`agentglass wait`.** · It
   names the question users ask; the help says it reports and never blocks; `--by family|kind|tool` covers the
   "stats" use. · If wrong: someone reads `wait` as "block until free"; the help's first line and `--check`'s exit
   code make the behaviour plain; renaming before contract 2 is cheap.
3. **Family normalisation** · (a) `program()` only, (b) regex rules, (c) word rules: program + a known subcommand /
   script, wrappers stripped, filters demoted, user word patterns first. · **(c).** · `program()` lumps `pnpm test`
   with `pnpm install` and `gh pr checks` with `gh pr view`; the measurement shows 116 families for 80 % of time, so
   the top must be precise; word patterns avoid regex pitfalls and scriptc's C-backend limits. · If wrong: a family
   is split or merged badly; users fix it with one config line, and the golden table pins the built-ins.
4. **Compute at read time or store per row?** · (a) a family column in the call rows (cache `VERSION` bump,
   re-index; config changes need a re-index), (b) at read time from the command id with a memo. · **(b).** · No cache
   change, a config edit applies at the next start without a re-index, each distinct command normalised once per run (≤ ~120k strings, measured row
   count). · If wrong: first report on 90 days slower than the 2 s budget; then add the column with the next planned
   `VERSION` bump.
5. **What is "heavy"?** · (a) by measured duration only, (b) by kind (`test typecheck lint build install`),
   configurable, plus `minSec` 10 for history. · **(b).** · Kinds match the user's complaint (lint, type checks, CI)
   and are known the moment a command starts — the live alert cannot wait for a duration. `ci` and `wait` are not
   heavy: they poll, they do not load the machine. · If wrong: a heavy custom command is missed; `heavy: true` in a
   user rule fixes it.
6. **Contention grouping for the alert** · same family only, any heavy command, both. · **Both metrics; the
   built-in uses any heavy command (`contention`, ≥ 3 for 30 s).** · Memory pressure is cross-family (`tsc` +
   `vitest` + `eslint` in three worktrees): measured ≥ 3 heavy at once 3.2 h vs ≥ 3 same-family 0.4 h. Same-family
   remains available (`contention_family`). · If wrong: noisier than wanted; the rule is opt-in and its threshold
   one edit.
7. **Built-in on or off?** · on, off. · **Off (opt-in), surfaced in the Wait tab ("contention alert off — how to
   enable") and in `rules defaults --examples`.** · rules-config promised the built-ins equal today's detectors;
   a new notification nobody asked for is noise. · If wrong: users who would have benefited never enable it; the tab's
   hint is the mitigation.
8. **Scope in agent mode** · project for everything, host for everything, history = project / now = host. ·
   **History project-scoped, `now`/`--check` host-wide.** · Consistent with every other agent-mode command for
   history; machine contention is host-wide by nature — an agent asking "should I start tests" must count other
   repos' runs. · If wrong: an agent sees host-wide counts it did not expect; the JSON says `scope.now: "host"`.
9. **Agent-time split** · tool/model only, tool/user/model with approval estimated from alerts, tool/user/model with
   approval inside tools. · **The last.** · Questions to the user are recorded calls (42 h here); approval dialogs
   are not recorded anywhere historically, an estimate from live alerts would exist only for hours the TUI ran.
   · If wrong: approval-heavy users read "tool time" too high; the label says so and live approval shows in "now".
10. **Host load/RSS history** · sample to a file while TUI/`--watch` runs, live only. · **Live only.** · History
    would exist only for hours agentglass ran and adds a writer; the per-call duration already shows the effect. ·
    If wrong: no "what was the load during that slow run"; a sampling file can be added without changing this design.
11. **Overlap definition** · any overlap, ≥ 50 % of the call's duration, concurrency-weighted. · **≥ 50 %, counted
    by calls (not agents).** · A call that overlapped 1 s of 5 minutes was not slowed; two parallel calls of one
    agent contend as much as two agents. Slowdown needs ≥ 10 calls each side and is labelled a correlation. · If
    wrong: ratios a bit off; the brute-force check pins the definition, changing the threshold is one constant.
12. **Drill-down keys** · ↵ slowest/newest calls, `t` triage, `f` filter Sessions. · **All three.** · Same meaning
    as in Stats (↵ drill, `t` triage) and Repos; `f` answers "which sessions ran this". · If wrong: a key nobody uses.
13. **Fleet** · ship call rows per host, ship a per-host report and merge, skip. · **`fleet pull --wait` + exact
    merge of sums and histograms, live per host.** · Rows across SSH would cost MBs per pull; the report is a few KB
    and merges exactly except peaks, which must stay per host anyway. · If wrong: no cross-host overlap (none is
    physically meaningful).
14. **Default period** · today, 7 days, 30 days. · **7 days vs the 7 before.** · Same default as triage; enough calls
    for p95 and trend; ~4 MB of rows. · If wrong: one keypress (`m`).
15. **OTLP attributes** · none, family + kind always, family + kind with generic families only under `--detail
    meta`. · **The last.** · Same privacy line as `process.executable.name` vs `agentglass.tool.command`. · If wrong:
    backends see `node` instead of `node build.js` without `--detail meta`.

## Open questions (technical verification during implementation)
1. scriptc 0.1.7: `os.loadavg()` / `os.cpus()` available in the native and C backends? Fallback: `/proc/loadavg` on
   Linux, `—` on macOS.
2. Share of stored shell commands cut at 200 chars whose family falls back to `sh` (Task 0 measures on the isolated
   index); if > 2 % of shell time, store a per-row family hint at the next planned `VERSION` bump.
3. Codex `exec` with yielded long-running commands (`yield_time_ms`): does the call end at the yield? If so, mark it
   like `run_in_background`.
4. The Claude `eval '…'` argv format on macOS (zsh/bash) — same as Linux?
