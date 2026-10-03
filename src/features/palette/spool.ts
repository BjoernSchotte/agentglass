// agentglass — single instance, the spool transport (scriptc 0.1.7 has no Unix-domain sockets): a client drops
// "open <ref>\n" as inbox/<epoch-ms>-<pid>.link (0600, O_EXCL under a temp name, then renamed) and waits ≤ 2 s for
// <epoch-ms>-<pid>.res (also written under a temp name, then renamed); the TUI holding tui.lock answers on its tick. Entries that are not regular files of ours
// (symlinks, FIFOs, foreign) are never read or unlinked: single instance is disabled instead.
// SPDX-License-Identifier: Apache-2.0
import { lstatSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { listDir } from "../../util/fs.ts";
import { type InfoFn, secureDir, lockHolder, readOwn, createOwn } from "./rundir.ts";
import { type Rate, parseRequest, allow } from "./handoff.ts";

const LINK_RE = /^(\d{13})-(\d{1,10})\.link$/; const RES_RE = /^(\d{13})-(\d{1,10})\.res$/; const TMP_RE = /^\.tmp-(\d{13})-(\d{1,10})$/;
const MAX_FILE = 4096; const PER_TICK = 16; const STALE = 60000; const SKEW = 5000;
let warn = "";
export function spoolWarn(): string { return warn; }
// client: "" = no live server or an unsafe run dir (open the link yourself), else the .link written
export function spoolSend(run: string, req: string, pid: number, now: number, uid: number, info: InfoFn, alive: (pid: number) => boolean, isOurs: (pid: number) => boolean): string {
  const inbox = join(run, "inbox");
  if (secureDir(run, uid, info, false) || secureDir(inbox, uid, info, false)) return "";
  if (!lockHolder(run, uid, info, alive, isOurs)) return "";
  const name = String(now) + "-" + String(pid);
  const tmp = join(inbox, ".tmp-" + name); const p = join(inbox, name + ".link");
  if (!createOwn(tmp, req)) return "";
  try { renameSync(tmp, p); } catch (e) { try { unlinkSync(tmp); } catch (e2) { /* gone */ } return ""; }
  return p;
}
function dirent(p: string): boolean { try { lstatSync(p); return true; } catch (e) { return false; } }
function own(p: string): boolean { try { const st = lstatSync(p); return st.isFile() && !st.isSymbolicLink(); } catch (e) { return false; } }
// client: polls every 50 ms for the reply; on timeout our .link is withdrawn and done("") (fall back to an own TUI)
export function spoolAwait(path: string, timeoutMs: number, uid: number, info: InfoFn, done: (reply: string) => void): void {
  const res = path.slice(0, -".link".length) + ".res";
  const t0 = Date.now();
  const tick = (): void => {
    if (dirent(res)) { // lstat: a dangling symlink counts too
      const b = readOwn(res, uid, info, 64);
      if (b) { try { unlinkSync(res); } catch (e) { /* gone */ } } // not ours (a symlink, a FIFO): never unlinked
      else if (own(path)) { try { unlinkSync(path); } catch (e) { /* taken meanwhile */ } } // no usable reply: withdraw the request
      done(b ? new TextDecoder().decode(b).trim() : "");
      return;
    }
    if (Date.now() - t0 >= timeoutMs) { if (own(path)) { try { unlinkSync(path); } catch (e) { /* taken meanwhile */ } } done(""); return; }
    setTimeout(tick, 50);
  };
  tick();
}
// the reply appears whole (temp name, then rename): a client polling every 50 ms never reads it half-written
function reply1(inbox: string, stem: string, reply: string): void {
  const tmp = join(inbox, ".tmp-" + stem); const res = join(inbox, stem + ".res");
  if (dirent(res) || !createOwn(tmp, reply + "\n")) return; // never renamed over an entry that is there
  try { renameSync(tmp, res); } catch (e) { try { unlinkSync(tmp); } catch (e2) { /* gone */ } }
}
let sig = ""; let sigAt = 0;
// the inbox's mtime, -1 = missing, a symlink or not a directory
function dirStat(p: string): number { try { const st = lstatSync(p); return st.isSymbolicLink() || !st.isDirectory() ? -1 : st.mtimeMs; } catch (e) { return -1; } }
function stamp(name: string): number { const m = /^(?:\.tmp-)?(\d{13})-/.exec(name); return m ? Number(m[1] ?? "0") : 0; }
function disable(why: string): number { warn = "single instance off: " + why + " (nothing there was read or removed)"; return -1; }
// server tick: the number of links applied; -1 = something in the inbox is not ours → single instance off (spoolWarn says why)
export function spoolPoll(run: string, now: number, uid: number, info: InfoFn, rate: Rate, apply: (ref: string) => string): number {
  const inbox = join(run, "inbox");
  const d = dirStat(inbox);
  if (d < 0) return disable(inbox + " is not a real directory");
  const names = listDir(inbox).sort();
  const s = String(d) + ":" + names.join("/"); // names too: a rename can keep the mtime (same ms) and the count
  if (s === sig && now - sigAt < 10000) return 0; // nothing new (a full pass every 10 s still cleans stale files)
  sig = s; sigAt = now;
  let n = 0; let seen = 0;
  for (const name of names) {
    const p = join(inbox, name);
    const ml = LINK_RE.exec(name); const mr = RES_RE.exec(name); const mt = TMP_RE.exec(name);
    if (!ml && !mr && !mt) continue; // not ours to judge
    const i = info(p);
    if (!i) continue; // gone meanwhile
    if (i.kind !== "file" || i.uid !== uid) return disable(p + " is " + (i.kind === "link" ? "a symlink" : i.kind === "file" ? "owned by uid " + String(i.uid) : "a " + i.kind));
    const at = stamp(name);
    if (!ml) { if (now - at > STALE) { try { unlinkSync(p); } catch (e) { /* gone */ } } continue; } // orphan reply / abandoned temp
    if (now - at > STALE || at > now + SKEW) { try { unlinkSync(p); } catch (e) { /* gone */ } continue; } // unread
    if (++seen > PER_TICK) break;
    const b = readOwn(p, uid, info, MAX_FILE + 1);
    let reply = "err bad-request";
    if (b && b.length <= MAX_FILE) {
      const r = parseRequest(b);
      if (!r.err) { if (allow(rate, now)) { reply = apply(r.ref); n++; } else reply = "err busy"; }
    }
    reply1(inbox, name.slice(0, -".link".length), reply);
    try { unlinkSync(p); } catch (e) { /* gone */ }
  }
  sig = String(dirStat(inbox)) + ":" + listDir(inbox).sort().join("/"); sigAt = now; // after our own unlinks and replies
  return n;
}
