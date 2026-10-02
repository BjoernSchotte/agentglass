# Configurable watchdog rules — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 6 (depends on filter-language).

## Goal
The watchdog's fixed detectors become declarative **rules** in `~/.agentglass/rules.json`. Each rule has a metric, a
filter-language `where`, **degraded** and **critical** thresholds, a `for` duration, labels, and an enable switch.
The built-in rules reproduce today's behaviour exactly. Users can tune them, disable them, or add their own, such as
session cost > $5, Bash error rate > 30% over ≥ 20 calls, approval wait > 2 min, or the same command repeated more
than 5 times.

Rules feed the row badges, header counts, preview, the `!` jump, the bell, the desktop notification, `--json`, a new
`alert` line in `--watch`, and an optional notify command.

## Why (user value)
- Today's thresholds suit one workflow. People who run long test suites get "long cmd" after 10 min. People who want
  a nudge only after 5 minutes of waiting cannot have it.
- Cost and error alarms do not exist. "Tell me when a session passes $5" is the most asked-for guard for agents that
  run unattended.
- `--watch` consumers (tmux status lines, scripts, chat bots) get alerts as structured lines instead of scraping
  the TUI.
- Two severities map onto the colours the TUI already uses: yellow ◆ and red ⚠.

## Today (current code, with path:line refs)
All of this is in `src/features/watchdog.ts`:
- Watched sessions are live, top-level ones only (`:108`). There is one tick every 500 ms (`H.onTick`, `:131-158`).
  CPU history per process tree holds ≤ 120 samples, one per process refresh of ~1.5 s (`src/model/procs.ts:66-68`).
- **waiting** (◆): a busy → idle transition raises "turn finished" (`:146`). The first sight of a session only
  records its state (`:144`). It clears when the session is busy again (`:147`) or when the user looks: selected
  for > 1 s, or its transcript is open (`:155`).
- **approval?** (◆, `approvalNote`, `:74-82`) applies while busy and the last event is a tool call with no result.
  It needs the call open > 20 s, ≥ 7 CPU samples, no active subagent, a 7-sample CPU average < 2%, and no tool shell
  command started since the call (+5 s). It is raised on the rising edge (`:150`), its note is refreshed while it
  holds (`:151`), and it clears when the condition clears (`:152`) or when the user looks.
- **stuck** (⚠, `stuckOf`, `:84-101`). The first match wins:
  - `loop`: ≥ 3 identical consecutive tool calls (`loopRun`, `:21-31`);
  - `long cmd`: a tool call pending and a tool shell command older than 600 s (`:91`);
  - `stalled`: busy, log silent > 480 s, 7-sample CPU average < 1%, no tool commands (`:92-95`);
  - `spinning`: ≥ 120 samples, log silent > 180 s, minimum CPU over those samples > 80% (`:96-99`).
- `raise()` (`:121-128`) sets `s.attention`. Bell (`\x07`) and desktop notification share a 30 s throttle per
  session (`:123`). `AGENTGLASS_NOTIFY=0` turns off the notification but not the bell (`:126`). The notification
  reads: title `agentglass`, subtitle `<harness> · <cwd basename>`, body `[approval? ]<title ≤ 120>` (`:127`).
  Stuck rules never ring or notify.
- UI:
  - row badge ⚠ (red, wins) or ◆ (yellow) (`:173`);
  - preview lines: one ◆ line and one ⚠ line with the note (`:174-182`);
  - header counts `◆ a ⚠ k`, where a session with ⚠ is not counted under ◆ (`:184-188`);
  - `!` jumps to the next ◆, then to the next ⚠ (`:190-198`);
  - help text (`:200-203`).
- `--json` gets `attention`/`stuck` through `H.complete` (`:160-170`; `src/features/cli.ts:109`). `--watch` runs no
  watchdog at all (`cli.ts:133-186`).
- Settings: only `~/.agentglass/config.json` (`src/util/config.ts`), read once at startup. Tests are in
  `src/features/watchdog.check.ts`.

## Design

### 1. File and format
`~/.agentglass/rules.json` (JSON: there is no YAML parser, and adding one is a dependency). Every field is optional:
```json
{
  "version": 1,
  "builtins": true,
  "notify": { "bell": true, "desktop": true, "throttle": "30s", "command": null, "on": ["fire", "escalate"] },
  "rules": [
    { "id": "session-cost", "metric": "session_cost", "degraded": 5, "critical": 20 },
    { "id": "bash-errors", "metric": "tool_error_rate", "where": "tool is Bash", "min_calls": 20, "degraded": "30%" },
    { "id": "approval", "critical": "2m" },
    { "id": "bash-repeats", "metric": "repeat_run", "where": "tool is Bash", "degraded": 5, "labels": { "team": "infra" } },
    { "id": "spinning", "enabled": false }
  ]
}
```
- `builtins: false` drops every built-in rule. Otherwise a user rule with a built-in `id` is **merged** into it
  (shallow, field by field). `{"id":"approval","critical":"2m"}` keeps the 20 s degraded level and adds a 2-minute
  critical level.
- Rule fields:

  | field | type | default | meaning |
  |---|---|---|---|
  | `id` | `[a-z0-9-]{1,40}` | required, unique | key for merging, alerts, `--watch` |
  | `metric` | catalog name (decision 2) | required for new rules | what is measured |
  | `where` | filter-language expression | `""` | session attributes scope the rule; call attributes select calls (call metrics only) |
  | `op` | `>` `>=` `<` `<=` | `>` | comparison |
  | `degraded`, `critical` | number, `"30%"`, or duration `"20s"`/`"2m"`/`"1h"` | — | at least one is required |
  | `for` | duration | `"0s"` | the condition must hold this long before the level fires (per level) |
  | `min_calls`, `window` | integer | 1, `0` (= whole session) | call metrics: minimum sample size, last-N-calls window |
  | `params` | object | per metric | metric tuning, e.g. `{"cpu_below": 2}` |
  | `ack` | `"look"` \| `"none"` | `"none"` | `look`: the alert is acknowledged when the session is selected > 1 s or its transcript is open |
  | `notify` | bool | `true` | bell, desktop and command on transitions (decision 5) |
  | `message` | template | per metric | placeholders `{value} {threshold} {severity} {rule} {tool} {title} {project} {harness}` |
  | `labels` | `{string: string}`, ≤ 16 | `{}` | passed through to the preview, JSON, `--watch` and the command |
  | `enabled` | bool | `true` | |

### 2. Metric catalog (`src/features/rules/metrics.ts`)
A metric gives a value or *absent* (its preconditions do not hold, so the rule cannot fire). The value is computed
at most once per session per tick and per (metric, params).

| metric | unit | entity | value (absent when …) | params (defaults) |
|---|---|---|---|---|
| `turn_done` | duration | session | time since a busy → idle transition seen in this run (busy, or no transition seen) | — |
| `approval_wait` | duration | session | age of the open tool call (not busy, no open call, < `samples` CPU samples, a subagent active, CPU avg ≥ `cpu_below`, a tool command started within `grace` after the call) | `cpu_below` 2, `samples` 7, `grace` 5s |
| `repeat_run` | count | call | identical consecutive calls at the end, as `loopRun` (the last call does not match `where`) | — |
| `command_age` | duration | session | age of the oldest tool shell command (no call pending, no command) | — |
| `stalled` | duration | session | log-silent time (not busy, < `samples`, CPU avg ≥ `cpu_below`, a tool command running) | `cpu_below` 1, `samples` 7 |
| `spinning` | duration | session | log-silent time (< `samples`, min CPU over them ≤ `cpu_above`) | `cpu_above` 80, `samples` 120 |
| `session_cost` | USD | session | `s.cost` (unknown, `s.cost < 0`) | — |
| `session_tokens` | count | session | in + out + cache read + cache write | — |
| `tool_calls` | count | call | matching calls in the session or the window | — |
| `tool_errors` | count | call | matching failed calls | — |
| `tool_error_rate` | ratio | call | errors / calls (fewer than `min_calls` matching calls) | — |

- The process-based metrics are the existing pure helpers, refactored to return numbers: `approvalNote` →
  `approvalWait(o, p)`, `stuckOf` → `commandAge`, `stalledFor` and `spinningFor`. The `Obs` shape (`watchdog.ts:71`)
  stays.
- Call metrics read filter-language's per-call rows (`Acc.calls`: `t`, `tool`, `progs`, `err`, …). `window: N`
  takes the last N rows that match `where` and have a result (`err ≥ 0`). Without `window`, every row of the session
  counts. Rows are kept for 90 days (`filter.callDays`), far longer than a live session lasts. No new ledger data
  is needed.
- `where` with call attributes (`tool`, `server`, `program`, `command`, `file`, `ext`, `status`) filters calls.
  With session attributes (`harness`, `repo`, `model`, `cwd`, `branch`, `agent`) it scopes the whole rule. Day
  attributes are rejected. The entity of each attribute comes from filter-language's catalogue; its lifting rules do
  not apply, because a rule never selects sessions by their calls.
- `samples` is capped at 400 (10 min). The process CPU history cap (`procs.ts:67`) becomes
  `max(120, the largest samples of any enabled rule)`.

### 3. Built-in rules (exact equivalence)
```
waiting   turn_done      op >=  degraded 0s     ack look  notify true   message "turn finished"
approval  approval_wait  op >   degraded 20s    ack look  notify true   message "{tool} pending {value}, cpu {cpu}%"
loop      repeat_run     op >=  critical 3                notify false  message "{tool} called {value}× in a row with the same arguments"
long-cmd  command_age    op >   critical 10m              notify false  message "{cmd} running {value}"
stalled   stalled        op >   critical 8m               notify false  message "no log activity {value}, cpu {cpu}%"
spinning  spinning       op >   critical 3m               notify false  message "cpu > {cpu}% for 3m while the log is silent {value}"
```
- **Severity → UI**: degraded = ◆ yellow and `s.attention`; critical = ⚠ red and `s.stuck`. `s.stuck` is the
  reason name of the first firing critical rule in rule order (`loop`, `long cmd`, `stalled`, `spinning` for the
  built-ins, so `--json` `stuck` values do not change; user rules give their `id`). Badges, header counts and the
  `!` order come from the same two flags, as today.
- `ack: look` reproduces `clear()` on look. An acknowledged alert loses its badge and is not counted. It stays
  acknowledged until it resolves; the next firing shows again.
- `waiting` resolves on busy, because `turn_done` becomes absent. `approval` resolves when its value becomes absent.
- First sight records only, because `turn_done` needs a transition this run. `--json` therefore reports `attention`
  only for a current `approval_wait`, as `watchdog.ts:168` does.
- One visible difference: the preview lists **every** firing alert. With the built-ins, a second ⚠ line can appear
  only when `loop` fires together with `long-cmd`, `stalled` or `spinning`.
- `watchdog.check.ts` keeps its cases. A new equivalence check runs the old helpers and the rule engine over the
  same `Obs` fixtures and compares the badges.

### 4. Engine (`src/features/rules/engine.ts`)
- State per (session path, rule id): `{level: 0|1|2, pendingSince[2], firedAt, acked, value}`.
- On each tick, for each watched session (live, top-level; same as `watchdog.ts:108`) and each enabled rule in scope:
  1. compute the value;
  2. find the highest level whose threshold holds (`op`);
  3. a level fires once it has held continuously for `for`;
  4. emit transitions `fire` (0 → n), `escalate` (1 → 2), `deescalate` (2 → 1) and `resolve` (n → 0).
- A session that stops being watched resolves all its alerts silently, as today's `watchdog.ts:138`.
- The watchdog tick calls the engine. The TUI parts of `watchdog.ts` (badges, preview, header, `!`, help) read engine
  state instead of `St`.
- An alert log: an in-memory ring of the last 500 transitions `{at, session, rule, from, to, value}`. The help
  popup's rules section shows the newest. related-events reads it.

### 5. Outputs
- **Bell/desktop**: on a `fire` or `escalate` transition of a rule with `notify: true`, subject to `notify.bell`,
  `notify.desktop` and the per-session `throttle` (default 30 s, shared by bell and desktop as today).
  `AGENTGLASS_NOTIFY=0` still disables the desktop notification. The text keeps today's form: subtitle
  `<harness> · <cwd basename>`, body `<message prefix>` + title. The built-ins give `approval? <title>` and `<title>`,
  exactly as today.
- **Notify command** (`notify.command`: an argv array, never run through a shell):
  - Placeholders in each argument are substituted.
  - The alert JSON (decision 6) goes to stdin, and env `AGENTGLASS_RULE`, `…_SEVERITY`, `…_STATE`, `…_SESSION`,
    `…_HARNESS`, `…_VALUE` are set.
  - Spawned asynchronously (`spawn`, as `src/actions.ts:99`), stdout/stderr discarded, killed after 10 s. At most 4
    run at once; extra ones are dropped with a warning toast.
  - Runs for the states in `notify.on` (default `fire`, `escalate`; `resolve` and `deescalate` are opt-in).
  - It is not subject to the bell throttle, but each transition runs at most once.
  - Honoured only if `rules.json` belongs to the user and is not group- or world-writable. Otherwise the command is
    ignored with a validation error, the same check ssh does.
- **`--json`**: adds `alerts: [{rule, severity, value, threshold, since, message, labels, acked}]` per session.
  `attention`/`stuck` are unchanged.
- **`--watch`**: the watch loop (`cli.ts:179-185`) runs the engine on every poll, after process refresh. Transitions
  become lines
  `{ts, harness, session, title, project, parent, kind:"alert", tool:null, text:<message>, alert:{rule, severity, state, value, threshold, labels}}`.
  `--no-alerts` turns them off. In `--watch`, bell and desktop are off; the notify command runs only with
  `--notify`. Watch never has a "look", so `ack: look` does nothing there.

### 6. Alert object
`{rule, severity:"degraded"|"critical", state, value, unit, threshold, since:<iso>, session, harness, title, project, message, labels}`.
Durations are in seconds, ratios 0–1, cost in USD. Text fields go through `screenOut()`/`display()`, so `--redact`
fakes titles and projects in all outputs, including the command's stdin and env.

### 7. Validation and reload
- File missing → built-ins only, silently.
- JSON syntax error → built-ins only, plus one warning (TUI toast, CLI stderr): `rules.json: <error> — using
  built-in rules`.
- Per-rule errors disable that rule only; every error is collected:
  - unknown `metric`, `id` or field (an unknown field is a warning, not an error);
  - duplicate `id`;
  - `where` does not parse: filter-language's error with its column;
  - `where` uses call attributes with a session metric;
  - a threshold of the wrong unit (`"2m"` for `session_cost`);
  - `degraded`/`critical` out of order for `op`;
  - `params` out of range.
- At TUI start, one toast: `rules.json: 2 rules disabled — agentglass rules check`.
- `agentglass rules check [--json]` prints the effective rules (built-ins merged), each diagnostic as
  `rules.json:<line>:<col>: <rule id>: <message>`, and exits 0 when clean, 1 on warnings only, 2 on errors. Line and
  column come from a small JSON position scanner, because scriptc's `JSON.parse` error text may carry no position
  (uncertain).
- `agentglass rules defaults` prints the built-ins as a ready-to-edit `rules.json`.
- Hot reload: stat the mtime every 2 s. A valid new file replaces the rule set. Engine state is kept for unchanged
  ids and resolved silently for removed ids. A broken new file keeps the old rule set and warns.

### 8. Examples (documented in `rules defaults --examples`)
| intent | rule |
|---|---|
| session cost > $5, critical at $20 | `{"id":"session-cost","metric":"session_cost","degraded":5,"critical":20,"message":"cost {value}"}` |
| Bash error rate > 30% over ≥ 20 calls | `{"id":"bash-errors","metric":"tool_error_rate","where":"tool is Bash","min_calls":20,"degraded":"30%"}` |
| same, last 50 calls only | add `"window":50` |
| approval wait > 2 min is critical | `{"id":"approval","critical":"2m"}` |
| same command repeated > 5 times | `{"id":"bash-repeats","metric":"repeat_run","where":"tool is Bash","degraded":5}` |
| only nag after 5 min of waiting | `{"id":"waiting","degraded":"5m"}` |
| long test suites are fine | `{"id":"long-cmd","critical":"45m"}` |
| Codex sessions only | `"where":"harness is codex"` on any rule |

## Interactions with other specs
- **filter-language**: the `where` grammar, attribute entities, per-call rows (`Acc.calls`), parse errors with
  columns. Its `state` attribute (`stuck` > `attention` > …) keeps working, because the engine still sets
  `s.stuck`/`s.attention`.
- **repo-view**: the `repo` attribute in `where`.
- **honest-costs**: `session_cost` uses the same cost. A global budget is honest-costs' job, not a rule.
- **related-events**: shows alert-log transitions (approval waits) on the related timeline.
- **cli-agent-mode**: `rules check --json` and `--watch` alert lines follow its output conventions.
- **otlp-export**: none (alerts are not exported).

## Testing
- `watchdog.check.ts` stays green: the helpers keep their exports, now wrapping the numeric metrics.
- `rules/engine.check.ts`: the built-in equivalence table over `Obs` fixtures (each old outcome gives the same
  badge/stuck/attention); `for` pending and reset; escalate/deescalate/resolve; ack and re-fire; merge of a user
  override into a built-in; `builtins:false`; unwatching resolves silently; the throttle.
- `rules/config.check.ts`: every validation error with line:col; unit mismatch; unknown field warning; hot reload
  keeps the old set on a broken file; the permission check for `command`.
- Call metrics: windowed error rate from `Acc.calls`; `min_calls` gate; `where` on `tool` and `program`.
- CLI: `--watch` emits alert lines for a synthetic stalled session (fake procs); `--no-alerts`; `rules check` exit
  codes.

## Out of scope
- PromQL or any expression language beyond filter-language plus one comparison.
- Global, cross-session or time-series rules (daily spend, rate of sessions), meta rules, rule groups.
- Alerting backends (Slack, PagerDuty). The notify command is the integration point.
- Rules on non-live sessions.

## Open questions
1. `turn_done` with a degraded threshold > 0 changes when ◆ appears. Should the bell still ring at the transition
   (today's behaviour), or only when the threshold is reached? The proposal: at the threshold.
2. Should `turn_done`/`waiting` also be configurable per harness? It already is, through `where: "harness is …"` on a
   copy of the rule. Is that enough?
3. Should `notify.command` also run in the TUI for `ack: look` rules that the user has already acknowledged by
   looking? The proposal: yes, because transitions are independent of acknowledgement.
