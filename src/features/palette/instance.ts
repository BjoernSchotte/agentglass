// agentglass — single instance, shared by client and server: the setting, and whether a pid is a live agentglass
// SPDX-License-Identifier: Apache-2.0
import { basename } from "node:path";
import { say } from "../../state.ts";
import { section } from "../../util/config.ts";
import { OS } from "../../platform/index.ts";

let si = -1;
export function singleInstance(): boolean {
  if (si < 0) {
    const v = section("open")["singleInstance"];
    if (v !== undefined && typeof v !== "boolean") say("warn", "config open.singleInstance must be true or false — using true");
    si = v === false ? 0 : 1;
  }
  return si === 1;
}
export function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return String(e).indexOf("EPERM") >= 0; } }
// an agentglass process: its program is this binary's name or "agentglass" (a reused pid of another program is stale)
export function isOurs(pid: number): boolean {
  const me = basename(process.execPath);
  for (const p of OS.listProcs()) if (p.pid === pid) { const b = basename((p.args.split(" ")[0] ?? "")); return b === me || b === "agentglass"; }
  return false;
}
