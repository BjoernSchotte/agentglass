// @vitest-environment jsdom
// resolveTokens: every token of tokens.css resolves to #rrggbb in both themes; a theme switch is noticed
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOKENS, resolveTokens, rgba, onThemeChange } from "../src/resolve.ts";
const css = readFileSync(join(process.cwd(), "tokens.css"), "utf8").replace(/@font-face[^}]*}/g, "");
beforeAll(() => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); });
const tick = () => new Promise((r) => setTimeout(r, 0));
test("tokens.css defines exactly the resolved tokens", () => {
  const names = new Set([...css.slice(0, css.indexOf("}")).matchAll(/--([\w-]+):/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual([...TOKENS].sort());
});
for (const theme of ["light", "dark"]) {
  test(theme + ": every token resolves to #rrggbb", () => {
    document.documentElement.setAttribute("data-theme", theme);
    const t = resolveTokens();
    for (const k of TOKENS) expect(t[k], theme + " " + k).toMatch(/^#[0-9a-f]{6}$/);
  });
}
test("the themes differ, and a switch is noticed", async () => {
  document.documentElement.setAttribute("data-theme", "light"); const l = resolveTokens();
  let n = 0; const off = onThemeChange(() => n++);
  document.documentElement.setAttribute("data-theme", "dark"); await tick();
  expect(n).toBe(1); expect(resolveTokens().bg).not.toBe(l.bg);
  off(); document.documentElement.setAttribute("data-theme", "light"); await tick(); expect(n).toBe(1);
});
test("rgba", () => { expect(rgba("#4f46e5", 0.25)).toBe("rgba(79,70,229,0.25)"); });
