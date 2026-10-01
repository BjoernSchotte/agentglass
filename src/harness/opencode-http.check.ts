// agentglass — self-check for OpenCode over the service daemon's HTTP API: scriptc build src/harness/opencode-http.check.ts -o och && ./och
// SPDX-License-Identifier: Apache-2.0
// Run from the repo root. curl is faked ($AGENTGLASS_CURL, a sh script serving specs/pi-opencode-depth/fixtures/oc-http by URL);
// the SQLite comparison builds the fixture DB of specs/pi-opencode-harnesses/fixtures/opencode.sql with the real sqlite3 CLI.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { newSess, type Ev, type Sess } from "../model/types.ts";
import { newAcc, type Acc } from "../features/usage/record.ts";
import { S } from "../state.ts";
import { parseEvents, sourceOf, busy, epochOf } from "./index.ts";
import { opencode } from "./opencode.ts";
import { b64url } from "./opencode-http.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-och-check"; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir + "/state/opencode", { recursive: true });
const FX = "specs/pi-opencode-depth/fixtures/oc-http";
const P2 = "ses_f12acb259ffeoToIvxeAjWIeys"; const C2 = "ses_f12ac8b5bffe043s7U74AHb6nX";
for (const f of ["sessions.json", "active.json", P2 + ".jsonl", C2 + ".jsonl"]) copyFileSync(FX + "/" + f, dir + "/" + f);
const PASS = "pw-\"keepme-secret\\";
// fake curl: config from stdin (url + user), files by URL path; message cursors are honored (rows after the cursor's id)
const fake = dir + "/curl";
writeFileSync(fake, [
  "#!/bin/sh",
  "[ \"$1\" = -V ] && { echo curl 8; exit 0; }",
  "D=" + dir,
  "cfg=$(cat); echo \"$*\" >> $D/argv.log; printf '%s\\n' \"$cfg\" >> $D/stdin.log",
  "[ -e $D/down ] && exit 7",
  "url=$(printf '%s\\n' \"$cfg\" | sed -n 's/^url = \"\\(.*\\)\"$/\\1/p'); p=${url#http://*/}",
  "case \"$p\" in",
  "  api/info) cat $D/info.json ;;",
  "  api/session/active) cat $D/active.json ;;",
  "  api/session\\?*) cat $D/sessions.json ;;",
  "  api/session/*/message*) id=${p#api/session/}; id=${id%%/*}",
  "    cur=$(printf '%s' \"$p\" | sed -n 's/.*cursor=\\([^&]*\\).*/\\1/p')",
  "    if [ -n \"$cur\" ]; then",
  "      case $(( ${#cur} % 4 )) in 2) cur=\"$cur==\" ;; 3) cur=\"$cur=\" ;; esac",
  "      after=$(printf '%s' \"$cur\" | tr '_-' '/+' | base64 -d | sed 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/')",
  "      rows=$(sed -n \"/\\\"id\\\":\\\"$after\\\"/,\\$p\" $D/$id.jsonl | tail -n +2)",
  "    else rows=$(cat $D/$id.jsonl); fi",
  "    printf '{\"data\":[%s],\"cursor\":{\"next\":\"x\"}}' \"$(printf '%s\\n' \"$rows\" | grep . | paste -sd, -)\" ;;",
  "  *) exit 22 ;;",
  "esac", ""].join("\n"));
chmodSync(fake, 493);
process.env["AGENTGLASS_CURL"] = fake;
process.env["XDG_STATE_HOME"] = dir + "/state";
process.env["OPENCODE_DB"] = dir + "/opencode.db"; // no DB file: HTTP only
process.env["AGENTGLASS_SQLITE3"] = "/nonexistent";
let port = 49000;
function service(infoPid: number): void { // the daemon (this process: alive) moved to another port; /api/info answers infoPid
  port++;
  writeFileSync(dir + "/state/opencode/service.json", JSON.stringify({ id: "x", version: "2.0.19", url: "http://127.0.0.1:" + String(port), pid: process.pid, password: PASS }));
  writeFileSync(dir + "/info.json", JSON.stringify({ version: "2.0.19", pid: infoPid, urls: [], paths: {} }));
}
const byId = new Map<string, Sess>();
let added = 0;
function scan(): void {
  added = 0;
  opencode.scan((path: string, id: string, parent: string, archived: boolean) => {
    added++;
    let s = byId.get(id);
    if (!s) { s = newSess("opencode", id, path, archived); s.parent = parent; const m = opencode.meta; if (m) m(s); byId.set(id, s); }
    const st = src.stat(s); if (st) { s.size = st.size; s.ep = epochOf(s); }
  });
}
function sess(id: string): Sess { const s = byId.get(id); if (!s) throw new Error("no session " + id); return s; }
const src = sourceOf("opencode");
function end(s: Sess): number { const st = src.stat(s); return st ? st.size : -1; }
function events(s: Sess, from: number, to: number): Ev[] { const evs: Ev[] = []; for (const l of src.lines(s, from, to).lines) parseEvents("opencode", l, evs, s); return evs; }
function cost(s: Sess): Acc { const a = newAcc(); for (const l of src.lines(s, 0, end(s)).lines) opencode.usage(a, l); return a; }

ok("cursor encoding", b64url("{\"id\":\"msg_0ed5384ee00132f7cKuAnGpk1k\",\"order\":\"asc\",\"direction\":\"next\"}") === "eyJpZCI6Im1zZ18wZWQ1Mzg0ZWUwMDEzMmY3Y0t1QW5HcGsxayIsIm9yZGVyIjoiYXNjIiwiZGlyZWN0aW9uIjoibmV4dCJ9", "");

// ── (b) /api/info names another pid: not our daemon → nothing, one warning ──
service(1);
S.toast = "";
scan();
ok("foreign daemon: no sessions", added === 0, String(added));
ok("foreign daemon: warning", S.toast.indexOf("sqlite3") >= 0 && S.toast.indexOf("opencode service") >= 0, S.toast);

// ── (a) the daemon answers: sessions, parent links, transcript, usage ──
service(process.pid);
scan();
ok("two sessions", added === 2, String(added));
ok("subagent linked to its parent", byId.has(C2) && sess(C2).parent === P2 && sess(C2).kind === "general", byId.has(C2) ? sess(C2).parent + "/" + sess(C2).kind : "missing");
ok("cwd", sess(P2).cwd === "/tmp/agtest-oc", sess(P2).cwd);
const title = opencode.title; ok("title", (title ? title(sess(P2)) : "") === "Minimal todo web app with localStorage", "");
ok("epoch idx", epochOf(sess(P2)) === "idx", epochOf(sess(P2)));
ok("end = message count", end(sess(P2)) === 10 && end(sess(C2)) === 4, end(sess(P2)) + "/" + end(sess(C2)));
const pe = events(sess(P2), 0, end(sess(P2)));
ok("transcript", pe.length > 0 && pe[0].kind === "user" && pe[pe.length - 1].text === "turn complete", pe.map((e: Ev) => e.kind).join(" "));
const l3 = src.lines(sess(P2), 3, 5);
ok("lines from index 3", l3.lines.length === 2 && l3.next === 5 && l3.lines[0].startsWith("{\"type\":\"assistant\",\"seq\":3,"), JSON.stringify(l3).slice(0, 160));
const spawn = opencode.spawnOf; const sp = (s: Sess): string => spawn ? spawn(s) : "";
ok("spawnOf from the parent's messages", sp(sess(C2)) === "toolu_01NUutkj1dxD1m55v5WZnjfU", sp(sess(C2)));
const hc = cost(sess(P2)); const hcc = cost(sess(C2));
ok("usage", hc.tools > 0 && hc.inTok > 0 && hc.pend.size === 0, hc.tools + " " + hc.inTok);
const search = opencode.search; const found = search ? search("localstorage") : [];
ok("search = title match", found.length === 1 && found[0] === sess(P2).path, found.join(","));
ok("idle", !busy(sess(P2)), "busy");

// ── (c) a message streams: the end holds at the first unfinished assistant row while the session runs ──
const DONE = readFileSync(dir + "/" + P2 + ".jsonl", "utf8");
const T = 1790690000000;
const newer = "{\"id\":\"msg_z1\",\"type\":\"user\",\"time\":{\"created\":" + String(T) + "},\"text\":\"more\"}\n" +
  "{\"id\":\"msg_z2\",\"type\":\"assistant\",\"time\":{\"created\":" + String(T + 1) + "},\"agent\":\"build\",\"model\":{\"id\":\"claude-sonnet-5-5\"},\"content\":[{\"type\":\"text\",\"text\":\"wor\"}],\"tokens\":{\"input\":1,\"output\":1}}\n";
writeFileSync(dir + "/" + P2 + ".jsonl", DONE + newer);
writeFileSync(dir + "/active.json", "{\"data\":{\"" + P2 + "\":{\"type\":\"running\"}}}");
writeFileSync(dir + "/sessions.json", readFileSync(dir + "/sessions.json", "utf8").split("1790688093697").join(String(T + 1)));
scan();
ok("running: busy", busy(sess(P2)), "idle");
ok("running: end held at the streaming row", end(sess(P2)) === 11, String(end(sess(P2))));
const settled = DONE + newer.split("\"time\":{\"created\":" + String(T + 1) + "}").join("\"time\":{\"created\":" + String(T + 1) + ",\"completed\":" + String(T + 9) + "}");
writeFileSync(dir + "/" + P2 + ".jsonl", settled + "{\"id\":\"msg_z3\",\"type\":\"idle\",\"time\":{\"created\":" + String(T + 10) + "},\"outcome\":\"succeeded\"}\n");
writeFileSync(dir + "/active.json", "{\"data\":{}}");
writeFileSync(dir + "/sessions.json", readFileSync(dir + "/sessions.json", "utf8").split(String(T + 1)).join(String(T + 10)));
scan();
ok("settled: idle, end = all", !busy(sess(P2)) && end(sess(P2)) === 13, String(end(sess(P2))));
const tail = events(sess(P2), 11, 13);
ok("settled rows readable", tail.length === 2 && tail[0].text === "wor", tail.map((e: Ev) => e.text).join("|"));
// the daemon goes away mid-run (and there is no sqlite3): the rows stay, the end never moves back
writeFileSync(dir + "/down", "");
service(process.pid);
scan();
ok("daemon gone: rows kept", added === 2 && end(sess(P2)) === 13, added + " " + end(sess(P2)));
rmSync(dir + "/down");
service(process.pid); // the daemon is back (a restart rewrites service.json)

// ── (d) sqlite3 appears: epoch → seq, the ledger re-reads, SQLite and HTTP agree on usage ──
writeFileSync(dir + "/" + P2 + ".jsonl", DONE);
copyFileSync(FX + "/active.json", dir + "/active.json"); copyFileSync(FX + "/sessions.json", dir + "/sessions.json");
const db = dir + "/opencode.db";
execFileSync("sqlite3", [db], { input: readFileSync("specs/pi-opencode-harnesses/fixtures/opencode.sql", "utf8"), stdio: ["pipe", "ignore", "inherit"] });
delete process.env["AGENTGLASS_SQLITE3"];
scan();
ok("sqlite3 back: epoch seq", epochOf(sess(P2)) === "seq", epochOf(sess(P2)));
const sc = cost(sess(P2)); const scc = cost(sess(C2));
ok("same usage over both transports (parent)", sc.inTok === hc.inTok && sc.outTok === hc.outTok && Math.abs(sc.cost - hc.cost) < 1e-9 && sc.tools === hc.tools && sc.add === hc.add, sc.inTok + "/" + hc.inTok + " " + sc.cost + "/" + hc.cost);
ok("same usage over both transports (subagent)", scc.inTok === hcc.inTok && Math.abs(scc.cost - hcc.cost) < 1e-9, scc.inTok + "/" + hcc.inTok);
// and back to HTTP (sqlite3 removed again)
process.env["AGENTGLASS_SQLITE3"] = "/nonexistent";
scan();
ok("sqlite3 gone again: epoch idx", epochOf(sess(P2)) === "idx" && end(sess(P2)) === 10, epochOf(sess(P2)) + " " + end(sess(P2)));

// ── the password never shows: not in argv, not in any output ──
const argv = existsSync(dir + "/argv.log") ? readFileSync(dir + "/argv.log", "utf8") : "";
ok("password not in curl's argv", argv.length > 0 && argv.indexOf("keepme") < 0, argv.slice(0, 80));
ok("password on stdin", readFileSync(dir + "/stdin.log", "utf8").indexOf("keepme-secret") >= 0, "");
ok("password not in the toast", S.toast.indexOf("keepme") < 0, S.toast);

console.log(bad ? bad + " failed" : "opencode http: all checks passed");
process.exit(bad ? 1 : 0);
