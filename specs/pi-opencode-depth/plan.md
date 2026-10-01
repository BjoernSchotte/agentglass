# pi MCP + pi subagents + OpenCode HTTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi MCP calls (native ≥ 0.99 incl. codemode-nested, and pi-mcp-adapter) and pi subagent sessions show correctly in transcript, call graph and Stats; OpenCode 2.x sessions show over the daemon's HTTP API when `sqlite3` is unavailable.

**Architecture:** pi changes stay inside `src/harness/pi.ts` plus one record primitive (`retool`). OpenCode gets a second transport (`src/harness/opencode-http.ts`) behind the existing adapter, selected per scan; a cursor `epoch` on the `SessionSource` port lets the ledger and readers reset a session whose cursor meaning changed. HTTP goes through the `curl` CLI synchronously (new `src/util/http.ts`), like `sqlite3`.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps; `node:fs`, `node:child_process` (`execFileSync` with `input`). Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first; this plan argues from it.

## Global Constraints

- Build: `./build.sh`. Tests: `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass.
- scriptc limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields, not foreign interfaces); call optional function members via a local; out-of-range array reads trap (`numAt`/bounds checks); no `Promise.race` over mixed types.
- Style: match surrounding code — dense one-line helpers, short `//` comments saying why, no new dependencies.
- Old behavior is a contract: for the existing pi fixtures (`specs/pi-opencode-harnesses/fixtures/`) and the user's real sessions, `agentglass --json --subagents --limit 400` is field-identical before/after Tasks 1–6 except volatile fields (`updated bytes activity live pid status attention stuck`) and the intended additions (new rows for nested/MCP calls, new subagent sessions).
- Never write to agent data dirs; never start the OpenCode daemon (no `opencode api|run|serve` from agentglass code); the daemon password never appears in argv, env of children, logs, `--json` or errors.
- Detection by content, never by pi version (the header has none).
- `src/features/usage/cache.ts` `VERSION` bumps to 5 in Task 7 (Acc gains `ep`; pi Stats change) — once, not per task.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in worktree `../agentglass-depth`, branch `feat/pi-opencode-depth`, PR to `main`, rebase-merge after green CI.

## Review Focus

1. **A call counted twice or lost by `retool`**: the count must move, not copy — tool total, day total, hour histogram and the per-tool row (removed when it drops to 0). Task 1 check asserts totals before/after.
2. **Codemode with `complete:false` / `argumentsBytes`** (arguments dropped): nested bash/edit without arguments must not crash or invent lines; they count as calls only. Task 3 fixture.
3. **A pi `/fork` with `parentSession` and no subagent name** must stay top-level and keep its live pid; a tintinweb child must not take the parent's pid. Task 5 check with both in one cwd.
4. **OpenCode HTTP while a message streams**: the readable end holds at the first unfinished assistant row while the session is active and is released when it settles; the end never moves back. Task 9 check with a fixture that changes between two fake-curl responses.
5. **Transport switch** (sqlite3 appears/disappears mid-run): no session counted twice in Stats, transcript does not show garbage. Task 7 + Task 9 checks flip `AGENTGLASS_SQLITE3` between ticks.

---

### Task 0: Environment, real sessions, fixtures

**Files:** `specs/pi-opencode-depth/fixtures/` (committed, anonymized, ≤ 60 lines per file).

- [ ] **Step 1: Worktree** `git worktree add -b feat/pi-opencode-depth ../agentglass-depth main`; `./build.sh` there.
- [ ] **Step 2: pi 0.99.2** (spec open question 1): `PATH=$HOME/.nvm/versions/node/v24.12.0/bin:$PATH npm i -g --ignore-scripts @earendil-works/pi-coding-agent@0.99.2 && pi --version`.
- [ ] **Step 3: MCP server** (open question 2): `~/.pi/agent/mcp.json` = `{"mcpServers":{"everything":{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}}}`. pi already points at cliproxyapi (models.json from the previous plan).
- [ ] **Step 4: Real runs** in `/tmp/agtest-mcp`: (a) default exposure (codemode): "use the everything MCP server's echo and add tools, then write notes.txt with the results and run `wc -l notes.txt`"; (b) set `"exposure":"direct"` for the server and repeat with echo only; (c) one call that fails (`everything` tool with a bad argument).
- [ ] **Step 5: Subagent packages** (open question 3): `pi install npm:@tintinweb/pi-subagents` in `/tmp/agtest-sub1`, run "use a subagent to list the files here"; then remove it, `pi install npm:pi-subagents` in `/tmp/agtest-sub2`, same prompt. Record where the child files landed (`find ~/.pi/agent/sessions -newer <marker>`). Uninstall both afterwards.
- [ ] **Step 6: pi-mcp-adapter**: `pi install npm:pi-mcp-adapter` in `/tmp/agtest-adapter` with the same mcp.json, one proxy call and one failing call; uninstall afterwards.
- [ ] **Step 7: OpenCode HTTP fixtures**: read the running daemon (read-only GETs only) with `curl -sS -K -`, credentials on stdin from `service.json`: `/api/info`, `/api/session?limit=50`, `/api/session/active`, `/api/session/<id>/message?order=asc&limit=200` for one session that spawned a subagent and for that subagent. Save under `fixtures/oc-http/`. Never print or commit the password; no POSTs.
- [ ] **Step 8: Anonymize + commit**: replace `$HOME` with `/home/u`, keys/emails/tokens with placeholders, trim tool output to ≤ 200 chars. `git add specs/pi-opencode-depth/fixtures && git commit -m "chore(specs): real pi MCP, pi subagent and OpenCode HTTP fixtures"`.
- If a real shape contradicts the spec's facts: ledger a `Ruling:` and follow the real data.

---

### Task 1: `retool` primitive + one call-recording helper in pi.ts (no behavior change)

**Files:** Modify `src/features/usage/record.ts`, `src/harness/pi.ts`; Test `src/features/usage/record.check.ts` (create if absent; otherwise extend), `src/harness/harness.check.ts` (pi samples unchanged).

**Interfaces — Produces:**
- `export function retool(a: Acc, p: Pend, name: string): void` — moves one call from `p.st` to the tool row `name` of the day of `p` (`bucket(a, p.t, p.ts)`): old row `n--` and `h[hour]--` (row deleted from `d.tt` at `n === 0`), new row `n++`, `h[hour]++`, then `p.st = new row`. `a.tools`, `d.tools`, `d.hours` unchanged. No-op when the name is already the row's key.
- pi.ts `function callStats(a: Acc, d: Day, name: string, id: string, inp: Obj | null, iso: string, t: number): void` — the body of today's per-toolCall loop (tool + pend + edit/write lines + files), reused by Tasks 2–3.

- [ ] **Step 1: Failing check** in `record.check.ts`: build an Acc, `tool()`+`pend()` a call `mcp` at 10:00, `retool(a, p, "mcp__s__t")`; assert `d.tt.has("mcp") === false`, `d.tt.get("mcp__s__t").n === 1`, `.h[10] === 1`, `a.tools === 1`, `d.tools === 1`; a second call `mcp` kept → row `mcp` n 1 after moving the other. Run `scriptc build src/features/usage/record.check.ts -o /tmp/rc && /tmp/rc` → FAIL (retool undefined).
- [ ] **Step 2: Implement `retool`** (record.ts, next to `pend`); find the old key by identity over `d.tt`.
- [ ] **Step 3: Extract `callStats`** in pi.ts from the assistant toolCall loop; the loop calls it. No other change.
- [ ] **Step 4: Verify**: record check PASS; `sh scripts/check.sh` PASS; `./agentglass --json --harness pi --limit 400` before/after identical (store before-output from `main` build in the workspace).
- [ ] **Step 5: Commit** `refactor(usage): retool primitive; pi records calls through one helper`.

---

### Task 2: pi MCP canonical names + adapter errors

**Files:** Modify `src/harness/pi.ts`; Test `src/harness/pi.check.ts` (create: feeds fixture lines through `pi.usage` into an Acc and asserts tool rows).

**Interfaces — Consumes:** `retool`, `callStats` (Task 1), `mcpServer` (calls.ts).

Rules (spec decisions 2, 4), applied in `usage()` on `role:"toolResult"` before `done()`:
- `det = obj(m["details"])`; `srv = str(det.server)`, `tl = str(det.tool)`, `mode = str(det.mode)`.
- canonical = `srv && tl && (mode === "" || mode === "call") ? "mcp__" + srv + "__" + tl : ""` — sanitize nothing (display name; `mcpServer` splits at the first `__` after the prefix, so a server containing `__` groups wrongly: accepted, spec).
- if canonical and the pending row's key ≠ canonical → `retool(a, p, canonical)`.
- error = `m.isError === true || det.error === "tool_error" || det.error === "call_failed"`.

- [ ] **Step 1: Failing checks** (pi.check.ts) with lines from Task 0 fixtures (fallback: the shapes in spec "Facts"): native direct `mcp__everything__echo` + result `details{server:"everything",tool:"echo"}` → row `mcp__everything__echo` n 1; adapter proxy `mcp {tool:"echo",server:"everything"}` + result `details{mode:"call",server:"everything",tool:"echo"}` → row `mcp__everything__echo`, no `mcp` row; adapter `mode:"search"` → stays `mcp`; adapter direct `everything_echo` + `details{server,tool}` → `mcp__everything__echo`; wrapper `mcp__everything` → `mcp__everything__echo`; `isError:false` + `details.error:"tool_error"` → `err === 1`; `details.error:"auth_required"` → `err === 0`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** in pi.ts `usage()` toolResult branch.
- [ ] **Step 4: Run** pi.check PASS, `sh scripts/check.sh` PASS, old-pi `--json` identical.
- [ ] **Step 5: Commit** `feat(pi): MCP calls under mcp__<server>__<tool>, adapter errors count`.

---

### Task 3: pi nested calls (codemode, mcpScript)

**Files:** Modify `src/harness/pi.ts`; Test `src/harness/pi.check.ts`.

Rules (spec decision 3), after the parent's `done()`:
- source list: `nestedCalls.calls` if present; else `details.calls` (codemode: `args` is a JSON string → `parseJson`); else adapter `details.mode === "script"` → `details.calls[{operation:"call", path, ok, error, durationMs}]` (name = `path`; non-`call` operations skipped).
- per nested call `c`: `d = bucket(a, 0, iso)` (parent result time); `callStats(a, d, name, c.id, args, iso, 0)`; then `done(p2, durationMs ?? -1, status === "error" || ok === false, 0, c.id, [])` on the pend `callStats` created (status `unfinished`/`running`/`cancelled` → `done` with `-1`, no error).
- arguments missing (`argumentsBytes`) → `inp = null`: call counted, no lines/files/commands.

- [ ] **Step 1: Failing checks**: codemode result with nestedCalls `[mcp__everything__echo ok 412ms, bash {command:"wc -l notes.txt"} ok, write {path:"notes.txt",content:"a\nb\n"} ok, mcp__everything__add error "bad", edit argumentsBytes 9000 unfinished]` → rows: `codemode` 1, `mcp__everything__echo` 1 with `ms === 412`, `bash` 1 + shell program `wc`, `write` 1 + 2 added lines + file `notes.txt`, `mcp__everything__add` 1 err 1, `edit` 1 no lines; `a.tools === 6`. Same calls only in `details.calls` (no nestedCalls) → same rows. Adapter `mcpScript` with `calls[{operation:"call",path:"echo",ok:true,durationMs:5},{operation:"search",…}]` → `echo` 1 (+ `mcpScript` 1).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** PASS + suite + old-pi identical.
- [ ] **Step 5: Commit** `feat(pi): count tool calls nested in codemode and mcpScript`.

---

### Task 4: pi transcript for MCP and nested calls

**Files:** Modify `src/harness/common.ts` (`toolArg` keys), `src/harness/pi.ts` (`parse`); Test `src/harness/harness.check.ts` SAMPLES (pi) + `pi.check.ts`.

- `toolArg`: add key `code` (first non-empty line, ≤ 120 chars) after `query`; for name `mcp` with `inp.tool`: return `(server ? server + "/" : "") + tool`. Keep key order otherwise (other harnesses unchanged — assert claude/codex samples identical).
- `parse` toolResult: after the `result` event, per nested call (same source list as Task 3) one `meta` event `"↳ " + name + " " + (status === "error" ? "[error] " + error : status) + (durationMs ? " " + fmtMs(durationMs) : "")`.
- `parse` `role:"system"` with `sections.mcp_servers` (array of `{name}` or strings — take what the fixture shows) → `meta` `"MCP: " + names.join(", ")`.

- [ ] **Step 1: Failing checks** for the three cases (events text). **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(pi): transcript shows codemode code, MCP proxy targets and nested calls`.

---

### Task 5: pi subagent discovery + liveness

**Files:** Modify `src/harness/pi.ts` (`scan`, `meta`); Test `src/harness/pi.check.ts` (temp session dir via `PI_CODING_AGENT_SESSION_DIR`), `src/model/link.ts` behavior via existing `linkByCwd` check if present.

**Interfaces — Produces:** `scan` adds children with `parent` = parent id; `meta` sets `s.parent`/`s.kind` for tintinweb children.

- `scan`: per `--cwd--` dir, for each `<base>.jsonl` with a sibling dir `<base>/`: `tasks/*.jsonl`, `forks/*.jsonl`, `*/run-*/session.jsonl` → `add(path, headerId(path), parentId(base), false)`. `headerId` reads ≤ 4 KB once, cached in a `Map<path, string>` (falls back to the filename rule). `parentId(base)` = filename rule on `<base>.jsonl`. One extra `listDir` only for bases that have a dir (check with the dir listing already read).
- `meta`: header with `parentSession` and s.parent unset → read `headBytes` once; a `session_info` whose name matches `/^[^#\s]+#[0-9a-f]{8}$/` → `s.parent` = id from the `parentSession` value (path → filename rule; bare id → as is), `s.kind` = part before `#`. Else unchanged (fork stays top-level).
- `kind` for scan-found children: `"subagent"` (set in meta when `s.parent` came from scan).

- [ ] **Step 1: Failing checks**: temp dir with parent `P.jsonl`, `P/tasks/T.jsonl` (header parentSession = P's id), `P/r1/run-0/session.jsonl` (header id X), `P/forks/F.jsonl`, sibling tintinweb child `C.jsonl` (header parentSession = P path, `session_info` `Explore#1b2c3d4e`), sibling fork `K.jsonl` (parentSession = P path, no such name) → scan yields 6 sessions; T/X/F have parent P and id from header; after meta C has parent P kind `Explore`; K has no parent. Liveness: `linkByCwd` with one pi process in that cwd and C newest → linked to the newest unparented (K or P), never C.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS + suite + `--json` on the user's real `~/.pi` unchanged except new children.
- [ ] **Step 5: Commit** `feat(pi): find subagent sessions of the pi-subagents packages and nest them`.

---

### Task 6: pi spawnOf + example-extension child usage

**Files:** Modify `src/harness/pi.ts` (`spawnOf`, `usage`); Test `src/harness/pi.check.ts`.

- `spawnOf(s)`: `s.parent` set → find the parent session path (same dir / `<base>.jsonl` two or three levels up — derive from the child path for scan-found children, from `parentSession` for tintinweb); read it in 1 MB chunks for the needle (`"sessionFile":"<child path>"` → nearest preceding `"toolCallId":"…"` in the same line; or `"agentId":"<8 hex>` in a line with `"toolName":"Agent"` → its `toolCallId`). Cache per child path (also misses, re-tried when the parent's size changed).
- `usage()` toolResult with `toolName ∈ {subagent, Agent}` and `details.results[]`: for each result **without** `sessionFile`, book `results[].usage` via `book(a, u, results[].model, iso)` (cost from `usage.cost` number or `usage.cost.total`). With `sessionFile`: nothing (the child file is counted on its own).

- [ ] **Step 1: Failing checks**: parent line with `details.results[{sessionFile:"<child>"}]` + toolCallId `call_9` → `spawnOf(child) === "call_9"`; tintinweb `Agent` result `details.agentId:"1b2c3d4e5f…"` → `spawnOf(C) === <its toolCallId>`; example-extension result `results[{usage:{input:10,output:5,cost:0.01},model:"m"}]` → Acc cost +0.01; same with `sessionFile` → +0.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(pi): link subagents to their spawning call, count --no-session subagent cost`.

---

### Task 7: SessionSource `epoch` + ledger/readers reset

**Files:** Modify `src/harness/types.ts` (`epoch?`), `src/features/usage/record.ts` (`Acc.ep`), `src/features/usage/cache.ts` (persist `ep`, `VERSION = 5` with comment `5: Acc.ep (source cursor epoch); pi MCP/nested/subagent stats`), `src/features/usage/ledger.ts:19` (reset on epoch change), `src/model/sessions.ts` (treat an epoch change like a rewrite: reload head/tail), `src/ui/transcript.ts`, `src/features/callgraph/view.ts`, `src/features/cli.ts` (`--watch`: reset cursor); Test `src/harness/source.check.ts`.

**Interfaces — Produces:** `epoch?: (s: Sess) => string` on `SessionSource`; helper `export function epochOf(s: Sess): string` in `src/harness/index.ts` (`""` when absent). `Sess` gains `ep: string` (set wherever `size` is set from `stat`).

- [ ] **Step 1: Failing check** (source.check.ts): fake source whose epoch flips from "a" to "b" with the same size → ledger `accOf` returns a fresh Acc (off 0) and `sessions` reloads the tail; unchanged epoch → same Acc.
- [ ] **Step 2:** FAIL. **Step 3: Implement** (all readers route through one `epochOf` comparison next to their existing truncation check). **Step 4:** PASS + suite; a cache written by v4 is dropped once (VERSION).
- [ ] **Step 5: Commit** `feat(harness): SessionSource cursor epoch — readers and ledger reset when it changes`.

---

### Task 8: `src/util/http.ts` — synchronous JSON GET through curl

**Files:** Create `src/util/http.ts`, `src/util/http.check.ts`.

**Interfaces — Produces:**
- `export function curlBin(): string` — `$AGENTGLASS_CURL` or `curl`, probed once per value with `-V` (like `sqliteBin`).
- `export function getJson(url: string, user: string, pass: string): Obj | null` — `execFileSync(curlBin(), ["-sS", "--fail", "--max-time", "3", "-K", "-"], { input: 'url = "<url>"\nuser = "<user>:<pass>"\n', maxBuffer: 67108864, timeout: 4000 })`; `"` and `\` in values escaped for curl's config syntax; null on any error or non-object JSON. The password is only in `input`.

- [ ] **Step 1: Failing check**: fake curl script (sh) that writes its stdin to a file and prints `{"ok":1}` → `getJson` returns `{ok:1}`; argv recorded by the fake contains no password; a fake that exits 22 → null; `AGENTGLASS_CURL=/nonexistent` → `curlBin() === ""`, `getJson` null.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS + suite.
- [ ] **Step 5: Commit** `feat(util): JSON GET through the curl CLI, credentials via stdin`.

---

### Task 9: OpenCode HTTP transport + selection

**Files:** Create `src/harness/opencode-http.ts`; Modify `src/harness/opencode.ts` (`scan`, `source`, `search`, `busy`, warning text, `epoch`); Test `src/harness/opencode.check.ts` (extend; fake curl serving `specs/pi-opencode-depth/fixtures/oc-http/*.json` by URL path).

**Interfaces — Produces (opencode-http.ts):**
- `export function endpoint(): { url: string; pass: string; pid: number } | null` — reads service.json (cached by its mtime), requires a live pid that is an OpenCode process (reuse `daemonUp` logic), then `/api/info` pid match (cached per service.json mtime).
- `export function listSessions(ep): Obj[] | null` — paginated `/api/session?limit=1000`, stop on a short page.
- `export function activeSet(ep): Set<string> | null`.
- `export function messages(ep, id: string, after: string): Obj[] | null` — `/api/session/<id>/message?order=asc&limit=200` (+ cursor from `after`), all pages.
- Row fields map: `dir = location.directory`, `parent = parentID`, `mtime = time.updated`, `archived = !!time.archived`, `fork = fork ? time.created : 0`, `busy = active.has(id)`.

**opencode.ts selection** (spec decision 11): per scan `mode = sqliteBin() && load(db) ok ? "seq" : endpoint() ? "idx" : ""`; `mode === ""` → warning `OpenCode needs the sqlite3 CLI or a running opencode service` (once), keep last rows for this run. `source.epoch = () => mode`. HTTP rows keep the same path `<db>#<id>` (same session, different cursor meaning → epoch).
**HTTP lines(s, from, to)**: per-session cache `{msgs: Obj[], settled: number}`; refresh when the row's `mtime` changed: fetch after the last settled message id, replace unsettled tail; `end` = index of the first unsettled assistant/shell/compaction message while busy, else `msgs.length`; the floor rule (`r.floor`) applies unchanged. Each line = `JSON.stringify` of the message with `seq` = index and `copied:1` when `time.created < fork`.
**search** in HTTP mode: title match over rows (documented).

- [ ] **Step 1: Failing checks**: (a) `AGENTGLASS_SQLITE3=/nonexistent`, fake curl serving info/session/active/messages fixtures → scan lists the fixture sessions with parent links, `usage` cost equals the fixture sum, transcript events non-empty; (b) wrong pid in `/api/info` → no sessions + warning; (c) busy session whose last assistant has no `time.completed` → `stat().size` = its index; next fake response completes it → size = length; never decreases; (d) flip `AGENTGLASS_SQLITE3` back to the fixture DB → epoch changes to `seq`, ledger re-reads, Stats cost equals the SQLite-only run (no double count).
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS + suite; check that no test or log output contains the fixture password.
- [ ] **Step 5: Commit** `feat(opencode): read sessions over the service daemon's HTTP API when sqlite3 is unavailable`.

---

### Task 10: Real-life verification + docs

**Files:** Modify `README.md` (pi MCP/subagents; OpenCode: sqlite3 *or* running service), `src/ui/help.ts` if it mentions the sqlite3 requirement.

- [ ] **Step 1:** Build; run agentglass against the Task 0 real sessions: pi MCP runs → Stats rows `mcp__everything__*` grouped under server `everything`, nested bash/write counted, failing call red; subagent runs → children nested under parents, call graph links, parent stays live while child runs; OpenCode with `AGENTGLASS_SQLITE3=/nonexistent` while the daemon runs → sessions, transcript, busy, Stats as with sqlite3 (compare `--json` costs).
- [ ] **Step 2:** README + help text. **Step 3:** `sh scripts/check.sh` PASS.
- [ ] **Step 4: Commit** `docs: pi MCP and subagents, OpenCode without sqlite3`.
- [ ] **Step 5:** Final whole-branch review (most capable model), fix pass, PR, CI green, rebase-merge, delete worktree + branch, clean `/tmp/agtest-*`, uninstall test packages/configs added in Task 0 (keep pi 0.99.2 unless the user says otherwise).
