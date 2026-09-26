# agentglass

A single-binary TUI to browse, search, watch and steer coding-agent sessions
(Claude Code `~/.claude`, Codex `~/.codex`) — plus a btop-style monitor of the
running harness processes and their child processes.

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
| `s` | send prompt — tmux `send-keys` if the agent is live in tmux, otherwise headless `claude -p --resume` / `codex exec resume` (log in `~/.agentglass/logs`) |
| `R` | resume interactively |
| `a` | switch tmux client to the agent's pane |
| `x` `X` | SIGTERM / SIGKILL |
| `D` | move session to `~/.Trash` |
| `?` | help |

Override the agent commands with `AGENTGLASS_CLAUDE="claude --settings …"` / `AGENTGLASS_CODEX=…`.
