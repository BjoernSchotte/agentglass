// agentglass — per-message rows of owned Claude messages (fleet spec 13.1, Decision 18): what each owned message booked,
// by hashed id, so a fleet viewer can take one copy's usage out of a session when another host owns the message.
// SPDX-License-Identifier: Apache-2.0
// A sidecar per Claude log under <cache>/msgrows/<sha256(path)[0:16]>: .tsv (one row per booking: h key d hr m prov in
// out cr w5 w1 usd priced) and .st (JSON: the read state it continues from, its row count and token sums). It is built
// by reading the log again into a scratch Acc that claims nothing (ro) and skips the copies the ledger skipped (its mc),
// with the booking tap on: the rows are exactly the ledger's own bookings of that log. It continues from the stored
// offset when the log only grew, and starts over when the ledger's entry for the log no longer matches it (rewritten,
// restarted after an ownership change, another process appended twice): the check is the token sums, which must equal
// the ledger entry's exactly. Only fleet runs (snapshot, drop, the viewer's merge) read or write it: the ledger's hot path
// is unchanged.
import { mkdirSync, writeFileSync, appendFileSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, readBytes } from "../../util/fs.ts";
import { sha256Hex } from "../../util/sha256.ts";
import { parse, obj, str, arr } from "../../util/json.ts";
import { harnessOf } from "../../harness/index.ts";
import { type Acc, type Booking, newAcc, setBookTap, flushSpans } from "./record.ts";
import { mine, keyOf } from "./owners.ts";
import type { OwnRow } from "../fleet/model.ts";

// a message id leaves its host only as this: 64 bits of a salted SHA-256 (spec Decision 19)
export function msgHash(id: string): string { return sha256Hex("agentglass/msg/v1|" + id).slice(0, 16); }
export function rowsDir(): string { return join(cacheDir(), "msgrows"); }
function base(path: string): string { return join(rowsDir(), sha256Hex(path).slice(0, 16)); }
export function rowsFile(path: string): string { return base(path) + ".tsv"; }
function stFile(path: string): string { return base(path) + ".st"; }
function idsFile(path: string): string { return base(path) + ".ids"; } // the booked ids, read only to continue a log

// the scratch reader's state between runs: byte offset, epoch, the booked ids (id → output tokens so far: a later line
// of a streamed message adds only the growth), the adapter's state (model, x), the rows written and their token sums
interface St { off: number; ep: string; model: string; x: number[]; ids: Map<string, number>; rows: number; sum: number[] }
function newSt(ep: string): St { return { off: 0, ep, model: "", x: [], ids: new Map<string, number>(), rows: 0, sum: [0, 0, 0, 0] }; }
function nums(v: unknown): number[] { const o: number[] = []; for (const x of arr(v)) o.push(typeof x === "number" ? x as number : 0); return o; }
function stIn(t: string): St | null {
  const o = parse(t); if (!o || o["v"] !== 1) return null;
  const st = newSt(str(o["ep"]));
  st.off = typeof o["off"] === "number" ? o["off"] as number : 0; st.model = str(o["model"]); st.x = nums(o["x"]);
  st.rows = typeof o["rows"] === "number" ? o["rows"] as number : 0; st.sum = nums(o["sum"]);
  return st.sum.length === 4 ? st : null;
}
function stOut(st: St): string { return JSON.stringify({ v: 1, off: st.off, ep: st.ep, model: st.model, x: st.x, rows: st.rows, sum: st.sum }); }
// "<id> <n>" lines; false = unreadable (start over)
function idsIn(path: string, st: St): boolean {
  const t = readAll(idsFile(path)); if (!t && st.rows > 0) return false;
  for (const l of t.split("\n")) { if (!l) continue; const i = l.lastIndexOf(" "); if (i <= 0) return false; st.ids.set(l.slice(0, i), Number(l.slice(i + 1))); }
  return true;
}
function idsOut(st: St): string { const o: string[] = []; for (const [k, n] of st.ids) o.push(k + " " + String(n)); return o.join("\n") + "\n"; }
// the ledger entry's token sums the rows must add up to
function sumOf(a: Acc): number[] { return [a.inTok, a.outTok, a.cr, a.cw]; }
function same(x: number[], y: number[]): boolean { if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) > 0.5) return false; return true; }

export function rowLine(r: OwnRow): string {
  const n = r.n;
  return r.h + "\t" + String(r.key) + "\t" + r.d + "\t" + String(r.hr) + "\t" + r.m + "\t" + r.prov + "\t" + String(n[0] ?? 0) + "\t" + String(n[1] ?? 0) + "\t" + String(n[2] ?? 0) + "\t" +
    String(n[3] ?? 0) + "\t" + String(n[4] ?? 0) + "\t" + String(n[5] ?? 0) + "\t" + String(n[6] ?? 0);
}
// null = not a row (a torn or foreign line)
export function rowOf(l: string): OwnRow | null {
  const f = l.split("\t"); if (f.length !== 13) return null;
  const key = Number(f[1] ?? ""); const hr = Number(f[3] ?? "");
  if (!(key >= 0) || !(hr >= 0 && hr < 24) || !/^\d{4}-\d\d-\d\d$/.test(f[2] ?? "")) return null;
  const n: number[] = [];
  for (let i = 6; i < 13; i++) { const v = Number(f[i] ?? ""); if (!isFinite(v) || (f[i] ?? "") === "") return null; n.push(v); }
  return { h: f[0] ?? "", key, d: f[2] ?? "", hr, m: f[4] ?? "", prov: f[5] ?? "", n };
}
function readAll(p: string): string { try { return readFileSync(p, "utf8"); } catch (e) { return ""; } }
// rows from index `from`; ok = false when the file is missing or a line does not parse
export function readRows(path: string, from: number): { rows: OwnRow[]; n: number; ok: boolean } {
  const t = readAll(rowsFile(path)); const rows: OwnRow[] = [];
  if (!t) return { rows, n: 0, ok: false };
  const ls = t.split("\n"); let n = 0;
  for (const l of ls) {
    if (!l) continue;
    const r = rowOf(l); if (!r) return { rows: [], n, ok: false };
    if (n >= from) rows.push(r);
    n++;
  }
  return { rows, n, ok: true };
}

// the log read from st.off up to `to` into a scratch Acc carrying st; every booking becomes a row (consecutive bookings of
// one message into the same day, hour, model and provider are one row). The chunking and the >1 MB line skip are the
// ledger's (ledger.ts step): the scratch sees exactly the lines the ledger booked
const CHUNK = 1048576;
// until: stop after the chunk that passes this clock time (st.off says how far it got: a later call continues there)
function scan(path: string, h: string, a: Acc, st: St, to: number, out: OwnRow[], until = Infinity): void {
  const s = newAcc(); s.p = path; s.ro = true; s.sub = a.sub; s.mc = a.mc; s.ep = st.ep; s.off = st.off; s.ids = st.ids; s.model = st.model; s.x = st.x;
  const owned = mine(a); const ad = harnessOf(h);
  let bs: Booking[] = [];
  setBookTap((b: Booking): void => { bs.push(b); });
  try {
    let skip = false;
    while (s.off < to) {
      const len = Math.min(CHUNK, to - s.off);
      const b = readBytes(path, s.off, len); if (!b.length) break;
      let z = b.length - 1; while (z >= 0 && b[z] !== 10) z--;
      if (z < 0) { if (s.off + b.length < to) { skip = true; s.off += b.length; continue; } break; }
      const ls = new TextDecoder("utf-8").decode(b.subarray(0, z + 1)).split("\n");
      for (let i = skip ? 1 : 0; i < ls.length; i++) {
        const l = ls[i] ?? ""; if (!l) continue;
        ad.usage(s, l);
        if (!bs.length) continue;
        const o = parse(l); const m = o ? obj(o["message"]) : null;
        const id = (m ? str(m["id"]) : "") || (o ? str(o["requestId"]) : "");
        const k = owned.get(id); const key = k !== undefined ? k : keyOf(o ? str(o["timestamp"]) : "", false);
        const hh = id ? msgHash(id) : ""; // no id: never matched across hosts, still part of the sums
        for (const x of bs) {
          const n = [x.nIn, x.nOut, x.cr, x.cw - x.w1, x.w1, x.unk > 0 ? -1 : x.cost, x.unk > 0 ? 0 : 1];
          const last = out.length ? out[out.length - 1] : null;
          if (last && last.h === hh && last.d === x.day && last.hr === x.hr && last.m === x.model && last.prov === x.prov && ((last.n[6] ?? 0) === (n[6] ?? 0))) {
            for (let j = 0; j < 5; j++) last.n[j] = (last.n[j] ?? 0) + (n[j] ?? 0);
            if ((n[6] ?? 0) === 1) last.n[5] = (last.n[5] ?? 0) + (n[5] ?? 0);
          } else out.push({ h: hh, key, d: x.day, hr: x.hr, m: x.model, prov: x.prov, n });
          st.sum[0] = (st.sum[0] ?? 0) + x.nIn; st.sum[1] = (st.sum[1] ?? 0) + x.nOut; st.sum[2] = (st.sum[2] ?? 0) + x.cr; st.sum[3] = (st.sum[3] ?? 0) + x.cw;
        }
        bs = [];
      }
      flushSpans(s);
      skip = false;
      s.off += z + 1;
      if (Date.now() >= until) break;
    }
  } finally { setBookTap(null); }
  st.off = s.off; st.model = s.model; st.x = s.x; st.ids = s.ids;
}
function ensure(): boolean { try { mkdirSync(rowsDir(), { recursive: true, mode: 0o700 }); return true; } catch (e) { return false; } }
function writeAtomic(p: string, t: string): void { const tmp = p + "." + String(process.pid) + ".tmp"; writeFileSync(tmp, t, { mode: 0o600 }); renameSync(tmp, p); }

export interface Rows { rows: OwnRow[]; ok: boolean; rebuilt: boolean }
// a rebuild in slices (rowsBy): the read state and the rows so far, per log; a new ledger entry starts it over
const RB = new Map<string, { a: Acc; st: St; rows: OwnRow[] }>();
// the owned-message rows of one Claude log as its ledger entry `a` has booked it (h = the harness, "claude"); brings the
// sidecar up to date first (continues or starts over). ok = false: the rows still do not add up to the entry (a log the
// ledger read differently, e.g. a line it skipped as too long that grew): the caller treats the session as inexact
export function rowsFor(path: string, h: string, a: Acc): Rows { return rowsBy(path, h, a, Infinity) ?? { rows: [], ok: false, rebuilt: true }; }
// rowsFor in time slices (the TUI's merge): a log read again from the start stops after the chunk that passes `until` and
// returns null; the next call goes on from there (a 1 MB chunk at most past the clock). A cached or grown sidecar: at once
export function rowsBy(path: string, h: string, a: Acc, until: number): Rows | null {
  const want = sumOf(a);
  const rb = RB.get(path);
  if (rb && rb.a === a && rb.st.ep === a.ep && rb.st.off <= a.off) return rebuild(path, h, a, rb.st, rb.rows, want, until);
  RB.delete(path);
  let st = stIn(readAll(stFile(path)));
  if (st && st.ep === a.ep && st.off === a.off && same(st.sum, want)) {
    const r = readRows(path, 0);
    if (r.ok && r.n === st.rows) return { rows: r.rows, ok: true, rebuilt: false };
  }
  const canWrite = ensure();
  if (st && st.ep === a.ep && st.off < a.off) { // grew: continue, then check the sums
    const prev = readRows(path, 0);
    if (prev.ok && prev.n === st.rows && idsIn(path, st)) {
      const add: OwnRow[] = []; scan(path, h, a, st, a.off, add);
      if (same(st.sum, want)) {
        if (canWrite) { try { const t: string[] = []; for (const r of add) t.push(rowLine(r) + "\n"); if (t.length) appendFileSync(rowsFile(path), t.join("")); st.rows = prev.n + add.length; writeAtomic(idsFile(path), idsOut(st)); writeAtomic(stFile(path), stOut(st)); } catch (e) { /* the next run starts over */ } }
        return { rows: prev.rows.concat(add), ok: true, rebuilt: false };
      }
    }
  }
  return rebuild(path, h, a, newSt(a.ep), [], want, until);
}
function rebuild(path: string, h: string, a: Acc, st: St, rows: OwnRow[], want: number[], until: number): Rows | null {
  const off0 = st.off; scan(path, h, a, st, a.off, rows, until);
  if (st.off < a.off && st.off > off0) { RB.set(path, { a, st, rows }); return null; } // no progress (the log shrank, a torn end): as far as it goes
  RB.delete(path);
  st.rows = rows.length;
  if (ensure()) {
    try { const t: string[] = []; for (const r of rows) t.push(rowLine(r) + "\n"); writeAtomic(rowsFile(path), t.join("")); writeAtomic(idsFile(path), idsOut(st)); writeAtomic(stFile(path), stOut(st)); } catch (e) { /* rebuilt next time */ }
  }
  return { rows, ok: same(st.sum, want), rebuilt: true };
}
// a log's owned messages ("u:" prompt ids aside) as hashes and order keys, read from the entry's stored text when it is
// still text (the ledger keeps it undecoded: decoding every log's ids would hold a Map per log for nothing). Cached per
// entry: an entry only grows (a re-read is a new entry), so a grown one hashes only its new ids (hashing 200 k ids
// costs a few hundred ms once)
export interface Hashes { hs: string[]; ks: number[] }
const HC = new Map<string, { a: Acc; t: boolean; len: number; n: number; x: Hashes }>();
type Push = (h: string, k: number) => void;
function owned(a: Acc, from: number, push: Push): number {
  let n = 0;
  if (a.mv) { // "<id>,<key delta> …" (owners.ts moOut)
    let prev = 0;
    for (const e of a.mv.split(" ")) {
      const i = e.indexOf(","); if (i <= 0) continue;
      const t = prev + Number(e.slice(i + 1)); if (!(t >= 0)) continue; prev = t;
      if (n++ < from) continue;
      const id = e.slice(0, i); if (!id.startsWith("u:")) push(msgHash(id), t);
    }
    return n;
  }
  for (const [id, key] of a.mo) { if (n++ < from) continue; if (!id.startsWith("u:")) push(msgHash(id), key); }
  return n;
}
export function ownHashes(path: string, a: Acc): Hashes {
  const hit = HC.get(path);
  if (hit && hit.a === a) {
    const x = hit.x; const push = (h: string, k: number): void => { x.hs.push(h); x.ks.push(k); };
    if (a.mv) { if (hit.t && hit.len === a.mv.length) return hit.x; }
    else if (a.mo.size === hit.n) return hit.x;
    else if (a.mo.size > hit.n) { hit.n = owned(a, hit.n, push); hit.t = false; hit.len = a.mo.size; return hit.x; } // grown: its new ids only
  }
  const x: Hashes = { hs: [], ks: [] }; const n = owned(a, 0, (h: string, k: number): void => { x.hs.push(h); x.ks.push(k); });
  HC.set(path, { a, t: !!a.mv, len: a.mv ? a.mv.length : a.mo.size, n, x }); // n: entries read (the text's are the Map's, in order)
  return x;
}
// the viewer's merge (fleet follow-ups): the same, each hash as an id (`id`: ownc.ts hashId; no hash string is kept: 200 k
// of them were ~15 MB), and in time slices: a log whose stored text is hashed from the start stops at `until` and returns
// null; the next call goes on (the text split once, kept until done). A cached or grown entry: at once
export interface Ids { hs: number[]; ks: number[] }
const IC = new Map<string, { a: Acc; t: boolean; len: number; n: number; x: Ids }>();
const IP = new Map<string, { a: Acc; t: boolean; len: number; es: string[]; i: number; prev: number; n: number; x: Ids }>(); // t: the stored text (else the decoded Map)
export function ownIdsBy(path: string, a: Acc, until: number, id: (h: string) => number): Ids | null {
  const hit = IC.get(path);
  if (hit && hit.a === a) {
    const x = hit.x; const push = (h: string, k: number): void => { x.hs.push(id(h)); x.ks.push(k); };
    if (a.mv) { if (hit.t && hit.len === a.mv.length) return x; }
    else if (a.mo.size === hit.n) return x;
    else if (a.mo.size > hit.n) { hit.n = owned(a, hit.n, push); hit.t = false; hit.len = a.mo.size; return x; } // grown: its new ids only
  }
  const t = !!a.mv; const len = t ? a.mv.length : a.mo.size;
  let p = IP.get(path);
  if (!p || p.a !== a || p.t !== t || p.len !== len) { p = { a, t, len, es: t ? a.mv.split(" ") : [], i: 0, prev: 0, n: 0, x: { hs: [], ks: [] } }; IP.set(path, p); }
  const i0 = p.i;
  if (t) {
    for (; p.i < p.es.length; p.i++) {
      if (p.i > i0 && (p.i & 255) === 0 && Date.now() >= until) return null; // after some progress
      const e = p.es[p.i] ?? ""; const i = e.indexOf(","); if (i <= 0) continue; // as owned() reads the text
      const k = p.prev + Number(e.slice(i + 1)); if (!(k >= 0)) continue; p.prev = k; p.n++;
      const m = e.slice(0, i); if (!m.startsWith("u:")) { p.x.hs.push(id(msgHash(m))); p.x.ks.push(k); }
    }
  } else { // a decoded entry (a live log): the Map in its order, the entries done so far skipped
    let i = 0;
    for (const [m, k] of a.mo) {
      if (i++ < p.i) continue;
      if (p.i > i0 && (p.i & 255) === 0 && Date.now() >= until) return null;
      p.i++; p.n++; if (!m.startsWith("u:")) { p.x.hs.push(id(msgHash(m))); p.x.ks.push(k); }
    }
  }
  IP.delete(path); IC.set(path, { a, t, len, n: p.n, x: p.x });
  return p.x;
}
// a log gone from the ledger: its ids go too
export function forgetIds(keep: (path: string) => boolean): void { for (const k of [...IC.keys()]) if (!keep(k)) IC.delete(k); for (const k of [...IP.keys()]) if (!keep(k)) IP.delete(k); }
// the same as ownership-only rows (the snapshot's own lines of sessions outside the window)
export function ownKeys(path: string, a: Acc): OwnRow[] {
  const x = ownHashes(path, a); const rows: OwnRow[] = [];
  for (let i = 0; i < x.hs.length; i++) rows.push({ h: x.hs[i] ?? "", key: x.ks[i] ?? 0, d: "", hr: 0, m: "", prov: "", n: [] });
  return rows;
}
