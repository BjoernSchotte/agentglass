// agentglass — filter language: tokenizer, parser, canonical printer, errors with columns (spec §1, §10)
// SPDX-License-Identifier: Apache-2.0
//   expr = term { [and | ,] term }; term = [not | -] (key op value… | text)
// A term is a clause only where a known key (or alias) is followed by an operator; anything else is a text term, so
// today's plain `/foo` keeps working (`foo` = text ~ foo). OR exists only inside is_one_of; no parentheses.
import type { Attr, AType, Clause, Parsed, QErr } from "./types.ts";
import { attrOf, keys, aliases, canonEnum, enumValues, opsOf, opHint, isNumeric } from "./attrs.ts";

interface Tok { s: string; q: boolean; col: number }
const OPS = ["is", "is_not", "is_one_of", "is_not_one_of", "=", "!=", "~", "!~", ">", ">=", "<", "<="];
const SYM = [">=", "<=", "!=", "!~", "=", "~", ">", "<"]; // longest first: split "cost>=2"
const RANGE = [">", ">=", "<", "<="];
const INV = new Map<string, string>([["is", "is_not"], ["is_not", "is"], ["~", "!~"], ["!~", "~"], ["is_one_of", "is_not_one_of"], ["is_not_one_of", "is_one_of"]]);

function opOf(t: Tok): string {
  if (t.q) return "";
  const l = t.s.toLowerCase();
  if (OPS.indexOf(l) < 0) return "";
  return l === "=" ? "is" : l === "!=" ? "is_not" : l;
}
function word(t: Tok | null, w: string): boolean { return !!t && !t.q && t.s.toLowerCase() === w; }

// words, quoted strings (\" and \\ escapes) and "," tokens; "cost>2" splits into key, op, value
function tokenize(src: string): { toks: Tok[]; err: QErr | null } {
  const toks: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c === ",") { toks.push({ s: ",", q: false, col: i }); i++; continue; }
    if (c === "\"") {
      const at = i; let v = ""; i++; let closed = false;
      while (i < src.length) {
        const d = src.charAt(i);
        if (d === "\\" && i + 1 < src.length) { v += src.charAt(i + 1); i += 2; continue; }
        if (d === "\"") { closed = true; i++; break; }
        v += d; i++;
      }
      if (!closed) return { toks, err: { msg: "unterminated quote at column " + String(at + 1), col: at } };
      toks.push({ s: v, q: true, col: at }); continue;
    }
    const at = i; let w = "";
    while (i < src.length) { const d = src.charAt(i); if (d === " " || d === "\t" || d === "\n" || d === "," || d === "\"") break; w += d; i++; }
    splitWord(w, at, toks);
  }
  return { toks, err: null };
}
function splitWord(w: string, col: number, toks: Tok[]): void {
  const prev = toks.length ? toks[toks.length - 1] : null;
  // "<key><op><value>" or, right after a key, "<op><value>" ("cost >2"); "~/x" after a key stays a value-like word
  let k = 0;
  while (k < w.length && "<>=!~".indexOf(w.charAt(k)) < 0) k++;
  const head = w.slice(0, k);
  const keyFirst = k > 0 && k < w.length && (!!attrOf(head) || (head.charAt(0) === "-" && !!attrOf(head.slice(1))));
  const afterKey = k === 0 && !!prev && !prev.q && !!attrOf(prev.s) && toks.length > 0 && !(toks.length > 1 && opOf(toks[toks.length - 2]) !== "");
  if (keyFirst || afterKey) {
    const rest = w.slice(k);
    for (const op of SYM) {
      if (!rest.startsWith(op)) continue;
      const val = rest.slice(op.length);
      if (op === "~" && val.startsWith("/") && afterKey) break;
      if (keyFirst) toks.push({ s: head, q: false, col });
      toks.push({ s: op, q: false, col: col + k });
      if (val) toks.push({ s: val, q: false, col: col + k + op.length });
      return;
    }
  }
  toks.push({ s: w, q: false, col });
}

function lev(a: string, b: string): number {
  let prev: number[] = []; for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, sub));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}
// the closest key or alias within edit distance 2 ("" none)
export function suggest(k: string): string {
  let best = ""; let bd = 3; const l = k.toLowerCase();
  for (const c of keys().concat(aliases())) { const d = lev(l, c); if (d < bd) { bd = d; best = c; } }
  return best;
}

// value syntax per type (spec §1.6); "" = ok, else the error message
const NUMRE: Record<string, RegExp> = {
  usd: /^\$?\d+(\.\d+)?$/, tok: /^\d+(\.\d+)?[kKmM]?$/, size: /^\d+(\.\d+)?([kKmMgG]?[bB]|[kKmMgG])?$/,
  dur: /^\d+(\.\d+)?(ms|s|m|h|d)$/, ratio: /^\d+(\.\d+)?%?$/, num: /^-?\d+(\.\d+)?$/,
};
const EXAMPLE: Record<string, string> = { usd: "> 2, {k} > $0.50", tok: "> 40k, {k} > 1.5M", size: "> 100KB, {k} > 1MB", dur: "> 30s, {k} > 500ms", ratio: "> 20%, {k} > 0.2", num: "> 10" };
function validDate(v: string): boolean {
  const l = v.toLowerCase();
  if (l === "today" || l === "yesterday" || /^-\d+d$/.test(l)) return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); if (!m) return false;
  const y = Number(m[1] ?? ""); const mo = Number(m[2] ?? ""); const d = Number(m[3] ?? "");
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= (dim[mo - 1] ?? 0);
}
// a value checked and canonicalized for its attribute: { v, err }
function value(a: Attr, op: string, v: string): { v: string; err: string } {
  const k = a.key; const t: AType = a.type;
  if (v.toLowerCase() === "unknown" && (op === "is" || op === "is_not") && (isNumeric(t) || t === "text" || t === "path")) return { v: "unknown", err: "" };
  if (t === "enum") {
    const c = canonEnum(a, v);
    return c ? { v: c, err: "" } : { v, err: k + " is one of " + enumValues(a).join(", ") + " — got \"" + v + "\"" };
  }
  if (t === "bool") {
    const l = v.toLowerCase();
    if (l === "true" || l === "yes") return { v: "true", err: "" };
    if (l === "false" || l === "no") return { v: "false", err: "" };
    return { v, err: "\"" + k + "\" is true or false, got \"" + v + "\"" };
  }
  if (t === "date") return validDate(v) ? { v: v.toLowerCase(), err: "" } : { v, err: "\"" + k + "\" needs a date (2026-10-01, today, yesterday, -7d), got \"" + v + "\"" };
  if (isNumeric(t)) {
    const re = NUMRE[t];
    if (re && re.test(v)) return { v, err: "" };
    const what = t === "dur" ? "a duration" : "a number";
    return { v, err: "\"" + k + "\" needs " + what + " (e.g. " + k + " " + (EXAMPLE[t] ?? "> 1").split("{k}").join(k) + "), got \"" + v + "\"" };
  }
  return { v, err: "" };
}

function clauseStart(toks: Tok[], i: number): boolean {
  const t = i < toks.length ? toks[i] : null; const n = i + 1 < toks.length ? toks[i + 1] : null;
  return !!t && !!n && !t.q && opOf(n) !== "" && t.s !== "," && OPS.indexOf(t.s.toLowerCase()) < 0;
}
function text(v: string, neg: boolean): Clause { return { key: "text", op: neg ? "!~" : "~", vals: [v], neg: false, pinned: false }; }
function fail(cs: Clause[], msg: string, col: number): Parsed { return { cs, err: { msg, col }, notes: [] }; }

export function parse(src: string): Parsed {
  const tk = tokenize(src);
  if (tk.err) return { cs: [], err: tk.err, notes: [] };
  const toks = tk.toks; const cs: Clause[] = [];
  let i = 0; let neg = false; let negCol = -1;
  let conn: Tok | null = null; // the last connector while no filter followed it yet
  while (i < toks.length) {
    const t = toks[i];
    if (!t.q && (t.s === "," || t.s.toLowerCase() === "and")) {
      if (neg) return fail(cs, "\"not\" needs a filter after it", negCol);
      if (conn || !cs.length) return fail(cs, "\"" + t.s + "\" needs a filter before it", t.col); // leading or doubled
      conn = t; i++; continue;
    }
    if (!word(t, "not")) conn = null;
    if (word(t, "or")) return fail(cs, "\"or\" is not supported; use is_one_of (tool is_one_of Bash Edit)", t.col);
    if (word(t, "not")) { neg = !neg; negCol = t.col; i++; continue; }
    // -<key> <op> … = not <key> <op> …; -word = text !~ word
    if (!t.q && t.s.length > 1 && t.s.charAt(0) === "-") {
      const rest = t.s.slice(1);
      const n = i + 1 < toks.length ? toks[i + 1] : null;
      if (n && opOf(n) !== "" && (attrOf(rest) || /^[a-z_.]+$/i.test(rest))) { toks[i] = { s: rest, q: false, col: t.col + 1 }; neg = !neg; negCol = t.col; continue; }
      cs.push(text(rest, !neg)); neg = false; i++; continue;
    }
    if (!clauseStart(toks, i)) { cs.push(text(t.s, neg)); neg = false; i++; continue; }
    // key op value…
    const a = attrOf(t.s);
    if (!a) { const sg = suggest(t.s); return fail(cs, "unknown key \"" + t.s + "\"" + (sg ? " — did you mean " + sg + "?" : ""), t.col); }
    const ot = toks[i + 1]; let op = opOf(ot);
    if (a.key === "content" && (op === "is_one_of" || op === "is_not_one_of")) return fail(cs, "content " + op + " is not supported; use two content ~ clauses", ot.col);
    if (opsOf(a).indexOf(op) < 0) return fail(cs, "\"" + ot.s + "\" does not apply to " + a.key + (a.ops.length ? "" : " (" + a.type + ")") + "; use " + opHint(a), ot.col);
    i += 2;
    const vals: string[] = [];
    const multi = op === "is_one_of" || op === "is_not_one_of";
    while (i < toks.length) {
      const v = toks[i];
      if (!v.q && (v.s === "," || v.s.toLowerCase() === "and" || v.s.toLowerCase() === "or")) break;
      if (vals.length > 0 && (clauseStart(toks, i) || word(v, "not") || (!v.q && v.s.charAt(0) === "-" && i + 1 < toks.length && opOf(toks[i + 1]) !== ""))) break;
      if (vals.length === 0 && !v.q && clauseStart(toks, i)) break;
      const cv = value(a, op, v.s);
      if (cv.err) return fail(cs, cv.err, v.col);
      vals.push(cv.v); i++;
      if (!multi) break;
    }
    if (!vals.length) return fail(cs, a.key + " " + op + " …: needs a value", ot.col);
    let cneg = false;
    if (neg) { if (RANGE.indexOf(op) >= 0) cneg = true; else op = INV.get(op) ?? op; }
    cs.push({ key: a.key, op, vals, neg: cneg, pinned: false });
    neg = false;
  }
  if (neg) return fail(cs, "\"not\" needs a filter after it", negCol);
  if (conn) return fail(cs, "\"" + conn.s + "\" needs a filter after it", conn.col);
  return { cs, err: null, notes: [] };
}

const KEYWORDS = ["and", "or", "not"].concat(OPS);
// quoted when empty, with blanks, quotes, commas or backslashes, or equal to a keyword; a value equal to a key too
// (except validated enum values), so a reader never mistakes it for the start of the next clause
function q(v: string, en: boolean): string {
  const l = v.toLowerCase();
  const plain = v !== "" && !/[\s",\\]/.test(v) && KEYWORDS.indexOf(l) < 0 && (en || !attrOf(l));
  return plain ? v : "\"" + v.split("\\").join("\\\\").split("\"").join("\\\"") + "\"";
}
export function printClause(c: Clause): string {
  const a = attrOf(c.key); const en = !!a && (a.type === "enum" || a.type === "bool");
  const vs: string[] = []; for (const v of c.vals) vs.push(q(v, en));
  return (c.neg ? "not " : "") + c.key + " " + c.op + " " + vs.join(" ");
}
export function print(cs: Clause[]): string { const o: string[] = []; for (const c of cs) o.push(printClause(c)); return o.join(" and "); }
export function caret(src: string, e: QErr): string { return src + "\n" + " ".repeat(Math.max(0, e.col)) + "^"; }
export function sameClause(a: Clause, b: Clause): boolean {
  if (a.key !== b.key || a.op !== b.op || a.neg !== b.neg || a.vals.length !== b.vals.length) return false;
  for (let i = 0; i < a.vals.length; i++) if ((a.vals[i] ?? "").toLowerCase() !== (b.vals[i] ?? "").toLowerCase()) return false;
  return true;
}
// a value as it must be typed (quoted when it would not survive as a bare word)
export function quoteVal(v: string): string { return q(v, false); }
