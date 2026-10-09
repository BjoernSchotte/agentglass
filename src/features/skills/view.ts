// agentglass — "view skill": one load of a skill with its record (trigger, turn, time, size, tier, hash, base dir, load /
// carry / tail per bucket, model) and the text it put into the context, read from the transcript on demand and shown as
// markdown (skill-usage §6.1, Privacy). Opened by v on a transcript skill line or a Stats skills panel row
// SPDX-License-Identifier: Apache-2.0
import { clean, fit, fitStyled, fillTo, width, wrap, home } from "../../util/text.ts";
import type { Sess } from "../../model/types.ts";
import { S, say, type Mode } from "../../state.ts";
import { H } from "../../hooks.ts";
import { C, HL, CSI, RST, fg } from "../../ui/theme.ts";
import { put, box, scrollbar } from "../../ui/screen.ts";
import { type Seg, hlLine, segPush, wrapSegs } from "../../ui/highlight.ts";
import { copyText } from "../../actions.ts";
import { kfmt, money } from "../usage/costs.ts";
import { type Bill, asBill } from "../usage/billing.ts";
import type { LoadRow } from "./model.ts";
import { skillVis } from "./vis.ts";
import { shownText } from "./text.ts";

export const SV_NAME = "skill";
const TRIG = new Map<string, string>([["user", "/ by you"], ["model", "⚙ by the model"], ["compact", "↻ re-injected after a compaction"], ["listing", "· the skill listing"]]);
const WHY = new Map<string, string>([["compact", "compacted"], ["drop", "dropped (the context shrank)"], ["relist", "a new listing replaced it"], ["clear", "cleared"]]);
// the open pane: the load, its session (for the text), the lines at width lw, and where esc returns
const SV = { s: null as Sess | null, l: null as LoadRow | null, lines: [] as string[], plain: "", lw: -1, scroll: 0, backMode: "list" as Mode, backView: "", why: "" };

function hm(t: number): string { if (t <= 0) return "--:--"; const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function tok(n: number, tier: string): string { return n < 0 ? "?" : (tier === "≈" ? "≈" : "") + kfmt(n) + " tok"; }
// one load's record as label/value lines (plain, the pane colours them); the name as skillVis shows it
export function recordLines(l: LoadRow, bill: Bill | ""): string[] {
  const v = skillVis(l.name);
  const state = l.end === 0 ? "in context" : "out at " + hm(l.end) + " (" + (WHY.get(l.why) ?? l.why) + ")";
  const o = [
    "✧ " + v.shown + (l.stub ? " (re-invocation stub)" : "") + (l.rel ? " (loaded again after a compaction)" : ""),
    "trigger  " + (TRIG.get(l.trig) ?? l.trig) + " · turn " + String(l.turn + 1) + " · " + hm(l.t),
    "size     " + (l.size < 0 ? "? (no text in the log: counted, not priced)" : tok(l.size, l.tier)) + (l.bytes >= 0 ? " · " + String(l.bytes) + " bytes" : "") + " · tier " + l.tier + (l.hash ? " · hash " + l.hash : ""),
    "context  " + state + " · carried " + String(l.requests) + " requests" + (l.model ? " · " + l.model : ""),
    "tokens   load " + kfmt(l.load) + " · carry " + kfmt(l.carry) + " (tail " + kfmt(l.tail) + ")" + " · " + (l.unpriced ? "$ ?" : money(l.usd, bill) + " (tail " + money(l.tailUsd, bill) + ")"),
  ];
  if (v.mode === "show" && l.dir) o.push("base dir " + home(l.dir) + " · scope " + l.scope); else o.push("scope    " + l.scope);
  return o;
}
// markdown, lightly: headings, list markers, fences (their body by the fence's language), `code`, the yaml frontmatter
function mdRows(text: string): Seg[][] {
  const rows: Seg[][] = []; let fence = ""; let front = false; const st: number[] = [0];
  const ls = text.split("\n");
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i] ?? ""; const out: Seg[] = [];
    if (i === 0 && l === "---") { front = true; segPush(out, HL.punct, l); rows.push(out); continue; }
    if (front) { if (l === "---") front = false; rows.push(l === "---" ? [{ s: fg(HL.punct), t: l }] : hlLine("yaml", l, st)); continue; }
    const f = /^\s*(```|~~~)(\w*)/.exec(l);
    if (f) { fence = fence ? "" : (f[2] ?? "") || "text"; segPush(out, HL.com, l); rows.push(out); continue; }
    if (fence) { const lang = fence === "bash" || fence === "sh" || fence === "shell" ? "sh" : fence === "json" ? "json" : fence === "py" || fence === "python" ? "py" : fence === "yaml" ? "yaml" : fence === "text" ? "text" : "js"; rows.push(hlLine(lang, l, st)); continue; }
    const h = /^(#{1,6} )(.*)$/.exec(l);
    if (h) { out.push({ s: fg(C.accent) + CSI + "1m", t: (h[1] ?? "") + (h[2] ?? "") }); rows.push(out); continue; }
    const b = /^(\s*(?:[-*+]|\d+\.) )(.*)$/.exec(l);
    let rest = l; if (b) { segPush(out, HL.punct, b[1] ?? ""); rest = b[2] ?? ""; }
    while (rest) { // `code` spans
      const a = rest.indexOf("`"); const z = a >= 0 ? rest.indexOf("`", a + 1) : -1;
      if (a < 0 || z < 0) { segPush(out, HL.text, rest); break; }
      segPush(out, HL.text, rest.slice(0, a)); segPush(out, HL.str, rest.slice(a, z + 1)); rest = rest.slice(z + 1);
    }
    rows.push(out);
  }
  return rows;
}
function build(w: number): void {
  const l = SV.l; const s = SV.s; if (!l) return;
  const L: string[] = [];
  const rec = recordLines(l, s ? asBill(s.bill) : "");
  L.push(fg(C.cyan) + CSI + "1m" + fit(clean(rec[0] ?? ""), w) + RST);
  for (const x of rec.slice(1)) for (const y of wrap(x, w)) L.push(fg(C.sub) + y.slice(0, 9) + RST + fg(C.text) + y.slice(9) + RST);
  L.push("");
  L.push(fg(C.cyan) + CSI + "1m" + "━━ TEXT " + RST + fg(C.line) + "━".repeat(Math.max(0, w - 8)) + RST);
  const t = s ? shownText(s, l.name, l.hash, l.off, l.len, false, false) : { text: "", why: "text not found (the session is gone)" };
  SV.why = t.why; SV.plain = t.text;
  if (!t.text) L.push(fg(C.dim) + "(" + t.why + ")" + RST);
  else for (const segs of mdRows(t.text)) for (const x of wrapSegs(segs, w, "", w, "")) L.push(x);
  SV.lines = L; SV.lw = w;
}
// the pane for load l of session s; esc returns to the mode (and view) it was opened from
export function openSkillView(s: Sess | null, l: LoadRow): void {
  if (skillVis(l.name).mode === "omit") { say("info", "this skill is hidden by skills.hide"); return; }
  SV.s = s; SV.l = l; SV.lw = -1; SV.scroll = 0; SV.backMode = S.mode; SV.backView = S.fview;
  S.fview = SV_NAME; S.mode = "view";
}
// checks: the pane's plain lines at width w
export function skillViewLines(w: number): string[] { build(w); return SV.lines.map((x: string): string => x.replace(/\x1b\[[0-9;]*m/g, "")); }
function render(): void {
  const W = S.W; const iw = W - 4; const vh = S.H - 4;
  if (SV.lw !== iw) build(iw);
  const l = SV.l; if (!l) return;
  const max = Math.max(0, SV.lines.length - vh); SV.scroll = Math.max(0, Math.min(SV.scroll, max));
  box(0, 1, W, S.H - 2, "view skill · " + clean(skillVis(l.name).shown), (SV.plain ? String(SV.plain.split("\n").length) + " lines · " : "") + (SV.s ? clean(SV.s.title || SV.s.id) : ""), true);
  for (let r = 0; r < vh; r++) { const x = SV.scroll + r < SV.lines.length ? SV.lines[SV.scroll + r] ?? "" : ""; const f = fitStyled(x, iw); put(1, 2 + r, " " + f + fillTo(f, iw) + " "); }
  scrollbar(SV.lines.length, vh, SV.scroll, max);
}
function back(): void { S.mode = SV.backMode; S.fview = SV.backView; SV.s = null; SV.l = null; SV.lines = []; SV.plain = ""; }
H.views.push({ name: SV_NAME, render });
H.keys.push((mode: string, k: string): boolean => {
  if (mode !== "view" || S.fview !== SV_NAME) return false;
  const vh = S.H - 4;
  if (k === "esc" || k === "q" || k === "left" || k === "backspace") back();
  else if (k === "up" || k === "k" || k === "wheelup") SV.scroll -= k === "wheelup" ? 3 : 1;
  else if (k === "down" || k === "j" || k === "wheeldown") SV.scroll += k === "wheeldown" ? 3 : 1;
  else if (k === "pgup" || k === "b") SV.scroll -= vh - 1;
  else if (k === "pgdn" || k === " ") SV.scroll += vh - 1;
  else if (k === "g" || k === "home") SV.scroll = 0;
  else if (k === "G" || k === "end") SV.scroll = SV.lines.length;
  else if (k === "y") { if (SV.plain) copyText(SV.plain, String(SV.plain.length) + " chars of skill text"); else say("info", SV.why || "no text to copy"); }
  else if (k === "?") return false;
  return true;
});
H.footerHints.push((mode: string): string[][] => mode === "view" && S.fview === SV_NAME ? [["↑↓", "scroll"], ["g/G", "top/end"], ["y", "copy text"], ["esc", "back"]] : []);
H.helpSections.push({ name: "view skill", ctx: SV_NAME, keys: [["↑↓ jk  pgup pgdn", "scroll"], ["g  G", "top / end"], ["y", "copy the skill text"], ["esc  q", "back"],
  ["", "the text is read from the transcript when the pane opens (agentglass never stores it); --redact and skills.hide (content, name, omit) hide it"]] });
