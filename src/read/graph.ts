// agentglass — the call-graph read model (local-web-api §2, W8.7): one session's turns, tool calls and subagents as
// spans (callgraph/model.ts, the TUI's call graph), columnar for the web's timeline (W9). serve reads source by source
// in slices — the session's log, then each subagent's, each from its last 8 MB (read/events.ts TAIL_BYTES) — and lets a
// source's events go once its spans are built. No content: tool names and categories, never arguments or text.
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../util/json.ts";
import type { Sess } from "../model/types.ts";
import { subActive } from "../model/sessions.ts";
import { harnessOf } from "../harness/index.ts";
import { familyOf } from "../features/queries.ts";
import { type Span, CATS, graphAdd, graphEnd } from "../features/callgraph/model.ts";
import { type EvRead, TAIL_BYTES, evRead, evStep } from "./events.ts";

export interface GraphRead { s: Sess; fam: Sess[]; k: number; r: EvRead | null; out: Span[]; now: number; truncated: number }
export function graphStart(s: Sess, now: number): GraphRead { return { s, fam: familyOf(s), k: 0, r: null, out: [], now, truncated: 0 }; }
function spawnOf(s: Sess): string { const f = harnessOf(s.h).spawnOf; return f ? f(s) : ""; }
// read on for about budget ms; true = every source is in
export function graphStep(g: GraphRead, budget: number): boolean {
  const end = Date.now() + Math.max(1, budget);
  while (g.k < g.fam.length) {
    const x = g.fam[g.k] as Sess;
    let r = g.r; if (!r) { r = evRead(x, TAIL_BYTES); g.r = r; }
    if (!evStep(r, Math.max(1, end - Date.now()))) return false;
    if (r.from > 0) g.truncated++;
    graphAdd(g.out, g.k, { evs: r.evs, live: g.k === 0 ? x.pid > 0 : subActive(x), kind: x.kind, spawn: g.k === 0 ? "" : spawnOf(x) }, g.now);
    g.r = null; g.k++; // this source's events go
    if (Date.now() >= end && g.k < g.fam.length) return false;
  }
  return true;
}
// the spans as columns; from/to (ms, 0 = open): only spans that overlap the window (parent -1 when its parent is out)
export function graphOut(g: GraphRead, from: number, to: number): Obj {
  const gr = graphEnd(g.out);
  const keep: number[] = []; const at = new Map<number, number>();
  for (let i = 0; i < gr.spans.length; i++) { const s = gr.spans[i] as Span; if ((from && s.t1 < from) || (to && s.t0 > to)) continue; at.set(i, keep.length); keep.push(i); }
  const names: string[] = []; const nameAt = new Map<string, number>();
  const c = { t0: [] as number[], t1: [] as number[], depth: [] as number[], row: [] as number[], kind: [] as number[], cat: [] as number[], name: [] as number[], err: [] as number[], open: [] as number[], est: [] as number[], parent: [] as number[], src: [] as number[] };
  for (const i of keep) {
    const s = gr.spans[i + 0] as Span; // scriptc: a for-of number indexes with +0
    let n = nameAt.get(s.name); if (n === undefined) { n = names.length; names.push(s.name); nameAt.set(s.name, n); }
    c.t0.push(s.t0); c.t1.push(s.t1); c.depth.push(s.depth); c.row.push(s.row); c.kind.push(s.kind); c.cat.push(s.cat); c.name.push(n);
    c.err.push(s.err); c.open.push(s.open ? 1 : 0); c.est.push(s.est ? 1 : 0); c.parent.push(s.parent >= 0 ? at.get(s.parent) ?? -1 : -1); c.src.push(s.src);
  }
  const srcs: Obj[] = []; for (const x of g.fam) srcs.push({ harness: x.h, id: x.id, kind: x.kind || null });
  return { session: { harness: g.s.h, id: g.s.id }, t0: gr.t0, t1: gr.t1, noTiming: gr.noTiming, rows: gr.rows.length, n: keep.length, total: gr.spans.length,
    kinds: ["turn", "tool", "agent"], cats: CATS.slice(), names, spans: c, sources: srcs, truncated: g.truncated };
}
