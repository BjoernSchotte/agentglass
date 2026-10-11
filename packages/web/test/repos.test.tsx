// the Repos page: projects by cost with sessions, live, commits, $/commit, active time, error rate; a row opens its files,
// branches and harnesses (sel in the URL); the period goes to repos.list as days
import { render, screen, act, cleanup, within, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { fakeLive } from "./fake-live.ts";

const repo = (key: string, label: string, extra = {}) => ({ key, label, kind: "git", worktrees: [{ name: label, top: "/w/" + label }], sessions: 12, live: 1, last: new Date(Date.now() - 3_600_000).toISOString(),
  costUsd: 42.5, unpricedTokens: 0, tokens: { in: 1, out: 1 }, calls: 300, errors: 30, errorRate: 0.1, activeMin: 135, agentMin: 300,
  files: [{ path: "src/app.ts", edits: 9, add: 120, del: 30, harnesses: ["claude"] }], outsideFiles: 2, byHarness: [{ harness: "claude", sessions: 10, costUsd: 40 }],
  branches: [{ branch: "main", sessions: 8, commits: 5, costUsd: 30 }], commits: 5, costPerCommit: 8.5, spendWithoutCommits: 0, prs: ["https://x/pr/1"], ...extra });
const seen: Record<string, unknown>[] = [];
function mount(path: string) {
  const live = fakeLive([], { "repos.list": (p: Record<string, unknown>) => { seen.push(p); return { rows: [repo("git:github.com/acme/api", "api"), repo("git:github.com/acme/web", "web", { live: 0, errorRate: null, costPerCommit: null, worktrees: [{ name: "web", top: "/a" }, { name: "web-2", top: "/b" }] })], days: p.days, pending: 0, at: 1 }; } }); live.connect();
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={router} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  return router;
}
afterEach(() => { cleanup(); seen.length = 0; });
test("projects, and a row opens its details", async () => {
  const r = mount("/repos");
  const t = await screen.findByRole("table", { name: "Projects" });
  const rows = within(t).getAllByRole("row").slice(1);
  expect(rows[0]?.textContent).toContain("api"); expect(rows[0]?.textContent).toContain("$42.50"); expect(rows[0]?.textContent).toContain("$8.50"); expect(rows[0]?.textContent).toContain("2h 15m"); expect(rows[0]?.textContent).toContain("10%"); expect(rows[0]?.textContent).toContain("●1");
  expect(rows[1]?.textContent).toContain("2 worktrees");
  expect(seen[0]).toEqual({ days: 7 });
  await act(async () => { fireEvent.click(rows[0]!); await new Promise((x) => setTimeout(x, 20)); });
  expect((r.state.location.search as { sel?: string }).sel).toBe("git:github.com/acme/api");
  expect(screen.getByRole("region", { name: "Files of api" }).textContent).toContain("src/app.ts");
  expect(screen.getByRole("region", { name: "Branches of api" }).textContent).toContain("5 commits");
});
test("a and m: all history and 30 days", async () => {
  mount("/repos");
  await screen.findByRole("table", { name: "Projects" });
  await act(async () => { fireEvent.keyDown(window, { key: "a" }); await new Promise((x) => setTimeout(x, 20)); });
  expect(seen.at(-1)).toEqual({ days: 0 });
  await act(async () => { fireEvent.keyDown(window, { key: "m" }); await new Promise((x) => setTimeout(x, 20)); });
  expect(seen.at(-1)).toEqual({ days: 30 });
});
