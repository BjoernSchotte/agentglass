// agentglass — the sessions read model (local-web-api W1): rows = the --json rows, cursor pages, filter errors, redact,
// generation counter, meta. Runs itself as two children (AGENTGLASS_REDACT is read at start):
// scriptc build src/read/sessions.check.ts -o rsc && HOME=$(mktemp -d) ./rsc
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { type Obj, obj, str } from "../util/json.ts";
import { CLAUDE } from "../util/fs.ts";
import { discover } from "../features/cli.ts";
import { type SessQ, readSessions, readSession } from "./sessions.ts";
import { readMeta, gen } from "./meta.ts";
import "../features/redact.ts"; // the binary loads every feature: --redact's fakes
import "../features/skills/marks.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const mode = process.argv[2] ?? "";
const day = new Date().toISOString().slice(0, 10);
const IDS = ["aaaaaaa1-0000-4000-8000-000000000001", "aaaaaaa2-0000-4000-8000-000000000002", "aaaaaaa3-0000-4000-8000-000000000003"];
const TITLES = ["alpha marmalade", "bravo marmalade", "charlie marmalade"];
const dir = CLAUDE + "/projects/-w-rsc";
function file(i: number): string { return dir + "/" + (IDS[i] ?? "") + ".jsonl"; }
function line(id: string, k: number, text: string): string {
  return "{\"type\":\"user\",\"sessionId\":\"" + id + "\",\"cwd\":\"/w/rsc\",\"timestamp\":\"" + day + "T00:00:0" + String(k) + ".000Z\",\"message\":{\"role\":\"user\",\"content\":\"" + text + "\"}}\n" +
    "{\"type\":\"assistant\",\"sessionId\":\"" + id + "\",\"cwd\":\"/w/rsc\",\"timestamp\":\"" + day + "T00:00:0" + String(k + 1) + ".000Z\",\"message\":{\"id\":\"m" + id.slice(0, 8) + String(k) + "\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"usage\":{\"input_tokens\":1000,\"output_tokens\":100}}}\n";
}
function Q(filter: string, limit: number, cursor: string): SessQ { return { filter, limit, cursor, subagents: false, team: "", room: "" }; }
function ids(rows: Obj[]): string { const o: string[] = []; for (const r of rows) o.push(str(r["id"]).slice(0, 8)); return o.join(","); }
function code(q: SessQ): string { const r = readSessions(q); return r.err ? r.err.code : ""; }

if (mode === "--child-plain") {
  discover();
  const all = readSessions(Q("", 0, ""));
  eq("no error", all.err ? all.err.code : "", "");
  const p = all.page;
  eq("newest first", p ? ids(p.data) : "", "aaaaaaa3,aaaaaaa2,aaaaaaa1");
  eq("one page", p ? String(p.next) : "", "null");
  const r0: Obj = p ? p.data[0] ?? {} : {};
  const tk = obj(r0["tokens"]) ?? {};
  eq("--json fields", JSON.stringify([r0["harness"], r0["title"], r0["live"], tk["in"]]), JSON.stringify(["claude", TITLES[2], false, 1000]));
  // state: the filter's state attribute (status is free text, e.g. pi's "open" while it works)
  eq("state", str(r0["state"]), "ended");
  const st = readSessions(Q("state is ended", 0, "")).page;
  eq("state = filter state", st ? ids(st.data) : "", "aaaaaaa3,aaaaaaa2,aaaaaaa1");
  eq("at is now", p &&Math.abs(p.at - Date.now()) < 60000 ? "ok" : "off", "ok");
  // pages of 2 cover the list exactly once, newest first
  const p1 = readSessions(Q("", 2, "")).page;
  const c1 = p1 && p1.next !== null ? p1.next : "";
  const p2 = readSessions(Q("", 2, c1)).page;
  eq("page 1", p1 ? ids(p1.data) : "", "aaaaaaa3,aaaaaaa2");
  eq("page 2", p2 ? ids(p2.data) + " next " + String(p2.next) : "", "aaaaaaa1 next null");
  eq("bad cursor", code(Q("", 2, "nonsense")), "bad_param");
  // the filter language, errors with their column
  const f = readSessions(Q("title ~ bravo", 0, "")).page;
  eq("filter", f ? ids(f.data) : "", "aaaaaaa2");
  const e = readSessions(Q("cost >", 0, "")).err;
  eq("bad filter code", e ? e.code : "", "bad_filter");
  eq("bad filter column", e && e.msg.indexOf("column ") >= 0 ? "col" : (e ? e.msg : ""), "col");
  eq("bad filter caret", e && e.hint.indexOf("^") >= 0 ? "caret" : "", "caret");
  eq("no team", code({ filter: "", limit: 0, cursor: "", subagents: false, team: "acme", room: "" }), "no_team");
  // one session in full (session <ref>)
  const one = readSession("aaaaaaa2");
  eq("session ref", one.data ? str(one.data["id"]) : "", IDS[1] ?? "");
  eq("session turns", one.data && typeof one.data["turns"] === "number" ? "n" : "", "n");
  const miss = readSession("zzzzzzzz");
  eq("session missing", miss.err ? miss.err.code : "", "not_found");
  // the generation moves with the inputs only
  const g1 = gen("sessions"); const g2 = gen("sessions");
  eq("gen steady", String(g2), String(g1));
  appendFileSync(file(0), line(IDS[0] ?? "", 3, "more marmalade"));
  discover();
  eq("gen bumped", String(gen("sessions") > g2), "true");
  const top = readSessions(Q("", 1, "")).page;
  eq("appended row first", top ? ids(top.data) : "", "aaaaaaa1");
  eq("unknown resource", String(gen("nope")), "0");
  const m = readMeta(true);
  eq("meta", JSON.stringify([m["proto"], m["contract"], m["readOnly"], m["redact"], m["teams"]]), JSON.stringify([1, 1, true, false, []]));
  eq("meta harnesses", JSON.stringify(m["harnesses"]).indexOf("\"claude\"") >= 0 ? "ok" : "", "ok");
  const cs = JSON.stringify(m["caps"]);
  eq("meta caps", cs.indexOf("\"sessions\"") >= 0 && cs.indexOf("\"cmd\"") < 0 ? "ok" : cs, "ok");
  console.log(bad ? bad + " failed" : "plain ok");
  process.exit(bad ? 1 : 0);
}
if (mode === "--child-redact") {
  discover();
  const p = readSessions(Q("", 0, "")).page;
  const j = JSON.stringify(p ? p.data : []);
  eq("redact rows", p ? String(p.data.length) : "", "3");
  eq("redact: no real title", j.indexOf("marmalade") < 0 ? "fake" : "real", "fake");
  eq("redact meta", String(readMeta(false)["redact"]), "true");
  // a filter still matches the real values
  const f = readSessions(Q("title ~ bravo", 0, "")).page;
  eq("redact filter", f ? String(f.data.length) : "", "1");
  console.log(bad ? bad + " failed" : "redact ok");
  process.exit(bad ? 1 : 0);
}

mkdirSync(dir, { recursive: true });
for (let i = 0; i < 3; i++) {
  writeFileSync(file(i), line(IDS[i] ?? "", 1, TITLES[i] ?? ""));
  // no utimesSync in scriptc; ISO with Z: GNU and BSD (macOS) touch both take it, "@<epoch>" only GNU
  execFileSync("touch", ["-d", new Date(Date.now() - (3 - i) * 60000).toISOString().slice(0, 19) + "Z", file(i)]);
}
function child(m: string, redact: string): string {
  const sh = "AGENTGLASS_REDACT=" + redact + " AGENTGLASS_AGENT=0 '" + process.execPath + "' " + m + " 2>&1; echo \"rc=$?\"";
  return execFileSync("sh", ["-c", sh], { encoding: "utf8" }).trim();
}
const a = child("--child-plain", "0"); if (!a.endsWith("rc=0")) { bad++; console.log(a); }
const b = child("--child-redact", "1"); if (!b.endsWith("rc=0")) { bad++; console.log(b); }
console.log(bad ? bad + " failed" : "read/sessions: all checks passed");
if (bad) process.exit(1);
