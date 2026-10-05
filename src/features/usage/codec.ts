// agentglass — the ledger cache's JSON shape: Acc/Day ⇄ plain objects (IO lives in ./cache.ts)
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";
import { type Acc, type Day, type VRef, type RlWin, L, type Heavy, HEAVY, newHeavy } from "./record.ts";
import { type Rec, type TS, type Cnt, type Pend, HB } from "./calls.ts";
import { own } from "../../util/own.ts";
import { moOut } from "./owners.ts";
import { newRows } from "./rows.ts";
// every string read back is own()ed: the parser hands escaped strings (each key "<tool>\t<…>") over with up to 64 KB of
// spare capacity, and the loaded ledger lives for the whole run

// bump when log parsing or bucketing changes: stale caches are dropped, not reused
export const VERSION = 15; // 15: cross-file ownership of Claude messages and prompts (Acc.mo as text "mo", Acc.mc, Acc.xs): a fork's, continuation's, second project dir's or forked subagent's copies book nothing, and a forked Codex rollout's copied parent calls and token totals are not its own; v14 caches double count them and re-index; 14: Claude messages booked at their final output_tokens (Acc.ids → booked output_tokens, persisted as io; a message's first, thinking line under-counts it): v12/v13 caches re-index; 13: a day's tool/program/command/file maps as one JSON text "hv", decoded on first use, and the head/tail memos Acc.hd/tl (perf-baseline): a v12 build would read those maps as empty; 12: Gemini calls failed by exit code/response error, their call rows' model, pi /skill uses (harness-correctness); 11: Acc.vcs git refs (git-linkage); 10: Acc.rs reasoning tokens (otlp-export); 9: Day.act active intervals (repo-view), Acc.al; 8: per-call rows (cache/calls/<key>.json, filter-language), Acc.t0; 7: honest-costs day/acc fields after parsing-fixes' 6 — unk = unpriced tokens only, um/uc/cp/hc/mt per day, uc/bill/plan/bs per session; 6: Claude fallback iterations booked per attempt; Day.skills + Day.turns + Acc.pk (parsing-fixes); 5: Acc.ep (source cursor epoch); pi MCP/nested/subagent stats; 4: kiro end_timestamp parsed as ISO (re-dates already booked turns); 3: per-harness running state as x/xM

// older caches re-index (v12/v13 under-count Claude output, v14 double counts copied Claude messages); dayIn still reads v12's inline heavy maps
export function readable(v: number): boolean { return v === VERSION; }
export function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
function strsIn(v: unknown): string[] { const out: string[] = []; for (const x of arr(v)) out.push(own(str(x))); return out; }
function nums(v: unknown): number[] { const out: number[] = []; for (const x of arr(v)) out.push(num(x)); return out; }

// the newest Codex rate limits (L.rl): runtime state the indexing finds, kept with the ledger so a warm start (which
// reads no old codex line) still shows the gauge. {at, ws: [[pct, minutes, reset ms]…]}
export function rlOut(): Obj { return { at: L.rlAt, ws: L.rl.map((w: RlWin) => [w.pct, w.min, w.reset]) }; }
export function rlIn(o: Obj | null): void {
  const at = o ? num(o["at"]) : 0; if (!o || at <= 0 || at < L.rlAt) return; // what this run already indexed is newer
  const ws: RlWin[] = [];
  for (const v of arr(o["ws"])) { const x = nums(v); const w: RlWin = { pct: x[0] ?? 0, min: x[1] ?? 0, reset: x[2] ?? 0 }; if (w.min > 0 && w.reset > 0 && w.pct >= 0 && w.pct <= 100) ws.push(w); }
  if (ws.length) { L.rl = ws; L.rlAt = at; }
}

function recsOut(rs: Rec[]): Obj[] { const out: Obj[] = []; for (const r of rs) out.push({ t: r.t, m: r.ms, i: r.id, s: r.ts, a: r.arg }); return out; }
function recsIn(v: unknown): Rec[] {
  const out: Rec[] = [];
  for (const x of arr(v)) { const o = obj(x); if (o) out.push({ t: num(o["t"]), ms: num(o["m"]), id: own(str(o["i"])), ts: own(str(o["s"])), arg: own(str(o["a"])) }); }
  return out;
}
function cntsOut(m: Map<string, Cnt>): Obj { const o: Obj = {}; for (const [k, c] of m) o[k] = [c.n, c.err, c.add, c.del]; return o; }
function cntsIn(v: unknown): Map<string, Cnt> {
  const m = new Map<string, Cnt>(); const o = obj(v);
  if (o) for (const k of Object.keys(o)) { const a = nums(o[k]); m.set(own(k), { n: at(a, 0), err: at(a, 1), add: at(a, 2), del: at(a, 3) }); }
  return m;
}
function numMapOut(m: Map<string, number>): Obj { const o: Obj = {}; for (const [k, v] of m) o[k] = v; return o; }
function numMapIn(v: unknown): Map<string, number> { const m = new Map<string, number>(); const o = obj(v); if (o) for (const k of Object.keys(o)) m.set(own(k), num(o[k])); return m; }
function rowsOut(m: Map<string, number[]>): Obj { const o: Obj = {}; for (const [k, v] of m) o[k] = v; return o; }
function rowsIn(v: unknown, n: number): Map<string, number[]> { const m = new Map<string, number[]>(); const o = obj(v); if (o) for (const k of Object.keys(o)) m.set(own(k), padTo(nums(o[k]), n)); return m; }
function at(a: number[], i: number): number { let v = 0; for (const x of a.slice(i, i + 1)) v = x; return v; }
function padTo(a: number[], n: number): number[] { while (a.length < n) a.push(0); return a; }
// the heavy part as one JSON text ("hv"): read back without decoding, written out again as it came when never decoded
function heavyOut(x: Heavy): string {
  const tt: Obj = {};
  for (const [k, s] of x.tt) tt[k] = { n: s.n, e: s.err, dn: s.dn, ms: s.ms, mx: s.max, o: s.out, hi: s.hist, h: s.h, s: recsOut(s.slow), x: recsOut(s.errs) };
  return JSON.stringify({ tt, p: cntsOut(x.prog), m: cntsOut(x.cmds), f: cntsOut(x.files) });
}
function heavyIn(raw: string): Heavy { const o = parse(raw); return o ? heavyOf(o) : newHeavy(); }
// the same keys as a day object of a cache written before "hv" (VERSION 12): read at once
function heavyOf(o: Obj): Heavy {
  const tt = new Map<string, TS>();
  const n = obj(o["tt"]);
  if (n) for (const k of Object.keys(n)) {
    const s = obj(n[k]); if (!s) continue;
    tt.set(own(k), { n: num(s["n"]), err: num(s["e"]), dn: num(s["dn"]), ms: num(s["ms"]), max: num(s["mx"]), out: num(s["o"]), hist: padTo(nums(s["hi"]), HB), h: padTo(nums(s["h"]), 24), slow: recsIn(s["s"]), errs: recsIn(s["x"]) });
  }
  return { tt, prog: cntsIn(o["p"]), cmds: cntsIn(o["m"]), files: cntsIn(o["f"]) };
}
HEAVY.decode = heavyIn;
function dayOut(d: Day): Obj {
  return { t: d.tools, hv: d.hx ? heavyOut(d.hx) : d.hv, k: cntsOut(d.skills), tu: d.turns, h: d.hours, i: d.inTok, o: d.outTok, r: d.cr, w: d.cw, c: d.cost, u: d.unk, a: d.add, d: d.del,
    um: numMapOut(d.um), uc: d.uc, cp: numMapOut(d.cp), hc: d.hc, mt: rowsOut(d.mt), ak: d.act };
}
// a stored interval list: even length, bounded, sorted pairs (anything else is dropped rather than trusted)
function actIn(v: unknown): number[] {
  const a = nums(v); if (a.length % 2 || a.length > 400) return [];
  for (let i = 0; i + 1 < a.length; i++) if ((a[i] ?? 0) > (a[i + 1] ?? 0)) return [];
  return a;
}
function dayIn(o: Obj): Day {
  const hours = padTo(nums(o["h"]), 24);
  const hc = padTo(nums(o["hc"]), 24);
  const hv = str(o["hv"]);
  return { tools: num(o["t"]), hx: hv ? null : heavyOf(o), hv: own(hv), skills: cntsIn(o["k"]), turns: num(o["tu"]), hours, inTok: num(o["i"]), outTok: num(o["o"]), cr: num(o["r"]), cw: num(o["w"]), cost: num(o["c"]), unk: num(o["u"]), add: num(o["a"]), del: num(o["d"]),
    um: numMapIn(o["um"]), uc: num(o["uc"]), cp: numMapIn(o["cp"]), hc: hc.length > 24 ? hc.slice(0, 24) : hc, mt: rowsIn(o["mt"], 5), act: actIn(o["ak"]) };
}
// git refs as [k, v, t, how, br, subj, call, ts] tuples
function refsOut(rs: VRef[]): unknown[][] { const out: unknown[][] = []; for (const r of rs) out.push([r.k, r.v, r.t, r.how, r.br, r.subj, r.call, r.ts]); return out; }
function refsIn(v: unknown): VRef[] {
  const out: VRef[] = [];
  for (const x of arr(v)) {
    const t = arr(x); if (t.length < 8) continue;
    const r: VRef = { k: own(str(t[0])), v: own(str(t[1])), t: num(t[2]), how: own(str(t[3])), br: own(str(t[4])), subj: own(str(t[5])), call: own(str(t[6])), ts: own(str(t[7])) };
    if (r.k && r.v && out.length < 200) out.push(r);
  }
  return out;
}
function pairsOut(m: Map<string, string>): string[][] { const out: string[][] = []; for (const [k, v] of m) out.push([k, v]); return out; }
function pairsIn(v: unknown): Map<string, string> { const m = new Map<string, string>(); for (const x of arr(v)) { const t = arr(x); if (t.length !== 2) continue; const k = str(t[0]); if (k) m.set(own(k), own(str(t[1]))); } return m; }
// keepIds: claude dedupe only needs the ids near the resume offset
export function accOut(a: Acc, keepIds = 64): Obj {
  const days: Obj = {};
  for (const k of [...a.days.keys()]) { const d = a.days.get(k); if (d) days[k] = dayOut(d); }
  return {
    off: a.off, skip: a.skip, ep: a.ep, model: a.model, ids: [...a.ids.keys()].slice(-keepIds), io: [...a.ids.values()].slice(-keepIds), x: a.x, xM: a.xM, pk: a.pk,
    t: [a.inTok, a.outTok, a.cr, a.cw, a.cost, a.unk, a.tools, a.add, a.del, a.uc, a.rs], bill: a.bill, plan: a.plan, bs: a.billSrc, t0: a.t0, al: a.al, days, v: refsOut(a.vcs), hd: a.hd, tl: a.tl,
    mo: a.mv || moOut(a.mo), mc: pairsOut(a.mc), xs: [...a.xs],
  };
}
export function accIn(o: Obj): Acc {
  const t = nums(o["t"]);
  const ids = new Map<string, number>(); const io = nums(o["io"]);
  arr(o["ids"]).forEach((x: unknown, i: number) => { ids.set(own(str(x)), at(io, i)); });
  const days = new Map<string, Day>();
  const dd = obj(o["days"]);
  if (dd) for (const k of Object.keys(dd)) { const d = obj(dd[k]); if (d) days.set(own(k), dayIn(d)); }
  return {
    off: num(o["off"]), skip: o["skip"] === true, stall: -1, ids, days, model: own(str(o["model"])), pend: new Map<string, Pend>(), ep: own(str(o["ep"])), x: nums(o["x"]), xM: num(o["xM"]), pk: own(str(o["pk"])), sub: false,
    inTok: at(t, 0), outTok: at(t, 1), cr: at(t, 2), cw: at(t, 3), cost: at(t, 4), unk: at(t, 5), tools: at(t, 6), add: at(t, 7), del: at(t, 8), uc: at(t, 9), rs: at(t, 10),
    bill: own(str(o["bill"])), plan: own(str(o["plan"])), billSrc: own(str(o["bs"])), rows: newRows(), lastCall: -1, t0: num(o["t0"]), al: num(o["al"]), sp: [], vcs: refsIn(o["v"]), dn: [], vk: new Set<string>(), vkn: -1, hd: strsIn(o["hd"]), tl: strsIn(o["tl"]),
    p: "", ro: false, mo: new Map<string, number>(), mv: own(str(o["mo"])), mc: pairsIn(o["mc"]), xs: new Set<string>(strsIn(o["xs"])),
  };
}
