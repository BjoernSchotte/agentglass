// agentglass — OpenCode adapter: sessions live in SQLite (~/.local/share/opencode/opencode.db), read with the sqlite3 CLI
// SPDX-License-Identifier: Apache-2.0
// 2.x: session_v2 + session_message (one row per message, cursor = seq, which has gaps; assistant rows are updated in place
// while they stream). 1.x (or a DB migrated from it): session + message + part (cursor = part ordinal).
// Without a working sqlite3, 2.x sessions come from the service daemon's HTTP API (cursor = index in the message list).
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { HOME, readText } from "../util/fs.ts";
import { query, q, sqliteBin } from "../util/sqlite.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";
import { say } from "../state.ts";
import { type Acc, type Day, bucket, tool, pend, file, lines as addLines, usageExact, reasoning, turn, skill, nlines, num, patchLines, skillLoad, skillUnload, skillRead, skillReadDone } from "../features/usage/record.ts";
import { MQ_MSG } from "../features/usage/facts.ts";
import { outDir } from "../features/usage/skillrec.ts";
import { done } from "../features/usage/calls.ts";
import type { AddFn, HarnessAdapter, Live, SessionSource } from "./types.ts";
import { toolArg, blockText, prompts } from "./common.ts";
import { type Endpoint, endpoint, listSessions, activeSet, messages, lastId } from "./opencode-http.ts";

function dbPath(): string {
  const e = process.env["OPENCODE_DB"]; if (e !== undefined && e) return e;
  const x = process.env["XDG_DATA_HOME"];
  return join(x !== undefined && x ? x : join(HOME, ".local", "share"), "opencode", "opencode.db");
}
function statePath(): string {
  const x = process.env["XDG_STATE_HOME"];
  return join(x !== undefined && x ? x : join(HOME, ".local", "state"), "opencode", "service.json");
}

// one session as of the last scan query. end = cursor after the last record; hold = first record of the running turn still
// being written (-1 none), honored only while the turn really runs; floor = the end readers were given (never moves back);
// busy = a turn is open in the DB (2.x time_suspended, 1.x an assistant message without time.completed); act = its last write;
// fork = the session's creation time when rows older than it are copies of another session's (0 = none can be);
// http = read over the daemon's HTTP API (end/hold/floor are message indexes, see hc)
interface Row { db: string; id: string; parent: string; dir: string; title: string; agent: string; mtime: number; end: number; hold: number; floor: number; busy: boolean; act: number; archived: boolean; v1: boolean; fork: number; http: boolean }
const rows = new Map<string, Row>(); // path ("<db>#<id>") → row
let tables = new Set<string>();
let dbKey = ""; // db + db-wal size/mtime at the last successful query: unchanged → no query
let failedAt = 0; let warned = false;
let sqlOk = false; // SQLite is the transport: the last read worked, or failed fewer than SQL_FAILS times in a row since one did
let sqlFails = 0; const SQL_FAILS = 3; // a busy DB fails a read now and then: no reason to re-read every session over HTTP
let mode = ""; // the transport the rows come from: "seq" (SQLite), "idx" (HTTP); "" = none yet (SessionSource.epoch)
let daemonUp = false; // the 2.x daemon (service.json pid) is alive: without it a leftover time_suspended means nothing
let notDaemon = 0; // the service.json pid is alive but, per the process table, no OpenCode process (recycled after a crash)
const IN_FLIGHT_MS = 1800000; // an open turn nothing vouches for (1.x; 2.x without the daemon) runs for this long after its last write

function fileKey(p: string): string { try { const st = statSync(p); return st.size + ":" + st.mtimeMs; } catch (e) { return "-"; } }
function warnOnce(msg: string): void { if (!warned) { warned = true; say("warn", msg); } }

function load(db: string): boolean {
  const t = query(db, "select name from sqlite_master where type='table'");
  if (!t) return false;
  tables = new Set<string>(); for (const r of t) tables.add(str(r["name"]));
  const next = new Map<string, Row>();
  if (tables.has("session_v2") && tables.has("session_message")) { // 2.x (a 1.18 DB has session_message but no session_v2)
    // `--fork` copies the parent's rows verbatim (seq, time_created, data with cost/tokens) into the new session; like
    // OpenCode's own stats, rows created before a fork session count as copies
    const fc = query(db, "select 1 from pragma_table_info('session_v2') where name='fork_session_id'");
    if (!fc) return false;
    const res = query(db, "select s.id, coalesce(s.parent_id,'') p, s.directory d, coalesce(s.title,'') t, coalesce(s.agent,'') a," +
      (fc.length ? " case when s.fork_session_id is not null then s.time_created else 0 end f," : " 0 f,") +
      " max(s.time_updated, coalesce((select max(m.time_updated) from session_message m where m.session_id=s.id),0)) u," +
      " coalesce((select max(m.seq)+1 from session_message m where m.session_id=s.id),0) e," +
      " s.time_suspended is not null b, s.time_archived is not null x," +
      // while it runs, the first message of this turn (after the last idle) still being written — streaming assistant,
      // running shell/compaction — ends the readable range; an older turn that never finished doesn't count
      " case when s.time_suspended is not null then (select min(m.seq) from session_message m where m.session_id=s.id" +
      " and m.seq > coalesce((select max(i.seq) from session_message i where i.session_id=s.id and i.type='idle'),-1) and" +
      " ((m.type='assistant' and json_extract(m.data,'$.time.completed') is null) or (m.type in ('shell','compaction') and json_extract(m.data,'$.status')='running'))) end o" +
      " from session_v2 s");
    if (!res) return false;
    for (const r of res) {
      const id = str(r["id"]); const e = num(r["e"]); const o = r["o"];
      next.set(db + "#" + id, { db, id, parent: str(r["p"]), dir: str(r["d"]), title: str(r["t"]), agent: str(r["a"]), mtime: num(r["u"]), end: e, hold: typeof o === "number" ? num(o) : -1, floor: 0, busy: num(r["b"]) === 1, act: num(r["u"]), archived: num(r["x"]) === 1, v1: false, fork: num(r["f"]), http: false });
    }
  }
  if (tables.has("session") && tables.has("message") && tables.has("part")) { // 1.x
    // a 1.x fork has no marker: it clones the parent's messages and parts with their original time_created (all older
    // than the new session, which a session's own messages never are)
    const res = query(db, "select s.id, coalesce(s.parent_id,'') p, s.directory d, coalesce(s.title,'') t, coalesce(s.agent,'') a, s.time_updated u, s.time_archived is not null x, s.time_created f," +
      " (select count(*) from part pt join message m on m.id=pt.message_id where pt.session_id=s.id) n," +
      " (select json_object('r',json_extract(m.data,'$.role'),'c',json_extract(m.data,'$.time.completed'),'n',(select count(*) from part pt where pt.message_id=m.id)," +
      " 'u',max(m.time_updated, coalesce((select max(pt.time_updated) from part pt where pt.message_id=m.id),0))) from message m where m.session_id=s.id order by m.time_created desc, m.id desc limit 1) l" +
      " from session s");
    if (!res) return false;
    for (const r of res) {
      const id = str(r["id"]); const path = db + "#" + id;
      if (next.has(path)) continue; // the same id in both schemas: the 2.x row is the live one
      const l = parseJson(str(r["l"]));
      const lu = l ? num(l["u"]) : 0;
      const busy = !!l && str(l["r"]) === "assistant" && (l["c"] === null || l["c"] === undefined);
      const n = num(r["n"]);
      next.set(path, { db, id, parent: str(r["p"]), dir: str(r["d"]), title: str(r["t"]), agent: str(r["a"]), mtime: Math.max(num(r["u"]), lu), end: n, hold: busy && l ? n - num(l["n"]) : -1, floor: 0, busy, act: lu, archived: num(r["x"]) === 1, v1: true, fork: num(r["f"]), http: false });
    }
  }
  keep(next, false);
  return true;
}
// the end never moves back (a row that became unsettled again would otherwise reset every reader) — within one transport:
// the other one's cursor means something else
function keep(next: Map<string, Row>, http: boolean): void {
  for (const [p, r] of next) { const old = rows.get(p); if (old && old.http === http) r.floor = old.floor; }
  rows.clear(); for (const [p, r] of next) rows.set(p, r);
}

// ── HTTP transport: the session list each scan, each session's messages cached and fetched from the last settled one ──
interface Msgs { msgs: Obj[]; settled: number; mt: number; busy: boolean } // settled = leading messages that no longer change
const hc = new Map<string, Msgs>(); // path → messages
const SYNC_MS = 2000; // per scan; sessions left over keep their last known end until the next scan
// still being written: a streaming assistant (no time.completed yet), a running shell or compaction
function unsettled(m: Obj): boolean {
  const t = str(m["type"]);
  return (t === "assistant" && !tm(m, "completed")) || ((t === "shell" || t === "compaction") && str(m["status"]) === "running");
}
function settledCount(ms: Obj[]): number { let i = 0; for (const m of ms) { if (unsettled(m)) return i; i++; } return ms.length; }
// the SQLite hold rule on fetched rows: the first unsettled message of the turn after the last idle
function holdIdx(ms: Obj[]): number {
  let idle = -1; let i = 0;
  for (const m of ms) { if (str(m["type"]) === "idle") idle = i; i++; }
  i = 0;
  for (const m of ms) { if (i > idle && unsettled(m)) return i; i++; }
  return -1;
}
// fetch from the last settled message on (re-fetch from the start when that cursor fails: a revert deleted its message)
function sync(ep: Endpoint, path: string, r: Row, was: boolean): void {
  const c = hc.get(path);
  if (c && c.mt === r.mtime && !was && !c.busy) return;
  let base = c ? c.msgs.slice(0, c.settled) : [];
  let got = messages(ep, r.id, lastId(base));
  if (!got && base.length) { base = []; got = messages(ep, r.id, ""); }
  if (got) { const ms = base.concat(got); hc.set(path, { msgs: ms, settled: settledCount(ms), mt: r.mtime, busy: was }); }
}
function loadHttp(ep: Endpoint, db: string): boolean {
  const list = listSessions(ep); if (!list) return false;
  const next = new Map<string, Row>();
  for (const o of list) {
    const id = str(o["id"]); if (!id) continue;
    const t = obj(o["time"]); const loc = obj(o["location"]);
    const up = t ? num(t["updated"]) : 0;
    next.set(db + "#" + id, { db, id, parent: str(o["parentID"]), dir: loc ? str(loc["directory"]) : "", title: str(o["title"]), agent: str(o["agent"]), mtime: up, end: 0, hold: -1, floor: 0,
      busy: false, act: up, archived: !!t && t["archived"] !== undefined && t["archived"] !== null, v1: false, fork: o["fork"] !== undefined && o["fork"] !== null && t ? num(t["created"]) : 0, http: true });
  }
  const t0 = Date.now();
  for (const [p, r] of [...next.entries()].sort((x, y) => y[1].mtime - x[1].mtime)) {
    const old = rows.get(p);
    if (Date.now() - t0 < SYNC_MS) sync(ep, p, r, !!old && old.busy);
  }
  // the active set after the messages: a turn that started in between is busy, and its streaming row (already fetched) held
  const ids = activeSet(ep); if (!ids) return false;
  const act = new Set<string>(ids);
  for (const [p, r] of next) {
    r.busy = act.has(r.id);
    const c = hc.get(p); if (!c) continue;
    if (r.busy) c.busy = true;
    r.end = c.msgs.length; r.hold = r.busy ? holdIdx(c.msgs) : -1;
  }
  for (const p of [...hc.keys()]) if (!next.has(p)) hc.delete(p);
  keep(next, true);
  return true;
}
// one message as a record line: the SQLite line shape (type, seq first, then the message's own fields incl. id; copied when a fork took it from its parent)
function httpLine(m: Obj, i: number, fork: number): string {
  const o: Obj = {}; o["type"] = str(m["type"]); o["seq"] = i;
  if (fork > 0 && tm(m, "created") < fork) o["copied"] = 1;
  for (const k of Object.keys(m)) if (k !== "type" && k !== "seq") o[k] = m[k];
  return JSON.stringify(o);
}

// mid-turn, decided when asked (the DB is only re-read when it changes): an open 2.x turn while the service daemon lives
// (it resumes suspended sessions; a dead one leaves time_suspended set); otherwise — 1.x, 2.x `--standalone`/`--server`
// with a private server and no service.json — while the turn was written to within IN_FLIGHT_MS
function running(r: Row): boolean { return r.busy && ((!r.v1 && daemonUp) || Date.now() - r.act < IN_FLIGHT_MS); }
function endOf(r: Row): number {
  const e = running(r) && r.hold >= 0 ? Math.min(r.end, r.hold) : r.end;
  if (e > r.floor) r.floor = e;
  return r.floor;
}
function daemonPid(): number { const o = parseJson(readText(statePath(), 0, 8192).trim()); return o ? num(o["pid"]) : 0; }
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return false; } } // the daemon is the user's own process

// SQLite first (seq cursor, suspended turns, full-text search, 1.x); the daemon's HTTP API when sqlite3 is missing or fails
function scan(add: AddFn): void {
  const db = dbPath(); const have = existsSync(db);
  const dp = daemonPid(); daemonUp = dp > 0 && dp !== notDaemon && pidAlive(dp); // before any stat: sizes depend on it
  let m = "";
  if (have && sqliteBin()) { // probe cached
    const k = db + "|" + fileKey(db) + "|" + fileKey(db + "-wal");
    if (k !== dbKey && Date.now() - failedAt > 30000) { // a failed query backs off: never a 3 s stall on every tick
      if (load(db)) { dbKey = k; sqlOk = true; sqlFails = 0; }
      else {
        failedAt = Date.now(); sqlFails++;
        if (mode !== "seq" || sqlFails >= SQL_FAILS) sqlOk = false;
        else warnOnce("OpenCode: reading " + db + " with sqlite3 failed");
      }
    }
    if (sqlOk) m = "seq";
  } else { sqlOk = false; dbKey = ""; }
  if (!m) {
    const ep = daemonUp ? endpoint(statePath()) : null;
    if (ep && loadHttp(ep, db)) { m = "idx"; dbKey = ""; } // the next SQLite read starts from scratch
  }
  if (m) { if (m === "seq") hc.clear(); mode = m; }
  else if (!have && mode !== "idx" && !existsSync(statePath())) { rows.clear(); dbKey = ""; return; } // no OpenCode here
  else warnOnce(have && sqliteBin() ? "OpenCode: reading " + db + " with sqlite3 failed" : "OpenCode needs the sqlite3 CLI or a running `opencode service`"); // rows kept for the run: no flicker
  for (const [p, r] of rows) add(p, r.id, r.parent, r.archived);
}
// liveness links a process to a session by cwd before any head is loaded
function meta(s: Sess): void {
  const r = rows.get(s.path); if (!r) return;
  s.cwd = r.dir;
  if (r.parent) s.kind = r.agent || "subagent";
}

// ── source: records are rows ──
// rows vary from bytes to hundreds of KB (2.x assistant rows embed tool output): one call returns rows until their data
// passes max(READ_MIN, span × unit) — always at least one — and the cursor resumes after the last row returned
const UNIT = 8192; // ≈ bytes per row, for the byte-sized read windows
const READ_MIN = 4194304;
function sessionLines(s: Sess, from: number, to0: number): { lines: string[]; next: number } {
  const r = rows.get(s.path);
  const to = r ? Math.min(to0, endOf(r)) : from;
  if (!r || to <= from) return { lines: [], next: from };
  if (r.http) { // every message is in memory
    const c = hc.get(s.path); if (!c) return { lines: [], next: from };
    const e = Math.min(to, c.msgs.length); const out: string[] = [];
    let i = from; for (const m of c.msgs.slice(from, e)) { out.push(httpLine(m, i, r.fork)); i++; }
    return { lines: out, next: Math.max(from, e) };
  }
  const budget = String(Math.max(READ_MIN, (to - from) * UNIT));
  // rows a fork copied from its parent are tagged "copied" (usage skips them, the transcript shows them)
  const f = String(r.fork);
  if (!r.v1) { // every row in [from, to) comes back, gaps included: the cursor moves to `to` unless the budget cut it short
    const head = r.fork > 0 ? "case when time_created < " + f + " then json_object('type',type,'seq',seq,'id',id,'copied',1) else json_object('type',type,'seq',seq,'id',id) end" : "json_object('type',type,'seq',seq,'id',id)";
    const res = query(r.db, "select json_patch(" + head + ", data) l, seq, c >= " + budget + " cut from (select id, type, seq, time_created, data, length(data) n," +
      " sum(length(data)) over (order by seq) c from session_message where session_id=" + q(r.id) +
      " and seq >= " + String(from) + " and seq < " + String(to) + ") where c - n < " + budget + " order by seq");
    if (!res) return { lines: [], next: from };
    const out: string[] = []; for (const x of res) out.push(str(x["l"]));
    const last = res.length ? res[res.length - 1] : null;
    return { lines: out, next: last && num(last["cut"]) === 1 ? num(last["seq"]) + 1 : to };
  }
  const res = query(r.db, "select json_object('v1',1,'role',json_extract(md,'$.role'),'model',json_extract(md,'$.modelID'),'prov',json_extract(md,'$.providerID'),'t',mt,'mid',mid,'copied',mt < " + f + ",'part',json(pd)) l" +
    " from (select md, mt, mid, pd, k, n, sum(n) over (order by k) c from (select m.data md, m.time_created mt, m.id mid, pt.data pd, length(pt.data) n," +
    " row_number() over (order by m.time_created, m.id, pt.id) k from part pt join message m on m.id=pt.message_id where pt.session_id=" + q(r.id) + ")" +
    " where k > " + String(from) + " and k <= " + String(to) + ") where c - n < " + budget + " order by k");
  if (!res) return { lines: [], next: from };
  const out: string[] = []; for (const x of res) out.push(str(x["l"]));
  return { lines: out, next: from + out.length };
}
const source: SessionSource = {
  stat: (s: Sess) => { const r = rows.get(s.path); return r ? { size: endOf(r), mtime: r.mtime } : null; },
  align: (s: Sess, at: number) => at, // every cursor value starts a record
  lines: sessionLines,
  unit: UNIT,
  // one transport for every session; spelled with s: scriptc rejects a zero-parameter arrow for this optional member (SC2003)
  epoch: (s: Sess) => s.h ? mode : mode,
};

// ── transcript ──
function iso(ms: number): string { return ms > 0 ? new Date(ms).toISOString() : ""; }
function ev(out: Ev[], kind: string, text: string, ts: string, id: string, full: string): void { out.push({ kind, text, ts, id, full }); }
function tm(o: Obj | null, k: string): number { const t = o ? obj(o["time"]) : null; return t ? num(t[k]) : 0; }
function argOf(name: string, inp: Obj | null): string { const fp = inp ? str(inp["filePath"]) : ""; return fp || toolArg(name, inp, ""); } // 1.x names it filePath
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  const o = obj(e); if (!o) return "";
  const d = obj(o["data"]);
  return str(o["message"]) || (d ? str(d["message"]) : "") || str(o["name"]) || JSON.stringify(o);
}
// a tool call and, once it settled, its result (both schemas keep them in one record)
function toolEvs(out: Ev[], name: string, id: string, st: Obj | null, ts: string, v1: boolean): void {
  const inp = st ? obj(st["input"]) : null;
  ev(out, "tool", name + "\u0000" + argOf(name, inp), ts, id, inp ? JSON.stringify(inp) : "");
  const status = st ? str(st["status"]) : "";
  if (!st || (status !== "completed" && status !== "error")) return;
  const body = v1 ? str(st["output"]) : blockText(st["content"]);
  const md = obj(st["metadata"]);
  const rts = iso(tm(st, "end")) || ts;
  ev(out, "result", status === "error" ? "[error] " + errText(st["error"]) + (body ? "\n" + body : "") : body, rts, id, md ? JSON.stringify(md) : "");
}
function parse2(o: Obj, out: Ev[], s: Sess | null): void {
  const type = str(o["type"]); const ts = iso(tm(o, "created"));
  if (type === "user") { const t = str(o["text"]); if (t) ev(out, "user", t, ts, "", ""); return; }
  if (type === "assistant") {
    const m = obj(o["model"]); if (s && m) { const id = str(m["id"]); if (id) s.model = id; }
    for (const b of arr(o["content"])) {
      const bo = obj(b); if (!bo) continue;
      const bt = str(bo["type"]);
      if (bt === "text") { const t = str(bo["text"]); if (t) ev(out, "assistant", t, ts, "", ""); }
      else if (bt === "reasoning") { const t = str(bo["text"]); if (t) ev(out, "thinking", t, ts, "", ""); }
      else if (bt === "tool") toolEvs(out, str(bo["name"]) || "tool", str(bo["id"]), obj(bo["state"]), iso(tm(bo, "created")) || ts, false);
    }
    if (o["error"] !== undefined && o["error"] !== null) ev(out, "meta", "[error] " + errText(o["error"]), ts, "", "");
    return;
  }
  if (type === "shell") { // the user's own `!cmd`
    const id = str(o["shellID"]) || "shell" + String(num(o["seq"]));
    const cmd = str(o["command"]);
    ev(out, "tool", "!shell\u0000" + cmd, ts, id, JSON.stringify({ command: cmd }));
    const status = str(o["status"]);
    if (status === "running") return;
    const op = obj(o["output"]); const exit = o["exit"];
    const bad = status !== "exited" || (typeof exit === "number" && exit !== 0);
    ev(out, "result", (bad ? "[error] " : "") + (op ? str(op["output"]) : ""), iso(tm(o, "completed")) || ts, id, "");
    return;
  }
  if (type === "compaction") { const st = str(o["status"]); if (st !== "running") ev(out, "meta", st === "failed" ? "[error] compaction: " + errText(o["error"]) : "context compacted", ts, "", ""); return; }
  if (type === "idle") { const oc = str(o["outcome"]); ev(out, "meta", oc === "interrupted" ? "turn aborted" : oc === "failed" ? "turn complete (failed)" : "turn complete", ts, "", ""); return; }
  if (type === "system" || type === "synthetic") { const t = str(o["description"]) || str(o["text"]); if (t) ev(out, "meta", type + ": " + t.split("\n")[0], ts, "", ""); return; }
  if (type === "skill") { ev(out, "meta", "skill: " + str(o["name"]), ts, "", ""); return; }
  if (type === "agent-switched") { ev(out, "meta", "agent → " + str(o["agent"]), ts, "", ""); return; }
  if (type === "model-switched") { const m = obj(o["model"]); const id = m ? str(m["id"]) : ""; if (s && id) s.model = id; ev(out, "meta", "model → " + id, ts, "", ""); }
}
function parse1(o: Obj, out: Ev[], s: Sess | null): void {
  const p = obj(o["part"]); if (!p) return;
  const role = str(o["role"]); const pt = str(p["type"]);
  const ts = iso(tm(p, "start") || num(o["t"]));
  if (s && role === "assistant") { const md = str(o["model"]); if (md) s.model = md; }
  if (pt === "text") {
    if (p["synthetic"] === true || p["ignored"] === true) return; // attachments and injected context
    const t = str(p["text"]); if (t) ev(out, role === "user" ? "user" : "assistant", t, ts, "", "");
  } else if (pt === "reasoning") { const t = str(p["text"]); if (t) ev(out, "thinking", t, ts, "", ""); }
  else if (pt === "tool") { const st = obj(p["state"]); toolEvs(out, str(p["tool"]) || "tool", str(p["callID"]), st, iso(tm(st, "start")) || ts, true); }
  else if (pt === "compaction") ev(out, "meta", "context compacted", ts, "", "");
}
function parse(o: Obj, out: Ev[], s: Sess | null): void { if (o["v1"] !== undefined) parse1(o, out, s); else parse2(o, out, s); }

// ── usage: 2.x assistant rows carry cost + tokens; 1.x books the step-finish parts (one per assistant message) ──
function book(a: Acc, d: Day, model: string, tk: Obj | null, usd: number, prov: string): void {
  if (!tk) return;
  const c = obj(tk["cache"]);
  if (model) a.model = model;
  usageExact(a, d, model || a.model, num(tk["input"]), num(tk["output"]) + num(tk["reasoning"]), c ? num(c["read"]) : 0, c ? num(c["write"]) : 0, 0, usd, prov);
  reasoning(a, d, num(tk["reasoning"]));
}
// model: the issuing message's model (1.x part row modelID, 2.x the assistant row's model.id)
function useTool(a: Acc, d: Day, name: string, id: string, st: Obj | null, t0: number, t1: number, model: string): void {
  const ts = tool(a, d, name, model, MQ_MSG);
  const inp = st ? obj(st["input"]) : null;
  const shell = name === "shell" || name === "bash";
  pend(a, d, ts, name, id, t0, iso(t0), argOf(name, inp), shell && inp ? [str(inp["command"])] : []);
  const status = st ? str(st["status"]) : "";
  const p = a.pend.get(id);
  if (p && (status === "completed" || status === "error")) {
    a.pend.delete(id);
    const md = st ? obj(st["metadata"]) : null; const ex = md ? md["exit"] : undefined;
    const codes: number[] = typeof ex === "number" ? [ex as number] : [];
    const body = st ? (typeof st["output"] === "string" ? str(st["output"]) : blockText(st["content"])) : "";
    done(p, t0 > 0 && t1 >= t0 ? t1 - t0 : -1, status === "error" || (codes.length > 0 && codes[0] !== 0), body.length, id, codes);
  }
  if (!inp) return;
  const fin = status === "completed" || status === "error"; // a part is written again as it runs: its text once, at the end
  if (name === "skill") { // 2.x {id}, 1.x {name}; the skill's text is the tool's output (none: size unknown)
    const sn = str(inp["id"]) || str(inp["name"]); skill(d, "model", sn);
    if (fin) { const out = st ? (typeof st["output"] === "string" ? str(st["output"]) : blockText(st["content"])) : ""; skillLoad(a, sn, "model", t1 > 0 ? t1 : t0, "", out, out !== "" && status === "completed", outDir(out, sn), false); }
    return;
  }
  if (name === "read" && fin && status === "completed") { skillRead(a, id, str(inp["filePath"]) || str(inp["path"])); if (a.skr.has(id)) skillReadDone(a, d, id, t1 > 0 ? t1 : t0, "", st ? (typeof st["output"] === "string" ? str(st["output"]) : blockText(st["content"])) : "", false); }
  const path = str(inp["filePath"]) || str(inp["path"]);
  let add = 0; let del = 0;
  if (name === "edit") { add = nlines(str(inp["newString"])); del = nlines(str(inp["oldString"])); }
  else if (name === "write") add = nlines(str(inp["content"]));
  else if (name === "multiedit") for (const e of arr(inp["edits"])) { const eo = obj(e); if (eo) { add += nlines(str(eo["newString"])); del += nlines(str(eo["oldString"])); } }
  else if (name === "apply_patch" || name === "patch") { patchLines(a, d, name, str(inp["patchText"])); return; }
  else return;
  addLines(a, d, add, del); file(a, d, name, path, add, del);
}
function usage(a: Acc, l: string): void {
  if (l.startsWith("{\"v1\":")) {
    const usr = !a.sub && l.indexOf("\"role\":\"user\"") >= 0 && l.indexOf("\"type\":\"text\"") >= 0;
    if (!usr && l.indexOf("\"type\":\"step-finish\"") < 0 && l.indexOf("\"type\":\"tool\"") < 0 && l.indexOf("\"type\":\"compaction\"") < 0) return;
    const o = parseJson(l); if (!o || o["copied"] === 1) return; // a fork's copied history is not this session's work
    const p = obj(o["part"]); if (!p) return;
    if (usr && str(o["role"]) === "user" && str(p["type"]) === "text") { turn(a, tm(p, "start") || num(o["t"]), "", prompts(parse, o)); return; }
    const t = num(o["t"]); const d = bucket(a, t, "");
    const pt = str(p["type"]);
    if (pt === "compaction") { skillUnload(a, t, "compact"); return; }
    if (pt === "step-finish") book(a, d, str(o["model"]), obj(p["tokens"]), num(p["cost"]), str(o["prov"]));
    else if (pt === "tool") { const st = obj(p["state"]); useTool(a, d, str(p["tool"]) || "tool", str(p["callID"]), st, tm(st, "start"), tm(st, "end"), str(o["model"])); }
    return;
  }
  // a skill row is a user activation (the session's skill endpoint, a /skill or mention); the model loads skills with its skill tool
  if (l.startsWith("{\"type\":\"skill\"")) {
    const o = parseJson(l); if (!o || o["copied"] === 1) return;
    const sn = str(o["skill"]) || str(o["name"]); const t = tm(o, "created"); const txt = str(o["content"]) || str(o["text"]);
    skill(bucket(a, t, ""), "command", sn);
    skillLoad(a, sn, "user", t, "", txt, txt !== "", "", false);
    return;
  }
  if (l.startsWith("{\"type\":\"user\"")) { if (a.sub) return; const o = parseJson(l); const n = o && o["copied"] !== 1 ? prompts(parse, o) : 0; if (o && n) turn(a, tm(o, "created"), "", n); return; }
  if (!l.startsWith("{\"type\":\"assistant\"") && !l.startsWith("{\"type\":\"compaction\"")) return;
  const o = parseJson(l); if (!o || o["copied"] === 1) return;
  if (str(o["type"]) === "compaction" && str(o["status"]) !== "running") skillUnload(a, tm(o, "created"), "compact"); // before its own usage
  const d = bucket(a, tm(o, "created"), "");
  const m = obj(o["model"]);
  book(a, d, m ? str(m["id"]) : "", obj(o["tokens"]), num(o["cost"]), m ? str(m["providerID"]) : "");
  for (const b of arr(o["content"])) {
    const bo = obj(b); if (!bo || str(bo["type"]) !== "tool") continue;
    useTool(a, d, str(bo["name"]) || "tool", str(bo["id"]), obj(bo["state"]), tm(bo, "ran") || tm(bo, "created"), tm(bo, "completed"), m ? str(m["id"]) : "");
  }
}

// ── subagents, liveness, search ──
const spawnCache = new Map<string, string>(); // child path → the parent's call id (settled once found)
function spawnOf(s: Sess): string {
  const hit = spawnCache.get(s.path); if (hit !== undefined) return hit;
  const r = rows.get(s.path); if (!r || !r.parent) return "";
  const pr = rows.get(r.db + "#" + r.parent); if (!pr) return "";
  if (pr.http) { // the parent's messages are in memory
    const c = hc.get(r.db + "#" + r.parent); if (!c) return "";
    for (const m of c.msgs) {
      if (str(m["type"]) !== "assistant") continue;
      for (const b of arr(m["content"])) {
        const bo = obj(b); const st = bo && str(bo["type"]) === "tool" ? obj(bo["state"]) : null; const md = st ? obj(st["metadata"]) : null;
        if (!bo || !md || (str(md["sessionID"]) !== r.id && str(md["sessionId"]) !== r.id)) continue;
        const id = str(bo["id"]); spawnCache.set(s.path, id); return id;
      }
    }
    return "";
  }
  const like = " like " + q("%" + r.id + "%");
  const res = pr.v1
    ? query(r.db, "select data from part where session_id=" + q(pr.id) + " and data" + like)
    : query(r.db, "select data from session_message where session_id=" + q(pr.id) + " and type='assistant' and data" + like + " order by seq");
  if (!res) return "";
  for (const x of res) {
    const o = parseJson(str(x["data"])); if (!o) continue;
    const calls: Obj[] = [];
    if (pr.v1) calls.push(o); else for (const b of arr(o["content"])) { const bo = obj(b); if (bo && str(bo["type"]) === "tool") calls.push(bo); }
    for (const c of calls) {
      const st = obj(c["state"]); const md = st ? obj(st["metadata"]) : null;
      if (!md || (str(md["sessionID"]) !== r.id && str(md["sessionId"]) !== r.id)) continue;
      const id = pr.v1 ? str(c["callID"]) : str(c["id"]);
      spawnCache.set(s.path, id);
      return id;
    }
  }
  return "";
}
// ~/.local/state/opencode/service.json names the 2.x daemon ({id, version, url, pid, password}; only pid is read):
// it runs every suspended (= mid-turn) session
function liveRegistry(alive: (pid: number) => boolean, harnessOfPid: (pid: number) => string): Live[] {
  const pid = daemonPid();
  const up = pid > 0 && alive(pid);
  daemonUp = up && harnessOfPid(pid) === "opencode";
  notDaemon = up && !daemonUp ? pid : 0;
  if (!daemonUp) return [];
  const out: Live[] = [{ id: "", pid, status: "", name: "", cwd: "" }]; // the daemon itself, so the cwd link never takes it for a TUI
  for (const r of rows.values()) if (running(r) && !r.v1) out.push({ id: r.id, pid, status: "busy", name: "", cwd: "" });
  return out;
}
function likeEsc(t: string): string { return t.split("\\").join("\\\\").split("%").join("\\%").split("_").join("\\_"); }
function search(term: string): string[] {
  const db = dbPath();
  if (mode === "idx") { // over HTTP the daemon matches titles only
    const t = term.toLowerCase(); const out: string[] = [];
    if (t) for (const [p, r] of rows) if (r.title.toLowerCase().indexOf(t) >= 0) out.push(p);
    return out;
  }
  if (!term || !rows.size || !existsSync(db)) return [];
  const like = " like " + q("%" + likeEsc(term) + "%") + " escape '\\'";
  const sel: string[] = [];
  if (tables.has("session_message")) sel.push("select session_id id from session_message where data" + like);
  if (tables.has("session_v2")) sel.push("select id from session_v2 where title" + like);
  if (tables.has("part")) sel.push("select session_id id from part where data" + like);
  if (tables.has("session")) sel.push("select id from session where title" + like);
  if (!sel.length) return [];
  const res = query(db, sel.join(" union "));
  const out: string[] = [];
  if (res) for (const x of res) { const p = db + "#" + str(x["id"]); if (rows.has(p)) out.push(p); }
  return out;
}
function busy(s: Sess): boolean { const r = rows.get(s.path); return !!r && running(r); }
function title(s: Sess): string { const r = rows.get(s.path); return r ? r.title : ""; }

export const opencode: HarnessAdapter = {
  id: "opencode", label: "OpenCode", glyph: "▣", mark: "▣", color: () => C.purple,
  badge: () => fg(C.sub) + "open" + CSI + "1m" + fg(C.text) + "code" + RST + "  ", // the logo is the wordmark, "code" bold
  bin: "opencode", procs: ["opencode", "opencode.exe", "opencode2", ".opencode"], // 2.x: `opencode.exe serve --service` is the daemon
  roots: (): string[] => [], scan, meta, source, headBytes: 262144,
  parse, title, busy, spawnOf,
  liveRegistry, liveCwd: true, // 1.x TUIs have neither registry nor open transcript
  daemon: "opencode service stop", // SIGTERM would stop every running session (and the next start resumes them anyway)
  headless: (s: Sess, msg: string) => ["run", "-s", s.id, msg],
  resume: (s: Sess) => ["-s", s.id],
  search, usage, // no files: the rows can't be moved to the trash
};
