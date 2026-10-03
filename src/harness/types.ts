// agentglass — harness port: everything agentglass knows about one coding agent, in one adapter
// SPDX-License-Identifier: Apache-2.0
//
// Adding a harness (opencode, pi, …):
//   1. copy the smallest adapter (fx.ts) to src/harness/<id>.ts and fill in the fields below
//   2. add it to HARNESSES in src/harness/index.ts
//   3. add a few real log lines to SAMPLES in src/harness/harness.check.ts and run the contract check
// Everything else (list, filters, badges, ticker, stats rows, --harness, help, full-text search, trash,
// live detection, send/resume) picks it up from the registry.
import type { Obj } from "../util/json.ts";
import type { Ev, Sess } from "../model/types.ts";
import type { Acc } from "../features/usage/record.ts";

// how a session's records are read: files by default (cursor = byte offset); a database-backed adapter brings its own cursor
export interface SessionSource {
  stat: (s: Sess) => { size: number; mtime: number } | null; // size = end cursor (bytes for files)
  align: (s: Sess, at: number) => number; // first whole record at/after `at`
  lines: (s: Sess, from: number, to: number) => { lines: string[]; next: number }; // whole records in [from, to); next = cursor after the last one
  unit: number; // bytes one cursor step stands for (window budgets)
  epoch?: (s: Sess) => string; // what the cursor means right now (a source with two transports); a change = re-read from 0
}

// scan() reports each transcript it finds; parent = the parent session's id for subagents known from the
// directory layout ("" otherwise, meta() may still set s.parent), archived = shown dimmed
export type AddFn = (path: string, id: string, parent: string, archived: boolean) => void;
// a live-session registry entry: the harness itself says which pid runs which session
export interface Live { id: string; pid: number; status: string; name: string }

export interface HarnessAdapter {
  // ── identity & look ──
  id: string; // stable key: Sess.h, --harness, AGENTGLASS_<ID>, cache files; lowercase, no spaces
  label: string; // human name, ≤ 7 cells ("Claude"); ≤ 8 with its own badge ("OpenCode")
  glyph: string; // logo, 1–2 cells (ticker, default badge)
  mark: string; // 1-cell logo for dense tables (stats)
  color: () => string; // theme color as "r;g;b" (a function: themes switch at runtime)
  badge?: () => string; // own BADGE_W-cell styled badge; default: glyph + label in color()

  // ── process view ──
  bin: string; // command to launch it; the user can override with AGENTGLASS_<ID>="cmd --flags"
  procs: string[]; // process basenames that belong to this harness (wrappers and helpers too)

  // ── discovery ──
  roots: () => string[]; // directories holding its transcripts (full-text search)
  scan: (add: AddFn) => void; // report every transcript; called every few seconds, keep it to listDir + cheap checks
  meta?: (s: Sess) => void; // once, when a session is first seen: sidecar metadata, subagent parent/kind, title
  refresh?: (s: Sess) => void; // before each tail load: sidecars that change while the agent runs
  source?: SessionSource; // where records come from; default = the file at s.path (byte cursor)
  headBytes: number; // bytes of the log head read for the first prompt and metadata

  // ── transcript ──
  parse: (o: Obj, out: Ev[], s: Sess | null) => void; // one parsed JSONL line → 0..n events; may update s (cwd, model, title)
  title?: (s: Sess) => string; // title from elsewhere (codex thread index) when the log sets none
  busy?: (s: Sess) => boolean; // mid-turn right now? default: turnBusy(s, false) (turn started … complete/aborted markers)
  spawnOf?: (s: Sess) => string; // subagent s: the parent's tool-call id that spawned it (call graph), "" if unknown

  // ── live detection (either or both) ──
  liveFile?: (path: string) => boolean; // the harness keeps its transcript open while running: is this open file one?
  liveRegistry?: (alive: (pid: number) => boolean, harnessOfPid: (pid: number) => string) => Live[]; // the harness writes a pid ↔ session registry (harnessOfPid: "" = no agent process)
  approvalTitle?: (title: string) => boolean; // its terminal title (read from its tmux pane) says it waits for the user to approve a tool call
  daemon?: string; // its registry pids are one shared daemon running many sessions: never signalled from here; how the user stops it

  // ── steering: args after bin; leave out what the CLI can't do ──
  headless?: (s: Sess, msg: string) => string[]; // send msg to session s without a terminal (s.id, s.path, s.cwd for the CLI's own addressing)
  resume?: (s: Sess) => string[]; // reopen session s interactively
  files?: (s: Sess) => string[]; // every file/dir that belongs to the session (moved to the trash together); absent = can't be trashed
  search?: (q: string) => string[]; // session paths whose content matches q (non-file sources); file harnesses are searched via roots() + rg
  liveCwd?: boolean; // no registry, no open transcript: link a live process to the newest session whose cwd equals the process cwd

  // ── usage (tokens, cost, tools, lines, files → Stats tab, --json) ──
  usage: (a: Acc, line: string) => void; // one raw log line; pre-filter with indexOf before parse(), most lines are noise
  usageSidecar?: (s: Sess, a: Acc) => void; // per tick: running totals kept outside the log (stat first, reparse on change)
}
