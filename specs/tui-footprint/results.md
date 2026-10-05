# TUI footprint — results

Status: measured 2026-10-05/06 on `main` @ d00257f (T0–T8, PRs #60 and #59) against `main` @ e5b02e7 (the last main
before them: model-prices merged, footprint not). The pinned-filter and cold-start CPU rows also give the numbers with
#63 (`perf/pinned-and-cold`). Spec: [spec.md](spec.md), plan: [plan.md](plan.md) Task 9.

## Method
- Host: Linux 6.17, 32 cores, about 3,450 sessions (12 GB of transcripts), 36 live agents streaming, load average 2–11.
  Both binaries are release builds (`./build.sh`) run with `nice -n 10`.
- TUI: `sh scripts/footprint.sh` runs in a detached 160×45 tmux pane. Every `AGENTGLASS_*` path, including
  `AGENTGLASS_PRICES`, points into a scratch dir, and `AGENTGLASS_AGENT=0` is set. CPU is the utime+stime (self) and
  cutime+cstime (children) of the process, taken over the window after a 30 s warm-up. `--away` sends the terminal's
  focus-out after the first frame. The warm caches come from the golden runs: the new binary's cache was migrated from
  `ledger.json` to `ledger.jsonl`.
- Exactness: `sh scripts/golden-usage.sh --ref <e5b02e7> --new <d00257f>`. It compares tokens, costs, unpriced
  tokens and credits, tools, lines, skills, billing, the session sets of three call-row filters and the
  `cost --by session --since 30d` rows, on every session that did not change during the runs.
- One-shot runs: `/usr/bin/time -v` with an isolated cache, two samples each, run alternately.
- Job costs: the debug footer (`AGENTGLASS_DEBUG_REFRESH=1`, 300 columns wide so nothing is cut off), after 60 s warm.

## Results
| | before (e5b02e7) | after (d00257f) | target | |
|---|---|---|---|---|
| Golden `--warm` (new binary starts from the old binary's cache) | — | 3,388 sessions, **0 differences** | 0 | met |
| Golden `--cold` (all harnesses) | — | 3,390 sessions, **0 differences** | 0 | met |
| TUI first frame, warm | 2,476 ms | **752 ms** | ≤ 1 s | met |
| TUI first frame, warm, pinned `tool is Bash` | 2,831 ms | **588 ms** (matches fill in within ~12 s, `filtering n/m` until then) | ≤ 1 s | met |
| TUI first frame, cold cache | 351 ms | **353 ms**, gauge after 3 s | ≤ 2 s, gauge | met |
| History indexed on a cold start (TUI) | ~8 min (spec) | 265 s on d00257f; **500 s** with #63 (whole process held at 20 %), peak RSS 332 MB | ≈ 4 min; longer accepted for the 20 % cap | accepted |
| TUI RSS 5 s / 30 s / end, warm | 828 / 828 / 828 MB | **169 / 175 / 176 MB** | ≤ 300 MB | met |
| TUI RSS end, pinned `tool is Bash` | 825 MB | **272 MB** | ≤ 300 MB | met |
| TUI CPU, warm, focused, 120 s (self + children) | 12.12 + 4.19 = **16.3 %** | 4.03 + 0.15 = **4.2 %** (3.5–4.2 % over runs) | ≤ 2 % applies to the unattended (away) state (decision) | accepted |
| TUI CPU, warm, unfocused (`--away`) | 7.18 + 4.19 = 11.4 % | 1.69 + 0.05 = **1.7 %** | ≤ 2 % | met |
| TUI CPU, pinned `tool is Bash`, focused, 60 s | 13.10 + 4.02 = 17.1 % | 6.8 % on d00257f; **+0.27 %** over no filter with #63 (3 alternating pairs) | ≤ +0.5 % over no filter (decision) | met with #63 |
| TUI CPU, cold start, whole process while history indexes | 27.1 + 4.1 = 31.2 % (first 100 s) | 27.1 % on d00257f; **19.9 %** over 500 s with #63 | ≤ 20 %, the whole process (Decision 1) | met with #63 |
| Cold full index `--json --subagents`, peak RSS | 903 MB | **478 MB** | ≤ 500 MB | met |
| Cold full index, wall / user CPU | 58.1 s / 53.6 s | 59.3 s / 54.8 s | not slower than ref by more than 10 % | met (+2 %) |
| Warm `--json --limit 400` (2nd run) | 1.16 s / 408 MB | **0.83 s / 149 MB** | not slower, not larger | met |
| Warm `cost --json` (2nd run) | 0.99 s / 401 MB | **0.71 s / 137 MB** | not slower, not larger | met |

The spec's own baseline (0e610f3, the 2026.10.4 release) was 810–827 MB RSS, a 2.2–2.4 s first frame, 19.1 % CPU
(14.1 % self + 5.0 % children) and an 875 MB cold peak. e5b02e7 above is the same code plus #56/#58, and it measures
the same on this host.

### Where the focused CPU goes (debug footer, warm, 60 s, nothing typed)
`procs 13 ms / 1.5 s · tick 4.1 ms / 500 ms · render 3.6 ms / 500 ms · scan 7.5 ms / 3 s · watch 3.8 ms / 1.5 s ·
size 1.7 ms / 2 s · slow 2.8 ms / 5 s · probe 0.2 ms / 1 s · ingest 0 ms/s · 0 KB/s`

That is about procs 0.9 %, tick 0.8 %, render ≤ 0.7 %, scan 0.25 %, watch 0.25 %, size 0.1 %, slow 0.06 %: about
3.1 % in the jobs. The rest of the measured 4.0 % self is the runtime outside the jobs (loop, input poll, allocation).
Before: procs 102 ms, render 112–160 ms, tick 14–20 ms, scan 32 ms (spec "Today").

### Memory
- Warm TUI: 176 MB (was 828 MB). The ledger loads from `ledger.jsonl` one line at a time, call rows are read only on
  demand and kept in columns, there is no save on the first tick, and calls files are read without a JSON tree.
- Pinned call filter: 272 MB. Every calls file is read, which adds the rows in columns (~25 MB) and the global
  dictionary of command lines (~60 MB, 213k distinct strings).
- Cold full index: 478 MB (was 903 MB). The save is streamed, and one-shot runs pack the day maps of the logs they
  have read back to text.

## Decisions and rulings
- **Focused CPU 3.5–4.2 % is accepted (lead decision, from the user's low-load mandate).** The ≤ 2 % target applies to
  the unattended state: in the background (`--away`) it is met at 1.7 %. In front, these are the floors: procs (~0.9 %),
  the tick (~0.8 %), render (≤ 0.7 %) and about 1 % of runtime overhead. Each is bound by the 1.5 s alarm cadence
  (Decision 7) and the hot refresh level while agents stream.
- **Pinned call filter: re-matched incrementally (#63).** A session's row verdict is kept while its ledger entry, the
  retention cut and the price generation are unchanged. After a ledger move only the moved sessions are re-checked,
  and the "pins hide n" count is redone only when a set changed. Same binary, pinned `tool is Bash` vs no filter, 3
  alternating pairs: 4.15/3.60/5.52 % vs 3.83/3.58/5.05 %, which is +0.27 % on average. The final set equals a full
  re-match (`eval.check.ts`, `ui.check.ts`).
- **Cold-start CPU: the whole process holds 20 % (#63).** History reads spend a credit: 0.19 of one core minus this
  process's other CPU over the last second (`process.cpuUsage`). The 0.01 covers children and the one-window lag. Live
  ingest keeps its fixed slice. Result: 19.9 % (self + children) over the whole cold start. History is done after
  500 s instead of 265 s, the price of the cap.
- **CHANGELOG not edited.** The release tooling (`scripts/release.sh`) generates CHANGELOG.md from the commit
  subjects; a hand-written "unreleased" entry would be duplicated at release time.
- **Golden skipped counts (65–73).** These are sessions written during the runs: 36 live agents plus the agents
  running this work. Each compare took several minutes.

## Manual pass (this run)
- The Sessions, Processes, Stats and Repos tabs at 80, 120 and 200 columns (warm, d00257f): every tab drew a full
  30-row frame with its header and box. `?` lists `⟳ 34%` (indexing) and `filtering n/m` (call filter).
- Cold start: the gauge showed after 3 s, sessions were listed at once, and history was done after 265 s. Pinned
  `tool is Bash`: the first frame at 588 ms shows `filtering n/m`, and matches fill in newest first.
- Alarms: the watchdog ran at its 1.5 s cadence while agents were live, focused and `--away` (`watch 3.8 ms / 1.5 s`
  in the footer). A real turn ending was not timed in this run: no session of the user was prompted. The alarm logic
  is covered by `watchdog.check.ts` and `sched.check.ts` in the suite.
