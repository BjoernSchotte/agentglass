// agentglass — json helpers for loosely typed log lines
// SPDX-License-Identifier: Apache-2.0
export type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj | null {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Obj;
  return null;
}
export function str(v: unknown): string { return typeof v === "string" ? v : ""; }
export function arr(v: unknown): unknown[] { return Array.isArray(v) ? (v as unknown[]) : []; }
export function parse(l: string): Obj | null {
  if (l.length < 2 || l.charCodeAt(0) !== 123) return null;
  try { return obj(JSON.parse(l)); } catch (e) { return null; }
}
export function base(p: string): string { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
// the objects and arrays in a JSON text (strings skipped), counting stops past max. A guard before JSON.parse on
// untrusted text: scriptc's parse tree costs ~120 bytes a node, so 64 MB of "{}," would take 2.5 GB
export function jsonNodes(t: string, max: number): number {
  let n = 0; let i = 0; const L = t.length;
  while (i < L) {
    const c = t.charCodeAt(i);
    if (c === 34) { // a string: to the quote not escaped by an odd run of backslashes (each run is counted once)
      let j = t.indexOf("\"", i + 1);
      while (j > 0) { let k = j - 1; let bs = 0; while (k > i && t.charCodeAt(k) === 92) { bs++; k--; } if (bs % 2 === 0) break; j = t.indexOf("\"", j + 1); }
      if (j < 0) return n;
      i = j + 1; continue;
    }
    if (c === 123 || c === 91) { n++; if (n > max) return n; }
    i++;
  }
  return n;
}
