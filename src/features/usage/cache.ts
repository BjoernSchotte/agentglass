// agentglass — persists the usage ledger to ~/.agentglass/cache so a restart resumes at the last byte instead of re-indexing every log
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, parse } from "../../util/json.ts";
import { HOME, readText } from "../../util/fs.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, indexing } from "./ledger.ts";
import { L } from "./record.ts";
import { PRICES_SIG } from "./pricing.ts";
import { VERSION, num, accOut, accIn } from "./codec.ts";
export { accOut, accIn }; // the ledger codec, for checks that round-trip an Acc

// AGENTGLASS_CACHE_DIR: a separate ledger cache (test builds of other branches must not rewrite the real one)
const DIR = process.env.AGENTGLASS_CACHE_DIR || join(HOME, ".agentglass", "cache");
const FILE = join(DIR, "ledger.json");
const KEEP_IDS = 64; // claude dedupe only needs the ids near the resume offset (a message's lines are adjacent)

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
  for (const s of sessions.values()) { const a = ledger.get(s.path); if (a && a.off > 0) ss[s.path] = accOut(a, KEEP_IDS); } // only sessions that still exist
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
