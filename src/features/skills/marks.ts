// agentglass — skill loads as session marks (skill-usage spec §5): family "skill", one skill:load span per load (anchored
// on the call that loaded it, else at its time) and one skill:unload point per ended load. The event-kind filter, the
// transcript's ] [ and every timeline view read them through marksOf. The listing is no load a user looks for: no mark.
// Names through skillVis (omit: no mark)
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import { type Mark, registerMarks } from "../../model/marks.ts";
import { C, fg } from "../../ui/theme.ts";
import { accsOf } from "../usage/ledger.ts";
import { type Acc, type SkLoad } from "../usage/record.ts";
import { LISTING } from "../usage/skillrec.ts";
import { skillLoads, tierOf } from "./model.ts";
import { skillVis } from "./vis.ts";

function iso(t: number): string { return t > 0 ? new Date(t).toISOString() : ""; }
// the marks of one session's own logs (its copies; subagents have their own sessions and marks)
export function skillMarks(as: Acc[]): Mark[] {
  const out: Mark[] = [];
  const rows = skillLoads(as, as.map((a: Acc) => ""));
  let r = 0;
  for (const a of as) {
    for (let i = 0; i < a.sk.length; i++, r++) {
      const l = a.sk[i] as SkLoad; if (l.name === LISTING || l.n > 1) continue; // folded summaries have no time
      const v = skillVis(l.name); if (v.mode === "omit") continue;
      const row = rows[r]; const tok = row ? row.load + row.carry : 0; const usd = row ? row.usd : 0;
      out.push({ kind: "skill:load", t0: l.t, t1: l.end > 0 ? l.end : -1, seq: i, turn: l.tu, ev: -1, anchor: l.cid ? "call=" + l.cid : l.t > 0 ? "ts=" + iso(l.t) : "",
        label: v.shown, sub: l.trig, tok, usd, est: tierOf(l) !== "exact", ref: "sk" + String(i) });
      if (l.end > 1) out.push({ kind: "skill:unload", t0: l.end, t1: l.end, seq: i, turn: l.tu, ev: -1, anchor: "ts=" + iso(l.end), label: v.shown, sub: l.why, tok: 0, usd: 0, est: false, ref: "sk" + String(i) + "e" });
    }
  }
  return out;
}
// changes when the ledger read more of the session at the same log size (its marks then differ)
function gen(s: Sess): number { let g = 0; for (const a of accsOf(s)) g += a.off + a.sk.length; return g; }
registerMarks({ kind: "skill", glyph: "✧", color: (): string => fg(C.cyan), of: (s: Sess): Mark[] => skillMarks(accsOf(s)), gen });
