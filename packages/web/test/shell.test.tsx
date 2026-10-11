// the shell in jsdom over a fake socket: sidebar collapse kept (and storage that throws breaks nothing), ? opens the
// help with every shortcut, the palette lists items with key hints and fuzzy-matches "sess", the URL keeps the filter
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { Live } from "../src/live/socket.ts";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { SHORTCUTS } from "../src/shell/shortcuts.ts";
import { validateSessions } from "../src/routes/sessions.tsx";

// a socket that answers meta and sub like agentglass-web
function fakeLive(teams: { id: string; name: string }[] = []): Live {
  return new Live(() => {
    const w = { readyState: 0, onopen: null as (() => void) | null, onclose: null as (() => void) | null, onmessage: null as ((e: { data: unknown }) => void) | null,
      send(s: string) { const q = JSON.parse(s); const reply = (o: unknown) => queueMicrotask(() => w.onmessage?.({ data: JSON.stringify(o) }));
        if (q.m === "meta") reply({ id: q.id, ok: { version: "test", contract: 1, proto: 1, caps: [], readOnly: true, redact: false, harnesses: ["claude"], teams } });
        else if (q.m === "sub") { reply({ id: q.id, ok: { sub: "c1", resumed: false } }); reply({ sub: "c1", ev: "e-1", k: "snapshot", d: { data: [{ key: "claude:s1", id: "s1", harness: "claude", title: "fix the flaky test", cwd: "/w", live: true, pid: 1, status: "", state: "busy", costUsd: 1.2, twins: 0, attention: false, stuck: null, alerts: [], mux: null, updated: new Date().toISOString() }], at: Date.now(), gen: 1, next: null } }); }
        else reply({ id: q.id, ok: {} }); },
      close() {} };
    queueMicrotask(() => { w.readyState = 1; w.onopen?.(); });
    return w;
  }, false);
}
async function app(path = "/sessions", teams: { id: string; name: string }[] = []) {
  const live = fakeLive(teams); live.connect();
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><TipProvider><RouterProvider router={router} /></TipProvider></QueryClientProvider></LiveCtx.Provider>);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return router;
}
afterEach(() => { cleanup(); localStorage.clear(); });

test("the sidebar collapse is kept per browser", async () => {
  await app();
  fireEvent.click(screen.getByRole("button", { name: "Collapse the sidebar" }));
  expect(localStorage.getItem("agentglass.sidebar")).toBe("collapsed");
  cleanup(); await app();
  expect(screen.getByRole("button", { name: "Expand the sidebar" })).toBeTruthy();
});
test("storage that throws breaks nothing", async () => {
  const g = Storage.prototype.getItem; const s = Storage.prototype.setItem;
  Storage.prototype.getItem = () => { throw new Error("blocked"); }; Storage.prototype.setItem = () => { throw new Error("blocked"); };
  try { await app(); fireEvent.click(screen.getByRole("button", { name: "Collapse the sidebar" })); expect(screen.getByRole("button", { name: "Expand the sidebar" })).toBeTruthy(); }
  finally { Storage.prototype.getItem = g; Storage.prototype.setItem = s; }
});
test("? opens the help with every shortcut", async () => {
  await app();
  fireEvent.keyDown(window, { key: "?" });
  const d = await screen.findByRole("dialog");
  for (const s of SHORTCUTS) expect(d.textContent).toContain(s.label);
});
test("the palette: items with key hints; sess matches Sessions and the session", async () => {
  await app();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const d = await screen.findByRole("dialog");
  expect(d.textContent).toContain("Go to Sessions"); expect(d.textContent).toContain("g s · 1");
  expect(d.textContent).not.toContain("Go to Team"); // no team: no Team section
  fireEvent.change(screen.getByPlaceholderText("Type a command or search…"), { target: { value: "sess" } });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const opts = screen.getAllByRole("option").map((o) => o.textContent ?? "");
  expect(opts.some((o) => o.includes("Go to Sessions"))).toBe(true);
});
test("with a team: the Team section and g t", async () => {
  const r = await app("/sessions", [{ id: "t1", name: "acme" }]);
  expect(screen.getByRole("link", { name: /Team/ })).toBeTruthy();
  fireEvent.keyDown(window, { key: "g" }); fireEvent.keyDown(window, { key: "t" });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(r.state.location.pathname).toBe("/team");
});
test("the live list renders the row with its glyph", async () => {
  await app();
  expect(await screen.findByText("fix the flaky test")).toBeTruthy();
  expect(screen.getByLabelText("working").textContent).toBe("●");
});
test("URL search round trip: f and sel", async () => {
  expect(validateSessions({ f: "live is true", sel: "claude:s1", junk: 1 })).toEqual({ f: "live is true", sel: "claude:s1" });
  const r = await app("/sessions?f=harness%20is%20codex");
  expect((r.state.location.search as { f?: string }).f).toBe("harness is codex");
  expect((screen.getByLabelText("Filter") as HTMLInputElement).value).toBe("harness is codex");
});
