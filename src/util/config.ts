// agentglass — ~/.agentglass/config.json: settings that are off unless the user opts in (read once at startup)
// SPDX-License-Identifier: Apache-2.0
//   { "prices": { "source": "litellm" | "models.dev", "refreshHours": 24 } }
import { openSync, writeSync, closeSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Obj, obj } from "./json.ts";
import { HOME, readText } from "./fs.ts";

export const CONFIG_FILE = join(HOME, ".agentglass", "config.json");
const root: Obj | null = obj((() => { try { return JSON.parse(readText(CONFIG_FILE, 0, 262144)); } catch (e) { return null; } })());

// a section of the config ({} when absent or not an object)
export function section(name: string): Obj { return (root ? obj(root[name]) : null) ?? {}; }

// merge {[name]: {...old, [key]: value}} into the config file (atomic; other sections and keys stay as they are)
export function setConfig(name: string, key: string, value: string): void {
  const cur = obj((() => { try { return JSON.parse(readText(CONFIG_FILE, 0, 262144)); } catch (e) { return null; } })()) ?? {};
  const sec = obj(cur[name]) ?? {};
  sec[key] = value; cur[name] = sec;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  const tmp = CONFIG_FILE + ".tmp";
  const fd = openSync(tmp, "w"); writeSync(fd, JSON.stringify(cur, null, 2) + "\n"); closeSync(fd);
  renameSync(tmp, CONFIG_FILE);
}
