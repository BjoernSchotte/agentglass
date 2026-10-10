// check: crypto
// agentglass — self-check for sealed room files (fleet-teams spec 7): round trip; the sender must be a member with that
// device (a removed one only for files from before the removal); the signature covers header and ciphertext, so no
// byte can change; the epoch key must be held; a declared size over 256 MB is refused before anything is allocated.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/sealed.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { hex, randomBytes } from "../../util/rand.ts";
import { type MemberKeys, newMember } from "./keys.ts";
import { type Manifest, type MemberPub } from "./manifest.ts";
import { type Head, sealFile, sealFileGz, openFile, OPEN_MAX } from "./sealed.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const T = "0123456789abcdef"; const R = "fedcba9876543210";
const ann = newMember(); const bob = newMember(); const eve = newMember();
const DEV = "aaaaaaaaaaaaaaaa";
function pub(k: MemberKeys, removedAt: number): MemberPub { return { id: k.id, signPk: hex(k.sign.pk), boxPk: hex(k.box.pk), devices: [DEV], admin: false, removedAt }; }
const m: Manifest = { team: T, version: 2, root: hex(ann.sign.pk), signer: ann.id, at: 1790000000000, members: [pub(ann, 0), pub(bob, 1790000005000)], rooms: [{ id: R, epoch: 2 }], invites: [], priv: new Uint8Array(0) };
const k2 = randomBytes(32); const k1 = randomBytes(32);
const keyOf = (room: string, epoch: number): Uint8Array | null => room === R && epoch === 2 ? k2 : room === R && epoch === 1 ? k1 : null;
function head(member: string, at: number, epoch: number): Head { return { team: T, room: R, epoch, member, device: DEV, kind: "base", n: 0, gen: "g1", base: "", at }; }
const plain = new TextEncoder().encode("{\"snap\":{}}\n{\"sess\":{\"key\":\"x\"}}\n");
const f = sealFile(head(ann.id, 1790000001000, 2), plain, k2, ann);
const o = openFile(f, m, keyOf);
ok("round trip", o.err === "" && o.h !== null && o.h.member === ann.id && o.h.epoch === 2 && new TextDecoder().decode(o.plain ?? new Uint8Array(0)) === new TextDecoder().decode(plain), o.err);
ok("magic", new TextDecoder().decode(f.subarray(0, 4)) === "AGT1", "");
ok("a sender not in the manifest: refused", openFile(sealFile(head(eve.id, 1790000001000, 2), plain, k2, eve), m, keyOf).err.indexOf("unknown member") >= 0, "");
const hd = head(ann.id, 1790000001000, 2); hd.device = "bbbbbbbbbbbbbbbb";
ok("a device that is not the member's: refused", openFile(sealFile(hd, plain, k2, ann), m, keyOf).err.indexOf("device") >= 0, openFile(sealFile(hd, plain, k2, ann), m, keyOf).err);
ok("a removed member, written after the removal: refused", openFile(sealFile(head(bob.id, 1790000006000, 2), plain, k2, bob), m, keyOf).err !== "", "");
ok("a removed member, written before it: read", openFile(sealFile(head(bob.id, 1790000004000, 2), plain, k2, bob), m, keyOf).err === "", openFile(sealFile(head(bob.id, 1790000004000, 2), plain, k2, bob), m, keyOf).err);
ok("signed by another key than the member's: refused", openFile(sealFile(head(ann.id, 1790000001000, 2), plain, k2, eve), m, keyOf).err.indexOf("signature") >= 0, "");
ok("an epoch whose key is not held: refused", openFile(sealFile(head(ann.id, 1790000001000, 3), plain, k2, ann), m, keyOf).err.indexOf("no key for epoch") >= 0, "");
ok("the old epoch still opens", openFile(sealFile(head(ann.id, 1790000001000, 1), plain, k1, ann), m, keyOf).err === "", "");
ok("sealed with another key than the epoch's: refused", openFile(sealFile(head(ann.id, 1790000001000, 2), plain, k1, ann), m, keyOf).err !== "", "");
let flips = 0; let n = 0; for (let i = 0; i < f.length; i += 3) { n++; const t = f.slice(); t[i] = (t[i] ?? 0) ^ 1; if (openFile(t, m, keyOf).err !== "") flips++; }
ok("a flipped byte anywhere (header, ciphertext, signature): refused", flips === n, String(flips) + " of " + String(n));
ok("truncated: refused", openFile(f.subarray(0, f.length - 1), m, keyOf).err !== "" && openFile(f.subarray(0, 10), m, keyOf).err !== "", "");
ok("another team's file: refused", openFile(f, { team: "1111111111111111", version: m.version, root: m.root, signer: m.signer, at: m.at, members: m.members, rooms: m.rooms, invites: m.invites, priv: m.priv }, keyOf).err !== "", "");
// a member of the room could make a ciphertext with the same Poly1305 tag (the key is shared): the signature covers the
// ciphertext itself, so a file of Ann's cannot carry Bob's content
{
  const h = f.subarray(8, 8 + ((f[4] ?? 0) | ((f[5] ?? 0) << 8) | ((f[6] ?? 0) << 16)));
  const t = f.slice(); const ctAt = 8 + h.length; t[ctAt] = (t[ctAt] ?? 0) ^ 1;
  ok("a changed ciphertext under the same header and signature: refused", openFile(t, m, keyOf).err !== "", "");
}
// a header that is not exactly the canonical one (an extra key, other key order): refused
{
  const hl = (f[4] ?? 0) | ((f[5] ?? 0) << 8) | ((f[6] ?? 0) << 16) | ((f[7] ?? 0) << 24);
  const ht = new TextDecoder().decode(f.subarray(8, 8 + hl));
  const extra = new TextEncoder().encode(ht.split("{\"format\"").join("{\"x\":1,\"format\""));
  const t = new Uint8Array(f.length + extra.length - hl); t.set(f.subarray(0, 4), 0);
  t[4] = extra.length & 255; t[5] = (extra.length >>> 8) & 255; t.set(extra, 8); t.set(f.subarray(8 + hl), 8 + extra.length);
  ok("an extra header key: refused", openFile(t, m, keyOf).err.indexOf("header") >= 0, openFile(t, m, keyOf).err);
}
// a plaintext that says it is larger than 256 MB: refused before it is inflated (a gzip whose ISIZE lies, sealed validly)
{
  const big = new Uint8Array(20); big[0] = 31; big[1] = 139; big[2] = 8; big[16] = 255; big[17] = 255; big[18] = 255; big[19] = 255;
  ok("OPEN_MAX is 256 MB", OPEN_MAX === 268435456, String(OPEN_MAX));
  const e = openFile(sealFileGz(head(ann.id, 1790000001000, 2), big, k2, ann), m, keyOf).err;
  ok("a lying size field: refused", e.indexOf("too large") >= 0, e);
}
console.log(bad ? String(bad) + " failed" : "team sealed: all checks passed");
if (bad) process.exit(1);
