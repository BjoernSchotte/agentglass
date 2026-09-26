# agentglass

A single-binary looking-glass TUI to browse, search, watch and steer coding-agent
sessions — old and live — for **Claude Code** (`~/.claude`), **Codex** (`~/.codex`)
and **fx** (`~/.fx`), plus a btop-style monitor of the running harness processes
and their child processes.

- live transcripts that follow the log as the agent works
- subagents grouped under their session (Claude `subagents/`, Codex `parent_thread_id`,
  fx `subagent/owner.json`), auto-expanded while they run, drill down with `n`/`u`
- live processes linked to their session (Claude registry, `lsof` for Codex/fx)

## Build

Requires Node 24+ and [scriptc](https://github.com/vercel-labs/scriptc):

```sh
npm i -g scriptc
scriptc build agentglass.ts -o agentglass
./agentglass
```

## Keys

| key | action |
|---|---|
| `Tab` `1` `2` | Sessions / Processes |
| `↵` | open transcript (live follow) |
| `/` `F` | filter · full-text search (ripgrep, falls back to grep) |
| `h` `l` | harness filter · live only |
| `s` | send prompt — tmux `send-keys` if the agent is live in tmux, otherwise headless `claude -p --resume` / `codex exec resume` / `fx ask --auto --resume-id` (log in `~/.agentglass/logs`); on a subagent it goes to the parent session |
| `R` | resume interactively |
| `a` | switch tmux client to the agent's pane |
| `x` `X` | SIGTERM / SIGKILL |
| `D` | move session to `~/.Trash` |
| `␣` | fold / unfold subagents |
| `n` `N` `u` | in a transcript: next / previous subagent, up to parent |
| `?` | help |

Override the agent commands with `AGENTGLASS_CLAUDE="claude --settings …"`, `AGENTGLASS_CODEX=…`, `AGENTGLASS_FX=…`.
fx reads its custom-connection key from the env var named in `~/.fx/settings.json`, so start agentglass from an
environment that has it (e.g. a shell wrapper).
