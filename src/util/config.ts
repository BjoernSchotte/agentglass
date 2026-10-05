// agentglass — ~/.agentglass/config.json: settings that are off unless the user opts in (read once at startup)
// SPDX-License-Identifier: Apache-2.0
//   { "prices": { "source": "litellm" | "models.dev", "refreshHours": 24 } }
import { openSync, writeSync, closeSync, renameSync, mkdirSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Obj, obj } from "./json.ts";
import { HOME, readWhole } from "./fs.ts";
import { S, say } from "../state.ts";

// AGENTGLASS_CONFIG: another config file (test runs must not write the real one)
export const CONFIG_FILE = process.env.AGENTGLASS_CONFIG || join(HOME, ".agentglass", "config.json");
const MAX = 262144;
// pure (checks): the file's text → its object, or why it is unusable ("" = fine; a missing or blank file is fine)
export function parseConfig(text: string): { root: Obj | null; bad: string } {
  if (!text.trim()) return { root: null, bad: "" };
  try { const o = obj(JSON.parse(text)); return o ? { root: o, bad: "" } : { root: null, bad: "not a JSON object" }; }
  catch (e) { return { root: null, bad: e instanceof Error ? e.message : String(e) }; }
}
// the file → its object, or why it is unusable ("cannot be read (…)": a directory, no permission, too large; "is not valid JSON (…)")
function load(path: string): { root: Obj | null; bad: string } {
  const r = readWhole(path, MAX); if (r.err) return { root: null, bad: "cannot be read (" + r.err + ")" };
  const p = parseConfig(r.text); return p.bad ? { root: null, bad: "is not valid JSON (" + p.bad + ")" } : p;
}
const parsed = load(CONFIG_FILE);
// a broken file is ignored with one warning: the TUI toasts configProblem() at start; a CLI command prints it on stderr
// at its first read (sections are also read at startup, before S.cli is known)
export function configProblem(): string { return parsed.bad ? "config " + CONFIG_FILE + " " + parsed.bad + " — ignored, defaults in force" : ""; }
let told = false;
function cfg(): Obj | null {
  if (parsed.bad && !told && S.cli) { told = true; say("warn", configProblem()); }
  return parsed.root;
}

// a section's raw value (undefined when absent): lets a section report a wrong shape
export function rawSection(name: string): unknown { const r = cfg(); return r ? r[name] : undefined; }
// a section of the config ({} when absent or not an object)
export function section(name: string): Obj { const r = cfg(); return (r ? obj(r[name]) : null) ?? {}; }

// a top-level value of the config (undefined when absent)
export function topValue(name: string): unknown { const r = cfg(); return r ? r[name] : undefined; }

// pure (checks): text with {[name]: {...old, [key]: value}} merged in; null = the text is not a JSON object (never replaced)
export function mergeConfig(text: string, name: string, key: string, value: string): string | null {
  const p = parseConfig(text); if (p.bad) return null;
  const cur = p.root ?? {};
  const sec = obj(cur[name]) ?? {};
  sec[key] = value; cur[name] = sec;
  return JSON.stringify(cur, null, 2) + "\n";
}
// edit a JSON object file in place (atomic; keys the edit does not touch stay as they are): re-read right before writing,
// a missing or blank file is {}; throws, leaving the file as it is, when it cannot be read or is not a JSON object.
// Pretty-printed (2 spaces) + newline, mode 0600. A symlink (dotfile managers) is written through: the link stays a link.
export function writeJsonAt(path: string, edit: (root: Obj) => void): void {
  const r = readWhole(path, MAX);
  if (r.err) throw new Error("cannot read " + path + " (" + r.err + ") — it was left as it is");
  const p = parseConfig(r.text);
  if (p.bad) throw new Error(path + " is not valid JSON (" + p.bad + ") — fix it first (it was left as it is)");
  const root = p.root ?? {};
  edit(root);
  const real = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(real), { recursive: true });
  const tmp = real + ".tmp";
  const fd = openSync(tmp, "w"); writeSync(fd, JSON.stringify(root, null, 2) + "\n"); closeSync(fd);
  try { chmodSync(tmp, 0o600); } catch (e) { /* keep the umask's mode */ } // pinned filters may name repos and paths
  renameSync(tmp, real);
}
// merge {[name]: {...old, [key]: value}} into a config file (writeJsonAt's rules)
export function writeConfigAt(path: string, name: string, key: string, value: string): void {
  writeJsonAt(path, (cur: Obj): void => { const sec = obj(cur[name]) ?? {}; sec[key] = value; cur[name] = sec; });
}
export function setConfig(name: string, key: string, value: string): void { writeConfigAt(CONFIG_FILE, name, key, value); }
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
