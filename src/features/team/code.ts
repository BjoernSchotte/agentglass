// agentglass — team invite codes and ids (fleet-teams spec 1, 3). A code is "agt1-" + Crockford base32 of
//   v (1) | team (8) | invite (8) | secret (16) | root (16) | kind (1: 0 dir, 1 hub) | where (UTF-8, the rest)
// + 2 check symbols: the whole symbol string, check included, is a multiple of 1021 read as base-32 digits — a prime
// above 32, so every single substitution and every adjacent swap changes the value (the parser finds every typo, but
// cannot say which symbol it was: the error names the range). Ids hash with SHA-256 (no FFI needed here).
// SPDX-License-Identifier: Apache-2.0
import { sha256Hex } from "../../util/sha256.ts";
import { hex } from "../../util/rand.ts";

export interface Invite { v: number; team: string; invite: string; secret: Uint8Array; root: string; kind: "dir" | "hub"; where: string }
export const CODE_PREFIX = "agt1-";
export const CODE_MAX = 200;
export const CODE_V = 1;
// the address bytes that still fit in CODE_MAX: 5 + ceil((50 + n) × 8 / 5) + 2 ≤ 200
export const WHERE_MAX = 70;
const ALPHA = "0123456789abcdefghjkmnpqrstvwxyz";
const P = 1021;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;

// the symbol value of one character (case-insensitive; I/L → 1, O → 0 as Crockford reads them), -1 = not one
function symOf(c: string): number {
  const l = c.toLowerCase();
  if (l === "i" || l === "l") return 1;
  if (l === "o") return 0;
  return ALPHA.indexOf(l);
}
function unhex(s: string): Uint8Array { const b = new Uint8Array(s.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return b; }
// the folder name or hub URL a code may carry: "" ok, else why not
export function whereErr(kind: string, where: string): string {
  if (!where) return kind === "hub" ? "no hub URL" : "no folder name";
  if (new TextEncoder().encode(where).length > WHERE_MAX) return (kind === "hub" ? "hub URL" : "folder name") + " too long (at most " + String(WHERE_MAX) + " bytes: the code must stay under " + String(CODE_MAX) + " characters)";
  if (/[\u0000-\u001f\u007f]/.test(where)) return "control characters in the " + (kind === "hub" ? "hub URL" : "folder name");
  if (kind === "hub") return /^https?:\/\/[^/\s]/i.test(where) && !/\s/.test(where) ? "" : "the hub must be an http(s) URL"; // as otlp urlErr
  return where.indexOf("/") >= 0 || where.indexOf("\\") >= 0 || where === "." || where === ".." ? "the folder name must be one name, not a path" : "";
}
function polyMod(syms: number[]): number { let h = 0; for (const s of syms) h = (h * 32 + s) % P; return h; }

export function inviteCode(i: Invite): string {
  if (!HEX16.test(i.team) || !HEX16.test(i.invite) || !HEX32.test(i.root) || i.secret.length !== 16 || i.v < 1 || i.v > 255) throw new Error("invite: malformed fields");
  if (!i.where || new TextEncoder().encode(i.where).length > WHERE_MAX) throw new Error("invite: " + whereErr(i.kind, i.where)); // other address checks: parseInvite
  const w = new TextEncoder().encode(i.where);
  const b = new Uint8Array(50 + w.length);
  b[0] = i.v; b.set(unhex(i.team), 1); b.set(unhex(i.invite), 9); b.set(i.secret, 17); b.set(unhex(i.root), 33); b[49] = i.kind === "hub" ? 1 : 0; b.set(w, 50);
  const syms: number[] = []; let acc = 0; let bits = 0;
  for (let k = 0; k < b.length; k++) { acc = ((acc << 8) | (b[k] ?? 0)) & 0xffff; bits += 8; while (bits >= 5) { bits -= 5; syms.push((acc >>> bits) & 31); } }
  if (bits > 0) syms.push((acc << (5 - bits)) & 31);
  // check value c: (body * 32^2 + c) ≡ 0 (mod P)
  const c = (P - (polyMod(syms) * 1024) % P) % P;
  syms.push(c >>> 5); syms.push(c & 31);
  let s = CODE_PREFIX; for (const v of syms) s += ALPHA.charAt(v);
  return s;
}

export function parseInvite(code: string): { i: Invite | null; err: string } {
  const t = code.trim();
  if (t.length > CODE_MAX) return { i: null, err: "the code is longer than " + String(CODE_MAX) + " characters (" + String(t.length) + "): paste only the code" };
  if (t.toLowerCase().indexOf(CODE_PREFIX) !== 0) return { i: null, err: t.toLowerCase().startsWith("agt") ? "not an invite code this version reads (position 1: want " + CODE_PREFIX + "…; update agentglass?)" : "not an invite code (position 1: want " + CODE_PREFIX + "…)" };
  const syms: number[] = [];
  for (let p = CODE_PREFIX.length; p < t.length; p++) {
    const v = symOf(t.charAt(p));
    if (v < 0) return { i: null, err: "position " + String(p + 1) + ": '" + (t.charCodeAt(p) < 32 ? "?" : t.charAt(p)) + "' is not a code character" };
    syms.push(v);
  }
  const first = CODE_PREFIX.length + 1;
  if (syms.length < 82) return { i: null, err: "the code is cut short (" + String(t.length) + " characters; check the end, after position " + String(t.length) + ")" };
  if (polyMod(syms) !== 0) return { i: null, err: "typo: the check fails — a character between position " + String(first) + " and " + String(t.length) + " is wrong or two are swapped" };
  const body = syms.slice(0, syms.length - 2);
  const n = Math.floor(body.length * 5 / 8);
  const b = new Uint8Array(n); let acc = 0; let bits = 0; let k = 0;
  for (const v of body) { acc = ((acc << 5) | v) & 0xffff; bits += 5; if (bits >= 8) { bits -= 8; if (k < n) b[k] = (acc >>> bits) & 255; k++; } }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return { i: null, err: "position " + String(t.length - 2) + ": the code does not end where it should (a character too many or too few)" };
  if (n < 51) return { i: null, err: "the code is cut short (position " + String(t.length) + ")" };
  const v = b[0] ?? 0;
  if (v > CODE_V) return { i: null, err: "position " + String(first) + ": an invite of a newer agentglass (code v" + String(v) + "): update agentglass" };
  if (v < 1) return { i: null, err: "position " + String(first) + ": not an invite code (version 0)" };
  const kb = b[49] ?? 0;
  if (kb > 1) return { i: null, err: "position " + String(first + 78) + ": unknown mailbox kind" };
  const kind: "dir" | "hub" = kb === 1 ? "hub" : "dir";
  const wb = b.subarray(50); const where = new TextDecoder("utf-8").decode(wb);
  if (hex(new TextEncoder().encode(where)) !== hex(wb)) return { i: null, err: "position " + String(first + 80) + ": the folder name or URL is not text" };
  const we = whereErr(kind, where);
  if (we) return { i: null, err: "position " + String(first + 80) + ": " + we };
  const secret = new Uint8Array(16); secret.set(b.subarray(17, 33), 0);
  return { i: { v, team: hex(b.subarray(1, 9)), invite: hex(b.subarray(9, 17)), secret, root: hex(b.subarray(33, 49)), kind, where }, err: "" };
}

// a device's id in one team: two teams cannot link the same machine, no team learns the fleet/OTLP host id
export function deviceId(team: string, hostId: string): string { return sha256Hex("agentglass/team/v1|" + team + "|" + hostId).slice(0, 16); }
// a session's id in one team's streams (its harness:id key is not sent)
export function teamSessId(team: string, sessKey: string): string { return sha256Hex("agentglass/team/sess/v1|" + team + "|" + sessKey).slice(0, 16); }
