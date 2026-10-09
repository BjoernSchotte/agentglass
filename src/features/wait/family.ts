// agentglass — agent-wait: a stored shell command line → its command family ("pnpm test", "tsc", "gh run watch") and kind
// SPDX-License-Identifier: Apache-2.0
// Pure word rules (spec agent-wait §1), no regular expressions on user input: wrappers (sudo, timeout 600, rtk proxy,
// flock <file>) and env assignments are skipped, trivial steps (cd, export, echo) never name a family, filters (cat, grep,
// jq) only when nothing else ran, package-manager scripts and runners (npx, uv run, python -m) name what they run. User
// rules from config.json "wait.families" (word patterns) go first. A row's family comes from its command ids, memoised per
// id: worked out as indexing books each command (calls.ts CMDS), or at read time for rows read back from disk (each
// distinct command text is normalised once per run; the config is read once). A command cut at 200 characters may
// carry a family hint (famHint).
import { obj, str, arr } from "../../util/json.ts";
import { rawSection } from "../../util/config.ts";
import { say } from "../../state.ts";
import { REDACT } from "../redact-on.ts";
import { DICT, nameOf } from "../usage/facts.ts";
import { type Rows, KIND_CMD, KIND_HINT } from "../usage/rows.ts";
import { mcpServer, CMDS } from "../usage/calls.ts";

export interface Fam { name: string; kind: string; heavy: boolean; generic: boolean }
export const SHELL_KINDS = ["test", "typecheck", "lint", "build", "install", "ci", "wait", "vcs", "net", "other"];
export const TOOL_KINDS = ["user", "wait", "agent", "web", "mcp", "file", "other"];
// every kind once (filter enum): shell kinds, then the tool kinds not already there
export const ALL_KINDS: string[] = SHELL_KINDS.concat(TOOL_KINDS.filter((k: string) => SHELL_KINDS.indexOf(k) < 0));
export const DEF_HEAVY = ["test", "typecheck", "lint", "build", "install"];
// the built-in rules' version: stored day sums (digest.ts) count as missing under another. Bump it with every change of
// families.golden; family.check.ts holds the table to GOLDEN_SIG (a hash of its text) so a change cannot slip by
export const FAM_RULES = 1;
export const GOLDEN_SIG = "1:2682726982";
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
export function setWaitCfgForTest(c: WaitCfg | null): void { cfg = c; memo = new Float64Array(0); TXT.m = new Map<number, number>(); }

// ── tokens ──
// a line → segments (split on && || ; | & outside quotes) of words (quotes removed); heredoc bodies dropped (norm() has
// joined the lines: "<<WORD" up to a later " WORD" token, or the end)
function isSp(c: number): boolean { return c === 32 || c === 9; }
// one segment at a time (pick stops at the first that runs a program): its words from i0 on into ws; returns the index
// past it (ws stays empty only at the end of the line). keep false: a segment pick skips, its words stay "" (no slicing).
// An index rather than a cursor object: the object form hung pick under scriptc 0.1.7.
function nextSeg(line: string, i0: number, ws: string[], keep: boolean): number {
  // no closures over w / inW: captured variables cost a heap cell per access (this loop runs per character)
  const L = line.length; let i = i0; let w = ""; let inW = false;
  while (i < L) {
    const c = line.charCodeAt(i);
    if (c === 39) { inW = true; const e = line.indexOf("'", i + 1); if (e < 0) { if (keep) w += line.slice(i + 1); i = L; } else { if (keep) w += line.slice(i + 1, e); i = e + 1; } continue; } // '…' literal
    if (c === 34) { // "…" with \" escapes
      inW = true; let j = i + 1; let s0 = j;
      while (j < L) { const d = line.charCodeAt(j); if (d === 34) break; if (d === 92 && j + 1 < L) { if (keep) w += line.slice(s0, j) + line.charAt(j + 1); j += 2; s0 = j; continue; } j++; }
      if (keep) w += line.slice(s0, j); i = j < L ? j + 1 : L; continue;
    }
    if (c === 92 && i + 1 < L) { if (keep) w += line.charAt(i + 1); inW = true; i += 2; continue; }
    if (c === 32 || c === 9) { if (inW) { ws.push(w); w = ""; inW = false; } i++; continue; }
    if (c === 60 && line.charCodeAt(i + 1) === 60 && line.charCodeAt(i + 2) !== 60) { if (inW) { ws.push(w); w = ""; inW = false; } i = heredoc(line, i + 2); continue; } // <<WORD … WORD
    if (c === 60 && line.charCodeAt(i + 1) === 60) { if (keep) w += "<<<"; inW = true; i += 3; continue; } // <<< here-string: a redirect word
    let sep = 0; // a separator's length: ; ;; | || |& && and a lone & (2>&1, &>, >&2 belong to a redirect: plain)
    if (c === 59 || c === 124) sep = line.charCodeAt(i + 1) === c || (c === 124 && line.charCodeAt(i + 1) === 38) ? 2 : 1;
    else if (c === 38) {
      const p = i > 0 ? line.charCodeAt(i - 1) : 0; const n = line.charCodeAt(i + 1);
      sep = n === 38 ? 2 : p === 62 || p === 60 || n === 62 ? 0 : 1;
    }
    if (sep) { if (inW) { ws.push(w); w = ""; inW = false; } i += sep; if (ws.length) return i; continue; }
    // a plain run: this character and the next up to a quote, escape, blank, < ; | or &
    const s = i; i++;
    while (i < L) { const d = line.charCodeAt(i); if (d === 39 || d === 34 || d === 92 || d === 32 || d === 9 || d === 60 || d === 59 || d === 124 || d === 38) break; i++; }
    if (keep) w += line.slice(s, i);
    inW = true;
  }
  if (inW) ws.push(w);
  return L;
}
export function segments(line: string): string[][] {
  const out: string[][] = []; let i = 0;
  while (i < line.length) { const ws: string[] = []; i = nextSeg(line, i, ws, true); if (ws.length) out.push(ws); }
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
    let a = 0; while (a < w.length && (w.charCodeAt(a) === 40 || w.charCodeAt(a) === 123)) a++; // ( {
    let b = w.length; while (b > a && (w.charCodeAt(b - 1) === 41 || w.charCodeAt(b - 1) === 125)) b--; // ) }
    if (a > 0 || b < w.length) w = w.slice(a, b);
    if (w) o.push(w);
  }
  return o;
}

// ── word rules ──
const WRAP = new Set<string>(["sudo", "env", "timeout", "nice", "ionice", "nohup", "time", "command", "exec", "caffeinate", "stdbuf", "rtk", "flock", "xargs"]);
// wrapper options that take a separate value (numeric values are skipped anyway)
const WOPT: Record<string, string[]> = { sudo: ["-u", "-g", "-C", "-D"], env: ["-u", "-C", "-S"], timeout: ["-s", "-k", "--signal", "--kill-after"], ionice: ["-c", "-n", "-p"], nice: ["-n"],
  stdbuf: ["-i", "-o", "-e"], time: ["-f", "-o"], flock: ["-w", "-E", "--timeout", "--conflict-exit-code"], xargs: ["-I", "-n", "-P", "-L", "-d", "-a", "-E", "-s", "--max-args", "--max-procs", "--replace", "--delimiter"] };
const RTK_SUB = new Set<string>(["proxy", "err", "summary", "test"]); // rtk subcommands that wrap a command
const KEYW = new Set<string>(["do", "then", "else", "elif", "while", "until", "if", "!", "time"]); // a command follows
const TRIV = new Set<string>(["cd", "pushd", "popd", "export", "source", ".", "set", "unset", "ulimit", "true", "false", "echo", "printf", "test", "[", "[[", "mkdir", "local", "read", "trap", "break", "continue",
  "for", "while", "until", "if", "then", "else", "elif", "do", "done", "fi", "case", "esac", "select", "function", "return", "exit", "shift", "declare", "typeset", "alias", ":",
  "shopt", "setopt", "emulate", "builtin", "hash", "umask", "jobs", "disown", "{", "}", "(", ")"]);
const FILTER = new Set<string>(["cat", "grep", "rg", "sed", "head", "tail", "awk", "jq", "wc", "sort", "uniq", "tee", "less", "cut", "tr", "column"]);
const PM = new Set<string>(["npm", "pnpm", "yarn", "bun", "turbo", "nx"]);
const PM_OPT = ["-C", "--dir", "--filter", "-F", "--prefix", "--cwd", "--workspace", "--config"];
const RUNNERS = new Set<string>(["npx", "pnpx", "bunx", "uvx"]);
const RUN_OPT = ["-p", "--package", "--from", "--with", "--python"];
const SUBCMD = new Set<string>(["poetry", "pipenv", "cargo", "go", "make", "just", "git", "docker", "kubectl", "mvn", "mvnw", "gradle", "gradlew", "dotnet", "terraform", "composer", "mix", "flutter", "deno", "scriptc", "tmux", "herdr", "agentglass",
  "uv", "pip", "pip3", "bundle", "rake", "helm", "brew", "apt", "apt-get", "dnf", "yum", "next", "vite", "podman", "systemctl"]);
const SUB_OPT: Record<string, string[]> = { git: ["-C", "-c", "--git-dir", "--work-tree"], make: ["-C", "-f", "-I", "-l", "--directory", "--file"], docker: ["-H", "--context", "--host", "-c", "--log-level"],
  kubectl: ["-n", "--namespace", "--context", "--kubeconfig"], gh: ["-R", "--repo"], just: ["-f", "--justfile", "-d", "--working-directory"], mvn: ["-f", "-pl", "-P", "-s"], gradle: ["-p"], gradlew: ["-p"],
  tmux: ["-L", "-S", "-f"], uv: ["--directory", "--project"], cargo: ["-C", "--config"], brew: [], pip: ["-r"] };
const SHELLS = new Set<string>(["sh", "bash", "zsh", "dash", "fish"]);
const INTERP = new Set<string>(["node", "tsx", "ts-node", "python", "python3", "ruby", "perl", "php", "sh", "bash", "zsh", "dash"]);
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
    if (KEYW.has(w) || (w.startsWith("-") && w.length > 1)) { i++; continue; } // a stray option is no program
    const b = base(w);
    if (WRAP.has(b)) {
      i = skipOpts(ws, i + 1, WOPT[b] ?? []);
      while (i < ws.length && isNum(ws[i] ?? "")) i++; // timeout 600, nice 10
      if (b === "env") while (i < ws.length && isAssign(ws[i] ?? "")) i++;
      if (b === "rtk" && i + 1 < ws.length && RTK_SUB.has(ws[i] ?? "")) i++;
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
  const raw = ws[i] ?? ""; const at = raw.lastIndexOf("@");
  if (raw === "trap") { // trap <action> <signals>: words past the signals are the next command (a script's lines joined)
    let k = i + 2; while (k < ws.length && /^(SIG)?[A-Z0-9]+$/.test(ws[k] ?? "")) k++;
    if (k < ws.length) { const rest = ws.slice(k); return famAt(rest, progAt(rest), depth); }
    return NONE;
  }
  if (at > 0 && raw.indexOf("/", at) < 0) return fn(cut(raw.startsWith("@") ? raw.slice(0, at) : base(raw.slice(0, at)))); // npx pkg@version, @scope/pkg@latest
  if (raw.startsWith("@") && raw.indexOf("/") > 0) return fn(cut(raw)); // a scoped package
  const p = base(raw); if (!p || TRIV.has(p)) return NONE;
  if (PM.has(p)) {
    const j = skipOpts(ws, i + 1, PM_OPT); const a0 = ws[j] ?? "";
    if (!a0) return fn(p === "yarn" ? "yarn install" : p);
    if (a0 === "run" || a0 === "run-script") { const k = skipOpts(ws, j + 1, PM_OPT); const s = ws[k] ?? ""; return fn(s && isWord(s) ? p + " run " + s : p + " run"); }
    if (a0 === "test" || a0 === "t" || a0 === "tst") return fn(p + " test");
    if (a0 === "workspace" && p === "yarn" && j + 2 < ws.length) return famAt([p].concat(ws.slice(j + 2)), 0, depth); // yarn workspace <name> <script>
    if (a0 === "exec" || a0 === "dlx" || a0 === "x") { const k = skipOpts(ws, j + 1, RUN_OPT); return k < ws.length ? famAt(ws, k, depth) : fn(p + " " + a0); }
    if (a0 === "i" || a0 === "ci" || a0 === "add" || a0 === "install") return fn(p + " install");
    return fn(isWord(a0) ? p + " " + a0 : p);
  }
  if (RUNNERS.has(p)) { const k = skipOpts(ws, i + 1, RUN_OPT); return k < ws.length ? famAt(ws, k, depth) : fn(p); }
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
  if (SUBCMD.has(p)) {
    const j = skipOpts(ws, i + 1, SUB_OPT[p] ?? []); const a = ws[j] ?? "";
    if (!a || !isWord(a)) return fn(p);
    if (p === "go" && a === "tool") { const t = ws[skipOpts(ws, j + 1, [])] ?? ""; return fn(t && isWord(base(t)) ? cut("go tool " + base(t)) : "go tool"); }
    return fn(cut(p + " " + a));
  }
  if (INTERP.has(p) || p.startsWith("python3.")) {
    let j = i + 1;
    while (j < ws.length) {
      const w = ws[j] ?? "";
      if (w === "-") return fn(p);
      if (!w.startsWith("-") || w === "--") break;
      const sh = SHELLS.has(p);
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
// does the segment at i start with a plain trivial word (cd, export, echo …: famAt names no family whatever follows)?
// Only a bare word ended by a blank, ; | or the line's end; keywords and trap go the full way. Most stored lines start
// with "cd <dir> &&": that segment is skipped without building its words.
const TRIV_MAX = ((): number => { let m = 0; for (const w of TRIV) m = Math.max(m, w.length); return m; })();
function trivAt(line: string, i: number): boolean {
  const L = line.length; while (i < L && isSp(line.charCodeAt(i))) i++;
  const s = i;
  while (i < L && i - s <= TRIV_MAX) { const c = line.charCodeAt(i); if (isSp(c) || c === 59 || c === 124) break; if (c === 39 || c === 34 || c === 92 || c === 38 || c === 60 || c === 62 || c === 40 || c === 41 || c === 123 || c === 125 || c === 36 || c === 96) return false; i++; } // ' " \ & < > ( ) { } $ `
  if (i === s || i - s > TRIV_MAX) return false;
  const w = line.slice(s, i);
  return TRIV.has(w) && !KEYW.has(w) && w !== "trap";
}
// the chosen segment of a line: the first that runs a non-filter program, else the first filter; null = only trivial steps.
// s, e: where it is in the line
interface Pick { ws: string[]; i: number; f: FN; s: number; e: number }
function pick(line: string, depth: number): Pick | null {
  let first: Pick | null = null;
  let at = 0;
  while (at < line.length) {
    const seg: string[] = []; const tr = trivAt(line, at); const s = at; at = nextSeg(line, at, seg, !tr); if (!seg.length) break;
    if (tr) continue;
    const ws = bare(seg); const i = progAt(ws); const f = famAt(ws, i, depth);
    if (!f.name) continue;
    if (FILTER.has(f.name)) { if (!first) first = { ws, i, f, s, e: at }; continue; }
    return { ws, i, f, s, e: at };
  }
  return first;
}
function famLine(line: string, depth: number): FN { const p = pick(line, depth); return p ? p.f : fn("sh"); }

// The family hint of a shell command line longer than the stored 200 characters (calls.ts norm): the segment its family
// comes from, taken from the whole line (≤ 200 characters; ":" = only trivial steps), or "" when the stored text names
// the same segment and family. record.ts keeps it beside the cut text (rows.ts KIND_HINT), so a chain whose heavy step lies
// past the cut (cd … && export … && pnpm test) keeps its family. A segment alone gives the line's family: the pick is per
// segment and user rules see only its words. Decided by the built-in rules (user rules may change after indexing).
export function famHint(full: string): string {
  if (full.length <= 200) return "";
  const pf = pick(full, 0); const pc = pick(full.slice(0, 200), 0);
  if (!pf) return pc ? ":" : "";
  if (pc && pc.s === pf.s && pc.f.name === pf.f.name) return "";
  const t = full.slice(pf.s, pf.e).trim();
  return t.length > 200 ? t.slice(0, 200) : t;
}

// a stored line cut at 200 characters (no hint: written before hints existed): could the cut have changed its family?
// Not when it comes from a program other than a filter in a segment wholly inside the cut, or one the cut ends in a
// heredoc body of (its words lie before), nor when the segment runs into the cut but its family stays the same without
// its last word (the one the cut may have split), with another one there, and with more words after it: the words that
// decide lie before the cut (famHint would add no hint either)
const OTHER = "zz";
export function cutMayHide(cut: string): boolean {
  const p = pick(cut, 0); if (!p || FILTER.has(p.f.name)) return true;
  if (p.e < cut.length || inHeredoc(cut, p.s)) return false;
  const ws = p.ws; const n = p.f.name; if (ws.length - 1 <= p.i) return true; // the program word itself may be cut
  const head = ws.slice(0, ws.length - 1);
  return famAt(head, p.i, 0).name !== n || famAt(head.concat([OTHER]), p.i, 0).name !== n || famAt(ws.concat([OTHER, OTHER]), p.i, 0).name !== n;
}
// does the line end inside a heredoc body opened at or after i (outside quotes)?
function inHeredoc(line: string, i: number): boolean {
  const L = line.length;
  while (i < L) {
    const c = line.charCodeAt(i);
    if (c === 39 || c === 34) { const e = line.indexOf(line.charAt(i), i + 1); if (e < 0) return false; i = e + 1; continue; }
    if (c === 92) { i += 2; continue; }
    if (c === 60 && line.charCodeAt(i + 1) === 60 && line.charCodeAt(i + 2) !== 60) { const e = heredoc(line, i + 2); if (e >= L) return true; i = e; continue; }
    i++;
  }
  return false;
}

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
const KMEMO = new Map<string, string>(); // family name → built-in kind (families repeat across many command lines)
export function kindOfName(name: string): string {
  const hit = KMEMO.get(name); if (hit !== undefined) return hit;
  const k = kindOf0(name); if (KMEMO.size > 50000) KMEMO.clear();
  KMEMO.set(name, k); return k;
}
function kindOf0(name: string): string {
  const toks = name.split(" ");
  const ps: string[] = []; for (const t of toks) for (const x of parts(t)) ps.push(x);
  if (ps.indexOf("mcp") >= 0) return "other"; // an MCP server (playwright-mcp) is never a check, whatever its name says
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
  if (t.startsWith("mcp__") || mcpServer(tool) !== "") return "mcp"; // Gemini: mcp_<server>_<tool>
  if (T_FILE.indexOf(t) >= 0) return "file";
  return "other";
}
export function toolFamily(tool: string): string { const s = mcpServer(tool); return s ? "mcp " + s : tool; }

// ── memo over call rows ──
// family dictionary: one id per (name, kind, heavy, generic); names may repeat across kinds only through user rules
const FAMS = { ids: new Map<string, number>(), names: [] as string[], kinds: [] as string[], heavy: [] as boolean[], generic: [] as boolean[] };
export const FAM_STATS = { norm: 0 };
let memo = new Float64Array(0); // DICT.cmd id → family id + 1 (0 = not computed)
function famIdOf(f: Fam): number { return famIdFor(f.name, f.kind, f.heavy, f.generic); }
export function famIdFor(name: string, kind: string, heavy: boolean, generic: boolean): number {
  const k = name + "\t" + kind + "\t" + (heavy ? "1" : "0") + (generic ? "1" : "0");
  const hit = FAMS.ids.get(k); if (hit !== undefined) return hit;
  FAMS.names.push(name); FAMS.kinds.push(kind); FAMS.heavy.push(heavy); FAMS.generic.push(generic);
  const id = FAMS.names.length - 1; FAMS.ids.set(k, id); return id;
}
// a command text's family id without interning the text (a scanned calls file, report.ts): memo by two 32-bit FNV-1a
// hashes of the text in one 53-bit key, for one report (releaseTexts); a shared key across texts is ~1e-5 likely at 1M texts
const TXT = { m: new Map<number, number>() };
function fnv(s: string, h0: number): number { let h = h0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
export function textFam(text: string): number {
  if (!text) return -1;
  const k = fnv(text, 2166136261) * 2097152 + (fnv(text, 3735928559) >>> 11);
  const hit = TXT.m.get(k); if (hit !== undefined) return hit;
  FAM_STATS.norm++;
  const id = famIdOf(familyOf(text, waitCfg())); TXT.m.set(k, id); return id;
}
export function releaseTexts(): void { TXT.m = new Map<number, number>(); }
// of two family ids (-1 none), the one a call with both commands counts as (rowFam): heavy first, then the kinds' order
export function betterFam(best: number, id: number): number {
  if (id < 0) return best; if (best < 0) return id;
  const c = waitCfg();
  return prio({ name: "", kind: famKind(id), heavy: famHeavy(id), generic: false }, c) < prio({ name: "", kind: famKind(best), heavy: famHeavy(best), generic: false }, c) ? id : best;
}
export function cmdFam(cmdId: number): number {
  if (cmdId < 0) return -1;
  if (cmdId >= memo.length) { const b = new Float64Array(Math.max(1024, (cmdId + 1) * 2)); b.set(memo); memo = b; }
  const v = memo[cmdId] + 0; if (v > 0) return v - 1;
  FAM_STATS.norm++;
  const id = famIdOf(familyOf(nameOf(DICT.cmd, cmdId), waitCfg()));
  memo[cmdId] = id + 1; return id;
}
// is the family of this command id worked out already (no normalisation on the next rowFam)?
export function famKnown(cmdId: number): boolean { return cmdId < 0 || (cmdId < memo.length && memo[cmdId] > 0); }
// family id of row i of r; -1 = the row has no shell command (a non-shell tool: toolFamily / toolKind of its tool)
// (a command followed by its hint counts by the hint: famHint)
export function rowFam(r: Rows, i: number): number {
  if (i < 0 || i >= r.n) return -1;
  const e = i + 1 < r.n ? r.lo[i + 1] + 0 : r.nl;
  let best = -1;
  for (let k = r.lo[i] + 0; k < e; k++) {
    const v = r.li[k] + 0; if (v % 4 !== KIND_CMD) continue;
    const h = k + 1 < e ? r.li[k + 1] + 0 : -1;
    best = betterFam(best, cmdFam(h >= 0 && h % 4 === KIND_HINT ? (h - KIND_HINT) / 4 : (v - KIND_CMD) / 4));
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
// indexing books commands through these (calls.ts CMDS): the hint beside a cut line, the family of each stored text
CMDS.hint = famHint;
CMDS.booked = (id: number): void => { cmdFam(id); };
CMDS.mayHide = cutMayHide;
