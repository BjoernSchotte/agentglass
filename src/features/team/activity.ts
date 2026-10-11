// agentglass — the team activity log (fleet-teams spec 5a): derived from signed sources only — manifest versions (joined,
// removed, admin, room, rotated: an admin signed them), name claims (renamed: the member), member events in activity/
// (shares into a room on/off, paused, resumed: only the fact, never the repos; signed by the member, sealed with the
// team key) and leave notices. Kept 90 days, newest first.
// SPDX-License-Identifier: Apache-2.0
import { obj, str, parse } from "../../util/json.ts";
import { b64url, unb64url, unhex, randomBytes } from "../../util/rand.ts";
import { sign, verify, lock, unlock } from "./crypto.ts";
import { type Manifest, type MemberPub, readManifest, cat } from "./manifest.ts";
import { NAMES } from "./mailbox.ts";
import { type NameClaim, readClaim, displayNames } from "./names.ts";
import { type TeamState, mbOf, teamKey } from "./state.ts";

export interface Act { at: number; actor: string; kind: string; room: string; text: string } // kind: joined|left|removed|renamed|shares|paused|resumed|room|rotated|admin
export const KEEP_MS = 90 * 86400000;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder("utf-8").decode(b);
const EVENTS = ["shares", "unshares", "paused", "resumed"];

// one member event of mine: activity/<me>-<seq>.act (signed, sealed with the team key)
export function writeEvent(t: TeamState, kind: string, room: string, now: number): string {
  const m = t.manifest; const k = m ? teamKey(t, m.tk) : null; if (!m || !k) return "no team key yet";
  if (EVENTS.indexOf(kind) < 0) return "not an event: " + kind;
  const mb = mbOf(t); let seq = 0;
  for (const f of mb.list("activity")) { const x = NAMES.activity.exec("activity/" + f.name); if (x && x[1] === t.me.id) seq = Math.max(seq, Number(x[2] ?? "0")); }
  const body = JSON.stringify({ member: t.me.id, kind, room, at: now });
  const pt = enc(JSON.stringify({ body, sig: b64url(sign(t.me.sign.sk, enc("agentglass-team/v1|act|" + body))) }));
  const nonce = randomBytes(24); const l = lock(k, nonce, enc("agentglass-team/v1|act|" + t.me.id), pt);
  return mb.put("activity/" + t.me.id + "-" + String(seq + 1) + ".act", cat([nonce, l.mac, l.ct]));
}
// every name claim in the folder this machine can read (forged or foreign ones dropped)
export function claimsOf(t: TeamState): NameClaim[] {
  const m = t.manifest; const o: NameClaim[] = []; if (!m) return o;
  const mb = mbOf(t);
  for (const f of mb.list("names")) {
    const b = mb.get("names/" + f.name, 65536); if (!b) continue;
    for (let e = m.tk; e >= 1; e--) { const k = teamKey(t, e); if (!k) continue; const r = readClaim(b, m, k); if (r.c) { o.push(r.c); break; } } // a claim from before a rotation
  }
  return o;
}
// the manifest versions the folder holds, in chain order (each judged by the one before)
function history(t: TeamState): Manifest[] {
  const mb = mbOf(t); const fs: { v: number; s: string; n: string }[] = [];
  for (const f of mb.list("manifest")) { const x = NAMES.manifest.exec("manifest/" + f.name); if (x) fs.push({ v: Number(x[1] ?? "0"), s: x[2] ?? "", n: f.name }); }
  const o: Manifest[] = []; let prev: Manifest | null = null;
  for (let v = 1; v <= 100000; v++) {
    let best: Manifest | null = null;
    for (const f of fs) if (f.v === v) { const b = mb.get("manifest/" + f.n, 16777216); if (!b) continue; const r = readManifest(b, prev); if (r.m && (!best || r.m.signer > best.signer)) best = r.m; }
    if (!best) break;
    o.push(best); prev = best;
  }
  return o;
}
function memberOf(m: Manifest, id: string): MemberPub | null { for (const x of m.members) if (x.id === id) return x; return null; }
export function activity(t: TeamState, since: number, now: number): Act[] {
  const out: Act[] = []; const from = Math.max(since, now - KEEP_MS);
  const hs = history(t); const m = t.manifest; if (!m || !hs.length) return out;
  const claims = claimsOf(t); const names = displayNames(m, claims, t.priv ? t.priv.names : {});
  const nm = (id: string): string => names.get(id) ?? "member·" + id.slice(0, 4);
  const rooms = new Map<string, string>(); if (t.priv) for (const r of t.priv.rooms) rooms.set(r.id, r.name);
  const rn = (id: string): string => rooms.get(id) ?? id.slice(0, 6);
  const add = (at: number, actor: string, kind: string, room: string, text: string): void => { if (at >= from) out.push({ at, actor, kind, room, text }); };
  // manifest versions: what each changed
  for (let i = 0; i < hs.length; i++) {
    const cur = hs[i] as Manifest; const prev = i > 0 ? hs[i - 1] as Manifest : null;
    if (!prev) { for (const r of cur.rooms) add(cur.at, cur.signer, "room", r.id, nm(cur.signer) + " created room " + rn(r.id)); continue; }
    for (const x of cur.members) {
      const p = memberOf(prev, x.id);
      if (!p) { const rs: string[] = []; for (const r of cur.rooms) if (r.members.indexOf(x.id) >= 0) rs.push(rn(r.id)); add(cur.at, x.id, "joined", "", nm(x.id) + " joined" + (rs.length ? " room " + rs.join(", ") : "")); continue; }
      if (!p.removedAt && x.removedAt) add(cur.at, cur.signer, "removed", "", nm(cur.signer) + " removed " + nm(x.id));
      if (!p.admin && x.admin) add(cur.at, cur.signer, "admin", "", nm(cur.signer) + " made " + nm(x.id) + " an admin");
      if (x.devices.length > p.devices.length) add(cur.at, x.id, "joined", "", nm(x.id) + " added a device");
    }
    for (const r of cur.rooms) {
      let pr = -1; for (const q of prev.rooms) if (q.id === r.id) pr = q.epoch;
      if (pr < 0) add(cur.at, cur.signer, "room", r.id, nm(cur.signer) + " created room " + rn(r.id));
      else if (r.epoch > pr) add(cur.at, cur.signer, "rotated", r.id, "keys of room " + rn(r.id) + " rotated");
    }
  }
  // names: a claim after the first is a rename
  for (const c of claims) if (c.seq > 1) add(c.at, c.member, "renamed", "", "member·" + c.member.slice(0, 4) + " renamed to " + nm(c.member));
  // member events
  const mb = mbOf(t); const keys: Uint8Array[] = []; for (let e = m.tk; e >= 1; e--) { const k = teamKey(t, e); if (k) keys.push(k); } // events from before a rotation
  for (const f of mb.list("activity")) {
    const x = NAMES.activity.exec("activity/" + f.name); const id = x ? x[1] ?? "" : ""; const mp = memberOf(m, id); if (!mp) continue;
    const b = mb.get("activity/" + f.name, 65536); if (!b || b.length < 40) continue;
    let pt: Uint8Array | null = null; for (const k of keys) { if (!pt) pt = unlock(k, b.subarray(0, 24), enc("agentglass-team/v1|act|" + id), b.subarray(40), b.subarray(24, 40)); }
    if (!pt) continue;
    const o = obj(parse(dec(pt))); if (!o) continue;
    const body = str(o["body"]); const bo = obj(parse(body)); const sig = unb64url(str(o["sig"])); const pk = unhex(mp.signPk);
    if (!bo || bo["member"] !== id || !sig || !pk || !verify(pk, enc("agentglass-team/v1|act|" + body), sig)) continue; // forged: dropped
    const kind = str(bo["kind"]); const room = str(bo["room"]); const at = typeof bo["at"] === "number" ? bo["at"] : 0;
    const what = kind === "shares" ? "shares into" : kind === "unshares" ? "stopped sharing into" : kind === "paused" ? "paused" : kind === "resumed" ? "resumed" : "";
    if (what) add(at, id, kind, room, nm(id) + " " + what + " room " + rn(room));
  }
  // leave notices (their signatures are checked by sync before anyone acts on them; here only the fact)
  for (const f of mb.list("leave")) { const x = NAMES.leave.exec("leave/" + f.name); const id = x ? x[1] ?? "" : ""; if (memberOf(m, id)) add(f.at, id, "left", "", nm(id) + " left the team"); }
  out.sort((a: Act, b: Act) => b.at - a.at);
  return out;
}
