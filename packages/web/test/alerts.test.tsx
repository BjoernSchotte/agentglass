// the Alerts page: the alerts topic's log newest first with severity glyphs, firing count, a patch adds a row at the top,
// a row links to its session
import { render, screen, act, cleanup, within } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { fakeLive } from "./fake-live.ts";

const at = (m: number) => new Date(2026, 9, 11, 10, m).toISOString();
const row = (key: string, state: string, severity: string, rule: string, m: number, session = "s1") => ({ key, at: at(m), rule, severity, state, value: 420, threshold: 300, unit: "s", message: rule + " " + state, harness: "claude", session, title: "fix the flaky test", project: "api", labels: {} });
afterEach(cleanup);
test("the log newest first, glyphs, firing count, a live patch, the session link", async () => {
  const live = fakeLive([], {}, { alerts: [row("1", "fire", "critical", "stuck", 1), row("2", "fire", "degraded", "waiting", 2, "s2"), row("3", "resolve", "critical", "stuck", 3)] }); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: ["/alerts"] }))} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  const t = await screen.findByRole("table", { name: "Alert log" });
  const rows = within(t).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
  expect(rows[0]).toContain("10:03"); expect(rows[0]).toContain("✓ resolve"); expect(rows[1]).toContain("◆ fire"); expect(rows[2]).toContain("⚠ fire");
  expect(screen.getByText("1 firing")).toBeTruthy(); // stuck resolved; waiting still fires
  expect(within(t).getAllByRole("link")[0]?.getAttribute("href")).toContain("sel=claude%3As1");
  await act(async () => { live.push("alerts", { upsert: [row("4", "fire", "critical", "stuck", 4)], remove: [] }); await new Promise((r) => setTimeout(r, 20)); });
  const after = within(t).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
  expect(after.length).toBe(4); expect(after[0]).toContain("10:04"); expect(after[0]).toContain("⚠ fire");
  expect(screen.getByText("2 firing")).toBeTruthy();
});
