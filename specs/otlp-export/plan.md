# OTLP Export (OpenTelemetry GenAI traces) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agentglass export --otlp <url>` (history, resumable, no duplicates) and `agentglass --watch --otlp <url>` (live) send every harness's sessions to any OTLP/HTTP backend as GenAI-semconv traces: one `invoke_agent` root per turn, one `chat` span per API request, `execute_tool` siblings, subagents under their spawning call.

**Architecture:** Turn segmentation moves out of the call graph into a pure `TurnCursor` (`src/features/callgraph/turns.ts`) that the call graph and the exporter share. The exporter (`src/features/otlp/`) reads each session whole through `sourceOf(h).lines`, feeds `parseEvents` (turns, tools, content) and the adapter's `usage()` (tokens, cost, exact tool timing via two taps), and builds `XTurn` records with deterministic SHA-256 ids. An encoder turns them into OTLP/JSON, a pure-TS gzip compresses the body, and `postJson` sends it through curl (config on stdin). A per-endpoint state file marks exported turns; a lock file keeps a second exporter out.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps; `node:fs`, `node:child_process` (`execFileSync` with `input`); curl CLI for HTTP. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh` (may use `python3` and `gzip`, both present on the CI runners ubuntu-24.04 and macos-14).

**Spec:** [spec.md](spec.md) — the binding authority, including "Decisions (review 2026-10-02)" and "Open questions". Read it first; this plan argues from it.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`; hex via a 16-char lookup string); nominal typing (pass fields); call optional function members via a local; out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log` → SHA-256 round constants and initial hash values are literal tables, never computed.
- Bit math: 32-bit words only, `>>> 0` after every addition, `Math.imul` for multiplication (as `pricing.ts:36`).
- Epoch nanoseconds are strings `String(ms) + "000000"` (ms an integer, `Math.floor`); never a JS number.
- Phase 3. Starts when **parsing-fixes** (turn boundaries, `classifyUser`, Claude `usage.iterations`, `scrubRemote` in `src/util/giturl.ts`), **filter-language** (`src/features/query/`, `projectOf()`) and **honest-costs** (`src/features/usage/billing.ts`: `Bill`, `MODES`, `envSummary`/`SWITCHES`; `src/features/usage/bill-live.ts`: `modeOf(s, prov)`; the `prov` parameter of `tokens()`/`usageExact()`; codec `accOut`/`accIn` with `Acc.uc` at `t` index 9) are merged on `main`.
- No network unless the user runs `export`/`--watch --otlp`. Never write into agent data dirs. Never change a harness's telemetry settings; never read OTLP endpoint values, headers or tokens of a harness.
- Credentials (header values, URL userinfo) never in argv, child env, logs, stderr, `--json`, the state file or `--status`. curl config goes on stdin (`-K -`), `-q` first.
- Ids: prefix `"agentglass/otlp/v1|"` is a contract; changing the scheme needs a new prefix and a changelog entry.
- Usage attributes only on `chat` spans; `invoke_agent` spans never carry `gen_ai.usage.*` or `agentglass.usage.cost` (exception: fx session totals on the last exported root with `agentglass.usage.session_total = true`, spec 3.1).
- Content off by default: without `--content` no `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, titles or status messages.
- Ledger `VERSION` (honest-costs moved it to `src/features/usage/codec.ts`; `cache.ts:15` on `main` today) bumps once in Task 3 (`Acc.rs` persisted) to the next free number at implementation time; no number is reserved.
- Style: match the surrounding code — dense one-line helpers, short `//` why-comments, no classes, no new dependencies. Other harness behavior unchanged: `agentglass --json --subagents --limit 400` identical before/after for all seven harnesses (volatile fields `updated bytes activity live pid status attention stuck` excepted).
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-otlp-export`, branch `feat/otlp-export`, PR to `main`, rebase-merge after green CI.

## Review Focus

1. **Codex `token_count` events that carry no new usage** (rate-limit-only events with `info: null`, a repeated identical total, a counter reset on a new thread): no zero-usage `chat` span, a reset counts fresh like `codex.ts:140`. Task 4 check "codex grain".
2. **Usage conservation:** bookings on lines that are not a request (pi subagent results on a `toolResult`, `<synthetic>` Claude lines, compaction usage) are neither lost nor counted twice — per fixture session, Σ over `chat` spans of in/out/cr/cw/cost equals the Stats `Acc` totals of the same file. Task 5 check "conservation".
3. **Events after a turn closed by quiet time** (a Claude background task notification or a slow tool result arriving > 2 min later, no new prompt): they open a continuation turn keyed by their own first `ts`, never re-send or mutate the already exported trace. Task 1 check "continuation" + Task 13 check "late events".
4. **A turn larger than one batch** (> 512 spans or > 4 MB body): batches hold whole turns; an oversized turn goes alone, split into several requests only when its body exceeds 4 MB, and is marked only when all its requests succeeded. Task 12 check "oversized turn".
5. **An endpoint URL with userinfo or a query token** (`https://u:tok@host/v1/traces?key=x`): userinfo and query never appear in the state file, `--status`, stderr, `--json` or argv; the state key ignores both. Task 9 check "endpoint key" + Task 8 check "argv clean".

---

### Task 0: Worktree, prerequisites, open questions, fixtures

**Files:** `specs/otlp-export/notes.md` (rulings + probe evidence, committed; no real session data), `testdata/otlp/fixtures/` (hand-written lines in real shapes, ≤ 60 lines per file).

- [ ] **Step 1: Worktree + build.** `git worktree add -b feat/otlp-export ../agentglass-otlp-export main && cd ../agentglass-otlp-export && ./build.sh && sh scripts/check.sh`. Expected: build ok, all checks `ok`.
- [ ] **Step 2: Prerequisites merged.** Run: `git log --oneline main | grep -E "parsing-fixes|filter-language|honest-costs"; ls src/util/giturl.ts src/features/query src/features/usage/billing.ts; grep -n "export function classifyUser\|export function scrubRemote\|export function projectOf\|export function modeOf" -r src`. Expected: all four functions found. Expected exact names (from the producer plans): filter-language `parse(src): Parsed`, `compile(cs, ctx): { f: Compiled | null; err: QErr | null }`, `sessMatches(f, s)` (`src/features/query/parse.ts`, `eval.ts`), `projectOf(cwd)` (`src/features/query/project.ts`, body replaced by repo-view); parsing-fixes `scrubRemote(raw): Remote | null`, `classifyUser(o, text)`; honest-costs `modeOf(s: Sess, prov: string): Bill` (`bill-live.ts`), `Bill`, `MODES`, `envSummary(raw)` + `SWITCHES` (`billing.ts`). Note in `notes.md` only the event parsing-fixes emits for a slash-command skill. If any prerequisite is missing: stop, do not start Task 1.
- [ ] **Step 3: Open question 1 (re-export dedupe).** Start Jaeger and Tempo:
  `docker run -d --rm --name agtest-jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest` and `docker run -d --rm --name agtest-tempo -p 3200:3200 -p 4319:4318 grafana/tempo:latest -config.file=/etc/tempo.yaml` (if the image has no default config, mount a minimal `tempo.yaml` with an `otlp: protocols: http: endpoint: 0.0.0.0:4318` receiver and local storage). Post one hand-written two-span `ExportTraceServiceRequest` (fixed `traceId`/`spanId`) twice with `curl -sS -H 'Content-Type: application/json' --data-binary @req.json http://localhost:4318/v1/traces`, then query `curl -s 'http://localhost:16686/api/traces/<traceId>' | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["data"][0]["spans"]))'` and `curl -s http://localhost:3200/api/traces/<traceId>` (count spans). Expected evidence: 2 (dedupe) or 4 (duplicates) per backend. Record the matrix; SigNoz and Honeycomb stay "untested". Fallback (spec): README documents `--resend` as "may duplicate" for every backend not shown to dedupe. Stop both containers.
- [ ] **Step 4: Open question 2 (Claude approval status).** In `/tmp/agtest-otlp`, start `claude` interactively, ask it to run `touch x` (Bash needs approval), and while the prompt waits run `cat ~/.claude/sessions/*.json | python3 -c 'import sys,json;[print(json.loads(l).get("status")) for l in sys.stdin if l.strip()]'` (one JSON object per file; adapt to the real layout). Expected evidence: a status value that differs between "waiting for permission" and "running". If found: Task 13 uses it as an exact wait (`agentglass.estimated` omitted on those). Fallback (spec): estimated waits from the watchdog only.
- [ ] **Step 5: Open question 3 (fx/Kiro token semantics).** fx: in the newest fx session dir, read `usage-v2.json` `snapshot` before and after one more turn that hits the cache; exclusive if `input_tokens` grows by less than `cache_read_tokens` grows. Kiro: confirm `user_turn_metadatas[i]` has only `input_token_count`/`output_token_count` (`python3 -c` over the newest `~/.kiro` session sidecar). Fallback (spec table): fx treated as exclusive (`in + cr + cw`) and marked "unverified" in the README; Kiro exports `in` only, no cache attributes.
- [ ] **Step 6: Open question 4 (native session keys).** `cd ~ && npx opensrc https://github.com/google-gemini/gemini-cli && npx opensrc https://github.com/sst/opencode`; then `grep -rn "session\.id\|'session.id'\|SESSION_ID" <gemini-cli>/packages/core/src/telemetry | head` and `grep -rn "session" <opencode>/packages/util/src/observability | head`. Expected evidence: the attribute key each puts on its spans. Record it; Task 6 uses it. Fallback (spec): `session.id`, README marks it "uncertain".
- [ ] **Step 7: Open question 5 (binary body file).** Write `/tmp/probe-bin.ts`: `import { writeFileSync } from "node:fs"; const b = new Uint8Array(256); for (let i = 0; i < 256; i++) b[i] = i; writeFileSync("/tmp/probe.bin", b);` then `scriptc build /tmp/probe-bin.ts -o /tmp/pb && /tmp/pb && od -An -tu1 /tmp/probe.bin | tr -s ' \n' ' ' | head -c 60`. Expected: `0 1 2 3 …` and `stat -c %s /tmp/probe.bin` = 256. If it fails: try `openSync`+`writeSync(fd, b)`; if that fails too, Task 7's `writeBin` returns false and every run sends uncompressed (spec decision 7). Record which call works.
- [ ] **Step 8: Open question 6 (Codex request grain).** On the newest real rollout: `python3 - <<'EOF'` script that walks `~/.codex/sessions/**/rollout-*.jsonl` (newest 3), and between consecutive `event_msg/token_count` lines whose `info.total_token_usage` changed counts the `response_item` lines of type `message`/`function_call`/`reasoning`. Expected evidence: exactly one model response (one or more items ending in a `message` or `function_call` batch) per changed `token_count`; also count `token_count` lines with `info: null` or unchanged totals. Fallback (spec): a `chat` span covers whatever lies between two changed counts.
- [ ] **Step 9: Fixtures.** For each harness write hand-written fixture lines in the real shapes seen above (no copies of real sessions, ids/paths/text invented, `$HOME` → `/home/u`) under `testdata/otlp/fixtures/<harness>/` covering the golden cases of spec "Testing": Claude (subagent with `toolUseId` in its `meta.json`, an `mcp__ctx__search` call, three streamed lines of one `message.id`, one message with two `usage.iterations` on different models, a denied tool result "The user doesn't want to proceed", an API-error assistant line in the shape `grep -m1 isApiErrorMessage ~/.claude/projects/*/*.jsonl` shows), Codex (`task_started`/`turn_aborted`, cumulative `token_count` incl. one `info: null` and one repeated total, a subagent rollout used in two turns), Gemini (normalized stream with a `$rewindTo`, a model switch inside a turn), OpenCode (rows for a 2.x DB built like `src/harness/opencode.check.ts` builds its DB), pi (`responseModel` ≠ `model`), Kiro (JSONL + sidecar with two `user_turn_metadatas`), fx (`turn_completed` with `turn_duration_ms`, `usage-v2.json`).
- [ ] **Step 10: Commit.** `git add specs/otlp-export/notes.md testdata/otlp/fixtures && git commit -m "chore(otlp): probe evidence, consumed names and hand-written fixtures"`. If a probe contradicts the spec: write a `Ruling:` line in `notes.md` and follow the evidence.

---

### Task 1: `TurnCursor` extracted and shared with the call graph

**Files:** Create `src/features/callgraph/turns.ts`, `src/features/callgraph/turns.check.ts`; Modify `src/features/callgraph/model.ts:51-98` (`sessionSpans` uses the cursor); Test `src/features/callgraph/model.check.ts` (unchanged expectations stay green).

**Interfaces — Produces:**
```ts
export type Step = "open" | "close" | "none";
export interface TurnCursor { open: boolean; n: number; closedBy: string; prompt: boolean; late: boolean }
// n = turns opened so far (1-based index of the current one); closedBy = "" | "marker" | "next" | "quiet" | "aborted";
// prompt = the open turn still waits for its prompt (codex "turn started" first); late = next event after a quiet close opens a continuation turn
export function newCursor(): TurnCursor;
export function feed(c: TurnCursor, e: Ev, top: boolean): Step; // top = event of the root session (subagent prompts never open a turn)
export function closeQuiet(c: TurnCursor): void; // completeness rule closed the open turn from outside (spec 2.3)
export function abortedBy(e: Ev): boolean; // meta "turn aborted"
```
Rules (spec 2.2): `user` + top → `"open"` (if a turn opened by `turn started` still waits for its prompt: `"none"`, prompt filled, `c.prompt = false`); meta `turn started` + top → `"open"` with `c.prompt = true`; meta starting `turn complete` or equal to `turn aborted` with an open turn → `"close"` (`closedBy` `marker`/`aborted`); a `tool`/`assistant`/`result` with no open turn → `"open"` (the "(no prompt logged)" turn of `model.ts:77-80`, and the continuation turn after `closeQuiet`).

- [ ] **Step 1: Failing check `turns.check.ts`** (same `eq` helper style as `model.check.ts`): per harness row of spec 2.2 one event list → expected step string, e.g. codex `[meta turn started, user hi, tool, result, meta turn complete, meta turn started, meta turn aborted]` → `open none none none close open close` and `closedBy` `aborted`; claude `[user a, tool, result, user b]` → `open none none open`; fx `[user, tool, result, meta "turn complete · 40.0s"]` → `open none none close`; a subagent `user` with `top=false` → `none`; **continuation**: `[user a, tool]`, `closeQuiet(c)`, then `[result]` → `open` with `c.n === 2`.
- [ ] **Step 2: Run** `scriptc build src/features/callgraph/turns.check.ts -o /tmp/x && /tmp/x`. Expected: BUILD FAIL (module missing).
- [ ] **Step 3: Implement `turns.ts`**, then rewrite the branch head of `sessionSpans` so the four turn branches call `feed(cur, e, parent < 0)` and act on the step (the span bookkeeping stays in `model.ts`). Codex `turn aborted` now closes a turn in the call graph too (today only `turn complete` does) — intended, per spec 2.2.
- [ ] **Step 4: Run** the turns check and `model.check.ts`. Expected: both `all checks passed`. Add to `model.check.ts` one codex case: `turn aborted` ends the turn span at its timestamp.
- [ ] **Step 5: Run** `./build.sh && sh scripts/check.sh`. Expected: all ok.
- [ ] **Step 6: Commit** `refactor(callgraph): extract turn segmentation into a shared TurnCursor`.

---

### Task 2: Pure-TS SHA-256 and the deterministic id scheme

**Files:** Create `src/util/sha256.ts`, `src/util/sha256.check.ts`, `src/features/otlp/ids.ts`, `src/features/otlp/ids.check.ts`.

**Interfaces — Produces:**
```ts
// sha256.ts — FIPS 180-4; K and H0 as literal tables
export function sha256Bytes(b: Uint8Array): number[]; // 8 words
export function sha256Hex(s: string): string;          // UTF-8 via TextEncoder, 64 lowercase hex chars
// ids.ts — spec 4.1
export const PREFIX = "agentglass/otlp/v1|";
export function H(x: string): string;                  // sha256Hex(PREFIX + x)
export function rootKey(h: string, rootId: string): string;           // h + "|" + rootId
export function turnKeys(firstTs: string[]): string[];                // ts + "#" + k (k = ordinal among equal ts); "" ts → "i" + (index+1)
export function traceId(R: string, T: string): string;                // H("s|"+R)[0:16] + H("t|"+R+"|"+T)[0:16]
export function rootSpanId(R: string, T: string): string;             // H("r|"+R+"|"+T)[0:16]
export function chatSpanId(R: string, reqSess: string, Q: string): string; // H("c|"+R+"|"+reqSess+"|"+Q)[0:16]
export function toolSpanId(R: string, callerSess: string, callId: string): string; // H("x|"+…)[0:16]; callId "" → caller passes "anon:" + T + ":" + ordinal
export function agentSpanId(R: string, subSess: string, T: string): string; // H("a|"+…)[0:16]
export function nonZero(hex: string): string;          // all "0" → last char "1"
```

- [ ] **Step 1: Failing `sha256.check.ts`:** NIST vectors `""` → `e3b0c442…b855`, `"abc"` → `ba7816bf…15ad`, the 448-bit `"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"` → `248d6a61…06c1`, one million `"a"` → `cdc76e5c…c7c0` (full 64-char values in the check); a UTF-8 string `"ü€😀"` equals `printf 'ü€😀' | sha256sum`; **1,000 random files** (lengths 0..300, bytes from a seeded xorshift, written to `/tmp/agentglass-sha-check/`) each equal `OS.sha256File(path)` (bytes hashed via `sha256Bytes(readBytes(…))`); **bench**: 10,000 `H("c|claude|abc|msg_…")` calls, print µs/id, FAIL if > 20 µs in the native build.
- [ ] **Step 2: Run** `scriptc build src/util/sha256.check.ts -o /tmp/x && /tmp/x`. Expected: BUILD FAIL.
- [ ] **Step 3: Implement** `sha256.ts` (~80 lines: padding, 64-word schedule, compression with `>>> 0`; hex via `"0123456789abcdef"[…]`).
- [ ] **Step 4: Run.** Expected: `sha256: all checks passed` and a µs/id line ≤ 20.
- [ ] **Step 5: Failing `ids.check.ts`:** same input twice → same ids; `turnKeys(["t1","t1","t2",""])` → `["t1#0","t1#1","t2#0","i4"]`; trace id first 16 chars depend only on `R` (two turns share them); all ids 16/32 lowercase hex; `nonZero("0000000000000000")` → `"0000000000000001"`; a frozen golden: `rootSpanId("claude|s1","2026-01-01T00:00:00.000Z#0")` equals the value computed once with `printf 'agentglass/otlp/v1|r|claude|s1|2026-01-01T00:00:00.000Z#0' | sha256sum | cut -c1-16` (literal in the check — it pins the contract).
- [ ] **Step 6: Implement `ids.ts`; run** both checks + `sh scripts/check.sh`. Expected: all ok.
- [ ] **Step 7: Commit** `feat(otlp): pure-TS SHA-256 and deterministic trace/span ids`.

---

### Task 3: Usage port additions — reasoning tokens, booking tap, call tap, sidecar readers

**Files:** Modify `src/features/usage/record.ts` (`Acc.rs`, `reasoning()`, `bookTap`), `src/features/usage/calls.ts:54` (`callTap` in `done()`), `src/features/usage/cache.ts` (persist `rs`, `VERSION` bump), `src/harness/gemini.ts:306`, `src/harness/opencode.ts:333`, `src/harness/codex.ts:133-142` (call `reasoning`), `src/harness/kiro.ts` (export `kiroTurns`), `src/harness/fx.ts` (export `fxTotals`), `record.ts` `retool` reports through `callTap`; Test `src/features/usage/record.check.ts`, `src/features/usage/calls.check.ts`, `src/harness/kiro.check.ts`, `src/harness/gemini.check.ts`.

**Interfaces — Produces:**
```ts
// record.ts
// Acc gains rs: number (reasoning tokens, a subset of outTok)
export function reasoning(a: Acc, d: Day, n: number): void;
export interface Booking { model: string; nIn: number; nOut: number; cr: number; cw: number; cost: number; unk: number; exact: boolean; prov: string /* honest-costs' provider key, "" single-provider */ }
export let bookTap: ((b: Booking) => void) | null; // set by the exporter; tokens()/usageExact() call it once per booking (Claude iterations: once per iteration)
export function setBookTap(f: ((b: Booking) => void) | null): void;
// calls.ts
export let callTap: ((id: string, ms: number, err: boolean, codes: number[], name: string) => void) | null; // name = the row's tool name (retool's new name)
export function setCallTap(f: ((id: string, ms: number, err: boolean, codes: number[], name: string) => void) | null): void;
// kiro.ts
export interface KTurn { end: number; nIn: number; nOut: number; credits: number; usd: number; unk: number }
export function kiroTurns(s: Sess): KTurn[]; // user_turn_metadatas in order, priced like usageSidecar (credit rate)
// fx.ts
export interface FxTot { nIn: number; nOut: number; cr: number; cw: number; usd: number; unk: number }
export function fxTotals(s: Sess): FxTot | null; // current usage-v2.json snapshot
```
Callers of the taps read them through a local (`const f = bookTap; if (f) f(b);`) — scriptc optional-call rule.

- [ ] **Step 1: Failing checks:** `record.check.ts`: with `setBookTap(push)`, `tokens(a,d,"claude-sonnet-4-5",10,5,3,2,0)` → one Booking `{model:"claude-sonnet-4-5",nIn:10,nOut:5,cr:3,cw:2,exact:false,prov:""}` with `cost` = the Acc cost delta; `usageExact(…, usd 0.5, "openrouter")` → `exact:true, cost:0.5, prov:"openrouter"`; unpriced model → `cost 0, unk 20`; `reasoning(a,d,7)` → `a.rs === 7` and `a.outTok` unchanged. `calls.check.ts`: `done(p, 1200, true, 10, "c1", [2])` with `setCallTap` → `("c1",1200,true,[2],"Bash")`; `retool` to `mcp__s__t` then `done` → tap name `mcp__s__t`. `gemini.check.ts`: a record with `thoughts: 50` → `a.rs === 50`. Cache round trip: `accIn(accOut(a)).rs === a.rs`. `kiro.check.ts`: fixture sidecar with two turns → `kiroTurns` length 2, ends ascending, tokens per turn.
- [ ] **Step 2: Run** each check. Expected: BUILD FAIL / FAIL (`rs`, `setBookTap`, `kiroTurns` undefined).
- [ ] **Step 3: Implement.** `rs` goes into the `accOut` `t` array at the next free index after honest-costs' `uc` (index 9) — 10 if nothing else was appended by then (`accIn` reads it with `at(t, 10)`; use the index found at implementation time); bump `VERSION` with comment `// N: Acc.rs reasoning tokens (otlp-export)`. Codex: when `info.total_token_usage.reasoning_output_tokens` is present, its delta goes to `reasoning()` (kept in `a.x[4]`; extend the `while (a.x.length < 4)` pad to 5).
- [ ] **Step 4: Run** the checks, then `./build.sh && sh scripts/check.sh` and the seven-harness `--json --subagents --limit 400` comparison against `main`. Expected: all ok, JSON identical (taps are null outside the exporter).
- [ ] **Step 5: Commit** `feat(usage): reasoning tokens, booking and call taps for per-request export`.

---

### Task 4: Request grain, provider names and input-token semantics

**Files:** Create `src/features/otlp/requests.ts`, `src/features/otlp/requests.check.ts`.

**Interfaces — Consumes:** `Booking` (Task 3). **Produces:**
```ts
export interface Req { key: string; model: string; respModel: string; provider: string; providerId: boolean; t: number; err: string }
// key = request key Q of spec 1.2 ("" = this line is no request); providerId = key is a provider message id (→ gen_ai.response.id)
export function requestOf(h: string, o: Obj, line: string, x: ReqState): Req | null;
export interface ReqState { codexLast: number[]; codexTs: string; codexK: number } // codex: last cumulative totals, "#k" ordinal per timestamp
export function newReqState(): ReqState;
export function providerOf(logged: string, model: string): string; // spec 3.3 prefix table; "" = unknown (attribute omitted)
export type InMode = "inclusive" | "provider";
export function inputTokens(h: string, provider: string, b: { nIn: number; cr: number; cw: number }, mode: InMode): number; // spec 3.6 table
```
Per harness (spec 1.2): claude assistant line → `message.id` (`providerId` true; `err` = `"api_error"` when the line has `isApiErrorMessage: true` — confirm the field on a real Claude API-error line in Task 0 step 9, else no chat error for Claude); codex `event_msg/token_count` whose `info.total_token_usage` differs from `x.codexLast` → `timestamp + "#" + k`, else `null`; gemini `type:"gemini"` with `tokens` → its `id`; opencode 2.x assistant row → row `id`, 1.x `step-finish` part → its `messageID` (field names from Task 0 notes); pi `message` entry with `usage` (and `usage`/`compaction`/`branch_summary` entries with usage) → entry `id`, `respModel` = `responseModel`, `provider` = logged `provider`; kiro/fx → `null` (turn grain, built in Task 5).

- [ ] **Step 1: Failing check:** one fixture line per harness → expected `Req` fields; **codex grain**: the sequence `[token_count A, token_count info:null, token_count A again, token_count B, token_count C < B (reset)]` → keys for A, B, C only (3 requests), the reset yields a request (counted fresh); `providerOf("", "o3-mini")` = `openai`, `("", "claude-opus-4-5")` = `anthropic`, `("", "gemini-2.5-pro")` = `gcp.gemini`, `("", "kimi-k2")` = `moonshot_ai`, `("openrouter","x")` = `openrouter`, `("", "llama3")` = `""`; **token semantics table** — for each row of spec 3.6 × mode: anthropic `{nIn:10,cr:100,cw:5}` → inclusive 115, provider 10; codex `{10,100,5}` → 115 / 115; gemini `{10,100,0}` → 110 / 110; kiro `{10,0,0}` → 10 / 10.
- [ ] **Step 2: Run** `scriptc build src/features/otlp/requests.check.ts -o /tmp/x && /tmp/x`. Expected: BUILD FAIL.
- [ ] **Step 3: Implement** (`requestOf` pre-filters by `indexOf` like the adapters' `usage()`).
- [ ] **Step 4: Run** the check + suite. Expected: all ok.
- [ ] **Step 5: Commit** `feat(otlp): request grain per harness, provider names, input-token semantics`.

---

### Task 5: Span builder — root session, turns, `chat` and `execute_tool`

**Files:** Create `src/features/otlp/types.ts`, `src/features/otlp/build.ts`, `src/features/otlp/build.check.ts`.

**Interfaces — Consumes:** `TurnCursor`/`feed`/`closeQuiet` (Task 1), ids (Task 2), `setBookTap`/`setCallTap`/`Booking`/`kiroTurns`/`fxTotals` (Task 3), `requestOf`/`Req`/`ReqState` (Task 4), `sourceOf`, `parseEvents`, `harnessOf`, `window` (`src/harness/index.ts`), `newAcc` (`record.ts`), `catOf`/`toolName`/`toolArg`/`isErr`/`ms` (`model.ts`), `program`/`norm`/`mcpServer` (`calls.ts`). `modeOf(s, prov)` (honest-costs, `bill-live.ts`: each chat span's `bill` from its `Booking.prov`). **Produces:**
```ts
// types.ts
export interface Attr { k: string; t: string; s: string; n: number; b: boolean; a: string[] } // t: "s" string, "i" int, "d" double, "b" bool, "as" string array
export interface XEvent { name: string; t: number; attrs: Attr[] }
export interface XSpan {
  op: string; name: string; spanId: string; parentId: string; kind: number; // op "invoke_agent" | "chat" | "execute_tool"; kind 1 INTERNAL, 3 CLIENT
  t0: number; t1: number; est: boolean; err: string; errMsg: string;       // ms; err = error.type or ""
  sess: string; attrs: Attr[]; events: XEvent[];
  // facts the encoder turns into attributes (Task 6)
  model: string; respModel: string; provider: string; respId: string; models: string[];
  nIn: number; nOut: number; cr: number; cw: number; rs: number; cost: number; unk: number; exact: boolean; hasUsage: boolean;
  bill: string; // chat: honest-costs mode of this request, modeOf(root, Booking.prov) (pi/OpenCode per provider); "" on other spans
  tool: string; callId: string; mcp: string; prog: string; exit: number; skill: string; superseded: boolean;
  input: string; output: string; args: string; result: string; // content, used only with --content
}
export interface XTurn {
  h: string; rootId: string; path: string; key: string; index: number; traceId: string;
  t0: number; t1: number; closed: boolean; closedBy: string; compacted: boolean; ver: string; cwd: string; branch: string;
  spans: XSpan[]; // spans[0] = root invoke_agent
}
// build.ts
export interface BuildOpts { now: number; quietMs: number; content: boolean; subagents: boolean }
export interface SessB { root: Sess; subs: Sess[]; at: number; ep: string; cur: TurnCursor; acc: Acc; rq: ReqState; open: XTurn | null; done: XTurn[]; lastT: number } // incremental state (Task 13 keeps one per session)
export function newSessB(root: Sess, subs: Sess[]): SessB;
export function advance(b: SessB, o: BuildOpts): XTurn[]; // reads root (and subagents, Task 6) from b.at to the end in 1 MB windows; returns turns that closed now
export function finish(b: SessB, o: BuildOpts): XTurn[];  // one-shot: applies the completeness rule (spec 2.3) to the open turn
```
Algorithm per record of the root: `parseEvents` → for each new event `feed(cur, e, true)`; `"open"` starts an `XTurn` (`key` from `turnKeys` over the session's turn first-ts list, root span `invoke_agent {label}`); then the adapter's `usage(acc, line)` runs with `bookTap` collecting `Booking`s and `callTap` collecting tool timings. `requestOf` gives the current request: bookings of that line go to its `chat` span (created on first sight, start = previous event of the same session, end = this line's time); ≥ 2 bookings on one Claude line → one `chat` span per booking keyed `message.id + "/i" + n`, the line's window split evenly, `est`, all but the last `superseded`. Bookings on a line with no request key go to the latest `chat` span of the same session in the open turn, else to a `chat` span keyed `"turn:" + T` (est). `tool` events → `execute_tool` spans (name `execute_tool {tool}` or `execute_tool {tool} {program}` for shell `catOf === 0`), closed by their `result`; duration/err from the call tap when present, else `isErr`. `error.type`: `rejected` for "The user doesn't want to proceed", `cancelled` for `[cancel`, `timeout` for `[timeout`, else `tool_error`; a codex `turn aborted` root gets `cancelled`. Kiro: turn times from `kiroTurns` (end = sidecar end, start = previous end), one `chat` per turn with that turn's totals, children `est` (`spread` layout). fx: one `chat` per turn (start = end − `turn complete · Ns`), no usage; `fxTotals` goes on the root of the last exported turn with `agentglass.usage.session_total`. Completeness (spec 2.3): a turn closes on `next`/`marker`, or when `!busy(s) && !subs.some(subActive) && now − s.mtime ≥ quietMs`, or when the process is gone (`s.pid === 0` and `now − s.mtime ≥ 120000`); a turn closed by "gone" while `busy(s)` was true gets `err = "interrupted"`. Clock skew: a child starting before its parent moves the parent's `t0` (and `t1` for an ending after). A > 1 MB line: its call stays open, ends at the turn end, `err = "unknown"`.

- [ ] **Step 1: Failing `build.check.ts`** (fixtures from `testdata/otlp/fixtures/`, temp `HOME`, fixed `now`): Claude — tree root → `chat`×3 (`msg_a` three streamed lines = one span; `msg_b` with two iterations = two spans, models differ, first `superseded`) + `execute_tool` siblings, `execute_tool Bash git` for a `git status` call, the denied call `err = "rejected"`; **conservation**: per fixture session Σ chat `nIn/nOut/cr/cw/cost` equals a plain ledger pass (`newAcc` + `usage()` over the same lines) — for Claude, Codex, Gemini, pi, OpenCode; no `invoke_agent` span has `hasUsage`; Codex aborted turn → root `err = "cancelled"`; Kiro → 2 turns, `chat` per turn with the sidecar totals, `est`; fx → `chat` without usage, last root `session_total`; **ids stable**: build twice → identical span ids; append a turn → earlier ids unchanged; append a request to the open turn → root and earlier chat ids unchanged; **clock skew**: a tool with `t0` before its root → root `t0` moved; **quiet**: `advance` with `now − mtime = 9 min` → open turn not returned; `finish` with 10 min → returned `closed`; a busy turn with `pid 0` and 3 min quiet → `err = "interrupted"`.
- [ ] **Step 2: Run** `scriptc build src/features/otlp/build.check.ts -o /tmp/x && /tmp/x`. Expected: BUILD FAIL.
- [ ] **Step 3: Implement** `types.ts`, `build.ts` (taps set at the start of each line batch and reset to `null` in `finally`).
- [ ] **Step 4: Run** the check + suite. Expected: all ok.
- [ ] **Step 5: Commit** `feat(otlp): span builder for turns, requests and tool calls`.

---

### Task 6: Subagents in the trace (spawn host, Codex pieces per hosting turn)

**Files:** Modify `src/features/otlp/build.ts`; Test `src/features/otlp/build.check.ts`.

**Interfaces — Consumes:** `SessB`, `XTurn`, `XSpan` (Task 5); `HarnessAdapter.spawnOf` (`src/harness/types.ts:54`); `subActive` (`src/model/sessions.ts:77`). **Produces:** `advance`/`finish` also place subagent spans; `export function hostSpan(t: XTurn, spawn: string, at: number): number` — index in `t.spans`: the `execute_tool` span with `callId === spawn`, else the latest spawn-like tool (`catOf === 4`) started ≤ `at + 1000`, else 0 (the root) — the same rule as `hostOf` (`model.ts:100-107`) on exporter spans.

Each subagent `Sess` is read whole with its own `Acc`, `ReqState` and cursor (`feed(…, top=false)`: its prompt never opens a turn). Its events are split by the host turns' windows `[turn.t0, next turn.t0)`; events before the first host turn go to the first, events in a gap to the preceding one. Per hosting turn with ≥ 1 event: one `invoke_agent {s.kind || "subagent"}` span (`agentSpanId(R, sub.id, T)`, `sess = sub.id`) under `hostSpan(turn, spawnOf(sub), firstEventT)`, the sub's `chat` and `execute_tool` spans as its children (chat span ids use `requestSessionId = sub.id`, tool ids `callerSess = sub.id`). A turn is not closed while one of its subagents is `subActive`.

- [ ] **Step 1: Failing cases:** Claude subagent with `toolUseId` → its `invoke_agent` parent is the `Agent` tool span, its `chat` spans are its children with own usage, and conservation still holds per subagent file; no `toolUseId` and no spawn-like call → parent = root; Codex subagent used in turns 1 and 2 → two `invoke_agent` pieces, distinct stable ids, events split by window (a sub event between turns lands in turn 1's piece), a turn whose window holds no sub event has no piece; `--no-subagents` (`o.subagents = false`) → no subagent spans; a turn with an active subagent (`mtime` 10 s ago) stays open under `advance`.
- [ ] **Step 2: Run.** Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** check + suite. Expected: all ok.
- [ ] **Step 5: Commit** `feat(otlp): subagents under their spawning call, Codex pieces per hosting turn`.

---

### Task 7: Pure-TS deflate + gzip container

**Files:** Create `src/util/gzip.ts`, `src/util/gzip.check.ts`, `scripts/gzip.test.sh`.

**Interfaces — Produces:**
```ts
export function crc32(b: Uint8Array): number;        // 256-entry table, unsigned (>>> 0)
export function deflateRaw(b: Uint8Array): Uint8Array; // RFC 1951: LZ77, 32 KB window, 3-byte hash + chains capped at 32, no lazy matching, fixed Huffman (BTYPE 01), final block flag
export function gzip(b: Uint8Array): Uint8Array;     // RFC 1952: 1f 8b 08 00 | mtime 0 | xfl 0 | os 255, deflate, CRC-32 LE, ISIZE LE
export function writeBin(path: string, b: Uint8Array): boolean; // mode 0600; false if the runtime cannot write bytes unchanged (Task 0 step 7)
export function gzipProbe(dir: string): boolean;     // once per run: gzip a fixed 2 KB probe, writeBin, read back with readBytes, compare
```

- [ ] **Step 1: Failing `gzip.check.ts`:** `crc32("")=0`, `crc32("123456789")=0xcbf43926`, `crc32("The quick brown fox jumps over the lazy dog")=0x414fa339`; header bytes `[0x1f,0x8b,8,0,0,0,0,0,0,255]`; trailer ISIZE = input length; **bench**: 4 MB of repeated OTLP/JSON spans compressed in ≤ 200 ms (≥ 20 MB/s, prints MB/s) and output < 25 % of input. `scripts/gzip.test.sh` builds a tiny driver (`scriptc build`) that gzips stdin to a file, then for inputs empty, 1 byte, 100 KB of `"a"`, 1 MB of `/dev/urandom`, a generated 4 MB OTLP batch, and a 70 KB input whose repeats straddle the 32 KB window edge, asserts `gzip -dc out.gz | cmp - in` succeeds.
- [ ] **Step 2: Run** check and test. Expected: BUILD FAIL / FAIL.
- [ ] **Step 3: Implement** (bit writer LSB-first; fixed literal/length codes 0–143: 8 bits, 144–255: 9, 256–279: 7, 280–287: 8; distance codes 5 bits; length/distance base + extra-bit tables as literals; Huffman codes written bit-reversed).
- [ ] **Step 4: Run.** Expected: all ok; the random input compresses to ≥ input size (the caller then sends it plain, Task 8).
- [ ] **Step 5: Commit** `feat(util): pure-TS deflate and gzip for OTLP request bodies`.

---

### Task 8: `postJson` transport, retries, gzip fallback

**Files:** Modify `src/util/http.ts` (add `postJson`, `getJson` unchanged); Create `src/features/otlp/send.ts`, `src/features/otlp/send.check.ts`, `scripts/otlp-transport.test.sh` (python3 mock server); Test `src/util/http.check.ts` (extended).

**Interfaces — Consumes:** `curlBin`, `cq` (`http.ts`), `gzip`/`writeBin` (Task 7). **Produces:**
```ts
// http.ts
export interface PostRes { status: number; body: string; err: string; exit: number; retryAfter: number } // status 0 = no HTTP response; exit = curl exit code
export function postJson(url: string, headers: string[][], body: Uint8Array, timeoutS: number, gz: boolean): PostRes;
// config on stdin: url, one `header = "K: V"` per header (+ Content-Type: application/json, + Content-Encoding: gzip when gz),
// request = "POST", data-binary = "@<body file>", write-out = "\n%{http_code}", -D <hdr file> (Retry-After), max-time;
// `-q` first; no --fail; loopback hosts get noproxy = "localhost,127.0.0.1,::1"; body file ~/.agentglass/tmp/otlp-<pid>-<n>.bin 0600, deleted in finally; response capped at 64 KB
// send.ts
export interface SendCfg { url: string; headers: string[][]; timeoutS: number; gzip: boolean; live: boolean }
export interface SendOut { ok: boolean; status: number; rejected: number; msg: string; gzipRefused: boolean; retries: number }
export function sendBatch(c: SendCfg, json: string, sleep: (ms: number) => void): SendOut;
```
Retry policy (spec 6.2): curl exit 6, 7, 28, 35, 52, 56 and HTTP 429/502/503/504 retried; one-shot backoff 1 s, 2 s, 4 s (3 attempts), live up to 5 min; `Retry-After` honored up to 60 s; other 4xx fail without retry; 200 with `partialSuccess.rejectedSpans > 0` → `ok: true`, `rejected` set. gzip only for bodies ≥ 1 KB whose gzip is smaller; a compression taking > 1 s switches the run to plain (module flag, one notice); a gzip request answered 415 or 400 is resent once plain — success → `gzipRefused: true`.

- [ ] **Step 1: Failing checks** with fake curls (pattern of `http.check.ts`: shell scripts recording argv, stdin and the body file, printing a canned response): `postJson` → **argv clean**: argv = `-q -sS -K -` only, no header value, no URL; stdin holds the escaped header lines and `request = "POST"`; the body file exists during the call (fake curl copies it) and is gone afterwards, mode 0600; status parsed from the last line; a `Retry-After: 3` header → `retryAfter 3`; loopback URL → `noproxy` line, remote URL → none. `sendBatch` with an injected `sleep` recorder: 503 then 200 → `ok`, sleeps `[1000]`; 400 → fail, no sleep; 429 + `Retry-After: 120` → sleep 60000; partial success body `{"partialSuccess":{"rejectedSpans":2}}` → `ok`, `rejected 2`; gzip 415 then plain 200 → `ok`, `gzipRefused`; gzip 400 then plain 400 → fail, `gzipRefused false`; body < 1 KB → sent plain.
- [ ] **Step 2: Run** `http.check.ts`, `send.check.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Shell test `scripts/otlp-transport.test.sh`:** starts `python3 -c` an `http.server` on a free port that records request headers and the (gunzipped when `Content-Encoding: gzip`) body, answers per a script file; a small driver binary posts a 50 KB gzip body with header `Authorization: Bearer t0k3n` read from a config in a temp `HOME`; asserts the header arrived, the body decodes to the input, and (Linux only) a `/proc/<curl pid>/cmdline` snapshot taken by a background loop during a slow (2 s) response never contains `t0k3n`.
- [ ] **Step 5: Run** checks + test + suite. Expected: all ok.
- [ ] **Step 6: Commit** `feat(otlp): POST transport through curl with retries and gzip fallback`.

---

### Task 9: OTLP configuration, export state file and lock

**Files:** Create `src/features/otlp/config.ts`, `src/features/otlp/state.ts`, `src/features/otlp/state.check.ts`, `src/features/otlp/config.check.ts`.

**Interfaces — Consumes:** `section` (`src/util/config.ts:13`), `H` (Task 2). **Produces:**
```ts
// config.ts — spec 7
export interface OtlpCfg { endpoint: string; headers: string[][]; content: boolean; contentMax: number; inputTokens: string; hostName: boolean;
  extra: Attr[]; rename: Map<string, string>; drop: Set<string>; batch: number; timeoutS: number; insecure: boolean; compression: string; native: string; warns: string[] }
export function loadCfg(env: Map<string, string>): OtlpCfg;   // malformed section → defaults + one warn; wrong-typed key ignored
export function endpointOf(flag: string, c: OtlpCfg, env: Map<string, string>): string; // --otlp > otlp.endpoint > OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (as is) > OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces); "" = none
export function withPath(url: string): string;               // empty or "/" path → "/v1/traces"
export function expandHeaders(c: OtlpCfg, env: Map<string, string>): { headers: string[][]; err: string }; // ${env:NAME}; headersFile owner + 0600 check; OTEL_EXPORTER_OTLP_(TRACES_)HEADERS k=v,… URL-decoded when no config headers
export function plainOk(url: string, c: OtlpCfg, hasHeaders: boolean): string; // "" ok, else "headers over plain http to <host> need otlp.insecure"
export function safeUrl(url: string): string;                // userinfo and query removed — the only form ever printed or stored
// state.ts — spec 4.3/4.4
export interface ExpState { v: number; endpoint: string; gzip: boolean; gzipNote: string; nativeSince: Map<string, number>; last: number;
  sessions: Map<string, { h: string; id: string; ep: string; turns: Set<string> }> }
export function statePath(url: string): string;             // ~/.agentglass/otlp/state-<H(safeUrl(url))[0:16]>.json
export function loadState(url: string): ExpState;
export function saveState(url: string, st: ExpState): void;  // tmp + rename, mode 0600, dir 0700
export function lock(url: string): number;                   // 0 = taken; else the live pid holding it (exit 3); stale lock taken over
export function unlock(url: string): void;
```

- [ ] **Step 1: Failing checks:** `withPath("http://h:4318")` → `http://h:4318/v1/traces`, `("http://h/custom")` unchanged; precedence of `endpointOf` with env maps; `${env:OTEL_TOKEN}` expanded, unset → `err`; headersFile mode 0644 → refused with message, 0600 → read; `OTEL_EXPORTER_OTLP_HEADERS="a=b%20c,x=y"` → `[["a","b c"],["x","y"]]` only when config has no headers; `plainOk("http://10.0.0.5:4318/…", insecure false, headers)` → error naming `10.0.0.5`, loopback → `""`; malformed `otlp` (a string) → defaults + 1 warn; **endpoint key**: `statePath("https://u:tok@h/v1/traces?key=x") === statePath("https://h/v1/traces")`, and after `saveState` the file text contains neither `tok` nor `key=x`; atomic write leaves no `.tmp`; mode 0600; round trip keeps `turns`, `gzip`, `nativeSince`; a changed session `ep` (cursor epoch) or a shrunk file keeps its marks (ids do not depend on offsets); **lock**: `lock()` → 0, second `lock()` in a child process (`execFileSync` of the same check binary with an env flag) → this pid; a lock file holding a dead pid → taken over.
- [ ] **Step 2: Run** both checks. Expected: BUILD FAIL.
- [ ] **Step 3: Implement** (lock via `openSync(path, "wx")`, pid alive via `process.kill(pid, 0)` like `opencode.ts:179`).
- [ ] **Step 4: Run** checks + suite. Expected: all ok.
- [ ] **Step 5: Commit** `feat(otlp): config section, resumable export state and endpoint lock`.

---

### Task 10: Attributes and OTLP/JSON encoding

**Files:** Create `src/features/otlp/encode.ts`, `src/features/otlp/encode.check.ts`.

**Interfaces — Consumes:** `XTurn`/`XSpan`/`Attr` (Task 5), `OtlpCfg` (Task 9), `inputTokens`/`InMode` (Task 4), `scrubText`/`REDACT` (`src/features/redact.ts`), `projectOf` (filter-language), `scrubRemote`/`Remote` (`src/util/giturl.ts`), `XSpan.bill` (built from honest-costs' `modeOf(s, prov)`), `BUILD` (`src/build-info.ts`). **Produces:**
```ts
export function spanAttrs(t: XTurn, sp: XSpan, c: OtlpCfg): Attr[]; // spec 3.3/3.4 table, in table order
export function vcsAttrs(cwd: string, branch: string): Attr[];       // [] under --redact; remote origin url read from <gitdir>/config (no git process) → scrubRemote; dropped if null
export function encodeRequest(turns: XTurn[], c: OtlpCfg): string;   // one ExportTraceServiceRequest JSON; one ResourceSpans per (harness, version)
export function serviceName(h: string): string;                      // claude-code, codex, gemini-cli, pi, opencode, kiro-cli, fx
export function agentName(h: string): string;                        // Claude Code, Codex, Gemini CLI, pi, OpenCode, Kiro, fx
export function nativeKey(h: string): string;                        // session.id / conversation.id / … (Task 0 step 6)
```
Rules: `startTimeUnixNano = String(Math.floor(t0)) + "000000"`; `intValue` as string; doubles as numbers; arrays as `arrayValue`; status `{code: 2}` + `message` only with content; kind 1/3; resource `service.name`, `service.version` (when known), `os.type` (`linux`/`darwin`), `host.name` only with `hostName`, `agentglass.usage.input_tokens.semantics`, `agentglass.source = "transcript"`; scope `{name: "agentglass", version: BUILD.version}`. Root also carries `nativeKey(h)` = root session id, `agentglass.turn.index`, `agentglass.models` (array), `gen_ai.request.model` (last request's model, omitted when unknown), `gen_ai.conversation.compacted` when true, `gen_ai.skill.name` when the prompt is a slash skill. `chat`: usage attributes (input per `inputTokens`), `cache_*` omitted when 0 for Kiro, `reasoning` only > 0, `agentglass.usage.cost` omitted when `unk > 0 && cost === 0`; `agentglass.billing.mode` (`api|plan|metered|gateway|unknown`) = `sp.bill` (set when the chat span is built: `modeOf(root, booking.prov)`, pi/OpenCode per that request's provider), always present on `chat` spans, also when the cost is unknown. `execute_tool`: `gen_ai.tool.name` (MCP: tool part), `gen_ai.tool.type` (`function`/`extension`), `mcp.method.name`, `agentglass.mcp.server.name`, `process.executable.name`, `process.exit.code`, `gen_ai.tool.call.id`, `gen_ai.skill.name` for `Skill`. Content (only `c.content`): semconv message JSON `[{"role":…,"parts":[{"type":"text","content":…}]}]`, every value truncated to `contentMax` bytes. Under `REDACT` every string attribute passes `scrubText` and `vcs.*` are absent. `extra` added to every span; `rename`/`drop` applied last to span and resource attributes.

- [ ] **Step 1: Failing check** on hand-built `XTurn`s: nanos `1767225600123` → `"1767225600123000000"`; int as string; the root has no `gen_ai.usage.*` key; `inclusive` vs `provider` input values per provider; unpriced chat has no cost key but has `agentglass.billing.mode`; `agentglass.billing.mode` sits on every `chat` span and on no other span kind; a pi session with two providers → each chat span carries its own provider's mode; content off → none of the four content keys nor status `message` anywhere in the JSON; content on → messages JSON shape and truncation to `contentMax`; **privacy**: with `REDACT` (the check runs with `AGENTGLASS_REDACT=1`) and a learned name in the scrub dictionary fixture, `--content` output does not contain that name and has no `vcs.` key; `drop: ["process.working_directory"]` removes it from spans; `rename` renames `agentglass.usage.cost`; two harnesses in one request → two `ResourceSpans`; vcs from a temp repo whose `.git/config` holds `url = https://user:ghp_x@github.com/o/r.git` → `vcs.repository.url.full` without userinfo, or absent if `scrubRemote` drops it.
- [ ] **Step 2: Run.** Expected: BUILD FAIL.
- [ ] **Step 3: Implement** (pin the semconv-genai revision in the file header comment).
- [ ] **Step 4: Run** check + suite. Expected: all ok.
- [ ] **Step 5: Commit** `feat(otlp): GenAI semconv attributes and OTLP/JSON encoding`.

---

### Task 11: Native-telemetry detection and policy

**Files:** Create `src/features/otlp/native.ts`, `src/features/otlp/native.check.ts`.

**Interfaces — Consumes:** honest-costs' environment reader (names + allowlisted boolean switches; extend its allowlist with `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`; `OTEL_EXPORTER_OTLP_ENDPOINT` is a **name-presence** check, its value never read), `ExpState.nativeSince` (Task 9). **Produces:**
```ts
export interface Native { h: string; on: string; src: string } // on: "on" | "off" | "unknown"; src: "config <path>" | "env of pid <n>" | ""
export function detectNative(pids: Map<string, number[]>, home: string): Native[]; // claude, codex, gemini, opencode; others "off"
export interface NativeDecision { skipFrom: Map<string, number>; notes: string[] } // harness → turns starting at/after this ms are skipped
export function applyPolicy(n: Native[], pol: string, st: ExpState, now: number): NativeDecision; // warn | skip | include; sets/clears st.nativeSince
export let accessed: string[]; // keys the config readers touched (test hook)
```
Sources in order (spec 3b.1): live agent processes' env (names/switches), then `~/.claude/settings.json` `env` block, `~/.codex/config.toml` `[otel]` `exporter`/`trace_exporter` ∈ {`otlp-http`, `otlp-grpc`}, `~/.gemini/settings.json` and `<cwd>/.gemini/settings.json` `telemetry.enabled`. A parse failure → `unknown`, never `on`. `warn` → one note per harness and run in the spec's wording; `skip` → `nativeSince` set on first sight of `on`, turns starting before it exported; native off again → `nativeSince` cleared, one notice; `include` → nothing.

- [ ] **Step 1: Failing check** with fixture homes: codex `[otel]\ntrace_exporter = "otlp-http"` → `on`, `config …/config.toml`; claude `env.CLAUDE_CODE_ENABLE_TELEMETRY = "1"` → `on`; gemini `telemetry.enabled: true` → `on`; malformed TOML/JSON → `unknown`; `warn` prints the codex message exactly once over two calls in one run; `skip` sets `nativeSince` and `skipFrom`; off again clears it with a notice; `accessed` never contains an endpoint/header/token key (`OTEL_EXPORTER_OTLP_ENDPOINT` value, `exporter.endpoint`, `headers`, `otlp.endpoint`).
- [ ] **Step 2: Run.** Expected: BUILD FAIL.
- [ ] **Step 3: Implement** (minimal TOML scan: section headers and `key = "value"` lines only).
- [ ] **Step 4: Run** check + suite. Expected: all ok.
- [ ] **Step 5: Commit** `feat(otlp): detect the harnesses' own OTLP export and apply the native policy`.

---

### Task 12: `agentglass export` CLI

**Files:** Create `src/features/otlp/export.ts`, `src/features/otlp/export.check.ts`, `scripts/otlp-export.test.sh`; Modify `src/main.ts` (`import "./features/otlp/export.ts";` after `update.ts`), `src/features/cli.ts` (`usage()` gains the `export` command lines).

**Interfaces — Consumes:** Tasks 5, 6, 8–11; filter-language `parse`, `compile(cs, "json")`, `sessMatches(f, s)` (session clauses only: a compiled filter with `f.day.length`, `f.call.length`, `f.dayKeys` or `f.content.length` is rejected); `discover`/`scan`, `sessions` (`src/model/sessions.ts`). **Produces:**
```ts
export interface ExOpts { url: string; since: number; until: number; harness: string; ids: string[]; filter: string; subagents: boolean;
  native: string; status: boolean; content: boolean; resend: boolean; dry: boolean; batch: number; compression: string; json: boolean }
export function parseExport(args: string[], c: OtlpCfg, now: number): { o: ExOpts; err: string }; // err → exit 2
export function batches(turns: XTurn[], max: number, maxBytes: number, c: OtlpCfg): { turns: XTurn[]; json: string }[]; // whole turns per batch
export function dryRun(paths: string[], o: ExOpts, c: OtlpCfg, now: number): string[]; // the --dry-run lines (used by the golden check)
export function runExport(o: ExOpts, c: OtlpCfg): number; // exit code 0/1/2/3
```
`H.cli.unshift` handler on `args[0] === "export"`. `--since/--until` accept `30m|24h|7d|YYYY-MM-DD|all` (default `7d`); selection = root sessions by `--harness`/`--session`/`--filter` (call/day clauses → exit 2 "export --filter takes session clauses only: <clause>"); turns whose start is in range, not marked (unless `--resend`), not skipped by `NativeDecision`. One-shot quiet = 10 min. Batches: whole turns, ≤ `--batch` spans (default 512) and ≤ 4 MB; a turn alone above either limit is one batch, split by span only if its body exceeds 4 MB; marked after all its requests succeeded. After each successful batch, the state is saved (an interrupted run keeps the progress). `gzipRefused` → state `gzip: false`, later runs plain (one notice; `--compression gzip` retries). gzip probe once per run (Task 7); unusable → plain, noted once and in `--status`. Summary on stderr `exported N spans in T turns from S sessions (R requests)` or JSON on stdout with `--json`; `nothing to export` + exit 0 for an empty selection; no curl → exit 2 "export needs curl (AGENTGLASS_CURL)"; unreadable/sqlite-busy source → warning, session skipped. `--status`: per harness `nativeOn`, source, `nativeSince`, policy, last export time, gzip state; no network. `--dry-run`: one OTLP/JSON request per line on stdout, no network, no state change, no lock.

- [ ] **Step 1: Failing `export.check.ts`:** `parseExport` cases (`--since 30m`, `2026-09-01`, `all`, bad value → err; `--filter 'tool is Bash'` → err naming the clause; no endpoint anywhere → err; `--batch 0` → err); **oversized turn**: `batches` with a 700-span turn and two 10-span turns at max 512 → three batches, the big turn alone; a 5 MB turn → split into two requests both belonging to one turn; a run where request 2 of that turn fails (fake curl) → turn not marked, exit 1; **resume**: fake curl failing the second of three batches → exit 1, first batch's turns marked; rerun with a succeeding curl → only the remaining turns sent (fake curl counts span ids, no id seen twice); `--resend` → all sent again with identical ids; lock held by a live pid → exit 3 with "another export to <safeUrl> is running, pid N"; 415 on gzip → state `gzip:false`, next run sends without `Content-Encoding`.
- [ ] **Step 2: Run.** Expected: BUILD FAIL.
- [ ] **Step 3: Implement**, register the handler, add help lines: `export --otlp <url> [--since 7d] [--until …] [--harness id] [--session id]… [--filter expr] [--no-subagents] [--content] [--resend] [--dry-run] [--batch n] [--compression gzip|none] [--native warn|skip|include] [--status] [--json]`.
- [ ] **Step 4: Shell test `scripts/otlp-export.test.sh`:** `./agentglass export --dry-run --since all` with `HOME` = the Claude fixture home prints the same lines as `testdata/otlp/golden-claude.json` (Task 14 golden; until it exists the test compares a second run with the first — identical); `./agentglass export` without endpoint → exit 2; `AGENTGLASS_CURL=/nonexistent` → exit 2 with the curl message.
- [ ] **Step 5: Run** checks + test + suite. Expected: all ok.
- [ ] **Step 6: Commit** `feat(otlp): agentglass export — history and backfill to any OTLP/HTTP backend`.

---

### Task 13: `--watch --otlp` live sink

**Files:** Modify `src/features/cli.ts:133-194` (`watch(o, sink)`; `Opts.jsonl`), `src/features/watchdog.ts` (export `approvalOf`); Create `src/features/otlp/live.ts`, `src/features/otlp/live.check.ts`; Modify `src/features/otlp/export.ts` (handler for `--watch` + `--otlp` before cli.ts's).

**Interfaces — Consumes:** `SessB`/`advance` (Tasks 5–6), `sendBatch` (Task 8), state/lock (Task 9), `encodeRequest` (Task 10), `detectNative`/`applyPolicy` (Task 11), `approvalNote`/`observe` (`watchdog.ts:74-83`, `:115-119`). **Produces:**
```ts
// cli.ts
export interface Sink { tick: (now: number) => void; stop: () => void }
export function watch(o: Opts, sink: Sink | null): void; // JSONL lines only when sink is null or o.jsonl
// watchdog.ts
export function approvalOf(s: Sess): string; // observe + approvalNote for one session (CLI watch: hist is fed by refreshProcs)
// live.ts
export interface Live { b: Map<string, SessB>; q: XTurn[]; qSpans: number; lastFlush: number; dropped: boolean; appr: Map<string, { call: string; t0: number }> }
export function newLive(since: number): Live;
export function liveTick(L: Live, now: number, send: (turns: XTurn[]) => boolean): void; // advance all sessions (quiet 2 min), enqueue closed turns, flush every 5 s or at 512 spans
export function enqueue(L: Live, t: XTurn): void; // > 10,000 spans → drop the oldest whole turns (unmarked), warn once
export function liveStop(L: Live, send: (turns: XTurn[]) => boolean, budgetMs: number): void; // one flush within 5 s
```
On start: catch-up of closed, unmarked turns since `--since` (default: the watch start — history is never sent implicitly). Native detection every 60 s. A status line on stderr every 60 s (`otlp: N spans sent, Q queued, last ok <time>`). Approval wait: when `approvalOf(s)` turns non-empty, remember the open call (id + start); when it clears, the call's span gets `agentglass.tool.approval_wait` (seconds, double) and an event `agentglass.approval_wait` with `agentglass.estimated = true` (exact, without `estimated`, if Task 0 step 4 found a Claude status). Live retries: backoff up to 5 min, unlimited while the queue fits. SIGINT/SIGTERM: `liveStop` (5 s), save state, unlock, exit.

- [ ] **Step 1: Failing `live.check.ts`** (fake time, fake `send`, fixture session files appended between ticks): turn closes when the next prompt is appended → enqueued once; queue flushes at 5 s; **late events**: after a quiet close (2 min) a result line is appended → a continuation turn with its own key, the exported turn is not re-enqueued; overflow: 10,001 spans → oldest whole turn dropped, one warning, its turn not marked; an interrupted run (stop after one flush) + restart → no turn sent twice (state); approval: `approvalOf` stub non-empty for two ticks then empty → the call span carries `agentglass.tool.approval_wait` ≈ elapsed seconds and the event; `send` failing → turns stay queued, retried.
- [ ] **Step 2: Run.** Expected: BUILD FAIL.
- [ ] **Step 3: Implement** (`watch` calls `sink.tick(Date.now())` after `poll()`; the signal handler calls `sink.stop()` before `process.exit(0)`).
- [ ] **Step 4: Run** check + suite; `./agentglass --watch --jsonl` unchanged without `--otlp` (diff of 10 s output against `main` on a quiet machine: identical shape).
- [ ] **Step 5: Commit** `feat(otlp): live export from --watch with a bounded queue and approval waits`.

---

### Task 14: Golden spans for every harness

**Files:** Create `src/features/otlp/otlp.check.ts`, `testdata/otlp/golden-<harness>.json` (claude, codex, gemini, opencode, pi, kiro, fx).

**Interfaces — Consumes:** `dryRun` (Task 12), fixtures (Task 0 step 9).

- [ ] **Step 1: Write the check:** per harness, temp `HOME` with the fixture tree, fixed `now`, `dryRun(…, {since: all, content: false})` → compared byte-for-byte with the golden file; `AGENTGLASS_GOLDEN=update` writes the file instead. Structural asserts on the parsed output independent of the golden: every trace has exactly one span without `parentSpanId` named `invoke_agent …`; every `chat` and `execute_tool` span's parent is a root or a subagent `invoke_agent`; no `invoke_agent` span carries a `gen_ai.usage.*`, `agentglass.usage.cost` or `agentglass.billing.mode` key; every `chat` span carries `agentglass.billing.mode` (fixtures: Claude `plan` via a fixture `~/.claude.json`, Codex `api`, Kiro `plan`, fx `unknown`); Σ chat usage per trace = the turn total from a ledger pass. Spec cases: Claude subagent + MCP (`gen_ai.tool.type = extension`, `mcp.method.name = tools/call`) + three streamed lines = one chat + two-iteration fallback = two chats, first `agentglass.chat.superseded`; Codex `turn aborted` root `cancelled`, one chat per changed `token_count`, the reused subagent as two pieces with distinct ids; Gemini rewind + model switch → root `agentglass.models` = both, `gen_ai.request.model` = last; OpenCode one chat per assistant message; pi `gen_ai.response.model` ≠ request model; Kiro and fx one chat per turn with `agentglass.timing.estimated`.
- [ ] **Step 2: Run** without goldens. Expected: FAIL "golden missing".
- [ ] **Step 3: Generate** with `AGENTGLASS_GOLDEN=update`, then **read every golden by hand** against the spec tables (span tree, names, kinds, attribute keys, nanos strings) and fix the code, not the golden, where they disagree.
- [ ] **Step 4: Run twice** without the env. Expected: PASS both times (stable output); `sh scripts/check.sh` ok (`otlp-export.test.sh` now compares against `golden-claude.json`).
- [ ] **Step 5: Commit** `test(otlp): golden span output for all seven harnesses`.

---

### Task 15: Real-life verification against local OTLP sinks, docs, final review

**Files:** Modify `README.md` ("Send to an OTLP backend": Jaeger and Collector examples, config section, content/privacy, request start times reconstructed, input-token semantics, dedupe matrix from Task 0 step 3, `--resend` "may duplicate" where not shown otherwise, native-telemetry coexistence, fx/Kiro/native-key "unverified/uncertain" notes as Task 0 found them), `src/ui/help.ts` if it lists CLI commands; `CHANGELOG` entry for the id scheme `v1` if the repo keeps one.

- [ ] **Step 1: Jaeger.** `docker run -d --rm --name agtest-jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest`; `./agentglass export --otlp http://localhost:4318 --since 2d` over the user's real sessions (read-only). Expected: exit 0, summary line. Check in the UI (`http://localhost:16686`) and via `curl -s 'http://localhost:16686/api/services'`: services `claude-code`, `codex`, … for the harnesses present; one trace per turn; tree root → chat/tool siblings → subagent under its `Agent` call; an errored tool shows status ERROR; span counts per service noted.
- [ ] **Step 2: Re-run** the same command. Expected: `nothing to export` (state), Jaeger span count unchanged. `--resend`: count behavior matches the Task 0 matrix.
- [ ] **Step 3: Collector.** `otel/opentelemetry-collector-contrib:latest` with an `otlp` HTTP receiver on 4318 and `debug` (verbosity detailed) + `file` exporters; `./agentglass export --otlp http://localhost:4318 --since 1d --resend --compression gzip`. Expected: the debug log shows `invoke_agent`/`chat`/`execute_tool` spans with `gen_ai.*` attributes, no content keys; the file exporter's span count equals the summary's span count; collector log shows gzip-encoded requests accepted.
- [ ] **Step 4: Live.** `./agentglass --watch --otlp http://localhost:4318` while running one short real Claude turn in `/tmp/agtest-otlp` (with one tool approval wait); after the turn plus 2 min, the trace appears once in Jaeger with `agentglass.tool.approval_wait` on the waited call; Ctrl+C flushes and exits 0; a restart sends nothing twice.
- [ ] **Step 5: Privacy run.** `./agentglass export --redact --content --dry-run --since 1d | grep -c "<a real project name>"`. Expected: 0; without `--content`: `grep -c "gen_ai.input.messages\|tool.call.arguments"` = 0.
- [ ] **Step 6: Docs**, `--help` text for both commands; `./build.sh && sh scripts/check.sh` all ok; stop containers, `rm -rf /tmp/agtest-otlp`.
- [ ] **Step 7: Commit** `docs: send sessions to an OTLP backend`.
- [ ] **Step 8: Final whole-branch review** (most capable model) against spec.md and this plan's Review Focus, one fix pass, push, PR to `main`, CI green on ubuntu and macOS, rebase-merge, remove worktree and branch.
