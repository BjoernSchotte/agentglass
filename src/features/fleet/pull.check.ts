// agentglass — self-check for fleet pull: scriptc build src/features/fleet/pull.check.ts -o pc && ./pc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { sessions } from "../../model/sessions.ts";
import { jsonSess } from "../cli.ts";
import { type Obj, obj } from "../../util/json.ts";
import { FORMAT } from "./model.ts";
import { pullReport } from "./pull.ts";
import { reportLines, parseReport } from "./report.ts";
import { REDACT } from "../redact-on.ts";
import "../wait/cli.ts"; // registers fleet pull --wait

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "cache");
const p = join(HOME, ".claude", "projects", "-w-app"); mkdirSync(p, { recursive: true });
function sess(id: string, iso: string): string {
  return '{"type":"user","sessionId":"' + id + '","cwd":"/w/app","timestamp":"' + iso + '","message":{"role":"user","content":"fix the keepme bug"}}\n' +
    '{"type":"assistant","sessionId":"' + id + '","timestamp":"' + iso + '","message":{"id":"m-' + id + '","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000,"output_tokens":10}}}\n';
}
const now = Date.now(); const old = now - 10 * 86400000;
writeFileSync(join(p, "s-new.jsonl"), sess("s-new", new Date(now - 60000).toISOString()));
writeFileSync(join(p, "s-old.jsonl"), sess("s-old", new Date(old).toISOString()));
const t = new Date(old); const two = (n: number): string => (n < 10 ? "0" : "") + String(n); // touch -t: GNU and BSD
execFileSync("touch", ["-t", String(t.getFullYear()) + two(t.getMonth() + 1) + two(t.getDate()) + two(t.getHours()) + two(t.getMinutes()), join(p, "s-old.jsonl")]);
const r = pullReport(7, now);
ok("7 days: 1 session", r.sessions.length === 1 && (r.sessions[0]?.key ?? "") === "claude:s-new", JSON.stringify(r.sessions.map((x) => x.key)));
let s0: Obj | null = null;
for (const s of sessions.values()) if (s.id === "s-new") s0 = jsonSess(s);
ok("object = --json object", s0 !== null && JSON.stringify(r.sessions[0]?.s ?? null) === JSON.stringify(s0), JSON.stringify(r.sessions[0]?.s ?? null) + " vs " + JSON.stringify(s0));
ok("hello", r.hello.format === FORMAT && /^[0-9a-f]{16}$/.test(r.hello.hostId) && r.hello.days === 7 && r.hello.now === now, JSON.stringify(r.hello));
const today = obj((r.cost ?? {})["today"]);
ok("cost today.byMode", today !== null && obj(today["byMode"]) !== null, JSON.stringify(r.cost));
ok("allowance shape", JSON.stringify(r.allowance) === "{\"claude\":null,\"codex\":null}", JSON.stringify(r.allowance));
const ls = reportLines(r);
ok("end line", (ls[ls.length - 1] ?? "").startsWith("{\"end\""), ls[ls.length - 1] ?? "");
ok("parses back", parseReport(ls.join("\n")).r !== null, parseReport(ls.join("\n")).err);
const r30 = pullReport(30, now);
ok("30 days: 2 sessions, newest first", r30.sessions.length === 2 && (r30.sessions[0]?.key ?? "") === "claude:s-new", JSON.stringify(r30.sessions.map((x) => x.key)));
// twins (one session under two project dirs: a resume from another worktree copies the log) are one row: rows are keyed
// by harness:id on the viewer, the copy that stands for the session (sessref.ts owns) is sent
const p2 = join(HOME, ".claude", "projects", "-w-app-codex"); mkdirSync(p2, { recursive: true });
writeFileSync(join(p2, "s-new.jsonl"), sess("s-new", new Date(now - 60000).toISOString()) + sess("s-new2", new Date(now - 30000).toISOString()).split("s-new2").join("s-new"));
const rt = pullReport(7, now);
ok("twins: one row", rt.sessions.length === 1 && (rt.sessions[0]?.key ?? "") === "claude:s-new", JSON.stringify(rt.sessions.map((x) => x.key)));
// agent-wait: --wait adds one wait line after allowance (families, no command line; --redact: no script name)
{
  const q = (x: string): string => JSON.stringify(x); const t0 = new Date(now - 120000).toISOString(); const t1 = new Date(now - 60000).toISOString();
  writeFileSync(join(p, "s-gen.jsonl"), '{"type":"user","sessionId":"s-gen","cwd":"/w/app","timestamp":' + q(t0) + ',"message":{"role":"user","content":"gen"}}\n' +
    '{"type":"assistant","sessionId":"s-gen","timestamp":' + q(t0) + ',"message":{"id":"m-gen","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"tg","name":"Bash","input":{"command":"node scripts/gen.js --all"}}],"usage":{"input_tokens":1,"output_tokens":1}}}\n' +
    '{"type":"user","sessionId":"s-gen","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tg","content":"x"}]},"uuid":"ug","timestamp":' + q(t1) + '}\n');
  const lw = reportLines(pullReport(7, now, true)); const l0 = reportLines(pullReport(7, now));
  ok("--wait: one wait line after allowance", (lw[3] ?? "").startsWith("{\"wait\":") && lw.filter((l: string) => l.startsWith("{\"wait\"")).length === 1 && (lw[2] ?? "").startsWith("{\"allowance\""), lw.slice(0, 4).join("\n").slice(0, 300));
  ok("without --wait: none", l0.filter((l: string) => l.startsWith("{\"wait\"")).length === 0, "a wait line");
  const wl = lw[3] ?? "";
  ok("wait carries the family", wl.indexOf(REDACT ? "\"key\":\"node\"" : "\"key\":\"node gen.js\"") >= 0, wl.slice(0, 300));
  ok("no command line", wl.indexOf("--all") < 0, "the command line leaked");
  if (REDACT) ok("--redact: no script name", wl.indexOf("gen.js") < 0, "gen.js in the wait line");
  const back = parseReport(lw.join("\n")).r;
  ok("wait round-trips", back !== null && JSON.stringify(back.wait) === wl.slice(8, wl.length - 1), back ? JSON.stringify(back.wait).slice(0, 200) : "no report");
}
console.log(bad ? String(bad) + " failed" : "fleet pull: all checks passed");
if (bad) process.exit(1);
