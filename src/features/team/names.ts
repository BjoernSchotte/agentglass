// agentglass — display names (fleet-teams spec 5a): a member names itself with a claim {member, name, device labels,
// seq, at} signed with its own key and sealed with the team key (names/<member>.name): nobody else can name or rename
// it, the relay and the folder cannot read it. The highest seq wins. Rows carry the member id; the name is resolved
// when shown, so a rename applies to the whole history. Two members with one name (case-insensitive): the earlier by
// manifest order keeps it, the later shows "name·<4 hex of its id>". --redact shows stable fakes.
// SPDX-License-Identifier: Apache-2.0
import { obj, str, parse } from "../../util/json.ts";
import { b64url, unb64url, unhex, randomBytes } from "../../util/rand.ts";
import { REDACT } from "../redact-on.ts";
import { sha256Hex } from "../../util/sha256.ts";
import { sign, verify, lock, unlock } from "./crypto.ts";
import { type MemberKeys } from "./keys.ts";
import { type Manifest, cat } from "./manifest.ts";

export interface NameClaim { member: string; name: string; devices: { [device: string]: string }; seq: number; at: number }
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
// "" = a name (or device label) one may choose: 1–32 characters, no control characters
export function nameErr(n: string): string {
  const t = n.trim(); const len = [...t].length;
  if (len < 1 || len > 32) return "a name has 1 to 32 characters";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(t)) return "a name has no control characters";
  return "";
}
function claimJson(c: NameClaim): string {
  const ds: { [d: string]: string } = {}; for (const k of Object.keys(c.devices).sort()) ds[k] = c.devices[k] ?? "";
  return JSON.stringify({ member: c.member, name: c.name, devices: ds, seq: c.seq, at: c.at });
}
export function signClaim(c: NameClaim, k: MemberKeys, teamKey: Uint8Array): Uint8Array {
  const body = claimJson(c);
  const pt = enc(JSON.stringify({ body, sig: b64url(sign(k.sign.sk, enc("agentglass-team/v1|name|" + body))) }));
  const nonce = randomBytes(24); const l = lock(teamKey, nonce, enc("agentglass-team/v1|name|" + c.member), pt);
  return cat([nonce, l.mac, l.ct]);
}
// the claim in b if the team key opens it and the member it names signed it
export function readClaim(b: Uint8Array, m: Manifest, teamKey: Uint8Array): { c: NameClaim | null; err: string } {
  if (b.length < 40) return { c: null, err: "too short" };
  // the member id is inside: try each member's associated data (a claim is sealed for its own member's name file)
  for (const x of m.members) {
    const pt = unlock(teamKey, b.subarray(0, 24), enc("agentglass-team/v1|name|" + x.id), b.subarray(40), b.subarray(24, 40)); if (!pt) continue;
    const o = obj(parse(new TextDecoder("utf-8").decode(pt))); if (!o) return { c: null, err: "broken claim" };
    const body = str(o["body"]); const bo = obj(parse(body)); const sig = unb64url(str(o["sig"])); const pk = unhex(x.signPk);
    if (!bo || str(bo["member"]) !== x.id) return { c: null, err: "claim for another member" };
    if (!sig || !pk || !verify(pk, enc("agentglass-team/v1|name|" + body), sig)) return { c: null, err: "not signed by member " + x.id };
    const devices: { [d: string]: string } = {}; const dv = obj(bo["devices"]); if (dv) for (const k of Object.keys(dv)) if (/^[0-9a-f]{16}$/.test(k) && nameErr(str(dv[k])) === "") devices[k] = str(dv[k]);
    const c: NameClaim = { member: x.id, name: str(bo["name"]).trim(), devices, seq: typeof bo["seq"] === "number" ? bo["seq"] : 0, at: typeof bo["at"] === "number" ? bo["at"] : 0 };
    if (nameErr(c.name)) return { c: null, err: "claim: " + nameErr(c.name) };
    return { c, err: "" };
  }
  return { c: null, err: "does not open with the team key" };
}
const POOL = ["Alex", "Sam", "Robin", "Kim", "Jo", "Noa", "Mika", "Toni", "Lou", "Ari", "Pat", "Eli", "Rene", "Kai", "Dana", "Luca"];
// --redact: a stable fake per member id, per device label
export function fakeMember(id: string): string { const h = sha256Hex("agentglass/team/fake|" + id); return (POOL[parseInt(h.slice(0, 2), 16) % POOL.length] ?? "Alex") + "·" + h.slice(2, 4); }
export function fakeDevice(label: string): string { return "device-" + sha256Hex("agentglass/team/fakedev|" + label).slice(0, 4); }
// member id → the name to show: the highest-seq claim, else the name given at admission (fallback), else "member·<4 hex>"
export function displayNames(m: Manifest, claims: NameClaim[], fallback: { [id: string]: string }): Map<string, string> {
  const best = new Map<string, NameClaim>(); for (const c of claims) { const b = best.get(c.member); if (!b || c.seq > b.seq) best.set(c.member, c); }
  const out = new Map<string, string>(); const taken = new Set<string>();
  for (const x of m.members) { // manifest order: the earlier member keeps a shared name
    if (REDACT) { out.set(x.id, fakeMember(x.id)); continue; }
    const c = best.get(x.id); const n = c ? c.name : (fallback[x.id] ?? "") || "member·" + x.id.slice(0, 4);
    const k = n.toLowerCase(); out.set(x.id, taken.has(k) ? n + "·" + x.id.slice(0, 4) : n); taken.add(k);
  }
  return out;
}
// a device's label: from its member's claim (--redact: a fake), else "" (the caller shows the device id)
export function deviceLabel(claims: NameClaim[], member: string, device: string): string {
  let best: NameClaim | null = null; for (const c of claims) if (c.member === member && (!best || c.seq > best.seq)) best = c;
  const l = best ? best.devices[device] ?? "" : ""; return l && REDACT ? fakeDevice(l) : l;
}
