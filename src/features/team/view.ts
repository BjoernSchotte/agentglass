// agentglass — the team view (fleet-teams spec 9): every current member device's stream in the room(s), one row per
// session. A session has one id per team on every device (teamSessId), so a log synced between a member's devices, a
// session shared into two rooms and the same session from two members are one row: the newest copy's fields, its days
// merged by date (the newer copy's day wins), its rooms joined. Members and devices with presence; files skipped with
// their reason. Caps: 16 rooms, 64 device streams (the newest first), the rest counted as truncated.
// shortcut: copies across devices are joined by session id only — a session continued on another device that carries
// copied messages under a new id counts them twice (rare: that device's own ledger owns its copies); a message-level
// merge (fleet's exactMerge over the members' own rows) when it shows up.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, str } from "../../util/json.ts";
import { type DayRow } from "../fleet/model.ts";
import { type TeamState } from "./state.ts";
import { type TeamFeed, teamFeed, pollFeed } from "./feed.ts";

export const MAX_STREAMS = 64; export const MAX_VIEW_ROOMS = 16;
export const ONLINE_MS = 900000; // a device that published within 15 min is online (TUI sync 1 min, the service 5 min)
export interface TeamDevice { id: string; online: boolean; at: number; live: number; attention: number; stuck: number }
export interface TeamMember { id: string; name: string; mine: boolean; devices: TeamDevice[]; sessions: number }
export interface TeamRow { member: string; device: string; rooms: string[]; s: Obj; days: DayRow[]; mine: boolean; updated: number }
export interface Skipped { file: string; why: string }
export interface TeamView { team: string; room: string; at: number; members: TeamMember[]; rows: TeamRow[]; skipped: Skipped[]; truncated: number }
const FEEDS = new Map<string, TeamFeed>();
export function resetFeeds(): void { FEEDS.clear(); }

export function buildView(t: TeamState, room: string, now: number, lines: number): TeamView {
  const v: TeamView = { team: t.id, room, at: now, members: [], rows: [], skipped: [], truncated: 0 };
  const m = t.manifest; if (!m) return v;
  const names = t.priv ? t.priv.names : {};
  // the streams: (room, member, device) of current members holding the room
  const fs: TeamFeed[] = []; let nRooms = 0;
  for (const r of m.rooms) {
    if (room && r.id !== room) continue;
    if (++nRooms > MAX_VIEW_ROOMS) { v.truncated++; continue; }
    for (const x of m.members) {
      if (x.removedAt || r.members.indexOf(x.id) < 0) continue;
      for (const d of x.devices) {
        const k = t.id + "|" + r.id + "|" + x.id + "|" + d;
        let f = FEEDS.get(k); if (!f) { f = teamFeed(r.id, x.id, d); FEEDS.set(k, f); }
        fs.push(f);
      }
    }
  }
  for (const f of fs) pollFeed(t, f, now, lines);
  fs.sort((a: TeamFeed, b: TeamFeed) => b.at - a.at);
  const devs = new Map<string, TeamDevice>(); const byId = new Map<string, TeamRow>();
  let n = 0;
  for (const f of fs) {
    for (const [file, why] of f.chain.bad) if (why !== "another chain") v.skipped.push({ file: "rooms/" + f.room + "/" + file, why });
    const rep = f.st.report; if (!rep) continue;
    if (++n > MAX_STREAMS) { v.truncated++; continue; }
    const dk = f.member + "|" + f.device;
    let dv = devs.get(dk); if (!dv) { dv = { id: f.device, online: false, at: 0, live: 0, attention: 0, stuck: 0 }; devs.set(dk, dv); }
    if (f.at > dv.at) dv.at = f.at;
    for (const sr of rep.sessions) {
      const id = str(sr.s["id"]); if (!id) continue;
      const up = Date.parse(str(sr.s["updated"])) || 0;
      const row: TeamRow = { member: f.member, device: f.device, rooms: [f.room], s: sr.s, days: sr.days ?? [], mine: f.member === t.me.id, updated: up };
      const old = byId.get(id);
      if (!old) { byId.set(id, row); continue; }
      if (old.rooms.indexOf(f.room) < 0) old.rooms.push(f.room);
      old.mine = old.mine || row.mine;
      const newer = up > old.updated; const a = newer ? old.days : row.days; const b = newer ? row.days : old.days; // b wins a date
      const dm = new Map<string, DayRow>(); for (const d of a) dm.set(d.d, d); for (const d of b) dm.set(d.d, d);
      const days: DayRow[] = []; for (const d of dm.values()) days.push(d); days.sort((x: DayRow, y: DayRow) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0));
      old.days = days;
      if (newer) { old.s = row.s; old.member = row.member; old.device = row.device; old.updated = up; }
    }
  }
  for (const r of byId.values()) { v.rows.push(r); }
  v.rows.sort((a: TeamRow, b: TeamRow) => b.updated - a.updated);
  // presence and live state per device (from the rows it sent last)
  for (const r of v.rows) {
    const dv = devs.get(r.member + "|" + r.device); if (!dv) continue;
    if (r.s["live"] === true) dv.live++;
    const st = str(r.s["status"]); if (st === "attention") dv.attention++; else if (st === "stuck") dv.stuck++;
  }
  for (const x of m.members) {
    if (x.removedAt) continue;
    const ds: TeamDevice[] = [];
    for (const d of x.devices) { const dv = devs.get(x.id + "|" + d); const e = dv ?? { id: d, online: false, at: 0, live: 0, attention: 0, stuck: 0 }; e.online = e.at > 0 && now - e.at < ONLINE_MS; ds.push(e); }
    let sn = 0; for (const r of v.rows) if (r.member === x.id) sn++;
    v.members.push({ id: x.id, name: names[x.id] ?? "", mine: x.id === t.me.id, devices: ds, sessions: sn });
  }
  return v;
}
// local day keys (fleet day rows are the publisher's local days, shifted as fleet does when it renders)
function dayKey(t: number): string { const d = new Date(t); const z = (n: number): string => String(n).padStart(2, "0"); return String(d.getFullYear()) + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); }
function usdOf(d: DayRow): number {
  let u = 0;
  for (const r of d.tp) { const x = Number(r[8] ?? "-1"); if (x > 0) u += x; }
  for (const r of d.hx) { const x = Number(r[2] ?? "0"); if (x > 0) u += x; }
  return u;
}
// the distinct sessions' cost: today, the last 7 days, this month (USD, as their publishers priced them)
export function viewCost(v: TeamView): { today: number; week: number; month: number } {
  const today = dayKey(v.at); const wk = dayKey(v.at - 6 * 86400000); const mo = today.slice(0, 7);
  let t = 0; let w = 0; let mm = 0;
  for (const r of v.rows) for (const d of r.days) { const u = usdOf(d); if (d.d === today) t += u; if (d.d >= wk && d.d <= today) w += u; if (d.d.slice(0, 7) === mo) mm += u; }
  return { today: t, week: w, month: mm };
}
