// the Wait page: rows by command family (heavy ◆, share, total, p50/p95, error rate, trend, peak), agent time split, what
// runs now, the URL's period / grouping / filter go to wait.get, a bad filter shows its message
import { render, screen, act, cleanup, within, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { dur } from "../src/routes/wait.tsx";
import { histQ, boxOf, dms } from "../src/routes/wait-box.tsx";
import { ApiFail } from "../src/live/socket.ts";
import { fakeLive } from "./fake-live.ts";

const row = (key: string, kind: string, heavy: boolean, totalMs: number, extra = {}) => ({ key, kind, heavy, calls: 12, timedCalls: 12, totalMs, share: 0.25, p50Ms: 42000, p95Ms: 300000, maxMs: 400000, errors: 3, errorRate: 0.25,
  prevTotalMs: 1000, trend: 0.5, agents: 2, peak: 3, peakAt: "2026-10-10T10:00:00.000Z", atLeast2Ms: 60000, atLeast3Ms: 1000, slowdown: null, hist: [], ...extra });
// the CLI's duration buckets (usage/calls.ts EDGE): bucket 0 < 10 ms, the last ≥ 30 min
const EDGES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000, 600000, 1800000];
const H = (b: [number, number][]) => { const h = new Array(EDGES.length + 1).fill(0); for (const [i, n] of b) h[i] = n; return h; };
const report = (p: Record<string, unknown>) => ({ period: { since: "x", until: "y", days: 7 }, previous: null, scope: { filter: p.filter ?? null, project: null, now: "host" }, retention: { days: 90, complete: true },
  agentTime: { activeMs: 3_600_000, toolMs: 1_800_000, userMs: 600_000, modelMs: 1_200_000, pollingMs: 0 },
  rows: [row("pnpm test", "test", true, 3_723_000, { hist: H([[7, 2], [8, 6], [9, 4]]) }), row("git status", "vcs", false, 900, { peak: null, trend: null, errorRate: 0, hist: H([[0, 10], [1, 2]]), maxMs: 30 }), row("untimed", "other", false, 0, { timedCalls: 0 })],
  histEdgesMs: EDGES,
  heavy: { peak: 3, peakAt: "2026-10-10T10:00:00.000Z", atLeastMs: [60000, 1000], slowdown: 1.8 },
  now: { at: "z", host: "h", load1: 2.5, cpus: 8, memAvailPct: 40, running: [{ session: "s1", harness: "claude", family: "pnpm test", kind: "test", heavy: true, ageSec: 75, rssMb: 512, bg: false }], heavyRunning: 1 },
  guard: null, warnings: [], pending: 0, at: 1 });
const seen: Record<string, unknown>[] = [];
function mount(path: string) {
  const live = fakeLive([], { "wait.get": (p: Record<string, unknown>) => { seen.push(p); if (p.filter === "tool is") throw new ApiFail({ code: "bad_filter", msg: "filter: a value is missing at column 8", hint: "" }); return report(p); } }); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: [path] }))} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
}
afterEach(() => { cleanup(); seen.length = 0; });
test("dur", () => { expect(dur(3_723_000)).toBe("1h 2m"); expect(dur(42_000)).toBe("42s"); expect(dur(900)).toBe("0.9s"); expect(dur(null)).toBe("·"); });
test("rows, agent time, now, heavy at once", async () => {
  mount("/wait");
  const rows = await screen.findByRole("region", { name: "Wait rows" });
  const tr = within(rows).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
  expect(tr[0]).toContain("◆ pnpm test"); expect(tr[0]).toContain("25%"); expect(tr[0]).toContain("1h 2m"); expect(tr[0]).toContain("42s"); expect(tr[0]).toContain("+50%"); expect(tr[0]).toContain("3");
  expect(tr[1]).not.toContain("◆");
  expect(screen.getByRole("region", { name: "Agent time" }).textContent).toContain("tools 30m 0s");
  const now = screen.getByRole("region", { name: "Now" }).textContent ?? "";
  expect(now).toContain("pnpm test"); expect(now).toContain("1m 15s · 512 MB"); expect(now).toContain("peak 3"); expect(now).toContain("×1.8");
  expect(seen[0]).toEqual({ since: "7d", by: "family", limit: 30 });
});
test("period, grouping and filter from the URL and the buttons", async () => {
  mount("/wait?p=m&by=kind&f=harness%20is%20claude");
  await screen.findByRole("region", { name: "Wait rows" });
  expect(seen[0]).toEqual({ since: "30d", by: "kind", limit: 30, filter: "harness is claude" });
  await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "tool" })); await new Promise((r) => setTimeout(r, 20)); });
  expect(seen.at(-1)).toMatchObject({ by: "tool", since: "30d" });
  await act(async () => { fireEvent.keyDown(window, { key: "d" }); await new Promise((r) => setTimeout(r, 20)); });
  expect(seen.at(-1)).toMatchObject({ since: "today" });
});
test("a bad filter: its message", async () => {
  mount("/wait?f=tool%20is");
  expect((await screen.findByRole("alert")).textContent).toContain("a value is missing at column 8");
});
test("histQ: the bucket's geometric middle, never above the max; empty is null", () => {
  expect(histQ(H([[0, 4]]), EDGES, 0.5, 1e9)).toBe(5);
  expect(histQ(H([[2, 1]]), EDGES, 0.5, 1e9)).toBeCloseTo(Math.sqrt(25 * 50));
  expect(histQ(H([[15, 1]]), EDGES, 0.5, 3_000_000)).toBe(3_000_000); // the open last bucket: the max
  expect(histQ(H([[9, 1]]), EDGES, 0.5, 6000)).toBe(6000);
  expect([dms(1), dms(35), dms(3536)]).toEqual(["1.0ms", "35ms", "3.5s"]);
  expect(histQ(H([]), EDGES, 0.5, 1)).toBeNull(); expect(boxOf(H([]), EDGES, 1)).toBeNull();
});
test("the duration boxes: one per timed row, the slowest median in the summary, quantiles in the table", async () => {
  mount("/wait");
  const f = await screen.findByRole("region", { name: "Call durations" });
  expect(within(f).getByRole("img").getAttribute("aria-label")).toContain("2 commands with the most time · slowest median pnpm test 3.5s · widest pnpm test p95 7.1s");
  fireEvent.click(within(f).getByRole("button", { name: "table" }));
  const tr = within(within(f).getByRole("table")).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
  expect(tr.length).toBe(2); expect(tr[0]).toMatch(/^pnpm test12/); expect(tr[1]).toMatch(/^git status12/);
});
