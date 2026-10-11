// check: crypto
// agentglass — self-check for the activity log (fleet-teams spec 5a): a history played through sync (create, join with a
// share, pause, rename, removal and its key rotation) reads back in time order, newest first, with names; a forged
// activity file is dropped; an event older than 90 days is gone.
//   scriptc build --ffi src/features/team/crypto/ffi.json src/features/team/activity.check.ts -o ac && HOME=$(mktemp -d) ./ac
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { HOSTID, HOSTID_TEST } from "../../util/hostid.ts";
import { hex } from "../../util/rand.ts";
import { REDACT } from "../redact-on.ts";
import { type Invite, parseInvite } from "./code.ts";
import { dirMailbox } from "./mailbox.ts";
import { type TeamState, loadTeam } from "./state.ts";
import { createTeam, makeInvite, requestJoin, syncOnce, removeMember, renameMe } from "./sync.ts";
import { type Act, activity, writeEvent } from "./activity.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got.slice(0, 800)); } }
if (REDACT) { // names are fakes under --redact (names.check.ts): the texts here are checked without
  const r = execFileSync("sh", ["-c", "AGENTGLASS_REDACT=0 '" + process.execPath + "' 2>&1; echo \"rc=$?\""], { encoding: "utf8" });
  process.stdout.write(r.slice(0, r.lastIndexOf("rc="))); process.exit(r.trim().endsWith("rc=0") ? 0 : 1);
}
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "cache"); process.env["AGENTGLASS_FLEET_DIR"] = join(HOME, "fl", "fleet");
const box = join(HOME, "box"); mkdirSync(box, { recursive: true, mode: 0o700 }); const mb = dirMailbox(box);
function on(who: string): void {
  process.env["AGENTGLASS_TEAM_DIR"] = join(HOME, "m-" + who, "team"); mkdirSync(join(HOME, "m-" + who), { recursive: true });
  const f = join(HOME, "m-" + who, "host-id"); if (!existsSync(f)) writeFileSync(f, ("0000000000000000" + hex(new TextEncoder().encode(who))).slice(-16) + "\n", { mode: 0o600 });
  HOSTID.idFile = f; HOSTID_TEST.reset();
}
function fresh(t: TeamState): TeamState { return loadTeam(t.id).t ?? t; }
function inv(code: string): Invite { const p = parseInvite(code); if (!p.i) throw new Error(p.err); return p.i; }
const now = Date.now(); const H = 3600000;

on("a"); const c = createTeam("acme", box, [{ id: "", name: "backend", scope: ["github.com/acme/*"], level: "numbers", budgetUsd: 0, epoch: 1 }], false, now - 10 * H, "Anna");
let A = c.t as TeamState; ok("create", c.t !== null, c.err);
const backend = A.priv ? A.priv.rooms[0]?.id ?? "" : "";
const i1 = makeInvite(A, [backend], 1, 24 * H, false, false, now - 9 * H); A = fresh(A);
on("b"); const jb = requestJoin(inv(i1.code), mb, "Bob", [{ room: backend, on: true, repos: ["github.com/acme/api"], level: "numbers", since: 0, paused: false }], now - 8 * H);
let B = jb.t as TeamState;
on("a"); syncOnce(A, now - 7 * H, false); A = fresh(A);
on("b"); B = fresh(B); syncOnce(B, now - 6 * H, false); B = fresh(B);
ok("B pauses", writeEvent(B, "paused", backend, now - 5 * H) === "", "");
ok("B renames", renameMe(B, "Bobby", "", now - 4 * H) === "", "");
ok("an event 91 days old", writeEvent(B, "resumed", backend, now - 91 * 86400000) === "", "");
writeFileSync(join(box, "activity", B.me.id + "-99.act"), "forged, not sealed or signed");
on("a"); ok("A removes B", removeMember(A, B.me.id, now - 3 * H) === "", ""); A = fresh(A);
const acts = activity(A, 0, now);
const kinds: string[] = []; for (const x of acts) kinds.push(x.kind);
const lines: string[] = []; for (const x of acts) lines.push(x.text);
ok("newest first", (() => { for (let i = 1; i < acts.length; i++) if ((acts[i] as Act).at > (acts[i - 1] as Act).at) return false; return true; })(), JSON.stringify(acts));
const want = ["renamed", "paused", "shares", "joined", "room"]; // removed and rotated: one manifest version, one time, before these
let at = 0; let inOrder = true; for (const k of want) { const i = kinds.indexOf(k, at); if (i < 0) inOrder = false; else at = i; }
ok("the history in time order", inOrder && kinds.indexOf("removed") < kinds.indexOf("renamed") && kinds.indexOf("rotated") < kinds.indexOf("renamed") && kinds.indexOf("removed") >= 0, kinds.join(","));
const all = lines.join("\n");
ok("names in the texts", all.indexOf("Bobby joined room backend") >= 0 && all.indexOf("Anna removed Bobby") >= 0 && all.indexOf("Bobby paused room backend") >= 0 && all.indexOf("renamed to Bobby") >= 0 && all.indexOf("Anna created room backend") >= 0, all);
ok("no repos in an event", all.indexOf("github.com") < 0, all);
ok("an event older than 90 days is gone", kinds.indexOf("resumed") < 0, kinds.join(","));
ok("a forged activity file is dropped", acts.length === kinds.length && all.indexOf("forged") < 0, all);
console.log(bad ? String(bad) + " failed" : "team activity: all checks passed");
if (bad) process.exit(1);
