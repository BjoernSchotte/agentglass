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

- (Superseded by the review below: hot is now below main.) Targets: idle/away ≤ 0.3% met. `warm` ≤ 1% and `hot` not worse than today are not met on this host: with 24
  agents streaming the level is `hot` almost all the time (a live file grew < 5 s ago), and `hot` runs render, scan
  and slow faster than the old fixed tick (+1.1 points). Per-job CPU (`process.cpuUsage()` around each job, 60 s,
  mostly `warm`): tick 4.1% (of which the 30 s ledger cache save ≈ 2%, `buildView` ≈ 1.6%, ledger ≈ 1.5%), marquee
  frames 2.6%, procs 1.7% (`ps` lists ~1,900 processes, 94 ms wall per run: `procs slow`), scan 0.9%, render 0.8%.
  These per-run costs are out of this spec's scope ("reducing per-scan cost itself").
- The ledger's first index is a burst at the level's tick cadence (ruling below): 2× faster than the old 500 ms tick
  at up to 2× the CPU while it runs, same total work.

## Alarm latency
(Measured live in the review below.) Not measured before or after: driving a real `claude` to an approval prompt from an unattended agent session would create real
session data. Bound by cadence. Before: watchdog every 0.5 s, CPU samples (`procs`) every 1.5 s. After: watchdog and
`procs` every 1.5 s at every level while an agent is live (`sched.check.ts` covers the bound under budget pressure),
so approval/stuck latency is unchanged and "turn finished" can take up to 1 s longer (spec Decision 2).

## Live test (active pi, OpenCode, Gemini sessions)
pi (cliproxy Sonnet 5.5), OpenCode and Gemini (`gemini-3.5-flash-lite`) built a todo app in `/tmp/agtest-adaptive-refresh-*`,
agentglass (`AGENTGLASS_DEBUG_REFRESH=1`, isolated HOME overlay with a warm cache) and the old binary side by side in tmux:
- Levels: `hot (grow)` ↔ `warm` while they streamed; focus-out (`ESC[O`) → `away unfocused` with render every 5 s,
  `watch`/`procs` at 1.5 s; a key while unfocused → `hot (input+grow) unfocused` with render capped at 1 s (spinner
  stepped ~1/s), `probe` 250 ms; focus-in → render 250 ms (spinner ~4/s). Replay (`P`): `hot (replay)`, `fast` 50 ms.
  Resize to 120×35: full redraw within the 2 s size poll.
- Alarm latency, "turn finished" of pi (◆ on its row after the pane stopped "Working", 0.1 s polling): focused
  new 1.51 s / old 1.51 s; focus-out but agents streaming (level `hot`, render 1/s) new 0.93 s / old 1.95 s.
- Gemini waiting on its tool-approval dialog never got ◆ "approval?" — in both binaries (pre-existing, not refresh).

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

## Review (2026-10-03)
Same host; `main` @ 3fd989f vs this branch, release builds, run side by side in detached tmux panes (120×40) under the
same live load (~37 live agents, ~1,900 processes), each with its own `AGENTGLASS_CACHE_DIR` seeded from one fully
indexed ledger (34 MB); 60 s warm-up, then `pidstat` over the same 120 s window. "PR before" = the branch as the
implementer left it, "after" = with the review fixes.

| case | main | PR before | after |
|---|---|---|---|
| hot from input (a key every second) | 10.1 % | 14.2 % | 8.5 % |
| streaming agents, no input (mostly `hot` from file growth) | 11.1 % | 16.0 % | 8.7 % |
| same, an earlier window | 11.9 % | 11.8 % | 7.2 % |
| no agents, idle (empty `HOME`, `ps` lists nothing; 60 s) | 0.17 % | — | 0.05 % |

- Root cause of the hot regression: hot ran procs (1 s), scan (2 s), slow (3 s) and tick (250 ms: `buildView`, ledger,
  ticker) faster than the old fixed loop, and with agents streaming the level is hot nearly all the time.
- Per-job CPU after the fixes, warm, 60 s (`process.cpuUsage()` around each job): tick 1.0 s (`buildView` over 1,800
  sessions ≈ 0.5 s, ledger ingest 0.42 s, ticker 0.07 s), render 0.97 s (120 frames), procs 0.89 s, scan 0.45 s, marquee
  header rows 0.42 s, watch 0.17 s, slow 0.12 s, probe 0.05 s — 6.8 % in all. Before the fixes the marquee alone cost
  2.6 s (each step built a whole frame) and the 30 s ledger save 0.5–1.1 s.
- `warm` ≤ 1 % is not reachable on this host: `ps` over ~1,900 processes, `buildView` over ~1,800 sessions and ledger
  ingest of ~37 streaming agents each cost more per run than the budget allows at their cadence; the spec leaves per-run
  costs out of scope. With no agents the target holds (0.05 %).

### Alarm latency (measured live)
An interactive `gemini --skip-trust -m gemini-3.5-flash-lite` (no yolo) asked to run `mkdir dN` shows its approval
prompt; Gemini logs the reply text but not the pending tool call, so agentglass sees a finished turn and raises ◆
("turn finished"). A poller logged every 100 ms when the prompt and the ◆ on the session's row appeared, with the
agentglass instance unfocused (`ESC[O`, level `away`) and a `main` instance next to it (focused, `hot`/`warm`).

| | prompt → ◆ |
|---|---|
| PR before (unfocused) | 2.17 s, 0.80 s, 2.30 s; earlier (focused, indexing) 0.34, 0.57, 1.26, 0.57 s and one turn never raised |
| after (unfocused) | 0.11, 0.34, 0.92, 0.69 s |
| main (focused) | ≈ 2.5 s, or nothing until the next turn (sizes only follow `scan()` every 3 s) |

Three lags added up before: the probe (≤ 1 s; the tail only follows a new stat), the 1.5 s watch and the render cap
(1/s unfocused). And a turn that started and finished between two watch runs (a 1.2 s Gemini reply) was never seen busy.

### Review rulings
- Ruling: `hot` never polls data faster than the old fixed loop — procs 1.5 s, scan 3 s, slow 5 s, tick 500 ms (250 ms
  only while the ledger indexes). Deviates from the spec table to meet its own target ("hot not worse than today");
  hot stays faster where it is cheap: the stat-only probe (250 ms) and render on change (≤ 4/s).
- Ruling: a marquee step redraws the header row only (`H.onHeaderTick`); the next full frame is always written.
- Ruling: the ledger cache is saved every 5 min outside indexing (30 s while indexing; quit always saves).
- Ruling: the watch job probes first and draws a changed alarm at once at every level, unfocused included (Decision 3
  caps drawing; a changed ◆ is rare and is the point of the alarm). A new prompt in the tail while idle raises "turn
  finished" even when the watchdog never saw the session busy.
- Flaky `opencode.check` "aged without a DB change": two suite runs at once (several worktrees) shared
  `/tmp/agentglass-oc-check/opencode.db`; reproduced by starting two check binaries 1.2 s apart. Every check with a
  fixed `/tmp` dir now uses a per-process one.
