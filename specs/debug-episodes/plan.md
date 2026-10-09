# Debug Episodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agentglass recognises temporary debug instrumentation and debugging loops in every harness's transcripts, flags instrumentation left in the code (checked on disk), and serves one versioned view model to the TUI (`E` panel, `⚑` badge, preview, filters), the CLI (`agentglass debug`, `--check`, `--instructions`), the rules engine (built-in `leftover`) and the MCP server (`debug` tool).

**Architecture:** Adapters expose the text each edit adds and removes (`editText`, default in `common.ts`) and hand it to a tap in `record.ts` at the site where they already book `file()`. `src/features/debug/capture.ts` folds explicit markers, paired debug prints and reverts into small per-session fields of `Acc` (persisted, one `VERSION` bump). `verify.ts` checks open probes against the file on disk (cached by size/mtime). `model.ts` is a pure `detect()` over the probe stream and the lazily loaded call rows. `query.ts` builds the plain-JSON `DebugVM` with `agentglass://` links; every front end reads only `query.ts`.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`, discovered by `scripts/check.sh`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first, including "Today", "Decisions" and "Open questions"; this plan argues from it.

**Round:** Round 3 (after 2026.10.10). Shares `src/model/marks.ts` (marks and event kinds) with skill-usage: if that layer is not on `main` when Task 6 starts, Task 6 creates it to the shape agreed in both specs (spec §6.1), and skill-usage then builds on it. The event-kind taxonomy, the `event.kind` filter key and the view-filter controller (`src/ui/evfilter.ts`: chips `K`, presets, solo `i`, invert `!`, gap lines, `f=` links) are skill-usage plan Tasks E1–E2. If those are not merged when Task 6 starts, Task 6 implements E1–E2 to skill-usage spec §5a first. Needs filter-language, rules-config, agent-wait (families), honest-costs (`Day.hc`, billing), cli-agent-mode, command-palette (links, `applyTarget`), mcp-server (merged). Bumps the ledger `VERSION` once (Task 3).

## Global Constraints

- **Build and tests.** `./build.sh`; `sh scripts/check.sh`. A task is done only when both pass.
- **Single check.** Builds and caches go under your own dir, never `/tmp`:
  `C=$HOME/.cache/agentglass-agents/impl-debug-episodes; mkdir -p $C/home; scriptc build --optimization dev --strip <f> -o $C/x && HOME=$C/home AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme $C/x`.
  The suite runs checks with `AGENTGLASS_REDACT=1`; run once without it locally too. Delete `$C` when you finish.
- **Live runs of agentglass** use only the full isolation set, written out literally (zsh does not split `$VAR`):
  `AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp AGENTGLASS_FLEET_DIR=$S/fleet AGENTGLASS_HUB_DIR=$S/hub`
  (`$S` = your scratch dir; `mkdir -p $S/run && chmod 700 $S/run`). `ls -la ~/.agentglass` before and after: nothing
  may change. Inside tmux keep `AGENTGLASS_AGENT=0`.
- **Synthetic fixtures only.** Transcript lines, files with markers and projects are hand-written inside checks and
  shell tests (fake `HOME`). No real transcript, path or command is committed.
- **Never use the user's agents.** No `claude`/`codex`/`gemini`/`pi`/`opencode`/`kiro-cli`/`fx` session is started.
- **scriptc 0.1.7 limits:** nominal typing (pass fields, not foreign interfaces); no `Record<string, RegExp>` (C
  backend); out-of-range array reads trap (bounds-check, `numAt`); no zero-parameter arrow for an optional interface
  member (SC2003); SC1090 quirks (`+ 0` on typed-array reads used as indexes, no `.map` callbacks on index types, no
  `.replace` with a function); no `readlinkSync`; no `n.toString(radix)`; a missing `Record<string, string>` key
  traps (read through `Record<string, string | undefined>`).
- **No content stored.** The ledger keeps paths, marker indexes, counts, call ids, times, 32-bit hashes. No edit
  text, line text or log content. Line text leaves `verify.ts` only when `content: true`.
- **Old behavior is a contract.** `scripts/golden-usage.sh` before/after: every existing number identical (tokens,
  cost, tools, lines, files). Line counting (`nlines`, `lines()`, `file()`) is not touched.
- **Footprint.** Idle TUI: no new per-tick work. Episodes only on request. Budgets (spec §8.4): RSS + ≤ 1 MB, cold
  index CPU + ≤ 2 %, panel open ≤ 50 ms on a 2,000-call session.
- **UX baseline.** Text output ≤ 80 columns; `cliError` with a hint; `--help --format json` for every field; help
  section and footer hint for every key; no glyph without a word.
- **Process hygiene.** One build at a time; at most one TUI, killed right after; kill only PIDs/tmux sessions you
  started; `nice` heavy measurements.
- **Commits:** conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branches:** integration branch `feat/debug-episodes` from `origin/main` in `../agentglass-debug-episodes`.
  Parallel tasks run in `../agentglass-debug-episodes-t<N>` on `feat/debug-episodes-t<N>`, branched from the
  integration branch at the wave start, merged back in task-number order (rebase, fast-forward). One PR to `main`,
  rebase-merged after green CI.

## Waves (parallel vs sequential)

| Wave | Tasks | Run | Needs |
|---|---|---|---|
| 0 | T0 worktree, baselines, open questions | alone | — |
| 1 | T1 markers (pure) · T2 `editText` port, 7 adapters, tap | **parallel** | T0 |
| 2 | T3 capture into `Acc`, codec, `VERSION` | alone | T1, T2 |
| 3 | T4 disk verification · T5 episode model (pure) | **parallel** | T3 |
| 4 | T6 query layer, `DebugVM`, golden, stubs | alone | T4, T5 |
| 5 | T7 CLI `agentglass debug` · T8 TUI panel, badge, preview · T9 filter attributes + rule | **parallel** | T6 |
| 6 | T10 MCP `debug` tool | alone | T7 |
| 7 | T11 old-behavior golden, footprint, docs, final review | alone | T1–T10 |

Files per parallel wave are disjoint:
- Wave 1: T1 `src/features/debug/markers*.ts`, `src/features/debug/config.ts`; T2 `src/harness/*.ts` (not checks of
  other tasks), `src/harness/common.ts`, `src/harness/types.ts`, `src/features/usage/record.ts` (`edits`, `EDITS`
  only), `src/features/usage/calls.ts` (`patchTexts` only), new `src/harness/edittext.check.ts`.
- Wave 3: T4 `src/features/debug/verify*.ts`; T5 `src/features/debug/model*.ts`.
- Wave 5: T7 `src/features/debug/cli.ts` (stub from T6), `docs/cli-contract.md`, `scripts/debug.test.sh`,
  `scripts/contract.test.sh`; T8 `src/features/debug/view.ts` (stub from T6), `src/features/debug/view.check.ts`;
  T9 `src/features/query/attrs.ts`, `src/features/query/eval.ts`, `src/features/rules/config.ts`,
  `src/features/rules/metrics.ts`, their checks.

## Review Focus

1. **False positives.** No alert, badge or `debug is leftover` from a debug print unless `debug.heuristics` is on —
   and even then never an alert. Markdown files never yield explicit probes. A probe another session removed shows
   `removed`, not leftover (T4, T5, T9 checks).
2. **Nothing changes existing numbers.** `golden-usage.sh` identical; `harness.check.ts` unchanged and green; the
   `edittext.check.ts` "counts unchanged" cases (T2, T11).
3. **No content leaks.** The ledger line of a session with probes contains no fixture canary text
   (`CANARY-DBG-7` inside the probe lines) — T3 codec check; CLI and MCP outputs contain it only with `--content` —
   T7, T10 tests.
4. **Disk reads stay inside the project or `$HOME`**, regular files ≤ 4 MiB, never written; `../` escapes and
   symlinks out are `unverified` (T4).
5. **Unknown is `null`.** Kiro times, cost, wall; runs older than `filter.callDays` (T5, T6 golden).
6. **Lazy.** No call-row load or episode detection on the tick; the 60 s sweep only for sessions with open probes
   (T4 counter check, T11 footprint).
7. **Contract.** `DebugVM` golden byte-exact; contract doc and MCP goldens change together; `contract` stays 1.

---

### Task 0: Worktree, baselines, open questions — wave 0, alone

**Files:** none committed; findings go into the PR description as `Ruling:` lines.

- [ ] **Step 1: Worktree + build**: `git worktree add -b feat/debug-episodes ../agentglass-debug-episodes origin/main && cd ../agentglass-debug-episodes && ./build.sh && sh scripts/check.sh`. Expected: build succeeds, every check `ok`.
- [ ] **Step 2: Old-behavior baseline**: `nice sh scripts/golden-usage.sh > $C/golden-before.txt` (read the script's header for its isolated paths first; it must not touch `~/.agentglass`). Expected: the file ends with the script's summary line.
- [ ] **Step 3: Open question 1 (Codex exec escapes)**: count how the existing exec-patch path splits: `grep -c 'Begin Patch' $(ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -20) | awk -F: '$2>0' | wc -l` and inspect one hit's escaping with `grep -o 'Begin Patch.\{0,200\}' <file> | head -2 | sed 's/[A-Za-z]/x/g'` (letters masked: shape only). Expected: `\\n` newlines, `\\"` quotes. Record which escapes occur. T2's Codex override unescapes exactly those plus `\\\\` and `\\t`.
- [ ] **Step 4: Open question 2 (Kiro `fs_write` commands)**: `grep -rhoE '"command":"(create|strReplace|insert|append)[^"]*"' ~/.kiro ~/.local/share/kiro-cli 2>/dev/null | sort | uniq -c`. Expected: the command literals in use. Unknown commands → non-whole edit with `newStr`/`content` added (spec fallback).
- [ ] **Step 5: Open question 3 (fx `edits[]`)**: `grep -rhoE '"edits":\[\{[^}]{0,120}' ~/.fx 2>/dev/null | sed 's/:"[^"]*"/:"…"/g' | head -3`. Expected: key names only. None found → default `editTextOf` (covers both shapes).
- [ ] **Step 6: Open question 4 (realpath)**: a 5-line program `import { realpathSync } from "node:fs"; console.log(realpathSync("/proc/self/cwd"))` built with `scriptc build` and with `SCRIPTC_FLAGS="--backend c"`. Expected: both print a path, or one fails → T4 uses `lstatSync` and refuses symlinks.
- [ ] **Step 7:** If any finding contradicts the spec, write the `Ruling:` and follow the real data. No commit.

---

### Task 1: Markers and debug config (pure) — wave 1, parallel with T2

**Files:** Create `src/features/debug/markers.ts`, `src/features/debug/config.ts`, `src/features/debug/markers.check.ts`.

**Interfaces — Produces:**
- `export const BUILTIN_MARKERS: string[]` = `["agentglass:debug", "#region debug", "debug-temp", "debug_temp", "debug temp", "temp-debug", "temp_debug", "temp debug"]` (lowercase; index = marker key `k` for built-ins; user markers follow).
- `export function markerTable(user: string[]): string[]` — built-ins then valid user markers (lowercased, 4–64 chars, no `\n`, deduplicated).
- `export function skipFile(path: string): boolean` — true for `.md .mdx .rst .txt` (case-insensitive).
- `export function countMarkers(text: string, table: string[], out: number[]): void` — `out[k]` += lines of `text` containing marker `k` (one count per line per marker; prefilter: return without allocation when `text` has none of `debug`, `Debug`, `DEBUG`, `temp`, `Temp`, `TEMP`, or a user marker's literal).
- `export const PRINTS: string[]` — the spec §2.2 fragment list, exactly.
- `export function printLines(text: string): string[]` — trimmed lines of `text` containing a `PRINTS` fragment and no marker of the built-in table.
- `export function fnv32(s: string): number` — FNV-1a 32-bit (unsigned, as a number).
- `src/features/debug/config.ts`: `export interface DebugCfg { markers: string[]; heuristics: boolean; idleMin: number; diag: string }`; `export function parseDebugCfg(v: unknown): DebugCfg` (`markers` array of strings, invalid entries dropped and named in `diag`; `heuristics` bool; `idleMin` integer 5–240, default 30); `export function debugCfg(): DebugCfg` (reads `section("debug")` once, memo); `export function setDebugCfgForTest(c: DebugCfg | null): void`.

- [ ] **Step 1: Failing check** `src/features/debug/markers.check.ts`:

```ts
import { BUILTIN_MARKERS, markerTable, skipFile, countMarkers, printLines, fnv32 } from "./markers.ts";
import { parseDebugCfg } from "./config.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function cnt(t: string, tab: string[]): number[] { const o: number[] = []; for (let i = 0; i < tab.length; i++) o.push(0); countMarkers(t, tab, o); return o; }
const tab = markerTable(["XX-PROBE", "no", "a\nb"]);
ok("table", tab.length === BUILTIN_MARKERS.length + 1 && tab[tab.length - 1] === "xx-probe", tab.join(","));
let c = cnt("a\n// agentglass:debug start\nconsole.log(x) // AGENTGLASS:DEBUG\nb", tab);
ok("own marker, case", c[0] === 2, String(c[0]));
c = cnt("  // #region debug output\n  fetch(u)\n  // #endregion", tab);
ok("region opens only", c[1] === 1, String(c[1]));
c = cnt("x = 1 # TEMP DEBUG\ny // debug_temp", tab);
ok("temp tags", c[7] === 1 && c[3] === 1, c.join(","));
c = cnt("// xx-probe here", tab);
ok("user marker", c[tab.length - 1] === 1, c.join(","));
c = cnt("plain code\nconst debugLevel = 2", tab);
ok("no false hit", c.join("") === "0".repeat(tab.length), c.join(","));
ok("markdown skipped", skipFile("docs/README.md") && skipFile("a/B.MDX") && !skipFile("src/a.ts"), "");
const p = printLines("  console.log('x', y)\nreturn 1\nprint(f\"v={v}\")  \n// agentglass:debug console.log(z)");
ok("prints", p.length === 2 && p[0] === "console.log('x', y)" && p[1] === "print(f\"v={v}\")", JSON.stringify(p));
ok("fnv stable", fnv32("a") === 3826002220 && fnv32("") === 2166136261, String(fnv32("a")));
const cf = parseDebugCfg({ markers: ["ok-marker", 3, "x"], heuristics: true, idleMin: 2 });
ok("cfg", cf.markers.length === 1 && cf.heuristics && cf.idleMin === 30 && cf.diag !== "", JSON.stringify(cf));
ok("cfg default", parseDebugCfg(undefined).idleMin === 30 && !parseDebugCfg(undefined).heuristics, "");
// prefilter equivalence: 200 generated texts give the same counts with and without the fast path
let seed = 7; function rnd(n: number): number { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; }
const parts = ["x", "debug", "agentglass:debug", "#region debug", "TEMP", "temp-debug", "\n", " ", "print(", "Debug"];
for (let i = 0; i < 200; i++) {
  let t = ""; for (let j = 0; j < 12; j++) t += parts[rnd(parts.length)] ?? "";
  const fast = cnt(t, tab); const slow: number[] = []; for (let k = 0; k < tab.length; k++) { let n = 0; for (const l of t.split("\n")) if (l.toLowerCase().indexOf(tab[k] ?? "") >= 0) n++; slow.push(n); }
  if (fast.join(",") !== slow.join(",")) { ok("prefilter " + JSON.stringify(t), false, fast.join(",") + " vs " + slow.join(",")); break; }
}
console.log(bad ? bad + " failed" : "debug markers: all checks passed");
if (bad) process.exit(1);
```

- [ ] **Step 2: Run** the single-check command on `src/features/debug/markers.check.ts`. Expected: build FAIL (modules missing).
- [ ] **Step 3: Implement** `markers.ts` and `config.ts` (config reads through `section()` from `src/util/config.ts:37`; the startup toast for `diag` follows the pattern of other config diagnostics — `grep -rn "configProblem\|startup toast" src | head` and reuse it).
- [ ] **Step 4: Run** → `debug markers: all checks passed`; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(debug): marker table, debug-print fragments and debug config`.

---

### Task 2: `editText` port, seven adapters, the edit tap — wave 1, parallel with T1

**Files:** Modify `src/harness/types.ts` (`EditText`, optional `editText`), `src/harness/common.ts` (`editTextOf`), `src/features/usage/calls.ts` (`patchTexts` beside `patchFiles`, `calls.ts:187`), `src/features/usage/record.ts` (`EDITS`, `edits()`), `src/harness/claude.ts:296-302`, `codex.ts:279-291`, `gemini.ts:404-411`, `pi.ts:296-303`, `opencode.ts:354-360`, `kiro.ts:141-146`, `fx.ts:96-98`; Create `src/harness/edittext.check.ts`.

**Interfaces — Produces:**
- `export interface EditText { path: string; added: string; removed: string; whole: boolean; gone: boolean }` (types.ts).
- `HarnessAdapter.editText?: (name: string, inp: Obj | null, raw: string) => EditText[]`.
- `export function editTextOf(name: string, inp: Obj | null, raw: string): EditText[]` (common.ts) — spec §3.1 shapes; path from `file_path`/`filePath`/`path`/`notebook_path`; `Write`/`write`/`write_file`/`create` with `content` → whole; patch text → `patchTexts`.
- `export interface PatchText { p: string; added: string; removed: string; whole: boolean; gone: boolean }`; `export function patchTexts(patch: string): PatchText[]` (calls.ts) — same file split as `patchFiles` (a check asserts equal file lists and that `nlines(added)`/`nlines(removed)` equal `patchFiles`' add/del on every fixture).
- `export const EDITS = { on: false, tap: (a: Acc, d: Day, cid: string, t: number, e: EditText[]): void => {} }` and `export function edits(a: Acc, d: Day, cid: string, t: number, e: EditText[]): void` (record.ts) — returns at once unless `EDITS.on`.
- Each adapter: at the site where it calls `file()`/`patchLines()` for an edit tool, also `if (EDITS.on) edits(a, d, id, t, (ad.editText ?? editTextOf)(name, inp, raw))` with its own call id and time (Kiro: `t = 0`). Overrides: Codex (exec-embedded patches unescaped per T0 Step 3), Kiro (`command`), fx (patch first). Call the optional member through a local (scriptc).

- [ ] **Step 1: Failing check** `src/harness/edittext.check.ts`: set `EDITS.on = true` and `EDITS.tap` to a collector of `[harness, cid, t, path, added, removed, whole, gone]`; feed one hand-written line per shape through `harnessOf(h).usage(newAcc(), line)`; assert exactly:
  - claude `Edit` (`old_string: "a\n"`, `new_string: "a\n// agentglass:debug\n"`) → one entry, path `/w/src/a.ts`, removed `"a\n"`, added as given, whole false; `MultiEdit` two edits → two entries; `Write` → whole true; `NotebookEdit` → whole false, removed `""`;
  - codex `apply_patch` custom tool input with `*** Update File: src/a.ts` (`-x`, `+y // agentglass:debug`) → added `"y // agentglass:debug"`, removed `"x"`; `*** Add File` → whole; `*** Delete File` → gone; an `exec` input holding `tools.apply_patch("*** Begin Patch\\n*** Update File: b.py\\n-print(\\"a\\")\\n+print(\\"b\\")\\n*** End Patch")` → path `b.py`, removed `print("a")`, added `print("b")`;
  - gemini `replace` ok → entry; the same call failed (error result) → none; `write_file` → whole;
  - pi `edit` with `edits[]` (`oldText`/`newText`) → one entry per edit; legacy top-level → one; `write` → whole;
  - opencode `edit`, `write`, `multiedit`, `apply_patch` `patchText` (file and HTTP part shapes from `opencode.check.ts`) → entries as above;
  - kiro `fs_write` `create` → whole, `t === 0`; `strReplace` → removed `oldStr`, added `newStr`; `insert` → added only;
  - fx `arguments_json` with `*** Begin Patch` → patch entries; with `path` + `content` → whole;
  - **counts unchanged:** for every fixture line, `Acc.add`/`Acc.del`/files map with `EDITS.on` true equal the values with it false;
  - `EDITS.on = false` → collector stays empty (no work).
- [ ] **Step 2: Run** the single check on `src/harness/edittext.check.ts`. Expected: build FAIL (`EDITS` missing).
- [ ] **Step 3: Implement** types, `editTextOf`, `patchTexts`, `EDITS`/`edits`, the seven call sites and three overrides.
- [ ] **Step 4: Run** → `edittext: all checks passed`; `harness.check.ts`, `opencode.check.ts`, `kiro.check.ts`, `gemini.check.ts`, `pi.check.ts`, `calls.check.ts` unchanged and green; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(harness): editText — the text each edit adds and removes, for all seven harnesses`.

---

### Task 3: Capture into `Acc`, codec, `VERSION` — wave 2, alone

**Files:** Create `src/features/debug/types.ts`, `src/features/debug/capture.ts`, `src/features/debug/capture.check.ts`; Modify `src/features/usage/record.ts` (`Acc` fields `de`, `dp`, `dh`, `dhc`, `dr`; `newAcc`), `src/features/usage/codec.ts:13,105,119` (`VERSION` → next free; keys `de`, `dp`, `dh`, `dhc`, `dr`), `src/main.ts` (import `./features/debug/capture.ts`, which sets `EDITS.on = true` and the tap).

**Interfaces — Produces** (`types.ts`; spec §3.2, §4, §5):
- `export interface DEv { t: number; cid: string; f: string; k: number; d: number }` — `k ≥ 0` marker index; `-1` paired print; `-2` revert; `-3` possible print; `d` = `+n`, `-n`, or `1000000 + n` (whole write: absolute count), `0` with `k = -4` for a `restore` mark.
- `export interface DProbe { f: string; k: number; open: number; added: number; removed: number; t0: number; c0: string; t1: number; c1: string }`.
- `export interface DiskState { path: string; k: number; disk: string /* present removed gone unverified */; line: number /* 0 unknown */ }`.
- `Acc.de: DEv[]` (≤ 256), `Acc.dp: DProbe[]` (≤ 64), `Acc.dh: number[]` (`[hash, t]` pairs, ≤ 128 entries, oldest dropped) with `Acc.dhc: string[]` (the call id of each pair, same order), `Acc.dr: number[]` (≤ 64 hashes).
- `capture.ts`: `export function tap(a: Acc, d: Day, cid: string, t: number, e: EditText[]): void` (registered in `EDITS`); `export function restoreMark(a: Acc, cid: string, t: number, cmd: string): void` (called from the shell-command path: `git checkout -- …`, `git restore`, `git stash` except `list`/`show`, `git reset --hard`, `git apply -R`; hook it where `pend()` sees the command, `record.ts:220-235`, through a second tap `EDITS.cmd`); `export function folds(a: Acc): DProbe[]`; `export function openCount(a: Acc): number` (explicit + paired open).

- [ ] **Step 1: Failing check** `capture.check.ts` (calls `tap` directly with hand-made `EditText` lists; marker table from T1):
  - add `// agentglass:debug` ×2 in `src/a.ts` → `dp` entry `{open: 2, added: 2}`, one `DEv` `d = +2`; remove one → `open 1`; whole write of `src/a.ts` with no marker → `open 0`, `DEv d = 1000000`; `gone` → `open 0`;
  - removing a marker never added → `open` stays `0`, a `DEv` `d = -1` is kept;
  - `README.md` with a marker → nothing recorded;
  - paired print: add `console.log('v', v)` in `x.ts` (no marker) → no `DEv`, `dh` has one entry; later remove the same trimmed line → two `DEv` `k = -1` (`+1` at the add's time and cid, `-1` now), `dh` empty; the same line removed in another file → no pair;
  - heuristics on (`setDebugCfgForTest`): an unpaired print open at the end → `DEv k = -3`, counted as `possible`, never in `openCount`;
  - revert: edit adds `if (x) return 1;` then a later edit removes exactly that block → `DEv k = -2`;
  - caps: 300 marker adds over 300 files → `de.length === 256`, `dp.length === 64` with closed entries dropped first, totals of the kept folds exact;
  - `restoreMark` on `git restore src/a.ts` → `DEv k = -4`; `git stash list` → none;
  - **codec round trip**: `accIn(JSON.parse(JSON.stringify(accOut(a))))` equals field by field; the encoded line contains no `CANARY-DBG-7` (the fixture's probe lines carry it);
  - `VERSION` equals the old value + 1.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; bump `VERSION` with a comment entry in `codec.ts:13` ("19: Acc.de/dp/dh/dr debug probes (debug-episodes)" — the number as found). If another spec bumped in the same release window, share its number and append to its comment.
- [ ] **Step 4: Run** → `debug capture: all checks passed`; `harness.check.ts` (it round-trips `accOut`/`accIn`), `cachemig.check.ts`, `codec.check.ts`, `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(debug): capture probes, paired prints and reverts per session (ledger VERSION bump)`.

---

### Task 4: Disk verification — wave 3, parallel with T5

**Files:** Create `src/features/debug/verify.ts`, `src/features/debug/verify.check.ts`.

**Interfaces — Produces:**
- `export function verifyProbe(s: Sess, f: string, k: number, table: string[], content: boolean): Verified` (`export interface Verified { path: string; k: number; disk: string; line: number; text: string }`, a named type: no intersections under nominal typing) — spec §4 table; path resolution against `realCwd(s)` (`src/hooks.ts:86`); allowed roots = the session's project root (`projectOf` / the cwd) and `$HOME`; regular files only; ≤ 4 MiB (`readText(p, 0, 4194304)`); first matching line number; `text` only when `content`.
- `export function verifySession(s: Sess, a: Acc, content: boolean): DiskState[]` — every open explicit probe (and `possible` prints with heuristics on; their match is the line hash from `dh`).
- `export function sweep(now: number): number` — the 60 s sweep over sessions with `openCount > 0`, ≤ 64 paths per call, round robin; returns paths touched (for the footprint check). Registered on `H.onTick` with its own 60 s gate.
- Cache: `Map<path, {size, mtime, lines: [k, line][]}>` ≤ 512 entries, cleared when full.
- `export const VSTAT = { stats: 0, reads: 0 }` (check counters).

- [ ] **Step 1: Failing check** `verify.check.ts` (fake `HOME` under `$C/home`, files written by the check):
  - file with the marker on line 3 → `present`, `line 3`, `text` empty unless `content`;
  - marker removed on disk → `removed`; file deleted → `gone`;
  - relative path with the session cwd `/…/proj` → resolved; no cwd → `unverified`;
  - `../../etc/hosts`, `/etc/hosts`, a symlink pointing outside `$HOME` → `unverified`, `VSTAT.reads` unchanged;
  - 5 MiB file → `unverified`;
  - second call with the same `(size, mtime)` → `VSTAT.reads` unchanged; touch the file → one more read;
  - remote row (`s.host = "h1"`) → `unverified`, no stat;
  - `sweep` with 100 sessions of which 2 have open probes → touches only their paths; with 0 open → returns 0, `VSTAT.stats` unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (T0 Step 6 decides `realpathSync` vs `lstat`). **Step 4: Run** → PASS; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(debug): verify open probes against the file on disk`.

---

### Task 5: Episode model (pure) — wave 3, parallel with T4

**Files:** Create `src/features/debug/model.ts`, `src/features/debug/model.check.ts`, `src/features/debug/fixture.ts` (synthetic builders shared by later checks).

**Interfaces — Produces:** `Step`, `Episode` exactly as spec §5; `export function detect(de: DEv[], rows: Rows | null, fold: DProbe[], disk: DiskState[], cfg: DebugCfg, live: boolean, lastAt: number, now: number, h: string, id: string): Episode[]`; `export function mergeStreams(parts: DEv[][]): DEv[]` (subagents, time order, stable). Families via `rowFam`/`famName` and kinds via the agent-wait API (`src/features/wait/family.ts:419-520`), programs via `rowIds(r, i, KIND_PROG)`.

`fixture.ts` builds `Rows` and `DEv[]` from a compact script: `["12:04:31 probe+ src/auth.ts k0 x2 c1", "12:05:02 run pnpm test auth fail c2", "12:06:40 read tmp/debug.ndjson c3", …]`.

- [ ] **Step 1: Failing check** `model.check.ts`, three sessions plus edge cases:
  - **explicit-marker debug run** (the panel example of spec §8.1): one episode, `state closed`, `outcome verified`, `runs 9` (`failed 7`, `repro 8`, `verify 1`), `fixes 3`, `reverted 1`, `reads 2`, `evidence ["tmp/debug.ndjson"]`, `t0`/`t1` = first probe / verify run, steps in order, untagged commands collapsed only in views (the model lists them);
  - **ad-hoc print debugging** (paired prints, `pytest -k x` ×4): one episode from the paired `probe+` to the `probe-` plus the verify run;
  - **no-debug control** (edits and tests, no probes): `[]`;
  - idle split: two probe spans 45 min apart → two episodes; 10 min apart → one (reopened);
  - open probe, session live → `open`; not live, disk `present` → `leftover`; disk `removed` → `closed`; `unverified` → `open`, `outcome unknown`;
  - Kiro (all `t = 0`, rows matched by `cid`): order by row index, `t0 = t1 = 0`;
  - `rows = null` (older than `callDays`): probe steps only, runs/fixes/reads `-1` (the query maps to `null`);
  - subagent stream merged: parent removes the subagent's probe → closed;
  - > 200 steps → `steps.length === 200`, counts exact;
  - `key` = `"claude:<id>#c1"`; without cid `"#s0"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → `debug model: all checks passed`; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(debug): episode detection over the probe stream and call rows`.

---

### Task 6: Query layer, `DebugVM`, golden, stubs — wave 4, alone

**Files:** Create or extend `src/model/marks.ts` (spec §6.1; see Round), `src/features/debug/marks.ts` (the `debug` provider); Create `src/features/debug/query.ts`, `src/features/debug/query.check.ts`, `testdata/debug/vm.golden.json`, stubs `src/features/debug/cli.ts` and `src/features/debug/view.ts` (header comment only), `src/features/debug/index.ts` (imports `capture.ts`, `verify.ts`, `cli.ts`, `view.ts`); Modify `src/main.ts` (replace T3's capture import with `./features/debug/index.ts`).

**Interfaces — Produces** (spec §6): `debugOf(s, o): Obj`, `debugList(sel, o): Obj[]`, `debugFacts(s): DebugFacts`, `DebugOpts`, `export const DEBUG_FIELDS: string[]` (list-row fields in order: `session, harness, title, episodes, open, leftover, possible, lastAt, wallMs, costUsd, link`); memo per `(s.path, ledger generation)`; cost per spec §5.4 from `Day.hc` with the honest-costs billing label; links via `canonicalUrl` (`src/features/palette/ref.ts:233`); paths via `display("file", p, s)`.

- [ ] **Step 1: Failing check** `query.check.ts` with `fixture.ts` sessions in a fake `HOME`:
  - `JSON.stringify(debugOf(s, {content: false, subagents: true, now}), null, 2)` equals `testdata/debug/vm.golden.json` byte for byte (write the golden from the spec §6 example adapted to the fixture; review it by eye, then commit it);
  - Kiro fixture: `from`, `to`, `wallMs`, `costUsd` are `null`; old fixture without rows: `runs` is `null`;
  - `content: true` adds `probes[].text`; `false` has no `text` key anywhere;
  - every `link` parses with `parseRef` and resolves to the fixture session and call;
  - under `AGENTGLASS_REDACT=1` paths are faked (no fixture project name in the JSON);
  - `debugFacts` reads no call rows (counter on `callsOf`);
  - `marksOf(s, ["debug"])` returns one `debug:episode` span per episode plus one point mark per step, with kinds equal to `steps[].kind`, `anchor` `call=<cid>`, Kiro marks `t0 0` ordered by `seq`; changing only the disk state (marker removed on disk) changes `gen(s)` and the memoised result.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(debug): DebugVM query layer with links and a golden`.

---

### Task 7: CLI `agentglass debug` — wave 5, parallel with T8, T9

**Files:** Fill `src/features/debug/cli.ts`; Create `scripts/debug.test.sh`; Modify `docs/cli-contract.md` (section "`agentglass debug`"), `scripts/contract.test.sh` (fields).

**Interfaces — Produces:** `addCmd(cmd("debug", …))` with options `--since` (7d), `--leftover`, `--check`, `--content`, `--subagents` (default on for a ref), `--all-projects`, `--format table|json|csv`, `--json`, `--fields`, `--limit` (20), `--instructions`; JSON = `DebugVM` (ref) or `{rows, scope}` (list); text panel lines shared with T8 through a pure `export function panelLines(vm: Obj, w: number, color: boolean): string[]` — **T7 owns it in `src/features/debug/lines.ts`**, T8 imports it (create the file in T7; T8 may start against the function signature and a local copy of the spec mock, then rebase).

- [ ] **Step 1: Failing test** `scripts/debug.test.sh` (pattern of `scripts/wait.test.sh`: fake `HOME`, own build or `AGENTGLASS_BIN`): a Claude session in `/w/app` (fake HOME project) with an `Edit` adding `// agentglass:debug CANARY-DBG-7` to `src/a.ts`, two failing `Bash` `pnpm test` runs, a fix edit, a passing run, and the file `src/a.ts` on disk still holding the marker; a second session that adds and removes it; a Codex session with paired prints; assert with `jq`:
  - `debug --json` (list) → two rows with episodes, the first `leftover == 1`; field order equals `DEBUG_FIELDS`;
  - `debug <id> --json` → `.episodes[0].runs.failed == 2`, `.probes[0].disk == "present"`, `.probes[0].line == 1`, no `CANARY-DBG-7` anywhere; with `--content` it appears once;
  - `debug --leftover --json` → one row with `.leftovers[0].file == "src/a.ts"`;
  - `debug --check` in agent mode with the fake agent as current session → exit 3, stdout names `src/a.ts:1`; after removing the marker from the file → exit 0;
  - `debug --instructions` → contains `agentglass:debug` and `agentglass debug --check`, ≤ 80 columns;
  - text output: no line > 80 columns (ANSI stripped); `--redact` → no `app` project name in output;
  - `debug --since nope`, `debug a b` → exit 2 with a hint; `--help --format json` lists every field (contract test).
- [ ] **Step 2: Run** `sh scripts/debug.test.sh` → FAIL (unknown command). **Step 3: Implement** (`complete()` for the listed sessions, then `verifySession`; agent scope via `agentScope`). **Step 4: Run** → PASS; `scripts/contract.test.sh`, `scripts/clihelp*`, `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(cli): agentglass debug — episodes, leftovers, --check, --instructions`.

---

### Task 8: TUI panel, badge, preview, help, palette — wave 5, parallel with T7, T9

**Files:** Fill `src/features/debug/view.ts`; Create `src/features/debug/view.check.ts`.

**Interfaces — Produces:** view `"debug"` (`H.views`); keys via `H.keys`: `E` in `transcript` mode and `list` mode on tab 0 → open; inside the view `j/k ↑↓` step, `]`/`[` episode, `g`/`G`, `↵` apply the step's link (`resolve(parseRef(link))` + `applyTarget`, `src/features/palette/apply.ts`, `open.ts`) and set `inTx`, `esc`/`q`/`←` back (and from a transcript opened by the panel back to the panel, as `related/view.ts:306-308`), `r` related at the step's event, `y` copy link; `H.rowBadges` `⚑` (yellow, after watchdog/herdr); `H.previewSections` one line; `H.helpSections` `{name: "debug", ctx: "transcript"}` with keys and markers; `H.footerHints` `E debug` in transcript and list (tier 2), the view's own footer; palette action "Debug episodes" (`H.actions`, key `E`). Kind filtering inside the panel and in other timelines uses the shared event-kind chips of `src/model/marks.ts` (family `debug`, names per spec §6.1); the panel adds no filter of its own.

- [ ] **Step 1: Failing check** `view.check.ts` (fixture sessions from `fixture.ts`, `S.W` 80 then 120):
  - rendered lines equal the spec §8.1 mock at 80 columns (golden strings in the check, ANSI stripped); no line wider than `S.W`;
  - at 120 a duration column appears;
  - `E` in transcript → `S.mode === "view"`, `S.fview === "debug"`; `↵` on the `run` step → transcript open, `S.tv.cur` on the event with that call id; `esc` → back in the view; `esc` again → transcript of origin;
  - session without activity → the one-line hint naming the markers and `agentglass debug --instructions`;
  - `⚑` badge only for `leftover > 0`; not for `possible`; with `◆` present the slot shows `◆⚑`;
  - preview line text as spec §8.2;
  - help popup contains a "debug" section; the transcript footer contains `E debug`;
  - with the shared kind filter showing only `debug:repro`, the panel lists only repro runs, and hidden steps collapse into one gap line (`… 5 hidden`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (render reads only `debugOf`/`debugFacts`; never `model.ts`). **Step 4: Run** → PASS; `src/ui/footer.check.ts`, `help.check.ts`, `palette.check.ts`, `sh scripts/check.sh` PASS.
- [ ] **Step 5: Live look** (isolation set, tmux, `AGENTGLASS_AGENT=0`, fake `HOME` from T7's test fixture): open the panel at 80×24 and 120×40, capture with `tmux capture-pane -p`, attach both captures to the PR; kill the tmux session you started.
- [ ] **Step 6: Commit** `feat(tui): debug episode panel (E), leftover badge and preview line`.

---

### Task 9: Filter attributes and the `leftover` rule — wave 5, parallel with T7, T8

**Files:** Modify `src/features/query/attrs.ts` (after `kind`, `attrs.ts:99`), `src/features/query/eval.ts` (session cases), `src/features/rules/config.ts:21-45` (`METRICS`, `UNITS`, `DEFMSG`), `config.ts:169-181` (`builtins()` gains `leftover`), `src/features/rules/metrics.ts:30-34` (`sessMetric` case), the placeholder `{file}` in `engine.ts` `placeholders()`; Test `src/features/query/eval.check.ts`, `src/features/rules/config.check.ts`, `src/features/rules/metrics.check.ts` (append).

**Interfaces — Produces:** attributes `debug` (session, enum, multi: `episode open leftover unverified possible clean`), `debug.episodes` (num), `debug.probes` (num) read from `debugFacts`; metric `leftover_probes` (count; absent while `busy(s)`); built-in `mk("leftover", "leftover_probes", ">=", 1, -1, "look", false, "{value} debug probe(s) left in {file}", "leftover", "[leftover] ")`, enabled.

- [ ] **Step 1: Failing checks**: (eval) `debug is leftover` matches only the leftover fixture; `debug is episode and debug.episodes >= 2`; `debug is possible` empty unless heuristics on; unknown value → the existing "unknown value" error with the enum listed; (config) `builtins()` contains `leftover` enabled; `{"rules":[{"id":"leftover","enabled":false}]}` disables it; `rules defaults` lists it; (metrics) busy session → absent; idle with 2 present probes → 2; with `removed` → 0; message renders `2 debug probe(s) left in src/a.ts`; `{file}` with 3 files → `src/a.ts +2`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `scripts/rules.test.sh`, `scripts/filter-cli.test.sh`, `sh scripts/check.sh` PASS; `agentglass rules defaults` diff shows only the new entry (paste in the PR).
- [ ] **Step 5: Commit** `feat(rules): leftover-instrumentation rule and debug filter attributes`.

---

### Task 10: MCP `debug` tool — wave 6, alone

**Files:** Modify `src/mcp/tools.ts` (`SPECS` entry, argv mapping, `TRIM` fields `steps`, `episodes`, `probes`), `src/mcp/shape.ts` (strip `probes[].text`, `leftovers[].text` without `--content`), `testdata/mcp/tools-2025-11-25.json`, `testdata/mcp/tools-2024-11-05.json`, `docs/cli-contract.md` (MCP section: tool list), `scripts/mcp.test.sh` (cases), `src/mcp/tools.check.ts`.

**Interfaces — Produces:** tool `debug` (spec §10): inputs `ref` (REF pattern), `leftover` (bool), `since` (SINCE "7d"), `limit` (LIMIT(100, 20)), `cursor`; output schema `OBJ({ episodes: T("array"), probes: T("array"), summary: T("object"), rows: T("array"), next: TN("string") })` — every property a field the CLI lists in `debug --help --format json` (the existing schema-vs-CLI check enforces it).

- [ ] **Step 1: Failing tests**: `tools.check.ts` — the argv for `{}` is `["debug", "current", "--format", "json"]`, for `{leftover: true}` `["debug", "--leftover", "--since", "7d", "--limit", "21", "--format", "json"]`; a ref starting with `-` is rejected; `mcp.test.sh` — `debug {}` from the fake agent returns its episodes; the canary `CANARY-DBG-7` absent without `--content`, present with it; a 30-episode fixture is cut under the 24 KB cap with `truncated` naming `steps`; goldens regenerated and diffed (only the new tool).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `scripts/mcp-imports.test.sh` (no feature import in `src/mcp/*`), `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(mcp): debug tool — leftovers and debug loops of the calling session`.

---

### Task 11: Old-behavior golden, footprint, docs, final review — wave 7, alone

**Files:** Modify `README.md` (keys table: `E`; section "Debug episodes" with the marker convention and `--instructions`; CLI list; MCP tools list; config keys `debug.*`; filter keys), `CHANGELOG.md` (Unreleased), `specs/ROADMAP.md` (status of this entry), `specs/debug-episodes/spec.md` (answers to open questions, under "Answers").

- [ ] **Step 1: Old behavior**: `nice sh scripts/golden-usage.sh > $C/golden-after.txt && diff $C/golden-before.txt $C/golden-after.txt`. Expected: no difference.
- [ ] **Step 2: Footprint** (`scripts/footprint.sh`, its own isolation; read its header): idle TUI CPU and RSS against `main` within noise, RSS + ≤ 1 MB; cold full index CPU + ≤ 2 % (open question 5); panel open on the 2,000-call fixture ≤ 50 ms (`AGENTGLASS_TRACE`-style timing or a check timer). Put the numbers in the PR. Over budget → prefilter only the added text for prints (spec open question 5) and re-measure.
- [ ] **Step 3: Docs**: README sections listed above, all examples synthetic, 80-column code blocks; CHANGELOG entry; ROADMAP status "implemented, PR open".
- [ ] **Step 4: Final review** (superpowers:requesting-code-review) against the Review Focus list; fix findings; `./build.sh && sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `docs: debug episodes — README, changelog, roadmap, open-question answers`. Open the PR to `main`.

---

## Phase 2 (specified in spec §13, not part of this plan)
Each gets its own plan after this one ships: evidence lane (§13.1), MCP `timeline` and the call-graph band (§13.2),
fix churn in triage and a Stats debugging share (§13.3), `--watch`/OTLP episode events (§13.4). Web UI readiness
(§13.5) is guaranteed by Task 6's contract and golden; no task builds a web UI.
