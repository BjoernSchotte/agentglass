// agentglass — persists the usage ledger to ~/.agentglass/cache so a restart resumes at the last byte instead of re-indexing every log
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync } from "node:fs";
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
import { rulesNeedRows } from "../rules/file.ts";
import { PRICES_SIG } from "./pricing.ts";
import { VERSION, num, accOut, accIn, rlOut, rlIn } from "./codec.ts";
import { CACHE_DIR, CALLS_DIR, callCutoff, pathKey, prune, saveCallsTo, loadCallsFrom, sweepCalls } from "./callcache.ts";
export { accOut, accIn }; // the ledger codec, for checks that round-trip an Acc

// Runs that never read call rows (`cost`, `sessions`, `session`, plain --json / --watch) read a session's calls file only
// right before that session grows (ledger.ts LAZY), not all of them up front: the rows they save stay whole. A --filter
// or --pinned may need rows; `errors` and `triage` read them (every failed call within their retention).
const GLOBAL = ["--agent", "--no-agent", "--redact"]; // flags of any command (main.ts moves them last)
const ARGV = process.argv.slice(2).filter((a: string) => GLOBAL.indexOf(a) < 0);
function lazyRows(): boolean {
  const filtered = ARGV.indexOf("--filter") >= 0 || ARGV.indexOf("--pinned") >= 0;
  if (ARGV[0] === "cost" || ARGV[0] === "sessions" || ARGV[0] === "session") return !filtered;
  if (ARGV[0] === "triage") return false; // ranks call rows
  const oneShot = ["--json", "--watch"].some((x: string) => ARGV.indexOf(x) >= 0);
  if (!oneShot || filtered) return false;
  // --json alerts / --watch alert lines of a rule on call rows (tool_calls, tool_errors, tool_error_rate)
  return !((ARGV.indexOf("--json") >= 0 || ARGV.indexOf("--watch") >= 0) && ARGV.indexOf("--no-alerts") < 0 && rulesNeedRows());
}
const LAZY_ROWS = lazyRows();
const DIR = CACHE_DIR; // AGENTGLASS_CACHE_DIR or ~/.agentglass/cache
const FILE = join(DIR, "ledger.json");
const KEEP_IDS = 64; // claude dedupe only needs the ids near the resume offset (a message's lines are adjacent)

let loaded = false;
function load(): void {
  loaded = true; savedIdx = L.idx; // nothing to save until something is indexed
  let size = 0;
  try { size = statSync(FILE).size; } catch (e) { return; }
  const root = parse(readText(FILE, 0, size).trim());
  if (!root || num(root["v"]) !== VERSION || str(root["prices"]) !== PRICES_SIG) return; // stale: re-index from scratch
  rlIn(obj(root["rl"]));
  const ss = obj(root["sessions"]);
  if (!ss) return;
  for (const path of Object.keys(ss)) {
    const o = obj(ss[path]); if (!o) continue;
    const a = accIn(o);
    if (!ROWS.on) { ledger.set(path, a); continue; } // no rows built (checks): the day buckets alone are consistent with off
    if (LAZY_ROWS) { ledger.set(path, a); written.set(path, a.off); unread.add(path); continue; } // its calls file, as is, until it grows
    const calls = loadCallsFrom(CALLS_DIR, path, a);
    if (!calls) continue; // no or stale call rows: this session alone re-indexes
    a.calls = calls; a.lastCall = calls.length - 1;
    ledger.set(path, a); written.set(path, a.off);
  }
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
  const ss: Obj = {};
  for (const s of sessions.values()) { const a = ledger.get(s.path); if (a && a.off > 0) ss[s.path] = accOut(a, KEEP_IDS); } // only sessions that still exist
  saveCalls();
  const body = JSON.stringify({ v: VERSION, prices: PRICES_SIG, saved: Date.now(), rl: rlOut(), sessions: ss });
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    const fd = openSync(tmp, "w"); writeSync(fd, body); closeSync(fd);
    renameSync(tmp, FILE); // atomic: a crash mid-write never leaves a torn cache
    savedIdx = L.idx;
  } catch (e) { /* read-only home etc.: keep indexing in memory */ }
}

LAZY.rows = (path: string, a: Acc): boolean => {
  const calls = loadCallsFrom(CALLS_DIR, path, a); if (!calls) return false;
  a.calls = calls; a.lastCall = calls.length - 1; written.set(path, a.off); return true;
};
// head and tail memos live in the session's ledger entry (reset with it when the log is rewritten); never under --redact,
// where a read sees faked texts and a replay could show real ones
if (!REDACT) {
  HEADS.get = (s: Sess): HeadMemo | null => {
    const a = ledger.get(s.path); if (!a || a.hd.length < 3 || a.ep !== s.ep) return null;
    return { w: Number(a.hd[0]), h: Number(a.hd[1]), x: a.hd[2] ?? "", f: a.hd.slice(3) };
  };
  HEADS.put = (s: Sess, m: HeadMemo): void => { const a = accOf(s); a.hd = [String(m.w), String(m.h), m.x].concat(m.f); L.idx++; };
  TAILS.get = (s: Sess): TailMemo | null => {
    const a = ledger.get(s.path); const t = a ? a.tl : []; if (!a || t.length < 6 || a.ep !== s.ep) return null;
    const k = t[2] ?? "";
    return { size: Number(t[0]), x: t[1] ?? "", ev: k ? { kind: k, text: t[3] ?? "", ts: t[4] ?? "", id: t[5] ?? "", full: "" } : null, f: t.slice(6) };
  };
  TAILS.put = (s: Sess, m: TailMemo): void => {
    const a = accOf(s); const e = m.ev;
    a.tl = [String(m.size), m.x, e ? e.kind : "", e ? e.text : "", e ? e.ts : "", e ? e.id : ""].concat(m.f); L.idx++;
  };
}
H.firstScan.push(load); // not at import: --help, --version and the agent help never read it
// a one-shot CLI run keeps what it indexed for the next run (also on an error exit: what was saved is consistent)
process.on("exit", () => { try { save(); } catch (e) { /* never block the exit */ } });
// a save serializes the whole ledger (tens of MB and ~0.5 s of CPU with a long history): every 30 s only while indexing
// (a crash must not lose much of a first index), else every 5 min; quit always saves, a crash re-reads ≤ 5 min of logs
H.onTick.push(() => { if (Date.now() - lastSave > (indexing() ? 30000 : 300000)) { lastSave = Date.now(); save(); } });
H.onQuit.push(save);
