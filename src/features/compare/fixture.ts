// agentglass — compare fixture: hand-written lines in real shapes for the compare checks (specs/session-compare/plan.md Task 2)
// SPDX-License-Identifier: Apache-2.0
//   a1   claude TMP/app  sonnet  09:00 1 prompt · 2 messages (in 1000 / out 200 / cache read 3000 each) · Bash npm test ok 2 s,
//        Bash npm test error 4 s, Edit src/a.ts +3 −1, Edit src/shared.ts +1 −0, mcp__github__get_issue ok 1 s (one call per 5 min)
//   b1   claude TMP/app  opus    11:00 + 11:30 prompts, 11:20 task notification (no turn) · 3 messages (2000 / 400 / cache read
//        1000 each) · Bash npm test ok 1 s, Read ×3, Edit src/shared.ts +2 −2, Edit src/b.ts +5 −0, get_issue ok, list_prs error 2 s (11:50)
//   b1s  claude TMP/app  sonnet  subagent of b1, 11:10, 1 message (800 / 50) · Grep ×2 ok 0.2 s
//   f1   fx     TMP/app  fx-large 08:00 1 prompt · 1 shell call (fx stamps a turn alike: no duration), no usage file (no price)
import { mkdirSync, rmSync } from "node:fs";
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { accOf } from "../usage/ledger.ts";
import { fxReset, fxSession, isoAt } from "../query/fixture.ts";

export const TMP = "/tmp/agentglass-compare-check-" + String(process.pid);
function q(s: string): string { return JSON.stringify(s); }
function plus(iso: string, ms: number): string { return new Date(Date.parse(iso) + ms).toISOString(); }
export function prompt(iso: string, text: string): string { return "{\"type\":\"user\",\"timestamp\":" + q(iso) + ",\"message\":{\"role\":\"user\",\"content\":" + q(text) + "},\"uuid\":\"p" + iso + "\"}"; }
// one tool call of assistant message mid (lines of one message share id + usage: booked once) and its result after ms (err)
export function call(iso: string, mid: string, model: string, usage: string, name: string, id: string, input: string, ms: number, err: boolean): string[] {
  return ["{\"type\":\"assistant\",\"timestamp\":" + q(iso) + ",\"message\":{\"id\":" + q(mid) + ",\"model\":" + q(model) + ",\"content\":[{\"type\":\"tool_use\",\"id\":" + q(id) + ",\"name\":" + q(name) + ",\"input\":" + input + "}],\"usage\":" + usage + "}}",
    "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":" + q(id) + (err ? ",\"is_error\":true" : "") + ",\"content\":\"x\"}]},\"uuid\":\"u" + id + "\",\"timestamp\":" + q(plus(iso, ms)) + "}"];
}
function U(i: number, o: number, cr: number): string { return "{\"input_tokens\":" + String(i) + ",\"output_tokens\":" + String(o) + ",\"cache_read_input_tokens\":" + String(cr) + "}"; }
function edit(path: string, oldS: string, newS: string): string { return "{\"file_path\":" + q(path) + ",\"old_string\":" + q(oldS) + ",\"new_string\":" + q(newS) + "}"; }
// one Edit call at 10:00 today in a message of its own (sections check: a session in another repo)
export function editLine(path: string): string[] { return call(isoAt(0, 10, 0), "mz" + path, "claude-sonnet-4-5", U(10, 5, 0), "Edit", "ez" + path, edit(path, "a", "b"), 100, false); }
// the session's last activity is its last line (fxSession stamps now): wall time is first → last
function ends(s: Sess, iso: string): void { const t = Date.parse(iso); s.mtime = t; s.last = t; }
function cat(xs: string[][]): string[] { const o: string[] = []; for (const x of xs) for (const l of x) o.push(l); return o; }

export function cmpBase(): void {
  fxReset();
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP + "/app/.git", { recursive: true });
  const app = TMP + "/app"; const S4 = "claude-sonnet-4-5"; const O4 = "claude-opus-4-5";
  const t = (h: number, m: number): string => isoAt(0, h, m);
  const ua = U(1000, 200, 3000);
  const a1 = fxSession("claude", "a1", app, "", S4, cat([
    [prompt(t(9, 0), "fix the failing test")],
    call(t(9, 0), "ma1", S4, ua, "Bash", "a1c1", "{\"command\":\"npm test\"}", 2000, false),
    call(t(9, 5), "ma1", S4, ua, "Bash", "a1c2", "{\"command\":\"npm test\"}", 4000, true),
    call(t(9, 10), "ma1", S4, ua, "Edit", "a1c3", edit(app + "/src/a.ts", "x", "a\nb\nc"), 500, false),
    call(t(9, 15), "ma2", S4, ua, "Edit", "a1c4", edit(app + "/src/shared.ts", "", "y"), 500, false),
    call(t(9, 20), "ma2", S4, ua, "mcp__github__get_issue", "a1c5", "{\"n\":1}", 1000, false),
  ]));
  ends(a1, t(9, 20));
  const ub = U(2000, 400, 1000);
  const b1 = fxSession("claude", "b1", app, "", O4, cat([
    [prompt(t(11, 0), "fix the failing test")],
    call(t(11, 0), "mb1", O4, ub, "Bash", "b1c1", "{\"command\":\"npm test\"}", 1000, false),
    call(t(11, 5), "mb1", O4, ub, "Read", "b1c2", "{\"file_path\":" + q(app + "/src/a.ts") + "}", 100, false),
    call(t(11, 6), "mb1", O4, ub, "Read", "b1c3", "{\"file_path\":" + q(app + "/src/b.ts") + "}", 100, false),
    call(t(11, 7), "mb2", O4, ub, "Read", "b1c4", "{\"file_path\":" + q(app + "/src/shared.ts") + "}", 100, false),
    [prompt(t(11, 20), "<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>")],
    call(t(11, 25), "mb2", O4, ub, "Edit", "b1c5", edit(app + "/src/shared.ts", "p\nq", "r\ns"), 500, false),
    [prompt(t(11, 30), "now also add a test")],
    call(t(11, 35), "mb3", O4, ub, "Edit", "b1c6", edit(app + "/src/b.ts", "", "1\n2\n3\n4\n5"), 500, false),
    call(t(11, 40), "mb3", O4, ub, "mcp__github__get_issue", "b1c7", "{\"n\":1}", 1000, false),
    call(t(11, 48), "mb3", O4, ub, "mcp__github__list_prs", "b1c8", "{}", 2000, true),
  ]));
  ends(b1, t(11, 50));
  const b1s = fxSession("claude", "b1s", app, "b1", S4, cat([
    [prompt(t(11, 10), "find the callers of shared")],
    call(t(11, 10), "mbs1", S4, U(800, 50, 0), "Grep", "bsc1", "{\"pattern\":\"shared\"}", 200, false),
    call(t(11, 11), "mbs1", S4, U(800, 50, 0), "Grep", "bsc2", "{\"pattern\":\"a\"}", 200, false),
  ]));
  ends(b1s, t(11, 11));
  const f8 = Date.parse(t(8, 0));
  const f1 = fxSession("fx", "f1", app, "", "fx-large", [
    "{\"seq\":1,\"timestamp_ms\":" + String(f8) + ",\"event\":{\"user\":{\"text\":\"list the files\"}}}",
    "{\"seq\":2,\"timestamp_ms\":" + String(f8 + 1000) + ",\"event\":{\"tool_call\":{\"tool_name\":\"shell\",\"call_id\":\"f1c1\",\"arguments_json\":" + q("{\"command\":\"ls\"}") + "}}}",
    "{\"seq\":3,\"timestamp_ms\":" + String(f8 + 1000) + ",\"event\":{\"tool_result\":{\"call_id\":\"f1c1\",\"status\":\"success\",\"output_bytes\":10}}}",
  ]);
  ends(f1, t(8, 0));
  b1.subs = [b1s]; b1s.depth = 1; // buildView's tree (the list and the previous pick read it)
}
export function cmpCleanup(): void { rmSync(TMP, { recursive: true, force: true }); }
export function sess(id: string): Sess { for (const s of sessions.values()) if (s.id === id) return s; throw new Error("fixture: no session " + id); }
export function costOf(id: string): number { return accOf(sess(id)).cost; }
