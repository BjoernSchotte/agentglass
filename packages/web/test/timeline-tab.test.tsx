// the drawer's Timeline tab (W9.2): loads on first open, asks graph.get for the session, shows the spans' summary and
// the timeline (its own chunk); an empty graph says so
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { fakeLive, ROW } from "./fake-live.ts";

const graph = (n: number) => ({ session: { harness: "claude", id: "s1" }, t0: 1000, t1: 61000, noTiming: false, rows: 2, n, total: n, kinds: ["turn", "tool", "agent"], cats: ["shell", "edit", "read", "web", "agent", "mcp", "other"], names: ["turn", "Bash"],
  spans: n ? { t0: [1000, 2000, 5000], t1: [61000, 4000, 9000], depth: [0, 1, 1], row: [0, 1, 1], kind: [0, 1, 1], cat: [6, 0, 0], name: [0, 1, 1], err: [0, 0, 1], open: [0, 0, 0], est: [0, 0, 0], parent: [-1, 0, 0], src: [0, 0, 0] }
    : { t0: [], t1: [], depth: [], row: [], kind: [], cat: [], name: [], err: [], open: [], est: [], parent: [], src: [] },
  sources: [{ harness: "claude", id: "s1", kind: null }], truncated: 0, at: 1 });
const seen: Record<string, unknown>[] = [];
function mount(n: number) {
  const live = fakeLive([], { "graph.get": (p: Record<string, unknown>) => { seen.push(p); return graph(n); }, "sessions.get": { ...ROW, via: "ref", turns: 1 } }); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: ["/sessions?sel=claude:s1"] }))} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
}
afterEach(() => { cleanup(); seen.length = 0; });
test("the Timeline tab: graph.get for the session, the summary, the timeline", async () => {
  mount(3);
  fireEvent.click(await screen.findByRole("tab", { name: "timeline" }));
  const app = await screen.findByRole("application", { name: /Timeline of claude:s1: 3 spans on 2 lanes over 1m 0s/ });
  expect(app.querySelectorAll("canvas").length).toBe(2);
  expect(seen).toEqual([{ ref: "claude:s1" }]);
  expect(screen.getByText(/3 spans · 2 lanes · 1m 0s/)).toBeTruthy();
});
test("an empty graph says so", async () => {
  mount(0);
  fireEvent.click(await screen.findByRole("tab", { name: "timeline" }));
  expect(await screen.findByText("No turns or calls in this session.")).toBeTruthy();
});
