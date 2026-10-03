// agentglass — self-check for request grain, provider names and input-token semantics: scriptc build src/features/otlp/requests.check.ts -o rq && ./rq
// SPDX-License-Identifier: Apache-2.0
import { type Req, requestOf, newReqState, providerOf, inputTokens } from "./requests.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function show(r: Req | null): string { return r ? [r.key, r.model, r.respModel, r.provider, String(r.providerId), String(r.t0), String(r.t), r.err].join("|") : "null"; }
const TS = "2026-09-01T10:00:02.000Z"; const T = Date.parse(TS);

// claude: one request per message.id (streamed lines share it); API-error lines carry their error type, no model
let x = newReqState();
eq("claude", show(requestOf("claude", null, "{\"type\":\"assistant\",\"timestamp\":\"" + TS + "\",\"message\":{\"id\":\"msg_a\",\"model\":\"claude-sonnet-4-5\",\"content\":[],\"usage\":{}}}", x)), "msg_a|claude-sonnet-4-5||anthropic|true|0|" + String(T) + "|");
eq("claude api error", show(requestOf("claude", null, "{\"type\":\"assistant\",\"timestamp\":\"" + TS + "\",\"isApiErrorMessage\":true,\"error\":\"rate_limit\",\"message\":{\"id\":\"msg_e\",\"model\":\"<synthetic>\",\"content\":[]}}", x)), "msg_e|||anthropic|true|0|" + String(T) + "|rate_limit");
eq("claude user line", show(requestOf("claude", null, "{\"type\":\"user\",\"timestamp\":\"" + TS + "\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}", x)), "null");

// codex grain: a request per changed cumulative total; info:null and repeats are none; a reset (counter back) is a fresh request
x = newReqState();
const tc = (ts: string, i: number, o: number): string => "{\"timestamp\":\"" + ts + "\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":" + String(i) + ",\"cached_input_tokens\":0,\"output_tokens\":" + String(o) + "}}}}";
const seq = [tc(TS, 100, 10), "{\"timestamp\":\"" + TS + "\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":null,\"rate_limits\":{}}}", tc(TS, 100, 10), tc(TS, 300, 20), tc("2026-09-01T10:00:05.000Z", 50, 5)];
const keys: string[] = []; for (const l of seq) { const r = requestOf("codex", null, l, x); if (r) keys.push(r.key); }
eq("codex grain", keys.join(","), TS + "#0," + TS + "#1,2026-09-01T10:00:05.000Z#0");
eq("codex function call is no request", show(requestOf("codex", null, "{\"timestamp\":\"" + TS + "\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\"}}", x)), "null");

// gemini: a gemini record with tokens (its tool-call echo line is none)
x = newReqState();
eq("gemini", show(requestOf("gemini", null, "{\"id\":\"g1\",\"timestamp\":\"" + TS + "\",\"type\":\"gemini\",\"model\":\"gemini-2.5-pro\",\"tokens\":{\"input\":1}}", x)), "g1|gemini-2.5-pro||gcp.gemini|true|0|" + String(T) + "|");
eq("gemini calls only", show(requestOf("gemini", null, "{\"id\":\"g1\",\"timestamp\":\"" + TS + "\",\"type\":\"gemini\",\"toolCalls\":[]}", x)), "null");

// opencode 2.x: an assistant row (id from the source, provider logged, start = created); copied fork rows are none
eq("opencode", show(requestOf("opencode", null, "{\"type\":\"assistant\",\"seq\":1,\"id\":\"msg_1\",\"time\":{\"created\":1000,\"completed\":5000},\"model\":{\"id\":\"gpt-5.2\",\"providerID\":\"openai\"},\"tokens\":{}}", x)), "msg_1|gpt-5.2||openai|true|1000|5000|");
eq("opencode no id", show(requestOf("opencode", null, "{\"type\":\"assistant\",\"seq\":4,\"time\":{\"created\":1000,\"completed\":5000},\"model\":{\"id\":\"m\",\"providerID\":\"p\"},\"tokens\":{}}", x)), "seq:4|m||p|false|1000|5000|");
eq("opencode copied", show(requestOf("opencode", null, "{\"type\":\"assistant\",\"seq\":1,\"copied\":1,\"time\":{\"created\":1},\"tokens\":{}}", x)), "null");
eq("opencode 1.x step-finish", show(requestOf("opencode", null, "{\"v1\":1,\"role\":\"assistant\",\"model\":\"claude-x\",\"prov\":\"anthropic\",\"t\":1000,\"mid\":\"msg_9\",\"part\":{\"type\":\"step-finish\",\"tokens\":{}}}", x)), "msg_9|claude-x||anthropic|true|1000|1000|");

// pi: assistant entries with usage; responseModel kept apart
eq("pi", show(requestOf("pi", null, "{\"type\":\"message\",\"id\":\"e2\",\"timestamp\":\"" + TS + "\",\"message\":{\"role\":\"assistant\",\"provider\":\"openrouter\",\"model\":\"anthropic/claude-sonnet-4.5\",\"responseModel\":\"anthropic/claude-4.5-sonnet-20250929\",\"usage\":{\"input\":1}}}", x)), "e2|anthropic/claude-sonnet-4.5|anthropic/claude-4.5-sonnet-20250929|openrouter|true|0|" + String(T) + "|");
eq("pi compaction", show(requestOf("pi", null, "{\"type\":\"compaction\",\"id\":\"c1\",\"timestamp\":\"" + TS + "\",\"model\":\"m\",\"usage\":{\"input\":1}}", x)), "c1|m|||true|0|" + String(T) + "|");
eq("pi tool result", show(requestOf("pi", null, "{\"type\":\"message\",\"id\":\"e3\",\"timestamp\":\"" + TS + "\",\"message\":{\"role\":\"toolResult\",\"usage\":{\"input\":1}}}", x)), "null");
eq("kiro/fx: turn grain", show(requestOf("kiro", null, "{\"kind\":\"AssistantMessage\"}", x)) + show(requestOf("fx", null, "{\"event\":{}}", x)), "nullnull");

// providers: logged id first (aliases mapped to semconv names), else by model prefix
eq("providers", [providerOf("", "o3-mini"), providerOf("", "claude-opus-4-5"), providerOf("", "gemini-2.5-pro"), providerOf("", "kimi-k2"), providerOf("openrouter", "x"), providerOf("", "llama3"), providerOf("", "gpt-5.2-codex"), providerOf("google", "x"), providerOf("", "anthropic/claude-x"), providerOf("", "devstral-small"), providerOf("", "grok-4"), providerOf("", "deepseek-v3")].join(","),
  "openai,anthropic,gcp.gemini,moonshot_ai,openrouter,,openai,gcp.gemini,anthropic,mistral_ai,x_ai,deepseek");

// input-token semantics (spec 3.6): inclusive = in + cache read + cache write everywhere; provider = exclusive for anthropic only
const b = (i: number, r: number, w: number): { nIn: number; cr: number; cw: number } => ({ nIn: i, cr: r, cw: w });
eq("anthropic", String(inputTokens("claude", "anthropic", b(10, 100, 5), "inclusive")) + "/" + String(inputTokens("claude", "anthropic", b(10, 100, 5), "provider")), "115/10");
eq("codex", String(inputTokens("codex", "openai", b(10, 100, 5), "inclusive")) + "/" + String(inputTokens("codex", "openai", b(10, 100, 5), "provider")), "115/115");
eq("gemini", String(inputTokens("gemini", "gcp.gemini", b(10, 100, 0), "inclusive")) + "/" + String(inputTokens("gemini", "gcp.gemini", b(10, 100, 0), "provider")), "110/110");
eq("kiro", String(inputTokens("kiro", "", b(10, 0, 0), "inclusive")) + "/" + String(inputTokens("kiro", "", b(10, 0, 0), "provider")), "10/10");
eq("pi on anthropic", String(inputTokens("pi", "anthropic", b(5, 450, 0), "provider")), "5");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("requests: all checks passed");
