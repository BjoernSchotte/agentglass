// agentglass — the remote-host model (fleet spec section 1): every transport (SSH pull, SSH snapshot, dir drop, the OTLP
// hub) delivers HostReports; the TUI, the filter, the merge and the CLI read only reports
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../../util/json.ts";
import type { SState } from "../../model/state.ts";

export const FORMAT = "agentglass-fleet/v1";
export interface Hello { format: string; version: string; hostId: string; hostName: string; os: string; tzOffsetMin: number; redact: boolean; days: number; now: number; priceSig: string }
export interface OwnRow { h: string; key: number; d: string; m: string; prov: string; n: number[] } // one owned Claude message: hashed id, order key, local day, model, provider, [in, out, cacheRead, write5m, write1h, usd, tablePriced 0|1]
export interface DayRow { d: string; tp: string[][]; hx: number[][]; unk: number; um: string[][]; uc: number; tools: number; turns: number; calls: number; errors: number } // 13.2
export interface SessRow {
  s: Obj;                // the jsonSess object (the `--json` contract)
  key: string;           // host-local stable key: "<harness>:<id>"
  days: DayRow[] | null; // per-day usage (Part B feeds); null = only the totals in `s` (Part A pull)
  own: OwnRow[] | null;  // Claude messages this session owns on its host (Part B, OTLP hub); null = unknown
  prov: string[][];      // [provider, billing mode] for multi-provider harnesses (pi, OpenCode); [] = the session's mode
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
}
export interface FeedState { report: HostReport | null; okAt: number; tryAt: number; err: string; code: string; busy: boolean } // viewer clock
export interface HostFeed {
  kind: string;                    // "ssh" (pull or snapshot), "dir" (snapshot drop), "otlp" (otlp-hub)
  start(now: number): boolean;     // begin one refresh in the background; false = one is already running
  poll(now: number): FeedState;    // cheap: stats a file or two, parses only what changed, never blocks
  stop(): void;                    // kill what start() spawned (on quit)
}
export function newFeedState(): FeedState { return { report: null, okAt: 0, tryAt: 0, err: "", code: "", busy: false }; }
