// agentglass — self-check for the ledger tick (work only where something changed), indexing() and the header gauge:
// scriptc build src/features/usage/ledger.check.ts -o lc && ./lc
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, appendFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { H } from "../../hooks.ts";
import { L } from "./record.ts";
import { ledger, indexing, indexState, reapplyAll, complete, PACE, TICK_STATS } from "./ledger.ts";
import { heavy } from "./record.ts";
import "./codec.ts"; // the day-map text codec (packHeavy)
import { gaugeText } from "./progress.ts";
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
PACE.sliceMs = 1000; a.pid = 0;
let more = ""; while (more.length < 3 * 1048576) more += asst(2); const d = sess("d", more);
let k = 0; for (; k < 20 && !(L.done === L.total && ledger.has(d.path) && (ledger.get(d.path)?.off ?? 0) === d.size); k++) tick();
eq("(e) 3 MB + 1 MB indexed within 20 ticks", String(k < 20 && L.done === L.total), "true");
eq("(e) not indexing once done", String(indexing()), "false");
const st = indexState(); eq("indexState done = total", String(st.done === st.total && st.left === 0), "true");

// the gauge text by room; the ETA only after 10 s of rate samples
const now = 1000000;
const s0 = { done: 34, total: 100, left: 8589934592, bps: 0, since: 0 };
eq("gauge 40, no rate yet", gaugeText(s0, 40, now), "⟳ indexing 34% · 8.0G left");
const s1 = { done: 34, total: 100, left: 8589934592, bps: 8589934592 / 180, since: now - 11000 };
eq("gauge 40 with ETA", gaugeText(s1, 40, now), "⟳ indexing 34% · 8.0G left · ~3m");
eq("gauge ETA waits 10 s", gaugeText({ done: 34, total: 100, left: 8589934592, bps: 1000, since: now - 5000 }, 40, now), "⟳ indexing 34% · 8.0G left");
eq("gauge 30", gaugeText(s1, 30, now), "⟳ 34% · 8.0G");
eq("gauge 10", gaugeText(s1, 10, now), "⟳ 34%");
eq("gauge 4: no room", gaugeText(s1, 4, now), "");
eq("gauge never 100% while indexing", gaugeText({ done: 9999, total: 10000, left: 1, bps: 0, since: 0 }, 8, now), "⟳ 99%");

// a one-shot complete() leaves the read logs' day maps as text (a cold index must not hold every day decoded); they decode
// again on use, unchanged
const call = (id: string): string => "{\"type\":\"assistant\",\"timestamp\":\"" + TS + "\",\"requestId\":\"rq" + id + "\",\"message\":{\"id\":\"mm" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tu" + id + "\",\"name\":\"Bash\",\"input\":{\"command\":\"make " + id + "\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n";
const e = sess("e", call("1") + call("2"));
complete(e);
const ea = ledger.get(e.path); let packed = 0; let cmds = 0;
if (ea) for (const d of ea.days.values()) { if (!d.hx && d.hv) packed++; cmds += heavy(d).cmds.size; }
eq("complete packs day maps to text, decodable", String(packed) + " " + String(cmds), "1 2");
rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "ledger: all checks passed");
if (bad) process.exit(1);
