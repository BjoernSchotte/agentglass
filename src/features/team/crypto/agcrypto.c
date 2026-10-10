// agentglass — team crypto for src/features/team/crypto.ts, bound through scriptc --ffi (ffi.json): EdDSA (BLAKE2b),
// X25519, an anonymous sealed box, XChaCha20-Poly1305 with associated data, keyed BLAKE2b, all from the vendored
// Monocypher 4.0.2 (monocypher.c, unmodified). Each `bytes` parameter is (pointer, length). Every entry checks every
// length first: a wrong one returns -2 and writes nothing. 0 = ok, -1 = refused (bad signature, failed open). A
// zero-length input is never dereferenced (scriptc passes a non-null pointer today; the wrapper does not rely on it).
// C has no RNG here: random keys and nonces come from the caller (randomBytes, /dev/urandom).
// SPDX-License-Identifier: Apache-2.0
#include <stdint.h>
#include <string.h>
#include "monocypher.c"

static const uint8_t ag_none[1] = { 0 };
// a pointer safe to hand Monocypher for n bytes: never the caller's when n is 0
#define IN(p, n) ((n) ? (const uint8_t *)(p) : ag_none)

// seed (32) → sk (64), pk (32). The caller's seed stays as it was (Monocypher wipes its copy)
int ag_sign_keypair(uint8_t *seed, size_t ns, uint8_t *sk, size_t nsk, uint8_t *pk, size_t npk) {
  if (ns != 32 || nsk != 64 || npk != 32) return -2;
  uint8_t s[32]; memcpy(s, seed, 32);
  crypto_eddsa_key_pair(sk, pk, s);
  crypto_wipe(s, 32);
  return 0;
}

int ag_sign(uint8_t *sk, size_t nsk, uint8_t *msg, size_t nm, uint8_t *sig, size_t nsig) {
  if (nsk != 64 || nsig != 64) return -2;
  crypto_eddsa_sign(sig, sk, IN(msg, nm), nm);
  return 0;
}

// 0 = valid, -1 = not (a signature of the wrong length is just invalid)
int ag_verify(uint8_t *pk, size_t npk, uint8_t *msg, size_t nm, uint8_t *sig, size_t nsig) {
  if (npk != 32) return -2;
  if (nsig != 64) return -1;
  return crypto_eddsa_check(sig, pk, IN(msg, nm), nm) == 0 ? 0 : -1;
}

// X25519 public key of a 32-byte secret
int ag_x25519_keypair(uint8_t *sk, size_t nsk, uint8_t *pk, size_t npk) {
  if (nsk != 32 || npk != 32) return -2;
  crypto_x25519_public_key(pk, sk);
  return 0;
}

// raw X25519 (checks: the RFC 7748 vector)
int ag_x25519(uint8_t *sk, size_t nsk, uint8_t *pk, size_t npk, uint8_t *out, size_t no) {
  if (nsk != 32 || npk != 32 || no != 32) return -2;
  crypto_x25519(out, sk, pk);
  return 0;
}

static int all_zero(const uint8_t *b, size_t n) { uint8_t d = 0; for (size_t i = 0; i < n; i++) d |= b[i]; return d == 0; }

// box key = BLAKE2b-256 keyed with the X25519 shared secret over (ephemeral pk ‖ recipient pk); -1 on a low-order
// point (all-zero shared secret)
static int box_key(uint8_t key[32], const uint8_t sk[32], const uint8_t their[32], const uint8_t eph_pk[32], const uint8_t rcpt_pk[32]) {
  uint8_t shared[32], both[64];
  crypto_x25519(shared, sk, their);
  int lowOrder = all_zero(shared, 32);
  memcpy(both, eph_pk, 32); memcpy(both + 32, rcpt_pk, 32);
  crypto_blake2b_keyed(key, 32, shared, 32, both, 64);
  crypto_wipe(shared, 32);
  return lowOrder ? -1 : 0;
}

// sealed box to pk: out = eph pk (32) | nonce (24) | mac (16) | ct (nm). eph_sk and nonce are random from the caller
int ag_seal(uint8_t *pk, size_t npk, uint8_t *eph_sk, size_t ne, uint8_t *nonce, size_t nn, uint8_t *msg, size_t nm, uint8_t *out, size_t no) {
  if (npk != 32 || ne != 32 || nn != 24 || nm > SIZE_MAX - 72 || no != 72 + nm) return -2;
  uint8_t eph_pk[32], key[32];
  crypto_x25519_public_key(eph_pk, eph_sk);
  if (box_key(key, eph_sk, pk, eph_pk, pk) != 0) { crypto_wipe(key, 32); return -1; }
  memcpy(out, eph_pk, 32); memcpy(out + 32, nonce, 24);
  crypto_aead_lock(out + 72, out + 56, key, nonce, ag_none, 0, IN(msg, nm), nm);
  crypto_wipe(key, 32);
  return 0;
}

// opens a sealed box with the recipient's sk and pk into out (nb - 72 bytes); -1 = not for this key or tampered
int ag_seal_open(uint8_t *sk, size_t nsk, uint8_t *pk, size_t npk, uint8_t *box, size_t nb, uint8_t *out, size_t no) {
  if (nsk != 32 || npk != 32) return -2;
  if (nb < 72) return -1;
  if (no != nb - 72) return -2;
  uint8_t key[32];
  if (box_key(key, sk, box, box, pk) != 0) { crypto_wipe(key, 32); return -1; }
  int r = crypto_aead_unlock(no ? out : (uint8_t *)ag_none, box + 56, key, box + 32, ag_none, 0, IN(box + 72, no), no);
  crypto_wipe(key, 32);
  return r == 0 ? 0 : -1;
}

// XChaCha20-Poly1305 with associated data: ct (nm bytes), mac (16)
int ag_lock(uint8_t *key, size_t nk, uint8_t *nonce, size_t nn, uint8_t *ad, size_t na, uint8_t *msg, size_t nm, uint8_t *ct, size_t nc, uint8_t *mac, size_t nmac) {
  if (nk != 32 || nn != 24 || nc != nm || nmac != 16) return -2;
  crypto_aead_lock(nm ? ct : (uint8_t *)ag_none, mac, key, nonce, IN(ad, na), na, IN(msg, nm), nm);
  return 0;
}

// -1 = tampered or the wrong key/nonce/ad; out stays unspecified then (the caller drops it)
int ag_unlock(uint8_t *key, size_t nk, uint8_t *nonce, size_t nn, uint8_t *ad, size_t na, uint8_t *ct, size_t nc, uint8_t *mac, size_t nmac, uint8_t *out, size_t no) {
  if (nk != 32 || nn != 24 || nmac != 16 || no != nc) return -2;
  return crypto_aead_unlock(nc ? out : (uint8_t *)ag_none, mac, key, nonce, IN(ad, na), na, IN(ct, nc), nc) == 0 ? 0 : -1;
}

// keyed BLAKE2b (key 1..64 bytes) of msg into out (1..64 bytes); key length 0 = plain BLAKE2b
int ag_kdf(uint8_t *key, size_t nk, uint8_t *msg, size_t nm, uint8_t *out, size_t no) {
  if (nk > 64 || no < 1 || no > 64) return -2;
  crypto_blake2b_keyed(out, no, IN(key, nk), nk, IN(msg, nm), nm);
  return 0;
}

int ag_wipe(uint8_t *b, size_t n) {
  if (n) crypto_wipe(b, n);
  return 0;
}
