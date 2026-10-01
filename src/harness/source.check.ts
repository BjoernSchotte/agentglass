// agentglass — self-check for the file session source: scriptc build src/harness/source.check.ts -o sc && ./sc
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { newSess } from "../model/types.ts";
import { FILE_SOURCE } from "./source.ts";
import { accOf } from "../features/usage/ledger.ts";
import { restat } from "../model/sessions.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-source-check"; mkdirSync(dir, { recursive: true });
const p = dir + "/s.jsonl";
const fd = openSync(p, "w"); writeSync(fd, "{\"a\":1}\n{\"b\":2}\n{\"c\":3"); closeSync(fd); // last line still being written
const s = newSess("claude", "x", p, false);
const st = FILE_SOURCE.stat(s);
ok("stat size", !!st && st.size === 22, JSON.stringify(st));
const r = FILE_SOURCE.lines(s, 0, 22);
ok("whole lines only", r.lines.join("|") === "{\"a\":1}|{\"b\":2}" && r.next === 16, JSON.stringify(r));
ok("align mid-line", FILE_SOURCE.align(s, 3) === 8, String(FILE_SOURCE.align(s, 3)));
ok("align at start", FILE_SOURCE.align(s, 0) === 0, String(FILE_SOURCE.align(s, 0)));
ok("align at boundary", FILE_SOURCE.align(s, 8) === 8, String(FILE_SOURCE.align(s, 8)));
ok("align in unterminated tail", FILE_SOURCE.align(s, 18) === 22, String(FILE_SOURCE.align(s, 18)));
ok("nothing after EOF align", FILE_SOURCE.lines(s, 22, 22).lines.length === 0, "");
const p2 = dir + "/t.jsonl";
const fd2 = openSync(p2, "w"); writeSync(fd2, "{\"a\":1}\n{\"b\":2}\n"); closeSync(fd2);
const s2 = newSess("claude", "z", p2, false);
const r2 = FILE_SOURCE.lines(s2, 0, 16);
ok("terminated file: no trailing empty", r2.lines.length === 2 && r2.next === 16, JSON.stringify(r2));
ok("align at EOF of terminated file", FILE_SOURCE.align(s2, 16) === 16, String(FILE_SOURCE.align(s2, 16)));
const p3 = dir + "/n.jsonl";
const fd3 = openSync(p3, "w"); writeSync(fd3, "{\"a\":1}\n" + "x".repeat(70000)); closeSync(fd3); // long unterminated line
const s3 = newSess("claude", "w", p3, false);
ok("align across chunks to EOF", FILE_SOURCE.align(s3, 100) === 70008, String(FILE_SOURCE.align(s3, 100)));
ok("nothing new", FILE_SOURCE.lines(s, 16, 22).lines.length === 0 && FILE_SOURCE.lines(s, 16, 22).next === 16, "");
ok("missing file", FILE_SOURCE.stat(newSess("claude", "y", dir + "/nope.jsonl", false)) === null, "");
// cursor epoch (SessionSource.epoch): same size, other cursor meaning → the ledger and the loaded tail start over
const se = newSess("opencode", "e", dir + "/e#1", false);
restat(se, 10, 1, "a"); se.headDone = true; se.tailSize = 10; se.evs.push({ kind: "user", text: "x", ts: "", id: "", full: "" });
const a1 = accOf(se); a1.off = 10; a1.tools = 3;
ok("unchanged epoch keeps the account", accOf(se) === a1, "");
restat(se, 10, 2, "a");
ok("unchanged epoch keeps the tail", se.tailSize === 10 && se.headDone && se.evs.length === 1, String(se.tailSize));
restat(se, 10, 3, "b");
const a2 = accOf(se);
ok("epoch change: fresh account", a2 !== a1 && a2.off === 0 && a2.tools === 0 && a2.ep === "b", a2.ep);
ok("epoch change: tail and head reload", se.tailSize === -1 && !se.headDone && se.evs.length === 0, String(se.tailSize));
console.log(bad ? bad + " failed" : "source: all checks passed");
process.exit(bad ? 1 : 0);
