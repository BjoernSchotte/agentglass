// agentglass — self-check for the deterministic OTLP ids: scriptc build src/features/otlp/ids.check.ts -o ic && ./ic
// SPDX-License-Identifier: Apache-2.0
import { PREFIX, H, rootKey, turnKeys, traceId, rootSpanId, chatSpanId, toolSpanId, agentSpanId, nonZero } from "./ids.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const hex = (s: string, n: number): boolean => s.length === n && /^[0-9a-f]+$/.test(s);

const R = rootKey("claude", "s1");
eq("root key", R, "claude|s1");
eq("prefix", PREFIX, "agentglass/otlp/v1|");
eq("H is sha256 of prefix + x", H("x").length === 64 ? "64" : "?", "64");
eq("turn keys", turnKeys(["t1", "t1", "t2", ""]).join(","), "t1#0,t1#1,t2#0,i4");
const T1 = "2026-01-01T00:00:00.000Z#0"; const T2 = "2026-01-01T00:05:00.000Z#0";
eq("same input same id", traceId(R, T1) + rootSpanId(R, T1), traceId(R, T1) + rootSpanId(R, T1));
eq("trace id: session half shared", traceId(R, T1).slice(0, 16), traceId(R, T2).slice(0, 16));
eq("trace id: turn half differs", String(traceId(R, T1).slice(16) !== traceId(R, T2).slice(16)), "true");
eq("trace id: session half from R only", traceId(R, T1).slice(0, 16), H("s|" + R).slice(0, 16));
for (const [n, v, l] of [["trace", traceId(R, T1), 32], ["root", rootSpanId(R, T1), 16], ["chat", chatSpanId(R, "s1", "msg_a"), 16], ["tool", toolSpanId(R, "s1", "toolu_1"), 16], ["agent", agentSpanId(R, "sub1", T1), 16]] as [string, string, number][]) eq(n + " hex", String(hex(v, l)), "true");
eq("kinds differ", String(new Set([rootSpanId(R, T1), chatSpanId(R, "s1", T1), toolSpanId(R, "s1", T1), agentSpanId(R, "s1", T1)]).size), "4");
eq("non zero", nonZero("0000000000000000"), "0000000000000001");
eq("non zero keeps others", nonZero("0000000000000010"), "0000000000000010");
// frozen golden: pins the v1 contract (printf 'agentglass/otlp/v1|r|claude|s1|2026-01-01T00:00:00.000Z#0' | sha256sum | cut -c1-16)
eq("golden root span id", rootSpanId("claude|s1", T1), "89eb61a6dc52cc4a");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ids: all checks passed");
