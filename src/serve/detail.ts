// agentglass serve — the full detail of a big session (sessions.get, detail full) in a child process: reading a 100 MB
// transcript takes seconds, and serve is one thread — inline it would hold every other request and every push. The
// child is `agentglass session <ref> --format json` (the same object), writing into a file in the 0700 run dir; its
// exit hands the result back. One child per session at a time (callers wait for it), at most two at once.
// SPDX-License-Identifier: Apache-2.0
import { openSync, closeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { type Obj, parse } from "../util/json.ts";
import { randomBytes, hex } from "../util/rand.ts";
import { RUN_DIR } from "../features/palette/rundir.ts";
import { REDACT } from "../features/redact-on.ts";

// smaller: computed inline (well under 0.2 s); AGENTGLASS_DETAIL_INLINE: another limit in bytes (tests: 0 = always a child)
const envInline = process.env["AGENTGLASS_DETAIL_INLINE"];
export const INLINE_BYTES = envInline !== undefined && /^\d+$/.test(envInline) ? Number(envInline) : 8 * 1024 * 1024;
export const MAX_CHILDREN = 2;
export interface Waiter { done: (o: Obj | null, err: string) => void }
const RUN = { n: 0, queue: [] as string[], waiting: new Map<string, Waiter[]>() };

export function detailInChild(ref: string, w: Waiter): void {
  const ws = RUN.waiting.get(ref);
  if (ws) { ws.push(w); return; } // the same session is being read: share it
  RUN.waiting.set(ref, [w]); RUN.queue.push(ref); next();
}
function next(): void {
  while (RUN.n < MAX_CHILDREN && RUN.queue.length) { const ref = RUN.queue.shift() ?? ""; if (ref) start(ref); }
}
function finish(ref: string, o: Obj | null, err: string): void {
  RUN.n--; const ws = RUN.waiting.get(ref) ?? []; RUN.waiting.delete(ref);
  for (const w of ws) w.done(o, err);
  next();
}
function start(ref: string): void {
  RUN.n++;
  try { mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 }); } catch (e) { /* exists */ }
  const f = join(RUN_DIR, "detail-" + hex(randomBytes(6)) + ".json");
  let fd = -1;
  try { fd = openSync(f, "w"); } catch (e) { finish(ref, null, "cannot write " + f); return; }
  const env: Record<string, string> = {}; for (const k of Object.keys(process.env)) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
  env["AGENTGLASS_AGENT"] = "0"; env["AGENTGLASS_REDACT"] = REDACT ? "1" : "0";
  const ch = spawn(process.execPath, ["session", ref, "--format", "json"], { stdio: ["ignore", fd, "ignore"], env });
  closeSync(fd);
  let over = false;
  const end = (why: string): void => {
    if (over) return; over = true;
    let o: Obj | null = null;
    try { o = parse(readFileSync(f, "utf8")); } catch (e) { /* no output */ }
    try { unlinkSync(f); } catch (e) { /* gone */ }
    if (o) o["via"] = "ref";
    finish(ref, o, o ? "" : why);
  };
  ch.on("error", (e: Error) => { end(e.message); });
  ch.on("exit", (code: number | null) => { end("agentglass session exited " + String(code)); });
}
