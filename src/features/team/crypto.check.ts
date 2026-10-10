// check: crypto
// agentglass — self-check for the team crypto (fleet-teams spec 8): known-answer vectors through the Monocypher wrapper,
// tamper and length refusals, the vendored sources' hashes.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/crypto.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { readBytes } from "../../util/fs.ts";
import { signKeys, sign, verify, boxKeys, seal, sealOpen, lock, unlock, kdf, hash16, wipe, selfTest, x25519, lockRaw, CRYPTO_LIB } from "./crypto.ts";
import { hex } from "../../util/rand.ts";
import { sha256Bytes, hexOf } from "../../util/sha256.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function unhex(s: string): Uint8Array { const b = new Uint8Array(s.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return b; }
function bytes(s: string): Uint8Array { return new TextEncoder().encode(s); }
function seq(from: number, n: number): Uint8Array { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (from + i) & 255; return b; }
function flip(b: Uint8Array, i: number): Uint8Array { const c = new Uint8Array(b.length); c.set(b, 0); c[i] = (c[i] ?? 0) ^ 1; return c; }
function throwsCrypto(f: () => void): string { try { f(); return "no throw"; } catch (e) { const m = e instanceof Error ? e.message : String(e); return m.startsWith("crypto: ") ? "" : m; } }

// RFC 7748 §5.2, first vector
ok("x25519 RFC 7748", hex(x25519(unhex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"), unhex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"))) === "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552", "");

// draft-irtf-cfrg-xchacha-03 A.3.1
{
  const key = seq(0x80, 32); const nonce = seq(0x40, 24); const ad = unhex("50515253c0c1c2c3c4c5c6c7");
  const pt = bytes("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const r = lock(key, nonce, ad, pt);
  ok("xchacha ciphertext prefix", hex(r.ct).startsWith("bd6d179d3e83d43b9576579493c0e939"), hex(r.ct).slice(0, 32));
  ok("xchacha ciphertext length", r.ct.length === pt.length, String(r.ct.length));
  ok("xchacha tag", hex(r.mac) === "c0875924c1c7987947deafd8780acf49", hex(r.mac));
  const back = unlock(key, nonce, ad, r.ct, r.mac);
  ok("unlock round trip", back !== null && new TextDecoder().decode(back) === new TextDecoder().decode(pt), "");
  ok("flipped ct → null", unlock(key, nonce, ad, flip(r.ct, 5), r.mac) === null, "");
  ok("flipped mac → null", unlock(key, nonce, ad, r.ct, flip(r.mac, 15)) === null, "");
  ok("flipped ad → null", unlock(key, nonce, flip(ad, 0), r.ct, r.mac) === null, "");
  ok("flipped nonce → null", unlock(key, flip(nonce, 23), ad, r.ct, r.mac) === null, "");
  ok("flipped key → null", unlock(flip(key, 0), nonce, ad, r.ct, r.mac) === null, "");
  // zero-length message and associated data (open question 2: never dereferenced)
  const z = lock(key, nonce, new Uint8Array(0), new Uint8Array(0));
  ok("empty lock", z.ct.length === 0 && z.mac.length === 16, String(z.ct.length));
  const zb = unlock(key, nonce, new Uint8Array(0), z.ct, z.mac);
  ok("empty unlock", zb !== null && zb.length === 0, "");
  ok("empty, ad differs → null", unlock(key, nonce, bytes("x"), z.ct, z.mac) === null, "");
  // wrong lengths: the wrapper refuses (-2) and writes nothing
  ok("31-byte key throws", throwsCrypto(() => { lock(seq(0, 31), nonce, ad, pt); }) === "", "");
  ok("23-byte nonce throws", throwsCrypto(() => { lock(key, seq(0, 23), ad, pt); }) === "", "");
  ok("15-byte mac throws", throwsCrypto(() => { unlock(key, nonce, ad, r.ct, seq(0, 15)); }) === "", "");
  const ct = new Uint8Array(pt.length); const mac = new Uint8Array(16);
  for (let i = 0; i < ct.length; i++) ct[i] = 7; for (let i = 0; i < 16; i++) mac[i] = 7;
  const rc = lockRaw(seq(0, 31), nonce, ad, pt, ct, mac);
  let same = true; for (let i = 0; i < ct.length; i++) if (ct[i] !== 7) same = false; for (let i = 0; i < 16; i++) if (mac[i] !== 7) same = false;
  ok("-2 on a short key, buffers unchanged", rc === -2 && same, String(rc));
  ok("-2 on a short output", lockRaw(key, nonce, ad, pt, new Uint8Array(pt.length - 1), mac) === -2, "");
}

// EdDSA (BLAKE2b): round trip, a flipped bit anywhere → false
{
  const k = signKeys(seq(1, 32)); const k2 = signKeys(seq(1, 32));
  ok("sign keys sizes", k.sk.length === 64 && k.pk.length === 32, String(k.sk.length) + "/" + String(k.pk.length));
  ok("sign keys deterministic from the seed", hex(k.pk) === hex(k2.pk), "");
  const seed = seq(1, 32); signKeys(seed);
  ok("seed buffer untouched", hex(seed) === hex(seq(1, 32)), hex(seed));
  const msg = bytes("agentglass-team/v1|{\"room\":\"r\"}"); const sig = sign(k.sk, msg);
  ok("signature 64 bytes", sig.length === 64, String(sig.length));
  ok("verify", verify(k.pk, msg, sig), "");
  ok("flipped msg → false", !verify(k.pk, flip(msg, 3), sig), "");
  ok("flipped sig → false", !verify(k.pk, msg, flip(sig, 40)), "");
  ok("flipped pk → false", !verify(flip(k.pk, 7), msg, sig), "");
  ok("other key → false", !verify(signKeys(seq(9, 32)).pk, msg, sig), "");
  ok("empty message signs", verify(k.pk, new Uint8Array(0), sign(k.sk, new Uint8Array(0))), "");
  ok("short signature → false, no throw", !verify(k.pk, msg, sig.subarray(0, 63)), "");
  ok("33-byte pk throws", throwsCrypto(() => { verify(seq(0, 33), msg, sig); }) === "", "");
  ok("short sk throws", throwsCrypto(() => { sign(seq(0, 32), msg); }) === "", "");
}

// sealed box: anonymous, to one X25519 key
{
  const a = boxKeys(seq(3, 32)); const b = boxKeys(seq(5, 32));
  ok("box keys sizes", a.sk.length === 32 && a.pk.length === 32 && hex(a.pk) !== hex(b.pk), "");
  const m = bytes("room key 0123456789abcdef0123456789abcdef");
  const box = seal(a.pk, m);
  ok("box layout: 32 + 24 + 16 + n", box.length === 72 + m.length, String(box.length));
  const o = sealOpen(a, box);
  ok("seal round trip", o !== null && hex(o) === hex(m), "");
  ok("wrong key → null", sealOpen(b, box) === null, "");
  ok("tampered box → null", sealOpen(a, flip(box, 40)) === null && sealOpen(a, flip(box, 2)) === null && sealOpen(a, flip(box, box.length - 1)) === null, "");
  ok("short box → null", sealOpen(a, box.subarray(0, 71)) === null, "");
  ok("two seals differ (random ephemeral key and nonce)", hex(seal(a.pk, m)) !== hex(seal(a.pk, m)), "");
  const e = seal(a.pk, new Uint8Array(0)); const eo = sealOpen(a, e);
  ok("empty sealed message", e.length === 72 && eo !== null && eo.length === 0, String(e.length));
  ok("low-order recipient (all zero) → throws", throwsCrypto(() => { seal(new Uint8Array(32), m); }) === "", "");
}

// keyed BLAKE2b and the 16-hex id hash
{
  const k = seq(0, 32);
  const a = kdf(k, "agentglass/team/invite", 32); const a2 = kdf(k, "agentglass/team/invite", 32);
  ok("kdf deterministic, 32 bytes", a.length === 32 && hex(a) === hex(a2), "");
  ok("kdf label separates", hex(kdf(k, "agentglass/team/card", 32)) !== hex(a), "");
  ok("kdf key separates", hex(kdf(seq(1, 32), "agentglass/team/invite", 32)) !== hex(a), "");
  ok("kdf 64 bytes", kdf(k, "x", 64).length === 64, "");
  ok("kdf 65 bytes throws", throwsCrypto(() => { kdf(k, "x", 65); }) === "", "");
  ok("kdf 0 bytes throws", throwsCrypto(() => { kdf(k, "x", 0); }) === "", "");
  // BLAKE2b-256("abc") = bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319
  ok("hash16 BLAKE2b-256", hash16(bytes("abc")) === "bddd813c63423972", hash16(bytes("abc")));
  ok("hash16 of empty", hash16(new Uint8Array(0)).length === 16, "");
  const w = seq(1, 8); wipe(w);
  let z = true; for (let i = 0; i < 8; i++) if (w[i] !== 0) z = false;
  ok("wipe zeroes", z, hex(w));
  wipe(new Uint8Array(0));
}

ok("selfTest", selfTest() === "", selfTest());
ok("lib name", CRYPTO_LIB === "monocypher 4.0.2", CRYPTO_LIB);

// the vendored sources are Monocypher 4.0.2 unmodified (hashes of the release tarball's src/, fleet-teams Task 0)
function fileSha(p: string): string { return hexOf(sha256Bytes(readBytes(p, 0, 1 << 20))); }
ok("monocypher.c unmodified", fileSha("src/features/team/crypto/monocypher.c") === "afe2b098c8569577a84488e0b98d276d1fba6506adea68bb9241a52111734c59", fileSha("src/features/team/crypto/monocypher.c"));
ok("monocypher.h unmodified", fileSha("src/features/team/crypto/monocypher.h") === "f78bb31255cfb7beba66afd2137f5194c8a025cf40488b6cc1e295234d43f374", fileSha("src/features/team/crypto/monocypher.h"));

if (bad > 0) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("crypto: all checks passed");
