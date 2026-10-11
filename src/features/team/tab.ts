// agentglass — the Team tab (fleet-teams spec 10; Task 9a): key 6 after Wait, shown once a team exists. One row per
// member: devices online, live agents (● live, ◆ attention, ⚠ stuck; ○ age when the newest file is old), today and the
// period's cost, $/commit, the top harness with its share, skills. ↵ opens a member's sessions as they shared them
// (read-only: no transcript, no send or resume). A job every 60 s syncs (publish, fetch, admit) and rebuilds the view.
// The header shows "team ●n" (live agents across the team) when the tab is not open.
// SPDX-License-Identifier: Apache-2.0
import { fit } from "../../util/text.ts";
import { S, say } from "../../state.ts";
import { H, type Tab } from "../../hooks.ts";
import { obj, arr, str } from "../../util/json.ts";
import { C, RST, fg } from "../../ui/theme.ts";
import { put, box } from "../../ui/screen.ts";
import { register } from "../query/attrs.ts";
import { extend } from "../query/eval.ts";
import type { Val } from "../query/types.ts";
import type { Sess } from "../../model/types.ts";
import { type TeamState, loadTeams } from "./state.ts";
import { syncOnce } from "./sync.ts";
import { type TeamView, type TeamRow, buildView, viewCost } from "./view.ts";

export const SYNC_MS = 60000;
export const TS = { teams: [] as TeamState[], ti: 0, view: null as TeamView | null, room: "", period: "w", sel: 0, detail: "", dsel: 0, syncAt: 0, problems: [] as string[], pushed: false };
const PER: { [k: string]: string } = { d: "today", w: "this week", m: "this month", a: "all kept days" };
function money(u: number): string { return u <= 0 ? "$0.00" : "$" + (u >= 1000 ? u.toFixed(0) : u.toFixed(2)); }
function age(ms: number): string { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? String(s) + " s" : s < 5400 ? String(Math.round(s / 60)) + " min" : s < 172800 ? String(Math.round(s / 3600)) + " h" : String(Math.round(s / 86400)) + " d"; }

export interface MRow { id: string; name: string; me: boolean; online: number; devices: number; live: number; attention: number; stuck: number; at: number; today: number; period: number; commits: number; top: string; share: number; second: string; skills: number; sessions: number }
// one row per member from the view (period: d w m a)
export function memberRows(v: TeamView, period: string): MRow[] {
  const o: MRow[] = [];
  for (const m of v.members) {
    let on = 0; let at = 0; let live = 0; let att = 0; let st = 0;
    for (const d of m.devices) { if (d.online) on++; if (d.at > at) at = d.at; live += d.live; att += d.attention; st += d.stuck; }
    const mine: TeamRow[] = []; for (const r of v.rows) if (r.member === m.id) mine.push(r);
    const one: TeamView = { team: v.team, room: v.room, at: v.at, members: [], rows: mine, skipped: [], truncated: 0 };
    const c = viewCost(one); let all = 0; for (const r of mine) for (const d of r.days) { for (const x of d.tp) { const u = Number(x[8] ?? "-1"); if (u > 0) all += u; } for (const x of d.hx) { const u = Number(x[2] ?? "0"); if (u > 0) all += u; } }
    const per = period === "d" ? c.today : period === "w" ? c.week : period === "m" ? c.month : all;
    let commits = 0; const hs = new Map<string, number>(); const sk = new Set<string>();
    for (const r of mine) {
      const g = obj(r.s["git"]); if (g && typeof g["produced"] === "number") commits += g["produced"];
      const h = str(r.s["harness"]); hs.set(h, (hs.get(h) ?? 0) + 1);
      for (const x of arr(r.s["skills"])) { const e = obj(x); if (e) sk.add(str(e["name"])); }
    }
    let top = ""; let tn = 0; let sec = ""; let sn = 0;
    for (const [h, n] of hs) { if (n > tn) { sec = top; sn = tn; top = h; tn = n; } else if (n > sn) { sec = h; sn = n; } }
    o.push({ id: m.id, name: m.name, me: m.mine, online: on, devices: m.devices.length, live, attention: att, stuck: st, at, today: c.today, period: per, commits, top, share: mine.length ? Math.round(tn * 100 / mine.length) : 0, second: sec, skills: sk.size, sessions: mine.length });
  }
  o.sort((a: MRow, b: MRow) => b.period - a.period || (a.name < b.name ? -1 : 1));
  return o;
}
// the tab as plain lines at width w (render colours them; the check reads them)
export function lines(t: TeamState | null, v: TeamView | null, period: string, room: string, w: number, now: number): string[] {
  const o: string[] = [];
  if (!t || !v) { o.push(fit(" no team on this machine: agentglass team create <name> | agentglass team join <code>", w)); return o; }
  const rs = memberRows(v, period); let on = 0; for (const r of rs) if (r.online) on++;
  let rn = "all"; if (room && t.priv) for (const r of t.priv.rooms) if (r.id === room) rn = r.name;
  o.push(fit(" Team " + (t.priv ? t.priv.name : t.id) + " · room " + rn + " ▾ · " + (PER[period] ?? "") + " · " + String(on) + " of " + String(rs.length) + " members online" + (TS.syncAt ? " · synced " + age(now - TS.syncAt) + " ago" : ""), w));
  // columns: member 12, devices 8, live 9, today 8, the period 9, $/commit 9, top harness 16, skills 6 (80 in all)
  o.push(fit(" " + "MEMBER".padEnd(12) + "DEVICES".padEnd(8) + "LIVE".padEnd(9) + "TODAY".padStart(8) + (period === "d" ? " ".repeat(9) : (period === "w" ? "WEEK" : period === "m" ? "MONTH" : "ALL").padStart(9)) + "$/COMMIT".padStart(9) + "  " + "TOP HARNESS".padEnd(16) + "SKILLS".padStart(6), w));
  for (const r of rs) {
    const nm = (r.name || r.id.slice(0, 8)) + (r.me ? " (me)" : "");
    const lv = r.live || r.attention || r.stuck ? ((r.live ? "●" + String(r.live) + " " : "") + (r.attention ? "◆" + String(r.attention) + " " : "") + (r.stuck ? "⚠" + String(r.stuck) : "")).trim() : r.at && now - r.at > 900000 ? "○ " + age(now - r.at) + " ago" : "○";
    const cpc = r.commits ? money(r.period / r.commits) : "—";
    const th = r.top ? r.top + " " + String(r.share) + "%" + (r.second ? " " + r.second : "") : "—";
    o.push(fit(" " + fit(nm, 11) + " " + (String(r.online) + "/" + String(r.devices)).padEnd(8) + fit(lv, 9) + (r.at || r.sessions ? money(r.today) : "—").padStart(8) + (period === "d" ? " ".repeat(9) : money(r.period).padStart(9)) + cpc.padStart(9) + "  " + fit(th, 16) + String(r.skills).padStart(6), w));
  }
  o.push(fit(" " + "─".repeat(Math.max(0, w - 2)), w));
  if (v.skipped.length) o.push(fit(" " + String(v.skipped.length) + " file(s) skipped: " + v.skipped[0]?.why, w));
  if (TS.problems.length) o.push(fit(" ⚠ " + TS.problems[0], w));
  o.push(fit(" d w m a period · r room · ↵ sessions · ? keys", w));
  return o;
}
// a member's sessions (read-only rows) as plain lines
export function detailLines(v: TeamView, member: string, period: string, w: number): string[] {
  const o: string[] = []; let nm = member.slice(0, 8); for (const m of v.members) if (m.id === member) nm = m.name || nm;
  o.push(fit(" " + nm + " · shared sessions (read-only: no transcript, no send or resume) · esc back", w));
  for (const r of v.rows) {
    if (r.member !== member) continue;
    const one: TeamView = { team: v.team, room: v.room, at: v.at, members: [], rows: [r], skipped: [], truncated: 0 }; const c = viewCost(one);
    const what = str(r.s["title"]) || str(obj(r.s["repo"])?.["label"] ?? "") || str(r.s["model"]);
    o.push(fit(" " + str(r.s["updated"]).slice(0, 16).split("T").join(" ") + "  " + fit(str(r.s["harness"]), 9) + " " + fit(str(r.s["status"]), 9) + " " + money(period === "d" ? c.today : period === "w" ? c.week : c.month).padStart(9) + "  " + what, w));
  }
  return o;
}
function current(): TeamState | null { return TS.teams[TS.ti] ?? null; }
export function refresh(now: number, doSync: boolean): void {
  TS.teams = loadTeams(); if (TS.ti >= TS.teams.length) TS.ti = 0;
  if (TS.teams.length && !TS.pushed) { H.tabs.push(TEAM_TAB); TS.pushed = true; }
  const t = current(); if (!t) { TS.view = null; return; }
  if (doSync) { const r = syncOnce(t, now, false); TS.problems = r.problems; TS.syncAt = now; if (r.admitted.length) say("ok", "team: admitted " + String(r.admitted.length) + " member(s)"); if (r.pending.length) say("info", "team: join request — agentglass team admit"); }
  TS.view = buildView(t, TS.room, now, 0);
}
function render(): void {
  const W = S.W; const Ht = S.H; const t = current(); const v = TS.view; const now = Date.now();
  const ls = TS.detail && v ? detailLines(v, TS.detail, TS.period, W - 2) : lines(t, v, TS.period, TS.room, W - 2, now);
  box(0, 1, W, Ht - 2, "team", TS.detail ? "sessions" : "members", true);
  for (let i = 0; i < ls.length && i < Ht - 4; i++) {
    const sel = TS.detail ? i === TS.dsel + 1 : i === TS.sel + 2 && i >= 2;
    put(1, 2 + i, (i === 0 ? fg(C.text) : i === 1 && !TS.detail ? fg(C.dim) : sel ? fg(C.accent) : fg(C.text)) + (ls[i] ?? "") + RST);
  }
}
function key(k: string): boolean {
  const v = TS.view; const rows = v ? memberRows(v, TS.period) : [];
  if (k === "d" || k === "w" || k === "m" || k === "a") { TS.period = k; return true; }
  if (TS.detail) {
    if (k === "esc" || k === "left" || k === "bs" || k === "backspace") { TS.detail = ""; return true; }
    if (k === "up" || k === "k") { TS.dsel = Math.max(0, TS.dsel - 1); return true; }
    if (k === "down" || k === "j") { TS.dsel++; return true; }
    return false;
  }
  if (k === "up" || k === "k") { TS.sel = Math.max(0, TS.sel - 1); return true; }
  if (k === "down" || k === "j") { TS.sel = Math.min(Math.max(0, rows.length - 1), TS.sel + 1); return true; }
  if (k === "enter" || k === "right") { const r = rows[TS.sel]; if (r) { TS.detail = r.id; TS.dsel = 0; } return true; }
  if (k === "r") { // the next room, then all rooms
    const t = current(); const ids: string[] = [""]; if (t && t.priv) for (const r of t.priv.rooms) ids.push(r.id);
    TS.room = ids[(ids.indexOf(TS.room) + 1) % ids.length] ?? ""; refresh(Date.now(), false); return true;
  }
  return false;
}
export const TEAM_TAB: Tab = { name: "Team", render, key };
function onTab(): boolean { return S.mode === "list" && S.tab - 2 === H.tabs.indexOf(TEAM_TAB); }
// the job: sync every 60 s (the first one a few seconds after start), a view rebuild when the tab shows
let nextAt = Date.now() + 3000;
H.onTick.push(() => { const now = Date.now(); if (now < nextAt) return; nextAt = now + SYNC_MS; refresh(now, true); });
H.headerWidgets.push((w: number): string => {
  const v = TS.view; if (!v || onTab() || w < 10) return "";
  let live = 0; for (const m of v.members) for (const d of m.devices) live += d.live;
  return fg(C.dim) + "team " + RST + fg(live ? C.green : C.dim) + "●" + String(live) + RST;
});
H.footerHints.push((mode: string): string[][] => (mode === "list" && onTab() ? [["d w m a", "period"], ["r", "room"], ["↵", "sessions"]] : []));
H.helpSections.push({ name: "team", ctx: "Team", keys: [["d w m a", "period: today, 7 days, this month, all kept days"], ["r", "room: each room, then all rooms"],
  ["↵", "the member's sessions as shared (read-only: no transcript, no send or resume)"], ["", "● live · ◆ waiting for you · ⚠ stuck · ○ no device online (the age of its last file)"],
  ["", "agentglass team … in a shell: invite, join, sync, report, sessions"]] });
// filter keys: member (me for every local row) and room (team rows; local rows have none)
register({ key: "member", aliases: [], ent: "session", type: "text", multi: false, enumVals: [], enumFn: "", ops: [] });
register({ key: "room", aliases: [], ent: "session", type: "text", multi: false, enumVals: [], enumFn: "", ops: [] });
const UNKNOWN: Val = { n: 0, ss: ["unknown"], unk: true };
extend("member", { sess: (s: Sess): Val => (s.host ? UNKNOWN : { n: 0, ss: ["me"], unk: false }), resolve: null });
extend("room", { sess: (s: Sess): Val => UNKNOWN, resolve: null });
