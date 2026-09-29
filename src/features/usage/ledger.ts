// agentglass — usage ledger: incremental, budgeted per-session/per-day token, cost, tool and line counts from the raw logs
// SPDX-License-Identifier: Apache-2.0
// What a line means is the harness adapter's business (HarnessAdapter.usage, recording via ./record.ts);
// this module decides which bytes get read when, within a time and byte budget per tick.
import { readBytes } from "../../util/fs.ts";
import type { Sess } from "../../model/types.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { harnessOf, sourceOf, window } from "../../harness/index.ts";
import { FILE_SOURCE } from "../../harness/source.ts";
import { type Acc, L, newAcc, startOfDay } from "./record.ts";

export const ledger = new Map<string, Acc>();

const BUDGET = 4194304; const CHUNK = 1048576; const SLICE_MS = 100;

export function accOf(s: Sess): Acc {
  let a = ledger.get(s.path);
  if (!a || s.size < a.off) { a = newAcc(); ledger.set(s.path, a); } // new or truncated/rewritten
  return a;
}
export function pending(s: Sess, a: Acc): boolean { return a.off < s.size && a.stall !== s.size; }
// side files with running totals (fx usage-v2.json, …): cheap stat per session, re-read on change
function sidecar(s: Sess, a: Acc): void { const f = harnessOf(s.h).usageSidecar; if (f) f(s, a); }

// one chunk (≤ CHUNK bytes) of new log lines; returns bytes consumed (0 = nothing to do right now)
function step(s: Sess, a: Acc): number {
  const src = sourceOf(s.h);
  if (src !== FILE_SOURCE) { // record-cursor source (database rows): whole records, no byte skipping
    const r = src.lines(s, a.off, Math.min(s.size, a.off + window(src, CHUNK)));
    const ad = harnessOf(s.h);
    for (const l of r.lines) ad.usage(a, l);
    const used = r.next - a.off; a.off = r.next;
    if (used <= 0) a.stall = s.size;
    return used * src.unit;
  }
  const len = Math.min(CHUNK, s.size - a.off);
  if (len <= 0) return 0;
  const b = readBytes(s.path, a.off, len);
  if (!b.length) { a.stall = s.size; return 0; }
  let z = b.length - 1;
  while (z >= 0 && b[z] !== 10) z--;
  if (z < 0) {
    if (a.off + b.length < s.size) { a.skip = true; a.off += b.length; return b.length; } // a >1 MB line (images, huge outputs): skip it
    a.stall = s.size; return 0; // partial last line, the agent is still writing it
  }
  const ls = new TextDecoder("utf-8").decode(b.subarray(0, z + 1)).split("\n");
  const ad = harnessOf(s.h);
  for (let i = a.skip ? 1 : 0; i < ls.length; i++) {
    const l = ls[i] ?? "";
    ad.usage(a, l);
  }
  a.skip = false;
  a.off += z + 1;
  return z + 1;
}
function apply(s: Sess, a: Acc): void {
  s.inTok = a.inTok; s.outTok = a.outTok; s.cacheRTok = a.cr; s.cacheWTok = a.cw;
  s.cost = a.unk > 0 && a.cost === 0 ? -1 : a.cost;
  s.tools = a.tools; s.linesAdd = a.add; s.linesDel = a.del;
}
function rank(s: Sess, sod: number): number {
  if (s.path === L.prio && Date.now() - L.prioAt < 3000) return 0;
  if (s.pid) return 1;
  return s.mtime >= sod ? 2 : 3;
}
function tick(): void {
  const t0 = Date.now();
  const sod = startOfDay();
  const q: Sess[] = [];
  let done = 0; let total = 0;
  for (const s of sessions.values()) {
    const a = accOf(s);
    sidecar(s, a);
    if (pending(s, a)) q.push(s);
    apply(s, a);
  }
  q.sort((x, y) => rank(x, sod) - rank(y, sod) || y.mtime - x.mtime);
  let budget = BUDGET;
  for (const s of q) {
    const a = accOf(s);
    while (budget > 0 && Date.now() - t0 < SLICE_MS) { const n = step(s, a); if (!n) break; budget -= n; }
    apply(s, a);
    if (budget <= 0 || Date.now() - t0 >= SLICE_MS) break;
  }
  if (budget < BUDGET) L.ver++;
  for (const s of sessions.values()) { const a = accOf(s); total += s.size; done += Math.min(a.off, s.size); if (a.stall === s.size) done += s.size - a.off; }
  L.done = done; L.total = total;
}
// blocking: everything up to the end of the file (CLI exports)
export function complete(s: Sess): void {
  const a = accOf(s);
  sidecar(s, a); // first: some adapters date log lines from it (kiro turn times)
  while (step(s, a) > 0) { /* next chunk */ }
  apply(s, a);
}

H.onTick.push(tick);
H.enrich.push((s: Sess) => { L.prio = s.path; L.prioAt = Date.now(); }); // O(1): the next tick indexes this one first
H.complete.push(complete);
