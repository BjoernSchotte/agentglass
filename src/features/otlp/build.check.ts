// agentglass — self-check for the OTLP span builder on the fixture sessions: scriptc build src/features/otlp/build.check.ts -o bc && ./bc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, rmSync, copyFileSync, appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { type Sess, newSess } from "../../model/types.ts";
import { harnessOf, sourceOf } from "../../harness/index.ts";
import { opencode } from "../../harness/opencode.ts";
import { newAcc } from "../usage/record.ts";
import { REDACT } from "../redact-on.ts";
import { type XTurn, type XSpan } from "./types.ts";
import { type BuildOpts, newSessB, advance, finish, hostSpan } from "./build.ts";
import { setVis } from "../skills/vis.ts";

let bad = 0;
setVis([], false); // skill names as logged (skills.check.ts covers hiding and --redact)
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ":\n  got  " + got + "\n  want " + want); } }
const F = "testdata/otlp/fixtures/";
const NOW = Date.parse("2026-09-02T00:00:00.000Z");
const O: BuildOpts = { now: NOW, quietMs: 600000, content: false, subagents: true };
function sess(h: string, id: string, path: string, parent: string): Sess {
  const s = newSess(h, id, path, false); s.parent = parent;
  const m = harnessOf(h).meta; if (m) m(s);
  s.mtime = Date.parse("2026-09-01T10:30:00.000Z");
  return s;
}
// a turn as "op name <parent index>" per span (root first)
function tree(t: XTurn): string {
  const at = new Map<string, number>(); for (let i = 0; i < t.spans.length; i++) at.set(t.spans[i].spanId, i);
  return t.spans.map((s: XSpan) => s.name + "<" + String(at.get(s.parentId) ?? -1) + (s.err ? " !" + s.err : "") + (s.superseded ? " sup" : "") + (s.est ? " est" : "")).join(", ");
}
function sum(ts: XTurn[], sess: string): string {
  let i = 0; let o = 0; let r = 0; let w = 0; let c = 0;
  for (const t of ts) for (const s of t.spans) if (s.op === "chat" && s.sess === sess) { i += s.nIn; o += s.nOut; r += s.cr; w += s.cw; c += s.cost; }
  return [i, o, r, w, c.toFixed(9)].join("/");
}
// Stats' view of the same file: a plain ledger pass over all its records
function ledger(s: Sess, sub: boolean): string {
  const a = newAcc(); a.sub = sub; const src = sourceOf(s.h); const st = src.stat(s);
  if (st) for (const l of src.lines(s, 0, st.size).lines) harnessOf(s.h).usage(a, l);
  return [a.inTok, a.outTok, a.cr, a.cw, a.cost.toFixed(9)].join("/");
}
function noUsageOnAgents(ts: XTurn[]): boolean { for (const t of ts) for (const s of t.spans) if (s.op === "invoke_agent" && (s.hasUsage || s.total)) return false; return true; }
function ids(ts: XTurn[]): string { return ts.map((t: XTurn) => t.traceId + ":" + t.spans.map((s: XSpan) => s.spanId).join(",")).join(" | "); }

// ── claude: streamed lines = one chat, two fallback iterations = two chats, a subagent under its Agent call ──
const CP = F + "claude/.claude/projects/-home-u-proj/";
const CID = "11111111-1111-4111-8111-111111111111";
const cs = sess("claude", CID, CP + CID + ".jsonl", "");
const csub = sess("claude", "a1b2c3", CP + CID + "/subagents/agent-a1b2c3.jsonl", CID);
const ct = finish(newSessB(cs, [csub]), O);
eq("claude turns", String(ct.length), "2");
if (ct.length === 2) {
  eq("claude turn 1", tree(ct[0]), "invoke_agent Claude Code<-1, chat claude-sonnet-4-5<0, execute_tool Bash git<0, execute_tool search<0, chat claude-opus-4-5<0 sup est, chat claude-sonnet-4-5<0 est, execute_tool Agent<0, chat claude-sonnet-4-5<0, invoke_agent Explore<6, chat claude-haiku-4-5<8, execute_tool Grep<8, chat claude-haiku-4-5<8");
  eq("claude turn 2", tree(ct[1]), "invoke_agent Claude Code<-1, chat claude-sonnet-4-5<0, execute_tool Bash rm<0 !rejected, chat<0 !rate_limit");
  const r = ct[0].spans[0];
  eq("root models", r.model + " " + r.models.join(","), "claude-sonnet-4-5 claude-sonnet-4-5,claude-opus-4-5");
  eq("claude keys", ct[0].key + " " + ct[1].key, "2026-09-01T10:00:00.000Z#0 2026-09-01T10:05:00.000Z#0");
  const m = ct[0].spans[1];
  eq("streamed chat window", String((m.t1 - m.t0) / 1000) + " " + m.respId + " " + m.provider, "3 msg_a anthropic");
  eq("streamed chat: one span at the final output_tokens", String(m.nOut) + " " + String(m.nIn), "14 10");
  eq("bash", ct[0].spans[2].prog + " " + String((ct[0].spans[2].t1 - ct[0].spans[2].t0) / 1000), "git 1.5");
  eq("bash family", String(ct[0].spans[2].fam.startsWith("git")) + " " + ct[0].spans[2].fkind, "true vcs");
  eq("mcp", ct[0].spans[3].mcp, "ctx");
}
eq("claude conservation (root)", sum(ct, CID), ledger(cs, false));
eq("claude conservation (subagent)", sum(ct, "a1b2c3"), ledger(csub, true));
eq("no usage on invoke_agent", String(noUsageOnAgents(ct)), "true");
// ids are stable across builds
const ct2 = finish(newSessB(cs, [csub]), O);
eq("ids stable", ids(ct2), ids(ct));
// no subagents
const cn = finish(newSessB(cs, [csub]), { now: NOW, quietMs: 600000, content: false, subagents: false });
eq("no subagents", String(cn.length ? cn[0].spans.some((s: XSpan) => s.sess !== CID) : true), "false");
// no spawn link and no spawn-like call: the subagent hangs under the turn's root
eq("hostSpan fallback", String(ct.length ? hostSpan(ct[1], "nope", Date.parse("2026-09-01T10:05:03.000Z")) : -1), "0");

// ── appending: earlier ids stay, a new request in the open turn leaves root + earlier chat ids alone ──
const tmp = "/tmp/agentglass-otlp-build-" + String(process.pid); mkdirSync(tmp, { recursive: true });
const ap = tmp + "/" + CID + ".jsonl"; copyFileSync(CP + CID + ".jsonl", ap);
const lines = readFileSync(ap, "utf8").trim().split("\n");
writeFileSync(ap, lines.slice(0, 11).join("\n") + "\n"); // up to turn 2's first response
const as1 = sess("claude", CID, ap, ""); as1.pid = 4242; as1.mtime = NOW - 1000; // live, just written: turn 2 stays open
const B = newSessB(as1, []);
const first = advance(B, O);
eq("open turn not returned", String(first.length) + " " + String(!!B.open), "1 true");
const open2 = B.open; const openIds = open2 ? open2.spans.map((s: XSpan) => s.spanId).join(",") : "";
appendFileSync(ap, lines.slice(11).join("\n") + "\n");
const more = advance(B, O);
eq("still open", String(more.length), "0");
const op2 = B.open;
eq("append keeps root + chat ids", op2 ? op2.spans.slice(0, openIds.split(",").length).map((s: XSpan) => s.spanId).join(",") : "", openIds);
// quiet rule: 9 min quiet (one-shot 10 min) stays open, 10 min closes
as1.mtime = NOW - 540000;
eq("9 min quiet: open", String(advance(B, O).length), "0");
as1.mtime = NOW - 600000;
const q = finish(B, O);
eq("10 min quiet: closed", q.length ? q[0].closedBy + " " + q[0].key : "none", "quiet 2026-09-01T10:05:00.000Z#0");
eq("same ids as the whole-file build", q.length && ct.length > 1 ? q[0].spans.map((s: XSpan) => s.spanId).join(",") : "x", ct.length > 1 ? ct[1].spans.map((s: XSpan) => s.spanId).join(",") : "y");
// a busy turn whose process is gone: interrupted after 2 min
const ip = tmp + "/int.jsonl"; writeFileSync(ip, lines.slice(0, 11).join("\n") + "\n");
const is1 = sess("claude", "int", ip, ""); is1.status = "busy"; is1.pid = 0; is1.mtime = NOW - 180000;
const it = advance(newSessB(is1, []), O);
eq("interrupted", it.length > 1 ? it[1].spans[0].err : "none", "interrupted");
// late events after a quiet close: a continuation turn with its own key, the closed turn is not returned again
const lp = tmp + "/late.jsonl"; writeFileSync(lp, lines.slice(0, 4).join("\n") + "\n");
const ls1 = sess("claude", "late", lp, ""); ls1.pid = 4242; ls1.mtime = NOW - 700000;
const LB = newSessB(ls1, []);
const l1 = advance(LB, O);
appendFileSync(lp, lines.slice(4, 6).join("\n") + "\n"); ls1.mtime = NOW - 700000;
const l2 = advance(LB, O);
eq("late: continuation", String(l1.length) + " " + String(l2.length) + " " + (l2.length ? l2[0].key + " " + String(l2[0].index) + " " + String(l2[0].traceId !== l1[0].traceId) : ""), "1 1 2026-09-01T10:00:04.000Z#0 2 true");

// a turn whose subagent is still active (written 10 s ago) stays open, however quiet the root is
const sp0 = tmp + "/subact.jsonl"; writeFileSync(sp0, lines.slice(0, 8).join("\n") + "\n");
const sa = sess("claude", "subact", sp0, ""); sa.pid = 4242; sa.mtime = NOW - 900000;
const sas = sess("claude", "a1b2c3", CP + CID + "/subagents/agent-a1b2c3.jsonl", "subact"); sas.mtime = NOW - 10000;
const SB = newSessB(sa, [sas]);
eq("active subagent keeps the turn open", String(advance(SB, O).length) + " " + String(!!SB.open), "0 true");
sas.mtime = NOW - 900000;
eq("subagent done: closes", String(advance(SB, O).length), "1");

// ── clock skew: a call that starts before its turn widens the root ──
const kp = tmp + "/skew.jsonl";
writeFileSync(kp, "{\"type\":\"user\",\"timestamp\":\"2026-09-01T10:00:10.000Z\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n{\"type\":\"assistant\",\"timestamp\":\"2026-09-01T10:00:05.000Z\",\"message\":{\"id\":\"m\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n");
const sk = advance(newSessB(sess("claude", "skew", kp, ""), []), O);
eq("skew widens root", sk.length ? new Date(sk[0].spans[0].t0).toISOString() : "", "2026-09-01T10:00:05.000Z");

// ── codex: aborted turn cancelled, one chat per changed token_count, the reused subagent as two pieces ──
const XP = F + "codex/.codex/sessions/2026/09/01/";
const XS = sess("codex", "22222222-2222-4222-8222-222222222222", XP + "rollout-2026-09-01T10-00-00-22222222-2222-4222-8222-222222222222.jsonl", "");
const XSub = sess("codex", "33333333-3333-4333-8333-333333333333", XP + "rollout-2026-09-01T10-00-06-33333333-3333-4333-8333-333333333333.jsonl", "");
const xt = finish(newSessB(XS, [XSub]), O);
eq("codex turns", String(xt.length), "2");
if (xt.length === 2) {
  eq("codex turn 1", tree(xt[0]), "invoke_agent Codex<-1, execute_tool exec_command ls<0, chat gpt-5.2-codex<0, execute_tool spawn_agent<0, chat gpt-5.2-codex<0, chat gpt-5.2-codex<0, invoke_agent worker<3, execute_tool apply_patch<6, chat gpt-5.2-codex-mini<6, chat gpt-5.2-codex-mini<6");
  eq("codex turn 2", tree(xt[1]), "invoke_agent Codex<-1 !cancelled, execute_tool send_input<0, chat gpt-5.2-codex<0, invoke_agent worker<1, chat gpt-5.2-codex-mini<3");
  eq("codex pieces: distinct ids", String(xt[0].spans[6].spanId !== xt[1].spans[3].spanId), "true");
  eq("codex reasoning", String(xt[0].spans[2].rs) + " " + String(xt[0].spans[4].rs), "20 10");
}
eq("codex conservation (root)", sum(xt, XS.id), ledger(XS, false));
eq("codex conservation (subagent)", sum(xt, XSub.id), ledger(XSub, true));
eq("codex: no usage on invoke_agent", String(noUsageOnAgents(xt)), "true");

// ── gemini: rewind drops turn 2 and keeps its replacement apart; model switch inside a turn ──
const GS = sess("gemini", "44444444-4444-4444-8444-444444444444", F + "gemini/.gemini/tmp/proj/chats/session-2026-09-01T10-00-44444444.jsonl", "");
const gt = finish(newSessB(GS, []), O);
eq("gemini turns", gt.map((t: XTurn) => t.key + "=" + tree(t)).join(" ; "),
  "2026-09-01T10:00:00.000Z#0=invoke_agent Gemini CLI<-1, chat gemini-2.5-pro<0, execute_tool run_shell_command ls<0, chat gemini-2.5-flash<0 ; " +
  "2026-09-01T10:03:00.000Z#0=invoke_agent Gemini CLI<-1, chat gemini-2.5-flash<0 ; " +
  "2026-09-01T10:04:00.000Z#0=invoke_agent Gemini CLI<-1, chat gemini-2.5-flash<0, execute_tool run_shell_command mv<0 !tool_error, chat gemini-2.5-flash<0");
if (gt.length) eq("gemini models", gt[0].spans[0].models.join(",") + " last " + gt[0].spans[0].model, "gemini-2.5-pro,gemini-2.5-flash last gemini-2.5-flash");
eq("gemini conservation", sum(gt, GS.id), ledger(GS, false));

// ── pi: responseModel kept apart, two providers in one turn ──
const PS = sess("pi", "55555555-5555-4555-8555-555555555555", F + "pi/.pi/agent/sessions/--home-u-proj--/2026-09-01T10-00-00-000Z_55555555-5555-4555-8555-555555555555.jsonl", "");
const pt = finish(newSessB(PS, []), O);
eq("pi", pt.length ? tree(pt[0]) : "", "invoke_agent pi<-1, chat anthropic/claude-sonnet-4.5<0, execute_tool bash npm<0, chat claude-haiku-4-5<0");
if (pt.length) eq("pi response model + providers (the model's vendor; the logged id kept apart)", pt[0].spans[1].respModel + " " + pt[0].spans[1].provider + "@" + pt[0].spans[1].provId + " " + pt[0].spans[3].provider + "@" + pt[0].spans[3].provId, "anthropic/claude-4.5-sonnet-20250929 anthropic@openrouter anthropic@anthropic");
eq("pi conservation", sum(pt, PS.id), ledger(PS, false));
{ // a /skill:name prompt names its skill on the turn root, as a Claude slash-command skill does
  const pd = tmp + "/pi-skill/--home-u-proj--"; mkdirSync(pd, { recursive: true });
  const pp = pd + "/2026-09-01T10-00-00-000Z_66666666-6666-4666-8666-666666666666.jsonl";
  const blk = "<skill name=\"todo-style\" location=\"/home/u/.pi/agent/skills/todo-style/SKILL.md\">\nReferences are relative to /home/u/.pi/agent/skills/todo-style.\n\n# Todo style\n</skill>\n\nbuild it";
  writeFileSync(pp, "{\"type\":\"session\",\"version\":3,\"id\":\"66666666-6666-4666-8666-666666666666\",\"timestamp\":\"2026-09-01T10:00:00.000Z\",\"cwd\":\"/home/u/proj\"}\n" +
    "{\"type\":\"message\",\"id\":\"u1\",\"timestamp\":\"2026-09-01T10:00:01.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(blk) + "}]}}\n" +
    "{\"type\":\"message\",\"id\":\"a1\",\"timestamp\":\"2026-09-01T10:00:05.000Z\",\"message\":{\"role\":\"assistant\",\"provider\":\"cliproxy\",\"model\":\"claude-sonnet-5-5\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":5,\"output\":2,\"cost\":{\"total\":0.001}},\"stopReason\":\"stop\"}}\n");
  const st = finish(newSessB(sess("pi", "66666666-6666-4666-8666-666666666666", pp, ""), []), O);
  eq("pi /skill: the turn root names the skill", st.length ? st[0].spans[0].skill + " " + st[0].spans[1].provider + "@" + st[0].spans[1].provId : "", "todo-style anthropic@cliproxy");
}

// ── opencode 2.x rows: one chat per assistant message ──
const db = tmp + "/opencode.db";
execFileSync("sqlite3", [db], { input: readFileSync(F + "opencode/opencode.sql", "utf8"), stdio: ["pipe", "ignore", "inherit"] });
process.env["OPENCODE_DB"] = db; process.env["XDG_STATE_HOME"] = tmp + "/state"; delete process.env["AGENTGLASS_SQLITE3"];
let OS0: Sess | null = null;
opencode.scan((p: string, id: string, parent: string, ar: boolean) => { if (!OS0) OS0 = sess("opencode", id, p, parent); });
const OS = OS0 ?? newSess("opencode", "x", "x", false);
const ot = finish(newSessB(OS, []), O);
eq("opencode", ot.length ? tree(ot[0]) + " " + ot[0].closedBy : "", "invoke_agent OpenCode<-1, chat claude-sonnet-4-5<0, execute_tool write<0, chat gpt-5.2<0 marker");
if (ot.length) eq("opencode chat", ot[0].spans[1].respId + " " + ot[0].spans[1].provider + " rs" + String(ot[0].spans[1].rs) + " " + String((ot[0].spans[1].t1 - ot[0].spans[1].t0) / 1000), "m1 anthropic rs10 4");
eq("opencode conservation", sum(ot, OS.id), ledger(OS, false));

// ── kiro: sidecar turns, one chat per turn with its totals, children laid out (est) ──
const KS = sess("kiro", "66666666-6666-4666-8666-666666666666", F + "kiro/.kiro/sessions/cli/66666666-6666-4666-8666-666666666666.jsonl", "");
const kt = finish(newSessB(KS, []), O);
eq("kiro", kt.map((t: XTurn) => t.key + "=" + tree(t)).join(" ; "), "i1=invoke_agent Kiro<-1, chat<0 est, execute_tool execute_bash df<0 est ; i2=invoke_agent Kiro<-1, chat<0 est, execute_tool execute_bash free<0 !tool_error est");
if (kt.length === 2) eq("kiro times + usage", new Date(kt[0].t1).toISOString() + " " + new Date(kt[1].t0).toISOString() + " " + String(kt[0].spans[1].nIn) + "/" + String(kt[1].spans[1].nOut), "2026-09-01T10:00:20.123Z 2026-09-01T10:00:20.123Z 900/25");

// ── fx: one chat per turn, no usage; session totals on the last turn's chat span (never on invoke_agent, decision 2) ──
const FS = sess("fx", "fx-77777777", F + "fx/.fx/sessions/fx-77777777/events.jsonl", "");
const ft = finish(newSessB(FS, []), O);
eq("fx", ft.map((t: XTurn) => tree(t) + " " + String((t.t1 - t.t0) / 1000)).join(" ; "), "invoke_agent fx<-1, chat fx-large<0 est, execute_tool shell wc<0 est 30 ; invoke_agent fx<-1, chat fx-large<0 est, execute_tool shell wc<0 !tool_error est 12");
if (ft.length === 2) eq("fx cumulative totals on the newest turn (the exporter sends their growth)", ft[0].fx.join("/") + " | " + ft[1].fx.join("/"), " | 3000/" + String(ft[1].spans[1].nOut) + "/" + String(ft[1].spans[1].cr) + "/" + String(ft[1].spans[1].cw) + "/" + String(ft[1].spans[1].cost) + "/" + String(ft[1].spans[1].unk));
if (ft.length === 2) eq("fx totals", String(ft[0].spans[1].total) + " " + String(ft[1].spans[1].total) + " " + String(ft[1].spans[1].nIn) + " " + String(ft[1].spans[1].hasUsage) + " " + String(ft[0].spans[1].hasUsage) + " " + String(ft[1].spans[0].hasUsage || ft[1].spans[0].total), "false true 3000 true false false");

// ── otlp-complete 3: request id, 1-hour cache writes, call details, title and project key on the turn ──
{
  const rp = tmp + "/req.jsonl"; const cwd = tmp + "/proj";
  mkdirSync(cwd + "/src", { recursive: true });
  const L = (o: string): string => o + "\n";
  writeFileSync(rp,
    L("{\"type\":\"user\",\"sessionId\":\"rq\",\"cwd\":\"" + cwd + "\",\"timestamp\":\"2026-09-01T10:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"fix login bug\"}}") +
    L("{\"type\":\"assistant\",\"sessionId\":\"rq\",\"cwd\":\"" + cwd + "\",\"requestId\":\"req_A\",\"timestamp\":\"2026-09-01T10:00:02.000Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"on it\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cache_creation_input_tokens\":700,\"cache_creation\":{\"ephemeral_5m_input_tokens\":200,\"ephemeral_1h_input_tokens\":500}}}}") +
    L("{\"type\":\"assistant\",\"sessionId\":\"rq\",\"cwd\":\"" + cwd + "\",\"requestId\":\"req_A\",\"timestamp\":\"2026-09-01T10:00:03.000Z\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tb\",\"name\":\"Bash\",\"input\":{\"command\":\"git push origin main\"}},{\"type\":\"tool_use\",\"id\":\"tr\",\"name\":\"Read\",\"input\":{\"file_path\":\"" + cwd + "/src/a.ts\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cache_creation_input_tokens\":700,\"cache_creation\":{\"ephemeral_5m_input_tokens\":200,\"ephemeral_1h_input_tokens\":500}}}}") +
    L("{\"type\":\"user\",\"sessionId\":\"rq\",\"cwd\":\"" + cwd + "\",\"timestamp\":\"2026-09-01T10:00:04.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tb\",\"content\":\"ok\"},{\"type\":\"tool_result\",\"tool_use_id\":\"tr\",\"content\":\"x\"}]}}") +
    L("{\"type\":\"assistant\",\"sessionId\":\"rq\",\"cwd\":\"" + cwd + "\",\"timestamp\":\"2026-09-01T10:00:05.000Z\",\"message\":{\"id\":\"m2\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}"));
  const rs = sess("claude", "rq", rp, ""); rs.cwd = cwd;
  const rt = finish(newSessB(rs, []), O);
  const chats = rt.length ? rt[0].spans.filter((x: XSpan) => x.op === "chat") : [];
  eq("request id: the line's requestId, none without", chats.map((x: XSpan) => x.reqId || "-").join(","), "req_A,-");
  eq("1-hour cache writes", chats.map((x: XSpan) => String(x.cw) + "/" + String(x.cw1)).join(","), "700/500,0/0");
  const tools = rt.length ? rt[0].spans.filter((x: XSpan) => x.op === "execute_tool") : [];
  eq("call details kept for the encoder", tools.map((x: XSpan) => x.tool + "=" + (x.cmd || "-") + "|" + (x.target ? x.target.slice(cwd.length) : "-")).join(","), REDACT ? tools.map((x: XSpan) => x.tool + "=" + (x.cmd || "-") + "|" + (x.target ? x.target.slice(cwd.length) : "-")).join(",") : "Bash=git push origin main|-,Read=-|/src/a.ts");
  eq("turn title", rt.length ? String(rt[0].title !== "" && rt[0].title.length <= 256) + (REDACT ? "" : " " + rt[0].title) : "", REDACT ? "true" : "true fix login bug");
  const rk = rt.length ? rt[0].repoKey : ""; // macOS: /tmp is /private/tmp, the key holds the resolved path
  eq("turn repo key", rk.startsWith("path:/private/") ? "path:/" + rk.slice(14) : rk, "path:" + cwd);
}

rmSync(tmp, { recursive: true, force: true });

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp build: all checks passed");
