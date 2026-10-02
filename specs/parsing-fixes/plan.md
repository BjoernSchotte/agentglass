# Parsing Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude `/rename` titles win, fallback attempts are booked per model, task notifications and peer messages stop being (or swallowing) prompts, skills are counted (Stats group, preview, `--json`), and one `scrubRemote()` helper removes credentials from git remotes (first consumer: Codex `repository_url`).

**Architecture:** Changes stay inside the harness adapters (`claude.ts`, `codex.ts`, `opencode.ts`, `gemini.ts`), the shared noise list in `common.ts`, the usage record/cache (`Day.skills`, `Day.turns`, `Acc.pk`), the Stats tab, the CLI and one new pure module `src/util/giturl.ts`. `classifyUser()` and `scrubRemote()` are exported shared pieces (owner: this spec) that otlp-export, repo-view and git-linkage reuse.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first, including "Decisions (review 2026-10-02)" and "Open questions"; this plan argues from it.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`); a task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields); call optional function members via a local; out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log`.
- Style: match the surrounding code — dense one-line helpers, short `//` why-comments, no new dependencies.
- Never write into agent data dirs (`~/.claude`, `~/.codex`, …) from agentglass code; no network. A raw (unscrubbed) remote URL is never stored on `Sess`, in the ledger cache, in logs or in `--json`.
- Ledger cache: `src/features/usage/cache.ts` `VERSION` (5 on `main` today, `cache.ts:15`) bumps **once** in this branch (Task 4) to the next free number at implementation time. If honest-costs ships in the same release, the two branches share one bump: whichever merges second rebases onto the other's number and does not bump again; its comment lists both changes.
- Old behavior is a contract: `agentglass --json --subagents --limit 400` for codex/fx/pi/opencode/kiro/gemini is field-identical before/after except volatile fields (`updated bytes activity live pid status attention stuck`) and the intended additions (`skills`, `remote`, user events for prompts starting with an unknown `<tag>`). For claude, only `title` (renamed sessions), tokens/`costUsd` (two-iteration messages) and the additions may change.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Phase 1, no dependencies. Worktree `../agentglass-parsing-fixes`, branch `fix/parsing-fixes`, PR to `main`, rebase-merge after green CI. honest-costs (also phase 1) touches `record.ts`/`cache.ts`/`stats.ts`/`cli.ts` too: the second to merge rebases and resolves.

## Review Focus

1. **A slash command or hook output line that carries `origin.kind:"human"`**: `<local-command-stdout>`, `<system-reminder>` or `<command-name>` text must never become a prompt or open a turn, whatever the origin says. Task 3 check feeds each known tag with `origin.kind:"human"` and asserts `noise`/command handling.
2. **Head read after tail** (preview opened, then the head window loads late): an older `custom-title` in the head must not overwrite a newer one already seen in the tail, and an `ai-title` must never overwrite either. Task 2 check runs tail lines then head lines through `parse()`.
3. **Two-iteration message streamed over 3 lines + a ledger resume between them**: tokens booked exactly once per message (the iteration sum), never top-level + iterations. Task 4 check books the 3 lines, then the same lines again into the same Acc, and once more into a fresh Acc resumed at line 2.
4. **Credential in an unusual place of a remote** (`https://a:b@c@host/o/r`, `%40` in userinfo, token in the query, `ssh://git@host:2222/o/r.git`): scrubbed or `null`, never echoed. Task 1 table + Task 9 check that `--json` of a Codex session with `x-access-token:ghs_…@` shows no `ghs_`.
5. **Skill pairing across a gap**: a `/skill` command whose base-directory line never comes (`/compact`, a custom command) must not count, and the pending `pk` must not pair with a later, unrelated skill line of another prompt. Task 5 check: `/compact` → no count; `/x:a` then a base-directory line with a different `promptId` → no count; ledger resumed between command and meta line → counted once (`pk` persisted).

---

### Task 0: Worktree, probes for the open questions, fixtures

**Files:** none committed except check fixtures added by later tasks (hand-written lines in the real shapes found here; copies of real session data are not committed).

- [ ] **Step 1: Worktree** `git worktree add -b fix/parsing-fixes ../agentglass-parsing-fixes main && cd ../agentglass-parsing-fixes && ./build.sh && sh scripts/check.sh` → all ok.
- [ ] **Step 2: Baseline** `./agentglass --json --subagents --limit 400 > /tmp/pf-before.json` (kept outside the repo for the contract diff in Task 10).
- [ ] **Step 3: Origin vs leading tag (Review Focus 1)**:
  Run: `for f in $(ls -t ~/.claude/projects/*/*.jsonl | head -300); do jq -rc 'select(.type=="user" and (.message.content|type)=="string") | [(.message.content|capture("^\\s*<(?<t>[a-z-]+)>")?.t // "-"), (.origin.kind // "-"), (.turnOrigin // "-"), (.promptSource // "-")] | @tsv' "$f" 2>/dev/null; done | sort | uniq -c | sort -rn | head -40`
  Expected: a table tag × origin. Record it in the PR description. **Rule if any noise tag (`local-command-*`, `system-reminder`, `bash-*`, `user-prompt-submit-hook`) or `command-*` appears with `origin.kind` = `human`:** the known-tag check runs **before** the origin check in `classifyUser` (Task 3 already implements this order; the probe confirms it is needed). Also list every `origin.kind` and `turnOrigin` value seen; any value not in the spec list (`human task-notification auto-continuation peer` / `human task_notification auto_continuation peer scheduled sdk`) → ledger a `Ruling:` in the PR and map it to `human` (spec rule 3: unknown = visible).
- [ ] **Step 4: Open question 3 — Claude `peer` sender field**:
  Run: `rg -l '"kind":"peer"|"turnOrigin":"peer"' ~/.claude/projects | head -3` then for one hit `rg -m1 '"kind":"peer"|"turnOrigin":"peer"' <file> | jq '{origin, turnOrigin, promptSource, content: (.message.content|tostring|.[0:300])}'`.
  Expected: an `origin` object; note which key carries the sender (`from`, `name`, `agent`, `sender` …) and whether the content wraps it (e.g. `<peer-message from="…">`). If no local hit: produce one with Claude Code's agent-to-agent messaging (a session with a teammate / `SendMessage` from one agent to another) in `/tmp/agtest-peer`, then repeat. **Fallback** (no sample obtainable): `<from>` = `str(origin.from) || str(origin.name) || "peer"`, ledger a `Ruling:`.
- [ ] **Step 5: Fallback iterations shape (L2)**:
  Run: `rg -l '"fallback_message"' ~/.claude/projects | head -3`; for one file `jq -c 'select(.message.usage.iterations|length>=2) | [.message.id, (.message.usage.iterations|map([.type,.model,.input_tokens,.output_tokens,.cache_read_input_tokens,(.cache_creation|tostring)]))]' <file>`.
  Expected: every streamed line of one `message.id` carries identical `iterations`; the per-iteration cache split keys are `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. **If the lines of one id differ** (later lines larger): ledger a `Ruling:` and change Task 4 to book on the first line only what is final (keep first-line booking, as the spec's dedupe rule says) — do not add per-iteration delta state.
- [ ] **Step 6: Claude skill pairing (L6)**:
  Run: `rg -n -m3 'Base directory for this skill:' ~/.claude/projects/*/*.jsonl | head -6`, then for one session `jq -c 'select(.type=="user") | {isMeta, promptId, sourceToolUseID, c: (.message.content|tostring|.[0:160])}' <file> | rg -B2 'Base directory'`.
  Expected: command pair (`<command-name>/a:b</command-name>` line, then `isMeta:true` line with the same `promptId`, no `sourceToolUseID`); model pair (`Skill` tool_use, then meta line **with** `sourceToolUseID`). Note whether the meta text is a string or a `[{"type":"text"}]` array (the parser must accept both).
- [ ] **Step 7: Open question 1 — Codex `<skill>` message and `$name`**:
  Source: `cd ~ && npx opensrc https://github.com/openai/codex` then `rg -n '<skill>|</skill>|SKILL.md' ~/opensrc/**/codex-rs --glob '*.rs' | head -20` — find how the skill message is built and whether the injected item has an explicit marker field.
  Real runs in `/tmp/agtest-codex-skill`: create `.agents/skills/agtest-hello/SKILL.md` (`---\nname: agtest-hello\ndescription: Say hello in the agtest way\n---\nAnswer "hello from agtest".`) — if Codex does not pick up repo-local skills, use `~/.codex/skills/agtest-hello/` and delete it afterwards. Then `codex exec 'use $agtest-hello'` and `codex exec 'greet me the agtest way'`.
  Run: `rg -l agtest-hello ~/.codex/sessions | xargs -I{} jq -c 'select(.type=="response_item" and .payload.role=="user") | .payload.content[0].text[0:200]' {}`.
  Expected: a user message starting `<skill>` with `<name>agtest-hello</name>` in both runs; the first run's human prompt contains `$agtest-hello`. Check that `"text":"<skill>` lies within the first 200 bytes of the line. **If Codex marks injected items explicitly** (a field on the item): use that marker for detection and for `command`/`model` (spec). **If no `<skill>` message appears at all:** Codex skills are not counted (Task 7 drops its Codex part), `<skill>` stays on the noise list; ledger a `Ruling:`.
- [ ] **Step 8: Open question 2 — pi skills**:
  Run: `rg -n -i 'skill' $(npm root -g)/@earendil-works/pi-coding-agent/dist --glob '*.js' -l | head` and look for a session entry type written on skill load. Real run in `/tmp/agtest-pi-skill` with `.pi/skills/agtest-hello/SKILL.md` (same content): `pi -p 'use the agtest-hello skill'`; then `rg -n -i 'agtest-hello' ~/.pi/agent/sessions -l | head -1 | xargs jq -c 'select(tostring|test("agtest-hello"))|{type, role: .message.role, c: (tostring|.[0:200])}'`.
  Expected: either a dedicated entry (count it like OpenCode, `model\t<name>`, add to Task 7) or only a `read` tool call of `SKILL.md` (**fallback, spec default:** pi skills not counted; ledger a `Ruling:`).
- [ ] **Step 9: Leading tags per harness (spec §3 risk)**:
  Run for codex: `rg -h -o '"role":"user","content":\[\{"type":"input_text","text":"<[a-z_-]+>' ~/.codex/sessions | sort | uniq -c`; kiro: `rg -h -o '"Prompt".{0,200}' ~/.kiro 2>/dev/null | rg -o '"text":"<[a-z_-]+>' | sort | uniq -c`; gemini: `rg -h -o '"type":"user".{0,300}' ~/.gemini/tmp | rg -o '"text":"<[a-z_-]+>' | sort | uniq -c`.
  Expected: Codex `environment_context`, `recommended_plugins`, `user_instructions`, `turn_aborted`, `skill`; anything else seen ≥ 2 times that is harness-injected goes into `NOISE_TAGS` (Task 3) with a comment naming the harness; ledger the list.
- [ ] **Step 10: Codex remote shape (L10)**: `rg -h -o '"repository_url":"[^"]*"' ~/.codex/sessions | sort | uniq -c | head` — expected `https://github.com/<o>/<r>.git` (and possibly `git@…`). Never paste a real URL with credentials anywhere; if one shows up, the check fixture uses a synthetic token.
- [ ] **Step 11:** No commit in this task (probe results go into the PR description and the fixtures of the owning tasks).

---

### Task 1: `scrubRemote()` — credential-free git remotes

**Files:** Create `src/util/giturl.ts`, `src/util/giturl.check.ts`.

**Interfaces — Produces:**
- `export interface Remote { url: string; host: string; path: string; owner: string; name: string }` — `url` = scrubbed canonical form `scheme://host[:port]/path` (no userinfo, query, fragment, trailing `.git`); `path` without leading `/` and without `.git`; `owner`/`name` = last two path segments (`""` when fewer). `file://` remotes: `host = ""`, `url = "file://" + path` with `$HOME` → `~`.
- `export function scrubRemote(raw: string): Remote | null` — `null` = dropped (suspicious or unparseable).
- `export function remoteLabel(r: Remote): string` — `host + "/" + path` (`path` only for `file://`), for preview display.

Rules (spec §5, in order): trim; reject control chars (`/[\x00-\x1f\x7f]/`) or length > 2048; recognise `scheme://` (`https http ssh git git+ssh file`, case-insensitive; other schemes → `null`), scp-like `[user@]host:path` (no `://`, host has no `/`, path does not start with `/` or `\`), absolute local path (`/…`, `~/…`). Authority = text up to the first `/` after `://`; strip userinfo up to the **last** `@` in the authority; strip `?…` and `#…` from the rest. scp-like → `ssh://host/path`. Then reject when host or path still contains `@ ? #` or `%40`/`%3A`/`%3a` (structural check). The token-shaped patterns (`/^(ghp|gho|ghs|ghu|github_pat)_/`, `/^glpat-/`, `x-access-token`, `oauth2`, `/^[A-Za-z0-9_-]{32,}$/` with both a letter and a digit) concern only userinfo, query and fragment, which are removed whole; path segments (owner/repo) are never dropped as tokens (spec §5 step 4, decision 4). Lowercase the host; keep the port.

- [ ] **Step 1: Failing check** `giturl.check.ts` — a table of ≥ 25 `[input, expectedUrl | null, owner, name]` rows, including:
  `https://github.com/o/r.git` → `https://github.com/o/r`, `o`, `r`;
  `https://x-access-token:ghs_abc123@github.com/o/r.git` → `https://github.com/o/r`;
  `https://user:pass@gitlab.com/g/sub/r` → `https://gitlab.com/g/sub/r`, `sub`, `r`;
  `https://a:b@c@github.com/o/r` → `https://github.com/o/r` (last `@`);
  `https://user%40corp:tok@host/o/r` → `https://host/o/r`;
  `https://host/o/r?token=abc` → `https://host/o/r`; `https://host/o/r#frag` → `https://host/o/r`;
  `https://host/o%40x/r` → `null`; `https://ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@host/o/r` → `https://host/o/r` (token in userinfo removed); `https://host/o/r?access_token=glpat-xyz#oauth2` → `https://host/o/r`;
  path segments are never dropped as tokens: `https://host/ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/r` → kept, owner `ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, name `r`; `https://host/oauth2/r` → kept; `https://host/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8` → kept, owner `o`, name `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8`;
  `git@github.com:o/r.git` → `ssh://github.com/o/r`; `ssh://git@host:2222/o/r.git` → `ssh://host:2222/o/r`;
  `git+ssh://git@host/o/r` → `git+ssh://host/o/r`; `git://host/o/r` → `git://host/o/r`;
  `HTTPS://GitHub.com/O/R` → `https://github.com/O/R` (host lowercased, path kept);
  `file:///home/u/src/r` with HOME=/home/u → `file://~/src/r`, host `""`; `/srv/git/r.git` → `file:///srv/git/r`;
  `https://host` → url `https://host`, owner `""`, name `""`; `" https://host/o/r "` → trimmed;
  `"https://host/o/r\n"` with an inner `\r` → `null`; 2049-char input → `null`; `""` → `null`; `"not a url"` → `null`; `ftp://host/o/r` → `null`; `https://host/o/my-repo-name-2026` → kept (not token-shaped: < 32).
  Also assert `remoteLabel(scrubRemote("git@github.com:o/r.git"))` = `github.com/o/r`, and that no returned field of any row contains `ghs_`, `pass`, `tok`, `token=`.
  Run: `scriptc build src/util/giturl.check.ts -o /tmp/x && /tmp/x` → Expected: FAIL (module missing).
- [ ] **Step 2: Implement** `giturl.ts` (pure, imports only `HOME` from `./fs.ts`):

```ts
// agentglass — git remote URLs without credentials: every remote agentglass shows or exports goes through scrubRemote
// SPDX-License-Identifier: Apache-2.0
import { HOME } from "./fs.ts";
export interface Remote { url: string; host: string; path: string; owner: string; name: string }
const SCHEMES = ["https", "http", "ssh", "git", "git+ssh", "file"];
function build(scheme: string, host: string, path0: string): Remote | null {
  let path = path0.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (/[@?#]|%40|%3a/i.test(host + "/" + path)) return null;
  const segs = path.split("/").filter((x) => x.length > 0); // never dropped as tokens: userinfo/query/fragment are already gone
  path = segs.join("/");
  const n = segs.length;
  const owner = n >= 2 ? segs[n - 2] ?? "" : ""; const name = n >= 2 ? segs[n - 1] ?? "" : "";
  if (scheme === "file") return { url: "file://" + path0.replace(/\.git$/, ""), host: "", path, owner, name };
  return { url: scheme + "://" + host + (path ? "/" + path : ""), host, path, owner, name };
}
export function scrubRemote(raw: string): Remote | null {
  const s = raw.trim();
  if (!s || s.length > 2048 || /[\x00-\x1f\x7f]/.test(s)) return null;
  const local = (p: string): Remote | null => build("file", "", p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);
  const m = /^([A-Za-z][A-Za-z0-9+]*):\/\/(.*)$/.exec(s);
  if (m) {
    const scheme = (m[1] ?? "").toLowerCase(); if (SCHEMES.indexOf(scheme) < 0) return null;
    let rest = m[2] ?? "";
    const q = rest.search(/[?#]/); if (q >= 0) rest = rest.slice(0, q);
    if (scheme === "file") return local(rest);
    const sl = rest.indexOf("/"); let auth = sl >= 0 ? rest.slice(0, sl) : rest; const path = sl >= 0 ? rest.slice(sl) : "";
    const at = auth.lastIndexOf("@"); if (at >= 0) auth = auth.slice(at + 1);
    if (!auth) return null;
    return build(scheme, auth.toLowerCase(), path);
  }
  if (s.startsWith("/")) return local(s);
  if (s.startsWith("~/")) return build("file", "", s);
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(s);
  if (scp && !(scp[2] ?? "").startsWith("/") && !(scp[2] ?? "").startsWith("//")) return build("ssh", (scp[1] ?? "").toLowerCase(), scp[2] ?? "");
  return null;
}
export function remoteLabel(r: Remote): string { return r.host ? r.host + (r.path ? "/" + r.path : "") : r.path; }
```

  (Adjust to scriptc rejections, e.g. a zero-parameter arrow is fine here because it is a local, not an optional interface member. The `ftp`/garbage rows decide the exact scp-like regex; keep every table row passing.)
- [ ] **Step 3: Run** the check → Expected: `giturl: all checks passed`; `sh scripts/check.sh` → all ok.
- [ ] **Step 4: Commit** `git add src/util/giturl.ts src/util/giturl.check.ts && git commit -m "feat(util): scrubRemote — git remote URLs without credentials"`.

---

### Task 2: Claude title precedence (`custom-title` beats `ai-title`)

**Files:** Modify `src/harness/claude.ts:40-43` (`parse`); Test `src/harness/harness.check.ts` (new block after the SAMPLES loop).

**Interfaces — Produces:** module-level `const renamed = new Map<string, string>()` in `claude.ts` (path → latest custom title seen); `parse()` handles `type === "custom-title"`. No exported names.

Rules (spec §1): `custom-title` with `t = str(o["customTitle"]).trim()`: non-empty → `s.title = t; renamed.set(s.path, t)`; empty → `renamed.delete(s.path)` (the next `ai-title` applies). `ai-title`: `if (s && !renamed.has(s.path)) s.title = str(o["aiTitle"])`; if `renamed.has(s.path)` → `s.title = renamed.get(s.path)` (re-assert: a reader that reset `s.title` gets the custom one back). **Ordering (Review Focus 2):** store with the custom title the line's `timestamp`; a `custom-title` older than the stored one (ISO string compare, both non-empty) does not replace it — so a head window read after the tail cannot roll a rename back.

- [ ] **Step 1: Failing check** in `harness.check.ts`: helper `claudeTitle(lines: string[]): string` = fresh `newSess("claude", "t", "/x/t-<n>.jsonl", false)` (unique path per case), `parseEvents("claude", l, evs, s)` for each line, return `s.title`. Cases (lines in the real shapes: `{"type":"custom-title","customTitle":"…","sessionId":"t","timestamp":"…"}`, `{"type":"ai-title","aiTitle":"…","sessionId":"t","timestamp":"…"}`):
  - `ai A`, → `A`;
  - `custom X`, `ai A` → `X` (the real interleaving: ai right after custom);
  - `custom X`, `ai A`, `custom Y`, `ai B` → `Y`;
  - `custom X`, `custom ""`, `ai B` → `B` (rename to empty);
  - tail-then-head on the **same** session: `custom Y @10:05`, `ai B` then `custom X @10:00`, `ai A` → `Y`;
  - `custom "  "` only → `""` → then `ai A` → `A`.
  Run: `scriptc build src/harness/harness.check.ts -o /tmp/x && /tmp/x` → Expected: FAIL on the `X`/`Y` cases.
- [ ] **Step 2: Implement** in `parse()`:

```ts
const renamed = new Map<string, string[]>(); // path → [custom title, its timestamp]: /rename wins over the ai-title Claude re-appends after it
…
if (type === "custom-title") {
  if (!s) return;
  const t = str(o["customTitle"]).trim(); const prev = renamed.get(s.path);
  if (prev && ts && (prev[1] ?? "") > ts) return; // an older rename (head read after tail) never rolls back a newer one
  if (t) { renamed.set(s.path, [t, ts]); s.title = t; } else renamed.delete(s.path);
  return;
}
if (type === "ai-title") { if (s) { const r = renamed.get(s.path); s.title = r ? r[0] ?? "" : str(o["aiTitle"]); } return; }
```

- [ ] **Step 3: Run** the check → PASS; `sh scripts/check.sh` → all ok.
- [ ] **Step 4: Commit** `git commit -am "fix(claude): a /rename title wins over the ai-title re-appended after it"`.

---

### Task 3: `classifyUser()` — turn boundaries, notifications, peers, narrowed noise

**Files:** Modify `src/harness/common.ts:38-41` (`isNoise`, new `NOISE_TAGS`, `leadTag`), `src/harness/claude.ts:40-67` (`parse`, new exported `classifyUser`); Test `src/harness/harness.check.ts`, `src/features/callgraph/model.check.ts`.

**Interfaces — Produces:**
- `common.ts`: `export const NOISE_TAGS: string[]` = `["local-command-stdout", "local-command-stderr", "local-command-caveat", "system-reminder", "bash-stdout", "bash-stderr", "user-prompt-submit-hook", "environment_context", "recommended_plugins", "user_instructions", "turn_aborted", "skill"]` plus the Task 0 Step 9 additions (each with a `// <harness>` comment); `export function leadTag(t: string): string` (the `x` of a leading `<x>` or `<x ` after `trimStart()`, else `""`); `isNoise(t)` = empty, or `leadTag(t)` in `NOISE_TAGS`, or `task-notification`, or starts with `# AGENTS.md` / `Caveat:`. A text starting with an unknown `<tag>` or with `<` not followed by a tag (`<div>`, `< 3`) is **not** noise.
- `claude.ts`: `export type UserKind = "human" | "notify" | "peer" | "meta" | "noise"`; `export function classifyUser(o: Obj, text: string): UserKind`.

`classifyUser` order (spec §3, with Task 0 Step 3's finding applied — known tags first so an origin can never promote hook/command output, Review Focus 1):
1. `lt = leadTag(text)`: `lt` in `NOISE_TAGS` → `noise`; `lt === "bash-input"` → `meta`; `lt === "command-name" || lt === "command-message"` → `meta` (the caller's existing command path handles it first; this is the fallback).
2. `ok = obj(o["origin"])`, `k = ok ? str(ok["kind"]) : ""`, `to = str(o["turnOrigin"])`: `k === "human"` or `to` ∈ `human sdk scheduled` → `human`; `k` ∈ `task-notification auto-continuation` or `to` ∈ `task_notification auto_continuation` → `notify`; `k === "peer" || to === "peer"` → `peer`.
3. `lt === "task-notification"` → `notify`.
4. else `human`.

Events emitted by `parse()` for a user text `t` (string content and each `text` block; the command path at `claude.ts:52-54` stays first):
- `human` → `{kind:"user", text:t}` (as today);
- `noise` → nothing;
- `meta` (`bash-input`) → `{kind:"meta", text:"! " + inner}`, `inner` = text between `<bash-input>` and `</bash-input>`, trimmed;
- `notify` → `{kind:"meta", text: "⟲ " + status + (summary ? " · " + summary : ""), id: toolUseId}` with `status` = `<status>…</status>` (default `"resumed"`), `summary` = `<summary>…</summary>`, `toolUseId` = `<tool-use-id>…</tool-use-id>` (`""` when absent); an auto-continuation without tags → `⟲ auto-continue`;
- `peer` → `{kind:"meta", text: "⇄ " + from + " · " + firstLine(t, 120)}`, `from` per Task 0 Step 4 (fallback `"peer"`).

- [ ] **Step 1: Failing checks** in `harness.check.ts` — `claudeKinds(lines)` = joined `kind:text` of the events. Lines (real shapes from Task 0):
  - human `{"type":"user","origin":{"kind":"human"},"turnOrigin":"human","promptSource":"typed","message":{"role":"user","content":"<div>fix this</div>"}}` → `user:<div>fix this</div>`;
  - same text without origin (older transcript) → `user:…`;
  - task notification with origin (`origin.kind:"task-notification"`, `turnOrigin:"task_notification"`, `promptSource:"system"`, content `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Inventory hook seams" finished</summary>\n</task-notification>`) → one `meta` event `⟲ completed · Agent "Inventory hook seams" finished` with `id === "toolu_1"`, no `user` event;
  - the same without origin → identical result;
  - `peer` origin (sample from Task 0) → `meta:⇄ <from> · <first line>`;
  - `sdk` and `scheduled` `turnOrigin` with plain text → `user:`;
  - each tag of `NOISE_TAGS` and `command-message` **with** `origin.kind:"human"` → no `user` event;
  - `<bash-input>git status</bash-input>` → `meta:! git status`;
  - `<command-name>/compact</command-name>` → unchanged (`meta:/compact`).
  Codex/Kiro/Gemini: `isNoise("<environment_context>…")` true; `isNoise("<div>x")` false; `isNoise("< 3 apples")` false; `isNoise("# AGENTS.md …")` true.
  In `callgraph/model.check.ts`: events `[user "do it", tool a, meta "⟲ completed · x" (id b), tool c, meta "⇄ peer · hi", tool d, user "next"]` → `summary(g).turns === 2`, and tools a, c, d are all under turn 1 (`sp[i].parent === 0`).
  Run each check → Expected: FAIL (notification today yields nothing, `<div>` vanishes, `classifyUser` missing).
- [ ] **Step 2: Implement** `common.ts` (`NOISE_TAGS`, `leadTag`, narrowed `isNoise`), then `classifyUser` + the emitting helper `userEvs(o, t, ts, out)` in `claude.ts`, called from both the string-content branch (`claude.ts:55`) and the text-block branch (`claude.ts:62`). Gemini's `noise()` (`gemini.ts:227`) keeps wrapping `isNoise`.
- [ ] **Step 3: Run** both checks → PASS; `sh scripts/check.sh` → all ok (existing SAMPLES `kinds` unchanged).
- [ ] **Step 4: Commit** `git commit -am "fix(claude): task notifications and peer messages are markers, not prompts; prompts starting with < are kept"`.

---

### Task 4: Claude fallback iterations booked per attempt + the one cache bump

**Files:** Modify `src/harness/claude.ts:96-109` (`usage`), `src/features/usage/cache.ts:15` (`VERSION`); Test `src/harness/harness.check.ts`.

**Interfaces — Consumes:** `tokens(a, d, model, nIn, nOut, nCr, w5, w1)` (`record.ts:108`). **Produces:** no new names; `VERSION` = next free number at implementation time (see Global Constraints).

Rule (spec §2), inside the existing id dedupe: `its = arr(u["iterations"])`; if `its.length >= 2`, for each `it = obj(…)`: `md = str(it.model) || model`; skip `<synthetic>`; `cc = obj(it.cache_creation)`; `w1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0`; `w5 = cc ? num(cc.ephemeral_5m_input_tokens) : num(it.cache_creation_input_tokens)`; `tokens(a, d, md, num(it.input_tokens), num(it.output_tokens), num(it.cache_read_input_tokens), w5, w1)`; the top-level numbers are not booked. `a.model` stays `message.model`. 0–1 iterations: today's code path unchanged.

- [ ] **Step 1: Failing check** — 3 streamed lines, same `message.id` `m2`, `message.model` `claude-opus-4-8`, top-level usage = the last attempt, `iterations: [{type:"message", model:"claude-fable-5", input_tokens:3, output_tokens:477, cache_read_input_tokens:938889, cache_creation:{ephemeral_5m_input_tokens:0, ephemeral_1h_input_tokens:1200}}, {type:"fallback_message", model:"claude-opus-4-8", input_tokens:3, output_tokens:350, cache_read_input_tokens:938889, cache_creation:{ephemeral_5m_input_tokens:0, ephemeral_1h_input_tokens:0}}]` on every line:
  - fresh Acc, all 3 lines → `outTok === 827`, `cr === 1877778`, `cw === 1200`, `a.model === "claude-opus-4-8"`, `cost` = `cost(price("claude-fable-5"), 3, 477, 938889, 0, 1200, …) + cost(price("claude-opus-4-8"), 3, 350, 938889, 0, 0)` (compute the expectation with `price`/`cost` from `pricing.ts`; when a model has no built-in price, expect `unk` to carry its tokens instead);
  - the same 3 lines again into the same Acc → totals unchanged (Review Focus 3);
  - a fresh Acc that only sees lines 2–3 (resume) → the same totals once;
  - a one-iteration message → identical to today's booking (top-level numbers);
  - an iteration with model `<synthetic>` → not booked.
  Run → Expected: FAIL (`outTok` 350 today).
- [ ] **Step 2: Implement** the iteration loop in `usage()`; bump `VERSION` to the next free number at implementation time with the comment `// N: Claude fallback iterations booked per attempt; Day.skills + Day.turns + Acc.pk (parsing-fixes)` (Tasks 5 and 6 add their keys under this same number; if honest-costs merged first in the same release, share its number per Global Constraints, else its number + 1).
- [ ] **Step 3: Run** the check → PASS; `sh scripts/check.sh` → all ok.
- [ ] **Step 4: Commit** `git commit -am "fix(claude): book each fallback attempt with its own model and tokens"`.

---

### Task 5: Skills data model + Claude skill counting

**Files:** Modify `src/features/usage/record.ts` (`Day.skills`, `Acc.pk`, `newAcc`, `bucket`, new `skill`, new `skillUses`), `src/features/usage/cache.ts:37-72` (`dayOut`/`dayIn` key `k`, `accOut`/`accIn` key `pk`), `src/harness/claude.ts:96-124` (`usage`); Test `src/features/usage/record.check.ts`, `src/harness/harness.check.ts`, new `src/features/usage/cache.check.ts` only if the round-trip cannot be tested through exported functions (export `accOut`/`accIn` for the check otherwise).

**Interfaces — Produces:**
- `Day.skills: Map<string, Cnt>` keyed `"<source>\t<name>"`, `source ∈ {"command","model"}`, `n` = uses.
- `Acc.pk: string` — Claude: `"<promptId>\t<command name>"` of a slash command waiting for its base-directory line; Codex (Task 7): the `$names` of the latest human prompt of the current turn, space-separated; `""` otherwise. Persisted.
- `export function skill(d: Day, source: string, name: string): void` — `if (name) cnt(d.skills, source + "\t" + name)`.
- `export interface SkillUse { name: string; source: string; n: number }`; `export function skillUses(a: Acc, days: string[] | null): SkillUse[]` — summed over the given local days (`null` = all), sorted by `n` desc then name.

Claude rules (spec §4), in `usage()` before the assistant fast path (cheap `indexOf` pre-filters, `JSON.parse` only on a hit):
- line contains `<command-name>/` and `"type":"user"` → parse; `pk = promptId + "\t" + name` (name without `/`), return;
- line contains `Base directory for this skill:` and `"isMeta":true` → parse; text = string content or joined text blocks; `dir` = last path segment of the base directory; if `!str(o.sourceToolUseID)` and `pk` set and `promptId` equals `pk`'s and `dir === pk name after its last ":"` → `skill(d, "command", name)`; clear `pk`; return;
- any other `"type":"user"` line that is not a `tool_result` → clear `pk` (a `<command-name>` without skill dir never produces the meta line);
- assistant `tool_use` named `Skill` → `skill(d, "model", str(inp.skill))` in addition to the tool count.

- [ ] **Step 1: Failing checks**:
  `record.check.ts`: `skill(d, "command", "a:b")` twice + `skill(d, "model", "a:b")` → `skillUses(a, null)` = `[{a:b, command, 2}, {a:b, model, 1}]`; `skill(d, "model", "")` → no entry.
  `harness.check.ts` (real shapes from Task 0 Step 6): slash pair `skill-codex:codex` (command line + meta line, same `promptId`, `Base directory for this skill: /h/.claude/plugins/x/skills/codex`) → `command\tskill-codex:codex` = 1; `Skill` tool_use `{skill:"superpowers:brainstorming"}` + meta line **with** `sourceToolUseID` → `model\tsuperpowers:brainstorming` = 1 and `command` none, tool row `Skill` = 1; `/compact` + `<local-command-stdout>` → no skill; command `/x:a` then a meta line with another `promptId` → none (Review Focus 5); command line → ledger cache round-trip of the Acc (`accIn(accOut(a))`) → meta line into the restored Acc → counted once.
  Cache round-trip: a Day with `skills` and an Acc with `pk` survive `accOut` → `JSON.stringify` → `JSON.parse` → `accIn`.
  Run → Expected: FAIL (`skill`/`skillUses` undefined).
- [ ] **Step 2: Implement** record.ts (`skills: new Map<string, Cnt>()` in `bucket()`'s Day literal; `pk: ""` in `newAcc`), cache.ts (`k: cntsOut(d.skills)` / `skills: cntsIn(o["k"])`; `pk: a.pk` / `pk: str(o["pk"])`), claude.ts rules.
- [ ] **Step 3: Run** checks → PASS; `sh scripts/check.sh` → all ok.
- [ ] **Step 4: Commit** `git commit -am "feat(usage): count skills per day; Claude slash-command and model-invoked skills"`.

---

### Task 6: Human-turn counter `Day.turns`

**Files:** Modify `src/features/usage/record.ts` (`Day.turns`, `bucket()` day literal, new `turn`), `src/features/usage/cache.ts:37-72` (`dayOut`/`dayIn` key `tu`), every adapter's `usage()` (`src/harness/claude.ts:96-124`, `codex.ts:85`, `fx.ts:69`, `gemini.ts:298`, `pi.ts:196`, `opencode.ts:359`, `kiro.ts:106`) plus the prompt predicate it shares with `parse()` (`claude.ts:55,62`, `codex.ts:70`, `fx.ts:31`, `kiro.ts:39`, and the user-event sites of gemini/pi/opencode); Test `src/harness/harness.check.ts`, `src/features/usage/record.check.ts`.

**Interfaces — Consumes:** `classifyUser`, narrowed `isNoise` (Task 3); the shared cache bump (Task 4). **Produces:**
- `Day.turns: number` — real human turns booked on the local day of the user line; persisted under day key `tu` (0 when absent).
- `export function turn(d: Day): void` — `d.turns++`.
- Per adapter a local `isPrompt(…)` (or the existing condition, moved into one helper) that both `parse()` (emits `kind:"user"`) and `usage()` (calls `turn(bucket(a, ms, iso))`) use, so the two can never disagree. Claude: a `"type":"user"` line that is not a `tool_result`, not on the command path, and whose text `classifyUser` calls `human` (includes `sdk`/`scheduled`, spec decision 1); `notify`, `peer`, `meta`, `noise` and slash commands do not count. Other harnesses: their current user-prompt condition with the narrowed `isNoise`. Cheap `indexOf` pre-filter before any `JSON.parse`, as the existing usage paths do.

Consumers: session-compare's turn rows (turns, cost/tokens/calls per turn) and filter-language's `turns` key read `Day.turns`.

- [ ] **Step 1: Failing checks**:
  `harness.check.ts`, inside the SAMPLES loop that already feeds `parseEvents` and `ad.usage(a, l)`: `let tu = 0; for (const dd of a.days.values()) tu += dd.turns;` then `ok(x.h + " turns = call graph", tu === summary(buildGraph([{ evs, live: false, kind: "", spawn: "" }], Date.now())).turns, …)`.
  Claude lines (Task 3 shapes): a typed prompt, a task notification (with and without origin), a `peer` message, `<command-name>/compact</command-name>`, a `<system-reminder>` with `origin.kind:"human"`, `sdk` and `scheduled` `turnOrigin` prompts → `turns === 3` (typed + sdk + scheduled). Resume: feed the first half into an Acc, round-trip it through `accOut`/`accIn`, feed the rest → same total, no double count.
  `record.check.ts`: cache round-trip of a Day with `turns 4` → `4`; an old day object without `tu` → `0`.
  Run → Expected: FAIL (`turns` undefined).
- [ ] **Step 2: Implement** `record.ts` (`turns: 0` in the Day literal, `turn`), `cache.ts` (`tu: d.turns` / `turns: num(o["tu"])`, no new bump — Task 4's number covers it; add `Day.turns` to that comment), the per-adapter helper and `turn()` calls.
- [ ] **Step 3: Run** → PASS; `sh scripts/check.sh` → all ok.
- [ ] **Step 4: Commit** `git commit -am "feat(usage): count human turns per day"`.

---

### Task 7: Codex, OpenCode and Gemini skills

**Files:** Modify `src/harness/codex.ts:85-103` (`usage`), `src/harness/opencode.ts:357-376` (`usage`), `src/harness/gemini.ts:298-322` (`usage`); Test `src/harness/harness.check.ts` (or the existing `opencode.check.ts` / `gemini.check.ts` where those adapters' usage is already checked).

**Interfaces — Consumes:** `skill(d, source, name)`, `Acc.pk` (Task 5).

Rules:
- **Codex** (shape and marker per Task 0 Step 7; skip this bullet entirely if Step 7 found no `<skill>` message): pre-filter `h.indexOf("\"role\":\"user\"") >= 0` on `response_item` message lines. `event_msg` `task_started` → `a.pk = ""`. A user message whose text does not start with `<` (human prompt) → `a.pk` = the `$name` tokens of the text (`/\$([A-Za-z0-9_.:-]+)/g`), space-separated. A user message starting `<skill>` → `name` from `<name>…</name>`; `source = (" " + a.pk + " ").indexOf(" " + name + " ") >= 0 ? "command" : "model"`; `skill(d, source, name)`. If Codex carries an explicit marker (Step 7), the marker decides instead.
- **OpenCode**: 2.x row `{"type":"skill",…,"name":…}` (the same rows `parse2` turns into `skill: <name>` at `opencode.ts:310`) → `skill(bucket(a, tm(o, "created"), ""), "model", str(o["name"]))`; add the `"type":"skill"` pre-filter next to the assistant/compaction one.
- **Gemini**: in the `toolCalls` loop, `name === "activate_skill" && args` → `skill(d, "model", str(args["name"]))` (counted once: the normalized stream emits each call once).

- [ ] **Step 1: Failing checks**: Codex — turn with human prompt `use $agtest-hello` + `<skill>\n<name>agtest-hello</name>…` → `command\tagtest-hello`; next turn (after `task_started`) without `$` + the same skill message → `model\tagtest-hello`; ledger resume between prompt and skill line (cache round-trip) keeps `pk`. OpenCode — one skill row → `model\t<name>` 1. Gemini — `activate_skill {name:"x"}` read through two different windows of the normalized stream → `model\tx` = 1.
  Run → FAIL.
- [ ] **Step 2: Implement.** **Step 3: Run** → PASS; `sh scripts/check.sh` → all ok; Codex/OpenCode/Gemini `--json` (without `skills`) unchanged vs `/tmp/pf-before.json`.
- [ ] **Step 4: Commit** `git commit -am "feat(usage): Codex, OpenCode and Gemini skill uses"`.

---

### Task 8: Skills in Stats, preview and `--json`

**Files:** Modify `src/features/usage/stats.ts:38-76` (`Agg.skills`), `:174-209` (`Row`, `toolRows`, `parentKey`, `toggle`), `:254` (`openDrill`), `:404-431` (`key`), `:454-463` (preview), `:476-483` (footer/help); `src/features/cli.ts:45-46,58-62,103-110` (`skills` field + help text); Test `src/features/usage/stats.check.ts` (create; `toolRows` exported for it) and a shell test `scripts/json-skills.test.sh` only if an existing `scripts/*.test.sh` already drives `--json` against a fake `HOME` (otherwise extend `harness.check.ts` with `skillUses` on a sample session).

**Interfaces — Consumes:** `Day.skills`, `skillUses(a, days)` (Task 5). **Produces:**
- `Agg.skills: Map<string, Cnt>` (merged over the period, keys `"<source>\t<name>"`).
- `Row` gains `skill: boolean`; the group row has `key "skills"`, `label "✧ skills"`, `server: false`, `skill: true`; kids `key "skill\t<name>"`, label `name  / 3 · ⚙ 5` when both sources exist, `name  /` or `name  ⚙` otherwise; `n` = total uses; err 0.
- `export function toolRows(g: Agg): Row[]` (exported for the check).
- `--json` per session: `skills: SkillUse[]` (`[]` when none) — `JSess.skills`, filled from `skillUses(accOf(s), null)` after `complete(s)`; `cli.ts` imports `accOf` from `./usage/ledger.ts` and `skillUses` from `./usage/record.ts`.

Behavior (spec §4 UI): the group row sorts among the top rows by its total; hidden when `g.skills` is empty; `␣`/`→`/`←` expand/fold it like an MCP server (`toggle`: `r.skill || r.kid` with `parentKey` returning `"skills"` for `skill\t` kids); `↵`/click on the group or a kid does nothing (`openDrill` returns early when `r.skill` or the key starts with `skill\t`). Preview line `skills  brainstorming ×2, codex` (top 5 by uses, `×n` only when n > 1, from `skillUses(a, null)`), shown only when any. Help: `["␣  → ←", "expand / fold an MCP server or the skills group"]`; `--help` field list gains `skills[{name,source,n}]`.

- [ ] **Step 1: Failing check** `stats.check.ts`: an Agg with `names` {`Bash` 5, `mcp__s__t` 2} and `skills` {`command\tcodex` 3, `model\tcodex` 5, `model\tbrainstorming` 1} → collapsed rows: `Bash 5`, `✧ skills 9`, `⧉ s 2` (sorted by n); with `open` containing `skills` → kids `codex  / 3 · ⚙ 5` (8) before `brainstorming  ⚙` (1); empty `skills` → no group row. Run → FAIL.
- [ ] **Step 2: Implement** stats.ts and cli.ts.
- [ ] **Step 3: Run** → PASS; `sh scripts/check.sh` → all ok; `./agentglass --json --limit 50 | jq '[.[] | select(.skills|length>0) | {title, skills}] | .[0:3]'` shows real skill uses from the user's Claude sessions.
- [ ] **Step 4: Commit** `git commit -am "feat(stats): skills group in top tools, skills in preview and --json"`.

---

### Task 9: Codex remote — `Sess.remote`, preview, `--json`, `--redact`

**Files:** Modify `src/model/types.ts:5-23` (`Sess.remote`, `newSess`), `src/harness/codex.ts:54-56` (`parse` session_meta), `src/ui/list.ts:89` (preview line after `branch`), `src/features/cli.ts:45,58-62,104` (`remote`), `src/features/redact.ts:226-256` (`Rec.remote`, `meta`); Test `src/harness/harness.check.ts`, `src/features/redact.check.ts`.

**Interfaces — Consumes:** `scrubRemote`, `remoteLabel` (Task 1). **Produces:** `Sess.remote: string` — the scrubbed `Remote.url`, `""` when absent or dropped (the raw value is never assigned).

- `codex.ts` session_meta: `const ru = g ? str(g["repository_url"]) : ""; if (ru) { const r = scrubRemote(ru); s.remote = r ? r.url : ""; }`.
- Preview: `if (s.remote) { const r = scrubRemote(s.remote); if (r) kv("remote", remoteLabel(r), C.green); }`.
- `--json`: `remote: s.remote ? s.remote : null`.
- `--redact` `meta()`: `if (s.remote && s.remote !== r.remote) { r.remote = "https://github.com/acme/" + (slug(r.title) || "repo"); s.remote = r.remote; }` — same pattern as `branch`.

- [ ] **Step 1: Failing checks**: Codex `session_meta` with `git.repository_url` `https://x-access-token:ghs_abc123@github.com/o/r.git` → `s.remote === "https://github.com/o/r"`; `https://host/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8` → `s.remote === "https://host/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8"` (path segments are kept); `https://host/o/r?token=ghs_x` → `https://host/o/r`; no `repository_url` → `""`; `JSON.stringify(s)` never contains `ghs_` (Review Focus 4). `redact.check.ts`: a session with `remote` → after `meta` the remote is `https://github.com/acme/…` and stable across two calls. Run → FAIL.
- [ ] **Step 2: Implement.** **Step 3: Run** → PASS; `sh scripts/check.sh` → all ok; `./agentglass --json --harness codex --limit 20 | jq '.[].remote'` → scrubbed values or `null`, no userinfo.
- [ ] **Step 4: Commit** `git commit -am "feat(codex): show the session's git remote, credentials scrubbed"`.

---

### Task 10: Real-life verification, docs, final review

**Files:** Modify `README.md` (Stats: skills group; `--json` fields `skills`, `remote`; transcript markers `⟲` / `⇄`; note that renamed Claude sessions show their `/rename` title), `src/features/cli.ts` help text (already extended in Tasks 8–9; re-read it).

- [ ] **Step 1: Real sessions (read-only)**, with the branch build:
  - a Claude session renamed with `/rename` shows the custom title in the list, preview and `--json` (`jq '.[] | select(.harness=="claude") | .title'` vs `rg -h '"customTitle"' <file> | tail -1`);
  - a session with `fallback_message` iterations: `--json` tokens/`costUsd` now exceed the `/tmp/pf-before.json` value by the failed attempts;
  - a session with background tasks: transcript shows `⟲ completed · …`, the call graph's turn count equals the number of typed prompts; a prompt starting with `<` shows as a prompt;
  - a peer message (Task 0 Step 4 sample) shows as `⇄ …`;
  - Stats `✧ skills` group with real counts (Today and 7 days), expand with `␣`; preview `skills …`;
  - Codex sessions: preview `remote github.com/<o>/<r>`, `--json remote`; `AGENTGLASS_REDACT=1 ./agentglass --json --harness codex --limit 5 | jq '.[].remote'` → `acme` fakes;
  - contract diff: `./agentglass --json --subagents --limit 400 > /tmp/pf-after.json`; `jq` diff of both files minus the volatile fields → only the intended changes (Global Constraints);
  - first start re-indexes once (ledger `VERSION` bump), the indexing gauge reaches 100%.
- [ ] **Step 2: Docs** README + help; `sh scripts/check.sh` → all ok; `./build.sh` ok.
- [ ] **Step 3: Commit** `git commit -am "docs: skills, remotes and turn markers in the README"`.
- [ ] **Step 4: Final whole-branch review** (most capable model) against spec.md and this plan's Review Focus; one fix pass; push, PR to `main` (body: Task 0 probe results and `Ruling:` lines), CI green, rebase-merge; remove the worktree and branch; delete `/tmp/agtest-*` dirs and any test skill created under `~/.codex/skills/` in Task 0.
