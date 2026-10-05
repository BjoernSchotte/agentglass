// agentglass — header gauge while the ledger indexes history (a cold cache, a VERSION bump, a log far behind)
// SPDX-License-Identifier: Apache-2.0
// `⟳ indexing 34% · 8.0G left · ~3m`, shorter forms when the header has less room; hidden while nothing but live appends
// is pending. The ETA needs 10 s of samples of the indexing rate.
import { H } from "../../hooks.ts";
import { C, RST, fg } from "../../ui/theme.ts";
import { bytes, width } from "../../util/text.ts";
import { type IndexState, indexing, indexState } from "./ledger.ts";

function eta(s: number): string {
  if (s < 60) return "~" + String(Math.max(1, Math.round(s))) + "s";
  if (s < 3600) return "~" + String(Math.round(s / 60)) + "m";
  const h = Math.floor(s / 3600); const m = Math.round((s - h * 3600) / 60);
  return "~" + String(h) + "h" + (m ? String(m) + "m" : "");
}
// plain text of the gauge for w free columns ("" = no room); pure, for the check
export function gaugeText(st: IndexState, w: number, now: number): string {
  const pct = st.total > 0 ? Math.min(99, Math.floor(st.done / st.total * 100)) : 0;
  const p = String(pct) + "%"; const left = bytes(st.left);
  const t = st.bps > 0 && st.since > 0 && now - st.since >= 10000 ? " · " + eta(st.left / st.bps) : "";
  for (const o of ["⟳ indexing " + p + " · " + left + " left" + t, "⟳ " + p + " · " + left, "⟳ " + p]) if (width(o) <= w) return o;
  return "";
}
H.headerWidgets.push((w: number) => {
  if (!indexing()) return "";
  const t = gaugeText(indexState(), w, Date.now()); if (!t) return "";
  return fg(C.yellow) + "⟳" + RST + fg(C.sub) + t.slice(1) + RST;
});
H.helpSections.push({ name: "indexing", ctx: "", keys: [
  ["⟳ 34%", "history indexing: done, left, time left"], ["", "live sessions and today's first; ≤ 20 % of one core"] ] });
