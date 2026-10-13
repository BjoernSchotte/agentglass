// agentglass — the skills read model (local-web-api §2, W8.5): `agentglass skills --json` — per skill its loads, carry,
// tail, cost and share for the period, the hidden row, the top advice — as skills.get serves it. serve indexes the
// period's sessions in slices; lazy: a log the background index is far behind on counts as booked so far (pending),
// an indexed one is not read again.
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../util/json.ts";
import type { Sess } from "../model/types.ts";
import { harnessIds } from "../harness/index.ts";
import { filterOf } from "../features/query/cli.ts";
import { type SkPrep, SKILL_PERIODS, SKILL_SORTS, newOpts, skillsPrep, skillsStep, skillsJson, skillsFilters } from "../features/skills/cli.ts";
import { LAZY, farBehind, indexed } from "./row.ts";
import { dropRows } from "../features/usage/ledger.ts";
import { type Err } from "./sessions.ts";

export interface SkillsQ { period: string; sort: string; harness: string; repo: string; filter: string; advice: number }
export interface SkillsR { prep: SkPrep | null; err: Err | null; pending: number }
function bad(code: string, msg: string, hint: string): SkillsR { return { prep: null, err: { code, msg, hint }, pending: 0 }; }
export function skillsStart(q: SkillsQ): SkillsR {
  if (q.period && SKILL_PERIODS.indexOf(q.period) < 0) return bad("bad_param", "period: " + SKILL_PERIODS.join("|"), "");
  if (q.sort && SKILL_SORTS.indexOf(q.sort) < 0) return bad("bad_param", "sort: " + SKILL_SORTS.join("|"), "");
  if (q.harness && harnessIds().indexOf(q.harness) < 0) return bad("bad_param", "harness: " + harnessIds().join("|"), "");
  if (!(Number.isInteger(q.advice) && q.advice >= 0 && q.advice <= 50)) return bad("bad_param", "advice: 0 to 50", "");
  const o = newOpts(); o.json = true; o.period = q.period || "30d"; o.sort = q.sort || "cost"; o.harness = q.harness; o.repo = q.repo; o.advice = q.advice;
  if (q.filter) o.filters.push(q.filter);
  const fs = skillsFilters(o);
  const fr = filterOf(fs, o.harness, false, false, false); const cf = fr.cf;
  if (fs.length && !cf) { const e = fr.err; const col = e ? e.col : 0; return bad("bad_filter", "filter: " + (e ? e.msg : "invalid filter") + " at column " + String(col + 1), fr.src ? fr.src + "\n" + " ".repeat(Math.max(0, col)) + "^" : ""); }
  const r: SkillsR = { prep: null, err: null, pending: 0 };
  const p = skillsPrep(o, { name: "all", key: "", cwd: "", warn: "" }, fs.length ? cf : null,
    (s: Sess): boolean => { if (!LAZY.on) return false; if (farBehind(s)) { r.pending++; return true; } return indexed(s); });
  p.rows = true; r.prep = p;
  return r;
}
export function skillsStepR(r: SkillsR, ms: number): boolean { const p = r.prep; return !p || skillsStep(p, ms); }
// the answer; then the call rows read for it go back (a skills page open on a long history would keep ~85 MB of them)
export function skillsOut(r: SkillsR): Obj {
  const p = r.prep; const e: Obj = {}; const o = p ? skillsJson(p.o, p.set) : e; o["pending"] = r.pending;
  if (p) { for (const s of p.loaded) dropRows(s); p.loaded = []; }
  return o;
}
