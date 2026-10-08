// agentglass-mcp — the 11 read-only tools: schemas (tools/list), input validation and the argv of the one agentglass CLI
// child each call runs. One property table per tool feeds both the JSON Schema and the validator, so they cannot differ.
// Values reach argv only through this mapping: refs and ids by pattern, filters as --flag=value, never a shell.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, str, arr } from "../util/json.ts";
import { annotated, structured } from "./rpc.ts";

// ── server options (the registered command line: the user's explicit consent) ──
export interface Opts { allProjects: boolean; content: boolean; redact: boolean; maxBytes: number; timeoutMs: number; log: boolean }
export function defaultOpts(): Opts { return { allProjects: false, content: false, redact: false, maxBytes: 24000, timeoutMs: 50000, log: false }; }
function intIn(v: string, lo: number, hi: number): number { if (!/^[0-9]{1,7}$/.test(v)) return -1; const n = Number(v); return n >= lo && n <= hi ? n : -1; }
export function parseOpts(argv: string[]): { o: Opts; err: string; version: boolean; help: boolean } {
  const o = defaultOpts(); let version = false; let help = false;
  const args: string[] = [];
  for (const a of argv) { const e = a.indexOf("="); if (a.startsWith("--") && e > 2) { args.push(a.slice(0, e)); args.push(a.slice(e + 1)); } else args.push(a); }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ""; const v = args[i + 1] ?? "";
    if (a === "--all-projects") o.allProjects = true;
    else if (a === "--content") o.content = true;
    else if (a === "--redact") o.redact = true;
    else if (a === "--log") o.log = true;
    else if (a === "--version" || a === "-V") version = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--max-bytes") { const n = intIn(v, 4000, 200000); if (n < 0) return { o, err: "--max-bytes needs a number from 4000 to 200000", version, help }; o.maxBytes = n; i++; }
    else if (a === "--timeout") { const n = intIn(v, 5, 600); if (n < 0) return { o, err: "--timeout needs seconds from 5 to 600", version, help }; o.timeoutMs = n * 1000; i++; }
    else return { o, err: (a.startsWith("-") ? "unknown option " : "unexpected argument ") + a, version, help };
  }
  return { o, err: "", version, help };
}

// ── property tables ──
// kind: str bool int enum fields refs; pat: a pattern name (PATS) for str/refs; lo..hi: int range, or maxLength for str
interface Prop { name: string; kind: string; pat: string; lo: number; hi: number; vals: string[]; def: string; desc: string }
function P(name: string, kind: string, pat: string, lo: number, hi: number, vals: string[], def: string, desc: string): Prop { return { name, kind, pat, lo, hi, vals, def, desc }; }
// the schema's pattern text per name; matches() holds the same patterns as literals (no RegExp table: C backend)
const PATS: Record<string, string | undefined> = {
  ref: "^[\\w:.][\\w:.-]{0,127}$",
  since: "^(today|[0-9]{1,4}[hd]|[0-9]{4}-[0-9]{2}-[0-9]{2})$",
  at: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.Z+-]{5,24}$",
  family: "^[\\w./+:@][\\w ./+:@-]{0,63}$",
  model: "^[\\w./+:@][\\w./+:@-]{0,127}$",
}; // expr (filter expressions): only the validator refuses a leading "-" (keeps tools/list small)
function matches(pat: string, v: string): boolean {
  if (pat === "ref") return /^[\w:.][\w:.-]{0,127}$/.test(v);
  if (pat === "since") return /^(today|[0-9]{1,4}[hd]|[0-9]{4}-[0-9]{2}-[0-9]{2})$/.test(v);
  if (pat === "at") return /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.Z+-]{5,24}$/.test(v); // the CLI parses it
  if (pat === "family") return /^[\w./+:@][\w ./+:@-]{0,63}$/.test(v);
  if (pat === "model") return /^[\w./+:@][\w./+:@-]{0,127}$/.test(v);
  if (pat === "expr") return v.length > 0 && !v.startsWith("-");
  return true;
}
const HARNESSES = ["claude", "codex", "fx", "pi", "opencode", "kiro", "gemini"];
// the CLI's field lists (testdata/mcp/cli-fields.json; tools.check.ts compares them)
const SESSION_FIELDS = ["id", "harness", "title", "cwd", "branch", "remote", "model", "path", "updated", "bytes", "live", "pid", "status", "mux", "parent", "kind", "twins", "activity", "tokens", "costUsd", "costEstimatedUsd", "billing", "unpricedTokens", "unpricedCredits", "linesAdded", "linesRemoved", "attention", "stuck", "skills", "repo", "alerts", "git", "turns", "wallMs", "activeMs", "models", "tools", "errors", "files", "repeats", "subagents", "costBasis", "via"];
const SESSIONS_FIELDS = ["id", "harness", "title", "cwd", "branch", "remote", "model", "path", "updated", "bytes", "live", "pid", "status", "mux", "parent", "kind", "subagents", "twins", "activity", "tokens", "costUsd", "costEstimatedUsd", "billing", "unpricedTokens", "unpricedCredits", "tools", "linesAdded", "linesRemoved", "attention", "stuck", "skills", "repo", "alerts", "git", "project"];
// curated defaults: 20 session rows are ~5 KB instead of ~320 KB with every field (spec, measured)
const SESSION_DEF = ["id", "harness", "title", "cwd", "live", "status", "updated", "costUsd", "costBasis", "tokens", "turns", "wallMs", "activeMs", "models", "tools", "errors", "files", "repeats", "attention", "stuck", "alerts", "via"];
const SESSIONS_DEF = ["id", "harness", "title", "project", "updated", "live", "status", "costUsd", "attention", "stuck"];
const ERRORS_DEF = ["ts", "harness", "session", "tool", "arg", "durationMs"];

const REF = (d: string): Prop => P("ref", "str", "ref", 0, 128, [], "", d);
const SINCE = (def: string): Prop => P("since", "str", "since", 0, 16, [], def, "");
const FILTER = P("filter", "str", "expr", 0, 512, [], "", "e.g. tool is Bash");
const LIMIT = (hi: number, def: number): Prop => P("limit", "int", "", 1, hi, [], String(def), "");
const CURSOR = P("cursor", "str", "", 0, 64, [], "", "");
export interface ToolDef { name: string; title: string; description: string; input: Obj; output: Obj }
interface Spec { name: string; title: string; desc: string; props: Prop[]; out: Obj }

// ── output schemas: permissive (no required, extra keys allowed) so an error result validates too; types only where certain ──
const T = (t: string): Obj => ({ type: t });
const TN = (t: string): Obj => ({ type: [t, "null"] });
const ROWS = (items: Obj): Obj => ({ type: "array", items: { type: "object", properties: items } });
const LIST_ENV = (items: Obj): Obj => ({ type: "object", properties: { rows: ROWS(items), next: TN("string"), truncated: T("boolean"), scope: T("string") } });
const OBJ = (props: Obj): Obj => ({ type: "object", properties: props });

const SPECS: Spec[] = [
  { name: "session", title: "Session",
    desc: "One coding-agent session: cost, tokens, models, tools, errors, files. No ref = the session calling this tool ('what did this cost so far?').",
    props: [REF("current (default), last, parent, id or harness:id"), P("root", "bool", "", 0, 0, [], "", ""), P("fields", "fields", "", 0, 0, SESSION_FIELDS, "", "")],
    out: OBJ({ id: T("string"), harness: T("string"), costUsd: TN("number"), errors: T("array"), via: T("string"), scope: T("string") }) },
  { name: "sessions", title: "Sessions",
    desc: "Coding-agent sessions in this project, newest first: cost, status, attention. Find another agent's session or what ran recently.",
    props: [SINCE("24h"), P("live", "bool", "", 0, 0, [], "", ""), P("harness", "enum", "", 0, 0, HARNESSES, "", ""), FILTER, LIMIT(100, 20), CURSOR, P("fields", "fields", "", 0, 0, SESSIONS_FIELDS, "", "")],
    out: LIST_ENV({ id: T("string"), harness: T("string"), costUsd: TN("number"), status: T("string") }) },
  { name: "errors", title: "Failed tool calls",
    desc: "Failed tool calls of this project's agents, newest first; with ref, that session's. Use when a command keeps failing.",
    props: [REF(""), SINCE("24h"), FILTER, LIMIT(100, 20), CURSOR],
    out: LIST_ENV({ session: T("string"), tool: T("string"), arg: T("string"), durationMs: TN("number") }) },
  { name: "cost", title: "Cost",
    desc: "Agent spend today, 7 days, month and budget; or rows by day, model, harness, project, session. Unpriced stays null.",
    props: [P("since", "str", "since", 0, 16, [], "", ""), P("by", "enum", "", 0, 0, ["day", "model", "harness", "project", "session"], "", ""), FILTER],
    out: OBJ({}) },
  { name: "triage", title: "Triage",
    desc: "Which attributes (tool, model, hour …) stand out in a selection, e.g. failing or slow calls: why errors or costs went up.",
    props: [P("preset", "enum", "", 0, 0, ["errors", "slow", "long", "expensive", "failing", "period"], "", ""), P("select", "str", "expr", 0, 512, [], "", "filter expression"), P("baseline", "enum", "", 0, 0, ["rest", "previous"], "", ""), P("entity", "enum", "", 0, 0, ["call", "session"], "", ""), P("days", "int", "", 1, 90, [], "7", ""), LIMIT(50, 10)],
    out: OBJ({ rows: T("array") }) },
  { name: "compare", title: "Compare",
    desc: "A vs B: two sessions, or two groups as filter expressions (a, b): cost, tokens, tools, errors, time.",
    props: [P("sessions", "refs", "ref", 0, 0, [], "", "two session refs"), P("a", "str", "expr", 0, 512, [], "", "filter expression"), P("b", "str", "expr", 0, 512, [], "", ""), FILTER, P("subagents", "bool", "", 0, 0, [], "true", "")],
    out: OBJ({}) },
  { name: "related", title: "Related events",
    desc: "What all agents in this project did within N minutes of an event (default: this session's latest); conflicting writes flagged.",
    props: [REF(""), P("event", "str", "ref", 0, 128, [], "", "a tool call id"), P("at", "str", "at", 0, 40, [], "", "ISO time"), P("minutes", "int", "", 1, 60, [], "10", ""), LIMIT(200, 50), CURSOR],
    out: OBJ({ events: T("array"), next: TN("string") }) },
  { name: "contention", title: "Contention",
    desc: "Before running tests, builds, type checks, lint or installs: are other agents on this machine already running heavy commands? Returns go=false with what is running.",
    props: [P("kind", "enum", "", 0, 0, ["test", "typecheck", "lint", "build", "install", "ci"], "", ""), P("family", "str", "family", 0, 64, [], "", "e.g. pnpm test"), P("max", "int", "", 1, 32, [], "3", "")],
    out: OBJ({ go: T("boolean"), running: T("array"), advice: T("string") }) },
  { name: "waits", title: "Waits",
    desc: "Where agent time goes: wall time per command family (pnpm test, tsc …), kind or tool; share, p50/p95, failures, trend.",
    props: [SINCE("7d"), P("by", "enum", "", 0, 0, ["family", "kind", "tool"], "", ""), FILTER, LIMIT(50, 15)],
    out: OBJ({ rows: T("array") }) },
  { name: "fleet", title: "Fleet hosts",
    desc: "The agentglass fleet's machines: reachable, last report, errors. configured=false: no fleet set up.",
    props: [],
    out: OBJ({ configured: T("boolean") }) },
  { name: "prices", title: "Unpriced models",
    desc: "Models without a price (why a cost is null); unpriced=false: every model's price source.",
    props: [P("unpriced", "bool", "", 0, 0, [], "true", ""), P("model", "str", "model", 0, 128, [], "", "")],
    out: OBJ({ models: T("array") }) },
];

function propSchema(p: Prop): Obj {
  const o: Obj = {};
  if (p.kind === "str") { o["type"] = "string"; const pt = PATS[p.pat] ?? ""; if (pt) o["pattern"] = pt; if (p.hi > 0 && (!pt || p.pat === "expr")) o["maxLength"] = p.hi; } // the ref/since/at/family/model patterns bound the length
  else if (p.kind === "bool") { o["type"] = "boolean"; if (p.def) o["default"] = p.def === "true"; }
  else if (p.kind === "int") { o["type"] = "integer"; o["minimum"] = p.lo; o["maximum"] = p.hi; if (p.def) o["default"] = Number(p.def); }
  else if (p.kind === "enum") { o["type"] = "string"; o["enum"] = p.vals; }
  else if (p.kind === "fields") { o["type"] = "array"; o["items"] = { type: "string", enum: p.vals }; o["minItems"] = 1; }
  else if (p.kind === "refs") { o["type"] = "array"; o["items"] = { type: "string", pattern: PATS[p.pat] ?? "" }; o["minItems"] = 2; o["maxItems"] = 2; }
  if (p.kind === "str" && p.def) o["default"] = p.def;
  if (p.desc) o["description"] = p.desc;
  return o;
}
function inputSchema(s: Spec): Obj {
  const props: Obj = {};
  for (const p of s.props) props[p.name] = propSchema(p);
  return { type: "object", properties: props, additionalProperties: false };
}
export const TOOLS: ToolDef[] = SPECS.map((s: Spec): ToolDef => ({ name: s.name, title: s.title, description: s.desc, input: inputSchema(s), output: s.out }));
const RO: Obj = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
// annotations from 2025-03-26 (whose Tool has no title of its own: it goes in the annotations there); the tool's title
// and outputSchema from 2025-06-18 (older clients may parse strictly)
export function toolsList(version: string): Obj {
  const out: Obj[] = [];
  for (const t of TOOLS) {
    const o: Obj = { name: t.name };
    if (structured(version)) o["title"] = t.title;
    o["description"] = t.description; o["inputSchema"] = t.input;
    if (structured(version)) o["outputSchema"] = t.output;
    if (structured(version)) o["annotations"] = RO;
    else if (annotated(version)) { const an: Obj = { title: t.title }; for (const k of Object.keys(RO)) an[k] = RO[k]; o["annotations"] = an; }
    out.push(o);
  }
  return { tools: out };
}
// initialize's instructions (≤ 600 characters); scope: "project" | "all projects" — never a project's name (--redact)
export function instructionsFor(scope: string): string {
  return "agentglass reads the coding-agent sessions on this machine (Claude Code, Codex, Gemini CLI, pi, OpenCode, Kiro, fx). " +
    "`session` with no ref is the session calling these tools. You see " + (scope === "project" ? "this project only" : "every project") + " (" + scope + "). " +
    "Call `contention` before a test run, build, type check or install. Results are JSON; lists page with `cursor`.";
}

// ── cursors: opaque base64url("o:<offset>") ──
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function encodeCursor(offset: number): string {
  const s = "o:" + String(offset); let o = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i); const b = i + 1 < s.length ? s.charCodeAt(i + 1) : 0; const c = i + 2 < s.length ? s.charCodeAt(i + 2) : 0;
    const n = (a << 16) | (b << 8) | c;
    o += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    if (i + 1 < s.length) o += B64.charAt((n >> 6) & 63);
    if (i + 2 < s.length) o += B64.charAt(n & 63);
  }
  return o;
}
const MAX_OFFSET = 10000;
// -1 when malformed (or past MAX_OFFSET)
export function decodeCursor(c: string): number {
  if (!c || c.length > 64 || !/^[A-Za-z0-9_-]+$/.test(c) || c.length % 4 === 1) return -1;
  let s = "";
  for (let i = 0; i < c.length; i += 4) {
    const v = [0, 1, 2, 3].map((k: number): number => (i + k < c.length ? B64.indexOf(c.charAt(i + k)) : 0));
    const n = ((v[0] ?? 0) << 18) | ((v[1] ?? 0) << 12) | ((v[2] ?? 0) << 6) | (v[3] ?? 0);
    s += String.fromCharCode((n >> 16) & 255);
    if (i + 2 < c.length) s += String.fromCharCode((n >> 8) & 255);
    if (i + 3 < c.length) s += String.fromCharCode(n & 255);
  }
  const m = /^o:([0-9]{1,6})$/.exec(s);
  if (!m) return -1;
  const n = Number(m[1] ?? "-1");
  return n <= MAX_OFFSET ? n : -1;
}

// ── a call: validated arguments → the child's argv ──
// scoped: the child's answer depends on the project scope (main.ts needs a project cwd for it); model: prices' filter
export interface Call { argv: string[]; tool: string; offset: number; limit: number; err: string; heartbeat: string; scoped: boolean; model: string }
function failed(tool: string, err: string): Call { return { argv: [], tool, offset: 0, limit: 0, err, heartbeat: "", scoped: false, model: "" }; }
// one value against its property: "" = ok, else why not
function check(p: Prop, v: unknown): string {
  const n = p.name;
  if (p.kind === "bool") return typeof v === "boolean" ? "" : n + " must be true or false";
  if (p.kind === "int") {
    if (typeof v !== "number" || !Number.isInteger(v)) return n + " must be an integer";
    return (v as number) >= p.lo && (v as number) <= p.hi ? "" : n + " must be from " + String(p.lo) + " to " + String(p.hi);
  }
  if (p.kind === "enum") return typeof v === "string" && p.vals.indexOf(v as string) >= 0 ? "" : n + " must be one of: " + p.vals.join(", ");
  if (p.kind === "fields" || p.kind === "refs") {
    if (!Array.isArray(v)) return n + " must be an array";
    const a = v as unknown[];
    if (p.kind === "refs" && a.length !== 2) return n + " must name exactly two sessions";
    if (p.kind === "fields" && !a.length) return n + " must not be empty";
    for (const x of a) {
      if (typeof x !== "string") return n + " must hold strings";
      if (p.kind === "fields" && p.vals.indexOf(x as string) < 0) return "unknown field " + (x as string).slice(0, 40) + " (valid: " + p.vals.join(", ") + ")";
      if (p.kind === "refs" && !matches(p.pat, x as string)) return n + ": " + (x as string).slice(0, 40) + " is not a session ref";
    }
    return "";
  }
  if (typeof v !== "string") return n + " must be a string";
  const s = v as string;
  if (p.hi > 0 && s.length > p.hi) return n + " is longer than " + String(p.hi) + " characters";
  if (s.startsWith("-")) return n + " must not start with '-'";
  if (p.pat && !matches(p.pat, s)) return n + ": " + s.slice(0, 40) + " is not valid" + (p.desc ? " (" + p.desc + ")" : "");
  return "";
}
// the arguments of one call, checked against the tool's table; err → no argv
interface Args { a: Obj; err: string }
function args(s: Spec, raw: Obj): Args {
  for (const k of Object.keys(raw)) {
    let known = false; for (const p of s.props) if (p.name === k) known = true;
    if (!known) return { a: raw, err: "unknown argument " + k.slice(0, 40) + (s.props.length ? " (valid: " + s.props.map((p: Prop) => p.name).join(", ") + ")" : " (" + s.name + " takes none)") };
  }
  for (const p of s.props) { const v = raw[p.name]; if (v === undefined || v === null) continue; const e = check(p, v); if (e) return { a: raw, err: e }; }
  return { a: raw, err: "" };
}
const S = (a: Obj, k: string): string => str(a[k]);
const I = (a: Obj, k: string, def: number): number => { const v = a[k]; return typeof v === "number" ? (v as number) : def; };
const Bo = (a: Obj, k: string, def: boolean): boolean => { const v = a[k]; return typeof v === "boolean" ? (v as boolean) : def; };
// name unknown → err "unknown tool" (main.ts answers -32602); any other err is an isError result the model can fix
export function plan(name: string, raw: Obj, o: Opts): Call {
  let sp: Spec | null = null; for (const s of SPECS) if (s.name === name) sp = s;
  if (!sp) return failed(name, "unknown tool");
  const v = args(sp, raw); if (v.err) return failed(name, v.err);
  const a = v.a;
  const c: Call = { argv: [], tool: name, offset: 0, limit: 0, err: "", heartbeat: "", scoped: true, model: "" };
  const fields = (def: string[]): string => { const f = arr(a["fields"]).map((x: unknown) => str(x)); return (f.length ? f : def).join(","); };
  const page = (def: number): string => { // limit + cursor: the child lists offset + limit + 1 rows (one more = there is a next page)
    c.limit = I(a, "limit", def);
    const cu = S(a, "cursor"); if (cu) { const off = decodeCursor(cu); if (off < 0) { c.err = "cursor is not one this server returned"; return ""; } c.offset = off; }
    return String(c.offset + c.limit + 1);
  };
  const filter = (k: string, flag: string): string[] => (S(a, k) ? [flag + "=" + S(a, k)] : []);
  let g: string[] = [];
  if (name === "session") {
    g = ["session", S(a, "ref") || "current"].concat(Bo(a, "root", false) ? ["--root"] : [], ["--format", "json", "--fields", fields(SESSION_DEF)]);
  } else if (name === "sessions") {
    const n = page(20);
    g = ["sessions", "--since", S(a, "since") || "24h"].concat(Bo(a, "live", false) ? ["--live"] : [], S(a, "harness") ? ["--harness", S(a, "harness")] : [], filter("filter", "--filter"), ["--limit", n, "--format", "json", "--fields", fields(SESSIONS_DEF)]);
  } else if (name === "errors") {
    const n = page(20); const ref = S(a, "ref");
    // with a ref: all its history unless since says otherwise (the CLI's rule); without: the last 24 h
    const since = S(a, "since") || (ref ? "" : "24h");
    g = ["errors"].concat(ref ? [ref] : [], since ? ["--since", since] : [], filter("filter", "--filter"), ["--limit", n, "--format", "json", "--fields", (o.content ? ERRORS_DEF.slice(0, 5).concat(["text", "durationMs"]) : ERRORS_DEF).join(",")]);
  } else if (name === "cost") {
    const rows = S(a, "since") !== "" || S(a, "by") !== "" || S(a, "filter") !== "";
    g = rows ? ["cost", "--since", S(a, "since") || "today", "--by", S(a, "by") || "day"].concat(filter("filter", "--filter"), ["--format", "json"]) : ["cost", "--format", "json"];
  } else if (name === "triage") {
    g = ["triage", "--json"].concat(S(a, "preset") ? ["--preset", S(a, "preset")] : [], filter("select", "--select"), S(a, "baseline") ? ["--baseline", S(a, "baseline")] : [],
      S(a, "entity") ? ["--entity", S(a, "entity")] : [], a["days"] !== undefined ? ["--days", String(I(a, "days", 7))] : [], ["--limit", String(I(a, "limit", 10))]);
  } else if (name === "compare") {
    const ss = arr(a["sessions"]).map((x: unknown) => str(x)); const ga = S(a, "a"); const gb = S(a, "b");
    if (ss.length && (ga || gb)) return failed(name, "give sessions or a and b, not both");
    if (!ss.length && (!ga || !gb)) return failed(name, ga || gb ? "a and b go together: give both filter expressions" : "give sessions: [ref, ref], or a and b (filter expressions)");
    g = (ss.length ? ["compare", ss[0] ?? "", ss[1] ?? "", "--json"] : ["compare", "--a=" + ga, "--b=" + gb, "--json"]).concat(filter("filter", "--filter"), Bo(a, "subagents", true) ? [] : ["--no-subagents"]);
  } else if (name === "related") {
    page(50); // events are paged here: the CLI returns them all
    g = ["--json", "--related", S(a, "ref") || "current"].concat(S(a, "event") ? ["--event", S(a, "event")] : [], S(a, "at") ? ["--at", S(a, "at")] : [], ["--minutes", String(I(a, "minutes", 10))]);
  } else if (name === "contention") {
    if (S(a, "kind") && S(a, "family")) return failed(name, "give kind or family, not both");
    c.scoped = false; // machine resources are shared across projects: host-wide, as `wait --now` is
    g = ["wait", "--check", "--json"].concat(S(a, "kind") ? ["--kind", S(a, "kind")] : [], S(a, "family") ? ["--family", S(a, "family")] : [], a["max"] !== undefined ? ["--max", String(I(a, "max", 3))] : []);
  } else if (name === "waits") {
    g = ["wait", "--json", "--since", S(a, "since") || "7d", "--by", S(a, "by") || "family"].concat(filter("filter", "--filter"), ["--limit", String(I(a, "limit", 15))]);
  } else if (name === "fleet") {
    c.scoped = false; g = ["fleet", "status", "--json"]; // never --refresh: no SSH from a tool call
  } else { // prices
    c.scoped = false; c.model = S(a, "model");
    g = ["prices", "--json"].concat(Bo(a, "unpriced", true) ? ["--unpriced"] : []);
  }
  if (c.err) return failed(name, c.err);
  if (c.scoped && o.allProjects) g.push("--all-projects");
  if (o.redact) g.push("--redact");
  c.argv = g;
  c.heartbeat = "agentglass " + (name === "contention" ? "wait --check" : name === "fleet" ? "fleet status" : name === "related" ? "--related" : (g[0] ?? ""));
  return c;
}
export function toolNames(): string[] { return SPECS.map((s: Spec) => s.name); }
// for doctor and tests: the input property names of a tool
export function inputProps(name: string): string[] { for (const s of SPECS) if (s.name === name) return s.props.map((p: Prop) => p.name); return []; }
