// check: crypto
// agentglass — self-check for publishing a room (fleet-teams spec 6, Task 5): only the chosen repo's sessions leave,
// projected to the room's level, sealed per room; --dry-run shows exactly the plaintext and writes nothing; a delta
// after the log grew carries changed-day rows; a paused share writes nothing; a hidden skill never appears.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/publish.check.ts -o pc && HOME=$(mktemp -d) ./pc
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { REDACT } from "../redact-on.ts";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { randomBytes } from "../../util/rand.ts";
import { newMember, saveMember, saveRoomKey, roomKey } from "./keys.ts";
import { type Manifest } from "./manifest.ts";
import { type Room, type RoomShare } from "./policy.ts";
import { dirMailbox, roomFile } from "./mailbox.ts";
import { openFile } from "./sealed.ts";
import { publishRoom } from "./publish.ts";
import { hex } from "../../util/rand.ts";
import { setVis } from "../skills/vis.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got.slice(0, 600)); } }
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "cache");
process.env["AGENTGLASS_FLEET_DIR"] = join(HOME, "fl", "fleet");
process.env["AGENTGLASS_TEAM_DIR"] = join(HOME, "team");
setVis([{ match: "secret-skill", mode: "omit" }], false); // skills.hide (the config is read before this line runs)

function repo(name: string): string {
  const d = join(HOME, "acme", name); mkdirSync(join(d, ".git"), { recursive: true });
  writeFileSync(join(d, ".git", "config"), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/acme/" + name + ".git\n");
  return d;
}
const api = repo("api"); const web = repo("web");
const now = Date.now(); const ts = (m: number): string => new Date(now - m * 60000).toISOString();
const pp = join(HOME, ".claude", "projects", "-acme"); mkdirSync(pp, { recursive: true });
function turn(id: string, cwd: string, t: string, mid: string, inp: number, text: string): string {
  return '{"type":"user","sessionId":"' + id + '","cwd":"' + cwd + '","timestamp":"' + t + '","message":{"role":"user","content":' + JSON.stringify(text) + '}}\n' +
    '{"type":"assistant","sessionId":"' + id + '","cwd":"' + cwd + '","timestamp":"' + t + '","message":{"id":"' + mid + '","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"t' + mid + '","name":"Skill","input":{"skill":"secret-skill"}},{"type":"text","text":"ok"}],"usage":{"input_tokens":' + String(inp) + ',"output_tokens":10}}}\n';
}
writeFileSync(join(pp, "a1.jsonl"), turn("a1", api, ts(30), "ma1", 1000, "fix the api login, token sk-ant-api03-Xy7Kq2Lm9Pz4Rt8Vw1Bn5Cd6Ef3Gh"));
writeFileSync(join(pp, "w1.jsonl"), turn("w1", web, ts(20), "mw1", 3000, "web only: never shared"));
const cd = join(HOME, ".codex", "sessions", "2026", "10", "10"); mkdirSync(cd, { recursive: true });
const CX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
writeFileSync(join(cd, "rollout-2026-10-10T10-00-00-" + CX + ".jsonl"), '{"timestamp":"' + ts(25) + '","type":"session_meta","payload":{"id":"' + CX + '","timestamp":"' + ts(25) + '","cwd":"' + api + '"}}\n'
  + '{"timestamp":"' + ts(25) + '","type":"event_msg","payload":{"type":"user_message","message":"codex in api"}}\n');

const T = "0123456789abcdef"; const R = "fedcba9876543210"; const DEV = "aaaaaaaaaaaaaaaa";
const me = newMember(); ok("save member", saveMember(T, me) === "", "");
const rk = randomBytes(32); ok("save room key", saveRoomKey(T, R, 1, rk) === "", "");
const room: Room = { id: R, name: "api", scope: ["github.com/acme/*"], level: "titles", budgetUsd: 0, epoch: 1 };
const share: RoomShare = { room: R, on: true, repos: ["github.com/acme/api"], level: "titles", since: 0, paused: false };
const m: Manifest = { team: T, version: 1, root: hex(me.sign.pk), signer: me.id, at: 1, tk: 1, members: [{ id: me.id, signPk: hex(me.sign.pk), boxPk: hex(me.box.pk), devices: [DEV], admin: true, removedAt: 0 }], rooms: [{ id: R, epoch: 1, members: [] }], invites: [], priv: new Uint8Array(0) };
const root = join(HOME, "mailbox"); mkdirSync(root, { recursive: true, mode: 0o700 });
const mb = dirMailbox(root);
const keyOf = (r: string, e: number): Uint8Array | null => roomKey(T, r, e);
function opened(name: string): string[] {
  const b = mb.get("rooms/" + R + "/" + name, 268435456); if (!b) return ["<no file>"];
  const o = openFile(b, m, keyOf); if (o.err) return ["<" + o.err + ">"];
  const out: string[] = []; for (const l of new TextDecoder().decode(o.plain ?? new Uint8Array(0)).split("\n")) if (l !== "") out.push(l);
  return out;
}

// scripts/check.sh runs checks under AGENTGLASS_REDACT=1: there publishing refuses, and the checks run again in a child
if (REDACT) {
  const rr = publishRoom(mb, T, room, share, me, DEV, now, false);
  ok("under --redact: not published", rr.name === "" && rr.err.indexOf("--redact") >= 0 && mb.list("rooms/" + R).length === 0, rr.err);
  if (bad) process.exit(1);
  const r = execFileSync("sh", ["-c", "AGENTGLASS_REDACT=0 '" + process.execPath + "' 2>&1; echo \"rc=$?\""], { encoding: "utf8" });
  process.stdout.write(r.slice(0, r.lastIndexOf("rc=")));
  process.exit(r.trim().endsWith("rc=0") ? 0 : 1);
}
// --dry-run: the plaintext, nothing written
const dry = publishRoom(mb, T, room, share, me, DEV, now, true);
ok("dry run: no error", dry.err === "", dry.err);
ok("dry run: nothing written", mb.list("rooms/" + R).length === 0, JSON.stringify(mb.list("rooms/" + R)));
const dj = dry.plain.join("\n");
ok("only the chosen repo's sessions (claude + codex in api)", dj.indexOf("\"claude:a1\"") >= 0 && dj.indexOf("\"codex:" + CX + "\"") >= 0 && dj.indexOf("w1") < 0, dj);
ok("titles level: a title, secrets scrubbed", dj.indexOf("fix the api login") >= 0 && dj.indexOf("Xy7Kq2Lm9Pz4Rt8Vw1Bn5Cd6Ef3Gh") < 0, dj);
ok("never: cwd, path, the home dir, hostName", dj.indexOf("\"cwd\"") < 0 && dj.indexOf("\"path\"") < 0 && dj.indexOf(HOME) < 0 && dj.indexOf("hostName\":\"x") < 0, dj);
ok("a hidden skill never appears", dj.indexOf("secret-skill") < 0, dj.slice(Math.max(0, dj.indexOf("secret-skill") - 300), dj.indexOf("secret-skill") + 40));
ok("head: the device as hostId, the room, epoch, member, level", (dry.plain[0] ?? "").indexOf("\"hostId\":\"" + DEV + "\"") >= 0 && (dry.plain[0] ?? "").indexOf("\"room\":\"" + R + "\"") >= 0
  && (dry.plain[0] ?? "").indexOf("\"member\":\"" + me.id + "\"") >= 0 && (dry.plain[0] ?? "").indexOf("\"level\":\"titles\"") >= 0 && (dry.plain[0] ?? "").indexOf("\"hostName\":\"\"") >= 0, dry.plain[0] ?? "");

// the base: sealed, opening to the same lines a dry run shows
const b1 = publishRoom(mb, T, room, share, me, DEV, now, false);
const f1 = roomFile(b1.name.slice(b1.name.lastIndexOf("/") + 1));
ok("base written", b1.err === "" && f1 !== null && f1.base && f1.member === me.id && f1.device === DEV && b1.bytes > 0, b1.err + " " + b1.name);
const o1 = opened(b1.name.slice(b1.name.lastIndexOf("/") + 1));
ok("the base opens to the dry run's sessions", o1.length === dry.plain.length && o1.join("\n").indexOf("\"claude:a1\"") >= 0 && o1.join("\n").indexOf("w1") < 0, o1.join("\n"));
console.log("bytes: base " + String(b1.bytes));

// the log grows: a delta with changed-day rows
appendFileSync(join(pp, "a1.jsonl"), turn("a1", api, ts(1), "ma2", 500, "more"));
const d1 = publishRoom(mb, T, room, share, me, DEV, now + 1000, false);
const fd = roomFile(d1.name.slice(d1.name.lastIndexOf("/") + 1));
ok("delta written", d1.err === "" && fd !== null && !fd.base && fd.n === 1, d1.err + " " + d1.name);
const od = opened(d1.name.slice(d1.name.lastIndexOf("/") + 1)).join("\n");
ok("the delta carries the grown session with dd", od.indexOf("\"claude:a1\"") >= 0 && od.indexOf("\"dd\":true") >= 0 && od.indexOf("w1") < 0, od);
console.log("bytes: delta " + String(d1.bytes));

// paused or off: nothing written
const paused: RoomShare = { room: R, on: true, repos: share.repos, level: "titles", since: 0, paused: true };
const n0 = mb.list("rooms/" + R).length;
const pz = publishRoom(mb, T, room, paused, me, DEV, now + 2000, false);
ok("paused: nothing written", pz.name === "" && pz.err === "" && mb.list("rooms/" + R).length === n0, pz.err);
// the share changes (titles → numbers, a later history start): a base, so no row of the old choice stays with a reader
const nb = publishRoom(mb, T, room, { room: R, on: true, repos: share.repos, level: "numbers", since: 0, paused: false }, me, DEV, now + 2500, false);
const nf = roomFile(nb.name.slice(nb.name.lastIndexOf("/") + 1));
ok("a changed share starts with a base", nf !== null && nf.base, nb.name + " " + nb.err);
// numbers level: no title
const nums = opened(nb.name.slice(nb.name.lastIndexOf("/") + 1)).join("\n");
ok("numbers level: no title, no branch", nums.indexOf("fix the api login") < 0 && nums.indexOf("\"title\"") < 0 && nums.indexOf("\"claude:a1\"") >= 0, nums);
// a history start after the sessions: none of them
const later = publishRoom(mb, T, room, { room: R, on: true, repos: share.repos, level: "titles", since: now + 60000, paused: false }, me, DEV, now + 4000, true).plain.join("\n");
ok("history start after them: no session", later.indexOf("\"claude:a1\"") < 0 && later.indexOf("codex:") < 0, later);
// no room key: an error, nothing written
const nk = publishRoom(mb, T, { id: "1111111111111111", name: "x", scope: ["*"], level: "numbers", budgetUsd: 0, epoch: 1 }, { room: "1111111111111111", on: true, repos: share.repos, level: "numbers", since: 0, paused: false }, me, DEV, now, false);
ok("no room key: err", nk.err.indexOf("no key") >= 0 && nk.name === "", nk.err);

console.log(bad ? String(bad) + " failed" : "team publish: all checks passed");
if (bad) process.exit(1);
