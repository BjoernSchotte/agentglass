// agentglass — self-check: a VERSION 17 cache loads, except the Claude logs whose prompt ownership it may have booked wrong
// (a background continuation and the sessions it names re-index): scriptc build src/features/usage/cachemig.check.ts -o cm && ./cm
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

ok("VERSION 18", VERSION === 18, String(VERSION));
ok("reads 18 and 17, not 16 or 19", readable(18) && readable(17) && !readable(16) && !readable(19), "");
const ORIG = "3c4e27dd-7185-40bd-a29f-8ca06a57d08c"; const CONT = "3c00e05d-2078-4567-871d-d54d9b91d8c4";
const dir = "/w/.claude/projects/-w-app/";
const acc = (xs: string[]): unknown => { const a = newAcc(); a.off = 100; tokens(a, bucket(a, 0, "2026-10-01T09:30:00.000Z"), "claude-sonnet-4-5", 10, 1, 0, 0, 0); for (const x of xs) a.xs.add(x); return accOut(a, 64); };
const ss: Record<string, unknown> = {};
ss[dir + ORIG + ".jsonl"] = acc([]); // the original: named by the continuation
ss[dir + CONT + ".jsonl"] = acc([ORIG]); // the background continuation: its lines name the original
ss[dir + "aaaaaaaa-0000-4000-8000-000000000001.jsonl"] = acc([]); // an unrelated Claude session
ss[dir + ORIG + "/subagents/agent-x1.jsonl"] = acc([]); // the original's subagent books no prompts: kept
ss["/w/.codex/sessions/rollout-x.jsonl"] = acc([]);
mkdirSync(cacheDir(), { recursive: true });
writeFileSync(join(cacheDir(), "ledger.json"), JSON.stringify({ v: 17, prices: pricesSig(), kiro: 0, saved: Date.now(), rl: {}, sessions: ss }));
ROWS.on = false;
for (const f of H.firstScan) f();
const has = (p: string): string => (ledger.has(p) ? "kept" : "dropped");
ok("v17: the continuation re-indexes", has(dir + CONT + ".jsonl") === "dropped", has(dir + CONT + ".jsonl"));
ok("v17: the session it names re-indexes", has(dir + ORIG + ".jsonl") === "dropped", has(dir + ORIG + ".jsonl"));
ok("v17: the rest loads", [has(dir + "aaaaaaaa-0000-4000-8000-000000000001.jsonl"), has(dir + ORIG + "/subagents/agent-x1.jsonl"), has("/w/.codex/sessions/rollout-x.jsonl")].join(" ") === "kept kept kept", "");
console.log(bad ? bad + " failed" : "cachemig: all checks passed");
if (bad) process.exit(1);
