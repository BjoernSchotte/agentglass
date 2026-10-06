// agentglass — hub sources in the fleet (otlp-hub spec 1, 2): a fleet.hosts entry with "otlp" is a source; every host
// found in its directory becomes a RemoteHost of its own (kind "otlp", path = the source's directory) and takes fleet's
// rows, filter, merge, status and cost from there. The TUI reads within the tick budget (H.onTick), a CLI run drains
// the directory once before it prints.
// SPDX-License-Identifier: Apache-2.0
import { H } from "../../hooks.ts";
import { S } from "../../state.ts";
import { type FeedState, type HostFeed, newFeedState } from "../fleet/model.ts";
import type { HostCfg } from "../fleet/config.ts";
import { FLEET, reapply } from "../fleet/hosts.ts";
import { type HubSrcCfg, HUBS, expandHome } from "./config.ts";
import { type HostSource, type HubHost, hubSource } from "./feed.ts";
import { TICK_BYTES, TICK_LINES } from "./read.ts";

const SRC = new Map<string, HostSource>(); // source entry name → its reader
const OF = new Map<string, HubHost>();     // discovered host name → its live state
// the feed of a source entry: no report of its own; its status line says what the reader skipped
export function hubFeed(h: HostCfg, reserved: string[]): HostFeed {
  const cfg: HubSrcCfg = HUBS.cfg.get(h.name) ?? { dir: expandHome(h.path), names: new Map<string, string>(), trust: "", maxAgeDays: 30, includeNative: false };
  const src = hubSource(h.name, cfg, reserved); SRC.set(h.name, src);
  const st: FeedState = newFeedState();
  return { kind: "otlp", start: (now: number): boolean => false,
    poll: (now: number): FeedState => { const w = src.status(); st.code = w.length ? "skipped" : "ok"; st.err = w.length ? (w[0] ?? "") + (w.length > 1 ? " (+" + String(w.length - 1) + " more: agentglass fleet status --json)" : "") : ""; st.busy = src.busy(); st.okAt = now; st.tryAt = now; return st; },
    stop: (): void => { src.stop(); } };
}
function hostFeed(hh: HubHost): HostFeed { return { kind: "otlp", start: (now: number): boolean => false, poll: (now: number): FeedState => hh.state, stop: (): void => {} }; }
// read the sources (drain: until no backlog, a CLI run), add hosts seen for the first time, apply changed reports
export function syncHubs(now: number, drain: boolean): boolean {
  let changed = false; const budget = { bytes: TICK_BYTES, lines: TICK_LINES };
  const sources: { cfg: HostCfg; src: HostSource }[] = [];
  for (const rh of FLEET.hosts) { const src = SRC.get(rh.cfg.name); if (src && rh.cfg.kind === "otlp" && rh.cfg.enabled) sources.push({ cfg: rh.cfg, src }); }
  for (const x of sources) {
    for (let i = 0; i < (drain ? 100000 : 1); i++) {
      const b = drain ? { bytes: TICK_BYTES, lines: TICK_LINES } : budget;
      for (const hh of x.src.poll(now, b)) { upsert(x.cfg, hh); changed = true; }
      if (!drain || !x.src.busy()) break;
    }
  }
  for (const rh of FLEET.hosts) { const hh = OF.get(rh.cfg.name); if (hh && rh.cfg.kind === "otlp") { rh.st = hh.state; if (hh.state.report && hh.state.report !== rh.report) { rh.report = hh.state.report; rh.okAt = hh.state.okAt; changed = true; } } else if (SRC.has(rh.cfg.name)) rh.st = rh.feed.poll(now); }
  if (changed) reapply();
  return changed;
}
function upsert(src: HostCfg, hh: HubHost): void {
  OF.set(hh.name, hh);
  for (const rh of FLEET.hosts) if (rh.cfg.name === hh.name) return;
  FLEET.hosts.push({ cfg: { name: hh.name, ssh: "", agentglass: "", redact: src.redact, enabled: true, kind: "otlp", path: src.path }, feed: hostFeed(hh), report: null, rows: [], okAt: 0, dupOf: "", alertsSeen: new Set<string>(), fresh: false, st: hh.state, applied: null });
}
H.backlog.push((): boolean => { for (const x of SRC.values()) if (x.busy()) return true; return false; }); // a first read spreads over fast ticks
H.onTick.push((): void => { if (SRC.size && syncHubs(Date.now(), false)) S.dirty = true; });
