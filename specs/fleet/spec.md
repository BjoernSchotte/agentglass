# Fleet: several machines in one view (SSH pull, snapshots, exact merge) — spec

Status: **draft** (2026-10-06). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4). Two parts:
**Part A** (sections 2–11) is the SSH pull MVP; **Part B** (sections 12–17) makes it exact: incremental snapshots,
cross-host message ownership, local re-pricing, `dir` hosts and a live stream. Companion specs:
[otlp-complete](../otlp-complete/spec.md) (export completeness; shares the host identity of section 3) and
[otlp-hub](../otlp-hub/spec.md) (Collector file reader and `agentglass receive`; a third feed of the model in
section 1, which is defined here once and referenced by both).

## Goal
`agentglass fleet` and the TUI show the sessions, cost and live state of several machines in one place:
1. Hosts are listed in `~/.agentglass/config.json` (`fleet.hosts`). The viewer pulls each host's own figures over
   SSH, or reads snapshots a host drops into a synced directory. No transcript leaves its host.
2. Every remote session row carries its host: a badge in the list, a `host` attribute in the filter language and a
   `host` field in `--json`. Session keys are host-qualified.
3. Each host's numbers are the numbers that host shows for itself; with Part B the fleet totals are **exact**: a
   Claude message copied to several hosts is counted once, and one price table prices the whole fleet.
4. A host that cannot be reached shows its last result with its age. Nothing blocks the TUI.
5. `agentglass fleet status` says, per host, what works and what does not.
6. Remote alarms and approval waits appear within seconds (`fleet watch`, Part B).
7. One remote-host model (`HostFeed` → `HostReport`, section 1) that every transport — SSH pull, SSH snapshot, `dir`
   drop, and the OTLP hub of [otlp-hub](../otlp-hub/spec.md) — delivers into, without touching the TUI or the CLI.

## Why (user value)
- People run agents on a laptop, a workstation and a few VMs or containers. An agent that waits for approval on the
  VM, or a stuck one, goes unnoticed until someone logs in there.
- Budgets and plan allowances are per account, not per machine. Today every machine shows only its own share: the
  monthly budget line and the "today" figure are wrong on each of them.
- agentglass reads seven harnesses without hooks. Merging per-host agentglass output is the only way to get one
  complete picture across machines and harnesses.
- SSH keys already exist between a developer's machines. Pulling over SSH needs no new credentials, ports or
  services, and the remote agentglass computes liveness, alarms and approval waits from its own process table,
  which no file sync can provide.

## Today (measured, not guessed)
- **No multi-host code.** `Sess` (`src/model/types.ts:5-15`) has no host field. Sessions live in one map keyed by
  absolute path (`src/model/sessions.ts`); `buildView` (`sessions.ts:264-299`) builds the list from that map only and
  sorts live first by `s.pid` (`:284`).
- **Machine-readable output exists, without a host or a format version.**
  - `--json` prints a bare array of `jsonSess` objects (`src/features/cli.ts:173-183`, fields `JSON_FIELDS`
    `cli.ts:61-62`). `snapshot` (`cli.ts:194-211`) indexes every listed session (`complete`) before printing.
    There is no `--since`; `--filter 'age < 7d'` and `--fields` narrow it.
  - `cost --json` (`src/features/cost-cli.ts:53-62`) prints `{today, week, month{projected}, budget}` with
    `byMode` per billing mode. It carries **no** allowance gauge: the Claude 5 h / 7 d gauge comes from
    `~/.claude.json` `cachedUsageUtilization` (`src/features/usage/bill-live.ts:70-78`, guard
    `src/features/usage/billing.ts:256-263`) and the Codex gauge from transcript `rate_limits`, both TUI-only
    (`src/features/usage/stats.ts:723-735`).
  - The budget state is a pure function, `budgetState(b, month, projByMode)` (`src/features/usage/costs.ts:159`);
    `addSum` (`costs.ts:57`) adds two `ModeSum`s.
- **Processes and spool files.** `detached(cmd, args)` (`src/platform/posix.ts:37-39`) spawns with
  `stdio: "ignore", detached: true` and returns nothing (no pid). The run directory `~/.agentglass/run`
  (`src/features/palette/rundir.ts:13`, `AGENTGLASS_RUN_DIR`) is checked owner-only 0700 by `secureDir`
  (`rundir.ts:17-30`). External commands are configurable and probed once (`AGENTGLASS_CURL`,
  `src/util/http.ts:12-19`). `process.kill(pid, sig)` works (`src/actions.ts:134`); `execFileSync` with
  `stdio: "inherit"` works (`src/actions.ts:50`).
- **SSH.** `src/util/sshcfg.ts` parses `~/.ssh/config` read-only for git remotes (Host → HostName/Port). Nothing runs
  `ssh`.
- **Host identity.** None. The OTLP exporter can send `host.name` from `uname -n` (`src/features/otlp/encode.ts:150`),
  off by default.
- **Privacy switch.** `REDACT` is fixed at process start from `--redact` or `AGENTGLASS_REDACT`
  (`src/features/redact-on.ts:5`); `--json` and `--watch` honor it.
- **Hooks used here.** `H.rowBadges` (list badge slot, `src/ui/list.ts:86-91`; the watchdog's ⚠/◆ at
  `src/features/watchdog.ts:146`), `H.headerWidgets` (`stats.ts:723`), `H.enrich` / `H.complete`
  (`src/hooks.ts:72-73`), `H.dynActions` (palette), `H.helpSections`, `H.onTick`, `H.cli`.
- **Filter attributes** are registered in `src/features/query/attrs.ts:56-80` and read in
  `src/features/query/eval.ts` (`live` via `livePid`, `eval.ts:49,87`; `state` via `stateOf`, `eval.ts:50,89`).

Measurements (this machine, Linux x64, OpenSSH, 2026-10-06; agentglass built from `main` at 4e76de8; the
isolated cache started empty):

| What | Result |
|---|---|
| `ssh localhost true`, new connection | 183 ms |
| same with `ControlMaster=auto` reused | 6–8 ms |
| `ControlPath=<run dir>/ssh-%C` with a 92-character directory | **ssh fails** (exit 255, "ControlPath too long … >= 108 bytes"); ssh also appends a 17-character temp suffix while it creates the socket, so the limit is 107 bytes for the whole path plus suffix |
| `cost --json`, cold ledger (first run on a host) | 19.0 s, 157 MB RSS |
| `cost --json`, warm | 0.67 s, 109 MB RSS, 834 bytes |
| `--json` (all 2,389 top-level sessions), cold / warm | 42.1 s / 1.27 s, 3.5 MB (gzip 431 KB) |
| `--json --filter 'age < 7d'` (910 sessions) | 1.22 s, 1.4 MB |
| same with `--fields` (19 list fields, no `git`/`skills`/`path`) | 0.99 s, 627 KB, **gzip 82 KB** |
| `--json --filter 'age < 24h'` (211 sessions) | 0.93 s, 516 KB |

Consequences: a refresh over a shared connection costs about one second of the remote agentglass, not the SSH
handshake. The first pull of a host that never ran agentglass indexes its whole history (up to a minute here). A
week of sessions on a busy host is under 100 KB on the wire with SSH compression.

## Design

### 1. The remote-host model: `HostFeed` → `HostReport` (shared by fleet and otlp-hub)
Every transport delivers the same thing: a **`HostReport`**, one host's state at one moment. The TUI, the filter
language, the merge and the CLI read only reports; they never know how a report travelled. This section is the one
definition; [otlp-hub](../otlp-hub/spec.md) refers to it.

```ts
// src/features/fleet/model.ts
export interface Hello { format: string; version: string; hostId: string; hostName: string; os: string; tzOffsetMin: number; redact: boolean; days: number; now: number; priceSig: string }
export interface OwnRow { h: string; key: number; d: string; m: string; prov: string; n: number[] } // one owned Claude message: hashed id, order key, local day, model, provider, [in, out, cacheRead, write5m, write1h, usd, tablePriced 0|1]
export interface DayRow { d: string; tp: string[][]; hx: number[][]; unk: number; um: string[][]; uc: number; tools: number; turns: number; calls: number; errors: number } // 13.2
export interface SessRow {
  s: Obj;                // the jsonSess object (the `--json` contract)
  key: string;           // host-local stable key: "<harness>:<id>"
  days: DayRow[] | null; // per-day usage (Part B feeds); null = only the totals in `s` (Part A pull)
  own: OwnRow[] | null;  // Claude messages this session owns on its host (Part B, OTLP hub); null = unknown
  prov: string[][];      // [provider, billing mode] for multi-provider harnesses (pi, OpenCode); [] = the session's mode
}
export interface HostReport {
  hello: Hello;              // who produced it, when (source clock), under which privacy mode, which price table
  sessions: SessRow[];       // top-level sessions, updated within hello.days or live
  cost: Obj | null;          // the host's own `cost --json` object (shown as is when the report has no days)
  allowance: Obj | null;     // {claude: {account, fetchedAt, h5, d7} | null, codex: {at, wins} | null} (7.4)
  live: LiveRow[] | null;    // newest live state per session from a stream (16, otlp-hub), fresher than `s`
  exact: boolean;            // every session carries days and own: the merge can be exact (13)
}
export interface LiveRow { key: string; at: number; live: boolean; busy: boolean; attention: boolean; approval: boolean; stuck: string; alerts: Obj[] }
export interface FeedState { report: HostReport | null; okAt: number; tryAt: number; err: string; code: string; busy: boolean } // viewer clock
export interface HostFeed {
  kind: string;                    // "ssh" (pull or snapshot), "dir" (snapshot drop), "otlp" (otlp-hub)
  start(now: number): boolean;     // begin one refresh in the background; false = one is already running
  poll(now: number): FeedState;    // cheap: stats a file or two, parses only what changed, never blocks
  stop(): void;                    // kill what start() spawned (on quit)
}
```

- `src/features/fleet/hosts.ts` keeps one `RemoteHost {cfg, feeds, state, rows: Sess[]}` per host and turns new
  reports into rows (section 7) and into the exact merge (section 13). It is the only module that knows hosts exist.
- Feeds and what they fill:

| Feed | `kind` | Spec | `days` | `own` | `live` | `exact` |
|---|---|---|---|---|---|---|
| SSH pull (`fleet pull`) | `ssh` | Part A, 4–5 | — | — | — | no |
| SSH snapshot (`fleet snapshot`) | `ssh` | Part B, 12 | yes | yes | from `fleet watch` (16) | yes |
| Snapshot drop | `dir` | Part B, 15 | yes | yes | — (the drop's own state, minutes old) | yes |
| OTLP hub (Collector files, `agentglass receive`) | `otlp` | otlp-hub | from spans | from Claude `gen_ai.response.id` | from the logs stream | yes for hosts exporting with otlp-complete |

- A report's `SessRow.s` is always the `--json` object shape. A feed that rebuilds sessions from other data (OTLP)
  produces that shape too, so the `--json` field list is the one contract every transport meets.
- One host may arrive through several feeds (an SSH host that also exports to the hub). Section 17 merges them by
  `host.id`.

## Part A — the SSH pull MVP

### 2. Hosts (`~/.agentglass/config.json`, section `fleet`)
```json
{"fleet": {
  "hosts": [
    {"name": "ws",  "ssh": "bjoern@workstation"},
    {"name": "vm1", "ssh": "vm1", "agentglass": "~/.local/bin/agentglass", "redact": true},
    {"name": "old", "ssh": "old-laptop", "enabled": false}
  ],
  "localName": "local", "refreshSeconds": 60, "days": 7, "timeoutSeconds": 90
}}
```
- `name`: `^[a-z0-9][a-z0-9-]{0,15}$`, unique, not equal to `localName`. It is the badge, the filter value, the
  `@host` suffix and the cache file name.
- `ssh`: what `ssh` gets as its destination: an alias from `~/.ssh/config` or `[user@]host`. ssh itself resolves it
  (keys, ProxyJump, Tailscale SSH all work unchanged). Validated: `^[A-Za-z0-9._%+@:\[\]-]+$`, must not start with
  `-` (an option injected as a destination), at most 255 characters.
- `agentglass`: the remote binary, default `agentglass`. `~/` at its start means the remote home. Validated:
  `^(~/)?[A-Za-z0-9._/+-]+$`.
- `redact` (default `false`): the host answers with `--redact` (fake titles, projects, paths; section 11).
- `enabled` (default `true`): `false` keeps the entry without pulling.
- `localName` (default `local`): the name of this machine in badges, filters and `--json`.
- `refreshSeconds` 15–3600 (default 60), `days` 1–90 (default 7), `timeoutSeconds` 10–600 (default 90).
- Exactly one transport key per entry: `ssh` (this spec, Part A/B), `dir` (a snapshot drop directory, section 15),
  or `otlp` (a hub directory, [otlp-hub](../otlp-hub/spec.md)). An entry with none, or several, is skipped with a
  toast. `{"name": "nas", "dir": "~/Sync/agentglass/nas"}`; `{"name": "hub", "otlp": "~/.agentglass/hub"}` is a hub
  *source*: every host found in it becomes a fleet host (otlp-hub section 2).
- `snapshot` (ssh hosts, default `true`): use `fleet snapshot` (Part B) and fall back to `fleet pull` when the host's
  agentglass is older; `false` forces the pull. `watch` (ssh hosts, default `true`): run the live stream (16).
- `reprice` (fleet-wide, default `true`): price every host's table-priced usage with this machine's price table (14).
- Other invalid values are skipped with one startup toast per entry (the `otlp` section's rule:
  `src/features/otlp/config.ts:30-58`).
- At most 32 hosts; more are ignored with one toast.

### 3. Host identity (`src/util/hostid.ts`, shared with otlp-complete)
- `hostId()`: the first 16 hex digits of SHA-256 (`src/util/sha256.ts`) of
  `"agentglass/host/v1|" + machineId + "|" + uid`.
  - `machineId`: Linux `/etc/machine-id` (else `/var/lib/dbus/machine-id`); macOS `IOPlatformUUID` from
    `ioreg -rd1 -c IOPlatformExpertDevice` (one spawn, cached for the process).
  - The uid is part of it: two users on one machine have two transcript sets and are two hosts.
  - Override and fallback: `~/.agentglass/host-id` (one line, 16 hex digits). If the file exists it wins. If no
    machine id can be read, a random id is written there (mode 0600) and used from then on. Containers built from
    one image share `/etc/machine-id`: their owners write distinct `host-id` files (documented).
- `hostName()`: `uname -n` up to the first dot, as the OTLP exporter does today.
- The viewer computes its own `hostId()` too. A remote report with the viewer's id (the local machine listed as a
  host) or with the id of an earlier entry (one host under two aliases) is not merged; `fleet status` names the
  entry it duplicates and the TUI toasts it once.

### 4. The remote side
#### 4.1 `agentglass fleet pull`
What the viewer runs on each host. One process, one ledger load (cheaper than `--json` and `cost --json` apart:
those would index twice).

```
agentglass fleet pull [--days N] [--redact]
```
Output: JSON lines, in this order:
1. `{"hello": {format: "agentglass-fleet/v1", version, hostId, hostName, os, tzOffsetMin, redact, days, now}}`
2. `{"cost": <exactly the cost --json object>}`
3. `{"allowance": {claude, codex}}` (7.4)
4. one `{"s": <exactly the jsonSess object>}` per top-level session updated within `days` or live, newest first.
5. `{"end": {sessions: n}}` — a report without this line is incomplete and rejected (a cut connection).

- The objects are produced by the same functions as `--json` (`jsonSess`) and `cost --json` (`json()` in
  `cost-cli.ts`, exported for this). Their documented fields are the contract; new fields may appear, none disappear
  within `agentglass-fleet/v1`.
- Lines instead of one document: the viewer parses a bounded number of lines per TUI tick (section 6), so a 900-row
  report never stalls a frame.
- The host's own `fleet` config is ignored (no recursion), and the command never pulls other hosts.
- Exit 0. Under `AGENTGLASS_AGENT` detection it behaves the same (the output is already JSON).
- `--days` defaults to 7, range 1–90.

#### 4.2 `agentglass fleet serve` (forced command)
The recommended `authorized_keys` line on each host restricts the viewer's key to read-only agentglass output:

```
restrict,command="/home/me/.local/bin/agentglass fleet serve" ssh-ed25519 AAAA… agentglass-viewer@laptop
```
- `restrict` (OpenSSH ≥ 7.2) turns off PTY, port, agent and X11 forwarding and `~/.ssh/rc`. An optional
  `from="100.64.0.0/10"` (a tailnet range, or the viewer's address) limits where the key may connect from.
- `fleet serve` reads `SSH_ORIGINAL_COMMAND`, splits it into words (no shell; single and double quotes and
  backslashes as POSIX `sh` does for plain words; any of `` ` $ ; | & < > ( ) `` or a newline outside quotes →
  refused), and allows exactly:
  - `<anything ending in agentglass> fleet pull [--days N] [--redact]`
  - `<…agentglass> fleet snapshot [--peer <16 hex>] [--ack <16 hex>] [--full] [--days N] [--redact]` (Part B, 12)
  - `<…agentglass> fleet watch [--redact]` (Part B, 16)
  - `<…agentglass> --version [--json]`
  Everything else exits 126 with `agentglass fleet serve: only fleet pull/snapshot/watch and --version are allowed`.
- The allowed command runs as a child: `execFileSync(process.execPath, ["fleet", "pull", …], {stdio: "inherit"})`,
  with `AGENTGLASS_REDACT=1` in its environment when the request has `--redact` (the flag is process-wide, fixed at
  start: `redact-on.ts:5`).
- `fleet serve --redact` (in the `command=` string) forces redaction for every request on that key, whatever the
  viewer asks. This is the host owner's control at the source.
- Outside an SSH forced command (`SSH_ORIGINAL_COMMAND` unset) it prints usage and exits 2.

#### 4.3 `agentglass fleet authorize <public-key-file> [--from <cidr>] [--redact]`
Run **on the remote host**. It prints the line of 4.2 with this binary's absolute path (`process.execPath`) and the
key from the file (one `ssh-…`/`ecdsa-…`/`sk-…` line, at most 16 KB, validated). It never writes
`authorized_keys`: the user appends the line, so no tool edits SSH configuration.

### 5. Transport: the SSH feed (`src/features/fleet/ssh.ts`)
1. **Command.** One `ssh` per refresh:
   ```
   ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2
       -o Compression=yes -o ControlMaster=auto -o ControlPath=<run>/f-<h12> -o ControlPersist=600
       <ssh target> <agentglass> fleet pull --days <N> [--redact]
   ```
   - `AGENTGLASS_SSH` names another ssh command (tests use a fake; probed once like `AGENTGLASS_CURL`).
   - `BatchMode=yes`: never a password or passphrase prompt; a key that needs one fails with a clear status
     ("ssh needs a key without a prompt, or ssh-agent").
   - The destination and the remote words are separate argv entries after the options; the remote words are each
     single-quoted for the remote shell (a leading `~/` stays unquoted so the remote shell expands it). Under a
     forced command the remote words are only `SSH_ORIGINAL_COMMAND`; serve parses them (4.2).
   - No secret is ever in argv or in the environment: ssh finds keys through its own config and agent.
2. **Connection sharing.** `ControlPath` is a literal short name, `<run dir>/f-` + the first 12 hex digits of
   SHA-256 of the destination, not `%C` (40 digits). If `len(path) + 17 > 107` (measured limit), the feed runs without
   `ControlMaster`/`ControlPath` and `fleet status` says "connection sharing off: the run directory path is too
   long". `ControlPersist=600` keeps the master 10 minutes after the last pull; quitting the TUI does not kill
   masters (other viewers may share them), `fleet status --close` sends `ssh -O exit` to each.
3. **Never on the tick.** `start()` spawns, detached, a fixed shell snippet with the paths and the argv as positional
   parameters (no string built from config):
   ```sh
   d=$1; k=$2; shift 2
   "$@" > "$d/$k.tmp" 2> "$d/$k.err"; rc=$?
   [ "$rc" = 0 ] && mv -f "$d/$k.tmp" "$d/$k.jsonl"
   echo "$rc" > "$d/$k.rc.tmp" && mv -f "$d/$k.rc.tmp" "$d/$k.rc"
   ```
   The `.rc` file appears last and atomically: its mtime is the completion signal. `posix.ts` gains
   `detachedPid(cmd, args): number` (the same spawn, returning `ch.pid`); the pid goes into
   `<fleet dir>/<k>.pid`.
4. **Timeout.** A run older than `timeoutSeconds` is killed: `process.kill(-pid, "SIGTERM")` (the detached child
   leads its own process group, so `sh` and `ssh` go together), else `process.kill(pid)`. Only pids this process
   spawned (kept in memory) or found in our own `.pid` file with a matching start time are ever killed. The status
   becomes "timed out after 90 s (first pull indexes the host's history; try again)".
5. **Concurrency and cadence.**
   - At most 4 pulls at once; the rest wait their turn (round robin by last try).
   - A host is due `refreshSeconds` after its last finished pull. While the TUI is unfocused or idle (the
     adaptive-refresh signal), the interval is `max(refreshSeconds, 300)`.
   - After a failure the next try backs off: 30 s, 60 s, … up to 15 minutes, reset on success.
   - The palette action **"fleet: refresh hosts now"** starts every enabled host at once (still ≤ 4 in parallel).
6. **Exit codes → status.** 0 = ok; 255 = ssh error (the first line of `.err`: "Permission denied
   (publickey)", "Could not resolve hostname", "Connection timed out", "Host key verification failed"); 127 =
   "agentglass not found on <host>: set fleet.hosts[].agentglass"; 126 = refused by `fleet serve`; 2 with
   "unknown command fleet" in `.err` = "agentglass on <host> is older than fleet (<version>): update it there";
   a report with a newer `format` major = "<host> runs a newer agentglass: update this one". A missing `end` line →
   "incomplete report (connection cut)", the previous report stays.

### 6. Store, cache and staleness (`src/features/fleet/store.ts`)
- Directory `~/.agentglass/fleet/` (`AGENTGLASS_FLEET_DIR` for tests), checked and created 0700 with `secureDir`.
  Per host key `k` = `name` (+ `.r` when redacted): `k.jsonl` (last complete report), `k.tmp`, `k.err`, `k.rc`,
  `k.pid`. Files 0600.
- `poll()` stats `k.rc`. When its mtime moved, the feed reads `k.jsonl` in windows of at most 256 lines per tick
  (`readLines`, as `--watch` does) and swaps the new report in when the `end` line arrives.
- At start, the cached `k.jsonl` of every enabled host is loaded as its current report (age = now − `hello.now`
  corrected by the clock skew seen at that pull), so the TUI shows remote rows before the first pull finishes.
- **Fresh / stale / offline.** A report is *fresh* while its age ≤ `2 × interval + timeoutSeconds`. Beyond that it is
  *stale*: rows are dimmed, show the age instead of activity, and count as not live (no running glyph, no
  attention, no remote alarm toasts). Its cost figures still count in totals, marked `≈` with the host named in the
  tooltip line. A report older than 7 days is shown in `fleet status` only.
- **Redaction and the cache.** A redacted report is stored under `k.r.jsonl`, an unredacted one under `k.jsonl`. A
  viewer under `--redact` reads only `.r` files and pulls with `--redact`, so cached real names never appear on a
  redacted screen.
- Clock skew: `hello.now` vs the viewer's clock at the `.rc` mtime; a skew over 2 minutes is shown in
  `fleet status` and ages use the viewer's clock.

### 7. Merge
#### 7.1 Host-qualified sessions
- `Sess` gains `host: string` (`""` = this machine), `rlive: boolean` (the report's `live`) and `rat: number` (the
  report's time, viewer clock). `newSess` defaults them to `""`, `false`, `0`.
- A remote row is a `Sess` built from a `jsonSess` object: `h`, `id`, `title`, `cwd`, `branch`, `remote`, `model`,
  `mtime` (`updated`), `status`, `kind`, tokens, `cost` (`costUsd`, `null` → −1), billing, unpriced, `tools`, lines,
  `attention`, `stuck`, and the `repo` and `alerts` objects (kept on the row for preview and `--json`). `pid` stays
  0, `path` = `"@" + host + "/" + h + ":" + id` (never a file), `headDone = true`.
- Remote rows are **not** in the `sessions` map: `hosts.ts` keeps them, `buildView` appends them to the roots
  before sorting. Every local loop over `sessions` (ledger, procs, watchdog, export, cost) stays local by
  construction.
- `isLive(s)` (`src/model/sessions.ts`): `s.pid > 0 || (s.host !== "" && s.rlive && fresh(s.host))`. The list sort,
  the status glyph and the `live`/`state` attributes use it.
- `H.enrich` and `H.complete` (`hooks.ts:72-73`), `loadHead` and `loadTail` return at once for a remote row.
- Session refs: `<harness>:<id>@<host>` (`agentglass fleet --json` rows, `fleet open`). Without `@host` a ref
  resolves locally first (unchanged behavior for every existing command).

#### 7.2 Cross-host overlap
- Hosts whose reports are `exact` (snapshot, `dir`, hub) merge exactly by message ownership (section 13): no `≈`.
- For a host on the Part A pull (an older agentglass there, or `snapshot: false`), the merge cannot see messages. The
  same `(harness, id)` reported by such a host and another host is the same session read twice: both rows stay, each
  with an `≈` after the cost, and the fleet total carries `≈` and "N sessions seen on 2+ hosts may be counted twice"
  (Stats line, `fleet status`, `fleet cost --json` `overlap`). A Claude history copied under a **new** session id is
  invisible to this rule; `fleet status` says "update agentglass on <host> for an exact merge".
- Within one host nothing changes: each host's own agentglass already counts a copied Claude message once
  (`src/features/usage/owners.ts`); section 13 extends that rule across hosts.

#### 7.3 Cost and budget
- **Part A (pull reports)**: fleet cost = the local `costNow("")` plus each host's `cost` object read into
  `ModeSum`s (`today`, `week`, `month`, `month.projected.byMode`), summed with `addSum`. Each host prices with its own
  table and day boundaries; `fleet status` shows "prices differ" / "UTC+2 vs UTC−5".
- **Part B (exact reports)**: fleet cost is computed by the viewer from the merged day buckets (13.4) re-priced with
  its own table (14), in the viewer's time zone, through the same `sumDays`/projection code the local Stats use. The
  hosts' `cost` objects are then only shown in `fleet status` for comparison.
- **Budget**: the local `budget` config applies to the fleet when at least one host is configured: the state is
  `budgetState(budget, fleetMonth, fleetProjByMode)` (`costs.ts:159`). `approx` is true only when a Part A host or a
  stale host contributes. Hosts' own budgets are ignored by the viewer (one account, one budget).
- **Projection**: Part B — the local projection functions (`projectToday`, `projectMonth`, `costs.ts:101-112`) over
  the merged hourly profile; Part A — the sum of the hosts' projections, `≈` when a host lacks history.

#### 7.4 Allowance (Claude 5 h / 7 d, Codex rate limits)
- `fleet pull` adds `allowance`:
  - `claude`: `{account, fetchedAt, h5: {pct, reset}, d7: {pct, reset}}` from the same guarded reader
    (`allowanceOf`). `account` = the first 12 hex digits of SHA-256 of `"agentglass/account/v1|" + accountUuid`,
    where the uuid comes from inside the `cachedUsageUtilization` block when present, else `""`. No e-mail, name or
    organisation field is read.
  - `codex`: the newest `rate_limits` windows the host saw, with their event time.
- The Claude figure is the **account's** utilization as the service reported it, not a per-machine share. The fleet
  gauge therefore takes, per account, the window with the newest `fetchedAt` across hosts; it never sums. An
  unknown account (`""`) is treated as one account. Codex: the newest event across hosts.

### 8. TUI
- **Opt-in.** Remote rows, the header host segment and the Stats fleet line exist only when `fleet.hosts` has an
  enabled entry. `--no-fleet` (or `AGENTGLASS_FLEET=0`) starts the TUI without pulling or showing hosts.
- **List.** A host tag in the `H.rowBadges` slot: up to 4 characters of the name in the dim accent color (`ws`,
  `vm1`), local rows untagged. At 80 columns the tag takes the slot's existing room; the title shrinks by at most
  4 cells. Stale rows are dimmed and show `2h?` in the age column. Overlapping rows show `≈` after the cost.
- **Header.** After the cost widget: `· 3 hosts`; with problems `· 3 hosts · vm1 stale 2h` (yellow) or
  `· 3 hosts · vm1 ✗` (red, unreachable with no cached report). Narrow widths drop the details first, then the
  segment.
- **Cost widget.** The "today" figure is the fleet figure when hosts are configured (`≈` when any contribution is
  stale or overlapping); the budget color follows the fleet budget state (7.3); the allowance gauges follow 7.4.
- **Stats.** One line under the summary: `fleet  local ≈$12.30 · ws ≈$40.10 · vm1 ≈$3.20 (2 h old) · 3 sessions on
  2 hosts ≈` for the selected period (today / 7 days); hidden without hosts. The per-harness table and charts stay
  local (they need day and call data the report does not carry).
- **Preview and Enter on a remote row.** The preview shows the row's facts (host, harness, title, cwd, branch,
  model, cost with billing tag, tokens, tools, lines, status, alerts) and the line
  `transcript on ws: ssh ws -t agentglass open claude:5f1e…` (the exact command, `ssh` target and binary from the
  config). Enter, the transcript, the call graph, kill, approve, open in harness, compare marks, related events and
  git views toast `remote session on ws: <action> needs the host (ssh ws …)`. One guard,
  `remoteOnly(s, what): boolean`, is called at each of those entry points.
- **Alerts.** A remote alert transition seen in a new report (a rule firing or escalating that the previous report
  did not have) toasts once: `ws · <title>: <message>`. Latency = the refresh interval. No desktop notification in
  the MVP (the rules engine's notify path stays local).
- **Palette.** "fleet: refresh hosts now", "fleet: status" (opens the status text in the detail pane, the same text
  as `agentglass fleet status`).
- **Help** (`?`): a "fleet" section: the badge, the header segment, staleness, `host is …`, what remote rows cannot
  do, the two palette actions, the config path.
- **Footer.** No new keys; on a remote row the footer hint `↵` reads `remote` instead of `open`.

### 9. Filter attribute `host`
- `r("host", [], "session", "enum", false, [], "host", [])` in `attrs.ts`; `enumValues` for `"host"` returns
  `localName` plus the configured names; `canonEnum` maps case-insensitively.
- Value: `s.host || localName`. `host is local`, `host is_not ws`, `host is_one_of ws,vm1` work in the list, Stats
  (local only: Stats does not carry remote rows), `--json`, `fleet --json` and pinned filters.
- A filter with call or day clauses (`tool is Bash`, `day is mo`) matches no remote row: those facts are not in the
  report. The filter bar shows `remote rows have no calls/days` once when such a clause hides remote rows.

### 10. CLI
| Command | Output | Exit |
|---|---|---|
| `agentglass fleet [--json] [--filter …] [--format …] [--fields …] [--refresh] [--strict]` | every host's sessions (local included), newest first; text table with a `host` column, or the `--json` array with a `host` and a `stale` field on every row | 0; with `--strict` 5 when a host is unreachable or stale |
| `agentglass fleet cost [--json] [--refresh] [--strict]` | per host and total: `{hosts: [{name, ok, age, cost}], total: <cost --json shape over the fleet>, overlap, approx}` | 0 / 5; `--check` 3 over the fleet budget |
| `agentglass fleet status [--json] [--close]` | per host: name, transport, target, enabled, last ok age, last error, version, hostId, redact, tz, sessions, live, overlap, connection sharing on/off; `--close` ends the shared SSH connections | 0 |
| `agentglass fleet pull [--days N] [--redact]` | the report (4.1) | 0 |
| `agentglass fleet serve [--redact]` | forced-command entry (4.2) | the child's code; 126 refused; 2 outside SSH |
| `agentglass fleet authorize <key.pub> [--from <cidr>] [--redact]` | the `authorized_keys` line (4.3) | 0; 2 bad key |

- `fleet`, `fleet cost` use cached reports younger than `refreshSeconds`; older ones (or `--refresh`) are pulled
  first, in parallel (≤ 4), waiting at most `timeoutSeconds`. Hosts that fail are listed on stderr
  (`agentglass: vm1: Connection timed out — showing the report from 2 h ago`) and their cached rows are included with
  `stale: true`.
- Without `fleet.hosts`, `fleet` prints `no hosts configured: add "fleet": {"hosts": [{"name": "ws", "ssh": "…"}]}
  to <config path>` and exits 2.
- `--json` rows keep the `--json` field order and add `host` (after `harness`) and `stale` (after `live`). The help
  text (`--help`, `fleet --help`, the JSON help in agent mode) lists the commands, flags, fields and exit codes.

### 11. Security defaults
- **SSH only.** No listener, no port, no token. The viewer uses the user's existing SSH setup.
- **Least privilege.** README and `fleet authorize` recommend a dedicated key with `restrict,command="… fleet
  serve"` per host (4.2), optionally `from=`. Without it the key keeps whatever rights the user gave it; agentglass
  only ever runs `fleet pull`.
- **Redaction at the source.** `redact: true` per host, or `fleet serve --redact` on the host, means the host never
  sends real titles, paths, project names or remotes. The viewer cannot un-redact.
- **What moves.** The `--json` session fields (titles, cwd, branch, git remote with credentials scrubbed, model,
  counts, cost, alerts) and the `cost --json` figures. No prompts beyond the title, no tool arguments or results, no
  file contents, no environment values, no transcript.
- **At rest on the viewer.** Reports under `~/.agentglass/fleet` (0700/0600). `fleet status` shows their age;
  removing a host from the config deletes its files on the next start.

## Part B — exactness: snapshots, ownership, re-pricing, `dir` hosts, live stream

Part A shows each host's own figures. Part B makes the fleet figures exact and live:
- a versioned, incremental snapshot replaces the pull wherever the host's agentglass has it;
- hashed Claude message ids let the viewer count a message copied to several hosts once;
- the viewer prices all usage with one table;
- hosts that cannot be reached drop snapshots into a synced directory;
- a long-lived `fleet watch` stream carries state and alarms within seconds.

Measured inputs: this machine holds **235,188 distinct Claude message ids** in **423,243 occurrences** (`rg` over
`~/.claude/projects`, 0.2 s): copies across files are common even on one machine, so they will be common across
machines that share or copy histories.

### 12. Snapshot format `agentglass-snapshot/v1`
1. **Command:** `agentglass fleet snapshot [--peer <id>] [--ack <gen>] [--full] [--days N] [--redact]`, allowed by
   `fleet serve` (4.2) like `fleet pull`. Output: JSON lines (gzip-compressed by ssh `Compression=yes` on the wire):
   1. `{"snap": {format: "agentglass-snapshot/v1", gen, base, full, …Hello}}` — `gen`: this snapshot's generation
      (random 16 hex digits); `base`: the generation it is relative to (`""` = full).
   2. `{"sess": SessRow}` for every session that changed since `base` (a whole replacement of that session: `s`,
      `days`, `prov`), and for every session when `full`.
   3. `{"own": {key, reset, rows: OwnRow[]}}` for every session whose owned messages grew (rows appended since
      `base`) or changed (`reset: true`, all rows).
   4. `{"gone": [key, …]}` sessions present at `base` that no longer exist or fell out of the window.
   5. `{"cost": …}`, `{"allowance": …}` as in `fleet pull`.
   6. `{"end": {gen, sessions, own}}` — counts of the lines above; a snapshot without a matching `end` is ignored.
2. **Days.** `DayRow` (section 1) per local day of the window, from the session's `Acc`:
   - `tp`: the table-priced rows of `Day.tp` (`src/features/usage/record.ts:17`) as
     `[hour, provider, model, in, out, cacheRead, write5m, write1h, usd]` — what re-pricing needs (14);
   - `hx`: harness-priced cost per provider (`[provider, usd]`: pi/OpenCode/fx reported costs, Kiro credits with a
     rate) — kept as sent;
   - `unk`, `um` (unpriced tokens per model), `uc` (credits), `tools`, `turns`, calls and errors of that day.
3. **Generations and acknowledgements (no lost deltas).** The host keeps, per peer, a small state file
   `~/.agentglass/fleet-peers/<peer>.json` (0600): the last two generations it produced — `acked` and `pending` —
   each with a per-session signature (`size:mtime:ownN:ownSig`). A request names the generation the viewer fully
   applied (`--ack`):
   - `ack == pending.gen` → pending becomes acked; the new snapshot is relative to it;
   - `ack == acked.gen` → the last one was lost; the new snapshot is relative to acked again;
   - anything else, no state, or `--full` → a full snapshot.
   The viewer acknowledges only after it applied the `end` line. `--peer` is the viewer's `hostId()`; the host keeps
   at most 16 peers (oldest dropped: that viewer gets a full snapshot next time).
4. **Size.** A full snapshot of a busy host is dominated by the own rows (13.1): ~235 k rows × ~60 bytes ≈ 14 MB of
   JSON, about 5 MB with SSH compression, once. Deltas carry only new messages and changed sessions: a minute of a busy
   host is a few KB.
5. **Fallback.** A host without `fleet snapshot` (exit 2 "unknown command") is pulled with `fleet pull` (Part A) and
   marked "update for an exact merge" in `fleet status`.

### 13. Message ownership across hosts (exact merge)
1. **Per-message rows on the source.** The ledger keeps owned message ids per Claude log (`Acc.mo`, id → order key,
   `src/features/usage/owners.ts:31-45`) but not their usage. A sidecar keeps it:
   `~/.agentglass/cache/msgrows/<sha256(path)[0:16]>.tsv`, one line per owned message
   (`h key day hour model provider in out cacheRead write5m write1h usd priced`), appended by a booking tap
   (`setBookTap`, `record.ts:400`) when the Claude adapter books a message, rewritten when `OWN.restart` re-reads a log
   (`ledger.ts:78`). `h` = the first 16 hex digits of SHA-256 of `"agentglass/msg/v1|" + message id`. A log without a
   sidecar (first snapshot after upgrading) is re-read once with the tap on, inside the snapshot run (bounded like a
   cold index).
2. **The rule.** Over all hosts' own rows (local included, from the local sidecars), a message `h` belongs to the
   occurrence with the smallest order key (the copy's timestamp × 2 + copied flag, the `owners.ts` key); ties go to
   the smaller `hostId`, then the smaller session key. Within one host nothing changes (the host already decided).
3. **Applying it.** For each occurrence that is not the owner, the viewer subtracts that row's tokens and cost from
   the session's shadow day bucket (13.4): from `tp[hour, provider, model]` when `priced`, else from `unk`/`um`.
   The subtracted amount is exactly what the host booked for that message, so the result equals a single machine
   reading every copy.
4. **Shadow ledger.** For every exact remote session the viewer builds an `Acc` from its `DayRow`s ("shadow
   entry", never persisted in the local ledger file, never in `sessions`). Fleet cost, projection, budget, Stats'
   fleet line and `fleet cost` sum local and shadow entries through the existing `addDay`/`sumDays` code.
5. **What stays approximate.** Tool calls, turns and lines of a copied history count in each session that holds
   them (per-session figures are per file, as on one host). Tokens, cost and models are exact. A Part A host in the
   fleet keeps the `≈` of 7.2.
6. **Collisions.** 64-bit hashes: for 1 M distinct messages the chance of any collision is about 3 × 10⁻⁸. A
   collision would hide one message's usage; accepted.
7. **The OTLP hub feeds the same index:** it hashes `gen_ai.response.id` of Claude `chat` spans with the same prefix
   and builds own rows from the spans' usage ([otlp-hub](../otlp-hub/spec.md) section 7), so a session that one
   host exports and another host's snapshot also holds is still counted once.

### 14. Local re-pricing
- `fleet.reprice: true` (default): the viewer re-prices every shadow entry's table-priced rows with its own price
  table through `reprice(a)` (`record.ts:382`), as it re-prices local history today (`repricer.ts`). One table
  prices the fleet; a price set on the viewer (`agentglass prices set`) applies to every host.
- Harness-priced cost (`hx`) and Kiro credits keep the host's figure (they are the harness's own numbers).
- Unpriced remote models appear in the viewer's unpriced list and in `$` (model-prices) like local ones; pricing
  them there prices them for the whole fleet.
- `reprice: false` keeps each host's `usd`; `fleet status` then shows "prices differ" when `priceSig` differs.
- **Time zones.** Day rows are re-bucketed into the viewer's zone by shifting `(day, hour)` by the difference of the
  offsets (whole hours; a half-hour zone rounds toward the host's hour, documented). The viewer's "today" is then the
  same for every host.

### 15. `dir` hosts: snapshots through a synced directory
For machines the viewer cannot reach (a laptop behind NAT, a machine that is often asleep):
1. **Writer on the host:** `agentglass fleet drop <dir> [--every 5m] [--redact]`. Without `--every` it writes once
   (for cron or a systemd/launchd timer); with it, it loops. It is its own peer (`--peer drop`) and acknowledges a
   generation itself after the file is complete.
2. **Layout** in `<dir>` (any sync tool: rsync, Syncthing, a network share):
   - `<hostId>.base-<gen>.snap.gz` — a full snapshot (written at start, daily, and when the deltas since the base
     exceed half its size);
   - `<hostId>.delta-<n>-<gen>.snap.gz` — a snapshot relative to the previous file's generation, `n` counting up;
   - each file written as `.tmp` and renamed when complete (sync tools copy only finished files or rename their own
     temporaries);
   - the writer deletes deltas older than the newest base and bases older than the previous one, after 24 hours.
3. **Reader on the viewer** (`kind: "dir"`): applies the newest base and then the contiguous chain of deltas whose
   `base` matches; a gap (a delta not synced yet) waits; a chain that never closes within an hour → falls back to
   the newest base and says so in `fleet status`. Files are opened only if owned by the user and not group- or
   world-writable (a shared folder can be written by others). Decompression: `zlib.gunzipSync` (verified in a
   scriptc 0.1.7 native build on this machine: a 171 KB gzip body to 4.0 MB in 5–9 ms).
4. **Freshness:** a drop is fresh while its newest file is at most `2 × every + 10 min` old. Live state from a
   drop is never shown as running (it is minutes old); alarms from it are not toasted.
5. **Privacy:** a drop directory is synced to other machines and possibly to a sync provider: `fleet drop` warns
   when `--redact` is off and the directory is not under the user's home, and the README recommends `--redact` for
   drops through third-party sync.

### 16. Live stream: `fleet watch`
1. **Remote command:** `agentglass fleet watch [--redact]` (allowed by `fleet serve`). It runs the `--watch` poll
   loop's state and rules parts only (no event content) and prints JSON lines:
   - `{"hello": …}` once;
   - `{"live": LiveRow}` when a top-level session's `live`, `busy`, `attention`, `approval` or `stuck` changes,
     once for every live session at start, and every 300 s while live;
   - `{"alert": {key, rule, severity, state, value, threshold, labels, message}}` per rules transition;
   - `{"turn": {key, done: true, at}}` when a turn closes (the viewer then pulls a snapshot early: costs move);
   - `{"beat": now}` every 30 s.
   The state rule (`live`, `busy`, `attention`, `approval`, `stuck`) is one function, `sessState(s)` in
   `src/model/state.ts`, shared with otlp-complete's `session.state` records; whichever plan lands first creates it.
2. **Viewer:** per host with `watch: true` and an exact-capable agentglass, one detached
   `ssh … fleet watch >> <fleet dir>/<k>.watch.jsonl` (over the shared connection). The tick tails the file with a
   byte cursor (≤ 256 lines per tick). Restarted with backoff (5 s doubling to 5 min) when it ends; killed on quit;
   when the file passes 16 MB the viewer restarts the stream into a fresh file.
3. **Effect:** a host is live-fresh while its last `beat` is ≤ 90 s old. `LiveRow`s override the snapshot's `live`,
   `attention` and `stuck` for that session; the list's running glyph, attention badge and sort follow within about
   a second plus the round trip. Remote `critical` alert transitions also go through the local desktop notification
   path (`OS.notify`, with `AGENTGLASS_NOTIFY=0` respected); all transitions toast. A `turn` line schedules the next
   snapshot within 5 s (at most one per 10 s per host).
4. **Cost:** one long-lived ssh channel and one remote agentglass process per host; the remote process does what a
   headless `--watch` does (Task budget: ≤ 1 % of one core on the host).

### 17. One host through several feeds
- A host is its `hostId`. When two feeds deliver reports for the same id (an SSH host that also exports to the OTLP
  hub; a laptop with both a `dir` drop and SSH when at home), `hosts.ts` keeps one `RemoteHost` and per field takes:
  sessions, days and own rows from the freshest **exact** report (snapshot or `dir` over hub when equally fresh,
  since the snapshot carries the host's own ownership decisions and billing modes); live state from the freshest
  live source (`fleet watch`, the hub's logs stream).
- Rows are never duplicated by a second feed of the same host; `fleet status` lists the feeds per host.

## Failure modes
- ssh missing → `fleet` exits 2 "fleet needs ssh (AGENTGLASS_SSH)"; the TUI shows the header segment `hosts: no ssh`
  once.
- A host asks for a password, passphrase or host-key confirmation → `BatchMode` fails it; status names the cause.
- A slow host (cold index, 19–42 s measured) → the first pull may hit the timeout on very large histories; status
  says to retry; the next pull finds the warm ledger.
- A cut connection mid-report → no `end` line → the previous report stays.
- Disk full or the fleet dir not ours → no pulls, one toast with the reason (`secureDir`'s text).
- The remote clock is wrong → ages use the viewer's clock; skew shown in status.
- Two viewers pull the same host → each has its own spool; they may share the SSH master (same `ControlPath` in the
  same run dir only).
- A remote session id appears that is also a local id (same session read on both machines through a shared
  directory) → exact hosts: the ownership rule (13) counts each message once; Part A hosts: overlap rule 7.2.
- A snapshot is lost in transit → the next request acknowledges the older generation and gets a delta from it (12.3).
- The peer state on the host is deleted or the host restored from a backup → the `ack` no longer matches → full
  snapshot.
- A `dir` chain has a gap (sync lag) → the reader waits on the last complete generation; after an hour it rebuilds
  from the newest base (15.3).
- `fleet watch` dies or the link drops → backoff restart; the host's live state turns stale after 90 s without a
  `beat`, rows stop showing as running.
- The msgrows sidecar is missing or corrupt for a log → the snapshot re-reads that log once with the tap on; a line
  that does not parse → that log's rows are rebuilt.

## Privacy
- Nothing leaves a host unless the user configured it on the viewer and the host's SSH accepts the key.
- The report holds metadata and titles; `redact` removes titles and identity at the source.
- No account e-mail, name or organisation is read; the Claude account key is a salted hash of a uuid (7.4).
- The viewer never sends local data to a host: the remote command carries only `--days N`, `--redact`, and for
  snapshots its own `hostId` and the acknowledged generation.
- Message ids leave a host only hashed (salted with a fixed prefix); per-message rows carry counts and cost, no
  content.
- `dir` drops can pass through third-party sync: `fleet drop` warns without `--redact` outside the home directory.

## Interactions with other specs
- **otlp-complete**: `host.id` on every exported resource uses `hostId()` from section 3, so the OTLP hub and the
  SSH feeds name a host the same way. Whichever plan lands first creates `src/util/hostid.ts` (section 3) and
  `src/model/state.ts` (`sessState`, 16.1).
- **otlp-hub**: a third feed (`kind: "otlp"`) of the model in section 1; it builds `SessRow`s with days and own rows
  from spans, `LiveRow`s from otlp-complete's logs stream, and joins the exact merge of section 13 through the same
  hashed message ids. Feed precedence per host: section 17. Fleet Part B and otlp-hub can be built in parallel; both
  need Part A's `model.ts`/`hosts.ts` (fleet T2, T6).
- **otlp-export**: unchanged. Its deterministic ids carry no host, so the same copied session exported from two
  hosts lands on the same trace ids; the hub feed relies on that.
- **filter-language**: a new session attribute `host` (9); the attribute catalogue and `eval.ts` gain one entry each.
- **cli-agent-mode**: `fleet --json` follows `--format`/`--fields`; inside an agent, `fleet` is allowed (read-only),
  `fleet serve` is not meant for agents (it exits 2 without `SSH_ORIGINAL_COMMAND`).
- **command-palette**: `H.dynActions` gains the two fleet actions; `agentglass open <ref>@<host>` prints the ssh
  command instead of opening (the transcript is remote).
- **adaptive-refresh**: the unfocused/idle signal stretches the pull interval (5.5).
- **honest-costs**: billing modes, `budgetState`, `addSum`, the allowance guard are reused unchanged; the budget
  applies to the fleet sum (7.3).
- **model-prices**: `reprice(a)` and `Day.tp` re-price shadow entries (14); unpriced remote models show in `$`.
- **rules-config**: remote alerts are the host's own rule results (the remote `rules.json`); the viewer does not
  re-evaluate them.
- **tui-footprint / macos-footprint**: the tick does at most a `stat` per host and ≤ 256 parsed lines per tick; no
  process is spawned on the tick except a due pull (≤ 4 per minute per host set).

## Testing
- `fleet/config.check.ts`: valid and invalid names, targets (`-oProxyCommand=x` refused), binary paths, ranges,
  duplicates, unknown transport kept as "needs newer agentglass", 33 hosts → 32.
- `util/hostid.check.ts`: machine-id fixture → stable id; uid changes it; `host-id` file wins; missing machine id →
  random id written 0600 and reused.
- `fleet/pull.check.ts` + `scripts/fleet.test.sh`: `fleet pull` on fixture homes: line order, `end` line, every
  `s` object equal to the matching `--json` object (field by field), `cost` equal to `cost --json`, `--days`
  window, `--redact` output has no fixture title or path.
- `fleet/serve.check.ts`: word splitter (quotes, backslashes), refusal of `;`, `$(…)`, backticks, `|`, newlines,
  other subcommands, extra flags; `--redact` forced by serve's own flag; outside SSH → exit 2.
- `fleet/ssh.check.ts`: argv builder (option order, quoting, `~/`, ControlPath length rule at 107), status mapping of
  exit codes and stderr lines.
- `scripts/fleet.test.sh` with a fake `ssh` (`AGENTGLASS_SSH`) that runs the local binary on a second fixture home:
  two hosts merge (row count = sum, totals = sum of `cost --json` figures), a host that sleeps past the timeout is
  killed and marked, exit 255 / 127 / 126 / old-version stderr map to their statuses, a cut report keeps the old one,
  `--strict` exits 5, the same `(harness, id)` on two hosts gives `overlap: 1` and `approx: true`, a duplicate host id
  is not merged, a redacted host's cache never holds a fixture title.
- `fleet/hosts.check.ts`: report → rows (`pid` 0, `path` never a file, `isLive` only while fresh), stale transition,
  allowance takes the newest `fetchedAt` per account, budget state over the fleet sum.
- `query`: `host is local`, `host is ws`, a call clause excludes remote rows.
- TUI (tmux, isolated env): rows with badges at 80/120/200 columns, header segment states, Enter on a remote row
  toasts and does not touch a file, palette refresh, `?` section; one TUI at a time, killed after.
- Part B:
  - `fleet/snapshot.check.ts`: generations and acks (pending acked, lost snapshot → delta from acked, unknown ack →
    full), `gone` lines, `end` counts, 16-peer cap, window, `--redact`.
  - `usage/msgrows.check.ts`: the booking tap writes one row per owned Claude message; `OWN.restart` rewrites; rows
    sum to the session's Claude tokens and cost exactly; a missing sidecar is rebuilt.
  - `fleet/merge.check.ts`: two hosts with a copied history (same ids, different session ids) → fleet tokens and cost
    equal one machine reading both files (computed with the local ledger on a fixture home holding both copies);
    owner by key, ties by host id; a Part A host keeps `≈`; local re-pricing changes the fleet cost after
    `prices set`; time-zone shift of day/hour.
  - `fleet/dir.check.ts`: base + delta chain, a gap waits, a stale chain falls back to the base, foreign-owned or
    group-writable files refused, pruning by the writer.
  - `fleet/watch.check.ts`: `LiveRow` changes, 300 s repeat, beats, alert lines; viewer tail with restarts and the
    16 MB rotation; staleness after 90 s; `critical` → `OS.notify` stub once.
  - `scripts/fleet.test.sh` extension: fake ssh hosts with copied Claude histories: `fleet cost --json` `approx`
    false and totals equal the single-home ledger; `fleet watch` through the fake ssh delivers a state change in ≤ 3 s.
- Manual: real `ssh localhost` with a forced-command key in a test `authorized_keys` of a throwaway user or
  container (never the user's own `~/.ssh`), ControlMaster reuse timing.

## Out of scope
- Exact tool-call and turn counts across copied histories (13.5); `cost --by host` rows and per-host Stats charts.
- Remote event content in the live stream (prompts, tool arguments) and opening a remote transcript in the TUI.
- The OTLP hub and `agentglass receive` — [otlp-hub](../otlp-hub/spec.md).
- Windows hosts; hosts without agentglass (they can still export to the hub).

## Decisions
Each: question · options · decision · why · cost if wrong.

1. **What the remote runs.**
   - Options: (a) the existing `--json` and `cost --json` as two commands; (b) one `fleet pull` that prints the same
     two objects as JSON lines; (c) a new snapshot format with day buckets and message ids now.
   - **Decision: (b).**
   - Why: one process loads the ledger once (two commands would index twice: 0.67 s + 1.0 s warm, 19 s + 42 s cold
     measured); the objects stay the documented `--json` contract, so nothing new has to be specified per field;
     lines let the TUI parse a big report across ticks; a `hello` line carries host id, format version and time
     zone, which neither command has today. (c) is Part B (`fleet snapshot`, Decision 17); the pull stays as the
     first deliverable and as the fallback for hosts with an older agentglass.
   - Cost if wrong: hosts need an agentglass with `fleet pull`; an older host is reported as "update it there" in
     one status line.
2. **Where remote sessions appear.**
   - Options: (a) merged into the Sessions list with a host badge; (b) a separate Fleet tab; (c) CLI only.
   - **Decision: (a)**, only when `fleet.hosts` has an enabled entry.
   - Why: the point is noticing a stuck or waiting agent wherever it runs; a separate tab must be visited; the list
     already sorts live first and has a badge slot (`H.rowBadges`). The filter `host is local` (pinnable) gives the
     old view back in one step.
   - Cost if wrong: list noise for people with many busy hosts; mitigated by the pinned filter, `--no-fleet`, and
     `enabled: false`.
3. **Opt-in and network.**
   - Options: (a) configuring hosts is the opt-in, the TUI pulls on start; (b) an extra `fleet.tui: true` switch;
     (c) only `agentglass fleet` pulls.
   - **Decision: (a)**, with `--no-fleet` / `AGENTGLASS_FLEET=0` to skip for one run.
   - Why: a host entry has no other purpose; a second switch is a trap ("I configured it, why is it empty?"). The
     ROADMAP rule "no network unless the user opts in" holds: no entry, no ssh.
   - Cost if wrong: an SSH connection per host at TUI start that a user did not expect; visible in the header.
4. **`--redact` for remote hosts by default?**
   - Options: (a) default on for every remote host; (b) default off, per-host `redact: true`, forced on when the
     viewer runs with `--redact`, and `fleet serve --redact` on the host as the owner's override; (c) redact in the
     viewer only.
   - **Decision: (b).**
   - Why: in the solo case the viewer and the hosts belong to one person; fake titles and paths would make the merged
     list useless for its job (which agent, in which project, is stuck). Redaction must happen at the source to mean
     anything: (c) would put real names on the viewer's disk. A viewer under `--redact` must never show real remote
     names, so it pulls redacted reports and keeps them in separate cache files. The host owner can force it
     regardless of the viewer (`fleet serve --redact`).
   - Cost if wrong: a user who adds a shared or customer machine sees real titles from it until they set `redact`;
     the README's host section says so first.
5. **Cross-host overlap.**
   - Options: (a) ignore; (b) `≈` marks on the same `(harness, id)` on 2+ hosts; (c) exact message-level merge.
   - **Decision: (c) for every host that delivers exact reports (Part B snapshots, `dir` drops, the OTLP hub); (b)
     only for Part A pull hosts** (an older agentglass on the host, or `snapshot: false`).
   - Why: the user asked for exact numbers, and copies are frequent: 235,188 distinct Claude messages appear 423,243
     times on this one machine. (b) remains the honest answer where a host cannot send message ids.
   - Cost if wrong: Part B's sidecar and own rows (13.1, 12.4); a host left on an old agentglass shows `≈` and a
     status hint to update.
6. **Fleet allowance gauge: sum or newest?**
   - Options: (a) sum the hosts' percentages; (b) per account, the window with the newest `fetchedAt`.
   - **Decision: (b).**
   - Why: the Claude figure in `~/.claude.json` is the service's account-wide utilization as last fetched by that
     machine's client, not a per-machine share; summing would double it on two machines. The newest fetch is the
     most accurate. Codex likewise: the newest event.
   - Cost if wrong: if a provider ever reports per-machine shares, the gauge under-reports; the fixture test pins
     the shape.
7. **Which remote sessions travel.**
   - Options: (a) all history; (b) updated within `days` (default 7) plus every live one; (c) live only.
   - **Decision: (b).**
   - Why: measured 3.5 MB for all 2,389 sessions vs 627 KB (82 KB compressed) for the 910 of the last week on a very
     busy host; the list is about now; costs come from `cost`, not from the rows, so totals do not depend on the
     window.
   - Cost if wrong: an old remote session is not in the merged list; `fleet.days` up to 90 widens it.
8. **Refresh cadence.**
   - Options: 15 s, 60 s, 300 s, adaptive.
   - **Decision: 60 s (`refreshSeconds`), 300 s while the TUI is unfocused or idle, a palette action for now.**
   - Why: one pull costs the host about a second of CPU (measured warm), so 60 s is about 1.7 % of one core on the
     host; alarms then arrive within a minute on Part A; `fleet watch` (Part B) brings them to seconds.
   - Cost if wrong: remote alerts up to a minute late; configurable down to 15 s.
9. **ControlPath** (technical).
   - Options: `%C` (40 hex), `%h-%p-%r`, a literal short hash.
   - **Decision: literal `<run dir>/f-<12 hex>`, sharing off when the path would pass 107 bytes.**
   - Why: measured: ssh refuses paths ≥ 108 bytes including a 17-character temp suffix, and then fails the whole
     command (exit 255) instead of connecting without sharing. `%C` alone needs 44 of those bytes; host names make
     `%h…` unbounded.
   - Cost if wrong: none functional; a long run directory loses the 175 ms saving per pull.
10. **Host identity.**
    - Options: (a) the configured name only; (b) a hash of machine id + uid with a file override; (c) a random id
      per install.
    - **Decision: (b).**
    - Why: names collide and change; the viewer must recognise itself and one host under two aliases. Hashing keeps
      the machine id private; the uid separates users; the file fixes containers sharing an image's machine id.
    - Cost if wrong: two containers from one image look like one host until their owners write `host-id` files;
      `fleet status` names the duplicate.
11. **Timeout and parallelism.**
    - Options: 30 s / 90 s / none; 1 / 4 / all in parallel.
    - **Decision: 90 s (`timeoutSeconds`), at most 4 pulls at once.**
    - Why: a cold host indexed for 19–42 s here; 90 s covers larger histories on slower machines without hanging on
      a dead one. Four parallel pulls keep the viewer's own CPU and memory flat while a 5-host fleet refreshes in
      one round.
    - Cost if wrong: a huge cold host times out once; the next try is warm.
12. **Remote transcripts.**
    - Options: (a) stream on demand over SSH into the transcript view now; (b) show the exact ssh command.
    - **Decision: (b).**
    - Why: on-demand streaming is content moving between machines and needs a second forced command (`open
      --print`); the MVP keeps the forced command to read-only aggregates.
    - Cost if wrong: one extra step for the user (copy the command).
13. **Remote alarms.**
    - Options: (a) toast per new transition; (b) toast and desktop notification; (c) nothing.
    - **Decision: Part A (pull, up to a minute old): (a). With `fleet watch` (Part B, seconds old): (b) for
      `critical` transitions, (a) for the rest.**
    - Why: a desktop notification is worth it only while the moment (an approval wait, a stuck agent) is still on;
      the stream makes remote alarms as timely as local ones, so they use the same notify path and the same
      `AGENTGLASS_NOTIFY=0` switch.
    - Cost if wrong: one more notification source; `AGENTGLASS_NOTIFY=0` or `watch: false` per host silences it.
14. **Exit code for partial results.**
    - Options: (a) 0 always, warnings on stderr; (b) non-zero whenever a host fails; (c) (a) plus `--strict`.
    - **Decision: (c), `--strict` → 5** (codes 2–4 are taken: usage, budget/lock, ambiguous/unpriced).
    - Why: a sleeping laptop must not break a cron job or a prompt; scripts that need all hosts ask for it.
    - Cost if wrong: a script without `--strict` reads stale rows; each has `stale: true`.
15. **The remote-host model's name and seam.**
    - Options: (a) feeds deliver `HostReport`s (sessions in the `--json` shape, cost in the `cost --json` shape);
      (b) feeds deliver `Sess` objects; (c) one model per transport.
    - **Decision: (a)**, `HostFeed` → `HostReport` (section 1).
    - Why: the `--json` shape is already the public contract and the thing an OTLP mapper or a snapshot reader can
      target; `Sess` is internal and changes with every spec; one model per transport would triple the TUI work.
      The exact-merge data (`days`, `own`, `live`) are optional fields on the same report, so Part A, Part B and the
      OTLP hub share one model, one merge and one TUI path; otlp-hub references this section instead of defining its
      own.
    - Cost if wrong: a feed that knows more later (per-call rows) adds another optional field, not a new model.
16. **ROADMAP: the built-in OTLP receiver.**
    - Options: (a) keep "a local OTLP receiver" under "Explicitly not planned"; (b) "Later, decision pending";
      (c) plan it now, in [otlp-hub](../otlp-hub/spec.md).
    - **Decision: (c).** The user decided (2026-10-06): world-class log collection and distribution, and agentglass
      should dogfood its own OTLP export end to end.
    - Why: the old entry's own trigger is met: hosts the viewer cannot reach over SSH (laptops behind NAT, CI runners,
      short-lived VMs) hold data on no disk the viewer can read. scriptc 0.1.7 can listen on TCP: a native test build
      here received gzip OTLP/JSON over `http.createServer` with a bearer check (4 MB decoded in 5–9 ms, 27 MB RSS);
      HTTPS works only through the C backend and client certificates are not supported, so mTLS stays on the
      Collector path (otlp-hub decides the details). A receiver turns agentglass's own export into a complete
      collection path without a third-party service.
    - Cost if wrong: a network listener to maintain and secure; otlp-hub keeps it loopback-only by default with a
      token per host, so the exposed surface is opt-in.
17. **Snapshot deltas without lost updates** (technical).
    - Options: (a) time cursor (`--since <ms>`); (b) the viewer stores per-session state and sends it; (c) the host
      keeps per-peer `acked`/`pending` generations and the viewer acknowledges.
    - **Decision: (c).**
    - Why: (a) misses copies with old timestamps and rows appended to old sessions; (b) would put a large state into
      the ssh command line; (c) is small on the host (two signatures per session per peer), stateless on the wire,
      and a lost snapshot is repaired by the next request.
    - Cost if wrong: a few KB of state per peer on each host; 16 peers at most.
18. **Where per-message usage comes from.**
    - Options: (a) store per-message usage in the ledger cache (`VERSION` bump, every user pays); (b) a sidecar per
      Claude log written by the booking tap, used only by fleet; (c) ask the losing host to re-read without the
      shared ids (a round trip).
    - **Decision: (b).**
    - Why: (c) does not work for `dir` hosts or offline hosts, and the answer arrives late; (a) grows every user's
      ledger and forces a re-index; (b) costs only on machines that serve or view a fleet, ~9 MB per 235 k messages,
      and can be rebuilt from the transcripts at any time.
    - Cost if wrong: a one-time re-read of Claude logs on a host's first snapshot (cold-index time, 19–42 s here).
19. **Message-id hash length.**
    - Options: 32, 64, 128 bits.
    - **Decision: 64 bits (16 hex digits), salted with `agentglass/msg/v1|`.**
    - Why: ~3 × 10⁻⁸ chance of any collision among 1 M messages; 128 bits doubles the dominant part of a full
      snapshot for no practical gain.
    - Cost if wrong: one hidden message's usage in a fleet of millions of messages.
20. **Prices across hosts.**
    - Options: (a) each host's own figure; (b) the viewer's table for table-priced usage (default), harness-priced
      cost as sent.
    - **Decision: (b)**, `fleet.reprice: false` for (a).
    - Why: one budget and one projection need one price table; prices set on the viewer then apply everywhere; the
      harness's own reported costs are facts, not table lookups.
    - Cost if wrong: a host with a deliberately different price table is overridden unless `reprice: false`.
21. **Time zones.**
    - Options: (a) each host's local days; (b) re-bucket into the viewer's zone by hour.
    - **Decision: (b).**
    - Why: "today" and the budget month must mean one thing; `tp` rows carry the hour, so the shift is exact for
      whole-hour zones.
    - Cost if wrong: half-hour zones are off by 30 minutes at day edges.
22. **`dir` drop layout.**
    - Options: (a) one full snapshot file overwritten each time; (b) base + numbered deltas, renamed when complete.
    - **Decision: (b).**
    - Why: a full snapshot of a busy host is ~5 MB compressed; rewriting it every 5 minutes is 1.4 GB a day through
      the sync tool. Deltas keep it to KB; renames keep half-written files out of the reader.
    - Cost if wrong: a reader must handle gaps (15.3).
23. **Live stream format.**
    - Options: (a) the full `--watch` JSONL (events with content); (b) state, alerts, turn ends and beats only.
    - **Decision: (b).**
    - Why: the viewer needs "what is running, what needs me"; event content would move prompts and tool output
      between machines, which the fleet avoids by design.
    - Cost if wrong: no remote event tail in the TUI; the transcript stays one ssh command away.
24. **One host through several feeds.**
    - Options: (a) separate rows per feed; (b) merge by `hostId`, exact reports first, live state from the freshest
      live source.
    - **Decision: (b).**
    - Why: a host that is both SSH-reachable and exporting to the hub must not appear twice; the snapshot carries the
      host's own ownership and billing decisions, the hub may carry fresher liveness.
    - Cost if wrong: a field taken from the less fresh feed for up to one refresh.

## Open questions (technical verification during implementation)
1. Does scriptc 0.1.7 lower `process.kill(-pid, sig)` (process group)? If not, kill `sh` by pid and rely on ssh's
   `ServerAliveInterval`/the remote side ending; the plan's Task 4 tests both.
2. `spawn(…, {detached: true})`: does the child lead its own process group in the native build (setsid/setpgid)?
   Checked with `ps -o pgid` in Task 4.
3. The Claude account uuid inside `cachedUsageUtilization`: present in current Claude Code builds? If absent,
   `account` is `""` and all hosts count as one account (the documented default).
4. macOS `ioreg` output format for `IOPlatformUUID` on macos-14 runners (the macOS CI job checks it).
5. Native-build speed of parsing a 900-line report at 256 lines per tick (budget: ≤ 5 ms per tick on the perf host).
6. Book tap coverage: does every Claude booking path (streamed lines, fallback iterations, subagent logs) pass
   through `setBookTap` with the message id at hand? If not, the msgrows tap goes into the Claude adapter's
   `claim()` call site (`claude.ts:254`).
7. Remote `fleet watch` CPU on the perf host (budget ≤ 1 % of a core) with 900 sessions in the window.
8. `zlib.gunzipSync` output-size limit (`maxOutputLength`) lowering in scriptc for `dir` files (a decompression
   bomb in a shared folder); fallback: check the gzip ISIZE trailer and refuse > 256 MB before decompressing.
