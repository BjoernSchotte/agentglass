// agentglass — skill surface fixture: sessions whose ledger entries hold skill loads, built through the record API (no log
// lines), for the checks of the Stats panel, filters, triage, compare, Repos and the timeline views
// SPDX-License-Identifier: Apache-2.0
//   k1 claude /w/app   today 09:00 prompt · 09:01 alpha (user, 1000 tok) · requests · 10:00 prompt (alpha carries as tail)
//                      · 14:00 beta (model) · 14:30 compaction (both out) · 15:00 alpha again (model, reloaded after compaction)
//   k2 codex  /w/app   today 11:00 alpha (model) · requests · the (listing) · 11:30 gamma (user, size unknown)
//   k3 claude /w/other today 12:00 no skills
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, accOf, applyAcc } from "../usage/ledger.ts";
import { type Acc, L, startOfDay, bucket, tokens, turn, skillLoad, skillUnload } from "../usage/record.ts";
import { setVis } from "./vis.ts";

export const SK_TEXT = "LOREMSKILLTEXT" + "x".repeat(3586); // 3600 bytes: 1000 tokens at 3.6
export const SK_M = "claude-sonnet-4-5";
// epoch ms of today hh:mm local
export function at(hh: number, mm: number): number { return startOfDay() + (hh * 60 + mm) * 60000; }
export function isoOf(ms: number): string { return new Date(ms).toISOString(); }
function sess(h: string, id: string, cwd: string): { s: Sess; a: Acc } {
  const s = newSess(h, id, "/fx/" + h + "/" + id + ".jsonl", false);
  s.cwd = cwd; s.model = SK_M; s.size = 1000; s.mtime = Date.now(); s.last = s.mtime;
  sessions.set(s.path, s);
  const a = accOf(s); a.off = s.size;
  return { s, a };
}
function req(a: Acc, ms: number, cr: number, w5: number): void { const iso = isoOf(ms); tokens(a, bucket(a, ms, iso), SK_M, 10, 50, cr, w5, 0); }
export interface SkFx { k1: Sess; k2: Sess; k3: Sess }
export function skFixture(): SkFx {
  sessions.clear(); ledger.clear(); L.ver++; setVis([], false);
  const x1 = sess("claude", "k1", "/w/app"); const a1 = x1.a;
  turn(a1, at(9, 0), isoOf(at(9, 0)), 1);
  req(a1, at(9, 0), 0, 20000);
  skillLoad(a1, "alpha", "user", at(9, 1), isoOf(at(9, 1)), SK_TEXT, true, "/h/.claude/skills/alpha", false);
  req(a1, at(9, 2), 20000, 1500);
  req(a1, at(9, 3), 21500, 100);
  turn(a1, at(10, 0), isoOf(at(10, 0)), 1);
  req(a1, at(10, 1), 21600, 100);
  skillLoad(a1, "beta", "model", at(14, 0), isoOf(at(14, 0)), SK_TEXT, true, "/h/.claude/skills/beta", false);
  req(a1, at(14, 1), 21700, 1200);
  req(a1, at(14, 2), 22900, 100);
  skillUnload(a1, at(14, 30), "compact");
  req(a1, at(14, 31), 0, 5000);
  skillLoad(a1, "alpha", "model", at(15, 0), isoOf(at(15, 0)), SK_TEXT, true, "/h/.claude/skills/alpha", false);
  req(a1, at(15, 1), 5000, 1200);
  req(a1, at(15, 2), 6200, 100);
  applyAcc(x1.s, a1);
  const x2 = sess("codex", "k2", "/w/app"); const a2 = x2.a;
  turn(a2, at(11, 0), isoOf(at(11, 0)), 1);
  req(a2, at(11, 0), 0, 9000);
  skillLoad(a2, "alpha", "model", at(11, 1), isoOf(at(11, 1)), SK_TEXT, true, "/h/.codex/skills/alpha", false);
  req(a2, at(11, 2), 9000, 1500);
  skillLoad(a2, "gamma", "user", at(11, 30), isoOf(at(11, 30)), "", false, "", false);
  req(a2, at(11, 31), 10500, 300);
  applyAcc(x2.s, a2);
  const x3 = sess("claude", "k3", "/w/other");
  turn(x3.a, at(12, 0), isoOf(at(12, 0)), 1); req(x3.a, at(12, 1), 0, 4000); applyAcc(x3.s, x3.a);
  L.ver++;
  return { k1: x1.s, k2: x2.s, k3: x3.s };
}
