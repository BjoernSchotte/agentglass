// agentglass — the ledger cache's JSON shape: Acc/Day ⇄ plain objects (IO lives in ./cache.ts)
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { type Acc, type Day } from "./record.ts";
import { type Rec, type TS, type Cnt, type Pend, HB } from "./calls.ts";

// bump when log parsing or bucketing changes: stale caches are dropped, not reused
export const VERSION = 7; // 7: honest-costs day/acc fields after parsing-fixes' 6 — unk = unpriced tokens only, um/uc/cp/hc/mt per day, uc/bill/plan/bs per session; 6: Claude fallback iterations booked per attempt; Day.skills + Day.turns + Acc.pk (parsing-fixes); 5: Acc.ep (source cursor epoch); pi MCP/nested/subagent stats; 4: kiro end_timestamp parsed as ISO (re-dates already booked turns); 3: per-harness running state as x/xM

export function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
function nums(v: unknown): number[] { const out: number[] = []; for (const x of arr(v)) out.push(num(x)); return out; }

function recsOut(rs: Rec[]): Obj[] { const out: Obj[] = []; for (const r of rs) out.push({ t: r.t, m: r.ms, i: r.id, s: r.ts, a: r.arg }); return out; }
function recsIn(v: unknown): Rec[] {
  const out: Rec[] = [];
  for (const x of arr(v)) { const o = obj(x); if (o) out.push({ t: num(o["t"]), ms: num(o["m"]), id: str(o["i"]), ts: str(o["s"]), arg: str(o["a"]) }); }
  return out;
}
function cntsOut(m: Map<string, Cnt>): Obj { const o: Obj = {}; for (const [k, c] of m) o[k] = [c.n, c.err, c.add, c.del]; return o; }
function cntsIn(v: unknown): Map<string, Cnt> {
  const m = new Map<string, Cnt>(); const o = obj(v);
  if (o) for (const k of Object.keys(o)) { const a = nums(o[k]); m.set(k, { n: at(a, 0), err: at(a, 1), add: at(a, 2), del: at(a, 3) }); }
  return m;
}
function numMapOut(m: Map<string, number>): Obj { const o: Obj = {}; for (const [k, v] of m) o[k] = v; return o; }
function numMapIn(v: unknown): Map<string, number> { const m = new Map<string, number>(); const o = obj(v); if (o) for (const k of Object.keys(o)) m.set(k, num(o[k])); return m; }
function rowsOut(m: Map<string, number[]>): Obj { const o: Obj = {}; for (const [k, v] of m) o[k] = v; return o; }
function rowsIn(v: unknown, n: number): Map<string, number[]> { const m = new Map<string, number[]>(); const o = obj(v); if (o) for (const k of Object.keys(o)) m.set(k, padTo(nums(o[k]), n)); return m; }
function at(a: number[], i: number): number { let v = 0; for (const x of a.slice(i, i + 1)) v = x; return v; }
function padTo(a: number[], n: number): number[] { while (a.length < n) a.push(0); return a; }
function dayOut(d: Day): Obj {
  const tt: Obj = {};
  for (const [k, s] of d.tt) tt[k] = { n: s.n, e: s.err, dn: s.dn, ms: s.ms, mx: s.max, o: s.out, hi: s.hist, h: s.h, s: recsOut(s.slow), x: recsOut(s.errs) };
  return { t: d.tools, tt, p: cntsOut(d.prog), m: cntsOut(d.cmds), f: cntsOut(d.files), k: cntsOut(d.skills), tu: d.turns, h: d.hours, i: d.inTok, o: d.outTok, r: d.cr, w: d.cw, c: d.cost, u: d.unk, a: d.add, d: d.del,
    um: numMapOut(d.um), uc: d.uc, cp: numMapOut(d.cp), hc: d.hc, mt: rowsOut(d.mt) };
}
function dayIn(o: Obj): Day {
  const tt = new Map<string, TS>();
  const n = obj(o["tt"]);
  if (n) for (const k of Object.keys(n)) {
    const s = obj(n[k]); if (!s) continue;
    tt.set(k, { n: num(s["n"]), err: num(s["e"]), dn: num(s["dn"]), ms: num(s["ms"]), max: num(s["mx"]), out: num(s["o"]), hist: padTo(nums(s["hi"]), HB), h: padTo(nums(s["h"]), 24), slow: recsIn(s["s"]), errs: recsIn(s["x"]) });
  }
  const hours = padTo(nums(o["h"]), 24);
  const hc = padTo(nums(o["hc"]), 24);
  return { tools: num(o["t"]), tt, prog: cntsIn(o["p"]), cmds: cntsIn(o["m"]), files: cntsIn(o["f"]), skills: cntsIn(o["k"]), turns: num(o["tu"]), hours, inTok: num(o["i"]), outTok: num(o["o"]), cr: num(o["r"]), cw: num(o["w"]), cost: num(o["c"]), unk: num(o["u"]), add: num(o["a"]), del: num(o["d"]),
    um: numMapIn(o["um"]), uc: num(o["uc"]), cp: numMapIn(o["cp"]), hc: hc.length > 24 ? hc.slice(0, 24) : hc, mt: rowsIn(o["mt"], 5) };
}
// keepIds: claude dedupe only needs the ids near the resume offset
export function accOut(a: Acc, keepIds = 64): Obj {
  const days: Obj = {};
  for (const k of [...a.days.keys()]) { const d = a.days.get(k); if (d) days[k] = dayOut(d); }
  return {
    off: a.off, skip: a.skip, ep: a.ep, model: a.model, ids: [...a.ids].slice(-keepIds), x: a.x, xM: a.xM, pk: a.pk,
    t: [a.inTok, a.outTok, a.cr, a.cw, a.cost, a.unk, a.tools, a.add, a.del, a.uc], bill: a.bill, plan: a.plan, bs: a.billSrc, days,
  };
}
export function accIn(o: Obj): Acc {
  const t = nums(o["t"]);
  const ids = new Set<string>();
  for (const x of arr(o["ids"])) ids.add(str(x));
  const days = new Map<string, Day>();
  const dd = obj(o["days"]);
  if (dd) for (const k of Object.keys(dd)) { const d = obj(dd[k]); if (d) days.set(k, dayIn(d)); }
  return {
    off: num(o["off"]), skip: o["skip"] === true, stall: -1, ids, days, model: str(o["model"]), pend: new Map<string, Pend>(), ep: str(o["ep"]), x: nums(o["x"]), xM: num(o["xM"]), pk: str(o["pk"]), sub: false,
    inTok: at(t, 0), outTok: at(t, 1), cr: at(t, 2), cw: at(t, 3), cost: at(t, 4), unk: at(t, 5), tools: at(t, 6), add: at(t, 7), del: at(t, 8), uc: at(t, 9),
    bill: str(o["bill"]), plan: str(o["plan"]), billSrc: str(o["bs"]),
  };
}
