# herdr, first-class — spec

Status: **draft** (2026-10-06; scope widened the same day: the herdr plugin is part of this spec, not a follow-up).
Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4). Plan: [plan.md](plan.md).

## Goal
Two halves, shipped together:

**A. herdr agents are first-class in agentglass** — through one multiplexer port (`src/mux/`, adapters tmux, herdr,
none) that a later backend (zellij, wezterm, …) plugs into:
1. **Send** (`s`): `herdr agent prompt`, refused while the agent waits at an approval or question dialog.
2. **Jump** (`R` on a live session, `a` in Processes): `herdr agent focus` moves herdr's attached clients to the pane.
3. **Resume** (`R` on an ended session, agentglass running inside herdr): a new herdr tab in the workspace that owns the
   session's directory, the agent started there with its resume arguments (`herdr agent start`), focused.
4. **Approval**: herdr's `blocked` state raises the approval alert (◆) for every harness on the first look after it is
   read, instead of the CPU heuristic's ≥ 20 s.
5. **Exact links**: herdr's `agent_session` (the agent's own session id or file, reported by herdr's official
   integrations) links a process to its session where agentglass guesses by cwd today or links nothing.
6. **herdr state in the row**: a herdr-hosted session's row shows herdr's state (working, blocked, done-unseen), the
   preview and Processes show the pane (`herdr webapp › 2 · w7:p1A`).
7. **Grouping by herdr workspace/worktree**: filter key `workspace`, `cost --by workspace`, Stats dimension
   `workspace`, a palette action "Sessions in this herdr workspace"; ended sessions are attributed to the workspace whose
   worktree holds their directory.
8. **Machine contract**: `--json` field `mux`, filter key `mux`, and a versioned **CLI contract** (`contract: 1` in
   `--version --json`, `docs/cli-contract.md`, a contract test in CI) that the plugin — and any other tool — builds on.

**B. agentglass is first-class inside herdr** — a public plugin repo `BjoernSchotte/agentglass-herdr`
(`herdr plugin install BjoernSchotte/agentglass-herdr`), POSIX sh, no dependencies beyond herdr and agentglass, using
only the CLI contract:
1. a popup with the agentglass TUI; 2. "Open in agentglass" for the focused pane's agent; 3. an `agentglass://` link
handler; 4. opt-in sidebar tokens `$ag_cost` / `$ag_alert` (fixed width, updated on state change only); 5. a
`rules.json` notify recipe that forwards only alerts herdr cannot see (stalled, loop, long command, spinning, cost);
6. README with install and `--redact` screenshots; 7. its own CI (shellcheck, fixture tests against a fake herdr and a
fake agentglass, a contract check against the newest agentglass release) and tagged releases; 8. a minimum-version
check: the plugin needs CLI contract ≥ 1 (the first agentglass release that ships A).

No herdr polling per tick: the pane map is refreshed when agent processes change and every 30 s; statuses are read
while an approval can be pending, and for the row state at most every 5 s while the TUI is focused (30 s unfocused).

## Why (user value)
- On this machine all 32 running agents live in herdr panes. For every one of them `s` says "session is live outside
  tmux — cannot inject input safely", `R` says "already running", and approvals are guessed from CPU samples (or, for
  Gemini, not seen at all outside tmux). herdr already knows each pane's agent, its state and its session id.
- herdr's `blocked` is the agent's real dialog state, read from its screen by herdr. The heuristic needs ≥ 20 s and a
  quiet process tree, and it misses dialogs while an MCP server or subagent keeps the tree busy.
- In the live check (below) the two agents herdr reported `blocked` were Codex sessions that agentglass did not show as
  live at all. herdr's `agent_session` gives the exact pid ↔ session pair.
- tmux lock-in: send/jump/approval are coded against tmux in four modules. A port makes the next multiplexer one adapter.
- The user works inside herdr all day: workspaces are their tasks (often one git worktree each). Cost and alerts belong
  where they look (herdr's sidebar), and the full view should be one key away (a popup), not another terminal window.
- A plugin built on agentglass internals breaks on every release; a versioned CLI contract lets it (and scripts, CI
  jobs, other plugins) depend on agentglass safely.

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
- **Resume of an ended session** (`actions.ts:122-129`): leaves the TUI, runs `<agent> <resume args>` in agentglass's
  own terminal (`HarnessAdapter.resume`, e.g. `claude.ts:367` `["--resume", id]`), comes back when it exits.
- **Row state**: `glyphKind`/`statusGlyph` (`src/ui/list.ts:31-38`) — spinner while busy or written < 8 s ago, `●`
  live idle, `○` recent, `·` old; the 2-column badge slot (`H.rowBadges`, `list.ts:85-88`) shows ⚠/◆
  (`watchdog.ts:146`).
- **Grouping**: `--by day|model|harness|project|session` (`src/features/queries.ts:259`); no notion of a multiplexer
  workspace. Worktrees fold into their repo (repo-view), so herdr worktree workspaces already group under the repo.
- **Machine interface**: `--json` fields (`cli.ts:61-62`), `--fields`/`--format` (cli-agent-mode), structured
  `--help --json` with per-command field lists (`src/features/clihelp.ts`), `--version --json`
  (`src/features/version.ts:53-57`: version, channel, commit, date, platform, installMethod) — **no contract version**;
  nothing says which fields a script may rely on. `agentglass open <ref> --new-instance` exists
  (`src/features/palette/open.ts:65,85`).
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
| Plugin runtime environment (herdr source, `src/app/api/plugins/runtime.rs:40-80`) | `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_PLUGIN_EVENT(_JSON)`, `HERDR_PLUGIN_CLICKED_URL`, the focused `HERDR_WORKSPACE_ID`/`TAB_ID`/`PANE_ID`; plugin config and state dirs |
| Plugin registry location | the isolated server created its `.plugins.lock` under its own `$XDG_CONFIG_HOME/herdr`: plugins are kept per config dir, so the integration test can `herdr plugin link` without touching the user's plugins (confirmed in Task I1, Open question 6) |

Send/focus/blocked were exercised only against an isolated herdr server (own `XDG_CONFIG_HOME`, own socket, a stand-in
agent process), never against the user's panes.

## Design A: agentglass

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
    plan, Task A1). `present(now)` is cheap (no spawn); `refresh(procs, now, force)` runs from the slow job;
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

**Row-state reads** (11): besides the gated reads, the slow job re-reads statuses (one `agent list` per server) at most
every 5 s while the TUI is focused and a herdr-hosted live session is in the Sessions list or Processes, every 30 s
otherwise (the map refresh). A gated read in between counts as one.

**Cost**: one `agent list` ≈ 2.2 ms CPU (agentglass + herdr client + server). Row state while focused: 0.04 % of one
core; unfocused: < 0.01 %. Worst case on top (a session quiet mid-turn for < 60 s, every look): 0.15 %; after 60 s:
0.04 %. Within the tui-footprint budget (≤ 2 % unfocused, all in).

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
- **agentglass as the plugin's popup** (`HERDR_PLUGIN_ID` set in its own environment): after a successful herdr jump or
  resume (10) agentglass quits, so the popup closes and the user lands in the pane.
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

### 10. Resume inside herdr
`R` on a session without a live process, while agentglass itself runs in a herdr pane (its own `HERDR_ENV=1` and
`HERDR_SOCKET_PATH`; the herdr adapter is present) and the harness is one herdr can start (`claude`, `codex`, `gemini`,
`opencode`, `pi`, `kiro` — `herdr agent start --kind`):
1. **Workspace**: the workspace whose `worktree.checkout_path` contains the session's real cwd (longest match), else the
   one whose `worktree.repo_root` is the session's repo top (repo-view `Ident.top`), else a new workspace
   (`herdr workspace create --cwd <cwd> --label <repo label> --no-focus`).
2. `herdr tab create --workspace <id> --cwd <cwd> --label <title, ≤ 24 chars; the session id's first 8 chars under
   --redact> --no-focus` → the new root pane.
3. `herdr agent start <harness>-<id8> --kind <harness> --pane <pane> -- <HarnessAdapter.resume(s)>`, **spawned** (it
   waits up to 30 s for the agent to be ready); then `herdr agent focus <pane>`; toast "resumed in herdr: webapp ›
   <tab>". Failure → the parsed error, the empty tab is closed (`herdr tab close`).
4. The new process links through `agent_session` (4) or agentglass's own linking on the next pass.
Outside herdr, or a harness herdr cannot start (fx): today's in-terminal resume. A config switch is not needed: inside
herdr a new tab is what the user expects; outside nothing changes.

### 11. herdr state in the row
For a live session in a herdr pane with a fresh status (read within 30 s and not older than the log's last write):
- `working` → the spinner, even when the log is quiet (herdr sees screen activity: a long tool run, a thinking model);
- `blocked` → ◆ via the approval alert (5);
- `done` → herdr's "finished, not seen yet": the badge slot shows a green `✓` until herdr reports `idle` (the user
  looked at the pane) or the user selects the session in agentglass for > 1 s (agentglass then does **not** tell herdr:
  marking seen is herdr's business);
- `idle`/`unknown` → agentglass's own glyph.
The row key includes the herdr status, so a change redraws the row. Sessions in tmux or none: unchanged.

### 12. Grouping by herdr workspace and worktree
- **Workspace of a session**: live in a herdr pane → that pane's workspace; ended → the workspace whose
  `worktree.checkout_path` contains the session's real cwd (longest match; workspaces without a worktree match by
  their pane cwds is not attempted). From the last workspace list of any present server; none → no workspace.
- **Filter key `workspace`** (session, text): the workspace label (`workspace is webapp`, `workspace ~ feat-`);
  under `--redact` matches the real label, shows `…` in chips (like pinned values).
- **`--by workspace`** for `cost`, `sessions` aggregation and the Stats dimension: key = label, extra field
  `workspaceId` (rows without a workspace: key `(none)`, `workspaceId` null).
- **Palette**: "Sessions in this herdr workspace" (session context, live or mapped) pins `workspace is <label>`.
- **Repos tab**: unchanged — herdr worktree workspaces are worktrees of their repo already.

### 13. The CLI contract (what the plugin and any script may rely on)
- `agentglass --version --json` gains `"contract": 1`. The number is an integer; **additive changes** (a new field, a
  new command, a new enum value, a new flag) keep it; **removing or renaming** a field/command/flag, changing a field's
  type or meaning, or changing an exit code bumps it. A bump keeps the previous contract's behavior for at least one
  release where possible and is listed in CHANGELOG under "Contract".
- `docs/cli-contract.md` (new, in the agentglass repo) lists contract 1 exactly:
  - `--version --json`: `version`, `contract`;
  - `--json [--live] [--all-projects] [--limit N] [--filter …] --fields <f> --format json|jsonl|csv`: fields `id`,
    `harness`, `title`, `cwd`, `live`, `pid`, `status`, `costUsd`, `attention`, `stuck`, `alerts`, `mux`
    (`mux_kind`, `mux_pane`, `mux_workspace`, `mux_tab`, `mux_status` flattened in csv);
  - `session <ref>` with the same fields; exit 3 no session, 4 ambiguous (cli-agent-mode);
  - `cost --since today|7d|30d --by workspace|project|harness --format json|csv --fields key,workspaceId,costUsd`;
  - `open <ref|agentglass://…> [--new-instance]`; exit 0 opened, 4 not found;
  - `rules.json` `notify.command`: the alert JSON on stdin (`rule`, `severity`, `state`, `session`, `harness`,
    `message` …, as `--watch` alert lines) — fields listed;
  - environment: `AGENTGLASS_REDACT`, `AGENTGLASS_AGENT=0`, `AGENTGLASS_HERDR`.
- `scripts/contract.test.sh` (agentglass CI) runs every listed command against a fixture HOME and asserts each field
  exists with its type, and that `--help --json` lists each field for its command. A change that breaks it fails CI
  until the contract number and the doc move.
- The plugin requires `contract >= 1` (checked once per agentglass binary path + mtime, cached in its state dir); a
  missing `contract` means an older agentglass → the plugin says "agentglass with CLI contract 1 needed (≥ <first
  release with it>): `agentglass update` or `brew upgrade agentglass`".

## Part B: the plugin repo `BjoernSchotte/agentglass-herdr`
Public, Apache-2.0, GitHub topic `herdr-plugin` (herdr's marketplace). herdr ≥ 0.7.5 (startup hooks, sidebar tokens),
Linux + macOS. POSIX sh only (`dash`-clean, shellcheck-clean): no Node, no jq, no build step — `herdr plugin install`
clones and registers it. It calls agentglass only through the CLI contract (13), herdr only through its documented CLI.

### B1. Layout
```
herdr-plugin.toml          manifest (id "agentglass", version = the release tag without "v")
bin/ag-env.sh              shared: find agentglass + herdr, contract check, lock, csv helpers (sourced)
bin/ag-pane.sh             pane entrypoints: tui | open | link
bin/ag-action.sh           actions: open-here, open-link, workspace-cost, tokens-on, tokens-off
bin/ag-tokens.sh           tokens on | off | run
bin/ag-event.sh            event + startup hook: ag-tokens.sh run (when enabled)
bin/ag-alert.sh            the notify recipe (rules.json notify.command)
test/fake-herdr.sh, test/fake-agentglass.sh, test/run.sh   fixtures and the test runner
.github/workflows/ci.yml, release.yml
README.md, CHANGELOG.md, LICENSE, docs/screenshots/*.png
```

### B2. Manifest
- `[[panes]] id = "tui"`, `placement = "popup"`, `width = "90%"`, `height = "90%"`, command
  `["/bin/sh", "bin/ag-pane.sh", "tui"]`; `id = "open"` (same, mode `open`) and `id = "link"` (mode `link`).
- `[[actions]]`: `open-here` ("Open in agentglass", contexts `pane`), `workspace-cost` ("agentglass: cost of this
  workspace", contexts `workspace`), `tui` ("agentglass", `global`) → `bin/ag-action.sh <id>`; `tokens-on` /
  `tokens-off` ("agentglass: sidebar tokens on/off", `global`) → `bin/ag-tokens.sh on|off`.
- `[[link_handlers]] id = "agentglass-link"`, `pattern = "^agentglass://open/"`, `action = "open-link"`.
- `[[events]]` `on = "pane.agent_status_changed"` and `on = "pane.agent_detected"` →
  `["/bin/sh", "bin/ag-event.sh"]`; `[[startup]]` → `["/bin/sh", "bin/ag-event.sh", "startup"]`.
- README suggests keys (`[[keys.command]] key = "prefix+g" type = "plugin_action" command = "agentglass.tui"` and
  `prefix+G` → `agentglass.open-here`); the manifest binds none (no key collisions in users' configs).

### B3. Behavior
- **Finding binaries** (`ag-env.sh`): `AGENTGLASS_BIN` from the plugin config file (`$HERDR_PLUGIN_CONFIG_DIR/config`,
  `KEY=value` lines), else `agentglass` on `PATH`, else `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
  `/home/linuxbrew/.linuxbrew/bin` (the server's `PATH` may lack them). herdr: `HERDR_BIN_PATH`.
- **Contract check**: `agentglass --version --json` → `"contract":N` (sed); `N < 1` or missing → popups show the
  upgrade message (13) and wait for a key; hooks exit 0 silently after writing it once to the state dir log. Cached
  per binary path + mtime in `$HERDR_PLUGIN_STATE_DIR/contract`.
- **Popup `tui`**: `exec agentglass` with `AGENTGLASS_AGENT=0` (a popup is a human terminal, not an agent shell).
- **Open here** (`open-here` action → pane `open`): the action writes `$HERDR_PANE_ID` to
  `$HERDR_PLUGIN_STATE_DIR/open-target` and runs `herdr plugin pane open --plugin agentglass --entrypoint open`; the
  pane reads and deletes the target, finds the session with `agentglass --json --live --all-projects --fields
  id,harness,mux_pane --format csv` (row with `mux_pane` = target), then `exec agentglass open <harness>:<id>
  --new-instance`. No row (no linked session) → `exec agentglass` with a one-line note. `--new-instance`: a TUI
  running elsewhere must not take the link — the popup is where the user looks.
- **Link handler**: `open-link` writes `$HERDR_PLUGIN_CLICKED_URL` (validated: `^agentglass://open/[A-Za-z0-9._:%/#=&?-]+$`,
  else ignored) to `link-target`, opens pane `link` → `exec agentglass open "<url>" --new-instance`.
- **Workspace cost** (`workspace-cost`): `agentglass cost --since today --by workspace --format csv --fields
  workspaceId,costUsd` → the row for `$HERDR_WORKSPACE_ID` → `herdr notification show "agentglass" --body "<label>:
  $X today"`; plus 7 days with `--since 7d`.
- **Sidebar tokens** (off until `tokens-on`; the flag is a file in the state dir):
  - On each event/startup: if a run is going (lock dir `$HERDR_PLUGIN_STATE_DIR/run.lock`, `mkdir`-atomic), touch
    `dirty` and exit; else run once, and again while `dirty` was touched meanwhile (≤ 3 rounds). One run =
    `agentglass --json --live --all-projects --fields mux_kind,mux_pane,mux_workspace,costUsd,stuck --format csv`
    (≈ 0.5 s) → for each `herdr` row: `herdr pane report-metadata <pane> --source plugin:agentglass --token
    ag_cost=<v> --token ag_alert=<v> --seq <epoch ms>`; workspace token `ag_cost` = sum per workspace
    (`herdr workspace report-metadata`). Values are reported **only when changed** (last values in the state dir).
  - **Fixed width**: `ag_cost` = `$` + 6 chars right-aligned (`$  0.42`, `$ 12.40`, `$ 123.5`, `$  1.2k`, unpriced
    `$     ?`); `ag_alert` = 10
    chars: `⚠ stalled `, `⚠ loop    `, `⚠ long-cmd`, `⚠ spinning`, `⚠ cost    `, or 10 spaces when none (a constant
    width: rows never change width, so herdr never re-layouts).
  - **Only numbers and rule ids** go to herdr — never titles, prompts, paths, commands. With `AGENTGLASS_REDACT` set in
    the plugin config, `ag_cost` is not reported either.
  - `tokens-off` clears both tokens on every pane/workspace it set (`--clear-token`) and removes the flag.
  - README: the flicker note, the `ui.sidebar.agents.rows` snippet (`[["state_icon","agent","$ag_cost"],["$ag_alert"]]`)
    and the advice to pin `ui.sidebar_min_width = ui.sidebar_max_width`.
- **Notify recipe** (`ag-alert.sh`, set by the user as `rules.json` `notify.command` with the full path the README
  prints via `herdr plugin config-dir agentglass`): reads the alert JSON on stdin; ignores rules `waiting` and
  `approval` (herdr rings for those) and states other than `fire`/`escalate`; maps `session` to a pane with one
  `agentglass --json --live --all-projects --fields id,harness,mux_pane --format csv`; reports `ag_alert` (same
  fixed-width value) with `--ttl-ms 600000`; `severity = critical` → `herdr notification show "agentglass" --body
  "<rule> · <harness>" --sound request`. The notify command's environment is stripped by agentglass: the script finds
  herdr by absolute path and the server by `HERDR_SOCKET_PATH` from its own config file (the README's setup writes
  it), else the default socket. No title, message or project text is forwarded (they may name customers).

### B4. Tests, CI, releases
- `test/run.sh`: every entrypoint against `test/fake-herdr.sh` (records argv, answers from fixture JSON) and
  `test/fake-agentglass.sh` (answers `--version --json`, `--json … --format csv`, `cost …`, records `open` argv):
  contract < 1 → message; open-here finds the row; link validation; tokens: fixed widths, only-on-change, lock + dirty
  coalescing (two events during a run → exactly one extra run), tokens-off clears; ag-alert filters waiting/approval,
  forwards stalled/loop/cost, critical → notification. Runs with `dash` and `bash`.
- CI (`ci.yml`, ubuntu + macos): shellcheck (`-s sh`), `test/run.sh`, manifest lint (TOML keys, `version` = latest
  CHANGELOG entry), **contract job**: install the newest agentglass release (its `install.sh`), run
  `test/contract.sh` — `contract >= 1` and every field the plugin uses appears in `agentglass --help --json` for its
  command. Target ≤ 2 min.
- Releases (`release.yml`): tag `vX.Y.Z` → checks that the manifest version matches → GitHub release with the
  CHANGELOG section. `herdr plugin install BjoernSchotte/agentglass-herdr` installs the default branch; the README
  shows `--ref v0.1.0` for pinning. v0.1.0 ships after the agentglass release that carries contract 1.

## Failure modes
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
- Resume in herdr: `agent start` times out (30 s) or the harness is missing on the server's `PATH` → the error toast,
  the empty tab is closed; nothing is left running.
- A worktree workspace removed later: its ended sessions lose the workspace attribution (`(none)`); the repo grouping
  still holds them.
- Plugin: agentglass missing or contract < 1 → popups show the upgrade line, hooks do nothing; herdr < 0.7.5 → herdr
  refuses the manifest (`min_herdr_version`). A token run that fails leaves the old values (no flapping). A crashed run
  leaves `run.lock`: a lock older than 120 s is taken over.

## Privacy
- The prompt text goes into `herdr agent prompt`'s argv (visible to the same user's `ps` for ~0.3 s), as it goes into
  `tmux send-keys`' argv today. It is the user's own text for their own agent; nothing else agentglass knows is sent.
- Process environments: only the values of `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are kept; no other variable is read
  into a kept structure, logged, cached or exported.
- agentglass itself writes nothing to herdr's metadata; it creates tabs/workspaces only on a user's `R` (10). `--redact`
  hides workspace/tab labels (8) and uses the session id as the new tab's label (10).
- The plugin sends herdr only numbers and rule ids (tokens) and rule + harness names (notifications); no title, prompt,
  path, project or command. With `AGENTGLASS_REDACT` in its config it sends no cost either and runs agentglass with
  `AGENTGLASS_REDACT=1`. README screenshots are taken with `--redact`.
- Link handler URLs are validated against a strict pattern before they reach `agentglass open`.
- Child processes get `HERDR_SOCKET_PATH` set and inherit nothing else new.

## Interactions with other specs
- **tui-footprint**: the slow-job and watchdog cadences it set are the only places herdr is called; the cost is in 5.
  `scripts/footprint.sh` gains no herdr dependency; the integration task measures with an isolated server.
- **macos-footprint**: replaces `ps`/`lsof` on macOS; this spec uses only `OS.ttyDevice` (tmux) and `OS.envOf`
  (empty on macOS, so herdr's pid ↔ pane link there always comes from `pane process-info`). No overlap in files.
- **adaptive-refresh**: statuses ride `H.onWatch` (1.5 s while agents are live); unfocused the procs pass halves
  discovery, the herdr refresh follows the slow job.
- **rules-config / filter-language**: `mux` and `workspace` are session attributes (`register` + `extend`,
  `src/features/query/`); rules' `where` scopes can use them; `workspace` joins the `--by` dimensions.
- **cli-agent-mode**: `mux` joins `JSON_FIELDS`; the CLI contract (13) names which of its commands, fields and exit
  codes are stable, and its contract test guards them.
- **command-palette**: entries renamed (7); `agentglass://open/<session>` is the deep link the plugin's link handler
  opens.
- **redact**: labels hidden (8).
- **sessref (bug fixed here)**: `agentglass open claude:<id>` / `session claude:<id>` report "ambiguous" (exit 4) when the
  same session file exists under two Claude project dirs (a resumed session copied into a second worktree). The
  plugin's "Open in agentglass" passes exactly such full refs, so this spec fixes it: a full `<harness>:<id>` with
  several copies resolves to the copy with the newest mtime (the one the agent writes); a prefix stays ambiguous.

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
- Checks for 10–13: resume-in-herdr argv sequence (workspace match by checkout path, then repo root, then create;
  tab label under `--redact`; `agent start` args = the harness's resume args; failure closes the tab); row glyph per
  herdr status incl. staleness and `done` → `✓`; `workspace` of live and ended sessions (longest checkout-path match),
  filter key and `--by workspace` rows with `workspaceId`; `--version --json` has `contract: 1`; a full
  `<harness>:<id>` with two copies resolves to the newest.
- `scripts/contract.test.sh` (agentglass CI): every command and field of `docs/cli-contract.md` against a fixture HOME.
- End to end (`scripts/mux-herdr.test.sh`, skipped when `herdr` is not installed): an isolated herdr server (own
  `XDG_CONFIG_HOME`, own socket, `AGENTGLASS_HERDR_SOCKET` pins it), a stand-in agent (a copy of `dash` named
  `claude`, reading lines into a file), a fake Claude session linked through herdr `agent_session`; asserts
  `--json --live` `mux`, TUI `s` delivers the line, `blocked` refuses with the toast and shows ◆, `R` focuses (herdr
  `focused_pane_id`), `R` on an ended session opens a tab running the stand-in with `--resume <id>`, and the server is
  stopped by pid at the end.
- Plugin: `test/run.sh` (B4) in its own CI; the integration task links the plugin into the isolated server
  (`herdr plugin link`, the isolated config dir) and drives popup, open-here, link, tokens and the alert recipe live.
- Footprint: TUI with 32 isolated herdr panes (stand-in agents) for 5 min unfocused, idle: added CPU ≤ 0.1 % vs herdr
  off; focused with herdr sessions shown: ≤ 0.15 %; with one pane quiet mid-turn: ≤ 0.3 %. Plugin tokens on: one
  agentglass run per status change, never two at once.

## Out of scope
- agentglass writing herdr metadata itself (the plugin does it, opt-in).
- A herdr plugin marketplace listing beyond the GitHub topic; Windows support in the plugin.
- Remote herdr machines (`--machine`, `--remote`), herdr on Windows.
- herdr as a harness (it holds no transcripts).
- herdr's terminal title as an approval source (its `blocked` state supersedes it).
- zellij/wezterm adapters (the port is shaped for them; no code).

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
17. **Sidebar tokens.** Options: on by default; opt-in; none. **Decision: opt-in (`tokens-on` action), fixed width,
    reported only when a value changed, numbers and rule ids only.** Why: the user's own herdr config had to drop
    dynamic tokens after they made herdr re-layout panes on every focus change; constant-width values cannot change a
    row's width; free text in a sidebar leaks on screen shares. Cost if wrong: users who want them run one action.
18. **Scope: plugin in this spec, not a follow-up.** Options: agentglass side first, plugin later; both now.
    **Decision: both, one plan, one integration task.** Why: the user asked for herdr support that is first-class in
    both directions; the plugin is small and only needs the contract, so most of it runs in parallel. Cost if wrong:
    plugin v0.1.0 waits for the agentglass release (its contract job), nothing else.
19. **Plugin language.** Options: Node/TypeScript; a scriptc binary per platform; POSIX sh. **Decision: POSIX sh, no
    jq.** Why: herdr installs plugins by `git clone` + optional build; sh needs no toolchain, no build, works on Linux
    and macOS, and the plugin is glue (call agentglass, call herdr). JSON from herdr is avoided: agentglass gives csv
    (`--format csv`), herdr ids come from env vars; the one JSON read (`--version --json`'s `contract`) is a fixed key.
    Cost if wrong: if the glue grows, a rewrite in another language — the contract keeps that independent.
20. **What the plugin may call.** Options: agentglass internals (files under `~/.agentglass`); any CLI output; a
    versioned contract. **Decision: only the CLI contract (13), checked at runtime (`contract >= 1`) and in the plugin's
    CI against the newest release.** Why: cache files and TUI behavior change every release; a contract is the
    promise that does not. Cost if wrong: one more doc + test to maintain in agentglass (small; it also serves scripts).
21. **Contract versioning.** Options: tie to the agentglass version; semver string; one integer bumped only on
    breaking changes. **Decision: one integer, additive changes keep it.** Why: CalVer releases say nothing about
    compatibility; an integer is trivial to compare in sh. Cost if wrong: a consumer needing a newly added field checks
    the version too (the plugin's README says which release).
22. **How "Open in agentglass" finds the session.** Options: a new `agentglass open --herdr-pane <id>`; the plugin
    resolves via `--json --live … mux_pane`. **Decision: the plugin resolves via the contract's `--json` fields.** Why:
    no herdr-specific CLI surface in agentglass; the same field serves scripts. Cost if wrong: ~0.5 s per open (one
    `--json --live` run) — acceptable for a popup.
23. **Popup and a running TUI.** Options: hand the link to the running TUI (single-instance default); always a new
    instance. **Decision: `--new-instance` in plugin panes.** Why: the user looks at the popup; a hand-off would open
    the session in a TUI in another window and leave an empty popup. Cost if wrong: two TUIs briefly (the popup one
    ends when closed).
24. **After a jump from the popup.** Options: stay open; quit. **Decision: quit after a successful herdr jump/resume
    when running as a plugin pane (`HERDR_PLUGIN_ID` set).** Why: the jump's purpose is to land in the pane; a popup
    on top would hide it. Cost if wrong: one key to reopen the popup.
25. **Resume of an ended session inside herdr.** Options: today's in-terminal resume (it would run inside agentglass's
    own pane or popup); a new tab in the right workspace. **Decision: a new tab in the workspace owning the session's
    directory, `herdr agent start`, focused.** Why: in herdr, agents live in their own tabs; resuming inside a popup
    would trap the agent in a temporary pane. Cost if wrong: a tab the user did not want — closed with one key.
26. **herdr state in the row.** Options: a new column; reuse the status glyph and the badge slot. **Decision: reuse —
    herdr `working` drives the spinner, `blocked` the ◆, `done` a green `✓` in the badge slot.** Why: no new column at
    80 columns; the glyphs already mean busy/attention; `done`-unseen is herdr's most useful extra ("finished while you
    looked elsewhere"). Cost if wrong: `✓` competes with ⚠/◆ in the slot — those win (the slot shows one mark).
27. **Row-state freshness.** Options: 30 s (map refresh); every look (1.5 s); 5 s while focused and visible.
    **Decision: 5 s focused + visible, 30 s otherwise.** Why: a stale spinner misleads; 5 s costs 0.04 %; unfocused
    nobody looks. Cost if wrong: a state change shows up to 5 s late.
28. **Workspace of ended sessions.** Options: live sessions only; attribute by worktree checkout path; persist a
    history of pane ↔ session. **Decision: checkout path, from the current workspace list.** Why: herdr worktree
    workspaces are tasks with their own directory — the path is exact; no new cache. Cost if wrong: sessions of removed
    worktree workspaces fall back to `(none)` (the repo grouping still has them).
29. **The `open` ambiguity bug.** Options: separate PR; fix here. **Decision: fix here (newest copy wins for a full
    `<harness>:<id>`).** Why: the plugin's open passes full refs; on this machine one live Claude session already hits
    it. Cost if wrong: none — a full id names one session; the copies are the same session.
30. **Plugin keybindings.** Options: bind `prefix+g` in the manifest; document only. **Decision: document only.** Why:
    a manifest binding can collide with the user's config (theirs is managed by configuration management). Cost if
    wrong: one config line to add (README gives it).
31. **Alert forwarding (notify recipe).** Options: forward all agentglass alerts; only those herdr cannot see.
    **Decision: never `waiting`/`approval`; `fire`/`escalate` only; critical → herdr notification, all → `$ag_alert`.**
    Why: herdr already rings for done/blocked; duplicates teach users to ignore both. Cost if wrong: a user wanting
    both edits one line in the script's filter.

## Open questions (to verify during implementation)
1. Why were the two `blocked` Codex agents not live in agentglass? Expected: Codex's open-rollout link missed them
   (app-server / `--no-daemon` layout). Task A0 checks read-only with `agentglass --json --live` and `ls -l
   /proc/<pid>/fd`; Task A6's herdr link must make them live either way.
2. `process-info` foreground processes for node-based agents (Gemini, pi, OpenCode): is the agent's own pid among
   them, named `node`/`node-MainThread`? Task A0 reads it for one running pane (read-only); the pid choice (3b) falls back
   to "the first foreground pid agentglass knows as a harness root" if names do not match.
3. macOS: `pane process-info` reports foreground pids there too (herdr's own platform code) — verified by the fake
   herdr in CI and once on a Mac in Task I1 if one is available; else noted in the PR.
4. A plugin pane opened by `herdr plugin pane open` from an action: does it receive the action's context
   (`HERDR_PANE_ID` of the focused agent)? The design does not depend on it (state files); Task I1 confirms the popup
   flow end to end.
5. A plugin popup when agentglass focuses another pane: does herdr hide the popup by itself? If yes, Decision 24's
   quit is still right (the TUI should not linger hidden); Task I1 records what happens.
6. The isolated server's plugin registry: `herdr plugin link` with `XDG_CONFIG_HOME` pointing at the isolated config
   dir must not appear in the user's `herdr plugin list`. Task I1 Step 1 checks `herdr plugin list` (read-only, user's
   server) before and after.
7. `herdr agent start --kind claude` readiness: does herdr detect a started agent by process name or by its screen
   manifest? With a real agent it is ready; the e2e stand-in may time out. Task A10 records it; the design closes the
   tab on failure either way.
8. `herdr tab create` JSON: the path of the new root pane id (`result.root_pane.pane_id` as for `workspace create`, or
   under `tab`). Task A0 Step 3 records it.

