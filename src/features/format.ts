// agentglass — one formatter for every CLI list: rows of plain objects → json | jsonl | csv | table, with --fields selection
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { type Obj, obj } from "../util/json.ts";
import { width, cw, cpOf, clean } from "../util/text.ts";
import { agentHost, cliError } from "./agentenv.ts";
import { link, hyperOn, sessUrl } from "../util/hyper.ts";
import { argVal } from "../util/argv.ts";

export const FORMATS = ["json", "jsonl", "csv", "table"];

// nested objects joined with "_" (tokens.in → tokens_in), arrays → ";"-joined scalars (objects inside as compact JSON), null stays null
export function flatten(o: Obj): Obj {
  const out: Obj = {};
  const walk = (pre: string, v: Obj): void => {
    for (const k of Object.keys(v)) {
      const x = v[k]; const n = pre ? pre + "_" + k : k;
      if (x === undefined) continue;
      const ox = x !== null && !Array.isArray(x) ? obj(x) : null;
      if (ox) walk(n, ox);
      else if (Array.isArray(x)) out[n] = (x as unknown[]).map((e: unknown): string => typeof e === "string" ? e : JSON.stringify(e)).join(";");
      else out[n] = x;
    }
  };
  walk("", o);
  return out;
}
// every flattened name → its real value: nested objects under their own name too (git_who), lists as lists (git_commits)
function named(o: Obj): Obj {
  const out: Obj = {};
  const walk = (pre: string, v: Obj): void => {
    for (const k of Object.keys(v)) {
      const x = v[k]; const n = pre ? pre + "_" + k : k;
      if (x === undefined) continue;
      out[n] = x;
      const ox = x !== null && !Array.isArray(x) ? obj(x) : null;
      if (ox) walk(n, ox);
    }
  };
  walk("", o);
  return out;
}
// the keys of rows in first-seen order: "top" as is, "flat" the flattened leaves, "named" every flattened name
function keysOf(rows: Obj[], how: string): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const r of rows) for (const k of Object.keys(how === "flat" ? flatten(r) : how === "named" ? named(r) : r)) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}
// fields empty → defaults (empty defaults → every flattened key, first-seen order); valid = top-level + flattened names (+ known,
// the command's declared fields, so an empty result still rejects a typo)
export function pickCols(rows: Obj[], fields: string[], defaults: string[], known: string[]): { cols: string[]; bad: string[]; valid: string[] } {
  const valid = keysOf(rows, "top");
  for (const k of keysOf(rows, "named").concat(known)) if (valid.indexOf(k) < 0) valid.push(k);
  if (!fields.length) return { cols: defaults.length ? defaults : keysOf(rows, "flat"), bad: [], valid };
  const bad: string[] = [];
  for (const f of fields) if (valid.indexOf(f) < 0) bad.push(f);
  return { cols: fields, bad, valid };
}
// a row cut to cols: every name keeps its real value, a flattened one too (git_commits stays a list: --json is typed;
// csv/table flatten the cut row afterwards)
function project(r: Obj, cols: string[]): Obj {
  if (!cols.length) return r;
  const out: Obj = {}; let all: Obj | null = null;
  for (const c of cols) {
    const v = r[c];
    if (v !== undefined) { out[c] = v; continue; }
    if (!all) all = named(r);
    const fv = all[c];
    out[c] = fv === undefined ? null : fv;
  }
  return out;
}
// csv/table columns: a top-level object name stands for its flattened children
function expand(rows: Obj[], cols: string[]): string[] {
  const all = keysOf(rows, "flat");
  if (!cols.length) return all;
  const out: string[] = [];
  for (const c of cols) {
    const kids = all.filter((k: string) => k.startsWith(c + "_"));
    if (all.indexOf(c) < 0 && kids.length) { for (const k of kids) out.push(k); } else out.push(c);
  }
  return out;
}

// RFC 4180 cell; text starting with = + - @ gets a leading ' so spreadsheets do not run it (numbers are not guarded)
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? "\"" + s.split("\"").join("\"\"") + "\"" : s;
}
function numText(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.abs(n) >= 1 ? Math.round(n * 100) / 100 : Math.round(n * 10000) / 10000);
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function two(n: number): string { return (n < 10 ? "0" : "") + String(n); }
// an ISO time as local "MM-DD HH:MM": the table is for a person, and the full stamp would be cut first
function localTime(s: string): string { const d = new Date(s); return d.getTime() > 0 ? two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes()) : s; }
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return numText(v as number);
  if (typeof v === "string") return ISO.test(v as string) ? localTime(v as string) : clean(v as string);
  return clean(typeof v === "boolean" ? String(v) : JSON.stringify(v));
}
// cut to w columns with … (no padding)
function cut(s: string, w: number): string {
  if (width(s) <= w) return s;
  let out = ""; let n = 0;
  for (const ch of s) { const c = cw(cpOf(ch)); if (n + c > w - 1) break; out += ch; n += c; }
  return out + "…";
}
function pad(s: string, w: number, right: boolean): string { const f = " ".repeat(Math.max(0, w - width(s))); return right ? f + s : s + f; }
const B = "\x1b[1m"; const R = "\x1b[0m";
function table(rows: Obj[], cols: string[], tty: boolean, cols0: number): string {
  const flat = rows.map((r: Obj) => flatten(r));
  const num = cols.map((c: string) => flat.every((r: Obj) => r[c] === null || r[c] === undefined || typeof r[c] === "number"));
  // one decimal count per number column, so the points line up: whole numbers as is, else 2 (4 when every value is below 1)
  const dec = cols.map((c: string, i: number): number => {
    if (!num[i]) return -1;
    let frac = false; let big = 0;
    for (const r of flat) { const v = r[c]; if (typeof v === "number") { if (!Number.isInteger(v)) frac = true; big = Math.max(big, Math.abs(v as number)); } }
    return !frac ? -1 : big < 1 ? 4 : 2;
  });
  const cells = flat.map((r: Obj) => cols.map((c: string, i: number) => { const v = r[c]; const d = dec[i] ?? -1; return d >= 0 && typeof v === "number" ? (v as number).toFixed(d) : cellText(v); }));
  const w: number[] = [];
  for (let i = 0; i < cols.length; i++) { let m = width(cols[i] ?? ""); for (const r of cells) m = Math.max(m, width(i < r.length ? r[i] : "")); w.push(m); }
  // too wide: the text columns share the room (one common cap, at least 4 each; short ones stay whole); gaps of 2, or 1
  // when even the 4-column floors do not fit
  const fixed = (): number => { let t = 0; for (let i = 0; i < w.length; i++) if (num[i]) t += w[i] ?? 0; return t; };
  const floors = (): number => { let t = 0; for (let i = 0; i < w.length; i++) if (!num[i]) t += Math.min(4, w[i] ?? 0); return t; };
  const gaps = Math.max(0, w.length - 1);
  const gap = fixed() + floors() + 2 * gaps <= cols0 ? 2 : 1;
  const room = cols0 - fixed() - gap * gaps;
  const sumAt = (cap: number): number => { let t = 0; for (let i = 0; i < w.length; i++) if (!num[i]) t += Math.min(cap, w[i] ?? 0); return t; };
  let cap = 0; for (let i = 0; i < w.length; i++) if (!num[i]) cap = Math.max(cap, w[i] ?? 0);
  while (cap > 4 && sumAt(cap) > room) cap--;
  for (let i = 0; i < w.length; i++) if (!num[i]) w[i] = Math.min(cap, w[i] ?? 0);
  // a terminal with OSC 8: the id column links to the session (agentglass open takes it); the padding stays outside
  const idc = tty && hyperOn() ? cols.indexOf("id") : -1;
  const urls = flat.map((r: Obj): string => { const h = r["harness"]; const id = r["id"]; return idc >= 0 && typeof h === "string" && typeof id === "string" ? sessUrl(h as string, id as string) : ""; });
  const line = (r: string[], url: string): string => r.map((v: string, i: number) => { const c = cut(v, w[i] ?? 0); if (i !== idc || !url) return pad(c, w[i] ?? 0, num[i] ?? false); const f = " ".repeat(Math.max(0, (w[i] ?? 0) - width(c))); return num[i] ? f + link(url, c) : link(url, c) + f; }).join(" ".repeat(gap)).replace(/\s+$/, "");
  const hd = line(cols, "");
  const body: string[] = []; for (let k = 0; k < cells.length; k++) body.push(line(cells[k], urls[k] ?? ""));
  return [tty ? B + hd + R : hd].concat(body).join("\n");
}
// one object: key/value lines, values cut to the width
function kv(row: Obj, cols: string[], tty: boolean, cols0: number): string {
  const f = flatten(row);
  let kw = 0; for (const c of cols) kw = Math.max(kw, width(c));
  return cols.map((c: string) => (tty ? B + pad(c, kw, false) + R : pad(c, kw, false)) + "  " + cut(cellText(f[c]), Math.max(8, cols0 - kw - 2))).join("\n").replace(/[ \t]+$/gm, "");
}
// one object as JSON, stringified inside a one-element array: scriptc rejects stringify of a lone Obj from an array read
function js(o: Obj[], pretty: boolean): string {
  if (!pretty) return JSON.stringify(o).slice(1, -1);
  const ls = JSON.stringify(o, null, 2).split("\n");
  return ls.slice(1, ls.length - 1).map((l: string) => l.slice(2)).join("\n");
}
// rows → text (no trailing newline); cols [] = whole rows (json/jsonl) or every flattened key (csv/table)
export function render(rows: Obj[], cols: string[], fmt: string, single: boolean, pretty: boolean, tty: boolean, cols0: number): string {
  const p: Obj[] = []; for (const r of rows) p.push(project(r, cols));
  const ls: string[] = [];
  if (fmt === "jsonl") { for (let i = 0; i < p.length; i++) ls.push(js(p.slice(i, i + 1), false)); return ls.join("\n"); }
  if (fmt === "csv") {
    const cs = expand(p, cols);
    ls.push(cs.map((c: string) => csvCell(c)).join(","));
    for (const r of p) { const f = flatten(r); ls.push(cs.map((c: string) => csvCell(f[c])).join(",")); }
    return ls.join("\n");
  }
  if (fmt === "table") { const cs = expand(p, cols); return single ? (p.length ? kv(p[0], cs, tty, cols0) : "") : table(p, cs, tty, cols0); }
  if (single) return p.length ? js(p.slice(0, 1), pretty) : "null";
  return pretty ? JSON.stringify(p, null, 2) : JSON.stringify(p);
}
// --json → json; inside an agent → json; a terminal → table; a pipe → json
export function defaultFormat(agent: boolean, stdoutTty: boolean, legacyJson: boolean): string {
  if (legacyJson || agent) return "json";
  return stdoutTty ? "table" : "json";
}
// $COLUMNS (shells do not export it), else the terminal's width from "stty size" output ("rows cols"), else 120
export function colsOf(env: string, stty: string): number {
  const c = Number(env); if (c > 20) return c;
  const m = /^\d+ (\d+)$/.exec(stty.trim()); const w = m ? Number(m[1] ?? "") : 0;
  return w > 20 ? w : 120;
}
// stty only for a person at a terminal (tables elsewhere use $COLUMNS or 120)
export function termCols(tty: boolean): number {
  const env = process.env.COLUMNS ?? "";
  if (Number(env) > 20 || !tty) return colsOf(env, "");
  const r = spawnSync("sh", ["-c", "stty size < /dev/tty"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return colsOf(env, r.status === 0 ? String(r.stdout) : "");
}

// --format F / --fields a,b,c of one command line (fmt "" = the default for where the output goes)
export interface Fmt { fmt: string; fields: string[] }
export function fmtArgs(args: string[]): Fmt {
  const f: Fmt = { fmt: "", fields: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--format") { f.fmt = argVal(args, i) ?? ""; i++; if (FORMATS.indexOf(f.fmt) < 0) cliError("usage", "--format must be one of " + FORMATS.join(", "), "", 2); }
    else if (a === "--fields") { f.fields = (argVal(args, i) ?? "").split(",").map((x: string) => x.trim()).filter((x: string) => x !== ""); i++; if (!f.fields.length) cliError("usage", "--fields needs a comma-separated list of field names", "", 2); }
  }
  return f;
}
// rows → the text for stdout: format default, --fields check (unknown → exit 2 listing the valid names), styling only for a person at a terminal
export function formatRows(rows: Obj[], f: Fmt, single: boolean, tableCols: string[], known: string[], legacyJson: boolean): string {
  const agent = agentHost().on; const tty = process.stdout.isTTY === true;
  const fmt = f.fmt || defaultFormat(agent, tty, legacyJson);
  let cols: string[] = fmt === "table" ? tableCols : [];
  if (f.fields.length) {
    const pc = pickCols(rows, f.fields, tableCols, known);
    if (pc.bad.length) cliError("usage", "unknown field" + (pc.bad.length > 1 ? "s " : " ") + pc.bad.join(", "), "valid: " + pc.valid.join(", "), 2);
    cols = pc.cols;
  }
  const human = tty && !agent;
  return render(rows, cols, fmt, single, fmt === "json" && human, human && process.env.NO_COLOR === undefined, termCols(tty));
}
