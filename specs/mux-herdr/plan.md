# Live agents in herdr panes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send (`s`), jump (`R`/`a`), approval (◆) and exact process ↔ session links work for agents in herdr panes, through a multiplexer port (`src/mux/`) with tmux, herdr and none adapters; preview, Processes, `--json` and the filter language show the pane.

**Architecture:** `src/mux/types.ts` is the port, `src/mux/index.ts` the registry and the functions the app calls (pane of a pid / session, forced refresh before actions, links, a per-look reader for the watchdog). `tmux.ts` holds today's tmux code unchanged; `herdr.ts` talks to herdr through its CLI (`agent list`, `workspace list`, `tab list`, `pane process-info`, `status server`, `agent prompt`, `agent focus`), with every parsing and decision rule pure in `herdr-parse.ts`; `none.ts` is the null adapter. The pane map refreshes from the slow job (process change, 30 s, forced before actions); herdr statuses are read from the watchdog only while an approval can be pending.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first, including "Measured", "Decisions" and "Open questions"; this plan argues from it.

**Roadmap:** Round 2 (after 2026.10.4). No other plan must merge first; no ledger `VERSION` bump (no cached data changes).

## Global Constraints

- Build `./build.sh`; tests `CHECK_JOBS=4 sh scripts/check.sh`; a task is done only when both pass. Single check:
  `scriptc build <f> -o ~/.cache/agentglass-agents/<you>/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme AGENTGLASS_HERDR=off ~/.cache/agentglass-agents/<you>/x`
  (builds and caches under `~/.cache/agentglass-agents/<you>/`, never `/tmp`: a shared RAM tmpfs).
- scriptc 0.1.7 limits: no Unix-domain sockets (hence the CLI); nominal typing (pass fields, not foreign interfaces);
  call optional function members via a local; a zero-parameter arrow for an **optional** interface member is rejected
  (SC2003) — the port's members are all required; out-of-range array reads trap (bounds-check, `?? ""`); SC1090: never
  `return xs[i]` bare from a function whose result indexes an array (`+ 0` / `String(...)`), no index reads inside
  `.map` callbacks (plain `for…of`); no `String.replace` in static builds (`split/join`); no `Record<string, RegExp>`.
- **Never touch the user's herdr.** Live research is read-only (`herdr agent list`, `workspace list`, `tab list`,
  `pane process-info`, `status server`). `agent prompt`, `agent focus`, `pane report-*`, `pane run`, `workspace create`
  run only against an isolated server (Task 0 Step 3 recipe). Never against an orchestrator running in the user's herdr.
- **Hermetic tests**: after Task 3, `scripts/check.sh` strips `HERDR_*` and sets `AGENTGLASS_HERDR=off` for every
  check and shell test; a herdr check opts in with a fake binary (`process.env["AGENTGLASS_HERDR"] = fake`) and
  `AGENTGLASS_HERDR_SOCKET`.
- Running agentglass by hand: every isolation variable written literally inline (zsh does not word-split `$VAR`):
  `AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp`
  (`mkdir -p $S/run && chmod 700 $S/run`); `ls -la ~/.agentglass` before and after; one TUI at a time, killed by pid.
- Process environments: only the values of `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are kept; the block is dropped in
  the same function (`envHerdr`). Nothing of it is logged, cached or exported.
- tmux behavior is a contract: every tmux path (pane map cadence, titles once per look, `send-keys -l` + Enter after
  400 ms, `switch-client` inside tmux) behaves as before; only the "neither" wording changes (Task 4).
- `--json` is a stable contract: `mux` is additive; no other field changes.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: integration branch `feat/mux-herdr` (worktree `../agentglass-mux-herdr`); parallel tasks on
  `feat/mux-herdr-t<N>` in `../agentglass-mux-herdr-t<N>`, branched from the integration branch at the point named in
  the task, merged back by the lead in task order; one PR `feat/mux-herdr` → `main`.

## Task order and parallelism

| Task | What | Runs | Needs |
|---|---|---|---|
| 0 | worktree, live verification, isolated-server recipe | sequential, first | — |
| 1 | port + tmux/none adapters, call sites through the port (refactor) | **parallel with 2** | 0 |
| 2 | `herdr-parse.ts` pure rules + check | **parallel with 1** | 0 |
| 3 | herdr adapter (detection, map, process-info, version) + fake herdr + hermetic `check.sh` | sequential | 1, 2 |
| 4 | send + jump through the port, wording, keys/help/footer/palette | **parallel with 5, 6, 7** | 3 |
| 5 | approval from herdr `blocked` (watchdog look, gate, staleness) | **parallel with 4, 6, 7** | 3 |
| 6 | exact links from `agent_session` in `linkSessions` | **parallel with 4, 5, 7** | 3 |
| 7 | preview/Processes lines, `--json mux`, filter key `mux`, config, README/CHANGELOG | **parallel with 4, 5, 6** | 3 |
| 8 | end-to-end test with an isolated herdr, footprint, live QA | sequential, last | 4–7 |

Files touched by the parallel tasks do not overlap (each task lists its files); `README.md`/`CHANGELOG.md` are Task 7's
alone — Tasks 4–6 put their doc lines into their PR description and Task 7 (or the lead at merge) folds them in.

## Review Focus

1. **The user's herdr is never written to by tests or tooling**: `scripts/check.sh` strips `HERDR_*` and sets
   `AGENTGLASS_HERDR=off`; `herdr.check.ts` uses a fake; the e2e test pins `AGENTGLASS_HERDR_SOCKET` to its own server
   and never discovers others (Task 3 check: with the pin, no other socket appears in the fake's call log).
2. **Typing into a dialog**: send is refused while `blocked` (herdr's `agent_blocked`), refused for herdr < 0.8.2 or an
   unknown version, and never falls back to `send-keys` for a herdr pane (Task 4 check).
3. **Innermost wins**: a pid tmux maps is never routed to herdr, even when herdr reports an `agent_session` for the
   outer pane (Task 1 + Task 6 checks).
4. **CPU**: no herdr spawn on a tick where nothing is due; ≤ 1 `agent list` per server per look; process-info ≤ 8 per
   slow pass in the TUI; nothing at all with herdr absent (Task 3/5 checks count fake calls; Task 8 footprint).
5. **Staleness**: a `blocked` reading older than the session's last log write never raises ◆; a moved pane is addressed
   by its new id at action time (forced refresh) (Task 5 and Task 3 checks).
6. **Privacy**: only `HERDR_SOCKET_PATH`/`HERDR_PANE_ID` values kept from environments; labels hidden under `--redact`
   in preview, Processes, toasts and `--json` (Task 2/7 checks).

---

### Task 0: Worktree, live verification, isolated herdr recipe

**Files:** none committed. Findings go into the PR description (`Ruling:` lines).

- [ ] **Step 1: Worktree + build + checks.**
  `git worktree add -b feat/mux-herdr ../agentglass-mux-herdr origin/main && cd ../agentglass-mux-herdr && ./build.sh && CHECK_JOBS=4 sh scripts/check.sh`.
  Expected: build succeeds, every check `ok`.
- [ ] **Step 2: Read-only shapes from the user's herdr** (skip if `herdr` is not installed; never another subcommand):
  `herdr --version; herdr status server | grep -E '^(version|status):'; herdr agent list | python3 -c "import json,sys;a=json.load(sys.stdin)['result']['agents'];print(len(a),sorted(a[0].keys()))"`.
  Expected (0.9.1): `version: 0.9.1`, keys `agent, agent_session, agent_status, cwd, focused, foreground_cwd, pane_id, revision, state_change_seq, tab_id, terminal_id, terminal_title, terminal_title_stripped, workspace_id`.
  Any other key set → `Ruling:` line; `parseAgents` (Task 2) reads only the keys the spec names.
- [ ] **Step 3: Isolated server recipe** (used again in Task 8; one server at a time, stopped by pid):

```sh
D=$HOME/.cache/agentglass-agents/<you>/herdr; mkdir -p "$D/home" "$D/cfg/herdr" "$D/state" "$D/bin"
HB=$(command -v herdr)
H() { env -i HOME="$D/home" XDG_CONFIG_HOME="$D/cfg" XDG_STATE_HOME="$D/state" HERDR_SOCKET_PATH="$D/cfg/herdr/herdr.sock" PATH=/usr/bin:/bin TERM=xterm-256color "$HB" "$@"; }
env -i HOME="$D/home" XDG_CONFIG_HOME="$D/cfg" XDG_STATE_HOME="$D/state" HERDR_SOCKET_PATH="$D/cfg/herdr/herdr.sock" PATH=/usr/bin:/bin TERM=xterm-256color setsid "$HB" server > "$D/server.log" 2>&1 & echo $! > "$D/server.pid"
cp "$(command -v dash || echo /bin/sh)" "$D/bin/claude"     # a stand-in agent: argv[0] and comm are "claude"
H workspace create --cwd "$D" --label fixture --no-focus     # → root pane w1:p1
sleep 1; H pane run w1:p1 "$D/bin/claude -c 'while IFS= read -r l; do printf \"%s\\n\" \"\$l\" >> $D/recv.txt; done'"
sleep 1; H pane report-agent w1:p1 --source herdr:claude --agent claude --state idle
H pane report-agent-session w1:p1 --source herdr:claude --agent claude --agent-session-id 11111111-2222-4333-8444-555555555555
H agent prompt w1:p1 'hello'; sleep 0.5; cat "$D/recv.txt"          # Expected: hello
H pane report-agent w1:p1 --source herdr:claude --agent claude --state blocked
H agent prompt w1:p1 'refused'; echo "exit $?"                      # Expected: agent_blocked on stderr, exit 1
H server stop; sleep 1; kill "$(cat "$D/server.pid")" 2>/dev/null; true
```

  Expected as in the spec's "Measured" table. `pane report-agent-session` only sticks with an official source
  (`herdr:<agent>`); `pane run` right after `workspace create` can race the pane's shell (the `sleep 1`).
- [ ] **Step 4: Open question 1 — the unlinked Codex panes** (read-only). For each herdr agent with
  `agent_status=blocked` or `agent=codex`: `herdr pane process-info --pane <id>` → foreground pids; then
  `ls -l /proc/<pid>/fd 2>/dev/null | grep -c rollout-` and the isolated `agentglass --json --live --all-projects`
  (isolation variables inline) → is the session live? Record per pane: pid, rollout open yes/no, live yes/no.
  Expected: some Codex TUIs hold no rollout open (or a child does) → not linked today; Task 6 links them via
  `agent_session` + process-info. If they are linked today, note it; Task 6 is unchanged.
- [ ] **Step 5: Open question 2 — node-based agents.** If a Gemini/pi/OpenCode agent runs in the user's herdr:
  `herdr pane process-info --pane <id>` and compare its foreground pids with `agentglass --json --live` `pid` (isolated).
  Expected: the agent's root pid is among the foreground pids. Record the names herdr reports (`node-MainThread`, …).
  Task 2's `choosePid` matches by "agent root pid of a harness", not by name, so names do not matter; a `Ruling:` only
  if the root pid is **not** among them (then use the first foreground pid whose root is an agent root).
- [ ] **Step 6:** No commit. PR description gets a "Task 0" block with the findings.

---

### Task 1: Multiplexer port; tmux and none adapters; call sites through the port

Runs in parallel with Task 2 (branch `feat/mux-herdr-t1` from `feat/mux-herdr` after Task 0).

**Files:** Create `src/mux/types.ts`, `src/mux/tmux.ts`, `src/mux/none.ts`, `src/mux/index.ts`, `src/mux/index.check.ts`.
Modify `src/model/procs.ts` (drop `tmuxByTty` `:25`, the pane block in `refreshSlow` `:183-186`, `SLOW.tmuxAt/noPane`
and `readPanes` `:191-199`, `paneTitles`/`tmuxTargetNow`/`tmuxTarget` `:272-288`; keep `ttyOf`), `src/actions.ts`
(`sendTmux` `:72-78` moves to `tmux.ts`; `sendPrompt` `:89-94`, `resume` `:116-121` through the port),
`src/input.ts` (`:8-9`, `:56`, `:180-186`), `src/features/watchdog.ts` (`:8`, `:45-63`, `:123`, `:134`),
`src/features/cli.ts:301`, `src/ui/list.ts` (`:9`, `:76`, `:154`), `src/ui/procs.ts` (`:8`, `:56-57`).

**Interfaces — Produces** (`src/mux/types.ts`):

```ts
// one agent's pane as its terminal multiplexer reports it
export interface MuxPane {
  kind: string;   // "tmux" | "herdr" | "none"
  id: string;     // the address the multiplexer takes: tmux "work:1.0", herdr "w7:p1A"; "" for none
  term: string;   // a key that survives moves: herdr terminal_id, tmux the pane tty
  server: string; // herdr API socket path; "" for tmux
  ws: string;     // herdr workspace label ("" unknown / tmux)
  tab: string;    // herdr tab label ("" unknown / tmux)
  status: string; // herdr agent_status idle|working|blocked|done|unknown; "" = not reported (tmux, none)
  at: number;     // epoch ms the status was read (0 = never)
}
export interface MuxProc { pid: number; h: string; tty: string } // agent root process: harness id, tty device ("" none)
export interface MuxLink { pid: number; key: string; path: string } // exact pid ↔ session: key "<h>:<id>" or a session file path
export interface Mux {
  id: string; label: string;
  present: (now: number) => boolean; // cheap: env, file existence, cached lookups; never spawns
  // slow job: map agent processes to panes; force = re-read now (actions, one-shot commands); known(key, path) = the
  // exact pid agentglass already has for that session (registry, open transcript), 0 none; true = the map changed
  refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number) => boolean;
  paneOf: (pid: number) => MuxPane | null;
  paneOfSession: (key: string, path: string) => MuxPane | null;
  links: () => MuxLink[];
  title: (p: MuxPane, look: number) => string;   // the pane's terminal title, read at most once per look id ("" none)
  status: (p: MuxPane, due: boolean, look: number, now: number) => string; // re-read when due (≤ 1 read per server per look); the last reading otherwise
  send: (p: MuxPane, msg: string) => void;       // shows its own toast(s)
  focus: (p: MuxPane) => void;                   // shows its own toast
}
```

`src/mux/index.ts`:

```ts
export const NONE_PANE: MuxPane;                                    // kind "none", all "" / 0
export const MUXES: Mux[];                                          // precedence order: [tmux] now, [tmux, herdr] after Task 3
export function muxOf(kind: string): Mux;                           // "none" (and unknown) → the none adapter
export function muxRefresh(ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean; // keeps ps + known for paneNow
export function paneOfPid(pid: number): MuxPane;                    // first present adapter that claims it, else NONE_PANE
export function paneOfSess(s: Sess): MuxPane;                       // s.pid → paneOfPid; else each adapter's paneOfSession(s.h + ":" + s.id, s.path)
export function paneNow(s: Sess): MuxPane;                          // muxRefresh(last ps, now, true, last known), then paneOfSess
export function paneNowPid(pid: number): MuxPane;
export function sendTo(p: MuxPane, msg: string): void;              // muxOf(p.kind).send
export function focusOn(p: MuxPane): void;
export function muxLinks(): MuxLink[];                              // all adapters' links, in precedence order
export function muxSig(): string;                                   // links as "pid key path\n"…: linkSig input
export interface MuxLook { title: (p: MuxPane) => string; status: (p: MuxPane, due: boolean) => string }
export function muxLook(now: number): MuxLook;                      // a new look id (named apart from the watchdog's looker())
export function sharedMuxLook(now: number): MuxLook;                // the same look for 1000 ms (one-shot callers: H.complete, approvalOf)
export function muxReset(): void;                                   // checks: forget ps/known/looks
export function setMuxes(ms: Mux[]): void;                          // checks: replace the adapters (MUXES keeps its identity)
```

Adapter behavior (`tmux.ts`, moved code, same semantics): `present` = true (tmux absent → `list-panes` returns "" as
today); `refresh` re-reads `tmux list-panes -a -F "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"` when
forced, 30 s after the last read, or when a proc's tty is neither mapped nor in the no-pane set (today's
`procs.ts:183-198`); `paneOf(pid)` by the tty of that pid from the last `ps`; `paneOfSession` → null; `links` → [];
`title` reads `#{pane_tty}\t#{pane_title}` once per look id; `status` → ""; `send` = today's `sendTmux`; `focus` =
`switch-client -t <id>` + "switched to <id>" inside tmux (`process.env.TMUX`), else warn
"not inside tmux — attach with: tmux a -t <id>". `none.ts`: `present` true, claims nothing; `send` warns
"session is live outside tmux — cannot inject input safely"; `focus` warns "not running in tmux" (Task 4 rewords both).

- [ ] **Step 1: Failing check** `src/mux/index.check.ts` with two stub adapters pushed into `MUXES` (export a test seam
  `setMuxes(ms: Mux[]): void`): stub A claims pid 10 (`kind "tmux"`, id `a:1.0`), stub B claims pids 10 and 20
  (`kind "herdr"`) and session key `claude:S2`, links `[{pid: 20, key: "claude:S2", path: ""}]`.
  Assert: `paneOfPid(10).kind === "tmux"` (precedence); `paneOfPid(20).kind === "herdr"`; `paneOfPid(30).kind === "none"`;
  a `Sess` with `pid 0, h "claude", id "S2"` → `paneOfSess(...).kind === "herdr"`; `paneNow` calls B's `refresh` with
  `force === true` (counter); `muxSig()` changes when B's link changes; `muxLook(1).title` calls the adapter with the
  same look id for two panes and a new id for `muxLook(2)`; `sharedMuxLook(1000)` and `sharedMuxLook(1500)` share one
  id, `sharedMuxLook(2100)` gets a new one; `sendTo(NONE_PANE, "x")` sets `S.toastKind === "warn"`.
  Ends `console.log(bad ? bad + " failed" : "mux: all checks passed"); if (bad) process.exit(1);`.
- [ ] **Step 2: Run** `scriptc build src/mux/index.check.ts -o ~/.cache/agentglass-agents/<you>/mc && ~/.cache/agentglass-agents/<you>/mc`.
  Expected: build FAIL (module missing).
- [ ] **Step 3: Implement** the four modules. `procs.ts`: `refreshSlow` calls
  `muxRefresh(rootsAsMuxProcs(), now, false, known)` where `rootsAsMuxProcs` maps `procs` to
  `{pid, h, tty: OS.ttyDevice(p.tty)}` and `known(key, path)` = `registry.get(key)?.pid ?? filePid.get(path) ?? 0`
  (pid only if `allProcs.has`), called where the pane block stood (`:183-186`). Call sites:
  `sendPrompt` live branch → `const p = paneNow(s); if (p.kind === "none") { say("warn", "session is live outside tmux — cannot inject input safely"); return; } sendTo(p, msg);`;
  `resume` live branch → `const p = paneNow(s); if (p.kind === "none") say("warn", "already running (pid " + s.pid + ")"); else focusOn(p);`;
  `input.ts:56` → `const p = procAt(S.psel); if (p && v.trim()) sendTo(paneNowPid(p.pid), v);`;
  `input.ts:181-184` → `const t = p ? paneNowPid(p.pid) : NONE_PANE; … else if (t.kind !== "none") ask("send to " + t.kind + " " + t.id, "sendpane", ""); else say("warn", "no session linked and not in tmux");`;
  `input.ts:186` → `const p = procAt(S.psel); if (p) focusOn(paneNowPid(p.pid));`;
  `watchdog.ts` `observe(s, kids, lk: MuxLook)`: `const p = paneOfSess(s); const title = at && p.kind === "tmux" ? lk.title(p) : undefined;` (rest unchanged);
  `Looker` becomes `{ kids, look: MuxLook }` (`looker()` → `{ kids: kidsMap(), look: muxLook(Date.now()) }`);
  `approvalOf`/`H.complete` use `sharedMuxLook(Date.now())`; `cli.ts:301` unchanged in shape (calls the watchdog's
  `looker()`); `ui/list.ts:154` → `const t = paneOfPid(s.pid); … (t.kind === "tmux" ? " · tmux " + t.id : "")`,
  `:76` key part `paneOfPid(s.pid).id`; `ui/procs.ts:56-57` likewise.
- [ ] **Step 4: Run** the check → `mux: all checks passed`; `CHECK_JOBS=4 sh scripts/check.sh` → all `ok`
  (`watchdog.check.ts` unchanged: it calls `approvalWait`/`approvalGuess` with literal `Obs`).
- [ ] **Step 5: Manual tmux regression** (isolation variables inline, inside a tmux session you start, killed by name
  after): `s` on a fake live session in a tmux pane types the text and Enter; `a` in Processes switches; `R` on it
  switches. Expected: as on `main`.
- [ ] **Step 6: Commit** `refactor(mux): multiplexer port with tmux and none adapters`.

---

### Task 2: herdr parsing and decision rules (pure)

Runs in parallel with Task 1 (branch `feat/mux-herdr-t2`). No imports from `src/mux/types.ts` (own types).

**Files:** Create `src/mux/herdr-parse.ts`, `src/mux/herdr-parse.check.ts`.

**Interfaces — Produces:**

```ts
export interface HAgent { pane: string; term: string; ws: string; tab: string; label: string; status: string; sKind: string; sVal: string }
export interface HList { ok: boolean; agents: HAgent[] }               // ok false = not the expected JSON
export function parseAgents(text: string): HList;                     // result.agents[]; entries without pane_id or terminal_id skipped
export function parseLabels(text: string, list: string, idKey: string): Map<string, string>; // ("workspaces","workspace_id") / ("tabs","tab_id") → id → label
export function parseProcInfo(text: string): number[];                // result.process_info.foreground_processes[].pid, in order; [] on any mismatch
export interface HErr { code: string; message: string }
export function parseError(text: string): HErr;                       // {"error":{code,message}} anywhere in text; {"",""} none
export function parseVersion(text: string): string;                   // the "version: X" line of `status server`, "" none
export function versionAtLeast(v: string, min: string): boolean;      // numeric per dot part; "" → false
export const HARNESS_LABELS: string[];                                // ["claude","codex","gemini","opencode","pi","kiro"]
export interface HRef { key: string; path: string }
export function sessRef(label: string, kind: string, value: string): HRef; // id → {label+":"+value,""}, path → {"",value}; label not in HARNESS_LABELS or empty value → {"",""}
export function choosePid(fg: number[], harnessOfRoot: (pid: number) => string, label: string): number; // first fg pid whose root harness === label; else first with any harness; else 0
export function pollDue(quietMs: number, busy: boolean, hidden: boolean, wasBlocked: boolean, sinceLastMs: number): boolean;
export function fresh(at: number, mtime: number): boolean;            // at > 0 && at >= mtime
export function placeLabel(ws: string, tab: string, id: string, redact: boolean): string; // "webapp › 2 · w7:p1A"; redact or no labels → "w7:p1A"
export interface Outcome { kind: string; text: string }               // toast kind ok|warn|err
export function sendOutcome(exit: number, errText: string, place: string): Outcome;
export function envHerdr(block: Uint8Array): { sock: string; pane: string }; // only these two values; everything else discarded
```

Rules: `pollDue` = `wasBlocked || (quietMs >= 3000 && (busy || hidden) && sinceLastMs >= (quietMs < 60000 ? 1400 : 6000))`
(1400 < the 1.5 s look). `sendOutcome`: exit 0 → `ok "sent to herdr " + place`; codes `agent_blocked` →
`warn "the agent waits at a dialog — answer it there (R jumps to the pane)"`; `agent_not_ready` →
`warn "the agent is not in its pane's foreground — nothing sent"`; `agent_not_found` → `warn "the herdr pane is gone"`;
`server_not_running` → `err "herdr server not running"`; other/none → `err "herdr: " + message (≤ 100 chars) || "send failed (exit N)"`.

- [ ] **Step 1: Failing check** `src/mux/herdr-parse.check.ts` (fixtures are herdr 0.9.1 shapes with fake values):

```ts
import { parseAgents, parseLabels, parseProcInfo, parseError, parseVersion, versionAtLeast, sessRef, choosePid, pollDue, fresh, placeLabel, sendOutcome, envHerdr } from "./herdr-parse.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const AL = '{"id":"cli:agent:list","result":{"agents":[' +
  '{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"S1"},"agent_status":"blocked","cwd":"/w","focused":false,"pane_id":"w7:p1A","tab_id":"w7:t6","terminal_id":"term_a","workspace_id":"w7"},' +
  '{"agent":"pi","agent_session":{"agent":"pi","kind":"path","source":"herdr:pi","value":"/h/.pi/s.jsonl"},"agent_status":"idle","pane_id":"w2:p1","tab_id":"w2:t1","terminal_id":"term_b","workspace_id":"w2"},' +
  '{"agent":"amp","agent_status":"working","pane_id":"w2:p2","tab_id":"w2:t1","terminal_id":"term_c","workspace_id":"w2"},' +
  '{"agent":"claude","agent_status":"idle","tab_id":"w2:t1","workspace_id":"w2"}],"type":"agent_list"}}';
const l = parseAgents(AL);
ok("ok + 3 entries (no pane id skipped)", l.ok && l.agents.length === 3, String(l.agents.length));
ok("fields", l.agents[0]?.pane === "w7:p1A" && l.agents[0]?.term === "term_a" && l.agents[0]?.status === "blocked" && l.agents[0]?.sVal === "S1", JSON.stringify(l.agents[0]));
ok("garbage → not ok", !parseAgents("<html>").ok && !parseAgents('{"result":{}}').ok, "");
ok("labels", parseLabels('{"result":{"workspaces":[{"workspace_id":"w7","label":"webapp"}],"type":"workspace_list"}}', "workspaces", "workspace_id").get("w7") === "webapp", "");
ok("proc info", parseProcInfo('{"result":{"process_info":{"foreground_processes":[{"pid":11,"name":"claude"},{"pid":12,"name":"npm"}],"pane_id":"w7:p1A","shell_pid":9}}}').join(",") === "11,12", "");
ok("error", parseError('{"error":{"code":"agent_blocked","message":"agent w1:p1 is blocked"},"id":"cli:agent:prompt"}').code === "agent_blocked", "");
ok("error none", parseError("").code === "", "");
ok("version", parseVersion("status: running\nversion: 0.9.1\nendpoint_compatible: yes\n") === "0.9.1", "");
ok("version cmp", versionAtLeast("0.8.2", "0.8.2") && versionAtLeast("0.10.0", "0.8.2") && !versionAtLeast("0.8.1", "0.8.2") && !versionAtLeast("", "0.8.2"), "");
ok("ref id", sessRef("claude", "id", "S1").key === "claude:S1", "");
ok("ref path", sessRef("pi", "path", "/h/.pi/s.jsonl").path === "/h/.pi/s.jsonl", "");
ok("ref unknown label", sessRef("amp", "id", "X").key === "" && sessRef("claude", "id", "").key === "", "");
const roots = new Map<number, string>([[11, "claude"], [13, "codex"]]);
const hr = (pid: number): string => roots.get(pid) ?? "";
ok("pid by label", choosePid([12, 13, 11], hr, "claude") === 11, "");
ok("pid any harness", choosePid([12, 13], hr, "claude") === 13, "");
ok("pid none", choosePid([12], hr, "claude") === 0, "");
ok("due: log moving", !pollDue(2900, true, false, false, 99999), "");
ok("due: quiet busy", pollDue(3000, true, false, false, 1500), "");
ok("due: once per look", !pollDue(3000, true, false, false, 1000), "");
ok("due: idle, not hidden", !pollDue(9000, false, false, false, 99999), "");
ok("due: idle, hidden (gemini)", pollDue(9000, false, true, false, 1500), "");
ok("due: backoff after 60 s", !pollDue(60000, true, false, false, 3000) && pollDue(60000, true, false, false, 6000), "");
ok("due: blocked re-read", pollDue(100, false, false, true, 0), "");
ok("fresh", fresh(2000, 1999) && fresh(2000, 2000) && !fresh(1999, 2000) && !fresh(0, 0), "");
ok("place", placeLabel("webapp", "2", "w7:p1A", false) === "webapp › 2 · w7:p1A", placeLabel("webapp", "2", "w7:p1A", false));
ok("place redact", placeLabel("webapp", "2", "w7:p1A", true) === "w7:p1A", "");
ok("place no labels", placeLabel("", "", "w7:p1A", false) === "w7:p1A", "");
ok("send ok", sendOutcome(0, "", "webapp › 2").kind === "ok", "");
ok("send blocked", sendOutcome(1, '{"error":{"code":"agent_blocked","message":"m"}}', "x").text.indexOf("dialog") >= 0, "");
ok("send other", sendOutcome(3, "", "x").text === "send failed (exit 3)", sendOutcome(3, "", "x").text);
const env = new TextEncoder().encode("PATH=/bin\u0000ANTHROPIC_API_KEY=SECRET\u0000HERDR_PANE_ID=w7:p1A\u0000HERDR_SOCKET_PATH=/h/.config/herdr/herdr.sock\u0000");
const e = envHerdr(env);
ok("env two values", e.pane === "w7:p1A" && e.sock === "/h/.config/herdr/herdr.sock", JSON.stringify(e));
ok("env nothing else", JSON.stringify(e).indexOf("SECRET") < 0, "");
console.log(bad ? bad + " failed" : "herdr-parse: all checks passed");
if (bad) process.exit(1);
```

- [ ] **Step 2: Run** `scriptc build src/mux/herdr-parse.check.ts -o ~/.cache/agentglass-agents/<you>/hp && ~/.cache/agentglass-agents/<you>/hp`. Expected: build FAIL.
- [ ] **Step 3: Implement** with `parse`/`obj`/`arr`/`str` from `src/util/json.ts`; `envHerdr` scans the bytes for
  `\0`-separated entries, decodes only an entry starting with one of the two names. No regex tables.
- [ ] **Step 4: Run** → `herdr-parse: all checks passed`; `CHECK_JOBS=4 sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(mux): herdr CLI parsing and decision rules`.

---

### Task 3: herdr adapter, fake herdr, hermetic checks

Sequential, after Tasks 1 and 2 are merged into `feat/mux-herdr`.

**Files:** Create `src/mux/herdr.ts`, `src/mux/herdr.check.ts`, `testdata/herdr/fake-herdr.sh`. Modify
`src/mux/index.ts` (`MUXES = [tmux, herdr]`), `scripts/check.sh` (`run_check` env `:29-32`, shell-test env `:69`).

**Interfaces — Produces:** `export const herdr: Mux` and `export function herdrReset(): void` (checks: forget binary,
sockets, maps, versions, skips). Internals (not exported): `bin()` per spec Design 2 (`AGENTGLASS_HERDR` `off`/`0` →
"", a path → it; config `section("mux")["herdr"] === "off"` → ""; own `HERDR_BIN_PATH` if it exists; `herdr` on
`PATH`, cached for the run); `sockets(now)` (`AGENTGLASS_HERDR_SOCKET` → exactly it; else own `HERDR_SOCKET_PATH`,
sockets learned from `envHerdr` of new pids (Linux), `$XDG_CONFIG_HOME/herdr/herdr.sock` or `~/.config/herdr/herdr.sock`,
`…/herdr/sessions/*/herdr.sock` listed every ≥ 30 s; kept when `existsSync`); `call(server, args)` =
`execFileSync(bin, args, {encoding: "utf8", stdio: ["ignore","pipe","ignore"], timeout: 4000, env: childEnv(server)})`
with `childEnv` = the process environment with `HERDR_SOCKET_PATH = server` and without `HERDR_SESSION`; failure →
server skipped 60 s. Config value other than `"auto"`/`"off"` → one startup toast "config mux.herdr must be auto or off
— using auto".

Behavior: per spec Design 2–3, 6–7 (send/focus land in Task 4 but the adapter's `send`/`focus` members are written
here, Task 4 wires call sites and wording):
- `present(now)`: `bin() !== "" && sockets(now).length > 0`.
- `refresh(ps, now, force, known)`: new pids (not seen before) → on Linux `envHerdr(OS.envOf(pid))`: a pane value marks
  dirty and adds the socket; on macOS any new pid marks dirty. Due = force || dirty || now − last ≥ 30000. Per server:
  `agent list` (unparseable → skip 60 s + one toast per run "herdr: unexpected output from agent list"); labels via
  `workspace list`/`tab list` when an id is unknown or ≥ 30 s old; pid per `terminal_id` (cached): `known(ref.key,
  ref.path)` → else queue `pane process-info --pane <id>` → `choosePid(fg, harnessOfRoot, label)`; ≤ 8 process-info
  calls per refresh unless `force` (one-shot and actions: all); a cached pid not in `ps` → resolve again. Returns true
  when any pane id, pid, label or session ref changed.
- `paneOf(pid)`, `paneOfSession(key, path)` (several sessions with one id: the caller passes the one it has; the
  adapter answers by key), `links()` (`{pid, key, path}` for panes with pid and ref).
- `title` → "". `status(p, due, look, now)`: if `due` and this server was not read in this look → `agent list`, update
  `status`/`at` of every pane of that server; return the pane's `status`.
- `send(p, msg)`: version per server (`status server` once per socket mtime) `versionAtLeast(v, "0.8.2")` else warn
  "herdr <v or unknown> is too old to send safely (needs ≥ 0.8.2)"; one send per `term` at a time (else warn
  "still sending…"); `spawn(bin, ["agent","prompt",p.id,msg], {stdio: ["ignore","ignore", fd], env: childEnv(p.server)})`
  with `fd` an `openSync(~/.agentglass/tmp/herdr-send-<n>.err, "w")`, kill after 10 s (err "herdr send timed out"),
  on exit `sendOutcome(code, readText(err, 0, 4096), placeLabel(p.ws, p.tab, p.id, REDACT))` → `say`, delete the file.
- `focus(p)`: `call(p.server, ["agent","focus",p.id])` → ok "focused in herdr: " + place, else the parsed error message.

`testdata/herdr/fake-herdr.sh` (POSIX sh): data dir = `dirname "$HERDR_SOCKET_PATH"`; appends
`"$HERDR_SOCKET_PATH|$*"` to `$dir/calls.log`; answers `agent list`→`agent-list.json`, `workspace list`→
`workspace-list.json`, `tab list`→`tab-list.json`, `pane process-info --pane P`→`process-info-P.json`,
`status server`→`status.txt`, `agent prompt P TEXT`→ appends TEXT to `prompts.log` (after `sleep 0.3`), `agent focus P`
→ `{"result":{"type":"agent_focused"}}`; a file `fail-<name>` (name = the json base, `prompt`, `focus`) → its content on
stderr, exit 1.

- [ ] **Step 1: Hermetic `check.sh` first.** In `run_check` add `-u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID
  -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u HERDR_SESSION -u AGENTGLASS_HERDR_SOCKET` and
  `AGENTGLASS_HERDR=off`; same `-u` list and `AGENTGLASS_HERDR=off` on the shell-test `env` (`:69`). Run
  `CHECK_JOBS=4 sh scripts/check.sh` → all `ok`.
- [ ] **Step 2: Failing check** `src/mux/herdr.check.ts` (temp dir under `/tmp/agentglass-herdr-check-<pid>` like
  `http.check.ts`, removed at the end; copies `testdata/herdr/fake-herdr.sh` — read it with `readFileSync` relative to
  the repo, the check runs from the repo root — into the dir, `chmod 755`; `process.env["AGENTGLASS_HERDR"] = fake`,
  `process.env["AGENTGLASS_HERDR_SOCKET"] = dir + "/herdr.sock"` (an empty file)). Fixtures: the Task 2 `agent list`
  (3 panes), `workspace-list.json` (`w7` → `webapp`, `w2` → `scratch`), `tab-list.json` (`w7:t6` → `6`, `w2:t1` → `1`),
  `process-info-w2:p1.json` → pids `[31]`, `process-info-w2:p2.json` → `[]`, `status.txt` `version: 0.9.1`.
  The check's `harnessOfRoot` comes from the `ps` list it passes. Assertions:
  - `present` true; with `AGENTGLASS_HERDR=off` + `herdrReset()` → false and `calls.log` unchanged;
  - `refresh([{pid: 21, h: "claude", tty: ""}, {pid: 31, h: "pi", tty: ""}], now, false, known)` with
    `known("claude:S1", "") = 21`, else 0: pane `w7:p1A` gets pid 21 with **no** process-info call for it; `w2:p1`
    (pi, path ref) → one process-info call → pid 31; `w2:p2` (amp) → one call → no pid;
  - `paneOf(21).id === "w7:p1A"`, `.ws === "webapp"`, `paneOfSession("claude:S1", "").id === "w7:p1A"`;
  - `links()` contains `{pid: 21, key: "claude:S1", path: ""}` and `{pid: 31, key: "", path: "/h/.pi/s.jsonl"}`;
  - a second `refresh` 10 s later, nothing new → no new line in `calls.log`; at +30 s → one `agent list`;
  - a new pid → due at once; `force` → due at once;
  - cap: 12 unresolved panes → 8 process-info calls in one non-forced refresh, the rest next refresh; forced → all;
  - move: replace the fixture's `w7:p1A` by `w8:p3` with the same `terminal_id` → after a forced refresh
    `paneOf(21).id === "w8:p3"` and no new process-info call;
  - `fail-agent-list` containing `server_not_running` → refresh returns false, the server is skipped: a second refresh
    within 60 s makes no call;
  - every line of `calls.log` starts with `dir + "/herdr.sock|"` (no other server touched);
  - `status(p, true, 1, now)` twice with look 1 → one `agent list`; look 2 with `due=false` → no call;
  - `send` with `status.txt` `version: 0.8.1` → warn "too old", no prompt; with `0.9.1` → after 800 ms (`setTimeout`)
    `prompts.log` has the text and `S.toastKind === "ok"`; with `fail-prompt` = `agent_blocked` JSON → warn with
    "dialog"; two sends back to back → the second warns "still sending…";
  - `focus` → `calls.log` has `agent focus w7:p1A`, toast "focused in herdr: webapp › 6 · w7:p1A".
- [ ] **Step 3: Run** → build FAIL. **Step 4: Implement** `herdr.ts`, the fake, `MUXES = [tmux, herdr]`.
- [ ] **Step 5: Run** the check → `herdr: all checks passed`; `index.check.ts` still passes (it sets its own muxes);
  `CHECK_JOBS=4 sh scripts/check.sh` all `ok`.
- [ ] **Step 6: Commit** `feat(mux): herdr adapter over the herdr CLI; checks never reach a real herdr`.

---

### Task 4: Send and jump through the port; wording and keys

Parallel with 5, 6, 7 (branch `feat/mux-herdr-t4` from `feat/mux-herdr` after Task 3).

**Files:** Modify `src/mux/none.ts` (wording), `src/actions.ts` (`sendPrompt`, `resume`), `src/input.ts` (`:163`
prompt label, `:180-186`), `src/ui/help.ts:20,24`, `src/ui/footer.ts:45`, `src/features/palette/actions.ts:61-62`;
Test `src/mux/send.check.ts`, `src/ui/footer.check.ts` (one assertion).

Changes:
- none adapter: `send` warn "session is live outside tmux and herdr — cannot inject input safely"; `focus` warn
  "not in a tmux or herdr pane". Processes `s` without session and without pane: "no session linked and not in a
  tmux or herdr pane".
- `input.ts:163` label: `"send to " + s.h + (c !== s ? " parent" : "") + (s.pid ? " (" + (pk === "none" ? "live" : pk) + ")" : " (headless)")`
  with `pk = paneOfSess(s).kind` (no refresh: a label).
- Processes `s` for a process without a session: `ask("send to " + t.kind + " " + t.id, …)` — herdr shows the place
  label instead of the id when not redacted.
- Help: Sessions `["s", "send prompt (live: its tmux or herdr pane; else headless)"]`, `["R", "resume, or jump to the live agent's pane"]`;
  Processes `["s", "send prompt to the agent's pane"]`, `["a", "jump to the agent's pane (tmux, herdr)"]`.
  Footer Processes `k("a", "jump")`. Palette `proc.send` "Send prompt to the agent's pane…", `proc.attach`
  "Jump to the agent's pane" (ids unchanged: pinned palette history keeps working).
- README lines (for Task 7 to fold in): the "Talk back" bullet.

- [ ] **Step 1: Failing check** `src/mux/send.check.ts` with stub adapters (`setMuxes`): a live `Sess` whose pid the
  herdr stub claims → `sendPrompt` calls the stub's `send` once with the text and never the tmux stub; a pid both stubs
  claim → tmux (innermost); a pid nobody claims → toast "outside tmux and herdr"; `resume` on a herdr-claimed live
  session → stub `focus`; `resume` on an unclaimed live session → "already running (pid N)"; the stub's `refresh` saw
  `force === true` before `send`/`focus`. Help: a `HELP` (`src/ui/help.ts:10`) entry of the `processes` section reads
  "jump to the agent's pane (tmux, herdr)". Footer: add to `src/ui/footer.check.ts` an assertion with its `footer()`
  helper — `footer("list", 1, 160)` contains "a jump" and not "tmux".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass; `CHECK_JOBS=4 sh scripts/check.sh` all `ok`.
- [ ] **Step 5: Commit** `feat(mux): send and jump to herdr panes; neutral multiplexer wording`.

---

### Task 5: Approval from herdr's `blocked`

Parallel with 4, 6, 7 (branch `feat/mux-herdr-t5`).

**Files:** Modify `src/features/watchdog.ts` (`observe`), `src/features/detect.ts` (`Obs` `:87` gains
`askBy?: string`; `approvalWait` `:98-111`, `approvalNote` `:139-143`), `src/harness/types.ts:62-63` (comments),
`src/features/rules/notify.ts:84` (`lead()`); Test: extend `src/features/watchdog.check.ts`,
`src/features/rules/notify.check.ts` (a "herdr" hint adds no prefix).

Changes in `observe(s, kids, lk)`:

```ts
const p = paneOfSess(s); let known = false;
if (p.kind === "herdr") {
  const quiet = Date.now() - s.mtime; const busy = working(s);
  const due = pollDue(quiet, busy, !!h.hiddenApproval, p.status === "blocked" && fresh(p.at, s.mtime), Date.now() - p.at);
  const st = lk.status(p, due);
  if (st !== "" && fresh(p.at, s.mtime)) { known = true; asks = st === "blocked"; if (asks) askBy = "herdr"; }
}
```

`o.asks = asks`, `o.askBy`, `o.mayGuess = !!h.hiddenApproval && title === undefined && !known`. In `approvalWait`
the `asks` branch sets the tool to `pendingTool(o.evs) || "approval dialog"` and, for `askBy === "herdr"`,
`m.hint = "herdr"`; `approvalNote` returns `"approval dialog open" + (a.hint === "herdr" ? " (herdr)" : "")`; the
alert message renders `{tool}` as before plus " (herdr)" via the hint (check `lead()` in `rules/notify.ts:84`: a hint
other than "likely" is prefixed — keep "herdr" out of the prefix: `lead()` treats `"herdr"` like `""`).
`H.complete` (one-shot `--json`) passes `due = true` for herdr panes (one `agent list` per server per shared look).

- [ ] **Step 1: Failing checks** appended to `src/features/watchdog.check.ts` (stub herdr adapter via `setMuxes`, a
  live Claude `Sess` with `mtime = now - 5000`, busy, a pending tool call):
  - stub status `blocked`, `at = now` → `approvalWait(o, 2, 7, 5)` has `lv === 1` on the **first** look, `approvalNote`
    ends with "(herdr)";
  - `at = s.mtime - 1` (stale) → not asserted (`lv === 0`), the heuristic path decides (absent with < 7 CPU samples);
  - status `idle` fresh, Gemini session (hiddenApproval) → `o.mayGuess === false`;
  - log moving (`mtime = now - 1000`), not blocked → the stub's `status` was called with `due === false`;
  - two sessions on one stub server in one look → one stub read;
  - `H.complete` on a herdr session → `due === true`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass; `CHECK_JOBS=4 sh scripts/check.sh` all `ok`
  (existing watchdog/metrics/notify checks unchanged).
- [ ] **Step 5: Commit** `feat(watchdog): herdr's blocked state is the approval signal`.

---

### Task 6: Exact links from herdr's `agent_session`

Parallel with 4, 5, 7 (branch `feat/mux-herdr-t6`).

**Files:** Modify `src/model/procs.ts` (`linkSessions` `:216-246`, `linkSig` `:162-170`); Test: extend
`src/model/procs.check.ts` (or create `src/model/muxlink.check.ts` if `procs.check.ts` cannot stub muxes).

Changes:
- `linkSig` appends `muxSig()`.
- In `linkSessions`, after the registry/open-file loop: build `byKey` (`"<h>:<id>"` → the session with the newest
  mtime among those with that key, top-level only) and `byPath`; for each `muxLinks()` entry with
  `allProcs.has(pid)`: `s = l.key ? byKey.get(l.key) : sessions.get(l.path)`; if `s && !s.pid` →
  `const r = rootOf(l.pid); linkOne(s, r ? r.pid : l.pid, "open", "")` and add the pid to a `muxPids` set.
- `regPids` (the cwd stage's exclusion set) also takes `muxPids`.
- A pid tmux claims (`paneOfPid(pid).kind === "tmux"`) is skipped (innermost wins; Review Focus 3).

- [ ] **Step 1: Failing check**: two pi processes (pids 41, 42) in one cwd, two pi sessions A (older) and B (newer);
  the cwd heuristic alone links 42→B, 41→nothing or A by start order; a herdr stub links 41→B, 42→A (paths) → after
  `linkSessions`, `B.pid === 41`, `A.pid === 42`. A Claude session linked by registry to pid 51, herdr stub says
  pid 52 for the same key → stays 51. A Codex session with no registry and no open file, herdr links pid 61 → linked.
  A stub link for a pid the tmux stub claims → ignored. `muxSig` change → relink on the next `refreshProcs` (the
  link signature differs).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass; `CHECK_JOBS=4 sh scripts/check.sh` all
  `ok` (`link.check.ts` unchanged: `linkByCwd` itself does not change).
- [ ] **Step 5: Commit** `feat(procs): herdr's session ids link processes exactly, before the cwd heuristic`.

---

### Task 7: Display, `--json mux`, filter key `mux`, config, docs

Parallel with 4, 5, 6 (branch `feat/mux-herdr-t7`).

**Files:** Modify `src/ui/list.ts:154`, `src/ui/procs.ts:56-57`, `src/features/cli.ts` (`JSON_FIELDS` `:61-62`,
`jsonSess` `:172-183`, the `--json fields` help text), `src/main.ts` (import `./mux/attr.ts` next to the other
feature imports), `README.md`, `CHANGELOG.md`; Create `src/mux/attr.ts`, `src/mux/attr.check.ts`.

Changes:
- Preview: `kv("process", "pid " + … + muxPart(s))`, `muxPart` = `tmux` → `" · tmux " + id`; `herdr` →
  `" · herdr " + placeLabel(p.ws, p.tab, p.id, REDACT)`; none → "". Processes detail line likewise after the tty.
  The preview key at `list.ts:76` includes `p.kind + p.id + p.ws + p.tab` so a moved/renamed pane redraws.
- `--json`: `JSON_FIELDS` gets `"mux"` after `"status"`; `jsonSess` adds
  `mux: muxJson(s)` = `null` when `livePid(s) === 0` or kind `none`; else `{kind, pane: id, workspace: REDACT || !ws ? null : ws, tab: REDACT || !tab ? null : tab, status: kind === "herdr" && status ? status : null}`
  (subagents: the parent's pane). Help text `--json fields:` gains `mux{kind,pane,workspace,tab,status}` with
  "(null = no live process or not in tmux/herdr; workspace/tab null under --redact)".
- `src/mux/attr.ts`: `register({ key: "mux", aliases: [], ent: "session", type: "enum", multi: false, enumVals: ["tmux", "herdr", "none"], enumFn: "", ops: [] })`
  and `extend("mux", { sess: (s: Sess): Val => ({ n: 0, ss: [paneOfSess(owner(s)).kind], unk: false }), resolve: null })`
  (`owner` = the session itself or its parent, as `livePid` does).
- README: a "herdr" section under the live features (what works: send, jump, approval, exact links, `--json mux`,
  filter `mux`; herdr ≥ 0.8.2 for send; integrations give session ids (`herdr integration install claude|codex|…`);
  `mux.herdr: "off"`, `AGENTGLASS_HERDR`, `AGENTGLASS_HERDR_SOCKET`; the duplicate-bell recipe
  `{"rules": [{"id": "approval", "where": "mux is_not herdr"}, {"id": "waiting", "where": "mux is_not herdr"}]}` —
  verify the exact override shape against `agentglass rules defaults` before writing it); the "Talk back" bullet
  (Task 4's line); `approval_wait` row: "herdr's blocked state raises it at once". CHANGELOG "Unreleased": one entry.
- Config: `mux.herdr` documented in the config table of the README (key, values, default).

- [ ] **Step 1: Failing check** `src/mux/attr.check.ts` (stub muxes): `mux is herdr` selects the herdr-claimed live
  session, `mux is none` an ended one, a subagent follows its parent; `jsonSess` of a herdr session has
  `mux.kind === "herdr"`, `mux.workspace === null` under `AGENTGLASS_REDACT=1` (check.sh sets it); of an ended
  session `mux === null`; `JSON_FIELDS.indexOf("mux") === JSON_FIELDS.indexOf("status") + 1`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass; `CHECK_JOBS=4 sh scripts/check.sh` all `ok`
  (agent-mode and filter-cli shell tests: `--fields` lists and `filter` help gain `mux`; update their expected lines if
  they pin the full list).
- [ ] **Step 5: Commit** `feat(mux): show the pane in preview, Processes and --json; filter key mux`.

---

### Task 8: End to end with an isolated herdr, footprint, live QA

Sequential, after 4–7 are merged into `feat/mux-herdr`.

**Files:** Create `scripts/mux-herdr.test.sh`. Modify the PR description (measurements).

- [ ] **Step 1: Failing test** `scripts/mux-herdr.test.sh` (POSIX sh; `command -v herdr || { echo "mux-herdr: skipped (no herdr)"; exit 0; }`;
  `command -v python3` for the PTY like `open.test.sh`; temp dir under `${XDG_CACHE_HOME:-$HOME/.cache}/agentglass-test-<pid>`
  is **not** allowed in CI's hermetic HOME — use `mktemp -d` there; a socket path must stay < 100 bytes):
  1. Start the isolated server (Task 0 Step 3 recipe, `XDG_CONFIG_HOME=$t/cfg`), stand-in `claude` (dash copy),
     report `idle` + `agent_session` = the fake session id `A`.
  2. Fake HOME with a Claude transcript for `A` (cwd `$t/w`) and **no** registry file (the link must come from herdr).
  3. `AGENTGLASS_HERDR=$(command -v herdr) AGENTGLASS_HERDR_SOCKET=$t/cfg/herdr/herdr.sock "$AGENTGLASS_BIN" --json --live`
     (HOME = fake) → session `A` is live, `pid` = the stand-in's pid, `mux.kind == "herdr"`, `mux.pane == "w1:p1"`.
  4. TUI in a PTY (same env): select `A`, `s`, type `hello`, Enter → within 2 s `$t/recv.txt` contains `hello`;
     toast "sent to herdr".
  5. Report `blocked`; `s`, `x`, Enter → `recv.txt` unchanged, the screen shows "waits at a dialog"; the session row
     shows ◆ within 3 looks (≤ 5 s) after the transcript's last write is ≥ 3 s old.
  6. `R` → `H api snapshot` (or `H pane list`) reports `focused_pane_id` `w1:p1` after focusing it away first with a
     second pane.
  7. Cleanup trap: quit the TUI, `H server stop`, kill the server pid if alive, kill the stand-in by pid, `rm -rf $t`.
- [ ] **Step 2: Run** `AGENTGLASS_BIN=$PWD/agentglass sh scripts/mux-herdr.test.sh` → passes locally (with herdr
  installed); `CHECK_JOBS=4 sh scripts/check.sh` → `mux-herdr` `ok` (or `skipped` where herdr is absent, CI).
- [ ] **Step 3: Footprint.** With the isolated server: 32 panes with stand-in agents (`idle`, sessions reported),
  `scripts/footprint.sh`-style run of the TUI unfocused for 5 min, once with `AGENTGLASS_HERDR=off`, once pinned to the
  server; then one pane `working` with a transcript quiet for > 3 s. Expected: added CPU ≤ 0.1 % idle, ≤ 0.3 % with the
  quiet pane (spec Testing). Record both numbers and the `agent list` count from the server log in the PR.
- [ ] **Step 4: Live QA against the user's herdr, read-only**: TUI with isolation variables, `AGENTGLASS_HERDR` unset
  (auto). Check: preview of a herdr-hosted Claude session shows `herdr <ws> › <tab> · <pane>`; Processes shows the
  pane; `--json --live --all-projects` has `mux` for every herdr agent with a linked session; the Codex panes from
  Task 0 Step 4 are live. **Do not press `s`, `R` or `a` on the user's sessions.** `ls -la ~/.agentglass` unchanged.
- [ ] **Step 5: Commit** `test(mux): herdr end to end against an isolated server`; push; open the PR
  `feat/mux-herdr` → `main` with Task 0 findings, Task 8 measurements, and the spec link.
