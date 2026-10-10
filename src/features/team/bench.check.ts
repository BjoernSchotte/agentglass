// check: crypto
// check: timing
// agentglass — team view bench (fleet-teams Task 7): 10 members × 3 devices × 300 sessions over 30 days sealed into one
// room, then the whole view built from cold. Time and RSS printed; bounds: 5 s, 400 MB (move them only with a recorded
// measurement).
//   scriptc build -O2 --ffi src/features/team/crypto/ffi.json src/features/team/bench.check.ts -o bc && HOME=$(mktemp -d) ./bc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { selfRssMb } from "../../util/selfmem.ts";
import { type Obj } from "../../util/json.ts";
import { hex, randomBytes } from "../../util/rand.ts";
import { type DayRow, type SessRow } from "../fleet/model.ts";
import { newSnap, snapLines } from "../fleet/snap.ts";
import { type MemberKeys, newMember, saveRoomKey } from "./keys.ts";
import { type Manifest, type MemberPub } from "./manifest.ts";
import { dirMailbox } from "./mailbox.ts";
import { sealFile } from "./sealed.ts";
import { type TeamState } from "./state.ts";
import { buildView, viewCost } from "./view.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
process.env["AGENTGLASS_TEAM_DIR"] = join(HOME, "team");
const T = "0123456789abcdef"; const R = "1111111111111111"; const rk = randomBytes(32);
saveRoomKey(T, R, 1, rk);
const now = Date.now(); const z = (n: number): string => String(n).padStart(2, "0");
const day = (k: number): string => { const d = new Date(now - k * 86400000); return String(d.getFullYear()) + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); };
const MEMBERS = 10; const DEVICES = 3; const SESSIONS = 300; const DAYS = 30;
const ms: MemberKeys[] = []; const pubs: MemberPub[] = [];
for (let i = 0; i < MEMBERS; i++) {
  const k = newMember(); ms.push(k); const devs: string[] = [];
  for (let d = 0; d < DEVICES; d++) devs.push(hex(randomBytes(8)));
  pubs.push({ id: k.id, signPk: hex(k.sign.pk), boxPk: hex(k.box.pk), devices: devs, admin: i === 0, removedAt: 0 });
}
const ids: string[] = []; for (const p of pubs) ids.push(p.id);
const m: Manifest = { team: T, version: 1, root: pubs[0]?.signPk ?? "", signer: pubs[0]?.id ?? "", at: 1, tk: 1, members: pubs, rooms: [{ id: R, epoch: 1, members: ids }], invites: [], priv: new Uint8Array(0) };
const box = join(HOME, "box"); mkdirSync(box, { recursive: true, mode: 0o700 }); const mb = dirMailbox(box);
const t0 = Date.now(); let bytes = 0;
for (let i = 0; i < MEMBERS; i++) {
  const p = pubs[i] as MemberPub; const k = ms[i] as MemberKeys;
  for (const dev of p.devices) {
    const x = newSnap(); x.gen = hex(randomBytes(8)); x.full = true; x.done = true;
    x.head = { hostId: dev, hostName: "", tzOffsetMin: 0, days: 7, now, room: R, epoch: 1, member: p.id, level: "numbers", n: 0 };
    for (let si = 0; si < SESSIONS; si++) {
      const days: DayRow[] = [];
      // a session runs a day or two within the 30 days (every day of the window has sessions)
      for (const d of [si % DAYS, (si + 1) % DAYS]) days.push({ d: day(d), tp: [[String(d % 24), "", "claude-sonnet-4-5", "1000", "100", "5000", "0", "0", "0.01"]], hx: [], unk: 0, um: [], uc: 0, tools: 3, turns: 2, calls: 3, errors: 0, sa: [] });
      const s: Obj = { id: hex(randomBytes(8)), harness: "claude", model: "claude-sonnet-4-5", updated: new Date(now - si * 60000).toISOString(), live: si === 0, status: si === 0 ? "busy" : "ended", tokens: { in: 30000, out: 3000, cacheRead: 150000, cacheWrite: 0 }, costUsd: 0.3, tools: 90 };
      const sr: SessRow = { s, key: "claude:" + String(s["id"]), days, own: null, prov: [], dd: false };
      x.sess.push(sr);
    }
    const f = sealFile({ team: T, room: R, epoch: 1, member: p.id, device: dev, kind: "base", n: 0, gen: x.gen, base: "", at: now }, new TextEncoder().encode(snapLines(x).join("\n") + "\n"), rk, k);
    bytes += f.length;
    mb.put("rooms/" + R + "/" + p.id + "-" + dev + ".base-" + x.gen + ".agt", f);
  }
}
console.log("sealed " + String(MEMBERS * DEVICES) + " streams, " + String(Math.round(bytes / 1024)) + " KB, in " + String(Date.now() - t0) + " ms");
const viewer = ms[0] as MemberKeys;
const t: TeamState = { id: T, mailbox: box, kind: "dir", me: viewer, device: pubs[0]?.devices[0] ?? "", label: "", req: "", manifest: m, priv: null, policy: [] };
const r0 = selfRssMb(); const b0 = Date.now();
const v = buildView(t, "", now, 0);
const ms1 = Date.now() - b0; const rss = selfRssMb();
const c = viewCost(v);
console.log("view: " + String(v.rows.length) + " sessions, " + String(v.members.length) + " members in " + String(ms1) + " ms; RSS " + String(Math.round(rss)) + " MB (+" + String(Math.round(rss - r0)) + ")");
ok("every session once", v.rows.length === MEMBERS * DEVICES * SESSIONS, String(v.rows.length));
let want = 0; for (let si = 0; si < SESSIONS; si++) for (const d of [si % DAYS, (si + 1) % DAYS]) if (d <= 6) want += 0.01;
ok("the cost of the distinct sessions", Math.abs(c.week - MEMBERS * DEVICES * want) < 0.01, JSON.stringify(c) + " want week " + String(MEMBERS * DEVICES * want));
ok("within 5 s", ms1 <= 5000, String(ms1) + " ms");
ok("within 400 MB", rss > 0 && rss <= 400, String(Math.round(rss)) + " MB");
console.log(bad ? String(bad) + " failed" : "team bench: all checks passed");
if (bad) process.exit(1);
