// agentglass — self-check for kiro usage day attribution: sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { newSess } from "../model/types.ts";
import { newAcc, dayKey } from "../features/usage/record.ts";
import { kiro } from "./kiro.ts";

let bad = 0;
function ok(w: string, c: boolean, g: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + g); } }
const dir = "/tmp/agentglass-kiro-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
function write(p: string, s: string): void { const fd = openSync(p, "w"); writeSync(fd, s); closeSync(fd); }
function two(n: number): string { return (n < 10 ? "0" : "") + String(n); }
// touch -t [[CC]YY]MMDDhhmm[.ss] in local time: POSIX, so the same on Linux and macOS (scriptc has no utimesSync)
function setMtime(p: string, ms: number): void {
  const d = new Date(ms);
  execFileSync("touch", ["-t", String(d.getFullYear()) + two(d.getMonth() + 1) + two(d.getDate()) + two(d.getHours()) + two(d.getMinutes()) + "." + two(d.getSeconds()), p]);
}
const SEP24 = 1790251200000; const SEP15 = 1789473600000; const SEP16 = 1789560000000;
const PROMPT = "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"go\"}]}}";
function call(id: string): string { return "{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{\"content\":[{\"kind\":\"toolUse\",\"data\":{\"toolUseId\":\"" + id + "\",\"name\":\"shell\",\"input\":{\"command\":\"ls\"}}}]}}"; }
const COMPACTION = "{\"version\":\"v1\",\"kind\":\"Compaction\",\"data\":{}}";
function turn(endMs: number): string { return "{\"end_timestamp\":" + String(endMs / 1000) + ",\"input_token_count\":1,\"output_token_count\":1,\"metering_usage\":[]}"; }
// real kiro-cli writes end_timestamp as an ISO-8601 string with nanosecond precision, not a number
function isoTurn(iso: string): string { return "{\"end_timestamp\":\"" + iso + "\",\"input_token_count\":1,\"output_token_count\":1,\"metering_usage\":[]}"; }
// replay one session the way the ledger does: sidecar first, then every transcript line
function days(id: string, lines: string[], turns: string[], jsonMtime: number): Map<string, number> {
  const p = dir + "/" + id + ".jsonl";
  write(p, lines.join("\n") + "\n");
  write(dir + "/" + id + ".json", "{\"session_state\":{\"conversation_metadata\":{\"user_turn_metadatas\":[" + turns.join(",") + "]}}}");
  setMtime(dir + "/" + id + ".json", jsonMtime);
  const s = newSess("kiro", id, p, false); const a = newAcc();
  const side = kiro.usageSidecar; if (side) side(s, a);
  for (const l of lines) kiro.usage(a, l);
  const out = new Map<string, number>();
  for (const [k, d] of a.days) if (d.tools > 0) out.set(k, d.tools);
  return out;
}
function show(m: Map<string, number>): string { let t = ""; for (const [k, v] of m) t += k + "=" + String(v) + " "; return t; }
const today = dayKey(new Date());

// subagents carry no turn metadata: their calls belong to the session's own day, not to today
const sub = days("11111111-1111-1111-1111-111111111111", [PROMPT, call("a"), call("b")], [], SEP24);
ok("subagent calls on the .json day", sub.get(dayKey(new Date(SEP24))) === 2, show(sub));
ok("subagent calls not on today", !sub.has(today) || dayKey(new Date(SEP24)) === today, show(sub));

// a compaction adds a Prompt without a turn entry: prompts outrun turns, the overflow goes to the last real turn
const cmp = days("22222222-2222-2222-2222-222222222222", [PROMPT, call("c"), COMPACTION, PROMPT, call("d"), PROMPT, call("e")], [turn(SEP15), turn(SEP16)], SEP24);
ok("first turn on its day", cmp.get(dayKey(new Date(SEP15))) === 1, show(cmp));
ok("overflow booked on the last turn's day", cmp.get(dayKey(new Date(SEP16))) === 2, show(cmp));
ok("nothing on today", !cmp.has(today), show(cmp));

// real end_timestamp is an ISO-8601 string (nanosecond precision), not a number: calls must still land on the turn's day
const isoS = days("33333333-3333-3333-3333-333333333333", [PROMPT, call("f"), call("g")], [isoTurn("2026-09-15T12:00:00.123456789Z")], SEP24);
ok("ISO-string turn dates calls to its day", isoS.get(dayKey(new Date(SEP15))) === 2, show(isoS));
ok("ISO-string turn not on the .json mtime day", !isoS.has(dayKey(new Date(SEP24))) || dayKey(new Date(SEP15)) === dayKey(new Date(SEP24)), show(isoS));

rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "kiro: all checks passed");
process.exit(bad ? 1 : 0);
