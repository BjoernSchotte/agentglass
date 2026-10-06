// agentglass — OTLP request lines → host reports (otlp-hub spec 4, 5): per host, per session aggregates of agentglass's
// own spans and logs (never the spans themselves), day/hour usage rows in the viewer's time zone, owned Claude messages
// for the exact merge, live state and alerts from the logs stream. Only mapped fields are kept: user.email and the like
// cannot reach a report. Native Claude Code api_request records count only when no agentglass span has their request id.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, arr, str } from "../../util/json.ts";
import { sha256Hex } from "../../util/sha256.ts";
import { localDay } from "../../util/text.ts";
import { type Hello, type SessRow, type DayRow, type OwnRow, type LiveRow, type HostReport, FORMAT } from "../fleet/model.ts";
import { JSON_FIELDS } from "../cli.ts";

// service.name → harness id (the exporter's table, src/features/otlp/types.ts, inverted)
const HARNESS = new Map<string, string>([["claude-code", "claude"], ["codex", "codex"], ["gemini-cli", "gemini"], ["pi", "pi"], ["opencode", "opencode"], ["kiro-cli", "kiro"], ["fx", "fx"]]);
const SEEN_MS = 48 * 3600000; const STALE_MS = 90000; const NATIVE_MAX = 20000;
// fleet spec 13.1: the first 16 hex digits of SHA-256 of "agentglass/msg/v1|" + message id
export function msgHash(id: string): string { return sha256Hex("agentglass/msg/v1|" + id).slice(0, 16); }

interface DayAgg { tp: Map<string, number[]>; hx: Map<number, number>; unk: number; um: Map<string, number>; tools: number; turns: number; calls: number; errors: number }
interface OwnAgg { key: number; d: string; m: string; prov: string; n: number[] } // n: in, out, cacheRead, write5m, write1h, usd, priced
export interface SessAgg {
  key: string; h: string; id: string; title: string; cwd: string; branch: string; remote: string; repoKey: string; repoName: string;
  model: string; modelAt: number; updated: number; tin: number; tout: number; tcr: number; tcw: number; cost: number; priced: boolean; unk: number;
  modes: Map<string, number>; tools: number; errors: number; subs: number; days: Map<string, DayAgg>; own: Map<string, OwnAgg>; prov: Map<string, string>;
  live: LiveRow | null; alerts: Map<string, Obj>;
}
export interface HostAgg {
  name: string; hostId: string; hostName: string; version: string; os: string; redact: boolean; exact: boolean;
  sess: Map<string, SessAgg>; seen: Map<string, number>; newest: number; beat: number; reqIds: Set<string>; respIds: Set<string>;
  native: Obj[]; dropped: number; changed: boolean;
}
export interface Agg { hosts: Map<string, HostAgg>; subjects: Map<string, string>; refused: number }
export function newAgg(): Agg { return { hosts: new Map<string, HostAgg>(), subjects: new Map<string, string>(), refused: 0 }; }
export interface Label { name: string; hostId: string } // the authenticated directory label (trust "label")

interface Attrs { s: Map<string, string>; n: Map<string, number>; b: Map<string, boolean> } // an attribute list by value kind
function attrMap(list: unknown): Attrs {
  const m: Attrs = { s: new Map<string, string>(), n: new Map<string, number>(), b: new Map<string, boolean>() };
  for (const a of arr(list)) {
    const o = obj(a); if (!o) continue;
    const v = obj(o["value"]); if (!v) continue;
    const k = str(o["key"]);
    if (v["stringValue"] !== undefined) m.s.set(k, str(v["stringValue"]));
    else if (v["intValue"] !== undefined) { const x = v["intValue"]; const nv = typeof x === "number" ? x as number : Number(str(x)); if (isFinite(nv)) m.n.set(k, nv); }
    else if (v["doubleValue"] !== undefined) { const x = v["doubleValue"]; const nv = typeof x === "number" ? x as number : Number(str(x)); if (isFinite(nv)) m.n.set(k, nv); }
    else if (v["boolValue"] !== undefined) m.b.set(k, v["boolValue"] === true);
  }
  return m;
}
function s(m: Attrs, k: string): string { return m.s.get(k) ?? ""; }
function n(m: Attrs, k: string): number { return m.n.get(k) ?? 0; }
function b(m: Attrs, k: string): boolean { return m.b.get(k) === true; }
function has(m: Attrs, k: string): boolean { return m.s.has(k) || m.n.has(k) || m.b.has(k); }
function nsMs(v: unknown): number { const t = typeof v === "string" ? v as string : typeof v === "number" ? String(v) : ""; return t.length > 6 ? Number(t.slice(0, t.length - 6)) : 0; }
function hourOf(ms: number): number { return new Date(ms).getHours(); }

function hostAgg(a: Agg, name: string, hostId: string): HostAgg {
  let h = a.hosts.get(name);
  if (!h) { h = { name, hostId, hostName: "", version: "", os: "", redact: false, exact: false, sess: new Map<string, SessAgg>(), seen: new Map<string, number>(), newest: 0, beat: 0, reqIds: new Set<string>(), respIds: new Set<string>(), native: [], dropped: 0, changed: true }; a.hosts.set(name, h); }
  if (hostId && !h.hostId) h.hostId = hostId;
  return h;
}
function sessAgg(h: HostAgg, harness: string, id: string): SessAgg {
  const key = harness + ":" + id;
  let x = h.sess.get(key);
  if (!x) { x = { key, h: harness, id, title: "", cwd: "", branch: "", remote: "", repoKey: "", repoName: "", model: "", modelAt: 0, updated: 0, tin: 0, tout: 0, tcr: 0, tcw: 0, cost: 0, priced: false, unk: 0, modes: new Map<string, number>(), tools: 0, errors: 0, subs: 0, days: new Map<string, DayAgg>(), own: new Map<string, OwnAgg>(), prov: new Map<string, string>(), live: null, alerts: new Map<string, Obj>() }; h.sess.set(key, x); }
  return x;
}
function dayAgg(x: SessAgg, d: string): DayAgg {
  let g = x.days.get(d);
  if (!g) { g = { tp: new Map<string, number[]>(), hx: new Map<number, number>(), unk: 0, um: new Map<string, number>(), tools: 0, turns: 0, calls: 0, errors: 0 }; x.days.set(d, g); }
  return g;
}
function where(x: SessAgg, m: Attrs): void {
  const cwd = s(m, "process.working_directory"); if (cwd) x.cwd = cwd;
  const br = s(m, "vcs.ref.head.name"); if (br) x.branch = br;
  const rm = s(m, "vcs.repository.url.full"); if (rm) x.remote = rm;
  const rk = s(m, "agentglass.repo.key"); if (rk) x.repoKey = rk;
  const rn = s(m, "vcs.repository.name"); if (rn) x.repoName = rn;
}
// the host a resource belongs to (spec 5.1), "" = refused
function hostOfResource(a: Agg, rm: Attrs, label: Label | null): { name: string; hostId: string } {
  const hid = s(rm, "host.id");
  if (label) return { name: label.name, hostId: label.hostId || hid }; // receive already refused foreign host ids at ingest
  if (!hid) return { name: "", hostId: "" };
  const sub = s(rm, "agentglass.auth.subject");
  if (sub) { const p = a.subjects.get(sub); if (p === undefined) a.subjects.set(sub, hid); else if (p !== hid) { a.refused++; return { name: "", hostId: "" }; } }
  return { name: hid, hostId: hid };
}

// one chat span's usage into its session (spec 4 table)
function chat(h: HostAgg, x: SessAgg, m: Attrs, end: number, inclusive: boolean): void {
  const model = s(m, "gen_ai.request.model");
  if (model && end >= x.modelAt) { x.model = model; x.modelAt = end; }
  const cr = n(m, "gen_ai.usage.cache_read.input_tokens"); const cw = n(m, "gen_ai.usage.cache_write.input_tokens");
  const w1 = Math.min(cw, n(m, "agentglass.usage.cache_write_1h.input_tokens"));
  const inRaw = n(m, "gen_ai.usage.input_tokens"); const inX = Math.max(0, inclusive ? inRaw - cr - cw : inRaw);
  const out = n(m, "gen_ai.usage.output_tokens");
  const src = s(m, "agentglass.usage.cost.source"); const hasCost = has(m, "agentglass.usage.cost"); const usd = n(m, "agentglass.usage.cost");
  const mode = s(m, "agentglass.billing.mode") || "unknown";
  const prov = s(m, "agentglass.provider.id") || s(m, "gen_ai.provider.name");
  x.tin += inX; x.tout += out; x.tcr += cr; x.tcw += cw;
  const unpriced = !hasCost || src === "unpriced";
  const d = dayAgg(x, localDay(new Date(end).toISOString())); const hr = hourOf(end);
  d.calls++;
  if (unpriced) { const t = inX + out + cr + cw; x.unk += t; d.unk += t; d.um.set(model, (d.um.get(model) ?? 0) + t); }
  else {
    x.cost += usd; x.priced = true; x.modes.set(mode, (x.modes.get(mode) ?? 0) + usd);
    // table-priced: what re-pricing needs (fleet 14); harness-priced or mixed: kept at the sent cost
    if (src === "harness" || src === "mixed") d.hx.set(hr, (d.hx.get(hr) ?? 0) + usd);
    else {
      const k = String(hr) + "\u0000" + prov + "\u0000" + model;
      const r = d.tp.get(k) ?? [0, 0, 0, 0, 0, 0];
      r[0] = (r[0] ?? 0) + inX; r[1] = (r[1] ?? 0) + out; r[2] = (r[2] ?? 0) + cr; r[3] = (r[3] ?? 0) + (cw - w1); r[4] = (r[4] ?? 0) + w1; r[5] = (r[5] ?? 0) + usd;
      d.tp.set(k, r);
    }
  }
  if (s(m, "agentglass.provider.id")) x.prov.set(s(m, "agentglass.provider.id"), mode);
  // a Claude message this session holds (fleet 13.1): one own row per response id, the earliest end as its order key
  const rid = s(m, "gen_ai.response.id");
  if (rid && x.h === "claude") {
    h.respIds.add(rid);
    const hh = msgHash(rid); const o = x.own.get(hh);
    const add = [inX, out, cr, cw - w1, w1, unpriced ? 0 : usd];
    if (!o) x.own.set(hh, { key: end * 2, d: localDay(new Date(end).toISOString()), m: model, prov, n: add.concat([unpriced ? 0 : 1]) });
    else { for (let i = 0; i < 6; i++) o.n[i] = (o.n[i] ?? 0) + (add[i] ?? 0); if (end * 2 < o.key) o.key = end * 2; }
  }
  const req = s(m, "agentglass.request.id"); if (req) h.reqIds.add(req);
}

function spans(a: Agg, rs: Obj, label: Label | null): void {
  const r = obj(rs["resource"]); const rm = attrMap(r ? r["attributes"] : []);
  const who = hostOfResource(a, rm, label); if (!who.name) return;
  const h = hostAgg(a, who.name, who.hostId);
  const svc = s(rm, "service.name"); const harness = HARNESS.get(svc) ?? svc;
  const inclusive = s(rm, "agentglass.usage.input_tokens.semantics") !== "provider";
  if (s(rm, "host.name")) h.hostName = s(rm, "host.name");
  if (s(rm, "os.type")) h.os = s(rm, "os.type");
  if (b(rm, "agentglass.redact")) h.redact = true;
  for (const sx of arr(rs["scopeSpans"])) {
    const so = obj(sx); if (!so) continue;
    const sc = obj(so["scope"]); const ours = str(sc ? sc["name"] : "") === "agentglass";
    if (ours) { h.exact = true; const v = str(sc ? sc["version"] : ""); if (v) h.version = v; }
    for (const it of arr(so["spans"])) {
      const sp = obj(it); if (!sp) continue;
      const m = attrMap(sp["attributes"]);
      if (!ours) { // native spans (otlp-complete 4.6): Claude Code llm_request spans only ever drop out; usage comes from api_request records
        const rid = s(m, "gen_ai.response.id"); if (rid && h.respIds.has(rid)) h.dropped++;
        continue;
      }
      const sid = str(sp["spanId"]); const end = nsMs(sp["endTimeUnixNano"]);
      if (sid) { if (h.seen.has(sid)) continue; h.seen.set(sid, end); } // a resent batch (spec 3.6)
      if (end > h.newest) h.newest = end;
      const conv = s(m, "gen_ai.conversation.id"); if (!conv) continue;
      const x = sessAgg(h, harness, conv); h.changed = true;
      if (end > x.updated) x.updated = end;
      where(x, m);
      const t = s(m, "agentglass.session.title"); if (t) x.title = t;
      const op = s(m, "gen_ai.operation.name");
      const d = dayAgg(x, localDay(new Date(end).toISOString()));
      if (s(m, "error.type")) { x.errors++; d.errors++; }
      if (op === "chat") chat(h, x, m, end, inclusive);
      else if (op === "execute_tool") { x.tools++; d.tools++; }
      else if (op === "invoke_agent") { if (sp["parentSpanId"]) x.subs++; else d.turns++; }
    }
  }
}
function logs(a: Agg, rs: Obj, label: Label | null): void {
  const r = obj(rs["resource"]); const rm = attrMap(r ? r["attributes"] : []);
  const who = hostOfResource(a, rm, label); if (!who.name) return;
  const h = hostAgg(a, who.name, who.hostId);
  const svc = s(rm, "service.name"); const harness = HARNESS.get(svc) ?? svc;
  for (const sx of arr(rs["scopeLogs"])) {
    const so = obj(sx); if (!so) continue;
    const sc = obj(so["scope"]); const ours = str(sc ? sc["name"] : "") === "agentglass";
    for (const it of arr(so["logRecords"])) {
      const lr = obj(it); if (!lr) continue;
      const m = attrMap(lr["attributes"]);
      const ev = str(lr["eventName"]) || s(m, "event.name");
      const t = nsMs(lr["timeUnixNano"]) || nsMs(lr["observedTimeUnixNano"]);
      if (!ours) { // native Claude Code usage (otlp-complete 4.6): decided at report time, when every agentglass span is in
        if ((ev === "claude_code.api_request" || ev === "api_request") && h.native.length < NATIVE_MAX) {
          const o: Obj = {}; o["req"] = s(m, "request_id"); o["sess"] = s(m, "session.id"); o["model"] = s(m, "model"); o["t"] = t;
          o["in"] = n(m, "input_tokens"); o["out"] = n(m, "output_tokens"); o["cr"] = n(m, "cache_read_tokens"); o["cw"] = n(m, "cache_creation_tokens"); o["usd"] = n(m, "cost_usd");
          h.native.push(o); h.changed = true; // only these fields: user.email, account and organization ids are never kept
        }
        continue;
      }
      if (ev === "agentglass.heartbeat") { if (t > h.beat) { h.beat = t; h.changed = true; } continue; }
      const conv = s(m, "gen_ai.conversation.id"); if (!conv) continue;
      const x = sessAgg(h, harness, conv);
      if (ev === "agentglass.session.state") {
        if (x.live && x.live.at > t) continue;
        const ttl = s(m, "agentglass.session.title"); if (ttl) x.title = ttl;
        where(x, m);
        x.live = { key: x.key, at: t, live: b(m, "agentglass.session.live"), busy: b(m, "agentglass.session.busy"), attention: b(m, "agentglass.session.attention"), approval: b(m, "agentglass.session.approval"), stuck: s(m, "agentglass.session.stuck"), alerts: [] };
        if (t > x.updated) x.updated = t;
        h.changed = true;
      } else if (ev === "agentglass.alert") {
        const rule = s(m, "agentglass.alert.rule"); const st = s(m, "agentglass.alert.state");
        if (st === "resolve") x.alerts.delete(rule);
        else { const o: Obj = {}; o["rule"] = rule; o["severity"] = s(m, "agentglass.alert.severity"); o["state"] = st; o["value"] = n(m, "agentglass.alert.value"); o["threshold"] = n(m, "agentglass.alert.threshold"); o["since"] = new Date(t).toISOString(); o["message"] = str(obj(lr["body"])?.["stringValue"]); x.alerts.set(rule, o); }
        h.changed = true;
      }
    }
  }
}
// one stored line (an ExportTraceServiceRequest or ExportLogsServiceRequest); malformed lines are ignored
export function ingestLine(a: Agg, line: string, label: Label | null): void {
  if (line.length < 2 || line.charCodeAt(0) !== 123) return;
  let root: Obj | null = null; try { root = obj(JSON.parse(line)); } catch (e) { return; }
  if (!root) return;
  for (const r of arr(root["resourceSpans"])) { const o = obj(r); if (o) spans(a, o, label); }
  for (const r of arr(root["resourceLogs"])) { const o = obj(r); if (o) logs(a, o, label); }
}
// span ids older than 48 h before the newest end are forgotten (bounded memory, spec 3.6)
export function prune(a: Agg): void {
  for (const h of a.hosts.values()) {
    const cut = h.newest - SEEN_MS; const old: string[] = [];
    for (const k of h.seen.keys()) if ((h.seen.get(k) ?? 0) < cut) old.push(k);
    for (const k of old) h.seen.delete(k);
  }
}

function dayRows(x: SessAgg): DayRow[] {
  const out: DayRow[] = [];
  const days = [...x.days.keys()].sort();
  for (const d of days) {
    const g = x.days.get(d); if (!g) continue;
    const tp: string[][] = [];
    for (const k of g.tp.keys()) { const p = k.split("\u0000"); const r = g.tp.get(k) ?? []; tp.push([p[0] ?? "0", p[1] ?? "", p[2] ?? ""].concat(r.map((v: number) => String(v)))); }
    const hx: number[][] = []; for (const hr of g.hx.keys()) hx.push([hr, g.hx.get(hr) ?? 0]);
    const um: string[][] = []; for (const mo of g.um.keys()) um.push([mo, String(g.um.get(mo) ?? 0)]);
    out.push({ d, tp, hx, unk: g.unk, um, uc: 0, tools: g.tools, turns: g.turns, calls: g.calls, errors: g.errors });
  }
  return out;
}
function topMode(x: SessAgg): string { let best = "unknown"; let v = -1; for (const k of x.modes.keys()) { const c = x.modes.get(k) ?? 0; if (c > v) { v = c; best = k; } } return best; }
// the --json object of a rebuilt session: the JSON_FIELDS order, null/0 for what the export cannot carry (spec 4)
function jsonOf(x: SessAgg, live: LiveRow | null): Obj {
  const o: Obj = {};
  const alerts: Obj[] = []; for (const al of x.alerts.values()) alerts.push(al);
  const tok: Obj = {}; tok["in"] = x.tin; tok["out"] = x.tout; tok["cacheRead"] = x.tcr; tok["cacheWrite"] = x.tcw;
  const bill: Obj = {}; bill["mode"] = topMode(x); bill["plan"] = ""; bill["source"] = "otlp";
  let repo: Obj | null = null; if (x.repoKey) { repo = {}; repo["key"] = x.repoKey; repo["label"] = x.repoName || x.cwd.slice(x.cwd.lastIndexOf("/") + 1); repo["kind"] = ""; repo["worktree"] = ""; repo["top"] = ""; repo["remote"] = x.remote; }
  const vals: Obj = {};
  vals["id"] = x.id; vals["harness"] = x.h; vals["title"] = x.title; vals["cwd"] = x.cwd; vals["branch"] = x.branch; vals["remote"] = x.remote || null; vals["model"] = x.model;
  vals["path"] = null; vals["updated"] = new Date(x.updated || 0).toISOString(); vals["bytes"] = 0; vals["live"] = live ? live.live : false; vals["pid"] = 0;
  vals["status"] = ""; vals["mux"] = null; vals["parent"] = null; vals["kind"] = ""; vals["subagents"] = x.subs; vals["activity"] = "";
  vals["tokens"] = tok; vals["costUsd"] = x.priced ? Math.round(x.cost * 1e9) / 1e9 : x.unk > 0 ? null : 0; vals["costEstimatedUsd"] = 0; vals["billing"] = bill;
  vals["unpricedTokens"] = x.unk; vals["unpricedCredits"] = 0; vals["tools"] = x.tools; vals["linesAdded"] = 0; vals["linesRemoved"] = 0;
  vals["attention"] = live ? live.attention : false; vals["stuck"] = live && live.stuck ? live.stuck : null; vals["skills"] = []; vals["repo"] = repo; vals["alerts"] = alerts; vals["git"] = null;
  for (const k of JSON_FIELDS) o[k] = vals[k] ?? null;
  return o;
}
// the reports of every host that changed (all = every host); a host is live while its heartbeat is at most 90 s old
export function reportsOf(a: Agg, now: number, all: boolean, maxAgeDays: number): Map<string, HostReport> {
  const out = new Map<string, HostReport>();
  const tz = -new Date(now).getTimezoneOffset();
  for (const h of a.hosts.values()) {
    if (!all && !h.changed) continue;
    h.changed = false;
    const fresh = h.beat > 0 && now - h.beat <= STALE_MS;
    // native api_request records without a matching agentglass span: harness-priced usage of a session agentglass does
    // not export (a host without agentglass); sessions agentglass exports are authoritative. Built fresh each time
    const natives = new Map<string, SessAgg>();
    const tmp: HostAgg = { name: "", hostId: "", hostName: "", version: "", os: "", redact: false, exact: false, sess: new Map<string, SessAgg>(), seen: new Map<string, number>(), newest: 0, beat: 0, reqIds: new Set<string>(), respIds: new Set<string>(), native: [], dropped: 0, changed: false };
    for (const o of h.native) {
      const req = str(o["req"]); if (req && h.reqIds.has(req)) continue;
      const sid = str(o["sess"]); if (!sid || h.sess.has("claude:" + sid)) continue;
      const x = sessAgg(tmp, "claude", sid); natives.set(x.key, x);
      const t = typeof o["t"] === "number" ? o["t"] as number : 0;
      const v = (f: string): number => typeof o[f] === "number" ? o[f] as number : 0;
      x.tin += v("in"); x.tout += v("out"); x.tcr += v("cr"); x.tcw += v("cw"); x.cost += v("usd"); x.priced = true;
      x.modes.set("unknown", (x.modes.get("unknown") ?? 0) + v("usd"));
      const d = dayAgg(x, localDay(new Date(t).toISOString())); const hr = hourOf(t); d.hx.set(hr, (d.hx.get(hr) ?? 0) + v("usd")); d.calls++;
      if (t > x.updated) x.updated = t;
      if (str(o["model"]) && t >= x.modelAt) { x.model = str(o["model"]); x.modelAt = t; }
    }
    const rows: SessRow[] = []; const lives: LiveRow[] = [];
    const cut = now - maxAgeDays * 86400000;
    const all2: SessAgg[] = []; for (const x of h.sess.values()) all2.push(x); for (const x of natives.values()) all2.push(x);
    for (const x of all2) {
      if (x.updated && x.updated < cut) continue;
      let lv = x.live;
      if (lv && !fresh) lv = { key: lv.key, at: lv.at, live: false, busy: false, attention: lv.attention, approval: false, stuck: lv.stuck, alerts: [] };
      const own: OwnRow[] = []; for (const hh of x.own.keys()) { const o = x.own.get(hh); if (o) own.push({ h: hh, key: o.key, d: o.d, m: o.m, prov: o.prov, n: o.n.slice() }); }
      const prov: string[][] = []; for (const p of x.prov.keys()) prov.push([p, x.prov.get(p) ?? "unknown"]);
      rows.push({ s: jsonOf(x, lv), key: x.key, days: dayRows(x), own: x.h === "claude" ? own : null, prov });
      if (lv) { const al: Obj[] = []; for (const v of x.alerts.values()) al.push(v); lives.push({ key: lv.key, at: lv.at, live: lv.live, busy: lv.busy, attention: lv.attention, approval: lv.approval, stuck: lv.stuck, alerts: al }); }
    }
    rows.sort((p, q) => str(q.s["updated"]) < str(p.s["updated"]) ? -1 : 1);
    const hello: Hello = { format: FORMAT, version: h.version, hostId: h.hostId, hostName: h.hostName, os: h.os, tzOffsetMin: tz, redact: h.redact, days: maxAgeDays, now: Math.max(h.newest, h.beat), priceSig: "" };
    out.set(h.name, { hello, sessions: rows, cost: null, allowance: null, live: lives, exact: h.exact && natives.size === 0 });
  }
  return out;
}
