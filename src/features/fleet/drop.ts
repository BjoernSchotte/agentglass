// agentglass — `agentglass fleet drop <dir>` (fleet spec 15): snapshots into a synced directory for a viewer that cannot
// reach this host (a laptop behind NAT, a machine that sleeps): a full base, then deltas relative to the previous file,
// each written as .tmp and renamed when complete (sync tools copy finished files only)
// SPDX-License-Identifier: Apache-2.0
//   <hostId>.base-<gen>.snap.gz        a full snapshot (at the start, daily, and when the deltas since it pass half its size)
//   <hostId>.delta-<n>-<gen>.snap.gz   relative to the previous file's generation; n counts up across bases
import { mkdirSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { S } from "../../state.ts";
import { cliError, parseDur } from "../agentenv.ts";
import { HOME } from "../../util/fs.ts";
import { gzip, writeBin } from "../../util/gzip.ts";
import { hostId } from "../../util/hostid.ts";
import { REDACT } from "../redact-on.ts";
import { type Snap, snapLines } from "./snap.ts";
import { type PeerState, buildSnap, loadPeer, savePeer } from "./snapshot.ts";
import { argVal } from "../../util/argv.ts";

export const DROP_RE = /^([0-9a-f]{16})\.(base|delta-(\d{1,9}))-([0-9a-f]{16})\.snap\.gz$/;
export interface DropFile { name: string; id: string; base: boolean; n: number; gen: string; at: number; size: number }
export function dropFile(name: string, at: number, size: number): DropFile | null {
  const m = DROP_RE.exec(name); if (!m) return null;
  return { name, id: m[1] ?? "", base: m[2] === "base", n: m[3] ? Number(m[3]) : -1, gen: m[4] ?? "", at, size };
}
// this host's files in dir, oldest first by sequence (a base sorts by the n it starts after: its mtime order)
export function dropFiles(dir: string, id: string): DropFile[] {
  const o: DropFile[] = [];
  let ns: string[] = []; try { ns = readdirSync(dir); } catch (e) { ns = []; }
  for (const n of ns) { let at = 0; let sz = 0; try { const s = statSync(join(dir, n)); at = s.mtimeMs; sz = s.size; } catch (e) { continue; } const f = dropFile(n, at, sz); if (f && (!id || f.id === id)) o.push(f); }
  o.sort((a: DropFile, b: DropFile) => a.at - b.at || a.n - b.n);
  return o;
}
function dayOf(t: number): string { const d = new Date(t); return String(d.getFullYear()) + "-" + String(d.getMonth() + 1) + "-" + String(d.getDate()); }
export const DAY = 86400000; export const BASE_MIN = 262144;
// what the next run writes: a base (no base yet, a new day, the deltas since it past half its size (and 256 KB), the state lost or
// out of step with the directory) or a delta on the newest file's generation
export function nextKind(files: DropFile[], st: PeerState, now: number): { full: boolean; n: number } {
  let base: DropFile | null = null; for (const f of files) if (f.base) base = f;
  let maxN = 0; for (const f of files) if (f.n > maxN) maxN = f.n;
  const last = files.length ? files[files.length - 1] : null;
  if (!base || !last || dayOf(base.at) !== dayOf(now)) return { full: true, n: maxN };
  let since = 0; for (const f of files) if (!f.base && f.at >= base.at) since += f.size;
  if (since > Math.max(base.size / 2, BASE_MIN)) return { full: true, n: maxN }; // a small base is cheap to keep on
  // only a state that names the newest file continues the chain (a crash between rename and state save: a new base)
  if (!st.pending || st.pending.gen !== last.gen) return { full: true, n: maxN };
  return { full: false, n: maxN + 1 };
}
// deltas older than the newest base and bases older than the previous one go once they are a day old
export function pruneable(files: DropFile[], now: number): string[] {
  const bases: DropFile[] = []; for (const f of files) if (f.base) bases.push(f);
  if (!bases.length) return [];
  const newest = bases[bases.length - 1]; const prev = bases.length > 1 ? bases[bases.length - 2] : null;
  const old: string[] = [];
  for (const f of files) {
    if (now - f.at < DAY || !newest) continue;
    if (f.base ? !!prev && f.at < prev.at : f.at < newest.at) old.push(f.name);
  }
  return old;
}
export function prune(dir: string, files: DropFile[], now: number): string[] {
  const gone: string[] = [];
  for (const n of pruneable(files, now)) { try { unlinkSync(join(dir, n)); gone.push(n); } catch (e) { /* gone */ } }
  return gone;
}
// one run: the snapshot written into dir (tmp, then rename), the peer state "drop" acknowledged after the rename
export function dropOnce(dir: string, days: number, now: number, every = 0): { name: string; err: string } {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { return { name: "", err: "cannot create " + dir }; }
  const id = hostId(); const files = dropFiles(dir, id);
  const st = loadPeer("drop"); const k = nextKind(files, st, now);
  const base = k.full ? null : st.pending;
  if (base) { st.acked = base; st.pending = null; }
  const b = buildSnap(days, base, now);
  const x: Snap = b.snap; x.head["n"] = k.n; x.head["every"] = every; // a base names the sequence it starts after: the reader takes deltas past it
  const name = id + "." + (k.full ? "base" : "delta-" + String(k.n)) + "-" + x.gen + ".snap.gz";
  const tmp = join(dir, "." + name + ".tmp");
  if (!writeBin(tmp, gzip(new TextEncoder().encode(snapLines(x).join("\n") + "\n")))) return { name: "", err: "cannot write " + tmp };
  try { renameSync(tmp, join(dir, name)); } catch (e) { try { unlinkSync(tmp); } catch (e2) { /* gone */ } return { name: "", err: "cannot rename " + tmp }; }
  savePeer("drop", st, b.next);
  prune(dir, dropFiles(dir, id), now);
  return { name, err: "" };
}
function expand(p: string): string { return p.startsWith("~/") ? join(HOME, p.slice(2)) : resolve(p); }
function err(m: string): void { process.stderr.write("agentglass fleet drop: " + m + "\n"); }
// `fleet drop <dir> [--every <dur>] [--days N] [--redact]`: once (cron, a timer), or every <dur> until stopped
export function dropCli(args: string[]): void {
  const usage = "agentglass fleet drop <dir> [--every 5m] [--days N] [--redact]";
  let dir = ""; let every = 0; let days = 7;
  for (let i = 2; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--every") { every = parseDur(argVal(args, i) ?? ""); i++; if (!(every >= 60000 && every <= DAY)) cliError("usage", "--every needs a duration 1m–24h", usage, 2); }
    else if (a === "--days") { const v = argVal(args, i) ?? ""; i++; days = /^\d+$/.test(v) ? Number(v) : 0; if (days < 1 || days > 90) cliError("usage", "--days needs a whole number 1–90", usage, 2); }
    else if (a === "--redact" || a === "--agent" || a === "--no-agent") continue;
    else if (!a.startsWith("-") && !dir) dir = a;
    else cliError("usage", "unknown option " + a + " for fleet drop", usage, 2);
  }
  if (!dir) cliError("usage", "fleet drop needs a directory (one per host, synced to the viewer)", usage, 2);
  S.cli = true;
  const d = expand(dir);
  if (!REDACT && !(d === HOME || d.startsWith(HOME + "/"))) err("warning: " + d + " is outside your home and the drop is not redacted: titles, paths and projects travel as they are (use --redact for a shared or third-party synced folder)");
  const once = (): void => { const r = dropOnce(d, days, Date.now(), every); if (r.err) err(r.err); else if (!every) process.stdout.write(r.name + "\n"); };
  once();
  if (!every) process.exit(0);
  setInterval(once, every);
}
