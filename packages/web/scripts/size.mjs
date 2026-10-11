// the bundle budget (local-web-api W5): the shell's JS + CSS ≤ 160 KB gzip, fonts ≤ 120 KB; prints the sizes
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
const dir = new URL("../dist/assets/", import.meta.url).pathname;
let code = 0, fonts = 0;
for (const f of readdirSync(dir)) {
  const b = readFileSync(join(dir, f));
  if (f.endsWith(".woff2")) fonts += b.length; else if (f.endsWith(".js") || f.endsWith(".css")) code += gzipSync(b, { level: 9 }).length;
}
const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log("shell js+css gzip " + kb(code) + " (≤ 160 KB) · fonts " + kb(fonts) + " (≤ 120 KB)");
if (code > 160 * 1024 || fonts > 120 * 1024) { console.error("over the bundle budget"); process.exit(1); }
