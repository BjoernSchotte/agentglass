// agentglass — ~/.agentglass/config.json: settings that are off unless the user opts in (read once at startup)
// SPDX-License-Identifier: Apache-2.0
//   { "prices": { "source": "litellm" | "models.dev", "refreshHours": 24 } }
import { join } from "node:path";
import { type Obj, obj } from "./json.ts";
import { HOME, readText } from "./fs.ts";

export const CONFIG_FILE = join(HOME, ".agentglass", "config.json");
const root: Obj | null = obj((() => { try { return JSON.parse(readText(CONFIG_FILE, 0, 262144)); } catch (e) { return null; } })());

// a section of the config ({} when absent or not an object)
export function section(name: string): Obj { return (root ? obj(root[name]) : null) ?? {}; }
