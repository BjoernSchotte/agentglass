# ◈ agentglass

**A looking glass for your coding agents.** One tiny native binary that shows every
Claude Code, Codex and fx session on your machine, past and live. You can watch the agents think,
drill into every tool call and diff, and steer them without leaving the terminal.

```
 ◈ agentglass  1 Sessions  2 Processes      ● 4 live · 2 busy · cpu 38.2% ⣀⣠⣤⣶⣿⣷⣤⣀ · mem 2.1G
╭─ sessions ───────────────────────────────────────── 1/412╮╭─ preview ────────────────────── claude · 3.4M╮
│❯⠹ ✻ Claude  4s  api-server  Migrate auth to OAuth ▾⑂2/3  ││ Migrate auth to OAuth device flow            │
│   ├─ ⠹ Explore          6s  Map token refresh paths      ││ process  pid 81234 · busy · tmux work:1.0    │
│   ├─ ⠹ general-purpose  9s  Write migration tests        ││ ─ subagents 2 active / 3                     │
│   └─ · Plan             4m  Draft rollout plan           ││ ⠹ Explore     6s  ⚒ Grep refresh_token       │
│ ● >_ Codex  1m  web-app     Fix hydration mismatch       ││ ⠹ general…    9s  ⚒ Write auth.test.ts       │
│ ● ▲ 𝒇x      3m  infra       Bump node to 24              ││ ──────────────────────────────────────────── │
│ · ✻ Claude  2h  docs        Rewrite quickstart           ││ ⚒ Edit(src/auth/session.ts)                  │
│ · >_ Codex  1d  cli         Add --json output            ││   ⎿ Updated 12 lines                         │
╰──────────────────────────────────────────────────────────╯╰──────────────────────────────────────────────╯
? keys  ↵ open  ␣ subagents  / filter  F full-text  h harness  s send  R resume
```

You have agents running in five tmux panes and two IDE windows, plus a Codex desktop app humming
in the background. Which one is stuck? Which one just rewrote your auth layer? Which subagent is
burning CPU? **agentglass answers that in one keystroke.**

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
- **Mouse too.** Click rows, click again to open, click a preview line to jump straight to that
  event, click footer hints like buttons. Right-click goes back, and the wheel scrolls everything.

## Tiny, fast, local

- **~730 KB native binary**, starts instantly, zero runtime dependencies. It's TypeScript
  compiled to native code with [scriptc](https://github.com/vercel-labs/scriptc), with no Node,
  no Bun and no `node_modules` at runtime.
- **Local only.** It reads the agents' own session logs from disk and never phones home.
- **Nothing to set up.** It works with whatever is already in your home directory.

## Install

```sh
npm i -g scriptc          # needs Node 24+ to build (not to run)
git clone https://github.com/BjoernSchotte/agentglass && cd agentglass
scriptc build agentglass.ts -o agentglass
ln -s "$PWD/agentglass" ~/.local/bin/agentglass
agentglass
```

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
| `Tab` | Sessions ⇄ Processes |

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
| >_ **Codex** | `~/.codex/sessions` | open rollout (`lsof`) | `parent_thread_id` | ✔ |
| ▲ **fx** | `~/.fx/sessions` | open event log (`lsof`) | `subagent/owner.json` | ✔ |

Gemini, opencode, aider, amp and friends already show up in the process view. Their session
browsers are next, and PRs are welcome.

## License

[Apache-2.0](LICENSE)
