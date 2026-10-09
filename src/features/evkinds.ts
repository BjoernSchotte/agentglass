// agentglass — the event-kind filter's wiring (ui/evfilter.ts holds the state): the / expression input with completion
// and carets, the debounced save of the per-view filters, palette entries ("Show only skills" …) and the ? help section
// SPDX-License-Identifier: Apache-2.0
import { S, say } from "../state.ts";
import { H, type Ctx, type Action, tabAt } from "../hooks.ts";
import { famsIn, kindsOfFam } from "../model/kinds.ts";
import { EVK } from "./query/attrs.ts";
import { cycleNext, exprErr, newCyc } from "./query/ui.ts";
import { addClause } from "./query/scope.ts";
import { parse } from "./query/parse.ts";
import { INPUT, PRESETS, hasCount, countText, vfOf, vfSet, preset, flush, label, active, barView, barKinds, closeBar, chipKey } from "../ui/evfilter.ts";
import { restore } from "./palette/actions.ts";
import { openGraph } from "./callgraph/view.ts";
import type { Sess } from "../model/types.ts";

// the event view a palette origin (or the current screen) is in: "" none
export function viewOfCtx(mode: string, fview: string, tab: number): string {
  if (mode === "transcript" || mode === "detail") return "transcript";
  if (mode === "view" && fview === "call graph") return "callgraph";
  if (mode === "view" && fview === "related") return "related";
  const t = tabAt(tab - 2);
  if (mode === "list" && t && t.name === "Wait") return "wait";
  return "";
}
// the session behind the open filter input (completion offers what that view holds)
const EVS = { kinds: (): string[] => [] as string[], vals: (key: string): string[] => [] as string[] };
export const EV_SOURCE = EVS; // views set these while their input is open (transcript: its events)
EVK.present = (): string[] => S.inputAction === "evfilter" ? EVS.kinds() : [];
EVK.values = (key: string): string[] => S.inputAction === "evfilter" ? EVS.vals(key) : [];
// the kinds of a transcript's events, families first (completion)
export function kindsFor(m: Map<string, number>): string[] { const o: string[] = []; for (const f of famsIn(m)) { o.push(f); for (const k of kindsOfFam(m, f)) o.push(k); } return o; }

const cyc = newCyc();
function err(t: string): string { return exprErr(t, "events", ""); }
H.input.push((action: string, ev: string, text: string): boolean => {
  if (action !== "evfilter") return false;
  if (ev === "change") { S.inputErr = err(text); if (text !== cyc.last) cyc.cands = []; return false; }
  if (ev === "tab") { const next = cycleNext(cyc, text); if (next) { S.inputText = next; S.inputErr = err(next); } return false; }
  if (ev === "esc") { S.inputErr = ""; return false; }
  if (ev !== "enter") return false;
  const e = vfSet(INPUT.view, text);
  if (e) { S.inputErr = e; S.inputErrCol = vfOf(INPUT.view).errCol; say("warn", e); return true; } // the last valid filter stays
  say("info", text.trim() ? "showing " + label(INPUT.view) + " — esc clears" : "all events");
  return false;
});
// a link's view= and f= (palette/open.ts applyTarget, after the transcript opened): the filter, then the call graph
H.linkView.push((view: string, f: string, s: Sess): string => {
  const e = f ? vfSet(view, f) : "";
  if (view === "callgraph") openGraph(s);
  return e ? "the link's filter was not applied: " + e : "";
});
H.onTick.push(() => { flush(false); });
// the chip bar is modal: every key goes to it (? shows help, ctrl-k the palette) while its view is on screen
H.modal.push((mode: string, k: string): boolean => {
  const v = barView(); if (!v) return false;
  if (k === "ctrl-k") { closeBar(); return false; }
  if (viewOfCtx(mode, S.fview, S.tab) !== v) { if (mode !== "help" && mode !== "input" && mode !== "palette" && mode !== "confirm") closeBar(); return false; }
  return chipKey(v, barKinds(), k);
});
// footer: the chip bar's keys while it is open; with a filter its label, count and the keys to step, edit and clear it;
// without one, how to start (K, /, i, !, ] [)
H.footerHints.push((mode: string): string[][] => {
  const v = viewOfCtx(mode, S.fview, S.tab); if (!v || (mode === "list" && !hasCount(v))) return [];
  if (barView() === v) return []; // ui/footer.ts shows the bar's own keys only
  if (active(v)) { const c = countText(v); return [[label(v), c, "1"], ["]/[", "next", "1"], ["K", "edit", "1"], ["esc", "clear"]]; }
  if (mode === "view") return v === "callgraph" ? [["K", "kinds", "3"], ["/", "filter", "3"]] : []; // their own keys fill 80 columns: related shows / filter itself, the rest is in ?
  return [["K", "kinds", "1"], ["i", "solo", "3"], ["!", "invert", "3"], ["/", "filter", "2"], ["]/[", "next match", "3"]];
});
H.onQuit.push(() => { flush(true); });

// ── palette: the presets and file edits, in any event view ──
function inEventView(c: Ctx): boolean { return viewOfCtx(c.mode, c.fview, c.tab) !== ""; }
function show(id: string, title: string, run: (view: string) => void): Action {
  return { id: "events." + id, title, group: "Events", keys: "", when: inEventView, run: (c: Ctx): void => { restore(c); const v = viewOfCtx(c.mode, c.fview, c.tab); if (v) { run(v); say("info", "showing " + label(v) + " — esc clears"); } } };
}
for (const a of [
  show("skills", "Show only skills", (v: string): void => preset(v, 1)),
  show("mcp", "Show only MCP calls", (v: string): void => preset(v, 2)),
  show("errors", "Show only errors and their causes", (v: string): void => preset(v, 4)),
  show("shell", "Show only shell", (v: string): void => preset(v, 3)),
  show("edits", "Show only file edits", (v: string): void => { vfSet(v, "event.kind is edit"); }),
  show("prompts", "Show only my prompts", (v: string): void => preset(v, 5)),
  show("all", "Show all events", (v: string): void => preset(v, 0)),
]) H.actions.push(a);
H.actions.push({ id: "events.pin", title: "Pin this view's event filter (every event view, remembered)", group: "Events", keys: "",
  when: (c: Ctx): boolean => { const v = viewOfCtx(c.mode, c.fview, c.tab); return v !== "" && vfOf(v).expr !== ""; },
  run: (c: Ctx): void => {
    restore(c); const v = viewOfCtx(c.mode, c.fview, c.tab); const p = parse(vfOf(v).expr); if (p.err) return;
    let cs = S.pins; for (const cl of p.cs) cs = addClause(cs, { key: cl.key, op: cl.op, vals: cl.vals, neg: cl.neg, pinned: true }).cs;
    S.pins = cs; say("info", "pinned: " + vfOf(v).expr + " (P edits pins)");
  } });

H.helpSections.push({ name: "event kinds", ctx: "transcript|call graph|related|Wait", keys: [
  ["K", "kind chips: ←→ move · ␣ show/hide · ↵ its kinds · ! invert · 1–6 presets · L link · esc close"],
  ["i", "only the cursor's kind (mcp:github) · again: its family (mcp) · a third time: all"],
  ["!", "invert the kind filter"], ["/", "filter expression: event.kind is skill · mcp.server is github · shell.family ~ test"],
  ["]  [", "next / previous match (no filter: next mark, e.g. a skill load)"], ["esc", "clear the kind filter (esc again: back)"],
  ["L", "one filter in all event views ⇄ a filter per view (remembered)"],
  ["1–6 (in K)", PRESETS.map((p) => p.key + " " + p.name).join(" · ")],
  ["┄ n hidden", "hidden events stay as one dim line (↵ shows them); time views keep their time axis (┄n ticks)"],
  ["^K", "Events: Show only skills · MCP calls · errors and their causes · shell · file edits · my prompts · all"]] });
