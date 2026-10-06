// agentglass — self-check for the host id: scriptc build src/util/hostid.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./fs.ts";
import { OS } from "../platform/index.ts";
import { HOSTID, HOSTID_TEST, hostIdOf, machineIdFrom, hostId, hostName } from "./hostid.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const a = hostIdOf("0123456789abcdef0123456789abcdef", 1000);
ok("16 hex", /^[0-9a-f]{16}$/.test(a), a);
ok("stable", a === hostIdOf("0123456789abcdef0123456789abcdef", 1000), "differs");
ok("uid matters", a !== hostIdOf("0123456789abcdef0123456789abcdef", 1001), "same");
ok("machine id matters", a !== hostIdOf("fedcba9876543210fedcba9876543210", 1000), "same");
ok("ioreg", machineIdFrom('  | |   "IOPlatformUUID" = "AB12CD34-0000-1111-2222-333344445555"\n') === "AB12CD34-0000-1111-2222-333344445555", "parse");
ok("ioreg absent", machineIdFrom("nothing") === "", "not empty");
const d = join(HOME, "hid"); mkdirSync(d, { recursive: true });
// a machine-id file: the id follows from it and the uid
writeFileSync(join(d, "machine-id"), "0123456789abcdef0123456789abcdef\n");
HOSTID.machineFiles = [join(d, "missing"), join(d, "machine-id")]; HOSTID.idFile = join(d, "host-id"); HOSTID.ioreg = "/nonexistent-ioreg";
const m = hostId();
ok("from machine-id", /^[0-9a-f]{16}$/.test(m) && m.length === 16, m);
ok("cached", hostId() === m, "differs");
// all zeros = no machine id
writeFileSync(join(d, "zeros"), "00000000000000000000000000000000\n");
HOSTID.machineFiles = [join(d, "zeros")]; HOSTID_TEST.reset();
const r = hostId();
ok("random written", /^[0-9a-f]{16}$/.test(r) && readFileSync(join(d, "host-id"), "utf8").trim() === r, r);
const fi = OS.fileInfo(join(d, "host-id"));
ok("file 0600", fi !== null && (fi.mode & 0o077) === 0, fi ? String(fi.mode) : "missing");
HOSTID_TEST.reset();
ok("random reused", hostId() === r, hostId());
writeFileSync(join(d, "host-id"), "00112233445566ff\n"); HOSTID_TEST.reset();
ok("file wins", hostId() === "00112233445566ff", hostId());
HOSTID.machineFiles = [join(d, "machine-id")]; HOSTID_TEST.reset();
ok("file wins over machine id", hostId() === "00112233445566ff", hostId());
writeFileSync(join(d, "host-id"), "not-hex\n"); HOSTID_TEST.reset();
ok("bad file: machine id", hostId() === m, hostId());
ok("hostName", hostName().length > 0 && hostName().indexOf(".") < 0, hostName());
console.log(bad ? String(bad) + " failed" : "hostid: all checks passed");
if (bad) process.exit(1);
