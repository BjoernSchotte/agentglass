// agentglass — `agentglass fleet pull` (fleet spec 4.1): what a viewer runs on each host over SSH. One process, one ledger
// load: the sessions of the window as `--json` objects, the `cost --json` object and the allowance, as JSON lines
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { complete, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import { cliError } from "../agentenv.ts";
import { sessions, loadHead, loadTail } from "../../model/sessions.ts";
import type { Sess } from "../../model/types.ts";
import { distinct } from "../../model/sessref.ts";
import { BUILD } from "../../build-info.ts";
import { hostId, hostName } from "../../util/hostid.ts";
import { REDACT } from "../redact-on.ts";
import { discover, jsonSess } from "../cli.ts";
import { json, summary } from "../cost-cli.ts";
import { livePid } from "../query/eval.ts";
import { peers } from "../vcs/json.ts";
import { allowanceInfo, codexWins } from "../usage/bill-live.ts";
import { pricesSig } from "../usage/pricing.ts";
import { type HostReport, FORMAT, noOwned } from "./model.ts";
import { sessRowOf, reportLines } from "./report.ts";
import { argVal } from "../../util/argv.ts";

export const DAY_MS = 86400000;
// the top-level sessions updated within days, or live, newest first; twins (one session under two project dirs) once, as
// the copy that stands for them (sessref.ts owns: the live one): the viewer keys rows by host, harness and id
export function pullSessions(days: number, now: number): Sess[] {
  const from = now - days * DAY_MS; const out: Sess[] = [];
  for (const s of sessions.values()) if (s.depth === 0 && !s.parent && (s.mtime >= from || livePid(s) > 0)) out.push(s);
  return distinct(out);
}
// the whole report; discover() first (a CLI run: scan, processes, view)
export function pullReport(days: number, now: number): HostReport {
  discover();
  const sel = pullSessions(days, now);
  // indexed first, then the rows (as --json does: the git attribution is built once)
  for (const s of sel) { loadHead(s); loadTail(s, true); complete(s); for (const c of s.subs) complete(c); peers(s); }
  const rows = sel.map((s: Sess) => sessRowOf(jsonSess(s)));
  const cost = json(summary(""));
  return {
    hello: { format: FORMAT, version: BUILD.version, hostId: hostId(), hostName: REDACT ? "" : hostName(), os: process.platform, tzOffsetMin: -new Date(now).getTimezoneOffset(),
      redact: REDACT, days, now, priceSig: pricesSig() },
    sessions: rows, cost, allowance: { claude: allowanceInfo(now), codex: codexWins() }, live: null, exact: false, owned: noOwned(),
  };
}

// `fleet pull [--days N] [--redact]`: the report on stdout, one line each (a closed reader ends quietly). The host's own
// fleet config is not read: a host never pulls others
export function pullCli(args: string[]): void {
  let days = 7;
  for (let i = 2; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--days") { const v = argVal(args, i) ?? ""; i++; days = /^\d+$/.test(v) ? Number(v) : 0; if (days < 1 || days > 90) cliError("usage", "--days needs a whole number 1–90", "e.g. agentglass fleet pull --days 7", 2); }
    else if (a === "--redact" || a === "--agent" || a === "--no-agent") continue;
    else cliError("usage", "unknown option " + a + " for fleet pull", "agentglass fleet pull [--days N] [--redact]", 2);
  }
  S.cli = true;
  for (const l of reportLines(pullReport(days, Date.now()))) { try { writeSync(1, screenOut(l) + "\n"); } catch (e) { process.exit(0); } }
  process.exit(0);
}
