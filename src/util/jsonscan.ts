// agentglass — a small pull reader for JSON of a known shape (numbers, strings, arrays of them, nested number arrays)
// SPDX-License-Identifier: Apache-2.0
// For bulk data read in a long run (call-row files): scriptc 0.1.7's JSON.parse builds the whole tree, and repeated
// parses of files with escaped strings grew the heap by ~85 MB over this host's call rows (fragmentation around the
// growable string buffer, util/own.ts). Reading straight into number[] / string[] avoids the tree. Any deviation from
// the expected shape sets ok = false; callers then treat the input as corrupt.
export interface Cur { s: string; i: number; ok: boolean }
export function cursor(s: string): Cur { return { s, i: 0, ok: true } }
function ws(c: Cur): void {
  const s = c.s; let i = c.i;
  while (i < s.length) { const ch = s.charCodeAt(i); if (ch === 32 || ch === 10 || ch === 13 || ch === 9) i++; else break; }
  c.i = i;
}
// the next non-space char is ch: consume it
export function eat(c: Cur, ch: number): boolean { ws(c); if (c.i < c.s.length && c.s.charCodeAt(c.i) === ch) { c.i++; return true; } return false; }
export function peekIs(c: Cur, ch: number): boolean { ws(c); return c.i < c.s.length && c.s.charCodeAt(c.i) === ch; }
function fail<T>(c: Cur, v: T): T { c.ok = false; return v; }
export function num(c: Cur): number {
  ws(c); const s = c.s; const st = c.i; let i = st;
  // an integer of ≤ 15 digits (call times, durations, ids: nearly every number in these files): its digits summed in
  // place, no slice and no Number() per number
  let j = i; const neg = j < s.length && s.charCodeAt(j) === 45; if (neg) j++;
  const d0 = j; let acc = 0;
  while (j < s.length) { const ch = s.charCodeAt(j); if (ch < 48 || ch > 57) break; acc = acc * 10 + (ch - 48); j++; }
  if (j > d0 && j - d0 <= 15) {
    const ch = j < s.length ? s.charCodeAt(j) : 0;
    if (ch !== 46 && ch !== 101 && ch !== 69 && ch !== 43 && ch !== 45) { c.i = j; return neg ? -acc : acc; }
  }
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if ((ch >= 48 && ch <= 57) || ch === 45 || ch === 43 || ch === 46 || ch === 101 || ch === 69) i++; else break;
  }
  if (i === st) return fail(c, 0);
  const v = Number(s.slice(st, i)); c.i = i;
  return v === v ? v : fail(c, 0); // NaN: not a JSON number
}
const HEX = "0123456789abcdef";
function hex4(s: string, i: number): number {
  let v = 0;
  for (let k = 0; k < 4; k++) { const d = HEX.indexOf(s.charAt(i + k).toLowerCase()); if (d < 0) return -1; v = v * 16 + d; }
  return v;
}
// one code point as text (UTF-8 bytes through the decoder: scriptc 0.1.7 has no String.fromCodePoint); a lone
// surrogate becomes U+FFFD
function cpText(c0: number): string {
  const u = c0 >= 0xd800 && c0 <= 0xdfff ? 0xfffd : c0;
  const b = u < 0x80 ? [u] : u < 0x800 ? [0xc0 | (u >> 6), 0x80 | (u & 63)] : u < 0x10000 ? [0xe0 | (u >> 12), 0x80 | ((u >> 6) & 63), 0x80 | (u & 63)]
    : [0xf0 | (u >> 18), 0x80 | ((u >> 12) & 63), 0x80 | ((u >> 6) & 63), 0x80 | (u & 63)];
  return new TextDecoder("utf-8").decode(new Uint8Array(b));
}
// a string; escapes decoded (\uXXXX surrogate pairs joined). An unescaped string is one exact-size slice.
export function str(c: Cur): string {
  if (!eat(c, 34)) return fail(c, "");
  const s = c.s; let i = c.i; let st = i; const parts: string[] = [];
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 34) { c.i = i + 1; if (!parts.length) return s.slice(st, i); parts.push(s.slice(st, i)); return parts.join(""); }
    if (ch !== 92) { i++; continue; }
    parts.push(s.slice(st, i));
    const e = s.charAt(i + 1);
    if (e === "u") {
      let u = hex4(s, i + 2); if (u < 0) return fail(c, "");
      i += 6;
      if (u >= 0xd800 && u <= 0xdbff && s.charAt(i) === "\\" && s.charAt(i + 1) === "u") {
        const lo = hex4(s, i + 2);
        if (lo >= 0xdc00 && lo <= 0xdfff) { u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00); i += 6; }
      }
      parts.push(cpText(u));
    } else {
      const m = e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "b" ? "\b" : e === "f" ? "\f" : e === "\"" || e === "\\" || e === "/" ? e : "";
      if (!m) return fail(c, "");
      parts.push(m); i += 2;
    }
    st = i;
  }
  return fail(c, "");
}
export function nums(c: Cur): number[] {
  const o: number[] = []; if (!eat(c, 91)) return fail(c, o);
  if (eat(c, 93)) return o;
  for (;;) { o.push(num(c)); if (!c.ok) return o; if (eat(c, 44)) continue; if (eat(c, 93)) return o; return fail(c, o); }
}
export function strs(c: Cur): string[] {
  const o: string[] = []; if (!eat(c, 91)) return fail(c, o);
  if (eat(c, 93)) return o;
  for (;;) { o.push(str(c)); if (!c.ok) return o; if (eat(c, 44)) continue; if (eat(c, 93)) return o; return fail(c, o); }
}
export function numLists(c: Cur): number[][] {
  const o: number[][] = []; if (!eat(c, 91)) return fail(c, o);
  if (eat(c, 93)) return o;
  for (;;) { o.push(nums(c)); if (!c.ok) return o; if (eat(c, 44)) continue; if (eat(c, 93)) return o; return fail(c, o); }
}
// any JSON value, skipped (a member a reader does not know); nested deeper than 64 levels counts as corrupt (no data of
// ours is, and a recursion that deep in a damaged file would overflow the stack)
export function skip(c: Cur): void { skipIn(c, 0); }
function skipIn(c: Cur, depth: number): void {
  ws(c); if (c.i >= c.s.length || depth > 64) { c.ok = false; return; }
  const ch = c.s.charCodeAt(c.i);
  if (ch === 34) { str(c); return; }
  if (ch === 91 || ch === 123) {
    const close = ch === 91 ? 93 : 125; c.i++;
    if (eat(c, close)) return;
    for (;;) {
      if (ch === 123) { str(c); if (!c.ok || !eat(c, 58)) { c.ok = false; return; } }
      skipIn(c, depth + 1); if (!c.ok) return;
      if (eat(c, 44)) continue; if (eat(c, close)) return; c.ok = false; return;
    }
  }
  const s = c.s; let i = c.i;
  for (const w of ["true", "false", "null"]) if (s.startsWith(w, i)) { c.i = i + w.length; return; }
  num(c);
}
