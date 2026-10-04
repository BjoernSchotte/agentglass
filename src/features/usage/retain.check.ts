// agentglass — self-check: strings kept for long hold no spare capacity (util/own.ts): scriptc build src/features/usage/retain.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
// Linux only (reads VmRSS). Each case runs three times: once dropping its results (the heap warms up), then twice keeping
// them. The last run is measured: kept strings with the runtime's 64 KB builder capacity still pin the blocks the run
// before freed, so that run touches a fresh block per kept string; exact-size copies leave them for reuse.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { own } from "../../util/own.ts";
import { HOME } from "../../util/fs.ts";
import { type Acc, newAcc } from "./record.ts";
import { harnessOf } from "../../harness/index.ts";
import { parseReflog } from "../vcs/reflog.ts";
import { type Sess, newSess } from "../../model/types.ts";
import { loadTail } from "../../model/sessions.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function rss(): number {
  let t = ""; try { t = readFileSync("/proc/self/status", "utf8"); } catch (e) { return -1; }
  const i = t.indexOf("VmRSS:"); return i < 0 ? -1 : Number(t.slice(i + 6, t.indexOf("\n", i)).trim().split(" ")[0]) * 1024;
}
const N = 12000; const LIMIT = 24 * 1048576; // 12000 kept 64 KB blocks touch ≥ 47 MB; the cases keep 10–16 MB of real data
const keepS: string[] = []; const keepA: Acc[] = []; const keepO: unknown[] = [];
function growth(f: (keep: boolean) => void): number { f(false); f(true); const r0 = rss(); f(true); return rss() - r0; }
function grows(what: string, f: (keep: boolean) => void): void {
  const d = growth(f); ok(what + " keeps ≤ " + (LIMIT >> 20) + " MB", d <= LIMIT, Math.round(d / 1048576) + " MB");
  if (process.env.RETAIN_VERBOSE) console.log(what + ": " + Math.round(d / 1048576) + " MB");
}

if (rss() < 0) console.log("retain: skipped (no /proc/self/status)");
else {
  // the runtime's builder remembers the largest result so far: one big stringify sets every later capture to 64 KB
  let big = ""; for (let i = 0; i < 16384; i++) big += "abcdefgh";
  JSON.stringify({ big });
  // control (informational): unowned replace results do hold the spare capacity on this runtime
  { const d = growth((k: boolean) => { for (let i = 0; i < N; i++) { const s = ("x " + i).replace(/ /, "-"); if (k) keepS.push(s); } });
    console.log("control: unowned replace() results kept " + Math.round(d / 1048576) + " MB" + (d < LIMIT ? " (the scriptc builder bug may be fixed: util/own.ts)" : ""));
    keepS.length = 0; }
  grows("own()", (k: boolean) => { for (let i = 0; i < N; i++) { const s = own(("x " + i).replace(/ /, "-")); if (k) keepS.push(s); } });
  // claude tool results: the call id is a regex capture of the result line; the slow/error records keep it
  const ad = harnessOf("claude");
  const T = "\"timestamp\":\"2026-10-01T09:30:0";
  grows("claude call records", (k: boolean) => {
    const a = newAcc();
    for (let i = 0; i < N; i++) {
      const id = "toolu_" + i; const name = "T" + (i % 1200); // 1200 tools × 10 kept records
      ad.usage(a, "{\"type\":\"assistant\"," + T + "0Z\",\"message\":{\"id\":\"m" + i + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":{}}]}}");
      ad.usage(a, "{\"type\":\"user\"," + T + "5Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"" + id + "\",\"content\":\"a\\nb\",\"is_error\":true}]}}");
    }
    if (k) keepA.push(a);
  });
  // reflog events (git linkage keeps them per worktree)
  let rl = ""; for (let i = 0; i < N; i++) { const h = (String(1000000 + i) + "0".repeat(40)).slice(0, 40); rl += h + " " + h + " A <a@b> 1759312800 +0200\tcheckout: moving from main to br-" + i + "\n"; }
  grows("reflog", (k: boolean) => { const r = parseReflog(rl, "main"); if (k) keepO.push(r); });
  // the last 60 events each session keeps after a tail read (escaped text and the stringified tool input: builder strings)
  const f = join(HOME, "retain-tail.jsonl"); let body = "";
  for (let i = 0; i < 30; i++) body += "{\"type\":\"assistant\"," + T + "0Z\",\"message\":{\"id\":\"m" + i + "\",\"content\":[{\"type\":\"text\",\"text\":\"line\\none " + i + "\"},{\"type\":\"tool_use\",\"id\":\"t" + i + "\",\"name\":\"Bash\",\"input\":{\"command\":\"ls " + i + "\"}}]}}\n";
  writeFileSync(f, body);
  const ss: Sess[] = []; for (let i = 0; i < 200; i++) { const s = newSess("claude", "s" + i, f, false); s.size = body.length; ss.push(s); }
  grows("session tail events", (k: boolean) => { for (const s of ss) { s.tailSize = -1; loadTail(s); if (k) keepO.push(s.evs); } });
  ok("tail events read", (ss[0]?.evs.length ?? 0) === 60, String(ss[0]?.evs.length ?? 0));
  console.log(bad ? bad + " failed" : "retain: all checks passed");
}
if (bad) process.exit(1);
