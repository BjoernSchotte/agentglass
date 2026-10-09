// agentglass — per-tool call detail for the usage ledger: call↔result pairing, durations, shell programs, changed files
// SPDX-License-Identifier: Apache-2.0
import { clean } from "../../util/text.ts";
import type { Rows } from "./rows.ts";
import { own } from "../../util/own.ts";

// one remembered call: t = call time (epoch ms), ms = duration (-1 unknown), ts/id = the transcript event to jump to
export interface Rec { t: number; ms: number; id: string; ts: string; arg: string }
// one tool on one day: n calls, err failed, dn calls with a known duration (ms total, max, log histogram), out result bytes, h calls per hour
export interface TS { n: number; err: number; dn: number; ms: number; max: number; out: number; hist: number[]; h: number[]; slow: Rec[]; errs: Rec[] }
// shell program / command line (n calls, err) or changed file (n edits, add/del lines)
export interface Cnt { n: number; err: number; add: number; del: number }
// a call still waiting for its result; sh = [program, command] counters per shell command, for error attribution; rows/ri =
// its session's call rows and its row there (null / -1 none; callcache prune remaps ri);
// name = the tool's name as booked (retool renames it); sp = its session's Acc.sp: done() leaves the call's [start, end] there for the active-time intervals (record.ts flushSpans)
// cmd = its full shell command line(s) ("" none), id = call id, end = result time (0 unknown);
// dn = its session's Acc.dn: done() appends the call there, for the git-linkage scraper of the same line (vcs.ts)
export interface Pend { t: number; ts: string; arg: string; st: TS; sh: Cnt[]; rows: Rows | null; ri: number; sp: number[]; name: string; cmd: string; id: string; end: number; dn: Pend[] }

// duration histogram: bucket 0 = < 10 ms, bucket k = [EDGE[k-1], EDGE[k]), the last one ≥ 30 min (roughly ×2.5 per step)
export const EDGE = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000, 600000, 1800000];
export const HB = EDGE.length + 1;
const KEEP = 10; const CAP = 600; const PRUNE = 300;
function zeros(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0); return a; }
export function newTS(): TS { return { n: 0, err: 0, dn: 0, ms: 0, max: 0, out: 0, hist: zeros(HB), h: zeros(24), slow: [], errs: [] }; }
export function newCnt(): Cnt { return { n: 0, err: 0, add: 0, del: 0 }; }
export function hb(ms: number): number { let b = 0; for (const e of EDGE) { if (ms < e) break; b++; } return b; }
// ≈ q-quantile from the histogram: geometric middle of the bucket it falls in, never above the real max
export function pct(hist: number[], q: number, max: number): number {
  let tot = 0; for (const v of hist) tot += v;
  if (!tot) return -1;
  let acc = 0; let b = 0;
  for (const v of hist) { acc += v; if (acc >= q * tot) break; b++; }
  return b >= HB - 1 ? max : Math.min(max, numAt0(MID, b));
}
// geometric bucket middles, precomputed: static scriptc builds have no Math.sqrt/pow/log
const MID = [5, 16, 35, 71, 158, 354, 707, 1581, 3536, 7071, 17321, 42426, 103923, 328634, 1039230];
export function fmtMs(ms: number): string {
  if (ms < 0) return "n/a";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m" + Math.floor((ms % 60000) / 1000) + "s";
  return Math.floor(ms / 3600000) + "h" + Math.floor((ms % 3600000) / 60000) + "m";
}

// bounded top-k: when a day's map outgrows CAP, keep the PRUNE most used entries
export function cnt(m: Map<string, Cnt>, k: string): Cnt {
  let c = m.get(k);
  if (!c) { c = newCnt(); m.set(own(k), c); } // kept with the ledger: own() (util/own.ts)
  c.n++;
  if (m.size > CAP) {
    const keep = [...m.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, PRUNE);
    m.clear();
    for (const [kk, v] of keep) m.set(kk, v);
  }
  return c;
}

// the OTLP exporter's view of each finished call (exact duration, error flag, exit codes, real tool name); null outside it
let callTap: ((id: string, ms: number, err: boolean, codes: number[], name: string) => void) | null = null;
export function setCallTap(f: ((id: string, ms: number, err: boolean, codes: number[], name: string) => void) | null): void { callTap = f; }
// a result arrived: ms < 0 = duration unknown, out = result size (bytes, approximate)
export function done(p: Pend, ms: number, err: boolean, out: number, id: string, codes: number[]): void {
  const tap = callTap; if (tap) tap(id, ms, err, codes, p.name);
  const st = p.st;
  const r: Rec = { t: p.t, ms, id: own(id), ts: p.ts, arg: p.arg }; // id: often a regex capture of the result line
  const rw = p.rows; const i = p.ri;
  if (rw && i >= 0 && i < rw.n) { rw.err[i] = err ? 1 : 0; rw.ms[i] = ms >= 0 && ms < 86400000 ? ms : -1; rw.out[i] = out; }
  st.out = st.out + out;
  if (err) { st.err = st.err + 1; st.errs.push(r); if (st.errs.length > KEEP) st.errs.shift(); }
  if (p.t > 0 && ms > 0 && ms < 86400000) { p.sp.push(p.t); p.sp.push(p.t + ms); } // a 20-minute test run is active time without lines
  p.end = p.t > 0 && ms >= 0 && ms < 86400000 ? p.t + ms : 0;
  if (p.dn.length >= 32) p.dn.splice(0, 16); // callers that never scrape (checks feeding usage() alone): stay bounded
  p.dn.push(p);
  if (ms >= 0 && ms < 86400000) {
    st.dn = st.dn + 1; st.ms = st.ms + ms;
    if (ms > st.max) st.max = ms;
    const b = hb(ms); st.hist[b] = (st.hist[b] ?? 0) + 1;
    if (st.slow.length < KEEP || ms > (st.slow[st.slow.length - 1] ?? r).ms) {
      st.slow.push(r); st.slow.sort((x, y) => y.ms - x.ms);
      if (st.slow.length > KEEP) st.slow.pop();
    }
  }
  // per-command errors: exit codes line up with the commands when there is one per command, else the call's verdict counts for all
  const nc = Math.floor(p.sh.length / 2);
  for (let i = 0; i < nc; i++) {
    const e = codes.length === nc ? numAt0(codes, i) !== 0 : err;
    if (!e) continue;
    for (const c of p.sh.slice(i * 2, i * 2 + 2)) c.err = c.err + 1;
  }
}
function numAt0(a: number[], i: number): number { let v = 0; for (const x of a.slice(i, i + 1)) v = x; return v; }
// a finished call whose run went on after its result (a Codex yield, harness/codex.ts): its duration grows to ms — the
// row, the day's sums and histogram (moved, not counted twice), the active time — and it failed when err. Never shrinks.
export function extend(p: Pend, ms: number, err: boolean): void {
  if (p.t <= 0 || ms >= 86400000) return;
  const old = p.end > 0 ? p.end - p.t : -1;
  const rw = p.rows; const i = p.ri; const st = p.st;
  const row = !!rw && i >= 0 && i < rw.n && (rw.cid[i] ?? "") === p.id; // still its row (a prune since moves rows of done calls)
  if (err && rw && row && rw.err[i] !== 1) { rw.err[i] = 1; st.err = st.err + 1; }
  if (ms <= old) return;
  if (rw && row) rw.ms[i] = ms;
  if (old >= 0) { const b0 = hb(old); st.hist[b0] = Math.max(0, (st.hist[b0] ?? 0) - 1); st.ms = st.ms - old; } else st.dn = st.dn + 1;
  const b = hb(ms); st.hist[b] = (st.hist[b] ?? 0) + 1; st.ms = st.ms + ms; if (ms > st.max) st.max = ms;
  const sl: Rec[] = []; for (const r of st.slow) if (r.id !== p.id || r.t !== p.t) sl.push(r); // this call's old entry goes
  sl.push({ t: p.t, ms, id: own(p.id), ts: p.ts, arg: p.arg }); sl.sort((x, y) => y.ms - x.ms);
  st.slow = sl.slice(0, KEEP);
  p.sp.push(p.t); p.sp.push(p.t + ms); p.end = p.t + ms;
}

// ── shell commands ──────────────────────────────────────────────────────────
const WRAP = ["sudo", "env", "timeout", "nice", "nohup", "time", "command", "exec", "caffeinate", "do", "then", "else", "!"];
const SKIP = ["cd", "pushd", "export", "source", ".", "set", "unset", "ulimit", "true", "for", "while", "until", "if", "done", "fi", "esac"];
export function norm(cmd: string): string { return normFull(cmd).slice(0, 200); }
// one line, whitespace collapsed, not cut (norm keeps the first 200 characters of it)
export function normFull(cmd: string): string { return clean(cmd).replace(/\s+/g, " ").trim(); }
// what indexing asks the command families (wait/family.ts sets these): hint = the family hint of a line longer than norm
// keeps (famHint, "" none), booked = a stored command id, its family worked out now (inside the paced index slice, so a
// first Wait report finds them done)
// mayHide = could a stored 200-character text have lost its family to the cut (callcache.ts: a format-2 file, which has no
// hints, reads on when none of its texts could)
export const CMDS = { hint: (full: string): string => "", booked: (id: number): void => {}, mayHide: (cut: string): boolean => true };
// program = first real command of the chain: env assignments, wrappers (sudo, env, timeout N, …) and cd/export steps skipped
export function program(cmd: string): string {
  let first = "";
  for (const seg of cmd.split(/&&|\|\||;|\||\n/)) {
    const w = seg.trim().split(/\s+/).filter((x) => x.length > 0);
    let i = 0; let wrapped = false;
    while (i < w.length) {
      const x = w[i] ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) || (wrapped && (x.startsWith("-") || /^[0-9.]+[smhd]?$/.test(x)))) { i++; continue; }
      if (WRAP.indexOf(x) >= 0) { i++; wrapped = true; continue; }
      break;
    }
    const p = (w[i] ?? "").replace(/^[("'{]+/, "").replace(/["')}]+$/, "");
    if (!p) continue;
    if (!first) first = p;
    if (SKIP.indexOf(p) >= 0) continue;
    return base(p);
  }
  return base(first) || "sh";
}
function base(p: string): string { const i = p.lastIndexOf("/"); return (i >= 0 && i < p.length - 1 ? p.slice(i + 1) : p).slice(0, 40); }
// codex shell args: a string, or an argv like ["bash", "-lc", "<script>"]
export function argv(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  const a: string[] = [];
  for (const x of v as unknown[]) if (typeof x === "string") a.push(x);
  const sh = a[0] ?? "";
  if (a.length >= 3 && (sh.endsWith("sh") || sh.endsWith("bash")) && ((a[1] ?? "") === "-c" || (a[1] ?? "") === "-lc")) return a[2] ?? "";
  return a.join(" ");
}
// commands inside Codex's JS `exec` wrapper: tools.exec_command({cmd:"…"}) — string literals, JSON-decodable when double-quoted
export function execCmds(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/exec_command\(\s*\{[^}]*?(?:\bcmd|"cmd"|'cmd')\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) { // cmd: or a JSON-style "cmd":
    const lit = m[1] ?? "";
    let s = lit.slice(1, -1);
    if (lit.startsWith("\"")) { try { const v: unknown = JSON.parse(lit); if (typeof v === "string") s = v; } catch (e) { /* keep raw */ } }
    if (s) out.push(s);
  }
  return out;
}
// exit codes in a Codex tool output line, in order (raw JSONL: nested JSON text escapes its quotes once)
export function exitCodes(l: string): number[] {
  const out: number[] = [];
  const nd = "exit_code\\\":";
  let at = l.indexOf(nd);
  while (at >= 0) {
    const m = /^\s*(-?\d+)/.exec(l.slice(at + nd.length, at + nd.length + 12));
    if (m) out.push(Number(m[1] ?? "0"));
    at = l.indexOf(nd, at + nd.length);
  }
  return out;
}
export function codexFailed(l: string, codes: number[]): boolean {
  for (const c of codes) if (c !== 0) return true;
  if (/Process exited with code [1-9]|Exit code:? [1-9]/.test(l.slice(0, 4096))) return true;
  const h = l.slice(0, 600);
  return h.indexOf("Script failed") >= 0 || h.indexOf("Script error") >= 0 || l.indexOf("\\\"status\\\":\\\"rejected\\\"") >= 0;
}

// ── apply_patch ─────────────────────────────────────────────────────────────
export interface FileCh { p: string; add: number; del: number }
// per-file +/- of a Codex patch (*** Update/Add/Delete File: headers); lines before any header count under ""
export function patchFiles(patch: string): FileCh[] {
  const out: FileCh[] = [];
  let cur: FileCh = { p: "", add: 0, del: 0 };
  out.push(cur);
  for (const l of patch.split("\n")) {
    const h = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(l);
    if (h) { cur = { p: (h[1] ?? "").trim(), add: 0, del: 0 }; out.push(cur); continue; }
    if (l.startsWith("+") && !l.startsWith("+++")) cur.add++;
    else if (l.startsWith("-") && !l.startsWith("---")) cur.del++;
  }
  return out;
}

// ── MCP ─────────────────────────────────────────────────────────────────────
// mcp__<server>__<tool> → server ("" for built-in tools); servers may contain single underscores
export function mcpServer(name: string): string {
  if (!name.startsWith("mcp__")) return "";
  const i = name.indexOf("__", 5);
  return i > 5 ? name.slice(5, i) : "";
}
export function argSummary(s: string): string { const t = clean(s).replace(/\s+/g, " ").trim(); return t.length > 120 ? t.slice(0, 120) : t; }
