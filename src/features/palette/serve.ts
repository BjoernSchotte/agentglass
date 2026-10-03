// agentglass — single instance, the server side in the TUI: every TUI tries to hold tui.lock at start and again every
// 10 s; the holder polls the spool inbox every 250 ms (a hand-off must answer within the client's 2 s, whatever the
// refresh level) and releases the lock on quit. Config "open": {"singleInstance": false} turns it off.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { S, say } from "../../state.ts";
import { H } from "../../hooks.ts";
import { OS } from "../../platform/index.ts";
import { type FInfo, type InfoFn, RUN_DIR, myUid, secureDir, takeLock, releaseLock } from "./rundir.ts";
import { type Rate } from "./handoff.ts";
import { spoolPoll, spoolWarn } from "./spool.ts";
import { applyLink, flushQueued } from "./apply.ts";
import { singleInstance, isAlive, isOurs } from "./instance.ts";

const info: InfoFn = (p: string): FInfo | null => OS.fileInfo(p);
const st = { on: false, off: false, tried: 0, rate: { at: [] } as Rate };
function off(why: string): void { st.off = true; if (st.on) releaseLock(RUN_DIR, process.pid); st.on = false; say("warn", why); }
function become(now: number): void {
  st.tried = now;
  const uid = myUid();
  try { mkdirSync(dirname(RUN_DIR), { recursive: true }); } catch (e) { /* re-checked below */ }
  const why = secureDir(RUN_DIR, uid, info, true) || secureDir(join(RUN_DIR, "inbox"), uid, info, true);
  if (why) { off("single instance off: " + why + " — links open a new window"); return; }
  const l = takeLock(RUN_DIR, process.pid, uid, info, isAlive, isOurs);
  if (l < 0) { off("single instance off: " + join(RUN_DIR, "tui.lock") + " is not a regular file of yours — links open a new window"); return; }
  st.on = l === 1;
}
function poll(): void {
  if (st.off || !st.on) return;
  const n = spoolPoll(RUN_DIR, Date.now(), myUid(), info, st.rate, (ref: string): string => applyLink(ref, Date.now()));
  if (n < 0) { off(spoolWarn()); return; }
  if (n > 0) { S.dirty = true; for (const f of H.redraw) f(); }
}
H.start.push(() => {
  if (!singleInstance()) { st.off = true; return; }
  become(Date.now());
  setInterval(() => { try { poll(); } catch (e) { /* the timer must survive */ } }, 250);
});
H.onTick.push(() => {
  const was = S.mode;
  flushQueued(); // a link that waited for a dialog
  if (S.mode !== was) S.dirty = true;
  if (!st.off && !st.on && Date.now() - st.tried >= 10000) become(Date.now());
});
H.onQuit.push(() => { if (st.on) releaseLock(RUN_DIR, process.pid); st.on = false; });
