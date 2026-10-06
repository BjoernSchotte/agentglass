// agentglass — receive storage (otlp-hub spec 9.4, 10): per host <dir>/<host>/ (0700) with .host and one JSON line per
// request in traces-YYYYMMDD.jsonl / logs-YYYYMMDD.jsonl (UTC days, 0600); closed days gzip-compressed; retention and
// a disk budget over all hosts (oldest closed files first, today's never)
// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import { openSync, writeSync, closeSync, fstatSync, statSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { listDir, readWhole, readBytes } from "../../util/fs.ts";
import { gzip, writeBin } from "../../util/gzip.ts";
import { gunzipCapped } from "../../util/inflate.ts";
import { dirProblem } from "./tokens.ts";

export const FILE_RE = /^(traces|logs)-(\d{8})\.jsonl(\.gz)?$/;
export function utcDay(ms: number): string { const d = new Date(ms); const m = d.getUTCMonth() + 1; const n = d.getUTCDate(); return String(d.getUTCFullYear()) + (m < 10 ? "0" : "") + String(m) + (n < 10 ? "0" : "") + String(n); }
const hostSeen = new Map<string, string>(); // dir → the .host content written this run

// a fresh 0600 file replacing path (O_EXCL temp, never over a symlink); "" ok
export function writePrivate(path: string, data: string): string {
  const tmp = path + ".tmp-" + String(process.pid); let fd = -1;
  try {
    try { unlinkSync(tmp); } catch (e) { /* none */ }
    fd = openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    writeSync(fd, data); closeSync(fd); fd = -1; renameSync(tmp, path); return "";
  } catch (e) { if (fd >= 0) closeSync(fd); try { unlinkSync(tmp); } catch (e2) { /* not written */ } return e instanceof Error ? e.message : String(e); }
}
// <root>/<name>, 0700, with .host ({name, hostId, since}) kept current; "" ok, else why not
export function hostDir(root: string, name: string, hostId: string, now: number): string {
  const r = dirProblem(root, true); if (r) return r;
  const d = join(root, name);
  const p = dirProblem(d, true); if (p) return p;
  const f = join(d, ".host");
  const prev = hostSeen.get(d);
  if (prev !== undefined && prev.indexOf("\"hostId\":" + JSON.stringify(hostId) + ",") >= 0) return "";
  let since = now;
  const old = readWhole(f, 4096);
  if (!old.err && !old.missing) { try { const o = JSON.parse(old.text) as Record<string, unknown>; const s = o["since"]; if (typeof s === "number") since = s as number; if (o["hostId"] === hostId && o["name"] === name) { hostSeen.set(d, old.text); return ""; } } catch (e) { /* rewritten below */ } }
  const text = JSON.stringify({ name, hostId, since }) + "\n";
  const e = writePrivate(f, text); if (e) return f + ": " + e;
  hostSeen.set(d, text);
  return "";
}
// one request line appended to today's file in one write; a line torn by an earlier failed write (disk full) is ended
// first, so it costs only itself (the reader skips it); "" ok
export function appendReq(root: string, name: string, signal: string, json: string, now: number): string {
  const d = join(root, name);
  const f = join(d, signal + "-" + utcDay(now) + ".jsonl");
  let fd = -1;
  try {
    fd = openSync(f, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    const size = fstatSync(fd).size;
    const torn = size > 0 && (readBytes(f, size - 1, 1)[0] ?? 10) !== 10;
    writeSync(fd, (torn ? "\n" : "") + json + "\n");
    return "";
  } catch (e) { return f + ": " + (e instanceof Error ? e.message : String(e)); } finally { if (fd >= 0) closeSync(fd); }
}

export interface HubFile { host: string; path: string; day: string; size: number; gz: boolean }
// every stored request file under root (host directories only: names that are not ours are left alone)
export function hubFiles(root: string): HubFile[] {
  const out: HubFile[] = [];
  for (const h of listDir(root)) {
    if (h.startsWith(".")) continue;
    const d = join(root, h);
    for (const n of listDir(d)) {
      const m = FILE_RE.exec(n); if (!m) continue;
      let size = 0; try { const st = statSync(join(d, n)); if (!st.isFile()) continue; size = st.size; } catch (e) { continue; }
      out.push({ host: h, path: join(d, n), day: m[2] ?? "", size, gz: !!m[3] });
    }
  }
  return out;
}
// spec 10: files past the retention go first, then the oldest closed days across hosts until under 90 % of the budget;
// today's files are never deleted; full = today's files alone exceed the budget (ingest answers 503 then)
export function enforce(root: string, maxBytes: number, retentionDays: number, now: number): { deleted: string[]; used: number; full: boolean; today: number } {
  const today = utcDay(now); const cut = utcDay(now - retentionDays * 86400000);
  const fs0 = hubFiles(root); const deleted: string[] = [];
  let used = 0; let todayB = 0;
  const keep: HubFile[] = [];
  for (const f of fs0) {
    if (f.day !== today && f.day < cut) { try { unlinkSync(f.path); deleted.push(f.path); continue; } catch (e) { /* counted as kept */ } }
    keep.push(f); used += f.size; if (f.day === today) todayB += f.size;
  }
  if (used > maxBytes) {
    const old = keep.filter((f: HubFile) => f.day !== today).sort((a: HubFile, b: HubFile) => a.day < b.day ? -1 : a.day > b.day ? 1 : a.path < b.path ? -1 : 1);
    const target = maxBytes * 0.9;
    for (const f of old) { if (used < target) break; try { unlinkSync(f.path); deleted.push(f.path); used -= f.size; } catch (e) { /* stays */ } }
  }
  return { deleted, used, full: todayB > maxBytes, today: todayB };
}
// gzip one closed day (UTC days before today, once an hour past midnight has passed); returns how many were compressed
// (0 or 1: the timer calls again). The .jsonl goes only after the .gz is complete and reads back to the same bytes
export function compressClosed(root: string, now: number): number {
  if (now % 86400000 < 3600000) return 0;
  const today = utcDay(now);
  for (const f of hubFiles(root)) {
    if (f.gz || f.day >= today) continue;
    const gzPath = f.path + ".gz"; const tmp = gzPath + ".tmp";
    const r = readWhole(f.path, 512 * 1048576); if (r.err) continue;
    const raw = new TextEncoder().encode(r.text);
    const z = gzip(raw);
    try { unlinkSync(tmp); } catch (e) { /* none */ }
    if (!writeBin(tmp, z)) continue;
    const back = gunzipCapped(z, raw.length);
    if (back.err || back.out.length !== raw.length) { try { unlinkSync(tmp); } catch (e) { /* gone */ } continue; }
    try { renameSync(tmp, gzPath); unlinkSync(f.path); } catch (e) { continue; }
    return 1;
  }
  return 0;
}
