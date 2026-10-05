// agentglass — persists the usage ledger to ~/.agentglass/cache so a restart resumes at the last byte instead of re-indexing every log
// SPDX-License-Identifier: Apache-2.0
import { statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, parse } from "../../util/json.ts";
import { readText } from "../../util/fs.ts";
import { H } from "../../hooks.ts";
import { sessions, HEADS, TAILS, type HeadMemo, type TailMemo } from "../../model/sessions.ts";
import type { Sess } from "../../model/types.ts";
import { ledger, indexing, unread, LAZY, accOf } from "./ledger.ts";
import { REDACT } from "../redact-on.ts";
import { type Acc, L } from "./record.ts";
import { ROWS } from "./facts.ts";
import { PRICES_SIG } from "./pricing.ts";
import { VERSION, readable, num, accOut, accIn, rlOut, rlIn } from "./codec.ts";
import { readCache, writeCache } from "./cachefile.ts";
import { CACHE_DIR, CALLS_DIR, callCutoff, pathKey, prune, saveCallsTo, loadCallsFrom, sweepCalls } from "./callcache.ts";
export { accOut, accIn }; // the ledger codec, for checks that round-trip an Acc

// Every run reads a session's calls file only when something asks for its rows (ledger.ts callsOf) or right before the
// session grows (ledger.ts LAZY), never all of them up front: the rows it saves stay whole.
const DIR = CACHE_DIR; // AGENTGLASS_CACHE_DIR or ~/.agentglass/cache
// one header line + one line per session, streamed (cachefile.ts); ledger.json = the one-object file of 2026.10.4 and
// before, read once to migrate (no re-index on upgrade) and removed after the first save of FILE
const FILE = join(DIR, "ledger.jsonl");
const OLD = join(DIR, "ledger.json");
const KEEP_IDS = 64; // claude dedupe only needs the ids near the resume offset (a message's lines are adjacent)

let loaded = false;
function mtime(p: string): number { try { return statSync(p).mtimeMs; } catch (e) { return -1; } }
function load(): void {
  loaded = true; savedIdx = L.idx; // nothing to save until something is indexed
  lastSave = Date.now(); // the save clock starts here: a warm start has nothing new to write on its first tick
  // the old file only when it is newer (none yet, or an older build ran since and wrote it): what it holds is current
  if (mtime(OLD) > mtime(FILE)) { loadOld(); if (ledger.size) L.idx++; return; } // the next save writes FILE and drops OLD
  readCache(FILE, (h) => { if (!readable(h.v) || h.prices !== PRICES_SIG) return false; rlIn(h.rl); return true; }, install);
}
// one session of a readable cache; a line the reader could not use was skipped: that session alone re-indexes
function install(path: string, o: Obj): void {
  const a = accIn(o);
  if (!ROWS.on) { ledger.set(path, a); return; } // no rows built (checks): the day buckets alone are consistent with off
  ledger.set(path, a); written.set(path, a.off); unread.add(path); // its calls file, as is, until asked for or it grows
}
function loadOld(): void {
  let size = 0;
  try { size = statSync(OLD).size; } catch (e) { return; }
  const root = parse(readText(OLD, 0, size).trim());
  const v = root ? num(root["v"]) : 0;
  if (!root || !readable(v) || str(root["prices"]) !== PRICES_SIG) return; // stale: re-index from scratch
  rlIn(obj(root["rl"]));
  const ss = obj(root["sessions"]);
  if (!ss) return;
  for (const path of Object.keys(ss)) { const o = obj(ss[path]); if (o) install(path, o); }
}
// ledger offset each session's calls file was last written at (= consistent with)
const written = new Map<string, number>();
// call rows first: a crash before ledger.json leaves a calls file with a newer off → mismatch → that session re-indexes
function saveCalls(): void {
  const cut = callCutoff(); const keys = new Set<string>();
  for (const s of sessions.values()) {
    const a = ledger.get(s.path); if (!a || a.off <= 0) continue;
    keys.add(pathKey(s.path));
    const pr = prune(a, cut);
    if ((pr || written.get(s.path) !== a.off) && saveCallsTo(CALLS_DIR, s.path, a)) written.set(s.path, a.off);
  }
  sweepCalls(CALLS_DIR, keys);
}
let savedIdx = -1; let lastSave = 0;
function save(): void {
  if (!loaded || L.idx === savedIdx || !ROWS.on) return; // without rows a save would leave calls files behind the ledger
  saveCalls();
  const ok = writeCache(FILE, { v: VERSION, prices: PRICES_SIG, rl: rlOut() }, (put: (path: string, o: Obj) => void): void => {
    for (const s of sessions.values()) { const a = ledger.get(s.path); if (a && a.off > 0) put(s.path, accOut(a, KEEP_IDS)); } // only sessions that still exist
  });
  if (!ok) return; // read-only home etc.: keep indexing in memory
  savedIdx = L.idx;
  if (existsSync(OLD)) { try { unlinkSync(OLD); } catch (e) { /* the newer FILE wins at the next load anyway */ } }
}

LAZY.rows = (path: string, a: Acc): boolean => {
  const rows = loadCallsFrom(CALLS_DIR, path, a); if (!rows) return false;
  a.rows = rows; a.lastCall = rows.n - 1; written.set(path, a.off); return true;
};
// head and tail memos live in the session's ledger entry (reset with it when the log is rewritten); never under --redact,
// where a read sees faked texts and a replay could show real ones
if (!REDACT) {
  // none for a log that shrank below what the ledger booked (rewritten: accOf starts that entry over)
  const entry = (s: Sess): Acc | null => { const a = ledger.get(s.path); return a && a.ep === s.ep && s.size >= a.off ? a : null; };
  HEADS.get = (s: Sess): HeadMemo | null => {
    const a = entry(s); if (!a || a.hd.length < 5) return null;
    return { w: Number(a.hd[0]), h: Number(a.hd[1]), z: Number(a.hd[2]), t: Number(a.hd[3]), x: a.hd[4] ?? "", f: a.hd.slice(5) };
  };
  HEADS.put = (s: Sess, m: HeadMemo): void => { const a = accOf(s); a.hd = [String(m.w), String(m.h), String(m.z), String(m.t), m.x].concat(m.f); L.idx++; };
  TAILS.get = (s: Sess): TailMemo | null => {
    const a = entry(s); const t = a ? a.tl : []; if (!a || t.length < 7) return null;
    const k = t[3] ?? "";
    return { size: Number(t[0]), t: Number(t[1]), x: t[2] ?? "", ev: k ? { kind: k, text: t[4] ?? "", ts: t[5] ?? "", id: t[6] ?? "", full: "" } : null, f: t.slice(7) };
  };
  TAILS.put = (s: Sess, m: TailMemo): void => {
    const a = accOf(s); const e = m.ev;
    a.tl = [String(m.size), String(m.t), m.x, e ? e.kind : "", e ? e.text : "", e ? e.ts : "", e ? e.id : ""].concat(m.f); L.idx++;
  };
}
H.firstScan.push(load); // not at import: --help, --version and the agent help never read it
// a one-shot CLI run keeps what it indexed for the next run (also on an error exit: what was saved is consistent)
process.on("exit", () => { try { save(); } catch (e) { /* never block the exit */ } });
// a save serializes the whole ledger (tens of MB written, ~0.5 s of CPU with a long history; one session's line in memory
// at a time): only when something was indexed, every 30 s while indexing (a crash must not lose much of a first index),
// else every 5 min, never on the first tick (the clock starts at load); quit always saves, a crash re-reads ≤ 5 min of logs
H.onTick.push(() => { if (Date.now() - lastSave > (indexing() ? 30000 : 300000)) { lastSave = Date.now(); save(); } });
H.onQuit.push(save);
