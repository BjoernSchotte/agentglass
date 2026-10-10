// agentglass — team crypto (fleet-teams spec 8): Monocypher 4.0.2 through src/features/team/crypto/agcrypto.c, bound by
// scriptc --ffi crypto/ffi.json (build.sh passes it on every OS). A build without the manifest compiles and throws on
// the first call: selfTest() names that. Every function throws Error("crypto: …") on a wrapper refusal (a wrong length:
// -2, nothing written) and never returns partial output. Random keys and nonces come from randomBytes (/dev/urandom).
// SPDX-License-Identifier: Apache-2.0
import { randomBytes, hex } from "../../util/rand.ts";

// 0 = ok, -1 = refused (invalid signature, failed open, low-order point), -2 = a wrong length
declare function agSignKeypair(seed: Uint8Array, sk: Uint8Array, pk: Uint8Array): number;
declare function agSign(sk: Uint8Array, msg: Uint8Array, sig: Uint8Array): number;
declare function agVerify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): number;
declare function agX25519Keypair(sk: Uint8Array, pk: Uint8Array): number;
declare function agX25519(sk: Uint8Array, pk: Uint8Array, out: Uint8Array): number;
declare function agSeal(pk: Uint8Array, ephSk: Uint8Array, nonce: Uint8Array, msg: Uint8Array, out: Uint8Array): number;
declare function agSealOpen(sk: Uint8Array, pk: Uint8Array, box: Uint8Array, out: Uint8Array): number;
declare function agLock(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, msg: Uint8Array, ct: Uint8Array, mac: Uint8Array): number;
declare function agUnlock(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ct: Uint8Array, mac: Uint8Array, out: Uint8Array): number;
declare function agKdf(key: Uint8Array, msg: Uint8Array, out: Uint8Array): number;
declare function agWipe(b: Uint8Array): number;

export const CRYPTO_LIB = "monocypher 4.0.2";
export interface SignKeys { sk: Uint8Array; pk: Uint8Array } // sk 64 (seed ‖ pk), pk 32
export interface BoxKeys { sk: Uint8Array; pk: Uint8Array } // X25519, 32 each

function must(rc: number, what: string): void {
  if (rc === -2) throw new Error("crypto: wrong length (" + what + ")");
  if (rc !== 0) throw new Error("crypto: " + what + " refused");
}
// EdDSA (BLAKE2b) keys from a 32-byte seed; the seed buffer is left as it was
export function signKeys(seed32: Uint8Array): SignKeys {
  const sk = new Uint8Array(64); const pk = new Uint8Array(32);
  must(agSignKeypair(seed32, sk, pk), "sign keypair");
  return { sk, pk };
}
export function sign(sk: Uint8Array, msg: Uint8Array): Uint8Array {
  const sig = new Uint8Array(64);
  must(agSign(sk, msg, sig), "sign");
  return sig;
}
// false for any invalid signature (also one of the wrong length); throws only on a public key of the wrong length
export function verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  const rc = agVerify(pk, msg, sig);
  if (rc === -2) must(rc, "verify");
  return rc === 0;
}
export function boxKeys(sk32: Uint8Array): BoxKeys {
  const pk = new Uint8Array(32);
  must(agX25519Keypair(sk32, pk), "x25519 keypair");
  const sk = new Uint8Array(32); sk.set(sk32, 0);
  return { sk, pk };
}
// raw X25519 (the RFC 7748 vector in the check; protocol code uses seal)
export function x25519(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  must(agX25519(sk, pk, out), "x25519");
  return out;
}
// anonymous sealed box to an X25519 key: eph pk 32 | nonce 24 | mac 16 | ct
export function seal(pk: Uint8Array, msg: Uint8Array): Uint8Array {
  const eph = randomBytes(32); const nonce = randomBytes(24);
  const out = new Uint8Array(72 + msg.length);
  const rc = agSeal(pk, eph, nonce, msg, out);
  agWipe(eph);
  must(rc, "seal");
  return out;
}
// null when the box is not for these keys, tampered or too short
export function sealOpen(keys: BoxKeys, box: Uint8Array): Uint8Array | null {
  if (box.length < 72) return null;
  const out = new Uint8Array(box.length - 72);
  const rc = agSealOpen(keys.sk, keys.pk, box, out);
  if (rc === -2) must(rc, "seal open");
  return rc === 0 ? out : null;
}
// XChaCha20-Poly1305 with associated data; the nonce must never repeat with a key (callers pass randomBytes(24))
export function lock(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, msg: Uint8Array): { ct: Uint8Array; mac: Uint8Array } {
  const ct = new Uint8Array(msg.length); const mac = new Uint8Array(16);
  must(agLock(key, nonce, ad, msg, ct, mac), "lock");
  return { ct, mac };
}
// the wrapper's return code, writing into the caller's buffers (the check proves -2 writes nothing)
export function lockRaw(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, msg: Uint8Array, ct: Uint8Array, mac: Uint8Array): number {
  return agLock(key, nonce, ad, msg, ct, mac);
}
// null when the key, nonce, associated data, ciphertext or mac do not match
export function unlock(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ct: Uint8Array, mac: Uint8Array): Uint8Array | null {
  const out = new Uint8Array(ct.length);
  const rc = agUnlock(key, nonce, ad, ct, mac, out);
  if (rc === -2) must(rc, "unlock");
  if (rc !== 0) { agWipe(out); return null; }
  return out;
}
// keyed BLAKE2b of a label: n (1..64) bytes derived from key
export function kdf(key: Uint8Array, label: string, n: number): Uint8Array {
  if (n < 1 || n > 64) throw new Error("crypto: kdf length " + String(n) + " (1..64)");
  const out = new Uint8Array(n);
  must(agKdf(key, new TextEncoder().encode(label), out), "kdf");
  return out;
}
// BLAKE2b-256 → its first 16 hex (member ids: hash16(signing pk))
export function hash16(b: Uint8Array): string {
  const out = new Uint8Array(32);
  must(agKdf(new Uint8Array(0), b, out), "hash");
  return hex(out).slice(0, 16);
}
export function wipe(b: Uint8Array): void { if (b.length > 0) agWipe(b); }

// "" when seal/open and sign/verify work on fixed inputs, else what failed (team doctor; a build without the manifest)
export function selfTest(): string {
  try {
    const seed = new Uint8Array(32); for (let i = 0; i < 32; i++) seed[i] = i + 1;
    const msg = new TextEncoder().encode("agentglass self-test");
    const k = signKeys(seed); const sig = sign(k.sk, msg);
    if (!verify(k.pk, msg, sig)) return "crypto: signature does not verify";
    const bad = new Uint8Array(msg.length); bad.set(msg, 0); bad[0] = (bad[0] ?? 0) ^ 1;
    if (verify(k.pk, bad, sig)) return "crypto: a changed message verifies";
    const bk = boxKeys(seed); const box = seal(bk.pk, msg); const o = sealOpen(bk, box);
    if (o === null || hex(o) !== hex(msg)) return "crypto: sealed box does not open";
    box[80] = (box[80] ?? 0) ^ 1;
    if (sealOpen(bk, box) !== null) return "crypto: a tampered box opens";
    const key = kdf(seed, "agentglass/self-test", 32); const nonce = kdf(seed, "agentglass/self-test/nonce", 24);
    const l = lock(key, nonce, seed, msg); const u = unlock(key, nonce, seed, l.ct, l.mac);
    if (u === null || hex(u) !== hex(msg)) return "crypto: aead does not open";
    if (unlock(key, nonce, msg, l.ct, l.mac) !== null) return "crypto: aead opens with other associated data";
    return "";
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return (m.startsWith("crypto: ") ? m : "crypto: " + m) + " (built without src/features/team/crypto/ffi.json?)";
  }
}
