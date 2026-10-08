// agentglass — agent-wait digests: a report summed from day digests equals the one read row by row, on seeded random
// sessions (calls across midnight, untimed calls, failures, questions, polling), for windows on and off day starts, a
// retention cut inside the window, session and day filters; the static part reused; the drill-down's slowest calls
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fxReset, fxSession } from "../query/fixture.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, unread } from "../usage/ledger.ts";
import { startOfDay } from "../usage/record.ts";
import { type Rows, newRows } from "../usage/rows.ts";
import { setCallDaysForTest, saveCallsTo, CALLS_DIR } from "../usage/callcache.ts";
import { compile, EMPTY } from "../query/eval.ts";
import { parse } from "../query/parse.ts";
import { type WRow, type WaitReport, type SlowCall, newWaitRun, stepWait, waitResult, dropWaitBase, BASE_STATS, FOLD_STATS, newDrill, stepDrill } from "./report.ts";
import { parseWaitCfg, setWaitCfgForTest } from "./family.ts";
import { type Digest, buildDigest, encodeDigest, decodeDigest, setDigestDirForTest, writeDigest, digestValid, DIG_STATS } from "./digest.ts";
import "../usage/cache.ts"; // LAZY.rows: rows read back from the calls files

let bad = 0;
function eq(w: string, got: string, want: string): void {
  if (got === want) return;
  bad++; const g = got.split("\n"); const x = want.split("\n"); let i = 0; while (i < g.length && g[i] === x[i]) i++; // the first line that differs
  console.log("FAIL " + w + " (line " + String(i + 1) + "): got " + JSON.stringify(g[i] ?? "").slice(0, 400) + " want " + JSON.stringify(x[i] ?? "").slice(0, 400));
}
function q(s: string): string { return JSON.stringify(s); }

// ── the encoding round-trips ──
{
  const g: Digest = buildDigest("/s/a.jsonl", 42, { n: 3, t: [1000, 2000, 90000000], ms: [500, -1, 7200000], er: [0, 1, 0], fid: [-1, -1, -1], tool: ["Read", "Read", "AskUserQuestion"] }, [-1, -1], 10000);
  const back = decodeDigest(encodeDigest(g), true);
  eq("round trip", back ? encodeDigest(back) : "null", encodeDigest(g));
  eq("days", String(g.days.length) + " " + g.days.map((d) => String(d.ents.length) + ":" + String(d.u[0])).join(","), "2 1:500,1:7200000");
  setDigestDirForTest(join(tmpdir(), "agentglass-digest-head-" + String(process.pid))); writeDigest(g);
  eq("valid by its head", String(digestValid("/s/a.jsonl", 42)) + String(digestValid("/s/a.jsonl", 43)) + String(digestValid("/s/b.jsonl", 42)), "truefalsefalse");
  rmSync(join(tmpdir(), "agentglass-digest-head-" + String(process.pid)), { recursive: true, force: true });
  eq("corrupt → null", String(decodeDigest(encodeDigest(g).slice(0, 50), true) === null && decodeDigest("{\"v\":9}", true) === null), "true");
}

// ── seeded sessions ──
let seed = 12345;
function rnd(): number { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function pick<T>(xs: T[]): T { return xs[Math.floor(rnd() * xs.length)] as T; }
let mid = 0;
function call(t: number, name: string, id: string, input: string): string {
  mid++;
  return "{\"type\":\"assistant\",\"timestamp\":" + q(new Date(t).toISOString()) + ",\"message\":{\"id\":\"m" + String(mid) + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":" + q(id) + ",\"name\":" + q(name) + ",\"input\":" + input + "}],\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}";
}
function result(t: number, id: string, err: boolean): string {
  return "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":" + q(id) + (err ? ",\"is_error\":true" : "") + ",\"content\":\"x\"}]},\"uuid\":\"u" + id + "\",\"timestamp\":" + q(new Date(t).toISOString()) + "}";
}
const CMDS = ["pnpm test", "npx tsc --noEmit", "git status", "sleep 30", "gh run watch 1", "cat x | python3 -", "pnpm lint", "cargo build"];
// calls in time order (results may arrive after later calls: parallel calls overlap); durations from milliseconds to
// hours, some across midnight, some never answered
function lines(id: string, day0: number, days: number): string[] {
  const o: { t: number; l: string }[] = []; const sod = startOfDay();
  for (let d = day0; d > day0 - days; d--) {
    let t = sod - d * 86400000 + Math.floor(rnd() * 6) * 3600000 + 8 * 3600000;
    const n = 3 + Math.floor(rnd() * 10);
    for (let k = 0; k < n; k++) {
      t += Math.floor(rnd() * 3600000);
      const cid = id + "-" + String(d) + "-" + String(k); const r = rnd();
      const ms = r < 0.08 ? -1 : r < 0.2 ? Math.floor(rnd() * 5 * 3600000) : r < 0.5 ? Math.floor(rnd() * 600000) : Math.floor(rnd() * 30000);
      const kind = rnd();
      const name = kind < 0.7 ? "Bash" : kind < 0.8 ? "AskUserQuestion" : kind < 0.9 ? "TaskOutput" : "Read";
      o.push({ t, l: call(t, name, cid, name === "Bash" ? "{\"command\":" + q(pick(CMDS)) + "}" : "{}") });
      if (ms >= 0) o.push({ t: t + ms, l: result(t + ms, cid, rnd() < 0.15) });
    }
    if (rnd() < 0.5) { const t2 = sod - d * 86400000 + 22 * 3600000 + Math.floor(rnd() * 7200000); const cid = id + "-" + String(d) + "-late"; o.push({ t: t2, l: call(t2, "Bash", cid, "{\"command\":\"pnpm test\"}") }); o.push({ t: t2 + 3 * 3600000, l: result(t2 + 3 * 3600000, cid, false) }); } // into the next day
  }
  o.sort((a, b) => a.t - b.t);
  const ls: string[] = []; for (const x of o) ls.push(x.l); return ls;
}
setWaitCfgForTest(parseWaitCfg({ minSec: 10 }));
fxReset();
fxSession("claude", "A", "/w/a", "", "claude-sonnet-4-5", lines("A", 9, 10));
fxSession("claude", "As", "/w/a", "A", "claude-sonnet-4-5", lines("As", 3, 3));
fxSession("claude", "B", "/w/b", "", "claude-sonnet-4-5", lines("B", 6, 7));
fxSession("claude", "C", "/w/c", "", "claude-sonnet-4-5", lines("C", 1, 2));
fxSession("claude", "D", "/w/d", "", "claude-sonnet-4-5", lines("D", 12, 4));
fxSession("claude", "E", "/w/b", "", "claude-sonnet-4-5", lines("E", 0, 1));

function core(x: WaitReport): string {
  const strip = (ws: WRow[]): string => JSON.stringify(ws.map((w: WRow) => [w.key, w.id, w.kind, w.n, w.timed, w.ms, w.max, w.hist, w.err, w.agents, w.prevN, w.prevMs]));
  return [strip(x.fams), strip(x.kinds), strip(x.tools), JSON.stringify(x.split), JSON.stringify(x.spans.slice().sort((a, b) => a.t0 - b.t0 || a.group - b.group || a.agent - b.agent)), String(x.sessions)].join("\n");
}
function slowest(x: WaitReport): string {
  const o: string[] = [];
  for (const w of x.fams.concat(x.tools)) { const d = newDrill(x, w, [w]); while (!stepDrill(d, 0)) { /* a day at a time */ } o.push(w.key + "=" + d.out.map((c: SlowCall): string => String(c.ms) + "@" + c.id).join(",")); }
  for (const w of x.kinds) { const d = newDrill(x, w, x.fams.concat(x.tools).filter((m: WRow): boolean => m.kind === w.key)); while (!stepDrill(d, 0)) { /* a day at a time */ } o.push("kind " + w.key + "=" + d.out.map((c: SlowCall): string => String(c.ms)).join(",")); }
  return o.join("\n");
}
function run(f0: string, since: number, until: number, step0: boolean): WaitReport {
  const f = f0 ? compile(parse(f0).cs, "stats").f ?? EMPTY : EMPTY;
  const r = newWaitRun(f, since, until); while (!stepWait(r, step0 ? 0 : 1e9)) { /* steps */ } return waitResult(r);
}
const base = join(tmpdir(), "agentglass-digest-check-" + String(process.pid)); rmSync(base, { recursive: true, force: true });
let dn = 0; function freshDigests(): void { dn++; const d = join(base, String(dn)); mkdirSync(d, { recursive: true }); setDigestDirForTest(d); }
const kept = new Map<string, Rows>();
for (const s of sessions.values()) { const a = ledger.get(s.path); if (a) kept.set(s.path, a.rows); }
function inMemory(): void { for (const s of sessions.values()) { const a = ledger.get(s.path); if (a) { a.rows = kept.get(s.path) ?? a.rows; unread.delete(s.path); } } }
function onDisk(): void { for (const s of sessions.values()) { const a = ledger.get(s.path); if (a) { saveCallsTo(CALLS_DIR, s.path, a); a.rows = newRows(); unread.add(s.path); } } }

const sod = startOfDay(); const H = 3600000;
const cases: { name: string; since: number; until: number; days: number }[] = [
  { name: "3 days", since: sod - 3 * 86400000, until: sod + 86400000, days: 0 },
  { name: "today", since: sod, until: sod + 20 * H, days: 0 },
  { name: "10 days", since: sod - 10 * 86400000, until: sod + 86400000, days: 0 },
  { name: "off a day start", since: sod - 3 * 86400000 + 5 * H, until: sod + 86400000, days: 0 },
  { name: "previous window starts mid-day", since: sod - 2 * 86400000, until: sod + 13 * H, days: 0 },
  { name: "retention cut inside", since: sod - 8 * 86400000, until: sod + 86400000, days: 5 },
];
for (const c of cases) for (const f of ["", "cwd is /w/b", "day.tools > 9"]) {
  const tag = c.name + (f ? " [" + f + "]" : "");
  setCallDaysForTest(c.days); dropWaitBase();
  inMemory(); freshDigests(); const f1 = FOLD_STATS.folded;
  const mem = run(f, c.since, c.until, false);
  eq(tag + ": rows read, nothing folded", String(FOLD_STATS.folded - f1), "0");
  const want = core(mem); const wantSlow = slowest(mem);
  onDisk(); dropWaitBase(); const w0 = DIG_STATS.written;
  const d1 = run(f, c.since, c.until, true);
  eq(tag + ": digests worked out = rows", core(d1), want);
  eq(tag + ": digests written", String(DIG_STATS.written - w0 > 0), "true");
  eq(tag + ": drill = rows", slowest(d1), wantSlow);
  dropWaitBase(); const f2 = FOLD_STATS.folded;
  const d2 = run(f, c.since, c.until, false);
  eq(tag + ": digests = rows", core(d2), want);
  eq(tag + ": folded", String(FOLD_STATS.folded - f2 > 0), "true");
  eq(tag + ": drill from digests = rows", slowest(d2), wantSlow);
  const b0 = BASE_STATS.used; const d3 = run(f, c.since, c.until, false);
  if (!f) { eq(tag + ": static part reused", String(BASE_STATS.used - b0), "1"); eq(tag + ": static part = rows", core(d3), want); eq(tag + ": static drill = rows", slowest(d3), wantSlow); }
}
// the clock moves the previous window's start while a static part lives: its days apply again from the new start
{
  setCallDaysForTest(0); dropWaitBase(); inMemory(); onDisk();
  const since = sod - 2 * 86400000;
  run("", since, sod + 26 * H, false); // every call has started by then (static sessions have no future calls)
  const b0 = BASE_STATS.used; const later = run("", since, sod + 35 * H, false);
  eq("later: static part reused", String(BASE_STATS.used - b0), "1");
  inMemory(); freshDigests(); dropWaitBase();
  eq("later: = rows", core(later), core(run("", since, sod + 35 * H, false)));
}
rmSync(base, { recursive: true, force: true });
setCallDaysForTest(0); setWaitCfgForTest(null);
console.log(bad ? bad + " failed" : "digest: all checks passed");
if (bad) process.exit(1);
