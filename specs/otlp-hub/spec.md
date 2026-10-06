# OTLP hub: Collector file reader and `agentglass receive` — spec

Status: **draft** (2026-10-06). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4). Builds on
[fleet](../fleet/spec.md) (the remote-host model, section 1 there, and the exact merge, section 13 there) and
[otlp-complete](../otlp-complete/spec.md) (the logs stream, `host.id`, titles, request ids, client TLS, and the
receiver contract, section 4 there). Two parts:
- **Part 1 — hub reader**: a `HostFeed` (`kind: "otlp"`) that reads OTLP/JSON files as an OTel Collector's file
  exporter writes them, and maps them to `HostReport`s.
- **Part 2 — `agentglass receive`**: a built-in OTLP/HTTP receiver that authenticates each host with its own token,
  stores per host in the same file format, and so feeds the same reader.

## Goal
1. Hosts that the viewer cannot reach — laptops behind NAT, CI runners, containers, short-lived VMs — appear in the
   fleet view with the same rows, exact costs, liveness and alarms as SSH hosts, by **pushing** their export.
2. agentglass collects its own OTLP export end to end (dogfooding): `agentglass --watch --otlp` on each host,
   `agentglass receive` on the hub, the fleet view on top. No third-party service needed.
3. Teams that need mutual TLS or central policy keep an OTel Collector in front; agentglass reads what it writes.
4. Secure by default: loopback only, a token per host, redaction at the source, hub-side scrubbing as a second line,
   a disk budget, private files.

## Why (user value)
- The SSH pull needs a reachable host. The machines people forget most — the CI runner that burned a budget overnight,
  the VM that waits for an approval, a colleague's laptop in a small team — are often the ones that cannot be reached.
  They can push.
- The export already resumes exactly-once from its state file, carries deterministic ids and, with otlp-complete,
  liveness and alarms. A receiver turns it into a complete collection and distribution path.
- Many teams already run a Collector. Reading its file output is the cheapest way to join that pipeline; the
  Collector also does what agentglass cannot (mTLS, OIDC, fan-out to other backends).
- One reader for both sources means one set of mapping, dedup and security rules.

## Today (measured, not guessed)
- **No listener exists.** Nothing in `src/` creates a server (`grep createServer` empty). The ROADMAP lists "a local
  OTLP receiver" under "Explicitly not planned" with the condition "revisit only if a needed signal is missing from
  on-disk transcripts" (`specs/ROADMAP.md`).
- **The exporter** (`src/features/otlp/`) sends OTLP/JSON over HTTP with gzip (`send.ts`, `http.ts:44-74`),
  deterministic ids (`ids.ts`), a resumable state file (`state.ts`), `host.name` opt-in (`encode.ts:149-156`).
  otlp-complete adds `host.id`, client TLS, the logs stream and the receiver contract.
- **The remote-host model** (`HostFeed` → `HostReport`, `SessRow` with `days`/`own`, `LiveRow`) and the exact merge
  (`ownerIndex`, shadow entries, re-pricing) are specified in fleet sections 1 and 13; this spec only adds a feed.
- **scriptc 0.1.7 can serve HTTP.** A 25-line probe built natively here (`http.createServer`, `zlib.gunzipSync`,
  bearer check, append to a file; 2.4 MB binary):

| Probe (2026-10-06, Linux x64, loopback, curl 8.14.1) | Result |
|---|---|
| POST without the token | 401 |
| 20,000-span OTLP/JSON body, gzip 171 KB → 4.0 MB | 200 in 5–9 ms per request (decompress + append included) |
| the same body uncompressed (4.0 MB) | 200 after **1.006 s**: curl sends `Expect: 100-continue` for large bodies and the probe server never answered `100 Continue`, so curl waited its 1 s timeout |
| RSS of the probe after the requests | 27 MB |

- **What scriptc cannot do (checked in scriptc's surface manifest and lowering):** client-certificate handshakes on a
  server (`requestCert` is fenced: SC2020), Unix-domain-socket listening, HTTP/2 without TLS (so no gRPC).
  `https.createServer` with a certificate and key builds, but the LLVM tier refuses it and the build falls back to
  the C backend (`backend c (llvm refused: libCall:https.createServer)`).
- **The C backend is already a release path:** the darwin-x64 release is built with `--backend c`
  (`.github/workflows/build-artifacts.yml:22-23`) and CI builds a C-backend job on every PR
  (`.github/workflows/ci.yml:40-52`).
- **zlib:** `zlib.gunzipSync` works in native builds (the probe); agentglass has its own gzip writer
  (`src/util/gzip.ts:37-95`) but no reader.

## Design

### Part 1 — the hub reader

#### 1. Place in the model
The hub reader is one more `HostFeed` (`kind: "otlp"`, fleet section 1). It produces one `HostReport` per host it
finds, with `days` and `own` (exact) for hosts that export with agentglass, and `live` from the logs stream. Fleet
does the rest: rows, badges, filter, exact merge, re-pricing, budget, allowance, TUI, CLI (fleet sections 7–10,
13–17).

#### 2. Configuration
In `fleet.hosts` (fleet section 2), an entry with an `otlp` directory is a **hub source**; every host found in it
becomes a fleet host:
```json
{"fleet": {"hosts": [
  {"name": "hub", "otlp": "~/.agentglass/hub", "hosts": {"ci": "3f2a…16 hex", "lap": "9c01…"}},
  {"name": "team", "otlp": "/srv/otelcol/agentglass"}
]}}
```
- `otlp`: a directory (`~/` or absolute). The reader scans it and one level of subdirectories.
- `hosts` (optional): display names for host ids. A host without an entry is named after its `host.name` when sent
  (sanitised to the fleet name pattern), else `<source name>-<first 6 hex of host.id>`. Names stay unique (a numeric
  suffix on collision).
- `trust` (default `"label"` for `agentglass receive` directories, `"payload"` otherwise): where the host identity comes
  from (section 5.1).
- `maxAgeDays` (default 30): records older than this are ignored on first read.

#### 3. Files, cursors, rotation
1. **Formats read.** One JSON object per line, each an `ExportTraceServiceRequest` (`{"resourceSpans": …}`) or an
   `ExportLogsServiceRequest` (`{"resourceLogs": …}`) in the protobuf JSON mapping: what the Collector's file
   exporter writes with `format: json`, and what `agentglass receive` writes (section 9). Files: `*.jsonl`, `*.json`
   and, read whole, `*.jsonl.gz` (rotated, closed). Lines with `resourceMetrics` are skipped.
2. **Which files.** Regular files owned by the user or root, not group- or world-writable, in the directory and its
   direct subdirectories (the receive layout and the Collector's `group_by` output). Others are skipped with one
   status line each.
3. **Cursors.** Per file: identity `dev:ino` plus the SHA-256 of its first 4 KB, and a byte offset. A rotated file
   (renamed by the exporter, same inode) keeps its cursor; a file whose first 4 KB changed restarts at 0; a shrunk file
   restarts at 0. Gzip files are read once and remembered by identity.
4. **Budget per tick.** At most 2 MB or 2,000 lines per tick across all sources (the indexing backlog hook keeps the
   tick fast while a backlog exists, as the ledger does); one gzip file per tick at most. A first read of a large
   directory therefore spreads over seconds, with the indexing gauge.
5. **Persistence.** After ingesting, the reader saves per source the aggregated host reports (as full
   `agentglass-snapshot/v1` lines, fleet section 12, reusing its codec) and the cursors in
   `~/.agentglass/fleet/hub-<source>.state` (0600, atomic). A restart resumes from the cursors without re-reading.
6. **Bounded memory.** The reader keeps aggregates (sessions, day rows, own rows, live rows), not spans. A span-id
   set per host covers the last 48 hours of span end times (resends of recent batches); older exact duplicates are
   caught by the message-id dedup (5.3) for Claude and otherwise counted once more (documented).

#### 4. Mapping OTLP to a `HostReport`
| Report field | From |
|---|---|
| host | resource `host.id` (or the authenticated label, 5.1); `Hello.hostName` from `host.name` when sent; `version` from scope `agentglass` version; `redact` true when spans carry fake titles (resource `agentglass.redact`, otlp-complete 3.7) |
| session key | `service.name` → harness id (the otlp-export table, `types.ts:44`) + `:` + `gen_ai.conversation.id` |
| `s.title` | `agentglass.session.title` (latest), else `""` (the list shows the id) |
| `s.cwd`, `s.branch`, `s.remote`, `s.repo` | `process.working_directory`, `vcs.ref.head.name`, `vcs.repository.url.full`, `agentglass.repo.key` |
| `s.model` | `gen_ai.request.model` of the latest `chat` span |
| `s.updated` | latest span end or state record time |
| `s.tokens`, `s.costUsd`, `s.billing.mode` | sums over `chat` spans (input exclusive of cache: `input_tokens − cache_read − cache_write` under `inclusive` semantics, as declared by `agentglass.usage.input_tokens.semantics`); cost `null` when only unpriced usage; mode = the mode with the largest cost |
| `s.tools`, errors | `execute_tool` span counts, `error.type` |
| `s.live`, `attention`, `stuck`, `alerts` | from `LiveRow` (logs), else `false`/`[]` |
| `days` | per local day (viewer time zone) and hour of each `chat` span's end: `tp` rows `[hour, agentglass.provider.id, model, in, out, cache_read, cache_write − write_1h, write_1h, usd]` when `agentglass.usage.cost.source` is a price-table source, else `hx`; unpriced tokens to `unk`/`um` |
| `own` | Claude `chat` spans with `gen_ai.response.id`: `h = msgHash(id)` (fleet 13.1), `key = end ms × 2`, usage as above |
| `prov` | `[agentglass.provider.id, agentglass.billing.mode]` pairs (pi, OpenCode) |
| `live` | the latest `agentglass.session.state` per session; host fresh while the last `agentglass.heartbeat` ≤ 90 s old |
| alerts | `agentglass.alert` records → `LiveRow.alerts`, toasts and `critical` notifications exactly as fleet `watch` (fleet 16.3) |
| `cost` | `null` (fleet computes it from `days`, fleet 7.3) |
| `exact` | `true` when the host's spans come from agentglass (scope name `agentglass`) |

- **Not reconstructable** from the export (shown as `null`/0 in `--json`, listed in the README): `pid`, `path`,
  `bytes`, lines added/removed, skills per session, git commits, the `subagents` count beyond `invoke_agent` spans.
- **Re-pricing** needs the 1-hour cache-write split for Anthropic models: otlp-complete sends
  `agentglass.usage.cache_write_1h.input_tokens` (a subset of `cache_write`, only when > 0; 3.6 there). Spans
  from an older exporter without it are kept at their sent cost (`hx`), not re-priced.

#### 5. Identity and dedup
1. **Host identity.** With `trust: "label"` (receive directories), the host is the directory's authenticated
   label (section 9.3); a record whose `host.id` differs from the label's pinned id was already refused at ingest.
   With `trust: "payload"` (a Collector directory), the host is the resource `host.id`; a Collector that
   authenticates hosts (mTLS, tokens) should add the authenticated identity as a resource attribute
   (`agentglass.auth.subject`, from the Collector's `headers_setter`/`attributes` processor, recipe in section 13);
   when present, the reader uses it and drops records whose `host.id` changes under one subject.
2. **Several feeds for one host** (SSH snapshot + hub): merged by `hostId` (fleet section 17).
3. **Messages across hosts and feeds:** the hub's own rows join fleet's ownership index (fleet 13.2): a Claude
   message exported by one host and held in another host's snapshot is counted once.
4. **Spans within the hub:** the same span id from one host twice (a resend, a Collector retry) counts once (3.6).
5. **Native harness telemetry** in the same files (otlp-complete 4.6):
   - Claude Code `api_request` log records whose `request_id` equals an agentglass span's `agentglass.request.id` are
     dropped (the agentglass span wins); unmatched ones become usage for that host (session from `session.id`, cost
     `cost_usd` as harness-priced `hx`, model, tokens) — the case of a host without agentglass;
   - Claude Code `llm_request` spans whose `gen_ai.response.id` matches an agentglass span are dropped;
   - native metrics are never read (3.1);
   - Codex, Gemini CLI, OpenCode native records are ignored unless `includeNative: true` on the source, then mapped as
     approximate usage (`≈` on the host) per otlp-complete 4.6;
   - `user.email`, `user.account_uuid`, `organization.id` are never stored by the reader (it keeps only mapped
     fields).

### Part 2 — `agentglass receive`

#### 6. Command and lifecycle
```
agentglass receive [--listen 127.0.0.1:4318] [--dir ~/.agentglass/hub] [--tls-cert F --tls-key F]
agentglass receive token add <host> [--expires 90d]     # prints the token once
agentglass receive token rotate <host> [--grace 24h]
agentglass receive token revoke <host>
agentglass receive token list [--json]
agentglass receive status [--json]
agentglass receive service [--print]                     # prints a systemd user unit / launchd agent, never installs
```
- A foreground process; it never runs inside the TUI tick. One instance per directory (`<dir>/receive.lock`,
  `O_EXCL` with the pid, the export lock's rule).
- SIGTERM/SIGINT: stop accepting, finish writes in progress (≤ 5 s), exit 0. SIGHUP: reload tokens, config and the
  TLS certificate.
- Config section `receive` in `~/.agentglass/config.json` mirrors the flags (`listen`, `dir`, `tls`, limits,
  `maxDiskMB`, `retentionDays`, `keepContent`, `drop`); flags win.
- `receive status`: listen address, uptime, per host (requests, records, bytes, last seen, rejected by reason,
  pinned host id, token expiry), disk use vs budget, retention, TLS certificate expiry.

#### 7. Listen policy (secure by default)
- Default `127.0.0.1:4318` (loopback; expose with `tailscale serve` or a reverse proxy, section 11).
- Allowed without further flags: loopback (`127.0.0.0/8`, `::1`), the tailnet ranges `100.64.0.0/10` and
  `fd7a:115c:a1e0::/48` (WireGuard-encrypted and device-authenticated by the tailnet).
- Any other address (a LAN address, `0.0.0.0`, `::`) needs `--listen-public` **and** built-in TLS (section 11.3);
  plain HTTP on a public address is refused (exit 2 with the reason).
- Tokens are required on every address, loopback included (another local user could otherwise write into the hub).

#### 8. Endpoints and formats
| Path | Method | Content-Type | Handling |
|---|---|---|---|
| `/v1/traces` | POST | `application/json`, `application/x-protobuf` | stored (section 9) |
| `/v1/logs` | POST | same | stored |
| `/v1/metrics` | POST | same | **accepted and discarded** (counted in status): native exporters send metrics that the contract never uses (otlp-complete 4.6); answering 200 keeps them from retrying |
| `/healthz` | GET | — | `200 ok`, no auth, no data (for proxies and `tailscale serve` health checks) |
| anything else | — | — | 404; other methods 405 |

- `Content-Encoding`: `gzip` or none; others → 415. Request bodies may be chunked.
- **Protobuf**: a hand-written decoder for `ExportTraceServiceRequest` and `ExportLogsServiceRequest`
  (resource, scope, spans with events, links skipped, status; log records; `AnyValue` incl. arrays, kvlists and
  bytes; 64-bit fields as decimal strings) that produces the same JSON the file stores. Metrics are not decoded.
- **Responses** follow the OTLP/HTTP specification: `200` with an empty `Export…ServiceResponse` in the request's
  encoding, or with `partialSuccess {rejectedSpans|rejectedLogRecords, errorMessage}` when some resources were
  refused (5.1 mismatch); `400` undecodable; `401` missing/unknown/expired token; `403` host id mismatch for all
  resources; `413` too large; `415` unsupported type or encoding; `429` rate limit with `Retry-After`; `503` disk
  budget or write failure with `Retry-After`. 400/401/403/413/415 are not retryable for OTLP clients; 429/503 are.
- **`Expect: 100-continue`**: answered with `100 Continue` when the request is within limits, `413` at once when its
  `Content-Length` is over the limit (the probe measured a 1 s stall without it). If the runtime cannot send an
  interim response, agentglass's own exporter sends `Expect:` empty (curl config) and the README notes the delay for
  other clients.
- No gRPC (HTTP/2 without TLS is not available in scriptc; OTLP/HTTP is the documented alternative every exporter
  supports).

#### 9. Tokens, host pinning and storage
1. **Tokens.** `token add <host>` creates 32 random bytes (from `/dev/urandom`), shown once as `agr_<base64url>`, and
   prints the host-side `otlp-headers` line (`Authorization: Bearer agr_…`) and the `chmod 600` hint. Stored in
   `<dir>/tokens` (0600): `name sha256-hex created expires pinnedHostId` per line — never the token itself.
   Verification hashes the presented token (`src/util/sha256.ts`) and compares hashes.
2. **Rotation and revocation.** `rotate` adds a new token for the host and marks the old one to expire after the
   grace period (default 24 h); `revoke` removes all of the host's tokens at once; `--expires` sets a lifetime
   (default none; `receive status` warns 7 days before). The token file is re-read when its mtime changes (checked at
   most once per second) and on SIGHUP: changes apply without a restart.
3. **Pinning.** The first accepted resource under a token pins its `host.id` to that token (written to the token
   line). Later resources with another `host.id` are refused (`403`/partial success: `host.id … does not belong to
   token "ci"`); `token add --repin` clears the pin (a reinstalled machine). A resource without `host.id` is stored
   under the token's host.
4. **Layout.** `<dir>/<host>/` (0700): `.host` (`{name, hostId, since}`), `traces-YYYYMMDD.jsonl`,
   `logs-YYYYMMDD.jsonl` (UTC days), files 0600; each line one request as OTLP/JSON (protobuf requests converted).
   Closed days are gzip-compressed (`src/util/gzip.ts`) an hour after midnight UTC. The hub reader is configured on
   `<dir>` with `trust: "label"`.

#### 10. Limits, backpressure, disk budget, retention
- Per request: ≤ 8 MB on the wire, ≤ 64 MB decompressed (the gzip ISIZE trailer checked first; decompression with an
  output cap if the runtime supports `maxOutputLength`, else the ISIZE check plus the 8 MB input cap bound it), ≤
  20,000 spans or log records.
- Per token: ≤ 120 requests and ≤ 128 MB decompressed per minute (sliding window) → `429` with `Retry-After`.
- Writes are synchronous appends; when a write fails (disk full, permissions) or the budget is reached → `503`
  `Retry-After: 60`, never a silent drop. The exporter's state file then re-sends from the transcripts.
- **Disk budget** `maxDiskMB` (default 2048) and **retention** `retentionDays` (default 30): every 10 minutes and at
  start, files older than the retention are deleted, then the oldest closed files across hosts until the directory
  is under 90 % of the budget; today's files are never deleted; if today's files alone exceed the budget, ingest
  answers `503` and `receive status` says "disk budget full".
- Connection limits: at most 64 concurrent connections (others closed at accept), 10 s header timeout, 60 s body
  timeout.

#### 11. Exposure
1. **Tailscale** (recommended for a solo user or a small group): `agentglass receive` on loopback,
   `tailscale serve --bg --https=443 http://127.0.0.1:4318`: tailnet-only HTTPS with an automatic certificate; a
   tailnet policy limits which devices may reach the hub's port. Funnel (public exposure) must not be used; the
   README says so and `receive status` warns when the hub is reachable through a public Funnel hostname it can detect
   (`tailscale serve status --json`, when the CLI is present).
2. **A TLS-terminating reverse proxy** in front of loopback (README examples for a generic proxy configuration:
   TLS, HTTP/1.1, request body limit, `X-Forwarded-For` ignored by agentglass).
3. **Built-in HTTPS** (`--tls-cert`, `--tls-key`, PEM; reload on SIGHUP and on file change): a separate binary,
   `agentglass-receive-tls`, built from `src/receive-tls.ts` with `--backend c`, because a program that uses
   `https.createServer` cannot be built on the LLVM tier and the main binary must not change backend. `agentglass
   receive --tls-cert …` runs it when it is installed next to `agentglass` (same directory), else exits 2 with the
   install hint. No client certificates (not supported by scriptc): mTLS is the Collector path (section 13).
4. **Release CI** builds `agentglass-receive-tls` for every release target with `--backend c`
   (`build-artifacts.yml` matrix: a second build step per target), smoke-tests it (self-signed certificate, `curl
   --cacert` POST → 200, token refusal → 401), and ships it in the same archive as `agentglass`; `install.sh` installs
   both binaries when present and verifies both against `SHA256SUMS`. A target where the C build fails ships without
   it (the release notes say so); built-in HTTPS is optional by design.

#### 12. Hub-side scrubbing (defense in depth)
Redaction at the source stays the primary control (otlp-complete: no content by default, `--redact`). At ingest,
before anything is written:
- always dropped: `user.email`;
- dropped unless `receive.keepContent: true`: `gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, status messages;
- `scrubText` (`src/features/redact.ts`) applied to `agentglass.session.title`, `agentglass.tool.command`,
  `agentglass.tool.target`, log bodies and `exception.message`;
- `receive.drop`: extra attribute keys to drop (e.g. `process.working_directory`, `vcs.repository.url.full`).
- Counted per host and shown in `receive status` ("scrubbed 3 content attributes from ci — check its export
  settings"), so a source that sends content is noticed.

#### 13. The team path: Collector with mTLS
For stricter setups (client certificates, OIDC, central policy): hosts export with `otlp.tls` (otlp-complete
section 1) to an OTel Collector (contrib) with `tls.client_ca_file`, an authenticator, an `attributes` processor that
drops `user.email` and adds the authenticated subject as `agentglass.auth.subject`, and the file exporter
(`format: json`, `group_by` on `host.id`, rotation). The viewer reads its directory as a hub source (`trust:
"payload"`, 5.1). The README carries the full Collector configuration.

#### 14. Threat model
| Asset / threat | Mitigation |
|---|---|
| Content on the wire (prompts, tool output, files) | not sent by default (otlp-complete); `--redact` at the source; TLS via tailnet, proxy or built-in HTTPS |
| Eavesdropping / MITM | loopback default; tailnet WireGuard; TLS with a pinned CA on the exporter (`otlp.tls.ca`) |
| A rogue sender injecting sessions or costs | a token per host; tokens hashed at rest; host-id pinning per token; rate limits |
| A stolen token | one host's scope only; `rotate`/`revoke` apply within a second; optional expiry; `receive status` shows last-seen per token |
| Hub compromise | the hub never receives content by default; hub-side scrubbing; per-host directories 0700; tokens hashed |
| Data at rest on the hub | 0700/0600; retention and a disk budget; closed days compressed; an encrypted disk recommended (agentglass does not encrypt files: the key would sit next to them) |
| Resource exhaustion (big bodies, gzip bombs, floods) | size caps before and after decompression, record caps, per-token rate limits, connection limits and timeouts, `503` on budget |
| Accidental public exposure | public binds need `--listen-public` and TLS; Funnel warning; tokens required everywhere |
| Malformed or hostile files in a Collector directory | owner and mode checks, line size cap (16 MB), JSON parsing only, no paths taken from data |
| Personal identifiers from native telemetry | `user.email` dropped at ingest and never stored by the reader |

## Failure modes
- The listen address is taken → exit 2 with the address; another `receive` on the same directory → exit 3 (lock).
- Token file unreadable or not private → refuse to start (exit 2, `chmod 600`).
- Disk full / budget reached → `503` with `Retry-After`; exporters retry; status says why.
- Clock skew between host and hub → records keep the host's times; the heartbeat's observed time shows the skew in
  `receive status`.
- A Collector rotates and compresses files the reader has not finished → the gzip file is read whole once; the
  cursor identity prevents double counting of the renamed part.
- A host's export stops → its heartbeat ages; after 90 s its rows stop showing as live; data stays.
- A protobuf request with unknown fields → ignored per protobuf rules; an undecodable body → `400`.
- The TLS binary is missing on a target → `receive --tls-cert` exits 2 with the hint; plain loopback works.

## Privacy
- No content stored by default; content attributes are dropped at ingest even if a source sends them.
- `user.email` never stored; other identity attributes only as the source sends them, droppable with `receive.drop`.
- Tokens are never stored or logged in clear; the token is printed once at creation.
- The hub directory is the user's own; nothing is forwarded anywhere.

## Interactions with other specs
- **fleet**: the model (section 1 there) is used, not redefined; `kind: "otlp"` hosts get rows, filter, merge, budget,
  TUI and CLI from fleet. The reader's own rows join fleet's ownership index (13.7 there); feed precedence per host
  (17 there). The persisted reader state reuses fleet's snapshot codec (12 there). Fleet's `fleet.hosts` validation
  accepts `otlp` entries with `hosts`, `trust`, `maxAgeDays`, `includeNative` (fleet section 2).
- **otlp-complete**: required inputs — the logs stream (2 there) for liveness and alarms, `host.id`, titles,
  `agentglass.request.id`, `agentglass.repo.key`, `meta` details (3 there), the receiver contract (4 there), client
  TLS (1 there) for the exporter side. It also provides `agentglass.redact` (resource), `agentglass.usage.cache_write_1h.input_tokens`
  (3.6–3.7 there) and the empty `Expect:` header in the exporter (1.3 there). The reader task of this plan needs
  otlp-complete's Task 4 (logs) and Task 3 (attributes).
- **otlp-export**: ids and state unchanged; the hub relies on deterministic ids for span-level dedup.
- **model-prices**: re-pricing of hub hosts uses the viewer's table (fleet 14).
- **rules-config**: alerts arrive as the host's own rule results.
- **release-management**: the release workflow gains the `agentglass-receive-tls` build, smoke test and archive entry;
  `install.sh` installs it.

## Testing
- **Reader** (`otlp/hubread.check.ts`): fixture files (JSON lines of requests produced by the exporter's own encoder
  and by hand in the Collector's shape) → `HostReport`: sessions, tokens (inclusive → exclusive), cost, billing mode,
  days by hour in the viewer zone, own rows for Claude, live rows from state/heartbeat records, alerts; a rotated file
  (rename, same inode) does not double count; a changed head restarts; gzip files read once; group-writable files
  refused; 2,000-line budget per tick; restart resumes from the saved state.
- **Mapping goldens**: one session exported by agentglass (`--dry-run` output of the otlp-export goldens) and read
  back: `jsonSess`-shaped fields equal the source session's `--json` for every reconstructable field.
- **Dedup**: a Claude history exported by host A and held in host B's snapshot → fleet totals equal the single-home
  ground truth (fleet merge check reused); a resent batch counts once; native `api_request` with matching
  `request_id` dropped, unmatched kept as `hx`; `user.email` absent from all stored state.
- **Receive** (`scripts/receive.test.sh`, the built binary on `127.0.0.1:0`):
  - JSON and protobuf (hand-encoded fixtures) → stored lines identical for the same content;
  - 401 without/with a wrong/expired token; rotate: both tokens work during grace, old fails after; revoke: fails at
    once; tokens file holds no clear token;
  - pinning: a second host id under one token → 403 / partial success;
  - limits: 9 MB body → 413; a gzip bomb (ISIZE 1 GB) → 413 before decompressing; 121 requests in a minute → 429 with
    `Retry-After`;
  - `Expect: 100-continue` with a 4 MB body completes in < 200 ms;
  - disk budget: a tiny budget → oldest closed files pruned, then 503 when today's files exceed it; retention prunes;
  - scrubbing: content attributes and `user.email` never reach the files;
  - listen policy: `0.0.0.0` without `--listen-public` and TLS → exit 2; tailnet address allowed;
  - `/v1/metrics` → 200 and nothing stored; `/healthz` → 200 without a token.
- **End to end**: `agentglass --watch --otlp http://127.0.0.1:<port>` from fixture home A (token in `headersFile`) into
  `agentglass receive`; the viewer with the hub source shows A's sessions, live state within 35 s (heartbeat), an alert
  toast, and fleet cost equal to A's `cost --json`.
- **TLS binary** (release CI and `scripts/receive-tls.test.sh`, skipped without the binary): self-signed certificate,
  `curl --cacert` → 200; certificate reload on SIGHUP; expired certificate warning in status.
- **Fuzz-ish**: random bytes as protobuf and as JSON bodies never crash the receiver (1,000 cases in a check).

## Out of scope
- gRPC; OTLP metrics storage; client-certificate authentication inside agentglass (Collector path).
- Forwarding received data to other backends (a Collector does that).
- A web UI; multi-user access control on the hub beyond per-host tokens.
- Windows hubs.

## Decisions
Each: question · options · decision · why · cost if wrong.

1. **Build a receiver at all (ROADMAP "not planned" → planned).**
   - Options: (a) keep it out, Collector only; (b) plan it.
   - **Decision: (b).** The user decided (2026-10-06): world-class log collection and distribution, and agentglass
     dogfoods its own OTLP export end to end.
   - Why: unreachable hosts are the "needed signal missing from on-disk transcripts" the old entry named; a solo user
     should not need to run a Collector to see a CI runner; the probe shows the runtime can do it cheaply (5–9 ms per
     4 MB batch, 27 MB RSS).
   - Cost if wrong: a network-facing component to maintain; mitigated by loopback default, tokens, limits.
2. **One reader for Collector files and receive storage.**
   - Options: (a) receive feeds the TUI directly; (b) receive writes Collector-compatible files that the hub reader
     reads.
   - **Decision: (b).**
   - Why: one mapping and dedup path; the TUI never depends on a running receiver; files survive restarts; teams can
     swap receive for a Collector without changing the viewer.
   - Cost if wrong: a few seconds of file latency (the tick reads files, not sockets).
3. **Protobuf.**
   - Options: (a) OTLP/JSON only; (b) JSON and protobuf (hand-written decoder for traces and logs); (c) also gRPC.
   - **Decision: (b).**
   - Why: protobuf is the default encoding of most OTLP/HTTP exporters (including the Collector's and the harnesses'
     own); JSON-only would force users to reconfigure every native exporter. The OTLP trace and log schema is small
     and stable, so a decoder is a bounded piece (~400 lines) with a fuzz test. gRPC needs HTTP/2 without TLS, which
     scriptc does not provide.
   - Cost if wrong: a decoder to maintain when OTLP adds fields (unknown fields are skipped by protobuf rules).
4. **Metrics.**
   - Options: reject (404/415); accept and discard; store.
   - **Decision: accept and discard, counted.**
   - Why: the receiver contract never uses metrics (they would double count spans); rejecting makes native exporters
     log errors and retry forever.
   - Cost if wrong: a user who points metrics at the hub expecting dashboards gets none; `receive status` shows the
     discarded count.
5. **Authentication.**
   - Options: (a) none on loopback; (b) one shared token; (c) one token per host, hashed at rest, rotation with grace,
     revocation, pinning.
   - **Decision: (c), required on every address.**
   - Why: the token names the host, so a stolen token affects one host and can be revoked alone; loopback is shared
     by every local user and process; hashing keeps the token file harmless if read.
   - Cost if wrong: one extra setup step per host (`token add`, a headers file).
6. **Where the host identity comes from.**
   - Options: (a) the payload `host.id`; (b) the authenticated token label, with `host.id` pinned per token.
   - **Decision: (b) for receive; (a) plus an authenticated subject attribute for Collector directories.**
   - Why: a payload is a claim; the token is proof. Collector setups authenticate at the Collector, which can stamp the
     subject.
   - Cost if wrong: a reinstalled machine needs `--repin`.
7. **Listen default and public binds.**
   - Options: (a) `0.0.0.0:4318` like a Collector; (b) loopback, tailnet allowed, public only with TLS and a flag.
   - **Decision: (b).**
   - Why: secure by default; `tailscale serve` or a proxy gives TLS and reachability without exposing a plain port.
   - Cost if wrong: one flag for users who want a LAN listener (and TLS, which they need anyway).
8. **Built-in HTTPS.**
   - Options: (a) none (proxy/tailnet only); (b) in the main binary; (c) a separate C-backend binary
     `agentglass-receive-tls`.
   - **Decision: (c), optional.**
   - Why: `https.createServer` forces the C backend for the whole program; moving the main binary off LLVM for a
     feature few use would risk every user's binary. A second small binary built with the already-supported C path
     isolates it; release CI builds and smoke-tests it per target.
   - Cost if wrong: one more release asset per target; a target without it falls back to proxy/tailnet.
9. **Backpressure.**
   - Options: (a) drop when full; (b) `429`/`503` with `Retry-After`.
   - **Decision: (b).**
   - Why: OTLP exporters retry these; agentglass's own exporter resends from transcripts, so nothing is lost; silent
     drops would make the hub's numbers wrong without a trace.
   - Cost if wrong: a misbehaving client retries; per-token rate limits cap it.
10. **Disk budget and retention defaults.**
    - Options: unlimited; 2 GB / 30 days; per-host quotas.
    - **Decision: 2048 MB total, 30 days, oldest closed files first, today never deleted.**
    - Why: without content a busy host writes a few MB a day; 2 GB holds months for a handful of hosts; 30 days
      matches the transcripts' own default lifetime on several harnesses. Per-host quotas add configuration nobody
      asked for.
    - Cost if wrong: a very chatty source pushes out older days of others; `receive status` shows per-host use.
11. **Hub-side scrubbing.**
    - Options: (a) store as received; (b) drop content and `user.email`, scrub free text, configurable.
    - **Decision: (b).**
    - Why: defense in depth: a misconfigured source (`--content` on) must not fill the hub with source code; the
      counter tells the user which source to fix.
    - Cost if wrong: a user who wants content at the hub sets `keepContent: true`.
12. **mTLS.**
    - Options: (a) build client-certificate auth into agentglass; (b) the Collector path.
    - **Decision: (b).**
    - Why: scriptc cannot request client certificates on a server; the Collector does it well and adds OIDC and
      policy for teams.
    - Cost if wrong: teams that want mTLS run a Collector (they usually do).
13. **At-rest encryption.**
    - Options: (a) encrypt files with a key file; (b) private files plus an encrypted disk.
    - **Decision: (b).**
    - Why: a key next to the data protects nothing; full-disk encryption already covers theft; no crypto library exists
      in the runtime.
    - Cost if wrong: an unencrypted disk exposes metadata (no content by default).
14. **`Expect: 100-continue`.**
    - Options: ignore; answer `100 Continue`; and make the own exporter not send it.
    - **Decision: answer it (or `413` early), and the exporter sends `Expect:` empty.**
    - Why: measured: a 1 s stall per large request otherwise; batches up to 4 MB are routine.
    - Cost if wrong: none.

## Open questions (technical verification during implementation)
1. Does scriptc's `http` server lowering expose `checkContinue` / `writeContinue` (interim `100 Continue`)? If not,
   the receiver answers large requests with `Expect` immediately and the exporter's `Expect:` header avoids the stall.
2. Does a program that contains `https.createServer` fall back to the C backend as a whole, or per module? Confirms
   Decision 8 (Task 0 builds both).
3. `zlib.gunzipSync` with `maxOutputLength`: lowered? Else the ISIZE trailer check plus the 8 MB input cap.
4. `statSync().ino` / `dev` available in the native build for file identity? Else identity = first 4 KB hash + size
   history.
5. Collector file exporter details in the deployed contrib version: line format with `format: json`, rotation naming,
   `group_by` path syntax (alpha component) — checked against a real Collector in the plan's manual task.
6. Reading `/dev/urandom` for tokens and generation ids in the native build (`readBytes` on a character device).
