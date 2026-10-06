// agentglass — self-check for the host id: scriptc build src/util/hostid.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME } from "./fs.ts";
import { HOSTID, HOSTID_TEST, hostIdOf, machineIdFrom, hostId, hostName } from "./hostid.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const a = hostIdOf("0123456789abcdef0123456789abcdef", 1000);
ok("16 hex", /^[0-9a-f]{16}$/.test(a), a);
ok("stable", a === hostIdOf("0123456789abcdef0123456789abcdef", 1000), "differs");
ok("uid matters", a !== hostIdOf("0123456789abcdef0123456789abcdef", 1001), "same");
ok("ioreg", machineIdFrom('  | |   "IOPlatformUUID" = "AB12CD34-0000-1111-2222-333344445555"\n') === "AB12CD34-0000-1111-2222-333344445555", "parse");
ok("ioreg absent", machineIdFrom("nothing") === "", "not empty");
const d = join(HOME, "hid"); mkdirSync(d, { recursive: true });
// a machine id file wins over randomness; all zeros does not count
writeFileSync(join(d, "mid"), "0123456789abcdef0123456789abcdef\n");
HOSTID.machineFiles = [join(d, "missing"), join(d, "mid")]; HOSTID.idFile = join(d, "host-id"); HOSTID.ioreg = "/nonexistent-ioreg";
const m = hostId();
ok("from the machine id", /^[0-9a-f]{16}$/.test(m) && m.length === 16, m);
HOSTID_TEST.reset(); writeFileSync(join(d, "mid"), "00000000000000000000000000000000\n");
const r = hostId();
ok("random written", /^[0-9a-f]{16}$/.test(r) && readFileSync(join(d, "host-id"), "utf8").trim() === r, r);
const mode = execFileSync("stat", process.platform === "darwin" ? ["-f", "%Lp", join(d, "host-id")] : ["-c", "%a", join(d, "host-id")], { encoding: "utf8" }).trim(); // scriptc's Stats has no mode
ok("file 0600", mode === "600", mode);
ok("cached", hostId() === r, hostId());
HOSTID_TEST.reset(); writeFileSync(join(d, "host-id"), "00112233445566ff\n");
ok("file wins", hostId() === "00112233445566ff", hostId());
HOSTID_TEST.reset(); writeFileSync(join(d, "host-id"), "not-an-id\n"); writeFileSync(join(d, "mid"), "0123456789abcdef0123456789abcdef\n");
ok("a malformed file is ignored", hostId() === m, hostId());
const hn: string = hostName();
ok("hostName", hn.length > 0 && hn.indexOf(".") < 0, hn);
if (bad) console.log(String(bad) + " failed"); else console.log("hostid: all checks passed");
if (bad) process.exit(1);
