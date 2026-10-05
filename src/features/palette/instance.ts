// agentglass — single instance, shared by client and server: the setting, and whether a pid is a live agentglass
// SPDX-License-Identifier: Apache-2.0
import { basename } from "node:path";
import { say } from "../../state.ts";
import { section } from "../../util/config.ts";
import { OS } from "../../platform/index.ts";
import { myUid } from "./rundir.ts";

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
// an agentglass process of this user: its program is this binary's name or "agentglass", its owner our uid (a pid
// reused by another program, or by another user's agentglass, is a stale lock: never handed a link, never waited for)
export function holderOf(args: string, owner: number, me: string, uid: number): boolean {
  if (owner !== uid) return false;
  const b = basename(args.split(" ")[0] ?? ""); return b === me || b === "agentglass";
}
export function isOurs(pid: number): boolean {
  const uid = myUid(); if (OS.procOwner(pid) !== uid) return false; // cheap first: one stat, no process table
  const t = new Set<number>(); t.add(pid); // tracked: read fresh, a reused pid is told apart by its start time
  for (const p of OS.listProcs(t)) if (p.pid === pid) return holderOf(p.args, uid, basename(process.execPath), uid);
  return false;
}
