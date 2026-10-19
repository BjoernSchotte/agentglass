// the Skills page: per skill loads, size, carry, tail, $ and share with the tier marks; a header sorts as --sort; the
// period goes to skills.get; the advice list with its evidence, suggestion and sessions
import { render, screen, act, cleanup, within, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { skUsd, tk } from "../src/routes/skills.tsx";
import { splitOf } from "../src/routes/skills-bars.tsx";
import { fakeLive } from "./fake-live.ts";

const row = (name: string, extra = {}) => ({ name, loadsUser: 2, loadsModel: 5, loadsCompact: 1, sessions: 4, sizeP50: 3200, load: 6400, carry: 1_250_000, tail: 900_000, usd: 4.25, carryUsd: 4, tailUsd: 3, perSess: 1.0625, share: 0.031, tier: "exact", hashes: ["ab12"], scope: "user", unpriced: false, ...extra });
const seen: Record<string, unknown>[] = [];
function mount(path: string, advice = true) {
  const live = fakeLive([], { "skills.get": (p: Record<string, unknown>) => { seen.push(p); return { period: p.period, rows: [row("pdf"), row("brainstorm", { tier: "≈", usd: 1.5, sizeP50: null }), row("(hidden)", { usd: 0.4 })], hidden: 2,
    advice: advice ? [{ id: "A1", skill: "pdf", pair: null, severityUsd: 12.5, basisDays: 9, evidence: ["carried 1.2M tokens after its turn in 4 sessions"], suggestion: "split the skill: keep the steps, move the reference out", sessions: ["claude:abcdef0123"] }] : [], notes: "", pending: 0, at: 1 }; } }); live.connect();
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={router} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  return router;
}
const tick = () => act(async () => { await new Promise((x) => setTimeout(x, 20)); });
afterEach(() => { cleanup(); seen.length = 0; });

test("money and tokens as the CLI prints them", () => {
  expect(skUsd(1.5, "≈", false)).toBe("≈$1.50"); expect(skUsd(0, "?", false)).toBe("?"); expect(skUsd(120, "exact", true)).toBe("$120+");
  expect(tk(1_250_000)).toBe("1.3M"); expect(tk(3200)).toBe("3.2k");
});
test("rows with loads, carry, cost, share and tier marks; the hidden row says how many", async () => {
  mount("/skills");
  const t = await screen.findByRole("table", { name: "Skills" });
  const rows = within(t).getAllByRole("row").slice(1);
  expect(rows[0]?.textContent).toContain("pdf"); expect(rows[0]?.textContent).toContain("2 / 5 / 1"); expect(rows[0]?.textContent).toContain("1.3M"); expect(rows[0]?.textContent).toContain("$4.25"); expect(rows[0]?.textContent).toContain("3.1%");
  expect(rows[1]?.textContent).toContain("≈$1.50"); expect(rows[1]?.textContent).toContain("?");
  expect(rows[2]?.textContent).toContain("(hidden: 2 skills)");
  expect(seen[0]).toEqual({ period: "30d", sort: "cost", advice: 10 });
});
test("a header sorts, w and a switch the period", async () => {
  const r = mount("/skills");
  const t = await screen.findByRole("table", { name: "Skills" });
  await act(async () => { fireEvent.click(within(t).getByRole("button", { name: "Tail" })); await new Promise((x) => setTimeout(x, 20)); });
  expect((r.state.location.search as { sort?: string }).sort).toBe("tail"); expect(seen.at(-1)).toEqual({ period: "30d", sort: "tail", advice: 10 });
  await act(async () => { fireEvent.keyDown(window, { key: "w" }); }); await tick();
  expect(seen.at(-1)).toEqual({ period: "7d", sort: "tail", advice: 10 });
  await act(async () => { fireEvent.keyDown(window, { key: "a" }); }); await tick();
  expect(seen.at(-1)).toEqual({ period: "all", sort: "tail", advice: 10 });
});
test("advice: what, how much, the evidence, what to do, the sessions", async () => {
  mount("/skills");
  const a = await screen.findByRole("region", { name: "Advice" });
  expect(a.textContent).toContain("A1 carried too long"); expect(a.textContent).toContain("≈$12.50/30 d, from 9 days"); expect(a.textContent).toContain("carried 1.2M tokens");
  expect(a.textContent).toContain("→ split the skill");
  expect(within(a).getByText("abcdef01").closest("a")?.getAttribute("href")).toContain("sel=claude%3Aabcdef0123");
});
test("no advice: says why", async () => {
  mount("/skills", false);
  const a = await screen.findByRole("region", { name: "Advice" });
  expect(a.textContent).toContain("No skill crossed a threshold");
});
test("splitOf: load, carry within the turn, tail; tail never above carry", () => {
  expect(splitOf({ load: 10, carry: 100, tail: 40 })).toEqual([10, 60, 40]);
  expect(splitOf({ load: 0, carry: 5, tail: 9 })).toEqual([0, 0, 5]);
});
test("the bars: a stack per skill in the table's order, shares in the summary, the hidden row named", async () => {
  mount("/skills");
  const f = await screen.findByRole("region", { name: "Where skill tokens go" });
  expect(within(f).getByRole("img").getAttribute("aria-label")).toContain("3 skills · 3.8M tokens · load 1% · carry in turn 28% · tail 72%");
  fireEvent.click(within(f).getByRole("button", { name: "table" }));
  const tr = within(within(f).getByRole("table")).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
  expect(tr[0]).toBe("pdf6.4k350.0k900.0k"); expect(tr[2]).toContain("(hidden: 2 skills)");
});
