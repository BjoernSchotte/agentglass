// agentglass — per-call fact rows: compact call records with dictionary-encoded strings, shared by filters, triage, compare
// SPDX-License-Identifier: Apache-2.0
export const MQ_MSG = 0; export const MQ_TURN = 1; export const MQ_SESS = 2; // model exact per message | per turn | per session
// one tool call. String columns are ids into DICT; -1 = none/unknown. t = call time (epoch ms, never 0: falls back to the bucket's time).
// ms -1 = untimed; err -1 = no result seen yet, 0 ok, 1 failed; out = result bytes; cid = the harness call id ("" none)
export interface Call { t: number; tool: number; model: number; mq: number; progs: number[]; cmds: number[]; files: number[]; ms: number; err: number; out: number; cid: string }
export interface Dict { ids: Map<string, number>; names: string[] }
function newDict(): Dict { return { ids: new Map<string, number>(), names: [] }; }
// ledger-wide: ids are only meaningful in memory (calls files keep their own local dictionaries)
export const DICT = { tool: newDict(), model: newDict(), prog: newDict(), cmd: newDict(), file: newDict() };
export function intern(d: Dict, s: string): number {
  if (!s) return -1;
  const i = d.ids.get(s); if (i !== undefined) return i;
  d.names.push(s); d.ids.set(s, d.names.length - 1);
  return d.names.length - 1;
}
export function nameOf(d: Dict, i: number): string { const ns: string[] = d.names; if (i < 0 || i >= ns.length) return ""; return ns[i]; }
// lowercased extension without the dot; "" for none and for dotfiles (".bashrc")
export function extOf(p: string): string { const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); return i > 0 && i < b.length - 1 ? b.slice(i + 1).toLowerCase() : ""; }

function two(n: number): string { return (n < 10 ? "0" : "") + n; }
export function dayKey(d: Date): string { return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()); }
export interface Local { day: string; hour: number; wd: number /* 0 = Sunday, Date.getDay() */ }
// local day/hour only change on half-hour boundaries in every real time zone (some have :30 offsets): memoize per half hour
const memo = new Map<number, Local>();
export function localOf(t: number): Local {
  const k = Math.floor(t / 1800000); const hit = memo.get(k); if (hit) return hit;
  const d = new Date(k * 1800000); const v = { day: dayKey(d), hour: d.getHours(), wd: d.getDay() };
  if (memo.size > 20000) memo.clear();
  memo.set(k, v); return v;
}
