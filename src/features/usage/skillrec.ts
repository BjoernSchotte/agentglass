// agentglass — skill attribution engine: one record per skill load, and each request's tokens shared out to the loads in
// context (skill-usage spec §3). Pure over its arguments: record.ts owns the Acc/Day wiring (skillLoad, skillReq, …)
// SPDX-License-Identifier: Apache-2.0
import { HOME } from "../../util/fs.ts";
import { own, pooled } from "../../util/own.ts";

// one load of a skill (in load order); bytes/S -1 = text not visible; end 0 = still in context.
// trig user | model | compact | listing; why "" | compact | clear | drop | relist; tu = turn (human prompts before it),
// te = end of its loading turn (0 open); rq0 = requests booked before it; S = size in tokens (bounded by the growth at its
// load request, §3.2); pend = not sent yet; short = tokens it could not get (requests smaller than Σ S); nq = requests
// carried; lt/ct/tt = load / carry / tail tokens [in, cacheRead, write5m, write1h]; hb = of lt+ct the tokens of
// harness-priced requests (never re-priced), hu/hl/ht = their $ share (all / of it load / tail); off/len = where the text is in the log
// (source cursor units: bytes, or records), rec = a database record id; mdl/prov = model + provider of the load request;
// est = size ≈ (cut, assembled from parts); n = loads this record stands for (> 1: older ended loads folded, the cap);
// rd = loaded by reading its SKILL.md; h1/h2 = the text's running FNV pair (hash = its hex), pg = tokens grown after the load request, not sent yet
export interface SkLoad {
  name: string; trig: string; t: number; tu: number; te: number; rq0: number;
  bytes: number; S: number; hash: string; dir: string; scope: string;
  end: number; why: string; rel: boolean; stub: boolean; pend: boolean; short: number;
  nq: number; lt: number[]; ct: number[]; tt: number[]; hb: number[]; hu: number; hl: number; ht: number;
  off: number; len: number; rec: string; mdl: string; prov: string; est: boolean; n: number; rd: boolean;
  h1: number; h2: number; pg: number;
}
// a SKILL.md read waiting for its output (by call id, not persisted): the path, the call line's place in the log, its turn
export interface SkRead { path: string; off: number; tu: number }

// UTF-8 bytes per token of a skill text (spec Decision 2, Open question 8), per tokenizer family. Measured 2026-10-09 on five
// public SKILL.md texts (5.6–18.7 KB of markdown with code and JSON): a request's context with the text minus one without.
// Claude Sonnet 5.5: 2.57 pooled (2.37–3.35 per text); Gemini 3.5 Flash-Lite: 3.93 (3.63–4.71). Claude's newer tokenizer
// (Opus 4.7 and later) takes about a third more tokens than the older one, which 3.6 fits; GPT/Codex is not measured here:
// 3.6 (o200k on such text: ≈ 3.5–4). Spread per text ±15 %; the context growth bounds the size from above (§3.2)
export const SKILL_BPT = 3.6; export const CLAUDE_BPT = 2.6; export const GEMINI_BPT = 3.9;
// the divisor for the model a load was sent with ("" = not sent yet: the default)
export function bptOf(model: string): number {
  const m = model.toLowerCase();
  if (m.indexOf("gemini") >= 0) return GEMINI_BPT;
  if (m.indexOf("claude") < 0 && !/(^|[\/.])(opus|sonnet|haiku|fable)-\d/.test(m)) return SKILL_BPT;
  const v = /(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?/.exec(m); // claude-opus-4-7, us.anthropic.claude-sonnet-5-5-v1; claude-3-5-sonnet: old naming
  if (!v) return SKILL_BPT;
  const major = Number(v[2] ?? "0"); const minor = Number(v[3] ?? "0");
  if (major >= 100) return SKILL_BPT; // claude-3-5-sonnet-20241022: the date is no version
  return major > 4 || (major === 4 && minor >= 7 && minor < 100) ? CLAUDE_BPT : SKILL_BPT; // a date suffix (…-4-20250514) is no minor
}
export const SK_CAP = 400; // loads kept per log; beyond, the oldest ended loads fold per name
export const LISTING = "(listing)";
// skills bundled with Claude Code (the same on every install; the /help skill list, invoked_skills paths "bundled:<name>"):
// they have no "Base directory" line, so a user's /<name> is told from a plain prompt command by its name alone
export const CLAUDE_BUNDLED = ["update-config", "claude-api", "keybindings-help", "simplify", "loop", "schedule", "fewer-permission-prompts",
  "code-review", "security-review", "review", "init", "workflow-authoring", "artifact-design", "artifact-diagramming", "artifact-capabilities",
  "claude-in-chrome", "run", "verify", "debug", "batch"];
// Day.sa slots: loads by trigger, then [in, cacheRead, write5m, write1h] of load, carry and tail, then harness-priced $
// (all, of it the load part, the tail part)
export const SA_LU = 0; export const SA_LM = 1; export const SA_LC = 2; export const SA_L = 3; export const SA_C = 7; export const SA_T = 11; export const SA_HU = 15; export const SA_HL = 16; export const SA_HT = 17; export const SA_N = 18;
export const HP = "="; // provider prefix of a Day.sa row booked from harness-priced requests: its $ is SA_HU, never re-priced

// UTF-8 byte length (no encoder needed)
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; } else n += 3;
  }
  return n;
}
export function sizeEst(bytes: number, model = ""): number { return bytes < 0 ? -1 : Math.ceil(bytes / bptOf(model)); }
// the version identity: two FNV-1a hashes (callcache.ts pathKey scheme) over the text, 16 hex chars; fed in parts
export const FNV1 = 2166136261; export const FNV2 = 3735928559;
export function fnvFeed(h0: number, s: string): number { let h = h0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const HEX = "0123456789abcdef";
function hex8(n: number): string { let o = ""; for (let i = 28; i >= 0; i -= 4) o += HEX.charAt((n >>> i) & 15); return o; }
export function hashHex(h1: number, h2: number): string { return hex8(h1) + hex8(h2); }
// 8 hex chars back to the number (a pending load's running hash after a restart); bad input → def (the offset basis)
export function hexNum(s: string, def: number): number {
  if (s.length !== 8) return def;
  let n = 0; for (let i = 0; i < 8; i++) { const v = HEX.indexOf(s.charAt(i)); if (v < 0) return def; n = n * 16 + v; }
  return n;
}
export function skillHash(text: string): string { return hashHex(fnvFeed(FNV1, text), fnvFeed(FNV2, text)); }

// where a skill lives, from its base directory: user | project | plugin | builtin | ?
export function scopeOf(dir: string): string {
  if (!dir) return "?";
  const d = dir.split("\\").join("/");
  if (d.startsWith("bundled:") || d.indexOf("/skills/.system/") >= 0) return "builtin";
  if (d.indexOf("/plugins/") >= 0) return "plugin";
  const h = HOME.split("\\").join("/");
  for (const u of ["/.claude/skills/", "/.codex/skills/", "/.agents/skills/", "/.gemini/skills/", "/.pi/agent/skills/", "/.pi/skills/", "/.config/opencode/skill", "/.opencode/skill"]) {
    const i = d.indexOf(u);
    if (i >= 0) return d.slice(0, i) === h ? "user" : "project";
  }
  return "?";
}

// the skill a path names: …/skills/<dir>/SKILL.md → <dir>; under …/plugins/…: <plugin>:<dir> (the plugin is the segment
// before skills/, or before its version segment); "" for any other path
export function skillPath(path: string): string {
  const p = path.split("\\").join("/").split("/");
  const n = p.length;
  if (n < 3 || p[n - 1] !== "SKILL.md" || p[n - 3] !== "skills") return "";
  const dir = p[n - 2] ?? ""; if (!dir || dir === "." || dir === "..") return "";
  let pi = -1; for (let i = 0; i < n; i++) if (p[i] === "plugins") pi = i;
  if (pi < 0 || pi >= n - 3) return dir;
  let k = n - 4; // the segment before skills/
  if (k > pi && /^v?\d/.test(p[k] ?? "")) k--; // …/<plugin>/<version>/skills/
  const plug = k > pi ? p[k] ?? "" : "";
  return plug ? plug + ":" + dir : dir;
}
const READERS = ["cat", "sed", "nl", "head", "tail", "less", "bat", "rg", "grep"];
const WRAPS = ["sudo", "command", "env", "nice", "time", "rtk", "exec"];
// shell words of one command (quotes removed, no expansion)
function words(seg: string): string[] {
  const out: string[] = []; let cur = ""; let q = ""; let any = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charAt(i);
    if (q) { if (c === q) q = ""; else if (c === "\\" && q === "\"" && i + 1 < seg.length) { i++; cur += seg.charAt(i); } else cur += c; continue; }
    if (c === "'" || c === "\"") { q = c; any = true; continue; }
    if (c === " " || c === "\t") { if (cur || any) out.push(cur); cur = ""; any = false; continue; }
    if (c === "\\" && i + 1 < seg.length) { i++; cur += seg.charAt(i); continue; }
    cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}
// the SKILL.md path a shell command line reads: a reading program (after cd …&&, sudo, rtk, env assignments; never after a
// pipe; rtk proxy too) with a path argument skillPath() names; "" for anything else (ls, find, wc, an editor)
export function skillReadCmd(cmd: string): string {
  if (cmd.indexOf("SKILL.md") < 0) return "";
  for (const line of cmd.split("\n")) {
    for (const part of line.split(/&&|\|\||;/)) {
      const seg = part.split("|")[0] ?? ""; // a pipe's later stages read their stdin
      const w = words(seg.trim());
      let i = 0;
      while (i < w.length && (WRAPS.indexOf(w[i] ?? "") >= 0 || (i > 0 && w[i - 1] === "rtk" && w[i] === "proxy") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i] ?? ""))) i++;
      const prog = w[i] ?? ""; const base = prog.slice(prog.lastIndexOf("/") + 1);
      const rtkRead = i > 0 && w[i - 1] === "rtk" && base === "read";
      if (READERS.indexOf(base) < 0 && !rtkRead) continue;
      for (let j = i + 1; j < w.length; j++) { const a = w[j] ?? ""; if (!a.startsWith("-") && a.endsWith("SKILL.md") && skillPath(a)) return a; }
    }
  }
  return "";
}

// SkLoad.hb until a harness-priced request books into it (most loads are table-priced): shared, never written
export const NO_HB: number[] = [0, 0, 0, 0];
// "view skill" (skills/text.ts) parses the load's log lines again with capture on: the texts a parse loads, in order
// (a grown load's parts appended), so the one whose hash matches can be shown. Off for every ledger read: text is never kept
export interface SkCap { name: string; parts: string[] }
export const SKCAP = { on: false, out: [] as SkCap[] };
export function newLoad(name: string, trig: string, ms: number, text: string, known: boolean, dir: string, est: boolean, tu: number, rq0: number, off: number, len: number, rec: string): SkLoad {
  const h1 = known ? fnvFeed(FNV1, text) : FNV1; const h2 = known ? fnvFeed(FNV2, text) : FNV2;
  const bytes = known ? utf8Len(text) : -1;
  if (SKCAP.on && known) SKCAP.out.push({ name: own(name), parts: [text] });
  return { name: pooled(name), trig: pooled(trig), t: ms, tu, te: 0, rq0, bytes, S: sizeEst(bytes), hash: known ? pooled(hashHex(h1, h2)) : "", dir: pooled(dir), scope: pooled(scopeOf(dir)),
    end: 0, why: "", rel: false, stub: false, pend: true, short: 0, nq: 0, lt: [0, 0, 0, 0], ct: [0, 0, 0, 0], tt: [0, 0, 0, 0], hb: NO_HB, hu: 0, hl: 0, ht: 0,
    off, len, rec: own(rec), mdl: "", prov: "", est, n: 1, rd: false, h1, h2, pg: 0 };
}
// more text of the same load (a skill text over several lines, a second partial read): bytes, hash and size grow; once the
// load was sent the extra tokens go out with the next request (pg)
export function growLoad(l: SkLoad, text: string, lineEnd: number): void {
  const nb = utf8Len(text); if (nb <= 0) return;
  if (SKCAP.on) for (let i = SKCAP.out.length - 1; i >= 0; i--) { const c = SKCAP.out[i] as SkCap; if (c.name === l.name) { c.parts.push(text); break; } }
  const was = l.S;
  l.bytes = (l.bytes < 0 ? 0 : l.bytes) + nb;
  l.h1 = fnvFeed(l.h1, text); l.h2 = fnvFeed(l.h2, text); l.hash = pooled(hashHex(l.h1, l.h2));
  l.S = sizeEst(l.bytes, l.pend ? "" : l.mdl);
  if (!l.pend) l.pg += l.S - Math.max(0, was);
  if (lineEnd > l.off && l.off >= 0) l.len = lineEnd - l.off;
}

// take up to want tokens from the request's remaining buckets b in the given order into got[] (zeroed first); returns the sum
function take(b: number[], want: number, order: number[], got: number[]): number {
  got[0] = 0; got[1] = 0; got[2] = 0; got[3] = 0;
  let left = want;
  for (let k = 0; k < order.length; k++) {
    if (left <= 0) break;
    const i = (order[k] ?? 0) + 0;
    const have = b[i] ?? 0; if (have <= 0) continue;
    const t = have < left ? have : left;
    b[i] = have - t; got[i] = t; left -= t;
  }
  return want - left;
}
const LOAD_ORDER = [2, 3, 0, 1]; // new text is written to the cache: write5m → write1h → in → cacheRead
const CARRY_ORDER = [1, 2, 3, 0]; // a prefix is read from the cache; after an expiry written again
export function saKey(name: string, prov: string, model: string): string { return name + "\t" + prov + "\t" + model; }
export function saRow(sa: Map<string, number[]>, name: string, prov: string, model: string): number[] {
  const k = saKey(name, prov, model); let r = sa.get(k);
  if (!r) { r = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; sa.set(pooled(k), r); } // SA_N slots, a literal: exact capacity
  return r;
}
function addTo(x: number[], at: number, g: number[]): void { for (let i = 0; i < 4; i++) x[at + i] = (x[at + i] ?? 0) + (g[i] ?? 0); }
// what one load got from this request: into the load (field arrays), its tail (carry only), the day row, the harness-priced share
function book(l: SkLoad, g: number[], slot: number, tail0: boolean, row: number[], hp: boolean, usd: number, w: number[], wReq: number): void {
  const into = slot === SA_L ? l.lt : l.ct; const tail = tail0 && slot === SA_C; // tail = carry in a later turn, never the load
  addTo(into, 0, g); addTo(row, slot, g);
  if (tail) { addTo(l.tt, 0, g); addTo(row, SA_T, g); }
  if (!hp) return;
  if (l.hb === NO_HB) l.hb = [0, 0, 0, 0];
  addTo(l.hb, 0, g);
  let wl = 0; for (let i = 0; i < 4; i++) wl += (g[i] ?? 0) * (w[i] ?? 1);
  const u = wReq > 0 ? usd * wl / wReq : 0;
  l.hu = l.hu + u; if (tail) l.ht = l.ht + u; if (slot === SA_L) l.hl = l.hl + u;
  row[SA_HU] = (row[SA_HU] ?? 0) + u; if (tail) row[SA_HT] = (row[SA_HT] ?? 0) + u; if (slot === SA_L) row[SA_HL] = (row[SA_HL] ?? 0) + u;
}

// one request: b = its [in, cacheRead, write5m, write1h] (mutated: what is left after the skills), nOut its output,
// ctx/lastCtx its context and the previous request's; tq = human prompts so far; w = per-bucket weights [in, cr, w5, w1,
// out] for a harness-priced request's $ share (usd > 0; token counts when the model has no price). Implicit drop (§3.4),
// then carry oldest first (§3.3), then the loads sent with this request (§3.2), then text grown into open loads; books
// the loads and Day.sa (sa). Never takes more than b holds, per bucket (§3.8).
export function attribute(sk: SkLoad[], sa: Map<string, number[]>, model: string, prov: string, b: number[], nOut: number, ctx: number, lastCtx: number, tq: number, ms: number, usd: number, w: number[]): void {
  let sumS = 0;
  for (const l of sk) if (l.end === 0 && !l.pend && l.S > 0) sumS += l.S;
  if (lastCtx > 0 && ctx < 0.5 * lastCtx && ctx < sumS) for (const l of sk) if (l.end === 0 && !l.pend) { l.end = ms > 0 ? ms : 1; l.why = "drop"; }
  const hp = usd > 0;
  let wReq = 0; if (hp) { for (let i = 0; i < 4; i++) wReq += (b[i] ?? 0) * (w[i] ?? 1); wReq += nOut * (w[4] ?? 1); }
  const rp = hp ? HP + prov : prov;
  const g = [0, 0, 0, 0];
  for (const l of sk) { // carry, oldest first: it sits earlier in the prefix
    if (l.end !== 0 || l.pend || l.S <= 0) continue;
    const want = l.S - l.pg; // grown text not sent yet is load, below
    const n = take(b, want, CARRY_ORDER, g);
    l.short += want - n; l.nq++;
    book(l, g, SA_C, tq > l.tu, saRow(sa, l.name, rp, model), hp, usd, w, wReq);
  }
  let gl = ctx - lastCtx; // the context's growth: an upper bound for the new loads' sizes, shared in load order
  const bounded = gl > 0; // none (cache expiry, model switch): the size from the text stands
  for (const l of sk) { // sent with this request
    if (l.end !== 0 || !l.pend) continue;
    l.pend = false; l.mdl = pooled(model); l.prov = pooled(prov);
    if (l.S < 0) continue; // size unknown: counted, never priced
    l.S = sizeEst(l.bytes, model); // the tokenizer is known now
    if (bounded) { if (l.S > gl) l.S = gl > 0 ? gl : 0; gl -= l.S; }
    const n = take(b, l.S, LOAD_ORDER, g);
    l.short += l.S - n;
    book(l, g, SA_L, tq > l.tu, saRow(sa, l.name, rp, model), hp, usd, w, wReq);
  }
  for (const l of sk) { // text grown after the load was sent (a second partial read): goes out now, as load
    if (l.end !== 0 || l.pend || l.pg <= 0) continue;
    const n = take(b, l.pg, LOAD_ORDER, g);
    l.short += l.pg - n; l.pg = 0;
    book(l, g, SA_L, tq > l.tu, saRow(sa, l.name, rp, model), hp, usd, w, wReq);
  }
}
