// agentglass — Linux adapter: cpu from /proc tick deltas, cwd and open files from /proc (no lsof needed)
// SPDX-License-Identifier: Apache-2.0
import { realpathSync, renameSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { HOME, readText, readBytes, listDir, run } from "../util/fs.ts";
import type { Platform } from "./types.ts";
import { psProcs, devOf, detached, freeName } from "./posix.ts";

// ps %cpu on Linux is the lifetime average, so fresh helpers read as 100%+ and long-lived agents as idle →
// diff utime+stime from /proc/<pid>/stat between refreshes instead
const ticks = new Map<number, { t: number; at: number; cpu: number }>();
let hz = 0;
function cpuOf(pid: number, reported: number, now: number): number {
  if (!hz) hz = Number(run("getconf", ["CLK_TCK"]).trim()) || 100;
  const st = readText("/proc/" + pid + "/stat", 0, 1024);
  const i = st.lastIndexOf(")"); // comm may contain spaces and parens
  const f = i > 0 ? st.slice(i + 2).split(" ") : [];
  const t = Number(f[11]) + Number(f[12]); // fields 14 utime + 15 stime, counted from field 3 (state)
  if (!isFinite(t)) return 0;
  const prev = ticks.get(pid);
  if (prev && now - prev.at < 500) return prev.cpu; // a refresh right after another (kill, resume): a 10 ms tick over a few ms would read as 1000%+
  const cpu = prev ? Math.max(0, (t - prev.t) / hz / ((now - prev.at) / 1000) * 100) : 0;
  ticks.set(pid, { t, at: now, cpu });
  return cpu;
}
function realpath(p: string): string { try { return realpathSync(p); } catch (e) { return ""; } }
function procFiles(pids: number[], want: (path: string) => boolean): { cwd: Map<number, string>; open: Map<string, number> } {
  const cwd = new Map<number, string>(); const open = new Map<string, number>();
  for (const pid of pids) {
    const c = realpath("/proc/" + pid + "/cwd");
    if (c) cwd.set(pid, c);
    const dir = "/proc/" + pid + "/fd";
    for (const fd of listDir(dir)) { const n = realpath(dir + "/" + fd); if (n && want(n)) open.set(n, pid); }
  }
  return { cwd, open };
}
// freedesktop.org trash spec: $XDG_DATA_HOME/Trash/{files/<name>, info/<name>.trashinfo} — file managers can restore it
function two(n: number): string { return (n < 10 ? "0" : "") + n; }
function trash(path: string): void {
  const root = join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "Trash");
  const files = join(root, "files"); const info = join(root, "info");
  mkdirSync(files, { recursive: true }); mkdirSync(info, { recursive: true });
  const name = freeName(files, path);
  const d = new Date();
  const when = d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + "T" + two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
  const ip = join(info, name + ".trashinfo");
  const fd = openSync(ip, "w");
  writeSync(fd, "[Trash Info]\nPath=" + path.split("/").map((p: string) => encodeURIComponent(p)).join("/") + "\nDeletionDate=" + when + "\n");
  closeSync(fd);
  try { renameSync(path, join(files, name)); } catch (e) { try { unlinkSync(ip); } catch (e2) { /* gone */ } throw e; }
}

export const linux: Platform = {
  name: "linux",
  listProcs: psProcs,
  cpuOf,
  prune: (alive: (pid: number) => boolean) => { for (const k of [...ticks.keys()]) if (!alive(k)) ticks.delete(k); },
  procFiles,
  ttyDevice: devOf,
  clipboardCmds: () => {
    const c: string[][] = [];
    if (process.env.WAYLAND_DISPLAY) c.push(["wl-copy"]);
    if (process.env.DISPLAY) c.push(["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]);
    return c;
  },
  notify: (title: string, subtitle: string, msg: string) => {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) detached("notify-send", ["-a", "agentglass", title + " · " + subtitle, msg]);
  },
  // passwd GECOS: "Full Name,Room,Phone,…"
  fullName: () => ((run("getent", ["passwd", userInfo().username]).split(":")[4] ?? "").split(",")[0] ?? "").trim(),
  trash,
  sha256File: (path: string) => (run("sha256sum", [path]).split(" ")[0] ?? "").trim(),
  trashName: "the trash (~/.local/share/Trash)",
  envOf: (pid: number) => readBytes("/proc/" + String(pid) + "/environ", 0, 262144),
};
