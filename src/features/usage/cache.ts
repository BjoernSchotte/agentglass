// agentglass — persists the usage ledger to ~/.agentglass/cache so a restart resumes at the last byte instead of re-indexing every log
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";
import { HOME, readText } from "../../util/fs.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, L, type Acc, type Day } from "./ledger.ts";
import { PRICES_SIG } from "./pricing.ts";

// bump when log parsing or bucketing changes: stale caches are dropped, not reused
const VERSION = 1;
const DIR = join(HOME, ".agentglass", "cache");
const FILE = join(DIR, "ledger.json");
const KEEP_IDS = 64; // claude dedupe only needs the ids near the resume offset (a message's lines are adjacent)

function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
function nums(v: unknown): number[] { const out: number[] = []; for (const x of arr(v)) out.push(num(x)); return out; }

function dayOut(d: Day): Obj {
  const names: Obj = {};
  for (const k of [...d.names.keys()]) names[k] = d.names.get(k) ?? 0;
  return { t: d.tools, n: names, h: d.hours, i: d.inTok, o: d.outTok, r: d.cr, w: d.cw, c: d.cost, u: d.unk, a: d.add, d: d.del };
}
function dayIn(o: Obj): Day {
  const names = new Map<string, number>();
  const n = obj(o["n"]);
  if (n) for (const k of Object.keys(n)) names.set(k, num(n[k]));
  const hours = nums(o["h"]);
  while (hours.length < 24) hours.push(0);
  return { tools: num(o["t"]), names, hours, inTok: num(o["i"]), outTok: num(o["o"]), cr: num(o["r"]), cw: num(o["w"]), cost: num(o["c"]), unk: num(o["u"]), add: num(o["a"]), del: num(o["d"]) };
}
function accOut(a: Acc): Obj {
  const days: Obj = {};
  for (const k of [...a.days.keys()]) { const d = a.days.get(k); if (d) days[k] = dayOut(d); }
  return {
    off: a.off, skip: a.skip, model: a.model, ids: [...a.ids].slice(-KEEP_IDS), cx: a.cx, fx: a.fx, fxM: a.fxM,
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
  const cx = nums(o["cx"]); while (cx.length < 4) cx.push(0);
  const fx = nums(o["fx"]); while (fx.length < 7) fx.push(0);
  return {
    off: num(o["off"]), skip: o["skip"] === true, stall: -1, ids, days, model: str(o["model"]), cx, fx, fxM: num(o["fxM"]),
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
H.onTick.push(() => { if (Date.now() - lastSave > 30000) { lastSave = Date.now(); save(); } });
H.onQuit.push(save);
