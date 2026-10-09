// agentglass — skills in `agentglass --json` session rows: the skills[] entries ({name, source, n} as before, plus their
// loads, tokens and $) and, behind --fields skillLoads, the session's load timeline (text only with --content)
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import type { Obj } from "../../util/json.ts";
import { type Acc, skillUsesOf } from "../usage/record.ts";
import { type LoadRow, skillLoads, sizeFill } from "./model.ts";
import { skillVis } from "./vis.ts";
import { shownText } from "./text.ts";
import { note } from "./watchvis.ts";

function round(x: number): number { return Math.round(x * 1e6) / 1e6; }
// source command ↔ a user load, model ↔ a model load (re-injections and the listing have no source entry)
function trigOf(source: string): string { return source === "command" ? "user" : "model"; }
// one entry per (name, source) as before; tokens and $ of that source's loads; hidden skills (omit) leave the list
export function skillsJson(as: Acc[]): Obj[] {
  const loads = skillLoads(as, as.map((a: Acc) => ""));
  const out: Obj[] = [];
  for (const u of skillUsesOf(as, null)) {
    const v = skillVis(u.name); note(u.name); if (v.mode === "omit") continue;
    let n = 0; let ld = 0; let cr = 0; let tl = 0; let usd = 0; let cu = 0; let tu = 0; let newest: LoadRow | null = null; let est = false; let unk = false;
    for (const l of loads) {
      if (l.name !== u.name || l.trig !== trigOf(u.source)) continue;
      n += l.n; ld += l.load; cr += l.carry; tl += l.tail; usd += l.usd; cu += l.carryUsd; tu += l.tailUsd;
      if (l.tier === "≈") est = true; if (l.tier === "?") unk = true;
      if (!newest || (l.t >= newest.t && !l.stub) || newest.stub) newest = l; // a re-invocation stub is no version of the text
    }
    const nl = newest as LoadRow | null;
    out.push({ name: v.shown, source: u.source, n: u.n, loads: n, tokens: { load: ld, carry: cr, tail: tl }, costUsd: round(usd), carryUsd: round(cu), tailUsd: round(tu),
      size: nl ? nl.size : null, tier: n === 0 ? null : unk && !est && ld === 0 ? "?" : est || unk ? "≈" : "exact", hash: nl ? nl.hash : null, scope: nl ? nl.scope : null, dir: nl && v.mode === "show" ? nl.dir : null });
  }
  return out;
}
// the session's loads in order (subagents' with their ids); content = --content: each load's text (when not hidden)
export function skillLoadsJson(s: Sess, as: Acc[], ids: string[], content: boolean, find: (id: string) => Sess | null): Obj[] {
  const rows = skillLoads(as, ids); sizeFill(rows);
  const out: Obj[] = [];
  for (const r of rows) {
    const v = skillVis(r.name); if (v.mode === "omit") continue;
    const o: Obj = { name: v.shown, trigger: r.trig, at: r.t > 0 ? new Date(r.t).toISOString() : null, turn: r.turn, bytes: r.bytes, size: r.size, end: r.end > 0 ? new Date(r.end).toISOString() : null, why: r.why || null,
      reloadedAfterCompact: r.rel, requests: r.requests, tokens: { load: r.load, carry: r.carry, tail: r.tail }, costUsd: round(r.usd), tier: r.tier, hash: r.hash, scope: r.scope, dir: v.mode === "show" ? r.dir : "", session: r.sess };
    if (content) { const t = shownText(find(r.sess) ?? s, r.name, r.hash, r.off, r.len, false, false); o["text"] = t.text || null; if (t.why) o["textHidden"] = t.why; }
    out.push(o);
  }
  return out;
}
