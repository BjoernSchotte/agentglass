// agentglass — `agentglass receive`: the OTLP/HTTP receiver's CLI (otlp-hub spec 6–11): serve, tokens, status, service
// SPDX-License-Identifier: Apache-2.0
import * as http from "node:http";
import { writeSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { type Obj, obj, str } from "../../util/json.ts";
import { HOME, readWhole, run } from "../../util/fs.ts";
import { H } from "../../hooks.ts";
import { BUILD } from "../../build-info.ts";
import { addCmd, opt, cmdText, cmdOf, helpOf, wantsHelp } from "../clihelp.ts";
import { agentHost, errLine } from "../agentenv.ts";
import { type RecvCfg, loadRecv, listenOk, splitListen, expandHome } from "./config.ts";
import { type Tok, addToken, rotateToken, revokeToken, readTokens, tokensFile, live } from "./tokens.ts";
import { newRt, handler, onConnection, boot, started, onSignals, releaseRecvLock } from "./server.ts";
import { argVal } from "../../util/argv.ts";

const TLS_BIN = "agentglass-receive-tls";
function out(s: string): void { try { writeSync(1, s + "\n"); } catch (e) { /* stdout closed */ } }
function die(msg: string, hint: string, code: number): never { errLine("agentglass receive", code === 2 ? "usage" : code === 3 ? "locked" : "receive_failed", msg, hint); process.exit(code); }
// "90d", "24h", "30m", "45s" → ms; -1 malformed
export function durMs(s: string): number {
  const m = /^(\d{1,6})(s|m|h|d)$/.exec(s); if (!m) return -1;
  const n = Number(m[1] ?? "0"); const u = m[2] ?? "";
  return u === "s" ? n * 1000 : u === "m" ? n * 60000 : u === "h" ? n * 3600000 : n * 86400000;
}
// flag values: --x v; unknown flags are usage errors
function flags(args: string[], withVal: string[], bare: string[]): { v: Map<string, string>; pos: string[]; err: string } {
  const v = new Map<string, string>(); const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (withVal.indexOf(a) >= 0) { const x = argVal(args, i); if (x === null) return { v, pos, err: a + " needs a value" }; v.set(a, String(x)); i++; continue; }
    if (bare.indexOf(a) >= 0) { v.set(a, "1"); continue; }
    if (a.startsWith("-")) return { v, pos, err: "unknown option " + a };
    pos.push(a);
  }
  return { v, pos, err: "" };
}
function warnCfg(c: RecvCfg): void { for (const w of c.warns) errLine("agentglass receive", "config", w + " (~/.agentglass/config.json)", ""); }
function day(ms: number): string { return ms ? new Date(ms).toISOString().slice(0, 10) : "never"; }

// ── serve ──
function serve(args: string[]): void {
  const f = flags(args, ["--listen", "--dir", "--tls-cert", "--tls-key"], ["--listen-public"]);
  if (f.err || f.pos.length) die(f.err || "unexpected argument " + (f.pos[0] ?? ""), "agentglass receive --help", 2);
  const c = loadRecv(); warnCfg(c);
  c.listen = f.v.get("--listen") ?? c.listen;
  if (f.v.has("--dir")) c.dir = expandHome(f.v.get("--dir") ?? "");
  if (f.v.has("--tls-cert")) c.tls[0] = f.v.get("--tls-cert") ?? "";
  if (f.v.has("--tls-key")) c.tls[1] = f.v.get("--tls-key") ?? "";
  if (f.v.has("--listen-public")) c.listenPublic = true;
  const cert = c.tls[0] ?? ""; const key = c.tls[1] ?? "";
  const tls = cert !== "" || key !== "";
  if (tls && (cert === "" || key === "")) die("--tls-cert and --tls-key go together", "", 2);
  const lp = listenOk(c.listen, c.listenPublic, tls);
  if (lp) die(lp, "", 2);
  if (tls) { // built-in HTTPS is a separate C-backend binary next to this one (Decision 8)
    const bin = join(dirname(process.execPath), TLS_BIN);
    if (!existsSync(bin)) die("built-in HTTPS needs " + TLS_BIN + " next to " + process.execPath, "install.sh and the stable Homebrew formula install it from the release archive; or keep 127.0.0.1 and use tailscale serve / a TLS proxy", 2);
    const tv = run(bin, ["--version"]).trim(); // a binary left from another version must not serve (it misses that version's fixes)
    if (tv !== BUILD.version) die(bin + " is version " + (tv || "unknown") + ", agentglass is " + BUILD.version, "reinstall both from one release (install.sh, or agentglass update)", 2);
    const a = ["--listen", c.listen, "--dir", c.dir, "--tls-cert", expandHome(c.tls[0] ?? ""), "--tls-key", expandHome(c.tls[1] ?? "")];
    if (c.listenPublic) a.push("--listen-public");
    const ch = spawn(bin, a, { stdio: "inherit" });
    const fwd = (): void => { try { ch.kill("SIGTERM"); } catch (e) { /* gone */ } }; // a service manager stops the parent: the child goes too
    process.on("SIGTERM", fwd); process.on("SIGINT", fwd);
    ch.on("exit", (code: number | null) => { process.exit(typeof code === "number" ? code : 1); });
    ch.on("error", (e: Error) => { die("cannot start " + bin + ": " + e.message, "", 2); });
    return;
  }
  const l = splitListen(c.listen); if (!l) die("bad listen address", "", 2);
  const rt = newRt(c);
  const b = boot(rt); if (b.code) die(b.err, b.code === 3 ? "stop it first (agentglass receive status shows its pid)" : "", b.code);
  const srv = http.createServer(handler(rt));
  srv.on("connection", onConnection(rt));
  srv.on("error", (e: Error) => { releaseRecvLock(c.dir); die("cannot listen on " + c.listen + ": " + e.message, "pick another --listen address or stop what uses it", 2); });
  srv.listen(l ? l.port : 0, l ? l.host : "127.0.0.1", () => {
    const a = srv.address(); const port = a && typeof a === "object" ? (a as { port: number }).port : 0;
    const stop = started(rt, port);
    onSignals(rt, (done: () => void) => { srv.close(() => { done(); }); }, stop);
    const n = new Set<string>(); for (const t of rt.toks.toks) if (live(t, Date.now())) n.add(t.name);
    errLine("agentglass receive", "info", "listening on http://" + (l && l.host.indexOf(":") >= 0 ? "[" + l.host + "]" : l ? l.host : "") + ":" + String(port) + " — " + String(n.size) + " host token(s), storing in " + c.dir, n.size ? "" : "no tokens yet: agentglass receive token add <host>");
  });
}

// ── tokens ──
function tokens(args: string[]): void {
  const sub = args[0] ?? "";
  const f = flags(args.slice(1), ["--expires", "--grace", "--dir"], ["--repin", "--json"]);
  if (f.err) die(f.err, "agentglass receive token --help", 2);
  const c = loadRecv(); if (f.v.has("--dir")) c.dir = expandHome(f.v.get("--dir") ?? "");
  const file = tokensFile(c.dir); const now = Date.now();
  const exp = f.v.has("--expires") ? durMs(f.v.get("--expires") ?? "") : 0;
  if (exp < 0) die("--expires must look like 90d, 24h or 30m", "", 2);
  const host = f.pos[0] ?? "";
  if ((sub === "add" || sub === "rotate") && agentHost().on) die("refusing to print a token inside a coding agent: it would go into the agent's transcript", "run it in your own terminal", 2);
  if (sub === "add" || sub === "rotate" || sub === "revoke") { if (!host || f.pos.length > 1) die("usage: agentglass receive token " + sub + " <host>", "", 2); }
  try {
    if (sub === "add") {
      const t = addToken(file, host, exp, now, f.v.has("--repin"));
      if (!t) { out("pin cleared for " + host + ": its next accepted host.id pins the token again"); return; }
      showToken(host, t, exp ? now + exp : 0);
    } else if (sub === "rotate") {
      const g = f.v.has("--grace") ? durMs(f.v.get("--grace") ?? "") : 86400000;
      if (g < 0) die("--grace must look like 24h, 30m or 0s", "", 2);
      const t = rotateToken(file, host, g, exp, now);
      showToken(host, t, exp ? now + exp : 0);
      out("the old token of " + host + " keeps working until " + new Date(now + g).toISOString() + "; replace it on the host before then");
    } else if (sub === "revoke") {
      const n = revokeToken(file, host);
      out("revoked " + String(n) + " token(s) of " + host + " — a running receive refuses them within a second");
    } else if (sub === "list") {
      const r = readTokens(file); if (r.err) die(r.err, "", 2);
      const rows = r.toks.map((t: Tok) => ({ host: t.name, created: t.created, expires: t.expires, hostId: t.pin, state: !live(t, now) ? "expired" : t.expires && t.expires - now < 7 * 86400000 ? "expiring" : "active" }));
      if (f.v.has("--json") || agentHost().on) { out(JSON.stringify(rows)); return; }
      if (!rows.length) { out("no tokens — add one: agentglass receive token add <host>"); return; }
      out("HOST              CREATED     EXPIRES     STATE     HOST ID");
      for (const x of rows) out(x.host.padEnd(18) + day(x.created).padEnd(12) + (x.expires ? day(x.expires) : "never").padEnd(12) + x.state.padEnd(10) + (x.hostId || "(not pinned yet)"));
    } else die("usage: agentglass receive token add|rotate|revoke|list", "", 2);
  } catch (e) { die(e instanceof Error ? e.message : String(e), "", 2); }
}
function showToken(host: string, t: string, exp: number): void {
  out("token for " + host + (exp ? " (expires " + new Date(exp).toISOString().slice(0, 10) + ")" : "") + " — shown once, the hub keeps only its hash:\n");
  out("  " + t + "\n");
  out("on " + host + ": put this line into a file only you can read (chmod 600), e.g. ~/.agentglass/otlp-headers:\n");
  out("  Authorization: Bearer " + t + "\n");
  out("and in its ~/.agentglass/config.json: \"otlp\": {\"endpoint\": \"<hub URL>\", \"headersFile\": \"~/.agentglass/otlp-headers\"}");
  out("then run there: agentglass --watch --otlp");
}

// ── status (spec 6): what the running receiver flushed to status.json, plus warnings ──
function ago(ms: number, now: number): string { if (!ms) return "never"; const s = Math.max(0, Math.round((now - ms) / 1000)); return s < 120 ? String(s) + " s ago" : s < 7200 ? String(Math.round(s / 60)) + " min ago" : s < 172800 ? String(Math.round(s / 3600)) + " h ago" : String(Math.round(s / 86400)) + " d ago"; }
function mb(n: number): string { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB"; }
export function statusWarnings(st: Obj, toks: Tok[], now: number, funnel: string): string[] {
  const w: string[] = [];
  const disk = obj(st["disk"]) ?? {};
  if (disk["full"] === true) w.push("disk budget full: today's files exceed receive.maxDiskMB — ingest answers 503 until tomorrow or a bigger budget");
  for (const t of toks) if (t.expires && live(t, now) && t.expires - now < 7 * 86400000) w.push("token of " + t.name + " expires " + new Date(t.expires).toISOString().slice(0, 10) + " — agentglass receive token rotate " + t.name);
  const hosts = obj(st["hosts"]) ?? {};
  for (const n of Object.keys(hosts)) { const h = obj(hosts[n]) ?? {}; const sc = h["scrubbed"]; if (typeof sc === "number" && (sc as number) > 0) w.push("scrubbed " + String(sc) + " content attribute(s) from " + n + " — check its export settings (otlp.content off, or --redact)"); }
  const te = st["tlsExpires"];
  if (typeof te === "number" && (te as number) > 0 && (te as number) - now < 14 * 86400000) w.push((te as number) <= now ? "the TLS certificate expired " + new Date(te as number).toISOString().slice(0, 10) + " — exporters refuse it; replace the files (reloaded within 5 s)" : "the TLS certificate expires " + new Date(te as number).toISOString().slice(0, 10) + " — renew it (the files are reloaded within 5 s)");
  if (funnel) w.push(funnel);
  return w;
}
// a tailscale Funnel in front of this port would expose the hub publicly (spec 11.1); "" when none can be seen
function funnelWarning(port: number): string {
  const s = run("tailscale", ["serve", "status", "--json"]); if (!s) return "";
  let o: Obj | null = null; try { o = obj(JSON.parse(s)); } catch (e) { return ""; }
  const af = obj(o?.["AllowFunnel"]); if (!af) return "";
  for (const k of Object.keys(af)) if (af[k] === true && s.indexOf("127.0.0.1:" + String(port)) >= 0) return "tailscale Funnel is on for " + k + " and proxies this hub: it is reachable from the internet — turn Funnel off (tailscale funnel reset)";
  return "";
}
function status(args: string[]): void {
  const f = flags(args, ["--dir"], ["--json"]);
  if (f.err || f.pos.length) die(f.err || "unexpected argument", "agentglass receive status --help", 2);
  const c = loadRecv(); if (f.v.has("--dir")) c.dir = expandHome(f.v.get("--dir") ?? "");
  const now = Date.now();
  const r = readWhole(join(c.dir, "status.json"), 1048576);
  let st: Obj = {}; if (!r.err && !r.missing) { try { st = obj(JSON.parse(r.text)) ?? {}; } catch (e) { st = {}; } }
  const pid = typeof st["pid"] === "number" ? st["pid"] as number : 0;
  let running = false; if (pid > 0) { try { process.kill(pid, 0); running = true; } catch (e) { running = false; } }
  const lock = readWhole(join(c.dir, "receive.lock"), 64);
  if (running && (lock.missing || lock.text.trim() !== String(pid))) running = false;
  const tk = readTokens(tokensFile(c.dir));
  const port = typeof st["port"] === "number" ? st["port"] as number : 0;
  const warns = statusWarnings(st, tk.toks, now, running && port ? funnelWarning(port) : "");
  if (tk.err) warns.unshift(tk.err);
  st["running"] = running; st["warnings"] = warns;
  if (f.v.has("--json") || agentHost().on) { out(JSON.stringify(st)); return; }
  out("agentglass receive " + (running ? "running (pid " + String(pid) + ") on " + str(st["listen"]) + (port ? " port " + String(port) : "") + ", up since " + new Date(typeof st["startedAt"] === "number" ? st["startedAt"] as number : now).toISOString().slice(0, 16).split("T").join(" ") + " UTC" : "not running") + " — " + c.dir);
  const hosts = obj(st["hosts"]) ?? {};
  const names = Object.keys(hosts);
  if (!names.length) out("  no hosts yet" + (tk.toks.length ? "" : " — agentglass receive token add <host>"));
  for (const n of names) {
    const h = obj(hosts[n]) ?? {}; const rj = obj(h["rejected"]) ?? {};
    const rs = Object.keys(rj).map((k: string) => k + " " + String(rj[k])).join(", ");
    const sk = h["heartbeatSkewMs"]; const skew = typeof sk === "number" && Math.abs(sk as number) > 30000 ? ", clock skew " + String(Math.round((sk as number) / 1000)) + " s" : "";
    out("  " + n.padEnd(16) + " last seen " + ago(typeof h["lastSeen"] === "number" ? h["lastSeen"] as number : 0, now) + ", " + String(h["requests"] ?? 0) + " requests, " + String(h["records"] ?? 0) + " records, " + mb(typeof h["bytes"] === "number" ? h["bytes"] as number : 0) +
      (rs ? ", refused: " + rs : "") + (h["hostId"] ? ", host id " + str(h["hostId"]) : "") + skew);
  }
  const d = obj(st["disk"]) ?? {};
  if (typeof d["usedBytes"] === "number") out("  disk " + mb(d["usedBytes"] as number) + " of " + mb(typeof d["maxBytes"] === "number" ? d["maxBytes"] as number : 0) + ", retention " + String(st["retentionDays"] ?? c.retentionDays) + " days" + (str(st["tls"]) ? ", " + str(st["tls"]) : ""));
  const rf = obj(st["refused"]) ?? {}; const rfs = Object.keys(rf).map((k: string) => k + " " + String(rf[k])).join(", ");
  if (rfs) out("  refused before authentication: " + rfs);
  for (const w of warns) out("  ! " + w);
}

// ── service (spec 6): a user unit to copy, never installed ──
export function serviceText(os: string, exe: string, home: string): string {
  if (os === "darwin") {
    const plist = home + "/Library/LaunchAgents/dev.agentglass.receive.plist";
    return "# " + plist + "\n<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n" +
      "  <key>Label</key><string>dev.agentglass.receive</string>\n  <key>ProgramArguments</key><array><string>" + exe + "</string><string>receive</string></array>\n" +
      "  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardErrorPath</key><string>" + home + "/Library/Logs/agentglass-receive.log</string>\n</dict></plist>\n" +
      "\n# enable: launchctl bootstrap gui/$(id -u) " + plist + "\n";
  }
  const unit = home + "/.config/systemd/user/agentglass-receive.service";
  return "# " + unit + "\n[Unit]\nDescription=agentglass receive (OTLP hub)\nAfter=network-online.target\n\n[Service]\nExecStart=" + exe + " receive\nRestart=on-failure\nRestartSec=5\n" +
    "NoNewPrivileges=yes\nPrivateTmp=yes\nUMask=0077\n\n[Install]\nWantedBy=default.target\n\n# enable: systemctl --user daemon-reload && systemctl --user enable --now agentglass-receive\n";
}

const RECEIVE_OPTS = [opt("--listen", "ip:port", "address to listen on: loopback or tailnet without further flags", "127.0.0.1:4318", []), opt("--dir", "path", "hub directory (also receive.dir, AGENTGLASS_HUB_DIR)", "~/.agentglass/hub", []),
  opt("--listen-public", "", "allow a non-loopback, non-tailnet address (needs TLS)", "", []), opt("--tls-cert", "file", "PEM certificate: built-in HTTPS via " + TLS_BIN, "", []), opt("--tls-key", "file", "PEM key for --tls-cert", "", [])];
addCmd({ cmd: "receive", usage: "agentglass receive [--listen 127.0.0.1:4318]", summary: "OTLP/HTTP hub receiver: hosts push their export with a token each (foreground)\n(--dir, --listen-public with --tls-cert/--tls-key; config section receive)", options: RECEIVE_OPTS, fields: [], group: "cmd" });
addCmd({ cmd: "receive token", usage: "agentglass receive token add|rotate|revoke|list <host>", summary: "per-host tokens: add prints one once; rotate (--grace 24h) keeps the old one for the grace period;\nrevoke ends them at once; add --repin clears the pinned host id; --expires 90d",
  options: [opt("--expires", "90d|24h", "token lifetime", "none", []), opt("--grace", "24h", "rotate: how long the old token keeps working", "24h", []), opt("--repin", "", "add: clear the host id pin (a reinstalled machine)", "", []), opt("--json", "", "list as JSON", "", [])], fields: [], group: "cmd" });
addCmd({ cmd: "receive status", usage: "agentglass receive status [--json]", summary: "the receiver: per host requests, records, last seen, refusals, pin, token expiry; disk vs budget", options: [opt("--json", "", "as JSON", "", [])], fields: [], group: "cmd" });
addCmd({ cmd: "receive service", usage: "agentglass receive service [--print]", summary: "print a systemd user unit (Linux) or launchd agent (macOS) for the receiver; never installs it", options: [], fields: [], group: "cmd" });
H.cli.unshift((args: string[]): boolean => {
  if (args[0] !== "receive") return false;
  const sub = args[1] ?? ""; const rest = args.slice(2);
  const cmd = sub === "token" || sub === "status" || sub === "service" ? "receive " + sub : "receive";
  if (wantsHelp(args)) { const c = cmdOf(cmd); out(helpOf(cmd, args, c ? cmdText(c) : "")); process.exit(0); }
  if (sub === "token") tokens(rest);
  else if (sub === "status") status(rest);
  else if (sub === "service") { const f = flags(rest, [], ["--print"]); if (f.err || f.pos.length) die(f.err || "unexpected argument", "", 2); out(serviceText(process.platform, process.execPath, HOME)); }
  else { serve(args.slice(1)); return true; } // the server keeps the process alive
  process.exit(0);
  return true;
});
