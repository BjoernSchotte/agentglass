# Honest costs — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 1 (no dependencies).

## Goal
Every dollar figure agentglass shows says what it is:
1. **Billing-mode label** per figure: real spend (API key), list-price equivalent of a plan/subscription, metered by a
   cloud (Bedrock, Vertex, Foundry), routed through a gateway, or unknown. Detected per harness from auth precedence,
   config files, the agent process's environment and transcript evidence. **No secret is ever read or stored** — only
   whether a variable/field is present (plus a short allowlist of non-secret switches).
2. **Unpriced is explicit**: "unpriced: 1.2M tokens (gpt-x 900K, custom 300K) · kiro 120 credits" instead of a bare `+?`.
3. **Projection**: today and this month, from the recent burn rate.
4. **Optional monthly budget** with a warning, configured in `~/.agentglass/config.json`.

## Why (user value)
- A Max/Team/ChatGPT-plan user sees "≈$140 today" and either panics or learns to ignore the number. The same figure on
  an API key is money actually leaving the account. Today both look identical.
- `+?` hides how much is missing. 5% unpriced and 80% unpriced need different reactions (add a price vs. distrust the
  total).
- "What will this month cost at this pace?" is the question behind looking at the number at all; a budget line turns
  it into a glanceable signal.

## Today (current code, with path:line refs)
- Cost is always API list price × tokens: `src/features/usage/pricing.ts:1-2` (layers built-in < community list <
  `~/.agentglass/prices.json`), `cost()` `pricing.ts:86-91`. Model ids are normalised only by stripping a `provider/`
  prefix and a `-YYYYMMDD` suffix (`pricing.ts:77-79`); Bedrock ids (`us.anthropic.claude-…-v1:0`) and Vertex ids
  (`claude-…@2025…`) do not match and fall into unpriced.
- Booking: `tokens()` prices or adds to `unk` (`src/features/usage/record.ts:108-113`); `usageExact()` books a
  harness-reported cost (OpenCode, pi) and falls back to `tokens()` when it is ≤ 0 (`record.ts:103-107`).
- `unk` mixes units: tokens (`record.ts:112`), Kiro credits when no `kiroCreditUsd` rate (`src/harness/kiro.ts:176-177`),
  and a `1` marker for fx custom-model connections that report $0 (`src/harness/fx.ts:110`). It is kept per session
  (`Acc.unk`, `record.ts:17`) and per day (`Day.unk`, `record.ts:10`), persisted in the ledger cache
  (`src/features/usage/cache.ts:40,50`, `VERSION = 5` at `cache.ts:15`). No per-model breakdown exists.
- Display: `money()` → `≈$x` / `≈$x+?` / `cost ?` (`src/features/usage/stats.ts:30-33`); Stats summary line
  `stats.ts:98-102` with the subtitle "≈ API list price · <source>"; per-harness table cost column `stats.ts:114,124-125`;
  session preview `stats.ts:455-462`; header widget "≈$x today" plus the Codex rate-limit gauge `stats.ts:464-475`;
  help text `stats.ts:484-485`. `--json` emits `costUsd` per session, `null` when unknown (`src/features/cli.ts:61,108`;
  `s.cost = -1` when only unpriced usage exists, `src/features/usage/ledger.ts:59`).
- Codex `rate_limits.primary` is parsed into `L.rlPct/rlWin/rlReset` (`src/harness/codex.ts:145-149`, `record.ts:19`);
  `plan_type` next to it (seen locally: `"plan_type":"pro"`) is ignored.
- Config: `~/.agentglass/config.json` read once (`src/util/config.ts:9-13`), atomic writer `setConfig` (`config.ts:16-24`).
  Desktop notification via `OS.notify`, disabled by `AGENTGLASS_NOTIFY=0` (`src/features/watchdog.ts:126-127`).
- No billing-mode detection, no projection, no budget anywhere.

## Design

### 1. Billing modes
`type Bill = "api" | "plan" | "metered" | "gateway" | "unknown"` (new `src/features/usage/billing.ts`).

| mode | meaning | figure style | short tag |
|---|---|---|---|
| `api` | pay-as-you-go API key; list price ≈ real spend | `$4.20` (no `≈`) | `spend` |
| `plan` | subscription/seat (Pro, Max, Team, ChatGPT plans, Kiro, Gemini OAuth); figure = what the API would have charged | `≈$4.20` | `plan` |
| `metered` | cloud provider bills it (Bedrock, Vertex, Foundry, Azure); real spend, cloud price may differ from list | `≈$4.20` | `cloud` |
| `gateway` | a proxy/gateway with its own auth (LiteLLM, corporate proxy); spend unknown to us | `≈$4.20` | `gw` |
| `unknown` | nothing conclusive | `≈$4.20` | `?` |

Harness-reported costs (pi `usage.cost`, OpenCode `cost`, fx `total_cost`) keep their mode: they are still the
provider's list price, so on a plan they are list-equivalent too.

### 2. Detection: evidence, precedence, scope
`detect(h, s): { bill: Bill; plan: string; why: string; src: "session" | "process" | "config" }`, evaluated in this
order — the first conclusive source wins:
1. **Session evidence** (transcript, already parsed by the usage reader): Claude model id shaped like Bedrock
   (`anthropic.claude-`, `us.|eu.|apac.anthropic.`, `arn:aws:bedrock`) or Vertex (`@` date suffix) → `metered`;
   Codex `rate_limits.plan_type` present → `plan` with that plan name (`pro`, `plus`, `team`, …).
2. **Process environment** of the live agent process (only while the session is linked to a pid). Linux:
   `/proc/<pid>/environ`, split on `\0`, **names only** are kept; values are read only for the allowlisted boolean
   switches below and immediately reduced to on/off. macOS: `ps -E -o command= -p <pid>` is unreliable (truncation,
   SIP) — **not used**; macOS relies on config files. Windows: later.
3. **Config files** (current state, not historical): per harness below.
4. Otherwise `unknown`.

A conclusive result from 1 or 2 is **stamped on the session** (`Acc.bill`, `Acc.plan`, `Acc.billSrc`, persisted) so
history keeps the mode it ran with. Sessions only ever covered by 3 show the current config's mode with
`src: "config"`; the UI marks those as assumed (dim tag, "assumed from current config" in the preview). A later
session-evidence result overrides a config result, never the other way.

Per-harness rules (env names are presence checks unless marked *switch*):

| harness | precedence (first match wins) |
|---|---|
| claude | *switch* `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` → `metered` · `ANTHROPIC_AUTH_TOKEN` → `gateway` · `ANTHROPIC_API_KEY` → `api` · `apiKeyHelper` key present in `~/.claude/settings.json` / project `.claude/settings{,.local}.json` → `api` · `~/.claude.json` `oauthAccount.billingType` present (e.g. `stripe_subscription`) → `plan`, plan name from `seatTier` / `organizationType` / `claudeMaxTier` (e.g. `team_tier_1`, `claude_team`) · else `unknown`. The `env` blocks of the settings files count like the process environment (names/switches only). |
| codex | rollout `plan_type` (session evidence) · `~/.codex/auth.json` `auth_mode`: `chatgpt` → `plan`, `apikey` → `api` (the `OPENAI_API_KEY` field: presence only) · env `OPENAI_API_KEY`/`CODEX_API_KEY` → `api` · `~/.codex/config.toml` `model_provider` other than `openai` (line-scan for the key, no TOML parser): `azure` → `metered`, anything else → `gateway`. |
| gemini | *switch* `GOOGLE_GENAI_USE_VERTEXAI` → `metered` · `~/.gemini/settings.json` `security.auth.selectedType`: `gemini-api-key` → `api`, `vertex-ai` / `compute-default-credentials` / `cloud-shell` → `metered`, `oauth-personal` → `plan` · env `GEMINI_API_KEY` / `GOOGLE_API_KEY` → `api`. |
| pi | per provider: `~/.pi/agent/auth.json` `{<provider>: {type}}` — `oauth` → `plan`, an API-key type → `api`; env `<PROVIDER>_API_KEY` → `api`. Mode is resolved per provider of each assistant message (see 4). |
| opencode | per provider: `~/.local/share/opencode/auth.json` `{<providerID>: {type: "oauth"|"api"|"wellknown"}}` → `plan` / `api` / `gateway`. |
| kiro | always `plan` (Kiro bills plan credits); with `kiroCreditUsd` set the figure is credit-equivalent, still `plan`. |
| fx | `unknown` until its auth storage is documented (open question). |

All file reads are size-capped (`readText(…, 0, 2 MiB)`), cached by mtime and re-checked at most every 60 s
(`refreshSlow` cadence or slower). `~/.claude.json` holds personal data (e-mail, names, org UUIDs): only the four
named fields are copied out; the parsed object is dropped right away; nothing else is logged, cached or exported.

### 3. Data model changes (ledger)
- `Day` (`record.ts:10`): replace `unk` with
  - `unk: number` — unpriced **tokens only**;
  - `um: Map<string, number>` — unpriced tokens per model id (as booked, `"?"`-prefixed Gemini keys unprefixed);
  - `uc: number` — Kiro credits without a rate;
  - `cp: Map<string, number>` — cost per provider key (`""` for single-provider harnesses; pi/OpenCode pass the
    message's provider id) so the mode can be resolved per provider at display time;
  - `hc: number[24]` — cost per local hour (for the projection, 7).
- `Acc` (`record.ts:11-18`): `unk` same meaning change; `uc`; `bill`, `plan`, `billSrc` (2).
- fx: the $0-snapshot case books the snapshot's token delta as unpriced tokens under model `a.model || "fx:custom"`
  instead of the `1` marker (`fx.ts:110`).
- Kiro: credits without a rate go to `uc`, not `unk` (`kiro.ts:177`).
- `tokens()`/`usageExact()` get an optional trailing `prov = ""` parameter.
- Cache: `VERSION` bumps once to the next free number at implementation time (`cache.ts:15`; 5 today), new day keys `um`, `uc`, `cp`, `hc`; acc keys `bill`, `plan`, `bs`. A
  version bump re-indexes everything once (minutes on large histories; the existing indexing gauge shows progress).
- `price()` (`pricing.ts:74-84`): normalise Bedrock (`[region.]anthropic.` prefix, `-v\d+(:\d+)?` suffix) and Vertex
  (`@\d{8}` suffix) ids before the prefix lookup, so metered usage is priced at list instead of falling into unpriced.

### 4. Aggregation by mode
`agg()` (`stats.ts:49`) additionally sums cost per mode: for each session/day, every `cp` entry is resolved through
`modeOf(session, prov)` (per-provider rule for pi/OpenCode, otherwise the session's stamped or assumed mode). Result:
`byMode: Record<Bill, number>`, `unk`, `um` (merged, top 5 + rest), `uc`. Cached like today (`L.ver`, 5 s).

### 5. Display
- **Money format**: `money(c, unk)` becomes `money(c, bill)`; `api` without `≈`, everything else with `≈`. The `+?`
  suffix stays only where width is tight (header, session list); everywhere else the unpriced amount is spelled out.
- **Header widget** (`stats.ts:464-475`): one mode today → `$3.10 spend today` / `≈$9.20 plan today`; mixed →
  `$3.10 spend + ≈$9.20 plan`; shrinks to `≈$12.30 today` when narrow. Budget state colours it (8).
- **Stats summary** (`stats.ts:98-102`): line 1 subtitle becomes `prices: <source> · billing: Claude plan (team) · Codex plan (pro) · Gemini spend`
  (assumed modes dim with `*`). Line 2 starts with the split figure, then
  `· unpriced 1.2M tok` (dim; omitted when 0). A new line under the per-harness table (below `Σ total`):
  `unpriced  gpt-x 900K · custom 300K · +2 models · kiro 120 credits (set kiroCreditUsd)` — hidden when nothing is
  unpriced. Table: the cost column shows the per-harness figure with its tag (`$3.10 spend`, `≈$9.20 plan`, `mixed`).
- **Projection**: appended to Stats line 3 after "busiest" when `W ≥ 130`, else it replaces the "busiest" text on line 3
  (busiest stays visible in the per-harness table order):
  `→ today ≈$14 · month ≈$310` and, with a budget, `of $200 (155%)`. Shown in both Today and 7-days views.
- **Session preview** (`stats.ts:455-462`): `$1.20 spend` or `≈$1.20 plan (team)`; `+ 340K tok unpriced (gpt-x)`
  when > 0; `billing assumed from current config` when `billSrc = config`.
- **Help** (`stats.ts:484-485`): the "costs ≈ API list price" line explains the tags.

### 6. CLI
- `--json` per session (`cli.ts:59-61,108`): add `billing: {mode, plan, source}`, `unpricedTokens`,
  `unpricedCredits`. `costUsd` keeps its meaning (list-price figure; `null` when only unpriced usage exists).
- New `agentglass cost [--json] [--harness h]`: today, last 7 days, month-to-date, per mode, unpriced breakdown,
  projection, budget state. Text output is a small table; `--json`:
  `{today:{byMode,unpriced}, month:{byMode,unpriced,projected}, budget:{monthlyUsd,counts,used,projected,state,approx}}`
  (`approx` per 8).
  Runs the blocking `complete()` path like `--json` (`ledger.ts:91-96`). Exit code 0; `3` when the budget is exceeded
  and `--check` is given (for shell prompts / cron).

### 7. Projection
- **Today**: `spent_so_far + Σ_{h > now} profile[h]`, where `profile[h]` = mean cost in local hour `h` over the last
  14 days that had any cost (from `Day.hc`). The current hour contributes `max(0, profile[h] − spent_this_hour)`.
  Needs ≥ 3 such days, else shown as `—` with "not enough history".
- **Month**: `month_to_date + remaining_days × mean daily cost of the last 14 complete days` (weekends included, they
  are part of the pattern). Needs ≥ 3 complete days with data.
- Projections are per mode; the budget (8) uses the sum over its counted modes.
- Limits stated in the help: history is what is still on disk (Claude and Gemini delete old sessions after ~30 days by
  default); a new session pattern makes the first days noisy. No smoothing beyond the mean (YAGNI).

### 8. Budget
`~/.agentglass/config.json`:
```json
{ "budget": { "monthlyUsd": 200, "counts": ["api", "metered", "gateway"], "warnAt": 0.8 } }
```
- `monthlyUsd` (number > 0; absent = no budget). `counts`: modes that count; default `["api","metered","gateway"]` —
  real or possibly real spend. `metered` counts by default although cloud discounts/commitments make its list-price
  figure approximate: whenever a counted `metered` or `gateway` amount is > 0, the budget figures carry an approximate
  marker — `≈` before used/projected (`≈$170 of $200`), and `budget.approx: true` in `agentglass cost --json`. A plan
  user who wants a soft cap on list-equivalent sets `["plan"]` or `["all"]` (then `≈` too).
  `warnAt`: 0 < x < 1, default 0.8. Invalid values → ignored with one startup toast.
- States: `ok`; `watch` (projected month > budget, or used ≥ `warnAt`) → header figure yellow; `over` (used ≥ budget)
  → red, a toast once per calendar day and `OS.notify` once per day (respects `AGENTGLASS_NOTIFY=0`). Last notified
  day is kept in memory only (a restart may notify again the same day — accepted).
- No in-TUI editor; `B` in Stats shows the current budget and the config path (key free in Stats today).

### 9. Plan allowance (Claude), best effort
For `plan` Claude sessions, `~/.claude.json` `cachedUsageUtilization.utilization.{five_hour,seven_day}.{utilization,resets_at}`
gives an allowance gauge like the Codex one (`stats.ts:469-473`): header `· cc 7d 71%`. Undocumented cache written by
Claude Code, so it ships behind a guard:
- **Staleness**: hidden when `fetchedAtMs` is older than 1 h.
- **Shape check**: `allowanceOf(obj)` accepts only the exact path above with `utilization` a number in 0–100 (or
  0–1, scaled) and `resets_at` a parseable timestamp; anything else → gauge hidden, no toast, one debug-log line.
- **Drop rule** (maintenance policy, not runtime): the check pins the shape seen at implementation. If Claude Code
  changes the shape once, the check is updated to the new shape; a second change removes the gauge and this section
  instead of chasing it. The fixture test (Testing) is what notices the change.

### Failure modes
- Unreadable/malformed config → that rule is skipped, mode falls through; never an error toast for missing files.
- `/proc/<pid>/environ` unreadable (other user, gone) → skip step 2.
- Mixed modes inside one session (a user switches from `/login` to an API key mid-session): per-session stamp shows the
  first conclusive mode. Accepted; documented.

### Privacy
No secret value is read: environment values only for the boolean switches `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `GOOGLE_GENAI_USE_VERTEXAI`; auth files are parsed for type
fields only; `~/.claude.json` for four plan fields plus the allowance block. Nothing leaves the machine. The ledger
cache stores mode, plan name and source, never evidence values. `--redact` leaves billing tags as they are (not
personal), and replaces the plan name when it contains an organisation name (it does not today; checked by pattern).

## Interactions with other specs
- **parsing-fixes**: L2 (fallback iterations) changes Claude token totals; land it before or with the cache bump here so
  only one re-index happens (both bump `VERSION` — merge into one bump if they ship together).
- **otlp-export**: exports `billing.mode` and `plan` as span attributes, `unknown` when undetermined.
- **filter-language**: `billing is plan`, `unpriced > 0` become filter keys over the same fields.
- **repo-view / session-compare**: reuse `byMode` aggregation and `money(c, bill)`.
- **rules-config**: budget states may later become rules; this spec keeps the fixed thresholds.

## Testing
- `billing.check.ts`: precedence tables per harness from fixture env-name sets and fixture config files (fake
  `HOME`), incl. malformed JSON, missing files, switches set to `0`/`false`, Bedrock/Vertex model ids.
- `/proc` environ parser: values never retained (assert the returned structure has names only).
- `record.check.ts`: unpriced per model, Kiro credits into `uc`, fx $0 snapshot as tokens, `cp` per provider, `hc`.
- `pricing`: Bedrock/Vertex id normalisation hits the right row.
- Projection: synthetic `Day` sets (0, 2, 3, 14 days; current hour partially spent; month boundary; DST day).
- Budget: state transitions and once-per-day notify; `approx` set iff a counted metered/gateway amount > 0; default
  `counts` includes `metered`.
- Allowance: `allowanceOf` accepts the pinned fixture shape, rejects renamed/missing fields, out-of-range values and
  stale `fetchedAtMs`.
- Cache: v5 file discarded and re-indexed; v6 round-trip.
- Manual: header/Stats at 80, 120, 200 columns, mixed and single mode.

## Out of scope
- Fetching real invoices or usage from provider APIs (network, credentials).
- Per-request mode switching inside one session; team/org budgets; currency other than USD.
- Credit balance (`rate_limits.credits.balance`) display.

## Decisions (review 2026-10-02)
1. Metered toward the default budget? Yes; budget figures carry the `≈` approximate marker (8).
2. Claude allowance gauge on an undocumented cache? Ships behind the staleness/shape guard; dropped if the shape
   changes twice (9).

## Open questions (to verify during implementation)
1. fx billing: where does fx store its auth/provider config? Until known, `unknown`.
2. Codex `auth_mode` values beyond `chatgpt` (seen) and `apikey` (expected) — verify on an API-key login.
3. pi `auth.json` type literal for API keys (`api_key`?) — verify against pi source.
