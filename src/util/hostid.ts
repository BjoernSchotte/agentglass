// agentglass — the host id: one stable key per machine and user, shared by the fleet view and the OTLP export (fleet spec 3)
// SPDX-License-Identifier: Apache-2.0
// SHA-256 of "agentglass/host/v1|<machine id>|<uid>", 16 hex digits: the machine id never leaves the host, two users on one
// machine are two hosts. ~/.agentglass/host-id (16 hex digits) overrides it, and holds a random id where no machine id
// can be read (containers built from one image share /etc/machine-id: their owners write distinct files).
import { execFileSync } from "node:child_process";
import { openSync, writeSync, closeSync, chmodSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { HOME, readText } from "./fs.ts";
import { sha256Hex } from "./sha256.ts";

// checks repoint these; idFile "" = ~/.agentglass/host-id, resolved at first use
export const HOSTID = { machineFiles: ["/etc/machine-id", "/var/lib/dbus/machine-id"], idFile: "", ioreg: "ioreg" };
let id = ""; let hname = "";
export const HOSTID_TEST = { reset: (): void => { id = ""; hname = ""; } };
const HEX = "0123456789abcdef";

// the IOPlatformUUID line of `ioreg -rd1 -c IOPlatformExpertDevice`, "" if absent
export function machineIdFrom(ioregOut: string): string { const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioregOut); return m ? m[1] ?? "" : ""; }
export function hostIdOf(machineId: string, uid: number): string { return sha256Hex("agentglass/host/v1|" + machineId + "|" + String(uid)).slice(0, 16); }
function idFile(): string { return HOSTID.idFile || join(HOME, ".agentglass", "host-id"); }
function uid(): number { try { const u = Number(execFileSync("id", ["-u"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); return u >= 0 ? u : -1; } catch (e) { return -1; } }
function machineId(): string {
  for (const f of HOSTID.machineFiles) { const v = readText(f, 0, 256).trim(); if (v && !/^0+$/.test(v)) return v; }
  if (process.platform !== "darwin") return "";
  try { return machineIdFrom(execFileSync(HOSTID.ioreg, ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })); } catch (e) { return ""; }
}
function randomId(): string { let s = ""; for (let i = 0; i < 16; i++) s += HEX[Math.floor(Math.random() * 16) % 16] ?? "0"; return s; }
// atomic: a reader never sees a half-written id (dir 0700, file 0600)
function writeId(p: string, v: string): void {
  const tmp = p + ".tmp-" + String(process.pid);
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "w"); chmodSync(tmp, 0o600);
    try { writeSync(fd, v + "\n"); } finally { closeSync(fd); }
    renameSync(tmp, p);
  } catch (e) { try { unlinkSync(tmp); } catch (e2) { /* not written */ } }
}
// cached per process
export function hostId(): string {
  if (id) return id;
  const f = idFile(); const o = readText(f, 0, 64).trim();
  if (/^[0-9a-f]{16}$/.test(o)) { id = o; return id; }
  const m = machineId(); const u = uid();
  if (m && u >= 0) { id = hostIdOf(m, u); return id; }
  id = randomId(); writeId(f, id);
  return id;
}
// `uname -n` up to the first dot, "unknown" on failure (fleet; the OTLP exporter keeps the full name for host.name)
export function hostName(): string {
  if (hname) return hname;
  try { hname = execFileSync("uname", ["-n"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(".")[0] ?? ""; } catch (e) { hname = ""; }
  if (!hname) hname = "unknown";
  return hname;
}
