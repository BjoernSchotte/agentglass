// check: timing
// agentglass — budget for re-pricing the ledger in place (2000 session-days × 3 rows < 20 ms a pass): scriptc build src/features/usage/reprice.check.ts -o rp && ./rp
// SPDX-License-Identifier: Apache-2.0
import { type Acc, newAcc, bucket, tokens, reprice } from "./record.ts";
import { loadUser } from "./pricing.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const accs: Acc[] = [];
const t0 = Date.parse("2025-01-01T10:00:00.000Z");
for (let s = 0; s < 200; s++) {
  const a = newAcc();
  for (let dd = 0; dd < 10; dd++) {
    const iso = new Date(t0 + (s * 10 + dd) * 86400000).toISOString();
    const d = bucket(a, 0, iso);
    tokens(a, d, "gpt-6.1-sol", 1000, 100, 5000, 0, 0); tokens(a, d, "codex-auto-review", 300, 30, 0, 0, 0, "openai"); tokens(a, d, "claude-sonnet-4-5", 10, 10, 10, 10, 10);
  }
  accs.push(a);
}
const tabs = [JSON.parse('{"gpt-6.1-sol":{"input":1.25,"output":10},"codex-auto-review":{"alias":"gpt-6.1-sol"}}'), JSON.parse('{"claude-sonnet-4-5":{"input":1,"output":1}}')];
let worst = 0;
for (let i = 0; i < 10; i++) {
  loadUser(i % 2 === 0 ? tabs[0] : tabs[1]);
  const st = Date.now();
  for (const a of accs) reprice(a);
  worst = Math.max(worst, Date.now() - st);
}
ok("2000 session-days × 3 rows re-priced in < 20 ms", worst < 20, worst + " ms");
console.log(bad ? bad + " failed" : "reprice: all checks passed (worst pass " + worst + " ms)");
if (bad) process.exit(1);
