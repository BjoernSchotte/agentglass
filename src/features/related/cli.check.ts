// agentglass — --json --related assembly: scriptc build src/features/related/cli.check.ts -o rcc && ./rcc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { P } from "../../model/project.ts";
import { relatedJson } from "./cli.ts";
import "../redact.ts"; // the binary loads it: --redact rewrites events, titles and labels

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
P.sync = true;
const D = "/tmp/agentglass-related-cli-" + String(process.pid);
rmSync(D, { recursive: true, force: true });
function repo(p: string): void { mkdirSync(p + "/.git", { recursive: true }); writeFileSync(p + "/.git/config", "[core]\n"); writeFileSync(p + "/.git/HEAD", "ref: refs/heads/main\n"); }
const K = D + "/keepme-proj"; const O = D + "/other"; const Q = D + "/private";
repo(K); repo(O); repo(Q); mkdirSync(D + "/logs", { recursive: true });
const T = Date.parse("2026-09-30T14:00:00Z");
function iso(s: number): string { return new Date(T + s * 1000).toISOString(); }
function user(s: number, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(s), message: { role: "user", content: text } }); }
function call(s: number, id: string, name: string, input: string): string { return "{\"type\":\"assistant\",\"timestamp\":\"" + iso(s) + "\",\"message\":{\"id\":\"m" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}]}}"; }
function res(s: number, id: string, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }); }
function sess(id: string, cwd: string, lines: string[]): Sess {
  const p = D + "/logs/" + id + ".jsonl"; writeFileSync(p, lines.join("\n") + "\n");
  const s = newSess("claude", id, p, false); s.cwd = cwd; s.headDone = true;
  const st = statSync(p); s.size = st.size; s.mtime = T + 600000;
  sessions.set(p, s); return s;
}
const edit = (f: string): string => "{\"file_path\":\"" + f + "/src/a.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}";
const sa = sess("aaaaaa11", K, [user(0, "start"), call(60, "call-a", "Edit", edit(K)), res(61, "call-a", "ok")]);
const sb = sess("bbbbbb22", K, [user(30, "other"), call(130, "call-b", "Edit", edit(K)), res(131, "call-b", "ok")]);
sess("aaaaaa99", O, [user(10, "elsewhere"), call(70, "call-o", "Edit", edit(O))]); // another project, sharing a prefix with sa
const r = relatedJson("aaaaaa1", "call-a", "", 10, () => true);
eq("code 0", String(r.code) + " " + r.err, "0 ");
let j: { anchor: { session: string; t: string; kind: string }; project: { key: string }; events: { t: string; session: string; kind: string; conflict: { kind: string; with: string[] } | null }[]; sessions: { id: string }[] } | null = null;
try { j = JSON.parse(r.json); } catch (e) { j = null; }
if (!j) { bad++; console.log("FAIL json: " + r.json.slice(0, 200)); } else {
  eq("anchor", j.anchor.session + " " + j.anchor.t, "aaaaaa11 " + iso(60));
  const jo = JSON.parse(r.json);
  eq("complete: no sessions left out, not capped", String(jo.more) + " " + String(jo.capped), "0 false");
  eq("other project absent", String(j.sessions.map((x) => x.id).sort().join(",")), "aaaaaa11,bbbbbb22");
  let sorted = true; for (let i = 1; i < j.events.length; i++) if ((j.events[i]?.t ?? "") < (j.events[i - 1]?.t ?? "")) sorted = false;
  eq("events sorted by t", String(sorted) + " " + String(j.events.length), "true 4");
  const cb = j.events.find((e) => e.session === "bbbbbb22" && e.kind === "write");
  eq("conflict row", cb && cb.conflict ? cb.conflict.kind + " " + cb.conflict.with.join(",") : "none", "conflict aaaaaa11");
}
const amb = relatedJson("aaaaaa", "", "", 10, () => true);
eq("ambiguous prefix → 4, two candidates", String(amb.code) + " " + String(amb.hint.split("\n").length), "4 2");
eq("unknown → 3", String(relatedJson("zzzzzz", "", "", 10, () => true).code), "3");
eq("too short → 2", String(relatedJson("zz", "", "", 10, () => true).code), "2");
eq("unknown event → 3", String(relatedJson("aaaaaa11", "nope", "", 10, () => true).code), "3");
eq("bad --at → 2", String(relatedJson("aaaaaa11", "", "yesterday-ish", 10, () => true).code), "2");
const early = relatedJson("bbbbbb22", "", iso(-3600), 10, () => true);
eq("--at before the first event → the first event", early.code === 0 ? String(JSON.parse(early.json).anchor.t) : early.err, iso(30));
const late = relatedJson("bbbbbb22", "", "", 10, () => true);
eq("no --event/--at → the last event (a result: its call's row)", late.code === 0 ? String(JSON.parse(late.json).anchor.t) + " " + String(JSON.parse(late.json).anchor.kind) : late.err, iso(130) + " write");
eq("out of scope → 3", String(relatedJson("aaaaaa11", "", "", 10, (s: Sess) => s.id !== "aaaaaa11").code), "3");
// --redact (the checks run with AGENTGLASS_REDACT=1): titles, labels and content of a non-kept project are the fakes
sess("cccccc33", Q, [user(0, "secret plan alpha"), call(5, "call-q", "Bash", "{\"command\":\"cat secret-alpha.txt\"}")]);
const q = relatedJson("cccccc33", "", "", 10, () => true);
eq("redacted: no real title or content", String(q.code === 0 && q.json.indexOf("secret") < 0 && q.json.indexOf("private") < 0), "true");
// --redact keeps the flags: conflicts and clobbers are computed on the real files and commands, only fakes are shown
const sedit = "{\"file_path\":\"" + Q + "/src/secretmod.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}";
sess("dddddd44", Q, [user(100, "one"), call(160, "call-d", "Edit", sedit), res(161, "call-d", "ok")]);
sess("eeeeee55", Q, [user(110, "two"), call(190, "call-e", "Edit", sedit), res(191, "call-e", "ok")]);
sess("ffffff66", Q, [user(120, "three"), call(200, "call-f", "Bash", "{\"command\":\"git reset --hard\"}"), res(201, "call-f", "HEAD is now at 1234567")]);
const rq = relatedJson("dddddd44", "call-d", "", 10, () => true);
let rj: { events: { session: string; kind: string; text: string; files: string[]; conflict: { kind: string; with: string[] } | null }[] } | null = null;
try { rj = JSON.parse(rq.json); } catch (e) { rj = null; }
if (!rj) { bad++; console.log("FAIL redact json: " + rq.err); } else {
  const evs = rj.events;
  const fl = (sid: string, k: string): string => evs.filter((e) => e.session === sid && e.kind === k && e.conflict !== null).map((e) => (e.conflict ? e.conflict.kind + ":" + e.conflict.with.slice().sort().join(",") : "")).join(" ");
  eq("redacted: conflict of the first writer", fl("dddddd44", "write"), "conflict:eeeeee55");
  eq("redacted: conflict of the second writer", fl("eeeeee55", "write"), "conflict:dddddd44");
  eq("redacted: clobber over the others' writes", fl("ffffff66", "shell"), "clobber:dddddd44,eeeeee55");
  const fs = evs.filter((e) => e.kind === "write").map((e) => e.files.join(","));
  eq("redacted: both writes show one fake file", String(fs.length === 2 && fs[0] === fs[1] && (fs[0] ?? "") !== ""), "true");
  eq("redacted: clobber shows the git command form", evs.filter((e) => e.session === "ffffff66" && e.kind === "shell").map((e) => e.text).join(""), "git reset --hard");
}
eq("redacted: no real path, file name or project", String(rq.json.indexOf("secretmod") < 0 && rq.json.indexOf("private") < 0 && rq.json.indexOf(D) < 0), "true");
rmSync(D, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "related cli: all checks passed");
process.exit(bad ? 1 : 0);
