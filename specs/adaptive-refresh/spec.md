# Adaptive refresh — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 7 (no dependencies).

## Goal
agentglass refreshes fast while something happens (an agent streams, the user types or scrolls) and slowly when
nothing does or the terminal is in the background — with a hard CPU budget per refresh step, so it can stay open all
day next to the agents it watches. Alarm latency (waiting-for-you, approval, stuck) stays bounded at every level.

## Why (user value)
- It is meant to run all day in a pane. Today it does the same work every 500 ms whether five agents stream or the
  machine has been idle for hours: a process spawn every 0.5 s (`stty`), `ps` every 1.5 s, a full transcript-directory
  scan every 3 s, `lsof`/`/proc` plus `tmux` every 5 s, a full re-render every 0.5 s and a 50 ms timer that never stops.
  On a laptop that is battery and fan noise for nothing.
- While an agent streams, 500 ms feels laggy; the budget saved while idle can be spent there.

## Today (current code, with path:line refs)
- One 500 ms `setInterval` (`src/main.ts:70-79`), by tick count:
  - every tick: `termSize()` spawns `stty size` (`src/main.ts:72`, `src/term.ts:8-13`); `buildView()` when on the
    session list (`main.ts:76`); all `H.onTick` callbacks (`main.ts:77`); unconditional `render()` and full-frame
    write (`main.ts:78`, `main.ts:31-53`).
  - every 3rd: `refreshProcs()` → `ps -axo …` spawn (`main.ts:73`, `src/model/procs.ts:41-89`,
    `src/platform/posix.ts:11`) plus per-process CPU sampling.
  - every 6th: `scan()` lists every harness root (Claude: one `listDir` per project dir) and `buildView()`
    (`main.ts:74`, `src/model/sessions.ts:31-35`).
  - every 10th: `refreshSlow()` → `/proc` walk (Linux) or `lsof` (macOS) for cwd/open files plus a `tmux list-panes`
    spawn (`main.ts:75`, `procs.ts:91-106`, `src/platform/linux.ts:28`, `posix.ts:21`).
- `H.onTick` subscribers (`src/hooks.ts:14`): ledger indexing with a 100 ms / 4 MiB slice
  (`src/features/usage/ledger.ts:15,67-89`), ticker rebuild (`src/features/ticker.ts:57`), watchdog — `loadTail` of
  every live top-level session + detectors (`src/features/watchdog.ts:131-158`), cache save every 30 s
  (`src/features/usage/cache.ts:98`), price refresh check (`src/features/prices.ts:13`), call-graph refresh
  (`src/features/callgraph/view.ts:335`).
- A second 50 ms `setInterval` runs whenever any `H.onFastTick` is registered (`main.ts:80-84`, `hooks.ts:16`). The
  ticker always registers one (`ticker.ts:58-65`), so it **always** runs; it scrolls the marquee every 150 ms when
  the text overflows. Replay registers one too (`src/features/replay.ts:44-51`).
- Input renders immediately (`main.ts:62-67`). Spinners animate from `S.frame` (`src/ui/screen.ts:32`), incremented
  per tick (`main.ts:71`).
- No focus reporting: `enter()` enables alt screen and SGR mouse only (`term.ts:14-18`). The tokenizer already splits
  `ESC [ I` / `ESC [ O` into single tokens (`src/input.ts:19-36`).
- `--watch` has its own 500 ms loop (`src/features/cli.ts:178-185`); out of scope here (no rendering, users expect
  fixed latency).

## Design

### 1. Activity levels
`type Level = "hot" | "warm" | "idle" | "away"`, recomputed after every input and every job run:

| level | when (first match) |
|---|---|
| `hot` | input (key, mouse, wheel) within 3 s · replay running · a live session's file grew within 5 s · ledger indexing pending |
| `away` | terminal reported focus-out (6) and no input since — **only** from focus-out; input inactivity alone never makes `away` |
| `warm` | input within 60 s · any live agent process (busy or not) |
| `idle` | otherwise |

"File grew" comes from the live probe (3), not from `scan()`, so idle-to-hot takes ≤ 1 s.

### 2. Scheduler
Replace both `setInterval`s in `main.ts` with one self-rescheduling `setTimeout` loop (`setTimeout` exists in the
runtime, `src/actions.ts:70`) over named jobs. Each job has a base interval per level; the loop sleeps until the
earliest due job (min 16 ms, max 1 s so level changes apply promptly).

| job | hot | warm | idle | away | notes |
|---|---|---|---|---|---|
| `render` | on change, ≤ 4/s | on change, ≤ 2/s | on change, ≤ 1/s | ≤ 1 per 5 s | see 4; while unfocused ≤ 1/s at every level (below); keystrokes and resize render at once |
| `probe` (stat live files) | 250 ms | 1 s | 1 s | 1 s | no spawn; feeds `hot` |
| `procs` (`refreshProcs`) | 1 s | 1.5 s | 5 s | 5 s | watchdog needs it (approval: CPU quiet); ≤ 1.5 s at every level while any agent is live (below) |
| `scan` (+ `buildView`) | 2 s | 3 s | 10 s | 15 s | new sessions appear within that |
| `slow` (`refreshSlow`) | 3 s | 5 s | 15 s | 30 s | cwd/open files/tmux |
| `tick` (`H.onTick`) | 250 ms | 500 ms | 2 s | 5 s | ledger, ticker, cache, prices, callgraph |
| `watch` (watchdog / rules, `H.onWatch`) | 1.5 s / 5 s | 1.5 s / 5 s | 5 s | 1.5 s / 5 s | 1.5 s while any agent is live, else 5 s, at every level (`idle` has no live agent by definition; `hot` from input alone and `away` can go either way) |
| `fast` (`H.onFastTick`) | 50 ms | 50 ms | paused | paused | only while armed (5) |
| `size` (`termSize`) | on input + 2 s | 2 s | 5 s | 10 s | or SIGWINCH (open question 1) |

**Alarm cadence does not relax while agents run.** The watchdog (and rules-config's engine) moves from `H.onTick` to
its own job `watch` (new seam `H.onWatch`, same signature): every **1.5 s while any agent process is live**, at every
level including `idle` and `away`, and every 5 s when none is. `procs` follows the same bound (≤ 1.5 s while an agent
is live), because approval and stalled detection need fresh CPU samples. So "waiting for you" / approval / stuck
alarms keep today's latency (≤ 1.5 s) whenever there is something to alarm about; the saving comes from render,
scan, slow and tick. Cost accepted: one `ps` spawn per 1.5 s while an agent runs. On level change to `hot` all
overdue jobs run on the next loop turn.

**Unfocused terminal.** While the terminal has reported focus-out (6) and no focus-in since, `render` is capped at
1/s even when the level is `hot` (an agent streams in a background pane) or `warm`; `away` keeps its 1 per 5 s.
Only drawing is capped: `probe`, `scan`, `tick` (ledger ingest), `watch` (watchdog, rules, alarms) and `procs` keep
the full cadence of the level, so the bell, desktop notifications and the data are as fresh as when focused.

### 3. Live probe
Every `probe` interval: `statSync` of each **pid-linked** session file (non-file sources: their `stat()`,
`src/harness/types.ts:16`) — typically < 10 files, no process spawn. Size or mtime change → mark `lastGrow = now`,
and update `s.size`/`s.mtime` so the transcript tail follows without waiting for `scan()`. Sessions not linked to a
process are only seen by `scan()`.

### 4. Render only on change
- `render()` builds the frame as today, then compares `buf.join("")` with the last written frame; identical → no
  write. (String compare of a few tens of KB; cheaper than the terminal repaint it avoids.)
- Dirty flags avoid building at all: `S.dirty` is set by input, `scan`/`procs`/`probe` when they change anything
  visible (session set, sizes, pids, statuses), `L.ver` changes (ledger), toasts expiring, and spinners — the latter
  only when something on screen animates (`spin()` called during the previous render sets `S.animating`). Clock
  texts ("3m ago") are covered by a forced build at least every 5 s (`away`) / 1 s (others).
- **Immediate renders, at every level:** a keystroke or mouse event renders at once (as `main.ts:62-67` today), and a
  terminal resize (a changed `termSize()` result, or SIGWINCH if available) forces a full repaint (`CSI 2J` + write,
  bypassing the frame compare). Neither waits for the `render` job nor counts against its cap.
- `S.frame` (spinner phase) advances on the `render` job, not per tick, so spinners keep a steady speed across levels
  (≈ 4 fps hot, 2 warm, 1 idle).

### 5. Fast frames only when needed
`H.onFastTick` keeps its signature. New optional `H.fastArmed: (() => boolean)[]`: the ticker reports
`content > slot` (marquee overflow), replay reports `R.on`. The `fast` job runs only while one is armed **and** the
level is `hot`/`warm`; in `idle`/`away` the marquee freezes at its current offset. Without any armed source no 50 ms
timer exists.

### 6. Focus detection
- `enter()` adds `ESC[?1004h`, `leave()` adds `ESC[?1004l` (`term.ts:16,20`). `ESC[I` = focus in, `ESC[O` = focus out;
  handled in the stdin loop before `onInput` (never passed on as keys).
- Supported by xterm, VTE terminals, kitty, WezTerm, iTerm2, Alacritty, foot, Windows Terminal; tmux forwards them only
  with `set -g focus-events on` (help text says so). A terminal that never reports focus simply never enters `away`.
- Focus-in → `hot` (the user is looking) and an immediate full render (also covers terminals that dropped frames).

### 7. CPU budget
- Each job's run time is measured (`Date.now()` around the call). Its effective interval becomes
  `max(base, 20 × ewma(duration))` — no single job may use more than ~5% of one core on average. Exception: `watch`
  and `procs` while an agent is live are capped at 1.5 s whatever they cost (alarm latency wins over the budget); a
  host where `ps` alone exceeds the budget shows `procs slow` in the debug footer (8). Example: `ps` taking
  60 ms on a host with 3,000 processes stretches `procs` to ≥ 1.2 s even in `hot`.
- The ledger keeps its own 100 ms slice (`ledger.ts:15`) — indexing is the one intentional burst and is visible as a
  progress gauge; during indexing the level is `hot`, so the UI stays responsive between slices.
- Targets (Task 0 measures today's baseline first): `idle`/`away` with no live agent ≤ 0.3% of one core averaged over
  60 s; `warm` ≤ 1% (with live agents, the 1.5 s `ps` cadence is included in this budget); `hot` not worse than today.

### 8. Configuration
- `~/.agentglass/config.json` `{"refresh": {"mode": "adaptive" | "fixed"}}`, default `adaptive`; `fixed` restores
  today's cadence (500 ms tick, jobs as today) for anyone who prefers it or hits a bug. Env override
  `AGENTGLASS_REFRESH=adaptive|fixed`.
- `AGENTGLASS_DEBUG_REFRESH=1`: footer shows `lvl hot · procs 18ms/1s · scan 41ms/2s …` for tuning; off by default.

### Failure modes
- Clock jumps (suspend/resume): a job whose `last` is in the future or > 10 min old runs immediately; resume shows
  fresh data on the first loop turn.
- An exception in a job is caught per job (logged once as a toast), the loop keeps running and reschedules (a thrown error must never stop the self-rescheduling `setTimeout` chain).
- `stty` missing/failing: today defaults to 24×80 (`term.ts:11`); unchanged.

## Interactions with other specs
- **rules-config** (phase 6): its engine first runs on the watchdog's `H.onTick` job; it moves to `H.onWatch` (the
  `watch` job, 1.5 s while agents are live) when this spec lands. Whichever of the two merges second does the move.
  Rules with `for:` durations must use wall time, not tick counts (the interval varies when no agent is live).
- **honest-costs**: projection/budget checks run on `tick`; budget notifications stay once per day.
- **command-palette**: palette open = input activity → `hot`.
- **otlp-export** `--watch --otlp`: uses the CLI loop, not this scheduler.

## Testing
- Pure scheduler module (`src/sched.ts`) with an injected clock: level transitions (no `away` after 10 min without
  input but with focus; `away` only after focus-out), due-time computation, the unfocused render cap (≤ 1/s while
  `hot`, ingest and `watch` unchanged), immediate render on keystroke and forced repaint on resize at every level, bounds (`watch` and `procs` ≤ 1.5 s at
  every level while an agent is live, 5 s otherwise), budget stretching from synthetic durations (never past the
  1.5 s alarm bound — see 7), clock jump handling — `sched.check.ts`.
- Focus parsing: token stream with interleaved `ESC[I`/`ESC[O`, mouse and keys.
- Render diff: identical frame → no write (stub `process.stdout.write`).
- Manual/perf: Task 0 baseline and after, on Linux and macOS, with 0 and 5 live agents: `pidstat -p <pid> 60 1` /
  `ps -o %cpu`, spawned process count (`strace -f -e execve -c` on Linux), alarm latency (send an agent to an
  approval prompt, measure until ◆ appears) in `idle` and `away`.

## Out of scope
- `--watch` cadence; file-system notification APIs (inotify/FSEvents — not available to the runtime today).
- Reducing per-scan cost itself (incremental directory scans); this spec only schedules it less often.

## Decisions (review 2026-10-02)
1. `away` from input inactivity when focus reporting is unavailable? No; `away` comes only from focus-out (1).
2. Alarm latency? The watchdog/alarm cadence (and `procs`) stays 1.5 s while any agent is live, 5 s otherwise (2).
3. Rendering while the terminal is unfocused? Capped at 1/s even when `hot`; ingest, watchdog and alarms keep full
   speed (2).
4. `watch` cadence per level? 1.5 s only while an agent is live, else 5 s, at every level; the table matches the rule
   text (2).
5. Keystrokes and resize? A keystroke renders immediately and a resize forces a full repaint, regardless of level (4).
6. rules-config on `H.onWatch`? rules-config (phase 6) runs on the watchdog tick and moves to `H.onWatch` when this
   spec lands; whichever merges second does the move (Interactions).

## Open questions (to verify during implementation)
1. Does the scriptc runtime deliver `SIGWINCH` (`process.on("SIGWINCH")`) or expose `process.stdout.columns/rows`?
   If yes, drop `stty` polling entirely; if not, keep the polling table above.
