// agentglass — the events read model (local-web-api §2): one session's events with their kinds, filtered like the
// TUI's event views (a filter expression or a preset of the K bar), as `events --json` prints them. serve reads the log
// in slices (evStep) and, for a log over TAIL_BYTES (8 MB), only its tail: the events before it come as one gap with
// truncated: true (holding every event of a 100 MB log would cost serve hundreds of MB). No event text here: the web
// shows kinds, tools and targets, as `events` without --content.
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../model/types.ts";
import { type Obj } from "../util/json.ts";
import { complete } from "../hooks.ts";
import { loadHead, titleOf } from "../model/sessions.ts";
import { sourceOf, parseEvents, window } from "../harness/index.ts";
import { S } from "../state.ts";
import { VF_STORE, vfSet, vfOf, preset, resetForTest } from "../ui/evfilter.ts";
import { listEvents } from "../features/events-cli.ts";
import { type Err } from "./sessions.ts";

export const VIEW = "events"; // its own controller state: never the TUI's saved or linked filters
export const PRESET_NAMES = ["all", "skills", "mcp", "shell", "errors", "prompts"];
export const TAIL_BYTES = 8388608; // ~10x in memory while it is listed: 8 MB of log ≈ 80–100 MB, then freed
// the controller for one listing: no saved file, no pinned clauses; a preset or a filter; "" = fine, else the error
export function viewFor(filter: string, presetName: string): Err | null {
  VF_STORE.path = "-"; VF_STORE.remember = false; resetForTest(); S.pins = [];
  if (presetName) { const i = PRESET_NAMES.indexOf(presetName); if (i < 0) return { code: "bad_param", msg: "preset: " + PRESET_NAMES.join("|"), hint: "" }; preset(VIEW, i); return null; }
  if (filter) { const e = vfSet(VIEW, filter); if (e) { const col = vfOf(VIEW).errCol; return { code: "bad_filter", msg: "filter: " + e + (col >= 0 ? " at column " + String(col + 1) : ""), hint: "event.kind is skill · event.kind is_one_of mcp, error · shell.family ~ test" }; } }
  return null;
}
// a slice-wise read of one log from `from` to its size when asked
export interface EvRead { s: Sess; p: number; from: number; end: number; evs: Ev[] }
export function evRead(s: Sess, tailBytes: number): EvRead {
  loadHead(s); complete(s); // marks (skill loads …) come from the ledger
  const st = sourceOf(s.h).stat(s); const end = st ? st.size : s.size; const from = tailBytes > 0 ? Math.max(0, end - tailBytes) : 0;
  return { s, p: from, from, end, evs: [] };
}
// read on for about budget ms (0 = to the end); true = done. A first line cut by a tail start does not parse: dropped.
export function evStep(r: EvRead, budget: number): boolean {
  const src = sourceOf(r.s.h); const t0 = Date.now();
  while (r.p < r.end) {
    if (budget > 0 && Date.now() - t0 >= budget) return false;
    let w = window(src, 4194304); let x = src.lines(r.s, r.p, Math.min(r.end, r.p + w));
    while (x.next <= r.p && r.p + w < r.end && w < window(src, 67108864)) { w *= 4; x = src.lines(r.s, r.p, Math.min(r.end, r.p + w)); }
    if (x.next <= r.p) { r.p = r.end; break; }
    for (const l of x.lines) parseEvents(r.s.h, l, r.evs, r.s);
    r.p = x.next;
  }
  return true;
}
// the `events --json` object over a read (the controller set by viewFor first); truncated: the read began at a tail
export function eventsJson(r: EvRead, limit: number, presetName: string): Obj {
  const l = listEvents(r.s, r.evs, limit, false);
  const evs = l.events;
  if (r.from > 0) evs.unshift({ unread: r.from }); // the bytes before the tail: not read
  return { session: { harness: r.s.h, id: r.s.id, title: titleOf(r.s) }, filter: vfOf(VIEW).expr || null, preset: presetName || null, matched: l.matched, total: l.total, events: evs, truncated: r.from > 0 };
}
