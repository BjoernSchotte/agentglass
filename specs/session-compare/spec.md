# Session compare (A vs B) — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 4 (depends on
[filter-language](../filter-language/spec.md) for groups and `aggregate()`, and on [triage](../triage/spec.md) for
distribution scoring; uses turn counts from parsing-fixes when present).

## Goal
Mark two sessions, or two days/periods, or any two filter expressions, and see a side-by-side diff: cost, turns, tokens,
cache use, tool mix, error rates, p50/p95 durations, programs, files touched, models. "Why did this run cost 4× the
last one?" and "did this week go worse than last week?" become one screen.

## Why (user value)
- Users rerun the same task with another model, harness or prompt and want to know what changed. Today that means two
  previews side by side in memory: the preview shows tokens, cost, tools and lines per session
  (`src/features/usage/stats.ts:454-462`), nothing per tool, no durations, no files.
- Period comparison ("this week vs last") is the same question over larger groups.
- It reuses triage's aggregation: little new machinery, one more answer.

## Today (current code, with path:line refs)
- Per session and day the ledger holds tokens (input normalized exclusive of cache for every harness:
  `src/harness/codex.ts:142`, `gemini.ts:306`, `claude.ts:108`), cost/unpriced, tool counts, lines, and per tool `TS`
  (n, err, duration histogram, max, result bytes) plus `Cnt` maps for programs, commands and changed files
  (`src/features/usage/record.ts:10`, `calls.ts:6-12`). Everything compare needs for **sessions and periods** is there
  already, for all history (no call rows needed).
- Percentiles from histograms: `pct()` (`calls.ts:22-29`); formatting `fmtMs`, `money`, `kfmt`, `grp`
  (`calls.ts:32`, `stats.ts:19-33`).
- No turn count in the ledger (no `turns` field in `Day`/`Acc`, `record.ts:10-18`); parsing-fixes adds turn boundaries.
- Session list keys in use: `↵ ␣ / F h l esc s R x D y c ! T` (`src/input.ts:141-167`, `callgraph/view.ts:350`,
  `watchdog.ts:190`, `themes.ts:102`); `m` and `C` are free. Row badge slot: 2 columns, used by the watchdog
  (`src/ui/list.ts:29-33`, `watchdog.ts:173`).

## Design

### 1. Groups
A comparison is two **groups**, A and B, each a filter-language expression evaluated inside the same scope (pins only;
local clauses of the origin tab are not applied — the groups are explicit). Presets create the expressions:
- **two sessions**: `session is <harness>:<id>` (new exact key registered by this spec: matches the session and, unless
  `S` toggles it off, its subagents — their cost and calls are part of the run);
- **two periods**: `day >= -6d` vs `day >= -13d and day < -6d` (this week vs last), `day is today` vs `day is yesterday`;
- **anything**: `model ~ opus` vs `model ~ sonnet`, `harness is claude` vs `harness is codex`.
Groups made only of session/day clauses use the bucket path (all history); a call clause switches to call rows
(within `filter.callDays`), as filter-language §5.1 decides.

### 2. Marking (TUI)
1. Sessions tab: `m` marks the selected session (toggle). The first mark is A, the second B; a third `m` replaces B.
   Marked rows show `A`/`B` in the title prefix (not the badge slot, which the watchdog owns). esc in the list keeps
   marks; `m` on a marked row unmarks.
2. `C` opens the compare view: with two marks → A vs B; with one mark → the mark vs the selected session; with none →
   the selected session vs the previous session of the same harness and repo (the "rerun" case), or a toast if there
   is none.
3. Stats tab: `C` compares the current period with the previous one of the same length (today vs yesterday, 7 days vs
   the 7 before), in the Stats filter scope.
4. Inside the view `a` / `b` edit a group's expression (filter-language input with completion), `x` swaps A and B.

### 3. Metrics (summary section)
| row | definition | note |
|---|---|---|
| sessions | top-level sessions in the group (subagents counted separately on the next row) | hidden for two single sessions |
| cost | Σ cost, `+?` when any part is unpriced (`money()`); with honest-costs, its billing label | |
| wall time | session: first transcript event → last activity; period: n/a | single sessions only |
| turns | user turns (parsing-fixes' count, stored per `Day` as `turns`); `n/a` for harnesses without it | |
| tokens in / out / cache read / cache write | Σ, `kfmt` | |
| cache hit | `cr / (in + cr + cw)` | input is exclusive of cache in the ledger for every harness |
| cost per turn, tokens per turn | ratio | `n/a` without turns |
| tool calls, calls per turn | Σ `tools` | |
| errors, error rate | Σ `TS.err`, err/n | |
| p50 / p95 / max call duration | merged histograms, `pct()` | "timed n/N" shown, fx has no durations |
| lines + / − | Σ add/del | |
| files touched | distinct paths in `Day.files` | |
| models | distinct models (session `model` attribute) | |
| subagents | count and Σ cost | |
Each row: `A`, `B`, `Δ` (B − A, sign-colored: more cost/errors/duration red, fewer green; neutral rows uncolored),
and `B/A` (`×2.4`). Unknown values print `n/a` and produce no Δ.

### 4. Detail sections (`tab` cycles)
1. **Tools**: per tool name (MCP grouped per server, expandable with `␣` like Stats `toolRows`, `stats.ts:179-198`):
   calls A | calls B | share A | share B | Δpp | err% A | err% B | p95 A | p95 B. Sorted by |Δ share|. With groups of
   ≥ 50 calls each, triage's χ² (triage §4.2) marks significant share changes; below that the header says "small
   samples, no significance".
2. **Programs** and **commands**: the same table over `Day.prog` / `Day.cmds` (shell tools only).
3. **Files**: three lists — only in A, only in B, in both (edits and +/− per side). Paths are shown relative to the
   group's repo root when both sides have one repo (`projectOf`), else with `~`. `enter` opens the file via the
   existing open action (`openFileN` behaviour) when it exists on disk.
4. **Models**: per model tokens and cost per side (needs call rows' `model` or, for the bucket path, the session model).
5. **Timeline** (two single sessions only): calls per 5-minute slot since each session's start, two sparkline rows,
   to see where one run stalled.
`enter` on a tool row opens the Stats drill-down for that tool scoped to group A or B (`[`/`]` pick the side); `o`
opens session A or B (`1`/`2` inside the view) in the transcript. esc returns to the origin tab.

### 5. Layout
Two value columns of equal width under a header `A: <title or expression>  ·  B: …` (titles via `titleOf`, passed
through `display()`/`screenOut()` for `--redact`). Below 100 columns the `B/A` column is dropped, below 80 the Δ column
too (values only). The bars in the tools table use `gauge()`.

### 6. Edge cases
- A = B (same session or same expression): toast "A and B are the same", view not opened.
- A live session: numbers update with the ledger (`L.ver`); the header shows "live". While a session is still being
  indexed, `L.prio` is set for it (as the preview does, `ledger.ts:99`) and the view shows "indexing N%".
- Different harnesses: fine; token rows are comparable because the ledger normalizes input (see Today). Codex/fx
  durations missing on one side: the duration rows say `n/a` for that side.
- Empty group: the view shows which group matched nothing and its expression.
- Old sessions beyond `filter.callDays`: everything from buckets still works; only call-level group clauses and the
  models-by-call section are limited (the section says so).
- Session ids: `session is` accepts `<harness>:<id>` or a unique id prefix (≥ 6 chars); ambiguous prefixes are an
  error listing the candidates.

### 7. CLI
`agentglass compare <session> <session> [--no-subagents] [--json]` and
`agentglass compare --a '<expr>' --b '<expr>' [--filter '<scope>']… [--json]`.
- Text output: the summary table plus the top 15 tool rows. `--json`: `{a:{expr, n, metrics:{…}}, b:{…},
  tools:[{tool, a:{n, err, p50, p95}, b:{…}, shareDiff, chi2?}], programs:[…], files:{onlyA:[…], onlyB:[…], both:[…]}}`.
  Unknown values are `null`.
- `complete()` runs for the sessions in both groups first. Exit 2 on bad expressions or ambiguous ids.

### 8. Computation
`aggregate()` (filter-language §5) twice with `weight: "count"` and dimensions `tool`, `program`, `command`, `file`,
`model`, plus the metric sums; the distribution rows reuse triage's `diff`/`lift`/`χ²` functions. No new cache
format: the `turns` counter comes with parsing-fixes; the `session is` key and the timeline (5-min slots from call rows,
or from `TS.h` hours for buckets) are the only additions. Cached per (A, B, scope, `L.ver`).

## Interactions with other specs
- **filter-language**: groups, scope, lifting, `aggregate()`, call-row retention; this spec registers `session`.
- **triage**: share-difference scoring and χ²; compare = triage with two explicit groups. A key `t` inside compare
  could open triage with A as selection and B as baseline (cheap, listed as open question 2).
- **parsing-fixes**: `turns`. **honest-costs**: billing labels and unpriced rows on the cost line.
- **repo-view**: `projectOf()` for relative paths; the Repos tab may offer `C` for two repos later.
- **git-linkage**: commits per side could become a row once it exists (not in this spec).

## Testing
- Fixture ledger: two sessions with known tokens, tools, errors, durations, files (one shared, one unique each) →
  every summary row, Δ, ratio and the three file lists exact; MCP grouping in the tools section.
- Periods: two days of fixtures, `day is today` vs `day is yesterday` → sums equal Stats' per-day numbers
  (`stats.ts:62-70`) for the same days.
- Subagents included/excluded (`S`), unpriced side (`+?`, no Δ), untimed side (`n/a`), A = B guard, ambiguous id.
- CLI JSON shape; text output without ANSI when not a TTY.
- Real life: rerun a small task with two models, compare, check the numbers against both previews.

## Out of scope
More than two groups, diffing transcript content or prompts, cost forecasts, compare across machines, automatic
"rerun" detection beyond same harness + repo.

## Open questions
1. Default for subagents: included (current design) — or excluded, since the parent's tool mix then reads cleaner?
2. Add `t` (triage A vs B) inside the compare view?
3. Is "previous session of the same harness and repo" a good enough default for `C` without marks, or should it ask?
