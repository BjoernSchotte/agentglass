// the bundle budgets (local-web-api §12, W9.0), from Vite's manifest (gzip -9):
//   shell (the entry and what it imports statically, JS + CSS) ≤ 160 KB · each lazy route (its chunk and the chunks it
//   imports that the shell does not, viz chunks aside) ≤ 80 KB · each viz chunk (name starts with "viz-") ≤ 250 KB ·
//   fonts ≤ 120 KB. Every page but Sessions (the first view) is a lazy route, and so is the drawer's timeline tab; no
//   viz chunk is a static import of the shell. Prints the sizes; exit 1 over a budget.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
const dist = new URL("../dist/", import.meta.url).pathname;
const mf = join(dist, ".vite", "manifest.json");
if (!existsSync(mf)) { console.error("no dist/.vite/manifest.json: build first (vite build with build.manifest)"); process.exit(1); }
const m = JSON.parse(readFileSync(mf, "utf8"));
const gz = (f) => gzipSync(readFileSync(join(dist, f)), { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1) + " KB";
const LAZY = ["stats", "wait", "repos", "skills", "alerts", "fleet", "team", "settings", "timeline-tab"]; // timeline-tab: the drawer's lazy tab
const bad = [];
const entry = Object.entries(m).find(([, c]) => c.isEntry);
if (!entry) { console.error("no entry chunk in the manifest"); process.exit(1); }
// the chunks a key reaches through static imports (its own included)
const reach = (k, into = new Set()) => { if (into.has(k)) return into; into.add(k); for (const i of m[k]?.imports ?? []) reach(i, into); return into; };
const files = (keys) => { const fs = new Set(); for (const k of keys) { const c = m[k]; if (!c) continue; fs.add(c.file); for (const s of c.css ?? []) fs.add(s); } return fs; };
const sum = (fs) => [...fs].reduce((a, f) => a + gz(f), 0);
const shellKeys = reach(entry[0]); const shellFiles = files(shellKeys);
const shell = sum(shellFiles);
const lines = ["shell js+css " + kb(shell) + " (≤ 160 KB)"];
if (shell > 160 * 1024) bad.push("shell " + kb(shell));
const isViz = (k) => (m[k]?.name ?? "").startsWith("viz-");
for (const r of LAZY) {
  const k = Object.keys(m).find((x) => x.endsWith("src/routes/" + r + ".tsx"));
  if (!k || !m[k].isDynamicEntry) { bad.push(r + ": not a lazy route chunk"); continue; }
  if (shellKeys.has(k)) { bad.push(r + ": in the shell"); continue; }
  const own = [...reach(k)].filter((x) => !shellKeys.has(x) && !isViz(x));
  const n = sum([...files(own)].filter((f) => !shellFiles.has(f)));
  lines.push(r + " " + kb(n) + " (≤ 80 KB)"); if (n > 80 * 1024) bad.push(r + " " + kb(n));
}
for (const k of shellKeys) if (isViz(k)) bad.push(m[k].name + ": in the shell");
for (const [k, c] of Object.entries(m)) if (isViz(k)) { const n = gz(c.file); lines.push(c.name + " " + kb(n) + " (≤ 250 KB)"); if (n > 250 * 1024) bad.push(c.name + " " + kb(n)); }
let fonts = 0; for (const f of readdirSync(join(dist, "assets"))) if (f.endsWith(".woff2")) fonts += readFileSync(join(dist, "assets", f)).length;
lines.push("fonts " + kb(fonts) + " (≤ 120 KB)"); if (fonts > 120 * 1024) bad.push("fonts " + kb(fonts));
console.log(lines.join(" · "));
if (bad.length) { console.error("over the bundle budget: " + bad.join(", ")); process.exit(1); }
