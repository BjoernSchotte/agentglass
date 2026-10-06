# agentglass feature roadmap

Status: **reviewed** (2026-10-02); each spec records its review decisions in "Decisions (review 2026-10-02)" and
keeps only technical verification items open. Each entry links its spec; implementation plans are cut per spec in
this order. A phase starts when the phases it depends on are merged; specs within a phase are independent unless the
"Depends on" column names a spec of the same phase — that one merges first.

Guiding constraints for every spec: local-first, single native binary, no required backend, no network unless the
user opts in, keyboard-first TUI, works for every harness agentglass reads (Claude Code, Codex, fx, pi, OpenCode,
Kiro, Gemini CLI).

| Phase | Spec | What it adds | Depends on |
|---|---|---|---|
| 1 | [honest-costs](honest-costs/spec.md) | billing-mode label on every cost figure, explicit unpriced row, per-model day buckets (tokens + cost per model per day), day/month projection, optional budget, Claude 5h + 7d allowance gauge | — |
| 1 | [parsing-fixes](parsing-fixes/spec.md) | small transcript-parsing corrections (titles, retries, turn boundaries, skills), a per-day human-turn counter (`Day.turns`) and a git-remote credential scrub | — |
| 2 | [filter-language](filter-language/spec.md) | one filter grammar for list, Stats, `--json`, `--watch`; pinned filters (remembered by default); shared attribute model; per-call rows with the issuing message's model | phase 1 (honest-costs, parsing-fixes: both touch the adapters' `usage()` lines, `record.ts` and `VERSION`) |
| 3 | [otlp-export](otlp-export/spec.md) | sessions exported as OpenTelemetry GenAI traces (`invoke_agent` turn root, one `chat` span per API request) to any OTLP backend, history and live, gzip | parsing-fixes (turn boundaries, fallback iterations, scrub), filter-language (export selection), honest-costs (billing mode `agentglass.billing.mode`, cost basis) |
| 4 | [triage](triage/spec.md) | "what is different about these?" — over-represented attribute values vs a baseline | filter-language |
| 4 | [session-compare](session-compare/spec.md) | side-by-side diff of two sessions or two periods | filter-language, triage (shared aggregation, `group` baseline for `t`); uses `Day.turns` (parsing-fixes) and per-model day buckets (honest-costs) |
| 5 | [repo-view](repo-view/spec.md) | Repos tab: per-project cost, activity, errors, files, harness mix | filter-language |
| 5 | [git-linkage](git-linkage/spec.md) | commits, PRs and issues per session from local git and tool output | parsing-fixes (scrub), repo-view (`Ident` incl. `gitdir`, `Day.act`) |
| 6 | [rules-config](rules-config/spec.md) | watchdog detectors as configurable rules with two severities | filter-language, repo-view (`repo` attribute value) |
| 7 | [related-events](related-events/spec.md) | everything that happened around an event across all agents in the same repo | repo-view (project identity, `Day.act`), git-linkage (commits, reflog), rules-config (alert log), filter-language |
| 7 | [cli-agent-mode](cli-agent-mode/spec.md) | JSON-first CLI when run inside a coding agent, `--format` | honest-costs (billing, per-model day buckets for `cost --by model`), filter-language (`aggregate()`), repo-view (`identOfCwd`) |
| 7 | [command-palette](command-palette/spec.md) | Ctrl+K palette, `agentglass open <session>` deep links, single-instance link hand-off | cli-agent-mode (`src/model/sessref.ts`, `addCmd()`, `format.ts`); otlp-export (`TurnCursor`, trace id scheme, `sha256.ts`), repo-view, filter-language |
| 7 | [adaptive-refresh](adaptive-refresh/spec.md) | refresh cadence follows activity, lower idle CPU, rendering capped at 1/s while the terminal is unfocused; alarms stay at 1.5 s while agents run | — |

## Round 2 (after 2026.10.4)

| Spec | What it adds | Depends on |
|---|---|---|
| [model-prices](model-prices/spec.md) (implemented, PR pending review) | price unknown models from the TUI (`$` in Stats, palette) and the CLI (`agentglass prices`), aliases (estimates, `≈`), per-model costs from pi/OpenCode configs, price sources in Stats/`--json`/OTLP, price changes re-price the ledger in memory (`Day.tp`, no re-index) | honest-costs (`Day.mt/um/cp/hc`), cli-agent-mode, command-palette (`H.dynActions`); independent of tui-footprint (model-prices bumps `VERSION`; tui-footprint keeps it) |
| [tui-footprint](tui-footprint/spec.md) | TUI memory and CPU: streamed one-session-per-line ledger cache, lazy columnar call rows, ledger/scan/view/git work only on change, Linux `/proc` process scan instead of `ps`, frames on visible change, cold-start indexing gauge; golden comparison keeps every number identical (RSS ~820 → ≤ 300 MB, CPU 19 % → ≤ 2 %) | — ; independent of model-prices (tui-footprint keeps `VERSION`; model-prices bumps it, `Day.tp` stays a plain field in the cache line) |
| [macos-footprint](macos-footprint/spec.md) | the tui-footprint CPU gains on macOS: processes, cwd and open files read through `libproc`/`sysctl` (scriptc FFI + a small C file) instead of spawning `ps` every 1.5 s and `lsof` every 5 s; one incremental scanner shared with Linux; `AGENTGLASS_PROCS=ps` fallback; a one-runner macos-14 footprint workflow and a ps-parity check (away ≤ 2 %, children ~1.6 % → ≤ 0.2 %) | tui-footprint (released 2026.10.5) |
| [mux-herdr](mux-herdr/spec.md) | herdr, first-class both ways. **agentglass**: multiplexer port (`src/mux/`: tmux, herdr, none); herdr agents get send (`agent prompt`, refused at dialogs), jump (`agent focus`), resume in a new herdr tab, approval ◆ from herdr's `blocked`, exact process ↔ session links from `agent_session`, herdr state in the row, grouping by herdr workspace (`workspace` filter, `--by workspace`), `--json mux`, filter key `mux`; a versioned CLI contract (`contract: 1`, `docs/cli-contract.md`, contract test). **Plugin** (new public repo `BjoernSchotte/agentglass-herdr`, POSIX sh, contract-only): popup, open in agentglass, `agentglass://` link handler, opt-in fixed-width `$ag_cost`/`$ag_alert` tokens, notify recipe, CI, releases | — (uses tui-footprint's slow-job and watchdog cadences; no `VERSION` bump) |

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
6. **Phase 7** is polish and integration. Recommended merge order: cli-agent-mode, related-events, command-palette,
   adaptive-refresh (command-palette needs cli-agent-mode; the first three all touch `src/features/cli.ts`).
   rules-config (phase 6) runs its engine on the watchdog tick and moves to adaptive-refresh's `H.onWatch` when that
   lands — whichever of the two merges second does the move.

## Conventions across specs
- **Ledger cache version** (`src/features/usage/cache.ts:15` `VERSION`, 5 today; honest-costs moves it with the codec to
  `src/features/usage/codec.ts`): every spec that changes cached data
  bumps it once, to the next free number at implementation time — no spec reserves a number. Specs of one phase that
  ship together share one bump. Plans that bump: honest-costs + parsing-fixes (one shared bump: `um`/`uc`/`cp`/`hc`/
  `mt`, iterations, `skills`, `turns`), filter-language (per-call rows, `Acc.t0`), otlp-export (`Acc.rs`), repo-view
  (`Day.act`; shared with git-linkage's `Acc.vcs` if shipped together). triage, session-compare, rules-config,
  related-events, cli-agent-mode, command-palette and adaptive-refresh change no cached data.
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
  those call rows and is what triage, compare, rules-config and the Stats `model` dimension read; `dayMatches()`,
  `intSetting()` (config integers) → filter-language; per-model day buckets (`Day.mt`, `modelUses()`, tokens + cost per
  model per day) → honest-costs, read by session-compare's models section and cli-agent-mode's `cost --by model`;
  `classifyUser()` (human/notify/peer turns), `Day.turns` + `scrubRemote()` → parsing-fixes; `Ident` (incl. `gitdir`)
  and `projectOf()` project identity →
  repo-view (filter-language ships the simple `.git` walk first and keeps it until repo-view lands); turn segmentation
  (`TurnCursor`) and the turn key `T` → otlp-export, reused by the call graph and by command-palette's `turn=`
  anchors; the `H.onWatch` alarm job (1.5 s while agents are live) → adaptive-refresh, used by the watchdog and the
  rules-config engine; `src/model/sessref.ts` (`findSession`), `addCmd()`, `format.ts` → cli-agent-mode;
  `~/.agentglass/run/` single-instance hand-off (spool files + `tui.lock`; scriptc 0.1.7 has no Unix-domain sockets)
  → command-palette.

## Explicitly not planned
Team/adoption analytics, LLM-based session evaluation, query engines (PromQL/SQL), dashboards-as-code, autonomous
fixing, and a local OTLP receiver (revisit only if a needed signal is missing from on-disk transcripts).
