// agentglass — self-check for the folder mailbox (fleet-teams spec 4): put/get/list/del of layout names; sync-tool
// conflict copies, editor droppings, symlinks and tmp files are never listed; a write appears only whole.
//   scriptc build src/features/team/mailbox.check.ts -o mbc && ./mbc
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirMailbox, NAMES, roomFile } from "./mailbox.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const root = (process.env["HOME"] ?? "/nonexistent") + "/mailbox-" + String(process.pid);
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true, mode: 0o700 });
const mb = dirMailbox(root);
const R = "fedcba9876543210"; const M = "0123456789abcdef"; const D = "aaaaaaaaaaaaaaaa"; const G = "1111111111111111";
const base = "rooms/" + R + "/" + M + "-" + D + ".base-" + G + ".agt";
const b = new Uint8Array([65, 71, 84, 49, 0, 1, 2, 255]);

ok("kind", mb.kind === "dir", mb.kind);
ok("no problem with a usable folder", mb.problem() === "", mb.problem());
ok("put", mb.put(base, b) === "", mb.put(base, b));
ok("get", (mb.get(base, 1024) ?? new Uint8Array(0)).join(",") === b.join(","), "");
ok("get over the size limit: null", mb.get(base, 4) === null, "");
const l = mb.list("rooms/" + R);
ok("list", l.length === 1 && l[0]?.name === M + "-" + D + ".base-" + G + ".agt" && l[0]?.size === b.length && (l[0]?.at ?? 0) > 0, JSON.stringify(l));
const rf = roomFile(l[0]?.name ?? "");
ok("a room file name parses", rf !== null && rf.member === M && rf.device === D && rf.base && rf.gen === G && rf.n === -1, JSON.stringify(rf));
const dn = roomFile(M + "-" + D + ".delta-7-" + G + ".agt");
ok("a delta name parses", dn !== null && !dn.base && dn.n === 7, JSON.stringify(dn));
// what sync tools, editors and others leave next to it
const dir = root + "/rooms/" + R;
writeFileSync(dir + "/" + M + "-" + D + ".base-" + G + ".sync-conflict-20261010-120000-ABCDEFG.agt", "x");
writeFileSync(dir + "/" + M + "-" + D + ".base-" + G + " (conflicted copy).agt", "x");
writeFileSync(dir + "/." + M + "-" + D + ".base-" + G + ".agt.tmp", "x");
writeFileSync(dir + "/" + M + "-" + D + ".base-" + G + ".agt~", "x");
execFileSync("ln", ["-s", dir + "/" + M + "-" + D + ".base-" + G + ".agt", dir + "/" + M + "-bbbbbbbbbbbbbbbb.base-" + G + ".agt"]);
mkdirSync(dir + "/" + M + "-cccccccccccccccc.base-" + G + ".agt");
ok("only layout names, regular files: one listed", mb.list("rooms/" + R).length === 1, JSON.stringify(mb.list("rooms/" + R)));
ok("a symlink is not read", mb.get("rooms/" + R + "/" + M + "-bbbbbbbbbbbbbbbb.base-" + G + ".agt", 1024) === null, "");
// names outside the layout are refused for every operation (no path escapes the root)
ok("put outside the layout: refused", mb.put("../evil", b) !== "" && mb.put("rooms/" + R + "/../../x.agt", b) !== "" && mb.put("rooms/x.agt", b) !== "", "");
ok("get outside the layout: null", mb.get("../../etc/passwd", 1024) === null, "");
ok("list outside the layout: empty", mb.list("..").length === 0 && mb.list("/etc").length === 0, "");
ok("NAMES cover the layout", NAMES.manifest.test("manifest/12-" + M + ".agm") && NAMES.join.test("join/" + M + "-" + D + ".req") && NAMES.key.test("keys/" + R + "/3/" + M + ".key")
  && NAMES.welcome.test("welcome/" + M + "-" + D + ".key") && NAMES.leave.test("leave/" + M + ".tomb") && NAMES.invite.test("invites/" + M + ".card")
  && NAMES.name.test("names/" + M + ".name") && NAMES.activity.test("activity/" + M + "-12.act") && NAMES.room.test(base) && !NAMES.room.test(base + ".tmp"), "");
// a write is whole or absent under its final name: the tmp file is the only other name while it is written
{ let tmps = 0; for (const n of readdirSync(dir)) if (n.endsWith(".tmp") && n !== "." + M + "-" + D + ".base-" + G + ".agt.tmp") tmps++; ok("put leaves no tmp file", tmps === 0, String(tmps)); }
ok("del", mb.del(base) === "" && !existsSync(root + "/" + base) && mb.get(base, 1024) === null, "");
ok("del of an absent file: no error", mb.del(base) === "", "");
// a file others may write is not read (a shared folder: authenticity comes from signatures, this is the first filter)
ok("put again", mb.put(base, b) === "", "");
chmodSync(root + "/" + base, 0o666);
ok("a group/world-writable file is not read", mb.get(base, 1024) === null, "");
ok("a missing root is a problem", dirMailbox(root + "/nope").problem() !== "", "");

rmSync(root, { recursive: true, force: true });
console.log(bad ? String(bad) + " failed" : "team mailbox: all checks passed");
if (bad) process.exit(1);
