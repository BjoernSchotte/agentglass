// the shell in jsdom over a fake socket: sidebar collapse kept (and storage that throws breaks nothing), ? opens the
// help with every shortcut, the palette lists items with key hints and fuzzy-matches "sess", the URL keeps the filter
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { fakeLive } from "./fake-live.ts";
import { LiveCtx } from "../src/app.tsx";
import { makeRouter } from "../src/router.tsx";
import { SHORTCUTS } from "../src/shell/shortcuts.ts";
import { validateSessions } from "../src/routes/sessions.tsx";

export async function app(path = "/sessions", teams: { id: string; name: string }[] = [], answers: Record<string, unknown> = {}, topics: Record<string, unknown[]> = {}) {
  const live = fakeLive(teams, answers, topics); live.connect();
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
  expect(await screen.findByRole("button", { name: "Expand the sidebar" })).toBeTruthy();
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
  await waitFor(() => expect(screen.getAllByRole("option").some((o) => (o.textContent ?? "").includes("Go to Sessions"))).toBe(true));
});
test("with a team: the Team section and g t", async () => {
  const r = await app("/sessions", [{ id: "t1", name: "acme" }]);
  expect(await screen.findByRole("link", { name: /Team/ })).toBeTruthy(); // meta answers asynchronously
  fireEvent.keyDown(window, { key: "g" }); fireEvent.keyDown(window, { key: "t" });
  await waitFor(() => expect(r.state.location.pathname).toBe("/team"));
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
  expect(((await screen.findByLabelText("Filter")) as HTMLInputElement).value).toBe("harness is codex");
});
