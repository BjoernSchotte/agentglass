// agentglass — one session's live state, the rule shared by the OTLP logs stream (session.state records) and `fleet watch`
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "./types.ts";
import { parentOf } from "./sessions.ts";

// live = its agent process runs; busy = mid-turn; attention / stuck = the rules engine's flags (stuck: the reason code,
// "" = fine); approval = the watchdog's estimate that a tool call waits for the user
export interface SState { live: boolean; busy: boolean; attention: boolean; approval: boolean; stuck: string }
export function sessState(s: Sess, approval: (s: Sess) => string, busy: (s: Sess) => boolean): SState {
  const p = s.pid || (s.parent ? (parentOf(s)?.pid ?? 0) : 0);
  const live = p > 0;
  return { live, busy: live && busy(s), attention: s.attention, approval: live && approval(s) !== "", stuck: s.stuck };
}
export function sameState(a: SState, b: SState): boolean { return a.live === b.live && a.busy === b.busy && a.attention === b.attention && a.approval === b.approval && a.stuck === b.stuck; }
