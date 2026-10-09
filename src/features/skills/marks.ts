// agentglass — skill loads as session marks (skill-usage spec §5): family "skill", one skill:load span per load (anchored
// on the call that loaded it, else at its time) and one skill:unload point per ended load. The event-kind filter, the
// transcript's ] [ and every timeline view read them through marksOf. The listing is no load a user looks for: no mark.
// Names through skillVis (omit: no mark). Also their transcript lines, the event detail's load record, v (view skill) in
// the transcript and the skills in context at a moment (replay)
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../../model/types.ts";
import { S, say } from "../../state.ts";
import { H } from "../../hooks.ts";
import { type Mark, registerMarks, marksOf, famOf } from "../../model/marks.ts";
import { toolKinds, markAt } from "../../model/kinds.ts";
import { C, CSI, RST, fg } from "../../ui/theme.ts";
import { clean, fitStyled } from "../../util/text.ts";
import { accsOf } from "../usage/ledger.ts";
import { type Acc, type SkLoad } from "../usage/record.ts";
import { LISTING } from "../usage/skillrec.ts";
import { kfmt, money } from "../usage/costs.ts";
import { asBill } from "../usage/billing.ts";
import { toolName, toolArg } from "../callgraph/model.ts";
import { type LoadRow, skillLoads, tierOf } from "./model.ts";
import { skillVis, hideRules, VIS } from "./vis.ts";
import { hideEvents } from "./watchvis.ts";
import { openSkillView, recordLines } from "./view.ts";

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
// changes when the ledger read more of the session at the same log size (its marks then differ), or the hiding rules did
function gen(s: Sess): number { let g = 0; for (const a of accsOf(s)) g += a.off + a.sk.length; return g + VIS.gen * 7919; }
registerMarks({ kind: "skill", glyph: "✧", color: (): string => fg(C.cyan), of: (s: Sess): Mark[] => skillMarks(accsOf(s)), gen });
// the TUI's events follow skills.hide / --redact like its skill lines (transcript, detail, search, copy, call graph,
// related, replay): first, on the real text, before the redaction hook scrubs it. Only when something is hidden (a hook in
// H.events means rewritten events to related/build.ts); --watch applies the rules per line itself
H.start.unshift((): void => { if (VIS.redact || hideRules().length) H.events.unshift(hideEvents); });

// the load row behind a skill mark (sk<i>: load i of the session's log, or of a copy with a load at that time); null: not
// a skill mark, or the load is gone. Kept per (session, ref, times): the transcript asks every frame
const ROWS = new Map<string, LoadRow>(); const ROWS_MAX = 4000;
export function loadOf(s: Sess, m: Mark): LoadRow | null {
  if (famOf(m.kind) !== "skill") return null;
  const ref = m.ref.endsWith("e") ? m.ref.slice(0, -1) : m.ref; const i = Number(ref.slice(2));
  const k = s.path + "\t" + m.ref + "\t" + String(m.t0) + "\t" + String(m.t1) + "\t" + String(m.tok); const hit = ROWS.get(k); if (hit) return hit;
  if (!Number.isInteger(i) || i < 0) return null;
  for (const a of accsOf(s)) {
    const l = i < a.sk.length ? a.sk[i] as SkLoad : null;
    if (!l || (m.kind === "skill:load" && l.t !== m.t0) || (m.kind === "skill:unload" && l.end !== m.t0)) continue;
    const row = skillLoads([a], [s.path])[i]; if (!row) return null;
    if (ROWS.size > ROWS_MAX) ROWS.clear();
    ROWS.set(k, row); return row;
  }
  return null;
}
const WHY = new Map<string, string>([["compact", "compacted"], ["drop", "dropped"], ["relist", "relisted"], ["clear", "cleared"]]);
// the transcript line: "✧ brainstorming · user · 4.1K tok · in context 31 req · $0.42 (tail $0.35)", "✧ brainstorming out (compacted)"
export function skillLine(s: Sess, m: Mark, w: number): string {
  if (famOf(m.kind) !== "skill") return "";
  const dot = fg(C.dim) + " · " + RST; const g = fg(C.cyan) + "✧ " + RST + fg(C.cyan) + CSI + "1m" + clean(m.label) + RST;
  if (m.kind === "skill:unload") return fitStyled(g + fg(C.dim) + " out (" + (WHY.get(m.sub) ?? m.sub) + ")" + RST, w);
  const r = loadOf(s, m);
  if (!r) return fitStyled(g + dot + fg(C.sub) + m.sub + RST, w);
  const size = r.size < 0 ? "size ?" : (r.tier === "≈" ? "≈" : "") + kfmt(r.size) + " tok";
  const usd = r.tier === "?" && r.usd <= 0 ? "$ ?" : money(r.usd, asBill(s.bill), r.tier === "≈") + (r.unpriced ? "+" : "") + (r.tailUsd > 0 ? " (tail " + money(r.tailUsd, asBill(s.bill), r.tier === "≈") + ")" : "");
  return fitStyled(g + dot + fg(C.sub) + r.trig + (r.stub ? " (stub)" : "") + (r.rel ? " (again after compaction)" : "") + RST + dot + fg(C.text) + size + RST + dot +
    fg(C.sub) + (r.end === 0 ? "in context " : "carried ") + String(r.requests) + " req" + RST + dot + fg(C.yellow) + usd + RST, w);
}
H.markLines.push(skillLine);
// the skill loads anchored on event i of evs (the transcript's own events); on a call that loads a skill (Skill, skill,
// activate_skill, a SKILL.md read) also the load its result made when the log names no call for it (it lands a few
// events later, after the result)
export function loadsAt(s: Sess, evs: Ev[], i: number): LoadRow[] {
  const o: LoadRow[] = []; if (i < 0 || i >= evs.length) return o;
  const e = evs[i]; let near = false;
  if (e.kind === "tool") near = toolKinds(toolName(e), toolArg(e)).indexOf("skill:load") >= 0 || toolArg(e).indexOf("SKILL.md") >= 0;
  const to = near ? Math.min(evs.length, i + 4) : i;
  for (const m of marksOf(s, ["skill:load"])) { const j = markAt(s, evs, m); if (j < i || j > to) continue; const r = loadOf(s, m); if (r) o.push(r); }
  return o;
}
// the event detail (↵) of an event a load lands on: the load's record first
H.detailHead.push((s: Sess, evs: Ev[], i: number, w: number): string[] => {
  const o: string[] = [];
  for (const r of loadsAt(s, evs, i)) {
    const rec = recordLines(r, asBill(s.bill));
    o.push(fg(C.cyan) + CSI + "1m" + "━━ SKILL LOAD " + RST + fg(C.line) + "━".repeat(Math.max(0, w - 14)) + RST);
    o.push(fg(C.cyan) + CSI + "1m" + clean(rec[0] ?? "") + RST + fg(C.dim) + "   v views its text" + RST);
    for (const x of rec.slice(1)) o.push(fg(C.sub) + x.slice(0, 9) + RST + fg(C.text) + x.slice(9) + RST);
    o.push("");
  }
  return o;
});
// the skills in context at time t (replay's status): how many, and their size per request
export function openAt(s: Sess, t: number): { n: number; tok: number } {
  let n = 0; let tok = 0; if (t <= 0) return { n, tok };
  for (const a of accsOf(s)) for (const l of a.sk) {
    if (l.name === LISTING || l.t <= 0 || l.t > t || (l.end > 0 && l.end <= t) || skillVis(l.name).mode === "omit") continue;
    n++; if (l.S > 0) tok += l.S;
  }
  return { n, tok };
}
// v in the transcript: view the skill loaded at the cursor's event (the first, when several land there)
H.keys.push((mode: string, k: string): boolean => {
  if (mode !== "transcript" || k !== "v") return false;
  const t = S.tv; if (!t) return false;
  const ls = loadsAt(t.s, t.evs, t.cur);
  const r = ls.length ? ls[0] : null; // the nearest (on a call: the load its result made)
  if (r) openSkillView(t.s, r); else say("info", "no skill load at this event — ] [ jump to the next / previous skill load (or other mark)");
  return true;
});
H.footerHints.push((mode: string): string[][] => {
  if (mode !== "transcript") return [];
  const t = S.tv; return t && t.cur >= 0 && loadsAt(t.s, t.evs, t.cur).length ? [["v", "view skill", "1"]] : [];
});
H.helpSections.push({ name: "skills", ctx: "transcript", keys: [["✧", "a skill entered the context (name · trigger · size · requests carried · $ with the tail after its turn) or left it (out)"],
  ["] [", "next / previous mark: skill loads (and other marks) when no kind filter is on"], ["v", "view skill: the load's record and the text it put into the context"],
  ["↵", "on a skill line: the event detail starts with the load record"], ["K 2", "kind filter preset 2: only skill events"]] });
