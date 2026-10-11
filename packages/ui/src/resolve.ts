// the theme's tokens as plain colours for canvas and WebGL charts (local-web-api §12): zrender, sigma and uPlot take
// hex/rgb, not CSS variables; every chart adapter reads them here and again when the theme changes
import { useEffect, useState } from "react";

export const TOKENS = ["bg", "surface", "surface-2", "border-subtle", "border", "text", "text-muted", "accent", "accent-fg", "focus",
  "live", "attention", "stuck", "error", "cost", "h-claude", "h-codex", "h-pi", "h-opencode", "h-gemini", "h-kiro", "h-fx"] as const;
export type Token = (typeof TOKENS)[number];
export type Tokens = Record<Token, string>;
// the current theme's tokens (lowercase #rrggbb), read from the computed style of <html>
export function resolveTokens(el: Element = document.documentElement): Tokens {
  const cs = getComputedStyle(el); const o = {} as Tokens;
  for (const t of TOKENS) o[t] = cs.getPropertyValue("--" + t).trim().toLowerCase();
  return o;
}
// #rrggbb at an alpha, for fills and bands
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}
// calls back when <html data-theme> changes (theme.js: a choice in Settings, or the system's under "system"); returns off
export function onThemeChange(cb: () => void, el: Element = document.documentElement): () => void {
  const mo = new MutationObserver(() => cb()); mo.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}
// the tokens, re-read on a theme change
export function useTokens(): Tokens {
  const [t, setT] = useState<Tokens>(() => resolveTokens());
  useEffect(() => onThemeChange(() => setT(resolveTokens())), []);
  return t;
}
// prefers-reduced-motion: charts skip their transitions
export function reducedMotion(): boolean { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; }
