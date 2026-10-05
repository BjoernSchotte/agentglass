// agentglass — self-check for gateway prices (pi models.json, OpenCode config): scriptc build src/features/usage/gwprices.check.ts -o gw && ./gw
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stripJsonc, piRows, opencodeRows, gatewayFiles, loadGateway } from "./gwprices.ts";
import { type Price } from "./pricing.ts";
import { obj } from "../../util/json.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function find(m: Map<string, Price[]>, prov: string, id: string): Price | null { for (const r of m.get(prov) ?? []) if (r.p === id) return r; return null; }
function dump(m: Map<string, Price[]>): string { let t = ""; for (const [k, rs] of m) for (const r of rs) t += k + "/" + r.p + ":" + r.i + "," + r.o + "," + r.cr + "," + r.cw + "," + r.cw1 + ";"; return t; }

const PI = '{"providers":{"cliproxy":{"baseUrl":"http://x","apiKey":"SECRET-1","headers":{"x":"SECRET-2"},"models":[' +
  '{"id":"claude-sonnet-5-5","name":"S","cost":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}},' +
  '{"id":"gpt-6-sol","cost":{"input":1.25,"output":10}},' +
  '{"id":"no-out","cost":{"input":1}},{"id":"neg","cost":{"input":-1,"output":2}},{"id":"free","cost":{"input":0,"output":0}},{"id":"nocost"}]}}}';
const pr = piRows(obj(JSON.parse(PI)));
const s55 = find(pr, "cliproxy", "claude-sonnet-5-5");
ok("pi row", !!s55 && s55.i === 3 && s55.o === 15 && s55.cr === 0.3 && s55.cw === 3.75 && s55.cw1 === -1, s55 ? JSON.stringify(s55) : "null");
const g6 = find(pr, "cliproxy", "gpt-6-sol"); ok("missing cache fields → -1", !!g6 && g6.cr === -1 && g6.cw === -1, g6 ? JSON.stringify(g6) : "null");
ok("row without output skipped", !find(pr, "cliproxy", "no-out"), "kept");
ok("negative skipped", !find(pr, "cliproxy", "neg"), "kept");
ok("explicit 0/0 kept", !!find(pr, "cliproxy", "free"), "dropped");
ok("no cost → no row", !find(pr, "cliproxy", "nocost"), "kept");
ok("no secrets (pi)", dump(pr).indexOf("SECRET") < 0 && dump(pr).indexOf("http") < 0, dump(pr));

const OC = '{\n  // my providers\n  "provider": {\n    "router": { "options": {"apiKey": "SECRET-3", "baseURL": "https://r//x"}, /* models */ "models": {\n' +
  '      "openai/GPT-6.1-sol": {"name": "//not-a-comment", "cost": {"input": 2, "output": 8, "cache_read": 0.2, "context_over_200k": {"input": 4, "output": 16}}},\n' +
  '      "m2": {"cost": {"input": 1, "output": 1, "cache_write": 1.5,},},\n    },},\n  },\n}\n';
const st = stripJsonc(OC);
let parsed = true; try { JSON.parse(st); } catch (e) { parsed = false; }
ok("jsonc parses", parsed, st);
ok("string with // kept", st.indexOf("//not-a-comment") >= 0 && st.indexOf("https://r//x") >= 0, st);
const orows = opencodeRows(obj(JSON.parse(st)));
const o1 = find(orows, "router", "gpt-6.1-sol"); ok("opencode row (normModel key)", !!o1 && o1.i === 2 && o1.o === 8 && o1.cr === 0.2 && o1.cw === -1, o1 ? JSON.stringify(o1) : dump(orows));
const o2 = find(orows, "router", "gpt-6.1-sol>200k"); ok("context_over_200k → >200k row", !!o2 && o2.i === 4 && o2.o === 16, o2 ? JSON.stringify(o2) : dump(orows));
const o3 = find(orows, "router", "m2"); ok("cache_write", !!o3 && o3.cw === 1.5, o3 ? JSON.stringify(o3) : "null");
ok("no secrets (opencode)", dump(orows).indexOf("SECRET") < 0, dump(orows));
ok("null object → empty", piRows(null).size === 0 && opencodeRows(null).size === 0, "rows");

// files under a fake home: pi models.json + OpenCode opencode.json and opencode.jsonc (both read, .jsonc wins per id)
const h = "/tmp/agentglass-gw-" + process.pid;
rmSync(h, { recursive: true, force: true });
mkdirSync(join(h, ".pi", "agent"), { recursive: true }); mkdirSync(join(h, ".config", "opencode"), { recursive: true });
writeFileSync(join(h, ".pi", "agent", "models.json"), PI);
writeFileSync(join(h, ".config", "opencode", "opencode.json"), '{"provider":{"router":{"models":{"a":{"cost":{"input":1,"output":1}}, "b":{"cost":{"input":1,"output":1}}}}}}');
writeFileSync(join(h, ".config", "opencode", "opencode.jsonc"), '// over\n{"provider":{"router":{"models":{"b":{"cost":{"input":9,"output":9}}}}}}');
const env = new Map<string, string>();
const fs = gatewayFiles(h, env);
ok("files", fs.length === 4 && fs[0] === join(h, ".pi", "agent", "models.json"), fs.join(","));
const env2 = new Map<string, string>([["PI_CODING_AGENT_DIR", "/elsewhere"], ["XDG_CONFIG_HOME", "/xdg"]]);
const fs2 = gatewayFiles(h, env2); ok("env dirs", (fs2[0] ?? "") === "/elsewhere/models.json" && (fs2[1] ?? "").startsWith("/xdg/opencode/"), fs2.join(","));
const g1 = loadGateway(h, env);
ok("both harnesses", !!find(g1.rows, "cliproxy", "claude-sonnet-5-5") && !!find(g1.rows, "router", "a"), dump(g1.rows));
const b1 = find(g1.rows, "router", "b"); ok("opencode.jsonc after opencode.json", !!b1 && b1.i === 9, b1 ? JSON.stringify(b1) : "null");
const g1b = loadGateway(h, env); ok("unchanged → same sig", g1b.sig === g1.sig, g1b.sig + " vs " + g1.sig);
writeFileSync(join(h, ".pi", "agent", "models.json"), PI.split('"input":3,').join('"input":4.5,')); // another size: no utimes in scriptc
const g2 = loadGateway(h, env);
const s2 = find(g2.rows, "cliproxy", "claude-sonnet-5-5"); ok("changed file re-read", !!s2 && s2.i === 4.5 && g2.sig !== g1.sig, s2 ? JSON.stringify(s2) : "null");
rmSync(h, { recursive: true, force: true });
const g3 = loadGateway(h, env); ok("files gone → empty", g3.rows.size === 0 && g3.sig === "", dump(g3.rows));

console.log(bad ? bad + " failed" : "gwprices: all checks passed");
if (bad) process.exit(1);
