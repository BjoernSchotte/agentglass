// theme.js: data-theme from localStorage before the app runs; system follows prefers-color-scheme live
import { readFileSync } from "node:fs";
import { join } from "node:path";
const src = readFileSync(join(process.cwd(), "public", "theme.js"), "utf8");
function mm(dark: boolean) { const ls: ((e: unknown) => void)[] = []; const m = { matches: dark, addEventListener: (_: string, f: (e: unknown) => void) => ls.push(f) }; return { m, fire: (d: boolean) => { m.matches = d; for (const f of ls) f({}); } }; }
beforeEach(() => { document.documentElement.removeAttribute("data-theme"); localStorage.clear(); });
test("a stored theme wins", () => {
  localStorage.setItem("agentglass.theme", "dark"); const { m } = mm(false); window.matchMedia = (() => m) as never;
  new Function(src)(); expect(document.documentElement.dataset.theme).toBe("dark");
});
test("system follows the OS, live", () => {
  const { m, fire } = mm(false); window.matchMedia = (() => m) as never;
  new Function(src)(); expect(document.documentElement.dataset.theme).toBe("light");
  fire(true); expect(document.documentElement.dataset.theme).toBe("dark");
});
test("blocked storage: system, no throw", () => {
  const g = Storage.prototype.getItem; Storage.prototype.getItem = () => { throw new Error("blocked"); };
  const { m } = mm(true); window.matchMedia = (() => m) as never;
  try { new Function(src)(); expect(document.documentElement.dataset.theme).toBe("dark"); } finally { Storage.prototype.getItem = g; }
});
test("index.html: no inline script, theme.js loads before the app", () => {
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) { expect(t[1]).toMatch(/src=/); expect(t[2]!.trim()).toBe(""); }
  expect(html.indexOf("/theme.js")).toBeLessThan(html.indexOf("/src/main.tsx"));
});
