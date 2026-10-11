// agentglass — sealed room files `agentglass-team/v1` (fleet-teams spec 7):
//   "AGT1" | u32 LE header length | header JSON | ciphertext | 64-byte signature
// ciphertext = XChaCha20-Poly1305(room key of the epoch, nonce, gzip(snapshot lines), ad = the header with "mac":"")
// signature  = EdDSA(member key, "agentglass-team/v1|" ‖ header ‖ ciphertext)
// The signature covers the ciphertext itself, not only the tag in the header: every room member holds the room key and
// could make another ciphertext with the same Poly1305 tag. Readers check, in order: magic, the canonical header, the
// sender (a member with that device; a removed one only for files from before the removal), the signature, the epoch
// key, the tag, the declared size (≤ 256 MB, before inflating).
// SPDX-License-Identifier: Apache-2.0
import { obj, str, parse } from "../../util/json.ts";
import { randomBytes, b64url, unb64url, unhex } from "../../util/rand.ts";
import { gzip } from "../../util/gzip.ts";
import { gzipIsize, gunzipCapped } from "../../util/inflate.ts";
import { sign, verify, lock, unlock } from "./crypto.ts";
import { type MemberKeys } from "./keys.ts";
import { type Manifest, cat } from "./manifest.ts";

export interface Head { team: string; room: string; epoch: number; member: string; device: string; kind: string; n: number; gen: string; base: string; at: number }
export const OPEN_MAX = 268435456; // decoded bytes a reader accepts (as dirfeed.ts)
const FORMAT = "agentglass-team/v1";
const ID = /^[0-9a-f]{16}$/; const GEN = /^[0-9A-Za-z_-]{0,64}$/;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function headJson(h: Head, nonce: string, mac: string): string {
  return JSON.stringify({ format: FORMAT, team: h.team, room: h.room, epoch: h.epoch, member: h.member, device: h.device, kind: h.kind, n: h.n, gen: h.gen, base: h.base, at: h.at, nonce, mac });
}
// the file for h with gz (already gzip) as its sealed body; sealFile compresses for the caller
export function sealFileGz(h: Head, gz: Uint8Array, roomKey: Uint8Array, k: MemberKeys): Uint8Array {
  const nonce = randomBytes(24); const nb = b64url(nonce);
  const l = lock(roomKey, nonce, enc(headJson(h, nb, "")), gz);
  const hb = enc(headJson(h, nb, b64url(l.mac)));
  const pre = new Uint8Array(8); pre.set(enc("AGT1"), 0);
  pre[4] = hb.length & 255; pre[5] = (hb.length >>> 8) & 255; pre[6] = (hb.length >>> 16) & 255; pre[7] = (hb.length >>> 24) & 255;
  return cat([pre, hb, l.ct, sign(k.sign.sk, cat([enc("agentglass-team/v1|"), hb, l.ct]))]);
}
export function sealFile(h: Head, plain: Uint8Array, roomKey: Uint8Array, k: MemberKeys): Uint8Array { return sealFileGz(h, gzip(plain), roomKey, k); }

function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : NaN; }
function fail(err: string): { h: Head | null; plain: Uint8Array | null; err: string } { return { h: null, plain: null, err }; }
// the file's header and plaintext if it is genuine and readable with the keys held; err names the first check that failed
export function openFile(b: Uint8Array, m: Manifest, keyOf: (room: string, epoch: number) => Uint8Array | null): { h: Head | null; plain: Uint8Array | null; err: string } {
  if (b.length < 8 + 2 + 64 || b[0] !== 65 || b[1] !== 71 || b[2] !== 84 || b[3] !== 49) return fail("not a sealed team file");
  const hl = (b[4] ?? 0) + (b[5] ?? 0) * 256 + (b[6] ?? 0) * 65536 + (b[7] ?? 0) * 16777216;
  if (hl < 2 || 8 + hl > b.length - 64) return fail("truncated");
  const ht = new TextDecoder("utf-8").decode(b.subarray(8, 8 + hl));
  const o = obj(parse(ht)); if (!o) return fail("header is not JSON");
  const h: Head = { team: str(o["team"]), room: str(o["room"]), epoch: num(o["epoch"]), member: str(o["member"]), device: str(o["device"]), kind: str(o["kind"]), n: num(o["n"]), gen: str(o["gen"]), base: str(o["base"]), at: num(o["at"]) };
  const nb = str(o["nonce"]); const mb = str(o["mac"]);
  if (o["format"] !== FORMAT || headJson(h, nb, mb) !== ht) return fail("header is not canonical agentglass-team/v1 (an unknown key, a type, an order)");
  if (!ID.test(h.team) || !ID.test(h.room) || !ID.test(h.member) || !ID.test(h.device) || (h.kind !== "base" && h.kind !== "delta")
    || !Number.isInteger(h.epoch) || h.epoch < 1 || !Number.isInteger(h.n) || h.n < 0 || !GEN.test(h.gen) || !GEN.test(h.base) || !(h.at > 0)) return fail("header fields invalid");
  const nonce = unb64url(nb); const mac = unb64url(mb);
  if (!nonce || nonce.length !== 24 || !mac || mac.length !== 16) return fail("header nonce or mac invalid");
  if (h.team !== m.team) return fail("a file of another team");
  let pk = "";
  for (const x of m.members) if (x.id === h.member) {
    if (x.devices.indexOf(h.device) < 0) return fail("device " + h.device + " is not member " + h.member + "'s");
    if (x.removedAt > 0 && h.at >= x.removedAt) return fail("member " + h.member + " was removed before this file");
    pk = x.signPk;
  }
  if (!pk) return fail("unknown member " + h.member);
  const ct = b.subarray(8 + hl, b.length - 64);
  const key = unhex(pk);
  if (!key || !verify(key, cat([enc("agentglass-team/v1|"), b.subarray(8, 8 + hl), ct]), b.subarray(b.length - 64))) return fail("signature invalid");
  const rk = keyOf(h.room, h.epoch); if (!rk) return fail("no key for epoch " + String(h.epoch) + " of room " + h.room);
  const gz = unlock(rk, nonce, enc(headJson(h, nb, "")), ct, mac); if (!gz) return fail("does not open with the epoch key");
  if (gzipIsize(gz) > OPEN_MAX) return fail("too large: over 256 MB decoded");
  const u = gunzipCapped(gz, OPEN_MAX); if (u.err) return fail("gzip: " + u.err);
  return { h, plain: u.out, err: "" };
}
