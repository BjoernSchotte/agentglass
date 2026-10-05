// agentglass — core data types: events, sessions, processes
// SPDX-License-Identifier: Apache-2.0
export type Harness = string; // a registered adapter id (src/harness/index.ts)
export interface Ev { kind: string; text: string; ts: string; id: string; full: string } // id pairs tool call ↔ result; full = untruncated detail ("@file:" = load lazily)
export interface Sess {
  h: Harness; id: string; path: string; cwd: string; title: string; prompt: string; branch: string; model: string;
  remote: string; // git remote, credentials scrubbed (util/giturl.ts scrubRemote); "" = unknown
  mtime: number; size: number; ep: string; headDone: boolean; tailSize: number; evs: Ev[]; pid: number; status: string; name: string; archived: boolean;
  parent: string; kind: string; // subagents: parent session id + agent type/role ("" for top-level sessions)
  subs: Sess[]; last: number; depth: number; // derived per buildView: children, newest mtime across self + children, tree depth
  // filled by feature modules via H.enrich; cost < 0 = unknown, stuck "" = fine
  inTok: number; outTok: number; cacheRTok: number; cacheWTok: number; cost: number;
  unkTok: number; unkCr: number; bill: string; plan: string; billSrc: string; // unpriced tokens / credits; billing mode, plan, evidence source
  tools: number; linesAdd: number; linesDel: number; attention: boolean; stuck: string;
}
export interface Proc {
  pid: number; ppid: number; cpu: number; rss: number; etime: string; tty: string; args: string; h: string;
  start: number; // epoch ms (from etime: a lower bound, up to 1 s early)
  cwd: string; tcpu: number; trss: number; kids: number; sess: string;
}

export function newSess(h: Harness, id: string, path: string, archived: boolean): Sess {
  return {
    h, id, path, cwd: "", title: "", prompt: "", branch: "", model: "", remote: "", mtime: 0, size: 0, ep: "", headDone: false, tailSize: -1, evs: [], pid: 0, status: "", name: "", archived, parent: "", kind: "", subs: [], last: 0, depth: 0,
    inTok: 0, outTok: 0, cacheRTok: 0, cacheWTok: 0, cost: -1, unkTok: 0, unkCr: 0, bill: "", plan: "", billSrc: "", tools: 0, linesAdd: 0, linesDel: 0, attention: false, stuck: "",
  };
}
