// agentglass — deep links: the strict <ref> grammar (pure) and its resolution to a session, an event and a read cursor.
// A ref selects among already-scanned sessions only: no component is ever treated as a path.
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../../model/types.ts";
import { findSession, distinct } from "../../model/sessref.ts";
// the agent's own sessions (as `agentglass session` takes them): resolved where the command runs, never by a running TUI
export const SELF = ["current", "last", "parent"];
import { sessions, parentOf } from "../../model/sessions.ts";
import { H as idH, rootKey, traceId, rootSpanId, chatSpanId, toolSpanId, agentSpanId } from "../otlp/ids.ts";
import { type ReqState, newReqState, requestOf } from "../otlp/requests.ts";
import { newCursor, feed } from "../callgraph/turns.ts";
import { isHarness, sourceOf, parseEvents, window } from "../../harness/index.ts";
import { sessUrl, urlPart } from "../../util/hyper.ts";

// akey "" | call | ts | turn | span; aval its value (decoded; turn: the start ts or the index digits, ak = ~k); trace/span =
// an OTLP trace id ref (otlp-export ids); warn = an ignored part (unknown anchor)
export interface Ref { ok: boolean; err: string; warn: string; harness: string; sess: string; trace: string; span: string; akey: string; aval: string; ak: number }
export const MAX_REF = 512;
const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const TRACE_RE = /^([0-9a-f]{32})(?:\/([0-9a-f]{16}))?$/; const SPAN_RE = /^[0-9a-f]{16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
function bad(err: string): Ref { return { ok: false, err, warn: "", harness: "", sess: "", trace: "", span: "", akey: "", aval: "", ak: 0 }; }
// one percent-decoding pass; "" + ok false on a malformed escape
function pct(s: string): { v: string; ok: boolean } { try { return { v: decodeURIComponent(s), ok: true }; } catch (e) { return { v: "", ok: false }; } }
function idErr(id: string, what: string): string {
  if (id.length > 200) return what + " is longer than 200 characters";
  if (!ID_RE.test(id)) return what + " may only hold letters, digits and . _ : -";
  if (id.indexOf("..") >= 0) return what + " may not contain ..";
  return "";
}
export function parseRef(raw: string): Ref {
  if (raw.length > MAX_REF) return bad("the link is longer than " + String(MAX_REF) + " characters");
  if (!raw) return bad("empty link");
  if (/[\u0000- \u007f]/.test(raw)) return bad("the link holds whitespace or control characters");
  const tm = TRACE_RE.exec(raw); // an OTLP trace id (otlp-export), optionally /<span id>
  if (tm) return { ok: true, err: "", warn: "", harness: "", sess: "", trace: tm[1] ?? "", span: tm[2] ?? "", akey: "", aval: "", ak: 0 };
  let path = raw; let anc = "";
  const hi = raw.indexOf("#");
  if (hi >= 0) { path = raw.slice(0, hi); anc = raw.slice(hi + 1); }
  let h = ""; let id = "";
  if (path.slice(0, 13).toLowerCase() === "agentglass://") { // scheme and host are case-insensitive
    if (path.slice(0, 18).toLowerCase() !== "agentglass://open/") return bad("only agentglass://open/ links are accepted");
    let rest = path.slice(18); if (rest.endsWith("/")) rest = rest.slice(0, -1); // one trailing slash (some apps add it)
    const parts = rest.split("/");
    if (parts.length > 2 || parts.some((p: string) => !p)) return bad("expected agentglass://open/[harness/]session-id");
    const dec: string[] = [];
    for (const p of parts) { const d = pct(p); if (!d.ok) return bad("malformed %-escape in the link"); dec.push(d.v); }
    if (dec.length === 2) { h = dec[0] ?? ""; id = dec[1] ?? ""; } else id = dec[0] ?? "";
    if (h && !isHarness(h)) return bad("unknown harness " + h);
    const da = pct(anc); if (!da.ok) return bad("malformed %-escape in the anchor");
    anc = da.v;
  } else {
    if (path.indexOf("/") >= 0 || path.startsWith("~")) return bad("not a session reference (paths are not accepted)");
    const ci = path.indexOf(":");
    if (ci > 0 && /^[a-z0-9-]+$/.test(path.slice(0, ci))) {
      h = path.slice(0, ci); id = path.slice(ci + 1);
      if (!isHarness(h)) return bad("unknown harness " + h);
    } else id = path;
  }
  const ie = idErr(id, "the session id"); if (ie) return bad(ie);
  const self = !h && SELF.indexOf(id) >= 0 && !path.toLowerCase().startsWith("agentglass:"); // resolved by the caller (open.ts)
  if (id.length < 6 && !self) return bad("the session reference " + id + " is too short (at least 6 characters)");
  const r: Ref = { ok: true, err: "", warn: "", harness: h, sess: id, trace: "", span: "", akey: "", aval: "", ak: 0 };
  if (hi < 0) return r;
  const eq = anc.indexOf("=");
  const k = eq > 0 ? anc.slice(0, eq) : anc; const v = eq > 0 ? anc.slice(eq + 1) : "";
  if (k === "call") { const e = idErr(v, "the call id"); if (e) return bad(e); r.akey = "call"; r.aval = v; }
  else if (k === "ts") { if (!ISO_RE.test(v)) return bad("ts= needs an ISO-8601 time, e.g. 2026-09-30T10:00:00Z"); r.akey = "ts"; r.aval = v; }
  else if (k === "turn") { // <start ts as logged>[~k] (stable) or <n> (the 1-based index, an alias)
    const m = /^(.+?)(?:~(\d{1,4}))?$/.exec(v);
    if (/^\d{1,6}$/.test(v) && Number(v) > 0) { r.akey = "turn"; r.aval = v; }
    else if (m && ISO_RE.test(m[1] ?? "")) { r.akey = "turn"; r.aval = m[1] ?? ""; r.ak = Number(m[2] ?? "0"); }
    else return bad("turn= needs the turn's start time (2026-09-30T10:00:00.000Z, ~1 for the 2nd turn sharing it) or its number");
  }
  else if (k === "span") { if (!SPAN_RE.test(v)) return bad("span= needs a 16-digit lowercase hex span id"); r.akey = "span"; r.aval = v; }
  else r.warn = "unknown anchor " + (k.length > 40 ? k.slice(0, 40) + "…" : k) + " ignored";
  return r;
}

// code 0 found, 3 not found, 4 ambiguous (cands newest first); cursor = where to start reading so the event is in
// the read (0 = from the start); kind/ts/id/text = the event for the transcript's focus matcher ("" = no anchor);
// turn = the event's 1-based turn (-1 = not known); ukey/uval = the anchor of the canonical link (turn/span refs resolve to one)
export interface Target { s: Sess | null; code: number; cands: Sess[]; msg: string; cursor: number; kind: string; ts: string; id: string; text: string; turn: number; warn: string; ukey: string; uval: string }
function miss(code: number, msg: string, cands: Sess[]): Target { return { s: null, code, cands, msg, cursor: 0, kind: "", ts: "", id: "", text: "", turn: -1, warn: "", ukey: "", uval: "" }; }
function found(s: Sess, warn: string): Target { return { s, code: 0, cands: [], msg: "", cursor: 0, kind: "", ts: "", id: "", text: "", turn: -1, warn, ukey: "", uval: "" }; }
function msOf(ts: string): number { const v = ts ? new Date(ts).getTime() : NaN; return isFinite(v) ? v : NaN; }
function focus(t: Target, s: Sess, off: number, e: Ev): void { t.s = s; t.cursor = off; t.kind = e.kind; t.ts = e.ts; t.id = e.id; t.text = e.id ? e.id : e.text; }
// every record of a session in log order, read from the start in 64 KB windows (a longer record grows the window);
// each(line, its events, the window's start) → true stops
function walk(s: Sess, pre: string, each: (l: string, evs: Ev[], off: number) => boolean): void {
  const src = sourceOf(s.h); const span = window(src, 65536);
  let off = 0; const end = s.size;
  while (off < end) {
    let r = src.lines(s, off, Math.min(end, off + span));
    for (let w = span * 4; r.next <= off && off + w / 4 < end && w <= window(src, 67108864); w *= 4) r = src.lines(s, off, Math.min(end, off + w)); // a record longer than the window
    if (r.next <= off) break;
    for (const l of r.lines) {
      if (pre && l.indexOf(pre) < 0) continue; // cheap prefilter: the value is in the raw record
      const evs: Ev[] = []; parseEvents(s.h, l, evs, s);
      if (each(l, evs, off)) return;
    }
    off = r.next;
  }
}
// call= / ts=: the anchored event
function findEvent(s: Sess, akey: string, aval: string, t: Target): boolean {
  const want = akey === "ts" ? msOf(aval) : NaN; const st = { hit: false };
  walk(s, akey === "call" ? aval : "", (l: string, evs: Ev[], off: number): boolean => {
    for (const e of evs) if (akey === "call" ? e.kind === "tool" && e.id === aval : e.ts !== "" && msOf(e.ts) >= want) { focus(t, s, off, e); st.hit = true; return true; }
    return false;
  });
  return st.hit;
}
// the root session's turns as the OTLP export cuts them (shared TurnCursor over its own events): key T = the opening
// event's timestamp as logged + "#k" (k = ordinal among turns sharing it), "i<n>" without one; each(key, n, event,
// window start) → true stops. (A live export that closed a turn by quiet time and saw it continue keys that part apart.)
interface TurnAt { key: string; n: number; e: Ev; off: number }
function turns(root: Sess, each: (x: TurnAt) => boolean): void {
  const c = newCursor(); const seen = new Map<string, number>();
  walk(root, "", (l: string, evs: Ev[], off: number): boolean => {
    for (const e of evs) {
      if (feed(c, e, true) !== "open") continue;
      let key = "i" + String(c.n);
      if (e.ts) { const k = seen.get(e.ts) ?? 0; seen.set(e.ts, k + 1); key = e.ts + "#" + String(k); }
      if (each({ key, n: c.n, e, off })) return true;
    }
    return false;
  });
}
function rootOf(s: Sess): Sess { return s.parent ? parentOf(s) ?? s : s; }
// "<ts>#<k>" → the canonical anchor value "<ts>[~k]"; "i<n>" → "<n>"
function turnVal(key: string): string { const i = key.lastIndexOf("#"); if (i < 0) return key.slice(1); const k = key.slice(i + 1); return key.slice(0, i) + (k === "0" ? "" : "~" + k); }
function atTurn(t: Target, root: Sess, x: TurnAt): void { focus(t, root, x.off, x.e); t.turn = x.n; t.ukey = "turn"; t.uval = turnVal(x.key); }
// turn=<ts>[~k] | turn=<n> on the root session; a key that no longer exists → the first turn starting at or after <ts>
function findTurn(root: Sess, aval: string, ak: number, t: Target): boolean {
  const idx = /^\d+$/.test(aval) ? Number(aval) : 0; const want = aval + "#" + String(ak); const at = msOf(aval);
  const got = { hit: null as TurnAt | null, next: null as TurnAt | null }; // a box: closures assign it
  turns(root, (x: TurnAt): boolean => {
    if (idx ? x.n === idx : x.key === want) { got.hit = x; return true; }
    if (!idx && !got.next && x.e.ts && msOf(x.e.ts) >= at) got.next = x;
    return false;
  });
  const h = got.hit; const nx = got.next;
  if (h) { atTurn(t, root, h); return true; }
  if (nx) { atTurn(t, root, nx); t.warn = "turn " + aval + (ak ? "~" + String(ak) : "") + " no longer exists — showing the next one"; return true; }
  return false;
}
// the request key Q of each line (otlp requests.ts), with the per-iteration keys a multi-booking claude message gets
function chatKeys(h: string, l: string, rq: ReqState): string[] {
  const q = requestOf(h, null, l, rq); if (!q) return [];
  const o = [q.key]; for (let i = 1; i <= 8; i++) o.push(q.key + "/i" + String(i));
  return o;
}
// span=<16 hex> in the trees of root's turns: the turn's invoke_agent (its first event), a tool call, a request's chat
// span (that line's answer), a subagent's invoke_agent (that subagent from the hosting turn's start)
function findSpan(root: Sess, span: string, t: Target): boolean {
  const R = rootKey(root.h, root.id); const ts: TurnAt[] = [];
  const st = { hit: false };
  turns(root, (x: TurnAt): boolean => {
    ts.push(x);
    if (rootSpanId(R, x.key) === span || chatSpanId(R, root.id, "turn:" + x.key) === span) { atTurn(t, root, x); st.hit = true; return true; }
    return false;
  });
  if (st.hit) return true;
  const all: Sess[] = [root]; for (const c of root.subs) all.push(c);
  for (const s of all) {
    const rq = newReqState();
    walk(s, "", (l: string, evs: Ev[], off: number): boolean => {
      for (const e of evs) if (e.kind === "tool" && e.id && toolSpanId(R, s.id, e.id) === span) { focus(t, s, off, e); t.ukey = "call"; t.uval = e.id; st.hit = true; return true; }
      for (const k of chatKeys(s.h, l, rq)) if (chatSpanId(R, s.id, k) === span) {
        let e: Ev | null = null; for (const x of evs) if (!e || (x.kind === "assistant" && e.kind !== "assistant")) e = x;
        if (e) { focus(t, s, off, e); if (e.ts) { t.ukey = "ts"; t.uval = e.ts; } } else t.s = s;
        st.hit = true; return true;
      }
      return false;
    });
    if (st.hit) return true;
    if (s !== root) for (const x of ts) if (agentSpanId(R, s.id, x.key) === span) {
      t.s = s; t.warn = "";
      if (x.e.ts) { findEvent(s, "ts", x.e.ts, t); t.ukey = "ts"; t.uval = x.e.ts; }
      return true;
    }
  }
  return false;
}
// trace id → its session: the first half is H("s|" + R) of a top-level session; the index (half → path) is built on
// demand, again when the session count changed or a hit no longer names that session
const traceIdx = { n: -1, m: new Map<string, string>() };
function sessOfTrace(trace: string): Sess | null {
  const half = trace.slice(0, 16);
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1 || traceIdx.n !== sessions.size) {
      traceIdx.m.clear(); traceIdx.n = sessions.size;
      for (const s of sessions.values()) if (!s.parent) traceIdx.m.set(idH("s|" + rootKey(s.h, s.id)).slice(0, 16), s.path);
    }
    const s = sessions.get(traceIdx.m.get(half) ?? "");
    if (s && !s.parent && idH("s|" + rootKey(s.h, s.id)).slice(0, 16) === half) return s;
  }
  return null;
}
function resolveTrace(r: Ref): Target {
  const root = sessOfTrace(r.trace);
  if (!root) return miss(3, "no session exported as trace " + r.trace + " (agentglass sessions lists them)", []);
  const t = found(root, ""); const R = rootKey(root.h, root.id);
  const got = { turn: null as TurnAt | null };
  turns(root, (x: TurnAt): boolean => { if (traceId(R, x.key) === r.trace) { got.turn = x; return true; } return false; });
  const tu = got.turn;
  if (tu) atTurn(t, root, tu); else t.warn = "trace " + r.trace + " is this session, but none of its turns now — showing its end";
  if (r.span && !findSpan(root, r.span, t)) t.warn = "no span " + r.span + " in this session" + (tu ? " — showing its turn" : " — showing its end");
  return t;
}
// the sessions must be scanned (and the view built) by the caller
export function resolve(r: Ref): Target {
  if (!r.ok) return miss(2, r.err, []);
  if (r.trace) return resolveTrace(r);
  let f = findSession(r.harness ? r.harness + ":" + r.sess : r.sess, (x: Sess): boolean => true);
  if (r.harness && f.code === 3) { // <harness>:<prefix> (findSession takes exact ids there): the id prefix within that harness
    const ms: Sess[] = []; for (const s of sessions.values()) if (s.h === r.harness && s.id.startsWith(r.sess)) ms.push(s);
    const ds = distinct(ms); // twins of one session are one: the copy that stands for it (sessref.ts owns)
    if (ds.length === 1) f = { s: ds[0], code: 0, cands: [], err: "", msg: "", hint: "" };
    else if (ds.length > 1) return miss(4, "session reference " + r.harness + ":" + r.sess + " is ambiguous (" + String(ds.length) + " sessions)", ds);
  }
  if (f.code === 4) return miss(4, f.msg, f.cands);
  const s = f.s;
  if (!s) return miss(3, f.msg || "no session " + r.sess, []);
  const t = found(s, r.warn); t.ukey = r.akey; t.uval = r.akey === "turn" && r.ak ? r.aval + "~" + String(r.ak) : r.aval;
  if (r.akey === "turn") { if (!findTurn(rootOf(s), r.aval, r.ak, t)) t.warn = "no turn " + t.uval + " in this session — showing its end"; }
  else if (r.akey === "span") { if (!findSpan(rootOf(s), r.aval, t)) t.warn = "no span " + r.aval + " in this session — showing its end"; }
  else if (r.akey && !findEvent(s, r.akey, r.aval, t)) t.warn = (r.akey === "call" ? "no call " + r.aval : "no event at or after " + r.aval) + " in this session — showing its end";
  return t;
}
// agentglass://open/<h>/<id>[#<akey>=<aval>]: components percent-encoded outside [A-Za-z0-9._:-]
export function canonicalUrl(s: Sess, akey: string, aval: string): string { return sessUrl(s.h, s.id) + (akey ? "#" + akey + "=" + urlPart(aval) : ""); }
