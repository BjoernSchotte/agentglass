// agentglass — which transcript file owns an API message that several files carry (Claude forks, resumes, a session under
// two project dirs, forked subagents): each message is booked once, in the file where it first appeared
// SPDX-License-Identifier: Apache-2.0
// Order of appearance: the copy's timestamp, then a root session before a subagent, then the path. A file that claims an
// earlier copy than the current owner's takes the message over and the owner re-reads its whole log without it
// (OWN.restart), so per-day buckets, tool calls and turns move along. Owned ids live in each Acc (mo, persisted with the
// ledger as text, decoded on first use); the index across files is built from them when a file first claims a message.
import { type Acc, isoMs } from "./record.ts";
import { own } from "../../util/own.ts";

// set by the ledger: its entries, whether a path is still a session (and a subagent's), and how a log is re-read
export const OWN = {
  accs: (): Map<string, Acc> => new Map<string, Acc>(),
  alive: (path: string): boolean => true,
  sub: (path: string): boolean => false,
  restart: (path: string): void => {},
};
interface Own { p: string; t: number }
const LAST = 8640000000000000; // an untimed copy sorts after every timed one
const G = new Map<string, Own>(); let built = false; // id → owner, once built from the entries
const holders = new Set<string>(); let heldAll = false; // paths whose Acc skipped copies (Acc.mc), for reconcile()

// the stored text: "<id>,<ms delta> …" (ids never hold a space or comma; deltas from the previous entry keep it short)
export function moOut(m: Map<string, number>): string {
  const out: string[] = []; let prev = 0;
  for (const [k, t] of m) { if (k.indexOf(" ") >= 0 || k.indexOf(",") >= 0) continue; out.push(k + "," + String(t - prev)); prev = t; }
  return out.join(" ");
}
export function moIn(s: string): Map<string, number> {
  const m = new Map<string, number>(); if (!s) return m;
  let prev = 0;
  for (const e of s.split(" ")) { const i = e.indexOf(","); if (i <= 0) continue; const t = prev + Number(e.slice(i + 1)); if (!(t >= 0)) continue; m.set(e.slice(0, i), t); prev = t; }
  return m;
}
export function mine(a: Acc): Map<string, number> { if (a.mv) { a.mo = moIn(a.mv); a.mv = ""; } return a.mo; }

// (t1, p1) appeared before (t2, p2)
function before(t1: number, p1: string, t2: number, p2: string): boolean {
  if (t1 !== t2) return t1 < t2;
  const s1 = OWN.sub(p1); if (s1 !== OWN.sub(p2)) return !s1;
  return p1 < p2;
}
// the index, built from every entry's owned ids; two entries claiming one id (a cache written mid-takeover): the later re-reads
function index(): Map<string, Own> {
  const g = G; if (built) return g;
  built = true;
  const lose = new Set<string>();
  for (const [p, a] of OWN.accs()) {
    for (const [k, t] of mine(a)) {
      const o = g.get(k);
      if (o && o.p !== p && OWN.alive(o.p)) { if (!before(t, p, o.t, o.p)) { lose.add(p); continue; } lose.add(o.p); }
      g.set(k, { p, t });
    }
  }
  for (const p of lose) OWN.restart(p);
  return g;
}
// true = this file books the message (or prompt) id seen at iso; false = a copy of one another file owns
export function claim(a: Acc, id: string, iso: string): boolean {
  if (a.mc.has(id)) return false; // also an export's scratch Acc, seeded with its log's copies
  if (!id || !a.p) return true; // no path: a fixture or an export's scratch Acc
  const m = mine(a); if (m.has(id)) return true;
  const t = isoMs(iso) || LAST;
  const g = index(); const o = g.get(id);
  if (o && o.p !== a.p && OWN.alive(o.p)) {
    if (!before(t, a.p, o.t, o.p)) { a.mc.set(own(id), o.p); held().add(a.p); return false; }
    OWN.restart(o.p); // this copy is older: the owner so far re-reads without it
  }
  const k = own(id); g.set(k, { p: a.p, t }); m.set(k, t);
  return true;
}
function held(): Set<string> {
  const h = holders; if (heldAll) return h;
  heldAll = true;
  for (const [p, a] of OWN.accs()) if (a.mc.size) h.add(p);
  return h;
}
// files that skipped copies of an owner that is gone re-read: the next copy in order of appearance owns those now
export function reconcile(): void {
  const h = held();
  for (const p of [...h]) {
    const a = OWN.accs().get(p); if (!a || !a.mc.size || !OWN.alive(p)) { h.delete(p); continue; }
    for (const o of a.mc.values()) if (!OWN.alive(o)) { h.delete(p); OWN.restart(p); break; }
  }
}
// an entry dropped because its log was rewritten: what it owned is open again, and whoever skipped it re-reads
export function release(path: string, old: Acc): void {
  if (built) for (const k of mine(old).keys()) { const o = G.get(k); if (o && o.p === path) G.delete(k); }
  for (const [p, a] of OWN.accs()) { if (p === path || !a.mc.size) continue; for (const o of a.mc.values()) if (o === path) { OWN.restart(p); break; } }
}
// checks: start over with an empty index
export function forget(): void { G.clear(); built = false; holders.clear(); heldAll = false; }
