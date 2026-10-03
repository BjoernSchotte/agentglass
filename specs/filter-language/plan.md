# Filter Language and Shared Attribute Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One filter grammar for the Sessions list, Stats, `--json` and `--watch`, with pinned filters remembered across runs, an attribute catalogue, and per-call ledger rows that carry the model of the message that issued each call. `aggregate()`, `totals()` and `eachCall()` are the shared engine that triage, session-compare, repo-view and rules-config consume.

**Architecture:** The ledger gets a per-session call table (`Acc.calls`). Its string columns are ids into ledger-wide dictionaries (`src/features/usage/facts.ts`). The table persists as one columnar file per session under `~/.agentglass/cache/calls/`. A new module `src/features/query/` holds the tokenizer/parser/printer, the attribute registry, compile-to-predicates with lifting, aggregation over buckets or rows, filter scopes and pins, and the TUI glue. The Sessions list, Stats, Processes tab and CLI read the filter through that module. Model code (`sessions.ts`, `procs.ts`) reaches it only through new `H` hooks, so `model/` never imports `features/`.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`); CLI behaviour is checked with a shell test (`scripts/*.test.sh`).

**Spec:** [spec.md](spec.md). Read it first. This plan argues from it, and the spec wins on any conflict.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`, hex by hand); nominal typing (pass fields, not foreign interfaces); call optional function members through a local; out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log`/`Math.pow`; no `node:crypto`.
- Every harness works: claude, codex, fx, pi, opencode, kiro, gemini. Never write into agent data dirs. No network. Credentials never in argv/env of children/logs/`--json`.
- Filtering reads only data already read. `--redact` scrubs every chip value through `display()`/`screenOut()`.
- Grammar, canonical form, error texts, merge toasts: copied verbatim from spec §1, §6.2, §10.
- Config keys (`~/.agentglass/config.json`): `filter.callDays` (integer ≥ 1, default 90, read through `intSetting`, Task 3), `filter.remember` (bool, default true), `filter.pinned` (canonical expression string). An invalid value falls back to the default and shows one startup toast. `config.json` is created with mode 0600 when it does not exist yet.
- Ledger cache `VERSION` (`src/features/usage/cache.ts:15` on `main` today; `codec.ts` once honest-costs Task 3 moved it): bump once, in Task 3, to the next free number at implementation time (read it on `main` then; phase 1 bumps it first). The comment says why.
- Unfiltered Stats keeps today's `agg()`/`dagg()` fast path (`stats.ts:49-76`, `:221-253`). The new engine runs only when a filter is active.
- Style: dense one-line helpers, short `//` why-comments, no new dependencies.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-filter-language`, branch `feat/filter-language`, PR to `main`, rebase-merge after green CI. **Phase 2.** Start after phase 1 (`honest-costs`, `parsing-fixes`) is merged: both touch the adapters' `usage()` lines, `record.ts` and `VERSION`. If either is still open, rebase onto it before Task 1.

## Review Focus

1. **A call counted in `TS` but missing its row, or a row whose `err`/`ms` never closes** (pi nested calls, pi `retool`, gemini/opencode "call + result on one line", kiro untimed results). Rows must match `TS` n/err/dn exactly per harness. Pinned by the `harness.check.ts` row-parity loop in Task 1.
2. **The wrong model on a row after a mid-session model switch** (Claude fallback iteration, pi `model_change`, OpenCode `model-switched`, Codex second `turn_context`, Claude `<synthetic>`). Pinned by `src/harness/model.check.ts` in Task 2.
3. **A torn or stale calls file** (crash between the calls write and the ledger write, an older `off`, a hash collision, a deleted session) must re-index that one session and never produce wrong numbers. Pinned by `callcache.check.ts` "off mismatch" and "foreign path" cases in Task 3.
4. **Typing in `/` mid-expression** (`tool is`, `cost >`, an unclosed quote) must not empty the list. The last valid filter stays applied and esc restores the previous one. Pinned by `ui.check.ts` "prefix keeps last valid" in Task 8.
5. **A restored pin that silently hides sessions** (`remember` default on). The start toast, `· pins hide N` and the empty-list text must appear. Pinned by `scope.check.ts` "restored pins announced" and `ui.check.ts` "hidden count" in Tasks 7 and 8.

---

### Task 0: Worktree, baseline, probes

**Files:** none committed except a ledger note in the PR description.

The spec's "Open questions (to verify during implementation)" says **None**. The probes below check the facts this plan relies on.

- [ ] **Step 1: Worktree + build.** `git worktree add -b feat/filter-language ../agentglass-filter-language main && cd ../agentglass-filter-language && ./build.sh && sh scripts/check.sh` → all `ok`.
- [ ] **Step 2: Baseline outputs** (kept in the scratchpad, not committed): `./agentglass --json --subagents --limit 400 > $SCRATCH/json-before.json`; `ls -la ~/.agentglass/cache/ledger.json` (size); `/usr/bin/time -v ./agentglass --json --limit 1 2>&1 | grep -E "Elapsed|Maximum resident"` with the warm cache.
- [ ] **Step 3: Probe the model sources** still sit where the spec says. Run `grep -n "str(m\[\"model\"\])\|const md = str(o\[\"model\"\])\|responseModel\|modelID\|turn_context\|s.model = str(o\[\"model\"\])" src/harness/{claude,gemini,pi,opencode,codex,fx}.ts`. Expected: claude.ts:105, gemini.ts:302, pi.ts:240, opencode.ts:242/366/373, codex.ts:103, fx.ts:63. If a line moved because of parsing-fixes, use the new line. The source expression must stay the same. If it changed, record a `Ruling:` in the PR description and follow the code.
- [ ] **Step 4: Probe scriptc file modes.** Write `$SCRATCH/mode.ts`: `import { openSync, writeSync, closeSync, statSync, chmodSync } from "node:fs"; const fd = openSync("/tmp/agm", "w", 0o600); writeSync(fd, "x"); closeSync(fd); chmodSync("/tmp/agm", 0o600); console.log(String(statSync("/tmp/agm").mode & 0o777));`. Run `scriptc build $SCRATCH/mode.ts -o /tmp/agm-x && /tmp/agm-x`. Expected `384`. If the build fails: use `run("chmod", ["600", path])` (`src/util/fs.ts:35`) after the rename. Record which one.
- [ ] **Step 5: Probe the `.git` worktree file format**: `cat $(git -C ../agentglass-filter-language rev-parse --git-dir 2>/dev/null)/../.git 2>/dev/null; cat ../agentglass-filter-language/.git`. Expected `gitdir: /home/…/agentglass/.git/worktrees/agentglass-filter-language`. `projectOf` (Task 5) resolves the main repo as the text before `/.git/worktrees/`.
- [ ] **Step 6: Hash.** Spec §4.2 (decision 6): calls-file names are `pathKey()` = two 32-bit FNV-1a hashes with different offset bases, written as 16 hex chars by hand (scriptc has no `node:crypto`). Every calls file stores its `path`, and a mismatch counts as a missing file, so collisions cannot mix data. Changing the scheme later is self-cleaning: files without a current session are removed on save. Probe only that `Math.imul` and `>>>` build (as `pricing.ts:36` already does).

---

### Task 1: Per-call rows in the ledger (primitives + row parity)

**Files:**
- Create: `src/features/usage/facts.ts`
- Modify: `src/features/usage/record.ts:10-18` (Acc), `:41-49` (bucket), `:50-58` (tool), `:60-66` (pend), `:68-80` (retool), `:81-85` (file), `:116-118` (patchLines)
- Modify: `src/features/usage/calls.ts:12` (Pend), `:54-75` (done)
- Modify every adapter's `tool()`/`file()` call: `src/harness/claude.ts:112,122`, `codex.ts:110`, `fx.ts:85,92-93`, `gemini.ts:312,324`, `pi.ts:276,286`, `opencode.ts:336,357`, `kiro.ts:129,138`
- Test: `src/features/usage/record.check.ts` (extend), `src/harness/harness.check.ts` (row parity loop)

**Interfaces — Produces (exact; triage, compare, repo-view, rules-config read these):**
```ts
// src/features/usage/facts.ts
export const MQ_MSG = 0; export const MQ_TURN = 1; export const MQ_SESS = 2; // model exact per message | per turn | per session
// one tool call. String columns are ids into DICT; -1 = none/unknown. t = call time (epoch ms, never 0: falls back to the bucket's time).
export interface Call { t: number; tool: number; model: number; mq: number; progs: number[]; cmds: number[]; files: number[]; ms: number /* -1 unknown */; err: number /* -1 unknown, 0, 1 */; out: number; cid: string /* harness call id, "" none */ }
export interface Dict { ids: Map<string, number>; names: string[] }
export const DICT: { tool: Dict; model: Dict; prog: Dict; cmd: Dict; file: Dict };
export function intern(d: Dict, s: string): number;   // "" → -1
export function nameOf(d: Dict, i: number): string;   // -1 / out of range → ""
export function extOf(path: string): string;          // lowercased extension without dot, "" if none (".bashrc" → "")
export interface Local { day: string; hour: number; wd: number /* 0 = Sunday, Date.getDay() */ }
export function localOf(t: number): Local;            // memoized per half hour (Math.floor(t / 1800000)): :30 time zones
// src/features/usage/record.ts
Acc.calls: Call[]; Acc.lastCall: number /* index of the newest row, -1 none */; Acc.t0: number /* first activity (epoch ms), 0 unknown */
export function tool(a: Acc, d: Day, name: string, model: string, mq: number): TS; // appends one row; model "" → -1
export function file(a: Acc, d: Day, name: string, path: string, add: number, del: number): void; // + attaches path to a.lastCall when that row's tool is `name`
// src/features/usage/calls.ts
Pend.row: Call | null  // done() sets row.ms/err/out; retool() renames row.tool
```
`Call.cid` and `Acc.t0` are part of the spec's data model (spec §4, decision 7). Triage needs `cid` to jump to a call (`enter` on a call row) and `t0` for the session start hour. Compare needs `t0` for "wall time" and "previous session". They belong to this spec's one `VERSION` bump.

- [ ] **Step 1: Failing check — rows from primitives.** Append to `src/features/usage/record.check.ts`:
```ts
import { DICT, nameOf, MQ_MSG, MQ_SESS, localOf, extOf } from "./facts.ts";
import { done } from "./calls.ts";
import { file, patchLines } from "./record.ts";
const b = newAcc(); const iso2 = "2026-10-01T10:00:05.000Z"; const d2 = bucket(b, 0, iso2);
pend(b, d2, tool(b, d2, "Bash", "claude-opus-4-5", MQ_MSG), "Bash", "t1", Date.parse(iso2), iso2, "npm test", ["npm test && git status"]);
const r0 = b.calls[0];
ok("row appended", b.calls.length === 1 && b.lastCall === 0, String(b.calls.length));
ok("row tool/model/mq", !!r0 && nameOf(DICT.tool, r0.tool) === "Bash" && nameOf(DICT.model, r0.model) === "claude-opus-4-5" && r0.mq === MQ_MSG, "");
ok("row progs", !!r0 && r0.progs.map((i) => nameOf(DICT.prog, i)).join(",") === "npm,git", r0 ? r0.progs.join(",") : "");
ok("row t from iso", !!r0 && r0.t === Date.parse(iso2), r0 ? String(r0.t) : "");
ok("row open", !!r0 && r0.err === -1 && r0.ms === -1 && r0.cid === "t1", "");
const pp = b.pend.get("t1"); if (pp) done(pp, 1200, true, 42, "t1", []);
ok("row closed", !!r0 && r0.err === 1 && r0.ms === 1200 && r0.out === 42, r0 ? [r0.err, r0.ms, r0.out].join(",") : "");
tool(b, d2, "Edit", "", MQ_SESS); file(b, d2, "Edit", "/w/src/a.TS", 3, 1);
const r1 = b.calls[1];
ok("unknown model", !!r1 && r1.model === -1, "");
ok("file attached", !!r1 && r1.files.map((i) => nameOf(DICT.file, i)).join(",") === "/w/src/a.TS", "");
ok("ext", extOf("/w/src/a.TS") === "ts" && extOf("/w/.bashrc") === "" && extOf("/w/Makefile") === "", "");
file(b, d2, "Write", "/w/other.md", 1, 0); // tool name differs from the newest row: day counter only
ok("file not attached to other tool", !!r1 && r1.files.length === 1, "");
tool(b, d2, "apply_patch", "gpt-5", MQ_SESS); patchLines(b, d2, "apply_patch", "*** Update File: x.go\n+a\n*** Add File: y.go\n+b\n");
ok("patch files attached", b.calls[2].files.length === 2, String(b.calls[2].files.length));
// retool renames the row of a pending call
pend(b, d2, tool(b, d2, "mcp", "m1", MQ_MSG), "mcp", "c9", 0, iso2, "", []);
const p9 = b.pend.get("c9"); if (p9) retool(b, p9, "mcp__s__t");
ok("retool renames row", nameOf(DICT.tool, b.calls[3].tool) === "mcp__s__t", "");
// kiro-style: no call time → the bucket's time
const k = newAcc(); const kd = bucket(k, 1759312800000, ""); pend(k, kd, tool(k, kd, "shell", "", MQ_SESS), "shell", "u1", 0, "", "", []);
ok("row t falls back to bucket ms", k.calls[0].t === 1759312800000, String(k.calls[0].t));
ok("t0 first activity", k.t0 === 1759312800000 && b.t0 === Date.parse(iso2), [k.t0, b.t0].join(","));
ok("localOf memo", localOf(Date.parse(iso2)).hour === new Date(iso2).getHours(), "");
```
Also update the existing calls in this file to the new `tool(a, d, name, "", MQ_SESS)` signature.

- [ ] **Step 2: Run** `scriptc build src/features/usage/record.check.ts -o /tmp/rc && /tmp/rc`. Expected: BUILD FAIL (`facts.ts` not found / `tool` arity).

- [ ] **Step 3: Implement `facts.ts`.**
```ts
// agentglass — per-call fact rows: compact call records with dictionary-encoded strings, shared by filters, triage, compare
// SPDX-License-Identifier: Apache-2.0
import { dayKey } from "./record.ts";
export const MQ_MSG = 0; export const MQ_TURN = 1; export const MQ_SESS = 2;
export interface Call { t: number; tool: number; model: number; mq: number; progs: number[]; cmds: number[]; files: number[]; ms: number; err: number; out: number; cid: string }
export interface Dict { ids: Map<string, number>; names: string[] }
function newDict(): Dict { return { ids: new Map<string, number>(), names: [] }; }
export const DICT = { tool: newDict(), model: newDict(), prog: newDict(), cmd: newDict(), file: newDict() };
export function intern(d: Dict, s: string): number { if (!s) return -1; const i = d.ids.get(s); if (i !== undefined) return i; d.names.push(s); d.ids.set(s, d.names.length - 1); return d.names.length - 1; }
export function nameOf(d: Dict, i: number): string { return i >= 0 && i < d.names.length ? d.names[i] : ""; }
export function extOf(p: string): string { const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); return i > 0 && i < b.length - 1 ? b.slice(i + 1).toLowerCase() : ""; }
export interface Local { day: string; hour: number; wd: number }
const memo = new Map<number, Local>(); // per UTC hour: local day/hour only change on hour boundaries (all real time zones are whole or half hours → key by half hour)
export function localOf(t: number): Local {
  const k = Math.floor(t / 1800000); const hit = memo.get(k); if (hit) return hit;
  const d = new Date(k * 1800000); const v = { day: dayKey(d), hour: d.getHours(), wd: d.getDay() };
  if (memo.size > 20000) memo.clear(); memo.set(k, v); return v;
}
```
(The memo uses half-hour keys because some zones have a :30 offset. `record.ts` imports `facts.ts`, which imports `dayKey` back. scriptc resolves cycles of plain functions. If the build rejects it, move `two`/`dayKey` into `facts.ts` and re-export them from `record.ts`.)

- [ ] **Step 4: Implement the record changes.**
  - `Acc`: add `calls: Call[]; lastCall: number; t0: number`. `newAcc()` sets `calls: [], lastCall: -1, t0: 0`. `accIn` (`codec.ts` after honest-costs) must set the same defaults now (`calls: [], lastCall: -1, t0: num(o["t0"])`, persisted in Task 3), or the build fails.
  - `bucket()`: next to `tsKey/tsDay/tsHour`, keep `let tsIso = ""; let tsMs = 0;`. Set them on every call (`tsIso = iso; tsMs = iso ? 0 : (ms > 0 ? ms : 0)`). When `a.t0 === 0`, set `a.t0 = iso ? isoMs(iso) : ms > 0 ? ms : 0`. Lines arrive in order, so the first real timestamp is the start. The `Date.now()` fallback does not count as activity.
  - `tool(a, d, name, model, mq)`: keep today's body, then
```ts
  const t = tsIso ? isoMs(tsIso) : tsMs;
  a.calls.push({ t: t > 0 ? t : Date.now(), tool: intern(DICT.tool, name), model: intern(DICT.model, model), mq, progs: [], cmds: [], files: [], ms: -1, err: -1, out: 0, cid: "" });
  a.lastCall = a.calls.length - 1;
```
  - `pend(...)`: `const row = a.lastCall >= 0 && a.lastCall < a.calls.length ? a.calls[a.lastCall] : null;`. For each normalized command, push distinct `intern(DICT.prog, program(n))` / `intern(DICT.cmd, n)` into `row.progs`/`row.cmds` (skip ids already present). Then `if (row) row.cid = id;` before the `if (!id) return;`. Store `row` in the `Pend` (`a.pend.set(id, { …, row })`).
  - `retool`: after moving the count, `if (p.row) p.row.tool = intern(DICT.tool, name);`.
  - `file(a, d, name, path, add, del)`: today's body, plus `const r = a.lastCall >= 0 && a.lastCall < a.calls.length ? a.calls[a.lastCall] : null; if (r && nameOf(DICT.tool, r.tool) === name) { const fi = intern(DICT.file, path); if (r.files.indexOf(fi) < 0) r.files.push(fi); }`.
  - `patchLines`: call `file(a, d, name, …)`.
  - `calls.ts`: `Pend` gets `row: Call | null` (`import type { Call } from "./facts.ts"`). In `done()`, `const r = p.row; if (r) { r.err = err ? 1 : 0; r.ms = ms >= 0 && ms < 86400000 ? ms : -1; r.out = out; }`.
- [ ] **Step 5: Adapters, mechanical step.** Every `tool(a, d, name)` becomes `tool(a, d, name, "", MQ_SESS)` (Task 2 puts in the real models). Every `file(d, …)` becomes `file(a, d, …)`: claude.ts:122, fx.ts:92-93, gemini.ts:324, pi.ts:286, opencode.ts:357, kiro.ts:138. `opencode.ts:357` lives in `useTool(a, d, …)` and `a` is in scope. Check: `grep -n "file(d," src/harness/*.ts` → no hits.
- [ ] **Step 6: Failing parity check** in `src/harness/harness.check.ts`. Inside the existing SAMPLES loop (it builds an `Acc` per sample and feeds `harnessOf(x.h).usage(a, l)`), add:
```ts
let tn = 0; let te = 0; let tdn = 0;
for (const dd of a.days.values()) for (const st of dd.tt.values()) { tn += st.n; te += st.err; tdn += st.dn; }
let rn = 0; let re = 0; let rdn = 0; for (const c of a.calls) { rn++; if (c.err === 1) re++; if (c.ms >= 0) rdn++; }
ok(x.h + " rows = TS.n", rn === tn && rn === a.tools, rn + " vs " + tn);
ok(x.h + " rows err = TS.err", re === te, re + " vs " + te);
ok(x.h + " rows timed = TS.dn", rdn === tdn, rdn + " vs " + tdn);
```
Run the check from Step 7 with the old `done()` (no row write) to see it fail on err/dn. Then keep the Step 4 version.
- [ ] **Step 7: Run** `scriptc build src/features/usage/record.check.ts -o /tmp/rc && /tmp/rc && scriptc build src/harness/harness.check.ts -o /tmp/hc && /tmp/hc` → `all checks passed` for both. Then also run `pi.check.ts`, `gemini.check.ts`, `opencode.check.ts`, `opencode-http.check.ts`, `kiro.check.ts`, and `./build.sh && sh scripts/check.sh` → all ok. Then `./agentglass --json --subagents --limit 400 | diff <(jq -S 'map(del(.updated,.bytes,.activity,.live,.pid,.status,.attention,.stuck))' $SCRATCH/json-before.json) <(jq -S 'map(del(.updated,.bytes,.activity,.live,.pid,.status,.attention,.stuck))' -)` → no diff (no visible change yet).
- [ ] **Step 8: Commit** `git add src/features/usage src/harness && git commit -m "feat(usage): per-call fact rows in the ledger (tool, programs, commands, files, status, duration)"`.

---

### Task 2: The issuing message's model on every row

**Files:**
- Modify: `src/harness/claude.ts:96-123`, `gemini.ts:298-325`, `pi.ts:212-245,275-277`, `opencode.ts:335-377`, `codex.ts:103-110`, `fx.ts:84-85,96-100`, `kiro.ts:129`
- Create: `src/harness/model.check.ts`

**Interfaces — Consumes:** `tool(a, d, name, model, mq)`, `MQ_*`, `DICT`, `nameOf` (Task 1). **Produces:** rows whose `model`/`mq` follow spec §4.1:

| harness | row model | `mq` |
|---|---|---|
| claude | `str(m["model"])` of the line holding the `tool_use`; `<synthetic>` → `""` | `MQ_MSG` |
| gemini | `str(o["model"])` of the `gemini` record | `MQ_MSG` |
| pi | `str(m["responseModel"]) \|\| str(m["model"])` of the assistant message. Nested calls use the parent call row's model, captured before `a.pend.delete(id)` | `MQ_MSG` |
| opencode | 1.x part row: `str(o["model"])` (= `modelID`). 2.x JSON: `m ? str(m["id"]) : ""` of the assistant row | `MQ_MSG` |
| codex | `a.model` (the latest `turn_context`) | `MQ_TURN` |
| fx | `a.model`, set from `s.model` (`fx.ts:63`) at the top of `usageSidecar` (the ledger always runs the sidecar before `step`, `ledger.ts:74,93`) | `MQ_SESS` |
| kiro | `""` | `MQ_SESS` |

`a.model` keeps its current meaning everywhere else.

- [ ] **Step 1: Failing check** `src/harness/model.check.ts`. Hand-written lines in real shapes. Each harness switches model between two tool-calling messages:
```ts
// agentglass — per-message model on call rows: scriptc build src/harness/model.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
import { newAcc } from "../features/usage/record.ts";
import { DICT, nameOf, MQ_MSG, MQ_TURN, MQ_SESS } from "../features/usage/facts.ts";
import { newSess } from "../model/types.ts";
import { harnessOf } from "./index.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function rows(h: string, lines: string[]): string { const a = newAcc(); for (const l of lines) harnessOf(h).usage(a, l); return a.calls.map((c) => nameOf(DICT.tool, c.tool) + "@" + (nameOf(DICT.model, c.model) || "?") + "/" + String(c.mq)).join(" "); }
const T = "\"timestamp\":\"2026-01-02T10:00:0";
// claude: fallback iteration — the second message is answered by sonnet; usage block of a repeated id is skipped but its tool row still gets its model; <synthetic> → unknown
ok("claude", rows("claude", [
  "{\"type\":\"assistant\"," + T + "1Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
  "{\"type\":\"assistant\"," + T + "2Z\",\"message\":{\"id\":\"m2\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"Read\",\"input\":{\"file_path\":\"/a\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
  "{\"type\":\"assistant\"," + T + "3Z\",\"message\":{\"id\":\"m2\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t3\",\"name\":\"Grep\",\"input\":{}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
  "{\"type\":\"assistant\"," + T + "4Z\",\"message\":{\"id\":\"m3\",\"model\":\"<synthetic>\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t4\",\"name\":\"Bash\",\"input\":{}}]}}",
]) === "Bash@claude-opus-4-5/" + MQ_MSG + " Read@claude-sonnet-4-5/" + MQ_MSG + " Grep@claude-sonnet-4-5/" + MQ_MSG + " Bash@?/" + MQ_MSG, "claude");
// codex: model per turn_context
ok("codex", rows("codex", [
  "{" + T + "0Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5\"}}",
  "{" + T + "1Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"ls\\\"]}\",\"call_id\":\"c1\"}}",
  "{" + T + "2Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}",
  "{" + T + "3Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"pwd\\\"]}\",\"call_id\":\"c2\"}}",
]) === "shell@gpt-5/" + MQ_TURN + " shell@gpt-5-codex/" + MQ_TURN, "codex");
```
Add one block per remaining harness in the same style:
  - **gemini**: two `{"type":"gemini","model":"gemini-2.5-pro",…,"toolCalls":[{…"status":"success"}]}` records, the second with `gemini-2.5-flash` → `run_shell_command@gemini-2.5-pro/0 read_file@gemini-2.5-flash/0`.
  - **pi**: an assistant message with `responseModel:"claude-sonnet-4-5"` + `toolCall bash`, then `{"type":"model_change","modelId":"gpt-5"}`, then an assistant message with `model:"gpt-5"` + `toolCall codemode`, then its `toolResult` with `nestedCalls.calls:[{id:"n1",name:"read",status:"ok",durationMs:3}]` → `bash@claude-sonnet-4-5/0 codemode@gpt-5/0 read@gpt-5/0`.
  - **opencode** 1.x rows: `{"v1":1,"role":"assistant","model":"anthropic/claude-opus-4-5","t":…,"part":{"type":"tool",…}}`, then `"model":"openai/gpt-5"` → each row its own model. 2.x JSON line `{"type":"assistant","model":{"id":"gpt-5"},"content":[{"type":"tool",…}]}` → `gpt-5`.
  - **fx**: build `const s = newSess("fx", "f1", "/tmp/none/events.jsonl", false); s.model = "fx-large";`. Call `harnessOf("fx").usageSidecar` through a local with `(s, a)` before the usage lines (the stat fails, but `a.model` must be set first) → rows `shell@fx-large/2`.
  - **kiro**: one `AssistantMessage` with a `toolUse` → `shell@?/2`.
  End with `console.log(bad ? bad + " failed" : "per-message model: all checks passed"); if (bad) process.exit(1);`.
- [ ] **Step 2: Run** `scriptc build src/harness/model.check.ts -o /tmp/mc && /tmp/mc`. Expected FAIL: every row is `@?/2`.
- [ ] **Step 3: Implement per adapter.**
  - claude `usage()`: right after `const m = …` add `const md0 = str(m["model"]); const rowModel = md0 === "<synthetic>" ? "" : md0;`. At line 112 use `tool(a, d, name, rowModel, MQ_MSG)`.
  - gemini line 312: `tool(a, d, name, md, MQ_MSG)`.
  - pi: `callStats(a, d, name, id, inp, iso, t, model: string)`. In the assistant branch (240-244) compute `const md = str(m["responseModel"]) || str(m["model"])` once, pass it to `book` and to every `callStats`. In the toolResult branch, before `a.pend.delete(id)`, capture `const pm = p && p.row ? nameOf(DICT.model, p.row.model) : "";` and pass it to the nested `callStats` (line 232). `callStats` calls `tool(a, d, name, model, MQ_MSG)`.
  - opencode: `useTool(a, d, name, id, st, t0, t1, model: string)`. Line 367 passes `str(o["model"])`, line 377 passes `m ? str(m["id"]) : ""`. Inside, `tool(a, d, name, model, MQ_MSG)`.
  - codex line 110: `tool(a, d, name, a.model, MQ_TURN)`.
  - fx: first line of `usageSidecar`: `if (s.model) a.model = s.model;`. Line 85: `tool(a, d, name, a.model, MQ_SESS)`.
  - kiro line 129: `tool(a, d, name, "", MQ_SESS)` (unchanged from Task 1, now on purpose; add the comment `// kiro logs no model`).
- [ ] **Step 4: Run** the model check → `per-message model: all checks passed`. Then `./build.sh && sh scripts/check.sh` → all ok. Re-run the Task 1 `--json` diff → no diff.
- [ ] **Step 5: Commit** `git commit -am "feat(usage): call rows carry the model of the message that issued them"` (add `src/harness/model.check.ts`).

---

### Task 3: Calls cache files, retention, VERSION bump

**Files:**
- Create: `src/features/usage/callcache.ts`, `src/features/usage/callcache.check.ts`
- Modify: the ledger codec — `src/features/usage/codec.ts` after honest-costs Task 3 moved `VERSION`, `accOut`/`accIn` there from `cache.ts:15,52-72` (`VERSION`; accOut/accIn: `t0`) — and `src/features/usage/cache.ts:74-95` (load/save), `src/util/config.ts:9-24` (`intOf`, `intSetting`; mode 0600), `src/features/usage/record.ts` (export `callDays`)

**Interfaces — Produces:**
```ts
// src/features/usage/callcache.ts
export function pathKey(path: string): string;  // 16 lowercase hex chars, two FNV-1a 32-bit hashes (offset bases 2166136261 and 3735928559)
export function encodeCalls(path: string, a: Acc): string;   // {"v":2,"path","off","tool","model","prog":[names],"cmd"/"file":[refs],"cmdp"/"filep":[prefix lengths],"cmdl"/"filel":[rests],"cp":id prefix,"t":[deltas],"to","mo","mq","pg":[[…]],"cm":[[…]],"fi":[[…]],"ms","er","ou","ci":[id suffixes]} — local dictionaries; command/file texts as FNV-1a hashes of the session's Day.cmds/Day.files keys (ref ≥ 0), else front-coded literals (ref = -1 - index) (review: 41% smaller)
export function decodeCalls(body: string, path: string, a: Acc): Call[] | null; // a = the session's ledger entry (off + day counters the refs resolve against); null = missing/corrupt/other path/other off/unresolvable ref → caller re-indexes the session
export function prune(a: Acc, cutoff: number): boolean;      // drops rows with t < cutoff, fixes a.lastCall (-1 if the newest went); true = rows removed
export function callDays(): number;                           // intSetting("filter", "callDays", 1, 0, 90)
export const CALLS_DIR: string;                               // ~/.agentglass/cache/calls
// src/util/config.ts — shared int settings (repo-view repo.idleGapMin, git-linkage git.tailPadMin, related-events related.*)
export function intOf(v: unknown, lo: number, hi: number, def: number): number;   // pure: an integer in [lo, hi] (hi 0 = no upper bound), else def
export function intSetting(sec: string, key: string, lo: number, hi: number, def: number): number; // intOf(section(sec)[key], …), cached per "sec.key"; invalid → def + one startup toast
```
Toast text (exact): `config <sec>.<key> must be an integer ≥ <lo> — using <def>` when `hi` is 0, else `config <sec>.<key> must be an integer <lo>–<hi> — using <def>`. A missing key is not invalid (no toast).
- [ ] **Step 1: Failing check** `callcache.check.ts`:
```ts
import { newAcc, bucket, tool, pend } from "./record.ts";
import { MQ_MSG, DICT, nameOf } from "./facts.ts";
import { pathKey, encodeCalls, decodeCalls, prune } from "./callcache.ts";
// key: 16 hex, stable, differs for near paths
ok("key shape", /^[0-9a-f]{16}$/.test(pathKey("/a/b.jsonl")), pathKey("/a/b.jsonl"));
ok("key stable/distinct", pathKey("/a/b.jsonl") === pathKey("/a/b.jsonl") && pathKey("/a/b.jsonl") !== pathKey("/a/c.jsonl"), "");
// round trip
const a = newAcc(); a.off = 900; const iso = "2026-10-01T10:00:00.000Z"; const d = bucket(a, 0, iso);
pend(a, d, tool(a, d, "Bash", "claude-opus-4-5", MQ_MSG), "Bash", "t1", 0, iso, "", ["npm test"]);
tool(a, d, "Read", "", MQ_MSG);
const body = encodeCalls("/s/x.jsonl", a);
const back = decodeCalls(body, "/s/x.jsonl", 900);
ok("round trip", !!back && back.length === 2 && nameOf(DICT.tool, back[0].tool) === "Bash" && nameOf(DICT.model, back[0].model) === "claude-opus-4-5" && back[1].model === -1 && back[0].cid === "t1" && nameOf(DICT.prog, back[0].progs[0] ?? -1) === "npm", body.slice(0, 200));
ok("off mismatch → null", decodeCalls(body, "/s/x.jsonl", 901) === null, "");
ok("foreign path → null", decodeCalls(body, "/s/y.jsonl", 900) === null, "");
ok("corrupt → null", decodeCalls(body.slice(0, 40), "/s/x.jsonl", 900) === null && decodeCalls("", "/s/x.jsonl", 900) === null, "");
// retention
const old = newAcc(); const od = bucket(old, Date.parse("2026-01-01T10:00:00Z"), ""); tool(old, od, "Bash", "", MQ_MSG);
const nd = bucket(old, Date.parse("2026-10-01T10:00:00Z"), ""); tool(old, nd, "Read", "", MQ_MSG);
ok("prune drops old rows", prune(old, Date.parse("2026-07-01T00:00:00Z")) && old.calls.length === 1 && old.lastCall === 0, String(old.calls.length));
ok("prune no-op", !prune(old, Date.parse("2026-07-01T00:00:00Z")), "");
```
Plus a config check of the pure `intOf` (`src/util/config.ts`). Cases with `(lo 1, hi 0, def 90)`: `90` → 90, `7` → 7, `0`/`-1`/`1.5`/`"30"`/`null` → 90; with `(1, 60, 5)`: `60` → 60, `61` → 5.
- [ ] **Step 2: Run** `scriptc build src/features/usage/callcache.check.ts -o /tmp/cc && /tmp/cc` → BUILD FAIL.
- [ ] **Step 3: Implement `callcache.ts`.** FNV (same arithmetic as `pricing.ts:36`, which already builds), hex by shifts (no `toString(16)`, no `Math.pow`):
```ts
function fnv(s: string, h0: number): number { let h = h0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const HEX = "0123456789abcdef";
function hex8(n: number): string { let o = ""; for (let i = 28; i >= 0; i -= 4) o += HEX.charAt((n >>> i) & 15); return o; }
export function pathKey(p: string): string { return hex8(fnv(p, 2166136261)) + hex8(fnv(p, 3735928559)); }
``` Encode: build local dicts by walking rows (`Map<number, number>` global id → local index), write column arrays, `JSON.stringify`. Decode: `parse()`, check `v === 1 && path === path && off === off`, check that all column arrays have the same length, and re-intern the local names into `DICT`. Any mismatch → `null`.
- [ ] **Step 4: Wire into `cache.ts`.**
  - `VERSION` → next free number, with the comment `// N: per-call rows (calls/<key>.json), Acc.t0`.
  - `accOut` writes `t0`; `accIn` reads it.
  - `load()`: after `ledger.set(path, accIn(o))`, read `join(CALLS_DIR, pathKey(path) + ".json")` (size-checked `readText`). Run `decodeCalls(body, path, acc.off)`. On `null`, `ledger.delete(path)`, so that session alone re-indexes. Otherwise set `acc.calls` and `acc.lastCall = calls.length - 1`. Keep `written.set(path, acc.off)`.
  - `save()`: before writing `ledger.json`, `const cutoff = startOfDay() - (callDays() - 1) * 86400000;`. For each session with an Acc and `a.off > 0`: `const pr = prune(a, cutoff)`. If `pr || written.get(path) !== a.off`, write `calls/<key>.json` atomically (tmp + rename, same pattern as `cache.ts:88-94`) and set `written`. Then remove every file in `CALLS_DIR` whose name is not `pathKey` of a current session (`listDir`, `unlinkSync`, try/catch). The calls files are written **before** `ledger.json`. A crash in between leaves a newer `off` in the calls file → mismatch → re-index. That is correct.
  - `config.ts`: `intOf` + `intSetting` (cache `Map<string, number>` keyed `sec + "." + key`; on an invalid present value `say("warn", <toast text above>)` once). `callDays()` = `intSetting("filter", "callDays", 1, 0, 90)` → toast `config filter.callDays must be an integer ≥ 1 — using 90`.
  - `config.ts` `setConfig`: create the tmp file with the existing file's mode, or `0o600` if `config.json` does not exist yet (per the Task 0 probe: `openSync(tmp, "w", mode)` or `chmod` after rename).
- [ ] **Step 5: Failing → passing reload check.** Add an end-to-end case to `callcache.check.ts` with a temp dir: write a calls file via a `saveCallsTo(dir, path, a)` helper exported for tests, read it back via `loadCallsFrom(dir, path, off)`, delete it → `null`. Run → PASS. `./build.sh && sh scripts/check.sh` → ok.
- [ ] **Step 6: Real run.** `cp -a ~/.agentglass/cache $SCRATCH/cache-backup`. Start the TUI, wait for `✔ indexed` in Stats, quit. Then `ls ~/.agentglass/cache/calls | wc -l` ≈ number of sessions. `du -sh ~/.agentglass/cache/calls` ≈ 5–10 MB. Note the numbers for Task 11. Start again: Stats shows `✔ indexed` within one tick (no re-index).
- [ ] **Step 7: Commit** `feat(usage): persist call rows per session with 90-day retention; ledger cache version bump`.

---

### Task 4: Tokenizer, parser, printer, errors

**Files:**
- Create: `src/features/query/types.ts`, `src/features/query/parse.ts`, `src/features/query/attrs.ts` (registry metadata only: keys, aliases, entity, type, multi, enum values), `src/features/query/parse.check.ts`

**Interfaces — Produces:**
```ts
// types.ts
export type Ent = "session" | "day" | "call" | "event";
export type AType = "enum" | "text" | "path" | "bool" | "usd" | "tok" | "num" | "ratio" | "dur" | "size" | "date";
// op ∈ is | is_not | is_one_of | is_not_one_of | ~ | !~ | > | >= | < | <=  (= and != are parsed and printed as is / is_not)
// neg: "not"/"-" before a numeric clause (not cost > 2 matches unknown cost too); other negations fold into the inverse op
export interface Clause { key: string; op: string; vals: string[]; neg: boolean; pinned: boolean }
export interface QErr { msg: string; col: number /* 0-based column into the input */ }
export interface Parsed { cs: Clause[]; err: QErr | null; notes: string[] /* semantic warnings, e.g. merged same-key clauses */ }
export interface Val { n: number; ss: string[]; unk: boolean }   // numeric value, or lowercase strings (multi), unk = unknown
export interface Attr { key: string; aliases: string[]; ent: Ent; type: AType; multi: boolean; enumVals: string[]; enumFn: string /* "" or "harness" | "state" | "status" | "event" | "weekday" */; ops: string[] /* [] = the type's default ops; else only these */ }
// parse.ts
export function parse(src: string): Parsed;
export function print(cs: Clause[]): string;          // canonical, ANDed with " and "
export function printClause(c: Clause): string;
export function caret(src: string, e: QErr): string;  // "<src>\n<spaces>^"
export function sameClause(a: Clause, b: Clause): boolean;
// attrs.ts
export function attrOf(keyOrAlias: string): Attr | null;
export function register(a: Attr): void;              // later specs: turns, billing, session (compare), repo refinements
export function keys(): string[];                     // canonical keys in registry order (help text, completion)
export function enumValues(a: Attr): string[];        // harness ids from harnessIds(), else a.enumVals
export function canonEnum(a: Attr, v: string): string; // "OpenCode" → "opencode"; "" if invalid
```
- [ ] **Step 1: Failing table check** `parse.check.ts`. Each row is `[input, canonical or "", error message or "", error col]`:
```ts
const CASES: [string, string, string, number][] = [
  ["foo", "text ~ foo", "", 0],
  ["foo bar", "text ~ foo and text ~ bar", "", 0],
  ["\"foo bar\"", "text ~ \"foo bar\"", "", 0],
  ["-foo", "text !~ foo", "", 0],
  ["repo is agentglass", "repo is agentglass", "", 0],
  ["project = agentglass", "repo is agentglass", "", 0],
  ["h is OpenCode", "harness is opencode", "", 0],
  ["harness is nope", "", "harness is one of claude, codex, fx, pi, opencode, kiro, gemini — got \"nope\"", 11],
  ["tool is_one_of Bash Edit", "tool is_one_of Bash Edit", "", 0],
  ["tool is_one_of Bash Edit cost > 2", "tool is_one_of Bash Edit and cost > 2", "", 0],
  ["tool is_one_of Bash Edit, foo", "tool is_one_of Bash Edit and text ~ foo", "", 0],
  ["tool is_one_of Bash \"tool\"", "tool is_one_of Bash \"tool\"", "", 0],   // a value equal to a key prints quoted
  ["tool is_not_one_of Read Grep", "tool is_not_one_of Read Grep", "", 0],
  ["cost > 2", "cost > 2", "", 0],
  ["cost>2", "cost > 2", "", 0],
  ["cost > $0.50", "cost > $0.50", "", 0],
  ["cost > abc", "", "\"cost\" needs a number (e.g. cost > 2, cost > $0.50), got \"abc\"", 7],
  ["cost is unknown", "cost is unknown", "", 0],
  ["not cost > 2", "not cost > 2", "", 0],
  ["-cost > 2", "not cost > 2", "", 0],
  ["not tool is Bash", "tool is_not Bash", "", 0],
  ["tool != Bash", "tool is_not Bash", "", 0],
  ["model ~ opus", "model ~ opus", "", 0],
  ["model !~ opus", "model !~ opus", "", 0],
  ["not model ~ opus", "model !~ opus", "", 0],
  ["tokens > 40k", "tokens > 40k", "", 0],
  ["tokens > 1.5M", "tokens > 1.5M", "", 0],
  ["out > 100KB", "out > 100KB", "", 0],
  ["duration > 30s", "duration > 30s", "", 0],
  ["duration >= 500ms", "duration >= 500ms", "", 0],
  ["age < 3d", "age < 3d", "", 0],
  ["error_rate > 20%", "error_rate > 20%", "", 0],
  ["error_rate > 0.2", "error_rate > 0.2", "", 0],
  ["day is today", "day is today", "", 0],
  ["day >= -7d", "day >= -7d", "", 0],
  ["day is 2026-10-01", "day is 2026-10-01", "", 0],
  ["day is 2026-13-01", "", "\"day\" needs a date (2026-10-01, today, yesterday, -7d), got \"2026-13-01\"", 7],
  ["weekday is mo", "weekday is mo", "", 0],
  ["hour >= 14", "hour >= 14", "", 0],
  ["status is error", "status is error", "", 0],
  ["status is failed", "", "status is one of ok, error, unknown — got \"failed\"", 10],
  ["live is true", "live is true", "", 0],
  ["not live is true", "live is_not true", "", 0],
  ["file is *.test.ts", "file is *.test.ts", "", 0],
  ["cwd is \"~/my code\"", "cwd is \"~/my code\"", "", 0],
  ["title ~ \"say \\\"hi\\\"\"", "title ~ \"say \\\"hi\\\"\"", "", 0],
  ["tol is Bash", "", "unknown key \"tol\" — did you mean tool?", 0],
  ["tool > 2", "", "\">\" does not apply to tool (text); use is, is_one_of, ~", 5],
  ["tool is Bash or tool is Edit", "", "\"or\" is not supported; use is_one_of (tool is_one_of Bash Edit)", 13],
  ["title ~ \"abc", "", "unterminated quote at column 9", 8],   // messages count columns from 1, QErr.col from 0
  ["tool is", "", "tool is …: needs a value", 5],
  ["content is_one_of a b", "", "content is_one_of is not supported; use two content ~ clauses", 8],
  ["TOOL IS Bash AND cost > 2", "tool is Bash and cost > 2", "", 0],
  ["tool is Bash, cost > 2", "tool is Bash and cost > 2", "", 0],
  ["foo tool is Bash", "text ~ foo and tool is Bash", "", 0],
  ["tool", "text ~ \"tool\"", "", 0],          // a key without an operator is text (today's / behaviour); printed quoted
  ["cwd ~ ~/code", "cwd ~ ~/code", "", 0],     // ~ as a value is not an operator
];
for (const [src, want, err, col] of CASES) {
  const p = parse(src);
  if (err) { eq("err " + src, p.err ? p.err.msg : "(none)", err); eq("col " + src, String(p.err ? p.err.col : -1), String(col)); continue; }
  eq("parse " + src, p.err ? "ERR " + p.err.msg : print(p.cs), want);
  const again = parse(print(p.cs)); eq("roundtrip " + src, print(again.cs), want);
}
eq("caret", caret("tol is Bash", { msg: "x", col: 0 }), "tol is Bash\n^");
```
The table above has 58 rows. Before Step 2, add the cases needed to reach the spec's ~80: every unit suffix (`k`, `M`, `KB`, `MB`, `ms`, `s`, `m`, `h`, `d`), `yesterday`, each weekday, `is_not` on bool, `state is busy`, `event is tool`, `agent is ""` (empty quoted value allowed), `ext is ts`, `server is github`, `program is npm`, `command ~ "npm test"`, `id ~ 3f2a`, and keyword case on every operator spelling.
- [ ] **Step 2: Run** `scriptc build src/features/query/parse.check.ts -o /tmp/pc && /tmp/pc` → BUILD FAIL.
- [ ] **Step 3: Implement.**
  - `attrs.ts` holds the spec §2 table as `register({...})` calls, in table order. Types: harness enum (`enumFn:"harness"`), repo text, cwd path, branch text, model text multi, title/id text, agent text, subagent/live/archived bool, state enum `stuck attention busy idle ended`, cost usd, tokens/tokens.* tok, tools/errors num, error_rate ratio, lines/lines.* num, age dur, text text, content text, day date (ent day), weekday enum `mo tu we th fr sa su`, day.cost usd/day.tokens tok/day.tools num (ent day), tool text, server text, program/command text multi (ent call), file path multi, ext text multi, status enum `ok error unknown`, duration dur, out size, hour num, event enum (ent event). Aliases: `h`→harness, `project`→repo.
  - Tokenizer: walk chars. Whitespace separates. `,` is its own token. `"…"` with `\"`/`\\` escapes → a quoted token (an unterminated quote → error at the quote's column). A bare word whose prefix is a known key or alias directly followed by one of `!=`, `!~`, `>=`, `<=`, `=`, `~`, `>`, `<` splits into key/op/rest (`cost>2`). Each token keeps its start column.
  - Parser loop. Optional `not`/`-` prefix: a `-word` token that is not `-<num><unit>` after an operator, where `word` is a key followed by an op token, means negation. A clause starts when `attrOf(tok)` is set **and** the next token is an operator word/symbol (case-insensitive: `is`, `is_not`, `is_one_of`, `is_not_one_of`, `=`, `!=`, `~`, `!~`, `>`, `>=`, `<`, `<=`). Otherwise the token is a text term. `and` and `,` are skipped between terms. `or` → error. `is_one_of` consumes values until `and`, `,`, the end, or a token that starts a new clause (key + op). A quoted token is always a value. Validate the op against `attr.ops` when non-empty (error `"<op>" does not apply to <key>; use <ops joined by ", ">`), else against the type: text/path/enum allow `is is_not is_one_of is_not_one_of ~ !~`; bool allows `is is_not`; numeric types allow `is is_not > >= < <=`, and `is unknown` is allowed for usd/dur. Validate values by type (unit regexes per §1.6). Unknown keys: a token followed by an op whose key is unknown → `unknown key "…" — did you mean <best>?` (Levenshtein ≤ 2 over keys + aliases; omit the hint when none). Negation folding: `is`↔`is_not`, `~`↔`!~`, `is_one_of`↔`is_not_one_of`; numeric ops keep the op and set `neg`.
  - Printer: `printClause` = `(neg ? "not " : "") + key + " " + op + " " + vals.map(q).join(" ")`. `q(v)` quotes when `v` is empty, contains whitespace, `"`, `,`, or equals a key/alias/keyword, and escapes `\` and `"`. Text terms print as `text ~ v` / `text !~ v`. Enum values print canonicalized.
- [ ] **Step 4: Run** → PASS. `./build.sh && sh scripts/check.sh` → ok.
- [ ] **Step 5: Commit** `feat(query): filter grammar — tokenizer, parser, canonical printer, errors with columns`.

---

### Task 5: Attribute accessors, projectOf, compile + lifting

**Files:**
- Create: `src/features/query/project.ts`, `src/features/query/eval.ts`, `src/features/query/fixture.ts` (test fixture, exported for triage/compare checks), `src/features/query/eval.check.ts`
- Modify: `src/features/query/attrs.ts` (accessors)

**Interfaces — Consumes:** Tasks 1–4. **Produces (exact):**
```ts
// project.ts — repo-view later replaces the body, keeping the signature
export function projectRoot(cwd: string): string; // the nearest dir with .git walking up (a .git *file* "gitdir: X/.git/worktrees/N" → X); "" when none; cached per cwd
export function projectOf(cwd: string): string;   // basename(projectRoot(cwd)) or, without a repo, basename(cwd); "" for ""
// eval.ts
export type Ctx = "list" | "stats" | "json" | "watch" | "procs";
export interface Compiled {
  key: string;            // canonical text + resolved relative dates ("…|2026-10-02"): cache key
  cs: Clause[];           // the clauses compiled (pinned flags kept)
  sess: ((s: Sess) => boolean)[];
  day: ((s: Sess, dk: string, d: Day) => boolean)[];
  call: ((s: Sess, c: Call) => boolean)[];
  event: ((s: Sess, kind: string, tool: string, args: string) => boolean)[];
  content: Clause[];      // content ~ / !~ clauses (Task 8 runs the search)
  dayKeys: Set<string> | null;   // day/weekday clauses resolved against known day keys; null = no day restriction
  needsCalls: boolean;    // any call clause
  dimmed: Clause[];       // clauses that do not apply in this ctx (procs: all but harness/repo/cwd/live)
}
export function compile(cs: Clause[], ctx: Ctx): { f: Compiled | null; err: QErr | null };
export const EMPTY: Compiled;                       // matches everything
export function matchSession(f: Compiled, s: Sess, days: string[] | null): boolean; // lifting per spec §3; days null = all of the session's days
export function sessMatches(f: Compiled, s: Sess): boolean;          // session clauses only, no day/call lifting (rules-config rule scope, cheap CLI pre-pass)
export function dayMatches(f: Compiled, s: Sess, dk: string, d: Day): boolean; // one day bucket: f.dayKeys membership (null = any) ∧ every f.day predicate; no session/call clauses (repo-view pairs it with sessMatches)
export function callMatches(f: Compiled, s: Sess, c: Call): boolean; // one row: f.sess ∧ f.day on the row's day bucket ∧ f.call (rules-config call metrics)
export function eachCall(f: Compiled, days: string[], fn: (s: Sess, c: Call) => void): void; // rows of sessions passing f.sess, on those days, passing f.day (their day) and f.call
export function callCutoff(): number;               // start of the oldest local day still holding rows (startOfDay() - (callDays()-1)·86400000)
export function sessVal(key: string, s: Sess): Val; // attribute value of a session (repo-view's tables and rules-config read these)
export function callVal(key: string, s: Sess, c: Call): Val;
// later specs add attributes: register(attr) for the metadata (Task 4) + extend() for behaviour.
// sess: value of a session-level attribute; resolve: canonicalize/validate one clause value at compile time ("" err = ok)
export interface Ext { sess: ((s: Sess) => Val) | null; resolve: ((v: string) => { v: string; err: string }) | null }
export function extend(key: string, x: Ext): void;  // session-compare registers `session`, honest-costs `billing`, parsing-fixes `turns`
// fixture.ts — used by eval/agg/scope checks here and by triage/compare checks
export function fxReset(): void;                                           // clears sessions, ledger, DICT stays
export function isoAt(daysAgo: number, hh: number, mm: number): string;    // local wall time → ISO string
export function fxSession(h: string, id: string, cwd: string, parent: string, model: string, lines: string[]): Sess; // registers in sessions + ledger via the adapter's usage(); sets s.size/mtime/last/cost/tools like ledger apply()
export function fxBase(): void;  // the standard fixture below
export function pathOf(id: string): string;  // the fixture path of a session id ("/fx/<harness>/<id>.jsonl")
```
**`fxBase()` contents.** The checks of Tasks 5, 6 and 9, triage and session-compare assert against these exact numbers. Keep this table and the fixture's header comment identical:

| session | harness | cwd | parent | model | calls (today unless noted), all in real line shapes |
|---|---|---|---|---|---|
| `c1` | claude | `/w/agentglass` | — | `claude-sonnet-4-5` (priced; usage 1000 in / 100 out per assistant line) | **yesterday 09:00**: Read `/w/agentglass/README.md` ok 0.1 s ×2 · **today 14:00**: Bash `ls` ok 2 s · Bash `make` **error** 1 s · Bash `sleep 100` no result (untimed, status unknown) · Edit `/w/agentglass/src/a.ts` ok 0.2 s (+2 −1) |
| `c1s` | claude | `/w/agentglass` | `c1` | `claude-sonnet-4-5` | today 14:05: Grep **error** 0.5 s |
| `x1` | codex | `/w/other` | — | `gpt-x-unpriced` via `turn_context` (no price → `s.cost = -1`; one `token_count` 500/50) | today 10:00: `exec` custom tool with `tools.exec_command({cmd:"npm test"}); tools.exec_command({cmd:"git status"})` ok 3 s · shell `npm run build` **error** 1 s |
| `k1` | kiro | `/w/k` | — | none | shell `ls` ok (untimed; kiro lines carry no time → today, `Acc.t0 = 0`) |

Derived numbers (today + yesterday): tools 10, errors 3. Tools: Bash 3/1, Edit 1/0, Grep 1/1, Read 2/0, exec 1/0, shell 2/1. Models (rows): `claude-sonnet-4-5` 7/2, `gpt-x-unpriced` 2/1, `unknown` 1/0. Codex programs (rows): `git` 1/0, `npm` 2/1. Unknown-cost sessions: `x1`. Error rates: c1 1/6, c1s 1/1, x1 1/2, k1 0/1.
- [ ] **Step 1: Failing check** `eval.check.ts` using `fxBase()`:
```ts
fxBase();
const S0 = (src: string): string[] => { const r = compile(parse(src).cs, "list"); const out: string[] = []; if (r.f) for (const s of sessions.values()) if (matchSession(r.f, s, null)) out.push(s.id); return out.sort().join(","); };
eq("harness", S0("harness is codex"), "x1");
eq("repo (basename fallback, no .git on disk)", S0("repo is agentglass"), "c1,c1s");
eq("same-call lifting", S0("tool is Bash and status is error"), "c1");
eq("same-call: error was a Grep, not a Bash", S0("tool is Read and status is error"), "");
eq("model per call", S0("model ~ sonnet and tool is Bash"), "c1");
eq("model unknown", S0("model is unknown"), "k1");
eq("cost unknown", S0("cost is unknown"), "x1");
eq("numeric never matches unknown", S0("cost < 1000"), "c1,c1s,k1");
eq("not numeric matches unknown", S0("not cost > 1000"), "c1,c1s,k1,x1");
eq("day lifting", S0("day is yesterday"), "c1");
eq("day + call same day", S0("day is yesterday and tool is Bash"), "");
eq("duration unknown", S0("tool is Bash and duration is unknown"), "c1");
eq("program", S0("program is npm and status is error"), "x1");
eq("ext", S0("ext is ts"), "c1");
eq("subagent", S0("subagent is true"), "c1s");
const fb = compile(parse("model ~ sonnet and status is error").cs, "list").f ?? EMPTY;
const c1 = sessions.get(pathOf("c1")); const rowsOk: string[] = [];
if (c1) for (const c of accOf(c1).calls) if (callMatches(fb, c1, c)) rowsOk.push(nameOf(DICT.tool, c.tool));
eq("callMatches per row", rowsOk.join(","), "Bash");
eq("sessMatches ignores call clauses", c1 && sessMatches(compile(parse("harness is claude and tool is Nope").cs, "list").f ?? EMPTY, c1) ? "yes" : "no", "yes");
const fd = compile(parse("day is yesterday and harness is codex").cs, "stats").f ?? EMPTY; const ac1 = c1 ? accOf(c1) : null;
const dks = ac1 ? [...ac1.days.keys()].filter((k) => { const dd = ac1.days.get(k); return !!dd && !!c1 && dayMatches(fd, c1, k, dd); }) : [];
eq("dayMatches: day clauses only, ignores session clauses", dks.length === 1 && dks[0] === localOf(Date.parse(isoAt(1, 9, 0))).day ? "ok" : dks.join(","), "ok");
eq("text haystack", S0("agentglass"), "c1,c1s");
eq("error_rate", S0("error_rate > 40%"), "c1s,x1");
const w = compile(parse("duration > 1s").cs, "watch"); eq("watch rejects duration", w.err ? w.err.msg : "", "--watch: duration is known only after the call's result; filter result events with event is result instead");
const p = compile(parse("harness is pi and cost > 2").cs, "procs"); eq("procs dims", p.f ? p.f.dimmed.map(printClause).join("|") : "", "cost > 2");
eq("projectOf worktree", projectOf(WT), "mainrepo"); // WT: temp dir with a .git file "gitdir: <tmp>/mainrepo/.git/worktrees/wt"
eq("projectOf plain", projectOf("/nonexistent/abc"), "abc");
eq("projectRoot worktree", projectRoot(WT), TMP + "/mainrepo");
register({ key: "zz", aliases: [], ent: "session", type: "text", multi: false, enumVals: [], enumFn: "", ops: ["is"] });
extend("zz", { sess: (s: Sess) => ({ n: 0, ss: [s.id === "c1" ? "yes" : "no"], unk: false }), resolve: (v: string) => ({ v: v.toLowerCase(), err: v === "bad" ? "zz: bad value" : "" }) });
eq("extend: accessor + resolve", S0("zz is YES"), "c1");
const zb = compile(parse("zz is bad").cs, "list"); eq("extend: resolve error", zb.err ? zb.err.msg : "", "zz: bad value");
const zo = parse("zz ~ y"); eq("registered ops", zo.err ? zo.err.msg : "", "\"~\" does not apply to zz; use is");
```
Retention case: put a row 120 days old into `c1`, set `callDays` to 90 through a test setter `setCallDaysForTest(90)`. Then `S0("tool is Bash and day is <that day>")` → `""`, and `matchSession` with `day is <that day>` alone (bucket) → `c1`.
- [ ] **Step 2: Run** → BUILD FAIL.
- [ ] **Step 3: Implement.**
  - Accessors in `attrs.ts`, by key:
    - session: `harness` → `[s.h]`, `repo` → `[projectOf(s.cwd)]`, `cwd` → `[home-expanded s.cwd]`, `branch`, `model` → `s.model` ∪ distinct row models (cached per `(path, L.ver)`), `title` → `titleOf(s)`, `id`, `agent` → `s.kind`, `subagent` → `s.parent !== ""`, `live` → own or parent pid (move `livePid` from `cli.ts:84-88` into `eval.ts` and export it), `archived`, `state` (`s.stuck` → stuck, `s.attention` → attention, `s.pid && working(s)` → busy, `s.pid` → idle, else ended; a subagent uses its parent's pid), `cost` (`s.cost < 0` → unk), `tokens` = in+out+cr+cw and the parts, `tools` = `s.tools`, `errors` = Σ `TS.err` over all days, `error_rate` = errors/tools (unk when tools 0), `lines` = add+del, `age` = `Date.now() - s.last`, `text` = the `sessions.ts:86` haystack lowercased.
    - day: `day.cost` (unk if `cost === 0 && unk > 0`), `day.tokens`, `day.tools`.
    - call: `tool`, `server` (`mcpServer`), `program`/`command` (dict names), `file`/`ext`, `status` (`err` -1 → unknown, 0 → ok, 1 → error), `duration` (`ms < 0` → unk), `out`, `hour` (`localOf(c.t).hour`), `model` (row model; `-1` → unk), `day`/`weekday` (`localOf(c.t)`).
  - Value matching:
    - text: lowercase compare. `is` = equal, `~` = contains. Path `is` with `*` → glob to regex (`*` → `[^/]*`, `**` → `.*`, anchored) after expanding `~`. Multi: any value matches; `is_not` matches when none does.
    - numeric: parse the clause value once (usd strips `$`; tok `k`=1e3 `M`=1e6; size `KB`=1024 `MB`=1048576; dur `ms`/`s`/`m`/`h`/`d`; ratio `%`/100). Unknown never satisfies a comparison. `is unknown` checks `unk`.
    - date: resolve `today`/`yesterday`/`-Nd`/ISO to a day key at compile time and compare day keys as strings. Weekday → `wd`.
  - `compile` sorts clauses by entity into the four predicate arrays. `ctx === "watch"` rejects `status`, `duration`, `out` with the §10 message and keeps `tool server program command file ext` as event predicates over `toolArg`/`program()` of the call text. `ctx === "procs"` puts every clause except harness/repo/cwd/live into `dimmed`. `content` clauses go to `content` (`is_one_of` is rejected at parse time).
  - `matchSession(f, s, days)`: all `f.sess`. Then, when `f.call.length`, look for a row of `accOf(s).calls` with `t >= callCutoff()`, its `localOf(t).day` ∈ days (or any), day preds true on that day's bucket, and all call preds true. Else, when `f.day.length || f.dayKeys`, look for a day bucket that passes (`dayMatches`). Content is handled in Task 8, which wraps `matchSession`.
  - `dayMatches(f, s, dk, d)`: `(!f.dayKeys || f.dayKeys.has(dk)) && f.day.every((p) => p(s, dk, d))` (a loop, not `every` with a closure, if scriptc rejects it).
  - `projectOf`: walk up with `existsSync(join(dir, ".git"))`. If `.git` is a file, read ≤ 4 KB, `gitdir: (.*)`, and if it contains `/.git/worktrees/`, the repo root is the text before that. Cache by cwd in a `Map<string, string>`.
  - `fixture.ts`: `fxSession` builds a `Sess` with `newSess`, sets `cwd/model/parent`, runs `harnessOf(h).usage(acc, l)` per line on `accOf(s)`, then copies the totals the way `ledger.ts:57-61` `apply` does. Export `applyAcc(s, a)` from `ledger.ts` (rename the private `apply`) so the fixture uses the real code.
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(query): attribute catalogue, projectOf, compile with lifting (same-call, same-day)`.

---

### Task 6: `aggregate()`, `totals()` — the shared engine

**Files:**
- Create: `src/features/query/agg.ts`, `src/features/query/agg.check.ts`

**Interfaces — Consumes:** `Compiled`, `matchSession`, `eachCall`, `sessVal`, `callVal`, `callCutoff` (Task 5); `TS`, `Cnt`, `HB`, `hb`, `pct` (`calls.ts`). **Produces (exact; triage §4, compare §3/§8, repo-view, rules-config):**
```ts
export type Weight = "count" | "cost" | "tokens" | "duration";
export interface Bin { n: number; w: number; err: number; hist: number[] /* HB buckets, durations of timed rows (call entity) */; max: number }
export interface Dist { dim: string; total: number; wTotal: number; vals: Map<string, Bin>; path: "rows" | "buckets"; unpriced: number /* sessions/days with unknown cost, weight 0 */ }
// entity "call": rows = calls; "session": rows = sessions with ≥ 1 selected day passing f. Multi-valued dims count once per distinct value.
// Path: rows when f.needsCalls or (entity call and any dim ∈ ROW_DIMS); else buckets. Rows only cover days ≥ callCutoff(): older days in `days` are skipped on the rows path.
export const ROW_DIMS: string[];  // ["model","status","duration","out","program","command","file","ext"] — buckets count program/command/file per occurrence, not per call
export function aggregate(f: Compiled, entity: "session" | "call", days: string[], dims: string[], weight: Weight): Dist[];
// rows path with an extra row predicate that no filter can express (triage `slow`: duration ≥ per-tool p90; untimed calls excluded)
export function aggregateWhere(f: Compiled, days: string[], dims: string[], weight: Weight, keep: (s: Sess, c: Call) => boolean): Dist[];
// Dist subtraction for "rest" baselines (scope − selection, per value; never below 0)
export function minus(a: Dist[], b: Dist[]): Dist[];
export interface ToolT { n: number; err: number; dn: number; ms: number; max: number; hist: number[]; out: number }
export interface Totals {
  sessions: number; subs: number; subsCost: number; subsUnk: number;   // top-level sessions with activity; subagent sessions and their cost
  cost: number; unk: number; inTok: number; outTok: number; cr: number; cw: number;
  tools: number; errors: number; add: number; del: number;
  dn: number; ms: number; max: number; hist: number[];                  // merged durations of all tools
  perTool: Map<string, ToolT>; prog: Map<string, Cnt>; cmds: Map<string, Cnt>; files: Map<string, Cnt>; // bucket Cnt maps re-keyed without the "<tool>\t" prefix for files, kept "<tool>\t<x>" for prog/cmds
  models: Set<string>; paths: Set<string> /* matching session paths */; first: number; last: number /* min Acc.t0, max s.last */;
  callScoped: boolean;   // f had call clauses: cost/tokens are "in session-days with matching calls", tools/errors/durations from matching rows only
  path: "rows" | "buckets";
}
export function totals(f: Compiled, days: string[] | null): Totals;   // days null = all history
export function tsOf(t: ToolT, q: number): number;                     // pct(t.hist, q, t.max), -1 when untimed
export function aggKey(f: Compiled, entity: string, days: string[], dims: string[], weight: string): string; // cache key incl. L.ver
```
Both results are cached per `aggKey` (map, ≤ 64 entries, cleared when `L.ver` changes).
- [ ] **Step 1: Failing check** `agg.check.ts` with `fxBase()`:
```ts
fxBase();
const F = (s: string): Compiled => compile(parse(s).cs, "stats").f ?? EMPTY;
const dump = (d: Dist): string => [...d.vals.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map((e) => e[0] + "=" + e[1].n + "/" + e[1].err).join(",");
const all = F(""); const days2 = lastDays(2);
const tt = totals(all, days2);
eq("tools total", String(tt.tools), "10");
eq("errors", String(tt.errors), "3");
eq("sessions top-level / subs", tt.sessions + "/" + tt.subs, "3/1");
const byTool = aggregate(all, "call", days2, ["tool"], "count")[0];
eq("bucket path for tool", byTool.path, "buckets");
eq("tool counts", dump(byTool), "Bash=3/1,Edit=1/0,Grep=1/1,Read=2/0,exec=1/0,shell=2/1");
const viaRows = aggregate(F("status is_one_of ok error unknown"), "call", days2, ["tool"], "count")[0];
eq("rows path when a call clause", viaRows.path, "rows");
eq("bucket = rows for tool counts", dump(viaRows), dump(byTool));
const m = aggregate(all, "call", days2, ["model"], "count")[0];
eq("model needs rows", m.path, "rows");
eq("model values", dump(m), "claude-sonnet-4-5=7/2,gpt-x-unpriced=2/1,unknown=1/0");
const ses = aggregate(all, "session", days2, ["harness"], "cost")[0];
eq("session weight cost, unpriced counted", String(ses.unpriced), "1");
eq("session entity counts sessions", dump(ses), "claude=2/2,codex=1/1,kiro=1/0");   // err = Σ errors of those sessions
const cs = totals(F("tool is Bash and status is error"), days2);
eq("call-scoped totals", [cs.callScoped, cs.tools, cs.errors].join(","), "true,1,1");
const multi = aggregate(F("harness is codex"), "call", days2, ["program"], "count")[0];
eq("multi-valued once per value", dump(multi), "git=1/0,npm=2/1");
eq("yesterday only", String(totals(all, [lastDays(2)[0] ?? ""]).tools), "2");
const z: number[] = []; for (let i = 0; i < HB; i++) z.push(0);
eq("p95 untimed", String(tsOf({ n: 1, err: 0, dn: 0, ms: 0, max: 0, hist: z, out: 0 }, 0.95)), "-1");
const bashT = totals(F("tool is Bash"), days2).perTool.get("Bash");
eq("Bash timed 2 of 3", bashT ? bashT.dn + "/" + bashT.n : "none", "2/3");
const sl = aggregateWhere(all, days2, ["tool"], "count", (s: Sess, c: Call) => c.ms >= 1500);
eq("aggregateWhere", dump(sl[0]), "Bash=1/0,exec=1/0");
eq("minus", dump(minus(aggregate(all, "call", days2, ["tool"], "count"), sl)[0]), "Bash=2/1,Edit=1/0,Grep=1/1,Read=2/0,shell=2/1");
eq("session hour = start hour", dump(aggregate(all, "session", days2, ["hour"], "count")[0]), "10=1/1,14=1/1,9=1/1,unknown=1/0");
```
The numbers come from the `fxBase()` table in Task 5.
- [ ] **Step 2: Run** → BUILD FAIL.
- [ ] **Step 3: Implement.**
  - **Bucket path**: for each session passing `f.sess`, for each `d` in `days` present in `a.days` and passing `f.day`/`dayKeys`: session entity collects the dim values per session once; call entity adds per `TS` in `d.tt`: dim `tool` → key name, `n += st.n`, `err += st.err`, hist merge. Session dims (harness, repo, agent, branch, subagent, state, …) are weighted by `d.tools`. `hour` uses `st.h[hh]`. `day`/`weekday` uses the bucket key. Weight: count = n; duration = `st.ms`; cost/tokens are session entity only (call entity rejects them with weight 0 and `wTotal = 0`).
  - **Rows path**: `eachCall(f, days, …)`. Per row and dim, `callVal` → distinct values → `bin.n++`, `bin.err += c.err === 1 ? 1 : 0`, timed → `hist[hb(ms)]++` and `max`. Weight duration = `ms` (untimed 0). Session entity on the rows path: a session counts once if any of its rows match. Its dims come from `sessVal`, plus call dims as the union over its matching rows.
  - **Session entity dims**: `hour` and `weekday` are the session's **start** (`localOf(Acc.t0)`; sessions with `t0 = 0` → `unknown`). `tool`, `program`, `ext` are the union over the session's selected days (bucket keys `d.tt`, `d.prog`, `d.files`); `model` is the session `model` attribute; every other session attribute via `sessVal`.
  - `aggregateWhere` = rows path with `keep` ANDed to `f.call`; `minus` subtracts `n`, `w`, `err`, `hist` per value and `total`/`wTotal`, dropping values that reach 0.
  - `totals`: buckets unless `f.needsCalls`. With call clauses: day buckets with ≥ 1 matching row contribute cost/tokens/lines. Tools, errors, durations, perTool, prog, cmds and files come from the matching rows (prog/cmds/files from row dict names). `callScoped = true`.
  - Session counting matches `stats.ts:71`: top-level sessions with activity. Subagents count in `subs`/`subsCost` and still add to every sum.
- [ ] **Step 4: Run** → PASS; suite ok.
- [ ] **Step 5: Commit** `feat(query): aggregate() and totals() over day buckets or call rows`.

---

### Task 7: Scopes, pins, merge rules, persistence

**Files:**
- Create: `src/features/query/scope.ts`, `src/features/query/scope.check.ts`
- Modify: `src/state.ts:22-23,41-42` (replace `filter/hfilter/liveOnly` with `pins/local`; keep `fulltext/useFull/fullq` until Task 8 removes them)

**Interfaces — Produces:**
```ts
// state.ts
S.pins: Clause[]; S.local: Map<string, Clause[]>   // tab name → local clauses ("Sessions", "Stats", later "Triage", "Compare", "Repos")
// scope.ts
export function addClause(scope: Clause[], c: Clause): { cs: Clause[]; note: string };  // same-key merge (§6.2); note = toast text or ""
export function addAll(scope: Clause[], add: Clause[]): { cs: Clause[]; notes: string[] };
export interface Eff { cs: Clause[]; struck: Clause[] /* pinned clauses overridden by a local equality clause */ }
export function effective(pins: Clause[], local: Clause[]): Eff;                         // §6.3
export function localFor(tab: string): Clause[]; export function setLocal(tab: string, cs: Clause[]): void;
export function pinAll(tab: string): string;            // `p`: moves the tab's local clauses into pins via addAll; returns the toast
export function setPins(expr: string): QErr | null;     // `P` editor result; "" unpins all; persists
export interface PinStore { load: () => string; save: (v: string) => void; remember: boolean }
export function initPins(st: PinStore): string;          // restores; returns the start toast ("" when nothing restored); an unparsable saved value → warning toast, dropped
export function hiddenByPins(tab: string, total: (cs: Clause[]) => number): number;     // sessions the pins alone exclude
export function onScopeChange(fn: () => void): void;     // views re-filter (list buildView, stats cache)
```
- [ ] **Step 1: Failing check** `scope.check.ts`. Every pair from spec §6.2/§6.3 with its toast:
```ts
const P = (s: string): Clause[] => parse(s).cs; const T = (cs: Clause[]): string => print(cs);
let r = addClause(P("tool is Bash"), P("tool is Edit")[0]); eq("is+is", T(r.cs), "tool is_one_of Bash Edit"); eq("is+is toast", r.note, "merged: tool is_one_of Bash Edit");
r = addClause(P("tool is_one_of Bash Edit"), P("tool is Read")[0]); eq("is+one_of", T(r.cs), "tool is_one_of Bash Edit Read");
r = addClause(P("tool is_not Bash"), P("tool is_not Edit")[0]); eq("not+not", T(r.cs), "tool is_not_one_of Bash Edit");
r = addClause(P("tool is Bash"), P("tool is_not Bash")[0]); eq("is vs is_not same value", T(r.cs), "tool is_not Bash"); eq("replace toast", r.note, "replaced: tool is_not Bash");
r = addClause(P("cost > 2"), P("cost > 5")[0]); eq("same direction", T(r.cs), "cost > 5"); eq("same dir toast", r.note, "replaced: cost > 5");
r = addClause(P("cost > 2"), P("cost < 10")[0]); eq("opposite directions AND", T(r.cs), "cost > 2 and cost < 10"); eq("no toast", r.note, "");
r = addClause(P("model ~ opus"), P("model ~ 4")[0]); eq("~ AND", T(r.cs), "model ~ opus and model ~ 4");
r = addClause(P("tool is Bash"), P("tool is Bash")[0]); eq("duplicate", T(r.cs), "tool is Bash");
const e = effective(P("harness is pi and repo is agentglass"), P("harness is codex and cost > 2"));
eq("local eq overrides pinned eq", T(e.cs), "repo is agentglass and harness is codex and cost > 2"); eq("struck", T(e.struck), "harness is pi");
const e2 = effective(P("cost > 2"), P("cost < 10")); eq("ranges AND across scopes", T(e2.cs), "cost > 2 and cost < 10");
// persistence
let saved = "repo is agentglass and harness is pi"; const st: PinStore = { load: () => saved, save: (v: string) => { saved = v; }, remember: true };
eq("restored pins announced", initPins(st), "pinned: repo is agentglass · harness is pi — P edits, P then enter on empty unpins");
eq("restored", T(S.pins), "repo is agentglass and harness is pi");
setPins(""); eq("unpin persists", saved, "");
const st2: PinStore = { load: () => "repo is x", save: (v: string) => { saved = "SHOULD NOT"; }, remember: false };
eq("remember false ignores saved", initPins(st2), ""); eq("remember false no pins", T(S.pins), "");
setPins("tool is Bash"); eq("remember false never saves", saved === "SHOULD NOT" ? "saved" : "ok", "ok");
const st3: PinStore = { load: () => "tol is x", save: (v: string) => {}, remember: true };
eq("unparsable dropped", initPins(st3), "saved pinned filter dropped: unknown key \"tol\" — did you mean tool?");
```
A zero-parameter arrow for an optional member is SC2003. `PinStore.load` is required, not optional, so this is fine.
- [ ] **Step 2: Run** → BUILD FAIL.
- [ ] **Step 3: Implement** the merge rules as a switch over `(old.op, new.op)` for the same key in the same scope. Clause identity uses `sameClause`. The real store: `load = () => str(section("filter")["pinned"])`, `save = (v) => setConfig("filter", "pinned", v)`, `remember = section("filter")["remember"] !== false` (a non-bool value → default true + one startup toast `config filter.remember must be true or false — using true`). The start toast is shown with `say("info", …)` and `S.toastAt` extended to 6 s. Add `S.toastMs: number` (default 5000) read by `footer.ts:39` instead of the literal `5000`.
- [ ] **Step 4: Run** → PASS. The build fails where `S.filter`/`S.hfilter`/`S.liveOnly` are still read (`input.ts:50,54,59,157-161`, `sessions.ts:94,108-109`, `list.ts:42`). Bridge until Task 8: in those places read the new state through `scope.ts` helpers `legacyText()`, `legacyHarness()`, `legacyLive()`. They return the Sessions-local `text ~` values, `harness is` value and `live is true` presence. Task 8 deletes them. Suite ok.
- [ ] **Step 5: Commit** `feat(query): filter scopes, pins with same-key merge, remembered pins`.

---

### Task 8: Sessions tab — input, completion, chips, keys, full-text as `content`

**Files:**
- Create: `src/features/query/content.ts`, `src/features/query/ui.ts`, `src/features/query/ui.check.ts`
- Modify: `src/hooks.ts` (new seams), `src/input.ts:46-61,157-161`, `src/model/sessions.ts:83-122`, `src/ui/list.ts:42-43`, `src/ui/footer.ts:16-18,36`, `src/ui/help.ts:16-17`, `src/actions.ts:142-154` (move into `content.ts`), `src/ui/transcript.ts:70` (focus by id when `focusTs` is empty), `src/model/procs.ts` + `src/ui/procs.ts` (process view), `src/main.ts` (import `./features/query/ui.ts`), `src/state.ts` (drop `filter/hfilter/liveOnly/fulltext/useFull/fullq`)

**Interfaces — Produces:**
```ts
// hooks.ts
H.listFilter: ((s: Sess) => boolean)[]      // buildView keeps a top-level session when every hook passes for it or for one of its subagents
H.listFiltering: (() => boolean)[]          // true = a filter is active (expand matching subagents, as today's `filtering`)
H.input: ((action: string, ev: string, text: string) => boolean)[] // ev "change" | "enter" | "esc" | "tab"; enter → true keeps the input open
H.procFilter: ((p: Proc) => boolean)[]
// state.ts
S.inputErr: string                          // shown in red after the input text (footer)
// ui.ts
export function tabFilter(tab: string, ctx: Ctx): Compiled;   // effective (pins ∘ local) compiled; cached per canonical text
export function chips(tab: string, ctx: Ctx, w: number): string; // styled chip bar, display()/screenOut() applied, "… +N" overflow
export function openFilterInput(tab: string): void;          // `/`; any tab name ("Sessions", "Stats", "Repos", …), local clauses kept per tab in S.local
export function complete(text: string, cursorAtEnd: boolean): string[]; // tab candidates (keys → ops → values)
export function matchingPaths(f: Compiled): Set<string>;     // cached per (f.key, L.ver, content epoch)
// content.ts
export function contentSet(q: string, cands: string[] | null): { paths: Set<string>; timedOut: boolean }; // rg over roots or ≤ 200 candidate files; cached per q until scan() adds/changes a session
// model/procs.ts
export let procView: Proc[]; export function buildProcView(): void;  // procAt() and renderProcs() read procView; liveness code keeps `procs`
```
Behaviour per spec §7:
- `/` on Sessions: `ask("filter", "query", print(localFor("Sessions")))`. The `H.input` handler: on `change`, parse. If it parses and compiles → `setLocal`, re-filter, `S.inputErr = ""`. Otherwise keep the last valid local and set `S.inputErr` = the error message. `enter` with an error → returns true (stays open). `esc` → restore the local captured at open. `tab` → replace the last token with the next candidate (cycling on repeated tab).
- Completion candidates: after whitespace with no key yet → `keys()`. After a key → the ops valid for its type. After an op → `enumValues` for enums; for text keys the 20 most frequent values from the ledger (tool names from `DICT.tool` weighted by `TS.n`, repos from sessions, models from `DICT.model`, programs from `DICT.prog`, extensions from row files).
- `h`: cycle the local `harness is …` clause (all → each id). If a pin has `harness` → `say("info", "harness is pinned — P edits pins")`. `l`: toggle local `live is true`. `F`: `ask("full-text", "content", "")`; enter adds `content ~ "<q>"` to local via `addClause`. `esc` in the list clears the Sessions local clauses (pins stay). `p`: `pinAll("Sessions")`. `P` (list mode only; transcript `P` stays replay): `ask("pins", "pins", print(S.pins))`; enter → `setPins`.
- `buildView()` (`sessions.ts:93-122`): `const filtering = H.listFiltering.some((f) => f())`, and `matches(s)` = every `H.listFilter`. The `S.hfilter`/`S.liveOnly`/`S.useFull` lines go away (they are clauses now). The list hook = `matchingPaths(tabFilter("Sessions", "list")).has(s.path)`. `matchingPaths` runs `matchSession` plus the content clauses: candidates = sessions passing the non-content clauses; when ≤ 200, `rg` gets those paths, else the roots; `content !~` = not in the set; a timeout → `say("warn", "full-text search timed out after 30 s — content clause matches nothing")` and an empty set.
- Box title (`list.ts:42-43`): `chips("Sessions", "list", w) + " " + (sel+1) + "/" + n`, plus `· pins hide N` when N > 0, plus `calls ≤ <callDays> d` when the filter has call clauses. Empty list with pins hiding sessions: `no sessions match — N hidden by pins (P edits)`.
- Chips: pinned in `C.accent` with `⚲`, local plain, struck pinned with `CSI 9m`, dimmed (not applicable) with `C.dim`. Every value goes through `display("filter", v, null)`. `redact.ts` handles kind `"filter"` like `"cwd"`/`"file"` for path/repo/title keys (add the case there).
- Processes tab: `H.procFilter` = pins with keys harness/repo/cwd/live, evaluated on `p.h`, `projectOf(p.cwd)`, `p.cwd`, live = true. Other pinned clauses show dimmed in the Processes box title.
- Help (`help.ts:16-17`) and footer (`footer.ts:36`): `/ filter`, `p pin`, `P pins`. A "filter" help section lists the grammar and `keys().join(" ")`.

- [ ] **Step 1: Failing check** `ui.check.ts` (fixture from Task 5; no terminal, drive `onInput` directly):
```ts
fxBase(); initPins({ load: () => "", save: (v: string) => {}, remember: true }); buildView();
const ids = (): string => S.view.filter((s) => s.depth === 0).map((s) => s.id).sort().join(",");
onInput("/"); for (const ch of "harness is codex") onInput(ch);
eq("live re-filter", ids(), "x1");
for (const ch of " and tool is") onInput(ch);       // incomplete: needs a value
eq("prefix keeps last valid", ids(), "x1"); eq("inline error", S.inputErr, "tool is …: needs a value");
onInput("enter"); eq("enter on invalid stays open", S.mode, "input");
onInput("esc"); eq("esc cancels to previous", print(localFor("Sessions")), ""); eq("all back", ids(), "c1,k1,x1");
onInput("/"); for (const ch of "tool is Bash") onInput(ch); onInput("enter"); onInput("p");
eq("p pins all local", print(S.pins), "tool is Bash"); eq("local emptied", print(localFor("Sessions")), "");
eq("hidden count", String(hiddenByPins("Sessions", countFor)), "2");   // countFor: sessions matching a clause list
onInput("esc"); eq("esc keeps pins", print(S.pins), "tool is Bash");
onInput("h"); eq("h cycles local harness", print(localFor("Sessions")), "harness is claude");
onInput("l"); eq("l toggles live", print(localFor("Sessions")), "harness is claude and live is true");
eq("completion keys", complete("too", true).slice(0, 1).join(","), "tool");
eq("completion ops", complete("cost ", true).join(","), "is,is_not,>,>=,<,<=");
eq("completion enum", complete("status is ", true).join(","), "ok,error,unknown");
```
- [ ] **Step 2: Run** → BUILD FAIL / FAIL.
- [ ] **Step 3: Implement** as described. In `input.ts`: lines 50/54/59 become the generic `H.input` dispatch, so the `"filter"` branches go away; the `fulltext` branch goes away; lines 157-161 go away (the H.keys in `ui.ts` handle `/ F h l esc p P` on tab 0 and Stats). `actions.ts` `fullText` moves to `content.ts` (keep the `rg`/`grep` fallback and `HarnessAdapter.search` merge exactly). `transcript.ts:70`: accept `(t.focusTs === "" || e.ts === t.focusTs)` when `focusText` is an event id.
- [ ] **Step 4: Run** → PASS; suite ok. Manual: `./build.sh && ./agentglass`, then `/` `tool is Bash and status is error` → list narrows, chip shows. `p` → the chip turns accent with the pin mark. Restart → toast for 6 s, chips present.
- [ ] **Step 5: Commit** `feat(query): Sessions filter input with live parse, completion, chips, pins keys, content search`.

---

### Task 9: Stats honors the filter

**Files:**
- Modify: `src/features/usage/stats.ts:49-76` (agg), `:87-166` (renderStats), `:221-253` (dagg), `:292-358` (renderDrill), `:404-434` (key), `:476-483` (footer/help)
- Test: `src/features/usage/stats.check.ts` (create; imports `fxBase` and the pure aggregation helpers, not `cache.ts`)

**Interfaces — Consumes:** `tabFilter("Stats","stats")`, `totals`, `aggregate`, `eachCall`, `chips`. **Produces:**
```ts
export function statsDrill(tool: string, local: Clause[], week: boolean): void; // switch to the Stats tab, set its local filter, open the drill-down of `tool` (session-compare's enter on a tool row; triage `o` for calls)
export function statsPeriod(): string[];   // the current d/w period (triage default period)
export function statsDrillTool(): string;  // the tool (or "mcp__<server>") of the open drill-down, "" when none (triage `t` from the drill-down)
```
- With an empty effective filter, `agg()`/`dagg()` run as today (fast path).
- With a filter: summary/per-harness rows from `totals(f, days)` per harness (`f` + `harness is <id>`, so the per-harness table stays). Top tools from `aggregate(f, "call", days, ["tool"], "count")`. Charts: per hour `aggregate(…, ["hour"])`, per day `["day"]`. Drill-down: `totals(f + "tool is <dKey>", days)` for counts/histogram. `prog`/`cmds`/`files` from `Totals`. Slowest/errors: the `TS.slow/errs` recs of matching sessions/days, and with call clauses only recs whose `id` equals the `cid` of a matching row. Rows without a rec are listed from the row (`arg` "(no arguments)", jump by `cid`).
- Subtitle: `chips("Stats","stats", w)`. With `callScoped`: the cost/tokens line gets `in session-days with matching calls`. Period ∩ `day` clauses empty → `no days of the last 7 match day is …` in place of the tables.
- `/` on Stats edits the Stats local filter (same input as Task 8). `p` pins it.

- [ ] **Step 1: Failing check** `stats.check.ts`: with `fxBase()`, `statsTotalsFor("")` equals today's `agg(days).tot` field by field (tools, cost, in/out, add/del, sess). `statsTotalsFor("harness is codex")` equals the `codex` row of `agg(days)`. `statsTotalsFor("tool is Bash and status is error")` gives `callScoped` with tools 1. `statsTotalsFor("day is 2020-01-01")` gives an empty intersection and the message text. Export `statsTotalsFor(expr: string): Totals` and `periodMessage(f: Compiled, days: string[]): string` from `stats.ts` for the check. `stats.ts` imports `./cache.ts` at line 15: move that import to `main.ts`, so a check can import `stats.ts` without loading the user's cache.
- [ ] **Step 2: Run** `scriptc build src/features/usage/stats.check.ts -o /tmp/sc && /tmp/sc` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; suite ok. Manual: Stats `/ repo is agentglass` → totals shrink, the subtitle shows the chip; `w` keeps the filter; drill-down on Bash shows only that repo's calls.
- [ ] **Step 5: Commit** `feat(stats): filter Stats totals, tables, charts and drill-down`.

---

### Task 10: CLI — `--filter`, `--pinned`, `--watch` evaluation, errors

**Files:**
- Modify: `src/features/cli.ts:27-33` (OPTS), `:35-54` (usage), `:56` (Opts), `:71-82` (opts), `:89-92` (wanted), `:95-114` (snapshot), `:133-186` (watch)
- Create: `scripts/filter-cli.test.sh`

**Interfaces — Consumes:** `parse`, `caret`, `compile`, `matchSession`, `addAll`, `livePid` (eval.ts), `keys()`. **Produces:** `Opts.filter: Compiled`, `Opts.pinned: boolean`. The CLI contract:
- `--filter '<expr>'` (repeatable, merged with `addAll`). `--harness X` → `harness is X`, `--live` → `live is true`. `--pinned` adds `S.pins` (restored with the real store; with `remember: false` there are no pins).
- A parse/compile error → stderr `agentglass: filter: <msg>\n  <src>\n  <caret>` and exit 2.
- `--json`: candidates = sessions passing `f.sess` predicates that need no ledger (harness, repo, cwd, branch, title, id, agent, subagent, live, archived, text). `complete(s)` runs only for those, then the full `matchSession` (content clauses via `contentSet`). Output fields unchanged.
- `--watch`: compile with ctx `"watch"`. Session ledger clauses: `complete(s)` the first time a session emits, then at most every 10 s per session (`Map<path, lastComplete>`). `event` predicates per emitted event (`kind`, tool name, arguments). `status`/`duration`/`out` → exit 2 with the §10 message.
- `--help`: one line per option, plus `filter keys: ` + `keys().join(" ")` wrapped at 100 columns.
- `state is …` in `--json` → stderr note `agentglass: state needs process info; run without --json or use live` (once).

- [ ] **Step 1: Failing shell test** `scripts/filter-cli.test.sh`. It builds the binary once (`./build.sh` output `./agentglass`) and uses a temp `HOME` with hand-written Claude and Codex sessions:
```sh
#!/bin/sh
# --filter for --json/--watch, exit codes, --harness/--live sugar, --pinned
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/.claude/projects/-w-app" "$T/.codex/sessions/2026/10/01" "$T/.agentglass"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '%s\n' "{\"type\":\"user\",\"timestamp\":\"$NOW\",\"cwd\":\"/w/app\",\"sessionId\":\"c1\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}" \
  "{\"type\":\"assistant\",\"timestamp\":\"$NOW\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"npm test\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}" \
  "{\"type\":\"user\",\"timestamp\":\"$NOW\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":true,\"content\":\"x\"}]},\"uuid\":\"u2\"}" \
  > "$T/.claude/projects/-w-app/c1.jsonl"
printf '%s\n' "{\"timestamp\":\"$NOW\",\"type\":\"session_meta\",\"payload\":{\"id\":\"x1\",\"cwd\":\"/w/other\",\"model\":\"gpt-5\"}}" \
  > "$T/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-x1.jsonl"
ag() { HOME="$T" AGENTGLASS_NOTIFY=0 ./agentglass "$@"; }
[ "$(ag --json --filter 'tool is Bash and status is error' | grep -o '"id":"[^"]*"' | head -1)" = '"id":"c1"' ] || { echo "FAIL same-call"; exit 1; }
[ "$(ag --json --filter 'harness is codex' | grep -c '"id":')" = 1 ] || { echo "FAIL harness"; exit 1; }
[ "$(ag --json --harness codex)" = "$(ag --json --filter 'harness is codex')" ] || { echo "FAIL --harness sugar"; exit 1; }
set +e; err=$(ag --json --filter 'tol is Bash' 2>&1 >/dev/null); rc=$?; set -e
[ $rc = 2 ] || { echo "FAIL exit $rc"; exit 1; }
echo "$err" | grep -q 'unknown key "tol" — did you mean tool?' || { echo "FAIL msg: $err"; exit 1; }
echo "$err" | grep -q '^  \^' || { echo "FAIL caret"; exit 1; }
printf '{"filter":{"pinned":"harness is codex"}}\n' > "$T/.agentglass/config.json"
[ "$(ag --json | grep -c '"id":')" = 2 ] || { echo "FAIL pins applied without --pinned"; exit 1; }
[ "$(ag --json --pinned | grep -c '"id":')" = 1 ] || { echo "FAIL --pinned"; exit 1; }
set +e; ag --watch --filter 'duration > 1s' >/dev/null 2>&1; rc=$?; set -e
[ $rc = 2 ] || { echo "FAIL watch duration rc=$rc"; exit 1; }
ag --help | grep -q '^filter keys: harness repo' || { echo "FAIL help keys"; exit 1; }
echo "filter cli: all checks passed"
```
Check the Codex sessions path layout against `src/harness/codex.ts` `scan()` first, and adjust the directory if needed. The test must pass on `main`'s layout.
- [ ] **Step 2: Run** `./build.sh && sh scripts/filter-cli.test.sh` → FAIL (unknown option ignored → counts wrong).
- [ ] **Step 3: Implement** in `cli.ts` as described. `wanted()` becomes `matchSession(o.filter, s, null)`, run after `complete(s)` for the candidates.
- [ ] **Step 4: Run** → `filter cli: all checks passed`; `sh scripts/check.sh` → ok.
- [ ] **Step 5: Commit** `feat(cli): --filter and --pinned for --json and --watch; filter keys in --help`.

---

### Task 11: Real-life verification, docs, final review

**Files:** Modify `README.md` (filter section: grammar, keys, pins, `--filter`, `filter.*` config, `calls/` cache and retention), `src/ui/help.ts` (already generated keys; check the wording).

- [ ] **Step 1: Real data (read-only)** on the user's machine with the backed-up cache from Task 3:
  - Re-index time: `rm -rf ~/.agentglass/cache && time ./agentglass --json --limit 1 >/dev/null` (first run indexes the listed session only). Then start the TUI and time until Stats shows `✔ indexed`. Record it.
  - Calls cache size: `du -sh ~/.agentglass/cache/calls` (spec estimate ≈ 5 MB for 124k calls; `cid` adds ~30 B per row). Record it.
  - Memory: `/usr/bin/time -v ./agentglass --json --filter 'tool is Bash' > /dev/null` → max RSS before vs after (baseline from Task 0).
  - Keystroke re-filter: temporary env `AGENTGLASS_TIMING=1` makes `buildView` log its ms to stderr. Type `/tool is Bash and status is error`. Target < 16 ms with the matching-set cache warm. Remove the env hook before commit, or keep it documented in README if useful.
  - Row parity on real data: a one-off script (scratchpad, not committed) loads the ledger and asserts Σ rows = Σ `TS.n` for days within retention, per harness.
  - Spot checks: `--json --filter 'model ~ opus and tool is Bash' | jq length`; for a Claude session with a fallback iteration, check that its rows carry both models.
  - Restore: `rm -rf ~/.agentglass/cache && cp -a $SCRATCH/cache-backup ~/.agentglass/cache` (or let it re-index).
- [ ] **Step 2: Docs.** README filter section; `--help` text reviewed.
- [ ] **Step 3:** `./build.sh && sh scripts/check.sh` → all ok.
- [ ] **Step 4: Commit** `docs: filter language, pins and per-call rows`.
- [ ] **Step 5: Final whole-branch review** (most capable model) against spec + this plan's Review Focus, one fix pass. Then PR (`gh pr create`, body ends with the attribution line), CI green, rebase-merge, remove worktree + branch.
