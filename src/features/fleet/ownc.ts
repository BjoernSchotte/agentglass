// agentglass — owned Claude message rows in columns (fleet follow-ups): how a viewer holds every host's own rows. A row
// as an object (its strings, its number array) costs ~550 bytes; in columns ~85. A message's hash is an id into one table
// of 64-bit values (two int32 halves, open addressing): a message copied to several hosts and this machine is held once.
// SPDX-License-Identifier: Apache-2.0
import type { OwnRow } from "./model.ts";

// ── hashes: 16 hex digits ↔ a dense id (ids only grow: a long run holds every hash it has seen, ~16 bytes each) ──
const HT = { n: 0, slot: new Int32Array(0), hi: new Int32Array(0), lo: new Int32Array(0) }; // slot: id + 1, 0 = empty
const HEX16 = /^[0-9a-f]{16}$/;
function half(h: string, at: number): number { return parseInt(h.slice(at, at + 8), 16) | 0; }
function slotOf(lo: number, cap: number): number { return (lo >>> 0) % cap; } // the hashes are SHA-256 bits: uniform already
function grow(): void {
  const cap = Math.max(1024, HT.slot.length * 2); const s = new Int32Array(cap);
  for (let id = 0; id < HT.n; id++) { let j = slotOf(HT.lo[id] ?? 0, cap); while ((s[j] ?? 0) !== 0) j = j + 1 === cap ? 0 : j + 1; s[j] = id + 1; }
  HT.slot = s;
  if (HT.hi.length < cap / 2) { const hi = new Int32Array(cap / 2); const lo = new Int32Array(cap / 2); for (let i = 0; i < HT.n; i++) { hi[i] = HT.hi[i] ?? 0; lo[i] = HT.lo[i] ?? 0; } HT.hi = hi; HT.lo = lo; }
}
function find(hi: number, lo: number, add: boolean): number {
  if (!HT.slot.length) { if (!add) return -1; grow(); } else if (add && (HT.n + 1) * 2 > HT.slot.length) grow();
  const cap = HT.slot.length; let j = slotOf(lo, cap);
  for (;;) {
    const v = HT.slot[j] ?? 0;
    if (v === 0) break;
    if ((HT.hi[v - 1] ?? 0) === hi && (HT.lo[v - 1] ?? 0) === lo) return v - 1;
    j = j + 1 === cap ? 0 : j + 1;
  }
  if (!add) return -1;
  const id = HT.n; HT.n = id + 1; HT.hi[id] = hi; HT.lo[id] = lo; HT.slot[j] = id + 1;
  return id;
}
// the id of a hash, added when new; -1 = not a hash (a message without an id: never matched across hosts)
export function hashId(h: string): number { return HEX16.test(h) ? find(half(h, 0), half(h, 8), true) : -1; }
// the id of a hash some row already holds; -1 = none does
export function hashFind(h: string): number { return HEX16.test(h) ? find(half(h, 0), half(h, 8), false) : -1; }
const HEX = "0123456789abcdef";
function hex8(v: number): string { let s = ""; for (let sh = 28; sh >= 0; sh -= 4) s += HEX[(v >>> sh) & 15] ?? "0"; return s; }
export function hashHex(id: number): string { const j = Number(id); return j >= 0 && j < HT.n ? hex8(HT.hi[j] ?? 0) + hex8(HT.lo[j] ?? 0) : ""; }
export function hashCount(): number { return HT.n; }

// ── words: days, models, providers (a few hundred distinct) ──
const WI = new Map<string, number>(); const WS: string[] = [];
export function wordId(s: string): number { const v = WI.get(s); if (v !== undefined) return v; WI.set(s, WS.length); WS.push(s); return WS.length - 1; }
export function word(i: number): string { return WS[i] ?? ""; }

// ── a chunk: rows in columns. u: a row's usage slot (-1 = an ownership-only row: hash and order key, no usage; ~40 % of
// a mirrored history), d/hr/m/p/v by slot: day, hour, model and provider ids, 7 numbers ([in, out, cacheRead, write5m,
// write1h, usd, tablePriced], OwnRow.n) ──
export interface OwnChunk { n: number; h: Int32Array; k: Float64Array; u: Int32Array; d: Int32Array; hr: Uint8Array; m: Int32Array; p: Int32Array; v: Float64Array }
// n rows, nu of them with usage
export function newChunk(n: number, nu: number): OwnChunk { return { n, h: new Int32Array(n), k: new Float64Array(n), u: new Int32Array(n), d: new Int32Array(nu), hr: new Uint8Array(nu), m: new Int32Array(nu), p: new Int32Array(nu), v: new Float64Array(nu * 7) }; }
export const NO_ROWS: OwnChunk = newChunk(0, 0);
// row i of c from r (its hash interned); slot: its usage slot when it has usage (the caller counts them)
export function putRow(c: OwnChunk, i: number, r: OwnRow, slot: number): void {
  c.h[i] = hashId(r.h); c.k[i] = r.key;
  if (!r.n.length) { c.u[i] = -1; return; }
  c.u[i] = slot; c.d[slot] = wordId(r.d); c.hr[slot] = r.hr; c.m[slot] = wordId(r.m); c.p[slot] = wordId(r.prov);
  for (let q = 0; q < 7; q++) c.v[slot * 7 + q] = r.n[q] ?? 0;
}
export function chunkOf(rows: OwnRow[]): OwnChunk {
  if (!rows.length) return NO_ROWS;
  let nu = 0; for (const r of rows) if (r.n.length) nu++;
  const c = newChunk(rows.length, nu); let slot = 0;
  for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (!r) continue; putRow(c, i, r, slot); if (r.n.length) slot++; }
  return c;
}
// row i into r (a scratch row a reader does not keep: its number array is reused); hash = false leaves r.h (a reader that
// needs only the usage: 16 hex digits less to build per row)
export function fillRow(c: OwnChunk, i: number, r: OwnRow, hash = true): void {
  if (hash) r.h = hashHex(c.h[i] ?? -1);
  r.key = c.k[i] ?? 0;
  const u = Number(c.u[i] ?? -1);
  if (u < 0) { r.d = ""; r.hr = 0; r.m = ""; r.prov = ""; r.n = []; return; }
  r.d = word(c.d[u] ?? 0); r.hr = c.hr[u] ?? 0; r.m = word(c.m[u] ?? 0); r.prov = word(c.p[u] ?? 0);
  if (r.n.length !== 7) r.n = [0, 0, 0, 0, 0, 0, 0];
  for (let q = 0; q < 7; q++) r.n[q] = c.v[u * 7 + q] ?? 0;
}
export function rowAt(c: OwnChunk, i: number): OwnRow { const r: OwnRow = { h: "", key: 0, d: "", hr: 0, m: "", prov: "", n: [] }; fillRow(c, i, r); return r; }
// chunks as one (a full snapshot carries one line per part)
export function joinChunks(cs: OwnChunk[]): OwnChunk {
  if (cs.length === 1) return cs[0] ?? NO_ROWS;
  let n = 0; let nu = 0; for (const c of cs) { n += c.n; nu += c.d.length; } if (!n) return NO_ROWS;
  const o = newChunk(n, nu); let j = 0; let s0 = 0;
  for (const c of cs) {
    for (let i = 0; i < c.n; i++) { o.h[j] = c.h[i] ?? -1; o.k[j] = c.k[i] ?? 0; const u = Number(c.u[i] ?? -1); o.u[j] = u < 0 ? -1 : u + s0; j++; }
    for (let u = 0; u < c.d.length; u++) { o.d[s0 + u] = c.d[u] ?? 0; o.hr[s0 + u] = c.hr[u] ?? 0; o.m[s0 + u] = c.m[u] ?? 0; o.p[s0 + u] = c.p[u] ?? 0; for (let q = 0; q < 7; q++) o.v[(s0 + u) * 7 + q] = c.v[u * 7 + q] ?? 0; }
    s0 += c.d.length;
  }
  return o;
}
export function rowsOfChunk(c: OwnChunk): OwnRow[] { const o: OwnRow[] = []; for (let i = 0; i < c.n; i++) o.push(rowAt(c, i)); return o; }
export function rowsOfChunks(cs: OwnChunk[]): OwnRow[] { let o: OwnRow[] = []; for (const c of cs) o = o.concat(rowsOfChunk(c)); return o; }
export function lenOf(cs: OwnChunk[]): number { let n = 0; for (const c of cs) n += c.n; return n; }
