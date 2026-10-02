# Adaptive refresh — baseline (Task 0)

Host: Linux 6.17, 32 cores, `main` @ 45fcafe, release build. agentglass untouched on the Sessions tab in a detached
tmux pane (120×40). The host runs ~23 live `claude` processes (other agents), so "0 live agents" was not available:
every number below is the "many live agents" case.

## CPU (`pidstat -p <pid> 60 1`)
| case | %CPU (one core) |
|---|---|
| before, 23 live agents, idle UI | 10.8 – 11.8 |

## Spawns per minute (`strace -f -e trace=execve`, successful execs only, 65 s window, scaled to 60 s)
| program | before |
|---|---|
| `stty` | 221 |
| `ps` | 74 |
| `tmux` | 22 |
| `sqlite3` | 4 |

(`ptrace_scope=1`: strace runs agentglass as its child instead of attaching. The counts are about 1.8× the tick
arithmetic in the spec — 120 / 40 / 12 — measured the same way before and after, so the ratio is what matters.)

## After (Task 7)
Same host, same method. "no agents" = `HOME` with no sessions and a `ps` that lists nothing (the host always has live
agents); "A/B" = old and new binary side by side for 120 s on an isolated `HOME` overlay with a warm ledger cache
(the shared `~/.agentglass/cache` is rewritten by other branches' builds, which forces re-indexing).

| case | before %CPU | after %CPU |
|---|---|---|
| no agents, idle | 0.17 | 0.05 |
| no agents, away (focus-out reported) | — | 0.02 |
| 24 live agents streaming (A/B, mostly `hot` from file growth) | 13.6 | 14.7 |

| spawns per 65 s | before, no agents | after, no agents idle | after, away | before, live | after, live |
|---|---|---|---|---|---|
| `stty` | 131 | 14 | 7 | 240 | 33 |
| `ps` | 44 | 14 | 14 | 80 | 44 |
| `tmux` | 14 | 5 | 3 | 24 | 14 |

- Targets: idle/away ≤ 0.3% met. `warm` ≤ 1% and `hot` not worse than today are not met on this host: with 24
  agents streaming the level is `hot` almost all the time (a live file grew < 5 s ago), and `hot` runs render, scan
  and slow faster than the old fixed tick (+1.1 points). Per-job CPU (`process.cpuUsage()` around each job, 60 s,
  mostly `warm`): tick 4.1% (of which the 30 s ledger cache save ≈ 2%, `buildView` ≈ 1.6%, ledger ≈ 1.5%), marquee
  frames 2.6%, procs 1.7% (`ps` lists ~1,900 processes, 94 ms wall per run: `procs slow`), scan 0.9%, render 0.8%.
  These per-run costs are out of this spec's scope ("reducing per-scan cost itself").
- The ledger's first index is a burst at the level's tick cadence (ruling below): 2× faster than the old 500 ms tick
  at up to 2× the CPU while it runs, same total work.

## Alarm latency
Not measured before or after: driving a real `claude` to an approval prompt from an unattended agent session would create real
session data. Bound by cadence. Before: watchdog every 0.5 s, CPU samples (`procs`) every 1.5 s. After: watchdog and
`procs` every 1.5 s at every level while an agent is live (`sched.check.ts` covers the bound under budget pressure),
so approval/stuck latency is unchanged and "turn finished" can take up to 1 s longer (spec Decision 2).

## Rulings during implementation
- Ruling: the first sample of a job, and any later sample, counts at most max(4 × average, 50 ms) in the EWMA. A single
  slow run (startup ledger pass, the 30 s cache save inside `tick`) otherwise stretched `tick` to 5–9 s for half a
  minute; a lasting cost still converges in a few runs. Plan checks that used one `ran()` now use a steady-state cost.
- Ruling: while ledger indexing is pending, `tick` keeps its level cadence (no budget stretch); indexing is the
  spec's one intentional burst.
- Ruling: the `fast` job renders directly when a callback reports a change (marquee steps every 150 ms, replay at its
  own pace); while unfocused it only marks dirty, so the 1/s cap holds. Fixed mode keeps `fast` paused while nothing
  is armed (the old timer ran but drew nothing then).
- Ruling: fixed mode runs `watch` every 500 ms (the old watchdog ran on every tick).
- Ruling: the debug footer shows why the level is `hot` (`input`, `replay`, `grow`, `index <bytes> left`).

## Runtime probes (scriptc 0.1.7)
- `process.on("SIGWINCH")` does not type-check (only `"SIGINT" | "SIGTERM"`), and `process.stdout` has no
  `columns`/`rows`.
- Ruling: SIGWINCH=no. The `size` job keeps polling `stty size` on the level table (2 s / 2 s / 5 s / 10 s, plus on
  input at most every 250 ms).
- `setTimeout(f, 16)` and `setTimeout(f, 1000)` fire with the computed delay (measured 1033 ms for 16 + 1000 ms
  chained), and a throw caught inside the callback leaves the chain running.
- Ruling: the loop is one self-rescheduling `setTimeout`; each job runs inside its own `try`/`catch`.
- Focus events (`ESC[?1004h`): not measured interactively (no attached terminal in this environment; a detached tmux
  session has no client focus). Parsing is covered by `src/term.check.ts`; tmux needs `set -g focus-events on`.
