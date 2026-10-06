// agentglass — self-check for the ledger tick (work only where something changed), indexing() and the header gauge:
// scriptc build src/features/usage/ledger.check.ts -o lc && ./lc
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, appendFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { H } from "../../hooks.ts";
import { L } from "./record.ts";
import { ledger, indexing, indexState, reapplyAll, complete, PACE, TICK_STATS, paceResetForTest, newRate, rateAdd } from "./ledger.ts";
import { heavy } from "./record.ts";
import "./codec.ts"; // the day-map text codec (packHeavy)
import { gaugeText, gaugeReset } from "./progress.ts";
import "../../harness/index.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-ledger-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
const TS = "2026-09-01T10:00:00.000Z";
let n = 0;
function asst(out: number): string {
  n++;
  return "{\"type\":\"assistant\",\"timestamp\":\"" + TS + "\",\"requestId\":\"req_" + String(n) + "\",\"message\":{\"id\":\"m" + String(n) + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":" + String(out) + ",\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}\n";
}
function sess(name: string, lines: string): Sess {
  const p = dir + "/" + name + ".jsonl"; writeFileSync(p, lines);
  const s = newSess("claude", name, p, false); s.size = statSync(p).size; s.mtime = Date.now(); sessions.set(p, s); return s;
}
function grow(s: Sess, line: string): void { appendFileSync(s.path, line); s.size = statSync(s.path).size; }
function tick(): void { for (const f of H.onTick) f(); }

PACE.fullMs = 0; // every tick a full pass, unless a case says otherwise
const a = sess("a", asst(5) + asst(6)); const b = sess("b", asst(7)); const c = sess("c", asst(8) + asst(9));
tick();
eq("(a) all indexed after one tick", String(L.done === L.total && L.total > 0), "true");
eq("(a) tokens applied", String(a.outTok) + " " + String(b.outTok) + " " + String(c.outTok), "11 7 17");
TICK_STATS.applied = 0; tick();
eq("(b) nothing changed: nothing applied", String(TICK_STATS.applied), "0");
TICK_STATS.applied = 0; grow(b, asst(4)); tick();
eq("(c) one log grew: one applied", String(TICK_STATS.applied), "1");
eq("(c) its tokens rose", String(b.outTok), "11");
TICK_STATS.sidecars = 0; tick();
eq("sidecars of unlinked sessions not every tick", String(TICK_STATS.sidecars), "0");
// between full passes only the hot sessions (pid-linked or pending at the last full pass) are visited
PACE.fullMs = 3600000; b.pid = 77; reapplyAll(); tick(); // a full pass that sees b live
TICK_STATS.visits = 0; TICK_STATS.full = 0; tick();
eq("between full passes: only the live session", String(TICK_STATS.visits) + " " + String(TICK_STATS.full), "1 0");
grow(b, asst(1)); tick();
eq("live growth applied at once", String(b.outTok), "12");
grow(a, asst(3)); tick();
eq("an unlinked log's growth waits for the full pass", String(a.outTok), "11");
PACE.fullMs = 0; tick();
eq("…and is applied by it", String(a.outTok), "14");
b.pid = 0; tick();
// a rewritten log (shorter): a new entry, applied
TICK_STATS.applied = 0; writeFileSync(c.path, asst(1)); c.size = statSync(c.path).size; tick();
eq("rewritten log re-applied (new entry, then its read)", String(TICK_STATS.applied) + " " + String(c.outTok), "2 1");
// a session object seen again (removed and re-added by the scan): applied to the new object
const c2 = newSess("claude", "c", c.path, false); c2.size = c.size; c2.mtime = c.mtime; sessions.set(c.path, c2); tick();
eq("new Sess object gets the totals", String(c2.outTok), "1");

// (d) indexing() is history: a live agent's small append is ingest, a finished log's byte is indexing
PACE.sliceMs = 0; // classify only, read nothing
a.pid = 4242; grow(a, asst(1)); tick();
eq("(d) live append < 1 MB: not indexing", String(indexing()), "false");
a.pid = 0; tick();
eq("(d) same bytes, no live agent: indexing", String(indexing()), "true");
a.pid = 4242; let big = ""; while (big.length < 1100000) big += asst(1); grow(a, big); tick();
eq("(d) live session > 1 MB behind: indexing", String(indexing()), "true");
// (e) no byte cap: a 3 MB log is read within a few ticks of a 1 s slice
PACE.sliceMs = 1000; PACE.share = 1; a.pid = 0; // no process budget in a check: the slice alone
let more = ""; while (more.length < 3 * 1048576) more += asst(2); const d = sess("d", more);
let k = 0; for (; k < 20 && !(L.done === L.total && ledger.has(d.path) && (ledger.get(d.path)?.off ?? 0) === d.size); k++) tick();
eq("(e) 3 MB + 1 MB indexed within 20 ticks", String(k < 20 && L.done === L.total), "true");
eq("(e) not indexing once done", String(indexing()), "false");
const st = indexState(); eq("indexState done = total", String(st.done === st.total && st.left === 0), "true");
// (f) the process budget: with no CPU share left (the rest of the process takes it all) history still advances, one step
// (≤ 1 MB) a second, and no more than that
PACE.sliceMs = 50; PACE.share = 0.001; paceResetForTest();
let huge = ""; while (huge.length < 12 * 1048576) huge += asst(3); const f = sess("f", huge); huge = "";
const offF = (): number => ledger.get(f.path)?.off ?? 0;
const tf = Date.now(); let at03 = -1; let at31 = -1;
while (Date.now() - tf < 3100) { // a 50 ms tick that keeps the core busy between ticks
  tick(); const w = Date.now(); while (Date.now() - w < 50) { /* busy */ }
  if (at03 < 0 && Date.now() - tf >= 300) at03 = offF();
}
at31 = offF();
eq("(f) budget spent: history still advances (one step a second)", String(at31 > at03), "true");
eq("(f) …and no more than ~3 steps in 2.8 s", String(at31 - at03 <= 3 * 1048576), "true");
eq("(f) not done", String(at31 < f.size), "true");
PACE.share = 1; sessions.delete(f.path); ledger.delete(f.path);

// the gauge text by room; the ETA "~…" until 30 s of indexing were sampled, then rounded (whole minutes to 10 min, 5 min
// to an hour, 15 min above) and held against moves smaller than ¾ of a step
gaugeReset();
const G8 = 8589934592;
const s0 = { done: 34, total: 100, left: G8, bps: 0, span: 0 };
eq("gauge 40, no rate yet", gaugeText(s0, 40), "⟳ indexing 34% · 8.0G left · ~…");
const s1 = { done: 34, total: 100, left: G8, bps: G8 / 180, span: 31000 };
eq("gauge 40 with ETA", gaugeText(s1, 40), "⟳ indexing 34% · 8.0G left · ~3m");
eq("gauge ETA waits 30 s", gaugeText({ done: 34, total: 100, left: G8, bps: 1000, span: 20000 }, 40), "⟳ indexing 34% · 8.0G left · ~…");
eq("gauge 30", gaugeText(s1, 30), "⟳ 34% · 8.0G");
eq("gauge 10", gaugeText(s1, 10), "⟳ 34%");
eq("gauge 4: no room", gaugeText(s1, 4), "");
eq("gauge never 100% while indexing", gaugeText({ done: 9999, total: 10000, left: 1, bps: 0, span: 0 }, 8), "⟳ 99%");
const etaOf = (sec: number): string => { const t = gaugeText({ done: 1, total: 2, left: G8, bps: G8 / sec, span: 60000 }, 60); return t.slice(t.lastIndexOf("· ") + 2); };
gaugeReset(); eq("ETA under a minute", etaOf(40), "<1m");
gaugeReset(); eq("ETA 47 min: 5-min steps", etaOf(47 * 60), "~45m");
gaugeReset(); eq("ETA 2h07: 15-min steps", etaOf(127 * 60), "~2h");
gaugeReset(); eq("ETA 2h20", etaOf(140 * 60), "~2h15m");
gaugeReset(); etaOf(180); eq("held: 3.4 min stays ~3m", etaOf(204), "~3m"); eq("held: 3.6 min stays ~3m", etaOf(216), "~3m"); eq("moves: 3.8 min → ~4m", etaOf(228), "~4m");
// a cold index under the CPU budget books in bursts (credit spent, then waits; fast and slow logs): the rate is the
// throughput over about the last two minutes, idle waits included, so the implied finish time holds still. A seeded run:
// 6 GB at ~10 MB/s on average, every second 0 bytes half the time, else 0–40 MB
{
  gaugeReset(); const r = newRate(); let seed = 7; const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let left = 6000 * 1048576; let t = 1000000; const fin: number[] = []; let tilde = 0;
  for (let i = 0; i < 400 && left > 0; i++) {
    const b = rnd() < 0.5 ? 0 : Math.floor(rnd() * 40 * 1048576); left = Math.max(0, left - b); t += 1000;
    rateAdd(r, t, b, true);
    const txt = gaugeText({ done: 1, total: 2, left, bps: r.bps, span: r.span }, 60); const e = txt.slice(txt.lastIndexOf("· ") + 2);
    if (e === "~…") { tilde++; continue; }
    const m = /^~(\d+)m$/.exec(e); if (m) fin.push(t / 1000 + Number(m[1] ?? "0") * 60);
  }
  eq("burst run: ~… for the first 30 s only", String(tilde), "30");
  let lo = 1e18; let hi = 0; for (const x of fin.slice(30)) { lo = Math.min(lo, x); hi = Math.max(hi, x); } // after the first minute
  eq("burst run: the implied finish moves < 2.5 min (was 8 min)", String(hi - lo < 150) + " (" + String(Math.round(hi - lo)) + " s)", "true (" + String(Math.round(hi - lo)) + " s)");
  // idle time (nothing pending) is not indexing time: it neither counts as samples nor drags the rate down
  const span = r.span; const bps = r.bps; rateAdd(r, t + 60000, 0, false); rateAdd(r, t + 61000, 0, true);
  eq("idle: no samples, rate kept", String(r.span === span) + " " + String(r.bps === bps), "true true");
}

// a one-shot complete() leaves the read logs' day maps as text (a cold index must not hold every day decoded); they decode
// again on use, unchanged
const call = (id: string): string => "{\"type\":\"assistant\",\"timestamp\":\"" + TS + "\",\"requestId\":\"rq" + id + "\",\"message\":{\"id\":\"mm" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tu" + id + "\",\"name\":\"Bash\",\"input\":{\"command\":\"make " + id + "\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n";
const res = (id: string): string => "{\"type\":\"user\",\"timestamp\":\"" + TS + "\",\"uuid\":\"uu" + id + "\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tu" + id + "\",\"is_error\":true,\"content\":\"x\"}]}}\n";
const e = sess("e", call("1") + res("1") + call("2") + res("2"));
complete(e);
const ea = ledger.get(e.path); let packed = 0; let cmds = 0;
if (ea) for (const d of ea.days.values()) { if (!d.hx && d.hv) packed++; cmds += heavy(d).cmds.size; }
eq("complete packs day maps to text, decodable", String(packed) + " " + String(cmds), "1 2");
// …but not the day a pending call still books into: its result (a later read: --watch, a live log) lands in that day's
// tool and command counters
const g = sess("g", call("8") + res("8") + call("9"));
complete(g); grow(g, res("9")); complete(g);
const ga = ledger.get(g.path); let errs = ""; let cerr = 0;
if (ga) for (const d of ga.days.values()) { const t = heavy(d).tt.get("Bash"); errs = t ? String(t.n) + "/" + String(t.err) : "none"; for (const x of heavy(d).cmds.values()) cerr += x.err; }
eq("a pending call's result after complete() is counted", errs + " " + String(cerr), "2/2 2");
rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "ledger: all checks passed");
if (bad) process.exit(1);
