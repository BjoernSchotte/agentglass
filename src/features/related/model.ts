// agentglass — related events model: parsed events of many sessions → one timeline of rows, with same-file conflicts,
// cross-worktree overlaps and workspace clobbers marked (pure, no UI; spec related-events 4–5)
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";
import { firstLine } from "../../util/text.ts";
import { intOf } from "../../util/config.ts";
import { catOf, toolName, toolArg, isErr, ms } from "../callgraph/model.ts";
import { patchFiles } from "../usage/calls.ts";
import { nlines } from "../usage/record.ts";
import { filesOf } from "../../ui/detail.ts";
import { display } from "../../hooks.ts";

// a file as the project sees it: top = the session's worktree top ("" = outside the repo, rel then absolute)
export interface FileRef { top: string; rel: string }
// one timeline row. sess = session path ("" = a commit no session observed); top = that session's worktree top;
// mark "" | anchor | conflict | overlap | clobber, withS = the other sessions of the flag, dt = ms to the nearest of
// them, race = a parent wrote while its own subagent ran; evKind/evId/evText locate the source event (enter)
export interface RelEv {
  t: number; ts: string; sess: string; h: string; top: string; kind: string; cat: number; tool: string; text: string; files: FileRef[];
  add: number; del: number; err: boolean; self: boolean; mark: string; withS: string[]; dt: number; race: boolean;
  evKind: string; evId: string; evText: string; sha: string; rt: number; // rt = its result's time (0 none yet)
  clob: boolean; // a shell row whose real command is a workspace-wide git command (clobberCmd), also when text is a fake
}
// per-session read state across batches: dedup keys, and open calls (call id → row index in the append-only out)
export interface RelSt { seen: Set<string>; pend: Map<string, number>; last: number }
export function newSt(): RelSt { return { seen: new Set<string>(), pend: new Map<string, number>(), last: 0 }; }
export const KINDS = ["prompt", "write", "shell", "read", "agent", "web", "mcp", "alert", "commit"];
// k cycles: default → everything → writes only
export const KIND_SETS: string[][] = [["prompt", "write", "shell", "agent", "alert", "commit"], ["prompt", "write", "shell", "read", "agent", "web", "mcp", "alert", "commit"], ["write"]];
const CAT_KIND = ["shell", "write", "read", "web", "agent", "mcp", "read"]; // callgraph CATS order; other → read

// a file as shown: rel, through the display hooks (--redact: a stable fake, the same one for the same real path)
export function fileShown(f: FileRef): string { return display("file", f.rel, null); }
export function fileRef(abs: string, top: string): FileRef {
  return top && abs.startsWith(top + "/") ? { top, rel: abs.slice(top.length + 1) } : { top: "", rel: abs };
}
export function row(t: number, ts: string, sess: string, h: string, top: string, kind: string, tool: string, text: string, self: boolean): RelEv {
  return { t, ts, sess, h, top, kind, cat: -1, tool, text, files: [], add: 0, del: 0, err: false, self, mark: "", withS: [], dt: 0, race: false, evKind: "", evId: "", evText: "", sha: "", rt: 0, clob: false };
}
// +added/−removed lines of an edit call from its arguments (Claude/Gemini old_string/new_string, OpenCode oldString/newString,
// pi oldText/newText and edits[], content of a whole-file write) or a Codex patch
function lineCounts(full: string): number[] {
  const o = parse(full);
  if (!o) { let a = 0; let d = 0; for (const f of patchFiles(full)) { a += f.add; d += f.del; } return [a, d]; }
  const es = arr(o["edits"]);
  if (es.length) { let a = 0; let d = 0; for (const e of es) { const eo = obj(e); if (eo) { a += nlines(str(eo["newText"]) || str(eo["new_string"])); d += nlines(str(eo["oldText"]) || str(eo["old_string"])); } } return [a, d]; }
  const nw = str(o["new_string"]) || str(o["newString"]) || str(o["newText"]); const od = str(o["old_string"]) || str(o["oldString"]) || str(o["oldText"]);
  if (nw || od) return [nlines(nw), nlines(od)];
  const c = str(o["content"]); if (c) return [nlines(c), 0];
  const p = str(o["input"]) || str(o["patch"]); if (p) { let a = 0; let d = 0; for (const f of patchFiles(p)) { a += f.add; d += f.del; } return [a, d]; }
  return [0, 0];
}
// a shell call's command line: Codex passes {"command":["bash","-lc","…"]} (or "cmd") as raw JSON arguments
export function shellCmd(arg: string): string {
  const o = parse(arg.trim()); if (!o) return arg;
  const c = o["command"] ?? o["cmd"];
  if (typeof c === "string") return c;
  const a = arr(c).map((x: unknown) => str(x));
  if (a.length >= 3 && /(^|\/)(ba|z)?sh$/.test(a[0] ?? "") && /^-l?c$/.test(a[1] ?? "")) return a.slice(2).join(" ");
  return a.length ? a.join(" ") : arg;
}
const BANNER = /^\[(?:detached HEAD|[^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/;
// a result that records the user's (or a configured rule's) refusal of the call, per harness as its parser renders it:
// Claude's rejection text; Codex ToolError::Rejected (core/src/tools/events.rs); OpenCode PermissionV1 Rejected/Corrected/
// DeniedError (core/src/v1/permission.ts); Gemini's cancelled call; pi's default block by an extension (agent-loop.ts).
// Kiro and fx record none that can be told apart
export function denied(h: string, text: string): boolean {
  const t = text.trimStart();
  if (h === "claude") return /^The user doesn't want to proceed/.test(t);
  if (h === "codex") return /^(exec command |patch )?rejected by user\b/.test(t);
  if (h === "opencode") return /^\[error\] The user (rejected permission to use this specific tool call|has specified a rule which prevents you from using this specific tool call)/.test(t);
  if (h === "gemini") return /^(\[cancelled\] )?\[Operation Cancelled\] Reason: User denied execution/.test(t); // the parser prefixes the status
  if (h === "pi") return /^\[error\] Tool execution was blocked\s*$/.test(t);
  return false;
}

// parsed events of one session → rows appended to out (spec 4): results fold into their call (also across batches),
// events outside [t0, t1] are dropped, replays dedup by (id, kind) or (ts, text); an untimed event takes the previous time
export function toRel(evs: Ev[], sess: string, h: string, cwd: string, top: string, self: boolean, t0: number, t1: number, st: RelSt, out: RelEv[]): void {
  toRelShown(evs, evs, false, sess, h, cwd, top, self, t0, t1, st, out);
}
// the same over raw events (no hooks) and their shown copies (hookedCopy; same order): kinds, files, commands, errors,
// denials and commit shas come from the real content, so --redact flags exactly what a plain run flags; texts are the
// shown ones. red = the shown copies differ (redaction): a commit's subject is dropped, a clobber shows its git form
export function toRelShown(evs: Ev[], shown: Ev[], red: boolean, sess: string, h: string, cwd: string, top: string, self: boolean, t0: number, t1: number, st: RelSt, out: RelEv[]): void {
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]; const v = i < shown.length ? shown[i] : e;
    const t = ms(e.ts) || st.last;
    if (t > st.last) st.last = t;
    if (e.kind === "result") { result(e, red, t, sess, h, top, self, t0, t1, st, out); continue; }
    if (e.kind !== "user" && e.kind !== "tool") continue;
    if (!t || t < t0 || t > t1) continue;
    const key = sess + "\u0001" + (e.id ? e.id + "\u0001" + e.kind : e.ts + "\u0001" + e.text);
    if (st.seen.has(key)) continue;
    st.seen.add(key);
    if (e.kind === "user") {
      const r = row(t, e.ts, sess, h, top, "prompt", "", firstLine(v.text, 300), self);
      r.evKind = e.kind; r.evText = v.text; out.push(r); continue;
    }
    const name = toolName(e); const cat = catOf(name);
    const kind = CAT_KIND[cat] ?? "read";
    const cmd = kind === "shell" ? shellCmd(toolArg(e)) : ""; const form = cmd ? clobberForm(cmd) : "";
    const sa = toolArg(v);
    const r = row(t, e.ts, sess, h, top, kind, name, firstLine(kind !== "shell" ? sa : red && form ? form : shellCmd(sa), 300), self);
    r.cat = cat; r.evKind = e.kind; r.evId = e.id; r.evText = v.text; r.clob = form !== "";
    for (const abs of filesOf([e.text, e.full], cwd)) { const f = fileRef(abs, top); if (!r.files.some((x: FileRef) => x.top === f.top && x.rel === f.rel)) r.files.push(f); }
    if (r.kind === "write") { const lc = lineCounts(e.full); r.add = lc[0] ?? 0; r.del = lc[1] ?? 0; }
    if (e.id) st.pend.set(sess + "\u0001" + e.id, out.length);
    out.push(r);
  }
}
// a result: err onto its call's row; a recorded denial → alert row; a commit banner after a shell call → commit row
function result(e: Ev, red: boolean, t: number, sess: string, h: string, top: string, self: boolean, t0: number, t1: number, st: RelSt, out: RelEv[]): void {
  const i = e.id ? st.pend.get(sess + "\u0001" + e.id) ?? -1 : -1;
  if (i < 0 || i >= out.length) return; // its call lies outside the window
  const c = out[i];
  if (isErr(e.text)) c.err = true;
  if (t && !c.rt) c.rt = t;
  if (!t || t < t0 || t > t1) return;
  const key = sess + "\u0001" + e.id + "\u0001result";
  if (st.seen.has(key)) return;
  st.seen.add(key);
  if (denied(h, e.text)) {
    const r = row(t, e.ts, sess, h, top, "alert", "", "denied " + c.tool, self);
    r.evKind = "tool"; r.evId = c.evId; r.evText = c.evText; out.push(r); return;
  }
  if (c.kind !== "shell") return; // c.text may be a fake (--redact): the banner shape alone decides
  for (const l of e.text.split("\n").slice(0, 20)) {
    const m = BANNER.exec(l.trim()); if (!m) continue;
    const sha = (m[1] ?? "").slice(0, 7);
    const r = row(t, e.ts, sess, h, top, "commit", "", sha + (red ? "" : " " + firstLine(m[2] ?? "", 80)), self); // the subject is real content
    r.sha = sha; r.evKind = "tool"; r.evId = c.evId; r.evText = c.evText; out.push(r);
  }
}

// ── conflicts (spec 5) ──
// a subagent's active interval: its spawning call's start → result, else its own first → last event
export interface Spawn { parent: string; child: string; t0: number; t1: number }
// a workspace-wide git command that can discard others' uncommitted work (each && ; || part of the line)
export function clobberCmd(cmd: string): boolean { return clobberForm(cmd) !== ""; }
// its generic form ("git stash", "git reset --hard", "git checkout <branch>" …; "" = none): names nothing, shown under --redact
export function clobberForm(cmd: string): string {
  for (const part of cmd.split(/&&|\|\||;|\n/)) {
    const w = part.trim().split(/\s+/).filter((x: string) => x.length > 0);
    let i = 0; while (i < w.length && /^[A-Z_][A-Z0-9_]*=/.test(w[i] ?? "")) i++; // VAR=x git …
    if (w[i] !== "git") continue;
    i++; while (i < w.length && (w[i] === "-C" || w[i] === "-c")) i += 2; // git -C dir …
    const sub = w[i] ?? ""; const rest = w.slice(i + 1);
    if (sub === "stash") { const a = rest[0] ?? ""; if (a !== "list" && a !== "show") return "git stash"; continue; }
    if (sub === "reset" && rest.indexOf("--hard") >= 0) return "git reset --hard";
    if (sub === "clean" && rest.some((a: string) => /^-[a-zA-Z]*f/.test(a) || a === "--force")) return "git clean -f";
    if (sub === "restore" && rest.indexOf(".") >= 0) return "git restore .";
    if (sub === "checkout" || sub === "switch") {
      if (rest.indexOf(".") >= 0) return "git " + sub + " .";
      if (rest.some((a: string) => a === "-b" || a === "-B" || a === "-c" || a === "-C" || a === "--orphan")) continue;
      const pos = rest.filter((a: string) => !a.startsWith("-"));
      if (pos.length === 1 && rest.indexOf("--") < 0 && (sub === "switch" || !/[\/.]/.test(pos[0] ?? ""))) return "git " + sub + " <branch>";
    }
  }
  return "";
}
function spawnOf(sp: Spawn[], parent: string, child: string): Spawn | null { for (const s of sp) if (s.parent === parent && s.child === child) return s; return null; }
// two writes of different sessions: flagged unless delegation (parent ↔ own child) outside the child's interval
function exempt(a: RelEv, b: RelEv, sp: Spawn[]): number { // 0 flag, 1 exempt, 2 race (a or b is the parent writing inside)
  const s1 = spawnOf(sp, a.sess, b.sess); if (s1) return a.t >= s1.t0 && a.t <= s1.t1 ? 2 : 1;
  const s2 = spawnOf(sp, b.sess, a.sess); if (s2) return b.t >= s2.t0 && b.t <= s2.t1 ? 2 : 1;
  return 0;
}
function flag(r: RelEv, mark: string, other: RelEv): void {
  if (r.mark === "conflict" && mark !== "conflict") return; // a conflict wins over an overlap on the same row
  if (r.mark !== mark) { r.mark = mark; r.withS = []; r.dt = 0; }
  if (r.withS.indexOf(other.sess) < 0) r.withS.push(other.sess);
  const d = Math.abs(r.t - other.t); if (r.dt === 0 || d < r.dt) r.dt = d;
}
// marks every row of the loaded range (rows sorted by t or not); returns the number of flagged rows. Buckets by
// (top, rel) and by rel, sorted by time: each write is compared with the writes within cMs, not with every row
export function markConflicts(rows: RelEv[], cMs: number, spawns: Spawn[]): number {
  for (const r of rows) if (r.mark !== "anchor") { r.mark = ""; r.withS = []; r.dt = 0; r.race = false; }
  const phys = new Map<string, number[]>(); const byRel = new Map<string, number[]>(); const writes: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; if (r.kind !== "write") continue;
    writes.push(i);
    for (const f of r.files) {
      const pk = f.top + "\u0000" + f.rel; const l = phys.get(pk); if (l) l.push(i); else phys.set(pk, [i]);
      if (f.top) { const m = byRel.get(f.rel); if (m) m.push(i); else byRel.set(f.rel, [i]); }
    }
  }
  const pairs = (idx: number[], fn: (a: RelEv, b: RelEv) => void): void => {
    const s = idx.slice().sort((x: number, y: number) => rows[x].t - rows[y].t);
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
      const a = rows[s[i] ?? 0]; const b = rows[s[j] ?? 0];
      if (b.t - a.t > cMs) break;
      if (a.sess !== b.sess) fn(a, b);
    }
  };
  for (const idx of phys.values()) pairs(idx, (a: RelEv, b: RelEv) => {
    const x = exempt(a, b, spawns); if (x === 1) return;
    flag(a, "conflict", b); flag(b, "conflict", a);
    if (x === 2) { const sp = spawnOf(spawns, a.sess, b.sess); if (sp) a.race = true; else b.race = true; }
  });
  for (const idx of byRel.values()) pairs(idx, (a: RelEv, b: RelEv) => {
    let same = false; for (const f of a.files) for (const g of b.files) if (f.rel === g.rel && f.top === g.top) same = true;
    if (same || exempt(a, b, spawns) === 1) return;
    flag(a, "overlap", b); flag(b, "overlap", a);
  });
  // clobber: a workspace-wide git command after another session's write in the same top (writes sorted by time)
  const ws = writes.slice().sort((x: number, y: number) => rows[x].t - rows[y].t);
  for (const r of rows) {
    if (r.kind !== "shell" || !r.top || !r.clob) continue;
    for (let j = 0; j < ws.length; j++) {
      const w = rows[ws[j] ?? 0]; if (w.t > r.t) break;
      if (r.t - w.t > cMs || w.sess === r.sess || w.top !== r.top) continue;
      flag(r, "clobber", w);
    }
  }
  let n = 0; for (const r of rows) if (r.mark === "conflict" || r.mark === "overlap" || r.mark === "clobber") n++;
  return n;
}

// related.minutes / related.conflictMinutes: integers 1–240, else 10 (warn names each invalid key)
export function relCfg(sec: Obj): { minutes: number; conflictMinutes: number; warn: string } {
  const bad: string[] = [];
  const get = (k: string): number => { const raw = sec[k]; const v = intOf(raw, 1, 240, 10); if (raw !== undefined && (typeof raw !== "number" || v !== raw)) bad.push("related." + k); return v; };
  const minutes = get("minutes"); const conflictMinutes = get("conflictMinutes");
  return { minutes, conflictMinutes, warn: bad.length ? "config " + bad.join(", ") + " must be an integer 1–240 — using 10" : "" };
}
