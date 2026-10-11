// the Stats page: KPI cards today / 7 days / month (≈ estimated, + unpriced), projection, budget meter, tables per
// harness and model for the URL's period (cost.get by + since), d/w/m keys, "counting…" while logs are pending, a bad
// filter shown with its hint
import { render, screen, act, cleanup, within, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { sinceOf } from "../src/routes/stats.tsx";
import { fakeLive } from "./fake-live.ts";

const zero = { api: 0, plan: 0, metered: 0, gateway: 0, unknown: 0 };
const per = (api: number, plan: number, est = 0, unk = 0) => ({ byMode: { ...zero, api, plan }, estimatedUsd: est, unpriced: { tokens: unk, byModel: {}, credits: 0 } });
const summary = (pending: number) => ({ today: per(1.5, 2), week: per(10, 20, 3), month: { ...per(40, 60, 0, 1_200_000), projected: { byMode: { ...zero, api: 80, plan: 120 }, total: 200 } },
  budget: { monthlyUsd: 200, counts: ["api"], used: 40, projected: 80, state: "ok", approx: false }, pending, at: 1, ...(pending ? { indexing: { done: 50, total: 100 } } : {}) });
const row = (key: string, costUsd: number | null, extra = {}) => ({ key, in: 1500, out: 20, cacheRead: 3_000_000, cacheWrite: 0, costUsd, unpricedTokens: costUsd === null ? 900 : 0, sessions: 2, ...extra });
const seen: Record<string, unknown>[] = [];
function answers(pending = 0) {
  return { "cost.get": (p: Record<string, unknown>) => {
    seen.push(p);
    if (!p.by) return summary(pending);
    if (p.filter === "harness is") throw new Error("unused");
    return p.by === "model" ? { rows: [row("claude-sonnet-4-5", 12.5, { priceSource: "built-in", estimated: false }), row("total", 12.5, { priceSource: null, estimated: false })], source: "ledger", by: "model", since: p.since, pending, at: 1 }
      : { rows: [row("claude", 12.5), row("total", 12.5)], source: "ledger", by: "harness", since: p.since, pending, at: 1 };
  } };
}
function mount(path: string, pending = 0) {
  const live = fakeLive([], answers(pending)); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: [path] }))} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
}
afterEach(() => { cleanup(); seen.length = 0; });

test("cards, projection, budget and the tables of the period", async () => {
  mount("/stats");
  const today = await screen.findByRole("region", { name: "Today" });
  expect(today.textContent).toContain("$3.50"); expect(today.textContent).toContain("spend $1.50 · plan $2.00");
  expect(screen.getByRole("region", { name: "7 days" }).textContent).toContain("≈$30.00");
  const month = screen.getByRole("region", { name: "This month" }).textContent ?? "";
  expect(month).toContain("$100.00+"); expect(month).toContain("1.2M tokens"); expect(month).toContain("projected $200");
  expect(screen.getByRole("meter", { name: "Budget used" }).getAttribute("aria-valuenow")).toBe("20");
  const byH = await screen.findByRole("region", { name: "By harness" }); await within(byH).findByText("claude");
  expect(within(byH).getAllByRole("row")[1]?.textContent).toContain("$12.50");
  const byM = screen.getByRole("region", { name: "By model" }); await within(byM).findByText(/claude-sonnet-4-5/);
  expect(byM.textContent).toContain("built-in"); expect(byM.textContent).toContain("3.0M");
  expect(seen.some((p) => p.by === "harness" && p.since === "7d")).toBe(true); // default period: 7 days
  expect(screen.queryByRole("status")).toBeNull();
});

test("d / m switch the period: since today, then the month's first day", async () => {
  mount("/stats");
  await screen.findByRole("region", { name: "By harness" });
  await act(async () => { fireEvent.keyDown(window, { key: "d" }); await new Promise((r) => setTimeout(r, 30)); });
  expect(seen.some((p) => p.by === "model" && p.since === "today")).toBe(true);
  await act(async () => { fireEvent.keyDown(window, { key: "m" }); await new Promise((r) => setTimeout(r, 30)); });
  expect(seen.some((p) => p.by === "harness" && p.since === sinceOf("m"))).toBe(true);
  expect(sinceOf("m", new Date(2026, 9, 11))).toBe("2026-10-01");
});

test("logs still being indexed: counting… with the progress", async () => {
  mount("/stats", 3);
  const st = await screen.findByRole("status");
  expect(st.textContent).toContain("3 logs are still being indexed (50%)");
});

test("the URL's filter goes to cost.get by", async () => {
  mount("/stats?p=w&f=harness%20is%20claude");
  await screen.findByRole("region", { name: "By harness" });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(seen.some((p) => p.by === "harness" && p.filter === "harness is claude")).toBe(true);
  expect((screen.getByRole("textbox", { name: "Filter" }) as HTMLInputElement).value).toBe("harness is claude");
});
