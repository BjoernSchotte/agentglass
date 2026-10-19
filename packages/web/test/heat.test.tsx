// the Stats heatmap (W9.3): cost.get {by: hour} over the tables' days (a brushed range too), all 168 cells (0 where none),
// the peak in the summary, the non-empty hours in the table view
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { weekGrid } from "../src/routes/stats-heat.tsx";
import { fakeLive } from "./fake-live.ts";

const row = (key: string, costUsd: number, sessions = 1) => ({ key, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd, unpricedTokens: 0, sessions });
const empty = { byMode: {}, estimatedUsd: 0, unpriced: { tokens: 0, byModel: {}, credits: 0 } };
const seen: Record<string, unknown>[] = [];
function mount(path: string) {
  const live = fakeLive([], { "cost.get": (p: Record<string, unknown>) => {
    seen.push(p);
    if (!p.by) return { today: empty, week: empty, month: { ...empty, projected: null }, budget: null, pending: 0, at: 1 };
    if (p.by === "hour") return { rows: [row("Mon 09", 1.5, 2), row("Tue 14", 4.2, 3), row("total", 5.7, 4)], source: "ledger", by: "hour", since: "2026-10-12", pending: 0, at: 1 };
    return { rows: [row("total", 0)], source: "ledger", by: p.by, since: "2026-10-12", pending: 0, at: 1 };
  } }); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: [path] }))} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
}
afterEach(() => { cleanup(); seen.length = 0; });
test("weekGrid: 168 cells, Monday first, the peak; unknown keys skipped", () => {
  const g = weekGrid([row("Sun 23", 2), row("Mon 00", 1), row("bad", 9), row("total", 3)]);
  expect(g.cells.length).toBe(168); expect(g.cells[0]).toEqual([0, 0, 1]); expect(g.cells[167]).toEqual([23, 6, 2]);
  expect(g.total).toBe(3); expect(g.peak).toEqual({ day: "Sun", hour: "23", usd: 2 });
  expect(weekGrid([]).peak).toBeNull();
});
test("the heatmap: by hour over the period, peak in the summary, hours in the table", async () => {
  mount("/stats");
  const f = await screen.findByRole("region", { name: "Cost by weekday and hour" });
  expect(within(f).getByRole("img").getAttribute("aria-label")).toContain("$5.70 over 7 days · peak Tue 14:00 $4.20 · 2 of 168 hours with cost");
  expect(seen.some((p) => p.by === "hour" && p.since === "7d")).toBe(true);
  fireEvent.click(within(f).getByRole("button", { name: "table" }));
  const rows = within(within(f).getByRole("table")).getAllByRole("row").map((r) => r.textContent);
  expect(rows.slice(1)).toEqual(["Tue 14:00$4.203", "Mon 09:00$1.502"]);
});
test("a brushed range: the heatmap counts its days", async () => {
  mount("/stats?from=2026-10-13&to=2026-10-14");
  const f = await screen.findByRole("region", { name: "Cost by weekday and hour" });
  expect(within(f).getByRole("img").getAttribute("aria-label")).toContain("on Oct 13 – Oct 14");
  expect(seen.some((p) => p.by === "hour" && p.since === "2026-10-13" && p.until === "2026-10-14")).toBe(true);
});
