# Adaptive Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The TUI refreshes fast while something happens and slowly when nothing does or the terminal is in the background. Every job has a CPU budget. Alarms (waiting-for-you, approval, stuck) keep ≤ 1.5 s latency whenever an agent process is live.

**Architecture:** A pure scheduler module `src/sched.ts` holds the activity level (`hot|warm|idle|away`), the per-level job table, due-time computation, the CPU-budget stretching and the clock-jump rule. The caller passes the clock in, so `sched.check.ts` tests it. `main.ts` replaces both `setInterval`s with one self-rescheduling `setTimeout` loop over named jobs. New seams: `H.onWatch` (the alarm job; the watchdog moves there, rules-config uses it later) and `H.fastArmed` (gates the 50 ms timer). Frames are built only when dirty and written only when they differ (`src/ui/frame.ts`). Focus reporting (`ESC[?1004h`) drives `away`. A cheap live probe (`probeLive()` in `sessions.ts`) stats pid-linked files and feeds `hot`.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`).

**Spec:** [spec.md](spec.md). Read it first; this plan argues from it.

**Phase / order:** Phase 7, no dependencies. Independent of every other plan. This plan **owns** the `H.onWatch` alarm job (1.5 s while any agent is live, else 5 s). The watchdog uses it from Task 2 on. rules-config's engine registers on it later, rules-config (phase 6) normally merges first: its engine runs on the watchdog tick (`H.onTick`) and this branch moves it to `H.onWatch` in Task 2. If the order flips, rules-config does the move — whichever merges second does it (spec Decision 6). Recommended merge order inside phase 7: cli-agent-mode, related-events, command-palette, adaptive-refresh. honest-costs' projection/budget check stays on `H.onTick`.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x` (scriptc via `. ./scripts/toolchain.sh`).
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields); call optional function members via a local; out-of-range array reads trap (use `numAt` from `src/util/text.ts:90` / bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log` (the EWMA below uses only `*`/`+`).
- No `Infinity` sentinel in tables: `-1` = "job not scheduled at this level".
- Timings, exact values from the spec (ms, columns hot / warm / idle / away):
  `render` 250 / 500 / 1000 / 5000 (cap; builds only when dirty, forced build every 1000 ms, 5000 ms in `away`) ·
  `probe` 250 / 1000 / 1000 / 1000 · `procs` 1000 / 1500 / 5000 / 5000 · `scan` 2000 / 3000 / 10000 / 15000 ·
  `slow` 3000 / 5000 / 15000 / 30000 · `tick` 250 / 500 / 2000 / 5000 · `watch` 1500 when any agent is live, else 5000, at every level ·
  `fast` 50 / 50 / -1 / -1 and only while armed · `size` 2000 / 2000 / 5000 / 10000 (+ on input, ≤ once per 250 ms).
  `procs` ≤ 1500 at every level while any agent is live.
- Unfocused cap (spec Decision 3): while focus-out was reported and no focus-in since, `render` is at most once per 1000 ms at every level (also `hot`/`warm`; `away` keeps 5000). Only `render` is capped; `probe`, `scan`, `tick`, `watch`, `procs` keep their level's cadence.
- Immediate renders at every level (spec Decision 5): a stdin chunk (keys, mouse) renders right away as today; a size change (`termSize()` result differs, or SIGWINCH) sets `S.repaint` and renders right away. Neither goes through the `render` job's cap.
- Level rules: `hot` = input < 3 s ago, replay running, a live session's file grew < 5 s ago, or ledger indexing pending. Otherwise `away` = focus-out reported and no input since. Otherwise `warm` = input < 60 s ago or any live agent process. Otherwise `idle`. `away` only ever comes from focus-out (Decision 1).
- Loop sleep: min 16 ms, max 1000 ms.
- Budget: effective interval = `max(base, 20 × ewma(duration))`. Exception: `watch` and `procs` while an agent is live are capped at 1500 ms whatever they cost.
- Clock jump: a job whose `last` is in the future or more than 10 min old runs immediately.
- Config `~/.agentglass/config.json` `{"refresh":{"mode":"adaptive"|"fixed"}}`, default `adaptive`. Env `AGENTGLASS_REFRESH=adaptive|fixed` wins. An invalid value falls back to `adaptive` with one startup toast. `fixed` = today's cadence. `AGENTGLASS_DEBUG_REFRESH=1` shows the debug footer.
- `--watch` (`src/features/cli.ts:178-185`) is out of scope and stays unchanged.
- Style: match surrounding code (dense helpers, short why-comments, no new dependencies).
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-adaptive-refresh`, branch `feat/adaptive-refresh`, PR to `main`, rebase-merge after green CI.

## Review Focus

1. **A resize (`CSI 2J` from `termSize`) followed by an unchanged frame** must still repaint. Otherwise the screen stays blank until something changes. Task 3 check: `flush()` after `S.repaint = true` writes even when the frame equals the last one.
2. **A job that throws** must not stop the `setTimeout` chain, and must toast only once per job name. Task 6 check `runJob` with a throwing job, run 3 times: the loop keeps scheduling (`ran` recorded each time), one toast.
3. **Alarm latency at `idle`/`away` with a live agent**: `watch` and `procs` are due within 1500 ms even when their measured cost would stretch them (EWMA 200 ms → 20× = 4 s). Task 1 check.
4. **Focus-out followed by a key press** must leave `away` right away. A terminal that never reports focus never reaches `away` after 10 min without input. Task 1 check (level table) + Task 4 check (tokens: `ESC[I`/`ESC[O` never reach `onInput`).
5. **Suspend/resume (clock jumps forward > 10 min, or backwards)**: every job runs on the next turn, none is starved. Task 1 check with `last` = now + 60 s and now − 11 min.
6. **Unfocused but busy**: focus-out while an agent streams (`hot`) must draw at most once per second, while `tick`/`probe`/`watch` keep the `hot`/live cadence (bell and ledger stay current). Task 1 check "unfocused cap".

---

### Task 0: Worktree, baseline, open question

**Files:** none committed except `specs/adaptive-refresh/baseline.md` (measured numbers, ≤ 40 lines).

- [ ] **Step 1: Worktree** `git worktree add -b feat/adaptive-refresh ../agentglass-adaptive-refresh main && cd ../agentglass-adaptive-refresh && ./build.sh && sh scripts/check.sh` → all `ok`.
- [ ] **Step 2: Baseline CPU** (spec §7 "Task 0 measures today's baseline first"). In a tmux pane run `./agentglass`, leave it untouched on the Sessions tab. In another pane:
  Run: `pid=$(pgrep -n agentglass); pidstat -p $pid 60 1 || ps -o %cpu=,time= -p $pid` (with 0 live agents, then with 5 live agents, e.g. 5 × `claude` idle in other panes).
  Expected: a `%CPU` number per case. Record it in `baseline.md`. Fallback when `pidstat` is missing: `ps -o time= -p $pid` before and after 60 s, delta / 60.
- [ ] **Step 3: Baseline spawns** (Linux):
  Run: `timeout 60 strace -f -e trace=execve -c -p $(pgrep -n agentglass) 2>&1 | tail -5`
  Expected: about 120 `stty`, 40 `ps`, 12 `tmux` execve per minute. Record. On macOS: `sudo dtruss -f -t execve -p <pid>` for 60 s, or count `stty` with `ps -A | grep -c stty` sampling. Record "not measured" if neither is available.
- [ ] **Step 4: Baseline alarm latency**: start `claude` in a pane, ask for a command that needs approval, and time how long until ◆ appears in agentglass (stopwatch, 3 runs). Record.
- [ ] **Step 5: Open question 1, SIGWINCH / `process.stdout.columns`**. Write `/tmp/agtest-winch.ts`:
  ```ts
  let n = 0;
  process.on("SIGWINCH", () => { n++; console.log("winch " + n + " cols=" + String(process.stdout.columns) + " rows=" + String(process.stdout.rows)); });
  console.log("start cols=" + String(process.stdout.columns) + " rows=" + String(process.stdout.rows));
  setTimeout(() => console.log("done " + n), 15000);
  ```
  Run: `scriptc build /tmp/agtest-winch.ts -o /tmp/agtest-winch && /tmp/agtest-winch`, then resize the terminal (or `tmux resize-pane -x 100` from another pane) twice within 15 s.
  Expected (feature present): `start cols=<n> rows=<n>` with numbers, and at least one `winch` line per resize with the new size. Ruling **SIGWINCH=yes**: Task 6 registers the handler and the `size` job is unscheduled (`-1` at every level). `termSize()` reads `process.stdout.columns/rows` and keeps `stty` only as a fallback when they are `undefined`.
  Fallback (build error, `undefined` columns, or no `winch` lines): ruling **SIGWINCH=no**. Keep the `size` polling table from Global Constraints and `stty`. Record the ruling as a `Ruling:` line in `baseline.md`.
- [ ] **Step 6: Runtime probes the loop relies on** (same scratch program style): `setTimeout` returns and fires with a computed delay (`setTimeout(f, 16)`, `setTimeout(f, 1000)`), and `try { throw new Error("x") } catch (e) { String(e) }` inside a timer callback keeps the next `setTimeout` firing. Expected: both fire, and the chain survives the throw. Fallback if a caught throw still kills the timer: wrap each job in its own function and check `typeof` results instead of throwing; record a `Ruling:`.
- [ ] **Step 7: Focus events in the user's terminal**: `printf '\e[?1004h'; cat -v` then switch window focus away and back, Ctrl+C, `printf '\e[?1004l'`. Expected: `^[[O` then `^[[I`. Inside tmux without `focus-events on` nothing appears (documented in help, Task 7). Record.
- [ ] **Step 8: Commit** `git add specs/adaptive-refresh/baseline.md && git commit -m "chore(specs): adaptive-refresh baseline measurements and runtime rulings"`.

---

### Task 1: Pure scheduler module

**Files:** Create `src/sched.ts`, `src/sched.check.ts`.

**Interfaces — Produces:**
- `export type Level = "hot" | "warm" | "idle" | "away"`
- `export type Job = "size" | "procs" | "scan" | "slow" | "probe" | "tick" | "watch" | "fast" | "render"`
- `export const JOBS: Job[] = ["size", "procs", "scan", "slow", "probe", "tick", "watch", "fast", "render"]` (run order inside one turn, render last, like today's `main.ts:71-78`)
- `export interface Act { now: number; input: number; focusOut: number; replay: boolean; grow: number; indexing: boolean; live: boolean }` (`input`/`focusOut`/`grow` are timestamps in ms, 0 = never)
- `export function levelOf(a: Act): Level`
- `export interface JS { last: number; ew: number }`
- `export interface Sched { fixed: boolean; winch: boolean; lv: Level; unf: boolean /* focus-out reported, no focus-in since */; js: Map<string, JS> }`
- `export function newSched(fixed: boolean, winch: boolean, now: number): Sched`. Every job has `last = now`, `ew = 0`; `unf = false`.
- `export function base(j: Job, lv: Level, live: boolean, fixed: boolean, winch: boolean): number`. Returns the table value, or -1.
- `export function every(sc: Sched, j: Job, live: boolean, armed: boolean): number`. Returns the effective interval with budget and caps, or -1 (paused; `fast` while not armed). `render` with `sc.unf` → at least 1000 (unfocused cap).
- `export function due(sc: Sched, now: number, live: boolean, armed: boolean): Job[]` (in `JOBS` order, clock-jump rule applied)
- `export function ran(sc: Sched, j: Job, now: number, dur: number): void`. Sets `last = now` and `ew = ew === 0 ? dur : 0.7 * ew + 0.3 * dur`.
- `export function sleepFor(sc: Sched, now: number, live: boolean, armed: boolean): number`. Clamped to 16..1000.
- `export function forceMs(lv: Level): number`. Returns 5000 for `away`, else 1000 (forced frame build for clock texts).
- `export function debugLine(sc: Sched, live: boolean, armed: boolean): string`. Format: `lvl hot · procs 18ms/1s · scan 41ms/2s · …`, plus ` · procs slow` when `20 × ew > 1500` for `procs` while live.
- `export function refreshMode(env: string, cfg: string): { mode: string; err: string }`

Implementation core:
```ts
const LV: Level[] = ["hot", "warm", "idle", "away"];
function row(j: Job): number[] {
  if (j === "render") return [250, 500, 1000, 5000];
  if (j === "probe") return [250, 1000, 1000, 1000];
  if (j === "procs") return [1000, 1500, 5000, 5000];
  if (j === "scan") return [2000, 3000, 10000, 15000];
  if (j === "slow") return [3000, 5000, 15000, 30000];
  if (j === "tick") return [250, 500, 2000, 5000];
  if (j === "fast") return [50, 50, -1, -1];
  return [2000, 2000, 5000, 10000]; // size
}
// fixed = today's main.ts cadence: 500 ms tick, procs every 3rd, scan every 6th, slow every 10th, watchdog on every tick
function fixedMs(j: Job): number {
  if (j === "procs" || j === "watch") return j === "procs" ? 1500 : 500;
  if (j === "scan") return 3000; if (j === "slow") return 5000; if (j === "fast") return 50; if (j === "probe") return -1;
  return 500; // render, tick, size
}
export function levelOf(a: Act): Level {
  if ((a.input > 0 && a.now - a.input < 3000) || a.replay || (a.grow > 0 && a.now - a.grow < 5000) || a.indexing) return "hot";
  if (a.focusOut > 0 && a.input < a.focusOut) return "away";
  if ((a.input > 0 && a.now - a.input < 60000) || a.live) return "warm";
  return "idle";
}
export function base(j: Job, lv: Level, live: boolean, fixed: boolean, winch: boolean): number {
  if (fixed) return j === "size" && winch ? -1 : fixedMs(j);
  if (j === "size" && winch) return -1;
  if (j === "watch") return live ? 1500 : 5000;
  const v = numAt(row(j), LV.indexOf(lv), -1);
  return j === "procs" && live ? Math.min(v, 1500) : v;
}
export function every(sc: Sched, j: Job, live: boolean, armed: boolean): number {
  const b = base(j, sc.lv, live, sc.fixed, sc.winch);
  if (b < 0 || (j === "fast" && !armed && !sc.fixed)) return -1;
  if (sc.fixed) return b;
  const x = sc.js.get(j); const e = x ? Math.max(b, 20 * x.ew) : b;
  return live && (j === "watch" || j === "procs") ? Math.min(e, 1500) : e; // alarm latency wins over the budget
}
export function due(sc: Sched, now: number, live: boolean, armed: boolean): Job[] {
  const out: Job[] = [];
  for (const j of JOBS) {
    const e = every(sc, j, live, armed); if (e < 0) continue;
    const x = sc.js.get(j); const last = x ? x.last : 0;
    if (last > now || now - last > 600000 || now - last >= e) out.push(j); // clock jumped back or forward (suspend): run now
  }
  return out;
}
```
`sleepFor` returns `max(16, min(1000, min over scheduled jobs of last + every − now))`. `refreshMode`: `env` wins when non-empty. Valid values are `adaptive`/`fixed`. Anything else gives `{mode: "adaptive", err: "refresh.mode must be adaptive or fixed (got <v>)"}`. Empty env and empty cfg give `adaptive` with no error.

- [ ] **Step 1: Failing check** `src/sched.check.ts` (helper `eq(name, got, want)` like `watchdog.check.ts`). Cases:
  - levels: input 1 s ago → `hot`; replay → `hot`; grow 4 s ago → `hot`, 6 s ago with live → `warm`; indexing → `hot`; focusOut at t, input before t → `away`; focusOut at t, input after t (2 min ago, beyond 60 s) → `idle`; **no focusOut, input 10 min ago, no live → `idle`, never `away`**; live and no input → `warm`; nothing → `idle`; focus-out and indexing → `hot` (first match).
  - table: `base("scan","idle",false,false,false) === 10000`; `base("procs","idle",true,…) === 1500`; `base("procs","idle",false,…) === 5000`; `base("watch", lv, true, …) === 1500` for all four levels; `=== 5000` when not live; `base("fast","idle",…) === -1`; `base("size", "hot", false, false, true) === -1` (winch).
  - budget: `ran(sc,"scan",t,800)` → `every(sc,"scan",…) === 16000` at `hot` (20 × 800 > 2000). `ran(sc,"procs",t,200)` with live at `away` → `every === 1500` (capped). Not live → `every === 5000` (stretched from 4000 to base 5000). Fixed mode ignores the EWMA.
  - `fast`: armed at `hot` → 50; not armed → -1 and absent from `due`; `idle` armed → -1.
  - unfocused cap: `sc.unf = true` at `hot` → `every(sc,"render",…) === 1000`, `every(sc,"tick",…) === 250`, `every(sc,"probe",…) === 250`, `every(sc,"watch",true,…) === 1500` (ingest and alarms unchanged); at `away` → render 5000; `sc.unf = false` → render 250 at `hot`.
  - due: fresh sched at `now` → `due(now + 249)` empty at hot for `tick`, and `due(now + 250)` contains `tick` and `probe`. `last = now + 60000` (clock went back) → all scheduled jobs due. `last = now − 11 min` → all due. Order equals `JOBS` order and `render` is last.
  - `sleepFor` never below 16 or above 1000.
  - `refreshMode("", "")` → adaptive with no err; `("fixed","adaptive")` → fixed; `("", "fast")` → adaptive with an err containing `fast`.
  - `debugLine` begins with `lvl hot`; it contains `procs slow` after `ran(sc,"procs",t,200)` with live.
- [ ] **Step 2: Run** `scriptc build src/sched.check.ts -o /tmp/sc && /tmp/sc` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/sched.ts` as above (imports only `numAt` from `./util/text.ts`; no `S`, no `H`: pure).
- [ ] **Step 4: Run** the check → `sched: all checks passed`; `sh scripts/check.sh` PASS; `./build.sh` PASS.
- [ ] **Step 5: Commit** `git add src/sched.ts src/sched.check.ts && git commit -m "feat(refresh): pure activity-level scheduler with per-job budgets"`.

---

### Task 2: `H.onWatch` and `H.fastArmed` seams (no behavior change)

**Files:** Modify `src/hooks.ts:14-16` (doc comments + two new seams), `src/features/watchdog.ts:158` (`H.onTick.push(tick)` → `H.onWatch.push(tick)`), `src/features/watchdog.check.ts:47` (drive `H.onWatch`), `src/features/ticker.ts:58-65` (arm), `src/features/replay.ts:44-51` (arm), `src/main.ts:70-84` (call `H.onWatch` every 3rd tick = 1.5 s for now; fast timer only when armed).

**Interfaces — Produces:**
- `H.onWatch: (() => void)[]`: the alarm job. It runs every 1.5 s while any agent process is live, else every 5 s, at every activity level. The watchdog uses it, and rules-config's engine will too.
- `H.fastArmed: (() => boolean)[]`: a source that needs 50 ms frames returns true. The `fast` job runs only while one is armed.
- ticker: `H.fastArmed.push(() => total > 0 && content > slot)` (marquee overflow). replay: `H.fastArmed.push(() => R.on)`.
- `export function armed(): boolean` in `src/hooks.ts`: `for (const f of H.fastArmed) if (f()) return true; return false;`

- [ ] **Step 1: Failing check** in `watchdog.check.ts`: replace `const tick = (): void => { for (const f of H.onTick) f(); };` with `for (const f of H.onWatch) f();` and add `eq("watchdog not on onTick", String(H.onTick.length), "0")` (the check imports only watchdog, which registers nothing else on `onTick`; if another import does, compare against the count before importing watchdog instead). Run `scriptc build src/features/watchdog.check.ts -o /tmp/wd && AGENTGLASS_NOTIFY=0 /tmp/wd` → FAIL (`onWatch` missing).
- [ ] **Step 2: Implement**: the seams in `hooks.ts` with comments (`onTick: // ledger, ticker, cache, prices, callgraph: cadence follows the activity level`, `onWatch: // alarms: 1.5 s while any agent is live, else 5 s, at every level`). Move the watchdog. In `main.ts` add `if (tick % 3 === 0) for (const f of H.onWatch) f();` after `refreshProcs()`, which keeps the 1.5 s alarm cadence until Task 6. Then start the 50 ms interval unconditionally and skip the body when `!armed()`. The ticker arm uses its module vars `content`, `slot`, `total`; replay uses `R.on`.
- [ ] **Step 3: Add a ticker arm check**: the ticker has no check yet, so cover `armed()` in `sched.check.ts`. Push a `() => true` arm into `H.fastArmed` and assert `armed() === true`. Pop it and assert `false`.
- [ ] **Step 4: Run** watchdog check PASS, sched check PASS, `sh scripts/check.sh` PASS, `./build.sh`. Manual: `./agentglass` marquee still scrolls with many live agents; ◆ still appears.
- [ ] **Step 5: Commit** `refactor(hooks): onWatch alarm seam and fastArmed gate; watchdog moves to onWatch`.

---

### Task 3: Render only on change

**Files:** Create `src/ui/frame.ts`, `src/ui/frame.check.ts`. Modify `src/state.ts:17-55` (fields), `src/ui/screen.ts:32` (`spin` marks animating), `src/term.ts:12` (resize sets repaint), `src/main.ts:31-53` (`render` uses `flush`).

**Interfaces — Produces:**
- `S.dirty: boolean` (something visible changed since the last build), `S.animating: boolean` (`spin()` was called during the last build), `S.repaint: boolean` (screen was cleared, so the next frame must be written even if identical).
- `export function flush(frame: string, out: (s: string) => void): boolean` in `frame.ts`. If `!S.repaint && frame === last`, it returns false without writing. Otherwise it writes, sets `last = frame`, clears `S.repaint` and returns true.
- `export function resetFrame(): void`. Sets `last = ""` (focus-in and resize).
- `spin()` sets `S.animating = true`. `render()` sets `S.animating = false` and `S.dirty = false` before building.

- [ ] **Step 1: Failing check** `frame.check.ts`: `let n = 0; const w = (s: string): void => { n++; };`. Then `flush("A", w)` → true and n 1. `flush("A", w)` → false and n 1. `flush("B", w)` → true and n 2. `S.repaint = true; flush("B", w)` → true, n 3 and `S.repaint === false`. `resetFrame(); flush("B", w)` → true. `S.animating = false; spin(); S.animating === true`. Run → FAIL.
- [ ] **Step 2: Implement**. `render()` in `main.ts` ends with `flush(buf.join(""), (s: string) => { process.stdout.write(s); })` instead of `process.stdout.write(buf.join(""))`. `termSize()` sets `S.repaint = true` next to its `CSI 2J` write and returns `true` when the size changed; its callers (`size` job, input path, SIGWINCH handler) then call `render()` at once, so a resize repaints immediately at every level. Input still renders immediately after each `data` chunk (`main.ts:62-67`, unchanged). Typing latency is not capped at any level.
- [ ] **Step 3: Run** frame check PASS, `sh scripts/check.sh`, `./build.sh`. Manual: resize the terminal, and the screen redraws completely (Review Focus 1).
- [ ] **Step 4: Commit** `perf(ui): write a frame only when it differs from the last one`.

---

### Task 4: Focus reporting

**Files:** Modify `src/term.ts:14-21` (`enter`/`leave`, new `focusOf`), `src/main.ts:62-67` (stdin loop); Create `src/term.check.ts`.

**Interfaces — Produces:**
- `export function focusOf(t: string): string` returns `"in"` for `"\x1b[I"`, `"out"` for `"\x1b[O"`, else `""`.
- `enter()` writes `\x1b[?1004h` in addition to today's sequence. `leave()` writes `\x1b[?1004l` first.
- Main stdin loop (consumed in Task 6): for each token, a non-empty `focusOf(t)` calls `onFocus(f)` and skips `onInput`/`onMouse`. Focus-in sets `act.focusOut = 0`, `sc.unf = false` (Task 6 wires `sc`), `act.input = now` (→ `hot`), calls `resetFrame()` and renders right away. Focus-out sets `sc.unf = true` (render cap 1/s, spec Decision 3). Focus-out sets `act.focusOut = now`.

- [ ] **Step 1: Failing check** `term.check.ts`: `tokens("a\x1b[I\x1b[<0;3;4M\x1b[Ob")` deep-equals `["a","\x1b[I","\x1b[<0;3;4M","\x1b[O","b"]` (`tokens` from `src/input.ts:19-36`). Then `focusOf` maps those to `["","in","","out",""]`, and `focusOf("\x1bOA")` (arrow in SS3 form) is `""`. Run → FAIL (`focusOf` missing).
- [ ] **Step 2: Implement** `focusOf` and the `enter`/`leave` sequences. In `main.ts` the token loop becomes `const f = focusOf(t); if (f) onFocus(f); else if (t.startsWith("\x1b[<")) onMouse(t); else onInput(keyName(t));`. Until Task 6 adds the scheduler, `onFocus` only does `resetFrame()` + `render()` on `in`, so `act` comes in Task 6.
- [ ] **Step 3: Run** term check PASS, suite, build. Manual: switch focus away and back: no stray key action (e.g. `O`/`I` do not trigger anything), and quitting restores the terminal (no `^[[I` printed in the shell afterwards).
- [ ] **Step 4: Commit** `feat(term): focus reporting; focus events never reach key handling`.

---

### Task 5: Live probe

**Files:** Modify `src/model/sessions.ts` (next to `restat`, `:26-30`); Test `src/model/link.check.ts` is about linking, so create `src/model/sessions.check.ts`.

**Interfaces — Consumes:** `sourceOf`, `epochOf` (`src/harness/index.ts:33,35`), `restat` (`sessions.ts:26`).
**Produces:** `export function probeLive(): boolean`. It walks `sessions.values()`, and for each `s` with `s.pid > 0` it calls `const st = sourceOf(s.h).stat(s)`. When `st` is non-null and `st.size !== s.size || st.mtime !== s.mtime`, it calls `restat(s, st.size, st.mtime, epochOf(s))` and remembers that something changed. It returns true when any session changed. No process spawn. Sessions without a pid are left to `scan()`.

- [ ] **Step 1: Failing check** `sessions.check.ts`: write `/tmp/agtest-probe/a.jsonl` (`{"x":1}\n`). `newSess("claude","a",path,false)` with `pid = 1` and `size`/`mtime` from `statSync`, plus a second session `b` with `pid = 0` on another temp file. `sessions.set` both. `probeLive()` → false. Append a line to both files: `probeLive()` → true, `a.size` equals the new size, and `b.size` is unchanged. A deleted file with a pid → false and no throw. Run → FAIL.
- [ ] **Step 2: Implement** `probeLive`.
- [ ] **Step 3: Run** check PASS, suite, build.
- [ ] **Step 4: Commit** `feat(sessions): live probe stats pid-linked session files without spawning`.

---

### Task 6: Scheduler loop in `main.ts`, config, error isolation, debug footer

**Files:** Modify `src/main.ts:55-85` (replace both `setInterval`s), `src/term.ts` (SIGWINCH branch per Task 0 ruling), `src/sched.ts` (`runJob` helper for testability), `src/ui/footer.ts:33` (debug line), `src/features/usage/ledger.ts` (export `indexing()`); Test `src/sched.check.ts`.

**Interfaces — Consumes:** everything from Tasks 1–5; `procs` (`src/model/procs.ts:16`), `L.done/L.total` (`src/features/usage/record.ts:19`), `section` (`src/util/config.ts:13`), `say` (`src/state.ts:57`).
**Produces:**
- `export function indexing(): boolean` in `ledger.ts`: `L.total > 0 && L.done < L.total`.
- `export function runJob(sc: Sched, j: Job, f: () => void, now: () => number, warn: (msg: string) => void): void` in `sched.ts`. It times `f`, catches anything thrown, calls `warn("refresh " + j + " failed: " + String(e))` only the first time per job name (module `Set<string>`), and always calls `ran`.
- `export const DBG = { on: false, line: "" }` in `sched.ts`. `footer.ts` puts `DBG.line` right-aligned on the footer row when `DBG.on`.
- main.ts job bodies:
  - `size` runs `if (termSize()) render();` (forced repaint on resize, outside the `render` cap).
  - `procs` runs `refreshProcs()` and sets `S.dirty = true` (the header CPU graph and the Processes tab change with every sample).
  - `scan` runs `scan(); buildView();` and sets dirty when the session count or `Σ size` changed.
  - `slow` runs `refreshSlow()` and sets dirty.
  - `probe` runs `if (probeLive()) { act.grow = now; S.dirty = true; }`.
  - `tick` runs `if (S.mode === "list" && S.tab === 0) buildView(); const v = L.ver; for (const f of H.onTick) f(); if (L.ver !== v) S.dirty = true;`.
  - `watch` runs `for (const f of H.onWatch) f();` and sets dirty when any `attention`/`stuck` value changed. It keeps a signature string built over live sessions.
  - `fast` runs `for (const f of H.onFastTick) if (f()) S.dirty = true;`.
  - `render` builds only `if (S.dirty || S.animating || S.toast && now − S.toastAt < 5500 || now − lastBuild >= forceMs(sc.lv))`. Then it runs `S.frame++` and `render()`. The toast term lets the expiry frame build.
- Loop: `function turn(): void { const now = Date.now(); const live = procs.length > 0; sc.lv = levelOf({ now, input: act.input, focusOut: act.focusOut, replay: …, grow: act.grow, indexing: indexing(), live }); for (const j of due(sc, now, live, armed())) runJob(sc, j, body(j), () => Date.now(), (m) => say("err", m)); if (DBG.on) DBG.line = debugLine(sc, live, armed()); }` and `function loop(): void { try { turn(); } catch (e) { /* the chain must survive */ } setTimeout(loop, sleepFor(sc, Date.now(), procs.length > 0, armed())); }`. `replay` running = `armed()` returned true from replay. Expose `export function replaying(): boolean { return R.on; }` from `replay.ts` and use it.
- Input: `act.input = Date.now()` per data chunk. If the `size` job last ran ≥ 250 ms ago, run it now (spec "on input"). Then `render()` as today.
- Mode: `const m = refreshMode(process.env.AGENTGLASS_REFRESH ?? "", str(section("refresh")["mode"]))`; `if (m.err) say("warn", m.err)`. `DBG.on = process.env.AGENTGLASS_DEBUG_REFRESH === "1"`.
- SIGWINCH=yes ruling (Task 0): `process.on("SIGWINCH", () => { if (termSize()) render(); })`, `newSched(fixed, true, now)`, and `termSize()` reads `process.stdout.columns/rows`, falling back to `stty` when they are not numbers. SIGWINCH=no: `newSched(fixed, false, now)`, with `termSize()` unchanged.

- [ ] **Step 1: Failing checks** (sched.check.ts): `runJob` with `() => { throw new Error("boom") }` three times. `warn` is called once, `ran` recorded 3 times (`js.get("tick").last` advanced each call), and no exception escapes (Review Focus 2). `runJob` with a 30 ms busy-wait body → `ew >= 30`. Run → FAIL (`runJob` missing).
- [ ] **Step 2: Implement** `runJob`, `DBG`, `indexing()`, `replaying()`, then rewrite `main()`'s timer section as above. Delete `let tick` and both `setInterval`s. Keep `main.ts:60-61` (initial `scan/refreshProcs/refreshSlow/buildView/render`).
- [ ] **Step 3: Run** sched check PASS, `sh scripts/check.sh`, `./build.sh`.
- [ ] **Step 4: Manual verification** in tmux:
  - `AGENTGLASS_DEBUG_REFRESH=1 ./agentglass`: footer shows `lvl hot` while you type. It drops to `lvl warm` after 3 s with a live agent, and to `lvl idle` after 60 s with none. With `tmux set -g focus-events on`, switching panes shows `lvl away`, and pressing a key returns to `hot`.
  - start a `claude` that streams → `hot` within ≤ 1 s and the transcript tail follows.
  - `AGENTGLASS_REFRESH=fixed`: debug line shows the fixed intervals (`tick …/500ms`).
  - `{"refresh":{"mode":"fast"}}` in a temp `HOME` config shows one warn toast, then the app runs adaptive.
- [ ] **Step 5: Commit** `feat(refresh): one adaptive scheduler loop replaces the fixed 500 ms and 50 ms timers`.

---

### Task 7: Measurements, real-life verification, docs, final review

**Files:** Modify `README.md` ("Tiny, fast, local" section, `README.md:82-91`: adaptive refresh, `refresh.mode`, `AGENTGLASS_REFRESH`, `AGENTGLASS_DEBUG_REFRESH`, tmux `focus-events`), `src/features/cli.ts:14-26` usage text is not touched (`--watch` unchanged). Add a help section via `H.helpSections.push({ name: "refresh", ctx: "", keys: [["", "refresh adapts to activity; ~/.agentglass/config.json {\"refresh\":{\"mode\":\"fixed\"}} restores 500 ms"], ["", "in tmux: set -g focus-events on (lets agentglass slow down while unfocused)"]] })` in `main.ts`. Update `specs/adaptive-refresh/baseline.md` with after-numbers.

- [ ] **Step 1: CPU after**, same method as Task 0 Step 2. Expected: `idle`/`away` with no live agent ≤ 0.3% averaged over 60 s; `warm` with live agents ≤ 1%; `hot` not worse than the baseline. If a target is missed, run with `AGENTGLASS_DEBUG_REFRESH=1` to find the job, fix it, and repeat.
- [ ] **Step 2: Spawns after**, same command as Task 0 Step 3. Expected: no live agent and idle → 0 `stty` (SIGWINCH=yes) or ≤ 12/min, ≤ 12 `ps`/min, ≤ 4 `tmux`/min. With a live agent → about 40 `ps`/min (1.5 s bound, accepted).
- [ ] **Step 3: Alarm latency after** (Review Focus 3): an approval prompt in `idle` and in `away` (focus elsewhere, tmux `focus-events on`). Expected ≤ the baseline + 0.5 s, and ◆ within ≤ 3 s in both.
- [ ] **Step 4: Real sessions, read-only**: open the user's real Sessions/Stats/transcript/call graph views at each level and check the following. The ledger indexing gauge still advances. "3m ago" texts update (forced build). Spinners turn at a steady speed. The marquee freezes in `idle`/`away` and resumes on input. Replay (`P`) plays smoothly at 50 ms. Suspend the laptop (or `kill -STOP`/`-CONT` the pid for 11 min) and on resume the data is fresh on the first turn (Review Focus 5). macOS run if available: same steps with `lsof`.
- [ ] **Step 5: Docs** README + help section as listed. Run `sh scripts/check.sh` → PASS and `./build.sh` → PASS.
- [ ] **Step 6: Commit** `docs: adaptive refresh, refresh.mode and tmux focus-events`.
- [ ] **Step 7: Final whole-branch review** (most capable model) against spec.md and this plan's Review Focus. Do one fix pass, then open the PR to `main`. When CI is green, rebase-merge and remove the worktree and branch.
