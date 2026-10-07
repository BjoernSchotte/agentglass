// agentglass — the `fleet pull` line format (fleet spec 4.1): hello, cost, allowance, one session per line, end. Parsed
// incrementally so the TUI can take a big report a window of lines per tick
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, parse } from "../../util/json.ts";
import { type Hello, type HostReport, type SessRow, noOwned } from "./model.ts";

export interface Parse { hello: Hello | null; cost: Obj | null; allowance: Obj | null; wait: Obj | null; sessions: SessRow[]; done: boolean; err: string }
export function newParse(): Parse { return { hello: null, cost: null, allowance: null, wait: null, sessions: [], done: false, err: "" }; }
function num(v: unknown): number { return typeof v === "number" ? v as number : 0; }
export function helloOf(o: Obj): Hello {
  return { format: str(o["format"]), version: str(o["version"]), hostId: str(o["hostId"]), hostName: str(o["hostName"]), os: str(o["os"]), tzOffsetMin: num(o["tzOffsetMin"]),
    redact: o["redact"] === true, days: num(o["days"]), now: num(o["now"]), priceSig: str(o["priceSig"]) };
}
// "agentglass-fleet/v1" → 1; another family or an unreadable version → -1
function major(format: string): number { const m = /^agentglass-fleet\/v(\d+)$/.exec(format); return m ? Number(m[1] ?? "") : -1; }
export function sessRowOf(s: Obj): SessRow { return { s, key: str(s["harness"]) + ":" + str(s["id"]), days: null, own: null, prov: [] }; }
// feeds lines in order; after an error or the end line nothing more is taken
export function feedLines(p: Parse, lines: string[]): void {
  for (const l of lines) {
    if (p.err || p.done) return;
    if (!l.trim()) continue;
    const o = parse(l);
    if (!o) continue; // a remote shell rc that prints text before the report, a garbled line inside it: skipped (the end count catches a loss)
    if (!p.hello) {
      const h = obj(o["hello"]);
      if (!h) { p.err = "not a fleet report"; return; }
      const he = helloOf(h); const mj = major(he.format);
      if (mj < 0) { p.err = "not a fleet report"; return; }
      if (mj !== 1) { p.err = "newer format " + he.format; return; }
      p.hello = he; continue;
    }
    const s = obj(o["s"]);
    if (s) { p.sessions.push(sessRowOf(s)); continue; }
    if (o["cost"] !== undefined) { p.cost = obj(o["cost"]); continue; }
    if (o["allowance"] !== undefined) { p.allowance = obj(o["allowance"]); continue; }
    if (o["wait"] !== undefined) { p.wait = obj(o["wait"]); continue; } // agent-wait (fleet pull --wait)
    const e = obj(o["end"]);
    if (e) { if (num(e["sessions"]) === p.sessions.length) p.done = true; else p.err = "incomplete report"; continue; }
    // unknown keys: a newer v1 writer's additions
  }
}
// the finished report; null while unfinished or after an error (a stream that ended without its end line is incomplete)
export function toReport(p: Parse): HostReport | null {
  const h = p.hello;
  if (!p.done || p.err || !h) return null;
  return { hello: h, sessions: p.sessions, cost: p.cost, allowance: p.allowance, live: null, exact: false, owned: noOwned(), wait: p.wait };
}
// a whole text at once (CLI, checks); null with the reason
export function parseReport(text: string): { r: HostReport | null; err: string } {
  const p = newParse(); feedLines(p, text.split("\n"));
  const r = toReport(p);
  return { r, err: r ? "" : p.err || (p.hello ? "incomplete report" : "not a fleet report") };
}
function helloObj(h: Hello): Obj { return { format: h.format, version: h.version, hostId: h.hostId, hostName: h.hostName, os: h.os, tzOffsetMin: h.tzOffsetMin, redact: h.redact, days: h.days, now: h.now, priceSig: h.priceSig }; }
// the inverse: what `fleet pull` prints, one JSON object per line
export function reportLines(r: HostReport): string[] {
  const out: string[] = [JSON.stringify({ hello: helloObj(r.hello) }), JSON.stringify({ cost: r.cost }), JSON.stringify({ allowance: r.allowance })];
  if (r.wait) out.push(JSON.stringify({ wait: r.wait }));
  for (const s of r.sessions) out.push(JSON.stringify({ s: s.s }));
  out.push(JSON.stringify({ end: { sessions: r.sessions.length } }));
  return out;
}
