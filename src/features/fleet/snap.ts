// agentglass — the snapshot line format `agentglass-snapshot/v1` (fleet spec 12): what `fleet snapshot` prints and `fleet
// drop` writes, the incremental parser and how a snapshot applies to the report a viewer holds. Pure: no I/O
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { type Acc, peekHeavy, mkey } from "../usage/record.ts";
import { type DayRow, type Hello, type HostReport, type OwnRow, type Owned, type SessRow, ownSess } from "./model.ts";
import { helloOf } from "./report.ts";

export const SNAP = "agentglass-snapshot/v1";
export interface OwnLine { key: string; reset: boolean; rows: OwnRow[] }
// head: the hello fields; gen: this snapshot's generation; base: the one it is relative to ("" = full)
export interface Snap { head: Obj; gen: string; base: string; full: boolean; sess: SessRow[]; own: OwnLine[]; gone: string[]; cost: Obj | null; allowance: Obj | null; done: boolean; err: string }
export function newSnap(): Snap { return { head: {}, gen: "", base: "", full: false, sess: [], own: [], gone: [], cost: null, allowance: null, done: false, err: "" }; }
export function newSnapParse(): Snap { return newSnap(); }
function num(v: unknown): number { return typeof v === "number" ? v as number : 0; }
function strs(v: unknown): string[] { const o: string[] = []; for (const x of arr(v)) o.push(typeof x === "string" ? x as string : typeof x === "number" ? String(x) : ""); return o; }
function rows2(v: unknown): string[][] { const o: string[][] = []; for (const x of arr(v)) o.push(strs(x)); return o; }

// ── rows on the wire: an own row is an array [h, key, d, hr, m, prov, in, out, cr, w5, w1, usd, priced] (ownership-only:
// [h, key]); a day is an object with the DayRow fields ──
export function ownOut(r: OwnRow): unknown[] {
  if (!r.n.length) return [r.h, r.key];
  const o: unknown[] = [r.h, r.key, r.d, r.hr, r.m, r.prov]; for (const x of r.n) o.push(x); return o;
}
export function ownIn(v: unknown): OwnRow | null {
  const a = arr(v); if (a.length !== 2 && a.length !== 13) return null;
  const h = a[0]; const key = a[1];
  if (typeof h !== "string" || typeof key !== "number" || !/^[0-9a-f]{16}$/.test(h as string)) return null;
  if (a.length === 2) return { h: h as string, key: key as number, d: "", hr: 0, m: "", prov: "", n: [] };
  const n: number[] = []; for (let i = 6; i < 13; i++) { const x = a[i]; if (typeof x !== "number") return null; n.push(x as number); }
  const hr = num(a[3]); if (!(hr >= 0 && hr < 24)) return null;
  return { h: h as string, key: key as number, d: str(a[2]), hr, m: str(a[4]), prov: str(a[5]), n };
}
function dayOut(d: DayRow): Obj { return { d: d.d, tp: d.tp, hx: d.hx, unk: d.unk, um: d.um, uc: d.uc, tools: d.tools, turns: d.turns, calls: d.calls, errors: d.errors }; }
function dayIn(o: Obj): DayRow { return { d: str(o["d"]), tp: rows2(o["tp"]), hx: rows2(o["hx"]), unk: num(o["unk"]), um: rows2(o["um"]), uc: num(o["uc"]), tools: num(o["tools"]), turns: num(o["turns"]), calls: num(o["calls"]), errors: num(o["errors"]) }; }
function sessOut(r: SessRow): Obj { const ds: Obj[] = []; for (const d of r.days ?? []) ds.push(dayOut(d)); return { key: r.key, s: r.s, days: ds, prov: r.prov }; }
function sessIn(o: Obj): SessRow | null {
  const s = obj(o["s"]); const key = str(o["key"]); if (!s || !key) return null;
  const days: DayRow[] = []; for (const x of arr(o["days"])) { const d = obj(x); if (d) days.push(dayIn(d)); }
  return { s, key, days, own: null, prov: rows2(o["prov"]) };
}

export function snapLines(x: Snap): string[] {
  const head: Obj = {}; for (const k of Object.keys(x.head)) head[k] = x.head[k];
  head["format"] = SNAP; head["gen"] = x.gen; head["base"] = x.base; head["full"] = x.full;
  const out: string[] = [JSON.stringify({ snap: head })];
  for (const s of x.sess) out.push(JSON.stringify({ sess: sessOut(s) }));
  for (const o of x.own) { const rs: unknown[] = []; for (const r of o.rows) rs.push(ownOut(r)); const ln: Obj = { key: o.key, reset: o.reset, rows: rs }; out.push(JSON.stringify({ own: ln })); }
  if (x.gone.length) out.push(JSON.stringify({ gone: x.gone }));
  out.push(JSON.stringify({ cost: x.cost })); out.push(JSON.stringify({ allowance: x.allowance }));
  out.push(JSON.stringify({ end: { gen: x.gen, sessions: x.sess.length, own: x.own.length } }));
  return out;
}
// "agentglass-snapshot/v1" → 1; another family → -1
function major(f: string): number { const m = /^agentglass-snapshot\/v(\d+)$/.exec(f); return m ? Number(m[1] ?? "") : -1; }
const HEX16 = /^[0-9a-f]{16}$/;
// feeds lines in order (any chunking); after an error or the end line nothing more is taken
export function feedSnap(p: Snap, lines: string[]): void {
  for (const l of lines) {
    if (p.err || p.done) return;
    if (!l.trim()) continue;
    let o: Obj | null = null; try { const v: unknown = JSON.parse(l); o = obj(v); } catch (e) { o = null; }
    if (!o) continue; // text a remote shell rc printed first; a garbled line inside is caught by the end counts
    if (!p.gen) {
      const h = obj(o["snap"]); if (!h) { p.err = "not a fleet snapshot"; return; }
      const mj = major(str(h["format"]));
      if (mj < 0) { p.err = "not a fleet snapshot"; return; }
      if (mj !== 1) { p.err = "newer format " + str(h["format"]); return; }
      const g = str(h["gen"]); const b = str(h["base"]);
      if (!HEX16.test(g) || (b !== "" && !HEX16.test(b))) { p.err = "bad generation"; return; }
      p.head = h; p.gen = g; p.base = b; p.full = h["full"] === true || b === ""; continue;
    }
    const s = obj(o["sess"]); if (s) { const r = sessIn(s); if (r) p.sess.push(r); else p.err = "bad session line"; continue; }
    const w = obj(o["own"]);
    if (w) {
      const rows: OwnRow[] = [];
      for (const x of arr(w["rows"])) { const r = ownIn(x); if (!r) { p.err = "bad own row"; return; } rows.push(r); }
      p.own.push({ key: str(w["key"]), reset: w["reset"] === true, rows }); continue;
    }
    if (o["gone"] !== undefined) { for (const k of strs(o["gone"])) p.gone.push(k); continue; }
    if (o["cost"] !== undefined) { p.cost = obj(o["cost"]); continue; }
    if (o["allowance"] !== undefined) { p.allowance = obj(o["allowance"]); continue; }
    const e = obj(o["end"]);
    if (e) { if (str(e["gen"]) === p.gen && num(e["sessions"]) === p.sess.length && num(e["own"]) === p.own.length) p.done = true; else p.err = "incomplete snapshot"; continue; }
  }
}
export function helloOfSnap(x: Snap): Hello { return helloOf(x.head); }

// a finished snapshot onto the report a viewer holds (null = none yet). full → replaces everything; a delta replaces the
// sessions it carries, drops the `gone` sessions, appends or resets own rows (a reset without rows drops the key). The caller checks x.base against what it applied
// last: a delta on another base must not apply (feed and dir reader do). The result is a new report (the old one stays
// valid for whoever holds it); its `owned` map is shared with nobody
export function applySnap(cur: HostReport | null, x: Snap): HostReport {
  const own = new Map<string, OwnRow[]>();
  const keep = new Map<string, SessRow>(); const order: string[] = [];
  if (!x.full && cur) {
    for (const o of cur.owned) own.set(o.key, o.rows);
    for (const s of cur.sessions) { keep.set(s.key, s); order.push(s.key); }
  }
  for (const k of x.gone) keep.delete(k);
  for (const s of x.sess) { if (!keep.has(s.key)) order.push(s.key); keep.set(s.key, s); }
  for (const o of x.own) {
    const old = own.get(o.key);
    if (o.reset && !o.rows.length) own.delete(o.key); // the key owns nothing any more
    else own.set(o.key, o.reset || !old ? o.rows : old.concat(o.rows));
  }
  const bySess = new Map<string, OwnRow[]>();
  for (const [k, v] of own) { const sk = ownSess(k); const o = bySess.get(sk); bySess.set(sk, o ? o.concat(v) : v); }
  const sessions: SessRow[] = [];
  for (const k of order) { const s = keep.get(k); if (!s) continue; sessions.push({ s: s.s, key: s.key, days: s.days, own: bySess.get(k) ?? [], prov: s.prov }); keep.delete(k); }
  sessions.sort((a: SessRow, b: SessRow) => { const ua = str(a.s["updated"]); const ub = str(b.s["updated"]); return ua < ub ? 1 : ua > ub ? -1 : 0; });
  const owned: Owned[] = []; for (const [k, v] of own) owned.push({ key: k, rows: v });
  return { hello: helloOf(x.head), sessions, cost: x.cost, allowance: x.allowance, live: cur && !x.full ? cur.live : null, exact: true, owned };
}
// the report as one full snapshot (the viewer's persisted state, the drop writer's base)
export function fullOf(r: HostReport, gen: string): Snap {
  const own: OwnLine[] = [];
  for (const o of r.owned) own.push({ key: o.key, reset: true, rows: o.rows });
  const head: Obj = { version: r.hello.version, hostId: r.hello.hostId, hostName: r.hello.hostName, os: r.hello.os, tzOffsetMin: r.hello.tzOffsetMin, redact: r.hello.redact, days: r.hello.days, now: r.hello.now, priceSig: r.hello.priceSig };
  const sess: SessRow[] = []; for (const s of r.sessions) sess.push({ s: s.s, key: s.key, days: s.days, own: null, prov: s.prov });
  return { head, gen, base: "", full: true, sess, own, gone: [], cost: r.cost, allowance: r.allowance, done: true, err: "" };
}

// ── a session's days (spec 12.2): its own Acc and its subagents' folded into one DayRow per day of `days` ──
function add(m: Map<string, number>, k: string, v: number): void { m.set(k, (m.get(k) ?? 0) + v); }
const R6 = (x: number): number => Math.round(x * 1e9) / 1e9; // sums of many bookings: no float dust on the wire
export function dayRows(accs: Acc[], days: Set<string>): DayRow[] {
  const out: DayRow[] = []; const keys: string[] = [];
  for (const a of accs) for (const k of a.days.keys()) if (days.has(k) && keys.indexOf(k) < 0) keys.push(k);
  keys.sort();
  for (const k of keys) {
    const tp = new Map<string, number[]>(); const hxP = new Map<string, number>(); const hxH: number[] = []; for (let i = 0; i < 24; i++) hxH.push(0);
    const um = new Map<string, number>(); let unk = 0; let uc = 0; let tools = 0; let turns = 0; let calls = 0; let errors = 0;
    for (const a of accs) {
      const d = a.days.get(k); if (!d) continue;
      const tpP = new Map<string, number>(); const tpH: number[] = []; for (let i = 0; i < 24; i++) tpH.push(0);
      const tpU = new Map<string, number>(); let tpUnk = 0;
      for (const [rk, r] of d.tp) {
        const x0 = tp.get(rk); const x = x0 ? x0 : [0, 0, 0, 0, 0, (r[5] ?? 0) < 0 ? -1 : 0]; if (!x0) tp.set(rk, x);
        for (let i = 0; i < 5; i++) x[i] = (x[i] ?? 0) + (r[i] ?? 0);
        const usd = r[5] ?? 0; const t1 = rk.indexOf("\t"); const t2 = rk.indexOf("\t", t1 + 1);
        const hr = Number(rk.slice(0, t1)); const prov = rk.slice(t1 + 1, t2); const model = rk.slice(t2 + 1);
        if (usd >= 0) { if ((x[5] ?? 0) >= 0) x[5] = (x[5] ?? 0) + usd; add(tpP, prov, usd); if (hr >= 0 && hr < 24) tpH[hr] = (tpH[hr] ?? 0) + usd; }
        else if (usd > -1.5) { const n = (r[0] ?? 0) + (r[1] ?? 0) + (r[2] ?? 0) + (r[3] ?? 0) + (r[4] ?? 0); tpUnk += n; add(tpU, mkey(model), n); }
      }
      // what the day's totals hold beyond its table-priced rows: harness-reported cost (per provider and per hour; split
      // over both in proportion: exact per provider and per hour) and unpriced tokens outside tp
      const ph = new Map<string, number>(); let pt = 0;
      for (const [p, c] of d.cp) { const v = c - (tpP.get(p) ?? 0); if (v > 1e-12) { ph.set(p, v); pt += v; } }
      const hh: number[] = []; let ht = 0; for (let h = 0; h < 24; h++) { const v = (d.hc[h] ?? 0) - (tpH[h] ?? 0); hh.push(v > 1e-12 ? v : 0); ht += v > 1e-12 ? v : 0; }
      if (pt > 0) {
        for (const [p, v] of ph) { if (ht > 0) { for (let h = 0; h < 24; h++) if ((hh[h] ?? 0) > 0) add(hxP, String(h) + "\t" + p, v * (hh[h] ?? 0) / ht); } else add(hxP, "0\t" + p, v); }
      }
      for (const [m, n] of d.um) { const v = n - (tpU.get(m) ?? 0); if (v > 0) add(um, m, v); }
      unk += Math.max(0, d.unk - tpUnk); uc += d.uc; tools += d.tools; turns += d.turns;
      for (const st of peekHeavy(d).tt.values()) { calls += st.n; errors += st.err; }
    }
    const tpo: string[][] = [];
    for (const [rk, x] of tp) { const p = rk.split("\t"); tpo.push([p[0] ?? "0", p[1] ?? "", p.slice(2).join("\t"), String(x[0] ?? 0), String(x[1] ?? 0), String(x[2] ?? 0), String(x[3] ?? 0), String(x[4] ?? 0), String((x[5] ?? 0) < 0 ? -1 : R6(x[5] ?? 0))]); }
    const hxo: string[][] = []; for (const [hk, v] of hxP) { const t = hk.indexOf("\t"); hxo.push([hk.slice(0, t), hk.slice(t + 1), String(R6(v))]); }
    const umo: string[][] = []; for (const [m, n] of um) umo.push([m, String(n)]);
    out.push({ d: k, tp: tpo, hx: hxo, unk, um: umo, uc, tools, turns, calls, errors });
  }
  return out;
}
