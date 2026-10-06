// agentglass — the receive token store (otlp-hub spec 9.1–9.3): one token per host, only its SHA-256 at rest, rotation
// with a grace period, revocation, expiry, host-id pinning; re-read when the file changes (at most one stat a second)
// SPDX-License-Identifier: Apache-2.0
//   <dir>/tokens (0600 in a 0700 dir), one line per token: "name sha256-hex created-ms expires-ms pinnedHostId|-"
import * as fs from "node:fs";
import { statSync, renameSync, unlinkSync, writeSync, closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { OS } from "../../platform/index.ts";
import { secureDir, myUid } from "../palette/rundir.ts";
import { readWhole } from "../../util/fs.ts";
import { sha256Hex } from "../../util/sha256.ts";
import { randomBytes, b64url, ctEq } from "../../util/rand.ts";

export interface Tok { name: string; hash: string; created: number; expires: number; pin: string } // expires 0 = never, pin "" = none yet
export const HOST_RE = /^[a-z0-9][a-z0-9-]{0,15}$/; // the fleet host-name pattern: names become directories
const HOSTID_RE = /^[0-9a-f]{16}$/;
const LINE_RE = /^([a-z0-9][a-z0-9-]{0,15}) ([0-9a-f]{64}) (\d{1,15}) (\d{1,15}) ([0-9a-f]{16}|-)$/;
export const TOKEN_RE = /^agr_[A-Za-z0-9_-]{43}$/;
export const TOKEN_MAX = 64 * 1024; // a token file larger than this is refused (thousands of hosts fit)
export function tokensFile(dir: string): string { return join(dir, "tokens"); }
export function tokenHash(t: string): string { return sha256Hex(t); }

// malformed lines are dropped (a hand edit cannot widen access: a line must parse completely to count)
export function parseTokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const l of text.split("\n")) {
    const m = LINE_RE.exec(l.trim());
    if (!m) continue;
    const pin = m[5] ?? "-";
    out.push({ name: m[1] ?? "", hash: m[2] ?? "", created: Number(m[3] ?? "0"), expires: Number(m[4] ?? "0"), pin: pin === "-" ? "" : pin });
  }
  return out;
}
export function tokensText(ts: Tok[]): string { return ts.map((t: Tok) => t.name + " " + t.hash + " " + String(t.created) + " " + String(t.expires) + " " + (t.pin || "-") + "\n").join(""); }

function octal(m: number): string { return "0" + String((m >> 6) & 7) + String((m >> 3) & 7) + String(m & 7); }
// "" = the file is missing or a regular file of ours without group/other bits; else why not, with the fix
export function fileProblem(file: string): string {
  const i = OS.fileInfo(file);
  if (!i) return "";
  if (i.kind !== "file") return file + " is not a regular file";
  if (i.uid !== myUid()) return file + " is owned by uid " + String(i.uid) + " — it must be yours";
  if ((i.mode & 0o077) !== 0) return file + " has mode " + octal(i.mode) + " — run: chmod 600 " + file;
  return "";
}
// the directory holding the file: ours, 0700 (made so when absent and create)
export function dirProblem(dir: string, create: boolean): string {
  const r = secureDir(dir, myUid(), OS.fileInfo, create);
  return r ? r + (r.indexOf("mode") >= 0 ? " — run: chmod 700 " + dir : "") : "";
}
// the tokens as stored; err = refused (not private, unreadable): callers must not treat that as "no tokens"
export function readTokens(file: string): { toks: Tok[]; err: string } {
  const d = dirProblem(dirname(file), false); if (d && OS.fileInfo(dirname(file))) return { toks: [], err: d };
  const p = fileProblem(file); if (p) return { toks: [], err: p };
  const r = readWhole(file, TOKEN_MAX);
  if (r.missing) return { toks: [], err: "" };
  if (r.err) return { toks: [], err: file + ": " + r.err };
  return { toks: parseTokens(r.text), err: "" };
}
// atomic replace: a 0600 temp file (O_EXCL, never over a symlink) renamed over the old one
export function writeTokens(file: string, ts: Tok[]): string {
  const d = dirProblem(dirname(file), true); if (d) return d;
  const tmp = file + ".tmp-" + String(process.pid);
  let fd = -1;
  try {
    try { unlinkSync(tmp); } catch (e) { /* none left */ }
    fd = openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    writeSync(fd, tokensText(ts)); closeSync(fd); fd = -1;
    renameSync(tmp, file);
    return "";
  } catch (e) {
    if (fd >= 0) closeSync(fd);
    try { unlinkSync(tmp); } catch (e2) { /* not written */ }
    return file + ": " + (e instanceof Error ? e.message : String(e));
  }
}
function edit(file: string, f: (ts: Tok[]) => string): string {
  const r = readTokens(file); if (r.err) return r.err;
  const e = f(r.toks); if (e) return e;
  return writeTokens(file, r.toks);
}
function newToken(): string { return "agr_" + b64url(randomBytes(32)); }
export function live(t: Tok, now: number): boolean { return t.expires === 0 || now < t.expires; }

// a new host: returns the token (shown once) or throws with the reason. repin on a known host clears its pins instead
// and returns "" (a reinstalled machine keeps its headers file; its next accepted host.id pins again)
export function addToken(file: string, name: string, expiresMs: number, now: number, repin: boolean): string {
  if (!HOST_RE.test(name)) throw new Error("host name must be 1–16 of a-z 0-9 - (starting with a letter or digit): " + JSON.stringify(name));
  let tok = "";
  const e = edit(file, (ts: Tok[]): string => {
    const mine = ts.filter((t: Tok) => t.name === name && live(t, now));
    if (mine.length && repin) { for (const t of mine) t.pin = ""; return ""; }
    if (mine.length) return "host " + name + " already has a token — use: agentglass receive token rotate " + name + " (or revoke it first)";
    for (let i = ts.length - 1; i >= 0; i--) if ((ts[i] as Tok).name === name) ts.splice(i, 1); // expired leftovers
    tok = newToken();
    ts.push({ name, hash: tokenHash(tok), created: now, expires: expiresMs > 0 ? now + expiresMs : 0, pin: "" });
    return "";
  });
  if (e) throw new Error(e);
  return tok;
}
// a new token for a known host (same pin: the same machine); its older tokens stop working after the grace period
export function rotateToken(file: string, name: string, graceMs: number, expiresMs: number, now: number): string {
  let tok = "";
  const e = edit(file, (ts: Tok[]): string => {
    const mine = ts.filter((t: Tok) => t.name === name && live(t, now));
    if (!mine.length) return "no token for host " + name + " — add one: agentglass receive token add " + name;
    let pin = ""; for (const t of mine) { if (t.pin) pin = t.pin; const g = now + Math.max(0, graceMs); if (t.expires === 0 || t.expires > g) t.expires = g; }
    tok = newToken();
    ts.push({ name, hash: tokenHash(tok), created: now, expires: expiresMs > 0 ? now + expiresMs : 0, pin });
    return "";
  });
  if (e) throw new Error(e);
  return tok;
}
// every token of the host, at once; returns how many
export function revokeToken(file: string, name: string): number {
  let n = 0;
  const e = edit(file, (ts: Tok[]): string => { for (let i = ts.length - 1; i >= 0; i--) if ((ts[i] as Tok).name === name) { ts.splice(i, 1); n++; } return n ? "" : "no token for host " + name; });
  if (e) throw new Error(e);
  return n;
}
// the live token the presented secret matches, or null. The presented value is hashed once and compared against every
// entry in constant time (no early exit: the position of a match does not show in the timing)
export function checkToken(ts: Tok[], presented: string, now: number): Tok | null {
  if (!TOKEN_RE.test(presented)) return null;
  const h = tokenHash(presented); let hit: Tok | null = null;
  for (const t of ts) if (ctEq(t.hash, h) && live(t, now) && !hit) hit = t;
  return hit;
}
// record the first accepted host.id under this token (by hash); "" ok, else the write error
export function pinToken(file: string, hash: string, hostId: string): string {
  if (!HOSTID_RE.test(hostId)) return "bad host id";
  return edit(file, (ts: Tok[]): string => { for (const t of ts) if (t.hash === hash && !t.pin) t.pin = hostId; return ""; });
}

// the server's view: re-read when the file's mtime or size changes, stat at most once a second (SIGHUP forces it)
export interface TokStore { file: string; toks: Tok[]; mt: number; size: number; ino: number; at: number; err: string }
export function tokStore(file: string): TokStore { const s: TokStore = { file, toks: [], mt: -1, size: -1, ino: -1, at: 0, err: "" }; reloadTokens(s, 0, true); return s; }
export function reloadTokens(s: TokStore, now: number, force: boolean): void {
  if (!force && now - s.at < 1000) return;
  s.at = now;
  let mt = 0; let size = 0; let ino = 0; // every write renames a new file in: the inode changes even within one mtime tick
  try { const st = statSync(s.file); mt = st.mtimeMs; size = st.size; ino = st.ino; } catch (e) { mt = 0; size = 0; ino = 0; }
  if (!force && mt === s.mt && size === s.size && ino === s.ino) return;
  const r = readTokens(s.file);
  s.mt = mt; s.size = size; s.ino = ino; s.err = r.err;
  s.toks = r.err ? [] : r.toks; // refused file: nobody gets in until it is fixed (fail closed)
}
