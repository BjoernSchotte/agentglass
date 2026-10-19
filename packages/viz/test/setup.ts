// jsdom has no canvas and no matchMedia: a 2D context that draws nothing (uPlot and zrender call into it; gradients and patterns are inert objects) and a static media query
const noop = () => {};
const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 0 }) : k === "canvas" ? undefined : typeof k === "string" && k.startsWith("create") ? () => ({ addColorStop: noop }) : noop), set: () => true });
HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
if (!window.matchMedia) window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, onchange: null, dispatchEvent: () => false })) as never;
// …nor Path2D (uPlot builds series paths with it)
if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") (globalThis as { Path2D?: unknown }).Path2D = class { moveTo() {} lineTo() {} rect() {} arc() {} closePath() {} bezierCurveTo() {} addPath() {} };
