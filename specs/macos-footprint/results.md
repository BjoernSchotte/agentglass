# macOS footprint — results

Status: measured 2026-10-06 on GitHub `macos-14` runners (Apple M1 virtual, 3 cores) with `footprint-macos.yml`, PR
#68 (`feat/macos-footprint`). Spec: [spec.md](spec.md), plan: [plan.md](plan.md) Task 4.

## Method
- One runner per run. `fixture-agents.sh start --agents 12 --history 300 --background 300`: 12 fake agents (4 each
  `claude`, `codex`, `node …/gemini.js`), each with 2 children and an `sh → sleep` chain, streaming a line every 2 s,
  every fourth burning 5 % of a core; 300 old Claude sessions; 300 background `sleep`s. The runner went from 409–468
  processes to 776–831.
- Both binaries are release builds through `build.sh` (after: with `--ffi`). Each gets a warm cache (`--json` once).
- `footprint.sh --home <fixture> --warm … --warmup 20 --window 60 --debug [--away]`, interleaved before-focused,
  after-focused, before-away, after-away. CPU is self plus the exited children it waited for, from
  `proc_pid_rusage` (`scripts/proc-cpu.c`; see V1), in % of one core over the window.
- Run A: PR trigger, run 37423997836, before `main` @ 4e76de8, after e93026f.
  Run B: `workflow_dispatch`, run 37425062501, before `main` @ d1cdc99, after e010153 (same code as A's after plus a
  workflow fix).

## Before (main)
| metric | A focused | A away | B focused | B away |
|---|---|---|---|---|
| first frame (ms) | 286 | 275 | 411 | 241 |
| RSS end (MB) | 16 | 16 | 15 | 15 |
| CPU self (%) | 2.79 | 1.45 | 2.07 | 1.27 |
| CPU children (%) | 3.91 | 3.33 | 3.60 | 3.13 |
| **CPU total (%)** | **6.70** | **4.78** | **5.67** | **4.40** |
| debug footer: procs / slow | 54 ms / 22 ms | 69 ms / 17 ms | 55 ms / 25 ms | 54 ms / 17 ms |

These are the real macOS "today" numbers the spec could only derive: `ps` and `lsof` cost 3.1–3.9 % of a core in
children alone (the spec's estimate, 1.6 %, was for 398 processes; here ~800), and an unfocused TUI was at 4.4–4.8 %.

## After (libproc)
| metric | A focused | A away | B focused | B away |
|---|---|---|---|---|
| first frame (ms) | 144 | 251 | 228 | 130 |
| RSS end (MB) | 16 | 17 | 16 | 17 |
| CPU self (%) | 3.53 | 1.22 | 3.21 | 1.11 |
| CPU children (%) | 0.12 | 0.07 | 0.12 | 0.05 |
| **CPU total (%)** | **3.66** | **1.29** | **3.33** | **1.16** |
| debug footer: procs / slow | 2.7 ms / 9 ms | 4.8 ms / 1.9 ms | 3.1 ms / 4.4 ms | 4.3 ms / 3.1 ms |

## Goals
| goal | target | measured (A, B) | |
|---|---|---|---|
| CPU unfocused, self + children | ≤ 2 % | 1.29 %, 1.16 % (from 4.78 %, 4.40 %) | met |
| CPU focused | ~3.5 % (≤ 4.2 %) | 3.66 %, 3.33 % (from 6.70 %, 5.67 %) | met |
| CPU of children | ≤ 0.2 % | 0.05–0.12 % (from 3.1–3.9 %) | met |
| procs job per pass | ≤ 2 ms | 2.7–4.8 ms (from 54–69 ms) | not met |
| first frame | ±10 % | 130–251 ms (from 241–411 ms) | met (faster) |
| RSS | ±10 % | 16–17 MB (from 15–16 MB) | not met by the letter: +1–2 MB |
| tree, links, liveness | = ps path | parity check on every macOS CI shard (220–264 own pids compared, all equal), CLI parity test (3 live sessions, one per link method) | met |

Ruling: the procs job misses ≤ 2 ms. The kernel reads are not the cause: listing and reading the tracked pids take
~0.05 ms (spec "Today"). The job also runs the model work shared with Linux on every pass (`applyRows` over every row,
the process-tree walk, registries, linking), which grows with the process count: Linux pays 13 ms per pass for 2,300
processes (tui-footprint results), macOS here 3–5 ms for ~800. The 2 ms target counted only the reads. The job's cost
is inside the CPU totals above, which meet their targets; a follow-up could make the model pass incremental for both
OSes. Cost if wrong: ~0.1–0.2 % of a core.

Ruling: RSS ends 1–2 MB higher on a 15 MB process (integer MB, so ±1 is resolution). The incremental scanner keeps a
row per pid between passes (~800 here), as on Linux since 2026.10.5; the `ps` path rebuilt them per pass. On a real
history (~175 MB, README) this is ~1 %. Cost if wrong: ~2 MB.

## Open verifications
- **V1** `ps -S -o time=` does not count waited-for children on macOS 14: after a 1 s busy child it read `0:00.00`
  (runs 37423253579, 37423997836). Instead of the spec's fallback (two `/usr/bin/time -l` runs and their difference),
  `footprint.sh` reads `ri_child_user_time + ri_child_system_time` of `proc_pid_rusage` through `scripts/proc-cpu.c`:
  the same 1 s child read 1,066–1,133 ms. One run per measurement, Linux-like semantics (cutime + cstime).
- **V2** `(comm)` for unreadable arguments: the parity check found no difference between libproc and `ps` on the
  220–264 own processes of each macOS shard; other users' processes are not compared (their arguments are not readable
  for either).
- **V3** Terminal.app focus reporting (`?1004`): not verified (needs someone with a Mac: switch tabs, the debug footer
  must say `lvl … unfocused`). It changes no code (Decision 10).
- **V4** `brew install tmux` on macos-14: 4–5 s (tmux 3.7c). The `script -q` fallback is not needed.
