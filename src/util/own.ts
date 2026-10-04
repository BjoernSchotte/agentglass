// agentglass — exact-size copies of strings that are kept for long (scriptc runtime workaround)
// SPDX-License-Identifier: Apache-2.0
// scriptc 0.1.7 builds some strings in a growable buffer and hands that buffer over as the result: String.replace,
// toLowerCase/toUpperCase, RegExp exec/match/split captures, JSON.parse of a string with an escape, JSON.stringify. The
// buffer starts at the size of the largest such result so far (capped at 64 KB) and is never shrunk, so once one large
// line went through, every short capture kept in a map holds 64 KB. On a long history that was GBs of RSS.
// slice() copies into an exact-size block: call own() where such a string is stored beyond the current line or tick.
export function own(s: string): string { return s.slice(0); }
