// agentglass — ~/.agentglass/config.json: settings that are off unless the user opts in (read once at startup)
// SPDX-License-Identifier: Apache-2.0
//   { "prices": { "source": "litellm" | "models.dev", "refreshHours": 24 } }
import { openSync, writeSync, closeSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Obj, obj } from "./json.ts";
import { HOME, readText } from "./fs.ts";
import { say } from "../state.ts";

// AGENTGLASS_CONFIG: another config file (test runs must not write the real one)
export const CONFIG_FILE = process.env.AGENTGLASS_CONFIG || join(HOME, ".agentglass", "config.json");
const root: Obj | null = obj((() => { try { return JSON.parse(readText(CONFIG_FILE, 0, 262144)); } catch (e) { return null; } })());

// a section's raw value (undefined when absent): lets a section report a wrong shape
export function rawSection(name: string): unknown { return root ? root[name] : undefined; }
// a section of the config ({} when absent or not an object)
export function section(name: string): Obj { return (root ? obj(root[name]) : null) ?? {}; }

// a top-level value of the config (undefined when absent)
export function topValue(name: string): unknown { return root ? root[name] : undefined; }

// merge {[name]: {...old, [key]: value}} into the config file (atomic; other sections and keys stay as they are)
export function setConfig(name: string, key: string, value: string): void {
  const cur = obj((() => { try { return JSON.parse(readText(CONFIG_FILE, 0, 262144)); } catch (e) { return null; } })()) ?? {};
  const sec = obj(cur[name]) ?? {};
  sec[key] = value; cur[name] = sec;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const tmp = CONFIG_FILE + ".tmp";
  const fd = openSync(tmp, "w"); writeSync(fd, JSON.stringify(cur, null, 2) + "\n"); closeSync(fd);
  try { chmodSync(tmp, 0o600); } catch (e) { /* keep the umask's mode */ } // pinned filters may name repos and paths
  renameSync(tmp, CONFIG_FILE);
}
// an integer in [lo, hi] (hi 0 = no upper bound), else def; pure (checks)
export function intOf(v: unknown, lo: number, hi: number, def: number): number {
  if (typeof v !== "number") return def;
  const n = v as number;
  return Number.isInteger(n) && n >= lo && (hi === 0 || n <= hi) ? n : def;
}
// an integer setting, cached; a present but invalid value → def and one startup toast (a missing key is not invalid)
const ints = new Map<string, number>();
export function intSetting(sec: string, key: string, lo: number, hi: number, def: number): number {
  const k = sec + "." + key; const hit = ints.get(k); if (hit !== undefined) return hit;
  const raw = section(sec)[key]; const v = intOf(raw, lo, hi, def);
  if (raw !== undefined && (typeof raw !== "number" || v !== raw)) say("warn", "config " + k + " must be an integer " + (hi === 0 ? "≥ " + String(lo) : String(lo) + "–" + String(hi)) + " — using " + String(def));
  ints.set(k, v); return v;
}
