// agentglass — macOS adapter: ps %cpu is already a recent (decaying) average, lsof for open files
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { HOME, run } from "../util/fs.ts";
import type { Platform } from "./types.ts";
import { psProcs, lsofFiles, devOf, detached, moveInto, ownerModeOf, fileInfoOf } from "./posix.ts";

function esc(t: string): string { return t.replace(/\\/g, "\\\\").replace(/"/g, "\\\""); }

export const darwin: Platform = {
  name: "darwin",
  listProcs: psProcs,
  cpuOf: (pid: number, reported: number, now: number) => reported,
  prune: (alive: (pid: number) => boolean) => { /* stateless */ },
  procFiles: lsofFiles,
  ttyDevice: devOf,
  clipboardCmds: () => [["pbcopy"]],
  notify: (title: string, subtitle: string, msg: string) =>
    detached("osascript", ["-e", "display notification \"" + esc(msg) + "\" with title \"" + esc(title) + "\" subtitle \"" + esc(subtitle) + "\""]),
  fullName: () => run("id", ["-F"]).trim(),
  sha256File: (path: string) => (run("shasum", ["-a", "256", path]).split(" ")[0] ?? "").trim(),
  trash: (path: string) => { moveInto(join(HOME, ".Trash"), path); },
  trashName: "~/.Trash",
  fileInfo: (path: string) => fileInfoOf(run("stat", ["-f", "%u %Lp %HT", "--", path])),
  ownerMode: (path: string) => ownerModeOf(run("stat", ["-L", "-f", "%u %Lp", path])),
  envOf: (pid: number) => new Uint8Array(0), // ps -E truncates and SIP hides it: config files only
};
