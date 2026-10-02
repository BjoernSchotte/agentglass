// agentglass — persists the usage ledger to ~/.agentglass/cache so a restart resumes at the last byte instead of re-indexing every log
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";
import { HOME, readText } from "../../util/fs.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, indexing } from "./ledger.ts";
import { L, type Acc, type Day } from "./record.ts";
import { PRICES_SIG } from "./pricing.ts";
import { type Rec, type TS, type Cnt, type Pend, HB } from "./calls.ts";

// bump when log parsing or bucketing changes: stale caches are dropped, not reused
const VERSION = 5; // 5: Acc.ep (source cursor epoch); pi MCP/nested/subagent stats; 4: kiro end_timestamp parsed as ISO (re-dates already booked turns); 3: per-harness running state as x/xM
// AGENTGLASS_CACHE_DIR: a separate ledger cache (test builds of other branches must not rewrite the real one)
const DIR = process.env.AGENTGLASS_CACHE_DIR || join(HOME, ".agentglass", "cache");
const FILE = join(DIR, "ledger.json");
const KEEP_IDS = 64; // claude dedupe only needs the ids near the resume offset (a message's lines are adjacent)

function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
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
function at(a: number[], i: number): number { let v = 0; for (const x of a.slice(i, i + 1)) v = x; return v; }
function padTo(a: number[], n: number): number[] { while (a.length < n) a.push(0); return a; }
function dayOut(d: Day): Obj {
  const tt: Obj = {};
  for (const [k, s] of d.tt) tt[k] = { n: s.n, e: s.err, dn: s.dn, ms: s.ms, mx: s.max, o: s.out, hi: s.hist, h: s.h, s: recsOut(s.slow), x: recsOut(s.errs) };
  return { t: d.tools, tt, p: cntsOut(d.prog), m: cntsOut(d.cmds), f: cntsOut(d.files), h: d.hours, i: d.inTok, o: d.outTok, r: d.cr, w: d.cw, c: d.cost, u: d.unk, a: d.add, d: d.del };
}
function dayIn(o: Obj): Day {
  const tt = new Map<string, TS>();
  const n = obj(o["tt"]);
  if (n) for (const k of Object.keys(n)) {
    const s = obj(n[k]); if (!s) continue;
    tt.set(k, { n: num(s["n"]), err: num(s["e"]), dn: num(s["dn"]), ms: num(s["ms"]), max: num(s["mx"]), out: num(s["o"]), hist: padTo(nums(s["hi"]), HB), h: padTo(nums(s["h"]), 24), slow: recsIn(s["s"]), errs: recsIn(s["x"]) });
  }
  const hours = padTo(nums(o["h"]), 24);
  return { tools: num(o["t"]), tt, prog: cntsIn(o["p"]), cmds: cntsIn(o["m"]), files: cntsIn(o["f"]), hours, inTok: num(o["i"]), outTok: num(o["o"]), cr: num(o["r"]), cw: num(o["w"]), cost: num(o["c"]), unk: num(o["u"]), add: num(o["a"]), del: num(o["d"]) };
}
function accOut(a: Acc): Obj {
  const days: Obj = {};
  for (const k of [...a.days.keys()]) { const d = a.days.get(k); if (d) days[k] = dayOut(d); }
  return {
    off: a.off, skip: a.skip, ep: a.ep, model: a.model, ids: [...a.ids].slice(-KEEP_IDS), x: a.x, xM: a.xM,
    t: [a.inTok, a.outTok, a.cr, a.cw, a.cost, a.unk, a.tools, a.add, a.del], days,
  };
}
function accIn(o: Obj): Acc {
  const t = nums(o["t"]);
  const at = (i: number): number => { let v = 0; for (const x of t.slice(i, i + 1)) v = x; return v; };
  const ids = new Set<string>();
  for (const x of arr(o["ids"])) ids.add(str(x));
  const days = new Map<string, Day>();
  const dd = obj(o["days"]);
  if (dd) for (const k of Object.keys(dd)) { const d = obj(dd[k]); if (d) days.set(k, dayIn(d)); }
  return {
    off: num(o["off"]), skip: o["skip"] === true, stall: -1, ids, days, model: str(o["model"]), pend: new Map<string, Pend>(), ep: str(o["ep"]), x: nums(o["x"]), xM: num(o["xM"]),
    inTok: at(0), outTok: at(1), cr: at(2), cw: at(3), cost: at(4), unk: at(5), tools: at(6), add: at(7), del: at(8),
  };
}

function load(): void {
  let size = 0;
  try { size = statSync(FILE).size; } catch (e) { return; }
  const root = parse(readText(FILE, 0, size).trim());
  if (!root || num(root["v"]) !== VERSION || str(root["prices"]) !== PRICES_SIG) return; // stale: re-index from scratch
  const ss = obj(root["sessions"]);
  if (ss) for (const path of Object.keys(ss)) { const o = obj(ss[path]); if (o) ledger.set(path, accIn(o)); }
}
let savedVer = -1; let lastSave = 0;
function save(): void {
  if (L.ver === savedVer) return;
  const ss: Obj = {};
  for (const s of sessions.values()) { const a = ledger.get(s.path); if (a && a.off > 0) ss[s.path] = accOut(a); } // only sessions that still exist
  const body = JSON.stringify({ v: VERSION, prices: PRICES_SIG, saved: Date.now(), sessions: ss });
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    const fd = openSync(tmp, "w"); writeSync(fd, body); closeSync(fd);
    renameSync(tmp, FILE); // atomic: a crash mid-write never leaves a torn cache
    savedVer = L.ver;
  } catch (e) { /* read-only home etc.: keep indexing in memory */ }
}

load();
// a save serializes the whole ledger (tens of MB and ~0.5 s of CPU with a long history): every 30 s only while indexing
// (a crash must not lose much of a first index), else every 5 min; quit always saves, a crash re-reads ≤ 5 min of logs
H.onTick.push(() => { if (Date.now() - lastSave > (indexing() ? 30000 : 300000)) { lastSave = Date.now(); save(); } });
H.onQuit.push(save);
