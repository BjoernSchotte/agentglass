// agentglass — agent-wait: a stored shell command line → its command family ("pnpm test", "tsc", "gh run watch") and kind
// SPDX-License-Identifier: Apache-2.0
// Pure word rules (spec agent-wait §1), no regular expressions on user input: wrappers (sudo, timeout 600, rtk proxy,
// flock <file>) and env assignments are skipped, trivial steps (cd, export, echo) never name a family, filters (cat, grep,
// jq) only when nothing else ran, package-manager scripts and runners (npx, uv run, python -m) name what they run. User
// rules from config.json "wait.families" (word patterns) go first. Families are computed at read time from the call rows'
// command ids and memoised per id (each distinct command text is normalised once per run; the config is read once).
import { obj, str, arr } from "../../util/json.ts";
import { rawSection } from "../../util/config.ts";
import { say } from "../../state.ts";
import { REDACT } from "../redact-on.ts";
import { DICT, nameOf } from "../usage/facts.ts";
import { type Rows, KIND_CMD } from "../usage/rows.ts";
import { mcpServer } from "../usage/calls.ts";

export interface Fam { name: string; kind: string; heavy: boolean; generic: boolean }
export const SHELL_KINDS = ["test", "typecheck", "lint", "build", "install", "ci", "wait", "vcs", "net", "other"];
export const TOOL_KINDS = ["user", "wait", "agent", "web", "mcp", "file", "other"];
// every kind once (filter enum): shell kinds, then the tool kinds not already there
export const ALL_KINDS: string[] = SHELL_KINDS.concat(TOOL_KINDS.filter((k: string) => SHELL_KINDS.indexOf(k) < 0));
export const DEF_HEAVY = ["test", "typecheck", "lint", "build", "install"];
// one user rule: pattern words ("*" one word, captured as $1…; a trailing "..." the rest; "*" inside a word a glob)
export interface FamRule { words: string[]; rest: boolean; family: string; kind: string; heavy: number /* -1 unset, 0, 1 */ }
export interface WaitCfg { rules: FamRule[]; heavyKinds: string[]; minSec: number; diags: string[] }

// ── config ──
export function parseWaitCfg(v: unknown): WaitCfg {
  const c: WaitCfg = { rules: [], heavyKinds: DEF_HEAVY.slice(), minSec: 10, diags: [] };
  if (v === undefined || v === null) return c;
  const o = obj(v); if (!o) { c.diags.push("wait: not an object — ignored"); return c; }
  const fs = o["families"];
  if (fs !== undefined && !Array.isArray(fs)) c.diags.push("wait.families: not a list — ignored");
  let k = 0;
  for (const e of arr(fs)) {
    const at = "wait.families[" + String(k) + "]"; k++;
    const r = obj(e); if (!r) { c.diags.push(at + ": not an object — ignored"); continue; }
    const m = str(r["match"]).trim();
    if (!m) { c.diags.push(at + ": \"match\" missing or empty — ignored"); continue; }
    const fam = r["family"]; const kd = r["kind"]; const hv = r["heavy"];
    if (fam !== undefined && (typeof fam !== "string" || !(fam as string).trim())) { c.diags.push(at + ": \"family\" must be a non-empty string — ignored"); continue; }
    if (kd !== undefined && (typeof kd !== "string" || SHELL_KINDS.indexOf(kd as string) < 0)) { c.diags.push(at + ": kind " + JSON.stringify(kd) + " unknown (" + SHELL_KINDS.join(" ") + ") — ignored"); continue; }
    if (hv !== undefined && typeof hv !== "boolean") { c.diags.push(at + ": \"heavy\" must be true or false — ignored"); continue; }
    const ws = m.split(" ").filter((x: string) => x.length > 0); let rest = false;
    if (ws.length && ws[ws.length - 1] === "...") { ws.pop(); rest = true; }
    if (!ws.length && !rest) { c.diags.push(at + ": \"match\" has no words — ignored"); continue; }
    c.rules.push({ words: ws, rest, family: fam === undefined ? "" : (fam as string).trim(), kind: kd === undefined ? "" : (kd as string), heavy: hv === undefined ? -1 : hv === true ? 1 : 0 });
  }
  const hk = o["heavyKinds"];
  if (hk !== undefined) {
    const xs: string[] = []; let ok = Array.isArray(hk);
    for (const x of arr(hk)) { const s = str(x); if (SHELL_KINDS.indexOf(s) < 0 || xs.indexOf(s) >= 0) ok = false; else xs.push(s); }
    if (ok) c.heavyKinds = xs; else c.diags.push("wait.heavyKinds: want a list of kinds (" + SHELL_KINDS.join(" ") + ") — default " + DEF_HEAVY.join(" "));
  }
  const ms = o["minSec"];
  if (ms !== undefined) { if (typeof ms === "number" && (ms as number) >= 0) c.minSec = ms as number; else c.diags.push("wait.minSec: want a number of seconds ≥ 0 — default 10"); }
  return c;
}
let cfg: WaitCfg | null = null;
export function waitCfg(): WaitCfg {
  const c = cfg; if (c) return c;
  const n = parseWaitCfg(rawSection("wait")); cfg = n;
  if (n.diags.length) say("warn", "config " + n.diags.join("; "));
  return n;
}
// checks: a fixed config (null: read config.json again); the memo depends on it
export function setWaitCfgForTest(c: WaitCfg | null): void { cfg = c; memo = new Float64Array(0); }

// ── tokens ──
// a line → segments (split on && || ; | & outside quotes) of words (quotes removed); heredoc bodies dropped (norm() has
// joined the lines: "<<WORD" up to a later " WORD" token, or the end)
function isSp(c: number): boolean { return c === 32 || c === 9; }
export function segments(line: string): string[][] {
  const out: string[][] = []; let ws: string[] = []; let w = ""; let inW = false; let q = 0;
  const L = line.length; let i = 0;
  const endWord = (): void => { if (inW) ws.push(w); w = ""; inW = false; };
  const endSeg = (): void => { endWord(); if (ws.length) out.push(ws); ws = []; };
  while (i < L) {
    const c = line.charCodeAt(i);
    if (q) { // inside quotes: '…' literal, "…" with \" escapes
      if (c === q) { q = 0; i++; continue; }
      if (q === 34 && c === 92 && i + 1 < L) { w += line.charAt(i + 1); i += 2; continue; }
      w += line.charAt(i); i++; continue;
    }
    if (c === 39 || c === 34) { q = c; inW = true; i++; continue; }
    if (c === 92 && i + 1 < L) { w += line.charAt(i + 1); inW = true; i += 2; continue; }
    if (isSp(c)) { endWord(); i++; continue; }
    if (c === 60 && line.charCodeAt(i + 1) === 60 && line.charCodeAt(i + 2) !== 60) { i = heredoc(line, i + 2); endWord(); continue; } // <<WORD … WORD
    if (c === 60 && line.charCodeAt(i + 1) === 60) { w += "<<<"; inW = true; i += 3; continue; } // <<< here-string: a redirect word
    if (c === 59 || c === 124) { endSeg(); i += line.charCodeAt(i + 1) === c || (c === 124 && line.charCodeAt(i + 1) === 38) ? 2 : 1; continue; } // ; ;; | || |&
    if (c === 38) { // && and a lone & separate; 2>&1, &>, >&2 belong to a redirect
      const p = i > 0 ? line.charCodeAt(i - 1) : 0; const n = line.charCodeAt(i + 1);
      if (n === 38) { endSeg(); i += 2; continue; }
      if (p === 62 || p === 60 || n === 62) { w += "&"; inW = true; i++; continue; }
      endSeg(); i++; continue;
    }
    w += line.charAt(i); inW = true; i++;
  }
  endSeg();
  return out;
}
// after "<<": skip "-", blanks and the delimiter word (quoted or not); then past its closing " WORD" token, or to the end
function heredoc(line: string, i: number): number {
  const L = line.length;
  if (line.charCodeAt(i) === 45) i++;
  while (i < L && isSp(line.charCodeAt(i))) i++;
  let d = ""; const qc = line.charCodeAt(i);
  if (qc === 39 || qc === 34) { const e = line.indexOf(line.charAt(i), i + 1); d = e > i ? line.slice(i + 1, e) : ""; i = e > i ? e + 1 : L; }
  else { const s = i; while (i < L && !isSp(line.charCodeAt(i)) && ";&|<>)".indexOf(line.charAt(i)) < 0) i++; d = line.slice(s, i); }
  if (!d) return i;
  let from = i;
  for (;;) {
    const k = line.indexOf(" " + d, from); if (k < 0) return L;
    const e = k + 1 + d.length; const n = e < L ? line.charAt(e) : "";
    if (e >= L || n === " " || n === ";" || n === "&" || n === "|" || n === ")") return e;
    from = k + 1;
  }
}
// redirect words go (with their target when it is a word of its own); (, {, ), } around words go
function isRedir(w: string): boolean {
  let i = 0; while (i < w.length && w.charCodeAt(i) >= 48 && w.charCodeAt(i) <= 57) i++;
  const c = w.charCodeAt(i); if (c === 38 && (w.charCodeAt(i + 1) === 62)) return true; // &> &>>
  return i < w.length && (c === 62 || c === 60);
}
function bare(ws: string[]): string[] {
  const o: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    let w = ws[i] ?? "";
    if (isRedir(w)) { if (w.endsWith(">") || w.endsWith("<")) i++; continue; } // "> file": its target goes too; 2>&1, >/dev/null are whole
    let a = 0; while (a < w.length && (w.charAt(a) === "(" || w.charAt(a) === "{")) a++;
    let b = w.length; while (b > a && (w.charAt(b - 1) === ")" || w.charAt(b - 1) === "}")) b--;
    if (a > 0 || b < w.length) w = w.slice(a, b);
    if (w) o.push(w);
  }
  return o;
}

// ── word rules ──
const WRAP = ["sudo", "env", "timeout", "nice", "ionice", "nohup", "time", "command", "exec", "caffeinate", "stdbuf", "rtk", "flock", "xargs"];
// wrapper options that take a separate value (numeric values are skipped anyway)
const WOPT: Record<string, string[]> = { sudo: ["-u", "-g", "-C", "-D"], env: ["-u", "-C", "-S"], timeout: ["-s", "-k", "--signal", "--kill-after"], ionice: ["-c", "-n", "-p"], nice: ["-n"],
  stdbuf: ["-i", "-o", "-e"], time: ["-f", "-o"], flock: ["-w", "-E", "--timeout", "--conflict-exit-code"], xargs: ["-I", "-n", "-P", "-L", "-d", "-a", "-E", "-s", "--max-args", "--max-procs", "--replace", "--delimiter"] };
const RTK_SUB = ["proxy", "err", "summary", "test"]; // rtk subcommands that wrap a command
const KEYW = ["do", "then", "else", "elif", "while", "until", "if", "!", "time"]; // a command follows
const TRIV = ["cd", "pushd", "popd", "export", "source", ".", "set", "unset", "ulimit", "true", "false", "echo", "printf", "test", "[", "[[", "mkdir", "local", "read", "trap", "break", "continue",
  "for", "while", "until", "if", "then", "else", "elif", "do", "done", "fi", "case", "esac", "select", "function", "return", "exit", "shift", "declare", "typeset", "alias", ":"];
const FILTER = ["cat", "grep", "rg", "sed", "head", "tail", "awk", "jq", "wc", "sort", "uniq", "tee", "less", "cut", "tr", "column"];
const PM = ["npm", "pnpm", "yarn", "bun", "turbo", "nx"];
const PM_OPT = ["-C", "--dir", "--filter", "-F", "--prefix", "--cwd", "--workspace", "--config"];
const RUNNERS = ["npx", "pnpx", "bunx", "uvx"];
const RUN_OPT = ["-p", "--package", "--from", "--with", "--python"];
const SUBCMD = ["poetry", "pipenv", "cargo", "go", "make", "just", "git", "docker", "kubectl", "mvn", "mvnw", "gradle", "gradlew", "dotnet", "terraform", "composer", "mix", "flutter", "deno", "scriptc", "tmux", "herdr", "agentglass",
  "uv", "pip", "pip3", "bundle", "rake", "helm", "brew", "apt", "apt-get", "dnf", "yum", "next", "vite", "podman", "systemctl"];
const SUB_OPT: Record<string, string[]> = { git: ["-C", "-c", "--git-dir", "--work-tree"], make: ["-C", "-f", "-I", "-l", "--directory", "--file"], docker: ["-H", "--context", "--host", "-c", "--log-level"],
  kubectl: ["-n", "--namespace", "--context", "--kubeconfig"], gh: ["-R", "--repo"], just: ["-f", "--justfile", "-d", "--working-directory"], mvn: ["-f", "-pl", "-P", "-s"], gradle: ["-p"], gradlew: ["-p"],
  tmux: ["-L", "-S", "-f"], uv: ["--directory", "--project"], cargo: ["-C", "--config"], brew: [], pip: ["-r"] };
const SHELLS = ["sh", "bash", "zsh", "dash", "fish"];
const INTERP = ["node", "tsx", "ts-node", "python", "python3", "ruby", "perl", "php", "sh", "bash", "zsh", "dash"];
const INT_OPT = ["-r", "--require", "--import", "--loader", "-W", "-X", "-I", "--experimental-loader"];

function base(p: string): string { const i = p.lastIndexOf("/"); return i >= 0 && i < p.length - 1 ? p.slice(i + 1) : p; }
function isNum(w: string): boolean { if (!w) return false; let d = 0; for (let i = 0; i < w.length; i++) { const c = w.charCodeAt(i); if (c >= 48 && c <= 57) d++; else if (c !== 46 && !(i === w.length - 1 && "smhd".indexOf(w.charAt(i)) >= 0)) return false; } return d > 0; }
function isAssign(w: string): boolean { const e = w.indexOf("="); if (e <= 0) return false; for (let i = 0; i < e; i++) { const c = w.charCodeAt(i); if (!(c === 95 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (i > 0 && c >= 48 && c <= 57))) return false; } return true; }
// a subcommand word: letters first, no path, no glob
function isWord(w: string): boolean { const c = w.charCodeAt(0); if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false; for (let i = 1; i < w.length; i++) { const x = w.charCodeAt(i); if (!((x >= 48 && x <= 57) || (x >= 65 && x <= 90) || (x >= 97 && x <= 122) || x === 45 || x === 95 || x === 58 || x === 46 || x === 43)) return false; } return true; }
// index of the first word after options (and their values: opts, numbers) from i; ws.length when none
function skipOpts(ws: string[], i: number, opts: string[]): number {
  while (i < ws.length) {
    const w = ws[i] ?? "";
    if (w === "--") return i + 1;
    if (!w.startsWith("-") && !w.startsWith("+")) return i;
    i++;
    if (w.indexOf("=") < 0 && opts.indexOf(w) >= 0 && i < ws.length) i++;
    else if (i < ws.length && isNum(ws[i] ?? "")) i++;
  }
  return i;
}
// the program's index after env assignments, keywords and wrappers (with their options); -1 = the segment runs nothing
// (for x in …, case …)
function progAt(ws: string[]): number {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i] ?? "";
    if (isAssign(w)) { i++; continue; }
    if (w === "for" || w === "case" || w === "select" || w === "function") return -1;
    if (KEYW.indexOf(w) >= 0) { i++; continue; }
    const b = base(w);
    if (WRAP.indexOf(b) >= 0) {
      i = skipOpts(ws, i + 1, WOPT[b] ?? []);
      while (i < ws.length && isNum(ws[i] ?? "")) i++; // timeout 600, nice 10
      if (b === "env") while (i < ws.length && isAssign(ws[i] ?? "")) i++;
      if (b === "rtk" && i + 1 < ws.length && RTK_SUB.indexOf(ws[i] ?? "") >= 0) i++;
      if (b === "flock" && i < ws.length) i = skipOpts(ws, i + 1, []); // the lock file, then the command
      continue;
    }
    return i;
  }
  return ws.length;
}
interface FN { name: string; generic: boolean }
const NONE: FN = { name: "", generic: false };
function fn(name: string): FN { return { name, generic: false }; }
function cut(s: string): string { return s.length > 40 ? s.slice(0, 40) : s; }
// a segment's family from its program at i; "" = trivial (names no family)
function famAt(ws: string[], i: number, depth: number): FN {
  if (i < 0 || i >= ws.length) return NONE;
  const p = base(ws[i] ?? ""); if (!p || TRIV.indexOf(p) >= 0) return NONE;
  if (PM.indexOf(p) >= 0) {
    const j = skipOpts(ws, i + 1, PM_OPT); const a0 = ws[j] ?? "";
    if (!a0) return fn(p === "yarn" ? "yarn install" : p);
    if (a0 === "run" || a0 === "run-script") { const k = skipOpts(ws, j + 1, PM_OPT); const s = ws[k] ?? ""; return fn(s && isWord(s) ? p + " run " + s : p + " run"); }
    if (a0 === "test" || a0 === "t" || a0 === "tst") return fn(p + " test");
    if (a0 === "workspace" && p === "yarn" && j + 2 < ws.length) return famAt([p].concat(ws.slice(j + 2)), 0, depth); // yarn workspace <name> <script>
    if (a0 === "exec" || a0 === "dlx" || a0 === "x") { const k = skipOpts(ws, j + 1, RUN_OPT); return k < ws.length ? famAt(ws, k, depth) : fn(p + " " + a0); }
    if (a0 === "i" || a0 === "ci" || a0 === "add" || a0 === "install") return fn(p + " install");
    return fn(isWord(a0) ? p + " " + a0 : p);
  }
  if (RUNNERS.indexOf(p) >= 0) { const k = skipOpts(ws, i + 1, RUN_OPT); return k < ws.length ? famAt(ws, k, depth) : fn(p); }
  if ((p === "poetry" || p === "pipenv" || p === "uv" || p === "bundle") && ws[skipOpts(ws, i + 1, SUB_OPT[p] ?? [])] === (p === "bundle" ? "exec" : "run")) {
    const k = skipOpts(ws, skipOpts(ws, i + 1, SUB_OPT[p] ?? []) + 1, RUN_OPT.concat(["--group", "--extra", "--env-file", "--directory", "--project"]));
    return k < ws.length ? famAt(ws, k, depth) : fn(p + " run");
  }
  if ((p === "python" || p === "python3" || p.startsWith("python3.")) && ws[i + 1] === "-m" && i + 2 < ws.length) return famAt(ws, i + 2, depth);
  if (p === "gh") {
    const j = skipOpts(ws, i + 1, SUB_OPT["gh"] ?? []); const a = ws[j] ?? ""; if (!a || !isWord(a)) return fn("gh");
    const k = skipOpts(ws, j + 1, []); const b = ws[k] ?? "";
    return fn(b && isWord(b) ? "gh " + a + " " + b : "gh " + a);
  }
  if (SUBCMD.indexOf(p) >= 0) {
    const j = skipOpts(ws, i + 1, SUB_OPT[p] ?? []); const a = ws[j] ?? "";
    if (!a || !isWord(a)) return fn(p);
    if (p === "go" && a === "tool") { const t = ws[skipOpts(ws, j + 1, [])] ?? ""; return fn(t && isWord(base(t)) ? cut("go tool " + base(t)) : "go tool"); }
    return fn(cut(p + " " + a));
  }
  if (INTERP.indexOf(p) >= 0 || p.startsWith("python3.")) {
    let j = i + 1;
    while (j < ws.length) {
      const w = ws[j] ?? "";
      if (w === "-") return fn(p);
      if (!w.startsWith("-") || w === "--") break;
      const sh = SHELLS.indexOf(p) >= 0;
      if (sh && !w.startsWith("--") && w.endsWith("c")) { // sh -c / bash -lc "<cmd>": the family of that command
        if (depth < 3 && j + 1 < ws.length) { const f = famLine(ws[j + 1] ?? "", depth + 1); if (f.name && f.name !== "sh") return f; }
        return fn(p);
      }
      if (w === "-c" || w === "-e" || w === "-p" || w === "--eval" || w === "--print") return fn(p);
      j++; if (INT_OPT.indexOf(w) >= 0) j++;
    }
    if (j < ws.length && ws[j] === "--") j++;
    const s = ws[j] ?? "";
    return s ? { name: cut(p + " " + base(s)), generic: true } : fn(p);
  }
  return fn(cut(p));
}
// the chosen segment of a line: the first that runs a non-filter program, else the first filter; null = only trivial steps
interface Pick { ws: string[]; i: number; f: FN }
function pick(line: string, depth: number): Pick | null {
  let first: Pick | null = null;
  for (const seg of segments(line)) {
    const ws = bare(seg); const i = progAt(ws); const f = famAt(ws, i, depth);
    if (!f.name) continue;
    if (FILTER.indexOf(f.name) >= 0) { if (!first) first = { ws, i, f }; continue; }
    return { ws, i, f };
  }
  return first;
}
function famLine(line: string, depth: number): FN { const p = pick(line, depth); return p ? p.f : fn("sh"); }

// ── kinds ──
// [kind, words]: a word matches a family token exactly or one part of it (split at : . / _ -); "a b" words match the
// name's leading tokens
const KINDS: [string, string[]][] = [
  ["test", ["test", "tests", "vitest", "jest", "mocha", "pytest", "playwright", "cypress", "rspec", "check.sh", "e2e", "nextest", "cargo test", "go test", "mix test"]],
  ["typecheck", ["tsc", "typecheck", "type-check", "check-types", "mypy", "pyright", "vue-tsc", "svelte-check", "cargo check"]],
  ["lint", ["lint", "eslint", "biome", "ruff", "clippy", "prettier", "shellcheck", "golangci-lint", "stylelint", "fmt", "format", "vet"]],
  ["build", ["build", "compile", "make", "scriptc", "webpack", "vite build", "esbuild", "rollup", "next build", "tsup", "cargo build", "go build", "docker build"]],
  ["install", ["install", "pip", "pip3", "uv sync", "go mod", "bundle install"]],
  ["ci", ["gh run", "gh pr checks", "gh workflow", "act"]],
  ["wait", ["sleep", "wait"]],
  ["vcs", ["git"]],
  ["net", ["ssh", "scp", "rsync", "curl", "wget"]],
];
function parts(t: string): string[] {
  const o: string[] = []; let s = 0;
  for (let i = 0; i <= t.length; i++) { const c = i < t.length ? t.charAt(i) : ":"; if (c === ":" || c === "." || c === "/" || c === "_" || c === "-") { if (i > s) o.push(t.slice(s, i)); s = i + 1; } }
  return o;
}
export function kindOfName(name: string): string {
  const toks = name.split(" ");
  const ps: string[] = []; for (const t of toks) for (const x of parts(t)) ps.push(x);
  for (const [k, ws] of KINDS) for (const w of ws) {
    if (w.indexOf(" ") >= 0) { if (name === w || name.startsWith(w + " ")) return k; continue; }
    if (k === "vcs" || k === "net" || k === "wait") { if (toks[0] === w) return k; continue; } // the program itself (not "agentglass wait")
    if (toks.indexOf(w) >= 0) return k;
    if (w.indexOf("-") < 0 && w.indexOf(".") < 0 && ps.indexOf(w) >= 0) return k;
  }
  return "other";
}

// ── user rules ──
function glob(p: string, s: string): boolean { return globAt(p, 0, s, 0); }
function globAt(p: string, i: number, s: string, j: number): boolean {
  while (i < p.length) {
    if (p.charAt(i) === "*") { for (let k = j; k <= s.length; k++) if (globAt(p, i + 1, s, k)) return true; return false; }
    if (j >= s.length || p.charAt(i) !== s.charAt(j)) return false;
    i++; j++;
  }
  return j === s.length;
}
// the rule's captures ($1… = the words a lone * matched), null = no match
function ruleMatch(r: FamRule, ws: string[]): string[] | null {
  if (r.rest ? ws.length < r.words.length : ws.length !== r.words.length) return null;
  const caps: string[] = [];
  for (let k = 0; k < r.words.length; k++) {
    const p = r.words[k] ?? ""; const w = ws[k] ?? "";
    if (p === "*") { caps.push(w); continue; }
    if (p.indexOf("*") >= 0 ? !glob(p, w) : p !== w) return null;
  }
  return caps;
}
function fill(t: string, caps: string[]): string {
  let o = "";
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i + 1);
    if (t.charAt(i) === "$" && c >= 49 && c <= 57) { o += caps[c - 49] ?? ""; i++; continue; }
    o += t.charAt(i);
  }
  return o;
}

// ── families ──
export function familyOf(cmd: string, c: WaitCfg): Fam {
  const p = pick(cmd, 0);
  if (!p) return { name: "sh", kind: "other", heavy: c.heavyKinds.indexOf("other") >= 0, generic: false };
  let name = p.f.name; let generic = p.f.generic; let kind = kindOfName(name); let heavy = -1;
  if (c.rules.length) {
    const ws = p.ws.slice(p.i);
    for (const r of c.rules) {
      const caps = ruleMatch(r, ws); if (!caps) continue;
      if (r.family) { name = cut(fill(r.family, caps).trim() || name); generic = false; }
      if (r.kind) kind = r.kind;
      heavy = r.heavy;
      break;
    }
  }
  return { name, kind, heavy: heavy >= 0 ? heavy === 1 : c.heavyKinds.indexOf(kind) >= 0, generic };
}
// kind priority for a call with several commands: heavy ones first (heavyKinds order), then the shell kinds' order
function prio(f: Fam, c: WaitCfg): number {
  const h = c.heavyKinds.indexOf(f.kind);
  if (f.heavy) return h >= 0 ? h : c.heavyKinds.length;
  return 100 + SHELL_KINDS.indexOf(f.kind);
}
export function callFamily(cmds: string[], c: WaitCfg): Fam {
  let best: Fam | null = null;
  for (const x of cmds) { const f = familyOf(x, c); if (!best || prio(f, c) < prio(best, c)) best = f; }
  return best ?? { name: "sh", kind: "other", heavy: false, generic: false };
}

// ── non-shell tools ──
function low(t: string): string { return t.toLowerCase(); }
const T_USER = ["askuserquestion", "ask_user", "askuser"];
const T_WAIT = ["taskoutput", "bashoutput", "monitor", "wait", "write_stdin", "killshell"];
const T_AGENT = ["agent", "task", "sendmessage", "spawn_agent", "send_input", "wait_agent"];
const T_WEB = ["webfetch", "websearch", "google_web_search"];
const T_FILE = ["read", "edit", "write", "grep", "glob", "ls", "notebookedit", "multiedit", "apply_patch", "read_file", "write_file", "replace", "list_directory", "read_many_files", "search_file_content", "patch"];
export function toolKind(tool: string): string {
  const t = low(tool);
  if (T_USER.indexOf(t) >= 0 || t.startsWith("request_user_input")) return "user";
  if (T_WAIT.indexOf(t) >= 0) return "wait";
  if (T_AGENT.indexOf(t) >= 0) return "agent";
  if (T_WEB.indexOf(t) >= 0 || t.startsWith("web_")) return "web";
  if (t.startsWith("mcp__")) return "mcp";
  if (T_FILE.indexOf(t) >= 0) return "file";
  return "other";
}
export function toolFamily(tool: string): string { const s = mcpServer(tool); return s ? "mcp " + s : tool; }

// ── memo over call rows ──
// family dictionary: one id per (name, kind, heavy, generic); names may repeat across kinds only through user rules
const FAMS = { ids: new Map<string, number>(), names: [] as string[], kinds: [] as string[], heavy: [] as boolean[], generic: [] as boolean[] };
export const FAM_STATS = { norm: 0 };
let memo = new Float64Array(0); // DICT.cmd id → family id + 1 (0 = not computed)
function famIdOf(f: Fam): number {
  const k = f.name + "\t" + f.kind + "\t" + (f.heavy ? "1" : "0") + (f.generic ? "1" : "0");
  const hit = FAMS.ids.get(k); if (hit !== undefined) return hit;
  FAMS.names.push(f.name); FAMS.kinds.push(f.kind); FAMS.heavy.push(f.heavy); FAMS.generic.push(f.generic);
  const id = FAMS.names.length - 1; FAMS.ids.set(k, id); return id;
}
export function cmdFam(cmdId: number): number {
  if (cmdId < 0) return -1;
  if (cmdId >= memo.length) { const b = new Float64Array(Math.max(1024, (cmdId + 1) * 2)); b.set(memo); memo = b; }
  const v = memo[cmdId] + 0; if (v > 0) return v - 1;
  FAM_STATS.norm++;
  const id = famIdOf(familyOf(nameOf(DICT.cmd, cmdId), waitCfg()));
  memo[cmdId] = id + 1; return id;
}
// family id of row i of r; -1 = the row has no shell command (a non-shell tool: toolFamily / toolKind of its tool)
export function rowFam(r: Rows, i: number): number {
  if (i < 0 || i >= r.n) return -1;
  const e = i + 1 < r.n ? r.lo[i + 1] + 0 : r.nl; const c = waitCfg();
  let best = -1; let bp = 0;
  for (let k = r.lo[i] + 0; k < e; k++) {
    const v = r.li[k] + 0; if (v % 4 !== KIND_CMD) continue;
    const id = cmdFam((v - KIND_CMD) / 4); if (id < 0) continue;
    const p = prio({ name: "", kind: famKind(id), heavy: famHeavy(id), generic: false }, c);
    if (best < 0 || p < bp) { best = id; bp = p; }
  }
  return best;
}
function at<T>(a: T[], i: number, d: T): T { return i >= 0 && i < a.length ? a[i] ?? d : d; }
export function famName(id: number): string { return at(FAMS.names, id, ""); }
export function famKind(id: number): string { return at(FAMS.kinds, id, "other"); }
export function famHeavy(id: number): boolean { return at(FAMS.heavy, id, false); }
export function famGeneric(id: number): boolean { return at(FAMS.generic, id, false); }
export function famId(name: string): number { for (let i = 0; i < FAMS.names.length; i++) if (FAMS.names[i] === name) return i; return -1; }
// --redact (spec §1.11): an interpreter + script family shows as its program only
export function shownFam(name: string, generic: boolean): string { if (!generic || !REDACT) return name; const i = name.indexOf(" "); return i > 0 ? name.slice(0, i) : name; }
export function famLabel(id: number): string { return shownFam(famName(id), famGeneric(id)); }
// a row's family and kind as text (non-shell rows: the tool's)
export function rowFamName(r: Rows, i: number): string { const f = rowFam(r, i); return f >= 0 ? famName(f) : toolFamily(nameOf(DICT.tool, r.tool[i] + 0)); }
export function rowKind(r: Rows, i: number): string { const f = rowFam(r, i); return f >= 0 ? famKind(f) : toolKind(nameOf(DICT.tool, r.tool[i] + 0)); }
