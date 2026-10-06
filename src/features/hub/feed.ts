// agentglass — a hub source as fleet hosts (otlp-hub spec 1–3): one fleet.hosts entry with "otlp" yields every host
// found in its directory. Each poll reads within the tick budget, maps the new lines and returns the hosts whose report
// changed, with display names (spec 2: the hosts map, the receive label, host.name, else <source>-<6 hex>).
// State (spec 3.5): ~/.agentglass/fleet/hub-<source>.state holds the cursors and, per host, its report as a full
// agentglass-snapshot/v1 (fleet's codec) plus the span ids, request ids and native records a report does not carry; a
// restart resumes from it without re-reading. Saved at most every 30 s while lines arrive, and on stop.
// SPDX-License-Identifier: Apache-2.0
import { join, dirname, basename } from "node:path";
import { readWhole } from "../../util/fs.ts";
import { type FeedState, newFeedState } from "../fleet/model.ts";
import type { HubSrcCfg } from "./config.ts";
import { type Source, newSource, readStep, trustOf, saveState, loadState, TICK_BYTES, TICK_LINES } from "./read.ts";
import { type Agg, type Label, type HostExtra, newAgg, ingestLine, reportsOf, prune, extraOf, restoreHost, LINE_NODES } from "./map.ts";
import { type Obj, obj, arr, str } from "../../util/json.ts";
import { newSnap, feedSnap, applySnap, snapLines, fullOf } from "../fleet/snap.ts";
import { randomBytes, hex } from "../../util/rand.ts";

export interface HubHost { name: string; hostId: string; state: FeedState }
export interface HostSource { name: string; poll(now: number, budget: { bytes: number; lines: number }): HubHost[]; hosts(): HubHost[]; busy(): boolean; save(now: number): string; status(): string[]; stop(): void }
export const SAVE_MS = 30000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
// host.name → the fleet name pattern ("" when nothing usable is left)
export function sanitizeName(s: string): string {
  let o = ""; for (const ch of s.toLowerCase().split(".")[0] ?? "") o += /[a-z0-9-]/.test(ch) ? ch : "-";
  while (o.startsWith("-")) o = o.slice(1);
  o = o.slice(0, 16); while (o.endsWith("-")) o = o.slice(0, o.length - 1);
  return NAME_RE.test(o) ? o : "";
}
// reserved: names other fleet hosts already use (a derived name never takes one)
export function hubSource(name: string, cfg: HubSrcCfg, reserved: string[] = []): HostSource {
  const trust = trustOf(cfg.dir, cfg.trust);
  const src: Source = newSource(name, cfg.dir, trust, cfg.maxAgeDays);
  const agg: Agg = newAgg();
  const states = new Map<string, HubHost>(); // agg host key → its fleet host
  const used = new Set<string>(reserved);
  const labels = new Map<string, Label | null>(); // host directory → its label (receive layout)
  // the label of a file in a receive directory: <dir>/<host>/<file>, host id from <dir>/<host>/.host
  const labelOf = (file: string): Label | null => {
    if (trust !== "label") return null;
    const d = dirname(file); if (d === cfg.dir || dirname(d) !== cfg.dir) return null;
    const hit = labels.get(d); if (hit !== undefined) return hit;
    const n = basename(d); let hostId = "";
    const r = readWhole(join(d, ".host"), 4096);
    if (!r.err && !r.missing) { try { const o = JSON.parse(r.text) as Record<string, unknown>; const h = o["hostId"]; if (typeof h === "string") hostId = h as string; } catch (e) { hostId = ""; } }
    const l: Label | null = NAME_RE.test(n) ? { name: n, hostId } : null;
    labels.set(d, l);
    return l;
  };
  const nameFor = (key: string, hostId: string, hostName: string): string => {
    const want = cfg.names.get(hostId) || (trust === "label" ? key : "") || sanitizeName(hostName) || (name + "-" + hostId.slice(0, 6)).slice(0, 16);
    let n = want; let i = 2;
    while (used.has(n)) { const sfx = "-" + String(i++); n = want.slice(0, 16 - sfx.length) + sfx; }
    used.add(n); return n;
  };
  let skipped = 0; // lines from files without a label in a receive directory
  let dirty = false; let savedAt = 0;
  // the state file's body: per host a {"hubhost": …} line, then its report as a full snapshot
  const body = (now: number): string[] => {
    const out: string[] = []; const reps = reportsOf(agg, now, true, cfg.maxAgeDays);
    for (const key of reps.keys()) {
      const rep = reps.get(key); if (!rep) continue;
      const x = extraOf(agg, key); const hh = states.get(key);
      const head: Obj = {}; head["key"] = key; head["name"] = hh ? hh.name : ""; head["seen"] = x.seen; head["req"] = x.req; head["native"] = x.native;
      const w: Obj = {}; w["hubhost"] = head; out.push(JSON.stringify(w));
      for (const l of snapLines(fullOf(rep, hex(randomBytes(8))))) out.push(l);
    }
    return out;
  };
  const restore = (lines: string[]): void => {
    let i = 0;
    while (i < lines.length) {
      let o: Obj | null = null; try { o = obj(JSON.parse(lines[i] ?? "")); } catch (e) { o = null; }
      const head = o ? obj(o["hubhost"]) : null; i++;
      if (!head) continue;
      const grp: string[] = []; while (i < lines.length && (lines[i] ?? "").indexOf("{\"hubhost\":") !== 0) { grp.push(lines[i] ?? ""); i++; }
      const sn = newSnap(); feedSnap(sn, grp); if (!sn.done || sn.err) continue; // an incomplete host: its files are re-read
      const seen: string[][] = []; for (const p of arr(head["seen"])) { const a = arr(p); seen.push([str(a[0]), str(a[1])]); }
      const req: string[] = []; for (const q of arr(head["req"])) req.push(str(q));
      const nat: Obj[] = []; for (const n of arr(head["native"])) { const no = obj(n); if (no) nat.push(no); }
      const x: HostExtra = { seen, req, native: nat };
      const key = str(head["key"]); if (!key) continue;
      restoreHost(agg, key, applySnap(null, sn), x);
      const nm = str(head["name"]); if (nm && !used.has(nm)) { used.add(nm); const hst = { name: nm, hostId: sn.head["hostId"] !== undefined ? str(sn.head["hostId"]) : "", state: newFeedState() }; states.set(key, hst); }
    }
  };
  { const st = loadState(src); if (st) restore(st); else src.cur.clear(); } // no state (or another directory): read from the start
  const save = (now: number): string => { savedAt = now; dirty = false; return saveState(src, body(now)); };
  return {
    name,
    poll(now: number, budget: { bytes: number; lines: number }): HubHost[] {
      const r = readStep(src, Math.min(budget.bytes, TICK_BYTES), Math.min(budget.lines, TICK_LINES), (line: string, file: string) => {
        const l = labelOf(file);
        if (trust === "label" && !l) { skipped++; return; }
        ingestLine(agg, line, l);
      });
      budget.bytes -= r.bytes; budget.lines -= r.lines;
      if (r.lines) { prune(agg); dirty = true; }
      const changed: HubHost[] = [];
      const reps = reportsOf(agg, now, false, cfg.maxAgeDays);
      for (const key of reps.keys()) {
        const rep = reps.get(key); if (!rep) continue;
        let h = states.get(key);
        if (!h) { h = { name: nameFor(key, rep.hello.hostId, rep.hello.hostName), hostId: rep.hello.hostId, state: newFeedState() }; states.set(key, h); }
        // the report's age is its data's: the newest span or heartbeat (a host whose export stopped turns stale)
        const at = rep.hello.now > 0 ? Math.min(now, rep.hello.now) : now;
        h.state.report = rep; h.state.okAt = at; h.state.tryAt = now; h.state.err = ""; h.state.code = "";
        changed.push(h);
      }
      if (dirty && now - savedAt >= SAVE_MS && !src.backlog) save(now); // after the reports above: their change flags are taken
      return changed;
    },
    save,
    busy(): boolean { return src.backlog; },
    hosts(): HubHost[] { const o: HubHost[] = []; for (const h of states.values()) o.push(h); return o; },
    status(): string[] {
      const o: string[] = [];
      for (const p of src.skipped.keys()) o.push(name + ": skipped " + p + " — " + (src.skipped.get(p) ?? ""));
      if (skipped) o.push(name + ": " + String(skipped) + " line(s) outside a host directory ignored (a receive directory keeps one directory per host)");
      if (agg.refused) o.push(name + ": " + String(agg.refused) + " resource(s) dropped: host.id changed under one agentglass.auth.subject");
      if (agg.oversized) o.push(name + ": " + String(agg.oversized) + " line(s) skipped: more than " + String(LINE_NODES) + " JSON values in one line");
      return o;
    },
    stop(): void { if (dirty) save(Date.now()); },
  };
}
