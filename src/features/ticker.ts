// agentglass — header marquee: what the live agents and active subagents are doing right now
// SPDX-License-Identifier: Apache-2.0
import { base } from "../util/json.ts";
import { clean, cw, cpOf, fitStyled } from "../util/text.ts";
import type { Sess } from "../model/types.ts";
import { H } from "../hooks.ts";
import { sessions, loadTail, activity, subActive } from "../model/sessions.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";

// the text as cells (char, style, width) so it can be cut at any column without breaking escapes or wide chars
const ch: string[] = []; const st: string[] = []; const cwid: number[] = [];
let content = 0; // visible width without the loop gap
let total = 0; // width of one loop (content + gap)
let off = 0; let step = 0; let slot = 0; let built = false;

function add(style: string, s: string): void {
  for (const c of clean(s)) { const w = cw(cpOf(c)); ch.push(c); st.push(style); cwid.push(w); total += w; }
}
function col(s: Sess): string { return s.h === "claude" ? C.claude : s.h === "codex" ? C.codex : C.fx; }
function glyph(s: Sess): string {
  if (s.parent) return "⑂";
  return s.h === "claude" ? "✻" : s.h === "codex" ? ">_" : "▲";
}
function build(): void {
  built = true;
  const live: Sess[] = [];
  for (const s of sessions.values()) if (s.pid || (s.parent && subActive(s))) live.push(s);
  live.sort((a, b) => b.mtime - a.mtime);
  ch.length = 0; st.length = 0; cwid.length = 0; total = 0;
  for (const s of live.slice(0, 12)) {
    loadTail(s); // no-op unless the log grew
    if (ch.length) add(fg(C.dim), "  ·  ");
    add(fg(col(s)) + CSI + "1m", glyph(s) + " ");
    add(fg(C.text) + CSI + "1m", s.parent ? s.kind || "subagent" : s.name || base(s.cwd) || s.id.slice(0, 8));
    const a = activity(s);
    if (a) add(fg(C.sub), " " + a);
  }
  content = total;
  if (ch.length) add("", "   ·   ");
  if (total) off = off % total;
}

// styled run of up to w columns starting at cell i (wrapping around); a style escape only where it changes
function cells(i: number, w: number): string {
  let out = ""; let n = 0; let cur = "-"; let j = i;
  while (n < w) {
    const c = cwid[j] ?? 0;
    if (n + c > w) { out += " ".repeat(w - n); break; } // wide char cut at the right edge
    const sty = st[j] ?? "";
    if (sty !== cur) { out += RST + sty; cur = sty; }
    out += ch[j] ?? ""; n += c; j = (j + 1) % ch.length;
  }
  return out + RST;
}

H.onTick.push(build);
H.onFastTick.push(() => {
  const n = Math.floor(Date.now() / 150);
  if (n === step) return false;
  step = n;
  if (content <= slot || !total) return false; // fits: static
  off = (off + 1) % total;
  return true;
});
H.headerWidgets.push((w) => {
  if (!built) build();
  slot = w;
  if (w <= 0) return "";
  if (!ch.length) return fitStyled(fg(C.dim) + "no live agents", w);
  if (content <= w) return fitStyled(cells(0, content), content);
  // marquee window [off, off + w) over the looping text
  const len = ch.length;
  let i = 0; let p = 0;
  while (p + (cwid[i] ?? 0) <= off) { p += cwid[i] ?? 0; i = (i + 1) % len; }
  let pad = 0;
  if (p < off) { pad = p + (cwid[i] ?? 0) - off; i = (i + 1) % len; } // wide char cut at the left edge
  return " ".repeat(pad) + cells(i, w - pad);
});
