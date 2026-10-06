// agentglass — a remote row (fleet) has no transcript, process or worktree here: one guard for every action that needs them
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "./types.ts";
import { say } from "../state.ts";

// the command that does it on the host (features/fleet/tui.ts: ssh <target> -t <agentglass> open <harness>:<id>)
export const REMOTE = { hint: (s: Sess): string => "" };
// true (and a toast naming the host) when s is a remote row: the caller does nothing
export function remoteOnly(s: Sess | null, what: string): boolean {
  if (!s || !s.host) return false;
  const h = REMOTE.hint(s);
  say("info", "remote session on " + s.host + ": " + what + " needs the host" + (h ? " (" + h + ")" : ""));
  return true;
}
