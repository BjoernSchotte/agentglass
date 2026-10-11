// agentglass — the Team tab (fleet-teams spec 10; Tasks 9a, 9b): key 6 after Wait, shown once a team exists. One row per
// group (b: member ▸ harness ▸ repo ▸ room ▸ skill ▸ model): devices online (by member) or sessions, live agents
// (● live, ◆ attention, ⚠ stuck; ○ age when the newest file is old), today and the period's cost, $/commit, the top
// harness (by harness: member) with its share, skills; a budget line per room with a budget. / filters the shared rows
// with the filter language (group.ts). ↵ opens a group's sessions as they were shared (read-only: no transcript, no
// send or resume). A job every 60 s syncs (publish, fetch, admit) and rebuilds the view. The header shows "team ●n"
// (live agents across the team) when the tab is not open.
// SPDX-License-Identifier: Apache-2.0
import { fit } from "../../util/text.ts";
import { S, say } from "../../state.ts";
import { H, type Tab } from "../../hooks.ts";
import { obj, str } from "../../util/json.ts";
import { C, RST, fg } from "../../ui/theme.ts";
import { put, box } from "../../ui/screen.ts";
import { type TeamState, loadTeams } from "./state.ts";
import { syncOnce } from "./sync.ts";
import { type TeamView, buildView, rowsCost } from "./view.ts";
import { type GRow, GROUPS, TEAM_KEYS, ctxOf, groupRows, teamFilter, filterRows, periodCost, budgets, budgetLine } from "./group.ts";
import { ask } from "../../actions.ts";
import { OS } from "../../platform/index.ts";

export const SYNC_MS = 60000;
export const TS = { teams: [] as TeamState[], ti: 0, view: null as TeamView | null, room: "", period: "w", by: "member", filter: "", sel: 0, detail: "", dsel: 0, syncAt: 0, problems: [] as string[], pushed: false, told: new Map<string, string>() };
const PER: { [k: string]: string } = { d: "today", w: "this week", m: "this month", a: "all kept days" };
function money(u: number): string { return u <= 0 ? "$0.00" : "$" + (u >= 1000 ? u.toFixed(0) : u.toFixed(2)); }
function age(ms: number): string { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? String(s) + " s" : s < 5400 ? String(Math.round(s / 60)) + " min" : s < 172800 ? String(Math.round(s / 3600)) + " h" : String(Math.round(s / 86400)) + " d"; }

// the groups the tab shows (the view's rows through the filter, grouped by TS.by)
export function groupsOf(t: TeamState | null, v: TeamView, by: string, period: string, filter: string): GRow[] {
  const cx = ctxOf(t, v); const f = teamFilter(filter);
  return groupRows(v, f.err ? v.rows : filterRows(f, v.rows, cx), by, period, cx, f.ps.length > 0);
}
// the tab as plain lines at width w (render colours them; the check reads them)
export function lines(t: TeamState | null, v: TeamView | null, period: string, room: string, w: number, now: number, by = "member", filter = ""): string[] {
  const o: string[] = [];
  if (!t || !v) { o.push(fit(" no team on this machine: agentglass team create <name> | agentglass team join <code>", w)); return o; }
  const rs = groupsOf(t, v, by, period, filter); let on = 0; for (const m of v.members) for (const d of m.devices) if (d.online) { on++; break; }
  let rn = "all"; if (room && t.priv) for (const r of t.priv.rooms) if (r.id === room) rn = r.name;
  o.push(fit(" Team " + (t.priv ? t.priv.name : t.id) + " · room " + rn + " ▾ · " + (PER[period] ?? "") + " · " + String(on) + " of " + String(v.members.length) + " members online" + (TS.syncAt ? " · synced " + age(now - TS.syncAt) + " ago" : ""), w));
  // columns: group 12, devices (by member) or sessions 8, live 9, today 8, the period 9, $/commit 9, top 16, skills 6 (80 in all)
  const mem = by === "member";
  o.push(fit(" " + by.toUpperCase().padEnd(12) + (mem ? "DEVICES" : "SESS").padEnd(8) + "LIVE".padEnd(9) + "TODAY".padStart(8) + (period === "d" ? " ".repeat(9) : (period === "w" ? "WEEK" : period === "m" ? "MONTH" : "ALL").padStart(9)) + "$/COMMIT".padStart(9) + "  " + (by === "harness" ? "TOP MEMBER" : "TOP HARNESS").padEnd(16) + "SKILLS".padStart(6), w));
  for (const r of rs) {
    const nm = r.label + (r.me ? " (me)" : "");
    const lv = r.live || r.attention || r.stuck ? ((r.live ? "●" + String(r.live) + " " : "") + (r.attention ? "◆" + String(r.attention) + " " : "") + (r.stuck ? "⚠" + String(r.stuck) : "")).trim() : r.at && now - r.at > 900000 ? "○ " + age(now - r.at) + " ago" : "○";
    const cpc = r.commits ? money(r.period / r.commits) : "—";
    const th = r.top ? r.top + " " + String(r.share) + "%" + (r.second ? " " + r.second : "") : "—";
    o.push(fit(" " + fit(nm, 11) + " " + (mem ? String(r.online) + "/" + String(r.devices) : String(r.sessions)).padEnd(8) + fit(lv, 9) + (r.at || r.sessions ? money(r.cost.today) : "—").padStart(8) + (period === "d" ? " ".repeat(9) : money(r.period).padStart(9)) + cpc.padStart(9) + "  " + fit(th, 16) + String(r.skills.length).padStart(6), w));
  }
  if (!rs.length) o.push(fit(" no session matches the filter", w));
  o.push(fit(" " + "─".repeat(Math.max(0, w - 2)), w));
  for (const b of budgets(t, v, room)) o.push(fit(" " + budgetLine(b), w));
  const fe = teamFilter(filter).err;
  if (filter) o.push(fit(" filter: " + filter + (fe ? "  ⚠ " + fe : "") + " · esc clears", w));
  if (v.skipped.length) o.push(fit(" " + String(v.skipped.length) + " file(s) skipped: " + v.skipped[0]?.why, w));
  if (TS.problems.length) o.push(fit(" ⚠ " + TS.problems[0], w));
  const nx = GROUPS[(GROUPS.indexOf(by) + 1) % GROUPS.length] ?? "member";
  o.push(fit(" d w m a period · b by " + by + " ▸ " + nx + " · r room · / filter · ↵ sessions · ? keys", w));
  return o;
}
// a group's sessions (read-only rows) as plain lines
export function detailLines(t: TeamState | null, v: TeamView, by: string, key: string, period: string, filter: string, w: number): string[] {
  const o: string[] = []; const cx = ctxOf(t, v); let g: GRow | null = null;
  for (const x of groupsOf(t, v, by, period, filter)) if (x.key === key) g = x;
  o.push(fit(" " + (g ? g.label : key.slice(0, 8)) + " · shared sessions (read-only: no transcript, no send or resume) · esc back", w));
  if (!g) return o;
  for (const r of g.rows) {
    const what = str(r.s["title"]) || str(obj(r.s["repo"])?.["label"] ?? "") || str(r.s["model"]);
    const rn: string[] = []; for (const id of r.rooms) rn.push(cx.rooms.get(id) ?? id.slice(0, 8));
    // who shared it where ("alice in backend"); by member the member is the group
    const who = by === "member" ? fit(rn.join(", "), 10) : fit((cx.names.get(r.member) ?? r.member.slice(0, 8)) + " in " + rn.join(", "), 16);
    o.push(fit(" " + str(r.s["updated"]).slice(0, 16).split("T").join(" ") + "  " + fit(str(r.s["harness"]), 9) + " " + fit(str(r.s["status"]), 9) + " " + money(periodCost(rowsCost([r], v.at), period)).padStart(9) + "  " + who + "  " + what, w));
  }
  return o;
}
function current(): TeamState | null { return TS.teams[TS.ti] ?? null; }
// a room near or over its budget: a toast (and a desktop notice) once a day per room and state
// shortcut: with one room picked (r) only that room's budget is checked; a full view per sync when rooms get many budgets
function budgetToasts(t: TeamState, v: TeamView, now: number): void {
  const d = new Date(now); const day = String(d.getFullYear()) + "-" + String(d.getMonth() + 1) + "-" + String(d.getDate());
  for (const b of budgets(t, v, TS.room)) {
    if (b.state !== "watch" && b.state !== "over") continue;
    const k = b.room + "|" + b.state; if (TS.told.get(k) === day) continue; TS.told.set(k, day);
    const msg = "team: " + budgetLine(b); say("warn", msg);
    if (process.env["AGENTGLASS_NOTIFY"] !== "0") OS.notify("agentglass", "team budget", msg);
  }
}
export function refresh(now: number, doSync: boolean): void {
  TS.teams = loadTeams(); if (TS.ti >= TS.teams.length) TS.ti = 0;
  if (TS.teams.length && !TS.pushed) { H.tabs.push(TEAM_TAB); TS.pushed = true; }
  const t = current(); if (!t) { TS.view = null; return; }
  if (doSync) { const r = syncOnce(t, now, false); TS.problems = r.problems; TS.syncAt = now; if (r.admitted.length) say("ok", "team: admitted " + String(r.admitted.length) + " member(s)"); if (r.pending.length) say("info", "team: join request — agentglass team admit"); }
  TS.view = buildView(t, TS.room, now, 0);
  if (doSync) budgetToasts(t, TS.view, now);
}
function render(): void {
  const W = S.W; const Ht = S.H; const t = current(); const v = TS.view; const now = Date.now();
  const ls = TS.detail && v ? detailLines(t, v, TS.by, TS.detail, TS.period, TS.filter, W - 2) : lines(t, v, TS.period, TS.room, W - 2, now, TS.by, TS.filter);
  box(0, 1, W, Ht - 2, "team", TS.detail ? "sessions" : "by " + TS.by, true);
  for (let i = 0; i < ls.length && i < Ht - 4; i++) {
    const sel = TS.detail ? i === TS.dsel + 1 : i === TS.sel + 2 && i >= 2;
    put(1, 2 + i, (i === 0 ? fg(C.text) : i === 1 && !TS.detail ? fg(C.dim) : sel ? fg(C.accent) : fg(C.text)) + (ls[i] ?? "") + RST);
  }
}
let before = "";
function key(k: string): boolean {
  const v = TS.view; const rows = v ? groupsOf(current(), v, TS.by, TS.period, TS.filter) : [];
  if (k === "d" || k === "w" || k === "m" || k === "a") { TS.period = k; return true; }
  if (TS.detail) {
    if (k === "esc" || k === "left" || k === "bs" || k === "backspace") { TS.detail = ""; return true; }
    if (k === "up" || k === "k") { TS.dsel = Math.max(0, TS.dsel - 1); return true; }
    if (k === "down" || k === "j") { TS.dsel++; return true; }
    return false;
  }
  if (k === "up" || k === "k") { TS.sel = Math.max(0, TS.sel - 1); return true; }
  if (k === "down" || k === "j") { TS.sel = Math.min(Math.max(0, rows.length - 1), TS.sel + 1); return true; }
  if (k === "enter" || k === "right") { const r = rows[TS.sel]; if (r) { TS.detail = r.key; TS.dsel = 0; } return true; }
  if (k === "b") { TS.by = GROUPS[(GROUPS.indexOf(TS.by) + 1) % GROUPS.length] ?? "member"; TS.sel = 0; return true; }
  if (k === "/") { before = TS.filter; S.inputErr = ""; ask("filter team", "team-filter", TS.filter); return true; }
  if (k === "esc" && TS.filter) { TS.filter = ""; TS.sel = 0; return true; }
  if (k === "r") { // the next room, then all rooms
    const t = current(); const ids: string[] = [""]; if (t && t.priv) for (const r of t.priv.rooms) ids.push(r.id);
    TS.room = ids[(ids.indexOf(TS.room) + 1) % ids.length] ?? ""; refresh(Date.now(), false); return true;
  }
  return false;
}
// the / input: applied while typing when valid; esc restores the filter before it, enter keeps an invalid one open
H.input.push((action: string, ev: string, text: string): boolean => {
  if (action !== "team-filter") return false;
  const err = teamFilter(text).err; S.inputErr = ev === "esc" ? "" : err;
  if (ev === "change" && !err) { TS.filter = text.trim(); TS.sel = 0; }
  if (ev === "esc") TS.filter = before;
  if (ev === "enter") { if (err) return true; TS.filter = text.trim(); TS.sel = 0; }
  return false;
});
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
H.footerHints.push((mode: string): string[][] => (mode === "list" && onTab() ? [["d w m a", "period"], ["b", "group"], ["r", "room"], ["/", "filter"], ["↵", "sessions"]] : []));
H.helpSections.push({ name: "team", ctx: "Team", keys: [["d w m a", "period: today, 7 days, this month, all kept days"], ["b", "group by member ▸ harness ▸ repo ▸ room ▸ skill ▸ model"],
  ["r", "room: each room, then all rooms"], ["/", "filter the shared rows: " + TEAM_KEYS.join(", ") + " (member is me, room is backend)"], ["esc", "clear the filter"],
  ["↵", "the group's sessions as shared (read-only: no transcript, no send or resume)"], ["", "● live · ◆ waiting for you · ⚠ stuck · ○ no device online (the age of its last file)"],
  ["", "a room's budget line: this month's spend, projected to the month's end; a toast once a day when near or over"],
  ["", "agentglass team … in a shell: invite, join, sync, report, sessions"]] });
