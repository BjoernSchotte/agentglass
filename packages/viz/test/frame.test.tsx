// ChartFrame: the summary is the chart's accessible name; "table" shows the same numbers; the chart takes focus and keys
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ChartFrame, stats } from "../src/index.ts";
afterEach(cleanup);
test("summary as the chart's name, the table toggle, keys while focused", () => {
  const keys: string[] = [];
  render(<ChartFrame title="Cost per day" summary="7 days · max $4.00" cols={[{ key: "d", label: "Day" }, { key: "c", label: "Cost", num: true }]} rows={[{ d: "Mon", c: "$4.00" }, { d: "Tue", c: "$1.00" }]} onKey={(e) => keys.push(e.key)}><canvas /></ChartFrame>);
  const img = screen.getByRole("img", { name: "Cost per day: 7 days · max $4.00" });
  fireEvent.keyDown(img, { key: "ArrowRight" }); expect(keys).toEqual(["ArrowRight"]);
  fireEvent.click(screen.getByRole("button", { name: "table" }));
  expect(screen.queryByRole("img")).toBeNull(); expect(screen.getByRole("table").textContent).toContain("Tue$1.00");
  expect(screen.getByRole("button", { name: "chart" }).getAttribute("aria-pressed")).toBe("true");
});
test("stats: min, p50, p95, max; empty is zeros", () => {
  expect(stats([5, 1, 3, 2, 4])).toEqual({ min: 1, p50: 3, p95: 5, max: 5 });
  expect(stats([])).toEqual({ min: 0, p50: 0, p95: 0, max: 0 });
});
