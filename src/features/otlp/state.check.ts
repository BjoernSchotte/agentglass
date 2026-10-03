// agentglass — self-check for the export state file and the endpoint lock: scriptc build src/features/otlp/state.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { statePath, loadState, saveState, lock, unlock, markTurn, marked } from "./state.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
// a second process trying the lock: this binary, run with AGENTGLASS_LOCK_CHILD=<url> (and the parent's AGENTGLASS_OTLP_DIR)
const child = process.env["AGENTGLASS_LOCK_CHILD"];
if (child) { process.stdout.write(String(lock(child))); process.exit(0); }
const dir = "/tmp/agentglass-otlp-state-" + String(process.pid);
process.env["AGENTGLASS_OTLP_DIR"] = dir;
const U = "https://u:tok@h.example/v1/traces?key=x";

eq("endpoint key ignores userinfo and query", statePath(U), statePath("https://h.example/v1/traces"));
eq("state under the otlp dir", String(statePath(U).startsWith(dir + "/state-") && statePath(U).endsWith(".json")), "true");
const st = loadState(U);
eq("fresh", String(st.sessions.size) + " " + String(st.gzip) + " " + st.endpoint, "0 true https://h.example/v1/traces");
markTurn(st, "/p/a.jsonl", "claude", "s1", "", "2026-09-01T10:00:00.000Z#0");
markTurn(st, "/p/a.jsonl", "claude", "s1", "", "2026-09-01T10:05:00.000Z#0");
st.gzip = false; st.nativeSince.set("codex", 1788256800000); st.last = 1788256900000;
saveState(U, st);
const txt = readFileSync(statePath(U), "utf8");
eq("no credentials stored", String(txt.indexOf("tok") < 0 && txt.indexOf("key=x") < 0), "true");
eq("no tmp left", readdirSync(dir).filter((f: string) => f.indexOf(".tmp") >= 0).join(","), "");
eq("mode 0600", execFileSync("stat", process.platform === "darwin" ? ["-f", "%Lp", statePath(U)] : ["-c", "%a", statePath(U)], { encoding: "utf8" }).trim(), "600");
const back = loadState(U);
eq("round trip", [String(marked(back, "/p/a.jsonl", "2026-09-01T10:05:00.000Z#0")), String(marked(back, "/p/a.jsonl", "x")), String(back.gzip), String(back.nativeSince.get("codex") ?? 0), String(back.last)].join(" "), "true false false 1788256800000 1788256900000");
// a changed cursor epoch keeps the marks (ids do not depend on offsets)
markTurn(back, "/p/a.jsonl", "claude", "s1", "seq", "2026-09-01T10:09:00.000Z#0");
eq("epoch change keeps marks", String(marked(back, "/p/a.jsonl", "2026-09-01T10:00:00.000Z#0")), "true");
// a broken file starts over (with a warning), never crashes
writeFileSync(statePath(U), "{nope");
eq("broken state", String(loadState(U).sessions.size), "0");
// lock: taken, refused for a second process (its answer: our pid), stale lock taken over
eq("lock", String(lock(U)), "0");
const other = execFileSync(process.execPath,  [], { encoding: "utf8", env: { AGENTGLASS_LOCK_CHILD: U, AGENTGLASS_OTLP_DIR: dir, PATH: process.env["PATH"] ?? "" } });
eq("second exporter refused", other, String(process.pid));
unlock(U);
eq("unlocked", String(existsSync(statePath(U).replace(/\.json$/, ".lock"))), "false");
writeFileSync(statePath(U).replace(/\.json$/, ".lock"), "999999");
eq("stale lock taken over", String(lock(U)), "0");
unlock(U);
rmSync(dir, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp state: all checks passed");
