// agentglass — contract check for every registered harness adapter: scriptc build src/harness/harness.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
// A new adapter passes the registry checks as soon as it is in HARNESSES; add a SAMPLES entry with a few real
// log lines (anonymized) and the event kinds and usage they must produce.
import { existsSync } from "node:fs";
import { width } from "../util/text.ts";
import { newSess, type Ev } from "../model/types.ts";
import { BADGE_W, badge } from "../ui/screen.ts";
import { type Acc, newAcc, bucket, usageExact } from "../features/usage/record.ts";
import { price, cost } from "../features/usage/pricing.ts";
import { skillUses } from "../features/usage/record.ts";
import { accOut, accIn } from "../features/usage/cache.ts";
import { buildGraph, summary } from "../features/callgraph/model.ts";
import { HARNESSES, harnessOf, parseEvents, cmdOf, busy } from "./index.ts";
import { NOISE_TAGS, isNoise, leadTag } from "./common.ts";
import { classifyUser } from "./claude.ts";

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
  // gemini: lines as its normalizing source emits them (src/harness/gemini.check.ts covers the raw upsert stream)
  { h: "gemini", kinds: "user thinking assistant tool result", tools: 1, inTok: 100, outTok: 15, cost: 0.0000675, lines: [
    "{\"sessionId\":\"0000aaaa-1111-2222-3333-444455556666\",\"projectHash\":\"ab\",\"startTime\":\"2026-01-02T10:00:00.000Z\",\"lastUpdated\":\"2026-01-02T10:00:00.000Z\",\"kind\":\"main\"}",
    "{\"id\":\"u1\",\"timestamp\":\"2026-01-02T10:00:01.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"hello\"}]}",
    "{\"id\":\"g1\",\"timestamp\":\"2026-01-02T10:00:02.000Z\",\"type\":\"gemini\",\"content\":\"hi\",\"thoughts\":[{\"subject\":\"Plan\",\"description\":\"list\",\"timestamp\":\"2026-01-02T10:00:02.000Z\"}],\"model\":\"gemini-2.5-flash\",\"tokens\":{\"input\":100,\"output\":10,\"cached\":0,\"thoughts\":5,\"tool\":0,\"total\":115}}",
    "{\"id\":\"g1\",\"timestamp\":\"2026-01-02T10:00:02.000Z\",\"type\":\"gemini\",\"toolCalls\":[{\"id\":\"run_shell_command__call_1\",\"name\":\"run_shell_command\",\"args\":{\"command\":\"ls\"},\"result\":[{\"functionResponse\":{\"id\":\"run_shell_command__call_1\",\"name\":\"run_shell_command\",\"response\":{\"output\":\"a\"}}}],\"status\":\"success\",\"timestamp\":\"2026-01-02T10:00:03.000Z\"}]}",
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
const sampleTurns = new Map<string, number>();
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
  let tu = 0; for (const dd of a.days.values()) tu += dd.turns;
  const gt = buildGraph([{ evs, live: false, kind: "", spawn: "" }], Date.now()).spans.filter((x) => x.kind === 0 && x.ev >= 0).length; // turns with a prompt, not "earlier turn"
  ok(sm.h + " turns = call graph turns", tu === gt, String(tu) + " ≠ " + String(gt));
  sampleTurns.set(sm.h, (sampleTurns.get(sm.h) ?? 0) + tu);
}
for (const [h, n] of sampleTurns) ok(h + " SAMPLES count a turn", n > 0, String(n));
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
// Claude titles: /rename (custom-title) beats the ai-title Claude re-appends right after it
{
  let n = 0;
  const ct = (t: string, at: string): string => "{\"type\":\"custom-title\",\"customTitle\":" + JSON.stringify(t) + ",\"sessionId\":\"t\",\"timestamp\":\"2026-10-01T" + at + ":00.000Z\"}";
  const ai = (t: string): string => "{\"type\":\"ai-title\",\"aiTitle\":" + JSON.stringify(t) + ",\"sessionId\":\"t\"}";
  const title = (runs: string[][]): string => {
    const s = newSess("claude", "t", "/x/t-" + String(++n) + ".jsonl", false);
    for (const ls of runs) { const evs: Ev[] = []; for (const l of ls) parseEvents("claude", l, evs, s); } // each run = one read window
    return s.title;
  };
  ok("title: ai only", title([[ai("A")]]) === "A", title([[ai("A")]]));
  const t1 = title([[ct("X", "10:00"), ai("A")]]); ok("title: custom then ai", t1 === "X", t1);
  const t2 = title([[ct("X", "10:00"), ai("A"), ct("Y", "10:05"), ai("B")]]); ok("title: latest rename", t2 === "Y", t2);
  const t3 = title([[ct("X", "10:00"), ct("", "10:01"), ai("B")]]); ok("title: renamed to empty", t3 === "B", t3);
  const t4 = title([[ct("Y", "10:05"), ai("B")], [ct("X", "10:00"), ai("A")]]); ok("title: head after tail keeps the newer rename", t4 === "Y", t4);
  const t5 = title([[ct("  ", "10:00")]]); ok("title: blank rename only", t5 === "", t5);
  const t6 = title([[ct("  ", "10:00"), ai("A")]]); ok("title: blank rename then ai", t6 === "A", t6);
}
// Claude user lines: prompts vs task notifications (⟲), peer messages (⇄), shell input, hook/command output
const CU = (extra: string, content: string): string => "{\"type\":\"user\"," + extra + (extra ? "," : "") + "\"timestamp\":\"2026-10-01T10:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":" + JSON.stringify(content) + "}}";
const HUMAN = "\"origin\":{\"kind\":\"human\"},\"turnOrigin\":\"human\",\"promptSource\":\"typed\"";
const NOTE = "<task-notification>\n<task-id>x</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Inventory hook seams\" finished</summary>\n</task-notification>";
const NOTIFY = "\"origin\":{\"kind\":\"task-notification\"},\"turnOrigin\":\"task_notification\",\"promptSource\":\"system\"";
const PEER = "\"origin\":{\"kind\":\"peer\",\"from\":\"template-analyst\",\"name\":\"template-analyst\",\"senderTaskId\":\"t1\",\"body\":\"# Inventory of the template\\n\\nmore\"},\"turnOrigin\":\"peer\",\"promptSource\":\"system\"";
const PEER_TEXT = "Another Claude session sent a message:\n<agent-message from=\"template-analyst\">\n# Inventory of the template\n\nmore\n</agent-message>";
const HANDBACK = "\"origin\":{\"kind\":\"peer\",\"from\":\"aff8aa7c34737900b\",\"senderTaskId\":\"aff8aa7c34737900b\",\"handback\":true,\"body\":\"[Subagent hand-back] The text below is the final report of a subagent. The report follows:\\n  Report done.\\n  more\"},\"promptSource\":\"system\"";
function claudeEvs(lines: string[]): Ev[] { const s = newSess("claude", "u", "/x/u.jsonl", false); const evs: Ev[] = []; for (const l of lines) parseEvents("claude", l, evs, s); return evs; }
function claudeKinds(lines: string[]): string { return claudeEvs(lines).map((e: Ev) => e.kind + ":" + e.text).join("|"); }
{
  const k1 = claudeKinds([CU(HUMAN, "<div>fix this</div>")]); ok("claude: prompt starting with <div>", k1 === "user:<div>fix this</div>", k1);
  const k2 = claudeKinds([CU("", "<div>fix this</div>")]); ok("claude: <div> prompt without origin", k2 === "user:<div>fix this</div>", k2);
  for (const ex of [NOTIFY, ""]) {
    const ev = claudeEvs([CU(ex, NOTE)]);
    const k = ev.map((e: Ev) => e.kind + ":" + e.text + "#" + e.id).join("|");
    ok("claude: task notification " + (ex ? "with" : "without") + " origin", k === "meta:⟲ completed · Agent \"Inventory hook seams\" finished#toolu_1", k);
  }
  const k3 = claudeKinds([CU("\"origin\":{\"kind\":\"auto-continuation\"},\"turnOrigin\":\"auto_continuation\"", "Continue from where you left off.")]); ok("claude: auto-continuation", k3 === "meta:⟲ auto-continue", k3);
  const k4 = claudeKinds([CU(PEER, PEER_TEXT)]); ok("claude: peer message", k4 === "meta:⇄ template-analyst · # Inventory of the template", k4);
  const k5 = claudeKinds([CU("", PEER_TEXT)]); ok("claude: peer message without origin", k5 === "meta:⇄ template-analyst · # Inventory of the template", k5);
  const k6 = claudeKinds([CU(HANDBACK, "Another Claude session sent a message:\n<agent-message from=\"aff8aa7c34737900b\">\n[Subagent hand-back] …\n</agent-message>")]); ok("claude: subagent hand-back", k6 === "meta:⇄ aff8aa7c34737900b · Report done.", k6);
  for (const to of ["sdk", "scheduled"]) { const k = claudeKinds([CU("\"turnOrigin\":\"" + to + "\"", "run the report")]); ok("claude: " + to + " origin is a prompt", k === "user:run the report", k); }
  for (const tag of NOISE_TAGS.concat(["command-message"])) {
    const k = claudeKinds([CU(HUMAN, "<" + tag + ">x</" + tag + ">")]);
    ok("claude: <" + tag + "> with a human origin is no prompt", k.indexOf("user:") < 0, k);
  }
  const k7 = claudeKinds([CU(HUMAN, "<bash-input>git status</bash-input>")]); ok("claude: shell input", k7 === "meta:! git status", k7);
  const k8 = claudeKinds([CU("", "<command-name>/compact</command-name>")]); ok("claude: slash command unchanged", k8 === "meta:/compact", k8);
  const k9 = claudeKinds(["{\"type\":\"user\",\"origin\":{\"kind\":\"human\"},\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<system-reminder>x</system-reminder>\"},{\"type\":\"text\",\"text\":\"<p>real</p>\"}]}}"]);
  ok("claude: text blocks classified one by one", k9 === "user:<p>real</p>", k9);
  ok("classifyUser: unknown origin kind is a prompt", classifyUser({ origin: { kind: "something-new" } }, "hi") === "human", classifyUser({ origin: { kind: "something-new" } }, "hi"));
  ok("isNoise: codex env", isNoise("<environment_context>\n<cwd>/x</cwd>"), "false");
  ok("isNoise: <div> kept", !isNoise("<div>x"), "true");
  ok("isNoise: < 3 kept", !isNoise("< 3 apples"), "true");
  ok("isNoise: AGENTS.md", isNoise("# AGENTS.md instructions"), "false");
  ok("isNoise: task notification", isNoise("<task-notification>\n<status>x</status>"), "false");
  ok("isNoise: empty", isNoise("  \n"), "false");
  ok("leadTag", leadTag("  <skill name=\"x\">") === "skill" && leadTag("<a>") === "a" && leadTag("< a>") === "" && leadTag("x<a>") === "", leadTag("  <skill name=\"x\">"));
}
// Claude fallback: a message with two usage.iterations books each attempt with its own model and tokens, once per message id
{
  const IT = "[{\"type\":\"message\",\"model\":\"claude-fable-5\",\"input_tokens\":3,\"output_tokens\":477,\"cache_read_input_tokens\":938889,\"cache_creation_input_tokens\":1200,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":1200}},"
    + "{\"type\":\"fallback_message\",\"model\":\"claude-opus-4-8\",\"input_tokens\":3,\"output_tokens\":350,\"cache_read_input_tokens\":938889,\"cache_creation_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":0}}]";
  const msg = (id: string, its: string, blk: string): string => "{\"type\":\"assistant\",\"timestamp\":\"2026-10-01T10:00:00.000Z\",\"message\":{\"id\":\"" + id + "\",\"model\":\"claude-opus-4-8\",\"content\":[" + blk + "],"
    + "\"usage\":{\"input_tokens\":3,\"output_tokens\":350,\"cache_read_input_tokens\":938889,\"cache_creation_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":1200}" + (its ? ",\"iterations\":" + its : "") + "}}}";
  const L3 = [msg("m2", IT, "{\"type\":\"thinking\",\"thinking\":\"\"}"), msg("m2", IT, "{\"type\":\"text\",\"text\":\"ok\"}"), msg("m2", IT, "{\"type\":\"tool_use\",\"id\":\"t9\",\"name\":\"Read\",\"input\":{\"file_path\":\"/x\"}}")];
  const pf = price("claude-fable-5"); const po = price("claude-opus-4-8");
  const want = (pf ? cost(pf, 3, 477, 938889, 0, 1200) : 0) + (po ? cost(po, 3, 350, 938889, 0, 0) : 0);
  const wantUnk = (pf ? 0 : 3 + 477 + 938889 + 1200) + (po ? 0 : 3 + 350 + 938889);
  const feed = (a: Acc, ls: string[]): void => { for (const l of ls) harnessOf("claude").usage(a, l); };
  const same = (w: string, a: Acc): void => ok("fallback: " + w, a.outTok === 827 && a.cr === 1877778 && a.cw === 1200 && a.inTok === 6 && Math.abs(a.cost - want) < 1e-9 && a.unk === wantUnk && a.model === "claude-opus-4-8",
    [a.inTok, a.outTok, a.cr, a.cw, a.cost, want, a.unk, wantUnk, a.model].join(" "));
  const a = newAcc(); feed(a, L3); same("both attempts booked", a);
  feed(a, L3); same("lines read again: booked once", a);
  const r = newAcc(); feed(r, L3.slice(1)); same("resumed mid-message: booked once", r);
  const one = newAcc(); feed(one, [msg("m3", "[{\"type\":\"message\",\"model\":\"claude-opus-4-8\",\"input_tokens\":3,\"output_tokens\":350,\"cache_read_input_tokens\":938889}]", "")]);
  ok("fallback: one iteration books the top level", one.outTok === 350 && one.cw === 1200 && one.cr === 938889, one.outTok + " " + one.cw);
  const syn = newAcc(); feed(syn, [msg("m4", "[{\"model\":\"<synthetic>\",\"output_tokens\":5},{\"model\":\"claude-opus-4-8\",\"input_tokens\":1,\"output_tokens\":2}]", "")]);
  ok("fallback: <synthetic> attempt skipped", syn.outTok === 2 && syn.inTok === 1, syn.outTok + " " + syn.inTok);
}
// Claude skills: a slash command paired with its base-directory meta line (same promptId) = command; a Skill tool call = model
const SK_T = "\"timestamp\":\"2026-10-01T10:00:00.000Z\"";
const skCmd = (pid: string, name: string): string => "{\"type\":\"user\",\"promptId\":\"" + pid + "\"," + SK_T + ",\"message\":{\"role\":\"user\",\"content\":" + JSON.stringify("<command-message>" + name + "</command-message>\n<command-name>/" + name + "</command-name>") + "}}";
const skMeta = (pid: string, dir: string, src: string, asStr: boolean): string => {
  const t = "Base directory for this skill: /h/.claude/plugins/x/skills/" + dir + "\n\n# Skill body";
  return "{\"type\":\"user\",\"isMeta\":true,\"promptId\":\"" + pid + "\"," + (src ? "\"sourceToolUseID\":\"" + src + "\"," : "") + SK_T + ",\"message\":{\"role\":\"user\",\"content\":" + (asStr ? JSON.stringify(t) : "[{\"type\":\"text\",\"text\":" + JSON.stringify(t) + "}]") + "}}";
};
function skills(lines: string[], resumeAt: number): string {
  let a = newAcc();
  for (let i = 0; i < lines.length; i++) { if (i === resumeAt) a = accIn(JSON.parse(JSON.stringify(accOut(a)))); harnessOf("claude").usage(a, lines[i] ?? ""); }
  return skillUses(a, null).map((x) => x.source + "\t" + x.name + "=" + String(x.n)).join(",");
}
{
  const s1 = skills([skCmd("p1", "skill-codex:codex"), skMeta("p1", "codex", "", false)], -1); ok("skill: slash command", s1 === "command\tskill-codex:codex=1", s1);
  const s2 = skills([skCmd("p1", "codex"), skMeta("p1", "codex", "", true)], -1); ok("skill: slash command, string meta", s2 === "command\tcodex=1", s2);
  const call = "{\"type\":\"assistant\"," + SK_T + ",\"message\":{\"id\":\"ms\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tu1\",\"name\":\"Skill\",\"input\":{\"skill\":\"superpowers:brainstorming\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}";
  const res = "{\"type\":\"user\",\"promptId\":\"p2\"," + SK_T + ",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tu1\",\"content\":\"Launching skill\"}]}}";
  const ma = newAcc(); for (const l of [skCmd("p0", "other:thing"), call, res, skMeta("p2", "brainstorming", "tu1", false)]) harnessOf("claude").usage(ma, l);
  const s3 = skillUses(ma, null).map((x) => x.source + "\t" + x.name + "=" + String(x.n)).join(",");
  let skRow = 0; for (const d of ma.days.values()) { const t = d.tt.get("Skill"); if (t) skRow += t.n; }
  ok("skill: model-invoked", s3 === "model\tsuperpowers:brainstorming=1" && skRow === 1, s3 + " Skill row " + String(skRow));
  const local = "{\"type\":\"user\",\"promptId\":\"p3\"," + SK_T + ",\"message\":{\"role\":\"user\",\"content\":\"<local-command-stdout>Compacted</local-command-stdout>\"}}";
  const s4 = skills([skCmd("p3", "compact"), local], -1); ok("skill: /compact is none", s4 === "", s4);
  const s5 = skills([skCmd("p4", "x:a"), skMeta("p5", "a", "", false)], -1); ok("skill: other promptId is none", s5 === "", s5);
  const s6 = skills([skCmd("p4", "x:a"), skMeta("p4", "b", "", false)], -1); ok("skill: other directory is none", s6 === "", s6);
  const s7 = skills([skCmd("p6", "x:a"), skMeta("p6", "a", "", false)], 1); ok("skill: ledger resumed between command and meta", s7 === "command\tx:a=1", s7);
  const s8 = skills([skCmd("p7", "x:a"), "{\"type\":\"user\",\"promptId\":\"p8\"," + SK_T + ",\"message\":{\"role\":\"user\",\"content\":\"next prompt\"}}", skMeta("p7", "a", "", false)], -1);
  ok("skill: a later prompt clears the pending command", s8 === "", s8);
}
// Day.turns: Claude counts typed, sdk and scheduled prompts — not notifications, peer messages, slash commands or hook output
{
  const TL = [CU(HUMAN, "fix the bug"), CU(NOTIFY, NOTE), CU("", NOTE), CU(PEER, PEER_TEXT), CU("", "<command-name>/compact</command-name>"),
    CU(HUMAN, "<system-reminder>x</system-reminder>"), CU("\"turnOrigin\":\"sdk\"", "run it"), CU("\"turnOrigin\":\"scheduled\"", "nightly"),
    "{\"type\":\"user\",\"isMeta\":true," + SK_T + ",\"message\":{\"role\":\"user\",\"content\":\"meta text\"}}"];
  const count = (resumeAt: number): number => {
    let a = newAcc();
    for (let i = 0; i < TL.length; i++) { if (i === resumeAt) a = accIn(JSON.parse(JSON.stringify(accOut(a)))); harnessOf("claude").usage(a, TL[i] ?? ""); }
    let n = 0; for (const d of a.days.values()) n += d.turns; return n;
  };
  ok("claude turns", count(-1) === 3, String(count(-1)));
  ok("claude turns across a ledger resume", count(4) === 3, String(count(4)));
  const gt = summary(buildGraph([{ evs: claudeEvs(TL), live: false, kind: "", spawn: "" }], Date.now())).turns;
  ok("claude turns = call graph turns", gt === 3, String(gt));
}
// Codex skills: Codex injects <skill> only for an explicit $name mention (codex-rs skills/injection.rs) → command; OpenCode skill rows → model
{
  const cx = (t: string, at: string): string => "{\"timestamp\":\"2026-10-01T10:00:0" + at + ".000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":" + JSON.stringify(t) + "}]}}";
  const a = newAcc(); const ad = harnessOf("codex");
  for (const l of [cx("use $agtest-hello", "1"), cx("<skill>\n<name>agtest-hello</name>\n<path>/h/.codex/skills/agtest-hello/SKILL.md</path>\nAnswer hello\n</skill>", "2"), cx("<environment_context>x</environment_context>", "3")]) ad.usage(a, l);
  const u = skillUses(a, null).map((x) => x.source + "\t" + x.name + "=" + String(x.n)).join(",");
  let tu = 0; for (const d of a.days.values()) tu += d.turns;
  ok("codex: <skill> message is a command skill use, not a turn", u === "command\tagtest-hello=1" && tu === 1, u + " turns " + String(tu));
  const evs: Ev[] = []; parseEvents("codex", cx("<skill>\n<name>x</name>\n</skill>", "4"), evs, null);
  ok("codex: <skill> message stays out of the transcript", evs.length === 0, JSON.stringify(evs));
  const o = newAcc();
  harnessOf("opencode").usage(o, "{\"type\":\"skill\",\"seq\":4,\"name\":\"brainstorming\",\"time\":{\"created\":1790688000000}}");
  harnessOf("opencode").usage(o, "{\"type\":\"skill\",\"seq\":5,\"name\":\"brainstorming\",\"copied\":1,\"time\":{\"created\":1790688000000}}");
  const ou = skillUses(o, null).map((x) => x.source + "\t" + x.name + "=" + String(x.n)).join(",");
  ok("opencode: skill row is a model skill use, a fork's copy is not", ou === "model\tbrainstorming=1", ou);
}
// Codex remote: scrubbed at parse time, the raw repository_url is never stored
{
  const rem = (u: string): string => {
    const s = newSess("codex", "r", "/x/r.jsonl", false); const evs: Ev[] = [];
    parseEvents("codex", "{\"timestamp\":\"2026-10-01T10:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/w\",\"git\":{\"branch\":\"main\"" + (u ? ",\"repository_url\":" + JSON.stringify(u) : "") + "}}}", evs, s);
    ok("codex remote: no credential in the session (" + u + ")", JSON.stringify(s).indexOf("ghs_") < 0, JSON.stringify(s));
    return s.remote;
  };
  const r1 = rem("https://x-access-token:ghs_abc123@github.com/o/r.git"); ok("codex remote: token in userinfo", r1 === "https://github.com/o/r", r1);
  const r2 = rem("https://host/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8"); ok("codex remote: hash-like repo kept", r2 === "https://host/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8", r2);
  const r3 = rem("https://host/o/r?token=ghs_x"); ok("codex remote: token in query", r3 === "https://host/o/r", r3);
  const r4 = rem(""); ok("codex remote: none", r4 === "", r4);
  const r5 = rem("https://host/o%40ghs_x/r"); ok("codex remote: suspicious → dropped", r5 === "", r5);
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
for (const id of ["claude", "codex", "fx", "pi", "opencode", "kiro", "gemini"]) ok(id + " registered", HARNESSES.some((a) => a.id === id), "missing");
// a DB-backed adapter (own source) has no log lines to sample: its golden coverage is src/harness/<id>.check.ts
for (const ad of HARNESSES) ok(ad.id + " has SAMPLES", ad.source ? existsSync("src/harness/" + ad.id + ".check.ts") : SAMPLES.some((sm: Sample) => sm.h === ad.id), "add a few real log lines above");

console.log(bad ? bad + " failed" : "harness: all checks passed (" + HARNESSES.length + " adapters)");
process.exit(bad ? 1 : 0);
