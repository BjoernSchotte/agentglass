// agentglass serve --stdio — the headless engine behind agentglass-web (local-web-api §1, §3): reads JSON-lines requests
// on stdin, answers on stdout (agentglass-serve/1, docs/cli-contract.md), exits when stdin closes. The engine is the
// TUI's without rendering: discovery, processes, the alert flags; it runs a cadence only while a subscription exists
// (requests alone discover on demand), and pushes patches only when the read model's generation moved.
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, screenOut } from "../hooks.ts";
import { S } from "../state.ts";
import type { Sess } from "../model/types.ts";
import { sessions, scan, buildView, loadTail, probeLive } from "../model/sessions.ts";
import { procs, refreshProcs, refreshSlow } from "../model/procs.ts";
import { addCmd } from "../features/clihelp.ts";
import { cliError } from "../features/agentenv.ts";
import { badArg } from "../util/argv.ts";
import { randomBytes, hex } from "../util/rand.ts";
import { newFramer, push } from "../util/jsonl.ts";
import { discover } from "../read/index.ts";
import { LAZY } from "../read/row.ts";
import { summaryInc } from "../features/usage/summary.ts";
import { BG, indexTick, indexing, indexState } from "../features/usage/ledger.ts";
import { rules } from "../features/rules/state.ts";
import { flags } from "../features/rules/engine.ts";
import { watched, looker, observeWith, watchStep, forgetSession, ledgerRule, ruleOf } from "../features/watchdog.ts";
import { stateOf, severityOf, render } from "../features/rules/engine.ts";
import { unitOf } from "../features/rules/config.ts";
import { recordAlert } from "../read/alerts.ts";
import { complete as ledgerComplete } from "../features/usage/ledger.ts";
import { LIVE, collectLive } from "../features/wait/live.ts";
import { type Srv, newSrv, onLine } from "./proto.ts";
import { step, beat, teamTopics } from "./subs.ts";
import { loadTeams } from "../features/team/state.ts";
import { syncOnce } from "../features/team/sync.ts";

const USAGE = "agentglass serve --stdio [--redact] [--read-only]";
const HELP = `${USAGE}
  the agentglass-serve/1 protocol on stdin/stdout for agentglass-web and integrations: one JSON object per line,
  requests {id, m, p} → {id, ok} | {id, err: {code, msg, hint}}; subscriptions push {sub, ev, k: snapshot|patch|hb, d}
  methods: hello (first: {want: 1}), meta, sessions.list {filter, limit, cursor, subagents}, sessions.get {ref},
  sub {topic: "sessions", filter, limit, subagents, from}, unsub {sub}; exits 0 when stdin closes
  --redact     privacy mode: fake titles, projects and content in every answer
  --read-only  refuse every command (the default in this release: there are no commands yet)
  details: docs/cli-contract.md (agentglass-serve/1)
`;
addCmd({ cmd: "serve", usage: USAGE, summary: "the JSON-lines protocol agentglass-web reads (requests, resumable subscriptions) on stdin/stdout", options: [], fields: [], group: "cmd" });

const TICK_MS = 1500; // the watch cadence (H.onWatch while agents are live): a subscriber sees a grown log within ~1.5 s
const SLOW_MS = 5000; // slow process facts, as the TUI
const FRESH_MS = 1000; // a request reads state at most this old (no subscription: no cadence, discovery on demand)
// as the TUI's Team tab: publish, fetch, admit — only while a team topic is subscribed (AGENTGLASS_TEAM_SYNC_MS: tests)
const TEAM_SYNC_MS = Number(process.env["AGENTGLASS_TEAM_SYNC_MS"] ?? "") || 60000;
const INDEX_MS = 250; const INDEX_PUSH_MS = 1000; // background index: a step every 250 ms (the TUI's tick), rows pushed once a second
const E = { disc: 0, slow: 0, procs: 0, timer: false, ledAt: new Map<string, number>(), teamAt: 0, stepAt: 0 };

// sync write: a closed reader ends the process quietly; the screen filters run as on every CLI line (--redact scrubs)
function send(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
function fresh(): void { const now = Date.now(); if (now - E.disc >= FRESH_MS) { discover(); E.disc = now; E.slow = now; E.procs = now; } }
// the alert flags (attention, stuck) and wait's live heavy commands, as the TUI's watchdog sets them — without its bell,
// desktop note or notify command (the TUI, or agentglass --watch --notify, does that)
function flagStep(now: number): void {
  const rs = rules(); const lk = looker(); const led = ledgerRule(rs);
  const ws: Sess[] = []; for (const s of sessions.values()) if (watched(s)) ws.push(s);
  LIVE.cur = collectLive(ws, lk.kids, now); LIVE.ver++;
  for (const s of sessions.values()) {
    if (!watched(s)) { if (s.attention || s.stuck) { s.attention = false; s.stuck = ""; } forgetSession(s.path); continue; }
    if (led && now - (E.ledAt.get(s.path) ?? 0) >= 10000) { E.ledAt.set(s.path, now); ledgerComplete(s); }
    loadTail(s);
    for (const t of watchStep(s, observeWith(s, lk), rs, now)) { // the alerts log (alerts.list, the alerts topic)
      const r = ruleOf(rs, t.rule); const a = stateOf(s.path, t.rule); if (!r || !a) continue;
      recordAlert(s, { at: t.at, rule: r.id, severity: severityOf(t.to || t.from), state: t.state, value: t.v, threshold: t.thr, unit: unitOf(r.metric), message: render(r, a.v, t.to || t.from, s), labels: r.labels });
    }
    const f = flags(rs, s.path); s.attention = f[0] === "1"; s.stuck = f[1] ?? "";
  }
  for (const p of [...E.ledAt.keys()]) if (!sessions.has(p)) E.ledAt.delete(p);
}
// one engine step while subscribed: logs, processes, view, flags; then patches and heartbeats
function tick(sv: Srv): void {
  E.timer = false;
  if (!sv.hub.subs.size) { // no subscriber: only the background index runs on (a read answered with pending logs), then rest
    indexTick(); if (behind()) { E.timer = true; setTimeout(() => { tick(sv); }, INDEX_MS); }
    return;
  }
  // the background index (a cold start, a resume far behind): a paced step each INDEX_MS, the rows out once a second
  indexTick();
  if (indexing() && Date.now() - E.stepAt < INDEX_PUSH_MS) { E.timer = true; setTimeout(() => { tick(sv); }, INDEX_MS); return; }
  const now = Date.now(); E.stepAt = now;
  scan(); probeLive(); // logs written in the last 10 min each scan, older ones in turns (as the TUI); live ones each tick
  const pr = procs.length > 0 || now - E.procs >= SLOW_MS; // processes as H.onWatch: every tick while agents are live, else every 5 s
  if (pr) { refreshProcs(); E.procs = now; }
  if (now - E.slow >= SLOW_MS) { refreshSlow(); E.slow = now; }
  buildView(); E.disc = now;
  if (pr) flagStep(now); // after a process pass (also when the last agent ended: its flags clear)
  let team = false;
  if (teamTopics(sv.hub) && now - E.teamAt >= TEAM_SYNC_MS) { E.teamAt = now; for (const t of loadTeams()) syncOnce(t, now, false); team = true; }
  step(sv.hub, now, team); beat(sv.hub, now);
  arm(sv);
}
// logs the ledger has not indexed to their end: the background index has work
function behind(): boolean { return indexState().left > 0; }
function arm(sv: Srv): void { if (E.timer || (!sv.hub.subs.size && !behind())) return; E.timer = true; setTimeout(() => { tick(sv); }, indexing() ? INDEX_MS : TICK_MS); }

function serveCli(args: string[]): void {
  const m = badArg(args.slice(1), [], ["--stdio", "--redact", "--read-only"], []); if (m) cliError("usage", m, "agentglass serve --help", 2);
  if (args.indexOf("--stdio") < 0) cliError("usage", "serve needs --stdio (the only transport)", USAGE, 2);
  S.cli = true; // warnings go to stderr, never into the protocol
  LAZY.on = true; BG.on = true; summaryInc(); // rows of logs not indexed yet answer at once (pending); the ledger indexes in the background
  discover(); E.disc = Date.now(); E.slow = E.disc; E.procs = E.disc;
  flagStep(E.disc);
  const sv = newSrv(true, hex(randomBytes(2)), (): number => Date.now(), send, fresh);
  indexTick(); arm(sv); // the background index starts at once (its totals come from this first step), with or without subscribers
  const F = newFramer();
  process.stdin.on("data", (d: Uint8Array) => { for (const f of push(F, d)) onLine(sv, f.line, f.oversize); arm(sv); });
  process.stdin.on("end", () => { process.exit(0); }); // the ledger cache is saved on exit (usage/cache.ts)
  process.on("SIGTERM", () => { process.exit(0); });
  process.on("SIGINT", () => { process.exit(0); });
}
H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: serve --help is this command's
  if (args[0] !== "serve") return false;
  if (args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) { process.stdout.write(HELP); process.exit(0); }
  serveCli(args);
  return true;
});
