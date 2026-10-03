// agentglass — OTLP export: transcripts → turns of spans (spec 1–3). One trace per turn: an invoke_agent root, a chat span
// per API request, execute_tool siblings, subagents under their spawning call. Reads each session whole and incrementally
// (SessB keeps the cursor), so the one-shot export and the live sink share it.
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../../model/types.ts";
import { harnessOf, sourceOf, parseEvents, window, epochOf, busy } from "../../harness/index.ts";
import { type Acc, type Booking, newAcc, setBookTap } from "../usage/record.ts";
import { setCallTap, program, norm, mcpServer } from "../usage/calls.ts";
import { modeOf } from "../usage/bill-live.ts";
import { kiroTurns, type KTurn } from "../../harness/kiro.ts";
import { fxTotals } from "../../harness/fx.ts";
import { type TurnCursor, newCursor, feed, closeQuiet } from "../callgraph/turns.ts";
import { catOf, toolName, toolArg, isErr, ms } from "../callgraph/model.ts";
import { type ReqState, type Req, newReqState, requestOf, providerOf } from "./requests.ts";
import { rootKey, traceId, rootSpanId, chatSpanId, toolSpanId, agentSpanId } from "./ids.ts";
import { type XSpan, type XTurn, newSpan, agentName } from "./types.ts";

export interface BuildOpts { now: number; quietMs: number; content: boolean; subagents: boolean }
interface CallRec { ms: number; err: boolean; codes: number[]; name: string }
// one (sub)session being read: cursor, ledger-style Acc (usage() runs on it), request state, open calls
export interface Side {
  s: Sess; at: number; ep: string; acc: Acc; rq: ReqState; top: boolean;
  last: number; mark: number; // newest event time; when the next request starts (prompt, tool result, previous response)
  pend: Map<string, XSpan>; anon: XSpan[]; // calls waiting for their result (by call id; without an id in order)
  chats: Map<string, XSpan>; lastChat: XSpan | null; outBuf: string; // requests of the current turn (streamed lines share one); assistant text not yet given to a request
  lineTurn: string; lineAt: number; // where this line's first span went (a request's chat goes before the calls it issued)
  pieces: Map<string, XSpan>; // subagents: their invoke_agent span per hosting turn key
  first: number; // subagents: first event time (spawn host)
}
export interface SessB {
  root: Sess; subs: Side[]; side: Side; cur: TurnCursor; R: string;
  open: XTurn | null; done: XTurn[]; // the turn being built; turns closed but not yet returned
  tsN: Map<string, number>; // turn keys: ordinal per first timestamp
  tail: Ev[]; ver: string; // recent root events (busy()), harness version
  kiro: KTurn[];
}
const WIN = 1048576;

function newSide(s: Sess, top: boolean): Side {
  const a = newAcc(); a.sub = !top;
  return { s, at: 0, ep: epochOf(s), acc: a, rq: newReqState(), top, last: 0, mark: 0, pend: new Map<string, XSpan>(), anon: [], chats: new Map<string, XSpan>(), lastChat: null, outBuf: "", lineTurn: "", lineAt: -1, pieces: new Map<string, XSpan>(), first: 0 };
}
export function newSessB(root: Sess, subs: Sess[]): SessB {
  const sd: Side[] = []; for (const c of subs) sd.push(newSide(c, false));
  return { root, subs: sd, side: newSide(root, true), cur: newCursor(), R: rootKey(root.h, root.id), open: null, done: [], tsN: new Map<string, number>(), tail: [], ver: "", kiro: [] };
}
// push and hand back the stored element: scriptc 0.1.7 may store a copy of a freshly built object, so later writes go
// through the array's element (the call graph keeps indexes for the same reason)
function add(tr: XTurn, s: XSpan): XSpan { tr.spans.push(s); return tr.spans[tr.spans.length - 1]; }
function addAt(tr: XTurn, s: XSpan, i: number): XSpan { if (i < 1 || i >= tr.spans.length) return add(tr, s); tr.spans.splice(i, 0, s); return tr.spans[i]; }
function cut(s: string, n: number): string { return s.length > n ? s.slice(0, n) : s; }
const CMAX = 65536; // content kept per field while building (the encoder truncates to otlp.contentMax)

// ── turns ──
function startTurn(b: SessB, e: Ev, t: number): XTurn {
  const k = e.ts ? e.ts + "#" + String(b.tsN.get(e.ts) ?? 0) : "i" + String(b.cur.n);
  if (e.ts) b.tsN.set(e.ts, (b.tsN.get(e.ts) ?? 0) + 1);
  const r = b.root;
  const tr: XTurn = { h: r.h, rootId: r.id, path: r.path, key: k, index: b.cur.n, traceId: traceId(b.R, k), t0: t, t1: t, closed: false, closedBy: "", compacted: false, ver: b.ver, cwd: r.cwd, branch: r.branch, remote: r.remote, spans: [] };
  const root = newSpan("invoke_agent", "invoke_agent " + agentName(r.h), rootSpanId(b.R, k), "", t, r.id);
  tr.spans.push(root);
  const sd = b.side; sd.chats = new Map<string, XSpan>(); sd.lastChat = null; sd.outBuf = "";
  return tr;
}
// the root's turn a subagent event at time t belongs to: the last turn not yet returned that started at or before t, else the first
function hostTurn(b: SessB, t: number): XTurn | null {
  let best: XTurn | null = null; let first: XTurn | null = null;
  const all: XTurn[] = b.done.slice(0); const op = b.open; if (op) all.push(op);
  for (const x of all) { if (!first) first = x; if (x.t0 <= t) best = x; }
  return best ?? first;
}
// the root-session span a subagent hangs under (call-graph hostOf on exporter spans): its spawning call, else the latest
// spawn-like call started by then, else the turn's root
export function hostSpan(t: XTurn, spawn: string, at: number): number {
  if (spawn) for (let i = 0; i < t.spans.length; i++) { const s = t.spans[i]; if (s.op === "execute_tool" && s.callId === spawn && s.agent === "") return i; }
  let best = 0;
  for (let i = 0; i < t.spans.length; i++) { const s = t.spans[i]; if (s.op === "execute_tool" && s.agent === "" && catOf(s.tool) === 4 && s.t0 <= at + 1000) best = i; }
  return best;
}
function pieceOf(b: SessB, sd: Side, tr: XTurn, t: number): XSpan {
  const hit = sd.pieces.get(tr.key); if (hit) return hit;
  const sf = harnessOf(sd.s.h).spawnOf; const spawn = sf ? sf(sd.s) : "";
  const host = tr.spans[hostSpan(tr, spawn, t)];
  const kind = sd.s.kind || "subagent";
  const p = newSpan("invoke_agent", "invoke_agent " + kind, agentSpanId(b.R, sd.s.id, tr.key), host.spanId, t, sd.s.id);
  p.agent = kind;
  const pc = add(tr, p); sd.pieces.set(tr.key, pc);
  sd.chats = new Map<string, XSpan>(); sd.lastChat = null;
  return pc;
}
function errType(text: string, err: boolean): string {
  const t = text.trimStart();
  if (/^The user doesn't want to proceed|^\[(rejected|denied)\]/i.test(t)) return "rejected";
  if (/^\[(cancel|aborted)|^\[Request interrupted/i.test(t)) return "cancelled";
  if (/^\[timeout/i.test(t)) return "timeout";
  return err ? "tool_error" : "";
}
function mcpTool(name: string): string { const sv = mcpServer(name); return sv ? name.slice(5 + sv.length + 2) : name; }

// ── one line of a (sub)session ──
function line(b: SessB, sd: Side, l: string, o: BuildOpts): void {
  const h = sd.s.h; const a = sd.acc;
  const bs: Booking[] = []; const calls = new Map<string, CallRec>();
  const rs0 = a.rs;
  setBookTap((x: Booking) => { bs.push(x); });
  setCallTap((id: string, d: number, err: boolean, codes: number[], name: string) => { calls.set(id, { ms: d, err, codes, name }); });
  try { harnessOf(h).usage(a, l); } finally { setBookTap(null); setCallTap(null); }
  const q = requestOf(h, null, l, sd.rq);
  if (sd.top && !b.ver) { const m = /"(?:cli_)?version":"([^"]+)"/.exec(l.slice(0, 2000)); if (m && (h === "claude" || h === "codex")) b.ver = m[1] ?? ""; }
  const evs: Ev[] = [];
  parseEvents(h, l, evs, sd.s);
  sd.lineAt = -1; sd.lineTurn = "";
  let tr: XTurn | null = sd.top ? b.open : null;
  for (const e of evs) {
    const t = ms(e.ts) || sd.last;
    if (t > sd.last) sd.last = t;
    if (sd.top) {
      b.tail.push(e); if (b.tail.length > 60) b.tail.shift();
      const st = feed(b.cur, e, true);
      if (st === "open") { const op = b.open; if (op) closeTurn(b, op, b.cur.closedBy === "next" ? "next" : b.cur.closedBy, o); b.open = startTurn(b, e, t); }
      tr = b.open;
      if (!tr) continue;
      if (st === "close") { tr.t1 = Math.max(tr.t1, t); fxStart(tr, e); closeTurn(b, tr, b.cur.closedBy, o); b.open = null; continue; }
    } else {
      if (!sd.first && t) sd.first = t;
      tr = hostTurn(b, t);
      if (!tr) continue;
    }
    event(b, sd, tr, e, t, calls, o);
  }
  if (!tr && !sd.top) tr = hostTurn(b, sd.last);
  if (tr && (q || bs.length > 0 || a.rs > rs0)) request(b, sd, tr, q, bs, a.rs - rs0, o);
  if (sd.top && b.open && l.indexOf("Base directory for this skill:") >= 0 && l.indexOf("\"isMeta\":true") >= 0) { // a slash command's skill (parsing-fixes L6)
    const rt = b.open.spans[0]; const m = /^\/([^\s]+)/.exec(rt.input);
    if (m) rt.skill = m[1] ?? "";
  }
}
// fx: "turn complete · Ns" is logged at the turn's end, its events share one timestamp: the turn started N s earlier
function fxStart(tr: XTurn, e: Ev): void {
  const m = /· ([\d.]+)s/.exec(e.text); const d = m ? Number(m[1] ?? "0") * 1000 : 0;
  if (d > 0 && tr.t1 - d < tr.t0) { tr.t0 = tr.t1 - d; tr.spans[0].t0 = tr.t0; }
}
function parentOf(b: SessB, sd: Side, tr: XTurn, t: number): XSpan { return sd.top ? tr.spans[0] : pieceOf(b, sd, tr, t); }
function event(b: SessB, sd: Side, tr: XTurn, e: Ev, t: number, calls: Map<string, CallRec>, o: BuildOpts): void {
  const par = parentOf(b, sd, tr, t);
  if (t > tr.t1) tr.t1 = t;
  if (t && (par.t1 < t || !par.t0)) { if (!par.t0) par.t0 = t; par.t1 = Math.max(par.t1, t); }
  if (e.kind === "user") { if (!par.input) par.input = cut(e.text, CMAX); sd.mark = t; return; }
  if (e.kind === "assistant") { sd.outBuf = cut(sd.outBuf ? sd.outBuf + "\n" + e.text : e.text, CMAX); par.output = cut(e.text, CMAX); return; }
  if (e.kind === "meta") { if (e.text === "context compacted" || e.text.startsWith("summary: ")) tr.compacted = true; sd.mark = t; return; }
  if (e.kind === "tool") {
    const name = toolName(e); const n = tr.spans.length;
    const cid = e.id || "anon:" + tr.key + ":" + String(n);
    const sp = newSpan("execute_tool", "execute_tool " + mcpTool(name), toolSpanId(b.R, sd.s.id, cid), par.spanId, t, sd.s.id);
    sp.agent = par.agent; sp.tool = name; sp.callId = e.id; sp.open = true;
    sp.mcp = mcpServer(name);
    const arg = toolArg(e);
    if (catOf(name) === 0 && arg) { sp.prog = program(norm(arg)); sp.name = "execute_tool " + name + " " + sp.prog; }
    if (name === "Skill" || name === "activate_skill") { const m = /"(?:skill|name)":"([^"]+)"/.exec(e.full); sp.skill = m ? m[1] ?? "" : arg; }
    if (o.content) sp.args = cut(e.full || arg, CMAX);
    if (sd.lineTurn !== tr.key || sd.lineAt < 0) { sd.lineTurn = tr.key; sd.lineAt = tr.spans.length; }
    const sx = add(tr, sp);
    if (e.id) sd.pend.set(e.id, sx); else sd.anon.push(sx);
    return;
  }
  if (e.kind === "result") {
    let sp: XSpan | null = null;
    if (e.id) { const p = sd.pend.get(e.id); if (p) { sp = p; sd.pend.delete(e.id); } }
    if (!sp && sd.anon.length) sp = sd.anon.shift() ?? null;
    sd.mark = t;
    if (!sp) return;
    const c = e.id ? calls.get(e.id) : undefined;
    sp.open = false;
    sp.t1 = c && c.ms >= 0 ? sp.t0 + c.ms : Math.max(sp.t0, t);
    if (sp.t1 < sp.t0) sp.t1 = sp.t0;
    sp.err = errType(e.text, c ? c.err : isErr(e.text));
    if (c) {
      if (c.codes.length) sp.exit = c.codes[c.codes.length - 1] ?? -1;
      if (c.name && c.name !== sp.tool) { sp.tool = c.name; sp.mcp = mcpServer(c.name); sp.name = "execute_tool " + mcpTool(c.name); } // pi: the real MCP tool behind a proxy
    }
    if (o.content) { sp.result = cut(e.text, CMAX); if (sp.err) sp.errMsg = cut(e.text, 1024); }
  }
}
// a request line: its chat span(s) get the line's bookings (Claude fallback iterations: one span each)
function request(b: SessB, sd: Side, tr: XTurn, q: Req | null, bs: Booking[], rs: number, o: BuildOpts): void {
  const t = q ? q.t || sd.last : sd.last;
  const par = parentOf(b, sd, tr, t);
  if (!q) { // usage on a line that is no request (pi subagent results, …): the latest request of this session, else one for the turn
    let c = sd.lastChat;
    if (!c) c = chatFor(b, sd, tr, par, "turn:" + tr.key, t, t, o);
    if (!sd.lastChat) { c.est = true; sd.lastChat = c; }
    for (const x of bs) book(b, c, x);
    c.rs = c.rs + rs;
    return;
  }
  const hit = sd.chats.get(q.key);
  if (hit) { // a streamed message's later lines: extend
    hit.t1 = Math.max(hit.t1, t); for (const x of bs) book(b, hit, x); hit.rs = hit.rs + rs;
    if (o.content && sd.outBuf) { hit.output = cut(hit.output ? hit.output + "\n" + sd.outBuf : sd.outBuf, CMAX); sd.outBuf = ""; }
    sd.mark = Math.max(sd.mark, t);
    return;
  }
  if (!bs.length && !q.err) return; // no usage, no error: nothing to report (a counter that moved without tokens)
  const t0 = q.t0 > 0 ? q.t0 : sd.mark > 0 && sd.mark <= t ? sd.mark : t;
  const its = bs.length >= 2 && sd.s.h === "claude" ? bs.length : 1;
  for (let i = 0; i < its; i++) {
    const key = its > 1 ? q.key + "/i" + String(i + 1) : q.key;
    const a0 = its > 1 ? t0 + ((t - t0) * i) / its : t0; const a1 = its > 1 ? t0 + ((t - t0) * (i + 1)) / its : t;
    const c = chatFor(b, sd, tr, par, key, a0, a1, o);
    if (its > 1) { c.est = true; c.superseded = i < its - 1; book(b, c, bs[i]); c.model = bs[i].model === "<synthetic>" ? "" : bs[i].model; }
    else for (const x of bs) book(b, c, x);
    if (!c.model) c.model = q.model || (bs.length ? bs[0].model.replace(/^\?/, "") : "");
    c.respModel = q.respModel; c.err = q.err;
    c.provider = q.provider || providerOf("", c.model);
    if (q.providerId) c.respId = q.key;
    if (i === its - 1) { c.rs = c.rs + rs; if (o.content) c.output = sd.outBuf; }
    c.name = c.model ? "chat " + c.model : "chat";
    sd.chats.set(key, c); sd.lastChat = c;
  }
  const lc = sd.lastChat; if (its > 1 && lc) sd.chats.set(q.key, lc); // the message's later lines extend its answering attempt
  sd.outBuf = ""; sd.mark = t;
}
function chatFor(b: SessB, sd: Side, tr: XTurn, par: XSpan, key: string, t0: number, t1: number, o: BuildOpts): XSpan {
  const c = newSpan("chat", "chat", chatSpanId(b.R, sd.s.id, key), par.spanId, t0, sd.s.id);
  c.t1 = Math.max(t0, t1); c.agent = par.agent;
  c.bill = modeOf(b.root, "");
  if (sd.lineTurn === tr.key && sd.lineAt > 0) { const x = addAt(tr, c, sd.lineAt); sd.lineAt++; return x; }
  return add(tr, c);
}
function book(b: SessB, c: XSpan, x: Booking): void {
  c.nIn = c.nIn + x.nIn; c.nOut = c.nOut + x.nOut; c.cr = c.cr + x.cr; c.cw = c.cw + x.cw; c.cost = c.cost + x.cost; c.unk = c.unk + x.unk;
  if (x.exact) c.exact = true;
  c.hasUsage = true;
  if (x.prov) c.bill = modeOf(b.root, x.prov); // pi/OpenCode: the request's provider decides
}

// ── closing a turn ──
// closed now; finished (times, models, open calls) when advance() returns it, after the subagents were read too
function closeTurn(b: SessB, tr: XTurn, by: string, o: BuildOpts): void {
  if (tr.closed) return;
  tr.closed = true; tr.closedBy = by;
  if (by === "aborted") tr.spans[0].err = "cancelled";
  b.done.push(tr);
}
function finalize(b: SessB, tr: XTurn): void {
  const root = tr.spans[0];
  if (b.root.h === "kiro") kiroTimes(b, tr);
  if (b.root.h === "kiro" || b.root.h === "fx") turnChat(b, tr);
  // calls that never got a result end with the turn
  for (const s of tr.spans) if (s.open) { s.open = false; s.t1 = Math.max(s.t0, tr.t1); s.err = tr.closedBy === "aborted" ? "cancelled" : "unknown"; }
  for (const sd of [b.side].concat(b.subs)) {
    for (const [k, s] of [...sd.pend.entries()]) if (tr.spans.indexOf(s) >= 0) sd.pend.delete(k);
    sd.anon = sd.anon.filter((s: XSpan) => tr.spans.indexOf(s) < 0);
    sd.pieces.delete(tr.key);
  }
  spreadKids(tr);
  // model facts per invoke_agent: its own requests, in order of first use (subagent pieces keep theirs)
  for (const p of tr.spans) {
    if (p.op !== "invoke_agent") continue;
    for (const c of tr.spans) if (c.op === "chat" && c.parentId === p.spanId && c.model) { if (p.models.indexOf(c.model) < 0) p.models.push(c.model); p.model = c.model; }
  }
  skew(tr);
  root.t0 = Math.min(root.t0, tr.t0); root.t1 = Math.max(root.t1, tr.t1); tr.t0 = root.t0; tr.t1 = root.t1;
}
// Kiro lines carry no time: the sidecar's turn ends, start = the previous end (the first turn: 1 s before its end)
function kiroTimes(b: SessB, tr: XTurn): void {
  if (!b.kiro.length || tr.index > b.kiro.length) b.kiro = kiroTurns(b.root);
  const k = tr.index - 1; const kt = k >= 0 && k < b.kiro.length ? b.kiro[k] : null;
  if (!kt || kt.end <= 0) return;
  const prev = k > 0 && k - 1 < b.kiro.length ? b.kiro[k - 1].end : 0;
  const t0 = prev > 0 && prev < kt.end ? prev : kt.end - 1000;
  tr.t0 = t0; tr.t1 = kt.end;
  for (const s of tr.spans) { s.t0 = t0; s.t1 = t0; }
  tr.spans[0].t1 = kt.end;
}
// Kiro, fx: no per-request records — one chat span covers the turn (Kiro: the sidecar's totals for it; fx: no usage)
function turnChat(b: SessB, tr: XTurn): void {
  const root = tr.spans[0];
  const c = newSpan("chat", "chat", chatSpanId(b.R, b.root.id, "turn:" + tr.key), root.spanId, tr.t0, b.root.id);
  c.t1 = tr.t1; c.est = true; c.bill = modeOf(b.root, "");
  c.model = b.root.model; c.provider = providerOf("", c.model); c.name = c.model ? "chat " + c.model : "chat";
  if (b.root.h === "kiro") {
    const k = tr.index - 1; const kt = k >= 0 && k < b.kiro.length ? b.kiro[k] : null;
    if (kt) { c.nIn = kt.nIn; c.nOut = kt.nOut; c.cost = kt.usd; c.unk = kt.unk; c.hasUsage = true; }
  }
  tr.spans.splice(1, 0, c);
}
// children of a container with no timing of their own (fx: one timestamp per turn; Kiro: none) are laid out side by side
function spreadKids(tr: XTurn): void {
  for (const p of tr.spans) {
    if (p.op !== "invoke_agent" || p.t1 <= p.t0) continue;
    const kids: XSpan[] = []; let timed = false;
    for (const s of tr.spans) if (s.parentId === p.spanId && s.op !== "invoke_agent") { if (s.t1 > s.t0 && !(s.op === "chat" && s.est)) timed = true; if (s.op !== "chat" || !s.est) kids.push(s); }
    if (timed || !kids.length) continue;
    const slot = (p.t1 - p.t0) / kids.length;
    for (let i = 0; i < kids.length; i++) { kids[i].t0 = Math.floor(p.t0 + i * slot); kids[i].t1 = Math.floor(kids[i].t0 + slot * 0.9); kids[i].est = true; }
  }
}
// clock skew: a child outside its parent widens the parent (backends show no orphans); parents precede children in spans
function skew(tr: XTurn): void {
  const at = new Map<string, number>(); for (let i = 0; i < tr.spans.length; i++) at.set(tr.spans[i].spanId, i);
  for (let i = tr.spans.length - 1; i > 0; i--) {
    const c = tr.spans[i]; const pi = at.get(c.parentId) ?? -1; if (pi < 0) continue;
    const p = tr.spans[pi];
    if (c.t0 < p.t0) p.t0 = c.t0;
    if (c.t1 > p.t1) p.t1 = c.t1;
  }
}

// ── reading ──
// reads one side from its cursor to the end in 1 MB windows; a changed epoch or a shrunk source starts it over
function readSide(b: SessB, sd: Side, o: BuildOpts): void {
  const src = sourceOf(sd.s.h); const st = src.stat(sd.s); if (!st) return;
  const ep = epochOf(sd.s);
  if (st.size < sd.at || ep !== sd.ep) { const n = newSide(sd.s, sd.top); sd.at = 0; sd.ep = ep; sd.acc = n.acc; sd.rq = n.rq; sd.pend = n.pend; sd.anon = []; sd.chats = n.chats; sd.lastChat = null; sd.pieces = n.pieces; sd.last = 0; sd.mark = 0; }
  const win = window(src, WIN);
  while (sd.at < st.size) {
    const r = src.lines(sd.s, sd.at, Math.min(st.size, sd.at + win));
    if (r.next <= sd.at) { // one record longer than the window (> 1 MB): skipped like the ledger does; its call stays open
      const nx = src.align(sd.s, sd.at + win); if (nx <= sd.at || nx >= st.size) { if (nx > sd.at) sd.at = nx; break; }
      sd.at = nx; continue;
    }
    for (const l of r.lines) line(b, sd, l, o);
    sd.at = r.next;
  }
}
function quietFor(s: Sess, now: number): number { return now - s.mtime; }
function busyNow(b: SessB): boolean { const s = b.root; const keep = s.evs; s.evs = b.tail; const v = busy(s); s.evs = keep; return v; }
// reads what is new and returns the turns that closed: on the next prompt / a close marker, or by the completeness rule
// (spec 2.3): not busy, no subagent active, quiet for o.quietMs — or the process is gone (2 min quiet, then a busy turn is "interrupted")
export function advance(b: SessB, o: BuildOpts): XTurn[] {
  readSide(b, b.side, o);
  if (o.subagents) for (const sd of b.subs) readSide(b, sd, o);
  const op = b.open;
  if (op) {
    let subActive = false; for (const sd of b.subs) if (o.now - sd.s.mtime < 45000) subActive = true;
    const bz = busyNow(b); const q = quietFor(b.root, o.now);
    const gone = b.root.pid === 0 && q >= 120000;
    if ((!bz && !subActive && q >= o.quietMs) || (gone && !subActive)) {
      closeQuiet(b.cur);
      if (bz) op.spans[0].err = "interrupted";
      closeTurn(b, op, "quiet", o);
      b.open = null;
    }
  }
  const out = b.done; b.done = [];
  for (const tr of out) finalize(b, tr);
  if (b.root.h === "fx" && out.length) { // fx keeps session totals only: they ride on the newest turn's chat span (usage never sits on invoke_agent)
    const t = fxTotals(b.root); const lt = out[out.length - 1]; const r = lt.spans.find((x: XSpan) => x.op === "chat" && x.parentId === lt.spans[0].spanId);
    if (t && r) { r.nIn = t.nIn; r.nOut = t.nOut; r.cr = t.cr; r.cw = t.cw; r.cost = t.usd; r.unk = t.unk; r.hasUsage = true; r.total = true; }
  }
  return out;
}
// subagents that appeared since the builder was made (live mode) join it
export function syncSubs(b: SessB, subs: Sess[]): void {
  for (const c of subs) { let has = false; for (const sd of b.subs) if (sd.s.path === c.path) has = true; if (!has) b.subs.push(newSide(c, false)); }
}
// the open turn's newest call still waiting for its result (approval waits attach to it), null = none
export function openCall(b: SessB): XSpan | null {
  const t = b.open; if (!t) return null;
  for (let i = t.spans.length - 1; i > 0; i--) { const s = t.spans[i]; if (s.op === "execute_tool" && s.open && s.agent === "") return s; }
  return null;
}
// one-shot export: the same pass, with the one-shot quiet time in o
export function finish(b: SessB, o: BuildOpts): XTurn[] { return advance(b, o); }
