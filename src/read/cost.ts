// agentglass — the cost read model (local-web-api §2): `cost --json` (today / 7 days / month by billing mode, unpriced,
// projection, budget) and the `cost --by` rows. The CLI, fleet pull/snapshot and serve --stdio share it.
// lazy (serve, LAZY.on): a log the background index is far behind on is not read here; what it booked so far counts and
// pending says how many logs of the window are still being counted — the answer comes at once on a cold start
// SPDX-License-Identifier: Apache-2.0
import { complete } from "../hooks.ts";
import { sessions, loadHead } from "../model/sessions.ts";
import type { Sess } from "../model/types.ts";
import type { Obj } from "../util/json.ts";
import { MODES } from "../features/usage/billing.ts";
import { type ModeSum, monthStart } from "../features/usage/costs.ts";
import { type CostNow, type Ent, costNow, costOfEnts } from "../features/usage/summary.ts";
import { ledger } from "../features/usage/ledger.ts";
import { modeOf } from "../features/usage/bill-live.ts";
import type { Bill } from "../features/usage/billing.ts";
import { startOfDay, dayKey, todayKey } from "../features/usage/record.ts";
import { BY, costRows, parseSince } from "../features/queries.ts";
import { filterOf } from "../features/query/cli.ts";
import { harnessIds } from "../harness/index.ts";
import { LAZY, farBehind, indexed } from "./row.ts";
import { type Err } from "./sessions.ts";

function round(c: number): number { return Math.round(c * 1e6) / 1e6; }
function byMode(m: ModeSum): Obj { const o: Obj = {}; for (let i = 0; i < MODES.length; i++) o[MODES[i] ?? ""] = round(m.by[i] ?? 0); return o; }
function unpriced(m: ModeSum): Obj { const bm: Obj = {}; for (const [k, n] of m.um) bm[k] = n; return { tokens: m.unk, byModel: bm, credits: m.uc }; }
// the `cost --json` object (fleet pull prints exactly this)
export function json(c: CostNow): Obj {
  const pb: Obj = {}; for (let i = 0; i < MODES.length; i++) { const p = c.projByMode[i]; pb[MODES[i] ?? ""] = p && p.month >= 0 ? round(p.month) : null; }
  const b = c.budget;
  return {
    today: { byMode: byMode(c.today), estimatedUsd: round(c.today.est), unpriced: unpriced(c.today) },
    week: { byMode: byMode(c.week), estimatedUsd: round(c.week.est), unpriced: unpriced(c.week) },
    month: { byMode: byMode(c.month), estimatedUsd: round(c.month.est), unpriced: unpriced(c.month), projected: c.proj.month >= 0 ? { byMode: pb, total: round(c.proj.month) } : null },
    budget: b.usd > 0 ? { monthlyUsd: b.usd, counts: b.counts, used: round(c.bs.used), projected: c.bs.projected >= 0 ? round(c.bs.projected) : null, state: c.bs.state, approx: c.bs.approx } : null,
  };
}
// a log serve's background index is far behind on: counted as booked so far, not read here (a live log's last appends
// are read: they are small, and a running agent would otherwise count as pending forever)
function lazy(s: Sess): boolean { return LAZY.on && farBehind(s); }
// every session that can hold a day of this month or of the 14-day projection window, indexed to its end (serve: the
// ones indexed already); pending = the window's logs still being counted
const P = { pending: 0 };
export function summary(harness: string): CostNow {
  const from = Math.min(startOfDay() - (monthStart(Date.now()).length - 1) * 86400000, startOfDay() - 15 * 86400000) - 3600000;
  P.pending = 0;
  for (const s of sessions.values()) {
    if (s.mtime < from || (harness && s.h !== harness)) continue;
    if (lazy(s)) { P.pending++; continue; }
    if (LAZY.on && indexed(s)) continue; // serve: the background index keeps it booked to its end already
    loadHead(s); complete(s);
  }
  return costNow(harness);
}
// summary() over these top-level sessions and their subagents only (a scoped snapshot: fleet-teams spec 6)
export function summaryOf(top: Sess[]): CostNow {
  const es: Ent[] = []; const st: Sess[] = []; for (const s of top) st.push(s);
  while (st.length) {
    const s = st.pop(); if (!s) break;
    loadHead(s); complete(s);
    const a = ledger.get(s.path); if (a) { const x = s; es.push({ a, mode: (p: string): Bill => modeOf(x, p) }); }
    for (const c of s.subs) st.push(c);
  }
  return costOfEnts(es);
}

// cost.get {harness?, by?, since?, filter?}: without by/since/filter the summary, else the rows (by defaults to day,
// since to today), as `cost` and `cost --by` print them; pending: logs of the window not counted to their end yet
export interface CostQ { harness: string; by: string; since: string; filter: string }
export interface CostR { data: Obj | null; err: Err | null }
function bad(code: string, msg: string, hint: string): CostR { return { data: null, err: { code, msg, hint } }; }
export function readCost(q: CostQ): CostR {
  if (q.harness && harnessIds().indexOf(q.harness) < 0) return bad("bad_param", "harness: " + harnessIds().join("|"), "");
  if (!q.by && !q.since && !q.filter) { const o = json(summary(q.harness)); o["pending"] = P.pending; return { data: o, err: null }; }
  const by = q.by || "day";
  if (BY.indexOf(by) < 0) return bad("bad_param", "by: " + BY.join("|"), "");
  const ms = q.since ? parseSince(q.since, Date.now()) : 0; if (ms < 0) return bad("bad_param", "since: today, <n>h, <n>d or YYYY-MM-DD", "");
  const since = q.since ? dayKey(new Date(ms)) : todayKey(); // as cost --since
  const fr = filterOf(q.filter ? [q.filter] : [], q.harness, false, false, false); const cf = fr.cf;
  if (!cf) { const e = fr.err; const col = e ? e.col : 0; return bad("bad_filter", "filter: " + (e ? e.msg : "invalid filter") + " at column " + String(col + 1), fr.src ? fr.src + "\n" + " ".repeat(Math.max(0, col)) + "^" : ""); }
  let pending = 0;
  const rows = costRows(since, by, { name: "all", key: "", cwd: "", warn: "" }, cf, (s: Sess): boolean => { const l = lazy(s); if (l) pending++; return l; });
  return { data: { rows, source: "ledger", by, since, pending }, err: null };
}
