// the token exchange: a link in the fragment → POST, the fragment leaves history; a new link pasted into an open tab
// (only the fragment changes, the browser does not reload) is noticed
import { bootstrap, watchToken } from "../src/live/auth.ts";
test("the fragment's token is exchanged and removed from the URL", async () => {
  const calls: string[] = []; let replaced = "";
  const f = (async (u: string, o?: RequestInit) => { calls.push((o?.method ?? "GET") + " " + u + " " + (o?.body ?? "")); return new Response(JSON.stringify({ csrf: "c" }), { status: 200 }); }) as typeof fetch;
  const b = await bootstrap({ hash: "#t=abc_DEF-1", pathname: "/", search: "" } as Location, { replaceState: (_: unknown, __: string, u: string) => { replaced = u; } } as unknown as History, f);
  expect(b).toEqual({ csrf: "c", err: "" }); expect(replaced).toBe("/"); expect(calls[0]).toBe('POST /api/v1/session {"token":"abc_DEF-1"}');
});
test("a used or expired link: the error, no session", async () => {
  const f = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  const b = await bootstrap({ hash: "#t=old", pathname: "/", search: "" } as Location, { replaceState: () => {} } as unknown as History, f);
  expect(b.err).toMatch(/used or has expired/);
});
test("a new link pasted into the open tab (only the fragment changes) starts over", () => {
  let n = 0; const stop = watchToken(() => { n++; });
  location.hash = "#t=newtoken123"; window.dispatchEvent(new HashChangeEvent("hashchange"));
  location.hash = "#somethingelse"; window.dispatchEvent(new HashChangeEvent("hashchange"));
  stop(); expect(n).toBe(1);
});
