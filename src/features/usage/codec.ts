// agentglass — the ledger cache's JSON shape: Acc/Day ⇄ plain objects (IO lives in ./cache.ts)
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";
import { type Acc, type Day, type VRef, type RlWin, L, type Heavy, HEAVY, newHeavy, NO_SA, NO_SK, NO_LST, NO_SKR, SKV } from "./record.ts";
import { type Rec, type TS, type Cnt, type Pend, HB } from "./calls.ts";
import { own, pooled, pooledText } from "../../util/own.ts";
import { moOut } from "./owners.ts";
import { newRows } from "./rows.ts";
import { type SkLoad, NO_HB, SA_N, hexNum, scopeOf, sizeEst, FNV1, FNV2 } from "./skillrec.ts";
// every string read back is own()ed: the parser hands escaped strings (each key "<tool>\t<…>") over with up to 64 KB of
// spare capacity, and the loaded ledger lives for the whole run

// bump when log parsing or bucketing changes: stale caches are dropped, not reused
export const VERSION = 19; // 19: skill loads + per-skill day buckets (Acc.sk "sk", Day.sa "sa", skill-usage): the loads need the skill text, which only a re-read sees, so older caches re-index; 18: Claude typed prompts (no session_id) follow the session_id of the lines before them, and a background continuation ("sessionKind":"bg") loses ties: a v17 cache loads, but its continuations and the sessions they name re-index (OWN_FIX); 17: Day.tp per-hour priced-token rows (model-prices): caches load across price changes and re-price in place, gemini keys carry their tier tags; 16: a Claude twin under the project dir its cwd names owns the shared messages, not the first path (OWN.home); v15 caches gave a copy's project the tokens and re-index; 15: cross-file ownership of Claude messages and prompts (Acc.mo as text "mo", Acc.mc, Acc.xs): a fork's, continuation's, second project dir's or forked subagent's copies book nothing, and a forked Codex rollout's copied parent calls and token totals are not its own; v14 caches double count them and re-index; 14: Claude messages booked at their final output_tokens (Acc.ids → booked output_tokens, persisted as io; a message's first, thinking line under-counts it): v12/v13 caches re-index; 13: a day's tool/program/command/file maps as one JSON text "hv", decoded on first use, and the head/tail memos Acc.hd/tl (perf-baseline): a v12 build would read those maps as empty; 12: Gemini calls failed by exit code/response error, their call rows' model, pi /skill uses (harness-correctness); 11: Acc.vcs git refs (git-linkage); 10: Acc.rs reasoning tokens (otlp-export); 9: Day.act active intervals (repo-view), Acc.al; 8: per-call rows (cache/calls/<key>.json, filter-language), Acc.t0; 7: honest-costs day/acc fields after parsing-fixes' 6 — unk = unpriced tokens only, um/uc/cp/hc/mt per day, uc/bill/plan/bs per session; 6: Claude fallback iterations booked per attempt; Day.skills + Day.turns + Acc.pk (parsing-fixes); 5: Acc.ep (source cursor epoch); pi MCP/nested/subagent stats; 4: kiro end_timestamp parsed as ISO (re-dates already booked turns); 3: per-harness running state as x/xM

// older caches re-index (v18 and before hold no skill loads); dayIn still reads v12's inline heavy maps
export function readable(v: number): boolean { return v === VERSION; }
export function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
function poolIn(v: unknown): string[] { const out: string[] = []; for (const x of arr(v)) out.push(pooled(str(x))); return out; } // few distinct values
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
// Day.sa rows: each into an SA_N literal (exact capacity: a grown array keeps twice the slots); stored as one JSON text
// ("sa"), decoded on first use (record.ts saOf)
function saIn(v: unknown): Map<string, number[]> {
  const o = obj(v); if (!o) return NO_SA;
  const m = new Map<string, number[]>();
  for (const k of Object.keys(o)) {
    const r = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; const xs = arr(o[k]);
    for (let i = 0; i < SA_N && i < xs.length; i++) r[i] = num(xs[i]);
    m.set(pooled(k), r);
  }
  return m;
}
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
HEAVY.decode = heavyIn; HEAVY.encode = heavyOut;
function dayOut(d: Day): Obj {
  const o: Obj = { t: d.tools, hv: d.hx ? heavyOut(d.hx) : d.hv, k: cntsOut(d.skills), tu: d.turns, h: d.hours, i: d.inTok, o: d.outTok, r: d.cr, w: d.cw, c: d.cost, u: d.unk, a: d.add, d: d.del,
    um: numMapOut(d.um), uc: d.uc, cp: numMapOut(d.cp), hc: d.hc, mt: rowsOut(d.mt), ak: d.act, tp: rowsOut(d.tp) };
  if (d.sav) o["sa"] = d.sav; else if (d.sa.size) o["sa"] = JSON.stringify(rowsOut(d.sa));
  return o;
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
    um: numMapIn(o["um"]), uc: num(o["uc"]), cp: numMapIn(o["cp"]), hc: hc.length > 24 ? hc.slice(0, 24) : hc, mt: rowsIn(o["mt"], 5), act: actIn(o["ak"]), tp: rowsIn(o["tp"], 6),
    sa: typeof o["sa"] === "object" ? saIn(o["sa"]) : NO_SA, sav: typeof o["sa"] === "string" ? own(str(o["sa"])) : "" }; // object: a cache before the text form
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
// skill loads: one flat number array (SKW numbers per load) and string tables (names, directories, hashes, record ids,
// "model\tprovider"), each load an index into them: a few JSON nodes per log however many loads (a parse tree per field
// and load cost more than the loads). No text, ever
const TRIGS = ["user", "model", "compact", "listing"]; const WHYS = ["", "compact", "clear", "drop", "relist"];
const SKW = 41; // [nm, trig, t, tu, te, rq0, bytes, S, dr, end, why, flags, short, nq, hu, ht, off, len, n, pg, hl, h, r, mp, cid, lt×4, ct×4, tt×4, hb×4]
function idxOf(tab: string[], m: Map<string, number>, v: string): number { let i = m.get(v); if (i === undefined) { i = tab.length; tab.push(v); m.set(v, i); } return i; }
function skOut(sk: SkLoad[]): Obj {
  const nm: string[] = []; const nmI = new Map<string, number>(); const dr: string[] = []; const drI = new Map<string, number>();
  const hs: string[] = []; const hsI = new Map<string, number>(); const rs: string[] = []; const rsI = new Map<string, number>(); const mp: string[] = []; const mpI = new Map<string, number>();
  const cs: string[] = [""]; const csI = new Map<string, number>(); csI.set("", 0); // call ids: index 0 = none (older rows hold 0 there)
  const x: number[] = [];
  for (const l of sk) {
    const f = (l.rel ? 1 : 0) + (l.stub ? 2 : 0) + (l.pend ? 4 : 0) + (l.est ? 8 : 0) + (l.rd ? 16 : 0);
    const row = [idxOf(nm, nmI, l.name), TRIGS.indexOf(l.trig), l.t, l.tu, l.te, l.rq0, l.bytes, l.S, idxOf(dr, drI, l.dir), l.end, WHYS.indexOf(l.why), f, l.short, l.nq, l.hu, l.ht, l.off, l.len, l.n, l.pg, l.hl,
      idxOf(hs, hsI, l.hash), idxOf(rs, rsI, l.rec), idxOf(mp, mpI, l.mdl + "\t" + l.prov), idxOf(cs, csI, l.cid)];
    for (const v of row) x.push(v);
    for (let k = 0; k < 4; k++) x.push(l.lt[k] ?? 0);
    for (let k = 0; k < 4; k++) x.push(l.ct[k] ?? 0);
    for (let k = 0; k < 4; k++) x.push(l.tt[k] ?? 0);
    for (let k = 0; k < 4; k++) x.push(l.hb[k] ?? 0);
  }
  const o: Obj = { nm, dr, h: hs, r: rs, mp, x }; if (cs.length > 1) o["c"] = cs;
  return o;
}
// a pre-release VERSION 19 cache stored the loads as columns: that log re-indexes (cache.ts)
export function skStale(o: Obj): boolean { const s = obj(o["sk"]); return s !== null && s["x"] === undefined; }
// the skill split (cache head "sk"): 1 = loads sent with one request share its growth in proportion (§3.2), and a Codex
// SKILL.md read is the file's text (no envelope; several files of one call each their own). A VERSION 19 cache without it
// (dev builds before 2026.10.12) has the old numbers in such logs: they re-index, once (the next save writes the head)
export const SK_SPLIT = 1;
// ≥ 2 loads sent with one request (the same rq0: requests booked before each) of which one got less than its estimate
// (the bound cut it): its split may be wrong; codex: a Codex rollout with a SKILL.md read. Read from the stored columns,
// no SkLoad built
export function skSplitStale(o: Obj, codex: boolean): boolean {
  const v = o["sk"]; const s = typeof v === "string" ? obj(parse(str(v))) : null; if (!s) return false;
  const x = nums(s["x"]); const mp = strsIn(s["mp"]);
  const n = new Map<number, number>(); const cut = new Set<number>();
  for (let i = 0; i + SKW <= x.length; i += SKW) {
    if (codex && (at(x, i + 11) & 16) !== 0) return true;
    const bytes = at(x, i + 6); if (bytes < 0 || at(x, i + 18) > 1 || (at(x, i + 11) & 4) !== 0) continue; // size unknown, folded, not sent
    const rq = at(x, i + 5); n.set(rq, (n.get(rq) ?? 0) + 1);
    const m = mp[at(x, i + 23)] ?? ""; const tab = m.indexOf("\t");
    if (at(x, i + 7) < sizeEst(bytes, tab >= 0 ? m.slice(0, tab) : m)) cut.add(rq);
  }
  for (const rq of cut) if ((n.get(rq) ?? 0) > 1) return true;
  return false;
}
// stored as one JSON text ("sk", the layout above), decoded on first use (record.ts skOf); an object: a cache before that
function skIn(v: unknown): SkLoad[] {
  const o = obj(v); if (!o) return NO_SK;
  const out: SkLoad[] = [];
  const nm = poolIn(o["nm"]); const dr = poolIn(o["dr"]); const hs = poolIn(o["h"]); const rs = strsIn(o["r"]); const mp = poolIn(o["mp"]); const x = nums(o["x"]); const cs = strsIn(o["c"]);
  const four = (i: number): number[] => [at(x, i), at(x, i + 1), at(x, i + 2), at(x, i + 3)];
  for (let i = 0; i + SKW <= x.length && out.length < 2000; i += SKW) {
    const name = nm[at(x, i)] ?? ""; if (!name) continue;
    const fl = at(x, i + 11); const hash = hs[at(x, i + 21)] ?? ""; const m = mp[at(x, i + 23)] ?? ""; const tab = m.indexOf("\t"); const dir = dr[at(x, i + 8)] ?? "";
    const hb = at(x, i + 37) + at(x, i + 38) + at(x, i + 39) + at(x, i + 40) > 0 ? four(i + 37) : NO_HB;
    out.push({ name, trig: TRIGS[at(x, i + 1)] ?? "model", t: at(x, i + 2), tu: at(x, i + 3), te: at(x, i + 4), rq0: at(x, i + 5), bytes: at(x, i + 6), S: at(x, i + 7), hash,
      dir, scope: pooled(scopeOf(dir)), end: at(x, i + 9), why: WHYS[at(x, i + 10)] ?? "", rel: (fl & 1) !== 0, stub: (fl & 2) !== 0, pend: (fl & 4) !== 0, short: at(x, i + 12), nq: at(x, i + 13),
      lt: four(i + 25), ct: four(i + 29), tt: four(i + 33), hb, hu: at(x, i + 14), hl: at(x, i + 20), ht: at(x, i + 15), off: at(x, i + 16), len: at(x, i + 17), rec: rs[at(x, i + 22)] ?? "",
      mdl: pooled(tab >= 0 ? m.slice(0, tab) : m), prov: pooled(tab >= 0 ? m.slice(tab + 1) : ""), est: (fl & 8) !== 0, n: Math.max(1, at(x, i + 18)), rd: (fl & 16) !== 0,
      h1: hexNum(hash.slice(0, 8), FNV1), h2: hexNum(hash.slice(8, 16), FNV2), pg: at(x, i + 19), cid: cs[at(x, i + 24)] ?? "" });
  }
  return out.length ? out : NO_SK;
}
SKV.loads = (raw: string): SkLoad[] => skIn(parse(raw)); SKV.rows = (raw: string): Map<string, number[]> => saIn(parse(raw));
// the skill names of loads stored as text, no load decoded: the name pool skOut writes first, else the whole object
SKV.names = (raw: string): string[] => {
  const k = raw.startsWith("{\"nm\":[") ? raw.indexOf("],\"dr\":") : -1;
  const o = parse(k > 0 ? raw.slice(0, k + 1) + "}" : raw); return o ? poolIn(o["nm"]) : [];
};
// keepIds: claude dedupe only needs the ids near the resume offset
export function accOut(a: Acc, keepIds = 64): Obj {
  const days: Obj = {};
  for (const k of [...a.days.keys()]) { const d = a.days.get(k); if (d) days[k] = dayOut(d); }
  const o: Obj = {
    off: a.off, skip: a.skip, ep: a.ep, model: a.model, ids: [...a.ids.keys()].slice(-keepIds), io: [...a.ids.values()].slice(-keepIds), x: a.x, xM: a.xM, pk: a.pk,
    t: [a.inTok, a.outTok, a.cr, a.cw, a.cost, a.unk, a.tools, a.add, a.del, a.uc, a.rs], bill: a.bill, plan: a.plan, bs: a.billSrc, t0: a.t0, al: a.al, days, v: refsOut(a.vcs), hd: a.hd, tl: a.tl,
    mo: a.mv || moOut(a.mo), mc: pairsOut(a.mc), xs: [...a.xs],
    sq: [a.rq, a.tq, a.lastCtx],
  };
  if (a.lst.length) o["ls"] = a.lst.join("\n"); // one string: most logs list the same skills (pooledText shares the array)
  if (a.skv) o["sk"] = a.skv; else if (a.sk.length) o["sk"] = JSON.stringify(skOut(a.sk)); // sessions without skills grow by nothing but sq
  return o;
}
export function accIn(o: Obj): Acc {
  const t = nums(o["t"]); const sq = nums(o["sq"]);
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
    sk: typeof o["sk"] === "object" ? skIn(o["sk"]) : NO_SK, skv: typeof o["sk"] === "string" ? own(str(o["sk"])) : "", rq: at(sq, 0), tq: at(sq, 1), lastCtx: at(sq, 2), lst: typeof o["ls"] === "string" && o["ls"] ? pooledText(str(o["ls"])) : NO_LST, skr: NO_SKR,
  };
}
