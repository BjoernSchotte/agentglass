// splits scripts/check.sh's jobs across CI shards: node scripts/check-plan.mjs <i> <n> <job>... prints shard i's jobs
// A job's weight estimates its build time: the bytes of TypeScript it compiles (the entry and every relative import,
// transitively; 0.97 correlated with measured build times). A test that builds agentglass weighs one src/main.ts per
// "# check: builds <k>" (default 1); other tests are light. "bin" and the tests that use the shared binary stay on
// shard 1.
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [i, n, ...jobs] = process.argv.slice(2);
const shard = Number(i), shards = Number(n);
const closures = new Map();
function closure(entry) { // bytes of entry + its transitive relative imports
  const seen = new Set(); const stack = [resolve(entry)]; let bytes = 0;
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    let src; try { src = readFileSync(f, "utf8"); bytes += statSync(f).size; } catch { continue; }
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) stack.push(resolve(dirname(f), m[1]));
  }
  return bytes;
}
const bytesOf = (f) => { if (!closures.has(f)) closures.set(f, closure(f)); return closures.get(f); };
const main = bytesOf("src/main.ts");
function weight(job) {
  if (job === "bin") return main;
  if (job === "release") return main * 2.5; // -O2 takes ~2.5x the -O0 build
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
