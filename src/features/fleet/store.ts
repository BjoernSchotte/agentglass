// agentglass — the fleet spool (fleet spec 6): ~/.agentglass/fleet (0700), per host key k: k.jsonl (the last complete
// report), k.tmp, k.err, k.rc (written last: the completion signal), k.pid. Reports are read in line windows
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME, readBytes, readText, listDir } from "../../util/fs.ts";
import { OS } from "../../platform/index.ts";
import { secureDir, myUid } from "../palette/rundir.ts";
import type { HostReport } from "./model.ts";
import { type Parse, newParse, feedLines, toReport } from "./report.ts";
import { NAME_RE } from "./config.ts";

// AGENTGLASS_FLEET_DIR: another spool (tests); read per call
export function fleetDir(): string { const e = process.env["AGENTGLASS_FLEET_DIR"]; return e !== undefined && e ? e : join(HOME, ".agentglass", "fleet"); }
const DIR = { ok: "" }; // the directory checked fine once (secureDir spawns stat): not again per pull
// "" = the spool directory is ours and owner-only (created 0700 when missing); else why not
export function ensureDir(): string {
  const d = fleetDir(); if (DIR.ok === d) return "";
  try { mkdirSync(join(d, ".."), { recursive: true, mode: 0o700 }); } catch (e) { /* secureDir names the problem */ }
  const why = secureDir(d, myUid(), OS.fileInfo, true);
  if (!why) DIR.ok = d;
  return why;
}
// a redacted report never shares a file with an unredacted one: a viewer under --redact reads only .r files
export function keyOf(name: string, redact: boolean): string { return redact ? name + ".r" : name; }
export function spoolPath(k: string, ext: string): string { return join(fleetDir(), k + "." + ext); }
export function mtimeOf(path: string): number { try { return statSync(path).mtimeMs; } catch (e) { return 0; } }
export interface Spool { rcAt: number; rc: number; err: string }
// the last finished run: its exit code and the first line of its stderr (≤ 4 KB read); null = none yet
export function spoolOf(k: string): Spool | null {
  const at = mtimeOf(spoolPath(k, "rc")); if (!at) return null;
  const t = readText(spoolPath(k, "rc"), 0, 32).trim();
  const rc = /^-?\d+$/.test(t) ? Number(t) : 1;
  return { rcAt: at, rc, err: firstErr(readText(spoolPath(k, "err"), 0, 4096)) };
}
// the first stderr line that says something (ssh warnings about known_hosts additions come first and are not the cause)
export function firstErr(t: string): string {
  const ls = t.split("\n").map((l: string) => l.trim()).filter((l: string) => l !== "");
  for (const l of ls) if (!/^Warning: Permanently added/.test(l)) return l.slice(0, 300);
  return ls.length ? (ls[0] ?? "").slice(0, 300) : "";
}
// a report read a window of lines per step: off = the byte after the last consumed line, at = the file's mtime
export interface Reader { k: string; path: string; off: number; p: Parse; at: number }
export function newReader(k: string): Reader { const path = spoolPath(k, "jsonl"); return { k, path, off: 0, p: newParse(), at: mtimeOf(path) }; }
const WIN = 524288; const MAX_LINE = 67108864;
// undefined = not finished yet; null = finished with r.p.err (a missing file, a cut report); else the report
export function readStep(r: Reader, maxLines: number): HostReport | null | undefined {
  if (r.p.err) return null;
  let w = WIN;
  for (;;) {
    const b = readBytes(r.path, r.off, w);
    let z = b.length - 1; while (z >= 0 && b[z] !== 10) z--;
    if (z < 0) {
      if (b.length === w && w < MAX_LINE) { w *= 4; continue; } // one line longer than the window
      if (!r.p.done) r.p.err = r.off === 0 && b.length === 0 ? "no report" : "incomplete report"; // the end of the file without the end line
      return toReport(r.p) ?? null;
    }
    // at most maxLines: cut after the maxLines-th newline (bytes, not decoded text)
    let n = 0; let cut = -1;
    for (let i = 0; i <= z; i++) if (b[i] === 10 && ++n === maxLines) { cut = i; break; }
    const end = cut >= 0 ? cut : z;
    const lines = new TextDecoder("utf-8").decode(b.subarray(0, end + 1)).split("\n"); lines.pop(); // after the last "\n"
    feedLines(r.p, lines); r.off += end + 1;
    if (r.p.err) return null;
    if (r.p.done) return toReport(r.p);
    return undefined;
  }
}
// spool files of hosts no longer configured: only names of the host pattern, only inside fleetDir(), only our extensions
const EXTS = ["jsonl", "tmp", "err", "rc", "rc.tmp", "pid"];
export function forget(names: string[]): void {
  const d = fleetDir();
  for (const f of listDir(d)) {
    let base = ""; let ext = "";
    for (const e of EXTS) if (f.endsWith("." + e) && f.length > e.length + 1) { const b = f.slice(0, f.length - e.length - 1); if (!base || b.length < base.length) { base = b; ext = e; } }
    if (!ext) continue;
    const name = base.endsWith(".r") ? base.slice(0, base.length - 2) : base;
    if (!NAME_RE.test(name) || names.indexOf(name) >= 0) continue;
    try { unlinkSync(join(d, f)); } catch (e) { /* gone */ }
  }
}
