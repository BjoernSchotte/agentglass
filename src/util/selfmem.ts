// agentglass — this process's resident memory (debug footer, footprint probes) and extra debug-footer parts
// SPDX-License-Identifier: Apache-2.0
import { readText } from "./fs.ts";

// VmRSS of /proc/self/status (kB, so no page-size guess: arm64 kernels may use 16 or 64 KB pages), in MB; -1 where
// there is no /proc (macOS). A file read, no spawn.
export function selfRssMb(): number {
  const t = readText("/proc/self/status", 0, 8192); const i = t.indexOf("\nVmRSS:"); if (i < 0) return -1;
  const kb = parseInt(t.slice(i + 7, t.indexOf("\n", i + 1)).trim(), 10);
  return kb >= 0 ? Math.round(kb / 1024) : -1;
}
// extra debug-footer segments (AGENTGLASS_DEBUG_REFRESH=1), after `rss`; an empty string adds nothing
export const DEBUG_PARTS: (() => string)[] = [];
export function debugExtras(): string {
  const r = selfRssMb(); const o: string[] = r >= 0 ? ["rss " + String(r) + "M"] : [];
  for (const f of DEBUG_PARTS) { const s = f(); if (s) o.push(s); }
  return o.join(" · ");
}
