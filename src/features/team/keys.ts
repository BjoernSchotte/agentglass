// agentglass — team keys at rest (fleet-teams spec 8): <teamDir>/<team>/member.key (the member's signing seed and X25519
// secret, hex) and rooms/<room>.<epoch>.key, every file 0600 in 0700 directories; a key is never read from a file or
// directory others can access. No passphrase (as SSH keys without one; team doctor says so).
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { HOME } from "../../util/fs.ts";
import { OS } from "../../platform/index.ts";
import { secureDir, myUid } from "../palette/rundir.ts";
import { hex, unhex, randomBytes } from "../../util/rand.ts";
import { type Obj, obj, str, parse } from "../../util/json.ts";
import { type SignKeys, type BoxKeys, signKeys, boxKeys, hash16, wipe } from "./crypto.ts";

export function teamDir(): string { return process.env["AGENTGLASS_TEAM_DIR"] || join(HOME, ".agentglass", "team"); }
export interface MemberKeys { id: string; sign: SignKeys; box: BoxKeys }
const ID = /^[0-9a-f]{16}$/;

// a member: a random signing seed and X25519 secret; id = the first 16 hex of BLAKE2b(signing public key)
export function newMember(): MemberKeys {
  const seed = randomBytes(32); const sign = signKeys(seed); wipe(seed);
  const bs = randomBytes(32); const box = boxKeys(bs); wipe(bs);
  return { id: hash16(sign.pk), sign, box };
}
// "" = the team's directory (and dir/sub) is ours and private, created when create; else why not
function privDir(team: string, sub: string, create: boolean): string {
  if (!ID.test(team)) return "not a team id: " + team;
  const info = (p: string) => OS.fileInfo(p); const uid = myUid();
  const d = join(teamDir(), team);
  const why = secureDir(teamDir(), uid, info, create) || secureDir(d, uid, info, create) || (sub ? secureDir(join(d, sub), uid, info, create) : "");
  return why ? "not private: " + why : "";
}
// a 0600 file written whole (tmp + rename: a crash leaves the old one)
function writeKey(path: string, text: string): string {
  const tmp = path + "." + String(process.pid) + ".tmp";
  try { writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path); return ""; } catch (e) { return "cannot write " + path + ": " + (e instanceof Error ? e.message : String(e)); }
}
// the text of a key file that only we can read; "" with err otherwise
function readKey(path: string): { t: string; err: string } {
  const i = OS.fileInfo(path);
  if (!i) return { t: "", err: "missing: " + path };
  if (i.kind !== "file") return { t: "", err: "not private: " + path + " is not a regular file" };
  if (i.uid !== myUid() || (i.mode & 0o077) !== 0) return { t: "", err: "not private: " + path + " allows group/other access or is not ours" };
  try { return { t: readFileSync(path, "utf8"), err: "" }; } catch (e) { return { t: "", err: "cannot read " + path }; }
}

export function saveMember(team: string, k: MemberKeys): string {
  const why = privDir(team, "", true); if (why) return why;
  const o: Obj = { v: 1, id: k.id, sign: hex(k.sign.sk.subarray(0, 32)), box: hex(k.box.sk) };
  return writeKey(join(teamDir(), team, "member.key"), JSON.stringify(o) + "\n");
}
export function loadMember(team: string): { k: MemberKeys | null; err: string } {
  const why = privDir(team, "", false); if (why) return { k: null, err: why };
  const r = readKey(join(teamDir(), team, "member.key")); if (r.err) return { k: null, err: r.err };
  const o = obj(parse(r.t)); if (!o || o["v"] !== 1) return { k: null, err: "member.key is not a key file this version reads" };
  const seed = unhex(str(o["sign"])); const bs = unhex(str(o["box"]));
  if (!seed || seed.length !== 32 || !bs || bs.length !== 32) return { k: null, err: "member.key holds no valid keys" };
  const sign = signKeys(seed); wipe(seed); const box = boxKeys(bs); wipe(bs);
  const id = hash16(sign.pk);
  if (id !== str(o["id"])) return { k: null, err: "member.key: the id does not match its key" };
  return { k: { id, sign, box }, err: "" };
}
function roomPath(team: string, room: string, epoch: number): string { return join(teamDir(), team, "rooms", room + "." + String(epoch) + ".key"); }
export function saveRoomKey(team: string, room: string, epoch: number, key: Uint8Array): string {
  if (!ID.test(room) || !Number.isInteger(epoch) || epoch < 1 || key.length !== 32) return "not a room key: " + room;
  const why = privDir(team, "rooms", true); if (why) return why;
  return writeKey(roomPath(team, room, epoch), hex(key) + "\n");
}
// null = not held (or not private)
export function roomKey(team: string, room: string, epoch: number): Uint8Array | null {
  if (!ID.test(room) || !Number.isInteger(epoch) || epoch < 1 || privDir(team, "rooms", false)) return null;
  const r = readKey(roomPath(team, room, epoch)); if (r.err) return null;
  const k = unhex(r.t.trim()); return k && k.length === 32 ? k : null;
}
