// agentglass — OTLP export: span records → one OTLP/JSON ExportTraceServiceRequest (protobuf JSON mapping)
// SPDX-License-Identifier: Apache-2.0
// Attribute names follow the OpenTelemetry GenAI semantic conventions as of semantic-conventions v1.37 (gen-ai registry,
// Development stability) plus the general vcs/process/mcp registries; facts with no semconv home use agentglass.*.
import { execFileSync } from "node:child_process";
import { scrubRemote } from "../../util/giturl.ts";
import { BUILD } from "../../build-info.ts";
import { REDACT } from "../redact-on.ts";
import { scrubText } from "../redact.ts";
import { identNow, labelOf } from "../../model/project.ts";
import { mcpServer } from "../usage/calls.ts";
import { type InMode, inputTokens, providerOf } from "./requests.ts";
import { type OtlpCfg } from "./config.ts";
import { type Attr, type XSpan, type XTurn, attrS, attrI, attrD, attrB, attrA, serviceName, agentName } from "./types.ts";

// epoch ms → decimal nanoseconds: the value exceeds 2^53, so it is built as a string
export function nanos(ms: number): string { return String(Math.floor(ms)) + "000000"; }
// the harness's own session attribute in its native telemetry (spec 3b.3): lets a backend join both sources
const NATIVE = new Map<string, string>([["claude", "session.id"], ["codex", "conversation.id"], ["gemini", "session.id"], ["opencode", "session.id"]]);
export function nativeKey(h: string): string { return NATIVE.get(h) ?? ""; }

// ── vcs.* from repo-view's project identity (its chosen remote, worktrees resolved; no git process); dropped under --redact ──
function providerName(host: string): string {
  const h = host.replace(/:\d+$/, "");
  if (h === "github.com" || h.endsWith(".github.com")) return "github";
  if (h.indexOf("gitlab") >= 0) return "gitlab";
  if (h.indexOf("bitbucket") >= 0) return "bitbucket";
  if (h.indexOf("gitea") >= 0 || h === "codeberg.org") return "gitea";
  return "";
}
export function vcsOf(cwd: string, branch: string, remote: string): Attr[] {
  if (REDACT || !cwd) return [];
  const out: Attr[] = [];
  const id = identNow(cwd);
  const repo = id.kind === "git" || id.kind === "gitdir";
  const r = scrubRemote(id.remote || remote);
  if (r) {
    out.push(attrS("vcs.repository.url.full", r.url));
    if (r.name) out.push(attrS("vcs.repository.name", r.name));
    if (r.owner) out.push(attrS("vcs.owner.name", r.owner));
    const p = providerName(r.host); if (p) out.push(attrS("vcs.provider.name", p));
  } else if (repo) out.push(attrS("vcs.repository.name", labelOf(id)));
  if (branch) { out.push(attrS("vcs.ref.head.name", branch)); out.push(attrS("vcs.ref.head.type", "branch")); }
  return out;
}

// ── attributes per span (spec 3.3/3.4) ──
function cut(s: string, n: number): string { return s.length > n ? s.slice(0, n) : s; }
function msgs(role: string, text: string, max: number): string { return JSON.stringify([{ role, parts: [{ type: "text", content: cut(text, max) }] }]); }
function usage(out: Attr[], t: XTurn, sp: XSpan, c: OtlpCfg): void {
  const prov = sp.provider || providerOf("", sp.model);
  out.push(attrI("gen_ai.usage.input_tokens", inputTokens(t.h, prov, sp, c.inputTokens === "provider" ? "provider" : "inclusive" as InMode)));
  out.push(attrI("gen_ai.usage.output_tokens", sp.nOut));
  if (t.h !== "kiro" || sp.cr > 0) out.push(attrI("gen_ai.usage.cache_read.input_tokens", sp.cr));
  if (t.h !== "kiro" || sp.cw > 0) out.push(attrI("gen_ai.usage.cache_write.input_tokens", sp.cw));
  if (sp.rs > 0) out.push(attrI("gen_ai.usage.reasoning.output_tokens", sp.rs));
  const unknown = sp.unk > 0 && sp.cost === 0;
  if (!unknown) out.push(attrD("agentglass.usage.cost", sp.cost)); // unknown cost is omitted, never 0
  const src = unknown ? "unpriced" : sp.costSrc || (sp.exact || sp.total ? "harness" : ""); // fx totals and kiro turns: the harness's own figure
  if (src) { out.push(attrS("agentglass.usage.cost.source", src)); out.push(attrB("agentglass.usage.cost.estimated", sp.costEst)); }
}
// gen_ai.provider.name of a root or tool span: the model's vendor, else what a chat span of that model resolved (the
// provider its record logged), so a model no vendor rule knows names one provider across the trace
function spanProv(t: XTurn, model: string): string {
  const v = providerOf("", model); if (v || !model) return v;
  for (const x of t.spans) if (x.op === "chat" && x.model === model && x.provider) return x.provider;
  return "";
}
export function spanAttrs(t: XTurn, sp: XSpan, c: OtlpCfg, vcs: Attr[]): Attr[] {
  const a: Attr[] = [];
  const root = sp === t.spans[0];
  a.push(attrS("gen_ai.operation.name", sp.op));
  a.push(attrS("gen_ai.conversation.id", t.rootId));
  a.push(attrS("gen_ai.agent.name", sp.agent || agentName(t.h)));
  const prov = sp.op === "chat" ? sp.provider || providerOf("", sp.model) : spanProv(t, sp.op === "invoke_agent" ? sp.model : t.spans[0].model);
  if (prov) a.push(attrS("gen_ai.provider.name", prov));
  if (t.cwd) a.push(attrS("process.working_directory", t.cwd));
  for (const v of vcs) a.push(v);
  if (sp.op === "chat") {
    if (sp.model) a.push(attrS("gen_ai.request.model", sp.model));
    if (sp.respModel) a.push(attrS("gen_ai.response.model", sp.respModel));
    if (sp.respId) a.push(attrS("gen_ai.response.id", sp.respId));
    a.push(attrS("agentglass.billing.mode", sp.bill || "unknown"));
    if (sp.hasUsage) usage(a, t, sp, c);
    if (sp.provId) a.push(attrS("agentglass.provider.id", sp.provId));
    if (sp.total) a.push(attrB("agentglass.usage.session_delta", true)); // fx: the growth of the session's totals since the last export, not one request's
    if (sp.superseded) a.push(attrB("agentglass.chat.superseded", true));
    if (c.content && sp.output) a.push(attrS("gen_ai.output.messages", msgs("assistant", sp.output, c.contentMax)));
  } else if (sp.op === "invoke_agent") {
    if (sp.model) a.push(attrS("gen_ai.request.model", sp.model));
    if (sp.models.length) a.push(attrA("agentglass.models", sp.models));
    if (root) {
      const nk = nativeKey(t.h); if (nk) a.push(attrS(nk, t.rootId));
      a.push(attrI("agentglass.turn.index", t.index));
      if (t.compacted) a.push(attrB("gen_ai.conversation.compacted", true));
      if (sp.skill) a.push(attrS("gen_ai.skill.name", sp.skill));
    } else a.push(attrS("agentglass.session.id", sp.sess));
    if (c.content && sp.input) a.push(attrS("gen_ai.input.messages", msgs("user", sp.input, c.contentMax)));
    if (c.content && sp.output) a.push(attrS("gen_ai.output.messages", msgs("assistant", sp.output, c.contentMax)));
  } else {
    const sv = sp.mcp || mcpServer(sp.tool);
    a.push(attrS("gen_ai.tool.name", sv ? sp.tool.slice(5 + sv.length + 2) || sp.tool : sp.tool));
    if (sp.callId) a.push(attrS("gen_ai.tool.call.id", sp.callId));
    a.push(attrS("gen_ai.tool.type", sv ? "extension" : "function"));
    if (sv) { a.push(attrS("mcp.method.name", "tools/call")); a.push(attrS("agentglass.mcp.server.name", sv)); }
    if (sp.prog) a.push(attrS("process.executable.name", sp.prog));
    if (sp.exit >= 0 && sp.prog) a.push(attrI("process.exit.code", sp.exit));
    if (sp.skill) a.push(attrS("gen_ai.skill.name", sp.skill));
    if (c.content && sp.args) a.push(attrS("gen_ai.tool.call.arguments", cut(sp.args, c.contentMax)));
    if (c.content && sp.result) a.push(attrS("gen_ai.tool.call.result", cut(sp.result, c.contentMax)));
  }
  if (sp.est) a.push(attrB("agentglass.timing.estimated", true));
  if (sp.err) a.push(attrS("error.type", sp.err));
  for (const x of sp.attrs) a.push(x);
  for (const x of c.extra) a.push(x);
  return tables(a, c);
}
// rename + drop last; under --redact every string passes the scrubber (vcs.* never get here then)
function tables(a: Attr[], c: OtlpCfg): Attr[] {
  const out: Attr[] = [];
  for (const x of a) {
    if (c.drop.has(x.k)) continue;
    const k = c.rename.get(x.k) ?? x.k;
    if (k === x.k && !REDACT) { out.push(x); continue; }
    out.push({ k, t: x.t, s: REDACT && x.t === "s" ? scrubText(x.s) : x.s, n: x.n, b: x.b, a: REDACT && x.t === "as" ? x.a.map((v: string) => scrubText(v)) : x.a });
  }
  return out;
}

// ── JSON ──
function val(x: Attr): string {
  if (x.t === "s") return "{\"stringValue\":" + JSON.stringify(x.s) + "}";
  if (x.t === "i") return "{\"intValue\":\"" + String(Math.round(x.n)) + "\"}";
  if (x.t === "d") return "{\"doubleValue\":" + (isFinite(x.n) ? String(x.n) : "0") + "}";
  if (x.t === "b") return "{\"boolValue\":" + (x.b ? "true" : "false") + "}";
  return "{\"arrayValue\":{\"values\":[" + x.a.map((v: string) => "{\"stringValue\":" + JSON.stringify(v) + "}").join(",") + "]}}";
}
function attrsJson(a: Attr[]): string { return "[" + a.map((x: Attr) => "{\"key\":" + JSON.stringify(x.k) + ",\"value\":" + val(x) + "}").join(",") + "]"; }
function spanJson(t: XTurn, sp: XSpan, c: OtlpCfg, vcs: Attr[]): string {
  let s = "{\"traceId\":\"" + t.traceId + "\",\"spanId\":\"" + sp.spanId + "\"";
  if (sp.parentId) s += ",\"parentSpanId\":\"" + sp.parentId + "\"";
  s += ",\"name\":" + JSON.stringify(REDACT ? scrubText(sp.name) : sp.name) + ",\"kind\":" + String(sp.kind);
  s += ",\"startTimeUnixNano\":\"" + nanos(sp.t0) + "\",\"endTimeUnixNano\":\"" + nanos(Math.max(sp.t0, sp.t1)) + "\"";
  s += ",\"attributes\":" + attrsJson(spanAttrs(t, sp, c, vcs));
  if (sp.events.length) s += ",\"events\":[" + sp.events.map((e) => "{\"timeUnixNano\":\"" + nanos(e.t) + "\",\"name\":" + JSON.stringify(e.name) + ",\"attributes\":" + attrsJson(e.attrs) + "}").join(",") + "]";
  if (sp.err) s += ",\"status\":{\"code\":2" + (c.content && sp.errMsg ? ",\"message\":" + JSON.stringify(cut(REDACT ? scrubText(sp.errMsg) : sp.errMsg, c.contentMax)) : "") + "}";
  return s + "}";
}
let host = "";
function hostName(): string { if (!host) { try { host = execFileSync("uname", ["-n"], { encoding: "utf8" }).trim(); } catch (e) { host = "unknown"; } } return host; }
function resource(h: string, ver: string, c: OtlpCfg): Attr[] {
  const a: Attr[] = [attrS("service.name", serviceName(h))];
  if (ver) a.push(attrS("service.version", ver));
  a.push(attrS("os.type", process.platform === "darwin" ? "darwin" : "linux"));
  if (c.hostName) a.push(attrS("host.name", hostName()));
  a.push(attrS("agentglass.usage.input_tokens.semantics", c.inputTokens === "provider" ? "provider" : "inclusive"));
  a.push(attrS("agentglass.source", "transcript"));
  return tables(a, c);
}
// one request: a ResourceSpans per (harness, harness version), one scope "agentglass"
export function encodeRequest(turns: XTurn[], c: OtlpCfg): string {
  const groups = new Map<string, XTurn[]>(); const order: string[] = [];
  for (const t of turns) { const k = t.h + "\u0000" + t.ver; const g = groups.get(k); if (g) g.push(t); else { groups.set(k, [t]); order.push(k); } }
  const rs: string[] = [];
  for (const k of order) {
    const g = groups.get(k) ?? []; const f = g[0]; if (!f) continue;
    const sp: string[] = [];
    for (const t of g) { const v = vcsOf(t.cwd, t.branch, t.remote); for (const s of t.spans) sp.push(spanJson(t, s, c, v)); }
    rs.push("{\"resource\":{\"attributes\":" + attrsJson(resource(f.h, f.ver, c)) + "},\"scopeSpans\":[{\"scope\":{\"name\":\"agentglass\",\"version\":" + JSON.stringify(BUILD.version) + "},\"spans\":[" + sp.join(",") + "]}]}");
  }
  return "{\"resourceSpans\":[" + rs.join(",") + "]}";
}
