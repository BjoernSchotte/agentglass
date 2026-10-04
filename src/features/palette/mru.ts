// agentglass — the palette's recently chosen items (~/.agentglass/palette.json): ids only, never titles; ≤ 50
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readText } from "../../util/fs.ts";
import { obj, arr } from "../../util/json.ts";

export interface Recent { id: string; at: number }
const MAX = 50;
let recent: Recent[] = []; let dirty = false;
export function mruList(): Recent[] { return recent; }
// read once at start; missing or corrupt → empty
export function mruLoad(path: string): Recent[] {
  const out: Recent[] = [];
  try {
    const o = obj(JSON.parse(readText(path, 0, 65536)));
    for (const x of arr(o ? o["recent"] : null)) {
      const r = obj(x); if (!r) continue;
      const id = r["id"]; const at = r["at"];
      if (typeof id === "string" && typeof at === "number" && out.length < MAX) out.push({ id: id as string, at: at as number });
    }
  } catch (e) { return []; }
  recent = out;
  return out;
}
export function mruTouch(id: string, now: number): void {
  const o: Recent[] = [{ id, at: now }];
  for (const r of recent) if (r.id !== id && o.length < MAX) o.push(r);
  recent = o; dirty = true;
}
// atomic; under --redact nothing is written (a screencast leaves no trace)
export function mruSave(path: string, redact: boolean): void {
  if (redact || !dirty) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    const fd = openSync(tmp, "w"); writeSync(fd, JSON.stringify({ v: 1, recent }) + "\n"); closeSync(fd);
    renameSync(tmp, path); dirty = false;
  } catch (e) { /* best effort: the palette works without it */ }
}
// +20 for an id chosen in the last 24 h, +10 for one chosen earlier
export function mruBoost(id: string, now: number): number { for (const r of recent) if (r.id === id) return now - r.at < 86400000 ? 20 : 10; return 0; }
