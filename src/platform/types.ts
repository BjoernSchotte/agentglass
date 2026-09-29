// agentglass — platform port: everything OS-specific the app needs; one adapter per OS (darwin.ts, linux.ts, …)
// SPDX-License-Identifier: Apache-2.0

// one row of the process table; cpu as the OS reports it (see Platform.cpuOf), rss in bytes, etime as [[dd-]hh:]mm:ss
export interface ProcRow { pid: number; ppid: number; cpu: number; rss: number; etime: string; tty: string; args: string }

export interface Platform {
  name: string;
  // every process on the machine
  listProcs(): ProcRow[];
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
  // where trash() puts things, for messages ("~/.Trash")
  trashName: string;
}
