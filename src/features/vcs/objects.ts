// agentglass — is a commit in a repo's object DB? Loose objects and pack indexes read directly: no git spawn
// SPDX-License-Identifier: Apache-2.0
// Git linkage asks it for a banner sha that no reflog knows: there, a commit of a removed worktree (counted) and one of
// another repo (a test script's temp repo: elsewhere) look alike; the shared object DB tells them apart.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readBytes, readText } from "../../util/fs.ts";

const memo = new Map<string, number>();
const HX = "0123456789abcdef";
function hex(b: Uint8Array, n: number): string { let s = ""; for (let i = 0; i < n && i < b.length; i++) { const v = b[i] ?? 0; s += HX.charAt(Math.floor(v / 16)) + HX.charAt(v % 16); } return s; }
function u32(b: Uint8Array, i: number): number { return (((b[i] ?? 0) * 256 + (b[i + 1] ?? 0)) * 256 + (b[i + 2] ?? 0)) * 256 + (b[i + 3] ?? 0); }
// a version-2 pack index (8-byte header, 256 fan-out counts, sorted 20-byte names): 1 = an object starts with p,
// 0 = none, -1 = unreadable or another format
export function inIdx(idx: string, p: string): number {
  const h = readBytes(idx, 0, 8 + 1024);
  if (h.length < 8 + 1024 || u32(h, 0) !== 0xff744f63 || u32(h, 4) !== 2) return -1;
  const fb = parseInt(p.slice(0, 2), 16);
  let lo = fb > 0 ? u32(h, 8 + (fb - 1) * 4) : 0; let hi = u32(h, 8 + fb * 4);
  const nb = Math.ceil(p.length / 2);
  while (lo < hi) { // the first name ≥ p
    const mid = Math.floor((lo + hi) / 2);
    const k = hex(readBytes(idx, 8 + 1024 + mid * 20, nb), nb).slice(0, p.length);
    if (k.length < p.length) return -1;
    if (k < p) lo = mid + 1; else hi = mid;
  }
  const n = u32(h, 8 + 255 * 4);
  if (lo >= n) return 0;
  return hex(readBytes(idx, 8 + 1024 + lo * 20, nb), nb).startsWith(p) ? 1 : 0;
}
function inDir(objects: string, p: string, depth: number): number {
  if (!existsSync(objects)) return -1;
  try { for (const f of readdirSync(join(objects, p.slice(0, 2)))) if (f.startsWith(p.slice(2))) return 1; } catch (e) { /* no such fan-out dir */ }
  let unk = false;
  try {
    for (const f of readdirSync(join(objects, "pack"))) {
      if (!f.endsWith(".idx")) continue;
      const r = inIdx(join(objects, "pack", f), p); if (r === 1) return 1; if (r < 0) unk = true;
    }
  } catch (e) { /* no packs */ }
  if (depth < 2) for (const l of readText(join(objects, "info", "alternates"), 0, 65536).split("\n")) { // shared clones
    const a = l.trim(); if (!a || a.startsWith("#")) continue;
    const r = inDir(a.startsWith("/") ? a : join(objects, a), p, depth + 1); if (r === 1) return 1; if (r < 0) unk = true;
  }
  return unk ? -1 : 0;
}
// common = the repo's common git dir; sha = a printed (short, ≥ 7) or full sha. 1 = there, 0 = not there, -1 = cannot tell
export function hasCommit(common: string, sha: string): number {
  const p = sha.toLowerCase();
  if (!common || !/^[0-9a-f]{7,64}$/.test(p)) return -1;
  const k = common + "\t" + p;
  const hit = memo.get(k); if (hit !== undefined) return hit; // objects are immutable; a foreign sha stays foreign
  const r = inDir(join(common, "objects"), p, 0);
  if (memo.size > 4096) memo.clear();
  memo.set(k, r);
  return r;
}
