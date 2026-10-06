// agentglass — the hub reader's file side (otlp-hub spec 3): OTLP/JSON request lines from an OTel Collector's file
// exporter or from agentglass receive, read incrementally under a per-tick budget with rotation-safe cursors.
// A cursor belongs to a file's identity (dev:ino) and is checked against the SHA-256 of the file's head: a renamed file
// keeps its cursor, a rewritten head or a shrunk file restarts at 0, a gzip-compressed copy of a file already read
// continues where the plain file left off (its decompressed head matches). Persisted per source, 0600, atomic.
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { join } from "node:path";
import { HOME, listDir, readBytes, readWhole } from "../../util/fs.ts";
import { sha256Bytes, hexOf } from "../../util/sha256.ts";
import { gunzipCapped, gzipIsize } from "../../util/inflate.ts";
import { OS } from "../../platform/index.ts";
import { myUid } from "../palette/rundir.ts";
import { dirProblem } from "./tokens.ts";
import { writePrivate } from "./store.ts";

export const HEAD = 4096; export const LINE_MAX = 16 * 1048576; export const GZ_MAX = 256 * 1048576;
export const TICK_BYTES = 2 * 1048576; export const TICK_LINES = 2000;
const CHUNK = 1048576; const RECHECK_MS = 60000;
export interface FileCur { id: string; head: string; hlen: number; off: number; gz: boolean; done: boolean; path: string; lost: number } // lost: when the file was first missed (0 = present)
interface Seen { id: string; ok: string; at: number } // a path's identity and owner/mode verdict ("" = readable)
export interface Source { name: string; dir: string; trust: string; maxAgeDays: number; cur: Map<string, FileCur>; backlog: boolean; skipped: Map<string, string>; seen: Map<string, Seen>; clock: () => number }
export function newSource(name: string, dir: string, trust: string, maxAgeDays: number): Source {
  return { name, dir, trust, maxAgeDays, cur: new Map<string, FileCur>(), backlog: false, skipped: new Map<string, string>(), seen: new Map<string, Seen>(), clock: (): number => Date.now() };
}
// "label" for an agentglass receive directory (it holds the token file), "payload" otherwise (spec 2), unless configured
export function trustOf(dir: string, configured: string): string { return configured || (statOk(join(dir, "tokens")) ? "label" : "payload"); }
function statOk(p: string): boolean { try { return statSync(p).isFile(); } catch (e) { return false; } }
const NAME_RE = /\.(jsonl|json|jsonl\.gz)$/;
function headHash(b: Uint8Array): string { return hexOf(sha256Bytes(b)); }
function octal(m: number): string { return "0" + String((m >> 6) & 7) + String((m >> 3) & 7) + String(m & 7); }
// "" = a regular file of the user or root, not group/other-writable; else why it is skipped (spec 3.2)
export function fileVerdict(path: string): string {
  const i = OS.fileInfo(path);
  if (!i) return "gone";
  if (i.kind !== "file") return "not a regular file";
  if (i.uid !== myUid() && i.uid !== 0) return "owned by uid " + String(i.uid) + " — the writer must run as you (a Collector in Docker: --user $(id -u):$(id -g))";
  if ((i.mode & 0o022) !== 0) return "mode " + octal(i.mode) + " lets others write it — chmod go-w";
  return "";
}
// the readable request files of the source: the directory and its direct subdirectories, oldest change first
export function scanFiles(src: Source): string[] {
  const now = src.clock(); const out: { p: string; mt: number }[] = [];
  const dirs = src.trust === "label" ? [] : [src.dir]; // a receive directory keeps requests in host directories only (its root holds tokens, status.json)
  for (const n of listDir(src.dir)) { if (n.startsWith(".")) continue; const d = join(src.dir, n); try { if (statSync(d).isDirectory()) dirs.push(d); } catch (e) { /* gone */ } }
  const live = new Set<string>();
  for (const d of dirs) for (const n of listDir(d)) {
    if (!NAME_RE.test(n) || n.endsWith(".tmp")) continue;
    const p = join(d, n);
    let id = ""; let mt = 0;
    try { const st = statSync(p); if (!st.isFile()) continue; id = String(st.dev) + ":" + String(st.ino); mt = st.mtimeMs; } catch (e) { continue; }
    live.add(p);
    let s = src.seen.get(p);
    if (!s || s.id !== id || now - s.at > RECHECK_MS) { s = { id, ok: fileVerdict(p), at: now }; src.seen.set(p, s); }
    if (s.ok) { src.skipped.set(p, s.ok); continue; }
    src.skipped.delete(p);
    out.push({ p, mt });
  }
  for (const p of src.seen.keys()) if (!live.has(p)) { src.seen.delete(p); src.skipped.delete(p); }
  out.sort((a, b) => a.mt - b.mt || (a.p < b.p ? -1 : 1));
  return out.map((x) => x.p);
}
function idOf(p: string): { id: string; size: number; mt: number } | null { try { const st = statSync(p); return { id: String(st.dev) + ":" + String(st.ino), size: st.size, mt: st.mtimeMs }; } catch (e) { return null; } }
// complete lines of text in order; a line over LINE_MAX is skipped
function emit(text: string, file: string, sink: (line: string, file: string) => void): number {
  let n = 0;
  for (const l of text.split("\n")) { if (!l || l.length > LINE_MAX) continue; sink(l, file); n++; }
  return n;
}

// one budgeted pass (spec 3.3–3.4): plain files from their cursors, at most one gzip file whole; returns what was read
export function readStep(src: Source, budgetBytes: number, budgetLines: number, sink: (line: string, file: string) => void): { bytes: number; lines: number } {
  let bytes = 0; let lines = 0; let gzDone = false; src.backlog = false;
  const now = src.clock(); const cutMs = now - src.maxAgeDays * 86400000;
  const files = scanFiles(src);
  const ids = new Set<string>();
  for (const p of files) {
    const f = idOf(p); if (!f) continue;
    ids.add(f.id);
    let c = src.cur.get(f.id);
    const gz = p.endsWith(".gz");
    if (!c && f.mt < cutMs) { src.cur.set(f.id, { id: f.id, head: "", hlen: 0, off: f.size, gz, done: gz, path: p, lost: 0 }); continue; } // older than maxAgeDays on first sight
    if (gz) {
      if (c && c.done) continue;
      if (gzDone || bytes >= budgetBytes || lines >= budgetLines) { src.backlog = true; continue; }
      gzDone = true;
      const raw = readBytes(p, 0, f.size);
      const isz = gzipIsize(raw);
      if (isz > GZ_MAX) { src.cur.set(f.id, { id: f.id, head: "", hlen: 0, off: 0, gz: true, done: true, path: p, lost: 0 }); src.skipped.set(p, "decompresses past 256 MB"); continue; }
      const g = gunzipCapped(raw, GZ_MAX);
      if (g.err) { src.cur.set(f.id, { id: f.id, head: "", hlen: 0, off: 0, gz: true, done: true, path: p, lost: 0 }); src.skipped.set(p, "gzip: " + g.err); continue; }
      // a compressed copy of a plain file already (partly) read: continue at its offset, once
      const hl = Math.min(HEAD, g.out.length); const hh = headHash(g.out.subarray(0, hl));
      let start = 0;
      let from = "";
      for (const o of src.cur.values()) if (!o.gz && o.hlen > 0 && o.hlen <= g.out.length && o.off <= g.out.length && !ids.has(o.id) && headHash(g.out.subarray(0, o.hlen)) === o.head) { start = o.off; from = o.id; break; }
      if (from) src.cur.delete(from);
      const text = new TextDecoder("utf-8").decode(g.out.subarray(start));
      const n = emit(text, p, sink);
      lines += n; bytes += raw.length;
      src.cur.set(f.id, { id: f.id, head: hh, hlen: hl, off: g.out.length, gz: true, done: true, path: p, lost: 0 });
      continue;
    }
    // plain file: verify the cursor against the head, then read complete lines from its offset
    const hl = Math.min(HEAD, f.size);
    if (c) {
      const cur = c;
      const h = cur.hlen ? headHash(readBytes(p, 0, cur.hlen)) : "";
      if ((cur.hlen && h !== cur.head) || f.size < cur.off) { cur.off = 0; cur.hlen = 0; cur.head = ""; } // rewritten or truncated: from the start
    } else { c = { id: f.id, head: "", hlen: 0, off: 0, gz: false, done: false, path: p, lost: 0 }; src.cur.set(f.id, c); }
    c.path = p; c.lost = 0;
    if (c.hlen < hl) { c.hlen = hl; c.head = headHash(readBytes(p, 0, hl)); }
    while (c.off < f.size) {
      if (bytes >= budgetBytes || lines >= budgetLines) { src.backlog = true; break; }
      const want = Math.min(Math.max(CHUNK, budgetBytes - bytes), LINE_MAX + 1);
      const b = readBytes(p, c.off, Math.min(want, f.size - c.off));
      let z = b.length - 1; while (z >= 0 && b[z] !== 10) z--;
      if (z < 0) { // no complete line in the window: find the end of this long line
        let q = c.off + b.length; let end = -1;
        while (q < f.size && end < 0 && q - c.off <= LINE_MAX) { const nb = readBytes(p, q, CHUNK); if (!nb.length) break; let k = 0; while (k < nb.length && nb[k] !== 10) k++; if (k < nb.length) end = q + k; else q += nb.length; }
        if (end < 0 && q - c.off <= LINE_MAX) break; // still being written
        if (end < 0) { // over LINE_MAX: skip to its end (it may not be complete yet: look again next pass)
          let r2 = q; let found = -1;
          while (r2 < f.size && found < 0) { const nb = readBytes(p, r2, CHUNK); if (!nb.length) break; let k = 0; while (k < nb.length && nb[k] !== 10) k++; if (k < nb.length) found = r2 + k; else r2 += nb.length; }
          if (found < 0) break;
          bytes += found + 1 - c.off; c.off = found + 1; continue;
        }
        if (end - c.off > LINE_MAX) { bytes += end + 1 - c.off; c.off = end + 1; continue; }
        const whole = readBytes(p, c.off, end - c.off); // one long line, whole (≤ LINE_MAX)
        sink(new TextDecoder("utf-8").decode(whole), p); lines++;
        bytes += end + 1 - c.off; c.off = end + 1; continue;
      }
      // whole lines up to the line budget, byte offsets exact
      let a = 0; let stopped = false;
      for (let i = 0; i <= z; i++) {
        if (b[i] !== 10) continue;
        if (lines >= budgetLines) { src.backlog = true; stopped = true; break; }
        if (i > a && i - a <= LINE_MAX) { sink(new TextDecoder("utf-8").decode(b.subarray(a, i)), p); lines++; }
        a = i + 1;
      }
      c.off += a; bytes += a;
      if (stopped) break;
    }
    if (c.off < f.size) {
      const tail = readBytes(p, c.off, Math.min(f.size - c.off, LINE_MAX + 1));
      let nl = false; for (let i = 0; i < tail.length; i++) if (tail[i] === 10) { nl = true; break; }
      if (nl) src.backlog = true;
    }
  }
  // cursors of files that are gone: a compressed copy may still appear (receive gzips closed days an hour after
  // midnight), so plain ones are kept two days; finished gzip ones go at once
  const drop: string[] = [];
  for (const k of src.cur.keys()) {
    if (ids.has(k)) continue;
    const c = src.cur.get(k); if (!c) continue;
    if (c.gz) { drop.push(k); continue; }
    if (!c.lost) c.lost = now; else if (now - c.lost > 2 * 86400000) drop.push(k);
  }
  for (const k of drop) src.cur.delete(k);
  return { bytes, lines };
}

// ~/.agentglass/fleet/hub-<source>.state: a header line with the cursors, then the caller's lines (aggregates)
export function stateFile(name: string): string { return join(process.env["AGENTGLASS_FLEET_DIR"] || join(HOME, ".agentglass", "fleet"), "hub-" + name + ".state"); }
export function saveState(src: Source, body: string[]): string {
  const f = stateFile(src.name);
  const dir = f.slice(0, f.lastIndexOf("/"));
  const d = dirProblem(dir, true); if (d) return d;
  const cur: string[] = []; for (const c of src.cur.values()) cur.push("[" + JSON.stringify(c.id) + "," + JSON.stringify(c.head) + "," + String(c.hlen) + "," + String(c.off) + "," + (c.gz ? "1" : "0") + "," + (c.done ? "1" : "0") + "," + JSON.stringify(c.path) + "," + String(c.lost) + "]");
  const head = "{\"format\":\"agentglass-hub-state/v1\",\"source\":" + JSON.stringify(src.name) + ",\"dir\":" + JSON.stringify(src.dir) + ",\"cur\":[" + cur.join(",") + "]}";
  return writePrivate(f, head + "\n" + body.map((l: string) => l + "\n").join(""));
}
export function loadState(src: Source): string[] | null {
  const r = readWhole(stateFile(src.name), 256 * 1048576);
  if (r.err || r.missing) return null;
  const ls = r.text.split("\n"); const h = ls[0] ?? "";
  let o: Record<string, unknown> | null = null; try { o = JSON.parse(h) as Record<string, unknown>; } catch (e) { return null; }
  if (!o || o["format"] !== "agentglass-hub-state/v1" || o["dir"] !== src.dir) return null; // another directory: start over
  const cur = o["cur"]; if (!Array.isArray(cur)) return null;
  src.cur.clear();
  for (const x of cur as unknown[]) {
    if (!Array.isArray(x)) continue; const a = x as unknown[];
    const id = String(a[0] ?? ""); if (!id) continue;
    const n = (v: unknown): number => typeof v === "number" ? v as number : 0;
    src.cur.set(id, { id, head: String(a[1] ?? ""), hlen: n(a[2]), off: n(a[3]), gz: a[4] === 1, done: a[5] === 1, path: String(a[6] ?? ""), lost: n(a[7]) });
  }
  return ls.slice(1).filter((l: string) => l.length > 0);
}
