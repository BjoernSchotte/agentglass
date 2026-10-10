// agentglass — team sync (fleet-teams spec 3–5): create, invite, join, admission, key epochs, removal, leave.
// Admins write the manifest, invite cards, welcomes and key files; each device writes only its own join request, leave
// notice and room files. Keys travel sealed to the recipient's X25519 key; the manifest chain decides who belongs.
//   invites/<id>.card            the consent screen's data, sealed with a key derived from the invite secret
//   join/<invite>-<rand>.req     {to:[{id, box}]}: the request sealed to each admin; inside, the joiner's keys, device,
//                                name, a proof derived from the invite secret (its hash is the manifest's verifier) and
//                                the joiner's signature (it holds the key it names)
//   welcome/<member>-<device>.key  sealed to the joiner: team key, room keys (a device invite: the member's own keys)
//   keys/<room>/<epoch>/<member>.key  a room key (room = the team id: the team key) sealed to that member
//   leave/<member>.tomb          signed: delete what you hold of me
// SPDX-License-Identifier: Apache-2.0
import { join, basename } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { type Obj, obj, arr, str, parse } from "../../util/json.ts";
import { hex, unhex, b64url, unb64url, randomBytes } from "../../util/rand.ts";
import { hostId } from "../../util/hostid.ts";
import { sign, verify, seal, sealOpen, lock, unlock, kdf, hash16, signKeys, boxKeys, wipe } from "./crypto.ts";
import { type MemberKeys, teamDir, newMember, saveMember, roomKey, saveRoomKey } from "./keys.ts";
import { type Manifest, type MemberPub, type InvitePub, type RoomPub, type Private, signManifest, readManifest, sealPrivate, rootFp, cat } from "./manifest.ts";
import { type Room, type RoomShare } from "./policy.ts";
import { type Invite, inviteCode, deviceId } from "./code.ts";
import { type Mailbox, NAMES, dirMailbox, roomFile } from "./mailbox.ts";
import { type TeamState, loadTeam, saveMeta, savePolicy, saveManifest, teamKey, saveTeamKey, mbOf, privOf, dropTeam } from "./state.ts";
import { publishRoom } from "./publish.ts";

export const MAX_DEVICES = 64; export const MAX_ROOMS = 16;
export interface SyncOut { admitted: string[]; pending: string[]; published: string[]; fetched: number; removed: string[]; wiped: string[]; problems: string[] }
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder("utf-8").decode(b);
function newId(): string { return hex(randomBytes(8)); }
function label(dev: string): string { return (process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : "host") + "-" + dev.slice(0, 4); }
function proofOf(secret: Uint8Array): Uint8Array { return kdf(secret, "agentglass-team/v1|join-proof", 32); }
function verifierOf(proof: Uint8Array): string { return hex(kdf(proof, "agentglass-team/v1|verifier", 32)); }
function cardKey(secret: Uint8Array): Uint8Array { return kdf(secret, "agentglass-team/v1|card", 32); }

// ── the manifest chain ──
function memberOf(m: Manifest, id: string): MemberPub | null { for (const x of m.members) if (x.id === id) return x; return null; }
function roomOf(m: Manifest, id: string): RoomPub | null { for (const r of m.rooms) if (r.id === id) return r; return null; }
function current(m: Manifest, id: string): boolean { const x = memberOf(m, id); return !!x && x.removedAt === 0; }
interface MFile { v: number; s: string; n: string }
// the newest manifest the folder holds that follows prev (null: from version 1); the bytes of the last accepted
function chain(mb: Mailbox, prev: Manifest | null): { m: Manifest | null; b: Uint8Array | null; problems: string[] } {
  const fs: MFile[] = [];
  for (const f of mb.list("manifest")) { const x = NAMES.manifest.exec("manifest/" + f.name); if (x) fs.push({ v: Number(x[1] ?? "0"), s: x[2] ?? "", n: f.name }); }
  fs.sort((a: MFile, b: MFile) => a.v - b.v || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  let m = prev; let mb2: Uint8Array | null = null; const problems: string[] = [];
  for (const f of fs) {
    if (m && (f.v < m.version || (f.v === m.version && f.s <= m.signer))) continue;
    const b = mb.get("manifest/" + f.n, 16777216); if (!b) continue;
    const r = readManifest(b, m);
    if (r.m) { m = r.m; mb2 = b; } else if (m && f.v > m.version) problems.push("manifest/" + f.n + ": " + r.err);
  }
  return { m, b: mb2, problems };
}
// the next version of t's manifest: copied, version + 1; the caller changes it and calls writeManifest
function nextOf(m: Manifest, now: number): Manifest {
  const members: MemberPub[] = []; for (const x of m.members) members.push({ id: x.id, signPk: x.signPk, boxPk: x.boxPk, devices: x.devices.slice(), admin: x.admin, removedAt: x.removedAt });
  const rooms: RoomPub[] = []; for (const r of m.rooms) rooms.push({ id: r.id, epoch: r.epoch, members: r.members.slice() });
  const invites: InvitePub[] = []; for (const i of m.invites) invites.push({ id: i.id, verifier: i.verifier, expires: i.expires, uses: i.uses, rooms: i.rooms.slice(), device: i.device, approve: i.approve, by: i.by });
  return { team: m.team, version: m.version + 1, root: m.root, signer: "", at: Math.max(now, m.at + 1), tk: m.tk, members, rooms, invites, priv: m.priv };
}
function writeManifest(t: TeamState, m: Manifest, p: Private | null): string {
  if (p) { const k = teamKey(t, m.tk); if (!k) return "no team key for epoch " + String(m.tk); m.priv = sealPrivate(p, k); }
  const b = signManifest(m, t.me);
  const r = readManifest(b, t.manifest); if (!r.m) return "the new manifest is refused: " + r.err;
  const e = mbOf(t).put("manifest/" + String(m.version) + "-" + t.me.id + ".agm", b); if (e) return e;
  t.manifest = r.m; t.priv = privOf(t);
  return saveManifest(t, b);
}
function privCopy(p: Private): Private {
  const names: { [id: string]: string } = {}; for (const k of Object.keys(p.names)) names[k] = p.names[k] ?? "";
  const rooms: Room[] = []; for (const r of p.rooms) rooms.push({ id: r.id, name: r.name, scope: r.scope.slice(), level: r.level, budgetUsd: r.budgetUsd, epoch: r.epoch });
  return { name: p.name, names, rooms };
}
// a key sealed to member x: keys/<room>/<epoch>/<x>.key (room = the team id for the team key)
function putKey(mb: Mailbox, room: string, epoch: number, x: MemberPub, key: Uint8Array): string {
  const pk = unhex(x.boxPk); if (!pk) return "bad key of " + x.id;
  return mb.put("keys/" + room + "/" + String(epoch) + "/" + x.id + ".key", seal(pk, key));
}

// ── create ──
export function createTeam(name: string, mailbox: string, rooms: Room[], personal: boolean, now: number): { t: TeamState | null; err: string } {
  if (!name.trim()) return { t: null, err: "a team needs a name" };
  if (rooms.length < 1 || rooms.length > MAX_ROOMS) return { t: null, err: "a team has 1 to " + String(MAX_ROOMS) + " rooms" };
  const mb = dirMailbox(mailbox); const why = mb.problem(); if (why) return { t: null, err: why };
  if (existsSync(join(mailbox, "agentglass-team.json"))) return { t: null, err: mailbox + " already holds a team: pick another folder" };
  const id = newId(); const me = newMember(); const dev = deviceId(id, hostId());
  const e1 = saveMember(id, me); if (e1) return { t: null, err: e1 };
  const t: TeamState = { id, mailbox, kind: "dir", me, device: dev, label: label(dev), req: "", manifest: null, priv: null, policy: [] };
  const tk = randomBytes(32); const e2 = saveTeamKey(t, 1, tk); wipe(tk); if (e2) return { t: null, err: e2 };
  const rs: Room[] = []; const rp: RoomPub[] = [];
  for (const r of rooms) {
    const rid = r.id || newId(); const k = randomBytes(32); const e = saveRoomKey(id, rid, 1, k); wipe(k); if (e) return { t: null, err: e };
    rs.push({ id: rid, name: r.name, scope: r.scope.slice(), level: r.level, budgetUsd: r.budgetUsd, epoch: 1 }); rp.push({ id: rid, epoch: 1, members: [me.id] });
  }
  const m: Manifest = { team: id, version: 1, root: hex(me.sign.pk), signer: "", at: now, tk: 1,
    members: [{ id: me.id, signPk: hex(me.sign.pk), boxPk: hex(me.box.pk), devices: [dev], admin: true, removedAt: 0 }], rooms: rp, invites: [], priv: new Uint8Array(0) };
  const p: Private = { name: name.trim(), names: {}, rooms: rs };
  if (personal) { /* one member, one room "all" (the caller passes it): the same machinery */ }
  const e3 = writeManifest(t, m, p); if (e3) return { t: null, err: e3 };
  const e4 = mb.put("agentglass-team.json", enc(JSON.stringify({ format: "agentglass-team/v1", team: id }) + "\n")); if (e4) return { t: null, err: e4 };
  const e5 = saveMeta(t) || savePolicy(t); if (e5) return { t: null, err: e5 };
  return { t, err: "" };
}

// ── invite ──
export function makeInvite(t: TeamState, rooms: string[], uses: number, expiresMs: number, device: boolean, approve: boolean, now: number): { code: string; err: string } {
  const m = t.manifest; const p = t.priv;
  if (!m || !p) return { code: "", err: "this machine does not hold the team yet (team sync)" };
  const me = memberOf(m, t.me.id); if (!me || !me.admin || me.removedAt) return { code: "", err: "only an admin invites" };
  for (const r of rooms) if (!roomOf(m, r)) return { code: "", err: "no room " + r };
  if (!(uses >= 1 && uses <= 100) || !(expiresMs > 0 && expiresMs <= 30 * 86400000)) return { code: "", err: "uses 1–100, expiry up to 30 days" };
  const secret = randomBytes(16); const iid = newId(); const exp = now + expiresMs;
  const n = nextOf(m, now);
  n.invites.push({ id: iid, verifier: verifierOf(proofOf(secret)), expires: exp, uses, rooms: rooms.slice(), device, approve, by: t.me.id });
  const admins: string[] = []; const members: string[] = [];
  for (const x of m.members) if (!x.removedAt) { const nm = p.names[x.id] ?? ""; members.push(nm); if (x.admin) admins.push(nm); }
  const rs: Obj[] = []; for (const r of p.rooms) if (rooms.indexOf(r.id) >= 0) rs.push({ id: r.id, name: r.name, scope: r.scope, level: r.level, budgetUsd: r.budgetUsd });
  const card = enc(JSON.stringify({ team: p.name, admins, members, rooms: rs, uses, expires: exp, device, approve }));
  const nonce = randomBytes(24); const l = lock(cardKey(secret), nonce, enc(iid), card);
  const e1 = mbOf(t).put("invites/" + iid + ".card", cat([nonce, l.mac, l.ct])); if (e1) return { code: "", err: e1 };
  const e2 = writeManifest(t, n, null); if (e2) return { code: "", err: e2 };
  const code = inviteCode({ v: 1, team: t.id, invite: iid, secret, root: rootFp(m.root), kind: "dir", where: basename(t.mailbox) });
  wipe(secret);
  return { code, err: "" };
}
// the consent screen's data: team, admins, members, rooms with scope and level (no key, no id of a member)
export function readCard(code: Invite, mb: Mailbox): { card: Obj | null; err: string } {
  const b = mb.get("invites/" + code.invite + ".card", 65536);
  if (!b || b.length < 40) return { card: null, err: "no invite card " + code.invite + " in " + mb.where + " (withdrawn, or the folder is not synced yet)" };
  const pt = unlock(cardKey(code.secret), b.subarray(0, 24), enc(code.invite), b.subarray(40), b.subarray(24, 40));
  if (!pt) return { card: null, err: "the invite card does not open: check the code" };
  return { card: obj(parse(dec(pt))), err: "" };
}

// ── join ──
export function requestJoin(code: Invite, mb: Mailbox, name: string, shares: RoomShare[], now: number): { t: TeamState | null; err: string } {
  const c = readCard(code, mb); if (!c.card) return { t: null, err: c.err };
  const ch = chain(mb, null); const m = ch.m;
  if (!m || m.team !== code.team) return { t: null, err: "no manifest of team " + code.team + " in " + mb.where };
  if (rootFp(m.root) !== code.root) return { t: null, err: "this folder's team is not the invite's (root key differs)" };
  let inv: InvitePub | null = null; for (const i of m.invites) if (i.id === code.invite) inv = i;
  if (!inv) return { t: null, err: "the invite is used up or withdrawn: ask for a new one" };
  if (now > inv.expires) return { t: null, err: "the invite expired: ask for a new one" };
  const me = newMember(); const dev = deviceId(m.team, hostId());
  const req = JSON.stringify({ team: m.team, invite: inv.id, member: { id: me.id, signPk: hex(me.sign.pk), boxPk: hex(me.box.pk) }, device: dev, label: label(dev), name: name.trim(), at: now });
  const pay = enc(JSON.stringify({ req, proof: b64url(proofOf(code.secret)), sig: b64url(sign(me.sign.sk, enc("agentglass-team/v1|join|" + req))) }));
  const to: Obj[] = [];
  for (const x of m.members) if (x.admin && !x.removedAt) { const pk = unhex(x.boxPk); if (pk) to.push({ id: x.id, box: b64url(seal(pk, pay)) }); }
  const rname = "join/" + inv.id + "-" + newId() + ".req";
  const t: TeamState = { id: m.team, mailbox: mb.where, kind: mb.kind, me, device: dev, label: label(dev), req: rname, manifest: m, priv: null, policy: shares.slice() };
  const e1 = saveMember(t.id, me) || saveMeta(t) || savePolicy(t); if (e1) return { t: null, err: e1 };
  if (ch.b) { const e2 = saveManifest(t, ch.b); if (e2) return { t: null, err: e2 }; }
  const e3 = mb.put(rname, enc(JSON.stringify({ v: 1, invite: inv.id, to }))); if (e3) return { t: null, err: e3 };
  return { t, err: "" };
}
interface Req { file: string; invite: string; member: MemberPub; device: string; name: string; proof: Uint8Array }
// one join request as this admin reads it; null when it is not for me or broken (err says why when it is worth naming)
function readReq(t: TeamState, mb: Mailbox, file: string): { r: Req | null; err: string } {
  const b = mb.get("join/" + file, 1048576); if (!b) return { r: null, err: "" };
  const o = obj(parse(dec(b))); if (!o) return { r: null, err: file + ": not a join request" };
  let mine = ""; for (const x of arr(o["to"])) { const e = obj(x); if (e && e["id"] === t.me.id) mine = str(e["box"]); }
  if (!mine) return { r: null, err: "" };
  const sb = unb64url(mine); const pt = sb ? sealOpen(t.me.box, sb) : null; if (!pt) return { r: null, err: file + ": does not open" };
  const p = obj(parse(dec(pt))); if (!p) return { r: null, err: file + ": broken" };
  const reqT = str(p["req"]); const q = obj(parse(reqT)); const mo = q ? obj(q["member"]) : null;
  if (!q || !mo) return { r: null, err: file + ": broken" };
  const member: MemberPub = { id: str(mo["id"]), signPk: str(mo["signPk"]), boxPk: str(mo["boxPk"]), devices: [str(q["device"])], admin: false, removedAt: 0 };
  const spk = unhex(member.signPk); const sig = unb64url(str(p["sig"])); const proof = unb64url(str(p["proof"]));
  if (!spk || spk.length !== 32 || hash16(spk) !== member.id || !/^[0-9a-f]{64}$/.test(member.boxPk) || !/^[0-9a-f]{16}$/.test(str(q["device"]))) return { r: null, err: file + ": keys invalid" };
  if (!sig || !verify(spk, enc("agentglass-team/v1|join|" + reqT), sig)) return { r: null, err: file + ": signature invalid" };
  if (!proof || q["team"] !== t.id || q["invite"] !== o["invite"]) return { r: null, err: file + ": not for this team" };
  return { r: { file, invite: str(q["invite"]), member, device: str(q["device"]), name: str(q["name"]).slice(0, 64), proof }, err: "" };
}
function devices(m: Manifest): number { let n = 0; for (const x of m.members) if (!x.removedAt) n += x.devices.length; return n; }
function deviceIn(m: Manifest, dev: string): boolean { for (const x of m.members) if (!x.removedAt && x.devices.indexOf(dev) >= 0) return true; return false; }
// the welcome for a joiner: the team key and the keys of its rooms (a device invite: also the member's own keys)
function welcome(t: TeamState, mb: Mailbox, to: MemberPub, dev: string, rooms: string[], own: MemberKeys | null): string {
  const m = t.manifest; if (!m) return "no manifest";
  const tk = teamKey(t, m.tk); if (!tk) return "no team key";
  const rs: unknown[] = []; for (const id of rooms) { const r = roomOf(m, id); const k = r ? roomKey(t.id, id, r.epoch) : null; if (r && k) rs.push([id, r.epoch, b64url(k)]); }
  const w: Obj = { team: t.id, tk: [m.tk, b64url(tk)], rooms: rs, member: own ? { sign: hex(own.sign.sk.subarray(0, 32)), box: hex(own.box.sk) } : null };
  const pk = unhex(to.boxPk); if (!pk) return "bad key";
  return mb.put("welcome/" + to.id + "-" + dev + ".key", seal(pk, enc(JSON.stringify(w))));
}
// one admission pass (admins): requests in join/, judged against the manifest held; approved = ids admitted by `admit`
function admitPass(t: TeamState, mb: Mailbox, now: number, approved: string[], out: SyncOut): void {
  const m0 = t.manifest; const self = m0 ? memberOf(m0, t.me.id) : null;
  if (!m0 || !t.priv || !self || !self.admin || self.removedAt) return;
  for (const f of mb.list("join")) {
    const m = t.manifest; const p = t.priv; if (!m || !p) return;
    const rr = readReq(t, mb, f.name); const r = rr.r; if (rr.err) out.problems.push("join/" + rr.err); if (!r) continue;
    const already = memberOf(m, r.member.id);
    if (already && already.devices.indexOf(r.device) >= 0) continue; // admitted before: the joiner removes its request
    let inv: InvitePub | null = null; for (const i of m.invites) if (i.id === r.invite) inv = i;
    if (!inv) { out.problems.push(r.name + " (" + r.device + "): invite used up or withdrawn"); continue; }
    if (now > inv.expires) { out.problems.push(r.name + " (" + r.device + "): invite expired"); continue; }
    if (verifierOf(r.proof) !== inv.verifier) { out.problems.push(r.name + " (" + r.device + "): wrong invite secret"); continue; }
    if (deviceIn(m, r.device)) { out.problems.push(r.name + " (" + r.device + "): device already in the team (one device belongs to one member)"); continue; }
    if (devices(m) >= MAX_DEVICES) { out.problems.push(r.name + ": the team has " + String(MAX_DEVICES) + " devices"); continue; }
    if (inv.device && inv.by !== t.me.id) continue; // another device of `by`: only its own devices hold the member keys
    if (inv.approve && approved.indexOf(r.member.id) < 0) { if (out.pending.indexOf(r.member.id) < 0) out.pending.push(r.member.id); continue; }
    const n = nextOf(m, now); const np = privCopy(p);
    let target = r.member; let own: MemberKeys | null = null;
    if (inv.device) {
      for (const x of n.members) if (x.id === inv.by) { x.devices.push(r.device); target = x; }
      own = t.me;
    } else {
      n.members.push(r.member); if (r.name) np.names[r.member.id] = r.name;
      for (const x of n.rooms) if (inv.rooms.indexOf(x.id) >= 0 && x.members.indexOf(r.member.id) < 0) x.members.push(r.member.id);
    }
    for (const x of n.invites) if (x.id === inv.id) x.uses = x.uses - 1;
    const keep: InvitePub[] = []; for (const x of n.invites) if (x.uses > 0) keep.push(x); n.invites = keep;
    const e1 = writeManifest(t, n, np); if (e1) { out.problems.push(e1); continue; }
    const granted: string[] = []; for (const x of n.rooms) if (x.members.indexOf(target.id) >= 0) granted.push(x.id);
    // the welcome goes to the joiner's own key (a device invite: the device's transport key, then the member's keys)
    const e2 = welcome(t, mb, r.member, r.device, granted, own); if (e2) { out.problems.push(e2); continue; }
    out.admitted.push(r.member.id);
  }
}
// an admin admits a request held by --approve
export function admit(t: TeamState, member: string, now: number): string {
  const out: SyncOut = { admitted: [], pending: [], published: [], fetched: 0, removed: [], wiped: [], problems: [] };
  admitPass(t, mbOf(t), now, [member], out);
  return out.admitted.indexOf(member) >= 0 ? "" : out.problems.join("; ") || "no request of " + member;
}

// ── keys this member is owed ──
function takeWelcome(t: TeamState, mb: Mailbox, out: SyncOut): void {
  const b = mb.get("welcome/" + t.me.id + "-" + t.device + ".key", 1048576); if (!b) return;
  const pt = sealOpen(t.me.box, b); if (!pt) { out.problems.push("welcome does not open"); return; }
  const w = obj(parse(dec(pt))); if (!w || w["team"] !== t.id) return;
  const tk = arr(w["tk"]); const tkb = unb64url(str(tk[1])); const tke = typeof tk[0] === "number" ? tk[0] : 0;
  if (tkb && tke >= 1) { saveTeamKey(t, tke, tkb); out.fetched++; }
  for (const x of arr(w["rooms"])) { const r = arr(x); const k = unb64url(str(r[2])); const e = typeof r[1] === "number" ? r[1] : 0; if (k && e >= 1 && saveRoomKey(t.id, str(r[0]), e, k) === "") out.fetched++; }
  const mo = obj(w["member"]);
  if (mo) { // a device invite: from now on this device is the member
    const seed = unhex(str(mo["sign"])); const bs = unhex(str(mo["box"]));
    if (seed && bs && seed.length === 32 && bs.length === 32) { const sk = signKeys(seed); const bk = boxKeys(bs); t.me = { id: hash16(sk.pk), sign: sk, box: bk }; saveMember(t.id, t.me); }
  }
  if (t.req) { mb.del(t.req); t.req = ""; saveMeta(t); }
}
function fetchKeys(t: TeamState, mb: Mailbox, out: SyncOut): void {
  const m = t.manifest; if (!m || !current(m, t.me.id)) return;
  const want: { room: string; epoch: number }[] = [{ room: t.id, epoch: m.tk }];
  for (const r of m.rooms) if (r.members.indexOf(t.me.id) >= 0) want.push({ room: r.id, epoch: r.epoch });
  for (const w of want) {
    if (roomKey(t.id, w.room, w.epoch)) continue;
    const b = mb.get("keys/" + w.room + "/" + String(w.epoch) + "/" + t.me.id + ".key", 4096); if (!b) continue;
    const k = sealOpen(t.me.box, b); if (k && k.length === 32 && saveRoomKey(t.id, w.room, w.epoch, k) === "") out.fetched++;
  }
}

// ── removal, leave ──
export function removeMember(t: TeamState, member: string, now: number): string {
  const m = t.manifest; const p = t.priv; if (!m || !p) return "this machine does not hold the team";
  const me = memberOf(m, t.me.id); if (!me || !me.admin || me.removedAt) return "only an admin removes";
  if (member === t.me.id) return "leave instead (team leave)";
  if (!current(m, member)) return "no current member " + member;
  const n = nextOf(m, now); const mb = mbOf(t);
  for (const x of n.members) if (x.id === member) x.removedAt = n.at;
  // every room it held: a new epoch with a new key, sealed to the members left; the team key the same way
  const stay: MemberPub[] = []; for (const x of n.members) if (!x.removedAt) stay.push(x);
  for (const r of n.rooms) {
    if (r.members.indexOf(member) < 0) continue;
    const keep: string[] = []; for (const id of r.members) if (id !== member) keep.push(id); r.members = keep; r.epoch = r.epoch + 1;
    const k = randomBytes(32); const e = saveRoomKey(t.id, r.id, r.epoch, k); if (e) return e;
    for (const x of stay) if (keep.indexOf(x.id) >= 0 && x.id !== t.me.id) { const e2 = putKey(mb, r.id, r.epoch, x, k); if (e2) return e2; }
    wipe(k);
  }
  n.tk = n.tk + 1; const tk = randomBytes(32); const e3 = saveTeamKey(t, n.tk, tk); if (e3) return e3;
  for (const x of stay) if (x.id !== t.me.id) { const e4 = putKey(mb, t.id, n.tk, x, tk); if (e4) return e4; }
  wipe(tk);
  const np = privCopy(p); const nn: { [id: string]: string } = {}; for (const k of Object.keys(np.names)) if (k !== member) nn[k] = np.names[k] ?? ""; np.names = nn;
  return writeManifest(t, n, np);
}
// leave: (unless keep) a signed notice asking peers to drop what they hold of me and my room files removed; then this
// machine forgets the team. An admin rotates the keys when it reads the notice
export function leaveTeam(t: TeamState, keep: boolean, now: number): string {
  const mb = mbOf(t);
  if (!keep) {
    const body = JSON.stringify({ team: t.id, member: t.me.id, at: now });
    const e = mb.put("leave/" + t.me.id + ".tomb", enc(JSON.stringify({ body, sig: b64url(sign(t.me.sign.sk, enc("agentglass-team/v1|leave|" + body))) }))); if (e) return e;
    const m = t.manifest;
    if (m) for (const r of m.rooms) for (const f of mb.list("rooms/" + r.id)) { const rf = roomFile(f.name); if (rf && rf.member === t.me.id) mb.del("rooms/" + r.id + "/" + f.name); }
  }
  if (t.req) mb.del(t.req);
  dropTeam(t.id);
  return "";
}
// leave notices: the members whose data this machine must drop (each once); an admin also removes them
function tombs(t: TeamState, mb: Mailbox, now: number, out: SyncOut): void {
  const m = t.manifest; if (!m) return;
  const wf = join(teamDir(), t.id, "wiped.json"); let done: string[] = []; try { for (const x of arr((obj(parse(readFileSync(wf, "utf8"))) ?? {})["ids"])) if (typeof x === "string") done.push(x); } catch (e) { done = []; }
  let changed = false;
  for (const f of mb.list("leave")) {
    const x = NAMES.leave.exec("leave/" + f.name); const id = x ? x[1] ?? "" : ""; if (!id || id === t.me.id) continue;
    const mp = memberOf(m, id); if (!mp) continue;
    const b = mb.get("leave/" + f.name, 65536); const o = b ? obj(parse(dec(b))) : null; if (!o) continue;
    const body = str(o["body"]); const bo = obj(parse(body)); const sig = unb64url(str(o["sig"])); const pk = unhex(mp.signPk);
    if (!bo || bo["member"] !== id || bo["team"] !== t.id || !sig || !pk || !verify(pk, enc("agentglass-team/v1|leave|" + body), sig)) { out.problems.push("leave/" + f.name + ": not signed by " + id); continue; }
    if (done.indexOf(id) < 0) { done.push(id); out.wiped.push(id); changed = true; }
    const me = memberOf(m, t.me.id);
    if (me && me.admin && !me.removedAt && !mp.removedAt) { const e = removeMember(t, id, now); if (e) out.problems.push(e); else out.removed.push(id); }
  }
  if (changed) { const tmp = wf + "." + String(process.pid) + ".tmp"; try { writeFileSync(tmp, JSON.stringify({ ids: done }), { mode: 0o600 }); renameSync(tmp, wf); } catch (e) { out.problems.push("cannot write " + wf); } }
}

// ── one sync ──
export function syncOnce(t: TeamState, now: number, dry: boolean): SyncOut {
  const out: SyncOut = { admitted: [], pending: [], published: [], fetched: 0, removed: [], wiped: [], problems: [] };
  const mb = mbOf(t); const why = mb.problem(); if (why) { out.problems.push(why); return out; }
  const ch = chain(mb, t.manifest); for (const p of ch.problems) out.problems.push(p);
  if (ch.m && ch.b && ch.m !== t.manifest) { t.manifest = ch.m; saveManifest(t, ch.b); }
  const m = t.manifest; if (!m) { out.problems.push("no manifest of team " + t.id + " in " + t.mailbox); return out; }
  takeWelcome(t, mb, out);
  fetchKeys(t, mb, out);
  t.priv = privOf(t);
  if (!dry) { admitPass(t, mb, now, [], out); tombs(t, mb, now, out); }
  const mm = t.manifest; const p = t.priv;
  if (mm && p && current(mm, t.me.id)) {
    for (const s of t.policy) {
      let room: Room | null = null; for (const r of p.rooms) if (r.id === s.room) room = r;
      const rp = roomOf(mm, s.room); if (!room || !rp || rp.members.indexOf(t.me.id) < 0) continue;
      const r = publishRoom(mb, t.id, { id: room.id, name: room.name, scope: room.scope, level: room.level, budgetUsd: room.budgetUsd, epoch: rp.epoch }, s, t.me, t.device, now, dry);
      if (r.err) out.problems.push(room.name + ": " + r.err); else if (r.name) out.published.push(r.name);
    }
  }
  return out;
}
