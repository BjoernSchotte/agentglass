// agentglass — the live stream on the viewer (fleet spec 16.2): one detached `ssh … fleet watch` per host appending to
// <fleet dir>/<k>.watch.jsonl (over the shared connection); the tick tails the file with a byte cursor, ≤ 256 lines
// per poll. Restarted with backoff when it ends; rotated at 16 MB; killed on quit
// SPDX-License-Identifier: Apache-2.0
import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { readLines } from "../../util/fs.ts";
import { type Obj, obj, str, parse } from "../../util/json.ts";
import type { HostCfg } from "./config.ts";
import type { LiveRow } from "./model.ts";
import { ensureDir, fleetDir, spoolPath } from "./store.ts";
import { sshOpts, sshBin, q } from "./ssh.ts";

export const WATCH_MAX = 16777216; export const LIVE_FRESH_MS = 90000;
const BACK0 = 5000; const BACK_MAX = 300000; const LINES = 256;
// what one poll read: new session states, alert transitions (key, rule, severity, state, message, at), turn ends (keys)
export interface WatchEv { rows: LiveRow[]; alerts: Obj[]; turns: string[] }
export interface WatchFeed { start(now: number): boolean; poll(now: number): WatchEv; beatAt(): number; running(): boolean; stop(): void }
// the remote words: fleet watch [--redact]
export function watchArgs(h: HostCfg, redact: boolean, cp: string): string[] {
  const a = sshOpts(cp).concat(["--", h.ssh, q(h.agentglass), q("fleet"), q("watch")]);
  if (redact) a.push(q("--redact"));
  return a;
}
// the fixed snippet (paths and argv as positional parameters, as the pull's): the stream appends to the spool file, and
// ends within 5 s of the viewer (pid v) going away however it went (a closed terminal, a kill): no stream outlives it
export const WATCH_SNIPPET = [
  "umask 077",
  "d=$1; k=$2; v=$3; shift 3",
  "\"$@\" >> \"$d/$k.watch.jsonl\" 2>> \"$d/$k.watch.err\" & c=$!",
  "trap 'kill $c 2>/dev/null; exit 0' TERM INT HUP",
  "while kill -0 \"$v\" 2>/dev/null && kill -0 $c 2>/dev/null; do sleep 5; done",
  "kill $c 2>/dev/null; wait $c 2>/dev/null",
].join("\n");
function num(v: unknown): number { return typeof v === "number" ? v as number : 0; }
// one line of the stream → into ev; beat/hello times (the host's clock) are not used: the viewer's clock at reading is
export function feedWatch(ev: WatchEv, line: string, now: number): boolean {
  const o = parse(line); if (!o) return false;
  const l = obj(o["live"]);
  if (l) { const k = str(l["key"]); if (k) ev.rows.push({ key: k, at: now, live: l["live"] === true, busy: l["busy"] === true, attention: l["attention"] === true, approval: l["approval"] === true, stuck: str(l["stuck"]), alerts: [] }); return true; }
  const a = obj(o["alert"]); if (a) { if (str(a["key"])) ev.alerts.push(a); return true; }
  const t = obj(o["turn"]); if (t) { const k = str(t["key"]); if (k) ev.turns.push(k); return true; }
  return o["beat"] !== undefined || o["hello"] !== undefined;
}
function sizeOf(p: string): number { try { return statSync(p).size; } catch (e) { return -1; } }
function alive(pid: number): boolean { if (pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return String(e).indexOf("EPERM") >= 0; } }
// k: the host's spool key (keyOf: .r when redacted); spawn = detachedPid (a stub in checks)
export function watchFeed(h: HostCfg, k: string, redact: boolean, cp: string, spawn: (cmd: string, args: string[]) => number): WatchFeed {
  const file = spoolPath(k, "watch.jsonl");
  const w = { pid: 0, off: -1, beat: 0, next: 0, back: 0, startedAt: 0 };
  const kill = (): void => {
    if (!w.pid) return;
    try { process.kill(-w.pid, "SIGTERM"); } catch (e) { try { process.kill(w.pid, "SIGTERM"); } catch (e2) { /* gone */ } }
    w.pid = 0;
  };
  const fd: WatchFeed = {
    start(now: number): boolean {
      if (w.pid || now < w.next) return false;
      if (ensureDir()) return false;
      const b = sshBin(); if (!b) return false;
      // a fresh file per stream: what an earlier stream left is old state
      try { writeFileSync(file, "", { mode: 0o600 }); } catch (e) { return false; }
      w.off = 0;
      const pid = spawn("sh", ["-c", WATCH_SNIPPET, "sh", fleetDir(), k, String(process.pid), b].concat(watchArgs(h, redact, cp)));
      if (pid <= 0) { w.next = now + BACK0; return false; }
      w.pid = pid; w.startedAt = now;
      return true;
    },
    poll(now: number): WatchEv {
      const ev: WatchEv = { rows: [], alerts: [], turns: [] };
      if (w.off >= 0) {
        const sz = sizeOf(file);
        if (sz > w.off) {
          const r = readLines(file, w.off, Math.min(sz, w.off + 4194304), false);
          let n = 0; let next = w.off;
          // ≤ LINES per poll: the rest waits for the next tick (offsets follow the lines taken)
          let at = w.off;
          const ls = r.lines; if (ls.length && ls[ls.length - 1] === "") ls.pop(); // the text ends with its newline
          for (const l of ls) { if (n >= LINES) break; at += new TextEncoder().encode(l).length + 1; n++; if (feedWatch(ev, l, now)) w.beat = now; next = at; }
          w.off = next;
        }
        if (sz > WATCH_MAX) { kill(); w.next = now; } // rotate: the next start truncates the file
      }
      if (w.pid && !alive(w.pid)) { // the stream ended (link down, host rebooted): back off, then again
        w.pid = 0;
        const ranLong = now - w.startedAt > 60000;
        w.back = ranLong ? BACK0 : Math.min(BACK_MAX, w.back ? w.back * 2 : BACK0);
        w.next = now + w.back;
      }
      return ev;
    },
    beatAt: (): number => w.beat,
    running: (): boolean => w.pid > 0,
    stop(): void { kill(); try { unlinkSync(spoolPath(k, "watch.pid")); } catch (e) { /* none */ } },
  };
  return fd;
}
