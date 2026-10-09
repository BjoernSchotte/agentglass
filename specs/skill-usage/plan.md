# Skill Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per session, a timeline of skill loads (trigger, turn, time, size) and the tokens and dollars each skill was responsible for (load + carry, tail carry), shown on every surface (transcript, call graph, replay, related, Wait timeline, Stats, preview, Repos, triage, compare, filters, rules, `--json`/`--watch`, OTLP, fleet, MCP, `agentglass skills`), plus evidence-based advice (`agentglass skills advise`).

**Architecture:** Adapters report loads and unloads to `record.ts` (`skillLoad`, `skillUnload`); the existing booking path (`tokens()`/`usageExact()`) attributes each request's tokens to the open loads (spec §3), into `Acc.sk` (timeline) and `Day.sa` (per-day per-skill buckets), both in the ledger's light part (one `VERSION` bump). A pure read model (`src/features/skills/model.ts`) prices and aggregates for every surface; a harness-neutral marks layer (`src/model/marks.ts`, shared with debug-episodes) feeds the timeline views. Advice is pure (`advise.ts`) over the read model plus a read-only inventory scan.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`, goldens `*.golden` beside their check.

**Spec:** [spec.md](spec.md) — read it first, including "Measurements", "Decisions" and "Open questions"; this plan argues from it.

**Phase:** Round 3 (roadmap). Needs nothing unmerged. Coordinates with debug-episodes on `src/model/marks.ts` (Task 1): whichever lands first creates it.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (after each edit `sh scripts/check.sh --changed`); a task is done only when both pass. Single check: `scriptc build <f> -o ~/.cache/agentglass-agents/<you>/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme ~/.cache/agentglass-agents/<you>/x`. Builds, caches and binaries under `~/.cache/agentglass-agents/<you>/`, never `/tmp` (RAM tmpfs).
- Any live run of `agentglass` uses the full isolation set inline (zsh does not word-split `$VAR`): `AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp AGENTGLASS_FLEET_DIR=$S/fleet AGENTGLASS_HUB_DIR=$S/hub` (`$S` = your scratch dir, `mkdir -p $S/run && chmod 700 $S/run`); `ls ~/.agentglass` before and after.
- scriptc 0.1.7: nominal typing (pass fields, not foreign interfaces); out-of-range array reads trap (`numAt`, bounds checks, `+ 0` on typed-array reads in comparisons, SC1090); no `Record<string, RegExp>` (C backend); SC2003 (no zero-parameter arrow for an optional interface member); no crypto (hash = the FNV pair of `callcache.ts pathKey`); no `n.toString(16)`; no map callbacks on typed arrays.
- **Skill text is never stored**: adapters pass it to `skillLoad()`, which measures and hashes it and keeps neither the string nor a slice. Review Focus 1.
- **Invariants** (spec §3.8) are enforced in `record.ts` by construction and asserted by `skillCheck()` (Task 5) in every attribution check.
- `--json` contract: existing `skills[]` entries keep `name`, `source`, `n` with the same values; fields are only added. Exception, intended: Codex (and any harness) sessions gain `model` entries for SKILL.md reads (spec Decision 19); list it in the PR. `tokens`, `costUsd` per session unchanged (skill $ is a share of them, never added).
- `VERSION` (`src/features/usage/codec.ts:13`) bumps **once**, in Task 3, to the next free number at implementation time.
- Keys: Stats `S` (skills panel), panel keys `s` sort / `↵` sessions / `a` advice / `esc`; transcript `]` / `[` (next / previous mark); `K` kind chips in transcript, call graph, related. Check again against `src/input.ts` and every `H.keys` handler for the mode before binding; a clash → stop and report.
- Footprint: nothing new on the hot path except a branch when loads are open; marks lazy; inventory only for advice. Task 3 and Task 16 measure with `scripts/footprint.sh`; RSS growth ≤ 2 MB and first frame ±5 % vs. baseline.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-skill-usage`, branch `feat/skill-usage` (parallel tasks: `feat/skill-usage-<task>` worktrees, rebased onto `feat/skill-usage`), PR to `main`, rebase-merge after green CI.

## Review Focus

1. **Skill text leaking** into a kept structure: serialize `accOut` of a fixture Acc, every `--json`/`--watch`/OTLP/fleet/MCP output of the fixtures and grep for the fixture text marker `LOREMSKILLTEXT` → none. Task 2, 6, 12, 13 checks.
2. **Over-attribution**: Σ skill tokens per request and bucket ≤ the request's bucket, with 3 open skills, a request smaller than Σ S, a reload while open, and harness-priced cost shares ≤ the request's `usd`. Task 2 check + `skills --check` on real logs (Task 16).
3. **Unload correctness**: compaction markers per harness end every open load; implicit drop fires only with both conditions; `/clear` (new log) leaves the old log's loads open but without further carry. Task 2 + Task 4a/b/c checks.
4. **Redaction**: no user skill name in `--redact` outputs (fake of equal length, stable), built-in names kept, hashes kept. Task 6 check.
5. **Cost consistency with re-pricing**: changing a price in `prices.json` changes skill $ in the same proportion as session $ (tokens per bucket priced at read time). Task 5 check.

---

### Task 0: Worktree, open questions, fixture shapes

**Files:** none committed; fixtures are hand-written lines in checks (real session lines are never copied in; skill text is `LOREMSKILLTEXT` + filler of known byte length).

- [ ] **Step 1: Worktree + build**: `git worktree add -b feat/skill-usage ../agentglass-skill-usage origin/main && cd ../agentglass-skill-usage && ./build.sh && sh scripts/check.sh`. Expected: build ok, all checks `ok`.
- [ ] **Step 2: Baseline**: with the isolation set, `./agentglass --json --subagents --limit 400 > ~/.cache/agentglass-agents/<you>/su-before.json` and `sh scripts/footprint.sh --bin ./agentglass --cold --scratch ~/.cache/agentglass-agents/<you>/fp0 > ~/.cache/agentglass-agents/<you>/fp-before.txt`.
- [ ] **Step 3: Open questions 1–7** (spec): run the commands listed under each open question; record each answer as a `Ruling:` line in the PR description. Where a ruling contradicts the spec, follow the real data and say so in the PR.
- [ ] **Step 4: Shapes** (keys only, never values; anonymize names): one Claude slash-skill pair, one `Skill` tool_use + its isMeta line, one `compact_boundary` line; one Codex `<skill>` user message + a `token_count` with `last_token_usage` + a `compacted` item; one pi `<skill …>` message + `compaction` entry; one OpenCode `skill` tool part with output + a compaction part; one Gemini `activate_skill` call + its functionResponse. Print with `python3 -c` replacing every string value longer than 40 chars by its length. These shapes drive Task 4's fixtures.
- [ ] **Step 5:** No commit in this task.

---

### Task 1: Shared session marks (`src/model/marks.ts`) — parallel with Task 2

**Files:** Create `src/model/marks.ts`, `src/model/marks.check.ts`. debug-episodes (merged spec, its plan Task 6) creates the same module if it starts first: then verify the shape against spec §5 and add only what is missing.

**Interfaces — Produces** (spec §5, the shape agreed with debug-episodes):
```ts
export interface Mark { kind: string; t0: number; t1: number; seq: number; turn: number; ev: number; anchor: string; label: string; sub: string; tok: number; usd: number; est: boolean; ref: string }
export interface MarkKind { kind: string; glyph: string; color: () => string; of: (s: Sess) => Mark[]; gen: (s: Sess) => number }
export function registerMarks(k: MarkKind): void;          // a family registered twice replaces the first
export function markKinds(): MarkKind[];
export function marksOf(s: Sess, kinds: string[] | null): Mark[]; // sorted by t0 (t0 0: by seq, after dated marks of the same turn), then kind, then ref; memo key s.id + "\t" + s.size + "\t" + Σ gen + "\t" + kinds; "skill" matches "skill:*"
export function markEv(s: Sess, m: Mark): number;           // anchor call=<cid> → the event with that id; else the first event with ts >= t0 (binary search); -1 none; cached into m.ev
export function nextMark(s: Sess, fromEv: number, dir: number, kinds: string[] | null): number; // event index of the next/previous mark, -1 none
```

- [ ] **Step 1: Failing check** `marks.check.ts`: register families `a` (points `a:x` at t=10,30) and `b` (span `b:y` 20..40, `gen` from a counter); a Sess with 5 events at ts 0,10,20,30,40 (ISO), event 3 with id `c1`. Assert `marksOf(s,null)` order `a:x@10, b:y@20, a:x@30`; `marksOf(s,["b"])` length 1, `marksOf(s,["a:x"])` length 2; `markEv` = 1, 2, and 3 for a mark with `anchor "call=c1"` and t0 0; `nextMark(s,1,1,null) === 2`, `nextMark(s,2,-1,null) === 1`, `nextMark(s,3,1,null) === -1`, `nextMark(s,0,1,["b"]) === 2`; memo: unchanged `s.size` and `gen` → provider called once; `s.size++` → again; `gen` bump → again; Kiro-style marks with t0 0 ordered by `seq`.
- [ ] **Step 2: Run** `scriptc build src/model/marks.check.ts -o ~/.cache/agentglass-agents/<you>/mk && ~/.cache/agentglass-agents/<you>/mk` → FAIL (module missing).
- [ ] **Step 3: Implement.** Memo: one `Map<string, Mark[]>` capped at 64 entries (drop the oldest).
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh --changed` PASS.
- [ ] **Step 5: Commit** `feat(model): harness-neutral session marks`.

---

### Task 1b: Event kinds — filter values, chips `K`, gap markers, deep links (after Task 1; parallel with wave 3)

**Files:** Modify `src/model/marks.ts` (`evKind`, `kindsOf`), `src/features/query/attrs.ts:106` (`event` gets `enumFn: "evkind"`), `src/features/query/eval.ts` (event clauses over kinds + families; legacy values `user` … map to `ev:user` …), `src/ui/transcript.ts` (hidden runs → gap line), `src/features/callgraph/view.ts`, `src/features/related/view.ts` (honor the clause), `src/features/palette/ref.ts:233` + `open.ts` (`kinds=` fragment); Create `src/ui/chips.ts` (the chip bar, one implementation for all three views), `src/ui/chips.check.ts`, `src/model/kinds.check.ts`.

- [ ] **Step 1: Failing checks**: `evKind` for user/assistant/thinking/tool/result/failed result/meta/`mcp__srv__x` → `ev:user` … `ev:error`, `mcp:srv`; `kindsOf` counts built-ins + registered marks; `event is skill` matches a Sess with a `skill:load` mark and not one without; `event is user` (legacy) still matches as before (the existing query checks stay green); chip bar render at 80 columns (golden), `␣`/`f`/presets 1–4/`↵` produce the expected clause text; transcript with `event is_not ev:thinking` shows `┄ 3 hidden · thinking 3 ┄` lines; `canonicalUrl(…, kinds)` → `…#call=c1&kinds=skill,debug` and `applyTarget` restores the clause.
- [ ] **Step 2–4:** FAIL → implement → PASS; `sh scripts/check.sh --changed`.
- [ ] **Step 5: Commit** `feat(views): one event-kind taxonomy, kind chips, gap markers, links with kinds`.

---

### Task 2: Attribution engine in the ledger records (sequential base)

**Files:** Modify `src/features/usage/record.ts` (Acc, Day, `newAcc`, `bucket` day literal, `tokens`, `usageExact`, `turn`); Create `src/features/usage/skillrec.ts` (the engine, imported by `record.ts`), `src/features/usage/skillrec.check.ts`.

**Interfaces — Produces:**
- `SkLoad` exactly as spec §4. `Acc` gains `sk: SkLoad[]; rq: number; tq: number; lastCtx: number`. `Day` gains `sa: Map<string, number[]>` (16 slots, spec §4 order; constants `SA_LU=0, SA_LM=1, SA_LC=2, SA_L=3, SA_C=7, SA_T=11, SA_HU=15`).
- `export function skillLoad(a: Acc, name: string, trig: string /* user | model | compact | listing */, ms: number, iso: string, text: string, dir: string, est: boolean): void` — `text` may be `""` (size unknown → `bytes = -1, S = -1`); `est` forces tier ≈ (truncated text). Books `Day.sa[..][SA_LU|LM|LC]` on the load's day. Ignored when `owned()` said copied (the caller checks).
- `export function skillUnload(a: Acc, ms: number, why: string): void` — ends every open load.
- `export function skillHash(text: string): string` — 16 hex (FNV pair).
- `export function skillReq(a: Acc, d: Day, model: string, prov: string, b: number[] /* [in, cr, w5, w1] remaining, mutated */, usd: number, ms: number): void` — called from `tokens()` and `usageExact()` **before** the tap, only when `nIn + nCr + w5 + w1 > 0`; implements §3.2–3.4 (implicit drop first, then carries oldest-first, then pending loads), books `Acc.sk[i].lt/ct/tt/nq/hu` and `Day.sa`, updates `a.rq`, `a.lastCtx`.
- `turn()` increments `a.tq` by `n` (also for `a.sub`: a subagent's prompts number its own turns but book no `Day.turns`) and sets `te` on loads of the closed turn.
- `export function skillPath(path: string): string` — the skill name for a path `…/skills/<dir>/SKILL.md` (plugin
  paths `…/plugins/…/<plugin>/…/skills/<dir>/SKILL.md` → `<plugin>:<dir>`), `""` otherwise (spec §2 "SKILL.md reads").
- `export function skillReadCmd(cmd: string): string` — for a shell command line: the first path argument ending in
  `/SKILL.md` of a reading program (`cat sed nl head tail less bat rg grep`, after `cd …&&`, `sudo`, env assignments;
  not after a pipe), `""` otherwise. Plain string scanning, no `Record<string, RegExp>`.
- `export function skillRead(a: Acc, d: Day, callId: string, path: string, ms: number): void` and
  `export function skillReadDone(a: Acc, callId: string, ms: number, iso: string, out: string, cut: boolean): void` —
  the call side remembers `callId → path` (map on `Acc`, not persisted, like `pend`), the result side loads it
  (`trig = "model"`, `dir` = the path's directory, `est = cut`) and books `Day.skills` `model\t<name>`; the same path
  again in the same turn while its load is pending/open → `skillGrow` (tier ≈); a `Skill`/`skill`/`activate_skill`
  load of the same name in the same request → ignored (part of that load).
- Bytes → `S_est = Math.ceil(bytes / SKILL_BPT)`, `export const SKILL_BPT = 3.6` (Task 0 / M3 may tune it; one constant).
- Harness-priced share: `w` by `resolve(model, prov)` rates when present, else token counts (spec §3.5).

- [ ] **Step 1: Failing checks** in `skillrec.check.ts` (hand-made sequences, `newAcc()`, `bucket()`):

```ts
const T = "LOREMSKILLTEXT" + "x".repeat(3586);            // 3600 bytes → S_est = ceil(3600 / 3.6) = 1000
const a = newAcc(); const iso = "2026-10-01T09:00:00.000Z"; const d = bucket(a, 0, iso); const M = "claude-sonnet-4-5";
function sum4(x: number[]): number { return (x[0] ?? 0) + (x[1] ?? 0) + (x[2] ?? 0) + (x[3] ?? 0); }
function allEnded(why: string): boolean { for (const x of a.sk) if (x.end === 0 || x.why !== why) return false; return true; }
tokens(a, d, M, 10, 50, 0, 20000, 0);                     // r1: ctx 20010, no load
skillLoad(a, "alpha", "user", 1, iso, T, "/k/alpha", false);
tokens(a, d, M, 10, 50, 20000, 1500, 0);                  // r2: ctx 21510, growth 1500 → S = 1000, taken from w5
const A = a.sk[0];
ok("load from write", A.S === 1000 && A.lt[2] === 1000 && sum4(A.lt) === 1000, JSON.stringify(A.lt));
tokens(a, d, M, 10, 50, 21500, 100, 0);                   // r3: ctx 21610, alpha carries 1000 from cache read
ok("carry from read", A.ct[1] === 1000 && A.nq === 1, JSON.stringify(A.ct));
skillLoad(a, "beta", "model", 2, iso, T, "/k/beta", false); skillLoad(a, "gamma", "model", 3, iso, T, "/k/gamma", false);
tokens(a, d, M, 0, 50, 900, 1200, 0);                     // r4: ctx 2100. Drop test: 2100 < 0.5 × 21610 but not < 1000 (Σ S of
// non-pending loads = alpha only) → no drop. alpha (oldest) carries cr 900 + w5 100; beta (growth ≤ 0 → S_est 1000) takes w5
// 1000; gamma takes the last w5 100, short 900. Σ = 2100 = ctx(r4) exactly.
const B = a.sk[1]; const G = a.sk[2];
ok("no drop on one condition", a.sk[0].end === 0 && B.end === 0 && G.end === 0, "");
ok("alpha carry r4", A.ct[1] === 1900 && A.ct[2] === 100 && A.nq === 2, JSON.stringify(A.ct));
ok("beta load r4", B.S === 1000 && B.lt[2] === 1000, JSON.stringify(B.lt));
ok("gamma short", G.lt[2] === 100 && G.short === 900, JSON.stringify(G.lt) + " " + String(G.short));
ok("r4 never exceeds request", (1900 + 100 - 1000) + sum4(B.lt) + sum4(G.lt) === 2100, "");
tokens(a, d, M, 0, 50, 400, 0, 0);                        // r5: ctx 400 < 0.5 × 2100 and < 3000 → all three drop, nothing carried
ok("drop ends all", allEnded("drop") && A.nq === 2, String(A.nq));
```  Plus: (0) `skillPath` cases: `/h/.codex/skills/ponytail/SKILL.md` → `ponytail`; `/h/.claude/plugins/cache/m/superpowers/5.1/skills/brainstorming/SKILL.md` → `superpowers:brainstorming`; `/r/docs/SKILL.md` → `""`; `skillReadCmd` cases: `sed -n '1,200p' /x/skills/a/SKILL.md` → path, `cd /x && cat skills/a/SKILL.md` → path, `ls /x/skills/a/SKILL.md` → `""`, `echo x | cat /x/skills/a/SKILL.md` → `""`; two partial reads in one turn → one load, tier ≈;
  (a) reload while open → two records, both carry, `rel = false`; (b) `skillUnload(a, t, "compact")`, then a load of `alpha` → `rel = true`; (c) two turns: `turn(a, 0, iso, 1)` after the load → carry in the next request lands in `tt`; (d) `usageExact` with `usd = 0.10` and a load open → `hu ≤ 0.10` and Σ `hu` over loads ≤ 0.10; (e) `skillLoad(..., "", ...)` → `S === -1`, carries nothing, counts a load; (f) `accOut(a)` JSON contains no `LOREMSKILLTEXT` (Task 3 adds the codec; until then assert on `JSON.stringify` of `a.sk`); (g) Σ over `Day.sa` slots equals Σ over `Acc.sk` per bucket; (h) a `pend` load with growth `g ≤ 0` (cache expiry) uses `S_est`.
  Every step ends with `skillInv(a)` (local helper until Task 5's `skillCheck`): per load `short ≥ 0`, all token slots ≥ 0, ended loads have `why`.
- [ ] **Step 2: Run** `scriptc build src/features/usage/skillrec.check.ts -o ~/.cache/agentglass-agents/<you>/sr && ~/.cache/agentglass-agents/<you>/sr` → build FAIL.
- [ ] **Step 3: Implement** `skillrec.ts`; wire into `record.ts` (`tokens`/`usageExact` build the bucket array `[nIn, nCr, w5, w1]` and call `skillReq` only `if (a.sk.length)` — `rq`/`lastCtx` still update on every request: one add, one store). The drop test (spec §3.4) sums `S` over **non-pending** open loads only; a load pending at this request is never dropped by it. No arrow callbacks over `a.sk` in hot code (plain loops).
- [ ] **Step 4: Run** the check → PASS; `record.check.ts` unchanged and PASS; `sh scripts/check.sh --changed` PASS.
- [ ] **Step 5: Commit** `feat(usage): skill load timeline and per-request attribution`.

---

### Task 3: Ledger codec + VERSION bump + footprint (after Task 2)

**Files:** Modify `src/features/usage/codec.ts` (`accOut`/`accIn`: key `sk` columnar; `dayOut`/`dayIn`: key `sa`), `VERSION`; Test `src/features/usage/cache.check.ts` (or the codec's existing round-trip check).

- [ ] **Step 1: Failing check**: round-trip an Acc with 3 loads (one open, one `compact`, one `drop`, one `S = -1`) and a Day with two `sa` rows → field-equal after `accIn(accOut(a))`; the serialized text contains no `LOREMSKILLTEXT`; an Acc with no loads serializes without an `sk` key (no growth for sessions without skills).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; columns: `sk: {n: [names, front-coded], g: [trig codes], t: [...], tu, te, rq0, b, S, h, dir, sc, end, why, rel, pend, short, nq, lt (4×n flat), ct, tt, hu, m, p}`; bump `VERSION` with a one-line reason (`skill loads + per-skill day buckets`); `OWN_FIX` handling: a v-old cache is not `readable` → re-index.
- [ ] **Step 4: Run** → PASS; `./build.sh`; with the isolation set: `./agentglass --json --subagents --limit 400 > ~/.cache/agentglass-agents/<you>/su-t3.json`; `jq -S '[.[]|{id,tokens,costUsd}]'` both files and `diff` → no diff except sessions newer than the baseline. Footprint: `sh scripts/footprint.sh --bin ./agentglass --cold --scratch …/fp3` vs `fp-before.txt`: RSS +≤ 2 MB, first frame ±5 %. Record both in the commit body.
- [ ] **Step 5: Commit** `feat(usage): persist skill loads and day buckets (cache v<N>)`.

---

### Task 4a: Claude adapter — parallel with 4b, 4c, 5 (after Task 2)

**Files:** Modify `src/harness/claude.ts:225-250,285-296` (`userLine`, `usage`), Test `src/harness/claude.check.ts` (create if absent) with fixtures in `src/features/skills/fixtures/claude.jsonl` (synthetic).

**Behavior:**
- Slash command: where `claude.ts:243` books `command`, also `skillLoad(a, name, "user", ms, textAfterBaseDirLine, dir, truncated)`.
- Model: on the isMeta `Base directory for this skill:` line **with** `sourceToolUseID`: `skillLoad(a, name-from-dir-or-the-Skill-call, "model", …)` (keep a small map tool_use id → skill name from the `Skill` tool_use, cleared on use; the count at `claude.ts:293` stays).
- Model text may span several isMeta lines with the same `sourceToolUseID`: the first creates the load, later ones add
  bytes before the next request (`skillGrow(a, bytes, text)`: a pending load only; re-hash over the concatenation by
  feeding the FNV state, kept in the load as two numbers while pending).
- Stub: an isMeta line with `sourceToolUseID` whose text starts `(Re-invocation of` → `skillLoad(…, "model", …)` with the
  stub text and `stub = true` (field on `SkLoad`, codec in Task 3).
- Re-injection after compaction: `{"type":"attachment","attachment":{"type":"invoked_skills","skills":[…]}}` →
  one `skillLoad(a, name, "compact", ms, content, "", content.length === 20000)` per entry; **no** `Day.skills` count.
- Listing: `{"type":"attachment","attachment":{"type":"skill_listing","content":…,"skillCount":n}}` →
  `skillLoad(a, "(listing)", "listing", ms, content, "", false)` and `a.lst = names` parsed from the content (one name per
  entry; Task 0 Step 4 records the entry format; keep names only, ≤ 400, own()ed). A later listing with `isInitial:
  false` replaces the open `(listing)` load (unload it with `why = "relist"`, load the new one).
- `{"type":"system","subtype":"compact_boundary"}` → `skillUnload(a, ms, "compact")` (pre-filter `indexOf("compact_boundary")`).
- `Read` of a SKILL.md (not right after a `Skill` load of the same name) → `skillRead`/`skillReadDone`.
- Copied lines (`owned()` false) → no load.
- Truncation marker (Open question 7) → `est = true`.

- [ ] **Step 1: Failing check**: fixture with: a `skill_listing` attachment (3 entries, 720 B); request r1; slash `/alpha` + isMeta (3600 B); r2..r4; `Skill` tool_use `beta` + isMeta with `sourceToolUseID` (7200 B, split over two lines); r5; `Skill` `beta` again + stub line; r6; `compact_boundary`; `invoked_skills` with `alpha` (3600 B); r7; a copied line pair (same uuid as earlier) → assert loads `(listing)`/listing, alpha/user, beta/model (S 2000, one record from two lines), beta/model stub, alpha/compact; everything open before the boundary ends `why = compact`; r7 carries only the compact load of alpha (and nothing of the listing, which the boundary ended — Open question 1 decides whether Claude re-sends the listing; the fixture follows the ruling); `Day.skills` counts as today (`command\talpha` 1, `model\tbeta` 2) — the compact and listing loads add none; `a.lst` = the 3 names; no `LOREMSKILLTEXT` in `JSON.stringify(a.sk)`.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS; `sh scripts/check.sh --changed`.
- [ ] **Step 5: Commit** `feat(claude): skill loads with size, model skill text, compaction`.

### Task 4b: Codex + pi adapters — parallel

**Files:** Modify `src/harness/codex.ts:62,101-102,244-258`, `src/harness/pi.ts:98,159,217-222`; Tests `src/harness/codex-yield.check.ts` neighbour → new `src/harness/codex-skill.check.ts`, `src/harness/pi.check.ts`; fixtures `src/features/skills/fixtures/{codex,pi}.jsonl`.

**Behavior:** Codex: shell calls (`exec_command`, `shell`, `local_shell_call`) whose command line `skillReadCmd()` matches → `skillRead()` at the call, `skillReadDone()` at its output (`cut` when the output carries Codex's truncation marker; Task 0 records the marker text); the developer message's `<skills_instructions>` part → `skillLoad(a, "(listing)", "listing", …)` replacing the open listing (`relist`), names parsed per entry; the `<skill>` block → `skillLoad(…, "user", …)` with the block's inner text; `compacted` item and `context_compacted` → `skillUnload`; when a `token_count` has `last_token_usage`, book that request through the normal path (Task 0 Ruling on whether `usage()` already books per response; if per turn only, pass `est = true` on loads of that rollout). pi: `<skill>` message → `skillLoad(…, "user", …)` (text inside the block, `location` → dir); `read` tool calls whose path `skillPath()` names → `skillRead`/`skillReadDone` with the read result's text; `compaction` entry → `skillUnload` **before** its own usage booking (`pi.ts:222`).

- [ ] Steps 1–5 as 4a. Codex fixture: a developer message with a `<skills_instructions>` part (3 entries), `token_count` with `last_token_usage` after each response, an `exec_command` `sed -n '1,200p' …/skills/alpha/SKILL.md` + output, a second `sed -n '200,400p'` of the same file in the same turn + output with the truncation marker, 3 responses, a `compacted` item, a second developer message with the listing again, 1 response → loads `(listing)` (then `relist`), one `alpha` load (model, tier ≈, bytes = both outputs), unloads at the compaction, `Day.skills` `model\talpha` = 1. pi fixture: `<skill>` message, a `read` of `…/skills/beta/SKILL.md`, 3 messages, a `compaction` entry, 1 message. Commit `feat(codex,pi): skill loads from SKILL.md reads and listings, compaction`.

### Task 4c: OpenCode + Gemini + Kiro — parallel

**Files:** Modify `src/harness/opencode.ts:308-311,325,353,376-379`, `src/harness/gemini.ts:390-399`, `src/harness/kiro.ts:76`; Tests `opencode.check.ts`, `gemini.check.ts`, `kiro.check.ts`.

**Behavior:** OpenCode `skill` tool → load `model` with the tool part's output text (absent → `""`, tier `?`, sized by Task 5's `sizeFill`); `read` of a SKILL.md → `skillRead`/`skillReadDone`; `{"type":"skill"}` row → `user`; compaction part/message (`status !== "running"`) → `skillUnload`. Gemini `activate_skill` → load `model` with the functionResponse output (paired by call id; absent → `""`); `read_file` of a SKILL.md → `skillRead`/`skillReadDone`; `/compress` marker if Task 0 found one → `skillUnload`, else implicit drop covers it. Kiro: `Compaction` → `skillUnload` (no loads; keeps the API uniform).

- [ ] Steps 1–5 as 4a. Commit `feat(opencode,gemini,kiro): skill loads and compaction`.

---

### Task 5: Read model + pricing + invariants (after Task 2; parallel with 4a–c)

**Files:** Create `src/features/skills/model.ts`, `src/features/skills/model.check.ts`.

**Interfaces — Produces:**
```ts
export interface LoadRow { sess: string; name: string; trig: string; t: number; turn: number; te: number; end: number; why: string; rel: boolean;
  bytes: number; size: number; tier: string /* exact | ≈ | ? */; hash: string; scope: string; requests: number;
  load: number; carry: number; tail: number; /* tokens */ usd: number; carryUsd: number; tailUsd: number; unpriced: boolean }
export interface SkillRow { name: string; loadsUser: number; loadsModel: number; loadsCompact: number; sessions: number; sizeP50: number;
  load: number; carry: number; tail: number; usd: number; carryUsd: number; tailUsd: number; perSess: number; tier: string; hashes: string[]; scope: string; unpriced: boolean }
export const SKILL_FIELDS: string[];                     // the JSON field names of SkillRow, in order (stable contract)
export function skillLoads(as: Acc[], ids: string[]): LoadRow[];                     // a session's timeline (subagents with their ids)
export function skillTable(as: Acc[], days: string[] | null, sessOf: (a: Acc) => string, by: string /* cost|loads|tail|size|persess */): SkillRow[];
export function bucketUsd(model: string, prov: string, b: number[] /* in, cr, w5, w1 */): number; // via resolve(); -1 unpriced
export function skillCheck(as: Acc[]): string[];          // spec §3.8 violations, [] = ok
export function sizeFill(rows: LoadRow[]): void;          // a "?" load gets the size of the same hash/name's known loads, tier ≈
```

- [ ] **Step 1: Failing check**: Accs built through Task 2's API (two sessions, three skills, one harness-priced) → `skillTable` sums equal Σ `Day.sa`; `usd` = `bucketUsd` per bucket + `hu`; sort orders; `perSess` = usd / sessions; `skillCheck` = [] for valid Accs and reports a hand-broken one (`ct[1]` > request); **re-pricing**: `loadUser(prices.json with a 2× cache-read price)` → `carryUsd` scales by the cache-read share exactly (Review Focus 5); `sizeFill` gives a `?` load the p50 of its name and tier `≈`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(skills): read model, pricing and invariants`.

---

### Task 6: CLI `agentglass skills`, `--json`, `--watch`, redaction (after Tasks 5 and 7)

**Files:** Create `src/features/skills/cli.ts`, `scripts/skills.test.sh`, `src/features/skills/skills.golden`, `skills-80.golden`, `skills-json.golden`; Modify `src/features/cli.ts:69,108,121,196` (skills entries + `skillLoads` field), `src/features/clihelp.ts:103`, the `--watch` emitter (skill / skill_end events), `src/features/redact.ts` (`fakeSkill`, built-in allowlist).

**Behavior:** spec 6.13, 6.17, Privacy. `agentglass skills` text table (6.6 layout; ≤ 80 columns drops columns in the spec's order), `--json` = `{period, rows: SkillRow[], advice: Advice[] (top 3), tier notes}`; `--session ref` = timeline; `--check` = `skillCheck` over the ledger, exit 3 on violations, prints them. `--json` session entries gain the fields of 6.13; `--fields skillLoads`. Redaction: `fakeSkill(name)` through the subagent scrubber (`redact.ts:139-163`), allowlist `BUILTIN_SKILLS` (harness-bundled names; document the source of each list in a comment).

- [ ] **Step 1: Failing test** `scripts/skills.test.sh`: a fixture HOME (`scripts/fixture-agents.sh` pattern) with the Task 4 fixtures; run with the isolation set: `agentglass skills` → `diff` vs `skills.golden`; `COLUMNS=80` → `skills-80.golden`; `skills --json | jq -S .` → `skills-json.golden`; `--json` session: `jq '.[0].skills[0] | keys'` contains `name,source,n,costUsd,carryUsd,tier`; `skills --check` exit 0; `--redact skills --json` has no fixture name except built-ins and no `LOREMSKILLTEXT`; `--watch --from 0` stream contains `"type":"skill"` lines in order.
- [ ] **Step 2–4:** FAIL → implement → PASS; `sh scripts/check.sh --changed`.
- [ ] **Step 5: Commit** `feat(skills): agentglass skills, --json skill fields, --watch events, redaction`.

---

### Task 7: Advice engine A1–A6 + inventory (after Task 5; parallel with 8–12)

**Files:** Create `src/features/skills/advise.ts`, `src/features/skills/inventory.ts`, `advise.check.ts`, `inventory.check.ts`, `advise.golden`.

**Interfaces — Produces:**
```ts
export interface Advice { id: string /* A1..A6 */; skill: string; severity: number /* $ at stake per 30 days, for ordering */; evidence: string[]; suggestion: string; sessions: string[] /* ≤ 10 ids */ }
export function advise(rows: SkillRow[], loads: LoadRow[], inv: InvSkill[], cfg: AdviseCfg, calls: (sess: string, t0: number, t1: number) => { n: number; err: number }): Advice[];
export interface InvSkill { name: string; harness: string; scope: string; descBytes: number; manual: boolean }
export function inventory(repos: string[]): InvSkill[];   // read-only, frontmatter (≤ 4 KB) only, memo 1 h
export function adviseCfg(): AdviseCfg;                    // config "skills.advise.*" with defaults (spec §8), invalid → default + toast
```

- [ ] **Step 1: Failing check**: one synthetic case per rule A1–A6 that fires, one near-miss per rule that does not (threshold − 1); A5 delta table (two hashes, 3 sessions each); A6 with a temp HOME holding two SKILL.md files (one loaded, one not) → only the unloaded one, listing ≈ tokens = ceil(descBytes/3.6) × requests; description text never in the output (`LOREMDESC` marker); ordering by severity; golden of the rendered text.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(skills): advice A1–A6 and skill inventory`.

---

### Task 8: Stats — skills panel `S`, preview, hour markers (after Tasks 1 and 5; parallel)

**Files:** Modify `src/features/usage/stats.ts:283-352,463,712-748,785` ; Create `src/features/skills/panel.ts`, `panel.check.ts`, `panel-80.golden`, `panel-120.golden`.

**Behavior:** spec 6.6, 6.7. Panel honors the Stats period and filter (pins); `↵` sets the session-list filter `skill is <name>`; `a` shows Task 7 advice for the row (until Task 7 lands: "advice: not available" — Task 7 is merged before this task's PR); `✧ skills` group `↵` opens the panel at that row; hour chart markers row; preview line. Help entries.

- [ ] **Step 1: Failing check**: render the panel from fixture Accs at 80 and 120 columns → goldens; key handling: `S` opens only in Stats mode, `s` cycles sort, `esc` closes; preview line text for a session with 3 skills; marker row for loads at hours 9 and 14.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(stats): skills panel, preview line and hourly load markers`.

---

### Task 9: Timeline views — transcript, call graph, replay, related, Wait timeline (after Tasks 1b and 5; parallel)

**Files:** Modify `src/ui/transcript.ts` (meta lines at loads/unloads), `src/input.ts:92-111` (`]`/`[` via `nextMark`), `src/ui/detail.ts` (load detail), `src/features/callgraph/model.ts` + `view.ts` (skill lane, tree rows), `src/features/replay.ts` (status line), `src/features/related/build.ts` (kind `skill`), `src/features/wait/tab.ts` (timeline ticks); Create `src/features/skills/marks.ts` (registers kind `skill`), checks beside each modified view (`callgraph/model.check.ts`, `related/build.check.ts`, `ui/transcript.check.ts`).

- [ ] **Step 1: Failing checks**: transcript of the Claude fixture shows `✧ alpha · user · 1.0k tok …` at the load index and `✧ alpha out (compacted)` at the boundary; `]` from event 0 lands on the load; call graph model has a skill lane with a band [load, compact]; related rows include a `skill` row only with kinds = all; Wait timeline lane tick at the load minute.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(views): skill marks in transcript, call graph, replay, related and wait timeline`.

---

### Task 10: Filters, triage, compare, Repos (after Task 5; parallel)

**Files:** Modify `src/features/query/types.ts` (`Ent` += `"skill"`), `attrs.ts` (keys spec 6.11), `eval.ts` (skill rows from `Acc.sk` per session; lifting like `call`), `parse.ts` completion, `src/features/triage/run.ts:79-80`, `src/features/compare/sections.ts` (+ `view.ts` section), `src/features/repos/tab.ts` (column ≥ 120 cols, detail table); Tests `query/eval.check.ts`, `triage/run.check.ts`, `compare/sections.check.ts`, `repos/tab.check.ts`.

- [ ] **Step 1: Failing checks**: `skill is alpha and skill.cost > $0.01` matches the session where alpha cost more and not one where only beta did (same-row rule); `skill.trigger is model`; `--watch` rejects `skill.cost` with the "known only after" error; triage `skill` dimension on calls attributes a failing call to the skills open at its time; compare section rows for A/B; Repos column text.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(query,triage,compare,repos): skill entity, dimension, section and column`.

---

### Task 11: Alert rule metrics (after Task 5; parallel)

**Files:** Modify `src/features/rules/metrics.ts:30-34` (`sessMetric`), `src/features/rules/config.ts:164-176` (built-in `skill-reload`, off), placeholders `{skill}` in the message renderer; Test `metrics.check.ts`, `config.check.ts`.

- [ ] **Step 1: Failing check**: `skill_reloads` = 2 for a session with alpha loaded twice while open, 1 when the first was compacted before; `skill_carry_usd` = the max per skill; `skill_context_share` in [0,1]; built-in `skill-reload` present, `enabled: false`, enabling via rules.json fires `degraded` with message `alpha loaded 2× in one context`.
- [ ] **Step 2–4, 5:** commit `feat(rules): skill reload, carry and context-share metrics`.

---

### Task 12: OTLP span events + hub (after Tasks 4a–c and 5; parallel)

**Files:** Modify `src/features/otlp/build.ts:150-190` (span events per load/unload on the turn root, session attributes), `src/features/otlp/types.ts` (event list already exists on spans), `src/features/otlp/encode.ts:169` (unchanged encoder, verify), `src/features/hub/map.ts:262` (events → `skills[]`); Tests `otlp/build.check.ts`, `hub/map.check.ts`.

- [ ] **Step 1: Failing check**: the Claude fixture exports `gen_ai.skill.load` events with `gen_ai.skill.name`, `agentglass.skill.trigger`, `size_tokens`, `hash`, `scope`, `tier`; `gen_ai.skill.unload` with `reason = compact`; no `LOREMSKILLTEXT` in the payload; `--redact` fakes the name; hub map turns them into `skills[{name, source, n, …}]` equal to the local `--json` entry (minus $ fields the hub cannot price → `null`).
- [ ] **Step 2–4, 5:** commit `feat(otlp): skill load/unload span events; hub fills skills`.

---

### Task 13: Fleet + MCP tool (after Task 6)

**Files:** Modify `src/features/fleet/model.ts` (`DayRow.sa`), `snapshot.ts` / `merge.ts` (carry and sum `sa`), `src/features/fleet/tui.ts` (host column in the skills panel), `src/mcp/tools.ts:76` (tool `skills`), `src/mcp/shape.ts`; Tests `fleet/merge.check.ts`, `scripts/fleet-exact.test.sh` (extend), `mcp/tools.check.ts`.

- [ ] **Step 1: Failing checks**: two host reports with the same session copy (owned on host A) → merged skill $ = host A's, not doubled; redacted host report has fake names, same hashes; MCP `skills` tool: schema listed, `{period:"7d"}` returns rows with `SKILL_FIELDS`, `{ref:"current"}` returns loads, `advise: true` returns ≤ 10 advice items; no text marker.
- [ ] **Step 2–4, 5:** commit `feat(fleet,mcp): exact skill merge across hosts, skills MCP tool`.

---

### Task 14: Phase B advice A7–A10 (after Task 7; separate PR allowed)

**Files:** `src/features/skills/advise.ts` (+ checks, golden). A7 needs call rows in `[t, te)` (the `calls` callback of Task 7); A8 co-load Jaccard over (session, turn) sets; A9 test-kind/vcs-commit outcome per loading turn vs the repo's turns without the skill (wait families `kind`), labelled correlation; A10 per name hashes per host (fleet rows).

- [ ] Steps as Task 7, one fire + one near-miss case per rule. Commit `feat(skills): advice A7–A10`.

---

### Task 15: Docs

**Files:** `README.md` (Supported harnesses: skill notes per harness incl. tier, and the Codex note at line ~1492 rewritten: Codex skills are counted from `$name` mentions **and** from the agent reading a `SKILL.md`; a "Skills: what they cost" highlight; `agentglass skills` in the CLI list; keys `S`, `]`/`[`), `specs/ROADMAP.md` (status), help text already done per task.

- [ ] Write; `sh scripts/check.sh` (help/README contract checks); commit `docs: skill usage`.

### Task 16: Real-life verification, footprint, final review

- [ ] With the isolation set on this machine's logs (read-only): `./agentglass skills --check` → exit 0; `./agentglass skills --period 30d` totals vs the spec's M-figures (±10 %); `./agentglass --json --subagents --limit 400` `tokens`/`costUsd` identical to Task 0 baseline for unchanged sessions; footprint vs baseline (RSS +≤ 2 MB, first frame ±5 %); TUI: open Stats → `S`, a session transcript → `]`, call graph → skill lane (one tmux pane, killed after).
- [ ] Request review (superpowers:requesting-code-review) with the Review Focus list; fix findings; PR.

## Parallelism

| wave | tasks | why |
|---|---|---|
| 0 | 0 | rulings drive fixtures |
| 1 | 1 ∥ 2 | marks module is independent of the engine |
| 2 | 3 | codec needs the engine's fields |
| 3 | 1b ∥ 4a ∥ 4b ∥ 4c ∥ 5 | separate files; 4a–c and 5 use only Task 2's API, 1b only Task 1's |
| 4 | 7 ∥ 8 ∥ 9 ∥ 10 ∥ 11 ∥ 12 | separate files; all read Task 5's model (9 also needs 1b, 12 also needs 4a–c); 9 and 10 both touch `query/` only if 1b is not merged — merge 1b first |
| 5 | 6 | wires advice (7) into the CLI and `--json` |
| 6 | 13 | needs the `--json` skill entries (6) |
| 7 | 14 ∥ 15 | phase B advice; docs |
| 8 | 16 | verification |
