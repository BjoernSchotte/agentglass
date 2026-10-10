// agentglass — the team mailbox (fleet-teams spec 4): where sealed files meet. Phase 1 is a folder a sync tool shares
// (Syncthing, Dropbox, iCloud Drive, NFS, an rsync target). Only the layout's names exist for it: whatever else a sync
// tool, an editor or another user leaves there (conflict copies, tmp files, symlinks) is never listed or read. Writes
// are tmp + rename, so a synced copy is whole or absent. Authenticity comes from the signatures, not from the folder.
// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readBytes } from "../../util/fs.ts";
import { writeBin } from "../../util/gzip.ts";
import { OS } from "../../platform/index.ts";
import { myUid } from "../palette/rundir.ts";

export interface MbFile { name: string; size: number; at: number }
export interface Mailbox { kind: string; list: (dir: string) => MbFile[]; get: (path: string, max: number) => Uint8Array | null; put: (path: string, b: Uint8Array) => string; del: (path: string) => string; problem: () => string }
const H = "[0-9a-f]{16}";
// manifest/<version>-<signer>.agm: two admins writing one version at once make two files (a sync tool would turn one
// name into a conflict copy); the reader keeps the higher signer id (manifest.ts)
export const NAMES = {
  discovery: /^agentglass-team\.json$/,
  manifest: new RegExp("^manifest/(\\d{1,9})-(" + H + ")\\.agm$"),
  invite: new RegExp("^invites/(" + H + ")\\.card$"),
  join: new RegExp("^join/(" + H + ")-(" + H + ")\\.req$"),
  welcome: new RegExp("^welcome/(" + H + ")-(" + H + ")\\.key$"),
  key: new RegExp("^keys/(" + H + ")/(\\d{1,9})/(" + H + ")\\.key$"),
  room: new RegExp("^rooms/(" + H + ")/(" + H + ")-(" + H + ")\\.(base|delta-(\\d{1,9}))-(" + H + ")\\.agt$"),
  leave: new RegExp("^leave/(" + H + ")\\.tomb$"),
  name: new RegExp("^names/(" + H + ")\\.name$"),
  activity: new RegExp("^activity/(" + H + ")-(\\d{1,9})\\.act$"),
};
function layout(p: string): boolean {
  return NAMES.discovery.test(p) || NAMES.manifest.test(p) || NAMES.invite.test(p) || NAMES.join.test(p) || NAMES.welcome.test(p) || NAMES.key.test(p)
    || NAMES.room.test(p) || NAMES.leave.test(p) || NAMES.name.test(p) || NAMES.activity.test(p);
}
// a room file's name (in rooms/<room>/): <member>-<device>.base-<gen>.agt or .delta-<n>-<gen>.agt
export interface RoomFile { name: string; member: string; device: string; base: boolean; n: number; gen: string }
const ROOM_FILE = new RegExp("^(" + H + ")-(" + H + ")\\.(base|delta-(\\d{1,9}))-(" + H + ")\\.agt$");
export function roomFile(name: string): RoomFile | null {
  const m = ROOM_FILE.exec(name); if (!m) return null;
  return { name, member: m[1] ?? "", device: m[2] ?? "", base: m[3] === "base", n: m[4] ? Number(m[4]) : -1, gen: m[5] ?? "" };
}
// a regular file of ours that others cannot write (lstat: a symlink is never followed); size, mtime, or null
function regular(p: string): MbFile | null {
  try { const s = lstatSync(p); if (s.isSymbolicLink() || !s.isFile()) return null; return { name: p, size: s.size, at: s.mtimeMs }; } catch (e) { return null; }
}
export function dirMailbox(root: string): Mailbox {
  return {
    kind: "dir",
    list: (dir: string): MbFile[] => {
      const out: MbFile[] = []; if (!/^[a-z]+(\/[0-9a-f]{16}(\/\d{1,9})?)?$/.test(dir)) return out;
      let ns: string[] = []; try { ns = readdirSync(join(root, dir)); } catch (e) { return out; }
      ns.sort();
      for (const n of ns) { if (!layout(dir + "/" + n)) continue; const f = regular(join(root, dir, n)); if (f) out.push({ name: n, size: f.size, at: f.at }); }
      return out;
    },
    get: (path: string, max: number): Uint8Array | null => {
      if (!layout(path)) return null;
      const p = join(root, path); const f = regular(p); if (!f || f.size > max) return null;
      const i = OS.fileInfo(p); if (!i || i.kind !== "file" || i.uid !== myUid() || (i.mode & 0o022) !== 0) return null; // as dirfeed.ts: a first filter
      const b = readBytes(p, 0, max); return b.length === f.size ? b : null;
    },
    put: (path: string, b: Uint8Array): string => {
      if (!layout(path)) return "not a mailbox name: " + path;
      const p = join(root, path); const d = p.slice(0, p.lastIndexOf("/"));
      try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (e) { return "cannot create " + d; }
      const tmp = join(d, "." + p.slice(p.lastIndexOf("/") + 1) + "." + String(process.pid) + ".tmp");
      if (!writeBin(tmp, b)) return "cannot write " + tmp;
      try { renameSync(tmp, p); return ""; } catch (e) { try { unlinkSync(tmp); } catch (e2) { /* gone */ } return "cannot rename into " + p; }
    },
    del: (path: string): string => {
      if (!layout(path)) return "not a mailbox name: " + path;
      try { unlinkSync(join(root, path)); } catch (e) { /* already gone */ }
      return "";
    },
    problem: (): string => {
      try { const s = lstatSync(root); if (!s.isDirectory()) return root + " is not a directory"; } catch (e) { return root + " does not exist (is the sync folder mounted?)"; }
      return "";
    },
  };
}
