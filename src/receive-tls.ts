// agentglass-receive-tls — `agentglass receive` with built-in HTTPS (otlp-hub spec 11.3, Decision 8). A separate binary
// built with --backend c: https.createServer cannot be lowered on the LLVM tier, and the main binary must not change
// backend. Same handler, limits and storage as the plain receiver (src/features/hub/server.ts); the only file that
// imports node:https (scripts/no-https-in-main.test.sh keeps it out of src/main.ts's import graph).
// The certificate and key are re-read when either file changes (checked every 5 s; scriptc has neither SIGHUP nor
// setSecureContext): a new server takes over the port, the old one finishes its requests.
// SPDX-License-Identifier: Apache-2.0
import * as https from "node:https";
import { readFileSync, statSync, writeSync } from "node:fs";
import { run } from "./util/fs.ts";
import { BUILD } from "./build-info.ts";
import { loadRecv, listenOk, splitListen, expandHome } from "./features/hub/config.ts";
import { type Rt, newRt, handler, onConnection, boot, started, onSignals, releaseRecvLock } from "./features/hub/server.ts";

function say(s: string): void { try { writeSync(2, "agentglass-receive-tls: " + s + "\n"); } catch (e) { /* stderr closed */ } }
function die(s: string, code: number): never { say(s); process.exit(code); }
const MON: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// "notAfter=Oct  8 09:52:00 2026 GMT" (openssl x509 -enddate) → ms, 0 unknown
export function notAfterMs(s: string): number {
  const m = /notAfter=([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) GMT/.exec(s); if (!m) return 0;
  const mo = MON[m[1] ?? ""]; if (mo === undefined) return 0;
  return Date.UTC(Number(m[6] ?? "0"), mo, Number(m[2] ?? "1"), Number(m[3] ?? "0"), Number(m[4] ?? "0"), Number(m[5] ?? "0"));
}
function certNote(rt: Rt, cert: string): void {
  const exp = notAfterMs(run("openssl", ["x509", "-enddate", "-noout", "-in", cert]));
  rt.tlsNote = exp ? "TLS certificate expires " + new Date(exp).toISOString().slice(0, 10) : "TLS on";
  rt.tlsExpires = exp;
}
function mtimes(a: string, b: string): string { try { return String(statSync(a).mtimeMs) + "/" + String(statSync(b).mtimeMs); } catch (e) { return ""; } }

function main(args: string[]): void {
  if (args[0] === "--version") { writeSync(1, BUILD.version + "\n"); process.exit(0); }
  if (args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) { writeSync(1, "usage: agentglass-receive-tls --tls-cert F --tls-key F [--listen ip:port] [--dir D] [--listen-public]\n  (normally started by: agentglass receive --tls-cert F --tls-key F)\n"); process.exit(0); }
  const c = loadRecv();
  for (const w of c.warns) say(w);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ""; const v = args[i + 1] ?? "";
    if (a === "--listen-public") { c.listenPublic = true; continue; }
    if (a !== "--listen" && a !== "--dir" && a !== "--tls-cert" && a !== "--tls-key") die("unknown option " + a, 2);
    if (!v || v.startsWith("--")) die(a + " needs a value", 2);
    if (a === "--listen") c.listen = v; else if (a === "--dir") c.dir = expandHome(v); else if (a === "--tls-cert") c.tls[0] = expandHome(v); else c.tls[1] = expandHome(v);
    i++;
  }
  const cert = expandHome(c.tls[0] ?? ""); const key = expandHome(c.tls[1] ?? "");
  if (!cert || !key) die("--tls-cert and --tls-key are required", 2);
  const lp = listenOk(c.listen, c.listenPublic, true); if (lp) die(lp, 2);
  const l = splitListen(c.listen); if (!l) die("bad listen address", 2);
  const host = l ? l.host : "127.0.0.1";
  let pem = ["", ""];
  try { pem = [readFileSync(cert, "utf8"), readFileSync(key, "utf8")]; } catch (e) { die("cannot read the certificate or key: " + (e instanceof Error ? e.message : String(e)), 2); }
  const rt = newRt(c);
  const b = boot(rt); if (b.code) die(b.err, b.code);
  certNote(rt, cert);
  const make = (p: string[]): https.Server => { const s = https.createServer({ cert: p[0] ?? "", key: p[1] ?? "" }, handler(rt)); s.on("connection", onConnection(rt)); return s; };
  let srv = make(pem);
  srv.on("error", (e: Error) => { releaseRecvLock(c.dir); die("cannot listen on " + c.listen + ": " + e.message, 2); });
  srv.listen(l ? l.port : 0, host, () => {
    const a = srv.address(); const port = a && typeof a === "object" ? (a as { port: number }).port : 0;
    let seen = mtimes(cert, key);
    const reload = setInterval(() => {
      const m = mtimes(cert, key); if (!m || m === seen) return;
      let p = ["", ""]; try { p = [readFileSync(cert, "utf8"), readFileSync(key, "utf8")]; } catch (e) { return; } // half-written: next round
      if (p[0].indexOf("-----BEGIN") < 0 || p[1].indexOf("-----BEGIN") < 0) return;
      seen = m;
      const n = make(p);
      n.on("error", (e: Error) => { say("certificate reload failed (" + e.message + ") — still serving the old one"); });
      const old = srv; old.close(); srv = n;
      n.listen(port, host, () => { certNote(rt, cert); say("certificate reloaded (" + rt.tlsNote + ")"); });
    }, 5000);
    const stop = started(rt, port);
    onSignals(rt, (done: () => void) => { srv.close(() => { done(); }); }, () => { clearInterval(reload); stop(); });
    say("listening on https://" + (host.indexOf(":") >= 0 ? "[" + host + "]" : host) + ":" + String(port) + " — storing in " + c.dir + " (" + rt.tlsNote + ")");
  });
}
main(process.argv.slice(2));
