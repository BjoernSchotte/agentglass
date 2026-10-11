// agentglass web — the launcher of agentglass-web (local-web-api §1, §4): finds agentglass-web beside this binary, then
// on PATH (missing: exit 2 with this platform's install commands; nothing is downloaded), reuses a running one (run/
// web.lock with a live pid) or starts one detached (logs to ~/.agentglass/logs/web.log, 0600), then mints a one-time
// token for this browser: its hash goes into run/web.tokens (0600, hashes only), the token itself only into the URL's
// fragment. The browser is opened through run/web-open.html (0600 in the 0700 run dir), never with the URL in argv
// (another local user could read argv and redeem the link first). --no-open and --json print the URL instead.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, chmodSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { H } from "../hooks.ts";
import { HOME } from "../util/fs.ts";
import { parse, type Obj } from "../util/json.ts";
import { randomBytes, b64url } from "../util/rand.ts";
import { sha256Hex } from "../util/sha256.ts";
import { addCmd, opt } from "./clihelp.ts";
import { cliError, agentHost } from "./agentenv.ts";
import { RUN_DIR } from "./palette/rundir.ts";
import { isAlive } from "./palette/instance.ts";
import { detachedPid } from "../platform/posix.ts";
import { OS } from "../platform/index.ts";

export const TOKEN_MS = 600000; // as agentglass-web: a one-time link lives 10 minutes
export const WAIT_MS = 10000;
const USAGE = "agentglass web [--port N] [--host 0.0.0.0] [--no-open] [--redact] [--json] | agentglass web --stop";

// agentglass-web beside this binary, else on PATH; "" = not installed
export function webBin(self: string, path: string): string {
  const i = self.lastIndexOf("/"); const sib = (i >= 0 ? self.slice(0, i + 1) : "") + "agentglass-web";
  if (isExec(sib)) return sib;
  for (const d of path.split(":")) if (d && isExec(join(d, "agentglass-web"))) return join(d, "agentglass-web");
  return "";
}
function isExec(p: string): boolean { if (!existsSync(p)) return false; const i = OS.fileInfo(p); return !!i && i.kind === "file" && (i.mode & 0o111) !== 0; }
export function installLines(platform: string): string[] {
  const o = ["brew install bjoernschotte/tap/agentglass-web", "npm i -g agentglass-web   (or: npx agentglass-web)", "curl -fsSL https://raw.githubusercontent.com/BjoernSchotte/agentglass/main/install.sh | sh -s -- --web"];
  return platform === "darwin" || platform === "linux" ? o : o.slice(1);
}
// a running agentglass-web: its lock with a live pid
export interface Lock { pid: number; port: number; host: string }
export function lockOf(run: string): Lock | null {
  let o: Obj | null = null; try { o = parse(readFileSync(join(run, "web.lock"), "utf8")); } catch (e) { return null; }
  if (!o) return null;
  const pid = typeof o["pid"] === "number" ? o["pid"] : 0; const port = typeof o["port"] === "number" ? o["port"] : 0;
  // the link's host as agentglass-web wrote it: loopback, or (--host 0.0.0.0) this machine's address or name
  const h = typeof o["host"] === "string" ? o["host"] : ""; const host = /^(\[[0-9a-f:]+\]|[a-z0-9.-]{1,253})$/i.test(h) ? h : "127.0.0.1";
  return pid > 0 && port > 0 && isAlive(pid) ? { pid, port, host } : null;
}
// a new one-time token: its sha256 and expiry appended to run/web.tokens (expired lines dropped), the token returned
export function mintToken(run: string, now: number): string {
  const t = b64url(randomBytes(32)); const f = join(run, "web.tokens");
  const keep: string[] = [];
  try { for (const l of readFileSync(f, "utf8").split("\n")) { const p = l.trim().split(" "); if (p.length === 2 && Number(p[1]) > now) keep.push(l.trim()); } } catch (e) { /* first token */ }
  keep.push(sha256Hex(t) + " " + String(now + TOKEN_MS));
  writeFileSync(f, keep.join("\n") + "\n", { mode: 0o600 }); chmodSync(f, 0o600);
  return t;
}
// the page the browser opens: a refresh to the URL (the token stays out of every argv)
export function openPage(run: string, url: string): string {
  const f = join(run, "web-open.html");
  const esc = url.split("&").join("&amp;").split("\"").join("&quot;");
  writeFileSync(f, "<!doctype html><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><meta http-equiv=\"refresh\" content=\"0;url=" + esc + "\"><title>agentglass</title>\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}
function nap(ms: number): void { try { execFileSync("sleep", [String(ms / 1000)]); } catch (e) { /* interrupted */ } }
function val(a: string[], k: string): string { const i = a.indexOf(k); return i >= 0 ? a[i + 1] ?? "" : ""; }

function webCli(a: string[]): void {
  const json = a.indexOf("--json") >= 0 || agentHost().on; const noOpen = a.indexOf("--no-open") >= 0 || json;
  for (const x of a) if (x.startsWith("-") && ["--port", "--host", "--no-open", "--redact", "--json", "--stop"].indexOf(x) < 0) cliError("usage", "unknown option " + x, USAGE, 2);
  if (a.indexOf("--stop") >= 0) { // the running one, by its lock's pid
    const s = lockOf(RUN_DIR);
    if (s) { try { process.kill(s.pid, "SIGTERM"); } catch (e) { /* gone */ } const end = Date.now() + 3000; while (Date.now() < end && isAlive(s.pid)) nap(100); }
    process.stdout.write(json ? JSON.stringify({ stopped: s !== null }) + "\n" : s ? "agentglass web: stopped\n" : "agentglass web: not running\n"); return;
  }
  const bind = val(a, "--host"); if (a.indexOf("--host") >= 0 && ["127.0.0.1", "::1", "0.0.0.0", "::"].indexOf(bind) < 0) cliError("usage", "--host must be 127.0.0.1, ::1, 0.0.0.0 or ::", USAGE, 2);
  const port = val(a, "--port"); if (a.indexOf("--port") >= 0 && !/^\d{1,5}$/.test(port)) cliError("usage", "--port needs a number 0–65535", USAGE, 2);
  try { mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 }); chmodSync(RUN_DIR, 0o700); } catch (e) { /* lock read says why */ }
  let lk = lockOf(RUN_DIR); const reused = lk !== null;
  if (lk && bind && (bind === "0.0.0.0" || bind === "::") !== !/^(127\.0\.0\.1|\[::1\])$/.test(lk.host)) process.stderr.write("agentglass web: one is already running on " + lk.host + " — --stop it first to change --host\n");
  if (!lk) {
    const bin = webBin(process.execPath, process.env["PATH"] ?? "");
    if (!bin) cliError("not_installed", "agentglass-web is not installed (the web UI is a separate binary)", "install it with one of:\n  " + installLines(process.platform).join("\n  "), 2);
    const logs = join(HOME, ".agentglass", "logs"); try { mkdirSync(logs, { recursive: true, mode: 0o700 }); } catch (e) { /* exists */ }
    const log = join(logs, "web.log"); const fd = openSync(log, "a"); try { chmodSync(log, 0o600); } catch (e) { /* not ours */ }
    const args = ["--agentglass", process.execPath, "--run-dir", RUN_DIR, "--log", log];
    if (port) args.push("--port", port); if (bind) args.push("--host", bind); if (a.indexOf("--redact") >= 0 || process.env["AGENTGLASS_REDACT"] === "1") args.push("--redact");
    const ch = spawn(bin, args, { stdio: ["ignore", "ignore", fd], detached: true }); closeSync(fd);
    const pid = ch.pid ?? 0; ch.unref();
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) { lk = lockOf(RUN_DIR); if (lk && lk.pid === pid) break; lk = null; if (!isAlive(pid)) break; nap(100); }
    if (!lk) cliError("start_failed", "agentglass-web did not start", "its log: " + log, 1);
  }
  const l = lk as Lock;
  const url = "http://" + l.host + ":" + String(l.port) + "/#t=" + mintToken(RUN_DIR, Date.now());
  if (json) { process.stdout.write(JSON.stringify({ url, port: l.port, pid: l.pid, reused }) + "\n"); return; }
  const shown = "http://" + l.host + ":" + String(l.port) + "/";
  if (!noOpen) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    if (detachedPid(opener, [openPage(RUN_DIR, url)]) > 0) { process.stdout.write("agentglass web: " + shown + (reused ? " (running)" : "") + " — opened in your browser; the link works once, for 10 minutes\n"); return; }
  }
  process.stdout.write(url + "\n");
  process.stderr.write("agentglass web: open this link (it works once, for 10 minutes)" + (reused ? "; the server was already running" : "") + "\n");
}

addCmd({ cmd: "web", usage: USAGE, summary: "the web UI in your browser (starts agentglass-web on 127.0.0.1, a one-time link)", options: [opt("--port", "N", "the port (default: a free one)", "", []), opt("--host", "0.0.0.0", "listen on all interfaces (other devices on your network; plain HTTP: trusted networks only)", "127.0.0.1", []), opt("--no-open", "", "print the link instead of opening the browser", "", []), opt("--redact", "", "fake titles, projects and content", "", []), opt("--json", "", "{url, port, pid, reused}", "", []), opt("--stop", "", "stop the running agentglass-web", "", [])], fields: [], group: "cmd" });
H.cli.unshift((args: string[]): boolean => {
  if (args[0] !== "web") return false;
  if (args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) {
    process.stdout.write(USAGE + "\n  the web UI: agentglass-web serves it on 127.0.0.1 only; this opens (or with --no-open prints) a one-time link (10 minutes)\n  a running agentglass-web is reused: each run mints a new link; --stop ends it\n");
    process.exit(0);
  }
  webCli(args.slice(1));
  return true;
});
