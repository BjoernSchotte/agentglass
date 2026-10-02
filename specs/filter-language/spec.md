# Filter language and shared attribute model — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 2 (no dependencies; foundation for
triage, session-compare, repo-view, rules-config and otlp-export selection).

## Goal
One filter grammar, written the same way everywhere: the session list, the Stats tab, `--json`, `--watch` and every later
view (Triage, Compare, Repos). Examples: `repo is agentglass`, `tool is_one_of Bash Edit`, `cost > 2`, `model ~ opus`,
`status is error`, `harness is pi`, `not live is true`. Filters can be **pinned** so they follow the user across tabs
and across runs (remembered by default, visible on start, can be turned off). Two `is` filters on the same key merge into `is_one_of`. The spec also defines the
**attribute catalogue** (which attributes exist on which entity) and the **fact/aggregation model** that triage and
session-compare reuse.

## Why (user value)
- Today the list filter is a plain substring (`/`), the harness filter is a cycle key (`h`), and Stats cannot be
  filtered at all. Questions like "what did Bash cost me in repo X this week" or "which sessions over $2 used opus"
  need a filter that knows attributes.
- One syntax for TUI and CLI: what works in `/` works in `--json --filter '…'`, so a TUI view can be reproduced in a
  script and the other way round.
- Pinned filters make "only this repo" or "only pi" a context instead of something retyped on every tab.
- Triage and compare need a precise "selection" and "baseline". Those are filter expressions; without this spec each
  would invent its own.

## Today (current code, with path:line refs)
- State: `S.filter` (free text), `S.hfilter` (harness id or ""), `S.liveOnly`, `S.fulltext`/`S.useFull`/`S.fullq`
  (`src/state.ts:22-23`).
- Keys, Sessions tab only: `/` opens the input (`src/input.ts:157`), every keystroke re-filters (`src/input.ts:59`),
  esc in the input clears it (`src/input.ts:54`); `F` = full-text (`:158`); `h` cycles all → each harness (`:159`);
  `l` live only (`:160`); esc in the list clears everything (`:161`).
- Matching: lowercase substring over title, cwd, id, harness, name, branch, kind (`src/model/sessions.ts:83-87`); a
  parent stays visible when a subagent matches (`src/model/sessions.ts:110`, `:118`). Harness and live filters are
  applied in `buildView` (`src/model/sessions.ts:108-109`).
- Full-text: `rg -l -i -F --glob *.jsonl` over all harness roots, `grep -rilF` fallback, plus `HarnessAdapter.search`
  (OpenCode database) → set of session paths (`src/actions.ts:142-154`).
- Filter chips in the list box title: `<harness> · live · /<text> · F:<q>` (`src/ui/list.ts:42`). Help/footer:
  `src/ui/help.ts:16-17`, `src/ui/footer.ts:36`.
- CLI: `--live`, `--harness <id>` (validated), `--limit`, `--subagents`, `--from-start` (`src/features/cli.ts:27-33`,
  `:71-82`); `wanted()` applies harness/live to `--json` and `--watch` (`src/features/cli.ts:89-92`).
- Stats has no filter. It aggregates the ledger's per-session, per-local-day `Day` buckets (`src/features/usage/record.ts:10`)
  over today or 7 days (`src/features/usage/stats.ts:49-76`, `:79-80`); drill-down over one tool (`stats.ts:221-253`).
- The ledger keeps **no per-call records**: only per-day, per-tool counters `TS` (n, err, duration histogram, calls
  per hour, top-10 slow and top-10 error `Rec`s) and `Cnt` maps keyed `"<tool>\t<program|command|path>"`
  (`src/features/usage/calls.ts:6-12`, `record.ts:10`). Combinations such as "Bash errors with model X at 14:00"
  cannot be answered from it. The session model is the last one seen (`Acc.model`, `record.ts:13`; set e.g. at
  `src/harness/claude.ts:105`). `tool()` (`record.ts:50`) takes no model; every adapter has the issuing message's model
  at hand where it calls `tool()`: Claude `message.model` (`claude.ts:105,112`), Gemini `o.model` (`gemini.ts:302,312`),
  pi `responseModel || model` (`pi.ts:240-244`), OpenCode the message's `modelID` per part row (`opencode.ts:242,366-367`)
  or `o.model.id` (`opencode.ts:373`); Codex only per turn (`turn_context`, `codex.ts:103`); fx only per session
  (`fx.ts:63`); Kiro logs no model at all.
- Size on a real machine (2026-10-02): 1058 sessions, 124,080 tool calls, `ledger.json` 15.5 MB.
- Config: `~/.agentglass/config.json`, `section()` / `setConfig()` (`src/util/config.ts:13-24`).

## Design

### 1. Grammar
```
expr    = term { [ "and" | "," ] term }            -- adjacent terms are ANDed
term    = [ "not" | "-" ] ( clause | text )
clause  = key op value                              -- every op except *_one_of
        | key ("is_one_of" | "is_not_one_of") value { value }
op      = is | = | is_not | != | is_one_of | is_not_one_of | ~ | !~ | > | >= | < | <=
value   = word | "quoted string"                    -- \" and \\ escapes inside quotes
text    = word | "quoted string"                    -- a term that does not start a clause
```
1. A clause starts where a known key (or alias) is followed by an operator. Anything else is a **text** term, so
   today's `/foo` keeps working: `foo` = `text ~ foo`. Several bare words are ANDed (`foo bar` = both appear; today:
   the phrase). `"foo bar"` is the phrase.
2. `is_one_of` takes values until `and`, `,`, the end, or a token that starts a new clause (key + operator). A value
   that equals a key must be quoted.
3. Keywords (`and`, `not`, operators) are case-insensitive. `or` is rejected with a hint (5). OR exists only inside
   `is_one_of`; no parentheses (YAGNI, no query engine).
4. Negation: `not <clause>`, `-<clause>`, `is_not`, `!=`, `!~`, `is_not_one_of`. `-foo` = `text !~ foo`.
5. String comparison is case-insensitive. `is` = equal; `~` = contains. `is` on a path value (cwd, file) also accepts
   a `*` glob (`file is *.test.ts`). Enum values are validated (harness ids and labels: `harness is OpenCode` →
   `opencode`).
6. Values with units: money `2`, `$2`, `0.5`; tokens/sizes `40k`, `1.5M`, `100KB`; durations `500ms`, `30s`, `2m`,
   `1h`, `3d`; ratios `20%` or `0.2`; dates `2026-10-01`, `today`, `yesterday`, `-7d` (7 local days ago), weekdays
   `mo`…`su`. The special value `unknown` matches unpriced cost and untimed calls (`cost is unknown`,
   `duration is unknown`); numeric comparisons never match an unknown value.
7. **Canonical form**: every clause prints as `key op value…` with quoting where needed. Chips, `--filter`, persisted
   pins, triage include/exclude and error messages all use it. `parse(print(f))` = `f` (tested).

### 2. Attribute catalogue
Entities: **session** (one `Sess` + its ledger `Acc`), **day** (one session's `Day` bucket), **call** (one tool call,
new fact rows, 4), **event** (`--watch` only). A call inherits all attributes of its session and day; a day inherits
its session's. Multi-valued attributes (`m`) match when any value matches (`is_not`: when none does).

| key (aliases) | entity | type | values / source |
|---|---|---|---|
| `harness` (`h`) | session | enum | `Sess.h`; ids from `harnessIds()`, labels accepted |
| `repo` (`project`) | session | text | `projectOf(cwd)`: nearest dir with `.git` walking up from cwd (a worktree's `.git` file resolves to its main repo), else basename(cwd); cached per cwd; repo-view may refine the identity behind the same function |
| `cwd` | session | path | `Sess.cwd`, `~` expanded |
| `branch` | session | text | `Sess.branch` |
| `model` | session m / call | text | session: `Sess.model` ∪ models of its calls; call: the model of the assistant message that issued the call (4.1); `unknown` when the harness records none |
| `title`, `id` | session | text | `titleOf(s)`, `Sess.id` |
| `agent` | session | text | subagent type `Sess.kind` ("" for top-level) |
| `subagent`, `live`, `archived` | session | bool | `parent !== ""`; own or parent pid (`cli.ts:84-88`); `Sess.archived` |
| `state` | session | enum | `stuck` > `attention` > `busy` > `idle` (live) > `ended` (no process); from `watchdog.ts`, `working()` |
| `cost` | session | usd | `Sess.cost` (−1 → `unknown`) |
| `tokens`, `tokens.in`, `tokens.out`, `tokens.cache_read`, `tokens.cache_write` | session | tok | `Sess.inTok`… sum for `tokens` |
| `tools`, `errors`, `error_rate` | session | num, num, ratio | call count; failed calls (Σ `TS.err`); errors/tools |
| `lines`, `lines.added`, `lines.removed` | session | num | `linesAdd + linesDel`, … |
| `age` | session | dur | now − last activity (`Sess.last`) |
| `text` | session | text | bare words: today's haystack (`sessions.ts:86`) |
| `content` | session | text | full-text search of the transcript (rg), 9 |
| `day` | day / call | date | local day key (`record.ts:23`) |
| `weekday` | day / call | enum | `mo`…`su` |
| `day.cost`, `day.tokens`, `day.tools` | day | usd, tok, num | `Day.cost` (unknown if `cost 0 && unk > 0`), …, `Day.tools` |
| `tool` | call | text | tool name as recorded (MCP: full `mcp__server__tool`) |
| `server` | call | text | MCP server (`mcpServer()`, `calls.ts:161`), "" for built-ins |
| `program`, `command` | call m | text | `program()` / `norm()` of each shell command (`calls.ts:81-101`) |
| `file`, `ext` | call m | path, text | files the call changed; extension lowercased without dot, "" if none |
| `status` | call | enum | `ok`, `error`, `unknown` (no result seen yet, or the harness gives no call id) |
| `duration` | call | dur | result time − call time (`calls.ts:54`), else `unknown` |
| `out` | call | size | result bytes (approximate, as `TS.out`) |
| `hour` | call | num 0–23 | local hour of the call |
| `event` | event | enum | `user`, `assistant`, `thinking`, `tool`, `result`, `meta`, `live`, `exit` (`--watch` only) |

`turns` (from parsing-fixes' turn boundaries) and `billing` (from honest-costs) are registered by those specs when they
land; the registry is open (8).

### 3. Where a clause applies (lifting)
Each view has a row entity. A clause on another entity is **lifted**:
- Row = session (Sessions list, `--json`): session clauses apply directly; a day clause means "has a day bucket that
  matches"; a call clause means "has a call that matches" (`tool is Bash and status is error` = has a call that is
  both: all call clauses are checked against the **same** call, likewise day clauses against the same day).
- Row = call (Stats tool table and drill-down, triage call mode): session and day clauses apply to the call's session/day.
- Row = day (Stats totals, charts): session clauses select sessions; day clauses select buckets; with call clauses a
  bucket counts only if it contains a matching call, and its cost/tokens are labelled "in session-days with matching
  calls" (cost is not attributable to single calls).
- `--watch`: session clauses per session; `event`; call clauses only for `tool`, `server`, `program`, `command`,
  `file`, `ext`, matched on `tool` events from the call arguments (the same `toolArg`/`program()` the ledger uses).
  `status`, `duration`, `out` are rejected (known only after the result).
- Processes tab: only `harness`, `repo`, `cwd`, `live` apply (a process has nothing else); other pinned clauses are
  shown dimmed there.
- List tree: as today, a parent stays when a subagent matches, and only matching subagents are expanded.

### 4. Fact model: per-call rows in the ledger
Per-call filtering needs per-call data. The ledger gets a compact call table next to the `Day` buckets:
```ts
// one tool call; string columns are ids into ledger-wide dictionaries (tool, model, program, command, file)
interface Call { t: number; tool: number; model: number /* -1 unknown */; mq: 0 | 1 | 2 /* model exact per message | per turn | per session */; progs: number[]; cmds: number[]; files: number[]; ms: number; err: number /* -1 unknown, 0, 1 */; out: number; cid: string /* harness call id, "" none */ }
Acc.calls: Call[]   // in call order; Acc.lastCall = index of the newest row
Acc.t0: number      // first activity of the session (epoch ms), 0 unknown
```
1. `tool(a, d, name, model, mq)` (`record.ts:50`) appends a row (`t`, `tool`, `model`, `mq`); the caller passes the
   model of the **assistant message that issued the call** — never `a.model` ("latest seen"), which can belong to a
   later message or another attempt. Per harness:

   | harness | model source for the row | `mq` |
   |---|---|---|
   | claude | `message.model` of the assistant line holding the `tool_use` (`claude.ts:105,112`); with fallback iterations (parsing-fixes 2) the answering model, which is `message.model`; `<synthetic>` → unknown | message |
   | gemini | `o.model` of the `gemini` record carrying `toolCalls` (`gemini.ts:302,312`) | message |
   | pi | `responseModel || model` of the assistant message carrying the `toolCall` (`pi.ts:240-244`); nested calls inherit the row of their parent call id | message |
   | opencode | the part row's message `modelID` (`opencode.ts:242,366-367`); JSON export: the message's `model.id` (`opencode.ts:373`) | message |
   | codex | model of the latest `turn_context` (`codex.ts:103`) — Codex fixes the model per turn, so this is exact per its records | turn |
   | fx | session model from the meta line (`fx.ts:63`) | session |
   | kiro | none recorded → `-1` (`model is unknown`) | session |

   `a.model` keeps its current meaning (session's latest model, for the list and cost booking). The session-level
   `model` attribute is `Sess.model` ∪ the row models. `pend()` (`record.ts:60`) adds programs and
   commands and keeps the row index in `Pend`; `done()` (`calls.ts:54`) sets `ms`, `err`, `out`; `retool()`
   (`record.ts:68`) renames the row's tool. `file()` and `patchLines()` take `a` and attach the path to `a.lastCall`
   when its tool name matches (every adapter records files right after `tool()` on the same line:
   `claude.ts:122`, `codex.ts:118-128`, `fx.ts:92-93`, `gemini.ts:324`, `pi.ts:286`, `opencode.ts:355-357`,
   `kiro.ts:138`). The `Day`/`TS`/`Cnt` aggregates stay as they are: they are the fast path for unfiltered Stats.
2. **Persistence**: per-session files `~/.agentglass/cache/calls/<key>.json`, `key` = 16 hex chars from two
   32-bit FNV-1a hashes of the session path (pure TS: scriptc has no `node:crypto`), columnar
   (`{v, path, off, dict…, t:[…], tool:[…], …}`). Each file stores its own `path`: a file whose `path` differs
   (hash collision) or whose `off` differs counts as missing, so only that session re-indexes, written only for sessions whose rows changed, atomically like
   `cache.ts:88-94`, in the same save tick. Each file stores the ledger `off` it is consistent with; at load, a session
   whose calls file is missing or has another `off` gets its `Acc` dropped and is re-indexed (only that session).
   `cache.ts` `VERSION` bumps once to the next free number at implementation time (forces one re-index). Deleted sessions' files are removed on save.
   `cid` lets triage and the Stats drill-down jump to the call; `t0` gives triage the session start hour and compare
   its wall time and "previous session" (both persisted under the same bump).
3. **Retention**: rows older than `filter.callDays` days (config `"filter": {"callDays": 90}`, integer ≥ 1, default
   90; invalid → default with one startup toast) are pruned at save; day buckets are kept forever as today. Rows are
   loaded eagerly at start (no lazy per-session loading). Call clauses over older days see no rows: the chip shows
   `calls ≤ <callDays> d` when a filter with call clauses covers older data. Raising `callDays` does not bring pruned
   rows back until those sessions re-index.
4. Size estimate: ~40 bytes per row on disk → ~5 MB for the 124k calls above; in memory ~100 B per row. Measured on
   real data in the implementation plan (Testing, "Real life").

### 5. Evaluation and aggregation (shared by Stats, triage, compare, repo-view)
Module `src/features/query/` (names indicative): `parse.ts` (tokenizer, parser, printer, errors), `attrs.ts`
(registry), `eval.ts` (compile to predicates), `agg.ts` (group-by).
```ts
type Ent = "session" | "day" | "call" | "event";
interface Clause { key: string; op: string; vals: string[]; pinned: boolean }
interface Attr { key: string; aliases: string[]; ent: Ent; type: string; multi: boolean; enumVals?: () => string[];
  sess?: (s: Sess) => Val; day?: (s: Sess, d: Day, key: string) => Val; call?: (s: Sess, c: Call) => Val }
interface Compiled { sess: Pred[]; day: Pred[]; call: Pred[]; event: Pred[]; content: string[]; needsCalls: boolean }
// group-by: count rows (and weights) per value of each dimension, for the rows a compiled filter selects
interface Dist { dim: string; total: number; wTotal: number; vals: Map<string, { n: number; w: number; err: number; hist: number[] }> }
function aggregate(f: Compiled, entity: "session" | "call", days: string[], dims: string[], weight: "count" | "cost" | "duration"): Dist[]
```
1. **Two paths.** Filters with only session/day clauses run on `Day` buckets (works for all history, as fast as today's
   Stats). Any call clause, or a call-level dimension that buckets cannot answer (e.g. `model` × `status`), uses the
   call rows (within retention). `aggregate` picks the path; callers do not.
2. Results are cached per (canonical filter, days, dims, weight, `L.ver`), like `agg()` today (`stats.ts:49-52`).
   Session-list matching caches the set of matching session paths per (canonical filter, `L.ver`).
3. Triage = two `aggregate` calls (selection, baseline) + scoring; compare = two `aggregate` calls (A, B) + metric
   table. Both live in their own specs and add no second aggregation engine.

### 6. Filter state, scopes and pins
1. State replaces `S.filter`/`S.hfilter`/`S.liveOnly`: `S.pins: Clause[]` (global) and `S.local: Map<tabName, Clause[]>`
   (Sessions, Stats, and later Triage/Compare/Repos). Effective filter of a tab = pins ∘ local.
2. **Same-key merge inside one scope** (when a clause is added by typing, `h`, `l`, triage include/exclude, or
   pinning): `is a` + `is b` → `is_one_of a b`; `is` + `is_one_of` → union; `is_not` + `is_not` →
   `is_not_one_of` (same meaning, one chip); `is a` + `is_not a` → the newer replaces the older; same-direction numeric
   (`cost > 2` then `cost > 5`) → the newer replaces; opposite directions (`cost > 2`, `cost < 10`) and `~` clauses
   stay ANDed. Every merge or replacement says so in a toast (`merged: tool is_one_of Bash Edit`).
3. **Pins vs local**: a local equality clause on a key overrides a pinned equality clause on the same key for that
   tab (the pinned chip is shown struck through); range and `~` clauses always AND. Rationale: union would widen the
   pinned context, intersection of two `is` values is always empty.
4. **Persistence across runs** (default on): the canonical pinned expression is saved with
   `setConfig("filter", "pinned", expr)` on every change and restored at start. `config.json`
   `"filter": {"remember": false}` turns it off (nothing saved, a saved value is ignored). An unparsable saved value
   is dropped with a warning. So a restored pin never looks like missing sessions:
   - **On start** with restored pins: a toast for 6 s `pinned: repo is agentglass · harness is pi — P edits, P then
     enter on empty unpins`, and the chip bar (7.6) shows the pinned chips from the first frame.
   - **Hidden count**: while pins hide sessions, the Sessions box title ends with `· pins hide N` (N = sessions the
     pins alone exclude), and an empty list says `no sessions match — N hidden by pins (P edits)` instead of the
     plain empty state.
   - The Stats subtitle and every other tab that honors pins carry the same pinned chips.

### 7. TUI
1. `/` (Sessions, Stats): input prefilled with the tab's local expression in canonical form. Live re-filter while the
   prefix parses (as today); while it does not, the last valid filter stays applied and the input line shows the error
   after the text in red (no toast). Enter applies; Enter on an invalid expression keeps the input open; esc **cancels**
   (restores the previous local filter — today esc clears it, `input.ts:54`).
2. `tab` in the filter input completes: keys, then operators valid for that key's type, then values (enums; for text
   attributes the most frequent values in the data: tools, repos, models, programs, extensions). Repeated `tab` cycles.
3. `p` pins **all** of the tab's local clauses (merge rules apply; local is emptied; no per-chip selection). `P` (list mode) edits the pinned expression
   (empty = unpin all). `P` in transcript mode stays replay (`replay.ts:58`).
4. `h` and `l` stay as shortcuts: `h` cycles the local `harness is …` clause (all → each id); if harness is pinned it
   says "harness is pinned — P edits pins". `l` toggles local `live is true`.
5. esc in the list clears the tab's local clauses and the full-text clause; pins stay (visible in the chip bar).
6. **Chip bar**: the Sessions box title (`list.ts:42`) and the Stats usage box subtitle show the effective filter as
   chips: pinned ones in the accent color with a pin mark, local ones plain, overridden pins struck, clauses that do
   not apply in this tab dimmed. When too long: `… +N`. Text in chips passes `display()`/`screenOut()` so `--redact`
   scrubs repo, path and title values.
7. Stats: the filter narrows totals, the per-harness table, top tools, charts and the drill-down (3). The `d`/`w`
   period intersects with `day` clauses; an empty intersection says so ("no days of the last 7 match day is …").
8. Help and footer list `/ filter`, `p pin`, `P pins`; the help popup has a "filter" section with the grammar and the
   key list of the catalogue (generated from the registry, so it never drifts).

### 8. CLI
1. `--filter '<expr>'` for `--json` and `--watch`, repeatable (ANDed, same-scope merge rules). `--harness X` = sugar
   for `harness is X`, `--live` = `live is true`; both stay. Pins are not applied unless `--pinned` is given (scripts
   must be reproducible).
2. `--json` keeps its session fields (`cli.ts:58-62`); with call or day clauses it lists sessions that contain a match
   (3). Before filtering on ledger attributes the CLI runs `complete(s)` (blocking, incremental) only for sessions that
   pass the cheap session clauses first.
3. `--watch` evaluates session ledger attributes with an incremental `complete(s)` the first time a session emits and
   then every 10 s per session.
4. `--help` gets one line per option plus "filter keys: …" from the registry.

### 9. Full-text search
`content ~ "<q>"` (and `content !~`) is a session clause backed by the existing search (`actions.ts:142-154`): `F`
becomes sugar that adds it to the local scope. The search runs once per distinct query and is cached until the next
`scan()` adds or changes a session. When the other clauses already narrow the candidates to ≤ 200 sessions, rg gets those
file paths instead of the harness roots, and `HarnessAdapter.search` results are intersected. Several `content`
clauses AND; `content is_one_of` is rejected (use two searches). rg's 30 s timeout stays; a timeout says so and the
clause matches nothing (not everything).

### 10. Error messages
Parse errors carry a column and print the input with a caret (CLI: stderr, exit 2; TUI: inline). Examples:
- `unknown key "tol" — did you mean tool?` (edit distance ≤ 2 over keys and aliases)
- `"cost" needs a number (e.g. cost > 2, cost > $0.50), got "abc"`
- `">" does not apply to tool (text); use is, is_one_of, ~`
- `status is one of ok, error, unknown — got "failed"`
- `"or" is not supported; use is_one_of (tool is_one_of Bash Edit)`
- `unterminated quote at column 12`; `tool is …: needs a value`
- `--watch: duration is known only after the call's result; filter result events with event is result instead`
- Semantic warnings (not errors): `tool is Bash and tool is Edit` → merged note; `state is busy` in `--json` without
  a live process table → "state needs process info; run without --json or use live".

### 11. Privacy and failure modes
- Filtering is local and reads only what is already read. Pins are persisted to `config.json` unless
  `filter.remember` is false; they may contain repo names and paths; `setConfig` writes with the default umask today (`config.ts:20-23`), so the
  implementation should create `config.json` as 0600 when it does not exist yet.
- A corrupt or missing calls cache file costs one re-index of that session, never wrong numbers (4.2).
- Unknown values (`cost` −1, untimed calls) never satisfy comparisons; `is unknown` finds them.

## Interactions with other specs
- **triage**, **session-compare**: selection, baseline and A/B groups are filter expressions (compare registers the
  `session is <harness>:<id>` key); aggregation is
  `aggregate()` (5); include/exclude go through the merge rules (6.2).
- **repo-view**: owns the project identity behind `projectOf()` (same `repo` key); the Repos tab honors pins.
- **otlp-export**: `--filter` selects what is exported. **rules-config**: rule conditions reuse the key catalogue and
  clause syntax (`tool_error_rate where tool is Bash`).
- **honest-costs** registers `billing`; **parsing-fixes** registers `turns`. **cli-agent-mode** adds `--format` to the
  same outputs. **command-palette** may offer saved filters later.

## Testing
- Parser table check (`src/features/query/parse.check.ts`, built like `calls.check.ts`): ~80 inputs → canonical form or
  exact error message + column; `parse(print(x)) = x` for every valid case; units, quoting, `is_one_of` termination,
  bare-word compatibility with today's `/` behaviour.
- Merge rules: each pair in 6.2/6.3 → expected clause list and toast text.
- Pins: restored at start by default, not with `remember: false`; start toast and `pins hide N` count; unparsable
  saved value dropped.
- Per-message model: a fixture per harness with a model switch between two tool-calling messages (pi `model_change`,
  OpenCode `model-switched`, Claude fallback iteration, Gemini, Codex across two `turn_context`s) → each row carries
  its issuing message's model and `mq`; Kiro rows are `unknown`; `model is X` matches only the calls X issued.
- Retention: `filter.callDays` honored, invalid value → 90.
- Evaluation over a fixture ledger (two harnesses, subagent, priced and unpriced models, errored and untimed calls,
  two days): list lifting (same-call semantics), Stats totals per path (bucket vs calls give equal results when both
  apply), retention cut-off, `unknown`.
- Ledger: per-call rows match the `TS` counters (n, err, dn) for every harness fixture in `harness.check.ts`; calls
  cache round trip; `off` mismatch → that session re-indexes; `VERSION` bump drops old caches.
- CLI: `--filter` with `--json`/`--watch`, exit 2 + caret on errors, `--harness`/`--live` equivalence, `--pinned`.
- Real life: on the developer's ledger (≈124k calls) measure re-index time, calls cache size, memory, and the list
  re-filter time per keystroke (target < 16 ms with the matching-set cache warm).

## Out of scope
Parentheses and general OR, regex operator, saved named filters, sorting by attribute, filters in transcript/detail
views, PromQL/SQL, a filter on process attributes beyond the four in 3, copying the filter as a shell command (could
come with cli-agent-mode).

## Decisions (review 2026-10-02)
1. Per-call row retention? 90 days, configurable (`filter.callDays`), loaded eagerly (4.3).
2. `p` pins the selected chip or all local clauses? All local clauses (7.3).
3. Remembered pins default? On; persisted across restarts, `filter.remember: false` turns it off; restored pins are
   announced and counted on start (6.4).
4. `repo` before repo-view? The simple `.git` walk until repo-view refines `projectOf()` (2).
5. Model of a call? Exactly the model of the assistant message that issued it, per harness record granularity; no
   "latest seen" (4.1).
6. Calls-cache file names? Two 32-bit FNV-1a hashes of the path in pure TS (no crypto in scriptc); each file stores
   its path, a collision re-indexes only that session (4.2).
7. `Call.cid` and `Acc.t0` in the data model? Yes — call jumps (triage, Stats drill-down) and session start/wall time
   (triage, compare); persisted under this spec's one `VERSION` bump (4).

## Open questions (to verify during implementation)
None.
