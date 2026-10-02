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

## Alarm latency
Not measured: driving a real `claude` to an approval prompt from an unattended agent session would create real
session data. Bound by cadence: watchdog every 0.5 s (every `H.onTick`), CPU samples (`procs`) every 1.5 s.

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
