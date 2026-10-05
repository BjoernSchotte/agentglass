// agentglass — self-check for the Stats price panel ($) and its palette entries: scriptc build src/features/usage/pricepanel.check.ts -o pp && ./pp
// SPDX-License-Identifier: Apache-2.0
// Writes prices.json under check.sh's temp HOME ($HOME/.agentglass/prices.json).
import { readFileSync, existsSync } from "node:fs";
import { S } from "../../state.ts";
import { H, type Action, type Ctx } from "../../hooks.ts";
import { onInput } from "../../input.ts";
import { vwidth } from "../../util/text.ts";
import { fxBase, fxSession, isoAt } from "../query/fixture.ts";
import { PRICES_FILE } from "./pricing.ts";
import { type PRow } from "./pricerows.ts";
import { PP, panelRows, panelLines, panelKey, suggestAlias } from "./pricepanel.ts";
import { todayKey } from "./record.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
if (!process.env.AGENTGLASS_HERMETIC) { console.log("pricepanel: skipped (needs check.sh's temp HOME)"); process.exit(0); }
const mode = (): string => String(S.mode); // not narrowed by the assignments below
const strip = (s: string): string => s.split(/\x1b\[[0-9;]*m/).join("");

fxBase(); // claude-sonnet-4-5 (priced), codex gpt-x-unpriced (unpriced)
const t = isoAt(0, 11, 0);
fxSession("pi", "p1", "/w/pi", "", "claude-sonnet-5-5", [
  "{\"type\":\"session\",\"version\":3,\"id\":\"p1\",\"timestamp\":\"" + t + "\",\"cwd\":\"/w/pi\"}",
  "{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"" + t + "\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"model\":\"claude-sonnet-5-5\",\"provider\":\"cliproxy\",\"usage\":{\"input\":100,\"output\":10,\"cacheRead\":0,\"cacheWrite\":0,\"cost\":{\"total\":0.5}},\"stopReason\":\"stop\"}}"]);
const days = [todayKey()];
PP.period = (): string[] => days;
const names = (rs: PRow[]): string => rs.map((r: PRow) => r.model + ":" + r.src).join(" ");
let rows = panelRows(days);
ok("unpriced first", rows.length >= 3 && (rows[0]?.model ?? "") === "gpt-x-unpriced" && (rows[0]?.src ?? "") === "unpriced", names(rows));
const pi = rows.find((r: PRow) => r.model === "claude-sonnet-5-5");
ok("harness-reported row", !!pi && pi.src === "harness" && pi.rh === "pi", pi ? pi.src + "/" + pi.rh : "missing");

// layout: every line fits, ids ≤ 18 chars stay whole, at 80 and 120 columns
for (const w of [80, 120, 60]) {
  const ls = panelLines(rows, w, 10, 0, 0);
  let wide = 0; for (const l of ls) wide = Math.max(wide, vwidth(l));
  ok("fits " + w, wide <= w - 2, String(wide));
  const all = strip(ls.join("\n"));
  ok("full ids at " + w, all.indexOf("gpt-x-unpriced") >= 0 && all.indexOf("claude-sonnet-4-5") >= 0, all);
  ok("source column at " + w, all.indexOf("unpriced") >= 0 && all.indexOf("harness") >= 0 && all.indexOf("built-in") >= 0, all);
  if (w >= 80) ok("price columns at " + w, all.indexOf("$IN") >= 0 && all.indexOf("3.00") >= 0, all);
}
ok("note under the selected harness row", strip(panelLines(rows, 120, 10, rows.indexOf(pi ?? rows[0]), 0).join("\n")).indexOf("cost reported by pi — a user price applies only to its unpriced messages") >= 0, "no note");

// palette: one "Set price for" per unpriced model of the period
const c: Ctx = { mode: "list", prevMode: "list", tab: 0, fview: "", sel: 0, psel: 0, sess: null, ev: -1 };
const dyn = (): string[] => { const o: string[] = []; for (const f of H.dynActions) for (const a of f()) if (a.when(c)) o.push(a.title); return o; };
ok("palette entry while unpriced", dyn().indexOf("Set price for gpt-x-unpriced") >= 0, dyn().join(" | "));

// edit price: enter on the unpriced row opens the input line, empty
S.mode = "list"; PP.open = true; PP.sel = 0;
ok("enter handled", panelKey("enter", days), "not handled");
ok("price-set opened, empty", mode() === "input" && S.inputAction === "price-set" && S.inputText === "" && S.inputLabel.indexOf("price gpt-x-unpriced ($/Mtok: in out") === 0, mode() + " " + S.inputAction + " [" + S.inputText + "] " + S.inputLabel);
for (const ch of Array.from("abc 1")) onInput(ch);
onInput("enter");
ok("invalid stays open", mode() === "input" && S.inputErr === "\"abc\" is not a number", mode() + " " + S.inputErr);
onInput("ctrl-u"); for (const ch of Array.from("1.25 10")) onInput(ch);
onInput("enter");
ok("valid closes", mode() === "list" && S.inputErr === "", mode() + " " + S.inputErr);
ok("file written", existsSync(PRICES_FILE) && JSON.stringify(JSON.parse(readFileSync(PRICES_FILE, "utf8"))) === "{\"gpt-x-unpriced\":{\"input\":1.25,\"output\":10}}", existsSync(PRICES_FILE) ? readFileSync(PRICES_FILE, "utf8") : "missing");
ok("toast", S.toast.indexOf("gpt-x-unpriced: user price $1.25/$10 — history re-priced, today +$") === 0, S.toast);
rows = panelRows(days);
const gx = rows.find((r: PRow) => r.model === "gpt-x-unpriced");
ok("re-priced in place", !!gx && gx.src === "user" && gx.cost > 0 && gx.unk === 0, gx ? gx.src + " " + gx.cost + " " + gx.unk : "missing");
ok("palette entry gone", dyn().indexOf("Set price for gpt-x-unpriced") < 0, dyn().join(" | "));
// pre-fill of a priced model
PP.sel = rows.indexOf(gx ?? rows[0]); panelKey("enter", days);
ok("pre-filled", S.inputText === "1.25 10", S.inputText);
onInput("esc");
// remove: x then y
panelKey("x", days);
ok("confirm asked", mode() === "confirm" && S.confirmText.indexOf("remove the user price of gpt-x-unpriced") === 0, mode() + " " + S.confirmText);
onInput("y");
ok("removed", JSON.stringify(JSON.parse(readFileSync(PRICES_FILE, "utf8"))) === "{}", readFileSync(PRICES_FILE, "utf8"));
rows = panelRows(days);
ok("unpriced again", (rows[0]?.model ?? "") === "gpt-x-unpriced" && (rows[0]?.src ?? "") === "unpriced", names(rows));

// alias: suggestion, unpriced target refused, valid target written
PP.sel = 0; panelKey("a", days);
ok("alias line", mode() === "input" && S.inputAction === "price-alias" && S.inputLabel === "price gpt-x-unpriced like:", S.inputAction + " " + S.inputLabel);
ok("suggestion: the priced model with most tokens of its harness, else any", S.inputText === suggestAlias("gpt-x-unpriced", days), S.inputText);
onInput("ctrl-u"); for (const ch of Array.from("nope")) onInput(ch); onInput("enter");
ok("unpriced target refused", mode() === "input" && S.inputErr.indexOf("nope has no price") === 0, S.inputErr);
onInput("ctrl-u"); for (const ch of Array.from("claude-sonnet-4")) onInput(ch); onInput("tab");
ok("tab completes a priced id", S.inputText === "claude-sonnet-4-5", S.inputText);
onInput("enter");
rows = panelRows(days);
const ga = rows.find((r: PRow) => r.model === "gpt-x-unpriced");
ok("alias row", !!ga && ga.src === "alias" && ga.via === "claude-sonnet-4-5" && ga.est > 0, ga ? ga.src + " " + ga.via + " " + ga.est : "missing");
ok("alias toast", S.toast.indexOf("gpt-x-unpriced: ≈ claude-sonnet-4-5") === 0, S.toast);
ok("alias source label", strip(panelLines(rows, 100, 10, 0, 0).join("\n")).indexOf("≈ claude-sonnet-4-5") >= 0, "no ≈ label");

// a harness-priced model: the label and the toast say what a user price does
PP.sel = panelRows(days).findIndex((r: PRow) => r.model === "claude-sonnet-5-5"); panelKey("enter", days);
ok("harness label", S.inputLabel.indexOf("cost reported by pi") >= 0, S.inputLabel);
onInput("ctrl-u"); for (const ch of Array.from("1 1")) onInput(ch); onInput("enter");
ok("harness toast", S.toast.indexOf("cost reported by pi") >= 0, S.toast);
// close
panelKey("$", days); ok("$ closes", !PP.open, "open");
const acts: Action[] = H.actions.filter((a: Action) => a.id === "prices.panel");
ok("static palette action", acts.length === 1 && acts[0]?.keys === "$", String(acts.length));

console.log(bad ? bad + " failed" : "pricepanel: all checks passed");
if (bad) process.exit(1);
