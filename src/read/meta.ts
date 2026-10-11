// agentglass — the read model's meta resource and generation counters (local-web-api §2): gen(resource) moves only when
// what the resource is built from moved, so a client revalidates with one number and serve --stdio patches only then
// SPDX-License-Identifier: Apache-2.0
import { type Obj } from "../util/json.ts";
import { sessions, SG } from "../model/sessions.ts";
import { L } from "../features/usage/record.ts";
import { gitGen } from "../features/vcs/attrib.ts";
import { harnessIds } from "../harness/index.ts";
import { REDACT } from "../features/redact-on.ts";
import { BUILD } from "../build-info.ts";
import { CONTRACT } from "../features/version.ts";
import { teamsMeta } from "./team.ts";

export const PROTO = 1; // agentglass-serve/<n> (docs/cli-contract.md)
// what the resources of this release serve (the command channel, "cmd", arrives with the typed commands)
export const CAPS = ["sessions", "team"];

// the inputs of the sessions rows: the set (SG), the ledger's booked messages (L), git attribution, and per session
// what a row shows from its log and process (size, time, pid, status, flags)
function strHash(h: number, s: string): number { let x = h; for (let i = 0; i < s.length; i++) x = (Math.imul(x, 31) + s.charCodeAt(i)) | 0; return x; }
function sessionsSig(): string {
  let h = 0;
  for (const s of sessions.values()) {
    h = (Math.imul(h, 31) + (s.size | 0)) | 0; h = (Math.imul(h, 31) + (Math.floor(s.mtime) | 0)) | 0; h = (Math.imul(h, 31) + (s.pid | 0)) | 0;
    h = strHash(h, s.status); h = (Math.imul(h, 31) + (s.attention ? 1 : 2)) | 0; h = strHash(h, s.stuck);
  }
  return String(SG.gen) + "/" + String(sessions.size) + "/" + String(L.idx) + "/" + String(L.ver) + "/" + String(gitGen()) + "/" + String(h);
}
const G = new Map<string, number>(); const SIG = new Map<string, string>();
// the resource's generation: 1 on first ask, +1 whenever its inputs differ from the last ask; 0 = no such resource
export function gen(resource: string): number {
  if (resource !== "sessions") return 0;
  const sig = sessionsSig(); const g = G.get(resource) ?? 0;
  if (SIG.get(resource) === sig && g > 0) return g;
  SIG.set(resource, sig); G.set(resource, g + 1);
  return g + 1;
}
// version, contract, protocol, capabilities, privacy, the harnesses this build reads and this machine's teams ({id, name})
export function readMeta(readOnly: boolean): Obj {
  return { version: BUILD.version, contract: CONTRACT, proto: PROTO, caps: CAPS, readOnly, redact: REDACT, harnesses: harnessIds(), teams: teamsMeta() };
}
