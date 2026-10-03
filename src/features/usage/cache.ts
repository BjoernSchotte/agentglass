// agentglass — persists the usage ledger to ~/.agentglass/cache so a restart resumes at the last byte instead of re-indexing every log
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, parse } from "../../util/json.ts";
import { readText } from "../../util/fs.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, indexing } from "./ledger.ts";
import { L } from "./record.ts";
import { ROWS } from "./facts.ts";
import { rulesNeedRows } from "../rules/file.ts";
import { PRICES_SIG } from "./pricing.ts";
import { VERSION, num, accOut, accIn } from "./codec.ts";
import { CACHE_DIR, CALLS_DIR, callCutoff, pathKey, prune, saveCallsTo, loadCallsFrom, sweepCalls } from "./callcache.ts";
export { accOut, accIn }; // the ledger codec, for checks that round-trip an Acc

// One-shot runs that never read call rows and never save (`cost`, plain --json / --watch, --help, --version) neither load
// nor build them: on a long history that is ~150 MB of a cold --json. A --filter or --pinned may need rows (and saves).
const ARGV = process.argv.slice(2);
function rowless(): boolean {
  if (ARGV[0] === "cost") return true;
  const oneShot = ["--json", "--watch", "--help", "-h", "--version"].some((x: string) => ARGV.indexOf(x) >= 0);
  if (!oneShot || ARGV.indexOf("--filter") >= 0 || ARGV.indexOf("--pinned") >= 0) return false;
  // --json alerts / --watch alert lines of a rule on call rows (tool_calls, tool_errors, tool_error_rate)
  return !((ARGV.indexOf("--json") >= 0 || ARGV.indexOf("--watch") >= 0) && ARGV.indexOf("--no-alerts") < 0 && rulesNeedRows());
}
if (rowless()) ROWS.on = false;
const DIR = CACHE_DIR; // AGENTGLASS_CACHE_DIR or ~/.agentglass/cache
const FILE = join(DIR, "ledger.json");
const KEEP_IDS = 64; // claude dedupe only needs the ids near the resume offset (a message's lines are adjacent)

function load(): void {
  let size = 0;
  try { size = statSync(FILE).size; } catch (e) { return; }
  const root = parse(readText(FILE, 0, size).trim());
  if (!root || num(root["v"]) !== VERSION || str(root["prices"]) !== PRICES_SIG) return; // stale: re-index from scratch
  const ss = obj(root["sessions"]);
  if (!ss) return;
  for (const path of Object.keys(ss)) {
    const o = obj(ss[path]); if (!o) continue;
    const a = accIn(o);
    if (!ROWS.on) { ledger.set(path, a); continue; } // no rows wanted: the day buckets alone are consistent with off
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
let savedVer = -1; let lastSave = 0;
function save(): void {
  if (L.ver === savedVer || !ROWS.on) return; // without rows a save would leave calls files behind the ledger
  const ss: Obj = {};
  for (const s of sessions.values()) { const a = ledger.get(s.path); if (a && a.off > 0) ss[s.path] = accOut(a, KEEP_IDS); } // only sessions that still exist
  saveCalls();
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
