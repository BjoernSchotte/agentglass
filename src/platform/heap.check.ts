// agentglass — self-check for platform/heap.ts: freed objects go back to the system after trimHeap (Linux: RSS drops by
// most of what was freed; elsewhere: the call is linked and answers), trimIdle waits for growth and for its gap
//   scriptc build --ffi src/features/team/crypto/ffi.json src/platform/heap.check.ts -o hc && ./hc   (check.sh: crypto)
// check: crypto
// SPDX-License-Identifier: Apache-2.0
import { selfRssMb } from "../util/selfmem.ts";
import { trimHeap, trimIdle, trimNow } from "./heap.ts";
import "../features/team/crypto.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
interface O { a: string; b: number }
function fill(n: number): O[] { const xs: O[] = []; for (let i = 0; i < n; i++) xs.push({ a: "event " + String(i) + "x".repeat(200), b: i }); return xs; }

// a big transient inside a function (as a read's events are): freed when it returns
function big(): number { const xs = fill(300000); return xs.length > 0 ? selfRssMb() : 0; }
function churn(): number { let n = 0; const c0 = Date.now(); while (Date.now() - c0 < 100) n += fill(1000).length; return n; }
function main(): void {
  ok("trimHeap linked", trimHeap() >= 0, String(trimHeap()));
  const full = big(); churn();
  const kept = selfRssMb();
  trimNow(Date.now()); const after = selfRssMb();
  if (process.platform === "linux" && full > 0) ok("freed memory returned (" + String(kept) + " → " + String(after) + " MB)", kept - after > (full - 20) / 2, String(after));
  // trimIdle: not within its gap, and not without growth; after growth past its gap it trims
  const t0 = Date.now();
  ok("trimIdle waits for its gap", !trimIdle(t0 + 1000), "trimmed");
  ok("trimIdle needs growth", !trimIdle(t0 + 20000), "trimmed");
  big(); churn();
  if (process.platform === "linux" && selfRssMb() > 0) ok("trimIdle after growth", trimIdle(t0 + 40000), "not trimmed");
  console.log(bad ? String(bad) + " failed" : "heap: all checks passed (" + String(full) + " → " + String(kept) + " → " + String(after) + " MB)");
}
main();
if (bad) process.exit(1);
