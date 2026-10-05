// agentglass — self-check for cross-file message ownership (Claude forks, resumes, moved projects, forked subagents):
// scriptc build src/features/usage/owners.check.ts -o oc && ./oc
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, appendFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { type Acc, dayKey } from "./record.ts";
import { ledger, accOf, complete } from "./ledger.ts";
import { accOut, accIn } from "./codec.ts";
import { forget } from "./owners.ts";
import { parse } from "../../util/json.ts";
import { newSessB, finish } from "../otlp/build.ts";
import "../../harness/index.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-owners-check-" + String(process.pid); mkdirSync(dir + "/p1/S/subagents", { recursive: true }); mkdirSync(dir + "/p2", { recursive: true });

const D1 = "2026-09-01T10:00:00.000Z"; const D1b = "2026-09-01T10:05:00.000Z"; const D2 = "2026-09-03T10:00:00.000Z"; const D2b = "2026-09-03T10:05:00.000Z";
// one assistant message line: cache reads cr, output out, an optional Bash call
function asst(id: string, ts: string, cr: number, out: number, call: string): string {
  const c = call ? ",{\"type\":\"tool_use\",\"id\":\"" + call + "\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}" : "";
  return "{\"type\":\"assistant\",\"timestamp\":\"" + ts + "\",\"requestId\":\"req_" + id + "\",\"message\":{\"id\":\"" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}" + c + "],\"usage\":{\"input_tokens\":10,\"output_tokens\":" + String(out) + ",\"cache_read_input_tokens\":" + String(cr) + ",\"cache_creation_input_tokens\":0}}}";
}
// a message line without message.id: identified by its requestId
function asstReq(rq: string, ts: string, cr: number): string {
  return "{\"type\":\"assistant\",\"timestamp\":\"" + ts + "\",\"requestId\":\"" + rq + "\",\"message\":{\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"cache_read_input_tokens\":" + String(cr) + ",\"cache_creation_input_tokens\":0}}}";
}
function prompt(uuid: string, ts: string): string {
  return "{\"type\":\"user\",\"uuid\":\"" + uuid + "\",\"timestamp\":\"" + ts + "\",\"origin\":{\"kind\":\"human\"},\"message\":{\"role\":\"user\",\"content\":\"do it\"}}";
}
function result(call: string, ts: string): string {
  return "{\"type\":\"user\",\"timestamp\":\"" + ts + "\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"" + call + "\",\"type\":\"tool_result\",\"content\":\"x\"}]},\"uuid\":\"r-" + call + "\"}";
}
function put(path: string, lines: string[]): void { writeFileSync(path, lines.join("\n") + "\n"); }
function sess(path: string, parent: string): Sess {
  let s = sessions.get(path);
  if (!s) { s = newSess("claude", path.slice(path.lastIndexOf("/") + 1, -6), path, false); s.parent = parent; sessions.set(path, s); }
  s.size = statSync(path).size; s.mtime = Date.now();
  return s;
}
function reset(): void { sessions.clear(); ledger.clear(); forget(); }
function cr(s: Sess): number { const a = ledger.get(s.path); return a ? a.cr : -1; }
function show(s: Sess): string { const a = ledger.get(s.path); return a ? "cr " + String(a.cr) + " out " + String(a.outTok) + " tools " + String(a.tools) + " turns " + String(turns(a)) : "-"; }
function turns(a: Acc): number { let n = 0; for (const d of a.days.values()) n += d.turns; return n; }
function dayCr(s: Sess, iso: string): number { const a = ledger.get(s.path); const d = a ? a.days.get(dayKey(new Date(iso))) : undefined; return d ? d.cr : 0; }
function all(order: Sess[]): void { for (const s of order) complete(s); }

// ── fork copy: the fork file repeats the original's history (same ids, same timestamps), then goes on ──
const ORIG = dir + "/p1/a-orig.jsonl"; const FORK = dir + "/p1/b-fork.jsonl";
const HIST = [prompt("u1", D1), asst("m1", D1, 1000, 5, "c1"), result("c1", D1), asst("m2", D1b, 2000, 7, "")];
put(ORIG, HIST);
put(FORK, HIST.concat([prompt("u3", D2), asst("m3", D2, 4000, 9, "c3"), result("c3", D2)]));
for (const first of ["orig", "fork"]) {
  reset();
  const o = sess(ORIG, ""); const f = sess(FORK, "");
  all(first === "orig" ? [o, f] : [f, o]);
  eq("fork (" + first + " first): original keeps its history", show(o), "cr 3000 out 12 tools 1 turns 1");
  eq("fork (" + first + " first): the fork books only its own", show(f), "cr 4000 out 9 tools 1 turns 1");
  eq("fork (" + first + " first): the fork's copied day is empty", String(dayCr(f, D1)), "0");
}

// ── resumed session: the copy carries later timestamps; the earlier file owns them whatever the path order ──
const LATE = dir + "/p1/0-resumed.jsonl"; const EARLY = dir + "/p1/z-first.jsonl";
put(EARLY, [prompt("v1", D1), asst("n1", D1, 100, 1, ""), asst("n2", D1b, 200, 1, "")]);
put(LATE, [asst("n1", D2, 100, 1, ""), asst("n2", D2, 200, 1, ""), prompt("v2", D2b), asst("n3", D2b, 400, 1, "")]);
for (const first of ["late", "early"]) {
  reset();
  const l = sess(LATE, ""); const e = sess(EARLY, "");
  all(first === "late" ? [l, e] : [e, l]);
  eq("resume (" + first + " first): earliest timestamp owns", String(cr(e)) + "/" + String(cr(l)), "300/400");
  eq("resume (" + first + " first): no copy on the resume day", String(dayCr(l, D2)), "400");
}

// ── the same session file under two project dirs: booked once ──
const P1 = dir + "/p1/same.jsonl"; const P2 = dir + "/p2/same.jsonl";
const SAME = [prompt("w1", D1), asst("k1", D1, 10, 1, ""), asst("k2", D1b, 20, 1, "")];
put(P1, SAME); put(P2, SAME);
for (const first of [1, 2]) {
  reset();
  const x = sess(P1, ""); const y = sess(P2, "");
  all(first === 1 ? [x, y] : [y, x]);
  eq("two project dirs (" + String(first) + " first): booked once", String(cr(x) + cr(y)) + " turns " + String(turns(ledger.get(P1) ?? accOf(x)) + turns(ledger.get(P2) ?? accOf(y))), "30 turns 1");
  eq("two project dirs: stable owner", String(cr(x)), "30"); // same timestamps: the first path
}

// ── a forked subagent starts with a copy of its parent's last message (later or equal timestamp) ──
const PAR = dir + "/p1/zz-parent.jsonl"; const SUB = dir + "/p1/S/subagents/agent-a1.jsonl"; // the subagent sorts first by path
put(PAR, [prompt("x1", D1), asst("j1", D1, 50, 1, ""), asst("j2", D1b, 60, 1, "")]);
put(SUB, [asst("j2", D1b, 60, 1, ""), asst("s1", D1b, 70, 1, "")]);
for (const first of ["sub", "parent"]) {
  reset();
  const p = sess(PAR, ""); const s = sess(SUB, "zz-parent");
  all(first === "sub" ? [s, p] : [p, s]);
  eq("subagent copy (" + first + " first): the parent owns the shared message on a tie", String(cr(p)) + "/" + String(cr(s)), "110/70");
}

// ── requestId stands in for a missing message.id ──
const R1 = dir + "/p1/r1.jsonl"; const R2 = dir + "/p1/r2.jsonl";
put(R1, [asstReq("req_A", D1, 5)]); put(R2, [asstReq("req_A", D1, 5), asstReq("req_B", D2, 6)]);
reset(); { const x = sess(R1, ""); const y = sess(R2, ""); all([y, x]); eq("requestId fallback", String(cr(x)) + "/" + String(cr(y)), "5/6"); }

// ── the owner disappears: ownership passes to the copy ──
reset();
{
  const o = sess(ORIG, ""); const f = sess(FORK, "");
  all([o, f]);
  eq("owner deleted: before", String(cr(f)), "4000");
  sessions.delete(ORIG);
  complete(f);
  eq("owner deleted: the copy books it now", show(f), "cr 7000 out 21 tools 2 turns 2");
}

// ── restart: the ledger cache keeps who owns what, so a warm start never re-reads the owner ──
reset();
{
  const o = sess(ORIG, ""); all([o]);
  const saved = parse(JSON.stringify(accOut(ledger.get(ORIG) ?? accOf(o), 64)));
  reset();
  const o2 = sess(ORIG, ""); ledger.set(ORIG, accIn(saved ?? {})); // as cache.ts load() does
  const f = sess(FORK, ""); complete(f);
  eq("warm start: the copy still books only its own", String(cr(f)), "4000");
  eq("warm start: the owner was not re-read", String((ledger.get(ORIG) ?? accOf(o2)).off), String(statSync(ORIG).size));
  // the copy's skips survive a restart too: after one, the copy's owner going away still hands ownership over
  const sf = parse(JSON.stringify(accOut(ledger.get(FORK) ?? accOf(f), 64)));
  reset();
  const f2 = sess(FORK, ""); ledger.set(FORK, accIn(sf ?? {}));
  complete(f2);
  eq("warm start, owner gone: the copy books everything", String(cr(f2)), "7000");
}

// ── a file that turns out earlier takes over: the later one re-reads, its per-day buckets move with it ──
reset();
{
  const f = sess(FORK, ""); complete(f);
  eq("out of order: alone, the fork books all it holds", String(cr(f)) + " day1 " + String(dayCr(f, D1)), "7000 day1 3000");
  const o = sess(ORIG, ""); complete(o);
  eq("out of order: the original took its history", String(cr(o)), "3000");
  eq("out of order: the fork re-read without it", String(cr(f)) + " day1 " + String(dayCr(f, D1)) + " day2 " + String(dayCr(f, D2)), "4000 day1 0 day2 4000");
}

// ── growth: a copy appended to a live file after its owner was indexed ──
reset();
{
  const G = dir + "/p1/grow.jsonl"; put(G, [prompt("g0", D2), asst("g1", D2, 1, 1, "")]);
  const o = sess(ORIG, ""); const g = sess(G, ""); all([o, g]);
  appendFileSync(G, HIST.join("\n") + "\n" + asst("g2", D2b, 2, 1, "") + "\n");
  complete(sess(G, ""));
  eq("growth: appended copies book nothing", String(cr(g)) + " turns " + String(turns(ledger.get(G) ?? accOf(g))), "3 turns 1");
}

// ── the OTLP export sends a fork's copied requests no tokens either (they are the original's spans) ──
reset();
{
  const o = sess(ORIG, ""); const f = sess(FORK, ""); all([o, f]);
  const ts = finish(newSessB(f, []), { now: Date.now() + 86400000, quietMs: 600000, content: false, subagents: true });
  let r = 0; let n = 0; for (const t of ts) for (const x of t.spans) if (x.op === "chat") { r += x.cr; n++; }
  eq("otlp: a copy's requests carry no tokens", String(r) + " in " + String(n) + " chat span(s)", "4000 in 1 chat span(s)");
}

// ── a message split over several lines (thinking, then text, then a call) stays one booking in its own file ──
reset();
{
  const M = dir + "/p1/multi.jsonl";
  put(M, [asst("q1", D1, 100, 2, ""), asst("q1", D1, 100, 8, "cq"), result("cq", D1)]);
  const m = sess(M, ""); complete(m);
  eq("multi-line message", show(m), "cr 100 out 8 tools 1 turns 0");
}

rmSync(dir, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " check(s) failed"); process.exit(1); }
console.log("all checks passed");
