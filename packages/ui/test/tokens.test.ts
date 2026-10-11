// tokens.css: both themes define every token; text ≥ 4.5:1 and status glyphs ≥ 3:1 against background and surfaces
import { readFileSync } from "node:fs";
import { join } from "node:path";
const css = readFileSync(join(process.cwd(), "tokens.css"), "utf8");
function block(sel: string): Map<string, string> {
  const i = css.indexOf(sel); const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  return new Map([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}
function lum(hex: string): number { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; }
function ratio(a: string, b: string): number { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const light = block(':root, :root[data-theme="light"]'); const dark = block(':root[data-theme="dark"]');
test("both themes define the same tokens", () => { expect([...dark.keys()].sort()).toEqual([...light.keys()].sort()); expect(light.size).toBeGreaterThan(15); });
for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  test(name + ": text ≥ 4.5:1, glyphs ≥ 3:1", () => {
    for (const bg of ["bg", "surface", "surface-2"]) {
      for (const fg of ["text", "text-muted"]) expect(ratio(t.get(fg)!, t.get(bg)!), name + " " + fg + " on " + bg).toBeGreaterThanOrEqual(4.5);
      for (const fg of ["live", "attention", "stuck", "error", "cost", "accent"]) expect(ratio(t.get(fg)!, t.get(bg)!), name + " " + fg + " on " + bg).toBeGreaterThanOrEqual(3);
    }
  });
}
