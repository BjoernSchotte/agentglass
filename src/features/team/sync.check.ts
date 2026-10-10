// check: crypto
// agentglass — self-check for team sync (fleet-teams spec 3–5, Task 6): three machines (team dirs and host ids switched
// inside the check) share one folder. Create, invite, the card, join, admission, the welcome, the first publish;
// refusals (used up, expired, wrong secret, a device twice); --approve; removal rotates the room and team keys; leave
// with and without --keep.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/sync.check.ts -o syc && HOME=$(mktemp -d) ./syc
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { HOSTID, HOSTID_TEST } from "../../util/hostid.ts";
import { hex } from "../../util/rand.ts";
import { REDACT } from "../redact-on.ts";
import { type Invite, parseInvite } from "./code.ts";
import { roomKey } from "./keys.ts";
import { type Manifest, type MemberPub, type RoomPub } from "./manifest.ts";
import { dirMailbox } from "./mailbox.ts";
import { openFile, sealFile } from "./sealed.ts";
import { type TeamState, loadTeam } from "./state.ts";
import { createTeam, makeInvite, readCard, requestJoin, syncOnce, removeMember, leaveTeam, admit } from "./sync.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got.slice(0, 500)); } }
// check.sh runs every check under AGENTGLASS_REDACT=1, where publishing refuses (publish.check.ts): run again without
if (REDACT) {
  const r = execFileSync("sh", ["-c", "AGENTGLASS_REDACT=0 '" + process.execPath + "' 2>&1; echo \"rc=$?\""], { encoding: "utf8" });
  process.stdout.write(r.slice(0, r.lastIndexOf("rc="))); process.exit(r.trim().endsWith("rc=0") ? 0 : 1);
}
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "cache");
process.env["AGENTGLASS_FLEET_DIR"] = join(HOME, "fl", "fleet");
// a session in github.com/acme/api for B to share
const api = join(HOME, "acme", "api"); mkdirSync(join(api, ".git"), { recursive: true });
writeFileSync(join(api, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/api.git\n");
const pp = join(HOME, ".claude", "projects", "-acme"); mkdirSync(pp, { recursive: true });
const t0 = Date.now(); const iso = new Date(t0 - 600000).toISOString();
writeFileSync(join(pp, "a1.jsonl"), '{"type":"user","sessionId":"a1","cwd":"' + api + '","timestamp":"' + iso + '","message":{"role":"user","content":"go"}}\n'
  + '{"type":"assistant","sessionId":"a1","cwd":"' + api + '","timestamp":"' + iso + '","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":100,"output_tokens":10}}}\n');
const box = join(HOME, "Sync", "agentglass-acme"); mkdirSync(box, { recursive: true, mode: 0o700 });
const mb = dirMailbox(box);
// one "machine": its own team dir and host id
function on(who: string): void {
  process.env["AGENTGLASS_TEAM_DIR"] = join(HOME, "m-" + who, "team");
  const f = join(HOME, "m-" + who, "host-id"); mkdirSync(join(HOME, "m-" + who), { recursive: true });
  if (!existsSync(f)) writeFileSync(f, ("0000000000000000" + hex(new TextEncoder().encode(who))).slice(-16) + "\n", { mode: 0o600 });
  HOSTID.idFile = f; HOSTID_TEST.reset();
}
function fresh(t: TeamState): TeamState { const r = loadTeam(t.id); return r.t ?? t; }
function inv(code: string): Invite { const p = parseInvite(code); if (!p.i) throw new Error("invite: " + p.err); return p.i; }
const has = (xs: string[], x: string): boolean => xs.indexOf(x) >= 0;
function mem(m: Manifest | null, id: string): MemberPub | null { if (m) for (const x of m.members) if (x.id === id) return x; return null; }
function rm(m: Manifest | null, id: string): RoomPub | null { if (m) for (const x of m.rooms) if (x.id === id) return x; return null; }
function invited(m: Manifest | null, id: string): boolean { if (m) for (const x of m.invites) if (x.id === id) return true; return false; }
function mine(id: string, room: string): number { let n = 0; for (const f of mb.list("rooms/" + room)) if (f.name.startsWith(id)) n++; return n; }

// ── A creates, invites ──
on("a");
const c = createTeam("acme", box, [{ id: "", name: "backend", scope: ["github.com/acme/*"], level: "numbers", budgetUsd: 0, epoch: 1 }], false, t0);
const A0 = c.t; ok("create", A0 !== null && c.err === "", c.err);
if (!A0) process.exit(1);
let A: TeamState = A0;
ok("discovery file", existsSync(join(box, "agentglass-team.json")), "");
ok("manifest v1 by the root", A.manifest !== null && A.manifest.version === 1 && A.priv !== null && A.priv.name === "acme", "");
const backend = A.priv ? (A.priv.rooms[0]?.id ?? "") : "";
const i1 = makeInvite(A, [backend], 1, 3600000, false, false, t0); ok("invite", i1.err === "" && i1.code.startsWith("agt1-"), i1.err);
A = fresh(A);

// ── B reads the card, joins with backend ──
on("b");
const card = readCard(inv(i1.code), mb);
const cj = JSON.stringify(card.card);
ok("card: team, rooms, scope, level", card.err === "" && cj.indexOf("\"acme\"") >= 0 && cj.indexOf("backend") >= 0 && cj.indexOf("github.com/acme/*") >= 0 && cj.indexOf("numbers") >= 0, card.err + cj);
ok("card: no keys", cj.indexOf("key") < 0 || cj.indexOf("\"key\"") < 0, cj);
const share = (repos: string[]): { room: string; on: boolean; repos: string[]; level: "numbers" | "titles"; since: number; paused: boolean } => ({ room: backend, on: true, repos, level: "numbers", since: 0, paused: false });
const jb = requestJoin(inv(i1.code), mb, "Bob", [share(["github.com/acme/api"])], t0);
const B0 = jb.t; ok("join request", B0 !== null && jb.err === "", jb.err);
if (!B0) process.exit(1);
const bId = B0.me.id; const bDev = B0.device;

// ── A admits ──
on("a");
const sa = syncOnce(A, t0 + 1000, false); A = fresh(A);
ok("A admits B", has(sa.admitted, bId), JSON.stringify(sa));
ok("manifest lists B with the device, in backend", (mem(A.manifest, bId)?.devices ?? []).indexOf(bDev) >= 0 && (rm(A.manifest, backend)?.members ?? []).indexOf(bId) >= 0, "");
ok("welcome written", existsSync(join(box, "welcome", bId + "-" + bDev + ".key")), "");
ok("the invite is used up", !invited(A.manifest, inv(i1.code).invite), "");

// ── B: welcome, keys, first publish ──
on("b");
let B: TeamState = fresh(B0);
const sb = syncOnce(B, t0 + 2000, false); B = fresh(B);
ok("B holds the room key and publishes", roomKey(B.id, backend, 1) !== null && sb.published.length === 1, JSON.stringify(sb));
ok("B's manifest and team name", B.manifest !== null && B.priv !== null && B.priv.name === "acme", "");
ok("B's request is gone", mb.list("join").length === 0, JSON.stringify(mb.list("join")));
on("a");
const bf = sb.published[0] ?? ""; const bBytes = mb.get(bf, 1 << 28);
const ob = bBytes && A.manifest ? openFile(bBytes, A.manifest, (r: string, e: number) => roomKey(A.id, r, e)) : null;
ok("A opens B's base", ob !== null && ob.err === "" && new TextDecoder().decode(ob.plain ?? new Uint8Array(0)).indexOf("claude:a1") >= 0, ob ? ob.err : "no file " + bf);

// ── refusals ──
// a used-up invite: C cannot use it
on("c");
const jc = requestJoin(inv(i1.code), mb, "Carol", [], t0 + 3000);
ok("a used-up invite: refused", jc.t === null && jc.err.indexOf("used") >= 0, jc.err);
// a wrong secret: the card does not open
const bad1 = inv(i1.code); bad1.secret[0] = (bad1.secret[0] ?? 0) ^ 1;
ok("a wrong secret: refused", readCard(bad1, mb).card === null && requestJoin(bad1, mb, "Carol", [], t0).t === null, "");
// an invite past its expiry when the admin syncs
on("a"); const i2 = makeInvite(A, [backend], 3, 3600000, false, false, t0); A = fresh(A);
on("c"); const jc2 = requestJoin(inv(i2.code), mb, "Carol", [], t0 + 4000); ok("C requests", jc2.t !== null, jc2.err);
on("a"); const sx = syncOnce(A, t0 + 2 * 3600000, false); A = fresh(A);
ok("expired at admission: refused", !has(sx.admitted, jc2.t ? jc2.t.me.id : "x") && sx.problems.join(" ").indexOf("expired") >= 0, JSON.stringify(sx));
// B's device again, as another member: refused
on("a"); const i3 = makeInvite(A, [backend], 3, 3600000, false, false, t0 + 2 * 3600000); A = fresh(A);
on("b"); process.env["AGENTGLASS_TEAM_DIR"] = join(HOME, "m-b2", "team");
const jb2 = requestJoin(inv(i3.code), mb, "Bob again", [], t0 + 2 * 3600000);
on("a"); const sd = syncOnce(A, t0 + 2 * 3600000 + 1000, false); A = fresh(A);
ok("a device already in the team: refused", jb2.t !== null && !has(sd.admitted, jb2.t.me.id) && sd.problems.join(" ").indexOf("device already in the team") >= 0, JSON.stringify(sd));

// ── --approve: queued until admitted ──
on("a"); const i4 = makeInvite(A, [backend], 1, 3600000, false, true, t0 + 2 * 3600000); A = fresh(A);
on("e"); const je = requestJoin(inv(i4.code), mb, "Erin", [share(["github.com/acme/api"])], t0 + 2 * 3600000);
const eId = je.t ? je.t.me.id : "";
on("a"); const sp = syncOnce(A, t0 + 2 * 3600000 + 2000, false); A = fresh(A);
ok("--approve: pending, not admitted", has(sp.pending, eId) && !has(sp.admitted, eId), JSON.stringify(sp));
ok("admit", admit(A, eId, t0 + 2 * 3600000 + 3000) === "", "");
A = fresh(A);
ok("admitted after admit", mem(A.manifest, eId) !== null, "");

// ── removal: B goes, backend and the team key rotate ──
on("a");
ok("remove B", removeMember(A, bId, t0 + 3 * 3600000) === "", ""); A = fresh(A);
const ep = rm(A.manifest, backend)?.epoch ?? 0;
ok("backend epoch 2, without B", ep === 2 && (rm(A.manifest, backend)?.members ?? [bId]).indexOf(bId) < 0, String(ep));
ok("team key rotated", A.manifest !== null && A.manifest.tk === 2, "");
const k2 = roomKey(A.id, backend, 2);
const after = k2 ? sealFile({ team: A.id, room: backend, epoch: 2, member: A.me.id, device: A.device, kind: "base", n: 0, gen: "aaaaaaaaaaaaaaaa", base: "", at: t0 + 3 * 3600000 + 1 }, new TextEncoder().encode("x\n"), k2, A.me) : new Uint8Array(0);
on("b"); B = fresh(B); syncOnce(B, t0 + 3 * 3600000 + 2000, false); B = fresh(B);
ok("B cannot open what A writes after", roomKey(B.id, backend, 2) === null && B.manifest !== null && openFile(after, B.manifest, (r: string, e: number) => roomKey(B.id, r, e)).err !== "", "");
on("a");
ok("A still opens B's epoch-1 base", bBytes !== null && A.manifest !== null && openFile(bBytes, A.manifest, (r: string, e: number) => roomKey(A.id, r, e)).err === "", "");
// Erin (still a member) holds the new epoch
on("e"); let E = loadTeam(je.t ? je.t.id : "").t; if (E) { syncOnce(E, t0 + 3 * 3600000 + 3000, false); E = fresh(E); }
ok("a remaining member gets the new epoch key and team key", E !== null && roomKey(E.id, backend, 2) !== null && E.priv !== null, "");

// ── leave: Erin leaves (a tomb, her files gone); A wipes her and rotates ──
on("e"); if (E) ok("leave", leaveTeam(E, false, t0 + 4 * 3600000) === "", "");
ok("tomb written, Erin's room files gone", existsSync(join(box, "leave", eId + ".tomb")) && mine(eId, backend) === 0, "");
ok("Erin's local team dir gone", !existsSync(join(HOME, "m-e", "team", A.id)), "");
on("a"); const sl = syncOnce(A, t0 + 4 * 3600000 + 1000, false); A = fresh(A);
ok("A wipes Erin and removes her", has(sl.wiped, eId) && (mem(A.manifest, eId)?.removedAt ?? 0) > 0, JSON.stringify(sl));
ok("wiped once", syncOnce(A, t0 + 4 * 3600000 + 2000, false).wiped.length === 0, "");
// --keep: no tomb
on("a"); const i5 = makeInvite(A, [backend], 1, 3600000, false, false, t0 + 4 * 3600000); A = fresh(A);
on("k"); const jk = requestJoin(inv(i5.code), mb, "Kim", [], t0 + 4 * 3600000);
on("a"); syncOnce(A, t0 + 4 * 3600000 + 3000, false); A = fresh(A);
on("k"); let K = jk.t ? fresh(jk.t) : null; if (K) { syncOnce(K, t0 + 4 * 3600000 + 4000, false); K = fresh(K); ok("leave --keep", leaveTeam(K, true, t0 + 4 * 3600000 + 5000) === "", ""); }
ok("--keep: no tomb", jk.t !== null && !existsSync(join(box, "leave", jk.t.me.id + ".tomb")), "");

console.log(bad ? String(bad) + " failed" : "sync: all checks passed");
if (bad) process.exit(1);
