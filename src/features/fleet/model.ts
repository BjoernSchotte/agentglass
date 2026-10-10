// agentglass — the remote-host model (fleet spec section 1): every transport (SSH pull, SSH snapshot, dir drop, the OTLP
// hub) delivers HostReports; the TUI, the filter, the merge and the CLI read only reports
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../../util/json.ts";
import type { SState } from "../../model/state.ts";
import type { OwnChunk } from "./ownc.ts";

export const FORMAT = "agentglass-fleet/v1";
export interface Hello { format: string; version: string; hostId: string; hostName: string; os: string; tzOffsetMin: number; redact: boolean; days: number; now: number; priceSig: string }
// one booking of an owned Claude message (fleet spec 13.1): hashed id (msgHash), order key (owners.ts keyOf), local day
// and hour on its host, model, provider, [in, out, cacheRead, write5m, write1h, usd, tablePriced 0|1]. A message may have
// several rows (streamed output, fallback attempts on other models, an hour edge); n = [] is an ownership-only row (a
// message outside the snapshot's day window: it decides who owns a copy, it carries no usage)
export interface OwnRow { h: string; key: number; d: string; hr: number; m: string; prov: string; n: number[] }
// one local day of a session (spec 12.2), its subagents folded in: tp = table-priced rows [hour, provider, model, in, out,
// cacheRead, write5m, write1h, usd] (usd -1 = unpriced; what re-pricing needs), hx = harness-priced cost [hour, provider,
// usd] (pi/OpenCode reported costs: kept as sent), unk/um = unpriced tokens outside tp ([model, n]), uc = credits without a
// rate, tools/turns/calls/errors of that day; sa = the day's skill rows (Day.sa: [name, provider, model, 18 slots], skill-usage
// 6.15; names as the host shows them: skills.hide / --redact applied, omitted skills folded into "(hidden)"; [] = none or an older host)
export interface DayRow { d: string; tp: string[][]; hx: string[][]; unk: number; um: string[][]; uc: number; tools: number; turns: number; calls: number; errors: number; sa: string[][] }
export interface SessRow {
  s: Obj;                // the jsonSess object (the `--json` contract)
  key: string;           // host-local stable key: "<harness>:<id>"
  days: DayRow[] | null; // per-day usage (Part B feeds); null = only the totals in `s` (Part A pull)
  own: OwnChunk[] | null; // Claude messages this session owns on its host (Part B, OTLP hub), in columns; null = unknown
  prov: string[][];      // [provider, billing mode] for multi-provider harnesses (pi, OpenCode); [] = the session's mode
  dd: boolean;           // days holds only the days that changed since the base ("dd": true on the wire; team streams)
}
// one session's live state: the SState sessState() computes on its host (model/state.ts, also the OTLP logs stream's
// session.state records), keyed and timed
export interface LiveRow extends SState { key: string; at: number; alerts: Obj[] }
export interface HostReport {
  hello: Hello;              // who produced it, when (source clock), under which privacy mode, which price table
  sessions: SessRow[];       // top-level sessions, updated within hello.days or live
  cost: Obj | null;          // the host's own `cost --json` object (shown as is when the report has no days)
  allowance: Obj | null;     // {claude: {account, fetchedAt, h5, d7} | null, codex: {at, wins} | null} (7.4)
  live: LiveRow[] | null;    // newest live state per session from a stream (16, otlp-hub), fresher than `s`
  exact: boolean;            // every session carries days and own: the merge can be exact (13)
  owned: Owned[];            // every Claude session on the host with its owned rows, also those outside the window
                             // (ownership-only rows): who owns a copy is decided over the host's whole history; [] = none (Part A)
  wait: Obj | null;          // agent-wait: the host's `wait --json` object (fleet pull --wait), null = not asked or not sent
}
export interface FeedState { report: HostReport | null; okAt: number; tryAt: number; err: string; code: string; busy: boolean } // viewer clock
export interface HostFeed {
  kind: string;                    // "ssh" (pull or snapshot), "dir" (snapshot drop), "otlp" (otlp-hub)
  start(now: number): boolean;     // begin one refresh in the background; false = one is already running
  poll(now: number): FeedState;    // cheap: stats a file or two, parses only what changed, never blocks
  stop(): void;                    // kill what start() spawned (on quit)
}
// one session's owned rows; key: the session key (SessRow.key), optionally "|<part>" when a session's rows come in parts
// (one per log of its tree: each grows on its own, so a snapshot delta carries only new rows). rows: in columns (ownc.ts),
// one chunk per snapshot line that added some: an append adds a chunk, the earlier ones stay the same objects
export interface Owned { key: string; rows: OwnChunk[] }
export function ownSess(key: string): string { const i = key.indexOf("|"); return i >= 0 ? key.slice(0, i) : key; }
export function noOwned(): Owned[] { return []; }
export function newFeedState(): FeedState { return { report: null, okAt: 0, tryAt: 0, err: "", code: "", busy: false }; }
