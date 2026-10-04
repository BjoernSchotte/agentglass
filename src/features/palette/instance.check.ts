// agentglass — self-check for the single-instance holder test: scriptc build src/features/palette/instance.check.ts -o ic && ./ic
// SPDX-License-Identifier: Apache-2.0
import { basename } from "node:path";
import { OS } from "../../platform/index.ts";
import { myUid } from "./rundir.ts";
import { holderOf, isOurs } from "./instance.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const me = basename(process.execPath); const uid = myUid();
ok("this binary, our uid → ours", holderOf("/opt/x/" + me + " --redact", uid, me, uid), "");
ok("agentglass, our uid → ours", holderOf("agentglass", uid, me, uid), "");
// a pid reused by another user's agentglass: never ours (no hand-off to it, no 2 s wait for its answer; the lock is stale)
ok("agentglass of another uid → not ours", !holderOf("/usr/local/bin/agentglass", uid + 1, me, uid), "");
ok("owner unknown → not ours", !holderOf("agentglass", -1, me, uid), "");
ok("another program → not ours", !holderOf("/usr/bin/vim x", uid, me, uid), "");
// the owner as the OS reports it (Linux: stat on /proc/<pid>, else ps -o uid=)
ok("own pid's owner", OS.procOwner(process.pid) === uid, String(OS.procOwner(process.pid)));
ok("pid 1 is root's", OS.procOwner(1) === 0, String(OS.procOwner(1)));
ok("gone pid → -1", OS.procOwner(2147483646) === -1, String(OS.procOwner(2147483646)));
ok("isOurs(self)", isOurs(process.pid) === (me === basename(process.execPath)), "");
console.log(bad ? bad + " failed" : "instance: all checks passed");
process.exit(bad ? 1 : 0);
