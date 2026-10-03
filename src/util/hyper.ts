// agentglass — OSC 8 terminal hyperlinks: link(url, text), and whether this terminal gets them (config/env, never in
// agent mode or under --redact: a file:// url would carry the real path inside an invisible escape)
// SPDX-License-Identifier: Apache-2.0
import { readText, run } from "./fs.ts";
import { topValue } from "./config.ts";
import { say } from "../state.ts";
import { agentHost } from "../features/agentenv.ts";
import { REDACT } from "../features/redact-on.ts";

const MODES = ["auto", "on", "off"];
// pure: env AGENTGLASS_HYPERLINKS wins over the config; auto = terminals known to support OSC 8, not inside tmux/screen
export function hyperMode(env: Record<string, string>, cfg: string, tty: boolean, agent: boolean, redact: boolean): boolean {
  if (agent || redact) return false;
  const e = env["AGENTGLASS_HYPERLINKS"] ?? "";
  const m = MODES.indexOf(e) >= 0 ? e : MODES.indexOf(cfg) >= 0 ? cfg : "auto";
  if (m !== "auto") return m === "on";
  const term = env["TERM"] ?? "";
  if ((env["TMUX"] ?? "") !== "" || term.startsWith("screen")) return false; // pass-through needs tmux ≥ 3.4 + terminal-features
  const tp = env["TERM_PROGRAM"] ?? "";
  const known = ["iTerm.app", "WezTerm", "vscode", "ghostty"].indexOf(tp) >= 0 || term === "xterm-kitty" ||
    Number(env["VTE_VERSION"] ?? "0") >= 5000 || (env["WT_SESSION"] ?? "") !== "";
  return known && tty;
}
let on = -1; // -1 = not decided yet
function envMap(): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of ["AGENTGLASS_HYPERLINKS", "TERM", "TMUX", "TERM_PROGRAM", "VTE_VERSION", "WT_SESSION"]) { const v = process.env[k]; if (v !== undefined) o[k] = v; }
  return o;
}
export function hyperOn(): boolean {
  if (on < 0) {
    const raw = topValue("hyperlinks");
    const cfg = typeof raw === "string" ? raw as string : "";
    if (raw !== undefined && MODES.indexOf(cfg) < 0) say("warn", "config hyperlinks must be auto, on or off — using auto");
    const ev = process.env.AGENTGLASS_HYPERLINKS;
    if (ev !== undefined && ev !== "" && MODES.indexOf(ev) < 0) say("warn", "AGENTGLASS_HYPERLINKS must be auto, on or off — ignored");
    on = hyperMode(envMap(), cfg, process.stdout.isTTY === true, agentHost().on, REDACT) ? 1 : 0;
  }
  return on === 1;
}
export function setHyper(v: boolean): void { on = v ? 1 : 0; } // checks
// OSC 8 link around text (text unchanged when hyperlinks are off); control characters and ESC never reach the url
export function link(url: string, text: string): string {
  if (!hyperOn()) return text;
  return "\x1b]8;;" + url.replace(/[\u0000-\u001f\u007f]/g, "") + "\x1b\\" + text + "\x1b]8;;\x1b\\";
}
let host = "-";
function hostname(): string {
  if (host === "-") host = (process.platform === "linux" ? readText("/proc/sys/kernel/hostname", 0, 256) : run("uname", ["-n"])).trim();
  return host;
}
// file://<host>/<percent-encoded path>
export function fileUrl(abs: string): string { return "file://" + hostname() + abs.split("/").map((p: string) => encodeURIComponent(p)).join("/"); }
