// agentglass — self-check for loading a ledger cache saved under other prices: scriptc build src/features/usage/cacheload.check.ts -o cl && ./cl
// SPDX-License-Identifier: Apache-2.0
// Runs under check.sh's temp HOME: the cache lives in $HOME/.agentglass/cache, kiro logs under $HOME/.kiro/sessions/cli.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { H } from "../../hooks.ts";
import { HOME, cacheDir } from "../../util/fs.ts";
import { ledger } from "./ledger.ts";
import { accOut } from "./cache.ts";
import { VERSION } from "./codec.ts";
import { ROWS } from "./facts.ts";
import { newAcc, bucket, tokens, addCost, L } from "./record.ts";
import { loadUser, pricesSig } from "./pricing.ts";
import { sessions } from "../../model/sessions.ts";
import { newSess } from "../../model/types.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
if (!process.env.AGENTGLASS_HERMETIC) { console.log("cacheload: skipped (needs check.sh's temp HOME)"); process.exit(0); }

// saved with gpt-6.1-sol unpriced and a kiro rate of 0.01
const a = newAcc(); a.off = 100; tokens(a, bucket(a, 0, "2026-10-01T09:30:00.000Z"), "gpt-6.1-sol", 1000, 1000, 0, 0, 0);
const k = newAcc(); k.off = 50; addCost(k, bucket(k, 0, "2026-10-01T09:30:00.000Z"), 0.3, "", "kiro");
const kp = join(HOME, ".kiro", "sessions", "cli", "k1.jsonl");
const ss: Record<string, unknown> = {}; ss["/w/a.jsonl"] = accOut(a, 64); ss[kp] = accOut(k, 64);
mkdirSync(cacheDir(), { recursive: true });
writeFileSync(join(cacheDir(), "ledger.json"), JSON.stringify({ v: VERSION, prices: "other", kiro: 0.01, saved: Date.now(), rl: {}, sessions: ss }));

loadUser(JSON.parse('{"gpt-6.1-sol":{"input":1,"output":2}}')); // the prices now: another signature
ROWS.on = false; // no call rows in this check: the day buckets alone
const ver = L.ver;
for (const f of H.firstScan) f();
const b = ledger.get("/w/a.jsonl");
ok("loaded, not re-indexed", !!b && b.off === 100, b ? String(b.off) : "missing");
ok("re-priced in place", !!b && Math.abs(b.cost - 3000 / 1e6) < 1e-12 && b.unk === 0, b ? b.cost + "/" + b.unk : "missing");
ok("caches told to rebuild", L.ver > ver, String(L.ver));
ok("kiro session dropped (rate changed)", !ledger.has(kp), "kept");

// a price change in this process that nobody re-priced (a CLI write): the save re-prices first, so the file's price
// signature always describes its numbers (else the next run would trust stale costs)
const sx = newSess("codex", "a", "/w/a.jsonl", false); sx.size = 100; sessions.set(sx.path, sx);
loadUser(JSON.parse('{"gpt-6.1-sol":{"input":2,"output":2}}'));
ROWS.on = true; L.idx++;
for (const f of H.onQuit) f();
// saved as ledger.jsonl (header line, one line per session); the migrated ledger.json is gone
const lines = readFileSync(join(cacheDir(), "ledger.jsonl"), "utf8").split("\n");
const saved = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
let so: Record<string, unknown> | null = null;
for (const l of lines.slice(1)) { if (!l) continue; const o = JSON.parse(l) as Record<string, unknown>; if (o["path"] === "/w/a.jsonl") so = o; }
const tt = (so ? so["t"] : []) as number[];
ok("old ledger.json removed", !existsSync(join(cacheDir(), "ledger.json")), "kept");
ok("saved sig = current", saved["prices"] === pricesSig(), String(saved["prices"]));
ok("saved numbers under that sig", Math.abs((tt[4] ?? 0) - 4000 / 1e6) < 1e-12, String(tt[4]));
console.log(bad ? bad + " failed" : "cacheload: all checks passed");
if (bad) process.exit(1);
