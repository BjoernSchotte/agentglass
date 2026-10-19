// the ECharts wrapper: one instance after StrictMode's mount → unmount → mount, disposed on unmount; options carry the
// theme's colours, decals, no transitions under reduced motion; a heatmap's colour scale ends at the largest cell
import { StrictMode } from "react";
import { render, cleanup } from "@testing-library/react";
import * as echarts from "echarts/core";
import { EChart, heatmapOption, boxplotOption, barsOption, baseOption, tipHtml } from "../src/echarts.tsx";
import { resolveTokens } from "@agentglass/ui";
afterEach(cleanup);
const tk = resolveTokens();
test("StrictMode: one instance; unmount disposes it", () => {
  const r = render(<StrictMode><EChart option={barsOption({ cats: ["a"], series: [{ label: "x", values: [1], color: "accent" }], fmt: String }, tk)} /></StrictMode>);
  const el = r.container.firstElementChild as HTMLDivElement;
  expect(echarts.getInstanceByDom(el)).toBeTruthy();
  expect(r.container.querySelectorAll("canvas").length).toBe(1);
  r.unmount(); expect(echarts.getInstanceByDom(el)).toBeUndefined();
});
test("options: theme colours, decals, reduced motion", () => {
  const mm = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  try { expect(baseOption(tk).animation).toBe(false); } finally { window.matchMedia = mm; }
  const two = barsOption({ cats: ["a"], series: [{ label: "x", values: [1], color: "accent" }, { label: "y", values: [2], color: "live" }], fmt: String }, tk) as { aria: { decal: { show: boolean } } };
  expect(two.aria.decal.show).toBe(true); // stacked series: patterns too; one series needs none
  const h = heatmapOption({ x: ["00", "01"], y: ["Mon"], cells: [[0, 0, 2], [1, 0, 5]], color: "cost", fmt: String }, tk) as { visualMap: { max: number; inRange: { color: string[] } } };
  expect(h.visualMap.max).toBe(5); expect((h as unknown as { aria: { decal: { show: boolean } } }).aria.decal.show).toBe(false); expect(h.visualMap.inRange.color).toEqual([tk["surface-2"], tk.cost]);
  const b = boxplotOption({ cats: ["make"], boxes: [[1, 2, 3, 4, 5]], color: "attention", fmt: String, log: true }, tk) as { xAxis: { type: string } };
  expect(b.xAxis.type).toBe("log");
});
test("tooltips: the caller's text is escaped, newlines break", () => {
  expect(tipHtml("<img src=x onerror=alert(1)>\nok & \"q\"")).toBe("&#60;img src=x onerror=alert(1)&#62;<br>ok &#38; &#34;q&#34;");
  const b = boxplotOption({ cats: ["<b>"], boxes: [[1, 2, 3, 4, 5]], color: "attention", fmt: String }, tk) as { tooltip: { formatter: (p: { dataIndex: number }) => string } };
  expect(b.tooltip.formatter({ dataIndex: 0 })).toBe("&#60;b&#62;");
});
