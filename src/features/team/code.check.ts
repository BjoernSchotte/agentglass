// agentglass — self-check for invite codes and team ids (fleet-teams spec 1, 3; Task 2):
//   scriptc build src/features/team/code.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { type Invite, inviteCode, parseInvite, WHERE_MAX, deviceId, teamSessId } from "./code.ts";
import { hex } from "../../util/rand.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function seq(from: number, n: number): Uint8Array { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (from + i * 7) & 255; return b; }
function same(a: Invite, b: Invite | null): boolean {
  return b !== null && a.v === b.v && a.team === b.team && a.invite === b.invite && hex(a.secret) === hex(b.secret) && a.root === b.root && a.kind === b.kind && a.where === b.where;
}

const dir: Invite = { v: 1, team: "0123456789abcdef", invite: "fedcba9876543210", secret: seq(3, 16), root: "00112233445566778899aabbccddeeff", kind: "dir", where: "acme-team" };
const hub: Invite = { v: 1, team: "a1b2c3d4e5f60718", invite: "1111222233334444", secret: seq(200, 16), root: "ffeeddccbbaa99887766554433221100", kind: "hub", where: "https://hub.example.com:8443/team" };
const cd = inviteCode(dir); const ch = inviteCode(hub);
ok("prefix", cd.startsWith("agt1-") && ch.startsWith("agt1-"), cd);
ok("only Crockford symbols after the prefix", /^agt1-[0-9a-hjkmnp-tv-z]+$/.test(cd), cd);
ok("dir code length about 82", cd.length >= 70 && cd.length <= 110, String(cd.length));
const pd = parseInvite(cd); const ph = parseInvite(ch);
ok("dir round trip", pd.err === "" && same(dir, pd.i), pd.err);
ok("hub round trip", ph.err === "" && same(hub, ph.i), ph.err);
ok("uppercase accepted", same(dir, parseInvite(cd.toUpperCase()).i), parseInvite(cd.toUpperCase()).err);
ok("surrounding space accepted", same(dir, parseInvite("  " + cd + "\n").i), "");
// Crockford: I/L read as 1, O as 0
{
  const one = cd.indexOf("1", 5); const zero = cd.indexOf("0", 5);
  if (one > 0) ok("l reads as 1", same(dir, parseInvite(cd.slice(0, one) + "l" + cd.slice(one + 1)).i), "");
  if (zero > 0) ok("o reads as 0", same(dir, parseInvite(cd.slice(0, zero) + "o" + cd.slice(zero + 1)).i), "");
}

// every single substitution and every adjacent swap is caught, and the error names a position
const SYM = "0123456789abcdefghjkmnpqrstvwxyz";
let subs = 0; let caught = 0; let named = 0;
for (let p = 5; p < cd.length; p++) {
  for (let k = 0; k < SYM.length; k++) {
    const c = SYM.charAt(k); if (c === cd.charAt(p)) continue;
    const r = parseInvite(cd.slice(0, p) + c + cd.slice(p + 1)); subs++;
    if (r.err !== "" && r.i === null) caught++; else console.log("FAIL substitution at " + String(p + 1) + " → " + c + " accepted");
    if (r.err.indexOf("position") >= 0) named++;
  }
}
ok("every substitution caught", caught === subs && subs > 2000, String(caught) + "/" + String(subs));
ok("every substitution error names a position", named === subs, String(named) + "/" + String(subs));
let swaps = 0; let sc = 0;
for (let p = 5; p + 1 < cd.length; p++) {
  if (cd.charAt(p) === cd.charAt(p + 1)) continue;
  const r = parseInvite(cd.slice(0, p) + cd.charAt(p + 1) + cd.charAt(p) + cd.slice(p + 2)); swaps++;
  if (r.err !== "" && r.err.indexOf("position") >= 0 && r.i === null) sc++; else console.log("FAIL swap at " + String(p + 1) + ": " + r.err);
}
ok("every adjacent swap caught", sc === swaps && swaps > 50, String(sc) + "/" + String(swaps));
{ const r = parseInvite(cd.slice(0, 20) + "u" + cd.slice(21)); ok("a non-alphabet character is named by position", r.err.indexOf("position 21") >= 0, r.err); }
{ const r = parseInvite(cd.slice(0, cd.length - 1)); ok("a cut code → err", r.i === null && r.err !== "", r.err); }
{ const r = parseInvite(cd + "0"); ok("an extra character → err", r.i === null && r.err !== "", r.err); }
ok("wrong prefix → err", parseInvite("agt2-" + cd.slice(5)).err !== "" && parseInvite(cd.slice(5)).err !== "", "");
ok("empty → err", parseInvite("").err !== "", "");

// limits: > 200 characters, a hub that is not http(s), control characters
{
  const long: Invite = { v: 1, team: dir.team, invite: dir.invite, secret: dir.secret, root: dir.root, kind: "hub", where: "https://example.com/" + "x".repeat(100) };
  // a code is never made that no one can join: the address is capped (WHERE_MAX bytes) when the code is made and read
  let thrown = ""; try { inviteCode(long); } catch (e) { thrown = e instanceof Error ? e.message : String(e); }
  ok("an address too long for a 200-character code is refused when made", thrown.indexOf("too long") >= 0, thrown);
  const max: Invite = { v: 1, team: dir.team, invite: dir.invite, secret: dir.secret, root: dir.root, kind: "hub", where: "https://example.com/" + "x".repeat(WHERE_MAX - 20) };
  const mc = inviteCode(max); const mp = parseInvite(mc);
  ok("the longest address round-trips", mc.length <= 200 && mp.i !== null && mp.i.where === max.where, String(mc.length) + " " + mp.err);
  ok("a code over 200 characters → err", parseInvite(mc + "x".repeat(10)).err.indexOf("200") >= 0, parseInvite(mc + "x".repeat(10)).err);
  ok("200 + junk → err", parseInvite(cd + "x".repeat(200)).err !== "", "");
  const ftp: Invite = { v: 1, team: dir.team, invite: dir.invite, secret: dir.secret, root: dir.root, kind: "hub", where: "ftp://example.com/x" };
  ok("hub must be http(s)", parseInvite(inviteCode(ftp)).err.indexOf("http") >= 0, parseInvite(inviteCode(ftp)).err);
  const js: Invite = { v: 1, team: dir.team, invite: dir.invite, secret: dir.secret, root: dir.root, kind: "hub", where: "javascript:alert(1)" };
  ok("hub javascript: refused", parseInvite(inviteCode(js)).i === null, "");
  const ctl: Invite = { v: 1, team: dir.team, invite: dir.invite, secret: dir.secret, root: dir.root, kind: "dir", where: "a\u0007b" };
  ok("control character in the folder name refused", parseInvite(inviteCode(ctl)).i === null, "");
  const sl: Invite = { v: 1, team: dir.team, invite: dir.invite, secret: dir.secret, root: dir.root, kind: "dir", where: "../etc" };
  ok("folder name with a slash refused", parseInvite(inviteCode(sl)).i === null, "");
  const v2: Invite = { v: 2, team: dir.team, invite: dir.invite, secret: dir.secret, root: dir.root, kind: "dir", where: "x" };
  ok("a newer code version → err naming the upgrade", parseInvite(inviteCode(v2)).err.indexOf("newer") >= 0, parseInvite(inviteCode(v2)).err);
}
// inviteCode refuses what it cannot encode
{
  let threw = 0;
  const bads: Invite[] = [
    { v: 1, team: "XYZ", invite: dir.invite, secret: dir.secret, root: dir.root, kind: "dir", where: "x" },
    { v: 1, team: dir.team, invite: dir.invite, secret: seq(0, 15), root: dir.root, kind: "dir", where: "x" },
    { v: 1, team: dir.team, invite: dir.invite, secret: dir.secret, root: "00", kind: "dir", where: "x" },
    { v: 1, team: dir.team, invite: dir.invite, secret: dir.secret, root: dir.root, kind: "dir", where: "" },
  ];
  for (const b of bads) { try { inviteCode(b); } catch (e) { threw++; } }
  ok("inviteCode refuses malformed fields", threw === bads.length, String(threw));
}

// ids: deterministic, per team, 16 hex
const d1 = deviceId("0123456789abcdef", "aaaaaaaaaaaaaaaa"); const d2 = deviceId("0123456789abcdef", "aaaaaaaaaaaaaaaa");
ok("deviceId deterministic, 16 hex", d1 === d2 && /^[0-9a-f]{16}$/.test(d1), d1);
ok("deviceId differs per team", deviceId("0123456789abcdee", "aaaaaaaaaaaaaaaa") !== d1, "");
ok("deviceId differs per host", deviceId("0123456789abcdef", "aaaaaaaaaaaaaaab") !== d1, "");
ok("deviceId is not the host id", d1 !== "aaaaaaaaaaaaaaaa", "");
const s1 = teamSessId("0123456789abcdef", "claude:abc");
ok("teamSessId 16 hex, deterministic", /^[0-9a-f]{16}$/.test(s1) && s1 === teamSessId("0123456789abcdef", "claude:abc"), s1);
ok("teamSessId differs per team and key", s1 !== teamSessId("0123456789abcdee", "claude:abc") && s1 !== teamSessId("0123456789abcdef", "claude:abd"), "");
ok("teamSessId differs from deviceId of the same input", s1 !== deviceId("0123456789abcdef", "claude:abc"), "");

if (bad > 0) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("code: all checks passed");
