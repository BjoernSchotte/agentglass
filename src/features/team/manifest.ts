// agentglass — the signed team manifest (fleet-teams spec 5): "AGM1" | u32 LE public length | public JSON | private part |
// 64-byte signature over "agentglass-team/v1|manifest|" ‖ everything before it. The public part (members, their keys
// and devices, admin and removed flags, room epochs, invite verifiers) is what a relay may read; the private part
// (team, member and room names, scopes, levels, budgets) is sealed with the team key every member holds.
// Version 1 is signed by the root key; a later one by the root or by an admin (not removed) of the version the reader
// holds. Two admins writing one version: the higher signer id wins.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, arr, str, parse } from "../../util/json.ts";
import { unhex, randomBytes } from "../../util/rand.ts";
import { sign, verify, lock, unlock, hash16 } from "./crypto.ts";
import { type MemberKeys } from "./keys.ts";
import { type Room } from "./policy.ts";

export interface MemberPub { id: string; signPk: string; boxPk: string; devices: string[]; admin: boolean; removedAt: number }
export interface InvitePub { id: string; verifier: string; expires: number; uses: number }
export interface RoomPub { id: string; epoch: number }
export interface Manifest { team: string; version: number; root: string; signer: string; at: number; members: MemberPub[]; rooms: RoomPub[]; invites: InvitePub[]; priv: Uint8Array /* sealed private part */ }
export interface Private { name: string; names: { [id: string]: string }; rooms: Room[] }
const FORMAT = "agentglass-team/v1";
const SIG_CTX = "agentglass-team/v1|manifest|";
const PRIV_AD = "agentglass-team/v1|private";
const ID = /^[0-9a-f]{16}$/; const KEY = /^[0-9a-f]{64}$/;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// the public part as written: fixed key order, so a reader can demand exactly these bytes
function pubJson(m: Manifest): string {
  const ms: Obj[] = []; for (const x of m.members) ms.push({ id: x.id, signPk: x.signPk, boxPk: x.boxPk, devices: x.devices, admin: x.admin, removedAt: x.removedAt });
  const rs: Obj[] = []; for (const x of m.rooms) rs.push({ id: x.id, epoch: x.epoch });
  const is: Obj[] = []; for (const x of m.invites) is.push({ id: x.id, verifier: x.verifier, expires: x.expires, uses: x.uses });
  return JSON.stringify({ format: FORMAT, team: m.team, version: m.version, root: m.root, signer: m.signer, at: m.at, members: ms, rooms: rs, invites: is });
}
function u32(b: Uint8Array, at: number): number { return (b[at] ?? 0) + (b[at + 1] ?? 0) * 256 + (b[at + 2] ?? 0) * 65536 + (b[at + 3] ?? 0) * 16777216; }
export function cat(parts: Uint8Array[]): Uint8Array { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let at = 0; for (let i = 0; i < parts.length; i++) { const p = parts[i] as Uint8Array; o.set(p, at); at += p.length; } return o; }

// the .agm bytes of m, signed by k (m.signer becomes k.id)
export function signManifest(m: Manifest, k: MemberKeys): Uint8Array {
  const pj = enc(pubJson({ team: m.team, version: m.version, root: m.root, signer: k.id, at: m.at, members: m.members, rooms: m.rooms, invites: m.invites, priv: m.priv }));
  const head = new Uint8Array(8); head.set(enc("AGM1"), 0);
  head[4] = pj.length & 255; head[5] = (pj.length >>> 8) & 255; head[6] = (pj.length >>> 16) & 255; head[7] = (pj.length >>> 24) & 255;
  const body = cat([head, pj, m.priv]);
  return cat([body, sign(k.sign.sk, cat([enc(SIG_CTX), body]))]);
}
function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : NaN; }
// the public JSON → a manifest (priv set by the caller); err = the first field that is not as written
function pubOf(t: string): { m: Manifest | null; err: string } {
  const o = obj(parse(t)); if (!o || o["format"] !== FORMAT) return { m: null, err: "not an agentglass-team/v1 manifest" };
  const members: MemberPub[] = [];
  for (const x of arr(o["members"])) {
    const e = obj(x); if (!e) return { m: null, err: "members: not objects" };
    const devices: string[] = []; for (const d of arr(e["devices"])) { if (typeof d !== "string" || !ID.test(d)) return { m: null, err: "members: a device id is not 16 hex" }; devices.push(d); }
    members.push({ id: str(e["id"]), signPk: str(e["signPk"]), boxPk: str(e["boxPk"]), devices, admin: e["admin"] === true, removedAt: num(e["removedAt"]) });
  }
  const rooms: RoomPub[] = []; for (const x of arr(o["rooms"])) { const e = obj(x); if (!e) return { m: null, err: "rooms: not objects" }; rooms.push({ id: str(e["id"]), epoch: num(e["epoch"]) }); }
  const invites: InvitePub[] = []; for (const x of arr(o["invites"])) { const e = obj(x); if (!e) return { m: null, err: "invites: not objects" }; invites.push({ id: str(e["id"]), verifier: str(e["verifier"]), expires: num(e["expires"]), uses: num(e["uses"]) }); }
  const m: Manifest = { team: str(o["team"]), version: num(o["version"]), root: str(o["root"]), signer: str(o["signer"]), at: num(o["at"]), members, rooms, invites, priv: new Uint8Array(0) };
  if (pubJson(m) !== t) return { m: null, err: "manifest header is not canonical (an unknown key, a type, an order)" };
  if (!ID.test(m.team) || !ID.test(m.signer) || !KEY.test(m.root) || !Number.isInteger(m.version) || m.version < 1 || !(m.at > 0)) return { m: null, err: "manifest: team, signer, root, version or time invalid" };
  const seen: string[] = [];
  for (const x of members) {
    const pk = unhex(x.signPk);
    if (!pk || !KEY.test(x.signPk) || !KEY.test(x.boxPk) || !(x.removedAt >= 0)) return { m: null, err: "manifest: a member's keys are invalid" };
    if (hash16(pk) !== x.id) return { m: null, err: "manifest: member id " + x.id + " is not its key's hash" };
    if (seen.indexOf(x.id) >= 0) return { m: null, err: "manifest: member " + x.id + " twice" };
    seen.push(x.id);
  }
  for (const r of rooms) if (!ID.test(r.id) || !Number.isInteger(r.epoch) || r.epoch < 1) return { m: null, err: "manifest: a room is invalid" };
  for (const i of invites) if (!ID.test(i.id) || !KEY.test(i.verifier) || !(i.expires > 0) || !Number.isInteger(i.uses) || i.uses < 0) return { m: null, err: "manifest: an invite is invalid" };
  return { m, err: "" };
}
function memberOf(m: Manifest, id: string): MemberPub | null { for (const x of m.members) if (x.id === id) return x; return null; }
// the signing key m's signer may use, judged by what the reader holds: the root always; with prev an admin of prev that
// is not removed (its key from prev, not from m); without prev only the root ("" = none)
function signerKey(m: Manifest, prev: Manifest | null): string {
  const self = memberOf(m, m.signer);
  if (self && self.signPk === m.root && (!prev || prev.root === m.root)) return m.root;
  if (!prev) return "";
  const p = memberOf(prev, m.signer);
  return p && p.admin && p.removedAt === 0 ? p.signPk : "";
}
// the manifest in b if it is valid and may follow prev (null: the first one this reader sees)
export function readManifest(b: Uint8Array, prev: Manifest | null): { m: Manifest | null; err: string } {
  if (b.length < 8 + 2 + 64 || b[0] !== 65 || b[1] !== 71 || b[2] !== 77 || b[3] !== 49) return { m: null, err: "not a manifest file" };
  const pl = u32(b, 4); if (pl < 2 || 8 + pl > b.length - 64) return { m: null, err: "manifest truncated" };
  const r = pubOf(new TextDecoder("utf-8").decode(b.subarray(8, 8 + pl))); const m = r.m; if (!m) return r;
  m.priv = b.slice(8 + pl, b.length - 64);
  if (prev) {
    if (m.team !== prev.team || m.root !== prev.root) return { m: null, err: "manifest of another team" };
    if (m.version < prev.version) return { m: null, err: "manifest v" + String(m.version) + " is older than v" + String(prev.version) };
    if (m.version === prev.version && m.signer <= prev.signer) return { m: null, err: "manifest v" + String(m.version) + " is not newer than the one held" };
  }
  const k = signerKey(m, prev);
  if (!k) return { m: null, err: prev ? "manifest signed by " + m.signer + ", who is no admin of v" + String(prev.version) : "manifest v" + String(m.version) + " is not signed by the root key (read the versions before it first)" };
  const pk = unhex(k);
  if (!pk || !verify(pk, cat([enc(SIG_CTX), b.subarray(0, b.length - 64)]), b.subarray(b.length - 64))) return { m: null, err: "manifest signature invalid" };
  return { m, err: "" };
}

export function sealPrivate(p: Private, teamKey: Uint8Array): Uint8Array {
  const rs: Obj[] = []; for (const r of p.rooms) rs.push({ id: r.id, name: r.name, scope: r.scope, level: r.level, budgetUsd: r.budgetUsd, epoch: r.epoch });
  const nonce = randomBytes(24);
  const l = lock(teamKey, nonce, enc(PRIV_AD), enc(JSON.stringify({ name: p.name, names: p.names, rooms: rs })));
  return cat([nonce, l.mac, l.ct]);
}
// null = not this team key, or not a private part this version reads
export function openPrivate(m: Manifest, teamKey: Uint8Array): Private | null {
  const b = m.priv; if (b.length < 40) return null;
  const pt = unlock(teamKey, b.subarray(0, 24), enc(PRIV_AD), b.subarray(40), b.subarray(24, 40)); if (!pt) return null;
  const o = obj(parse(new TextDecoder("utf-8").decode(pt))); if (!o) return null;
  const names: { [id: string]: string } = {}; const no = obj(o["names"]); if (no) for (const k of Object.keys(no)) if (ID.test(k) && typeof no[k] === "string") names[k] = str(no[k]);
  const rooms: Room[] = [];
  for (const x of arr(o["rooms"])) {
    const e = obj(x); if (!e) continue;
    const scope: string[] = []; for (const s of arr(e["scope"])) if (typeof s === "string") scope.push(s);
    rooms.push({ id: str(e["id"]), name: str(e["name"]), scope, level: e["level"] === "titles" ? "titles" : "numbers", budgetUsd: typeof e["budgetUsd"] === "number" ? e["budgetUsd"] : 0, epoch: typeof e["epoch"] === "number" ? e["epoch"] : 1 });
  }
  return { name: str(o["name"]), names, rooms };
}
