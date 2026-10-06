// agentglass — OTLP logs stream of `--watch --otlp` (otlp-complete 2): host heartbeat, session state, turn.open, alerts.
// What a receiver needs for "now" (liveness, running turns, alarms); best effort, never marked in the state file.
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import { type SState } from "../../model/state.ts";
import { titleOf } from "../../model/sessions.ts";
import { BUILD } from "../../build-info.ts";
import { REDACT } from "../redact-on.ts";
import { scrubText } from "../redact.ts";
import { type OtlpCfg } from "./config.ts";
import { type Attr, type XTurn, attrS, attrI, attrD, attrB, agentName } from "./types.ts";
import { nanos, resource, tables, attrsJson, vcsOf, repoKeyAttr, titleAttr } from "./encode.ts";

// one record; h = the harness whose resource it carries ("" = agentglass's own: the heartbeat), ver = its version
export interface XLog { t: number; obs: number; name: string; sev: number; body: string; attrs: Attr[]; traceId: string; spanId: string; h: string; ver: string }
// one rules transition (fire | escalate | deescalate | resolve), as the --watch alert line carries it plus the message
export interface AlertT { rule: string; severity: string; state: string; value: number; threshold: number; labels: string[][]; message: string }
export const HEARTBEAT_S = 30;
export const SEV_INFO = 9; export const SEV_WARN = 13; export const SEV_ERROR = 17;
export function sevText(n: number): string { return n >= SEV_ERROR ? "ERROR" : n >= SEV_WARN ? "WARN" : "INFO"; }

function rec(name: string, t: number, now: number, sev: number, attrs: Attr[], h: string, ver: string): XLog { return { t, obs: now, name, sev, body: name, attrs, traceId: "", spanId: "", h, ver }; }
function onTurn(l: XLog, t: XTurn | null): XLog { if (t && t.spans.length) { l.traceId = t.traceId; l.spanId = t.spans[0].spanId; } return l; }
// the title as the list shows it (faked under --redact), "" before there is one
function titleNow(s: Sess): string { const t = titleOf(s); return t === "(no prompt yet)" ? "" : t; }

// every 30 s while the live export runs: counts over the selection
export function heartbeat(now: number, live: number, busy: number, att: number): XLog {
  return rec("agentglass.heartbeat", now, now, SEV_INFO, [attrI("agentglass.heartbeat.interval", HEARTBEAT_S), attrI("agentglass.sessions.live", live), attrI("agentglass.sessions.busy", busy), attrI("agentglass.sessions.attention", att)], "", "");
}
// a top-level session's state: on change, every 300 s while live, after a recovered send failure
export function stateLog(s: Sess, st: SState, now: number, open: XTurn | null, c: OtlpCfg, ver: string, repoKey: string): XLog {
  const a: Attr[] = [attrS("gen_ai.conversation.id", s.id), attrS("gen_ai.agent.name", agentName(s.h)),
    attrB("agentglass.session.live", st.live), attrB("agentglass.session.busy", st.busy), attrB("agentglass.session.attention", st.attention),
    attrB("agentglass.session.approval", st.approval), attrS("agentglass.session.stuck", st.stuck)];
  for (const x of titleAttr(titleNow(s), c)) a.push(x);
  if (s.cwd) a.push(attrS("process.working_directory", s.cwd));
  for (const x of vcsOf(s.cwd, s.branch, s.remote)) a.push(x);
  for (const x of repoKeyAttr(repoKey)) a.push(x);
  return onTurn(rec("agentglass.session.state", now, now, st.attention || st.approval || st.stuck ? SEV_WARN : SEV_INFO, a, s.h, ver), open);
}
// a turn opened (first seen open): t = the open turn; its time is the turn's start
export function turnOpenLog(t: XTurn, now: number): XLog {
  const a: Attr[] = [attrS("gen_ai.conversation.id", t.rootId), attrI("agentglass.turn.index", t.index)];
  let model = t.spans.length ? t.spans[0].model : "";
  if (!model) for (const x of t.spans) if (x.op === "chat" && x.model && x.agent === "") { model = x.model; break; }
  if (model) a.push(attrS("gen_ai.request.model", model));
  return onTurn(rec("agentglass.turn.open", t.t0, now, SEV_INFO, a, t.h, t.ver), t);
}
// a rules transition; the body is the rendered message only where titles may go (it can quote the title), else the rule id
export function alertLog(s: Sess, al: AlertT, now: number, open: XTurn | null, c: OtlpCfg, ver: string): XLog {
  const a: Attr[] = [attrS("gen_ai.conversation.id", s.id), attrS("agentglass.alert.rule", al.rule), attrS("agentglass.alert.severity", al.severity),
    attrS("agentglass.alert.state", al.state), attrD("agentglass.alert.value", al.value), attrD("agentglass.alert.threshold", al.threshold)];
  for (const l of al.labels) a.push(attrS("agentglass.alert.label." + (l[0] ?? ""), l[1] ?? ""));
  const sev = al.state === "resolve" ? SEV_INFO : al.severity === "critical" ? SEV_ERROR : SEV_WARN;
  const r = onTurn(rec("agentglass.alert", now, now, sev, a, s.h, ver), open);
  r.body = (c.titles || REDACT) && al.message ? al.message : al.rule;
  return r;
}

function recJson(l: XLog, c: OtlpCfg): string {
  const a: Attr[] = [attrS("event.name", l.name)]; for (const x of l.attrs) a.push(x); for (const x of c.extra) a.push(x);
  let s = "{\"timeUnixNano\":\"" + nanos(l.t) + "\",\"observedTimeUnixNano\":\"" + nanos(l.obs) + "\",\"severityNumber\":" + String(l.sev) + ",\"severityText\":\"" + sevText(l.sev) + "\"";
  s += ",\"eventName\":" + JSON.stringify(l.name) + ",\"body\":{\"stringValue\":" + JSON.stringify(REDACT ? scrubText(l.body) : l.body) + "}";
  s += ",\"attributes\":" + attrsJson(tables(a, c));
  if (l.traceId) s += ",\"traceId\":\"" + l.traceId + "\",\"spanId\":\"" + l.spanId + "\"";
  return s + "}";
}
// one ExportLogsServiceRequest (protobuf JSON mapping): a ResourceLogs per (harness, version), one scope "agentglass"
export function encodeLogs(logs: XLog[], c: OtlpCfg): string {
  const groups = new Map<string, XLog[]>(); const order: string[] = [];
  for (const l of logs) { const k = l.h + "\u0000" + l.ver; const g = groups.get(k); if (g) g.push(l); else { groups.set(k, [l]); order.push(k); } }
  const rl: string[] = [];
  for (const k of order) {
    const g = groups.get(k) ?? []; const f = g[0]; if (!f) continue;
    rl.push("{\"resource\":{\"attributes\":" + attrsJson(resource(f.h, f.ver, c)) + "},\"scopeLogs\":[{\"scope\":{\"name\":\"agentglass\",\"version\":" + JSON.stringify(BUILD.version) + "},\"logRecords\":[" + g.map((l: XLog) => recJson(l, c)).join(",") + "]}]}");
  }
  return "{\"resourceLogs\":[" + rl.join(",") + "]}";
}
