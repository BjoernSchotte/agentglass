// agentglass — self-check for `agentglass web` (local-web-api W6): agentglass-web beside the binary first, then on
// PATH; missing → install lines (brew, npm/npx, install.sh) and nothing downloaded; a live lock is reused, a dead one
// not; tokens: only hashes on disk (0600), expired lines dropped; the open page (0600) carries the URL, argv never does.
//   scriptc build src/features/web-cli.check.ts -o wc && ./wc
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { OS } from "../platform/index.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hex } from "../util/sha256.ts";
import { webBin, installLines, lockOf, mintToken, openPage, TOKEN_MS } from "./web-cli.ts";

let bad = 0;
function mode(p: string): number { const i = OS.fileInfo(p); return i ? i.mode & 0o777 : -1; }
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const t = mkdtempSync(join(tmpdir(), "agw-cli-"));
const exe = (p: string): void => { writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, 0o755); };
mkdirSync(join(t, "bin")); mkdirSync(join(t, "path")); exe(join(t, "path", "agentglass-web"));
ok("on PATH when not beside the binary", webBin(join(t, "bin", "agentglass"), "/nonexistent:" + join(t, "path")) === join(t, "path", "agentglass-web"), webBin(join(t, "bin", "agentglass"), join(t, "path")));
exe(join(t, "bin", "agentglass-web"));
ok("beside the binary first", webBin(join(t, "bin", "agentglass"), join(t, "path")) === join(t, "bin", "agentglass-web"), "");
writeFileSync(join(t, "path", "plain"), ""); mkdirSync(join(t, "p2")); writeFileSync(join(t, "p2", "agentglass-web"), "not executable");
ok("missing: not executable, not found", webBin("/x/agentglass", join(t, "p2")) === "", "");
const il = installLines("linux").join("\n");
ok("install lines: brew, npm/npx, install.sh --web", il.indexOf("brew install bjoernschotte/tap/agentglass-web") >= 0 && il.indexOf("npx agentglass-web") >= 0 && il.indexOf("install.sh | sh -s -- --web") >= 0, il);
// the lock
const run = join(t, "run"); mkdirSync(run, { mode: 0o700 });
ok("no lock: none", lockOf(run) === null, "");
writeFileSync(join(run, "web.lock"), JSON.stringify({ pid: process.pid, port: 4711, host: "127.0.0.1" }));
const lk = lockOf(run); ok("a live lock: reused", lk !== null && lk.port === 4711 && lk.pid === process.pid, JSON.stringify(lk));
writeFileSync(join(run, "web.lock"), JSON.stringify({ pid: 2147483000, port: 4711, host: "127.0.0.1" }));
ok("a dead pid: not reused", lockOf(run) === null, "");
writeFileSync(join(run, "web.lock"), "garbage"); ok("a broken lock: none", lockOf(run) === null, "");
// tokens: hashes only, expiry, 0600, expired lines dropped
const now = Date.now();
writeFileSync(join(run, "web.tokens"), "deadbeef " + String(now - 1) + "\n" + "cafe " + String(now + 60000) + "\n");
const tok = mintToken(run, now); const f = readFileSync(join(run, "web.tokens"), "utf8");
ok("token: 32 random bytes, base64url", /^[A-Za-z0-9_-]{43}$/.test(tok), tok);
ok("tokens file: the hash with its expiry, never the token", f.indexOf(sha256Hex(tok) + " " + String(now + TOKEN_MS)) >= 0 && f.indexOf(tok) < 0, f);
ok("expired lines dropped, valid kept", f.indexOf("deadbeef") < 0 && f.indexOf("cafe ") >= 0, f);
ok("tokens file 0600", mode(join(run, "web.tokens")) === 0o600, String(mode(join(run, "web.tokens"))));
ok("two tokens differ", mintToken(run, now) !== tok, "");
// the open page
const url = "http://127.0.0.1:4711/#t=" + tok; const pg = openPage(run, url); const html = readFileSync(pg, "utf8");
ok("open page: a refresh to the URL, no referrer, 0600", html.indexOf("content=\"0;url=" + url + "\"") >= 0 && html.indexOf("no-referrer") >= 0 && mode(pg) === 0o600, html);
ok("open page: no script", html.indexOf("<script") < 0, html);
rmSync(t, { recursive: true, force: true });
console.log(bad ? String(bad) + " failed" : "web cli: all checks passed");
if (bad) process.exit(1);
