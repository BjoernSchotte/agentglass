// the Stats trend (W9.1): every day of the period on the x axis (0 where nothing was booked), a summary a screen reader
// gets, the same numbers as a table; a brushed range (?from=&to=) narrows the tables to since/until, and clears
import { render, screen, cleanup, within, fireEvent, act } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { firstDay } from "../src/routes/stats.tsx";
import { daySeries, secDay, daySec } from "../src/routes/stats-trend.tsx";
import { fakeLive } from "./fake-live.ts";

const day = (n: number) => secDay(Date.now() / 1000 - n * 86400);
const row = (key: string, costUsd: number, extra = {}) => ({ key, in: 1000, out: 10, cacheRead: 2_000_000, cacheWrite: 0, costUsd, unpricedTokens: 0, sessions: 1, ...extra });
const seen: Record<string, unknown>[] = [];
function mount(path: string) {
  const live = fakeLive([], { "cost.get": (p: Record<string, unknown>) => {
    seen.push(p);
    if (!p.by) return { today: { byMode: {}, estimatedUsd: 0, unpriced: { tokens: 0, byModel: {}, credits: 0 } }, week: { byMode: {}, estimatedUsd: 0, unpriced: { tokens: 0, byModel: {}, credits: 0 } }, month: { byMode: {}, estimatedUsd: 0, unpriced: { tokens: 0, byModel: {}, credits: 0 }, projected: null }, budget: null, pending: 0, at: 1 };
    if (p.by === "day") return { rows: [row(day(2), 4), row(day(0), 1), row("total", 5)], source: "ledger", by: "day", since: day(6), pending: 0, at: 1 };
    return { rows: [row("total", 5, p.by === "model" ? { priceSource: null, estimated: false } : {})], source: "ledger", by: p.by, since: p.since, pending: 0, at: 1 };
  } }); live.connect();
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={router} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  return router;
}
const tick = () => act(async () => { await new Promise((x) => setTimeout(x, 20)); });
afterEach(() => { cleanup(); seen.length = 0; });

test("daySeries: every day from since to today, zeros between", () => {
  const d = daySeries([row("2026-10-03", 2), row("2026-10-05", 3), row("total", 5)], "2026-10-02", "2026-10-06");
  expect(d.keys).toEqual(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]);
  expect(d.cost).toEqual([0, 2, 0, 3, 0]); expect(d.cr).toEqual([0, 2e6, 0, 2e6, 0]);
  expect(secDay(daySec("2026-10-04"))).toBe("2026-10-04");
});
test("firstDay: today, a week back, the month's first", () => {
  const now = new Date(2026, 9, 11, 15);
  expect(firstDay("d", now)).toBe("2026-10-11"); expect(firstDay("w", now)).toBe("2026-10-05"); expect(firstDay("m", now)).toBe("2026-10-01");
});
test("the trend: summary, the table view, the period's days", async () => {
  mount("/stats");
  const f = await screen.findByRole("region", { name: "Cost per day" });
  expect(within(f).getByRole("img").getAttribute("aria-label")).toContain("7 days · $5.00 · median $0.00 · max $4.00");
  expect(seen.some((p) => p.by === "day" && p.since === "7d")).toBe(true);
  fireEvent.click(within(f).getByRole("button", { name: "table" }));
  const t = within(f).getByRole("table"); expect(within(t).getAllByRole("row").length).toBe(8); expect(t.textContent).toContain("$4.00");
});
test("a brushed range narrows the tables; clear range brings the period back", async () => {
  const r = mount("/stats?from=" + day(3) + "&to=" + day(1));
  await screen.findByRole("region", { name: "Cost per day" }); await tick();
  expect(seen.some((p) => p.by === "harness" && p.since === day(3) && p.until === day(1))).toBe(true);
  expect(seen.some((p) => p.by === "day" && p.since === "7d" && !p.until)).toBe(true); // the trend keeps the whole period
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "clear range" })); }); await tick();
  expect((r.state.location.search as { from?: string }).from).toBeUndefined();
  expect(seen.at(-1)).toMatchObject({ since: "7d" }); expect(seen.at(-1)?.until).toBeUndefined();
});
test("a period key clears the range", async () => {
  const r = mount("/stats?from=" + day(3) + "&to=" + day(1));
  await screen.findByRole("region", { name: "Cost per day" });
  await act(async () => { fireEvent.keyDown(window, { key: "m" }); }); await tick();
  expect((r.state.location.search as { from?: string; p?: string }).from).toBeUndefined();
});
