# OTLP Export Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A receiver can rebuild agentglass's view from the export: client TLS (`otlp.tls`, mTLS) to a Collector, an OTLP logs stream from `--watch --otlp` (heartbeat, session state, `turn.open`, alerts), and the missing attributes (`host.id`, titles, `agentglass.request.id`, `agentglass.repo.key`, the opt-in `meta` call details), inside `--redact` and the content rules; a documented receiver contract for joins with native telemetry and the `user.email` drop.

**Architecture:** `config.ts` parses the new `otlp` keys and derives the logs endpoint; `postJson` gains TLS lines in its stdin curl config and `send.ts` classifies TLS failures as final. The encoder adds `host.id` to every resource and the new span attributes (fed by `build.ts`). A new `logs.ts` builds `LogRecord`s from live state changes, turn opens and alert transitions that `live.ts` detects on the existing poll loop; `watch()` runs the alert rules for a sink and hands transitions to it. Logs have their own bounded queue and are never marked in the state file.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps; curl for HTTP(S). Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh` (Python 3 and OpenSSL for the TLS mock, skipped when absent).

**Spec:** [spec.md](spec.md) — read it first, including "Decisions" and "Open questions"; this plan argues from it. Background: [../otlp-export/spec.md](../otlp-export/spec.md) (the implemented exporter).

**Round:** Round 2 (after 2026.10.4). Needs `src/util/hostid.ts` from [fleet](../fleet/plan.md) Task 1; if that has not merged, Task 3 Step 1 creates it exactly as fleet Task 1 describes (same files, interface and commit), and fleet Task 1 then only verifies it.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`; a task is done only when both pass. Single check: `C=$HOME/.cache/agentglass-agents/impl-otlp-complete; mkdir -p $C/home; scriptc build --optimization dev --strip <f> -o $C/x && HOME=$C/home AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme $C/x` (the suite runs every check with `AGENTGLASS_REDACT=1`: branch expectations on `REDACT` as `src/features/otlp/encode.check.ts:112` does, and run once without it locally). Builds, certificates and mock-server files live under `$C`, never under `/tmp`.
- Live runs with the full isolation set written out literally (zsh does not split `$VAR`): `AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp` (`mkdir -p $S/run && chmod 700 $S/run`); `ls ~/.agentglass` before and after.
- scriptc 0.1.7 limits: nominal typing; no `readlinkSync`; no `n.toString(radix)`; out-of-range array reads trap; SC2003 (no zero-parameter arrow for an optional interface member); no `Record<string, RegExp>` (keep the TLS phrase list a `string[]` matched with `indexOf` on a lowercased string); SC1090 quirks.
- **Secrets:** TLS paths go only into the curl config on stdin, never argv; key contents are never read by agentglass (only `stat` for owner/mode). Header values unchanged (otlp-export 7.1–7.2).
- **Content rules unchanged:** no prompts, outputs, tool arguments or results without `--content`; titles only with `otlp.titles` or under `--redact`; `meta` details only with `otlp.detail: "meta"`/`--detail meta`/`--content`. Every new string attribute goes through `tables()` (rename/drop, scrub under `--redact`).
- **Ids unchanged:** `agentglass/otlp/v1`; log records reuse the turn's trace id and root span id.
- **Logs never marked** in the state file; spans keep the exactly-once path.
- Goldens (`testdata/otlp/golden-*.json`) are regenerated once in Task 3 with the fixed host id `00112233445566ff` (`HOSTID.idFile` pointed at a fixture); the diff must show only the added attributes.
- One build at a time; `nice` heavy runs; kill only pids you started (mock servers: keep their pid from `$!`).
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: integration branch `feat/otlp-complete` from `origin/main` in `../agentglass-otlp-complete`. Parallel tasks in worktrees `../agentglass-otlp-complete-t<N>` on `feat/otlp-complete-t<N>` from `feat/otlp-complete` at the wave start; merged back in task order (rebase, fast-forward). One PR to `main`, rebase-merge after green CI.

## Waves (parallel vs sequential)

| Wave | Tasks | Run | Needs |
|---|---|---|---|
| 0 | T0 | alone | — |
| 1 | T1 config keys + logs endpoint | alone | T0 |
| 2 | T2 TLS transport + classification · T3 attributes + `host.id` | **parallel** (T2: `http.ts`, `send.ts`; T3: `encode.ts`, `build.ts`, `types.ts`) | T1 |
| 3 | T4 logs stream | alone | T1, T2, T3 |
| 4 | T5 status, README, manual Collector run | alone | T4 |

## Review Focus

1. **Endless TLS retries**: the measured exit 56 `tlsv13 alert certificate required` must not be retried; a real connection reset (exit 56 without a TLS phrase) still is (Task 2 table test).
2. **Key file safety**: a group-readable key is refused before any send; the key path never shows in curl's argv (`/proc/<pid>/cmdline` capture, Task 2).
3. **Title/content side doors**: no `agentglass.session.title`, no alert message body, no `tool.command`/`tool.target` without their switches; under `--redact` only fake values (Task 3, Task 4 goldens grep for fixture titles and paths).
4. **Liveness correctness**: exactly one `turn.open` per turn per run; state records only on change + 300 s repeat + recovery; heartbeat every 30 s; a stale backoff never floods (Task 4 check with a fake clock).
5. **No change to existing span output** beyond the added attributes: golden diffs reviewed line by line (Task 3 Step 5).
6. **Alert rules with a sink**: rules run under `--watch --otlp` without `--jsonl`; JSONL alert lines still only with `--jsonl` (Task 4).

---

### Task 0: Worktree, open questions

**Files:** none committed; findings as `Ruling:` lines in the PR description.

- [ ] **Step 1: Worktree + build:** `git worktree add -b feat/otlp-complete ../agentglass-otlp-complete origin/main && cd ../agentglass-otlp-complete && AGENTGLASS_OUT=$HOME/.cache/agentglass-agents/impl-otlp-complete/agentglass ./build.sh && sh scripts/check.sh`. Expected: build succeeds, all `ok`.
- [ ] **Step 2: Open question 1 — `eventName`.** In `~`: `npx opensrc https://github.com/open-telemetry/opentelemetry-proto` then `grep -n "event_name" ~/opensrc/*opentelemetry-proto*/opentelemetry/proto/logs/v1/logs.proto`. Expected: `string event_name = 12;`. JSON name `eventName` (lowerCamel). If absent: send only the `event.name` attribute; Ruling.
- [ ] **Step 3: Open question 2 — curl TLS texts.** With the Task 2 Step 1 certificates: an expired client cert (`openssl x509 -req … -days 0` or `-not_after` in the past) and a server cert from a second CA; run curl as in the spec's measurement table, record `exit` + first stderr line for each. On macOS (LibreSSL curl) the same, if a Mac/CI runner is available. Expected: phrases from the spec list appear; extend the list in Task 2 with any new phrase seen, nothing else.
- [ ] **Step 4: Open question 3 — `requestId`.** `for f in $(ls -t ~/.claude/projects/*/*.jsonl | head -5); do jq -c 'select(.type=="assistant") | has("requestId")' "$f" | sort | uniq -c; done`. Expected: counts of `true`/`false` (no values printed). Mostly `true` → use the last non-empty per request (spec rule either way).
- [ ] **Step 5:** No commit.

---

### Task 1: Config keys and the logs endpoint — wave 1

**Files:** Modify `src/features/otlp/config.ts:12-16,30-58,68-74` (OtlpCfg, `cfgFrom`, new helpers); Modify `src/features/otlp/config.check.ts`.

**Interfaces — Produces:**
- `OtlpCfg` gains `tls: string[]` (`[ca, cert, key]`, `""` = unset), `logs: boolean` (default `true`), `logsEndpoint: string`, `titles: boolean` (default `false`), `detail: string` (`"none" | "meta"`, default `"none"`).
- `export function tlsOf(c: OtlpCfg, env: Map<string, string>, signal: string /* "TRACES" | "LOGS" */): { tls: string[]; err: string }` — per field: config, else `OTEL_EXPORTER_OTLP_<SIGNAL>_<VAR>`, else `OTEL_EXPORTER_OTLP_<VAR>` (`VAR` = `CERTIFICATE`, `CLIENT_CERTIFICATE`, `CLIENT_KEY`); `~` expanded (`tilde`, `config.ts:86`); each set path must be a readable regular file (`statSync(p).isFile()`); the key passes the `ownerMode` + `myUid` rule of `expandRaw` (`config.ts:123-126`); cert without key or key without cert → `err`. Messages exactly as spec 1.2.
- `export function tlsUrlErr(url: string, tls: string[]): string` — `"otlp.tls needs an https endpoint"` when any field is set and the URL is `http://`.
- `export function logsUrlOf(tracesUrl: string, flagOrCfg: boolean, c: OtlpCfg, env: Map<string, string>): { url: string; why: string }` — spec 2.2: `c.logsEndpoint` as is; else when the traces URL came from the environment (`!flagOrCfg`) and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set → it; else a path ending in `/v1/traces` → replaced by `/v1/logs`; else `{url: "", why: "logs off: set otlp.logsEndpoint for " + safeUrl(tracesUrl)}`; `c.logs === false` → `{url: "", why: ""}`.
- `export function logHeaders(c: OtlpCfg, env: Map<string, string>): { headers: string[][]; err: string }` — `expandHeaders` but reading `OTEL_EXPORTER_OTLP_LOGS_HEADERS` before the generic variable when the config has no headers.

- [ ] **Step 1: Failing cases** in `config.check.ts` (its existing `ok` helper): `cfgFrom({tls:{ca:"~/ca.crt"}}).tls[0] === "~/ca.crt"`; `cfgFrom({tls:3}).warns` names `otlp.tls`; `detail: "full"` → `"none"` + warning; `logs` default `true`, `titles` default `false`; `tlsOf` with env `OTEL_EXPORTER_OTLP_CERTIFICATE=/x/ca` and `OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE=/y/ca` → `/y/ca` for TRACES, `/x/ca` for LOGS (files created in HOME); config beats env; a key with mode 0640 → err contains `chmod 600`; cert without key → err; `tlsUrlErr("http://h:4318", ["/a","",""])` non-empty, `https` → `""`; `logsUrlOf("https://h:4318/v1/traces", true, c, env).url === "https://h:4318/v1/logs"`; custom path `https://h/otlp/traces` → `""` + why contains `otlp.logsEndpoint`; `logsEndpoint` set → as is; env-sourced traces URL + `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` → that; `logs:false` → `""`, why `""`.
- [ ] **Step 2: Run** the single check on `src/features/otlp/config.check.ts`. Expected: build FAIL (missing exports).
- [ ] **Step 3: Implement.** Parse `tls` as an object with string fields (wrong type → one warning per field), `logs`/`titles` via `bool`, `detail` via `oneOf(s, "detail", ["none", "meta"], w)`, `logsEndpoint` via `str`.
- [ ] **Step 4: Run** the check → passes (existing last line of `config.check.ts`); `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `feat(otlp): config for client TLS, logs, titles and call detail; logs endpoint derivation`.

---

### Task 2: TLS transport and failure classification — wave 2, parallel with T3

**Files:** Modify `src/util/http.ts:44-74` (`postJson` gains `tls: string[]`), `src/features/otlp/send.ts:7-60` (`SendCfg.tls`, classification), `src/features/otlp/export.ts:279-330,331-388` (validate with `tlsOf`/`tlsUrlErr` before sending; pass `tls`; a final TLS failure in live mode stops sending), `src/features/otlp/send.check.ts`; Create `scripts/otlp-tls.test.sh`.

**Interfaces — Produces:**
- `postJson(url, headers, body, timeoutS, gz, tls: string[] = ["", "", ""])` — appends `cacert = "<ca>"`, `cert = "<cert>"`, `key = "<key>"` (each `cq()`-quoted, only when set) to the stdin config, after `url`.
- `send.ts`: `export function tlsFail(exit: number, err: string): string` — `""` = not a TLS failure; else the user message (spec 1.4). Exits 58, 59, 60, 66, 77, 80, 83, 90, 91 → always TLS; 35/56 only with a phrase from `TLS_PHRASES: string[]` (lowercase) found in `err.toLowerCase()`. `SendOut` gains `final: boolean`. `sendBatch` checks `tlsFail` before `retryable`: a TLS failure returns at once with `final = true`, `msg` = the message.
- `export.ts`: one-shot: a `final` failure ends the run (exit 1, remaining batches unsent, message once). Live: `L.fails` handling gains `L.halt = msg` (new `Live` field, default `""`); `flush` returns without sending while `L.halt` is set; the status line every 60 s repeats `halted: <msg>`.

- [ ] **Step 1: Certificates for tests** — the shell test generates them (copy the spec's measurement): in `scripts/otlp-tls.test.sh`, `command -v openssl >/dev/null && command -v python3 >/dev/null || { echo "skipped: no openssl/python3"; exit 0; }`, then `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes …` for `ca`, `srv` (SAN `DNS:localhost,IP:127.0.0.1`), `cli`; `chmod 600 *.key`.
- [ ] **Step 2: Failing table test** in `send.check.ts`:

```ts
import { tlsFail } from "./send.ts";
const T: [number, string, boolean][] = [
  [56, "curl: (56) OpenSSL SSL_read: OpenSSL/3.5.3: error:0A00045C:SSL routines::tlsv13 alert certificate required, errno 0", true],
  [56, "curl: (56) Recv failure: Connection reset by peer", false],
  [35, "curl: (35) OpenSSL/3.5.3: error:0A000418:SSL routines::tlsv1 alert unknown ca", true],
  [35, "curl: (35) Recv failure: Connection reset by peer", false],
  [60, "curl: (60) SSL certificate problem: self-signed certificate in certificate chain", true],
  [58, "curl: (58) unable to set private key file", true],
  [7, "curl: (7) Failed to connect", false],
];
for (const t of T) ok("tls " + String(t[0]) + " " + t[1].slice(0, 40), (tlsFail(t[0], t[1]) !== "") === t[2], tlsFail(t[0], t[1]));
ok("cert required msg", tlsFail(56, "tlsv13 alert certificate required").indexOf("otlp.tls.cert") >= 0, "");
ok("verify msg", tlsFail(60, "x").indexOf("otlp.tls.ca") >= 0, "");
```

  plus a `sendBatch` case with a stub that cannot be injected? — `sendBatch` calls `postJson` directly: test the retry decision through an exported pure `decide(status, exit, err, attempt, live): "ok" | "retry" | "final" | "fail"` that `sendBatch` uses; table: `(0, 56, "…certificate required", 0, false)` → `"final"`, `(0, 56, "Connection reset", 0, false)` → `"retry"`, `(503, 0, "", 3, false)` → `"fail"`.
- [ ] **Step 3: Run** → FAIL; implement `tlsFail`, `decide`, the `postJson` lines; run → the check's last line passes.
- [ ] **Step 4: Shell test** `scripts/otlp-tls.test.sh`: a Python server (`http.server` + `ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)`, `load_cert_chain(srv.crt, srv.key)`, `load_verify_locations(ca.crt)`, `verify_mode = ssl.CERT_REQUIRED`) on `127.0.0.1:0`, writing its port and one log line per request to the test dir; a fixture HOME with one Claude session (template `scripts/cost.test.sh:10-14`); config `{"otlp":{"tls":{"ca":…,"cert":…,"key":…}}}`:
  - `ag export --otlp https://localhost:$port --since all` → exit 0, server log has one POST to `/v1/traces`, body gunzips to JSON with `resourceSpans`;
  - without `cert`/`key` → exit 1, stderr contains `otlp.tls.cert`, server log shows **one** attempt (no retries);
  - without `ca` → stderr contains `otlp.tls.ca`;
  - key chmod 644 → exit 2, `chmod 600`;
  - `http://` with tls → exit 2, `needs an https endpoint`;
  - during a request (server handler sleeps 1 s), `cat /proc/$(pgrep -n -f "^curl -q")/cmdline | tr '\0' ' '` contains neither `cli.key` nor `cli.crt` (Linux only; pgrep scoped by `-P` to the agentglass pid).
  Kill the server by its `$!` pid in `trap`.
- [ ] **Step 5: Run** `sh scripts/otlp-tls.test.sh` → no FAIL; `sh scripts/otlp-transport.test.sh` still passes; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 6: Commit** `feat(otlp): client TLS (CA, client certificate, key) and final TLS failures without retries`.

---

### Task 3: `host.id` and the new span attributes — wave 2, parallel with T2

**Files:** Modify `src/features/otlp/encode.ts:69-117,151-158` (resource `host.id`; root title; `repo.key`; `request.id`; detail), `src/features/otlp/types.ts:7-20` (`XSpan` fields `reqId`, `cmd`, `target`; `XTurn` fields `title`, `repoKey`), `src/features/otlp/build.ts:158-170,215-225` (fill them), `src/features/otlp/requests.ts` (carry the Claude line's `requestId` with the request key), `src/features/otlp/export.ts:88-122` (`--detail` flag), `src/features/otlp/encode.check.ts`, `src/features/otlp/build.check.ts`, `testdata/otlp/golden-*.json` (regenerated). If `src/util/hostid.ts` is missing: create it per fleet plan Task 1 Steps 2–4 first.

**Interfaces — Produces:**
- `resource()` adds `attrS("host.id", hostId())` after `os.type` (before `tables()`, so `drop`/`rename` apply).
- `XTurn.title` = `titleOf(root)` cut to 256 (filled in `build.ts` when the turn is created); `XTurn.repoKey` = `keyShown(identSync(root).key)` or `""`.
- `spanAttrs`: root `invoke_agent` adds `agentglass.session.title` when `(c.titles || REDACT) && t.title` (value `scrubText(t.title)`); every span with `vcs` attributes context adds `agentglass.repo.key` (`REDACT` → `sha256Hex("agentglass/repo/v1|" + key).slice(0, 16)`), placed right after the `vcs.*` attributes (also under `--redact`, where `vcs.*` are empty); Claude `chat` spans add `agentglass.request.id` when `sp.reqId`; `execute_tool` adds `agentglass.tool.command` (`catOf` 0, `scrubText(norm(arg))`) and `agentglass.tool.target` (`catOf` 1 or 2, the first path-like argument: `arg` as the call graph shows it, made relative to `t.cwd` when it starts with `t.cwd + "/"`, `scrubText`, cut 256) when `c.detail === "meta" || c.content`.
- `export --detail none|meta` and `--watch --otlp --detail …` set `c.detail` (usage error otherwise: `--detail takes none or meta`).

- [ ] **Step 1: Host id module** present (`grep -n "export function hostId" src/util/hostid.ts`), else create it (fleet Task 1). Checks set `HOSTID.idFile` to a fixture file containing `00112233445566ff`.
- [ ] **Step 2: Failing cases** in `encode.check.ts`: every `resource` has `host.id = 00112233445566ff`; `attributes.drop: ["host.id"]` removes it; a root span with `t.title = "fix login bug"` carries no title by default, `agentglass.session.title = "fix login bug"` with `titles: true`; the suite runs checks with `AGENTGLASS_REDACT=1` (`scripts/check.sh`, comment at `encode.check.ts:2`), so branch the expectation on `REDACT` as `encode.check.ts:112` does: under `REDACT` the value is the scrubbed fake, without it the plain title (run the check once each way locally); `repoKey "github.com/acme/app"` → `agentglass.repo.key` plain, and 16 hex under REDACT with no `vcs.*`; chat span `reqId "req_011"` → `agentglass.request.id`; shell tool with `arg "git push origin main"` → `agentglass.tool.command` only with `detail: "meta"`; a `Read` tool with `arg = t.cwd + "/src/a.ts"` → `agentglass.tool.target = "src/a.ts"`; an `mcp__x__y` tool gets neither.
- [ ] **Step 3: Failing case** in `build.check.ts`: a Claude fixture line pair with `"requestId":"req_A"` on both lines of one message → the `chat` span's `reqId === "req_A"`.
- [ ] **Step 4: Run** both → FAIL; implement; run → pass.
- [ ] **Step 5: Goldens:** regenerate with the existing golden update path of `otlp.check.ts` (`grep -n "golden" src/features/otlp/otlp.check.ts` for its update switch), host id fixture as in Step 1. `git diff --stat testdata/otlp` and `git diff testdata/otlp | grep '^[-+]' | grep -v '^+++\|^---' | grep -v 'host.id\|agentglass.request.id\|agentglass.repo.key'` → empty (only added attributes). Paste the stat into the PR.
- [ ] **Step 6: Run** `sh scripts/check.sh` → all `ok`; `sh scripts/otlp-export.test.sh` → passes.
- [ ] **Step 7: Commit** `feat(otlp): host.id on resources; title, request id, repo key and meta call details on spans`.

---

### Task 4: The logs stream — wave 3

**Files:** Create `src/features/otlp/logs.ts`, `src/features/otlp/logs.check.ts`; Modify `src/features/otlp/live.ts:13-29,79-103` (state tracking, turn-open detection, log queue), `src/features/otlp/export.ts:331-388` (logs URL/headers/TLS, a second sender, `--no-logs`), `src/features/cli.ts:127-129,241-333` (`Sink.alert`, rules run with a sink), `src/features/otlp/live.check.ts`, `scripts/otlp-transport.test.sh` (logs endpoint case).

**Interfaces — Produces:**
- `logs.ts`:
  - `export interface XLog { t: number; obs: number; name: string; sev: number; body: string; attrs: Attr[]; traceId: string; spanId: string; h: string /* harness, "" = the agentglass resource */; ver: string }`.
  - `export function sevText(n: number): string` — 9 `INFO`, 13 `WARN`, 17 `ERROR`.
  - `export function heartbeat(now: number, live: number, busy: number, att: number): XLog`.
  - `export interface SState { live: boolean; busy: boolean; attention: boolean; approval: boolean; stuck: string }`; `export function stateLog(s: Sess, st: SState, now: number, open: XTurn | null, c: OtlpCfg): XLog` (attributes and severity per spec 2.3; title by the title rule; `process.working_directory`, `vcs.*`, `repo.key` via the encoder's helpers, exported from `encode.ts` as `sessAttrs(s, c)`).
  - `export function turnOpenLog(t: XTurn, now: number): XLog` (`t` = `b.open`; `timeUnixNano` = `t.t0`).
  - `export function alertLog(s: Sess, a: AlertT, now: number, open: XTurn | null, c: OtlpCfg): XLog` with `export interface AlertT { rule: string; severity: string; state: string; value: number; threshold: number; labels: string[][]; message: string }`; body = `message` when `c.titles || REDACT`, else `rule`.
  - `export function encodeLogs(logs: XLog[], c: OtlpCfg): string` — one `ExportLogsServiceRequest`: `resourceLogs` grouped by `(h, ver)` (resource from `encode.ts` `resource(h, ver, c)`, exported; `h = ""` → `service.name = "agentglass"`, `service.version = BUILD.version`, `host.id`, `os.type`), scope `agentglass`; each record `{timeUnixNano, observedTimeUnixNano, severityNumber, severityText, eventName, body: {stringValue}, attributes (incl. event.name), traceId?, spanId?}`, attributes through `tables()`.
- `live.ts`: `Live` gains `lq: XLog[]`, `lastBeat: number`, `st: Map<string, SState>`, `stAt: Map<string, number>`, `opened: Set<string>` (path + turn key), `logs: boolean`, `halt: string`, `alerts: AlertT[]` (pushed by the sink). `liveTick` after `advance(...)`: computes `SState` per selected top-level session (`live` = `livePid(s) > 0`, `busy` = the builder's busy rule, `attention` = `s.attention`, `approval` = `L.approval(s) !== ""`, `stuck` = `s.stuck`), queues `stateLog` on change or after 300 s while live; queues `turnOpenLog` for a new `b.open` key not in `opened`; a heartbeat every 30 s; drains `L.alerts` into `alertLog`s; `enqueueLog` caps `lq` at 2000 (oldest dropped, one warning). `flushLogs(L, now, sendLogs)` on the span flush cadence; after a failed flush succeeds again, every live session's state is re-queued once.
- `cli.ts`: `Sink` gains `alert: (s: Sess, a: AlertT) => void`; in `watch()`, `alerts()` runs when `o.alerts && (lines || sink)`; it prints the JSONL line only when `lines`, and calls `sink.alert` when a sink exists.
- `export.ts` (`liveExport`): `logsUrlOf`, `logHeaders`, `tlsOf(…, "LOGS")`; `--no-logs`; a `sendLogs` that posts `encodeLogs` to the logs URL with `sendBatch` (gzip as spans); a 404/405 → `L.logs = false`, notice once; a final TLS failure → `L.halt`.

- [ ] **Step 1: Failing check** `logs.check.ts` (fixed `now = 1790000000000`, host id fixture): `encodeLogs([heartbeat(now, 2, 1, 0)], c)` equals a golden string written in the check (resource `service.name agentglass`, `eventName "agentglass.heartbeat"`, attribute `event.name`, `severityNumber 9`, `timeUnixNano "1790000000000000000"`); a `stateLog` with `attention: true` → `severityNumber 13`, no `agentglass.session.title` unless `titles: true`; `turnOpenLog` → `traceId`/`spanId` equal the turn's `traceId` and `spans[0].spanId`; `alertLog` severity `critical` → 17, body is the rule id without `titles`, the message with it; `labels` → `agentglass.alert.label.<k>` attributes. Last line `otlp logs: all checks passed`.
- [ ] **Step 2: Failing cases** in `live.check.ts` with its stubbed sessions and a fake clock: busy → idle → attention gives exactly 3 state records (plus the start snapshot); 300 s later without change → 1 repeat; heartbeat at 0, 30 s, 60 s; a new open turn → 1 `turn.open`, polling again → none; 2001 queued records → 2000 and one warning; a failed `sendLogs` then a good one → one re-sent state per live session; `L.logs = false` → nothing queued; `L.halt` set → no send at all.
- [ ] **Step 3: Run** both → FAIL; implement; run → pass.
- [ ] **Step 4: Alerts with a sink**: a check (or `scripts/rules.test.sh` addition) with a rules file whose rule fires on a fixture session (copy an existing fixture from `scripts/rules.test.sh`), `ag --watch --otlp http://127.0.0.1:<mock> --for 5s` without `--jsonl` → the mock receives a `/v1/logs` request containing `agentglass.alert`; stdout has no JSONL alert line; with `--jsonl` the line is printed too.
- [ ] **Step 5: Transport**: extend `scripts/otlp-transport.test.sh`: the mock answers `/v1/logs` with 200 and records bodies; a `--watch --otlp --for 35s` run gets ≥ 1 heartbeat and the start `session.state`; a second mock answering `/v1/logs` with 404 → stderr `takes no OTLP logs`, spans still posted; `--no-logs` → no `/v1/logs` request.
- [ ] **Step 6: Cost** (open question 4): on the dev box, isolated, `--watch --otlp http://127.0.0.1:<mock> --for 10m` → `ps -o time= -p <pid>` before/after this task's build; CPU difference ≤ 0.5 % of a core (≤ 3 s per 10 min). Record in the PR.
- [ ] **Step 7: Run** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 8: Commit** `feat(otlp): logs stream in live export — heartbeat, session state, turn.open, alerts`.

---

### Task 5: Status, README, manual Collector run — wave 4

**Files:** Modify `src/features/otlp/export.ts:255-278` (`status`), `src/features/otlp/native.ts` (the `user.email` note), `src/features/cli.ts:79` (export help line: `--detail`, `--no-logs`), `README.md` ("Send to an OTLP backend": TLS block, logs records, titles/detail; new subsection "OTLP: several hosts" with the receiver contract of spec 4 and a Collector recipe), `CHANGELOG.md` (Unreleased).

- [ ] **Step 1: `--status`** prints, in this order after the existing lines: `tls: ca <path> · client certificate <path> (expires <date>)` (date from `openssl x509 -noout -enddate -in <cert>` when `openssl` exists; `tls: off` when unset), `logs: <url>` or the `why` of `logsUrlOf`, `titles: off|on`, `detail: none|meta`, and for Claude with `nativeOn` the `user.email` line of spec 4.7. Check: `src/features/otlp/export.check.ts` gains a status-text case with a fixture config.
- [ ] **Step 2: README.** The Collector recipe (contrib distribution): `receivers.otlp.protocols.http` with `tls.cert_file`, `tls.key_file`, `tls.client_ca_file`, `min_version: "1.3"`, endpoint bound to a tailnet or loopback address; `processors.attributes/drop_email` with `{key: user.email, action: delete}`; `exporters.file` writing OTLP/JSON lines; pipelines for traces **and** logs. The host side: `otlp.tls`, `headersFile`, `agentglass --watch --otlp …` as a user service, `agentglass export --since all` for backfill. The receiver contract as a numbered list (spec 4.1–4.7). State plainly: agentglass does not read the receiver back (the fleet hub feed is "Later").
- [ ] **Step 3: Manual run** (no system changes; Collector binary downloaded into `$C`, config in `$C`, bound to `127.0.0.1`): spans and logs arrive in the file exporter output with `host.id`; a client without a certificate gets the `otlp.tls.cert` message; Claude Code's own telemetry is **not** switched on for this (never touch the user's harness settings) — the `user.email` drop is checked with a hand-written OTLP log record posted by curl. Paste the relevant output lines (no hostnames beyond `localhost`) into the PR.
- [ ] **Step 4: Run** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `docs(otlp): TLS, logs stream and the receiver contract; export --status shows TLS and logs`.
