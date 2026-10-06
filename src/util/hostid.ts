// agentglass — this machine's identity for fleet reports and OTLP host.id: a hash of the machine id and the uid (two
// users on one machine are two hosts), overridable by ~/.agentglass/host-id (containers built from one image share
// /etc/machine-id); a random id is written there when no machine id can be read
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, renameSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { HOME, readWhole } from "./fs.ts";
import { sha256Hex } from "./sha256.ts";

// checks repoint these; idFile "" = ~/.agentglass/host-id at first use
export const HOSTID = { machineFiles: ["/etc/machine-id", "/var/lib/dbus/machine-id"], idFile: "", ioreg: "ioreg" };
const memo = { id: "", name: "" };
export const HOSTID_TEST = { reset: (): void => { memo.id = ""; memo.name = ""; } };

// the value of `"IOPlatformUUID" = "…"` in `ioreg -rd1 -c IOPlatformExpertDevice` output; "" = absent
export function machineIdFrom(ioregOut: string): string {
  const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioregOut);
  return m ? m[1] ?? "" : "";
}
export function hostIdOf(machineId: string, uid: number): string { return sha256Hex("agentglass/host/v1|" + machineId + "|" + String(uid)).slice(0, 16); }
function idFile(): string { return HOSTID.idFile || join(HOME, ".agentglass", "host-id"); }
function usable(id: string): boolean { return id.length >= 8 && !/^0+$/.test(id); } // an all-zero id is a placeholder (some images)
function machineId(): string {
  for (const f of HOSTID.machineFiles) { const r = readWhole(f, 4096); const t = r.text.trim(); if (!r.err && usable(t)) return t; }
  if (process.platform !== "darwin") return "";
  try { return machineIdFrom(execFileSync(HOSTID.ioreg, ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })); } catch (e) { return ""; }
}
const HEX = "0123456789abcdef";
function randomId(): string { let s = ""; for (let i = 0; i < 16; i++) s += HEX[Math.floor(Math.random() * 16) % 16] ?? "0"; return s; }
// atomic, owner-only (dir 0700, file 0600); false = could not write (the id is then only this process's)
function writeId(path: string, id: string): boolean {
  const old = process.umask(0o077);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = path + ".tmp"; const fd = openSync(tmp, "w"); writeSync(fd, id + "\n"); closeSync(fd); renameSync(tmp, path);
    return true;
  } catch (e) { return false; } finally { process.umask(old); }
}
// cached per process: the host-id file when it holds 16 lowercase hex digits, else the machine id hash, else a random id
// written to the file and used from then on
export function hostId(): string {
  if (memo.id) return memo.id;
  const f = readWhole(idFile(), 256).text.trim();
  if (/^[0-9a-f]{16}$/.test(f)) { memo.id = f; return f; }
  const m = machineId();
  if (m) { memo.id = hostIdOf(m, userInfo().uid); return memo.id; }
  const r = randomId(); writeId(idFile(), r); memo.id = r;
  return r;
}
// `uname -n` up to the first dot, cached; "unknown" when it fails
export function hostName(): string {
  if (memo.name) return memo.name;
  let n = "";
  try { n = execFileSync("uname", ["-n"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim(); } catch (e) { n = ""; }
  const i = n.indexOf(".");
  memo.name = (i > 0 ? n.slice(0, i) : n) || "unknown";
  return memo.name;
}
