# ◈ agentglass

**See every coding agent on your machine — live, down to every tool call, diff and dollar.**
One tiny native TUI for Claude Code, Codex and fx: browse every session you ever ran, watch the running
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

- **Every agent, one screen.** Claude Code (`~/.claude`), Codex (`~/.codex`) and
  [fx](https://github.com/vercel-labs/fx) (`~/.fx`) sessions in one searchable list. Live sessions
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
  `fx ask --resume-id`). Press `R` to jump back into a session interactively.
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
- **Local only.** It reads the agents' own session logs from disk and never phones home.
- **Nothing to set up.** It works with whatever is already in your home directory. Usage indexing
  is incremental and cached in `~/.agentglass/cache`, so restarts pick up where they left off.

## Install

Runs on macOS and Linux. Building needs Node 24+ and clang (Linux: `apt install clang`).

```sh
npm i -g scriptc          # needs Node 24+ to build (not to run)
git clone https://github.com/BjoernSchotte/agentglass && cd agentglass
./build.sh                # scriptc build src/main.ts -o agentglass
ln -s "$PWD/agentglass" ~/.local/bin/agentglass
agentglass
```

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
```

## Supported harnesses

| | sessions | live detection | subagents | send / resume |
|---|---|---|---|---|
| ✻ **Claude Code** | `~/.claude/projects` | session registry | `subagents/` | ✔ |
| >_ **Codex** | `~/.codex/sessions` | open rollout (`lsof` / `/proc`) | `parent_thread_id` | ✔ |
| ▲ **fx** | `~/.fx/sessions` | open event log (`lsof` / `/proc`) | `subagent/owner.json` | ✔ |

Gemini, opencode, aider, amp and friends already show up in the process view. Their session
browsers are next, and PRs are welcome.

## License

[Apache-2.0](LICENSE)
