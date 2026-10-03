// agentglass — deterministic OTLP trace and span ids (spec 4.1): the same transcript always yields the same ids
// SPDX-License-Identifier: Apache-2.0
// H(x) = SHA-256 of PREFIX + x. The "v1" prefix is a contract: another scheme needs a new prefix and a changelog entry.
import { sha256Hex } from "../../util/sha256.ts";

export const PREFIX = "agentglass/otlp/v1|";
export function H(x: string): string { return sha256Hex(PREFIX + x); }
// R: the root session ("<harness>|<root session id>")
export function rootKey(h: string, rootId: string): string { return h + "|" + rootId; }
// T per turn: its first event's timestamp as logged + "#k" (k = ordinal among turns sharing it); no timestamp → "i" + index
export function turnKeys(firstTs: string[]): string[] {
  const seen = new Map<string, number>(); const out: string[] = [];
  for (let i = 0; i < firstTs.length; i++) {
    const t = firstTs[i] ?? "";
    if (!t) { out.push("i" + String(i + 1)); continue; }
    const k = seen.get(t) ?? 0; seen.set(t, k + 1);
    out.push(t + "#" + String(k));
  }
  return out;
}
// an all-zero id is invalid in OTLP
export function nonZero(hex: string): string { return /^0+$/.test(hex) ? hex.slice(0, -1) + "1" : hex; }
function id16(x: string): string { return nonZero(H(x).slice(0, 16)); }
// the first 8 bytes name the session alone: a trace id leads back to its session by hashing session ids only
export function traceId(R: string, T: string): string { return nonZero(H("s|" + R).slice(0, 16) + H("t|" + R + "|" + T).slice(0, 16)); }
export function rootSpanId(R: string, T: string): string { return id16("r|" + R + "|" + T); }
export function chatSpanId(R: string, reqSess: string, Q: string): string { return id16("c|" + R + "|" + reqSess + "|" + Q); }
// callId "" → the caller passes "anon:" + T + ":" + ordinal
export function toolSpanId(R: string, callerSess: string, callId: string): string { return id16("x|" + R + "|" + callerSess + "|" + callId); }
export function agentSpanId(R: string, subSess: string, T: string): string { return id16("a|" + R + "|" + subSess + "|" + T); }
