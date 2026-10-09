// agentglass — a skill load's text, read from its transcript on demand ("view skill", `skills show`): agentglass never stores
// it (spec Privacy). The load's log lines (SkLoad.off/len, in the source's cursor units) are parsed again by the harness's
// own usage() into a scratch record with capture on; the text whose hash is the load's is the one shown, "" when none is
// (the log was rewritten or cut since)
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import { harnessOf, sourceOf } from "../../harness/index.ts";
import { newAcc } from "../usage/record.ts";
import { SKCAP, type SkCap, skillHash } from "../usage/skillrec.ts";
import { textShown, textHiddenWhy } from "./vis.ts";

const MAX = 16777216; // a load's lines span at most this much of its log
// the raw text, or "" (no place known, nothing matches); no visibility check: callers go through shownText
export function skillText(s: Sess, name: string, hash: string, off: number, len: number): string {
  if (off < 0 || len <= 0 || len > MAX || !hash) return "";
  const src = sourceOf(s.h); const ad = harnessOf(s.h);
  let lines: string[] = [];
  try { lines = src.lines(s, off, off + len).lines; } catch (e) { return ""; }
  const a = newAcc(); a.ro = true; a.sub = s.parent !== "";
  SKCAP.on = true; SKCAP.out = [];
  try { for (const l of lines) ad.usage(a, l); } catch (e) { /* a line this build cannot read: what was captured counts */ }
  const caps: SkCap[] = SKCAP.out; SKCAP.on = false; SKCAP.out = [];
  for (const c of caps) { if (c.name !== name) continue; const t = c.parts.join(""); if (skillHash(t) === hash) return t; }
  return "";
}
// what a surface may print: the text, or why it is not shown (hidden, gone); outward/content as textShown
export function shownText(s: Sess, name: string, hash: string, off: number, len: number, outward: boolean, content: boolean): { text: string; why: string } {
  if (!textShown(name, outward, content)) return { text: "", why: outward && textHiddenWhy(name) === "" ? "text only with --content" : textHiddenWhy(name) };
  const t = skillText(s, name, hash, off, len);
  return t ? { text: t, why: "" } : { text: "", why: off < 0 ? "text not found (no position recorded for this load)" : "text not found (the log changed since)" };
}
