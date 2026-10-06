# Fleet: several machines in one view (SSH pull MVP) — spec

Status: **draft** (2026-10-06). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4). Companion spec:
[otlp-complete](../otlp-complete/spec.md) (export completeness; shares the host identity of section 3).

## Goal
`agentglass fleet` and the TUI show the sessions, cost and live state of several machines in one place:
1. Hosts are listed in `~/.agentglass/config.json` (`fleet.hosts`). The viewer pulls each host's own figures over
   SSH. No server, no daemon, no listener, no transcript leaves its host.
2. Every remote session row carries its host: a badge in the list, a `host` attribute in the filter language and a
   `host` field in `--json`. Session keys are host-qualified.
3. Each host's numbers are the numbers that host shows for itself. Where hosts may overlap, the figure says so (`≈`).
4. A host that cannot be reached shows its last result with its age. Nothing blocks the TUI.
5. `agentglass fleet status` says, per host, what works and what does not.
6. One remote-host model (`HostFeed` → `HostReport`, section 1) that later transports (an OTLP file hub, a built-in
   receiver, a snapshot drop) plug into without touching the TUI or the CLI.

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

### 1. The remote-host model: `HostFeed` → `HostReport`
Every transport delivers the same thing: a **`HostReport`**, one host's state at one moment. The TUI, the filter
language and the CLI read only reports; they never know how a report travelled.

```ts
// src/features/fleet/model.ts
export interface Hello { format: string; version: string; hostId: string; hostName: string; os: string; tzOffsetMin: number; redact: boolean; days: number; now: number }
export interface HostReport {
  hello: Hello;          // who produced it, when (source clock), under which privacy mode
  sessions: Obj[];       // jsonSess objects (the `--json` contract), top-level only, updated within hello.days or live
  cost: Obj | null;      // the `cost --json` object of that host, unchanged
  allowance: Obj | null; // {claude: {account, fetchedAt, h5, d7} | null, codex: {at, wins} | null} (7.4)
}
export interface FeedState { report: HostReport | null; okAt: number; tryAt: number; err: string; code: string; busy: boolean } // viewer clock
export interface HostFeed {
  kind: string;                    // "ssh" (this spec); later "otlp" (OTLP file hub), "dir" (snapshot drop)
  start(now: number): boolean;     // begin one refresh in the background; false = one is already running
  poll(now: number): FeedState;    // cheap: stats a file or two, parses only what changed, never blocks
  stop(): void;                    // kill what start() spawned (on quit)
}
```

- `src/features/fleet/hosts.ts` keeps one `RemoteHost {cfg, feed, state, rows: Sess[]}` per configured host and turns a
  new report into rows (section 7). It is the only module that knows hosts exist.
- `HostFeed.kind = "ssh"` is the only feed this spec builds (section 5). The later phases add feeds, nothing else:
  - **OTLP file hub** (`kind: "otlp"`, config `{"name": "ci", "otlp": "<dir>"}`): tails OTLP/JSON files written by an
    OTel Collector's file exporter, maps spans to `sessions`/`cost` and the logs stream of
    [otlp-complete](../otlp-complete/spec.md) to `live`/`attention`/alerts, and dedups by
    `(gen_ai.provider.name, gen_ai.response.id)`.
  - **Built-in receiver** (`agentglass receive`): writes the same files the hub feed reads; no new feed.
  - **Snapshot drop** (`kind: "dir"`): reads a versioned snapshot file a host wrote into a synced directory.
- A report's `sessions` are always the `--json` object shape. A feed that rebuilds sessions from other data (OTLP)
  produces that shape too, so the `--json` field list is the one contract every transport meets.

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
- An entry with another transport key (`otlp`, `dir`) or without `ssh` is kept and shown in `fleet status` as
  "transport `otlp` needs a newer agentglass" (forward compatibility, section 1). Other invalid values are skipped
  with one startup toast per entry (the `otlp` section's rule: `src/features/otlp/config.ts:30-58`).
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
  - `<…agentglass> --version [--json]`
  Everything else exits 126 with `agentglass fleet serve: only "fleet pull" and "--version" are allowed`.
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

#### 7.2 Cross-host overlap (what the MVP does honestly)
- The same `(harness, id)` reported by two hosts (a synced `~/.claude`, a session directory copied to another
  machine) is the same session read twice. Both rows stay, each with an `≈` marker after the cost, and the fleet
  total carries `≈` and "N sessions seen on 2+ hosts may be counted twice" (Stats line, `fleet status`,
  `fleet cost --json` `overlap`).
- Not detectable in the MVP: a Claude session whose earlier messages were copied into a **new** session id on another
  machine (resume of a copied file). Counting such messages once needs per-message ownership across hosts: the
  OTLP hub feed dedups by `gen_ai.response.id`; the snapshot feed would carry hashed message ids. Documented under
  "Out of scope".
- Within one host nothing changes: each host's own agentglass already counts a copied Claude message once
  (`src/features/usage/owners.ts`).

#### 7.3 Cost and budget
- **Fleet cost** = the local `costNow("")` plus, per host with a report, its `cost` object read into `ModeSum`s
  (`today`, `week`, `month`, `month.projected.byMode`) and summed with `addSum`.
- Each host prices with its own price table and its own day boundaries (its time zone). `fleet status` shows
  "prices differ" when a host's version differs and "UTC+2 vs UTC−5" when `tzOffsetMin` differs. Re-pricing
  remote tokens locally needs per-model day buckets the report does not carry (snapshot phase).
- **Budget**: the local `budget` config applies to the fleet when at least one host is configured: the state is
  `budgetState(budget, fleetMonth, fleetProjByMode)` (`costs.ts:159`). `approx` is also true when a stale host or
  an overlap contributes. Hosts' own budgets are ignored by the viewer (one account, one budget).
- **Projection**: the sum of the hosts' projections (each host projects from its own history; the sum of means is
  the mean of the sum when the windows agree). A host without enough history contributes its month-to-date only;
  the fleet projection is then marked `≈`.

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
  directory) → overlap rule 7.2 applies to `local` too.

## Privacy
- Nothing leaves a host unless the user configured it on the viewer and the host's SSH accepts the key.
- The report holds metadata and titles; `redact` removes titles and identity at the source.
- No account e-mail, name or organisation is read; the Claude account key is a salted hash of a uuid (7.4).
- The viewer never sends local data to a host: the remote command carries only `--days N` and `--redact`.

## Interactions with other specs
- **otlp-complete**: owns the OTLP side of the same fleet: `host.id` on every exported resource uses `hostId()` from
  section 3, so an OTLP hub feed (later) and the SSH feed name a host the same way. Whichever of the two plans lands
  first creates `src/util/hostid.ts` with the interface of section 3.
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
- Manual: real `ssh localhost` with a forced-command key in a test `authorized_keys` of a throwaway user or
  container (never the user's own `~/.ssh`), ControlMaster reuse timing.

## Out of scope
- Exact cross-host message dedup (resumed copies under new ids), local re-pricing of remote usage, remote day
  buckets, `cost --by host` rows, Stats charts per host — the snapshot or OTLP feeds.
- Live streaming of remote events (`--watch` over SSH), remote desktop notifications.
- Opening a remote transcript inside the TUI.
- The OTLP hub feed, `agentglass receive`, snapshot drops (ROADMAP "Later").
- Windows hosts; hosts without agentglass.
- Pushing from hosts to the viewer.

## Decisions
Each: question · options · decision · why · cost if wrong.

1. **What the remote runs.**
   - Options: (a) the existing `--json` and `cost --json` as two commands; (b) one `fleet pull` that prints the same
     two objects as JSON lines; (c) a new snapshot format with day buckets and message ids now.
   - **Decision: (b).**
   - Why: one process loads the ledger once (two commands would index twice: 0.67 s + 1.0 s warm, 19 s + 42 s cold
     measured); the objects stay the documented `--json` contract, so nothing new has to be specified per field;
     lines let the TUI parse a big report across ticks; a `hello` line carries host id, format version and time
     zone, which neither command has today. (c) is two to three weeks and only pays for exact overlap and
     re-pricing.
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
5. **Cross-host overlap in the MVP.**
   - Options: (a) ignore; (b) mark the same `(harness, id)` on 2+ hosts with `≈` and say how many; (c) exact
     message-level dedup now.
   - **Decision: (b).**
   - Why: (a) silently double-counts synced directories; (c) needs message ids from every host (snapshot or OTLP
     feed). (b) is cheap, honest, and the case it misses (a copied history resumed under a new id) is documented.
   - Cost if wrong: a fleet total can be too high by the copied part of resumed sessions; the README says how to see
     it exactly later (OTLP hub).
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
     host; alarms then arrive within a minute. Faster needs the live stream (later).
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
    - **Decision: (a).**
    - Why: the TUI is where people look; desktop notifications for a minute-old event would arrive after the moment
      for approvals, and the notify path belongs to the local rules engine. Live notifications come with the stream.
    - Cost if wrong: a user away from the TUI misses a remote alarm; the header still shows it on return.
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
    - Cost if wrong: a later feed that knows more (per-call rows, day buckets) needs an optional field on
      `HostReport`, not a new model.
16. **ROADMAP: the built-in OTLP receiver (phase 4).**
    - Options: (a) keep "a local OTLP receiver" under "Explicitly not planned"; (b) move it to "Later, decision
      pending" with the criteria that would decide it; (c) plan it now.
    - **Decision: (b).**
    - Why: the "not planned" entry said to revisit when a needed signal is missing from on-disk transcripts. Hosts
      the viewer cannot reach over SSH (laptops behind NAT, CI runners, ephemeral VMs) are that case: their data is
      not on any disk the viewer can read. scriptc 0.1.7 can listen on TCP (HTTP; HTTPS only through the C backend;
      no client certificates), so it is feasible, but an OTel Collector with a file exporter (phase 3) covers the
      same hosts without a listener in agentglass. Decide after phase 3 ships, on three questions: do users run a
      Collector at all; does the release toolchain build the TLS server for every target; does a bearer token per
      host plus a tailnet suffice as authentication.
    - Cost if wrong: (b) costs nothing until decided; deciding too early would ship a network listener the product
      has avoided so far.

## Open questions (technical verification during implementation)
1. Does scriptc 0.1.7 lower `process.kill(-pid, sig)` (process group)? If not, kill `sh` by pid and rely on ssh's
   `ServerAliveInterval`/the remote side ending; the plan's Task 4 tests both.
2. `spawn(…, {detached: true})`: does the child lead its own process group in the native build (setsid/setpgid)?
   Checked with `ps -o pgid` in Task 4.
3. The Claude account uuid inside `cachedUsageUtilization`: present in current Claude Code builds? If absent,
   `account` is `""` and all hosts count as one account (the documented default).
4. macOS `ioreg` output format for `IOPlatformUUID` on macos-14 runners (the macOS CI job checks it).
5. Native-build speed of parsing a 900-line report at 256 lines per tick (budget: ≤ 5 ms per tick on the perf host).
