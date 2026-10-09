// agentglass — skills over the fleet (skill-usage spec 6.15): one table row per (skill, host) for the Stats skills panel's
// host column. This machine's ledger plus every exact host's merge entries (fleet/merge.ts: copies of a log another host
// owns are taken out of the losing side, skills included); a host without day rows (fleet pull, Part A) adds its
// sessions' skills[] entries (their $ as the host priced them: tier ≈). fleet/tui.ts fills the hook; the panel reads it
// SPDX-License-Identifier: Apache-2.0
import type { Acc } from "../usage/record.ts";
import { type Obj, obj, arr, str } from "../../util/json.ts";
import { type SkillRow, skillTable, sortRows, visRows } from "./model.ts";
import type { HostHash } from "./advise.ts";

export interface HostRow { host: string; row: SkillRow }
// on: more than this machine is shown; rows: every host's rows for the local days (null = all), sorted by `by` within a host
// local: this machine's host name; hashes: every host's skill versions (A10 in the panel's advice)
export const SKILL_FLEET = { on: (): boolean => false, rows: (days: string[] | null, by: string): HostRow[] => [], local: (): string => "", hashes: (): HostHash[] => [] };

// one host's entries: Accs with their session ids (copies and subagents share their session's id), or (Part A) the
// --json session objects whose skills[] entries are summed
// info: sessions whose skills[] only fill in what a merge entry cannot know (size, versions, scope: it has no load records)
export interface HostSet { host: string; accs: Acc[]; ids: string[]; sess: Obj[]; info: Obj[] }
function num(v: unknown): number { return typeof v === "number" ? v as number : 0; }
// Part A: per name over the sessions' skills[] entries (each already hidden/faked as its host shows it)
function fromJson(ss: Obj[]): SkillRow[] {
  const m = new Map<string, SkillRow>(); const seen = new Set<string>();
  for (const s of ss) for (const v of arr(s["skills"])) {
    const e = obj(v); if (!e) continue;
    const name = str(e["name"]); if (!name) continue;
    let r = m.get(name);
    if (!r) { r = { name, loadsUser: 0, loadsModel: 0, loadsCompact: 0, sessions: 0, sizeP50: -1, load: 0, carry: 0, tail: 0, usd: 0, carryUsd: 0, tailUsd: 0, perSess: 0, share: 0, ctx: 0, tier: "≈", hashes: [], scope: "?", unpriced: false }; m.set(name, r); }
    const k = name + "\t" + str(s["harness"]) + ":" + str(s["id"]); if (!seen.has(k)) { seen.add(k); r.sessions++; }
    const n = num(e["loads"]) || num(e["n"]);
    if (str(e["source"]) === "command") r.loadsUser += n; else r.loadsModel += n;
    const t = obj(e["tokens"]); if (t) { r.load += num(t["load"]); r.carry += num(t["carry"]); r.tail += num(t["tail"]); }
    if (e["costUsd"] === null || e["costUsd"] === undefined) r.unpriced = true;
    r.usd += num(e["costUsd"]); r.carryUsd += num(e["carryUsd"]); r.tailUsd += num(e["tailUsd"]);
    if (typeof e["size"] === "number" && num(e["size"]) > r.sizeP50) r.sizeP50 = num(e["size"]); // none sent: stays -1 (?)
    const h = str(e["hash"]); if (h && r.hashes.indexOf(h) < 0) r.hashes.push(h);
    if (str(e["scope"])) r.scope = str(e["scope"]);
  }
  const out: SkillRow[] = [];
  for (const r of m.values()) { r.perSess = r.sessions > 0 ? r.usd / r.sessions : 0; if (r.unpriced && r.usd === 0) r.tier = "?"; out.push(r); } // no $ sent (a hub-fed host): $ ?
  return out;
}
// the rows of every host: each host's table (this machine's names through skillVis; a remote host's names as it sent
// them, then this machine's hiding on top), sorted by `by` within the host, hosts in the given order
export function hostRows(sets: HostSet[], days: string[] | null, by: string): HostRow[] {
  const out: HostRow[] = [];
  for (const hs of sets) {
    let rows = hs.accs.length ? skillTable(hs.accs, hs.ids, days, by) : [];
    // (a size -1 from a host that sent none stays unknown: ?)
    if (hs.info.length && rows.length) { const ref = fromJson(hs.info); for (const r of rows) { if (r.sizeP50 > 0 || r.hashes.length) continue; for (const x of ref) if (x.name === r.name) { r.sizeP50 = x.sizeP50; r.hashes = x.hashes; r.scope = x.scope; } } }
    if (hs.sess.length) rows = sortRows(rows.concat(fromJson(hs.sess)), by);
    for (const r of visRows(rows).rows) {
      if (r.loadsUser + r.loadsModel + r.loadsCompact <= 0 && Math.abs(r.load + r.carry) < 0.5 && Math.abs(r.usd) < 1e-9) continue; // all of it went to another host's copy
      out.push({ host: hs.host, row: r });
    }
  }
  return out;
}
