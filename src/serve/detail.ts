// agentglass serve — full session details that need reading first: a log the running summary has not caught up with
// (runsum.ts: a first ask of a big session) is read in slices between everything else (requests and pushes are not
// held), then the request is answered; later asks read only what was appended and answer at once.
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import { detailStep } from "../features/queries.ts";
import { saveSums } from "../features/callgraph/runsum.ts";

export const SLICE_MS = 100; export const GAP_MS = 10;
interface Wait { s: Sess; done: () => void }
const Q = { list: [] as Wait[], timer: false };
export function whenRead(s: Sess, done: () => void): void { Q.list.push({ s, done }); arm(); }
function arm(): void { if (Q.timer || !Q.list.length) return; Q.timer = true; setTimeout(step, GAP_MS); }
function step(): void {
  Q.timer = false;
  const w = Q.list[0]; if (!w) return;
  if (detailStep(w.s, SLICE_MS)) { // caught up: every waiter for this session answers
    const rest: Wait[] = []; const now: Wait[] = [];
    for (const x of Q.list) (x.s.path === w.s.path ? now : rest).push(x);
    Q.list = rest; for (const x of now) x.done();
    saveSums(false);
  }
  arm();
}
