# Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "What is different about these?" The user picks a selection (preset or filter expression). agentglass ranks the attribute values that are over- or under-represented in it against a baseline (`rest`, `previous` period, or an explicit `group`). One key includes or excludes a value in the origin tab's filter.

**Architecture:** Triage adds scoring and a view on top of filter-language's engine. It adds no attributes and no aggregation of its own. `src/features/triage/score.ts` holds share difference, lift, 2×2 χ² with Yates, ranking and caps. `src/features/triage/run.ts` builds the two groups with `aggregate()`/`aggregateWhere()`/`minus()` and decides the guards. `src/features/triage/view.ts` is a full-screen `H.views` view opened with `t`. `src/features/triage/cli.ts` is `agentglass triage`.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7, no runtime deps; scriptc checks (`*.check.ts`) and a shell test.

**Spec:** [spec.md](spec.md). Read it first; it is the binding authority. Engine contract: [../filter-language/plan.md](../filter-language/plan.md), Tasks 5–9 "Produces".

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`. A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)`; nominal typing; optional function members via a local; out-of-range array reads trap; SC2003 (no zero-parameter arrow for an optional member); static builds lack `Math.sqrt`/`Math.log`/`Math.pow`. Statistics use only `+ − × ÷`, `Math.abs`, `Math.max`.
- Significance: `χ² ≥ 6.63` (constant `CHI_SIG`), Yates-corrected 2×2, never computed for weighted runs. It only **marks** rows (`●`); it never hides or reorders them.
- Config (`~/.agentglass/config.json`, section `triage`): `longCall` (duration, default `30s`; a number = seconds), `expensiveUsd` (number > 0, default 5), `minSupport` (integer ≥ 1, default 3). An invalid value falls back to the default with one startup toast.
- Keys live in their modes (`src/input.ts` + `H.keys`): `t` in list mode on the Sessions tab, the Stats tab and the Stats drill-down. Inside the view: `↑↓ enter + - p o b e c u s d w m r R esc` and `1`…`7` in the preset picker. Help and footer list them.
- `--redact`: every value shown passes `display()`; CLI text lines pass `screenOut()`.
- No network; reads only the ledger.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-triage`, branch `feat/triage`, PR to `main`, rebase-merge after green CI. **Phase 4.** Requires **filter-language merged** (phase 2). otlp-export (phase 3) is independent of triage; rebase onto it if it merged first. session-compare (same phase) depends on this plan's `openTriage` and `score()`, so merge triage first.

## Review Focus

1. **A "rest" baseline that is not exactly scope − selection** when the selection has several clauses (no OR in the grammar). It must come from `minus(aggregate(scope), aggregate(scope ∧ sel))`, never from a negated expression. Pinned by `run.check.ts` "rest = scope − selection, two-clause selection" in Task 2.
2. **False positives at 6.63 on a uniform fixture.** No row may be marked when nothing is planted. Pinned by `run.check.ts` "no planted pattern" in Task 2.
3. **`slow` with untimed calls** (fx, kiro, unfinished calls) must be excluded from both groups, not counted as fast. Pinned by `run.check.ts` "slow excludes untimed" in Task 2.
4. **`+`/`-` landing in the wrong scope** (pins instead of the origin tab, or lost on esc). The clause must survive leaving triage and go through the merge rules. Pinned by `view.check.ts` "include persists in origin" in Task 5.
5. **The empty-baseline guard when the pinned scope already fixes the selection.** `r` must change only the triage scope; `R` must change the origin/pins. Pinned by `view.check.ts` "r local, R real" in Task 5.

---

### Task 0: Worktree, prerequisites, probes

The spec's "Open questions (to verify during implementation)" says **None**. The probes check the engine contract this plan consumes.

- [ ] **Step 1: Worktree + build.** `git worktree add -b feat/triage ../agentglass-triage main && cd ../agentglass-triage && ./build.sh && sh scripts/check.sh` → all ok.
- [ ] **Step 2: Engine present.** `grep -n "export function aggregate\b\|export function aggregateWhere\|export function minus\|export function totals\|export function eachCall\|export function compile\|export function setLocal\|export function addClause\|export function statsPeriod\|export function statsDrillTool\|export function callCutoff" src/features/query/*.ts src/features/usage/stats.ts` → every name found with the signature from filter-language's plan (Tasks 5–9 "Produces"); these are the names used below. A missing name means filter-language is not merged yet: stop.
- [ ] **Step 3: Fixture helpers present.** `grep -n "export function fxSession\|export function fxBase\|export function isoAt" src/features/query/fixture.ts` → found.
- [ ] **Step 4: Session start.** `grep -n "t0" src/features/usage/record.ts` → `Acc.t0` exists (session `hour`/`weekday` = start, spec decision 3).
- [ ] **Step 5: Keys free.** `grep -n "\"t\"" src/input.ts src/features/*.ts src/features/*/*.ts` → only transcript-mode `t` (`input.ts:97`) and nothing in list mode or the Stats tab. If something took `t` in list mode since, stop and ask.

---

### Task 1: Scoring

**Files:** Create `src/features/triage/score.ts`, `src/features/triage/score.check.ts`.

**Interfaces — Produces (session-compare consumes `score`, `chi2`, `CHI_SIG`):**
```ts
export const CHI_SIG = 6.63;
export interface Score { a: number; A: number; b: number; B: number; pS: number; pB: number; diff: number /* pS − pB */; lift: number /* pS / pB; -1 = "new" (b = 0) */; chi2: number /* -1 = not computed (weighted) */; sig: boolean }
export function chi2(a: number, A: number, b: number, B: number): number;   // Yates; 0 when a margin is 0
export function score(a: number, A: number, b: number, B: number): Score;   // count weight
export function wscore(a: number, wa: number, WA: number, wb: number, WB: number): Score; // weight shares; a = support (rows), chi2 -1, sig false
export interface TRow { attr: string; value: string; s: Score }
// rows with a ≥ minSupport and pS ≥ 1% (file: a ≥ 5); ordered by diff desc (under: asc); at most `cap` per attr unless attr = expand
export function rank(rows: TRow[], under: boolean, cap: number, minSupport: number, expand: string): TRow[];
export function fmtLift(s: Score): string;   // "×5.6", "new", "×0.4"
export function fmtPct(p: number): string;   // "34.2%"
```
- [ ] **Step 1: Failing check** `score.check.ts`. The expected numbers were computed by hand with the spec formula `χ² = N(|ad − bc| − N/2)² / ((a+b)(c+d)(a+c)(b+d))`, `c = A − a`, `d = B − b`, `N = A + B`, with `|ad − bc| − N/2` clamped at 0:
```ts
// agentglass — triage scoring: scriptc build src/features/triage/score.check.ts -o tsc && ./tsc
// SPDX-License-Identifier: Apache-2.0
import { chi2, score, wscore, rank, fmtLift, fmtPct, CHI_SIG, type TRow } from "./score.ts";
let bad = 0;
function near(w: string, got: number, want: number): void { if (Math.abs(got - want) > 1e-4) { bad++; console.log("FAIL " + w + ": got " + got + " want " + want); } }
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
near("chi2 planted", chi2(30, 100, 50, 1000), 80.586121);
near("chi2 equal shares → 0 (clamped)", chi2(10, 100, 100, 1000), 0);
near("chi2 b = 0", chi2(5, 10, 0, 100), 41.490952);
near("chi2 tiny N", chi2(3, 5, 1, 10), 2.088068);
near("chi2 npm example", chi2(34, 100, 6, 100), 22.78125);
near("chi2 B = 0 → 0", chi2(3, 10, 0, 0), 0);
const s = score(30, 100, 50, 1000);
near("pS", s.pS, 0.3); near("pB", s.pB, 0.05); near("diff", s.diff, 0.25); near("lift", s.lift, 6);
eq("sig", String(s.sig), "true"); eq("lift fmt", fmtLift(s), "×6.0");
eq("new when b = 0", fmtLift(score(5, 10, 0, 100)), "new");
eq("tiny N not significant", String(score(3, 5, 1, 10).sig), "false");
eq("threshold", String(CHI_SIG), "6.63");
const w = wscore(4, 30, 100, 10, 200);   // 4 rows, 30% of selection cost vs 5% of baseline cost
near("weighted diff", w.diff, 0.25); eq("weighted no chi2", String(w.chi2), "-1"); eq("weighted not sig", String(w.sig), "false");
eq("pct", fmtPct(0.342), "34.2%");
// ranking: significant and non-significant rows in one list by diff; 3 per attr; support and 1% floor; under flips
const R = (attr: string, value: string, a: number, A: number, b: number, B: number): TRow => ({ attr, value, s: score(a, A, b, B) });
const rows: TRow[] = [R("program", "npm", 34, 100, 6, 100), R("program", "git", 20, 100, 18, 100), R("program", "ls", 10, 100, 9, 100), R("program", "make", 9, 100, 2, 100),
  R("branch", "wip", 3, 100, 1, 100), R("ext", "md", 2, 100, 0, 100), R("hour", "14", 1, 200, 0, 100), R("file", "/a", 4, 100, 0, 100), R("program", "cargo", 0, 100, 40, 100)];
eq("rank", rank(rows, false, 3, 3, "").map((r) => r.value).join(","), "npm,make,git,wip");
eq("expand lifts the cap", rank(rows, false, 3, 3, "program").map((r) => r.value).join(","), "npm,make,git,wip,ls");
eq("under-represented", rank(rows, true, 3, 3, "").map((r) => r.value).slice(0, 1).join(","), "ls");
```
Expected order: the diffs are npm .28, make .07, git .02, wip .02 and ls .01. git and wip tie on diff; git comes first because of its larger support. wip is listed although it is not significant. Program reaches its cap of 3 before ls. `ext md` fails support (a 2 < 3). `hour 14` fails support and the 1% floor. `file /a` fails the file support of 5. `cargo` (a = 0) fails support. With `under` (ascending diff) `ls` comes first.
- [ ] **Step 2: Run** `scriptc build src/features/triage/score.check.ts -o /tmp/tsc && /tmp/tsc` → BUILD FAIL.
- [ ] **Step 3: Implement.**
```ts
export function chi2(a: number, A: number, b: number, B: number): number {
  const c = A - a; const d = B - b; const N = A + B;
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  if (den <= 0) return 0;
  const x = Math.max(0, Math.abs(a * d - b * c) - N / 2);
  return (N * x * x) / den;
}
export function score(a: number, A: number, b: number, B: number): Score {
  const pS = A > 0 ? a / A : 0; const pB = B > 0 ? b / B : 0; const x = chi2(a, A, b, B);
  return { a, A, b, B, pS, pB, diff: pS - pB, lift: b === 0 ? -1 : pS / pB, chi2: x, sig: x >= CHI_SIG };
}
```
`rank`: filter by support (`a >= (attr === "file" ? Math.max(5, minSupport) : minSupport)`) and `pS >= 0.01`. Sort by `diff` (desc, or asc for `under`), ties by `a` desc then value. Count per attr and keep ≤ `cap` unless `attr === expand`. `fmtLift`: `-1` → `new`, else `"×" + lift.toFixed(1)`.
- [ ] **Step 4: Run** → `triage scoring: all checks passed`; suite ok.
- [ ] **Step 5: Commit** `feat(triage): share-difference scoring with Yates chi-square marks`.

---

### Task 2: Triage runs — groups, presets, slow, baselines, guards

**Files:** Create `src/features/triage/run.ts`, `src/features/triage/run.check.ts`.

**Interfaces — Consumes:** `compile`, `Compiled`, `EMPTY`, `eachCall`, `callCutoff` (eval.ts); `aggregate`, `aggregateWhere`, `minus`, `Dist`, `Weight` (agg.ts); `parse`, `print`, `Clause` (parse.ts/types.ts); `pct`, `HB` (calls.ts); `lastDays`, `L` (record.ts); `section` (config.ts); `score`, `wscore`, `rank`, `TRow` (Task 1).
**Produces (session-compare and the view consume these):**
```ts
export type Base = "rest" | "previous" | "group";
export type Guard = "" | "empty-baseline" | "empty-selection" | "small-sample" | "retention";
export interface Run {
  entity: "call" | "session"; scope: Clause[]; sel: Clause[]; slow: boolean; preset: number /* 1..7, 0 = from origin */;
  base: Base; group: Clause[] /* base "group" only */; days: number /* period length: 1, 7 or 30 */; weight: Weight; under: boolean;
  origin: string /* "Sessions" | "Stats" | "Compare" */; dropped: Clause[] /* removed by `r` for this triage only */;
}
export interface Result {
  key: string; selN: number; baseN: number; rows: TRow[] /* every scored (attr, value) of the used dims, before support filter and ranking (rank() applies both) */; guard: Guard; small: boolean;
  offending: Clause[]; partial: boolean; from: string; to: string; unpriced: number; selLabel: string; baseLabel: string; dimsUsed: string[];
}
export interface Preset { n: number; name: string; entity: "call" | "session"; sel: () => Clause[]; slow: boolean; base: Base }
export const PRESETS: Preset[];                    // spec §2 table, 1..7 (7 = custom: sel from the typed expression)
export function newRun(origin: string, entity: "call" | "session", scope: Clause[], sel: Clause[], days: number): Run;
export function runTriage(r: Run): Result;         // cached per (key, L.ver); recomputed at most every 2 s while the ledger grows
export function dimsFor(r: Run): string[];         // spec §3 lists; `status` only when the selection does not fix it
export function periodOf(days: number, previous: boolean): string[]; // local day keys oldest first
export function triageCfg(): { longCall: string; expensiveUsd: number; minSupport: number };
```
Group construction (one place, `groups(r)`):
- `F(cs) = compile(cs, "stats").f ?? EMPTY` (clauses are already valid: they come from parsed input or presets). `scopeF = F(scope − dropped)`, `selF = F(scope − dropped ∧ sel)`.
- **rest**: `sel = aggregate(selF, …)`, `base = minus(aggregate(scopeF, …), sel)`.
- **previous**: `sel = aggregate(selF, entity, periodOf(days, false), …)`, `base = aggregate(selF, entity, periodOf(days, true), …)`. With an empty `sel` (preset 6), `selF = scopeF`.
- **group**: `base = aggregate(F(scope ∧ group), …)` on the same period.
- **slow** (preset 2, call entity, rest only): first `aggregate(scopeF, "call", days, ["tool"], "count")`, then `p90[tool] = pct(bin.hist, 0.9, bin.max)`. `timed = aggregateWhere(scopeF, days, dims, w, (s, c) => c.ms >= 0)`, `slowD = aggregateWhere(scopeF, days, dims, w, (s, c) => c.ms >= 0 && c.ms >= p90(tool of c))`, `base = minus(timed, slowD)`.
- Group sizes: `selN`/`baseN` = `Dist.total` of the first dim (every dim has the same row total).
- Guards, in order: `B = 0` and `A > 0` → `empty-baseline`, `offending` = clauses of `scope − dropped` whose key equals a key in `sel` (or `status` for preset 1/2/3). `A = 0` → `empty-selection`. Entity call with `previous` and the previous period starting before `callCutoff()` → `retention`. `A < 20 || B < 20` → `small = true` (shown as a banner, rows still computed).
- Skip dims whose value set has one key in both groups.
- `partial = L.done < L.total`. Weighted runs use `wscore`. Count runs use `score`.
- `unpriced` = `Dist.unpriced` of the selection (session entity, cost weight).

- [ ] **Step 1: Failing check** `run.check.ts`. Planted fixture, built with `fxSession` from filter-language (`fixture.ts`):
```ts
// 200 codex shell calls today in one session: 20 errors (6 npm + 14 ls), 180 ok (4 npm + 176 ls) → npm 30% of errors vs 2.2% of rest
function codexCalls(spec: [string, boolean][]): string[] {
  const out: string[] = ["{\"timestamp\":\"" + isoAt(0, 10, 0) + "\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5\"}}"];
  let i = 0;
  for (const [cmd, fail] of spec) {
    i++; const ts = isoAt(0, 10, 0); const id = "c" + String(i);
    out.push("{\"timestamp\":\"" + ts + "\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"bash\\\",\\\"-lc\\\",\\\"" + cmd + "\\\"]}\",\"call_id\":\"" + id + "\"}}");
    out.push("{\"timestamp\":\"" + ts + "\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"" + id + "\",\"output\":\"" + (fail ? "Process exited with code 1" : "ok") + "\"}}");
  }
  return out;
}
function many(cmd: string, fail: boolean, n: number): [string, boolean][] { const o: [string, boolean][] = []; for (let i = 0; i < n; i++) o.push([cmd, fail]); return o; }
fxReset();
fxSession("codex", "p1", "/w/p", "", "gpt-5", codexCalls(many("npm test", true, 6).concat(many("ls", true, 14), many("npm test", false, 4), many("ls", false, 176))));
const r1 = runTriage(newRun("Stats", "call", [], parse("status is error").cs, 1));
eq("sizes", r1.selN + "/" + r1.baseN, "20/180");
const top = rank(r1.rows, false, 3, 3, "");
eq("planted program npm first", top.length ? top[0].attr + " " + top[0].value : "none", "program npm");
eq("npm marked", top.length ? String(top[0].s.sig) : "", "true");
eq("single-valued dims skipped", r1.dimsUsed.indexOf("harness") < 0 && r1.dimsUsed.indexOf("tool") < 0 ? "ok" : r1.dimsUsed.join(","), "ok");
eq("status not a dim when fixed", r1.dimsUsed.indexOf("status") < 0 ? "ok" : "status present", "ok");
eq("under: ls first", rank(r1.rows, true, 3, 3, "")[0].value, "ls");
// no planted pattern: 20 errors (1 npm + 19 ls), 180 ok (9 npm + 171 ls) → nothing marked
fxReset();
fxSession("codex", "p2", "/w/p", "", "gpt-5", codexCalls(many("npm test", true, 1).concat(many("ls", true, 19), many("npm test", false, 9), many("ls", false, 171))));
const r2 = runTriage(newRun("Stats", "call", [], parse("status is error").cs, 1));
eq("no planted pattern", r2.rows.filter((r) => r.s.sig).length === 0 ? "ok" : r2.rows.filter((r) => r.s.sig).map((r) => r.attr + " " + r.value).join(","), "ok");
// rest = scope − selection, two-clause selection (no OR in the grammar)
fxReset(); fxBase();
const r3 = runTriage(newRun("Stats", "call", [], parse("tool is Bash and status is error").cs, 2));
eq("rest = scope − selection, two-clause selection", r3.selN + "/" + r3.baseN, "1/9");
// empty baseline: scope already says status is error
const r4 = runTriage(newRun("Stats", "call", parse("status is error").cs, parse("status is error").cs, 2));
eq("empty-baseline guard", r4.guard, "empty-baseline"); eq("offending", print(r4.offending), "status is error");
const r5 = newRun("Stats", "call", parse("status is error").cs, parse("status is error").cs, 2); r5.dropped = r4.offending;
eq("dropping lifts the guard", runTriage(r5).guard, "");
eq("empty selection", runTriage(newRun("Stats", "call", [], parse("tool is Nope").cs, 2)).guard, "empty-selection");
eq("small sample flag", String(r3.small), "true");
// slow: per-tool p90, untimed excluded from both groups (fxBase: Bash 2 timed + 1 untimed; kiro shell untimed)
const rs = newRun("Stats", "call", [], [], 2); rs.slow = true; rs.preset = 2;
const rsr = runTriage(rs);
eq("slow excludes untimed", String(rsr.selN + rsr.baseN), "8");   // 10 calls − Bash sleep (untimed) − kiro shell (untimed)
// previous period: calls yesterday vs today
const rp = newRun("Stats", "call", [], [], 1); rp.base = "previous"; rp.preset = 6;
eq("previous", runTriage(rp).selN + "/" + runTriage(rp).baseN, "8/2");
// session entity: hour is the start hour
const rh = runTriage(newRun("Sessions", "session", [], parse("cost is unknown").cs, 2));
eq("session hour = start", rh.rows.filter((r) => r.attr === "hour").map((r) => r.value).join(","), "10");
// group baseline (compare's t)
const rg = newRun("Compare", "call", [], parse("harness is claude").cs, 2); rg.base = "group"; rg.group = parse("harness is codex").cs;
eq("group baseline sizes", runTriage(rg).selN + "/" + runTriage(rg).baseN, "7/2");
// config fallbacks
eq("cfg defaults", JSON.stringify(parseTriageCfg({ longCall: "abc", expensiveUsd: -1, minSupport: 1.5 })), "{\"longCall\":\"30s\",\"expensiveUsd\":5,\"minSupport\":3,\"warn\":\"config triage.longCall, triage.expensiveUsd, triage.minSupport invalid — using defaults\"}");
```
`parseTriageCfg(o: Obj): { longCall, expensiveUsd, minSupport, warn }` is exported for the check. `triageCfg()` caches it and shows `warn` once.
Check the sizes against filter-language's `fxBase` table before running: today 8 calls (Bash 3, Edit 1, Grep 1, exec 1, shell 2… = 3+1+1+1+1+1 = 8), yesterday 2 Read; claude rows 7, codex 2, kiro 1. With `rest` and `tool is Bash and status is error`: selection 1, base 10 − 1 = 9.
- [ ] **Step 2: Run** `scriptc build src/features/triage/run.check.ts -o /tmp/trc && /tmp/trc` → BUILD FAIL.
- [ ] **Step 3: Implement `run.ts`** per the group construction above. Presets:
  - 1 `errored calls`: call, `status is error`, rest.
  - 2 `slow calls`: call, slow, rest.
  - 3 `long calls`: call, `duration > <longCall>`, rest.
  - 4 `expensive sessions`: session, `cost > <expensiveUsd>`, rest.
  - 5 `failing sessions`: session, `error_rate > 20% and tools >= 10`, rest.
  - 6 `this period vs last`: call (the view's `e` toggles session), no selection, previous.
  - 7 `custom`: typed expression, rest.
  Dims per spec §3. Call: `tool server program ext model repo harness agent hour weekday branch status file`. Session: `harness repo model agent branch tool program ext weekday hour state subagent`. Cache: `Map<string, { ver: number; at: number; res: Result }>`, keyed by `JSON.stringify([entity, print(scope − dropped), print(sel), slow, base, print(group), days, weight])`. A hit is used if `ver === L.ver`, or if `Date.now() - at < 2000` while `L.done < L.total`.
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(triage): selection vs baseline runs — presets, slow per tool, previous, group, guards`.

---

### Task 3: CLI `agentglass triage`

**Files:** Create `src/features/triage/cli.ts`, `scripts/triage-cli.test.sh`; Modify `src/main.ts` (import), `src/features/cli.ts:15-26` (CMDS row `agentglass triage [opts]`).

**Interfaces — Consumes:** `runTriage`, `newRun`, `PRESETS`, `rank`, `fmtLift`, `fmtPct` (Tasks 1–2); `parse`, `caret`, `addAll`; `complete` (hooks.ts). **Produces:** `H.cli` handler for `args[0] === "triage"`. It writes text or JSON and exits 0 (guards included) or 2 (bad expression/option).

CLI contract (spec §6). `--select '<expr>' | --preset errors|slow|long|expensive|failing|period`; `--filter '<scope>'` (repeatable); `--baseline rest|previous`; `--entity call|session`; `--days N` (integer ≥ 1); `--weight count|cost|tokens|duration`; `--limit N` (default 20); `--json`. Defaults: entity from the preset, else call; days 7; no select and no preset → preset `period`. `complete(s)` runs first for every session passing the cheap session clauses of the scope. JSON:
```json
{"entity":"call","period":{"from":"2026-09-26","to":"2026-10-02"},"selection":{"expr":"status is error","n":812},"baseline":{"mode":"rest","expr":"","n":41377},
 "rows":[{"attr":"program","value":"npm","sel":{"n":278,"share":0.342},"base":{"n":2524,"share":0.061},"diff":0.281,"lift":5.6,"chi2":412.1,"significant":true}],"guard":null}
```
`lift` is `null` for "new". `chi2` is `null` when weighted. `guard` is `null` or `"empty-baseline" | "empty-selection" | "small-sample" | "retention"`. Text: the aligned table from spec §5 without bars when stdout is not a TTY. No ANSI when not a TTY.

- [ ] **Step 1: Failing shell test** `scripts/triage-cli.test.sh`. Use the temp-HOME layout of `scripts/filter-cli.test.sh` (filter-language Task 10) with one Claude session made today: 3 Bash `npm test` calls that error, 1 Bash `ls` ok, 6 Read ok (10 calls, so `npm` passes min support 3):
```sh
ag triage --preset errors --days 1 --json > "$T/out.json"
grep -q '"selection":{"expr":"status is error","n":3}' "$T/out.json" || { echo "FAIL selection"; cat "$T/out.json"; exit 1; }
grep -q '"guard":"small-sample"' "$T/out.json" || { echo "FAIL guard"; exit 1; }
grep -q '"attr":"program","value":"npm"' "$T/out.json" || { echo "FAIL npm row"; exit 1; }
ag triage --preset errors --days 1 | grep -q $'\033' && { echo "FAIL ansi without tty"; exit 1; }
set +e; ag triage --select 'tol is x' >/dev/null 2>&1; rc=$?; set -e; [ $rc = 2 ] || { echo "FAIL rc $rc"; exit 1; }
[ "$(ag triage --filter 'status is error' --preset errors --days 1 --json | grep -o '"guard":"[a-z-]*"')" = '"guard":"empty-baseline"' ] || { echo "FAIL empty-baseline"; exit 1; }
echo "triage cli: all checks passed"
```
`grep -q $'\033'` needs bash. Use `printf '\033'` into a variable for POSIX sh: `ESC=$(printf '\033'); ag … | grep -q "$ESC" && …`.
- [ ] **Step 2: Run** `./build.sh && sh scripts/triage-cli.test.sh` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh` ok.
- [ ] **Step 5: Commit** `feat(triage): agentglass triage CLI (text table, --json, guards as answers)`.

---

### Task 4: Triage view — render and navigation

**Files:** Create `src/features/triage/view.ts`, `src/features/triage/view.check.ts`; Modify `src/main.ts` (import).

**Interfaces — Consumes:** Tasks 1–2; `box`, `put`, `gauge`, `spin` (screen.ts); `C`, `fg`, `bg`, `RST`, `CSI` (theme.ts); `display` (hooks.ts); `chips`/`print`. **Produces:**
```ts
export const TV_NAME = "triage";
export interface TState { run: Run; res: Result | null; sel: number; top: number; expand: string; picker: boolean; calls: string /* attr\tvalue whose newest calls are listed, "" none */; csel: number; back: () => void }
export const T: { st: TState | null };
export function openTriage(r: Run, back: () => void): void;   // S.fview = "triage", S.mode = "view"; back() runs on esc (session-compare passes its own)
export function viewLines(st: TState, W: number, H: number): string[];   // plain (ANSI-stripped) lines, for checks
```
Layout (spec §5): header line `triage · <selLabel> (<selN>) vs <baseLabel> (<baseN>) · <period> · scope: <chips>`, with `b <base> · e <entity> · c <weight>` right-aligned. Below it a column header `attribute  value  selection  baseline  lift  χ²`. Rows: `gauge(pS/maxP, bw)` in accent and `gauge(pB/maxP, bw)` dim, shares, `fmtLift`, `●` + χ² (rounded, 1 decimal under 10) or χ² alone. A weighted run shows `weighted, no significance` in the χ² column header. Multi-valued dims get the note `of calls with ≥ 1 <dim>` in the attribute cell of their first row. Banners: `small sample: N rows, percentages are unreliable`, `partial` + `spin()` while indexing, `+N unpriced` (cost weight). A guard replaces the table with its text and key (spec §4.5 texts verbatim). Below 100 columns the χ² column is dropped; below 80 the baseline bar too.
Keys (mode `"view"`, `S.fview === "triage"`): `↑↓ j k` move, `enter` expands the attr (`expand = attr`; enter again on an expanded value → `calls`), `b` cycles rest → previous → group (group only when `run.group.length`), `e` toggles entity (forces preset-compatible selection: session presets ↔ call presets keep `sel`), `c` cycles count → cost → tokens (session) / count → duration (call), `u` flips under, `s` opens the preset picker (`1`…`7`), `d`/`w`/`m` period 1/7/30, `esc` → `back()`.

- [ ] **Step 1: Failing check** `view.check.ts` (`fxBase()`, then `openTriage(newRun("Stats", "call", [], parse("status is error").cs, 2), () => {})`):
```ts
const st = T.st;
if (!st) { bad++; console.log("FAIL no triage state"); } else {
  const L0 = viewLines(st, 120, 30);
  eq("header", (L0[0] ?? "").indexOf("triage · status is error (3) vs rest (7)") >= 0 ? "ok" : L0[0] ?? "", "ok");
  eq("small sample banner", L0.some((l) => l.indexOf("small sample: 3 rows, percentages are unreliable") >= 0) ? "ok" : "no", "ok");
  onInput("b"); eq("b cycles", st.run.base, "previous");
  onInput("b"); eq("b skips group without group", st.run.base, "rest");
  onInput("u"); eq("u flips", String(st.run.under), "true");
  onInput("c"); eq("c call weights", st.run.weight, "duration");
  onInput("m"); eq("m = 30 days", String(st.run.days), "30");
  onInput("s"); onInput("1"); eq("preset 1", print(st.run.sel) + "/" + String(st.run.slow), "status is error/false");
  eq("narrow drops chi2", String((viewLines(st, 90, 30)[1] ?? "").indexOf("χ²")), "-1");
}
```
(The keys mutate `T.st` in place, so `st` stays valid. No non-null assertions: scriptc's subset rejects them.)
- [ ] **Step 2: Run** → BUILD FAIL.
- [ ] **Step 3: Implement** render + keys. `H.views.push({ name: "triage", render })`. `H.keys` handles mode `"view"` with `S.fview === "triage"`. `H.footerHints` for `view` mode while `S.fview === "triage"`: `↑↓ value · ↵ expand · + include · - exclude · p pin · o open · b baseline · e entity · c weight · u under · s selection · d/w/m period · esc back`. `H.helpSections` "triage".
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(triage): full-screen triage view with baseline/entity/weight/period keys`.

---

### Task 5: Actions — include/exclude/pin, open, newest calls, guards `r`/`R`

**Files:** Modify `src/features/triage/view.ts`; Test `src/features/triage/view.check.ts` (extend).

**Interfaces — Consumes:** `setLocal`, `localFor`, `addClause`, `pinAll`/`setPins`, `S.pins` (scope.ts); `eachCall`, `compile` (eval.ts); `openTranscript` (ui/transcript.ts); `say`. **Produces:**
```ts
export function onInclude(origin: string, fn: (c: Clause) => string): void; // a non-tab origin (session-compare's "Compare") receives +/- clauses; returns the toast
export function includeSel(neg: boolean): string;  // + / - on the selected row; returns the toast text
```
- `+` → clause `attr is value` (`-` → `attr is_not value`). If the origin is a tab (Sessions/Stats): `setLocal(origin, addClause(localFor(origin), c).cs)` and toast `<origin> filter: + <printClause(c)>` plus the merge note. If an `onInclude` handler is registered for the origin, call it. Then rerun the triage in the narrowed scope: `run.scope` gets the clause through `addClause`.
- `p` → add the clause to pins via `addClause(S.pins, c)` and persist (`setPins(print(...))`). Toast `pinned: <clause>`.
- `o` → Sessions tab with local = `localFor("Sessions")` ∪ sel ∪ `attr is value` (call entity: the same clauses; the list lifting gives "sessions with such calls"). `S.mode = "list"; S.tab = 0;` toast `Sessions filter: <expr>`. The `slow` selection cannot be a filter: `o` adds only `attr is value` and the toast says `slow is not a filter — showing <attr> is <value>`.
- `enter` on an expanded value (call entity) → `calls` mode: the newest 10 rows from `eachCall(F(scope ∧ sel ∧ attr is value), days, …)` sorted by `t` desc, shown as `time  duration  harness  session title`. `enter` on one → `openTranscript(s)`; `S.tv.focusKind = "tool"; S.tv.focusTs = ""; S.tv.focusText = c.cid` (filter-language changed `transcript.ts:70` to accept an empty `focusTs`).
- `r` (on the empty-baseline guard) → `run.dropped = res.offending`. `R` → remove the offending clauses from the origin tab's local clauses and from pins (`setPins`). Toast `removed <clauses> from <origin>/pins`.
- Re-entry: after `+`/`-`/`r`, the cursor stays on the same `(attr, value)` if it is still listed.

- [ ] **Step 1: Failing check** (extend `view.check.ts`):
```ts
fxBase(); setLocal("Sessions", []);
openTriage(newRun("Sessions", "call", [], parse("status is error").cs, 2), () => { S.mode = "list"; S.tab = 0; });
selectRow("harness", "codex");   // test helper in view.ts: moves st.sel onto that row (exported for checks)
eq("include toast", includeSel(false), "Sessions filter: + harness is codex");
onInput("esc"); eq("include persists in origin", print(localFor("Sessions")), "harness is codex");
eq("triage scope narrowed", T.st ? print(T.st.run.scope) : "none", "harness is codex");
// merge rule on a second include
openTriage(newRun("Sessions", "call", parse("harness is codex").cs, parse("status is error").cs, 2), () => {});
selectRow("harness", "codex"); includeSel(true);
eq("exclude replaces is", print(localFor("Sessions")), "harness is_not codex");
// guards
S.pins = parse("status is error").cs;
openTriage(newRun("Stats", "call", S.pins.slice(), parse("status is error").cs, 2), () => {});
onInput("r"); const g1 = T.st && T.st.res ? T.st.res.guard : "x"; eq("r local", print(S.pins) + " | " + g1, "status is error | ");
onInput("R"); eq("R real", print(S.pins), "");
// open
openTriage(newRun("Stats", "call", [], parse("status is error").cs, 2), () => {});
selectRow("tool", "Bash"); onInput("o");
eq("o opens Sessions", String(S.tab) + " " + print(localFor("Sessions")), "0 harness is_not codex and status is error and tool is Bash");
```
(Each `openTriage` starts from a fresh `TState`. The `S.pins` assignments go through `setPins` with a memory `PinStore` set up at the top of the check: `initPins({ load: () => "", save: (v: string) => {}, remember: true })`.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(triage): include/exclude into the origin filter, pin, open sessions and calls, guard fixes`.

---

### Task 6: Entry points `t` and origin semantics

**Files:** Modify `src/features/triage/view.ts`; `src/ui/help.ts` (sessions section: `t triage`); `src/ui/footer.ts:36` (Sessions hint `t triage`); Test `view.check.ts` (extend).

**Interfaces — Consumes:** `localFor`, `S.pins`, `statsPeriod()`, `statsDrillTool()` (filter-language Task 9). **Produces:** `H.keys` handler for `t`:
- Sessions tab (list mode, `S.tab === 0`): entity session; scope = pins; selection = `localFor("Sessions")` (spec §4.6). Empty local → preset picker opens (`picker = true`). Days 7. Origin `Sessions`.
- Stats tab, no drill-down: entity call; scope = pins; selection = `localFor("Stats")`, empty → picker; days = `statsPeriod().length` (1 or 7). Origin `Stats`.
- Stats drill-down open (`statsDrillTool() !== ""`): entity call; selection `tool is <tool> and status is error`. For an MCP server key `mcp__<s>`: `server is <s> and status is error`. Scope = pins ∧ Stats local. Origin `Stats`.
- esc → back to the origin tab, mode list, the origin's state as it was (Stats drill-down stays open).

- [ ] **Step 1: Failing check**:
```ts
fxBase(); initPins({ load: () => "repo is agentglass", save: (v: string) => {}, remember: true });
setLocal("Sessions", parse("cost > 0").cs); S.tab = 0; S.mode = "list";
onInput("t");
const st = T.st;
eq("from Sessions", st ? st.run.entity + " | " + print(st.run.scope) + " | " + print(st.run.sel) : "none", "session | repo is agentglass | cost > 0");
onInput("esc"); eq("esc back to Sessions", S.mode + String(S.tab), "list0");
setLocal("Sessions", []); onInput("t"); eq("no local → picker", String(T.st ? T.st.picker : false), "true");
```
Add a Stats case: switch to the Stats tab index (`2 + H.tabs.indexOf(statsTab)`; read it through a `statsTabIndex()` export if filter-language did not add one; add one in `stats.ts` here), open a drill-down on `Bash` via `statsDrill("Bash", [], false)`, press `t` → sel `tool is Bash and status is error`, entity call.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(triage): t opens triage from Sessions, Stats and the Stats drill-down`.

---

### Task 7: Real-life verification, docs, final review

**Files:** Modify `README.md` (Triage section: presets, keys, baselines, `agentglass triage`, `triage.*` config).

- [ ] **Step 1: Real data (read-only)** on the user's ledger:
  - `time ./agentglass triage --preset errors --days 7` → wall time (target: well under 1 s with the warm cache) and the top 10 rows.
  - `./agentglass triage --preset period --days 7 --json | jq '.rows[:5]'`.
  - In the TUI, Stats → `t` → preset 1. For the top 3 rows, `o` and check that the listed sessions really have such errors (open one, find the call). Preset 6, `b` cycles, `e` to sessions.
  - Stats drill-down on the most-erroring tool → `t` → the top rows make sense (e.g. a program or repo).
  - Slow: preset 2 → no fx/kiro rows (untimed).
  - Small-period sanity: `d` (today) shows the small-sample banner when the groups are small, with rows still listed.
- [ ] **Step 2: Docs** README section; help/footer texts reviewed.
- [ ] **Step 3:** `./build.sh && sh scripts/check.sh` → ok.
- [ ] **Step 4: Commit** `docs: triage`.
- [ ] **Step 5: Final whole-branch review** (most capable model) against spec + Review Focus, one fix pass. Then PR, CI green, rebase-merge, remove worktree + branch.
