// agentglass — publishing one room (fleet-teams spec 6, 12): the sender selects and projects. A room stream carries
// the top-level sessions of the repos this member chose for the room (and the room's patterns allow), from the share's
// history start, each row through teamRow() at the share's level; the head names the device (never the host), room,
// epoch, member and level. Sealed with the room key of its epoch into rooms/<room>/<member>-<device>.<kind>-<gen>.agt:
// a base daily (and when the deltas since it grow), else a delta whose rows carry only the days that changed.
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Sess } from "../../model/types.ts";
import { complete } from "../../hooks.ts";
import { type Obj } from "../../util/json.ts";
import { identSync } from "../query/project.ts";
import { accsOf } from "../usage/ledger.ts";
import { buildSnap, loadPeerFile, writePeerFile } from "../fleet/snapshot.ts";
import { snapLines } from "../fleet/snap.ts";
import { type DropFile, nextKind, pruneable } from "../fleet/drop.ts";
import { type Room, type RoomShare, inScope, levelOf, teamRow, shareKey } from "./policy.ts";
import { type MemberKeys, teamDir, roomKey } from "./keys.ts";
import { type Mailbox, roomFile } from "./mailbox.ts";
import { sealFile } from "./sealed.ts";
import { sha256Hex } from "../../util/sha256.ts";

export const TEAM_DAYS = 7; // the list window of a room stream (cost days go further, as fleet's)
export interface Published { name: string; bytes: number; plain: string[]; err: string }
// a session's first activity (its log indexed first when the share has a history start); mtime when unknown
function started(s: Sess): number {
  complete(s);
  let t = 0; for (const a of accsOf(s)) if (a.t0 > 0 && (t === 0 || a.t0 < t)) t = a.t0;
  return t > 0 ? t : s.mtime;
}
function identKey(s: Sess): string { const id = identSync(s); return id ? id.key : ""; }
// this device's files of the room, oldest first, as fleet's drop sequence
function myFiles(mb: Mailbox, room: string, member: string, device: string): DropFile[] {
  const o: DropFile[] = [];
  for (const f of mb.list("rooms/" + room)) {
    const r = roomFile(f.name); if (!r || r.member !== member || r.device !== device) continue;
    o.push({ name: f.name, id: device, base: r.base, n: r.n, gen: r.gen, at: f.at, size: f.size });
  }
  o.sort((a: DropFile, b: DropFile) => a.at - b.at || a.n - b.n);
  return o;
}
// one publish of room by this member's device; dry: the plaintext lines, nothing written or remembered. name "" with
// err "" = nothing to do (the share is off or paused)
export function publishRoom(mb: Mailbox, team: string, room: Room, share: RoomShare, me: MemberKeys, device: string, now: number, dry: boolean, personal = false): Published {
  if (!share.on || share.paused || share.room !== room.id) return { name: "", bytes: 0, plain: [], err: "" };
  const key = roomKey(team, room.id, room.epoch);
  if (!key) return { name: "", bytes: 0, plain: [], err: "no key for room " + room.id + " epoch " + String(room.epoch) + " (team sync fetches it)" };
  const sd = join(teamDir(), team, "state"); const sf = join(sd, room.id + ".json");
  const st = loadPeerFile(sf);
  const files = myFiles(mb, room.id, me.id, device);
  const level = levelOf(room, share);
  // what the receivers' rows were built under: a change (fewer repos, a lower level, a later history start, another
  // scope or epoch) starts over with a base, so no row of the old choice stays with them
  const sig = sha256Hex(JSON.stringify([share.repos.slice().sort(), level, share.since, room.scope, room.epoch])).slice(0, 16);
  const pend = st.pending; const same = !!pend && pend.sig.get("p:share") === sig;
  const k0 = nextKind(files, st, now); const k = same ? k0 : { full: true, n: k0.n };
  const base = k.full ? null : st.pending;
  if (base) { st.acked = base; st.pending = null; }
  const b = buildSnap(TEAM_DAYS, base, now, {
    // the repo first (cheap, no indexing); the history start only for a session of a chosen repo
    pass: (s: Sess): boolean => { const ik = identKey(s); return shareKey(ik) !== "" && inScope(room, share, ik, Number.MAX_SAFE_INTEGER) && (share.since <= 0 || started(s) >= share.since); },
    row: (o: Obj): Obj => teamRow(o, level, team),
    head: (h: Obj): Obj => ({ version: h["version"], hostId: device, hostName: "", tzOffsetMin: h["tzOffsetMin"], redact: false, days: h["days"], now: h["now"], priceSig: h["priceSig"], room: room.id, epoch: room.epoch, member: me.id, level }),
    ownAll: false, dayDelta: true, cost: true, allowance: personal,
  });
  b.next.sig.set("p:share", sig);
  const x = b.snap; x.head["n"] = k.n;
  const plain = snapLines(x);
  if (dry) return { name: "", bytes: 0, plain, err: "" };
  const name = "rooms/" + room.id + "/" + me.id + "-" + device + "." + (k.full ? "base" : "delta-" + String(k.n)) + "-" + x.gen + ".agt";
  const f = sealFile({ team, room: room.id, epoch: room.epoch, member: me.id, device, kind: k.full ? "base" : "delta", n: k.n, gen: x.gen, base: x.base, at: now },
    new TextEncoder().encode(plain.join("\n") + "\n"), key, me);
  const e = mb.put(name, f); if (e) return { name: "", bytes: 0, plain, err: e };
  try { mkdirSync(sd, { recursive: true, mode: 0o700 }); } catch (err) { /* writePeerFile reports it */ }
  if (!writePeerFile(sf, st, b.next)) return { name, bytes: f.length, plain, err: "published, but the room state could not be saved: the next one is a base" };
  for (const n of pruneable(myFiles(mb, room.id, me.id, device), now)) mb.del("rooms/" + room.id + "/" + n);
  return { name, bytes: f.length, plain, err: "" };
}
