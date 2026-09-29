// agentglass — read-only SQLite through the sqlite3 CLI (a scriptc binary has no native SQLite; OpenCode keeps its sessions in one)
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { type Obj, obj } from "./json.ts";

// the probe result is cached per configured command, so a changed $AGENTGLASS_SQLITE3 is probed again
let binFor = "\u0000"; let bin = "";
export function sqliteBin(): string {
  const env = process.env["AGENTGLASS_SQLITE3"];
  const want = env !== undefined && env.trim() ? env.trim() : "sqlite3";
  if (want === binFor) return bin;
  binFor = want;
  try { execFileSync(want, ["-version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }); bin = want; } catch (e) { bin = ""; }
  return bin;
}
// rows as objects; null = no sqlite3, error, locked past the busy timeout, or the 3 s hard limit
export function query(db: string, sql: string): Obj[] | null {
  const b = sqliteBin();
  if (!b) return null;
  let out = "";
  try {
    out = execFileSync(b, ["-readonly", "-json", "-cmd", ".timeout 2000", db, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 67108864 });
  } catch (e) { return null; }
  if (!out.trim()) return []; // -json prints nothing for an empty result
  try {
    const v: unknown = JSON.parse(out);
    if (!Array.isArray(v)) return null;
    const rows: Obj[] = [];
    for (const x of v as unknown[]) { const o = obj(x); if (o) rows.push(o); }
    return rows;
  } catch (e) { return null; }
}
// SQL string literal
export function q(s: string): string { return "'" + s.replace(/'/g, "''") + "'"; }
