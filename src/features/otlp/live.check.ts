// agentglass — self-check for the live OTLP sink (queue, flush, late events, overflow, retries, approval waits):
// scriptc build src/features/otlp/live.check.ts -o lc && ./lc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { type XTurn, newSpan } from "./types.ts";
import { newLive, liveTick, enqueue, liveStop } from "./live.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const CID = "11111111-1111-4111-8111-111111111111";
const lines = readFileSync("testdata/otlp/fixtures/claude/.claude/projects/-home-u-proj/" + CID + ".jsonl", "utf8").trim().split("\n");
const dir = "/tmp/agentglass-live-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
const p = dir + "/" + CID + ".jsonl";
writeFileSync(p, lines.slice(0, 9).join("\n") + "\n"); // turn 1, its last answer included
const s: Sess = newSess("claude", CID, p, false); s.pid = 4242;
sessions.set(p, s);
let T = Date.parse("2026-09-01T10:01:00.000Z");
s.mtime = T - 1000;
const L = newLive(0);
const sent: string[] = []; let ok = true; let calls = 0;
const send = (ts: XTurn[]): boolean => { calls++; if (ok) for (const t of ts) sent.push(t.key + ":" + t.closedBy); return ok; };
const warns: string[] = []; L.warn = (m: string) => { warns.push(m); };

liveTick(L, T, send);
eq("open turn not sent", sent.join(","), "");
appendFileSync(p, lines[9] + "\n"); T += 5000; s.mtime = T;
liveTick(L, T, send);
eq("next prompt closes turn 1", sent.join(","), "2026-09-01T10:00:00.000Z#0:next");
T += 5000; liveTick(L, T, send);
eq("sent once", sent.join(","), "2026-09-01T10:00:00.000Z#0:next");
// approval wait on the open call (estimated by the watchdog; a stub here)
appendFileSync(p, lines[10] + "\n"); T = Date.parse("2026-09-01T10:05:03.000Z"); s.mtime = T;
let note = "";
L.approval = (x: Sess) => x ? note : "";
liveTick(L, T, send);
note = "Bash pending 25s"; T += 25000; liveTick(L, T, send);
T += 5000; liveTick(L, T, send);
note = ""; T += 5000; liveTick(L, T, send); // approved 35 s after the call started (2026-09-01T10:05:02)
const b = L.b.get(p); const op = b ? b.open : null;
const call = op ? op.spans.filter((x) => x.op === "execute_tool")[0] : undefined;
eq("approval wait recorded", call ? call.attrs.map((a) => a.k + "=" + String(a.n > 0)).join(",") + " " + call.events.map((e) => e.name + ":" + e.attrs.map((a) => a.k).join("")).join(",") : "none", "agentglass.tool.approval_wait=true agentglass.approval_wait:agentglass.estimated");
// a call logged only after it ran (Gemini): the cleared wait waits for the call that covers it
{
  const p2 = dir + "/late-" + CID + ".jsonl"; writeFileSync(p2, lines.slice(0, 10).join("\n") + "\n");
  const s2: Sess = newSess("claude", "late", p2, false); s2.pid = 4243; sessions.set(p2, s2);
  const L4 = newLive(0); let n4 = ""; const s4 = (ts: XTurn[]): boolean => ts.length >= 0; L4.approval = (x: Sess) => x ? n4 : ""; L4.warn = (m: string) => { warns.push(m); };
  let t4 = Date.parse("2026-09-01T10:05:03.000Z"); s2.mtime = t4;
  liveTick(L4, t4, s4); // first sight: the builder reads the session
  n4 = "approval dialog open"; liveTick(L4, t4, s4);
  t4 = Date.parse("2026-09-01T10:05:12.000Z"); n4 = ""; liveTick(L4, t4, s4);
  appendFileSync(p2, lines.slice(10, 12).join("\n") + "\n"); s2.mtime = t4; t4 += 1000; liveTick(L4, t4, s4); t4 += 1000; liveTick(L4, t4, s4);
  const ob = L4.b.get(p2); const oo = ob ? ob.open : null;
  const c4 = oo ? oo.spans.filter((x) => x.op === "execute_tool")[0] : undefined;
  eq("late-logged call gets the wait", c4 ? c4.attrs.map((a) => a.k + "=" + String(a.n)).join(",") : "none", "agentglass.tool.approval_wait=10");
  sessions.delete(p2);
}
// a turn already running when the watch starts is exported once it closes (spec 5.2); one closed before the start is not
{
  const p5 = dir + "/run-" + CID + ".jsonl"; writeFileSync(p5, lines.slice(0, 9).join("\n") + "\n"); // turn 1 still open
  const s5: Sess = newSess("claude", "run", p5, false); s5.pid = 4245; sessions.set(p5, s5);
  const start = Date.parse("2026-09-01T10:01:00.000Z"); s5.mtime = start - 30000; // written before the start
  const L5 = newLive(start); const got5: string[] = []; L5.warn = (m: string) => { warns.push(m); }; L5.want = (x: Sess) => x.path === p5;
  const send5 = (ts: XTurn[]): boolean => { for (const t of ts) got5.push(t.key); return true; };
  liveTick(L5, start, send5);
  appendFileSync(p5, lines[9] + "\n"); s5.mtime = start + 5000; liveTick(L5, start + 6000, send5);
  eq("running at start: sent when it closes", got5.join(","), "2026-09-01T10:00:00.000Z#0");
  const p6 = dir + "/hist-" + CID + ".jsonl"; writeFileSync(p6, lines.slice(0, 10).join("\n") + "\n"); // turn 1 closed by turn 2
  const s6: Sess = newSess("claude", "hist", p6, false); s6.pid = 4246; s6.mtime = start - 30000; sessions.set(p6, s6);
  sessions.delete(p5);
  const L6 = newLive(start); const got6: string[] = []; L6.warn = (m: string) => { warns.push(m); }; L6.want = (x: Sess) => x.path === p6;
  liveTick(L6, start, (ts: XTurn[]): boolean => { for (const t of ts) got6.push(t.key); return true; });
  eq("closed before the start: not sent", got6.join(","), "");
  sessions.delete(p6);
}
// late events: turn 2 closes by quiet time (2 min); a later result opens a continuation turn, turn 2 is not sent again
appendFileSync(p, lines[11] + "\n"); s.mtime = T; T += 1000; liveTick(L, T, send);
T += 130000; liveTick(L, T, send);
eq("quiet close", sent.slice(1).join(","), "2026-09-01T10:05:00.000Z#0:quiet");
appendFileSync(p, lines[12] + "\n"); s.mtime = T; T += 1000; liveTick(L, T, send);
T += 130000; liveTick(L, T, send);
eq("late event: continuation turn", sent.slice(1).join(","), "2026-09-01T10:05:00.000Z#0:quiet,2026-09-01T10:05:12.000Z#0:quiet");
// a failing backend: the turns stay queued, retried after a backoff
const L2 = newLive(0); L2.warn = (m: string) => { warns.push(m); };
const big = (k: string, n: number): XTurn => {
  const t: XTurn = { h: "claude", rootId: "x", path: "/x", key: k, index: 1, traceId: "0123456789abcdef0123456789abcdef", t0: 1, t1: 2, closed: true, closedBy: "next", compacted: false, ver: "", cwd: "", branch: "", remote: "", spans: [], fx: [], fxOn: false };
  for (let i = 0; i < n; i++) t.spans.push(newSpan("execute_tool", "x", "s" + String(i), "", 1, "x"));
  return t;
};
sessions.clear();
ok = false; calls = 0;
enqueue(L2, big("a", 600));
liveTick(L2, 100000, send);
eq("failed flush keeps the queue", String(calls) + " " + String(L2.q.length), "1 1");
liveTick(L2, 101000, send);
eq("no retry before the backoff", String(calls), "1");
ok = true; liveTick(L2, 106000, send);
eq("retried", String(calls) + " " + String(L2.q.length) + " " + sent[sent.length - 1], "2 0 a:next");
// overflow: more than 10,000 queued spans drop the oldest whole turns, one warning
const L3 = newLive(0); const w3: string[] = []; L3.warn = (m: string) => { w3.push(m); };
for (const k of ["o1", "o2", "o3"]) enqueue(L3, big(k, 4000));
enqueue(L3, big("o4", 1));
eq("overflow", L3.q.map((t: XTurn) => t.key).join(",") + " " + String(L3.qSpans) + " warns " + String(w3.length), "o2,o3,o4 8001 warns 1");
// stop: one last flush
ok = true; const before = sent.length;
liveStop(L3, send, 5000);
eq("stop flushes", String(sent.length - before) + " " + String(L3.q.length), "3 0");
rmSync(dir, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp live: all checks passed");
