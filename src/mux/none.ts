// agentglass — the null multiplexer: an agent in no tmux pane and no herdr agent pane (the reason: index.ts unreachable)
// SPDX-License-Identifier: Apache-2.0
import { say } from "../state.ts";
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";

export const NONE_PANE: MuxPane = { kind: "none", id: "", term: "", server: "", ws: "", wsId: "", tab: "", status: "", at: 0 };
export const none: Mux = {
  id: "none", label: "none",
  present: (now: number): boolean => true,
  refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => false,
  paneOf: (pid: number): MuxPane | null => null,
  paneOfSession: (key: string, path: string): MuxPane | null => null,
  links: (): MuxLink[] => [],
  title: (p: MuxPane, look: number): string => "",
  status: (p: MuxPane, due: boolean, look: number, now: number): string => "",
  // callers that know the agent's pid say why (index.ts unreachable); these are the fallbacks
  send: (p: MuxPane, msg: string): void => { say("warn", "no tmux or herdr agent pane — cannot send safely"); },
  focus: (p: MuxPane): void => { say("warn", "no tmux or herdr agent pane to jump to"); },
  start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => false,
};
