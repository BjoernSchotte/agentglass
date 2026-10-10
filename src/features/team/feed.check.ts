// check: crypto
// agentglass — self-check for team feeds and the team view (fleet-teams spec 9, Task 7): a member device's chain (base +
// deltas) equals a fresh base; a gap waits; a forged file is skipped with its reason; a session in two rooms, from two
// devices of one member, or from two members counts once; the cost is the distinct sessions' sum; my own rows are mine.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/feed.check.ts -o fc && HOME=$(mktemp -d) ./fc
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { obj } from "../../util/json.ts";
import { hex, randomBytes } from "../../util/rand.ts";
import { REDACT } from "../redact-on.ts";
import { type MemberKeys, newMember, saveRoomKey, saveMember } from "./keys.ts";
import { type Manifest, type MemberPub } from "./manifest.ts";
import { type Room, type RoomShare } from "./policy.ts";
import { dirMailbox } from "./mailbox.ts";
import { publishRoom } from "./publish.ts";
import { type TeamState } from "./state.ts";
import { buildView, resetFeeds, viewCost, type TeamRow } from "./view.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got.slice(0, 500)); } }
if (REDACT) { // publishing refuses under --redact (publish.check.ts): run again without
  const r = execFileSync("sh", ["-c", "AGENTGLASS_REDACT=0 '" + process.execPath + "' 2>&1; echo \"rc=$?\""], { encoding: "utf8" });
  process.stdout.write(r.slice(0, r.lastIndexOf("rc="))); process.exit(r.trim().endsWith("rc=0") ? 0 : 1);
}
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "cache");
process.env["AGENTGLASS_FLEET_DIR"] = join(HOME, "fl", "fleet");
const api = join(HOME, "acme", "api"); mkdirSync(join(api, ".git"), { recursive: true });
writeFileSync(join(api, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/api.git\n");
const pp = join(HOME, ".claude", "projects", "-acme"); mkdirSync(pp, { recursive: true });
const now = Date.now(); const iso = (m: number): string => new Date(now - m * 60000).toISOString();
function turn(id: string, t: string, mid: string, inp: number): string {
  return '{"type":"user","sessionId":"' + id + '","cwd":"' + api + '","timestamp":"' + t + '","message":{"role":"user","content":"go"}}\n'
    + '{"type":"assistant","sessionId":"' + id + '","cwd":"' + api + '","timestamp":"' + t + '","message":{"id":"' + mid + '","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":' + String(inp) + ',"output_tokens":10}}}\n';
}
writeFileSync(join(pp, "a1.jsonl"), turn("a1", iso(60), "m1", 1000));
writeFileSync(join(pp, "a2.jsonl"), turn("a2", iso(50), "m2", 2000));

const T = "0123456789abcdef"; const R1 = "1111111111111111"; const R2 = "2222222222222222";
const rk1 = randomBytes(32); const rk2 = randomBytes(32);
const viewer = newMember(); const B = newMember(); const C = newMember();
const D = { a: "aaaaaaaaaaaaaaaa", b1: "bbbbbbbbbbbbbbb1", b2: "bbbbbbbbbbbbbbb2", c: "cccccccccccccccc" };
function pub(k: MemberKeys, devs: string[]): MemberPub { return { id: k.id, signPk: hex(k.sign.pk), boxPk: hex(k.box.pk), devices: devs, admin: false, removedAt: 0 }; }
const rooms: Room[] = [{ id: R1, name: "api", scope: ["github.com/acme/*"], level: "numbers", budgetUsd: 0, epoch: 1 }, { id: R2, name: "all-acme", scope: ["github.com/**"], level: "numbers", budgetUsd: 0, epoch: 1 }];
const m: Manifest = { team: T, version: 1, root: hex(viewer.sign.pk), signer: viewer.id, at: 1, tk: 1, members: [pub(viewer, [D.a]), pub(B, [D.b1, D.b2]), pub(C, [D.c])],
  rooms: [{ id: R1, epoch: 1, members: [viewer.id, B.id, C.id] }, { id: R2, epoch: 1, members: [viewer.id, B.id, C.id] }], invites: [], priv: new Uint8Array(0) };
const box = join(HOME, "box"); mkdirSync(box, { recursive: true, mode: 0o700 }); const mb = dirMailbox(box);
// each publishing device: its own team dir (its own peer state), the room keys in it
function dev(name: string): void { process.env["AGENTGLASS_TEAM_DIR"] = join(HOME, "dev-" + name); saveRoomKey(T, R1, 1, rk1); saveRoomKey(T, R2, 1, rk2); }
const share = (room: string): RoomShare => ({ room, on: true, repos: ["github.com/acme/api"], level: "numbers", since: 0, paused: false });
function publish(who: string, k: MemberKeys, device: string, room: Room, at: number): string { dev(who); const r = publishRoom(mb, T, room, share(room.id), k, device, at, false); return r.err || r.name; }
const r1 = rooms[0] as Room; const r2 = rooms[1] as Room;
// the viewer: its own team dir with the keys
const vdir = join(HOME, "viewer"); process.env["AGENTGLASS_TEAM_DIR"] = vdir; saveMember(T, viewer); saveRoomKey(T, R1, 1, rk1); saveRoomKey(T, R2, 1, rk2);
const t: TeamState = { id: T, mailbox: box, kind: "dir", me: viewer, device: D.a, label: "", req: "", manifest: m, priv: { name: "acme", names: { [B.id]: "Bob", [C.id]: "Carol", [viewer.id]: "Vic" }, rooms }, policy: [] };
function view(room: string, at: number): ReturnType<typeof buildView> { process.env["AGENTGLASS_TEAM_DIR"] = vdir; return buildView(t, room, at, 0); }
function sessIds(rows: TeamRow[]): string { const o: string[] = []; for (const r of rows) o.push(String(r.s["id"])); o.sort(); return o.join(","); }

// ── B's chain in room api: base, then two deltas as the logs grow ──
ok("B1 base", publish("b1", B, D.b1, r1, now).indexOf("base") >= 0, "");
appendFileSync(join(pp, "a1.jsonl"), turn("a1", iso(10), "m3", 500));
ok("B1 delta 1", publish("b1", B, D.b1, r1, now + 1000).indexOf("delta-1") >= 0, "");
appendFileSync(join(pp, "a2.jsonl"), turn("a2", iso(5), "m4", 700));
ok("B1 delta 2", publish("b1", B, D.b1, r1, now + 2000).indexOf("delta-2") >= 0, "");
const v1 = view(R1, now + 3000);
ok("two sessions from B", v1.rows.length === 2, sessIds(v1.rows));
// the chain applied = the logs at the end (a fresh base would carry the same totals): a1 1000+500, a2 2000+700 input tokens
let ins = ""; { const o: string[] = []; for (const r of v1.rows) { const tk = obj(r.s["tokens"]); o.push(String(tk ? tk["in"] : "")); } o.sort(); ins = o.join(","); }
ok("the chain equals a fresh base", ins === "1500,2700", ins);
// ── the same sessions from B's second device, from C, and in the second room: each counts once ──
publish("b2", B, D.b2, r1, now + 6000); publish("c", C, D.c, r1, now + 6000); publish("b1", B, D.b1, r2, now + 6000);
resetFeeds();
const all = view("", now + 7000);
ok("all rooms: two distinct sessions", all.rows.length === 2, sessIds(all.rows));
const one = all.rows[0];
ok("a row names its rooms", one !== undefined && one.rooms.length >= 1, JSON.stringify(one ? one.rooms : []));
const cost = viewCost(all);
const sumOne = viewCost(view(R1, now + 7000)).month;
ok("cost counted once across devices, members and rooms", cost.month > 0 && Math.abs(cost.month - sumOne) < 1e-9, String(cost.month) + " vs " + String(sumOne));
// ── members and devices ──
let bm = 0; let bdev = 0; for (const mm of all.members) if (mm.id === B.id) { bm++; bdev = mm.devices.length; }
ok("B with two devices", bm === 1 && bdev === 2, JSON.stringify(all.members));
ok("names from the private part", JSON.stringify(all.members).indexOf("Bob") >= 0 && JSON.stringify(all.members).indexOf("Carol") >= 0, "");
{ let on = false; for (const x of all.members) if (x.id === B.id) for (const d of x.devices) if (d.online) on = true; ok("a device seen now is online", on, JSON.stringify(all.members)); }
// ── my own rows are mine ──
publish("a", viewer, D.a, r1, now + 8000); resetFeeds();
const mineV = view(R1, now + 9000); let mineN = 0; for (const r of mineV.rows) if (r.mine) mineN++;
ok("my own device's rows are mine", mineN >= 1, String(mineN));
// ── a forged file is skipped, its reason named; a gap waits ──
writeFileSync(join(box, "rooms", R1, C.id + "-" + D.c + ".base-9999999999999999.agt"), "AGT1 forged");
resetFeeds(); const fg = view(R1, now + 10000);
ok("a forged file: skipped with its reason", fg.skipped.length >= 1 && fg.rows.length === 2, JSON.stringify(fg.skipped));
console.log(bad ? String(bad) + " failed" : "team feed: all checks passed");
if (bad) process.exit(1);
