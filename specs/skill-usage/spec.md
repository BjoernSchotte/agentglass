# Skill usage — spec

Status: **draft** (2026-10-09). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 3 (after 2026.10.10). Plan: [plan.md](plan.md).

## Goal
For every session, agentglass shows **which skills the agent loaded, when, and who pulled them** (the user or the
model), and **what each skill cost**: the tokens and dollars of loading its text (load cost) and of re-sending that
text on every later request while it stays in the context (carry cost). On top of that, it tells a developer or a
team **which skills to change** and why, with evidence: skills carried far beyond the work they were loaded for,
skills the user keeps invoking by hand that the model never picks, skills loaded twice in one context, skills whose
new version made sessions more expensive, skills installed but never used.

Skill names and sizes are shown and exported; **skill text never leaves the machine** (no `--content` in this spec,
see Privacy).

## Why (user value)
- A skill is a prompt the developer (or a team) wrote and shipped to every session. It is the one part of the context
  the developer fully controls, and nobody can see what it costs today. A 6 000-token SKILL.md loaded in turn 2 of a
  40-request session costs 240 000 tokens of cache reads, not 6 000. That is invisible in every harness.
- Teams copy skills between repos and hosts. Without numbers they cannot tell a useful skill from dead weight, or
  see that a skill edit doubled its cost.
- The data is already in the transcripts: the load (with the full text for Claude, Codex and pi), the per-request
  usage (Claude, Gemini, pi, OpenCode; per response for Codex), and compaction markers. Measured on this machine
  (Today, M1–M7).
- "Which skills do I actually use?" was answered by parsing-fixes (`✧ skills` in Stats, `skills[]` in `--json`). This
  spec answers the next questions: "when?", "what does it cost?", "what should I change?".

## Today (current code, with path:line refs)
Measured on `origin/main` at `bda9190`.

**Detection (parsing-fixes L6/L7, counts only):**
- Record: `Day.skills: Map<"<command|model>\t<name>", Cnt>` (`src/features/usage/record.ts:21-23`), booked by
  `skill(d, source, name)` (`record.ts:263`); `skillUsesOf()` sums it over days (`record.ts:268-275`). No timestamp, no
  turn, no size, no request position, no order. Cached as day key `k` (`src/features/usage/codec.ts:70,83`).
- Claude: slash command `<command-name>/x</command-name>` arms `Acc.pk` (`src/harness/claude.ts:229-235`); the next
  isMeta line `Base directory for this skill: …/<name>` with the same `promptId` and no `sourceToolUseID` books
  `command` (`claude.ts:238-244`). Model: `Skill` tool_use books `model\t<input.skill>` (`claude.ts:293`). The model's
  skill text line (isMeta, with `sourceToolUseID`) is skipped.
- Codex: user text starting `<skill>` books `command` (`src/harness/codex.ts:244-246`); Codex injects a skill only for a
  `$name` mention.
- pi: the expanded `<skill name="…" location="…">…</skill>` user message books `command` (`src/harness/pi.ts:89-92,
  217-219`); the transcript shows it as `/skill:name args` (`pi.ts:107`).
- OpenCode: `skill` tool books `model` (`src/harness/opencode.ts:353`); a `{"type":"skill"}` row books `command`
  (`opencode.ts:376-377`); a `skill` part becomes a meta event `skill: <name>` (`opencode.ts:311`).
- Gemini: `activate_skill` books `model` (`src/harness/gemini.ts:399`).
- Kiro, fx: no skill detection (no evidence in their logs).

**Display:** Stats top tools `✧ skills` group with one kid per name, `/` command uses, `⚙` model uses
(`src/features/usage/stats.ts:319-352`); no drill-down (`stats.ts:463`). Preview line `skills  a ×2, b`
(`stats.ts:743-745`). `--json` sessions `skills: [{name, source, n}]` (`src/features/cli.ts:69,108,121,196`). OTLP
`gen_ai.skill.name` on the turn root (slash command) and on `Skill`/`activate_skill` tool spans
(`src/features/otlp/build.ts:152-154,169,187`; `encode.ts:110,127`). The hub sends `skills: []`
(`src/features/hub/map.ts:262`): OTLP carries no per-session skill list (otlp-hub spec line 129).

**Usage booking:** every harness books request tokens through `tokens()` / `usageExact()` (`record.ts:318-330`) with
a booking tap (`record.ts:405-406`, used only by fleet's message rows `src/features/usage/msgrows.ts`). Per request:
Claude (`claude.ts:285-288`, one booking per `message.id`), Gemini (`gemini.ts:390`), pi (`pi.ts:159`; compaction and
branch summaries book too, `pi.ts:222`), OpenCode (`opencode.ts:334`). Codex books deltas of `total_token_usage` per
`token_count` event (`codex.ts:101-102,258`). Compaction is parsed as a transcript meta event only (Codex
`codex.ts:62`, pi `pi.ts:98`, OpenCode `opencode.ts:308,325`, Kiro `kiro.ts:76`); Claude's `compact_boundary` is not
read by `usage()` at all.

**Cache:** ledger `VERSION = 18` (`codec.ts:13`). Call rows are columnar per session (`src/features/usage/rows.ts`),
persisted in `cache/calls/` (`callcache.ts`); agent-wait folds them into day digests (`src/features/wait/digest.ts`).

**Measured on this machine:** see "Measurements" (M1–M7).

## Measurements
Read-only, 90 days, this machine (2026-10-09), scripts under `~/.cache/agentglass-agents/spec-skills/measure/`;
aggregates only, user-defined skill names never printed. "main" = top-level Claude logs, "sub" = subagent logs.

| # | figure | Claude main | Claude sub |
|---|---|---|---|
| M1 | logs / with ≥ 1 skill load | 2 408 / 44 | 2 071 / 21 |
| M2 | loads (user / model), distinct skills | 78 (6 / 72), 25 | 22 (0 / 22), 5 |
| M3 | loaded text, chars p50 / p90 / max (≈ tokens at 4 chars) | 9 151 / 17 803 / 260 813 (2.3k / 4.5k / 65k) | 20 166 / 96 589 / 101 153 (5.0k / 24k / 25k) |
| M3 | context growth at the load request ÷ (chars/4), p50 | 1.66 | 1.58 |
| M4 | requests in context after a load, p50 / p90 / max | 96 / 524 / 839 | 172 / 260 / 632 |
| M4 | Σ carry ÷ Σ load (tokens) | **144×** (41.3M vs 0.29M) | **118×** (19.1M vs 0.16M) |
| M4 | skills' share of the session's cache-read tokens, p50 / p90 / max | 0.4 % / 2.4 % / 4.3 % | 2.1 % / 3.7 % / 9.7 % |
| M4 | sessions with one skill loaded ≥ 2×, max loads of one skill | 5, 3 (2 answered by a stub) | 0, 1 |
| M5 | logs with a compaction | 34 (1.4 %) | 16 (0.8 %) |
| M5 | loads later compacted away; `invoked_skills` re-injections | 42 of 78; 60 (content capped at 20 000 chars) | 2 of 22; 1 |
| M6 | open skills at once, p50 / p90 / max | 1 / 3 / 6 | 1 / 1 / 2 |
| M7 | `skill_listing` attachment chars p50 / p90 (skills listed p50) | 5 496 / 5 884 (12) | 29 806 / 29 974 (102) |
| M2 | `Skill` calls without a text line | 2 (both re-invocation stubs) | 0 |

Findings that drove the design:
- **Carry dominates**: a skill costs ~100–150× its load in later requests. Showing load cost alone (what a "skill
  size" view would do) misses >99 % of the money. → carry + tail carry are first-class (§3, §8 A1).
- **The listing is the largest skill cost** on this machine: ~1.4k tokens in every main request and ~7.5k tokens in
  every subagent request (102 skills listed, most never loaded: M2 shows 5 distinct skills loaded in subagents). → the
  listing is booked like a skill and feeds A6 (Decision 6).
- **Compaction matters for skills, not for sessions**: only 1.4 % of logs compact, but those are the long ones, and
  54 % of loads were compacted away and re-injected (M5). → `compact` trigger and A4.
- **Growth ≠ size**: the load request grows by ~1.6× the skill text (prompt, tool output ride along). → size from text,
  growth only as an upper bound (Decision 2).
- **Model-chosen loads dominate** (72 of 78): the description decides cost. → A2/A7 about descriptions.

Cross-check with today's build (`agentglass --json --subagents`, isolated cache, all history, list prices):

| harness | sessions | with skills | uses (command / model) | distinct | list-price $ of all sessions / of sessions with skills |
|---|---|---|---|---|---|
| Claude | 3 518 | 64 | 6 / 110 | 38 | $44 191 / $14 412 (33 %) |
| Gemini | 94 | 55 | 0 / 100 | 7 | $2 / $2 |
| OpenCode | 81 | 2 | 0 / 4 | 2 | $12 / $0 |
| pi | 102 | 2 | 3 / 0 | 1 | $11 / $0 |
| Codex | 393 | 0 | — | — | — |
| Kiro | 3 | 0 | — | — | — |

Sessions that load skills are the long, expensive ones (2 % of Claude sessions, 33 % of Claude list-price cost): the
skill's carry share is small per request (M4) but sits in the most expensive sessions.

Other harnesses (90 days, same scripts; M8):

| figure | Codex | Gemini | OpenCode | pi |
|---|---|---|---|---|
| sessions / with loads | 314 / 90 (all by SKILL.md reads) | 93 / 55 | 81 / 2 | 102 / 2 (+1 model `read` of a SKILL.md) |
| loads; distinct per session p50 / max | 946 reads; 1 / 21 | 100; 2 / 3 open at once | 4 | 3 |
| text chars p50 / p90 / max | 12 720 / 35 748 / 40 152 (253 cut by the output limit) | 3 424 / 17 651 | 358 – 2 164 | 275 – 371 |
| requests in context after a load p50 / p90 | 74 / 180 | 7 / 26 | — | 3 – 7 |
| Σ carry ÷ Σ load (tokens) | **92×** (356M vs 3.9M) | — | — | — |
| skills' share of the session's cached input p50 / p90 / max | 4.4 % / 15.3 % / 34.9 % | 17.7 % / 34.5 % / 70 % | — | — |
| sessions with a reload | 41 | 0 | 0 | 0 |
| logs with a compaction | 107 of 314 (34 %) | 0 | — | — |
| per-request usage | `token_count.last_token_usage` per response | per message | per message | per message |
| listing in context | developer message, ~22 000 chars, ~69 skills | — | — | — |

- **Codex loads skills by reading SKILL.md with shell commands**, never through `$name` here: agentglass counts 0
  today. 29 % of rollouts load skills, carry is 92× load and up to 35 % of a session's cached input. → SKILL.md-read
  detection (§2), Decision 20.
- **Gemini sessions are short and skill-heavy**: skills are 18 % of cached input at the median (`using-superpowers`
  loaded in 54 of 93 sessions). Per-session carry is small in $ but the share is the largest. → the panel shows share as
  well as $ (6.6 `share` column).
- **Codex compacts often** (34 % of rollouts), so `compact` unloads and A4 matter there most.

## Design

### 1. Terms
- **Load**: one injection of a skill's text into a context. Trigger `user` (slash command, `$name`, `/skill:name`,
  OpenCode skill row), `model` (the model's skill tool), `compact` (the harness re-injects a skill after a compaction:
  Claude's `invoked_skills` attachment, M5). One skill can be loaded several times in one session; each load is its own
  record. A **stub** load (Claude answers a re-invocation of a skill already in context with a short "(Re-invocation of
  …" text instead of the skill) is a load of that stub's size, flagged `stub`.
- **Listing**: the skill names and descriptions the harness puts into every context so the model can choose (Claude's
  `skill_listing` attachment, M7). It is carried like a skill under the reserved name `(listing)`, trigger `listing`;
  names are parsed from it (never the descriptions) for "listed, never loaded" (§8 A6).
- **Size** `S`: the load's text in tokens. `S_est = ceil(utf8Bytes / 3.6)` from the visible text (Open question 8
  calibrates the divisor), bounded by the measured growth of the context at the load request (3.2). Unknown text → `S` unknown
  (`-1`): the load is counted and timed, never priced.
- **In context**: from the load until an **unload**: a compaction (`compact`), `/clear` (`clear`), an implicit drop
  (`drop`, 3.4), or the session's end (still `0` = open; a session that ended carries nothing further by definition).
- **Request**: one model call with logged usage. `ctx(r) = in + cacheRead + write5m + write1h` of request `r` (output
  excluded: it is not context sent).
- **Load cost**: the skill's tokens in the first request after the load (normally a cache write).
- **Carry cost**: the skill's tokens in every later request while it is in context (normally cache reads; cache
  writes after a cache expiry).
- **Tail carry**: the part of the carry spent in **later turns** than the one the skill was loaded in. A turn = one
  human prompt (`classifyUser`, parsing-fixes). Tail carry is the money a skill costs after the work it was pulled in
  for; it is the main lever for advice (§8).
- **Tier**: `exact` when the harness logs usage per request (or per response) **and** the full text is visible
  (Claude, Codex, pi, OpenCode, Gemini — M8); `≈` when the text was cut (Codex output limit, Claude's 20 000-char
  re-injection cap), assembled from several partial reads, or inferred (a load whose text is not in the log, sized from
  the same skill's other loads with the same hash or name); `?` when no size is known: counted, not priced. "exact"
  means the attributed tokens are measured request tokens; only the split of a request's tokens between the skill and
  the rest is bounded, not observed (Decision 3).

### 2. Detection per harness

| harness | user trigger | model trigger | text visible | size source | usage | unload markers | tier |
|---|---|---|---|---|---|---|---|
| Claude | `<command-name>/x` + isMeta `Base directory for this skill:` line, same `promptId`, no `sourceToolUseID` | `Skill` tool_use + isMeta line(s) with `sourceToolUseID` = that tool_use id (text may span several isMeta lines: summed); a stub line `(Re-invocation of …` = stub load; after a compaction `{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{name, content}]}}` = one `compact` load per entry (content capped at 20 000 chars, M5: tier ≈ when exactly 20 000) | yes, the isMeta line's text / the attachment's `content` | text | per request (`requestId`, else `message.id`) | `{"type":"system","subtype":"compact_boundary"}`; `/clear` = new log (session end) | exact |
| Codex | user message text starting `<skill>` (a `$name` mention; 0 seen in 90 days) | **a read of `…/<name>/SKILL.md`** by a shell call (`cat`, `sed -n`, `nl`, `head`, `rg` on that path; M8: 946 reads in 90 of 314 rollouts) — today not detected at all | yes, the call output (cut by Codex's output limit: tier ≈ when the truncation marker is present) | text | per response `token_count` with `last_token_usage` (M8) | `compacted` item, `context_compacted` event (34 % of rollouts, M8) | exact, ≈ when cut |
| pi | `<skill name=… location=…>` user message (`/skill:name`) | a `read` tool call of `…/<name>/SKILL.md` (seen once) | yes (block / read result) | text | per message | `compaction` entry | exact |
| OpenCode | `{"type":"skill"}` row / `skill` part | `skill` tool call (input `{id}` 2.x, `{name}` 1.x) | yes, the tool part's output (M8: 358–2 164 chars) | text | per message | `compaction` part / message | exact |
| Gemini | — | `activate_skill` call | yes, the functionResponse output (M8: p50 3 424 chars) | text | per message | none seen (0 of 93 sessions); implicit drop | exact |
| Kiro, fx | — | — | — | — | — | Kiro `Compaction` | none |

**SKILL.md reads (all harnesses).** A model that loads a skill by reading its file is a model load: a read-type call
(Claude `Read`, pi `read`, Gemini `read_file`, OpenCode `read`, or a shell call whose program is `cat`, `sed`, `nl`,
`head`, `tail`, `less`, `bat`, `rg`, `grep` with a path argument) of a path whose basename is `SKILL.md` and whose
parent's parent is a `skills` directory (any depth: `~/.codex/skills/x/SKILL.md`, `<plugin>/skills/x/SKILL.md`). Name =
the parent directory (plugin skills: `<plugin>:<dir>` when the path holds `plugins/…/<plugin>/…/skills/`). Size = the
call's output. Several reads of the same path in the same turn while the first is pending or open (`sed -n 1,200p`,
then `200,400p`) grow one load (tier ≈: parts may overlap); a read in a later turn is a new load (a reload). A read by
a harness that also has a skill tool (Claude `Skill`) right after that tool's load of the same name is part of it, not
a second load. This fixes Codex skill counts (today 0 of 314 rollouts; M8: 90) and makes them a `model` use in
`Day.skills` too.

**Listing per harness.** Claude: `skill_listing` attachment (M7). Codex: the `<skills_instructions>` / `## Skills` part
of the developer message (M8: ~22 000 chars, ~69 skills, repeated with each turn context it is sent in) — the open
`(listing)` load is replaced (`why = relist`) when a new developer message carries it again. Gemini, OpenCode, pi:
none found; the inventory (§8) is their A6 source.

**Name**: as today (`plugin:name` kept whole). **Hash**: the first 16 hex chars of two FNV-1a hashes
(`callcache.ts pathKey` scheme) over the skill text with the trigger-specific wrapper removed (Claude: the text after
the `Base directory` line, so the directory path does not change the hash; Codex/pi: inside the block, without the
`location` attribute). Same text → same hash on every host. The hash is the version identity (§8 A5); it reveals nothing
about the text.

**Base directory**: Claude logs it; pi logs `location`. Kept per load as the directory **key** only (redacted like a
cwd under `--redact`): it lets the advice match `Read` calls of files under it (references loaded on demand, §8 A1) and
tells user (`~/.claude/skills`), project (`<repo>/.claude/skills`) and plugin skills apart (`scope`: `user` |
`project` | `plugin` | `builtin` | `?`).

### 3. Attribution algorithm
State per session log (`Acc`): `rq` (requests booked so far), `tq` (human prompts so far), `sk: SkLoad[]` (every load,
in load order), and the open set `A` = loads with `end = 0`. All work happens inside the existing booking path, so
cold index, tail reads and fleet message rows see the same numbers.

**3.1 Load.** The adapter calls `skillLoad(a, name, trig, ms, text)` when it sees the load line: a new `SkLoad`
`{name, trig, t: ms, tu: a.tq, rq0: a.rq, bytes, hash, dir, scope, S: S_est, pend: true}` joins `A`. Text is hashed
and measured, then dropped (never stored).

**3.2 The load request** (the first request booked with `pend = true`). Let `g = ctx(r) − ctx(r−1)` (the context growth;
`ctx(r−1)` of the previous request of this log, `0` if none). Then `S = min(S_est, max(g, 0))` when `g > 0`, else
`S_est` (a cache-expiry or model switch made `g` meaningless; the tier stays as for the harness). Several loads pending
at the same request share `g` in load order (each takes `min(S_est_i, g_left)`).
The skill's tokens in this request are taken from the request's buckets in the order **write5m → write1h → in →
cacheRead** (a new text is written to the cache). This is the load cost. `pend = false`.

**3.3 Every later request** `r` while the load is in `A`: in load order (oldest first, it sits earlier in the prefix),
each load takes `S` tokens from the request's **remaining** buckets in the order **cacheRead → write5m → write1h →
in** (a prefix is read from the cache; after a cache expiry it is written again, and that write is carry, not load).
New loads of this request (3.2) are served **after** all older ones. Each bucket is decremented by what was taken, so
the skills' shares of one request **never exceed** that request's tokens, per bucket and in total, even when ten
skills are open. A load that gets less than `S` because the request is smaller (a subagent-sized request, a truncated
log) records the shortfall (`short += S − taken`) and stays open.

**3.4 Unload.**
- Compaction marker (table §2) → every load in `A` ends with `why = compact`, `end = ms`.
- Claude `/clear` starts a new log (Open question 5 verifies); the old log's loads simply stop (no more requests).
- **Implicit drop** (any harness, the safety net for unknown markers, Gemini `/compress`, a harness that rewrites
  history): at a request with `ctx(r) < 0.5 × ctx(r−1)` **and** `ctx(r) < Σ S` over the **non-pending** loads in `A`,
  those loads end with `why = drop` before 3.3 runs (a load pending at this request was injected after the drop and is
  served by 3.2). Worked example: plan Task 2 Step 1. `skills --check` prints how often it fired; Task 16 reports
  it for this machine (expected: rare; a high count means a missed marker, fix the adapter).
- A **re-load** of a name already in `A` is a new record; the older copy stays in `A` (the harness sends the text
  twice; both carry). This is real cost and is what §8 A3 reports. Claude mostly answers a re-invocation with a stub
  (M4: 2 stubs, 5 sessions with a reload): the stub load carries only its own few tokens, A3 still counts it.
- A load after a compaction of a name that ended `compact` is flagged `rel = true` (lost to compaction, loaded again).

**3.5 Price.** Attributed tokens are kept per bucket and per (day, model, provider), exactly like the ledger's
table-priced rows (`Day.tp`): `$` is computed at read time by the same resolver (`resolve(model, prov)`), so a price
change re-prices skills like everything else. For a harness-reported cost (`usageExact` with `usd > 0`: pi, OpenCode)
the skill's share is `usd × w_skill / w_request`, `w` = the bucket tokens weighted by the resolver's rates for that
model (token counts when the model has no table price); stored as `$` (never re-priced, like the ledger).

**3.6 Subagents.** A subagent's log has its own `Acc`, its own context and its own loads: its skills carry there and
only there. A parent session's figures include its subagents' skill rows the way `accsOf(s)` includes their tokens
today (`--subagents` semantics unchanged).

**3.7 Turns.** `tq` increments where the adapter calls `turn()` (human prompts only). When `tq` increments, every load
with `tu = tq_old` and `te = 0` gets `te = ms` (the end of its loading turn). Requests booked while `a.tq > load.tu`
count as **tail** (`tail += taken`, per bucket).

**3.8 Exactness invariants** (checked in tests and by `agentglass skills --check`):
- per request and bucket: `Σ skills taken ≤ bucket`;
- per session: `Σ skill tokens ≤ session tokens − output`; per period: `Σ skill $ ≤ period $`;
- a load is in at most one state: open (`end = 0`), or ended with one `why`.

### 4. Data model (ledger)
`record.ts`:
```ts
// one load of a skill (in load order); bytes/S -1 = text not visible; end 0 = still in context
export interface SkLoad {
  name: string; trig: string /* user | model | compact | listing */; t: number; tu: number; te: number; rq0: number;
  bytes: number; S: number; hash: string; dir: string; scope: string;
  end: number; why: string /* "" | compact | clear | drop | relist */; rel: boolean; stub: boolean; pend: boolean; short: number;
  nq: number;      // requests carried (after the load request)
  lt: number[];    // load tokens  [in, cacheRead, write5m, write1h]
  ct: number[];    // carry tokens [in, cacheRead, write5m, write1h]
  tt: number[];    // of which tail [in, cacheRead, write5m, write1h]
  hu: number;      // harness-priced $ share (load + carry), never re-priced
  mdl: string; prov: string; // model + provider of the load request (the per-day rows below hold the split by model)
}
```
- `Acc` gains `sk: SkLoad[]`, `rq: number`, `tq: number`, `lastCtx: number`, `lst: string[]` (skill names of the newest
  listing, names only). Cap: 400 loads per log; beyond, the
  oldest **ended** loads fold into one `"<n> earlier loads"` summary record per name (counts and tokens kept, times
  dropped). Measured max is far below (M4).
- `Day` gains `sa: Map<string, number[]>` keyed `"<name>\t<provider>\t<model>"` → `[loadsUser, loadsModel,
  loadsInjected (compact + listing), L_in, L_cr, L_w5, L_w1, C_in, C_cr, C_w5, C_w1, T_in, T_cr, T_w5, T_w1, hu]`: per-day per-skill
  tokens, booked on the day/hour of the request (cost at read time as in 3.5). This is what Stats, `skills`, Repos,
  fleet and `cost`-style periods sum; `Acc.sk` is the per-session timeline.
- `Day.skills` (parsing-fixes) stays as is: counts by source, the Stats `✧ skills` group keeps reading it.
- Codec: `Acc.sk` as columns under key `sk` (names front-coded per Acc), `Day.sa` under day key `sa` (light part: Stats
  reads it without decoding the heavy maps). **`VERSION` bumps once** (19, or the next free number at implementation
  time); old caches re-index (the loads need the text, which only a re-read sees).
- Footprint: a load record ≈ 220 B in memory, `Day.sa` row ≈ 180 B. With M2's counts (≈ 3 loads per session with
  skills) the whole machine's ledger grows by well under 1 MB (tui-footprint budget: ledger resident ≤ budget there;
  Task 2 measures RSS before/after with the footprint script).
- Hot path: `tokens()`/`usageExact()` add one branch `if (a.sk.length)` and, when loads are open, one loop over `A`
  (open loads, ≤ a handful). Lines that are no skill line are rejected by `indexOf` pre-filters as today.

### 5. Shared session marks and event kinds (with debug-episodes)
A harness-neutral, view-neutral layer the TUI views, `--json`, the MCP server and a later web UI read the same way.
debug-episodes (merged, `specs/debug-episodes/spec.md` §6.1, Decision 14) registers on it; this section is the
agreed shape, including the two fields debug-episodes asked for (`anchor`, `seq`) and `gen`.
`src/model/marks.ts`:
```ts
// kind = "<family>:<name>" (skill:load, debug:episode, debug:probe …); t1 = t0 point, -1 open, else end; t0 0 = unknown (Kiro: order by seq)
export interface Mark { kind: string; t0: number; t1: number; seq: number; turn: number; ev: number /* index in s.evs, -1 */;
  anchor: string /* "call=<cid>" | "ts=<iso>" */; label: string; sub: string; tok: number; usd: number; est: boolean; ref: string }
export interface MarkKind { kind: string /* family */; glyph: string; color: () => string; of: (s: Sess) => Mark[]; gen: (s: Sess) => number /* 0 = none */ }
export function registerMarks(k: MarkKind): void;                       // a family registered twice replaces the first
export function marksOf(s: Sess, kinds: string[] | null): Mark[];       // lazy; memo per (s.id, s.size, Σ gen); "skill" matches "skill:*"
export function kindsOf(s: Sess): Map<string, number>;                  // event kinds present (built-in + marks) → count, for chips
export function evKind(e: Ev): string;                                  // built-in kind of a transcript event (below)
```
Skills register family `skill` (glyph `✧`, cyan, `gen` = 0): one `skill:load` span per load (`t0` = load, `t1` = end,
`-1` while open), `sub` = trigger, `tok`/`usd` = load + carry, `label` = name, `anchor` = the load line's call id when
it came from a tool call (`Skill`, `activate_skill`, `skill`, a SKILL.md read), else `ts=<iso>`; `ref = "sk<i>"`.

**Event kinds** (one taxonomy for every timeline and event view, debug-episodes §6.1): built-in kinds from `Ev.kind`
and the tool name — `ev:user`, `ev:assistant`, `ev:thinking`, `ev:tool`, `ev:result`, `ev:error` (a failed result),
`ev:meta`, `mcp:<server>` (an MCP tool call or result) — plus every registered mark kind (`skill:load`,
`debug:probe` …). Owned here:
- **Filter attribute**: the existing `event` key (entity `event`, `src/features/query/attrs.ts:106`; `kind` is taken
  by agent-wait's call kinds) gets a dynamic enum: its old values stay (`user` = `ev:user` …), plus every kind above
  and every family name (a family matches all its kinds): `event is skill`, `event is_not ev:thinking`,
  `event is_one_of debug, ev:error`. It selects which events and marks a timeline view shows; on the session list it
  means "has an event/mark of that kind" (lifted like call clauses). `--watch --filter "event is skill"` streams only
  skill events (6.13).
- **Kind chips**: key **`K`** in the transcript (also during replay), the call graph and related events (free in all
  three modes on `bda9190`): a one-line chip bar of the kinds present (`kindsOf`), family first, with counts;
  `←`/`→` move, `␣` toggle one kind, `f` toggle a whole family, presets `1` all, `2` marks only (skills + debug), `3`
  errors only, `4` hide thinking; `↵` applies (the chip state becomes an `event` clause shown in the view's filter line,
  editable with `/`), `esc` cancels. Help section `event kinds` (ctx transcript, call graph, related).
- **Gap markers**: hidden events collapse into one dim line per run, `┄ 12 hidden · tool 9 · thinking 3 ┄`; `↵` on it
  shows them once (the filter stays).
- **Deep links**: `canonicalUrl` (`src/features/palette/ref.ts:233`) gains an optional `kinds=<k1,k2>` fragment
  parameter, and `applyTarget` restores the chip state from it, so a shared link opens the same filtered view.
- **Navigation**: in the transcript `]` / `[` go to the next / previous **shown** mark (any family). debug-episodes
  binds `]`/`[` inside its own view (another mode, no clash).

### 6. Surfaces
Every surface reads either `Acc.sk` (per session) or `Day.sa` (per period) through one read module,
`src/features/skills/model.ts` (§6.0). Keys were checked against each mode's bindings (`src/input.ts`, the view's help
section) on `bda9190`.

**6.0 Read model** (`src/features/skills/model.ts`, pure over `Acc[]`): `skillLoads(as): LoadRow[]` (a session's
timeline, subagents folded in with their session id), `skillTable(as, days, opts): SkillRow[]` (per name: loads by
trigger, sessions, load/carry/tail tokens and $, size p50, hashes, tier), `priced(row)` through the resolver,
`SKILL_FIELDS` (the stable JSON field list). Every surface below calls these; none re-derives.

**6.1 Transcript.** A meta line at each load, in place (Claude: replaces the skipped isMeta line; others: next to the
existing `skill: x` meta / tool line): `✧ brainstorming · user · 4.1k tok · in context 31 req · $0.42 (tail $0.35)`;
at an unload: `✧ brainstorming out (compacted)`. Keys in transcript mode: **`]` / `[`** next / previous mark (any
kind, §5; free in transcript mode: used only in detail mode and the call graph). `↵` on a skill line opens the detail
view with the load record (trigger, turn, time, bytes, S, tier, hash, dir key, load/carry/tail per bucket, model).
Help section `skills` (ctx `transcript`).

**6.2 Call graph `c`.** Flame chart: a thin `✧` tick on the turn row at the load time, a dim band from load to
unload on a dedicated lane under the turns lane (one lane per concurrently open skill, at most 3, then `+n`). Call tree:
a `✧ name` row under the turn that loaded it (`↵` = the detail of 6.1). No new keys.

**6.3 Replay `P`.** The skill meta lines of 6.1 replay like any event; the status line shows the open skills
`✧2 · carry 9.1k tok/req` while replaying. No new keys.

**6.4 Related events `r`.** Skill loads of other sessions in the same project and window appear as rows of kind
`skill` (filtered out by default like reads; `k` cycles kinds: default → all includes them). Flag: none (a skill load
is not a conflict).

**6.5 Agent-wait (Wait tab overlap / timeline).** The timeline view gets the `✧` ticks on each session's lane; the
overlap view is unchanged (a skill load is not wait time). No digest change (skills live in the ledger, not the call
rows).

**6.6 Stats.**
- Activity-by-hour chart: a second row of small markers under the bars: loads per hour (`✧` when ≥ 1, brighter when ≥
  5). Reads the load times in `Acc.sk` of the sessions the chart already sums (period + filter); `(listing)` loads
  are not marked.
- **Skills panel** — key **`S`** in Stats (free there; `C` compare, `t` triage, `B` budget, `$` prices, `p`/`P` pins):
  a table for the current period and filter:

  ```
  skill              loads  /  ⚙  sess   size   load   carry   tail  share    $     $/sess  tier
  brainstorming         14  9  5     8   4.1k   57k    1.2M    0.9M   2.1 %  $1.84   $0.23
  user-skill-a           6  6  0     6   9.8k   59k    2.4M    2.2M   4.4 %  $3.10   $0.52  ≈
  (listing)             31  ·  ·    31   1.4k   43k    6.1M    5.0M   3.0 %  $2.95   $0.10
  ```
  `share` = the skill's tokens ÷ the cached + input tokens of the sessions it was loaded in. Sort `s` (cost, loads,
  tail, size, share, $/sess), `↵` = sessions that loaded it (the session list filtered with `skill is
  <name>`), `a` = advice for the selected skill (§8), `esc` back. 80 columns: drop `load`, `/`, `⚙` first, then `tail`.
  The existing `✧ skills` group of the top-tools list stays (counts); its `↵` now opens this panel at that skill
  (replaces "no per-skill drill-down", `stats.ts:463`).
- Help section `stats` gets `S skills: loads, carry, $ per skill`.

**6.7 Session preview and row.** Preview line (replaces `stats.ts:743-745`):
`skills   brainstorming ×2 $0.31 · user-skill-a $0.52 · +1   (carry 92 %)`. Session row: no new column (80-column
budget); the cost cell keeps its meaning (the skills are part of it).

**6.8 Repos tab.** A `skills` column (top skill by $ in the period + count, e.g. `brainstorming +3`) in the wide layout
only (≥ 120 columns); the repo detail (`↵`) gets the skills table of 6.6 for that repo. Sort keys unchanged.

**6.9 Triage.** New dimension `skill` (session entity: the session's skills; call entity: the skills open at the
call's time — "which skill was in context when these calls failed"). Added to `SESS_DIMS` and `CALL_DIMS`
(`src/features/triage/run.ts:79-80`).

**6.10 Compare (A vs B).** A `skills` section (after models): per name loads, $ and $/session in A and B, with the
existing significance marks. Answers "did the skill change make sessions cheaper?" when A/B are periods around a hash
change (§8 A5 links to a prepared compare).

**6.11 Filters.** New entity `skill` (one row per session × skill name, lifted like `call` rows: all `skill.*` clauses
of a group hit the **same** skill row, filter-language §3):
| key | type | value |
|---|---|---|
| `skill` | text | the name (redacted: the fake, `EXACT` prefix rule) |
| `skill.trigger` | enum `user`, `model`, `compact`, `listing` | multi: any of the session's loads of that skill |
| `skill.loads` | num | loads of that skill in the session |
| `skill.cost` | usd | load + carry $ of that skill in the session (unknown when `?` tier) |
| `skill.carry` | usd | carry $ |
| `skill.tail` | usd | tail carry $ |
| `skill.size` | tok | `S` of the newest load |
| `skill.scope` | enum `user`, `project`, `plugin`, `builtin`, `?` | |
`skill is brainstorming and skill.cost > $1` = sessions where brainstorming alone cost more than $1. `--watch`: only
`skill` and `skill.trigger`, matched on load events (6.13). Day/Stats rows: a skill clause selects the skill rows of
`Day.sa` (the skills panel shows only matching names; totals are labelled "in sessions with matching skills").

**6.12 Alert rules** (rules-config metrics, session scope, `sessMetric`, `src/features/rules/metrics.ts:30`):
- `skill_reloads`: max loads of one skill name while an earlier load of it is still in context. Placeholder
  `{skill}`. Built-in rule `skill-reload` (degraded ≥ 2, **off by default** like `contention`): "{skill} loaded
  {value}× in one context".
- `skill_carry_usd`: max carry $ of one skill in the session (`{skill}`), for user rules, e.g.
  `{"id":"fat-skill","metric":"skill_carry_usd","op":">","deg":0.5}`.
- `skill_context_share`: Σ open skills' `S` / `ctx` of the newest request (0–1).
Where-clauses accept the `skill.*` keys (6.11).

**6.13 `--json` / `--watch`.**
- `--json` sessions: `skills` keeps its shape and gains fields per entry (additive, the existing contract
  `{name, source, n}` stays): `{name, source, n, loads, tokens: {load, carry, tail}, costUsd, carryUsd, tailUsd, size,
  tier, hash, scope}` (one entry per (name, source) as today; tokens/$ split by the loads of that source). New field
  `skillLoads` behind `--fields skillLoads` (not in the default field set, footprint): `[{name, trigger, at, turn,
  bytes, size, end, why, reloadedAfterCompact, requests, tokens: {…}, costUsd, tier, hash, scope}]`.
- `--watch`: a `skill` event per load `{type:"skill", name, trigger, size, tier, …}` and `skill_end` per unload, in
  the stream order of the transcript events.

**6.14 OTLP export.** Per load a **span event** `gen_ai.skill.load` on the turn root span (`invoke_agent`) with
attributes `gen_ai.skill.name`, `agentglass.skill.trigger`, `agentglass.skill.size_tokens`, `agentglass.skill.hash`,
`agentglass.skill.scope`, `agentglass.skill.tier`; an unload adds `gen_ai.skill.unload` (`agentglass.skill.reason`).
Session-level span attributes on the session root: `agentglass.skill.cost_usd` (Σ), `agentglass.skill.carry_tokens`.
Existing `gen_ai.skill.name` on tool spans and the turn root stays (otlp-export §table, line 182/189). The hub maps the
events back into `skills[]` (replaces `skills: []`, `hub/map.ts:262`), so hub-fed fleet rows get skills too.

**6.15 Fleet.** Exact merge: skills are attributed on the host that owns the log, inside the booking path, so a message
the fleet merge drops (owned elsewhere, fleet spec 13) never carried a skill share on the dropping host — the sums are
exact by construction. Reports gain `DayRow.sa` (the `Day.sa` rows, names redacted per the host's privacy mode, hash
kept) and `SessRow.s.skills` (6.13). The fleet view's Stats/Skills panel sums across hosts; the skills panel gets a
`host` column when more than one host is shown. Portfolio drift (§8 A10) reads `hash` per host.

**6.16 MCP server.** New tool `skills`: input `{ref?, period?: "today"|"7d"|"30d"|"all", repo?, name?, advise?: bool}`;
output `{rows: SkillRow[], loads?: LoadRow[] (when ref given), advice?: Advice[], scope}`. "Which skills cost the most
in this repo this week?" and "what did my skills cost in this session?". Registered in `SPECS` (`src/mcp/tools.ts:76`)
with the field list `SKILL_FIELDS`.

**6.17 CLI.** `agentglass skills [--json] [--period today|7d|30d|all] [--repo r] [--harness h] [--session ref]
[--filter …] [--check]` and `agentglass skills advise [--json] [--period …]`. Text output = the 6.6 table (80
columns), then the top 3 advice lines. `--session ref` prints the session's timeline (one line per load). `--check`
verifies the 3.8 invariants over the ledger and exits 3 on a violation (CI-style self check, also used by tests).
Registered with `addCmd` (`src/features/cli.ts:77`) and in the help list (`src/features/clihelp.ts:103`).

**6.18 herdr sidebar.** No skill token (Decision 10).

### 7. CLI and TUI wording
- Units: `tok` with k/M (existing `kfmt`), `$` via the existing money formatting (billing-mode tags apply).
- `≈` precedes any figure of tier `≈`; `?` for an unknown size: `size ?`, `$ ?`.
- Triggers: `/` user, `⚙` model, `↻` compact (same markers as the Stats group).

### 8. Value: metrics and advice
Every advice item is **evidence + suggestion**, never an edit. Each names the numbers, the sessions they come from
(`↵` / `--json` ids), and a suggestion. `agentglass skills advise` and the Stats skills panel `a` show them; the MCP
`skills` tool returns them. Thresholds are config keys `skills.advise.*` (defaults below; invalid → default + one
startup toast). Ranked by value × feasibility; **MVP = A1–A6**.

| # | advice | metric (computed from) | default trigger | suggestion | MVP |
|---|---|---|---|---|---|
| A1 | **Carried too long** | tail share = tail $ / (load + carry) $; tail $/session; `S` (Acc.sk) | `S ≥ 2k` and tail share ≥ 60 % over ≥ 3 sessions | split SKILL.md: keep the decision part, move details to `references/` read on demand; for `user` skills, start a new session after the task | yes |
| A2 | **Never auto-loaded** (description too narrow) | user loads ≥ 3 in ≥ 3 sessions, model loads = 0, harness supports model loads (all but Kiro/fx; Codex through SKILL.md reads) | as stated, 30 days | add the user's phrasing to the description; or mark it manual-only (Claude `disable-model-invocation: true`) to silence this | yes |
| A3 | **Loaded twice in one context** | `skill_reloads` ≥ 2 (§6.12) and the duplicate's carry $ (M8: 41 Codex rollouts re-read a SKILL.md already in context) | ≥ 2 sessions in the period | the model re-invoked a skill already in context: say so in the skill ("already loaded? continue"), or narrow the description | yes |
| A4 | **Lost to compaction** | loads with `rel = true`; their load $ | ≥ 3 in the period | the skill is needed after compaction: make it shorter or move the long-running part to a sub-agent | yes |
| A5 | **Version changed** | per hash: first seen, sessions, `S`, $/session, tail share, tool-call error rate in the loading turn (call rows in `[t, te)`) | any hash change with ≥ 3 sessions on each side | shows the delta table; `↵` opens compare (6.10) for the two periods | yes |
| A6 | **Listed, never loaded** | names in the `(listing)` loads (Claude) or the inventory (Codex, fallback) vs loads in 30 days; the listing's carry $ × (that skill's share of the listing, ≈ by name count) | never loaded in 30 days | uninstall or disable the plugin/skill: its description rides along on every request; in subagents the listing is 5× larger (M7) | yes (Claude, Codex) |
| A7 | **Loaded, then nothing** (description too broad) | model loads whose loading turn had 0 tool calls after the load, or ended within 1 request | share ≥ 50 % of ≥ 5 model loads | narrow the description | phase B |
| A8 | **Overlap** | co-load Jaccard over loading turns between two skills | ≥ 0.6 with ≥ 5 co-loads | merge or reference one from the other | phase B |
| A9 | **Outcome** (correlation, labelled so) | in the loading turn: test-kind calls and whether the last one passed, a `vcs` commit, error rate of calls, vs the same repo's turns without the skill | ≥ 10 turns each side | informational: "turns with X: tests green 72 % vs 61 %" | phase B |
| A10 | **Portfolio drift** (fleet) | per name: hashes per host/repo | > 1 hash for one name across hosts within 7 days | align versions | phase B |

**Inventory (A6 fallback: Gemini, OpenCode, pi, and Claude/Codex logs without a listing).** Read-only scan, at most once per hour, size-capped reads of frontmatter only (first 4 KB):
Claude `~/.claude/skills/*/SKILL.md`, `<project>/.claude/skills/*/SKILL.md` for the repos seen in the period, plugin
skills of **enabled** plugins (`~/.claude/settings.json` `enabledPlugins` → `~/.claude/plugins/…/skills/*/SKILL.md`,
verify the path layout in Task 0); Codex `~/.codex/skills/*/SKILL.md`; Gemini, OpenCode and pi skill directories as their harness docs name them (Task 0 records the paths; a harness without a known path has no A6). Kept: name, scope, description byte length, `disable-model-
invocation` flag. Never the description text. Listing cost ≈ `Σ ceil(descBytes / 3.6)` per request; shown with `≈`.

### 9. Footprint
- No new file reads on the hot path except the skill lines themselves (already read).
- `Acc.sk` and `Day.sa` live in the ledger (light part). The marks layer is lazy (built when a view asks, memoized by
  log size). The inventory scan runs only for `advise` (CLI, panel `a`, MCP `advise: true`).
- Budgets of tui-footprint/macos-footprint hold (Task 2 and Task 16 measure).

### Failure modes
- **No usage for a request** (a crash mid-stream, a harness that logs usage late): carry is booked when the usage line
  arrives; a load with no request after it has load cost 0 and `pend = true` (shown as "not sent yet").
- **Skill text truncated** in a log (Claude caps very large isMeta lines? Open question 7): `S_est` from the truncated
  text would under-count; the growth `g` bounds it from above only. Tier `≈` when the line ends with a truncation
  marker.
- **Cache expiry between requests** (>5 min idle): carry is charged at write rates for that request (3.3 order) — this
  is correct cost, and A1 shows it.
- **Model switch mid-session**: the new model's first request rewrites the cache; carry follows the request's buckets.
- **Implicit drop false positive** (a request with a much smaller context that is not a compaction, e.g. a side query
  logged in the same file): the 3.4 rule needs both conditions; a wrongly ended load under-counts (never over-counts).
- **Copied logs** (Claude resume into another project dir): loads in copied lines are skipped like copied bookings
  (`owned()`), so a load is attributed once.
- **Old cache**: `VERSION` bump → full re-index on first start (one-time, progress shown as today).

### Privacy
- Skill **text** is read to measure and hash it, then dropped: never stored, cached, logged, exported, sent to OTLP,
  fleet, the hub or MCP. This spec adds no `--content` path for skill text (Decision 8).
- Exported: name, trigger, times, sizes (bytes, tokens), hash (16 hex, one-way), scope, directory **key** (local only:
  `--json` prints `scope`, never the path).
- `--redact`: a skill name that is not in the built-in allowlist (skills bundled with a harness: Claude Code's bundled
  skills, Codex's `skill-creator`/`skill-installer`, and the agentglass own docs' examples) is replaced by a stable fake
  of the same length through the same scrubber as subagent names (`src/features/redact.ts:139-163`, `fakeAgent`); a
  `plugin:name` is faked as a whole. Hashes stay (they reveal nothing and keep A5/A10 working on a redacted fleet).
  Filters on `skill is <fake>` work through the `EXACT` prefix rule.
- Fleet reports and OTLP use the same redaction when the host runs with `--redact` / `privacy` on (fleet Hello.redact).

## Interactions with other specs
- **parsing-fixes**: owns detection counts (`Day.skills`) and `classifyUser` (turns); this spec adds timing, size,
  attribution, and keeps `Day.skills` as the count source.
- **honest-costs / model-prices**: `$` at read time through the resolver; billing-mode tags apply to skill $ as to any $.
- **filter-language**: new entity `skill` and keys (6.11); registry is open (its Decision 8).
- **triage, session-compare, repo-view, related-events, agent-wait**: one dimension / section / column / row kind /
  tick each (6.4–6.10); no change to their data.
- **rules-config**: three metrics, one built-in rule off by default (6.12).
- **otlp-export / otlp-hub**: span events + attributes (6.14); the hub fills `skills[]`.
- **fleet**: `DayRow.sa`, `SessRow.s.skills` (6.15); exact merge unchanged.
- **mcp-server**: one tool (6.16).
- **debug-episodes** (merged spec, #101): shares `src/model/marks.ts` and the event-kind layer (§5); it registers
  `debug:*` kinds. Whichever implementation lands first creates the module to §5's shape; the second only registers.
- **tui-footprint**: light-part ledger data only; lazy marks.

## Testing
- Synthetic fixtures per harness (no real skill text: lorem text of known byte length) under
  `src/features/skills/fixtures/`: Claude slash + model + compact_boundary + reload; Codex `<skill>` + per-response
  token_count + compacted; pi `/skill:` + compaction; OpenCode skill tool + compaction part; Gemini `activate_skill` +
  implicit drop.
- Pure checks: attribution (3.2–3.4) on hand-made request sequences, including 3 skills open at once, a request
  smaller than `Σ S`, a cache expiry, a reload while open, a compaction, an implicit drop; invariants 3.8.
- Goldens: `agentglass skills` text (80 and 120 columns), `skills --json`, `skills advise`, `--json` session `skills`
  entries, the transcript lines, the Stats panel render, OTLP span events — all from the fixtures.
- Codec round-trip of `Acc.sk` + `Day.sa`; VERSION bump re-index.
- Redaction: no fixture skill name or text substring in any `--redact` output; hash unchanged.
- Real-life (read-only, isolated cache): `agentglass skills --check` passes over this machine's logs; totals vs M-figures.

## Out of scope
- Editing skills, auto-applying advice, generating SKILL.md splits.
- Exporting skill text (`--content`) — a later spec if asked.
- Skill detection for Kiro and fx (no evidence in their logs).
- Per-skill outcome causality (A9 is correlation, phase B).
- Instructions files (CLAUDE.md, AGENTS.md) and MCP tool listings as "carried context" — same algorithm would apply;
  a follow-up spec can register them as more `Mark` kinds.

## Decisions
Format: question · options considered · decision · why · cost if wrong.

1. **Where attribution runs** · (a) online in the booking path while indexing, (b) a separate pass per view that re-reads
   logs, (c) only at export time · (a) · one read of each line as today; tail reads, cold index and fleet message rows
   see identical numbers; views stay cheap (they read `Acc.sk`/`Day.sa`) · a logic fix needs another `VERSION` bump and a
   re-index (minutes on a big machine, shown with the existing progress gauge).
2. **Skill size** · (a) visible text bytes / 3.6, bounded by the context growth at the load request, (b) the context
   growth alone, (c) a tokenizer · (a) · the growth includes the prompt, tool results and the previous output: M3
   measured growth = 1.66× (p50) the text's chars/4, so (b) would over-charge skills by ~65 %; scriptc has no tokenizer
   and none is portable across vendors · ±10–20 % on skill token counts (text-to-token ratio varies with markdown/code);
   one constant (`SKILL_BPT`) to retune; Open question 8 calibrates it.
3. **"Exact" vs "≈"** · (a) no `≈` where usage is per request and the text is visible, (b) `≈` on every skill figure
   because the split is inferred · (a) · the user asked for exact-where-possible; the tokens attributed are measured
   request tokens, only the split is bounded (by size and growth), and the invariants make over-attribution impossible;
   `≈` stays meaningful for the coarse cases (per-turn usage, inferred size) · a reader may read "exact" as tokenizer-
   exact; the detail view and README say "measured requests, size from text".
4. **Bucket order** · carried text: cache read → write → input; new text: write → input → read · as stated · matches how
   prompt caching works (a prefix is read; new text is written), so load ≈ the cache write and carry ≈ cache reads, and
   a cache expiry (a re-write) shows up as carry at write price · after an expiry mid-prefix some carry is priced at write
   instead of read (it was written), which is the real cost.
5. **Claude's re-injection after compaction** (`invoked_skills`) · (a) a load with trigger `compact`, (b) ignore, (c)
   continue the old load · (a) · M5: 42 of 78 loads were compacted and 60 re-injections followed; they are real tokens
   (up to 20 000 chars each); counting them as user/model uses would distort A2 · none known; Stats `/ ⚙ ↻` shows them
   apart.
6. **The skill listing** · (a) carry it as `(listing)`, parse names for A6, (b) ignore it, (c) a filesystem inventory only
   · (a) for Claude (the listing is in every log, M7: p50 5.5k chars / 12 skills in main sessions, 29.8k chars / 102
   skills in subagents), (c) as fallback for Codex · the listing is the biggest per-request skill cost on this machine
   and the only evidence of "listed but never used" that matches what the model saw · listing format changes → names
   not parsed (size still booked); A6 falls back to the inventory.
7. **Subagents** · (a) own contexts, own loads, (b) inherit the parent's open skills · (a) · a subagent's context starts
   fresh (M: 21 subagent logs loaded skills themselves); inheriting would double-count · none.
8. **Skill text export** · (a) never, (b) `--content` like transcripts · (a) in this spec · skills are team IP; names,
   sizes and hashes answer every question in this spec · a team that wants text-level diffs gets them from git, not from
   agentglass.
9. **Data placement** · (a) `Acc.sk` + `Day.sa` in the ledger light part, (b) heavy part, (c) a sidecar per session like
   call rows · (a) · small (KBs per machine), needed by Stats and `--json` without decoding heavy maps · if loads grow far
   beyond M4 (hundreds per session) the 400-load cap folds them.
10. **herdr sidebar token** · (a) none, (b) `✧n` open skills, (c) skill $ · (a) · the sidebar shows state at a glance;
    skill cost is not actionable while an agent runs; the plugin's fixed-width tokens are budgeted (mux-herdr) · none; a
    token can be added later from `--json` without core changes.
11. **Session row** · (a) no new column, (b) a `✧` badge · (a) · 80-column budget; the preview carries it · a user who
    wants it scans the preview instead.
12. **Stats key** · `S` (skills panel) · free in Stats, mnemonic, `s` sorts inside the panel like Repos · compare's `S`
    (subagents) lives in another mode, no clash.
13. **Transcript navigation** · (a) `]`/`[` over all marks, (b) a skill-only key · (a) · one pair of keys serves skills
    and debug episodes (shared marks), same keys as the call graph's next/previous span · none.
14. **Filter semantics** · (a) a `skill` entity with same-row lifting, (b) session-level keys only · (a) · `skill is X
    and skill.cost > $1` must mean "X cost more than $1", which (b) cannot express · one more entity in eval.ts.
15. **`skill-reload` built-in** · (a) off by default, (b) on · (a) · M4: reloads are rare and mostly stubs (cheap); a
    noisy default would teach users to ignore alerts · users who care enable it with one line.
16. **MVP scope** · A1–A6 now; A7–A10 phase B · A1–A6 are computed from data this spec stores anyway and give a concrete
    edit (split, describe, mark manual, uninstall); A7–A9 need call-row joins per turn and are correlations; A10 needs
    fleet · a team waits longer for overlap/outcome views.
17. **Version identity** · (a) hash of the text (16 hex, FNV pair), (b) file mtime, (c) none · (a) · identical on every
    host, reveals nothing, works on redacted fleets · collisions are negligible at this scale (64 bits).
18. **Shared marks and event kinds** · (a) `src/model/marks.ts` + one event-kind taxonomy shared with debug-episodes
    (which adopted it, its Decision 14, and asked for `anchor`, `seq`, `gen`), (b) per-feature overlays and filters ·
    (a) · one rendering path and one filter ("only skills", "only errors", "only debugging") for every timeline view,
    `--watch` and a later web UI · the layer is a dependency of both specs; whichever implementation lands first creates
    it to this shape (both plans say so).
19. **Skills loaded by reading SKILL.md** · (a) a model load, (b) an ordinary file read · (a) · M8: it is how Codex loads
    every skill on this machine (946 reads, 90 rollouts) and agentglass shows 0 Codex skills today; the text is in the
    context exactly like a tool-loaded skill · a SKILL.md read for editing it (a developer working on a skill) counts as a
    load; acceptable — it is in the context and costs the same; the panel's trigger column shows `⚙`.
20. **Roadmap placement** · Round 3 (the brief named Round 2, which is shipped) · current round · none.

## Open questions (to verify during implementation)
1. Claude re-injection shape beyond `invoked_skills` (does `/resume` re-inject too?): `grep -c '"type":"invoked_skills"'`
   over logs with and without `compact_boundary`; a re-injection without a boundary → trigger `compact` still, note it.
2. SKILL.md-read detection: confirm the program list against 30 days of Codex rollouts (`grep -o` the command lines that
   name a `SKILL.md`, count programs); add a program only when it reads (never `ls`, `find`, `wc`). Report misses in
   the PR.
3. Codex listing entry format inside `<skills_instructions>` (Task 0 Step 4, names only): the parser takes the name of
   each entry; if the format is not one entry per line, book the size only.
4. Gemini `/compress`: which marker does the session JSON carry? None → implicit drop only.
5. Claude `/clear`: verify that it starts a new log (new session id) in the current Claude Code version; if it continues
   the same log, treat the `/clear` command line as an unload (`why = clear`).
6. Codex: is the `<skills_instructions>` developer message re-sent with every turn context, or only logged again? The
   requests' usage decides it (a re-sent listing is in context once, not N times): book it as one open `(listing)` load
   that a new copy replaces (`relist`), never as N concurrent loads.
7. Truncation: Claude caps `invoked_skills` content at 20 000 chars (M5); is the first isMeta skill line ever cut? Max
   seen 260 813 chars (not cut). Flag `est` only on the attachment cap.
8. `SKILL_BPT` calibration: for loads where the load request's growth is dominated by the skill (a subagent's first
   skill load right after its prompt), fit bytes → growth; keep 3.6 unless the fit differs by > 10 %.
