// agentglass — the call graph of a large session stays bounded: memory on open, none kept after close, frame time, and
// nothing lost (error flags read from long results, ↵ and r on the full events): scriptc build src/features/callgraph/mem.check.ts -o cgm && ./cgm
// SPDX-License-Identifier: Apache-2.0
// Linux only (reads VmRSS). A session with 24 subagents whose results carry escapes (JSON.parse builds them in the
// runtime's growable buffer, util/own.ts): kept as parsed, each event pinned up to 64 KB (1.4 GB on a real 175-subagent
// session).
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H, viewOf } from "../../hooks.ts";
import { buf } from "../../ui/screen.ts";
import { onInput } from "../../input.ts";
import { selfRssMb } from "../../util/selfmem.ts";
import { VF_STORE, vfSet, vfClear, resetForTest, MASK_STATS } from "../../ui/evfilter.ts";
import { KIND_STATS } from "../../model/kinds.ts";
import { openGraph, cgState, cgSelect, graphAnchor } from "./view.ts";
import "../evkinds.ts";

let bad = 0;
function ok(w: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + w); } }

if (selfRssMb() < 0) console.log("call graph memory: skipped (no RSS)");
else {
  const D = "/tmp/agentglass-cgmem-check-" + String(process.pid); rmSync(D, { recursive: true, force: true }); mkdirSync(D + "/s/subagents", { recursive: true });
  VF_STORE.path = D + "/vf.json"; resetForTest();
  let big = ""; for (let i = 0; i < 16384; i++) big += "abcdefgh";
  JSON.stringify({ big }); // one large line went through: later builder strings start at 64 KB (as on any real history)
  const T = Date.parse("2026-10-01T09:00:00Z");
  const iso = (x: number): string => new Date(T + x * 1000).toISOString();
  const pad = (n: number, w: string): string => { let o = ""; while (o.length < n) o += w + " line\n"; return o.slice(0, n); };
  const user = (x: number, t: string): string => JSON.stringify({ type: "user", timestamp: iso(x), message: { role: "user", content: t } });
  const say = (x: number, t: string): string => JSON.stringify({ type: "assistant", timestamp: iso(x), message: { id: "m" + String(x), model: "claude-sonnet-4-5", content: [{ type: "text", text: t }] } });
  const call = (x: number, id: string, name: string, input: string): string => "{\"type\":\"assistant\",\"timestamp\":\"" + iso(x) + "\",\"message\":{\"id\":\"m" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}]}}";
  const res = (x: number, id: string, t: string): string => JSON.stringify({ type: "user", timestamp: iso(x), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: t }] }, toolUseResult: { stdout: t } });
  const NSUB = 24; const NCALL = 20;
  const root: string[] = []; let x = 0;
  for (let a = 0; a < NSUB; a++) {
    root.push(user(x++, "task " + String(a) + "\n" + pad(3000, "prompt")));
    root.push(say(x++, pad(2000, "plan")));
    root.push(call(x++, "ag" + String(a), "Agent", JSON.stringify({ description: "part " + String(a), prompt: pad(1500, "brief"), subagent_type: "Explore" })));
    const sub: string[] = []; let y = x;
    sub.push(user(y++, "part " + String(a)));
    for (let c = 0; c < NCALL; c++) {
      const id = "c" + String(a) + "_" + String(c);
      sub.push(say(y++, pad(1500, "think")));
      sub.push(call(y++, id, "Bash", JSON.stringify({ command: "make test-" + String(c) })));
      sub.push(res(y++, id, pad(6000, "out")));
    }
    writeFileSync(D + "/s/subagents/agent-" + String(a) + ".jsonl", sub.join("\n") + "\n");
    writeFileSync(D + "/s/subagents/agent-" + String(a) + ".meta.json", JSON.stringify({ agentType: "Explore", toolUseId: "ag" + String(a) }));
    x = y + 1;
    root.push(res(x++, "ag" + String(a), pad(4000, "report")));
  }
  // errors the graph must still read: one only in a long result's tail (codex exit code), one at the head of a long one
  root.push(call(x++, "e1", "Bash", JSON.stringify({ command: "npm test" }))); root.push(res(x++, "e1", pad(9000, "noise") + "{\"output\":\"x\",\"metadata\":{\"exit_code\": 2}}"));
  root.push(call(x++, "e2", "Read", JSON.stringify({ file_path: "/w/a.ts" }))); root.push(res(x++, "e2", "<tool_use_error>File does not exist.\n" + pad(9000, "detail")));
  root.push(call(x++, "k1", "Bash", JSON.stringify({ command: "ls" }))); root.push(res(x++, "k1", pad(9000, "fine")));
  const P = D + "/s.jsonl"; writeFileSync(P, root.join("\n") + "\n");
  const s: Sess = newSess("claude", "s", P, false); s.size = statSync(P).size; s.mtime = T; s.cwd = D;
  for (let a = 0; a < NSUB; a++) {
    const f = D + "/s/subagents/agent-" + String(a) + ".jsonl";
    const c = newSess("claude", "agent-" + String(a), f, false); c.size = statSync(f).size; c.mtime = T; c.parent = "s"; c.kind = "Explore"; s.subs.push(c);
  }
  S.W = 160; S.H = 48;
  const v = viewOf("call graph");
  const frame = (): void => { buf.length = 0; if (v) v.render(); };
  const cycle = (): void => { openGraph(s); frame(); onInput("tab"); frame(); onInput("tab"); onInput("esc"); };
  const r0 = selfRssMb();
  openGraph(s); frame();
  const r1 = selfRssMb();
  ok("open keeps ≤ 16 MB (got " + String(r1 - r0) + " MB)", r1 - r0 <= 16);
  // nothing lost: every span, the subagents, the errors read from long results
  const st = cgState(); let agents = 0; let tools = 0; const err = new Map<string, number>();
  for (const sp of st.spans) { if (sp.kind === 2) agents++; if (sp.kind === 1) { tools++; err.set(sp.arg, sp.err); } }
  ok("24 subagents (got " + String(agents) + ")", agents === NSUB);
  ok("every call (got " + String(tools) + ")", tools === NSUB + NSUB * NCALL + 3);
  ok("error in a long result's tail", err.get("npm test") === 1);
  ok("error at a long result's head", err.get("/w/a.ts") === 1);
  ok("a long ok result", err.get("ls") === 0);
  // frames redo no classification or masking (deterministic), and stay well clear of slow (loose: CI runners vary 10×)
  let t0 = Date.now(); for (let i = 0; i < 10; i++) frame(); const plain = (Date.now() - t0) / 10;
  vfSet("callgraph", "event.kind is shell"); onInput("K"); frame();
  const k0 = KIND_STATS.events; const m0 = MASK_STATS.built;
  t0 = Date.now(); for (let i = 0; i < 10; i++) frame(); const filt = (Date.now() - t0) / 10;
  ok("frames with a filter and the chip bar classify nothing again (" + String(KIND_STATS.events - k0) + " events)", KIND_STATS.events === k0);
  ok("frames with a filter build no mask (" + String(MASK_STATS.built - m0) + ")", MASK_STATS.built === m0);
  onInput("esc"); vfClear("callgraph");
  ok("a frame ≤ 250 ms (got " + String(plain) + ")", plain <= 250);
  ok("a filtered frame ≤ 250 ms (got " + String(filt) + ")", filt <= 250);
  if (process.env.CG_VERBOSE) console.log("open +" + String(r1 - r0) + " MB · frame " + String(plain) + " ms · filtered " + String(filt) + " ms");
  // ↵ on a long call: the detail has its full result; r anchors on the full events
  let sel = -1; for (let i = 0; i < st.spans.length; i++) if (st.spans[i].arg === "ls") sel = i;
  const a0 = graphAnchor(); ok("an anchor", a0 !== null);
  cgSelect(sel);
  ok("selected ls", cgState().sel === sel);
  const an = graphAnchor();
  ok("r: the anchor's events are full", an !== null && an.evs[an.i].kind === "tool" && an.evs[an.i + 1].text.length >= 9000 && an.evs[an.i].full.length > 0);
  onInput("enter");
  const tv = S.tv;
  ok("↵: detail on the full events", S.mode === "detail" && tv !== null && tv.cur >= 0 && tv.evs[tv.cur].id === "k1" && tv.evs[tv.cur].full.length > 0);
  onInput("esc"); ok("esc back to the graph", S.mode === "view");
  // a subagent spawned while the graph is open: read alone, the others kept; ↵ still lands on the right event in each
  const drillsOn = (id: string): boolean => {
    let k = -1; const sp = cgState().spans; for (let i = 0; i < sp.length; i++) if (sp[i].id === id) k = i;
    if (k < 0) return false;
    cgSelect(k); onInput("enter"); const t = S.tv; const hit = S.mode === "detail" && t !== null && t.cur >= 0 && t.evs[t.cur].id === id && t.evs[t.cur].full.length > 0;
    onInput("esc"); return hit && S.mode === "view";
  };
  const f = D + "/s/subagents/agent-new.jsonl";
  writeFileSync(f, [user(x + 1, "late part"), call(x + 2, "n1", "Bash", JSON.stringify({ command: "make late" })), res(x + 3, "n1", pad(3000, "late"))].join("\n") + "\n");
  const c = newSess("claude", "agent-new", f, false); c.size = statSync(f).size; c.mtime = T; c.parent = "s"; c.kind = "Explore"; s.subs.splice(3, 0, c);
  for (let i = 0; i < 4; i++) for (const h of H.onTick) h();
  let ag2 = 0; for (const sp of cgState().spans) if (sp.kind === 2) ag2++;
  ok("the new subagent joins (got " + String(ag2) + ")", ag2 === NSUB + 1);
  ok("↵ in the new subagent", drillsOn("n1"));
  ok("↵ in a subagent read before", drillsOn("c7_5") && drillsOn("c23_19"));
  onInput("esc");
  // closing releases it: open and close again does not grow
  const r2 = selfRssMb();
  for (let i = 0; i < 3; i++) cycle();
  const r3 = selfRssMb();
  ok("3 more open/close keep ≤ 4 MB (got " + String(r3 - r2) + " MB)", r3 - r2 <= 4);
  rmSync(D, { recursive: true, force: true });
}
if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("call graph memory: ok");
