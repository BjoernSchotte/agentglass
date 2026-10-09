// agentglass — self-check: a cache of an older VERSION (18: no skill loads; 17) is not loaded, everything re-indexes once;
// a current one loads: scriptc build src/features/usage/cachemig.check.ts -o cm && ./cm
// SPDX-License-Identifier: Apache-2.0
// Runs under check.sh's temp HOME: the cache lives in $HOME/.agentglass/cache.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { H } from "../../hooks.ts";
import { cacheDir } from "../../util/fs.ts";
import { ledger } from "./ledger.ts";
import { accOut } from "./cache.ts";
import { VERSION, readable } from "./codec.ts";
import { ROWS } from "./facts.ts";
import { newAcc, bucket, tokens } from "./record.ts";
import { pricesSig } from "./pricing.ts";

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
console.log(bad ? bad + " failed" : "cachemig: all checks passed");
if (bad) process.exit(1);
