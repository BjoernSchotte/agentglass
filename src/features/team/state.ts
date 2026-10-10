// agentglass — a team as this machine holds it (fleet-teams spec 8): <teamDir>/<team>/team.json (mailbox, device,
// label, a pending join request), member.key, the keys (rooms/<room>.<epoch>.key; the team key as room <team>),
// manifest.agm (the newest manifest accepted), policy.json (this member's shares, never leaving the machine).
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { readBytes, readText } from "../../util/fs.ts";
import { writeBin } from "../../util/gzip.ts";
import { type Obj, obj, arr, str, parse } from "../../util/json.ts";
import { type MemberKeys, teamDir, loadMember, roomKey, saveRoomKey } from "./keys.ts";
import { type Manifest, type Private, localManifest, openPrivate } from "./manifest.ts";
import { type RoomShare } from "./policy.ts";
import { type Mailbox, dirMailbox } from "./mailbox.ts";

export interface TeamState { id: string; mailbox: string; kind: string; me: MemberKeys; device: string; label: string; req: string; manifest: Manifest | null; priv: Private | null; policy: RoomShare[] }
const ID = /^[0-9a-f]{16}$/;
function dirOf(id: string): string { return join(teamDir(), id); }
function writeText(p: string, t: string): string {
  const tmp = p + "." + String(process.pid) + ".tmp";
  try { writeFileSync(tmp, t, { mode: 0o600 }); renameSync(tmp, p); return ""; } catch (e) { return "cannot write " + p; }
}
export function teamKey(t: TeamState, epoch: number): Uint8Array | null { return roomKey(t.id, t.id, epoch); }
export function saveTeamKey(t: TeamState, epoch: number, key: Uint8Array): string { return saveRoomKey(t.id, t.id, epoch, key); }
export function mbOf(t: TeamState): Mailbox { return dirMailbox(t.mailbox); }

export function saveMeta(t: TeamState): string {
  return writeText(join(dirOf(t.id), "team.json"), JSON.stringify({ v: 1, id: t.id, mailbox: t.mailbox, kind: t.kind, device: t.device, label: t.label, req: t.req }) + "\n");
}
export function savePolicy(t: TeamState): string {
  const o: Obj[] = []; for (const s of t.policy) o.push({ room: s.room, on: s.on, repos: s.repos, level: s.level, since: s.since, paused: s.paused });
  return writeText(join(dirOf(t.id), "policy.json"), JSON.stringify({ v: 1, shares: o }) + "\n");
}
export function saveManifest(t: TeamState, b: Uint8Array): string {
  const p = join(dirOf(t.id), "manifest.agm"); const tmp = p + "." + String(process.pid) + ".tmp";
  if (!writeBin(tmp, b)) return "cannot write " + tmp;
  try { renameSync(tmp, p); return ""; } catch (e) { return "cannot write " + p; }
}
function policyIn(v: unknown): RoomShare[] {
  const o: RoomShare[] = [];
  for (const x of arr(v)) {
    const e = obj(x); if (!e) continue;
    const repos: string[] = []; for (const r of arr(e["repos"])) if (typeof r === "string") repos.push(r);
    o.push({ room: str(e["room"]), on: e["on"] === true, repos, level: e["level"] === "titles" ? "titles" : "numbers", since: typeof e["since"] === "number" ? e["since"] : 0, paused: e["paused"] === true });
  }
  return o;
}
// the private part of the newest team key this machine holds that opens it
export function privOf(t: TeamState): Private | null {
  const m = t.manifest; if (!m) return null;
  for (let e = m.tk; e >= 1 && e > m.tk - 4; e--) { const k = teamKey(t, e); if (k) { const p = openPrivate(m, k); if (p) return p; } }
  return null;
}
export function loadTeam(id: string): { t: TeamState | null; err: string } {
  if (!ID.test(id)) return { t: null, err: "not a team id: " + id };
  const d = dirOf(id);
  const o = obj(parse(readText(join(d, "team.json"), 0, 65536))); if (!o || o["v"] !== 1 || o["id"] !== id) return { t: null, err: "no team " + id + " here" };
  const mk = loadMember(id); if (!mk.k) return { t: null, err: mk.err };
  const mb = readBytes(join(d, "manifest.agm"), 0, 16777216);
  const t: TeamState = { id, mailbox: str(o["mailbox"]), kind: str(o["kind"]) || "dir", me: mk.k, device: str(o["device"]), label: str(o["label"]), req: str(o["req"]),
    manifest: mb.length ? localManifest(mb) : null, priv: null, policy: policyIn((obj(parse(readText(join(d, "policy.json"), 0, 1048576))) ?? {})["shares"]) };
  t.priv = privOf(t);
  return { t, err: "" };
}
export function loadTeams(): TeamState[] {
  const o: TeamState[] = [];
  let ns: string[] = []; try { ns = readdirSync(teamDir()); } catch (e) { return o; }
  ns.sort();
  for (const n of ns) if (ID.test(n)) { const r = loadTeam(n); if (r.t) o.push(r.t); }
  return o;
}
// everything of this team on this machine (leave)
export function dropTeam(id: string): void { if (ID.test(id)) rmSync(dirOf(id), { recursive: true, force: true }); }
