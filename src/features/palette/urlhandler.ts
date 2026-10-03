// agentglass — opt-in Linux handler for agentglass:// links (a browser or chat app hands the link to `agentglass open`):
// ~/.local/share/applications/agentglass-open.desktop + xdg-mime. macOS: see the README (a URL router app).
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, openSync, writeSync, closeSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, readText } from "../../util/fs.ts";

// one Exec argument per the Desktop Entry spec: quoted when it holds a reserved character, \ " ` $ escaped inside the
// quotes, then every \ escaped again (the value is a string), and % doubled (field codes)
export function execArg(a: string): string {
  const p = a.replace(/%/g, "%%");
  if (!/[\s"'\\><~|&;$*?#()`]/.test(p)) return p;
  return "\"" + p.replace(/([\\"`$])/g, "\\$1").replace(/\\/g, "\\\\") + "\"";
}
export function desktopFile(term: string, exe: string): string {
  return "[Desktop Entry]\nType=Application\nName=agentglass link\nComment=Open agentglass:// links in agentglass\nNoDisplay=true\nTerminal=false\n" +
    "MimeType=x-scheme-handler/agentglass;\nExec=" + term.split(" ").filter((x: string) => x.length > 0).map(execArg).join(" ") + " -e " + execArg(exe) + " open %u\n";
}
// open.terminal, else $TERMINAL, else x-terminal-emulator — the first that exists; "" = none
export function pickTerminal(cfg: string, env: Record<string, string>, has: (cmd: string) => boolean): string {
  for (const c of [cfg, env["TERMINAL"] ?? "", "x-terminal-emulator"]) { const b = c.trim().split(" ")[0] ?? ""; if (b && has(b)) return c.trim(); }
  return "";
}
export function onPath(cmd: string): boolean {
  if (cmd.indexOf("/") >= 0) return existsSync(cmd);
  for (const d of (process.env.PATH ?? "").split(":")) { if (!d) continue; try { if (statSync(join(d, cmd)).isFile()) return true; } catch (e) { /* next */ } }
  return false;
}
function appsDir(): string { return join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "applications"); }
const NAME = "agentglass-open.desktop";
// "" = done, else the error to show (exit 1/2 is the caller's)
export function installHandler(term: string, exe: string): string {
  const dir = appsDir(); const p = join(dir, NAME); const tmp = p + ".tmp";
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tmp, "w"); writeSync(fd, desktopFile(term, exe)); closeSync(fd);
    renameSync(tmp, p);
  } catch (e) { return "cannot write " + p + ": " + String(e); }
  try { execFileSync("xdg-mime", ["default", NAME, "x-scheme-handler/agentglass"], { stdio: "ignore", timeout: 10000 }); } catch (e) { return "wrote " + p + " but xdg-mime failed (is xdg-utils installed?)"; }
  if (onPath("update-desktop-database")) { try { execFileSync("update-desktop-database", [dir], { stdio: "ignore", timeout: 10000 }); } catch (e) { /* optional */ } }
  return "";
}
// mimeapps.list without our default line (xdg-mime cannot unset one); other lines stay byte for byte
export function dropDefault(text: string): string {
  return text.split("\n").filter((l: string) => !/^x-scheme-handler\/agentglass=agentglass-open\.desktop;?\s*$/.test(l)).join("\n");
}
export function uninstallHandler(): string {
  const dir = appsDir(); const p = join(dir, NAME);
  if (!existsSync(p)) return "no handler installed (" + p + ")";
  try { unlinkSync(p); } catch (e) { return "cannot remove " + p + ": " + String(e); }
  for (const m of [join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "mimeapps.list"), join(dir, "mimeapps.list")]) {
    const t = readText(m, 0, 1048576); const u = dropDefault(t);
    if (t && u !== t) { try { const fd = openSync(m + ".tmp", "w"); writeSync(fd, u); closeSync(fd); renameSync(m + ".tmp", m); } catch (e) { /* the association stays dangling: harmless */ } }
  }
  if (onPath("update-desktop-database")) { try { execFileSync("update-desktop-database", [dir], { stdio: "ignore", timeout: 10000 }); } catch (e) { /* optional */ } }
  return "";
}
export function handlerPath(): string { return join(appsDir(), NAME); }
