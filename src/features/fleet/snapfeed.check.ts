// agentglass — self-check for the snapshot feed on the viewer (fleet spec 12, plan T12): acknowledged deltas, the durable
// state (k.snap + journal), restarts, cut and foreign-base deltas, the pull fallback
// scriptc build src/features/fleet/snapfeed.check.ts -o sfc && ./sfc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { OS } from "../../platform/index.ts";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { detachedPid } from "../../platform/posix.ts";
import type { HostCfg, FleetCfg } from "./config.ts";
import type { FeedState, HostReport, OwnRow, SessRow } from "./model.ts";
import { type Snap, snapLines, applySnap } from "./snap.ts";
import { type SshFeed, sshFeed, snapArgs, FEEDTEST } from "./ssh.ts";
import { reportLines, sessRowOf } from "./report.ts";
import { FORMAT, noOwned } from "./model.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = join(HOME, "fleet"); process.env["AGENTGLASS_FLEET_DIR"] = dir;
const bin = join(HOME, "bin"); mkdirSync(bin, { recursive: true });
const OUT = join(HOME, "next.out"); const LOG = join(HOME, "ssh.log"); const RC = join(HOME, "next.rc"); const ERR = join(HOME, "next.err");
// a fake ssh: logs its remote words, prints next.out, exits with next.rc (stderr: next.err)
const fake = join(bin, "ssh-fake");
writeFileSync(fake, "#!/bin/sh\n[ \"$1\" = -V ] && exit 0\necho \"$*\" >> " + JSON.stringify(LOG) + "\ncat " + JSON.stringify(OUT) + "\n[ -f " + JSON.stringify(ERR) + " ] && cat " + JSON.stringify(ERR) + " >&2\nexit $(cat " + JSON.stringify(RC) + ")\n");
chmodSync(fake, 0o755); process.env["AGENTGLASS_SSH"] = fake;
const PEER = "00112233445566ff";
const h: HostCfg = { name: "ws", ssh: "me@ws", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "", snapshot: true, watch: true };
const f: FleetCfg = { hosts: [h], localName: "local", refreshS: 60, days: 7, timeoutS: 30, reprice: true, warns: [] };
FEEDTEST.timeoutMs = 20000;

// argv: the remote words of a snapshot request
const want: string[] = []; for (const w of ["fleet", "snapshot", "--peer", PEER, "--ack", "0011223344556677", "--days", "7", "--redact"]) want.push("'" + w + "'");
const a = snapArgs(h, 7, true, "", PEER, "0011223344556677");
ok("snapshot argv", JSON.stringify(a.slice(a.indexOf("--") + 3)) === JSON.stringify(want) && a[a.indexOf("--") + 1] === "me@ws", JSON.stringify(a));
ok("no ack: no --ack", snapArgs(h, 7, false, "", PEER, "").indexOf("'--ack'") < 0, "");

const HEAD = { version: "x", hostId: "0123456789abcdef", hostName: "ws", os: "linux", tzOffsetMin: 0, redact: false, days: 7, now: Date.now(), priceSig: "" };
function sr(key: string, cost: number): SessRow { return { s: { harness: "claude", id: key.slice(7), updated: new Date().toISOString(), costUsd: cost }, key, days: [], own: null, prov: [] }; }
function row(h16: string): OwnRow { return { h: h16, key: 2, d: "2026-10-01", hr: 1, m: "claude-sonnet-4-5", prov: "", n: [1, 1, 1, 1, 1, 0.1, 1] }; }
const G1 = "1111111111111111"; const G2 = "2222222222222222"; const G3 = "3333333333333333";
const full: Snap = { head: HEAD, gen: G1, base: "", full: true, sess: [sr("claude:a", 1), sr("claude:b", 2)], own: [{ key: "claude:a", reset: true, rows: [row("00000000000000a1")] }], gone: [], cost: null, allowance: null, done: true, err: "" };
const d2: Snap = { head: HEAD, gen: G2, base: G1, full: false, sess: [sr("claude:a", 5)], own: [{ key: "claude:a", reset: false, rows: [row("00000000000000a2")] }], gone: ["claude:b"], cost: null, allowance: null, done: true, err: "" };
const d3: Snap = { head: HEAD, gen: G3, base: G2, full: false, sess: [sr("claude:c", 7)], own: [], gone: [], cost: null, allowance: null, done: true, err: "" };
function serve(lines: string[], rc: number, err: string): void { writeFileSync(OUT, lines.length ? lines.join("\n") + "\n" : ""); writeFileSync(RC, String(rc)); writeFileSync(ERR, err); }
function run(fd: SshFeed): FeedState {
  fd.start(Date.now()); let s = fd.poll(Date.now()); const t0 = Date.now();
  while (s.busy && Date.now() - t0 < 10000) { execFileSync("sleep", ["0.05"]); s = fd.poll(Date.now()); }
  for (let i = 0; i < 50; i++) s = fd.poll(Date.now()); // the windows of a big snapshot
  return s;
}
function lastWords(): string { const l = readFileSync(LOG, "utf8").trim().split("\n"); return l[l.length - 1] ?? ""; }
function norm(r: HostReport | null): string {
  if (!r) return "null";
  const o: string[] = []; for (const s of r.sessions) o.push(s.key + "=" + JSON.stringify(s.s["costUsd"] ?? null) + "/" + String((s.own ?? []).length));
  return o.join(",");
}

let fd = sshFeed(h, f, false, (): number => Date.now(), detachedPid, 256, PEER);
serve(snapLines(full), 0, "");
let s = run(fd);
ok("first request: no ack", lastWords().indexOf("--ack") < 0 && lastWords().indexOf("'snapshot'") >= 0, lastWords());
ok("full applied", s.code === "ok" && !!s.report && s.report.exact && s.report.sessions.length === 2, s.code + " " + norm(s.report));
const sfi = OS.fileInfo(join(dir, "ws.snap"));
ok("state file 0600", sfi !== null && (sfi.mode & 0o077) === 0, sfi ? String(sfi.mode) : "missing");
serve(snapLines(d2), 0, "");
s = run(fd);
ok("second request acks the first", lastWords().indexOf("'--ack' '" + G1 + "'") >= 0, lastWords());
const want2 = applySnap(applySnap(null, full), d2);
ok("delta applied = applySnap(applySnap(full), delta)", norm(s.report) === norm(want2), norm(s.report) + " vs " + norm(want2));
ok("journal holds the delta", existsSync(join(dir, "ws.j")), "no journal");
// a cut delta (no end line): the report stays, the next request acknowledges the same generation
serve(snapLines(d3).slice(0, 2), 0, "");
s = run(fd);
ok("cut: report unchanged", norm(s.report) === norm(want2), norm(s.report));
serve(snapLines(d3), 0, "");
s = run(fd);
ok("after the cut: acks G2 again", lastWords().indexOf("'--ack' '" + G2 + "'") >= 0, lastWords());
const want3 = applySnap(want2, d3);
ok("then applied", norm(s.report) === norm(want3), norm(s.report));
// a restart: a new feed loads k.snap + journal and acknowledges the last generation
fd = sshFeed(h, f, false, (): number => Date.now(), detachedPid, 256, PEER);
let b = fd.poll(Date.now()); for (let i = 0; i < 20; i++) b = fd.poll(Date.now());
ok("restart: state loaded", norm(b.report) === norm(want3) && !!b.report && b.report.exact, norm(b.report));
serve(snapLines(d3), 0, ""); // the host answers with an old delta again (base G2): must not apply twice
s = run(fd);
ok("restart: acks G3", lastWords().indexOf("'--ack' '" + G3 + "'") >= 0, lastWords());
ok("a delta on another base never applies", norm(s.report) === norm(want3), norm(s.report));
serve(snapLines(full), 0, ""); run(fd);
ok("…and the next request asks for a full one", lastWords().indexOf("--ack") < 0, lastWords());
// an agentglass without fleet snapshot: the pull for the rest of the run
const rep: HostReport = { hello: { format: FORMAT, version: "x", hostId: "0123456789abcdef", hostName: "ws", os: "linux", tzOffsetMin: 0, redact: false, days: 7, now: Date.now(), priceSig: "" }, sessions: [sessRowOf({ id: "p", harness: "claude" })], cost: null, allowance: null, live: null, exact: false, owned: noOwned() };
const ho: HostCfg = { name: "old", ssh: "old", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "", snapshot: true, watch: true };
const fo = sshFeed(ho, f, false, (): number => Date.now(), detachedPid, 256, PEER);
serve(["x"], 2, "agentglass: unknown fleet command snapshot\n");
let so = run(fo);
ok("old host: status says so", so.code === "old" && so.err.indexOf("update it there") >= 0 && fo.mode() === "pull", so.code + " " + so.err + " " + fo.mode());
serve(reportLines(rep), 0, "");
so = run(fo);
ok("old host: pulled next", lastWords().indexOf("'pull'") >= 0 && !!so.report && !so.report.exact && so.code === "ok", lastWords() + " " + so.code);
const hs: HostCfg = { name: "srv", ssh: "srv", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "", snapshot: true, watch: true };
const fs2 = sshFeed(hs, f, false, (): number => Date.now(), detachedPid, 256, PEER);
serve([], 126, "agentglass fleet serve: only fleet pull and --version are allowed\n");
run(fs2);
ok("a Part A fleet serve: pull fallback", fs2.mode() === "pull", fs2.mode());
const hp: HostCfg = { name: "nosnap", ssh: "x", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "", snapshot: false, watch: true };
ok("snapshot: false → pull", sshFeed(hp, f, false, (): number => Date.now(), detachedPid, 256, PEER).mode() === "pull", "");

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("fleet snapfeed: all checks passed");
