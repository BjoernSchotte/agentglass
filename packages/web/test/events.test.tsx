// the drawer's Events tab: events.list with a preset chip or a filter, gaps and a big log's unread head as lines,
// [ ] move between events, a bad filter shows its message and hint
import { render, screen, act, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveCtx } from "../src/app.tsx";
import { Events } from "../src/routes/events.tsx";
import { fakeLive } from "./fake-live.ts";
import { ApiFail } from "../src/live/socket.ts";

const ts = (m: number) => new Date(2026, 9, 11, 9, m).toISOString();
const ev = (i: number, kinds: string[], tool: string | null, target: string | null) => ({ i, ts: ts(i), kind: tool ? "tool" : "user", kinds, tool, id: null, target, text: null, link: "agentglass://x" });
const seen: Record<string, unknown>[] = [];
function list(p: Record<string, unknown>) {
  seen.push(p);
  if (p.filter === "event.kind is") throw new ApiFail({ code: "bad_filter", msg: "filter: a value is missing at column 14", hint: "event.kind is skill" });
  return { session: { harness: "claude", id: "s1", title: "t" }, filter: p.preset === "errors" ? "event.kind is error" : null, preset: p.preset ?? null, matched: 3, total: 40, truncated: true,
    events: [{ unread: 40_000_000 }, ev(1, ["prompt"], null, null), { gap: 12, kinds: { reply: 8, edit: 4 } }, ev(14, ["shell:test"], "Bash", "pnpm"), ev(15, ["error", "shell:test"], "Bash", "pnpm")], at: 1 };
}
function mount() {
  const live = fakeLive([], { "events.list": list }); live.connect();
  render(<LiveCtx.Provider value={live}><QueryClientProvider client={new QueryClient()}><Events refId="claude:s1" /></QueryClientProvider></LiveCtx.Provider>);
}
afterEach(() => { cleanup(); seen.length = 0; });
test("events, a gap and the unread head; a preset chip asks with its preset", async () => {
  mount();
  const ol = await screen.findByRole("list", { name: "Events" });
  const lines = within(ol).getAllByRole("listitem").map((l) => l.textContent ?? "");
  expect(lines[0]).toContain("earlier events not read (40 MB");
  expect(lines[2]).toContain("12 hidden · reply 8 · edit 4");
  expect(lines[3]).toContain("09:14"); expect(lines[3]).toContain("shell:test"); expect(lines[3]).toContain("Bash pnpm");
  expect(screen.getByText(/3 of 40 events/)).toBeTruthy();
  expect(seen[0]).toEqual({ ref: "claude:s1", limit: 500 });
  await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "errors" })); await new Promise((r) => setTimeout(r, 20)); });
  expect(seen.at(-1)).toEqual({ ref: "claude:s1", limit: 500, preset: "errors" });
});
test("] and [ move between events, skipping gaps", async () => {
  mount();
  const ol = await screen.findByRole("list", { name: "Events" });
  const cur = () => within(ol).getAllByRole("listitem").findIndex((l) => l.getAttribute("aria-current") === "true");
  await act(async () => { fireEvent.keyDown(window, { key: "]" }); }); expect(cur()).toBe(1);
  await act(async () => { fireEvent.keyDown(window, { key: "]" }); }); expect(cur()).toBe(3); // the gap is skipped
  await act(async () => { fireEvent.keyDown(window, { key: "[" }); }); expect(cur()).toBe(1);
});
test("a bad filter: the message and the hint", async () => {
  mount();
  await screen.findByRole("list", { name: "Events" });
  const box = screen.getByRole("textbox", { name: "Event filter" });
  await act(async () => { fireEvent.change(box, { target: { value: "event.kind is" } }); fireEvent.submit(box.closest("form")!); await new Promise((r) => setTimeout(r, 20)); });
  const a = await screen.findByRole("alert");
  expect(a.textContent).toContain("a value is missing at column 14"); expect(a.textContent).toContain("event.kind is skill");
});
