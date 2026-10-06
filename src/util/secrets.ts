// agentglass — the dictionary-free part of the scrubber: e-mail addresses and key-like tokens masked in plain text,
// same length. Shared by --redact (features/redact.ts adds the user's own names on top) and the hub's ingest scrub
// SPDX-License-Identifier: Apache-2.0
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;
function secret(t: string): boolean {
  if (/^(toolu|call|msg|req|resp|fc|srvtoolu)_/.test(t)) return false; // tool-call / message ids: public, and the detail header shows them
  if (/^[0-9a-fA-F]+$/.test(t)) return true;
  return /[0-9]/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t);
}
function isTokCh(c: number): boolean { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 61; }
// runs of ≥ 24 [A-Za-z0-9_+=] that look like keys → • of the same width
// ponytail: a hand scan, not matchAll — scriptc crashed (use-after-free in the cycle collector) on `secret(m[0]) ? mask : m[0]`
export function maskTokens(s: string): string {
  let o = ""; let last = 0; let st = -1;
  for (let i = 0; i <= s.length; i++) {
    if (i < s.length && isTokCh(s.charCodeAt(i))) { if (st < 0) st = i; continue; }
    if (st >= 0 && i - st >= 24) { const tok = s.slice(st, i); if (secret(tok)) { o += s.slice(last, st); o += "•".repeat(i - st); last = i; } }
    st = -1;
  }
  return last > 0 ? o + s.slice(last) : s;
}
// e-mail addresses (letters and digits → x) and key-like runs (→ •), lengths kept
export function scrubSecrets(t: string): string {
  if (t.length < 3) return t;
  let s = t;
  if (s.indexOf("@") >= 0) {
    let o = ""; let last = 0;
    for (const m of s.matchAll(EMAIL)) { const i = m.index ?? 0; const hit = m[0]; o += s.slice(last, i); o += hit.replace(/[A-Za-z0-9]/g, "x"); last = i + hit.length; }
    s = o + s.slice(last);
  }
  if (s.length >= 24) s = maskTokens(s);
  return s;
}
