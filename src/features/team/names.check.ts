// check: crypto
// agentglass — self-check for display names (fleet-teams spec 5a): a name is a claim signed by its member and sealed
// with the team key; the highest seq wins; collisions get 4 hex of the member id; a rename applies to every past row
// (attribution by id); --redact shows stable fakes; names never reach a fleet snapshot.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/names.check.ts -o nc && HOME=$(mktemp -d) ./nc
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { hex, randomBytes } from "../../util/rand.ts";
import { REDACT } from "../redact-on.ts";
import { type MemberKeys, newMember } from "./keys.ts";
import { type Manifest, type MemberPub } from "./manifest.ts";
import { type NameClaim, signClaim, readClaim, displayNames, nameErr, fakeMember, fakeDevice } from "./names.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const ann = newMember(); const anna2 = newMember(); const bob = newMember();
function pub(k: MemberKeys): MemberPub { return { id: k.id, signPk: hex(k.sign.pk), boxPk: hex(k.box.pk), devices: ["aaaaaaaaaaaaaaaa"], admin: false, removedAt: 0 }; }
const m: Manifest = { team: "0123456789abcdef", version: 1, root: hex(ann.sign.pk), signer: ann.id, at: 1, tk: 1, members: [pub(ann), pub(anna2), pub(bob)], rooms: [], invites: [], priv: new Uint8Array(0) };
const tk = randomBytes(32);
const claim = (k: MemberKeys, name: string, seq: number): NameClaim => ({ member: k.id, name, devices: { aaaaaaaaaaaaaaaa: "mac-aaaa" }, seq, at: 1000 + seq });

if (REDACT) {
  ok("--redact: a stable fake name", fakeMember(ann.id) === fakeMember(ann.id) && fakeMember(ann.id) !== "Anna" && fakeMember(ann.id) !== fakeMember(bob.id), fakeMember(ann.id));
  ok("--redact: a stable fake label", fakeDevice("mac-7f3a") === fakeDevice("mac-7f3a") && fakeDevice("mac-7f3a") !== "mac-7f3a", fakeDevice("mac-7f3a"));
  const n = displayNames(m, [claim(ann, "Anna", 1)], {});
  ok("--redact: names shown are fakes", (n.get(ann.id) ?? "") === fakeMember(ann.id), n.get(ann.id) ?? "");
  const r = execFileSync("sh", ["-c", "AGENTGLASS_REDACT=0 '" + process.execPath + "' 2>&1; echo \"rc=$?\""], { encoding: "utf8" }); // the rest without
  process.stdout.write(r.slice(0, r.lastIndexOf("rc="))); process.exit(bad === 0 && r.trim().endsWith("rc=0") ? 0 : 1);
}
const c1 = readClaim(signClaim(claim(ann, "Anna", 1), ann, tk), m, tk);
ok("a claim round trip", c1.c !== null && c1.c.name === "Anna" && c1.c.devices["aaaaaaaaaaaaaaaa"] === "mac-aaaa", c1.err);
const forged = claim(ann, "Mallory", 5); // Bob signs a claim for Ann
ok("a claim signed by another member: refused", readClaim(signClaim(forged, bob, tk), m, tk).err.indexOf("not signed by member") >= 0, readClaim(signClaim(forged, bob, tk), m, tk).err);
ok("another team key: refused", readClaim(signClaim(claim(ann, "Anna", 1), ann, tk), m, randomBytes(32)).c === null, "");
// the highest seq wins, an older seq after a newer one is ignored
const n1 = displayNames(m, [claim(ann, "Anna", 2), claim(ann, "Annie", 1), claim(bob, "Bob", 1)], {});
ok("seq 2 beats seq 1 in any order", n1.get(ann.id) === "Anna", n1.get(ann.id) ?? "");
// two Annas: the earlier member by manifest order keeps the name, the later gets 4 hex of its id
const n2 = displayNames(m, [claim(ann, "Anna", 1), claim(anna2, "anna", 1)], {});
ok("collision", n2.get(ann.id) === "Anna" && n2.get(anna2.id) === "anna·" + anna2.id.slice(0, 4), (n2.get(ann.id) ?? "") + " / " + (n2.get(anna2.id) ?? ""));
// no claim yet: the name given at admission, else a placeholder from the id
const n3 = displayNames(m, [], { [bob.id]: "Bob" });
ok("fallback: the admission name, else the id", n3.get(bob.id) === "Bob" && (n3.get(ann.id) ?? "").indexOf(ann.id.slice(0, 4)) >= 0, (n3.get(bob.id) ?? "") + " " + (n3.get(ann.id) ?? ""));
// names: 1–32 characters, no control characters
ok("name rules", nameErr("Björn") === "" && nameErr("") !== "" && nameErr("x".repeat(33)) !== "" && nameErr("a\u0007b") !== "", "");
// a rename: rows carry the member id, the name is resolved when shown
const rows = [{ member: ann.id }, { member: ann.id }];
const after = displayNames(m, [claim(ann, "Anna", 1), claim(ann, "Annika", 2)], {});
let renamed = 0; for (const r of rows) if (after.get(r.member) === "Annika") renamed++;
ok("a rename applies to every past row", renamed === 2, String(renamed));
console.log(bad ? String(bad) + " failed" : "team names: all checks passed");
if (bad) process.exit(1);
