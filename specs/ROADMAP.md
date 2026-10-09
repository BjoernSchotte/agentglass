# agentglass feature roadmap

Status (2026-10-08): **Round 1 and Round 2 are shipped** (versions per entry below). Round 1 was reviewed 2026-10-02; each spec records its review decisions in "Decisions (review 2026-10-02)" and
keeps only technical verification items open. Each entry links its spec; implementation plans are cut per spec in
this order. A phase starts when the phases it depends on are merged; specs within a phase are independent unless the
"Depends on" column names a spec of the same phase — that one merges first.

Guiding constraints for every spec: local-first, single native binary, no required backend, no network unless the
user opts in, keyboard-first TUI, works for every harness agentglass reads (Claude Code, Codex, fx, pi, OpenCode,
Kiro, Gemini CLI).

All Round 1 specs shipped in 2026.10.4 (2026.10.3 was tagged but not published).

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
| [model-prices](model-prices/spec.md) (shipped 2026.10.5) | price unknown models from the TUI (`$` in Stats, palette) and the CLI (`agentglass prices`), aliases (estimates, `≈`), per-model costs from pi/OpenCode configs, price sources in Stats/`--json`/OTLP, price changes re-price the ledger in memory (`Day.tp`, no re-index) | honest-costs (`Day.mt/um/cp/hc`), cli-agent-mode, command-palette (`H.dynActions`); independent of tui-footprint (model-prices bumps `VERSION`; tui-footprint keeps it) |
| [tui-footprint](tui-footprint/spec.md) (shipped 2026.10.5) | TUI memory and CPU: streamed one-session-per-line ledger cache, lazy columnar call rows, ledger/scan/view/git work only on change, Linux `/proc` process scan instead of `ps`, frames on visible change, cold-start indexing gauge; golden comparison keeps every number identical (RSS ~820 → ≤ 300 MB, CPU 19 % → ≤ 2 %) | — ; independent of model-prices (tui-footprint keeps `VERSION`; model-prices bumps it, `Day.tp` stays a plain field in the cache line) |
| [macos-footprint](macos-footprint/spec.md) (shipped 2026.10.6) | the tui-footprint CPU gains on macOS: processes, cwd and open files read through `libproc`/`sysctl` (scriptc FFI + a small C file) instead of spawning `ps` every 1.5 s and `lsof` every 5 s; one incremental scanner shared with Linux; `AGENTGLASS_PROCS=ps` fallback; a one-runner macos-14 footprint workflow and a ps-parity check (away ≤ 2 %, children ~1.6 % → ≤ 0.2 %) | tui-footprint (released 2026.10.5) |
| [mux-herdr](mux-herdr/spec.md) (shipped 2026.10.6, plus plugin agentglass-herdr v0.1.0) | herdr, first-class both ways. **agentglass**: multiplexer port (`src/mux/`: tmux, herdr, none); herdr agents get send (`agent prompt`, refused at dialogs), jump (`agent focus`), resume in a new herdr tab, approval ◆ from herdr's `blocked`, exact process ↔ session links from `agent_session`, herdr state in the row, grouping by herdr workspace (`workspace` filter, `--by workspace`), `--json mux`, filter key `mux`; a versioned CLI contract (`contract: 1`, `docs/cli-contract.md`, contract test). **Plugin** (new public repo `BjoernSchotte/agentglass-herdr`, POSIX sh, contract-only): popup, open in agentglass, `agentglass://` link handler, opt-in fixed-width `$ag_cost`/`$ag_alert` tokens, notify recipe, CI, releases | — (uses tui-footprint's slow-job and watchdog cadences; no `VERSION` bump) |
| [fleet](fleet/spec.md) (shipped Part A 2026.10.6, Part B 2026.10.8) | several machines in one view. **Part A** (SSH pull MVP): `fleet.hosts`, each host's `fleet pull` (`--json` sessions + `cost --json` + allowance) through a shared, detached SSH connection into a 0700 spool, host-qualified rows with a host badge and a `host` filter key, staleness and cached reports, fleet cost/budget/allowance, `fleet status`, a forced-command key (`fleet serve`, `fleet authorize`), redaction at the source. **Part B** (exactness): incremental `agentglass-snapshot/v1` with acknowledged generations, hashed Claude message-id ownership for an exact cross-host merge (no `≈`), local re-pricing and time-zone re-bucketing, `dir` hosts (snapshot drops via rsync/Syncthing), live `fleet watch`. Defines the one remote-host model (`HostFeed` → `HostReport`) all transports share | cli-agent-mode (`jsonSess`, `format.ts`), honest-costs (`budgetState`, allowance guard), filter-language, model-prices (`reprice`, `Day.tp`); shares `src/util/hostid.ts` and `src/model/state.ts` with otlp-complete |
| [otlp-complete](otlp-complete/spec.md) (shipped 2026.10.6) | export completeness, so a receiver can rebuild agentglass's view: client TLS (`otlp.tls`, mTLS to a Collector; TLS failures not retried), an OTLP logs stream from `--watch --otlp` (heartbeat, session state, `turn.open`, alerts), `host.id`, opt-in titles, `agentglass.request.id`, `agentglass.repo.key`, the 1-hour cache-write split, opt-in `meta` call details, and the receiver contract (dedup by response id, native joins, drop `user.email`); transcripts stay on the host | otlp-export (implemented), rules-config, repo-view |
| [otlp-hub](otlp-hub/spec.md) (shipped 2026.10.8) | collection from hosts that cannot be reached over SSH: a hub reader for OTel Collector file-exporter output (the mTLS path for teams) and the built-in `agentglass receive` (OTLP/HTTP JSON + protobuf, gzip; loopback by default, exposed via `tailscale serve`, a TLS proxy or an optional C-backend HTTPS binary; a token per host with rotation, revocation and host-id pinning; limits, backpressure, disk budget, retention; hub-side scrubbing); hosts join the fleet as a third feed with exact merge, liveness and alarms | otlp-complete T3 + T4 (attributes, logs stream) before its mapping task; fleet T2, T6, T10, T13 (model, rows, codec, merge); runs in parallel with fleet Part B |
| [agent-wait](agent-wait/spec.md) (shipped 2026.10.10) | what agents wait on: wall time per normalised command family (`pnpm test`, `tsc`, `gh run watch` …; word rules, user-extensible in `wait.families`) and per tool, share of agent time, p50/p95, failure rate, trend, the tool / user / model split; contention between agents' heavy commands live (RSS, host load) and in history (peak, hours at ≥ 2/≥ 3, overlap slowdown); Wait tab (key 5), `agentglass wait` (`--json`, `--now`, `--check` exit 3 for agents), filter keys `family`/`kind`, opt-in `contention` rule (host-wide notification), OTLP `agentglass.tool.family/kind`, `fleet pull --wait` with exact merge | filter-language, rules-config, tui-footprint (lazy rows, budgets), cli-agent-mode, fleet Part A; no `VERSION` bump |

Order inside Round 2 for these three: fleet Part A and otlp-complete in parallel; then fleet Part B and otlp-hub in
parallel (otlp-hub's mapping task waits for otlp-complete T4 and fleet T13).

## Round 3 (after 2026.10.10)

| Spec | What it adds | Depends on |
|---|---|---|
| [mcp-server](mcp-server/spec.md) (implemented, PR open) | `agentglass-mcp`, a small stdio MCP server (one per agent session, ~0.13 MB idle, a second binary in every archive): 11 read-only tools — the calling session, sessions, errors, cost, triage, compare, related events, `contention` ("start my tests now?"), wait history, fleet hosts, unpriced models — each one `agentglass` CLI child in agent mode; identity from the process tree, project scope, `--redact`, no transcript content without `--content`, size cap + cursor pagination, golden `tools/list` under the CLI contract; `agentglass mcp install` (prints; `--write` runs each harness's own `mcp add` with consent) and `mcp doctor` | cli-agent-mode (contract 1), agent-wait, filter-language, triage, session-compare, related-events, model-prices, fleet Part A; release packaging; no `VERSION` bump |
| agent-wait follow-ups (implemented, PR open; [spec](agent-wait/spec.md) Decisions 16–20) | per-day digests beside the calls files (7-day first open 0.16 s), a first open without them worked out on the way and by a background job within the indexer's budget, family hints for commands cut at 200 characters (5.05 % → 0.29 %), Codex runs after a yield, Claude's eval argv proven on macOS | agent-wait; calls-file `FORMAT` 3 (format 2 still reads; a session whose cut may hide a family, or a Codex one with `exec` calls, indexes again, once); no ledger `VERSION` bump |
| [debug-episodes](debug-episodes/spec.md) (spec, PR open) | how agents debug code and whether they clean up: temporary instrumentation (explicit markers `agentglass:debug`, `#region debug`, temp tags; debug prints the same session added and removed again) captured from every harness's edit payloads at index time; leftovers verified on disk, a built-in `leftover` rule at turn end, `⚑` badge, `debug is leftover` filter; debug episodes (instrument → reproduce → read evidence → fix → verify) with runs, failed runs, fixes, reverts, wall time and ≈ cost; one versioned plain-JSON view model (`DebugVM`, `agentglass://` links) for the `E` panel, `agentglass debug` (`--check` exit 3, `--instructions`) and an MCP `debug` tool; evidence lane, timeline, triage churn and stream events in phase 2 | filter-language, rules-config, agent-wait (families), honest-costs (`Day.hc`, billing), cli-agent-mode, command-palette, mcp-server; one ledger `VERSION` bump |

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
  (`Day.act`; shared with git-linkage's `Acc.vcs` if shipped together), debug-episodes (`Acc.de/dp/dh/dhc/dr`). triage, session-compare, rules-config,
  related-events, cli-agent-mode, command-palette and adaptive-refresh change no cached data.
- **Keys** are mode-scoped (`src/input.ts`); each spec names the mode its new keys live in and was checked against
  that mode's current bindings. New keys: `t` triage (Sessions/Stats, and inside the compare view), `m`/`C` mark +
  compare, `S` subagent toggle (compare view), `p`/`P` pin filters (list), `r` related events
  (detail/transcript/call graph), `Ctrl+K` palette, period keys inside the Repos tab, `E` debug episodes
  (transcript, Sessions).
- **Config keys** added in `~/.agentglass/config.json` (invalid values fall back to the default with one startup
  toast): `budget.*` (honest-costs), `filter.callDays` (90) / `filter.remember` (true) / `filter.pinned`
  (filter-language), `otlp.*` incl. `otlp.compression` (gzip) and `otlp.native` (warn), `repo.idleGapMin` (5),
  `git.tailPadMin` (10), `related.minutes` / `related.conflictMinutes` (10 / 10), `agent.scope` (project),
  `open.singleInstance` (true), `refresh.mode` (adaptive), `debug.markers` / `debug.heuristics` / `debug.idleMin`
  ([] / false / 30).
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
Team/adoption analytics, LLM-based session evaluation, query engines (PromQL/SQL), dashboards-as-code and autonomous
fixing. A local OTLP receiver was listed here until 2026-10-06; it is now planned in [otlp-hub](otlp-hub/spec.md)
(the user's decision: world-class log collection and distribution, dogfooding the OTLP export; fleet spec Decision 16).
