// agentglass — call rows stored as columns: one typed array per field, rows in call order (tui-footprint Decision 3)
// SPDX-License-Identifier: Apache-2.0
// A row is an index i into the columns of its session's Rows; readers get (s, r, i) and must not keep r or i past their
// callback (prune compacts the columns). The ids a row names (programs, command lines, files) live in one shared list
// li: row i's are li[lo[i] .. lo[i + 1]) (the last row's up to nl), each id * 4 + kind; later lines only ever add ids to
// the newest row, so the list stays in row order. ~70 B per row instead of ~735 B for an object with three arrays.
import type { Call } from "./facts.ts";

export const KIND_PROG = 0; export const KIND_CMD = 1; export const KIND_FILE = 2;
// a command line's family hint (wait/family.ts famHint: the text its family comes from when the stored line was cut at 200
// characters), right after that command's own id; read by the families alone
export const KIND_HINT = 3;
// t = call time (epoch ms); tool/model = DICT ids (-1 none); mq = MQ_*; ms = duration (-1 untimed); err = -1 no result yet,
// 0 ok, 1 failed; out = result bytes; cid = the harness call id ("" none). n rows, nl ids in use (capacity = array lengths)
export interface Rows {
  n: number; nl: number;
  t: Float64Array; tool: Float64Array; model: Float64Array; mq: Float64Array; ms: Float64Array; err: Float64Array; out: Float64Array;
  lo: Float64Array; li: Float64Array; cid: string[];
}
export function newRows(): Rows {
  return { n: 0, nl: 0, t: new Float64Array(0), tool: new Float64Array(0), model: new Float64Array(0), mq: new Float64Array(0), ms: new Float64Array(0),
    err: new Float64Array(0), out: new Float64Array(0), lo: new Float64Array(0), li: new Float64Array(0), cid: [] };
}
function grown(a: Float64Array, cap: number): Float64Array { const b = new Float64Array(cap); b.set(a.subarray(0, Math.min(a.length, cap))); return b; }
// room for n rows (exact when shrinking: a compacted or freshly decoded session holds no spare capacity)
function fit(r: Rows, cap: number): void {
  r.t = grown(r.t, cap); r.tool = grown(r.tool, cap); r.model = grown(r.model, cap); r.mq = grown(r.mq, cap); r.ms = grown(r.ms, cap);
  r.err = grown(r.err, cap); r.out = grown(r.out, cap); r.lo = grown(r.lo, cap);
}
// a new row (no result yet, no ids); returns its index
export function push(r: Rows, t: number, tool: number, model: number, mq: number): number {
  const i = r.n;
  if (i >= r.t.length) fit(r, Math.max(8, r.t.length * 2));
  r.t[i] = t; r.tool[i] = tool; r.model[i] = model; r.mq[i] = mq; r.ms[i] = -1; r.err[i] = -1; r.out[i] = 0; r.lo[i] = r.nl;
  r.cid.push(""); r.n = i + 1;
  return i;
}
function end(r: Rows, i: number): number { return i + 1 < r.n ? r.lo[i + 1] + 0 : r.nl; }
// one id for the newest row (any other row: ignored), once per kind
export function addId(r: Rows, i: number, kind: number, id: number): void {
  if (i < 0 || i !== r.n - 1 || id < 0) return;
  const v = id * 4 + kind;
  for (let k = r.lo[i] + 0; k < r.nl; k++) if (r.li[k] === v) return;
  if (r.nl >= r.li.length) r.li = grown(r.li, Math.max(8, r.li.length * 2));
  r.li[r.nl] = v; r.nl++;
}
// a command line for the newest row, with its family hint right after it (hint < 0: none); a command the row has already
// adds nothing (nor its hint)
export function addCmd(r: Rows, i: number, cmd: number, hint: number): void {
  if (i < 0 || i !== r.n - 1 || cmd < 0) return;
  const v = cmd * 4 + KIND_CMD;
  for (let k = r.lo[i] + 0; k < r.nl; k++) if (r.li[k] === v) return;
  if (r.nl + 2 > r.li.length) r.li = grown(r.li, Math.max(8, r.li.length * 2));
  r.li[r.nl] = v; r.nl++;
  if (hint >= 0) { r.li[r.nl] = hint * 4 + KIND_HINT; r.nl++; }
}
// row i's ids of one kind, in the order they were added (allocates; only for readers that ask)
export function rowIds(r: Rows, i: number, kind: number): number[] {
  const o: number[] = []; if (i < 0 || i >= r.n) return o;
  const e = end(r, i);
  for (let k = r.lo[i] + 0; k < e; k++) { const v = r.li[k] + 0; if (v % 4 === kind) o.push((v - kind) / 4); }
  return o;
}
export function hasIds(r: Rows, i: number, kind: number): boolean {
  if (i < 0 || i >= r.n) return false;
  const e = end(r, i);
  for (let k = r.lo[i] + 0; k < e; k++) if ((r.li[k] + 0) % 4 === kind) return true;
  return false;
}
// keep the rows keep(i) says, in order; returns old index → new index (-1 = dropped). Capacity shrinks to the rows kept.
export function compact(r: Rows, keep: (i: number) => boolean): number[] {
  const map: number[] = []; let w = 0; let wl = 0;
  for (let i = 0; i < r.n; i++) {
    if (!keep(i)) { map.push(-1); continue; }
    const s = r.lo[i] + 0; const e = end(r, i);
    r.t[w] = r.t[i]; r.tool[w] = r.tool[i]; r.model[w] = r.model[i]; r.mq[w] = r.mq[i]; r.ms[w] = r.ms[i]; r.err[w] = r.err[i]; r.out[w] = r.out[i];
    r.cid[w] = r.cid[i] ?? ""; r.lo[w] = wl;
    for (let k = s; k < e; k++) { r.li[wl] = r.li[k]; wl++; }
    map.push(w); w++;
  }
  r.n = w; r.nl = wl; r.cid.length = w;
  fit(r, w); r.li = grown(r.li, wl);
  return map;
}
// exactly n rows and nl ids of room, n = nl = 0 in use: a decoder fills the columns and sets n / nl
export function sized(n: number, nl: number): Rows {
  const r = newRows(); fit(r, n); r.li = new Float64Array(nl); return r;
}
// one row as a plain value (allocates: checks and fixtures)
export function callAt(r: Rows, i: number): Call {
  return { t: r.t[i] + 0, tool: r.tool[i] + 0, model: r.model[i] + 0, mq: r.mq[i] + 0, progs: rowIds(r, i, KIND_PROG), cmds: rowIds(r, i, KIND_CMD), files: rowIds(r, i, KIND_FILE),
    ms: r.ms[i] + 0, err: r.err[i] + 0, out: r.out[i] + 0, cid: r.cid[i] ?? "" };
}
export function callList(r: Rows): Call[] { const o: Call[] = []; for (let i = 0; i < r.n; i++) o.push(callAt(r, i)); return o; }
// rows from plain values (checks and fixtures)
export function rowsFrom(cs: Call[]): Rows {
  const r = newRows();
  for (const c of cs) {
    const i = push(r, c.t, c.tool, c.model, c.mq); r.ms[i] = c.ms; r.err[i] = c.err; r.out[i] = c.out; r.cid[i] = c.cid;
    for (const x of c.progs) addId(r, i, KIND_PROG, x); for (const x of c.cmds) addId(r, i, KIND_CMD, x); for (const x of c.files) addId(r, i, KIND_FILE, x);
  }
  return r;
}
