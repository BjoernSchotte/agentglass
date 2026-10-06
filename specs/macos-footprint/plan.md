# macOS Footprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS, an unfocused TUI uses ≤ 2 % of one core in all (self + children) and a focused one ~3.5 %. Child-process CPU drops from ~1.6 % to ≤ 0.2 %. First frame and RSS stay unchanged, and the process tree and session links match the `ps` path.

**Architecture:** A small C file (`src/platform/darwin/libproc.c`) is bound through scriptc's `--ffi` manifest and wraps `proc_listallpids`, `sysctl(KERN_PROC_PID / KERN_PROCARGS2)`, `proc_pid_rusage` and the vnode-path calls. The incremental scanner of `procfs.ts` moves into a source-agnostic `procscan.ts`, which a procfs source (Linux) and a libproc source (macOS) feed. `darwin.ts` uses it, with `ps`/`lsof` as the fallback when the build has no FFI or `AGENTGLASS_PROCS=ps` is set. A `workflow_dispatch` job on one macos-14 runner measures before/after with fake agents.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), `--ffi` on Darwin only; C (macOS SDK) for the C file; POSIX sh scripts; GitHub Actions `macos-14`.

**Spec:** [spec.md](spec.md). Read it first, including "Today" (probe numbers), "Decisions" and the open questions V1–V4, which have fixed fallbacks.

**Round:** 2 (after 2026.10.4). Builds on tui-footprint (released 2026.10.5). Nothing else has to merge first.

## Task graph (parallelism)

| wave | tasks | runs | needs merged |
|---|---|---|---|
| 1 | T0 tooling + baseline · T1 C file + FFI binding + build · T2 scanner extraction | **in parallel**, one implementer and one worktree each (disjoint files, table below) | — |
| 2 | T3 darwin adapter + parity | alone | T0 (fixture script), T1, T2 |
| 3 | T4 measurement + results | alone | T3 |

| task | owns (only this task edits them) |
|---|---|
| T0 | `scripts/footprint.sh`, `scripts/fake-agent.c` (new), `scripts/fixture-agents.sh` (new), `scripts/fixture-agents.test.sh` (new), `.github/workflows/footprint-macos.yml` (new), `specs/macos-footprint/results.md` (new, "before" section) |
| T1 | `src/platform/darwin/libproc.c` (new), `src/platform/darwin/ffi.json` (new), `src/platform/libproc.ts` (new), `src/platform/libproc.check.ts` (new), `build.sh`, `scripts/check.sh` |
| T2 | `src/platform/procscan.ts` (new), `src/platform/procscan.check.ts` (new), `src/platform/procfs.ts` |
| T3 | `src/platform/darwin.ts`, `src/platform/linux.ts`, `src/util/selfmem.ts`, `src/main.ts` (debug footer part only), `src/platform/procs-parity.check.ts` (new), `scripts/procs-parity.test.sh` (new), `README.md` |
| T4 | `specs/macos-footprint/results.md`, `specs/ROADMAP.md` (status) |

## Global Constraints

- Build with `./build.sh`; run the tests with `sh scripts/check.sh`. A task is done only when both pass on Linux and
  the PR's CI is green on both OSes (the macOS shards run the native code).
- Build output, scriptc caches and test binaries go under `~/.cache/agentglass-agents/<task>/` (`/tmp` is a shared
  RAM tmpfs). Set `SCRIPTC_CACHE_DIR=~/.cache/agentglass-agents/<task>/scache`. Single check:
  `scriptc build <f> -o ~/.cache/agentglass-agents/<task>/c && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme ~/.cache/agentglass-agents/<task>/c`.
- scriptc 0.1.7:
  - nominal typing: pass fields, not foreign interfaces;
  - no `Record<string, RegExp>` (C backend);
  - an element read used as an index needs `+ 0` (SC1090);
  - out-of-range array reads trap;
  - a zero-parameter arrow for an optional interface member is rejected (SC2003);
  - no Unix sockets;
  - strings kept beyond the pass go through `own()`.
  FFI: `bytes` is `(const uint8_t *, size_t)` and writable in practice; returns are scalar (`i32`); an unbound
  `declare function` throws `ReferenceError` only when called. Never call one outside the guarded `nativeProcs()`
  path.
- **No host may be tested on the user's processes beyond reading them.** Fake agents only. Never kill by pattern:
  `fixture-agents.sh stop` kills the pids it wrote.
- Measurements on the shared Linux host: one build at a time, `nice -n 10`, every `AGENTGLASS_*` path in a scratch dir,
  `AGENTGLASS_AGENT=0` in tmux, never touch `~/.agentglass`. macOS numbers come only from the `footprint-macos`
  workflow (one runner; never more than one dispatch at a time).
- `VERSION` does not change. Output contracts (`--json`, `cost`, `--watch`) do not change.
- Keys, help, footer: no new key. The debug footer gains `rss` on macOS and `procs ps` on the fallback path.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Worktree
  `../agentglass-mf-<task>`, branch `perf/mf-<task>` (e.g. `perf/mf-t1-libproc`) from `origin/main` once the
  task's dependencies are merged. One PR per task; rebase-merge after green CI.

## Review Focus

1. **Linux unchanged** (T2): `procfs.check.ts` passes with no edit other than imports; `PROCFS_STATS` counts are
   identical; the Linux parity check passes.
2. **C file** (T1): no buffer overrun (every write is bounded by `n`); `KERN_PROCARGS2` parsing stops at argv (no
   environment copied); arm64 time scaling; `-n` grow protocol; `-Wall -Wextra` clean.
3. **Fallback** (T1/T3): a build without `--ffi` behaves exactly as 2026.10.5 on macOS (no crash, `procs ps` in the
   footer); `AGENTGLASS_PROCS=ps` forces it on both OSes.
4. **Parity** (T3): same live sessions, pids and statuses as the `ps` path; Codex's open rollout links (vnode path
   vs `lsof` path).
5. **Runner budget** (T0): the footprint workflow uses one macOS runner, ≤ 30 min, and does not trigger on
   ordinary PRs.

---

### Task 0: macOS measurement tooling and baseline (wave 1)

**Files:** Modify `scripts/footprint.sh`; Create `scripts/fake-agent.c`, `scripts/fixture-agents.sh`,
`scripts/fixture-agents.test.sh`, `.github/workflows/footprint-macos.yml`, `specs/macos-footprint/results.md`.

**Interfaces — Produces:**
- `footprint.sh`: gains `--home <dir>`, and the same output lines on Darwin (spec 1).
- `fake-agent.c`: `fake-agent [--children n] [--grandchild] [--open file] [--append file --every s] [--line text]
  [--busy pct]`. It sleeps until SIGTERM, then kills its children and exits 0.
- `fixture-agents.sh start <dir> [--agents n] [--history n] [--background n]` creates `<dir>/home` and starts the
  agents; it prints `agents <n> pids <m>` and writes `<dir>/pids`. `fixture-agents.sh stop <dir>` kills those pids
  and waits up to 5 s. `n` agents are split round-robin over claude / codex / gemini (n = 3 → one each).
  `--background 0` is allowed.

- [ ] **Step 1: Failing test** `scripts/fixture-agents.test.sh`, both OSes, no agentglass. Steps:
  1. `start "$t" --agents 3 --history 5 --background 2`;
  2. assert `ps -o args= -p <pid>` ends in `claude …` / `codex …` / `node …/gemini.js …` for the three agent pids;
  3. assert `<home>/.claude/sessions/<claude pid>.json` names the Claude fixture session;
  4. assert the Codex rollout is open: Linux `ls -l /proc/<pid>/fd`, macOS `lsof -p <pid>`;
  5. assert each agent has ≥ 2 children (`ps -axo pid=,ppid=`);
  6. assert a streamed file grew after 3 s;
  7. `stop`, then assert every pid is gone.
  Expected last line: `fixture agents: all checks passed`.
- [ ] **Step 2: Run** `sh scripts/fixture-agents.test.sh`. Expected: FAIL (`fixture-agents.sh: not found`).
- [ ] **Step 3: Implement** `fake-agent.c` (POSIX C: `fork`, `execl("/bin/sh", …)` for `--grandchild`,
  `nanosleep`, `open` with `O_APPEND`, a SIGTERM handler that `kill`s its children) and `fixture-agents.sh`:
  - It builds `fake-agent` with `cc -O2 -Wall -Wextra -Werror` into `<dir>/bin`. The symlinks there are `claude` and
    `codex` → `fake-agent`, and `node` → `fake-agent`; the Gemini "script" is `<dir>/bin/gemini/gemini.js`, an empty
    file.
  - The transcript shapes are the `cu`/`ca`, Codex `session_meta` and Gemini chat lines of
    `scripts/agent-mode.test.sh:13-30`, one project dir per agent (`<home>/w/p<i>` with `.git`).
  - Each agent is started from its project dir with `--children 2 --grandchild --append <its transcript> --every 2`,
    plus `--line` with a valid assistant line for its harness. Codex agents add `--open <rollout>`; every fourth agent
    adds `--busy 5`.
  - The Claude registry is written after the start (it needs the pid):
    `{"pid":…, "sessionId":…, "status":"busy", "name":"fixture <i>"}`.
  - `--history n` writes n Claude sessions dated 2–30 days back; `--background n` starts `sleep 3600` n times.
  - Portable sh only (`sh-portability.test.sh` must pass).
- [ ] **Step 4: Run** `sh scripts/fixture-agents.test.sh`. Expected: `fixture agents: all checks passed`.
- [ ] **Step 5: footprint.sh on Darwin** (spec 1).
  - Branch on `uname -s`: `ms`, `rss`, CPU via `ps -o time=` (self) and `ps -S -o time=` (self + waited children),
    `alive` via `kill -0`. Add `--home`.
  - The Linux output must stay identical: run `sh scripts/footprint.sh --bin ./agentglass --cold --warmup 5
    --window 10 --scratch ~/.cache/agentglass-agents/mf-t0/fp` on this host (niced, isolated) before and after the
    edit. Expected: the same 7 line names in the same order.
  - **V1:** in the workflow (step 6), first run `sh -c 'perl -e "1 while 1" & p=$!; sleep 1; kill $p; wait $p; ps -S
    -o time= -p $$'` and assert ≥ 0.8 s. If it fails, implement the spec V1 fallback: two `/usr/bin/time -l` runs and
    the difference. Note the outcome in `results.md`.
- [ ] **Step 6: Workflow** `.github/workflows/footprint-macos.yml` (spec 1):
  - `on: workflow_dispatch` (inputs `before`, `after`, `window`) and `pull_request: paths: [the four tooling files and
    the workflow]`; `runs-on: macos-14`, `timeout-minutes: 30`, `concurrency: { group: footprint-macos,
    cancel-in-progress: false }`; uses `./.github/actions/scriptc` with lane `footprint`.
  - Steps:
    1. time `HOMEBREW_NO_AUTO_UPDATE=1 brew install tmux` (V4: if > 60 s, note it and keep going; the `script -q`
       fallback is only needed if brew fails);
    2. `git worktree add` both refs and build each through `AGENTGLASS_SRC=<wt>/src AGENTGLASS_OUT=$RUNNER_TEMP/<name>
       sh build.sh`;
    3. `fixture-agents.sh start $RUNNER_TEMP/fx --agents 12 --history 300 --background 300`;
    4. a warm cache per binary (`HOME=… AGENTGLASS_CACHE_DIR=$RUNNER_TEMP/cache-<name> <bin> --json > /dev/null`);
    5. `footprint.sh --home … --warm … --warmup 20 --window $window --debug`, in the order before-focused,
       after-focused, before-away, after-away;
    6. `stop`;
    7. write a markdown table (rows = metrics, columns = the 4 runs) plus `ps -ax | wc -l` and the debug footer
       lines to `$GITHUB_STEP_SUMMARY`, and upload it as artifact `footprint-macos`.
  - Expected wall ≤ 15 min.
- [ ] **Step 7: Baseline.** In the PR, the `pull_request` trigger runs it with before = after = `main`. Paste the
  table into `results.md` under "Before (main @ <sha>)", together with the debug-footer job costs (`procs`, `slow`).
  These are the real macOS "today" numbers the spec could only derive.
- [ ] **Step 8:** `sh scripts/check.sh` PASS. Commit `test(perf): macOS footprint workflow, fake agents and fixture
  HOME`.

---

### Task 1: C file, FFI manifest, bindings, build flags (wave 1)

**Files:** Create `src/platform/darwin/libproc.c`, `src/platform/darwin/ffi.json`, `src/platform/libproc.ts`,
`src/platform/libproc.check.ts`; Modify `build.sh`, `scripts/check.sh`.

**Interfaces — Produces** (`libproc.ts`):
```ts
declare function agPids(buf: Uint8Array): number;
declare function agStat(pid: number, buf: Uint8Array): number;
declare function agArgs(pid: number, buf: Uint8Array): number;
declare function agCwd(pid: number, buf: Uint8Array): number;
declare function agFiles(pid: number, buf: Uint8Array): number;
export interface AgStat { ppid: number; uid: number; zombie: boolean; startMs: number; cpuMs: number; rss: number; tty: string; comm: string }
export function parseAgStat(text: string): AgStat | null;      // "ppid uid zombie(0|1) startMs cpuMs rss tty\tcomm"; cpuMs -1 = refused
export function nulSplit(b: Uint8Array, n: number): string[];  // NUL-separated paths, empty parts dropped
export function nativeProcs(): boolean;                         // darwin && AGENTGLASS_PROCS !== "ps" && agPids works (decided once)
export function lpPids(): number[];                             // grows its buffer as needed
export function lpStat(pid: number): AgStat | null;             // null = gone or unreadable
export function lpArgs(pid: number, comm: string): string;      // "(comm)" when refused
export function lpCwd(pid: number): string;                     // "" when unknown
export function lpFiles(pid: number): string[];
export const LP_STATS = { pids: 0, stat: 0, args: 0 };          // calls, for checks
```
C (`ffi.json`, `ffi_format` 1, `libraries: ["libproc.c"]`, no `system_libraries`): `ag_pids(uint8_t*, size_t)`,
`ag_stat(int, uint8_t*, size_t)`, `ag_args(int, uint8_t*, size_t)`, `ag_cwd(int, uint8_t*, size_t)`,
`ag_files(int, uint8_t*, size_t)`, all returning `int` (spec 2 table). In the manifest, params are `["bytes"]` or
`["i32", "bytes"]` and returns are `"i32"`.

- [ ] **Step 1: Failing check** `libproc.check.ts`, first line `// check: ffi`.
  - Pure part, runs everywhere:
    - `parseAgStat("1 501 0 1791265126127 1234 933888 ttys003\tnode MainThread x")` → ppid 1, uid 501,
      `comm = "node MainThread x"`, tty `ttys003`;
    - `"… -1 0 ??\tlaunchd"` → cpuMs -1;
    - zombie 1;
    - malformed (5 fields, no tab, non-numeric) → null;
    - `nulSplit` of `a\0b\0\0` → `[a, b]`.
  - Native part, only `if (nativeProcs())`; elsewhere print `native: skipped (not darwin or no ffi)`:
    - `lpStat(process.pid)` has ppid `process.ppid` and `startMs` within 60 s of now;
    - `lpArgs(process.pid, "")` contains the check binary's basename;
    - busy-child CPU: `spawn("sh", ["-c", "while :; do :; done"])`, `lpStat` twice 1 s apart, Δ`cpuMs` / Δwall
      within 70–130 %, then kill it;
    - `lpCwd(process.pid)` = `realpathSync(process.cwd())`;
    - `openSync` a temp file → `lpFiles(process.pid)` includes its realpath;
    - `lpStat(1)` → uid 0, and `lpArgs(1, "launchd")` is `(launchd)` or starts with `/sbin/launchd`;
    - a spawned `true` waited for → `lpStat(<its pid>)` null;
    - `lpPids()` contains `process.pid` and has ≥ 50 entries.
  Expected last line: `libproc: all checks passed`.
- [ ] **Step 2: Run** on Linux: `scriptc build src/platform/libproc.check.ts -o ~/.cache/agentglass-agents/mf-t1/c &&
  ~/.cache/agentglass-agents/mf-t1/c`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `libproc.c` (spec 2).
  - Every write is bounded by `n`; text is written with `snprintf`. If the line does not fit, return `-(needed)`.
  - `ag_args`: read `KERN_PROCARGS2` into a local buffer of `min(kern.argmax, 1 MB)` (malloc, freed), read `argc`,
    skip the exec path and its NUL padding, and copy `argc` NUL-terminated strings joined by `' '`, with bytes < 32
    or = 127 turned into `' '`. Stop at `argc` strings or the buffer end. A result larger than `n` is cut at `n`
    (no error).
  - The timebase is read once (`static mach_timebase_info_data_t`).
  - `ag_files` uses a `proc_fdinfo` array sized from a first `PROC_PIDLISTFDS` call with a NULL buffer.
  - Then `libproc.ts`, with buffers per spec 2 (one shared 64 KB `Uint8Array`) and text decoded with
    `TextDecoder("utf-8")` over `subarray(0, n)`. `nativeProcs()` wraps the first `agPids` call in `try/catch`.
- [ ] **Step 4: Build flags.**
  - `build.sh`: `ffi=""; [ "$(uname -s)" = Darwin ] && [ -f "${AGENTGLASS_SRC:-src}/platform/darwin/ffi.json" ] &&
    ffi="--ffi ${AGENTGLASS_SRC:-src}/platform/darwin/ffi.json"`, passed to `scriptc build`.
  - `scripts/check.sh`: compute `CHECK_FFI` the same way after `toolchain.sh`, export it, and add it to the `bin` and
    `release` builds. A check with `// check: ffi` gets `$CHECK_FFI`, plus `--backend c` on Darwin (spec 5,
    Decision 12).
  - The comment header of `check.sh` documents the marker.
- [ ] **Step 5: Run** the check on Linux → `native: skipped …` and `libproc: all checks passed`. `sh
  scripts/check.sh` PASS. Push; the macOS shards must print `libproc: all checks passed` **without** the skip line
  (check the shard log). When `CHECK_FFI` is set, `check.sh` also runs `cc -fsyntax-only -Wall -Wextra -Werror
  src/platform/darwin/libproc.c` once as its own job; a warning fails the shard.
- [ ] **Step 6:** Commit `feat(platform): libproc bindings for macOS via scriptc FFI`.

---

### Task 2: Source-agnostic incremental scanner (wave 1)

**Files:** Create `src/platform/procscan.ts`, `src/platform/procscan.check.ts`; Modify `src/platform/procfs.ts`.

**Interfaces — Produces** (`procscan.ts`; spec 3 has the `PStat` and `ProcSource` declarations):
- `export function scanSource(src: ProcSource, now: number, tracked: Set<number>, full: boolean, want: (comm: string) => boolean): ProcRow[]`
- `export function knownSource(src: ProcSource, now: number, tracked: Set<number>): ProcRow[]`
- `export const YOUNG_MS`, `export function etimeText(sec: number): string`, `export const SCAN_STATS = { comm: 0, stat: 0, args: 0, rss: 0 }`.
- `procfs.ts` keeps its exported names and signatures: `scanProcs(fs, now, tracked, full, want)` →
  `scanSource(procfsSource(fs), …)`, `knownProcs`, `PROCFS_STATS` (aliased to the reads its source makes),
  `etimeText` re-exported. `procfsSource(fs)` is cached per `fs.root`.

- [ ] **Step 1: Failing check** `procscan.check.ts`. A fake source holds maps in memory (pid → PStat, args, comm) and
  counts reads. Cases (spec Testing):
  - an unwanted new name is read on the second pass only;
  - a young `sh` is re-read and its args change after an exec;
  - pid reuse (new `startMs`) gives new args;
  - tracked CPU: cpuMs +300 over 1,000 ms → 30 %;
  - a second pass 200 ms later keeps the CPU (guard);
  - `knownSource` reads only tracked pids and drops a gone one;
  - `full` re-reads every pid's stat;
  - a changed `src.id` resets the state;
  - `rss -1` → `rss()` every `RSS_EVERY` passes for tracked pids;
  - `etimeText(90061)` = `1-01:01:01`.
  Expected: `procscan: all checks passed`.
- [ ] **Step 2: Run** `scriptc build src/platform/procscan.check.ts -o ~/.cache/agentglass-agents/mf-t2/c &&
  ~/.cache/agentglass-agents/mf-t2/c`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - Move the algorithm of `procfs.ts:88-175` into `scanSource`/`knownSource` line for line. Replace the `/proc` reads
    with `src.*`, and replace ticks with `cpuMs` (procfs: `ticks * 1000 / hz`).
  - `startMs` is `src.bootMs(now) + start` for procfs; the procfs source computes it inside `stat()`, so the scanner
    sees epoch ms only. The tty string is compared instead of `ttyNr`, and `own()` is called only on a change.
  - `procfsSource(fs)` wraps `readComm`, `readStat` (→ `PStat` with `zombie = state === "Z"`), `readRss` and
    `readArgs`.
- [ ] **Step 4: Linux guard.**
  - `src/platform/procfs.check.ts` must pass **unchanged**, except for import lines if a moved symbol needs it. Run
    it. Expected: `procfs: all checks passed`.
  - A temporary probe, not committed: `scanProcs` on the real `/proc` of this host before (on `main`) and after
    (this branch) gives the same pid count ±2% and the same args for the pids present in both (`nice`, one run each).
- [ ] **Step 5:** `sh scripts/check.sh` PASS. Commit `refactor(platform): one incremental process scanner for any
  source`.

---

### Task 3: Darwin adapter on libproc, fallback switch, parity (wave 2: after T0, T1, T2)

**Files:** Modify `src/platform/darwin.ts`, `src/platform/linux.ts:17-22`, `src/util/selfmem.ts`, `src/main.ts`
(debug-footer part via `DEBUG_PARTS`, no job change), `README.md` (env line near `AGENTGLASS_DEBUG_REFRESH`,
`README.md:142`); Create `src/platform/procs-parity.check.ts`, `scripts/procs-parity.test.sh`.

**Interfaces — Consumes:** `scanSource`/`knownSource` (T2), `lp*` (T1), `fixture-agents.sh` (T0).
**Produces:**
- `libprocSource()` in `darwin.ts`: `id: "libproc"`; `pids: lpPids`; `comm: (pid) => { const s = lpStat(pid); return s ? s.comm : ""; }`; `stat` → `PStat` (`cpuMs` -1 → the scanner reports 0); `rss` → the stat's rss; `args: lpArgs(pid, st.comm)` (`(comm)` for a zombie); `bootMs: () => 0`.
- `darwin.listProcs` / `procFiles` / `procOwner` per spec 4; `export const PROCS_PATH = { ps: false }` set when the `ps` path is taken, read by a `DEBUG_PARTS` entry (`procs ps`).
- `linux.ts`: `process.env.AGENTGLASS_PROCS === "ps"` → `useProc = 0`.
- `selfmem.ts`: `selfRssMb()` returns `lpStat(process.pid).rss` in MB on Darwin with `nativeProcs()`.

- [ ] **Step 1: Failing parity check** `procs-parity.check.ts` (`// check: ffi`; spec Testing). On Linux it compares
  `scanProcs(full)` with `psProcs()`, on Darwin `libprocSource` with `psProcs()`. Expected:
  `procs parity: all checks passed (<n> pids compared)`. It runs on Linux now and FAILs on Darwin (darwin adapter not
  wired). Run the Linux half locally and expect a pass; the Darwin half is proven by the CI shard after Step 3.
- [ ] **Step 2: Failing test** `scripts/procs-parity.test.sh` (uses `AGENTGLASS_BIN`):
  1. `fixture-agents.sh start "$t" --agents 3 --history 2 --background 0`;
  2. wait until the Claude registry exists;
  3. `a=$(HOME=$t/home AGENTGLASS_AGENT=0 … AGENTGLASS_PROCS=ps "$AGENTGLASS_BIN" --json --fields
     id,harness,live,pid,status --format csv | sort)` and `b=…` without `AGENTGLASS_PROCS`, with every
     `AGENTGLASS_*` path in `$t`;
  4. assert `a = b` and `grep -c ',true,' = 3` (the three link methods: registry, open file, cwd);
  5. `stop`.
  Expected: `procs parity cli: all checks passed`. On macOS before Step 3 both runs take the `ps` path, so
  `a = b` passes trivially. The CSV equality is the regression guard; the check in Step 1 proves the native path.
- [ ] **Step 3: Implement** spec 4: `darwin.ts`, `linux.ts`, `selfmem.ts`, the `procs ps` debug part, and the README
  line: "`AGENTGLASS_PROCS=ps` reads processes with `ps`/`lsof` instead of the kernel interfaces (diagnostics)".
  `procFiles` realpaths each path from `agFiles`/`agCwd`, so they match what `lsof` printed (`/private/var/…`):
  Decision 6's fix applied up front.
- [ ] **Step 4: Run** both on Linux. Expected: `procs parity: all checks passed`, `procs parity cli: all checks
  passed`. Push. On the macOS shards both must pass and the check must print no skip line. Paste `<n> pids compared`
  from both OSes into the PR.
- [ ] **Step 5: Golden on this host** (Linux, the T2 refactor is live now): `sh scripts/golden-usage.sh --warm --ref
  <main bin> --new ./agentglass` → `0 differences`. Processes do not change numbers; this guards the Linux scan path
  end to end.
- [ ] **Step 6:** `sh scripts/check.sh` PASS. Commit `perf(darwin): read processes and open files through libproc
  instead of ps and lsof`.

---

### Task 4: macOS measurement and results (wave 3)

**Files:** Modify `specs/macos-footprint/results.md`, `specs/ROADMAP.md` (status of this spec).

- [ ] **Step 1:** Dispatch: `gh workflow run footprint-macos.yml -f before=<main before T3, e.g. the T2 merge> -f
  after=main -f window=60`. Wait with `gh run watch`. Only one dispatch at a time.
- [ ] **Step 2:** Copy the summary table into `results.md` ("After"). Mark each spec Goal row met / not met:
  - away total ≤ 2 %;
  - focused ~3.5 % (≤ 4.2 %, the Linux range);
  - children ≤ 0.2 %;
  - procs ≤ 2 ms;
  - first frame and RSS within ±10 % of before.
  A row not met gets a `Ruling:` line with the measured cause (debug footer job costs). Never loosen a target
  silently.
- [ ] **Step 3:** If a target is missed and the footer shows a job other than procs/slow as the cause, record it as
  a follow-up in `results.md`; it is not in this plan's scope. If procs or slow is the cause, fix it in a new task
  with a check first.
- [ ] **Step 4:** V3 (Terminal.app focus): ask the lead to have someone with a Mac check it. Record the answer, or
  "not verified", in `results.md`; it changes nothing in the code (Decision 10).
- [ ] **Step 5:** ROADMAP status `implemented`. Commit `docs(perf): macos-footprint results`.
