// agentglass — `agentglass prices`: every model seen with its price and where it comes from; set / alias / unset write
// prices.json (AGENTGLASS_PRICES or ~/.agentglass/prices.json); `prices update` = --update-prices
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, complete, screenOut } from "../hooks.ts";
import { S } from "../state.ts";
import { sessions } from "../model/sessions.ts";
import type { Obj } from "../util/json.ts";
import { home } from "../util/text.ts";
import { discover } from "./cli.ts";
import { agentHost, agentScope, visible, cliError } from "./agentenv.ts";
import { helpOf, wantsHelp, setOptions, optTable, opt } from "./clihelp.ts";
import { fmtArgs } from "./format.ts";
import { parseSince } from "./queries.ts";
import { dayKey } from "./usage/record.ts";
import { ledger, accOf } from "./usage/ledger.ts";
import { kfmt } from "./usage/costs.ts";
import { type Price, type Resolved, PRICES_FILE, resolve, readUserFile, communitySource, communityFetched } from "./usage/pricing.ts";
import { type PRow, type SessAcc, priceRows, reportedNote, rates, srcLabel } from "./usage/pricerows.ts";
import { reloadPrices } from "./usage/repricer.ts";
import { type PriceIn, parsePriceLine, entryOf, storedKey, setUserEntry, userEntry } from "./usage/userprices.ts";

const LIST_OPTS = setOptions("prices", [
  opt("--json", "", "{file, community, models[{model, source, via, estimated, price, tokens, unpricedTokens, costUsd, reportedCostUsd, note, providers[]}]}", "", []),
  opt("--since", "today|<n>d|YYYY-MM-DD", "only usage from that day on", "all history", []),
  opt("--unpriced", "", "only models without a price; exit 4 when there is one", "", [])]);
const SET_OPTS = setOptions("prices set", [
  opt("--in", "<$>", "input $ per million tokens (required)", "", []), opt("--out", "<$>", "output $ per million tokens (required)", "", []),
  opt("--cache-read", "<$>", "cache read $/Mtok", "0.1 × in", []), opt("--cache-write", "<$>", "5-minute cache write $/Mtok", "1.25 × in", []),
  opt("--cache-write-1h", "<$>", "1-hour cache write $/Mtok", "2 × in", []), opt("--json", "", "{model, stored, before, after, file, note}", "", [])]);
const ALIAS_OPTS = setOptions("prices alias", [opt("--json", "", "{model, stored, before, after, file, note}", "", [])]);
const UNSET_OPTS = setOptions("prices unset", [opt("--json", "", "{model, stored, before, after, file, removed}", "", [])]);
const HELP = `usage: agentglass prices [--json] [--since today|<n>d|YYYY-MM-DD] [--unpriced]
       agentglass prices set <model> --in <$> --out <$> [--cache-read <$>] [--cache-write <$>] [--cache-write-1h <$>]
       agentglass prices alias <model> <target>
       agentglass prices unset <model>
       agentglass prices update                fetch the opted-in community list now (= --update-prices)

  every model with usage and where its price comes from (first hit wins):
    user       a price in prices.json            ≈ <target>  an alias in prices.json: priced like <target> (an estimate, ≈)
    gw <prov>  pi models.json / OpenCode config cost of that provider only
    litellm / models.dev   the opt-in community list            built-in   agentglass's own table
    harness    the harness reported the cost itself (pi, OpenCode, fx): a user price applies only to its unpriced messages
    unpriced   no price: tokens stay visible as unpriced, never $0
  prices are $ per million tokens; models are stored lower case without provider prefix or date suffix

` + optTable(LIST_OPTS.concat(SET_OPTS)) + `

  file: ${home(PRICES_FILE)} (AGENTGLASS_PRICES=<path> uses another one); a running TUI re-prices within 5 s
  {"gpt-6.1-sol": {"input": 1.25, "output": 10, "cacheRead": 0.125}, "codex-auto-review": {"alias": "gpt-6-sol"}}
  exit codes: 0 ok, 1 prices.json unreadable or not JSON (left as it is), 2 usage error, 4 --unpriced listed a model`;

function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
function usage(msg: string, hint: string): never { cliError("usage", msg, hint, 2); }
function r6(n: number): number { return Math.round(n * 1e6) / 1e6; }
function num(n: number): string { return String(r6(n)); }
function priceObj(p: Price | null): Obj | null { if (!p) return null; const r = rates(p); return { in: r6(r[0] ?? 0), out: r6(r[1] ?? 0), cacheRead: r6(r[2] ?? 0), cacheWrite: r6(r[3] ?? 0), cacheWrite1h: r6(r[4] ?? 0) }; }
function wantJson(args: string[]): boolean { const f = fmtArgs(args).fmt; return args.indexOf("--json") >= 0 || f === "json" || (!f && agentHost().on); }

// ── list ──
function rowJson(r: PRow): Obj {
  const ps: Obj[] = []; for (const x of r.provs) ps.push({ provider: x.prov, source: x.src, via: x.via, price: priceObj(x.p) });
  return { model: r.model, source: r.src, via: r.via, estimated: r.src === "alias", price: priceObj(r.p),
    tokens: { in: r.inTok, out: r.outTok, cacheRead: r.cr, cacheWrite: r.cw }, unpricedTokens: r.unk, costUsd: r6(r.cost), reportedCostUsd: r6(r.reported),
    note: reportedNote(r), providers: ps };
}
function pad(s: string, w: number): string { return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function cut(s: string, w: number): string { return s.length > w ? s.slice(0, w - 1) + "…" : s; }
function money(r: PRow): string {
  if (r.cost <= 0) return r.unk > 0 ? "?" : "$0.00";
  const c = r.cost < 1000 ? r.cost.toFixed(2) : kfmt(r.cost);
  return (r.est > 0 ? "≈$" : "$") + c + (r.unk > 0 ? " +?" : "");
}
function list(args: string[]): void {
  const json = wantJson(args); const only = args.indexOf("--unpriced") >= 0;
  let since = ""; let sinceMs = 0;
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--since") { const v = args[++i] ?? ""; const ms = parseSince(v, Date.now()); if (!v || ms < 0) usage("--since must be today, <n>d or YYYY-MM-DD", "agentglass prices --since 7d"); since = dayKey(new Date(ms)); sinceMs = ms; }
    else if (a === "--format") i++;
    else if (["--json", "--unpriced", "--agent", "--no-agent", "--redact", "--all-projects", "--project-only"].indexOf(a) < 0) usage((a.startsWith("-") ? "unknown option " : "unknown subcommand ") + a, "agentglass prices --help");
  }
  S.cli = true;
  const sc = agentScope(args);
  discover();
  const list: SessAcc[] = [];
  for (const s of sessions.values()) {
    if (since && s.mtime < sinceMs) continue; // no day of it is in range
    if (!visible(s, sc)) continue;
    complete(s); list.push({ a: accOf(s), h: s.h });
  }
  let days: string[] | null = null;
  if (since) { const ks = new Set<string>(); for (const x of list) for (const k of x.a.days.keys()) if (k >= since) ks.add(k); days = [...ks]; }
  let rows = priceRows(list, days);
  if (only) rows = rows.filter((r: PRow) => r.src === "unpriced");
  const code = only && rows.length ? 4 : 0;
  if (json) {
    const cs = communitySource();
    const ms: Obj[] = []; for (const r of rows) ms.push(rowJson(r));
    out(JSON.stringify({ file: PRICES_FILE, community: cs ? { source: cs, fetched: communityFetched() } : null, models: ms }));
    process.exit(code);
  }
  if (!rows.length) { out(only ? "no unpriced models" + (since ? " since " + since : "") : "no model usage" + (since ? " since " + since : "")); process.exit(code); }
  const MW = Math.max(18, Math.min(32, rows.reduce((m: number, r: PRow) => Math.max(m, r.model.length), 5)));
  const SW = Math.max(8, Math.min(24, rows.reduce((m: number, r: PRow) => Math.max(m, srcLabel(r).length), 6)));
  out("MODEL".padEnd(MW) + "  " + "SOURCE".padEnd(SW) + pad("$IN", 8) + pad("$OUT", 8) + pad("TOKENS", 9) + pad("COST", 12));
  for (const r of rows) {
    const rt = r.p ? rates(r.p) : [];
    out(cut(r.model, MW).padEnd(MW) + "  " + cut(srcLabel(r), SW).padEnd(SW) + pad(r.p ? (rt[0] ?? 0).toFixed(2) : "—", 8) + pad(r.p ? (rt[1] ?? 0).toFixed(2) : "—", 8) +
      pad(kfmt(r.tok), 9) + pad(money(r), 12));
    const n = reportedNote(r); if (n) out("  " + n);
  }
  const un = rows.filter((r: PRow) => r.src === "unpriced").length;
  if (un && !agentHost().on) out("\n" + un + " unpriced — set one: agentglass prices set <model> --in <$> --out <$>, or price it like another: agentglass prices alias <model> <target>");
  process.exit(code);
}

// ── set / alias / unset ──
function describe(r: Resolved | null): string {
  if (!r) return "unpriced";
  const p = "$" + num(r.p.i) + " in / $" + num(r.p.o) + " out";
  if (r.src === "alias") return "≈ " + r.via + " (" + p + ")";
  if (r.src === "gateway") return "gw " + r.via + " " + p;
  if (r.src === "community") return (r.via || "community") + " " + p;
  return r.src + " " + p;
}
function stateObj(r: Resolved | null): Obj { return { source: r ? r.src : "unpriced", via: r ? r.via : "", price: priceObj(r ? r.p : null) }; }
// the harness-reported note for a model, from the cached ledger (no log is read: the sessions as last indexed)
function noteOf(model: string): string {
  discover(); // loads the ledger cache (H.firstScan)
  const list: SessAcc[] = [];
  for (const [path, a] of ledger) { const s = sessions.get(path); list.push({ a, h: s ? s.h : "" }); }
  const k = storedKey(model);
  for (const r of priceRows(list, null)) if (r.model === k || storedKey(r.model) === k) return reportedNote(r);
  return "";
}
function write(model: string, e: Obj | null): void {
  try { setUserEntry(PRICES_FILE, model, e); }
  catch (x) { cliError("prices_file", x instanceof Error ? x.message : String(x), "fix " + home(PRICES_FILE) + " (it was not changed)", 1); }
  reloadPrices("cli"); // the user layer again, and the ledger this run loaded re-priced (its cache saves consistent)
}
function report(json: boolean, model: string, before: Resolved | null, extra: Obj, note: string): void {
  const k = storedKey(model); const after = resolve(k, "");
  if (json) {
    const o: Obj = { model, stored: k, before: stateObj(before), after: stateObj(after), file: PRICES_FILE, note };
    for (const x of Object.keys(extra)) o[x] = extra[x];
    out(JSON.stringify(o));
  } else {
    out(model + ": " + describe(before) + " → " + describe(after) + " (" + (k !== model ? "stored as " + k + " in " : "in ") + home(PRICES_FILE) + ")");
    if (note) out("  " + note);
  }
  process.exit(0);
}
// <model> and the flags of set; value flags take the next argument
function positional(args: string[], n: number, valued: string[], flags: string[], sub: string): string[] {
  const pos: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const a = args[i] ?? "";
    if (valued.indexOf(a) >= 0) { if (i + 1 >= args.length) usage(a + " needs a value", "agentglass prices " + sub + " --help"); i++; continue; }
    if (a === "--format") { i++; continue; }
    if (a.startsWith("--")) { if (flags.indexOf(a) < 0 && ["--agent", "--no-agent", "--redact"].indexOf(a) < 0) usage("unknown option " + a, "agentglass prices " + sub + " --help"); continue; }
    pos.push(a);
  }
  if (pos.length !== n) usage(n === 1 ? "prices " + sub + " needs one model" : "prices alias needs <model> <target>", "agentglass prices --help");
  return pos;
}
function val(args: string[], f: string): string { const i = args.indexOf(f); return i >= 0 ? args[i + 1] ?? "" : ""; }
function setCmd(args: string[]): void {
  const V = ["--in", "--out", "--cache-read", "--cache-write", "--cache-write-1h"];
  const model = positional(args, 1, V, ["--json"], "set")[0] ?? "";
  if (!val(args, "--in")) usage("--in is needed", "agentglass prices set " + model + " --in 1.25 --out 10");
  if (!val(args, "--out")) usage("--out is needed", "agentglass prices set " + model + " --in " + val(args, "--in") + " --out 10");
  // each value through the TUI input line's parser: the same messages ("abc" is not a number, ≥ 0, ≤ $10000/Mtok)
  const rate = (f: string): number => {
    const v = val(args, f); if (!v) return -1;
    const r = parsePriceLine("0 " + v); if (!r.p) usage(f + ": " + r.err, "agentglass prices set " + model + " --in 1.25 --out 10");
    return r.p ? r.p.o : -1;
  };
  const p: PriceIn = { i: rate("--in"), o: rate("--out"), cr: rate("--cache-read"), cw: rate("--cache-write"), cw1: rate("--cache-write-1h") };
  const before = resolve(storedKey(model), "");
  const note = noteOf(model);
  write(model, entryOf(p));
  report(wantJson(args), model, before, {}, note);
}
function aliasCmd(args: string[]): void {
  const ps = positional(args, 2, [], ["--json"], "alias"); const model = ps[0] ?? ""; const target = ps[1] ?? "";
  const k = storedKey(model); const tk = storedKey(target);
  if (k === tk) usage(model + " cannot be an alias of itself", "agentglass prices alias " + model + " <another model>");
  const tr = resolve(tk, "");
  if (tr && tr.src === "alias") usage("aliases do not chain: " + target + " is an alias of " + tr.via, "agentglass prices alias " + model + " " + tr.via);
  if (!tr) usage(target + " has no price — set one first (agentglass prices set " + target + " …)", "agentglass prices set " + target + " --in <$> --out <$>");
  const before = resolve(k, "");
  const note = noteOf(model);
  write(model, { alias: tk });
  report(wantJson(args), model, before, {}, note);
}
function unsetCmd(args: string[]): void {
  const model = positional(args, 1, [], ["--json"], "unset")[0] ?? "";
  const json = wantJson(args); const before = resolve(storedKey(model), "");
  if (!userEntry(PRICES_FILE, model)) {
    const u = readUserFile(PRICES_FILE);
    if (u.bad) cliError("prices_file", PRICES_FILE + ": " + u.bad, "fix " + home(PRICES_FILE) + " (it was not changed)", 1);
    if (json) out(JSON.stringify({ model, stored: storedKey(model), before: stateObj(before), after: stateObj(before), file: PRICES_FILE, removed: false }));
    else out(model + ": nothing to remove (source: " + (before ? before.src : "unpriced") + ")");
    process.exit(0);
  }
  write(model, null);
  report(json, model, before, { removed: true }, "");
}
function prices(args: string[]): void {
  const sub = args[1] ?? "";
  if (wantsHelp(args)) { out(helpOf(sub === "set" || sub === "alias" || sub === "unset" ? "prices " + sub : "prices", args, HELP)); process.exit(0); }
  if (sub === "update") return; // handled by prices.ts (--update-prices)
  if (sub === "set") setCmd(args);
  else if (sub === "alias") aliasCmd(args);
  else if (sub === "unset") unsetCmd(args);
  else list(args);
}
H.cli.unshift((args: string[]): boolean => {
  if (args[0] !== "prices" || args[1] === "update") return false;
  prices(args);
  return true;
});
