// agentglass — agentglass --json --related <session> [--event <id> | --at <iso>] [--minutes N]: the related timeline as JSON
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../../model/types.ts";
import { display } from "../../hooks.ts";
import { sessions, titleOf } from "../../model/sessions.ts";
import { type Found, resolveRef } from "../../model/sessref.ts";
import { sourceOf, window, parseEvents } from "../../harness/index.ts";
import { seekTime } from "../../harness/source.ts";
import { section } from "../../util/config.ts";
import { identOf } from "../query/project.ts";
import { keyShown } from "../repos/cli.ts";
import { ms } from "../callgraph/model.ts";
import { type RelEv, relCfg, fileShown } from "./model.ts";
import { startBuild, stepBuild } from "./build.ts";

export interface RelJson {
  anchor: { session: string; harness: string; t: string; kind: string; text: string };
  project: { key: string; label: string }; from: string; to: string; more: number; capped: boolean; // more/capped: what was not read
  sessions: { id: string; harness: string; title: string; worktree: string }[];
  events: { t: string; session: string | null; harness: string; title: string; kind: string; tool: string; text: string; files: string[]; err: boolean; self: boolean; conflict: { kind: string; with: string[] } | null }[];
}
const WIN = 65536; const SCAN = 1048576;
// one session's events in [from, to) of its cursor
function evsIn(s: Sess, from: number, to: number): { evs: Ev[]; next: number } {
  const src = sourceOf(s.h); const r = src.lines(s, from, to); const evs: Ev[] = [];
  for (const l of r.lines) parseEvents(s.h, l, evs, s);
  return { evs, next: r.next > from ? r.next : to };
}
// the anchor: the event with that id (the call, when a result shares it), else the first event at/after `at`
// (the first event when at lies before it, the last when after), else the session's last event; i -1 = not found
function anchorOf(s: Sess, eventId: string, at: number): { evs: Ev[]; i: number } {
  const src = sourceOf(s.h); const st = src.stat(s); const size = st ? st.size : s.size;
  if (eventId) {
    for (let p = 0; p < size;) { // the whole log in 1 MB windows: an id says nothing about where it is
      const r = evsIn(s, p, Math.min(size, p + window(src, SCAN)));
      for (let i = 0; i < r.evs.length; i++) if (r.evs[i].id === eventId && r.evs[i].kind !== "result") return { evs: r.evs, i };
      for (let i = 0; i < r.evs.length; i++) if (r.evs[i].id === eventId) return { evs: r.evs, i };
      p = r.next;
    }
    return { evs: [], i: -1 };
  }
  if (at > 0) {
    const tsOf = (l: string): number => { const e: Ev[] = []; parseEvents(s.h, l, e, s); for (const x of e) { const t = ms(x.ts); if (t) return t; } return 0; };
    const k = seekTime(s, src, size, at, window(src, WIN), tsOf);
    let last: Ev[] = []; let li = -1;
    for (let p = k.at; p < size;) {
      const r = evsIn(s, p, Math.min(size, p + window(src, SCAN)));
      for (let i = 0; i < r.evs.length; i++) { const t = ms(r.evs[i].ts); if (t && t >= at) return { evs: r.evs, i }; if (t) { last = r.evs; li = i; } }
      p = r.next;
    }
    if (li >= 0) return { evs: last, i: li };
  }
  const r = evsIn(s, src.align(s, Math.max(0, size - window(src, WIN))), size);
  for (let i = r.evs.length - 1; i >= 0; i--) if (ms(r.evs[i].ts)) return { evs: r.evs, i };
  return { evs: r.evs, i: r.evs.length - 1 };
}
function idOf(path: string): string { const s = sessions.get(path); return s ? s.id : ""; }
function wt(s: Sess): string { const id = identOf(s); return id && id.worktree ? display("repo", id.worktree, s) : ""; }
// code 0 ok, 2 usage, 3 not found, 4 ambiguous (err: "harness:id title" per candidate); ok = the agent-mode scope
export function relatedJson(prefix: string, eventId: string, at: string, minutes: number, ok: (s: Sess) => boolean): { code: number; json: string; err: string; hint: string } {
  const f: Found = resolveRef(prefix, false, ok);
  if (!f.s) {
    if (f.code === 4) return { code: 4, json: "", err: f.msg, hint: f.cands.slice(0, 10).map((c: Sess) => c.h + ":" + c.id + " " + titleOf(c)).join("\n") };
    return { code: f.code || 3, json: "", err: f.msg, hint: f.hint };
  }
  const s = f.s as Sess;
  const atMs = at ? Date.parse(at) : 0;
  if (at && !(atMs > 0)) return { code: 2, json: "", err: "--at needs an ISO time like 2026-09-30T14:06:43Z", hint: "" };
  const a = anchorOf(s, eventId, atMs);
  if (a.i < 0) return { code: 3, json: "", err: eventId ? "no event " + eventId + " in session " + s.id : "session " + s.id + " has no events", hint: eventId ? "event ids are the tool call ids --watch prints" : "" };
  const b = startBuild(s, a.evs, a.i, minutes, relCfg(section("related")).conflictMinutes);
  if (!b) return { code: 3, json: "", err: "session " + s.id + " has no timestamps around that event", hint: "" };
  for (let g = 0; g < 100000 && stepBuild(b, 1e12, () => Date.now()); g++) { /* no tick budget in the CLI; the 16 MB cap stays */ }
  const iso = (t: number): string => new Date(t).toISOString();
  const text = (r: RelEv): string => r.kind === "write" && r.files.length ? r.files.map((x) => fileShown(x)).join(" ") : r.text; // writes: the files, repo-relative
  const out: RelJson = {
    anchor: { session: s.id, harness: s.h, t: iso(b.anchor.t), kind: b.anchor.kind, text: text(b.anchor) },
    project: { key: keyShown(b.key), label: b.label }, from: iso(b.t0), to: iso(b.t1), more: b.more, capped: b.capped, sessions: [], events: [],
  };
  for (const p of b.cands) { const c = sessions.get(p); if (c) out.sessions.push({ id: c.id, harness: c.h, title: titleOf(c), worktree: wt(c) }); }
  for (const r of b.rows) {
    const c = r.sess ? sessions.get(r.sess) : undefined;
    const fl = r.mark === "conflict" || r.mark === "overlap" || r.mark === "clobber";
    out.events.push({ t: iso(r.t), session: c ? c.id : null, harness: r.h, title: c ? titleOf(c) : "", kind: r.kind, tool: r.tool, text: text(r),
      files: r.files.map((x) => fileShown(x)), err: r.err, self: r.self, conflict: fl ? { kind: r.mark, with: r.withS.map((p: string) => idOf(p)) } : null });
  }
  return { code: 0, json: JSON.stringify(out), err: "", hint: "" };
}
