// agentglass — contract check for every registered harness adapter: scriptc build src/harness/harness.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
// A new adapter passes the registry checks as soon as it is in HARNESSES; add a SAMPLES entry with a few real
// log lines (anonymized) and the event kinds and usage they must produce.
import { existsSync } from "node:fs";
import { width } from "../util/text.ts";
import { newSess, type Ev } from "../model/types.ts";
import { BADGE_W, badge } from "../ui/screen.ts";
import { newAcc, bucket, usageExact } from "../features/usage/record.ts";
import { HARNESSES, harnessOf, parseEvents, cmdOf, busy } from "./index.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": " + got); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }

interface Sample { h: string; lines: string[]; kinds: string; tools: number; inTok: number; outTok: number; cost: number }
const T = "\"timestamp\":\"2026-01-02T10:00:0";
const SAMPLES: Sample[] = [
  { h: "claude", kinds: "user assistant tool result", tools: 1, inTok: 10, outTok: 5, cost: 0.000105, lines: [
    "{\"type\":\"user\"," + T + "0Z\",\"cwd\":\"/w\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}",
    "{\"type\":\"assistant\"," + T + "1Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"},{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}",
    "{\"type\":\"user\"," + T + "2Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"a\"}]}}",
  ] },
  { h: "codex", kinds: "meta user tool result meta", tools: 1, inTok: 60, outTok: 7, cost: 0, lines: [
    "{" + T + "0Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/w\",\"model\":\"gpt-5\"}}",
    "{" + T + "1Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}",
    "{" + T + "2Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}",
    "{" + T + "3Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"ls\\\"]}\",\"call_id\":\"c1\"}}",
    "{" + T + "4Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"c1\",\"output\":\"a\"}}",
    "{" + T + "5Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":40,\"output_tokens\":7}}}}",
    "{" + T + "6Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}",
  ] },
  { h: "fx", kinds: "user tool result meta", tools: 1, inTok: 0, outTok: 0, cost: 0, lines: [
    "{\"seq\":1,\"timestamp_ms\":1767348000000,\"event\":{\"user\":{\"text\":\"hello\"}}}",
    "{\"seq\":2,\"timestamp_ms\":1767348001000,\"event\":{\"tool_call\":{\"tool_name\":\"shell\",\"call_id\":\"c1\",\"arguments_json\":\"{\\\"command\\\":\\\"ls\\\"}\"}}}",
    "{\"seq\":3,\"timestamp_ms\":1767348002000,\"event\":{\"tool_result\":{\"call_id\":\"c1\",\"status\":\"success\",\"preview\":\"a\"}}}",
    "{\"seq\":4,\"timestamp_ms\":1767348003000,\"event\":{\"turn_completed\":{}}}",
  ] },
  // pi: real 0.87.1 lines, text trimmed; system message skipped, model/thinking changes and session_info emit nothing; cost = pi's own usage.cost.total
  { h: "pi", kinds: "user tool result assistant", tools: 1, inTok: 4, outTok: 294, cost: 0.0177639, lines: [
    "{\"type\":\"session\",\"version\":3,\"id\":\"01a0ed51-2b3c-77d8-a26f-e5786854dc13\",\"timestamp\":\"2026-09-29T13:18:34.813Z\",\"cwd\":\"/tmp/agtest-pi\"}",
    "{\"type\":\"model_change\",\"id\":\"a9246d12\",\"parentId\":null,\"timestamp\":\"2026-09-29T13:18:34.859Z\",\"provider\":\"cliproxy\",\"modelId\":\"claude-sonnet-5-5\"}",
    "{\"type\":\"message\",\"id\":\"50ec715a\",\"parentId\":\"751a89bd\",\"timestamp\":\"2026-09-29T13:18:34.865Z\",\"message\":{\"role\":\"system\",\"content\":\"\",\"sections\":{\"preamble\":\"You are an expert coding assistant\"},\"timestamp\":1790687914864,\"toolsAdded\":[{\"name\":\"read\",\"description\":\"Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit firs…\",\"parameters\":{\"type\":\"object\",\"required\":[\"path\"],\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Path to the file to read (relative or absolute)\"},\"offset\":{\"type\":\"number\",\"description\":\"Line number to start reading from (1-indexed)\"},\"limit\":{\"type\":\"number\",\"description\":\"Maximum number of lines to read\"}}},\"constrainedSampling\":{\"type\":\"json_schema\",\"strict\":\"prefer\"}},{\"name\":\"bash\",\"description\":\"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a tem…\",\"parameters\":{\"type\":\"object\",\"required\":[\"command\"],\"properties\":{\"command\":{\"type\":\"string\",\"description\":\"Shell command to execute\"},\"timeout\":{\"type\":\"number\",\"description\":\"Timeout in seconds (optional, no default timeout)\"}}},\"constrainedSampling\":{\"type\":\"json_schema\",\"strict\":\"prefer\"}},{\"name\":\"edit\",\"description\":\"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge the…\",\"parameters\":{\"type\":\"object\",\"required\":[\"path\",\"edits\"],\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Path to the file to edit (relative or absolute)\"},\"edits\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"required\":[\"oldText\",\"newText\"],\"properties\":{\"oldText\":{\"type\":\"string\",\"description\":\"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.\"},\"newText\":{\"type\":\"string\",\"description\":\"Replacement text for this targeted edit.\"}}},\"description\":\"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, m…\"}}},\"constrainedSampling\":{\"type\":\"json_schema\",\"strict\":\"prefer\"}},{\"name\":\"write\",\"description\":\"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.\",\"parameters\":{\"type\":\"object\",\"required\":[\"path\",\"content\"],\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Path to the file to write (relative or absolute)\"},\"content\":{\"type\":\"string\",\"description\":\"Content to write to the file\"}}},\"constrainedSampling\":{\"type\":\"json_schema\",\"strict\":\"prefer\"}}]}}",
    "{\"type\":\"message\",\"id\":\"fd3651d6\",\"parentId\":\"50ec715a\",\"timestamp\":\"2026-09-29T13:18:34.865Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Build a minimal todo web app (single index.html + app.js, lo\"}],\"timestamp\":1790687914863}}",
    "{\"type\":\"message\",\"id\":\"38d3c65e\",\"parentId\":\"a2d6f39b\",\"timestamp\":\"2026-09-29T13:18:42.745Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"toolu_01CCQ6KhVwgdzfmgU113pmR8\",\"name\":\"bash\",\"arguments\":{\"command\":\"cd /tmp/agtest-pi && node --check app.js && echo \\\"syntax OK\\\"\"}}],\"api\":\"anthropic-messages\",\"provider\":\"cliproxy\",\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input\":2,\"output\":86,\"cacheRead\":8488,\"cacheWrite\":1217,\"totalTokens\":9793,\"cost\":{\"input\":0.000006,\"output\":0.0012900000000000001,\"cacheRead\":0.0025464,\"cacheWrite\":0.007302,\"total\":0.0111444},\"cacheWrite1h\":1217,\"reasoning\":0},\"stopReason\":\"toolUse\",\"timestamp\":1790687921353,\"responseId\":\"msg_011CfXoAoUL7fErkQy98h494\",\"rawStopReason\":\"tool_use\"}}",
    "{\"type\":\"message\",\"id\":\"6b1913a3\",\"parentId\":\"38d3c65e\",\"timestamp\":\"2026-09-29T13:18:42.768Z\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"toolu_01CCQ6KhVwgdzfmgU113pmR8\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"syntax OK\\n\"}],\"isError\":false,\"timestamp\":1790687922768}}",
    "{\"type\":\"message\",\"id\":\"1bd1e991\",\"parentId\":\"6b1913a3\",\"timestamp\":\"2026-09-29T13:18:45.198Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"I created the todo app in `/tmp/agtest-pi/`, and `node --che\"}],\"api\":\"anthropic-messages\",\"provider\":\"cliproxy\",\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input\":2,\"output\":208,\"cacheRead\":9705,\"cacheWrite\":97,\"totalTokens\":10012,\"cost\":{\"input\":0.000006,\"output\":0.00312,\"cacheRead\":0.0029115,\"cacheWrite\":0.000582,\"total\":0.0066194999999999995},\"cacheWrite1h\":97,\"reasoning\":0},\"stopReason\":\"stop\",\"timestamp\":1790687922769,\"responseId\":\"msg_011CfXoAuhNzVY7H3wJkUvvX\",\"rawStopReason\":\"end_turn\"}}",
    "{\"type\":\"session_info\",\"id\":\"si000001\",\"parentId\":\"a\",\"timestamp\":\"2026-09-29T13:18:43.000Z\",\"name\":\"todo app\"}",
  ] },
  // pi fork: entries older than the header are copies of the parent, only the newer entry counts
  { h: "pi", kinds: "tool result tool result", tools: 1, inTok: 2, outTok: 86, cost: 0.0111444, lines: [
    "{\"type\":\"session\",\"version\":3,\"id\":\"01a0ed51-2b3c-77d8-a26f-e5786854dc13\",\"timestamp\":\"2026-09-29T13:30:00.000Z\",\"cwd\":\"/tmp/agtest-pi\",\"parentSession\":\"/home/u/.pi/agent/sessions/--tmp--/p.jsonl\"}",
    "{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"2026-09-29T13:18:42.745Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"old1\",\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}],\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input\":2,\"output\":208,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":210,\"cost\":{\"total\":0.0066195}},\"stopReason\":\"toolUse\"}}",
    "{\"type\":\"message\",\"id\":\"e2\",\"parentId\":null,\"timestamp\":\"2026-09-29T13:18:42.768Z\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"old1\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"a\"}],\"isError\":false}}",
    "{\"type\":\"message\",\"id\":\"e3\",\"parentId\":null,\"timestamp\":\"2026-09-29T13:30:05.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"new1\",\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}],\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input\":2,\"output\":86,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":88,\"cost\":{\"total\":0.0111444}},\"stopReason\":\"toolUse\"}}",
    "{\"type\":\"message\",\"id\":\"e4\",\"parentId\":null,\"timestamp\":\"2026-09-29T13:30:05.020Z\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"new1\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"a\"}],\"isError\":false}}",
  ] },
  { h: "kiro", kinds: "user assistant tool result meta", tools: 1, inTok: 0, outTok: 0, cost: 0, lines: [
    "{\"version\":\"v1\",\"kind\":\"Prompt\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"hello\"}]}}",
    "{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{\"content\":[{\"kind\":\"text\",\"data\":\"hi\"},{\"kind\":\"toolUse\",\"data\":{\"toolUseId\":\"t1\",\"name\":\"shell\",\"input\":{\"command\":\"ls\",\"__tool_use_purpose\":\"list\"}}}]}}",
    "{\"version\":\"v1\",\"kind\":\"ToolResults\",\"data\":{\"content\":[{\"kind\":\"toolResult\",\"data\":{\"toolUseId\":\"t1\",\"status\":\"success\",\"content\":[{\"kind\":\"text\",\"data\":\"a\"}]}}]}}",
    "{\"version\":\"v1\",\"kind\":\"Compaction\",\"data\":{}}",
  ] },
];

// ── registry: identity, look, commands ──
const ids = new Set<string>();
for (const ad of HARNESSES) {
  const n = ad.id;
  ok(n + " id unique", !ids.has(n), n); ids.add(n);
  ok(n + " id shape", /^[a-z][a-z0-9-]*$/.test(n), n);
  ok(n + " label ≤ 8 cells, ≤ 7 in the default badge", ad.label.length > 0 && width(ad.label) <= 8 && (!!ad.badge || width(ad.label) <= 7), ad.label);
  ok(n + " glyph 1–2 cells", width(ad.glyph) >= 1 && width(ad.glyph) <= 2, ad.glyph);
  ok(n + " mark 1 cell", width(ad.mark) === 1, ad.mark);
  ok(n + " color r;g;b", /^\d+;\d+;\d+$/.test(ad.color()), ad.color());
  ok(n + " badge " + BADGE_W + " cells", width(plain(badge(n))) === BADGE_W, JSON.stringify(plain(badge(n))));
  ok(n + " bin", ad.bin.length > 0 && cmdOf(n).length > 0, ad.bin);
  ok(n + " procs", ad.procs.length > 0, String(ad.procs.length));
  ok(n + " headBytes", ad.headBytes >= 4096, String(ad.headBytes));
  ok(n + " roots or search", ad.roots().length > 0 || !!ad.search, String(ad.roots().length)); // a DB-backed adapter searches itself
  const s = newSess(n, "ID1", "/nonexistent/ID1.jsonl", false);
  const hl = ad.headless; if (hl) { const c = hl(s, "MSG"); ok(n + " headless names the session and message", c.join(" ").indexOf("ID1") >= 0 && c.indexOf("MSG") >= 0, c.join(" ")); }
  const rs = ad.resume; if (rs) ok(n + " resume names the session", rs(s).join(" ").indexOf("ID1") >= 0, rs(s).join(" "));
  const fl = ad.files; if (fl) ok(n + " files include the transcript or its dir", fl(s).some((f: string) => s.path.startsWith(f)), fl(s).join(" "));
  // robustness: junk must never throw
  const out: Ev[] = [];
  for (const l of ["", "{}", "[]", "null", "{\"type\":42}", "{\"payload\":null,\"event\":\"x\",\"kind\":7}", "not json", "{\"message\":{\"content\":[null,1,{}]}}"]) {
    parseEvents(n, l, out, s); ad.usage(newAcc(), l);
  }
  ok(n + " idle without events", !busy(s), "busy");
}

// ── golden samples: events and usage ──
for (const sm of SAMPLES) {
  const ad = harnessOf(sm.h);
  const s = newSess(sm.h, "S1", "/tmp/agentglass-check/S1.jsonl", false);
  const evs: Ev[] = [];
  const a = newAcc();
  for (const l of sm.lines) { parseEvents(sm.h, l, evs, s); ad.usage(a, l); }
  const kinds = evs.map((e: Ev) => e.kind).join(" ");
  ok(sm.h + " event kinds", kinds === sm.kinds, kinds + " ≠ " + sm.kinds);
  const call = evs.find((e: Ev) => e.kind === "tool"); const res = evs.find((e: Ev) => e.kind === "result");
  ok(sm.h + " call ↔ result paired by id", !!call && !!res && call.id !== "" && call.id === res.id, (call ? call.id : "-") + "/" + (res ? res.id : "-"));
  ok(sm.h + " tool text is name\\0arg", !!call && call.text.indexOf("\u0000") > 0, call ? JSON.stringify(call.text) : "-");
  ok(sm.h + " usage tools", a.tools === sm.tools, String(a.tools));
  ok(sm.h + " usage tokens", a.inTok === sm.inTok && a.outTok === sm.outTok, a.inTok + "/" + a.outTok);
  ok(sm.h + " usage cost", Math.abs(a.cost - sm.cost) < 1e-9, String(a.cost) + " ≠ " + String(sm.cost));
  ok(sm.h + " no pending calls left", a.pend.size === 0, String(a.pend.size));
}
// pi busy: decided from the tail's events alone — the head (first 256 KB, parsed after the tail) must not change it
{
  let n = 0;
  const line = (msg: string): string => "{\"type\":\"message\",\"id\":\"m" + String(++n) + "\",\"parentId\":null,\"timestamp\":\"2026-09-29T13:30:00.000Z\",\"message\":" + msg + "}";
  const USER = "{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"go\"}]}";
  const IMG = "{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"data\":\"AAAA\",\"mimeType\":\"image/png\"}]}";
  const CALL = "{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"c1\",\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}],\"stopReason\":\"toolUse\"}";
  const RES = "{\"role\":\"toolResult\",\"toolCallId\":\"c1\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"" + "x".repeat(300000) + "\"}],\"isError\":false}";
  const STOP = "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"stopReason\":\"stop\"}";
  const ABORT = "{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"aborted\",\"errorMessage\":\"Request was aborted\"}";
  const BASH = "{\"role\":\"bashExecution\",\"command\":\"ls\",\"output\":\"a\",\"exitCode\":0,\"cancelled\":false,\"truncated\":false,\"timestamp\":1}";
  const piBusy = (tail: string[], head: string[]): boolean => {
    const s = newSess("pi", "PB" + String(n), "/tmp/agentglass-check/pb" + String(n) + ".jsonl", false);
    const evs: Ev[] = []; for (const m of tail) parseEvents("pi", line(m), evs, s);
    s.evs = evs; // loadTail, then render → loadHead
    const hv: Ev[] = []; for (const m of head) parseEvents("pi", line(m), hv, s);
    return busy(s);
  };
  ok("pi busy: head after tail keeps a settled turn idle", !piBusy([CALL, RES, STOP], [USER, CALL]), "busy");
  ok("pi busy: user prompt", piBusy([STOP, USER], []), "idle");
  ok("pi busy: tool call", piBusy([USER, CALL], []), "idle");
  ok("pi busy: tool result", piBusy([USER, CALL, RES], [USER, CALL, RES, STOP]), "idle");
  ok("pi busy: stop", !piBusy([USER, STOP], []), "busy");
  ok("pi busy: aborted", !piBusy([USER, CALL, ABORT], []), "busy");
  ok("pi busy: a trailing !bash is not a turn", !piBusy([USER, STOP, BASH], []), "busy");
  ok("pi busy: !bash then a prompt", piBusy([BASH, USER], []), "idle");
  ok("pi busy: image-only prompt", piBusy([STOP, IMG], []), "idle");
  const iv: Ev[] = []; parseEvents("pi", line(IMG), iv, null);
  ok("pi: image-only prompt is a user event", iv.length === 1 && iv[0].kind === "user" && iv[0].text === "[image]", JSON.stringify(iv));
  ok("pi busy: no events", !piBusy([], [USER, CALL]), "busy");
}
// usageExact: the harness's own cost is booked as is; 0 (unknown model) falls back to the price table
{
  const a = newAcc(); const d = bucket(a, 0, "2026-01-02T10:00:00Z");
  usageExact(a, d, "claude-sonnet-4-5", 1000, 500, 0, 0, 0, 0.5);
  ok("usageExact books the reported cost", a.cost === 0.5 && d.cost === 0.5 && a.inTok === 1000 && a.outTok === 500 && a.unk === 0, String(a.cost));
  const b = newAcc(); const e = bucket(b, 0, "2026-01-02T10:00:00Z");
  usageExact(b, e, "claude-sonnet-4-5", 1000, 500, 0, 0, 0, 0);
  ok("usageExact with cost 0 books the table price", b.cost > 0 && e.cost === b.cost && b.unk === 0, String(b.cost));
  const c = newAcc(); const g = bucket(c, 0, "2026-01-02T10:00:00Z");
  usageExact(c, g, "no-such-model", 10, 5, 0, 0, 0, 0);
  ok("usageExact with cost 0 and unknown model counts unpriced tokens", c.cost === 0 && c.unk === 15, String(c.unk));
}
// a DB-backed adapter (own source) has no log lines to sample: its golden coverage is src/harness/<id>.check.ts
for (const ad of HARNESSES) ok(ad.id + " has SAMPLES", ad.source ? existsSync("src/harness/" + ad.id + ".check.ts") : SAMPLES.some((sm: Sample) => sm.h === ad.id), "add a few real log lines above");

console.log(bad ? bad + " failed" : "harness: all checks passed (" + HARNESSES.length + " adapters)");
process.exit(bad ? 1 : 0);
