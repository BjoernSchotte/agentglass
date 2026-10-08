// agentglass — Codex runs that outlive their call (yields): the call's row and day sums extend to the run's real end
// SPDX-License-Identifier: Apache-2.0
// Hand-written lines in the shapes Codex 0.160 writes (JS exec cells, wait, item_completed CommandExecution) and the older
// exec_command / write_stdin ones; commands are generic, no real session content.
import { newAcc, heavy, spanMin } from "../features/usage/record.ts";
import { harnessOf } from "./index.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }

const T0 = Date.parse("2026-10-04T08:04:00.000Z");
function iso(ms: number): string { return new Date(T0 + ms).toISOString(); }
function ln(ms: number, type: string, payload: string): string { return "{\"timestamp\":\"" + iso(ms) + "\",\"type\":\"" + type + "\",\"payload\":" + payload + "}"; }
function exec(ms: number, id: string, cmd: string): string {
  const js = "// @exec: {\"yield_time_ms\": 30000}\nconst r=await tools.exec_command({cmd:" + JSON.stringify(cmd) + ",workdir:\"/w/app\",yield_time_ms:30000});text(JSON.stringify(r))";
  return ln(ms, "response_item", "{\"type\":\"custom_tool_call\",\"status\":\"completed\",\"call_id\":\"" + id + "\",\"name\":\"exec\",\"input\":" + JSON.stringify(js) + "}");
}
// output: a plain text (a JSON string) or the array of input_text parts (chunk(): raw JSON), as Codex writes them
function out(ms: number, id: string, kind: string, text: string): string { return ln(ms, "response_item", "{\"type\":\"" + kind + "\",\"call_id\":\"" + id + "\",\"output\":" + (text.startsWith("[") ? text : JSON.stringify(text)) + "}"); }
function chunk(o: string): string { return JSON.stringify([{ type: "input_text", text: "Script completed\nWall time 2.0 seconds\nOutput:\n" }, { type: "input_text", text: o }]); }
function fcall(ms: number, id: string, name: string, args: string): string { return ln(ms, "response_item", "{\"type\":\"function_call\",\"name\":\"" + name + "\",\"arguments\":" + JSON.stringify(args) + ",\"call_id\":\"" + id + "\"}"); }
function cmdEnd(ms: number, s0: number, s1: number, cmd: string, code: number, pid: string): string {
  return ln(ms, "event_msg", "{\"type\":\"item_completed\",\"thread_id\":\"th\",\"turn_id\":\"tu\",\"item\":{\"type\":\"CommandExecution\",\"id\":\"exec-" + pid + "\",\"process_id\":\"" + pid + "\",\"command\":[\"/bin/zsh\",\"-lc\"," + JSON.stringify(cmd) +
    "],\"cwd\":\"/w/app\",\"parsed_cmd\":[],\"source\":\"unified_exec_startup\",\"status\":\"" + (code ? "failed" : "completed") + "\",\"stdout\":\"\",\"stderr\":\"\",\"aggregated_output\":\"exit_code\\\":9 not this one\",\"exit_code\":" + String(code) + "},\"started_at_ms\":" + String(T0 + s0) + ",\"completed_at_ms\":" + String(T0 + s1) + "}");
}

const a = newAcc(); a.p = "/x/rollout-2026-10-04T08-00-00-0000.jsonl";
const ad = harnessOf("codex");
const lines: string[] = [
  ln(0, "turn_context", "{\"model\":\"gpt-5.5\",\"cwd\":\"/w/app\"}"),
  // 1. a cell yields while its test run goes on; a wait sees the cell complete, the command itself ends much later
  exec(0, "c1", "pnpm test"),
  out(31000, "c1", "custom_tool_call_output", "Script running with cell ID 7\nWall time 31.0 seconds\nOutput:\n"),
  fcall(35000, "w1", "wait", "{\"cell_id\":\"7\",\"yield_time_ms\":30000}"),
  out(36000, "w1", "function_call_output", chunk("{\"chunk_id\":\"ab\",\"wall_time_seconds\":30.0,\"session_id\":4242,\"output\":\"…\"}")),
  // 2. a plain call in between (finished at once): its own command's end must not stretch call 1
  exec(40000, "c2", "git status"),
  cmdEnd(40500, 40100, 40400, "git status", 0, "11"),
  out(40600, "c2", "custom_tool_call_output", chunk("{\"chunk_id\":\"cd\",\"wall_time_seconds\":0.3,\"exit_code\":0,\"output\":\"clean\"}")),
  cmdEnd(395000, 400, 395000, "pnpm test", 0, "4242"),
  // 3. a cell that finished at once while its command runs on (session_id in the chunk), and fails later
  exec(400000, "c3", "cargo build"),
  out(402000, "c3", "custom_tool_call_output", chunk("{\"chunk_id\":\"ef\",\"wall_time_seconds\":1.0,\"session_id\":5151,\"output\":\"Compiling\"}")),
  cmdEnd(520000, 400300, 520000, "cargo build", 101, "5151"),
  // 4. the older exec_command: "Process running with session ID", polled by write_stdin until it exits
  fcall(600000, "c4", "exec_command", "{\"cmd\":\"npx tsc --noEmit\",\"yield_time_ms\":1000}"),
  out(601000, "c4", "function_call_output", "Chunk ID: x1\nWall time: 1.0016 seconds\nProcess running with session ID 777\nOriginal token count: 0\nOutput:\n"),
  fcall(630000, "p1", "write_stdin", "{\"session_id\":777,\"chars\":\"\",\"yield_time_ms\":10000}"),
  out(640000, "p1", "function_call_output", "Chunk ID: x2\nWall time: 10.0 seconds\nProcess running with session ID 777\nOutput:\n"),
  fcall(650000, "p2", "write_stdin", "{\"session_id\":777,\"chars\":\"\",\"yield_time_ms\":30000}"),
  out(690000, "p2", "function_call_output", "Chunk ID: x3\nWall time: 40.0 seconds\nProcess exited with code 2\nOriginal token count: 3\nOutput:\nerr"),
  // 5. a finished call: nothing to extend
  exec(700000, "c5", "ls"),
  cmdEnd(700300, 700100, 700200, "ls", 0, "12"),
  out(700400, "c5", "custom_tool_call_output", chunk("{\"chunk_id\":\"gh\",\"wall_time_seconds\":0.1,\"exit_code\":0,\"output\":\"a\"}")),
  // 6. a dev server the turn leaves running: a background process, its call keeps the yield's duration
  exec(800000, "c6", "pnpm dev"),
  out(831000, "c6", "custom_tool_call_output", "Script running with cell ID 9\nWall time 31.0 seconds\nOutput:\n"),
  ln(900000, "event_msg", "{\"type\":\"task_complete\",\"turn_id\":\"tu\"}"),
  cmdEnd(9000000, 800200, 9000000, "pnpm dev", 130, "6262"),
  // 7. a resumed Codex numbers its cells from 1 again: an old open cell 3 is not the new one
  exec(9100000, "c7", "npm test"),
  out(9131000, "c7", "custom_tool_call_output", "Script running with cell ID 3\nWall time 31.0 seconds\nOutput:\n"),
  exec(9900000, "c8", "npm test"),
  out(9931000, "c8", "custom_tool_call_output", "Script running with cell ID 3\nWall time 31.0 seconds\nOutput:\n"),
  fcall(9935000, "w8", "wait", "{\"cell_id\":\"3\"}"),
  out(9960000, "w8", "function_call_output", "Script completed\nWall time 25.0 seconds\nOutput:\nok"),
  // 8. the older format: a watcher the agent stops with ^C keeps its yield's duration too
  fcall(10000000, "c9", "exec_command", "{\"cmd\":\"npx vite\",\"yield_time_ms\":1000}"),
  out(10001000, "c9", "function_call_output", "Chunk ID: y1\nWall time: 1.0 seconds\nProcess running with session ID 888\nOriginal token count: 0\nOutput:\n"),
  fcall(10600000, "k1", "write_stdin", "{\"session_id\":888,\"chars\":\"\\u0003\",\"yield_time_ms\":1000}"),
  out(10601000, "k1", "function_call_output", "Chunk ID: y2\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n"),
];
for (const l of lines) ad.usage(a, l);
const r = a.rows; const rs: string[] = [];
for (let i = 0; i < r.n; i++) rs.push(String(r.cid[i] ?? "") + " " + String(r.ms[i]) + " " + String(r.err[i]));
eq("rows: durations and results", rs.join(" | "), "c1 395000 0 | w1 1000 0 | c2 600 0 | c3 120000 1 | c4 90000 1 | p1 10000 0 | p2 40000 1 | c5 400 0 | c6 31000 0 | c7 31000 0 | c8 60000 0 | w8 25000 0 | c9 1000 0 | k1 1000 0");
let ms = 0; let n = 0; let err = 0; let dn = 0;
for (const d of a.days.values()) { const st = heavy(d).tt.get("exec"); if (st) { ms += st.ms; n += st.n; err += st.err; dn += st.dn; } }
eq("day sums of exec moved, not doubled", String(n) + " " + String(dn) + " " + String(ms) + " " + String(err), "7 7 " + String(395000 + 600 + 120000 + 400 + 31000 + 31000 + 60000) + " 1");
let act = 0; for (const d of a.days.values()) act += spanMin(d.act);
eq("active time covers the runs", String(act >= Math.floor((395000 + 120000 + 90000) / 60000)), "true");

console.log(bad ? bad + " failed" : "codex yields: all checks passed");
if (bad) process.exit(1);
