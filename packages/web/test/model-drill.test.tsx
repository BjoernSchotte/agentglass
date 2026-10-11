// the Stats model drill-down (W8.8): a By-model row opens where that model's cost came from — one cost.get {by: session,
// model}, grouped by project (the top one open), its sessions linking to their drawer
import { render, screen, act, cleanup, within, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { byProject } from "../src/routes/stats.tsx";
import { fakeLive } from "./fake-live.ts";

const row = (key: string, extra = {}) => ({ key, in: 10, out: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpricedTokens: 0, sessions: 1, ...extra });
const pd = { today: { byMode: { api: 1 }, estimatedUsd: 0, unpriced: { tokens: 0, byModel: {}, credits: 0 } } };
const sum = { ...pd, week: pd.today, month: { ...pd.today, projected: null }, budget: null, pending: 0, at: 1 };
const sess = (key: string, project: string, cost: number, cr: number, extra = {}) => row(key, { costUsd: cost, cacheRead: cr, title: "t " + key, project, cwd: "/w/" + project, root: null, last: new Date(Date.now() - 7_200_000).toISOString(), ...extra });
const seen: Record<string, unknown>[] = [];
function mount(path: string) {
  const live = fakeLive([], { "cost.get": (p: Record<string, unknown>) => {
    seen.push(p);
    if (!p.by) return sum;
    if (p.by === "model") return { rows: [row("claude-opus-4-7", { costUsd: 90, cacheRead: 9e6, sessions: 3, priceSource: "built-in", estimated: false }), row("total", { costUsd: 90, sessions: 3, priceSource: null, estimated: false })], source: "ledger", by: "model", since: "7d", pending: 0, at: 1 };
    if (p.by === "session") return { rows: [sess("claude:a1", "api", 50, 1e6), sess("claude:b2", "web", 30, 7e6), sess("claude:c3", "api", 10, 1e6, { root: "claude:a1" }), row("total", { costUsd: 90, cacheRead: 9e6, sessions: 3, title: null, project: null, cwd: null, root: null, last: null })], source: "ledger", by: "session", since: "7d", model: p.model, pending: 0, at: 1 };
    return { rows: [row("total")], source: "ledger", by: p.by, since: "7d", pending: 0, at: 1 };
  } }); live.connect();
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={router} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  return router;
}
const tick = () => act(async () => { await new Promise((x) => setTimeout(x, 20)); });
afterEach(() => { cleanup(); seen.length = 0; });

test("byProject: projects by cost or cache read, sessions in the same order", () => {
  const rs = [sess("h:a", "api", 50, 1), sess("h:b", "web", 30, 7), sess("h:c", "api", 10, 1), row("total")] as Parameters<typeof byProject>[0];
  expect(byProject(rs, "cost").map((p) => p.name + ":" + p.cost + ":" + p.rows.map((r) => r.key).join("+"))).toEqual(["api:60:h:a+h:c", "web:30:h:b"]);
  expect(byProject(rs, "cache").map((p) => p.name + ":" + p.cacheRead)).toEqual(["web:7", "api:2"]);
});
test("a model row opens its projects and sessions; a session links to its drawer", async () => {
  const r = mount("/stats");
  const t = await screen.findByRole("region", { name: "By model" });
  const mrow = await within(t).findByText("claude-opus-4-7");
  await act(async () => { fireEvent.click(mrow.closest("tr")!); await new Promise((x) => setTimeout(x, 20)); });
  expect((r.state.location.search as { model?: string }).model).toBe("claude-opus-4-7");
  expect(seen.at(-1)).toEqual({ by: "session", since: "7d", model: "claude-opus-4-7" });
  const d = await screen.findByRole("table", { name: "Projects using claude-opus-4-7" });
  const rows = within(d).getAllByRole("row").slice(1);
  expect(rows[0]?.textContent).toContain("api"); expect(rows[0]?.textContent).toContain("$60.00"); expect(rows[0]?.textContent).toContain("67%");
  expect(rows[1]?.textContent).toContain("t claude:a1"); expect(rows[2]?.textContent).toContain("subagent"); // the top project is open
  expect(within(d).getByText("t claude:c3").closest("a")?.getAttribute("href")).toContain("sel=claude%3Ac3");
  expect(screen.getByRole("region", { name: "Where claude-opus-4-7's cost came from" }).textContent).toContain("2 projects");
});
test("sort by cache read puts the cache-heavy project first; esc closes", async () => {
  const r = mount("/stats?model=claude-opus-4-7");
  const d = await screen.findByRole("table", { name: "Projects using claude-opus-4-7" });
  await act(async () => { fireEvent.click(within(d).getByRole("button", { name: "Cache read" })); await new Promise((x) => setTimeout(x, 20)); });
  const first = within(screen.getByRole("table", { name: "Projects using claude-opus-4-7" })).getAllByRole("row")[1];
  expect(first?.textContent).toContain("web"); expect(first?.textContent).toContain("78%");
  await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); }); await tick();
  expect((r.state.location.search as { model?: string }).model).toBeUndefined();
  expect(screen.queryByRole("table", { name: "Projects using claude-opus-4-7" })).toBeNull();
});
