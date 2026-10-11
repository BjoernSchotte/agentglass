// agentglass-web — the loopback web server for agentglass (local-web-api §1, §4): starts `agentglass serve --stdio`,
// serves the embedded UI and /api/v1 on 127.0.0.1, prints one JSON line {port, url} (the URL carries the one-time
// token in its fragment) for the launcher, nothing else on stdout. Run by `agentglass web`.
import { writeFileSync, rmSync, appendFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Auth } from "./auth.ts";
import { Upstream, spawnServe } from "./stdio.ts";
import { startServer } from "./http.ts";
import { ASSETS } from "./assets.gen.ts";

export const VERSION = process.env.AGENTGLASS_WEB_VERSION ?? "0.0.0-dev";
const USAGE = "usage: agentglass-web --agentglass <path> [--port N] [--redact] [--ipv6] [--run-dir <dir>] [--log <file>] [--version]";
function die(msg: string, code = 2): never { process.stderr.write("agentglass-web: " + msg + "\n"); process.exit(code); }
function args(argv: string[]) {
  const o = { agentglass: "", port: 0, redact: false, ipv6: false, runDir: "", log: "", version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!; const v = () => { const x = argv[++i]; if (x === undefined) die(a + " needs a value\n" + USAGE); return x; };
    if (a === "--agentglass") o.agentglass = v(); else if (a === "--port") o.port = Number(v()); else if (a === "--redact") o.redact = true;
    else if (a === "--ipv6") o.ipv6 = true; else if (a === "--run-dir") o.runDir = v(); else if (a === "--log") o.log = v();
    else if (a === "--version") o.version = true; else if (a === "--help" || a === "-h") { process.stdout.write(USAGE + "\n"); process.exit(0); }
    else die("unknown option " + a + "\n" + USAGE);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) die("--port must be 0–65535");
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
  const srv = startServer({ port: a.port, hostname: a.ipv6 ? "::1" : "127.0.0.1", up, auth, assets: ASSETS, log });
  const host = a.ipv6 ? "[::1]" : "127.0.0.1";
  const lock = a.runDir ? join(a.runDir, "web.lock") : "";
  if (lock) { writeFileSync(lock, JSON.stringify({ pid: process.pid, port: srv.port, host }) + "\n", { mode: 0o600 }); chmodSync(lock, 0o600); }
  const bye = () => { if (lock) rmSync(lock, { force: true }); up.stop(); srv.stop(); process.exit(0); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye); process.on("SIGHUP", bye);
  process.stdout.write(JSON.stringify({ port: srv.port, url: "http://" + host + ":" + srv.port + "/#t=" + auth.mint() }) + "\n");
}
if (import.meta.main) void main();
