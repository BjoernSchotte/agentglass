// agentglass — syntax highlighting (shiki-ish, tokyo-night palette) into styled segments
// SPDX-License-Identifier: Apache-2.0
import { parse } from "../util/json.ts";
import { clean, cw, cpOf, numAt } from "../util/text.ts";
import { S } from "../state.ts";
import { HL, RST, fg, bg } from "./theme.ts";

export interface Seg { s: string; t: string }
const KEYWORDS = new Set<string>(("const let var function return if else for while do switch case break continue new class extends import from export default " +
  "async await try catch finally throw typeof instanceof in of interface type enum implements public private protected static readonly void null undefined " +
  "true false this super yield def lambda pass elif not and or is None True False with as raise except global nonlocal func package struct map chan go defer " +
  "range fn impl pub mut use mod match self Self then fi done esac local export source print").split(" "));
export function langOf(path: string, text: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m ? (m[1] ?? "").toLowerCase() : "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "c", "h", "cpp", "cs", "swift", "kt", "zig", "css", "scss"].indexOf(ext) >= 0) return "js";
  if (ext === "py") return "py";
  if (["sh", "bash", "zsh", "fish"].indexOf(ext) >= 0) return "sh";
  if (ext === "go" || ext === "rs") return "js";
  if (ext === "json" || ext === "jsonl") return "json";
  if (ext === "yml" || ext === "yaml" || ext === "toml") return "yaml";
  if (ext === "md" || ext === "txt" || ext === "log") return "text";
  const t = text.trimStart();
  if ((t.startsWith("{") || t.startsWith("[")) && parse(t.trim()) !== null) return "json";
  if (t.startsWith("#!/")) return "sh";
  if (t.startsWith("---\n") || looksYaml(text)) return "yaml";
  return ext ? "js" : "text";
}
export function looksYaml(text: string): boolean {
  let n = 0; let y = 0;
  for (const l of text.split("\n").slice(0, 40)) { if (!l.trim()) continue; n++; if (/^\s*(- )?[\w.\-"']+:( |$)/.test(l) || /^\s*- /.test(l) || /^\s*#/.test(l)) y++; }
  return n >= 3 && y / n >= 0.7;
}
export function segPush(out: Seg[], col: string, t: string): void { if (t) out.push({ s: fg(col), t }); }
export function hlLine(lang: string, line: string, state: number[]): Seg[] {
  const out: Seg[] = [];
  if (lang === "text") { segPush(out, HL.text, line); return out; }
  if (lang === "yaml") return hlYaml(line);
  let rest = line;
  let first = true; // shell: first word of a command is the program
  while (rest.length) {
    if (numAt(state, 0, 0) === 1) { // inside /* … */
      const e = rest.indexOf("*/");
      if (e < 0) { segPush(out, HL.com, rest); return out; }
      segPush(out, HL.com, rest.slice(0, e + 2)); rest = rest.slice(e + 2); state[0] = 0; continue;
    }
    const c = rest.charAt(0);
    if (lang !== "json" && lang !== "sh" && lang !== "py" && rest.startsWith("/*")) { state[0] = 1; continue; }
    if ((lang === "js" && rest.startsWith("//")) || ((lang === "py" || lang === "sh") && c === "#")) { segPush(out, HL.com, rest); return out; }
    if (c === "\"" || c === "'" || c === "`") {
      let j = 1;
      while (j < rest.length && rest.charAt(j) !== c) j += rest.charAt(j) === "\\" ? 2 : 1;
      const lit = rest.slice(0, Math.min(rest.length, j + 1));
      const after = rest.slice(lit.length).trimStart();
      segPush(out, after.startsWith(":") && lang !== "sh" ? HL.key : HL.str, lit);
      rest = rest.slice(lit.length); first = false; continue;
    }
    const ws = /^\s+/.exec(rest);
    if (ws) { const t = ws[0] ?? " "; segPush(out, HL.text, t); rest = rest.slice(t.length); continue; }
    const num = /^-?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?\b/.exec(rest);
    if (num && lang !== "sh") { const t = num[0] ?? ""; segPush(out, HL.num, t); rest = rest.slice(t.length); first = false; continue; }
    if (lang === "sh") {
      const fl = /^--?[A-Za-z][\w-]*/.exec(rest);
      if (fl && !first) { const t = fl[0] ?? ""; segPush(out, HL.flag, t); rest = rest.slice(t.length); continue; }
      const vr = /^\$\{?[A-Za-z_][\w]*\}?/.exec(rest);
      if (vr) { const t = vr[0] ?? ""; segPush(out, HL.key, t); rest = rest.slice(t.length); continue; }
      const op = /^(\|\||&&|;|\||>>|>|<|&)/.exec(rest);
      if (op) { const t = op[0] ?? ""; segPush(out, HL.kw, t); rest = rest.slice(t.length); first = true; continue; }
      const wd = /^[^\s|&;<>"'`$]+/.exec(rest);
      if (wd) { const t = wd[0] ?? ""; segPush(out, first ? HL.fn : KEYWORDS.has(t) ? HL.kw : HL.text, t); rest = rest.slice(t.length); first = false; continue; }
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) {
      const t = id[0] ?? "";
      const nx = rest.slice(t.length);
      const col = lang === "json" ? (t === "true" || t === "false" || t === "null" ? HL.num : HL.text)
        : KEYWORDS.has(t) ? (t === "true" || t === "false" || t === "null" || t === "None" || t === "True" || t === "False" || t === "undefined" ? HL.num : HL.kw)
        : nx.startsWith("(") ? HL.fn : /^[A-Z]/.test(t) ? HL.type : nx.trimStart().startsWith(":") && !nx.trimStart().startsWith("::") ? HL.key : HL.text;
      segPush(out, col, t); rest = nx; first = false; continue;
    }
    segPush(out, HL.punct, c); rest = rest.slice(1);
  }
  return out;
}
function hlYaml(line: string): Seg[] {
  const out: Seg[] = [];
  const m = /^(\s*)(- )?([^:#]+?)(:)(\s|$)(.*)$/.exec(line);
  if (/^\s*#/.test(line)) { segPush(out, HL.com, line); return out; }
  if (!m) {
    const d = /^(\s*)(- )(.*)$/.exec(line);
    if (d) { segPush(out, HL.text, d[1] ?? ""); segPush(out, HL.punct, d[2] ?? ""); yamlValue(out, d[3] ?? ""); return out; }
    segPush(out, line === "---" ? HL.punct : HL.text, line);
    return out;
  }
  segPush(out, HL.text, m[1] ?? ""); segPush(out, HL.punct, m[2] ?? ""); segPush(out, HL.key, m[3] ?? ""); segPush(out, HL.punct, m[4] ?? ""); segPush(out, HL.text, m[5] ?? "");
  yamlValue(out, m[6] ?? "");
  return out;
}
function yamlValue(out: Seg[], v: string): void {
  const h = v.indexOf(" #");
  const val = h >= 0 ? v.slice(0, h) : v;
  const t = val.trim();
  const col = /^-?\d+(\.\d+)?$/.test(t) || /^(true|false|null|yes|no|~)$/i.test(t) ? HL.num : /^[|>][-+]?$/.test(t) || /^[&*!]/.test(t) ? HL.kw : HL.str;
  segPush(out, col, val);
  if (h >= 0) segPush(out, HL.com, v.slice(h));
}
export function highlight(text: string, lang: string): Seg[][] {
  const rows: Seg[][] = [];
  const state: number[] = [0];
  const src = text.split("\n");
  if (src.length > 1 && src[src.length - 1] === "") src.pop();
  for (const l of src.slice(0, 20000)) rows.push(hlLine(lang, clean(l).replace(/\s+$/, ""), state));
  return rows;
}
// wrap styled segments into rows of width w (continuation rows get `cont`, width contW); bg tints the whole row
export function wrapSegs(segs: Seg[], w: number, cont: string, contW: number, bgc: string): string[] {
  const rows: string[] = [];
  const pre = bgc ? bg(bgc) : "";
  let cur = ""; let n = 0; let limit = w;
  const flush = (): void => { rows.push(cur + (bgc ? pre + " ".repeat(Math.max(0, limit - n)) : "") + RST); cur = cont + pre; n = 0; limit = contW; };
  for (const sg of segs) {
    cur += pre + sg.s;
    for (const ch of sg.t) {
      const c = cw(cpOf(ch));
      if (n + c > limit) { flush(); cur += sg.s; }
      cur += ch; n += c;
    }
  }
  rows.push(cur + (bgc ? pre + " ".repeat(Math.max(0, limit - n)) : "") + RST);
  return S.wrapCode ? rows : rows.slice(0, 1).map((r) => r); // cut mode keeps only the first row
}
