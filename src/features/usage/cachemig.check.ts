// agentglass — self-check: a cache of an older VERSION (18: no skill loads; 17) is not loaded, everything re-indexes once;
// a current one loads; one written before SK_SPLIT re-indexes only the logs whose parallel skill loads it split in load
// order: scriptc build src/features/usage/cachemig.check.ts -o cm && ./cm
// SPDX-License-Identifier: Apache-2.0
// Runs under check.sh's temp HOME: the cache lives in $HOME/.agentglass/cache.
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { H } from "../../hooks.ts";
import { cacheDir } from "../../util/fs.ts";
import { ledger } from "./ledger.ts";
import { accOut } from "./cache.ts";
import { VERSION, readable, SK_SPLIT } from "./codec.ts";
import { writeCache } from "./cachefile.ts";
import { sizeEst } from "./skillrec.ts";
import { ROWS } from "./facts.ts";
import { newAcc, bucket, tokens, skillLoad, L } from "./record.ts";
import { pricesSig } from "./pricing.ts";
import type { Obj } from "../../util/json.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
if (!process.env.AGENTGLASS_HERMETIC) { console.log("cachemig: skipped (needs check.sh's temp HOME)"); process.exit(0); }

ok("VERSION 19", VERSION === 19, String(VERSION));
ok("reads 19 only", readable(19) && !readable(18) && !readable(17) && !readable(20), "");
const dir = "/w/.claude/projects/-w-app/";
const acc = (): unknown => { const a = newAcc(); a.off = 100; tokens(a, bucket(a, 0, "2026-10-01T09:30:00.000Z"), "claude-sonnet-4-5", 10, 1, 0, 0, 0); return accOut(a, 64); };
const ss: Record<string, unknown> = {};
ss[dir + "aaaaaaaa-0000-4000-8000-000000000001.jsonl"] = acc();
ss["/w/.codex/sessions/rollout-x.jsonl"] = acc();
mkdirSync(cacheDir(), { recursive: true });
ROWS.on = false;
for (const v of [18, 17, 19]) {
  writeFileSync(join(cacheDir(), "ledger.json"), JSON.stringify({ v, prices: pricesSig(), kiro: 0, saved: Date.now(), rl: {}, sessions: ss }));
  ledger.clear();
  for (const f of H.firstScan) f();
  const n = (ledger.has(dir + "aaaaaaaa-0000-4000-8000-000000000001.jsonl") ? 1 : 0) + (ledger.has("/w/.codex/sessions/rollout-x.jsonl") ? 1 : 0);
  ok("v" + String(v) + (v === 19 ? ": loads" : ": re-indexes"), n === (v === 19 ? 2 : 0), String(n));
}

// SK_SPLIT: loads sent with one request (same rq0) shared its growth in load order before; a log where the bound cut one of
// them re-indexes, once; a log whose parallel loads fit, or with one cut load alone, keeps its entry
const M = "claude-sonnet-4-5";
function skAcc(rqs: number[], cut: number[]): Obj {
  const a = newAcc(); a.off = 100; tokens(a, bucket(a, 0, "2026-10-01T09:30:00.000Z"), M, 10, 1, 0, 0, 0);
  for (let i = 0; i < rqs.length; i++) {
    a.rq = (rqs[i] ?? 0) + 0; // + 0: a bare array read stored into the fresh record lost its later fields (scriptc)
    const l = skillLoad(a, "s" + String(i), "model", 0, "2026-10-01T09:30:00.000Z", "LOREM".repeat(400), true, "", false);
    l.pend = false; l.mdl = M; l.S = sizeEst(l.bytes, M) - (cut[i] ?? 0);
  }
  return accOut(a, 64);
}
const SK: string[][] = [["/w/par-cut.jsonl", "re-indexes"], ["/w/par-fit.jsonl", "loads"], ["/w/one-cut.jsonl", "loads"], ["/w/seq-cut.jsonl", "loads"]];
const skS: Record<string, Obj> = {};
skS["/w/par-cut.jsonl"] = skAcc([3, 3], [0, 40]); skS["/w/par-fit.jsonl"] = skAcc([3, 3], [0, 0]); skS["/w/one-cut.jsonl"] = skAcc([3], [40]); skS["/w/seq-cut.jsonl"] = skAcc([2, 3], [0, 40]);
if (existsSync(join(cacheDir(), "ledger.json"))) unlinkSync(join(cacheDir(), "ledger.json"));
for (const sk of [0, SK_SPLIT]) {
  writeCache(join(cacheDir(), "ledger.jsonl"), { v: VERSION, prices: pricesSig(), kiro: 0, rl: null, sk }, (put) => { for (const p of Object.keys(skS)) put(p, skS[p] as Obj); });
  ledger.clear(); const idx = L.idx;
  for (const f of H.firstScan) f();
  for (const c of SK) { const p = c[0] ?? ""; const want = sk === 0 ? c[1] === "loads" : true; ok("sk " + String(sk) + " " + p + (want ? ": loads" : ": re-indexes"), ledger.has(p) === want, String(ledger.has(p))); }
  ok("sk " + String(sk) + ": the head is " + (sk === 0 ? "rewritten" : "kept"), (L.idx > idx) === (sk === 0), String(L.idx - idx));
}
console.log(bad ? bad + " failed" : "cachemig: all checks passed");
if (bad) process.exit(1);
