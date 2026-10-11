// the Fleet page: problems first, state glyph + word, last report age, sessions (≈ overlap), live, details; the sidebar
// shows Fleet only with hosts configured (meta.fleetHosts)
import { render, screen, cleanup, within } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { fakeLive } from "./fake-live.ts";

const host = (name: string, extra = {}) => ({ name, kind: "ssh", target: name + ".lan", enabled: true, okAgeSec: 120, code: "ok", err: "", version: "2026.10.13", hostId: "h-" + name, redact: false, tzOffsetMin: 120,
  os: "linux", sessions: 40, live: 2, overlap: 0, sharing: "on", dupOf: null, skewSec: 0, exact: true, liveAgeSec: 10, feedOf: null, feeds: [], via: null, ...extra });
const status = { localName: "laptop", hostId: "h-me", at: 1, hosts: [host("ws"), host("nas", { kind: "dir", code: "timeout", err: "ssh: connect timed out", okAgeSec: 90000, live: 0, overlap: 3 }), host("old", { enabled: false, code: "disabled", okAgeSec: null })] };
function mount(path: string, hosts: number) {
  const live = fakeLive([], { "fleet.hosts": status }, {}, hosts); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: [path] }))} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
}
afterEach(cleanup);
test("hosts, problems first, state in words", async () => {
  mount("/fleet", 3);
  const t = await screen.findByRole("table", { name: "Hosts" });
  const rows = within(t).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
  expect(rows[0]).toContain("nas"); expect(rows[0]).toContain("⚠ timeout"); expect(rows[0]).toContain("ssh: connect timed out"); expect(rows[0]).toContain("(≈3)"); expect(rows[0]).toContain("1d ago");
  expect(rows[1]).toContain("ws"); expect(rows[1]).toContain("● ok"); expect(rows[1]).toContain("●2"); expect(rows[1]).toContain("agentglass 2026.10.13 · linux · UTC+2 · exact · live stream on");
  expect(rows[2]).toContain("○ disabled"); expect(rows[2]).toContain("never");
  expect(screen.getByText(/this machine: laptop/)).toBeTruthy();
});
test("the sidebar shows Fleet only with hosts", async () => {
  mount("/sessions", 0);
  const nav = await screen.findByRole("navigation", { name: "Sections" });
  expect(within(nav).queryByText("Fleet")).toBeNull();
  cleanup(); mount("/sessions", 2);
  expect(await within(await screen.findByRole("navigation", { name: "Sections" })).findByText("Fleet")).toBeTruthy();
});
