# ◈ agentglass

**See every coding agent on your machine — live, down to every tool call, diff and dollar.**
One tiny native TUI for Claude Code, Codex, fx, pi, OpenCode and Kiro: browse every session you ever ran, watch the running
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
  [fx](https://github.com/vercel-labs/fx) (`~/.fx`), [pi](https://github.com/badlogic/pi-mono) (`~/.pi`) and
  [OpenCode](https://opencode.ai) sessions in one searchable list. Live sessions
  come first, and all your history is there too.
- **Live transcripts.** Open a session and it follows the log as the agent works: prompts,
  thinking, tool calls and results as they land.
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
- **Know what it costs.** Tokens (in/out/cache) and API-equivalent cost per session and per day,
  with Claude list prices built in and your own rates via `~/.agentglass/prices.json`. A **Stats**
  tab shows today and the last 7 days: per-harness totals, busiest session, top tools, activity by hour.
  Top tools carry error rates (MCP servers grouped, `␣` expands); `↵` drills into one: p50/p95/max
  duration, calls over time, top shell programs and command lines, most-changed files, the slowest
  calls and latest errors — `↵` on one opens its session at that call.
- **It taps you on the shoulder.** When an agent finishes a turn or seems to wait for an approval,
  agentglass rings the bell, sends a desktop notification (macOS, or `notify-send` on Linux) and marks the row `◆`. `!` jumps there.
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

## Scriptable

```sh
agentglass --json --live | jq '.[] | {title, costUsd, attention}'   # snapshot of your sessions
agentglass --watch | jq -c 'select(.kind=="tool")'                  # live JSONL stream of every agent's events
agentglass --theme list                                             # themes; --theme gruvbox-dark to pick one
agentglass --redact                                                 # privacy mode for streams and screenshots
```

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

Kiro bills in credits, not tokens: set `"kiroCreditUsd"` in `~/.agentglass/prices.json` (or
`AGENTGLASS_KIRO_CREDIT_USD`) to see its cost; without a rate it shows as unknown.

Gemini, aider, amp and friends already show up in the process view. Their session
browsers are next, and PRs are welcome.

Notes:

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
```

The list, filters, badges, ticker, Stats rows, `--harness`, help, full-text search, trash and live
detection pick the new harness up from the registry. OS specifics (processes, open files, clipboard,
notifications, trash) sit behind the `Platform` port in [`src/platform/`](src/platform/).

## License

[Apache-2.0](LICENSE)
