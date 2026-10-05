// agentglass — privacy mode (--redact): deterministic fake identities, synthetic event content, width-preserving screen scrubber
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { HOME, readText, listDir, run } from "../util/fs.ts";
import { OS } from "../platform/index.ts";
import { HARNESSES } from "../harness/index.ts";
import { base } from "../util/json.ts";
import type { Ev, Sess } from "../model/types.ts";
import { H, type RealMeta } from "../hooks.ts";
import { isErr } from "./callgraph/model.ts";
import { C, CSI, RST, fg, bg } from "../ui/theme.ts";
import { REDACT, PINNED } from "./redact-on.ts";
import { attrOf } from "./query/attrs.ts";
import { ESC_RE, firstLine } from "../util/text.ts";

export { REDACT };
const envKeep = process.env.AGENTGLASS_REDACT_KEEP;
const KEEP = (envKeep !== undefined ? envKeep : "").split(",").map((x) => x.trim()).filter((x) => x.length > 0);

// ── pools ───────────────────────────────────────────────────────────────────
const TITLES = [
  "Add rate limiting to the API", "Fix flaky checkout test", "Migrate auth to OAuth device flow", "Speed up the search index rebuild",
  "Refactor the billing webhooks", "Add dark mode to settings", "Fix N+1 queries on the orders page", "Upgrade to Node 24",
  "Add retries to the email worker", "Write docs for the public API", "Debug memory leak in the image resizer", "Add pagination to the users endpoint",
  "Split the monolith config", "Fix timezone bug in reports", "Add CSV export to analytics", "Harden the file upload handler",
  "Cache feature flags at the edge", "Add OpenTelemetry tracing", "Fix race in the job scheduler", "Replace moment with date-fns",
  "Improve error messages in the CLI", "Add e2e tests for signup", "Migrate CI to GitHub Actions", "Clean up unused dependencies",
  "Add webhook signature checks", "Fix broken links in the docs site", "Add i18n to the onboarding flow", "Optimize bundle size",
  "Add health checks to the gateway", "Fix off-by-one in pagination", "Introduce a design token pipeline", "Add audit log for admin actions",
  "Make the importer idempotent", "Add keyboard shortcuts to the editor", "Fix CORS for the staging domain", "Tune Postgres connection pool",
  "Add a dry-run flag to the deploy script", "Port the queue consumer to TypeScript", "Fix hydration mismatch on the landing page", "Add SSO login for teams",
  "Rework the notifications preferences", "Add unit tests for the pricing module", "Fix slow cold start in the lambda", "Add streaming responses to chat",
  "Deduplicate search results", "Add a changelog generator", "Fix stale cache after profile update", "Add a status page",
  "Make migrations reversible", "Add typed API client", "Fix memory spike during export", "Add S3 lifecycle rules",
  "Improve accessibility of the modal", "Add a retry budget to the SDK", "Fix locale fallback in emails", "Add infinite scroll to the feed",
  "Consolidate logging setup", "Add schema validation to the config", "Fix double charge on retry", "Add a sandbox mode for payments",
  "Write a runbook for on-call", "Add blue/green deploys", "Fix flaky websocket reconnect", "Add a feature flag for the new editor",
  "Refine the empty states", "Add bulk actions to the admin table", "Fix CSV parser edge cases", "Speed up the test suite",
];
const SUBS = [
  "Explore the auth module", "Find all callers of the config loader", "Review the diff for regressions", "Run the test suite and summarize failures",
  "Search for rate limit handling", "Map the billing data flow", "Check dependency versions", "Draft migration steps",
  "Locate flaky tests", "Audit error handling in the API", "Summarize open TODOs", "Compare two implementation options",
  "Investigate slow queries", "Verify the build output", "Scan for unused exports", "Check docs for broken links",
  "Trace the request lifecycle", "List environment variables in use", "Inspect the CI workflow", "Review accessibility of forms",
];
const PROJECTS = [
  "api", "web", "sdk", "docs", "infra", "mobile", "search", "billing", "web-app", "api-server", "analytics", "dashboard", "notifications",
  "data-pipeline", "design-system", "payments", "checkout", "gateway", "scheduler", "inventory", "storefront", "admin-panel", "docs-site",
  "ml-platform", "event-bus", "feature-flags", "status-page", "edge-proxy", "email-worker", "user-service", "metrics", "reports", "onboarding",
  "catalog", "orders", "shipping", "support-bot", "landing", "playground", "blog", "chat", "queue", "auth", "media", "cms", "crm", "ledger-api",
  "image-service", "realtime", "webhooks", "exporter", "importer", "portal", "console", "sync", "cache", "kiosk", "wallet", "ops",
];
const ASKS = [
  "Keep the change small and add tests.", "Please check the edge cases too.", "Start by reading the existing code.", "Run the tests when you're done.",
  "Don't touch the public API.", "Explain the plan first.", "Use the existing helpers where possible.", "Make sure CI stays green.",
];
const SAYS = [
  "I'll start by looking at how this is wired up today.", "The change is in place; running the tests next.", "Found the root cause — the handler retries without a backoff.",
  "All tests pass. Summary of the change below.", "Let me check the call sites before editing.", "I refactored the helper and updated both callers.",
  "The config was read twice; I moved it to a single loader.", "Here's the plan: add the guard, cover it with a test, then clean up.",
  "Build succeeded. Two lint warnings remain, both pre-existing.", "I added a regression test that fails without the fix.",
  "That endpoint is only used by the admin UI, so the change is safe.", "Done — the diff is small and focused.",
];
const THINKS = [
  "Need to check where the value is set before changing the default.", "The test likely fails because of ordering; look at the fixture.",
  "Two options: patch the caller or fix the helper. Helper is cleaner.", "Check whether the migration is reversible first.",
  "The error comes from the retry path, not the initial request.", "Keep the public signature stable; add an optional parameter.",
];
const CMDS = [
  "pnpm test", "git status", "rg -n TODO src", "pnpm lint", "git diff --stat", "npm run build", "pnpm typecheck", "ls -la src",
  "git log --oneline -5", "go test ./...", "cargo test", "pytest -q", "make build", "docker compose up -d", "pnpm vitest run src/api",
  "rg -n \"retry\" src", "git add -A", "npx tsc --noEmit", "node scripts/seed.js", "curl -s localhost:3000/health", "pnpm dev",
  "git checkout -b fix/retry", "cat package.json", "wc -l src/*.ts", "pnpm format", "git stash list", "jq .version package.json",
  "pnpm install", "uv run pytest", "gh pr view", "bun test", "ls tests", "npm outdated", "git show --stat HEAD", "psql -c 'select 1'",
];
const PROGS = ["pnpm", "git", "rg", "npm", "node", "make", "go", "cargo", "pytest", "docker", "curl", "jq", "ls", "cat", "gh", "bun", "npx", "uv"];
const FILES = [
  "src/routes/users.ts", "src/api/client.ts", "src/lib/retry.ts", "src/config.ts", "tests/api.test.ts", "src/components/Modal.tsx",
  "src/db/migrations/0042_add_index.sql", "README.md", "package.json", "src/server.ts", "src/jobs/scheduler.ts", "src/utils/date.ts",
  "docs/api.md", "src/billing/webhooks.ts", "src/auth/session.ts", "src/pages/index.tsx", "src/search/indexer.ts", "src/email/worker.ts",
  "src/middleware/rateLimit.ts", "tests/e2e/signup.spec.ts", ".github/workflows/ci.yml", "src/models/order.ts", "src/cli/main.ts",
  "src/feature-flags.ts", "src/i18n/en.json", "Dockerfile", "src/logger.ts", "src/export/csv.ts", "src/queue/consumer.ts", "tsconfig.json",
];
const PATTERNS = ["TODO", "retry", "rateLimit", "export function", "useEffect", "process.env", "class .*Service", "fetch\\(", "*.test.ts", "src/**/*.ts"];
const QUERIES = ["node 24 release notes", "postgres connection pool tuning", "oauth device flow spec", "vitest mock timers", "css container queries support"];
const URLS = ["https://nodejs.org/en/blog", "https://developer.mozilla.org/en-US/docs/Web/API", "https://docs.github.com/en/actions", "https://www.postgresql.org/docs/current/"];
const OUTS = ["ok", "✓ 42 tests passed (1.8s)", "On branch main\nnothing to commit, working tree clean", "Build succeeded in 3.2s", "src/lib/retry.ts:12: // TODO: jitter",
  "3 files changed, 41 insertions(+), 7 deletions(-)", "Done.", "no issues found", "added 3 packages in 1s", "200 OK"];
const READS = ["export function retry(fn, n = 3) {\n  // …\n}", "import { config } from \"./config\";\n\nexport const client = createClient(config);", "{\n  \"name\": \"app\",\n  \"version\": \"1.4.2\"\n}"];
const ERRS = ["Error: exit code 1\n1 test failed: expected 200, got 429", "Error: Cannot find module './config'", "Exit code 1\nlint: 2 problems"];
// path segments and cwd basenames that identify nothing (kept in fake cwds, never scrubbed on screen)
const GENERIC = new Set<string>(["code", "src", "app", "apps", "packages", "web", "api", "server", "client", "lib", "docs", "test", "tests", "frontend",
  "backend", "scripts", "worktrees", "services", "cmd", "pkg", "internal", "examples", "core", "ui", "cli", "data", "config", "build", "dist", "tmp",
  "tools", "misc", "static", "stuff", "hello", "learn", "try", "tst", "well", "books", "writer", "writings", "generated", "til", "documents", "desktop",
  "downloads", "library", "projects", "work", "dev", "private", "var", "opt", "usr", "bin", "home", "users", "workspace", "repos", "main", "claude",
  "codex", "fx", "agents", "agent", "sessions", "agentglass", "node_modules", "vendor", "public", "assets", "site", "mobile", "infra", "icloud", "mnt"]);
for (const ad of HARNESSES) GENERIC.add(ad.id); // harness dirs (.kiro, .pi, …) are never secrets
// built-in subagent types and roles (lowercase), from the harness sources: Claude Code, Codex (roles, other sources), Gemini
// CLI, OpenCode, pi's subagent packages (pi-subagents, @tintinweb, the example extension); kiro and fx kinds are system
// values. Shown as they are; any other name is user-defined and gets a fake (fakeAgent)
const AGENTS = new Set<string>(["subagent", "agent", "general-purpose", "explore", "plan", "statusline-setup", "output-style-setup",
  "claude-code-guide", "fork", "workflow-subagent", "verification", "magic-docs", // claude
  "default", "explorer", "worker", "awaiter", "review", "compact", "memory_consolidation", "guardian", // codex
  "codebase_investigator", "generalist", "cli_help", "confucius", "browser_agent", // gemini
  "build", "general", "compaction", "title", "summary", // opencode
  "scout", "planner", "reviewer", "delegate", "researcher", "oracle", "evidence-auditor", "context-builder", "claude-code",
  "claude-code-writer", "codex-exec", "codex-exec-writer", "cursor-agent", "cursor-agent-writer"]); // pi
const AGENT_POOL = ["helper", "checker", "auditor", "builder", "runner", "tester", "fixer", "mapper", "linter", "porter", "triager", "drafter",
  "sweeper", "indexer", "profiler", "migrator", "verifier", "analyst", "curator", "scribe", "courier", "tracker", "grader", "sorter",
  "janitor", "watcher", "prober", "bisector", "packer", "stager"];
const FIRST = ["sam", "alex", "robin", "jordan", "charlie", "harrison", "alexander", "maximilian"];
const LAST = ["lee", "park", "smith", "miller", "johnson", "anderson", "rodriguez", "richardson"];

function hash(s: string): number { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) % 4294967296; return h; }
function pick(a: string[], key: string): string { return a.length ? a[hash(key) % a.length] ?? "" : ""; }
function exactLen(pool: string[], n: number): string { for (const x of pool) if (x.length === n) return x; return ""; }

// ── fake project names: same length as the real one, so the scrubber can swap them in place ─────────────
const codeDirs = new Set<string>();
const projMemo = new Map<string, string>();
function stretch(s: string, n: number): string { let o = s; while (o.length < n) o = o + "-" + s; return o.slice(0, n); }
export function fakeProject(real: string): string {
  const k = real.toLowerCase();
  const hit = projMemo.get(k);
  if (hit !== undefined) return hit;
  const n = real.length;
  const pool = PROJECTS.filter((p) => !codeDirs.has(p)); // a fake must never name a real ~/code dir (actions would run there)
  const cands = pool.filter((p) => p.length === n);
  if (!cands.length) for (const a of pool) for (const b of pool) if (a !== b && a.length + 1 + b.length === n) cands.push(a + "-" + b);
  let out = cands.length ? pick(cands, k) : "";
  if (!out) out = stretch(pick(pool, k) + "-" + pick(pool, k + "1"), n);
  projMemo.set(k, out);
  return out;
}
// a user-defined subagent name → a stable fake of the same length (the scrubber swaps it in place), one per real name
const agentMemo = new Map<string, string>(); const agentUsed = new Set<string>();
// tools named after a user-defined agent (Gemini; lowercase) → its fake, also where the word scrubber skips the name (a
// dictionary word: ordinary text). Only those: a Claude agent called "read" must not rename OpenCode's read tool
const agentTools = new Set<string>();
function agentTool(name: string): string { return agentTools.has(name.toLowerCase()) ? fakeAgent(name) : name; }
function toolAgent(name: string): void {
  const f = fakeAgent(name); if (f === name || agentTools.has(name.toLowerCase())) return;
  agentTools.add(name.toLowerCase()); addWord(name + "__", f + "__", false); // its call ids: <tool>__<n>, <tool>__call_<n>
}
export function builtinAgent(name: string): boolean { return AGENTS.has(name.toLowerCase()); }
export function fakeAgent(real: string): string {
  const k = real.toLowerCase();
  if (!k || AGENTS.has(k)) return real;
  const hit = agentMemo.get(k); if (hit !== undefined) return hit;
  const n = real.length; const free = (c: string): boolean => c !== k && !agentUsed.has(c) && !AGENTS.has(c);
  const cands = AGENT_POOL.filter((p: string) => p.length === n);
  if (!cands.length) for (const a of AGENT_POOL) for (const b of AGENT_POOL) if (a !== b && a.length + 1 + b.length === n) cands.push(a + "-" + b);
  let out = ""; const h = hash("agent\t" + k);
  for (let i = 0; i < cands.length && !out; i++) { const c = cands[(h + i) % cands.length] ?? ""; if (free(c)) out = c; }
  for (let i = 0; i < 64 && !out; i++) { const c = stretch(pick(AGENT_POOL, k + i) + "-" + pick(AGENT_POOL, k + "#" + i), n); if (free(c)) out = c; }
  if (!out) out = stretch(pick(AGENT_POOL, k), n);
  agentMemo.set(k, out); agentUsed.add(out);
  if (k.length >= 3 && !common.has(k) && !GENERIC.has(k)) addWord(real, out, true); // its name in tool names, arguments, OTLP strings
  addWord("a" + real, "a" + out, true); // Claude team subagents: id a<name>-<hex>, transcript agent-a<name>-<hex>.jsonl
  return out;
}
function fakePerson(real: string, first: boolean): string {
  const n = real.length;
  return exactLen(first ? FIRST : LAST, n) || exactLen(first ? LAST : FIRST, n) || "x".repeat(n);
}
function slug(t: string): string { return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 4).join("-"); }

// ── scrubber dictionary: lowercase word → same-length replacement; bound = only between non-word chars ─────
interface Word { w: string; rep: string; bound: boolean }
const dict: Word[] = [];
const inDict = new Set<string>();
let dictVer = 0;
function addWord(word: string, rep: string, bound: boolean): void {
  const w = word.toLowerCase();
  if (w.length < 3 || w.length !== word.length) return;
  if (inDict.has(w)) { if (!bound) for (const d of dict) if (d.w === w) { d.bound = false; dictVer++; } return; } // denylist entries match inside words too
  let r = rep.toLowerCase();
  if (r.length !== w.length) r = r.length > w.length ? r.slice(0, w.length) : r + " ".repeat(w.length - r.length);
  inDict.add(w); dict.push({ w, rep: r, bound });
  dict.sort((a, b) => b.w.length - a.w.length); // longest first: a long name wins over a shorter one inside it
  dictVer++;
}
// lowercase dictionary words ("plan", "inspect") name nothing; scrubbing them would garble ordinary text
const common = new Set<string>();
function learnSeg(seg: string): void {
  const l = seg.toLowerCase();
  if (l.length < 3 || GENERIC.has(l) || l.startsWith(".") || inDict.has(l) || common.has(l)) return;
  if (/^[0-9a-f-]+$/.test(l) || /^[0-9._:+-]+$/.test(l)) return; // ids, hashes, dates, versions
  addWord(seg, fakeProject(seg), true);
}
// every path segment below $HOME that names something (projects, clients, worktrees…); tool paths seen in
// process args skip dot-dirs and ~/Library (installs, caches: "pnpm", "bin" would garble ordinary text)
function learnPath(p: string, tool: boolean): void {
  if (!p.startsWith(HOME + "/")) { if (!tool) learnSeg(base(p)); return; }
  const segs = p.slice(HOME.length + 1).split("/");
  const top = segs[0] ?? "";
  if (tool && (top.startsWith(".") || top === "Library")) return;
  for (const sg of segs) learnSeg(sg);
}
function isWordCh(c: number): boolean { return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7); } // ASCII + Latin letters
function caseLike(orig: string, rep: string): string {
  if (orig.toUpperCase() === orig && orig.toLowerCase() !== orig) return rep.toUpperCase();
  const f = orig.slice(0, 1);
  return f.toUpperCase() === f && f.toLowerCase() !== f ? rep.slice(0, 1).toUpperCase() + rep.slice(1) : rep;
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;
function secret(t: string): boolean {
  if (/^(toolu|call|msg|req|resp|fc|srvtoolu)_/.test(t)) return false; // tool-call / message ids: public, and the detail header shows them
  if (/^[0-9a-fA-F]+$/.test(t)) return true;
  return /[0-9]/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t);
}
function isTokCh(c: number): boolean { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 61; }
// runs of ≥ 24 [A-Za-z0-9_+=] that look like keys → • of the same width
// ponytail: a hand scan, not matchAll — scriptc crashed (use-after-free in the cycle collector) on `secret(m[0]) ? mask : m[0]`
function maskTokens(s: string): string {
  let o = ""; let last = 0; let st = -1;
  for (let i = 0; i <= s.length; i++) {
    if (i < s.length && isTokCh(s.charCodeAt(i))) { if (st < 0) st = i; continue; }
    if (st >= 0 && i - st >= 24) { const tok = s.slice(st, i); if (secret(tok)) { o += s.slice(last, st); o += "•".repeat(i - st); last = i; } }
    st = -1;
  }
  return last > 0 ? o + s.slice(last) : s;
}
// plain text (no escapes) → same text with every sensitive run replaced by one of the same length
export function scrubText(t: string): string {
  if (t.length < 3) return t;
  let s = t;
  if (s.indexOf("@") >= 0) {
    let o = ""; let last = 0;
    for (const m of s.matchAll(EMAIL)) { const i = m.index ?? 0; const hit = m[0]; o += s.slice(last, i); o += hit.replace(/[A-Za-z0-9]/g, "x"); last = i + hit.length; }
    s = o + s.slice(last);
  }
  if (s.length >= 24) s = maskTokens(s);
  let low = s.toLowerCase();
  if (low.length !== s.length) low = s; // ponytail: a case mapping that changes length (rare) → case-sensitive matching
  for (const d of dict) {
    let i = low.indexOf(d.w);
    while (i >= 0) {
      const j = i + d.w.length;
      if (!d.bound || ((i === 0 || !isWordCh(low.charCodeAt(i - 1))) && (j >= low.length || !isWordCh(low.charCodeAt(j))))) {
        const r = caseLike(s.slice(i, j), d.rep);
        s = s.slice(0, i) + r + s.slice(j);
        low = low.slice(0, i) + r.toLowerCase() + low.slice(j);
      }
      i = low.indexOf(d.w, j);
    }
  }
  return s;
}
// styled chunk → only the visible text between escape sequences is scrubbed; chunks repeat frame to frame, so memoize
const memo = new Map<string, string>();
let memoVer = -1;
function scrubStyled(s: string): string {
  if (memoVer !== dictVer || memo.size > 6000) { memo.clear(); memoVer = dictVer; }
  const hit = memo.get(s);
  if (hit !== undefined) return hit;
  let o = ""; let last = 0;
  for (const m of s.matchAll(ESC_RE)) { const i = m.index ?? 0; const esc = m[0]; o += scrubText(s.slice(last, i)); o += esc; last = i + esc.length; }
  o += scrubText(s.slice(last));
  memo.set(s, o);
  return o;
}

// ── identity layer: per session, fakes that win over whatever parsing (re)writes ────────────────────────
// rt/rp/rb/rn/rk: the real title, prompt, branch, name and subagent kind as last parsed (filters match them: realMeta)
interface Rec { cwd: string; real: string; title: string; branch: string; name: string; remote: string; kind: string; rt: string; rp: string; rb: string; rn: string; rk: string }
const recs = new Map<string, Rec>();
function recOf(s: Sess): Rec {
  let r = recs.get(s.path);
  if (!r) { r = { cwd: "", real: "", title: pick(s.parent ? SUBS : TITLES, s.id), branch: "", name: "", remote: "", kind: "", rt: "", rp: "", rb: "", rn: "", rk: "" }; recs.set(s.path, r); }
  return r;
}
// ~/code/<fake project>/<generic or faked deeper segments>; outside ~/code only the basename survives (faked)
function fakeCwd(real: string): string {
  if (real === HOME || real === "/") return real;
  const code = join(HOME, "code") + "/";
  const segs = (real.startsWith(code) ? real.slice(code.length) : base(real)).split("/").filter((x) => x.length > 0);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) { const sg = segs[i] ?? ""; out.push(i > 0 && (GENERIC.has(sg.toLowerCase()) || sg.startsWith(".")) ? sg : fakeProject(sg)); }
  return code + out.join("/");
}
// owner/name → fake/fake (a leading host stays); ~/… and absolute paths like cwds; " (gone)" and "(no project)" kept
function fakeRepo(text: string): string {
  const gone = text.endsWith(" (gone)"); const t = gone ? text.slice(0, -7) : text;
  if (!t || t.startsWith("(") || t === "~") return text; // the home dir as a project names nobody
  let out = "";
  if (t.startsWith("~/") || t.startsWith("/")) { const p = t.startsWith("~/") ? HOME + t.slice(1) : t; learnPath(p, false); const f = fakeCwd(p); out = f.startsWith(HOME + "/") ? "~" + f.slice(HOME.length) : f; }
  else {
    const segs = t.split("/"); const n = segs.length; const o: string[] = [];
    for (let i = 0; i < n; i++) { const sg = segs[i] ?? ""; o.push(i >= n - 2 && sg ? fakeProject(sg) : sg); }
    out = o.join("/");
  }
  return gone ? out + " (gone)" : out;
}
// scheme://host/…/owner/name → the last two segments faked like fakeRepo
function fakeRemote(url: string): string {
  const m = /^([a-z+]+:\/\/[^/]*)(\/.*)?$/.exec(url); if (!m) return url;
  const path = m[2] ?? ""; if (!path) return url;
  if ((m[1] ?? "") === "file://") return "file://" + fakeRepo(path);
  return fakeHost(m[1] ?? "") + "/" + fakeRepo(path.slice(1));
}
// public forges stay (their URL shape is the point); a self-hosted one names the company: git.example.com, port kept
const FORGES = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "gitea.com", "dev.azure.com", "sr.ht", "git.sr.ht"];
function fakeHost(origin: string): string {
  const m = /^([a-z+]+:\/\/)(?:[^@/]*@)?([^:/]+)(:\d+)?$/.exec(origin); if (!m) return origin;
  const h = (m[2] ?? "").toLowerCase();
  return FORGES.indexOf(h) >= 0 || h === "localhost" ? origin : (m[1] ?? "") + "git.example.com" + (m[3] ?? "");
}
// git linkage: a forge URL keeps a public host, kind segment, number and sha, its owner/repo path faked; a commit subject → a title
const VCS_SEG = /\/(-\/merge_requests|-\/issues|-\/commit|pull|pulls|pull-requests|issues|commits?)\/[0-9a-f]+$/;
function fakeVcs(text: string): string {
  const m = /^(https?:\/\/[^/]+)\/(.*)$/.exec(text);
  if (!m) return pick(TITLES, "vcs\t" + text);
  const rest = m[2] ?? ""; const k = VCS_SEG.exec("/" + rest); const at = k ? rest.length - (k[0] ?? "").length + 1 : rest.length;
  const segs = rest.slice(0, Math.max(0, at - 1)).split("/").filter((x: string) => x.length > 0).map((x: string) => fakeProject(x));
  return fakeHost(m[1] ?? "") + "/" + segs.join("/") + (k ? k[0] ?? "" : "");
}
// a branch → a fake, one-to-one across the run: a session's branch, its commit rows and the Repos list agree; a fake maps
// to itself (rows built from already-faked session fields pass through display again)
const MAINLINE = ["main", "master", "develop", "dev", "trunk", "HEAD"];
const brFake = new Map<string, string>(); const brFakes = new Set<string>();
function fakeBranch(real: string): string {
  if (!real || brFakes.has(real)) return real;
  if (MAINLINE.indexOf(real) >= 0) return "main";
  const hit = brFake.get(real); if (hit !== undefined) return hit;
  const b = "feat/" + (slug(pick(TITLES, "branch\t" + real)) || "work");
  let f = b; for (let n = 2; brFakes.has(f); n++) f = b + "-" + String(n);
  brFake.set(real, f); brFakes.add(f);
  return f;
}
// a transcript path names the real cwd in its directory (Claude: every non-alphanumeric → "-", pi: --a-b-c--, Gemini:
// tmp/<basename>/): those spellings of the session's cwd become the fake cwd's, the rest is scrubbed
function claudeDir(p: string): string { return p.replace(/[^A-Za-z0-9]/g, "-"); }
function piDir(p: string): string { return "--" + p.slice(1).replace(/[\/\\:]/g, "-") + "--"; }
function fakePath(p: string, s: Sess | null): string {
  const r = s ? recs.get(s.path) : undefined;
  let o = p;
  if (r && r.real && r.cwd) {
    o = o.split(claudeDir(r.real)).join(claudeDir(r.cwd)).split(piDir(r.real)).join(piDir(r.cwd));
    const b = base(r.real);
    if (b && !GENERIC.has(b.toLowerCase())) o = o.split("/" + b + "/").join("/" + base(r.cwd) + "/");
  }
  // a Claude project dir no known cwd spelled (a session without a cwd line, one that moved): faked as a whole
  const cp = "/.claude/projects/"; const i = o.indexOf(cp);
  if (i >= 0) {
    const j = o.indexOf("/", i + cp.length); const d = o.slice(i + cp.length, j > 0 ? j : o.length);
    const h = claudeDir(HOME) + "-"; const fk = r && r.cwd ? claudeDir(r.cwd) : "";
    if (d && d !== fk && !(fk && d.startsWith(fk))) o = o.slice(0, i + cp.length) + (d.startsWith(h) ? h + fakeProject(d.slice(h.length)) : fakeProject(d)) + o.slice(i + cp.length + d.length);
  }
  return scrubText(o);
}
function kept(s: Sess): boolean {
  const r = recs.get(s.path);
  const real = r ? r.real : "";
  if (!real) return false;
  for (const k of KEEP) if (real.indexOf(k) >= 0) return true;
  return false;
}
function meta(s: Sess): void {
  const r = recOf(s);
  if (s.cwd && s.cwd !== r.cwd) { r.real = s.cwd; learnPath(s.cwd, false); r.cwd = fakeCwd(s.cwd); s.cwd = r.cwd; }
  if (s.title !== r.title) r.rt = s.title;
  s.title = r.title;
  if (s.prompt && !s.prompt.startsWith(r.title)) r.rp = s.prompt; // a faked user event's text starts with the fake title
  if (s.prompt) s.prompt = r.title;
  if (s.branch && s.branch !== r.branch) { r.rb = s.branch; r.branch = fakeBranch(s.branch); s.branch = r.branch; }
  if (s.remote && s.remote !== r.remote) { r.remote = "https://github.com/acme/" + (slug(r.title) || "repo"); s.remote = r.remote; }
  if (s.name && s.name !== r.name) { r.rn = s.name; r.name = (base(r.cwd) || "session") + "-" + "0123456789abcdef".charAt(hash(s.name) % 16) + "0123456789abcdef".charAt(hash(s.name + "#") % 16); s.name = r.name; }
  if (s.kind && s.kind !== r.kind) { r.rk = s.kind; r.kind = fakeAgent(s.kind); s.kind = r.kind; if (s.h === "gemini") toolAgent(r.rk); }
  recs.set(s.path, r); // scriptc may hand out a copy of an all-string record: store the updated one back (real cwd, kept fakes)
}

// ── content layer: synthetic events of the same shape ─────────────────────────────────────────────────
function kindOf(name: string): string {
  const n = name.toLowerCase();
  if (n.indexOf("mcp") >= 0) return "mcp";
  if (n.indexOf("websearch") >= 0 || n.indexOf("web_search") >= 0) return "web";
  if (n.indexOf("fetch") >= 0) return "fetch";
  if (n.indexOf("todo") >= 0 || n.indexOf("plan") >= 0) return "todo";
  if (/bash|shell|exec|command|terminal|run/.test(n)) return "cmd";
  if (/edit|write|patch|notebook/.test(n)) return "edit";
  if (/read|view|open|cat/.test(n)) return "read";
  if (/grep|glob|search|find|list|ls/.test(n)) return "grep";
  if (/agent|task|spawn/.test(n)) return "agent";
  return "other";
}
function fakeArg(name: string, key: string): string {
  const k = kindOf(name);
  if (k === "cmd") return pick(CMDS, key);
  if (k === "edit" || k === "read") return pick(FILES, key);
  if (k === "grep") return pick(PATTERNS, key);
  if (k === "web") return pick(QUERIES, key);
  if (k === "fetch") return pick(URLS, key);
  if (k === "agent") return pick(SUBS, key);
  if (k === "todo") return "update the task list";
  if (k === "mcp") return "{\"query\":\"" + pick(PATTERNS, key).replace(/[\\"]/g, "") + "\"}";
  return "{…}";
}
function fakeFull(name: string, arg: string, key: string): string {
  const k = kindOf(name);
  const q = (v: string): string => JSON.stringify(v);
  if (k === "cmd") return "{\"command\":" + q(arg) + "}";
  if (k === "edit" && /write/i.test(name)) return "{\"file_path\":" + q(arg) + ",\"content\":" + q(pick(READS, key)) + "}";
  if (k === "edit") return "{\"file_path\":" + q(arg) + ",\"old_string\":" + q("const retries = 1;") + ",\"new_string\":" + q("const retries = 3; // with backoff") + "}";
  if (k === "read") return "{\"file_path\":" + q(arg) + "}";
  if (k === "grep") return "{\"pattern\":" + q(arg) + ",\"path\":\"src\"}";
  if (k === "web") return "{\"query\":" + q(arg) + "}";
  if (k === "fetch") return "{\"url\":" + q(arg) + "}";
  if (k === "agent") return "{\"description\":" + q(arg) + "}";
  return "";
}
function fakeResult(name: string, key: string): string {
  const k = kindOf(name);
  if (k === "read") return pick(READS, key);
  if (k === "edit") return "The file has been updated successfully.";
  if (k === "grep") return pick(FILES, key) + "\n" + pick(FILES, key + "2");
  if (k === "agent") return pick(SAYS, key);
  if (k === "todo") return "Todos have been updated.";
  return pick(OUTS, key);
}
function fakeEv(e: Ev, evs: Ev[], i: number, title: string): void {
  const key = e.kind + e.ts + e.id + e.text.slice(0, 80);
  if (e.kind === "user") e.text = title + (hash(key) % 3 === 0 ? "" : ". " + pick(ASKS, key));
  else if (e.kind === "assistant") e.text = pick(SAYS, key);
  else if (e.kind === "thinking") e.text = pick(THINKS, key);
  else if (e.kind === "tool") {
    const j = e.text.indexOf("\u0000");
    const name = j >= 0 ? e.text.slice(0, j) : e.text;
    const a = fakeArg(name, key);
    e.text = name + "\u0000" + a;
    e.full = fakeFull(name, a, key);
    return;
  } else if (e.kind === "result") {
    let name = "";
    if (e.id) for (let j = i - 1; j >= 0 && j > i - 400; j--) { const c = evs[j]; if (c && c.kind === "tool" && c.id === e.id) { name = c.text.slice(0, Math.max(0, c.text.indexOf("\u0000"))); break; } }
    e.text = isErr(e.text) ? pick(ERRS, key) : fakeResult(name, key);
  } else if (e.kind === "meta" && e.text.startsWith("summary:")) e.text = "summary: " + title;
  else { e.text = scrubText(e.text); return; }
  e.full = "";
}
// process args: the program, flags, ids and paths stay; free text (prompts) goes
function fakeArgs(a: string): string {
  const out: string[] = [];
  for (const t of a.split(" ")) {
    if (!t) continue;
    if (t.startsWith(HOME + "/")) learnPath(t, true);
    const keep = !out.length || t.startsWith("-") || t.indexOf("/") >= 0 || /^[0-9a-fA-F-]{6,}$/.test(t) || /^[0-9]+$/.test(t) || /\.[a-z]{1,4}$/.test(t) ||
      ["resume", "exec", "ask", "run", "mcp", "serve", "app-server", "proxy", "start"].indexOf(t) >= 0;
    if (keep) out.push(t); else if (out[out.length - 1] !== "…") out.push("…");
  }
  return out.join(" ");
}
// ledger rows (commands, files, programs) are aggregated across sessions: stable one-to-one fakes
const uniqMap = new Map<string, string>(); const uniqUsed = new Set<string>();
function uniq(kind: string, text: string, pool: string[]): string {
  const k = kind + "\t" + text;
  const hit = uniqMap.get(k);
  if (hit !== undefined) return hit;
  const h = hash(k);
  let out = "";
  for (let n = 0; n < pool.length && !out; n++) { const c = pool[(h + n) % pool.length] ?? ""; if (!uniqUsed.has(kind + "\t" + c)) out = c; }
  if (!out) out = pick(pool, k) + " #" + uniqMap.size;
  uniqUsed.add(kind + "\t" + out); uniqMap.set(k, out);
  return out;
}
const SAFE_PROGS = new Set<string>(PROGS.concat(["sed", "awk", "grep", "find", "head", "tail", "echo", "python3", "python", "wc", "sort", "mkdir", "rm", "cp", "mv", "tmux", "sleep", "tsc", "rtk", "brew", "open"]));
// a pinned value shown as "…": free text, paths and user names; harness vocabulary (enums, built-in tools, safe programs,
// built-in agents), models and extensions stay readable
function maskPinned(k: string, v: string): boolean {
  const a = attrOf(k); if (!a || (a.type !== "text" && a.type !== "path") || k === "model" || k === "ext") return false;
  if (k === "tool") return /mcp|__/i.test(v) || agentMemo.has(v.toLowerCase());
  if (k === "program") return !SAFE_PROGS.has(v);
  if (k === "agent") return !builtinAgent(v);
  return true;
}
function display(kind: string, text: string, s: Sess | null): string {
  if (kind.startsWith("tool:")) return s && kept(s) ? text : fakeArg(kind.slice(5), kind + text);
  if (kind === "cmd") return uniq(kind, text, CMDS);
  if (kind === "file") return uniq(kind, text, FILES);
  if (kind === "prog") return SAFE_PROGS.has(text) ? text : uniq(kind, text, PROGS);
  if (kind === "args") return fakeArgs(text);
  if (kind === "cwd") { learnPath(text, false); return text ? fakeCwd(text) : text; }
  if (kind === "repo") return fakeRepo(text);
  if (kind === "remote") return fakeRemote(text);
  if (kind === "vcs") return fakeVcs(text);
  if (kind === "branch") return fakeBranch(text);
  if (kind === "path") return s && kept(s) ? text : fakePath(text, s);
  if (kind === "tool") return agentTool(text); // a tool name: Gemini runs a subagent as a tool named after it
  if (kind.startsWith("filter:")) { // a filter chip's value, by its key
    const k = kind.slice(7);
    if (PINNED.has(k + "\t" + text.toLowerCase()) && maskPinned(k, text)) return "…";
    if (k === "cwd") { const p = text.startsWith("~/") ? HOME + text.slice(1) : text; learnPath(p, false); return p.indexOf("*") >= 0 ? scrubText(text) : fakeCwd(p); }
    if (k === "file") return text.indexOf("*") >= 0 ? scrubText(text) : uniq("file", text, FILES);
    if (k === "command") return uniq("cmd", text, CMDS);
    if (k === "repo") { learnSeg(text); return scrubText(text); }
    if (k === "tool") return agentTool(text);
    if (k === "agent") return agentMemo.get(text.toLowerCase()) ?? scrubText(text); // a fake or a partial name: scrubbed
    if (k === "title" || k === "text" || k === "content" || k === "branch" || k === "id") return scrubText(text);
  }
  return text;
}

// ── setup ───────────────────────────────────────────────────────────────────
function learnPeople(): void {
  // "bjoern", "Björn Schotte", "BjoernSchotte" → bjoern, Björn, Schotte, Bjoern (+ ASCII spellings of umlauts); the first word of a name is a first name
  const add = (n: string, first: boolean): void => {
    for (const v of [n, n.replace(/ö/g, "oe").replace(/ä/g, "ae").replace(/ü/g, "ue").replace(/ß/g, "ss"), n.replace(/ö/g, "o").replace(/ä/g, "a").replace(/ü/g, "u")]) addWord(v, fakePerson(v, first), false);
  };
  add(userInfo().username, true);
  for (const full of [OS.fullName(), run("git", ["config", "--global", "user.name"])]) {
    const parts = full.trim().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s._-]+/).filter((p) => p.length > 0);
    for (let i = 0; i < parts.length; i++) add(parts[i] ?? "", i === 0);
  }
}
function setup(): void {
  learnPeople();
  for (const w of readText("/usr/share/dict/words", 0, 4194304).split("\n")) if (w.length >= 3 && w.toLowerCase() === w) common.add(w);
  const code = join(HOME, "code");
  for (const d of listDir(code)) {
    try { if (!statSync(join(code, d)).isDirectory()) continue; } catch (e) { continue; }
    codeDirs.add(d.toLowerCase());
  }
  for (const d of codeDirs) learnSeg(d);
  for (const l of readText(join(HOME, ".agentglass", "redact.txt"), 0, 65536).split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) addWord(t.slice(0, i).trim(), t.slice(i + 1).trim(), false);
    else addWord(t, fakeProject(t), false);
  }
}

if (REDACT) {
  setup();
  H.meta.push(meta);
  H.agents.push(toolAgent);
  H.events.push((s: Sess | null, evs: Ev[], from: number) => {
    const keep = s !== null && kept(s);
    const title = s ? recOf(s).title : pick(TITLES, "?");
    for (let i = from; i < evs.length; i++) {
      const e = evs[i];
      if (!e) continue;
      // the first prompt, before it is faked: a title read from it (loadTail) is what filters match (realMeta)
      if (s && e.kind === "user") { const r = recOf(s); if (!r.rp) { r.rp = firstLine(e.text, 200); recs.set(s.path, r); } }
      if (e.kind === "tool") { const j = e.text.indexOf("\u0000"); const n = j >= 0 ? e.text.slice(0, j) : e.text; const f = agentTool(n); if (f !== n) e.text = f + e.text.slice(n.length); }
      if (!keep) { fakeEv(e, evs, i, title); continue; }
      e.text = scrubText(e.text);
      if (!e.full.startsWith("@file:") && e.full.length < 1048576) e.full = scrubText(e.full);
    }
  });
  H.display.push(display);
  H.realCwd.push((s: Sess): string => { const r = recs.get(s.path); return r ? r.real : ""; }); // agent-mode scope compares real projects
  // filters match the real values; a field parsing rewrote since the last H.meta is real as it stands
  H.realMeta.push((s: Sess): RealMeta | null => {
    const r = recs.get(s.path); if (!r) return null;
    return { cwd: s.cwd !== r.cwd ? s.cwd : r.real || s.cwd, title: s.title !== r.title ? s.title : r.rt, prompt: s.prompt && !s.prompt.startsWith(r.title) ? s.prompt : r.rp,
      branch: s.branch !== r.branch ? s.branch : r.rb, name: s.name !== r.name ? s.name : r.rn, kind: s.kind !== r.kind ? s.kind : r.rk };
  });
  H.screenFilter.push(scrubStyled);
  H.headerWidgets.unshift((w: number) => (w >= 10 ? bg(C.red) + fg(C.panel) + CSI + "1m" + " REDACTED " + RST : ""));
}
H.helpSections.push({ name: "privacy (--redact)", ctx: "", keys: [
  ["--redact", "fake titles, projects, content; scrub names"], ["…REDACT=1", "AGENTGLASS_REDACT=1: the same via env"],
  ["…REDACT_KEEP", "cwd substrings whose content stays real"], ["redact.txt", "~/.agentglass/: extra words (w or w=repl)"],
  ["filters", "match the real values; a shown fake repo/cwd/branch/agent only exactly (is, is_one_of), never by ~ or a bare word"],
  ["pins", "values shown as … (they still filter); P keeps or deletes them, editing one needs a run without --redact"],
  ["subagents", "built-in types (Explore, generalist, …) stay; user-defined agent names get stable fakes"] ] });
