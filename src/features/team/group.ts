// agentglass — team groupings, the team filter and room budgets (fleet-teams spec 10–11; Task 9b), one function each,
// shared by the Team tab, `agentglass team report|sessions` and serve's team.* methods (one builder, same numbers).
// groupRows: by member (every member, with presence), device, harness, repo, room, skill or model; a session in two
// rooms or with two skills counts in each of its groups. teamFilter: the filter language over a teammate's shared row
// (the keys the row carries; member and room resolve names). budgets: a room's month spend against its budget,
// projected linearly over the month.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, arr, str } from "../../util/json.ts";
import type { Sess } from "../../model/types.ts";
import type { Val } from "../query/types.ts";
import { parse } from "../query/parse.ts";
import { register } from "../query/attrs.ts";
import { extend, clauseMatcher } from "../query/eval.ts";
import { stateOf } from "../usage/costs.ts";
import { type TeamState } from "./state.ts";
import { type TeamView, type TeamRow, type Cost, rowsCost } from "./view.ts";

export const GROUPS = ["member", "harness", "repo", "room", "skill", "model"]; // the Team tab's b cycle
export const BYS = ["member", "device", "harness", "repo", "room", "skill", "model"]; // team report --by
export const PERIODS = ["d", "w", "m", "a"];
export interface GRow {
  key: string; label: string; me: boolean; online: number; devices: number; live: number; attention: number; stuck: number; at: number;
  cost: Cost; period: number; commits: number; tokens: number; unpriced: number; top: string; share: number; second: string;
  skills: string[]; harnesses: string[]; sessions: number; rows: TeamRow[];
}
// names the rows refer to by id: members and rooms
export interface TCtx { names: Map<string, string>; rooms: Map<string, string>; me: string }
export function ctxOf(t: TeamState | null, v: TeamView): TCtx {
  const cx: TCtx = { names: new Map<string, string>(), rooms: new Map<string, string>(), me: t ? t.me.id : "" };
  for (const m of v.members) { cx.names.set(m.id, m.name || m.id.slice(0, 8)); if (m.mine) cx.me = m.id; }
  if (t && t.priv) for (const r of t.priv.rooms) cx.rooms.set(r.id, r.name);
  return cx;
}
export function periodCost(c: Cost, period: string): number { return period === "d" ? c.today : period === "w" ? c.week : period === "m" ? c.month : c.all; }
function n0(v: unknown): number { return typeof v === "number" && isFinite(v) ? v : 0; }
function models(s: Obj): string[] { const m = s["model"]; if (typeof m === "string") return m ? [m] : []; const o: string[] = []; for (const x of arr(m)) if (typeof x === "string" && x) o.push(x); return o; }
function skillNames(s: Obj): string[] { const o: string[] = []; for (const x of arr(s["skills"])) { const e = obj(x); const n = e ? str(e["name"]) : ""; if (n && o.indexOf(n) < 0) o.push(n); } return o; }
function repoOf(s: Obj): { key: string; label: string } { const r = obj(s["repo"]); return { key: r ? str(r["key"]) : "", label: r ? str(r["label"]) || str(r["key"]) : "" }; }
function tokensOf(s: Obj): number { const t = obj(s["tokens"]); return t ? n0(t["in"]) + n0(t["out"]) + n0(t["cacheRead"]) + n0(t["cacheWrite"]) : 0; }
// the group keys of one row
function keysOf(by: string, r: TeamRow): string[] {
  const s = r.s;
  if (by === "member") return [r.member];
  if (by === "device") return [r.device];
  if (by === "harness") return [str(s["harness"])];
  if (by === "repo") return [repoOf(s).key];
  if (by === "room") return r.rooms;
  if (by === "skill") { const n = skillNames(s); return n.length ? n : [""]; }
  const m = models(s); return m.length ? m : [""];
}
function newGroup(key: string, label: string): GRow {
  return { key, label: label || "—", me: false, online: 0, devices: 0, live: 0, attention: 0, stuck: 0, at: 0, cost: { today: 0, week: 0, month: 0, all: 0 }, period: 0, commits: 0, tokens: 0, unpriced: 0, top: "", share: 0, second: "", skills: [], harnesses: [], sessions: 0, rows: [] };
}
// the groups of a view's rows, the period's cost first; by member every member shows (with presence) unless rows were
// filtered (then members without a matching row drop out)
export function groupRows(v: TeamView, rows: TeamRow[], by: string, period: string, cx: TCtx, filtered: boolean): GRow[] {
  const gs = new Map<string, GRow>();
  if (by === "member") for (const m of v.members) {
    const g = newGroup(m.id, m.name || m.id.slice(0, 8)); g.me = m.mine; g.devices = m.devices.length;
    for (const d of m.devices) { if (d.online) g.online++; if (d.at > g.at) g.at = d.at; g.live += d.live; g.attention += d.attention; g.stuck += d.stuck; }
    gs.set(m.id, g);
  }
  for (const r of rows) for (const k of keysOf(by, r)) {
    let g = gs.get(k);
    if (!g) {
      const lb = by === "member" ? cx.names.get(k) ?? k.slice(0, 8) : by === "room" ? cx.rooms.get(k) ?? k.slice(0, 8) : by === "repo" ? repoOf(r.s).label : k;
      g = newGroup(k, lb); gs.set(k, g);
    }
    g.rows.push(r);
  }
  const o: GRow[] = [];
  for (const g of gs.values()) {
    if (filtered && !g.rows.length) continue;
    g.cost = rowsCost(g.rows, v.at); g.period = periodCost(g.cost, period); g.sessions = g.rows.length;
    const tops = new Map<string, number>();
    for (const r of g.rows) {
      const s = r.s; const gt = obj(s["git"]); g.commits += gt ? n0(gt["produced"]) : 0; g.tokens += tokensOf(s);
      if (n0(s["unpricedTokens"]) > 0) g.unpriced++;
      const h = str(s["harness"]); if (h && g.harnesses.indexOf(h) < 0) g.harnesses.push(h);
      for (const n of skillNames(s)) if (g.skills.indexOf(n) < 0) g.skills.push(n);
      const tk = by === "harness" ? cx.names.get(r.member) ?? r.member.slice(0, 8) : h; tops.set(tk, (tops.get(tk) ?? 0) + 1);
      if (by !== "member") { // presence comes from the rows' states (by member: from the devices)
        const st = str(s["status"]);
        if (st === "stuck") g.stuck++; else if (st === "attention") g.attention++; else if (s["live"] === true) g.live++;
        if (r.updated > g.at) g.at = r.updated;
      }
    }
    let tn = 0; let sn = 0;
    for (const [k, n] of tops) { if (n > tn) { g.second = g.top; sn = tn; g.top = k; tn = n; } else if (n > sn) { g.second = k; sn = n; } }
    g.share = g.rows.length ? Math.round(tn * 100 / g.rows.length) : 0;
    o.push(g);
  }
  o.sort((a: GRow, b: GRow) => b.period - a.period || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return o;
}

// ── the team filter ──
export const TEAM_KEYS = ["member", "room", "harness", "repo", "model", "title", "branch", "live", "state", "cost", "tokens", "skill"];
export interface TPred { key: string; m: (v: Val) => boolean }
export interface TeamFilter { ps: TPred[]; err: string; col: number }
// an expression of the filter language → predicates over team rows; a key a shared row does not carry is an error
export function teamFilter(text: string): TeamFilter {
  const f: TeamFilter = { ps: [], err: "", col: -1 };
  if (!text.trim()) return f;
  const p = parse(text); if (p.err) { f.err = p.err.msg; f.col = p.err.col; return f; }
  for (const c of p.cs) {
    const x = clauseMatcher(c); if (x.err) { f.err = x.err; return f; }
    if (TEAM_KEYS.indexOf(x.key) < 0) { f.err = x.key + " is not in a teammate's shared rows (team keys: " + TEAM_KEYS.join(", ") + ")"; return f; }
    const m = x.m; if (m) f.ps.push({ key: x.key, m });
  }
  return f;
}
function V(ss: string[]): Val { return { n: 0, ss, unk: false }; }
const UNK: Val = { n: 0, ss: [], unk: true };
function low(ss: string[]): string[] { const o: string[] = []; for (const s of ss) if (s) o.push(s.toLowerCase()); return o; }
export function teamVal(key: string, r: TeamRow, cx: TCtx): Val {
  const s = r.s;
  if (key === "member") { const o = [r.member]; const n = cx.names.get(r.member); if (n) o.push(n.toLowerCase()); if (r.mine || r.member === cx.me) o.push("me"); return V(o); }
  if (key === "room") { const o: string[] = []; for (const id of r.rooms) { o.push(id); const n = cx.rooms.get(id); if (n) o.push(n.toLowerCase()); } return V(o); }
  if (key === "harness") return V(low([str(s["harness"])]));
  if (key === "repo") { const rp = repoOf(s); return V(low([rp.key, rp.label])); }
  if (key === "model") return V(low(models(s)));
  if (key === "title" || key === "branch") { const t = str(s[key]); return t ? V([t.toLowerCase()]) : UNK; } // numbers level: not shared
  if (key === "live") return V([s["live"] === true ? "true" : "false"]);
  if (key === "state") return V(low([str(s["status"])]));
  if (key === "cost") { const c = s["costUsd"]; return typeof c === "number" && isFinite(c) ? { n: c, ss: [], unk: false } : UNK; }
  if (key === "tokens") return { n: tokensOf(s), ss: [], unk: false };
  if (key === "skill") return V(low(skillNames(s)));
  return UNK;
}
export function teamMatch(f: TeamFilter, r: TeamRow, cx: TCtx): boolean { for (const p of f.ps) if (!p.m(teamVal(p.key, r, cx))) return false; return true; }
export function filterRows(f: TeamFilter, rows: TeamRow[], cx: TCtx): TeamRow[] { if (!f.ps.length) return rows; const o: TeamRow[] = []; for (const r of rows) if (teamMatch(f, r, cx)) o.push(r); return o; }

// ── room budgets ──
export interface RoomBudget { room: string; name: string; usd: number; spent: number; projected: number; state: string }
// the days of at's month (from noon, so a DST shift never skips a day)
function monthDays(at: number): number {
  const d = new Date(at); const noon = at + (12 - d.getHours()) * 3600000; const dom = d.getDate(); const mo = d.getMonth(); let n = 28;
  while (n < 31 && new Date(noon + (n + 1 - dom) * 86400000).getMonth() === mo) n++;
  return n;
}
// rooms with a budget (one room, or all): this month's spend of the room's sessions, projected over the month
export function budgets(t: TeamState, v: TeamView, room: string): RoomBudget[] {
  const o: RoomBudget[] = []; if (!t.priv) return o;
  const dom = new Date(v.at).getDate(); const dim = monthDays(v.at);
  for (const r of t.priv.rooms) {
    if (r.budgetUsd <= 0 || (room && r.id !== room)) continue;
    const rs: TeamRow[] = []; for (const x of v.rows) if (x.rooms.indexOf(r.id) >= 0) rs.push(x);
    const spent = rowsCost(rs, v.at).month; const projected = spent / dom * dim;
    o.push({ room: r.id, name: r.name, usd: r.budgetUsd, spent, projected, state: stateOf({ usd: r.budgetUsd, counts: [], warnAt: 0.8, bad: "" }, spent, projected) });
  }
  return o;
}
function whole(u: number): string { return "$" + (u >= 100 ? u.toFixed(0) : u.toFixed(2)); }
export function budgetLine(b: RoomBudget): string { return b.name + " budget " + whole(b.usd) + "/month: " + whole(b.spent) + " spent · projected " + whole(b.projected) + " · " + b.state; }

// filter keys for the Sessions list too: member (me for every local row) and room (team rows only; local rows have none)
register({ key: "member", aliases: [], ent: "session", type: "text", multi: false, enumVals: [], enumFn: "", ops: [] });
register({ key: "room", aliases: [], ent: "session", type: "text", multi: false, enumVals: [], enumFn: "", ops: [] });
extend("member", { sess: (s: Sess): Val => (s.host ? UNK : V(["me"])), resolve: null });
extend("room", { sess: (s: Sess): Val => UNK, resolve: null });
