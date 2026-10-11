// the Sessions view: sortable columns (click, again reverses, the URL keeps it), the indexing gauge and pending costs,
// the phases before the first rows
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import type { SessionRow } from "@agentglass/api-contract";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { sortKeys, gauge } from "../src/routes/sessions.tsx";
import { Live } from "../src/live/socket.ts";
import { ROW } from "./fake-live.ts";

const row = (k: string, title: string, cost: number | null, updated: string, extra: Partial<SessionRow> = {}): SessionRow => ({ ...ROW, key: k, id: k, title, costUsd: cost, updated, ...extra }) as SessionRow;
const R = [row("a", "beta", 2, "2026-10-11T10:00:00Z"), row("b", "alpha", 9, "2026-10-11T09:00:00Z"), row("c", "gamma", null, "2026-10-11T08:00:00Z", { pending: true }), row("d", "delta", 0.5, "2026-10-11T07:00:00Z")];
const M = new Map(R.map((r) => [r.key!, r]));
test("sortKeys: cost both ways (pending and unknown last), title, default", () => {
  const k = ["a", "b", "c", "d"];
  expect(sortKeys(k, M, "-cost")).toEqual(["b", "a", "d", "c"]);
  expect(sortKeys(k, M, "cost")).toEqual(["d", "a", "b", "c"]);
  expect(sortKeys(k, M, "title")).toEqual(["b", "a", "d", "c"]);
  expect(sortKeys(k, M, undefined)).toEqual(k);
});
test("gauge: percent, bytes left, time", () => {
  expect(gauge({ done: 250e6, total: 1e9, bps: 5e6 }).text).toBe("Indexing your history: 25% · 750 MB left · ~3 min");
  expect(gauge({ done: 0, total: 1e9, bps: 0 }).text).toContain("estimating time");
  expect(gauge({ done: 1e9, total: 1e9, bps: 1 }).pct).toBe(99); // 100 only when it is gone
});

// a socket whose sessions snapshot carries the rows and an indexing state; held: no snapshot (phases)
function live(hold = false, detail: unknown = undefined, fastOnly = false): Live {
  return new Live(() => {
    const w = { readyState: 0, onopen: null as (() => void) | null, onclose: null as (() => void) | null, onmessage: null as ((e: { data: unknown }) => void) | null,
      send(s: string) { const q = JSON.parse(s); const reply = (o: unknown) => queueMicrotask(() => w.onmessage?.({ data: JSON.stringify(o) }));
        if (q.m === "meta") reply({ id: q.id, ok: { version: "t", contract: 1, proto: 1, caps: [], readOnly: true, redact: false, harnesses: [], teams: [], fleetHosts: 0 } });
        else if (q.m === "sub") { reply({ id: q.id, ok: { sub: "c1", resumed: false } }); if (!hold) reply({ sub: "c1", ev: "e-1", k: "snapshot", d: { data: R, at: 1, gen: 1, next: null, indexing: { done: 250e6, total: 1e9, bps: 5e6 } } }); }
        else if (q.m === "sessions.get") { if (detail !== undefined && (q.p.detail === "fast" || !fastOnly)) reply({ id: q.id, ok: q.p.detail === "fast" ? { ...(detail as object), turns: null, activeMs: null, wallMs: null, detail: "fast" } : detail }); } // undefined: never answers
        else reply({ id: q.id, ok: {} }); },
      close() {} };
    queueMicrotask(() => { w.readyState = 1; w.onopen?.(); });
    return w;
  }, false, async () => true);
}
async function app(l: Live, path = "/sessions") {
  l.connect(); const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<LiveCtx.Provider value={l}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={router} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  return router;
}
afterEach(cleanup);
test("click a header: sorted, again: reversed, the URL keeps it", async () => {
  const r = await app(live());
  await screen.findByText("alpha");
  const titles = () => within(screen.getAllByRole("rowgroup")[1]!).getAllByRole("row").map((x) => x.children[2]!.textContent);
  fireEvent.click(screen.getByRole("button", { name: /Cost/ }));
  await waitFor(() => expect(titles()).toEqual(["alpha", "beta", "delta", "gamma"]));
  expect((r.state.location.search as { s?: string }).s).toBe("-cost");
  expect(screen.getByRole("columnheader", { name: /Cost/ }).getAttribute("aria-sort")).toBe("descending");
  fireEvent.click(screen.getByRole("button", { name: /Cost/ }));
  await waitFor(() => expect(titles()).toEqual(["delta", "beta", "alpha", "gamma"]));
});
test("indexing: the gauge, a progress bar, … for costs still being counted", async () => {
  await app(live());
  expect(await screen.findByText("Indexing your history: 25% · 750 MB left · ~3 min")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  expect(screen.getByTitle("still being counted").textContent).toBe("…");
});
test("before the first rows: what it waits for, not a bare Loading", async () => {
  await app(live(true));
  expect(await screen.findByText("Reading your sessions…")).toBeTruthy();
});
test("the drawer: the row's facts at once, the details when they come", async () => {
  await app(live(false), "/sessions?sel=b");
  const d = await screen.findByRole("dialog");
  expect(d.textContent).toContain("alpha"); expect(d.textContent).toContain("$9.00");
  expect(within(d).getByText("Loading details…")).toBeTruthy();
});
test("the drawer: tools, files and errors from the detail", async () => {
  await app(live(false, { ...R[1], via: "ref", turns: 12, activeMs: 600000, tools: [{ name: "Bash", calls: 40, errors: 3 }], files: [{ path: "/w/src/app.ts", add: 10, del: 2 }], errors: [{ ts: "x", tool: "Bash", arg: "pnpm test" }] }), "/sessions?sel=b");
  const d = await screen.findByRole("dialog");
  await within(d).findByText("Tools");
  expect(d.textContent).toContain("40 calls"); expect(d.textContent).toContain("3 errors"); expect(d.textContent).toContain("src/app.ts"); expect(d.textContent).toContain("+10"); expect(d.textContent).toContain("pnpm test"); expect(d.textContent).toContain("10 min");
  expect(within(d).queryByText("Loading details…")).toBeNull();
});
test("the drawer: the index's answer at once, turns when the transcript is read", async () => {
  const det = { ...R[1], via: "ref", turns: 12, activeMs: 600000, tools: [{ name: "Bash", calls: 40, errors: 3 }] };
  await app(live(false, det, true), "/sessions?sel=b");
  const d = await screen.findByRole("dialog");
  await within(d).findByText("Tools"); expect(d.textContent).toContain("40 calls");
  expect(d.textContent).toContain("reading the transcript…"); expect(d.textContent).not.toContain("10 min");
});
test("the drawer: a session outside the live list (old, a subagent) comes from sessions.get", async () => {
  await app(live(false, { ...ROW, key: "claude:old", id: "old", title: "an old opus run", costUsd: 31, via: "ref", parent: "s1" }), "/sessions?sel=claude:old");
  const d = await screen.findByRole("dialog");
  await within(d).findAllByText("an old opus run"); expect(d.textContent).toContain("$31.00");
});
