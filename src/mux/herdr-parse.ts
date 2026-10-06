// agentglass — herdr CLI output and the decisions on it, pure (checks need no herdr): agent/workspace/tab lists,
// process info, errors, versions, session references, the approval read gate, row state, labels
// SPDX-License-Identifier: Apache-2.0
import { type Obj, parse, obj, arr, str } from "../util/json.ts";

// one agent pane of `herdr agent list`: ws/tab are herdr ids (w7, w7:t6); label = herdr's agent name (claude, codex, amp…)
export interface HAgent { pane: string; term: string; ws: string; tab: string; label: string; status: string; sKind: string; sVal: string }
export interface HList { ok: boolean; agents: HAgent[] } // ok false = not the expected JSON
function result(text: string): Obj | null { const o = parse(text.trim()); return o ? obj(o["result"]) : null; }
export function parseAgents(text: string): HList {
  const r = result(text); const out: HAgent[] = [];
  if (!r || !Array.isArray(r["agents"])) return { ok: false, agents: out };
  for (const v of arr(r["agents"])) {
    const a = obj(v); if (!a) continue;
    const pane = str(a["pane_id"]); const term = str(a["terminal_id"]); if (!pane || !term) continue;
    const ss = obj(a["agent_session"]);
    out.push({ pane, term, ws: str(a["workspace_id"]), tab: str(a["tab_id"]), label: str(a["agent"]), status: str(a["agent_status"]), sKind: ss ? str(ss["kind"]) : "", sVal: ss ? str(ss["value"]) : "" });
  }
  return { ok: true, agents: out };
}
// ("workspaces", "workspace_id") / ("tabs", "tab_id") → id → label
export function parseLabels(text: string, list: string, idKey: string): Map<string, string> {
  const m = new Map<string, string>(); const r = result(text); if (!r) return m;
  for (const v of arr(r[list])) { const o = obj(v); if (o && str(o[idKey])) m.set(str(o[idKey]), str(o["label"])); }
  return m;
}
// a workspace of `workspace list`: its worktree's checkout path and repo root ("" when it has no worktree)
export interface HWs { id: string; label: string; checkout: string; repoRoot: string }
export function parseWorkspaces(text: string): HWs[] {
  const out: HWs[] = []; const r = result(text); if (!r) return out;
  for (const v of arr(r["workspaces"])) {
    const o = obj(v); if (!o || !str(o["workspace_id"])) continue;
    const w = obj(o["worktree"]);
    out.push({ id: str(o["workspace_id"]), label: str(o["label"]), checkout: w ? str(w["checkout_path"]) : "", repoRoot: w ? str(w["repo_root"]) : "" });
  }
  return out;
}
// `pane process-info`: the foreground processes' pids, in order; [] on any mismatch
export function parseProcInfo(text: string): number[] {
  const r = result(text); const pi = r ? obj(r["process_info"]) : null; const out: number[] = []; if (!pi) return out;
  for (const v of arr(pi["foreground_processes"])) { const o = obj(v); const p = o ? o["pid"] : 0; if (typeof p === "number" && p > 0) out.push(p); }
  return out;
}
// `tab create` / `workspace create`: the new root pane, its tab and workspace ids ("" when not in the reply)
export interface HCreated { pane: string; tab: string; ws: string }
export function parseCreated(text: string): HCreated {
  const r = result(text); const rp = r ? obj(r["root_pane"]) : null; const w = r ? obj(r["workspace"]) : null;
  return { pane: rp ? str(rp["pane_id"]) : "", tab: rp ? str(rp["tab_id"]) : "", ws: w ? str(w["workspace_id"]) : rp ? str(rp["workspace_id"]) : "" };
}
// {"error":{"code","message"}} on the line that has it (stderr may carry other lines)
export interface HErr { code: string; message: string }
export function parseError(text: string): HErr {
  for (const l of text.split("\n")) {
    const o = l.indexOf("{") >= 0 ? parse(l.slice(l.indexOf("{")).trim()) : null; const e = o ? obj(o["error"]) : null;
    if (e) return { code: str(e["code"]), message: str(e["message"]) };
  }
  return { code: "", message: "" };
}
// the "version: X" line of `herdr status server`
export function parseVersion(text: string): string {
  for (const l of text.split("\n")) if (l.startsWith("version:")) return l.slice(8).trim();
  return "";
}
// numeric per dot part (a missing part is 0); "" → false
export function versionAtLeast(v: string, min: string): boolean {
  if (!v) return false;
  const a = v.split("-")[0].split("."); const b = min.split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number(a[i] ?? "0") || 0; const y = Number(b[i] ?? "0") || 0;
    if (x !== y) return x > y;
  }
  return true;
}
// herdr agent names that are agentglass harness ids (and kinds `agent start` takes)
export const HARNESS_LABELS: string[] = ["claude", "codex", "gemini", "opencode", "pi", "kiro"];
// a pane's session: kind id → key "<harness>:<id>", kind path → the session file; unknown agents and empty values → none
export interface HRef { key: string; path: string }
export function sessRef(label: string, kind: string, value: string): HRef {
  if (!value || HARNESS_LABELS.indexOf(label) < 0) return { key: "", path: "" };
  if (kind === "id") return { key: label + ":" + value, path: "" };
  if (kind === "path") return { key: "", path: value };
  return { key: "", path: "" };
}
// the pane's agent among its foreground processes: the first whose root agent is of the pane's harness, else the first
// with any harness (herdr's label is not one of agentglass's), else 0. harnessOfRoot: "" = not an agent process
export function choosePid(fg: number[], harnessOfRoot: (pid: number) => string, label: string): number {
  for (const p of fg) if (harnessOfRoot(p) === label) return p;
  for (const p of fg) if (harnessOfRoot(p) !== "") return p;
  return 0;
}
// read herdr's state for the approval signal now? A blocked reading is re-read every look until it clears; else only
// while the log is quiet ≥ 3 s mid-turn (busy) or for a harness that hides its dialogs: every look (1.5 s; 1.4 s
// margin) for the first minute, then every 6 s. An agent writing its log is at no dialog
export function pollDue(quietMs: number, busy: boolean, hidden: boolean, wasBlocked: boolean, sinceLastMs: number): boolean {
  return wasBlocked || (quietMs >= 3000 && (busy || hidden) && sinceLastMs >= (quietMs < 60000 ? 1400 : 6000));
}
// a reading older than the session's last log write is stale: the agent moved on since
export function fresh(at: number, mtime: number): boolean { return at > 0 && at >= mtime; }
// "webapp › 2 · w7:p1A"; under --redact (labels are user text) or without labels just the pane id
export function placeLabel(ws: string, tab: string, id: string, redact: boolean): string {
  if (redact || (!ws && !tab)) return id;
  return (ws && tab ? ws + " › " + tab : ws || tab) + " · " + id;
}
export interface Outcome { kind: string; text: string } // toast kind ok|warn|err
const SEND_ERR: string[][] = [
  ["agent_blocked", "warn", "the agent waits at a dialog — answer it there (R jumps to the pane)"],
  ["agent_not_ready", "warn", "the agent is not in its pane's foreground — nothing sent"],
  ["agent_not_found", "warn", "the herdr pane is gone"],
  ["server_not_running", "err", "herdr server not running"],
];
// `herdr agent prompt`'s exit and stderr → the toast
export function sendOutcome(exit: number, errText: string, place: string): Outcome {
  if (exit === 0) return { kind: "ok", text: "sent to herdr " + place };
  return errOutcome(parseError(errText), "send failed (exit " + String(exit) + ")");
}
export function errOutcome(e: HErr, fallback: string): Outcome {
  for (const r of SEND_ERR) if (r[0] === e.code) return { kind: r[1] ?? "err", text: r[2] ?? "" };
  return { kind: "err", text: e.message ? "herdr: " + Array.from(e.message).slice(0, 100).join("") : fallback };
}
// a process environment block: only HERDR_SOCKET_PATH and HERDR_PANE_ID are decoded and kept, the rest is never read
// into a string
const SOCK_KEY = new TextEncoder().encode("HERDR_SOCKET_PATH=");
const PANE_KEY = new TextEncoder().encode("HERDR_PANE_ID=");
function startsAt(b: Uint8Array, i: number, k: Uint8Array): boolean {
  if (i + k.length > b.length) return false;
  for (let j = 0; j < k.length; j++) if (b[i + j] !== k[j]) return false;
  return true;
}
export function envHerdr(block: Uint8Array): { sock: string; pane: string } {
  let sock = ""; let pane = ""; let i = 0; const dec = new TextDecoder();
  while (i < block.length) {
    let e = i; while (e < block.length && block[e] !== 0) e++;
    if (startsAt(block, i, SOCK_KEY)) sock = dec.decode(block.subarray(i + SOCK_KEY.length, e));
    else if (startsAt(block, i, PANE_KEY)) pane = dec.decode(block.subarray(i + PANE_KEY.length, e));
    i = e + 1;
  }
  return { sock, pane };
}
// the workspace owning a directory: the longest worktree checkout path containing it (whole path segments), else the
// workspace whose repo root is the session's repo top (its main checkout first); -1 none
export function workspaceFor(cwd: string, top: string, ws: HWs[]): number {
  let best = -1; let bl = -1;
  if (cwd) for (let i = 0; i < ws.length; i++) {
    const p = ws[i]?.checkout ?? "";
    if (p && (cwd === p || cwd.startsWith(p.endsWith("/") ? p : p + "/")) && p.length > bl) { best = i; bl = p.length; }
  }
  if (best >= 0 || !top) return best;
  for (let i = 0; i < ws.length; i++) if (ws[i]?.repoRoot === top && ws[i]?.checkout === top) return i;
  for (let i = 0; i < ws.length; i++) if (ws[i]?.repoRoot === top) return i;
  return -1;
}
// the herdr state that changes a session's row: working (spinner), blocked (◆), done (finished, not seen: ✓); only a
// reading ≤ 30 s old and not older than the log's last write; "" = agentglass's own glyph
export function rowState(status: string, at: number, mtime: number, now: number): string {
  if (!fresh(at, mtime) || now - at > 30000) return "";
  return status === "working" || status === "blocked" || status === "done" ? status : "";
}
// a new herdr tab's label: ≤ 24 characters of the title, the id's first 8 under --redact or without a title
export function tabLabel(title: string, id: string, redact: boolean): string {
  const t = title.split("\n").join(" ").trim();
  if (redact || !t) return Array.from(id).slice(0, 8).join("");
  return Array.from(t).slice(0, 24).join("").trim();
}
