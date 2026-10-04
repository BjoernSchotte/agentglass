// splits scripts/check.sh's jobs across CI shards: node scripts/check-plan.mjs <i> <n> <job>... prints shard i's jobs
// A job's weight estimates its build time: the bytes of TypeScript it compiles (the entry and every relative import,
// transitively; 0.97 correlated with measured build times). A test that builds agentglass weighs one src/main.ts per
// "# check: builds <k>" (default 1); other tests are light. Greedy, heaviest first onto the least loaded shard (ties: lowest shard, then name), so the split is
// deterministic and only moves when sources do. "bin" and the tests that use the shared binary stay on shard 1.
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
  if (job === "bin" || job === "release") return main;
  const f = job.slice(job.indexOf(":") + 1);
  if (job.startsWith("check:")) return bytesOf(f) * (/^\/\/ check: timing/m.test(readFileSync(f, "utf8")) ? 2 : 1); // -O2
  const src = readFileSync(f, "utf8");
  if (/AGENTGLASS_BIN/.test(src)) return main / 50; // runs the shared binary
  if (/build\.sh/.test(src)) return main * Number((src.match(/^# check: builds (\d+)/m) || [0, 1])[1]);
  if (/scriptc build/.test(src)) return main / 10;
  return main / 50;
}
const pinned = (job) => job === "bin" || (job.startsWith("test:") && /AGENTGLASS_BIN/.test(readFileSync(job.slice(5), "utf8")));
const load = Array(shards).fill(0); const mine = []; const last = [];
for (const j of jobs.filter(pinned)) { load[0] += weight(j); if (shard === 1) (j.startsWith("test:") ? last : mine).push(j); }
const rest = jobs.filter((j) => !pinned(j)).map((j) => [j, weight(j)]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
for (const [j, w] of rest) {
  let s = 0; for (let k = 1; k < shards; k++) if (load[k] < load[s]) s = k;
  load[s] += w; if (s === shard - 1) mine.push(j);
}
console.log(mine.concat(last).join("\n")); // heaviest first; the tests that wait for the shared binary last
