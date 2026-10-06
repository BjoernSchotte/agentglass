// agentglass — self-check for the fleet config section: scriptc build src/features/fleet/config.check.ts -o fc && ./fc
// SPDX-License-Identifier: Apache-2.0
import { fleetFrom, fleetOn, splitHostRef, openCmd } from "./config.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const has = (ws: string[], s: string): boolean => ws.some((x: string) => x.indexOf(s) >= 0);

const two = fleetFrom({ hosts: [{ name: "ws", ssh: "bjoern@workstation" }, { name: "vm1", ssh: "vm1", agentglass: "~/.local/bin/agentglass", redact: true }] });
ok("two hosts", two.hosts.length === 2 && two.warns.length === 0, JSON.stringify(two));
ok("defaults", two.localName === "local" && two.refreshS === 60 && two.days === 7 && two.timeoutS === 90, JSON.stringify(two));
const h0 = two.hosts[0]; const h1 = two.hosts[1];
ok("host fields", !!h0 && h0.agentglass === "agentglass" && h0.enabled && !h0.redact && h0.kind === "ssh" && h0.ssh === "bjoern@workstation", JSON.stringify(h0));
ok("host 2 fields", !!h1 && h1.agentglass === "~/.local/bin/agentglass" && h1.redact, JSON.stringify(h1));
ok("fleetOn", fleetOn(two), "off");
const up = fleetFrom({ hosts: [{ name: "Ws", ssh: "x" }] });
ok("uppercase skipped", up.hosts.length === 0 && has(up.warns, "Ws"), JSON.stringify(up.warns));
const inj = fleetFrom({ hosts: [{ name: "ws", ssh: "-oProxyCommand=evil" }] });
ok("option refused", inj.hosts.length === 0 && has(inj.warns, "must not start with -"), JSON.stringify(inj.warns));
ok("space refused", fleetFrom({ hosts: [{ name: "ws", ssh: "a b" }] }).hosts.length === 0, "kept");
ok("semicolon refused", fleetFrom({ hosts: [{ name: "ws", ssh: "a;id" }] }).hosts.length === 0, "kept");
ok("too long refused", fleetFrom({ hosts: [{ name: "ws", ssh: "a".repeat(256) }] }).hosts.length === 0, "kept");
const dup = fleetFrom({ hosts: [{ name: "ws", ssh: "a" }, { name: "ws", ssh: "b" }] });
ok("duplicate", dup.hosts.length === 1 && (dup.hosts[0]?.ssh ?? "") === "a" && has(dup.warns, "duplicate"), JSON.stringify(dup));
ok("local name refused", fleetFrom({ hosts: [{ name: "local", ssh: "a" }] }).hosts.length === 0, "kept");
ok("custom localName", fleetFrom({ localName: "lap", hosts: [{ name: "local", ssh: "a" }] }).hosts.length === 1, "skipped");
ok("bin injection", fleetFrom({ hosts: [{ name: "ws", ssh: "a", agentglass: "~/bin/ag;rm" }] }).hosts.length === 0, "kept");
ok("bin space", fleetFrom({ hosts: [{ name: "ws", ssh: "a", agentglass: "/a b/agentglass" }] }).hosts.length === 0, "kept");
const rng = fleetFrom({ refreshSeconds: 5, days: 91, timeoutSeconds: 9, hosts: [] });
ok("ranges", rng.refreshS === 60 && rng.days === 7 && rng.timeoutS === 90 && rng.warns.length === 3, JSON.stringify(rng));
const ok2 = fleetFrom({ refreshSeconds: 15, days: 90, timeoutSeconds: 600 });
ok("range ends", ok2.refreshS === 15 && ok2.days === 90 && ok2.timeoutS === 600 && ok2.warns.length === 0, JSON.stringify(ok2));
const ot = fleetFrom({ hosts: [{ name: "ci", otlp: "/x" }] });
ok("otlp kept", ot.hosts.length === 1 && (ot.hosts[0]?.kind ?? "") === "otlp" && !(ot.hosts[0]?.enabled ?? true) && has(ot.warns, "needs a newer agentglass"), JSON.stringify(ot));
ok("otlp only: fleet off", !fleetOn(ot), "on");
ok("two transports", fleetFrom({ hosts: [{ name: "ws", ssh: "a", dir: "/x" }] }).hosts.length === 0, "kept");
ok("no transport", fleetFrom({ hosts: [{ name: "ws" }] }).hosts.length === 0, "kept");
const many: unknown[] = []; for (let i = 0; i < 33; i++) many.push({ name: "h" + String(i), ssh: "h" + String(i) });
const m = fleetFrom({ hosts: many });
ok("33 → 32", m.hosts.length === 32 && has(m.warns, "at most 32"), String(m.hosts.length));
const bad3 = fleetFrom(3);
ok("not an object", bad3.hosts.length === 0 && has(bad3.warns, "fleet in ~/.agentglass/config.json must be an object"), JSON.stringify(bad3.warns));
const dis = fleetFrom({ hosts: [{ name: "old", ssh: "x", enabled: false }] });
ok("disabled", dis.hosts.length === 1 && !(dis.hosts[0]?.enabled ?? true) && !fleetOn(dis), JSON.stringify(dis));
ok("no section", fleetFrom(undefined).warns.length === 0 && !fleetOn(fleetFrom(undefined)), "warns");
// <ref>@<host>: the host before or after the anchor; links and plain refs have none
const SH = (r: string): string => { const x = splitHostRef(r); return x.ref + " | " + x.host; };
for (const [r, want] of [["claude:abc123@ws", "claude:abc123 | ws"], ["claude:abc123@ws#call=c1", "claude:abc123#call=c1 | ws"], ["claude:abc123#call=c1@ws", "claude:abc123#call=c1 | ws"],
  ["abc123", "abc123 | "], ["agentglass://open/claude/abc@x", "agentglass://open/claude/abc@x | "], ["abc123@", "abc123 | "]]) ok("split " + r, SH(r) === want, SH(r));
ok("open command", openCmd({ name: "ws", ssh: "me@ws", agentglass: "~/bin/agentglass", redact: false, enabled: true, kind: "ssh", path: "" }, "claude:abc") === "ssh -t me@ws ~/bin/agentglass open claude:abc", "cmd");
console.log(bad ? String(bad) + " failed" : "fleet config: all checks passed");
if (bad) process.exit(1);
