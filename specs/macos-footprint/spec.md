# macOS footprint — spec

Status: **implemented** (2026-10-06, PR #68; [results](results.md)). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4). Builds on
[tui-footprint](../tui-footprint/spec.md) (released in 2026.10.5, [results](../tui-footprint/results.md)).

## Goal
The CPU gains of 2026.10.5 on macOS too. The process scan and the open-file lookup stop spawning `ps` and `lsof`. They
read the kernel through `libproc`/`sysctl` instead, via scriptc's native FFI and a small C file. The scan is
incremental, as on Linux.

| | macOS today (measured / derived, see "Today") | target (macos-14 runner, fixture below) |
|---|---|---|
| TUI CPU, unfocused (`--away`), self + children | ≥ ~2.4 % for `ps` alone, every 1.5 s, also unfocused; whole TUI measured in Task 0 | **≤ 2 %** in all |
| TUI CPU, focused | ≥ ~2.6 % for `ps` + `lsof` alone; whole TUI measured in Task 0 | **~3.5 %** accepted (as on Linux, tui-footprint Decision 2) |
| CPU of child processes (`ps`, `lsof`) | ~1.6 % of one core (21 ms per `ps` per 1.5 s + 9 ms per `lsof` per 5 s) | ≤ 0.2 % (only `tmux`, `git`, `stty` remain) |
| procs job per pass | ~21 ms child + parse ≈ 25–30 ms | ≤ 2 ms (median, debug footer) |
| First frame, RSS | Task 0 numbers | unchanged (±10 %) |
| Process tree, links, liveness | `ps` path | identical to the `ps` path on fixtures (parity check, Testing) |

## Why (user value)
- Most agentglass users run it on a Mac laptop. On battery, 2–3 % of a core for a dashboard in a background tab is a
  drain for nothing. 2026.10.5 fixed this on Linux only.
- An unfocused TUI on macOS cannot get under 2 % today. `ps` lists every process every 1.5 s, even when only the
  agents' CPU is wanted (`darwin.ts:12` ignores `tracked` and `discover`).
- `lsof` is a separate tool that a locked-down Mac may restrict. One fewer dependency.

## Today (measured, not guessed)
Measured on a GitHub `macos-14` runner (Apple M1 virtual, 3 cores, macOS 14.8.9, 398 processes) with a throwaway
probe (run 37419548621, C + shell, described in the appendix). The host has no Mac, so only probe numbers exist. The
whole-TUI baseline is Task 0's first job.

| what | per run | cadence | share of one core |
|---|---|---|---|
| `ps -axo pid=,ppid=,pcpu=,rss=,etime=,tty=,args=` (`src/platform/posix.ts:10`), 404 lines, 45.6 KB | 24.7 ms wall, **21.0 ms CPU** in the child | procs job: 1.5 s; unfocused too (`darwin.ts:12` lists all on every pass, `discover` is ignored) | 1.4 % child |
| parsing that output (`parsePs`, a regex per line, `posix.ts:12-18`) | ~5 ms (derived: 30 ms for 2,300 lines on Linux, spec of tui-footprint "Today") | 1.5 s | ~0.3 % self |
| `ps -o … -p <12 pids>` | 5.0 ms wall, 3.0 ms CPU | — | (option, Decision 1) |
| `ps -axo pid=,ppid=,comm=` | 22.3 ms wall, 18.7 ms CPU | — | (option: the start-up of `ps` dominates, not the columns) |
| `lsof -a -p <12 pids> -Fpfn` (`posix.ts:20-35`, slow job `procs.ts:178`) | 13.0 ms wall, **9.0 ms CPU** | slow job, 5 s | 0.18 % child |
| spawn of `/usr/bin/true` (fork + exec floor) | 2.8 ms wall, 1.4 ms CPU | — | — |
| `stty size` (size job, `src/term.ts:11`) | 1.8 ms wall, 1.2 ms CPU | 2 s focused, seldom unfocused | 0.06 % |
| `proc_listallpids` | **0.004 ms** | — | — |
| full pass: `PROC_PIDTBSDINFO` + `proc_pid_rusage` + `KERN_PROCARGS2` for all 398 pids | **3.9 ms** CPU | (a 30 s full pass) | 0.013 % |
| tracked pass: info + rusage of 40 own pids | **0.047 ms** | 1.5 s | ~0 |
| cwd + open files of one process (`PROC_PIDVNODEPATHINFO`, `PROC_PIDLISTFDS` + `PROC_PIDFDVNODEPATHINFO`) | 0.003 ms | — | — |

A developer Mac runs 500–900 processes, against 398 on the runner. The `ps` cost grows with the process count. The
runner's 1.4 % is therefore a lower bound for what users pay.

Facts the probe established:
- `proc_pid_rusage` and `PROC_PIDTASKINFO` report CPU time in **mach absolute-time units** on arm64 (timebase 125/3):
  a busy child read 23.26 M units/s raw, which is 96.9 % after scaling by numer/denom. Intel's timebase is 1/1. The
  scaling is required.
- `PROC_PIDTBSDINFO`, `proc_pid_rusage` and `KERN_PROCARGS2` fail for the 188 processes of other users (root, system
  daemons) and succeed for all 209 own ones. Identity data for every uid needs `sysctl(KERN_PROC_PID)`, the source `ps`
  uses itself.
- The longest command line on the runner is 5,948 bytes in `KERN_PROCARGS2` form (with the environment) and 220
  characters in `ps -ww`. Piped `ps` output is not cut at 80 columns (max line 260).
- A process with no controlling terminal has `e_tdev = -1`, which `ps` prints as `??`. `devname()` gives `ttys003`
  for a tty, the same name `ps` prints.
- The runner has no `tmux`; Homebrew 6.0.20 is installed.

scriptc 0.1.7 FFI (verified on this Linux host, `~/.cache/agentglass-agents/spec-macos/ffi`):
- `scriptc build --ffi <manifest.json>` binds a TypeScript `declare function` to a C symbol. The params are `f64`,
  `bool`, `u8`, `u32`, `i32`, `string` and `bytes`; the returns are scalar only. `bytes` becomes
  `(const uint8_t *, size_t)`. Writes into it reach the `Uint8Array` (verified: `getcwd` into a 256-byte buffer).
- `libraries` in the manifest may name a `.c` file. The clang link driver compiles it, on the LLVM and the C backend
  (verified: `ag_fill` from `shim.c`). An `.o` works the same way.
- A build **without** `--ffi` compiles. A call to the unbound function throws `ReferenceError: <name> is not defined`,
  and `try/catch` catches it (verified). One source tree therefore builds on every OS. Without the manifest the
  adapter falls back to `ps`.

Code today:
- `src/platform/darwin.ts:12` `listProcs` → `psProcs()`, whatever `tracked`/`discover` say; `cpuOf` returns `ps`'s
  decaying `%cpu` (`:13`); `procFiles` → `lsofFiles` (`:15`); `procOwner` spawns `ps -o uid=` (`:25`).
- `src/platform/procfs.ts:88-160` holds the incremental algorithm (wait set, young exec chains, pid reuse by start
  time, the 500 ms CPU guard, full pass) together with the `/proc` reads. `knownProcs` (`:163-175`) is the
  no-discovery pass.
- `src/model/procs.ts:86-138` `refreshProcs(discover)`: `tracked` = agents every pass, children every other pass
  (`:109`). `main.ts:144`: unfocused, `discover` only every other pass.
- `src/util/selfmem.ts:6-11`: the debug footer's `rss` is Linux-only (`/proc/self/status`).
- Focus: `src/term.ts:26` enables `?1004h`; `src/main.ts:189-195` `onFocus`; `src/sched.ts:57` "only focus-out makes
  away, never inactivity alone".

## Design

### 1. Measurement on macOS (tooling, first)
- `scripts/footprint.sh` gains Darwin support. On Darwin the following parts change; the rest stays as on Linux:
  - `ms()`: `perl -MTime::HiRes=time -e 'printf "%d", time * 1000'` (BSD `date` has no `%N`).
  - `rss()`: `ps -o rss= -p $pid` / 1024.
  - CPU, self: `ps -o time= -p $pid`. Self plus waited-for children: `ps -S -o time= -p $pid` (BSD `-S` sums exited
    children into the parent). Both are converted from `[[dd-]hh:]mm:ss.cc` to seconds.
  - `alive()`: `kill -0`.
  - A new `--home <dir>` option sets `HOME` in the pane's command (fixture HOME).
  - The `Linux only` guard becomes `Linux or Darwin`.
- `scripts/fake-agent.c` (one small C program) is started through symlinks named `claude`, `codex` and `node`, so
  `harnessOfArgs` (`procs.ts:35`) classifies them. Options:
  - `--children n`: n children that sleep;
  - `--grandchild`: one child runs `sh -c 'sleep 3600'`, an exec chain;
  - `--open <file>`: keeps a file open (Codex `liveFile`);
  - `--append <file> --every <s>`: appends a fixture line every s seconds (streaming);
  - `--busy <pct>`: one child burns pct % of a core in 10 ms slices.
  It exits on SIGTERM and kills its children. It is POSIX C (`fork`, `nanosleep`, `open`) and builds on both OSes.
- `scripts/fixture-agents.sh start <dir> [--agents 12] [--history 300] [--background 300]` and `stop <dir>`:
  - It writes a fixture HOME with the transcript shapes of `scripts/agent-mode.test.sh` (Claude, Codex, Gemini) and
    `--history` older sessions.
  - It starts the agents: 4 `claude` (registry `~/.claude/sessions/<pid>.json`), 4 `codex` (rollout held open) and 4
    `node …/gemini.js` (link by cwd). Each has 2 children and a grandchild, streams a line every 2 s, and one in four
    runs `--busy 5`.
  - It starts `--background` plain `sleep` processes, so a 400-process runner has a desktop-like ~700.
  - It writes the pids to `<dir>/pids`. `stop` kills exactly those pids.
- `.github/workflows/footprint-macos.yml`:
  - Triggers: `workflow_dispatch` with the inputs `before` (default `main`), `after` (default: the dispatched ref) and
    `window` (default 60); and `pull_request` limited to the paths of the four tooling files, so the tooling tests
    itself.
  - **One** `macos-14` runner, `timeout-minutes: 30`, `concurrency: footprint-macos`, no cancel.
  - Steps:
    1. the scriptc action (lane `footprint`);
    2. `HOMEBREW_NO_AUTO_UPDATE=1 brew install tmux`;
    3. builds `before` and `after` through `AGENTGLASS_SRC` worktrees;
    4. `fixture-agents.sh start`;
    5. a warm cache per binary (`--json` once);
    6. `footprint.sh` runs: before/after × focused/`--away`, interleaved, warm-up 20 s, window 60 s;
    7. the table goes to `$GITHUB_STEP_SUMMARY`, and the job also uploads it as an artifact.
  - Budget: two builds ~6 min (cached: ~2), four runs ~6 min, setup ~1 min, about 13 min in all. It never runs on
    ordinary PRs.

### 2. Native process source: C file + FFI manifest
- `src/platform/darwin/libproc.c` (≤ 200 lines, `-Wall -Wextra` clean) and `src/platform/darwin/ffi.json`
  (`ffi_format` 1, `libraries: ["libproc.c"]`). The C file uses only the macOS SDK: `libproc.h`, `sys/sysctl.h`,
  `mach/mach_time.h`. The mach timebase is read once into a static.
- Functions. Each returns the number of bytes written, `0` = the pid is gone, `-1` = cannot be read, or `-n` = the
  buffer is too small, n bytes needed (the caller grows the buffer to n and calls once more):

  | TS binding (`declare function`) | C symbol | params → returns | what it writes |
  |---|---|---|---|
  | `agPids(buf)` | `ag_pids` | `bytes` → `i32` | `proc_listallpids`: the pids as int32 little-endian; returns the count; count × 4 ≥ length = grow ×2 and retry |
  | `agStat(pid, buf)` | `ag_stat` | `i32, bytes` → `i32` | one line `ppid uid zombie startMs cpuMs rss tty\tcomm`: `sysctl(KERN_PROC_PID)` for ppid, uid, `p_stat == SZOMB`, `p_starttime` (ms), `e_tdev` (→ `devname` or `??`), `p_comm`; `proc_pid_rusage(RUSAGE_INFO_V2)` for `(ri_user_time + ri_system_time) × numer / denom / 1e6` ms and `ri_resident_size` bytes, `-1 0` when rusage is refused (another user's process) |
  | `agArgs(pid, buf)` | `ag_args` | `i32, bytes` → `i32` | `KERN_PROCARGS2`: skips `argc` and the exec path, joins the `argc` arguments with spaces and turns control bytes into spaces; **stops after argv** (the environment that follows is never copied); `-1` when refused |
  | `agCwd(pid, buf)` | `ag_cwd` | `i32, bytes` → `i32` | `PROC_PIDVNODEPATHINFO` → `pvi_cdir.vip_path` |
  | `agFiles(pid, buf)` | `ag_files` | `i32, bytes` → `i32` | `PROC_PIDLISTFDS` + `PROC_PIDFDVNODEPATHINFO` for vnode fds: paths separated by NUL |

- `src/platform/libproc.ts` holds the declarations, the pure parsers (`parseAgStat(text, pid)`, `nulSplit`) and
  `nativeProcs()`. `nativeProcs()` is true when `process.platform === "darwin"`, `AGENTGLASS_PROCS` is not `ps`, and
  the first `agPids` call neither throws (no `--ffi` in the build) nor returns < 1. The answer is decided once per
  process.
- Buffers: one 64 KB buffer reused for `agStat`/`agArgs`/`agCwd` (16 KB arguments first; `-n` grows it once up to
  256 KB); `agPids` 16 KB, grown as needed; `agFiles` 64 KB, grown on `-n`.

### 3. One incremental scanner for both OSes
- The algorithm moves from `procfs.ts:88-175` into `src/platform/procscan.ts`, unchanged in behaviour. It covers the
  wait set, young exec chains (`EXECS`, `YOUNG_MS`), pid reuse by start time, `RSS_EVERY`, the 500 ms CPU guard,
  `knownProcs` and `etimeText`.
- The scanner is written against a source:
  ```ts
  export interface PStat { pid: number; comm: string; zombie: boolean; ppid: number; tty: string; cpuMs: number; startMs: number; rss: number }
  export interface ProcSource {
    id: string;                         // "procfs:<root>" | "libproc": state resets when it changes
    pids(): number[];                   // every pid now
    comm(pid: number): string;          // the cheapest name read, "" = gone
    stat(pid: number): PStat | null;    // null = gone; cpuMs -1 = unknown (cpu 0); rss -1 = read via rss()
    rss(pid: number, st: PStat): number;
    args(pid: number, st: PStat): string;
    bootMs(now: number): number;        // procfs: now − uptime; libproc: 0 (startMs is already epoch ms)
  }
  ```
- `procfs.ts` keeps its parsers (`parseStat`, `ttyName`, `cmdlineText`, `btimeOf`, `procfsUsable`) and builds a
  `ProcSource` from them. Its `scanProcs`/`knownProcs` become thin calls with the same signatures. `procfs.check.ts`
  passes unchanged, including the `PROCFS_STATS` read counts.
- The libproc source maps `agStat` → `PStat` and `agArgs` → args. A refused args read becomes `(comm)`, as BSD `ps`
  prints it; a zombie becomes `(comm)` too.

### 4. Darwin adapter
- `darwin.listProcs(tracked, wantArgs, discover)`: with `nativeProcs()` it calls `scanProcs`/`knownProcs` of the
  libproc source, with a full pass every 30 s as on Linux. Otherwise it calls `psProcs()` as today.
- `cpuOf` → `reported`. Native: the delta from the scanner; `ps`: `ps`'s own `%cpu`, as today.
- `procFiles(pids, fdPids, want)`: native → `agCwd` for each pid, `agFiles` only for `fdPids`, filtered by `want`.
  Otherwise `lsofFiles`.
- `procOwner(pid)`: native → the uid field of `agStat`. Otherwise `ps -o uid=`.
- `selfRssMb()` (`selfmem.ts`): on Darwin with native support, the rss of `agStat(own pid)`. The debug footer gains
  `rss` on macOS.
- Debug footer: `procs ps` is appended when the scan runs on the `ps` fallback. A user who reports high CPU then shows
  it in a screenshot.
- `AGENTGLASS_PROCS=ps` forces the `ps` path, on Linux too (`linux.ts:18`: `useProc = 0`). It serves the parity
  check and a user whose kernel reads misbehave. It is documented in the README next to `AGENTGLASS_DEBUG_REFRESH`.

### 5. Build
- `build.sh`: on `uname -s` = Darwin, when `${AGENTGLASS_SRC:-src}/platform/darwin/ffi.json` exists, it adds
  `--ffi <that file>`. An old tree without the file builds as before, which golden runs against old refs need.
  Release builds (`build-artifacts.yml`) go through `build.sh` and get it with no workflow change.
- `scripts/check.sh`: `CHECK_FFI` is set on Darwin the same way and is added to the `bin` and `release` builds and to
  every check carrying a `// check: ffi` line. On Darwin those checks are built with `--backend c` added. That covers
  the darwin-x64 release path (C backend + FFI + `libproc.c`) on every PR at the cost of one small program build;
  CI's `cbackend` job runs on Linux and cannot compile `libproc.c`.
- Toolchain: none new. `toolchain.sh` already requires clang, and Xcode's command-line tools ship the SDK headers.

### 6. Other macOS costs: evaluated
- `lsof` → native (4). Saves ~0.18 % and one external tool.
- `stty size` (both OSes, 1.2 ms per 2 s focused = 0.06 %, seldom unfocused): unchanged (Decision 9).
- `tmux list-panes` (every 30 s or on a new tty) and `git` (attribution, reflog stamps at most every 5 s since
  tui-footprint): same on both OSes, already change-driven. Unchanged.
- Focus reporting: iTerm2, Ghostty, WezTerm, kitty and Alacritty send `?1004` reports; tmux forwards them with
  `focus-events on` (the help already says so, `main.ts:218`). Terminal.app is not confirmed (V3). A terminal that
  sends no reports keeps the TUI "focused" (~3.5 % expected after this spec). No inactivity heuristic (Decision 10).

### 7. Expected result
The procs job drops to ≤ 2 ms per pass: the listing 0.004 ms, tracked pids 0.05 ms, the work done in JS, and a 4 ms
full pass every 30 s. Children drop from ~1.6 % to ≤ 0.2 %. The macOS TUI then has the same job profile as Linux after
2026.10.5: unfocused ~1.7 %, focused ~3.5–4 % on Linux, and Task 4 checks these against the macOS targets.

## Failure modes
- **Build without `--ffi`** (someone runs `scriptc build src/main.ts` by hand): the `ReferenceError` is caught once and
  the adapter falls back to `ps`, as today. The footer shows `procs ps`.
- **Pid gone between listing and read**: `agStat` returns 0 and the pid is skipped this pass (as `/proc`).
- **Pid reused**: another `startMs` → a new entry (shared scanner).
- **Another user's process**: identity comes from `KERN_PROC_PID` for every uid. CPU reads 0 (`cpuMs -1`) and args
  read `(comm)`. Agents are the user's own processes. An agent started with `sudo` shows as a root process with
  `(comm)` args, as `ps` shows it to a non-root user.
- **Argument area larger than 256 KB**: truncated at 256 KB; classification uses the first tokens.
- **A new macOS changes a libproc struct**: the C file is compiled against the SDK of the build machine, so it cannot
  drift silently. A runtime read that fails returns -1 and the row falls back the same way as an unreadable process.
  The parity check runs on every PR's macOS shard.
- **arm64 vs Intel time units**: scaled in C by the mach timebase; checked by the busy-child check (Testing).

## Privacy
Nothing new is read or stored. `KERN_PROCARGS2` returns the environment after argv; `ag_args` stops at argv and never
copies it. `envOf` on macOS stays empty (`darwin.ts:27`). Open files are read only for `fdPids` (harnesses with
`liveFile`), as with `lsof -p`. The fixture HOME and fake agents in CI use synthetic data only.

## Interactions with other specs
- **tui-footprint** (released): its `/proc` scanner is refactored into `procscan.ts` with no change in behaviour;
  `procfs.check.ts` is the guard. Its `footprint.sh` gains Darwin support; Linux output stays byte-identical in
  format.
- **adaptive-refresh** (released): `discover` and the unfocused cadence are reused as they are.
- **model-prices**, **release-management**: none. No cached data changes; `VERSION` stays.

## Testing
- `src/platform/procscan.check.ts` (both OSes): the scanner against a fake `ProcSource` (maps in memory):
  - new pid with a name that is not wanted → read on the second pass;
  - a launcher re-read while young;
  - pid reuse;
  - tracked CPU % = ΔcpuMs / Δwall × 100;
  - the 500 ms guard;
  - `knownProcs` reads only tracked pids;
  - a full pass re-reads all;
  - per-source state reset.
- `src/platform/procfs.check.ts`: unchanged, it must pass (Linux behaviour guard).
- `src/platform/libproc.check.ts` (`// check: ffi`):
  - pure, both OSes: `parseAgStat` (comm with spaces after the tab, `??` tty, `-1` cpu, zombie), `nulSplit`;
  - native, Darwin only (skipped with a printed `native: skipped (not darwin)` line elsewhere):
    - own pid → ppid = `process.ppid`, args contain the check's path;
    - a spawned `sh -c 'while :; do :; done'` reads 70–130 % over 1 s (time units);
    - `agCwd(self)` = `process.cwd()` realpath;
    - a file opened by the check appears in `agFiles(self)`;
    - pid 1 → uid 0 with args `(launchd)` or readable;
    - a pid that just exited → 0.
- `src/platform/procs-parity.check.ts` (`// check: ffi`, both OSes): spawns a known tree (`sh -c 'sleep 30 & exec
  sleep 31'`), then calls `psProcs()` and the native/procfs full scan back to back:
  - every own pid in both: same ppid, tty and args, start within 1 s, rss within 25 %;
  - pid-set overlap ≥ 98 %;
  - the spawned tree is complete in both.
  On Linux this compares `/proc` with `ps`, on Darwin libproc with `ps`.
- `scripts/procs-parity.test.sh` (both OSes, shared `AGENTGLASS_BIN`): runs `fixture-agents.sh start` with 3 agents
  (one per link method) and 0 background processes. It runs `agentglass --json --fields id,harness,live,pid,status
  --format csv` with `AGENTGLASS_PROCS=ps` and without; the outputs must be equal, with 3 live rows. Then it stops
  the fixture.
- Footprint: `footprint-macos.yml` before/after (Task 4), recorded in `specs/macos-footprint/results.md`.
- Manual (V3, someone with a Mac): Terminal.app and iTerm2 focus-out → `lvl away` in the debug footer.

## Out of scope
- `stty size` → `ioctl(TIOCGWINSZ)` (0.06 %, both OSes; Decision 9).
- `ps`-fallback tuning (`-p <tracked>`; Decision 5).
- Other BSDs (they keep the `ps` + `lsof` adapter); Windows.
- Reading the environment of processes on macOS (`envOf`).

## Decisions
Each: question · options · decision · why · cost if wrong.

1. **How macOS reads processes.**
   - Options:
     - (a) libproc/sysctl through scriptc FFI and a C file;
     - (b) cheaper `ps`: `ps -o … -p <tracked>` every pass (3 ms CPU) plus a full `ps -axo` for discovery every
       N s;
     - (c) a long-lived helper process that streams process events;
     - (d) as is.
   - **Decision: (a).**
   - Why:
     - (b) still spawns: 3 ms + 21 ms / N. Discovery at the 1.5 s focused cadence is still 1.4 % in children, and
       unfocused with N = 3 s ~0.9 %, too much for the ≤ 2 % budget together with the rest of the TUI. A new
       agent would show only after N s.
     - (c) needs a second binary to build, sign and ship, plus an IPC channel (scriptc has no Unix sockets) and its
       own wake-ups.
     - (a) is measured: 0.05 ms for a tracked pass, 3.9 ms for a full pass, no child. It gives Linux and macOS the
       same scanner and the same behaviour.
   - Cost if wrong: a C file in the tree (≤ 200 lines) and a build flag on Darwin. If the FFI misbehaves, the
     fallback is today's `ps` path.
2. **C file or direct libc bindings.**
   - Options: (a) a small C file; (b) bind `proc_listallpids`, `proc_pidinfo` and `sysctl` directly in the manifest.
   - **Decision: (a).**
   - Why: (b) cannot express these calls:
     - `bytes` expands to `(ptr, size_t)`, but `sysctl` needs `namelen` as a count of ints;
     - `proc_pidinfo`'s `uint64_t arg` has no FFI class;
     - the arm64 time scaling and the `KERN_PROCARGS2` parsing are C-shaped work.
     The clang driver compiles the `.c` file at link time (verified), so there is no extra build step.
   - Cost if wrong: none for users; a reviewer reads ~200 lines of C.
3. **Record format across the FFI.**
   - Options: (a) one text line per call; (b) a fixed binary struct.
   - **Decision: (a).**
   - Why: only new, tracked or full-pass pids are read (dozens per pass). Text keeps fixtures readable and the
     parsers testable on Linux. It needs no float/`DataView` decoding in scriptc.
   - Cost if wrong: ~1 µs of parsing per pid; a full pass of 700 pids costs ~1 ms more every 30 s.
4. **Share the incremental scanner with Linux.**
   - Options: (a) extract `procscan.ts` and use it from both adapters; (b) copy the algorithm into a darwin module.
   - **Decision: (a).**
   - Why: the subtle parts (wait set, exec chains, pid reuse, CPU guard) were tuned in #59 and #63. One copy keeps
     both OSes fixed together. `procfs.check.ts` guards Linux.
   - Cost if wrong: a Linux regression in the refactor. The unchanged `procfs.check.ts`, the Linux parity check and
     the golden run catch it before merge.
5. **Tune the `ps` fallback too.**
   - Options: (a) leave it as it is; (b) add a `-p <tracked>` pass when not discovering.
   - **Decision: (a).**
   - Why: the fallback only runs in a hand-made build without `--ffi` or with `AGENTGLASS_PROCS=ps`. `build.sh`, every
     release and CI use the native path. (b) adds merge logic that only that corner would exercise.
   - Cost if wrong: a hand-built binary costs what 2026.10.5 costs on macOS today.
6. **Replace `lsof` as well.**
   - Options: (a) yes, `agCwd`/`agFiles`; (b) keep `lsof`.
   - **Decision: (a).**
   - Why: it comes nearly free once the C file exists (2 functions). It removes 9 ms of child CPU every 5 s and one
     external tool. Codex's and fx's live-file links stay the same (parity test).
   - Cost if wrong: a vnode path differs in form from `lsof`'s (e.g. `/private/var` vs `/var`), so a Codex rollout
     does not link. The parity test compares the links, and `realpath` normalization is the fix.
7. **An env switch `AGENTGLASS_PROCS=ps`.**
   - Options: (a) yes, documented, on both OSes; (b) test-only, undocumented; (c) none.
   - **Decision: (a).**
   - Why: the parity check needs both paths in one binary, and a user whose kernel reads misbehave gets a way out
     without a rebuild. It matches the existing `AGENTGLASS_*` debug switches.
   - Cost if wrong: one README line and one env read.
8. **Measurement on CI.**
   - Options:
     - (a) a `workflow_dispatch` workflow on one macos-14 runner, plus the tooling's own PR paths;
     - (b) a footprint step in every PR's macOS shards;
     - (c) a nightly schedule.
   - **Decision: (a)**, plus the parity check inside the existing macOS shards.
   - Why: macOS runners are scarce (5 per account, CI already uses 3 per PR). A 13-minute measurement per PR would
     queue every other PR. CPU footprint changes are rare and deliberate; correctness (parity) is what each PR needs.
   - Cost if wrong: a CPU regression on macOS shows only when someone dispatches the workflow. Each perf PR's plan
     names the dispatch as a step.
9. **`stty size` spawn.**
   - Options: (a) keep it; (b) `ioctl(TIOCGWINSZ)` in the C file on macOS.
   - **Decision: (a).**
   - Why: measured 1.2 ms CPU per 2 s focused (0.06 %) and seldom unfocused. It is identical on Linux, which has no C
     file, so changing only macOS would split the size logic for noise.
   - Cost if wrong: 0.06 % focused on macOS.
10. **Terminals without focus reports (Terminal.app, if V3 confirms).**
    - Options: (a) nothing: the TUI stays "focused"; (b) treat N minutes without input as away.
    - **Decision: (a).**
    - Why: `sched.ts:57` deliberately never infers away from inactivity: a user watching agents without typing is
      the main use. After this spec the focused cost on macOS is ~3.5 %, the accepted figure.
    - Cost if wrong: Terminal.app users pay ~1.5 % more than the away state.
11. **Identity source for every pid.**
    - Options: (a) `sysctl(KERN_PROC_PID)`; (b) `PROC_PIDTBSDINFO`.
    - **Decision: (a).**
    - Why: measured, (b) fails for the 188 processes of other users. `ps` lists those, and parity needs the same
      tree (ppid chains through root-owned launchers).
    - Cost if wrong: about 1 µs more per pid read.
12. **C backend coverage for darwin-x64.**
    - Options:
      - (a) build the `// check: ffi` checks with `--backend c` on the macOS shards;
      - (b) a full `--backend c` agentglass build on a macOS shard;
      - (c) trust the release job.
    - **Decision: (a).**
    - Why: it exercises C backend + FFI + `libproc.c` on every PR for the price of one small program. (b) adds
      minutes to a scarce runner. (c) found the `Record<string, RegExp>` break only at release time (2026.10.3).
    - Cost if wrong: an agentglass-only C-backend construct is still caught by the existing Linux `cbackend` job.

## Open questions (technical verification during implementation)
- **V1** `ps -S -o time=` includes waited-for children on macOS 14. Task 0 checks it with a 1 s busy child. Fallback:
  measure the total as the difference of two `/usr/bin/time -l` runs (warm-up only vs warm-up + window) and keep `ps
  -o time=` for self.
- **V2** For processes whose arguments `ps` cannot read, `ps` prints `(comm)`. The parity check confirms it.
  Otherwise the libproc source copies what `ps` prints.
- **V3** Terminal.app focus reporting (`?1004`). It cannot be tested on CI. Someone with a Mac checks it with the
  debug footer (`lvl away` after switching tabs). The result goes into the README's terminal notes and does not
  change the design (Decision 10).
- **V4** `brew install tmux` time on macos-14 (budget 1 min). Fallback: run the TUI under BSD `script -q` with `stty
  rows 45 cols 160` and detect the first frame in its output file.

## Appendix: the probe (run 37419548621, macos-14)
<details><summary>probe.c and probe.sh</summary>

The probe's C file timed `proc_listallpids` × 100; a full pass (`PROC_PIDTBSDINFO`, `proc_pid_rusage(V2)`,
`KERN_PROCARGS2`) × 5 over all pids, counting failures; a tracked pass over 40 own pids × 100; a busy child read twice
1 s apart (rusage and taskinfo, raw and timebase-scaled); its own cwd and vnode fds × 100; its own `e_tdev`/`devname`,
start time, comm and name.

The shell part started 12 `sleep` copies named `claude` and timed each command over n runs with `/usr/bin/time -p`:
- `ps -axo pid=,ppid=,pcpu=,rss=,etime=,tty=,args=` (30 runs);
- `ps -o … -p <12 pids>` (30);
- `ps -axo pid=,ppid=,comm=` (30);
- `lsof -a -p <12 pids> -Fpfn` (10);
- `/usr/bin/true` (100);
- `stty size` (50).
It also recorded the output size and the longest line of `ps` with and without `-ww`.

Raw output: see "Today". The source was on the deleted branch `probe/macos-footprint`; Task 0 makes the measurement
permanent as `footprint-macos.yml`.
</details>
