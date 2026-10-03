// agentglass — agent-facing queries: session <ref>, sessions, errors, cost rows (one formatter, project scope inside an agent)
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import type { Obj } from "../util/json.ts";
import { accOf } from "./usage/ledger.ts";
import { modelUses } from "./usage/record.ts";

function r6(c: number): number { return Math.round(c * 1e6) / 1e6; }
// per model over the sessions (their ledger accs, filled by complete()) and local days (null = all): cost desc, then tokens;
// costUsd null when the model has unpriced tokens and no priced cost (unpriced usage never shows as $0)
export function modelRows(ss: Sess[], days: string[] | null): Obj[] {
  const by = new Map<string, number[]>(); // model → [in, out, cacheRead, cacheWrite, cost, unpriced]
  for (const s of ss) for (const u of modelUses(accOf(s), days)) {
    let r = by.get(u.model); if (!r) { r = [0, 0, 0, 0, 0, 0]; by.set(u.model, r); }
    r[0] = (r[0] ?? 0) + u.inTok; r[1] = (r[1] ?? 0) + u.outTok; r[2] = (r[2] ?? 0) + u.cr; r[3] = (r[3] ?? 0) + u.cw; r[4] = (r[4] ?? 0) + u.cost; r[5] = (r[5] ?? 0) + u.unk;
  }
  const ks = [...by.keys()];
  const tok = (k: string): number => { const r = by.get(k) ?? []; return (r[0] ?? 0) + (r[1] ?? 0) + (r[2] ?? 0) + (r[3] ?? 0); };
  const cost = (k: string): number => { const r = by.get(k) ?? []; return r[4] ?? 0; };
  ks.sort((x, y) => cost(y) - cost(x) || tok(y) - tok(x) || (x < y ? -1 : x > y ? 1 : 0));
  const out: Obj[] = [];
  for (const k of ks) {
    const r = by.get(k) ?? []; const c = r[4] ?? 0; const unk = r[5] ?? 0;
    out.push({ model: k, in: r[0] ?? 0, out: r[1] ?? 0, cacheRead: r[2] ?? 0, cacheWrite: r[3] ?? 0, costUsd: c === 0 && unk > 0 ? null : r6(c), unpricedTokens: unk });
  }
  return out;
}
