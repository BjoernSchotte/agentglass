// agentglass — golden checks for the CLI formatter: scriptc build src/features/format.check.ts -o fm && ./fm
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../util/json.ts";
import { flatten, pickCols, csvCell, render, defaultFormat } from "./format.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ":\n got  " + JSON.stringify(got) + "\n want " + JSON.stringify(want)); } }
function row(id: string, neg: number, cost: number | null): Obj {
  return { id, title: "Fix, \"quotes\"\nnext", tokens: { in: 1, out: 2 }, cost, tags: ["x", "y"], formula: "=1+2", neg, cjk: "日本語テキスト", emoji: "🚀 go" };
}
const rows: Obj[] = [row("a", -3, null), row("bb", 12, 0.5), row("ccc", 7, 1.23456)];

eq("flatten", JSON.stringify(flatten(row("a", -3, null))), "{\"id\":\"a\",\"title\":\"Fix, \\\"quotes\\\"\\nnext\",\"tokens_in\":1,\"tokens_out\":2,\"cost\":null,\"tags\":\"x;y\",\"formula\":\"=1+2\",\"neg\":-3,\"cjk\":\"日本語テキスト\",\"emoji\":\"🚀 go\"}");
eq("flatten objects in arrays", JSON.stringify(flatten({ s: [{ name: "a", n: 1 }] })), "{\"s\":\"{\\\"name\\\":\\\"a\\\",\\\"n\\\":1}\"}");

eq("json, all fields", render(rows.slice(0, 1), [], "json", false, false, false, 120), "[" + JSON.stringify(row("a", -3, null)) + "]");
eq("json single", render(rows.slice(0, 1), ["id", "tokens"], "json", true, false, false, 120), "{\"id\":\"a\",\"tokens\":{\"in\":1,\"out\":2}}");
eq("json flattened field", render(rows.slice(0, 1), ["tokens_in", "id"], "json", false, false, false, 120), "[{\"tokens_in\":1,\"id\":\"a\"}]");
eq("json pretty", render(rows.slice(0, 1), ["id"], "json", true, true, false, 120), "{\n  \"id\": \"a\"\n}");
eq("jsonl", render(rows, ["id", "cost"], "jsonl", false, false, false, 120), "{\"id\":\"a\",\"cost\":null}\n{\"id\":\"bb\",\"cost\":0.5}\n{\"id\":\"ccc\",\"cost\":1.23456}");

eq("csv", render(rows.slice(0, 2), [], "csv", false, false, false, 120),
  "id,title,tokens_in,tokens_out,cost,tags,formula,neg,cjk,emoji\n" +
  "a,\"Fix, \"\"quotes\"\"\nnext\",1,2,,x;y,'=1+2,-3,日本語テキスト,🚀 go\n" +
  "bb,\"Fix, \"\"quotes\"\"\nnext\",1,2,0.5,x;y,'=1+2,12,日本語テキスト,🚀 go");
eq("csv object field expands", render(rows.slice(0, 1), ["id", "tokens"], "csv", false, false, false, 120), "id,tokens_in,tokens_out\na,1,2");
eq("csv guard +", csvCell("+x"), "'+x");
eq("csv guard @", csvCell("@SUM"), "'@SUM");
eq("csv guard - text", csvCell("-x"), "'-x");
eq("csv number unguarded", csvCell(-3), "-3");
eq("csv CR quoted", csvCell("a\rb"), "\"a\rb\"");
eq("csv null", csvCell(null), "");

// table (3+3+4+14 columns + 4 gaps of 2 leave 8 for the title at 40): CJK/emoji count 2 columns, the widest text column is cut with …, numbers right-aligned, trailing blanks trimmed
eq("table", render(rows, ["id", "neg", "cost", "cjk", "title"], "table", false, false, false, 40),
  "id   neg  cost  cjk             title\n" +
  "a     -3        日本語テキスト  Fix, \"q…\n" +
  "bb    12  0.50  日本語テキスト  Fix, \"q…\n" +
  "ccc    7  1.23  日本語テキスト  Fix, \"q…");
eq("table: decimals per column", render([{ c: 0.0012 }, { c: 0.5 }], [], "table", false, false, false, 40), "     c\n0.0012\n0.5000");
eq("table cuts CJK on a column boundary", render(rows.slice(0, 1), ["cjk", "emoji"], "table", false, false, false, 16),
  "cjk        emoji\n日本語テ…  🚀 go");
eq("table tty header bold", render(rows.slice(0, 1), ["id"], "table", false, false, true, 40), "\x1b[1mid\x1b[0m\na");
eq("table single = key/value", render(rows.slice(0, 1), ["id", "neg", "tokens"], "table", true, false, false, 40), "id          a\nneg         -3\ntokens_in   1\ntokens_out  2");

const pc = pickCols(rows, ["cost", "id"], ["id"], []);
eq("pickCols order", pc.cols.join(",") + "|" + pc.bad.join(","), "cost,id|");
eq("pickCols flattened ok", pickCols(rows, ["tokens_in"], [], []).bad.join(","), "");
eq("pickCols unknown", pickCols(rows, ["nope", "id"], [], []).bad.join(","), "nope");
eq("pickCols defaults", pickCols(rows, [], ["id", "cost"], []).cols.join(","), "id,cost");
eq("pickCols no defaults: every flat key", pickCols(rows.slice(0, 1), [], [], []).cols.length + "", "10");
eq("pickCols known on empty rows", pickCols([], ["costUsd"], [], ["costUsd"]).bad.join(",") + "|" + pickCols([], ["x"], [], ["costUsd"]).bad.join(","), "|x");

eq("default: --json", defaultFormat(false, true, true), "json");
eq("default: agent", defaultFormat(true, true, false), "json");
eq("default: tty", defaultFormat(false, true, false), "table");
eq("default: pipe", defaultFormat(false, false, false), "json");

console.log(bad ? bad + " failed" : "format: all checks passed");
if (bad) process.exit(1);
