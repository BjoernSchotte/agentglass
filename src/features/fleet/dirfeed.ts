// agentglass — a `dir` host on the viewer (fleet spec 15.3): the newest base of a drop directory, then the contiguous
// chain of deltas on it. A gap (a delta not synced yet, files arriving out of order) waits; a chain that does not close
// for an hour stays at its last complete state and says so. Only files owned by this user and not group- or
// world-writable are opened (a shared folder can be written by others); at most one file is decompressed per poll
// SPDX-License-Identifier: Apache-2.0
import { gunzipSync } from "node:zlib";
import { readBytes } from "../../util/fs.ts";
import { HOME } from "../../util/fs.ts";
import { join, resolve } from "node:path";
import { OS } from "../../platform/index.ts";
import type { FileInfo } from "../../platform/types.ts";
import { myUid } from "../palette/rundir.ts";
import type { HostCfg, FleetCfg } from "./config.ts";
import { type HostFeed, type HostReport, type FeedState, newFeedState } from "./model.ts";
import { type Snap, newSnapParse, feedSnap, applySnap } from "./snap.ts";
import { type DropFile, dropFiles } from "./drop.ts";
import { DIR_EVERY } from "./hosts.ts";

export const MAX_UNZIP = 268435456; // 256 MB decoded: a bigger file in a shared folder is refused unread (a zip bomb)
export const GAP_MS = 3600000; export const LIST_MS = 5000;
export const DIRTEST = { info: (p: string): FileInfo | null => OS.fileInfo(p), uid: (): number => myUid() };
function expand(p: string): string { return p.startsWith("~/") ? join(HOME, p.slice(2)) : resolve(p); }
// "" = safe to read; else why not
export function unsafe(path: string): string {
  const i = DIRTEST.info(path); if (!i) return "cannot stat";
  if (i.kind !== "file") return "not a regular file";
  if (i.uid !== DIRTEST.uid()) return "owned by another user (uid " + String(i.uid) + ")";
  if ((i.mode & 0o022) !== 0) return "group- or world-writable";
  return "";
}
// a drop file decoded into one snapshot; null with why
export function readDrop(path: string): { x: Snap | null; err: string } {
  const why = unsafe(path); if (why) return { x: null, err: why };
  const b = readBytes(path, 0, MAX_UNZIP);
  if (b.length < 18) return { x: null, err: "too short" };
  const n = b.length; const isize = ((b[n - 4] ?? 0) | ((b[n - 3] ?? 0) << 8) | ((b[n - 2] ?? 0) << 16)) + (b[n - 1] ?? 0) * 16777216;
  if (isize > MAX_UNZIP) return { x: null, err: "decodes to more than 256 MB" };
  let text = "";
  try { text = new TextDecoder("utf-8").decode(gunzipSync(b)); } catch (e) { return { x: null, err: "not gzip" }; }
  const p = newSnapParse(); feedSnap(p, text.split("\n"));
  if (!p.done) return { x: null, err: p.err || "incomplete snapshot" };
  return { x: p, err: "" };
}
export interface DirFeed extends HostFeed { files(): DropFile[]; refused(): string }
// the feed of a dir host; lines = 0: a CLI run (every pending file at once), else one file per poll
export function dirFeed(h: HostCfg, f: FleetCfg, lines: number): DirFeed {
  const dir = expand(h.path); const st: FeedState = newFeedState();
  const S0 = { rep: null as HostReport | null, gen: "", base: "", n0: 0, n: 0, listAt: 0, files: [] as DropFile[], stuckAt: 0, id: "", bad: new Map<string, string>() };
  const fail = (code: string, msg: string): void => { st.code = code; st.err = msg; };
  const step = (now: number): boolean => { // one file; true = something applied
    const fs = S0.files; if (!fs.length) return false;
    let base: DropFile | null = null; for (const x of fs) if (x.base && !S0.bad.has(x.name)) base = x;
    if (!base) return false;
    if (base.gen !== S0.base) { // a newer base: start over from it
      const r = readDrop(join(dir, base.name));
      if (!r.x || !r.x.full) { S0.bad.set(base.name, r.err || "not a full snapshot"); fail("refused", base.name + ": " + (r.err || "not a full snapshot")); return false; }
      const ev = r.x.head["every"]; if (typeof ev === "number") DIR_EVERY.set(h.name, ev as number);
      S0.rep = applySnap(null, r.x); S0.gen = r.x.gen; S0.base = base.gen; S0.n0 = typeof r.x.head["n"] === "number" ? r.x.head["n"] as number : 0; S0.n = S0.n0; S0.stuckAt = 0;
      st.report = S0.rep; st.okAt = base.at; st.code = "ok"; st.err = "";
      return true;
    }
    // the next delta in sequence; a later one without it is a gap: wait
    let next: DropFile | null = null; let later = false;
    for (const x of fs) { if (x.base || x.id !== S0.id || S0.bad.has(x.name)) continue; if (x.n === S0.n + 1) next = x; else if (x.n > S0.n + 1) later = true; }
    if (!next) {
      if (later) { if (!S0.stuckAt) S0.stuckAt = now; if (now - S0.stuckAt > GAP_MS) fail("gap", "chain incomplete: delta " + String(S0.n + 1) + " missing since " + new Date(S0.stuckAt).toISOString() + " — showing the state before it"); }
      return false;
    }
    const r = readDrop(join(dir, next.name));
    if (!r.x) { S0.bad.set(next.name, r.err); fail("refused", next.name + ": " + r.err); return false; }
    if (r.x.full || r.x.base !== S0.gen) { S0.bad.set(next.name, "another chain"); return false; } // a writer that lost its state starts a new base
    S0.rep = applySnap(S0.rep, r.x); S0.gen = r.x.gen; S0.n = next.n; S0.stuckAt = 0;
    st.report = S0.rep; st.okAt = next.at; st.code = "ok"; st.err = "";
    return true;
  };
  const feed: DirFeed = {
    kind: "dir",
    start: (t: number): boolean => false, // nothing to spawn: the sync tool brings the files
    poll(now: number): FeedState {
      if (now - S0.listAt >= LIST_MS || lines <= 0) {
        S0.listAt = now;
        let all = dropFiles(dir, "");
        if (!all.length) { if (!st.report) fail("none", "no snapshots in " + h.path + " yet (agentglass fleet drop " + h.path + " on the host)"); S0.files = []; return st; }
        // one writer per directory: the host of the newest base (another id's files are named in the status)
        let id = ""; for (const x of all) if (x.base) id = x.id;
        if (!id) id = (all[all.length - 1] as DropFile).id;
        S0.id = id; const other = all.some((x: DropFile) => x.id !== id);
        all = all.filter((x: DropFile) => x.id === id);
        S0.files = all;
        if (other && st.code === "ok") st.err = "files of another host in " + h.path + " are ignored";
      }
      if (lines <= 0) { for (let i = 0; i < 100000 && step(now); i++) { /* every pending file */ } }
      else step(now);
      if (st.code === "ok" && !st.err) { const why = feed.refused(); if (why) st.err = "ignored " + why; } // the state stands; fleet status names the file
      return st;
    },
    stop: (): void => {},
    files: (): DropFile[] => S0.files,
    refused: (): string => { for (const [n, why] of S0.bad) if (why !== "another chain") return n + ": " + why; return ""; },
  };
  return feed;
}
