// agentglass — self-check: the TUI's incremental all-harness sums equal the full sums: scriptc build src/features/usage/summary-inc.check.ts -o si && ./si
// SPDX-License-Identifier: Apache-2.0
import { sessions } from "../../model/sessions.ts";
import { ledger, reapplyAll } from "./ledger.ts";
import { type CostNow, costNow, SUMMARY_TEST } from "./summary.ts";
import { L, todayKey, bucket, tokens } from "./record.ts";
import { MODES } from "./billing.ts";
import { fxBase, isoAt } from "../query/fixture.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function close(x: number, y: number): boolean { return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)); }
function same(a: CostNow, b: CostNow): string {
  const sums = [["today", a.today, b.today], ["week", a.week, b.week], ["month", a.month, b.month]] as const;
  for (const [n, x, y] of sums) {
    for (let i = 0; i < MODES.length; i++) if (!close(x.by[i] ?? 0, y.by[i] ?? 0) || !close(x.estBy[i] ?? 0, y.estBy[i] ?? 0)) return n + ".by[" + String(i) + "] " + String(x.by[i]) + " vs " + String(y.by[i]);
    if (x.unk !== y.unk || !close(x.uc, y.uc) || !close(x.est, y.est)) return n + " unk/uc/est";
    if (x.um.size !== y.um.size) return n + ".um size"; for (const [k, v] of x.um) if (y.um.get(k) !== v) return n + ".um " + k;
  }
  for (let i = 0; i < MODES.length; i++) { const p = a.projByMode[i]; const q = b.projByMode[i]; if (p && q && (!close(p.today, q.today) || !close(p.month, q.month))) return "projByMode[" + String(i) + "]"; }
  if (!close(a.proj.today, b.proj.today) || !close(a.proj.month, b.proj.month)) return "proj";
  if (!close(a.bs.used, b.bs.used) || a.bs.state !== b.bs.state) return "budget state";
  return "same";
}
function both(): string { SUMMARY_TEST.inc(false); const f = costNow(""); SUMMARY_TEST.inc(true); const i = costNow(""); return same(i, f); }

fxBase();
eq("first sums", both(), "same");
const r0 = SUMMARY_TEST.resums(); SUMMARY_TEST.fresh(); costNow("");
eq("nothing changed: no day re-summed", String(SUMMARY_TEST.resums() - r0), "0");
// one session grows today: only today is re-summed, and the sums still agree
let c1 = ""; for (const s of sessions.values()) if (s.id === "c1") c1 = s.path;
const a = ledger.get(c1);
if (a) { tokens(a, bucket(a, 0, isoAt(0, 15, 0)), "claude-sonnet-4-5", 5000, 700, 0, 0, 0); a.off += 100; L.ver++; }
const r1 = SUMMARY_TEST.resums(); SUMMARY_TEST.fresh(); costNow("");
eq("growth: only its touched days re-summed", String(SUMMARY_TEST.resums() - r1), "2"); // c1 has yesterday and today in the window
eq("after growth", both(), "same");
// a billing label change re-sums that session's days
for (const s of sessions.values()) if (s.path === c1) s.bill = "plan";
eq("after a billing label change", both(), "same");
// a session restarted (a new entry object, fewer days)
if (a) { const b = ledger.get(c1); if (b) { ledger.delete(c1); } }
eq("after a dropped entry", both(), "same");
// a re-pricing re-sums everything
const r2 = SUMMARY_TEST.resums(); reapplyAll(); SUMMARY_TEST.fresh(); costNow("");
eq("re-pricing re-sums the window", String(SUMMARY_TEST.resums() - r2 > 2), "true");
eq("today key", String(todayKey().length), "10");
console.log(bad ? bad + " failed" : "summary inc: all checks passed");
if (bad) process.exit(1);
