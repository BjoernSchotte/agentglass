# otlp-export — implementation notes (probe evidence, rulings)

Probes run 2026-10-03 on the implementer's machine. No real session data is copied here; only shapes and counts.

## Prerequisites (Task 0 step 2)
All on `main` (27e1d52): `classifyUser(o, text)` (`src/harness/claude.ts`), `scrubRemote(raw)` (`src/util/giturl.ts`),
`projectOf(cwd)` (`src/features/query/project.ts`), `modeOf(s, prov)` (`src/features/usage/bill-live.ts`),
`parse`/`compile`/`sessMatches` (`src/features/query/`). Ledger `VERSION` = 8 in `src/features/usage/codec.ts`.
filter-language deviations (PR #17): `Compiled.dayKeys` is `string[] | null`; `rowx` exists and counts as a call clause.

Slash-command skill: parsing-fixes emits no event for it. Claude's `parse` turns `<command-name>/x</command-name>` with
args into a `user` event `"/x args"` (without args: a `meta` event); the ledger books the skill from the following
`isMeta` "Base directory for this skill:" line (`userLine`, `claude.ts`). The exporter takes the skill the same way.

## Open questions
1. **Re-export dedupe** (two identical 2-span requests posted twice):
   | Backend | Spans after 2 posts | Verdict |
   |---|---|---|
   | Jaeger all-in-one (`jaegertracing/jaeger:latest`, memory storage) | 2 | dedupes |
   | Grafana Tempo (`grafana/tempo:latest`, local storage, queried right after) | 4 | duplicates (compaction may merge later — not shown) |
   | SigNoz, Honeycomb | – | untested |
   README: `--resend` "may duplicate" except on Jaeger.
2. **Claude approval status.** Registry files `~/.claude/sessions/<pid>.json` showed only `busy`, `idle`, `shell`. The
   2.1.285 bundle has a `status: "waiting"` (with `waitingFor`) state, but whether it reaches the registry file during a
   permission prompt was not observed (no interactive Claude run: the user's own Claude sessions are off limits).
   Ruling: estimated waits from the watchdog only (spec fallback) — cost if wrong: waits stay `agentglass.estimated`
   where they could be exact.
3. **fx / Kiro token semantics.** No fx install on this machine (`~/.fx` holds only `skills`). Kiro sidecars exist but none
   has `user_turn_metadatas` entries. Ruling: spec fallback — fx exclusive (`in + cr + cw`, README "unverified"), Kiro
   `in` only, no cache attributes — cost if wrong: fx input_tokens off by the cache share.
4. **Native session keys** (sources via `npx opensrc`): Gemini CLI puts `session.id` on every span
   (`packages/core/src/telemetry/telemetryAttributes.ts:20`, `sdk.ts:217`); OpenCode puts `session.id` on `Tool.execute`
   spans (`packages/opencode/src/session/tools.ts:411-417`). Both verified, no longer "uncertain". Codex
   `conversation.id`, Claude Code `session.id` as in the spec.
5. **Binary body file.** scriptc 0.1.7 `writeFileSync(path, Uint8Array)` and `openSync`+`writeSync(fd, Uint8Array)` both
   write all 256 byte values unchanged. `writeBin` uses `writeFileSync`; the per-run probe stays as the guard.
6. **Codex request grain.** Newest 3 rollouts: 2, 16 and 59 changed `token_count` events, each preceded by 1–6 response
   items (reasoning + function calls, or a message) — one model response per changed count; no `info: null` and no
   repeated totals in these files (the builder still skips both). Confirmed.

## Claude API-error lines
`isApiErrorMessage: true` assistant lines carry `message.model = "<synthetic>"`, a `message.id`, `usage`, and a string
`error` (e.g. `rate_limit`) plus `apiErrorStatus`.
Ruling: such a line becomes a `chat` span with status ERROR, `error.type` = the line's `error` string (else
`api_error`), no `gen_ai.request.model` (the request never reached a model) — cost if wrong: one attribute value.
