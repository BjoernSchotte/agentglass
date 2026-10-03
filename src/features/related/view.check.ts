// agentglass — related events view: scriptc build src/features/related/view.check.ts -o rvc && ./rvc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H } from "../../hooks.ts";
import { width } from "../../util/text.ts";
import { onInput } from "../../input.ts";
import { sessions } from "../../model/sessions.ts";
import { P } from "../../model/project.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { openDetail } from "../../ui/detail.ts";
import { parseEvents } from "../../harness/index.ts";
import { openGraph, graphAnchor } from "../callgraph/view.ts";
import { relState, viewLines } from "./view.ts";
import type { RelEv } from "./model.ts";
import { stepBuild } from "./build.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
P.sync = true;
S.W = 80; S.H = 24;
const D = "/tmp/agentglass-related-view-keepme-" + String(process.pid);
rmSync(D, { recursive: true, force: true });
mkdirSync(D + "/proj/.git", { recursive: true }); writeFileSync(D + "/proj/.git/config", "[core]\n"); writeFileSync(D + "/proj/.git/HEAD", "ref: refs/heads/main\n");
mkdirSync(D + "/logs", { recursive: true });
const T = Date.parse("2026-09-30T14:00:00Z");
function iso(s: number): string { return new Date(T + s * 1000).toISOString(); }
function user(s: number, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(s), message: { role: "user", content: text } }); }
function call(s: number, id: string, name: string, input: string): string { return "{\"type\":\"assistant\",\"timestamp\":\"" + iso(s) + "\",\"message\":{\"id\":\"m" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}]}}"; }
function res(s: number, id: string, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }); }
function cx(s: number, payload: string): string { return "{\"timestamp\":\"" + iso(s) + "\",\"type\":\"response_item\",\"payload\":" + payload + "}"; }
function sess(h: string, id: string, lines: string[]): Sess {
  const p = D + "/logs/" + id + ".jsonl"; writeFileSync(p, lines.join("\n") + "\n");
  const s = newSess(h, id, p, false); s.cwd = D + "/proj"; s.headDone = true;
  const st = statSync(p); s.size = st.size; s.mtime = T + 600000;
  sessions.set(p, s); return s;
}
const A = D + "/proj/src/a.ts";
const sa = sess("claude", "aaa", [
  user(0, "fix the login"),
  call(10, "e1", "Edit", "{\"file_path\":\"" + A + "\",\"old_string\":\"a\",\"new_string\":\"b\"}"), res(11, "e1", "ok"),
  call(20, "b1", "Bash", "{\"command\":\"npm test\"}"), res(25, "b1", "Exit code 1"),
  call(30, "r1", "Read", "{\"file_path\":\"" + D + "/proj/src/z.ts\"}"), res(31, "r1", "x"),
]);
const sb = sess("claude", "bbb", [user(40, "other task"), call(70, "e2", "Edit", "{\"file_path\":\"" + A + "\",\"old_string\":\"b\",\"new_string\":\"c\"}"), res(71, "e2", "ok")]);
const sc = sess("codex", "ccc", [cx(50, "{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":" + JSON.stringify("{\"command\":[\"bash\",\"-lc\",\"ls\"]}") + ",\"call_id\":\"s1\"}"), cx(51, "{\"type\":\"function_call_output\",\"call_id\":\"s1\",\"output\":\"ok\"}")]);
function rows(): RelEv[] { const st = relState(); if (!st) return []; const o: RelEv[] = []; for (let j = 0; j < st.vis.length; j++) { const r = st.b.rows[st.vis[j] ?? 0]; if (r) o.push(r); } return o; }
function show(): string { return rows().map((r: RelEv) => r.kind + ":" + r.tool).join(" "); }
function done(): void { const st = relState(); if (!st) return; for (let g = 0; g < 1000 && stepBuild(st.b, 1e9, () => Date.now()); g++) { /* to the end */ } viewLines(st, 80, 22); }

// ── from the transcript: r on the cursor event; esc back to the same transcript and cursor ──
openTranscript(sa);
const tv = S.tv;
if (!tv) { bad++; console.log("FAIL no transcript"); } else {
  for (const l of [user(0, "fix the login")]) parseEvents("claude", l, tv.evs, sa); // the transcript's events (render loads them lazily)
  tv.evs.length = 0; for (const l of [user(0, "fix the login"), call(10, "e1", "Edit", "{\"file_path\":\"" + A + "\",\"old_string\":\"a\",\"new_string\":\"b\"}"), res(11, "e1", "ok")]) parseEvents("claude", l, tv.evs, sa);
  tv.cur = 1;
  onInput("r");
  eq("r → view", S.mode + " " + S.fview, "view related");
  done();
  const st = relState();
  eq("anchor = the cursor's Edit", st ? st.b.anchor.evId : "", "e1");
  eq("rows interleaved, default kinds (no Read)", show(), "prompt: write:Edit shell:Bash prompt: shell:shell write:Edit");
  eq("both edits conflict", rows().filter((r: RelEv) => r.mark === "conflict").length + "", "2");
  const L = st ? viewLines(st, 80, 22) : [];
  eq("80 columns", L.every((l: string) => width(l.replace(/\x1b\[[0-9;]*m/g, "")) === 80) ? "ok" : L.map((l: string) => String(width(l.replace(/\x1b\[[0-9;]*m/g, "")))).join(","), "ok");
  eq("header at 80", (L[0] ?? "").indexOf("‼ 2") >= 0 ? "ok" : L[0] ?? "", "ok");
  const Lw = st ? viewLines(st, 160, 22) : [];
  eq("header wide: long labels", (Lw[0] ?? "").indexOf("±10m around") >= 0 && (Lw[0] ?? "").indexOf("3 sessions") >= 0 ? "ok" : Lw[0] ?? "", "ok");
  eq("anchor marker", L.some((l: string) => l.indexOf("▶") >= 0 && l.indexOf("+00:00") < 0 && l.indexOf(" 00:00") >= 0) ? "ok" : L.join("\n"), "ok");
  let fw = width("? keys") + 2 + width("esc back") + 2; // the footer: "? keys", the feature's hints, "esc back" (each + 2 spaces)
  for (const f of H.footerHints) for (const kd of f("view")) fw += width((kd[0] ?? "") + " " + (kd[1] ?? "")) + 2;
  eq("footer hints fit 80 columns", String(fw - 2 <= 79), "true");
  eq("conflict note", L.some((l: string) => l.indexOf("‼") >= 0 && l.indexOf("also edited by") >= 0) ? "ok" : L.join("\n"), "ok");
  onInput("esc");
  eq("esc → transcript", S.mode + " " + String(S.tv === tv) + " " + String(tv.cur), "transcript true 1");
  // ── window ──
  onInput("r"); const s2 = relState();
  onInput("+"); eq("+ 10 → 30", s2 ? String(s2.minutes) + " " + String((s2.b.t1 - s2.b.t0) / 60000) : "", "30 60");
  onInput("-"); onInput("-"); eq("- twice → 5", s2 ? String(s2.minutes) : "", "5");
  onInput("+");
  // ── kinds, own, files ──
  done();
  onInput("k"); done(); eq("k: all kinds (Read shown)", String(rows().some((r: RelEv) => r.kind === "read")), "true");
  onInput("k"); done(); eq("k: writes only", show(), "write:Edit write:Edit");
  onInput("k"); done(); eq("k: back to default", String(rows().some((r: RelEv) => r.kind === "read")), "false");
  onInput("o"); done(); eq("o hides own rows (the anchor stays)", rows().filter((r: RelEv) => r.sess === sa.path).length + "", "1");
  onInput("o"); onInput("f"); done(); eq("f: only rows sharing the anchor's files", show(), "write:Edit write:Edit");
  onInput("f"); done();
  // ── n / N ──
  const st3 = relState();
  if (st3) {
    st3.sel = 0; onInput("n"); const r1 = rows()[st3.sel]; eq("n → flagged row", r1 ? r1.mark : "", "conflict");
    const at1 = st3.sel; onInput("n"); onInput("N"); eq("N back", String(st3.sel), String(at1));
  }
  // ── filter ──
  onInput("/"); for (const ch of "tool is Bash") onInput(ch); onInput("enter"); done();
  eq("/ tool is Bash", show(), "write:Edit shell:Bash"); // the anchor always stays
  onInput("/"); onInput("ctrl-u"); for (const ch of "harness is codex") onInput(ch); onInput("enter"); done();
  eq("/ harness is codex", show(), "write:Edit shell:shell");
  onInput("/"); onInput("ctrl-u"); for (const ch of "tool is") onInput(ch); onInput("enter");
  eq("bad filter keeps the input open", S.mode + " " + String(S.inputErr !== ""), "input true");
  onInput("esc"); onInput("/"); onInput("ctrl-u"); onInput("enter"); done();
  // ── enter → another session's transcript, focused; esc back ──
  const st4 = relState();
  if (st4) {
    let bi = -1; const rs = rows(); for (let i = 0; i < rs.length; i++) if (rs[i]?.sess === sb.path && rs[i]?.kind === "write") bi = i;
    st4.sel = bi; onInput("enter");
    eq("enter → other transcript", S.mode + " " + (S.tv ? S.tv.s.id : "") + " " + (S.tv ? S.tv.focusTs : ""), "transcript bbb " + iso(70));
    onInput("esc"); eq("esc → related", S.mode + " " + S.fview, "view related");
  }
  onInput("esc"); eq("esc → transcript again", S.mode, "transcript");
}
// ── from the detail layer ──
const t2 = S.tv;
if (t2) {
  openDetail(1);
  const idx = S.dv ? S.dv.idx : -1;
  onInput("r"); eq("detail → view", S.mode + " " + S.fview, "view related");
  onInput("esc"); eq("esc → detail, same event", S.mode + " " + String(S.dv ? S.dv.idx : -2), "detail " + String(idx));
  onInput("esc");
}
// ── no time at all ──
const sn = sess("claude", "nnn", ["{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"untimed\"}}"]);
openTranscript(sn); const t3 = S.tv;
if (t3) { t3.evs.push({ kind: "user", text: "untimed", ts: "", id: "", full: "" }); t3.cur = 0; }
onInput("r"); eq("no time: toast, stays", S.mode + " | " + S.toast, "transcript | this event has no time");
onInput("esc");
// ── from the call graph ──
S.mode = "list";
openGraph(sa);
const ga = graphAnchor();
eq("graph has a selection", String(ga !== null), "true");
onInput("r");
eq("graph → view", S.mode + " " + S.fview, "view related");
const st5 = relState();
eq("anchored on the span's event", st5 && ga ? String(st5.b.anchor.evId === (ga.evs[ga.i]?.id ?? "?") || st5.b.anchor.evText === (ga.evs[ga.i]?.text ?? "?")) : "", "true");
onInput("esc"); eq("esc → call graph", S.mode + " " + S.fview, "view call graph");
rmSync(D, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "related view: all checks passed");
process.exit(bad ? 1 : 0);
