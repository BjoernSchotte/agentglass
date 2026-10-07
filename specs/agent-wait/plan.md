# Agent Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show what agents wait on (wall time per normalised command family and per tool, share of agent time, p50/p95, failure rate, trend, the tool / user / model split) and whether heavy commands block each other (live with RSS and host load, history with peaks, overlap and slowdown, an opt-in contention alert), in a Wait tab, `agentglass wait` (text, `--json`, `--now`, `--check`), filter attributes, OTLP attributes and `fleet pull --wait`.

**Architecture:** A pure normaliser (`src/features/wait/family.ts`) maps a stored command line to `{name, kind, heavy}`, memoised per command-dictionary id. A resumable report (`report.ts`) walks the call rows of a window through `callsIn` and sums per family, kind and tool, plus the agent-time split from `Day.act`. A pure sweep (`overlap.ts`) computes concurrency, overlap and slowdown. The live part (`live.ts`) runs on the watchdog's alarm tick from data the tick already holds (process tree, open calls). Rules get two host-wide metrics; the CLI, the tab, the fleet line and OTLP read these modules. No cached data changes (no `VERSION` bump, calls `FORMAT` stays 2).

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first, including "Decisions" and "Open questions"; this plan argues from it.

**Round:** Round 2 (after 2026.10.4). Needs filter-language, rules-config, tui-footprint, cli-agent-mode and fleet Part A (all merged). Independent of fleet Part B and otlp-hub.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`; a task is done only when both pass. Single check (builds and caches under your own dir, never `/tmp`): `C=$HOME/.cache/agentglass-agents/impl-wait; mkdir -p $C/home; scriptc build --optimization dev --strip <f> -o $C/x && HOME=$C/home AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme $C/x` (the suite runs checks with `AGENTGLASS_REDACT=1`: branch on `REDACT` where output differs, and run once without it locally).
- Live runs of agentglass only with the full isolation set written out literally (zsh does not split `$VAR`): `AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp AGENTGLASS_FLEET_DIR=$S/fleet AGENTGLASS_HUB_DIR=$S/hub` (`S=$HOME/.cache/agentglass-agents/impl-wait/s`, `mkdir -p $S/run && chmod 700 $S/run`). `ls -la ~/.agentglass` before and after each live run: nothing may change.
- scriptc 0.1.7 limits: nominal typing (pass fields, not foreign interfaces); no `Record<string, RegExp>` (C backend) — the normaliser uses word lists and string tests, no user regex; out-of-range array reads trap (bounds-check, `numAt`); no zero-parameter arrow for an optional interface member (SC2003); SC1090 array-index quirks (`+ 0` on typed-array reads used as indexes, no `.map` callbacks on index types, no `.replace` with a function); static builds lack `Math.sqrt/log/pow` (not needed).
- **Footprint** (tui-footprint): nothing runs for the Wait tab while it is hidden; the report steps in ≤ 20 ms slices; the live part is O(live shells) per alarm tick; no per-tick scan of call rows; no new files written.
- **Exactness**: no change to any existing number — `scripts/golden-usage.sh <main-bin> <branch-bin> --warm` reports 0 differences (Task 11). Sums in the report equal brute-force sums over the same rows (Task 3 check).
- Kill only pids/tmux sessions you started. One build at a time; at most one TUI at a time, killed right after; `nice` heavy measurements.
- TUI baseline: 80 columns, `?` help documents every key, footer hints correct, palette actions, `NO_COLOR`; CLI errors through `cliError` with a hint; `--json` field order fixed as in spec §7.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: integration branch `feat/agent-wait` from `origin/main` in `../agentglass-agent-wait`. Parallel tasks run in worktrees `../agentglass-agent-wait-t<N>` on `feat/agent-wait-t<N>` from `feat/agent-wait` at the wave start; each merges back (rebase, then fast-forward) in task-number order. One PR `feat/agent-wait` → `main`, rebase-merge after green CI.

## Waves (parallel vs sequential)

| Wave | Tasks | Run | Needs |
|---|---|---|---|
| 0 | T0 probes, baselines | alone | — |
| 1 | T1 normaliser + golden table · T2 overlap sweep | **parallel** | T0 |
| 2 | T3 period report · T4 live collection · T5 filter attributes · T6 OTLP attributes | **parallel** | T1 (T3 also T2's types only: `CallSpan`) |
| 3 | T7 rule metrics + built-in · T8 CLI `agentglass wait` · T9 Wait tab | **parallel** | T7: T4 · T8: T2, T3, T4 · T9: T2, T3, T4 |
| 4 | T10 fleet `pull --wait`, merge, host view | alone | T8, T9 |
| 5 | T11 footprint, golden, real-history cross-check, docs, final review | alone | T1–T10 |

Files per wave are disjoint except `src/main.ts` imports (one line each; keep both on merge) and `src/features/watchdog.ts` (T4 in wave 2, T7 in wave 3 — different waves).

## Review Focus

1. **Normaliser correctness on real shapes**: wrappers (`rtk`, `rtk proxy`, `flock <file>`, `timeout 600`, `env A=1`), heredocs inside the 200-char line, loops (`until …; do sleep 20; done`), pipes with filters (`cat x | python3 -`), package-manager scripts, runners (`npx`, `uv run --frozen`, `python3 -m`), `pnpm typecheck` (implicit run). The golden table (T1) is the contract; every changed line in it needs a reason in the commit.
2. **Sums are exact**: Σ family ms = Σ timed shell rows' ms; resumable stepping = one pass (T3). The overlap sweep equals the O(n²) brute force on seeded random sets (T2).
3. **No hidden-tab work, no per-tick history**: T9 check counts report steps while the tab is hidden (must be 0); T11 footprint run.
4. **Host-wide vs project scope**: in agent mode history is project-scoped, `now`/`--check` host-wide (T8 test asserts both).
5. **One notification per host** for three sessions in contention; alerts still on each row (T7).
6. **Privacy**: `--redact` hides generic (interpreter + script) family names; OTLP sends generic families only with `--detail meta`; `fleet pull --wait` carries no command line (T6, T8, T10 grep for fixture script names).

---

### Task 0: Worktree, probes, baselines

**Files:** none committed; findings go into the PR description as `Ruling:` lines.

- [ ] **Step 1: Worktree + build**: `git worktree add -b feat/agent-wait ../agentglass-agent-wait origin/main && cd ../agentglass-agent-wait && AGENTGLASS_OUT=$HOME/.cache/agentglass-agents/impl-wait/main-bin ./build.sh && sh scripts/check.sh`. Expected: build ok, every check `ok`. Keep `main-bin` as the golden reference (Task 11).
- [ ] **Step 2: Probe `os.loadavg()` / `os.cpus()`** (Open question 1): write `$C/probe.ts` = `import { loadavg, cpus } from "node:os"; console.log(String(loadavg()[0]) + " " + String(cpus().length));`, build with `scriptc build --optimization dev --strip $C/probe.ts -o $C/probe && $C/probe`, and once with `--backend c`. Expected: two numbers. Record per backend; Task 4 uses `/proc/loadavg` on Linux either way and `loadavg()` on macOS only where it built.
- [ ] **Step 3: Isolated index + 200-char share** (Open question 2): `S=$HOME/.cache/agentglass-agents/impl-wait/s; mkdir -p $S/run && chmod 700 $S/run`; run `nice -n 10 env AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp AGENTGLASS_FLEET_DIR=$S/fleet AGENTGLASS_HUB_DIR=$S/hub $C/main-bin --json --filter 'tool is Bash' --limit 1 > /dev/null` (indexes everything into `$S/cache`). Then count calls-file command texts of exactly 200 chars: `python3 -c "import json,glob,os;n=t=0
for f in glob.glob(os.path.expanduser('$S/cache/calls/*.json')):
  j=json.load(open(f));L=j.get('cmdl',[]);P=j.get('cmdp',[]);prev=''
  for p,r in zip(P,L): s=prev[:p]+r;prev=s;t+=1;n+=len(s)==200
print(n,t)"`. Expected: two numbers (literal texts only — hashed ones resolve through the ledger; the ratio is indicative). If > 2 %, write `Ruling: 200-char cut hides X % — note in Failure modes stays; per-row family hint deferred to the next VERSION bump`.
- [ ] **Step 4: Codex yielded exec** (Open question 3): `grep -rhoE 'yield_time_ms[^,}]{0,12}' ~/.codex/sessions --include=*.jsonl | sort | uniq -c | sort -rn | head -5` and, for one call with a large yield, compare its call → output timestamps with the `Wall time` in the output. Expected: whether the call ends at the yield. If yes, Task 3 marks such calls `bg` like `run_in_background`.
- [ ] **Step 5: Claude `eval` argv on macOS** (Open question 4): only if a macOS host is at hand (`ps -o args= -p <a claude Bash shell>`); else `Ruling: unverified, Task 4 falls back to the open call's command when no eval/-c is found`.
- [ ] **Step 6: Baseline for the cross-check**: `nice -n 15 python3 specs/agent-wait/measure.py 30 > $C/measure-30.txt` (read-only over `~/.claude/projects` and `~/.codex/sessions`, ~40 s, the script the spec's measurements came from). Task 11 compares kind totals with `agentglass wait --by kind --since 30d --json`.

---

### Task 1: Command families — normaliser, kinds, user rules, golden table — wave 1, parallel with T2

**Files:** Create `src/features/wait/family.ts`, `src/features/wait/family.check.ts`, `src/features/wait/families.golden`.

**Interfaces — Produces:**
```ts
export interface Fam { name: string; kind: string; heavy: boolean; generic: boolean }
export const SHELL_KINDS: string[];   // ["test","typecheck","lint","build","install","ci","wait","vcs","net","other"]
export const TOOL_KINDS: string[];    // ["user","wait","agent","web","mcp","file","other"]
export interface FamRule { words: string[]; rest: boolean; family: string; kind: string; heavy: number /* -1 unset, 0, 1 */ }
export interface WaitCfg { rules: FamRule[]; heavyKinds: string[]; minSec: number; diags: string[] }
export function parseWaitCfg(v: unknown): WaitCfg;         // the config section value; diags = one line per bad entry
export function waitCfg(): WaitCfg;                         // section("wait") parsed once (util/config.ts), diags said once
export function setWaitCfgForTest(c: WaitCfg | null): void;
export function familyOf(cmd: string, c: WaitCfg): Fam;     // one norm()ed command line (spec §1.1–1.7)
export function callFamily(cmds: string[], c: WaitCfg): Fam; // several commands of one call (§1.8); [] → {name:"sh",kind:"other"}
export function toolKind(tool: string): string;             // non-shell tools (§1.9)
export function toolFamily(tool: string): string;           // tool name; mcp__srv__x → "mcp srv"
// memo over call rows (§1.10): family id of row i of r (-1: the row has no shell command → use toolFamily of its tool)
export function rowFam(r: Rows, i: number): number;
export function famName(id: number): string; export function famKind(id: number): string; export function famHeavy(id: number): boolean; export function famGeneric(id: number): boolean;
export function famId(name: string): number;                // -1 unknown (filter attribute lookups)
```
Kind priority for §1.8: `c.heavyKinds` order, then `ci wait vcs net other`.

- [ ] **Step 1: Golden table** `src/features/wait/families.golden`, ≥ 200 lines, `command<TAB>family<TAB>kind`, `#` comments. Hand-written (no copies of real commands with paths or names from this machine; use `/w/app`, `acme`). Must include at least these lines (exact):
```
pnpm test	pnpm test	test
pnpm typecheck	pnpm typecheck	typecheck
pnpm run lint -- --fix	pnpm run lint	lint
npm run build	npm run build	build
npm ci	npm install	install
npx tsc --noEmit -p .	tsc	typecheck
cd /w/app && pnpm vitest run src/x.test.ts	pnpm vitest	test
rtk proxy pnpm test	pnpm test	test
flock -w 600 /tmp/acme-heavy.lock pnpm typecheck	pnpm typecheck	typecheck
timeout 600 cargo build --release	cargo build	build
RUST_LOG=info cargo test -p core	cargo test	test
uv run --frozen pytest -q tests/	pytest	test
python3 -m pytest -x	pytest	test
python3 - <<'EOF' import json print(1) EOF	python3	other
cat build.log | python3 -	python3	other
grep -rn TODO src	grep	other
git status --short	git status	vcs
gh run watch 123 --exit-status	gh run watch	ci
gh pr checks 12 --watch	gh pr checks	ci
until gh run view 1 --json status | grep -q completed; do sleep 20; done	gh run view	ci
sleep 30 && tail -5 /tmp/x.log	sleep	wait
for f in a b; do sed -n 1p $f; done	sed	other
./build.sh && sh scripts/check.sh	build.sh	build
sh scripts/check.sh	sh check.sh	test
node scripts/gen.js	node gen.js	other
make -j8 test	make test	test
just lint	just lint	lint
docker build -t x .	docker build	build
go test ./...	go test	test
go tool golangci-lint run	go tool golangci-lint	lint
biome check --write .	biome	lint
npx eslint .	eslint	lint
pnpm exec playwright test	playwright	test
bunx vitest	vitest	test
ssh host uptime	ssh	net
echo done	sh	other
export A=1; cd x	sh	other
```
- [ ] **Step 2: Failing check** `family.check.ts`: read the golden file (`readText`, relative to the check's source dir via `import.meta`-free path: `process.env.AGENTGLASS_SRC || "src"` + `/features/wait/families.golden`; `scripts/check.sh` runs checks from the repo root), run `familyOf(cmd, parseWaitCfg(undefined))` on each line, assert `name` and `kind`; plus:
  - user rules: `parseWaitCfg({families:[{match:"make *",family:"make $1",kind:"build"},{match:"./scripts/ci.sh ...",family:"ci.sh",kind:"test",heavy:true},{match:"pnpm run storybook:*",kind:"test"}]})` → `make docs` → `make docs`/build; `./scripts/ci.sh --fast x` → `ci.sh`/test heavy; `pnpm run storybook:test:dev` → `pnpm run storybook:test:dev`/test; rule order (first wins);
  - invalid entries: `{match:""}`, `{match:"x",kind:"nope"}`, `{family:"y"}`, `heavyKinds:["nope"]`, `minSec:-1` → each one diag, the valid rest kept, defaults for the bad scalars;
  - `callFamily(["git status","pnpm test"])` → `pnpm test`; `callFamily([])` → `sh`;
  - `toolKind`: `AskUserQuestion`→user, `TaskOutput`→wait, `Agent`→agent, `WebFetch`→web, `mcp__github__x`→mcp (`toolFamily` = `mcp github`), `Read`→file, `Foo`→other;
  - heavy: default kinds; `heavyKinds:["test"]` makes `tsc` not heavy;
  - 40-char cut; `REDACT` does not change `familyOf` (redaction is at display, `generic` flag set for `node gen.js` and `sh check.sh`).
  - memo: `rowsFrom` two rows with the same command id → `rowFam` equal ids, normaliser called once (counter exported for tests: `FAM_STATS.norm`).
  End with `console.log("family: all checks passed")`.
- [ ] **Step 3: Run** the single-check command on `src/features/wait/family.check.ts`. Expected: build FAIL (`family.ts` missing).
- [ ] **Step 4: Implement** `family.ts` per spec §1: quote-aware segment split (`'…'`, `"…"` kept whole), heredoc drop, word stripping, trivial/filter rules, family name rules, kind table as ordered `[kind, words[]]` arrays tested with word-anchored `indexOf` on the family name (` ` + name + ` ` contains ` ` + word + ` `, plus prefix tests for `test:*` / globs), `FamRule` matching (`*` one word with `$n` capture, trailing `...`, in-word `*` glob via a small matcher), memo `Float64Array` over `DICT.cmd` ids grown by doubling, `FAMS` dictionary (`newDict()` from `facts.ts`).
- [ ] **Step 5: Run** the check → `family: all checks passed`; `sh scripts/check.sh` PASS.
- [ ] **Step 6: Commit** `feat(wait): command families — normaliser, kinds, user rules, golden table`.

---

### Task 2: Overlap sweep (pure) — wave 1, parallel with T1

**Files:** Create `src/features/wait/overlap.ts`, `src/features/wait/overlap.check.ts`.

**Interfaces — Produces:**
```ts
// one heavy call: [t0, t1) epoch ms, group = family id, agent = session index (for the "agents at peak" figure)
export interface CallSpan { t0: number; t1: number; group: number; agent: number }
export interface GroupOverlap { group: number; n: number; peak: number; peakAt: number; peakAgents: number;
  atLeast: number[] /* ms with ≥ k concurrent, index 0 → k = 2 … index 6 → k = 8+ */;
  over: number /* calls ≥ 50 % covered by another call of the group */; overAny: number;
  slowdown: number /* p50(over) / p50(alone), -1 when either side < 10 */; slowdownAny: number;
  aloneP50: number; overP50: number; timeline: number[] /* max concurrency per bucket */ }
export const ALL = -2; // the group id of "all heavy calls"
export function overlap(spans: CallSpan[], from: number, to: number, bucketMs: number): GroupOverlap[]; // per group + ALL, groups by n desc
export function bucketFor(days: number): number; // ≤ 7 days 1 h, ≤ 30 days 6 h, else 1 day
```
p50 here = exact median of the durations (the spans are in memory), not the histogram.

- [ ] **Step 1: Failing check** `overlap.check.ts`: a seeded PRNG (`let x = 12345; next = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648`); 200 random sets of n ∈ [1, 400] spans over 6 h with 1–4 groups, durations 1 s–20 min; brute force: peak = max over all endpoints of the number of spans with `t0 ≤ t < t1`; `atLeast[k]` = Σ over elementary intervals between sorted endpoints; `over` per call = Σ of overlaps with every other same-group span merged as an interval union ≥ 50 % of its length. Assert equality for every group and `ALL`. Edge cases: equal endpoints (a span ending at t and one starting at t do not overlap), zero-length spans (ignored: never counted), one agent's two parallel spans (counted), a single span (peak 1, atLeast all 0, slowdown -1), slowdown with 9 vs 10 calls each side, timeline bucket boundaries. End with `overlap: all checks passed`.
- [ ] **Step 2: Run** → build FAIL.
- [ ] **Step 3: Implement**: endpoints sorted (ends before starts at equal times); one sweep keeps per-group counters and the open set per group (array of indexes, bounded by the peak); coverage per call: while sweeping, for each elementary interval add its length to every open call of the group when the group count ≥ 2 (O(n · peak)); `ALL` the same over all spans; medians by sorting the two duration lists.
- [ ] **Step 4: Run** → `overlap: all checks passed`; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(wait): overlap sweep — peak, time at ≥ k, overlapped calls, slowdown`.

---

### Task 3: Period report — wave 2, parallel with T4, T5, T6

**Files:** Create `src/features/wait/report.ts`, `src/features/wait/report.check.ts`.

**Interfaces — Consumes:** T1 (`rowFam`, `famKind`, `famHeavy`, `toolKind`, `toolFamily`, `waitCfg`), T2 (`CallSpan`, `overlap`, `bucketFor`), `callsIn` (`src/features/query/eval.ts:395`), `callsOf`, `ledger`, `Day.act` + `spanMin` (`record.ts:189`), `hb`/`HB`/`pct` (`calls.ts:21-35`), `localOf`/`dayKey`.
**Produces:**
```ts
export interface SlowCall { path: string; t: number; ms: number }
export interface WRow { key: string; kind: string; heavy: boolean; isTool: boolean; n: number; timed: number; ms: number; max: number;
  hist: number[]; err: number; agents: number; prevN: number; prevMs: number; slow: SlowCall[] }
export interface Split { activeMs: number; toolMs: number; userMs: number; pollMs: number; modelMs: number }
export interface WaitReport { since: number; until: number; prevSince: number; complete: boolean /* previous window inside retention */;
  fams: WRow[]; kinds: WRow[]; tools: WRow[]; split: Split; spans: CallSpan[]; sessions: number; bgCalls: number; done: boolean }
export interface WaitRun { /* opaque: queue of sessions, accumulators */ }
export function newWaitRun(f: Compiled, since: number, until: number): WaitRun;
export function stepWait(r: WaitRun, budgetMs: number): boolean;   // true = finished; reads one session at a time
export function waitResult(r: WaitRun): WaitReport;                  // after finished: rows sorted by ms desc
export function trendOf(w: WRow, complete: boolean): number | null; // ms / prevMs − 1, null if !complete or prevMs = 0
export function shareOf(w: WRow, s: Split): number;                  // ms / activeMs, 0 when activeMs = 0
```
- `fams`: shell calls by family; `tools`: non-shell calls by `toolFamily`; `kinds`: both by kind (shell kinds and tool kinds share names only for `wait` and `other` — one row each, summed).
- `spans`: heavy shell calls with `ms ≥ minSec × 1000` in `[since, until)` (input to `overlap`).
- `slow`: per family and tool the 10 longest calls `{path, t, ms}` (the Wait tab's ↵ list, T9).
- Background runs (`run_in_background`) are not marked in the call rows; history does not count them (the view says
  "background runs are not timed"). If Task 0 Step 4 finds a marker for Codex yielded calls, count those in `bgCalls`.

- [ ] **Step 1: Failing check** `report.check.ts` on fixture ledger entries (the `query/fixture.ts` helpers, `rowsFrom`, `bucket`, `addSpan` into `Day.act`): 3 sessions over 2 periods, shell rows with commands `pnpm test`, `npx tsc`, `git status`, `cat x | python3 -`, an `AskUserQuestion` row, a `TaskOutput` row, an untimed row (`ms = -1`), a failed row; assert:
  - Σ `fams[].ms` = Σ `ms` of timed shell rows (brute force over `callList`), Σ `n` = shell rows, Σ `err` = failed shell rows; same for `tools`; Σ `kinds` = Σ `fams` + Σ `tools`;
  - `split.toolMs` = brute-force union of `[t, t+ms]` per session; `userMs` = the AskUserQuestion row; `modelMs = activeMs − toolMs` (clamped);
  - trend: previous window partly before `callCutoff()` (`setCallDaysForTest(3)`) → `complete = false`, `trendOf = null`;
  - filter: `newWaitRun(compile(parse("repo is a")), …)` counts only that session's rows;
  - resumable: `stepWait(r, 0)` (one session per call) until done gives a report deep-equal (JSON) to one `stepWait(r, 1e9)`;
  - `spans` holds only heavy rows ≥ `minSec` (set `setWaitCfgForTest({…minSec: 10})`).
  End `report: all checks passed`.
- [ ] **Step 2: Run** → build FAIL.
- [ ] **Step 3: Implement**: the queue = sessions with a day bucket in either window (`rowsMayMatch` logic via `callsIn` with the union of both windows' day keys); per row: window by `t`, `rowFam`, accumulate; per session the union of spans (rows are in call order; sort a session's `[t0,t1]` only if out of order); `activeMs` from `spanMin(d.act) * 60000` for the window's days of the matching sessions (sessions selected by the filter's session clauses — `matchSession` semantics as Stats); `budgetMs` checked with `Date.now()` after each session.
- [ ] **Step 4: Run** → `report: all checks passed`; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(wait): period report — families, kinds, tools, agent-time split, trend`.

---

### Task 4: Live collection — wave 2, parallel with T3, T5, T6

**Files:** Create `src/features/wait/live.ts`, `src/features/wait/live.check.ts`; Modify `src/features/detect.ts:63-76` (`Cmd` gains `pid: number; args: string`; `toolCmds` fills them), `src/features/watchdog.ts:106-131` (after the session loop: `collectLive(watchedObs, now)`; the loop keeps each session's `Obs` in a local array — no second `observe`).

**Interfaces — Produces:**
```ts
export interface Run { path: string; h: string; family: string; kind: string; heavy: boolean; ageSec: number; rssKb: number; pid: number; bg: boolean }
export interface LiveWait { at: number; load1: number /* -1 unknown */; cpus: number; memAvailPct: number /* -1 unknown */; running: Run[] }
export const LIVE: { cur: LiveWait; want: number /* epoch ms until which host figures are read: set by the tab, --watch, rules */ };
export function shellCmd(args: string): string;   // eval '…' (Claude) → inner text, else text after " -c ", else ""
export function collectLive(obs: { s: Sess; o: Obs }[], kids: Map<number, Proc[]>, now: number): LiveWait;
export function heavyNow(lw: LiveWait, family: string, kind: string): Run[]; // filter for --check and the rule metrics
export function famCounts(rs: Run[]): string;    // "pnpm test ×2, tsc" (counts desc, then name), ≤ 60 chars
export function hostLoad(): { load1: number; memAvailPct: number }; // Linux /proc/loadavg + /proc/meminfo; macOS per Task 0 Step 2
```
- `rssKb` = Σ `rss` over the shell and its descendants (the `kids` map the tick built: `watchdog.ts:40` `kidsMap()`); `bg` = the session's `Acc.pend` holds no call whose `cmd` is non-empty; family memo keyed by `args` (≤ 512 entries, cleared when full).
- Fallback (spec §4): a watched session with a pid but no `Obs.cmds` and a non-empty `Acc.pend` call with a command, age < 24 h → `Run` with `rssKb = -1`, `pid = 0`.
- Host figures only when `LIVE.want > now` (cheap otherwise: no file read).

- [ ] **Step 1: Failing check** `live.check.ts`: `shellCmd` on (a) a Claude argv `/usr/bin/zsh -c source /h/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval 'pnpm test -- --run' \< /dev/null && pwd -P >| /tmp/claude-1-cwd` → `pnpm test -- --run`; (b) `bash -lc cargo build` → `cargo build`; (c) `eval 'echo '\''a b'\'' && tsc'` → `echo 'a b' && tsc`; (d) `/bin/sh` → `""`. `collectLive` with a fake tree (agent 100 → shell 200 (`eval 'pnpm test'`, rss 3000) → node 201 (rss 900000); agent 300 → shell 400 (`-c npx tsc`, rss 2000) → node 401 (rss 600000); agent 500 no shells but a pend call `pytest`) → 3 runs, `rssKb` 903000 / 602000 / -1, kinds test/typecheck/test, `bg` false where the session has a matching pend call and true for agent 100 without one. `famCounts` ordering and 60-char cut. `hostLoad` on a fixture string pair (export `parseLoad(loadavg: string, meminfo: string)`): `"5.04 5.92 4.64 2/10996 1"` + `MemTotal: 128137748 kB\nMemAvailable: 49274876 kB` → `5.04`, `38`. End `live: all checks passed`.
- [ ] **Step 2: Run** → build FAIL.
- [ ] **Step 3: Implement**; in `watchdog.ts` `tick()` collect `{s, o}` pairs and call `LIVE.cur = collectLive(pairs, lk.kids, now)` after the loop (one line plus the array push). `detect.ts` `toolCmds`: add `pid: c.pid, args: c.args` (no new reads).
- [ ] **Step 4: Run** live check + `src/features/watchdog.check.ts` (if present) + `sh scripts/check.sh` PASS. Measure the added tick cost: `AGENTGLASS_DEBUG_REFRESH=1` with `sh scripts/fixture-agents.sh start $C/fx --agents 36` and one isolated TUI for 60 s in a detached tmux pane; read `tick` ms from the debug footer before/after (main-bin vs branch). Expected: + ≤ 0.3 ms per tick. Stop the fixture agents (`fixture-agents.sh stop $C/fx`) and kill the tmux session you started.
- [ ] **Step 5: Commit** `feat(wait): live heavy commands per host from the alarm tick (RSS, load, memory)`.

---

### Task 5: Filter attributes `family`, `kind` — wave 2, parallel with T3, T4, T6

**Files:** Modify `src/features/query/attrs.ts:92-101` (two `r()` lines after `command`), `src/features/query/eval.ts` (the call-clause evaluator: the branch that reads `program`/`command` ids), `src/features/query/attrs.ts` enum list for `kind` = `SHELL_KINDS ∪ TOOL_KINDS`; Test `src/features/query/eval.check.ts` (append).

- [ ] **Step 1: Failing check** (append to `eval.check.ts`): fixture rows `pnpm test` (Bash), `git status` (Bash), `Read`; `family is "pnpm test"` matches row 1 only; `family ~ pnpm` row 1; `kind is test` row 1; `kind is file` row 3 (non-shell tools: kind from `toolKind`, family from `toolFamily`); `kind is_one_of test lint` row 1; `kind is nope` → parse/validation error listing the enum; `--help --format json` of `--filter` keys includes both (the attribute table is the source).
- [ ] **Step 2: Run** `eval.check.ts` → FAIL (unknown key `family`).
- [ ] **Step 3: Implement**: `r("family", [], "call", "text", false, [], "", [])`, `r("kind", [], "call", "enum", false, [...SHELL_KINDS, ...TOOL_KINDS minus duplicates], "", [])`; in the row evaluator `rowFam(r, i)` → `famName`/`famKind`, or `toolFamily`/`toolKind` of the row's tool when `-1`.
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh` PASS; `scripts/filter-cli.test.sh` unchanged PASS.
- [ ] **Step 5: Commit** `feat(query): call attributes family and kind`.

---

### Task 6: OTLP span attributes — wave 2, parallel with T3, T4, T5

**Files:** Modify `src/features/otlp/types.ts:16` (span gains `fam: string; fkind: string; fgen: boolean`), `src/features/otlp/build.ts:181` (set them from `familyOf(n0, waitCfg())` next to `sp.prog`), `src/features/otlp/encode.ts:120` (emit); Test `src/features/otlp/encode.check.ts` (append).

- [ ] **Step 1: Failing check**: a shell span with `pnpm test` → attributes `agentglass.tool.family = "pnpm test"`, `agentglass.tool.kind = "test"`; `node gen.js` with detail `none` → family `node` (generic reduced to its program), with `meta` → `node gen.js`; a `Read` span carries neither.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` PASS; `scripts/otlp-export.test.sh` PASS.
- [ ] **Step 5: Commit** `feat(otlp): agentglass.tool.family and agentglass.tool.kind on shell tool spans`.

---

### Task 7: Rule metrics `contention`, `contention_family` + disabled built-in — wave 3, parallel with T8, T9

**Files:** Modify `src/features/rules/config.ts:21-23` (`METRICS`, `UNITS` count, `PARAMS` `min_age` `["min_age","0","0","-1"]`, `DEFMSG`), `config.ts:165-174` (`builtins()` gains `contention`, `enabled: false`), `src/features/rules/metrics.ts` (two cases reading `LIVE.cur`), `src/features/rules/notify.ts:90-92` (throttle key), `src/features/rules/cli.ts` (`rules defaults --examples` prints the two examples), `src/features/watchdog.ts` (`ruleVals` passes the session path; sets `LIVE.want = now + 5000` when an enabled rule uses either metric); Test `src/features/rules/config.check.ts`, `metrics.check.ts`, `notify.check.ts` (append).

**Interfaces — Produces:** `export const HOST_METRICS = ["contention", "contention_family"]`; `throttleKey(r: Rule, s: Sess): string` = `r.id + "\t@host"` for host metrics, else `s.path`.

- [ ] **Step 1: Failing checks**: (config) built-ins list ends with `contention` disabled; `{ "rules": [{ "id": "contention", "enabled": true }] }` enables it with the built-in threshold 3, `for` 30 s; `metric: "contention_family"` with `degraded: 2` validates; `min_age: -1` → diag. (metrics) `LIVE.cur` with runs pnpm test ×2 (sessions A, B), tsc (C), git status (D, not heavy): `contention` A=3, B=3, C=3, D absent, E (no run) absent; `contention_family` A=2, C=1; `min_age 60` with ages 30/90/120 → counts only ≥ 60; `{cmd}` = `pnpm test ×2, tsc`. (notify) three transitions of `contention` for A, B, C at the same `at` → one bell/desktop call, three alert rows.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `scripts/rules*.test.sh` and `sh scripts/check.sh` PASS; `agentglass rules defaults` output unchanged except the new disabled entry (diff in the PR).
- [ ] **Step 5: Commit** `feat(rules): host-wide contention metrics and an opt-in contention rule`.

---

### Task 8: CLI `agentglass wait` — wave 3, parallel with T7, T9

**Files:** Create `src/features/wait/cli.ts`, `scripts/wait.test.sh`; Modify `src/features/cli.ts:76-89` (`addCmd(cmd("wait", …))` after `cost`), `src/main.ts` (import), `docs/cli-contract.md` (section `agentglass wait --json`), `scripts/contract.test.sh` (fields), `README.md` (CLI list).

**Interfaces — Produces:** `export function waitJson(rep: WaitReport, ov: GroupOverlap[], live: LiveWait | null, scope: Obj, by: string, limit: number): Obj` (the spec §7 object; T10 reuses it); `export const WAIT_FIELDS: string[]` (row fields, in order).

Options (`setOptions("wait", …)`, help via `optTable`): `--since` (default `7d`), `--by family|kind|tool` (family), `--filter` (repeatable, `cliFilter`), `--limit N` (20), `--json`, `--format table|json|csv`, `--fields`, `--now`, `--check`, `--family f`, `--kind k`, `--max N`, `--all-projects`, `--project-only`. Usage errors → `cliError("usage", …, 2)`.

- [ ] **Step 1: Failing test** `scripts/wait.test.sh` (pattern of `scripts/cost.test.sh`: fake HOME, `AGENTGLASS_BIN` or own build): one Claude session `/w/app` with 4 `Bash` tool_use/tool_result pairs (`pnpm test` 120 s ok, `pnpm test` 100 s failed, `npx tsc` 30 s, `git status` 1 s) and one `AskUserQuestion` (60 s), a second session `/w/lib` with `pnpm test` 90 s overlapping the first one; assert with `jq`:
  - `wait --json` → `.rows[0].key == "pnpm test"`, `.rows[0].calls == 3`, `.rows[0].totalMs == 310000`, `.rows[0].errors == 1`, `.rows[0].peak == 2`, `.agentTime.userMs == 60000`, `.guard == null`, field order of `.rows[0] | keys_unsorted` equals `WAIT_FIELDS`;
  - `--by kind` → a `test` row with 310000 and a `typecheck` row; `--by tool` → `AskUserQuestion` with kind `user`;
  - `--filter 'repo is lib'` → `pnpm test` calls 1;
  - `--now --json` → `.now.running == []` (no live agents in the fake HOME), no `.rows` key, exit 0;
  - `--check` → exit 0; `--check --max 0` → exit 2 (usage);
  - agent mode (`AGENTGLASS_AGENT=1`, cwd `/w/app` inside the fake HOME's project) → JSON by default, `.scope.project` set, rows only from `/w/app`, `.scope.now == "host"`;
  - `--since nope`, `--by x`, a stray argument → exit 2 with a hint;
  - text output: every line ≤ 80 columns (`awk 'length > 80'` empty, ANSI stripped);
  - `--help --format json` lists every field (contract test).
- [ ] **Step 2: Run** `sh scripts/wait.test.sh` → FAIL (unknown command wait).
- [ ] **Step 3: Implement** `cli.ts`: `discover()`, `cliFilter`, agent scope (`agentScope(args)` for history, never applied to `now`), `newWaitRun` + `stepWait(r, 1e9)`, `overlap(rep.spans, …)`, `LIVE` from one look (`looker()` + `observeWith` for live sessions + `collectLive`), `waitJson`, text table (columns per spec §6, quantiles via `fmtMs`), `--check` exit 3.
- [ ] **Step 4: Run** → PASS; `scripts/contract.test.sh`, `scripts/clihelp*`, `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(cli): agentglass wait — what agents wait on, contention, --now, --check`.

---

### Task 9: TUI Wait tab — wave 3, parallel with T7, T8

**Files:** Create `src/features/wait/tab.ts`, `src/features/wait/tab.check.ts`; Modify `src/main.ts` (import after `./features/repos/tab.ts` so the tab is 5th), `src/features/palette/actions.ts` (actions `wait.open`, `wait.today`, `wait.week`, `wait.month`, `wait.all`, `wait.view`), help section `wait` (`H.helpSections.push` in `tab.ts`).

**Behaviour:** spec §6. State `WV { period, view: "family"|"kind"|"tool", sort, sel, detail, run: WaitRun | null, rep, ov, at, ver }`. Report restarts on open, period/view-independent filter change, or (tab visible) `L.ver` changed and ≥ 30 s since `at`; `stepWait(run, 20)` once per render while running, progress line; `overlap()` once when the run finishes. `LIVE.want = now + 5000` on every render (host figures only while visible). Keys: `↑↓ jk pgup pgdn g G` select, `d w m a` period, `s` sort, `v` view, `↵` detail (the row's `slow` list from T3; ↵ on an entry opens that session's transcript at the call time, as Stats' drill `jump()` does), `esc` back, `t` triage (`openTriage` with selection `family is "<f>"`), `f` pin `family is "<f>"` as the Sessions local filter and `S.tab = 0`.

- [ ] **Step 1: Failing check** `tab.check.ts` (render into the screen buffer as `src/features/repos/tab.check.ts` does): fixture report + overlap + live; at 80×24 every line ≤ 80 columns, header line contains `7 days`, `now` line contains `pnpm test ×2`, table sorted by total; `s` cycles sort; `v` switches to kinds; tab hidden for 100 renders of another tab → `STEPS.n` (exported counter of `stepWait` calls) unchanged; visible with an unfinished run → one step per render; `?` help lists every key.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` PASS; manual: one isolated TUI (isolation set, detached tmux 80×24 then 200×50) on the real history, tab `5`, screenshot text via `tmux capture-pane -p`, kill the session. Expected: progress line, then the table; no line wraps at 80 columns.
- [ ] **Step 5: Commit** `feat(tui): Wait tab — families, kinds, tools, contention, live heavy commands`.

---

### Task 10: Fleet — `fleet pull --wait`, merge, per-host live — wave 4, alone

**Files:** Modify `src/features/fleet/pull.ts:33-60` (`--wait` flag; `pullReport` adds `wait: waitJson(…)` computed for `days`, unscoped), `src/features/fleet/serve.ts:55-73` (allow `--wait` for `pull`), `src/features/fleet/model.ts` (`HostReport.wait: Obj | null`), the report parser/codec in `src/features/fleet/report.ts` (line `{"wait": …}`), `src/features/fleet/ssh.ts` (append `--wait` while `WANT_WAIT.until > now`), `src/features/wait/tab.ts` + `src/features/wait/cli.ts` (`h` host toggle, `--fleet`); Create `src/features/wait/merge.ts` + `merge.check.ts`; Test `src/features/fleet/serve.check.ts`, `pull.check.ts` (append), `scripts/fleet.test.sh` (append).

**Interfaces — Produces:** `export function mergeWait(objs: Obj[]): Obj` — rows by key: sums of `calls timedCalls totalMs errors prevTotalMs agents`, `hist` bucket-wise, `p50Ms/p95Ms` recomputed with `pct` from the merged hist, `maxMs` max, `share` recomputed from merged `agentTime.activeMs`; `peak/peakAt/atLeast*/slowdown` set to `null` in merged rows (per host only).

- [ ] **Step 1: Failing checks**: `merge.check.ts` — two host objects whose rows' `hist` come from known duration lists → merged `hist` = hist of the concatenated list, `p95Ms` equal to `pct` of it, sums exact, peaks `null`; `serve.check.ts` — `fleet pull --wait` allowed, `fleet pull --wait --wait` refused, `fleet snapshot --wait` refused; `pull.check.ts` — `--wait` adds exactly one `wait` line after `allowance`, without it none; under `--redact` no fixture script name (`gen.js`) in the output.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `scripts/fleet.test.sh`, `scripts/fleet-serve.test.sh`, `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(fleet): wait report per host (fleet pull --wait), exact merge, per-host live`.

---

### Task 11: Footprint, golden, real-history cross-check, docs, final review — wave 5, alone

**Files:** Modify `README.md` (Wait tab, `agentglass wait`, contention rule, `wait` config), `docs/cli-contract.md` (if T8 left gaps), `specs/ROADMAP.md` (status: implemented, PR pending review); no source changes unless a check fails.

- [ ] **Step 1: Golden**: `AGENTGLASS_OUT=$C/branch-bin ./build.sh && nice sh scripts/golden-usage.sh $C/main-bin $C/branch-bin --warm`. Expected: `0 differences`.
- [ ] **Step 2: Real-history cross-check**: with the isolation set and `$S/cache` from Task 0, `nice $C/branch-bin wait --json --by kind --since 30d --limit 50 > $C/wait-30.json`; compare `test typecheck lint build install ci wait` totals with `$C/measure-30.txt` kinds. Expected: each within 2 %; a larger gap is explained in the PR (rows outside retention, 200-char cuts, untimed rows) with numbers. Also list the top 20 families side by side.
- [ ] **Step 3: Footprint** (`scripts/footprint.sh`, isolation set, `--warm $S/cache`, 160×45, nice): (a) Sessions tab, Wait never opened: `cpu_total_pct` and `rss_mb@end` within noise of main-bin (± 0.3 % CPU, ± 10 MB); (b) Wait tab open, 7 days: first report CPU (debug footer `wait <ms>` counter added in T9 under `AGENTGLASS_DEBUG_REFRESH=1`) ≤ 300 ms, every slice ≤ 20 ms, RSS + ≤ 15 MB vs (a); (c) `m`/`a` (30 / 90 days): ≤ 2 s CPU, RSS + ≤ 40 MB; (d) 36 fixture agents (`scripts/fixture-agents.sh start $C/fx --agents 36`): tick + ≤ 0.3 ms. Record the numbers in the PR; any miss is fixed before review (T3/T9 are the levers: per-family accumulators, fewer allocations per row).
- [ ] **Step 4: Live contention, real**: extend `scripts/fixture-agents.sh` with `--heavy n` (n of the agents get one
  extra child `sh -c "eval 'pnpm test' ; exec sleep 600"`-shaped: argv contains `eval 'pnpm test'`, the process is a
  plain `sleep`); `sh scripts/fixture-agents.test.sh` stays green. Run `fixture-agents.sh start $C/fx --agents 6
  --heavy 3`, one isolated TUI on the fixture HOME, Wait tab. Expected: `now  3 heavy: pnpm test ×3`; with
  `{"rules":[{"id":"contention","enabled":true}]}` in `$S/rules.json` and `AGENTGLASS_NOTIFY=0`: after 30 s one toast
  and three rows flagged; `wait --check --kind test` (isolation set, same HOME) exits 3, `--max 4` exits 0. Stop the
  fixtures, kill your tmux session.
- [ ] **Step 5: Docs**: README section "What do my agents wait on?" (tab, CLI, config example, contention rule, the agent recipe `agentglass wait --check --kind test`, the `flock` recipe for serialising heavy runs); help texts checked at 80 columns.
- [ ] **Step 6: Final review**: `superpowers:requesting-code-review` over the whole branch against Review Focus 1–6; fix findings; `sh scripts/check.sh` PASS; open the PR `feat/agent-wait` → `main` with the measurements of Steps 1–4 and all `Ruling:` lines.
- [ ] **Step 7: Commit** `docs(wait): README, contract, roadmap status`.
