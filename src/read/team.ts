// agentglass — the team read model (local-web-api W7, fleet-teams spec 11): status, report, sessions and activity as
// contract objects, shared by `agentglass team … --json` and serve --stdio's team.* methods (one builder: the CLI and
// the protocol answer the same bytes). Names resolve at read time (a rename applies to every row; --redact: fakes).
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str } from "../util/json.ts";
import { type TeamState, loadTeams } from "../features/team/state.ts";
import { type MemberPub } from "../features/team/manifest.ts";
import { type TeamView, type TeamRow, buildView, viewCost } from "../features/team/view.ts";
import { activity } from "../features/team/activity.ts";

export interface TeamErr { code: string; msg: string; hint: string }
function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }
// the team a request names (id prefix or name; "" = the only one)
export function pickTeam(want: string): { t: TeamState | null; err: TeamErr | null } {
  const ts = loadTeams();
  if (!ts.length) return { t: null, err: { code: "no_team", msg: "no team on this machine", hint: "agentglass team create <name> | agentglass team join <code>" } };
  if (!want) { if (ts.length === 1) return { t: ts[0] as TeamState, err: null }; const ns: string[] = []; for (const t of ts) ns.push(t.priv ? t.priv.name : t.id); return { t: null, err: { code: "bad_param", msg: "you are in " + String(ts.length) + " teams: name one", hint: ns.join(", ") } }; }
  for (const t of ts) if (t.id.startsWith(want) || (t.priv && t.priv.name === want)) return { t, err: null };
  return { t: null, err: { code: "not_found", msg: "no team " + want + " here", hint: "" } };
}
export function teamsMeta(): Obj[] { const o: Obj[] = []; for (const t of loadTeams()) o.push({ id: t.id, name: t.priv ? t.priv.name : "" }); return o; }
export function roomId(t: TeamState, want: string): { id: string; err: TeamErr | null } {
  if (!want || !t.priv) return { id: "", err: null };
  for (const r of t.priv.rooms) if (r.name === want || r.id === want) return { id: r.id, err: null };
  return { id: "", err: { code: "not_found", msg: "no room " + want, hint: "" } };
}
export function nameOf(v: TeamView, id: string): string { for (const m of v.members) if (m.id === id) return m.name; return id.slice(0, 8); }
function memberIs(v: TeamView, t: TeamState, r: TeamRow, want: string): boolean { return !want || (want === "me" ? r.member === t.me.id : nameOf(v, r.member) === want || r.member.startsWith(want)); }

export function statusObj(now: number): Obj {
  const o: Obj[] = [];
  for (const t of loadTeams()) {
    const m = t.manifest; const p = t.priv; const v = buildView(t, "", now, 0);
    let me: MemberPub | null = null; if (m) for (const x of m.members) if (x.id === t.me.id) me = x;
    const rooms: Obj[] = [];
    if (p && m) for (const r of p.rooms) {
      let ep = r.epoch; for (const q of m.rooms) if (q.id === r.id) ep = q.epoch;
      let sh: Obj | null = null; for (const s of t.policy) if (s.room === r.id) sh = { on: s.on, repos: s.repos, level: s.level, since: s.since, paused: s.paused };
      rooms.push({ id: r.id, name: r.name, scope: r.scope, level: r.level, epoch: ep, budget: r.budgetUsd || null, share: sh });
    }
    const members: Obj[] = [];
    for (const x of v.members) { let on = false; for (const d of x.devices) if (d.online) on = true; members.push({ id: x.id, name: x.name, devices: x.devices.length, online: on, sessions: x.sessions }); }
    o.push({ id: t.id, name: p ? p.name : "", mailbox: t.mailbox, kind: t.kind, me: { id: t.me.id, name: t.name, device: t.device }, admin: !!me && me.admin, joined: !!me && !t.req, rooms, members, pending: 0, problems: [] });
  }
  return { teams: o };
}
export const BYS = ["member", "device", "harness", "repo", "room"];
export function reportObj(t: TeamState, room: string, member: string, by: string, per: string, now: number): Obj {
  const v = buildView(t, room, now, 0); const groups = new Map<string, Obj>();
  for (const r of v.rows) {
    if (!memberIs(v, t, r, member)) continue;
    const c = viewCost({ team: v.team, room: v.room, at: v.at, members: v.members, rows: [r], skipped: [], truncated: 0 });
    const usd = per === "d" ? c.today : per === "w" ? c.week : c.month;
    const rk = obj(r.s["repo"]);
    const ks: string[] = by === "member" ? [nameOf(v, r.member)] : by === "device" ? [r.device] : by === "harness" ? [str(r.s["harness"])] : by === "repo" ? [rk ? str(rk["key"]) : ""] : r.rooms;
    for (const k of ks) {
      let g = groups.get(k); if (!g) { g = { key: k, sessions: 0, live: 0, tokens: 0, costUsd: 0, harnesses: [] as string[] }; groups.set(k, g); }
      g["sessions"] = num(g["sessions"]) + 1; if (r.s["live"] === true) g["live"] = num(g["live"]) + 1;
      const tk = obj(r.s["tokens"]); if (tk) g["tokens"] = num(g["tokens"]) + num(tk["in"]) + num(tk["out"]) + num(tk["cacheRead"]) + num(tk["cacheWrite"]);
      g["costUsd"] = Math.round((num(g["costUsd"]) + usd) * 1e6) / 1e6;
      const hs = g["harnesses"] as string[]; const h = str(r.s["harness"]); if (h && hs.indexOf(h) < 0) hs.push(h);
    }
  }
  const rows: Obj[] = []; for (const g of groups.values()) rows.push(g); rows.sort((x: Obj, y: Obj) => num(y["costUsd"]) - num(x["costUsd"]));
  const members: Obj[] = [];
  for (const m of v.members) { let on = false; let at = 0; for (const d of m.devices) { if (d.online) on = true; if (d.at > at) at = d.at; } members.push({ name: m.name, devices: m.devices.length, online: on, lastSyncAt: at ? new Date(at).toISOString() : null }); }
  return { team: t.id, room: room || null, period: per, by, rows, members, budget: null, stale: [] };
}
export function sessionsObj(t: TeamState, room: string, member: string, limit: number, now: number): Obj {
  const v = buildView(t, room, now, 0); const rows: Obj[] = [];
  for (const r of v.rows) {
    if (!memberIs(v, t, r, member)) continue; if (limit > 0 && rows.length >= limit) break;
    const o: Obj = { member: { id: r.member, name: nameOf(v, r.member) }, device: { id: r.device }, rooms: r.rooms, mine: r.mine };
    for (const k of Object.keys(r.s)) o[k] = r.s[k];
    rows.push(o);
  }
  return { team: t.id, room: room || null, rows };
}
export function activityObj(t: TeamState, since: number, now: number): Obj {
  const o: Obj[] = []; for (const a of activity(t, since, now)) o.push({ at: new Date(a.at).toISOString(), actor: a.actor, kind: a.kind, room: a.room || null, text: a.text });
  return { team: t.id, events: o };
}
