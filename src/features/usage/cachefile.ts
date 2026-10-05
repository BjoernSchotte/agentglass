// agentglass — the ledger cache file: one JSON header line, then one line per session, streamed in and out
// SPDX-License-Identifier: Apache-2.0
// Pure IO over a path (cache.ts decides what goes in). Reading holds one window of lines at a time, never the whole file
// or one object tree of it; writing holds one session's line at a time. A line that does not parse (a torn write, a
// line over the largest window) costs only that session: it is reported as bad and skipped, so it re-indexes.
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { type Obj, obj, str, parse } from "../../util/json.ts";
import { readBytes } from "../../util/fs.ts";

function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }

export const FILE_FORMAT = 2; // 1 = ledger.json (one object, cache.ts reads it once to migrate)
export interface Head { v: number; prices: string; kiro: number; rl: Obj | null } // kiro: the credit rate kiro sessions were booked at
const WIN = 4194304; const MAX_WIN = 67108864; // windows grow ×4 for a long line, up to 64 MB
const NL = 10;

function lastNl(b: Uint8Array): number { let z = b.length - 1; while (z >= 0 && b[z] !== NL) z--; return z; }
// the offset just past the next newline at or after `at` (size when there is none): skips a line over MAX_WIN
function pastLine(path: string, at: number, size: number): number {
  for (let p = at; p < size; p += WIN) {
    const b = readBytes(path, p, Math.min(WIN, size - p)); if (!b.length) return size;
    for (let i = 0; i < b.length; i++) if (b[i] === NL) return p + i + 1;
  }
  return size;
}
// onHead false (other VERSION, prices, format): stale, stop. Sessions arrive in file order; a later line for the same
// path wins (the caller's map set). lines = session lines seen, bad = those skipped.
export function readCache(path: string, onHead: (h: Head) => boolean, onSession: (path: string, o: Obj) => void): { lines: number; bad: number } {
  const r = { lines: 0, bad: 0 };
  let size = 0;
  try { size = statSync(path).size; } catch (e) { return r; }
  let at = 0; let w = WIN; let head = true;
  while (at < size) {
    const end = Math.min(size, at + w);
    const b = readBytes(path, at, end - at); if (!b.length) break;
    const z = lastNl(b);
    if (z < 0 && end < size) { // not one whole line in the window
      if (w < MAX_WIN) { w *= 4; continue; }
      if (head) return r; // a header that long is not ours
      r.lines++; r.bad++; at = pastLine(path, end, size); w = WIN; continue;
    }
    const n = z < 0 ? b.length : z + 1; // at the end of the file an unterminated rest is one (likely torn) line
    const text = new TextDecoder("utf-8").decode(b.subarray(0, z < 0 ? b.length : z));
    for (const l of text.split("\n")) {
      if (head) {
        head = false; const o = parse(l);
        if (!o || o["f"] !== FILE_FORMAT || !onHead({ v: num(o["v"]), prices: str(o["prices"]), kiro: num(o["kiro"]), rl: obj(o["rl"]) })) return r;
        continue;
      }
      if (!l) continue;
      r.lines++;
      const o = parse(l); const p = o ? str(o["path"]) : "";
      if (!o || !p) { r.bad++; continue; }
      onSession(p, o);
    }
    at += n; w = WIN;
  }
  return r;
}
// temp file + rename (atomic: a crash mid-write keeps the previous file); false on any error, the temp file removed.
// The line is {"path":…} followed by the session object's own members (no copy of the object to add the key).
export function writeCache(path: string, head: Head, each: (put: (path: string, o: Obj) => void) => void): boolean {
  const tmp = path + ".tmp"; let fd = -1;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(tmp, "w");
    const f = fd; let buf: string[] = []; let len = 0;
    const out = (s: string): void => { buf.push(s); len += s.length; if (len >= 1048576) { writeSync(f, buf.join("")); buf = []; len = 0; } };
    out(JSON.stringify({ v: head.v, f: FILE_FORMAT, prices: head.prices, kiro: head.kiro, saved: Date.now(), rl: head.rl }) + "\n");
    each((p: string, o: Obj): void => {
      const body = JSON.stringify(o);
      out('{"path":' + JSON.stringify(p) + (body.length > 2 ? "," + body.slice(1) : "}") + "\n");
    });
    if (buf.length) writeSync(f, buf.join(""));
    closeSync(fd); fd = -1;
    renameSync(tmp, path);
    return true;
  } catch (e) {
    try { if (fd >= 0) closeSync(fd); } catch (e2) { /* already closed */ }
    try { unlinkSync(tmp); } catch (e3) { /* never created */ }
    return false;
  }
}
