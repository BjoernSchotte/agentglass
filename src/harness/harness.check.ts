// agentglass — contract check for every registered harness adapter: scriptc build src/harness/harness.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
// A new adapter passes the registry checks as soon as it is in HARNESSES; add a SAMPLES entry with a few real
// log lines (anonymized) and the event kinds and usage they must produce.
import { width } from "../util/text.ts";
import { newSess, type Ev } from "../model/types.ts";
import { BADGE_W, badge } from "../ui/screen.ts";
import { newAcc, bucket, usageExact } from "../features/usage/record.ts";
import { HARNESSES, harnessOf, parseEvents, cmdOf, busy } from "./index.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": " + got); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }

interface Sample { h: string; lines: string[]; kinds: string; tools: number; inTok: number; outTok: number }
const T = "\"timestamp\":\"2026-01-02T10:00:0";
const SAMPLES: Sample[] = [
  { h: "claude", kinds: "user assistant tool result", tools: 1, inTok: 10, outTok: 5, lines: [
    "{\"type\":\"user\"," + T + "0Z\",\"cwd\":\"/w\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}",
    "{\"type\":\"assistant\"," + T + "1Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"},{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}",
    "{\"type\":\"user\"," + T + "2Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"a\"}]}}",
  ] },
  { h: "codex", kinds: "meta user tool result meta", tools: 1, inTok: 60, outTok: 7, lines: [
    "{" + T + "0Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/w\",\"model\":\"gpt-5\"}}",
    "{" + T + "1Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}",
    "{" + T + "2Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}",
    "{" + T + "3Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"ls\\\"]}\",\"call_id\":\"c1\"}}",
    "{" + T + "4Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"c1\",\"output\":\"a\"}}",
    "{" + T + "5Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":40,\"output_tokens\":7}}}}",
    "{" + T + "6Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}",
  ] },
  { h: "fx", kinds: "user tool result meta", tools: 1, inTok: 0, outTok: 0, lines: [
    "{\"seq\":1,\"timestamp_ms\":1767348000000,\"event\":{\"user\":{\"text\":\"hello\"}}}",
    "{\"seq\":2,\"timestamp_ms\":1767348001000,\"event\":{\"tool_call\":{\"tool_name\":\"shell\",\"call_id\":\"c1\",\"arguments_json\":\"{\\\"command\\\":\\\"ls\\\"}\"}}}",
    "{\"seq\":3,\"timestamp_ms\":1767348002000,\"event\":{\"tool_result\":{\"call_id\":\"c1\",\"status\":\"success\",\"preview\":\"a\"}}}",
    "{\"seq\":4,\"timestamp_ms\":1767348003000,\"event\":{\"turn_completed\":{}}}",
  ] },
];

// ── registry: identity, look, commands ──
const ids = new Set<string>();
for (const ad of HARNESSES) {
  const n = ad.id;
  ok(n + " id unique", !ids.has(n), n); ids.add(n);
  ok(n + " id shape", /^[a-z][a-z0-9-]*$/.test(n), n);
  ok(n + " label ≤ 7 cells", ad.label.length > 0 && width(ad.label) <= 7, ad.label);
  ok(n + " glyph 1–2 cells", width(ad.glyph) >= 1 && width(ad.glyph) <= 2, ad.glyph);
  ok(n + " mark 1 cell", width(ad.mark) === 1, ad.mark);
  ok(n + " color r;g;b", /^\d+;\d+;\d+$/.test(ad.color()), ad.color());
  ok(n + " badge " + BADGE_W + " cells", width(plain(badge(n))) === BADGE_W, JSON.stringify(plain(badge(n))));
  ok(n + " bin", ad.bin.length > 0 && cmdOf(n).length > 0, ad.bin);
  ok(n + " procs", ad.procs.length > 0, String(ad.procs.length));
  ok(n + " headBytes", ad.headBytes >= 4096, String(ad.headBytes));
  ok(n + " roots", ad.roots().length > 0, String(ad.roots().length));
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
  ok(sm.h + " no pending calls left", a.pend.size === 0, String(a.pend.size));
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
for (const ad of HARNESSES) ok(ad.id + " has SAMPLES", SAMPLES.some((sm: Sample) => sm.h === ad.id), "add a few real log lines above");

console.log(bad ? bad + " failed" : "harness: all checks passed (" + HARNESSES.length + " adapters)");
process.exit(bad ? 1 : 0);
