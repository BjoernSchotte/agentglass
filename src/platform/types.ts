// agentglass — platform port: everything OS-specific the app needs; one adapter per OS (darwin.ts, linux.ts, …)
// SPDX-License-Identifier: Apache-2.0

// one row of the process table; cpu as the OS reports it (see Platform.cpuOf), rss in bytes, etime as [[dd-]hh:]mm:ss
export interface ProcRow { pid: number; ppid: number; cpu: number; rss: number; etime: string; tty: string; args: string }

export interface FileInfo { uid: number; mode: number; kind: string }

export interface Platform {
  name: string;
  // every process on the machine; tracked = the pids whose cpu/rss the caller needs fresh (harness trees): an adapter
  // that reads incrementally (Linux /proc) re-reads those every call and the rest only when new or on a periodic full pass
  listProcs(tracked: Set<number>): ProcRow[];
  // recent cpu% of a process (not a lifetime average) given the cpu listProcs reported; called once per refresh for each process shown
  cpuOf(pid: number, reported: number, now: number): number;
  // drop per-process state of pids that are gone
  prune(alive: (pid: number) => boolean): void;
  // cwd per pid and the pid holding each open file for which want(path) is true
  procFiles(pids: number[], want: (path: string) => boolean): { cwd: Map<number, string>; open: Map<string, number> };
  // the tty's device path as tmux reports pane_tty, "" when the process has none
  ttyDevice(tty: string): string;
  // native clipboard commands to try in order (text on stdin); tmux and OSC 52 are tried after them
  clipboardCmds(): string[][];
  // best-effort desktop notification
  notify(title: string, subtitle: string, msg: string): void;
  // the user's full name as the OS knows it, "" if unknown
  fullName(): string;
  // move a file or directory to the desktop trash (restorable there); throws on failure
  trash(path: string): void;
  // SHA-256 of a file as lowercase hex, "" when it cannot be read
  sha256File(path: string): string;
  // a process's raw environment block (NAME=value\0…), empty when unreadable or unsupported; callers keep names only (billing.ts envSummary)
  envOf(pid: number): Uint8Array;
  // [owner uid, permission bits] of a file, [] when it cannot be read (scriptc: Stats has no uid/mode)
  ownerMode(path: string): number[];
  // the entry itself (lstat semantics: a symlink is "link"), via the stat CLI (scriptc: Stats has no uid/mode); null = missing.
  // kind: dir | file | socket | link | fifo | other; mode = permission bits
  fileInfo(path: string): FileInfo | null;
  // the uid that owns a process, -1 when it is gone or cannot be told
  procOwner(pid: number): number;
  // where trash() puts things, for messages ("~/.Trash")
  trashName: string;
}
