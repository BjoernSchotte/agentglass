// agentglass — `agentglass fleet watch` (fleet spec 16): the host's live state for a viewer, as JSON lines: hello once,
// a session's state when it changes (and every 300 s while live), rules transitions, turn ends, a beat every 30 s.
// State, alerts and beats only: no event content leaves the host (Decision 23)
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { S } from "../../state.ts";
import { cliError } from "../agentenv.ts";
import { sessions, working } from "../../model/sessions.ts";
import type { Sess } from "../../model/types.ts";
import { type SState, sessState, sameState } from "../../model/state.ts";
import { BUILD } from "../../build-info.ts";
import { hostId, hostName } from "../../util/hostid.ts";
import { type Obj } from "../../util/json.ts";
import { REDACT } from "../redact-on.ts";
import { opts, watch } from "../cli.ts";
import { approvalOf } from "../watchdog.ts";
import type { AlertT } from "../otlp/logs.ts";
import { pricesSig } from "../usage/pricing.ts";
import { FORMAT } from "./model.ts";

export const BEAT_MS = 30000; export const REPEAT_MS = 300000;
// what the stream has said per session key: the state, when, whether it was mid-turn
export interface WState { st: Map<string, SState>; at: Map<string, number>; beat: number }
export function newWState(): WState { return { st: new Map<string, SState>(), at: new Map<string, number>(), beat: 0 }; }
function liveObj(key: string, s: SState, now: number): Obj { return { key, at: now, live: s.live, busy: s.busy, attention: s.attention, approval: s.approval, stuck: s.stuck, alerts: [] }; }
// one poll's lines (pure: the checks drive it with stub states and a fake clock). rows: every top-level session that is
// live or was live in the last line sent; a session that leaves the list is sent once as not live
export function watchLines(w: WState, rows: { key: string; st: SState }[], now: number): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.key);
    const prev = w.st.get(r.key); const at = w.at.get(r.key) ?? 0;
    const due = prev ? !sameState(prev, r.st) || (r.st.live && now - at >= REPEAT_MS) : r.st.live;
    if (prev && prev.busy && !r.st.busy) out.push(JSON.stringify({ turn: { key: r.key, done: true, at: now } })); // a turn closed: costs moved
    if (due) { out.push(JSON.stringify({ live: liveObj(r.key, r.st, now) })); w.at.set(r.key, now); }
    w.st.set(r.key, r.st);
  }
  for (const [k, prev] of [...w.st.entries()]) {
    if (seen.has(k)) continue;
    w.st.delete(k); w.at.delete(k);
    if (prev.live) out.push(JSON.stringify({ live: liveObj(k, { live: false, busy: false, attention: false, approval: false, stuck: "" }, now) }));
  }
  if (now - w.beat >= BEAT_MS) { w.beat = now; out.push(JSON.stringify({ beat: now })); }
  return out;
}
export function alertLine(key: string, a: AlertT, at: number): string {
  const labels: Obj = {}; for (const l of a.labels) labels[l[0] ?? ""] = l[1] ?? "";
  return JSON.stringify({ alert: { key, rule: a.rule, severity: a.severity, state: a.state, value: a.value, threshold: a.threshold, labels, message: a.message, at } });
}
function keyOf(s: Sess): string { return s.h + ":" + s.id; }
function emit(l: string): void { try { writeSync(1, l + "\n"); } catch (e) { process.exit(0); } } // the viewer went away: done

// `fleet watch [--redact]`: the --watch poll loop's process and rules parts (no event reading), a sink that turns each
// poll into state lines
export function watchCli(args: string[]): void {
  for (let i = 2; i < args.length; i++) { const a = args[i] ?? ""; if (a !== "--redact" && a !== "--agent" && a !== "--no-agent") cliError("usage", "unknown option " + a + " for fleet watch", "agentglass fleet watch [--redact]", 2); }
  S.cli = true;
  const now0 = Date.now();
  emit(JSON.stringify({ hello: { format: FORMAT, version: BUILD.version, hostId: hostId(), hostName: REDACT ? "" : hostName(), os: process.platform, tzOffsetMin: -new Date(now0).getTimezoneOffset(), redact: REDACT, days: 0, now: now0, priceSig: pricesSig() } }));
  const w = newWState(); let last = 0;
  const o = opts(["--watch"]); o.forMs = 0; o.idle = false; o.jsonl = false; o.alerts = true;
  o.every = [20, 6, 20]; // new session files and process facts every 10 s, processes and rules every 3 s: ≤ 1 % of a core on a host with 39 live sessions (spec 16.4; measured 1.7 % at the --watch cadence)
  watch(o, {
    tick: (t: number): void => {
      if (t - last < 1000) return; // the loop polls every 500 ms; state once a second is enough for a viewer
      last = t;
      const rows: { key: string; st: SState }[] = [];
      for (const s of sessions.values()) {
        if (s.parent) continue;
        const k = keyOf(s);
        if (!s.pid && !w.st.has(k)) continue;
        rows.push({ key: k, st: sessState(s, approvalOf, working) });
      }
      for (const l of watchLines(w, rows, t)) emit(l);
    },
    stop: (): void => {},
    alert: (s: Sess, a: AlertT): void => { if (!s.parent) emit(alertLine(keyOf(s), a, Date.now())); },
  });
}
