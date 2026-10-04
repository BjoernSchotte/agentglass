// agentglass — self-check for the pure-TS SHA-256: scriptc build src/util/sha256.check.ts -o sc && ./sc
// check: timing — a µs/id bench: scripts/check.sh builds this one -O2 and runs it alone, not -O0 under parallel load
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { sha256Hex, sha256Bytes, hexOf } from "./sha256.ts";
import { readBytes } from "./fs.ts";
import { OS } from "../platform/index.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }

eq("empty", sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
eq("abc", sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
eq("448-bit", sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
eq("896-bit", sha256Hex("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"), "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
eq("million a", sha256Hex("a".repeat(1000000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
// UTF-8 against the system tool (macOS has shasum, not sha256sum)
function sys(input: string): string {
  try { return execFileSync("sha256sum", [], { input, encoding: "utf8" }).split(" ")[0] ?? ""; }
  catch (e) { return execFileSync("shasum", ["-a", "256"], { input, encoding: "utf8" }).split(" ")[0] ?? ""; }
}
const u = "ü€😀";
eq("utf-8", sha256Hex(u), sys(u));
// padding edges: lengths around one and two blocks
for (const n of [55, 56, 63, 64, 65, 119, 120, 128]) eq("len " + String(n), sha256Hex("x".repeat(n)), sys("x".repeat(n)));

// 1,000 random files (seeded xorshift) against OS.sha256File
const dir = "/tmp/agentglass-sha-check-" + String(process.pid);
mkdirSync(dir, { recursive: true });
let x = 2463534242;
function rnd(): number { x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; return x; }
for (let i = 0; i < 1000; i++) {
  const n = rnd() % 301; const b = new Uint8Array(n);
  for (let j = 0; j < n; j++) b[j] = rnd() & 255;
  const p = dir + "/f" + String(i);
  writeFileSync(p, b);
  eq("file " + String(i) + " (" + String(n) + " bytes)", hexOf(sha256Bytes(readBytes(p, 0, 400))), OS.sha256File(p));
  if (bad > 5) break;
}
rmSync(dir, { recursive: true, force: true });

// cost per short id (native build target: < 20 µs)
const N = 10000; const t0 = Date.now(); let acc = 0;
for (let i = 0; i < N; i++) acc += sha256Hex("agentglass/otlp/v1|c|claude|abc|msg_01ABCdefGHIjkl" + String(i)).length;
const us = ((Date.now() - t0) * 1000) / N;
console.log("sha256: " + us.toFixed(2) + " µs/id");
// target < 20 µs (spec 4.2); the gate is 5× that: shared CI runners are slower and noisy, an order-of-magnitude slip still fails
if (us > 100 || acc !== N * 64) { bad++; console.log("FAIL bench: " + us.toFixed(2) + " µs/id > 100 (target 20)"); }

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("sha256: all checks passed");
