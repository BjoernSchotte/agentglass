// agentglass — the alerts read model (local-web-api §2): the log of alert transitions (fire, escalate, deescalate,
// resolve) the rules engine produced in this process, newest first, as alerts.list and the alerts topic serve them.
// serve --stdio runs the rules on its cadence (flagStep) and records each transition here; text fields as the screen
// shows them (--redact fakes titles and projects). The TUI and --watch keep their own notifications.
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import { titleOf } from "../model/sessions.ts";
import { type Obj, base } from "../util/json.ts";
import { screenOut } from "../hooks.ts";

export const ALERTS_MAX = 500;
// rows: oldest first (appended); ver: +1 per recorded transition (the alerts topic rebuilds when it moved); seq: the key
export const AL = { rows: [] as Obj[], ver: 0, seq: 0 };
export interface AlertIn { at: number; rule: string; severity: string; state: string; value: number; threshold: number; unit: string; message: string; labels: Map<string, string> }
export function recordAlert(s: Sess, a: AlertIn): void {
  const l: Obj = {}; for (const [k, v] of a.labels) l[k] = v;
  AL.seq++; AL.ver++;
  AL.rows.push({ key: String(AL.seq), at: new Date(a.at).toISOString(), rule: a.rule, severity: a.severity, state: a.state, value: a.value, threshold: a.threshold, unit: a.unit,
    message: screenOut(a.message), harness: s.h, session: s.id, title: screenOut(titleOf(s)), project: screenOut(base(s.cwd)), labels: l });
  if (AL.rows.length > ALERTS_MAX) AL.rows.splice(0, AL.rows.length - ALERTS_MAX);
}
// newest first; since: ms (0 = all kept), limit: at most this many
export function alertRows(since: number, limit: number): Obj[] {
  const out: Obj[] = [];
  for (let i = AL.rows.length - 1; i >= 0 && out.length < limit; i--) { const r = AL.rows[i] as Obj; if (since > 0 && Date.parse(String(r["at"])) < since) break; out.push(r); }
  return out;
}
