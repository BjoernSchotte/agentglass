// agentglass — session compare entry points: m marks A/B in the Sessions list, C picks the pair (spec §2)
// SPDX-License-Identifier: Apache-2.0
// C with two marks compares them; with one, the mark (A) vs the selected row (B); with none, the selected run (B) vs the
// previous top-level session of the same harness and repo (A, the "rerun" case) — no prompt, the header names the pick.
// On the Stats tab C compares the period with the one before it.
import type { Sess } from "../../model/types.ts";
import { S, say } from "../../state.ts";
import { H, tabAt } from "../../hooks.ts";
import { sessions, titleOf, current, buildView } from "../../model/sessions.ts";
import { clean } from "../../util/text.ts";
import { C, CSI, RST, fg } from "../../ui/theme.ts";
import { ledger } from "../usage/ledger.ts";
import { dayKey, todayKey } from "../usage/record.ts";
import { statsPeriod } from "../usage/stats.ts";
import { parse } from "../query/parse.ts";
import { identSync } from "../query/project.ts";
import { labelOf } from "../../model/project.ts";
import { type Group, groupOfSession } from "./metrics.ts";
import { openCompare } from "./view.ts";

export const M = { a: "", b: "" }; // marked session paths ("" none)

function startOf(s: Sess): number { const a = ledger.get(s.path); return a && a.t0 > 0 ? a.t0 : s.mtime; }
function two(n: number): string { return n < 10 ? "0" + String(n) : String(n); }
function when(t: number): string { const d = new Date(t); const dk = dayKey(d); return (dk === todayKey() ? "today" : dk.slice(5)) + " " + two(d.getHours()) + ":" + two(d.getMinutes()); }
// marks of sessions gone from the scan (trashed, deleted) drop
function prune(): void { if (M.a && !sessions.has(M.a)) M.a = ""; if (M.b && !sessions.has(M.b)) M.b = ""; }

// m: an unmarked row becomes A if free, else B (a third mark replaces B); a marked row is unmarked. Returns the toast.
export function toggleMark(s: Sess): string {
  prune();
  if (M.a === s.path) { M.a = ""; return "unmarked"; }
  if (M.b === s.path) { M.b = ""; return "unmarked"; }
  if (!M.a) { M.a = s.path; return "A: " + clean(titleOf(s)); }
  M.b = s.path; return "B: " + clean(titleOf(s));
}
// the newest top-level session of b's harness and project that started before b (never b, never a subagent); null none.
// The project is repo-view's identity (worktrees and clones of one remote are one project). Candidates are visited newest
// first and resolved lazily (their cwd may sit in an unread head), so the walk stops at the first one in the project.
function projKey(s: Sess): string { const id = identSync(s); return id ? id.key : ""; }
function projLabel(s: Sess): string { const id = identSync(s); return id ? labelOf(id) : "?"; }
export function prevSession(b: Sess): Sess | null {
  const key = projKey(b); if (!key) return null;
  const t = startOf(b); const cand: Sess[] = [];
  for (const s of sessions.values()) if (s !== b && !s.parent && s.h === b.h && startOf(s) < t) cand.push(s);
  cand.sort((x: Sess, y: Sess) => startOf(y) - startOf(x));
  for (const s of cand) if (projKey(s) === key) return s;
  return null;
}
// spec §2.2: the pair for C on the Sessions tab, or the toast that explains why there is none
export function pickPair(): { A: Group; B: Group; note: string } | string {
  prune();
  const ma = M.a ? sessions.get(M.a) ?? null : null; const mb = M.b ? sessions.get(M.b) ?? null : null;
  if (ma && mb) return ma === mb ? "A and B are the same" : { A: groupOfSession(ma), B: groupOfSession(mb), note: "" };
  const mark = ma ?? mb; const cur = current();
  if (mark) {
    if (!cur || cur === mark) return "mark a second session with m";
    return { A: groupOfSession(mark), B: groupOfSession(cur), note: "" };
  }
  if (!cur) return "no session selected";
  const p = prevSession(cur);
  const repo = projLabel(cur);
  if (!p) return "no earlier " + cur.h + " session in " + repo + " — mark two with m";
  return { A: groupOfSession(p), B: groupOfSession(cur), note: "A: previous " + cur.h + " session in " + repo + " · " + clean(titleOf(p)) + " · " + when(startOf(p)) };
}
// Stats C: the previous period of the same length (A) vs the current one (B)
export function periodPair(days: string[]): { A: Group; B: Group; note: string } {
  const n = days.length;
  const a = n <= 1 ? "day is yesterday" : "day >= -" + String(2 * n - 1) + "d and day < -" + String(n - 1) + "d";
  const b = n <= 1 ? "day is today" : "day >= -" + String(n - 1) + "d";
  const ca = parse(a).cs; const cb = parse(b).cs;
  return { A: { label: a, cs: ca, single: null }, B: { label: b, cs: cb, single: null }, note: n <= 1 ? "yesterday vs today" : "the " + String(n) + " days before vs the last " + String(n) };
}
// test helpers: put the Sessions cursor on a session id; the toast C would show, or "view"
export function selectSession(id: string): boolean {
  buildView();
  for (let i = 0; i < S.view.length; i++) if (S.view[i].id === id) { S.sel = i; return true; }
  return false;
}
export function pickPairText(): string { const p = pickPair(); return typeof p === "string" ? p : "view"; }

// ── keys, row prefix, hints ──
function statsTab(): boolean { const t = tabAt(S.tab - 2); return !!t && t.name === "Stats"; }
H.rowPrefix.push((s: Sess): string => s.path === M.a ? fg(C.accent) + CSI + "1m" + "A " + RST : s.path === M.b ? fg(C.accent) + CSI + "1m" + "B " + RST : "");
H.onTick.push(prune);
H.keys.push((mode: string, k: string): boolean => {
  if (mode !== "list") return false;
  if (S.tab === 0 && k === "m") { const s = current(); if (s) say("info", toggleMark(s)); return true; }
  if (S.tab === 0 && k === "C") {
    const p = pickPair();
    if (typeof p === "string") say("info", p); else openCompare(p.A, p.B, "Sessions", p.note);
    return true;
  }
  if (k === "C" && statsTab()) { const p = periodPair(statsPeriod()); openCompare(p.A, p.B, "Stats", p.note); return true; }
  return false;
});
H.footerHints.push((mode: string): string[][] => mode === "list" && S.tab === 0 ? [["m", M.a || M.b ? "mark (" + (M.a && M.b ? "2" : "1") + ")" : "mark"], ["C", "compare"]] : mode === "list" && statsTab() ? [["C", "vs previous"]] : []);
