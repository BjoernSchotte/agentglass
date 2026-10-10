// agentglass events: the same events as the TUI's filter (parity), gap entries, --limit, no text without --content
// scriptc build src/features/events-cli.check.ts -o evc && ./evc
// SPDX-License-Identifier: Apache-2.0
import { type Ev, type Sess, newSess } from "../model/types.ts";
import { parseEvents } from "../harness/index.ts";
import { type Obj } from "../util/json.ts";
import { mask, vfSet, vfOf, preset } from "../ui/evfilter.ts";
import { listEvents, cliView } from "./events-cli.ts";
import { sessions } from "../model/sessions.ts";
import { ledger, accOf, applyAcc } from "./usage/ledger.ts";
import { L, skillLoad } from "./usage/record.ts";
import { setVis } from "./skills/vis.ts";
import "./skills/marks.ts"; // registers the skill marks (the binary loads it with every feature)

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const T = Date.parse("2026-10-01T09:00:00Z");
function iso(x: number): string { return new Date(T + x * 1000).toISOString(); }
function cu(x: number, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(x), message: { role: "user", content: text } }); }
function ca(x: number, id: string, name: string, input: string): string { return "{\"type\":\"assistant\",\"timestamp\":\"" + iso(x) + "\",\"message\":{\"id\":\"m" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}]}}"; }
function tr(x: number, id: string, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(x), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }); }
const s: Sess = newSess("claude", "evcli-0001", "/k/evcli.jsonl", false); s.size = 1;
const evs: Ev[] = [];
for (const l of [cu(0, "SECRETPROMPT fix it"), ca(1, "b1", "Bash", "{\"command\":\"npm test\"}"), tr(2, "b1", "Exit code 1"), ca(3, "s1", "Skill", "{\"skill\":\"brainstorming\"}"), tr(4, "s1", "ok"),
  ca(5, "r1", "Read", "{\"file_path\":\"/w/a.ts\"}"), tr(6, "r1", "x"), ca(7, "m1", "mcp__github__get_issue", "{\"number\":1}"), tr(8, "m1", "body"), ca(9, "b2", "Bash", "{\"command\":\"npm test\"}"), tr(10, "b2", "ok")]) parseEvents("claude", l, evs, s);
cliView();
function idx(o: Obj[]): string { const r: string[] = []; for (const x of o) r.push(x["gap"] !== undefined ? "~" + String(x["gap"]) : String(x["i"])); return r.join(","); }
function tui(): string { const m = mask("transcript", s, evs); const r: string[] = []; for (let i = 0; i < evs.length; i++) if (m[i] + 0 === 1) r.push(String(i)); return r.join(","); }
function cli(): string { const r: string[] = []; for (const x of listEvents(s, evs, 0, false).events) if (x["gap"] === undefined) r.push(String(x["i"])); return r.join(","); }
for (const ex of ["event.kind is_one_of skill error", "event.kind is shell", "mcp.server is github", "not event.kind is read", "shell.family ~ test", ""]) {
  vfSet("transcript", ex); vfSet("events", ex);
  eq("parity " + ex, cli(), tui());
}
vfSet("events", "event.kind is_one_of skill error");
const r = listEvents(s, evs, 0, false);
eq("listing", idx(r.events), "~1,1,2,3,4,~6");
eq("counts", String(r.matched) + "/" + String(r.total), "4/11");
const g = r.events[0] ?? {}; eq("gap kinds", JSON.stringify(g), JSON.stringify({ gap: 1, kinds: { prompt: 1 } }));
const e1 = r.events[1] ?? {};
eq("an event", JSON.stringify([e1["kind"], e1["kinds"], e1["tool"], e1["id"], e1["target"], e1["text"]]), JSON.stringify(["tool", ["error", "shell:test"], "Bash", "b1", "npm test", null]));
eq("link", String(e1["link"]), "agentglass://open/claude/evcli-0001#call=b1");
eq("no text without --content", String(JSON.stringify(r).indexOf("SECRETPROMPT") < 0), "true");
vfSet("events", "");
eq("text with --content", String(JSON.stringify(listEvents(s, evs, 0, true)).indexOf("SECRETPROMPT") >= 0), "true");
// --limit: the last N matches, one gap before them for the rest
vfSet("events", "event.kind is shell");
eq("limit", idx(listEvents(s, evs, 2, false).events), "~9,9,10");
// presets as in the TUI: errors + causes (the failing call; the reply before it when there is one)
preset("events", 4); eq("preset errors", cli(), "1,2"); eq("preset expr", vfOf("events").expr, "event.kind is error");
// a skill tool's events name the skill (OpenCode's skill tool, Claude's Skill …), from the ledger's load of that call,
// through skillVis: a hidden name shows its fake, an omitted one nothing
setVis([], false); // the suite runs with AGENTGLASS_REDACT=1: names shown as they are here, fakes below
sessions.clear(); ledger.clear(); sessions.set(s.path, s);
const ac = accOf(s); ac.off = s.size;
skillLoad(ac, "brainstorming", "model", T + 4000, iso(4), "LOREM", true, "", false).cid = "s1";
applyAcc(s, ac); L.ver++;
function skTarget(): string { vfSet("events", "event.kind is skill"); const o: string[] = []; for (const x of listEvents(s, evs, 0, false).events) if (x["gap"] === undefined) o.push(String(x["kind"]) + " " + String(x["target"])); return o.join(", "); }
eq("skill events name the skill", skTarget(), "tool brainstorming, result brainstorming");
setVis([{ match: "brainstorming", mode: "name" }], false);
eq("hidden name: its fake", String(skTarget().indexOf("brainstorming") < 0 && skTarget().indexOf("null") < 0), "true");
setVis([{ match: "brainstorming", mode: "omit" }], false);
eq("omitted: no name", skTarget(), "tool null, result null");
setVis([], false);
// one call that read two skills (Codex cat a b): both names
skillLoad(ac, "tdd", "model", T + 4000, iso(4), "LOREM", true, "", false).cid = "s1";
applyAcc(s, ac); L.ver++;
eq("one call, two skills", skTarget(), "tool brainstorming, tdd, result brainstorming, tdd");
if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("events cli: ok");
