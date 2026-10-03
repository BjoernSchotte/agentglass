// agentglass — per-message model on call rows: scriptc build src/harness/model.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
// Each harness switches model between two tool-calling messages; every row must carry the model of the message that issued it.
import { type Acc, newAcc } from "../features/usage/record.ts";
import { DICT, nameOf, MQ_MSG, MQ_TURN, MQ_SESS } from "../features/usage/facts.ts";
import { newSess } from "../model/types.ts";
import { harnessOf } from "./index.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function dump(a: Acc): string { const o: string[] = []; for (const c of a.calls) o.push(nameOf(DICT.tool, c.tool) + "@" + (nameOf(DICT.model, c.model) || "?") + "/" + String(c.mq)); return o.join(" "); }
function rows(h: string, lines: string[]): string { const a = newAcc(); for (const l of lines) harnessOf(h).usage(a, l); return dump(a); }
function want(xs: string[], mq: number): string { const o: string[] = []; for (const x of xs) o.push(x + "/" + String(mq)); return o.join(" "); }
function eq(w: string, got: string, exp: string): void { ok(w, got === exp, got + " ≠ " + exp); }
const T = "\"timestamp\":\"2026-01-02T10:00:0";

// claude: the second message is answered by sonnet (fallback); a repeated message id skips its usage but its tool row still
// gets the model; <synthetic> → unknown
eq("claude", rows("claude", [
  "{\"type\":\"assistant\"," + T + "1Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
  "{\"type\":\"assistant\"," + T + "2Z\",\"message\":{\"id\":\"m2\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"Read\",\"input\":{\"file_path\":\"/a\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
  "{\"type\":\"assistant\"," + T + "3Z\",\"message\":{\"id\":\"m2\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t3\",\"name\":\"Grep\",\"input\":{}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
  "{\"type\":\"assistant\"," + T + "4Z\",\"message\":{\"id\":\"m3\",\"model\":\"<synthetic>\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t4\",\"name\":\"Bash\",\"input\":{}}]}}",
]), want(["Bash@claude-opus-4-5", "Read@claude-sonnet-4-5", "Grep@claude-sonnet-4-5", "Bash@?"], MQ_MSG));

// codex: the model is fixed per turn (turn_context)
eq("codex", rows("codex", [
  "{" + T + "0Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5\"}}",
  "{" + T + "1Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"ls\\\"]}\",\"call_id\":\"c1\"}}",
  "{" + T + "2Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}",
  "{" + T + "3Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"pwd\\\"]}\",\"call_id\":\"c2\"}}",
]), want(["shell@gpt-5", "shell@gpt-5-codex"], MQ_TURN));

// gemini: each gemini record names its model
eq("gemini", rows("gemini", [
  "{\"id\":\"g1\",\"timestamp\":\"2026-01-02T10:00:02.000Z\",\"type\":\"gemini\",\"model\":\"gemini-2.5-pro\",\"toolCalls\":[{\"id\":\"c1\",\"name\":\"run_shell_command\",\"args\":{\"command\":\"ls\"},\"status\":\"success\",\"timestamp\":\"2026-01-02T10:00:03.000Z\"}]}",
  "{\"id\":\"g2\",\"timestamp\":\"2026-01-02T10:00:04.000Z\",\"type\":\"gemini\",\"model\":\"gemini-2.5-flash\",\"toolCalls\":[{\"id\":\"c2\",\"name\":\"read_file\",\"args\":{\"file_path\":\"/a\"},\"status\":\"success\",\"timestamp\":\"2026-01-02T10:00:05.000Z\"}]}",
]), want(["run_shell_command@gemini-2.5-pro", "read_file@gemini-2.5-flash"], MQ_MSG));

// pi: responseModel wins over model; model_change between messages; calls nested in a script inherit their parent call's model
eq("pi", rows("pi", [
  "{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"2026-01-02T10:00:01.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"p1\",\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}],\"model\":\"router-auto\",\"responseModel\":\"claude-sonnet-4-5\",\"usage\":{\"input\":1,\"output\":1,\"cost\":{\"total\":0.001}}}}",
  "{\"type\":\"model_change\",\"id\":\"mc\",\"parentId\":null,\"timestamp\":\"2026-01-02T10:00:02.000Z\",\"provider\":\"x\",\"modelId\":\"gpt-5\"}",
  "{\"type\":\"message\",\"id\":\"e2\",\"parentId\":null,\"timestamp\":\"2026-01-02T10:00:03.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"p2\",\"name\":\"codemode\",\"arguments\":{\"code\":\"x\"}}],\"model\":\"gpt-5\",\"usage\":{\"input\":1,\"output\":1,\"cost\":{\"total\":0.001}}}}",
  "{\"type\":\"message\",\"id\":\"e3\",\"parentId\":null,\"timestamp\":\"2026-01-02T10:00:04.000Z\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"p2\",\"toolName\":\"codemode\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"isError\":false,\"nestedCalls\":{\"calls\":[{\"id\":\"n1\",\"name\":\"read\",\"status\":\"ok\",\"durationMs\":3,\"arguments\":{\"path\":\"/a\"}}]}}}",
]), want(["bash@claude-sonnet-4-5", "codemode@gpt-5", "read@gpt-5"], MQ_MSG));

// opencode 1.x: one row per part, carrying its message's modelID; 2.x: the assistant row's model.id
eq("opencode 1.x", rows("opencode", [
  "{\"v1\":1,\"role\":\"assistant\",\"model\":\"claude-opus-4-5\",\"prov\":\"anthropic\",\"t\":1767348000000,\"part\":{\"type\":\"tool\",\"tool\":\"bash\",\"callID\":\"o1\",\"state\":{\"status\":\"completed\",\"input\":{\"command\":\"ls\"},\"output\":\"a\",\"time\":{\"start\":1767348000000,\"end\":1767348001000}}}}",
  "{\"v1\":1,\"role\":\"assistant\",\"model\":\"gpt-5\",\"prov\":\"openai\",\"t\":1767348002000,\"part\":{\"type\":\"tool\",\"tool\":\"read\",\"callID\":\"o2\",\"state\":{\"status\":\"completed\",\"input\":{\"filePath\":\"/a\"},\"output\":\"a\",\"time\":{\"start\":1767348002000,\"end\":1767348003000}}}}",
]), want(["bash@claude-opus-4-5", "read@gpt-5"], MQ_MSG));
eq("opencode 2.x", rows("opencode", [
  "{\"type\":\"assistant\",\"time\":{\"created\":1767348000000},\"model\":{\"id\":\"gpt-5\",\"providerID\":\"openai\"},\"content\":[{\"type\":\"tool\",\"name\":\"bash\",\"id\":\"q1\",\"time\":{\"ran\":1767348000000,\"completed\":1767348001000},\"state\":{\"status\":\"completed\",\"input\":{\"command\":\"ls\"},\"output\":\"a\"}}]}",
  "{\"type\":\"assistant\",\"time\":{\"created\":1767348002000},\"model\":{\"id\":\"claude-opus-4-5\",\"providerID\":\"anthropic\"},\"content\":[{\"type\":\"tool\",\"name\":\"read\",\"id\":\"q2\",\"time\":{\"ran\":1767348002000,\"completed\":1767348003000},\"state\":{\"status\":\"completed\",\"input\":{\"filePath\":\"/a\"},\"output\":\"a\"}}]}",
]), want(["bash@gpt-5", "read@claude-opus-4-5"], MQ_MSG));

// fx: only the session's model (session.json via meta), handed to the ledger by the side-file hook that runs before the log
{
  const s = newSess("fx", "f1", "/tmp/agentglass-model-check/none/events.jsonl", false); s.model = "fx-large";
  const a = newAcc(); const side = harnessOf("fx").usageSidecar; if (side) side(s, a);
  harnessOf("fx").usage(a, "{\"seq\":2,\"timestamp_ms\":1767348001000,\"event\":{\"tool_call\":{\"tool_name\":\"shell\",\"call_id\":\"c1\",\"arguments_json\":\"{\\\"command\\\":\\\"ls\\\"}\"}}}");
  eq("fx", dump(a), want(["shell@fx-large"], MQ_SESS));
}

// kiro logs no model at all
eq("kiro", rows("kiro", [
  "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"hello\"}]}}",
  "{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{\"content\":[{\"kind\":\"toolUse\",\"data\":{\"toolUseId\":\"t1\",\"name\":\"shell\",\"input\":{\"command\":\"ls\"}}}]}}",
]), want(["shell@?"], MQ_SESS));

console.log(bad ? bad + " failed" : "per-message model: all checks passed");
if (bad) process.exit(1);
