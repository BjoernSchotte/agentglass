// agentglass — self-check for the live OTLP sink (queue, flush, late events, overflow, retries, approval waits):
// scriptc build src/features/otlp/live.check.ts -o lc && ./lc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { realCwd } from "../../hooks.ts";
import { type XTurn, newSpan } from "./types.ts";
import { newLive, liveTick, enqueue, liveStop, enqueueLog, flushLogs } from "./live.ts";
import { type XLog, heartbeat } from "./logs.ts";

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
// ── the logs stream (otlp-complete 2.3, 2.6): state on change + 300 s repeat + recovery, heartbeat every 30 s, turn.open once ──
{
  const pl = dir + "/logs-" + CID + ".jsonl"; writeFileSync(pl, lines.slice(0, 9).join("\n") + "\n"); // turn 1 open
  const sl: Sess = newSess("claude", "logs", pl, false); sl.pid = 4250; sessions.set(pl, sl);
  let t = Date.parse("2026-09-01T10:01:00.000Z"); sl.mtime = t - 1000;
  const LL = newLive(t); LL.logs = true; LL.want = (x: Sess) => x.path === pl; LL.warn = (m: string) => { warns.push(m); };
  let bz = true; LL.busyRule = (x) => !!x && bz; LL.approval = (x: Sess) => x ? "" : "";
  const got: XLog[] = []; let lok = true; let lcalls = 0;
  LL.sendLogs = (ls: XLog[]): boolean => { lcalls++; if (lok) for (const l of ls) got.push(l); return lok; };
  const nm = (from: number): string => { // record names without "agentglass.", state records with their true flags
    const out: string[] = [];
    for (const l of got.slice(from)) {
      let f = ""; if (l.name === "agentglass.session.state") { const on: string[] = []; for (const a of l.attrs) if (a.t === "b" && a.b) on.push(a.k.slice(19)); f = "(" + on.join("+") + ")"; }
      out.push(l.name.slice(11) + f);
    }
    return out.join(",");
  };
  const noSpans = (ts: XTurn[]): boolean => ts.length >= 0;
  liveTick(LL, t, noSpans);
  eq("logs: start snapshot", nm(0), "session.state(live+busy),turn.open,heartbeat");
  eq("logs: turn.open carries the turn's ids", got.length > 1 ? String(got[1].traceId.length === 32 && got[1].spanId.length === 16 && got[1].traceId === got[0].traceId) : "", "true");
  t += 5000; bz = false; liveTick(LL, t, noSpans);
  t += 5000; sl.attention = true; liveTick(LL, t, noSpans);
  t += 5000; liveTick(LL, t, noSpans); // no change
  eq("logs: exactly the changes", nm(3), "session.state(live),session.state(live+attention)");
  const n1 = got.length;
  t += 15000; liveTick(LL, t, noSpans); // 30 s after the first beat
  eq("logs: heartbeat at 30 s", nm(n1), "heartbeat");
  const n2 = got.length;
  t += 300000; liveTick(LL, t, noSpans); // 5 min later, no change
  eq("logs: 300 s repeat while live", nm(n2), "session.state(live+attention),heartbeat");
  // a new turn opens: one turn.open; polling again: none
  appendFileSync(pl, lines[9] + "\n"); sl.mtime = t; const n3 = got.length;
  t += 1000; liveTick(LL, t, noSpans); t += 6000; liveTick(LL, t, noSpans);
  eq("logs: one turn.open per turn", got.slice(n3).filter((l: XLog) => l.name === "agentglass.turn.open").length.toString(), "1");
  // a failing receiver: backoff; once it works again every live session's state is re-sent
  lok = false; sl.attention = false; const c0 = lcalls; const n4 = got.length;
  t += 6000; liveTick(LL, t, noSpans);
  eq("logs: failed flush keeps the queue", String(lcalls - c0) + " " + String(LL.lq.length > 0), "1 true");
  t += 1000; liveTick(LL, t, noSpans);
  eq("logs: no retry before the backoff", String(lcalls - c0), "1");
  lok = true; t += 5000; liveTick(LL, t, noSpans); t += 6000; liveTick(LL, t, noSpans);
  eq("logs: recovery re-sends the state", nm(n4), "session.state(live),session.state(live)");
  // the alert transitions the --watch loop hands over
  LL.pend.push({ s: sl, a: { rule: "loop", severity: "critical", state: "fire", value: 9, threshold: 8, labels: [], message: "m" } });
  const n5 = got.length; t += 6000; liveTick(LL, t, noSpans);
  eq("logs: one alert record", String(got.slice(n5).filter((l: XLog) => l.name === "agentglass.alert").length) + " " + String(got.slice(n5).filter((l: XLog) => l.name === "agentglass.alert")[0]?.sev), "1 17");
  // stop: the final flush includes the log queue
  enqueueLog(LL, heartbeat(t, 0, 0, 0)); const n6 = got.length;
  liveStop(LL, noSpans, 5000);
  eq("logs: stop flushes logs", nm(n6), "heartbeat");
  // overflow: 2001 queued → 2000, one warning
  const LO = newLive(0); LO.logs = true; const wo: string[] = []; LO.warn = (m: string) => { wo.push(m); };
  for (let i = 0; i <= 2000; i++) enqueueLog(LO, heartbeat(i, 0, 0, 0));
  eq("logs: overflow drops the oldest", String(LO.lq.length) + " " + String(LO.lq[0]?.t) + " warns " + String(wo.length), "2000 1 warns 1");
  // off (--no-logs, 404/405): nothing queued; halted (TLS): nothing sent
  const LN = newLive(0); LN.logs = false; let nc = 0; LN.sendLogs = (ls: XLog[]): boolean => { nc += ls.length + 1; return true; }; LN.want = (x: Sess) => x.path === pl;
  liveTick(LN, t, noSpans); liveTick(LN, t + 60000, noSpans);
  eq("logs off: nothing queued or sent", String(LN.lq.length) + " " + String(nc), "0 0");
  const LH = newLive(0); LH.logs = true; let hc = 0; LH.sendLogs = (ls: XLog[]): boolean => { hc += ls.length + 1; return true; }; LH.want = (x: Sess) => x.path === pl;
  LH.halt = "the receiver requires a client certificate"; liveTick(LH, t, noSpans); flushLogs(LH, t + 60000);
  eq("halted: nothing sent", String(hc) + " " + String(LH.lq.length), "0 0");
  // a 404 switches the stream off inside sendLogs: the queue is dropped
  const LF = newLive(0); LF.logs = true; LF.want = (x: Sess) => x.path === pl; let fc = 0;
  LF.sendLogs = (ls: XLog[]): boolean => { fc++; if (ls.length) LF.logs = false; return false; };
  liveTick(LF, t, noSpans); liveTick(LF, t + 60000, noSpans);
  eq("404: one request, then off", String(fc) + " " + String(LF.lq.length) + " " + String(LF.logs), "1 0 false");
  sessions.delete(pl);
}

// --filter is judged on every poll, after the read: a session whose log moves out of it (an agent cd-ing elsewhere) sends
// nothing more — not the turn it closes there, no state, no alert — and the heartbeat stops counting it; back in, it sends again (not the
// turn it opened outside)
{
  const pm = dir + "/move-" + CID + ".jsonl"; const at = (l: string, cwd: string): string => l.split("/home/u/proj").join(cwd);
  writeFileSync(pm, lines.slice(0, 9).map((l: string) => at(l, "/w/in")).join("\n") + "\n"); // turn 1 open, inside
  const sm: Sess = newSess("claude", "move", pm, false); sm.pid = 4260; sessions.set(pm, sm);
  let t = Date.parse("2026-09-01T10:01:00.000Z"); sm.mtime = t - 1000;
  const LM = newLive(0); LM.logs = true; LM.want = (x: Sess) => realCwd(x).startsWith("/w/in"); // the real one: the suite runs with --redact LM.warn = (m: string) => { warns.push(m); };
  LM.busyRule = (x) => !!x; LM.approval = (x: Sess) => x ? "" : "";
  const logs: XLog[] = []; LM.sendLogs = (ls: XLog[]): boolean => { for (const l of ls) logs.push(l); return true; };
  const spans: string[] = []; const sendM = (ts: XTurn[]): boolean => { for (const x of ts) spans.push(x.key + "@" + x.cwd); return true; };
  const outs = (from: number): number => { let n = 0; for (const l of logs.slice(from)) for (const a of l.attrs) if (a.s.indexOf("/w/out") >= 0) n++; return n; };
  sm.cwd = "/w/in"; liveTick(LM, t, sendM);
  eq("filter: inside at the start", String(logs.filter((l: XLog) => l.name === "agentglass.session.state").length), "1");
  appendFileSync(pm, at(lines[9] ?? "", "/w/out") + "\n"); t += 6000; sm.mtime = t; const n0 = logs.length;
  LM.pend.push({ s: sm, a: { rule: "loop", severity: "critical", state: "fire", value: 9, threshold: 8, labels: [], message: "m" } });
  liveTick(LM, t, sendM); t += 31000; liveTick(LM, t, sendM);
  eq("filter: moved out — no turn", spans.join(","), "");
  eq("filter: moved out — no record names it", String(outs(n0)), "0");
  eq("filter: moved out — no state or alert", logs.slice(n0).map((l: XLog) => l.name).join(","), "agentglass.heartbeat");
  const hb = logs[logs.length - 1]; eq("filter: heartbeat counts it no more", hb ? hb.attrs.map((a) => a.k + "=" + String(a.n) + a.s).filter((x: string) => x.indexOf(".live=") >= 0).join("") : "", "agentglass.sessions.live=0");
  appendFileSync(pm, at(lines[11] ?? "", "/w/in") + "\n"); t += 6000; sm.mtime = t; const n1 = logs.length;
  liveTick(LM, t, sendM);
  eq("filter: back inside — state again", String(logs.slice(n1).filter((l: XLog) => l.name === "agentglass.session.state").length) + " " + String(outs(n1)), "1 0");
  eq("filter: back inside — the turn opened outside is not sent", spans.join(","), "");
  sessions.delete(pm);
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
  const t: XTurn = { h: "claude", rootId: "x", path: "/x", key: k, index: 1, traceId: "0123456789abcdef0123456789abcdef", t0: 1, t1: 2, closed: true, closedBy: "next", compacted: false, ver: "", cwd: "", branch: "", remote: "", spans: [], fx: [], fxOn: false, title: "", repoKey: "" };
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
