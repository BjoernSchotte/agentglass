// agentglass — self-check for the list view's change signature and the parent index: scriptc build src/model/view.check.ts -o vc && ./vc
// SPDX-License-Identifier: Apache-2.0
import { newSess, type Sess } from "./types.ts";
import { sessions, SG, buildView, viewSig, parentOf, expanded, collapsed } from "./sessions.ts";
import { S } from "../state.ts";
import { H } from "../hooks.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ok(what: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + what); } }
const now = Date.now();
function add(id: string, parent: string, mtime: number): Sess {
  const s = newSess("claude", id, "/v/" + id + ".jsonl", false); s.parent = parent; s.mtime = mtime;
  sessions.set(s.path, s); SG.gen++; return s;
}
const p1 = add("p1", "", now - 3600000);
const p2 = add("p2", "", now - 7200000);
const k1 = add("k1", "p1", now - 3600000); // an idle subagent of p1
S.mode = "list"; S.tab = 0;

// ── parentOf: an index, valid across set changes and a root turning into a subagent ──
ok("parent found", parentOf(k1) === p1);
ok("root has none", parentOf(p1) === null);
const p3 = add("p3", "", now - 60000); const k3 = add("k3", "p3", now - 60000);
ok("parent added later", parentOf(k3) === p3);
p3.parent = "p2"; // a head read found it is itself a subagent: no longer a root
ok("no longer a root", parentOf(k3) === null);
p3.parent = ""; sessions.delete(p3.path); sessions.delete(k3.path); SG.gen++;
ok("removed parent", parentOf(k3) === null);

// ── the signature: steady while nothing changes, moves with each input ──
buildView(); const v0 = S.view; const g0 = viewSig();
eq("steady", viewSig(), g0);
buildView(); ok("same signature: the same view array", S.view === v0);
let g = viewSig();
const n1 = add("n1", "", now - 1000); eq("add session: moved", viewSig() === g ? "same" : "moved", "moved");
buildView(); ok("rebuilt with the new session", S.view !== v0 && S.view.indexOf(n1) >= 0);
g = viewSig(); p2.mtime = now - 500; eq("mtime: moved", viewSig() === g ? "same" : "moved", "moved");
g = viewSig(); p2.pid = 4242; eq("pid: moved", viewSig() === g ? "same" : "moved", "moved");
buildView(); eq("live first", S.view.length ? S.view[0].id : "", "p2");
g = viewSig(); k1.mtime = now - 1000; eq("subagent active: moved", viewSig() === g ? "same" : "moved", "moved");
buildView(); ok("auto-expanded parent shows its active subagent", S.view.indexOf(k1) >= 0);
// time alone: a subagent's 45 s activity window ends
k1.mtime = Date.now() - 44950; buildView(); g = viewSig();
const t0 = Date.now(); while (Date.now() - t0 < 120) { /* the window closes */ }
eq("subagent idle by time alone: moved", viewSig() === g ? "same" : "moved", "moved");
buildView(); ok("collapsed again", S.view.indexOf(k1) < 0);
g = viewSig(); expanded.add(p1.path); eq("expand: moved", viewSig() === g ? "same" : "moved", "moved");
buildView(); ok("expanded shows the idle subagent", S.view.indexOf(k1) >= 0);
g = viewSig(); expanded.delete(p1.path); collapsed.add(p1.path); eq("collapse: moved", viewSig() === g ? "same" : "moved", "moved");
collapsed.delete(p1.path); buildView();
g = viewSig(); H.listFilter.push(() => (s: Sess): boolean => s.id === "p1");
eq("list filter: moved", viewSig() === g ? "same" : "moved", "moved");
buildView(); eq("filtered", S.view.map((s: Sess) => s.id).join(","), "p1");
g = viewSig(); eq("filter steady", viewSig(), g);
H.listFilter.pop(); buildView();
g = viewSig(); S.sel = S.sel === 1 ? 0 : 1; eq("selection: moved", viewSig() === g ? "same" : "moved", "moved");
// a view set elsewhere (another array) is rebuilt even with the same signature
buildView(); S.view = []; buildView(); ok("foreign view replaced", S.view.length > 0);

console.log(bad ? bad + " failed" : "view: all checks passed");
if (bad) process.exit(1);
