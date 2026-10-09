# Debug episodes — spec

Status: **draft** (2026-10-09). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 3. Decisions under the user's
2026-10-05 delegation (see "Decisions").

## Goal
Show, for every harness agentglass reads, how coding agents debug code and whether they cleaned up after themselves:

1. **Leftover instrumentation.** Temporary debug logging an agent added to the user's code and never removed. Flagged
   per session, checked against the file on disk, raised as a built-in alert when the agent finishes a turn with
   probes still in place, and answerable by the agent itself (`agentglass debug --check`, MCP `debug`) before it ends.
2. **Debug episodes.** The loop *instrument → reproduce → read the evidence → fix → verify → clean up*, recognised
   from data every harness already writes: when it ran, how long, roughly what it cost, how many reproduce runs
   failed, how many fixes were tried and how many were reverted, whether a verify run passed.
3. **One harness-neutral, UI-agnostic core** (`src/features/debug/`) whose versioned plain-JSON view model
   (`DebugVM`) with `agentglass://` deep links feeds the TUI, the CLI, the MCP server, the rules engine (and through
   it `--watch` and the OTLP logs stream), and a later web UI without new model code.

## Why (user value)
- An agent that debugs by adding `console.log`/`print` lines, reproducing, reading the output and fixing is doing
  the right thing. Forgetting to remove those lines is a real failure: debug output in a shipped CLI, a log line
  that prints request bodies, a `debugger;` statement, a call to a local log endpoint that no longer exists. Review
  catches some; a busy user approving a large diff misses them. Nothing tells the user today.
- The measurements below show the loop is common (3.5 % of Claude Code sessions with edits, 18 % of Codex sessions
  with edits add debug prints and remove them again) and that cleanup is unreliable (9 of 12 sessions that added
  prints tagged as debug output never removed them; every such line still checkable on disk is still there).
- "How much of my agents' time and money goes into debugging loops, and which ones went in circles (many failing
  reproduce runs, reverted fixes)?" is a question agentglass cannot answer today, although every input is in the
  transcripts it already indexes.
- An agent can check itself: "did I leave instrumentation?" before it says it is done, through the CLI in agent mode
  or the MCP server, the same way it asks `contention` before a test run.

## Today (current code and data, measured)

### Code (`main` @ bda9190)
- **Events** are `Ev { kind, text, ts, id, full }` (`src/model/types.ts:4`); `full` holds the untruncated tool
  input. The transcript view reads the last 6 MB of a log (`src/ui/transcript.ts:107-138`); tail loads keep the last
  60 events of a 96 KB window (`src/model/sessions.ts:182-206`). Neither sees a whole long session.
- **The usage indexer reads every line once** (`HarnessAdapter.usage`, `src/harness/types.ts:79`) and books edits
  through `lines()` and `file()` (`src/features/usage/record.ts:254-260,280`). The edit text is in hand at each
  adapter's booking site, then dropped (only line counts survive):
  - Claude: `Edit` `old_string`/`new_string`, `MultiEdit` `edits[]`, `Write` `content`, `NotebookEdit` `new_source`
    (`src/harness/claude.ts:296-302`);
  - Codex: `apply_patch` (function and custom tool calls) and patches embedded as escaped string literals in the JS
    `exec` tool (`src/harness/codex.ts:279-291`), split by `patchFiles()` (`src/features/usage/calls.ts:187`) through
    `patchLines()` (`record.ts:423-425`);
  - Gemini CLI: `replace` `old_string`/`new_string`, `write_file` `content`; failed edits are skipped
    (`src/harness/gemini.ts:404-411`);
  - pi: `edit` `edits[]` `oldText`/`newText` (legacy top-level fields), `write` `content` (`src/harness/pi.ts:296-303`);
  - OpenCode: `edit` `oldString`/`newString`, `write`, `multiedit`, `apply_patch`/`patch` `patchText`
    (`src/harness/opencode.ts:354-360`); the HTTP transport yields the same parts;
  - Kiro: `fs_write`-style `create`/`strReplace`/`insert` with `content`/`newStr`/`oldStr`
    (`src/harness/kiro.ts:141-146`); calls are booked with time 0 and no ISO stamp (`kiro.ts:139`): **order only**;
  - fx: embedded `*** Begin Patch` or `content`/`new_string`/`old_string`/`edits` (`src/harness/fx.ts:96-98`).
- **Call rows** (`src/features/usage/rows.ts:15-19`): per call time, tool, model, duration, `err` (−1 none, 0 ok,
  1 failed), result bytes, harness call id `cid`, and ids of programs, command lines and changed files. Persisted
  per session in `cache/calls/<key>.json` (`FORMAT = 3`, `src/features/usage/callcache.ts:18`) for
  `filter.callDays` (default 90, `callcache.ts:34`); loaded lazily (tui-footprint §4). No edit text.
- **Command families** (agent-wait): `rowFam(r, i)` (`src/features/wait/family.ts:508`), `familyOf`/`callFamily`
  (`family.ts:419,441`), kinds `test typecheck lint build install …` (`family.ts:22,369`).
- **Per-hour cost** per day: `Day.hc` (`record.ts:23,307`), the basis for an episode's approximate cost.
- **Persisted per-session scrapes** have a precedent: git-linkage keeps `Acc.vcs` (`record.ts:63`), encoded as `v`
  in the ledger line (`src/features/usage/codec.ts:105,119`). Ledger `VERSION = 18` (`codec.ts:13`).
- **Keys** (`src/input.ts`): transcript mode binds `↑↓ j k ↵ → b space g G f t s R n N u esc q` (`input.ts:92-113`);
  features add `c` call graph (`src/features/callgraph/view.ts:358`), `V` git (`src/features/vcs/view.ts:186`),
  `r` related (`src/features/related/view.ts:309`), `P` replay (`src/features/replay.ts:55-62`), `Y` link
  (`src/features/palette/links.ts:25-30`), `T` theme (`src/features/themes.ts:101-104`). **`E` is unbound in every
  mode** (grep for `"E"` in `src/`: no hit). Feature views use `S.mode = "view"`, `S.fview`, and return from a
  transcript they opened through the `inTx` pattern (`related/view.ts:306-308`).
- **Links**: `canonicalUrl(s, akey, aval)` → `agentglass://open/<h>/<id>#call=<id>` (`src/features/palette/ref.ts:233`);
  `resolve(parseRef(link))` + `applyTarget()` open a transcript at that call (`src/features/palette/apply.ts:15-30`).
- **List badges**: a 2-cell slot fed by `H.rowBadges` (`src/hooks.ts:40`, `src/ui/list.ts:88-93`): `⚠`/`◆` from
  the watchdog (`src/features/watchdog.ts:163`), herdr `✓` (`src/mux/attr.ts:35`). Preview lines via
  `H.previewSections` (`watchdog.ts:167`, `vcs/view.ts:108`).
- **Filter attributes** are registered in `src/features/query/attrs.ts:60-106` (`family`, `kind` from agent-wait at
  `attrs.ts:98-99`) and evaluated in `src/features/query/eval.ts` (session keys near `eval.ts:92`).
- **Rules**: metric catalogue `METRICS` (`src/features/rules/config.ts:21`), built-ins `builtins()`
  (`config.ts:169-178`; `contention` is the opt-in precedent, `config.ts:180-181`), session metrics `sessMetric`
  (`src/features/rules/metrics.ts:30-34`), evaluated for live sessions on the watch tick (`watchdog.ts:107-131`).
  Fired alerts already reach `--watch` as `kind: "alert"` lines (`src/features/cli.ts:336-341`) and the OTLP logs
  stream (`src/features/otlp/logs.ts`).
- **MCP**: 11 read-only tools, one CLI child each (`src/mcp/tools.ts:75-117`), goldens
  `testdata/mcp/tools-2025-11-25.json`, `tools-2024-11-05.json`; contract `CONTRACT = 1`
  (`src/features/version.ts:55`, `src/mcp/rpc.ts:11`), `docs/cli-contract.md`.
- **Redaction**: file paths shown through `display("file", …)` are faked under `--redact`
  (`src/features/redact.ts:321-330,544`); `realCwd()` gives the real cwd for disk access (`redact.ts:545`).
- Nothing in agentglass recognises debug instrumentation, debug loops or leftovers.

### Measured on this machine (2026-10-09, read-only, niced; aggregates only)
A standalone read-only script parsed the edit payloads and shell commands of local Claude Code and Codex transcripts
in file order (the two harnesses with substantial history here; Gemini, pi, OpenCode, Kiro and fx hold too little to
measure). No agentglass state, cache or config was read or written. "Debug print" = an added line matching the
print/log pattern list of §2.2.

| | Claude Code | Codex |
|---|---|---|
| sessions / sessions with file edits | 4,561 / 800 | 392 / 99 |
| sessions using an explicit marker (§2.1) | 1 | 1 |
| … of which still had the marker at session end | 1 | 1 |
| sessions adding debug prints | 234 (29 % of edit sessions) | 30 (30 %) |
| sessions that added debug prints **and removed the same lines again** (temporary instrumentation) | 28 (3.5 %) | 18 (18 %) |
| … of those, re-running one command family ≥ 2× after the first probe (the loop shape) | 28 (all) | 18 (all) |
| … of those, ending with more matching prints than removed in a file they cleaned (ambiguous) | 18 | 13 |
| sessions adding prints that say they are debug output (`debug`, `DEBUG`, `DBG`, `temp`, `>>>`) | 6 | 6 |
| … never removed in the session | 5 | 4 |
| … such lines still checkable on disk today / still present | 3 / 3 | 1 / 1 |

What this means for the design:
- **Explicit markers are almost unused today** (2 sessions). A leftover detector based only on them is precise but
  catches little until users adopt a convention → agentglass documents one and prints it (`debug --instructions`).
- **Paired prints are a strong, self-confirming episode signal**: a line added and later removed verbatim by the same
  session was temporary by definition, and every such session also shows the reproduce loop.
- **Unpaired prints are ambiguous**: 31 of 46 sessions that cleaned some prints left others that may be real output.
  Treating them as leftovers would be noisy → heuristic leftovers stay opt-in.
- **Disk verification matters**: every "debug" print left unremoved that could be checked is still in the code.

## Design

### 1. Vocabulary
- **Probe**: one instrumentation line an agent added: either a line carrying an **explicit marker** (§2.1) or a
  **debug print** (§2.2). A probe is *open* while the session has not removed it.
- **Episode**: a span of one session from its first probe to the cleanup (and the verify run after it), with the
  runs, reads, fixes and reverts inside (§5).
- **Step**: one entry of an episode's timeline. Its kind is one of the shared event kinds of §6.1: `debug:probe`
  (`change` add/remove), `debug:repro`, `debug:verify`, `debug:run`, `debug:read`, `debug:fix`, `debug:revert`,
  `debug:restore`. The episode itself is the span kind `debug:episode`.
- **Leftover**: an explicit-marker probe a session left open when its turn or session ended, **and** that is still in
  the file on disk (§4). Unverifiable ones are `unverified`, never alerts.

### 2. Markers

#### 2.1 Explicit markers (default)
A line is an explicit probe when it contains one of these literals, compared case-insensitively:

| marker | why |
|---|---|
| `agentglass:debug` | agentglass's own convention, documented in the README and printed by `agentglass debug --instructions` for AGENTS.md / CLAUDE.md / GEMINI.md |
| `#region debug` | the editor region convention (C#, TypeScript, Python and many editors fold on it); covers `// #region debug …` and `#Region Debug` |
| `DEBUG-TEMP`, `TEMP-DEBUG` (also with `_` or a space) | common "remove me" tags |

Users add their own with `debug.markers` (array of strings, each 4–64 characters, no newline; invalid entries are
dropped with one startup toast, as other config keys). A region's closing line (`#endregion`) is not a probe; the
opening line is the one that counts.

Matching is a substring test per added/removed line. Prefilter: the edit's added and removed texts are searched
with `indexOf` for `debug`/`Debug`/`DEBUG`/`temp`/`TEMP` and each user marker's literal before any line is
lowercased; texts without a hit cost one scan.

#### 2.2 Debug prints (paired by default, unpaired opt-in)
Debug prints are lines matching one of these literal fragments (one table, `markers.ts`; scriptc C backend: no
`Record<string, RegExp>`, so literals plus one compiled alternation):
`console.log(` `console.debug(` `console.error(` `console.warn(` `console.trace(` `debugger;` `print(` `pprint(`
`breakpoint()` `pdb.set_trace(` `ipdb.set_trace(` `dbg!(` `println!(` `eprintln!(` `fmt.Print` `fmt.Fprint`
`log.Print` `spew.Dump(` `var_dump(` `print_r(` `error_log(` `dd(` `System.out.print` `System.err.print`
`printf(` `fprintf(stderr` `std::cerr` `binding.pry` `Console.WriteLine(` `logger.debug(` `log.debug(`
`slog.Debug(`.

- **Paired (always on):** a debug-print line the session added and later removed with the same trimmed text in
  the same file becomes a probe pair (`probe+` at the add, `probe-` at the removal). It opens/extends an episode.
  It is never a leftover (it was removed).
- **Unpaired (opt-in `debug.heuristics: true`):** debug-print lines still open at the end count as `print` probes
  in state `possible`. They appear in the panel, `agentglass debug` and the MCP tool, never in the alert rule, the
  list badge or `debug is leftover`.
- Bookkeeping: each added debug-print line is remembered as a 32-bit FNV hash of `file + "\t" + trimmed line` with
  its call id and time (`Acc.dh`, ≤ 128 entries, oldest dropped). A removed line whose hash is present pairs and
  frees the entry. Explicit-marker lines are never also counted as prints.

### 3. Capture at index time (all sessions, all history)

#### 3.1 Adapter port
`HarnessAdapter` (`src/harness/types.ts:78-84`) gains one optional member in its usage section:

```ts
// the text an edit tool call adds and removes, per file; whole = added is the file's complete new content
// (a write/create: removals are unknown); [] = not an edit. Pure: no I/O, no Acc.
editText?: (name: string, inp: Obj | null, raw: string) => EditText[];
// src/harness/types.ts
export interface EditText { path: string; added: string; removed: string; whole: boolean; gone: boolean } // gone = file deleted
```

`common.ts` gets `editTextOf(name, inp, raw)`, the default every adapter uses unless it overrides:
`old_string`/`new_string`, `oldString`/`newString`, `oldStr`/`newStr`, `oldText`/`newText`, `edits[]` of any of
these, `content` (whole), `new_source` (cell, not whole), and patch text in `patchText`/`patch`/`input`/a raw
string (`*** Begin Patch` … `*** End Patch`: `+` lines added, `-` lines removed per file, `*** Add File` whole,
`*** Delete File` gone) via a new `patchTexts(patch)` beside `patchFiles()` (`calls.ts:187`).

Each adapter calls it **at the site where it already books `file()`**, with the same name and input, and hands the
result to `edits(a, d, cid, t, list)` (new, `record.ts`), which forwards to a tap `EDITS.tap` (a no-op unless the
debug feature is linked; same pattern as `CMDS`, `calls.ts:122`). Line counting (`nlines`, `lines()`, `file()`)
stays untouched, so every existing number is identical.

| harness | edit shapes (`editText`) | whole / gone | shell + outcome (call rows) | time | limits · verification items |
|---|---|---|---|---|---|
| Claude Code | default (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) | `Write` whole | `Bash` + result, `err` | per message | best case |
| Codex | override: `apply_patch` input, and every `*** Begin Patch` literal in a JS `exec` input unescaped (`\\n` → newline, `\\"`, `\\\\`), as `codex.ts:286-291` does for counts | `Add File` whole, `Delete File` gone | `exec_command`/`shell` + exit codes | per item | patches inside `exec` strings: unescape golden must cover quotes and backslashes |
| Gemini CLI | default (`replace`, `write_file`) | `write_file` whole | `run_shell_command`, exit from the output trailer | per message | failed edits are skipped (as today) |
| pi | default (`edit` `edits[]`/legacy, `write`) | `write` whole | `bash` | per message | — |
| OpenCode | default (`edit`, `write`, `multiedit`, `apply_patch`/`patch` `patchText`) | `write` whole | `bash`/`shell` parts | per part | HTTP transport parts identical (check both fixtures) |
| Kiro | override: `command` `create` → whole, `strReplace` → `oldStr`/`newStr`, `insert` → `newStr` | `create` whole | `execute_bash`/`shell`, status only | **none** | order only: episode times, wall time and cost are `null`; verify `command` field names on a real log (open question 2) |
| fx | override: embedded patch first, else default | `content` whole | `shell` | per event | `edits[]` element shape unverified (open question 3) |

Shell edits (`sed -i`, `perl -pi`, heredocs, `git apply`) are not parsed: they are invisible to probe tracking, and
§4's disk check is what keeps state honest. Shell commands that may restore files — `git checkout -- …`,
`git restore`, `git stash` (not `list`/`show`), `git reset --hard`, `git apply -R` — are recorded as `restore`
steps (recorded by a second tap on the shell-command path, `pend()`, `record.ts:220-235`, as a `DEv` with
`k = -4`) and mark the session's open probes as *maybe removed*
until §4 checks them.

#### 3.2 What the tap stores (`src/features/debug/capture.ts`)
Per session, in `Acc` (persisted in the ledger line; empty for sessions without debug activity, which are > 95 %):

```ts
// one probe stream entry: t = epoch ms (0 = unknown: Kiro), cid = harness call id ("" none), f = path as the agent
// wrote it, k = marker index into the marker table (0..), or -1 = paired print, -2 = revert, -3 = possible print
// (heuristics on), -4 = restore mark (d = 0), d = change: +n added, -n removed, or for a whole write the absolute count encoded as 1000000 + n
interface DEv { t: number; cid: string; f: string; k: number; d: number }
Acc.de: DEv[];                 // ≤ 256, oldest dropped (folds below keep the totals)
Acc.dp: DProbe[];              // fold per (f, k): ≤ 64, closed entries dropped first
interface DProbe { f: string; k: number; open: number; added: number; removed: number; t0: number; c0: string /* first add */; t1: number; c1: string /* last change */ }
Acc.dh: number[];              // paired-print bookkeeping: [hash, t] pairs, ≤ 128 entries (§2.2)
Acc.dhc: string[];             // the call id of each dh entry, same order
Acc.dr: number[];              // revert bookkeeping: hashes of the last 64 non-probe edit blocks' added text
```

- **Explicit markers:** per edited file, `count(added) − count(removed)` per marker; a whole write sets the file's
  count to `count(added)`; `gone` sets it to 0. Clamped at 0 (removing a marker the session did not add is
  recorded as `probe-` but never makes `open` negative).
- **Reverts** (for the episode's `reverted` count and `revert` steps): each non-probe edit block's added text,
  normalised (trimmed lines joined by `\n`, ≥ 1 non-blank line), is hashed into `Acc.dr`; a later edit whose
  removed text normalises to a hash in `Acc.dr` is a revert (`k = -2`) and frees the entry.
- Cost: one `indexOf` prefilter per edit text; edits are a small share of lines. No allocation for texts without a
  hit.
- **Cache:** `VERSION` bumps once (to the next free number at implementation time; 18 today), keys `de`, `dp`,
  `dh`, `dhc`, `dr` in the acc line. Old caches re-index once (the indexing gauge shows it; tui-footprint measured ~8 min in
  the background on the largest history here). If another spec bumps in the same release, they share one bump.
- Subagents keep their own streams (`Acc` per log); the parent's views include its subagents (§6).

### 4. Disk verification (`src/features/debug/verify.ts`)
For each open explicit probe (and `possible` prints with heuristics on): resolve the path (absolute, else joined
with the session's **real** cwd, `realCwd()`), then:

| outcome | rule |
|---|---|
| `present` | the file exists, ≤ 4 MiB, and contains the marker on a line (first matching line number kept) |
| `removed` | the file exists and does not contain it (another session, a shell edit, a git restore cleaned it) |
| `gone` | the file does not exist |
| `unverified` | no cwd, remote (fleet/hub) row, file > 4 MiB, unreadable, or a path outside the session's project root and `$HOME` |

- Results are cached per path by `(size, mtime)`; a check re-stats at most once per 60 s per path and reads only
  when `(size, mtime)` changed. Reads are capped (`readText(p, 0, 4 MiB)`), never follow into directories, never
  write.
- Triggers: the session's ledger entry changed (new probe events), a `restore` step, the 60 s sweep over sessions
  with open probes (stat only, ≤ 64 paths per sweep, round robin), and on demand (CLI, MCP, panel open). Sessions
  without open probes cost nothing.
- Line text is read only to find the line number; it leaves the module only with `--content` (§7, §10).

### 5. Episode model (`src/features/debug/model.ts`, pure)
`detect(de: DEv[], rows: Rows | null, fold: DProbe[], disk: DiskState[], cfg: DebugCfg, live: boolean, lastAt: number, now: number, h: string, id: string): Episode[]`
— no I/O, no `S`/`H` state, deterministic, no LLM.

```ts
export interface Step { seq: number; t: number /* 0 unknown */; cid: string; kind: string /* debug:probe debug:repro debug:verify debug:run debug:read debug:fix debug:revert debug:restore */;
  change: string /* debug:probe: "add" | "remove"; else "" */; file: string; family: string; cmd: string; ok: number /* 1 ok, 0 failed, -1 unknown */ }
export interface Episode {
  key: string;            // stable: "<harness>:<session id>#<cid of first step>" (or "#s<seq>" without a cid)
  t0: number; t1: number; // epoch ms, 0 unknown (Kiro)
  state: string;          // "open" | "closed" | "leftover"
  outcome: string;        // "verified" | "failed" | "unknown"
  steps: Step[];          // ≤ 200 per episode, then "… n more" (counts stay exact)
  probesAdded: number; probesRemoved: number; probesOpen: number;
  runs: number; runsFailed: number; fixes: number; reverted: number; reads: number;
  evidence: string[];     // files read as evidence (§5.3), ≤ 8
}
```

#### 5.1 Boundaries
- An episode **opens** at a `probe+` (explicit, paired print, or possible print with heuristics on) when no episode
  is open, or when the previous one closed more than `debug.idleMin` (default 30) minutes earlier; otherwise the
  previous one reopens (re-instrumentation).
- It **closes** when the session's open probe count (explicit + paired) returns to 0; its end extends to the last
  `verify` run (§5.2) within `debug.idleMin` after that.
- With probes still open: `open` while the session is live and not past `debug.idleMin` of silence; then
  `leftover` if any of its explicit probes is `present` on disk, else `closed` (cleaned elsewhere) — `unverified`
  probes keep it `open` with `outcome: "unknown"`.
- Kiro (`t = 0` everywhere): order by call-row index (rows matched to events by `cid`), one episode per contiguous
  probe span; `t0`/`t1`, wall time and cost `null`.

#### 5.2 Steps from the call rows (no transcript read)
Call rows inside `[t0, t1]` (by row index for Kiro), joined with the probe stream by `cid`:
- `fix`: a row that changed a file (`KIND_FILE`) and is not a probe or revert event.
- `debug:repro` / `debug:verify` / `debug:run`: a shell row. It is `debug:repro` when its family (`rowFam`, agent-wait) occurs ≥ 2× in the episode or its kind is
  `test`, and it lies before the last probe removal/fix; `debug:verify` when the same family runs after the last fix or
  probe removal. `ok` from `err`. Other shell rows are `debug:run`, listed but collapsed in views (`… 6 other commands`).
- `read`: a read-tool row or a shell row whose program is `cat tail head less jq grep rg` on a file ending in
  `.log`, `.ndjson`, `.jsonl` or with `debug`/`trace` in its basename. These files are the episode's `evidence`
  (§5.3).
- `restore`: §3.1.
- `outcome`: the last `verify` run ok → `verified`; failed → `failed`; none → `unknown`.
- Rows exist for `filter.callDays` (90) days; older episodes keep their probe steps and counts with
  `runs = null` in the view model (unknown, not 0).

#### 5.3 Evidence from structured logs (MVP: names only)
The MVP lists which log files an episode read (path, number of reads, link to the first read). It never reads them.
The evidence lane that shows their entries next to the steps is phase 2 (§13.1).

#### 5.4 Cost and time
- `wallMs = t1 − t0`; `null` when unknown.
- `costUsd`: the session's `Day.hc` per-hour cost, prorated by the episode's overlap with each hour; marked
  `costApprox: true` and labelled with the session's billing mode (honest-costs). `null` for Kiro and when the
  session has no priced usage in those hours.

### 6. Query layer and view-model contract (`src/features/debug/query.ts`)
The only module front ends call. It loads what it needs lazily (`accOf`, `callsOf`, verify), runs `detect`, and
returns plain JSON — no ANSI, no widths, no glyph-only meaning, stable keys, ISO times plus epoch ms, every entity
with an `agentglass://` link.

```ts
export function debugOf(s: Sess, o: DebugOpts): Obj;                         // one session (+ its subagents): DebugVM
export function debugList(sel: Sess[], o: DebugOpts): Obj[];                 // one row per session with debug activity
export function debugFacts(s: Sess): DebugFacts;                             // cheap, no rows: for filters, badge, rules
export interface DebugOpts { content: boolean; subagents: boolean; now: number }
export interface DebugFacts { episodes: number; open: number; leftover: number; unverified: number; possible: number; lastAt: number }
```

`DebugVM` (one session), the contract every consumer reads:

```json
{
  "contract": 1,
  "session": { "id": "…", "harness": "claude", "title": "…", "live": false, "link": "agentglass://open/claude/…" },
  "summary": { "episodes": 2, "open": 1, "leftover": 1, "unverified": 0, "possible": 0, "reverted": 1, "wallMs": 1980000, "costUsd": 1.4, "costApprox": true, "billing": "plan" },
  "episodes": [{
    "key": "claude:…#toolu_01", "state": "closed", "outcome": "verified",
    "from": "2026-10-09T12:04:31.000Z", "to": "2026-10-09T12:31:02.000Z", "fromMs": 0, "toMs": 0, "wallMs": 1591000,
    "costUsd": 1.1, "costApprox": true, "billing": "plan",
    "probes": { "added": 2, "removed": 2, "open": 0 },
    "runs": { "total": 9, "failed": 7, "repro": 8, "verify": 1 }, "fixes": 3, "reverted": 1, "reads": 2,
    "evidence": [{ "file": "tmp/debug.ndjson", "reads": 2, "link": "agentglass://open/claude/…#call=toolu_05" }],
    "steps": [{ "seq": 0, "at": "2026-10-09T12:04:31.000Z", "atMs": 0, "kind": "debug:probe", "change": "add", "file": "src/auth.ts", "family": "", "command": "", "ok": null, "marker": "agentglass:debug", "count": 2, "link": "…#call=toolu_01" }],
    "stepsTruncated": 0,
    "link": "agentglass://open/claude/…#call=toolu_01"
  }],
  "probes": [{ "file": "src/session.ts", "marker": "agentglass:debug", "kind": "explicit", "open": 1, "added": 1, "removed": 0, "disk": "present", "line": 88, "addedAt": "…", "link": "…#call=toolu_31" }],
  "truncated": []
}
```

Rules of the contract:
- It lives under the CLI contract (`contract: 1`, `docs/cli-contract.md` §"`agentglass debug`"): additive changes
  keep the number (new field, new enum value), renames/removals/meaning changes bump it. One golden JSON
  (`testdata/debug/vm.golden.json`) pins key order and types.
- Enumerations are spelled out (`kind`, `tag`, `state`, `outcome`, `disk`); the TUI maps them to glyphs.
- Unknown is `null`, never `0` (times, wall, cost, `runs` beyond `filter.callDays`).
- `text` (the line on disk) appears in `probes[]` only with `content: true`.
- Paths are shown as the agent wrote them (relative stays relative), passed through `display("file", …)` so
  `--redact` fakes them.
- A web UI maps `agentglass://open/<h>/<id>#call=<cid>` to its own route 1:1 and serves the same JSON; no new model
  code is needed (§13.5).

### 6.1 Shared marks and event kinds (with skill-usage)
Episodes and steps are not a debug-only timeline. They are registered on the shared, harness-neutral marks layer that
the skill-usage spec defines (`src/model/marks.ts`). That layer is also the event-kind filter mechanism for every
timeline and event view: kind chips, presets, filter-language integration, gap markers in place of hidden events,
and deep links that carry the filter.

- **Provider:** `registerMarks({ kind: "debug", glyph, color, of, gen })`. `of(s)` returns one span mark per episode
  (`kind "debug:episode"`, `t0`/`t1`, `t1 = -1` while open, `sub` = state, `usd` = episode cost with `est: true`,
  `tok 0`, `ref` = episode key). It also returns one point mark per step (`kind` = the step kind above, `sub` =
  `change` or `ok`/`failed`, `ref` = `<episode key>/<seq>`). `gen(s)` changes when the disk state of an open probe
  changes, so memoisation by `(s.id, s.size, gen)` stays correct when another session cleans up.
- **Anchors and order:** each mark carries `anchor` (`call=<cid>`, else `ts=<iso>`), so drill-down and links use
  `canonicalUrl`/`applyTarget`. It also carries `seq` for Kiro, where `t0 = 0` means unknown. Both are
  coordinated additions to the marks shape, requested from skill-usage on 2026-10-09.
- **Kind namespace:** `<family>:<name>`. The family `debug` is one chip group, and each name can be toggled alone,
  so the same filter shows "only debug", "only `debug:repro`", or "everything except debug" in the transcript,
  the call graph, replay, related events and the episode panel.
- `DebugVM.steps[].kind` uses the same strings: one taxonomy for the TUI, JSON, MCP and filters. The filter attribute
  for event kinds is owned by the shared layer; debug registers values and adds no attribute of its own for steps.
  The session attributes of §8.3 stay.
- `marksOf` is lazy: no marks are computed until a view or a filter asks (budgets of §8.4).

### 7. CLI: `agentglass debug`
```
agentglass debug [<ref>] [--since 7d] [--leftover] [--check] [--content] [--subagents]
                 [--all-projects] [--format table|json|csv] [--json] [--fields …] [--limit N]
agentglass debug --instructions
```
- **No ref**: a list of sessions in scope with debug activity since `--since` (default `7d`): `session, harness,
  title, episodes, open, leftover, possible, lastAt, wallMs, costUsd, link`, newest first. `--leftover` keeps rows
  with `leftover > 0` and adds their `leftovers: [{file, line, marker, link}]`.
- **With a ref** (`current`, `last`, `parent`, id prefix, `harness:id` — `sessref.ts`): that session's `DebugVM`
  (json) or the text panel (table).
- **`--check`** (agent-facing, like `wait --check`): ref defaults to `current`; exit **3** when the session (with its
  subagents) has a leftover, printing each `file:line marker`; exit 0 otherwise; `unverified` probes are listed as a
  warning on stderr, exit 0.
- **`--instructions`**: prints a 6-line paragraph to paste into AGENTS.md / CLAUDE.md / GEMINI.md: mark temporary
  debug logging with `agentglass:debug` (or a `#region debug` block), remove it before finishing, run
  `agentglass debug --check` (or the MCP `debug` tool) as the last step.
- Agent mode (cli-agent-mode): JSON by default, project scope, `--all-projects` widens it.
- Text output fits 80 columns; errors through `cliError` with a hint; `--help --format json` lists every field
  (contract test).
- Runs the blocking `complete()` path for the sessions it lists (as `--json`), then verification for their open
  probes only.

### 8. TUI

#### 8.1 Episode panel (`E` in transcript mode)
`E` (free in every mode; `e` is detail-mode "open in editor") opens the panel for the transcript's session (with its
subagents) as a feature view (`S.mode = "view"`, `S.fview = "debug"`). Also from the Sessions list (`E` on a row)
and the palette ("Debug episodes"). With no debug activity: a one-line message
`no debug episodes in this session — markers: agentglass:debug, #region debug (agentglass debug --instructions)`.

At 80 columns, one line per step (time · kind · target · detail), episodes as headers:

```
 Debug  fix login redirect loop · Claude · 2 episodes · 1 leftover
 #1 12:04–12:31 27m ≈$1.10 plan · 9 runs 7✗ · 3 fixes 1↺ · verified
  12:04:31 probe+  src/auth.ts               agentglass:debug ×2
  12:05:02 run     pnpm test auth            ✗ repro
  12:06:40 read    tmp/debug.ndjson
  12:09:10 fix     src/auth.ts
  12:11:00 revert  src/auth.ts
           … 6 other commands
  12:20:44 probe−  src/auth.ts               ×2
  12:21:30 run     pnpm test auth            ✓ verify
 #2 14:02– open · 1 probe left
  14:02:10 probe+  src/session.ts:88         agentglass:debug  ⚑ on disk
 j/k step  ]/[ episode  ↵ event  r related  y link  esc back           ? keys
```
- `↵` applies the step's link (`resolve` + `applyTarget`, the same path as `agentglass open`): the transcript opens
  at that call; `esc` there returns to the panel (`inTx` pattern). `r` opens related events at that step; `y` copies
  the step's link; `]`/`[` jump between episodes; `g`/`G` top/end.
- Glyphs carry no meaning alone: `✗`/`✓` sit next to `repro`/`verify`, `⚑` next to "on disk", `↺` next to
  "fixes". Widths ≥ 100 add the call duration column and the full command.
- Help (`?`): section "debug" with the keys and the marker list. Footer hint in transcript mode: `E debug` (tier 2:
  hidden first when narrow).

#### 8.2 Sessions list and preview
- Badge `⚑` (yellow) in the row-badge slot for a session with a leftover (`debugFacts().leftover > 0`); registered
  after the watchdog and herdr badges, so `◆⚑`/`⚠⚑` fit the 2-cell slot.
- Preview line (`H.previewSections`): `debug  2 episodes · 27m · 1 probe left: src/session.ts:88`; dim
  `1 unverified` / `2 possible prints` when present.

#### 8.3 Filter attributes (filter-language)
| key | entity | type | values |
|---|---|---|---|
| `debug` | session | enum, multi | `episode` (≥ 1 episode), `open`, `leftover`, `unverified`, `possible`, `clean` (had probes, none open) |
| `debug.episodes` | session | num | episodes |
| `debug.probes` | session | num | open explicit + paired probes |

`/ debug is leftover` lists every session with a leftover; `debug is episode and cost > 5` finds expensive debugging.
Evaluation reads `debugFacts` (no call rows); verification runs only for sessions with open probes.

#### 8.4 Footprint (tui-footprint, agent-wait budgets)
- Capture runs inside the existing indexer pass (no new reads); idle TUI: **0 added work per tick**; the 60 s
  verify sweep touches only sessions with open probes (stat only).
- Episodes are computed **lazily**: only when the panel, the CLI, the MCP tool or a filter on `debug.episodes`
  asks; call rows load through the existing lazy path; results are memoised per `(session, ledger generation)`.
- Budgets: RSS + ≤ 1 MB for 10,000 sessions (most `Acc.de/dp/dh/dr` empty); cold full index CPU + ≤ 2 %; panel open
  on a 2,000-call session ≤ 50 ms; footprint run (`scripts/footprint.sh`) idle CPU and RSS within noise of `main`.

### 9. Rules: built-in `leftover`
- New session metric `leftover_probes` (unit `count`): the number of the session's explicit probes that are open
  and `present` on disk; **absent while the session is busy** (mid-turn), so it is judged when a turn finishes.
- New built-in rule, **enabled**: `{"id": "leftover", "metric": "leftover_probes", "op": ">=", "degraded": 1,
  "ack": "look", "notify": false, "message": "{value} debug probe(s) left in {file}"}` (placeholder `{file}`: the
  first file, `+n` more). Disable with `{"rules": [{"id": "leftover", "enabled": false}]}`.
- It fires once per turn end (engine state), shows `◆` and the alert text, and reaches `--watch` (`kind: "alert"`)
  and the OTLP logs stream like every alert.

### 10. MCP: `debug` tool
Consistent with specs/mcp-server (read-only, one CLI child, project scope, `--redact`, content opt-in, 24 KB cap,
cursor):

| input | meaning |
|---|---|
| `ref` | default `current` (the calling session); `last`, `parent`, id |
| `leftover` | bool: without `ref`, list this project's sessions with leftovers (rows envelope) |
| `since` | for the list form, default `7d` |
| `limit`, `cursor` | list form |

- Description: "Did this session leave temporary debug logging in the code? Debug loops (probes, reproduce runs,
  fixes, verify) with time and cost. Call before you finish."
- Child: `agentglass debug [<ref>] --format json` (object) or `debug --leftover --since … --limit …` (list).
- Without `--content`: `probes[].text` and `leftovers[].text` stripped (never requested). Commands and paths are
  activity metadata and stay (mcp-server §8).
- Size cap trims `steps`, then `episodes`, then `probes` from the end, `truncated` names them.
- Goldens `testdata/mcp/tools-*.json` gain the tool; `docs/cli-contract.md` lists it (additive, contract stays 1).

### 11. Configuration (`~/.agentglass/config.json`, section `debug`)
| key | default | meaning |
|---|---|---|
| `debug.markers` | `[]` | extra explicit markers (§2.1) |
| `debug.heuristics` | `false` | unpaired debug prints count as `possible` probes (§2.2) |
| `debug.idleMin` | `30` | minutes of silence that end an open episode / separate two (5–240) |

Invalid values fall back to the default with one startup toast (`intSetting`, `src/util/config.ts:80`).

### 12. Errors and edge cases
- A probe in a file the session later deletes (`gone`) is closed, not a leftover.
- The same file edited by two sessions: each session's fold is its own; disk verification resolves the truth; a
  probe another session removed shows `removed` and the episode closes.
- Paths outside the project and `$HOME` (`/etc/…`): never read, `unverified`.
- A `git stash` that later pops probes back: the next sweep sees `present` again (state follows the disk).
- Subagent adds, parent removes: the parent view merges subagents' streams in time order before folding; standalone
  subagent views can show a probe open that the parent removed — disk verification marks it `removed`.
- Marker inside a string literal or documentation (README explaining the convention): counted. Mitigation: markdown
  files (`.md`, `.mdx`, `.rst`, `.txt`) are skipped for explicit markers.

### 13. Out of the MVP but specified (phase 2)
Specified here, not in the plan; each needs its own small plan after the MVP ships.

#### 13.1 Evidence lane
In the panel, `Tab` toggles the entries of the episode's evidence files (§5.3), aligned by timestamp with the run
that produced them, grouped by one field the user names (`debug.groupBy`, e.g. `run` or `level`) when present. Read only on open,
only files named in the session's own transcript (never discovered by scanning), windowed (≤ 4 MiB per read,
tui-footprint window budget), NDJSON/JSONL only, unknown fields opaque, malformed lines skipped and counted.
Content only with `--content` in CLI/MCP; `--redact` replaces values.

#### 13.2 Timeline
MCP `timeline` tool (`ref`, `from` = event index or `call=`/`turn=` anchor, `limit`, `kinds`): a session's events by
cursor; text only with `--content`. Call graph: episodes as a thin band above turns (a new `Span` kind).

#### 13.3 Fix churn in triage and Stats
`reverted` and `runsFailed` as triage dimensions (does churn go with a model, a project, a harness?); Stats gets a
"debugging" share (time and cost inside episodes per day/project/harness).

#### 13.4 Stream events
`--watch` lines `kind: "debug"` on episode open/close and OTLP log records `agentglass.debug.episode` next to
`turn.open` and alerts (otlp-complete's logs stream).

#### 13.5 Web UI readiness (guaranteed by the MVP, not built)
`DebugVM` is the web API: versioned, golden-pinned, links on every entity, no TUI formatting. Live updates come from
the `--watch` JSON line stream (relayable as SSE). A future `agentglass serve --ui` adds read-only `GET` routes that
call `debugOf`/`debugList`, with the hub's serving rules (loopback default, token, TLS when public).

## Failure modes
| failure | effect | handling |
|---|---|---|
| adapter shape change (field renamed) | edits invisible to capture | per-harness goldens in `harness.check.ts` and the debug capture check fail; counts unaffected |
| marker in docs or strings | false explicit probe | markdown skipped; disk check; per-rule disable; `debug.markers` users choose their literals |
| unpaired prints | noisy leftovers | opt-in only, never alerts |
| shell-edited probe removal | stale `open` | disk verification every 60 s while open |
| huge files / binary | slow verification | 4 MiB cap → `unverified` |
| path escapes project (`../../etc/passwd` in a transcript) | reading unrelated files | only under the project root or `$HOME`, regular files, no symlink to outside (realpath check where scriptc allows, else `lstat`) |
| call rows pruned (> 90 days) | no runs | `runs: null`, shown "runs unknown (older than 90 days)" |
| Kiro without timestamps | no time, cost | `null`, panel shows `—`, order by row |
| `VERSION` bump | one background re-index | the indexing gauge; shared bump with any spec in the same release |
| cap overflow (256 events) | oldest steps missing | folds keep exact totals; panel shows "… older steps not kept" |

## Privacy
- Stored: paths, marker index, counts, call ids, times, 32-bit hashes. **No edit text, no log content, no line
  text** is stored in the ledger.
- Read on demand: the files named by open probes (to find the marker line), within the project root or `$HOME`,
  capped; nothing is written. Evidence files: phase 2, only with explicit open, only those named in the transcript.
- Output: line text only with `--content` (CLI, MCP). Paths and commands follow the existing agent-mode rule
  (activity metadata). `--redact` fakes paths via `display("file", …)` and titles as everywhere.
- No network, no new listener, no hooks into the agents, nothing written to user code or agent data directories.

## Interactions with other specs
- **filter-language**: three attributes (§8.3), registered like `family`/`kind`.
- **rules-config**: one metric, one enabled built-in (§9); `rules defaults` lists it.
- **agent-wait**: families and kinds for `repro`/`verify` tagging (no second classifier).
- **honest-costs**: billing label and `Day.hc` for episode cost; unknown is `null`.
- **skill-usage (shared marks / event kinds)**: debug registers `debug:*` kinds and an episode span on
  `src/model/marks.ts`; that layer owns kind chips, presets, gap markers and filter links (§6.1).
- **command-palette**: links, `applyTarget` for drill-down, palette action.
- **related-events**: `r` from a step.
- **cli-agent-mode**: `addCmd`, `format.ts`, agent scope, contract 1.
- **mcp-server**: one more tool (12), goldens, contract doc.
- **tui-footprint**: lazy rows, budgets, footprint run before merge.
- **otlp-complete / `--watch`**: leftover alerts flow through the existing alert path; episode events are phase 2.
- **fleet / otlp-hub**: remote rows carry no probe data in the MVP (`unverified`, no badge); a later snapshot field is
  additive.

## Testing
- **Pure checks** (`*.check.ts`, synthetic fixtures only):
  - `markers.check.ts`: explicit markers (case, region forms, user markers, invalid config), print table, markdown
    skip, prefilter equivalence (with/without prefilter same result on 200 generated texts).
  - `harness.check.ts` (extended): every adapter's `editText` on its real edit shapes, including Codex `exec`
    escapes, Kiro `create`/`strReplace`/`insert`, fx patch and `edits[]`, OpenCode file and HTTP parts; plus
    "line counts unchanged" for the same fixtures.
  - `capture.check.ts`: folds, whole writes, deletes, clamping, pairing, reverts, caps, codec round trip.
  - `model.check.ts`: episode boundaries (idle split, reopen), tags, outcome, Kiro order-only, rows missing,
    subagent merge — three fixture sessions: an explicit-marker debug run, ad-hoc print debugging, a no-debug
    control.
  - `verify.check.ts`: present/removed/gone/unverified, cache by `(size, mtime)`, path escapes, 4 MiB cap.
  - `query.check.ts`: `DebugVM` golden JSON (`testdata/debug/vm.golden.json`), `null` rules, content stripping,
    links resolve through `parseRef`.
  - `view.check.ts`: panel lines at 80 and 120 columns (no line wider than `W`), help section, footer.
- **Shell tests** (fake `HOME`, synthetic transcripts for all 7 harnesses): `scripts/debug.test.sh` — `debug`,
  `--leftover`, `--check` exit codes, `--instructions`, agent mode, `--redact`, 80-column text, `--help --format
  json` fields; contract test fields; `scripts/mcp.test.sh` content canary for `debug`.
- **Old behavior**: `scripts/golden-usage.sh` before/after — every existing number identical.
- **Footprint**: `scripts/footprint.sh` idle and indexing runs against `main`, numbers in the PR.

## Out of scope
- Writing to user code (removing leftovers for the user): agentglass observes; "autonomous fixing" is explicitly not
  planned (ROADMAP). The panel and `--check` say where they are.
- A log sink or listener for instrumented apps; shipping a debugging prompt or skill (`--instructions` only prints a
  convention for the user to adopt).
- Live breakpoints / pausing an agent before a tool call (needs per-harness hooks).
- LLM-based judgement of whether a print is debug output.
- Language-aware parsing (AST) of edits.

## Decisions (2026-10-09, delegated by the user on 2026-10-05)
Each: question · options · decision · why · cost if wrong.

1. **What counts as a probe by default?** · (a) explicit markers only, (b) markers + every debug print, (c) markers
   + debug prints the same session removed again (paired), unpaired prints opt-in. · **(c), with leftovers from
   explicit markers only.** · Measured: explicit markers appear in 2 sessions on this machine, so (a) would show
   almost no episodes; unpaired prints are ambiguous (31 of 46 cleaning sessions left other prints), so (b) would
   flood leftovers; a pair is self-confirming (removed ⇒ temporary) and every paired session also shows the
   reproduce loop. Leftovers — the thing that alerts — stay explicit-only, as required for a low false-positive
   rate. · If wrong: pairing misses debug prints rewritten before removal (episodes under-counted, never false
   alerts); the opt-in flag widens it.
2. **Which explicit markers?** · a new agentglass-only tag, generic tags, both. · **Both: `agentglass:debug`,
   `#region debug`, `DEBUG-TEMP`/`TEMP-DEBUG`, plus `debug.markers`.** · Our own tag is unambiguous and can be taught
   (`--instructions`); the region and temp tags are conventions agents and people already use, so value arrives
   before anyone adopts ours. · If wrong: a generic tag matches permanent code; markdown is skipped, disk check and
   rule disable remain; removing a default later is a one-line change.
3. **Where is detection computed?** · (a) on the transcript tail at view time, (b) inside the usage indexer, stored
   per session, (c) a separate background scan. · **(b) capture in the indexer; episodes lazily at query time.** ·
   The indexer already reads every line once and holds the edit text; the transcript view sees only the last 6 MB
   and tail loads 60 events, so (a) cannot answer "leftover in any session" or filter history; (c) would read
   everything twice. Episodes need call rows, which are lazy — computing them only when asked keeps idle cost at 0.
   · If wrong: capture adds indexing CPU above budget; then the prefilter tightens (markers only) and pairing moves
   to an opt-in.
4. **Ledger `VERSION` bump?** · (a) bump, re-index once, (b) no bump, backfill with an `rg` pre-scan of transcript
   roots, (c) only new lines get probes. · **(a).** · (c) silently shows no leftovers for history; (b) cannot see
   OpenCode's database or HTTP transport and cannot pair prints. The re-index is a background job with a gauge
   (≈ 8 min measured by tui-footprint on the largest history here) and is shared with any other bump in the release.
   · If wrong: users see one more re-index; nothing is lost.
5. **Leftover = session state or disk state?** · (a) the session never removed it, (b) also present on disk now. ·
   **(b), with `unverified` as its own state.** · Another session, a shell edit or a `git restore` often cleans up;
   alerts on lines that are gone would teach users to ignore the rule. Measured: every checkable unremoved debug
   line was still on disk, so verification removes noise without hiding real cases. · If wrong: a read per open
   probe file every 60 s while open (rare; budgeted); remote rows show `unverified`.
6. **Built-in alert rule on or off?** · on, off (opt-in like `contention`). · **On, severity degraded, no desktop
   notification, judged at turn end.** · It fires only on explicit markers verified on disk — near-zero false
   positives — at the moment the user decides whether to accept the agent's work. `contention` is off because it is
   host-wide and noisy; this one is per session and precise. Notification off because the `waiting` rule already
   notifies at turn end; the alert text and `◆` carry the detail. · If wrong: users disable it with one line;
   `rules defaults` documents it.
7. **Key** · `E`, `e`, `D`, `B`. · **`E`** in transcript mode and on a Sessions row. · Unbound everywhere (`e` is
   detail-mode "open in editor", `D` trash, `b` page up); mnemonic "episodes". · If wrong: the palette entry and
   help still find it; rebinding is local to one feature file.
8. **Badge** · `⚑`, `✗`, `!`, text. · **`⚑` yellow, after alert badges.** · Distinct from `⚠` stuck, `◆` attention,
   `✓` herdr done; fits the 2-cell slot together with one of them. · If wrong: one glyph constant.
9. **View model versioning** · own schema number, the CLI contract. · **The CLI contract (`contract: 1`) + a golden.**
   · One number for CLI and MCP is the established rule (mcp-server Decision 9); a separate number would make
   consumers check two. · If wrong: a breaking VM change bumps the shared contract, which signals it to everyone.
10. **Episode cost** · exact per message, per-hour prorated, none. · **Per-hour prorated, `costApprox: true`, billing
    label.** · Per-message cost per episode would need a new per-call cost column (ledger change); `Day.hc` exists
    and is honest at hour granularity; the label and `≈` say what it is. · If wrong: short episodes in busy hours are
    over- or under-attributed; an exact column can come with the next planned bump.
11. **Reverted fixes in the MVP** · now, phase 2. · **Now (counted), triage dimension in phase 2.** · A 64-entry hash
    table in the same tap costs nothing extra and makes "went in circles" visible in the first release. · If wrong:
    reverts written differently (reformatted) are missed; the count is a floor.
12. **Agent-facing surface** · MCP only, CLI only, both + a convention printer. · **`debug --check`, MCP `debug`,
    `debug --instructions`.** · Agents run shell commands everywhere; MCP is optional; the measured low marker
    adoption means the convention must be easy to install. agentglass prints the text, it never writes AGENTS.md. ·
    If wrong: `--instructions` is unused; it costs a help line.
13. **Evidence content in the MVP** · read log files now, names only. · **Names only; contents phase 2.** · Reading
    app logs is content (privacy), needs windowing and opt-in UI; names and read counts already show the "read the
    evidence" step. · If wrong: the panel looks thinner for users of structured debug logs until phase 2.

14. **Own timeline kinds or the shared event-kind layer?** · (a) debug-only step kinds and a debug-only filter, (b)
    register on the shared marks/event-kind layer of skill-usage. · **(b), with namespaced kinds `debug:*`.** · The
    user wants one way to filter every timeline and event view ("only skills", "only MCP", "only errors", "only
    debugging"). A second taxonomy would split the filters and the web UI's API. · If wrong: the debug panel depends
    on a layer another spec ships. Whichever spec merges first creates `marks.ts` to the agreed shape, so neither
    blocks the other.

## Open questions (technical verification during implementation)
1. **Codex exec patch escapes**: confirm on a real rollout that the unescape (`\\n`, `\\"`, `\\\\`, `\\t`) yields the
   same per-file texts `patchFiles()` counts (line counts of both paths equal on every patch in the fixture set).
2. **Kiro `fs_write` `command` field**: confirm `create`/`strReplace`/`insert` and whether `insert` carries
   `insertLine` (no removal). Fallback: treat an unknown command as a non-whole edit with `newStr`/`content` added.
3. **fx `edits[]` element shape**: confirm keys (`old_string`/`new_string` or `oldText`/`newText`). Fallback: the
   default `editTextOf` handles both.
4. **realpath in scriptc 0.1.7**: `readlinkSync` is missing; confirm whether `realpathSync` works in both backends.
   Fallback: refuse symlinked paths (`lstat`) for verification → `unverified`.
5. **Indexing overhead**: measure capture on a cold full index (`scripts/golden-usage.sh` timing) against the
   + 2 % budget; if over, the prefilter checks only the added text for prints.
