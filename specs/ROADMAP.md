# agentglass feature roadmap

Status: **draft for review** (2026-10-02). Each entry links its spec; implementation plans are cut per spec after
review, in this order. A phase starts when the phases it depends on are merged; specs within a phase are independent.

Guiding constraints for every spec: local-first, single native binary, no required backend, no network unless the
user opts in, keyboard-first TUI, works for every harness agentglass reads (Claude Code, Codex, fx, pi, OpenCode,
Kiro, Gemini CLI).

| Phase | Spec | What it adds | Depends on |
|---|---|---|---|
| 1 | [honest-costs](honest-costs/spec.md) | billing-mode label on every cost figure, explicit unpriced row, day/month projection, optional budget | — |
| 1 | [parsing-fixes](parsing-fixes/spec.md) | small transcript-parsing corrections (titles, retries, turn boundaries, skills) and a git-remote credential scrub | — |
| 2 | [filter-language](filter-language/spec.md) | one filter grammar for list, Stats, `--json`, `--watch`; pinned filters; shared attribute model | — |
| 3 | [otlp-export](otlp-export/spec.md) | sessions exported as OpenTelemetry GenAI traces to any OTLP backend, history and live | parsing-fixes (turn boundaries, scrub), filter-language (export selection) |
| 4 | [triage](triage/spec.md) | "what is different about these?" — over-represented attribute values vs a baseline | filter-language |
| 4 | [session-compare](session-compare/spec.md) | side-by-side diff of two sessions or two periods | filter-language, triage (shared aggregation) |
| 5 | [repo-view](repo-view/spec.md) | Repos tab: per-project cost, activity, errors, files, harness mix | filter-language |
| 5 | [git-linkage](git-linkage/spec.md) | commits, PRs and issues per session from local git and tool output | parsing-fixes (scrub) |
| 6 | [rules-config](rules-config/spec.md) | watchdog detectors as configurable rules with two severities | filter-language |
| 7 | [related-events](related-events/spec.md) | everything that happened around an event across all agents in the same repo | repo-view (project identity) |
| 7 | [cli-agent-mode](cli-agent-mode/spec.md) | JSON-first CLI when run inside a coding agent, `--format` | — |
| 7 | [command-palette](command-palette/spec.md) | Ctrl+K palette and `agentglass open <session>` deep links | — |
| 7 | [adaptive-refresh](adaptive-refresh/spec.md) | refresh cadence follows activity, lower idle CPU | — |

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
  that mode's current bindings. New keys: `t` triage (Sessions/Stats), `m`/`C` mark + compare, `p`/`P` pin filters
  (list), `r` related events (detail/transcript/call graph), `Ctrl+K` palette, period keys inside the Repos tab.
- **Shared pieces** and their owners: attribute model + `aggregate()` + per-call rows → filter-language;
  `scrubRemote()` → parsing-fixes; `projectOf()` project identity → repo-view (filter-language ships a simple
  version first); turn segmentation (`TurnCursor`) → otlp-export, reused by the call graph.

## Explicitly not planned
Team/adoption analytics, LLM-based session evaluation, query engines (PromQL/SQL), dashboards-as-code, autonomous
fixing, and a local OTLP receiver (revisit only if a needed signal is missing from on-disk transcripts).
