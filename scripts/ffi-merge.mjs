// merge scriptc FFI manifests into one: scriptc build takes a single --ffi (a second one replaces the first), and macOS
// binds both the team crypto and libproc. Library paths become absolute (they resolve against the manifest's folder).
//   node scripts/ffi-merge.mjs <out.json> <manifest.json>…
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const [out, ...ins] = process.argv.slice(2);
if (!out || ins.length === 0) { console.error("usage: node scripts/ffi-merge.mjs <out.json> <manifest.json>…"); process.exit(2); }
const m = { ffi_format: 1, functions: [], libraries: [], system_libraries: [] };
const names = new Set(), symbols = new Set();
for (const f of ins) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  m.ffi_format = Math.max(m.ffi_format, j.ffi_format ?? 1);
  for (const fn of j.functions ?? []) {
    if (names.has(fn.name) || symbols.has(fn.symbol)) { console.error(`ffi-merge: ${fn.name} (${fn.symbol}) is in two manifests`); process.exit(1); }
    names.add(fn.name); symbols.add(fn.symbol); m.functions.push(fn);
  }
  for (const l of j.libraries ?? []) { const p = resolve(dirname(f), l); if (!m.libraries.includes(p)) m.libraries.push(p); }
  for (const l of j.system_libraries ?? []) if (!m.system_libraries.includes(l)) m.system_libraries.push(l);
}
if (m.system_libraries.length === 0) delete m.system_libraries;
writeFileSync(out, JSON.stringify(m, null, 2) + "\n");
