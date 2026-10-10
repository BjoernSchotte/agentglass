// agentglass — `agentglass team …` (fleet-teams spec 2, 3; Task 8a): status, create, invite, join with consent, sync,
// report, sessions. Every command has --json; errors through cliError (exit 2 usage, 3 not found, 5 mailbox). In agent
// mode a join never happens without --yes: the consent screen is printed as JSON and the command exits 2 — a person
// must read what leaves before it does.
// SPDX-License-Identifier: Apache-2.0
import { readSync, writeSync, readdirSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { H, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import { sessions } from "../../model/sessions.ts";
import { type Obj, obj, str } from "../../util/json.ts";
function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }
import { HOME } from "../../util/fs.ts";
import { agentHost, cliError, parseDur } from "../agentenv.ts";
import { addCmd, opt, cmdOf, cmdText, helpOf, wantsHelp } from "../clihelp.ts";
import { discover } from "../cli.ts";
import { identSync } from "../query/project.ts";
import { type Invite, parseInvite } from "./code.ts";
import { newMember } from "./keys.ts";
import { type MemberPub } from "./manifest.ts";
import { type Room, type RoomShare, scopeMatch, shareKey } from "./policy.ts";
import { dirMailbox } from "./mailbox.ts";
import { publishRoom } from "./publish.ts";
import { type TeamState, loadTeams } from "./state.ts";
import { createTeam, makeInvite, readCard, requestJoin, syncOnce, MAX_ROOMS } from "./sync.ts";
import { type TeamRow, type TeamView, buildView, viewCost } from "./view.ts";

function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
function flag(a: string[], f: string): boolean { return a.indexOf(f) >= 0; }
function val(a: string[], f: string): string { const i = a.indexOf(f); return i >= 0 && i + 1 < a.length ? a[i + 1] ?? "" : ""; }
function vals(a: string[], f: string): string[] { const o: string[] = []; for (let i = 0; i < a.length - 1; i++) if (a[i] === f) o.push(a[i + 1] ?? ""); return o; }
function list(s: string): string[] { const o: string[] = []; for (const x of s.split(",")) if (x.trim()) o.push(x.trim()); return o; }
function line(q: string): string { writeSync(1, q); const b = new Uint8Array(512); let n = 0; try { n = readSync(0, b, 0, 512, null); } catch (e) { return ""; } return new TextDecoder().decode(b.subarray(0, n)).trim(); }
function tty(): boolean { return process.stdout.isTTY === true && process.stdin.isTTY === true && !agentHost().on; }
function money(u: number): string { return "$" + (u >= 100 ? u.toFixed(0) : u.toFixed(2)); }

// ── where mailboxes live: the folders sync tools create (spec 3) ──
export function syncRoots(): string[] {
  const o: string[] = [join(HOME, "Sync"), join(HOME, "Dropbox"), join(HOME, "Google Drive"), join(HOME, "OneDrive"), join(HOME, "iCloud Drive"), join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs")];
  try { for (const n of readdirSync(join(HOME, "Library", "CloudStorage"))) o.push(join(HOME, "Library", "CloudStorage", n)); } catch (e) { /* not macOS */ }
  const ok: string[] = []; for (const p of o) { try { if (lstatSync(p).isDirectory()) ok.push(p); } catch (e) { /* none */ } }
  return ok;
}
// the folder holding team `team`: <root>/<where> first, then ≤ 2 levels under each root (≤ 200 directories)
function findMailbox(team: string, where: string): string {
  const named = (d: string): boolean => { try { return str((JSON.parse(new TextDecoder().decode(dirMailbox(d).get("agentglass-team.json", 4096) ?? new Uint8Array(0))) as Obj)["team"]) === team; } catch (e) { return false; } };
  const roots = syncRoots(); let seen = 0;
  for (const r of roots) if (where && named(join(r, where))) return join(r, where);
  for (const r of roots) {
    let l1: string[] = []; try { l1 = readdirSync(r); } catch (e) { continue; }
    for (const a of l1) {
      if (++seen > 200) return ""; const d = join(r, a); if (named(d)) return d;
      let l2: string[] = []; try { l2 = readdirSync(d); } catch (e) { continue; }
      for (const b of l2) { if (++seen > 200) return ""; if (named(join(d, b))) return join(d, b); }
    }
  }
  return "";
}
function pickTeam(a: string[]): TeamState {
  const ts = loadTeams(); const want = val(a, "--team");
  if (!ts.length) cliError("not_found", "no team on this machine", "agentglass team create <name> | agentglass team join <code>", 3);
  if (!want) { if (ts.length === 1) return ts[0] as TeamState; cliError("usage", "you are in " + String(ts.length) + " teams: name one with --team", ts.map((t: TeamState) => (t.priv ? t.priv.name : t.id)).join(", "), 2); }
  for (const t of ts) if (t.id.startsWith(want) || (t.priv && t.priv.name === want)) return t;
  return cliError("not_found", "no team " + want + " here", "agentglass team lists your teams", 3);
}

// ── what this machine has in a room's scope (the consent screen's "you have") ──
interface Have { repo: string; n: number; by: { [h: string]: number }; since: number }
function haveFor(scope: string[]): Have[] {
  const by = new Map<string, Have>();
  for (const s of sessions.values()) {
    if (s.depth !== 0 || s.parent) continue;
    const id = identSync(s); const k = id ? shareKey(id.key) : ""; if (!k) continue;
    let ok = false; for (const p of scope) if (scopeMatch(p, k)) ok = true; if (!ok) continue;
    let h = by.get(k); if (!h) { h = { repo: k, n: 0, by: {}, since: s.mtime }; by.set(k, h); }
    h.n++; h.by[s.h] = (h.by[s.h] ?? 0) + 1; if (s.mtime < h.since) h.since = s.mtime;
  }
  const o: Have[] = []; for (const h of by.values()) o.push(h); o.sort((x: Have, y: Have) => y.n - x.n);
  return o;
}
function monthStart(now: number): number { const d = new Date(now); return now - (((d.getDate() - 1) * 24 + d.getHours()) * 60 + d.getMinutes()) * 60000 - d.getSeconds() * 1000 - d.getMilliseconds(); }
function day(t: number): string { return new Date(t).toISOString().slice(0, 10); }

// ── team (status) ──
function status(a: string[]): void {
  const ts = loadTeams(); const json = flag(a, "--json"); const now = Date.now();
  const o: Obj[] = [];
  for (const t of ts) {
    const m = t.manifest; const p = t.priv; const v = buildView(t, "", now, 0);
    let me: MemberPub | null = null; if (m) for (const x of m.members) if (x.id === t.me.id) me = x;
    const rooms: Obj[] = [];
    if (p && m) for (const r of p.rooms) {
      let ep = r.epoch; for (const q of m.rooms) if (q.id === r.id) ep = q.epoch;
      let sh: Obj | null = null; for (const s of t.policy) if (s.room === r.id) sh = { on: s.on, repos: s.repos, level: s.level, since: s.since, paused: s.paused };
      rooms.push({ id: r.id, name: r.name, scope: r.scope, level: r.level, epoch: ep, budget: r.budgetUsd || null, share: sh });
    }
    const members: Obj[] = []; for (const x of v.members) { let on = false; for (const d of x.devices) if (d.online) on = true; members.push({ id: x.id, name: x.name, devices: x.devices.length, online: on, sessions: x.sessions }); }
    o.push({ id: t.id, name: p ? p.name : "", mailbox: t.mailbox, kind: t.kind, me: { id: t.me.id, name: t.name, device: t.device }, admin: !!me && me.admin, joined: !!me && !t.req, rooms, members, pending: 0, problems: [] });
  }
  if (json) { out(JSON.stringify({ teams: o })); return; }
  if (!o.length) { out("no team yet: agentglass team create <name> (or team join <code>)"); return; }
  for (const x of o) {
    out(String(x["name"]) + "  (" + String(x["id"]) + ")  " + String(x["mailbox"]));
    for (const r of x["rooms"] as Obj[]) out("  room " + String(r["name"]) + "  " + (r["scope"] as string[]).join(", ") + "  " + String(r["level"]) + (r["share"] ? "  · you share " + ((r["share"] as Obj)["repos"] as string[]).join(", ") : "  · you share nothing"));
    for (const mm of x["members"] as Obj[]) out("  " + (mm["online"] ? "●" : "○") + " " + String(mm["name"] || mm["id"]) + "  " + String(mm["devices"]) + " device(s) · " + String(mm["sessions"]) + " session(s)");
  }
}

// ── create ──
function create(a: string[]): void {
  const name = a[2] ?? ""; if (!name || name.startsWith("-")) cliError("usage", "team create needs a name", "agentglass team create acme --dir ~/Sync/agentglass-acme", 2);
  const json = flag(a, "--json"); const personal = flag(a, "--personal"); const now = Date.now();
  let dir = val(a, "--dir");
  if (!dir) {
    const roots = syncRoots();
    if (!roots.length || !tty()) cliError("usage", "where should the team's files meet?", "--dir <a folder your sync tool shares> (Syncthing, Dropbox, iCloud Drive, NFS …)", 2);
    const prop = join(roots[0] ?? "", "agentglass-" + name);
    if (line("Team folder: " + prop + " — use it? [Y/n] ").toLowerCase().startsWith("n")) cliError("usage", "no folder chosen", "--dir <path>", 2);
    dir = prop;
  }
  dir = resolve(dir.startsWith("~/") ? join(HOME, dir.slice(2)) : dir);
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { /* createTeam says why */ }
  const level = val(a, "--level") === "titles" ? "titles" : "numbers";
  const rooms: Room[] = [];
  for (const r of vals(a, "--room")) { const i = r.indexOf("="); if (i <= 0) cliError("usage", "--room <name>=<pattern>[,<pattern>…]", "--room backend=github.com/acme/api,github.com/acme/web", 2); rooms.push({ id: "", name: r.slice(0, i), scope: list(r.slice(i + 1)), level, budgetUsd: 0, epoch: 1 }); }
  if (!rooms.length) {
    if (personal) rooms.push({ id: "", name: "all", scope: ["*"], level: "titles", budgetUsd: 0, epoch: 1 });
    else { discover(); const hv = haveFor(["**"]); const sc: string[] = []; for (const h of hv) if (now - h.since < 30 * 86400000 || true) sc.push(h.repo); if (!sc.length) cliError("usage", "no repo with a git remote here to start a room with", "--room <name>=<pattern>", 2); rooms.push({ id: "", name: "main", scope: sc.slice(0, 50), level, budgetUsd: 0, epoch: 1 }); }
  }
  if (rooms.length > MAX_ROOMS) cliError("usage", "at most " + String(MAX_ROOMS) + " rooms", "", 2);
  const me = val(a, "--name") || process.env["USER"] || "me";
  const c = createTeam(name, dir, rooms, personal, now, me); const t = c.t;
  if (!t) return cliError("mailbox", c.err, "", 5);
  if (personal) { t.policy = [{ room: t.priv ? t.priv.rooms[0]?.id ?? "" : "", on: true, repos: ["*"], level: "titles", since: monthStart(now), paused: false }]; }
  const ids: string[] = []; if (t.priv) for (const r of t.priv.rooms) ids.push(r.id);
  const iv = makeInvite(t, ids, 1, 86400000, personal, false, now);
  if (json) { out(JSON.stringify({ ok: true, team: { id: t.id, name }, mailbox: dir, rooms: rooms.map((r: Room) => r.name), invite: iv.err ? null : { code: iv.code, link: "agentglass://team/join/" + iv.code, uses: 1, expires: new Date(now + 86400000).toISOString() } })); return; }
  out("Team " + name + " created in " + dir);
  if (iv.code) inviteText(name, rooms, iv.code, 1, now + 86400000, dir);
}
function inviteText(team: string, rooms: Room[], code: string, uses: number, exp: number, dir: string): void {
  const rn: string[] = []; for (const r of rooms) rn.push(r.name);
  out("Invite to " + team + " (rooms: " + rn.join(", ") + ") — " + String(uses) + " use" + (uses === 1 ? "" : "s") + ", expires " + new Date(exp).toISOString().slice(0, 16).split("T").join(" "));
  out("  agentglass team join " + code + "  (" + String(code.length) + " characters)");
  out("  link: agentglass://team/join/" + code);
  out("Mailbox: " + dir + " — share this folder with them first (Syncthing: add their device to the folder).");
}
function invite(a: string[]): void {
  const t = pickTeam(a); const now = Date.now(); const p = t.priv; if (!p) cliError("not_found", "this machine does not hold the team yet", "agentglass team sync", 3);
  const want = list(val(a, "--rooms")); const ids: string[] = []; const rs: Room[] = [];
  for (const r of p ? p.rooms : []) if (!want.length || want.indexOf(r.name) >= 0 || want.indexOf(r.id) >= 0) { ids.push(r.id); rs.push(r); }
  if (want.length && ids.length !== want.length) cliError("not_found", "no room " + want.join(","), "agentglass team lists the rooms", 3);
  const uses = Number(val(a, "--uses") || "1"); const exp = val(a, "--expires") ? parseDur(val(a, "--expires")) : 86400000;
  const r = makeInvite(t, ids, uses, exp, flag(a, "--device"), flag(a, "--approve"), now);
  if (r.err) cliError("usage", r.err, "", 2);
  if (flag(a, "--json")) { out(JSON.stringify({ ok: true, code: r.code, link: "agentglass://team/join/" + r.code, uses, expires: new Date(now + exp).toISOString(), rooms: rs.map((x: Room) => x.name) })); return; }
  inviteText(p ? p.name : t.id, rs, r.code, uses, now + exp, t.mailbox);
}

// ── join: the consent screen, the dry run, the request ──
function join_(a: string[]): void {
  const raw = a[2] ?? ""; const json = flag(a, "--json"); const now = Date.now();
  const pc = parseInvite(raw.startsWith("agentglass://team/join/") ? raw.slice("agentglass://team/join/".length) : raw);
  const code = pc.i as Invite; if (!pc.i) cliError("usage", "invite code: " + pc.err, "agentglass team join agt1-…", 2);
  let dir = val(a, "--dir"); if (dir) dir = resolve(dir.startsWith("~/") ? join(HOME, dir.slice(2)) : dir); else dir = findMailbox(code.team, code.where);
  if (!dir) cliError("mailbox", "the folder " + code.where + " is not here yet: accept the share in Syncthing/Dropbox, then run this again", "--dir <path> if it is elsewhere", 2);
  const mb = dirMailbox(dir); const cr = readCard(code, mb); const card = cr.card;
  if (!card) return cliError("mailbox", cr.err, "", 5);
  discover();
  const name = (val(a, "--name") || process.env["USER"] || "").trim();
  const since = val(a, "--since") === "now" ? now : monthStart(now);
  const rooms: Room[] = [];
  for (const x of (card["rooms"] as Obj[]) ?? []) { const sc: string[] = []; for (const p of (x["scope"] as string[]) ?? []) sc.push(String(p)); rooms.push({ id: str(x["id"]), name: str(x["name"]), scope: sc, level: x["level"] === "titles" ? "titles" : "numbers", budgetUsd: typeof x["budgetUsd"] === "number" ? x["budgetUsd"] : 0, epoch: 1 }); }
  const screen: Obj[] = [];
  for (const r of rooms) { const hv = haveFor(r.scope); screen.push({ name: r.name, scope: r.scope, level: r.level, budgetUsd: r.budgetUsd || null, youHave: hv.map((h: Have) => ({ repo: h.repo, sessions: h.n, byHarness: h.by, since: day(h.since) })) }); }
  const pick = list(val(a, "--share")); const repos = vals(a, "--repos");
  const shares: RoomShare[] = [];
  for (const r of rooms) if (pick.indexOf(r.name) >= 0) { const rs: string[] = repos.length ? repos : haveFor(r.scope).map((h: Have) => h.repo); shares.push({ room: r.id, on: true, repos: rs, level: r.level, since, paused: false }); }
  if (pick.length && shares.length !== pick.length) cliError("not_found", "no room " + pick.join(",") + " in this invite", "rooms: " + rooms.map((r: Room) => r.name).join(", "), 3);
  const what: Obj = { team: card["team"], admins: card["admins"], members: card["members"], name, device: "", rooms: screen,
    leaves: "per session: harness, model, start/end, live state, tokens, cost + billing mode, tools, errors, lines ±, commits made, skill names (your skills.hide applies), repo — titles only in 'titles' rooms",
    never: "prompts, outputs, tool arguments, file paths, cwd, branch, hostnames, other repos", history: day(since), where: dir };
  if (flag(a, "--dry-run")) {
    const tmp = newMember(); const plain: Obj = {};
    for (const s of shares) { let r: Room | null = null; for (const x of rooms) if (x.id === s.room) r = x; if (!r) continue; plain[r.name] = publishRoom(mb, code.team, r, s, tmp, "0000000000000000", now, true).plain; }
    if (json) { out(JSON.stringify({ dryRun: true, plain })); return; }
    for (const k of Object.keys(plain)) { out("── room " + k + " (exactly the plaintext that would be sealed) ──"); for (const l of plain[k] as string[]) out(l); }
    return;
  }
  let ok = flag(a, "--yes");
  if (!ok) {
    if (!tty()) { out(JSON.stringify({ consent: "a person must consent: run it in a terminal or pass --yes after reading this", screen: what })); process.exit(2); }
    out("Join " + str(card["team"]) + " as " + (name || "?") + "   (any name or a pseudonym; --name)");
    out("Rooms you can share into (nothing is shared until you pick):");
    for (const r of screen) { out("  " + str(r["name"]) + "   " + (r["scope"] as string[]).join(", ") + "   level: " + str(r["level"])); const hv = r["youHave"] as Obj[]; out("        you have: " + (hv.length ? hv.map((h: Obj) => str(h["repo"]) + "  " + String(h["sessions"]) + " sessions").join(", ") : "nothing that matches")); }
    out("What leaves this machine for each picked repo, sealed for the room's members:"); out("  " + str(what["leaves"])); out("  never: " + str(what["never"]));
    out("History: from " + day(since) + " (--since now: from now on)"); out("Where: " + dir + " (encrypted; the folder and the sync tool cannot read it)");
    if (!pick.length) { const ans = list(line("Share into (room names, comma; empty = nothing yet): ")); for (const r of rooms) if (ans.indexOf(r.name) >= 0) shares.push({ room: r.id, on: true, repos: haveFor(r.scope).map((h: Have) => h.repo), level: r.level, since, paused: false }); }
    ok = line("Join " + str(card["team"]) + " now? [y/N] ").toLowerCase().startsWith("y");
    if (!ok) { out("nothing joined, nothing shared"); return; }
  }
  if (!name) cliError("usage", "a name to show the team", "--name <name>", 2);
  const j = requestJoin(code, mb, name, shares, now); const t = j.t;
  if (!t) return cliError("mailbox", j.err, "", 5);
  // wait for an admin's agentglass to admit (--wait seconds, default 20)
  const wait = Number(val(a, "--wait") || "20") * 1000; let admitted = false; const t0 = Date.now();
  while (Date.now() - t0 <= wait) {
    const so = syncOnce(t, Date.now(), false); const m = t.manifest;
    let in_ = false; if (m) for (const x of m.members) if (x.id === t.me.id) in_ = true;
    if (in_ && !t.req) { admitted = true; break; }
    void so;
    if (wait <= 0) break;
    const until = Date.now() + 2000; while (Date.now() < until) { /* poll every 2 s */ }
  }
  if (json) { out(JSON.stringify({ ok: true, team: t.id, admitted, request: admitted ? null : "sent" })); return; }
  out(admitted ? "joined " + str(card["team"]) + ": publishing started" : "request sent — an admin's agentglass admits you when it next syncs (every minute while its TUI is open); `agentglass team` shows it; publishing starts by itself then");
}

// ── sync ──
function sync(a: string[]): void {
  const ts = val(a, "--team") ? [pickTeam(a)] : loadTeams(); const now = Date.now(); const o: Obj[] = [];
  for (const t of ts) { const r = syncOnce(t, now, false); o.push({ team: t.id, admitted: r.admitted, pending: r.pending, published: r.published, fetched: r.fetched, removed: r.removed, wiped: r.wiped, problems: r.problems }); }
  if (flag(a, "--json")) { out(JSON.stringify({ teams: o })); return; }
  for (const x of o) out(String(x["team"]) + ": published " + String((x["published"] as string[]).length) + ", admitted " + String((x["admitted"] as string[]).length) + ((x["problems"] as string[]).length ? " — " + (x["problems"] as string[]).join("; ") : ""));
}

// ── report, sessions ──
function nameOf(v: TeamView, id: string): string { for (const m of v.members) if (m.id === id) return m.name; return id.slice(0, 8); }
function memberIs(v: TeamView, t: TeamState, r: TeamRow, want: string): boolean { return !want || (want === "me" ? r.member === t.me.id : nameOf(v, r.member) === want || r.member.startsWith(want)); }
function roomIs(t: TeamState, want: string): string { if (!want || !t.priv) return ""; for (const r of t.priv.rooms) if (r.name === want || r.id === want) return r.id; cliError("not_found", "no room " + want, "", 3); return ""; }
function report(a: string[]): void {
  const t = pickTeam(a); const now = Date.now(); const by = val(a, "--by") || "member"; const per = val(a, "--period") || "m";
  if (["member", "device", "harness", "repo", "room"].indexOf(by) < 0) cliError("usage", "--by member|device|harness|repo|room", "", 2);
  const room = roomIs(t, val(a, "--room")); const v = buildView(t, room, now, 0); const mw = val(a, "--member");
  const groups = new Map<string, Obj>();
  for (const r of v.rows) {
    if (!memberIs(v, t, r, mw)) continue;
    const one: TeamView = { team: v.team, room: v.room, at: v.at, members: v.members, rows: [r], skipped: [], truncated: 0 }; const c = viewCost(one);
    const usd = per === "d" ? c.today : per === "w" ? c.week : c.month;
    const ks: string[] = by === "member" ? [nameOf(v, r.member)] : by === "device" ? [r.device] : by === "harness" ? [str(r.s["harness"])] : by === "repo" ? [str((r.s["repo"] as Obj | null)?.["key"] ?? "")] : r.rooms;
    for (const k of ks) {
      let g = groups.get(k); if (!g) { g = { key: k, sessions: 0, live: 0, tokens: 0, costUsd: 0, harnesses: [] as string[] }; groups.set(k, g); }
      g["sessions"] = (g["sessions"] as number) + 1; if (r.s["live"] === true) g["live"] = (g["live"] as number) + 1;
      const tk = obj(r.s["tokens"]); if (tk) g["tokens"] = (g["tokens"] as number) + num(tk["in"]) + num(tk["out"]) + num(tk["cacheRead"]) + num(tk["cacheWrite"]);
      g["costUsd"] = Math.round(((g["costUsd"] as number) + usd) * 1e6) / 1e6;
      const hs = g["harnesses"] as string[]; const h = str(r.s["harness"]); if (h && hs.indexOf(h) < 0) hs.push(h);
    }
  }
  const rows: Obj[] = []; for (const g of groups.values()) rows.push(g); rows.sort((x: Obj, y: Obj) => (y["costUsd"] as number) - (x["costUsd"] as number));
  const members: Obj[] = []; for (const m of v.members) { let on = false; let at = 0; for (const d of m.devices) { if (d.online) on = true; if (d.at > at) at = d.at; } members.push({ name: m.name, devices: m.devices.length, online: on, lastSyncAt: at ? new Date(at).toISOString() : null }); }
  if (flag(a, "--json")) { out(JSON.stringify({ team: t.id, room: room || null, period: per, by, rows, members, budget: null, stale: [] })); return; }
  out("team " + (t.priv ? t.priv.name : t.id) + " · by " + by + " · " + (per === "d" ? "today" : per === "w" ? "7 days" : "this month"));
  for (const g of rows) out("  " + String(g["key"]).padEnd(20) + "  " + money(g["costUsd"] as number).padStart(9) + "  " + String(g["sessions"]) + " sessions" + ((g["live"] as number) ? " · " + String(g["live"]) + " live" : ""));
}
function sessionsCli(a: string[]): void {
  const t = pickTeam(a); const now = Date.now(); const room = roomIs(t, val(a, "--room")); const v = buildView(t, room, now, 0);
  const mw = val(a, "--member"); const lim = Number(val(a, "--limit") || "0");
  const rows: Obj[] = [];
  for (const r of v.rows) {
    if (!memberIs(v, t, r, mw)) continue; if (lim > 0 && rows.length >= lim) break;
    const o: Obj = { member: { id: r.member, name: nameOf(v, r.member) }, device: { id: r.device }, rooms: r.rooms, mine: r.mine };
    for (const k of Object.keys(r.s)) o[k] = r.s[k];
    rows.push(o);
  }
  if (flag(a, "--json")) { out(JSON.stringify({ team: t.id, room: room || null, rows })); return; }
  for (const o of rows) { const m = o["member"] as Obj; out(String(o["updated"]).slice(0, 16).split("T").join(" ") + "  " + String(m["name"]).padEnd(12) + "  " + String(o["harness"]).padEnd(8) + "  " + String(o["status"]) + "  " + (o["title"] ? String(o["title"]) : String((o["repo"] as Obj | null)?.["key"] ?? ""))); }
}

// ── help and dispatch ──
const SUBS = ["create", "invite", "join", "sync", "report", "sessions", "status"];
const JSON_OPT = opt("--json", "", "the result as JSON", "", []);
const TEAM_OPT = opt("--team", "<t>", "the team (when you are in several)", "", []);
addCmd({ cmd: "team", usage: "agentglass team [--json]", summary: "your teams: rooms, members online, what you share (private team analytics: sealed, no server)", options: [JSON_OPT], fields: [], group: "cmd" });
addCmd({ cmd: "team create", usage: "agentglass team create <name> [--dir <path>] [--room <name>=<pattern>[,…]]… [--level numbers|titles] [--personal] [--name <me>]", summary: "a new team in a folder your sync tool shares; prints the first invite", options: [opt("--dir", "<path>", "the shared folder (default: under a detected sync root)", "", []), opt("--room", "<name>=<patterns>", "a room and its repo patterns (* within a segment, ** across)", "", []), opt("--level", "numbers|titles", "what a room shows (titles adds session titles and branches)", "numbers", ["numbers", "titles"]), opt("--personal", "", "a team of one: room all, your other devices join with a device invite", "", []), opt("--name", "<me>", "your display name", "", []), JSON_OPT], fields: [], group: "cmd" });
addCmd({ cmd: "team invite", usage: "agentglass team invite [--rooms a,b] [--uses N] [--expires 24h] [--device] [--approve]", summary: "an invite code (admins): rooms, uses, expiry; --device joins another device of yours", options: [TEAM_OPT, opt("--rooms", "a,b", "rooms granted (default all)", "", []), opt("--uses", "N", "how many may join with it", "1", []), opt("--expires", "<dur>", "valid for (≤ 30d)", "24h", []), opt("--device", "", "another device of yours", "", []), opt("--approve", "", "an admin admits each request", "", []), JSON_OPT], fields: [], group: "cmd" });
addCmd({ cmd: "team join", usage: "agentglass team join <code> [--dir <path>] [--name <me>] [--share <room>,…] [--repos <key>…] [--since month|now] [--dry-run] [--yes]", summary: "join with an invite: one consent screen names what leaves; --dry-run prints exactly that plaintext", options: [opt("--dir", "<path>", "the team folder (default: found under your sync roots)", "", []), opt("--name", "<me>", "your display name", "", []), opt("--share", "<rooms>", "rooms to share into (nothing until you pick)", "", []), opt("--repos", "<key>", "only these repos (default: yours in the room's scope)", "", []), opt("--since", "month|now", "history start", "month", ["month", "now"]), opt("--dry-run", "", "print what would leave; join nothing", "", []), opt("--yes", "", "consent without the screen (required in agent mode)", "", []), opt("--wait", "<s>", "wait for an admin to admit", "20", []), JSON_OPT], fields: [], group: "cmd" });
addCmd({ cmd: "team sync", usage: "agentglass team sync [--json]", summary: "one publish and fetch now (admins also admit, rotate, read leave notices)", options: [TEAM_OPT, JSON_OPT], fields: [], group: "cmd" });
addCmd({ cmd: "team report", usage: "agentglass team report [--room <r>] [--member <m>] [--by member|device|harness|repo|room] [--period d|w|m]", summary: "the team's cost and sessions per member, device, harness, repo or room", options: [TEAM_OPT, opt("--room", "<r>", "one room", "", []), opt("--member", "<m>", "one member (name, id prefix, me)", "", []), opt("--by", "member|device|harness|repo|room", "grouping", "member", []), opt("--period", "d|w|m", "today, 7 days, this month", "m", []), JSON_OPT], fields: [], group: "cmd" });
addCmd({ cmd: "team sessions", usage: "agentglass team sessions [--room <r>] [--member <m>] [--limit N]", summary: "the team's sessions as their members shared them (newest first)", options: [TEAM_OPT, opt("--room", "<r>", "one room", "", []), opt("--member", "<m>", "one member", "", []), opt("--limit", "N", "at most N rows", "", []), JSON_OPT], fields: [], group: "cmd" });
H.cli.unshift((args: string[]): boolean => {
  if (args[0] !== "team") return false;
  const sub = args[1] ?? ""; const name = SUBS.indexOf(sub) >= 0 && sub !== "status" ? "team " + sub : "team";
  if (wantsHelp(args)) { const r = cmdOf(name); if (r) out(helpOf(name, args, cmdText(r))); process.exit(0); }
  S.cli = true;
  if (sub === "create") create(args); else if (sub === "invite") invite(args); else if (sub === "join") join_(args);
  else if (sub === "sync") sync(args); else if (sub === "report") report(args); else if (sub === "sessions") sessionsCli(args);
  else if (!sub || sub === "status" || sub.startsWith("-")) status(args);
  else cliError("usage", "unknown team command " + sub, "agentglass team --help (team, create, invite, join, sync, report, sessions)", 2);
  return true;
});
