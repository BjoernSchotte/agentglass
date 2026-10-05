# TUI footprint — spec

Status: **draft** (2026-10-05). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 2 (after 2026.10.4).

## Goal
agentglass stays small and quiet on a shared machine, with the same numbers as today:

| | today (this host, measured) | target |
|---|---|---|
| TUI steady RSS | 810–827 MB | ≤ 300 MB (expected ≈ 180 MB), also with a call-row filter active |
| TUI first frame, warm cache | 2.2–2.4 s | ≤ 1 s |
| TUI first frame, cold cache | 0.35 s, no visible progress, history indexed for ~8 min | ≤ 2 s, live sessions first, header progress gauge, history indexed in the background |
| TUI CPU, 36 live agents streaming, no input | 14.1 % self + 5.0 % child processes = 19.1 % of one core | ≤ 1 % without the ingest of new transcript bytes, ≤ 2 % in all (self + children) — Decision 2 |
| Cold full index (`--json --subagents`, empty cache) peak RSS | 875 MB | ≤ 500 MB |
| Warm `--json --limit 400` / `cost` | 0.74 s / 174 MB | not slower, not larger |
| Costs, tokens, tool counts, call rows | — | identical to main (golden comparison, Testing) |

## Why (user value)
- 820 MB for a dashboard is a tenth of a small laptop's memory and a visible share of a shared dev box. People close
  the TUI to get the memory back and lose the alarms.
- 19 % of a core while nobody looks at it is the biggest single consumer after the agents themselves on a busy host;
  on battery it is drain for nothing.
- A 2.3 s blank terminal on every start, and a cold start that indexes for minutes with no sign of it, make the tool
  feel broken.

## Today (measured, not guessed)
Host: Linux 6.17, 32 cores, `main` @ 5d20c0b (2026.10.4), release build, niced, isolated `AGENTGLASS_*` paths. Data:
3,356 sessions (2,290 list rows), 12.1 GB of transcripts (Codex 8.8 GB, Claude 3.4 GB; 19 files > 100 MB hold 7.3 GB,
the largest 1.57 GB), 36 live agents, ~2,300 processes. Ledger cache `ledger.json` 62 MB, `calls/` 38 MB in 3,356 files.
Method: RSS from `/proc/<pid>/status`, CPU from `/proc/<pid>/stat` utime+stime (self) and cutime+cstime (waited
children), a temporary instrumented build logging RSS and time per startup phase, per job and per `H.onTick` hook, and
small scriptc probes for single costs.

### Memory (warm TUI)
| phase | RSS after | Δ | where |
|---|---|---|---|
| read `ledger.json` whole | 131 MB | +121 MB | `src/features/usage/cache.ts:44-45` (bytes + decoded string, 62 MB each) |
| `JSON.parse` of all of it | 235 MB | +105 MB | `cache.ts:45` (one object tree) |
| `accIn` × 3,356 + call rows of every session | 714 MB | +480 MB | `cache.ts:51-60`: the TUI is not a lazy-rows run (`cache.ts:25-35`), so every calls file is decoded (`cache.ts:56`) |
| first frame | 666 MB | −48 MB | parse tree freed |
| first tick: ledger save | 821 MB | +143–155 MB | `cache.ts:120`: `lastSave = 0`, so the first tick saves; `accOut` tree + one 62 MB `JSON.stringify` (`cache.ts:78-81`) |

- Call rows: 294,985 rows cost **+217 MB and 1.17 s CPU** to load (~735 B per row: one object per call with three
  arrays and an id string, `src/features/usage/facts.ts:7`, decoded per row at `src/features/usage/callcache.ts:164-168`).
- Loading rows decodes every day's heavy maps first: `refTable()` walks `heavy(d)` of every day (`callcache.ts:44-53`),
  and `heavy()` keeps what it decoded (`src/features/usage/record.ts:27`). All 3,549 days: 350 ms CPU, +29 MB net.
- Experiments on the same data: lazy rows + no first-tick save → **309 MB** steady, first frame 0.86 s (load 0.33 s).
  Plus a streamed one-session-per-line cache → **173 MB** steady (110 MB after load), first frame 0.75 s (load 0.26 s).
  Without the heavy text in memory → 131 MB. glibc tuning (`MALLOC_TRIM_THRESHOLD_=0 MALLOC_MMAP_THRESHOLD_=131072`):
  no effect (676 vs 681 MB) — the memory is live data and small-object fragmentation, not trimmable slack.
- `ledger.json` by field: day heavy text `hv` 41.3 MB (68 %; of it command lines 25.9 MB, tools 11.1 MB), tail memos `tl`
  6.8 MB, ownership `mo` 6.8 MB, `ids` 1.7 MB, git refs 1.7 MB, head memos 0.9 MB, all numeric day fields < 1 MB.
  Largest session line 0.78 MB, median 5 KB.

### Memory (cold full index, CLI)
`--json --subagents` on an empty cache: 69 s wall, **peak 875 MB**. Indexing grows to 652 MB (319,338 call rows,
186,372 Claude message ids, 192,792 ownership entries, 189,861 heavy map keys, all days decoded); then the save adds
the `accOut` tree (+152 MB) and the one-string `JSON.stringify` (+65 MB). Transcripts are read in 1 MB chunks
(`src/features/usage/ledger.ts:17,67-69`); no transcript is read whole. One unbounded read exists: `--watch` reads a
session's whole growth since the last poll in one call (`src/features/cli.ts:279`).

### Startup
- Warm: `tui()` runs `scan()` (which loads the cache: `H.firstScan`, `cache.ts:115`) before the first frame
  (`src/main.ts:206-211`): load 1.8 s, first frame at 2.2–2.4 s.
- Cold: first frame at 0.35 s; the list is complete, costs fill in as the ledger indexes. Indexing rate ~25 MB/s at
  20–45 % of one core (budget 4 MB per tick, 100 ms slice, `ledger.ts:17,115-121`): 9.6 GB left after 100 s, the full
  history after ~8 min. Progress is visible only in the Stats tab (`src/features/usage/stats.ts:184-186`) and in the
  debug footer; the Sessions screen shows nothing.
- Cold `--json --limit 400`: 25 s, 295 MB (it must index what it lists: `complete()`, `ledger.ts:129`).

### CPU (warm TUI, 36 live agents streaming, no input, Sessions tab, 160×45)
120 s window: self 14.1 %, children 5.0 %, total 19.1 %. Per job (EWMA from `AGENTGLASS_DEBUG_REFRESH=1` and the
instrumented build):

| job | cost per run / interval | share | cause |
|---|---|---|---|
| procs | 102 ms / 1.5 s | 6.8 % self + ~4.7 % child | `ps -axo …` over ~2,300 processes (70 ms wall, 551 KB output) + regex per line (`src/platform/posix.ts:10-17`); `linkSessions()` runs `applyMeta` on all 3,356 sessions (`src/model/procs.ts:115-122`) |
| render | 112 ms / ~2 s | 5.1 % | 130–156 ms of it is the preview's git line: `sessGit()` → `allInfo()` passes over every session, stats every reflog and lists worktrees at least once a second (`src/features/vcs/attrib.ts:225-245`, `src/features/vcs/view.ts:91-97`); header 0–1 ms, rows 1 ms |
| tick | 14–20 ms / 500 ms | 2.8–4 % | per tick: `buildView()` 6 ms (`src/main.ts:122`, `src/model/sessions.ts:170-203`), ledger 10 ms (ingest plus two O(n) passes over all sessions, `ledger.ts:108-124`), billing labels for every session 2.5 ms (`src/features/usage/bill-live.ts:96-100`), ticker 1 ms |
| scan | 32 ms / 3 s | 1.1 % | stat of 3,363 transcripts 8 ms, `listDir` of 532 dirs 8 ms (probe), `applyMeta` per session (`sessions.ts:14-27,47-52`) |
| watch | ~5 ms / 1.5 s | 0.3 % | watchdog over live sessions |
| slow, size, probe | 16 ms / 5 s, 2 ms / 2 s, 0.4 ms / 250 ms | 0.5 % | `/proc/<pid>/fd` walk, tmux, `stty` |

Single costs measured with scriptc probes: reading `/proc/<pid>/stat` of all 2,292 processes 27 ms CPU; `cmdline` of
all 14 ms; `stat` of 532 directories 0.4 ms. `flush()` writes the whole frame whenever any byte differs
(`src/ui/frame.ts:7-11`); `S.dirty` is set after every procs run (`main.ts:117`) and whenever `L.ver` moved
(`main.ts:124`), which is every tick while agents stream.

## Design

### 1. Measurement and golden comparison (tooling, first)
- `scripts/footprint.sh` (POSIX sh, Linux): starts a given binary in a detached tmux pane (160×45) with every
  `AGENTGLASS_*` path pointed at a scratch dir and `AGENTGLASS_AGENT=0`, runs `nice -n 10`, and prints one line per
  metric: `first_frame_ms` (pane shows the sessions box), `rss_mb@5s/30s/end`, `cpu_self_pct`, `cpu_children_pct`,
  `cpu_total_pct` over a window after a warm-up. Modes `--cold` (empty cache dir) and `--warm <cache dir>` (copied
  first, never written in place). Kills only its own tmux session.
- `scripts/golden-usage.sh <ref-bin> <new-bin>`: the two binaries index the same transcripts into separate scratch
  caches and their outputs are compared on the **stable** sessions — present in both, same `bytes`, `updated` older
  than the first run's start minus 120 s (live agents keep writing during the comparison). Compared per session:
  `tokens`, `costUsd`, `unpricedTokens`, `unpricedCredits`, `tools`, `linesAdded`, `linesRemoved`, `skills`,
  `billing`; the sets of sessions matching three call-row filters (`status is error`, `tool is Bash`,
  `duration > 30s`); `cost --json --by session --since 30d` rows of stable sessions. Modes: `--cold` (both empty),
  `--warm` (the new binary starts from a copy of the ref binary's cache: exercises load, migration and lazy rows),
  `--harness h` (passed through, for quicker runs). Exit 0 only with 0 differences; prints compared/skipped counts.
- Debug footer (`AGENTGLASS_DEBUG_REFRESH=1`) gains `rss <MB>` (Linux: `/proc/self/statm`, no spawn; elsewhere absent)
  and `ingest <ms>/s · <KB>/s` (EWMA of the ledger's time and bytes spent on new transcript bytes, from 3): the part
  of the CPU that Decision 2 counts apart.

### 2. Ledger cache: one session per line, streamed
- File `ledger.jsonl` next to today's `ledger.json` (`cache.ts:37`). Line 1: header
  `{"v":15,"f":2,"prices":"…","saved":…,"rl":{…}}` (`f` = file format; `v` stays the data `VERSION`, `codec.ts:12`).
  Every further line: `{"path":"<log path>", …accOut(a)}` — the same per-session object as today.
- **Load**: read in 4 MB windows of whole lines (`readLines`, `src/util/fs.ts:43`); each line is parsed, `accIn`ed and
  installed exactly as today's loop body (`cache.ts:52-59`), then dropped. A line longer than the window: the window
  grows ×4 up to 64 MB; still too long → that session is skipped (re-indexed). A line that does not parse or has no
  path → that session alone re-indexes. Header `v`/`prices` not readable → the whole cache is stale, as today.
- **Save**: write the header, then per session `JSON.stringify(accOut(a))` + `\n` straight to the temp file, then
  rename (atomic, as today `cache.ts:84-86`). Peak = one session's object (≤ 1 MB here), not the whole tree.
- **Migration**: no `ledger.jsonl`, but a readable `ledger.json` (same `v`, same price signature) → loaded once by
  the old whole-file path; the next save writes `ledger.jsonl` and then removes `ledger.json`. No re-index on upgrade.
- **Save policy**: the save clock starts at load (no save on the first tick); a save happens only when `L.idx` moved,
  every 30 s while the history is indexing (3) and every 5 min otherwise; quit and a one-shot exit save as today.
- `--watch` reads a session's growth in ≤ 4 MB windows per poll (`cli.ts:279`).

### 3. Ledger tick proportional to change; indexing pace; progress
- `tick()` (`ledger.ts:102-125`) makes one pass: per session a map lookup and a size/offset compare; `accOf()`,
  `applyAcc()` only where the entry is new, the log changed or the entry moved since it was last applied; `L.done` and
  `L.total` are summed in the same pass. Sidecars (fx, Kiro `usageSidecar`) are stat'ed at most every 5 s per session
  unless the session is pid-linked.
- `indexing()` means **history** indexing: bytes pending in a session that is not live, or more than 1 MB pending in
  any session. Live appends below that are ingest, not indexing (the level stays as adaptive-refresh decides; the
  30 s save cadence of 2 does not kick in for them).
- Pace (Decision 1): no 4 MB byte cap per tick; a 50 ms time slice per 250 ms tick while indexing, so
  indexing uses ≤ 20 % of one core and finishes this history in ~4 min instead of ~8. Ranking stays: the selected
  session, live sessions, today's, then newest first (`ledger.ts:94-98`).
- Header widget (new `src/features/usage/progress.ts`, `H.headerWidgets`): while `indexing()`, `⟳ indexing 34% ·
  8.0G left · ~3m` (≥ 120 columns), `⟳ 34% · 8.0G` (≥ 100), `⟳ 34%` (narrower); the ETA from an EWMA of bytes per
  second, shown after 10 s of samples. Hidden when nothing is pending. Help (`?`) lists it under "indexing".

### 4. Call rows: lazy everywhere
- Every run, the TUI included, reads a session's calls file only when something asks for that session's rows: the
  ledger right before the session grows (today's `LAZY.rows`, `ledger.ts:22,30`), and the readers through one
  accessor `callsOf(s)` (`ledger.ts`): `eachCall`/`callsIn` in `src/features/query/eval.ts`, the model attribute
  (`query/eval.ts:62`, `query/agg.ts:47`), the watchdog's row metrics (`src/features/watchdog.ts:69`), `queries.ts`,
  triage, compare. `lazyRows()` (`cache.ts:25-35`) goes away; `unread` stays the set of not-yet-read files.
- A filter over call rows reads the rows of the sessions in its day window only (as `errors`/`triage` do today).
- Decoding a calls file needs the day maps' text keys (`refTable`); it now decodes them transiently
  (`peekHeavy(d)`: decoded, not kept, when the day is not decoded already), so reading rows no longer pins 3,549
  decoded days.

### 5. Call rows: columnar
`Acc.calls: Call[]` becomes `Acc.rows: Rows` — one column per field, rows in call order:

```
interface Rows { n: number; t: number[]; tool: number[]; model: number[]; mq: number[]; ms: number[]; err: number[];
                 out: number[]; lo: number[] /* start of row i's ids in li */; li: number[] /* id * 4 + kind (0 prog, 1 cmd, 2 file) */;
                 cid: string[] }
```
- Append (`tool()`, `record.ts:194`) pushes one value per column; the ids a later line adds (`pend`, `file`,
  `record.ts:200-237`) always belong to the newest row, so they go to the end of `li`; `lo[n]` = `li.length`.
- A pending call keeps its row index (`Pend.row` → `Pend.ri`, `src/features/usage/calls.ts:17`); `done()` writes
  `ms`/`err`/`out` in place. `prune()` (`callcache.ts:176-184`) compacts all columns and returns an old→new index map
  that it applies to `a.pend` and `a.lastCall`.
- Readers get `(s, r, i)` instead of `(s, c: Call)`: `eachCall`, `callsIn`, rule metrics (`src/features/rules/metrics.ts:35,67`),
  triage, compare, Stats. `rowIds(r, i, kind)` returns a row's prog/cmd/file ids (allocates only when asked).
- The calls file format (`callcache.ts`, columnar on disk already) decodes straight into the columns: no per-row
  object. `FORMAT` stays 2 (the file does not change).
- Expected: ~110–120 B per row with `number[]` columns (~35 MB for 295k rows instead of 217 MB), less with typed arrays
  if scriptc 0.1.7 supports growing them (Task 0 probe 1).

### 6. Process scan (Linux: /proc, incremental)
- `Platform.listProcs` on Linux reads `/proc` itself instead of spawning `ps`:
  - every run: `listDir("/proc")`; pids not seen before → `stat` (ppid, tty_nr, utime+stime, starttime, rss pages)
    and `cmdline` (NUL → space; empty → `[comm]` as `ps` prints kernel threads); pids younger than 10 s → `cmdline`
    again (exec chains: `sh -c` → `node` → agent); pids gone → dropped;
  - harness process trees (roots and every descendant): `stat` again for CPU and RSS, new children from
    `/proc/<pid>/task/<tid>/children`;
  - every 30 s: a full pass over every pid (`stat` + `cmdline`), the safety net for execs of older processes and
    reparenting.
  `tty` is derived from `tty_nr` (major 136–143 → `pts/<n>`, 4 → `tty<n>`/`ttyS<n>`, else `?`); `etime` from
  `starttime` and `/proc/stat` `btime`; CPU from the tick delta of the stat just read (`cpuOf` stops re-reading,
  `src/platform/linux.ts:14-26`). Expected ≤ 4 ms per run instead of 102 ms + a `ps` child.
- macOS keeps `ps` (no `/proc`); it gains the change-only work below.
- `linkSessions()` (`procs.ts:115-140`) calls `applyMeta(s)` only for sessions whose `pid`, `status` or `name` changed.

### 7. Git attribution: incremental
- `allInfo()` keeps a per-session `SessIn` memo keyed by (identity version, `a.t0`, `a.al`, live, refs length) and
  rebuilds `SessIn`s only for sessions whose key changed; reflog stamps and worktree lists are re-read at most every
  5 s per gitdir (today: up to every second); attribution re-runs only for the project keys whose inputs changed.
- The preview's git line (`vcs/view.ts:91-97`) is memoized per session by (attribution generation, `L.ver` of the
  session's own cost, subagent count). Expected: the git line ≤ 1 ms per frame; a new commit shows within 5 s.
- The result is identical to today's for the same inputs (`vcs.check.ts` fixtures plus a new equality check of the
  incremental vs a full rebuild).

### 8. Session scan and list view
- `listDirCached(dir)` (`src/util/fs.ts`): the listing is reused while the directory's mtime is unchanged and older
  than 2 s (a directory changed within the last 2 s is always listed: coarse mtimes). The harness scans
  (`src/harness/{claude,codex,gemini,pi,kiro,fx}.ts`) use it for their directory walks.
- `addFile()` (`sessions.ts:14-27`) stats a known log only when it is pid-linked, changed within the last 24 h, or its
  turn in a rotation comes (every ~60 s for the rest); `applyMeta` only for new or changed sessions.
- `buildView()` keeps its result while a signature over its inputs is unchanged: session set (`SG.gen`), each
  session's `mtime`/`pid`/`parent`, the active-subagent count (time-based auto-expand), expanded/collapsed sets, the
  filter key and — when a filter is active — `L.ver`. The signature is one O(n) pass of number adds (~0.2 ms).
- Billing labels (`bill-live.ts:96-100`) are recomputed for a session only when its pid, its ledger entry's stamp or
  the config evidence changed.

### 9. Frames
- `S.dirty` is set when something shown changed: the procs job when the header values (live/busy counts, the CPU
  sample, memory) or the Processes tab rows changed; the tick when `L.ver` moved **and** the header's formatted cost,
  a visible row or the preview's session changed (a per-frame signature of those strings).
- `flush()` (`src/ui/frame.ts`) writes only the rows that differ from the last frame (cursor-addressed), and the
  whole frame after a resize, focus-in or `S.repaint`.
- Expected: a Sessions frame ≤ 3 ms at 160×45 (from 112–160 ms), ≤ 2 frames/s while agents stream.

### 10. Evaluated and not adopted
- **Event-driven refresh with `fs.watch`**: scriptc 0.1.7 ships `fs.watch` (inotify on Linux, kqueue on macOS; tested:
  directory events `rename`/`change`, file events `change`), but the listener gets no file name (no lowering), and
  kqueue on a directory reports entries, not appends to files in it. The polling it would replace costs < 0.2 % after
  8 (mtime-gated listings, tiered stats). Not worth a second code path.
- **Binary cache codec**: the cost was the whole-file read + parse (+226 MB, 0.2 s); streaming lines (2) removes it
  and keeps the format readable and diffable. A binary codec would save CPU on a 0.26 s load only.
- **Heavy maps in separate per-session files**: −42 MB (173 → 131 MB). Below the target either way; it would add a
  second file per session and a decode on every Stats aggregation. Not now.
- **String interning**: strings are already `own()`ed and the per-call strings are dictionary ids (`facts.ts`); the
  measured bulk was rows, the parse tree and the save, not duplicate strings.
- **Row eviction (LRU)**: columnar rows make all rows of this history ~35 MB; eviction would only add reload thrash
  when a filter sweeps every session.

### Failure modes
- Crash mid-save: the temp file is never renamed; the previous `ledger.jsonl` (or `ledger.json`) stays.
- A corrupt or truncated line: only that session re-indexes (today one bad byte re-indexes everything).
- `/proc/<pid>` vanishing between `listDir` and the read: the pid is skipped this run.
- `/proc/<pid>/task/<tid>/children` missing (kernel without `CONFIG_PROC_CHILDREN`): children come from the 30 s full
  pass and from new pids' ppid; detected once, logged in the debug footer.
- A directory whose mtime does not move on a new entry (some network filesystems): the rotation still lists every
  directory at least every 60 s (same as the 24 h-old files).
- Calls file unreadable when a reader asks: that session's rows are empty and it re-indexes from the start on its next
  growth (as `rowsOf` does today).

### Privacy
No new data is stored or read. `ledger.jsonl` holds what `ledger.json` holds; `/proc/<pid>/cmdline` is what `ps args`
showed. `--redact` keeps disabling the head/tail memos (`cache.ts:97`). The golden script and `footprint.sh` write only
to scratch dirs passed in and never print transcript text (ids, numbers and paths only; the reports stay local).

## Interactions with other specs
- **model-prices** (Round 2): adds `Day.tp` and bumps `VERSION`. The per-session line format here carries it unchanged.
  Independent specs: tui-footprint keeps `VERSION`, model-prices bumps it; whichever merges second rebases onto the
  other's codec. The migration of 2 applies only when `v` matches, so after model-prices' bump the first run
  re-indexes once (as any bump does).
- **adaptive-refresh**: its level table and alarm bounds stay (`sched.ts:23-31,65-71`); its debug footer is the probe
  used here (`rss` added). The "procs slow" footer note should no longer appear on Linux.
- **filter-language / triage / session-compare / rules-config**: their call-row readers move to `callsOf()` (4) and to
  `(s, r, i)` (5); results identical (golden filters).
- **git-linkage**: attribution results identical; latency of a new commit in the preview ≤ 5 s.
- **perf-baseline / honest-costs / #51 ownership**: `hv` text, head/tail memos and `mo` text stay as they are.
- **cli-agent-mode**: `--json`, `cost` and every CLI output unchanged.

## Testing
- Unit checks (scriptc `*.check.ts`): streamed cache round trip (header, lines, long line, corrupt line, migration from
  `ledger.json`, save after load not on first tick); ledger tick pass (only changed sessions applied, `done/total`,
  `indexing()` semantics); `peekHeavy` does not retain; `Rows` append/prune/index map/pending writes; `eachCall`
  equality old vs new on fixtures; `/proc` parsing (stat with spaces/parens in comm, tty_nr decoding, kernel threads,
  vanished pid) against fixture files; tree refresh via a fake children reader; `listDirCached` with a fake clock;
  `buildView` signature (changes on each input, steady otherwise); attribution incremental == full rebuild on the
  `vcs.check.ts` fixtures; frame row diff.
- Golden comparison (1) on this host: `--warm` after 2, 4, 5; `--cold --harness claude` after 3, 4, 5; `--cold` full
  once at the end. 0 differences required.
- Footprint (1) before/after per task and at the end, recorded in `specs/tui-footprint/results.md`.
- Manual: Sessions/Processes/Stats/Repos tabs at 80/120/200 columns, cold start shows the gauge and live sessions
  first, alarms still fire within the adaptive-refresh bounds.

## Out of scope
- macOS process scan without `ps` (no `/proc`; `libproc` is not reachable from scriptc).
- Faster ingest per byte (adapter parsing); Stats/Repos aggregation cost while those tabs are open.
- CLI progress output for long one-shot runs.

## Decisions
Each: question · options · decision · why · cost if wrong.

1. **Indexing pace on a cold cache.** Options: (a) no byte cap, 50 ms slice per 250 ms tick: ≤ 20 % of one core, this
   history (12.1 GB) in ~4 min; (b) 100 ms per tick: ≤ 40 %, ~2 min; (c) today: 4 MB per tick, 20–45 %, ~8 min.
   **Decision: (a).** Why: the user wants low CPU and memory on a shared machine; a cold index is rare (first start, a
   `VERSION` bump), so a lower peak beats a shorter duration. All options do the same total work. The live view and
   alarms stay responsive (live and today's sessions are indexed first, the slice bounds input latency) and the header
   gauge (3) shows progress. Cost if wrong: on a cold start, full-history Stats arrive ~2 min later than with (b).
2. **What the CPU target counts.** Options: (a) ≤ 1 % of one core excluding the ledger's ingest and tail parsing of
   new transcript bytes, ≤ 2 % in all including child processes, ingest shown separately in the debug footer (1);
   (b) a flat ≤ 1 % including ingest; (c) self only, children not counted. **Decision: (a).** Why: ingest scales with
   how much the agents write, not with agentglass; holding it under a flat cap means throttling it, which delays alarms
   and costs. Children count because `ps` was a quarter of today's cost and is invisible to `top -p`. Cost if wrong:
   on very busy hosts total CPU is above 1 % — visible in the footer, not hidden.
3. **Call rows: compact or evict?** Options: (a) columnar store, all rows that are loaded stay; (b) object rows with an
   LRU memory budget; (c) lazy loading only. **Decision: (a) together with lazy loading (4, 5).** Why: lazy alone
   gives 173 MB until a call-row filter (often pinned, remembered by default) loads every row (+217 MB → ~390 MB, over
   target); eviction would re-decode on every sweep (1.2 s CPU per full pass); columns make all rows ~35 MB. Cost if
   wrong: a wide reader refactor (T8) for ~180 MB that only matters to people with call-row filters — contained in one
   task after the lazy one, which alone already meets the target without such a filter.
4. **Cache file format.** Options: (a) JSON, one session per line, streamed; (b) a binary codec; (c) keep one JSON
   object. **Decision: (a).** Why: the cost was the whole-file read + parse (+226 MB) and the one-string save
   (+220 MB peak), not JSON itself; per-line streaming removes both (measured 173 MB), keeps the file readable and
   diffable, isolates a corrupt line to one session, and migrates from today's file without a re-index. Cost if
   wrong: load stays ~0.26 s of CPU where a binary codec might take ~0.1 s.
5. **Event-driven refresh (`fs.watch`).** Options: (a) polling made cheap (mtime-gated listings, tiered stats); (b)
   `fs.watch` with a polling fallback. **Decision: (a).** Why: in scriptc 0.1.7 the listener gets no file name, and
   kqueue on a macOS directory does not report appends to files in it, so (b) still needs most of (a); after 8 the
   polling costs < 0.2 %. Cost if wrong: a new session in an old, inactive project directory can take up to one scan
   interval (3 s hot) longer than an inotify event — the same as today.
6. **Process scan on Linux.** Options: (a) incremental `/proc` reads (new, young and tracked pids; full pass every
   30 s); (b) keep `ps` at a slower cadence; (c) `ps` as is. **Decision: (a).** Why: `ps` costs 70 ms in a child plus
   30 ms parsing per run (6.8 % + 4.7 %); a full `/proc` pass is 27 ms, the incremental one reads a few dozen files;
   (b) would delay new agents in the live count and the alarms' CPU samples. Cost if wrong: a process that execs into
   an agent more than 10 s after it started is classified up to 30 s late (the full pass); `/proc` parsing edge cases
   are covered by fixtures and a `ps` agreement check.
7. **Process discovery latency.** Options: (a) keep 1.5 s while agents are live; (b) slow discovery to 5–10 s to save
   CPU. **Decision: (a).** Why: with (6) a discovery pass costs ≤ 4 ms, so the slower cadence would save < 0.2 % and
   make a newly started agent appear late. Cost if wrong: ≤ 0.2 % CPU more than (b).
8. **Git line freshness in the preview.** Options: (a) reflogs re-read at most every 5 s; (b) every second as today.
   **Decision: (a).** Why: the per-second pass over every session and reflog was 130 ms per frame, the largest render
   cost; a commit is not an alarm. Cost if wrong: a new commit shows in the preview up to 5 s after it was made.
9. **Separate per-session files for the day detail maps (`hv`).** Options: (a) keep them in the ledger line as text,
   decoded on use; (b) move them out. **Decision: (a).** Why: (b) saves 42 MB (173 → 131 MB), already under target,
   and costs a second file per session plus a read on every Stats aggregation. Day fields that other specs re-price
   (model-prices `Day.tp`) stay plain fields in the line either way. Cost if wrong: ~40 MB more resident than possible.
10. **Cache `VERSION`.** Options: (a) unchanged (15); (b) bump with the new file. **Decision: (a).** Why: no cached
   value changes meaning; the new file migrates from the old one, so upgrading costs one parse instead of a full
   re-index (minutes). Cost if wrong: none for numbers — a wrong migration is caught by the golden `--warm` run, which
   starts the new binary from the old binary's cache.

## Open questions
None left open. The three technical unknowns are checked in plan Task 0 (`src/util/footprint-probes.check.ts`), each
with a named fallback that the later tasks follow without a new decision:
1. Growable typed arrays in scriptc 0.1.7 → fallback: `number[]` columns (5; ~35 MB instead of ~20 MB for 295k rows).
2. `/proc/<pid>/task/<tid>/children` on the CI kernels → fallback: children from new pids' ppid plus the 30 s full pass (6).
3. The 64 KB `own()` buffer after a streamed load → fallback: `cachefile.ts` copies each line with `own()` before parsing,
   and parsed strings keep going through `accIn`'s `own()` (2).
