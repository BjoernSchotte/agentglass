// check: crypto
// agentglass — self-check for the signed team manifest (fleet-teams spec 5): v1 only by the root key, later versions by
// the root or an admin of the version the reader holds, never by a removed admin; tampering, older versions and member
// ids that are not their key's hash are refused; the private part opens with the team key only.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/manifest.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
import { hex, randomBytes } from "../../util/rand.ts";
import { type MemberKeys, newMember } from "./keys.ts";
import { type Manifest, type MemberPub, type Private, signManifest, readManifest, openPrivate, sealPrivate } from "./manifest.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const T = "0123456789abcdef";
const root = newMember(); const ann = newMember(); const bob = newMember();
function pub(k: MemberKeys, admin: boolean): MemberPub { return { id: k.id, signPk: hex(k.sign.pk), boxPk: hex(k.box.pk), devices: ["d" + k.id.slice(0, 15)], admin, removedAt: 0 }; }
const teamKey = randomBytes(32);
const P: Private = { name: "acme", names: { [root.id]: "root", [ann.id]: "Ann" }, rooms: [{ id: "fedcba9876543210", name: "api", scope: ["github.com/acme/*"], level: "numbers", budgetUsd: 50, epoch: 1 }] };
function man(version: number, members: MemberPub[]): Manifest {
  return { team: T, version, root: hex(root.sign.pk), signer: "", at: 1790000000000 + version, members, rooms: [{ id: "fedcba9876543210", epoch: 1 }], invites: [], priv: sealPrivate(P, teamKey) };
}
function read(b: Uint8Array, prev: Manifest | null): Manifest | null { return readManifest(b, prev).m; }
function err(b: Uint8Array, prev: Manifest | null): string { return readManifest(b, prev).err; }

const v1 = signManifest(man(1, [pub(root, true), pub(ann, true), pub(bob, false)]), root);
const m1 = read(v1, null);
ok("v1 by the root: accepted", m1 !== null && m1.version === 1 && m1.signer === root.id && m1.members.length === 3, err(v1, null));
ok("v1 by an admin that is not the root: refused", err(signManifest(man(1, [pub(root, true), pub(ann, true)]), ann), null) !== "", "");
ok("a later version with no chain: refused unless the root signed it", err(signManifest(man(2, [pub(root, true), pub(ann, true)]), ann), null) !== "" && read(signManifest(man(2, [pub(root, true)]), root), null) !== null, "");
if (m1) {
  const v2 = signManifest(man(2, [pub(root, true), pub(ann, true), pub(bob, false)]), ann);
  const m2 = read(v2, m1);
  ok("v2 by an admin of v1: accepted", m2 !== null && m2.version === 2, err(v2, m1));
  ok("v2 by a member that is no admin: refused", err(signManifest(man(2, [pub(root, true), pub(ann, true), pub(bob, true)]), bob), m1) !== "", "");
  // v2 removes Ann; her v3 is refused, the root's is accepted
  const annGone = pub(ann, true); annGone.removedAt = 1790000000002;
  const m2r = read(signManifest(man(2, [pub(root, true), annGone, pub(bob, false)]), root), m1);
  ok("v2 removing an admin: accepted", m2r !== null, "");
  if (m2r) {
    ok("v3 by the removed admin: refused", err(signManifest(man(3, [pub(root, true), pub(ann, true)]), ann), m2r) !== "", "");
    ok("v3 by the root: accepted", read(signManifest(man(3, [pub(root, true), annGone]), root), m2r) !== null, "");
    ok("an older version than the one held: refused", err(v1, m2r).indexOf("older than") >= 0, err(v1, m2r));
  }
  // two admins write v2 at once: the higher signer id wins, the other is refused as not newer
  const byRoot = read(signManifest(man(2, [pub(root, true), pub(ann, true), pub(bob, false)]), root), m1);
  const byAnn = m2;
  if (byRoot && byAnn) {
    const hi = root.id > ann.id ? byRoot : byAnn; const lo = root.id > ann.id ? byAnn : byRoot;
    const hiB = signManifest(man(2, hi.members), root.id > ann.id ? root : ann); const loB = signManifest(man(2, lo.members), root.id > ann.id ? ann : root);
    ok("same version: the higher signer id replaces", read(hiB, lo) !== null, err(hiB, lo));
    ok("same version: the lower signer id does not", err(loB, hi) !== "", "");
  }
  // every byte counts: one flipped anywhere → refused
  let flips = 0; for (let i = 0; i < v1.length; i += 7) { const t = v1.slice(); t[i] = (t[i] ?? 0) ^ 1; if (read(t, null) === null) flips++; }
  ok("a flipped byte anywhere: refused", flips === Math.ceil(v1.length / 7), String(flips) + " of " + String(Math.ceil(v1.length / 7)));
  ok("truncated: refused", read(v1.subarray(0, v1.length - 1), null) === null && read(v1.subarray(0, 6), null) === null, "");
  // a member id that is not the hash of its key (a forged entry under someone's id)
  const forged = pub(bob, false); forged.id = ann.id;
  ok("a member id that is not its key's hash: refused", err(signManifest(man(1, [pub(root, true), forged]), root), null).indexOf("member id") >= 0, "");
  const p = openPrivate(m1, teamKey);
  ok("private part opens with the team key", p !== null && p.name === "acme" && p.names[ann.id] === "Ann" && p.rooms.length === 1 && p.rooms[0]?.scope[0] === "github.com/acme/*", JSON.stringify(p));
  ok("not with another key", openPrivate(m1, randomBytes(32)) === null, "");
}
console.log(bad ? String(bad) + " failed" : "team manifest: all checks passed");
if (bad) process.exit(1);
