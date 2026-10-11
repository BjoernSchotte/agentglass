// agentglass — memory back to the system. scriptc's runtime frees objects for reuse but never returns the pages, so a
// long-running process (serve, the TUI) keeps its peak — a big read (a session's events, a full detail) stays in RSS.
// trimHeap(): malloc_trim / zone relief (platform/trim.c, linked through the always-on FFI manifest
// features/team/crypto/ffi.json); a build without it (a test's plain `scriptc build`) skips it. About 15 ms per 200 MB.
// SPDX-License-Identifier: Apache-2.0
import { selfRssMb } from "../util/selfmem.ts";

declare function agTrim(): number;
// 1 = released pages, 0 = nothing to release, -1 = not linked
export function trimHeap(): number { try { return agTrim(); } catch (e) { return -1; } }
// after work that may have left freed memory: trim when RSS grew GROW_MB since the last trim, at most every GAP_MS
const T = { at: 0, rss: 0 }; const GROW_MB = 16; const GAP_MS = 10000;
export function trimIdle(now: number): boolean {
  if (now - T.at < GAP_MS) return false;
  const r = selfRssMb(); if (r < 0 || (T.rss > 0 && r < T.rss + GROW_MB)) return false;
  trimHeap(); T.at = now; T.rss = selfRssMb();
  return true;
}
// a trim right now (after a known large transient: startup, a sliced read's answer); trimIdle measures from here
export function trimNow(now: number): void { trimHeap(); T.at = now; T.rss = selfRssMb(); }
