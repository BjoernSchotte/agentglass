// agentglass serve — reads that need a log read first (a first full detail of a big session: runsum.ts; a session's
// events: read/events.ts) run in slices between everything else (requests and pushes are not held), then the request
// is answered. One queue, oldest first; every waiter with the same key answers when its read is done.
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import { detailStep } from "../features/queries.ts";
import { saveSums } from "../features/callgraph/runsum.ts";

export const SLICE_MS = 100; export const GAP_MS = 10;
// step(budget ms): read on; true = done
interface Wait { key: string; step: (ms: number) => boolean; done: () => void }
const Q = { list: [] as Wait[], timer: false };
export function whenDone(key: string, step: (ms: number) => boolean, done: () => void): void { Q.list.push({ key, step, done }); arm(); }
// a full detail: the running summary of the session's logs caught up (kept in the cache)
export function whenRead(s: Sess, done: () => void): void { whenDone("detail\t" + s.path, (ms: number): boolean => { const d = detailStep(s, ms); if (d) saveSums(false); return d; }, done); }
function arm(): void { if (Q.timer || !Q.list.length) return; Q.timer = true; setTimeout(step, GAP_MS); }
function step(): void {
  Q.timer = false;
  const w = Q.list[0]; if (!w) return;
  if (w.step(SLICE_MS)) {
    const rest: Wait[] = []; const now: Wait[] = [];
    for (const x of Q.list) (x.key === w.key ? now : rest).push(x);
    Q.list = rest; for (const x of now) x.done();
  }
  arm();
}
