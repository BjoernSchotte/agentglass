# ◈ agentglass

**See every coding agent on your machine — live, down to every tool call, diff and dollar.**
One tiny native TUI for Claude Code, Codex, fx, pi, OpenCode, Kiro and Gemini CLI: browse every session you ever ran, watch the running
ones think, drill into any call, see where the time and money went, and get tapped on the shoulder
when an agent needs you.

https://github.com/user-attachments/assets/7553c26d-2877-4dca-be2a-5508ec93707e

<sub>▶ 46 s launch video, recorded from the real binary in <code>--redact</code> mode · also in the repo: <a href="docs/media/agentglass-launch.webm"><code>docs/media/agentglass-launch.webm</code></a></sub>

You have agents running in five tmux panes and two IDE windows, plus a Codex desktop app humming
in the background. Which one is stuck? Which one just rewrote your auth layer? What did today cost?
**agentglass answers that in one keystroke.**

| Every agent, one screen | Every call, every diff |
|---|---|
| ![sessions](docs/screenshots/sessions.png) | ![event drill-down](docs/screenshots/detail.png) |
| **Where the time went** | **What it costs** |
| ![call graph](docs/screenshots/callgraph.png) | ![stats](docs/screenshots/stats.png) |

## Why it slaps

- **Every agent, one screen.** Claude Code (`~/.claude`), Codex (`~/.codex`),
  [fx](https://github.com/vercel-labs/fx) (`~/.fx`), [pi](https://github.com/badlogic/pi-mono) (`~/.pi`),
  [OpenCode](https://opencode.ai), Kiro and [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`~/.gemini`)
  sessions in one searchable list. Live sessions
  come first, and all your history is there too.
- **Live transcripts.** Open a session and it follows the log as the agent works: prompts,
  thinking, tool calls and results as they land. A background task that finishes shows as `⟲ completed · …`
  and a message from another agent as `⇄ <sender> · …`; neither counts as a new prompt or turn. Claude sessions
  renamed with `/rename` show that name.
- **Drill all the way down.** Put the cursor on any event and hit `↵`. You get the full tool call,
  its paired result, Edits as colored diffs, Writes and Reads with line numbers, and every file the
  agent touched. Press a number to open that file in `$PAGER` or `$EDITOR`.
- **Subagents, grouped.** Subagents nest under their parent session and unfold automatically while
  they work, so you see who is doing what right now. Hop between them with `n`, go back up with `u`.
- **btop for agents.** A process view shows every running harness with its process tree, CPU
  braille graphs and memory. You also see what it's executing *right now* (that `pnpm test`, that
  runaway `find`), and you can SIGTERM or SIGKILL it with a confirm.
- **Talk back.** Press `s` to send a prompt. If the agent lives in tmux it's typed into its pane,
  otherwise agentglass resumes the session headless (`claude -p --resume`, `codex exec resume`,
  `fx ask --resume-id`, `pi -p --session`, `opencode run -s`). Press `R` to jump back into a session interactively.
- **Search everything.** `/` filters by title, path, id, branch or harness. `F` runs a ripgrep
  full-text search across every transcript you've ever had.
- **Replay any session as a time-lapse.** Press `P` in a transcript and watch the agent's run play
  back at 1×/4×/16×/64× from its own timestamps: pause, step, scrub.
- **See where the time went.** Press `c` on a session (or in its transcript) for a call graph like
  the DevTools Performance panel: a zoomable flame chart of turns › tool calls › subagents › their
  tools, colored by tool kind, and a sortable call tree with total/self time, counts and errors.
  `↵` on any bar opens that call's detail.
- **Know what it costs — and what kind of cost it is.** Tokens (in/out/cache) and API-equivalent cost per
  session and per day, with Claude list prices built in and your own rates via `~/.agentglass/prices.json`.
  Every figure says how it is billed: `$4.20 spend` (API key), `≈$4.20 plan` (subscription, list-price
  equivalent), `cloud` (Bedrock/Vertex), `gw` (gateway) or `?`. Usage without a price is spelled out per
  model, today and this month are projected, and an optional monthly budget warns. A **Stats**
  tab shows today and the last 7 days: per-harness totals, busiest session, top tools, activity by hour.
  Top tools carry error rates (MCP servers and the `✧ skills` you used grouped, `␣` expands; a skill is marked `/`
  for slash-command uses, `⚙` for ones the agent chose, `/3 ⚙5` for both); `↵` drills into one: p50/p95/max
  duration, calls over time, top shell programs and command lines, most-changed files, the slowest
  calls and latest errors — `↵` on one opens its session at that call.
- **It taps you on the shoulder.** When an agent finishes a turn or seems to wait for an approval,
  agentglass rings the bell, sends a desktop notification (macOS, or `notify-send` on Linux) and marks the row `◆`. `!` jumps there.
  Gemini CLI logs a tool call only after it ran; its approval dialog is seen from its terminal title when it runs in tmux
  (elsewhere it shows as a finished turn).
- **It spots stuck agents.** Tool-call loops, stalled runs, commands running for 10+ minutes and
  silent CPU burners get a red `⚠` with the reason.
- **A live ticker** in the header scrolls what every running agent is doing right now.
- **Themes.** tokyo-night, catppuccin (mocha and latte), gruvbox, nord and dracula. Press `T` or pass `--theme`.
- **Mouse too.** Click rows, click again to open, click a preview line to jump straight to that
  event, click footer hints like buttons. Right-click goes back, and the wheel scrolls everything.

## More screens

| Live transcript | Tool drill-down |
|---|---|
| ![transcript](docs/screenshots/transcript.png) | ![tool drill-down](docs/screenshots/tool-drilldown.png) |
| **btop for agents** | **Themes** |
| ![processes](docs/screenshots/processes.png) | ![themes](docs/screenshots/themes.png) |

## Privacy mode

Streaming, screenshotting or demoing? `agentglass --redact` swaps session titles, project names,
paths, branches and subagent tasks for consistent fakes, replaces the content of other sessions with
neutral stand-ins, and scrubs your username, home path, e-mail addresses, secrets and anything listed
in `~/.agentglass/redact.txt` from every pixel — at the same width, so the layout stays intact.
`AGENTGLASS_REDACT_KEEP=<path-substring>` keeps chosen sessions readable (they are still scrubbed).
Every screen in this README and the launch video was recorded this way.

## Tiny, fast, local

- **~1.5 MB native binary**, starts instantly, zero runtime dependencies. It's TypeScript
  compiled to native code with [scriptc](https://github.com/vercel-labs/scriptc), with no Node,
  no Bun and no `node_modules` at runtime.
- **Local only.** It reads the agents' own session logs from disk and never phones home. The
  exceptions are explicit: an opt-in community price list (see [Prices](#prices)), and
  `agentglass update`, which asks GitHub for releases only when you run it.
- **Nothing to set up.** It works with whatever is already in your home directory. Usage indexing
  is incremental and cached in `~/.agentglass/cache`, so restarts pick up where they left off.
- **Light enough to leave open all day.** Refresh follows activity: fast while an agent streams or
  you type, slower when nothing happens, and at most one frame per second while the terminal is in
  the background. Alarms (waiting for you, approval, stuck) keep a 1.5 s cadence whenever an agent
  runs. Frames are only drawn when something changed. `{"refresh": {"mode": "fixed"}}` in
  `~/.agentglass/config.json` (or `AGENTGLASS_REFRESH=fixed`) restores the old fixed 500 ms tick;
  `AGENTGLASS_DEBUG_REFRESH=1` shows the activity level and each job's cost in the footer. Inside
  tmux, `set -g focus-events on` lets agentglass notice that its pane is not in front.

## Prices

Costs are API-equivalent list prices. Claude prices are built in. `~/.agentglass/prices.json`
overrides any model by id prefix:

```json
{ "claude-opus-4-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25, "cacheWrite1h": 10 },
  "kiroCreditUsd": 0.04 }
```

For Codex, Gemini and new models without maintaining that file, opt in to a community-maintained
list in `~/.agentglass/config.json`:

```json
{ "prices": { "source": "litellm", "refreshHours": 24 } }
```

`source` is [`litellm`](https://github.com/BerriAI/litellm) (covers Codex ids and 1-hour cache
writes) or [`models.dev`](https://models.dev). agentglass then fetches that public file at most every
`refreshHours` in the background — a plain GET, nothing about you or your sessions is sent, but the
host sees your IP — keeps only first-party model prices in `~/.agentglass/cache/`, and uses them from
the next start. Your `prices.json` still wins. `agentglass --update-prices` fetches now,
`AGENTGLASS_OFFLINE=1` stops fetching. The Stats tab shows which prices are in use.

## Billing modes, projection, budget

A list-price figure means different things on an API key and on a Max/Team/ChatGPT plan, so each one is
tagged with how the session is billed:

| tag | mode | meaning |
|---|---|---|
| `$4.20 spend` | `api` | API key: the list price is what you pay (the only figure without `≈`) |
| `≈$4.20 plan` | `plan` | subscription (Claude Pro/Max/Team, ChatGPT plans, Gemini OAuth, Kiro): what the API would have charged |
| `≈$4.20 cloud` | `metered` | Bedrock, Vertex, Foundry, Azure: real spend, the cloud price may differ from list |
| `≈$4.20 gw` | `gateway` | a proxy/gateway with its own auth (LiteLLM, corporate proxy, CLIProxyAPI): spend unknown to agentglass |
| `≈$4.20 ?` | `unknown` | nothing conclusive (fx; pi/OpenCode providers without an auth entry) |

Detection, first conclusive source wins: the transcript (Bedrock/Vertex model ids, Codex `plan_type`), the
live agent process's environment (Linux), then the current config files (`~/.claude.json`,
`~/.claude/settings.json`, `~/.codex/auth.json` + `config.toml`, `~/.gemini/settings.json`, pi/OpenCode
`auth.json`). pi and OpenCode resolve each provider on its own: one with its own endpoint (`baseUrl` in
`~/.pi/agent/models.json`, `provider.<id>.options.baseURL` in `~/.config/opencode/opencode.json`) is a gateway
whatever key it uses. Transcript and process results are stored with the session, so history keeps the mode it ran
with; sessions only covered by config show the current mode as assumed (`*`, dim). **Privacy:** only variable
*names* are read from the environment (values only for the on/off switches `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `GOOGLE_GENAI_USE_VERTEXAI`), auth files only for their
type fields (provider configs only for whether an endpoint is set), `~/.claude.json` only for the plan fields of `oauthAccount` and the usage cache below. No secret
is read, stored or exported; `--redact` keeps the tags and replaces plan names that are not plain type words.

Usage without a price is listed instead of hidden: `unpriced  gpt-x 900K · custom 300K · +2 models ·
kiro 120 credits (set kiroCreditUsd)`.

**Projection** (Stats line 3, `agentglass cost`): today = spent so far + the mean cost of each remaining hour
over the last 14 days with any cost; month = month-to-date + today's remainder + days left × the mean daily
cost since the first day with data in the last 14 days. Both need 3+ days of history (else `—`); history is
what is still on disk (Claude Code and Gemini CLI delete old sessions after ~30 days by default).

**Budget** (optional) in `~/.agentglass/config.json`:

```json
{ "budget": { "monthlyUsd": 200, "counts": ["api", "metered", "gateway"], "warnAt": 0.8 } }
```

`counts` are the modes that count (default: real or possibly real spend; `["all"]` or `["plan"]` for a soft cap
on list-equivalent). The header figure turns yellow when the projected month exceeds the budget or `warnAt` of
it is used, red when it is used up — then a toast and a desktop notification once a day
(`AGENTGLASS_NOTIFY=0` keeps it quiet). Figures that include cloud, gateway or plan amounts carry `≈`. `B` in
Stats shows the current state. Invalid values are ignored with one warning.

For Claude plan sessions the header also shows the plan allowance from Claude Code's own cache, `· cc 5h 15%
7d 71%` (the fuller window highlighted); it hides itself when that cache is older than an hour or changes shape.

```sh
agentglass cost                 # today / 7 days / month by mode, unpriced usage, projection, budget
agentglass cost --json | jq .   # {today, week, month{…, projected}, budget{monthlyUsd, used, projected, state, approx}}
agentglass cost --check         # exit 3 when the month is over budget (prompts, cron)
```

## Install

Prebuilt binaries for macOS (Apple Silicon, Intel) and Linux (x64, arm64; glibc 2.36+, e.g. Debian 12+,
Ubuntu 24.04+, Fedora 37+).

**Homebrew**

```sh
brew install bjoernschotte/tap/agentglass       # stable
brew install bjoernschotte/tap/agentglass-dev   # daily dev build (conflicts with stable)
```

The dev formula declares a conflict with the stable one, which current Homebrew only resolves for
trusted taps — once: `brew trust bjoernschotte/tap`.

**Install script** (into `~/.local/bin`, verifies checksums)

```sh
curl -fsSL https://raw.githubusercontent.com/BjoernSchotte/agentglass/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/BjoernSchotte/agentglass/main/install.sh | sh -s -- --channel dev
```

`--version 2026.10.1` pins a release, `--prefix <dir>` picks another directory.

**From source** (needs Node 24+, [scriptc](https://github.com/vercel-labs/scriptc) and clang; Linux: `apt install clang`)

```sh
npm i -g scriptc
git clone https://github.com/BjoernSchotte/agentglass && cd agentglass
./build.sh
ln -s "$PWD/agentglass" ~/.local/bin/agentglass
```

## Releases & channels

- **stable** — versions are `YYYY.M.N`: year, month, and a counter of releases within that month
  (`2026.10.1`, `2026.10.2`, `2026.11.1`). See [CHANGELOG.md](CHANGELOG.md).
- **dev** — a build of `main` every night (when it changed and CI is green), tagged
  `dev-YYYYMMDD.<run>.<attempt>-<sha>` as a GitHub prerelease; the newest 14 are kept.

```sh
agentglass --version --json        # version, channel, commit, build date, platform, install method
agentglass update                  # newest release of your channel (default stable)
agentglass update --channel dev    # switch channels (remembered after a successful update)
agentglass update --dry-run        # show what would happen; --json for scripts
agentglass update --tag 2026.10.1  # one specific release; downgrades ask first (--yes to skip)
agentglass update --rollback       # back to the binary before the last update
agentglass update status
```

`update` verifies the download against `SHA256SUMS`, runs the new binary once to check it is what it
claims to be, and swaps it atomically. Homebrew installs are updated with `brew upgrade`, source
builds with `git pull && ./build.sh`.

<details><summary>Maintainers: cutting a release</summary>

- `sh scripts/release.sh` on a clean, green `main`: computes the next version, writes the
  `CHANGELOG.md` section from Conventional Commits (opens `$EDITOR`), commits, tags `v<version>` and
  pushes; the tag starts `release.yml` (4-platform build → draft → published when every asset is there
  → Homebrew formula). `--dry-run` previews. Fallback without a checkout: the **Release cut** workflow.
- Notes link each entry's merged PR and end with a **Contributors** section (every commit or PR author
  except `RELEASE_MAINTAINERS` / `RELEASE_MAINTAINER_NAMES` and bots), looked up with `gh`;
  offline (`RELEASE_OFFLINE=1`) or without `gh` they fall back to git author names.
- Dev releases run on their own (`dev-release.yml`, 02:43 UTC) or via *Run workflow*.
- Secret `HOMEBREW_TAP_TOKEN`: a fine-grained PAT with **Actions: write** on
  `BjoernSchotte/homebrew-tap` (formula updates) and **Contents: write** on this repo (the Release
  cut workflow pushes the tag with it, because a `GITHUB_TOKEN` push would not start `release.yml`).
- All tests: `sh scripts/check.sh`.

</details>

`y` copies via `pbcopy`, `wl-copy`, `xclip` or `xsel`, else through tmux or the terminal (OSC 52), so it
works over ssh too.

## Keys

Press `?` inside the app for the full, context-aware cheat sheet. The essentials:

| | |
|---|---|
| `↵` / click | open live transcript · drill into an event |
| `j` `k` | move · in a transcript: previous / next event |
| `/` `F` | filter · full-text search |
| `␣` | fold / unfold subagents |
| `n` `u` | next subagent · up to parent |
| `s` `R` | send a prompt · resume interactively |
| `x` `X` | SIGTERM / SIGKILL the agent |
| `1`–`9` `e` | open a referenced file in `$PAGER` / `$EDITOR` |
| `P` | replay the open transcript |
| `c` | call graph (flame chart ⇄ call tree with `Tab`) |
| `!` | jump to the next agent waiting for you |
| `T` | cycle themes |
| `Tab` `1` `2` `3` | Sessions ⇄ Processes ⇄ Stats (`↵` on a tool drills in) |
| `B` | in Stats: budget state and the config path |

## Scriptable

```sh
agentglass --json --live | jq '.[] | {title, costUsd, attention}'   # snapshot of your sessions
agentglass --json | jq '.[] | select(.skills|length>0) | {title, skills}'  # skills used: [{name, source, n}]
agentglass --watch | jq -c 'select(.kind=="tool")'                  # live JSONL stream of every agent's events
agentglass --theme list                                             # themes; --theme gruvbox-dark to pick one
agentglass --redact                                                 # privacy mode for streams and screenshots
agentglass sessions --since 7d --format table                       # json | jsonl | csv | table, for every list
agentglass --json --format csv --fields id,harness,costUsd,tokens_in > sessions.csv
```

`--format csv` is RFC 4180 with a header row: nested fields are flattened (`tokens_in`), lists joined with `;`, `null`
is empty, and text starting with `= + - @` gets a leading `'` so spreadsheets do not run it. `--fields` picks and
orders columns; an unknown name exits 2 and lists the valid ones. On a terminal the default is `table`, in a pipe
`json` (`--json` stays JSON).

## Inside coding agents

When a coding agent runs `agentglass` from its shell tool, agentglass notices (`CLAUDECODE`, `AI_AGENT`, `CODEX_*`,
`GEMINI_CLI`, `PI_CODING_AGENT`, `OPENCODE*`, `KIRO_SESSION_ID`) and behaves like a CLI for machines: it never starts
the TUI and never prompts, bare `agentglass` prints a compact JSON help (< 1 KB), `--help` is JSON, output is compact
JSON, and errors are one line `{"error":{"code","message","hint"}}` on stderr. `--agent` / `--no-agent` (or
`AGENTGLASS_AGENT=1|0`) force it either way, for example to open the TUI in tmux started from an agent.

```sh
agentglass session current --fields costUsd,tools,errors   # this session: cost, models, tool stats, failed calls, repeats
agentglass session last                                     # the previous session in this project
agentglass errors --since 24h --limit 5                     # failed tool calls with the first 200 chars of their output
agentglass cost --since today --by model                    # rows per day | model | harness | project | session
agentglass sessions --since 24h                             # the session list (default: the last 24 h)
agentglass --watch --for 30s                                # inside an agent --watch needs --for <dur> or --until-idle
```

A `<ref>` is `current` (found through the agent's session variable or the process tree), `last`, `parent`, an id,
a unique id prefix of 6+ characters, or `<harness>:<id>`. Exit codes: 0 ok (also when empty), 1 runtime failure,
2 usage error, 3 not found, 4 ambiguous reference. As JSON, `errors` and `cost` rows come in
`{"rows":[…],"source":"…","scope":"…"}`.

Agent output lands in the agent's context and goes to its model provider, so inside an agent the queries only see
the current project (the nearest directory with `.git`). `--all-projects` widens one command; `{"agent": {"scope":
"all"}}` in `~/.agentglass/config.json` widens all of them and `--project-only` narrows again. `agentglass cost`
without `--by`/`--since` stays the global summary (the budget is global). `--redact` works here too.

For your `CLAUDE.md` / `AGENTS.md`:

> Run `agentglass session current` to see this session's cost and failed tool calls.

## Custom agent commands

If your agents run through wrappers (custom settings, profiles, proxies), point agentglass at
them:

```sh
export AGENTGLASS_CLAUDE="claude --settings ~/.config/my/claude.json"
export AGENTGLASS_CODEX="codex --profile work"
export AGENTGLASS_FX="fx"
export AGENTGLASS_PI="pi --model sonnet"
export AGENTGLASS_OPENCODE="opencode"
export AGENTGLASS_SQLITE3="/opt/bin/sqlite3"   # OpenCode sessions are read with the sqlite3 CLI
export AGENTGLASS_CURL="/opt/bin/curl"         # … or, without sqlite3, over the OpenCode service's HTTP API with curl
export AGENTGLASS_KIRO="kiro-cli"
export AGENTGLASS_GEMINI="gemini --approval-mode auto_edit"   # headless sends may edit files
export AGENTGLASS_CACHE_DIR="/tmp/ag-cache"   # a separate usage-ledger cache (default ~/.agentglass/cache)
```

## Supported harnesses

| | sessions | live detection | subagents | send / resume |
|---|---|---|---|---|
| ✻ **Claude Code** | `~/.claude/projects` | session registry | `subagents/` | ✔ |
| >_ **Codex** | `~/.codex/sessions` | open rollout (`lsof` / `/proc`) | `parent_thread_id` | ✔ |
| ▲ **fx** | `~/.fx/sessions` | open event log (`lsof` / `/proc`) | `subagent/owner.json` | ✔ |
| π **pi** | `~/.pi/agent/sessions` | process cwd = session cwd | pi-subagents packages | ✔ |
| ▣ **OpenCode** | `~/.local/share/opencode/opencode.db` | `service.json` daemon (v2) · process cwd (1.x) | `parent_id` | ✔ |
| ◇ **Kiro** | `~/.kiro/sessions/cli` | `<id>.lock` pid | `parent_session_id` | ✔ |
| ✦ **Gemini CLI** | `~/.gemini/tmp/<project>/chats` | process cwd = project root | `chats/<parent id>/` | ✔ |

Kiro bills in credits, not tokens: set `"kiroCreditUsd"` in `~/.agentglass/prices.json` (or
`AGENTGLASS_KIRO_CREDIT_USD`) to see its cost (tagged `plan`); without a rate its credits are listed as unpriced.

aider, amp and friends already show up in the process view. Their session
browsers are next, and PRs are welcome.

Notes:

- **Claude Code**: when a request falls back to another model (`usage.iterations`), each attempt is billed on its own
  model, so a failed attempt on a pricier model counts. Skills count as slash-command uses (`/name`, paired with the
  skill's base-directory line) and as model uses (`Skill` tool calls).
- **Codex**: the preview and `--json` show the session's git remote (`remote`) with credentials, query and fragment
  removed; a remote that still looks suspicious is not shown. Skills you mention with `$name` count as command uses.
  OpenCode skills you activate count as command uses, its `skill` tool and Gemini `activate_skill` calls as model uses;
  pi skills are not counted yet.
- **pi**: honors `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` and `sessionDir` in pi's `settings.json`.
  pi has no session registry, so a session is live when a pi process runs in its working directory.
  Cost comes from pi's own `usage.cost`. MCP calls (pi ≥ 0.99 native MCP, also inside `codemode` scripts, and the
  `pi-mcp-adapter` extension) show in Stats as `mcp__<server>__<tool>`, grouped per server; tool calls made inside
  `codemode`/`mcpScript` scripts count like top-level calls (lines, files, shell programs) and show as `↳` lines in the
  transcript. Subagent sessions of `@tintinweb/pi-subagents`, `pi-subagents` and `@gotgenes/pi-subagents` are nested
  under their parent and linked to the spawning call in the call graph (not for `@gotgenes`, which keeps that link in
  memory); a `/fork` stays a session of its own.
- **OpenCode** (2.x and 1.2–1.18): sessions are read from the SQLite file with the `sqlite3` CLI
  (`OPENCODE_DB` picks another file, `AGENTGLASS_SQLITE3` another binary). Without `sqlite3` (or when it fails),
  2.x sessions come from the running `opencode service` daemon's HTTP API through `curl` (read-only, found via
  `service.json`; the password goes to curl on stdin only; agentglass never starts the daemon). Over HTTP, `/`
  full-text search matches session titles only. With neither, OpenCode sessions don't show and a warning appears. Live detection uses the v2 daemon's
  `~/.local/state/opencode/service.json` plus `time_suspended`, and the process working directory for
  1.x TUIs. `D` (trash) is not available for OpenCode.
- **Gemini CLI** (≥ 0.39, JSONL sessions): honors `GEMINI_CLI_HOME`; also reads `~/.cache/.gemini/tmp` (macOS seatbelt
  sandbox). The cwd comes from each project's `.project_root`; legacy `.json` sessions and pre-0.29 hash dirs are not
  shown. Gemini rewrites history in place (re-appended messages, `/rewind`, resume and compression checkpoints):
  agentglass shows each message and tool call once, marks rewinds and rewritten history with the number of messages
  dropped, and counts each response's tokens once. No cost in the files: priced with the built-in table (paid-tier
  API prices; Pro models above 200k prompt tokens at the long-context rate, keys `<model>>200k`; dated price changes as
  `<model>@2027`; a `prices.json` price for a model replaces those tiers unless it names them too) or your price lists. Variants without
  a price of their own (`-lite`, `-image`, `-tts`) show as unpriced, not at their base model's rate. Helper calls (routing,
  summaries, compression) are not in the transcript, so cost is a slight undercount. Gemini deletes sessions after
  30 days by default (`general.sessionRetention`). A headless send (`s`) runs `gemini --resume <id> -p …` in the
  project root: tools that need approval are denied, and folders not trusted in Gemini are refused (its message is in
  the send log); opt in with `AGENTGLASS_GEMINI="gemini --approval-mode auto_edit"` or `--skip-trust`. On a
  subagent, `s` and `R` act on its parent session (Gemini cannot resume subagents).

### Adding a harness

Every agent is one adapter file behind the `HarnessAdapter` port
([`src/harness/types.ts`](src/harness/types.ts)): where its transcripts live, how a log line becomes
events and usage, how to tell it is live and busy, and how to send to / resume it. Copy the smallest
adapter ([`fx.ts`](src/harness/fx.ts)), register it in `HARNESSES`
([`src/harness/index.ts`](src/harness/index.ts)), and add a few real log lines to the contract check:

```sh
scriptc build src/harness/harness.check.ts -o hc && ./hc   # registry + golden samples for every adapter
scriptc build src/harness/opencode.check.ts -o oc && ./oc  # OpenCode: SQLite rows, subagents, live detection
scriptc build src/harness/opencode-http.check.ts -o och && ./och  # OpenCode over the service HTTP API (fake curl)
scriptc build src/harness/pi.check.ts -o pc && ./pc        # pi: MCP, nested calls, subagent sessions
scriptc build src/harness/gemini.check.ts -o gc && ./gc    # Gemini: normalizing source (every window split), scan, usage
```

The list, filters, badges, ticker, Stats rows, `--harness`, help, full-text search, trash and live
detection pick the new harness up from the registry. OS specifics (processes, open files, clipboard,
notifications, trash) sit behind the `Platform` port in [`src/platform/`](src/platform/).

## License

[Apache-2.0](LICENSE)
