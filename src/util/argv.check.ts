// agentglass — self-check for the shared argument rules: scriptc build src/util/argv.check.ts -o ac && ./ac
// SPDX-License-Identifier: Apache-2.0
import { argVal, splitEq, badArg } from "./argv.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const sv = (v: string | null): string => v === null ? "<null>" : v;

// a value is the next argument unless it is a flag; "-x" (a negated filter) is a value
eq("value", sv(argVal(["--filter", "cwd ~ x"], 0)), "cwd ~ x");
eq("flag is no value", sv(argVal(["--otlp", "--filter", "x"], 0)), "<null>");
eq("none at the end", sv(argVal(["--otlp"], 0)), "<null>");
eq("single dash is a value", sv(argVal(["--filter", "-harness is codex"], 0)), "-harness is codex");
eq("empty is a value", sv(argVal(["--filter", ""], 0)), "");

eq("split", splitEq(["--filter=cwd ~ a=b", "--json", "x=y", "--otlp=", "-a=b", "--=x"]).join("|"), "--filter|cwd ~ a=b|--json|x=y|--otlp||-a=b|--=x");

const V = ["--otlp", "--filter", "--for"]; const B = ["--watch", "--pinned"]; const O = ["--otlp"];
// [args, want]: "" = all taken
const cases: string[][] = [
  ["--watch|--otlp|--filter|cwd ~ x", ""],
  ["--watch|--filter|cwd ~ x|--otlp", ""],
  ["--watch|--otlp|http://h:4318|--pinned", ""],
  ["--watch|--filter|--pinned", "--filter needs a value"],
  ["--watch|--for", "--for needs a value"],
  ["--watch|--fitler|x", "unknown option --fitler"],
  ["--watch|stray", "unexpected argument stray"],
  ["--watch|-x", "unknown option -x"],
  ["--watch|--filter|-harness is codex", ""],
];
for (const c of cases) eq("badArg " + String(c[0]), badArg(String(c[0]).split("|"), V, B, O), String(c[1]));

console.log(bad ? bad + " failed" : "argv: all checks passed");
if (bad) process.exit(1);
