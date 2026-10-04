// agentglass — alert outputs (rules-config spec §5, §6): bell + desktop notification (throttled per session), and the
// notify command: an argv (never a shell), the alert JSON on stdin, bounded (≤ 4 at once, ≤ 32 more queued) and killed after 10 s
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { OS } from "../../platform/index.ts";
import { base } from "../../util/json.ts";
import type { Sess } from "../../model/types.ts";
import { titleOf } from "../../model/sessions.ts";
import { screenOut } from "../../hooks.ts";
import { say } from "../../state.ts";
import type { MVal } from "../detect.ts";
import { type Rule, type NotifyCfg, unitOf } from "./config.ts";
import { type Trans, severityOf, placeholders, fill } from "./engine.ts";

export interface JAlert { rule: string; severity: string; state: string; value: number; unit: string; threshold: number; since: string; session: string; harness: string; title: string; project: string; message: string; labels: { [k: string]: string } }

// side effects, swappable by checks
export const IO = {
  bell: (): void => { process.stdout.write("\x07"); },
  desk: (title: string, sub: string, msg: string): void => { OS.notify(title, sub, msg); },
  toast: (msg: string): void => { say("warn", msg); },
};
const lastBell = new Map<string, number>(); // path → last bell/notification (shared throttle)
interface Job { argv: string[]; env: { [k: string]: string }; input: string }
// SIGTERM at killMs, SIGKILL graceMs later; past max running, jobs wait in queue (oldest first, ≤ qmax): a burst of
// transitions (every live session's alert at TUI start) runs in turn instead of being dropped
export const CMD = { running: 0, max: 4, killMs: 10000, graceMs: 2000, queue: [] as Job[], qmax: 32 };
// the command's environment: what a notifier needs (PATH, locale, desktop bus, proxy) — never the rest of agentglass's
// own environment, which can hold API keys and tokens
const ENV_KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM", "DISPLAY", "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
export function cmdEnv(j: JAlert): { [k: string]: string } {
  const env: { [k: string]: string } = {};
  for (const k of Object.keys(process.env)) { const v = process.env[k]; if (v !== undefined && (ENV_KEEP.indexOf(k) >= 0 || k.startsWith("LC_"))) env[k] = v; }
  env["AGENTGLASS_RULE"] = j.rule; env["AGENTGLASS_SEVERITY"] = j.severity; env["AGENTGLASS_STATE"] = j.state;
  env["AGENTGLASS_SESSION"] = screenOut(j.session); env["AGENTGLASS_HARNESS"] = j.harness; env["AGENTGLASS_VALUE"] = String(j.value);
  return env;
}

// the alert object of a transition (text fields as the screen shows them: --redact fakes titles and projects)
export function alertJson(s: Sess, r: Rule, t: Trans, message: string, since: number): JAlert {
  const labels: { [k: string]: string } = {}; for (const [k, v] of r.labels) labels[k] = v;
  const lv = t.to || t.from;
  return { rule: r.id, severity: severityOf(lv), state: t.state, value: t.v, unit: unitOf(r.metric), threshold: t.thr, since: new Date(since || t.at).toISOString(),
    session: s.id, harness: s.h, title: screenOut(titleOf(s)), project: screenOut(base(s.cwd)), message: screenOut(message), labels };
}
// placeholders substituted per argument; no shell, no word splitting: "$(id)" stays literally "$(id)"
export function argvFor(cmd: string[], subs: Map<string, string>): string[] { const out: string[] = []; for (const a of cmd) out.push(fill(a, subs)); return out; }
export function cmdSubs(r: Rule, v: MVal, t: Trans, s: Sess): Map<string, string> {
  const m = placeholders(r, v, t.to || t.from, s);
  for (const k of ["title", "project"]) m.set(k, screenOut(m.get(k) ?? ""));
  return m;
}
// start the notify command for one transition (or queue it): "" = started or queued, else why not
export function runCommand(cfg: NotifyCfg, j: JAlert, subs: Map<string, string>): string {
  if (!cfg.command.length || cfg.on.indexOf(j.state) < 0) return "not configured for " + j.state;
  const job: Job = { argv: argvFor(cfg.command, subs), env: cmdEnv(j), input: screenOut(JSON.stringify(j)) + "\n" };
  if (CMD.running < CMD.max) return spawnJob(job);
  if (CMD.queue.length >= CMD.qmax) return "notify queue full (" + String(CMD.qmax) + " waiting) — dropped";
  CMD.queue.push(job);
  return "";
}
// a slot freed: start queued jobs in order (one that fails to start says so and the next one gets the slot)
function drain(): void {
  while (CMD.running < CMD.max && CMD.queue.length) { const why = spawnJob(CMD.queue.shift() as Job); if (why) IO.toast("rules: " + why); }
}
function spawnJob(job: Job): string {
  let done = false;
  try {
    const ch = spawn(job.argv[0] ?? "", job.argv.slice(1), { stdio: ["pipe", "ignore", "ignore"], env: job.env });
    CMD.running++;
    const end = (): void => { if (done) return; done = true; CMD.running--; clearTimeout(k); drain(); };
    // SIGTERM first; a command that ignores it is killed for good, so it cannot hold a slot forever
    const k = setTimeout(() => { ch.kill(); setTimeout(() => { if (!done) ch.kill("SIGKILL"); }, CMD.graceMs); }, CMD.killMs);
    ch.on("exit", (c: number | null) => { end(); });
    ch.on("error", (e: Error) => { end(); });
    const w = ch.stdin;
    if (w) { w.on("error", (e: Error) => { /* the command did not read its stdin */ }); w.write(job.input); w.end(); }
  } catch (e) { return "notify command failed: " + String(e); }
  return "";
}
// the desktop body's lead: a guess (approval?) leads, like the approval rule's prefix; "likely" qualifies the prefix
function lead(r: Rule, v: MVal): string { return v.hint === "likely" ? r.prefix.trimEnd() + " (likely) " : (v.hint ? v.hint + " " : "") + r.prefix; }
// one transition: bell + desktop (fire/escalate, notify rules, not acked, not in --watch, throttled per session), the command
// on every state in notify.on regardless of acknowledgement (in --watch only with --notify)
export function onTrans(s: Sess, r: Rule, t: Trans, acked: boolean, inWatch: boolean, cmdOn: boolean, cfg: NotifyCfg, v: MVal, message: string, since: number): void {
  if (!inWatch && r.notify && !acked && (t.state === "fire" || t.state === "escalate")) {
    const last = lastBell.get(s.path) ?? 0;
    if (t.at - last >= cfg.throttleSec * 1000) {
      lastBell.set(s.path, t.at);
      if (cfg.bell) IO.bell();
      if (cfg.desktop && process.env.AGENTGLASS_NOTIFY !== "0") IO.desk("agentglass", s.h + " · " + (base(s.cwd) || "?"), lead(r, v) + titleOf(s).slice(0, 120));
    }
  }
  if (cmdOn && r.notify && cfg.command.length && cfg.on.indexOf(t.state) >= 0) {
    const why = runCommand(cfg, alertJson(s, r, t, message, since), cmdSubs(r, v, t, s));
    if (why) IO.toast("rules: " + why);
  }
}
export function forget(path: string): void { lastBell.delete(path); }
