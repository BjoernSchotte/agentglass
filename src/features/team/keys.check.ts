// check: crypto
// agentglass — self-check for the team key store (fleet-teams spec 8): member keys and room keys round-trip, files are
// 0600 in 0700 directories, a directory others can read is refused.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/keys.check.ts -o kc && ./kc
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { OS } from "../../platform/index.ts";
import { hex, unhex, unb64url, b64url } from "../../util/rand.ts";
import { sign, verify, seal, sealOpen } from "./crypto.ts";
import { teamDir, newMember, saveMember, loadMember, saveRoomKey, roomKey } from "./keys.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const root = (process.env["HOME"] ?? "/nonexistent") + "/team-keys-" + String(process.pid);
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
process.env["AGENTGLASS_TEAM_DIR"] = root + "/team";
const T = "0123456789abcdef"; const R = "fedcba9876543210";

ok("hex round trip", hex(unhex("00ff10ab") ?? new Uint8Array(0)) === "00ff10ab", "");
ok("unhex refuses odd length and non-hex", unhex("abc") === null && unhex("zz") === null, "");
const b = new Uint8Array([1, 2, 3, 250, 251, 252, 0]);
for (let n = 0; n <= b.length; n++) { const s = b.subarray(0, n); ok("b64url round trip " + String(n), hex(unb64url(b64url(s)) ?? new Uint8Array(1)) === hex(s), b64url(s)); }
ok("unb64url refuses bad input", unb64url("a") === null && unb64url("ab+c") === null && unb64url("ab=") === null, "");

ok("team dir from the environment", teamDir() === root + "/team", teamDir());
const k = newMember();
ok("member id = 16 hex", /^[0-9a-f]{16}$/.test(k.id), k.id);
ok("save", saveMember(T, k) === "", saveMember(T, k));
const mode = (p: string): number => { const i = OS.fileInfo(p); return i ? i.mode & 0o777 : -1; };
ok("team dir 0700", mode(root + "/team") === 0o700 && mode(root + "/team/" + T) === 0o700, String(mode(root + "/team")));
ok("member.key 0600", mode(root + "/team/" + T + "/member.key") === 0o600, String(mode(root + "/team/" + T + "/member.key")));
const l = loadMember(T); const lk = l.k;
ok("load", lk !== null && l.err === "", l.err);
if (lk) {
  ok("same keys", lk.id === k.id && hex(lk.sign.pk) === hex(k.sign.pk) && hex(lk.box.pk) === hex(k.box.pk), lk.id);
  const msg = new TextEncoder().encode("x");
  ok("loaded keys sign and open", verify(k.sign.pk, msg, sign(lk.sign.sk, msg)) && sealOpen(lk.box, seal(k.box.pk, msg)) !== null, "");
}
ok("no member yet in another team", loadMember("aaaaaaaaaaaaaaaa").k === null && loadMember("aaaaaaaaaaaaaaaa").err !== "", "");
ok("a team id that is no id is refused", saveMember("../x", k) !== "" && loadMember("../x").k === null, "");
// a room key of an epoch
const rk = new Uint8Array(32); for (let i = 0; i < 32; i++) rk[i] = i;
ok("room key save", saveRoomKey(T, R, 3, rk) === "", "");
ok("room key 0600", mode(root + "/team/" + T + "/rooms/" + R + ".3.key") === 0o600, "");
ok("room key load", hex(roomKey(T, R, 3) ?? new Uint8Array(0)) === hex(rk), "");
ok("no key for another epoch", roomKey(T, R, 4) === null, "");
ok("a room id that is no id is refused", saveRoomKey(T, "../../x", 1, rk) !== "" && roomKey(T, "../../x", 1) === null, "");
// a key file someone else can read, a directory others can enter: refused
chmodSync(root + "/team/" + T + "/member.key", 0o644);
ok("member.key 0644 refused", loadMember(T).k === null && loadMember(T).err.indexOf("not private") >= 0, loadMember(T).err);
chmodSync(root + "/team/" + T + "/member.key", 0o600);
chmodSync(root + "/team/" + T, 0o755);
ok("team dir 0755 refused", loadMember(T).k === null && loadMember(T).err.indexOf("not private") >= 0, loadMember(T).err);
ok("no room key from it either", roomKey(T, R, 3) === null, "");
chmodSync(root + "/team/" + T, 0o700);
writeFileSync(root + "/team/" + T + "/member.key", "{nope", { mode: 0o600 });
ok("a broken member.key: err, no throw", loadMember(T).k === null && loadMember(T).err !== "", loadMember(T).err);

rmSync(root, { recursive: true, force: true });
console.log(bad ? String(bad) + " failed" : "team keys: all checks passed");
if (bad) process.exit(1);
