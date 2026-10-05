# Model prices — spec

Status: **draft** (2026-10-05). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4).

## Goal
Every model agentglass sees can get a price, from inside the tool, without a re-index:
1. **TUI price editor**: `$` in Stats opens a model price panel; set a price, alias a model or remove an override. The
   palette offers "Set price for <model>" for every unpriced model. Costs update on the next frame.
2. **CLI**: `agentglass prices` lists every model seen with its price source; `prices set`, `prices alias`,
   `prices unset`; stable `--json`, JSON errors inside an agent.
3. **Aliases**: price an unknown id like a known one (`codex-auto-review → gpt-6-sol`); the cost is marked as an estimate.
4. **Gateway prices**: per-model costs from pi's `models.json` and OpenCode's config apply to that provider's usage.
5. **Display**: price sources are visible (panel, `prices`, `cost --by model`, `--json`, OTLP); alias-priced figures carry
   `≈` even on an API key; unpriced tokens stay visible and are never priced at $0 unless the user says so.
6. **Re-pricing**: a price change re-prices the whole ledger in memory in milliseconds (no log is read again).

## Why (user value)
- On this machine 56.9M tokens today and 162.9M this month are unpriced (`agentglass cost --json`, 2026-10-05:
  `gpt-6.1-sol` 39.3M, `codex-auto-review` 13.8M, `gpt-6-sol` 3.8M today). The whole Codex column says `?`. Today the
  only fix is to hand-write `~/.agentglass/prices.json` with an undocumented shape, then restart and wait for a full
  re-index (18 s of CPU here; minutes on larger histories).
- A model id that is a renamed or internal variant (`codex-auto-review`) has no public price. "Price it like X" is the
  honest answer, but it is an estimate and must look like one.
- pi and OpenCode users already wrote per-model costs into their harness config. agentglass should use them for the
  messages the harness itself left at cost 0.

## Today (current code, measured)
- **Price table**: `src/features/usage/pricing.ts`. Layers "built-in < community list < user" (`pricing.ts:2,44-59`),
  prefix match, longest prefix first (`pricing.ts:57,88`). Built-in rows: Claude and Gemini only (`pricing.ts:16-29`);
  **no OpenAI row**, so every Codex model is unpriced unless the opt-in community list has it. The user table
  `~/.agentglass/prices.json` is read once at import (`pricing.ts:42`), shape
  `{"<model-prefix>": {"input","output","cacheRead","cacheWrite","cacheWrite1h"}, "kiroCreditUsd": n}`; no env override
  for its path; no writer. A user row also drops the built-in tier rows (`>200k`, `@2027`) of its key (`pricing.ts:55`).
- **Community list**: `src/features/usage/remote.ts`, opt-in via `config.json` `prices.source` (`remote.ts:27-35`),
  cached at `<cache>/prices-<source>.json`; a refresh "applies on next start" (`remote.ts:114`, `src/features/prices.ts:19`).
- **Cache invalidation by price**: `PRICES_SIG` = the whole user JSON + a hash of the community list
  (`pricing.ts:65-72`); a ledger cache with another signature is dropped and every log re-indexed
  (`src/features/usage/cache.ts:47`). Measured: full re-index 18.0 s wall / 16.8 s CPU, ledger 29 MB, 1639 sessions.
- **Booking**: `tokens()` prices one record with `price(model)` and books the cost (`addCost`) or the tokens as unpriced
  (`unpriced`) (`src/features/usage/record.ts:303-311`). `usageExact()` books a harness-reported cost (pi, OpenCode) and
  falls back to `tokens()` when it is ≤ 0 (`record.ts:296-302`). fx books $0 custom-model deltas through `unpriced()`
  directly (`src/harness/fx.ts:118`). Kiro books `credits × kiroCreditUsd` or credits (`src/harness/kiro.ts:151,178-179`).
- **Per-model day bucket** (honest-costs): `Day.mt` model → `[in, out, cacheRead, cacheWrite, costUsd]`, `Day.um`
  unpriced tokens per model (`record.ts:18-21,268-292`). It merges 5-minute and 1-hour cache writes (`w5 + w1`) and
  mixes harness-reported with table-priced cost, and `Day.hc` (cost per hour) and `Day.cp` (cost per provider) carry no
  model — **the ledger cannot re-price from what it stores today**.
- **Gemini keys depend on the table at booking time**: `priceKey()` (`src/harness/gemini.ts:336-346`) books
  `"?" + id` for variants the table must not prefix-match, the bare id when unpriced, and `<base>>200k` / `<base>@2027`
  tier keys only where the table has those rows.
- **Ledger cache**: `VERSION = 15` (`src/features/usage/codec.ts:12`); day codec `dayOut/dayIn` (`codec.ts:66-82`).
- **Display**: Stats summary "unpriced N tok" (`src/features/usage/stats.ts:194`), the `unpriced` line under the
  per-harness table (`stats.ts:226,248`), subtitle `prices: <source>` (`stats.ts:150`), help line "~/.agentglass/prices.json
  overrides" (`stats.ts:730`); `agentglass cost --by model` rows (`src/features/queries.ts:291-295`); session `--json`
  `costUsd`, `unpricedTokens` (`src/features/cli.ts:173-174`); OTLP `agentglass.usage.cost`, omitted when unknown
  (`src/features/otlp/encode.ts:57`). No price source is shown anywhere.
- **Stats keys** (`stats.ts:624-669`): `$` is free in Stats and globally. The input line (`S.mode = "input"`,
  `src/actions.ts:20` `ask()`, validation through `H.input`, `src/input.ts:49-66`) supports "invalid stays open".
  Palette actions are a static list `H.actions` read on every palette open (`src/features/palette/view.ts:108-109`).
- **Atomic config writer** (#39): `writeConfigAt()` (`src/util/config.ts:52-63`): re-reads, refuses a non-object file,
  writes through a symlink, tmp + rename.
- **Gateway configs on this machine** (keys only): pi `~/.pi/agent/models.json`
  `providers.<id>.models[] {id, cost{input, output, cacheRead, cacheWrite}}` ($/Mtok; provider `cliproxy`,
  `claude-sonnet-5-5` 3/15/0.3/3.75). OpenCode `~/.config/opencode/opencode.json` `provider.<id>.models.<id>.cost
  {input, output, cache_read?, cache_write?, context_over_200k?}` (schema: `@opencode-ai/sdk` `ProviderConfig`); no
  model here sets `cost`. cliproxyapi `config.yaml` has no price fields. Codex `config.toml` providers have none.
- **Provider keys match**: pi sessions here carry `"provider":"cliproxy"`, the `models.json` provider key; the pi
  adapter passes it as `prov` (`src/harness/pi.ts:152-158`).
- **`codex-auto-review`** is the model of Codex's guardian reviewer: its own rollout file with
  `"source":{"subagent":{"other":"guardian"}}` and `turn_context.model = "codex-auto-review"` (seen 2026-10-05).
- **Ledger shape** (isolated index of this machine's logs): 1751 session-days, 1743 `mt` entries, about 3000
  (hour, model) pairs with usage.

## Design

### 1. Price resolution
`src/features/usage/pricing.ts` gets one resolver used by booking, re-pricing, the CLI and the TUI:

```ts
export type PSrc = "user" | "alias" | "gateway" | "community" | "built-in";
export interface Resolved { p: Price; src: PSrc; key: string /* matched row key */; via: string /* alias target, gateway provider, community source */ }
export function resolve(model: string, prov: string): Resolved | null; // null = unpriced
```

Precedence, first hit wins:

| # | layer | match | scope |
|---|---|---|---|
| 1 | **user price** (`prices.json` entry with `input`) | prefix, longest first | all usage |
| 2 | **user alias** (`prices.json` entry with `alias`) | prefix, longest first | all usage; target resolved through layers 1, 3, 4, 5 (aliases do not chain) |
| 3 | **gateway config** (pi `models.json`, OpenCode config) | exact id after `normModel` | only bookings whose provider key is that provider |
| 4 | **community list** (opt-in) | prefix | all usage |
| 5 | **built-in** | prefix | all usage |

Why this order:
- The user's `prices.json` is the one place written for agentglass on purpose. It wins over everything; a user price
  beats a user alias of the same id (more specific statement).
- Gateway configs describe what the user's own route charges, which is closer to their bill than a public list, so they
  beat community and built-in. They are scoped to their provider: pi's `cliproxy` row for `claude-sonnet-5-5` says what
  that route costs, not what Claude Code's direct use of the same model costs.
- Community beats built-in because it is newer (unchanged from today).
- Harness-reported costs (pi `usage.cost`, OpenCode `cost`, fx `total_cost` > 0) are not table prices: they are booked
  as reported and never re-priced (Decision 1). Their source is `harness`.

Gemini rules move from the adapter into the resolver, so the booked key no longer depends on the table:
- A `gemini-*` id prefix-matches a row only when the rest is empty or starts with `-preview`, `-latest`, `-exp` or `-<digit>`
  (today's `?` rule, `gemini.ts:340`), in every layer.
- Tier tags are part of the booked key (`<id>@2027`, `<id>>200k`, see 3). The resolver strips them, finds the row for the
  id, then uses the tier row `<row.p>@2027` / `<row.p>>200k` of the same layer when it exists (today's order).

Normalisation (`normModel`) is unchanged. The memo is cleared whenever a layer changes.

`prices.json` path: `AGENTGLASS_PRICES` or `~/.agentglass/prices.json`. New entry shape (old entries stay valid):
```json
{ "gpt-6.1-sol": { "input": 1.25, "output": 10, "cacheRead": 0.125 },
  "codex-auto-review": { "alias": "gpt-6-sol" },
  "kiroCreditUsd": 0.04 }
```
An entry with both `input` and `alias` is a price (the alias is ignored, one warning). Invalid entries are skipped with
one warning each (toast in the TUI, stderr in the CLI), never an abort.

### 2. Gateway prices
New `src/features/usage/gwprices.ts` (pure parsing + an mtime-cached reader):
- pi: `<PI_CODING_AGENT_DIR or ~/.pi/agent>/models.json` → `providers.<prov>.models[]`, each `{id, cost:{input, output,
  cacheRead, cacheWrite}}` in $/Mtok. Provider key = `<prov>` (what the pi adapter passes as `prov`).
- OpenCode: `<XDG_CONFIG_HOME or ~/.config>/opencode/opencode.json`, then `opencode.jsonc` (comments `//` and `/* */`
  outside strings stripped by a small scanner; billing.ts skips `.jsonc` today and will reuse it), then `config.json`;
  first readable file wins → `provider.<prov>.models.<id>.cost {input, output, cache_read, cache_write}`.
  `context_over_200k` maps to a `>200k` tier row of that provider.
- A row needs `input` and `output` as finite numbers ≥ 0 (both 0 is allowed: the user configured a free route);
  missing cache fields = derived like the built-in rows (`-1`).
- Only these fields are read; `apiKey`, headers, `options` are never copied (same rule as honest-costs).
- Re-read at most every 60 s by mtime; a change re-prices (6).

Precedence vs. the harness's own cost: pi and OpenCode already compute `usage.cost` from these files at request time.
The gateway layer therefore matters for messages booked at cost 0 — written before the user added the `cost` block, or
by a harness version that did not compute it. That is the case this spec targets.

### 3. Ledger: priced-token rows and in-place re-pricing
`Day` gains one map:

```
tp: Map<string, number[]>   // key "<hour>\t<prov>\t<model>" → [in, out, cacheRead, write5m, write1h, usd]
```
- Every **table-priced** booking adds its tokens to the row of its local hour, provider key and booked model key, and
  its cost to `usd`. `usd = -1` marks an unpriced row (all tokens of a row share one price, so a row is either priced or
  not). Harness-reported costs and Kiro credits never enter `tp`.
- `tokens()` = `count()` + `modelTok()` + new `tableTok(a, d, model, prov, in, out, cr, w5, w1)`; fx's $0 custom-model
  path calls `tableTok()` instead of `unpriced()`, so fx custom models can be priced too.
- Gemini `priceKey()` becomes table-independent: `<id>` + `@2027` when the message is from 2027 on + `>200k` when its
  prompt is over 200k tokens. `mkey()` (the `mt`/`um` key) strips `?` (old keys) and the tier tags: Stats shows
  `gemini-3.1-pro-preview`, not `gemini-3.1-pro>200k`.
- Size: about 3000 rows × 6 numbers on this machine (~200 KB in a 29 MB ledger). The hot path keeps the last row
  reference per Acc (`hour, prov, model` unchanged → no map lookup).

**Re-pricing** (`reprice(a: Acc): number` in `record.ts`, returns the cost delta): for each day, for each `tp` row:
`r = resolve(model, prov)`, `nu = r ? cost(r.p, row) : -1`; when `nu !== usd`:
- remove the old state: priced → subtract `usd` from `a.cost`, `d.cost`, `d.cp[prov]`, `d.hc[hour]`, `d.mt[mkey][4]`;
  unpriced → subtract the row's tokens from `a.unk`, `d.unk`, `d.um[mkey]` (an entry reaching 0 is deleted);
- add the new state the same way; `usd = nu`.
Every aggregate stays consistent (totals, per provider, per hour for the projection, per model). Values with
`|x| < 1e-9` snap to 0. `repriceAll()` runs over the ledger, bumps `L.ver` (Stats/cost caches rebuild) and `L.idx`
(the cache saves). Measured budget: < 20 ms for this ledger (Testing).

Triggers: a write through the editor or CLI in this process; `prices.json`, pi `models.json` or OpenCode config mtime
changing (checked every 5 s by the TUI, on the slow tick); a community refresh finishing (applies at once instead of
"on next start"); the cache loading with another price signature (7).

### 4. Writing `prices.json`
New `src/features/usage/userprices.ts`:
- `PRICES_FILE = process.env.AGENTGLASS_PRICES || ~/.agentglass/prices.json`; pricing.ts reads the same constant.
- `setEntry(path, key, entry: Obj | null)`: generalised from `writeConfigAt` into `writeJsonAt(path, edit)` in
  `src/util/config.ts` (one implementation for both files): re-read the file right before writing; missing or blank →
  `{}`; unreadable or not a JSON object → throw, file left as is; apply the edit; pretty-print (2 spaces) + newline;
  write through a symlink; `tmp` + `rename`. Unknown keys (`kiroCreditUsd`, comments-as-keys, future fields) are kept.
- Keys are stored as `normModel(model)` (lower case, provider prefix and date suffix dropped); the CLI/TUI says so when
  that differs from what was typed.
- Validation (shared by CLI and TUI, pure `checkPrice()`/`checkAlias()`): numbers finite, ≥ 0, < 10000; `input` and
  `output` required; an alias target must resolve (layers 1, 3, 4, 5) to a price, must not be the model itself and
  must not be an alias (no chains); else a usage error naming the reason.
- After a write in this process: reload the user layer, `repriceAll()`.
- `scripts/check.sh` unsets `AGENTGLASS_PRICES` like the other path overrides (hermetic checks).

### 5. TUI
**Stats price panel** (`$` in Stats; new file `src/features/usage/pricepanel.ts`, rendered in the place of the top-tools
list like the drill-down):
```
 models · 7 days                                    $ close  ↵ price  a alias  x remove
 MODEL                    SOURCE        $IN   $OUT   TOKENS     COST
▌gpt-6.1-sol              unpriced        —      —    42.3M        ?
 codex-auto-review        ≈ gpt-6-sol  1.25  10.00   126.0M  ≈$171.30
 claude-opus-5-5          built-in     4.00  20.00     29.1B  ≈$9.6K
 claude-sonnet-5-5        gw cliproxy  3.00  15.00      23.7M   ≈$41.20
```
- Rows: models with usage in the Stats period (today / 7 days, `d`/`w` switch it), unpriced first (by tokens), then by
  cost. SOURCE: `unpriced`, `user`, `≈ <target>` (alias), `gw <provider>`, `litellm` / `models.dev`, `built-in`,
  `harness` (only harness-reported cost). A model with several sources (gateway for one provider, built-in for the rest)
  shows the source of its largest share and `+1`.
- At 80 columns the `$IN`/`$OUT` columns go first, then TOKENS; MODEL keeps ≥ 18 columns.
- Keys: `↑↓ jk` select, `↵`/`e` edit price, `a` alias, `x` remove the user entry (confirm `y/n`), `esc`/`$` close.
- **Edit price**: the input line `price gpt-6.1-sol ($/Mtok: in out [cacheRead [cacheWrite [cacheWrite1h]]]):`
  pre-filled with the current price (empty when unpriced). Errors keep the line open with the reason after the text
  (`out missing`, `"abc" is not a number`). `0 0` is accepted (explicitly free).
- **Alias**: input line `price gpt-6.1-sol like:` pre-filled with a suggestion: the priced (or most used) model of the
  parent session for a subagent log (Codex guardian → the reviewed session's model), else the priced model with the
  most tokens in the period's sessions of the same harness, else empty. Tab completes model ids seen and priced.
- Success toast: `gpt-6.1-sol: user price $1.25/$10 — history re-priced, 7 days +$412.10`. Write errors toast in red
  and change nothing.
- Discoverability: the Stats `unpriced` line ends with `· $ set prices` (dim); the Stats footer gains `$ prices`;
  the `?` help gains a "prices" block (keys, sources, precedence one-liner, file path).
- **Palette**: one action per unpriced model in the current Stats period: "Set price for <model>" (group "prices",
  key hint `$`), plus "Prices: edit model prices" (opens the panel). Dynamic entries need a new hook
  `H.dynActions: (() => Action[])[]`, read where `H.actions` is (`palette/view.ts:108-109`).

### 6. CLI
```
agentglass prices [--json] [--since today|<n>d|YYYY-MM-DD] [--unpriced]
agentglass prices set <model> --in <$> --out <$> [--cache-read <$>] [--cache-write <$>] [--cache-write-1h <$>] [--json]
agentglass prices alias <model> <target> [--json]
agentglass prices unset <model> [--json]
agentglass prices update                # = --update-prices (kept as is)
```
- `prices` (list): models with usage (default: all history in the ledger; `--since` narrows), runs the blocking
  `complete()` path like `cost`. Text table like the panel. `--unpriced` keeps only unpriced rows; exit code 0, or `4`
  with `--unpriced` when any row is listed (for scripts). JSON:
  ```json
  {"file":"…/prices.json","community":{"source":"litellm","fetched":"2026-10-04"}|null,
   "models":[{"model":"codex-auto-review","source":"alias","via":"gpt-6-sol","estimated":true,
     "price":{"in":1.25,"out":10,"cacheRead":0.125,"cacheWrite":1.5625,"cacheWrite1h":2.5}|null,
     "tokens":{"in":0,"out":0,"cacheRead":0,"cacheWrite":0},"unpricedTokens":0,"costUsd":171.3,"reportedCostUsd":0,
     "providers":[{"provider":"cliproxy","source":"gateway","price":{…}}]}]}
  ```
  `price` shows derived cache rates as numbers (never `-1`). `providers` lists only provider-scoped resolutions that
  differ from the row's own. Agent mode: `--json` is the default (cli-agent-mode rule) and the scope rule applies to
  the token and cost figures (models and prices are not project data).
- `set` / `alias` / `unset`: write (4), print one line `gpt-6.1-sol: unpriced → user $1.25 in / $10 out (stored as
  gpt-6.1-sol in ~/.agentglass/prices.json)`; JSON `{"model","stored","before":{source,via,price},"after":{…},"file"}`.
  They do not load the ledger (fast; a running TUI re-prices on its own when it sees the mtime change).
  Exit 0; usage errors 2 (`cliError("usage", …)` with a hint); file unreadable / not JSON 1 (`code: "prices_file"`,
  file left as is). `unset` of a model without a user entry: exit 0, `nothing to remove (source: built-in)`.
- `cost --by model` rows gain `priceSource` and `estimated` (JSON/CSV fields; text: a `src` column).
- `--json` sessions gain `costEstimatedUsd` (the alias-priced share of `costUsd`, 0 when none).

### 7. Ledger cache
- `VERSION` bumps once, to the next free number at implementation time (16 if nothing else lands first): `Day.tp`
  is new, older caches cannot be re-priced and re-index once.
- The file keeps a price signature, now only informative: on load with another signature the cache is **kept** and
  `repriceAll()` runs after loading (instead of today's re-index). Kiro credit rates are not in `tp`: the signature gets a
  separate `kiro` field (the rate); when it differs only Kiro sessions are dropped and re-indexed (small logs).
- Signature content: hash of user layer + gateway layer + community list (as today, extended).

### 8. Display of sources and estimates
- `≈` rule: a figure gets `≈` when its billing mode is not `api` (honest-costs, unchanged) **or** when any part of it
  was priced through an alias. User and gateway prices are exact: no `≈` from them.
- `ModeSum` gains `est: number` (alias-priced cost inside it), filled in `addDay()` from `tp` rows whose current
  resolution is an alias. `money()` gets the estimate flag.
- Stats line 1 subtitle: `prices: built-in + litellm 2026-10-04 · 2 user · 1 alias · 1 gw` (counts of models with usage
  in the period priced by each non-default layer; narrow drops it like today). Stats line 2: `· ≈$171 by alias` (dim)
  after the cost when `est > 0`.
- Session preview: `≈$12.40 plan · incl. ≈$3.10 alias (codex-auto-review)` when the session has alias-priced cost.
- OTLP chat spans: `agentglass.usage.cost.source` (`built-in|community|gateway|user|alias|harness`) and
  `agentglass.usage.cost.estimated` (bool) next to `agentglass.usage.cost`; an unpriced request keeps omitting the cost
  and gets `agentglass.usage.cost.source = "unpriced"` plus the unpriced token count already in its token attributes.
  The export prices at export time with the current table; turns already sent are not re-sent (`--resend` does).
- Unpriced stays visible everywhere it is today; nothing is ever booked at $0 without an explicit user, gateway or
  harness price of 0.

## Failure modes
- `prices.json` invalid JSON at startup: user layer empty, one warning; the editor and CLI refuse to write it
  ("fix it first"), naming the parse error.
- Two writers (CLI while the TUI runs): each re-reads before writing; the last rename wins for the same key; different
  keys both survive. The TUI picks the CLI's change up within 5 s.
- Alias target loses its price later (the user unsets it): the alias resolves to nothing, the model is unpriced again,
  and the panel shows `≈ gpt-6-sol (unpriced)` in red so the dead alias is visible.
- Gateway config unreadable or malformed: that layer is empty for it; no toast for missing files; one debug-log line.
- Floating drift after many re-prices: snapping at 1e-9 keeps totals clean; a re-index (VERSION bump) resets exactly.
- A price change while the ledger is still indexing: rows booked after the change use the new table directly; rows
  booked before are re-priced; both paths use `resolve()`, so the result is the same as a fresh index.

## Privacy
Only `cost` fields and model/provider ids are read from gateway configs; keys, base URLs and headers are never kept.
`prices.json` holds model ids and numbers only. Model ids are not personal data: `--redact` leaves them (as today).
Nothing leaves the machine.

## Interactions with other specs
- **honest-costs** (merged): owns `Day.mt`/`um`/`cp`/`hc` and billing modes; this spec keeps their meaning and keeps
  them consistent through `reprice()`. The billing tag `gw` (gateway billing mode) and the price source `gw <provider>`
  are different things: the panel says `gw cliproxy` only in the SOURCE column; help explains both.
- **tui-footprint** (spec in progress, may change the cache codec): both change `codec.ts`. Rule: whichever lands second
  takes the next free `VERSION` and keeps the other's fields. `Day.tp` must stay outside the lazily decoded heavy text
  `hv` (the re-price pass and `addDay()` read it on every price change). Coordinated with spec-footprint 2026-10-05.
- **cli-agent-mode**: `prices` follows its rules (JSON default in an agent, `cliError` JSON errors, scope).
- **command-palette**: gains `H.dynActions` (5); no change to ranking.
- **otlp-export**: two attributes added (8); `Booking` gains `src` and `est`.
- **filter-language**: a `price` dimension (`price is unpriced`) is a later addition, not part of this spec.

## Testing
- `pricing.check.ts`: precedence table (user > alias > gateway[prov] > community > built-in); gateway only for its
  provider; alias to an alias rejected; alias target unpriced → unpriced; gemini variant and tier rules equal today's
  results for every built-in Gemini row and `-preview`/`-image` ids; `AGENTGLASS_PRICES` path.
- `gwprices.check.ts`: pi and OpenCode fixture configs (fake `HOME`): cost rows, missing cache fields → `-1`, jsonc
  comments, `context_over_200k`, `apiKey` present in the fixture and absent from every returned structure.
- `userprices.check.ts`: write into a missing / blank / valid file; invalid JSON → throws, bytes unchanged; symlink
  stays a symlink; other keys (`kiroCreditUsd`) kept; `normModel` key; validation messages.
- `record.check.ts`: `tp` rows per hour/provider/model; `reprice()` unpriced → priced → other price → unpriced returns
  every aggregate (`a.cost`, `a.unk`, `d.cost`, `d.unk`, `d.um`, `d.cp`, `d.hc`, `d.mt`) to the values a fresh booking
  under each table gives (compare against a second Acc booked from scratch); harness-reported costs untouched;
  fx custom-model rows priceable. Timing check: re-price 2000 session-days × 3 rows in < 20 ms (`// check: timing`).
- `codec.check.ts`: `tp` round-trip; cache with another price signature loads and re-prices instead of re-indexing;
  Kiro rate change drops only Kiro sessions.
- `scripts/prices.test.sh`: `prices --json` on fixtures, `set`/`alias`/`unset` round-trip with `AGENTGLASS_PRICES`
  in a temp dir, exit codes 0/1/2/4, agent-mode JSON error line.
- Manual: Stats panel at 80 / 120 / 200 columns; edit, alias, remove; palette entries; a CLI `set` while the TUI runs
  updates the TUI within 5 s.

## Out of scope
- Built-in OpenAI price rows (gpt-6.x prices are not published in a form we can verify; the community list covers what
  is public).
- Built-in default aliases (`codex-auto-review` → anything): a guessed price shipped as a default is not honest.
- Editing `kiroCreditUsd` or the community-list source from the TUI (config stays hand-edited; documented in help).
- Per-session or per-project price overrides; currencies other than USD; tiered prices beyond `>200k`/`@2027`.

## Decisions
1. **PROPOSED** — A user price does **not** override a harness-reported cost (pi/OpenCode `usage.cost` > 0, fx
   `total_cost`): that cost is what the harness recorded, and those harnesses already use the same config file. The
   user price applies to table-priced tokens only. Alternative: let user prices win everywhere (needs harness-reported
   tokens in `tp` too; changes pi/OpenCode figures the harness itself shows).
2. Precedence user price > user alias > gateway config (its provider only) > community > built-in (1). Decided: explicit
   intent first, then the user's own route config, then public lists by freshness.
3. Gateway prices are scoped to their provider, not applied to the same model id elsewhere (1, 2).
4. Aliases do not chain and are always estimates (`≈`); user and gateway prices are exact (8).
5. Re-pricing works on per-(hour, provider, model) token rows (`Day.tp`) with delta application, not on a re-index (3).
   Per-hour rows keep the projection's hourly profile exact; about 200 KB on this machine.
6. `prices set/alias/unset` work inside an agent (the user asked for agent JSON output); they print before/after so a
   change is visible and reversible.
7. The TUI editor is a panel plus the existing input line, not a multi-field form: one validated line per action fits
   80 columns and reuses the input mode's error display.
8. No built-in aliases or OpenAI rows (Out of scope).

## Open questions (to verify during implementation)
1. OpenCode reads `opencode.jsonc` before or after `opencode.json` when both exist? Verify in OpenCode's config loader;
   until then `.json` first.
