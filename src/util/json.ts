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
