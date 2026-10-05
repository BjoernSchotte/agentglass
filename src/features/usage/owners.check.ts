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
function sess(path: string, parent: string): Sess { return sessOf("claude", path, parent); }
function sessOf(h: string, path: string, parent: string): Sess {
  let s = sessions.get(path);
  if (!s) { s = newSess(h, path.slice(path.lastIndexOf("/") + 1, -6), path, false); s.parent = parent; sessions.set(path, s); }
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

// ── Codex: a forked rollout (fork_context subagent) starts with a copy of its parent's history, calls included ──
reset();
{
  const PID = "019d24d0-99f7-7d61-94aa-158608eb5206"; const FID = "019d24d1-11d6-7452-a702-ead2b435dd14";
  const PP = dir + "/p1/rollout-2026-03-25T12-45-43-" + PID + ".jsonl"; const FP = dir + "/p1/rollout-2026-03-25T12-46-14-" + FID + ".jsonl";
  const meta = (id: string, ts: string, fork: string): string => "{\"timestamp\":\"" + ts + "\",\"type\":\"session_meta\",\"payload\":{\"id\":\"" + id + "\"" + (fork ? ",\"forked_from_id\":\"" + fork + "\"" : "") + ",\"timestamp\":\"" + ts + "\",\"cwd\":\"/w\"}}";
  const call = (id: string, ts: string): string => "{\"timestamp\":\"" + ts + "\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"ls " + "x".repeat(500) + "\\\"}\",\"call_id\":\"" + id + "\"}}";
  const out = (id: string, ts: string): string => "{\"timestamp\":\"" + ts + "\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"" + id + "\",\"output\":\"ok\"}}";
  put(PP, [meta(PID, "2026-03-25T11:45:43.000Z", ""), call("call_A", "2026-03-25T11:45:50.000Z"), out("call_A", "2026-03-25T11:45:51.000Z"), call("call_B", "2026-03-25T11:46:00.000Z"), out("call_B", "2026-03-25T11:46:01.000Z")]);
  put(FP, [meta(FID, "2026-03-25T11:46:14.623Z", PID), call("call_A", "2026-03-25T11:46:14.624Z"), out("call_A", "2026-03-25T11:46:14.624Z"), call("call_B", "2026-03-25T11:46:14.624Z"), out("call_B", "2026-03-25T11:46:14.624Z"), call("call_C", "2026-03-25T11:46:18.397Z"), out("call_C", "2026-03-25T11:46:18.536Z")]);
  const p = sessOf("codex", PP, ""); const f = sessOf("codex", FP, "");
  all([f, p]);
  eq("codex fork: the copied calls stay the parent's", String((ledger.get(PP) ?? accOf(p)).tools) + "/" + String((ledger.get(FP) ?? accOf(f)).tools), "2/1");
}

// ── a message split over several lines (thinking, then text, then a call) stays one booking in its own file ──
reset();
{
  const M = dir + "/p1/multi.jsonl";
  put(M, [asst("q1", D1, 100, 2, ""), asst("q1", D1, 100, 8, "cq"), result("cq", D1)]);
  const m = sess(M, ""); complete(m);
  eq("multi-line message", show(m), "cr 100 out 8 tools 1 turns 0");
}

// ── a background continuation: the new file copies the whole history under the same timestamps, and every copied line
// keeps the original's session_id (sessionId is the new file's). The original owns it although the copy sorts first ──
const CA = "3c4e27dd-7185-40bd-a29f-8ca06a57d08c"; const CB = "3c00e05d-2078-4567-871d-d54d9b91d8c4";
const CONT_A = dir + "/p1/" + CA + ".jsonl"; const CONT_B = dir + "/p1/" + CB + ".jsonl";
const tag = (l: string, file: string, sid: string): string => l.slice(0, -1) + ",\"sessionId\":\"" + file + "\",\"session_id\":\"" + sid + "\"}";
const CHIST = [prompt("ca1", D1), asst("ca-m1", D1, 1000, 5, ""), asst("ca-m2", D1b, 2000, 7, "")];
const contA: string[] = []; const contB: string[] = []; for (const l of CHIST) { contA.push(tag(l, CA, CA)); contB.push(tag(l, CB, CA)); }
put(CONT_A, contA);
put(CONT_B, contB.concat([tag(prompt("cb1", D2), CB, CB), tag(asst("cb-m1", D2, 4000, 9, ""), CB, CB)]));
for (const first of ["copy", "original"]) {
  reset();
  const a = sess(CONT_A, ""); const b = sess(CONT_B, "");
  all(first === "copy" ? [b, a] : [a, b]);
  eq("continuation (" + first + " first): the original owns its history", show(a) + " | " + show(b), "cr 3000 out 12 tools 0 turns 1 | cr 4000 out 9 tools 0 turns 1");
}
// a one-shot command that reads only the copy reads the session its lines name too: the same numbers as a full index
reset();
{ sess(CONT_A, ""); const b = sess(CONT_B, ""); complete(b); eq("continuation, copy alone: settled like a full index", show(b), "cr 4000 out 9 tools 0 turns 1"); }

// a session started after /clear keeps its process's first session_id on its own lines: that names no copy, so the root
// still owns what its forked subagent copied
{
  const RS = dir + "/p1/R"; mkdirSync(RS + "/subagents", { recursive: true });
  const RP = RS + ".jsonl"; const RF = RS + "/subagents/agent-rfork.jsonl";
  writeFileSync(RF.slice(0, -6) + ".meta.json", "{\"agentType\":\"fork\",\"isFork\":true}");
  const other = (l: string): string => l.slice(0, -1) + ",\"session_id\":\"8995df07-86f2-4f93-92ea-be9d41b4d33b\"}";
  put(RP, [other(prompt("rp1", D1)), other(asst("rm1", D1, 100, 1, "")), other(asst("rm2", D1b, 200, 1, ""))]);
  put(RF, [asst("rm2", D1b, 200, 1, ""), asst("rf1", D2, 7, 1, "")]);
  for (const first of ["fork", "root"]) {
    reset();
    const r = sess(RP, ""); const f = sess(RF, "R");
    all(first === "fork" ? [f, r] : [r, f]);
    eq("root after /clear (" + first + " first): the root owns its message", String(cr(r)) + "/" + String(cr(f)), "300/7");
  }
}

// ── forks of a subagent: each starts with a copy of its parent agent's history (meta isFork + parentAgentId); the parent
// agent owns it although a fork sorts first by path, and a fork read alone settles the same way ──
const FS = dir + "/p1/F/subagents"; mkdirSync(FS, { recursive: true });
const PA = FS + "/agent-zparent.jsonl"; const F1 = FS + "/agent-a1fork.jsonl"; const F2 = FS + "/agent-b2fork.jsonl";
writeFileSync(FS + "/agent-zparent.meta.json", "{\"agentType\":\"general-purpose\"}");
for (const f of [F1, F2]) writeFileSync(f.slice(0, -6) + ".meta.json", "{\"agentType\":\"fork\",\"isFork\":true,\"parentAgentId\":\"zparent\"}");
put(dir + "/p1/F.jsonl", [prompt("fr1", D1)]);
const FB = [asst("fb1", D1, 100, 1, "cf1"), result("cf1", D1), asst("fb2", D1b, 200, 1, "")];
put(PA, FB.concat([asst("fp3", D2, 300, 1, "")]));
put(F1, FB.concat([asst("f1own", D2, 10, 1, "")])); put(F2, FB.concat([asst("f2own", D2b, 20, 1, "")]));
const fam = (): string => show(sessions.get(PA) ?? sess(PA, "F")) + " | " + show(sessions.get(F1) ?? sess(F1, "F")) + " | " + show(sessions.get(F2) ?? sess(F2, "F"));
const FAM = "cr 600 out 3 tools 1 turns 0 | cr 10 out 1 tools 0 turns 0 | cr 20 out 1 tools 0 turns 0";
for (const order of ["forks first", "parent first"]) {
  reset(); sess(dir + "/p1/F.jsonl", "");
  const pa = sess(PA, "F"); const f1 = sess(F1, "F"); const f2 = sess(F2, "F");
  all(order === "forks first" ? [f2, f1, pa] : [pa, f1, f2]);
  eq("subagent forks (" + order + "): the parent agent owns the copied block", fam(), FAM);
}
reset(); sess(dir + "/p1/F.jsonl", "");
{ sess(PA, "F"); sess(F2, "F"); const f1 = sess(F1, "F"); complete(f1); eq("subagent fork alone: settled like a full index", show(f1), "cr 10 out 1 tools 0 turns 0"); }
// the parent agent's log goes away: the first fork by path owns the block now, and that equals a cold rebuild
{
  reset(); sess(dir + "/p1/F.jsonl", "");
  const pa = sess(PA, "F"); const f1 = sess(F1, "F"); const f2 = sess(F2, "F"); all([pa, f1, f2]);
  sessions.delete(PA); all([f1, f2]);
  const inc = show(f1) + " | " + show(f2);
  reset(); sess(dir + "/p1/F.jsonl", ""); const g1 = sess(F1, "F"); const g2 = sess(F2, "F"); all([g2, g1]);
  eq("parent agent gone: incremental equals a cold rebuild", inc, show(g1) + " | " + show(g2));
  eq("parent agent gone: one fork books the block", inc, "cr 310 out 3 tools 1 turns 0 | cr 20 out 1 tools 0 turns 0");
}

// ── Codex: a fork's copied token_count totals are its parent's usage: the fork counts on from them ──
reset();
{
  const PID = "019d24d0-0000-7d61-94aa-158608eb5206"; const FID = "019d24d1-0000-7452-a702-ead2b435dd14";
  const PP = dir + "/p1/rollout-2026-03-25T12-45-43-" + PID + ".jsonl"; const FP = dir + "/p1/rollout-2026-03-25T12-46-14-" + FID + ".jsonl";
  const meta = (id: string, ts: string, fork: string): string => "{\"timestamp\":\"" + ts + "\",\"type\":\"session_meta\",\"payload\":{\"id\":\"" + id + "\"" + (fork ? ",\"forked_from_id\":\"" + fork + "\"" : "") + ",\"timestamp\":\"" + ts + "\",\"cwd\":\"/w\"}}";
  const tok = (ts: string, inp: number, out: number): string => "{\"timestamp\":\"" + ts + "\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":" + String(inp) + ",\"cached_input_tokens\":0,\"output_tokens\":" + String(out) + ",\"reasoning_output_tokens\":0,\"total_tokens\":" + String(inp + out) + "}}}}";
  const ask = (ts: string): string => "{\"timestamp\":\"" + ts + "\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"go on\"}]}}";
  put(PP, [meta(PID, "2026-03-25T11:45:43.000Z", ""), ask("2026-03-25T11:45:44.000Z"), tok("2026-03-25T11:45:50.000Z", 1000, 10), tok("2026-03-25T11:46:00.000Z", 3000, 30), tok("2026-03-25T11:50:00.000Z", 9000, 90)]);
  put(FP, [meta(FID, "2026-03-25T11:46:14.623Z", PID), meta(PID, "2026-03-25T11:46:14.624Z", ""), ask("2026-03-25T11:46:14.624Z"), tok("2026-03-25T11:46:14.624Z", 1000, 10), tok("2026-03-25T11:46:14.624Z", 3000, 30), ask("2026-03-25T11:46:16.000Z"), tok("2026-03-25T11:46:18.000Z", 3500, 35)]);
  const p = sessOf("codex", PP, ""); const f = sessOf("codex", FP, "");
  all([f, p]);
  const fa = ledger.get(FP) ?? accOf(f);
  eq("codex fork: copied totals book nothing, the fork's own delta does", String(fa.inTok) + "/" + String(fa.outTok), "500/5");
  const ts = finish(newSessB(f, []), { now: Date.now() + 86400000, quietMs: 600000, content: false, subagents: true });
  let n = 0; let ti = 0; for (const t of ts) for (const x of t.spans) if (x.op === "chat") { n++; ti += x.nIn; } // nIn: uncached input + cache reads
  eq("codex fork otlp: one chat span, the fork's own request", String(n) + " span(s), in " + String(ti), "1 span(s), in 500");
}

rmSync(dir, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " check(s) failed"); process.exit(1); }
console.log("all checks passed");
