// agentglass — file reading, directory listing and subprocess helpers
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, openSync, readSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const CLAUDE = join(HOME, ".claude");
export const CODEX = join(HOME, ".codex");
export const FX = join(HOME, ".fx");
// the cache dir (ledger, call rows, projects, price lists): AGENTGLASS_CACHE_DIR keeps test and branch builds off the
// real one; read per call, the env may change after import (checks)
export function cacheDir(): string { const e = process.env["AGENTGLASS_CACHE_DIR"]; return e !== undefined && e ? e : join(HOME, ".agentglass", "cache"); }

export function readBytes(path: string, start: number, len: number): Uint8Array {
  const b = new Uint8Array(len);
  let n = 0;
  try { const fd = openSync(path, "r"); n = readSync(fd, b, 0, len, start); closeSync(fd); } catch (e) { n = 0; }
  return b.subarray(0, n);
}
export function readText(path: string, start: number, len: number): string {
  const b = readBytes(path, start, len);
  return new TextDecoder("utf-8").decode(b);
}
// Complete lines in [start,end). align: skip the partial first line. Returns next unread offset.
export function readLines(path: string, start: number, end: number, align: boolean): { lines: string[]; next: number } {
  const b = readBytes(path, start, end - start);
  let a = 0;
  if (align) { while (a < b.length && b[a] !== 10) a++; a++; }
  let z = b.length - 1;
  while (z >= a && b[z] !== 10) z--;
  if (z < a) return { lines: [], next: align ? start : start };
  const text = new TextDecoder("utf-8").decode(b.subarray(a, z + 1));
  return { lines: text.split("\n"), next: start + z + 1 };
}
export function listDir(p: string): string[] { try { return readdirSync(p); } catch (e) { return []; } }
export function run(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }); } catch (e) { return ""; }
}
