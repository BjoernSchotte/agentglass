// agentglass — probes for tui-footprint's three runtime unknowns: scriptc build src/util/footprint-probes.check.ts -o fp && ./fp
// SPDX-License-Identifier: Apache-2.0
// Never fails on an outcome, only on a crash: each probe prints one `RULING <probe> <outcome>` line that the footprint
// tasks follow (specs/tui-footprint/plan.md Task 0 Step 6), plus the measurements behind it.
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { selfRssMb } from "./selfmem.ts";
import { readLines } from "./fs.ts";
import { own } from "./own.ts";
import { type Obj, str } from "./json.ts";

const N = 300000;
const linux = existsSync("/proc/self/status");

// 1. growable typed arrays: a Float64Array that doubles by copy vs a number[], 300k values each
function typed(): number {
  let a = new Float64Array(16); let n = 0;
  for (let i = 0; i < N; i++) {
    if (n === a.length) { const b = new Float64Array(a.length * 2); b.set(a); a = b; }
    a[n] = i * 1.5; n++;
  }
  let s = 0; for (let i = 0; i < n; i++) s += a[i] ?? 0;
  KEEP_T.push(a);
  return s;
}
function plain(): number {
  const a: number[] = [];
  for (let i = 0; i < N; i++) a.push(i * 1.5);
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] ?? 0;
  KEEP_N.push(a);
  return s;
}
const KEEP_T: Float64Array[] = []; const KEEP_N: number[][] = [];
let r0 = selfRssMb(); let t0 = Date.now();
const st = typed(); const tT = Date.now() - t0; const gT = selfRssMb() - r0;
r0 = selfRssMb(); t0 = Date.now();
const sn = plain(); const tN = Date.now() - t0; const gN = selfRssMb() - r0;
const same = st === sn;
console.log("typed-arrays: Float64Array " + String(tT) + " ms +" + String(gT) + " MB, number[] " + String(tN) + " ms +" + String(gN) + " MB, sums " + (same ? "equal" : "differ"));
console.log("RULING typed-arrays " + (linux && same && gT <= 0.7 * gN ? "yes" : "no"));

// 2. /proc/<pid>/task/<tid>/children: is a spawned child listed while it runs?
function children(): string {
  if (!linux) return "n/a";
  const ch = spawn("sleep", ["1"], { stdio: ["ignore", "ignore", "ignore"] });
  const kid = ch.pid ?? 0;
  const me = String(process.pid);
  let txt = "";
  try { txt = readFileSync("/proc/self/task/" + me + "/children", "utf8"); } catch (e) { txt = ""; }
  console.log("proc-children: child " + String(kid) + ", children file " + (txt.trim() ? "\"" + txt.trim() + "\"" : "missing or empty"));
  return kid > 0 && (" " + txt.trim() + " ").indexOf(" " + String(kid) + " ") >= 0 ? "yes" : "no";
}
console.log("RULING proc-children " + children());

// 3. the 64 KB own() buffer after a streamed load: 4,000 lines of 10 KB with escapes, read in 4 MB windows, only a short
// owned string kept per line
function ownBuffer(): string {
  const dir = "/tmp/agentglass-fp-probe-" + String(process.pid); mkdirSync(dir, { recursive: true });
  const f = dir + "/big.jsonl";
  const pad = "ab\\ncd\\\"ef".repeat(1024); // 10 KB of JSON text with escapes: JSON.parse goes through the growable buffer
  const parts: string[] = [];
  for (let i = 0; i < 4000; i++) parts.push('{"path":"/p' + String(i) + '","s":"' + pad + '","k":"short' + String(i) + '"}');
  writeFileSync(f, parts.join("\n") + "\n");
  parts.length = 0;
  const r = selfRssMb(); const kept: string[] = [];
  let at = 0; const W = 4194304;
  for (let guard = 0; guard < 100; guard++) {
    const w = readLines(f, at, at + W, false); if (!w.lines.length) break;
    for (const l of w.lines) { if (!l) continue; const o = JSON.parse(l) as Obj; kept.push(own(str(o["k"]))); }
    at = w.next;
  }
  const g = selfRssMb() - r;
  rmSync(dir, { recursive: true, force: true });
  console.log("own-buffer: " + String(kept.length) + " lines kept, +" + String(g) + " MB after the load");
  return kept.length === 4000 && g <= 30 ? "ok" : "copy";
}
console.log("RULING own-buffer " + (linux ? ownBuffer() : "n/a"));
console.log("footprint-probes: done");
