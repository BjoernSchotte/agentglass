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
console.log(bad ? String(bad) + " failed" : "fleet pull: all checks passed");
if (bad) process.exit(1);
