// agentglass — self-check for the capped gzip reader: scriptc build src/util/inflate.check.ts -o ic && ./ic
// SPDX-License-Identifier: Apache-2.0
import * as zlib from "node:zlib";
import { gunzipCapped, gzipIsize } from "./inflate.ts";
import { gzip } from "./gzip.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function same(a: Uint8Array, b: Uint8Array): boolean { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
let seed = 12345;
function rnd(): number { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; }

// inputs: empty, text, OTLP-like JSON, random bytes, long runs (overlapping copies), all byte values
function jsonBody(): Uint8Array { let s = "{\"resourceSpans\":["; for (let i = 0; i < 3000; i++) s += "{\"traceId\":\"" + String(i * 7919) + "abcdef\",\"name\":\"execute_tool Bash\",\"attributes\":[{\"key\":\"k" + String(i % 13) + "\"}]},"; return enc(s + "{}]}"); }
const json = jsonBody();
const rand = new Uint8Array(70000); for (let i = 0; i < rand.length; i++) rand[i] = rnd() & 255;
const runs = new Uint8Array(300000); for (let i = 0; i < runs.length; i++) runs[i] = i < 150000 ? 97 : (i >> 10) & 255;
const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
function roundTrip(i: number, x: Uint8Array): void {
  const z = zlib.gzipSync(x); // real zlib: dynamic Huffman blocks, stored blocks for random data
  const r = gunzipCapped(z, 64 * 1048576);
  ok("zlib → ours #" + String(i), r.err === "" && same(r.out, x), r.err + " len " + String(r.out.length) + " want " + String(x.length));
  const g = gzip(x); // our writer: fixed Huffman blocks
  const r2 = gunzipCapped(g, 64 * 1048576);
  ok("gzip.ts → ours #" + String(i), r2.err === "" && same(r2.out, x), r2.err);
}
roundTrip(0, new Uint8Array(0)); roundTrip(1, enc("hello hello hello hello")); roundTrip(2, json); roundTrip(3, rand); roundTrip(4, runs); roundTrip(5, all);
// concatenated members
const two = new Uint8Array(zlib.gzipSync(enc("ab")).length + zlib.gzipSync(enc("cd")).length);
two.set(zlib.gzipSync(enc("ab")), 0); two.set(zlib.gzipSync(enc("cd")), zlib.gzipSync(enc("ab")).length);
const r2m = gunzipCapped(two, 100);
ok("two members", r2m.err === "" && new TextDecoder("utf-8").decode(r2m.out) === "abcd", r2m.err);

// the cap: a 100 MB bomb stops at the cap; a lying ISIZE does not get past it either
const bomb = zlib.gzipSync(new Uint8Array(100 * 1048576));
ok("bomb isize", gzipIsize(bomb) === 100 * 1048576, String(gzipIsize(bomb)));
const t0 = Date.now(); const rb = gunzipCapped(bomb, 1048576);
ok("bomb capped", rb.err.indexOf("over 1048576") >= 0 && rb.out.length === 0, rb.err);
console.log("inflate: bomb of " + String(Math.round(bomb.length / 1024)) + " KB refused at a 1 MB cap in " + String(Date.now() - t0) + " ms");
const liar = new Uint8Array(bomb.length); liar.set(bomb);
liar[liar.length - 4] = 10; liar[liar.length - 3] = 0; liar[liar.length - 2] = 0; liar[liar.length - 1] = 0;
ok("lying ISIZE still capped", gunzipCapped(liar, 1048576).err.indexOf("over") >= 0, gunzipCapped(liar, 1048576).err);
const exact = zlib.gzipSync(new Uint8Array(1000));
ok("exactly at the cap", gunzipCapped(exact, 1000).err === "" && gunzipCapped(exact, 999).err !== "", gunzipCapped(exact, 1000).err);

// damaged input: errors, never a throw
const good = zlib.gzipSync(json);
const bc = new Uint8Array(good.length); bc.set(good); bc[bc.length - 6] ^= 1;
ok("crc mismatch", gunzipCapped(bc, 1 << 26).err.indexOf("CRC") >= 0, gunzipCapped(bc, 1 << 26).err);
ok("not gzip", gunzipCapped(enc("{\"resourceSpans\":[] padding padding}"), 100).err !== "", "accepted");
ok("truncated", gunzipCapped(good.subarray(0, good.length - 20), 1 << 26).err !== "", "accepted");
const tg = new Uint8Array(good.length + 3); tg.set(good);
ok("trailing garbage", gunzipCapped(tg, 1 << 26).err !== "", "accepted");
let thrown = 0; let wrong = 0;
for (let i = 0; i < 1500; i++) {
  const src = i % 3 === 0 ? good : i % 3 === 1 ? zlib.gzipSync(rand.subarray(0, 2000)) : gzip(json.subarray(0, 5000));
  const m = new Uint8Array(src.length); m.set(src);
  const k = 1 + (rnd() % 6); for (let j = 0; j < k; j++) m[10 + (rnd() % (m.length - 10))] = rnd() & 255;
  try { const r = gunzipCapped(m, 1 << 20); if (!r.err && r.out.length > 1 << 20) wrong++; } catch (e) { thrown++; }
}
for (let i = 0; i < 500; i++) { const n = rnd() % 400; const b = new Uint8Array(n); for (let j = 0; j < n; j++) b[j] = rnd() & 255; if (n > 3) { b[0] = 0x1f; b[1] = 0x8b; b[2] = 8; b[3] = 0; } try { gunzipCapped(b, 1 << 20); } catch (e) { thrown++; } }
ok("fuzz: no throw", thrown === 0, String(thrown));
ok("fuzz: never over the cap", wrong === 0, String(wrong));

// throughput: a 4 MB OTLP-like body
let big = ""; for (let i = 0; i < 40000; i++) big += "{\"traceId\":\"" + String(i * 2654435761 % 4294967296) + "\",\"name\":\"chat model-x\",\"attributes\":[{\"key\":\"gen_ai.usage.input_tokens\",\"value\":{\"intValue\":\"" + String(i) + "\"}}]},";
const bigB = enc(big); const bz = zlib.gzipSync(bigB);
const t1 = Date.now(); const rr = gunzipCapped(bz, 64 * 1048576); const ms = Date.now() - t1;
ok("4 MB body", rr.err === "" && rr.out.length === bigB.length, rr.err);
console.log("inflate: " + String(Math.round(bigB.length / 1024)) + " KB from " + String(Math.round(bz.length / 1024)) + " KB in " + String(ms) + " ms");
if (bad) console.log(String(bad) + " failed"); else console.log("inflate: all checks passed");
if (bad) process.exit(1);
