# OTLP export completeness — spec

Status: **draft** (2026-10-06). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4). Extends
[otlp-export](../otlp-export/spec.md) (implemented). Companion spec: [fleet](../fleet/spec.md) (shares the host
identity, fleet spec section 3).

## Goal
A receiver of agentglass's OTLP export can rebuild what agentglass shows — sessions, turns, usage, cost, liveness,
alarms, titles and the filterable call details — for every host that exports, while the full transcripts stay on
each host:
1. **Client TLS**: `otlp.tls` (CA, client certificate and key) so a host can export to an OTel Collector that
   requires TLS with a pinned CA or mutual TLS. The standard `OTEL_EXPORTER_OTLP_*CERTIFICATE`/`*CLIENT_KEY`
   variables work too.
2. **An OTLP logs stream** from `--watch --otlp`: a host heartbeat, session state on change, `turn.open` when a turn
   starts, and alert transitions.
3. **The missing attributes**: `host.id` on every resource, session titles (opt-in or redacted), the Anthropic request
   id for joining native telemetry, a repo key, and an opt-in "meta" tier of call details (normalized command, target
   path) — all inside the existing privacy rules and `--redact`.
4. **A written receiver contract**: how traces, logs and the harnesses' own telemetry join without double counting,
   and which personal attributes a receiver drops (`user.email`).

## Why (user value)
- Some machines cannot be reached by SSH from the machine where the user looks: laptops behind NAT, CI runners,
  containers, short-lived VMs. They can push. The export is the one channel agentglass already has that every host
  can use, and it already resumes exactly-once from its state file.
- Today a receiver sees only **closed** turns: a running agent, an agent waiting for approval, a stuck one or a fired
  alarm is invisible until the turn ends (2 minutes in live mode, 10 minutes one-shot). That is the part of
  agentglass people watch most.
- A shared Collector usually requires TLS with its own CA, often client certificates. Without client TLS options the
  exporter cannot talk to such a Collector at all.
- The export's turn list shows ids instead of titles, and call spans carry only tool and program names, so the
  filters people use locally (`tool is Bash and cmd ~ deploy`) cannot be rebuilt.
- A user who also switches on a harness's own telemetry needs a rule that keeps one usage record per request and
  keeps personal identifiers out of the shared store.

## Today (current code, with path:line refs)
- **Transport.** `postJson` (`src/util/http.ts:44-74`) writes a curl config to stdin (`-K -`): `url`, `header`,
  `request`, `data-binary`, `dump-header`, `write-out`, `max-time`, `noproxy` for loopback (`http.ts:55-60`). There is
  no `cacert`, `cert` or `key` line. `OtlpCfg` (`src/features/otlp/config.ts:12-16`) has `insecure` and headers only.
  `plainOk` (`config.ts:80-85`) refuses credentials over plain http to a non-loopback host.
- **Retries.** `RETRY_EXIT = [6, 7, 28, 35, 52, 56]` (`src/features/otlp/send.ts:10`). Live mode tries once per flush
  and backs off in the queue (`send.ts:56`, `src/features/otlp/live.ts:39-50`).
- **Endpoint.** `withPath` appends `/v1/traces` to an empty path (`config.ts:63-66`); `endpointOf` reads `--otlp`,
  `otlp.endpoint`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` (`config.ts:68-74`). No logs
  endpoint exists; nothing in the tree posts to `/v1/logs`.
- **Live export.** `liveExport` (`src/features/otlp/export.ts:331-388`) runs the `--watch` poll loop with a sink.
  `liveTick` (`live.ts:79-98`) builds turns per session; `b.open` is the turn being built (`live.ts:95`,
  `src/features/otlp/build.ts:32-38`). Alert rules run in `--watch` only when JSONL lines are printed:
  `const lines = !sink || o.jsonl` (`src/features/cli.ts:246`), `if (o.alerts && lines) alerts()`
  (`cli.ts:319,326`). So `--watch --otlp` without `--jsonl` evaluates no alert rules at all.
- **Resource.** `resource()` (`src/features/otlp/encode.ts:151-158`): `service.name`, `service.version`, `os.type`,
  `host.name` only with `otlp.hostName` (from `uname -n`, `encode.ts:149-150`),
  `agentglass.usage.input_tokens.semantics`, `agentglass.source = transcript`. No `host.id`.
- **Attributes.** `spanAttrs` (`encode.ts:69-117`) sends no title. `gen_ai.response.id` is the request key when the
  request carries a provider message id (`build.ts:222`, `encode.ts:82`). The Claude adapter reads `requestId` only as
  a fallback message id (`src/harness/claude.ts:252`); it is not exported. Tool spans carry `gen_ai.tool.name`,
  `process.executable.name` from `program(norm(arg))` (`build.ts:165`, `src/features/usage/calls.ts:97-99`), and the
  arguments only with `--content` (`build.ts:167`). `tables()` (`encode.ts:119-128`) applies `rename`/`drop` and
  scrubs every string under `--redact`. `vcs.*` are dropped under `--redact` (`encode.ts:31-32`).
- **Turn openers.** Claude opens a turn only on a human prompt: notifications and peer messages become `meta`
  events (`claude.ts:122-132`, `classifyUser` `claude.ts:90`). So every exported turn is a human turn by construction.
- **Native telemetry.** Detection and the `warn|skip|include` policy exist (`src/features/otlp/native.ts`; spec
  otlp-export 3b). The correlation key per harness is on the root span (`encode.ts:19-20,93`).
- **Measured (2026-10-06, curl 8.14.1 / OpenSSL 3.5.3, `openssl s_server -Verify 1` with a private CA):**

| curl config on stdin | Result |
|---|---|
| `cacert` + `cert` + `key` | HTTP 200 in 10 ms |
| `cacert` only (server requires a client certificate) | **exit 56**, `tlsv13 alert certificate required` — exit 56 is in `RETRY_EXIT`, so live mode would retry this forever |
| no `cacert` (private CA) | exit 60, `self-signed certificate in certificate chain` (not retried) |

## Design

### 1. Client TLS
1. **Config** (`otlp` section):
   ```json
   {"otlp": {"endpoint": "https://hub.example.ts.net:4318",
             "tls": {"ca": "~/.agentglass/hub-ca.crt", "cert": "~/.agentglass/host.crt", "key": "~/.agentglass/host.key"}}}
   ```
   - `ca`: PEM file of the CA(s) that signed the receiver's certificate. When set, **only** it is trusted (curl
     replaces the system bundle with it), which pins the receiver to its own CA.
   - `cert` + `key`: the client certificate and its unencrypted private key, for mutual TLS. One without the other
     is an error.
   - Environment, used for each field the config does not set: `OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE` /
     `OTEL_EXPORTER_OTLP_CERTIFICATE` (ca), `…_CLIENT_CERTIFICATE` (cert), `…_CLIENT_KEY` (key); the `LOGS_`
     variants for the logs signal (section 2). Signal-specific variables win over the generic ones, as the OTel
     specification says.
2. **Validation** at start (exit 2 with one message each):
   - every path: `~` expanded; a readable regular file;
   - the key: owned by the user and not readable by group or others (the `headersFile` rule, `config.ts:122-127`):
     `otlp.tls.key … must be yours and private: chmod 600 …`;
   - any TLS field with an `http://` endpoint: `otlp.tls needs an https endpoint`.
3. **Transport.** `postJson` takes a `tls: string[]` (the three paths, `""` = unset) and adds `cacert = "…"`,
   `cert = "…"`, `key = "…"` lines to the curl config on stdin. Paths never appear in argv. No passphrase support:
   a passphrase would be a secret in the config line; an encrypted key fails with curl exit 58 and the message
   `the client key is encrypted or does not match the certificate: agentglass needs an unencrypted key file (chmod 600)`.
4. **TLS errors are not retried.** A send fails without retry, with a specific message, when curl exits 58, 59, 60,
   66, 77, 80, 83, 90 or 91, or when it exits 35 or 56 and its stderr contains one of `certificate required`,
   `unknown ca`, `bad certificate`, `certificate unknown`, `certificate expired`, `certificate revoked`,
   `handshake failure`, `access denied`, `certificate verify failed` (case-insensitive). Messages:
   - certificate required → `the receiver requires a client certificate: set otlp.tls.cert and otlp.tls.key`;
   - unknown ca / bad certificate → `the receiver rejected the client certificate (unknown CA or wrong certificate)`;
   - exit 60 → `cannot verify the receiver's certificate: set otlp.tls.ca to its CA`;
   - expired → `a certificate expired (receiver or client)`.
   In live mode such a failure stops sending for the run (spans stay unmarked, logs are dropped) and prints the
   message once; `agentglass export` sends them later from the transcripts once the config is fixed.
5. `agentglass export --status` prints `tls: ca <path>, client certificate <path> (expires <notAfter>)` when
   `openssl` is on PATH (`openssl x509 -noout -enddate`), else without the date. No network.

### 2. The logs stream (`--watch --otlp`)
1. **When.** Only live mode sends logs. One-shot `agentglass export` sends none: the facts in the stream (state,
   running turns, alerts) are "now" and do not exist for history. `otlp.logs: false` turns the stream off.
2. **Endpoint.** Derived from the traces endpoint unless set:
   - `otlp.logsEndpoint` (config, used as is) wins;
   - else `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (as is) when the traces endpoint came from the environment;
   - else: a traces URL whose path ends in `/v1/traces` → the same URL with `/v1/logs`;
   - else (a custom path): no logs, one notice `logs off: set otlp.logsEndpoint for <url>`.
   - The headers and TLS settings of the traces endpoint apply (`OTEL_EXPORTER_OTLP_LOGS_HEADERS` when headers come
     from the environment).
   - HTTP 404 or 405 on the logs endpoint → logs off for the run with one notice
     (`<host> takes no OTLP logs: the stream is off`); spans are unaffected.
3. **Records.** OTLP `LogRecord`s (protobuf JSON mapping, as the spans), each with `timeUnixNano` (when it happened),
   `observedTimeUnixNano` (when agentglass saw it), `severityNumber`/`severityText`, `eventName` (the OTLP field) and
   the same name in the attribute `event.name` (receivers older than the field read the attribute), a string `body`,
   attributes, and `traceId`/`spanId` where a turn applies (the deterministic ids of otlp-export 4.1).

| `eventName` | When | Attributes (besides the resource) | trace/span ids | Severity |
|---|---|---|---|---|
| `agentglass.heartbeat` | every 30 s while the live export runs | `agentglass.heartbeat.interval` (30, int), `agentglass.sessions.live`, `.busy`, `.attention` (int counts over the selection) | — | INFO (9) |
| `agentglass.session.state` | a selected top-level session changes `live`, `busy`, `attention`, `approval` or `stuck`; again every 300 s while live; once for every live session at start and after a send failure recovered | `gen_ai.conversation.id`, `gen_ai.agent.name`, `agentglass.session.live`, `.busy`, `.attention`, `.approval` (bool, estimated), `.stuck` (the stuck reason code, `""` = fine), `agentglass.session.title` (title rule 3.2), `process.working_directory`, `vcs.*` and `agentglass.repo.key` (span rules) | the open turn's trace id and root span id, if a turn is open | INFO; WARN (13) when attention, approval or stuck |
| `agentglass.turn.open` | a turn opens (first seen open; turns open when the run starts are announced at the first poll) | `gen_ai.conversation.id`, `agentglass.turn.index`, `gen_ai.request.model` (when known) | the turn's trace id and root span id | INFO |
| `agentglass.alert` | a rules transition (`fire`, `escalate`, `deescalate`, `resolve`) | `gen_ai.conversation.id`, `agentglass.alert.rule`, `.severity` (`degraded`/`critical`), `.state`, `.value` (double), `.threshold` (double), one `agentglass.alert.label.<k>` per rule label | the open turn's ids, if any | `degraded` WARN (13), `critical` ERROR (17), `resolve` INFO |

   - Body: the event name, except `agentglass.alert`, whose body is the rendered alert message when titles may be
     sent (3.2) and the rule id otherwise (a message can quote a title).
   - The `turn.open` record of a turn is sent once per run; the span that closes it is the end. A receiver treats a
     turn as running while it has a `turn.open` and no span, its session's latest state is `busy`, and the host's
     heartbeat is fresh.
4. **Resource and scope.** Session, turn and alert records use the span resource of their harness (otlp-export 3.8,
   plus `host.id`, 3.1 below). The heartbeat uses a resource with `service.name = "agentglass"`,
   `service.version` = the agentglass version, `host.id`, `os.type`. Scope: `agentglass`, `BUILD.version`.
5. **Alert rules in live export.** `watch()` runs the alert rules whenever a sink is present and `--no-alerts` is not
   given (today only with JSONL lines, `cli.ts:319,326`). The sink receives each transition through a new
   `Sink.alert(a)` callback; JSONL alert lines stay tied to `--jsonl`.
6. **Delivery.** Best effort, no backfill:
   - A separate in-memory queue of at most 2,000 records, flushed with the spans' cadence (every 5 s or at 512
     records), one `ExportLogsServiceRequest` per flush, gzip like spans.
   - On overflow the oldest records go (one warning). Failures back off like the span queue (5 s doubling to 5 min).
   - No state-file marks. After a failure recovers, one `session.state` per live session is re-sent so a receiver
     catches up.
   - SIGINT/SIGTERM: the final flush includes the log queue (inside the same 5 s budget).
7. **Selection.** The same as spans: `--harness`, `--filter` session clauses, the agent scope. Subagent sessions
   produce no state records of their own (their parent's `busy` covers them).

### 3. Added attributes
1. **`host.id`** on every resource (spans and logs) = `hostId()` (fleet spec section 3: SHA-256 of the machine id and
   uid, 16 hex digits, or the `~/.agentglass/host-id` override). On by default. `attributes.drop: ["host.id"]`
   removes it. `host.name` stays opt-in (`otlp.hostName`).
2. **`agentglass.session.title`** on the root `invoke_agent` span of every turn and on `session.state` records:
   - sent when `otlp.titles: true`, or under `--redact` (then it is the fake title the screen shows);
   - never sent otherwise (a title is usually the first prompt: content);
   - always through `scrubText`, cut to 256 characters.
3. **`agentglass.request.id`** on Claude `chat` spans: the line's top-level `requestId` (the last one seen for the
   request). It joins the harness's own `api_request` log record (`request_id`). Not sent when the line has none.
4. **`agentglass.repo.key`** wherever `vcs.*` would go (all spans of a session with a project identity, and
   `session.state`): the repo-view key as `--json` shows it (`repo.key`). Under `--redact`, where `vcs.*` are
   dropped, it is the first 16 hex digits of SHA-256 of `"agentglass/repo/v1|" + key`: a receiver can still group by
   project without learning its name.
5. **Call details, `otlp.detail: "none" | "meta"`** (default `none`; CLI `--detail meta`). `meta` adds, on
   `execute_tool` spans, without arguments beyond these and without results:
   - shell calls (`catOf` 0): `agentglass.tool.command` = `norm(cmd)` (`calls.ts:97`, at most 200 characters),
     through `scrubText`;
   - file calls (`catOf` 1 edit/write, 2 read/search): `agentglass.tool.target` = the call's path argument, relative
     to the session cwd when inside it, through `scrubText`, at most 256 characters;
   - nothing for other tools.
   Under `--redact` the exporter already reads the fake events, so both values are fake. `--content` implies
   `meta`.
6. **No `agentglass.turn.kind`.** Only human prompts open a turn (Today), so every exported turn is human; the
   attribute would carry one value. Notifications and peer messages stay `meta` events inside a turn.

### 4. The receiver contract (what a reader does with the export)
This section is the interface for any receiver that rebuilds agentglass's view (the planned OTLP hub feed of the
fleet spec, or a user's own Collector pipeline). agentglass documents it in the README; it does not implement a
receiver here.

1. **Host.** A host is its resource `host.id`. A receiver that authenticates senders (a client certificate or a
   bearer token per host) trusts the authenticated identity first and rejects records whose `host.id` does not match
   the identity's known id; `host.id` alone is a label, not proof.
2. **Sessions and turns.** One trace per turn, `gen_ai.conversation.id` per session (otlp-export 1, 4.1). Titles from
   `agentglass.session.title` when present, else the conversation id.
3. **Usage, exactly once.** Usage lives only on `chat` spans (otlp-export 1.4). The same request can arrive more
   than once: a Claude message copied into a fork or a resumed file (different root, so different span ids), a
   session synced to two hosts, a resend. Keep one usage record per `(gen_ai.provider.name, gen_ai.response.id)`:
   the agentglass `chat` span with the earliest end time. Spans without a response id (Codex, Kiro, fx) are unique by
   span id.
4. **Liveness.** A host is fresh while its last `agentglass.heartbeat` is at most 90 s old (three intervals). A session
   is live/busy/attention as its last `session.state` says, only while its host is fresh. Running turns: 2.3.
5. **Alerts.** `agentglass.alert` records are the host's own rules engine results; a receiver shows them, it does not
   re-evaluate rules.
6. **The harnesses' own telemetry at the same receiver.**
   - Prefer agentglass records for usage and cost: they carry history, billing mode, price source and the ownership
     rule. Use a native record only when no agentglass record exists for the same request (a host without
     agentglass, or a turn not closed yet).
   - Claude Code: its `api_request` log records join `agentglass.request.id` on `request_id`; its beta
     `llm_request` spans join on `gen_ai.response.id`. A match is the same request: keep the agentglass one.
   - Native metrics (`claude_code.cost.usage`, `claude_code.token.usage` and the like) are aggregates of the same
     requests: never add them to span sums.
   - Codex, Gemini CLI, OpenCode: no shared request id is verified. Join on `(session id, start ± 2 s, model, token
     counts)` and mark the result approximate, or switch the native export off on hosts that run agentglass, or use
     `--native skip` (otlp-export 3b.2).
   - Native exports carry useful extras agentglass does not have (exact approval waits, retries); a receiver may show
     them next to the agentglass records.
7. **Personal identifiers.** agentglass sends no `user.*` attribute (unchanged). Claude Code's own telemetry sends
   `user.email`, `user.account_uuid` and `organization.id` by default when the user is logged in. A receiver drops
   `user.email` before storing anything (README: one OTel Collector `attributes` processor action
   `{key: user.email, action: delete}`); the planned hub feed drops it on read and never stores it.
   `agentglass export --status` adds, when Claude Code's own telemetry is detected on:
   `claude: its own telemetry sends user.email by default — drop it at your collector (README "OTLP: several hosts")`.

### 5. What stays on the source
| Data | Leaves the host? |
|---|---|
| Full transcripts, prompts, answers, thinking | no; prompt/answer text only with `--content`, cut to `contentMax`, final text per request |
| Tool arguments and results, file contents, shell output | no; arguments/results only with `--content`; `meta` sends the normalized command and the target path only |
| Environment values, credentials, auth files | never (honest-costs rules; the exporter reads none) |
| Titles | only with `otlp.titles` or `--redact` (fake) |
| Project identity | `vcs.*` and `repo.key` (hashed under `--redact`) |
| Liveness, alerts | yes in live mode (logs), without content |
| Usage, cost, models, durations, errors | yes (unchanged) |

### 6. Config and CLI summary
- New keys in `otlp`: `tls {ca, cert, key}`, `logs` (default `true`), `logsEndpoint`, `titles` (default `false`),
  `detail` (`none` | `meta`, default `none`). Wrong types → one warning, default (otlp-export 7.5).
- New flags: `--detail none|meta` (export and `--watch --otlp`), `--no-logs` (`--watch --otlp`).
- `export --status`: TLS paths and expiry, the logs endpoint (or why logs are off), titles and detail settings,
  the `user.email` advice (4.7).
- `--dry-run` (one-shot) is unchanged: one-shot sends no logs. `--watch --otlp --jsonl` keeps printing the JSONL
  stream.
- Help text and README: the TLS block, the logs records, the receiver contract, and a Collector recipe with mTLS
  and the `user.email` drop.

## Failure modes
- CA, certificate or key unreadable, key not private, TLS with `http://` → exit 2 before any send.
- The receiver requires a client certificate the host does not send → measured exit 56; classified as TLS (1.4),
  not retried, one message.
- Certificates expire mid-run → the next send fails with the expiry message; the run stops sending and keeps
  spans unmarked.
- A receiver without logs support → 404/405 → logs off for the run, spans continue.
- The log queue overflows during a long outage → oldest records dropped, one warning; state re-sent after recovery.
- The alert rules file is invalid → the existing rules-config handling (defaults plus a warning); alert records
  follow the effective rules.
- Clock skew between host and receiver → records keep the host's times; the heartbeat's `observedTimeUnixNano`
  lets a receiver estimate the skew.

## Privacy
- Defaults send no content, no titles, no call details; `host.id` is a salted hash; `host.name` stays opt-in.
- `--redact` applies to every new attribute and record (fake titles, fake commands and paths through the fake
  events, hashed repo key, scrubbed strings), as it does to spans today.
- TLS paths are read, the files' contents are only handed to curl; a private key never enters argv, logs, the
  state file or `--json`.
- The receiver contract tells receivers to drop `user.email`; agentglass itself never sends user identifiers.

## Interactions with other specs
- **otlp-export** (implemented): extended, not changed.
  - Trace and span ids keep the `agentglass/otlp/v1` scheme with no host in them, so copies of one session from
    two hosts land on the same ids (otlp-export 4.1, 4.3). The logs stream reuses those ids for `traceId`/`spanId`.
  - The state file (4.3) still marks only spans; logs are never marked.
  - The lock (4.4) covers both signals: one live exporter per endpoint.
  - Endpoint resolution (5.1) gains the logs derivation (2.2); `attributes.extra/rename/drop` (7.4) apply to log
    records and their resources too; `content`/`contentMax` (3.7) unchanged; `--redact` (3.7) extended to the new
    attributes.
  - Retries (6.2) gain the TLS classification (1.4). Compression (6.5) applies to logs requests.
  - Native telemetry (3b): the policy is unchanged; `--status` gains the `user.email` note; the join rules of 4.6
    replace the "may appear twice" advice in the README with a rule.
  - Out of scope there, now in scope: OTLP logs (live only). Metrics and gRPC stay out.
- **fleet**: `hostId()` (`src/util/hostid.ts`) is created by whichever plan lands first, with the interface of the
  fleet spec section 3. The fleet's later OTLP hub feed implements section 4 of this spec.
- **rules-config**: alert transitions come from the same engine; `severityOf` names (`degraded`, `critical`) map to
  log severities.
- **repo-view**: `repo.key` comes from its project identity (`keyShown`).
- **honest-costs, model-prices**: unchanged; usage attributes as today.
- **cli-agent-mode**: inside an agent, `--watch --otlp` still needs `--for`/`--until-idle`.

## Testing
- **TLS config** (`config.check.ts`): fields from config and from each env variable (signal-specific beats generic,
  config beats env), `~` expansion, missing file, group-readable key (refused), cert without key (refused), TLS with
  `http://` (refused).
- **TLS transport** (`scripts/otlp-tls.test.sh`, skipped without `openssl` and `python3`): a private CA, a server
  and a client certificate generated in the test dir; a Python `ssl` server with `CERT_REQUIRED`:
  - with `ca` + `cert` + `key` → 200 and the body decodes;
  - without `cert` → the send fails without retry (one attempt in the server log) and the message names
    `otlp.tls.cert`;
  - without `ca` → the "cannot verify" message;
  - `/proc/<curl pid>/cmdline` captured during a request contains no path of the key.
- **Error classification** (`send.check.ts`): table of `(exit, stderr) → retry?, message`, including the measured
  exit 56 `tlsv13 alert certificate required`.
- **Logs encoding** (`logs.check.ts`): golden `ExportLogsServiceRequest` JSON for each record type (fixed times,
  fixed host id `00112233445566ff`): `eventName` and `event.name`, severities, `traceId`/`spanId` equal to the turn's
  deterministic ids, nanosecond strings, no title without `otlp.titles`, fake title under `--redact`, alert body rule.
- **Live logs** (`live.check.ts`): a session going busy → idle → attention emits exactly the state changes, the
  300 s repeat, a heartbeat every 30 s; a turn opening emits one `turn.open`; an alert transition from a stub rules
  engine emits one `agentglass.alert`; queue overflow drops oldest; recovery re-sends state; `--no-logs` sends none.
- **Endpoint derivation** (`config.check.ts`): the four cases of 2.2, 404 → off.
- **Attributes** (`encode.check.ts`, `build.check.ts`, goldens regenerated with the fixed host id): `host.id` on every
  resource and droppable; `agentglass.request.id` on Claude chat spans from `requestId`; `repo.key` plain and hashed;
  `detail meta` adds `tool.command` for shell and `tool.target` for file calls only, scrubbed; no new attribute
  without its switch.
- **Alerts with a sink** (`cli` test): `--watch --otlp` without `--jsonl` evaluates rules (a stub rule fires once).
- **Manual**: an OTel Collector (contrib) with `tls.client_ca_file` and the file exporter; check spans and logs arrive
  with `host.id`, a rejected client certificate shows the message, and `user.email` from Claude Code's own telemetry
  is dropped by the recipe.

## Out of scope
- A receiver in agentglass (fleet spec: Later, decision pending), reading OTLP back (the hub feed, Later).
- OTLP metrics, gRPC, protobuf.
- Key passphrases, PKCS#12 bundles, OS keychains.
- Logs for one-shot export or history; per-event log records (every tool call as a log).
- Exporting transcripts or files.

## Decisions
Each: question · options · decision · why · cost if wrong.

1. **Client TLS options.**
   - Options: (a) `otlp.tls {ca, cert, key}` plus the standard OTel variables; (b) env variables only; (c) curl's own
     `~/.curlrc`.
   - **Decision: (a).**
   - Why: a config block matches `headersFile` and the rest of `otlp.*`; the OTel variables keep agentglass
     compatible with environments that already set them; `~/.curlrc` is skipped on purpose (`-q`, `http.ts:24`)
     because it can leak headers.
   - Cost if wrong: three config keys that a later keychain integration might replace.
2. **Encrypted private keys.**
   - Options: (a) unsupported, the key file must be private (0600); (b) a passphrase in config or env.
   - **Decision: (a).**
   - Why: a passphrase next to the key protects nothing and would be a secret in a config line; the same model as
     SSH keys used by agents. Short-lived certificates from a small private CA, or a tailnet's own certificates, are the better
     protection.
   - Cost if wrong: users with encrypted keys must export an unencrypted copy for this host.
3. **TLS failures and retries.**
   - Options: (a) keep curl's exit codes as today (56 and 35 retried); (b) classify by exit code and stderr, never
     retry certificate problems.
   - **Decision: (b).**
   - Why: measured: a missing client certificate is exit 56 under TLS 1.3, which today means an endless live retry
     loop with a generic message. A certificate problem never fixes itself within a run.
   - Cost if wrong: a flaky network failure whose text happens to contain one of the phrases is not retried; the
     next `export` run sends the spans.
4. **Logs stream default.**
   - Options: (a) on in `--watch --otlp`, `otlp.logs: false` / `--no-logs` to stop; (b) off unless asked; (c) also in
     one-shot export.
   - **Decision: (a).**
   - Why: liveness is the main gap the stream closes and live export is its only source; the records carry no
     content; receivers without logs answer 404 and the stream switches itself off. One-shot export has no "now".
   - Cost if wrong: extra requests to a backend that bills per record; one flag stops them.
5. **Heartbeat and state cadence.**
   - Options: per-session heartbeats every 30 s; one host heartbeat every 30 s plus state on change and every 300 s.
   - **Decision: one host heartbeat every 30 s, `session.state` on change, every 300 s while live, and after
     recovery.**
   - Why: per-session heartbeats grow with the number of sessions (900 a week on a busy host) without adding
     information; a host heartbeat answers "is this host still reporting"; the 300 s repeat lets a receiver that
     started late learn the state.
   - Cost if wrong: a receiver that missed a change learns it within 5 minutes.
6. **`host.id` default.**
   - Options: (a) on (hashed); (b) opt-in like `host.name`.
   - **Decision: (a)**; `host.name` stays opt-in.
   - Why: without a host key a receiver cannot rebuild a per-host view or tell two hosts with the same hostname apart.
     The value is a salted hash of the machine id and uid; it identifies the machine to whoever has the export, not
     the person. `attributes.drop` removes it.
   - Cost if wrong: one attribute a privacy-strict user drops by config.
7. **Titles.**
   - Options: (a) always; (b) only with `otlp.titles: true`, and under `--redact` as fakes; (c) never.
   - **Decision: (b).**
   - Why: a title is usually the first prompt, which the export treats as content (off by default). Under
     `--redact` the fake title is safe and makes the turn list readable. Users of their own hub opt in once.
   - Cost if wrong: receivers show conversation ids until the user opts in.
8. **Call details.**
   - Options: (a) never; (b) opt-in `meta` tier with the normalized command and target path; (c) part of `--content`
     only.
   - **Decision: (b)**, with `--content` implying it.
   - Why: the filters people use (`cmd ~ deploy`, files touched) need exactly these two values, not the full
     arguments and results. Commands and paths can hold secrets and names, so the tier is opt-in and scrubbed.
   - Cost if wrong: a scrubbed command can still name a private host or path; the user opted in knowingly.
9. **Alert messages in the stream.**
   - Options: (a) always the rendered message; (b) the message only where titles may go, else the rule id.
   - **Decision: (b).**
   - Why: a rendered message can quote the session title; the title rule must not have a side door.
   - Cost if wrong: alert records without `otlp.titles` read as rule ids.
10. **Logs delivery guarantee.**
    - Options: (a) best effort, bounded queue, no backfill; (b) marked in the state file and resent like spans.
    - **Decision: (a)**, with a state re-send after recovery.
    - Why: state and alerts are "now"; a replayed hour-old "busy" is wrong data. Spans keep the exactly-once path for
      history.
    - Cost if wrong: an alert that fired during an outage reaches the receiver only through its later state.
11. **`user.email` from native telemetry.**
    - Options: (a) document the receiver-side drop and warn in `--status`; (b) change the harness's telemetry
      settings; (c) ignore.
    - **Decision: (a).**
    - Why: agentglass never touches a harness's telemetry configuration (otlp-export 3b.5) and never sees those
      records; the drop belongs at the receiver; the status note puts the advice where the user looks.
    - Cost if wrong: a user who skips the README stores e-mails at their receiver; the status line reminds them.
12. **Host in trace ids** (technical).
    - Options: add `host.id` to the id scheme (`v2`); keep `v1`.
    - **Decision: keep `v1`.**
    - Why: the same copied session exported from two hosts should land on the same trace and span ids, so a
      deduping receiver keeps one copy; the receiver contract's usage rule (4.3) covers receivers that keep both.
    - Cost if wrong: none for existing users; a `v2` would re-key every exported trace.
13. **`agentglass.turn.kind`.**
    - Options: add it; leave it out.
    - **Decision: leave it out.**
    - Why: only human prompts open turns (Today), so it would always be `human`.
    - Cost if wrong: if a future adapter opens turns on notifications, the attribute is added then.
14. **Repo identity under `--redact`.**
    - Options: drop like `vcs.*`; send a hashed key.
    - **Decision: hashed key.**
    - Why: a receiver can still group sessions by project (cost per project) without learning names; the hash is
      salted with a fixed prefix, like the trace ids.
    - Cost if wrong: a guessable repo name can be confirmed by hashing it; users who mind drop the attribute.

## Open questions (technical verification during implementation)
1. OTLP/JSON `eventName` on `LogRecord`: confirm the field name in the OTLP proto version the Collector contrib
   release accepts (added in OTLP 1.5); older receivers ignore unknown fields and read the `event.name` attribute.
2. curl exit code and stderr text for an expired client certificate and for a server certificate signed by a different
   CA under OpenSSL 3.x and LibreSSL (macOS curl): the classifier's phrase list is checked against both in Task 2.
3. Claude `requestId`: present on every assistant line of current Claude Code versions, or only on some? If only on
   some, `agentglass.request.id` is the last non-empty one per request.
4. The rules engine in `watch()` with a sink: CPU cost of evaluating rules every 1.5 s in a long-running headless
   export on the perf host (budget: ≤ 0.5 % of a core).
