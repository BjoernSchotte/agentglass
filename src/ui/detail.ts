// agentglass — event detail (drill-down): one tool call + its result fully expanded, foldable blocks, file refs
// SPDX-License-Identifier: Apache-2.0
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr, parse } from "../util/json.ts";
import { HOME, readText } from "../util/fs.ts";
import { width, clean, fit, wrap, fitStyled, fillTo, localHM, home } from "../util/text.ts";
import type { Ev } from "../model/types.ts";
import { S, type TV, type DV } from "../state.ts";
import { titleOf } from "../model/sessions.ts";
import { C, HL, CSI, RST, fg } from "./theme.ts";
import { put, box, scrollbar } from "./screen.ts";
import { type Seg, langOf, looksYaml, segPush, hlLine, highlight, wrapSegs } from "./highlight.ts";

function evIn(list: Ev[], i: number): Ev | null { return i >= 0 && i < list.length ? list[i] ?? null : null; }
function resolveFull(e: Ev): string {
  if (!e.full.startsWith("@file:")) return e.full;
  const p = e.full.slice(6);
  try { const st = statSync(p); return readText(p, 0, Math.min(st.size, 4194304)); } catch (err) { return ""; }
}
// tool call ↔ result, by id when the harness logs one, else the adjacent event
export function pairOf(evs: Ev[], i: number): number {
  const e = evIn(evs, i);
  if (!e) return -1;
  if (e.kind === "tool") {
    for (let j = i + 1; j < evs.length && j < i + 500; j++) {
      const r = evs[j];
      if (r.kind === "result" && (!e.id || r.id === e.id)) return j;
      if (!e.id && r.kind === "tool") return -1;
    }
  } else if (e.kind === "result") {
    for (let j = i - 1; j >= 0 && j > i - 500; j--) {
      const c = evs[j];
      if (c.kind === "tool" && (!e.id || c.id === e.id)) return j;
    }
  }
  return -1;
}
function dHead(L: string[], P: string[], title: string, w: number, col: string): void {
  L.push("");
  const t = clean(title);
  L.push(fg(col) + CSI + "1m" + "━━ " + fit(t, Math.min(width(t), w - 4)) + " " + RST + fg(C.line) + "━".repeat(Math.max(0, w - width(t) - 4)) + RST);
  P.push("", "== " + title);
}
function dText(L: string[], P: string[], text: string, w: number, col: string): void {
  for (const l of wrap(text, w)) L.push(fg(col) + l + RST);
  P.push(text);
}
// fold state for the detail layer: blocks longer than FOLD_AT rows start collapsed
const FOLD_AT = 10;
let blockNo = 0;
const foldRows: number[] = []; const foldIds: number[] = [];
function emitBlock(L: string[], P: string[], rows: Seg[][], rowBg: string[], w: number, numbered: boolean, plain: string, gutterCol: string, foldAt: number = FOLD_AT): void {
  const id = blockNo++;
  const open = S.foldAll || S.foldOpen.indexOf(id) >= 0;
  const foldable = rows.length > foldAt + 3 || (foldAt < FOLD_AT && rows.length > foldAt); // never fold away just a line or two
  const shown = foldable && !open ? foldAt : rows.length;
  const nw = numbered ? String(rows.length).length : 0;
  for (let i = 0; i < shown; i++) {
    const head = numbered ? fg(C.dim) + String(i + 1).padStart(nw, " ") + " " + fg(gutterCol) + "│ " + RST : fg(gutterCol) + "│ " + RST;
    const cont = numbered ? fg(C.dim) + " ".repeat(nw) + " " + fg(C.line) + "┆ " + RST : fg(C.line) + "┆ " + RST;
    const avail = Math.max(10, w - (numbered ? nw + 3 : 2));
    const none: Seg[] = [];
    const segs = i < rows.length ? rows[i] ?? none : none;
    const out = wrapSegs(segs, avail, cont, avail, i < rowBg.length ? rowBg[i] ?? "" : "");
    for (let j = 0; j < out.length; j++) L.push((j === 0 ? head : "") + out[j]);
  }
  if (foldable) {
    foldRows.push(L.length); foldIds.push(id);
    L.push(fg(C.line) + (numbered ? " ".repeat(nw + 1) : "") + "╰ " + fg(C.accent) + CSI + "1m" + (open ? "▾ collapse" : "▸ " + (rows.length - foldAt) + " more lines of " + rows.length) + RST + fg(C.dim) + "  · click or z" + RST);
  }
  P.push(plain);
}
function dCode(L: string[], P: string[], text: string, w: number, numbered: boolean, lang: string, foldAt: number = FOLD_AT): void {
  emitBlock(L, P, highlight(text, lang), [], w, numbered, text, C.line, foldAt);
}
function dDiff(L: string[], P: string[], text: string, w: number, lang: string): void {
  const rows: Seg[][] = []; const bgs: string[] = [];
  const state: number[] = [0];
  for (const raw of text.split("\n").slice(0, 20000)) {
    const c = raw.charAt(0);
    const add = c === "+" && !raw.startsWith("+++"); const del = c === "-" && !raw.startsWith("---");
    if (c === "@" || raw.startsWith("***") || raw.startsWith("+++") || raw.startsWith("---")) { rows.push([{ s: fg(C.cyan), t: clean(raw) }]); bgs.push(""); continue; }
    const body = add || del || c === " " ? raw.slice(raw.charAt(1) === " " ? 2 : 1) : raw;
    const segs: Seg[] = [{ s: fg(add ? C.green : del ? C.red : C.dim) + CSI + "1m", t: add ? "+ " : del ? "- " : "  " }];
    for (const sg of hlLine(lang, clean(body).replace(/\s+$/, ""), state)) segs.push(sg);
    rows.push(segs); bgs.push(add ? C.addBg : del ? C.delBg : "");
  }
  emitBlock(L, P, rows, bgs, w, false, text, C.line);
}
// tool output: single-line JSON (whole or embedded, e.g. codex "Output:\n{...}") is pretty-printed and colored
function dOutput(L: string[], P: string[], text: string, w: number): void {
  const whole = parse(text.trim());
  if (whole) { dCode(L, P, pretty(whole), w, false, "json"); return; }
  const rows: Seg[][] = [];
  const lang = looksYaml(text) ? "yaml" : "text";
  const state: number[] = [0];
  for (const l of text.split("\n").slice(0, 20000)) {
    const t = l.trim();
    const j = (t.startsWith("{") || t.startsWith("[")) && t.length > 2 ? parse(t) : null;
    if (j) { for (const r of highlight(pretty(j), "json")) rows.push(r); continue; }
    rows.push(hlLine(lang, clean(l).replace(/\s+$/, ""), state));
  }
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  emitBlock(L, P, rows, [], w, false, text, C.line);
}
function pretty(o: Obj): string { return JSON.stringify(o, null, 2); }
// structured values as colored key/value rows; multi-line strings become real indented blocks (key: |)
function kvRows(v: unknown, key: string, ind: string, rows: Seg[][]): void {
  const k = (r: Seg[]): void => { segPush(r, HL.text, ind); if (key) { segPush(r, HL.key, key); segPush(r, HL.punct, ":"); } };
  if (typeof v === "string") {
    if (v.indexOf("\n") >= 0) {
      const r: Seg[] = []; k(r); segPush(r, HL.kw, " |"); rows.push(r);
      const ls = v.split("\n"); if (ls.length > 1 && ls[ls.length - 1] === "") ls.pop();
      for (const l of ls) { const b: Seg[] = []; segPush(b, HL.text, ind + "  "); segPush(b, HL.str, clean(l).replace(/\s+$/, "")); rows.push(b); }
    } else { const r: Seg[] = []; k(r); segPush(r, HL.text, key ? " " : ""); segPush(r, HL.str, clean(v)); rows.push(r); }
    return;
  }
  if (typeof v === "number" || typeof v === "boolean" || v === null) { const r: Seg[] = []; k(r); segPush(r, HL.text, key ? " " : ""); segPush(r, HL.num, String(v)); rows.push(r); return; }
  if (Array.isArray(v)) {
    const items = v as unknown[];
    if (!items.length) { const r: Seg[] = []; k(r); segPush(r, HL.punct, " []"); rows.push(r); return; }
    if (key) { const r: Seg[] = []; k(r); rows.push(r); }
    for (const it of items) {
      const o = obj(it);
      if (o && Object.keys(o).length) {
        const mark: Seg[] = []; segPush(mark, HL.text, ind + "  "); segPush(mark, HL.punct, "-"); rows.push(mark);
        for (const kk of Object.keys(o)) kvRows(o[kk], kk, ind + "    ", rows);
      } else { const at = rows.length; kvRows(it, "", ind + "    ", rows); const r = rows[at]; if (r) r.unshift({ s: fg(HL.punct), t: ind + "  - " }); }
    }
    return;
  }
  const o = obj(v);
  if (o) {
    if (key) { const r: Seg[] = []; k(r); if (!Object.keys(o).length) segPush(r, HL.punct, " {}"); rows.push(r); }
    for (const kk of Object.keys(o)) kvRows(o[kk], kk, key ? ind + "  " : ind, rows);
  }
}
function dKV(L: string[], P: string[], o: Obj, w: number, skip: string[]): void {
  const rows: Seg[][] = [];
  for (const kk of Object.keys(o)) if (skip.indexOf(kk) < 0) kvRows(o[kk], kk, "", rows);
  if (rows.length) emitBlock(L, P, rows, [], w, false, pretty(o), C.line);
}
function prefixLines(text: string, pre: string): string { return text.split("\n").map((l) => pre + l).join("\n"); }
function fmtCall(L: string[], P: string[], e: Ev, w: number): void {
  const i0 = e.text.indexOf("\u0000");
  const name = i0 >= 0 ? e.text.slice(0, i0) : e.text;
  const a = parse(e.full.trim());
  if (a) {
    const fp = str(a["file_path"]) || str(a["path"]) || str(a["notebook_path"]);
    const cmd = str(a["command"]) || str(a["cmd"]);
    const req = obj(a["request"]);
    if (typeof a["old_string"] === "string" || typeof a["new_string"] === "string") {
      dHead(L, P, "EDIT  " + home(fp), w, C.yellow);
      dDiff(L, P, prefixLines(str(a["old_string"]), "- ") + "\n" + prefixLines(str(a["new_string"]), "+ "), w, langOf(fp, ""));
    } else if (arr(a["edits"]).length) {
      dHead(L, P, "MULTI-EDIT  " + home(fp), w, C.yellow);
      for (const ed of arr(a["edits"])) { const eo = obj(ed); if (eo) dDiff(L, P, prefixLines(str(eo["old_string"]), "- ") + "\n" + prefixLines(str(eo["new_string"]), "+ "), w, langOf(fp, "")); }
    } else if (typeof a["content"] === "string" && fp) {
      dHead(L, P, "WRITE  " + home(fp), w, C.yellow);
      dCode(L, P, str(a["content"]), w, true, langOf(fp, str(a["content"])));
    } else if (cmd) {
      dHead(L, P, "COMMAND" + (str(a["workdir"]) || str(a["cwd"]) ? "  in " + home(str(a["workdir"]) || str(a["cwd"])) : ""), w, C.yellow);
      dCode(L, P, cmd, w, false, "sh");
    } else if (req && str(req["task"])) {
      dHead(L, P, "SUBAGENT TASK", w, C.yellow);
      dText(L, P, str(req["task"]), w, C.text);
    } else if (str(a["prompt"])) {
      dHead(L, P, "PROMPT" + (str(a["description"]) ? "  " + str(a["description"]) : ""), w, C.yellow);
      dText(L, P, str(a["prompt"]), w, C.text);
    }
    const shownKeys = ["command", "cmd", "content", "old_string", "new_string", "edits", "prompt"];
    if (req && str(req["task"])) shownKeys.push("request");
    const rest = Object.keys(a).filter((x) => shownKeys.indexOf(x) < 0);
    if (rest.length) { dHead(L, P, (rest.length < Object.keys(a).length ? "OTHER ARGUMENTS  " : "ARGUMENTS  ") + name, w, C.sub); dKV(L, P, a, w, shownKeys); }
  } else if (e.full && /exec_command\(\{\s*cmd:\s*"/.test(e.full)) { // codex wraps shell calls in JS
    const cm = /cmd:\s*("(?:[^"\\]|\\.)*")/.exec(e.full);
    const wd = /workdir:\s*("(?:[^"\\]|\\.)*")/.exec(e.full);
    let cmdText = "";
    try { cmdText = str(JSON.parse(cm ? cm[1] ?? "\"\"" : "\"\"")); } catch (err) { cmdText = cm ? cm[1] ?? "" : ""; }
    let wdText = "";
    try { wdText = str(JSON.parse(wd ? wd[1] ?? "\"\"" : "\"\"")); } catch (err) { wdText = ""; }
    dHead(L, P, "COMMAND" + (wdText ? "  in " + home(wdText) : ""), w, C.yellow);
    dCode(L, P, cmdText, w, false, "sh");
    dHead(L, P, "RAW INPUT  " + name, w, C.sub);
    dCode(L, P, e.full, w, false, "js", 1); // already shown above: keep the raw call folded
  } else if (e.full) {
    dHead(L, P, "INPUT  " + name, w, C.yellow);
    if (e.full.indexOf("*** Begin Patch") >= 0) dDiff(L, P, e.full, w, "js"); else dCode(L, P, e.full, w, true, langOf("", e.full) === "text" ? "js" : langOf("", e.full));
  } else {
    dHead(L, P, "CALL  " + name, w, C.yellow);
    dText(L, P, i0 >= 0 ? e.text.slice(i0 + 1) : e.text, w, C.text);
  }
}
function fmtResult(L: string[], P: string[], e: Ev, w: number): void {
  const tur = e.full && !e.full.startsWith("@file:") ? parse(e.full.trim()) : null; // Claude toolUseResult
  if (tur) {
    let shown = false;
    const patch = arr(tur["structuredPatch"]);
    if (patch.length) {
      dHead(L, P, "PATCH  " + home(str(tur["filePath"])), w, C.green);
      for (const hk of patch) {
        const h = obj(hk);
        if (!h) continue;
        const ls: string[] = [];
        for (const x of arr(h["lines"])) ls.push(str(x));
        dDiff(L, P, "@@ -" + String(h["oldStart"]) + " +" + String(h["newStart"]) + " @@\n" + ls.join("\n"), w, langOf(str(tur["filePath"]), ""));
      }
      shown = true;
    }
    const file = obj(tur["file"]);
    if (file && str(file["content"])) {
      dHead(L, P, "FILE  " + home(str(file["filePath"])), w, C.green);
      dCode(L, P, str(file["content"]), w, true, langOf(str(file["filePath"]), str(file["content"])));
      shown = true;
    }
    const so = str(tur["stdout"]); const se = str(tur["stderr"]);
    if (so) { dHead(L, P, "STDOUT", w, C.green); dOutput(L, P, so, w); shown = true; }
    if (se) { dHead(L, P, "STDERR", w, C.red); dOutput(L, P, se, w); shown = true; }
    if (!shown) { dHead(L, P, "RESULT", w, C.green); dOutput(L, P, e.text, w); dHead(L, P, "RESULT DATA", w, C.sub); dKV(L, P, tur, w, []); }
    return;
  }
  const full = resolveFull(e);
  dHead(L, P, "RESULT" + (e.full.startsWith("@file:") ? "  " + home(e.full.slice(6)) : ""), w, C.green);
  const body = full || e.text;
  if (body.indexOf("\n@@ ") >= 0 || body.startsWith("diff --git")) dDiff(L, P, body, w, "js"); else dOutput(L, P, body, w);
}
function filesOf(texts: string[], cwd: string): string[] {
  const out: string[] = [];
  const add = (p0: string): void => {
    const p = p0.replace(/\\\//g, "/").trim();
    if (!p || p.length > 400 || p.indexOf("\n") >= 0) return;
    const abs = p.startsWith("/") ? p : p.startsWith("~/") ? HOME + p.slice(1) : cwd ? join(cwd, p) : p;
    if (out.indexOf(abs) < 0) out.push(abs);
  };
  for (const t of texts) {
    for (const m of t.matchAll(/"(?:file_path|filePath|path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) add(m[1]);
    for (const m of t.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/g)) add(m[1]);
  }
  return out;
}
function buildDetail(t: TV, idx: number, w: number): DV {
  const L: string[] = []; const P: string[] = [];
  blockNo = 0; foldRows.length = 0; foldIds.length = 0;
  const e = evIn(t.evs, idx);
  let title = "event";
  const texts: string[] = [];
  if (e) {
    const j = pairOf(t.evs, idx);
    const pe = evIn(t.evs, j);
    const call = e.kind === "tool" ? e : e.kind === "result" ? pe : null;
    const res = e.kind === "result" ? e : e.kind === "tool" ? pe : null;
    if (call || res) {
      const i0 = call ? call.text.indexOf("\u0000") : -1;
      title = "⚒ " + (call && i0 >= 0 ? call.text.slice(0, i0) : "tool result");
      if (call) { fmtCall(L, P, call, w); texts.push(call.full); }
      else { dHead(L, P, "CALL", w, C.dim); dText(L, P, "(call not in the loaded part of the log)", w, C.dim); }
      if (res) { fmtResult(L, P, res, w); texts.push(res.full.startsWith("@file:") ? "" : res.full); }
      else { dHead(L, P, "RESULT", w, C.dim); dText(L, P, "(no result yet — still running?)", w, C.dim); }
    } else {
      title = e.kind === "user" ? "❯ user" : e.kind === "assistant" ? "⏺ assistant" : e.kind === "thinking" ? "∴ thinking" : "── " + e.kind;
      dHead(L, P, e.kind.toUpperCase(), w, e.kind === "user" ? C.cyan : C.text);
      dText(L, P, e.text, w, e.kind === "thinking" ? C.sub : C.text);
      texts.push(e.text);
    }
    if (e.ts) title += "  ·  " + localHM(e.ts);
    if (e.id) title += "  ·  " + e.id;
  }
  const files = filesOf(texts, t.s.cwd);
  const head: string[] = []; const fileRow: number[] = [];
  if (files.length) {
    head.push(fg(C.purple) + CSI + "1m" + "FILES" + RST + fg(C.dim) + "   1-9 / click open in $PAGER · e edit · tab select" + RST);
    for (let i = 0; i < files.length; i++) {
      fileRow.push(head.length);
      const ok = existsSync(files[i]);
      head.push("  " + fg(C.accent) + CSI + "1m" + "[" + (i + 1) + "]" + RST + " " + fg(ok ? C.text : C.dim) + home(files[i]) + RST + (ok ? "" : fg(C.red) + "  (missing)" + RST));
    }
  }
  const foldRow = foldRows.map((r) => r + head.length);
  return { idx, lines: head.concat(L), plain: P.join("\n"), files, fileRow, foldRow, foldId: foldIds.slice(), fsel: 0, scroll: 0, title, lw: w };
}
export function openDetail(i: number): void {
  const tv = S.tv;
  if (!tv || i < 0 || i >= tv.evs.length) return;
  S.foldOpen = []; S.foldAll = false; // every event starts with long blocks folded
  S.dv = buildDetail(tv, i, S.W - 4);
  S.mode = "detail";
}
export function stepDetail(dir: number): void {
  const tv = S.tv; const dv = S.dv;
  if (!tv || !dv) return;
  let i = dv.idx + dir;
  // a result already shown with its call is skipped
  while (i >= 0 && i < tv.evs.length) {
    const e = tv.evs[i];
    if (e.kind === "result" && pairOf(tv.evs, i) >= 0) { i += dir; continue; }
    if (e.kind === "meta") { i += dir; continue; }
    break;
  }
  if (i < 0 || i >= tv.evs.length) return;
  tv.cur = i; tv.follow = false;
  openDetail(i);
}
export function renderDetail(): void {
  const tv = S.tv; const d = S.dv;
  if (!d || !tv) return;
  const W = S.W;
  let v = d;
  if (d.lw !== W - 4) { v = buildDetail(tv, d.idx, W - 4); v.scroll = d.scroll; v.fsel = d.fsel; S.dv = v; }
  const vh = S.H - 4; const iw = W - 4;
  const maxScroll = Math.max(0, v.lines.length - vh);
  v.scroll = Math.max(0, Math.min(v.scroll, maxScroll));
  box(0, 1, W, S.H - 2, v.title, "event " + (v.idx + 1) + "/" + tv.evs.length + " · " + clean(titleOf(tv.s)), true);
  for (let r = 0; r < vh; r++) {
    const li = v.scroll + r;
    const l = li < v.lines.length ? v.lines[li] : "";
    const fi = v.fileRow.indexOf(li);
    const mark = fi >= 0 && fi === v.fsel ? fg(C.accent) + "▌" + RST : " ";
    const f = fitStyled(l, iw);
    put(1, 2 + r, mark + f + fillTo(f, iw) + " ");
  }
  scrollbar(v.lines.length, vh, v.scroll, maxScroll);
}
