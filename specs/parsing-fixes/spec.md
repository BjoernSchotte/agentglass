# Parsing fixes — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 1 (no dependencies).

## Goal
Six small corrections so the numbers and labels agentglass already shows are right, plus one shared helper later
features need:
1. **Titles**: Claude `custom-title` (`/rename`) beats `ai-title`.
2. **Fallback retries**: Claude `usage.iterations` booked per attempt, so a failed attempt on a pricier model is counted.
3. **Turn boundaries**: task-notification follow-ups are not human prompts — and real prompts that happen to start
   with `<` are no longer dropped.
4. **Skills used**: slash-command skills and model-invoked skills (Claude, Codex; OpenCode and Gemini where the data is
   already parsed) counted in a new Stats group and in `--json`.
5. **Remote scrub**: one helper that removes credentials from git remote URLs, used wherever a remote is shown or exported.

Each item was checked against current code and real local transcripts (2026-10-02); results are in "Today".

## Why (user value)
- A renamed session keeps showing the auto title today — the name the user chose is the one they search for.
- Fallback retries are invisible spend: in one local session, three messages fell back from `claude-fable-5` to
  `claude-opus-4-8`; the Fable attempts (e.g. 477 output + 938,889 cache-read tokens for one message) are not counted.
- Turn segmentation drives the call graph today and OTLP export tomorrow; a background-task notification counted as
  a prompt would inflate turns, and a user prompt pasted as `<div>…` disappearing is a plain bug.
- "Which skills do I actually use?" is unanswerable today; the data is in the transcripts.
- Git remotes can carry tokens (`https://x-access-token:ghs_…@github.com/…`, CI checkouts). The first feature that
  shows or exports a remote must not leak one.

## Today (current code, with path:line refs)
**L3 titles — not handled.** `src/harness/claude.ts:42` sets `s.title` from `ai-title` only; `custom-title`
(`{"type":"custom-title","customTitle":"…","sessionId":"…"}`) is ignored. Claude Code re-appends both
periodically, **`ai-title` right after `custom-title`** (local session: 33 pairs over 919 lines), so even reading
`custom-title` naively would be overwritten on the next line. `titleOf()` prefers `s.title` (`src/model/sessions.ts:56-60`).

**L2 iterations — not handled.** `usage()` books the top-level `message.usage` once per `message.id`
(`claude.ts:96-109`, dedupe at `:103`). Real shape (local):
`usage.iterations: [{…tokens, cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}, type:"message", model:"claude-fable-5"},
{…, type:"fallback_message", model:"claude-opus-4-8"}]`, `message.model = "claude-opus-4-8"`; the top-level usage
mirrors only the last attempt (and inconsistently keeps the first attempt's `ephemeral_1h_input_tokens` while
`cache_creation_input_tokens` is 0). Every streamed line of the message carries the same `iterations`. 178,906 local
messages have one iteration (no change needed), 17 have two.

**L9 task notifications — handled by accident, with a side effect.** The follow-up is a `type:"user"` line with string
content `<task-notification>…` and, in current Claude Code, `origin:{kind:"task-notification"}`,
`turnOrigin:"task_notification"`, `promptSource:"system"` (human prompts: `origin.kind:"human"`,
`turnOrigin:"human"`, `promptSource:"typed"|"queued"|"suggestion_accepted"`). `isNoise()` drops **any** user text
starting with `<` (`src/harness/common.ts:38-41`, used at `claude.ts:55,62`, `src/harness/codex.ts:70`, `src/harness/kiro.ts:39`, `src/harness/gemini.ts:227`), so the
notification is not a prompt, not `s.prompt`, not a call-graph turn (`src/features/callgraph/model.ts:59-63`). Side
effects: (a) a genuine prompt starting with `<` vanishes from transcript, title fallback and turns; (b) the agent's
reaction to the notification silently joins the previous turn with no marker of why it resumed. Tags seen at the
start of user string content in 30 days of local transcripts: `task-notification` 2412, `system-reminder` 571,
`command-name` 107, `local-command-stdout` 90, `local-command-caveat` 86, `bash-stdout` 36, `bash-input` 36,
`command-message` 5.

**L6 slash-command skills — not handled.** `claude.ts:52-54` turns `<command-name>/x</command-name>` into a user/meta
event; nothing tells a skill from `/compact`, `/clear`, `/model`, `/plugin`. Real pairing (local): the command line
`<command-message>skill-codex:codex</command-message>\n<command-name>/skill-codex:codex</command-name>` is followed by
an `isMeta:true` user line with the same `promptId`, **no** `sourceToolUseID`, text
`Base directory for this skill: …/skills/codex`. A model-invoked skill is a `Skill` tool_use followed by the same
meta text **with** `sourceToolUseID`. `usage()` skips user lines without `tool_use_id` (`claude.ts:97`); `isMeta`
lines are skipped by `parse()` (`claude.ts:45`). `Skill` calls are counted as a tool named `Skill`, with no per-skill
breakdown.

**L7 Codex skills — not handled.** Codex injects a user message whose text starts with `<skill>` and carries
`<name>…</name>`; it is dropped as noise (`codex.ts:70`) and not counted. No local rollout contains one (shape from
upstream source; capture a real sample first, Testing). Already parsed elsewhere: OpenCode `skill` parts → meta event
(`src/harness/opencode.ts:310`); Gemini `activate_skill` tool call (`src/harness/gemini.ts:237`).

**L10 remote scrub — no consumer yet.** agentglass shows no git remote today (only `branch`:
`claude.ts:46`, `codex.ts:55`, preview `src/ui/list.ts:89`, `--json` `src/features/cli.ts:104`). Codex writes
`session_meta.payload.git.repository_url` (local: `https://github.com/<owner>/<repo>.git`), currently ignored. `--redact`
fakes titles, cwd and branch (`src/features/redact.ts:226-254`), not remotes.

**Already handled, not in scope:** subagent transcript linking (`claude.ts:15-26`), shell command family
(`program()`, `src/features/usage/calls.ts:83`). Duplicate streamed lines carrying identical `output_tokens` were
checked 2026-09-27 — keep first-line dedupe.

## Design

### 1. Claude title precedence (L3)
- `parse()` handles `type === "custom-title"`: `t = str(o["customTitle"]).trim()`; non-empty → `s.title = t` and the
  session path goes into a module-level `renamed: Map<string, string>` (path → custom title); empty → delete (title
  falls back to `ai-title` on the next one).
- `ai-title`: sets `s.title` only when `!renamed.has(s.path)`.
- Head and tail windows both run `parse()` (`sessions.ts:36-55`), so whichever window sees the latest `custom-title`
  wins; because Claude re-appends the pair, the tail almost always holds it.
- `--redact` is unaffected (it fakes `s.title` after parsing).

### 2. Claude fallback iterations (L2)
In `usage()` after the id dedupe: `its = arr(u["iterations"])`. If `its.length >= 2`, book **each** iteration via
`tokens()` with its own `model` (fallback `message.model`), its own `input/output/cache_read`, and its own
`cache_creation.ephemeral_5m_input_tokens` / `cache_creation.ephemeral_1h_input_tokens` split (fallback: all of
`cache_creation_input_tokens` as 5 m); skip the top-level
numbers. `<synthetic>` iterations are skipped like today. One or zero iterations: unchanged. The session's `a.model`
stays `message.model` (the model that answered). Stats per model show the failed attempt under its own model. Ledger
cache `VERSION` bump so existing sessions re-index (shared bump with honest-costs if both ship together).

### 3. Turn boundaries and prompt noise (L9)
New `classifyUser(o, text): "human" | "notify" | "peer" | "meta" | "noise"` in `src/harness/claude.ts`, exported for
the call graph and OTLP export:
0. **Known tags first**, before any origin: a leading noise tag (the list in 2) → `noise`; `<bash-input>` → `meta`;
   `<command-name>`/`<command-message>` → the command path. Hook or command output that carries `origin.kind:"human"`
   therefore never becomes a prompt or opens a turn.
1. `origin.kind` if present: `human` → `human`; `task-notification`, `auto-continuation` → `notify`; `peer` → `peer`.
   `turnOrigin` the same (`human` / `task_notification`, `auto_continuation`, `peer`, `scheduled`, `sdk`). `sdk` and
   `scheduled` count as **human** turns (a person or their script asked): they open a turn, count in turn totals and
   are a turn root in OTLP export, exactly like typed prompts.
2. Fallback for older transcripts (no origin) — known leading tags only: `<task-notification>` → `notify`;
   `<command-name>`/`<command-message>` → handled by the existing command path (`claude.ts:52-54`);
   `<local-command-stdout>`, `<local-command-caveat>`, `<system-reminder>`, `<bash-stdout>`, `<bash-stderr>`,
   `<user-prompt-submit-hook>` → `noise`; `<bash-input>` → `meta` (`! <cmd>`).
3. Anything else — including text that starts with an unknown `<tag>` — is `human`.
- `notify` emits a meta event `⟲ <status> · <summary>` from `<status>` / `<summary>` (e.g. `⟲ completed · Agent
  "Inventory hook seams" finished`), with `id` = `<tool-use-id>` so the call graph can attach it to the spawning call.
  It does **not** open a turn: `callgraph/model.ts:60` already opens turns on `kind === "user"` only.
- `peer` (a message from another agent) emits a meta event with its own glyph **`⇄`**: `⇄ <from> · <first line>`,
  `<from>` = the sender name when the origin carries one, else `peer`; first line truncated to the row width. It does
  not open a turn either (no human asked); the agent's reaction joins the current turn behind the `⇄` marker. `⟲`
  stays reserved for task notifications and auto-continuations, so the two are never confused in the transcript.
- `isNoise()` (`common.ts:38-41`) is narrowed to the same known-tag list (plus the existing `# AGENTS.md` and
  `Caveat:` prefixes) and stays the shared fallback for Codex, Kiro and Gemini. Codex keeps dropping `<environment_context>`,
  `<recommended_plugins>`, `<user_instructions>`, `<turn_aborted>` and `<skill>` (local rollouts: 53, 54 and 6 hits for the first, second and fourth) (list maintained in `common.ts`, checked against a fixture
  per harness).
- **Turn counter.** `Day` gets `turns: number` (persisted, ledger key `tu`): real human turns booked on the local day
  of the user line. Every adapter's `usage()` counts exactly the lines its `parse()` turns into `kind:"user"` events —
  Claude through `classifyUser` (`human`, which includes `sdk`/`scheduled` per decision 1) on user lines that are not
  tool results; Codex, Kiro, Gemini, pi, OpenCode and fx through their existing user-prompt predicate with the
  narrowed `isNoise`. Notifications, peer messages, meta lines, noise and slash commands do not count. Per day it equals
  the call graph's turn count for that day's prompts. Shares the one cache bump (2).
- Risk: a harness-injected tag not on the list would now show as a user prompt. Mitigation: the per-harness fixture
  test lists every leading tag seen in samples; unknown tags are visible, not silently lost.

### 4. Skills used (L6, L7)
**Data model.** `Day` gets `skills: Map<string, Cnt>` keyed `"<source>\t<name>"` with `source ∈ {command, model}`
(reuses `Cnt` from `calls.ts`; `n` = uses). Persisted in the ledger cache (`dayOut/dayIn`, new key `k`). `Acc` gets a
persisted `pk: string` (pending slash command waiting for its base-directory line).

**Claude.** In `usage()` before the assistant fast path:
- line contains `<command-name>/` → remember `pk = name` (without `/`) and its `promptId`;
- line contains `Base directory for this skill:` and `"isMeta":true` → parse; if **no** `sourceToolUseID`, same
  `promptId` as `pk`, and the last path segment of the base directory equals the part of `pk` after the last `:`
  → count `command\t<pk>`; clear `pk` on any other user line.
- `Skill` tool_use: count `model\t<input.skill>` in addition to the tool count. `/compact`, `/plugin`, `/clear`,
  custom slash commands without a skill directory never produce the meta line, so they are excluded by construction.

**Codex.** `usage()` pre-filter also matches `"role":"user"` with `"text":"<skill>` in the first 200 bytes. Name from
`<name>…</name>`. Source = `command` when the latest human user message of the same turn contains `$<name>`, else
`model`. (Shape to be confirmed with a captured rollout; Testing.)

**OpenCode / Gemini (cheap extras).** OpenCode `skill` part → `model\t<name>`; Gemini `activate_skill` call →
`model\t<args.name>`. pi: not yet (open question).

**UI.** Stats top-tools list (`src/features/usage/stats.ts:179-197`) gets one group row `✧ skills` built like an MCP
server row (expandable with `␣`/`→`), kids `name` with count; the kid label carries `/` for command uses and `⚙` for
model uses when both exist (`codex  / 3 · ⚙ 5`). Sorted by total uses; hidden when no skill was used in the period.
Enter on the group or a kid: no drill-down in this spec. Preview: `skills  brainstorming ×2, codex` when any.
**`--json`** per session: `skills: [{name, source, n}]`.

### 5. Remote credential scrub (L10)
New `src/util/giturl.ts`:
```ts
export interface Remote { url: string; host: string; path: string; owner: string; name: string } // url = scrubbed
export function scrubRemote(raw: string): Remote | null;  // null = dropped
```
1. Trim; reject control characters and anything > 2048 chars → `null`.
2. Forms: `scheme://[userinfo@]host[:port]/path[?q][#f]` (https, http, ssh, git, git+ssh), scp-like
   `[user@]host:path`, local paths and `file://` (returned as `file://` + path with `$HOME` → `~`, no host).
3. Remove userinfo (everything up to the **last** `@` in the authority, so `a:b@c@host` cannot smuggle), query and
   fragment. scp-like keeps no user (`git@github.com:o/r` → `ssh://github.com/o/r`).
4. Still suspicious → `null`: an `@`, `?`, `#` or `%40`/`%3A` left in host or path (structural check). The
   token-shaped rule — `^(ghp|gho|ghs|ghu|github_pat)_`, `^glpat-`, `x-access-token`, `oauth2`, or any value ≥ 32 chars
   of only `[A-Za-z0-9_\-]` with digits and letters mixed — applies only to userinfo, query and fragment, which step 3
   removes whole. Path segments (owner/repo) are never dropped as tokens: a repo named like a hash stays.
5. `path` drops a trailing `.git`; `owner`/`name` = last two segments (`""` when fewer).

Consumers in this spec: Codex `session_meta.git.repository_url` → new `Sess.remote` (scrubbed at parse time, the raw
value is never stored), shown in the preview as `remote  github.com/<owner>/<repo>` and in `--json` as `remote`
(string or `null`). `--redact` replaces it with a fake `github.com/acme/<slug>`. Later consumers (repo-view,
git-linkage, otlp-export) must call `scrubRemote` on every remote they read from `git remote get-url` or transcripts.

## Interactions with other specs
- **honest-costs**: same ledger cache version bump; iterations change token and cost totals.
- **session-compare**: `Day.turns` feeds the turn rows (turns, cost/tokens/calls per turn).
- **filter-language**: the `turns` key reads `Day.turns`.
- **otlp-export**: uses `classifyUser` for turn segmentation, the skills map for skill attributes, `scrubRemote`
  for repository attributes.
- **repo-view / git-linkage**: `scrubRemote` + `Remote.owner/name` for project identity.
- **filter-language**: `skill is X`, `remote ~ org/` keys.

## Testing
- Fixtures (sanitised from real local lines): custom-title/ai-title interleaving; two-iteration fallback message
  (3 streamed lines, same id); task-notification with and without `origin`; `peer`, `sdk` and `scheduled` origins; slash skill pair; `Skill` tool_use + meta;
  `/compact` + output; a human prompt starting with `<div>`.
- `harness.check.ts`: titles (rename, rename to empty, ai-title after custom); iteration booking per model; turn
  count in `callgraph/model.check.ts` unchanged by notifications and peer messages, plus the `⟲` and `⇄` meta
  events; `sdk`/`scheduled` origins open a turn. `Day.turns` per SAMPLES harness equals the call graph's turn count;
  notifications, peer messages and slash commands do not count; a ledger resume does not count a turn twice.
- Codex: capture one real rollout with a `$skill` mention and one model-chosen skill before implementing (Task 0).
- `giturl.check.ts`: table of ≥ 25 inputs — tokens in userinfo, `user:pass@`, double `@`, query tokens, fragments,
  percent-encoded `@`, scp-like, ssh with port, GitLab subgroups, `file://`, local path, garbage → expected
  `Remote | null`.
- Ledger cache round-trip with `skills`, `turns` and `pk`.

## Out of scope
- Streaming-safety guard "max output_tokens per message id" (checked, not needed today).
- JSON-stream decoding of pretty-printed multi-line transcript entries.
- Codex subagent result notifications (no on-disk sample).
- A skills drill-down (sessions per skill) — filter-language covers it later.

## Decisions (review 2026-10-02)
1. `sdk`/`scheduled` turn origins as human turns? Yes — they open and count as turns (3).
2. Own glyph for `peer` (agent-to-agent) messages? Yes — `⇄`, distinct from `⟲`; no new turn (3).
3. Per-day human-turn counter `Day.turns` (human per `classifyUser`, incl. `sdk`/`scheduled`), shared cache bump;
   session-compare's turn rows read it (3).
4. Remote scrub: the token-shaped rule applies only to userinfo, query and fragment; path segments (owner/repo) are
   never dropped as tokens (5).
5. `classifyUser` checks known noise/command tags before `origin`, so an origin can never promote hook or command
   output (3).
6. Fallback iterations read the real cache keys `cache_creation.ephemeral_5m_input_tokens` /
   `ephemeral_1h_input_tokens` (2).

## Open questions (to verify during implementation)
1. Codex `<skill>` message shape and `$name` rule — confirm with a captured rollout; if Codex marks injected messages
   explicitly, prefer that marker.
2. pi skills: does pi record skill loads in the session file (and how)? Until known, not counted.
3. Claude `peer` origin: which field carries the sender name — confirm on a captured agent-to-agent message.
