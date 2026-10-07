# agentglass CLI contract

The commands, fields, flags, environment variables and exit codes on this page are the part of agentglass that scripts,
CI jobs and plugins (for example [agentglass-herdr](https://github.com/BjoernSchotte/agentglass-herdr)) may rely on.
Everything else — the TUI, other `--json` fields, text output, files under `~/.agentglass` — can change in any release.

**Current contract: 1** (first shipped in the release after 2026.10.5).

## Versioning

- `agentglass --version --json` prints `"contract": N`, an integer.
- **Additive changes keep N**: a new field, command, flag or enum value. Consumers must ignore fields they do not know.
- **Breaking changes bump N**: a listed field, command or flag removed or renamed, a field's type or meaning changed, an
  exit code changed. A bump keeps the previous contract's behavior for at least one release where possible and is
  listed in `CHANGELOG.md` under "Contract".
- A missing `contract` key means an agentglass older than contract 1.

## How to depend on it

1. Check the contract once per agentglass binary (path + mtime): `agentglass --version --json` → `contract >= 1`. If
   it is missing or lower, tell the user to update (`agentglass update` or `brew upgrade agentglass`).
2. Ask only for the fields you need with `--fields`, and prefer `--format csv` or `--format json` explicitly: the
   default format depends on whether stdout is a terminal and on agent mode.
3. Never parse the TUI, text tables or files under `~/.agentglass`.
4. Run agentglass with `AGENTGLASS_AGENT=0` when your process may run inside a coding agent's shell but answers a
   person (a popup, a status bar): agent mode narrows the scope to the current project and changes defaults.
5. `agentglass <command> --help --format json` lists every field of a command (`commands[].fields`); the contract test
   checks that each field below appears there.
6. Arguments: `--flag value` or `--flag=value`. A value never starts with `--`; a flag without its value, an unknown
   option and a stray argument exit 2 (before 2026.10.8 some were ignored, and a bare `--watch --otlp` took the next
   flag as its URL).

Types below: `string`, `number`, `bool`, `object|null`, `string|null`, `number|null`, `array`.

## `agentglass --version --json`

| Field | Type | Meaning |
|---|---|---|
| `version` | string | the agentglass version (CalVer, e.g. `2026.10.6`) |
| `contract` | number | this contract's number |

Exit 0.

## `agentglass --json` — sessions snapshot

```
agentglass --json [--live] [--all-projects] [--limit N] [--filter '<expr>'] --fields <f,…> --format json|jsonl|csv
```

One row per session, newest first. `--live`: only sessions with a running agent. `--all-projects`: every project also
inside an agent shell.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | the session id (with `harness`, a full reference `<harness>:<id>`) |
| `harness` | string | `claude`, `codex`, `fx`, `pi`, `opencode`, `kiro`, `gemini` (more may be added) |
| `title` | string | the session's title (faked under `AGENTGLASS_REDACT`) |
| `cwd` | string | the session's working directory |
| `live` | bool | an agent process runs it |
| `pid` | number | the agent's process id, 0 when not live |
| `status` | string | how the process was linked or what the agent's registry says (e.g. `open`, `busy`, `idle`); `""` when not live — free text, do not switch on it |
| `costUsd` | number\|null | API-equivalent cost in USD; null = not priced |
| `twins` | number | other rows that are this same session (Claude: one session under several project dirs); 0 = none |
| `attention` | bool | an alert at the degraded level is active and not acknowledged (approval, turn finished, …) |
| `stuck` | string\|null | the first active critical alert's reason: `loop`, `long cmd`, `stalled`, `spinning`, or a user rule's id; null = none |
| `alerts` | array | the active alerts: objects with at least `rule` (string), `severity` (`degraded` or `critical`), `message` (string), `acked` (bool) |
| `mux` | object\|null | the terminal multiplexer pane of a live agent; null = not live, or in neither tmux nor herdr |
| `mux.kind` | string | `tmux` or `herdr` (more may be added) |
| `mux.pane` | string | the pane address the multiplexer takes (tmux `work:1.0`, herdr `w7:p1A`) |
| `mux.workspace` | string\|null | herdr workspace label; null for tmux, unknown, or under `AGENTGLASS_REDACT` |
| `mux.tab` | string\|null | herdr tab label; null for tmux, unknown, or under `AGENTGLASS_REDACT` |
| `mux.status` | string\|null | herdr's agent state `idle`, `working`, `blocked`, `done`, `unknown`; null for tmux |

A session can show as several rows (`twins` > 0, same `harness` and `id`): each carries the session's figures
(`costUsd`, tokens), each message counted once across them, and at most one is `live`. Count one row per
`harness:id` when you sum rows, or use `agentglass cost`.

In `--format csv`, objects are flattened with `_`: `mux_kind`, `mux_pane`, `mux_workspace`, `mux_tab`, `mux_status`
(empty cells for null). These names are accepted by `--fields` too. csv cells follow RFC 4180 (a cell containing `,`,
`"` or a newline is quoted; a text cell starting with `= + - @` gets a leading `'`).

Exit 0 (an empty result is ok), 2 on a usage error.

## `agentglass session <ref>` — one session

```
agentglass session <ref> --fields <f,…> --format json|csv
```

`<ref>`: `<harness>:<id>`, a full id, an id prefix of ≥ 6 characters, `current`, `last` or `parent`. A full
`<harness>:<id>` or full id names one session even when its file exists twice (a resumed Claude session copied into a
second project directory): the copy written last wins.

Fields: the `--json` fields above (`id`, `harness`, `title`, `cwd`, `live`, `pid`, `status`, `costUsd`, `attention`,
`stuck`, `alerts`, `mux`).

Exit 0 found, 2 usage error (prefix too short), 3 no such session, 4 ambiguous prefix (the candidates on stderr).

## `agentglass cost` — cost rows

```
agentglass cost --since today|7d|30d --by workspace|project|harness --format json|csv --fields key,workspaceId,costUsd
```

One row per key over the period, highest cost first, then one row with key `total`. `--format csv`: a header line and one
line per row. `--format json`: `{"rows": [...], "source": …, "scope": …}` — read `rows`.

| Field | Type | Meaning |
|---|---|---|
| `key` | string | the group: workspace label (`(none)` without one), project, or harness |
| `costUsd` | number | API-equivalent cost in USD over the period |
| `workspaceId` | string\|null | `--by workspace` only: the herdr workspace id (`w7`), null for `(none)` |

Exit 0, 2 on a usage error.

## `agentglass wait` — what agents wait on

```
agentglass wait --json [--since today|7d|30d|YYYY-MM-DD] [--by family|kind|tool] [--filter '<expr>'] [--limit N]
agentglass wait --format csv --fields key,kind,calls,totalMs
agentglass wait --now --json
agentglass wait --check [--family f | --kind k] [--max N]
```

`--json` prints one object: `period`, `previous` (null when the previous period is past the call-row retention),
`scope`, `retention`, `agentTime`, `rows`, `heavy`, `now`, `guard`, `warnings`. `--format csv|jsonl|table` prints the
rows only. Inside an agent, history is the current project (`scope.project`); `now` and `--check` are always host-wide
(`scope.now` = `"host"`).

| Field | Type | Meaning |
|---|---|---|
| `rows[].key` | string | the command family (`pnpm test`, `tsc`, `gh run watch`), kind or tool, by `--by` |
| `rows[].kind` | string | `test`, `typecheck`, `lint`, `build`, `install`, `ci`, `wait`, `vcs`, `net`, `other`; tools: `user`, `agent`, `web`, `mcp`, `file`, `wait`, `other` (more may be added) |
| `rows[].heavy` | bool | counts as a heavy command (contention) |
| `rows[].calls` | number | calls in the period (untimed ones included) |
| `rows[].totalMs` | number | summed wall time of the timed calls |
| `rows[].share` | number | `totalMs` ÷ the agents' active time (parallel calls each count) |
| `rows[].p50Ms`, `rows[].p95Ms` | number\|null | ≈ quantiles from a duration histogram; null = no timed call |
| `rows[].errors` | number | failed calls |
| `rows[].trend` | number\|null | `totalMs` ÷ the previous period's − 1; null = no previous data or past retention |
| `rows[].peak` | number\|null | most calls of this row running at once (heavy calls ≥ `wait.minSec`); null for tools |
| `agentTime.activeMs` | number | the agents' active time in the period; `toolMs`, `userMs`, `modelMs`, `pollingMs` split it |
| `now.running` | array | heavy and other commands running now: objects with `session`, `harness`, `family`, `kind`, `heavy` (bool), `ageSec`, `rssMb` (number\|null), `bg` (bool) |
| `now.heavyRunning` | number | heavy commands running now on this machine |
| `guard` | string\|null | null, `empty` (no rows) or `retention` (the period starts before the call-row retention) |

Exit 0; `--check`: 3 when the heavy commands running now (of `--family` / `--kind`) reach `--max` (default: the
`contention` rule's threshold, 3), else 0; 2 on a usage error.

## `agentglass open <ref>`

```
agentglass open <ref | agentglass://open/…> [--new-instance]
```

Starts the TUI on the session (a running agentglass takes the link unless `--new-instance`). In a pipe or with
`--print` it prints the resolution as JSON instead.

Exit 0 opened (or handed to a running TUI), 2 usage error (a malformed link), 3 no such session, 4 ambiguous prefix.

## `rules.json` `notify.command`

The command (an argv, no shell) gets one alert as a JSON line on stdin, with at least these fields:

| Field | Type | Meaning |
|---|---|---|
| `rule` | string | the rule id (`approval`, `waiting`, `loop`, `long-cmd`, `stalled`, `spinning`, or a user rule's id) |
| `severity` | string | `degraded` or `critical` (on `resolve`: the level it left) |
| `state` | string | `fire`, `escalate`, `deescalate`, `resolve` (`notify.on` picks which run the command; default `fire`, `escalate`) |
| `session` | string | the session id |
| `harness` | string | the session's harness |
| `message` | string | the alert text (faked under `AGENTGLASS_REDACT`) |
| `title` | string | the session title (faked under `AGENTGLASS_REDACT`) |
| `project` | string | the project directory's name (faked under `AGENTGLASS_REDACT`) |

The command's environment is reduced to `PATH`, `HOME`, locale, desktop-bus and proxy variables plus
`AGENTGLASS_RULE`, `AGENTGLASS_SEVERITY`, `AGENTGLASS_STATE`, `AGENTGLASS_SESSION`, `AGENTGLASS_HARNESS`,
`AGENTGLASS_VALUE`; it is killed after 10 s.

## Environment

| Variable | Meaning |
|---|---|
| `AGENTGLASS_REDACT=1` | privacy mode: fake titles and projects, labels hidden (same as `--redact`) |
| `AGENTGLASS_AGENT=0` | never agent mode, also inside a coding agent's shell |
| `AGENTGLASS_HERDR` | `off` (or `0`) disables the herdr integration; else the path of the `herdr` binary |
