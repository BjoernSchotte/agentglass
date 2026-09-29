// agentglass — self-check for the file session source: scriptc build src/harness/source.check.ts -o sc && ./sc
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { newSess } from "../model/types.ts";
import { FILE_SOURCE } from "./source.ts";
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
ok("nothing new", FILE_SOURCE.lines(s, 16, 22).lines.length === 0 && FILE_SOURCE.lines(s, 16, 22).next === 16, "");
ok("missing file", FILE_SOURCE.stat(newSess("claude", "y", dir + "/nope.jsonl", false)) === null, "");
console.log(bad ? bad + " failed" : "source: all checks passed");
process.exit(bad ? 1 : 0);
