# TUI Footprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TUI steady RSS ≤ 300 MB (from ~820 MB), warm first frame ≤ 1 s (from 2.3 s), cold start with a visible indexing gauge, TUI CPU with 36 streaming agents ≤ 1 % excluding ingest and ≤ 2 % in all (from 19.1 %), cold full-index peak ≤ 500 MB (from 875 MB) — with costs, tokens, tool counts and call rows identical to main.

**Architecture:** The ledger cache becomes one session per line, streamed in and out (`cache.ts`); call rows are read lazily through one accessor and stored columnar (`rows.ts`); the ledger tick, session scan, `buildView`, billing labels and git attribution do work only for what changed; Linux reads `/proc` incrementally instead of spawning `ps`; frames are built only on visible change and flushed row-wise. Two scripts measure footprint and compare outputs against a reference binary.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first, including "Today" (the measured causes) and "Decisions"; the former open questions are Task 0 Step 6 probes with fixed fallbacks.

**Round:** 2 (after 2026.10.4). No other plan must be merged first. model-prices shares `codec.ts`/`VERSION` (spec "Interactions").

## Task graph (parallelism)

| wave | tasks | runs | needs merged |
|---|---|---|---|
| 0 | T0 tooling | alone | — |
| 1 | T1 cache file · T2 ledger tick + gauge · T3 /proc lister · T4 git attribution · T5 scan + view · T6 frames | **in parallel**, one implementer and one worktree each; file sets are disjoint (table below) | T0 |
| 2 | T7 lazy call rows | alone | T1, T2 |
| 3 | T8 columnar call rows | alone | T7 |
| 4 | T9 verification + results | alone | all |

| task | owns (only this task edits them in its wave) |
|---|---|
| T0 | `scripts/footprint.sh`, `scripts/golden-usage.sh`, `src/util/selfmem.ts` (new), `src/util/footprint-probes.check.ts` (new), `src/main.ts` (debug line only) |
| T1 | `src/features/usage/cache.ts`, `src/features/usage/cachefile.ts` (new), `src/features/usage/cachefile.check.ts` (new), `src/features/cli.ts` (`--watch` read window), `scripts/cache-cli.test.sh`, `scripts/filter-cli.test.sh` (file name only) |
| T2 | `src/features/usage/ledger.ts`, `src/features/usage/progress.ts` (new), `src/features/usage/ledger.check.ts` (new), `src/features/usage/stats.ts` (one import line) |
| T3 | `src/platform/linux.ts`, `src/platform/procfs.ts` (new), `src/platform/procfs.check.ts` (new), `src/platform/types.ts`, `src/platform/darwin.ts`, `src/model/procs.ts` |
| T4 | `src/features/vcs/attrib.ts`, `src/features/vcs/view.ts`, `src/features/vcs/attrib-inc.check.ts` (new) |
| T5 | `src/util/fs.ts`, `src/harness/{claude,codex,gemini,pi,kiro,fx}.ts` (scan walks only), `src/model/sessions.ts`, `src/features/usage/bill-live.ts`, `src/model/view.check.ts` (new), `src/util/fs.check.ts` (new or extended) |
| T6 | `src/main.ts` (job bodies, dirty policy), `src/ui/frame.ts`, `src/ui/frame.check.ts` (new) |

T0 and T6 both edit `src/main.ts`; T0 merges first, T6 rebases.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`; a task is done only when both pass. Single check: `scriptc build <f> -o /tmp/claude-1000/tf-x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/claude-1000/tf-x`.
- scriptc 0.1.7: nominal typing (pass fields, not foreign interfaces); no `Record<string, RegExp>` (C backend); out-of-range array reads trap (bounds-check or `numAt`); an element read used as an index needs `+ 0` (SC1090); a zero-parameter arrow for an optional interface member is rejected (SC2003); no Unix sockets, no crypto; `fs.watch` listeners get no file name; strings kept beyond the current line/tick go through `own()` (`src/util/own.ts`).
- **Exactness**: `scripts/golden-usage.sh` must report `0 differences` where a task says so. Never change a number to make it pass; a difference is a bug in the task.
- Measurements on the shared host: one build at a time, at most one agentglass TUI at a time (killed right after), `nice -n 10`, every `AGENTGLASS_*` path in a scratch dir (the scripts do this), `AGENTGLASS_AGENT=0` in tmux. Never touch `~/.agentglass`. Kill only PIDs/tmux sessions you started.
- `VERSION` (`src/features/usage/codec.ts:12`) does **not** change in this plan (no cached data changes meaning). If model-prices lands first, rebase onto its number.
- Output contracts unchanged: `--json`, `cost`, `sessions`, `errors`, `triage`, `compare`, `--watch` lines.
- Keys, help, footer: only T2 adds a visible element (header gauge) and its help line.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Worktree `../agentglass-tf-<task>`, branch `perf/tf-<task>` (e.g. `perf/tf-t3-procfs`) from `origin/main` after the task's dependencies merged; one PR per task, rebase-merge after green CI. Each PR body carries the task's before/after numbers.

## Review Focus

1. **Exactness**: golden comparison output in each PR (`0 differences`, compared ≥ 1,500 stable sessions on this host). Any `skipped` count far above the live-session count is suspicious.
2. **Stale cache risks** (T1): a crash between calls files and `ledger.jsonl`, a corrupt line, a migration from `ledger.json`, a line over the window — never mixes states; at worst one session re-indexes.
3. **Rows held by reference** (T8): no reader keeps a row view or index past its callback; `prune()` remaps every `Pend.ri` and `lastCall`.
4. **Missed changes** (T2, T4, T5, T6): every skip is keyed on inputs that cover all writers (ledger restart = new `Acc` object, ownership `restart`, billing `stamp`, filter on ledger values, time-based subagent auto-expand). Checks flip each input once.
5. **/proc parsing** (T3): `comm` with spaces and `)`, kernel threads, pid reuse, vanished pids, `tty_nr` decoding; `listProcs()` vs `psProcs()` agree on this host.

---

### Task 0: Footprint and golden scripts, RSS in the debug footer

**Files:** Create `scripts/footprint.sh`, `scripts/golden-usage.sh`, `src/util/selfmem.ts`, `src/util/footprint-probes.check.ts`; Modify `src/main.ts:147` (debug line).

**Interfaces — Produces:**
- `sh scripts/footprint.sh --bin <path> (--cold | --warm <cache dir>) [--warmup 30] [--window 120] [--scratch <dir>]` prints exactly these lines: `first_frame_ms <n>`, `rss_mb_5s <n>`, `rss_mb_30s <n>`, `rss_mb_end <n>`, `cpu_self_pct <x.xx>`, `cpu_children_pct <x.xx>`, `cpu_total_pct <x.xx>`. Linux only (exits 2 with `footprint.sh: Linux only` elsewhere). `--warm` copies the dir into the scratch first.
- `sh scripts/golden-usage.sh --ref <bin> --new <bin> (--cold | --warm) [--harness h] [--scratch <dir>]` prints `compared <n> stable sessions, skipped <m>`, then one line per difference (`<id> <field> ref=<v> new=<v>`), then `<k> differences`; exit 0 iff k = 0.
- `export function selfRssMb(): number` (`src/util/selfmem.ts`): `/proc/self/statm` field 2 × page size / 2^20, `-1` when unreadable (not Linux).
- `export const DEBUG_PARTS: (() => string)[] = [];` (`src/util/selfmem.ts`): extra debug-footer segments, appended after `rss` (T2 adds `ingest`).

- [ ] **Step 1: Worktree + reference binary.** `git worktree add -b perf/tf-t0-tooling ../agentglass-tf-t0 origin/main && cd ../agentglass-tf-t0 && nice ./build.sh && cp agentglass /tmp/claude-1000/agentglass-ref`. Expected: build ok. Keep `/tmp/claude-1000/agentglass-ref` for every later task (rebuild it from `origin/main` @ the commit this plan starts from if it is lost).
- [ ] **Step 2: Write `footprint.sh`** (POSIX sh; `scripts/sh-portability.test.sh` must pass). Mechanics as in spec 1: tmux `new-session -d -x 160 -y 45` with `env AGENTGLASS_CACHE_DIR=… AGENTGLASS_CONFIG=… AGENTGLASS_RULES=… AGENTGLASS_RUN_DIR=… AGENTGLASS_PALETTE_FILE=… AGENTGLASS_THEME_FILE=… AGENTGLASS_OTLP_DIR=… AGENTGLASS_AGENT=0 AGENTGLASS_NOTIFY=0 nice -n 10 <bin>`; pane pid = agentglass; first frame = first 50 ms poll where `tmux capture-pane -p` contains `─ sessions`; CPU from `/proc/<pid>/stat` fields 14+15 (self) and 16+17 (children) over the window ÷ `getconf CLK_TCK`; `trap` kills its tmux session on exit.
- [ ] **Step 3: Write `golden-usage.sh`.** Runs, with separate scratch caches and the same isolation env: `<bin> --json --subagents --fields id,harness,path,bytes,updated,tokens,costUsd,unpricedTokens,unpricedCredits,tools,linesAdded,linesRemoved,skills,billing`; the same with `--fields id` and each `--filter` of `'status is error'`, `'tool is Bash'`, `'duration > 30s'`; `cost --json --by session --since 30d`. `--cold`: both caches empty, ref first. `--warm`: ref indexes cold into A; A is copied to B; new runs on B. Comparison in `python3` (inline heredoc; repo scripts may use python3 — check `scripts/` precedent; if none, write it in POSIX awk over `--format jsonl`). Stable = in both, equal `bytes`, `updated` < ref start − 120 s.
- [ ] **Step 4: Self-test of the golden script**: `sh scripts/golden-usage.sh --ref /tmp/claude-1000/agentglass-ref --new /tmp/claude-1000/agentglass-ref --warm --harness claude`. Expected: `compared ≥ 1000 stable sessions …` and `0 differences`. Then feed it a known difference: temporarily edit the new run's JSON in the scratch (the script keeps it under `--scratch`) via `GOLDEN_SELFTEST=1` that adds 1 to the first stable session's `tokens.in` → Expected `1 differences`, exit 1.
- [ ] **Step 5: RSS in the debug footer.** In `turn()` (`main.ts:147`): `if (DBG.on) { const r = selfRssMb(); DBG.line = debugLine(sc, live(), armed(), why) + (r >= 0 ? " · rss " + String(r) + "M" : "") + extras(); }` with `extras()` joining `DEBUG_PARTS` results (" · " + each non-empty) and the same in `onData` (`main.ts:176`). Build; run `AGENTGLASS_DEBUG_REFRESH=1` through footprint's env once and `tmux capture-pane` the last row. Expected: `… · rss 8xxM` (≈ 810–830 on this host).
- [ ] **Step 6: Probes for the three unknowns** in `src/util/footprint-probes.check.ts` (runs in CI with every check; it never fails on the outcome, only on a crash; it prints one `RULING` line per probe, which goes into the PR and decides the later tasks):
  1. *Growable typed arrays.* Push 300,000 values into a `Float64Array` that doubles by copy (`new Float64Array(n * 2)` + `set`) and into a `number[]`; report whether both compile and run, the time, and `selfRssMb()` growth of each. `RULING typed-arrays yes` when the typed array builds, runs and grows ≤ 0.7 × the `number[]` growth; else `RULING typed-arrays no`. **Fallback (no):** T8 uses `number[]` columns (behind the same `Rows` interface; ~35 MB for 295k rows, still under target).
  2. *`/proc` children files.* On Linux, read `/proc/self/task/<pid>/children` after spawning one `sleep 1` child (`execFileSync` is synchronous, so use `spawn` from `node:child_process` and read before it exits); `RULING proc-children yes` when the child's pid is listed, `no` when the file is missing or empty; elsewhere `RULING proc-children n/a`. **Fallback (no):** T3's `childrenOf` returns `[]`; new children of tracked agents are found from new pids' `ppid` in every incremental pass (they are new pids, so their `stat` is read anyway) and by the 30 s full pass; the debug footer shows `nochildren`.
  3. *`own()` buffer after a streamed load.* Write a 40 MB JSONL file to a temp dir: 4,000 lines, each `{"path":"/p<i>","s":"<10 KB with escapes \\n>","k":"short<i>"}`; read it in 4 MB windows with `readLines`, `JSON.parse` each line, keep only `own(str(o["k"]))` in an array; report `selfRssMb()` growth. `RULING own-buffer ok` when growth ≤ 30 MB; else `RULING own-buffer copy`. **Fallback (copy):** T1's `readCache` passes `own(line)` to the parser and keeps nothing from a line it did not `own()`; T1 Step 8 re-measures RSS after load.
  Expected on this host: all three print a `RULING` line; the check prints `footprint-probes: done` and exits 0.
- [ ] **Step 6b: Baseline**: `sh scripts/footprint.sh --bin /tmp/claude-1000/agentglass-ref --warm <a cache made by golden --warm A> --warmup 30 --window 120` and `--cold --window 100`. Expected (spec "Today"): warm `first_frame_ms` 2200–2600, `rss_mb_end` 800–840, `cpu_total_pct` 15–22; cold `first_frame_ms` < 600. Paste into the PR.
- [ ] **Step 7:** `sh scripts/check.sh` PASS. Commit `chore(perf): footprint and golden-usage scripts, probes, rss in the debug footer`.

---

### Task 1: Ledger cache as one session per line, streamed (wave 1)

**Files:** Create `src/features/usage/cachefile.ts`, `src/features/usage/cachefile.check.ts`; Modify `src/features/usage/cache.ts:36-121`, `src/features/cli.ts:279`, `scripts/cache-cli.test.sh`, `scripts/filter-cli.test.sh` (only where they name `ledger.json`).

**Interfaces — Produces** (`cachefile.ts`, pure IO over a path, testable without the ledger):
- `export const FILE_FORMAT = 2;`
- `export interface Head { v: number; prices: string; rl: Obj | null }`
- `export function readCache(path: string, onHead: (h: Head) => boolean, onSession: (path: string, o: Obj) => void): { lines: number; bad: number }` — 4 MB windows of whole lines (`readLines`); a line longer than the window grows it ×4 up to 64 MB, else counted `bad` and skipped; `onHead` false → stop (stale); a line that does not parse or lacks `"path"` → `bad`.
- `export function writeCache(path: string, head: Head, each: (put: (path: string, o: Obj) => void) => void): boolean` — temp file `path + ".tmp"`, header line, one `JSON.stringify` per session, `renameSync`; false on any error (temp removed).
- `cache.ts`: `FILE = ledger.jsonl`, `OLD = ledger.json`; `load()` reads `FILE`, else migrates from `OLD` (today's whole-file path, kept as `loadOld()`); `save()` uses `writeCache` and removes `OLD` after a successful rename; `lastSave` starts at load time.

- [ ] **Step 1: Failing check** `cachefile.check.ts` (fake files under a per-process dir `/tmp/agentglass-cf-check-<pid>`):

```ts
import { readCache, writeCache, FILE_FORMAT } from "./cachefile.ts";
import { type Obj, str } from "../../util/json.ts";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-cf-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
const f = dir + "/ledger.jsonl";
const big = "x".repeat(5 * 1048576); // a line over the 4 MB window
ok("write", writeCache(f, { v: 15, prices: "P", rl: null }, (put) => { put("/a", { off: 1 }); put("/b", { off: 2, s: big }); put("/c", { off: 3 }); }), "false");
ok("no tmp left", !existsSync(f + ".tmp"), "tmp");
const got: string[] = [];
const r = readCache(f, (h) => h.v === 15 && h.prices === "P", (p: string, o: Obj) => { got.push(p + ":" + String(o["off"])); });
ok("all sessions, long line included", got.join(",") === "/a:1,/b:2,/c:3", got.join(","));
writeFileSync(f, '{"v":15,"f":' + String(FILE_FORMAT) + ',"prices":"P"}\n{"path":"/a","off":1}\n{"path":"/b","off":\n{"off":9}\n{"path":"/c","off":3}\n');
const g2: string[] = []; const r2 = readCache(f, (h) => true, (p: string, o: Obj) => { g2.push(p); });
ok("corrupt and pathless lines skipped", g2.join(",") === "/a,/c" && r2.bad === 2, g2.join(",") + " bad=" + String(r2.bad));
const g3: string[] = []; readCache(f, (h) => false, (p: string, o: Obj) => { g3.push(p); });
ok("stale header stops", g3.length === 0, g3.join(","));
console.log(bad ? bad + " failed" : "cachefile: all checks passed");
if (bad) process.exit(1);
```

- [ ] **Step 2: Run** `scriptc build src/features/usage/cachefile.check.ts -o /tmp/claude-1000/tf-cf && /tmp/claude-1000/tf-cf`. Expected: build FAIL (module missing).
- [ ] **Step 3: Implement** `cachefile.ts` as specified. `own()` every kept string is `accIn`'s job (already), not this file's.
- [ ] **Step 4: Run** the check → `cachefile: all checks passed`.
- [ ] **Step 5: Wire `cache.ts`.** `load()`: `readCache(FILE, head → readable(v) && prices === PRICES_SIG (then rlIn), (path, o) → today's loop body cache.ts:52-59)`; when `FILE` is missing and `OLD` exists: `loadOld()` (today's code) then `L.idx++` so the next save writes `FILE`. `save()`: calls files first (unchanged), then `writeCache(FILE, {v: VERSION, prices: PRICES_SIG, rl: rlOut()}, put → for each existing session with `a.off > 0`: put(path, accOut(a, KEEP_IDS)))`; on success `unlinkSync(OLD)` if it exists. `let lastSave` = `Date.now()` at the end of `load()`.
- [ ] **Step 6: Extend `cachefile.check.ts`** or `scripts/cache-cli.test.sh` with the cache-level cases (shell test, real binary, a fixture `HOME` as the existing test builds it): (a) first run writes `ledger.jsonl`, no `ledger.json`; (b) put an old-format `ledger.json` produced by `/tmp/claude-1000/agentglass-ref` on the same fixture → new binary runs `--json`, output equal, `ledger.json` gone, `ledger.jsonl` present, and the fixture logs were not re-read (`AGENTGLASS_DEBUG_LEDGER` is not available: assert by making the fixture logs unreadable `chmod 000` after the ref run — numbers still equal); (c) truncate the last line of `ledger.jsonl` → next run still equal output. Update the two tests' `ledger.json` references.
- [ ] **Step 7: `--watch` window** (`cli.ts:279`): read `[at, min(size, at + window(src, 4194304)))`; the rest follows on the next poll. Existing `--watch` tests pass.
- [ ] **Step 8: Measure.** `nice ./build.sh`; golden: `sh scripts/golden-usage.sh --ref /tmp/claude-1000/agentglass-ref --new ./agentglass --warm`. Expected: `0 differences`. Footprint warm (cache migrated by a first `--json` run of the new binary): Expected `first_frame_ms` ≤ 2000 (rows still eager until T7), `rss_mb_end` ≤ 680 (no parse tree, no save spike; was 810–830). `/usr/bin/time -v ./agentglass --json --limit 400` warm: ≤ 0.74 s, max RSS ≤ 174 MB.
- [ ] **Step 9:** `sh scripts/check.sh` PASS. Commit `perf(cache): stream the ledger cache one session per line; no save on the first tick`.

---

### Task 2: Ledger tick proportional to change, indexing pace, header gauge (wave 1)

**Files:** Modify `src/features/usage/ledger.ts:17,94-127`; Create `src/features/usage/progress.ts`, `src/features/usage/ledger.check.ts`; Modify `src/features/usage/stats.ts` (add `import "./progress.ts";` next to its other imports).

**Interfaces — Produces:**
- `export const PACE = { sliceMs: 50, tickMs: 250 };` — spec Decision 1 (a): ≤ 20 % of one core while indexing; the 4 MB `BUDGET` goes.
- `export function indexing(): boolean` — true iff some session that is not live has `pending`, or some session has more than 1,048,576 bytes pending.
- `export interface IndexState { done: number; total: number; left: number; bps: number /* EWMA bytes/s, 0 = unknown */ }`; `export function indexState(): IndexState`.
- `tick()` one pass: per session `a = ledger.get(path)`; `accOf(s)` only when missing, `s.size < a.off`, or `a.ep !== s.ep`; `applyAcc` only when `shown.get(path) !== a || shownOff.get(path) !== a.off` (two module maps; a restarted entry is a new object); `L.done/L.total` in the same pass; sidecar per session at most every 5 s unless `s.pid > 0` (`sideAt` map).
- Ingest accounting (spec Decision 2): `export const INGEST = { ms: 0, bytes: 0 }` — EWMA per wall second of `step()` time and bytes for sessions that are live and not `indexing()`; `ledger.ts` pushes `() => "ingest " + ms + "ms/s · " + kb + "KB/s"` onto `DEBUG_PARTS`.
- `progress.ts`: `H.headerWidgets.push((w) => …)` per spec 3; `H.helpSections` entry `["⟳ 34%", "history indexing: done, left, time left"]` under name `indexing`.

- [ ] **Step 1: Failing check** `ledger.check.ts` with fixture sessions (temp JSONL logs written by the check, Claude format lines copied from `src/harness/claude.check.ts` fixtures) registered into `sessions`: (a) after one `H.onTick` pass all fixtures are indexed (`L.done === L.total`); (b) a second tick with nothing changed calls `applyAcc` 0 times (count via a test hook `TICK_STATS.applied`); (c) appending one line to one log → exactly 1 applied, its tokens rise; (d) `indexing()` false when only a pid-linked session has < 1 MB pending, true when a non-live one has 1 byte pending; (e) a 3 MB log is fully indexed within ≤ ceil(3 MB / slice throughput) ticks with no byte cap (assert `L.done === L.total` after ≤ 20 ticks with `PACE.sliceMs = 1000` in the check).
- [ ] **Step 2: Run** `scriptc build src/features/usage/ledger.check.ts -o /tmp/claude-1000/tf-lc && /tmp/claude-1000/tf-lc`. Expected: FAIL (`TICK_STATS`, `indexState` missing).
- [ ] **Step 3: Measure the split first** (instrumented locally, not committed): per tick, time of the two O(n) passes vs `step()` ingest, 100 ticks warm on this host. Record in the PR (spec: ledger hook 10 ms/tick in all).
- [ ] **Step 4: Implement** `tick()`, `indexing()`, `indexState()` (EWMA of bytes booked per wall second over ticks that booked), `PACE`, `TICK_STATS` (exported counters, test-only use).
- [ ] **Step 5: Run** the check → `ledger: all checks passed`.
- [ ] **Step 6: Gauge.** `progress.ts` as specified; widths: ≥ 120 cols `⟳ indexing 34% · 8.0G left · ~3m`, ≥ 100 `⟳ 34% · 8.0G`, else `⟳ 34%`; ETA only after 10 s of samples and `bps > 0`. Add to the check: render strings for `IndexState` fixtures at w = 40/30/10 (pure function `gaugeText(st, w, now)`).
- [ ] **Step 7: Measure.** Golden `--cold --harness claude` → `0 differences`. Footprint `--cold --window 100`: the header shows `⟳ indexing` within 2 s (capture-pane), `cpu_self_pct` ≤ 22 during indexing; time until the gauge disappears on the full history ≈ 4 min (spec Decision 1). Warm footprint: tick EWMA in the debug footer ≤ 3 ms with agents streaming (was 14–20 ms; buildView is T5's); the footer shows `ingest …ms/s · …KB/s`; record it.
- [ ] **Step 8:** `sh scripts/check.sh` PASS. Commit `perf(ledger): tick works on changed sessions only, time-sliced indexing, header progress gauge`.

---

### Task 3: Linux process scan from /proc, incremental (wave 1)

**Files:** Create `src/platform/procfs.ts`, `src/platform/procfs.check.ts`; Modify `src/platform/linux.ts:12-26,56-58`, `src/platform/types.ts` (Platform gains `listTree`), `src/platform/darwin.ts`, `src/model/procs.ts:44-92,115-140`.

**Interfaces — Produces:**
- `procfs.ts` (pure parsers + a reader with an injectable root for checks):
  - `export interface Stat { pid: number; comm: string; ppid: number; ttyNr: number; ticks: number; start: number; rssPages: number }`
  - `export function parseStat(line: string): Stat | null` — comm between the first `(` and the **last** `)`.
  - `export function ttyName(nr: number): string` — major `(nr >> 8) & 0xfff`, minor `(nr & 0xff) | ((nr >> 12) & 0xfff00)`; 136–143 → `pts/` + (minor + (major − 136) × 256); 4 → minor < 64 ? `tty` + minor : `ttyS` + (minor − 64); 0 or other → `?`.
  - `export function cmdlineText(raw: Uint8Array, comm: string): string` — NUL → space, trailing space trimmed; empty → `[` + comm + `]`.
  - `export interface ProcFs { root: string; hz: number; page: number; btime: number }`; `export function scanProcs(fs: ProcFs, now: number, tracked: Set<number>, full: boolean): ProcRow[]` — incremental per spec 6 with module state (seen pids → cached row, start, cmdline); `full` re-reads all.
  - `export function childrenOf(fs: ProcFs, pid: number): number[]` — union over `/proc/<pid>/task/*/children`.
- `Platform.listTree(roots: number[]): ProcRow[]` (types.ts): Linux via `childrenOf` + `stat`; darwin `ps -o pid=,ppid=,pcpu=,rss=,etime=,tty=,args= -p <known pids>`.
- `linux.listProcs` = `scanProcs(real, Date.now(), tracked, now − lastFull ≥ 30000)`; `linux.cpuOf(pid, reported, now)` returns the CPU computed from the stat read in this scan (no second read).
- `procs.ts`: `refreshProcs()` passes the harness trees' pids as `tracked`; `linkSessions()` calls `applyMeta(s)` only when `pid`, `status` or `name` changed.

- [ ] **Step 1: Failing check** `procfs.check.ts`: fixture tree under `/tmp/agentglass-procfs-<pid>/` with `stat`, `cmdline`, `task/<pid>/children` files, `stat` btime file. Cases: comm `a b) (c` parses ppid right; `ttyName` for `34816` (136:0 → `pts/0`), `34817` (`pts/1`), `1025` (4:1 → `tty1`), `1088` (4:64 → `ttyS0`), `0` → `?`; empty cmdline → `[kthreadd]`; second `scanProcs` with no change reads no `cmdline` (counter `PROCFS_STATS.cmdline` unchanged); a pid younger than 10 s re-reads its cmdline; a tracked pid's ticks change → CPU % = Δticks / hz / Δs × 100; a pid removed from the fixture → gone; a pid reused (same number, other `start`) → its new cmdline; `childrenOf` returns the union of two tasks.
- [ ] **Step 2: Run** `scriptc build src/platform/procfs.check.ts -o /tmp/claude-1000/tf-pf && /tmp/claude-1000/tf-pf`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `procfs.ts`; wire `linux.ts`, `types.ts`, `darwin.ts`, `procs.ts`. Per Task 0 probe 2 (`RULING proc-children`): on a kernel without `children` files `childrenOf` returns `[]` and the 30 s full pass plus new pids' ppid find the kids (set a module flag shown in the debug footer as `nochildren`).
- [ ] **Step 4: Run** the check → `procfs: all checks passed`.
- [ ] **Step 5: Agreement on this host** (a temporary check program, not committed, or a `--self-test`-free probe): call `psProcs()` and `scanProcs(real, …, full = true)` back to back; for every pid in both: same `ppid`, same `tty`, same `args` (except processes whose cmdline changed in between), `rss` within 10 %. Expected: ≥ 99 % of pids agree; paste the counts in the PR.
- [ ] **Step 6: Measure.** Golden `--warm` → `0 differences` (`live`, `pid` are not compared; processes do not change numbers). Footprint warm with `AGENTGLASS_DEBUG_REFRESH=1`: procs EWMA ≤ 5 ms (was ~100 ms), no `procs slow`, `cpu_children_pct` ≤ 0.5 (was 5.0). Live count in the header equals `ps`-based main's on the same host (both side by side, one after the other).
- [ ] **Step 7:** `sh scripts/check.sh` PASS. Commit `perf(procs): read /proc incrementally on Linux instead of spawning ps`.

---

### Task 4: Git attribution incremental (wave 1)

**Files:** Modify `src/features/vcs/attrib.ts:205-299`, `src/features/vcs/view.ts:85-97`; Create `src/features/vcs/attrib-inc.check.ts`.

**Interfaces — Produces:**
- `allInfo()` keeps `ALL.ins` as a memo `Map<path, { key: string; si: SessIn }>`; key = `identVer + "|" + a.t0 + "|" + a.al + "|" + live + "|" + a.vcs.length`. Reflog stamps and `worktreeGitdirs` per gitdir/common re-read only when `now − readAt ≥ 5000`. `attributeWith` runs for the project keys whose member keys or reflog stamps changed; others keep their `GitInfo`. `ALL.gen` bumps when any project re-attributed.
- `export function fullRebuildForCheck(): Map<string, GitInfo>` — today's full path, for the equality check.
- `view.ts` preview section memo: `Map<path, { k: string; line: string }>`, k = `ALL.gen + "|" + cost + "|" + unk + "|" + s.subs.length + "|" + w`.

- [ ] **Step 1: Failing check** `attrib-inc.check.ts`: reuse `vcs.check.ts`'s fixture builders (repo dirs with reflogs, sessions with `vcs` refs). (a) `allInfo()` == `fullRebuildForCheck()` (deep compare commits/prs/issues/links/tallies) on the fixture; (b) append a reflog line → after 5 s (inject clock `GIT_CLOCK.now`) the new commit is attributed, and still equal to a full rebuild; (c) change one session's `a.al` → only its project re-attributes (counter `ATTR_STATS.projects` += 1); (d) nothing changed → 0 projects, 0 reflog reads.
- [ ] **Step 2: Run** `scriptc build src/features/vcs/attrib-inc.check.ts -o /tmp/claude-1000/tf-gi && /tmp/claude-1000/tf-gi`. Expected: FAIL.
- [ ] **Step 3: Implement** memo, per-gitdir read throttle, per-project re-attribution, `GIT_CLOCK` (defaults to `Date.now`), counters; the preview memo in `view.ts`.
- [ ] **Step 4: Run** the check and `vcs.check.ts` → both pass.
- [ ] **Step 5: Measure.** Golden `--warm` → `0 differences`; additionally `--json --subagents --git --limit 200 --fields id,git` of ref vs new on stable sessions equal (run by hand, `diff` of sorted jsonl). Footprint warm: render EWMA ≤ 10 ms (was 112 ms; T6 brings it lower), preview git line still shown.
- [ ] **Step 6:** `sh scripts/check.sh` PASS. Commit `perf(git): attribute only projects whose inputs changed; memoize the preview line`.

---

### Task 5: Session scan, list view and billing labels on change (wave 1)

**Files:** Modify `src/util/fs.ts` (add `listDirCached`), the directory walks in `src/harness/claude.ts:21-26`, `codex.ts:24`, `gemini.ts:186`, `pi.ts:44-65`, `kiro.ts:20`, `fx.ts:17` (scan functions only, `listDir` → `listDirCached`), `src/model/sessions.ts:14-52,170-203`, `src/features/usage/bill-live.ts:74,96-100`; Create `src/model/view.check.ts`; extend or create `src/util/fs.check.ts`.

**Interfaces — Produces:**
- `export function listDirCached(p: string): string[]` — reuses the last listing while `statSync(p).mtimeMs` is unchanged and older than 2 s (`FS_CLOCK.now`); a missing dir → `[]` and the entry is dropped. `export const FS_CLOCK = { now: (): number => Date.now() };`
- `sessions.ts`: `addFile` stats a known session only when `s.pid > 0 || now − s.mtime < 86400000 || rot(path) === scanNo % 20`; `applyMeta` only when fresh or `restat` changed size/mtime/epoch. `buildView()` returns early when `viewSig()` equals the last one and `S.view` is non-empty-or-empty consistently; `export function viewSig(): string` = `SG.gen` · Σ(mtime + pid × 7 + depth) · active-subagent count · expanded/collapsed sizes and a running hash of their keys · filter key (`H.listFilter` predicates' identity: a `filterKey()` string the filter feature already uses for its cache) · `L.ver` when a filter is active · `S.sel`'s session path.
- `bill-live.ts`: `label(s)` runs when `s.pid`, the entry's `bill/plan/billSrc` or `configGen()` changed since the last label (per-path memo).

- [ ] **Step 1: Failing checks.** `fs.check.ts`: a temp dir; list → add a file with the dir mtime moved → listed; with `FS_CLOCK` 3 s later and no change → cached (assert via `FS_STATS.lists` counter); a dir changed < 2 s ago → listed every time. `view.check.ts`: fixture sessions in `sessions`; `viewSig()` changes on each of: add session, `mtime`, `pid`, a subagent becoming active (mtime within 45 s), `expanded.add`, a list filter added; unchanged otherwise; `buildView()` twice with the same sig leaves `S.view` the same array object (`===`).
- [ ] **Step 2: Run** both checks. Expected: FAIL (symbols missing).
- [ ] **Step 3: Implement**; keep the harness scans' logic otherwise identical (only the listing call changes).
- [ ] **Step 4: Run** the checks and every `src/harness/*.check.ts` → pass.
- [ ] **Step 5: Measure.** Golden `--warm` → `0 differences`, and the stable-session **count** equal to ref's total session count minus live/changed ones (no session lost by the scan). Footprint warm debug footer: scan EWMA ≤ 5 ms (was 32 ms), tick EWMA drops by ≥ 6 ms (buildView) — record. New-session latency: start `touch` of a fake transcript is not possible in real agent dirs (never write there); instead the `fs.check.ts` case covers discovery; manual: a new real session started by the user later shows within one scan interval.
- [ ] **Step 6:** `sh scripts/check.sh` PASS. Commit `perf(scan): list directories only when they changed, stat recent logs, rebuild the view only on change`.

---

### Task 6: Frames only on visible change, row-wise flush (wave 1)

**Files:** Modify `src/main.ts:63-139` (render, job bodies), `src/ui/frame.ts`; Create `src/ui/frame.check.ts`.

**Interfaces — Produces:**
- `frame.ts`: `export function flushRows(rows: string[], out: (s: string) => void): number` — compares with the last frame's rows; writes `CSI <y+1>;1H` + row for each changed row (whole frame after `resetFrame()`/`S.repaint`/size change); returns rows written. `render()` builds rows (one string per screen row) instead of one joined frame; overlays/modal keep working (they `put` into the same row buffer — check `ui/screen.ts` `put` semantics first and keep the row model it already has).
- `main.ts`: procs job: `S.dirty = true` only when `headerSig()` (live, busy, cpu text, mem text) or — on the Processes tab — `procView` signature changed; tick: `if (L.ver !== v && visibleSig() !== lastVisible) S.dirty = true`, where `visibleSig()` = header widgets' strings + the visible rows' (path, size, cost, tokens) + preview session (path, size, evs length). Typing and alarms keep drawing at once (unchanged).

- [ ] **Step 1: Failing check** `frame.check.ts`: two frames differing in row 3 → `flushRows` returns 1 and the output contains `\x1b[4;1H`; identical → 0 and no output; after `resetFrame()` → all rows; a frame with another row count → all rows.
- [ ] **Step 2: Run** `scriptc build src/ui/frame.check.ts -o /tmp/claude-1000/tf-fr && /tmp/claude-1000/tf-fr`. Expected: FAIL.
- [ ] **Step 3: Implement**; check `src/sched.check.ts` still passes (no scheduling change).
- [ ] **Step 4: Run** the checks → pass.
- [ ] **Step 5: Manual UI pass** in tmux at 80/120/200 columns: Sessions, Processes, Stats, Repos tabs, help `?`, palette `Ctrl+K`, confirm modal, transcript, resize (rows reflow, no leftovers), focus-out/in (`ESC[O` / `ESC[I` via `tmux send-keys`). Expected: no stale cells. Screenshots (capture-pane text) in the PR.
- [ ] **Step 6: Measure.** Footprint warm (with T4 merged or rebased, note which): frames per second while agents stream ≤ 2 (count renders via the debug footer's render interval), render EWMA ≤ 3 ms, bytes written per frame (count `out` lengths in a local instrumented run) median ≤ 4 KB (was the whole frame, ~30 KB at 160×45).
- [ ] **Step 7:** `sh scripts/check.sh` PASS. Commit `perf(ui): draw only on visible change and write only changed rows`.

---

### Task 7: Call rows read lazily in every run (wave 2; needs T1, T2)

**Files:** Modify `src/features/usage/ledger.ts:19-38` (`callsOf`), `src/features/usage/cache.ts:20-35,53-59` (remove `lazyRows`, always the lazy branch), `src/features/usage/callcache.ts:44-53` (`refTable` via `peekHeavy`), `src/features/usage/record.ts:27` (`peekHeavy`), readers: `src/features/query/eval.ts:55-62,330-355`, `src/features/query/agg.ts:47`, `src/features/watchdog.ts:65-69`, `src/features/queries.ts:215-223`, `src/features/triage/cli.ts:154`, `src/features/compare/metrics.ts:101`, `src/features/compare/sections.ts:155`, `src/features/usage/stats.ts:55,397`; Test `src/features/usage/callcache.check.ts`, `src/features/query/*.check.ts`.

**Interfaces — Produces:**
- `export function callsOf(s: Sess): Call[]` (ledger.ts) — if `unread.has(s.path)`: `rowsOf(s)` (today's code) first; returns `ledger.get(s.path)?.calls ?? []`. Every reader above reads rows only through it (grep gate in Step 6).
- `export function peekHeavy(d: Day): Heavy` (record.ts) — `d.hx` if decoded, else `HEAVY.decode(d.hv)` without storing; `refTable` uses it.

- [ ] **Step 1: Failing checks.** In `callcache.check.ts`: after `loadCallsFrom` of a fixture with two days, both days still have `hx === null` (not pinned) and the rows equal the encoded ones. In a query check: a fixture ledger whose rows are only on disk (`unread` set) → `eachCall` over `status is error` returns the same rows as with rows in memory; sessions outside the day window are not read (`unread` still has them).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**; every reader switches from `accOf(s).calls` / `ledger.get(…).calls` / `a.calls` to `callsOf(s)` (the ledger's own `record.ts` writes keep using `a.calls`).
- [ ] **Step 4: Run** the checks → pass.
- [ ] **Step 5: Measure.** Golden `--warm` and `--cold --harness claude` → `0 differences` (incl. the three filter sets). Footprint warm: `first_frame_ms` ≤ 1000, `rss_mb_end` ≤ 220 (spec experiment: 173 with T1). With a call filter pinned (`AGENTGLASS_CONFIG` scratch config `{"filter":{"pinned":"tool is Bash"}}` — check the filter-language config shape in `src/features/query/ui.ts` first): record `rss_mb_end` (expected ≈ 390 until T8).
- [ ] **Step 6: Gate**: `grep -rn '\.calls\b' src --include='*.ts' | grep -v check | grep -v 'usage/\(record\|callcache\|cache\|codec\|ledger\)\.ts'` → only non-row uses (`r.calls` counters in repos, codex `calls` set). Paste the output in the PR.
- [ ] **Step 7:** `sh scripts/check.sh` PASS. Commit `perf(rows): read call rows lazily in every run, decode day keys without pinning them`.

---

### Task 8: Columnar call rows (wave 3; needs T7)

**Files:** Create `src/features/usage/rows.ts`, `src/features/usage/rows.check.ts`; Modify `src/features/usage/facts.ts:7` (`Call` stays only as the encoder's/fixtures' value type or is removed), `record.ts:28-54,75-79,184-237` (`Acc.rows`, `tool`, `pend`, `retool`, `file`), `calls.ts:17,80-95` (`Pend.ri`, `done`), `callcache.ts:94-184` (encode/decode/prune on columns), `codec.ts:114-117` (`rows: newRows()`), `cache.ts`, `ledger.ts` (`callsOf` → `rowsOfSess(s): Rows`), readers from T7 plus `src/features/rules/metrics.ts:35,67`, `src/features/triage/run.ts:129-139`.

**Interfaces — Produces:**
- `rows.ts`: `export interface Rows { n: number; t: number[]; tool: number[]; model: number[]; mq: number[]; ms: number[]; err: number[]; out: number[]; lo: number[]; li: number[]; cid: string[] }`; `newRows()`; `push(r, t, tool, model, mq): number` (index; also pushes `lo[n] = li.length`); `addId(r, i, kind, id)` (only `i === r.n − 1`; dedupe within the row); `rowIds(r, i, kind): number[]`; `compact(r, keep: (i) => boolean): number[]` (old→new, −1 dropped); `KIND_PROG = 0, KIND_CMD = 1, KIND_FILE = 2`.
- Reader signature: `eachCall(f, days, fn: (s: Sess, r: Rows, i: number) => void)`; same for `callsIn`, rule metrics, triage `keep` predicates.
- Task 0 probe 1 (`RULING typed-arrays`) decides: `yes` → the numeric columns are `Float64Array`s behind the same interface; `no` → `number[]`.

- [ ] **Step 1: Re-run** `src/util/footprint-probes.check.ts` and follow its `RULING typed-arrays` line; quote it in the PR.
- [ ] **Step 2: Failing check** `rows.check.ts`: push 3 rows, `addId` cmd/file to the newest, `rowIds` per kind; `addId` on an older row is ignored; `compact` dropping row 0 returns `[-1, 0, 1]` and keeps `lo/li` consistent; 300k rows → `selfRssMb()` growth ≤ 45 MB.
- [ ] **Step 3: Run** `scriptc build src/features/usage/rows.check.ts -o /tmp/claude-1000/tf-rw && /tmp/claude-1000/tf-rw`. Expected: FAIL.
- [ ] **Step 4: Implement** `rows.ts`, then the ledger side (record, calls, callcache decode straight into columns, prune via `compact` + remap of `a.pend` (`p.ri`) and `a.lastCall`), then readers (mechanical: `c.x` → `r.x[i]`, `c.cmds` → `rowIds(r, i, KIND_CMD)`).
- [ ] **Step 5: Run** every check (`sh scripts/check.sh`) — the existing callcache/query/triage/compare/rules checks are the equality tests; plus `rows.check.ts`.
- [ ] **Step 6: Measure.** Golden `--warm` and `--cold --harness claude` → `0 differences`. Footprint warm with the pinned call filter of T7 Step 5: `rss_mb_end` ≤ 260 (was ≈ 390). Cold full `/usr/bin/time -v ./agentglass --json --subagents` (empty scratch cache): max RSS ≤ 500 MB (was 875), wall not slower than ref by more than 10 %.
- [ ] **Step 7:** Commit `perf(rows): store call rows in columns`.

---

### Task 9: Verification and results (needs all)

**Files:** Create `specs/tui-footprint/results.md`; Modify `README.md` (one short "Footprint" paragraph with the measured numbers, where performance is described today — find it with `grep -n -i 'memory\|cpu' README.md`), `CHANGELOG.md` (unreleased entry).

- [ ] **Step 1:** `nice ./build.sh`; golden `--cold` (full, all harnesses) → `0 differences`.
- [ ] **Step 2:** Footprint warm and cold with the final binary and the ref, same host, one after the other. Table in `results.md`: first frame warm/cold, RSS 5 s/30 s/end, CPU self/children/total, debug-footer job EWMAs, cold full-index peak RSS and wall, warm `--json --limit 400` and `cost` time + RSS.
- [ ] **Step 3: Targets** (spec Goal): each row met / not met with the number; CPU as spec Decision 2 counts it (total − ingest from the footer ≤ 1 %, total ≤ 2 %). Not met → a `Ruling:` line with the measured cause; do not loosen a target silently.
- [ ] **Step 4: Manual pass** (spec Testing, last bullet) incl. an alarm: the watchdog still raises ◆ "turn finished" within the adaptive-refresh bound for a live session (observe a real session of the user's finishing a turn; never prompt it).
- [ ] **Step 5:** `sh scripts/check.sh` PASS. Commit `docs(perf): tui-footprint results`.
