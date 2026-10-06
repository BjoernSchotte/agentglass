// agentglass — header gauge while the ledger indexes history (a cold cache, a VERSION bump, a log far behind)
// SPDX-License-Identifier: Apache-2.0
// `⟳ indexing 34% · 8.0G left · ~3m`, shorter forms when the header has less room; hidden while nothing but live appends
// is pending. The ETA shows "~…" until 30 s of indexing were sampled (ledger.ts Rate), then in steps that grow with it
// (whole minutes to 10 min, 5 min to an hour, 15 min above), held until the estimate moves ¾ of a step away.
import { H } from "../../hooks.ts";
import { C, RST, fg } from "../../ui/theme.ts";
import { bytes, width } from "../../util/text.ts";
import { type IndexState, indexing, indexState } from "./ledger.ts";

const STABLE_MS = 30000;
const SHOWN = { s: -1 }; // the ETA on screen (s, a step multiple; -1 = none yet)
export function gaugeReset(): void { SHOWN.s = -1; } // checks
function stepOf(s: number): number { return s < 600 ? 60 : s < 3600 ? 300 : 900; }
function eta(raw: number): string {
  const st = stepOf(raw);
  if (SHOWN.s < 0 || stepOf(SHOWN.s) !== st || Math.abs(raw - SHOWN.s) >= st * 0.75) SHOWN.s = raw < 60 ? raw : Math.round(raw / st) * st;
  const s = SHOWN.s;
  if (s < 60) return "<1m";
  if (s < 3600) return "~" + String(Math.round(s / 60)) + "m";
  const h = Math.floor(s / 3600); const m = Math.round((s - h * 3600) / 60);
  return "~" + String(h) + "h" + (m ? String(m) + "m" : "");
}
// plain text of the gauge for w free columns ("" = no room); for the check (its one state: the ETA shown, held)
export function gaugeText(st: IndexState, w: number): string {
  const pct = st.total > 0 ? Math.min(99, Math.floor(st.done / st.total * 100)) : 0;
  const p = String(pct) + "%"; const left = bytes(st.left);
  const t = " · " + (st.bps > 0 && st.span >= STABLE_MS ? eta(st.left / st.bps) : "~…");
  for (const o of ["⟳ indexing " + p + " · " + left + " left" + t, "⟳ " + p + " · " + left, "⟳ " + p]) if (width(o) <= w) return o;
  return "";
}
H.headerWidgets.push((w: number) => {
  if (!indexing()) return "";
  const t = gaugeText(indexState(), w); if (!t) return "";
  return fg(C.yellow) + "⟳" + RST + fg(C.sub) + t.slice(1) + RST;
});
H.helpSections.push({ name: "indexing", ctx: "", keys: [
  ["⟳ 34%", "history indexing: done, left, time left"], ["", "live sessions and today's first; ≤ 20 % of one core"] ] });
