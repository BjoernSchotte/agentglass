// agentglass — harness registry: the adapters agentglass knows, and the lookups everything else goes through
// SPDX-License-Identifier: Apache-2.0
import { parse } from "../util/json.ts";
import type { Ev, Sess } from "../model/types.ts";
import { H, applyMeta } from "../hooks.ts";
import type { HarnessAdapter, SessionSource } from "./types.ts";
import { FILE_SOURCE } from "./source.ts";
import { turnBusy } from "./common.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { fx } from "./fx.ts";
import { pi } from "./pi.ts";
import { opencode } from "./opencode.ts";
import { kiro } from "./kiro.ts";

// order = order in filters, stats rows and help
export const HARNESSES: HarnessAdapter[] = [claude, codex, fx, pi, opencode, kiro];

const byId = new Map<string, HarnessAdapter>();
const byProc = new Map<string, string>();
for (const a of HARNESSES) {
  if (byId.has(a.id)) throw new Error("duplicate harness id " + a.id);
  byId.set(a.id, a);
  for (const p of a.procs) byProc.set(p, a.id);
}

export function harnessOf(id: string): HarnessAdapter {
  const a = byId.get(id);
  if (!a) throw new Error("unknown harness " + id);
  return a;
}
export function sourceOf(h: string): SessionSource { return harnessOf(h).source ?? FILE_SOURCE; }
// a byte budget as a cursor span for this source
export function window(src: SessionSource, bytes: number): number { return Math.max(1, Math.round(bytes / src.unit)); }
export function isHarness(id: string): boolean { return byId.has(id); }
export function harnessIds(): string[] { return HARNESSES.map((a) => a.id); }
export function harnessIndex(id: string): number { for (let i = 0; i < HARNESSES.length; i++) if (HARNESSES[i].id === id) return i; return -1; }
// process basename → harness id ("" = not one of ours)
export function harnessOfProc(name: string): string { return byProc.get(name) ?? ""; }

export function parseEvents(h: string, line: string, out: Ev[], s: Sess | null): void {
  const o = parse(line);
  if (!o) return;
  const n = out.length;
  harnessOf(h).parse(o, out, s);
  if (s) applyMeta(s);
  if (out.length > n) for (const f of H.events) f(s, out, n);
}
export function busy(s: Sess): boolean { const f = harnessOf(s.h).busy; return f ? f(s) : turnBusy(s, false); }
// the user's claude/codex are often shell functions: AGENTGLASS_<ID> overrides the command
export function cmdOf(h: string): string[] {
  const env = process.env["AGENTGLASS_" + h.toUpperCase().replace(/[^A-Z0-9]/g, "_")];
  const cmd: string = env !== undefined ? env : harnessOf(h).bin;
  return cmd.split(" ").filter((x) => x.length > 0);
}
