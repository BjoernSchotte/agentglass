// agentglass — versions: stable YYYY.M.N, dev <base>-dev.<YYYYMMDD>.<run>+<sha8>, local <base>-local+<sha>[-dirty]; own ordering, never semver or dates
// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { type Obj, parse } from "../util/json.ts";
import { HOME, readText } from "../util/fs.ts";
import { BUILD } from "../build-info.ts";

// rank: 0 stable, 1 dev, 2 local
export interface Ver { y: number; m: number; n: number; rank: number; devDate: number; devRun: number; raw: string }
const BASE = "(0\\.0\\.0|[0-9]{4}\\.[1-9][0-9]?\\.[1-9][0-9]*)";
const STABLE = new RegExp("^" + BASE + "$");
const DEV = new RegExp("^" + BASE + "-dev\\.([0-9]{8})\\.([1-9][0-9]*)\\+[0-9a-f]{8}$");
const LOCAL = new RegExp("^" + BASE + "-local\\+[0-9a-f]{7,40}(-dirty)?$");
function mk(b: string, raw: string, rank: number, dd: number, dr: number): Ver {
  const p = b.split(".");
  return { y: Number(p[0]), m: Number(p[1]), n: Number(p[2]), rank, devDate: dd, devRun: dr, raw };
}
export function parseVersion(s: string): Ver | null {
  let m = STABLE.exec(s); if (m && m[1] !== "0.0.0") return mk(m[1] ?? "", s, 0, 0, 0);
  m = DEV.exec(s); if (m) return mk(m[1] ?? "", s, 1, Number(m[2]), Number(m[3]));
  m = LOCAL.exec(s); if (m) return mk(m[1] ?? "", s, 2, 0, 0);
  return null;
}
// same base: the stable release first, then its dev/local builds (dev by date, run); the next stable after all of them
export function compareVersions(a: Ver, b: Ver): number {
  return a.y - b.y || a.m - b.m || a.n - b.n || (a.rank === 0 ? 0 : 1) - (b.rank === 0 ? 0 : 1) || a.devDate - b.devDate || a.devRun - b.devRun;
}
const DEV_TAG = /^dev-([0-9]{8})\.([1-9][0-9]*)\.([1-9][0-9]*)-([0-9a-f]{8})$/;
export function parseDevTag(tag: string): { date: number; run: number; attempt: number; sha: string } | null {
  const m = DEV_TAG.exec(tag);
  return m ? { date: Number(m[1]), run: Number(m[2]), attempt: Number(m[3]), sha: m[4] ?? "" } : null;
}
// "v2026.9.1" → "2026.9.1"; anything else (dev tags, malformed) → ""
export function versionOfTag(tag: string): string {
  const v = tag.startsWith("v") ? tag.slice(1) : "";
  const p = parseVersion(v);
  return p && p.rank === 0 ? v : "";
}
// the same file? execPath is already resolved; a recorded path may go through a symlink (macOS /var → /private/var)
export function samePath(execPath: string, recorded: unknown): boolean {
  if (typeof recorded !== "string" || !recorded) return false;
  if (recorded === execPath) return true;
  try { return realpathSync(recorded) === execPath; } catch (e) { return false; }
}
// how this binary got here: Homebrew keeps it under a Cellar; install.sh leaves a marker naming the path it wrote
export function installMethod(execPath: string, channel: string, installJson: string): string {
  if (execPath.indexOf("/Cellar/") >= 0) return "homebrew";
  const o = parse(installJson.trim());
  if (o && o["method"] === "script" && samePath(execPath, o["path"])) return "script";
  return channel === "local" ? "source" : "unknown";
}
// the CLI contract (docs/cli-contract.md): bumped only when a listed command, field, flag or exit code is removed,
// renamed or changes type or meaning; additions keep it
export const CONTRACT = 1;
export function versionInfo(): Obj {
  const ij = readText(join(HOME, ".agentglass", "install.json"), 0, 65536);
  return { version: BUILD.version, channel: BUILD.channel, commit: BUILD.commit, date: BUILD.date, platform: BUILD.platform,
    installMethod: installMethod(process.execPath, BUILD.channel, ij), contract: CONTRACT };
}
