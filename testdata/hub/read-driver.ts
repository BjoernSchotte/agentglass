// agentglass — scripts/hub.test.sh driver: read a hub directory as the viewer's hub source does, one JSON line per host
// SPDX-License-Identifier: Apache-2.0
import { hubSource } from "../../src/features/hub/feed.ts";
const dir = process.argv[2] ?? "";
const src = hubSource("hub", { dir, names: new Map<string, string>(), trust: "", maxAgeDays: 3650, includeNative: false });
for (let i = 0; i < 100; i++) { src.poll(Date.now(), { bytes: 2097152, lines: 2000 }); const hs = src.hosts(); if (hs.length && hs[0] && !hs[0].state.busy) break; }
for (const h of src.hosts()) {
  const r = h.state.report; if (!r) continue;
  const ss: string[] = [];
  for (const s of r.sessions) ss.push("{\"key\":" + JSON.stringify(s.key) + ",\"costUsd\":" + JSON.stringify(s.s["costUsd"]) + ",\"tokens\":" + JSON.stringify(s.s["tokens"]) + ",\"own\":" + String(s.own ? s.own.length : -1) + "}");
  const lv: string[] = []; for (const l of r.live ?? []) lv.push(JSON.stringify({ key: l.key, live: l.live, attention: l.attention, alerts: l.alerts.length }));
  console.log("{\"name\":" + JSON.stringify(h.name) + ",\"hostId\":" + JSON.stringify(h.hostId) + ",\"exact\":" + String(r.exact) + ",\"sessions\":[" + ss.join(",") + "],\"live\":[" + lv.join(",") + "]}");
}
for (const l of src.status()) console.log("status " + l);
