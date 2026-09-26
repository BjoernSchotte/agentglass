// agentglass — harness dispatch: one log line → events, and the per-harness CLI invocations
// SPDX-License-Identifier: Apache-2.0
import { str, parse } from "../util/json.ts";
import type { Ev, Sess, Harness } from "../model/types.ts";
import { parseClaude, claudeHeadless, claudeResume } from "./claude.ts";
import { parseCodex, codexHeadless, codexResume } from "./codex.ts";
import { parseFx, fxHeadless, fxResume } from "./fx.ts";

export function parseEvents(h: Harness, line: string, out: Ev[], s: Sess | null): void {
  const o = parse(line);
  if (!o) return;
  if (h === "fx") { parseFx(o, out, s ? s.path : ""); return; }
  const ts = str(o["timestamp"]);
  const type = str(o["type"]);
  if (h === "claude") parseClaude(o, ts, type, out, s);
  else parseCodex(o, ts, type, out, s);
}
// the user's claude/codex are often shell functions: AGENTGLASS_<HARNESS> overrides the command
export function cmdOf(h: Harness): string[] {
  const env = h === "claude" ? process.env.AGENTGLASS_CLAUDE : h === "codex" ? process.env.AGENTGLASS_CODEX : process.env.AGENTGLASS_FX;
  const cmd: string = env !== undefined ? env : h;
  return cmd.split(" ").filter((x) => x.length > 0);
}
export function headlessArgs(h: Harness, id: string, msg: string): string[] { return h === "claude" ? claudeHeadless(id, msg) : h === "codex" ? codexHeadless(id, msg) : fxHeadless(id, msg); }
export function resumeArgs(h: Harness, id: string): string[] { return h === "claude" ? claudeResume(id) : h === "codex" ? codexResume(id) : fxResume(id); }
