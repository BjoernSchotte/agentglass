// agentglass — self-check: several skills loaded in parallel by one assistant message (2 and 4 loads), per harness
// (Claude Skill tool, Codex SKILL.md reads, pi reads, OpenCode skill tool, Gemini activate_skill): the size estimates
// overshoot the context's growth a little (as live), and every load still gets its load, carry, request and $ share; the
// shares never exceed the request's tokens. scriptc build src/harness/skill-parallel.check.ts -o sp && ./sp
// SPDX-License-Identifier: Apache-2.0
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { pi } from "./pi.ts";
import { opencode } from "./opencode.ts";
import { gemini } from "./gemini.ts";
import { type Acc, type SkLoad, newAcc } from "../features/usage/record.ts";
import { skillLoads, skillCheck } from "../features/skills/model.ts";
import { skillHash } from "../features/usage/skillrec.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function text(bytes: number): string { return "LOREMSKILLTEXT" + "x".repeat(bytes - 14); }
function sum(x: number[]): number { return (x[0] ?? 0) + (x[1] ?? 0) + (x[2] ?? 0) + (x[3] ?? 0); }
const NAMES = ["big", "mid", "mid2", "tiny"];
const T0 = 1790845200000;
function iso(s: number): string { return new Date(T0 + s * 1000).toISOString(); }
const J = (v: unknown): string => JSON.stringify(v);

// r0 (ctx 8000) calls the skills; r1 sends their texts (growth g, below Σ estimates); r2 carries them (+50)
function claudeLines(sizes: number[], g: number): string[] {
  const out: string[] = [];
  const asst = (n: number, cr: number, w: number, c: unknown): string => J({ type: "assistant", uuid: "a-" + String(n) + "-" + String(out.length), timestamp: iso(n * 10), sessionId: "s-par", requestId: "req_" + String(n), message: { id: "msg_" + String(n), model: "claude-sonnet-4-5", role: "assistant", content: [c], usage: { input_tokens: 0, cache_read_input_tokens: cr, cache_creation_input_tokens: w, output_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: w, ephemeral_1h_input_tokens: 0 } } } });
  const user = (id: string, c: unknown, meta: boolean, src: string): string => {
    const o: Record<string, unknown> = { parentUuid: null, isSidechain: false, promptId: "p0", type: "user", message: { role: "user", content: c }, uuid: id, timestamp: iso(5), sessionId: "s-par" };
    if (meta) o["isMeta"] = true; if (src) o["sourceToolUseID"] = src;
    return J(o);
  };
  out.push(user("u-0", "use the skills", false, ""));
  for (let i = 0; i < sizes.length; i++) out.push(asst(0, 0, 8000, { type: "tool_use", id: "toolu_" + String(i), name: "Skill", input: { skill: NAMES[i] ?? "" } })); // one line per block, one request
  for (let i = 0; i < sizes.length; i++) {
    out.push(user("u-r" + String(i), [{ type: "tool_result", tool_use_id: "toolu_" + String(i), content: "Launching skill: " + (NAMES[i] ?? "") }], false, ""));
    out.push(user("u-m" + String(i), [{ type: "text", text: "Base directory for this skill: /h/.claude/skills/" + (NAMES[i] ?? "") + "\n\n" + text(sizes[i] ?? 0) }], true, "toolu_" + String(i)));
  }
  out.push(asst(1, 8000, g, { type: "text", text: "ok" }));
  out.push(asst(2, 8000 + g, 50, { type: "text", text: "ok" }));
  return out;
}
function codexLines(sizes: number[], g: number): string[] {
  const out: string[] = [];
  const ev = (s: number, p: unknown): string => J({ timestamp: iso(s), type: "event_msg", payload: p });
  const tc = (s: number, inp: number, ca: number, ti: number, tca: number, tout: number): string => ev(s, { type: "token_count", info: {
    total_token_usage: { input_tokens: ti, cached_input_tokens: tca, cache_write_input_tokens: 0, output_tokens: tout, reasoning_output_tokens: 0, total_tokens: ti + tout },
    last_token_usage: { input_tokens: inp, cached_input_tokens: ca, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: inp + 20 } } });
  out.push(J({ timestamp: iso(0), type: "session_meta", payload: { id: "c0de0000-0000-4000-8000-0000000000aa", cwd: "/w/app", originator: "codex_cli_rs" } }));
  out.push(J({ timestamp: iso(0), type: "turn_context", payload: { cwd: "/w/app", model: "gpt-5.5" } }));
  out.push(J({ timestamp: iso(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "use the skills" }] } }));
  for (let i = 0; i < sizes.length; i++) out.push(J({ timestamp: iso(2), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call_" + String(i), arguments: J({ cmd: "cat /h/.codex/skills/" + (NAMES[i] ?? "") + "/SKILL.md" }) } }));
  out.push(tc(3, 8000, 0, 8000, 0, 20));
  for (let i = 0; i < sizes.length; i++) out.push(J({ timestamp: iso(4), type: "response_item", payload: { type: "function_call_output", call_id: "call_" + String(i), output: text(sizes[i] ?? 0) } }));
  out.push(tc(5, 8000 + g, 8000, 16000 + g, 8000, 40));
  out.push(tc(6, 8050 + g, 8000 + g, 24050 + 2 * g, 16000 + g, 60));
  return out;
}
function piLines(sizes: number[], g: number): string[] {
  const out: string[] = [];
  const msg = (id: string, s: number, m: Record<string, unknown>): string => J({ type: "message", id, parentId: null, timestamp: iso(s), message: m });
  const asst = (id: string, s: number, cr: number, w: number, usd: number, c: unknown[]): string => msg(id, s, { role: "assistant", content: c, provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 0, output: 20, cacheRead: cr, cacheWrite: w, totalTokens: cr + w + 20, cost: { total: usd } }, stopReason: "stop", timestamp: 0 });
  out.push(J({ type: "session", version: 3, id: "p1000000-0000-4000-8000-0000000000aa", timestamp: iso(0), cwd: "/w/app" }));
  const calls: unknown[] = [];
  for (let i = 0; i < sizes.length; i++) calls.push({ type: "toolCall", id: "tc" + String(i), name: "read", arguments: { path: "/h/.pi/agent/skills/" + (NAMES[i] ?? "") + "/SKILL.md" } });
  out.push(asst("m0", 1, 0, 8000, 0.03, calls));
  for (let i = 0; i < sizes.length; i++) out.push(msg("r" + String(i), 2, { role: "toolResult", toolCallId: "tc" + String(i), toolName: "read", content: [{ type: "text", text: text(sizes[i] ?? 0) }], isError: false, timestamp: 0 }));
  out.push(asst("m1", 3, 8000, g, 0.02, [{ type: "text", text: "a" }]));
  out.push(asst("m2", 4, 8000 + g, 50, 0.005, [{ type: "text", text: "b" }]));
  return out;
}
function opencodeLines(sizes: number[], g: number): string[] {
  const out: string[] = [];
  const t = (s: number): number => T0 + s * 1000;
  const asst = (seq: number, cr: number, w: number, usd: number, c: unknown[]): string => J({ type: "assistant", seq, time: { created: t(seq) }, model: { id: "claude-sonnet-4-5", providerID: "anthropic" }, tokens: { input: 0, output: 20, reasoning: 0, cache: { read: cr, write: w } }, cost: usd, content: c });
  out.push(J({ type: "user", seq: 1, time: { created: t(1) }, text: "use the skills", files: [] }));
  const tools: unknown[] = [];
  for (let i = 0; i < sizes.length; i++) tools.push({ type: "tool", name: "skill", id: "t" + String(i), time: { created: t(2), ran: t(2), completed: t(2) + 500 }, state: { status: "completed", input: { id: NAMES[i] ?? "" }, output: text(sizes[i] ?? 0) } });
  out.push(asst(2, 0, 8000, 0.03, tools));
  out.push(asst(3, 8000, g, 0.02, []));
  out.push(asst(4, 8000 + g, 50, 0.005, []));
  return out;
}
function geminiLines(sizes: number[], g: number): string[] {
  const out: string[] = [];
  const msg = (id: string, s: number, inp: number, cached: number, calls: unknown[]): string => {
    const o: Record<string, unknown> = { id, timestamp: iso(s), type: "gemini", content: "ok", model: "gemini-2.5-flash", tokens: { input: inp, output: 20, cached, thoughts: 0, tool: 0, total: inp + 20 } };
    if (calls.length) o["toolCalls"] = calls;
    return J(o);
  };
  out.push(J({ id: "u1", timestamp: iso(0), type: "user", content: [{ text: "use the skills" }] }));
  const calls: unknown[] = [];
  for (let i = 0; i < sizes.length; i++) calls.push({ id: "k" + String(i), name: "activate_skill", args: { name: NAMES[i] ?? "" }, status: "success", timestamp: iso(2), result: [{ functionResponse: { id: "k" + String(i), name: "activate_skill", response: { output: text(sizes[i] ?? 0) } } }] });
  out.push(msg("g0", 1, 8000, 0, calls));
  out.push(msg("g1", 3, 8000 + g, 8000, []));
  out.push(msg("g2", 4, 8050 + g, 8000 + g, []));
  return out;
}

// the loads' sizes: the estimates shrunk in proportion to fill the growth exactly (largest remainder)
function shares(est: number[], g: number): number[] {
  let tot = 0; for (const e of est) tot += e;
  const o: number[] = []; const fr: number[] = []; let left = g;
  for (const e of est) { const x = e * g / tot; const f = Math.floor(x); o.push(f); fr.push(x - f); left -= f; }
  while (left > 0) { let k = 0; for (let i = 1; i < fr.length; i++) if ((fr[i] ?? 0) > (fr[k] ?? 0)) k = i; o[k] = (o[k] ?? 0) + 1; fr[k] = -1; left--; }
  return o;
}
// priced: the harness reports $ (pi, OpenCode); table: the model has a built-in price (Codex's gpt ids come from the
// community list only: its loads are counted, not priced, all alike)
interface Case { h: string; gen: (sizes: number[], g: number) => string[]; use: (a: Acc, l: string) => void; bpt: number; priced: boolean; table: boolean }
const CASES: Case[] = [
  { h: "claude", gen: claudeLines, use: claude.usage, bpt: 3.6, priced: false, table: true },
  { h: "codex", gen: codexLines, use: codex.usage, bpt: 3.6, priced: false, table: false },
  { h: "pi", gen: piLines, use: pi.usage, bpt: 3.6, priced: true, table: true },
  { h: "opencode", gen: opencodeLines, use: opencode.usage, bpt: 3.6, priced: true, table: true },
  { h: "gemini", gen: geminiLines, use: gemini.usage, bpt: 3.9, priced: false, table: true },
];
for (const c of CASES) {
  for (const n of [2, 4]) {
    const est = n === 2 ? [1000, 100] : [1000, 500, 500, 100]; // tokens; the texts are est × the model's bytes per token
    const sizes: number[] = []; let tot = 0; for (const e of est) { sizes.push(Math.round(e * c.bpt)); tot += e; }
    const g = Math.round(tot * 0.95); // the estimates overshoot the real growth by 5 % (live: 13 989 est. vs 13 214 grown)
    const a = newAcc();
    for (const l of c.gen(sizes, g)) c.use(a, l);
    const at = c.h + " " + String(n) + " parallel";
    const want = shares(est, g);
    const got: string[] = []; const exp: string[] = [];
    let lt = 0; let ct = 0;
    for (let i = 0; i < n; i++) {
      const l = a.sk[i] as SkLoad | undefined;
      if (!l) { got.push("missing"); exp.push(NAMES[i] ?? ""); continue; }
      got.push(l.name + " S " + String(l.S) + " load " + String(sum(l.lt)) + " carry " + String(sum(l.ct)) + " req " + String(l.nq) + " " + (l.end ? l.why : "open"));
      exp.push((NAMES[i] ?? "") + " S " + String(want[i] ?? 0) + " load " + String(want[i] ?? 0) + " carry " + String(want[i] ?? 0) + " req 1 open");
      lt += sum(l.lt); ct += sum(l.ct);
    }
    eq(at + ": loads", got.join("\n"), exp.join("\n"));
    eq(at + ": load shares fill the growth, never more", String(lt), String(g));
    eq(at + ": carry within the next request", String(ct <= 8000 + g + 50), "true");
    const rows = skillLoads([a], ["s"]);
    let pos = 0; let unp = 0; for (const r of rows) { if (r.usd > 0) pos++; if (r.unpriced) unp++; }
    eq(at + ": every load has a $ share", String(c.table ? pos : unp), String(n));
    if (c.priced) { let hu = 0; for (const l of a.sk) hu += l.hu; eq(at + ": reported $ shares ≤ the requests'", String(hu > 0 && hu <= 0.025 + 1e-9), "true"); }
    eq(at + ": skills --check", skillCheck([a], ["s"]).join("; "), "");
  }
}
// Codex: one command reads several SKILL.md files (cat a b): one output, split per file at each front matter (exact: bytes
// and version hash of each file); without front matter in proportion to the sizes of earlier loads in the log, else alike (≈)
// (mid's text ends with a newline, big's does not: the next "---" is glued to its last line)
function fm(nm: string, bytes: number): string { const h = "---\nname: " + nm + "\ndescription: d\n---\n"; const nl = nm === "mid" ? "\n" : ""; return h + "LOREM" + "x".repeat(bytes - h.length - 5 - nl.length) + nl; }
function catLines(texts: string[], g: number, prior: boolean): string[] {
  const out: string[] = [];
  const ev = (s: number, p: unknown): string => J({ timestamp: iso(s), type: "event_msg", payload: p });
  const tot = [0, 0, 0]; // running totals: Codex books a token_count by its total_token_usage
  const tc = (s: number, inp: number, ca: number): string => { tot[0] = (tot[0] ?? 0) + inp; tot[1] = (tot[1] ?? 0) + ca; tot[2] = (tot[2] ?? 0) + 20; return ev(s, { type: "token_count", info: {
    total_token_usage: { input_tokens: tot[0], cached_input_tokens: tot[1], cache_write_input_tokens: 0, output_tokens: tot[2], reasoning_output_tokens: 0, total_tokens: (tot[0] ?? 0) + (tot[2] ?? 0) },
    last_token_usage: { input_tokens: inp, cached_input_tokens: ca, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: inp + 20 } } }); };
  const call = (s: number, id: string, cmd: string): string => J({ timestamp: iso(s), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: J({ cmd }) } });
  const res = (s: number, id: string, o: string): string => J({ timestamp: iso(s), type: "response_item", payload: { type: "function_call_output", call_id: id, output: o } });
  out.push(J({ timestamp: iso(0), type: "session_meta", payload: { id: "c0de0000-0000-4000-8000-0000000000ab", cwd: "/w/app", originator: "codex_cli_rs" } }));
  out.push(J({ timestamp: iso(0), type: "turn_context", payload: { cwd: "/w/app", model: "gpt-5.5" } }));
  let ctx = 8000;
  if (prior) { // an earlier turn read both, one each
    out.push(J({ timestamp: iso(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] } }));
    for (let i = 0; i < texts.length; i++) { out.push(call(2, "p" + String(i), "cat /h/.codex/skills/" + (NAMES[i] ?? "") + "/SKILL.md")); out.push(tc(3, ctx, 0)); out.push(res(4, "p" + String(i), texts[i] ?? "")); ctx += 3000; out.push(tc(5, ctx, ctx - 3000)); }
    out.push(J({ timestamp: iso(6), type: "event_msg", payload: { type: "context_compacted" } }));
    out.push(J({ timestamp: iso(6), type: "compacted", payload: { message: "" } }));
    ctx = 8000;
  }
  out.push(J({ timestamp: iso(10), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "use the skills" }] } }));
  const paths: string[] = []; for (let i = 0; i < texts.length; i++) paths.push("/h/.codex/skills/" + (NAMES[i] ?? "") + "/SKILL.md");
  out.push(call(11, "call_cat", "cat " + paths.join(" ")));
  out.push(tc(12, ctx, 0));
  out.push(res(13, "call_cat", "Chunk ID: 1a2b\nProcess exited with code 0\nOutput:\n" + texts.join("")));
  out.push(tc(14, ctx + g, ctx));
  return out;
}
{
  const sizes = [3600, 1800, 360];
  const ft: string[] = []; for (let i = 0; i < 3; i++) ft.push(fm(NAMES[i] ?? "", sizes[i] ?? 0));
  const plain: string[] = []; for (let i = 0; i < 3; i++) plain.push(text(sizes[i] ?? 0));
  for (const mode of ["front matter", "earlier loads", "alike"]) {
    const texts = mode === "front matter" ? ft : plain;
    const a = newAcc(); for (const l of catLines(texts, 1000, mode === "earlier loads")) codex.usage(a, l);
    const ls: SkLoad[] = []; for (const l of a.sk) if (l.cid === "call_cat") ls.push(l);
    const at = "codex cat a b c (" + mode + ")";
    eq(at + ": loads", ls.map((l: SkLoad) => l.name).join(","), "big,mid,mid2");
    let S = 0; for (const l of ls) S += l.S; eq(at + ": Σ S = growth", String(S), "1000");
    const hdr = "Chunk ID: 1a2b\nProcess exited with code 0\nOutput:\n".length;
    if (mode === "front matter") {
      eq(at + ": bytes", ls.map((l: SkLoad) => String(l.bytes)).join(","), String(sizes[0] + hdr) + "," + String(sizes[1]) + "," + String(sizes[2]));
      eq(at + ": versions", ls.slice(1).map((l: SkLoad) => l.hash).join(","), skillHash(ft[1] ?? "") + "," + skillHash(ft[2] ?? ""));
      eq(at + ": exact", ls.map((l: SkLoad) => String(l.est)).join(","), "false,false,false");
    } else if (mode === "earlier loads") {
      const b = ls.map((l: SkLoad) => l.bytes); const all = sizes[0] + sizes[1] + sizes[2] + hdr;
      eq(at + ": bytes in proportion", String(Math.abs((b[0] ?? 0) - Math.round(all * 3600 / 5760)) <= 1 && Math.abs((b[2] ?? 0) - (all - Math.round(all * 5400 / 5760))) <= 1), "true");
      eq(at + ": marked ≈", ls.map((l: SkLoad) => String(l.est)).join(","), "true,true,true");
    } else {
      const b = ls.map((l: SkLoad) => l.bytes); const all = sizes[0] + sizes[1] + sizes[2] + hdr;
      eq(at + ": bytes alike", String(Math.abs((b[0] ?? 0) - all / 3) <= 1 && Math.abs((b[1] ?? 0) - all / 3) <= 1), "true");
    }
    eq(at + ": skills --check", skillCheck([a], ["s"]).join("; "), "");
  }
}
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok parallel skill loads");
