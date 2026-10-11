// agentglass-web — the loopback web server for agentglass (local-web-api §1, §4): starts `agentglass serve --stdio`,
// serves the embedded UI and /api/v1 on 127.0.0.1, prints one JSON line {port, url} (the URL carries the one-time
// token in its fragment) for the launcher, nothing else on stdout. Run by `agentglass web`.
import { writeFileSync, rmSync, appendFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { networkInterfaces, hostname } from "node:os";
import { Auth, namesOf } from "./auth.ts";
import { Upstream, spawnServe } from "./stdio.ts";
import { startServer } from "./http.ts";
import { ASSETS } from "./assets.gen.ts";

export const VERSION = process.env.AGENTGLASS_WEB_VERSION ?? "0.0.0-dev";
const USAGE = "usage: agentglass-web --agentglass <path> [--port N] [--host 127.0.0.1|::1|0.0.0.0|::] [--redact] [--ipv6] [--run-dir <dir>] [--log <file>] [--version]";
function die(msg: string, code = 2): never { process.stderr.write("agentglass-web: " + msg + "\n"); process.exit(code); }
function args(argv: string[]) {
  const o = { agentglass: "", port: 0, host: "", redact: false, ipv6: false, runDir: "", log: "", version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!; const v = () => { const x = argv[++i]; if (x === undefined) die(a + " needs a value\n" + USAGE); return x; };
    if (a === "--agentglass") o.agentglass = v(); else if (a === "--port") o.port = Number(v()); else if (a === "--redact") o.redact = true;
    else if (a === "--ipv6") o.ipv6 = true; else if (a === "--host") o.host = v(); else if (a === "--run-dir") o.runDir = v(); else if (a === "--log") o.log = v();
    else if (a === "--version") o.version = true; else if (a === "--help" || a === "-h") { process.stdout.write(USAGE + "\n"); process.exit(0); }
    else die("unknown option " + a + "\n" + USAGE);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) die("--port must be 0–65535");
  if (!o.host) o.host = o.ipv6 ? "::1" : "127.0.0.1";
  if (!["127.0.0.1", "::1", "0.0.0.0", "::"].includes(o.host)) die("--host must be 127.0.0.1, ::1, 0.0.0.0 or ::");
  return o;
}
async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  if (a.version) { process.stdout.write("agentglass-web " + VERSION + "\n"); return; }
  const bin = a.agentglass || Bun.which("agentglass") || "";
  if (!bin) die("agentglass not found: install it first — brew install bjoernschotte/tap/agentglass, or curl -fsSL https://raw.githubusercontent.com/BjoernSchotte/agentglass/main/install.sh | sh");
  const up = new Upstream(spawnServe(bin, a.redact ? ["--redact"] : []));
  try { await up.start(); } catch (e) { die(String((e as Error).message), 1); }
  const tokens = a.runDir ? join(a.runDir, "web.tokens") : "";
  const auth = new Auth(tokens);
  const log = a.log ? (l: string) => { try { if (!existsSync(a.log)) { mkdirSync(dirname(a.log), { recursive: true, mode: 0o700 }); writeFileSync(a.log, "", { mode: 0o600 }); } appendFileSync(a.log, l + "\n"); } catch { /* a log problem never stops the server */ } } : undefined;
  const wide = a.host === "0.0.0.0" || a.host === "::";
  const names = namesOf(a.host, networkInterfaces(), hostname());
  const srv = startServer({ port: a.port, hostname: a.host, names, up, auth, assets: ASSETS, log });
  // the link's host: loopback, or (all interfaces) this machine's first network address so another device can open it
  const host = a.host === "::1" ? "[::1]" : wide ? names[3] ?? "127.0.0.1" : "127.0.0.1";
  if (wide) process.stderr.write("agentglass-web: listening on all interfaces (" + a.host + ") over plain HTTP: every device on the network reaches the login page; links and cookies travel unencrypted — use it on networks you trust\n");
  const lock = a.runDir ? join(a.runDir, "web.lock") : "";
  if (lock) { writeFileSync(lock, JSON.stringify({ pid: process.pid, port: srv.port, host }) + "\n", { mode: 0o600 }); chmodSync(lock, 0o600); }
  const bye = () => { if (lock) rmSync(lock, { force: true }); up.stop(); srv.stop(); process.exit(0); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye); process.on("SIGHUP", bye);
  process.stdout.write(JSON.stringify({ port: srv.port, url: "http://" + host + ":" + srv.port + "/#t=" + auth.mint() }) + "\n");
}
if (import.meta.main) void main();
