# Live agents in herdr panes — spec

Status: **draft** (2026-10-06). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4).
Plan: [plan.md](plan.md).

## Goal
Sessions whose agent runs in a [herdr](https://github.com/herdrdev/herdr) pane get the same live actions as sessions in
tmux panes, through one multiplexer port that a later backend (zellij, wezterm, …) plugs into:
1. **Send** (`s`): the prompt goes to the agent through `herdr agent prompt`, which refuses while the agent waits at an
   approval or question dialog.
2. **Jump** (`R` on a live session, `a` in Processes): `herdr agent focus` moves herdr's attached clients to the pane.
3. **Approval signal**: herdr's `blocked` state raises the approval alert (◆) for every harness, within one alarm look
   after it is read, instead of the CPU heuristic's ≥ 20 s.
4. **Exact links**: herdr's `agent_session` (the agent's own session id or file, reported by herdr's official
   integrations) links a process to its session where agentglass guesses by cwd today (pi, OpenCode 1.x, Gemini) or
   links nothing.
5. **Where it runs**: preview, Processes and `--json` show the pane (`herdr webapp › 2 · w7:p1A`, `mux{…}`); a filter
   key `mux` selects by multiplexer.

No herdr polling per tick: the pane map is refreshed when agent processes change and every 30 s, statuses are read only
while an approval can be pending.

## Why (user value)
- On this machine all 32 running agents live in herdr panes. For every one of them `s` says "session is live outside
  tmux — cannot inject input safely", `R` says "already running", and approvals are guessed from CPU samples (or, for
  Gemini, not seen at all outside tmux). herdr already knows each pane's agent, its state and its session id.
- herdr's `blocked` is the agent's real dialog state, read from its screen by herdr. The heuristic needs ≥ 20 s and a
  quiet process tree, and it misses dialogs while an MCP server or subagent keeps the tree busy.
- In the live check (below) the two agents herdr reported `blocked` were Codex sessions that agentglass did not show as
  live at all. herdr's `agent_session` gives the exact pid ↔ session pair.
- tmux lock-in: send/jump/approval are coded against tmux in four modules. A port makes the next multiplexer one adapter.

## Today (current code, with path:line refs)
- **Send**: `sendPrompt` (`src/actions.ts:86-112`) resolves a live session's tmux target (`tmuxTargetNow`,
  `actions.ts:90`), else warns "session is live outside tmux — cannot inject input safely" (`actions.ts:91`);
  `sendTmux` (`actions.ts:72-78`) types the text with `tmux send-keys -l` and sends Enter 400 ms later. A session without
  a process goes headless (`actions.ts:95-111`). Processes tab: `s` sends to the pane of a process without a session
  (`src/input.ts:180-185`, input action `sendpane`, `input.ts:56`).
- **Jump**: `resume` (`actions.ts:113-121`) runs `tmux switch-client` for a live session inside tmux, else "already
  running (pid …)". Processes tab `a` does the same (`input.ts:186`). Footer "a attach tmux" (`src/ui/footer.ts:45`),
  help (`src/ui/help.ts:20,24`), palette entries `proc.send`/`proc.attach` (`src/features/palette/actions.ts:61-62`).
- **Pane map**: `readPanes` (`src/model/procs.ts:192-199`) runs `tmux list-panes -a` keyed by pane tty
  (`tmuxByTty`, `procs.ts:25`), from the slow job when an agent sits on an unknown tty or every 30 s
  (`procs.ts:183-186`), and right before an action (`tmuxTargetNow`, `procs.ts:283`). `tmuxTarget` (`procs.ts:284-288`)
  feeds the preview's process line (`src/ui/list.ts:154`) and the Processes detail (`src/ui/procs.ts:56-57`).
- **Approval**: `observe` (`src/features/watchdog.ts:45-56`) reads tmux pane titles lazily, once per look
  (`looker`, `watchdog.ts:57-62`, `paneTitles` `procs.ts:273-280`), only for harnesses with `approvalTitle` (Gemini,
  `src/harness/gemini.ts:417`); `Obs.asks` (`src/features/detect.ts:87`) then asserts the approval level at once
  (`approvalWait`, `detect.ts:98-111`, `lv = 1`). Without a title, Gemini falls back to `approvalGuess`
  (`detect.ts:148-155`, `mayGuess`), every other harness to the CPU heuristic (open call > 20 s, tree < 2 % over 7
  samples). `HarnessAdapter.approvalTitle`/`hiddenApproval` (`src/harness/types.ts:62-63`) are worded for tmux.
- **Linking**: `linkSessions` (`procs.ts:216-246`): registry (Claude, Kiro, OpenCode daemon), open transcript (Codex,
  fx), then process cwd ↔ newest session (`linkByCwd`, `src/model/link.ts`) for `liveCwd` harnesses (pi, OpenCode 1.x,
  Gemini: `src/harness/pi.ts:311`, `opencode.ts:469`, `gemini.ts:423`).
- **Process environment**: `Platform.envOf` (`src/platform/types.ts:37`) reads `/proc/<pid>/environ` on Linux
  (`src/platform/linux.ts:94`); macOS returns nothing (`src/platform/darwin.ts:27`).
- **`--json`**: `jsonSess` (`src/features/cli.ts:172-183`) has `live`, `pid`, `status`; no multiplexer field.
  `JSON_FIELDS` `cli.ts:61-62`.
- **Tests**: `scripts/check.sh:27-33` runs checks with a temp HOME but passes `HERDR_*` through; inside a herdr pane
  every check inherits `HERDR_SOCKET_PATH` of the user's real server.

### Measured (2026-10-06, this machine, herdr 0.9.1, 32 agents in 19 workspaces)
| What | Result |
|---|---|
| `herdr agent list` | 17.4 KB JSON; from a scriptc probe (`execFileSync` + `JSON.parse`, 100 calls): 2.3–3.1 ms wall per call; CPU 1.45 ms per call (agentglass + herdr client) plus ≈ 0.7 ms in the herdr server (500 calls: 36 server ticks above its idle baseline) |
| `herdr api snapshot` | 57.7 KB (agents + panes + tabs + workspaces); same cost class — not used (see Decision 2) |
| `herdr agent focus`, `herdr pane process-info --pane` | 5–6 ms each |
| `herdr agent prompt` | **306 ms**, constant (herdr waits before Enter) — must not run on the UI thread |
| Agents with `agent_session` | 29 of 32 (Claude, Codex); kinds `id`; pi reports kind `path` |
| `herdr agent list` statuses | 23 idle, 5 done, 2 blocked, 2 working |
| agentglass `--json --live --all-projects` vs herdr | the 2 `blocked` agents (Codex) were **not live** in agentglass; 0 herdr agents had `attention` |
| Agent process environment (Linux) | every agent in a herdr pane carries `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH` |
| Pane move across workspaces (isolated server) | public pane id changed `w1:p1` → `w2:p2`; the agent's `HERDR_PANE_ID` stayed `w1:p1`; `terminal_id` and `agent_session` stayed |
| `agent prompt` on a pane reported `blocked` | `{"error":{"code":"agent_blocked",…}}` on stderr, exit 1, nothing typed |
| `agent prompt` with `$HOME`, backticks, quotes, `ü €` | delivered literally, followed by Enter |
| no server at the socket | exit 1, error code `server_not_running` |

Send/focus/blocked were exercised only against an isolated herdr server (own `XDG_CONFIG_HOME`, own socket, a stand-in
agent process), never against the user's panes.

## Design

### 1. The multiplexer port (`src/mux/`)
Same shape as the platform port (`src/platform/types.ts` + one adapter per OS) and the harness adapters
(`src/harness/types.ts` + `index.ts`):

- `src/mux/types.ts` — the port:
  - `MuxPane { kind, id, term, server, ws, tab, status, at }`: `kind` `tmux` | `herdr` | `none`; `id` the address the
    multiplexer takes (tmux `work:1.0`, herdr public pane id `w7:p1A`); `term` a key that survives moves (herdr
    `terminal_id`, tmux the pane tty); `server` the herdr API socket (`""` for tmux's default server); `ws`/`tab` herdr
    workspace and tab labels (`""` unknown; tmux leaves them empty); `status` herdr `agent_status`
    (`idle|working|blocked|done|unknown`, `""` = not reported); `at` when `status` was read (epoch ms).
  - `MuxProc { pid, h, tty }`: an agent root process handed to `refresh`.
  - `MuxLink { pid, key, path }`: an exact pid ↔ session pair the multiplexer knows (`key` = `<harness>:<id>`, or `path`
    for a session reported as a file).
  - `Mux { id, label, present, refresh, paneOf, paneOfSession, links, title, status, send, focus }` (signatures in the
    plan, Task 1). `present(now)` is cheap (no spawn); `refresh(procs, now, force)` runs from the slow job;
    `title(p)` and `status(p, due, now)` are per-look reads for the watchdog; `send`/`focus` show their own toasts.
- `src/mux/tmux.ts` — today's tmux code moved behind the port, behavior unchanged (pane map by tty, 30 s / unknown-tty
  refresh, titles once per look, `send-keys -l` + delayed Enter, `switch-client` only inside tmux).
- `src/mux/herdr.ts` — the herdr adapter (2–5). Pure parsing and decisions live in `src/mux/herdr-parse.ts` (checks
  need no herdr).
- `src/mux/none.ts` — the null adapter: no panes; its `send`/`focus` give today's explanatory warnings, worded for both
  multiplexers ("session is live outside tmux and herdr — cannot inject input safely").
- `src/mux/index.ts` — `MUXES = [tmux, herdr]` in precedence order, `NONE_PANE`, and the functions the app calls:
  `paneOfPid(pid)`, `paneOfSess(s)` (pid first, then the session key), `paneNow(s)`/`paneNowPid(pid)` (forced refresh of
  the owning adapter first: actions), `muxRefresh(procs, now, force)`, `muxLinks()`, `muxSig()`, `sendTo(p, msg)`,
  `focusOn(p)`, `muxLook(now)` / `sharedMuxLook(now)` for the watchdog.

**Precedence: the innermost multiplexer owns the agent.** tmux claims a pid by its tty (exact: the tty is the tmux
pane's pty); herdr claims by `agent_session` or by `pane process-info`. tmux inside a herdr pane: the agent's tty belongs
to tmux, and herdr would only see the tmux client in its foreground — tmux wins. herdr inside tmux: the agent's tty is
herdr's pty, tmux does not know it — herdr wins. So `paneOfPid` asks tmux first, then herdr.

### 2. herdr detection (no spawn when herdr is absent)
- **Binary**: `AGENTGLASS_HERDR` (`off`/`0` disables; else a path), else config `mux.herdr` = `"off"` disables, else
  `HERDR_BIN_PATH` from agentglass's own environment when the file exists, else `herdr` found on `PATH` (a directory
  walk, cached for the run). None → the adapter is absent; nothing else happens.
- **Servers** (API sockets), unless `AGENTGLASS_HERDR_SOCKET` pins exactly one (tests, a user who wants one session):
  agentglass's own `HERDR_SOCKET_PATH`; `HERDR_SOCKET_PATH` from each new agent process's environment (Linux,
  `OS.envOf`, read once per pid; only the values of `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are kept, the block is
  dropped at once); the default `$XDG_CONFIG_HOME/herdr/herdr.sock` (else `~/.config/herdr/herdr.sock`, both OSes); named
  sessions `…/herdr/sessions/*/herdr.sock` (directory listed at most every 30 s). A socket counts when the file exists.
- `present()` = binary and ≥ 1 socket. A server whose call fails (`server_not_running`, exit ≠ 0, timeout 4 s) is
  skipped for 60 s.
- A pid whose environment has `HERDR_PANE_ID` marks the herdr map dirty (a new herdr-hosted agent: refresh this slow
  pass). On macOS (no environment) a new agent root pid marks it dirty while a server is present.

### 3. The pane map (refresh)
From the slow job (`refreshSlow`), before `linkSessions`. Due when forced (an action, a one-shot command), when dirty
(2), or 30 s after the last one. Per server:
1. `herdr agent list` → one entry per agent pane: `pane_id`, `terminal_id`, `workspace_id`, `tab_id`, `agent` (label),
   `agent_status`, `agent_session{kind,value}`.
2. `herdr workspace list` and `herdr tab list` when an entry names a workspace/tab id not known yet, else every 30 s
   (labels for display).
3. **pid of each pane**, cached by `terminal_id` (stable across moves; Measured):
   a. the pane's `agent_session` resolves to a session that already has an exact pid (registry or open transcript,
      passed in as `known(key, path)`) → that pid, no spawn;
   b. else `herdr pane process-info --pane <id>` → the first foreground process that is an agent root of a harness
      equal to the pane's label (any harness when the label is not one of agentglass's) → its root pid. At most 8 such
      calls per pass in the TUI (≈ 50 ms), the rest next pass; unlimited in one-shot commands;
   c. a cached pid that is gone (agent restarted in the pane) is resolved again.
   `HERDR_PANE_ID` from the environment is **not** used as the pane address: it goes stale when a pane moves.
4. Session keys: herdr labels `claude`, `codex`, `gemini`, `opencode`, `pi`, `kiro` equal agentglass harness ids;
   `agent_session.kind = id` → key `<label>:<value>`, `kind = path` → the session file path. Other labels map to no
   harness (shown in Processes only when agentglass lists the process anyway).

`paneOfSession(key, path)` answers from 4; `paneOf(pid)` from 3. A session whose id exists twice (a resumed Claude
session copied into a second project dir) takes the copy with the newest mtime.

### 4. Exact links (`agent_session`)
`muxLinks()` returns `{pid, key, path}` for every herdr pane with both a pid (3) and a session reference (4).
`linkSessions` (`procs.ts:216`) applies them after the registry and open-transcript links and before `linkByCwd`:
- a session without a link gets the pane's pid (`linkOne(s, rootPid, "open", "")`);
- those pids are excluded from the cwd candidates (like registry pids), so `linkByCwd` cannot hand them another
  session; sessions linked this way count as owned;
- registry and open-transcript links stay as they are (both exact already); a disagreement between them and herdr is
  not acted on.
`linkSig` includes `muxSig()` (the links as text), so a changed link relinks on the next pass.

### 5. Approval from herdr's state
`muxLook(now)` gives the watchdog per look: `title(p)` (tmux: one `list-panes` per look, lazily, as today) and
`status(p, due, now)` (herdr: at most one `herdr agent list` per server per look, only when some caller passed
`due = true`; otherwise the last reading).
In `observe` for a session in a herdr pane:
- **due** (`pollDue` in `herdr-parse.ts`, pure): the last fresh reading was `blocked` (re-read every look until it
  clears), or the log has been quiet ≥ 3 s and (the session is busy, or its harness hides approvals
  (`hiddenApproval`)) — while quiet < 60 s every look (1.5 s), after that every 6 s. A session that writes its log is
  never due — an agent at a dialog does not write.
- A reading older than the session's last log write is stale (the user answered; the agent wrote) and counts as unknown.
- Fresh `blocked` → `Obs.asks = true`, `Obs.askBy = "herdr"`: `approvalWait` asserts the level at once (`lv = 1`), the
  message reads "approval dialog open (herdr)"; `stalledFor` stays absent as for titles. herdr's `blocked` also covers
  question dialogs; the alert is the same ("waiting for you").
- A fresh reading other than `blocked` → `asks = false` and `mayGuess = false` (herdr saw the screen; no Gemini guess).
- Unknown (not due, stale, server down) → today's behavior (CPU heuristic; Gemini's guess).
`HarnessAdapter.approvalTitle`/`hiddenApproval` comments say "its multiplexer pane's title" / "without a multiplexer that
reports dialogs". tmux keeps its title path unchanged.

**Cost**: one `agent list` ≈ 2.2 ms CPU (agentglass + herdr client + server). Worst case (a session quiet mid-turn for
< 60 s, every look): 0.15 % of one core; after 60 s: 0.04 %; refresh every 30 s: < 0.01 %. Nothing while every herdr
session writes its log or is idle. Within the tui-footprint budget (≤ 2 % unfocused, all in).

### 6. Send
`sendPrompt` for a live session: `p = paneNow(s)` (forced refresh of the owning adapter), then `sendTo(p, msg)`.
- **herdr**: the server version must be ≥ 0.8.2 (the release that refuses `agent_blocked` before typing; read once per
  server start from `herdr status server`, line `version: X` — the command exists since herdr 0.5.3; 0.9.1 prints
  `version: 0.9.1`); older, or no version line → warning "herdr X is too old to send safely (needs ≥ 0.8.2)", nothing
  sent. Else `herdr agent prompt <pane> <text>` is **spawned** (306 ms measured) with
  `HERDR_SOCKET_PATH=<server>`, stdout ignored, stderr to a file under `~/.agentglass/tmp/` read on exit (≤ 4 KB, then
  deleted). Exit 0 → "sent to herdr webapp › 2"; error code →
  - `agent_blocked` → warn "the agent waits at a dialog — answer it there (R jumps to the pane)";
  - `agent_not_ready` → warn "the agent is not in its pane's foreground — nothing sent";
  - `agent_not_found` → warn "the herdr pane is gone";
  - `server_not_running` → err "herdr server not running";
  - anything else → err "herdr: <message, ≤ 100 chars>".
  One send at a time per pane; a second `s` while one runs → warn "still sending…".
- **tmux**: unchanged (`send-keys -l`, Enter after 400 ms).
- **none**: unchanged headless path for a session without a process; a live session outside both → the none adapter's
  warning. The Processes tab's `sendpane` (a process without a session) uses `paneNowPid(pid)` the same way.

### 7. Jump
`R` on a live session and `a` in Processes: `focusOn(paneNow(...))`.
- **herdr**: `herdr agent focus <pane>` (sync, ~6 ms); "focused in herdr: webapp › 2". herdr ≥ 0.9.1 moves attached
  clients there; when agentglass itself runs in a pane of that server, focus leaves agentglass — that is the jump.
  Side effect: herdr marks a `done` agent as seen (a user action; accepted).
- **tmux**: unchanged (`switch-client` inside tmux, else "not inside tmux — attach with: tmux a -t …").
- **none**: "already running (pid N)" (`R`), "not in a tmux or herdr pane" (`a`).
Labels: footer `a jump` (was "attach tmux"); help `s` "send prompt (live: its tmux or herdr pane; else headless)", `R`
"resume, or jump to the live agent's pane", Processes `s` "send prompt to the agent's pane", `a` "jump to the agent's
pane (tmux, herdr)"; palette titles "Send prompt to the agent's pane…" / "Jump to the agent's pane".

### 8. Display, `--json`, filter
- Preview process line: `pid 123 · open · herdr webapp › 2 · w7:p1A` (tmux: `· tmux work:1.0`, unchanged). Processes
  detail: `tty /dev/pts/7  herdr webapp › 2 · w7:p1A`. Width: the label part is cut first (`fit`), the pane id stays.
- `--json`: new field `mux` after `status`: `null` (no live process, or neither multiplexer), else
  `{"kind":"tmux"|"herdr","pane":"…","workspace":"…"|null,"tab":"…"|null,"status":"…"|null}` (`status` = herdr's
  last reading). Additive; `--fields mux` works (cli-agent-mode). Help text lists it.
- Filter key `mux` (session, enum `tmux` | `herdr` | `none`; a subagent takes its parent's): `mux is herdr`,
  rules.json `where: "mux is_not herdr"` (drops agentglass's own approval/waiting alerts for herdr panes when herdr's
  bell is enough — README recipe).
- **--redact**: workspace and tab labels are user text (often customer or project names): the preview, Processes and
  toasts show only the pane id (`herdr w7:p1A`), `--json` has `workspace`/`tab` `null`.

### 9. Config
`~/.agentglass/config.json`: `"mux": {"herdr": "auto" | "off"}` (default `auto`; another value → `auto` and one
startup toast). Environment: `AGENTGLASS_HERDR` (`off` | path to the binary), `AGENTGLASS_HERDR_SOCKET` (only this
server). README: a "herdr" section (what works, versions, the opt-out, the duplicate-bell recipe).

### Failure modes
- herdr absent / binary missing / no socket: no spawn; everything as today.
- Server stopped or restarting (live handoff): calls fail → that server skipped for 60 s; panes keep their last map for
  display, actions force a refresh first and then report "herdr server not running".
- A pane moved: its `terminal_id` keeps the pid; the next refresh (30 s, or forced by the action) has the new pane id.
- An agent restarted in the same pane (new pid, same `terminal_id`): the cached pid is gone → resolved again (3c).
- Integration not installed (no `agent_session`): pid from `process-info` (3b); the session link then comes from
  agentglass's own linking.
- Older herdr: < 0.6.5 has no `agent_session` (pid path only); < 0.8.2 refuses send (6); < 0.9.1 focus may not move
  clients (the toast still says what was focused).
- JSON shape change in a future herdr: unparseable output → the server is treated as down for 60 s; one toast per run
  "herdr: unexpected output from `agent list`".
- `herdr agent prompt` hangs: killed after 10 s, err "herdr send timed out".
- Remote herdr (`--machine`, `--remote`): not handled; those agents run on another host and agentglass does not see them.

### Privacy
- The prompt text goes into `herdr agent prompt`'s argv (visible to the same user's `ps` for ~0.3 s), as it goes into
  `tmux send-keys`' argv today. It is the user's own text for their own agent; nothing else agentglass knows is sent.
- Process environments: only the values of `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are kept; no other variable is read
  into a kept structure, logged, cached or exported.
- Nothing is written to herdr in this phase (no metadata, no notifications). `--redact` hides workspace/tab labels (8).
- Child processes get `HERDR_SOCKET_PATH` set and inherit nothing else new.

## Interactions with other specs
- **tui-footprint**: the slow-job and watchdog cadences it set are the only places herdr is called; the cost is in 5.
  `scripts/footprint.sh` gains no herdr dependency; Task 8 measures with an isolated server.
- **macos-footprint**: replaces `ps`/`lsof` on macOS; this spec uses only `OS.ttyDevice` (tmux) and `OS.envOf`
  (empty on macOS, so herdr's pid ↔ pane link there always comes from `pane process-info`). No overlap in files.
- **adaptive-refresh**: statuses ride `H.onWatch` (1.5 s while agents are live); unfocused the procs pass halves
  discovery, the herdr refresh follows the slow job.
- **rules-config / filter-language**: `mux` is a session attribute (`register` + `extend`, `src/features/query/`);
  rules' `where` scopes can use it.
- **cli-agent-mode**: `mux` joins `JSON_FIELDS` (stable contract, additive).
- **command-palette**: entries renamed (7); `agentglass://open/<session>` is the deep link a Phase 2 herdr link handler
  opens.
- **redact**: labels hidden (8).
- Independent bug (separate small PR, not this spec): `agentglass open claude:<id>` reports "ambiguous" when the same
  session file exists under two Claude project dirs; this spec's join picks the newest copy and does not depend on it.

## Testing
- Pure checks (`src/mux/herdr-parse.check.ts`): `agent list` / `workspace list` / `tab list` / `process-info` / error
  JSON (shapes copied from herdr 0.9.1 with fake values) → entries, session keys (`id` and `path` kinds, unknown labels),
  pid choice from foreground processes, `pollDue` at its edges (2.9 s / 3 s quiet, 59 s / 60 s, busy/hidden/blocked),
  staleness against the log mtime, version compare (`0.8.1` < `0.8.2` ≤ `0.9.1`, `0.10.0`), error-code → message.
- Port checks (`src/mux/index.check.ts`) with stub adapters: precedence (tmux before herdr), `paneOfSess` (pid, then
  key), `none` messages, `muxSig` changes when a link changes.
- Adapter check (`src/mux/herdr.check.ts`) against a **fake herdr** (`testdata/herdr/fake-herdr.sh`: answers from JSON
  files, appends its argv and `HERDR_SOCKET_PATH` to a log): refresh cadence (30 s, dirty, forced), process-info cap,
  server skip after `server_not_running`, `AGENTGLASS_HERDR=off` and `AGENTGLASS_HERDR_SOCKET` spawn nothing else,
  send argv/env and outcome toasts per error code, one send at a time, focus argv.
- Watchdog check: a herdr `blocked` reading raises the approval alert on the first look with `lv = 1` and message
  "… (herdr)"; a stale reading does not; `mayGuess` false after a fresh non-blocked reading.
- Linking check: two pi processes in one cwd, herdr links them crosswise to the cwd guess → herdr's pairs win; a Claude
  registry link is not overridden.
- `scripts/check.sh` runs every check and test with `HERDR_*` unset and `AGENTGLASS_HERDR=off`; herdr tests set their
  own fake. No check ever reaches the user's herdr.
- End to end (`scripts/mux-herdr.test.sh`, skipped when `herdr` is not installed): an isolated herdr server (own
  `XDG_CONFIG_HOME`, own socket, `AGENTGLASS_HERDR_SOCKET` pins it), a stand-in agent binary named `claude` (a scriptc
  program that appends stdin lines to a file), a fake Claude session linked through herdr `agent_session`; asserts
  `--json --live` `mux`, TUI `s` delivers the line, `blocked` refuses with the toast, `R` focuses (herdr
  `focused_pane_id`), and the server is stopped by pid at the end.
- Footprint: TUI with 32 isolated herdr panes (stand-in agents) for 5 min unfocused, idle: added CPU ≤ 0.1 % vs herdr
  off; with one pane quiet mid-turn: ≤ 0.3 %.

## Out of scope
- Writing anything to herdr (metadata tokens, notifications): Phase 2.
- Remote herdr machines (`--machine`, `--remote`), herdr on Windows.
- herdr as a harness (it holds no transcripts).
- herdr's terminal title as an approval source (its `blocked` state supersedes it).
- zellij/wezterm adapters (the port is shaped for them; no code).

## Phase 2 (follow-up, separate repo `agentglass-herdr`; not in the plan)
A herdr plugin (herdr ≥ 0.7.5, Linux + macOS, no daemon), installable with `herdr plugin install
BjoernSchotte/agentglass-herdr`, marketplace topic `herdr-plugin`:
- **Popup**: `[[panes]] id = "agentglass" placement = "popup" width = "90%"` runs the TUI; suggested binding
  `prefix+g`. A `launch.sh` resolves `agentglass` (the server's `PATH` lacks Homebrew/nvm dirs) and passes
  `AGENTGLASS_REDACT` through.
- **"Open in agentglass"** action (pane context): reads the focused agent's `agent_session` from
  `HERDR_PLUGIN_CONTEXT_JSON`, opens the popup with `agentglass open <harness>:<id>`.
- **Link handler** for `^agentglass://open/` → the popup with `agentglass open <url>` (links agents print, commits,
  OTLP backends become Ctrl-clickable in herdr).
- **Sidebar tokens, opt-in (off by default)**: `$ag_cost` (session cost) and `$ag_alert` (severity + rule id) set with
  `herdr pane report-metadata --source plugin:agentglass`, only on `pane.agent_status_changed` (debounced, one
  `agentglass` run at a time through a lock in `HERDR_PLUGIN_STATE_DIR`), **fixed width** (`$` + 6 chars, alert
  `⚠ stalled` padded to 10) so rows never change width. The README states the flicker risk (dynamic tokens re-layout
  herdr's panes on focus changes) and recommends `ui.sidebar_min_width = ui.sidebar_max_width`. Token values are only
  numbers, severities and rule ids — never titles, prompts, paths or commands — so screen shares leak nothing even
  without `--redact`; with `AGENTGLASS_REDACT` set the plugin sends no cost either.
- **Notify recipe** (in the plugin README, also usable alone): `rules.json` `notify.command` → a script that maps the
  alert's session to a pane (`herdr agent list`, `agent_session`) and calls `herdr pane report-metadata` /
  `herdr notification show` — only for rules herdr cannot see (`stalled`, `loop`, `spinning`, `long-cmd`, cost/budget),
  never `waiting`/`approval` (herdr rings for those). The notify command's environment is stripped: the script names
  the server with `--session` or `HERDR_SOCKET_PATH`. The alert JSON passes through agentglass's redaction when
  `--redact` is on.

## Decisions (2026-10-06)
Each: question · options · decision · why · cost if wrong.

1. **Transport to herdr.** Options: the JSON socket API directly; a helper (`socat`/`nc -U`) for the socket; the
   `herdr` CLI. **Decision: the CLI.** Why: scriptc 0.1.7 has no Unix-domain sockets; a helper is a new runtime
   dependency; the CLI is herdr's documented plugin API, its JSON mirrors the socket's, and a call costs ≈ 2.2 ms CPU
   (Measured). Cost if wrong: ~1.5 ms more CPU per call than a socket; swapping the transport later touches only
   `herdr.ts`.
2. **How changes are noticed without polling per tick.** Options: `events.subscribe` (a long-lived stream — socket
   only, no CLI command); `agent list` every tick; refresh on process change + 30 s, statuses only while an approval can
   be pending. **Decision: the last.** Why: the stream needs sockets (1); per-tick polling of 32 agents costs 0.15 % for
   nothing while agents stream; the gate reads exactly when a dialog is possible (log quiet mid-turn). Cost if wrong: a
   dialog in a session agentglass thinks idle is caught by herdr's own bell, not by ◆; a pane moved without a process
   change shows its old id for ≤ 30 s (actions refresh first, so they never use it).
3. **pid ↔ pane link.** Options: `HERDR_PANE_ID` from the process environment; `pane process-info`; `agent_session`
   only. **Decision: `agent_session` → a session's known exact pid first, else `process-info` cached by `terminal_id`;
   the environment only marks "this pid is in herdr" and names its server.** Why: the environment's pane id goes stale
   on a move (Measured) and macOS has no environment; `terminal_id` survives moves; a known pid costs no spawn. Cost if
   wrong: up to 8 × 6 ms per slow pass while panes are new.
4. **tmux and herdr both claim an agent.** Options: herdr first; tmux first; whoever owns the tty. **Decision: the
   innermost (tty owner) — tmux is asked first.** Why: with tmux inside herdr, herdr only sees the tmux client and
   `agent prompt` would refuse (`agent_not_ready`); with herdr inside tmux, tmux does not know the agent's tty. Cost if
   wrong: none known; both orders give the same answer outside nesting.
5. **Do herdr's session ids change agentglass's linking?** Options: display only; fill gaps and override cwd guesses;
   override everything. **Decision: fill unlinked sessions and take precedence over the cwd heuristic; never override
   registry/open-transcript links.** Why: the live check had herdr-blocked Codex sessions agentglass did not link; pi,
   OpenCode 1.x and Gemini are linked by cwd today, ambiguous with two agents in one directory; registries are exact
   already. Cost if wrong: an integration reporting a wrong id would link the wrong session — herdr's own resume feature
   relies on the same id, so this would be a herdr bug visible there too.
6. **What herdr's `blocked` means to agentglass.** Options: ignore; a separate "blocked" state; the approval signal.
   **Decision: the approval signal (`Obs.asks`, `lv = 1`) for every harness, message "approval dialog open (herdr)".**
   Why: same path as Gemini's tmux title (consistent glyph ◆, rules, notifications); herdr reads the dialog from the
   screen, exact where agentglass guesses. Questions (not tool approvals) show the same alert — both wait for the user.
   Cost if wrong: a herdr misdetection shows ◆ falsely until the log moves (stale rule).
7. **Two notifiers for one dialog** (herdr rings on `blocked`/`done`, agentglass on approval/waiting). Options: suppress
   agentglass's for herdr panes by default; keep both; a config switch. **Decision: keep both by default; document
   `where: "mux is_not herdr"` on the built-in rules.** Why: agentglass may run where herdr's bell is not heard
   (another machine's terminal, `--watch --notify` pipelines); one rule line opts out, using the existing rules
   mechanism, no new switch. Cost if wrong: a double bell until the user adds the line.
8. **Send while `blocked`.** Options: send anyway (`send-keys`); refuse. **Decision: refuse (herdr does), toast says
   to answer the dialog and that `R` jumps there.** Why: text typed into an approval dialog can approve or reject it.
   Cost if wrong: one extra key press for a user who wanted to type into the dialog — they do that in the pane.
9. **Minimum herdr version.** Options: none; 0.6.5 (`agent_session`); 0.8.2 (`agent_blocked` refusal). **Decision:
   send requires ≥ 0.8.2; jump and approval work with any version that has the commands.** Why: before 0.8.2
   `agent prompt` typed into dialogs; the rest is harmless. Cost if wrong: users on 0.7.x cannot send until they update
   (`herdr update`).
10. **Send on the UI thread?** Options: `execFileSync` (306 ms freeze); spawn and toast on exit. **Decision: spawn.**
    Why: 306 ms is a visible freeze. Cost if wrong: none; one more code path (the headless send already works this way).
11. **Which keys jump.** Options: a new key; reuse `R` (live) and `a` (Processes). **Decision: reuse.** Why: they jump
    for tmux today; no new key to learn; footer label becomes "a jump". Cost if wrong: none.
12. **Configuration surface.** Options: always on; env only; config + env. **Decision: auto-on, `mux.herdr: "off"` in
    config, `AGENTGLASS_HERDR` (off | binary path), `AGENTGLASS_HERDR_SOCKET` (one server).** Why: zero setup for
    herdr users; a documented off switch; tests and users with several named sessions can pin one. Cost if wrong: two
    env vars to keep documented.
13. **`--json` shape.** Options: flat fields (`muxKind`, `pane`); one object. **Decision: `mux` object or `null`.**
    Why: groups what belongs together, `null` keeps "not in a multiplexer" unambiguous, room for a later backend.
    Cost if wrong: a consumer reading flat fields adapts once; the field is new, nothing breaks.
14. **Workspace/tab labels under `--redact`.** Options: fake them; hide them. **Decision: hide (pane id only).** Why:
    labels are free text; ids carry no meaning; faking needs a new redact kind for little value. Cost if wrong: a
    screencast shows less context.
15. **The `none` case.** Options: `null` checks at every call site; a null adapter. **Decision: a null adapter
    (`src/mux/none.ts`).** Why: one place for the "not in a multiplexer" wording; call sites stay uniform; a later
    backend changes nothing there. Cost if wrong: none.
16. **Hermetic tests.** Options: rely on the temp HOME; strip `HERDR_*` and set `AGENTGLASS_HERDR=off` in
    `scripts/check.sh`. **Decision: strip and set off; herdr tests opt in with a fake or an isolated server.** Why:
    developers run checks inside herdr panes; a temp HOME does not hide `HERDR_SOCKET_PATH` or the user's agents'
    environments. Cost if wrong: none.
17. **Phase 2 tokens.** Options: on by default; opt-in; none. **Decision: opt-in, fixed width, on state change only,
    numbers and rule ids only.** Why: the user's own herdr config had to drop dynamic tokens after they made herdr
    re-layout panes on every focus change; free text in a sidebar leaks on screen shares. Cost if wrong: users who want
    them flip one plugin setting.

## Open questions (to verify during implementation)
1. Why were the two `blocked` Codex agents not live in agentglass? Expected: Codex's open-rollout link missed them
   (app-server / `--no-daemon` layout). Task 0 checks read-only with `agentglass --json --live` and `ls -l
   /proc/<pid>/fd`; Task 6's herdr link must make them live either way.
2. `process-info` foreground processes for node-based agents (Gemini, pi, OpenCode): is the agent's own pid among
   them, named `node`/`node-MainThread`? Task 0 reads it for one running pane (read-only); the pid choice (3b) falls back
   to "the first foreground pid agentglass knows as a harness root" if names do not match.
3. macOS: `pane process-info` reports foreground pids there too (herdr's own platform code) — verified by the fake
   herdr in CI and once on a Mac in Task 8 if one is available; else noted in the PR.
