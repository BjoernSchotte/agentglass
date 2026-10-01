// agentglass — OpenCode 2.x over the service daemon's HTTP API (when the sqlite3 CLI is missing or fails)
// SPDX-License-Identifier: Apache-2.0
// Read-only GETs through curl (src/util/http.ts). The daemon is never started from here: it is used only when its
// service.json names a live pid that /api/info confirms. The password stays in memory and on curl's stdin.
import { statSync } from "node:fs";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { readText } from "../util/fs.ts";
import { getJson } from "../util/http.ts";
import { num } from "../features/usage/record.ts";

export interface Endpoint { url: string; pass: string; pid: number }
const USER = "opencode";
const PAGE = 200; const LIST_PAGE = 1000;

function fileKey(p: string): string { try { const st = statSync(p); return st.size + ":" + st.mtimeMs; } catch (e) { return "-"; } }
// service.json {id, version, url, pid, password} → the daemon, if /api/info answers with the same pid (a stale file whose pid
// was recycled, an older 2.x without /api, a foreign server → null). Cached per service.json size+mtime; a miss is retried
// after 30 s (a daemon busy past curl's 3 s limit is not gone)
let epKey = ""; let epVal: Endpoint | null = null; let epAt = 0;
export function endpoint(statePath: string): Endpoint | null {
  const k = fileKey(statePath);
  if (k === epKey && (epVal !== null || Date.now() - epAt < 30000)) return epVal;
  epKey = k; epVal = null; epAt = Date.now();
  const o = parseJson(readText(statePath, 0, 8192).trim()); if (!o) return null;
  const url = str(o["url"]).replace(/\/+$/, ""); const pass = str(o["password"]); const pid = num(o["pid"]);
  if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("http://localhost:") && !url.startsWith("http://[::1]:")) return null; // credentials never leave the machine
  if (!pid) return null;
  const info = getJson(url + "/api/info", USER, pass);
  if (!info || num(info["pid"]) !== pid) return null;
  epVal = { url, pass, pid };
  return epVal;
}
function get(ep: Endpoint, path: string): Obj | null { return getJson(ep.url + path, USER, ep.pass); }
function data(o: Obj | null): Obj[] | null {
  if (!o || !Array.isArray(o["data"])) return null;
  const out: Obj[] = []; for (const x of arr(o["data"])) { const v = obj(x); if (v) out.push(v); }
  return out;
}
// newest first by time.updated; the next cursor is set even on the last page: a short page ends the list
export function listSessions(ep: Endpoint): Obj[] | null {
  const out: Obj[] = [];
  let cur = "";
  for (let i = 0; i < 100; i++) {
    const r = get(ep, "/api/session?limit=" + String(LIST_PAGE) + (cur ? "&cursor=" + encodeURIComponent(cur) : ""));
    const d = data(r); if (!r || !d) return null;
    for (const x of d) out.push(x);
    const c = obj(r["cursor"]); cur = c ? str(c["next"]) : "";
    if (d.length < LIST_PAGE || !cur) break;
  }
  return out;
}
// the sessions the daemon runs right now ({"data":{"ses_…":{"type":"running"}}})
export function activeSet(ep: Endpoint): string[] | null {
  const r = get(ep, "/api/session/active"); if (!r) return null;
  const d = obj(r["data"]); if (!d) return null;
  return Object.keys(d);
}
// base64url without padding (the daemon's cursor encoding)
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function b64url(s: string): string {
  const b = new TextEncoder().encode(s); let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const x = ((b[i] ?? 0) << 16) | ((i + 1 < b.length ? b[i + 1] ?? 0 : 0) << 8) | (i + 2 < b.length ? b[i + 2] ?? 0 : 0);
    out += B64.charAt((x >> 18) & 63) + B64.charAt((x >> 12) & 63);
    if (i + 1 < b.length) out += B64.charAt((x >> 6) & 63);
    if (i + 2 < b.length) out += B64.charAt(x & 63);
  }
  return out;
}
export function lastId(ms: Obj[]): string { let id = ""; for (const m of ms.slice(-1)) id = str(m["id"]); return id; }
// a session's messages in ascending order after message id `after` ("" = from the start), every page.
// With a cursor the order comes from the cursor: passing order too is a 400
export function messages(ep: Endpoint, id: string, after: string): Obj[] | null {
  const out: Obj[] = [];
  let cur = after ? b64url(JSON.stringify({ id: after, order: "asc", direction: "next" })) : "";
  for (let i = 0; i < 10000; i++) {
    const r = get(ep, "/api/session/" + encodeURIComponent(id) + "/message?limit=" + String(PAGE) + (cur ? "&cursor=" + cur : "&order=asc"));
    const d = data(r); if (!r || !d) return null;
    for (const x of d) out.push(x);
    if (d.length < PAGE || d.length === 0) break;
    cur = b64url(JSON.stringify({ id: lastId(d), order: "asc", direction: "next" }));
  }
  return out;
}
