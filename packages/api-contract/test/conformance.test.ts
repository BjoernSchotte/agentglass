// conformance (local-web-api W3): the real `agentglass serve --stdio` on a fixture HOME — every answer and event
// validates against the schemas, and `agentglass --json` rows validate as session rows. AGENTGLASS_BIN: the binary
// (CI: the build job's artifact); without it the test is skipped with a note.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { validate, type SchemaName } from "../src/index.ts";
import { fixture, type Fixture } from "./fixture.ts";

const BIN = process.env.AGENTGLASS_BIN ?? "";
const run = BIN ? test : test.skip;
if (!BIN) console.log("conformance: skipped (set AGENTGLASS_BIN to an agentglass binary)");
let fx: Fixture;
beforeAll(() => { fx = fixture(); });
afterAll(() => fx?.done());

// a serve child: send lines, collect parsed messages until a predicate holds
function serve(args: string[] = []) {
  const p = Bun.spawn([BIN, "serve", "--stdio", ...args], { env: fx.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const msgs: Record<string, unknown>[] = []; let buf = "";
  const pump = (async () => { const dec = new TextDecoder(); for await (const c of p.stdout) { buf += dec.decode(c); let i; while ((i = buf.indexOf("\n")) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } } })();
  const send = (o: unknown) => { p.stdin.write(JSON.stringify(o) + "\n"); p.stdin.flush(); };
  const until = async (f: (m: Record<string, unknown>) => boolean, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = msgs.find(f); if (m) return m; await Bun.sleep(25); } throw new Error("timeout; got " + JSON.stringify(msgs).slice(0, 800)); };
  return { p, msgs, send, until, close: async () => { p.stdin.end(); await p.exited; await pump; } };
}
function ok(name: SchemaName, v: unknown) { expect(validate(name, v)).toEqual([]); }
const byId = (id: number) => (m: Record<string, unknown>) => m.id === id;

run("every answer and event conforms", async () => {
  const s = serve();
  s.send({ id: 1, m: "hello", p: { client: "conformance", want: 1 } });
  s.send({ id: 2, m: "meta" });
  s.send({ id: 3, m: "sessions.list", p: { limit: 10 } });
  s.send({ id: 4, m: "sessions.get", p: { ref: "aaaa0001" } });
  s.send({ id: 5, m: "sub", p: { topic: "sessions" } });
  s.send({ id: 6, m: "nope" });
  s.send({ id: 7, m: "sessions.list", p: { filter: "cost >" } });
  s.send({ id: 8, m: "team.report", p: {} });
  s.send({ id: 9, m: "cost.get" });
  s.send({ id: 10, m: "cost.get", p: { by: "model", since: "7d" } });
  s.send({ id: 11, m: "alerts.list" });
  s.send({ id: 12, m: "events.list", p: { ref: "aaaa0001" } });
  s.send({ id: 13, m: "wait.get", p: { since: "30d" } });
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) ok("response", await s.until(byId(id)));
  ok("wait", (await s.until(byId(13))).ok);
  ok("events-list", (await s.until(byId(12))).ok);
  ok("alerts-list", (await s.until(byId(11))).ok);
  ok("cost", (await s.until(byId(9))).ok); ok("cost-rows", (await s.until(byId(10))).ok);
  ok("hello", (await s.until(byId(1))).ok); ok("meta", (await s.until(byId(2))).ok); ok("page", (await s.until(byId(3))).ok);
  ok("session-detail", (await s.until(byId(4))).ok);
  expect(((await s.until(byId(6))).err as { code: string }).code).toBe("unknown_method");
  expect(((await s.until(byId(7))).err as { code: string }).code).toBe("bad_filter");
  expect(((await s.until(byId(8))).err as { code: string }).code).toBe("no_team");
  const snap = await s.until((m) => m.k === "snapshot"); ok("event", snap);
  for (const r of (snap.d as { data: unknown[] }).data) ok("session", r); // the sessions topic's rows are session rows
  fx.grow("the log grew");
  const patch = await s.until((m) => m.k === "patch"); ok("event", patch);
  for (const r of (patch.d as { upsert: unknown[] }).upsert) ok("session", r);
  // every message of the run
  for (const m of s.msgs) ok("sub" in m ? "event" : "response", m);
  await s.close();
}, 20000);

run("agentglass --json rows are session rows", async () => {
  const p = Bun.spawnSync([BIN, "--json"], { env: fx.env });
  const rows = JSON.parse(p.stdout.toString()) as unknown[];
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) ok("session", r);
});

run("--redact answers conform and carry no fixture text", async () => {
  const s = serve(["--redact"]);
  s.send({ id: 1, m: "hello", p: { want: 1 } }); s.send({ id: 2, m: "sessions.list", p: {} });
  const r = await s.until(byId(2)); ok("page", r.ok);
  expect(JSON.stringify(r)).not.toContain("fixture topic");
  await s.close();
});
