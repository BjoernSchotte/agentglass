# Fleet teams: private, team-scoped session analytics without a central collector — spec

Status: **draft** (2026-10-10). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 3 (after 2026.10.10). Builds on
[fleet](../fleet/spec.md) (snapshots, `dir` drops, exact merge, the `HostFeed` → `HostReport` model) and
[otlp-hub](../otlp-hub/spec.md) (`agentglass receive`); depends on [local-web-api](../local-web-api/spec.md) for the
read model, the `serve --stdio` protocol and the web UI (team, room and member are optional dimensions there; the two
plans share one slice table and are built together). Two phases: **Phase 1** (sections 1–12) is teams over a shared
folder; **Phase 2** (sections 13–15) adds the hub relay, wait data and the MCP tool.

## Goal
A group of people (or one person with several machines) sees one analysis of their coding agents — cost, harness mix,
skills, live presence, budgets — across every harness agentglass reads, without any of them sending data to a vendor,
a company-wide collector, or each other beyond what they chose:
1. **Teams and rooms.** A team has members; a member has devices; a team has rooms. A room allows a set of git
   repositories (by remote, e.g. `github.com/acme/*`) and a field level. A member shares into a room only sessions of
   repos the room allows **and** the member picked. Nothing else leaves the machine.
2. **No central collector.** Every device writes its own sealed snapshots into a team mailbox (a synced folder in
   phase 1; an `agentglass receive` relay in phase 2) and reads the others'. Offline and NAT work like `fleet drop`.
3. **End-to-end sealed.** Snapshots are encrypted per room and signed per member; the folder, the sync service and the
   relay see only opaque ids, sizes and times. Removing a member rotates the room keys: their access to future data
   ends.
4. **Names, not ids.** A member appears under the display name they chose at join (a pseudonym is fine), bound to
   their key; sessions, cost, skills and wait are attributed to them in the TUI, the web UI, `--json` and the API;
   joins, leaves, renames and sharing changes show up in the team's activity log.
5. **TUI and browser.** Everything in the Team tab is also in `agentglass web` (local-web-api), from the same read
   model.
6. **Minutes to a team view.** `agentglass team create` prints one invite code; `agentglass team join <code>` shows one
   consent screen (what leaves, to whom, from when), publishes, and the Team tab shows the group within the next sync.

## Why (user value)
- SaaS observability (Dash0, Datadog, vendor dashboards) needs every machine to ship telemetry to a third party, sees
  one vendor's agent at a time, and is all-or-nothing per company. Developers who want to compare and improve their
  own agent use — a small team, an OSS project's maintainers, one person with three servers and a MacBook — have no
  private option today.
- agentglass already reads every harness (Claude Code, Codex, Gemini CLI, pi, OpenCode, Kiro, fx), prices them, and
  merges hosts exactly. What is missing is people: identity, invites, consent, scoping and revocation.
- The fleet setup for one person needs SSH config, `authorized_keys` forced commands and reachable hosts per machine.
  A team of one with an invite code replaces that for devices behind NAT, laptops that sleep and servers without
  inbound SSH.
- Team questions that need several harnesses and several people: "what does our repo cost per week and per agent?",
  "which harness gets commits out cheapest on this repo?", "which skills does the team load and what do they carry?",
  "who has an agent waiting for approval right now?", "are we on track for the room's budget?".

## Today (current code, with path:line refs — measured, not guessed)
- **Snapshot builder has no scope.** `buildSnap()` takes every top-level session whose mtime falls in the cost days
  (this month + 16 days) or that is live (`src/features/fleet/snapshot.ts:133-142`), plus every other Claude session
  as ownership-only rows (`snapshot.ts:141,192-201`); the cost object is the whole host's `summary("")`
  (`snapshot.ts:208`). The only privacy switch is the process-wide `REDACT` (`src/features/redact-on.ts:5`), which
  fakes names (`snapshot.ts:206` hostName, `snapshot.ts:115` plan) — fake repo names are useless to a teammate.
- **Session rows are the full `--json` object.** `jsonSess()` (`src/features/cli.ts:200-211`) carries title, cwd,
  path, branch, remote, activity, stuck text, alerts, mux labels and git links. A snapshot row is `{s: jsonSess,
  key, days, prov}` (`src/features/fleet/snap.ts:43`); session rows outside the list window are `shortSess()`
  without a `repo` field (`snapshot.ts:113-116`).
- **Drops trust the file owner only.** `fleet drop` writes `<hostId>.base|delta-<n>-<gen>.snap.gz` with tmp + rename
  (`src/features/fleet/drop.ts:62-77`), a new base daily or when deltas pass half the base (`drop.ts:37-47`), prunes
  after a day (`drop.ts:49-60`), and warns when the folder is outside `$HOME` without `--redact` (`drop.ts:95`). The
  reader accepts a file when it is a regular file owned by this uid and not group/world-writable
  (`src/features/fleet/dirfeed.ts:24-30`) — on a synced folder every file is owned by the local user, so anyone who
  can write into the folder can forge any host's data, and anyone who can read it reads everything.
- **Forced command has no project scope.** `fleet serve` allows `fleet pull|snapshot|watch` with `--days`, `--peer`,
  `--ack`, `--full`, `--wait`, `--redact` only (`src/features/fleet/serve.ts:46-77`).
- **Exact merge exists.** The ownership index over hashed Claude message ids decides which host owns a copied
  message (`src/features/fleet/merge.ts:26-30`); `exactMerge(hosts: RemoteHost[], …)` and `fleetCost()`
  (`src/features/fleet/hosts.ts:325,365`) take `RemoteHost` objects (`hosts.ts:36`) built from `fleet.hosts`, capped
  at `MAX_HOSTS = 32` (`src/features/fleet/config.ts:21,84`).
- **Identity.** `hostId()` = SHA-256 of machine id + uid, 16 hex (`src/util/hostid.ts:1-5,20`); the same id goes to
  every fleet viewer and OTLP backend. No member, person or device concept exists.
- **Tokens.** `agentglass receive` stores one write token per host, SHA-256 at rest (`src/features/hub/tokens.ts:1-4,
  20-22,126`); there are no read tokens and no per-team access.
- **Crypto available.** Pure-TS SHA-256 (`src/util/sha256.ts:18,55`), `/dev/urandom` bytes, base64url and a
  constant-time compare (`src/util/rand.ts:8-14,19,28`). No MAC, KDF, cipher or signature anywhere in `src/` (the only
  `ed25519` match is the SSH key-type regex `serve.ts:78`). scriptc 0.1.7 has no crypto module.
- **FFI.** macOS binds `libproc.c` through `--ffi src/platform/darwin/ffi.json` (`build.sh:9-12`,
  `src/platform/libproc.ts:5-11`); `scripts/check.sh:14-16,76` passes the manifest to checks marked `// check: ffi`,
  built with `--backend c`. A `bytes` parameter is `(uint8_t *, size_t)` in C (`src/platform/darwin/libproc.c:27`).
- **Filters and scopes.** Session clauses compile through `sessFilter()`/`sessPass()`
  (`src/features/otlp/export.ts:58-78`); project identity is `Ident.key`, `git:<host>/<path>` from the normalised
  remote (`src/model/project.ts:60-84,87`), the same on every clone; `globMatch()` (`src/features/skills/vis.ts:22`).
- **Tabs.** Sessions, Processes, then `H.tabs`: Stats (`src/features/usage/stats.ts:749`), Repos
  (`src/features/repos/tab.ts:451`), Wait (`src/features/wait/tab.ts:426`); number keys `1`–`9` select
  (`src/input.ts:144-146`). Repos and Wait use `d`/`w`/`m`/`a` for the period (`repos/tab.ts:381`,
  `wait/tab.ts:381`).

### Measurements (2026-10-10, this machine, isolated cache, `nice`)
This host is an extreme case: an agent swarm, 2,997 top-level sessions in the cost window (≈ 65 a day), 242 k
Claude message rows.

| what | result |
|---|---|
| `fleet drop --days 1`, first run (cold isolated cache) | 148.7 s, 717 MB RSS |
| same, warm | 5.9–7.1 s, 412–447 MB RSS |
| base file | 8.8 MB gzip, 21.5 MB plain: `own` lines 18.97 MB (88 %), `sess` lines 2.51 MB (2,997 rows; `s` objects 1.62 MB, day rows 0.86 MB) |
| `--days 7` base | 8.9 MB (the cost days dominate, not the list window) |
| delta after ~2 min (6 live sessions) | 51.8 KB gzip; 226.7 KB plain, of which day rows 83.0 KB (26 rows), today's 6.6 KB |
| the same 6 rows projected to the `numbers` field level (section 6) | 85.9 KB plain; with only changed days ≈ 9 KB (≈ 12× smaller than today's delta) |
| share of the largest repo in the base | 31.6 %; a one-repo room base: 1.9 MB gzip |
| `cost --json`, local only | 1.37 s, 207 MB |
| `fleet cost --json`, local + 10 synthetic full hosts (distinct ids, distinct message hashes) | 13.2 s, 1.0 GB |
| local + 30 synthetic one-repo room streams | 12.2 s, 566 MB (≈ 12 MB per stream) |
| Monocypher 4.0.2 through `scriptc --ffi` (Linux, LLVM tier) | 8 MB XChaCha20-Poly1305 seal 113 ms, open 110 ms; tampered byte → rejected; EdDSA sign 0.08 ms, verify 0.16 ms (1 KB) |
| same, `--backend c` | seal/open 11 ms each; sign 0.02 ms, verify 0.07 ms |
| two `--ffi` manifests in one build | works (`--ffi crypto.json --ffi darwin.json`) |

Per member device, for a typical developer (≈ 10 sessions a day, one room of their repos), scaled from these numbers:
a daily base ≈ 0.5–1.5 MB and deltas ≈ 0.5 MB a day at a 5-minute cadence with changed-day deltas — about 2 MB per
device per day. A team of 10 people × 3 devices moves ≈ 60 MB a day through the mailbox.

Conclusions that drive the design: (1) a room stream must carry only its sessions' rows, including ownership rows
(the 88 % share); (2) deltas must carry only changed days (12×); (3) the viewer cannot run one exact ownership merge
over every device of a large team at once (≈ 80 MB per heavy full stream), so it merges each member's devices exactly
and joins members by session key (section 9); (4) crypto through a vendored C library costs milliseconds per file.

## Design

### 1. Concepts
- **Team**: id (16 hex, random), name, a root admin key (the creator's), a mailbox. A person can be in several teams.
- **Member**: a person: a display name (section 5a), an EdDSA signing key and an X25519 key. Member id =
  first 16 hex of BLAKE2b(signing public key).
- **Device**: one machine + user of a member, with a label chosen at join (default `<os>-<4 hex of the device id>`,
  e.g. `mac-7f3a`; never the hostname). Device id per team = first 16 hex of
  SHA-256("agentglass/team/v1|" + team id + "|" + `hostId()`): two teams cannot link the same device, and no team
  learns the fleet/OTLP `hostId`.
- **Room**: id (16 hex), name, **scope** (repo patterns), **level** (`numbers` | `titles`), optional monthly budget,
  current **epoch** with a 32-byte room key. Only members granted the room hold its key.
- **Share policy** (member-local, never leaves the machine except as its effect): per room, on/off, the explicit
  repos the member chose, a level ≤ the room's, the history start.
- **Mailbox**: where sealed files meet: a directory (phase 1: Syncthing, Dropbox, iCloud Drive, Google Drive,
  OneDrive, NFS, an rsync target) or an `agentglass receive` relay (phase 2).

A "team of one" (`team create --personal`) is the same machinery: one member, one room `all` with scope `*` and level
`titles`; devices join with a device invite. It replaces SSH fleet setup for machines that cannot be reached.

### 2. Commands (`agentglass team …`, every one with `--json`, errors through `cliError`)
```
team                                   status: my teams, rooms, members online, what I share, last sync (= team status)
team create <name> [--dir <path> | --hub <url>] [--room <name>=<pattern>[,<pattern>…]]… [--level numbers|titles] [--personal]
team invite [--team <t>] [--rooms a,b] [--uses N] [--expires 24h] [--device] [--approve]
team join <code> [--dir <path>] [--name <me>] [--share <room>[,<room>…]] [--repos <key>…] [--since month|now] [--dry-run] [--yes]
team share [--team <t>] [--room <r>] [--add <repo>…] [--remove <repo>…] [--level numbers|titles] [--pause | --resume] [--dry-run]
team report [--team <t>] [--room <r>] [--member <m>] [--by member|device|harness|repo|room|skill|model] [--period d|w|m|a]
team sessions [--team <t>] [--room <r>] [--member <m>] [--filter '<expr>'] [--limit N]
team rooms [add <name> <pattern>… | edit <room> [--scope …] [--level …] [--budget <usd>] | remove <room>]   (admins)
team members | team remove <member> | team admin add|remove <member> | team admit [<request> [--reject]]   (admins)
team rename-me <name> [--team <t>]     change my display name (signed; shown in the activity log)
team activity [--team <t>] [--room <r>] [--since 7d]   joins, leaves, renames, sharing changes, rooms, key rotations
team leave [--team <t>] [--keep]       leave; by default asks every peer to delete what it holds of me
team sync [--every 1m..24h]            one publish + fetch, or a loop (servers without a TUI)
team service [--write]                 the systemd --user unit / launchd agent for `team sync --every 5m`
team doctor                            mailbox, permissions, keys, clock, peers, crypto self-test, sync-tool conflicts
```
The `--team` default is the only team; with several teams, commands that need one name the choices in the error.
Exit codes follow the CLI contract (`docs/cli-contract.md`): 2 usage, 5 a peer/mailbox failure with `--strict`.

### 3. Onboarding flow (the DX contract)
**Create** (`team create acme`): picks a mailbox with zero questions where it can:
1. `--hub <url>` or `--dir <path>` given → that.
2. Else a sync root is detected (`~/Sync` Syncthing default, `~/Dropbox`, `~/Library/CloudStorage/*`, `~/Google
   Drive`, `~/OneDrive`, `~/iCloud Drive` / `~/Library/Mobile Documents/com~apple~CloudDocs`) → proposes
   `<root>/agentglass-acme`, one `[Y/n]`.
3. Else asks for a path (TTY) or fails with the two flags as hints (non-TTY, agent mode).
Then: generates the team, member and device keys, writes the manifest, creates room(s) — `--room` given, else one
room `main` whose scope lists the remote keys of the creator's repos with sessions in the last 30 days (shown, `[Y/n]`
to keep, or edit) — and prints the first invite (as `team invite`).

**Invite** (`team invite`): prints, ready to copy:
```
Invite to acme (rooms: backend, infra) — 1 use, expires 2026-10-11 14:02
  agentglass team join agt1-7k3m9q…x2  (82 characters)
  link: agentglass://team/join/agt1-7k3m9q…x2
Mailbox: ~/Sync/agentglass-acme — share this folder with them first (Syncthing: add their device to the folder).
```
The code holds: format version, team id, invite id, a 16-byte invite secret, 16 bytes of the root key fingerprint,
the mailbox kind and, for a hub, its URL; for a folder, its name (for auto-detection). Crockford base32 with a
2-character check; a mistyped code says "check the code (character 31?)". `--uses N` (default 1), `--expires`
(default 24 h, at most 30 days), `--rooms` (default all), `--device` (joins as another device of me), `--approve`
(an admin confirms each request with `team admit`; otherwise admission is automatic within the limits).

**Join** (`team join <code>`):
1. Find the mailbox: hub URL from the code; for a folder, the same sync roots as create, searched for a directory
   with `agentglass-team.json` naming the team id (≤ 2 levels deep, ≤ 200 directories); `--dir` overrides; not
   found → "the folder agentglass-acme is not here yet: accept the share in Syncthing/Dropbox, then run this again"
   (exit 2, nothing written).
2. Read the invite card (sealed with a key derived from the invite secret: team name, admin names, member count and
   names, rooms with scope, level, budget) and show **one consent screen** (TTY; `--json` prints it as an object):
```
Join acme as  [Björn Schotte______]  (from git config user.name — any name or a pseudonym)  on  [linux-7f3a]
Rooms you can share into (nothing is shared until you pick):
  [ ] backend   github.com/acme/api, github.com/acme/web    level: numbers
        you have: github.com/acme/api  14 sessions (claude 9, codex 5) since 2026-09-01
  [ ] infra     github.com/acme/infra-*                     level: titles
        you have: nothing that matches
What leaves this machine for each picked repo, sealed for the room's 4 members (alice, carol, dan, erin):
  per session: harness, model, start/end, live state, tokens, cost + billing mode, tools, errors,
  lines ±, commits made, skill names (your skills.hide applies), repo — titles only in 'titles' rooms
  never: prompts, outputs, tool arguments, file paths, cwd, branch, hostnames, other repos
History: from 2026-09-01 (this month + 16 days; --since now: from now on)
Where: ~/Sync/agentglass-acme (encrypted; the folder and Syncthing cannot read it)
Space to toggle · d dry run (exactly what would leave) · enter join · esc cancel
```
   `--name` / `--device-label` / `--share` / `--repos` / `--since` / `--yes` answer the screen non-interactively; in agent mode (`AGENTGLASS_AGENT`)
   without `--yes` the command prints the screen as JSON and exits 2 ("a person must consent: run it in a terminal or
   pass --yes after reading this").
3. `d` / `--dry-run`: builds the room snapshots exactly as the publisher would and prints the plaintext lines (the
   bytes before gzip and sealing) to stdout or `--out <file>`; nothing is written to the mailbox.
4. On enter: writes the join request; waits up to 20 s for the welcome (an admin's agentglass is running); then
   publishes the first snapshots and fetches the others' (a progress line per step). If no admin is online: "request
   sent — alice's agentglass admits you when it next syncs (it runs every 1 min while her TUI is open); `team status`
   shows it; publishing starts by itself then".
5. Offers the background publisher once on machines without a running TUI: "this machine publishes only while
   agentglass runs: `agentglass team service --write` installs a user service that syncs every 5 min [y/N]".

**Leave** (`team leave`): one confirmation screen naming what happens: own files removed from the mailbox, a signed
leave notice asking peers to delete what they hold of me, local keys and caches deleted, an admin rotates the room
keys at its next sync. Ends with the honest line: "Peers delete your data when their agentglass next syncs; data
already read by a peer cannot be recalled from a modified client or a copy." `--keep` leaves without the delete
request (the history stays in the team view).

### 4. Mailbox layout (both transports)
```
agentglass-team.json                                 {"format":"agentglass-team/v1","team":"<id>"} (plain: discovery)
manifest/<version>.agm                               signed manifest (section 5)
invites/<inviteId>.card                              invite card, sealed with KDF(invite secret)
join/<inviteId>-<rand16>.req                         join request, sealed to the admins' X25519 keys
welcome/<memberId>-<deviceId>.key                    sealed to the joiner: team key, room epoch keys (member keys for --device)
keys/<roomId>/<epoch>/<memberId>.key                 room key of that epoch, sealed to that member
rooms/<roomId>/<memberId>-<deviceId>.base-<gen>.agt  sealed snapshot (section 7); .delta-<n>-<gen>.agt as fleet drop
leave/<memberId>.tomb                                signed leave notice
names/<memberId>.name                                display-name claim: sealed with the team key, signed by the member
activity/<memberId>-<seq>.act                        member events (share on/off for a room, pause), sealed + signed
```
Each file has exactly one writer (a device writes only its own `rooms/*/<me>-<device>.*`, its own join/leave files;
admins write manifest, invites, welcome, keys). Writes are tmp + rename (`.name.tmp`, as `drop.ts:71-73`). Names not
matching these patterns are ignored (Syncthing `.sync-conflict-`, Dropbox "conflicted copy", editor droppings);
`team doctor` lists them. Readers open only regular files (no symlinks), ≤ 256 MB decoded (`dirfeed.ts:19`); the
uid/mode check of `dirfeed.ts:24-30` stays as a first filter, authenticity now comes from signatures.

### 5. Manifest, admins, admission
The manifest has a **public part** (signed, readable by the relay): team id, version, root key, members (id, signing
key, X25519 key, devices, admin flag, removed flag), rooms (id, epoch), invites (id, BLAKE2b(invite secret) as
verifier, expiry, uses) — and a **private part** sealed with the team key (held by every member): team name, member
names, room names, scopes, levels, budgets.
- Version 1 is signed by the root key; version n+1 must be signed by the root or by an admin of the version the
  reader last accepted. Readers keep the highest valid version; a lower or invalid one is ignored and named by
  `team doctor`. Two admins writing the same version at once: the higher (version, signer id) wins; the losing
  admin's sync sees its change missing and applies it again on top.
- Admission (on any admin's sync: TUI job every 60 s while it runs, `team sync`): for each request, check invite id
  known, not expired, uses left, MAC over the request with the invite secret, device not already in the team (a
  device belongs to one member: two people on one Unix account are refused with that reason). Then: manifest n+1
  with the member/device, room keys of the granted rooms sealed into `welcome/`, invite uses decremented. `--approve`
  invites queue the request; the admin's TUI shows a toast "join request: Björn (linux-7f3a) → `team admit`".
- Removal and leave: manifest n+1 marks the member removed; every room they held gets epoch e+1 with a new key
  sealed to the remaining members, and the team key (private part) is replaced the same way. Publishers use the newest epoch they hold for new files; readers keep old epoch
  keys to read files already written (bases roll daily, so old epochs fall out of use within a day).

### 5a. Display names and the activity log
- **Choice**: at join the consent screen proposes `git config --global user.name` (else the login name), editable;
  any 1–32 characters without control characters; a pseudonym is fine. `team rename-me <name>` changes it later.
  Device labels likewise (`team rename-me --device <label>`).
- **Bound to the key**: a name is a claim `{member, name, device labels, seq, at}` signed with the member's signing
  key and sealed with the team key (`names/<memberId>.name`); readers accept the highest `seq` with a valid signature
  of that member's key from the manifest. Nobody else can name or rename a member; the relay and the folder cannot
  read names.
- **Collisions**: two members claiming the same name (case-insensitive) are shown as `anna` (the earlier member by
  manifest order) and `anna·3f2a` (the later, with 4 hex of the member id); `team doctor` and the Team tab say so.
- **Attribution by id**: sessions, cost, skills and wait belong to the member id; the name is resolved at display
  time, so a rename applies to the whole history.
- **Activity log**: derived and signed events — from manifest versions (joined, removed, admin granted, room
  created/edited, key rotated; signed by an admin), name claims (renamed; signed by the member), member events
  (`activity/`: shares into room X on/off, paused/resumed — only the fact, never the repos; signed by the member),
  leave notices. Shown newest first: "Anna joined room web · 10:42", "bjoern renamed to Björn · 11:03", "carol
  paused room backend · 14:20". Kept 90 days; `team activity --json`, the Team tab (`l` log), the web activity view.
- **Privacy**: names appear only in that team's views (TUI Team tab, its rows' member column, `team` CLI, the web
  team pages, the API's team resources); never in OTLP, fleet streams, other teams or logs. `--redact` replaces
  member names and device labels with stable fakes (the `fakeAgent` pool pattern, `src/features/redact.ts:152`).

### 6. What a room stream carries (the sender's projection)
The publisher selects and projects; the viewer never filters what it was not meant to get.
- **Selection**: top-level sessions (subagents folded in as today) whose `Ident.key` (`project.ts:87`) is `git:<x>`
  with `<x>` in the member's chosen repos for that room **and** matching a room pattern (`globMatch`, `*` within a
  segment, `**` across segments; case-insensitive for the hosts in `CI_HOSTS`). Sessions without a remote (path
  identities, no git) never match. Sessions before the policy's history start are left out. Live sessions count by
  their repo like the others.
- **Ownership rows**: only for selected sessions (the 88 % share measured above; other sessions' hashed ids are not
  sent).
- **Field levels** (an allowlist over `jsonSess`, applied by `teamRow()`; anything not listed is dropped):
  - `numbers`: `id` (as a per-team hash: BLAKE2b(team id ‖ session key), 16 hex), `harness`, `model`, `updated`, `live`, `status`/state enum (busy, idle, attention, stuck, ended — no stuck text), `kind`, `subagents`,
    `tokens`, `costUsd`, `costEstimatedUsd`, `billing.mode` (no plan name), `unpricedTokens`, `unpricedCredits`,
    `tools`, `linesAdded`, `linesRemoved`, `repo.key` + `repo.label` (allowed repos only), `skills` (names after
    `skills.hide`; omitted skills fold into `(hidden)` as `snap.ts` does), alerts as rule ids only, `git.produced`
    (commit count), `git.prs` as a count, `git.costPerCommit`; day rows (`DayRow`, `fleet/model.ts:20`) as they are.
  - `titles`: `numbers` plus `title` (secret-scrubbed, `scrubSecrets`) and `branch`.
  - Never, at any level: `cwd`, `path`, `remote` URL, `activity`, stuck text, alert messages, mux labels, git commit
    messages/hashes/PR URLs, prompts, outputs, tool arguments, file paths, hostname, plan name.
- **Head**: `hostId` replaced by the device id, `hostName` empty, `tzOffsetMin`, `priceSig`, `days`, `now`, the
  room id, epoch, member id, level.
- **Cost line**: `summary()` over the selected sessions only (not the host's whole cost); allowance only in a room of
  a `--personal` team (plan allowance is account-wide, not per repo).
- **Changed-day deltas**: a delta's session row carries only the day rows whose content changed since its base (a
  per-day signature in the peer state), marked `"dd": true`; the reader merges them by date. Bases carry all days.
  This is new in the team stream only; fleet drops keep their v1 rows (old viewers).
- `REDACT` is not used for team streams: names stay real inside the allowed scope; the level decides what exists.

### 7. Sealed file format `agentglass-team/v1`
```
"AGT1" | u32 header length | header (JSON, UTF-8) | ciphertext | 64-byte signature
header: {format, team, room, epoch, member, device, kind: "base"|"delta", n, gen, base, at, nonce (24 bytes, b64url), mac (16 bytes, b64url)}
ciphertext = XChaCha20-Poly1305(room key[epoch], nonce, gzip(snapshot lines), ad = header bytes without "mac")
signature  = EdDSA(member signing key, "agentglass-team/v1|" ‖ header bytes)   (header holds the mac: the signature covers the ciphertext)
```
Readers check, in order: magic, header schema, sender is a current member with that device in the manifest (or a
removed member and `at` before the removal version's time), signature, epoch key held, open. Any failure → the file
is skipped and remembered (as `dirfeed.ts:59,73`), named by `team doctor`. Nonces are random (24 bytes from
`/dev/urandom`: XChaCha's nonce size makes random nonces safe). The plaintext is exactly what `--dry-run` prints.

### 8. Crypto: Monocypher through FFI
`src/features/team/crypto/` holds Monocypher 4.0.2 (`monocypher.c`, `monocypher.h`, 2-clause BSD / CC0, unmodified,
with its licence) and `agcrypto.c`, a ~150-line wrapper with length-checked entry points (`bytes` = pointer +
`size_t`; a wrong length returns -2, never writes): `ag_sign_keypair`, `ag_sign`, `ag_verify`, `ag_x25519_keypair`,
`ag_seal` / `ag_seal_open` (anonymous sealed box: ephemeral X25519, BLAKE2b KDF, XChaCha20-Poly1305), `ag_lock` /
`ag_unlock` (AEAD with associated data), `ag_kdf` (keyed BLAKE2b), `ag_wipe`. `crypto.ts` declares them and wraps
them in typed functions; `ffi.json` lists them. `build.sh` passes `--ffi src/features/team/crypto/ffi.json` on every
OS (with the darwin manifest on macOS; two manifests in one build work, measured); `scripts/build-tls.sh` too (the
receive-tls binary relays team files in phase 2). Checks that call crypto carry `// check: crypto`
(`scripts/check.sh` adds the manifest; a check that imports but does not call it builds without). `package.sh`
refuses an archive whose binary lacks the `ag_lock` symbol. `agentglass-mcp` does not link it.

Keys at rest: `~/.agentglass/team/<teamId>/` (0700; `AGENTGLASS_TEAM_DIR` moves it, for tests and the isolation
set): `member.key` (signing + X25519 secret keys, 0600), `rooms/<roomId>.<epoch>.key` (0600), `policy.json`,
`state/` (peer generations, per-day signatures), `cache/` (sealed files fetched from a hub; a folder mailbox is read
in place). No passphrase (as SSH keys without one; stated in `team doctor` and the README). Secrets never in argv,
environment, logs or `--json`; buffers wiped after use where the wrapper allows.

### 9. Viewer: feeds and merge
- One `HostFeed` (`fleet/model.ts:43-48`, kind `"team"`) per (team, room, member, device), reading that device's
  chain like `dirFeed` (`dirfeed.ts:49-78`: newest base, then contiguous deltas, one file per poll in the TUI, all at
  once in the CLI), opening each file through section 7 before `feedSnap()`.
- **Room union per device**: a device's streams in several rooms hold overlapping sessions (a repo in two rooms);
  rows are joined by session key per device (the newest generation's row wins; days by date; ownership rows by
  hash) before anything else, so a session counts once whatever the rooms. A view of one room uses only that room's
  streams.
- **Merge**: exact ownership merge (`merge.ts`, `exactMerge`) among one member's devices — where copies happen (a
  person syncs or moves `~/.claude` between machines); across members, sessions are joined by session key (a log
  copied between people keeps its id) and otherwise added. Each member's merge runs on its own and frees its index
  before the next; the TUI runs it as a sliced job (`mergeTick`, `hosts.ts:302`).
- **My devices**: rows from my own other devices appear in the Sessions list exactly like fleet hosts (host badge
  with the device name, `host` filter key), deduplicated with `fleet.hosts` entries for the same device (the device
  id is derived from the same `hostId`). Other members' rows appear only in the Team tab and `team` CLI.
- Limits: at most 64 devices and 16 rooms per team view; beyond that the newest-active devices are shown and the
  header says how many were left out. Re-pricing and time-zone re-bucketing as fleet (`fleet.reprice`, spec 14).

### 10. TUI: the Team tab (key `6`, after Wait; only when a team exists) — and the web Team page
The web UI's Team, Rooms and activity pages (local-web-api section 10) show the same read model; this section
defines the TUI.
80 columns, the period keys of Repos/Wait:
```
 Team acme · room all ▾ · this week · 4 of 5 members online · synced 40 s ago                 ? keys
 MEMBER      DEVICES  LIVE        TODAY      WEEK    $/COMMIT  TOP HARNESS        SKILLS
 alice       2/2      ●3 ◆1      $12.40    $88.10     $1.90  claude 71% codex   7
 bjoern (me) 3/3      ●5         $31.02   $140.55     $2.75  claude 52% pi      12
 carol       1/2      ○          $0.00     $22.80     $0.95  codex 100%         2
 dan         0/1      ○ 3 h ago  —          $9.40         —  gemini 100%        0
 ───────────────────────────────────────────────────────────────────────────────────
 backend budget $400/month: $261 spent · projected $372 · ok
 d w m a period · b by member ▸ harness ▸ repo ▸ room ▸ skill ▸ model · ↵ sessions · s share · l log · i invite
```
- `b` cycles the grouping; `↵` opens the selected group's sessions (read-only rows: no transcript, no send/resume;
  the detail pane shows the shared fields and "shared by alice in room backend"). `/` filters with the filter
  language plus the keys `member` and `room` (section 11). `r` picks the room (or all rooms).
- **Presence**: `●n` live agents, `◆n` waiting for approval/attention, `⚠n` stuck — from the newest snapshot's
  state enum; a device whose newest file is older than 3× its cadence shows `○ <age>`.
- **`s` — what I share** (always one key away): per room the repos, session count, level, history start, last
  publish (time, size), paused or not; keys inside: `space` pause/resume a room, `a` add a matching repo, `x` remove
  one, `d` dry run into `$PAGER`. Changes apply to the next publish; removing a repo deletes nothing already sent
  (said in the panel).
- `l` activity log (section 5a) as an overlay; `n` rename me.
- `i` invite (admins): the invite text of section 3 in an overlay; `y` copies the code.
- Toasts: a join request (admins), a new repo that matches a room ("github.com/acme/new matches room backend — `s`
  to share it"), a member left/removed, a room near/over budget (once a day, `OS.notify` too unless
  `AGENTGLASS_NOTIFY=0`), a mailbox problem (once, then in the header).
- The header widget shows `team ●9` (live agents across the team) when a team exists and the Team tab is not open.
- Help `?` has a Team section; the footer lists the tab's keys; the palette gets "Team: …" actions for each key.

### 11. Filter keys, CLI output, OTLP
- `member` (session, enum: member names; `me`) and `room` (session, enum) in `src/features/query/attrs.ts`; valid in
  the Team tab, `team sessions --filter`, `team report`; in the Sessions list `member` is `me` for every local row
  and my devices' rows.
- `team report --json`: `{team, room, period, by, rows: [{key, sessions, live, tokens, costUsd, byMode, unpriced,
  commits, costPerCommit, skills, harnesses}], members: [{name, devices, online, lastSyncAt}], budget, stale: [...]}`
  — stable under the CLI contract (golden in `docs/cli-contract.md`).
- API (local-web-api): `team.status`, `team.report`, `team.sessions`, `team.activity`, topics `team:<team>/<room>`
  and `presence`; every team row carries `member: {id, name}` and `device: {id, label}`.
- Commands touching the team (join, share, leave, invite, rename-me) go through local-web-api's typed command
  channel as risk class R3 (two-step confirm whose summary is this spec's consent preview); they act on this
  machine's membership only. No command is ever sent to or executed on another member's machine — team streams carry
  data, never commands (invariant, tested).
- Team data is never exported over OTLP by the viewer (it is other people's data); `export` keeps exporting local
  sessions only.

### 12. Background publishing
- TUI: a slow job (60 s; adaptive-refresh's idle cadence applies) runs `sync`: process manifest/join/leave (admins),
  publish each shared room (the drop rules: base daily or when deltas pass half the base, prune after a day), fetch.
- `team sync --every 5m`: the same without a TUI (servers). `team service` prints a systemd `--user` unit (Linux)
  or a launchd agent plist (macOS) running it; `--write` installs and starts it after one confirmation, as
  `mcp install --write` does.
- Publishing reads the same ledger cache as the TUI; a publish of an unchanged room writes nothing.

## Phase 2

### 13. Hub relay (`agentglass receive` as a team mailbox)
For teams without a shared folder (people in different companies, OSS contributors): one member or a small VPS runs
`agentglass receive` (loopback + `tailscale serve`/a TLS proxy, or receive-tls), started with `--team`.
- Routes under `/team/v1/<teamId>/<mailbox path>`: `GET` (a file or a listing of a directory, newest first, with
  sizes and mtimes), `PUT` (≤ the hub body limit, one file), `DELETE` (own files only). The stored tree is the
  layout of section 4 under `<hub dir>/team/<teamId>/`.
- Authentication without accounts: every request carries `Authorization: AGT <memberId>.<deviceId>.<unix ms>.<sig>`,
  the signature over method, path, time and SHA-256 of the body with the member's key. The hub verifies it against
  the newest valid public manifest part it holds (section 5) and allows: `PUT/DELETE` only under the member's own
  names; `GET` for current members only (a removed member loses read access at once — revocation that also covers
  files already written). Join requests and invite cards: `PUT join/…` and `GET invites/<id>.card` with
  `Authorization: AGI <inviteId>.<secret proof>` checked against the manifest's verifier and expiry. ±5 min clock
  window; `team doctor` measures the skew.
- A new team on a hub: `team create --hub <url>` needs a hub token from the operator (`agentglass receive token add
  <name> --team`, the token store of `tokens.ts`); the hub binds the team id to that token's first manifest.
- The hub never holds a key: it sees team/member/device/room ids, sizes and times. Limits, disk budget and retention
  as otlp-hub (per team: `receive.team.maxMB`, default 2048).
- The invite code carries the hub URL; `team join` needs nothing else — the shortest path to a team view.

### 14. Wait data in team streams
A room snapshot gains a `wait` line: the device's `wait --json` object computed with the room's selection as filter
(`wait/cli.ts:50` accepts `--filter`), families and kinds only (never command lines; as `fleet pull --wait`). The
Team tab gets a `wait` grouping (`b`): per family p50/p95 and share of agent time per member — "the same `pnpm test`
takes 4 min for alice and 40 s for carol".

### 15. MCP tool `team`
`agentglass-mcp` gains a read-only `team` tool (`agentglass team report --json` for the calling session's repo,
project scope as the other tools): the room's cost this week, harness and skill mix, teammates' live agents on this
repo. Same size cap, cursor and redaction rules as mcp-server; no other member's session titles at `numbers` level.

### 16. Team server (OCI image; slices S6 and S7)
For teams that want one always-on place to look (a browser tab for people who run no agentglass themselves, a
manager, a wall screen) and one relay that is always reachable. The **per-developer view stays the native binaries**
(local-web-api Decision 15); the team server is a different deployment target.
- **What it is**: one OCI image `ghcr.io/bjoernschotte/agentglass-team-server` (linux/amd64 + linux/arm64) with
  `agentglass` and `agentglass-web`, run as two processes of one pod/compose project sharing one volume:
  `agentglass receive --team` (the relay of section 13) and `agentglass-web --server` (local-web-api section 4b),
  whose `serve --stdio` child runs with `--no-local` (no harness discovery, no processes: it reads only team
  streams) and `--read-only` (forced; commands do not exist on a server).
- **A device of the team, not a bypass**: the server joins with a server invite (`team invite --server --rooms a,b`;
  `docker compose run --rm team-server agentglass team join <code> --server --yes`), gets its own device and member
  keys (member kind `server`, shown as "server: <label>" in the activity log, never counted as a person), is
  admitted by an admin, receives the keys of exactly the rooms it was granted, and is removed like any member
  (`team remove`, key rotation). It publishes nothing. E2E stays intact: rooms the server is not in remain
  ciphertext on its disk; for its rooms the server holds plaintext in memory like any member — whoever operates the
  server can read those rooms (stated in the invite, the consent screens of members of those rooms — "visible on
  the team server <label>" — and `team doctor`).
- **Who may see what**: web users authenticate (local-web-api 4b) and are mapped to members; a user sees only the
  rooms their member is in, with the same names, levels and redaction as in their own agentglass. Mapping is
  proven, not configured by hand: after the first login the page shows a one-time link code; the member runs
  `agentglass team link-web <code>` on their own machine, which signs `{code, member, server}` with the member key
  into the mailbox; the server binds the identity provider's subject to that member. An admin can unlink
  (`team link-web --revoke <member>`). Unmapped users see a "link your agentglass" page and no data.
- **Image hardening**: base `gcr.io/distroless/cc-debian12:nonroot` (glibc for both binaries, no shell, no package
  manager), uid/gid 65532, read-only root filesystem, one writable volume `/data` (hub storage, team keys of the
  server, caches) and a `tmpfs` `/tmp`, all capabilities dropped, `no-new-privileges`, seccomp `RuntimeDefault`;
  `HEALTHCHECK` in exec form (`agentglass-web --healthcheck`); the binaries are the release binaries of the same
  version (copied, not rebuilt), verified against their checksums in the Dockerfile.
- **docker compose** (S6, `deploy/compose/`): services `relay` and `web` (same image, shared volume), an optional
  `caddy` (automatic TLS, `forward_auth` to an `oauth2-proxy` service for identity — the trusted-proxy auth mode of
  4b) and an `.env.example`; `docker compose up` gives HTTPS with Let's Encrypt or a tailnet certificate.
- **Helm chart** (S7, `deploy/helm/agentglass-team-server/`, published as an OCI chart on GHCR): one Deployment
  (replicas 1: file-based state with one writer; strategy `Recreate`), two containers, a PVC for `/data`, Service,
  Ingress (class, host, TLS secret or cert-manager annotations), values for OIDC (issuer, client id,
  `existingSecret` for the client secret), resources (requests 50m/128Mi, limits 500m/512Mi as defaults to verify),
  securityContext as above, a NetworkPolicy (ingress only from the ingress controller's namespace; egress only to
  DNS, the OIDC issuer and the configured relay peers), optional ServiceMonitor off by default. HA, multiple
  replicas and object storage are out of scope.
- **Supply chain**: images built in the release workflow with buildx from the release binaries, pushed to GHCR,
  build-provenance attestations (`actions/attest-build-provenance`) and an SPDX SBOM attached (`buildx --sbom`);
  Dependabot `docker` ecosystem for the base image digest and `helm` for the chart's dependencies (none planned);
  CI smoke: `docker run --rm <image> agentglass --version` and `agentglass-web --version`, a compose up with a test
  relay + web and `curl` of `/healthz`; `helm lint` + `kubeconform` + an install into `kind` with the chart's test
  hook.
- **Measurements to record at implementation** (targets to verify, not measured yet): compressed image size (target
  ≤ 60 MB: agentglass ≈ 15 MB + agentglass-web ≈ 36 MB gzip + base ≈ 10 MB); idle RSS of both processes with 0 and
  3 browser users (target ≤ 80 MB together without team data); RSS and first-view time for the team bench (10
  members × 3 devices) served through the image; relay throughput for one day of the bench's uploads.

## Failure modes
- **Mailbox missing or read-only** (sync not set up, disk full, unmounted drive): publish keeps the peer state
  (nothing acknowledged), header shows "team: cannot write <path>", `team doctor` names the cause; reading continues.
- **Sync conflicts**: single-writer names make data files conflict-free; manifest conflicts resolve by version
  (section 5); conflict copies are ignored and listed by `doctor`.
- **Partial sync**: a delta without its predecessor waits (the `dirfeed` gap rule, 1 h then "chain incomplete"); a
  base without its epoch key waits for `keys/`; a welcome not yet synced → "pending".
- **Clock skew**: snapshot times are the sender's; the merge re-buckets by `tzOffsetMin`; the hub rejects signatures
  outside ±5 min with the measured skew in the error.
- **Lost keys** (a reinstalled machine): the device cannot read new epochs or sign as the member; `team join` with a
  new `--device` invite from another of my devices, or an admin's invite, restores access (history the peers hold
  stays attributed to the member).
- **Admin offline**: joins stay pending; teams should have two admins (`team doctor` warns with one admin and ≥ 3
  members).
- **Root key lost**: the team continues while another admin exists (versions signed by admins); with no admin left
  the team is frozen (members can read, nobody can admit) — said by `doctor`; the fix is a new team.
- **Forged or tampered files**: signature or MAC failure → skipped, counted, named; never partially applied.
- **Large teams**: beyond 64 devices or 16 rooms the view truncates with a header note; the merge budget is a tested
  number (Testing).
- **A repo renamed or moved** (remote URL changes): it leaves the scope; the toast offers the new key.

## Privacy
- **The sender decides.** Selection, projection and level are applied on the publishing device; the viewer
  receives nothing else. Default-deny: a room shares nothing until the member picks it; a repo is shared only when
  the member listed it (patterns in the room scope are the upper bound, not an opt-in); new matching repos only
  produce a suggestion.
- **Consent is explicit and reviewable**: the join screen names fields, recipients by name, history start and
  storage; `--dry-run` / `d` prints the exact plaintext; `s` in the Team tab and `team share` show the current
  policy at any time; `team status --json` includes it.
- **Local stays complete**: local surfaces show everything as today; only outward paths are scoped (consistent with
  the skills decision: `skills.hide` applies to team streams like every outward path).
- **No content ever**: prompts, outputs, tool arguments, file paths, cwd, branch (except `titles`), hostnames are
  not part of any level.
- **Revocation**: removal rotates room keys (future data); on a hub, read access ends at once; on a folder, the
  removed member keeps folder access until someone removes them from the sync share — `team remove` says so and
  `doctor` reminds. Leave requests deletion from peers (best effort, stated).
- **Names**: chosen by the member, pseudonyms welcome, visible only inside the team, faked under `--redact`, never
  in outward paths (5a).
- **Unlinkable ids**: device ids and session ids are per team; a member's teams cannot be correlated by ids.
- **Metadata visible to the mailbox**: team/room/member/device ids, file sizes and times (activity patterns). Stated
  in the README.

## Interactions with other specs
- **local-web-api**: provides the read model, `serve --stdio`, `agentglass-web` and the web UI; this spec adds the
  team dimensions, team resources and R3 commands. Built together, slice by slice (shared slice table in both plans).
- **fleet**: reuses `HostFeed`/`HostReport`, the snapshot codec and `applySnap` (extended with `dd` day merges),
  `drop.ts` chain rules (`nextKind`, `prune`), `dirFeed`'s chain walk, `exactMerge`; `buildSnap()` gains a scope
  argument (selection, projection, ownership limit, changed-day deltas) — fleet's own calls pass none and behave as
  today (golden check). My devices' rows join the fleet list with the fleet badge and `host` key.
- **otlp-hub**: phase 2 adds team routes to `receive` (same server, limits, store budget, TLS binary) and reuses
  `tokens.ts` for the hub token of `team create --hub`.
- **skill-usage**: skill names in streams pass `skillVis()`; `(hidden)` folding as `snap.ts` does.
- **git-linkage**: `produced` commit counts and `costPerCommit` feed `$/COMMIT`.
- **honest-costs / model-prices**: billing modes per row; viewer re-prices with its table (fleet 14); room budgets
  use `budgetState()` (`src/features/usage/costs.ts:161`).
- **filter-language**: keys `member`, `room`; `team sessions --filter`.
- **agent-wait**: phase 2 wait line uses `wait --json --filter`.
- **mcp-server**: phase 2 `team` tool.
- **adaptive-refresh**: the sync job is a slow job; idle cadence applies.
- **ROADMAP**: "Team/adoption analytics" moves out of "Explicitly not planned" (user decision 2026-10-10); this spec
  is private, opt-in team analytics without a central collector, not adoption tracking for a company.

## Testing
- **Crypto** (`crypto.check.ts`, `// check: crypto`): RFC 7748 X25519 vectors; Monocypher's EdDSA test vectors;
  XChaCha20-Poly1305 vectors (draft-irtf-cfrg-xchacha appendix A.3); seal/open round trip; wrong lengths → -2 with
  no write; tampered byte in ciphertext, header, ad or signature → rejected.
- **Codes and manifest** (pure): invite code round trip, check characters catch any single-character error and
  adjacent swaps; manifest chain (root, admin, removed admin, stale version, two versions at one number, gap).
- **Policy and projection** (pure, golden): a fixture session per field; `numbers` and `titles` outputs byte-equal
  to goldens; a fixture with a secret in the title, a cwd, a commit message — none appears at any level; repos
  outside the scope, path identities and pre-history sessions are not selected; ownership rows only for selected
  sessions.
- **Snapshot scope** (`snapshot.check.ts` extended): `buildSnap()` without scope byte-equal to before (fleet golden);
  with scope: cost line = sum of selected sessions; changed-day deltas carry only changed days and apply to the same
  report as a full delta.
- **Sealed files**: forged member, wrong device, removed member after removal, old epoch, truncated file, zip bomb,
  symlink, group-writable → all skipped with the named reason.
- **Admission** (two fake members in temp homes, one folder): invite → join → welcome → first publish → the other
  sees the rows; expired invite, used-up invite, wrong secret, duplicate device → refused with reasons; `--approve`
  flow; removal → epoch rotation → the removed member's reader cannot open new files.
- **Leave/wipe**: tombstone → peer deletes the cached files and rows on its next sync; `--keep` keeps them.
- **Merge**: the same Claude session copied between two of one member's devices counts once; the same session key in
  two members counts once; a session in two rooms of one device counts once in the all-rooms view.
- **Names** (`names.check.ts`): a claim signed by another member's key → ignored; a higher `seq` wins; the
  collision display `anna` / `anna·3f2a`; rename applies to past rows; `--redact` fakes names and labels; no name in
  any OTLP span, fleet snapshot or log line (grep).
- **Activity**: events derived from manifest versions, claims, member events and tombstones in time order; a forged
  member event is dropped.
- **Bench** (`team/bench.check.ts`, `// check: timing`): 10 members × 3 devices × 300 sessions (synthetic, sealed with
  real crypto in a temp mailbox): CLI `team report --json` ≤ 5 s and ≤ 400 MB RSS on the CI runner; TUI steady state
  adds ≤ 150 MB for 30 one-repo streams of this machine's size (measured once, recorded in the PR).
- **CLI** (`scripts/team.test.sh`, two temp HOMEs with the full isolation set): create, invite, join `--yes`,
  `--dry-run` prints exactly what a publish then seals (decrypt-and-compare), share add/remove/pause, report/sessions
  JSON shapes against goldens, leave, doctor findings (conflict copy, one admin, missing folder, clock).
- **TUI** (`team/tab.check.ts`): 80-column render of the tab, presence glyphs, the share panel, keys, help section,
  footer; agent-mode join refusal without `--yes`.
- **Hub** (phase 2): signed requests accepted/refused (other member's path, removed member GET, stale time, wrong
  invite proof); listener on 127.0.0.1 port 0 only.

## Out of scope
- Transcript content in any form; opening a teammate's transcript; sending prompts to a teammate's agent.
- Company-wide rollups, adoption dashboards, per-person rankings beyond the team's own view (no leaderboard).
- Git repositories as a mailbox (history grows with every daily base); QR codes (joining happens in a terminal);
  short "wormhole" codes (need a rendezvous server).
- SSH keys or GitHub keys as member identities; passphrase-protected key files.
- Windows.

## Decisions
Each: question · options · decision · why · cost if wrong.

1. **Distribution model.**
   - Options: (a) a mailbox every device writes its own files into and reads the others' (shared folder, later a
     dumb relay); (b) SSH pull mesh between members (`fleet serve` per member); (c) a central collector (OTLP hub
     receiving plaintext); (d) direct P2P over Tailscale/libp2p.
   - **Decision: (a).**
   - Why: it is `fleet drop` + `dirFeed`, already shipped and measured; works offline and behind NAT; no member has to
     accept inbound connections; no central party reads data (with section 7 not even the folder); n members need n
     writers, not n² connections. (b) needs SSH between people of different companies; (c) is the SaaS shape the
     user wants an alternative to; (d) has no scriptc support (no UDP hole punching, no Unix sockets) and needs NAT
     traversal infrastructure anyway.
   - Cost if wrong: latency of the sync tool (Syncthing seconds, cloud drives up to minutes); phase 2's relay covers
     teams without a shared folder.
2. **Encryption and signing: how, given scriptc has no crypto.**
   - Options: (a) vendor Monocypher (one C file, BSD-2/CC0, audited) through the existing FFI mechanism; (b) link the
     system libsodium/OpenSSL (`system_libraries`); (c) spawn `openssl`/`ssh-keygen -Y`/`age`; (d) rely on the
     transport (Syncthing TLS, SSH, Tailscale) and sign nothing.
   - **Decision: (a)**, EdDSA with BLAKE2b (Monocypher's default), X25519, XChaCha20-Poly1305.
   - Why: measured to build and run on the LLVM tier and the C backend with the macOS manifest alongside; 110 ms per
     8 MB (LLVM tier), 11 ms (C backend); no runtime dependency (macOS ships LibreSSL with differing CLI support,
     `age` is not installed, libsodium is not on stock macOS or Debian images and the release must stay one binary);
     random 24-byte nonces are safe. (d) fails two principles: anyone with folder access could forge another
     member's data (today's `dirfeed.ts:24-30` check passes for every synced file) and revocation would be out of
     agentglass's hands.
   - Cost if wrong: 3,000 lines of vendored C to update on advisories (Monocypher releases are rare; `doctor` prints
     the version); a non-standard EdDSA hash means no interop with other Ed25519 tools — switching is a format
     version bump.
3. **Identity.**
   - Options: (a) agentglass member keys, devices of one member share them through a `--device` invite; (b) SSH or
     GitHub keys; (c) one identity per device, grouped by name.
   - **Decision: (a).**
   - Why: (b) needs parsing and decrypting OpenSSH private keys (bcrypt-pbkdf, passphrases) and ties identities to
     keys people rotate for other reasons; (c) lets anyone claim a name. A `--device` invite moves the member key
     sealed to the new device's X25519 key — one command on each machine.
   - Cost if wrong: a person must keep their keys (lost keys: section Failure modes); adding GitHub key import later
     is additive.
4. **Admission: bearer invite vs. admin admits.**
   - Options: (a) the invite code holds the room keys (instant join); (b) an admin's running agentglass admits within
     the invite's expiry and use limits, optional manual approval; (c) always manual.
   - **Decision: (b).**
   - Why: expiry and use limits are only enforceable if someone holding keys checks them; a leaked (a) code is read
     access forever. With the creator's TUI open, admission takes ≤ 60 s; the consent screen does not wait for it
     (the invite card carries what the screen needs).
   - Cost if wrong: joins wait while every admin is offline; mitigated by two admins (`doctor` warns) and
     `team sync --every` on a server.
5. **Invite presentation.**
   - Options: code + `agentglass://` link; plus a terminal QR; plus short words via a rendezvous server.
   - **Decision: code + link only.**
   - Why: joining happens in a terminal on the joiner's machine, often over SSH; a phone cannot use a QR; short codes
     need a server agentglass does not want to require. The code has a check so typos are found.
   - Cost if wrong: an 82-character code is pasted rather than typed; chat and terminals handle that.
6. **Scope unit.**
   - Options: (a) git remote keys with glob patterns; (b) local paths; (c) arbitrary filter expressions.
   - **Decision: (a)**; sessions without a remote never leave.
   - Why: the remote key is the same on every member's clone (`project.ts:60-84`); paths differ per machine and leak
     usernames; filter expressions are hard to review in a consent screen and could select on content.
   - Cost if wrong: local-only repos cannot be shared; adding a named alias later is additive.
7. **What a member consents to: patterns or explicit repos.**
   - Options: (a) the room's patterns as they match now and later; (b) an explicit list picked at join, new matches as
     suggestions.
   - **Decision: (b).**
   - Why: default-deny and "only what they choose" — a new private repo that happens to match `acme/*` must not leave
     silently. The suggestion toast keeps it one key away.
   - Cost if wrong: one extra key press per new repo.
8. **Field levels.**
   - Options: (a) `numbers` and `titles`; (b) add `full` with cwd/branch/activity; (c) per-field toggles.
   - **Decision: (a)**, room sets the maximum, member may lower it, default `numbers`.
   - Why: the team questions (cost, harness, skills, presence, $/commit) need numbers; titles help explain an
     outlier and are the one field people weigh; paths, branches beyond `titles` and activity text are personal and
     leak content. Per-field toggles make the consent screen unreadable.
   - Cost if wrong: a team wanting branches asks for a level; adding one is additive.
9. **History at join.**
   - Options: (a) from now on; (b) the cost window (this month + 16 days); (c) everything.
   - **Decision: (b) by default, (a) with `--since now`,** named on the consent screen with the date.
   - Why: "a team view within minutes" needs this month's numbers; (c) is more than any view uses.
   - Cost if wrong: someone who reads past the screen shares a month they did not expect — the date is on the screen
     and the dry run shows the rows.
10. **Merge across people.**
    - Options: (a) one exact ownership merge over all devices; (b) exact within a member's devices, session-key join
      across members; (c) plain sums.
    - **Decision: (b).**
    - Why: copies occur within a person's machines; across people a copied log keeps its session id. Measured: one
      merge over everything grows ≈ 12–80 MB per stream; per member it stays the size of one person's fleet.
    - Cost if wrong: a partial copy of another person's history (a resumed fork of someone else's session) counts
      twice; it would need two people sharing one Claude account's logs.
11. **Where team rows appear.**
    - Options: (a) merged into Sessions like fleet; (b) a Team tab plus `team` CLI; (c) CLI only.
    - **Decision: (b) for other members, (a) for my own devices.**
    - Why: teammates' sessions are not mine to act on (no send/resume) and would crowd the list; my devices are the
      fleet use case and belong next to my local rows.
    - Cost if wrong: one extra key (`6`) to see the team.
12. **Changed-day deltas only in team streams.**
    - Options: (a) in team streams only; (b) in `agentglass-snapshot/v1` for fleet too; (c) not at all.
    - **Decision: (a).**
    - Why: measured 12× smaller deltas; every team reader is new code, fleet viewers of older versions would misapply
      partial days.
    - Cost if wrong: fleet drops stay larger; porting is a v2 snapshot later.
13. **Device ids.**
    - Options: (a) `hostId()`; (b) a per-team hash of it.
    - **Decision: (b).**
    - Why: the fleet id also goes to OTLP backends; per-team ids keep teams from linking a person's machines across
      teams. My-device dedup still works (derived locally).
    - Cost if wrong: none visible; a debugging step maps ids via `team doctor --json` on the device.
14. **Revocation.**
    - Options: (a) key epochs on remove/leave + signed leave notice + hub read cut-off; (b) re-encrypt history; (c)
      nothing beyond removing from the manifest.
    - **Decision: (a).**
    - Why: "revocation is real for future data" needs new keys; (b) cannot take back what was read. The honest
      statement is printed at `leave` and `remove`.
    - Cost if wrong: a removed member keeps what they already had — unavoidable.
15. **Hub relay in phase 2, folder in phase 1.**
    - Options: (a) folder first; (b) hub first; (c) both at once.
    - **Decision: (a).**
    - Why: the folder reuses drop/dirfeed with no server; the hub needs authenticated routes, quotas and a manifest
      reader on the server. Both share sections 4–9, so phase 2 adds a transport, not a redesign.
    - Cost if wrong: phase 1 teams across companies need a shared folder (Syncthing between two people takes minutes).
16. **Background publishing.**
    - Options: (a) only while a TUI runs; (b) TUI + `team sync --every` + `team service` (prints, `--write` installs
      with consent); (c) install a service at join automatically.
    - **Decision: (b).**
    - Why: servers often run no TUI; installing services silently is outward-facing change the user did not ask for
      (same rule as `mcp install --write`).
    - Cost if wrong: one more prompt during join.
17. **Cut: herdr/tmux team integration, per-person rankings.**
    - Why: pane and workspace names are personal labels (dropped at every level); presence uses the state enum,
      which already includes herdr's `blocked` as attention. Rankings turn a self-optimisation tool into
      surveillance; the view groups and compares but never sorts people by a score.
    - Cost if wrong: a herdr `$ag_team` token can be added through the plugin contract later.
18. **Kept: room budgets, `$/commit`, skills, presence, `team doctor`, MCP `team` tool, wait (phase 2).**
    - Why: each answers a team question with data agentglass already computes (budgetState, git-linkage, skill rows,
      state enum, wait families); none needs new collection beyond the room stream.
    - Cost if wrong: small per item; each is a separate task.
19. **Keys at rest without passphrase.**
    - Options: (a) 0600 files; (b) passphrase + KDF; (c) OS keychain.
    - **Decision: (a).**
    - Why: background sync cannot prompt; keychains differ per OS and are unreachable over SSH sessions. Equivalent to
      an unencrypted SSH key, said in `doctor` and README.
    - Cost if wrong: a stolen home directory reads the team's rooms; removal of that device rotates keys.
20. **Limits: 64 devices, 16 rooms per view.**
    - Why: the measured CLI merge of 30 one-repo streams of this extreme host takes 12 s and 566 MB; typical streams
      are ~10× smaller. 64 keeps the tested budget; teams beyond that want a different tool.
    - Cost if wrong: raising the cap after the bench is a constant.

21. **Display names: who sets them, how they are protected** (user requirement; mechanism decided here).
    - Options: (a) chosen by the member, signed with their key, sealed with the team key; (b) set by the admin in the
      manifest; (c) taken from git/OS without asking.
    - **Decision: (a)**, default proposed from `git config user.name`, editable, pseudonyms allowed, `team rename-me`.
    - Why: the user wants members to appear under the name they chose; only the key holder can claim it (no peer can
      spoof or rename another); sealing keeps names away from the folder/relay. (b) makes admins gatekeepers of
      identity; (c) leaks a real name a person may not want in this team.
    - Cost if wrong: two members can pick the same name — shown with an id suffix, never silently merged.
22. **Activity log from signed facts only.**
    - Options: (a) derived from manifest versions, name claims, member events and leave notices; (b) a free-form
      shared log file.
    - **Decision: (a).**
    - Why: every line is attributable to a key and cannot be forged by another member; a shared append-only file
      would conflict in sync folders. Sharing events say "shares into room X" without repos (the repos are private
      policy).
    - Cost if wrong: an event type nobody signs (e.g. "budget passed") is computed locally by each viewer instead.
23. **Depend on local-web-api; build slice by slice.**
    - Options: (a) team-only web endpoints; (b) the generic local API with team dimensions, both specs built
      together; (c) teams first, web later.
    - **Decision: (b)** (user decision 2026-10-10).
    - Why: the web UI must work without teams; one read model serves CLI, TUI and browser; slices give members
      something real in TUI and browser early (S1 own sessions, S2 teammates).
    - Cost if wrong: team work waits for W1–W6 of local-web-api in S1; fleet-teams T1–T3 run in parallel with them.
24. **Team commands from the browser: own membership only.**
    - Decision: join/share/leave/invite/rename-me as R3 commands with the consent preview as the confirm summary; no
      command addresses another member's machine, and team streams never carry commands.
    - Why: a team channel that could run anything on a peer would turn shared analytics into remote control.
    - Cost if wrong: nothing to lose; asking a teammate stays a chat message.
25. **Device labels instead of hostnames.**
    - Decision: a label chosen at join (default `<os>-<4 hex>`), never the hostname.
    - Why: hostnames often name people, customers or employers; the `numbers` level already drops them.
    - Cost if wrong: one more field on the consent screen.
26. **Local view in a container?** (lead analysis, user consideration 2026-10-10)
    - Options: (a) native binaries only for the per-developer view; (b) also a container for local use.
    - **Decision: (a).** Recorded in local-web-api Decision 15 with its cost.
27. **Team server as an admitted device.**
    - Options: (a) the server is a team member of kind `server`, admitted per room, revocable; (b) the server gets
      every room key by configuration; (c) the server is only a relay (ciphertext) and the browser decrypts.
    - **Decision: (a)** (lead analysis, adopted).
    - Why: the same admission, rotation and removal as everyone else; rooms not granted stay ciphertext on the
      server; (b) silently widens who can read; (c) would need member keys in the browser (key storage, XSS
      exposure, every viewer a member) — the opposite of the goal of a view for people without agentglass.
    - Cost if wrong: the operator can read the granted rooms; members see that on their consent screens.
28. **Web identity on the server: proof by the member's key.**
    - Options: (a) OIDC/proxy login + a one-time code signed by the member's key (`team link-web`); (b) an admin
      maps e-mails to members by hand; (c) OIDC groups.
    - **Decision: (a).**
    - Why: only the key holder can claim a member; no e-mail lists to maintain; works with any identity provider.
    - Cost if wrong: one command per member once; an admin can revoke links.
29. **Compose first (S6), Helm and built-in OIDC later (S7).**
    - Why: small teams run compose with Caddy + oauth2-proxy today; enterprises need Helm, NetworkPolicy and
      direct OIDC — built after the relay and image have run in the field.
    - Cost if wrong: an enterprise waits one slice; compose works on any VM meanwhile.
30. **One pod, two containers, replicas 1.**
    - Why: relay and web share file-based state on one volume with one writer; scaling out needs object storage and
      locking, not justified for teams of ≤ 64 devices (Decision 20).
    - Cost if wrong: a pod restart is a short outage; members keep working locally and catch up through their chains.

## Open questions (technical verification during implementation)
1. Monocypher on macOS arm64/x64 with `--backend c` and the libproc manifest in one build (Linux measured; macOS
   expected identical) — Task 1 runs it in the macOS CI job.
2. scriptc `--ffi` with a `bytes` parameter of length 0 (empty plaintext, empty associated data): pointer may be null
   — the wrapper must not dereference it; Task 1 check covers it.
3. Syncthing's handling of tmp + rename of hidden `.name.tmp` files (ignored by default patterns?) — Task 5 checks
   with a real Syncthing pair if one is available, else documents `.stignore` lines.
4. Sync roots on macOS (`~/Library/CloudStorage/*` names for Dropbox/Google Drive/OneDrive) — Task 9 lists the real
   names on the macOS runner.
5. Per-member merge memory on the bench: the ≤ 150 MB TUI budget for 30 streams is an estimate from the CLI runs —
   Task 8 measures and records it; if exceeded, ownership rows of other members are dropped after their member merge.
6. Distroless `cc-debian12` provides every shared library `agentglass` and the Bun binary load (`ldd` in the image
   build; a missing one → copy it in or switch to `base-debian12:nonroot`) — Task 19.
