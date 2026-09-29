# pi + OpenCode Harness Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agentglass shows pi (0.87.x) and OpenCode (2.0.x, plus 1.2–1.18) sessions with the same depth as Claude/Codex: list, live transcript, drill-down, subagents, live/busy, send/resume, tokens + cost, `--json`/`--watch`.

**Architecture:** Each harness is one adapter file behind the `HarnessAdapter` port. Two port extensions come first: a `SessionSource` so sessions need not be files (OpenCode lives in SQLite), and small optional capabilities (`liveCwd`, `search`, optional `files`, steering with the `Sess`, exact harness-reported cost). pi reads JSONL; OpenCode reads `opencode.db` through the `sqlite3` CLI.

**Tech Stack:** TypeScript compiled to a native binary with scriptc 0.1.7 (Node 24 to build; no npm deps at runtime; `node:fs`, `node:path`, `node:os`, `node:child_process`, `fetch`). Checks are standalone scriptc programs (`*.check.ts`).

**Spec:** [spec.md](spec.md) — read it first; this plan argues from it.

## Global Constraints

- Build: `./build.sh` (needs Node 24+, scriptc, clang). A task is done only when `./build.sh` succeeds.
- Checks: every `src/**/*.check.ts` builds and passes: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc limits (hit before in this repo): no `readlinkSync`; number `.toString(radix)` is unsupported (use `String(n)`); structural typing is nominal — pass fields, not objects of another interface; call optional function members via a local (`const f = ad.x; if (f) f()`); no `Promise.race` over mixed types; out-of-range array reads trap (use `numAt`/bounds checks).
- Style: match the surrounding code — dense one-line helpers, short `//` comments that say why, no new dependencies.
- The four existing adapters (claude, codex, fx, kiro when merged) must behave exactly as before: `--json --subagents --limit 400` output is field-identical before/after Tasks 1–2 (except volatile fields `updated bytes activity live pid status attention stuck`).
- Never write to agent data dirs from agentglass code paths except the existing trash action; OpenCode DB access is `sqlite3 -readonly`.
- Commits: conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A session appended while being read** (JSONL partial last line; SQLite row inserted mid-query): readers must never emit a half record or skip one — Task 1 `source.check.ts` pins the partial-line cases; Task 4 pins `seq` continuation.
2. **`sqlite3` missing or DB locked/busy** → OpenCode shows nothing, one warning, no crash, no 4 s stall per tick — Task 4 check with a bogus `AGENTGLASS_SQLITE3` binary + timing assert.
3. **pi fork files** (`parentSession`) double-counting cost in Stats — Task 3 sample with a forked session asserts the copied entries add 0 cost.
4. **Two pi sessions in the same cwd, one process** → only the newest is marked live — Task 2 `linkByCwd` unit test.
5. **OpenCode session present in both v1 and v2 tables** (migrated, then 1.18 kept writing) → listed once, v2 data — Task 4 fixture DB with a duplicate id.

---

### Task 0: Environment + real sessions (needs spec open questions 1, 3, 4 answered)

**Files:** none in the repo. Output: anonymized fixture lines under `specs/pi-opencode-harnesses/fixtures/` (committed; they feed the golden samples of Tasks 3–4).

- [ ] **Step 1: Create the worktree** (superpowers:using-git-worktrees): branch `feat/pi-opencode` from `main`, worktree `../agentglass-pi-opencode`. Run `./build.sh` there.
- [ ] **Step 2: Install pi 0.87.1**
  ```sh
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
  pi --version   # expect 0.87.1
  ```
- [ ] **Step 3: Install OpenCode 2.0.19** (per answer to open question 1; default: replace brew)
  ```sh
  brew uninstall opencode && npm install -g @opencode/cli@2.0.19
  opencode --version   # expect 2.0.19
  ```
- [ ] **Step 4: Point both at cliproxyapi** (`127.0.0.1:8317`, key in `~/.config/cliproxyapi/config.yaml` → `api-key`; never print it). pi: add a custom provider in `~/.pi/agent/models.json` (`baseUrl: "http://127.0.0.1:8317/v1"`, `api: "openai-completions"` for Codex models and `anthropic-messages` with `baseUrl: "http://127.0.0.1:8317"` for Claude; see pi docs `docs/models.md`). OpenCode: `~/.config/opencode/opencode.json` provider with `options.baseURL` `http://127.0.0.1:8317/v1` and `apiKey` `{env:CLIPROXY_KEY}`. Verify each with a one-line prompt.
- [ ] **Step 5: Real-life runs** in fresh dirs under `/tmp/agtest-{pi,oc}`: "Build a minimal todo web app (single index.html + app.js, localStorage, add/toggle/delete), then run a quick syntax check with node --check app.js". For OpenCode also ask it to delegate one part to a subagent (task/subagent tool). Then in each: resume the session once and send one follow-up headless (`pi -p --session <file> -- "add a clear-completed button"`, `opencode run -s <id> "add a clear-completed button"`).
- [ ] **Step 6: Capture fixtures**: copy the pi JSONL and `sqlite3 -readonly -json ~/.local/share/opencode/opencode.db "select * from session_v2"`, `"select * from session_message where session_id in (…) order by seq"` into `fixtures/`, replacing the home path with `/home/u`, emails and keys with placeholders. Keep ≤ 40 lines per file.
- [ ] **Step 7: Commit** `chore(specs): real pi and OpenCode fixture sessions`.

---

### Task 1: SessionSource port — sessions need not be files

**Files:**
- Create: `src/harness/source.ts`, `src/harness/source.check.ts`
- Modify: `src/harness/types.ts` (add `source?`), `src/harness/index.ts` (export `sourceOf`), `src/model/sessions.ts:14-47` (addFile/loadHead/loadTail), `src/features/usage/ledger.ts` (step), `src/ui/transcript.ts:45-56,100-110`, `src/features/callgraph/view.ts:32-40,78-88`, `src/features/cli.ts:140-156`

**Interfaces:**
- Produces:
  ```ts
  // src/harness/types.ts
  export interface SessionSource {
    stat: (s: Sess) => { size: number; mtime: number } | null; // size = end cursor (bytes for files)
    align: (s: Sess, at: number) => number;                      // first whole record at/after `at`
    lines: (s: Sess, from: number, to: number) => { lines: string[]; next: number }; // whole records in [from, to); next = cursor after the last one
    unit: number;                                                 // bytes one cursor step stands for (window budgets)
  }
  // HarnessAdapter gains:  source?: SessionSource;
  // src/harness/index.ts
  export function sourceOf(h: string): SessionSource;          // adapter's source or FILE_SOURCE
  export function window(src: SessionSource, bytes: number): number; // Math.max(1, Math.round(bytes / src.unit))
  ```

- [ ] **Step 1: Write the failing check** `src/harness/source.check.ts`:
  ```ts
  // agentglass — self-check for the file session source: scriptc build src/harness/source.check.ts -o sc && ./sc
  import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
  import { newSess } from "../model/types.ts";
  import { FILE_SOURCE } from "./source.ts";
  let bad = 0;
  function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
  const dir = "/tmp/agentglass-source-check"; mkdirSync(dir, { recursive: true });
  const p = dir + "/s.jsonl";
  const fd = openSync(p, "w"); writeSync(fd, "{\"a\":1}\n{\"b\":2}\n{\"c\":3"); closeSync(fd); // last line still being written
  const s = newSess("claude", "x", p, false);
  const st = FILE_SOURCE.stat(s);
  ok("stat size", !!st && st.size === 23, JSON.stringify(st));
  const r = FILE_SOURCE.lines(s, 0, 23);
  ok("whole lines only", r.lines.join("|") === "{\"a\":1}|{\"b\":2}" && r.next === 16, JSON.stringify(r));
  ok("align mid-line", FILE_SOURCE.align(s, 3) === 8, String(FILE_SOURCE.align(s, 3)));
  ok("align at start", FILE_SOURCE.align(s, 0) === 0, String(FILE_SOURCE.align(s, 0)));
  ok("nothing new", FILE_SOURCE.lines(s, 16, 23).lines.length === 0 && FILE_SOURCE.lines(s, 16, 23).next === 16, "");
  ok("missing file", FILE_SOURCE.stat(newSess("claude", "y", dir + "/nope.jsonl", false)) === null, "");
  console.log(bad ? bad + " failed" : "source: all checks passed");
  process.exit(bad ? 1 : 0);
  ```
- [ ] **Step 2: Run it — expect a build failure** (`source.ts` missing): `scriptc build src/harness/source.check.ts -o /tmp/sc`
- [ ] **Step 3: Implement** `src/harness/source.ts`:
  ```ts
  // agentglass — where a session's records come from: files by default (byte cursor), adapters may bring their own (OpenCode: SQLite rows by seq)
  // SPDX-License-Identifier: Apache-2.0
  import { statSync } from "node:fs";
  import { readBytes, readLines } from "../util/fs.ts";
  import type { Sess } from "../model/types.ts";
  import type { SessionSource } from "./types.ts";

  export const FILE_SOURCE: SessionSource = {
    stat: (s: Sess) => { try { const st = statSync(s.path); return { size: st.size, mtime: st.mtimeMs }; } catch (e) { return null; } },
    align: (s: Sess, at: number) => {
      if (at <= 0) return 0;
      const b = readBytes(s.path, at - 1, 1048576); // the byte before `at`: a newline means `at` already starts a line
      let i = 0; while (i < b.length && b[i] !== 10) i++;
      return i < b.length ? at + i : at;
    },
    lines: (s: Sess, from: number, to: number) => readLines(s.path, from, to, false),
    unit: 1,
  };
  ```
  Add `source?: SessionSource;` with a comment to `HarnessAdapter` (section "discovery"), and in `index.ts`:
  ```ts
  import { FILE_SOURCE } from "./source.ts";
  export function sourceOf(h: string): SessionSource { return harnessOf(h).source ?? FILE_SOURCE; }
  export function window(src: SessionSource, bytes: number): number { return Math.max(1, Math.round(bytes / src.unit)); }
  ```
- [ ] **Step 4: Run the check — expect `source: all checks passed`.**
- [ ] **Step 5: Route the six readers through the source.** Replace, keeping each call site's window size:
  - `sessions.ts addFile`: `statSync(path)` → `const st = sourceOf(h).stat(s)` (create `s` first, drop it again if `st` is null and it was new).
  - `sessions.ts loadHead`: `readText(s.path, 0, headBytes).split("\n")` → `src.lines(s, 0, window(src, harnessOf(s.h).headBytes)).lines`.
  - `sessions.ts loadTail`: `start = Math.max(0, s.size - 98304)` → `src.align(s, Math.max(0, s.size - window(src, 98304)))`, then `src.lines(s, start, s.size)`.
  - `transcript.ts renderTranscript`: stat via `src.stat(s)`; `readLines(...)` → `src.lines(s, t.off, Math.min(s.size, t.off + window(src, 16777216)))`. `openTranscript`: replace the manual newline skip with `t.off = src.align(s, start)` where `start = Math.max(0, s.size - window(src, 6291456))`; the "showing last …" meta stays, using `bytes((s.size - start) * src.unit)`.
  - `callgraph/view.ts loadTV` and the tail loop: same pattern as the transcript.
  - `cli.ts --watch poll`: `statSync(s.path).size` → `src.stat(s)`; `readLines` → `src.lines(s, at, size)`.
  - `ledger.ts step`: keep the byte path for `FILE_SOURCE` untouched; for other sources: `const r = src.lines(s, a.off, a.off + window(src, CHUNK)); for (const l of r.lines) ad.usage(a, l); const used = r.next - a.off; a.off = r.next; return used * src.unit;` (0 when nothing new).
- [ ] **Step 6: Regression** — build; run all checks; `./agentglass --json --subagents --limit 400` equals the `main` binary's output (script from the spec's constraint); open a transcript and the call graph in the TUI (tmux) on a live Claude session and see it follow.
- [ ] **Step 7: Commit** `refactor(harness): SessionSource port — readers go through the adapter's source`.

---

### Task 2: Port capabilities — steering with the session, optional files/search, liveness by cwd, exact cost

**Files:**
- Modify: `src/harness/types.ts`, `src/harness/{claude,codex,fx}.ts` (+ `kiro.ts` if merged), `src/actions.ts` (sendPrompt, resume, trash, fullText), `src/input.ts` (`D` guard), `src/model/procs.ts` (cwd linking), `src/features/usage/record.ts` (`usageExact`), `src/harness/harness.check.ts`
- Create: `src/model/link.ts`, `src/model/link.check.ts`

**Interfaces:**
- Consumes: Task 1's `sourceOf`.
- Produces:
  ```ts
  // HarnessAdapter changes
  headless?: (s: Sess, msg: string) => string[];   // was (id, msg)
  resume?: (s: Sess) => string[];                  // was (id)
  files?: (s: Sess) => string[];                   // optional now: no trash when absent
  search?: (q: string) => string[];                // session paths matching q (non-file sources); file harnesses use roots() + rg
  liveCwd?: boolean;                               // link a live process to the newest session whose cwd equals the process cwd
  // src/model/link.ts (pure, unit-tested)
  export interface CwdProc { pid: number; h: string; cwd: string }
  export function linkByCwd(procs: CwdProc[], sess: { path: string; h: string; cwd: string; mtime: number; pid: number }[]): Map<string, number>; // session path → pid
  // src/features/usage/record.ts
  export function usageExact(a: Acc, d: Day, model: string, nIn: number, nOut: number, nCr: number, w5: number, w1: number, usd: number): void; // usd < 0 → priced like tokens()
  ```

- [ ] **Step 1: Failing unit check** `src/model/link.check.ts`:
  ```ts
  import { linkByCwd } from "./link.ts";
  let bad = 0;
  function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
  const S = (path: string, cwd: string, mtime: number, pid: number) => ({ path, h: "pi", cwd, mtime, pid });
  const m = linkByCwd([{ pid: 10, h: "pi", cwd: "/w/a" }, { pid: 11, h: "pi", cwd: "/w/b" }, { pid: 12, h: "codex", cwd: "/w/a" }],
    [S("old", "/w/a", 1, 0), S("new", "/w/a", 5, 0), S("b", "/w/b", 3, 0), S("c", "/w/c", 9, 0), S("taken", "/w/b", 8, 11)]);
  ok("newest session in the cwd", m.get("new") === 10 && !m.has("old"), JSON.stringify([...m]));
  ok("already linked sessions are skipped, next newest wins", m.get("b") === 11 && !m.has("taken"), JSON.stringify([...m]));
  ok("other harness ignored", [...m.values()].indexOf(12) < 0, "");
  ok("no process, no link", !m.has("c"), "");
  ok("two procs, one cwd: one link each, newest first", linkByCwd([{ pid: 1, h: "pi", cwd: "/x" }, { pid: 2, h: "pi", cwd: "/x" }], [S("p", "/x", 1, 0), S("q", "/x", 2, 0)]).size === 2, "");
  console.log(bad ? bad + " failed" : "link: all checks passed"); process.exit(bad ? 1 : 0);
  ```
  (Semantics: sessions that already have a pid from registry/open-file linking are not candidates — the `taken` case.)
- [ ] **Step 2: Run — expect build failure.**
- [ ] **Step 3: Implement `linkByCwd`** — group candidate sessions (`pid === 0`, same harness) by cwd, newest first; give each process of that harness, in pid order, the next unlinked session of its cwd.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Wire it** in `procs.ts linkSessions()`: after registry and open-file linking, `for (const ad of HARNESSES) if (ad.liveCwd)` build `CwdProc[]` from `procs` with `p.h === ad.id` and `p.cwd`, call `linkByCwd`, set `s.pid = rootOf(pid).pid`, `s.status = "open"`.
- [ ] **Step 6: Steering and optional capabilities** — change the three/four adapters to `headless: (s, msg) => [..., s.id, msg]`, `resume: (s) => [..., s.id]`; `actions.ts` passes `s`; `trash()` warns "`<label>` sessions can't be moved to the trash" when `files` is absent and `input.ts` does not open the confirm then; `fullText()` also unions `ad.search(q)` results.
- [ ] **Step 7: `usageExact`** in `record.ts` next to `tokens()` — same token bookkeeping, `usd >= 0` adds `usd` to `a.cost`/`d.cost` instead of `price()`. Add to `harness.check.ts` an assertion that `usageExact(…, 0.5)` books exactly 0.5.
- [ ] **Step 8: Checks + regression** as in Task 1 Step 6; then commit `refactor(harness): steering gets the session; optional files/search; liveness by cwd; exact cost`.

---

### Task 3: pi adapter

**Files:**
- Create: `src/harness/pi.ts`
- Modify: `src/harness/index.ts` (register after `fx`), `src/model/procs.ts` (drop `"pi"` from `OTHER`), `src/harness/harness.check.ts` (samples), `README.md` (harness table row, `AGENTGLASS_PI`)

**Interfaces:**
- Consumes: `SessionSource` default, `liveCwd`, `usageExact`, `headless(s,…)`.
- Produces: `export const pi: HarnessAdapter`.

Field map (from the spec, pi-mono 0.87.1 `packages/coding-agent`):
- identity: `id "pi"`, `label "pi"`, `glyph "π"`, `mark "π"`, `color: () => C.cyan`, `bin "pi"`, `procs ["pi", "pi-rpc"]`.
- roots: `$PI_CODING_AGENT_SESSION_DIR` || `sessionDir` from `($PI_CODING_AGENT_DIR || ~/.pi/agent)/settings.json` || `<agentDir>/sessions`.
- scan: for each `--*--` subdir `*.jsonl`, and flat `*.jsonl` directly in a custom session dir; `id = f.slice(f.indexOf("_") + 1, -6)`; parent `""`.
- headBytes `262144` (first entry is a large system message).
- parse(o): by `o.type` — `session` → `s.cwd`; `session_info` → `s.title = name`; `model_change` → `s.model`; `message` by `message.role`: `user` (string or text blocks) → user; `assistant` → text/thinking/toolCall events (`id`, `name`, `JSON.stringify(arguments)` as full), `s.model = responseModel || model`, `stopReason` error/aborted → meta with `errorMessage`; `toolResult` → result (`id = toolCallId`, `[error] ` prefix when `isError`); `bashExecution` → tool `!bash` + result; `system`/`custom` → skip; `compaction` → meta `context compacted`; `branch_summary` → meta `branch: <summary first line>`; unknown types → nothing. `ts = o.timestamp`.
- busy(s): last message event decides: user/result → busy; assistant text is idle only when the raw `stopReason` was stop/length/error/aborted — keep the last stopReason on the session via a meta-free side map `lastStop: Map<path, string>` set in parse.
- liveCwd: `true`.
- headless: `(s, msg) => ["-p", "--session", s.path, "--", msg]`; resume: `(s) => ["--session", s.path]`.
- files: `(s) => [s.path]`.
- usage(a, line): pre-filter `"usage":{` / `"toolCall"` / `"toolCallId"`; header → remember `Date.parse(timestamp)` in `a.x[0]` and fork flag `a.x[1] = parentSession ? 1 : 0`; skip usage of entries older than `a.x[0]` when `a.x[1] === 1`; `usageExact(a, d, model, input, output, cacheRead, cacheWrite - (cacheWrite1h||0), cacheWrite1h||0, cost.total ?? -1)` for assistant usage, `type:"usage"`, `toolResult.usage`, compaction/branch_summary usage; toolCall → `tool()`+`pend()` (`bash` → program/command stats); toolResult → `done(p, isoMs(ts) - p.t, isError, len, id, [])`; edits: `edit` Σ`nlines(newText)`/Σ`nlines(oldText)` (legacy top-level oldText/newText), `write` → `nlines(content)`, `file(d, name, path, add, del)`.

- [ ] **Step 1: Add the golden sample** to `SAMPLES` in `harness.check.ts` from `fixtures/pi-*.jsonl` (header, user, assistant with toolCall + usage cost 0.01, toolResult, assistant `stop`, `session_info`) with expected kinds `"user tool result assistant"`, `tools: 1`, and a new sample field `cost: 0.01` (extend `Sample` with `cost: number`, set existing samples' `cost` to what they produce today — claude/codex priced via table, fx 0, kiro 0). Add a second pi sample: a forked file (`parentSession` set, one entry older than the header) → `cost` counts only the newer entry.
- [ ] **Step 2: Run `harness.check` — expect "unknown harness pi" failure.**
- [ ] **Step 3: Implement `src/harness/pi.ts`** per the field map; register it; remove `"pi"` from `OTHER`.
- [ ] **Step 4: Run all checks — pass.**
- [ ] **Step 5: Real session**: `./agentglass --json --harness pi` lists the Task 0 todo session with title, cwd, tools > 0, cost > 0; TUI: transcript follows while pi runs a prompt, the row is live (◆/spinner) while busy and idle after; `s` sends headless and the reply appears; `R` resumes.
- [ ] **Step 6: Commit** `feat(pi): pi coding agent harness adapter`.

---

### Task 4: OpenCode adapter (SQLite via `sqlite3` CLI; v2 + v1 schema)

**Files:**
- Create: `src/util/sqlite.ts`, `src/harness/opencode.ts`, `src/harness/opencode.check.ts`, `specs/pi-opencode-harnesses/fixtures/opencode.sql` (fixture DB schema + rows, built into a temp DB by the check)
- Modify: `src/harness/index.ts`, `src/model/procs.ts` (drop `"opencode"` from `OTHER`), `src/harness/harness.check.ts`, `README.md`

**Interfaces:**
- Consumes: `SessionSource`, `search?`, optional `files`, `liveRegistry`, `liveCwd`, `usageExact`, `spawnOf`.
- Produces:
  ```ts
  // src/util/sqlite.ts
  export function sqliteBin(): string;                                   // $AGENTGLASS_SQLITE3 || "sqlite3"; "" when not runnable (cached)
  export function query(db: string, sql: string): Obj[] | null;          // sqlite3 -readonly -json -cmd ".timeout 2000" db sql; null on error/timeout (3 s)
  export function q(s: string): string;                                  // SQL string literal: "'" + s.replace(/'/g, "''") + "'"
  export const opencode: HarnessAdapter;
  ```

Behavior:
- DB path: `$OPENCODE_DB` || `$XDG_DATA_HOME/opencode/opencode.db` || `~/.local/share/opencode/opencode.db`.
- scan: if `db` + `db-wal` mtime/size unchanged since the last scan, re-add the cached rows (no query). Else detect tables via `select name from sqlite_master where type='table'`; read `session_v2` (id, parent_id, directory, title, time_updated, time_suspended, time_archived) and, if present, v1 `session` (id, parent_id, directory, title, time_updated) for ids not in v2; plus per session the end cursor (`max(seq)+1` for v2; row count of `part` for v1). `add(db + "#" + id, id, parent_id ?? "", time_archived != null)`.
- source: `stat` from the cached scan row (`size` = end cursor, `mtime` = time_updated); `align` = identity; `lines(s, from, to)`: v2 → `select seq, type, data from session_message where session_id=… and seq >= from and seq < to order by seq` → each row as `JSON.stringify({type, seq, ...data})`, `next = last seq + 1`; v1 → parts joined with their message (`message.data` role/model/time, `part.data`) ordered by message time_created, part id, `limit to-from offset from`, each as `{"v1":true, role, part}`, `next = from + rows`. `unit: 2048`.
- parse: v2 types user/assistant(content text|reasoning|tool)/shell/compaction/idle → user/assistant/thinking/tool+result/meta ("turn complete" for `idle`); v1 parts text/reasoning/tool/step-finish → same kinds; tool call and result from the one `tool` part (`state.status` completed/error → result event after the call).
- busy: v2 row `time_suspended != null`; v1: last assistant without `time.completed` or a tool part pending/running.
- title: session `title`. spawnOf(s): the parent's tool call whose `state.metadata.sessionID` (v2) / `sessionId` (v1) equals `s.id`.
- liveRegistry: `~/.local/state/opencode/service.json` → daemon pid, alive → every session with `time_suspended != null` gets that pid (status "busy"); `liveCwd: true` covers v1 TUIs.
- headless `(s, msg) => ["run", "-s", s.id, msg]`, resume `(s) => ["-s", s.id]`; no `files` (no trash); `search(q)`: `… where data like '%' || q(term) || '%'` over `session_message` (+ v1 `part`), returns session paths.
- usage(a, line): assistant rows with `cost`/`tokens` → `usageExact(a, d, model, input, output, cache.read, cache.write, 0, cost)`; tool rows → tool/pend/done with `time` fields; never sum `step-finish` in addition to messages.
- No `sqlite3`: scan adds nothing and raises one `say("warn", "OpenCode sessions need the sqlite3 CLI")` per run.

- [ ] **Step 1: Write `opencode.check.ts`** — creates `/tmp/agentglass-oc-check/opencode.db` from `fixtures/opencode.sql` with the real `sqlite3`, points `OPENCODE_DB` at it, then asserts: one parent + one subagent session (parent linked, `spawnOf` = the subagent call id); duplicate id in v1+v2 appears once with the v2 title; `lines(s, 0, end)` yields the expected kinds `"user assistant tool result meta"`; reading `lines(s, 2, end)` after inserting a new row continues at the right seq; usage cost equals the fixture's assistant `cost` sum; `search("todo")` finds the parent; with `AGENTGLASS_SQLITE3=/bin/false` scan adds no session and returns within 500 ms.
- [ ] **Step 2: Run — expect build failure.**
- [ ] **Step 3: Implement `src/util/sqlite.ts`** (`execFileSync` with `timeout: 3000`, `maxBuffer: 64 MB`, stderr ignored; parse the JSON array; cache `sqliteBin()` result).
- [ ] **Step 4: Implement `src/harness/opencode.ts`** per the behavior list; register it after `pi`; drop `"opencode"` from `OTHER`.
- [ ] **Step 5: Run all checks — pass.** Add a `SAMPLES` entry is not possible (DB source) — the harness check must skip golden samples for adapters with a `source`; assert instead that `opencode.check.ts` exists (list it in the README's check command).
- [ ] **Step 6: Real session**: the Task 0 OpenCode todo session shows with its subagent nested, cost > 0, transcript follows a running prompt, busy while it runs, `s`/`R` work, `D` explains that OpenCode sessions can't be trashed, `F` full-text finds a word from the prompt.
- [ ] **Step 7: Commit** `feat(opencode): OpenCode 2.x/1.x harness adapter via sqlite3`.

---

### Task 5: Docs, final verification, merge

**Files:** `README.md`, `specs/pi-opencode-harnesses/spec.md` (status → implemented)

- [ ] **Step 1: README** — intro line and "Every agent, one screen" list pi and OpenCode; supported-harnesses rows (pi: `~/.pi/agent/sessions`, live by cwd, —, ✔; OpenCode: `opencode.db` (needs `sqlite3`), service.json / cwd, `parent_id`, ✔); `AGENTGLASS_PI`, `AGENTGLASS_OPENCODE`, `AGENTGLASS_SQLITE3`; remove pi/opencode from the "show up in the process view" sentence.
- [ ] **Step 2: Full verification** — all checks; `--json` regression vs `main` for claude/codex/fx; TUI walkthrough with tmux screenshots (capture-pane) of the Sessions list showing π and OpenCode rows, a pi transcript, the OpenCode subagent tree, the Stats "by harness" box with 5–6 rows.
- [ ] **Step 3: Whole-branch review** (superpowers:requesting-code-review), fix findings.
- [ ] **Step 4: Hand back** for the merge decision (superpowers:finishing-a-development-branch) — do not merge without the user's OK.
