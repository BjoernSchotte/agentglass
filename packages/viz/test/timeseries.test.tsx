// TimeSeries: one canvas after StrictMode's mount → unmount → mount; data updates keep the instance; a drag range maps
// to the x values under it; keys move the cursor and Esc clears the range
import { StrictMode, createRef } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { TimeSeries, xRange, ticksOn, type TsHandle } from "../src/timeseries.tsx";
afterEach(cleanup);
const x = [1, 2, 3, 4, 5];
test("StrictMode: one plot, one canvas; new data keeps it", () => {
  const r = render(<StrictMode><TimeSeries x={x} series={[{ label: "cost", values: [1, 2, 3, 4, 5], color: "cost", bars: true }]} /></StrictMode>);
  expect(r.container.querySelectorAll(".uplot").length).toBe(1); expect(r.container.querySelectorAll("canvas").length).toBe(1);
  const c = r.container.querySelector("canvas");
  r.rerender(<StrictMode><TimeSeries x={x} series={[{ label: "cost", values: [5, 4, 3, 2, 1], color: "cost", bars: true }]} /></StrictMode>);
  expect(r.container.querySelector("canvas")).toBe(c);
  r.unmount(); expect(document.querySelectorAll(".uplot").length).toBe(0);
});
test("ticksOn: every day when there is room, every k-th when not", () => {
  const days = Array.from({ length: 30 }, (_, i) => i);
  expect(ticksOn(days, 2000)).toEqual(days); expect(ticksOn(days, 560)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27]);
});
test("xRange: the first and last x inside a span", () => {
  expect(xRange(x, 1.5, 4.2)).toEqual([2, 4]); expect(xRange(x, 6, 9)).toBeNull(); expect(xRange(x, 0, 1)).toEqual([1, 1]);
});
test("keys: arrows move the cursor, Esc clears a range", () => {
  const h = createRef<TsHandle>(); const sel: unknown[] = []; const cur: unknown[] = [];
  render(<TimeSeries x={x} series={[{ label: "c", values: [1, 2, 3, 4, 5], color: "cost" }]} range={[2, 3]} onSelect={(r) => sel.push(r)} onCursor={(i) => cur.push(i)} handle={h} />);
  const ev = (key: string) => ({ key, preventDefault: () => {} }) as never;
  act(() => h.current!.key(ev("ArrowRight"))); act(() => h.current!.key(ev("ArrowRight")));
  act(() => h.current!.key(ev("Escape")));
  expect(sel).toEqual([null]);
});
