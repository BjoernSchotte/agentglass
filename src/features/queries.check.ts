// agentglass — self-check for the agent queries: scriptc build src/features/queries.check.ts -o q && ./q
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { accOf } from "./usage/ledger.ts";
import { tokens, bucket, dayKey, num } from "./usage/record.ts";
import { modelRows } from "./queries.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-queries-" + String(process.pid);
function put(h: string, id: string, cwd: string): Sess { const s = newSess(h, id, dir + "/" + h + "-" + id + ".jsonl", false); s.cwd = cwd; s.mtime = 1; sessions.set(s.path, s); return s; }

// ── per-model rows from the per-model day buckets ──
const D1 = "2026-09-30T10:00:00.000Z"; const D2 = "2026-10-01T10:00:00.000Z";
const m1 = put("claude", "m-1", "/w"); const m2 = put("claude", "m-2", "/w");
const a1 = accOf(m1); const a2 = accOf(m2);
const SON = "claude-sonnet-4-5";
tokens(a1, bucket(a1, 0, D1), SON, 10, 5, 2, 1, 0);
tokens(a1, bucket(a1, 0, D2), SON, 10, 5, 2, 1, 0);
tokens(a2, bucket(a2, 0, D1), SON, 10, 5, 2, 1, 0);
tokens(a2, bucket(a2, 0, D1), "gpt-x", 100, 0, 0, 0, 0);
const mr = modelRows([m1, m2], null);
eq("models: priced first", mr.map((r) => String(r["model"])).join(","), SON + ",gpt-x");
const son = mr[0];
eq("models: summed tokens", [son["in"], son["out"], son["cacheRead"], son["cacheWrite"]].map((v) => String(v)).join(","), "30,15,6,3");
eq("models: priced cost > 0", String(num(son["costUsd"]) > 0), "true");
const gx = mr[1];
eq("models: unpriced costUsd null, never 0", String(gx["costUsd"]) + "|" + String(gx["unpricedTokens"]), "null|100");
const dr = modelRows([m1, m2], [dayKey(new Date(D1))]); const d0 = dr[0];
eq("models: days restrict", String(d0["in"]), "20");

console.log(bad ? bad + " failed" : "queries: all checks passed");
if (bad) process.exit(1);
