// agentglass — the fleet read model (local-web-api §2): `agentglass fleet status --json` — per configured host what
// works (last report, error, version, host id, time zone, sessions, live, overlap, live stream) — as fleet.hosts serves
// it. Read-only: the reports cached on disk (the TUI's and the CLI's pulls write them); serve never pulls over ssh and
// never removes a spool file (`fleet --refresh` and the TUI stay the writers).
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../util/json.ts";
import type { Sess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { detachedPid } from "../platform/posix.ts";
import { hostId } from "../util/hostid.ts";
import { loadFleet, fleetOn } from "../features/fleet/config.ts";
import { FLEET, setFleet, reapply, merged, overlap } from "../features/fleet/hosts.ts";
import { type HostStatus, makeFeeds, settle, hostStatus, statusJson } from "../features/fleet/cli.ts";
import { syncHubs } from "../features/hub/fleet.ts";

const F = { init: false, on: false };
function init(): void {
  if (F.init) return; F.init = true;
  const c = loadFleet(); if (!fleetOn(c)) return;
  F.on = true;
  setFleet(c, hostId(), makeFeeds(c, detachedPid, 0)); // the feeds read their spool files; pulls are never started here
}
// configured hosts, enabled or not (meta: the web shows Fleet only with some)
export function fleetHosts(): number { init(); return F.on ? FLEET.hosts.length : 0; }
export function readFleet(now: number): Obj {
  init();
  const c = loadFleet();
  if (!F.on) return { localName: c.localName, hostId: hostId(), hosts: [] };
  syncHubs(now, true); // hub sources: their hosts, read to the end (as fleet status)
  for (const rh of FLEET.hosts) { const st = settle(rh.feed); rh.st = st; if (st.report) { rh.mine = st.report; rh.mineAt = st.okAt; } }
  reapply();
  const loc: Sess[] = []; if (merged().length) for (const s of sessions.values()) if (!s.parent) loc.push(s);
  const ov = overlap(loc, merged());
  const xs: HostStatus[] = []; for (const rh of FLEET.hosts) xs.push(hostStatus(rh, now, ov));
  return statusJson(c, xs);
}
