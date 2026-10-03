// agentglass — filter fixture: a small hand-written ledger in real line shapes, for the query, stats, triage and compare checks
// SPDX-License-Identifier: Apache-2.0
// fxBase() (numbers the checks assert against; keep in sync with specs/filter-language/plan.md Task 5):
//   c1  claude /w/agentglass  claude-sonnet-4-5 (priced, 1000 in / 100 out per assistant line)
//       yesterday 09:00 Read README.md ok 0.1 s ×2 · today 14:00 Bash ls ok 2 s · Bash make error 1 s · Bash sleep 100 (no result)
//       · Edit src/a.ts ok 0.2 s (+2 −1)
//   c1s claude /w/agentglass  subagent of c1, today 14:05 Grep error 0.5 s
//   x1  codex  /w/other  gpt-x-unpriced via turn_context (cost unknown; token_count 500/50); today 10:00 exec (npm test; git status)
//       ok 3 s · shell npm run build error 1 s
//   k1  kiro   /w/k  no model; shell ls ok, untimed (kiro lines carry no time → today, Acc.t0 = 0)
// Totals: tools 10, errors 3 · Bash 3/1 Edit 1/0 Grep 1/1 Read 2/0 exec 1/0 shell 2/1 · rows by model: claude-sonnet-4-5 7/2,
// gpt-x-unpriced 2/1, unknown 1/0 · codex programs git 1/0, npm 2/1 · error rates c1 1/6, c1s 1/1, x1 1/2, k1 0/1
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { harnessOf } from "../../harness/index.ts";
import { ledger, accOf, applyAcc } from "../usage/ledger.ts";
import { L, startOfDay } from "../usage/record.ts";

const harnessOfId = new Map<string, string>();
export function fxReset(): void { sessions.clear(); ledger.clear(); harnessOfId.clear(); L.ver++; }
export function pathOf(id: string): string { return "/fx/" + (harnessOfId.get(id) ?? "x") + "/" + id + ".jsonl"; }
// local wall time daysAgo days back → ISO string
export function isoAt(daysAgo: number, hh: number, mm: number): string { return new Date(startOfDay() - daysAgo * 86400000 + (hh * 60 + mm) * 60000).toISOString(); }
function plus(iso: string, ms: number): string { return new Date(Date.parse(iso) + ms).toISOString(); }
// registers a session in sessions + ledger, fed through its adapter's usage() like the ledger does
export function fxSession(h: string, id: string, cwd: string, parent: string, model: string, lines: string[]): Sess {
  harnessOfId.set(id, h);
  const s = newSess(h, id, pathOf(id), false);
  s.cwd = cwd; s.model = model; s.parent = parent; if (parent) s.kind = "general-purpose";
  let size = 0; for (const l of lines) size += l.length + 1;
  s.size = size; s.mtime = Date.now(); s.last = s.mtime;
  sessions.set(s.path, s);
  const a = accOf(s); const ad = harnessOf(h);
  for (const l of lines) ad.usage(a, l);
  a.off = size;
  applyAcc(s, a); L.ver++;
  return s;
}

function q(s: string): string { return JSON.stringify(s); }
let mid = 0;
function claudeCall(iso: string, name: string, id: string, input: string): string {
  mid++;
  return "{\"type\":\"assistant\",\"timestamp\":" + q(iso) + ",\"message\":{\"id\":\"m" + String(mid) + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":" + q(id) + ",\"name\":" + q(name) + ",\"input\":" + input + "}],\"usage\":{\"input_tokens\":1000,\"output_tokens\":100}}}";
}
function claudeResult(iso: string, id: string, err: boolean): string {
  return "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":" + q(id) + (err ? ",\"is_error\":true" : "") + ",\"content\":\"x\"}]},\"uuid\":\"u" + id + "\",\"timestamp\":" + q(iso) + "}";
}
function codex(iso: string, type: string, payload: string): string { return "{\"timestamp\":" + q(iso) + ",\"type\":" + q(type) + ",\"payload\":" + payload + "}"; }

export function fxBase(): void {
  fxReset();
  const y9 = isoAt(1, 9, 0); const t14 = isoAt(0, 14, 0); const t1405 = isoAt(0, 14, 5); const t10 = isoAt(0, 10, 0);
  fxSession("claude", "c1", "/w/agentglass", "", "claude-sonnet-4-5", [
    claudeCall(y9, "Read", "r1", "{\"file_path\":\"/w/agentglass/README.md\"}"), claudeResult(plus(y9, 100), "r1", false),
    claudeCall(plus(y9, 1000), "Read", "r2", "{\"file_path\":\"/w/agentglass/README.md\"}"), claudeResult(plus(y9, 1100), "r2", false),
    claudeCall(t14, "Bash", "b1", "{\"command\":\"ls\"}"), claudeResult(plus(t14, 2000), "b1", false),
    claudeCall(plus(t14, 3000), "Bash", "b2", "{\"command\":\"make\"}"), claudeResult(plus(t14, 4000), "b2", true),
    claudeCall(plus(t14, 5000), "Bash", "b3", "{\"command\":\"sleep 100\"}"),
    claudeCall(plus(t14, 6000), "Edit", "e1", "{\"file_path\":\"/w/agentglass/src/a.ts\",\"old_string\":\"a\",\"new_string\":\"b\\nc\"}"), claudeResult(plus(t14, 6200), "e1", false),
  ]);
  fxSession("claude", "c1s", "/w/agentglass", "c1", "claude-sonnet-4-5", [
    claudeCall(t1405, "Grep", "g1", "{\"pattern\":\"x\"}"), claudeResult(plus(t1405, 500), "g1", true),
  ]);
  fxSession("codex", "x1", "/w/other", "", "gpt-x-unpriced", [
    codex(t10, "turn_context", "{\"model\":\"gpt-x-unpriced\"}"),
    codex(t10, "response_item", "{\"type\":\"custom_tool_call\",\"name\":\"exec\",\"call_id\":\"e1\",\"input\":" + q("tools.exec_command({cmd:\"npm test\"}); tools.exec_command({cmd:\"git status\"})") + "}"),
    codex(plus(t10, 3000), "response_item", "{\"type\":\"custom_tool_call_output\",\"call_id\":\"e1\",\"output\":\"ok\"}"),
    codex(plus(t10, 4000), "response_item", "{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":" + q("{\"command\":[\"bash\",\"-lc\",\"npm run build\"]}") + ",\"call_id\":\"s1\"}"),
    codex(plus(t10, 5000), "response_item", "{\"type\":\"function_call_output\",\"call_id\":\"s1\",\"output\":\"Process exited with code 1\"}"),
    codex(plus(t10, 6000), "event_msg", "{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":500,\"cached_input_tokens\":0,\"output_tokens\":50}}}"),
  ]);
  fxSession("kiro", "k1", "/w/k", "", "", [
    "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"hello\"}]}}",
    "{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{\"content\":[{\"kind\":\"toolUse\",\"data\":{\"toolUseId\":\"k1\",\"name\":\"shell\",\"input\":{\"command\":\"ls\"}}}]}}",
    "{\"version\":\"v1\",\"kind\":\"ToolResults\",\"data\":{\"content\":[{\"kind\":\"toolResult\",\"data\":{\"toolUseId\":\"k1\",\"status\":\"success\",\"content\":[]}}]}}",
  ]);
}
