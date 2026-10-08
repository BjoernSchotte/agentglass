// agentglass — agent-wait digests in the background: sessions whose calls file has no digest get one, a slice at a time
// SPDX-License-Identifier: Apache-2.0
// Indexing writes a session's digest with its calls file (digest.ts). Calls files written before digests existed, or
// under other family rules (an upgrade, a config.json "wait" edit), have none: this job works them out once, so the first
// Wait report sums days instead of reading every calls file. TUI only, after the history index is done, while the Wait
// report is not running (it does the same work for its window, with a progress mark); ≤ SLICE ms per tick at the burst
// cadence: well inside the process budget the indexer keeps (ledger.ts PACE, ≤ 20 % of one core). A format-2 calls
// file with a 200-character command (no family hint) sends its session to be indexed again, once (callcache.ts FORMAT).
import { H } from "../../hooks.ts";
import { DEBUG_PARTS } from "../../util/selfmem.ts";
import { TERM } from "../../term.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, unread, indexing, rowsOf, pending, PACE } from "../usage/ledger.ts";
import { packAcc } from "../usage/record.ts";
import { localOf } from "../usage/facts.ts";
import { callCutoff } from "../usage/callcache.ts";
import { releaseTexts } from "./family.ts";
import { type DigJob, digestValid, digestJob, digestStep } from "./digest.ts";

const SLICE = 20;
// todo: the paths left to look at (null: the pass has not started); busy: the Wait report runs (the tab sets it)
// sent: sessions sent to index again, their day maps packed back to text once read (the TUI keeps a session's decoded
// otherwise: a re-read of a thousand logs would stay in memory)
export const BACKFILL = { todo: null as string[] | null, i: 0, job: null as DigJob | null, built: 0, reindex: 0, sent: [] as string[], busy: (): boolean => false, done: false };
function start(): void {
  const cd = localOf(callCutoff()).day; const o: string[] = [];
  for (const [p, s] of sessions) {
    if (s.host || !unread.has(p)) continue;
    const a = ledger.get(p); if (!a || a.off <= 0) continue;
    let keep = false; for (const [k, d] of a.days) if (d.tools > 0 && k >= cd) { keep = true; break; } // calls within retention
    if (keep) o.push(p);
  }
  BACKFILL.todo = o; BACKFILL.i = 0;
}
// the re-read sessions that are through: back to text
function packSent(): void {
  if (!BACKFILL.sent.length) return;
  const o: string[] = [];
  for (const p of BACKFILL.sent) {
    const s = sessions.get(p); const a = ledger.get(p); if (!s || !a) continue;
    if (s.pid <= 0 && !pending(s, a) && a.off > 0) packAcc(a); else o.push(p);
  }
  BACKFILL.sent = o;
}
// one slice: sessions until SLICE ms passed; true when the pass is through
export function backfillStep(budgetMs: number): boolean {
  if (BACKFILL.done) return true;
  if (!BACKFILL.todo) start();
  const todo = BACKFILL.todo ?? []; const until = Date.now() + budgetMs;
  while (BACKFILL.i < todo.length) {
    const p = todo[BACKFILL.i] ?? ""; const s = sessions.get(p); const a = ledger.get(p);
    let j = BACKFILL.job;
    if (!j && s && a && unread.has(p) && !digestValid(p, a.off)) { j = digestJob(p, a); BACKFILL.job = j; }
    if (j) {
      if (ledger.get(p) !== j.a || !unread.has(p)) j = null; // its entry moved meanwhile: the indexer writes it
      else if (!digestStep(j, until)) return false;
      if (j && j.out) BACKFILL.built++;
      else if (j && s) { rowsOf(s); BACKFILL.reindex++; BACKFILL.sent.push(p); } // no readable calls file (or no hints in it): the session indexes again
      BACKFILL.job = null;
    }
    BACKFILL.i++;
    if (Date.now() >= until) return false;
  }
  BACKFILL.done = true; BACKFILL.todo = []; releaseTexts();
  return true;
}
function due(): boolean { return TERM.tui && !BACKFILL.done && !indexing() && !BACKFILL.busy(); }
// the process's own CPU share since the last tick: a slice runs only while the rest of the process leaves room for it
// inside the indexer's budget (ledger.ts PACE.share; a slice per 250 ms tick is ~8 %)
const CPU = { at: 0, ms: 0 };
function room(): boolean {
  const u = process.cpuUsage(); const ms = (u.user + u.system) / 1000; const now = Date.now();
  const ok = CPU.at > 0 && now > CPU.at && (ms - CPU.ms) / (now - CPU.at) < PACE.share - SLICE / PACE.tickMs;
  CPU.at = now; CPU.ms = ms; return ok;
}
H.onTick.push((): void => { packSent(); if (due() && room()) { backfillStep(SLICE); const u = process.cpuUsage(); CPU.ms = (u.user + u.system) / 1000; CPU.at = Date.now(); } });
H.backlog.push(due);
DEBUG_PARTS.push((): string => BACKFILL.todo && (!BACKFILL.done || BACKFILL.built || BACKFILL.reindex) ? "digests " + String(BACKFILL.i) + "/" + String(BACKFILL.todo.length + (BACKFILL.done ? BACKFILL.i : 0)) + " +" + String(BACKFILL.built) + (BACKFILL.reindex ? " reindex " + String(BACKFILL.reindex) : "") : "");
