// agentglass — deep links: the strict <ref> grammar (pure) and its resolution to a session, an event and a read cursor.
// A ref selects among already-scanned sessions only: no component is ever treated as a path.
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../../model/types.ts";
import { findSession } from "../../model/sessref.ts";
import { sessions } from "../../model/sessions.ts";
import { isHarness, sourceOf, parseEvents, window } from "../../harness/index.ts";
import { sessUrl, urlPart } from "../../util/hyper.ts";

// akey "" | call | ts; aval its value (decoded); warn = an ignored part (unknown anchor)
export interface Ref { ok: boolean; err: string; warn: string; harness: string; sess: string; trace: string; span: string; akey: string; aval: string; ak: number }
export const MAX_REF = 512;
const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
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
  if (id.length < 6) return bad("the session reference " + id + " is too short (at least 6 characters)");
  const r: Ref = { ok: true, err: "", warn: "", harness: h, sess: id, trace: "", span: "", akey: "", aval: "", ak: 0 };
  if (hi < 0) return r;
  const eq = anc.indexOf("=");
  const k = eq > 0 ? anc.slice(0, eq) : anc; const v = eq > 0 ? anc.slice(eq + 1) : "";
  if (k === "call") { const e = idErr(v, "the call id"); if (e) return bad(e); r.akey = "call"; r.aval = v; }
  else if (k === "ts") { if (!ISO_RE.test(v)) return bad("ts= needs an ISO-8601 time, e.g. 2026-09-30T10:00:00Z"); r.akey = "ts"; r.aval = v; }
  else r.warn = "unknown anchor " + (k.length > 40 ? k.slice(0, 40) + "…" : k) + " ignored";
  return r;
}

// code 0 found, 3 not found, 4 ambiguous (cands newest first); cursor = where to start reading so the event is in
// the read (0 = from the start); kind/ts/id/text = the event for the transcript's focus matcher ("" = no anchor)
export interface Target { s: Sess | null; code: number; cands: Sess[]; msg: string; cursor: number; kind: string; ts: string; id: string; text: string; turn: number; warn: string }
function miss(code: number, msg: string, cands: Sess[]): Target { return { s: null, code, cands, msg, cursor: 0, kind: "", ts: "", id: "", text: "", turn: -1, warn: "" }; }
function msOf(ts: string): number { const v = ts ? new Date(ts).getTime() : NaN; return isFinite(v) ? v : NaN; }
// the anchored event: the session is read from the start in 64 KB windows; cursor = the start of the window that held it
function findEvent(s: Sess, akey: string, aval: string, t: Target): boolean {
  const src = sourceOf(s.h); const span = window(src, 65536);
  const want = akey === "ts" ? msOf(aval) : NaN;
  let off = 0; const end = s.size;
  while (off < end) {
    let r = src.lines(s, off, Math.min(end, off + span));
    for (let w = span * 4; r.next <= off && off + w / 4 < end && w <= window(src, 67108864); w *= 4) r = src.lines(s, off, Math.min(end, off + w)); // a record longer than the window
    if (r.next <= off) break;
    const evs: Ev[] = [];
    for (const l of r.lines) {
      if (akey === "call" && l.indexOf(aval) < 0) continue; // cheap prefilter: the id is in the raw record
      parseEvents(s.h, l, evs, s);
    }
    for (const e of evs) {
      const hit = akey === "call" ? e.kind === "tool" && e.id === aval : e.ts !== "" && msOf(e.ts) >= want;
      if (hit) { t.cursor = off; t.kind = e.kind; t.ts = e.ts; t.id = e.id; t.text = e.id ? e.id : e.text; return true; }
    }
    off = r.next;
  }
  return false;
}
// the sessions must be scanned (and the view built) by the caller
export function resolve(r: Ref): Target {
  if (!r.ok) return miss(2, r.err, []);
  let f = findSession(r.harness ? r.harness + ":" + r.sess : r.sess, (x: Sess): boolean => true);
  if (r.harness && f.code === 3) { // <harness>:<prefix> (findSession takes exact ids there): the id prefix within that harness
    const ms: Sess[] = []; for (const s of sessions.values()) if (s.h === r.harness && s.id.startsWith(r.sess)) ms.push(s);
    if (ms.length === 1) f = { s: ms[0], code: 0, cands: [], err: "", msg: "", hint: "" };
    else if (ms.length > 1) return miss(4, "session reference " + r.harness + ":" + r.sess + " is ambiguous (" + String(ms.length) + " sessions)", ms.sort((a, b) => b.mtime - a.mtime));
  }
  if (f.code === 4) return miss(4, f.msg, f.cands);
  const s = f.s;
  if (!s) return miss(3, f.msg || "no session " + r.sess, []);
  const t: Target = { s, code: 0, cands: [], msg: "", cursor: 0, kind: "", ts: "", id: "", text: "", turn: -1, warn: r.warn };
  if (r.akey && !findEvent(s, r.akey, r.aval, t)) t.warn = (r.akey === "call" ? "no call " + r.aval : "no event at or after " + r.aval) + " in this session — showing its end";
  return t;
}
// agentglass://open/<h>/<id>[#<akey>=<aval>]: components percent-encoded outside [A-Za-z0-9._:-]
export function canonicalUrl(s: Sess, akey: string, aval: string): string { return sessUrl(s.h, s.id) + (akey ? "#" + akey + "=" + urlPart(aval) : ""); }
