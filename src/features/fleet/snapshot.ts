// agentglass — `agentglass fleet snapshot` (fleet spec 12): the host's state as an incremental `agentglass-snapshot/v1`
// for one viewer (its peer id), relative to the last generation that viewer acknowledged. No lost deltas: the host keeps
// per peer the generation the viewer applied (acked) and the one it sent last (pending); a lost snapshot is repaired by
// the next request, which acknowledges the older one again (spec 12.3, Decision 17)
// SPDX-License-Identifier: Apache-2.0
import { writeSync, mkdirSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { complete, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import { cliError } from "../agentenv.ts";
import { sessions, loadHead, loadTail } from "../../model/sessions.ts";
import type { Sess } from "../../model/types.ts";
import { BUILD } from "../../build-info.ts";
import { hostId, hostName } from "../../util/hostid.ts";
import { readBytes, readWhole } from "../../util/fs.ts";
import { sha256Hex } from "../../util/sha256.ts";
import { type Obj, obj, str, parse } from "../../util/json.ts";
import { REDACT } from "../redact-on.ts";
import { discover, jsonSess } from "../cli.ts";
import { json, summary } from "../cost-cli.ts";
import { livePid } from "../query/eval.ts";
import { peers } from "../vcs/json.ts";
import { allowanceInfo, codexWins, modeOf } from "../usage/bill-live.ts";
import { pricesSig, resolve, cost } from "../usage/pricing.ts";
import { ledger } from "../usage/ledger.ts";
import { type Acc, lastDays } from "../usage/record.ts";
import { monthStart } from "../usage/costs.ts";
import { rowsFor, ownKeys } from "../usage/msgrows.ts";
import type { OwnRow, SessRow } from "./model.ts";
import { type Snap, newSnap, snapLines, dayRows } from "./snap.ts";
import { fleetDir } from "./store.ts";
import { DAY_MS } from "./pull.ts";
import { argVal } from "../../util/argv.ts";

export interface Gen { gen: string; sig: Map<string, string> } // key → signature ("s:<key>" a session, "o:<key>" its owned rows)
export interface PeerState { acked: Gen | null; pending: Gen | null }
export const PEER_RE = /^[0-9a-f]{16}$|^drop$/;
export const MAX_PEERS = 16;
// the peers' state lives next to the fleet spool (~/.agentglass/fleet-peers; AGENTGLASS_FLEET_DIR moves both)
export function peersDir(): string { return join(fleetDir(), "..", "fleet-peers"); }
// a redacted stream is another peer: its rows differ, a viewer keeps it in its own cache (.r)
export function peerFile(peer: string): string { return join(peersDir(), peer + (REDACT ? ".r" : "") + ".json"); }

const HEX = "0123456789abcdef";
// 16 hex digits from the kernel's random source (ids that must not repeat across runs: no Math.random)
export function newGen(): string {
  let b = readBytes("/dev/urandom", 0, 8); let o = "";
  if (b.length < 8) { const x: number[] = []; for (let i = 0; i < 8; i++) x.push(Math.floor(Math.random() * 256)); b = new Uint8Array(x); }
  for (let i = 0; i < 8; i++) { const v = b[i] ?? 0; o += HEX.charAt(v >> 4) + HEX.charAt(v & 15); }
  return o;
}
function genOut(g: Gen | null): Obj | null { if (!g) return null; const s: Obj = {}; for (const [k, v] of g.sig) s[k] = v; return { gen: g.gen, sig: s }; }
function genIn(v: unknown): Gen | null {
  const o = obj(v); if (!o) return null; const g = str(o["gen"]); if (!/^[0-9a-f]{16}$/.test(g)) return null;
  const m = new Map<string, string>(); const s = obj(o["sig"]) ?? {}; for (const k of Object.keys(s)) m.set(k, str(s[k]));
  return { gen: g, sig: m };
}
export function loadPeer(peer: string): PeerState {
  const r = readWhole(peerFile(peer), 64 * 1048576); const o = r.text ? parse(r.text) : null;
  return o ? { acked: genIn(o["acked"]), pending: genIn(o["pending"]) } : { acked: null, pending: null };
}
// which generation the next snapshot is relative to (spec 12.3); st moves on (pending → acked) when the viewer applied it
export function baseFor(st: PeerState, ack: string, full: boolean): Gen | null {
  if (full || !ack) return null;
  const p = st.pending; if (p && p.gen === ack) { st.acked = p; st.pending = null; return p; }
  const a = st.acked; if (a && a.gen === ack) return a; // the last one was lost: again from acked
  return null;
}
// the new pending generation, atomically; at most MAX_PEERS peer files (the oldest go: that viewer gets a full one)
export function savePeer(peer: string, st: PeerState, next: Gen): void {
  const d = peersDir(); try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (e) { return; }
  st.pending = next;
  const f = peerFile(peer); const tmp = f + "." + String(process.pid) + ".tmp";
  try { writeFileSync(tmp, JSON.stringify({ acked: genOut(st.acked), pending: genOut(st.pending) }), { mode: 0o600 }); renameSync(tmp, f); } catch (e) { return; }
  let fs: { n: string; t: number }[] = [];
  try { for (const n of readdirSync(d)) if (n.endsWith(".json")) { let t = 0; try { t = statSync(join(d, n)).mtimeMs; } catch (e) { t = 0; } fs.push({ n, t }); } } catch (e) { fs = []; }
  if (fs.length <= MAX_PEERS) return;
  fs.sort((a: { n: string; t: number }, b: { n: string; t: number }) => a.t - b.t);
  for (let i = 0; i < fs.length - MAX_PEERS; i++) { const x = fs[i]; if (x) try { unlinkSync(join(d, x.n)); } catch (e) { /* gone */ } }
}

// ── what goes out ──
// the days a viewer's cost figures need (this month, the last 15 days for the projection) plus a day on each side for
// the time-zone shift; sessions with usage in them travel with their day rows, the list shows those of `days`
export function costDays(now: number): Set<string> {
  const o = new Set<string>(); for (const k of monthStart(now)) o.add(k); for (const k of lastDays(16)) o.add(k);
  const t = new Date(now + DAY_MS); o.add(t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"));
  const ks = [...o].sort(); const f = ks[0] ?? ""; const p = new Date(Date.parse(f + "T12:00:00") - DAY_MS);
  o.add(p.getFullYear() + "-" + String(p.getMonth() + 1).padStart(2, "0") + "-" + String(p.getDate()).padStart(2, "0"));
  return o;
}
function oldest(days: Set<string>): number { const ks = [...days].sort(); return Date.parse((ks[0] ?? "") + "T00:00:00") || 0; }
function tree(s: Sess, out: Sess[]): void { out.push(s); for (const c of s.subs) tree(c, out); }
function accsOf(ss: Sess[]): Acc[] { const o: Acc[] = []; for (const s of ss) { const a = ledger.get(s.path); if (a) o.push(a); } return o; }
// the session's [provider, billing mode] pairs (pi/OpenCode bill per provider; the session's own mode under "")
function provOf(top: Sess, accs: Acc[]): string[][] {
  const ps = new Set<string>(); for (const a of accs) for (const d of a.days.values()) for (const p of d.cp.keys()) ps.add(p);
  const o: string[][] = []; for (const p of [...ps].sort()) o.push([p, modeOf(top, p)]);
  return o;
}
// a booked row at this host's current prices (the day rows are re-priced the same way by the ledger)
function priceNow(r: OwnRow): OwnRow {
  const z = resolve(r.m, r.prov); const n = r.n.slice();
  if (z) { n[5] = cost(z.p, n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0, n[4] ?? 0); n[6] = 1; } else { n[5] = -1; n[6] = 0; }
  return { h: r.h, key: r.key, d: r.d, hr: r.hr, m: r.m, prov: r.prov, n };
}
// one log's owned rows: bookings on the cost days in full, the rest ownership-only (one per message). A log's rows only
// grow (msgrows appends), so a delta carries its new rows alone; each log of a session tree is its own own-line key
function ownOfLog(path: string, a: Acc, days: Set<string>): { rows: OwnRow[]; ok: boolean } {
  const out: OwnRow[] = []; const only = new Set<string>();
  const r = rowsFor(path, "claude", a);
  for (const x of r.rows) {
    if (!x.h) continue;
    if (days.has(x.d)) out.push(priceNow(x));
    else if (!only.has(x.h)) { only.add(x.h); out.push({ h: x.h, key: x.key, d: "", hr: 0, m: "", prov: "", n: [] }); }
  }
  return { rows: out, ok: r.ok };
}
// the row of a session outside the list window: what the cost and the merge read (billing, time), not the list's fields
function shortSess(s: Sess): Obj {
  return { id: s.id, harness: s.h, updated: new Date(s.mtime).toISOString(), live: false, kind: s.kind, costUsd: s.cost < 0 ? null : s.cost,
    billing: { mode: s.bill || "unknown", plan: REDACT ? "" : s.plan, source: s.billSrc }, tokens: { in: s.inTok, out: s.outTok, cacheRead: s.cacheRTok, cacheWrite: s.cacheWTok } };
}
// the own-line key of one log of a session: "<session key>|<its file name>" (the session's own id or a subagent's agent
// id: unique within the session's tree; ownSess() takes the session back)
function logKey(sess: string, path: string): string { const b = path.slice(path.lastIndexOf("/") + 1); return sess + "|" + (b.endsWith(".jsonl") ? b.slice(0, b.length - 6) : b); }
// what a log's rows depend on: its read state, its owned set, the cost days, the price table (else: unchanged since base)
function cheapOf(a: Acc, cdSig: string, ps: string): string { return a.ep + ":" + String(a.off) + ":" + (a.mv ? "t" + String(a.mv.length) : "m" + String(a.mo.size)) + ":" + cdSig + ":" + ps; }
// signature of a row list: count, last hash, token and cost sums (an append keeps the prefix's)
function rowSig(rows: OwnRow[], n: number): string {
  let t = 0; let u = 0; for (let i = 0; i < n && i < rows.length; i++) { const r = rows[i]; if (!r) continue; for (let j = 0; j < 5; j++) t += r.n[j] ?? 0; u += Math.max(0, r.n[5] ?? 0); }
  const last = n > 0 ? rows[n - 1] : undefined;
  return String(n) + ":" + (last ? last.h : "") + ":" + String(t) + ":" + String(Math.round(u * 1e6));
}
const NONE = "none"; // a row set that is empty: nothing on the wire
function sigN(sig: string): number { const i = sig.indexOf(":"); return i > 0 ? Number(sig.slice(0, i)) : -1; }
// every top-level session the snapshot covers: the cost days' (usage), the list window's, the live ones; and every other
// top-level Claude session (ownership only)
export interface Built { snap: Snap; next: Gen; inexact: number }
export function buildSnap(days: number, base: Gen | null, now: number): Built {
  discover();
  const cd = costDays(now); const from = Math.min(oldest(cd), now - days * DAY_MS);
  const win: Sess[] = []; const rest: Sess[] = [];
  for (const s of sessions.values()) {
    if (s.depth !== 0 || s.parent) continue;
    if (s.mtime >= from || livePid(s) > 0) win.push(s); else if (s.h === "claude") rest.push(s);
  }
  win.sort((a: Sess, b: Sess) => b.mtime - a.mtime);
  const listFrom = now - days * DAY_MS;
  // indexed first (cost-only sessions: their logs alone; listed ones also head, tail and git, as --json does)
  for (const s of win) { const t: Sess[] = []; tree(s, t); for (const x of t) complete(x); if (s.mtime >= listFrom || livePid(s) > 0) { loadHead(s); loadTail(s, true); peers(s); } }
  for (const s of rest) { const t: Sess[] = []; tree(s, t); for (const x of t) complete(x); } // ownership needs every Claude log indexed (a cold host: once)
  const x = newSnap(); const next: Gen = { gen: newGen(), sig: new Map<string, string>() }; let inexact = 0;
  const b = base ? base.sig : new Map<string, string>();
  const send = (key: string, rows: OwnRow[]): void => {
    const sg = rowSig(rows, rows.length); next.sig.set("o:" + key, sg);
    const old = b.get("o:" + key);
    if (old === sg) return;
    const on = old !== undefined ? sigN(old) : -1;
    if (old !== undefined && on >= 0 && on < rows.length && rowSig(rows, on) === old) x.own.push({ key, reset: false, rows: rows.slice(on) });
    else x.own.push({ key, reset: true, rows });
  };
  const cdl = [...cd].sort(); const cdSig = (cdl[0] ?? "") + "-" + (cdl[cdl.length - 1] ?? ""); const ps = pricesSig();
  for (const s of win) {
    const t: Sess[] = []; tree(s, t); const accs = accsOf(t);
    const key = s.h + ":" + s.id;
    // a session only the cost figures need (not in the list window, not live): a short row; any session that is not live:
    // nothing rebuilt while its logs, billing, the cost days and the price table stay as they were
    // a listed one that is not live: the same while its logs are, rebuilt at least every 10 minutes (git and repo facts)
    const live = livePid(s) > 0; const listed = s.mtime >= listFrom || live;
    let cheap = "";
    if (!live) {
      cheap = cdSig + ":" + ps + ":" + s.bill + ":" + String(s.mtime) + ":" + (listed ? "L" + String(Math.floor(now / 600000)) : "C");
      for (const a of accs) cheap += ":" + a.ep + "/" + String(a.off) + "/" + String(a.xM);
      next.sig.set("q:" + key, cheap);
    }
    const oldS = b.get("s:" + key);
    if (cheap && oldS !== undefined && b.get("q:" + key) === cheap) next.sig.set("s:" + key, oldS);
    else {
      const row: SessRow = { s: listed ? jsonSess(s) : shortSess(s), key, days: dayRows(accs, cd), own: null, prov: provOf(s, accs) };
      const sg = sha256Hex(JSON.stringify({ s: row.s, d: row.days ?? [], p: row.prov })).slice(0, 16); next.sig.set("s:" + key, sg);
      if (oldS !== sg) x.sess.push(row);
    }
    for (const c of t) {
      if (c.h !== "claude") continue;
      const a = ledger.get(c.path); if (!a) continue;
      const lk = logKey(key, c.path); const cheap = cheapOf(a, cdSig, ps); next.sig.set("c:" + lk, cheap);
      const old = b.get("o:" + lk);
      if (old !== undefined && b.get("c:" + lk) === cheap) { next.sig.set("o:" + lk, old); continue; } // untouched since base: no rows read
      const o = ownOfLog(c.path, a, cd); if (!o.ok) inexact++;
      if (o.rows.length) send(lk, o.rows);
      else { next.sig.set("o:" + lk, NONE); if (old !== undefined && old !== NONE) x.own.push({ key: lk, reset: true, rows: [] }); } // owns nothing (all copies): remembered, not re-read
    }
  }
  for (const s of rest) {
    const t: Sess[] = []; tree(s, t); const key = s.h + ":" + s.id + "|*";
    // cheap signature first (the owned set's stored size): hashing ids only when it changed
    let cheap = "k"; for (const c of t) { const a = ledger.get(c.path); if (a) cheap += ":" + (a.mv ? "t" + String(a.mv.length) : "m" + String(a.mo.size)); }
    const ck = "c:" + key; next.sig.set(ck, cheap);
    const old = b.get("o:" + key);
    if (b.get(ck) === cheap && old !== undefined) { next.sig.set("o:" + key, old); continue; }
    const rows: OwnRow[] = []; const seen = new Set<string>();
    for (const c of t) { const a = ledger.get(c.path); if (a && c.h === "claude") for (const r of ownKeys(c.path, a)) if (!seen.has(r.h)) { seen.add(r.h); rows.push(r); } }
    if (rows.length) send(key, rows); else next.sig.delete(ck);
  }
  if (inexact) x.head["inexact"] = inexact; // logs whose rows do not add up to the ledger: the viewer marks the host ≈
  // what the base had and this run has not: a session row goes (gone), a row set empties (an own reset without rows)
  for (const k of b.keys()) {
    if (next.sig.has(k) || k.startsWith("c:") || k.startsWith("q:")) continue;
    if (k.startsWith("s:")) x.gone.push(k.slice(2));
    else if (k.startsWith("o:") && b.get(k) !== NONE) x.own.push({ key: k.slice(2), reset: true, rows: [] });
  }
  x.head = { version: BUILD.version, hostId: hostId(), hostName: REDACT ? "" : hostName(), os: process.platform, tzOffsetMin: -new Date(now).getTimezoneOffset(), redact: REDACT, days, now, priceSig: pricesSig() };
  x.gen = next.gen; x.base = base ? base.gen : ""; x.full = !base;
  x.cost = json(summary("")); x.allowance = { claude: allowanceInfo(now), codex: codexWins() };
  x.done = true;
  return { snap: x, next, inexact };
}

// `fleet snapshot [--peer <id>] [--ack <gen>] [--full] [--days N] [--redact]`: the snapshot on stdout, one JSON line each;
// the peer state is saved only after the end line was written (a cut write leaves it as it was)
export function snapshotCli(args: string[]): void {
  let days = 7; let peer = ""; let ack = ""; let full = false;
  const usage = "agentglass fleet snapshot [--peer <16 hex>] [--ack <16 hex>] [--full] [--days N] [--redact]";
  for (let i = 2; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--days") { const v = argVal(args, i) ?? ""; i++; days = /^\d+$/.test(v) ? Number(v) : 0; if (days < 1 || days > 90) cliError("usage", "--days needs a whole number 1–90", usage, 2); }
    else if (a === "--peer") { peer = argVal(args, i) ?? ""; i++; if (!PEER_RE.test(peer)) cliError("usage", "--peer needs 16 hex digits (the viewer's host id)", usage, 2); }
    else if (a === "--ack") { ack = argVal(args, i) ?? ""; i++; if (!/^[0-9a-f]{16}$/.test(ack)) cliError("usage", "--ack needs a generation (16 hex digits)", usage, 2); }
    else if (a === "--full") full = true;
    else if (a === "--redact" || a === "--agent" || a === "--no-agent") continue;
    else cliError("usage", "unknown option " + a + " for fleet snapshot", usage, 2);
  }
  S.cli = true;
  const st = peer ? loadPeer(peer) : { acked: null, pending: null };
  const base = peer ? baseFor(st, ack, full) : null;
  const b = buildSnap(days, base, Date.now());
  for (const l of snapLines(b.snap)) { try { writeSync(1, screenOut(l) + "\n"); } catch (e) { process.exit(0); } }
  if (peer) savePeer(peer, st, b.next);
  process.exit(0);
}
