// agentglass — self-check for `agentglass export`: options, batching, resume, resend, lock, gzip fallback:
// scriptc build src/features/otlp/export.check.ts -o xc && ./xc
// It re-runs itself with HOME = a copy of the Claude + Codex fixtures (agentglass reads HOME once at start).
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { newSpan, type XTurn } from "./types.ts";
import { cfgFrom } from "./config.ts";
import { type ExOpts, parseExport, batches, timeArg, runExport, fxDelta, fxAccepted } from "./export.ts";
import { newState, markTurn, loadState, saveState } from "./state.ts";
import { discover } from "../cli.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const child = process.env["AGENTGLASS_EXPORT_CHILD"] ?? "";
if (!child) {
  // parent: a temp home with the fixtures, files dated a day back (the one-shot quiet rule needs 10 min), then the child
  const t = "/tmp/agentglass-export-check-" + String(process.pid);
  mkdirSync(t + "/home", { recursive: true });
  for (const h of ["claude", "codex"]) execFileSync("cp", ["-R", "testdata/otlp/fixtures/" + h + "/.", t + "/home/"]);
  execFileSync("sh", ["-c", "find \"$1\" -type f -exec touch -t 202609011100 {} +", "sh", t + "/home"]);
  let outp = ""; let code = 0;
  try { outp = execFileSync(process.execPath, [], { encoding: "utf8", env: { HOME: t + "/home", PATH: process.env["PATH"] ?? "", AGENTGLASS_EXPORT_CHILD: t, AGENTGLASS_PARENT_PID: String(process.pid), AGENTGLASS_NOTIFY: "0", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = 1; outp = String(e); }
  rmSync(t, { recursive: true, force: true });
  process.stdout.write(outp);
  process.exit(code);
}

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const C = cfgFrom({});
const env = new Map<string, string>();
function opts(args: string[]): string { const p = parseExport(["export"].concat(args), C, NOW, env); return p.err; }
eq("since 30m", String(timeArg("30m", NOW)), String(NOW - 1800000));
eq("since 7d", String(timeArg("7d", NOW)), String(NOW - 7 * 86400000));
eq("since date (TZ=UTC)", String(timeArg("2026-09-01", NOW)), String(Date.parse("2026-09-01T00:00:00Z")));
eq("since all", String(timeArg("all", NOW)), "0");
eq("bad since", opts(["--otlp", "http://localhost:4318", "--since", "yesterday"]).indexOf("--since takes") >= 0 ? "err" : "ok", "err");
eq("filter: session clause ok", opts(["--otlp", "http://localhost:4318", "--filter", "harness is claude"]), "");
eq("filter: call clause refused", opts(["--otlp", "http://localhost:4318", "--filter", "tool is Bash"]), "export --filter takes session clauses only: tool is Bash");
eq("no endpoint", opts([]).indexOf("no endpoint") >= 0 ? "err" : "ok", "err");
eq("dry run needs no endpoint", opts(["--dry-run"]), "");
eq("batch 0", opts(["--otlp", "http://localhost:4318", "--batch", "0"]).indexOf("--batch") >= 0 ? "err" : "ok", "err");
eq("unknown option", opts(["--otlp", "http://x", "--frobnicate"]).indexOf("unknown option --frobnicate") >= 0 ? "err" : "ok", "err");
eq("default endpoint path", parseExport(["export", "--otlp", "http://localhost:4318"], C, NOW, env).o.url, "http://localhost:4318/v1/traces");

// batching: whole turns; an oversized turn alone; a body over 4 MB split into requests of the same turn
function turnOf(key: string, n: number, pad: number): XTurn {
  const t: XTurn = { h: "claude", rootId: "s", path: "/p", key, index: 1, traceId: "0123456789abcdef0123456789abcdef", t0: 1, t1: 2, closed: true, closedBy: "next", compacted: false, ver: "", cwd: "", branch: "", remote: "", spans: [], fx: [], fxOn: false };
  for (let i = 0; i < n; i++) { const s = newSpan(i ? "execute_tool" : "invoke_agent", "x", "aaaaaaaaaaaa" + String(1000 + i), i ? "aaaaaaaaaaaa1000" : "", 1, "s"); s.tool = "Bash"; s.agent = "a".repeat(pad); t.spans.push(s); }
  return t;
}
const bs = batches([turnOf("a", 10, 0), turnOf("big", 700, 0), turnOf("b", 10, 0), turnOf("c", 10, 0)], 512, 4194304, C);
eq("batches", bs.map((b) => b.turns.map((t: XTurn) => t.key).join("+") + ":" + String(b.spans)).join(" "), "a:10 big:700 b+c:20");
const huge = batches([turnOf("h", 400, 14000)], 512, 4194304, C);
eq("5 MB turn split", String(huge.length >= 2) + " " + String(huge.every((b) => b.json.length <= 4194304 && b.turns[0].key === "h")) + " " + String(huge.reduce((n: number, b) => n + b.spans, 0)), "true true 400");

// fx keeps session totals only (usage-v2.json): the newest turn of a session in a send carries the growth since the
// totals the endpoint already accepted; older turns of the same send carry none (a failed request loses nothing)
{
  const fxTurn = (key: string, t0: number, fx: number[]): XTurn => {
    const t: XTurn = { h: "fx", rootId: "fx-1", path: "/f/events.jsonl", key, index: 1, traceId: "0123456789abcdef0123456789abcdef", t0, t1: t0 + 1, closed: true, closedBy: "quiet", compacted: false, ver: "", cwd: "", branch: "", remote: "", spans: [], fx, fxOn: false };
    const r = newSpan("invoke_agent", "invoke_agent fx", "a" + key.padStart(15, "0"), "", t0, "fx-1");
    const c = newSpan("chat", "chat m", "c" + key.padStart(15, "0"), r.spanId, t0, "fx-1");
    c.nIn = fx[0] ?? 0; c.nOut = fx[1] ?? 0; c.cr = fx[2] ?? 0; c.cw = fx[3] ?? 0; c.cost = fx[4] ?? 0; c.unk = fx[5] ?? 0; c.hasUsage = true; c.total = true; // as advance() leaves it
    t.spans = [r, c]; return t;
  };
  const u = (t: XTurn): string => { const c = t.spans[1]; return c.hasUsage ? [c.nIn, c.nOut, c.cr, c.cw, c.cost, c.unk].join("/") + (c.total ? " delta" : "") : "-"; };
  process.env["AGENTGLASS_OTLP_DIR"] = child + "/fxstate"; const FU = "http://fx.invalid/v1/traces";
  const st = newState(FU);
  const t1 = fxTurn("k1", 1000, [100, 10, 50, 5, 0.5, 0]); const t2 = fxTurn("k2", 2000, [150, 20, 70, 5, 0.75, 0]);
  fxDelta([t2, t1], st, false);
  eq("fx first send: the newest turn carries the totals, the older none", u(t1) + " | " + u(t2), "- | 150/20/70/5/0.75/0 delta");
  for (const t of [t1, t2]) { markTurn(st, t.path, t.h, t.rootId, "", t.key); fxAccepted(st, t); }
  const t3 = fxTurn("k3", 3000, [180, 25, 90, 5, 0.9, 0]);
  fxDelta([t3], st, false);
  eq("fx next run: only the growth since the accepted totals", u(t3), "30/5/20/0/0.15000000000000002/0 delta");
  fxDelta([t3], st, false);
  eq("fx: a retry computes the same delta", u(t3), "30/5/20/0/0.15000000000000002/0 delta");
  fxDelta([t3], st, true);
  eq("fx --resend: the whole totals again", u(t3), "180/25/90/5/0.9/0 delta");
  const same = fxTurn("k4", 4000, [150, 20, 70, 5, 0.75, 0]);
  fxDelta([same], st, false);
  eq("fx: nothing grew = no usage", u(same), "-");
  const reset = fxTurn("k5", 5000, [40, 2, 0, 0, 0.1, 0]);
  fxDelta([reset], st, false);
  eq("fx: a newer turn with smaller totals (a rewritten usage file) = sent whole", u(reset), "40/2/0/0/0.1/0 delta");
  const late = fxTurn("k0", 500, [60, 5, 0, 0, 0.3, 0]); // an older turn whose request failed, retried after a newer one got through
  fxDelta([late], st, false);
  eq("fx: an older turn retried late sends nothing", u(late), "-");
  late.fxOn = true; fxAccepted(st, late); // and never moves the base back
  fxDelta([t3], st, false);
  eq("fx: an older turn does not move the base", u(t3), "30/5/20/0/0.15000000000000002/0 delta");
  saveState(FU, st);
  const back = loadState(FU); fxDelta([t3], back, false);
  eq("fx: the accepted totals survive in the state file", u(t3), "30/5/20/0/0.15000000000000002/0 delta");
  const claude = turnOf("c", 2, 0); fxDelta([claude], st, false);
  eq("fx: other harnesses untouched", String(claude.spans[1].hasUsage), "false");
}

// runs against a fake curl: span ids received, status per call from a script
const dir = child;
const fake = dir + "/curl";
writeFileSync(fake, "#!/bin/sh\n[ \"$1\" = -V ] && { echo curl 8; exit 0; }\ncat > " + dir + "/cfg\n" +
  "n=$(cat " + dir + "/n 2>/dev/null || echo 0); n=$((n+1)); echo $n > " + dir + "/n\n" +
  "st=$(sed -n \"${n}p\" " + dir + "/script); [ -n \"$st\" ] || st=200\n" +
  "b=$(sed -n 's/^data-binary = \"@\\(.*\\)\"$/\\1/p' " + dir + "/cfg)\n" +
  "if grep -q 'Content-Encoding: gzip' " + dir + "/cfg; then echo gz >> " + dir + "/enc; gzip -dc \"$b\" > " + dir + "/body; else echo plain >> " + dir + "/enc; cp \"$b\" " + dir + "/body; fi\n" +
  "[ \"$st\" = 200 ] && grep -o '\"spanId\":\"[0-9a-f]*\"' " + dir + "/body >> " + dir + "/ids\n" +
  "printf '{}\\n%s' \"$st\"\n");
chmodSync(fake, 0o755);
process.env["AGENTGLASS_CURL"] = fake; process.env["AGENTGLASS_OTLP_DIR"] = dir + "/otlp";
function reset(script: string[]): void { writeFileSync(dir + "/script", script.join("\n") + "\n"); writeFileSync(dir + "/n", "0"); writeFileSync(dir + "/enc", ""); }
function ids(): string[] { return existsSync(dir + "/ids") ? readFileSync(dir + "/ids", "utf8").trim().split("\n").filter((x: string) => x.length > 0) : []; }
function run(args: string[]): number { const p = parseExport(["export", "--otlp", "http://localhost:4318", "--since", "all"].concat(args), cfgFrom({}), Date.now(), env); if (p.err) { console.log("parse: " + p.err); return 2; } return runExport(p.o, cfgFrom({})); }
discover();
// resume: the 2nd of 4 requests fails → exit 1, the others' turns are marked; the rerun sends only the missing turn
reset(["200", "500", "200", "200"]);
eq("partial failure exit", String(run(["--batch", "12"])), "1");
const first = ids().length;
reset(["200"]);
eq("rerun exit", String(run(["--batch", "12"])), "0");
const all = ids();
eq("rerun sent only the rest", String(all.length - first > 0 && all.length - first <= 4), "true");
eq("no span id sent twice", String(new Set(all).size === all.length), "true");
reset([]);
eq("nothing left", String(run([])) + " " + String(ids().length === all.length), "0 true");
// resend: everything again, the same ids
reset([]);
run(["--resend"]);
const again = ids().slice(all.length);
eq("resend: same ids", [...again].sort().join(",") === [...all].sort().join(",") ? "same" : "differ " + String(again.length) + "/" + String(all.length), "same");
// lock held by a live process → exit 3
const lp = dir + "/otlp/" + execFileSync("sh", ["-c", "ls \"$1\" | grep '^state-.*json$' | head -1", "sh", dir + "/otlp"], { encoding: "utf8" }).trim().replace(/\.json$/, ".lock");
writeFileSync(lp, process.env["AGENTGLASS_PARENT_PID"] ?? "1");
eq("locked", String(run(["--resend"])), "3");
rmSync(lp, { force: true });
// gzip refused with 415: plain resend works, recorded; the next run starts plain
reset(["415", "200"]);
run(["--resend", "--harness", "claude"]);
const enc1 = readFileSync(dir + "/enc", "utf8").trim().split("\n").join("+");
reset([]);
run(["--resend", "--harness", "claude"]);
const enc2 = readFileSync(dir + "/enc", "utf8").trim().split("\n").join("+");
eq("415 → plain, remembered", enc1 + " / " + enc2, "gz+plain / plain");
reset([]);
run(["--resend", "--harness", "claude", "--compression", "gzip"]);
eq("--compression gzip tries again", readFileSync(dir + "/enc", "utf8").trim(), "gz");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp export: all checks passed");
