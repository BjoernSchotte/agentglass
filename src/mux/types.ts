// agentglass — the terminal multiplexer port (tmux, herdr, none): one adapter per multiplexer, as src/platform/ per OS
// SPDX-License-Identifier: Apache-2.0

// one agent's pane as its terminal multiplexer reports it
export interface MuxPane {
  kind: string;   // "tmux" | "herdr" | "none"
  id: string;     // the address the multiplexer takes: tmux "work:1.0", herdr "w7:p1A"; "" for none
  term: string;   // a key that survives moves: herdr terminal_id, tmux the pane tty
  server: string; // herdr API socket path; "" for tmux
  ws: string;     // herdr workspace label ("" unknown / tmux)
  wsId: string;   // herdr workspace id ("" unknown / tmux)
  tab: string;    // herdr tab label ("" unknown / tmux)
  status: string; // herdr agent_status idle|working|blocked|done|unknown; "" = not reported (tmux, none)
  at: number;     // epoch ms the status was read (0 = never)
}
// an agent process (every process of a harness, nested ones too): harness id, tty device ("" none), the pid of its
// outermost agent process (root, = pid for a root)
export interface MuxProc { pid: number; h: string; tty: string; root: number }
// an exact pid ↔ session pair: key "<h>:<id>" or a session file path
export interface MuxLink { pid: number; key: string; path: string }
export interface Mux {
  id: string; label: string;
  present: (now: number) => boolean; // cheap: env, file existence, cached lookups; never spawns
  // slow job: map agent processes to panes; force = re-read now (actions, one-shot commands); known(key, path) = the
  // exact pid agentglass already has for that session (registry, open transcript), 0 none; true = the map changed
  refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number) => boolean;
  paneOf: (pid: number) => MuxPane | null;
  paneOfSession: (key: string, path: string) => MuxPane | null;
  links: () => MuxLink[];
  title: (p: MuxPane, look: number) => string;   // the pane's terminal title, read at most once per look id ("" none)
  status: (p: MuxPane, due: boolean, look: number, now: number) => string; // re-read when due (≤ 1 read per server per look); the last reading otherwise
  send: (p: MuxPane, msg: string) => void;       // shows its own toast(s)
  focus: (p: MuxPane) => void;                   // shows its own toast
  // start a harness in a new pane of this multiplexer (resume of an ended session): false = not possible here (the
  // caller falls back to the in-terminal resume); true = started or failed with its own toast
  start: (h: string, id: string, args: string[], cwd: string, top: string, label: string) => boolean; // id: the session id (names the agent)
}
