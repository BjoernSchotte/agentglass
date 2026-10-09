// agentglass-mcp — a CLI child's output as a tool result: the envelope, pages, content stripping and the size cap.
// Order: parse → strip content (§8) → page → cap. Numbers and nulls pass through (an unpriced cost stays null).
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr } from "../util/json.ts";
import { type Call, type Opts, encodeCursor } from "./tools.ts";

export interface Shaped { obj: Obj; text: string; isError: boolean }
const J = (v: unknown): string => JSON.stringify(v);
function blen(s: string): number { return new TextEncoder().encode(s).length; }
function done(o: Obj): Shaped { return { obj: o, text: J(o), isError: false }; }
export function errorShaped(code: string, message: string, hint: string): Shaped {
  const e: Obj = { code, message }; if (hint) e["hint"] = hint;
  const o: Obj = { error: e };
  return { obj: o, text: J(o), isError: true };
}
function copy(o: Obj): Obj { const c: Obj = {}; for (const k of Object.keys(o)) c[k] = o[k]; return c; }
function without(o: Obj, k: string): Obj { const c: Obj = {}; for (const x of Object.keys(o)) if (x !== k) c[x] = o[x]; return c; }
function pick(o: Obj, ks: string[]): Obj { const c: Obj = {}; for (const k of ks) if (o[k] !== undefined) c[k] = o[k]; return c; }

// ── content (spec §8.1): tool results, prompts after the first, assistant text, thinking, subagent task prompts ──
// related: a prompt's or subagent task's text, and an anchor that is conversation itself (assistant text, thinking)
const CONTENT_KINDS = ["prompt", "agent", "assistant", "thinking", "result", "user"];
function noText(rows: unknown, when: (r: Obj) => boolean): unknown[] {
  return arr(rows).map((x: unknown): unknown => { const r = obj(x); return r && when(r) ? without(r, "text") : x; });
}
export function stripContent(tool: string, v: Obj): Obj {
  const all = (r: Obj): boolean => true;
  const byKind = (r: Obj): boolean => CONTENT_KINDS.indexOf(str(r["kind"])) >= 0;
  if (tool === "session" && v["errors"] !== undefined) { const c = copy(v); c["errors"] = noText(v["errors"], all); return c; }
  if (tool === "errors" && v["rows"] !== undefined) { const c = copy(v); c["rows"] = noText(v["rows"], all); return c; }
  if (tool === "related") {
    const c = copy(v);
    if (v["events"] !== undefined) c["events"] = noText(v["events"], byKind);
    const an = obj(v["anchor"]); if (an && byKind(an)) c["anchor"] = without(an, "text");
    return c;
  }
  if (tool === "events" && v["events"] !== undefined) { const c = copy(v); c["events"] = noText(v["events"], all); return c; }
  if (tool === "skills" && v["loads"] !== undefined) { const c = copy(v); c["loads"] = noText(v["loads"], all).map((x: unknown): unknown => { const r = obj(x); return r ? without(r, "textHidden") : x; }); return c; } // a skill's loaded text
  return v; // compare, triage: aggregates only
}

// ── the size cap ──
// a row too big on its own: its id and the mark
function stub(r: Obj): Obj { const id = r["id"] ?? r["session"] ?? null; return { id, truncated: true }; }
// rows from the start while the envelope (extra + rows) stays ≤ maxBytes; truncated when any was dropped or stubbed
export function capList(rows: Obj[], extra: Obj, maxBytes: number): { rows: Obj[]; truncated: boolean } {
  const e = copy(extra); e["rows"] = []; e["truncated"] = true; e["next"] = encodeCursor(99999);
  const room = maxBytes - blen(J(e)); let used = 0; let truncated = false;
  const out: Obj[] = [];
  for (const r of rows) {
    let s = J(r); let row = r;
    if (blen(s) > room) { row = stub(r); s = J(row); truncated = true; }
    const n = blen(s) + (out.length ? 1 : 0);
    if (used + n > room) { truncated = true; break; }
    used += n; out.push(row);
  }
  return { rows: out, truncated };
}
// the arrays an object result gives up first, then any other array; arrays one level down count too (compare's
// files.onlyA/onlyB), named by their path. truncated: the names trimmed
const TRIM = ["files", "tools", "errors", "repeats", "events", "programs", "models"];
interface Slot { key: string; sub: string; len: number }
export function capObject(v: Obj, maxBytes: number): Obj {
  if (blen(J(v)) <= maxBytes) return v;
  const c = copy(v); const trimmed: string[] = [];
  const budget = maxBytes - 200; // room for the truncated list
  for (let guard = 0; guard < 64; guard++) {
    let size = blen(J(c)); if (size <= budget) break;
    // the largest array of the first group that has one (under a TRIM name before any other)
    let best: Slot = { key: "", sub: "", len: 0 };
    for (const pass of [0, 1]) {
      for (const k of Object.keys(c)) {
        if ((pass === 0) !== (TRIM.indexOf(k) >= 0)) continue;
        const x = c[k];
        if (Array.isArray(x)) { const l = (x as unknown[]).length ? blen(J(x)) : 0; if (l > best.len) best = { key: k, sub: "", len: l }; continue; }
        const o = obj(x); if (!o) continue;
        for (const sk of Object.keys(o)) { const y = o[sk]; if (!Array.isArray(y) || !(y as unknown[]).length) continue; const l = blen(J(y)); if (l > best.len) best = { key: k, sub: sk, len: l }; }
      }
      if (best.key) break;
    }
    if (!best.key) break;
    const holder: Obj = best.sub ? copy(obj(c[best.key]) ?? {}) : c; const at = best.sub || best.key;
    const a = (holder[at] as unknown[]).slice();
    while (a.length && size > budget) { size -= blen(J(a[a.length - 1])) + 1; a.pop(); }
    holder[at] = a; if (best.sub) c[best.key] = holder;
    const name = best.sub ? best.key + "." + best.sub : best.key;
    if (trimmed.indexOf(name) < 0) trimmed.push(name);
  }
  if (trimmed.length) c["truncated"] = trimmed;
  return blen(J(c)) <= maxBytes ? c : stub(v);
}

// ── per tool ──
function list(c: Call, rows: Obj[], scope: string, o: Opts): Shaped {
  const page = rows.slice(c.offset, c.offset + c.limit); const more = rows.length > c.offset + c.limit;
  const cl = capList(page, { next: null, truncated: false, scope }, o.maxBytes);
  const next = cl.truncated ? encodeCursor(c.offset + cl.rows.length) : more ? encodeCursor(c.offset + c.limit) : null;
  return done({ rows: cl.rows, next, truncated: cl.truncated, scope });
}
function names(v: unknown): string[] { const o: string[] = []; for (const x of arr(v)) o.push(str(x)); return o; }
function objs(v: unknown): Obj[] { const o: Obj[] = []; for (const x of arr(v)) { const r = obj(x); if (r) o.push(r); } return o; }
const RUN_KEYS = ["session", "harness", "family", "kind", "heavy", "ageSec", "rssMb"];
function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
// wait --check's answer as data: exit 3 (over the limit) is go=false, not an error
function contention(v: Obj): Shaped {
  const now = obj(v["now"]) ?? {}; const ck = obj(v["check"]) ?? {};
  const go = ck["over"] !== true;
  const runs = objs(now["running"]);
  const older = (a: Obj, b: Obj): number => num(b["ageSec"]) - num(a["ageSec"]);
  const heavy = runs.filter((r: Obj) => r["heavy"] === true).sort(older);
  const rest = runs.filter((r: Obj) => r["heavy"] !== true).sort(older);
  const running = heavy.concat(rest).slice(0, 10).map((r: Obj): Obj => pick(r, RUN_KEYS));
  // the heavy ones the check counted (its kind/family), by family: "pnpm test ×2, tsc"
  const fk = str(ck["family"]); const kk = str(ck["kind"]);
  const counted = heavy.filter((r: Obj) => (!fk || str(r["family"]) === fk) && (!kk || str(r["kind"]) === kk));
  const fams: string[] = []; const cnt = new Map<string, number>();
  for (const r of counted) { const f = str(r["family"]) || "?"; if (!cnt.has(f)) fams.push(f); cnt.set(f, (cnt.get(f) ?? 0) + 1); }
  fams.sort((a: string, b: string) => (cnt.get(b) ?? 0) - (cnt.get(a) ?? 0));
  const n = typeof ck["running"] === "number" ? num(ck["running"]) : counted.length;
  const what = fams.length ? " (" + fams.map((f: string) => (cnt.get(f) ?? 0) > 1 ? f + " ×" + String(cnt.get(f) ?? 0) : f).join(", ") + ")" : "";
  const advice = String(n) + " heavy command" + (n === 1 ? "" : "s") + " running" + (n ? what : "") + ": " + (go ? "go" : "wait or run a subset");
  return done({ go, heavyRunning: now["heavyRunning"] ?? n, max: ck["max"] ?? null, running, load1: now["load1"] ?? null, cpus: now["cpus"] ?? null, memAvailPct: now["memAvailPct"] ?? null, advice, scope: "host" });
}
const WAIT_ROW = ["key", "kind", "heavy", "calls", "totalMs", "share", "p50Ms", "p95Ms", "errors", "trend", "peak"];
const PRICE_ROW = ["model", "source", "price", "unpricedTokens", "estimated"];
// the child's stdout (exit 0, or an exit that is data) → the tool result
export function shapeOk(c: Call, stdout: string, scope: string, o: Opts): Shaped {
  let v: unknown = null;
  try { v = JSON.parse(stdout); } catch (e) { return errorShaped("bad_output", "agentglass printed no JSON: " + stdout.trim().slice(0, 200), "run agentglass mcp doctor"); }
  const t = c.tool;
  if (t === "sessions") return list(c, objs(v), scope, o);
  const vo = obj(v);
  if (!vo) return errorShaped("bad_output", "agentglass printed no JSON object", "run agentglass mcp doctor");
  const x = o.content ? vo : stripContent(t, vo);
  if (t === "errors") return list(c, objs(x["rows"]), str(x["scope"]) || scope, o);
  if (t === "contention") return contention(x);
  if (t === "waits") return done(capObject({ period: x["period"] ?? null, agentTime: x["agentTime"] ?? null, rows: objs(x["rows"]).map((r: Obj) => pick(r, WAIT_ROW)), guard: x["guard"] ?? null, scope }, o.maxBytes));
  if (t === "fleet") { const f = copy(x); f["configured"] = true; return done(capObject(f, o.maxBytes)); }
  if (t === "prices") return done(capObject({ models: objs(x["models"]).filter((m: Obj) => !c.model || str(m["model"]) === c.model).map((m: Obj) => pick(m, PRICE_ROW)) }, o.maxBytes));
  const r = copy(x);
  if (t === "related" || t === "events") { // events paged here (the CLI returns the whole window / session)
    const ev = objs(x["events"]);
    r["events"] = ev.slice(c.offset, c.offset + c.limit);
    r["next"] = ev.length > c.offset + c.limit ? encodeCursor(c.offset + c.limit) : null;
  }
  if (r["scope"] === undefined || typeof r["scope"] !== "string") r["scope"] = scope;
  const capped = capObject(r, o.maxBytes);
  if ((t === "related" || t === "events") && names(capped["truncated"]).indexOf("events") >= 0) capped["next"] = encodeCursor(c.offset + arr(capped["events"]).length);
  return done(capped);
}
// the CLI's error line ({"error":{code,message,hint}} on stderr in agent mode): the last line that parses
function cliErr(stderr: string): Obj | null {
  const ls = stderr.split("\n");
  for (let i = ls.length - 1; i >= 0; i--) {
    const l = (ls[i] ?? "").trim(); if (!l.startsWith("{")) continue;
    try { const e = obj((obj(JSON.parse(l)) ?? {})["error"]); if (e) return e; } catch (er) { /* not JSON */ }
  }
  return null;
}
// a non-zero exit: data for contention (3) and prices (4); fleet without hosts is configured:false; else the CLI's error
export function shapeExit(c: Call, code: number, stdout: string, stderr: string, scope: string, o: Opts): Shaped {
  if (code === 0 || (c.tool === "contention" && code === 3) || (c.tool === "prices" && code === 4)) return shapeOk(c, stdout, scope, o);
  const e = cliErr(stderr);
  if (c.tool === "fleet" && code === 2 && e && str(e["code"]) === "usage" && str(e["message"]).indexOf("no hosts configured") >= 0) return done({ hosts: [], configured: false });
  if (e) { const o2: Obj = { error: pick(e, ["code", "message", "hint"]) }; return { obj: o2, text: J(o2), isError: true }; }
  const msg = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return errorShaped("cli", "agentglass exited " + String(code) + (msg ? ": " + msg : ""), "run agentglass mcp doctor");
}
