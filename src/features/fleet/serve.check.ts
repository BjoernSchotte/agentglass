// agentglass — self-check for fleet serve's request parsing and fleet authorize: scriptc build src/features/fleet/serve.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { words, allowed, keyLine } from "./serve.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const W = (s: string): string => JSON.stringify(words(s));
ok("plain", JSON.stringify(words("agentglass fleet pull --days 7").w) === JSON.stringify(["agentglass", "fleet", "pull", "--days", "7"]), W("agentglass fleet pull --days 7"));
ok("quotes", JSON.stringify(words("a 'b c' \"d\\\"e\"").w) === JSON.stringify(["a", "b c", "d\"e"]), W("a 'b c' \"d\\\"e\""));
ok("viewer quoting", JSON.stringify(words("~/'.local/bin/agentglass' 'fleet' 'pull' '--days' '7'").w) === JSON.stringify(["~/.local/bin/agentglass", "fleet", "pull", "--days", "7"]), W("~/'.local/bin/agentglass' 'fleet' 'pull'"));
ok("quote in quotes", JSON.stringify(words("'a'\\''b'").w) === JSON.stringify(["a'b"]), W("'a'\\''b'"));
ok("backslash", JSON.stringify(words("a\\ b").w) === JSON.stringify(["a b"]), W("a\\ b"));
ok("tabs and runs", JSON.stringify(words("  a\t\tb  ").w) === JSON.stringify(["a", "b"]), W("  a\t\tb  "));
for (const s of ["a;b", "a | b", "a $(id)", "a `id`", "a > f", "a < f", "a & b", "a\nb", "(a)", "a \"$HOME\"", "a \"`id`\""]) ok("refused " + JSON.stringify(s), words(s).err === "refused: shell syntax", W(s));
ok("unbalanced '", words("'a").err === "refused: unbalanced quote", W("'a"));
ok("unbalanced \"", words("\"a").err === "refused: unbalanced quote", W("\"a"));
ok("trailing backslash", words("a\\").err !== "", W("a\\"));
ok("literal $ in single quotes", JSON.stringify(words("'$x'").w) === JSON.stringify(["$x"]), W("'$x'"));
const A = (w: string[]): string => JSON.stringify(allowed(w));
const p = allowed(["/x/agentglass", "fleet", "pull", "--days", "7", "--redact"]);
ok("pull allowed", JSON.stringify(p.args) === JSON.stringify(["fleet", "pull", "--days", "7", "--redact"]) && p.redact && !p.err, JSON.stringify(p));
ok("bare pull", allowed(["agentglass", "fleet", "pull"]).err === "" && !allowed(["agentglass", "fleet", "pull"]).redact, A(["agentglass", "fleet", "pull"]));
ok("version", allowed(["agentglass", "--version"]).err === "" && allowed(["agentglass", "--version", "--json"]).err === "", A(["agentglass", "--version", "--json"]));
const REF: string[][] = [["sh", "-c", "x"], ["agentglass", "--json"], ["agentglass", "fleet", "pull", "--days", "999"], ["agentglass", "fleet", "pull", "--days", "0"], ["agentglass", "fleet", "pull", "--days"],
  ["agentglass", "fleet", "pull", "--x"], ["agentglass-evil", "fleet", "pull"], ["agentglass", "fleet", "serve"], ["agentglass", "fleet", "pull", "--redact", "--redact"],
  ["agentglass", "--version", "--x"], ["agentglass"], ["agentglass", "open", "x"], ["agentglass", "fleet", "pull", "--days", "7", "--days", "8"]];
// what a hostile viewer might send: each refused by the splitter or the allow-list, never run
for (const s of ["agentglass\rfleet pull", "agentglass fleet pull --days=7", "agentglass fleet pull --no-redact", "agentglass fleet pull # x", "agentglass fleet pull --days 7*",
  "agentglass --redact=0 fleet pull", "agentglass fleet pull -- --x", "agentglass fleet  pull --days '7 ;id'"]) { const r = words(s); ok("hostile " + JSON.stringify(s), r.err !== "" || allowed(r.w).err !== "", W(s)); }
for (const w of REF)
  ok("refused " + w.join(" "), allowed(w).err === 'only fleet pull and --version are allowed', A(w));
const k = keyLine("/h/.local/bin/agentglass", "ssh-ed25519 AAAAC3Nz me@x", "100.64.0.0/10", true);
ok("key line", k.line === 'restrict,from="100.64.0.0/10",command="/h/.local/bin/agentglass fleet serve --redact" ssh-ed25519 AAAAC3Nz me@x', JSON.stringify(k));
ok("key line plain", keyLine("/a/agentglass", "ssh-ed25519 AAAA\n", "", false).line === 'restrict,command="/a/agentglass fleet serve" ssh-ed25519 AAAA', JSON.stringify(keyLine("/a/agentglass", "ssh-ed25519 AAAA\n", "", false)));
ok("sk key", keyLine("/a/agentglass", "sk-ssh-ed25519@openssh.com AAAA x", "", false).err === "", "refused");
ok("newline in key", keyLine("/a/agentglass", "ssh-ed25519 AAAA a\nssh-rsa BBBB", "", false).err !== "", "accepted");
ok("quote in key", keyLine("/a/agentglass", "ssh-ed25519 AAAA a\"b", "", false).err !== "", "accepted");
ok("options in key", keyLine("/a/agentglass", "command=\"x\" ssh-ed25519 AAAA", "", false).err !== "", "accepted");
ok("bad from", keyLine("/a/agentglass", "ssh-ed25519 AAAA", "1.2.3.4\" x", false).err !== "", "accepted");
ok("escape in the key comment", keyLine("/a/agentglass", "ssh-ed25519 AAAA a\u001b]0;x\u0007b", "", false).err !== "", "accepted");
ok("non-ASCII key comment", keyLine("/a/agentglass", "ssh-ed25519 AAAA björn@laptop", "", false).err === "", "refused");
ok("space in path", keyLine("/a b/agentglass", "ssh-ed25519 AAAA", "", false).err.indexOf("plain path") >= 0, "accepted");
console.log(bad ? String(bad) + " failed" : "fleet serve: all checks passed");
if (bad) process.exit(1);
