// agentglass — self-check for the fleet TUI's pure parts: the remote guard, the header segment, alert de-dup, cadence:
// scriptc build src/features/fleet/tui.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import { newSess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { remoteOnly } from "../../model/remote.ts";
import { vwidth } from "../../util/text.ts";
import { FORMAT, type HostReport, newFeedState, noOwned } from "./model.ts";
import { sessRowOf } from "./report.ts";
import type { FleetCfg } from "./config.ts";
import { FLEET, setFleet, hostByName, newRemote } from "./hosts.ts";
import { headerSeg, newAlerts, intervalMs, backoffMs, nextDue, sshHint, hostTag, HUB_OPEN } from "./tui.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
ok("guard: null", !remoteOnly(null, "x"), "true");
const loc = newSess("claude", "l1", "/tmp/keepme.jsonl", false);
ok("guard: local", !remoteOnly(loc, "x"), "true");
const cfg: FleetCfg = { hosts: [{ name: "ws", ssh: "me@ws", agentglass: "~/.local/bin/agentglass", redact: false, enabled: true, kind: "ssh", path: "", snapshot: true, watch: true }], localName: "local", refreshS: 60, days: 7, timeoutS: 90, reprice: true, warns: [] };
setFleet(cfg, "ffffffffffffffff", [{ kind: "ssh", start: (t: number): boolean => false, poll: (t: number) => newFeedState(), stop: (): void => {} }]);
const r = newSess("claude", "5f1e", "@ws/claude:5f1e", false); r.host = "ws";
ok("ssh hint", sshHint(r) === "ssh -t me@ws ~/.local/bin/agentglass open claude:5f1e", sshHint(r));
ok("guard: remote", remoteOnly(r, "the transcript") && S.toast.indexOf("remote session on ws: the transcript needs the host") >= 0, S.toast);
ok("guard toast has ssh", S.toast.indexOf("ssh -t me@ws") >= 0, S.toast);
ok("host tag", plain(hostTag(r)) === "ws " && hostTag(loc) === "", JSON.stringify(plain(hostTag(r))));
const marks = [{ name: "vm1", stale: true, ageMs: 7200000, down: false }];
ok("header 120", plain(headerSeg(3, marks, 120, false)) === " · 3 hosts · vm1 stale 2h", JSON.stringify(plain(headerSeg(3, marks, 120, false))));
ok("header 20", plain(headerSeg(3, marks, 20, false)) === " · 3 hosts", JSON.stringify(plain(headerSeg(3, marks, 20, false))));
ok("header 5", headerSeg(3, marks, 5, false) === "", headerSeg(3, marks, 5, false));
ok("header down", plain(headerSeg(2, [{ name: "vm1", stale: false, ageMs: 0, down: true }], 120, false)) === " · 2 hosts · vm1 ✗", plain(headerSeg(2, [{ name: "vm1", stale: false, ageMs: 0, down: true }], 120, false)));
ok("header no ssh", plain(headerSeg(2, [], 120, true)) === " · hosts: no ssh", plain(headerSeg(2, [], 120, true)));
ok("header fits", vwidth(headerSeg(3, marks, 18, false)) <= 18, String(vwidth(headerSeg(3, marks, 18, false))));
// alerts: a transition toasts once; the first report only seeds
const rep = (alerts: unknown[]): HostReport => ({ hello: { format: FORMAT, version: "x", hostId: "1", hostName: "h", os: "linux", tzOffsetMin: 0, redact: false, days: 7, now: 1, priceSig: "" },
  sessions: [sessRowOf({ id: "a", harness: "claude", title: "fix login", alerts })], cost: null, allowance: null, live: null, exact: false, owned: noOwned() });
const ws = hostByName("ws"); if (!ws) throw new Error("ws");
const a1 = { rule: "stuck", severity: "warning", since: "2026-10-06T10:00:00.000Z", message: "no output for 10 min" };
ok("first report seeds", newAlerts(ws, rep([a1]), true).length === 0, "toasted");
ok("same alert again: quiet", newAlerts(ws, rep([a1]), false).length === 0, "toasted");
const a2 = { rule: "stuck", severity: "critical", since: "2026-10-06T10:00:00.000Z", message: "no output for 30 min" };
const t2 = newAlerts(ws, rep([a2]), false);
ok("escalation toasts once", t2.length === 1 && t2[0] === "ws · fix login: no output for 30 min", JSON.stringify(t2));
ok("then quiet", newAlerts(ws, rep([a2]), false).length === 0, "again");
ok("acked: quiet", newAlerts(ws, rep([{ rule: "cost", severity: "warning", since: "x", message: "m", acked: true }]), false).length === 0, "toasted");
// cadence
ok("interval", intervalMs(cfg, false) === 60000 && intervalMs(cfg, true) === 300000, String(intervalMs(cfg, true)));
ok("interval long refresh stays", intervalMs({ hosts: [], localName: "l", refreshS: 600, days: 7, timeoutS: 90, reprice: true, warns: [] }, true) === 600000, "x");
ok("backoff", backoffMs(1) === 30000 && backoffMs(2) === 60000 && backoffMs(6) === 900000 && backoffMs(9) === 900000 && backoffMs(0) === 0, [backoffMs(1), backoffMs(2), backoffMs(6), backoffMs(9)].join(","));
ok("due after ok", nextDue(1000, true, 0, 60000) === 61000, String(nextDue(1000, true, 0, 60000)));
ok("due after failure", nextDue(1000, false, 2, 60000) === 61000 && nextDue(1000, false, 1, 60000) === 31000, String(nextDue(1000, false, 1, 60000)));
ok("fleet hosts set", FLEET.hosts.length === 1, String(FLEET.hosts.length));
// a hub host (otlp-hub) pushes its export: no ssh command is offered for its rows
FLEET.hosts.push(newRemote({ name: "lap", ssh: "", agentglass: "", redact: false, enabled: true, kind: "otlp", path: "/h", snapshot: false, watch: false }, { kind: "otlp", start: (t: number): boolean => false, poll: (t: number) => newFeedState(), stop: (): void => {} }));
const hr = newSess("pi", "01a1", "@lap/pi:01a1", false); hr.host = "lap";
ok("hub host: no ssh hint", sshHint(hr) === HUB_OPEN, sshHint(hr));
ok("hub host: the guard's toast offers no ssh", remoteOnly(hr, "the transcript") && S.toast.indexOf("ssh") < 0 && S.toast.indexOf("pushes to the hub") >= 0, S.toast);
console.log(bad ? String(bad) + " failed" : "fleet tui: all checks passed");
if (bad) process.exit(1);
