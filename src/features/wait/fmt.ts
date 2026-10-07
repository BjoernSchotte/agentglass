// agentglass — agent-wait: shared figures and text pieces of the Wait tab and `agentglass wait`
// SPDX-License-Identifier: Apache-2.0
import { width } from "../../util/text.ts";
import { fmtMs } from "../usage/calls.ts";
import type { RuleSet } from "../rules/config.ts";
import { ALL_KINDS, famKind } from "./family.ts";
import type { WRow, WaitReport } from "./report.ts";
import { type CallSpan, type GroupOverlap, overlap, bucketFor } from "./overlap.ts";
import { type LiveWait, heavyNow, famCounts } from "./live.ts";

// the contention rule's threshold (enabled or not): what "too many" means here
export function maxOf(rs: RuleSet): number { for (const r of rs.rules) if (r.id === "contention" && r.hasDeg) return r.deg; return 3; }
// overlap groups for the rows of `by`: families (their ids), kinds (index in ALL_KINDS), tools (none: only ALL)
export function overlapFor(rep: WaitReport, by: string): GroupOverlap[] {
  const days = Math.max(1, Math.ceil((rep.until - rep.since) / 86400000));
  let sp: CallSpan[] = rep.spans;
  if (by === "kind") { sp = []; for (const s of rep.spans) sp.push({ t0: s.t0, t1: s.t1, group: ALL_KINDS.indexOf(famKind(s.group)), agent: s.agent }); }
  return overlap(sp, rep.since, rep.until, bucketFor(days));
}
export function groupOf(ov: GroupOverlap[], id: number): GroupOverlap | null { for (const g of ov) if (g.group === id) return g; return null; }
export function rowsBy(rep: WaitReport, by: string): WRow[] { return by === "kind" ? rep.kinds : by === "tool" ? rep.tools : rep.fams; }
// the overlap group of a row in view `by` (tools: none)
export function groupFor(ov: GroupOverlap[], w: WRow, by: string): GroupOverlap | null { return by === "tool" ? null : groupOf(ov, by === "kind" ? ALL_KINDS.indexOf(w.kind) : w.id); }
export function cut(s: string, w: number): string { return width(s) <= w ? s : s.slice(0, w - 1) + "…"; }
export function lp(s: string, w: number): string { const n = width(s); return n >= w ? cut(s, w) : s + " ".repeat(w - n); }
export function rp(s: string, w: number): string { const n = width(s); return n >= w ? cut(s, w) : " ".repeat(w - n) + s; }
export function hours(ms: number): string { return ms <= 0 ? "0" : ms < 3600000 ? fmtMs(ms) : (ms / 3600000).toFixed(ms < 36000000 ? 1 : 0) + "h"; }
export function pctTxt(x: number): string { return x <= 0 ? "0%" : x < 0.1 ? (x * 100).toFixed(1) + "%" : String(Math.round(x * 100)) + "%"; }
// +12%, -3%; from +1000% on the ratio (×26): the column stays 5 wide
export function trendTxt(t: number | null): string { return t === null ? "·" : t >= 9.995 ? "×" + String(Math.round(t + 1)) : (t >= 0 ? "+" : "") + String(Math.round(t * 100)) + "%"; }
// a kind in a 5-character column
export function kindShort(k: string): string { return k === "typecheck" ? "typec" : k === "install" ? "inst" : k; }
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function whenTxt(t: number): string { const d = new Date(t); return (WD[d.getDay()] ?? "") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
export function splitTxt(rep: WaitReport): string {
  const sp = rep.split; const a = sp.activeMs;
  if (a <= 0) return "no agent time recorded";
  return "agent time " + (a / 3600000).toFixed(a < 36000000 ? 1 : 0) + "h · tools " + pctTxt(sp.toolMs / a) + " (polling " + pctTxt(sp.pollMs / a) + ") · you " + pctTxt(sp.userMs / a) + " · model " + pctTxt(sp.modelMs / a);
}
export function periodTxt(since: string): string {
  if (since === "today") return "today";
  const m = /^(\d+)([dh])$/.exec(since); if (m) return (m[1] ?? "") + (m[2] === "d" ? (m[1] === "1" ? " day" : " days") : "h");
  return "since " + since;
}
export function nowTxt(lw: LiveWait, max: number): string {
  const hv = heavyNow(lw, "", "");
  const host = (lw.load1 >= 0 ? " · load " + lw.load1.toFixed(1) + (lw.cpus > 0 ? "/" + String(lw.cpus) : "") : "") + (lw.memAvailPct >= 0 ? " · mem " + String(lw.memAvailPct) + "% free" : "");
  if (!hv.length) return "now: no heavy command running" + host;
  let rss = 0; let known = false; for (const r of hv) if (r.rssKb >= 0) { rss += r.rssKb; known = true; }
  return "now: " + String(hv.length) + " heavy" + (hv.length >= max ? " (≥ " + String(max) + ")" : "") + ": " + famCounts(hv) + (known ? " · " + (rss / 1048576).toFixed(1) + "G" : "") + host;
}
