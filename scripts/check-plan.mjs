// splits scripts/check.sh's jobs across CI shards: node scripts/check-plan.mjs <i> <n> <job>... prints shard i's jobs
// --changed <list> <job>...: the jobs a change reaches (scripts/check.sh --changed; <list>: one changed path per line);
// see changed() below
// A job's weight estimates its build time: the bytes of TypeScript it compiles (the entry and every relative import,
// transitively; 0.97 correlated with measured build times). A test that builds agentglass weighs one src/main.ts per
// "# check: builds <k>" (default 1); other tests are light. "bin" and the tests that use the shared binary stay on
// shard 1.
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const closures = new Map();
function closure(entry) { // entry + its transitive relative imports: their bytes and paths (relative to the repo root)
  const seen = new Set(); const stack = [resolve(entry)]; let bytes = 0;
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    let src; try { src = readFileSync(f, "utf8"); bytes += statSync(f).size; } catch { continue; }
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) stack.push(resolve(dirname(f), m[1]));
  }
  return { bytes, files: new Set([...seen].map((f) => relative(".", f))) };
}
const closureOf = (f) => { if (!closures.has(f)) closures.set(f, closure(f)); return closures.get(f); };
const bytesOf = (f) => closureOf(f).bytes;
const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

// changed(paths, jobs): [job, why] for every job a change reaches, or [["ALL", why]] when the whole suite must run.
// Conservative: when unsure, a job runs. A check is reached when a path in its import closure changed, or one its
// text names (its own and its helpers' outside src/main.ts's closure: fixtures, testdata, specs/…/fixtures — the path,
// its file name, a prefix two directories deep like "testdata/otlp/golden-", or a glob like scripts/*.sh). A shell
// test when it changed, when a path in the closure of what it builds or runs changed (src/main.ts when it uses the
// shared binary, builds or runs scriptc build; every .ts path it names), or when it names a changed path. A path
// that shapes every job (check.sh, this file, check-lock.sh, toolchain.sh, build-info.sh, build.sh, CI) or a non-TS
// file under src/ (ffi.json, libproc.c) runs everything, and so does a changed path no job names (unknown reach),
// unless it is documentation (*.md, docs/, specs/) or TypeScript nothing imports. "bin" runs when a selected test uses
// the shared binary, "release" when src/main.ts's closure changed.
const DOC = /(^|\/)[^/]*\.md$|^docs\/|^specs\/|^LICENSE$|^\.gitignore$/;
function mention(text, c) { // the name under which text refers to changed path c, or ""
  const doc = DOC.test(c), base = c.slice(c.lastIndexOf("/") + 1);
  for (let t of text.match(/[\w.@*-]*(?:\/[\w.@*-]*)+/g) || []) { // path-like words: a/b, "$here"/../c/d, x/*.sh
    while (/^(\/|\.\.?\/)/.test(t)) t = t.replace(/^(\/|\.\.?\/)/, "");
    if (!t) continue;
    if (t.includes("*")) { // a glob under a named directory: scripts/*.sh (not "*.json", nor a comment's "/**")
      if (!/^[^/*]+\//.test(t)) continue;
      const re = new RegExp("(^|/)" + t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*") + "$");
      if (re.test(c)) return t;
    } else if (t === c || (!doc && /^[^/]+\/[^/]+\//.test(t) && c.startsWith(t))) return t; // the path, or a prefix below 2 dirs
  }
  // a file's bare name: a sibling script ("$here/release-lib.sh"); not for docs, whose names are everywhere
  if (!doc && base.length >= 4 && new RegExp("(^|[^\\w.-])" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^\\w.-])").test(text)) return base;
  return "";
}
function changed(paths, jobs) {
  const all = paths.find((c) => /^(build\.sh|scripts\/(check|check-plan|check-lock|toolchain|build-info)\.(sh|mjs)|\.github\/)/.test(c));
  if (all) return [["ALL", all + " changed: it shapes every job"]];
  const odd = paths.find((c) => c.startsWith("src/") && !c.endsWith(".ts"));
  if (odd) return [["ALL", odd + " changed: not TypeScript, its reach is unknown"]];
  const main = closureOf("src/main.ts").files, out = [], reached = new Set();
  const pick = (job, why, c) => { if (!out.some((o) => o[0] === job)) out.push([job, why]); reached.add(c); };
  for (const job of jobs) {
    const f = job.slice(job.indexOf(":") + 1), src = read(f);
    if (job.startsWith("cc:")) { for (const c of paths) if (c === f) pick(job, "changed", c); continue; }
    if (!job.startsWith("check:") && !job.startsWith("test:")) continue;
    let entries, text = src;
    if (job.startsWith("check:")) {
      entries = [f];
      for (const g of closureOf(f).files) if (g !== f && !main.has(g)) text += "\n" + read(g); // its helpers
    } else { // what the test builds or runs: the shared binary / build.sh / scriptc build, and every .ts it names
      entries = /AGENTGLASS_BIN|build\.sh|scriptc build/.test(src) ? ["src/main.ts"] : [];
      for (let t of src.match(/[\w.\/-]+\.ts\b/g) || []) {
        while (/^(\/|\.\.?\/)/.test(t)) t = t.replace(/^(\/|\.\.?\/)/, "");
        if (!entries.includes(t) && read(t)) entries.push(t);
      }
    }
    for (const c of paths) {
      if (c === f) { pick(job, "changed", c); continue; }
      const e = entries.find((e) => closureOf(e).files.has(c));
      if (e === f) pick(job, "imports " + c, c);
      else if (e === "src/main.ts") pick(job, /AGENTGLASS_BIN/.test(src) ? "runs agentglass, built from " + c + " among others" : "builds agentglass, " + c + " among its sources", c);
      else if (e) pick(job, e === c ? "names " + c : "builds " + e + ", which imports " + c, c);
      else { const m = mention(text, c); if (m) pick(job, "names " + m + (m === c ? "" : " (" + c + ")"), c); }
    }
  }
  const lost = paths.find((c) => !reached.has(c) && !DOC.test(c) && !(c.startsWith("src/") && c.endsWith(".ts")) && !main.has(c));
  if (lost) return [["ALL", lost + " changed and no check or test names it: its reach is unknown"]];
  if (jobs.includes("bin") && out.some(([j]) => j.startsWith("test:") && /AGENTGLASS_BIN/.test(read(j.slice(5))))) out.unshift(["bin", "the selected tests run the shared agentglass"]);
  if (jobs.includes("release") && paths.some((c) => main.has(c))) out.unshift(["release", "src/main.ts's closure changed"]);
  return out;
}
if (process.argv[2] === "--changed") {
  const [list, ...jobs] = process.argv.slice(3);
  for (const [job, why] of changed(read(list).split("\n").filter(Boolean), jobs)) console.log(job + "\t" + why);
  process.exit(0);
}

const [i, n, ...jobs] = process.argv.slice(2);
const shard = Number(i), shards = Number(n);
const main = bytesOf("src/main.ts");
function weight(job) {
  if (job === "bin") return main;
  if (job === "release") return main * 2.5; // -O2 takes ~2.5x the -O0 build
  if (job.startsWith("cc:")) return main / 50; // one C file, syntax only
  const f = job.slice(job.indexOf(":") + 1);
  if (job.startsWith("check:")) return bytesOf(f) * (/^\/\/ check: timing/m.test(readFileSync(f, "utf8")) ? 2 : 1); // -O2
  const src = readFileSync(f, "utf8");
  if (/AGENTGLASS_BIN/.test(src)) return main / 50; // runs the shared binary
  if (/build\.sh/.test(src)) return main * Number((src.match(/^# check: builds (\d+)/m) || [0, 1])[1]);
  if (/scriptc build/.test(src)) return main / 10;
  return main / 50;
}
const pinned = (job) => job === "bin" || (job.startsWith("test:") && /AGENTGLASS_BIN/.test(readFileSync(job.slice(5), "utf8")));
// contiguous runs of the jobs sorted by name, cut where the running weight crosses each shard's share: an edit moves only
// the jobs at a boundary, so most jobs keep their shard, and its scriptc build cache, from run to run
const w = new Map(jobs.map((j) => [j, weight(j)]));
const key = (j) => j.slice(j.lastIndexOf("/") + 1) + "\0" + j; // by basename: the heavy tests and "release" spread out
const pins = jobs.filter(pinned), rest = jobs.filter((j) => !pinned(j)).sort((a, b) => (key(a) < key(b) ? -1 : 1));
const share = jobs.reduce((t, j) => t + w.get(j), 0) / shards;
let run = pins.reduce((t, j) => t + w.get(j), 0); // shard 1 starts loaded with the binary and its tests
const mine = shard === 1 ? pins.filter((j) => !j.startsWith("test:")) : [];
for (const j of rest) {
  const s = Math.min(shards - 1, Math.floor((run + w.get(j) / 2) / share)); run += w.get(j);
  if (s === shard - 1) mine.push(j);
}
mine.sort((a, b) => (a === "bin" ? -1 : b === "bin" ? 1 : w.get(b) - w.get(a) || (a < b ? -1 : 1)));
// heaviest first (the shared binary before all); the tests that wait for the shared binary last
console.log(mine.concat(shard === 1 ? pins.filter((j) => j.startsWith("test:")) : []).join("\n"));
