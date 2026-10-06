// agentglass — self-check for the receive config, the listen policy and hub-source entries: scriptc build src/features/hub/config.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { recvFrom, listenOk, splitListen, v6words, privateAddr, hubSourceFrom, hubDir } from "./config.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

// defaults (spec 10)
const d = recvFrom(undefined);
ok("defaults", d.listen === "127.0.0.1:4318" && d.maxBodyMB === 8 && d.maxDecodedMB === 64 && d.maxRecords === 20000 && d.ratePerMin === 120 && d.mbPerMin === 128 && d.maxDiskMB === 2048 && d.retentionDays === 30 && !d.keepContent && !d.listenPublic && d.drop.length === 0 && d.warns.length === 0, JSON.stringify(d));
ok("default dir", d.dir === join(HOME, ".agentglass", "hub") || d.dir === process.env["AGENTGLASS_HUB_DIR"], d.dir);
process.env["AGENTGLASS_HUB_DIR"] = "/tmp/x-hub"; ok("AGENTGLASS_HUB_DIR", hubDir() === "/tmp/x-hub" && recvFrom({}).dir === "/tmp/x-hub", hubDir()); delete process.env["AGENTGLASS_HUB_DIR"];
const c = recvFrom({ listen: "100.64.0.1:9", dir: "~/h", tls: { cert: "c.pem", key: "k.pem" }, maxDiskMB: 10, keepContent: true, drop: ["process.working_directory"], ratePerMin: 0, retentionDays: "x" });
ok("values", c.listen === "100.64.0.1:9" && c.dir === join(HOME, "h") && c.tls[0] === "c.pem" && c.tls[1] === "k.pem" && c.maxDiskMB === 10 && c.keepContent && c.drop[0] === "process.working_directory", JSON.stringify(c));
ok("bad values fall back with warnings", c.ratePerMin === 120 && c.retentionDays === 30 && c.warns.length === 2, JSON.stringify(c.warns));
ok("not an object", recvFrom(3).warns.length === 1, JSON.stringify(recvFrom(3).warns));

// listen policy (spec 7)
ok("0.0.0.0 refused", listenOk("0.0.0.0:4318", false, false).indexOf("--listen-public") >= 0, listenOk("0.0.0.0:4318", false, false));
ok(":: refused", listenOk("[::]:4318", false, false) !== "", "allowed");
ok("loopback", listenOk("127.0.0.1:4318", false, false) === "" && listenOk("127.0.0.2:0", false, false) === "" && listenOk("[::1]:4318", false, false) === "", "refused");
ok("tailnet v4", listenOk("100.101.2.3:4318", false, false) === "", listenOk("100.101.2.3:4318", false, false));
ok("tailnet v4 edges", listenOk("100.64.0.0:1", false, false) === "" && listenOk("100.127.255.255:1", false, false) === "" && listenOk("100.63.255.255:1", false, false) !== "" && listenOk("100.128.0.0:1", false, false) !== "", "edges");
ok("tailnet v6", listenOk("[fd7a:115c:a1e0::5]:4318", false, false) === "" && listenOk("[fd7a:115c:a1e0:ab12:4843:cd96:6258:b240]:1", false, false) === "", "refused");
ok("other ULA refused", listenOk("[fd7a:115c:a1e1::5]:4318", false, false) !== "", "allowed");
ok("LAN with public, no TLS", listenOk("192.168.1.5:4318", true, false).indexOf("TLS") >= 0, listenOk("192.168.1.5:4318", true, false));
ok("LAN with public and TLS", listenOk("192.168.1.5:4318", true, true) === "", "refused");
ok("names refused", listenOk("localhost:4318", false, false).indexOf("IP address") >= 0 && listenOk("evil.example:80", true, true) !== "", "allowed");
ok("malformed", splitListen("1.2.3.4") === null && splitListen("1.2.3.4:70000") === null && splitListen("256.1.1.1:1") === null && splitListen("[::1]") === null && splitListen("[1::2::3]:1") === null, "parsed");
ok("v6 words", v6words("::1").join(",") === "0,0,0,0,0,0,0,1" && v6words("::ffff:127.0.0.1").length === 8 && v6words("1:2:3:4:5:6:7:8:9").length === 0, v6words("::1").join(","));
ok("v4-mapped loopback is not private by policy", !privateAddr("::ffff:127.0.0.1"), "private"); // binds the v6 socket: kept strict

// a fleet.hosts entry with otlp (spec 2)
const w: string[] = [];
const h = hubSourceFrom({ name: "hub", otlp: "~/h", hosts: { ci: "0011223344556677", "Bad": "0011223344556677", lap: "xyz" }, trust: "payload", maxAgeDays: 7, includeNative: true }, "fleet host hub", w);
ok("hub source", h.dir === join(HOME, "h") && h.names.get("0011223344556677") === "ci" && h.trust === "payload" && h.maxAgeDays === 7 && h.includeNative, JSON.stringify([h.dir, h.trust, h.maxAgeDays]));
ok("bad host ids/names warned, includeNative said to be ignored", w.length === 3 && h.names.size === 1 && (w[2] ?? "").indexOf("includeNative is not supported yet") >= 0, JSON.stringify(w));
const w2: string[] = [];
const h2 = hubSourceFrom({ otlp: "/srv/o", trust: "x", maxAgeDays: 0, includeNative: "y" }, "fleet host t", w2);
ok("hub defaults", h2.trust === "" && h2.maxAgeDays === 30 && !h2.includeNative && w2.length === 3, JSON.stringify(w2));
if (bad) console.log(String(bad) + " failed"); else console.log("hub config: all checks passed");
if (bad) process.exit(1);
