// agentglass — one member device's stream in one room (fleet-teams spec 9): its sealed files in rooms/<room>/, a chain
// as fleet's drop (a base, deltas in sequence), each file opened with the manifest and the epoch keys this machine holds.
// The sealed header must name what the file's name says (room, member, device, kind, sequence, generation): a renamed
// or moved file is refused, not applied out of order.
// SPDX-License-Identifier: Apache-2.0
import { type HostReport, type FeedState, newFeedState } from "../fleet/model.ts";
import { type Snap, newSnapParse, feedSnap } from "../fleet/snap.ts";
import { type DropFile } from "../fleet/drop.ts";
import { type Chain, newChain, chainStep } from "../fleet/dirfeed.ts";
import { roomKey } from "./keys.ts";
import { roomFile } from "./mailbox.ts";
import { openFile, OPEN_MAX } from "./sealed.ts";
import { type TeamState, mbOf } from "./state.ts";

export const LIST_MS = 5000;
export interface TeamFeed { kind: string; room: string; member: string; device: string; chain: Chain; st: FeedState; listAt: number; at: number /* newest file's mtime */ }
export function teamFeed(room: string, member: string, device: string): TeamFeed {
  const c = newChain(); c.id = device;
  return { kind: "team", room, member, device, chain: c, st: newFeedState(), listAt: 0, at: 0 };
}
function readTeam(t: TeamState, f: TeamFeed, d: DropFile): { x: Snap | null; err: string } {
  const m = t.manifest; if (!m) return { x: null, err: "no manifest" };
  const b = mbOf(t).get("rooms/" + f.room + "/" + d.name, OPEN_MAX); if (!b) return { x: null, err: "unreadable (not a regular file of ours, or over 256 MB)" };
  const o = openFile(b, m, (r: string, e: number) => roomKey(t.id, r, e)); const h = o.h;
  if (!h || !o.plain) return { x: null, err: o.err };
  if (h.room !== f.room || h.member !== f.member || h.device !== f.device || (h.kind === "base") !== d.base || h.gen !== d.gen || (!d.base && h.n !== d.n)) return { x: null, err: "the sealed header does not match the file name" };
  const p = newSnapParse(); feedSnap(p, new TextDecoder("utf-8").decode(o.plain).split("\n"));
  if (!p.done) return { x: null, err: p.err || "incomplete snapshot" };
  return { x: p, err: "" };
}
// lines 0: every pending file now (a CLI run); else one file per call (the TUI's slices)
export function pollFeed(t: TeamState, f: TeamFeed, now: number, lines: number): HostReport | null {
  if (now - f.listAt >= LIST_MS || lines <= 0) {
    f.listAt = now; const fs: DropFile[] = [];
    for (const x of mbOf(t).list("rooms/" + f.room)) {
      const r = roomFile(x.name); if (!r || r.member !== f.member || r.device !== f.device) continue;
      fs.push({ name: x.name, id: f.device, base: r.base, n: r.n, gen: r.gen, at: x.at, size: x.size });
      if (x.at > f.at) f.at = x.at;
    }
    fs.sort((a: DropFile, b: DropFile) => a.at - b.at || a.n - b.n);
    f.chain.files = fs;
  }
  const read = (d: DropFile): { x: Snap | null; err: string } => readTeam(t, f, d);
  if (lines <= 0) { for (let i = 0; i < 100000 && chainStep(f.chain, f.st, read, now); i++) { /* every pending file */ } }
  else chainStep(f.chain, f.st, read, now);
  return f.st.report;
}
