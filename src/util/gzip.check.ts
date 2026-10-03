// agentglass — self-check for the pure-TS gzip: scriptc build src/util/gzip.check.ts -o gz && ./gz
// SPDX-License-Identifier: Apache-2.0
// The round trips through the system gzip live in scripts/gzip.test.sh.
import { rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { crc32, gzip, deflateRaw, writeBin, gzipProbe } from "./gzip.ts";
import { readBytes } from "./fs.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
function list(b: Uint8Array): string { const o: string[] = []; for (let i = 0; i < b.length; i++) o.push(String(b[i])); return o.join(","); }

eq("crc32 empty", String(crc32(enc(""))), "0");
eq("crc32 123456789", String(crc32(enc("123456789"))), String(0xcbf43926));
eq("crc32 fox", String(crc32(enc("The quick brown fox jumps over the lazy dog"))), String(0x414fa339));
const g = gzip(enc("hello hello hello hello"));
eq("header", list(g.subarray(0, 10)), "31,139,8,0,0,0,0,0,0,255");
const n = g.length;
eq("isize", String(g[n - 4] | (g[n - 3] << 8) | (g[n - 2] << 16) | (g[n - 1] << 24)), "23");
eq("crc trailer", String((g[n - 8] | (g[n - 7] << 8) | (g[n - 6] << 16) | (g[n - 5] << 24)) >>> 0), String(crc32(enc("hello hello hello hello"))));
eq("empty deflate = final fixed block + end code", list(deflateRaw(new Uint8Array(0))), "3,0");

// file output keeps every byte value; mode 0600
const dir = "/tmp/agentglass-gzip-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
eq("writeBin", String(writeBin(dir + "/b.bin", all)) + " " + list(readBytes(dir + "/b.bin", 0, 300)) === "true " + list(all) ? "ok" : "bytes differ", "ok");
eq("writeBin mode", execFileSync("stat", process.platform === "darwin" ? ["-f", "%Lp", dir + "/b.bin"] : ["-c", "%a", dir + "/b.bin"], { encoding: "utf8" }).trim(), "600");
eq("probe", String(gzipProbe(dir)), "true");
rmSync(dir, { recursive: true, force: true });

// throughput on a 4 MB batch of repetitive OTLP/JSON: ≥ 20 MB/s, output < 25 % of input
const span = "{\"traceId\":\"5b8efff798038103d269b633813fc60c\",\"spanId\":\"eee19b7ec3c1b174\",\"parentSpanId\":\"eee19b7ec3c1b173\",\"name\":\"execute_tool Bash git\",\"kind\":1,\"startTimeUnixNano\":\"1767225600123000000\",\"endTimeUnixNano\":\"1767225601123000000\",\"attributes\":[{\"key\":\"gen_ai.operation.name\",\"value\":{\"stringValue\":\"execute_tool\"}},{\"key\":\"gen_ai.tool.name\",\"value\":{\"stringValue\":\"Bash\"}},{\"key\":\"gen_ai.tool.call.id\",\"value\":{\"stringValue\":\"toolu_";
const parts: string[] = []; let len = 0; let i = 0;
while (len < 4194304) { const p = span + String(i * 7919 % 100003) + "\"}}]},"; parts.push(p); len += p.length; i++; }
const big = enc(parts.join(""));
const t0 = Date.now(); const z = gzip(big); const dt = Math.max(1, Date.now() - t0);
const mbs = big.length / 1048576 / (dt / 1000);
console.log("gzip: " + mbs.toFixed(1) + " MB/s, " + (100 * z.length / big.length).toFixed(1) + " % of " + String(big.length) + " bytes in " + String(dt) + " ms");
if (mbs < 20) { bad++; console.log("FAIL throughput " + mbs.toFixed(1) + " MB/s < 20"); }
if (z.length * 4 >= big.length) { bad++; console.log("FAIL ratio " + String(z.length) + "/" + String(big.length)); }

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("gzip: all checks passed");
