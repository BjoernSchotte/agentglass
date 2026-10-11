// agentglass — the sessions read model (local-web-api §2): pure functions from the engine's state to contract objects.
// readSessions = the --json rows (read/row.ts) as cursor pages; readSession = `session <ref>`. Both read what the engine
// holds (discover() and the cadence are the caller's); privacy (--redact, skills.hide) applies as in the CLI.
// SPDX-License-Identifier: Apache-2.0
import { type Obj } from "../util/json.ts";
import type { Sess } from "../model/types.ts";
import { filterOf } from "../features/query/cli.ts";
import { findSession } from "../model/sessref.ts";
import { sessionObj, kidsOf } from "../features/queries.ts";
import { copiesOf, ledger } from "../features/usage/ledger.ts";
import { pickSessions, rowsOf } from "./row.ts";
import { gen } from "./meta.ts";

// one page of a list: next = the cursor of the following page (opaque), null on the last
export interface Page { data: Obj[]; at: number; gen: number; next: string | null }
// an error the protocol answers with (code: bad_filter | bad_param | not_found | ambiguous | no_team …)
export interface Err { code: string; msg: string; hint: string }
export interface SessQ { filter: string; limit: number; cursor: string; subagents: boolean; team: string; room: string }
export interface SessR { page: Page | null; err: Err | null }
export interface OneR { data: Obj | null; err: Err | null }
function fail(code: string, msg: string, hint: string): SessR { return { page: null, err: { code, msg, hint } }; }

// the cursor names the last row shown: "c1:<mtime>:<harness>:<id>"; the next page starts after that row, or (the row is
// gone) after its time
function cursorOf(s: Sess): string { return "c1:" + String(s.mtime) + ":" + s.h + ":" + s.id; }
function startOf(list: Sess[], cur: string): number {
  if (!cur) return 0;
  const m = /^c1:(\d+(?:\.\d+)?):(.+)$/.exec(cur); if (!m) return -1;
  const t = Number(m[1] ?? ""); const key = m[2] ?? "";
  for (let i = 0; i < list.length; i++) { const s = list[i] as Sess; if (s.h + ":" + s.id === key && s.mtime === t) return i + 1; }
  for (let i = 0; i < list.length; i++) if ((list[i] as Sess).mtime < t) return i;
  return list.length;
}
// limit 0 = every row (the CLI); the protocol caps it
export function readSessions(p: SessQ): SessR {
  if (p.team || p.room) return fail("no_team", "no team on this machine", "agentglass team join <invite> (fleet-teams)");
  const fr = filterOf(p.filter ? [p.filter] : [], "", false, false, false);
  const cf = fr.cf;
  if (!cf) {
    const e = fr.err; const col = e ? e.col : 0;
    return fail("bad_filter", "filter: " + (e ? e.msg : "invalid filter") + " at column " + String(col + 1), fr.src ? fr.src + "\n" + " ".repeat(Math.max(0, col)) + "^" : "");
  }
  const list = pickSessions(cf, p.subagents, (s: Sess): boolean => true);
  const from = startOf(list, p.cursor);
  if (from < 0) return fail("bad_param", "cursor is not one this server issued", "start again without a cursor");
  const to = p.limit > 0 ? Math.min(list.length, from + p.limit) : list.length;
  const sel = list.slice(from, to);
  const last = sel.length ? sel[sel.length - 1] ?? null : null;
  return { page: { data: rowsOf(sel, false, false), at: Date.now(), gen: gen("sessions"), next: to < list.length && last ? cursorOf(last) : null }, err: null };
}
// one session in full; ref = <harness>:<id>, an id, or a unique prefix (no current/last: they mean the caller's cwd)
// fast: sessionObj's index-only answer; the full one is kept per session until its logs or the index move (MEMO), so
// opening it again is instant
const MEMO = new Map<string, { sig: string; o: Obj }>(); const MEMO_MAX = 16;
// this session's own state: its copies' and subagents' sizes and how far the index booked them (not the global
// generation, which moves with every other session while the history indexes)
function part(x: Sess): string { const a = ledger.get(x.path); return String(x.size) + ":" + (a && a.off >= x.size ? "i" : "-") + ":" + String(x.pid); } // size, indexed to its end, live
function sigOf(s: Sess): string { let k = ""; for (const c of copiesOf(s)) { k += "|" + part(c); for (const x of kidsOf(c)) k += "," + part(x); } return k; }
export function readSession(ref: string, fast = false): OneR {
  const f = findSession(ref, (s: Sess): boolean => true);
  const s = f.s;
  if (!s) return { data: null, err: { code: f.code === 4 ? "ambiguous" : f.code === 2 ? "bad_param" : "not_found", msg: f.msg, hint: f.hint } };
  if (fast) { const o = sessionObj(s, true); o["via"] = "ref"; o["detail"] = "fast"; return { data: o, err: null }; }
  const m = memoOf(s); if (m) return { data: m, err: null };
  const o = sessionObj(s); o["via"] = "ref"; // as session <ref> prints it
  memoPut(s, o);
  return { data: o, err: null };
}
// the full detail of s when it is kept and still current
export function memoOf(s: Sess): Obj | null { const m = MEMO.get(s.path); return m && m.sig === sigOf(s) ? m.o : null; }
// the last full detail of s even when it moved since (a live session grows each turn): stale-while-revalidate
export function memoAny(s: Sess): Obj | null { const m = MEMO.get(s.path); return m ? m.o : null; }
export function memoPut(s: Sess, o: Obj): void {
  MEMO.delete(s.path); MEMO.set(s.path, { sig: sigOf(s), o });
  if (MEMO.size > MEMO_MAX) for (const k of MEMO.keys()) { MEMO.delete(k); break; } // the oldest (insertion order)
}
// bytes the full detail reads: the session's logs (its copies and subagents)
export function detailBytes(s: Sess): number { let n = 0; for (const c of copiesOf(s)) { n += c.size; for (const x of kidsOf(c)) n += x.size; } return n; }
