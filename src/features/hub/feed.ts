// agentglass — a hub source as fleet hosts (otlp-hub spec 1–3): one fleet.hosts entry with "otlp" yields every host
// found in its directory. Each poll reads within the tick budget, maps the new lines and returns the hosts whose report
// changed, with display names (spec 2: the hosts map, the receive label, host.name, else <source>-<6 hex>).
// fleet's hosts.ts consumes this as a multi-host feed (kind "otlp"); until fleet's snapshot codec lands (fleet Part B)
// the source keeps no state file and re-reads its directory on start (bounded by maxAgeDays and the tick budget).
// SPDX-License-Identifier: Apache-2.0
import { join, dirname, basename } from "node:path";
import { readWhole } from "../../util/fs.ts";
import { type FeedState, newFeedState } from "../fleet/model.ts";
import type { HubSrcCfg } from "./config.ts";
import { type Source, newSource, readStep, trustOf, TICK_BYTES, TICK_LINES } from "./read.ts";
import { type Agg, type Label, newAgg, ingestLine, reportsOf, prune } from "./map.ts";

export interface HubHost { name: string; hostId: string; state: FeedState }
export interface HostSource { name: string; poll(now: number, budget: { bytes: number; lines: number }): HubHost[]; hosts(): HubHost[]; status(): string[]; stop(): void }
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
// host.name → the fleet name pattern ("" when nothing usable is left)
export function sanitizeName(s: string): string {
  let o = ""; for (const ch of s.toLowerCase().split(".")[0] ?? "") o += /[a-z0-9-]/.test(ch) ? ch : "-";
  while (o.startsWith("-")) o = o.slice(1);
  o = o.slice(0, 16); while (o.endsWith("-")) o = o.slice(0, o.length - 1);
  return NAME_RE.test(o) ? o : "";
}
export function hubSource(name: string, cfg: HubSrcCfg): HostSource {
  const trust = trustOf(cfg.dir, cfg.trust);
  const src: Source = newSource(name, cfg.dir, trust, cfg.maxAgeDays);
  const agg: Agg = newAgg();
  const states = new Map<string, HubHost>(); // agg host key → its fleet host
  const used = new Set<string>();
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
  return {
    name,
    poll(now: number, budget: { bytes: number; lines: number }): HubHost[] {
      const r = readStep(src, Math.min(budget.bytes, TICK_BYTES), Math.min(budget.lines, TICK_LINES), (line: string, file: string) => {
        const l = labelOf(file);
        if (trust === "label" && !l) { skipped++; return; }
        ingestLine(agg, line, l);
      });
      budget.bytes -= r.bytes; budget.lines -= r.lines;
      if (r.lines) prune(agg);
      const changed: HubHost[] = [];
      const reps = reportsOf(agg, now, false, cfg.maxAgeDays);
      for (const key of reps.keys()) {
        const rep = reps.get(key); if (!rep) continue;
        let h = states.get(key);
        if (!h) { h = { name: nameFor(key, rep.hello.hostId, rep.hello.hostName), hostId: rep.hello.hostId, state: newFeedState() }; states.set(key, h); }
        h.state.report = rep; h.state.okAt = now; h.state.tryAt = now; h.state.err = ""; h.state.code = "";
        changed.push(h);
      }
      for (const h of states.values()) h.state.busy = src.backlog; // the indexing gauge while a backlog is read
      return changed;
    },
    hosts(): HubHost[] { const o: HubHost[] = []; for (const h of states.values()) o.push(h); return o; },
    status(): string[] {
      const o: string[] = [];
      for (const p of src.skipped.keys()) o.push(name + ": skipped " + p + " — " + (src.skipped.get(p) ?? ""));
      if (skipped) o.push(name + ": " + String(skipped) + " line(s) outside a host directory ignored (a receive directory keeps one directory per host)");
      if (agg.refused) o.push(name + ": " + String(agg.refused) + " resource(s) dropped: host.id changed under one agentglass.auth.subject");
      return o;
    },
    stop(): void { /* nothing spawned */ },
  };
}
