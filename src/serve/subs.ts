// agentglass serve --stdio — subscriptions (local-web-api §3): one topic per kind + parameters, shared by every sub on
// it; a ring of its last events (1,000 or 10 minutes) for resume; patches computed from the read model when its
// generation moved (the engine's cadence calls step), heartbeats from one shared beat. No timer per subscriber.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, str } from "../util/json.ts";
import { type SessQ, readSessions, gen } from "../read/index.ts";

export const RING_MAX = 1000;
export const RING_MS = 600000;
export const HB_MS = 25000;
export const LIMIT_DEF = 200;
export const LIMIT_MAX = 1000;

// one pushed event: seq = the process-wide sequence (ids "<epoch>-<seq>" never repeat in a run, across topics)
export interface REv { seq: number; at: number; k: string; d: string /* the payload's JSON */ }
// rows: key → the row's JSON as last sent; order: the keys newest first; min: the oldest id a resume may name (the topic's
// creation id, then the newest event dropped from the ring: everything after it is still there); g: the read model's
// generation the rows were built at
export interface Topic { key: string; q: SessQ; ring: REv[]; min: number; rows: Map<string, string>; order: string[]; g: number; at: number; n: number }
// last: when this sub was last sent anything (heartbeats go to the quiet ones)
export interface Sub { id: string; topic: string; last: number }
export interface Hub { epoch: string; seq: number; topics: Map<string, Topic>; subs: Map<string, Sub>; next: number; out: (line: string) => void }
export function newHub(epoch: string, out: (line: string) => void): Hub { return { epoch, seq: 0, topics: new Map<string, Topic>(), subs: new Map<string, Sub>(), next: 0, out }; }

export function evId(h: Hub, seq: number): string { return h.epoch + "-" + String(seq); }
function line(sub: string, id: string, k: string, d: string): string { return "{\"sub\":" + JSON.stringify(sub) + ",\"ev\":" + JSON.stringify(id) + ",\"k\":\"" + k + "\"" + (d ? ",\"d\":" + d : "") + "}"; }

// a row's key: "<harness>:<id>"; copies of one session (twins) in one list each get "@<path>" (the shown path: faked,
// stably, under --redact) so every key is unique and does not depend on the order
function keyed(rows: Obj[]): string[] {
  const n = new Map<string, number>(); const base: string[] = [];
  for (const r of rows) { const k = str(r["harness"]) + ":" + str(r["id"]); base.push(k); n.set(k, (n.get(k) ?? 0) + 1); }
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) { const k = base[i] ?? ""; const r = rows[i] as Obj; out.push((n.get(k) ?? 0) > 1 ? k + "@" + str(r["path"]) : k); }
  return out;
}
export function topicKey(q: SessQ): string { return "sessions\t" + q.filter + "\t" + (q.subagents ? "1" : "0") + "\t" + String(q.limit); }
// a topic's rows now (the read model's first page of its query); err: the query's error (a bad filter)
interface Built { keys: string[]; rows: Obj[]; err: string }
function build(q: SessQ): Built {
  const r = readSessions(q); const p = r.page;
  if (!p) return { keys: [], rows: [], err: r.err ? r.err.code + ": " + r.err.msg : "internal" };
  const ks = keyed(p.data);
  for (let i = 0; i < p.data.length; i++) (p.data[i] as Obj)["key"] = ks[i] ?? "";
  return { keys: ks, rows: p.data, err: "" };
}
export function openTopic(h: Hub, q: SessQ, now: number): { t: Topic | null; err: string } {
  const key = topicKey(q);
  const had = h.topics.get(key); if (had) return { t: had, err: "" };
  const b = build(q); if (b.err) return { t: null, err: b.err };
  h.seq++; // the topic's creation id: its first snapshot names it, an id from before it (another incarnation) never resumes
  const t: Topic = { key, q, ring: [], min: h.seq, rows: new Map<string, string>(), order: b.keys, g: gen("sessions"), at: now, n: 0 };
  for (let i = 0; i < b.rows.length; i++) t.rows.set(b.keys[i] ?? "", JSON.stringify(b.rows[i] as Obj));
  h.topics.set(key, t);
  return { t, err: "" };
}
function snapshotD(t: Topic, now: number): string {
  const rs: string[] = []; for (const k of t.order) rs.push(t.rows.get(k) ?? "null");
  return "{\"data\":[" + rs.join(",") + "],\"at\":" + String(now) + ",\"gen\":" + String(t.g) + ",\"next\":null}";
}
// "<epoch>-<seq>" of this run → seq; -1 = another run's or not an id
export function seqOf(h: Hub, from: string): number {
  if (!from.startsWith(h.epoch + "-")) return -1;
  const v = from.slice(h.epoch.length + 1); return /^\d+$/.test(v) ? Number(v) : -1;
}
// a new sub on t: replay after from when the ring still holds everything after it (resumed), else a snapshot event
export function attach(h: Hub, t: Topic, from: string, now: number): { id: string; resumed: boolean; lines: string[] } {
  h.next++; const id = "s" + String(h.next);
  h.subs.set(id, { id, topic: t.key, last: now }); t.n++;
  const s = from ? seqOf(h, from) : -1;
  const lines: string[] = [];
  if (s >= t.min && s <= h.seq) {
    for (const e of t.ring) if (e.seq > s) lines.push(line(id, evId(h, e.seq), e.k, e.d));
    return { id, resumed: true, lines };
  }
  lines.push(line(id, evId(h, h.seq), "snapshot", snapshotD(t, now)));
  return { id, resumed: false, lines };
}
// unsub: the topic goes with its last sub (its rows are rebuilt by the next sub)
export function detach(h: Hub, id: string): boolean {
  const s = h.subs.get(id); if (!s) return false;
  h.subs.delete(id);
  const t = h.topics.get(s.topic); if (t) { t.n--; if (t.n <= 0) h.topics.delete(t.key); }
  return true;
}
// one event on t: into its ring (trimmed to RING_MAX / RING_MS) and out to its subs
export function emit(h: Hub, t: Topic, k: string, d: string, now: number): void {
  h.seq++; t.ring.push({ seq: h.seq, at: now, k, d }); t.at = now;
  while (t.ring.length > RING_MAX || (t.ring.length && now - (t.ring[0] as REv).at > RING_MS)) { t.min = (t.ring[0] as REv).seq; t.ring.shift(); }
  for (const s of h.subs.values()) if (s.topic === t.key) { s.last = now; h.out(line(s.id, evId(h, h.seq), k, d)); }
}
// after an engine step: every topic whose inputs moved gets one patch with the rows that changed or came (upsert) and
// the keys that left (remove); nothing when the rows came out the same
export function step(h: Hub, now: number): number {
  if (!h.topics.size) return 0;
  const g = gen("sessions"); let n = 0;
  for (const t of h.topics.values()) {
    if (t.g === g) continue;
    t.g = g;
    const b = build(t.q); if (b.err) continue;
    const up: string[] = []; const seen = new Set<string>();
    for (let i = 0; i < b.rows.length; i++) {
      const k = b.keys[i] ?? ""; seen.add(k);
      const j = JSON.stringify(b.rows[i] as Obj); if (t.rows.get(k) !== j) { t.rows.set(k, j); up.push(j); }
    }
    const rm: string[] = []; for (const k of t.order) if (!seen.has(k)) { rm.push(k); t.rows.delete(k); }
    t.order = b.keys;
    if (!up.length && !rm.length) continue;
    emit(h, t, "patch", "{\"upsert\":[" + up.join(",") + "],\"remove\":" + JSON.stringify(rm) + "}", now); n++;
  }
  return n;
}
// heartbeat: every sub quiet for HB_MS gets "hb" with its topic's current id (not kept in the ring)
export function beat(h: Hub, now: number): number {
  let n = 0;
  for (const s of h.subs.values()) if (now - s.last >= HB_MS) { s.last = now; h.out(line(s.id, evId(h, h.seq), "hb", "")); n++; }
  return n;
}
