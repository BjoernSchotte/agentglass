// agentglass serve --stdio — the agentglass-serve/1 dispatcher (local-web-api §3, docs/cli-contract.md): one JSON object
// per line in, responses {id, ok} / {id, err} and sub events out. Pure over the engine's state: main.ts owns stdin,
// stdout, the clock and the cadence. Requests: hello (first), meta, sessions.list, sessions.get, sub, unsub.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str } from "../util/json.ts";
import { type SessQ, PROTO, CAPS, readMeta, readSessions, readSession } from "../read/index.ts";
import { CONTRACT } from "../features/version.ts";
import { BUILD } from "../build-info.ts";
import { REDACT } from "../features/redact-on.ts";
import { type Hub, LIMIT_DEF, LIMIT_MAX, SUBS_MAX, newHub, openTopic, attach, detach } from "./subs.ts";

// hello: a hello was answered; fresh: called before a request that reads the engine (main.ts: discover() when stale)
export interface Srv { readOnly: boolean; hello: boolean; hub: Hub; now: () => number; out: (line: string) => void; fresh: () => void }
export function newSrv(readOnly: boolean, epoch: string, now: () => number, out: (line: string) => void, fresh: () => void): Srv {
  return { readOnly, hello: false, hub: newHub(epoch, out), now, out, fresh };
}
function okL(id: string, r: Obj): string { return "{\"id\":" + id + ",\"ok\":" + JSON.stringify(r) + "}"; }
function errL(id: string, code: string, msg: string, hint: string): string {
  const e: Obj = { code, msg }; if (hint) e["hint"] = hint;
  return "{\"id\":" + (id || "null") + ",\"err\":" + JSON.stringify(e) + "}";
}
function num(v: unknown, def: number): number { return typeof v === "number" && Number.isFinite(v) ? v : def; }
// a list query from p; limit: 1–1,000, default 200; "" = fine, else the bad_param message
function sessQ(p: Obj): { q: SessQ; bad: string } {
  const lim = num(p["limit"], LIMIT_DEF);
  const q: SessQ = { filter: str(p["filter"]), limit: Math.floor(lim), cursor: str(p["cursor"]), subagents: p["subagents"] === true, team: str(p["team"]), room: str(p["room"]) };
  if (!(lim >= 1 && lim <= LIMIT_MAX)) return { q, bad: "limit must be 1–" + String(LIMIT_MAX) };
  for (const k of ["filter", "cursor", "team", "room"]) if (p[k] !== undefined && typeof p[k] !== "string") return { q, bad: k + " must be a string" };
  return { q, bad: "" };
}

// one input line (oversize: the framer dropped it); the answer and any events go out through sv.out
export function onLine(sv: Srv, line: string, oversize: boolean): void {
  if (oversize) { sv.out(errL("", "oversize", "line over 4 MiB dropped", "one JSON object per line, at most 4 MiB")); return; }
  let v: unknown = null;
  try { v = JSON.parse(line); } catch (e) { sv.out(errL("", "bad_request", "not JSON", "one JSON object per line")); return; }
  const o = obj(v);
  if (!o) { sv.out(errL("", "bad_request", "not a JSON object", "{\"id\":1,\"m\":\"hello\",\"p\":{\"want\":1}}")); return; }
  const idv = o["id"];
  if (!(typeof idv === "string" || (typeof idv === "number" && Number.isFinite(idv)))) { sv.out(errL("", "bad_request", "id must be a string or a number", "")); return; }
  const id = JSON.stringify(idv);
  const m = o["m"];
  if (typeof m !== "string") { sv.out(errL(id, "bad_request", "m (the method) must be a string", "")); return; }
  const pv = o["p"]; const p: Obj = pv === undefined || pv === null ? {} : obj(pv) ?? {};
  if (pv !== undefined && pv !== null && !obj(pv)) { sv.out(errL(id, "bad_request", "p must be an object", "")); return; }
  const l = dispatch(sv, id, m, p); if (l) sv.out(l);
}
// the answer line ("" = already written: a sub writes its answer, then its snapshot or replay)
function dispatch(sv: Srv, id: string, m: string, p: Obj): string {
  if (m === "hello") {
    const want = num(p["want"], PROTO);
    if (want > PROTO) return errL(id, "proto", "this agentglass speaks agentglass-serve/" + String(PROTO) + ", the client wants " + String(want), "update agentglass (agentglass update)");
    sv.hello = true;
    return okL(id, { proto: PROTO, contract: CONTRACT, version: BUILD.version, readOnly: sv.readOnly, redact: REDACT, caps: CAPS });
  }
  if (!sv.hello) return errL(id, "proto", "hello first", "{\"id\":1,\"m\":\"hello\",\"p\":{\"want\":" + String(PROTO) + "}}");
  if (m === "meta") return okL(id, readMeta(sv.readOnly));
  if (m === "sessions.list") {
    const r = sessQ(p); if (r.bad) return errL(id, "bad_param", r.bad, "");
    sv.fresh();
    const res = readSessions(r.q);
    const e = res.err; const pg = res.page;
    if (e || !pg) return errL(id, e ? e.code : "internal", e ? e.msg : "no page", e ? e.hint : "");
    return okL(id, { data: pg.data, at: pg.at, gen: pg.gen, next: pg.next });
  }
  if (m === "sessions.get") {
    const ref = str(p["ref"]); if (!ref) return errL(id, "bad_param", "ref is required", "<harness>:<id>, an id or a unique prefix of 6+ characters");
    sv.fresh();
    const r = readSession(ref); const d = r.data;
    if (!d) return errL(id, r.err ? r.err.code : "not_found", r.err ? r.err.msg : "no session " + ref, r.err ? r.err.hint : "");
    return okL(id, d);
  }
  if (m === "sub") {
    const topic = str(p["topic"]);
    if (topic !== "sessions") return errL(id, "bad_param", "unknown topic " + JSON.stringify(topic), "topics: sessions");
    const r = sessQ(p); if (r.bad) return errL(id, "bad_param", r.bad, "");
    if (r.q.cursor) return errL(id, "bad_param", "a subscription has no cursor", "");
    if (sv.hub.subs.size >= SUBS_MAX) return errL(id, "too_many", String(SUBS_MAX) + " subscriptions are open", "unsub one first");
    sv.fresh();
    const now = sv.now();
    const ot = openTopic(sv.hub, r.q, now); const t = ot.t;
    if (!t) return errL(id, ot.err.startsWith("bad_filter") ? "bad_filter" : ot.err.startsWith("no_team") ? "no_team" : "internal", ot.err, "");
    const a = attach(sv.hub, t, str(p["from"]), now);
    sv.out(okL(id, { sub: a.id, resumed: a.resumed }));
    for (const l of a.lines) sv.out(l);
    return "";
  }
  if (m === "unsub") return detach(sv.hub, str(p["sub"])) ? okL(id, {}) : errL(id, "not_found", "no subscription " + str(p["sub"]), "");
  if (m === "cmd" || m === "confirm") return sv.readOnly ? errL(id, "read_only", "started read-only: commands are off", "agentglass web --allow-commands") : errL(id, "unknown_method", "commands arrive in a later release", "");
  return errL(id, "unknown_method", "unknown method " + JSON.stringify(m), "methods: hello, meta, sessions.list, sessions.get, sub, unsub");
}
