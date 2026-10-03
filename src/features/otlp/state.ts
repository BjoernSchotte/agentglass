// agentglass — export state per endpoint (spec 4.3/4.4): which turns a backend already has, and the lock that keeps a
// second exporter to the same endpoint out. ~/.agentglass/otlp/state-<H(endpoint)[0:16]>.json, mode 0600, atomic writes.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, openSync, writeSync, closeSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { readText } from "../../util/fs.ts";
import { otlpDir } from "../../util/http.ts";
import { H } from "./ids.ts";
import { safeUrl } from "./config.ts";

export interface SessMark { h: string; id: string; ep: string; turns: Set<string> }
// gzip = the endpoint takes gzip bodies; nativeSince = per harness, when agentglass first saw its own OTLP export on; last = last export (ms)
export interface ExpState { v: number; endpoint: string; gzip: boolean; gzipNote: string; nativeSince: Map<string, number>; last: number; sessions: Map<string, SessMark>; warn: string }

// the key ignores userinfo and query: the same backend with another token is the same backend
export function statePath(url: string): string { return join(otlpDir(), "state-" + H(safeUrl(url)).slice(0, 16) + ".json"); }
function lockPath(url: string): string { return statePath(url).replace(/\.json$/, ".lock"); }
function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
export function newState(url: string): ExpState { return { v: 1, endpoint: safeUrl(url), gzip: true, gzipNote: "", nativeSince: new Map<string, number>(), last: 0, sessions: new Map<string, SessMark>(), warn: "" }; }
export function loadState(url: string): ExpState {
  const st = newState(url);
  const raw = readText(statePath(url), 0, 268435456).trim();
  if (!raw) return st;
  let o: Obj | null = null;
  try { o = obj(JSON.parse(raw)); } catch (e) { o = null; }
  if (!o) { st.warn = "export state " + statePath(url) + " is unreadable — starting over (turns may be sent again)"; return st; }
  st.gzip = o["gzip"] !== false; st.gzipNote = str(o["gzipNote"]); st.last = num(o["last"]);
  const ns = obj(o["nativeSince"]); if (ns) for (const k of Object.keys(ns)) st.nativeSince.set(k, num(ns[k]));
  const ss = obj(o["sessions"]);
  if (ss) for (const p of Object.keys(ss)) {
    const x = obj(ss[p]); if (!x) continue;
    const turns = new Set<string>(); const tu = obj(x["turns"]);
    if (tu) for (const k of Object.keys(tu)) turns.add(k); else for (const k of arr(x["turns"])) turns.add(str(k));
    st.sessions.set(p, { h: str(x["h"]), id: str(x["id"]), ep: str(x["ep"]), turns });
  }
  return st;
}
export function saveState(url: string, st: ExpState): void {
  const ss: Obj = {};
  for (const [p, m] of st.sessions) { const tu: Obj = {}; for (const k of m.turns) tu[k] = 1; ss[p] = { h: m.h, id: m.id, ep: m.ep, turns: tu }; }
  const ns: Obj = {}; for (const [k, v] of st.nativeSince) ns[k] = v;
  const body = JSON.stringify({ v: 1, endpoint: safeUrl(st.endpoint), gzip: st.gzip, gzipNote: st.gzipNote, nativeSince: ns, last: st.last, sessions: ss });
  const p = statePath(url); const tmp = p + ".tmp-" + String(process.pid);
  mkdirSync(otlpDir(), { recursive: true, mode: 0o700 });
  const fd = openSync(tmp, "w"); chmodSync(tmp, 0o600);
  try { writeSync(fd, body + "\n"); } finally { closeSync(fd); }
  renameSync(tmp, p);
}
export function marked(st: ExpState, path: string, key: string): boolean { const m = st.sessions.get(path); return !!m && m.turns.has(key); }
// a turn is marked once the backend accepted it; the cursor epoch is kept for reference only (ids never depend on offsets)
export function markTurn(st: ExpState, path: string, h: string, id: string, ep: string, key: string): void {
  let m = st.sessions.get(path);
  if (!m) { m = { h, id, ep, turns: new Set<string>() }; st.sessions.set(path, m); }
  m.ep = ep; m.turns.add(key);
}
function alive(pid: number): boolean { if (pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return false; } }
// 0 = this process holds the lock now; else the pid of the live exporter holding it (a dead holder's lock is taken over)
export function lock(url: string): number {
  const p = lockPath(url);
  mkdirSync(otlpDir(), { recursive: true, mode: 0o700 });
  for (let k = 0; k < 2; k++) {
    try { const fd = openSync(p, "wx"); try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); } return 0; }
    catch (e) {
      const pid = Number(readText(p, 0, 64).trim()) || 0;
      if (pid === process.pid) return 0;
      if (alive(pid)) return pid;
      try { unlinkSync(p); } catch (e2) { /* raced */ }
    }
  }
  return -1;
}
export function unlock(url: string): void { const p = lockPath(url); if ((Number(readText(p, 0, 64).trim()) || 0) === process.pid) { try { unlinkSync(p); } catch (e) { /* gone */ } } }
