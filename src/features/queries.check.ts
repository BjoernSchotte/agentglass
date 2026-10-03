// agentglass — self-check for the agent queries: scriptc build src/features/queries.check.ts -o q && ./q
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { accOf } from "./usage/ledger.ts";
import { tokens, bucket, dayKey, num } from "./usage/record.ts";
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Ev } from "../model/types.ts";
import { arr, obj, str } from "../util/json.ts";
import { modelRows, sessionObj, errorRows, parseSince, midnightOf } from "./queries.ts";
import { scopeOf } from "./agentenv.ts";
import { startOfDay } from "./usage/record.ts";
import { loopRuns } from "./watchdog.ts";

let bad = 0;
function dayKeyOf(ms: number): string { return dayKey(new Date(ms)); }
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-queries-keepme-" + String(process.pid); // keepme: the suite's AGENTGLASS_REDACT_KEEP, content stays real
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir + "/p1/.git", { recursive: true }); mkdirSync(dir + "/p2/.git", { recursive: true });
function put(h: string, id: string, cwd: string): Sess { const s = newSess(h, id, dir + "/" + h + "-" + id + ".jsonl", false); s.cwd = cwd; s.mtime = 1; sessions.set(s.path, s); return s; }

// ── per-model rows from the per-model day buckets ──
const D1 = "2026-09-30T10:00:00.000Z"; const D2 = "2026-10-01T10:00:00.000Z";
const m1 = put("claude", "m-1", "/w"); const m2 = put("claude", "m-2", "/w");
const a1 = accOf(m1); const a2 = accOf(m2);
const SON = "claude-sonnet-4-5";
tokens(a1, bucket(a1, 0, D1), SON, 10, 5, 2, 1, 0);
tokens(a1, bucket(a1, 0, D2), SON, 10, 5, 2, 1, 0);
tokens(a2, bucket(a2, 0, D1), SON, 10, 5, 2, 1, 0);
tokens(a2, bucket(a2, 0, D1), "gpt-x", 100, 0, 0, 0, 0);
const mr = modelRows([m1, m2], null);
eq("models: priced first", mr.map((r) => String(r["model"])).join(","), SON + ",gpt-x");
const son = mr[0];
eq("models: summed tokens", [son["in"], son["out"], son["cacheRead"], son["cacheWrite"]].map((v) => String(v)).join(","), "30,15,6,3");
eq("models: priced cost > 0", String(num(son["costUsd"]) > 0), "true");
const gx = mr[1];
eq("models: unpriced costUsd null, never 0", String(gx["costUsd"]) + "|" + String(gx["unpricedTokens"]), "null|100");
const dr = modelRows([m1, m2], [dayKey(new Date(D1))]); const d0 = dr[0];
eq("models: days restrict", String(d0["in"]), "20");

// ── loopRuns: every run of ≥ 3 identical calls ──
function tl(t: string): Ev { return { kind: "tool", text: "Bash\u0000" + t, ts: t, id: "", full: "" }; }
const lr = loopRuns([tl("a"), tl("a"), tl("a"), tl("b"), tl("b"), tl("c"), { kind: "result", text: "x", ts: "", id: "", full: "" }, tl("c"), tl("c"), tl("c")], 3);
eq("loopRuns", lr.map((r) => r.arg + r.n).join(","), "a3,c4");
eq("loopRuns broken by a user turn", String(loopRuns([tl("a"), tl("a"), { kind: "user", text: "u", ts: "", id: "", full: "" }, tl("a")], 3).length), "0");

// ── session <ref>: a Claude session with 2 turns, a failing Bash, 4 identical calls, an Edit, one subagent ──
const T = (n: number): string => "2026-10-01T10:00:" + (n < 10 ? "0" : "") + String(n) + ".000Z";
const SID = "11111111-2222-3333-4444-555555555555";
const head = (n: number): string => "\"sessionId\":\"" + SID + "\",\"cwd\":\"" + dir + "/p1\",\"timestamp\":\"" + T(n) + "\"";
const user = (n: number, text: string): string => "{\"type\":\"user\"," + head(n) + ",\"message\":{\"role\":\"user\",\"content\":\"" + text + "\"}}";
const call = (n: number, id: string, name: string, input: string): string => "{\"type\":\"assistant\"," + head(n) + ",\"message\":{\"id\":\"m" + id + "\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}],\"usage\":{\"input_tokens\":100,\"output_tokens\":10}}}";
const res = (n: number, id: string, text: string, err: boolean): string => "{\"type\":\"user\"," + head(n) + ",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"" + id + "\",\"content\":" + JSON.stringify(text) + (err ? ",\"is_error\":true" : "") + "}]}}";
const L: string[] = [user(0, "fix the tests"), call(1, "t1", "Bash", "{\"command\":\"npm test\"}"), res(2, "t1", "Exit code 1\nnpm ERR! missing script: test", true)];
for (let i = 0; i < 4; i++) { L.push(call(3 + i * 2, "l" + String(i), "Bash", "{\"command\":\"ls\"}")); L.push(res(4 + i * 2, "l" + String(i), "a.ts", false)); }
L.push(call(20, "e1", "Edit", "{\"file_path\":\"" + dir + "/p1/a.ts\",\"old_string\":\"a\",\"new_string\":\"b\\nc\"}")); L.push(res(21, "e1", "ok", false));
L.push(user(30, "now commit"));
const sp = dir + "/" + SID + ".jsonl"; writeFileSync(sp, L.join("\n") + "\n");
mkdirSync(dir + "/" + SID + "/subagents", { recursive: true });
const ap = dir + "/" + SID + "/subagents/agent-ab12.jsonl";
writeFileSync(ap, [user(10, "look around"), call(11, "r1", "Read", "{\"file_path\":\"" + dir + "/p1/a.ts\"}"), res(12, "r1", "x", false)].join("\n") + "\n");
function real(h: string, id: string, path: string, parent: string): Sess {
  const s = newSess(h, id, path, false); const st = statSync(path); s.size = st.size; s.mtime = st.mtimeMs; s.cwd = dir + "/p1"; s.parent = parent; s.kind = parent ? "Explore" : ""; sessions.set(path, s); return s;
}
const cs = real("claude", SID, sp, ""); real("claude", "ab12", ap, SID);
const so = sessionObj(cs);
eq("session: id", str(so["id"]), SID);
eq("session: turns", String(so["turns"]), "2");
const errs = arr(so["errors"]); const e0 = obj(errs[0]);
eq("session: one error", String(errs.length), "1");
eq("session: error text by call id", e0 ? str(e0["text"]).slice(0, 11) : "", "Exit code 1");
eq("session: error tool/arg", e0 ? str(e0["tool"]) + " " + str(e0["arg"]) : "", "Bash npm test");
const rp = obj(arr(so["repeats"])[0]);
eq("session: repeats", rp ? str(rp["tool"]) + " " + str(rp["arg"]) + " " + String(rp["n"]) : "", "Bash ls 4");
const f0 = obj(arr(so["files"])[0]);
// the suite runs with --redact semantics: paths are faked like the Stats tab's, counts stay
eq("session: files", f0 ? String(str(f0["path"]) !== "") + " +" + String(f0["add"]) + " -" + String(f0["del"]) : "", "true +2 -1");
eq("session: subagents", String(arr(so["subagents"]).length), "1");
const m0 = obj(arr(so["models"])[0]);
eq("session: models", m0 ? str(m0["model"]) : "", "claude-sonnet-4-5");
const t0 = obj(arr(so["tools"])[0]);
eq("session: tools (subagent's Read counted too)", t0 ? str(t0["name"]) + " " + String(t0["calls"]) + " " + String(t0["errors"]) : "", "Bash 5 1");
eq("session: tools list", String(arr(so["tools"]).length), "3");
eq("session: costBasis", String(obj(so["costBasis"]) !== null), "true");

// ── errors: project scope, newest first, text by call id, limit, since ──
const SID2 = "99999999-2222-3333-4444-555555555555";
const head2 = (n: number): string => "\"sessionId\":\"" + SID2 + "\",\"cwd\":\"" + dir + "/p2\",\"timestamp\":\"" + T(n) + "\"";
const p2 = dir + "/" + SID2 + ".jsonl";
writeFileSync(p2, ["{\"type\":\"user\"," + head2(40) + ",\"message\":{\"role\":\"user\",\"content\":\"go\"}}",
  "{\"type\":\"assistant\"," + head2(41) + ",\"message\":{\"id\":\"mx\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"x1\",\"name\":\"Bash\",\"input\":{\"command\":\"make\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
  "{\"type\":\"user\"," + head2(42) + ",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"x1\",\"content\":\"make: *** no rule\",\"is_error\":true}]}}"].join("\n") + "\n");
const o2 = real("claude", SID2, p2, ""); o2.cwd = dir + "/p2";
// a second error in p1, later than the first
appendFileSync(sp, [call(50, "t2", "Bash", "{\"command\":\"npm run lint\"}"), res(51, "t2", "Exit code 2\nlint failed", true)].join("\n") + "\n");
const st1 = statSync(sp); cs.size = st1.size; cs.mtime = st1.mtimeMs;
const sc1 = scopeOf(true, [], "", dir + "/p1");
const er = errorRows("", 0, 0, sc1, "");
eq("errors: source", er.source, "recent");
eq("errors: only the project's, newest first", er.rows.map((r) => str(r["arg"])).join(","), "npm run lint,npm test");
eq("errors: text by call id", er.rows.map((r) => str(r["text"])).join("|"), "Exit code 2\nlint failed|Exit code 1\nnpm ERR! missing script: test");
eq("errors: limit", String(errorRows("", 0, 1, sc1, "").rows.length), "1");
eq("errors: --all-projects", String(errorRows("", 0, 0, scopeOf(true, ["--all-projects"], "", dir + "/p1"), "").rows.length), "3");
eq("errors: since drops older", String(errorRows("", Date.parse(T(45)), 0, sc1, "").rows.length), "1");
eq("errors: harness", String(errorRows("", 0, 0, sc1, "codex").rows.length), "0");

// ── --since ──
const now = Date.parse("2026-10-03T15:30:00.000Z");
eq("since 24h", String(parseSince("24h", now)), String(now - 86400000));
eq("since today", dayKeyOf(parseSince("today", now)), dayKeyOf(now));
eq("since today is a midnight", String(new Date(parseSince("today", now)).getHours() + new Date(parseSince("today", now)).getMinutes()), "0");
eq("since 7d = 6 days before today", dayKeyOf(parseSince("7d", now)), dayKeyOf(now - 6 * 86400000));
eq("since date", dayKeyOf(parseSince("2026-09-01", now)) + " " + String(new Date(parseSince("2026-09-01", now)).getHours()), "2026-09-01 0");
eq("since bad", [parseSince("x", now), parseSince("0d", now), parseSince("2026-02-30", now), parseSince("5m", now)].map((n) => String(n)).join(","), "-1,-1,-1,-1");
eq("midnightOf today", String(midnightOf(dayKeyOf(Date.now()))), String(startOfDay()));

rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "queries: all checks passed");
if (bad) process.exit(1);
