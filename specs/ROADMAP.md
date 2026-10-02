# agentglass feature roadmap

Status: **reviewed** (2026-10-02); each spec records its review decisions in "Decisions (review 2026-10-02)" and
keeps only technical verification items open. Each entry links its spec; implementation plans are cut per spec in
this order. A phase starts when the phases it depends on are merged; specs within a phase are independent.

Guiding constraints for every spec: local-first, single native binary, no required backend, no network unless the
user opts in, keyboard-first TUI, works for every harness agentglass reads (Claude Code, Codex, fx, pi, OpenCode,
Kiro, Gemini CLI).

| Phase | Spec | What it adds | Depends on |
|---|---|---|---|
| 1 | [honest-costs](honest-costs/spec.md) | billing-mode label on every cost figure, explicit unpriced row, day/month projection, optional budget | — |
| 1 | [parsing-fixes](parsing-fixes/spec.md) | small transcript-parsing corrections (titles, retries, turn boundaries, skills) and a git-remote credential scrub | — |
| 2 | [filter-language](filter-language/spec.md) | one filter grammar for list, Stats, `--json`, `--watch`; pinned filters (remembered by default); shared attribute model; per-call rows with the issuing message's model | — |
| 3 | [otlp-export](otlp-export/spec.md) | sessions exported as OpenTelemetry GenAI traces (`invoke_agent` turn root, one `chat` span per API request) to any OTLP backend, history and live, gzip | parsing-fixes (turn boundaries, fallback iterations, scrub), filter-language (export selection) |
| 4 | [triage](triage/spec.md) | "what is different about these?" — over-represented attribute values vs a baseline | filter-language |
| 4 | [session-compare](session-compare/spec.md) | side-by-side diff of two sessions or two periods | filter-language, triage (shared aggregation, `group` baseline for `t`) |
| 5 | [repo-view](repo-view/spec.md) | Repos tab: per-project cost, activity, errors, files, harness mix | filter-language |
| 5 | [git-linkage](git-linkage/spec.md) | commits, PRs and issues per session from local git and tool output | parsing-fixes (scrub) |
| 6 | [rules-config](rules-config/spec.md) | watchdog detectors as configurable rules with two severities | filter-language |
| 7 | [related-events](related-events/spec.md) | everything that happened around an event across all agents in the same repo | repo-view (project identity) |
| 7 | [cli-agent-mode](cli-agent-mode/spec.md) | JSON-first CLI when run inside a coding agent, `--format` | — |
| 7 | [command-palette](command-palette/spec.md) | Ctrl+K palette, `agentglass open <session>` deep links, single-instance link hand-off | — (turn-key anchors and trace ids use otlp-export's `TurnCursor`/id scheme when present) |
| 7 | [adaptive-refresh](adaptive-refresh/spec.md) | refresh cadence follows activity, lower idle CPU; alarms stay at 1.5 s while agents run | — |

## Why this order
1. **Phase 1** fixes numbers people already read (cost, titles, turns) and is small — every later feature builds on
   correct numbers.
2. **Phase 2** is the foundation: triage, compare, repo view, rules and export selection all speak the same filter and
   attribute model, so it comes before them.
3. **Phase 3** is the largest outward-facing lever: any OpenTelemetry backend gets coding-agent data for every
   harness, including history, without installing hooks.
4. **Phases 4–5** turn the local data into answers ("why was this expensive?", "what did this project cost?",
   "which commits came out of it?").
5. **Phase 6** makes the existing alarms tunable once the filter/attribute model exists to express conditions.
6. **Phase 7** is polish and integration; items are independent and can be picked in any order.

## Conventions across specs
- **Ledger cache version** (`src/features/usage/cache.ts` `VERSION`, 5 today): every spec that changes cached data
  bumps it once, to the next free number when it is implemented — no spec reserves a number. Specs shipped in one
  release may share one bump.
- **Keys** are mode-scoped (`src/input.ts`); each spec names the mode its new keys live in and was checked against
  that mode's current bindings. New keys: `t` triage (Sessions/Stats, and inside the compare view), `m`/`C` mark +
  compare, `S` subagent toggle (compare view), `p`/`P` pin filters (list), `r` related events
  (detail/transcript/call graph), `Ctrl+K` palette, period keys inside the Repos tab.
- **Config keys** added in `~/.agentglass/config.json` (invalid values fall back to the default with one startup
  toast): `budget.*` (honest-costs), `filter.callDays` (90) / `filter.remember` (true) / `filter.pinned`
  (filter-language), `otlp.*` incl. `otlp.compression` (gzip) and `otlp.native` (warn), `repo.idleGapMin` (5),
  `git.tailPadMin` (10), `related.minutes` / `related.conflictMinutes` (10 / 10), `agent.scope` (project),
  `open.singleInstance` (true), `refresh.mode` (adaptive).
- **Shared pieces** and their owners: attribute model + `aggregate()` + per-call rows → filter-language; the
  per-message model of each call (`tool(a, d, name, model, mq)`: the model of the assistant message that issued it,
  exact per message for Claude/Gemini/pi/OpenCode, per turn for Codex, per session for fx, unknown for Kiro) lives in
  those call rows and is what triage, compare, rules-config and the Stats `model` dimension read;
  `classifyUser()` (human/notify/peer turns) + `scrubRemote()` → parsing-fixes; `projectOf()` project identity →
  repo-view (filter-language ships the simple `.git` walk first and keeps it until repo-view lands); turn segmentation
  (`TurnCursor`) and the turn key `T` → otlp-export, reused by the call graph and by command-palette's `turn=`
  anchors; the `H.onWatch` alarm job (1.5 s while agents are live) → adaptive-refresh, used by the watchdog and the
  rules-config engine; `~/.agentglass/run/` single-instance socket → command-palette.

## Explicitly not planned
Team/adoption analytics, LLM-based session evaluation, query engines (PromQL/SQL), dashboards-as-code, autonomous
fixing, and a local OTLP receiver (revisit only if a needed signal is missing from on-disk transcripts).
