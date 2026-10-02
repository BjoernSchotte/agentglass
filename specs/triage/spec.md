# Triage — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 4 (depends on
[filter-language](../filter-language/spec.md): grammar, attribute catalogue, call rows, `aggregate()`).

## Goal
Answer "what is different about these?" without a hypothesis. The user picks a **selection** (errored tool calls,
sessions over $5, slow calls, this week) and agentglass ranks the attribute values that are over-represented in it
compared with a **baseline** (the rest, or the previous period): "Bash · program npm — 34% of errored calls vs 6% of
all calls". One key adds a value to the filter or excludes it.

## Why (user value)
- "Why do my calls fail?", "why was this week expensive?", "what do my $5+ sessions have in common?" are today
  answered by clicking through the Stats drill-down tool by tool (`src/features/usage/stats.ts:221-253`) and guessing.
- The data is local and small (≈124k calls, ≈1k sessions on a heavy machine), so a full count over every attribute is
  cheap and exact. No sampling, no backend.
- It turns the filter language into a loop: triage → include/exclude → triage again.

## Today (current code, with path:line refs)
- Stats shows per-harness totals, top tools with error rates and an hour/day chart (`stats.ts:87-166`); the drill-down
  for one tool shows programs, commands, files, a duration histogram, slowest calls and recent errors
  (`stats.ts:292-358`). There is no comparison against a baseline anywhere.
- Error and duration data per call: `done()` (`src/features/usage/calls.ts:54-75`); per-day aggregates only
  (`record.ts:10`). filter-language §4 adds per-call rows with tool, model, programs, commands, files, ms, err, out.
- Percentiles come from the log histogram (`calls.ts:22-31`); static scriptc builds have no `Math.sqrt/pow/log`
  (`calls.ts:30`), so statistics must avoid them or ship their own.
- Keys taken in list mode: `T` theme (`src/features/themes.ts:102`), `c` call graph (`src/features/callgraph/view.ts:350`),
  `!` attention (`src/features/watchdog.ts:190`); digits switch tabs (`src/input.ts:136`). `t` is free in list mode.

## Design

### 1. Model
A triage run is `(entity, scope, selection, baseline, period, weight)`:
- **entity**: `call` (rows = tool calls, needs call rows, within `filter.callDays`) or `session` (rows = sessions
  with activity in the period; bucket path, all history).
- **scope**: the effective filter of the tab triage was opened from (pins + that tab's local clauses minus the
  selection, see 4).
- **selection**: a filter expression, or the special selection `slow` (2).
- **baseline**: `rest` = scope ∧ ¬selection in the same period; `previous` = scope ∧ selection in the preceding period
  of equal length (when the selection is empty, "scope this period vs scope last period").; `group` = an explicit
  expression (scope ∧ that expression, same period) — set only when opened from session-compare's `t` (A vs B).
- **period**: today, 7 days, 30 days (default: the Stats period when opened from Stats, else 7 days).
- **weight**: `count` (default); `cost` or `tokens` for sessions; `duration` (time spent) for calls.

Both groups are computed with filter-language `aggregate()` over the same dimension list; triage adds only scoring
and the view.

### 2. Selections (presets)
Picker shown when there is no selection yet, or with `s` (keys `1`…`7` inside the triage view):
| # | preset | entity | expression | baseline |
|---|---|---|---|---|
| 1 | errored calls | call | `status is error` | rest |
| 2 | slow calls | call | `slow`: duration ≥ the p90 of the **same tool** over scope and period (untimed calls excluded from both groups) | rest |
| 3 | long calls | call | `duration > 30s` (`triage.longCall` in config) | rest |
| 4 | expensive sessions | session | `cost > 5` (`triage.expensiveUsd`) | rest |
| 5 | failing sessions | session | `error_rate > 20% and tools >= 10` | rest |
| 6 | this period vs last | call (`e` toggles session) | scope only | previous |
| 7 | custom | — | typed expression (filter-language grammar, `tab` completion) | rest |

`slow` is per tool because 30 s is normal for `Bash` and alarming for `Read`. It is a triage-only selection, not a
filter key: including it into the filter would need a per-scope p90 that changes as the filter changes.

### 3. Dimensions
Counted for every row, multi-valued ones once per distinct value (shares may then sum to more than 100%; the view says
"of calls with ≥ 1 program").
- call: `tool`, `server`, `program`, `ext`, `model`, `repo`, `harness`, `agent` (subagent type, "" = top-level shown
  as "main"), `hour`, `weekday`, `branch`, `status` (only when the selection does not fix it), `file` (high
  cardinality: only shown with support ≥ 5).
- session: `harness`, `repo`, `model`, `agent`, `branch`, `tool` (tools used), `program`, `ext`, `weekday` and `hour`
  of the session **start** (local time of its first event; not the busiest hour), `state`, `subagent`.
- Dimensions with one value in both groups are skipped (e.g. `tool` when the scope says `tool is Bash`).

### 4. Scoring and statistics
For dimension d and value v: `a` = selection rows with v, `A` = selection rows; `b`, `B` the same for the baseline.
`pS = a/A`, `pB = b/B`, `diff = pS − pB` (percentage points), `lift = pS/pB` (shown as `×5.7`, `new` when b = 0).
1. **Minimum support**: a value is listed only if `a ≥ triage.minSupport` (default 3) and `pS ≥ 1%`.
2. **Significance**: 2×2 chi-square with Yates correction,
   `χ² = N(|ad − bc| − N/2)² / ((a+b)(c+d)(a+c)(b+d))` with `c = A − a`, `d = B − b`, `N = A + B` — only
   multiplication and division, no `sqrt`/`log`. Significant if `χ² ≥ 6.63` (p < 0.01; stricter than 0.05 because many
   values are tested at once). Significance only **marks** a row, it never hides or reorders it: significant rows
   carry `●` before the χ² value, the others show their χ² without the mark (`significant: false` in `--json`).
3. **Ranking**: all values that pass minimum support, significant or not, in one list by `diff` descending; per
   dimension at most 3 values in the overview so one high-cardinality attribute (files) cannot fill the screen. `u` flips to under-represented values (most negative
   `diff`), e.g. "errors almost never happen in `Read`".
4. **Weights**: with `cost`/`tokens`/`duration`, `pS`/`pB` are weight shares (share of cost in the selection vs the
   baseline); support still counts rows; chi-square is not computed (it is a count test) and the column says
   "weighted, no significance".
5. **Guards** (shown instead of the table, each with the key that fixes it):
   - Empty baseline: `B = 0` because the scope already restricts everything to the selection (e.g. pinned or local
     `status is error` with preset 1): "Baseline is empty: the filter `status is error` already selects only these.
     `r` removes it for this triage." `r` drops the offending clauses from the triage scope only (pins and the origin
     tab are not changed); `R` removes them from the origin tab/pins for real.
   - Empty selection: "No errored calls in scope for 7 days." with `w`/`m` to widen the period.
   - Small groups: `A < 20` or `B < 20` → banner "small sample: N rows, percentages are unreliable"; significance is
     still computed and marked (the test handles small N poorly; Yates is conservative), so on small periods (one day)
   most rows are simply unmarked.
   - `previous` baseline older than `filter.callDays` for entity call → "call details are kept for 90 days".
   - Ledger still indexing → spinner + "partial" as in Stats (`stats.ts:95-97`); results refresh every 2 s.
6. **Selection inside the scope** (opening from a tab): local clauses of the origin tab become the selection, pins stay
   the scope. Example: Sessions tab with local `cost > 5` and pin `repo is agentglass` → triage of $5+ sessions vs other
   agentglass sessions. Without local clauses the preset picker opens.

### 5. View (TUI)
Full-screen view (`H.views`, `S.fview = "triage"`), opened with `t` from the Sessions tab (entity session), the Stats tab
(entity call) and the Stats drill-down (entity call, selection `tool is <tool> and status is error`, i.e. "what is
different about this tool's errors"). esc returns to the origin.
```
 triage · errored calls (812) vs rest (41,377) · 7 days · scope: repo is agentglass            b rest · e calls · c count
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 attribute  value            selection              baseline              lift     χ²
 program    npm              ███████▏      34.2%    █▍            6.1%    ×5.6   ● 412
 harness    codex            ████████      39.0%    ████▉        24.0%    ×1.6   ●  54
 ext        ts               ████▌         22.0%    █▊            8.8%    ×2.5   ●  96
 hour       14               ██▌           12.4%    ▉             4.1%    ×3.0   ●  71
 branch     wip              ▋              3.1%    ▏             0.9%    ×3.4      4.2
 model      gpt-5-codex      …
```
Keys: `↑↓` select; `enter` expands the selected attribute to all its values; `+` includes (`attr is value` into the
**origin tab's** local filter — it stays there after leaving triage; merge rules from filter-language §6.2), `-`
excludes (`attr is_not value`, same place), `p` pins it; after `+`/`-` the triage re-runs in the narrowed scope and
a toast names the tab that changed (`Sessions filter: + program is npm`). `o` opens the matching rows: the Sessions list filtered to
scope ∧ selection ∧ `attr is value` (call entity: lifted, "sessions with such calls"); for calls, `enter` on the
expanded value list shows the newest 10 matching calls and `enter` there jumps to the transcript at that call (as
`jump()` in `stats.ts:359-365`). `b` cycles baseline, `e` entity, `c` weight, `u` over/under, `s` selection picker,
`d`/`w`/`m` period, `r`/`R` guards (4.5). Footer and help list them.
Bars use the existing `gauge()`; selection bar in the accent color, baseline in dim; `--redact` scrubs values through
`display()` like the Stats tables.

### 6. CLI
`agentglass triage [--select '<expr>' | --preset errors|slow|long|expensive|failing|period] [--filter '<scope>']…
[--baseline rest|previous] [--entity call|session] [--days N] [--weight count|cost|tokens|duration] [--limit N] [--json]`
- Default output: an aligned text table (as above, no colors when not a TTY). `--json`: `{entity, period:{from,to},
  selection:{expr, n}, baseline:{mode, expr, n}, rows:[{attr, value, sel:{n, share}, base:{n, share}, diff, lift,
  chi2, significant}], guard: null | "empty-baseline" | "empty-selection" | "small-sample"}`.
- Runs `complete()` over the sessions in scope first (blocking, incremental, like `--json`). Exit 0 with a guard in the
  output (empty groups are an answer, not an error); exit 2 on bad expressions (filter-language error format).

### 7. Performance
One pass over the rows per group: ~124k calls × ~12 dimensions ≈ 1.5M map increments (tens of ms native). Cached per
(entity, canonical scope, selection, baseline, period, weight, `L.ver`); recomputed at most every 2 s while the ledger
grows. The `slow` selection needs per-tool p90 first: one extra pass using the duration histogram of filter-language
`aggregate()` (`pct()`, `calls.ts:23`).

## Interactions with other specs
- **filter-language**: all expressions, lifting rules, merge rules, `aggregate()`, the call-row retention. Triage adds no
  attributes of its own except the `slow` selection.
- **session-compare**: reuses scoring (diff, lift, χ²) for its tool-mix and program tables when both groups are large
  enough; compare is triage with two explicit groups and no "rest". Its `t` opens triage with the `group` baseline (1).
- **honest-costs**: cost weights use the same priced/unpriced split; unpriced sessions are counted with weight 0 and
  the header shows "+N unpriced".
- **rules-config** may later point an alert at "open triage for this rule's selection".

## Testing
- Scoring check: hand-computed 2×2 tables (including a = b, b = 0, B = 0, tiny N) → exact `diff`, `lift`, `χ²`,
  significance flag; ordering by `diff` over significant and non-significant rows alike, the `●` mark, and the
  3-per-dimension cap.
- Fixture ledger (from the filter-language checks) with a planted pattern: 30% of errors are `npm` vs 5% overall →
  `program npm` ranks first; no planted pattern → no significant row (guards against false positives at 6.63).
- Guards: pinned `status is error` + preset 1 → empty-baseline guard, `r` lifts it locally only.
- `+`/`-` write into the origin tab's local filter and survive leaving triage; session `hour` = start hour.
- Multi-valued dimensions: a call with programs {git, npm} counts in both, totals unchanged.
- CLI JSON shape and exit codes; text table without TTY has no ANSI.
- Real life: on the developer's ledger, preset 1 and 6 over 7 days, check the top rows by drilling in via `o`.

## Out of scope
Heatmap or chart box-select (awkward in a TUI; selection is a filter or a preset), multi-attribute combinations
("program npm **and** hour 14" as one row), the "all" baseline mode, automatic triage on alerts, LLM explanations.

## Decisions (review 2026-10-02)
1. χ² ≥ 6.63 too strict for small periods? Rank all values by share difference; χ² only marks the rows that pass
   (`●`), non-significant rows stay visible (4.2, 4.3).
2. Where does `+` include? Into the origin tab's filter (5).
3. Session-level `hour`? The session's start hour (3).

## Open questions (to verify during implementation)
None.
