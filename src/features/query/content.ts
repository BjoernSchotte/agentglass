// agentglass — the `content` filter key: full-text search of transcripts (rg, grep fallback, HarnessAdapter.search)
// SPDX-License-Identifier: Apache-2.0
// One result set per query. It grows incrementally: sessions not searched yet (new ones, or candidates outside an earlier
// narrowed search) are searched on demand; already searched files are not searched again until the query is re-applied.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { run } from "../../util/fs.ts";
import { sessions } from "../../model/sessions.ts";
import { HARNESSES, sourceOf } from "../../harness/index.ts";
import { FILE_SOURCE } from "../../harness/source.ts";

interface Hit { paths: Set<string>; searched: Set<string>; roots: boolean; dbN: number; timedOut: boolean }
const hits = new Map<string, Hit>();
const NARROW = 200; // candidates up to this many: rg gets those files instead of the harness roots

function rg(q: string, targets: string[], glob: boolean): { out: string; timedOut: boolean } {
  const t0 = Date.now();
  const args = ["-l", "-i", "-F"].concat(glob ? ["--glob", "*.jsonl"] : []).concat(["--", q]).concat(targets);
  const r = spawnSync("rg", args, { encoding: "utf8", timeout: 30000 });
  if (r.error) {
    if (Date.now() - t0 >= 29000) return { out: "", timedOut: true };
    return { out: run("grep", ["-rilF"].concat(glob ? ["--include=*.jsonl"] : []).concat(["--", q]).concat(targets)), timedOut: false };
  }
  return { out: r.stdout ?? "", timedOut: false };
}
function addLines(h: Hit, out: string): void { for (const l of out.split("\n")) if (l.length > 0) h.paths.add(l); }
// sessions whose transcripts contain q (case-insensitive); cands = the sessions the other clauses leave (null = all)
export function contentSet(q: string, cands: string[] | null): { paths: Set<string>; timedOut: boolean } {
  let h = hits.get(q);
  if (!h) { h = { paths: new Set<string>(), searched: new Set<string>(), roots: false, dbN: -1, timedOut: false }; hits.set(q, h); }
  if (h.timedOut) return { paths: new Set<string>(), timedOut: true };
  const files: string[] = []; let db = 0;
  for (const s of sessions.values()) {
    if (sourceOf(s.h) !== FILE_SOURCE) { db++; continue; }
    if (!h.searched.has(s.path)) files.push(s.path);
  }
  const cs = new Set<string>(cands ?? []);
  const want = cands ? files.filter((p: string) => cs.has(p)) : files;
  if (!h.roots && (!cands || want.length > NARROW)) { // the first wide search: every root at once (also finds files the scan has not listed yet)
    const dirs: string[] = [];
    for (const ad of HARNESSES) for (const d of ad.roots()) if (existsSync(d)) dirs.push(d);
    const r = rg(q, dirs, true);
    if (r.timedOut) { h.timedOut = true; return { paths: new Set<string>(), timedOut: true }; }
    addLines(h, r.out); h.roots = true;
    for (const p of files) h.searched.add(p);
  } else if (want.length) { // new sessions, or a narrow candidate set: just those files
    for (let i = 0; i < want.length; i += 200) {
      const part = want.slice(i, i + 200);
      const r = rg(q, part, false);
      if (r.timedOut) { h.timedOut = true; return { paths: new Set<string>(), timedOut: true }; }
      addLines(h, r.out);
      for (const p of part) h.searched.add(p);
    }
  }
  if (db !== h.dbN) { // database-backed sessions (OpenCode): the adapter searches itself; again when their number changes
    h.dbN = db;
    for (const ad of HARNESSES) { const se = ad.search; if (se) for (const p of se(q)) h.paths.add(p); }
  }
  return { paths: h.paths, timedOut: false };
}
// has q been searched before (typing never starts a search: only applying the filter does)
export function contentKnown(q: string): boolean { return hits.has(q); }
// re-applying a query (enter in / or F) searches afresh
export function contentForget(q: string): void { hits.delete(q); }
