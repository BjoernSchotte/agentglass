// the Team page: members with devices online/total, live glyphs, cost, top harness (presence topic + team.report),
// rooms with their budget, the activity list "Anna joined room web · 10:42"
import { render, screen, act, cleanup, within } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { fakeLive } from "./fake-live.ts";

const T = [{ id: "t1", name: "acme" }];
const at = new Date(2026, 9, 10, 10, 42).toISOString();
const answers = {
  "team.status": { teams: [{ id: "t1", name: "acme", mailbox: "/x", kind: "dir", me: { id: "b", name: "bjoern", device: "d" }, admin: true, joined: true, pending: 0, problems: [],
    rooms: [{ id: "r1", name: "web", scope: ["github.com/acme/web"], level: "numbers", epoch: 1, budget: 400, share: { on: true } }], members: [] }] },
  "team.report": { team: "t1", room: null, period: "w", by: "member", filter: null, members: [], stale: [],
    rows: [{ key: "alice", sessions: 4, live: 3, tokens: 1, costUsd: 88.1, harnesses: ["claude", "codex"] }, { key: "bjoern", sessions: 2, live: 0, tokens: 1, costUsd: 12.4, harnesses: ["pi"] }],
    budget: [{ room: "web", usd: 400, spentUsd: 261, projectedUsd: 372, state: "ok" }] },
  "team.activity": { team: "t1", events: [{ at, actor: "a", kind: "join", room: "web", text: "Anna joined room web" }] },
};
const presence = [
  { key: "a", id: "a", name: "alice", mine: false, devices: 2, online: 2, live: 3, attention: 1, stuck: 0, lastAt: at },
  { key: "b", id: "b", name: "bjoern", mine: true, devices: 3, online: 1, live: 0, attention: 0, stuck: 0, lastAt: at },
];
afterEach(cleanup);
test("members, devices, live glyphs, cost, top harness, budget and activity", async () => {
  const live = fakeLive(T, answers, { presence }); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: ["/team"] }))} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const members = await screen.findByRole("region", { name: "Members" });
  await within(members).findByText("alice"); await screen.findByText("Anna joined room web");
  const rows = within(members).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
  expect(rows[0]).toContain("alice"); expect(rows[0]).toContain("2/2"); expect(rows[0]).toContain("●3"); expect(rows[0]).toContain("◆1"); expect(rows[0]).toContain("$88.10"); expect(rows[0]).toContain("claude");
  expect(rows[1]).toContain("bjoern (me)"); expect(rows[1]).toContain("1/3"); expect(rows[1]).toContain("pi");
  expect(screen.getByText("2 of 2 members online")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Rooms" })).getByText("$261 of $400")).toBeTruthy();
  const act1 = screen.getByRole("region", { name: "Activity" }).textContent ?? "";
  expect(act1).toContain("Anna joined room web"); expect(act1).toContain("10:42");
});
test("without a team: how to make or join one", async () => {
  const live = fakeLive([], {}, {}); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: ["/team"] }))} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(await screen.findByText(/No team on this machine/)).toBeTruthy();
});
