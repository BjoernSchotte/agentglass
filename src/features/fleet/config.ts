// agentglass — the "fleet" section of ~/.agentglass/config.json (fleet spec section 2): the hosts and the cadence
// SPDX-License-Identifier: Apache-2.0
//   {"fleet": {"hosts": [{"name", "ssh" | "dir" | "otlp", "agentglass", "redact", "enabled"}], "localName", "refreshSeconds", "days", "timeoutSeconds"}}
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { rawSection } from "../../util/config.ts";

// kind: "ssh" (pulled here), "dir" / "otlp" (later transports: kept, disabled), "" never stored
export interface HostCfg { name: string; ssh: string; agentglass: string; redact: boolean; enabled: boolean; kind: string; path: string }
export interface FleetCfg { hosts: HostCfg[]; localName: string; refreshS: number; days: number; timeoutS: number; warns: string[] }
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
// an ssh destination: an alias or [user@]host[:port-less]; never an option (a leading "-" would be one)
const SSH_RE = /^[A-Za-z0-9._%+@:\[\]-]{1,255}$/;
const BIN_RE = /^(~\/)?[A-Za-z0-9._\/+-]{1,255}$/;
export const MAX_HOSTS = 32;
const TRANSPORTS = ["ssh", "dir", "otlp"];

function int(o: Obj, k: string, lo: number, hi: number, d: number, w: string[]): number {
  const v = o[k]; if (v === undefined) return d;
  if (typeof v === "number" && Number.isInteger(v as number) && (v as number) >= lo && (v as number) <= hi) return v as number;
  w.push("fleet." + k + " must be an integer " + String(lo) + "–" + String(hi) + " — using " + String(d)); return d;
}
function bool(o: Obj, k: string, d: boolean, who: string, w: string[]): boolean {
  const v = o[k]; if (v === undefined) return d;
  if (typeof v === "boolean") return v as boolean;
  w.push(who + ": " + k + " must be true or false — using " + String(d)); return d;
}
// one entry → a host, or null with a warning (who: "fleet host <name>" or "fleet.hosts[i]")
function hostOf(v: unknown, i: number, localName: string, seen: Set<string>, w: string[]): HostCfg | null {
  const o = obj(v);
  if (!o) { w.push("fleet.hosts[" + String(i) + "] must be an object — skipped"); return null; }
  const name = str(o["name"]);
  const who = name ? "fleet host " + name : "fleet.hosts[" + String(i) + "]";
  if (!NAME_RE.test(name)) { w.push(who + ": name must be 1–16 of a-z 0-9 - (starting with a letter or digit) — skipped"); return null; }
  if (name === localName) { w.push(who + ": name equals fleet.localName — skipped"); return null; }
  if (seen.has(name)) { w.push(who + ": duplicate name — skipped"); return null; }
  const ts: string[] = []; for (const t of TRANSPORTS) if (o[t] !== undefined) ts.push(t);
  if (ts.length !== 1) { w.push(who + ": needs exactly one of ssh, dir, otlp" + (ts.length ? " (has " + ts.join(", ") + ")" : "") + " — skipped"); return null; }
  const kind = ts[0] ?? "";
  const redact = bool(o, "redact", false, who, w); const enabled = bool(o, "enabled", true, who, w);
  if (kind !== "ssh") {
    const p = str(o[kind]);
    if (!p) { w.push(who + ": " + kind + " must be a directory path — skipped"); return null; }
    w.push(who + ": transport " + kind + " needs a newer agentglass — kept, not pulled");
    seen.add(name);
    return { name, ssh: "", agentglass: "", redact, enabled: false, kind, path: p };
  }
  const ssh = str(o["ssh"]);
  if (ssh.startsWith("-")) { w.push(who + ": ssh must not start with - (it would be an ssh option) — skipped"); return null; }
  if (!SSH_RE.test(ssh)) { w.push(who + ": ssh must be an alias or [user@]host (letters, digits, . _ % + @ : [ ] -) — skipped"); return null; }
  const bin = o["agentglass"] === undefined ? "agentglass" : str(o["agentglass"]);
  if (!BIN_RE.test(bin)) { w.push(who + ": agentglass must be a path of letters, digits, . _ / + - (optionally starting with ~/) — skipped"); return null; }
  seen.add(name);
  return { name, ssh, agentglass: bin, redact, enabled, kind, path: "" };
}
// the section as given (any shape): valid hosts, defaults for what is missing or wrong, one warning per problem
export function fleetFrom(raw: unknown): FleetCfg {
  const w: string[] = [];
  let o = obj(raw);
  if (raw !== undefined && !o) { w.push("fleet in ~/.agentglass/config.json must be an object — using defaults"); o = null; }
  const s: Obj = o ?? {};
  let localName = "local";
  if (s["localName"] !== undefined) { const l = str(s["localName"]); if (NAME_RE.test(l)) localName = l; else w.push("fleet.localName must be 1–16 of a-z 0-9 - — using local"); }
  const hosts: HostCfg[] = []; const seen = new Set<string>();
  if (s["hosts"] !== undefined && !Array.isArray(s["hosts"])) w.push("fleet.hosts must be an array — no hosts");
  const list = arr(s["hosts"]);
  for (let i = 0; i < list.length; i++) {
    const h = hostOf(list[i], i, localName, seen, w);
    if (!h) continue;
    if (hosts.length >= MAX_HOSTS) { w.push("fleet.hosts: at most " + String(MAX_HOSTS) + " hosts — the rest are ignored"); break; }
    hosts.push(h);
  }
  return { hosts, localName, refreshS: int(s, "refreshSeconds", 15, 3600, 60, w), days: int(s, "days", 1, 90, 7, w), timeoutS: int(s, "timeoutSeconds", 10, 600, 90, w), warns: w };
}
let loaded: FleetCfg | null = null;
export function loadFleet(): FleetCfg { if (!loaded) loaded = fleetFrom(rawSection("fleet")); return loaded; }
export const FLEET_TEST = { set: (c: FleetCfg | null): void => { loaded = c; } };
// this run skips the fleet: --no-fleet or AGENTGLASS_FLEET=0
export function fleetOff(): boolean { return process.argv.indexOf("--no-fleet") >= 0 || process.env["AGENTGLASS_FLEET"] === "0"; }
// an enabled ssh host exists and this run does not skip the fleet
export function fleetOn(c: FleetCfg): boolean {
  if (fleetOff()) return false;
  for (const h of c.hosts) if (h.enabled && h.kind === "ssh") return true;
  return false;
}
export function hostNamed(c: FleetCfg, name: string): HostCfg | null { for (const h of c.hosts) if (h.name === name) return h; return null; }
