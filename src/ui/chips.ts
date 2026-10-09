// agentglass — the event-kind chip bar (K): one line of the families (or one family's kinds) present in the view with
// their counts, the shown ones bright, the hidden ones dim and struck through, the cursor reversed (pure: no state)
// SPDX-License-Identifier: Apache-2.0
import { width, fit } from "../util/text.ts";
import { C, CSI, RST, fg } from "./theme.ts";

export interface Chip { name: string; n: number; on: boolean }
// one line of at most w cells: " kinds ‹ prompt 12 · reply 40 · shell 31 › " — a window around the cursor when it does not
// fit (‹ › mark the chips cut off), the family's name before its kinds when one is open (fam), the inversion as "not"
export function chipLine(chips: Chip[], cur: number, w: number, fam: string, inv: boolean): string {
  const head = (fam ? " " + fam + " ›" : " kinds") + (inv ? " not" : "") + " ";
  const txt: string[] = []; for (const c of chips) txt.push(c.name + " " + String(c.n));
  const sep = " · ";
  const room = Math.max(4, w - width(head) - 4);
  // the window [a, b): grows around the cursor while it fits
  let a = Math.max(0, Math.min(cur, chips.length - 1)); let b = a + 1; let used = chips.length ? width(txt[a] ?? "") : 0;
  for (let grew = true; grew;) {
    grew = false;
    if (b < chips.length && used + width(sep) + width(txt[b] ?? "") <= room) { used += width(sep) + width(txt[b] ?? ""); b++; grew = true; }
    if (a > 0 && used + width(sep) + width(txt[a - 1] ?? "") <= room) { a--; used += width(sep) + width(txt[a] ?? ""); grew = true; }
  }
  let o = fg(C.sub) + CSI + "1m" + head + RST + (a > 0 ? fg(C.dim) + "‹ " + RST : "");
  if (!chips.length) o += fg(C.dim) + "no events" + RST;
  for (let i = a; i < b; i++) {
    const c = chips[i]; const t = txt[i] ?? "";
    const style = (i === cur ? CSI + "7m" : "") + (c.on ? fg(C.text) + CSI + "1m" : fg(C.dim) + CSI + "9m");
    o += (i > a ? fg(C.dim) + sep + RST : "") + style + (width(t) > room ? fit(t, room) : t) + RST;
  }
  if (b < chips.length) o += fg(C.dim) + " ›" + RST;
  return o;
}
