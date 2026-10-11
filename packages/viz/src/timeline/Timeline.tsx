// Timeline (local-web-api §12, W9.2): a session's turns, tool calls and subagents as spans on lanes — custom Canvas2D.
// A base canvas (spans, LOD-merged below a pixel), an overlay (hover, selection, box) and a minimap; HiDPI; painted
// on the next animation frame only when something moved. Wheel zooms around the cursor (Shift / sideways: pans), drag
// pans, Shift-drag box-selects, click selects; keys while focused: [ ] previous / next span, + - 0 zoom / fit,
// ← → ↑ ↓ pan, Esc clears. The index builds on the main thread: 50 k spans in ~7 ms (no worker needed, model.ts test).
import { useEffect, useMemo, useRef, useState } from "react";
import { type Tokens, type Token, useTokens, rgba } from "@agentglass/ui";
import { type Spans, type View, type Cmd, buildIndex, lod, hit, boxSelect, step, zoomAt, panBy } from "./model.ts";

export interface TimelineProps {
  spans: Spans; names: string[]; cats: string[]; kinds: string[]; maxHeight?: number;
  onSelect?: (ids: number[]) => void; label?: string;
}
const RH = 18; const AXIS = 20; const MINI = 26; // lane height, time axis, minimap (px)
const CAT_TOKEN: Record<string, Token> = { shell: "attention", edit: "live", read: "accent", web: "h-codex", agent: "h-pi", mcp: "h-fx", other: "text-muted" };
export function fmtDur(ms: number): string { if (ms < 1000) return Math.round(ms) + " ms"; const s = ms / 1000; if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + " s"; const m = Math.floor(s / 60); return m < 60 ? m + "m " + Math.round(s - m * 60) + "s" : Math.floor(m / 60) + "h " + (m % 60) + "m"; }
// an axis label: the date for day steps and at midnight, else the clock (seconds below a minute's step)
export function clock(ms: number, step: number): string {
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0");
  if (step >= 864e5 || (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && step >= 6e4)) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return p(d.getHours()) + ":" + p(d.getMinutes()) + (step < 60000 ? ":" + p(d.getSeconds()) : "");
}
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5, 6048e5];

export function Timeline({ spans, names, cats, kinds, maxHeight = 420, onSelect, label = "Timeline" }: TimelineProps) {
  const tk = useTokens();
  const ix = useMemo(() => buildIndex(spans), [spans]);
  const wrap = useRef<HTMLDivElement>(null); const base = useRef<HTMLCanvasElement>(null); const over = useRef<HTMLCanvasElement>(null); const mini = useRef<HTMLCanvasElement>(null); const tip = useRef<HTMLDivElement>(null);
  const st = useRef({ view: { a: ix.t0, b: ix.t1, y: 0 } as View, w: 600, hover: -1, focus: -1, sel: new Set<number>(), box: null as null | { x0: number; y0: number; x1: number; y1: number }, dirty: 3, raf: 0 });
  const [sel, setSel] = useState<number[]>([]);
  const lanesH = ix.rows * RH; const h = Math.min(maxHeight, AXIS + lanesH + 4);
  const colors = useMemo(() => cats.map((c) => tk[CAT_TOKEN[c] ?? "text-muted"]), [cats, tk]);

  // ── painting ──
  const paint = () => {
    const s = st.current; s.raf = 0; const dpr = window.devicePixelRatio || 1; const W = s.w; const v = s.view; const k = W / Math.max(1e-9, v.b - v.a);
    const bc = base.current; const oc = over.current; if (!bc || !oc) return;
    if (s.dirty & 1) { // spans and axis
      const g = bc.getContext("2d"); if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, h);
      drawAxis(g, v, W, tk);
      const r0 = Math.max(0, Math.floor(v.y / RH)); const r1 = Math.min(ix.rows - 1, Math.ceil((v.y + h - AXIS) / RH));
      const out: Cmd[] = []; const byColor = new Map<string, number[]>(); const labels: [number, number, number, number][] = []; const errs: number[] = [];
      for (let r = r0; r <= r1; r++) {
        const y = AXIS + r * RH - v.y + 2;
        for (const c of lod(ix, spans, r, v.a, v.b, k, out)) {
          const turn = c.i >= 0 && kinds[spans.kind[c.i]!] === "turn";
          const col = c.i >= 0 && c.err ? tk.error : turn ? rgba(tk.accent, 0.18) : c.i < 0 ? rgba(colors[c.cat] ?? tk["text-muted"], 0.55) : colors[c.cat] ?? tk["text-muted"];
          let a = byColor.get(col); if (!a) { a = []; byColor.set(col, a); }
          a.push(Math.max(0, c.x0), y, Math.max(1, Math.min(W, c.x1) - Math.max(0, c.x0)), RH - 4);
          for (const ex of c.errs) errs.push(ex, y);
          if (c.i >= 0 && c.x1 - c.x0 > 44) labels.push([c.i, Math.max(0, c.x0) + 4, y + RH - 8, Math.min(W, c.x1) - Math.max(0, c.x0) - 8]);
        }
      }
      for (const [col, a] of byColor) { g.fillStyle = col; for (let i = 0; i < a.length; i += 4) g.fillRect(a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!); }
      g.fillStyle = tk.error; for (let i = 0; i < errs.length; i += 2) g.fillRect(Math.max(0, errs[i]!) - 0.5, errs[i + 1]! + RH - 8, 2, 4); // failed calls inside merged runs
      g.font = "11px IBM Plex Sans, sans-serif"; g.textBaseline = "alphabetic";
      for (const [i, x, y, w] of labels) {
        const turn = kinds[spans.kind[i]!] === "turn"; g.fillStyle = turn ? tk.text : tk.bg;
        let t = names[spans.name[i]!] ?? ""; const max = Math.floor(w / 6.2); if (t.length > max) t = t.slice(0, Math.max(0, max - 1)) + "…";
        if (t.length > 1) g.fillText(t, x, y);
      }
    }
    if (s.dirty & 2) { // hover, focus, selection, box
      const g = oc.getContext("2d"); if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, h);
      const rect = (i: number, col: string, lw: number) => {
        const x0 = (spans.t0[i]! - v.a) * k; const x1 = Math.max(x0 + 2, (spans.t1[i]! - v.a) * k); const y = AXIS + spans.row[i]! * RH - v.y + 2;
        if (x1 < 0 || x0 > W || y + RH < AXIS || y > h) return; g.strokeStyle = col; g.lineWidth = lw; g.strokeRect(Math.max(-1, x0) + 0.5, y + 0.5, Math.min(W + 1, x1) - Math.max(-1, x0) - 1, RH - 5);
      };
      for (const i of s.sel) rect(i, tk.focus, 1.5);
      if (s.focus >= 0) rect(s.focus, tk.text, 2);
      if (s.hover >= 0) rect(s.hover, tk.text, 1);
      if (s.box) { const b = s.box; g.fillStyle = rgba(tk.accent, 0.12); g.strokeStyle = tk.accent; g.lineWidth = 1; const x = Math.min(b.x0, b.x1); const y = Math.min(b.y0, b.y1); g.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0)); g.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0)); }
    }
    paintMini(); s.dirty = 0;
  };
  // the minimap: span density over the whole session, the visible window outlined
  const density = useMemo(() => { const n = 400; const d = new Float64Array(n); const span = Math.max(1, ix.t1 - ix.t0); for (let i = 0; i < spans.n; i++) { const b = Math.min(n - 1, Math.floor(((spans.t0[i]! - ix.t0) / span) * n)); d[b]! += 1; } let m = 0; for (const x of d) m = Math.max(m, x); return { d, m: Math.max(1, m) }; }, [spans, ix]);
  const paintMini = () => {
    const c = mini.current; const g = c?.getContext("2d"); if (!c || !g) return; const s = st.current; const dpr = window.devicePixelRatio || 1; const W = s.w;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, MINI);
    g.fillStyle = rgba(tk["text-muted"], 0.5); const n = density.d.length;
    for (let b = 0; b < n; b++) { const v = density.d[b]!; if (!v) continue; const hh = Math.max(1, (Math.sqrt(v) / Math.sqrt(density.m)) * (MINI - 6)); g.fillRect((b / n) * W, MINI - 2 - hh, Math.max(1, W / n), hh); }
    const span = Math.max(1, ix.t1 - ix.t0); const x0 = ((s.view.a - ix.t0) / span) * W; const x1 = ((s.view.b - ix.t0) / span) * W;
    g.fillStyle = rgba(tk.accent, 0.15); g.fillRect(x0, 0, Math.max(2, x1 - x0), MINI); g.strokeStyle = tk.accent; g.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0) - 1, MINI - 1);
  };
  const schedule = (bits: number) => { const s = st.current; s.dirty |= bits; if (!s.raf) s.raf = requestAnimationFrame(paint); };

  // sizes (HiDPI) and a fresh view on new data
  useEffect(() => { st.current.view = { a: ix.t0, b: ix.t1, y: 0 }; st.current.sel = new Set(); st.current.focus = -1; setSel([]); schedule(3); }, [ix]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const size = () => {
      const dpr = window.devicePixelRatio || 1; const W = Math.max(100, el.clientWidth); st.current.w = W;
      for (const [c, hh] of [[base.current, h], [over.current, h], [mini.current, MINI]] as const) { if (!c) continue; c.width = Math.round(W * dpr); c.height = Math.round(hh * dpr); c.style.width = W + "px"; c.style.height = hh + "px"; }
      schedule(3);
    };
    size(); const ro = typeof ResizeObserver === "function" ? new ResizeObserver(size) : null; ro?.observe(el);
    return () => { ro?.disconnect(); if (st.current.raf) cancelAnimationFrame(st.current.raf); st.current.raf = 0; };
  }, [h]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => schedule(3), [tk]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── input ──
  const at = (e: { clientX: number; clientY: number }) => { const r = over.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const tAt = (x: number) => { const v = st.current.view; return v.a + (x / st.current.w) * (v.b - v.a); };
  const rowAt = (y: number) => Math.floor((y - AXIS + st.current.view.y) / RH);
  const maxY = Math.max(0, lanesH - (h - AXIS - 4));
  const setView = (v: View) => { st.current.view = { ...v, y: Math.max(0, Math.min(maxY, v.y)) }; schedule(3); };
  const choose = (ids: number[], focus: number) => { const s = st.current; s.sel = new Set(ids); s.focus = focus; setSel(ids); onSelect?.(ids); schedule(2); };
  const showTip = (i: number, x: number, y: number) => {
    const el = tip.current; if (!el) return;
    if (i < 0) { el.style.display = "none"; return; }
    const kind = kinds[spans.kind[i]!] ?? ""; const err = spans.err[i]! > 0 ? " · failed" : spans.open[i] ? " · running" : "";
    el.textContent = (names[spans.name[i]!] ?? "") + " · " + (kind === "tool" ? cats[spans.cat[i]!] ?? kind : kind) + " · " + fmtDur(spans.t1[i]! - spans.t0[i]!) + err;
    el.style.display = "block"; el.style.left = Math.min(st.current.w - 220, x + 12) + "px"; el.style.top = y + 14 + "px";
  };
  useEffect(() => { // wheel needs passive: false to keep the page from scrolling
    const el = over.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); const p = at(e); const v = st.current.view;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX; setView(panBy(v, (d / st.current.w) * (v.b - v.a), ix.t0, ix.t1)); return; }
      setView(zoomAt(v, p.x / st.current.w, Math.exp(e.deltaY * 0.0025), ix.t0, ix.t1));
    };
    el.addEventListener("wheel", wheel, { passive: false }); return () => el.removeEventListener("wheel", wheel);
  }, [ix, maxY]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = useRef<null | { x: number; y: number; v: View; box: boolean; moved: boolean }>(null);
  const down = (e: React.PointerEvent) => { if (e.button !== 0) return; (e.target as Element).setPointerCapture(e.pointerId); const p = at(e); drag.current = { x: p.x, y: p.y, v: st.current.view, box: e.shiftKey, moved: false }; };
  const move = (e: React.PointerEvent) => {
    const p = at(e); const d = drag.current; const s = st.current;
    if (d) {
      if (Math.abs(p.x - d.x) + Math.abs(p.y - d.y) > 3) d.moved = true; if (!d.moved) return;
      if (d.box) { s.box = { x0: d.x, y0: d.y, x1: p.x, y1: p.y }; schedule(2); return; }
      const ms = ((d.x - p.x) / s.w) * (d.v.b - d.v.a); setView({ ...panBy(d.v, ms, ix.t0, ix.t1), y: d.v.y + (d.y - p.y) }); return;
    }
    const r = rowAt(p.y); const i = p.y > AXIS && r >= 0 && r < ix.rows ? hit(ix, spans, r, tAt(p.x), 3 * ((s.view.b - s.view.a) / s.w)) : -1;
    if (i !== s.hover) { s.hover = i; schedule(2); } showTip(i, p.x, p.y);
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null; if (!d) return; const s = st.current; const p = at(e);
    if (d.box && s.box) { const b = s.box; s.box = null; const r0 = rowAt(Math.min(b.y0, b.y1)); const r1 = rowAt(Math.max(b.y0, b.y1)); const ids = boxSelect(ix, spans, r0, r1, tAt(Math.min(b.x0, b.x1)), tAt(Math.max(b.x0, b.x1))); choose(ids, ids[0] ?? -1); return; }
    if (!d.moved) { const r = rowAt(p.y); const i = r >= 0 && r < ix.rows ? hit(ix, spans, r, tAt(p.x), 3 * ((s.view.b - s.view.a) / s.w)) : -1; choose(i >= 0 ? [i] : [], i); }
  };
  const center = (i: number) => { const v = st.current.view; const w = v.b - v.a; const m = (spans.t0[i]! + spans.t1[i]!) / 2; const y = spans.row[i]! * RH - (h - AXIS) / 2; setView({ ...panBy({ a: m - w / 2, b: m + w / 2, y: v.y }, 0, ix.t0, ix.t1), y }); };
  const key = (e: React.KeyboardEvent) => {
    const s = st.current; const v = s.view; const w = v.b - v.a;
    if (e.key === "]" || e.key === "[") { const i = step(ix, s.focus, e.key === "]" ? 1 : -1); if (i >= 0) { choose([i], i); center(i); } }
    else if (e.key === "+" || e.key === "=") setView(zoomAt(v, 0.5, 0.67, ix.t0, ix.t1));
    else if (e.key === "-") setView(zoomAt(v, 0.5, 1.5, ix.t0, ix.t1));
    else if (e.key === "0") setView({ a: ix.t0, b: ix.t1, y: 0 });
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") setView({ ...panBy(v, (e.key === "ArrowLeft" ? -0.2 : 0.2) * w, ix.t0, ix.t1), y: v.y });
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") setView({ ...v, y: v.y + (e.key === "ArrowUp" ? -RH * 3 : RH * 3) });
    else if (e.key === "Escape" && (s.sel.size || s.focus >= 0)) choose([], -1);
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  const miniDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const go = (cx: number) => { const r = mini.current!.getBoundingClientRect(); const t = ix.t0 + ((cx - r.left) / r.width) * (ix.t1 - ix.t0); const v = st.current.view; const w = v.b - v.a; setView({ ...panBy({ a: t - w / 2, b: t + w / 2, y: v.y }, 0, ix.t0, ix.t1), y: v.y }); };
    go(e.clientX); const mv = (ev: PointerEvent) => go(ev.clientX); const end = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", end);
  };

  const total = sel.reduce((a, i) => a + (spans.t1[i]! - spans.t0[i]!), 0); const failed = sel.filter((i) => spans.err[i]! > 0).length;
  return (
    <div className="flex flex-col gap-2">
      <div ref={wrap} role="application" aria-label={label + ": " + spans.n + " spans on " + ix.rows + " lanes over " + fmtDur(ix.t1 - ix.t0) + ". Wheel zooms, drag pans, Shift-drag selects, [ and ] step through spans."}
        tabIndex={0} onKeyDown={key} className="w-full rounded border border-border-subtle bg-bg outline-none focus-visible:ring-1 focus-visible:ring-focus" style={{ position: "relative", overflow: "hidden", height: h }}>
        <canvas ref={base} style={{ position: "absolute", left: 0, top: 0 }} />
        <canvas ref={over} style={{ position: "absolute", left: 0, top: 0, cursor: "grab", touchAction: "none" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => { if (!drag.current) { st.current.hover = -1; schedule(2); showTip(-1, 0, 0); } }} />
        <div ref={tip} role="tooltip" className="max-w-[320px] truncate rounded border border-border bg-surface px-2 py-1 text-[11px] shadow" style={{ position: "absolute", zIndex: 10, display: "none", pointerEvents: "none" }} />
      </div>
      <canvas ref={mini} aria-label="Overview: click or drag to move the view" className="w-full cursor-pointer rounded border border-border-subtle" onPointerDown={miniDown} />
      {sel.length > 0 && (
        <div aria-label="Selected spans" className="text-[12px]">
          <p className="text-muted">{sel.length} selected · {fmtDur(total)} in all{failed ? " · " + failed + " failed" : ""} · esc clears</p>
          <ul className="mt-1 max-h-40 overflow-auto">{sel.slice(0, 200).map((i) => (
            <li key={i} className="flex gap-2"><span className="mono w-16 shrink-0 text-muted">{clock(spans.t0[i]!, 1000)}</span><span className={spans.err[i]! > 0 ? "text-error" : ""}>{names[spans.name[i]!]}</span><span className="text-muted">{kinds[spans.kind[i]!] === "tool" ? cats[spans.cat[i]!] : kinds[spans.kind[i]!]}</span><span className="num ml-auto">{fmtDur(spans.t1[i]! - spans.t0[i]!)}</span></li>))}
            {sel.length > 200 && <li className="text-muted">… {sel.length - 200} more</li>}</ul>
        </div>)}
    </div>
  );
}
function drawAxis(g: CanvasRenderingContext2D, v: View, W: number, tk: Tokens) {
  const w = v.b - v.a; const stp = STEPS.find((s) => (s / w) * W >= 90) ?? STEPS[STEPS.length - 1]!;
  g.fillStyle = tk["text-muted"]; g.font = "10px IBM Plex Sans, sans-serif"; g.textBaseline = "top"; g.strokeStyle = tk["border-subtle"]; g.lineWidth = 1;
  const tz = new Date(v.a).getTimezoneOffset() * 6e4; // local alignment for hour and day steps
  for (let t = stp >= 36e5 ? Math.ceil((v.a - tz) / stp) * stp + tz : Math.ceil(v.a / stp) * stp; t <= v.b; t += stp) { const x = Math.round(((t - v.a) / w) * W) + 0.5; g.beginPath(); g.moveTo(x, AXIS - 4); g.lineTo(x, 9999); g.stroke(); if (x + 52 < W) g.fillText(clock(t, stp), x + 3, 3); } // no label cut at the right edge
}
