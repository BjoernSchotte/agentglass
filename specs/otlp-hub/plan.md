# OTLP Hub Implementation Plan (hub reader + `agentglass receive`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosts that cannot be reached over SSH push their agentglass export; the viewer shows them as fleet hosts with exact costs, liveness and alarms. Part 1: a `HostFeed` (`kind: "otlp"`) reading OTLP/JSON files (OTel Collector file exporter output or receive storage). Part 2: `agentglass receive`, an OTLP/HTTP receiver (JSON + protobuf, gzip) on loopback by default with a token per host, limits, backpressure, a disk budget, retention and hub-side scrubbing; optional built-in HTTPS as a C-backend binary built in release CI.

**Architecture:** `src/features/hub/` holds the protobuf decoder (`otlppb.ts`), the token store (`tokens.ts`), the server (`receive.ts`), storage and budget (`store.ts`), the file reader (`read.ts`) and the OTLP → `HostReport` mapper (`map.ts`). Receive writes Collector-compatible JSON lines per host; the reader turns files into `HostReport`s through fleet's model (fleet spec section 1) and joins fleet's exact merge (fleet 13). The TLS variant is a second entry point `src/receive-tls.ts` built with `--backend c`.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build); `node:http`, `node:zlib` (`gunzipSync`, verified in a native probe); curl and Python 3 in shell tests; an OTel Collector contrib binary for the manual check only.

**Spec:** [spec.md](spec.md) — read it first, including "Decisions" and "Open questions". Also read [../fleet/spec.md](../fleet/spec.md) sections 1, 12, 13, 17 and [../otlp-complete/spec.md](../otlp-complete/spec.md) sections 2–4.

**Cross-spec order:**
- Needs from [fleet](../fleet/plan.md): T2 (`model.ts`, `report.ts`), T6 (`hosts.ts`, rows), T9 (`snap.ts` codec, `msgHash`), T12 (`ownerIndex`, shadow entries) — T12 only for this plan's T4 integration step and T5.
- Needs from [otlp-complete](../otlp-complete/plan.md): T3 (attributes) and T4 (logs stream) for T4 here (mapping fixtures use the real encoder) and the end-to-end task.
- Runs **in parallel** with fleet Part B (fleet T11, T12, T14, T15) and with otlp-complete T5.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`; a task is done only when both pass. Single check: `C=$HOME/.cache/agentglass-agents/impl-otlp-hub; mkdir -p $C/home; scriptc build --optimization dev --strip <f> -o $C/x && HOME=$C/home AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme $C/x` (branch expectations on `REDACT` as `src/features/otlp/encode.check.ts:112` does).
- Live runs only with the full isolation set written out literally (fleet plan Global Constraints, plus `AGENTGLASS_HUB_DIR=$S/hub`); `ls ~/.agentglass` before and after.
- **Listeners in tests bind `127.0.0.1` port `0` only**, write their port to a file, and are killed by their own pid in `trap`. Never bind a public address in tests or manual runs.
- **No token in argv, logs, stored files or `--json`** (only its SHA-256 hex in the token file). Tokens and generation ids come from `/dev/urandom`, never `Math.random`.
- Every stored file 0600, every directory 0700 (`secureDir`, `src/features/palette/rundir.ts:17`); refuse to run when the hub dir or the token file is not private.
- scriptc 0.1.7 limits (fleet plan list) plus: no `requestCert`; no Unix-socket listen; no h2c; `https.createServer` only in `src/receive-tls.ts` (never imported from `src/main.ts`'s graph — Task 8 checks with `scripts/check-plan.mjs`-style import closure).
- Secure defaults are contract: loopback default; public binds need `--listen-public` and TLS; tokens on every address; content attributes and `user.email` dropped at ingest.
- One build at a time; `nice` heavy runs; no Collector or receiver left running.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: integration branch `feat/otlp-hub` from `origin/main` (rebased on fleet and otlp-complete as their tasks land) in `../agentglass-otlp-hub`; parallel tasks in `../agentglass-otlp-hub-t<N>` on `feat/otlp-hub-t<N>`; merged back in task order. One PR to `main`.

## Waves (parallel vs sequential)

| Wave | Tasks | Run | Needs |
|---|---|---|---|
| 0 | T0 probes | alone | — |
| 1 | T1 tokens + random + config · T2 protobuf decoder · T3 file reader | **parallel** | T3: fleet T2, fleet T10 |
| 2 | T4 OTLP → HostReport mapping + dedup · T6 receive server | **parallel** | T4: T3, otlp-complete T3+T4, fleet T13 · T6: T1, T2 |
| 3 | T5 hub feed in the fleet · T7 storage budget, retention, status, service · T8 TLS binary + release CI | **parallel** | T5: T3, T4, fleet T6 · T7: T6 · T8: T6 |
| 4 | T9 end-to-end, README (tailnet, proxy, Collector mTLS recipe) | alone | all |

## Review Focus

1. **Authentication cannot be bypassed:** every POST path checks the token before reading more than the headers; `/healthz` returns no data; a revoked token fails within 1 s; token comparison on hashes (T1, T6).
2. **Resource exhaustion:** a gzip bomb is refused before decompression (ISIZE) and capped during it; body, record, rate and connection limits hold under the fuzz test; the server never buffers more than the caps (T6).
3. **No content and no `user.email` on disk** at the hub, whatever a source sends (T6 scrub test greps the stored files).
4. **Exactness through the hub:** a Claude history exported by one host and held in another host's snapshot counts once (T4 + fleet merge); a resent batch counts once (T3/T4).
5. **Main binary backend unchanged:** `src/main.ts` never reaches `https`; the release still builds `agentglass` on LLVM for the same targets as today (T8).
6. **Reader safety:** foreign-owned or group-writable files skipped; rotation never double counts; the tick budget holds (T3).

---

### Task 0: Worktree and runtime probes

**Files:** none committed; findings as `Ruling:` lines in the PR description. Probes live in `$C/probe/`.

- [ ] **Step 1: Worktree + build:** `git worktree add -b feat/otlp-hub ../agentglass-otlp-hub origin/main && cd ../agentglass-otlp-hub && AGENTGLASS_OUT=$C/agentglass ./build.sh`. Expected: success.
- [ ] **Step 2: `Expect: 100-continue`** (open question 1): a probe server with `server.on("checkContinue", (req, res) => { res.writeContinue(); handle(req, res); })`; build; `curl -sS -o /dev/null -w '%{time_total}\n' --data-binary @4mb.json -H 'Authorization: Bearer t' http://127.0.0.1:$port/v1/traces`. Expected: < 0.2 s. If the build refuses `checkContinue`/`writeContinue`: Ruling "no interim response"; T6 answers such requests at once (413 when over the limit, else processes after the body arrives) and relies on the exporter's empty `Expect:` (otlp-complete T2).
- [ ] **Step 3: HTTPS backend scope** (open question 2): build `tls.ts` (`https.createServer({cert, key})` only) and `mixed.ts` (imports both `http` and a module that imports `https`); note the `backend c (llvm refused …)` line for each. Expected: both fall back as a whole → Decision 8 stands (separate entry point). If only the importing module falls back: still keep the separate binary (smaller risk), Ruling records it.
- [ ] **Step 4: `maxOutputLength`** (open question 3): `zlib.gunzipSync(buf, { maxOutputLength: 1048576 })` on a 10 MB-expanding input. Expected: throws `ERR_BUFFER_TOO_LARGE`. Else Ruling: ISIZE check only.
- [ ] **Step 5: `ino`/`dev`** (open question 4): `statSync(f).ino`, `.dev` non-zero and stable across a rename. Else Ruling: identity = first-4 KB hash + size.
- [ ] **Step 6: `/dev/urandom`** (open question 6): `readBytes("/dev/urandom", 0, 32)` (`src/util/fs.ts:16`) returns 32 bytes, two calls differ. Else open + `readSync` directly.
- [ ] **Step 7: Collector file exporter shape** (open question 5): download the OTel Collector contrib release binary for linux-amd64 into `$C/otelcol/` (no install), config: `otlp` receiver on `127.0.0.1:0`-style fixed high port bound to `127.0.0.1`, `file` exporter `format: json`, `path: $C/otelcol/out/spans.jsonl`, `rotation: {max_megabytes: 1}`; send `agentglass export --otlp http://127.0.0.1:<port> --since all` from a fixture home; record one output line's top-level keys and the rotated file name pattern. Kill the Collector by pid. Expected: `{"resourceSpans":[…]}` per line; rotated name `spans-<timestamp>.jsonl`. Save a scrubbed one-line sample as `testdata/hub/collector-sample.jsonl` (fixture data only).
- [ ] **Step 8:** No commit except the fixture in Step 7 (commit it in T3).

---

### Task 1: Token store, random bytes, hub config — wave 1, parallel with T2, T3

**Files:** Create `src/util/rand.ts`, `src/features/hub/tokens.ts`, `src/features/hub/config.ts`, `src/features/hub/tokens.check.ts`, `src/features/hub/config.check.ts`; Modify `src/features/fleet/config.ts` (accept `otlp` entries with `hosts`, `trust`, `maxAgeDays`, `includeNative`), `src/features/fleet/config.check.ts`. If fleet T11 created `src/util/rand.ts` already, reuse it.

**Interfaces — Produces:**
- `rand.ts`: `export function randomBytes(n: number): Uint8Array` (from `/dev/urandom`; throws when unreadable — callers refuse to create tokens), `export function hex(b: Uint8Array): string`, `export function b64url(b: Uint8Array): string`.
- `tokens.ts`: `export interface Tok { name: string; hash: string; created: number; expires: number; pin: string }`; `parseTokens(text): Tok[]`, `tokensText(t: Tok[]): string`; `addToken(file, name, expiresMs): string` (returns `agr_` + b64url(32 bytes), stores only `sha256Hex(token)`); `rotateToken(file, name, graceMs): string` (new token; old ones get `expires = now + grace`); `revokeToken(file, name): number`; `checkToken(toks, presented, now): Tok | null` (hash, compare against non-expired entries); `pin(file, name, hostId)`; `reload(file)` cached by mtime (≤ 1 check per second). File 0600 in a 0700 dir; refuse otherwise with the `chmod` hint.
- `hub/config.ts`: `export interface RecvCfg { listen: string; dir: string; tls: string[]; maxBodyMB: number; maxDecodedMB: number; maxRecords: number; ratePerMin: number; mbPerMin: number; maxDiskMB: number; retentionDays: number; keepContent: boolean; drop: string[]; listenPublic: boolean; warns: string[] }` from `rawSection("receive")` with defaults of spec 10; `export function listenOk(addr: string, pub: boolean, tls: boolean): string` (spec 7: loopback, `100.64.0.0/10`, `fd7a:115c:a1e0::/48` allowed; others need `pub && tls`; `""` = ok, else the reason).
- `AGENTGLASS_HUB_DIR` overrides the default dir `~/.agentglass/hub` (tests).

- [ ] **Step 1: Failing checks**: tokens — add returns `agr_` + 43 chars, the file holds no part of it (`indexOf` of any 8-char slice is −1), `checkToken` accepts it, rejects a changed char; rotate → old and new both accepted until `now + grace`, old rejected after; revoke → both rejected; expiry honored; group-readable file → error mentions `chmod 600`; pin round trip. Config — `listenOk("0.0.0.0:4318", false, false)` non-empty; `("100.101.2.3:4318", false, false)` ok; `("[fd7a:115c:a1e0::5]:4318", …)` ok; `("192.168.1.5:4318", true, false)` non-empty (needs TLS); `(…, true, true)` ok; defaults. Fleet config — `{"name":"hub","otlp":"~/h","hosts":{"ci":"0011223344556677"}}` accepted, `kind "otlp"`; bad host id in `hosts` → warning.
- [ ] **Step 2: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 3: Commit** `feat(hub): token store (hashed, rotation, revocation, pinning), random bytes, receive config`.

---

### Task 2: OTLP protobuf decoder — wave 1, parallel with T1, T3

**Files:** Create `src/features/hub/otlppb.ts`, `src/features/hub/otlppb.check.ts`, `testdata/hub/pb/*.bin` (hand-built fixtures, written by the check's own encoder helper on first run and committed).

**Interfaces — Produces:**
- `export function decodeTraces(b: Uint8Array): { json: string; spans: number; err: string }` and `decodeLogs(b): { json: string; records: number; err: string }` — protobuf wire format (varint, fixed64, length-delimited; unknown fields skipped) for `ExportTraceServiceRequest` / `ExportLogsServiceRequest` → the protobuf JSON mapping as the exporter writes it (`src/features/otlp/encode.ts:131-172` conventions: hex ids, decimal-string nanos and `intValue`, `doubleValue` numbers, arrays, kvlists, `bytesValue` base64).
- 64-bit integers without BigInt: `u64dec(lo: number, hi: number): string` (decimal via repeated division of a two-word value by 10), signed via two's complement for `intValue`.
- Limits inside the decoder: nesting depth ≤ 16, string ≤ 16 MB, total records ≤ the caller's cap (returns `err` beyond).

- [ ] **Step 1: Failing check**: a minimal encoder in the check (varint/len/fixed64 writers) builds: one resource with `service.name`, one span with every AnyValue kind, a negative `intValue`, `startTimeUnixNano = 1790000000000000000`, status code 2, one event; decode → JSON parses and equals the expected object (written in the check); a logs request with `eventName` (field 12) and body string; unknown field numbers skipped; truncated input → `err`; 1,000 random byte strings → never throw, always `err` or a valid JSON.
- [ ] **Step 2: Run** → FAIL; implement; run → pass; the check also times decoding a 20,000-span fixture (expect < 200 ms native; record).
- [ ] **Step 3: Commit** `feat(hub): OTLP protobuf decoder for traces and logs (to the JSON mapping)`.

---

### Task 3: File reader (formats, cursors, rotation, budget, persistence) — wave 1, parallel with T1, T2

**Files:** Create `src/features/hub/read.ts`, `src/features/hub/read.check.ts`, `testdata/hub/collector-sample.jsonl` (from T0 Step 7).

**Interfaces — Consumes:** fleet `snap.ts` (`snapLines`, `feedSnap`) for persistence; `readLines` (`src/util/fs.ts:43`); `OS.fileInfo`.

**Interfaces — Produces:**
- `export interface FileCur { id: string /* dev:ino or head hash */; head: string; off: number; gz: boolean; done: boolean }`.
- `export interface Source { name: string; dir: string; trust: string; maxAgeDays: number; cur: Map<string, FileCur>; backlog: boolean }`.
- `export function scanFiles(src: Source): string[]` — `*.jsonl`, `*.json`, `*.jsonl.gz` in `dir` and its direct subdirectories, owner/mode checks (skip + status reason), sorted by mtime.
- `export function readStep(src: Source, budgetBytes: number, budgetLines: number, sink: (line: string, file: string) => void): { bytes: number; lines: number }` — per spec 3.3–3.4; a line > 16 MB skipped; gzip files decompressed whole (`zlib.gunzipSync`, ISIZE ≤ 256 MB), one per call.
- `export function saveState(src: Source, reports: Map<string, HostReport>): void` / `loadState(name): { cur: Map<string, FileCur>; reports: Map<string, HostReport> } | null` — `~/.agentglass/fleet/hub-<name>.state` (0600, atomic): a header line with cursors, then per host full snapshot lines.

- [ ] **Step 1: Failing check** `read.check.ts`: a temp dir with two files (5 lines, 3 lines) → `readStep` with `budgetLines 4` returns 4 lines, then 4, then 0; append 2 lines → 2 more; rename `a.jsonl` → `a-2026.jsonl` (same inode) → nothing re-read; rewrite `b.jsonl` head → re-read from 0; `c.jsonl.gz` (written with `gzip()`) → its lines once; a 0664 file → skipped with a reason; a subdirectory file read; state round trip resumes exactly; the Collector sample line parses.
- [ ] **Step 2: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 3: Commit** `feat(hub): OTLP/JSON file reader with rotation-safe cursors and persisted state`.

---

### Task 4: OTLP → `HostReport` mapping and dedup — wave 2, parallel with T6

**Files:** Create `src/features/hub/map.ts`, `src/features/hub/map.check.ts`.

**Interfaces — Consumes:** fleet `model.ts` types, `msgHash` (fleet T10), `ownerIndex` (fleet T13, integration step), otlp-export `serviceName` table (`src/features/otlp/types.ts:44-47`, inverted).

**Interfaces — Produces:**
- `export interface Agg { hosts: Map<string, HostAgg> }`, `export interface HostAgg { hostId: string; name: string; hello: Hello; sess: Map<string, SessAgg>; seen: Map<string, number> /* span id → end ms, 48 h */; beat: number; reqIds: Set<string> /* agentglass.request.id, for native joins */; nativeApi: Obj[] }`.
- `export function ingestLine(a: Agg, line: string, label: { name: string; hostId: string } | null, src: Source): void` — parses one request line; per resource: host from the label (`trust: "label"`) or `host.id` (+ `agentglass.auth.subject` rule, spec 5.1); spans → session aggregates (spec 4 table), day rows by the viewer's local day/hour of the span end, own rows for Claude `chat` spans with `gen_ai.response.id`; log records → `LiveRow`s, beats, alerts; native records per spec 5.5 (`api_request` with a known `request_id` dropped; others kept per rule; metrics never present); attributes outside the mapped set are never retained (so `user.email` cannot be stored).
- `export function reportsOf(a: Agg, now: number): Map<string, HostReport>` — `SessRow.s` in the `jsonSess` field order (`JSON_FIELDS`, `src/features/cli.ts:61-62`) with non-reconstructable fields `null`/0 (spec 4), `exact` per spec 4.

- [ ] **Step 1: Failing check** `map.check.ts`: fixture requests produced by the real encoder (`encodeRequest`, `encodeLogs` from otlp-complete) for a Claude session with two turns, an MCP call, a subagent, a heartbeat, a `session.state` (attention) and an alert → one host, one session: tokens (exclusive of cache) and cost equal the fixture's `--json`; title from `agentglass.session.title`; `live`/`attention` from the state record; day/hour rows; own rows = number of `chat` spans with response ids; the same request ingested twice → same totals; a Collector-shaped line with `host.id` and no label → payload host; a label with a different pinned id → resource ignored; a native `claude_code.api_request` record with a matching `request_id` → no extra usage, a non-matching one → `hx` usage; a resource with `user.email` → no `@` anywhere in `JSON.stringify(reportsOf(...))`.
- [ ] **Step 2: Integration with fleet's merge** (needs fleet T13): a second host's snapshot fixture holding copies of two of the session's messages under a later key → `exactFleet` total equals the single-home ground truth (reuse the fixture builder of `src/features/fleet/merge.check.ts`).
- [ ] **Step 3: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `feat(hub): map OTLP spans and logs to host reports; dedup by span, message and native request ids`.

---

### Task 5: The hub feed in the fleet — wave 3, parallel with T7, T8

**Files:** Create `src/features/hub/feed.ts`, `src/features/hub/feed.check.ts`; Modify `src/features/fleet/hosts.ts` (host sources: a feed that yields several hosts), `src/features/fleet/tui.ts` (status text for hub sources), `src/features/fleet/cli.ts` (`fleet status` lists hub-discovered hosts with their source).

**Interfaces — Produces:**
- `export interface HostSource { name: string; poll(now: number): { name: string; hostId: string; state: FeedState }[]; stop(): void }`; `export function hubSource(h: HostCfg): HostSource` — on each poll: `readStep` within the tick budget (2 MB / 2,000 lines; `H.backlog` true while behind), `ingestLine`, `reportsOf` for changed hosts, `saveState` at most every 30 s.
- `hosts.ts`: `FLEET.sources: HostSource[]`; their hosts become `RemoteHost`s (names per spec 2: `hosts` map, `host.name`, `<source>-<6 hex>`), merged with other feeds of the same `hostId` per fleet section 17; their live rows and alerts take the fleet `watch` path (toasts; `critical` → `OS.notify`).

- [ ] **Step 1: Failing check**: a fixture dir with two hosts' lines → two `RemoteHost`s with the configured/derived names; the same `hostId` also configured as an ssh host with a snapshot report → one host, sessions from the snapshot, live from the hub when fresher; a heartbeat older than 90 s → rows not live; a backlog of 10,000 lines is consumed over ≥ 5 polls with `H.backlog` true meanwhile.
- [ ] **Step 2: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 3: Commit** `feat(hub): hub sources as fleet hosts (discovery, naming, feed precedence, live state)`.

---

### Task 6: `agentglass receive` server — wave 2, parallel with T4

**Files:** Create `src/features/hub/receive.ts`, `src/features/hub/scrub.ts`, `src/features/hub/store.ts`, `src/features/hub/scrub.check.ts`, `scripts/receive.test.sh`; Modify `src/main.ts` (import `./features/hub/receive.ts`: CLI registration only), `src/features/cli.ts` (help rows via `addCmd`).

**Interfaces — Produces:**
- `scrub.ts`: `export function scrubRequest(json: string, keepContent: boolean, drop: string[]): { json: string; dropped: number }` — parses the request JSON, removes `user.email`, the content keys of spec 12 unless `keepContent`, `drop` keys (span, event, log and resource attributes), status messages; `scrubText` on the free-text keys; re-serializes.
- `store.ts`: `export function hostDir(root: string, name: string): string` (0700, `.host` file); `export function appendReq(root, name, signal: "traces" | "logs", json: string, now: number): string` (`""` ok, else the error → 503); UTC day files.
- `receive.ts`: `receive(cfg: RecvCfg)` — `http.createServer`; per request: method/path (405/404), `/healthz`; `Authorization` → `checkToken` (401) before reading the body; `Content-Length` > cap → 413 (and `Expect` handling per T0 Step 2); body read with a running byte cap (abort + 413); `Content-Encoding` gzip → ISIZE check → `gunzipSync` (with `maxOutputLength` if T0 Step 4 allows) → 413 on excess; `Content-Type` JSON or protobuf (`decodeTraces`/`decodeLogs`) else 415; record cap; per-resource `host.id` pin check (pin on first; mismatched resources removed → partial success, all mismatched → 403); `scrubRequest`; `appendReq` (503 on failure); per-token sliding-window rate (429 + `Retry-After`); response body in the request's encoding (`{}` JSON / empty protobuf message). Connection cap 64, header timeout 10 s, body timeout 60 s. Lock `<dir>/receive.lock`. Signals per spec 6.
- CLI: `receive [--listen] [--dir] [--listen-public]` (`listenOk` else exit 2), `receive token add|rotate|revoke|list` (T1 functions; `add` prints the token once plus `Authorization: Bearer …` for the host's `headersFile`).

- [ ] **Step 1: Failing check** `scrub.check.ts`: a request with `user.email` on the resource, `gen_ai.input.messages` on a span, `gen_ai.tool.call.result` on a tool span, an `agentglass.session.title` containing `me@example.com` → none of the dropped keys remain, the title is scrubbed, `dropped === 3`; `keepContent` keeps the content keys but still drops `user.email`.
- [ ] **Step 2: Shell test** `scripts/receive.test.sh` (template `scripts/otlp-transport.test.sh`; the built binary; `AGENTGLASS_HUB_DIR=$t/hub`): start `receive --listen 127.0.0.1:0` (the server writes its port to `$t/hub/port`), `token add ci` → `$tok`:
  - no token → 401; `Bearer wrong` → 401; `$tok` + gzip JSON body (from `agentglass export --dry-run` of a fixture) → 200 and `$t/hub/ci/traces-$(date -u +%Y%m%d).jsonl` has the line, mode 600;
  - a protobuf body (from T2's fixture) → 200, stored line equals the JSON-ingest line for the same content;
  - `/v1/metrics` → 200, nothing stored; `/healthz` → `ok`; `GET /v1/traces` → 405; `/x` → 404;
  - 9 MB body → 413; gzip with ISIZE 1 GB (crafted trailer) → 413 without allocation (RSS stays < 100 MB: `ps -o rss=`);
  - a second resource `host.id` under the same token → partial success with `rejectedSpans`;
  - 121 requests in a minute → the 121st 429 with `Retry-After`;
  - `rotate ci` → old and new accepted; `revoke ci` → both 401 within 1 s;
  - `curl` with `Expect: 100-continue` and a 4 MB body → `time_total` < 0.2 s;
  - `receive --listen 0.0.0.0:0` → exit 2; a second `receive` on the same dir → exit 3;
  - `grep -r "$tok" $t/hub` → nothing; `grep -rc '@example.com' $t/hub/ci` → 0.
  Kill the server by pid in `trap`.
- [ ] **Step 3: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Measure** (native, isolated): 200 gzip requests of the 4 MB fixture → mean latency and RSS; record in the PR (spec target: ≤ 20 ms per request, RSS ≤ 64 MB).
- [ ] **Step 5: Commit** `feat(hub): agentglass receive — OTLP/HTTP JSON and protobuf, token per host, limits, scrubbing`.

---

### Task 7: Disk budget, retention, compression of closed days, status, service unit — wave 3, parallel with T5, T8

**Files:** Modify `src/features/hub/store.ts` (budget, retention, gzip of closed days), `src/features/hub/receive.ts` (timer every 10 min; `503` when today exceeds the budget; `status`), Create `src/features/hub/service.ts`, `src/features/hub/store.check.ts`.

**Interfaces — Produces:**
- `export function enforce(root: string, maxBytes: number, retentionDays: number, now: number): { deleted: string[]; used: number; full: boolean }` — spec 10: older than retention first, then oldest closed files across hosts until < 90 % of the budget; today's files never deleted; `full` when today's files alone exceed the budget.
- `export function compressClosed(root: string, now: number): number` — UTC days before today, older than 1 h past midnight: `gzip()` + `writeBin` to `.jsonl.gz.tmp`, rename, delete the `.jsonl`; at most one file per call (the timer loops).
- `receive status [--json]` — spec 6 fields (from an in-memory counter set flushed to `<dir>/status.json` every 10 s, so `receive status` from another process reads it).
- `receive service [--print]` — prints a systemd user unit (`~/.config/systemd/user/agentglass-receive.service` content with `ExecStart=<execPath> receive`) or a launchd plist on macOS, plus the commands to enable it; never writes them.

- [ ] **Step 1: Failing check** `store.check.ts`: fixture tree with files dated over 40 days for two hosts, a 1 MB budget → retention deletes > 30 days, budget deletes oldest closed files next, today's untouched; today alone over budget → `full`; `compressClosed` turns yesterday's file into `.jsonl.gz` that `gunzipSync`s back to the same bytes, mode 0600.
- [ ] **Step 2: Shell additions** to `scripts/receive.test.sh`: a tiny `maxDiskMB` with today's file over it → 503 `Retry-After: 60`; `receive status --json` shows per-host counts and `full: true`; `receive service --print` contains `ExecStart=` and the binary path.
- [ ] **Step 3: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `feat(hub): disk budget, retention, compressed closed days, receive status and service unit`.

---

### Task 8: Built-in HTTPS binary and release CI — wave 3, parallel with T5, T7

**Files:** Create `src/receive-tls.ts` (entry: parses the same flags, builds `https.createServer({cert, key})`, reuses the request handler of `receive.ts` exported as `handler(cfg)`), `scripts/receive-tls.test.sh`; Modify `src/features/hub/receive.ts` (`--tls-cert`/`--tls-key` → exec `agentglass-receive-tls` from `dirname(process.execPath)` with the same args, else exit 2 with the install hint), `.github/workflows/build-artifacts.yml` (second build step per target: `scriptc build --backend c src/receive-tls.ts -o agentglass-receive-tls`, `continue-on-error` per target with a step summary line), `.github/workflows/ci.yml` (the `cbackend` job also builds `src/receive-tls.ts` and runs `scripts/receive-tls.test.sh`), `scripts/package.sh` (archive both binaries when present), `install.sh` (install `agentglass-receive-tls` next to `agentglass` when the archive has it; checksum verified as the main binary), `scripts/verify-release-assets.sh` (accept the optional binary).

**Interfaces — Produces:** `handler(cfg: RecvCfg): (req, res) => void` exported from `receive.ts` (no `https` import there); `receive-tls.ts` is the only file importing `node:https`.

- [ ] **Step 1: Import-closure guard**: add to `scripts/handoff-imports.test.sh` (or a new `scripts/no-https-in-main.test.sh`): the transitive relative imports of `src/main.ts` (the closure logic of `scripts/check-plan.mjs:11-19`) contain no file that imports `node:https`. Expected after this task: passes; it fails if someone imports `receive-tls.ts` from the main graph.
- [ ] **Step 2: TLS test** `scripts/receive-tls.test.sh` (skipped without `openssl` or when the TLS binary cannot be built on this machine): self-signed CA + server cert (as otlp-complete T2), `agentglass receive --tls-cert … --tls-key … --listen 127.0.0.1:0` → `curl --cacert ca.crt -H "Authorization: Bearer $tok"` POST → 200; without token → 401; replace the cert files and `kill -HUP` → the new cert is served (check `openssl s_client -connect … | openssl x509 -noout -serial`); `--listen-public --listen 127.0.0.2:0` with TLS → starts.
- [ ] **Step 3: Release CI**: run the workflow on a branch (`gh workflow run build-artifacts.yml --ref feat/otlp-hub`), check each target's step summary: `agentglass` built as before (same backend lines as on `main`), `agentglass-receive-tls` built with `--backend c` and smoke-tested, or reported as skipped for that target. Paste the matrix result into the PR.
- [ ] **Step 4: Run** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `feat(hub): optional built-in HTTPS as agentglass-receive-tls (C backend); release CI builds and smoke-tests it`.

---

### Task 9: End to end and docs — wave 4

**Files:** Create `scripts/hub.test.sh`; Modify `README.md` (new section "Collect from hosts you cannot reach (hub)": receive on loopback + `tailscale serve`, the proxy option, built-in HTTPS, tokens lifecycle, host setup with `headersFile` and `--watch --otlp` as a user service, the Collector mTLS recipe with `client_ca_file`, an `attributes` processor dropping `user.email` and adding `agentglass.auth.subject`, the file exporter with `group_by` on `host.id`; the threat model in short; what is not reconstructable), `CHANGELOG.md`.

- [ ] **Step 1: `scripts/hub.test.sh`**: fixture home A exports live (`--watch --otlp http://127.0.0.1:$port --for 40s`, token in `headersFile` 0600) into `receive`; the viewer (another fixture home) with `{"fleet":{"hosts":[{"name":"hub","otlp":"$t/hub"}]}}`:
  - `fleet --json` lists A's sessions with `host` = A's derived name, tokens/cost equal to A's `--json`;
  - `fleet status --json` shows the host live-fresh (heartbeat) during the run and stale 90 s after it ends (fake clock not available here: assert `lastBeat` age instead);
  - a fixture alert rule on A fires → the viewer's `fleet status --json` lists the alert;
  - `fleet cost --json` `.approx == false`;
  - host B both in the hub and as a fake-ssh snapshot host (fleet T16 harness) → one host, totals once.
- [ ] **Step 2: Manual Collector run** (T0 Step 7 binary, loopback only): config with `tls.client_ca_file`, a client cert for the exporter (`otlp.tls`), `attributes` processor (`user.email` delete, `agentglass.auth.subject` insert from a fixed value), file exporter with `group_by` on `host.id`; the viewer reads the output dir as a hub source with `trust: "payload"`; check the rows; a request without a client cert is refused by the Collector and the exporter prints the otlp-complete TLS message. Kill the Collector by pid. Notes into the PR.
- [ ] **Step 3: Run** `sh scripts/hub.test.sh` and `sh scripts/check.sh` → no FAIL, all `ok`.
- [ ] **Step 4: Commit** `test(hub): push to receive, read as fleet hosts, end to end; docs(readme): hub, tailnet, Collector mTLS`.
