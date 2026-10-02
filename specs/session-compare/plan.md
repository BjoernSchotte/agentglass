# Session Compare (A vs B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark two sessions, two periods or any two filter expressions and see a side-by-side diff. The diff covers cost, turns, tokens, cache use, tool mix, error rates, durations, programs, files and models, with `t` running triage A vs B.

**Architecture:** A comparison is two filter-language groups inside the pinned scope. The numbers come from filter-language's `totals()` and `aggregate()` (per group, once) plus `eachCall()` for the timeline. Distribution tables reuse triage's `score()` for χ² marks. This plan adds the `session` filter key (via `register` + `extend`), a small metrics/sections module, marks in the Sessions list, a full-screen view, and `agentglass compare`. There is no new cache format.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7, no runtime deps; scriptc checks and a shell test.

**Spec:** [spec.md](spec.md). Read it first; it is the binding authority. Engine contract: [../filter-language/plan.md](../filter-language/plan.md) (Tasks 4–9 "Produces"). Scoring and triage entry: [../triage/plan.md](../triage/plan.md) (Tasks 1, 2, 4, 5).

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`. A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)`; nominal typing; optional function members via a local; out-of-range array reads trap; SC2003; no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log`/`Math.pow`.
- Groups are evaluated inside the **pins only**. The origin tab's local clauses do not apply (spec §1). Subagents are included by default. `S` / `--no-subagents` excludes them by appending `subagent is false` to each session group.
- Keys: Sessions list `m` (mark) and `C` (compare); Stats tab `C`; inside the view `tab a b x S t enter [ ] o 1 2 esc`. `m`/`C` are free in list mode today (`src/input.ts:141-167`, `callgraph/view.ts:344-357`, `watchdog.ts:190`, `themes.ts:102`). Marks show `A`/`B` in the title prefix, never in the badge slot (watchdog owns it, `list.ts:28-33`).
- Unknown values print `n/a` and produce no Δ. CLI JSON writes them as `null`.
- `--redact`: titles and paths through `display()`/`screenOut()`.
- Below 100 columns the `B/A` column is dropped; below 80 the Δ column too.
- No network; reads only the ledger and the files under `cwd` for `enter` on a file.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-session-compare`, branch `feat/session-compare`, PR to `main`, rebase-merge after green CI. **Phase 4.** Requires **filter-language** and **triage** merged (this plan calls `score()`, `openTriage()` and `onInclude()`). parsing-fixes and honest-costs (phase 1) are merged by then: this plan reads parsing-fixes' `Day.turns` and honest-costs' billing (`modeOf`, `ModeSum`/`addDay`/`split`/`money`) and per-model day buckets (`modelUses`).

## Review Focus

1. **Subagents counted twice or lost.** A session group must include its subagents once (their cost and calls), and `S` must exclude them for both groups. Pinned by `metrics.check.ts` "subagents included / excluded" in Task 2.
2. **An unpriced or untimed side that still produces a Δ or a ratio.** Cost with `+?` or `cost ?`, fx/kiro durations: `n/a`, no Δ. Pinned by `metrics.check.ts` "unknown → n/a, no Δ" in Task 2.
3. **The "previous session" pick** (no marks): it must be the newest top-level session of the same harness and repo that **started** before B, never a subagent and never B itself. Pinned by `marks.check.ts` "previous pick" in Task 5.
4. **Ambiguous id prefixes and A = B.** An ambiguous prefix is an error listing the candidates. A = B shows the toast and does not open the view. Pinned by `key.check.ts` "ambiguous prefix" in Task 1 and `marks.check.ts` "A = B" in Task 5.
5. **Files relative to the wrong root** when A and B are in different repos or in none. Relative paths only when both sides have the same single repo root; else `~`-paths. Pinned by `sections.check.ts` "files root" in Task 3.

---

### Task 0: Worktree, prerequisites, probes

The spec's "Open questions (to verify during implementation)" says **None**. The probes check the contracts this plan consumes, including the phase-1 inputs (turns, billing, per-model buckets).

- [ ] **Step 1: Worktree + build.** `git worktree add -b feat/session-compare ../agentglass-session-compare main && cd ../agentglass-session-compare && ./build.sh && sh scripts/check.sh` → ok.
- [ ] **Step 2: Engine + triage present.** `grep -n "export function \(totals\|aggregate\|eachCall\|compile\|register\|extend\|projectRoot\|projectOf\|statsDrill\|setLocal\|livePid\)\b" src/features/query/*.ts src/features/usage/stats.ts` and `grep -n "export function \(score\|openTriage\|onInclude\|newRun\)\b" src/features/triage/*.ts` → every name found with the signature in the linked plans' Produces blocks (`compile(cs, ctx)` returns `{ f, err }`; `statsDrill(tool, local, week)`; `statsTotalsFor(expr)` from `stats.ts`; `fxSession`/`fxBase` from `fixture.ts`). A missing name is a blocker: stop and report it, do not substitute.
- [ ] **Step 3: Turns and per-model buckets present.** `grep -n "turns\|mt:\|export function modelUses\|export interface ModelUse" src/features/usage/record.ts` → `Day.turns: number` (parsing-fixes Task 6), `Day.mt`, `modelUses(a: Acc, days: string[] | null): ModelUse[]` (honest-costs Task 2).
- [ ] **Step 4: Billing present.** `grep -n "export function \(modeOf\|sessionBill\)" src/features/usage/bill-live.ts` and `grep -n "export function \(newSum\|addDay\|total\|single\|money\|split\)\b" src/features/usage/costs.ts` → honest-costs Tasks 5–6 names (`money(c, bill)`, not today's `money(c, unk)`).
- [ ] **Step 5: Keys free.** `grep -n "\"m\"\|\"C\"" src/input.ts src/features/*.ts src/features/*/*.ts` → no list-mode or Stats binding. If taken, stop and ask.

---

### Task 1: The `session` filter key

**Files:** Create `src/features/compare/key.ts`, `src/features/compare/key.check.ts`; Modify `src/main.ts` (import `./features/compare/key.ts` before `./features/query/ui.ts`, so completion sees the key).

**Interfaces — Consumes:** `register(attr)`, `extend(key, { sess, resolve })` (filter-language Task 4/5), `sessions`, `Val`. **Produces:**
```ts
export function resolveSession(v: string): { v: string; err: string }; // "<harness>:<id>" exact, or a unique id prefix ≥ 6 chars → "<harness>:<id>"; errors below
export function sessionClause(s: Sess): Clause;                        // `session is <h>:<id>` for a top-level session (a subagent → its own id)
export function sessionOf(v: string): Sess | null;                     // the session a resolved value names
```
- Registered attribute: `{ key: "session", aliases: [], ent: "session", type: "text", multi: true, enumVals: [], enumFn: "", ops: ["is", "is_not", "is_one_of", "is_not_one_of"] }`.
- `sess(s)` returns `ss = [s.h + ":" + s.id]`, plus `s.h + ":" + s.parent` when `s.parent` is set. So `session is claude:abc` matches the session and its subagents, and `session is claude:abc and subagent is false` matches the session alone.
- Errors (exact): `session "<v>": no such session`, `session "<v>": id prefix needs at least 6 characters`, `session "<v>" is ambiguous: claude:abc123…, codex:abc123…` (at most 5 candidates, then `+N`).
- Ops: registered with `ops: ["is", "is_not", "is_one_of", "is_not_one_of"]` (filter-language `Attr.ops`). `session ~ x` is a parse error from filter-language's op check: `"~" does not apply to session; use is, is_not, is_one_of, is_not_one_of`.

- [ ] **Step 1: Failing check** `key.check.ts`:
```ts
fxReset();
const a = fxSession("claude", "abc123def", "/w/app", "", "claude-sonnet-4-5", []);
fxSession("claude", "abc123zzz", "/w/app", "", "claude-sonnet-4-5", []);
fxSession("claude", "sub1", "/w/app", "abc123def", "claude-sonnet-4-5", []);
fxSession("codex", "ffffff01", "/w/x", "", "gpt-5", []);
const ids = (src: string): string => { const r = compile(parse(src).cs, "list"); if (!r.f) return "ERR " + (r.err ? r.err.msg : ""); const o: string[] = []; for (const s of sessions.values()) if (matchSession(r.f, s, null)) o.push(s.id); return o.sort().join(","); };
eq("exact incl. subagents", ids("session is claude:abc123def"), "abc123def,sub1");
eq("excl. subagents", ids("session is claude:abc123def and subagent is false"), "abc123def");
eq("unique prefix", ids("session is ffffff"), "ffffff01");
eq("ambiguous prefix", ids("session is abc123"), "ERR session \"abc123\" is ambiguous: claude:abc123def, claude:abc123zzz");
eq("short prefix", ids("session is abc"), "ERR session \"abc\": id prefix needs at least 6 characters");
eq("unknown", ids("session is codex:nope"), "ERR session \"codex:nope\": no such session");
eq("canonical after resolve", print(sessionClauseList("session is ffffff")), "session is codex:ffffff01");  // helper: parse + resolve + print
eq("clause of a session", printClause(sessionClause(a)), "session is claude:abc123def");
```
`sessionClauseList(src)` is a test helper in `key.ts` that returns the compiled `cs` with resolved values.
- [ ] **Step 2: Run** → BUILD FAIL.
- [ ] **Step 3: Implement.** The prefix scan goes over `sessions.values()` (top-level and subagents), matching on `s.id.startsWith(v)`.
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(compare): session filter key (harness:id or unique prefix, subagents included)`.

---

### Task 2: Summary metrics

**Files:** Create `src/features/compare/metrics.ts`, `src/features/compare/fixture.ts`, `src/features/compare/metrics.check.ts`.

**Interfaces — Consumes:** `totals`, `Totals`, `tsOf` (agg.ts); `compile`, `EMPTY`, `livePid` (eval.ts); `kfmt`, `grp` (stats.ts); `fmtMs`, `pct` (calls.ts); `accOf` (ledger.ts); `Day.turns` (parsing-fixes); `ModeSum`, `newSum`, `addDay`, `total`, `single`, `money`, `split` (honest-costs `costs.ts`), `modeOf` (honest-costs `bill-live.ts`). **Produces:**
```ts
export interface Group { label: string; cs: Clause[]; single: Sess | null /* the session when the group is one session */ }
export interface Side { n: number /* top-level sessions */; t: Totals; m: ModeSum /* cost per billing mode, unpriced */; bill: string /* single(m), "" mixed/none */; turns: number /* Σ Day.turns of top-level sessions */; wall: number /* ms, -1 n/a */; live: boolean; indexing: number /* 0..1, 1 = done */ }
export interface Metric { key: string; label: string; a: string; b: string; d: string /* Δ text, "" none */; r: string /* "×2.4", "" none */; tone: number /* +1 worse (red), -1 better (green), 0 neutral */ }
export interface Cmp { key: string; A: Group; B: Group; subs: boolean; a: Side; b: Side; rows: Metric[]; same: boolean /* A and B canonical-equal */; emptyA: boolean; emptyB: boolean }
export function compareGroups(A: Group, B: Group, scope: Clause[], subs: boolean, days: string[] | null): Cmp; // cached per (print(A), print(B), subs, print(scope), days, L.ver)
export function groupOfSession(s: Sess): Group;
export function groupOfExpr(src: string): { g: Group | null; err: QErr | null };
```
Rows, in spec §3 order and with spec §3 definitions: `sessions` (hidden when both groups are single sessions), `cost` (`split(side.m, narrow)` — one mode `$3.10 spend`, mixed `$3.10 spend + ≈$9.20 plan`; ` +?` when `m.unk > 0` or `m.uc > 0`; `cost ?` when the total is 0 and something is unpriced → no Δ when either side has unpriced usage), `wall time` (single sessions only: `Totals.last − Totals.first`), `turns` (Σ `Day.turns` over the group's **top-level** sessions and selected days; a subagent's opening prompt comes from its parent agent, not a person), `tokens in`, `tokens out`, `cache read`, `cache write`, `cache hit` (`cr / (in + cr + cw)`), `cost per turn`, `tokens per turn`, `tool calls`, `calls per turn` (`n/a` when a side has 0 turns), `errors`, `error rate`, `p50`/`p95`/`max call duration` (from `Totals.hist`; `timed dn/tools` shown in the label cell; `n/a` when `dn = 0`), `lines + / −`, `files touched` (`Totals.files.size`), `models` (sorted union of the side's `modelUses` models with tokens > 0 and `Totals.models`, comma-joined), `subagents` (`subs` count and `money(subsCost, side.bill || "unknown")`, `cost ?` when `subsCost === 0 && subsUnk > 0`). Δ = B − A in the row's unit. Ratio `B/A` when both are known and A > 0. Percentage rows (`error rate`, `cache hit`) show Δ in `pp` and no ratio. `lines` shows `+add −del` per side with no Δ or ratio. `models` is text only. `tone`: +1 when B > A for `cost`, `cost per turn`, `errors`, `error rate`, `p50`, `p95`, `max`; −1 when B < A for those; 0 for every other row.

**Fixture** (`compare/fixture.ts`, `cmpBase()`), built with filter-language's `fxSession`. `TMP` is a temp dir with `TMP/app/.git/` created (a real repo root for path tests):

| session | harness | cwd | parent | model | lines (today) |
|---|---|---|---|---|---|
| `a1` | claude | `TMP/app` | — | claude-sonnet-4-5 | 1 human prompt at 09:00. 2 assistant lines, each usage in 1000 / out 200 / cache read 3000. One call each at 09:00, 09:05, 09:10, 09:15, 09:20: Bash `npm test` ok 2 s, Bash `npm test` **error** 4 s, Edit `TMP/app/src/a.ts` +3 −1 0.5 s, Edit `TMP/app/src/shared.ts` +1 −0 0.5 s, `mcp__github__get_issue` ok 1 s |
| `b1` | claude | `TMP/app` | — | claude-opus-4-5 | 2 human prompts (11:00, 11:30) and one task notification (11:20, not a turn). 3 assistant lines, each in 2000 / out 400 / cache read 1000. Bash `npm test` ok 1 s at 11:00; from 11:05 to 11:50: Read ×3 ok 0.1 s, Edit `TMP/app/src/shared.ts` +2 −2 0.5 s, Edit `TMP/app/src/b.ts` +5 −0 0.5 s, `mcp__github__get_issue` ok 1 s, `mcp__github__list_prs` **error** 2 s (last line 11:50) |
| `b1s` | claude | `TMP/app` | `b1` | claude-sonnet-4-5 | 11:10; its opening prompt (from `b1`), 1 assistant line in 800 / out 50. Calls: Grep ×2 ok 0.2 s |
| `f1` | fx | `TMP/app` | — | fx-large | 08:00; 1 human prompt, 1 shell call (fx: no durations) |

Derived: A tools 5, errors 1, error rate 20%; B incl. subagents: tools 10, errors 1, error rate 10%; excl.: tools 8, errors 1, 12.5%. Tokens in A 2000, B 6800 incl. (6000 excl.). Cache hit A 6000/8000 = 75.0%, B 3000/9800 = 30.6% incl. (3000/9000 = 33.3% excl.). Files touched A 2, B 2. Lines A +4 −1, B +7 −2. Wall A 20m0s, B 50m0s. Turns (top-level) A 1, B 2, f1 1. Model tokens (in + out): A sonnet 2400; B opus 7200, sonnet 850 (`b1s`, incl. subagents). (No ratio or percentage lands on an exact .x5: native `toFixed` may round ties differently.) Expected costs come from `cost(price(model), …)` in the check, not from literals.

- [ ] **Step 1: Failing check** `metrics.check.ts`:
```ts
cmpBase();
const A = groupOfSession(sess("a1")); const B = groupOfSession(sess("b1"));
const c = compareGroups(A, B, [], true, null);
const row = (k: string): Metric | null => { for (const m of c.rows) if (m.key === k) return m; return null; };
const val = (k: string): string => { const m = row(k); return m ? m.a + " | " + m.b + " | " + m.d + " | " + m.r + " | " + String(m.tone) : "missing"; };
eq("sessions row hidden for two singles", row("sessions") === null ? "hidden" : "shown", "hidden");
eq("tool calls", val("tools"), "5 | 10 | +5 | ×2.0 | 0");
eq("errors", val("errors"), "1 | 1 | 0 | ×1.0 | 0");
eq("error rate", val("error_rate"), "20.0% | 10.0% | −10.0 pp |  | -1");
eq("tokens in", val("in"), "2.0K | 6.8K | +4.8K | ×3.4 | 0");
eq("cache hit", val("cache_hit"), "75.0% | 30.6% | −44.4 pp |  | 0");
eq("wall", val("wall"), "20m0s | 50m0s | +30m0s | ×2.5 | 0");
eq("files", val("files"), "2 | 2 | 0 | ×1.0 | 0");
eq("lines", val("lines"), "+4 −1 | +7 −2 |  |  | 0");
eq("models", val("models"), "claude-sonnet-4-5 | claude-opus-4-5, claude-sonnet-4-5 |  |  | 0");
eq("subagents included", val("subagents").split(" | ")[1] ?? "", "1 · " + money(costOf("b1s"), c.b.bill || "unknown"));
eq("turns (top-level, notification not counted)", val("turns"), "1 | 2 | +1 | ×2.0 | 0");
const cx = compareGroups(A, B, [], false, null);
const tx = cx.rows.filter((m) => m.key === "tools")[0];
eq("subagents excluded", tx ? tx.b : "", "8");
eq("cost tone", String((row("cost") ?? { tone: 9 }).tone), costOf("b1") + costOf("b1s") > costOf("a1") ? "1" : "-1");
// unknown → n/a, no Δ: fx has no durations and no price
const cf = compareGroups(groupOfSession(sess("f1")), A, [], true, null);
const p95 = cf.rows.filter((m) => m.key === "p95")[0];
eq("unknown → n/a, no Δ", p95 ? p95.a + "|" + p95.d + "|" + p95.r : "", "n/a||");
eq("turns fx", (cf.rows.filter((m) => m.key === "turns")[0] ?? { a: "" }).a, "1");
eq("same", String(compareGroups(A, A, [], true, null).same), "true");
const e = compareGroups(A, groupOfExpr("harness is pi").g ?? A, [], true, null);
eq("empty group", String(e.emptyB), "true");
// periods: today vs yesterday equal Stats per-day totals
const tp = compareGroups(groupOfExpr("day is yesterday").g ?? A, groupOfExpr("day is today").g ?? A, [], true, null);
eq("period B tools = Stats today", (tp.rows.filter((m) => m.key === "tools")[0] ?? { b: "" }).b, String(statsTotalsFor("day is today").tools));
```
`sess(id)`, `costOf(id)` are fixture helpers. `statsTotalsFor` is exported from `stats.ts` by filter-language Task 9. Number formats: counts `grp`, tokens `kfmt`, percents one decimal, Δ of percentages in `pp`, minus sign `−` (U+2212) as in `stats.ts:85`.
- [ ] **Step 2: Run** → BUILD FAIL.
- [ ] **Step 3: Implement.** `compareGroups`: `fa = compile(scope ∧ A.cs ∧ (subs ? [] : [subagent is false]), "list").f` (an error → `emptyA` with the message), same for B. `ta = totals(fa, days)`, `tb = totals(fb, days)`. Turns = Σ `Day.turns` over matched top-level sessions' selected days (`days` null = all). `m` = `newSum()` + `addDay(m, d, (p) => modeOf(s, p))` over every matched session's selected days; `bill = single(m)`. `wall` only when `A.single`/`B.single`. `live` = any matched session with `livePid(s) > 0`. `indexing` = Σ min(off, size) / Σ size over matched sessions. While < 1, set `L.prio` to the first pending path and `L.prioAt = Date.now()` (`ledger.ts:63`, as the preview does via `H.enrich`). `same` = `print(fa.cs) === print(fb.cs)`.
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(compare): A/B summary metrics from filter-language totals`.

---

### Task 3: Detail sections

**Files:** Create `src/features/compare/sections.ts`, `src/features/compare/sections.check.ts`.

**Interfaces — Consumes:** `Cmp`, `Side` (Task 2); `score`, `CHI_SIG` (triage `score.ts`); `mcpServer` (calls.ts); `projectRoot` (project.ts); `eachCall`, `callCutoff`; `localOf` (facts.ts); `home` (text.ts); `modelUses`, `ModelUse` (honest-costs `record.ts`), `accOf` (ledger.ts). **Produces:**
```ts
export interface ToolRow { key: string; label: string; server: boolean; kid: boolean; nA: number; nB: number; shA: number; shB: number; dpp: number; errA: number; errB: number; p95A: number; p95B: number; chi2: number /* -1 none */; sig: boolean }
export function toolRows(c: Cmp, open: Set<string>): { rows: ToolRow[]; significance: boolean /* both groups ≥ 50 calls */ };
export interface CntRow { key: string; nA: number; nB: number; shA: number; shB: number; dpp: number; errA: number; errB: number; chi2: number; sig: boolean }
export function cntRows(c: Cmp, which: "prog" | "cmds"): CntRow[];          // shell tools only (key "<tool>\t<x>" → x)
export interface FileRow { path: string; shown: string; abs: string; editsA: number; editsB: number; addA: number; delA: number; addB: number; delB: number }
export function fileLists(c: Cmp): { onlyA: FileRow[]; onlyB: FileRow[]; both: FileRow[]; root: string /* "" = shown with ~ */ };
export interface ModelRow { model: string; callsA: number; callsB: number; tokA: number; tokB: number; costA: number; costB: number; unkA: boolean; unkB: boolean }
export function modelRows(c: Cmp): { rows: ModelRow[]; limited: boolean /* call rows missing for part of the period: calls column only */ };
export function timeline(c: Cmp): { a: number[]; b: number[]; slot: number /* ms: 300000, or 3600000 from TS.h when rows are gone */ } | null; // single sessions only
```
- Tools: per tool name from `Totals.perTool`. MCP grouped by server (`mcp__<s>` parent rows, kids when `open` has the key), as `stats.ts:179-198`. Sorted by |Δ share| desc. With ≥ 50 calls on each side: `score(nB, B.tools, nA, A.tools)` per row (selection = B, baseline = A), `sig = chi2 ≥ CHI_SIG`. Otherwise `chi2 = -1`, and the section header says `small samples, no significance`.
- Programs/commands: `Totals.prog`/`Totals.cmds` (keys `"<tool>\t<x>"`). Merge by `x` across tools, same columns.
- Files: from `Totals.files` (path → `Cnt` edits/add/del) per side. `root = projectRoot(cwd)` when every matched session of both groups has the same non-empty root; `shown` is then relative to it, else `home(path)`. `abs` = the absolute path for `enter`.
- Models: tokens (`tokA`/`tokB` = in + out) and cost per model from honest-costs' per-model day buckets: `modelUses(accOf(s), days)` summed over the side's matched sessions (subagents per the `S` toggle); `unkA`/`unkB` = the model has unpriced tokens (`ModelUse.unk > 0`) → its cost shows `cost ?`/`+?`, no Δ. Calls per model from `eachCall` rows (`Call.model`, within `callCutoff()`). `limited = true` when the period reaches past `callCutoff()`; it concerns the calls column only (tokens and cost cover all history). Rows sorted by `costA + costB` desc, then model.
- Timeline: per session, `eachCall` rows → slot `floor((t − Acc.t0) / 300000)`. When the session's days are older than `callCutoff()`, use the hourly `TS.h` counts of its day buckets instead, with `slot = 3600000`.

- [ ] **Step 1: Failing check** `sections.check.ts` (`cmpBase()`, A = a1, B = b1, subs on):
```ts
const tr = toolRows(c, new Set<string>());
eq("tool order by |Δshare|", tr.rows.map((r) => r.label).join(","), "Bash,Read,Edit,Grep,github");
eq("no significance under 50", String(tr.significance), "false");
eq("mcp grouped", tr.rows.filter((r) => r.server).map((r) => r.key + "=" + r.nA + "/" + r.nB).join(","), "mcp__github=1/2");
const op = toolRows(c, new Set<string>(["mcp__github"]));
eq("mcp expanded", op.rows.filter((r) => r.kid).map((r) => r.label).join(","), "get_issue,list_prs");
const fl = fileLists(c);
eq("files root", fl.root === TMP + "/app" ? "root" : fl.root, "root");
eq("only A", fl.onlyA.map((f) => f.shown).join(","), "src/a.ts");
eq("only B", fl.onlyB.map((f) => f.shown).join(","), "src/b.ts");
eq("both", fl.both.map((f) => f.shown + " " + f.addA + "/" + f.delA + " " + f.addB + "/" + f.delB).join(","), "src/shared.ts 1/0 2/2");
const cross = compareGroups(groupOfSession(sess("a1")), groupOfExpr("harness is fx").g ?? A, [], true, null);   // f1 lives in TMP/app too → same root
eq("files root (same repo, other harness)", fileLists(cross).root === TMP + "/app" ? "root" : "none", "root");
fxSession("claude", "z1", "/elsewhere/proj", "", "claude-sonnet-4-5", editLine("/elsewhere/proj/x.ts"));
const other = compareGroups(groupOfSession(sess("a1")), groupOfSession(sess("z1")), [], true, null);
eq("files root (different repos) → ~ paths", fileLists(other).root, "");
const pr = cntRows(c, "prog"); eq("programs", pr.map((r) => r.key + "=" + r.nA + "/" + r.nB).join(","), "npm=2/1");
const tl = timeline(c); eq("timeline slots", tl ? tl.a.slice(0, 5).join(",") + " | " + tl.b.slice(0, 1).join(",") + " | " + String(tl.slot) : "null", "1,1,1,1,1 | 1 | 300000");
const md = modelRows(c); eq("models calls", md.rows.map((m) => m.model + " " + m.callsA + "/" + m.callsB).join(","), "claude-opus-4-5 0/8,claude-sonnet-4-5 5/2");
eq("models tokens from buckets", md.rows.map((m) => m.model + " " + m.tokA + "/" + m.tokB).join(","), "claude-opus-4-5 0/7200,claude-sonnet-4-5 2400/850");
eq("models not limited (all today)", String(md.limited), "false");
```
Tool order: A (5 calls) Bash .4, Edit .4, github .2; B (10, incl. subagents) Bash .1, Read .3, Edit .2, github .2, Grep .2. |Δ| = Bash .3, Read .3, Edit .2, Grep .2, github 0. The tie rule for every sorted table is `|Δ| desc, then nA + nB desc, then label asc`. So Bash (3) and Read (3) sort by label, and Edit (4) comes before Grep (2). Timeline: `a1` has one call per 5-minute slot from its start; `b1`'s first slot holds only the 11:00 Bash call.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with the tie rule above for every sorted table.
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(compare): tools, programs, commands, files, models and timeline sections`.

---

### Task 4: CLI `agentglass compare`

**Files:** Create `src/features/compare/cli.ts`, `scripts/compare-cli.test.sh`; Modify `src/features/cli.ts:15-26` (CMDS rows), `src/main.ts` (import).

**Interfaces — Consumes:** Tasks 1–3, `complete` (hooks.ts), `parse`/`caret`/`addAll`. **Produces:** `H.cli` handler for `args[0] === "compare"`:
- `agentglass compare <session> <session> [--no-subagents] [--json]`. Each `<session>` goes through `resolveSession`.
- `agentglass compare --a '<expr>' --b '<expr>' [--filter '<scope>']… [--no-subagents] [--json]`. Scope = the `--filter` clauses; pins are not applied (the same rule as `--json`).
- `complete(s)` runs for every session matching either group first.
- Exit 2: a bad expression (filter-language error format with caret), an ambiguous/unknown id (the Task 1 message), a missing argument, or A = B (`A and B are the same`).
- Text: the summary table (label, A, B, Δ, B/A) plus the top 15 tool rows. No ANSI when not a TTY.
- JSON (spec §7, unknown → `null`):
```json
{"a":{"expr":"session is claude:a1","n":1,"metrics":{"cost":0.0213,"unpriced":false,"wallMs":1200000,"turns":1,"tokens":{"in":2000,"out":400,"cacheRead":6000,"cacheWrite":0},"cacheHit":0.75,"tools":5,"errors":1,"errorRate":0.2,"p50Ms":1000,"p95Ms":3536,"maxMs":4000,"timed":5,"linesAdded":4,"linesRemoved":1,"filesTouched":2,"models":["claude-sonnet-4-5"],"subagents":{"n":0,"cost":0}}},
 "b":{…same shape…},"subagents":true,
 "tools":[{"tool":"Bash","a":{"n":2,"err":1,"p50":2000,"p95":4000},"b":{"n":1,"err":0,"p50":1000,"p95":1000},"shareDiff":-0.3,"chi2":null}],
 "programs":[{"program":"npm","a":{"n":2,"err":1},"b":{"n":1,"err":0}}],
 "files":{"onlyA":["src/a.ts"],"onlyB":["src/b.ts"],"both":["src/shared.ts"]}}
```
(`p50Ms`/`p95Ms` are the histogram estimates from `pct()`, so the example values are bucket middles.)

- [ ] **Step 1: Failing shell test** `scripts/compare-cli.test.sh`. Temp `HOME` as in `scripts/filter-cli.test.sh`, with two Claude sessions `aaaaaa11` and `aaaaaa22` (2 and 3 Bash calls) and one Codex session `bbbbbb33`:
```sh
ag compare aaaaaa11 aaaaaa22 --json > "$T/c.json"
grep -q '"tools":2' "$T/c.json" && grep -q '"tools":3' "$T/c.json" || { echo "FAIL counts"; cat "$T/c.json"; exit 1; }
set +e; err=$(ag compare aaaaaa aaaaaa22 2>&1); rc=$?; set -e
[ $rc = 2 ] && echo "$err" | grep -q 'is ambiguous: claude:aaaaaa11, claude:aaaaaa22' || { echo "FAIL ambiguous rc=$rc $err"; exit 1; }
set +e; ag compare aaaaaa11 aaaaaa11 >/dev/null 2>&1; rc=$?; set -e; [ $rc = 2 ] || { echo "FAIL same"; exit 1; }
ag compare --a 'harness is claude' --b 'harness is codex' --json | grep -q '"expr":"harness is codex"' || { echo "FAIL exprs"; exit 1; }
ESC=$(printf '\033'); ag compare aaaaaa11 aaaaaa22 | grep -q "$ESC" && { echo "FAIL ansi"; exit 1; }
echo "compare cli: all checks passed"
```
- [ ] **Step 2: Run** `./build.sh && sh scripts/compare-cli.test.sh` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh` ok.
- [ ] **Step 5: Commit** `feat(compare): agentglass compare CLI (sessions or expressions, --json)`.

---

### Task 5: Marks, `C` entry points, guards

**Files:** Create `src/features/compare/marks.ts`, `src/features/compare/marks.check.ts`; Modify `src/hooks.ts` (`H.rowPrefix`), `src/ui/list.ts:58-70` (prefix before the title on both row kinds), `src/ui/footer.ts:36` (`m mark`, `C compare`), `src/ui/help.ts` (sessions section).

**Interfaces — Consumes:** `accOf` (ledger.ts), `projectOf`, `current()`, `sessionClause`, `compareGroups`, `groupOfSession`, `groupOfExpr`, `localFor("Stats")`, `S.pins`, `statsPeriod()`. **Produces:**
```ts
// hooks.ts
H.rowPrefix: ((s: Sess) => string)[]   // styled text before a row's title (list.ts); visible width counts against the title
// marks.ts
export const M: { a: string; b: string };              // marked session paths ("" none)
export function toggleMark(s: Sess): string;            // returns the toast ("A: <title>", "B: <title>", "unmarked")
export function prevSession(b: Sess): Sess | null;      // newest top-level session with b.h and projectOf(b.cwd) whose start < b's start; start = Acc.t0 || s.mtime
export function pickPair(): { A: Group; B: Group; note: string } | string; // spec §2.2; a string = toast (no view)
export function periodPair(days: string[]): { A: Group; B: Group };       // Stats C: previous period (A) vs current (B), same length
```
- `m` (list mode, Sessions tab): `toggleMark(current())`. On an unmarked row: A if free, else B if free, else replaces B. On a marked row: unmarks it. Marks survive esc in the list. They are cleared when the marked session disappears (trash, gone from the scan).
- Prefix: `A ` / `B ` in `C.accent` bold before the title (both depth-0 and depth-1 rows). `tw` shrinks by the prefix width.
- `C` (Sessions): two marks → A vs B. One mark → mark (A) vs selected (B); when the selected row is the mark, the toast `mark a second session with m`. None → selected (B) vs `prevSession(B)` (A), with the header note `A: previous <harness> session in <repo> · <title> · <start>`. No previous session → toast `no earlier <harness> session in <repo> — mark two with m`. A = B → toast `A and B are the same`, no view.
- `C` (Stats tab, no drill-down): `periodPair(statsPeriod())`. Today: `day is yesterday` vs `day is today`. 7 days: `day >= -13d and day < -6d` vs `day >= -6d`. Scope = pins ∧ Stats local.

- [ ] **Step 1: Failing check** `marks.check.ts` (`cmpBase()` plus `fxSession("claude", "a0", TMP + "/app", "", "claude-sonnet-4-5", lines at 07:00)` and `fxSession("codex", "c9", TMP + "/app", "", "gpt-5", lines at 10:00)`):
```ts
eq("previous pick", (prevSession(sess("b1")) ?? { id: "none" }).id, "a1");      // a1 started 09:00 < b1 11:00; c9 is codex; b1s is a subagent
eq("previous of the first", (prevSession(sess("a0")) ?? { id: "none" }).id, "none");
selectRow("b1"); const p = pickPair();
eq("no marks → previous", typeof p === "string" ? p : p.A.label + " vs " + p.B.label, titleOf(sess("a1")) + " vs " + titleOf(sess("b1")));
eq("note names the pick", typeof p === "string" ? "" : p.note.indexOf("A: previous claude session in app") === 0 ? "ok" : p.note, "ok");
eq("mark A", toggleMark(sess("a0")), "A: " + titleOf(sess("a0")));
eq("mark B", toggleMark(sess("b1")), "B: " + titleOf(sess("b1")));
eq("third replaces B", toggleMark(sess("c9")), "B: " + titleOf(sess("c9")));
eq("prefix", plain(H.rowPrefix.map((f) => f(sess("a0"))).join("")), "A ");
eq("unmark", toggleMark(sess("c9")), "unmarked");
selectRow("a0"); eq("A = B", pickPairText(), "mark a second session with m");
M.a = sess("a0").path; M.b = sess("a0").path; eq("A = B guard", pickPairText(), "A and B are the same");
selectRow("a0"); M.a = ""; M.b = ""; eq("none earlier", pickPairText(), "no earlier claude session in app — mark two with m");
const pp = periodPair(lastDays(7)); eq("period pair", print(pp.A.cs) + " | " + print(pp.B.cs), "day >= -13d and day < -6d | day >= -6d");
```
`selectRow(id)` sets `S.sel` to that session in `S.view` (after `buildView()`). `pickPairText()` returns the toast or `"view"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, including the `H.keys` handlers for `m` and `C`. They open the view from Task 6 with `openCompare(A, B, origin)`. Until Task 6 exists, the handler builds the `Cmp` and shows a toast `compare: <A> vs <B>`, so this task is testable on its own. Task 6 replaces the toast with the view.
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(compare): m marks A/B in the session list; C picks the pair (marks, previous rerun, periods)`.

---

### Task 6: Compare view — layout, sections, keys

**Files:** Create `src/features/compare/view.ts`, `src/features/compare/view.check.ts`; Modify `src/actions.ts:42-56` (export `openPath(path: string, edit: boolean)`, which `openFileN` calls), `src/main.ts` (import).

**Interfaces — Consumes:** Tasks 2–5; `statsDrill(tool, local, week)` (filter-language Task 9); `openTranscript`; `ask` + `H.input` (filter-language Task 8, action names `"cmp-a"`, `"cmp-b"`); `gauge`, `box`, `put`. **Produces:**
```ts
export const CV_NAME = "compare";
export interface CState { A: Group; B: Group; subs: boolean; sec: number /* 0 summary, 1 tools, 2 programs, 3 commands, 4 files, 5 models, 6 timeline */; sel: number; top: number; side: 0 | 1 /* [ = A, ] = B */; open: Set<string>; note: string; origin: string /* "Sessions" | "Stats" */ }
export const CV: { st: CState | null };
export function openCompare(A: Group, B: Group, origin: string, note: string): void;   // S.fview = "compare", S.mode = "view"
export function compareLines(st: CState, W: number, H: number): string[];             // plain lines, for checks
```
- Header: `A: <label>  ·  B: <label>`, labels through `display()`, plus `subagents incl.|excl.`, `live` when either side is live, `indexing N%` while < 100%, and the pick note when present. An empty group: in place of the table, `group B matched nothing: <expr>`.
- Summary: one row per `Metric`. Columns label | A | B | Δ (tone-colored: +1 `C.red`, −1 `C.green`) | B/A. Below 100 columns no B/A; below 80 no Δ.
- `tab` cycles sections (timeline only when both groups are single sessions). Tools rows use `gauge(share, bw)` for A and B.
- Keys: `↑↓` move; `␣` expands an MCP server row; `enter` on a tool row → `statsDrill(tool, side === 0 ? A.cs : B.cs, days > 1)`; `[`/`]` pick the side; `enter` on a file row → `openPath(abs, false)` when it exists, else the toast `not found: <path>`; `o` opens the transcript of the selected side's single session, `1`/`2` open A/B directly (only when that group is one session, else the toast `group A is not a single session`); `a`/`b` → `ask("A", "cmp-a", print(A.cs))`, enter → `groupOfExpr` (an error stays in the input, as in filter-language Task 8); `x` swaps; `S` toggles subagents; `esc` → back to the origin tab (mode list).
- Footer hints and a help section `compare`.

- [ ] **Step 1: Failing check** `view.check.ts`:
```ts
cmpBase(); openCompare(groupOfSession(sess("a1")), groupOfSession(sess("b1")), "Sessions", "");
const st = CV.st;
if (!st) { bad++; console.log("FAIL no compare state"); } else {
  const L1 = compareLines(st, 120, 40);
  eq("header", (L1[0] ?? "").indexOf("A: " + titleOf(sess("a1")) + "  ·  B: " + titleOf(sess("b1"))) >= 0 ? "ok" : L1[0] ?? "", "ok");
  eq("subagents incl.", L1.some((l) => l.indexOf("subagents incl.") >= 0) ? "ok" : "no", "ok");
  eq("ratio column wide", L1.some((l) => l.indexOf("×2.0") >= 0) ? "ok" : "no", "ok");
  eq("no ratio < 100 cols", compareLines(st, 99, 40).some((l) => l.indexOf("×2.0") >= 0) ? "shown" : "dropped", "dropped");
  eq("no Δ < 80 cols", compareLines(st, 79, 40).some((l) => l.indexOf("+5") >= 0) ? "shown" : "dropped", "dropped");
  onInput("S"); eq("S toggles", String(st.subs), "false");
  onInput("x"); eq("x swaps", st.A.label, titleOf(sess("b1")));
  onInput("tab"); eq("tab → tools", String(st.sec), "1");
  onInput("esc"); eq("esc back", S.mode + String(S.tab), "list0");
}
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Replace the Task 5 toast with `openCompare`.
- [ ] **Step 4: Run** → PASS; suite ok. Manual: two real sessions, `m` `m` `C`; `tab` through the sections; `enter` on a tool; `S`; `x`; esc.
- [ ] **Step 5: Commit** `feat(compare): side-by-side compare view with summary and detail sections`.

---

### Task 7: `t` — triage A vs B, and back

**Files:** Modify `src/features/compare/view.ts`; Test `view.check.ts` (extend).

**Interfaces — Consumes:** `newRun`, `openTriage(r, back)`, `onInclude(origin, fn)` (triage), `callCutoff`, `accOf`. **Produces:** the `t` key in the compare view:
- `run = newRun("Compare", entity, S.pins, A.cs (+ subagent clause when excluded), days)` with `run.base = "group"` and `run.group = B.cs`. `entity = "call"` when every matched session of both groups has `Acc.t0 >= callCutoff()` (all calls within retention), else `"session"`. `days` = 30 for session groups and the period length for period groups.
- `back = () => { S.fview = "compare"; S.mode = "view"; }`. The `CState` stays in `CV.st`, so esc returns to the same section, cursor and toggles.
- `onInclude("Compare", (c) => { st.A = { label: st.A.label, cs: addClause(st.A.cs, c).cs, single: null }; return "group A: + " + printClause(c); })`. Triage's `+`/`-` thus edit group A (spec §8.1). After an include, `A.single` is null and the header shows the expression.

- [ ] **Step 1: Failing check**:
```ts
cmpBase(); openCompare(groupOfSession(sess("a1")), groupOfSession(sess("b1")), "Sessions", "");
onInput("t");
const ts = T.st;   // triage state (triage view.ts)
eq("t opens triage A vs B", ts ? ts.run.base + " | " + print(ts.run.sel) + " | " + print(ts.run.group) : "none", "group | session is claude:a1 | session is claude:b1");
eq("entity call within retention", ts ? ts.run.entity : "", "call");
selectTriageRow("tool", "Bash"); includeSel(false);
onInput("esc"); eq("back in compare", S.fview + " " + S.mode, "compare view");
const cs = CV.st; eq("include edited group A", cs ? print(cs.A.cs) : "", "session is claude:a1 and tool is Bash");
```
`selectTriageRow` is triage's `selectRow` test helper (`view.ts`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(compare): t runs triage with A as selection and B as the group baseline`.

---

### Task 8: Real-life verification, docs, final review

**Files:** Modify `README.md` (Compare section: marks, `C`, keys, `agentglass compare`), help texts.

- [ ] **Step 1: Real data (read-only):**
  - Rerun case: run the same small task twice with two models (e.g. `claude -p` with `--model` sonnet, then opus, in `/tmp/agtest-compare`). In the TUI, select the second run and press `C` with no marks. The header names the first run as "previous". Check cost, tokens, tool calls, lines and files against both previews (`stats.ts:454-463`) and `--json` for each session.
  - Subagents: compare a session that spawned subagents with `S` on/off; the tool call totals differ by the subagents' calls.
  - Periods: Stats `C` (today vs yesterday, then 7 days vs the 7 before). B's tool calls equal Stats' total for the same period.
  - `t` in the compare view → triage rows make sense; `+` on one → back in compare, A narrowed.
  - CLI: `./agentglass compare <id1> <id2> --json | jq '.a.metrics, .b.metrics'`, an ambiguous prefix, `--no-subagents`.
  - Clean `/tmp/agtest-compare` afterwards.
- [ ] **Step 2: Docs.**
- [ ] **Step 3:** `./build.sh && sh scripts/check.sh` → ok.
- [ ] **Step 4: Commit** `docs: session compare`.
- [ ] **Step 5: Final whole-branch review** (most capable model) against spec + Review Focus, one fix pass. Then PR, CI green, rebase-merge, remove worktree + branch.
