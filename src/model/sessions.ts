// agentglass — session discovery, lazy log loading, and the filtered subagent tree shown in the list
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { join } from "node:path";
import { str, parse } from "../util/json.ts";
import { CLAUDE, CODEX, FX, readText, readLines, listDir } from "../util/fs.ts";
import { firstLine } from "../util/text.ts";
import { type Ev, type Sess, type Harness, newSess } from "./types.ts";
import { parseEvents } from "../harness/index.ts";
import { claudeSub } from "../harness/claude.ts";
import { codexSub } from "../harness/codex.ts";
import { fxMeta } from "../harness/fx.ts";
import { S } from "../state.ts";

export const sessions = new Map<string, Sess>();
const codexTitles = new Map<string, string>();
let codexIndexM = 0;

function addFile(h: Harness, path: string, id: string, archived: boolean, seen: Set<string>, parent: string): void {
  let mt = 0; let sz = 0;
  try { const st = statSync(path); mt = st.mtimeMs; sz = st.size; } catch (e) { return; }
  let s = sessions.get(path);
  if (!s) {
    s = newSess(h, id, path, archived);
    sessions.set(path, s);
    if (parent) claudeSub(s, parent);
    else if (h === "codex") codexSub(s);
    else if (h === "fx") fxMeta(s);
  }
  s.mtime = mt; s.size = sz;
  seen.add(path);
}
export function scan(): void {
  const seen = new Set<string>();
  const pdir = join(CLAUDE, "projects");
  for (const proj of listDir(pdir)) {
    for (const f of listDir(join(pdir, proj))) {
      if (f.endsWith(".jsonl")) { addFile("claude", join(pdir, proj, f), f.slice(0, -6), false, seen, ""); continue; }
      if (f.length !== 36) continue; // <session-uuid>/ dirs hold subagent transcripts
      const sd = join(pdir, proj, f, "subagents");
      for (const a of listDir(sd)) if (a.endsWith(".jsonl")) addFile("claude", join(sd, a), a.slice(6, -6), false, seen, f);
    }
  }
  const walk = (dir: string, archived: boolean, depth: number): void => {
    for (const f of listDir(dir)) {
      const p = join(dir, f);
      if (f.endsWith(".jsonl")) addFile("codex", p, f.length > 42 ? f.slice(-42, -6) : f, archived, seen, "");
      else if (depth < 3 && /^\d+$/.test(f)) walk(p, archived, depth + 1);
    }
  };
  walk(join(CODEX, "sessions"), false, 0);
  const fxd = join(FX, "sessions");
  for (const id of listDir(fxd)) addFile("fx", join(fxd, id, "events.jsonl"), id, false, seen, "");
  walk(join(CODEX, "archived_sessions"), true, 3);
  for (const k of [...sessions.keys()]) if (!seen.has(k)) sessions.delete(k);
  // codex thread names
  const idx = join(CODEX, "session_index.jsonl");
  try {
    const st = statSync(idx);
    if (st.mtimeMs !== codexIndexM) {
      codexIndexM = st.mtimeMs;
      for (const l of readText(idx, 0, st.size).split("\n")) { const o = parse(l); if (o) codexTitles.set(str(o["id"]), str(o["thread_name"])); }
    }
  } catch (e) { /* no codex */ }
}
export function loadHead(s: Sess): void {
  s.headDone = true;
  const evs: Ev[] = [];
  for (const l of readText(s.path, 0, s.h === "claude" ? 131072 : 524288).split("\n")) {
    parseEvents(s.h, l, evs, s);
    if (!s.prompt) for (const e of evs) if (e.kind === "user") { s.prompt = firstLine(e.text, 200); break; }
  }
}
export function loadTail(s: Sess): void {
  if (s.tailSize === s.size) return;
  s.tailSize = s.size;
  if (s.h === "fx") fxMeta(s);
  const start = Math.max(0, s.size - 98304);
  const r = readLines(s.path, start, s.size, start > 0);
  const evs: Ev[] = [];
  for (const l of r.lines) parseEvents(s.h, l, evs, s);
  s.evs = evs.slice(-60);
  if (!s.prompt) for (const e of evs) if (e.kind === "user") { s.prompt = firstLine(e.text, 200); break; } // head was read before the first prompt
}
export function titleOf(s: Sess): string {
  if (s.h === "codex") { const t = codexTitles.get(s.id); if (t) return t; }
  return s.title || s.prompt || "(no prompt yet)";
}
export function working(s: Sess): boolean {
  for (let i = s.evs.length - 1; i >= 0; i--) {
    const e = s.evs[i];
    if (e.kind === "meta" && e.text === "turn started") return true;
    if (e.kind === "meta" && (e.text.startsWith("turn complete") || e.text === "turn aborted")) return false;
    if (s.h === "fx" && e.kind === "user") return true; // fx logs no turn-start marker
  }
  return false;
}
export function activity(s: Sess): string {
  const e = s.evs.length ? s.evs[s.evs.length - 1] : null;
  if (!e) return "";
  if (e.kind === "tool") { const i = e.text.indexOf("\u0000"); return "⚒ " + e.text.slice(0, i) + " " + firstLine(e.text.slice(i + 1), 80); }
  if (e.kind === "result") return "⎿ tool result";
  if (e.kind === "thinking") return "∴ thinking";
  if (e.kind === "user") return "❯ " + firstLine(e.text, 80);
  if (e.kind === "assistant") return "⏺ " + firstLine(e.text, 80);
  return e.text;
}

// ── subagent tree ───────────────────────────────────────────────────────────
export const expanded = new Set<string>(); export const collapsed = new Set<string>();
const AUTO_KIDS = 8; // auto-expanded parents show this many children; an explicit expand shows all
export function subActive(s: Sess): boolean { return Date.now() - s.mtime < 45000; }
export function activeSubs(s: Sess): number { let n = 0; for (const c of s.subs) if (subActive(c)) n++; return n; }
export function isOpen(s: Sess): boolean {
  if (collapsed.has(s.path)) return false;
  return expanded.has(s.path) || activeSubs(s) > 0; // auto-expand while subagents work
}
function matches(s: Sess, q: string): boolean {
  if (S.useFull && !S.fulltext.has(s.path)) return false;
  if (!q) return true;
  return (titleOf(s) + " " + s.cwd + " " + s.id + " " + s.h + " " + s.name + " " + s.branch + " " + s.kind).toLowerCase().indexOf(q) >= 0;
}
export function parentOf(s: Sess): Sess | null {
  if (!s.parent) return null;
  for (const p of sessions.values()) if (!p.parent && p.h === s.h && p.id === s.parent) return p;
  return null;
}
export function buildView(): void {
  const q = S.filter.toLowerCase();
  const filtering = q !== "" || S.useFull;
  const roots = new Map<string, Sess>();
  for (const s of sessions.values()) { s.subs = []; s.last = s.mtime; s.depth = 0; if (!s.parent) roots.set(s.h + ":" + s.id, s); }
  for (const s of sessions.values()) {
    if (!s.parent) continue;
    const p = roots.get(s.h + ":" + s.parent);
    if (!p) continue; // orphan subagent: listed as its own root
    p.subs.push(s); s.depth = 1;
    if (s.mtime > p.last) p.last = s.mtime;
  }
  const tops: Sess[] = [];
  for (const s of sessions.values()) {
    if (s.depth !== 0) continue;
    if (S.hfilter && s.h !== S.hfilter) continue;
    if (S.liveOnly && !s.pid && activeSubs(s) === 0) continue;
    if (!matches(s, q) && !(filtering && s.subs.some((c) => matches(c, q)))) continue;
    tops.push(s);
  }
  tops.sort((a, b) => (b.pid ? 1 : 0) - (a.pid ? 1 : 0) || b.last - a.last);
  const out: Sess[] = [];
  for (const t of tops) {
    out.push(t);
    if (!t.subs.length || collapsed.has(t.path) || !(filtering || isOpen(t))) continue;
    const kids = filtering ? t.subs.filter((c) => matches(c, q)) : t.subs.slice();
    kids.sort((a, b) => (subActive(b) ? 1 : 0) - (subActive(a) ? 1 : 0) || b.mtime - a.mtime);
    const n = filtering || expanded.has(t.path) ? kids.length : Math.max(AUTO_KIDS, activeSubs(t));
    for (const c of kids.slice(0, n)) out.push(c);
  }
  const cur = sessAt(S.sel);
  S.view = out;
  if (cur) { const i = S.view.indexOf(cur); if (i >= 0) S.sel = i; }
  S.sel = Math.max(0, Math.min(S.sel, S.view.length - 1));
}
// bounds-checked reads: in scriptc an out-of-range object read traps instead of yielding undefined
export function sessAt(i: number): Sess | null { return i >= 0 && i < S.view.length ? S.view[i] : null; }
export function current(): Sess | null { return sessAt(S.sel); }
