// agentglass — OTLP export: which transcript line is one API request (spec 1.2), provider names, input-token semantics (3.6)
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, parse as parseJson } from "../../util/json.ts";
import { isoMs, num } from "../usage/record.ts";

// key = request key Q ("" never: no request → null); providerId = key is the provider's message id (→ gen_ai.response.id);
// t0 = the request's own start when logged (0 = the builder takes the previous event of the session), t = its end
// provider = gen_ai.provider.name (providerOf); logged = the provider id the record itself names (pi/OpenCode), "" = none
export interface Req { key: string; model: string; respModel: string; provider: string; logged: string; providerId: boolean; t0: number; t: number; err: string }
// codex: the last cumulative totals seen, and the ordinal of requests per timestamp
export interface ReqState { codexLast: number[]; codexTs: string; codexK: number }
export function newReqState(): ReqState { return { codexLast: [], codexTs: "", codexK: 0 }; }

// prov = the logged provider id (pi/OpenCode) or the harness's only one (claude, codex): the name when the model has no vendor
function req(key: string, model: string, prov: string, idKey: boolean, t0: number, t: number): Req {
  return { key, model, respModel: "", provider: providerOf(prov, model), logged: "", providerId: idKey, t0, t, err: "" };
}
function logged(r: Req, prov: string): Req { r.logged = prov; return r; }
function tm(o: Obj | null, k: string): number { const t = o ? obj(o["time"]) : null; return t ? num(t[k]) : 0; }
function same(a: number[], b: number[]): boolean { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return false; return true; }

// the request one raw line (as the adapter's usage() sees it) stands for; o = the line parsed, or null (parsed here when needed)
export function requestOf(h: string, o0: Obj | null, line: string, x: ReqState): Req | null {
  if (h === "claude") {
    if (line.indexOf("\"type\":\"assistant\"") < 0) return null;
    const o = o0 ?? parseJson(line); if (!o || str(o["type"]) !== "assistant") return null;
    const m = obj(o["message"]); const id = m ? str(m["id"]) : ""; if (!m || !id) return null;
    const md = str(m["model"]);
    const r = req(id, md === "<synthetic>" ? "" : md, "anthropic", true, 0, isoMs(str(o["timestamp"])));
    if (o["isApiErrorMessage"] === true) r.err = str(o["error"]) || "api_error"; // the request failed before any model answered
    return r;
  }
  if (h === "codex") {
    if (line.indexOf("\"type\":\"token_count\"") < 0) return null;
    const o = o0 ?? parseJson(line); const p = o ? obj(o["payload"]) : null; if (!o || !p || str(p["type"]) !== "token_count") return null;
    const info = obj(p["info"]); const tu = info ? obj(info["total_token_usage"]) : null; if (!tu) return null; // rate-limit-only events
    const cur = [num(tu["input_tokens"]), num(tu["cached_input_tokens"]), num(tu["cache_write_input_tokens"]), num(tu["output_tokens"])];
    if (same(cur, x.codexLast)) return null; // a repeated total: no new response
    x.codexLast = cur;
    const ts = str(o["timestamp"]);
    if (ts === x.codexTs) x.codexK++; else { x.codexTs = ts; x.codexK = 0; }
    return req(ts + "#" + String(x.codexK), "", "openai", false, 0, isoMs(ts)); // model: the booking's (latest turn_context)
  }
  if (h === "gemini") {
    if (line.indexOf("\"tokens\":{") < 0) return null;
    const o = o0 ?? parseJson(line); if (!o || str(o["type"]) !== "gemini" || !obj(o["tokens"])) return null;
    const id = str(o["id"]); if (!id) return null;
    return req(id, str(o["model"]), "", true, 0, isoMs(str(o["timestamp"])));
  }
  if (h === "opencode") {
    if (line.startsWith("{\"v1\":")) { // 1.x: the step-finish part of an assistant message
      if (line.indexOf("\"type\":\"step-finish\"") < 0) return null;
      const o = o0 ?? parseJson(line); const pt = o ? obj(o["part"]) : null;
      if (!o || !pt || str(pt["type"]) !== "step-finish" || o["copied"] === 1 || o["copied"] === true) return null;
      const mid = str(o["mid"]); const t = num(o["t"]);
      return logged(req(mid || "t:" + String(t), str(o["model"]), str(o["prov"]), !!mid, t, Math.max(t, tm(pt, "end"))), str(o["prov"]));
    }
    if (!line.startsWith("{\"type\":\"assistant\"") && !line.startsWith("{\"type\":\"compaction\"")) return null;
    const o = o0 ?? parseJson(line); if (!o || o["copied"] === 1 || !obj(o["tokens"])) return null;
    const m = obj(o["model"]); const id = str(o["id"]);
    const t0 = tm(o, "created");
    const pv = m ? str(m["providerID"]) : "";
    return logged(req(id || "seq:" + String(num(o["seq"])), m ? str(m["id"]) : "", pv, !!id, t0, Math.max(t0, tm(o, "completed"))), pv);
  }
  if (h === "pi") {
    if (line.indexOf("\"usage\":{") < 0) return null;
    const o = o0 ?? parseJson(line); if (!o) return null;
    const type = str(o["type"]); const id = str(o["id"]); const t = isoMs(str(o["timestamp"]));
    if ((type === "usage" || type === "compaction" || type === "branch_summary") && obj(o["usage"])) return req(id, str(o["model"]), "", !!id, 0, t);
    const m = obj(o["message"]);
    if (type !== "message" || !m || str(m["role"]) !== "assistant" || !obj(m["usage"])) return null; // usage on a tool result: a subagent's, no request of this session
    const r = logged(req(id, str(m["model"]), str(m["provider"]), !!id, 0, t), str(m["provider"]));
    const rm = str(m["responseModel"]); if (rm && rm !== r.model) r.respModel = rm;
    return r;
  }
  return null; // kiro, fx: no per-request records (one chat span per turn)
}

// gen_ai.provider.name, one rule for every span of a trace: the model's vendor (a "vendor/" prefix or a known model family),
// else the logged provider id (aliases → semconv names); "" = unknown (omitted). A gateway or router id the record logs
// (cliproxyapi, openrouter, github-copilot) is no model vendor: it stays on the chat span as agentglass.provider.id
const ALIAS = new Map<string, string>([["google", "gcp.gemini"], ["gemini", "gcp.gemini"], ["vertex", "gcp.vertex_ai"], ["xai", "x_ai"], ["mistral", "mistral_ai"], ["moonshot", "moonshot_ai"], ["moonshotai", "moonshot_ai"], ["azure", "azure.ai.openai"], ["amazon-bedrock", "aws.bedrock"], ["bedrock", "aws.bedrock"]]);
const VENDORS = ["anthropic", "openai", "deepseek", "x_ai", "mistral_ai", "moonshot_ai"];
export function providerOf(logged: string, model: string): string {
  let m = model.toLowerCase(); const sl = m.lastIndexOf("/");
  if (sl >= 0) { // "anthropic/claude-…" (a router's model id): a known vendor prefix names the provider
    const p = m.slice(0, sl); m = m.slice(sl + 1);
    const v = ALIAS.get(p) ?? (VENDORS.indexOf(p) >= 0 ? p : ""); if (v) return v;
  }
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gpt-") || /^o\d/.test(m) || m.startsWith("codex-")) return "openai";
  if (m.startsWith("gemini-")) return "gcp.gemini";
  if (m.startsWith("grok-")) return "x_ai";
  if (m.startsWith("deepseek-")) return "deepseek";
  if (m.startsWith("mistral-") || m.startsWith("codestral-") || m.startsWith("devstral-")) return "mistral_ai";
  if (m.startsWith("kimi-")) return "moonshot_ai";
  const l = logged.toLowerCase();
  return l ? ALIAS.get(l) ?? l : "";
}
export type InMode = "inclusive" | "provider";
// agentglass's own `in` excludes cache reads/writes for every harness; semconv wants them included (inclusive). provider =
// what the provider's API reports: Anthropic exclusive, everyone else inclusive (Kiro has no split: in either way)
export function inputTokens(h: string, provider: string, b: { nIn: number; cr: number; cw: number }, mode: InMode): number {
  if (mode === "provider" && provider === "anthropic") return b.nIn;
  return h === "kiro" ? b.nIn : b.nIn + b.cr + b.cw;
}
